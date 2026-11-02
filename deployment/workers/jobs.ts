import pg from 'pg';
import { CLIENT_READ_TIMEOUT_MS, PostgresAuthority, PostgresOutbox, PostgresRetrievalWorker, RecordRetrievalProjector,
  SourceUploadReconciler } from '@stateplane/postgres';
import { R2BlobStore } from '@stateplane/storage';
import { consume, dispatch } from '@stateplane/workers';
import type { DeliveryMessage } from '@stateplane/workers';

interface Env {
  AUTHORITY: Hyperdrive;
  PROJECTION_JOBS: Queue<DeliveryMessage>;
  ORIGINALS: R2Bucket;
}

// SQL is the durable job authority. A Queue message is a hint naming one
// lease; losing or repeating one cannot lose or reapply committed work.
// Record completion projects each record revision into the collection's
// retrieval generations (docs/retrieval-projections.md#indexing-worker).
// Each once-a-minute tick dispatches for up to 15 s, advances reconciliations
// for up to 7 s, settles ended upload attempts for up to 10 s, erases the
// bytes of deleted sources and erased spaces for up to 5 s, sweeps one page
// of stored upload bytes for up to 5 s, then projects source and claim work
// for up to 8 s; docs/durable-outbox.md, docs/evidence-storage.md and
// docs/retrieval-projections.md record the bounds. Each budget is a hard end
// for its step's SQL and sends (a call in flight then is abandoned), and the
// budgets sum to the 50 s tick budget, so every step gets its whole budget
// on every tick however busy the steps before it are. A step is also cut to
// what is left of the tick and skipped with under 2 s left (more than a
// retrieval item's 1 s minimum plus its claim). The retrieval step may take
// 1 s past its budget to settle, and teardown at most 5 s, so the
// invocation ends inside its minute: ticks do not overlap, and a tick holds
// only the one origin connection scripts/topology.mjs allows it.
const TICK_BUDGET_MS = 50_000;
const MIN_STEP_MS = 2_000;
const CLOSE_MS = 5_000;
const DISPATCH_BUDGET_MS = 15_000;
const RECONCILE_BUDGET_MS = 7_000;
const UPLOAD_BUDGET_MS = 10_000;
const UPLOAD_PAGE = 25;
const ERASE_BUDGET_MS = 5_000;
const ERASE_PAGE = 25;
const SWEEP_BUDGET_MS = 5_000;
const SWEEP_PAGE = 100;
const RETRIEVAL_BUDGET_MS = 8_000;
function cell(env: Env, originals = false) {
  if (!env.AUTHORITY?.connectionString) throw new Error('Cell authority binding is missing');
  if (originals && !env.ORIGINALS) throw new Error('Cell originals binding is missing');
  // Statement timeouts bound every query; the client read bound sits past
  // them and only catches a silently lost session. An invocation runs one
  // transaction at a time, so one connection each keeps the consumer's
  // max_concurrency (scripts/topology.mjs) within the origin budget.
  const pool = new pg.Pool({ connectionString: env.AUTHORITY.connectionString, max: 1,
    connectionTimeoutMillis: 5_000, query_timeout: CLIENT_READ_TIMEOUT_MS });
  // pg-pool re-emits an idle session's error on the pool; the pool discards
  // that session, and SQL leases recover its work.
  pool.on('error', () => {});
  // The worker never issues receipts; retention only satisfies the constructor.
  const outbox = new PostgresOutbox(pool, new PostgresAuthority(pool, 1));
  const uploads = originals ? new SourceUploadReconciler({ pool, originals: new R2BlobStore(env.ORIGINALS) }) : undefined;
  // No embedding provider is qualified for a cell yet (its processing region
  // must be verified first), so the registry is empty: generations without
  // vectors apply, and each vector generation keeps its previous state with
  // its work due and reported degraded, never holding back the others.
  const projector = new RecordRetrievalProjector(pool);
  const retrieval = new PostgresRetrievalWorker(pool);
  return { outbox, uploads, projector, retrieval, close: () => pool.end() };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const tickEnd = Date.now() + TICK_BUDGET_MS;
    // A step's budget: its own, cut to what is left of the tick's; 0 skips the step.
    const left = (budgetMs: number) => {
      const ms = Math.min(budgetMs, tickEnd - Date.now());
      return ms >= MIN_STEP_MS ? ms : 0;
    };
    const { outbox, uploads, retrieval, close } = cell(env, true);
    try {
      const dispatchMs = left(DISPATCH_BUDGET_MS);
      const result = await dispatch(outbox, {
        send: async messages => { await env.PROJECTION_JOBS.sendBatch(messages.map(body => ({ body: { ...body } }))); }
      }, { budgetMs: dispatchMs, deadline: Date.now() + dispatchMs });
      const until = Date.now() + left(RECONCILE_BUDGET_MS);
      let stepped = 1;
      // Released leases are uncounted, so the tick error is the only record of
      // a failed send: a reconciliation failure joins it rather than hiding it.
      const failures: unknown[] = [];
      try { while (stepped > 0 && Date.now() < until) stepped = await outbox.stepReconciliations(4, 100, { deadline: until }); }
      catch (error) { failures.push(error); }
      // A full page means more ended attempts may be due; each step stops at the budget's end.
      const uploadsUntil = Date.now() + left(UPLOAD_BUDGET_MS);
      let due = UPLOAD_PAGE;
      try { while (due === UPLOAD_PAGE && Date.now() < uploadsUntil) due = await uploads!.step(UPLOAD_PAGE, Math.max(1, uploadsUntil - Date.now())); }
      catch (error) { failures.push(error); }
      const eraseMs = left(ERASE_BUDGET_MS);
      try { if (eraseMs) await uploads!.erase(ERASE_PAGE, eraseMs); }
      catch (error) { failures.push(error); }
      const sweepMs = left(SWEEP_BUDGET_MS);
      try { if (sweepMs) await uploads!.sweep(SWEEP_PAGE, sweepMs); }
      catch (error) { failures.push(error); }
      // Each item settles its own failure; only a failed claim reaches the tick.
      const retrievalMs = left(RETRIEVAL_BUDGET_MS);
      try { if (retrievalMs) await retrieval.step({ budgetMs: retrievalMs }); }
      catch (error) { failures.push(error); }
      if (result.error) throw new Error(`Projection dispatch released ${result.released} leases`, {
        cause: failures.length ? new AggregateError([result.error, ...failures], 'Queue send and reconciliation failed') : result.error });
      if (failures.length > 1) throw new AggregateError(failures, 'Reconciliation steps failed');
      if (failures.length) throw failures[0];
    } finally {
      // Teardown that cannot end in time is dropped with the invocation.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([close(), new Promise(resolve => { timer = setTimeout(resolve, CLOSE_MS); })])
        .finally(() => clearTimeout(timer));
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { outbox, projector, close } = cell(env);
    try {
      const results = await consume(batch.messages.map(message => message.body), message => outbox.process(message, projector), 1);
      batch.messages.forEach((message, index) => {
        if (results[index] === 'retry') message.retry();
        else message.ack();
      });
    } finally { await close(); }
  }
} satisfies ExportedHandler<Env, unknown>;

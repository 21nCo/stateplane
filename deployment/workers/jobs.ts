import pg from 'pg';
import { CLIENT_READ_TIMEOUT_MS, PostgresAuthority, PostgresOutbox, SourceUploadReconciler } from '@stateplane/postgres';
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
// Until a search projector exists, completion advances per-ref heads only.
// Each once-a-minute tick dispatches for up to 20 s, advances reconciliations
// for up to 10 s, settles ended upload attempts for up to 10 s, erases the
// bytes of deleted sources and erased spaces for up to 5 s, then sweeps
// one page of stored upload bytes for up to 5 s;
// docs/durable-outbox.md and docs/evidence-storage.md record the bounds.
const DISPATCH_BUDGET_MS = 20_000;
const RECONCILE_BUDGET_MS = 10_000;
const UPLOAD_BUDGET_MS = 10_000;
const UPLOAD_PAGE = 25;
const ERASE_BUDGET_MS = 5_000;
const ERASE_PAGE = 25;
const SWEEP_BUDGET_MS = 5_000;
const SWEEP_PAGE = 100;
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
  return { outbox, uploads, close: () => pool.end() };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const { outbox, uploads, close } = cell(env, true);
    try {
      const result = await dispatch(outbox, {
        send: async messages => { await env.PROJECTION_JOBS.sendBatch(messages.map(body => ({ body: { ...body } }))); }
      }, { budgetMs: DISPATCH_BUDGET_MS });
      const until = Date.now() + RECONCILE_BUDGET_MS;
      let stepped = 1;
      // Released leases are uncounted, so the tick error is the only record of
      // a failed send: a reconciliation failure joins it rather than hiding it.
      const failures: unknown[] = [];
      try { while (stepped > 0 && Date.now() < until) stepped = await outbox.stepReconciliations(); }
      catch (error) { failures.push(error); }
      // A full page means more ended attempts may be due; each step stops at the budget's end.
      const uploadsUntil = Date.now() + UPLOAD_BUDGET_MS;
      let due = UPLOAD_PAGE;
      try { while (due === UPLOAD_PAGE && Date.now() < uploadsUntil) due = await uploads!.step(UPLOAD_PAGE, Math.max(1, uploadsUntil - Date.now())); }
      catch (error) { failures.push(error); }
      try { await uploads!.erase(ERASE_PAGE, ERASE_BUDGET_MS); }
      catch (error) { failures.push(error); }
      try { await uploads!.sweep(SWEEP_PAGE, SWEEP_BUDGET_MS); }
      catch (error) { failures.push(error); }
      if (result.error) throw new Error(`Projection dispatch released ${result.released} leases`, {
        cause: failures.length ? new AggregateError([result.error, ...failures], 'Queue send and reconciliation failed') : result.error });
      if (failures.length > 1) throw new AggregateError(failures, 'Reconciliation steps failed');
      if (failures.length) throw failures[0];
    } finally { await close(); }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { outbox, close } = cell(env);
    try {
      const results = await consume(batch.messages.map(message => message.body), message => outbox.process(message), 1);
      batch.messages.forEach((message, index) => {
        if (results[index] === 'retry') message.retry();
        else message.ack();
      });
    } finally { await close(); }
  }
} satisfies ExportedHandler<Env, unknown>;

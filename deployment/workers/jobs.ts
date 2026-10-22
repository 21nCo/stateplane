import pg from 'pg';
import { CLIENT_READ_TIMEOUT_MS, PostgresAuthority, PostgresOutbox } from '@stateplane/postgres';
import { consume, dispatch } from '@stateplane/workers';
import type { DeliveryMessage } from '@stateplane/workers';

interface Env {
  AUTHORITY: Hyperdrive;
  PROJECTION_JOBS: Queue<DeliveryMessage>;
}

// SQL is the durable job authority. A Queue message is a hint naming one
// lease; losing or repeating one cannot lose or reapply committed work.
// Until a search projector exists, completion advances per-ref heads only.
// Each once-a-minute tick dispatches for up to 20 s and then advances
// reconciliations for up to 10 s; docs/durable-outbox.md records the bounds.
const DISPATCH_BUDGET_MS = 20_000;
const RECONCILE_BUDGET_MS = 10_000;
function cell(env: Env) {
  if (!env.AUTHORITY?.connectionString) throw new Error('Cell authority binding is missing');
  // Statement timeouts bound every query; the client read bound sits past
  // them and only catches a silently lost session.
  const pool = new pg.Pool({ connectionString: env.AUTHORITY.connectionString, max: 4,
    connectionTimeoutMillis: 5_000, query_timeout: CLIENT_READ_TIMEOUT_MS });
  // The worker never issues receipts; retention only satisfies the constructor.
  const outbox = new PostgresOutbox(pool, new PostgresAuthority(pool, 1));
  return { outbox, close: () => pool.end() };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const { outbox, close } = cell(env);
    try {
      const result = await dispatch(outbox, {
        send: async messages => { await env.PROJECTION_JOBS.sendBatch(messages.map(body => ({ body: { ...body } }))); }
      }, { budgetMs: DISPATCH_BUDGET_MS });
      const until = Date.now() + RECONCILE_BUDGET_MS;
      let stepped = 1;
      while (stepped > 0 && Date.now() < until) stepped = await outbox.stepReconciliations();
      if (result.error) throw new Error(`Projection dispatch released ${result.released} leases`, { cause: result.error });
    } finally { await close(); }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { outbox, close } = cell(env);
    try {
      const results = await consume(batch.messages.map(message => message.body), message => outbox.process(message));
      batch.messages.forEach((message, index) => {
        if (results[index] === 'retry') message.retry();
        else message.ack();
      });
    } finally { await close(); }
  }
} satisfies ExportedHandler<Env, unknown>;

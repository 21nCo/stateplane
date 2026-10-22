import pg from 'pg';
import { PostgresAuthority, PostgresOutbox } from '@stateplane/postgres';
import { consume, dispatch } from '@stateplane/workers';
import type { DeliveryMessage } from '@stateplane/workers';

interface Env {
  AUTHORITY: Hyperdrive;
  PROJECTION_JOBS: Queue<DeliveryMessage>;
}

// SQL is the durable job authority. A Queue message is a hint naming one
// lease; losing or repeating one cannot lose or reapply committed work.
// Until a search projector exists, completion advances per-ref heads only.
function cell(env: Env) {
  if (!env.AUTHORITY?.connectionString) throw new Error('Cell authority binding is missing');
  const pool = new pg.Pool({ connectionString: env.AUTHORITY.connectionString, max: 4,
    connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
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
      });
      await outbox.stepReconciliations();
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

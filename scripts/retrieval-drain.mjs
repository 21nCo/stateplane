// Bounded projection draining for the retrieval evaluation (STA-49). The evaluation delivers every record event and
// evidence item itself, as the cell's queue consumer and jobs Worker would, and makes failed work due again at once
// rather than waiting out its backoff. Retried work never settles if the embedder keeps failing, for example a provider
// sandbox that keeps answering 4xx or 5xx. So each queue is drained only while its outstanding count keeps falling, and
// only until an overall deadline. A drain that stops making progress fails with counts only, never a provider's
// answer or credential, and the evaluation's cleanup still drops its disposable database.
import { PostgresOutbox, PostgresRetrievalWorker, RecordRetrievalProjector } from '../packages/postgres/dist/index.js';
import { consume, dispatch } from '../packages/workers/dist/index.js';

export class DrainStalledError extends Error {
  name = 'DrainStalledError';
}

/**
 * Run `round` until `outstanding()` reaches zero. Fail when the count has not fallen below its lowest value for
 * `stalls` rounds in a row, or when `deadline` (epoch ms) passes with work left.
 */
export async function drain(label, { outstanding, round, deadline, stalls, now = Date.now }) {
  if (!Number.isSafeInteger(stalls) || stalls < 1) throw new RangeError('stalls must be a positive integer');
  let left = await outstanding(), lowest = left, idle = 0, rounds = 0;
  while (left > 0) {
    if (now() >= deadline)
      throw new DrainStalledError(`${label}: ${left} still outstanding at the drain deadline after ${rounds} rounds`);
    await round();
    rounds++;
    left = await outstanding();
    if (left < lowest) { lowest = left; idle = 0; }
    else if (++idle >= stalls) throw new DrainStalledError(`${label}: ${left} still outstanding after ${stalls} rounds without progress`);
  }
  return rounds;
}

/**
 * Deliver every record event, then every evidence item, of the database behind `pool`. A dead-lettered record event
 * stays outstanding, so it fails the drain instead of leaving its Ref unprojected.
 */
export async function drainProjections(pool, authority, embedders, { deadline, stalls }) {
  const outbox = new PostgresOutbox(pool, authority);
  const projector = new RecordRetrievalProjector(pool, { embedders });
  const count = async sql => Number((await pool.query(sql)).rows[0].count);
  await drain('record events', { deadline, stalls,
    outstanding: () => count(`SELECT count(*) FROM projection_outbox WHERE delivery_state<>'delivered'`),
    round: async () => {
      await pool.query(`UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second'
        WHERE delivery_state<>'delivered' AND dead_lettered_at IS NULL`);
      const sent = [];
      await dispatch(outbox, { send: async messages => { sent.push(...messages); } }, { deadline });
      await consume(sent, message => outbox.process(message, projector), 8);
    } });
  const worker = new PostgresRetrievalWorker(pool, { embedders });
  await drain('evidence projection jobs', { deadline, stalls,
    outstanding: () => count(`SELECT count(*) FROM retrieval_outbox WHERE delivery_state='pending'`),
    round: async () => {
      await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE delivery_state='pending'`);
      await worker.step({ budgetMs: Math.max(1_000, Math.min(30_000, deadline - Date.now())) });
    } });
}

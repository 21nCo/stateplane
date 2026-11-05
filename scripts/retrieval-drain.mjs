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

// No record message or evidence step is started with less than this left before the deadline (the worker's own
// minimum item budget); each started one gets at most what is left.
const RESERVE_MS = 1_000;

/**
 * Settle with `work`, or reject with `late()` at `deadline` (epoch ms on `now`'s clock). Work still running then is
 * abandoned; the evaluation's cleanup ends its connections by dropping the database.
 */
async function by(deadline, now, work, late) {
  work.catch(() => {});
  const left = deadline - now();
  if (!Number.isFinite(left)) return work;
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(late()), Math.min(Math.max(0, left), 2 ** 31 - 1)); });
  try { return await Promise.race([work, expired]); } finally { clearTimeout(timer); }
}

/**
 * Run `round` until `outstanding()` reaches zero. Fail when the count has not fallen below its lowest value for
 * `stalls` rounds in a row, or when `deadline` (epoch ms) passes with work left: no round starts within `reserve` ms
 * of it, and a round or count still running at it is abandoned.
 */
export async function drain(label, { outstanding, round, deadline, stalls, reserve = 0, now = Date.now }) {
  if (!Number.isSafeInteger(stalls) || stalls < 1) throw new RangeError('stalls must be a positive integer');
  let left = null, rounds = 0;
  const late = () => new DrainStalledError(`${label}: ${left ?? 'work'} still outstanding at the drain deadline after ${rounds} rounds`);
  left = await by(deadline, now, outstanding(), late);
  let lowest = left, idle = 0;
  while (left > 0) {
    if (now() + reserve >= deadline) throw late();
    await by(deadline, now, round(), late);
    rounds++;
    left = await by(deadline, now, outstanding(), late);
    if (left < lowest) { lowest = left; idle = 0; }
    else if (++idle >= stalls) throw new DrainStalledError(`${label}: ${left} still outstanding after ${stalls} rounds without progress`);
  }
  return rounds;
}

/**
 * Deliver every record event, then every evidence item, of the database behind `pool`. A dead-lettered record event
 * stays outstanding, so it fails the drain instead of leaving its Ref unprojected. Every statement, message and step
 * is bounded by `deadline`, the outbox's claim of a message included.
 */
export async function drainProjections(pool, authority, embedders, { deadline, stalls }) {
  const projector = new RecordRetrievalProjector(pool, { embedders });
  const remaining = () => Math.max(1, deadline - Date.now());
  const sql = text => pool.query({ text, query_timeout: remaining() });
  const count = async text => Number((await sql(text)).rows[0].count);
  await drain('record events', { deadline, stalls, reserve: RESERVE_MS,
    outstanding: () => count(`SELECT count(*) FROM projection_outbox WHERE delivery_state<>'delivered'`),
    round: async () => {
      await sql(`UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second'
        WHERE delivery_state<>'delivered' AND dead_lettered_at IS NULL`);
      const sent = [];
      await dispatch(new PostgresOutbox(pool, authority), { send: async messages => { sent.push(...messages); } }, { deadline });
      // A message is processed within what is left; one not started by then keeps its dispatch lease until it expires.
      await consume(sent, async message => {
        const left = deadline - Date.now();
        if (left < RESERVE_MS) return 'retry';
        const outbox = new PostgresOutbox(pool, authority, { processingMs: Math.min(authority.requestBudgetMs, left) });
        return outbox.process(message, projector);
      }, 8);
    } });
  const worker = new PostgresRetrievalWorker(pool, { embedders });
  await drain('evidence projection jobs', { deadline, stalls, reserve: RESERVE_MS,
    outstanding: () => count(`SELECT count(*) FROM retrieval_outbox WHERE delivery_state='pending'`),
    round: async () => {
      await sql(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE delivery_state='pending'`);
      const left = deadline - Date.now();
      if (left >= RESERVE_MS) await worker.step({ budgetMs: Math.min(30_000, left) });
    } });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { DrainStalledError, drain } from '../scripts/retrieval-drain.mjs';

// The retrieval evaluation's drain rule (STA-49): progress is a new lowest outstanding count; anything else is a stall.
const run = (counts, options = {}) => {
  let index = 0, clock = 0;
  const rounds = [];
  return { rounds, done: drain('queue', { stalls: 2, deadline: options.deadline ?? Infinity, now: () => clock,
    outstanding: async () => counts[Math.min(index, counts.length - 1)],
    round: async () => { rounds.push(counts[index]); index++; clock += 10; } }) };
};

test('a drain that keeps reaching a new lowest count finishes, however long it takes', async () => {
  assert.equal(await run([9, 8, 8, 7, 7, 6, 3, 0]).done, 7);
  assert.equal(await run([0]).done, 0);
});

test('a count that only returns to an earlier level is no progress', async () => {
  // A retried item that briefly settles and comes back (5, 4, 5, 4) never gets below 4.
  const { done, rounds } = run([5, 4, 5, 4, 5, 4]);
  await assert.rejects(done, error => error instanceof DrainStalledError
    && error.message === 'queue: 4 still outstanding after 2 rounds without progress');
  assert.deepEqual(rounds, [5, 4, 5]);
});

test('the deadline ends a drain that is still progressing', async () => {
  await assert.rejects(run([9, 8, 7, 6, 5], { deadline: 20 }).done,
    error => error.message === 'queue: 7 still outstanding at the drain deadline after 2 rounds');
});

test('the stall limit is a positive integer', async () => {
  await assert.rejects(drain('queue', { stalls: 0, deadline: Infinity, outstanding: async () => 1, round: async () => {} }), RangeError);
});

test('a round or a count still running at the deadline is abandoned there', { timeout: 10_000 }, async () => {
  for (const stuck of ['round', 'outstanding']) {
    let counts = 0;
    const started = Date.now();
    await assert.rejects(drain('queue', { stalls: 5, deadline: started + 200,
      outstanding: () => stuck === 'outstanding' && counts++ > 0 ? new Promise(() => {}) : Promise.resolve(3),
      round: () => stuck === 'round' ? new Promise(() => {}) : Promise.resolve() }),
    error => error instanceof DrainStalledError && /^queue: 3 still outstanding at the drain deadline after [01] rounds$/.test(error.message));
    assert.ok(Date.now() - started < 1_000, `${stuck}: ended ${Date.now() - started} ms after it started`);
  }
});

test('no round starts within the reserve before the deadline', { timeout: 10_000 }, async () => {
  let rounds = 0;
  await assert.rejects(drain('queue', { stalls: 5, reserve: 1_000, deadline: 500, now: () => 0,
    outstanding: async () => 3, round: async () => { rounds++; } }), /^DrainStalledError: queue: 3 still outstanding at the drain deadline after 0 rounds$/);
  assert.equal(rounds, 0);
});

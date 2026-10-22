import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { consume, dispatch, parseDeliveryMessage } from '../packages/workers/dist/index.js';

const hint = (n, attempt = 1) => ({ eventId: `evt_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, attempt });

test('a failed or partial send releases every claimed lease; an empty tick sends nothing', async () => {
  const released = [];
  const store = claims => ({ claim: async () => ({ messages: claims, scan: 'whole' }), release: async messages => { released.push(...messages); return messages.length; },
    stepReconciliations: async () => 0 });
  let sends = 0;
  assert.deepEqual(await dispatch(store([]), { send: async () => { sends++; } }), { claimed: 0, sent: 0, released: 0, batches: 0 });
  assert.equal(sends, 0);
  assert.deepEqual(await dispatch(store([hint(1), hint(2)]), { send: async () => { sends++; } }),
    { claimed: 2, sent: 2, released: 0, batches: 1 });
  const failure = new Error('queue unavailable');
  const result = await dispatch(store([hint(3), hint(4)]), { send: async () => { throw failure; } });
  assert.deepEqual(result, { claimed: 2, sent: 0, released: 2, batches: 1, error: failure });
  assert.deepEqual(released, [hint(3), hint(4)]);
});

test('a dispatch tick keeps claiming until nothing is due, its budget is spent or a send fails', async () => {
  const queued = (...batches) => {
    const claims = [];
    return { claims, claim: async limits => { claims.push(limits); return { messages: batches.shift() ?? [], scan: 'whole' }; },
      release: async messages => messages.length, stepReconciliations: async () => 0 };
  };
  const sent = [];
  const transport = { send: async messages => { sent.push(...messages); } };
  // A short claim may only mean per-space caps; only an empty claim ends the tick early.
  const drained = queued([hint(1), hint(2)], [hint(3)], [hint(4), hint(5)]);
  assert.deepEqual(await dispatch(drained, transport, { budgetMs: 60_000, limits: { limit: 2 } }),
    { claimed: 5, sent: 5, released: 0, batches: 3 });
  assert.equal(drained.claims.length, 4);
  assert.deepEqual(drained.claims[0], { limit: 2 });
  // Without a budget a tick sends one batch, as before.
  assert.equal((await dispatch(queued([hint(6)], [hint(7)]), transport)).batches, 1);
  let clock = 0;
  const endless = { claim: async () => ({ messages: [hint(++clock)], scan: 'partial' }), release: async () => 0, stepReconciliations: async () => 0 };
  assert.equal((await dispatch(endless, transport, { budgetMs: 3, now: () => clock })).batches, 3);
  let calls = 0;
  const flaky = { send: async () => { if (++calls === 2) throw new Error('queue unavailable'); } };
  const partial = await dispatch(queued([hint(8)], [hint(9), hint(10)], [hint(11)]), flaky, { budgetMs: 60_000 });
  assert.deepEqual([partial.claimed, partial.sent, partial.released, partial.batches], [3, 1, 2, 2]);
  for (const budgetMs of [-1, 1.5, 600_001]) await assert.rejects(dispatch(endless, transport, { budgetMs }), RangeError);
});

test('an empty claim ends a tick only once the empty run has covered every live pair', async () => {
  const walk = (...claims) => {
    const seen = [];
    return { seen, claim: async () => { const next = claims.shift() ?? { messages: [], scan: 'whole' }; seen.push(next); return next; },
      release: async () => 0, stepReconciliations: async () => 0 };
  };
  const empty = scan => ({ messages: [], scan });
  const sent = [];
  const transport = { send: async messages => { sent.push(...messages); } };
  // Windows of non-due pairs precede due work; one start crossing is not yet a full pass.
  const behind = walk(empty('partial'), empty('wrapped'), empty('partial'), { messages: [hint(1)], scan: 'partial' },
    empty('wrapped'), empty('partial'), empty('wrapped'), empty('partial'));
  assert.deepEqual(await dispatch(behind, transport, { budgetMs: 60_000 }), { claimed: 1, sent: 1, released: 0, batches: 1 });
  assert.equal(behind.seen.length, 7, 'the tick stopped at the second start crossing after the last lease');
  assert.deepEqual(sent, [hint(1)]);
  // A walk that visited every pair ends the tick at once, and so does a busy cursor.
  const whole = walk(empty('whole'), { messages: [hint(2)], scan: 'whole' });
  assert.equal((await dispatch(whole, transport, { budgetMs: 60_000 })).claimed, 0);
  assert.equal(whole.seen.length, 1);
  // The budget still bounds a tick that never completes a pass.
  let clock = 0;
  const partial = { claim: async () => { clock++; return empty('partial'); }, release: async () => 0, stepReconciliations: async () => 0 };
  assert.equal((await dispatch(partial, transport, { budgetMs: 3, now: () => clock })).batches, 0);
  assert.equal(clock, 3);
});

test('a tick stops once the cell reaches its in-flight bound, with time and due work left', async () => {
  const claims = [];
  const store = (...results) => ({ claim: async limits => { claims.push(limits); return results.shift() ?? { messages: [hint(9)], scan: 'partial' }; },
    release: async () => 0, stepReconciliations: async () => 0 });
  const transport = { send: async () => {} };
  const limits = { inFlight: 3 };
  // The claim that reaches the bound is sent, and the tick claims no further.
  assert.deepEqual(await dispatch(store({ messages: [hint(1), hint(2)], scan: 'partial' },
    { messages: [hint(3)], scan: 'partial', full: true }), transport, { budgetMs: 60_000, limits }),
  { claimed: 3, sent: 3, released: 0, batches: 2 });
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0], limits);
  // An already full cell ends the tick on its first, empty claim.
  claims.length = 0;
  assert.equal((await dispatch(store({ messages: [], scan: 'partial', full: true }), transport, { budgetMs: 60_000 })).claimed, 0);
  assert.equal(claims.length, 1);
});

test('delivery hints have one exact shape and grant nothing else', () => {
  assert.deepEqual(parseDeliveryMessage(hint(1, 3)), hint(1, 3));
  for (const body of [null, [], 'evt', { ...hint(1), spaceId: 'sp_x' }, { eventId: hint(1).eventId }, hint(1, 0), hint(1, 1.5),
    { eventId: 'rec_1', attempt: 1 }, { eventId: `${hint(1).eventId}\n`, attempt: 1 }])
    assert.equal(parseDeliveryMessage(body), null, JSON.stringify(body));
});

test('consume bounds concurrency and isolates malformed, poison and infrastructure outcomes per hint', async () => {
  let active = 0;
  let peak = 0;
  const outcomes = await consume([hint(1), { bad: true }, hint(2), hint(3), hint(4), hint(5)], async message => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (message.eventId === hint(2).eventId) return 'failed';
    if (message.eventId === hint(3).eventId) throw new Error('connection refused');
    return 'applied';
  }, 2);
  assert.deepEqual(outcomes, ['applied', 'malformed', 'failed', 'retry', 'applied', 'applied']);
  assert.equal(peak, 2);
  await assert.rejects(consume([], async () => 'applied', 0), RangeError);
});

test('outbox grants reject an external admin URL without verified TLS before connecting', () => {
  const adminUrl = new URL('postgres://db.example.invalid/stateplane');
  adminUrl.username = 'admin';
  adminUrl.password = ['private', 'fixture'].join('-');
  const result = spawnSync(process.execPath, ['scripts/grant-outbox.mjs'], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: adminUrl.href, STATEPLANE_CELL_ROLE: 'cell_reader' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /External DATABASE_URL requires sslmode=verify-full/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
});

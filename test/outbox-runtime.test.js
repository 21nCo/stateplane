import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { consume, dispatch, parseDeliveryMessage } from '../packages/workers/dist/index.js';

const hint = (n, attempt = 1) => ({ eventId: `evt_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, attempt });

test('a failed or partial send releases every claimed lease; an empty tick sends nothing', async () => {
  const released = [];
  const store = claims => ({ claim: async () => claims, release: async messages => { released.push(...messages); return messages.length; },
    stepReconciliations: async () => 0 });
  let sends = 0;
  assert.deepEqual(await dispatch(store([]), { send: async () => { sends++; } }), { claimed: 0, sent: 0, released: 0 });
  assert.equal(sends, 0);
  assert.deepEqual(await dispatch(store([hint(1), hint(2)]), { send: async () => { sends++; } }), { claimed: 2, sent: 2, released: 0 });
  const failure = new Error('queue unavailable');
  const result = await dispatch(store([hint(3), hint(4)]), { send: async () => { throw failure; } });
  assert.deepEqual(result, { claimed: 2, sent: 0, released: 2, error: failure });
  assert.deepEqual(released, [hint(3), hint(4)]);
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

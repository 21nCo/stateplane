import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAuthority, PostgresOutbox } from '../../packages/postgres/dist/index.js';
import { consume, dispatch } from '../../packages/workers/dist/index.js';

// The cell-wide dispatcher sees every space, so this suite owns its database.
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_outbox_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: baseUrl });
await admin.connect();
try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
const target = new URL(baseUrl); target.pathname = `/${name}`;
execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: fileURLToPath(new URL('../..', import.meta.url)),
  env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'ignore' });
const pool = new pg.Pool({ connectionString: target.toString(), max: 8 });
test.after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: baseUrl });
  await cleanup.connect();
  try { await cleanup.query(`DROP DATABASE ${name}`); } finally { await cleanup.end(); }
});

const authority = new PostgresAuthority(pool, 3600);
const outbox = new PostgresOutbox(pool, authority);
const digest = value => createHash('sha256').update(value).digest('hex');
const drained = () => pool.query("UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE delivery_state<>'delivered' AND dead_lettered_at IS NULL");

/** Each test owns its spaces, so a fresh cursor-wide claim only sees the rows it wrote. */
async function space(collections = 1) {
  await pool.query("UPDATE projection_outbox SET delivery_state='delivered',available_at=clock_timestamp() WHERE delivery_state<>'delivered'");
  const spaceId = `sp_${randomUUID()}`;
  const ids = Array.from({ length: collections }, (_, index) => `entries_${index}_${randomUUID()}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    for (const collectionId of ids) {
      await client.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const scope = collectionId => ({ spaceId, collectionId, principalId: 'owner', credentialId: 'owner-session',
    capability: 'records:write', policyVersion: 1, placementGeneration: 1 });
  return { spaceId, collectionId: ids[0], ids, scope };
}

function write(scope, operation, data, extras = {}) {
  const key = randomUUID();
  const complete = operation === 'replace' ? { unique: [], indexes: [], ...extras } : extras;
  return authority.mutate(scope, { operation, idempotencyKey: key, requestDigest: digest(key),
    ...(data === undefined ? {} : { canonicalData: data }), ...complete });
}

/** A projector that records each fenced apply in order. */
function recorder(fail) {
  const applied = [];
  return { applied, apply: async change => {
    if (fail?.(change)) throw new Error('embedder unavailable');
    applied.push({ id: change.ref.id, revision: change.revision, deleted: change.deleted, generation: change.generation,
      data: change.canonicalData });
  } };
}

async function row(eventId) {
  return (await pool.query(`SELECT delivery_state,attempts,failures,outcome,generation,dead_lettered_at,last_error,
    available_at='infinity' AS parked FROM projection_outbox WHERE event_id=$1`, [eventId])).rows[0];
}
async function head(spaceId, recordId) {
  const found = (await pool.query('SELECT generation,revision,deleted FROM projection_heads WHERE space_id=$1 AND record_id=$2',
    [spaceId, recordId])).rows[0];
  return found && { generation: Number(found.generation), revision: Number(found.revision), deleted: found.deleted };
}
async function projection(scope, recordId) {
  return authority.transaction({ ...scope, capability: 'records:read' }, tx => tx.projection(recordId));
}

test('lost, failed and duplicate hints neither lose committed work nor spend the failure budget', async () => {
  const { scope, collectionId, spaceId } = await space();
  const receipt = await write(scope(collectionId), 'create', '{"label":"a"}');
  // The Queue rejects the batch: every lease is released without a failure.
  const outage = await dispatch(outbox, { send: async () => { throw new Error('queue unavailable'); } });
  assert.deepEqual([outage.claimed, outage.sent, outage.released], [1, 0, 1]);
  const [{ eventId }] = (await pool.query('SELECT event_id AS "eventId" FROM projection_outbox WHERE space_id=$1', [spaceId])).rows;
  assert.deepEqual(await row(eventId), { ...await row(eventId), delivery_state: 'pending', failures: 0 });
  // The dispatcher crashes after its claim commits and before any send.
  const [lost] = await outbox.claim();
  assert.equal(lost.eventId, eventId);
  assert.deepEqual(await outbox.claim(), [], 'an unexpired dispatch lease is not reclaimed');
  await drained();
  const sent = [];
  assert.equal((await dispatch(outbox, { send: async messages => { sent.push(...messages); } })).sent, 1);
  assert.equal(sent[0].attempt, lost.attempt + 1);
  assert.equal((await row(eventId)).failures, 0, 'an unstarted lease expiry is not a processing failure');
  const projector = recorder();
  // The stale hint from the crashed tick, then a redelivered duplicate.
  assert.deepEqual(await consume([lost, sent[0], sent[0], { ...sent[0], extra: true }], message => outbox.process(message, projector), 1),
    ['lost', 'applied', 'lost', 'malformed']);
  assert.deepEqual(projector.applied, [{ id: receipt.ref.id, revision: 1, deleted: false, generation: 1, data: '{"label":"a"}' }]);
  assert.deepEqual(await head(spaceId, receipt.ref.id), { generation: 1, revision: 1, deleted: false });
  assert.equal((await projection(scope(collectionId), receipt.ref.id)).state, 'current');

  // Two copies of one hint arriving together start the lease only once.
  await write(scope(collectionId), 'replace', '{"label":"b"}', { recordId: receipt.ref.id, expectedRevision: 1 });
  const [twice] = await outbox.claim();
  let prepared = 0;
  const counted = { prepare: async () => { prepared++; await new Promise(resolve => setTimeout(resolve, 50)); }, apply: projector.apply };
  assert.deepEqual((await Promise.all([outbox.process(twice, counted), outbox.process({ ...twice }, counted)])).sort(), ['applied', 'lost']);
  assert.equal(prepared, 1);
});

test('reordered and concurrent completions keep the newest revision and never resurrect a delete', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const created = await write(writer, 'create', '{"label":"a"}');
  const id = created.ref.id;
  await write(writer, 'replace', '{"label":"b"}', { recordId: id, expectedRevision: 1 });
  await write(writer, 'delete', undefined, { recordId: id, expectedRevision: 2 });
  const leases = await outbox.claim();
  const byRevision = new Map();
  for (const lease of leases) {
    const { revision } = (await pool.query('SELECT revision FROM projection_outbox WHERE event_id=$1', [lease.eventId])).rows[0];
    byRevision.set(Number(revision), lease);
  }
  const projector = recorder();
  assert.equal(await outbox.process(byRevision.get(3), projector), 'applied');
  assert.deepEqual(await Promise.all([outbox.process(byRevision.get(2), projector), outbox.process(byRevision.get(1), projector)]),
    ['superseded', 'superseded']);
  assert.deepEqual(projector.applied, [{ id, revision: 3, deleted: true, generation: 1, data: null }]);
  assert.deepEqual(await head(spaceId, id), { generation: 1, revision: 3, deleted: true });
  for (const lease of byRevision.values()) assert.equal((await row(lease.eventId)).delivery_state, 'delivered');

  // Racing completions for consecutive updates converge on the newest one.
  const second = await write(writer, 'create', '{"n":1}');
  for (let revision = 1; revision < 6; revision++)
    await write(writer, 'replace', `{"n":${revision + 1}}`, { recordId: second.ref.id, expectedRevision: revision });
  const racing = recorder();
  const results = await Promise.all((await outbox.claim()).reverse().map(lease => outbox.process(lease, racing)));
  assert.ok(results.includes('applied'));
  assert.deepEqual(await head(spaceId, second.ref.id), { generation: 1, revision: 6, deleted: false });
  assert.equal(racing.applied.at(-1).revision, 6, 'the last fenced apply is the newest revision');
  assert.ok(racing.applied.every((entry, index) => index === 0 || entry.revision > racing.applied[index - 1].revision));
});

test('worker restart, expired started lease and delayed completion recover once; poison parks without blocking others', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const slow = await write(writer, 'create', '{"label":"slow"}');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const hanging = { prepare: () => blocked, apply: async () => { throw new Error('a delayed worker must not apply'); } };
  const [first] = await outbox.claim();
  const delayed = outbox.process(first, hanging);
  for (let polls = 0; !(await pool.query('SELECT 1 FROM projection_outbox WHERE event_id=$1 AND started_attempt=attempts',
    [first.eventId])).rows.length; polls++) {
    assert.ok(polls < 200, 'the worker started its lease');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // The worker is presumed dead once its processing lease expires.
  await drained();
  const [second] = await outbox.claim();
  assert.equal(second.attempt, first.attempt + 1);
  assert.deepEqual(await row(first.eventId), { ...await row(first.eventId), failures: 1, last_error: 'Processing lease expired' });
  const restarted = recorder();
  assert.equal(await new PostgresOutbox(pool, authority).process(second, restarted), 'applied');
  release('prepared');
  assert.equal(await delayed, 'lost', 'a delayed completion of a reclaimed lease is fenced');
  assert.deepEqual(restarted.applied.map(entry => entry.revision), [1]);
  assert.deepEqual(await head(spaceId, slow.ref.id), { generation: 1, revision: 1, deleted: false });

  const poison = await write(writer, 'create', '{"label":"poison"}');
  const healthy = await write(writer, 'create', '{"label":"healthy"}');
  const projector = recorder(change => change.ref.id === poison.ref.id);
  for (let attempt = 1; attempt <= 8; attempt++) {
    await drained();
    const outcomes = await Promise.all((await outbox.claim()).map(lease => outbox.process(lease, projector)));
    assert.ok(outcomes.includes('failed'));
  }
  assert.deepEqual(projector.applied.map(entry => entry.id), [healthy.ref.id], 'the healthy item is not held behind poison');
  const parked = (await pool.query('SELECT event_id FROM projection_outbox WHERE space_id=$1 AND record_id=$2', [spaceId, poison.ref.id])).rows[0];
  assert.deepEqual(await row(parked.event_id), { ...await row(parked.event_id), delivery_state: 'degraded', failures: 8, parked: true,
    last_error: 'Error: embedder unavailable' });
  assert.ok((await row(parked.event_id)).dead_lettered_at);
  await drained();
  assert.deepEqual(await outbox.claim(), [], 'a dead letter is not redelivered without an operator');
  assert.equal((await projection(writer, poison.ref.id)).state, 'degraded');
  const status = await outbox.status(spaceId);
  assert.deepEqual(status.collections.map(entry => [entry.pending, entry.delivering, entry.degraded, entry.deadLettered, entry.lastError]),
    [[0, 0, 0, 1, 'Error: embedder unavailable']]);
  assert.ok(status.collections[0].lagSeconds >= 0 && status.lastDispatchAt);

  assert.equal(await outbox.retry('operator@example.invalid', spaceId, null, 'embedder restored'), 1);
  const audit = (await pool.query('SELECT action,operator,reason,affected FROM outbox_operator_audit WHERE space_id=$1', [spaceId])).rows;
  assert.deepEqual(audit, [{ action: 'retry', operator: 'operator@example.invalid', reason: 'embedder restored', affected: '1' }]);
  await assert.rejects(pool.query('DELETE FROM outbox_operator_audit WHERE space_id=$1', [spaceId]), /immutable/);
  const recovered = recorder();
  assert.deepEqual(await Promise.all((await outbox.claim()).map(lease => outbox.process(lease, recovered))), ['applied']);
  assert.equal((await projection(writer, poison.ref.id)).state, 'current');
});

test('placement fences and policy changes reject stale leases and requeue only the latest revision', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const record = await write(writer, 'create', '{"v":1}');
  await write(writer, 'replace', '{"v":2}', { recordId: record.ref.id, expectedRevision: 1 });
  const leases = await outbox.claim();
  await pool.query('UPDATE spaces SET placement_generation=2 WHERE space_id=$1', [spaceId]);
  const projector = recorder();
  // Generation-1 work never applies under generation 2; only revision 2 is current.
  assert.deepEqual(await Promise.all(leases.map(lease => outbox.process(lease, projector))).then(values => values.sort()),
    ['requeued', 'superseded']);
  assert.deepEqual(projector.applied, []);
  assert.equal((await projection({ ...writer, placementGeneration: 2 }, record.ref.id)).state, 'pending');
  const [requeued] = await outbox.claim();
  assert.equal(await outbox.process(requeued, projector), 'applied');
  assert.deepEqual(projector.applied.map(entry => [entry.revision, entry.generation]), [[2, 2]]);
  assert.deepEqual(await head(spaceId, record.ref.id), { generation: 2, revision: 2, deleted: false });

  // A policy change between start and completion releases the lease without a failure.
  await write({ ...writer, placementGeneration: 2 }, 'replace', '{"v":3}', { recordId: record.ref.id, expectedRevision: 2 });
  const racing = { prepare: async () => { await pool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1', [spaceId]); },
    apply: projector.apply };
  const [lease] = await outbox.claim();
  assert.equal(await outbox.process(lease, racing), 'released');
  assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0 });
  const [fresh] = await outbox.claim();
  assert.equal(await outbox.process(fresh, projector), 'applied');
  assert.deepEqual(await head(spaceId, record.ref.id), { generation: 2, revision: 3, deleted: false });

  // A suspended space is not dispatched; its committed work waits rather than failing.
  await write({ ...writer, placementGeneration: 2, policyVersion: 2 }, 'replace', '{"v":4}', { recordId: record.ref.id, expectedRevision: 3 });
  await pool.query("UPDATE spaces SET lifecycle='suspended',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  assert.deepEqual(await outbox.claim(), []);
  await pool.query("UPDATE spaces SET lifecycle='active',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  assert.deepEqual(await Promise.all((await outbox.claim()).map(next => outbox.process(next, projector))), ['applied']);
});

test('one busy space cannot monopolize a dispatch tick, and the cursor rotates across pairs', async () => {
  const busy = await space(2);
  const quiet = await space();
  // The busy space's work is older and spread over two collections.
  for (let index = 0; index < 12; index++) await write(busy.scope(busy.ids[index % 2]), 'create', `{"n":${index}}`);
  await write(quiet.scope(quiet.collectionId), 'create', '{"n":0}');
  const leased = await outbox.claim({ limit: 5, perSpace: 3 });
  const spaces = (await pool.query('SELECT space_id,count(*)::int AS n FROM projection_outbox WHERE event_id=ANY($1) GROUP BY space_id',
    [leased.map(lease => lease.eventId)])).rows;
  assert.deepEqual(Object.fromEntries(spaces.map(entry => [entry.space_id, entry.n])), { [busy.spaceId]: 3, [quiet.spaceId]: 1 });
  await outbox.release(leased);
  // A one-pair scan budget still reaches every pair over successive ticks.
  const visited = [];
  for (let tick = 0; tick < 3; tick++) {
    const [lease] = await outbox.claim({ pairs: 1, limit: 1 });
    visited.push((await pool.query('SELECT collection_id FROM projection_outbox WHERE event_id=$1', [lease.eventId])).rows[0].collection_id);
  }
  assert.deepEqual(new Set(visited), new Set([...busy.ids, quiet.collectionId]));
});

test('projection outage degrades search state while authoritative writes and exact reads continue', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const first = await write(writer, 'create', '{"label":"a"}');
  const down = recorder(() => true);
  assert.deepEqual(await Promise.all((await outbox.claim()).map(lease => outbox.process(lease, down))), ['failed']);
  const second = await write(writer, 'replace', '{"label":"b"}', { recordId: first.ref.id, expectedRevision: 1 });
  assert.equal(second.revision, 2);
  const read = await authority.transaction({ ...writer, capability: 'records:read' }, tx => tx.getRecord(first.ref.id));
  assert.deepEqual([read.revision, read.canonicalData], [2, '{"label":"b"}']);
  assert.equal((await projection(writer, first.ref.id)).state, 'pending');
  const status = await outbox.status(spaceId);
  assert.deepEqual(status.collections.map(entry => [entry.pending, entry.degraded, entry.lastError]), [[1, 1, 'Error: embedder unavailable']]);
  assert.ok(status.collections[0].oldestUndeliveredAt);
});

test('reconciliation pages are resumable, cancellable, audited and repair missing heads', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const ids = [];
  for (let index = 0; index < 5; index++) ids.push((await write(writer, 'create', `{"n":${index}}`)).ref.id);
  await Promise.all((await outbox.claim()).map(lease => outbox.process(lease)));
  // Projection state lost for two refs, as after a restore without projections.
  const lost = [...ids].sort().slice(1, 3);
  await pool.query('DELETE FROM projection_heads WHERE space_id=$1 AND record_id=ANY($2)', [spaceId, lost]);
  const started = await outbox.reconcile('operator', spaceId, collectionId, 'restore drill');
  assert.equal(started.created, true);
  assert.deepEqual(await outbox.reconcile('operator', spaceId, collectionId, 'again'), { jobId: started.jobId, created: false });
  assert.equal(await outbox.stepReconciliations(1, 2), 1);
  // A restarted worker resumes from the durable checkpoint.
  const restarted = new PostgresOutbox(pool, authority);
  assert.equal(await restarted.stepReconciliations(1, 2), 1);
  assert.equal(await restarted.stepReconciliations(1, 2), 1);
  const done = await restarted.reconciliation(started.jobId);
  assert.deepEqual([done.state, done.scanned, done.requeued], ['completed', 5, 2]);
  assert.equal(await restarted.stepReconciliations(1, 2), 0);
  const repaired = recorder();
  await Promise.all((await outbox.claim()).map(lease => outbox.process(lease, repaired)));
  assert.deepEqual(repaired.applied.map(entry => entry.id).sort(), lost);
  for (const id of ids) assert.equal((await head(spaceId, id)).revision, 1);

  const cancelled = await outbox.reconcile('operator', spaceId, collectionId, 'second pass');
  assert.equal((await outbox.cancel('operator', cancelled.jobId, 'not needed')).state, 'cancelled');
  assert.equal(await outbox.stepReconciliations(1, 2), 0);
  assert.equal((await outbox.reconciliation(cancelled.jobId)).scanned, 0);
  assert.deepEqual((await pool.query(`SELECT action FROM outbox_operator_audit WHERE space_id=$1 ORDER BY recorded_at`, [spaceId]))
    .rows.map(entry => entry.action), ['reconcile', 'reconcile', 'cancel']);
  await assert.rejects(outbox.retry('', spaceId, null, 'empty operator'), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(outbox.reconcile('operator', `sp_${randomUUID()}`, collectionId, 'missing'), error => error.code === 'NOT_FOUND');

  // Erasure removes projection state and jobs; operator audit facts survive.
  await outbox.reconcile('operator', spaceId, collectionId, 'pending at erasure');
  await pool.query("UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1", [spaceId]);
  await pool.query('SELECT stateplane_purge_space($1)', [spaceId]);
  for (const table of ['projection_heads', 'projection_reconciliations', 'projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId])).rows[0].n, 0, table);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM outbox_operator_audit WHERE space_id=$1', [spaceId])).rows[0].n, 4);
});

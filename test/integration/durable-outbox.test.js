import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CollectionRegistry, PostgresAuthority, PostgresOutbox, PostgresSpaces } from '../../packages/postgres/dist/index.js';
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
async function space(collections = 1, spaceId = `sp_${randomUUID()}`) {
  await pool.query("UPDATE projection_outbox SET delivery_state='delivered',available_at=clock_timestamp() WHERE delivery_state<>'delivered'");
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
  const [lost] = (await outbox.claim()).messages;
  assert.equal(lost.eventId, eventId);
  assert.deepEqual((await outbox.claim()).messages, [], 'an unexpired dispatch lease is not reclaimed');
  await drained();
  const sent = [];
  assert.equal((await dispatch(outbox, { send: async messages => { sent.push(...messages); } })).sent, 1);
  assert.equal(sent[0].attempt, lost.attempt + 1);
  assert.equal((await row(eventId)).failures, 0, 'an unstarted lease expiry is not a processing failure');
  const projector = recorder();
  // The late hint from the crashed tick starts the current unstarted lease;
  // that lease's own hint and a redelivered duplicate are then no-ops.
  assert.deepEqual(await consume([lost, sent[0], sent[0], { ...sent[0], extra: true }], message => outbox.process(message, projector), 1),
    ['applied', 'lost', 'lost', 'malformed']);
  assert.deepEqual(projector.applied, [{ id: receipt.ref.id, revision: 1, deleted: false, generation: 1, data: '{"label":"a"}' }]);
  assert.deepEqual(await head(spaceId, receipt.ref.id), { generation: 1, revision: 1, deleted: false });
  assert.equal((await projection(scope(collectionId), receipt.ref.id)).state, 'current');

  // Two copies of one hint arriving together start the lease only once.
  await write(scope(collectionId), 'replace', '{"label":"b"}', { recordId: receipt.ref.id, expectedRevision: 1 });
  const [twice] = (await outbox.claim()).messages;
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
  const leases = (await outbox.claim()).messages;
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
  const results = await Promise.all((await outbox.claim()).messages.reverse().map(lease => outbox.process(lease, racing)));
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
  const [first] = (await outbox.claim()).messages;
  const delayed = outbox.process(first, hanging);
  for (let polls = 0; !(await pool.query('SELECT 1 FROM projection_outbox WHERE event_id=$1 AND started_attempt=attempts',
    [first.eventId])).rows.length; polls++) {
    assert.ok(polls < 200, 'the worker started its lease');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // The worker is presumed dead once its processing lease expires.
  await drained();
  const [second] = (await outbox.claim()).messages;
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
    const outcomes = await Promise.all((await outbox.claim()).messages.map(lease => outbox.process(lease, projector)));
    assert.ok(outcomes.includes('failed'));
  }
  assert.deepEqual(projector.applied.map(entry => entry.id), [healthy.ref.id], 'the healthy item is not held behind poison');
  const parked = (await pool.query('SELECT event_id FROM projection_outbox WHERE space_id=$1 AND record_id=$2', [spaceId, poison.ref.id])).rows[0];
  assert.deepEqual(await row(parked.event_id), { ...await row(parked.event_id), delivery_state: 'degraded', failures: 8, parked: true,
    last_error: 'Error: embedder unavailable' });
  assert.ok((await row(parked.event_id)).dead_lettered_at);
  await drained();
  assert.deepEqual((await outbox.claim()).messages, [], 'a dead letter is not redelivered without an operator');
  assert.equal((await projection(writer, poison.ref.id)).state, 'degraded');
  const status = await outbox.status(spaceId);
  assert.deepEqual(status.collections.map(entry => [entry.pending, entry.delivering, entry.degraded, entry.deadLettered,
    entry.capped, entry.lastError]), [[0, 0, 0, 1, false, 'Error: embedder unavailable']]);
  assert.equal(status.more, false);
  assert.ok(status.collections[0].lagSeconds >= 0 && status.lastDispatchAt);

  assert.equal(await outbox.retry('operator@example.invalid', spaceId, null, 'embedder restored'), 1);
  const audit = (await pool.query('SELECT action,operator,reason,affected FROM outbox_operator_audit WHERE space_id=$1', [spaceId])).rows;
  assert.deepEqual(audit, [{ action: 'retry', operator: 'operator@example.invalid', reason: 'embedder restored', affected: '1' }]);
  await assert.rejects(pool.query('DELETE FROM outbox_operator_audit WHERE space_id=$1', [spaceId]), /immutable/);
  await assert.rejects(pool.query('TRUNCATE outbox_operator_audit'), /immutable/);
  const recovered = recorder();
  assert.deepEqual(await Promise.all((await outbox.claim()).messages.map(lease => outbox.process(lease, recovered))), ['applied']);
  assert.equal((await projection(writer, poison.ref.id)).state, 'current');
});

test('placement fences and policy changes reject stale leases and requeue only the latest revision', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const record = await write(writer, 'create', '{"v":1}');
  await write(writer, 'replace', '{"v":2}', { recordId: record.ref.id, expectedRevision: 1 });
  const leases = (await outbox.claim()).messages;
  await pool.query('UPDATE spaces SET placement_generation=2 WHERE space_id=$1', [spaceId]);
  const projector = recorder();
  // Generation-1 work never applies under generation 2; only revision 2 is current.
  assert.deepEqual(await Promise.all(leases.map(lease => outbox.process(lease, projector))).then(values => values.sort()),
    ['requeued', 'superseded']);
  assert.deepEqual(projector.applied, []);
  assert.equal((await projection({ ...writer, placementGeneration: 2 }, record.ref.id)).state, 'pending');
  const [requeued] = (await outbox.claim()).messages;
  assert.equal(await outbox.process(requeued, projector), 'applied');
  assert.deepEqual(projector.applied.map(entry => [entry.revision, entry.generation]), [[2, 2]]);
  assert.deepEqual(await head(spaceId, record.ref.id), { generation: 2, revision: 2, deleted: false });

  // A policy change between start and completion releases the lease without a failure.
  await write({ ...writer, placementGeneration: 2 }, 'replace', '{"v":3}', { recordId: record.ref.id, expectedRevision: 2 });
  const racing = { prepare: async () => { await pool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1', [spaceId]); },
    apply: projector.apply };
  const [lease] = (await outbox.claim()).messages;
  assert.equal(await outbox.process(lease, racing), 'released');
  assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0 });
  await drained();
  const [fresh] = (await outbox.claim()).messages;
  assert.equal(await outbox.process(fresh, projector), 'applied');
  assert.deepEqual(await head(spaceId, record.ref.id), { generation: 2, revision: 3, deleted: false });

  // A suspended space is not dispatched; its committed work waits rather than failing.
  await write({ ...writer, placementGeneration: 2, policyVersion: 2 }, 'replace', '{"v":4}', { recordId: record.ref.id, expectedRevision: 3 });
  await pool.query("UPDATE spaces SET lifecycle='suspended',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  assert.deepEqual((await outbox.claim()).messages, []);
  await pool.query("UPDATE spaces SET lifecycle='active',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  assert.deepEqual(await Promise.all((await outbox.claim()).messages.map(next => outbox.process(next, projector))), ['applied']);
});

test('one busy space cannot monopolize a dispatch tick, and the cursor rotates across pairs', async () => {
  const busy = await space(2);
  const quiet = await space();
  // The busy space's work is older and spread over two collections.
  for (let index = 0; index < 12; index++) await write(busy.scope(busy.ids[index % 2]), 'create', `{"n":${index}}`);
  await write(quiet.scope(quiet.collectionId), 'create', '{"n":0}');
  const leased = (await outbox.claim({ limit: 5, perSpace: 3 })).messages;
  const spaces = (await pool.query('SELECT space_id,count(*)::int AS n FROM projection_outbox WHERE event_id=ANY($1) GROUP BY space_id',
    [leased.map(lease => lease.eventId)])).rows;
  assert.deepEqual(Object.fromEntries(spaces.map(entry => [entry.space_id, entry.n])), { [busy.spaceId]: 3, [quiet.spaceId]: 1 });
  await outbox.release(leased);
  // A one-pair scan budget still reaches every pair over successive ticks.
  const visited = [];
  for (let tick = 0; tick < 3; tick++) {
    const [lease] = (await outbox.claim({ pairs: 1, limit: 1 })).messages;
    visited.push((await pool.query('SELECT collection_id FROM projection_outbox WHERE event_id=$1', [lease.eventId])).rows[0].collection_id);
  }
  assert.deepEqual(new Set(visited), new Set([...busy.ids, quiet.collectionId]));
});

test('projection outage degrades search state while authoritative writes and exact reads continue', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const first = await write(writer, 'create', '{"label":"a"}');
  const down = recorder(() => true);
  assert.deepEqual(await Promise.all((await outbox.claim()).messages.map(lease => outbox.process(lease, down))), ['failed']);
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
  await Promise.all((await outbox.claim()).messages.map(lease => outbox.process(lease)));
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
  await Promise.all((await outbox.claim()).messages.map(lease => outbox.process(lease, repaired)));
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

test('start fences lifecycle, collection and placement before any projector sees content', async () => {
  const { scope, ids, spaceId } = await space(2);
  const seen = [];
  const spy = { prepare: async change => { seen.push(['prepare', change.canonicalData]); },
    apply: async change => { seen.push(['apply', change.canonicalData]); } };
  const leases = new Map();
  const lease = async eventId => {
    for (const next of (await outbox.claim()).messages) leases.set(next.eventId, next);
    return leases.get(eventId);
  };
  const eventOf = async receipt => (await pool.query('SELECT event_id FROM projection_outbox WHERE space_id=$1 AND record_id=$2',
    [spaceId, receipt.ref.id])).rows[0].event_id;

  // Suspended between claim and processing: released at start, not failed.
  const first = await write(scope(ids[0]), 'create', '{"secret":1}');
  const firstEvent = await eventOf(first);
  const suspended = await lease(firstEvent);
  await pool.query("UPDATE spaces SET lifecycle='suspended',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  assert.equal(await outbox.process(suspended, spy), 'released');
  assert.deepEqual(await row(firstEvent), { ...await row(firstEvent), delivery_state: 'pending', failures: 0 });
  await pool.query("UPDATE spaces SET lifecycle='active',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]);
  const writer = collectionId => ({ ...scope(collectionId), policyVersion: 3 });

  // A collection deleted after the claim is released the same way.
  const second = await write(writer(ids[1]), 'create', '{"secret":2}');
  const secondEvent = await eventOf(second);
  // This claim also leases the released first record again.
  const orphaned = await lease(secondEvent);
  await pool.query("UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id=$2", [spaceId, ids[1]]);
  assert.equal(await outbox.process(orphaned, spy), 'released');

  // Work from an earlier placement is requeued under the new one without the projector.
  const stale = leases.get(firstEvent);
  await pool.query('UPDATE spaces SET placement_generation=placement_generation+1 WHERE space_id=$1', [spaceId]);
  assert.equal(await outbox.process(stale, spy), 'requeued');
  assert.deepEqual(seen, [], 'no projector callback ran for a closed or stale scope');
  assert.equal((await row(firstEvent)).generation, '2');
  assert.equal(await outbox.process(await lease(firstEvent), spy), 'applied');
  assert.deepEqual(seen, [['prepare', '{"secret":1}'], ['apply', '{"secret":1}']]);
});

test('the processing budget bounds apply: a hung projector fails its lease and cannot commit late', async () => {
  const { scope, collectionId, spaceId } = await space();
  const writer = scope(collectionId);
  const bounded = new PostgresOutbox(pool, authority, { processingMs: 300 });
  const hung = await write(writer, 'create', '{"label":"hung"}');
  const [first] = (await bounded.claim()).messages;
  const started = Date.now();
  assert.equal(await bounded.process(first, { apply: () => new Promise(() => {}) }), 'failed');
  assert.ok(Date.now() - started < 5_000, 'a never-settling apply ends at the budget');
  assert.deepEqual(await row(first.eventId), { ...await row(first.eventId), delivery_state: 'degraded', failures: 1 });
  assert.match((await row(first.eventId)).last_error, /time budget/);
  assert.equal(await head(spaceId, hung.ref.id), undefined, 'the rolled-back completion did not move the head');

  // An apply that wakes after the budget can no longer write through its query handle.
  await drained();
  const [second] = (await bounded.claim()).messages;
  let late;
  const sleepy = { apply: async (_change, _prepared, query) => {
    await new Promise(resolve => setTimeout(resolve, 600));
    await query("UPDATE projection_outbox SET last_error='late' WHERE event_id=$1", [second.eventId]).catch(error => { late = error; });
  } };
  assert.equal(await bounded.process(second, sleepy), 'failed');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(late, 'the late statement was refused');
  assert.equal((await row(second.eventId)).failures, 2);
  assert.notEqual((await row(second.eventId)).last_error, 'late');
  assert.equal(await head(spaceId, hung.ref.id), undefined);
});

test('a rolled-back infrastructure failure after start releases the lease without spending the failure budget', async () => {
  const { scope, collectionId } = await space();
  await write(scope(collectionId), 'create', '{"label":"a"}');
  const unreachable = new PostgresAuthority({ connect: async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); } }, 3600);
  const flapping = new PostgresOutbox(pool, unreachable);
  const [lease] = (await outbox.claim()).messages;
  await assert.rejects(flapping.process(lease, recorder()), /ECONNRESET/);
  assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0 });
  assert.deepEqual((await outbox.claim()).messages, [], 'an uncounted release still backs off briefly');
  await drained();
  const [next] = (await outbox.claim()).messages;
  assert.equal(next.eventId, lease.eventId);
  assert.equal((await row(lease.eventId)).failures, 0);
  assert.equal(await outbox.process(next, recorder()), 'applied');
});

test('successive claims rotate service across spaces when the limit cuts a claim short', async () => {
  // The backlog space sorts first, so cursor order alone would serve it every time.
  const backlog = await space(1, `sp_00000000-${randomUUID().slice(9)}`);
  const others = [await space(), await space()];
  await pool.query("UPDATE projection_outbox SET delivery_state='delivered' WHERE delivery_state<>'delivered'");
  for (let index = 0; index < 3; index++) await write(backlog.scope(backlog.collectionId), 'create', `{"n":${index}}`);
  for (const other of others) await write(other.scope(other.collectionId), 'create', '{"n":0}');
  const served = [];
  for (let claim = 0; claim < 3; claim++) {
    const [lease] = (await outbox.claim({ limit: 1 })).messages;
    served.push((await pool.query('SELECT space_id FROM projection_outbox WHERE event_id=$1', [lease.eventId])).rows[0].space_id);
  }
  assert.deepEqual(new Set(served), new Set([backlog.spaceId, ...others.map(other => other.spaceId)]),
    'the older backlog does not take every claim');
  // One budgeted tick drains more than one claim's worth of due rows.
  await pool.query("UPDATE projection_outbox SET delivery_state='delivered' WHERE delivery_state<>'delivered'");
  for (let index = 0; index < 7; index++) await write(backlog.scope(backlog.collectionId), 'create', `{"m":${index}}`);
  const tick = await dispatch(outbox, { send: async () => {} }, { budgetMs: 10_000, limits: { limit: 3 } });
  assert.deepEqual([tick.claimed, tick.batches], [7, 3]);
});

test('a placement fence schedules re-projection that converges with no operator step, and status shows it', async () => {
  const { scope, collectionId, spaceId } = await space();
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,'owner','cell-a','cell-a','target-a','active')`, [spaceId]);
  const writer = scope(collectionId);
  const ids = [];
  for (let index = 0; index < 3; index++) ids.push((await write(writer, 'create', `{"n":${index}}`)).ref.id);
  await write(writer, 'delete', undefined, { recordId: ids[2], expectedRevision: 1 });
  const projector = recorder();
  const tick = async () => {
    const sent = [];
    await outbox.stepReconciliations(4, 2);
    await dispatch(outbox, { send: async messages => { sent.push(...messages); } }, { budgetMs: 1_000 });
    return Promise.all(sent.map(message => outbox.process(message, projector)));
  };
  await tick();
  assert.deepEqual(await head(spaceId, ids[0]), { generation: 1, revision: 1, deleted: false });

  const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
    { create: async () => { throw new Error('unexpected provider create'); }, find: async () => null, revoke: async () => {} },
    { current: async () => true });
  assert.equal(await spaces.fencePlacement(spaceId, 'cell-a', 1), 2);
  const fenced = { ...writer, placementGeneration: 2 };
  assert.equal((await projection(fenced, ids[0])).state, 'pending');
  const repairing = await outbox.status(spaceId);
  assert.deepEqual(repairing.reconciliations.map(job => [job.collectionId, job.cause, job.state]), [[collectionId, 'placement', 'running']]);

  for (let round = 0; round < 10 && (await outbox.reconciliation(repairing.reconciliations[0].jobId)).state === 'running'; round++)
    await tick();
  await tick();
  assert.equal((await outbox.reconciliation(repairing.reconciliations[0].jobId)).state, 'completed');
  for (const id of ids.slice(0, 2)) {
    assert.equal((await projection(fenced, id)).state, 'current');
    assert.deepEqual(await head(spaceId, id), { generation: 2, revision: 1, deleted: false });
  }
  assert.deepEqual(await head(spaceId, ids[2]), { generation: 2, revision: 2, deleted: true }, 'the delete stays deleted');
  assert.deepEqual(projector.applied.filter(entry => entry.generation === 2).map(entry => entry.id).sort(), [...ids].sort());
  assert.deepEqual((await outbox.status(spaceId)).collections, []);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fencer = () => new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  { create: async () => { throw new Error('unexpected provider create'); }, find: async () => null, revoke: async () => {} },
  { current: async () => true });
async function deliver(projector) {
  const sent = [];
  await dispatch(outbox, { send: async messages => { sent.push(...messages); } }, { budgetMs: 1_000 });
  return Promise.all(sent.map(message => outbox.process(message, projector)));
}

test('the processing deadline follows the authority budget, so the client rolls back before the server backstop', async () => {
  const { scope, collectionId, spaceId } = await space();
  const short = new PostgresAuthority(pool, 3600, undefined, 1_500);
  const derived = new PostgresOutbox(pool, short);
  assert.throws(() => new PostgresOutbox(pool, short, { processingMs: 1_501 }), { code: 'INVALID_ARGUMENT' });
  const created = await write(scope(collectionId), 'create', '{"label":"idle"}');
  const [lease] = (await derived.claim()).messages;
  const started = Date.now();
  assert.equal(await derived.process(lease, { apply: () => new Promise(() => {}) }), 'failed');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1_400 && elapsed < 3_000, `the client aborted at the authority deadline (${elapsed} ms)`);
  assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'degraded', failures: 1 });
  assert.match((await row(lease.eventId)).last_error, /time budget/);
  assert.equal(await head(spaceId, created.ref.id), undefined);
  // Past the old server-side backstop, the pool's sessions are all healthy.
  await sleep(5_500);
  assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
});

test('infrastructure faults inside apply release the lease uncounted; a projector error still counts', async () => {
  const { scope, collectionId, spaceId } = await space();
  const created = await write(scope(collectionId), 'create', '{"label":"a"}');
  await pool.query('CREATE TABLE IF NOT EXISTS outbox_test_locks(id integer PRIMARY KEY)');
  await pool.query('INSERT INTO outbox_test_locks VALUES(1) ON CONFLICT DO NOTHING');
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM outbox_test_locks WHERE id=1 FOR UPDATE');
    const [locked] = (await outbox.claim()).messages;
    // The projector swallows the lock timeout and throws its own error; the fault still decides.
    const contended = { apply: async (_change, _prepared, query) => {
      await query("SET LOCAL lock_timeout = '100ms'");
      await query('SELECT id FROM outbox_test_locks WHERE id=1 FOR UPDATE').catch(() => { throw new Error('index busy'); });
    } };
    await assert.rejects(outbox.process(locked, contended), { code: 'BACKPRESSURE' });
    assert.deepEqual(await row(locked.eventId), { ...await row(locked.eventId), delivery_state: 'pending', failures: 0 });
  } finally { await holder.query('ROLLBACK'); holder.release(); }

  await drained();
  const [terminated] = (await outbox.claim()).messages;
  const killed = { apply: async (_change, _prepared, query) => {
    const { pid } = (await query('SELECT pg_backend_pid() AS pid')).rows[0];
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    // The server ends the session while it is idle in the transaction.
    await sleep(300);
    await query('SELECT 1');
  } };
  await assert.rejects(outbox.process(terminated, killed), /not queryable|Connection terminated/);
  assert.deepEqual(await row(terminated.eventId), { ...await row(terminated.eventId), delivery_state: 'pending', failures: 0 });
  assert.equal(await head(spaceId, created.ref.id), undefined);

  await drained();
  const [poison] = (await outbox.claim()).messages;
  assert.equal(await outbox.process(poison, { apply: async () => { throw new Error('bad document'); } }), 'failed');
  assert.equal((await row(poison.eventId)).failures, 1);
  // A Node ERR_* programming error raised through the port is the item's, not infrastructure.
  await drained();
  const [misused] = (await outbox.claim()).messages;
  const invalid = { apply: async (_change, _prepared, query) => { await query('SELECT $1::text', [{ toPostgres: () => Buffer.from(42) }]); } };
  assert.equal(await outbox.process(misused, invalid), 'failed');
  assert.deepEqual(await row(misused.eventId), { ...await row(misused.eventId), failures: 2 });
  assert.match((await row(misused.eventId)).last_error, /ERR_INVALID_ARG_TYPE|argument/);
});

test('a tick reaches due work behind more than a claim window of live pairs with nothing due', async () => {
  const parked = await space(150, `sp_00000000-${randomUUID().slice(9)}`);
  const paused = await space(60, `sp_00000001-${randomUUID().slice(9)}`);
  const due = await space(1, `sp_ffffffff-${randomUUID().slice(9)}`);
  for (const [index, id] of parked.ids.entries()) await write(parked.scope(id), 'create', `{"n":${index}}`);
  for (const id of paused.ids) await write(paused.scope(id), 'create', '{"n":0}');
  const target = await write(due.scope(due.collectionId), 'create', '{"n":0}');
  // Dead letters, rows in backoff and a suspended space keep 210 pairs live with nothing due.
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=8,dead_lettered_at=clock_timestamp(),
    available_at='infinity' WHERE space_id=$1 AND collection_id=ANY($2)`, [parked.spaceId, parked.ids.filter((_, i) => i % 2 === 0)]);
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=1,available_at=clock_timestamp()+interval '1 hour'
    WHERE space_id=$1 AND dead_lettered_at IS NULL`, [parked.spaceId]);
  await pool.query("UPDATE spaces SET lifecycle='suspended',policy_version=policy_version+1 WHERE space_id=$1", [paused.spaceId]);
  await pool.query('UPDATE outbox_dispatch_checkpoint SET after_space_id=NULL,after_collection_id=NULL');
  try {
    const sent = [];
    const tick = await dispatch(outbox, { send: async messages => { sent.push(...messages); } }, { budgetMs: 10_000 });
    assert.deepEqual([tick.sent, tick.batches], [1, 1]);
    const { eventId } = (await pool.query('SELECT event_id AS "eventId" FROM projection_outbox WHERE record_id=$1', [target.ref.id])).rows[0];
    assert.equal(sent[0].eventId, eventId);
    // With nothing due anywhere, a tick ends after one full pass instead of spending its budget.
    const started = Date.now();
    const idle = await dispatch(outbox, { send: async () => {} }, { budgetMs: 10_000 });
    assert.equal(idle.claimed, 0);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await pool.query(`UPDATE projection_outbox SET dead_lettered_at=NULL,available_at=clock_timestamp() WHERE space_id=$1`, [parked.spaceId]);
  }
});

test('a placement fence that commits while a step scans for its job is still repaired', async () => {
  const { scope, collectionId, spaceId } = await space();
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,'owner','cell-a','cell-a','target-a','active')`, [spaceId]);
  const writer = scope(collectionId);
  const ids = [];
  for (let index = 0; index < 2; index++) ids.push((await write(writer, 'create', `{"n":${index}}`)).ref.id);
  await deliver(recorder());
  await pool.query("UPDATE projection_reconciliations SET state='cancelled' WHERE state='running'");
  const { jobId } = await outbox.reconcile('operator@example.test', spaceId, collectionId, 'race fixture');

  // A role-scoped row policy parks the step's job scan, after its snapshot
  // and before its row lock, on an advisory lock this test holds.
  const role = `outbox_paused_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  await pool.query(`GRANT SELECT,UPDATE ON projection_reconciliations,projection_outbox TO ${role}`);
  await pool.query(`GRANT SELECT ON spaces,collections,records,record_events,projection_heads TO ${role}`);
  await pool.query(`CREATE OR REPLACE FUNCTION outbox_test_pause() RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_lock_shared(4242); PERFORM pg_advisory_unlock_shared(4242); RETURN true; END $$`);
  await pool.query(`CREATE POLICY outbox_test_pause ON projection_reconciliations TO ${role} USING (outbox_test_pause())`);
  await pool.query('ALTER TABLE projection_reconciliations ENABLE ROW LEVEL SECURITY');
  const pausedPool = new pg.Pool({ connectionString: target.toString(), max: 1, options: `-c role=${role}` });
  const gate = await pool.connect();
  try {
    await gate.query('SELECT pg_advisory_lock(4242)');
    const stepping = new PostgresOutbox(pausedPool, authority).stepReconciliations(1, 100);
    for (let polls = 0; ; polls++) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event='advisory'
        AND query LIKE '%projection_reconciliations%'`);
      if (waiting.rows.length) break;
      assert.ok(polls < 100, 'the step reached the paused scan');
      await sleep(50);
    }
    assert.equal(await fencer().fencePlacement(spaceId, 'cell-a', 1), 2);
    await gate.query('SELECT pg_advisory_unlock(4242)');
    assert.equal(await stepping, 1);
  } finally {
    gate.release();
    await pausedPool.end();
    await pool.query('ALTER TABLE projection_reconciliations DISABLE ROW LEVEL SECURITY');
    await pool.query('DROP POLICY outbox_test_pause ON projection_reconciliations');
    await pool.query('DROP FUNCTION outbox_test_pause()');
    await pool.query(`REVOKE ALL ON projection_reconciliations,projection_outbox,spaces,collections,records,record_events,
      projection_heads FROM ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
  const projector = recorder();
  for (let round = 0; round < 5; round++) { await outbox.stepReconciliations(); await deliver(projector); }
  assert.equal((await outbox.reconciliation(jobId)).state, 'completed');
  const fenced = { ...writer, placementGeneration: 2 };
  for (const id of ids) {
    assert.equal((await projection(fenced, id)).state, 'current', 'the step paged under the fence generation');
    assert.deepEqual(await head(spaceId, id), { generation: 2, revision: 1, deleted: false });
  }
});

test('a first apply held open does not block replace, patch or delete of its record', async () => {
  const { spaceId } = await space(0);
  const collectionId = `entries_${randomUUID()}`;
  const owner = { spaceId, collectionId, principalId: 'owner', credentialId: 'owner-session', capability: 'schema:write',
    policyVersion: 1, placementGeneration: 1 };
  await new CollectionRegistry(pool).define(owner, { slug: collectionId, version: 1, unique: [], filterable: [], sortable: [],
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
      properties: { label: { type: 'string' } }, required: ['label'] } });
  const writer = { ...owner, capability: 'records:write' };
  const request = body => authority.mutateRequest(writer, { idempotencyKey: randomUUID(), ...body });
  const created = await request({ operation: 'create', data: { label: 'a' } });
  const id = created.ref.id;
  const [lease] = (await outbox.claim()).messages;
  let entered;
  let open;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { open = resolve; });
  const completing = outbox.process(lease, { apply: async () => { entered(); await gate; } });
  await inside;
  const prompt = (work, label) => Promise.race([work, sleep(3_000).then(() => { throw new Error(`${label} waited for projection`); })]);
  try {
    await prompt(request({ operation: 'replace', id, expectedRevision: 1, data: { label: 'b' } }), 'replace');
    await prompt(request({ operation: 'patch', id, expectedRevision: 2, set: { label: 'c' }, unset: [] }), 'patch');
    await prompt(request({ operation: 'delete', id, expectedRevision: 3 }), 'delete');
  } finally { open(); }
  assert.equal(await completing, 'applied');
  assert.deepEqual(await head(spaceId, id), { generation: 1, revision: 1, deleted: false });
  const projector = recorder();
  await deliver(projector);
  assert.deepEqual(await head(spaceId, id), { generation: 1, revision: 4, deleted: true });
  assert.equal((await projection({ ...writer, capability: 'records:read' }, id)).state, 'current');
});

test('dispatch stops at the in-flight bound, and hints that arrive after their lease expired still converge', async () => {
  const { scope, collectionId, spaceId } = await space();
  for (let n = 0; n < 12; n++) await write(scope(collectionId), 'create', `{"n":${n}}`);
  const limits = { limit: 4, perSpace: 4, inFlight: 5 };
  const unstarted = async () => Number((await pool.query(`SELECT count(*) AS n FROM projection_outbox WHERE space_id=$1
    AND delivery_state='delivering' AND started_attempt IS NULL AND available_at>clock_timestamp()`, [spaceId])).rows[0].n);
  const queue = [];
  const transport = { send: async messages => { queue.push(...messages); } };
  const first = await dispatch(outbox, transport, { budgetMs: 10_000, limits });
  assert.deepEqual([first.claimed, first.batches], [5, 2], 'the second claim is cut to the bound and ends the tick');
  assert.equal(await unstarted(), 5);
  assert.equal((await dispatch(outbox, transport, { budgetMs: 10_000, limits })).claimed, 0, 'a full cell claims nothing');
  // Consumers lag so far that every hint arrives after its lease expired and
  // the row was leased again; each late hint still starts the current lease.
  const projector = recorder();
  const outcomes = [];
  for (let tick = 0; tick < 10 && projector.applied.length < 12; tick++) {
    const late = queue.splice(0);
    await drained();
    await dispatch(outbox, transport, { budgetMs: 10_000, limits });
    assert.ok(await unstarted() <= 5);
    outcomes.push(...await Promise.all(late.map(message => outbox.process(message, projector))));
  }
  assert.equal(new Set(projector.applied.map(entry => entry.id)).size, 12, 'the backlog converges with no operator');
  assert.ok(outcomes.includes('lost'), 'hints for rows already started are fenced');
  assert.deepEqual((await pool.query(`SELECT DISTINCT delivery_state,failures FROM projection_outbox WHERE space_id=$1`,
    [spaceId])).rows, [{ delivery_state: 'delivered', failures: 0 }]);
});

test('status reports dead letters and backoff behind more due rows than its sample', async () => {
  const { scope, collectionId, spaceId } = await space();
  await Promise.all(Array.from({ length: 8 }, async (_, worker) => {
    for (let n = worker; n < 502; n += 8) await write(scope(collectionId), 'create', `{"n":${n}}`);
  }));
  const parked = await write(scope(collectionId), 'create', '{"n":"parked"}');
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=1,last_error='Error: backoff',
    available_at=clock_timestamp()+interval '1 hour' WHERE event_id=(SELECT min(event_id) FROM projection_outbox WHERE space_id=$1)`, [spaceId]);
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=8,dead_lettered_at=clock_timestamp(),
    last_error='Error: parked',available_at='infinity' WHERE space_id=$1 AND record_id=$2`, [spaceId, parked.ref.id]);
  try {
    const [status] = (await outbox.status(spaceId)).collections;
    assert.deepEqual([status.pending, status.capped, status.degraded, status.deadLettered, status.failuresCapped, status.lastError],
      [500, true, 1, 1, false, 'Error: parked']);
  } finally {
    await pool.query('UPDATE projection_outbox SET dead_lettered_at=NULL,available_at=clock_timestamp() WHERE space_id=$1', [spaceId]);
  }
});

test('a completion queued behind another completion of its ref gives way uncounted', async () => {
  const { scope, collectionId, spaceId } = await space();
  const created = await write(scope(collectionId), 'create', '{"v":1}');
  await write(scope(collectionId), 'replace', '{"v":2}', { recordId: created.ref.id, expectedRevision: 1 });
  const leases = new Map();
  for (const lease of (await outbox.claim()).messages)
    leases.set(Number((await pool.query('SELECT revision FROM projection_outbox WHERE event_id=$1', [lease.eventId])).rows[0].revision), lease);
  let entered;
  let open;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { open = resolve; });
  const holding = outbox.process(leases.get(1), { apply: async () => { entered(); await gate; } });
  await inside;
  const started = Date.now();
  try {
    await assert.rejects(outbox.process(leases.get(2), recorder()), { code: 'BACKPRESSURE' });
    assert.ok(Date.now() - started < 4_000, 'the head lock wait is bounded well inside the budget');
    assert.deepEqual(await row(leases.get(2).eventId), { ...await row(leases.get(2).eventId), delivery_state: 'pending', failures: 0 });
  } finally { open(); }
  assert.equal(await holding, 'applied');
  await drained();
  assert.deepEqual(await deliver(recorder()), ['applied']);
  assert.deepEqual(await head(spaceId, created.ref.id), { generation: 1, revision: 2, deleted: false });
});

test('a tick that parks exhausted leases keeps going and leases the due work behind them', async () => {
  // Expired started leases at the last allowed failure park on their next claim.
  const exhaust = spaceId => pool.query(`UPDATE projection_outbox SET delivery_state='delivering',attempts=8,started_attempt=8,
    failures=7,available_at=clock_timestamp()-interval '1 hour' WHERE space_id=$1`, [spaceId]);
  const eventOf = async recordId => (await pool.query('SELECT event_id FROM projection_outbox WHERE record_id=$1', [recordId])).rows[0].event_id;
  const tick = async (limits, deadSpaces) => {
    await pool.query('UPDATE outbox_dispatch_checkpoint SET after_space_id=NULL,after_collection_id=NULL');
    const sent = [];
    const result = await dispatch(outbox, { send: async messages => { sent.push(...messages); } }, { budgetMs: 10_000, limits });
    const dead = await pool.query(`SELECT count(*)::int AS n FROM projection_outbox WHERE space_id=ANY($1) AND dead_lettered_at IS NOT NULL`,
      [deadSpaces]);
    return { result, sent, dead: dead.rows[0].n };
  };
  // Later fixtures settle every live row, which a dead letter may not be.
  const revive = spaceIds => pool.query(`UPDATE projection_outbox SET dead_lettered_at=NULL,available_at=clock_timestamp()
    WHERE space_id=ANY($1)`, [spaceIds]);
  // More poison rows than one claim's per-space share sit ahead of a healthy row in one collection.
  const one = await space();
  for (let n = 0; n < 30; n++) await write(one.scope(one.collectionId), 'create', `{"n":${n}}`);
  await exhaust(one.spaceId);
  const healthy = await write(one.scope(one.collectionId), 'create', '{"n":"healthy"}');
  const single = await tick(undefined, [one.spaceId]);
  await revive([one.spaceId]);
  assert.deepEqual([single.result.parked, single.dead, single.sent.map(m => m.eventId)], [30, 30, [await eventOf(healthy.ref.id)]]);

  // Earlier spaces fill whole claims with poison rows when the limit is lowered.
  const poisoned = [];
  for (let index = 0; index < 5; index++) poisoned.push(await space(1, `sp_0000000${index}-${randomUUID().slice(9)}`));
  const later = await space(1, `sp_ffffffff-${randomUUID().slice(9)}`);
  for (const each of poisoned) {
    for (let n = 0; n < 3; n++) await write(each.scope(each.collectionId), 'create', `{"n":${n}}`);
    await exhaust(each.spaceId);
  }
  const behind = await write(later.scope(later.collectionId), 'create', '{"n":"healthy"}');
  const spread = await tick({ limit: 4, perSpace: 2 }, poisoned.map(each => each.spaceId));
  await revive(poisoned.map(each => each.spaceId));
  assert.deepEqual([spread.result.parked, spread.dead, spread.sent.map(m => m.eventId)], [15, 15, [await eventOf(behind.ref.id)]]);
});

test('completion errors: an error reply to COMMIT is a known rollback, and only infrastructure goes uncounted', async () => {
  const { scope, collectionId, spaceId } = await space();
  const created = await write(scope(collectionId), 'create', '{"v":1}');
  const [lease] = (await outbox.claim()).messages;
  // A writer holds the record past the head's deferred foreign key check at COMMIT.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM records WHERE space_id=$1 AND record_id=$2 FOR UPDATE', [spaceId, created.ref.id]);
    await assert.rejects(outbox.process(lease, recorder()), error => error.name === 'CommitOutcomeUnknownError' && error.cause?.code === '55P03');
    assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0 });
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.equal(await head(spaceId, created.ref.id), undefined);

  // Any other error from completion spends the failure budget, so a deterministic one reaches the dead letter.
  await drained();
  const [broken] = (await outbox.claim()).messages;
  const faulty = new PostgresOutbox(pool, { requestBudgetMs: authority.requestBudgetMs,
    transaction: (txScope, fn, ...rest) => authority.transaction(txScope, async tx => { await fn(tx); throw new Error('completion invariant broken'); }, ...rest) });
  assert.equal(await faulty.process(broken, recorder()), 'failed');
  assert.deepEqual(await row(broken.eventId), { ...await row(broken.eventId), delivery_state: 'degraded', failures: 1,
    last_error: 'Error: completion invariant broken' });
  assert.equal(await head(spaceId, created.ref.id), undefined);
  await drained();
  assert.deepEqual(await deliver(recorder()), ['applied']);
  assert.deepEqual(await head(spaceId, created.ref.id), { generation: 1, revision: 1, deleted: false });
});

test('apply cannot hide an infrastructure fault: catching it and returning, or issuing more SQL, still releases uncounted', async () => {
  const { scope, collectionId, spaceId } = await space();
  const created = await write(scope(collectionId), 'create', '{"label":"a"}');
  await pool.query('CREATE TABLE IF NOT EXISTS outbox_test_locks(id integer PRIMARY KEY)');
  await pool.query('INSERT INTO outbox_test_locks VALUES(1) ON CONFLICT DO NOTHING');
  const contend = query => query("SET LOCAL lock_timeout = '100ms'")
    .then(() => query('SELECT id FROM outbox_test_locks WHERE id=1 FOR UPDATE')).catch(() => {});
  const swallowing = {
    returned: { apply: async (_change, _prepared, query) => { await contend(query); } },
    continued: { apply: async (_change, _prepared, query) => { await contend(query); await query('SELECT 1'); } }
  };
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM outbox_test_locks WHERE id=1 FOR UPDATE');
    for (const projector of Object.values(swallowing)) {
      await drained();
      const [lease] = (await outbox.claim()).messages;
      await assert.rejects(outbox.process(lease, projector), { code: 'BACKPRESSURE' });
      assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0, last_error: null });
    }
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  assert.equal(await head(spaceId, created.ref.id), undefined);
  // The projector's own SQL error, swallowed before more SQL, is still the item's and counts.
  await drained();
  const [own] = (await outbox.claim()).messages;
  const careless = { apply: async (_change, _prepared, query) => {
    await query('SELECT 1/0').catch(() => {});
    await query('SELECT 1');
  } };
  assert.equal(await outbox.process(own, careless), 'failed');
  assert.deepEqual(await row(own.eventId), { ...await row(own.eventId), delivery_state: 'degraded', failures: 1 });
});

test('start reads scope after its row lock, so a change committed during the lock wait reaches no projector', async () => {
  const seen = [];
  const spy = { prepare: async change => { seen.push(['prepare', change.canonicalData]); },
    apply: async change => { seen.push(['apply', change.canonicalData]); } };
  const waiting = async () => {
    for (let tries = 0; tries < 250; tries++) {
      const { count } = (await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM projection_outbox%FOR UPDATE%'`)).rows[0];
      if (count > 0) return;
      await sleep(20);
    }
    throw new Error('start never waited for the row lock');
  };
  const raced = async (change, setup) => {
    const { scope, collectionId, spaceId } = await space();
    await setup?.(spaceId);
    await write(scope(collectionId), 'create', '{"label":"secret"}');
    const [lease] = (await outbox.claim()).messages;
    const blocker = await pool.connect();
    try {
      // A reclaiming dispatcher holds the row while the scope change commits.
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE projection_outbox SET attempts=attempts+1,available_at=clock_timestamp()+interval '5 minutes'
        WHERE event_id=$1`, [lease.eventId]);
      const outcome = outbox.process(lease, spy);
      await waiting();
      await change(spaceId, collectionId);
      await blocker.query('COMMIT');
      return { outcome: await outcome, row: await row(lease.eventId) };
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  };

  const suspended = await raced(spaceId =>
    pool.query("UPDATE spaces SET lifecycle='suspended',policy_version=policy_version+1 WHERE space_id=$1", [spaceId]));
  assert.deepEqual([suspended.outcome, suspended.row.delivery_state, suspended.row.failures], ['released', 'pending', 0]);
  const deleted = await raced((spaceId, collectionId) =>
    pool.query("UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id=$2", [spaceId, collectionId]));
  assert.deepEqual([deleted.outcome, deleted.row.delivery_state, deleted.row.failures], ['released', 'pending', 0]);
  const fenced = await raced(spaceId => fencer().fencePlacement(spaceId, 'cell-a', 1),
    spaceId => pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
      VALUES($1,'owner','cell-a','cell-a','target-a','active')`, [spaceId]));
  assert.deepEqual([fenced.outcome, fenced.row.delivery_state, fenced.row.generation], ['requeued', 'pending', '2']);
  assert.deepEqual(seen, [], 'no projector callback saw content for a scope that changed before start decided');
});

test('a client read timeout is a lost session: released uncounted and the session discarded', async () => {
  const { scope, collectionId, spaceId } = await space();
  const created = await write(scope(collectionId), 'create', '{"label":"a"}');
  // Only completion's pool has the short client bound; the lingering server
  // statement ends after it, and the release then proceeds.
  const impatient = new pg.Pool({ connectionString: target.toString(), max: 2, query_timeout: 300 });
  try {
    const reader = new PostgresOutbox(pool, new PostgresAuthority(impatient, 3600));
    const [lease] = (await reader.claim()).messages;
    await assert.rejects(reader.process(lease, { apply: async (_change, _prepared, query) => { await query('SELECT pg_sleep(1)'); } }),
      /Query read timeout/);
    assert.deepEqual(await row(lease.eventId), { ...await row(lease.eventId), delivery_state: 'pending', failures: 0 });
    assert.equal(impatient.totalCount, 0, 'the timed-out session was discarded');
    assert.equal(await head(spaceId, created.ref.id), undefined);
  } finally { await impatient.end(); }
});

test('operator retry pages over failed rows: every dead letter, no backoff row, one audit row', async () => {
  const { scope, ids, spaceId } = await space(2);
  const events = [];
  for (const collectionId of [...ids, ...ids]) {
    const created = await write(scope(collectionId), 'create', '{"v":1}');
    events.push((await pool.query('SELECT event_id FROM projection_outbox WHERE space_id=$1 AND record_id=$2',
      [spaceId, created.ref.id])).rows[0].event_id);
  }
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=8,dead_lettered_at=clock_timestamp(),
    available_at='infinity',last_error='parked' WHERE event_id=ANY($1)`, [events.slice(0, 3)]);
  await pool.query(`UPDATE projection_outbox SET delivery_state='degraded',failures=1,available_at=clock_timestamp()+interval '1 hour',
    last_error='backoff' WHERE event_id=$1`, [events[3]]);
  assert.equal(await outbox.retry('operator@example.invalid', spaceId, null, 'embedder restored'), 3);
  for (const eventId of events.slice(0, 3))
    assert.deepEqual(await row(eventId), { ...await row(eventId), delivery_state: 'pending', failures: 0, dead_lettered_at: null });
  assert.deepEqual(await row(events[3]), { ...await row(events[3]), delivery_state: 'degraded', failures: 1, dead_lettered_at: null });
  const audits = await pool.query("SELECT affected FROM outbox_operator_audit WHERE space_id=$1 AND action='retry'", [spaceId]);
  assert.deepEqual(audits.rows.map(entry => Number(entry.affected)), [3]);
});

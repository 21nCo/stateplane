import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresSpaces, postgresServices, reconcileIndexes, reconciliationBounds } from '../../packages/postgres/dist/index.js';
import { measure, SHAPES } from '../../scripts/analysis-measure.mjs';

// STA-60: the typed index reconciliation against records' canonical data, and the measurement script's report. The
// suite owns its database; the measurement makes and drops its own.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_measurements_${randomUUID().replaceAll('-', '')}`;
const url = Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
};
await admin(`CREATE DATABASE ${name}`);
const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
if (migrated.status !== 0) { await admin(`DROP DATABASE IF EXISTS ${name}`); throw new Error(migrated.stderr); }
const pool = new pg.Pool({ connectionString: url, max: 8 });
test.after(async () => { await pool.end(); await admin(`DROP DATABASE IF EXISTS ${name}`); });

const config = { database: memoryAdapter(), namespace: `measurements-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {
  team: { type: ['string', 'null'] }, score: { type: ['number', 'null'] }, active: { type: ['boolean', 'null'] },
  at: { type: ['string', 'null'], format: 'date-time' }, note: { type: 'string' } } };
const INDEXED = ['team', 'score', 'active', 'at'];

async function fixture() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const token = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  const owner = await identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  await services.collections.define(owner, spaceId, 'items', JSON.stringify({ slug: 'items', version: 1, schema, unique: [],
    filterable: INDEXED, sortable: ['score'] }));
  for (const field of INDEXED) await services.collections.backfill(owner, spaceId, 'items', field);
  const write = async request => (await services.records.mutate(owner, spaceId, 'items',
    JSON.stringify({ idempotencyKey: randomUUID(), ...request }))).ref.id;
  return { owner, spaceId, write };
}
/** Change stored rows as a faulty writer, a partial restore or a manual repair would: no trigger or foreign key runs. */
async function damage(sql, values) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL session_replication_role = 'replica'");
    await db.query(sql, values);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
const reasons = report => report.drift.map(item => [item.recordId, item.field, item.reason, item.expectedKind, item.actualKind]);

test('reconciliation finds a typed index that matches its records\' data clean and reports each kind of drift by record and field', async () => {
  const f = await fixture();
  const ids = [];
  for (let n = 0; n < 12; n++) {
    ids.push(await f.write({ operation: 'create', data: { team: n % 3 ? `t${n}` : null, ...(n % 4 ? { score: n / 10 } : {}),
      active: n % 2 === 0, at: `2026-03-08T0${n % 10}:30:00.120Z`, note: 'x' } }));
  }
  await f.write({ operation: 'replace', id: ids[1], expectedRevision: 1, data: { team: 'moved', score: 1e21 } });
  await f.write({ operation: 'delete', id: ids[2], expectedRevision: 1 });
  const clean = await reconcileIndexes(pool, f.spaceId, 'items');
  assert.deepEqual({ ...clean, drift: undefined }, { spaceId: f.spaceId, collectionId: 'items', fields: ['active', 'at', 'score', 'team'],
    checked: 12, after: null, next: null, driftCount: 0, drift: undefined });
  assert.deepEqual(clean.drift, []);

  // Record order as the database's own (default collation) record ID order.
  const sorted = (await pool.query(`SELECT record_id FROM records WHERE space_id=$1 AND collection_id='items' ORDER BY record_id`,
    [f.spaceId])).rows.map(row => row.record_id);
  // A value changed in place, a kind changed, a row lost, a deleted record's row left behind, and data that no longer derives.
  await damage(`UPDATE record_index_values SET number_value=number_value+0.000000000000000000001
    WHERE space_id=$1 AND collection_id='items' AND record_id=$2 AND field_name='score'`, [f.spaceId, ids[1]]);
  await damage(`UPDATE record_index_values SET value_kind='null',string_value=NULL
    WHERE space_id=$1 AND collection_id='items' AND record_id=$2 AND field_name='team'`, [f.spaceId, ids[4]]);
  await damage(`DELETE FROM record_index_values WHERE space_id=$1 AND collection_id='items' AND record_id=$2 AND field_name='active'`,
    [f.spaceId, ids[5]]);
  await damage(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,boolean_value)
    VALUES($1,'items',$2,'active','boolean',true)`, [f.spaceId, ids[2]]);
  await damage(`UPDATE records SET canonical_data=jsonb_set(canonical_data::jsonb,'{at}','"yesterday"')::text
    WHERE space_id=$1 AND collection_id='items' AND record_id=$2`, [f.spaceId, ids[7]]);
  const drifted = await reconcileIndexes(pool, f.spaceId, 'items');
  const expected = [
    [ids[1], 'score', 'value', 'number', 'number'],
    [ids[4], 'team', 'kind', 'string', 'null'],
    [ids[5], 'active', 'missing', 'boolean', null],
    [ids[2], 'active', 'unexpected', null, 'boolean'],
    [ids[7], 'at', 'underivable', null, null]];
  assert.equal(drifted.driftCount, expected.length);
  const key = item => `${item[0]} ${item[1]}`;
  assert.deepEqual(reasons(drifted).sort((a, b) => (key(a) < key(b) ? -1 : 1)), expected.sort((a, b) => (key(a) < key(b) ? -1 : 1)));
  assert.ok(!JSON.stringify(drifted).includes('moved') && !JSON.stringify(drifted).includes('yesterday'), 'drift states kinds, never values');

  // The operator entrypoint prints the same report and exits 2 on drift; a failed check exits 1 with no report.
  const cli = spawnSync(process.execPath, ['scripts/reconcile-indexes.mjs', '--space', f.spaceId, '--collection', 'items'],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), drifted);
  const failed = spawnSync(process.execPath, ['scripts/reconcile-indexes.mjs', '--space', f.spaceId, '--collection', 'none'],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.deepEqual([failed.status, failed.stdout], [1, '']);
  assert.match(failed.stderr, /No such collection/);

  // Pages: a bounded call returns where to continue, and the continuation finds the rest.
  const first = await reconcileIndexes(pool, f.spaceId, 'items', { maxRecords: 5 });
  assert.deepEqual([first.checked, first.next], [5, sorted[4]]);
  const rest = await reconcileIndexes(pool, f.spaceId, 'items', { after: first.next, maxRecords: 100 });
  assert.deepEqual([rest.checked, rest.after, rest.next], [7, sorted[4], null]);
  assert.equal(first.driftCount + rest.driftCount, expected.length);
  for (const bad of [0, 1.5, reconciliationBounds.maxRecords + 1]) await assert.rejects(reconcileIndexes(pool, f.spaceId, 'items',
    { maxRecords: bad }), RangeError);
  await assert.rejects(reconcileIndexes(pool, f.spaceId, 'none'), RangeError);
});

test('reconciliation reports damaged canonical data as underivable drift per record and field, beside other drift, without failing', async () => {
  const f = await fixture();
  const ids = [];
  for (let n = 0; n < 6; n++) ids.push(await f.write({ operation: 'create', data: { team: `t${n}`, score: n, active: true,
    at: '2026-03-08T01:30:00Z' } }));
  const data = (id, sql) => damage(`UPDATE records SET canonical_data=${sql} WHERE space_id=$1 AND collection_id='items' AND record_id=$2`,
    [f.spaceId, id]);
  // A number field holding an object, a string field holding an array, data that is a JSON array, a JSON string, not JSON.
  await data(ids[0], `jsonb_set(canonical_data::jsonb,'{score}','{"n":1}')::text`);
  await data(ids[1], `jsonb_set(canonical_data::jsonb,'{team}','["t1"]')::text`);
  await data(ids[2], `'[1,2]'`);
  await data(ids[3], `'"text"'`);
  await data(ids[4], `'{"team":'`);
  await damage(`UPDATE record_index_values SET number_value=number_value+1
    WHERE space_id=$1 AND collection_id='items' AND record_id=$2 AND field_name='score'`, [f.spaceId, ids[5]]);
  const report = await reconcileIndexes(pool, f.spaceId, 'items');
  const whole = id => INDEXED.map(field => [id, field, 'underivable', null, null]);
  const expected = [[ids[0], 'score', 'underivable', null, null], [ids[1], 'team', 'underivable', null, null], ...whole(ids[2]),
    ...whole(ids[3]), ...whole(ids[4]), [ids[5], 'score', 'value', 'number', 'number']];
  const key = item => `${item[0]} ${item[1]}`;
  const order = (a, b) => (key(a) < key(b) ? -1 : 1);
  assert.deepEqual([report.checked, report.driftCount], [6, expected.length]);
  assert.deepEqual(reasons(report).sort(order), expected.sort(order));
});

test('reconciliation checks ready fields only: a field still backfilling is not reported as drift', async () => {
  const f = await fixture();
  for (let n = 0; n < 5; n++) await f.write({ operation: 'create', data: { team: `t${n}`, note: `n${n}` } });
  await services.collections.revise(f.owner, f.spaceId, 'items', 1, JSON.stringify({ slug: 'items', version: 2, schema, unique: [],
    filterable: [...INDEXED, 'note'], sortable: ['score'] }));
  // The declaration is pending: no record has a note row yet.
  const pending = await reconcileIndexes(pool, f.spaceId, 'items');
  assert.deepEqual([pending.fields, pending.driftCount], [['active', 'at', 'score', 'team'], 0]);
  while (!(await services.collections.backfill(f.owner, f.spaceId, 'items', 'note')).ready);
  const ready = await reconcileIndexes(pool, f.spaceId, 'items');
  assert.deepEqual([ready.fields, ready.driftCount, ready.checked], [['active', 'at', 'note', 'score', 'team'], 0, 5]);
  const cli = spawnSync(process.execPath, ['scripts/reconcile-indexes.mjs', '--space', f.spaceId, '--collection', 'items'],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).driftCount, 0);
});

test('reconciliation reads each page in one snapshot: a write committing between its reads is never drift', async () => {
  const f = await fixture();
  const ids = [];
  for (let n = 0; n < 3; n++) ids.push(await f.write({ operation: 'create', data: { team: 'a', score: n } }));
  // A pool whose session runs `between` once, right after the page's records are read and before their rows are; with
  // `isolation`, it reads at that level instead of the snapshot reconciliation asks for.
  let between = null, isolation = null;
  const pausing = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(object, property) {
      if (property !== 'query') return typeof object[property] === 'function' ? object[property].bind(object) : object[property];
      return async (sql, values) => {
        if (isolation && typeof sql === 'string' && /^SET TRANSACTION ISOLATION LEVEL/.test(sql))
          sql = `SET TRANSACTION ISOLATION LEVEL ${isolation}, READ ONLY`;
        const result = await object.query(sql, values);
        if (between && typeof sql === 'string' && /tombstone,canonical_data FROM records/.test(sql)) {
          const run = between;
          between = null;
          await run();
        }
        return result;
      };
    } });
  } };
  between = () => f.write({ operation: 'replace', id: ids[0], expectedRevision: 1, data: { team: 'b', score: 99, active: true } });
  const report = await reconcileIndexes(pausing, f.spaceId, 'items');
  assert.equal(between, null, 'the write committed between the page\'s reads');
  assert.deepEqual([report.checked, report.driftCount], [3, 0], JSON.stringify(report.drift));
  // The next reconciliation reads the written record, data and rows together.
  assert.equal((await reconcileIndexes(pool, f.spaceId, 'items')).driftCount, 0);
  assert.equal((await pool.query('SELECT revision FROM records WHERE space_id=$1 AND record_id=$2', [f.spaceId, ids[0]])).rows[0].revision, '2');
  // The same interleaving read at READ COMMITTED sees the old data beside the new rows and reports false drift, so the
  // snapshot is what keeps it out.
  isolation = 'READ COMMITTED';
  between = () => f.write({ operation: 'replace', id: ids[0], expectedRevision: 2, data: { team: 'c', score: 7, active: false } });
  const unsnapshotted = await reconcileIndexes(pausing, f.spaceId, 'items');
  assert.equal(between, null);
  assert.deepEqual(unsnapshotted.drift.map(item => [item.recordId, item.field, item.reason]),
    [[ids[0], 'active', 'value'], [ids[0], 'score', 'value'], [ids[0], 'team', 'value']]);
});

test('the measurement script refuses a server URL outside the TLS policy before connecting', () => {
  // The .invalid host never resolves: a connection attempt fails with ENOTFOUND, not the policy's refusal.
  for (const [target, message] of [['postgres://u:p@db.example.invalid:5432/stateplane', /requires sslmode=verify-full/],
    ['postgres://u:p@db.example.invalid:5432/stateplane?sslmode=require', /requires sslmode=verify-full/],
    ['postgres://u:p@127.0.0.1:1/stateplane?sslmode=require', /Loopback DATABASE_URL only permits sslmode=disable/]]) {
    const run = spawnSync(process.execPath, ['scripts/analysis-measure.mjs', '--scales', '10', '--noise', '0'],
      { cwd: root, env: { ...process.env, DATABASE_URL: target }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, target);
    assert.match(run.stderr, message, target);
    assert.doesNotMatch(run.stderr, /ENOTFOUND|ECONNREFUSED/, target);
  }
});

test('the measurement script reports plans as issued, the candidate index, jobs, reconciliation, mixed load and limits, and drops its database', async () => {
  const before = (await admin("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'stateplane_measure_%'")).rows[0].n;
  const report = await measure({ scales: [400, 900], noise: 300, runs: 1, loadSeconds: 1, writes: 5 });
  assert.equal(report.fixture.name, 'analysis-fixture/v1');
  assert.deepEqual(report.aggregations.map(scale => scale.records), [400, 900]);
  for (const scale of report.aggregations) {
    for (const shape of Object.keys(SHAPES)) {
      for (const measured of [scale.baseline[shape], scale.candidate.shapes[shape]]) {
        assert.ok(measured.groups >= 1 && measured.serviceMs.samples === 1, shape);
        // The plan is the service's own statement, replayed under its settings: no parallel workers.
        assert.ok(measured.explain.settings.includes('SET LOCAL max_parallel_workers_per_gather = 0'), shape);
        assert.ok(measured.explain.executionMs > 0 && measured.explain.plan.node, shape);
      }
      assert.ok(scale.candidate.speedup[shape] > 0);
    }
    assert.ok(scale.candidate.buildMs > 0);
    // Filtered shapes reach their records through the typed value indexes.
    assert.ok(scale.baseline.filteredSelective.explain.indexes.includes('record_index_number'));
  }
  for (const job of report.jobs) {
    assert.equal(job.records, 900, job.kind);
    assert.equal(job.freshness, 'exact');
    assert.ok(job.asOfPagePlan.indexes.includes('record_event_feed_as_of'), `${job.kind} pages read the as-of index`);
  }
  assert.deepEqual([report.reconciliation.records, report.reconciliation.driftCount], [900, 0]);
  const load = report.mixedLoad;
  assert.deepEqual(Object.keys(load.phases), ['alone', 'jobsOnly', 'aggregationsOnly', 'aggregationsBackingOff', 'both',
    'bothBackingOff']);
  assert.deepEqual(Object.entries(load.phases).map(([label, phase]) => [label, phase.retryAfterRefusalMs]), [['alone', null],
    ['jobsOnly', null], ['aggregationsOnly', 5], ['aggregationsBackingOff', 250], ['both', 5], ['bothBackingOff', 250]]);
  for (const [label, phase] of Object.entries(load.phases)) {
    assert.ok(phase.interactiveReadPairMs.samples > 0, label);
    // At most the cell's analytical slots ran at once, however many loops asked.
    assert.ok(phase.aggregations.peakConcurrentStatements <= load.analyticalSlots.cell, JSON.stringify(phase.aggregations));
  }
  assert.equal(load.phases.alone.aggregations.answered + load.phases.alone.aggregations.refused, 0);
  assert.ok(load.phases.aggregationsOnly.aggregations.answered + load.phases.aggregationsOnly.aggregations.refused > 0);
  assert.deepEqual(report.candidateIndex.recordWriteMs.with.map(round => round.samples), [5, 5]);
  assert.ok(report.candidateIndex.bytes.candidate > 0);
  assert.deepEqual(Object.keys(report.limits.interactive), ['count', 'byValue', 'byMonth', 'threeDimensions']);
  assert.ok(report.limits.interactive.byValue.recordsWithinStatementBudget > 0);
  assert.ok(report.limits.jobs.export.recordsWithinRuntimeBudget > 0 && report.limits.jobs.export.recordsWithinByteBudget > 0);
  const after = (await admin("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'stateplane_measure_%'")).rows[0].n;
  assert.equal(after, before, 'the measurement database is dropped');
});

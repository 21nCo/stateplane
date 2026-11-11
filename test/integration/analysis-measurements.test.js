import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fsp from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresAggregations, PostgresAnalysisWorker, PostgresSpaces, postgresServices, reconcileIndexes, reconciliationBounds }
  from '../../packages/postgres/dist/index.js';
import { measure, reportDestination, seed, SHAPES, underLoad, writeReport } from '../../scripts/analysis-measure.mjs';
import { connectionOptions } from '../../scripts/db-connection.mjs';

// STA-60: the typed index reconciliation against records' canonical data, and the measurement script's report. The
// suite owns its database; the measurement makes and drops its own.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_measurements_${randomUUID().replaceAll('-', '')}`;
const url = Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const admin = async sql => {
  const client = new pg.Client(connectionOptions(baseUrl));
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
};
await admin(`CREATE DATABASE ${name}`);
const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
if (migrated.status !== 0) { await admin(`DROP DATABASE IF EXISTS ${name}`); throw new Error(migrated.stderr); }
const pool = new pg.Pool({ ...connectionOptions(url), max: 8 });
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

test('reconciliation expects what the writers accept: a stored value they would reject is underivable, never kind drift or clean', async () => {
  const f = await fixture();
  // A collection with constraints: required fields (one not indexed), non-nullable, bounded, integer, enumerated.
  const strict = { $schema: schema.$schema, type: 'object', additionalProperties: false, required: ['code', 'tag'], properties: {
    count: { type: 'number' }, flag: { type: 'boolean' }, at: { type: 'string', format: 'date-time' },
    code: { type: 'string', maxLength: 3 }, level: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['a', 'b'] },
    tag: { type: 'string' } } };
  const fields = ['at', 'code', 'count', 'flag', 'kind', 'level'];
  await services.collections.define(f.owner, f.spaceId, 'strict', JSON.stringify({ slug: 'strict', version: 1, schema: strict,
    unique: [], filterable: fields, sortable: [] }));
  for (const field of fields) await services.collections.backfill(f.owner, f.spaceId, 'strict', field);
  const ids = [];
  for (let n = 0; n < 13; n++) ids.push((await services.records.mutate(f.owner, f.spaceId, 'strict', JSON.stringify({
    idempotencyKey: randomUUID(), operation: 'create', data: { count: n, flag: true, at: '2026-03-08T01:30:00Z', code: 'abc', level: 1,
      kind: 'a', tag: 't' } }))).ref.id);
  const where = `space_id=$1 AND collection_id='strict' AND record_id=$2`;
  const data = (id, patch) => damage(`UPDATE records SET canonical_data=(canonical_data::jsonb || $3::jsonb)::text WHERE ${where}`,
    [f.spaceId, id, JSON.stringify(patch)]);
  const without = (id, member) => damage(`UPDATE records SET canonical_data=(canonical_data::jsonb - $3::text)::text WHERE ${where}`,
    [f.spaceId, id, member]);
  // The row a faulty writer would have derived from the damaged value, so that only validation tells them apart.
  const row = (id, field, kind, column, value) => damage(`UPDATE record_index_values SET value_kind=$4,string_value=$5::text,
    number_value=$6::numeric,boolean_value=NULL,time_value=NULL WHERE ${where} AND field_name=$3`,
  [f.spaceId, id, field, kind, column === 'string_value' ? value : null, column === 'number_value' ? value : null]);
  await data(ids[0], { count: '7' }); // a number field holding a string, its row untouched
  await data(ids[1], { count: '7' }); // the same with a matching string row
  await row(ids[1], 'count', 'string', 'string_value', '7');
  await data(ids[2], { flag: 1 }); // a boolean field holding a number, with a matching row
  await row(ids[2], 'flag', 'number', 'number_value', 1);
  await data(ids[3], { at: 5 }); // a date-time field holding a number, its row untouched
  await data(ids[4], { code: 'abcdef' }); // past maxLength, with a matching row
  await row(ids[4], 'code', 'string', 'string_value', 'abcdef');
  await data(ids[5], { level: 2.5 }); // not an integer, with a matching row
  await row(ids[5], 'level', 'number', 'number_value', 2.5);
  await data(ids[6], { level: -1 }); // below minimum, with a matching row
  await row(ids[6], 'level', 'number', 'number_value', -1);
  await data(ids[7], { kind: 'c' }); // outside enum, with a matching row
  await row(ids[7], 'kind', 'string', 'string_value', 'c');
  await without(ids[8], 'code'); // a required ready field missing, with a matching missing row
  await row(ids[8], 'code', 'missing');
  await data(ids[9], { count: null }); // null on a non-nullable field, with a matching null row
  await row(ids[9], 'count', 'null');
  await data(ids[10], { extra: 1 }); // an undeclared root property: the record is rejected, so is every ready field
  await without(ids[11], 'tag'); // a required field outside the ready ones missing: the same
  await damage(`UPDATE record_index_values SET number_value=number_value+1 WHERE ${where} AND field_name='count'`, [f.spaceId, ids[12]]);
  const report = await reconcileIndexes(pool, f.spaceId, 'strict');
  const underivable = (id, field) => [id, field, 'underivable', null, null];
  const expected = [underivable(ids[0], 'count'), underivable(ids[1], 'count'), underivable(ids[2], 'flag'), underivable(ids[3], 'at'),
    underivable(ids[4], 'code'), underivable(ids[5], 'level'), underivable(ids[6], 'level'), underivable(ids[7], 'kind'),
    underivable(ids[8], 'code'), underivable(ids[9], 'count'), ...fields.map(field => underivable(ids[10], field)),
    ...fields.map(field => underivable(ids[11], field)), [ids[12], 'count', 'value', 'number', 'number']];
  const key = item => `${item[0]} ${item[1]}`;
  const order = (a, b) => (key(a) < key(b) ? -1 : 1);
  assert.deepEqual([report.fields, report.checked, report.driftCount], [fields, 13, expected.length]);
  assert.deepEqual(reasons(report).sort(order), expected.sort(order));
});

test('reconciliation validates the whole record as the writers do: a whole-record constraint is never split across fields', async () => {
  const f = await fixture();
  const define = async (collectionId, root) => {
    await services.collections.define(f.owner, f.spaceId, collectionId, JSON.stringify({ slug: collectionId, version: 1, schema: {
      $schema: schema.$schema, type: 'object', additionalProperties: false, properties: { score: { type: 'number' } }, ...root },
    unique: [], filterable: ['score'], sortable: [] }));
    await services.collections.backfill(f.owner, f.spaceId, collectionId, 'score');
    return (await services.records.mutate(f.owner, f.spaceId, collectionId, JSON.stringify({ idempotencyKey: randomUUID(),
      operation: 'create', data: { score: 1 } }))).ref.id;
  };
  // A root enum the record satisfies, with a required field: the writers accepted it, so it reconciles clean.
  await define('accepted', { required: ['score'], enum: [{ score: 1 }] });
  const accepted = await reconcileIndexes(pool, f.spaceId, 'accepted');
  assert.deepEqual([accepted.checked, accepted.driftCount, accepted.drift], [1, 0, []]);
  // A root enum the damaged record leaves although its field is valid alone, with the row a faulty writer would derive.
  const id = await define('rejected', { enum: [{}, { score: 1 }] });
  const where = `space_id=$1 AND collection_id='rejected' AND record_id=$2`;
  await damage(`UPDATE records SET canonical_data='{"score":2}' WHERE ${where}`, [f.spaceId, id]);
  await damage(`UPDATE record_index_values SET number_value=2 WHERE ${where} AND field_name='score'`, [f.spaceId, id]);
  const rejected = await reconcileIndexes(pool, f.spaceId, 'rejected');
  assert.deepEqual([rejected.driftCount, reasons(rejected)], [1, [[id, 'score', 'underivable', null, null]]]);
});

test('reconciliation pages are bounded by canonical data bytes as well as records, and continue to the collection\'s end', async () => {
  const f = await fixture();
  const ids = [];
  for (let n = 0; n < 7; n++) ids.push(await f.write({ operation: 'create', data: { team: `t${n}`, note: 'x' } }));
  ids.sort();
  // Canonical data sizes in record order: one nearly filling a page, four of 300 kB, 900 kB, 100 kB (still derivable).
  const sizes = [1_040_000, 300_000, 300_000, 300_000, 300_000, 900_000, 100_000];
  for (const [i, size] of sizes.entries()) {
    await damage(`UPDATE records SET canonical_data=jsonb_set(canonical_data::jsonb,'{note}',to_jsonb(repeat('n',$3::int)))::text
      WHERE space_id=$1 AND collection_id='items' AND record_id=$2`, [f.spaceId, ids[i], size]);
  }
  let pages = [];
  const counting = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(object, property) {
      if (property !== 'query') return typeof object[property] === 'function' ? object[property].bind(object) : object[property];
      return async (sql, values) => {
        const result = await object.query(sql, values);
        if (typeof sql === 'string' && /tombstone,canonical_data,fetched FROM/.test(sql))
          pages.push(result.rows.map(row => Buffer.byteLength(row.canonical_data)));
        return result;
      };
    } });
  } };
  const all = await reconcileIndexes(counting, f.spaceId, 'items');
  assert.deepEqual([all.checked, all.next, all.driftCount], [7, null, 0]);
  // The record that would take a page past 1 MiB starts the next one; a first record is always taken.
  assert.deepEqual(pages.map(page => page.length), [1, 3, 1, 2]);
  for (const page of pages) assert.ok(page.length === 1 || page.reduce((a, b) => a + b) <= reconciliationBounds.pageBytes, `${page}`);
  // A page cut by bytes within a bounded call is not its end either.
  pages = [];
  const bounded = await reconcileIndexes(counting, f.spaceId, 'items', { maxRecords: 5 });
  assert.deepEqual([pages.map(page => page.length), bounded.checked, bounded.next], [[1, 3, 1], 5, ids[4]]);
  const rest = await reconcileIndexes(counting, f.spaceId, 'items', { after: bounded.next });
  assert.deepEqual([rest.checked, rest.next], [2, null]);
});

test('the reconciliation command reads the collection to its end unless bounded, and a bounded clean run exits incomplete', async () => {
  const f = await fixture();
  // Past the 10,000 records one call checks by default.
  await seed(pool, f.spaceId, 'items', 10_050, false);
  const cli = (...args) => {
    const run = spawnSync(process.execPath, ['scripts/reconcile-indexes.mjs', '--space', f.spaceId, '--collection', 'items', ...args],
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    return { status: run.status, stderr: run.stderr, report: run.stdout ? JSON.parse(run.stdout) : null };
  };
  const clean = cli();
  assert.deepEqual([clean.status, clean.report.checked, clean.report.next, clean.report.driftCount], [0, 10_050, null, 0], clean.stderr);
  await damage(`UPDATE record_index_values SET number_value=number_value+1 WHERE space_id=$1 AND collection_id='items'
    AND record_id='rec_00010040' AND field_name='score'`, [f.spaceId]);
  // One call with the default bound stops before the drift; the command does not.
  const prefix = await reconcileIndexes(pool, f.spaceId, 'items');
  assert.deepEqual([prefix.checked, prefix.next, prefix.driftCount], [reconciliationBounds.defaultRecords, 'rec_00009999', 0]);
  const whole = cli();
  assert.deepEqual([whole.status, whole.report.checked, whole.report.after, whole.report.next, whole.report.driftCount,
    whole.report.fields], [2, 10_050, null, null, 1, ['active', 'at', 'score', 'team']], whole.stderr);
  assert.deepEqual(reasons(whole.report), [['rec_00010040', 'score', 'value', 'number', 'number']]);
  // Bounded: a clean prefix exits 3 with where to continue; the continuation finds the drift.
  const bounded = cli('--max-records', '10000');
  assert.deepEqual([bounded.status, bounded.report.checked, bounded.report.next, bounded.report.driftCount], [3, 10_000, 'rec_00009999', 0]);
  const continued = cli('--after', bounded.report.next, '--max-records', '100');
  assert.deepEqual([continued.status, continued.report.checked, continued.report.next, continued.report.driftCount], [2, 50, null, 1]);
  const tail = cli('--after', 'rec_00010040');
  assert.deepEqual([tail.status, tail.report.checked, tail.report.next, tail.report.driftCount], [0, 9, null, 0]);
  // A bound ending exactly at the collection's end is complete; one record short of it is not, and continues to it.
  const exact = cli('--after', 'rec_00010040', '--max-records', '9');
  assert.deepEqual([exact.status, exact.report.checked, exact.report.next], [0, 9, null], exact.stderr);
  const short = cli('--after', 'rec_00010040', '--max-records', '8');
  assert.deepEqual([short.status, short.report.checked, short.report.next], [3, 8, 'rec_00010048'], short.stderr);
  const last = cli('--after', short.report.next, '--max-records', '8');
  assert.deepEqual([last.status, last.report.checked, last.report.next], [0, 1, null], last.stderr);
});

test('a reconciliation call is complete exactly when no record follows its last: a bound or page ending at the end is complete', async () => {
  const f = await fixture();
  await seed(pool, f.spaceId, 'items', reconciliationBounds.pageRecords, false);
  for (const maxRecords of [undefined, reconciliationBounds.pageRecords, reconciliationBounds.pageRecords + 1]) {
    const report = await reconcileIndexes(pool, f.spaceId, 'items', { maxRecords });
    assert.deepEqual([report.checked, report.next, report.driftCount], [reconciliationBounds.pageRecords, null, 0], `${maxRecords}`);
  }
  const short = await reconcileIndexes(pool, f.spaceId, 'items', { maxRecords: reconciliationBounds.pageRecords - 1 });
  assert.deepEqual([short.checked, short.next], [reconciliationBounds.pageRecords - 1, 'rec_00000998']);
  const rest = await reconcileIndexes(pool, f.spaceId, 'items', { after: short.next, maxRecords: 1 });
  assert.deepEqual([rest.checked, rest.next], [1, null]);
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

test('a measurement load failure stops the phase and every loop, is thrown once they settle, and never goes unobserved', async () => {
  const unobserved = [];
  const record = reason => unobserved.push(reason);
  process.on('unhandledRejection', record);
  try {
    for (const failing of [0, 1, 2]) {
      const settled = [];
      const failure = new Error(`load ${failing}`);
      const loop = n => async load => {
        try {
          for (let round = 0; !load.stop; round++) {
            await new Promise(resolve => setTimeout(resolve, 2));
            if (n === failing && round === 3) throw failure;
          }
        } finally { settled.push(n); }
      };
      let bodyStopped = false;
      await assert.rejects(underLoad([loop(0), loop(1), loop(2)], async load => {
        while (!load.stop) await new Promise(resolve => setTimeout(resolve, 2));
        bodyStopped = true;
        return 'never returned';
      }), failure);
      assert.ok(bodyStopped, 'the body saw the stop');
      assert.deepEqual(settled.sort(), [0, 1, 2], 'every loop settled before the failure was thrown');
    }
    // A failure of the body stops the loops the same way.
    const settled = [];
    await assert.rejects(underLoad([async load => { try { while (!load.stop) await new Promise(r => setTimeout(r, 2)); } finally { settled.push(0); } }],
      async () => { throw new Error('body'); }), /body/);
    assert.deepEqual(settled, [0]);
    assert.equal(await underLoad([async () => {}], async () => 'answered'), 'answered');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unobserved, []);
  } finally { process.off('unhandledRejection', record); }
});

test('a load failure during a measurement phase (an aggregation, the jobs Worker step, the monitor) fails the run and still drops its database', async () => {
  const databases = async () => (await admin("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'stateplane_measure_%'")).rows[0].n;
  const before = await databases();
  const unobserved = [];
  const record = reason => unobserved.push(reason);
  process.on('unhandledRejection', record);
  const originals = { aggregate: PostgresAggregations.prototype.aggregateSerialized, step: PostgresAnalysisWorker.prototype.step,
    query: pg.Pool.prototype.query };
  // Phases are the only callers of the pg_stat_activity monitor and of 2 s Worker steps; aggregations fail only once a phase runs.
  let inPhase = false;
  const monitor = sql => typeof sql === 'string' && sql.includes('FROM pg_stat_activity');
  const faults = {
    aggregation: () => {
      pg.Pool.prototype.query = function (sql, ...rest) { if (monitor(sql)) inPhase = true; return originals.query.call(this, sql, ...rest); };
      PostgresAggregations.prototype.aggregateSerialized = function (...args) {
        if (inPhase) return Promise.reject(new Error('injected aggregation failure'));
        return originals.aggregate.apply(this, args);
      };
    },
    step: () => {
      PostgresAnalysisWorker.prototype.step = function (options, ...rest) {
        if (options?.budgetMs === 2_000) return Promise.reject(new Error('injected step failure'));
        return originals.step.call(this, options, ...rest);
      };
    },
    monitor: () => {
      pg.Pool.prototype.query = function (sql, ...rest) {
        if (monitor(sql)) return Promise.reject(new Error('injected monitor failure'));
        return originals.query.call(this, sql, ...rest);
      };
    }
  };
  try {
    for (const [name, inject] of Object.entries(faults)) {
      inPhase = false;
      inject();
      try {
        await assert.rejects(measure({ scales: [60], noise: 0, runs: 1, loadSeconds: 1, writes: 1 }),
          new RegExp(`injected ${name} failure`));
      } finally {
        PostgresAggregations.prototype.aggregateSerialized = originals.aggregate;
        PostgresAnalysisWorker.prototype.step = originals.step;
        pg.Pool.prototype.query = originals.query;
      }
      assert.equal(await databases(), before, `${name}: the run's database is dropped`);
    }
    assert.deepEqual(unobserved, []);
  } finally { process.off('unhandledRejection', record); }
});

test('the measurement script takes its scales in ascending order up to the reconciliation bound, refused before any database', async () => {
  const databases = async () => (await admin("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'stateplane_measure_%'")).rows[0].n;
  const before = await databases();
  // The last scale is the one the jobs, reconciliation, mixed load and limits measure: it must be the largest.
  for (const scales of [[200, 100], [100, 100], []])
    await assert.rejects(measure({ scales, noise: 0, runs: 1, loadSeconds: 1, writes: 1 }), /scales must be strictly ascending/);
  // It is reconciled in one call, so it is at most that call's bound.
  const oversized = reconciliationBounds.maxRecords + 1;
  for (const reconciliationOnly of [false, true])
    await assert.rejects(measure({ scales: [10, oversized], noise: 0, runs: 1, loadSeconds: 1, writes: 1, reconciliationOnly }),
      /the largest scale must be at most 1000000, the reconciliation bound/);
  for (const [scales, refusal] of [['500,100', /scales must be strictly ascending/], [`10,${oversized}`, /reconciliation bound/]]) {
    const run = spawnSync(process.execPath, ['scripts/analysis-measure.mjs', '--scales', scales, '--noise', '0'],
      { cwd: root, env: { ...process.env, DATABASE_URL: baseUrl }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, scales);
    assert.match(run.stderr, refusal, scales);
  }
  assert.equal(await databases(), before, 'refused before creating a database');
});

test('the measurement script writes its report only to a file inside the current directory by real paths, checked before connecting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stateplane-out-')), outside = await mkdtemp(join(tmpdir(), 'stateplane-outside-'));
  try {
    await mkdir(join(dir, 'reports'));
    await symlink(outside, join(dir, 'linked'));
    await symlink(join(outside, 'target.json'), join(dir, 'report-link.json'));
    // The .invalid host never resolves: an accepted destination fails at the connection (ENOTFOUND), a refused one before it.
    const run = (out, cwd = dir) => spawnSync(process.execPath, [join(root, 'scripts/analysis-measure.mjs'), '--scales', '10', '--noise', '0',
      '--out', out], { cwd, env: { ...process.env, DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/stateplane?sslmode=verify-full' },
      encoding: 'utf8' });
    for (const out of ['../outside-report.json', join(outside, 'report.json'), '.', 'reports', 'reports/', 'linked/report.json',
      'report-link.json', 'missing/report.json']) {
      const refused = run(out);
      assert.notEqual(refused.status, 0, out);
      assert.match(refused.stderr, /--out must name a file inside the current directory/, out);
      assert.doesNotMatch(refused.stderr, /ENOTFOUND/, out);
    }
    await assert.rejects(stat(join(outside, 'target.json')), { code: 'ENOENT' });
    // Ordinary descendants are accepted, also from the root directory.
    for (const [out, cwd] of [['report.json', dir], ['reports/report.json', dir], [relative('/', join(dir, 'reports', 'r.json')), '/']]) {
      const accepted = run(out, cwd);
      assert.notEqual(accepted.status, 0, out);
      assert.doesNotMatch(accepted.stderr, /--out must name/, out);
      assert.match(accepted.stderr, /ENOTFOUND/, out);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the measurement script writes its report where it checked it: a parent replaced by a link outside during the run is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stateplane-out-')), outside = await mkdtemp(join(tmpdir(), 'stateplane-outside-'));
  const runs = async () => new Set((await admin("SELECT datname FROM pg_database WHERE datname ~ '^stateplane_measure_[0-9a-f]{32}$'"))
    .rows.map(row => row.datname));
  const cli = () => {
    const child = spawn(process.execPath, [join(root, 'scripts/analysis-measure.mjs'), '--scales', '10', '--noise', '0', '--runs', '1',
      '--load-seconds', '1', '--writes', '1', '--out', 'reports/report.json'], { cwd: dir, env: { ...process.env, DATABASE_URL: baseUrl } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    // 'close': the child's stderr is complete, which 'exit' does not promise.
    return { child, exited: new Promise(resolve => child.on('close', status => resolve({ status, stderr }))) };
  };
  try {
    await mkdir(join(dir, 'reports'));
    await writeFile(join(outside, 'report.json'), 'kept');
    const before = await runs();
    const { exited } = cli();
    let ended = null;
    exited.then(result => { ended = result; });
    // Once the run's database exists the destination was checked: replace its directory by a link to one outside.
    while (!ended && [...await runs()].every(name => before.has(name))) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(ended, null, 'the run was still going when its directory was replaced');
    await rename(join(dir, 'reports'), join(dir, 'moved'));
    await symlink(outside, join(dir, 'reports'));
    const replaced = await exited;
    assert.notEqual(replaced.status, 0);
    assert.match(replaced.stderr, /--out must name a file inside the current directory/);
    assert.equal(await readFile(join(outside, 'report.json'), 'utf8'), 'kept', 'the file outside is neither truncated nor written');
    await assert.rejects(stat(join(dir, 'moved', 'report.json')), { code: 'ENOENT' });
    // With its directory in place the report is written there.
    await rm(join(dir, 'reports'));
    await rename(join(dir, 'moved'), join(dir, 'reports'));
    await writeFile(join(dir, 'reports', 'report.json'), 'x'.repeat(100_000));
    const written = await cli().exited;
    assert.equal(written.status, 0, written.stderr);
    assert.equal(JSON.parse(await readFile(join(dir, 'reports', 'report.json'), 'utf8')).fixture.name, 'analysis-fixture/v1');
    assert.equal(await readFile(join(outside, 'report.json'), 'utf8'), 'kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the report write is bound to the checked directory: a parent replaced by a link outside, before or after it is entered, never leads it outside', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stateplane-out-')), outside = await mkdtemp(join(tmpdir(), 'stateplane-outside-'));
  const cwd = process.cwd(), realOpen = fsp.open, realChdir = process.chdir;
  /** Replace the checked directory by a link to the one outside, keeping it as `moved`. */
  const replace = () => { renameSync(join(dir, 'reports'), join(dir, 'moved')); symlinkSync(outside, join(dir, 'reports')); };
  try {
    await mkdir(join(dir, 'reports'));
    process.chdir(dir);
    const checked = await reportDestination('reports/report.json');
    // Replaced once the directory is entered, as the file is opened: the report is written in the checked directory (now
    // `moved`), and nothing is created outside.
    fsp.open = async (...args) => { replace(); return realOpen(...args); };
    syncBuiltinESMExports();
    await writeReport('reports/report.json', checked, 'report\n');
    fsp.open = realOpen;
    syncBuiltinESMExports();
    assert.equal(await readFile(join(dir, 'moved', 'report.json'), 'utf8'), 'report\n');
    await assert.rejects(stat(join(outside, 'report.json')), { code: 'ENOENT' });
    await rm(join(dir, 'reports'));
    await rename(join(dir, 'moved'), join(dir, 'reports'));
    await rm(join(dir, 'reports', 'report.json'));
    // Replaced after the check, as the directory is entered: the directory entered is outside, and the write is refused.
    process.chdir = function (directory) {
      if (directory === dirname(checked)) replace();
      return realChdir.call(this, directory);
    };
    await assert.rejects(writeReport('reports/report.json', checked, 'report\n'), /--out must name a file inside the current directory/);
    process.chdir = realChdir;
    await assert.rejects(stat(join(outside, 'report.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(dir, 'moved', 'report.json')), { code: 'ENOENT' });
    assert.equal(process.cwd(), await fsp.realpath(dir), 'the working directory is restored');
  } finally {
    fsp.open = realOpen;
    syncBuiltinESMExports();
    process.chdir = realChdir;
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a failed drop of the measurement database never replaces the run\'s own failure, and names the database either way', async () => {
  const original = { query: pg.Client.prototype.query, create: PostgresSpaces.prototype.create };
  pg.Client.prototype.query = function (sql, ...rest) {
    if (typeof sql === 'string' && sql.startsWith('DROP DATABASE')) return Promise.reject(new Error('injected drop failure'));
    return original.query.call(this, sql, ...rest);
  };
  // Each database left behind is registered as soon as its error arrives and dropped at the end, also when an assertion fails.
  const left = [];
  /** Register the database a measurement error names as left behind, and return the error. */
  const leaving = error => {
    const database = error?.cleanup?.database ?? error?.database;
    if (/^stateplane_measure_[0-9a-f]{32}$/.test(database)) left.push(database);
    return error;
  };
  /** 1 when the named database exists, else 0. */
  const exists = async database => (await admin(`SELECT count(*)::int AS n FROM pg_database WHERE datname='${database}'`)).rows[0].n;
  try {
    // The run and the drop both fail: the run's failure is thrown, the drop's attached to it.
    PostgresSpaces.prototype.create = () => Promise.reject(new Error('injected run failure'));
    const both = await measure({ scales: [10], noise: 0, runs: 1, loadSeconds: 1, writes: 1 }).then(() => null, leaving);
    PostgresSpaces.prototype.create = original.create;
    assert.match(both?.message, /injected run failure/);
    assert.match(both.cleanup.database, /^stateplane_measure_[0-9a-f]{32}$/);
    assert.match(both.cleanup.message, new RegExp(`${both.cleanup.database} was not dropped`));
    assert.match(both.cleanup.cause.message, /injected drop failure/);
    // Only the drop fails: its failure is thrown, naming the database.
    const only = await measure({ scales: [10], noise: 0, runs: 1, loadSeconds: 1, writes: 1, reconciliationOnly: true })
      .then(() => null, leaving);
    assert.match(only?.message, /^The measurement database stateplane_measure_[0-9a-f]{32} was not dropped/);
    assert.match(only.cause.message, /injected drop failure/);
    assert.deepEqual(left, [both.cleanup.database, only.database]);
    for (const database of left) assert.equal(await exists(database), 1, 'the named database is the one left behind');
  } finally {
    pg.Client.prototype.query = original.query;
    PostgresSpaces.prototype.create = original.create;
    for (const database of left) await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  for (const database of left) assert.equal(await exists(database), 0);
});

test('mixed load counts the job result pages written in its interval: a step returning after it counts, a page written after it does not', async () => {
  const step = PostgresAnalysisWorker.prototype.step, query = pg.Pool.prototype.query;
  const settings = { scales: [300], noise: 0, runs: 1, loadSeconds: 1, writes: 1 };
  const phaseStep = options => options?.budgetMs === 2_000;
  try {
    // Each phase step returns 1.5 s after it ends, after the 1 s of interactive reads; its page was written well within them.
    PostgresAnalysisWorker.prototype.step = async function (options, ...rest) {
      const result = await step.call(this, options, ...rest);
      if (phaseStep(options)) await new Promise(resolve => setTimeout(resolve, 1_500));
      return result;
    };
    const early = await measure(settings);
    // The phase's export of 300 records is one result page.
    assert.equal(early.mixedLoad.phases.jobsOnly.jobPagesWritten, 1);
    assert.equal(early.mixedLoad.phases.alone.jobPagesWritten, 0);
    // Each phase step starts 1.3 s into the phase, after the reads, and any count of result pages is 900 ms late: the page
    // written after the reads is outside the interval however late the count runs.
    PostgresAnalysisWorker.prototype.step = async function (options, ...rest) {
      if (phaseStep(options)) await new Promise(resolve => setTimeout(resolve, 1_300));
      return step.call(this, options, ...rest);
    };
    pg.Pool.prototype.query = async function (sql, ...rest) {
      if (typeof sql === 'string' && sql.includes('FROM analysis_result_pages')) await new Promise(resolve => setTimeout(resolve, 900));
      return query.call(this, sql, ...rest);
    };
    const late = await measure(settings);
    assert.equal(late.mixedLoad.phases.jobsOnly.jobPagesWritten, 0);
    assert.ok(late.mixedLoad.phases.jobsOnly.pageCutoffLagMs >= 0);
  } finally {
    PostgresAnalysisWorker.prototype.step = step;
    pg.Pool.prototype.query = query;
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
  // Reconciliation only: the fixture at the largest scale, reconciled --runs times, each finding the seed clean.
  const only = await measure({ scales: [400, 700], noise: 100, runs: 2, loadSeconds: 1, writes: 1, reconciliationOnly: true });
  assert.equal(only.kind, 'stateplane.analysis-reconciliation-measurements');
  assert.deepEqual(only.reconciliation.runs.map(run => [run.records, run.driftCount, run.fields.length]), [[700, 0, 4], [700, 0, 4]]);
  assert.equal(only.aggregations, undefined);
  const after = (await admin("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'stateplane_measure_%'")).rows[0].n;
  assert.equal(after, before, 'the measurement databases are dropped');
});

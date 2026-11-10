import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { analysisJobBounds, PostgresAnalysisWorker, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';

// STA-59: snapshot analysis and export jobs. Exports are checked against the
// records as the tests wrote them before the job was submitted, never against
// the tables the worker reads; aggregate jobs against STA-58's interactive
// aggregation (itself checked against an independent oracle) over the same
// unchanged data. The suite owns its database.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_analysis_jobs_${randomUUID().replaceAll('-', '')}`;
const url = Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
};
await admin(`CREATE DATABASE ${name}`);
const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
if (migrated.status !== 0) { await admin(`DROP DATABASE IF EXISTS ${name}`); throw new Error(migrated.stderr); }
const pool = new pg.Pool({ connectionString: url, max: 8 });
const extraPools = [];
const newPool = (max = 1) => { const created = new pg.Pool({ connectionString: url, max }); extraPools.push(created); return created; };
test.after(async () => { await Promise.all([pool, ...extraPools].map(item => item.end())); await admin(`DROP DATABASE IF EXISTS ${name}`); });

const config = { database: memoryAdapter(), namespace: `analysis-jobs-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32),
  analytics: { pool: newPool(1), originConnectionLimit: 5 } }]]), 3600);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const rejects = (promise, code, label = '') => assert.rejects(promise, error => { assert.equal(error.code, code, `${label} ${error.message}`); return true; });

/**
 * A jobs Worker on a one-connection pool of its own, as in the cell's jobs Worker. `fault(sql)` may throw to model
 * a step interrupted at that statement, as a crashed isolate or a lost connection would leave it.
 */
function worker(fault = () => {}) {
  const own = newPool(1);
  own.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (sql, ...rest) => { fault(typeof sql === 'string' ? sql : sql.text); return query(sql, ...rest); };
  });
  return new PostgresAnalysisWorker(own, { originConnectionLimit: 5 });
}
/** Run steps until no job is left to claim, as successive ticks would. */
async function drain(jobs = worker(), budgetMs = 10_000) {
  for (let i = 0; i < 100; i++) if (!(await jobs.step({ budgetMs })).claimed) return;
  throw new Error('jobs did not finish');
}

const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {
  team: { type: ['string', 'null'] }, score: { type: ['number', 'null'] }, active: { type: ['boolean', 'null'] },
  at: { type: ['string', 'null'], format: 'date-time' }, note: { type: 'string' } } };
const INDEXED = ['team', 'score', 'active', 'at'];

async function fixture() {
  // Every space here lives on cell-a, whose one analytical slot (an origin limit of 5) the tests share: a test starts with
  // no job of an earlier one left unfinished or holding it.
  await pool.query(`UPDATE analysis_jobs SET state='failed',failure_code='TEST_RESET' WHERE state IN ('queued','running')`);
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  await services.collections.define(owner, spaceId, 'items', JSON.stringify({ slug: 'items', version: 1, schema, unique: [],
    filterable: INDEXED, sortable: ['score'] }));
  for (const field of INDEXED) await services.collections.backfill(owner, spaceId, 'items', field);
  const write = async request => (await services.records.mutate(owner, spaceId, 'items',
    JSON.stringify({ idempotencyKey: randomUUID(), ...request }))).ref.id;
  /** Create records 20 per batch, four batches at a time; their IDs with their data. */
  const bulk = async items => {
    const ids = new Map(), chunks = [];
    for (let i = 0; i < items.length; i += 20) chunks.push(items.slice(i, i + 20));
    const lanes = Array.from({ length: 4 }, async (_, lane) => {
      for (let c = lane; c < chunks.length; c += 4) {
        const progress = await services.batches.ingest(owner, spaceId, 'items', `bulk-${randomUUID()}`,
          JSON.stringify(chunks[c].map(data => JSON.stringify({ operation: 'create', data }))), false);
        progress.items.forEach((item, j) => { assert.equal(item.state, 'succeeded', JSON.stringify(item)); ids.set(item.receipt.ref.id, chunks[c][j]); });
      }
    });
    await Promise.all(lanes);
    return ids;
  };
  const agent = async capabilities => {
    const key = await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000), [{ collectionId: 'items', capabilities }]);
    return { actor: await verify(key.secret), keyId: key.id };
  };
  return { spaceId, owner, write, bulk, agent };
}

const teams = ['red', 'blue', 'green', null];
/** Generic records: nulls and missing fields, decimals, instants around a DST change, some large notes. */
function generic(count, large = []) {
  return Array.from({ length: count }, (_, i) => {
    const data = { note: large.includes(i) ? 'x'.repeat(400_000) : `n${i}` };
    if (i % 7) data.team = teams[i % 4];
    if (i % 5) data.score = i % 3 ? i / 10 : null;
    if (i % 4) data.active = i % 2 === 0;
    if (i % 6) data.at = new Date(Date.UTC(2026, 2, 7, 12) + i * 1_799_000).toISOString();
    return data;
  });
}
/** Every page of a completed job, read through the services, with the job's manifest. */
async function result(actor, spaceId, jobId, collectionId = 'items') {
  const status = await services.analysis.status(actor, spaceId, collectionId, jobId);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  const pages = [];
  for (let n = 1; n <= status.manifest.pageCount; n++) pages.push(await services.analysis.page(actor, spaceId, collectionId, jobId, n));
  return { status, pages };
}
/** The records an export states, by ID, from its NDJSON pages. */
const exported = pages => new Map(pages.flatMap(page => page.page.content.trimEnd().split('\n').map(line => JSON.parse(line)))
  .map(line => [line.id, line]));
/** End the leases and slot holds of jobs whose isolate was lost, as their lapse would. */
async function lapse(jobIds) {
  await pool.query(`UPDATE analysis_jobs SET leased_until=clock_timestamp() WHERE job_id=ANY($1) AND state='running'`, [jobIds]);
  for (const table of ['analysis_cell_slots', 'analysis_space_slots'])
    await pool.query(`UPDATE ${table} SET held_until=clock_timestamp() WHERE holder_job_id=ANY($1)`, [jobIds]);
}
const slots = async () => (await pool.query(`SELECT 'cell' AS kind,slot,holder_job_id,held_until>clock_timestamp() AS held FROM analysis_cell_slots
  UNION ALL SELECT 'space',slot,holder_job_id,held_until>clock_timestamp() FROM analysis_space_slots ORDER BY 1,2`)).rows;

test('an export states exactly the records as of its watermark, unpublished writes before it included and every later write excluded', async () => {
  const f = await fixture();
  const before = await f.bulk(generic(1_100, [3, 4, 5, 6, 7]));
  // Nothing has read the event feed, so every write so far is unpublished: submission publishes it before it pins.
  const [replaced, deleted] = [...before.keys()];
  await f.write({ operation: 'replace', id: replaced, expectedRevision: 1, data: { note: 'replaced before' } });
  before.set(replaced, { note: 'replaced before' });
  await f.write({ operation: 'delete', id: deleted, expectedRevision: 1 });
  before.delete(deleted);
  const job = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  assert.equal(job.state, 'queued');
  assert.equal(job.complete, false);
  assert.equal(job.manifest, null);
  assert.ok(job.boundary.watermark > 0);
  assert.deepEqual([job.boundary.records, job.boundary.schemaVersion, job.boundary.capability], ['as-of-watermark', 1, 'export:read']);
  // Writes after the watermark, before and while the worker runs: a replace, a delete, a create and a revived record.
  const later = (async () => {
    const ids = [...before.keys()];
    for (let i = 0; i < 40; i++) {
      await f.write({ operation: 'create', data: { note: `later ${i}` } });
      await f.write({ operation: 'patch', id: ids[100 + i], expectedRevision: 1, set: { note: 'patched later' }, unset: [] });
      if (i % 4 === 0) await f.write({ operation: 'delete', id: ids[200 + i], expectedRevision: 1 });
    }
    await f.write({ operation: 'replace', id: replaced, expectedRevision: 2, data: { note: 'replaced later' } });
  })();
  await Promise.all([later, drain(worker(), 2_000)]);
  await drain();
  const { status, pages } = await result(f.owner, f.spaceId, job.jobId);
  const lines = exported(pages);
  assert.equal(lines.size, before.size);
  for (const [id, data] of before) {
    assert.deepEqual(lines.get(id)?.data, data, id);
    assert.equal(lines.get(id).revision, id === replaced ? 2 : 1);
  }
  // Pages are in key order, chained, bounded, and the large records forced byte cuts before the record cap.
  const ids = pages.flatMap(page => page.page.content.trimEnd().split('\n').map(line => JSON.parse(line).id));
  assert.deepEqual(ids, [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  let rows = 0, bytes = 0;
  for (const page of pages) {
    assert.deepEqual([page.page.rowOffset, page.page.byteOffset, page.complete], [rows, bytes, true]);
    assert.ok(page.page.byteSize <= analysisJobBounds.pageBytes && page.page.rowCount <= analysisJobBounds.pageRecords);
    assert.equal(page.page.sha256, createHash('sha256').update(page.page.content).digest('hex'));
    rows += page.page.rowCount; bytes += page.page.byteSize;
  }
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  assert.deepEqual([status.manifest.rowCount, status.manifest.byteSize, status.manifest.format], [rows, bytes, 'application/x-ndjson']);
  assert.equal(status.manifest.resultSha256, createHash('sha256').update(pages.map(page => page.page.sha256).join('')).digest('hex'));
  assert.equal(status.progress.recordsScanned >= before.size, true);
  // The interactive read sees the later writes the job excluded.
  const now = await services.records.get(f.owner, f.spaceId, 'items', replaced);
  assert.equal(JSON.parse(now.canonicalData).note, 'replaced later');
});

test('a job interrupted at any page and resumed writes the same pages and manifest as one run straight through', async () => {
  const f = await fixture();
  await f.bulk(generic(1_200, [10]));
  const straight = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  const resumed = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  const spec = JSON.stringify({ groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'max', field: 'at' }] });
  const aggregate = await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', spec);
  const aggregateResumed = await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', spec);
  assert.equal(straight.boundary.watermark, resumed.boundary.watermark);
  // Run the first of each pair straight through with nothing else queued: park the others' turn by holding their rows.
  const hold = await pool.connect();
  try {
    await hold.query('BEGIN');
    await hold.query('SELECT 1 FROM analysis_jobs WHERE job_id=ANY($1) FOR UPDATE', [[resumed.jobId, aggregateResumed.jobId]]);
    await drain();
  } finally { await hold.query('ROLLBACK'); hold.release(); }
  // The others crash at their first page and manifest writes and checkpoints: the isolate dies, leaving its lease behind.
  let writes = 0, checkpoints = 0, crashes = 0;
  const crash = () => { crashes++; throw new Error('isolate lost'); };
  const crashing = worker(sql => {
    if (/^\s*INSERT INTO analysis_result_(pages|manifests)/.test(sql) && writes++ % 2 === 0 && writes < 8) crash();
    if (/SET cursor_record_id=/.test(sql) && checkpoints++ % 3 === 1 && checkpoints < 9) crash();
    if (/leased_until=clock_timestamp\(\) WHERE/.test(sql)) throw new Error('isolate lost');
  });
  for (let i = 0; i < 60; i++) {
    const done = await Promise.all([resumed, aggregateResumed].map(job => services.analysis.status(f.owner, f.spaceId, 'items', job.jobId)));
    if (done.every(job => job.complete)) break;
    await crashing.step({ budgetMs: 3_000 }).catch(error => { if (error.message !== 'isolate lost') throw error; });
    // The lost lease and slot holds lapse (here at once; they end together), and the next tick reclaims the job from its
    // last committed page.
    await lapse([resumed.jobId, aggregateResumed.jobId]);
  }
  assert.ok(crashes >= 3, `${crashes} crashes`);
  for (const [a, b] of [[straight, resumed], [aggregate, aggregateResumed]]) {
    const one = await result(f.owner, f.spaceId, a.jobId), two = await result(f.owner, f.spaceId, b.jobId);
    assert.ok(two.status.progress.attempts > 1, `${two.status.progress.attempts} attempts`);
    assert.deepEqual(two.status.manifest, one.status.manifest);
    assert.deepEqual(two.pages.map(page => page.page), one.pages.map(page => page.page));
  }
});

test('records created and deleted after the watermark, ahead of an interrupted job\'s checkpoint, change none of its pages', async () => {
  const f = await fixture();
  await f.bulk(generic(2_100));
  const spec = JSON.stringify({ groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'max', field: 'at' }] });
  const straight = [await services.analysis.submit(f.owner, f.spaceId, 'items', 'export'),
    await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', spec)];
  const resumed = [await services.analysis.submit(f.owner, f.spaceId, 'items', 'export'),
    await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', spec)];
  const resumedIds = resumed.map(job => job.jobId);
  const hold = await pool.connect();
  try {
    await hold.query('BEGIN');
    await hold.query('SELECT 1 FROM analysis_jobs WHERE job_id=ANY($1) FOR UPDATE', [resumedIds]);
    await drain();
  } finally { await hold.query('ROLLBACK'); hold.release(); }
  // Each resumed job commits its first page, then its isolate is lost at the second checkpoint.
  for (let i = 0; i < 2; i++) {
    let checkpoints = 0;
    await worker(sql => {
      if (/SET cursor_record_id=/.test(sql) && ++checkpoints === 2) throw new Error('isolate lost');
      if (/leased_until=clock_timestamp\(\) WHERE/.test(sql)) throw new Error('isolate lost');
    }).step({ budgetMs: 3_000 }).catch(error => { if (error.message !== 'isolate lost') throw error; });
    await lapse(resumedIds);
  }
  const saved = (await pool.query('SELECT job_id,cursor_record_id,records_scanned FROM analysis_jobs WHERE job_id=ANY($1)', [resumedIds])).rows;
  assert.deepEqual(saved.map(row => Number(row.records_scanned)), [1_000, 1_000]);
  // Later writes: creates throughout the key range, and deletes and patches of records past both checkpoints.
  await f.bulk(generic(900));
  const cursor = saved.map(row => row.cursor_record_id).sort().at(-1);
  const ahead = (await pool.query(`SELECT record_id FROM records WHERE space_id=$1 AND collection_id='items' AND record_id>$2
    AND revision=1 ORDER BY record_id LIMIT 60`, [f.spaceId, cursor])).rows.map(row => row.record_id);
  for (const [i, id] of ahead.entries()) {
    if (i % 2) await f.write({ operation: 'delete', id, expectedRevision: 1 });
    else await f.write({ operation: 'patch', id, expectedRevision: 1, set: { team: 'later', score: 1e6 }, unset: [] });
  }
  await drain();
  for (const [i, job] of resumed.entries()) {
    const one = await result(f.owner, f.spaceId, straight[i].jobId), two = await result(f.owner, f.spaceId, job.jobId);
    assert.ok(two.status.progress.attempts > 1, `${two.status.progress.attempts} attempts`);
    assert.deepEqual(two.status.manifest, one.status.manifest);
    assert.deepEqual(two.pages.map(page => page.page), one.pages.map(page => page.page));
    assert.equal(two.status.progress.recordsScanned, one.status.progress.recordsScanned);
    assert.equal(one.status.progress.recordsScanned, 2_100);
  }
  const first = await result(f.owner, f.spaceId, resumed[0].jobId);
  assert.deepEqual(first.pages.map(page => page.page.rowCount), [1_000, 1_000, 100]);
});

test('a job over a field named __proto__ states the same groups as the interactive aggregation', async () => {
  const f = await fixture();
  // Computed keys, so the field is an own property of the schema and of each record.
  const odd = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    properties: { ['__proto__']: { type: ['string', 'null'] }, n: { type: 'number' } } };
  await services.collections.define(f.owner, f.spaceId, 'odd', JSON.stringify({ slug: 'odd', version: 1, schema: odd, unique: [],
    filterable: ['__proto__', 'n'], sortable: [] }));
  for (const field of ['__proto__', 'n']) await services.collections.backfill(f.owner, f.spaceId, 'odd', field);
  for (let i = 0; i < 30; i++) {
    const data = { n: i };
    if (i % 5) Object.defineProperty(data, '__proto__', { value: ['a', 'b', null][i % 3], enumerable: true, writable: true, configurable: true });
    await services.records.mutate(f.owner, f.spaceId, 'odd', JSON.stringify({ idempotencyKey: randomUUID(), operation: 'create', data }));
  }
  const specs = [
    { where: [{ field: '__proto__', kind: 'string', operator: 'eq', value: 'a' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'n' }] },
    { groupBy: [{ field: '__proto__' }], metrics: [{ op: 'count' }, { op: 'max', field: '__proto__' }, { op: 'avg', field: 'n' }] }
  ];
  const jobs = [];
  for (const spec of specs) jobs.push(await services.analysis.submit(f.owner, f.spaceId, 'odd', 'aggregate', JSON.stringify(spec)));
  await drain();
  for (const [i, spec] of specs.entries()) {
    const interactive = await services.analysis.aggregate(f.owner, f.spaceId, 'odd', JSON.stringify(spec));
    const job = JSON.parse((await result(f.owner, f.spaceId, jobs[i].jobId, 'odd')).pages[0].page.content);
    assert.deepEqual(job.groups, interactive.groups, `spec ${i}`);
    assert.ok(interactive.groups.length >= (i ? 3 : 1) && interactive.groups.every(group => group.count > 0), JSON.stringify(interactive.groups));
    assert.deepEqual(job.collection.fields.map(field => field.field).sort(), ['__proto__', 'n']);
  }
});

test('a page error every retry would meet fails its job at once, releasing its slots, instead of retrying it until expiry', async () => {
  const f = await fixture();
  // 1,000 groups of sixteen sums: about 960 KB as compact JSON, past 1 MiB as the stored jsonb text the bound measures.
  await f.bulk(Array.from({ length: 1_000 }, (_, i) => ({ team: `t${String(i).padStart(99, '0')}`, score: 1, note: 'n' })));
  const wide = JSON.stringify({ groupBy: [{ field: 'team' }], maxGroups: 1_000,
    metrics: Array.from({ length: 16 }, () => ({ op: 'sum', field: 'score' })) });
  const job = await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', wide);
  const step = await worker().step({ budgetMs: 5_000 });
  assert.equal(step.failed, 1);
  const failed = async jobId => (await pool.query(`SELECT state,failure_code,(SELECT count(*)::int FROM analysis_result_pages p
    WHERE p.job_id=j.job_id) AS pages FROM analysis_jobs j WHERE job_id=$1`, [jobId])).rows[0];
  assert.deepEqual(await failed(job.jobId), { state: 'failed', failure_code: 'RESULT_TOO_LARGE', pages: 0 });
  assert.equal((await slots()).some(slot => slot.holder_job_id === job.jobId && slot.held), false);
  // A database refusal that would recur (here a numeric overflow, injected) fails the job on the page it meets; the step goes on.
  const narrow = JSON.stringify({ metrics: [{ op: 'sum', field: 'score' }] });
  const overflow = await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', narrow);
  const export_ = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  const refusing = worker(sql => {
    if (/^WITH records AS/.test(sql)) throw Object.assign(new Error('numeric field overflow'), { code: '22003' });
  });
  const second = await refusing.step({ budgetMs: 5_000 });
  assert.deepEqual([second.failed, second.completed], [1, 1]);
  assert.deepEqual(await failed(overflow.jobId), { state: 'failed', failure_code: 'UNPROCESSABLE', pages: 0 });
  assert.equal((await services.analysis.status(f.owner, f.spaceId, 'items', export_.jobId)).complete, true);
  assert.equal((await slots()).some(slot => slot.holder_job_id === overflow.jobId && slot.held), false);
});

test('an aggregate job over several pages states the same groups as one interactive aggregation of the same data', async () => {
  const f = await fixture();
  await f.bulk(generic(1_200));
  const specs = [
    { metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'avg', field: 'score' }, { op: 'min', field: 'team' }] },
    { groupBy: [{ field: 'team' }, { field: 'active' }], metrics: [{ op: 'count' }, { op: 'min', field: 'score' }, { op: 'max', field: 'score' },
      { op: 'avg', field: 'score' }, { op: 'max', field: 'at' }, { op: 'min', field: 'at' }] },
    // Hours across New York's spring-forward night (2026-03-08), and a range predicate.
    { where: [{ field: 'score', kind: 'number', operator: 'lt', value: 40 }],
      groupBy: [{ field: 'at', bucket: { unit: 'hour', timeZone: 'America/New_York' } }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }],
      maxGroups: 1_000 },
    { groupBy: [{ field: 'at', bucket: { unit: 'day', timeZone: 'Europe/Berlin' } }, { field: 'team' }], metrics: [{ op: 'max', field: 'team' }], maxGroups: 1_000 }
  ];
  const jobs = [];
  for (const spec of specs) jobs.push(await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', JSON.stringify(spec)));
  await drain();
  for (const [i, spec] of specs.entries()) {
    const interactive = await services.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify(spec));
    const { status, pages } = await result(f.owner, f.spaceId, jobs[i].jobId);
    assert.equal(pages.length, 1);
    assert.equal(status.manifest.format, 'application/json');
    const job = JSON.parse(pages[0].page.content);
    assert.deepEqual(job.groups, interactive.groups, `spec ${i}`);
    assert.deepEqual([job.groupBy, job.metrics], [interactive.groupBy, interactive.metrics]);
    assert.deepEqual([job.snapshot, job.source.records, job.complete], [{ scope: 'watermark', watermark: status.boundary.watermark }, 'as-of-watermark', true]);
    assert.ok(status.progress.recordsScanned > analysisJobBounds.pageRecords, 'merged across pages');
  }
  // An empty collection still has its one group without groupBy.
  const empty = await fixture();
  const none = await services.analysis.submit(empty.owner, empty.spaceId, 'items', 'aggregate', JSON.stringify(specs[0]));
  await drain();
  const { pages } = await result(empty.owner, empty.spaceId, none.jobId);
  assert.deepEqual(JSON.parse(pages[0].page.content).groups,
    (await services.analysis.aggregate(empty.owner, empty.spaceId, 'items', JSON.stringify(specs[0]))).groups);
});

test('an aggregate job reports the as-of state, not the records written after its watermark', async () => {
  const f = await fixture();
  const ids = [...(await f.bulk(generic(300))).keys()];
  const spec = JSON.stringify({ groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] });
  const pinned = await services.analysis.aggregate(f.owner, f.spaceId, 'items', spec);
  const job = await services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', spec);
  for (let i = 0; i < 30; i++) {
    await f.write({ operation: 'create', data: { team: 'red', score: 1000 } });
    await f.write({ operation: 'delete', id: ids[i], expectedRevision: 1 });
  }
  const moved = await services.analysis.aggregate(f.owner, f.spaceId, 'items', spec);
  assert.notDeepEqual(moved.groups, pinned.groups);
  await drain();
  const { pages } = await result(f.owner, f.spaceId, job.jobId);
  assert.deepEqual(JSON.parse(pages[0].page.content).groups, pinned.groups);
});

test('cancellation and expiry end a job, release its cell and space slots and remove its pages', async () => {
  const f = await fixture();
  await f.bulk(generic(1_200));
  const job = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  // An isolate that writes one page and is then lost: the job stays running, its slots held until its lease ends.
  const stall = () => {
    let pages = 0;
    return worker(sql => {
      if (/^\s*INSERT INTO analysis_result_pages/.test(sql) && pages++ >= 1) throw new Error('isolate lost');
      if (/leased_until=clock_timestamp\(\) WHERE/.test(sql)) throw new Error('isolate lost');
    }).step({ budgetMs: 2_000 }).catch(() => {});
  };
  await stall();
  const running = await services.analysis.status(f.owner, f.spaceId, 'items', job.jobId);
  assert.equal(running.state, 'running');
  assert.ok(running.progress.pagesWritten >= 1);
  assert.deepEqual((await slots()).filter(slot => slot.holder_job_id === job.jobId).map(slot => [slot.kind, slot.held]), [['cell', true], ['space', true]]);
  // Pages of an unfinished job are never served as a result.
  await rejects(services.analysis.page(f.owner, f.spaceId, 'items', job.jobId, 1), 'CONFLICT');
  // While it holds the cell's one slot (an origin limit of 5), no other job runs.
  const waiting = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  assert.equal((await worker().step({ budgetMs: 2_000 })).claimed, 0);
  const cancelled = await services.analysis.cancel(f.owner, f.spaceId, 'items', job.jobId);
  assert.deepEqual([cancelled.state, cancelled.complete, cancelled.progress.pagesWritten], ['cancelled', false, 0]);
  assert.ok(cancelled.finishedAt);
  assert.equal((await slots()).some(slot => slot.holder_job_id === job.jobId), false);
  assert.equal(Number((await pool.query('SELECT count(*) FROM analysis_result_pages WHERE job_id=$1', [job.jobId])).rows[0].count), 0);
  // Cancelling again reports it as it is; the freed slot runs the waiting job, whose cancellation after completion changes nothing.
  assert.equal((await services.analysis.cancel(f.owner, f.spaceId, 'items', job.jobId)).state, 'cancelled');
  await drain();
  assert.equal((await services.analysis.cancel(f.owner, f.spaceId, 'items', waiting.jobId)).state, 'completed');

  // Expiry: a job admitted with a short lifetime (its binding copied, so it is admitted like any job) is running, then lapses.
  const admitted = async seconds => {
    const id = `anj_${randomUUID()}`;
    await pool.query(`INSERT INTO analysis_jobs(space_id,collection_id,job_id,kind,principal_id,credential_id,capability,policy_version,
        placement_generation,schema_version,watermark,canonical_spec,spec_digest,budget_records,budget_bytes,budget_runtime_ms,expires_at)
      SELECT space_id,collection_id,$2,kind,principal_id,credential_id,capability,policy_version,placement_generation,schema_version,
        watermark,canonical_spec,spec_digest,budget_records,budget_bytes,budget_runtime_ms,clock_timestamp()+$3::int*interval '1 second'
      FROM analysis_jobs WHERE job_id=$1`, [job.jobId, id, seconds]);
    return id;
  };
  const short = await admitted(2);
  await stall();
  assert.equal((await services.analysis.status(f.owner, f.spaceId, 'items', short)).state, 'running');
  await new Promise(resolve => setTimeout(resolve, 2_100));
  // Past its expiry it reads as expired before any worker ends it, and serves nothing.
  assert.equal((await services.analysis.status(f.owner, f.spaceId, 'items', short)).state, 'expired');
  await rejects(services.analysis.page(f.owner, f.spaceId, 'items', short, 1), 'CONFLICT');
  const swept = await worker().step({ budgetMs: 2_000 });
  assert.equal(swept.expired, 1);
  const row = (await pool.query('SELECT state,lease_id FROM analysis_jobs WHERE job_id=$1', [short])).rows[0];
  assert.deepEqual(row, { state: 'expired', lease_id: null });
  assert.equal((await slots()).some(slot => slot.holder_job_id === short), false);
  assert.equal(Number((await pool.query('SELECT count(*) FROM analysis_result_pages WHERE job_id=$1', [short])).rows[0].count), 0);
  // A completed result expires too: its pages go and it is no longer served.
  const completing = await admitted(4);
  await drain();
  assert.equal((await services.analysis.page(f.owner, f.spaceId, 'items', completing, 1)).complete, true);
  await new Promise(resolve => setTimeout(resolve, 4_100));
  await rejects(services.analysis.page(f.owner, f.spaceId, 'items', completing, 1), 'CONFLICT');
  assert.equal((await worker().step({ budgetMs: 2_000 })).expired, 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM analysis_result_pages WHERE job_id=$1', [completing])).rows[0].count), 0);
});

test('every read reauthorizes: a revoked key or grant cannot read a materialized result, and only the submitting key reads its job', async () => {
  const f = await fixture();
  await f.bulk(generic(50));
  const reader = await f.agent(['export:read']);
  const other = await f.agent(['export:read', 'records:read']);
  const narrow = await f.agent(['records:read']);
  // Exports need export:read; aggregates records:read.
  await rejects(services.analysis.submit(narrow.actor, f.spaceId, 'items', 'export'), 'FORBIDDEN');
  await rejects(services.analysis.submit(reader.actor, f.spaceId, 'items', 'aggregate', JSON.stringify({ metrics: [{ op: 'count' }] })), 'FORBIDDEN');
  const job = await services.analysis.submit(reader.actor, f.spaceId, 'items', 'export');
  await drain();
  const page = await services.analysis.page(reader.actor, f.spaceId, 'items', job.jobId, 1);
  assert.equal(page.complete, true);
  // Another key of the same space, even with export:read, sees no such job, and nor does the owner: a job is its submitter's.
  await rejects(services.analysis.status(other.actor, f.spaceId, 'items', job.jobId), 'NOT_FOUND');
  await rejects(services.analysis.page(other.actor, f.spaceId, 'items', job.jobId, 1), 'NOT_FOUND');
  await rejects(services.analysis.page(f.owner, f.spaceId, 'items', job.jobId, 1), 'NOT_FOUND');
  await spaces.revokeAgentKey(f.owner, f.spaceId, reader.keyId);
  await rejects(services.analysis.page(reader.actor, f.spaceId, 'items', job.jobId, 1), 'NOT_FOUND');
  await rejects(services.analysis.status(reader.actor, f.spaceId, 'items', job.jobId), 'NOT_FOUND');
  // A grant that no longer includes the job's capability refuses its pages too.
  const second = await services.analysis.submit(other.actor, f.spaceId, 'items', 'export');
  await drain();
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['records:read'] WHERE credential_id=$1`, [other.actor.credentialId]);
  await rejects(services.analysis.page(other.actor, f.spaceId, 'items', second.jobId, 1), 'FORBIDDEN');
  // A job whose key is revoked before it runs fails there, with nothing materialized.
  const queued = await services.analysis.submit((await f.agent(['export:read'])).actor, f.spaceId, 'items', 'export');
  await pool.query('UPDATE space_credentials SET revoked_at=clock_timestamp() WHERE credential_id=$1',
    [(await pool.query('SELECT credential_id FROM analysis_jobs WHERE job_id=$1', [queued.jobId])).rows[0].credential_id]);
  const step = await worker().step({ budgetMs: 2_000 });
  assert.equal(step.failed, 1);
  const failed = (await pool.query('SELECT state,failure_code FROM analysis_jobs WHERE job_id=$1', [queued.jobId])).rows[0];
  assert.deepEqual(failed, { state: 'failed', failure_code: 'FORBIDDEN' });
});

test('submission admits only valid jobs and bounds unfinished jobs per space', async () => {
  const f = await fixture();
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'scan'), 'INVALID_ARGUMENT');
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'export', '{}'), 'INVALID_ARGUMENT');
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', '{"metrics":[]}'), 'INVALID_ARGUMENT');
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'aggregate', JSON.stringify({ metrics: [{ op: 'sum', field: 'note' }] })), 'SCHEMA_CONFLICT');
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'missing', 'export'), 'NOT_FOUND');
  await rejects(services.analysis.status(f.owner, f.spaceId, 'items', 'anj_not-a-job'), 'NOT_FOUND');
  await rejects(services.analysis.page(f.owner, f.spaceId, 'items', `anj_${randomUUID()}`, 0), 'INVALID_ARGUMENT');
  const submitted = [];
  for (let i = 0; i < analysisJobBounds.activePerSpace; i++) submitted.push(await services.analysis.submit(f.owner, f.spaceId, 'items', 'export'));
  await assert.rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'export'), error => error.code === 'BACKPRESSURE' && error.retryable === true);
  await services.analysis.cancel(f.owner, f.spaceId, 'items', submitted[0].jobId);
  assert.equal((await services.analysis.submit(f.owner, f.spaceId, 'items', 'export')).state, 'queued');
  // A suspended space neither admits nor runs jobs; the queued ones fail when a worker reaches them.
  await services.spaces.update(f.owner, f.spaceId, 'suspended');
  await rejects(services.analysis.submit(f.owner, f.spaceId, 'items', 'export'), 'SPACE_UNAVAILABLE');
  await worker().step({ budgetMs: 3_000 });
  assert.deepEqual((await pool.query(`SELECT state,failure_code,count(*)::int AS n FROM analysis_jobs WHERE space_id=$1 AND state<>'cancelled'
    GROUP BY 1,2`, [f.spaceId])).rows, [{ state: 'failed', failure_code: 'SPACE_UNAVAILABLE', n: analysisJobBounds.activePerSpace }]);
});

test('mixed load: interactive reads keep answering while the jobs Worker runs a large job on its own connection', async () => {
  const f = await fixture();
  const ids = [...(await f.bulk(generic(1_500))).keys()];
  const job = await services.analysis.submit(f.owner, f.spaceId, 'items', 'export');
  const spec = JSON.stringify({ groupBy: [{ field: 'team' }, { field: 'active' }], metrics: [{ op: 'count' }, { op: 'avg', field: 'score' }] });
  const more = [];
  for (let i = 0; i < 4; i++) more.push(await services.analysis.submit(f.owner, f.spaceId, 'items', i % 2 ? 'export' : 'aggregate', i % 2 ? undefined : spec));
  const latencies = [];
  let running = true;
  const reads = (async () => {
    while (running) {
      const started = performance.now();
      await services.records.get(f.owner, f.spaceId, 'items', ids[latencies.length % ids.length]);
      await services.records.count(f.owner, f.spaceId, 'items', JSON.stringify([{ field: 'team', kind: 'string', operator: 'eq', value: 'red' }]));
      latencies.push(performance.now() - started);
    }
  })();
  try { await drain(worker(), 3_000); } finally { running = false; await reads; }
  const { status } = await result(f.owner, f.spaceId, job.jobId);
  assert.equal(status.manifest.rowCount, 1_500);
  for (const other of more) assert.equal((await services.analysis.status(f.owner, f.spaceId, 'items', other.jobId)).complete, true);
  latencies.sort((a, b) => a - b);
  assert.ok(latencies.length >= 3, `${latencies.length} reads`);
  console.log(`mixed load: ${latencies.length} interactive read pairs, median ${latencies[latencies.length >> 1].toFixed(1)} ms, ` +
    `max ${latencies.at(-1).toFixed(1)} ms, job ${status.progress.runtimeMs} ms over ${status.progress.attempts} claims`);
});

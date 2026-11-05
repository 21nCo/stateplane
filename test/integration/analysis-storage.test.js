import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresAuthority, PostgresSpaces } from '../../packages/postgres/dist/index.js';

// STA-57 storage only: no service admits or runs analysis jobs yet, so job,
// page, manifest and slot fixtures use SQL. One database for these tests and
// one for the upgrade test, both dropped afterwards.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const urlFor = name => Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const [testDatabase, upgradeDatabase] = ['analysis', 'analysis_upgrade'].map(kind => `stateplane_${kind}_${randomUUID().replaceAll('-', '')}`);
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
};
const dropDatabases = () => Promise.all([testDatabase, upgradeDatabase].map(name => admin(`DROP DATABASE IF EXISTS ${name}`)));
const migrate = (name, env = {}) => spawnSync(process.execPath, ['scripts/migrate.mjs'],
  { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8' });
/** Run the migrator without blocking the test's own sessions; resolves with its exit status and output. */
const migrateAsync = (name, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});
const pool = new pg.Pool({ connectionString: urlFor(testDatabase), max: 6 });
test.before(async () => {
  // Both creations settle before the after hook drops them, so neither commits after its cleanup.
  const failed = (await Promise.allSettled([testDatabase, upgradeDatabase].map(name => admin(`CREATE DATABASE ${name}`))))
    .find(creation => creation.status === 'rejected');
  if (failed) throw failed.reason;
  const migrated = migrate(testDatabase);
  assert.equal(migrated.status, 0, migrated.stderr);
});
test.after(async () => { await pool.end(); await dropDatabases(); });

const digest = value => createHash('sha256').update(value).digest('hex');
const refused = (code, constraint) => error => {
  assert.equal(error.code, code, error.message);
  if (constraint) assert.equal(error.constraint, constraint, error.message);
  return true;
};
const check = constraint => refused('23514', constraint);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** Append one event of a record and, unless `publish` is false, publish it to the feed; returns its position. */
async function write(db, spaceId, collectionId, recordId, revision, { operation = revision === 1 ? 'create' : 'patch',
  data = `{"v":${revision}}`, publish = true } = {}) {
  if (revision === 1) {
    await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      VALUES($1,$2,$3,1,1,'generated',$3,$4::text,$4::jsonb)`, [spaceId, collectionId, recordId, data]);
  } else {
    await db.query(`UPDATE records SET revision=$4,canonical_data=$5::text,data=$5::jsonb,tombstone=$6
      WHERE space_id=$1 AND collection_id=$2 AND record_id=$3`, [spaceId, collectionId, recordId, revision, data, operation === 'delete']);
  }
  const eventId = `evt_${randomUUID()}`;
  await db.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
    VALUES($1,$2,$3,$4,$5,$6,'writer',1,$7)`, [eventId, spaceId, collectionId, recordId, revision, operation, data]);
  if (!publish) return eventId;
  return publishEvent(db, eventId);
}
async function publishEvent(db, eventId) {
  const row = (await db.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id)
    SELECT event_id,space_id,collection_id FROM record_event_pending WHERE event_id=$1 RETURNING position`, [eventId])).rows[0];
  await db.query('DELETE FROM record_event_pending WHERE event_id=$1', [eventId]);
  return Number(row.position);
}

/** A space owned by `owner` with collections alpha and beta, one published record event in each; alpha's position is the watermark. */
async function space() {
  const spaceId = `sp_${randomUUID()}`;
  return inTransaction(async db => {
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    const positions = {};
    for (const collectionId of ['alpha', 'beta']) {
      await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
      positions[collectionId] = await write(db, spaceId, collectionId, 'rec_1', 1);
    }
    return { spaceId, watermark: positions.alpha, betaPosition: positions.beta };
  });
}

const spec = '{"kind":"export","fields":["/v"]}';
/** Admit a job; returns its key and binding. */
async function admit(spaceId, watermark, fields = {}, db = pool) {
  const job = { job_id: `anj_${randomUUID()}`, collection_id: 'alpha', kind: 'export', principal_id: 'owner',
    credential_id: 'owner-session', capability: 'records:read', policy_version: 1, placement_generation: 1, schema_version: 1,
    watermark, canonical_spec: spec, spec_digest: digest(spec), budget_records: 1000, budget_bytes: 4096,
    budget_runtime_ms: 60000, expires_in: '1 hour', ...fields };
  const { expires_in: expiresIn, ...columns } = job;
  const names = Object.keys(columns);
  await db.query(`INSERT INTO analysis_jobs(space_id,${names.join(',')},expires_at)
    VALUES($1,${names.map((_, i) => `$${i + 2}`).join(',')},clock_timestamp()+$${names.length + 2}::interval)`,
  [spaceId, ...Object.values(columns), expiresIn]);
  return { spaceId, ...job };
}
const key = job => [job.spaceId, job.collection_id, job.job_id];
const jobWhere = 'space_id=$1 AND collection_id=$2 AND job_id=$3';
const update = (job, set, values = [], db = pool) => db.query(`UPDATE analysis_jobs SET ${set} WHERE ${jobWhere} RETURNING *`,
  [...key(job), ...values]).then(result => result.rows[0]);
const run = (job, db = pool) => update(job, `state='running',lease_id='lease-1',leased_until=clock_timestamp()+interval '1 minute',
  attempts=attempts+1`, [], db);
const binding = job => [job.spaceId, job.collection_id, job.job_id, job.credential_id, job.spec_digest, job.schema_version, job.watermark];
async function page(job, number, content, rowOffset, rowCount, byteOffset, { db = pool, override = {} } = {}) {
  const values = [...binding({ ...job, ...override }), number, rowOffset, rowCount, byteOffset, content,
    override.content_sha256 ?? digest(content)];
  await db.query(`INSERT INTO analysis_result_pages(space_id,collection_id,job_id,credential_id,spec_digest,schema_version,watermark,
    page_number,row_offset,row_count,byte_offset,content,content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, values);
}
async function manifest(job, pages, { db = pool, override = {} } = {}) {
  const totals = { page_count: pages.length, row_count: pages.reduce((n, p) => n + p.rows, 0),
    byte_size: pages.reduce((n, p) => n + Buffer.byteLength(p.content), 0),
    result_sha256: digest(pages.map(p => digest(p.content)).join('')), ...override };
  await db.query(`INSERT INTO analysis_result_manifests(space_id,collection_id,job_id,credential_id,spec_digest,schema_version,watermark,
    page_count,row_count,byte_size,result_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [...binding({ ...job, ...override }), totals.page_count, totals.row_count, totals.byte_size, totals.result_sha256]);
}
const analysisTables = ['analysis_jobs', 'analysis_result_pages', 'analysis_result_manifests', 'analysis_space_slots'];
const counts = async spaceId => Object.fromEntries(await Promise.all([...analysisTables.map(async table =>
  [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId])).rows[0].n]),
(async () => ['analysis_cell_slots', (await pool.query('SELECT count(*)::int AS n FROM analysis_cell_slots WHERE holder_space_id=$1',
  [spaceId])).rows[0].n])()]));

/** A completed export of two pages that holds a space slot and a cell slot until it completes, and a running job that still holds both. */
async function populate(spaceId, watermark, cell) {
  const done = await admit(spaceId, watermark);
  const live = await admit(spaceId, watermark);
  await run(done);
  await run(live);
  const pages = [{ content: '{"rec_1":1}\n', rows: 1 }, { content: '{"rec_2":2}\n', rows: 1 }];
  await page(done, 1, pages[0].content, 0, 1, 0);
  await page(done, 2, pages[1].content, 1, 1, Buffer.byteLength(pages[0].content));
  await manifest(done, pages);
  await page(live, 1, pages[0].content, 0, 1, 0);
  await pool.query(`INSERT INTO analysis_space_slots(space_id,slot,holder_collection_id,holder_job_id,held_until)
    VALUES($1,1,'alpha',$2,clock_timestamp()+interval '1 minute'),($1,2,NULL,NULL,NULL)`, [spaceId, live.job_id]);
  await pool.query(`INSERT INTO analysis_cell_slots(cell_id,slot) VALUES($1,1),($1,2) ON CONFLICT DO NOTHING`, [cell]);
  const free = (await pool.query(`UPDATE analysis_cell_slots SET holder_space_id=$2,holder_collection_id='alpha',holder_job_id=$3,
    held_until=clock_timestamp()+interval '1 minute' WHERE (cell_id,slot) = (SELECT cell_id,slot FROM analysis_cell_slots
    WHERE cell_id=$1 AND holder_job_id IS NULL ORDER BY slot LIMIT 1) RETURNING slot`, [cell, spaceId, live.job_id])).rows[0];
  assert.ok(free, 'a free cell slot');
  await update(done, `state='completed'`);
  return { done, live };
}

test('a job binds its space, collection, credential and grant, spec digest, schema version, placement and watermark', async () => {
  const { spaceId, watermark, betaPosition } = await space();
  const job = await admit(spaceId, watermark);
  const row = (await pool.query(`SELECT * FROM analysis_jobs WHERE ${jobWhere}`, key(job))).rows[0];
  assert.deepEqual({ state: row.state, credential: row.credential_id, digest: row.spec_digest, schema: Number(row.schema_version),
    watermark: Number(row.watermark), policy: Number(row.policy_version), placement: Number(row.placement_generation) },
  { state: 'queued', credential: 'owner-session', digest: digest(spec), schema: 1, watermark, policy: 1, placement: 1 });

  // Stale bindings and a spec its digest does not name.
  await assert.rejects(admit(spaceId, watermark, { policy_version: 2 }), check('analysis_jobs_binding'));
  await assert.rejects(admit(spaceId, watermark, { placement_generation: 2 }), check('analysis_jobs_binding'));
  await pool.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'alpha',2,'{}')`, [spaceId]);
  await pool.query(`UPDATE collections SET schema_version=2 WHERE space_id=$1 AND collection_id='alpha'`, [spaceId]);
  await assert.rejects(admit(spaceId, watermark), check('analysis_jobs_binding'));
  await admit(spaceId, watermark, { schema_version: 2 });
  await assert.rejects(admit(spaceId, watermark, { schema_version: 2, spec_digest: digest('{}') }), check('analysis_jobs_spec_digest'));
  await assert.rejects(admit(spaceId, watermark, { schema_version: 2, canonical_spec: '[]', spec_digest: digest('[]') }),
    check('analysis_jobs_spec'));
  // The watermark is a position of the job's own collection's feed, or 0 only before its first event.
  await assert.rejects(admit(spaceId, betaPosition, { schema_version: 2 }), check('analysis_jobs_watermark'));
  await assert.rejects(admit(spaceId, watermark + 1000000, { schema_version: 2 }), check('analysis_jobs_watermark'));
  await assert.rejects(admit(spaceId, 0, { schema_version: 2 }), check('analysis_jobs_watermark'));
  await inTransaction(async db => {
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,'empty')`, [spaceId]);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'empty',1,'{}')`, [spaceId]);
  });
  await admit(spaceId, 0, { collection_id: 'empty' });

  // The owner, or a credential whose current grant on the collection includes the job's capability.
  const agent = { schema_version: 2, principal_id: 'agent', credential_id: 'agent-key' };
  await assert.rejects(admit(spaceId, watermark, agent), check('analysis_jobs_grant'));
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities,expires_at)
    VALUES($1,'alpha','agent-key',ARRAY['records:read'],clock_timestamp()+interval '1 hour')`, [spaceId]);
  await admit(spaceId, watermark, agent);
  await assert.rejects(admit(spaceId, watermark, { ...agent, capability: 'export:read' }), check('analysis_jobs_grant'));
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1`, [spaceId]);
  await assert.rejects(admit(spaceId, watermark, agent), check('analysis_jobs_grant'));

  // A job starts queued with nothing done, in a live space and collection.
  await assert.rejects(admit(spaceId, watermark, { schema_version: 2, state: 'running' }), check('analysis_jobs_transition'));
  await assert.rejects(admit(spaceId, watermark, { schema_version: 2, records_scanned: 1 }), check('analysis_jobs_transition'));
  await assert.rejects(admit(spaceId, watermark, { schema_version: 2, expires_in: '-1 second' }), check('analysis_jobs_expiry'));
  await pool.query(`UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id='empty'`, [spaceId]);
  await assert.rejects(admit(spaceId, 0, { collection_id: 'empty' }), check('analysis_jobs_admission'));
  for (const lifecycle of ['suspended', 'deleting']) {
    await pool.query('UPDATE spaces SET lifecycle=$2 WHERE space_id=$1', [spaceId, lifecycle]);
    await assert.rejects(admit(spaceId, watermark, { schema_version: 2 }), check('analysis_jobs_admission'));
  }
  await pool.query(`UPDATE spaces SET lifecycle='readOnly' WHERE space_id=$1`, [spaceId]);
  await admit(spaceId, watermark, { schema_version: 2 });

  // The binding, budgets and expiry never change.
  for (const set of [`credential_id='other'`, `spec_digest=repeat('0',64)`, `watermark=0`, `schema_version=2`, `budget_bytes=1`,
    `expires_at=expires_at+interval '1 day'`, `policy_version=2`, `principal_id='agent'`])
    await assert.rejects(update(job, set), check('analysis_jobs_binding'), set);
});

test('result pages and manifests carry their job binding, by foreign key', async () => {
  const { spaceId, watermark } = await space();
  const job = await admit(spaceId, watermark);
  await run(job);
  const binding = refused('23503', 'analysis_result_pages_binding');
  for (const override of [{ credential_id: 'other' }, { spec_digest: digest('{}') }, { schema_version: 2 }, { watermark: 0 }])
    await assert.rejects(page(job, 1, 'a', 0, 1, 0, { override }), binding, JSON.stringify(override));
  await page(job, 1, 'a', 0, 1, 0);
  for (const override of [{ credential_id: 'other' }, { watermark: 0 }])
    await assert.rejects(manifest(job, [{ content: 'a', rows: 1 }], { override }), refused('23503', 'analysis_result_manifests_binding'));
  await manifest(job, [{ content: 'a', rows: 1 }]);
  const stored = (await pool.query(`SELECT p.credential_id,p.spec_digest,p.schema_version::int,p.watermark::int,
      m.credential_id AS m_credential,m.spec_digest AS m_digest,m.schema_version::int AS m_schema,m.watermark::int AS m_watermark
    FROM analysis_result_pages p JOIN analysis_result_manifests m USING (space_id,collection_id,job_id) WHERE p.space_id=$1`, [spaceId])).rows[0];
  assert.deepEqual({ ...stored }, { credential_id: 'owner-session', spec_digest: digest(spec), schema_version: 1, watermark,
    m_credential: 'owner-session', m_digest: digest(spec), m_schema: 1, m_watermark: watermark });
});

test('a job moves forward only, runs under a lease before it expires, and completes only with its manifest', async () => {
  const { spaceId, watermark } = await space();
  const job = await admit(spaceId, watermark);
  // Progress and the lease need a running job.
  await assert.rejects(update(job, 'records_scanned=1'), check('analysis_jobs_transition'));
  await assert.rejects(update(job, `state='running'`), check('analysis_jobs_lease'));
  await assert.rejects(update(job, `state='completed'`), check('analysis_jobs_transition'));
  const running = await run(job);
  assert.ok(running.started_at && Number(running.attempts) === 1);
  // Progress only grows and stays within budget; the checkpoint is an object.
  await update(job, `records_scanned=10,runtime_ms=5,cursor_record_id='rec_10',checkpoint='{"sum":3}'`);
  await assert.rejects(update(job, 'records_scanned=9'), check('analysis_jobs_transition'));
  await assert.rejects(update(job, 'records_scanned=1001'), check('analysis_jobs_budget'));
  await assert.rejects(update(job, 'runtime_ms=60001'), check('analysis_jobs_budget'));
  await assert.rejects(update(job, `checkpoint='[]'`), check('analysis_jobs_checkpoint'));
  await assert.rejects(update(job, `leased_until=expires_at+interval '1 second'`), check('analysis_jobs_expiry'));
  // A reclaim after an interruption takes a new lease and counts an attempt.
  assert.equal((await update(job, `lease_id='lease-2',attempts=attempts+1`)).attempts, 2);
  await assert.rejects(update(job, `state='completed'`), check('analysis_jobs_manifest'));
  // A worker whose lease has lapsed writes nothing.
  await update(job, `leased_until=clock_timestamp()-interval '1 second'`);
  await assert.rejects(manifest(job, []), check('analysis_result_manifests_job'));
  await assert.rejects(page(job, 1, 'a', 0, 1, 0), check('analysis_result_pages_job'));
  await update(job, `leased_until=clock_timestamp()+interval '1 minute'`);
  await manifest(job, []);
  const completed = await update(job, `state='completed',records_scanned=12`);
  assert.deepEqual({ lease: completed.lease_id, until: completed.leased_until, scanned: Number(completed.records_scanned) },
    { lease: null, until: null, scanned: 12 });
  assert.ok(completed.finished_at);
  // An ended job is frozen, except that a completed result expires once its expiry passes.
  for (const set of [`state='running',lease_id='x',leased_until=clock_timestamp()`, `state='failed',failure_code='LATE'`,
    `cursor_record_id='rec_11'`, `attempts=attempts+1`])
    await assert.rejects(update(job, set), check('analysis_jobs_transition'), set);
  await assert.rejects(update(job, `state='expired'`), check('analysis_jobs_expiry'));

  // A queued job can be cancelled directly; a running one through cancelling, which keeps its stamp.
  const queued = await admit(spaceId, watermark);
  const cancelled = await update(queued, `state='cancelled'`);
  assert.ok(cancelled.cancel_requested_at && cancelled.finished_at);
  const cancelling = await admit(spaceId, watermark);
  await run(cancelling);
  const requested = (await update(cancelling, `state='cancelling'`)).cancel_requested_at;
  await assert.rejects(update(cancelling, 'records_scanned=1'), check('analysis_jobs_transition'));
  await assert.rejects(update(cancelling, `state='running'`), check('analysis_jobs_transition'));
  const ended = await update(cancelling, `state='cancelled'`);
  assert.deepEqual([ended.cancel_requested_at, ended.lease_id], [requested, null]);
  // A failure names its code, and only a failure does.
  const failing = await admit(spaceId, watermark);
  await run(failing);
  await assert.rejects(update(failing, `state='failed'`), check('analysis_jobs_failure'));
  await assert.rejects(update(failing, `failure_code='BUDGET_EXCEEDED'`), check('analysis_jobs_failure'));
  assert.equal((await update(failing, `state='failed',failure_code='BUDGET_EXCEEDED'`)).state, 'failed');

  // Past its expiry a job neither runs nor completes; it expires, and a completed result expires too.
  const brief = await admit(spaceId, watermark, { expires_in: '400 milliseconds' });
  const briefDone = await admit(spaceId, watermark, { expires_in: '400 milliseconds' });
  await assert.rejects(update(brief, `state='expired'`), check('analysis_jobs_expiry'));
  await pool.query(`UPDATE analysis_jobs SET state='running',lease_id='l',leased_until=expires_at,attempts=1 WHERE ${jobWhere}`, key(briefDone));
  await manifest(briefDone, []);
  await update(briefDone, `state='completed'`);
  await sleep(450);
  await assert.rejects(run(brief), check('analysis_jobs_expiry'));
  assert.equal((await update(brief, `state='expired'`)).state, 'expired');
  const expired = await update(briefDone, `state='expired'`);
  assert.equal(expired.state, 'expired');
  assert.ok(expired.finished_at < expired.expires_at, 'the completion time is kept');
});

test('result pages follow each other within the byte budget, digests are checked, and a manifest seals and states them', async () => {
  const { spaceId, watermark } = await space();
  const job = await admit(spaceId, watermark, { budget_bytes: 10 });
  await assert.rejects(page(job, 1, 'abc', 0, 1, 0), check('analysis_result_pages_job'));
  await run(job);
  await assert.rejects(page(job, 2, 'abc', 0, 1, 0), check('analysis_result_pages_order'));
  await assert.rejects(page(job, 1, 'abc', 1, 1, 0), check('analysis_result_pages_order'));
  await assert.rejects(page(job, 1, 'abc', 0, 1, 0, { override: { content_sha256: digest('abd') } }), check('analysis_result_pages_digest'));
  await assert.rejects(page(job, 1, 'x'.repeat(11), 0, 1, 0), check('analysis_result_pages_budget'));
  // A page holds a row and a byte, so empty pages cannot pile up outside the byte budget.
  await assert.rejects(page(job, 1, '', 0, 0, 0), check('analysis_result_pages_nonempty'));
  await assert.rejects(page(job, 1, '', 0, 1, 0), check('analysis_result_pages_nonempty'));
  await assert.rejects(page(job, 1, 'abc', 0, 0, 0), check('analysis_result_pages_nonempty'));
  // A result has at most 10,000 pages whatever its byte budget (checked here without the order trigger).
  await assert.rejects(inTransaction(async db => {
    await db.query("SET LOCAL session_replication_role = replica");
    await page(job, 10000, 'a', 0, 1, 0, { db });
    await page(job, 10001, 'a', 1, 1, 1, { db });
  }), check('analysis_result_pages_count'));
  await page(job, 1, 'abc', 0, 2, 0);
  await assert.rejects(page(job, 1, 'abc', 0, 2, 0), refused('23505'));
  await assert.rejects(page(job, 2, 'défg', 2, 1, 4), check('analysis_result_pages_order'));
  await assert.rejects(page(job, 2, 'défghij', 2, 1, 3), check('analysis_result_pages_budget'));
  await page(job, 2, 'défg', 2, 1, 3);
  assert.deepEqual((await pool.query(`SELECT page_number,byte_size FROM analysis_result_pages WHERE space_id=$1 ORDER BY page_number`,
    [spaceId])).rows.map(row => [row.page_number, row.byte_size]), [[1, 3], [2, 5]]);
  await assert.rejects(pool.query(`UPDATE analysis_result_pages SET row_count=9 WHERE space_id=$1`, [spaceId]),
    check('analysis_result_pages_immutable'));
  const pages = [{ content: 'abc', rows: 2 }, { content: 'défg', rows: 1 }];
  for (const override of [{ page_count: 1 }, { row_count: 2 }, { byte_size: 7 }, { result_sha256: digest('abc') }])
    await assert.rejects(manifest(job, pages, { override }), check('analysis_result_manifests_totals'), JSON.stringify(override));
  await manifest(job, pages);
  await assert.rejects(page(job, 3, 'h', 3, 1, 8), check('analysis_result_pages_sealed'));
  await assert.rejects(pool.query(`UPDATE analysis_result_manifests SET row_count=9 WHERE space_id=$1`, [spaceId]),
    check('analysis_result_manifests_immutable'));
  // Results are kept while the job runs or its completed result lives; once it is cancelled, failed or expired they can be removed.
  await assert.rejects(pool.query('DELETE FROM analysis_result_pages WHERE space_id=$1', [spaceId]), check('analysis_result_pages_kept'));
  await update(job, `state='completed'`);
  await assert.rejects(pool.query('DELETE FROM analysis_result_manifests WHERE space_id=$1', [spaceId]), check('analysis_result_manifests_kept'));
  await assert.rejects(pool.query('TRUNCATE analysis_result_pages'), check('analysis_result_pages_immutable'));
  await assert.rejects(pool.query('DELETE FROM analysis_jobs WHERE space_id=$1', [spaceId]), check('analysis_jobs_immutable'));
  const failed = await admit(spaceId, watermark);
  await run(failed);
  await page(failed, 1, 'abc', 0, 1, 0);
  await assert.rejects(pool.query(`DELETE FROM analysis_result_pages WHERE job_id=$1`, [failed.job_id]), check('analysis_result_pages_kept'));
  await update(failed, `state='failed',failure_code='CANCELLED_BY_BUDGET'`);
  assert.equal((await pool.query(`DELETE FROM analysis_result_pages WHERE job_id=$1`, [failed.job_id])).rowCount, 1);
});

test('a spec is at most 64 KiB, and a checkpoint and a page at most 1 MiB', async () => {
  const { spaceId, watermark } = await space();
  const specOf = length => `{"a":"${'x'.repeat(length - 8)}"}`;
  for (const [length, admitted] of [[65536, true], [65537, false]]) {
    const admission = admit(spaceId, watermark, { canonical_spec: specOf(length), spec_digest: digest(specOf(length)) });
    if (admitted) await admission;
    else await assert.rejects(admission, check('analysis_jobs_spec'));
  }
  const job = await admit(spaceId, watermark, { budget_bytes: 4 * 1048576 });
  await run(job);
  // jsonb renders {"a": "…"}: nine bytes around the value.
  const checkpoint = length => JSON.stringify({ a: 'x'.repeat(length - 9) });
  await assert.rejects(update(job, 'checkpoint=$4::jsonb', [checkpoint(1048577)]), check('analysis_jobs_checkpoint'));
  await update(job, 'checkpoint=$4::jsonb', [checkpoint(1048576)]);
  await assert.rejects(page(job, 1, 'x'.repeat(1048577), 0, 1, 0), check('analysis_result_pages_content_check'));
  await page(job, 1, 'x'.repeat(1048576), 0, 1, 0);
  assert.equal((await pool.query(`SELECT byte_size FROM analysis_result_pages WHERE ${jobWhere}`, key(job))).rows[0].byte_size, 1048576);
});

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  test(`under ${isolation}, cancelling a job waits for a page write in flight, and a later page is refused`, async () => {
    const { spaceId, watermark } = await space();
    const job = await admit(spaceId, watermark);
    await run(job);
    const [writer, canceller] = [await pool.connect(), await pool.connect()];
    try {
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await page(job, 1, 'abc', 0, 1, 0, { db: writer });
      await canceller.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const pid = (await canceller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const cancelling = update(job, `state='cancelling'`, [], canceller).catch(error => error);
      await waitsOnLock(pid);
      await writer.query('COMMIT');
      if (isolation === 'REPEATABLE READ') {
        // The page committed after the canceller's snapshot: it retries.
        assert.equal((await cancelling).code, '40001');
        await canceller.query('ROLLBACK');
        await canceller.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        assert.equal((await update(job, `state='cancelling'`, [], canceller)).state, 'cancelling');
      } else assert.equal((await cancelling).state, 'cancelling');
      await canceller.query('COMMIT');
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await assert.rejects(page(job, 2, 'def', 1, 1, 3, { db: writer }), check('analysis_result_pages_job'));
      await writer.query('ROLLBACK');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM analysis_result_pages WHERE space_id=$1', [spaceId])).rows[0].n, 1);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      await canceller.query('ROLLBACK').catch(() => {});
      writer.release();
      canceller.release();
    }
  });
}

/**
 * Run `first` in one transaction and `second` in another while the first is in flight, or, if `stale`, once the first
 * committed after the second's snapshot. Commits both and returns the second's error, if any.
 */
async function race(isolation, first, second, stale = false) {
  const [a, b] = [await pool.connect(), await pool.connect()];
  try {
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    if (stale) await b.query('SELECT 1');
    await a.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await first(a);
    if (stale) await a.query('COMMIT');
    const pending = second(b).then(() => null, error => error);
    if (!stale) {
      await waitsOnLock(pid);
      await a.query('COMMIT');
    }
    const error = await pending;
    await b.query(error ? 'ROLLBACK' : 'COMMIT');
    return error;
  } finally {
    for (const client of [a, b]) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
}

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  test(`under ${isolation}, a manifest and a page write of one job take turns, so the manifest states exactly the committed pages`, async () => {
    const { spaceId, watermark } = await space();
    const repeatable = isolation === 'REPEATABLE READ';
    const stored = async job => (await pool.query(`SELECT (SELECT count(*)::int FROM analysis_result_pages WHERE ${jobWhere}) AS pages,
      (SELECT page_count FROM analysis_result_manifests WHERE ${jobWhere}) AS stated`, key(job))).rows[0];
    for (const stale of repeatable ? [false, true] : [false]) {
      // A page first: a manifest of no pages no longer matches them.
      const pageFirst = await admit(spaceId, watermark);
      await run(pageFirst);
      const sealing = await race(isolation, db => page(pageFirst, 1, 'abc', 0, 1, 0, { db }), db => manifest(pageFirst, [], { db }), stale);
      assert.ok(sealing, 'the manifest is refused');
      if (repeatable) assert.equal(sealing.code, '40001', sealing.message);
      else check('analysis_result_manifests_totals')(sealing);
      assert.deepEqual(await stored(pageFirst), { pages: 1, stated: null });
      await assert.rejects(update(pageFirst, `state='completed'`), check('analysis_jobs_manifest'));
      await manifest(pageFirst, [{ content: 'abc', rows: 1 }]);
      assert.equal((await update(pageFirst, `state='completed'`)).state, 'completed');

      // The manifest first: a later page is refused.
      const manifestFirst = await admit(spaceId, watermark);
      await run(manifestFirst);
      await page(manifestFirst, 1, 'abc', 0, 1, 0);
      const writing = await race(isolation, db => manifest(manifestFirst, [{ content: 'abc', rows: 1 }], { db }),
        db => page(manifestFirst, 2, 'def', 1, 1, 3, { db }), stale);
      assert.ok(writing, 'the page is refused');
      if (repeatable) assert.equal(writing.code, '40001', writing.message);
      else check('analysis_result_pages_sealed')(writing);
      assert.deepEqual(await stored(manifestFirst), { pages: 1, stated: 1 });
      assert.equal((await update(manifestFirst, `state='completed'`)).state, 'completed');
    }
  });
}

async function waitsOnLock(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await sleep(25);
  }
  assert.fail(`backend ${pid} never waited on a lock`);
}

test('a slot is held by one live job of its space or cell, at most one of each kind, and released when the job ends', async () => {
  const { spaceId, watermark } = await space();
  const other = await space();
  const cell = `cell-${randomUUID()}`;
  await pool.query(`UPDATE spaces SET cell_id=$2 WHERE space_id=$1`, [spaceId, cell]);
  const job = await admit(spaceId, watermark);
  const foreign = await admit(other.spaceId, other.watermark);
  await assert.rejects(pool.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,11)', [spaceId]), check());
  await assert.rejects(pool.query('INSERT INTO analysis_cell_slots(cell_id,slot) VALUES($1,0)', [cell]), check());
  await pool.query('INSERT INTO analysis_space_slots(space_id,slot) SELECT $1,generate_series(1,2)', [spaceId]);
  await pool.query('INSERT INTO analysis_cell_slots(cell_id,slot) SELECT $1,generate_series(1,2)', [cell]);
  const take = (table, slot, holder, until = `clock_timestamp()+interval '1 minute'`) => table === 'space'
    ? pool.query(`UPDATE analysis_space_slots SET holder_collection_id='alpha',holder_job_id=$3,held_until=${until}
      WHERE space_id=$1 AND slot=$2`, [spaceId, slot, holder.job_id])
    : pool.query(`UPDATE analysis_cell_slots SET holder_space_id=$3,holder_collection_id='alpha',holder_job_id=$4,held_until=${until}
      WHERE cell_id=$1 AND slot=$2`, [cell, slot, holder.spaceId, holder.job_id]);
  // Another space's job cannot hold this space's slot (no such job here) or this cell's slot (its space is elsewhere).
  await assert.rejects(take('space', 1, foreign), check('analysis_space_slots_holder'));
  await assert.rejects(take('cell', 1, foreign), check('analysis_cell_slots_holder'));
  await assert.rejects(take('space', 1, job, `clock_timestamp()+interval '2 hours'`), check('analysis_space_slots_holder'));
  await take('space', 1, job);
  await take('cell', 1, job);
  await assert.rejects(take('space', 2, job), refused('23505'));
  await assert.rejects(take('cell', 2, job), refused('23505'));
  await assert.rejects(pool.query('UPDATE analysis_space_slots SET slot=3 WHERE space_id=$1 AND slot=1', [spaceId]), check('analysis_space_slots_key'));
  await assert.rejects(pool.query(`UPDATE analysis_space_slots SET held_until=NULL WHERE space_id=$1 AND slot=1`, [spaceId]), check());
  // A held slot passes to another job only once its hold has lapsed.
  const next = await admit(spaceId, watermark);
  await assert.rejects(take('space', 1, next), check('analysis_space_slots_held'));
  await assert.rejects(take('cell', 1, next), check('analysis_cell_slots_held'));
  await pool.query(`UPDATE analysis_space_slots SET held_until=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND slot=1`, [spaceId]);
  await take('space', 1, next);
  await pool.query(`UPDATE analysis_space_slots SET holder_job_id=NULL,holder_collection_id=NULL,held_until=NULL WHERE space_id=$1 AND slot=1`,
    [spaceId]);
  await take('space', 1, job);
  await run(job);
  await update(job, `state='failed',failure_code='WORKER_LOST'`);
  const held = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM analysis_space_slots WHERE space_id=$1 AND holder_job_id IS NOT NULL)
    + (SELECT count(*)::int FROM analysis_cell_slots WHERE cell_id=$2 AND holder_job_id IS NOT NULL) AS n`, [spaceId, cell])).rows[0].n;
  assert.equal(await held(), 0, 'ending the job released both slots');
  await assert.rejects(take('space', 1, job), check('analysis_space_slots_holder'));
});

/**
 * Run `first` in one session and then `second` in another, while the first is in flight (until the second waits on a
 * lock or settles), or, if `stale`, once the first committed after the second's snapshot. Commits each that succeeds
 * and returns the second's result or error.
 */
async function clash({ first, second, isolation, firstIsolation = isolation, stale = false }) {
  const [a, b] = [await pool.connect(), await pool.connect()];
  try {
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    if (stale) await b.query('SELECT 1');
    await a.query(`BEGIN ISOLATION LEVEL ${firstIsolation}`);
    await first(a);
    if (stale) await a.query('COMMIT');
    let settled = false;
    const pending = second(b).then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    if (!stale) {
      for (let attempt = 0; !settled; attempt += 1) {
        const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        if (row?.wait_event_type === 'Lock') break;
        assert.ok(attempt < 200, `backend ${pid} neither waited nor settled`);
        await sleep(25);
      }
      await a.query('COMMIT');
    }
    const outcome = await pending;
    await b.query(outcome.error ? 'ROLLBACK' : 'COMMIT');
    return outcome;
  } finally {
    for (const client of [a, b]) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
}

/** A space on its own cell with free space and cell slot 1, and a queued job; `takes` take a slot for it. */
async function slotted() {
  const { spaceId, watermark } = await space();
  const cell = `cell-${randomUUID()}`;
  await pool.query('UPDATE spaces SET cell_id=$2 WHERE space_id=$1', [spaceId, cell]);
  await pool.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1)', [spaceId]);
  await pool.query('INSERT INTO analysis_cell_slots(cell_id,slot) VALUES($1,1)', [cell]);
  const job = await admit(spaceId, watermark);
  const until = `clock_timestamp()+interval '1 minute'`;
  const takes = {
    'space INSERT': db => db.query(`INSERT INTO analysis_space_slots(space_id,slot,holder_collection_id,holder_job_id,held_until)
      VALUES($1,2,'alpha',$2,${until})`, [spaceId, job.job_id]),
    'space UPDATE': db => db.query(`UPDATE analysis_space_slots SET holder_collection_id='alpha',holder_job_id=$2,held_until=${until}
      WHERE space_id=$1 AND slot=1`, [spaceId, job.job_id]),
    'cell INSERT': db => db.query(`INSERT INTO analysis_cell_slots(cell_id,slot,holder_space_id,holder_collection_id,holder_job_id,held_until)
      VALUES($1,2,$2,'alpha',$3,${until})`, [cell, spaceId, job.job_id]),
    'cell UPDATE': db => db.query(`UPDATE analysis_cell_slots SET holder_space_id=$2,holder_collection_id='alpha',holder_job_id=$3,
      held_until=${until} WHERE cell_id=$1 AND slot=1`, [cell, spaceId, job.job_id]),
    'space upsert': db => db.query(`INSERT INTO analysis_space_slots(space_id,slot,holder_collection_id,holder_job_id,held_until)
      VALUES($1,1,'alpha',$2,${until}) ON CONFLICT (space_id,slot) DO UPDATE SET holder_collection_id=EXCLUDED.holder_collection_id,
      holder_job_id=EXCLUDED.holder_job_id,held_until=EXCLUDED.held_until`, [spaceId, job.job_id]),
    'cell upsert': db => db.query(`INSERT INTO analysis_cell_slots(cell_id,slot,holder_space_id,holder_collection_id,holder_job_id,held_until)
      VALUES($1,1,$2,'alpha',$3,${until}) ON CONFLICT (cell_id,slot) DO UPDATE SET holder_space_id=EXCLUDED.holder_space_id,
      holder_collection_id=EXCLUDED.holder_collection_id,holder_job_id=EXCLUDED.holder_job_id,held_until=EXCLUDED.held_until`,
    [cell, spaceId, job.job_id])
  };
  const extend = table => db => db.query(`UPDATE analysis_${table}_slots SET held_until=clock_timestamp()+interval '2 minutes'
    WHERE holder_job_id=$1`, [job.job_id]);
  const held = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM analysis_space_slots WHERE space_id=$1 AND holder_job_id IS NOT NULL)
    + (SELECT count(*)::int FROM analysis_cell_slots WHERE holder_space_id=$1) AS n`, [spaceId])).rows[0].n;
  const slots = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM analysis_space_slots WHERE space_id=$1)
    + (SELECT count(*)::int FROM analysis_cell_slots WHERE holder_space_id=$1) AS n`, [spaceId])).rows[0].n;
  return { spaceId, cell, job, takes, extend, held, slots };
}
const ends = { space: `state='cancelled'`, cell: `state='failed',failure_code='WORKER_LOST'` };
const noDeadlock = outcome => assert.notEqual(outcome.error?.code, '40P01', outcome.error?.message);

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  const repeatable = isolation === 'REPEATABLE READ';
  for (const taking of ['space INSERT', 'space UPDATE', 'cell INSERT', 'cell UPDATE']) {
    const table = taking.split(' ')[0];
    test(`under ${isolation}, a ${taking} slot taking and its job's ending take turns, and the ended job holds no slot`, async () => {
      for (const stale of repeatable ? [false, true] : [false]) {
        // The taking first: the ending waits and releases the slot, or retries after 40001.
        const takeFirst = await slotted();
        const ending = await clash({ isolation, stale, first: takeFirst.takes[taking],
          second: db => update(takeFirst.job, ends[table], [], db) });
        noDeadlock(ending);
        if (repeatable) {
          assert.equal(ending.error?.code, '40001', ending.error?.message);
          await update(takeFirst.job, ends[table]);
        } else assert.equal(ending.error, undefined, ending.error?.message);
        assert.equal(await takeFirst.held(), 0, 'the ended job holds no slot');

        // The ending first: an INSERT waits and is refused; an UPDATE, holding its slot row, is refused at once.
        const endFirst = await slotted();
        const take = await clash({ isolation, stale, first: db => update(endFirst.job, ends[table], [], db),
          second: endFirst.takes[taking] });
        noDeadlock(take);
        assert.ok(take.error, 'the taking is refused');
        if (stale || (repeatable && taking.endsWith('INSERT'))) assert.equal(take.error.code, '40001', take.error.message);
        else if (taking.endsWith('UPDATE')) refused('55P03', `analysis_${table}_slots_holder`)(take.error);
        else check(`analysis_${table}_slots_holder`)(take.error);
        assert.equal(await endFirst.held(), 0, 'the ended job holds no slot');
      }
    });

    test(`under ${isolation}, a ${taking} slot taking and a purge of its space finish in one order, leaving no slot`, async () => {
      const purge = spaceId => db => db.query('SELECT stateplane_purge_space($1)', [spaceId]);
      for (const stale of repeatable ? [false, true] : [false]) {
        // The taking first: deleting the space and the purge wait for it, and the purge removes the slot.
        if (!stale) {
          const live = await slotted();
          const purgingLive = await clash({ isolation: 'READ COMMITTED', firstIsolation: isolation, first: live.takes[taking],
            second: async db => {
              await db.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [live.spaceId]);
              await purge(live.spaceId)(db);
            } });
          noDeadlock(purgingLive);
          assert.equal(purgingLive.error, undefined, purgingLive.error?.message);
          assert.equal(await live.slots(), 0, 'the purge removed the slot taken first');
        }

        // The purge first: the taking is refused or finds no slot.
        const purgeFirst = await slotted();
        await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [purgeFirst.spaceId]);
        const take = await clash({ isolation, firstIsolation: 'READ COMMITTED', stale, first: purge(purgeFirst.spaceId),
          second: purgeFirst.takes[taking] });
        noDeadlock(take);
        // An INSERT waits for the space and finds it deleted; an UPDATE of a space slot waits for the slot the purge
        // removed; an UPDATE of a free cell slot is refused at once rather than wait while it holds that slot.
        const [, method] = taking.split(' ');
        if (repeatable && (stale || method === 'INSERT' || table === 'space')) assert.equal(take.error?.code, '40001', take.error?.message);
        else if (method === 'INSERT') check(`analysis_${table}_slots_space`)(take.error);
        else if (table === 'space') assert.equal(take.result.rowCount, 0, 'the purge removed the slot');
        else refused('55P03', 'analysis_cell_slots_space')(take.error);
        assert.equal(await purgeFirst.slots(), 0, 'no slot outlives the purge');
      }
    });
  }

  for (const table of ['space', 'cell']) {
    test(`under ${isolation}, extending a ${table} slot hold and ending its job finish in one order, and the ended job holds no slot`, async () => {
      for (const stale of repeatable ? [false, true] : [false]) {
        for (const extendFirst of [true, false]) {
          const { job, takes, extend, held } = await slotted();
          await takes[`${table} UPDATE`](pool);
          await run(job);
          const failed = `state='failed',failure_code='WORKER_LOST'`;
          const end = db => update(job, failed, [], db);
          const outcome = await clash({ isolation, stale, first: extendFirst ? extend(table) : end,
            second: extendFirst ? end : extend(table) });
          noDeadlock(outcome);
          if (repeatable) {
            assert.equal(outcome.error?.code, '40001', outcome.error?.message);
            if (extendFirst) await update(job, failed);
          } else {
            assert.equal(outcome.error, undefined, outcome.error?.message);
            if (!extendFirst) assert.equal(outcome.result.rowCount, 0, 'the released slot is not extended');
          }
          assert.equal((await pool.query(`SELECT state FROM analysis_jobs WHERE ${jobWhere}`, key(job))).rows[0].state,
            failed.match(/'(\w+)'/)[1]);
          assert.equal(await held(), 0, 'the ended job holds no slot');
        }
      }
    });
  }
}

/** Wait until backend `pid` waits on a lock or `promise` settles. */
async function waitsOrSettles(pid, promise) {
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  for (let attempt = 0; !settled; attempt += 1) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    assert.ok(attempt < 200, `backend ${pid} neither waited nor settled`);
    await sleep(25);
  }
}

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  test(`under ${isolation}, a slot statement that meets an ending or purge already holding its job or space never deadlocks`, async () => {
    const outcome = promise => promise.then(result => ({ result }), error => ({ error }));
    const [a, b] = [await pool.connect(), await pool.connect()];
    const pids = await Promise.all([a, b].map(async db => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    /** `hold` in a, then `slot` in b, then `finish` in a; returns both outcomes after committing each that succeeded. */
    const interleave = async (hold, slot, finish, holdIsolation = isolation) => {
      try {
        await a.query(`BEGIN ISOLATION LEVEL ${holdIsolation}`);
        await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await hold(a);
        const slotting = outcome(slot(b));
        await waitsOrSettles(pids[1], slotting);
        const finishing = outcome(finish(a));
        await waitsOrSettles(pids[0], finishing);
        const first = await slotting;
        await b.query(first.error ? 'ROLLBACK' : 'COMMIT');
        const last = await finishing;
        await a.query(last.error ? 'ROLLBACK' : 'COMMIT');
        noDeadlock(first);
        noDeadlock(last);
        return { slot: first, finish: last };
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        await b.query('ROLLBACK').catch(() => {});
      }
    };
    try {
      for (const table of ['space', 'cell']) {
        // The ender holds its job row (a progress write) when the holder extends; it then ends the job.
        const extended = await slotted();
        await extended.takes[`${table} UPDATE`](pool);
        await run(extended.job);
        const ending = await interleave(db => update(extended.job, 'runtime_ms=runtime_ms+1', [], db), extended.extend(table),
          db => update(extended.job, `state='failed',failure_code='WORKER_LOST'`, [], db));
        assert.equal(ending.slot.result?.rowCount, 1, 'the extension did not wait for the job');
        if (isolation === 'REPEATABLE READ') {
          assert.equal(ending.finish.error?.code, '40001', ending.finish.error?.message);
          await update(extended.job, `state='failed',failure_code='WORKER_LOST'`);
        } else assert.equal(ending.finish.error, undefined, ending.finish.error?.message);
        assert.equal(await extended.held(), 0, 'the ended job holds no slot');

        // The purge holds the space and its jobs, as it does first, when a slot is taken by update; it then finishes.
        const purged = await slotted();
        await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [purged.spaceId]);
        const purging = await interleave(async db => {
          await db.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR UPDATE', [purged.spaceId]);
          await db.query('SELECT 1 FROM analysis_jobs WHERE space_id=$1 FOR UPDATE', [purged.spaceId]);
        }, purged.takes[`${table} UPDATE`], db => db.query('SELECT stateplane_purge_space($1)', [purged.spaceId]), 'READ COMMITTED');
        refused('55P03', `analysis_${table}_slots_space`)(purging.slot.error);
        assert.equal(purging.finish.error, undefined, purging.finish.error?.message);
        assert.equal(await purged.slots(), 0, 'no slot outlives the purge');
      }
    } finally {
      a.release();
      b.release();
    }
  });
}

test('a slot taken by update waits for nothing more, so an upsert of its job or a space change in flight refuses it at once', async () => {
  const outcome = promise => promise.then(result => ({ result }), error => ({ error }));
  const [a, b] = [await pool.connect(), await pool.connect()];
  const pid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  try {
    for (const table of ['space', 'cell']) {
      // An upsert has written the job and waits for the slot row an update holds; the update then takes the slot for
      // the same job: it is refused (55P03), not deadlocked, and the upsert takes the slot.
      const raced = await slotted();
      await b.query('BEGIN');
      await b.query(`SELECT 1 FROM analysis_${table}_slots WHERE ${table}_id=$1 AND slot=1 FOR UPDATE`,
        [table === 'space' ? raced.spaceId : raced.cell]);
      await a.query('BEGIN');
      const upserting = outcome(raced.takes[`${table} upsert`](a));
      await waitsOrSettles(pid, upserting);
      const updated = await outcome(raced.takes[`${table} UPDATE`](b));
      await b.query(updated.error ? 'ROLLBACK' : 'COMMIT');
      const upserted = await upserting;
      await a.query(upserted.error ? 'ROLLBACK' : 'COMMIT');
      noDeadlock(updated);
      noDeadlock(upserted);
      refused('55P03', `analysis_${table}_slots_holder`)(updated.error);
      assert.equal(upserted.error, undefined, upserted.error?.message);
      assert.equal(await raced.held(), 1, 'the upsert holds the slot');

      // A lifecycle or cell change in flight refuses an update taking at once; once committed, the taking is refused.
      for (const change of [`lifecycle='suspended'`, ...table === 'cell' ? [`cell_id='cell-moved'`] : []]) {
        const changed = await slotted();
        await a.query('BEGIN');
        await a.query(`UPDATE spaces SET ${change} WHERE space_id=$1`, [changed.spaceId]);
        const inFlight = (await outcome(changed.takes[`${table} UPDATE`](pool))).error;
        assert.ok(inFlight, `a taking during ${change} went ahead of the space change`);
        refused('55P03', `analysis_${table}_slots_space`)(inFlight);
        await a.query('COMMIT');
        const late = (await outcome(changed.takes[`${table} UPDATE`](pool))).error;
        check(`analysis_${table}_slots_${change.startsWith('lifecycle') ? 'space' : 'holder'}`)(late);
        assert.equal(await changed.held(), 0, `no slot is taken across ${change}`);
      }
    }
  } finally {
    for (const client of [a, b]) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
});

test('a space purge runs only under READ COMMITTED, so a row committed after an earlier snapshot cannot outlive it', async () => {
  const { spaceId } = await space();
  const purger = await pool.connect();
  try {
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      // The purger's snapshot predates a free slot that another session adds and commits.
      await purger.query(`BEGIN ISOLATION LEVEL ${level}`);
      await purger.query('SELECT 1');
      await pool.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1) ON CONFLICT DO NOTHING', [spaceId]);
      await purger.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [spaceId]);
      await assert.rejects(purger.query('SELECT stateplane_purge_space($1)', [spaceId]), refused('25000'));
      await purger.query('ROLLBACK');
    }
    await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [spaceId]);
    await pool.query('SELECT stateplane_purge_space($1)', [spaceId]);
    assert.deepEqual(await counts(spaceId), Object.fromEntries([...analysisTables, 'analysis_cell_slots'].map(table => [table, 0])));
  } finally {
    await purger.query('ROLLBACK').catch(() => {});
    purger.release();
  }
});

test('as of a watermark, each record is its highest revision published at or below it, read through the as-of index', { timeout: 120000 }, async () => {
  const { spaceId } = await space();
  const scope = [spaceId, 'alpha'];
  // The feed derives each row's record and revision from its event, whatever the publisher sends, and refuses another collection's event.
  const mismatch = await inTransaction(db => write(db, spaceId, 'beta', 'rec_x', 1, { publish: false }));
  await assert.rejects(pool.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id) VALUES($1,$2,'alpha')`, [mismatch, spaceId]),
    refused('23503', 'record_event_feed_event'));
  const forged = await inTransaction(db => write(db, spaceId, 'alpha', 'rec_2', 1, { publish: false }));
  const derived = (await pool.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id,record_id,revision)
    VALUES($1,$2,'alpha','rec_1',9) RETURNING record_id,revision::int`, [forged, spaceId])).rows[0];
  assert.deepEqual({ ...derived }, { record_id: 'rec_2', revision: 1 });

  // The authority's own publication carries them too.
  const authority = new PostgresAuthority(pool, 3600);
  const writer = { spaceId, collectionId: 'alpha', principalId: 'owner', credentialId: 'owner-session', capability: 'records:write',
    policyVersion: 1, placementGeneration: 1 };
  const created = await authority.mutate(writer, { operation: 'create', idempotencyKey: 'k1', requestDigest: 'a'.repeat(64),
    canonicalData: '{"v":1}', unique: [], indexes: [] });
  await authority.transaction({ ...writer, capability: 'events:read' }, tx => tx.events());
  assert.deepEqual((await pool.query(`SELECT revision::int FROM record_event_feed WHERE space_id=$1 AND record_id=$2`,
    [spaceId, created.ref.id])).rows, [{ revision: 1 }]);

  // Before the watermark: rec_a created and patched, rec_b created and deleted, rec_c's revision 2 published before its
  // revision 1. After it: rec_a patched again, rec_d created, and rec_c's revision 3 written but not yet published.
  const w = await inTransaction(async db => {
    await write(db, spaceId, 'alpha', 'rec_a', 1);
    await write(db, spaceId, 'alpha', 'rec_a', 2);
    await write(db, spaceId, 'alpha', 'rec_b', 1);
    await write(db, spaceId, 'alpha', 'rec_b', 2, { operation: 'delete' });
    const c1 = await write(db, spaceId, 'alpha', 'rec_c', 1, { publish: false });
    const c2 = await write(db, spaceId, 'alpha', 'rec_c', 2, { publish: false });
    await publishEvent(db, c2);
    return publishEvent(db, c1);
  });
  await inTransaction(async db => {
    await write(db, spaceId, 'alpha', 'rec_a', 3);
    await write(db, spaceId, 'alpha', 'rec_d', 1);
    await write(db, spaceId, 'alpha', 'rec_c', 3, { publish: false });
  });
  const asOf = `SELECT r.record_id, e.revision::int, e.operation
    FROM records r
    CROSS JOIN LATERAL (SELECT f.revision FROM record_event_feed f
      WHERE f.space_id = r.space_id AND f.collection_id = r.collection_id AND f.record_id = r.record_id AND f.position <= $3
      ORDER BY f.revision DESC LIMIT 1) a
    JOIN record_events e ON e.space_id = r.space_id AND e.collection_id = r.collection_id AND e.record_id = r.record_id
      AND e.revision = a.revision
    WHERE r.space_id = $1 AND r.collection_id = $2 AND r.record_id > $4
    ORDER BY r.record_id LIMIT $5`;
  const at = async watermark => (await pool.query(asOf, [...scope, watermark, '', 100])).rows.map(row => [row.record_id, row.revision, row.operation]);
  assert.deepEqual((await at(w)).filter(([id]) => id.startsWith('rec_') && id.length === 5),
    [['rec_1', 1, 'create'], ['rec_2', 1, 'create'], ['rec_a', 2, 'patch'], ['rec_b', 2, 'delete'], ['rec_c', 2, 'patch']]);

  // A populated collection: 3,000 records, each 300th updated 200 times after the watermark. The lookup walks only the as-of index.
  await inTransaction(async db => {
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,'bulk')`, [spaceId]);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'bulk',1,'{}')`, [spaceId]);
  });
  await pool.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT $1,'bulk','b'||lpad(n::text,5,'0'),CASE WHEN n%300=0 THEN 201 ELSE 1 END,1,'generated','b'||n,'{}','{}'::jsonb
    FROM generate_series(1,3000) n`, [spaceId]);
  await pool.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
    SELECT 'evb_'||n||'_'||r,$1,'bulk','b'||lpad(n::text,5,'0'),r,CASE WHEN r=1 THEN 'create' ELSE 'patch' END,'w',1,'{}'
    FROM generate_series(1,3000) n CROSS JOIN generate_series(1,201) r WHERE r=1 OR n%300=0`, [spaceId]);
  await pool.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id) SELECT 'evb_'||n||'_1',$1,'bulk'
    FROM generate_series(1,3000) n ORDER BY n`, [spaceId]);
  const bulkWatermark = Number((await pool.query(`SELECT max(position) AS p FROM record_event_feed WHERE space_id=$1 AND collection_id='bulk'`,
    [spaceId])).rows[0].p);
  await pool.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id) SELECT 'evb_'||n||'_'||r,$1,'bulk'
    FROM generate_series(300,3000,300) n CROSS JOIN generate_series(2,201) r ORDER BY r,n`, [spaceId]);
  await pool.query(`DELETE FROM record_event_pending WHERE space_id=$1 AND collection_id='bulk'`, [spaceId]);
  await pool.query('ANALYZE records, record_events, record_event_feed');
  const page = (await pool.query(asOf, [spaceId, 'bulk', bulkWatermark, '', 1000])).rows;
  assert.equal(page.length, 1000);
  assert.ok(page.every(row => row.revision === 1), 'later revisions are excluded');
  const plan = (await pool.query(`EXPLAIN ${asOf}`, [spaceId, 'bulk', bulkWatermark, '', 1000])).rows.map(row => row['QUERY PLAN']).join('\n');
  assert.match(plan, /Index Only Scan Backward using record_event_feed_as_of on record_event_feed/);
  assert.doesNotMatch(plan, /Seq Scan on record_event(?:s|_feed)\b/);
});

const authConfig = { database: memoryAdapter(), namespace: `sta57-${randomUUID()}`, plugins: [] };
createAuthFn(authConfig);
const identity = new AuthFnIdentityVerifier(authConfig);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const spacesFor = cellPool => new PostgresSpaces(pool, new Map([['cell-a', { pool: cellPool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(authConfig), identity, randomBytes(32));
async function owner() {
  const user = await createUser(authConfig, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  return verify((await issueSession(authConfig, {}, { userId: user.id, methods: ['password'] })).sessionToken);
}
/** Give a space created through the services a collection with one published event, as `space()` does. */
async function seed(spaceId) {
  return inTransaction(async db => {
    await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, 'alpha']);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'alpha',1,'{}')`, [spaceId]);
    return write(db, spaceId, 'alpha', 'rec_1', 1);
  });
}

test('space erasure removes every job, page, manifest and space slot of that space only, and releases its cell slots', async () => {
  const erased = await space();
  const kept = await space();
  await populate(erased.spaceId, erased.watermark, 'cell-a');
  await populate(kept.spaceId, kept.watermark, 'cell-a');
  const keptBefore = await counts(kept.spaceId);
  assert.ok(Object.values(keptBefore).every(n => n > 0), JSON.stringify(keptBefore));
  assert.ok(Object.values(await counts(erased.spaceId)).every(n => n > 0));
  await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [erased.spaceId]);
  await pool.query('SELECT stateplane_purge_space($1)', [erased.spaceId]);
  assert.deepEqual(await counts(erased.spaceId), Object.fromEntries([...analysisTables, 'analysis_cell_slots'].map(table => [table, 0])));
  assert.deepEqual(await counts(kept.spaceId), keptBefore);
  assert.ok((await pool.query(`SELECT count(*)::int AS n FROM analysis_cell_slots WHERE cell_id='cell-a'`)).rows[0].n >= 2,
    'cell slots are cell capacity, not space data');
});

test('a space slot is added only while its space is live, so none outlives a purge, whichever starts first', async () => {
  const [purged, raced] = [await space(), await space()];
  const addSlot = (spaceId, db = pool) => db.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1)', [spaceId]);
  const slots = async spaceId => (await pool.query('SELECT count(*)::int AS n FROM analysis_space_slots WHERE space_id=$1', [spaceId])).rows[0].n;
  const [first, second] = [await pool.connect(), await pool.connect()];
  try {
    // A purge in flight: the slot waits for it and is then refused.
    await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [purged.spaceId]);
    await assert.rejects(addSlot(purged.spaceId), check('analysis_space_slots_space'));
    await first.query('BEGIN');
    await first.query('SELECT stateplane_purge_space($1)', [purged.spaceId]);
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const adding = addSlot(purged.spaceId, second).catch(error => error);
    await waitsOnLock(pid);
    await first.query('COMMIT');
    check('analysis_space_slots_space')(await adding);
    await assert.rejects(addSlot(purged.spaceId), check('analysis_space_slots_space'));
    assert.equal(await slots(purged.spaceId), 0);

    // A slot in flight: deleting the space waits for it, and the purge then removes it.
    await first.query('BEGIN');
    await addSlot(raced.spaceId, first);
    const deleting = second.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [raced.spaceId]);
    await waitsOnLock(pid);
    await first.query('COMMIT');
    await deleting;
    await pool.query('SELECT stateplane_purge_space($1)', [raced.spaceId]);
    assert.equal(await slots(raced.spaceId), 0);
  } finally {
    for (const client of [first, second]) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
});

test('a nonowner cell role runs jobs and proves erasure only with the analysis grants', async () => {
  const actor = await owner();
  const { spaceId } = await spacesFor(pool).create(actor);
  const watermark = await seed(spaceId);
  const role = `sta57_cell_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: urlFor(testDatabase), max: 2, options: `-c role=${role}` });
  const publicRoutines = (await pool.query(`SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`)).rows.map(row => row.routine);
  const analysis = [...analysisTables, 'analysis_cell_slots'];
  try {
    // A pre-049 cell role: every other table and the purge routine, nothing on the analysis tables, and the hardened
    // runbook's revocation of PUBLIC routine execution.
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${analysis.join(',')} FROM ${role}`);
    await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await pool.query('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC');
    await pool.query(`GRANT EXECUTE ON FUNCTION stateplane_purge_space(text) TO ${role}`);
    const asRole = async fn => {
      const client = await cellPool.connect();
      try { return await fn(client); } finally { client.release(); }
    };
    await assert.rejects(asRole(db => admit(spaceId, watermark, { principal_id: actor.userPrincipalId }, db)), refused('42501'));
    execFileSync(process.execPath, ['scripts/grant-analysis.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: urlFor(testDatabase), STATEPLANE_CELL_ROLE: role } });
    const privileges = Object.fromEntries((await pool.query(`SELECT t, has_table_privilege($1,t,'SELECT') AS r,
        has_table_privilege($1,t,'INSERT') AS i, has_table_privilege($1,t,'UPDATE') AS u, has_table_privilege($1,t,'DELETE') AS d,
        has_table_privilege($1,t,'TRUNCATE') AS x FROM unnest($2::text[]) t`, [role, analysis])).rows
      .map(({ t, ...row }) => [t, Object.entries(row).filter(([, granted]) => granted).map(([privilege]) => privilege).join('')]));
    assert.deepEqual(privileges, { analysis_jobs: 'riu', analysis_result_pages: 'rid', analysis_result_manifests: 'rid',
      analysis_space_slots: 'riu', analysis_cell_slots: 'riu' });
    // The role admits, runs and completes a job, takes and releases slots, and cannot delete a job; the checked digests need
    // no routine grant.
    await asRole(async db => {
      const job = await admit(spaceId, watermark, { principal_id: actor.userPrincipalId }, db);
      await db.query(`INSERT INTO analysis_space_slots(space_id,slot,holder_collection_id,holder_job_id,held_until)
        VALUES($1,1,'alpha',$2,clock_timestamp()+interval '1 minute')`, [spaceId, job.job_id]);
      await run(job, db);
      await page(job, 1, 'abc', 0, 1, 0, { db });
      await manifest(job, [{ content: 'abc', rows: 1 }], { db });
      await update(job, `state='completed'`, [], db);
      await assert.rejects(db.query('DELETE FROM analysis_jobs WHERE space_id=$1', [spaceId]), refused('42501'));
      const live = await admit(spaceId, watermark, { principal_id: actor.userPrincipalId }, db);
      await run(live, db);
      await page(live, 1, 'abc', 0, 1, 0, { db });
      // The erasing setting confers nothing on this role: the results of a completed or running job stay.
      for (const table of ['analysis_result_pages', 'analysis_result_manifests']) {
        await db.query('BEGIN');
        await db.query(`SELECT set_config('stateplane.erasing_space',$1,true)`, [spaceId]);
        await assert.rejects(db.query(`DELETE FROM ${table} WHERE space_id=$1`, [spaceId]), check(`${table}_kept`));
        await db.query('ROLLBACK');
      }
      // A failed job's results are the role's to remove.
      await update(live, `state='failed',failure_code='WORKER_LOST'`, [], db);
      assert.equal((await db.query('DELETE FROM analysis_result_pages WHERE job_id=$1', [live.job_id])).rowCount, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM analysis_result_pages WHERE job_id=$1', [job.job_id])).rows[0].n, 1);
      const holder = await admit(spaceId, watermark, { principal_id: actor.userPrincipalId }, db);
      await db.query(`INSERT INTO analysis_cell_slots(cell_id,slot,holder_space_id,holder_collection_id,holder_job_id,held_until)
        VALUES('cell-a',3,$1,'alpha',$2,clock_timestamp()+interval '1 minute') ON CONFLICT (cell_id,slot) DO UPDATE
        SET holder_space_id=EXCLUDED.holder_space_id,holder_collection_id=EXCLUDED.holder_collection_id,
          holder_job_id=EXCLUDED.holder_job_id,held_until=EXCLUDED.held_until`, [spaceId, holder.job_id]);
    });
    const spaces = spacesFor(cellPool);
    await spaces.archive(actor, spaceId);
    await spaces.delete(actor, spaceId);
    assert.deepEqual(await counts(spaceId), Object.fromEntries(analysis.map(table => [table, 0])));
    await assert.rejects(asRole(db => db.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1)', [spaceId])),
      check('analysis_space_slots_space'));
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
  } finally {
    await cellPool.end();
    for (const routine of publicRoutines) await pool.query(`GRANT EXECUTE ON ROUTINE ${routine} TO PUBLIC`);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

test('space deletion and erasure repair purge under READ COMMITTED whatever the session default isolation', async () => {
  for (const level of ['repeatable read', 'serializable']) {
    const sessionPool = new pg.Pool({ connectionString: urlFor(testDatabase), max: 2,
      options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` });
    try {
      assert.equal((await sessionPool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, level);
      const actor = await owner();
      const spaces = spacesFor(sessionPool);
      const { spaceId } = await spaces.create(actor);
      const job = await admit(spaceId, await seed(spaceId), { principal_id: actor.userPrincipalId });
      await pool.query(`INSERT INTO analysis_space_slots(space_id,slot,holder_collection_id,holder_job_id,held_until)
        VALUES($1,1,'alpha',$2,clock_timestamp()+interval '1 minute')`, [spaceId, job.job_id]);
      await spaces.archive(actor, spaceId);
      await spaces.delete(actor, spaceId);
      const none = Object.fromEntries([...analysisTables, 'analysis_cell_slots'].map(table => [table, 0]));
      assert.deepEqual(await counts(spaceId), none, level);
      // A row the purge missed, restored as the owner would, is erased by the repair under the same default.
      await inTransaction(async db => {
        await db.query("SELECT set_config('session_replication_role','replica',true)");
        await db.query('INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1)', [spaceId]);
      });
      assert.equal((await spaces.erasure(actor, spaceId)).database, 'pending', level);
      await spaces.repairDeletedErasure(actor, spaceId);
      assert.deepEqual(await counts(spaceId), none, level);
      assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased', level);
    } finally { await sessionPool.end(); }
  }
});

test('the erasure report waits for analysis rows that outlive a purge', async () => {
  const actor = await owner();
  const spaces = spacesFor(pool);
  const { spaceId } = await spaces.create(actor);
  await spaces.archive(actor, spaceId);
  await spaces.delete(actor, spaceId);
  assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
  // A row the purge missed, inserted as the owner would restore one, keeps the database pending.
  const restoreRow = sql => inTransaction(async db => {
    await db.query("SELECT set_config('session_replication_role','replica',true)");
    await db.query(sql, [spaceId]);
  });
  for (const [insert, remove] of [
    [`INSERT INTO analysis_space_slots(space_id,slot) VALUES($1,1)`, 'DELETE FROM analysis_space_slots WHERE space_id=$1'],
    [`INSERT INTO analysis_jobs(space_id,collection_id,job_id,kind,principal_id,credential_id,capability,policy_version,
      placement_generation,schema_version,watermark,canonical_spec,spec_digest,budget_records,budget_bytes,budget_runtime_ms,expires_at)
      VALUES($1,'gone','anj_00000000-0000-4000-8000-000000000000','export','o','c','records:read',1,1,1,0,'{}',
      encode(sha256(convert_to('{}','UTF8')),'hex'),1,1,1,clock_timestamp()+interval '1 hour')`,
    'DELETE FROM analysis_jobs WHERE space_id=$1']]) {
    await restoreRow(insert);
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'pending', insert);
    await restoreRow(remove);
  }
});

/** Apply, in one transaction except 047's concurrent index, every migration that precedes `migration`, recording each. */
async function applyMigrationsBefore(client, migration) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  assert.ok(files.includes(migration), `${migration} exists`);
  await client.query('BEGIN; CREATE TABLE stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of files.slice(0, files.indexOf(migration))) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    if (file === '047_retrieval_outbox_age.sql') { await client.query('COMMIT'); await client.query(sql); await client.query('BEGIN'); } // NOSONAR -- 047 cannot run in a transaction
    else await client.query(sql); // NOSONAR -- migrations apply in order
    await client.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)', [file, digest(sql)]); // NOSONAR -- recorded with its file
  }
  await client.query('COMMIT');
}

test('migration 049 rolls back whole when the feed is busy, populated past its bound or slow, keeps purges in flight working, and backfills the feed', { timeout: 120000 }, async () => {
  const name = upgradeDatabase;
  const [db, reader, purger] = [0, 1, 2].map(() => new pg.Client({ connectionString: urlFor(name) }));
  await Promise.all([db, reader, purger].map(client => client.connect()));
  const until = async (sql, message) => {
    for (let attempt = 0; !(await db.query(sql)).rows[0].ok; attempt += 1) {
      assert.ok(attempt < 1000, message);
      await sleep(10);
    }
  };
  const here = 'database=(SELECT oid FROM pg_database WHERE datname=current_database())';
  const feedWaited = `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND ${here} AND relation=to_regclass('record_event_feed')) AS ok`;
  try {
    await applyMigrationsBefore(db, '048_projection_rebuilds.sql');
    // Events published before 049 in a live space, and a space being erased.
    const positions = {};
    for (const spaceId of ['sp_upgrade', 'sp_doomed']) {
      await db.query('BEGIN');
      await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES($1,'owner','cell-a','cell-a','target-a')`,
        [spaceId]);
      await db.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,'entries')`, [spaceId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'entries',1,'{}')`, [spaceId]);
      positions[spaceId] = [];
      for (const [recordId, revision] of [['rec_1', 1], ['rec_1', 2], ['rec_2', 1]])
        positions[spaceId].push(await write(db, spaceId, 'entries', recordId, revision));
      await db.query('COMMIT');
    }
    await db.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id='sp_doomed'`);
    const untouched = async () => {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM stateplane_migrations WHERE name='049_analysis_jobs.sql'`)).rows[0].n, 0);
      assert.deepEqual((await db.query(`SELECT to_regclass('public.analysis_jobs') AS jobs,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='record_event_feed' AND column_name='record_id') AS feed`))
        .rows[0], { jobs: null, feed: 0 });
    };

    // An event reader holds the feed: nothing of 049 is left behind. 048 commits before 049 waits, so retrieval writes
    // and searches never wait behind the feed.
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM record_event_feed');
    const blocking = migrateAsync(name);
    await until(feedWaited, 'migration 049 never waited for the feed');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE ${here}
      AND relation=to_regclass('projection_generations') AND pid<>pg_backend_pid()`)).rows[0].n, 0, '048 still holds the generations');
    const blocked = await blocking;
    assert.equal(blocked.status, 1);
    assert.equal(blocked.stdout, 'Applied 048_projection_rebuilds.sql\n');
    assert.match(blocked.stderr, /Analysis job upgrade waits for event feed readers, space purges and collection, schema or space writers/);
    await reader.query('ROLLBACK');
    await untouched();

    // Above 50,000 feed rows the backfill's lock hold needs a drained window.
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id) SELECT 'bulk_'||n,'sp_upgrade','entries'
      FROM generate_series(1,50001) n`);
    await db.query('COMMIT');
    const populated = migrate(name, { STATEPLANE_POPULATED_INDEX_UPGRADE: '' });
    assert.equal(populated.status, 1);
    assert.match(populated.stderr, /Populated analysis job upgrade requires drained traffic above 50000 event feed rows/);
    await untouched();
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(`DELETE FROM record_event_feed WHERE event_id LIKE 'bulk\\_%'`);
    await db.query('COMMIT');

    // A statement still running once it holds the feed (as a slow backfill would) is cancelled at the bound, rolling
    // the step back and releasing the feed. The undrained step's own bound replaces a shorter inherited timeout.
    await db.query(`CREATE FUNCTION test_slow_feed() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity='public.record_event_feed')
      THEN PERFORM pg_sleep(600); END IF; END $$`);
    await db.query(`CREATE EVENT TRIGGER test_slow_feed ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION test_slow_feed()`);
    await db.query(`ALTER DATABASE ${name} SET statement_timeout = '2s'`);
    const feedReleased = async () => assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE ${here}
      AND relation=to_regclass('record_event_feed') AND pid<>pg_backend_pid()`)).rows[0].n, 0, 'the feed is released');
    let started = Date.now();
    const slow = await migrateAsync(name, { STATEPLANE_POPULATED_INDEX_UPGRADE: '' });
    assert.ok(Date.now() - started >= 14_000, 'the inherited timeout, not the step bound, ended the step');
    assert.ok(Date.now() - started < 40_000, 'the statement bound never ended the step');
    assert.equal(slow.status, 1);
    assert.match(slow.stderr, /^Analysis job upgrade ran past its 15 s statement bound and was rolled back, releasing the event feed; retry/);
    await feedReleased();
    await untouched();
    // A drained step installs no bound: the inherited timeout ends it, and the failure does not claim the step's bound.
    started = Date.now();
    const inherited = await migrateAsync(name, { STATEPLANE_POPULATED_INDEX_UPGRADE: 'drained' });
    assert.ok(Date.now() - started < 14_000, 'the inherited timeout never ended the drained step');
    assert.equal(inherited.status, 1);
    assert.match(inherited.stderr, /^Analysis job upgrade ran past the inherited statement_timeout \(a drained upgrade installs no bound\) and was rolled back, releasing the event feed/);
    assert.doesNotMatch(inherited.stderr, /statement bound/);
    await db.query(`ALTER DATABASE ${name} RESET statement_timeout`);
    await db.query('DROP EVENT TRIGGER test_slow_feed; DROP FUNCTION test_slow_feed()');
    await feedReleased();
    await untouched();

    // An erasure repair holds its space before its purge reaches the feed: 049 never waits for the space while holding
    // the feed, so it is refused at once instead of deadlocking with the purge.
    await purger.query('BEGIN');
    await purger.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id='sp_doomed'`);
    let settled = false;
    const refusing = migrateAsync(name).finally(() => { settled = true; });
    while (!settled) {
      assert.equal((await db.query(`SELECT EXISTS (SELECT 1 FROM pg_locks h JOIN pg_locks w ON w.pid=h.pid AND NOT w.granted
        WHERE h.granted AND h.${here} AND h.mode='AccessExclusiveLock' AND h.relation=to_regclass('record_event_feed')) AS ok`)).rows[0].ok,
      false, 'migration 049 waited for a lock while holding the feed');
      await sleep(10);
    }
    const refusedStep = await refusing;
    assert.equal(refusedStep.status, 1);
    assert.match(refusedStep.stderr, /Analysis job upgrade waits for event feed readers, space purges and collection, schema or space writers/);
    await untouched();
    // The purge, now past its events, holds the feed: 049 waits for it, the purge completes with 048's routine (no
    // analysis rows exist yet), and 049 then applies.
    await purger.query(`SELECT stateplane_purge_space('sp_doomed')`);
    const applying = migrateAsync(name);
    await until(feedWaited, 'migration 049 never waited for the purge');
    await purger.query('COMMIT');
    const applied = await applying;
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied 049_analysis_jobs.sql/);
    assert.equal((await db.query(`SELECT lifecycle FROM spaces WHERE space_id='sp_doomed'`)).rows[0].lifecycle, 'deleted');

    // Existing feed rows carry their events' records and revisions.
    assert.deepEqual((await db.query(`SELECT position::int,record_id,revision::int FROM record_event_feed ORDER BY position`)).rows
      .map(row => [row.position, row.record_id, row.revision]),
    positions.sp_upgrade.map((position, i) => [position, ['rec_1', 'rec_1', 'rec_2'][i], [1, 2, 1][i]]));
    // Upgraded and fresh schemas carry the same columns, constraints, indexes and triggers.
    const schema = async client => ({
      columns: (await client.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='public' ORDER BY table_name,column_name`)).rows,
      constraints: (await client.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
      indexes: (await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)).rows,
      triggers: (await client.query(`SELECT tgrelid::regclass::text AS relation,tgname FROM pg_trigger WHERE NOT tgisinternal
        ORDER BY relation,tgname`)).rows });
    const fresh = await pool.connect();
    try { assert.deepEqual(await schema(db), await schema(fresh)); } finally { fresh.release(); }
    assert.equal(migrate(name).status, 0, 'a recorded 049 is skipped');
  } finally {
    await reader.query('ROLLBACK').catch(() => {});
    await purger.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([db, reader, purger].map(client => client.end()));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresSpaces } from '../../packages/postgres/dist/index.js';

// STA-69 storage only: no service writes the erasure ledger, export or import
// rows yet, so their fixtures use SQL. One database for most tests, a separate
// control and cell database (and the cell's backup) for the restore proof, and
// an upgraded and a fresh database for the migration checks; all dropped after.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const urlFor = name => Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const suffix = randomUUID().replaceAll('-', '');
const db = Object.fromEntries(['main', 'control', 'cell', 'backup', 'upgrade', 'fresh'].map(kind => [kind, `stateplane_portability_${kind}_${suffix}`]));
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
};
const migrate = (name, env = {}) => spawnSync(process.execPath, ['scripts/migrate.mjs'],
  { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8' });
const pool = new pg.Pool({ connectionString: urlFor(db.main), max: 6 });
test.before(async () => {
  const failed = (await Promise.allSettled([db.main, db.control, db.cell, db.upgrade, db.fresh].map(name => admin(`CREATE DATABASE ${name}`))))
    .find(creation => creation.status === 'rejected');
  if (failed) throw failed.reason;
  for (const name of [db.main, db.control, db.cell]) {
    const migrated = migrate(name);
    assert.equal(migrated.status, 0, migrated.stderr);
  }
});
test.after(async () => {
  await pool.end();
  await Promise.all(Object.values(db).map(name => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)));
});

const digest = value => createHash('sha256').update(value).digest('hex');
const refused = (code, constraint) => error => {
  assert.equal(error.code, code, error.message);
  if (constraint) assert.equal(error.constraint, constraint, error.message);
  return true;
};
const check = constraint => refused('23514', constraint);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const authConfig = { database: memoryAdapter(), namespace: `sta69-${randomUUID()}`, plugins: [] };
createAuthFn(authConfig);
const identity = new AuthFnIdentityVerifier(authConfig);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const spacesFor = (control, cell) => new PostgresSpaces(control, new Map([['cell-a', { pool: cell, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(authConfig), identity, randomBytes(32));
async function owner() {
  const user = await createUser(authConfig, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  return verify((await issueSession(authConfig, {}, { userId: user.id, methods: ['password'] })).sessionToken);
}

/** A cell space owned by 'owner' with one collection, a confirmed agent credential and, unless `events` is 0, published events. */
async function space({ events = 1, lifecycle = 'active' } = {}) {
  const spaceId = `sp_${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    await client.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,'alpha')`, [spaceId]);
    await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,'alpha',1,'{}')`, [spaceId]);
    await client.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
      VALUES($1,'cred_agent','agent','owner',clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp()),
        ($1,'cred_pending','pending','owner',clock_timestamp()+interval '1 hour',clock_timestamp(),NULL)`, [spaceId]);
    const positions = [];
    for (let revision = 1; revision <= events; revision += 1) {
      if (revision === 1) await client.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,
        normalized_key,canonical_data,data) VALUES($1,'alpha','rec_1',1,1,'generated','rec_1','{}','{}'::jsonb)`, [spaceId]);
      const eventId = `evt_${randomUUID()}`;
      await client.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
        VALUES($1,$2,'alpha','rec_1',$3,$4,'writer',1,'{}')`, [eventId, spaceId, revision, revision === 1 ? 'create' : 'patch']);
      positions.push(Number((await client.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id) VALUES($1,$2,'alpha')
        RETURNING position`, [eventId, spaceId])).rows[0].position));
      await client.query('DELETE FROM record_event_pending WHERE event_id=$1', [eventId]);
    }
    if (lifecycle !== 'active') await client.query('UPDATE spaces SET lifecycle=$2 WHERE space_id=$1', [spaceId, lifecycle]);
    await client.query('COMMIT');
    return { spaceId, positions };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function admit(spaceId, kind, overrides = {}, client = pool) {
  const current = (await client.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1', [spaceId])).rows[0];
  const row = { space_id: spaceId, job_id: `${kind === 'export' ? 'exp' : 'imp'}_${randomUUID()}`, kind, principal_id: 'owner',
    credential_id: 'cred_owner', policy_version: current.policy_version, placement_generation: current.placement_generation,
    format_version: 1, watermark: 0, manifest_sha256: kind === 'import' ? digest('manifest') : null,
    part_count: kind === 'import' ? 2 : null, expires_at: new Date(Date.now() + 3_600_000), ...overrides };
  const columns = Object.keys(row);
  return (await client.query(`INSERT INTO portability_jobs(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})
    RETURNING *`, Object.values(row))).rows[0];
}
const update = (job, set, values = [], client = pool) => client.query(`UPDATE portability_jobs SET ${set} WHERE space_id=$1 AND job_id=$2 RETURNING *`,
  [job.space_id, job.job_id, ...values]).then(result => result.rows[0]);
const run = (job, client = pool) => update(job, `state='running',lease_id='lease',leased_until=clock_timestamp()+interval '1 minute',
  attempts=attempts+1`, [], client);
function part(job, number, content = `{"part":${number}}\n`, client = pool) {
  return client.query(`INSERT INTO portability_parts(space_id,job_id,kind,part_number,section,row_count,byte_size,content_sha256,content)
    VALUES($1,$2,$3,$4,'records',1,$5,$6,$7)`, job.kind === 'export'
    ? [job.space_id, job.job_id, 'export', number, Buffer.byteLength(content), digest(content), content]
    : [job.space_id, job.job_id, 'import', number, 7, digest(`part ${number}`), null]);
}
const map = (job, source, role, target, credential = null, client = pool) => client.query(`INSERT INTO portability_principal_map(space_id,
  job_id,source_principal_id,role,target_principal_id,target_credential_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
[job.space_id, job.job_id, source, role, target, credential]).then(result => result.rows[0]);
const directoryRow = (spaceId, lifecycle, client = pool) => client.query(`INSERT INTO space_directory(space_id,owner_principal_id,
  home_cell_id,cell_id,storage_target_id,lifecycle) VALUES($1,'owner','cell-a','cell-a','target-a',$2) RETURNING *`, [spaceId, lifecycle])
  .then(result => result.rows[0]);
const directory = (spaceId, client = pool) => client.query(`SELECT lifecycle,archived_at,tombstoned_at,hard_erased_at
  FROM space_directory WHERE space_id=$1`, [spaceId]).then(result => result.rows[0]);
const portabilityTables = ['portability_jobs', 'portability_parts', 'portability_principal_map'];
const counts = async spaceId => Object.fromEntries(await Promise.all(portabilityTables.map(async table =>
  [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId])).rows[0].n])));

/** Apply every migration before `migration` as the migrator records it, 047's and 050's concurrent indexes outside the transaction. */
async function applyMigrationsBefore(client, migration) {
  const directoryUrl = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directoryUrl)).filter(file => file.endsWith('.sql')).sort();
  assert.ok(files.includes(migration), `${migration} exists`);
  await client.query('CREATE TABLE stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of files.slice(0, files.indexOf(migration))) {
    const sql = await readFile(new URL(file, directoryUrl), 'utf8');
    if (['047_retrieval_outbox_age.sql', '050_records_byte_order.sql'].includes(file)) await client.query(sql); // NOSONAR -- concurrent index
    else await client.query(`BEGIN; ${sql}; COMMIT`); // NOSONAR -- migrations apply in order
    await client.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)', [file, digest(sql)]); // NOSONAR -- recorded with its file
  }
}

test('migration 051 applies on the current schema, waiting boundedly for directory writers, and matches a fresh install', { timeout: 120000 }, async () => {
  const upgraded = new pg.Client({ connectionString: urlFor(db.upgrade) });
  const holder = new pg.Client({ connectionString: urlFor(db.upgrade) });
  const fresh = new pg.Client({ connectionString: urlFor(db.fresh) });
  await Promise.all([upgraded, holder, fresh].map(client => client.connect()));
  try {
    await applyMigrationsBefore(upgraded, '051_portability_erasure_ledger.sql');
    // Directory rows in each state before 051, last published at known times, and a cell space with content.
    const published = { sp_active: 'active', sp_archived: 'readOnly', sp_suspended: 'suspended', sp_deleting: 'deleting', sp_deleted: 'deleted' };
    for (const [spaceId, lifecycle] of Object.entries(published)) {
      await upgraded.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,updated_at)
        VALUES($1,'owner','cell-a','cell-a','target-a',$2,'2026-01-02 03:04:05.123456+00')`, [spaceId, lifecycle]);
    }
    await upgraded.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES('sp_active','owner','cell-a','cell-a','target-a')`);

    // A directory writer holds the table: 051 waits at most its bound, then rolls back whole with a retry message.
    await holder.query('BEGIN');
    await holder.query(`UPDATE space_directory SET updated_at=updated_at WHERE space_id='sp_active'`);
    const blocked = migrate(db.upgrade);
    await holder.query('ROLLBACK');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Portability and erasure ledger upgrade waits for space directory, space and credential writers and space purges/);
    assert.deepEqual((await upgraded.query(`SELECT to_regclass('public.erasure_ledger') AS ledger,
      (SELECT count(*)::int FROM stateplane_migrations WHERE name='051_portability_erasure_ledger.sql') AS recorded`)).rows[0],
    { ledger: null, recorded: 0 });

    const applied = migrate(db.upgrade);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stdout, 'Applied 051_portability_erasure_ledger.sql\n');
    // Archived and deleted spaces take their last publication time; the others have no stamp.
    const stamps = (await upgraded.query(`SELECT space_id,archived_at::text AS archived,tombstoned_at::text AS tombstoned,
      hard_erased_at AS erased FROM space_directory ORDER BY space_id`)).rows;
    const at = '2026-01-02 03:04:05.123456+00';
    assert.deepEqual(stamps, [
      { space_id: 'sp_active', archived: null, tombstoned: null, erased: null },
      { space_id: 'sp_archived', archived: at, tombstoned: null, erased: null },
      { space_id: 'sp_deleted', archived: null, tombstoned: at, erased: null },
      { space_id: 'sp_deleting', archived: null, tombstoned: null, erased: null },
      { space_id: 'sp_suspended', archived: null, tombstoned: null, erased: null }]);
    assert.equal(migrate(db.upgrade).stdout, '', 'a second run applies nothing');

    const fromEmpty = migrate(db.fresh);
    assert.equal(fromEmpty.status, 0, fromEmpty.stderr);
    assert.match(fromEmpty.stdout, /Applied 051_portability_erasure_ledger\.sql\n$/);
    const schema = async client => ({
      constraints: (await client.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
      triggers: (await client.query(`SELECT tgrelid::regclass::text AS relation,tgname,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE NOT tgisinternal ORDER BY relation,tgname`)).rows,
      indexes: (await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)).rows,
      routines: (await client.query(`SELECT p.oid::regprocedure::text AS routine,md5(pg_get_functiondef(p.oid)) AS body,p.proacl::text AS acl
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' ORDER BY routine`)).rows,
      privileges: (await client.query(`SELECT relname,relacl::text AS acl FROM pg_class WHERE relnamespace='public'::regnamespace
        AND relname IN ('erasure_ledger','portability_jobs','portability_parts','portability_principal_map') ORDER BY relname`)).rows
    });
    assert.deepEqual(await schema(upgraded), await schema(fresh));
  } finally { await Promise.allSettled([upgraded.end(), holder.end(), fresh.end()]); }
});

test('restoring a cell from its backup brings the erased space back but leaves the control erasure ledger and stamps intact', { timeout: 60000 }, async () => {
  const control = new pg.Pool({ connectionString: urlFor(db.control), max: 3 });
  let cell = new pg.Pool({ connectionString: urlFor(db.cell), max: 3 });
  try {
    const actor = await owner();
    let spaces = spacesFor(control, cell);
    const { spaceId } = await spaces.create(actor);
    await cell.query(`BEGIN; INSERT INTO collections(space_id,collection_id) VALUES('${spaceId}','alpha');
      INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('${spaceId}','alpha',1,'{}'); COMMIT`);
    await cell.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      VALUES($1,'alpha','rec_secret',1,1,'generated','rec_secret','{"secret":true}','{"secret":true}'::jsonb)`, [spaceId]);
    await spaces.archive(actor, spaceId);
    // The cell's backup: a whole-database copy taken while the space is archived. The cell has no ledger entry to copy.
    await cell.end();
    await admin(`CREATE DATABASE ${db.backup} TEMPLATE ${db.cell}`);
    cell = new pg.Pool({ connectionString: urlFor(db.cell), max: 3 });
    spaces = spacesFor(control, cell);

    // Deletion, then the control ledger entry and the hard erasure stamp, as STA-72's erasure will record them.
    await spaces.delete(actor, spaceId);
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
    const { erasure_id: erasureId } = (await control.query(`INSERT INTO erasure_ledger(scope,space_id,cell_id) VALUES('space',$1,'cell-a')
      RETURNING erasure_id`, [spaceId])).rows[0];
    await control.query('UPDATE space_directory SET hard_erased_at=clock_timestamp() WHERE space_id=$1', [spaceId]);
    const ledgerBefore = (await control.query('SELECT * FROM erasure_ledger ORDER BY erasure_id')).rows;
    const stampsBefore = await directory(spaceId, control);
    assert.ok(stampsBefore.archived_at && stampsBefore.tombstoned_at && stampsBefore.hard_erased_at);
    assert.equal((await cell.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1', [spaceId])).rows[0].n, 0);
    // A cell database cannot hold a ledger entry: it has no directory row to name.
    await assert.rejects(cell.query(`INSERT INTO erasure_ledger(scope,space_id,cell_id) VALUES('space',$1,'cell-a')`, [spaceId]),
      check('erasure_ledger_cell'));

    // Restore the regional data: the cell database is replaced by its backup.
    await cell.end();
    await admin(`DROP DATABASE ${db.cell} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${db.cell} TEMPLATE ${db.backup}`);
    cell = new pg.Pool({ connectionString: urlFor(db.cell), max: 3 });
    spaces = spacesFor(control, cell);
    // The backup resurrected the space and its content ...
    assert.deepEqual((await cell.query(`SELECT s.lifecycle,count(r.*)::int AS records FROM spaces s LEFT JOIN records r USING (space_id)
      WHERE s.space_id=$1 GROUP BY s.lifecycle`, [spaceId])).rows, [{ lifecycle: 'readOnly', records: 1 }]);
    assert.equal((await cell.query('SELECT count(*)::int AS n FROM erasure_ledger')).rows[0].n, 0);
    // ... while the control ledger keeps every entry, naming the restored cell to replay, and the directory keeps its stamps.
    assert.deepEqual((await control.query('SELECT * FROM erasure_ledger ORDER BY erasure_id')).rows, ledgerBefore);
    assert.deepEqual((await control.query(`SELECT erasure_id,scope,space_id FROM erasure_ledger WHERE cell_id='cell-a' ORDER BY erasure_id`)).rows,
      [{ erasure_id: erasureId, scope: 'space', space_id: spaceId }]);
    assert.deepEqual(await directory(spaceId, control), stampsBefore);
    // The resurrection is visible, not reported as erased.
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'pending');
  } finally { await Promise.allSettled([control.end(), cell.end()]); }
});

test('the erasure ledger names a current cell and an allowed directory state, records each object once and never changes', async () => {
  const deleting = `sp_${randomUUID()}`;
  const live = `sp_${randomUUID()}`;
  const provisioning = `sp_${randomUUID()}`;
  await directoryRow(deleting, 'deleting');
  await directoryRow(live, 'active');
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle,provisioning_lease_until)
    VALUES($1,'owner','cell-a','target-a','provisioning',clock_timestamp()+interval '1 minute')`, [provisioning]);
  const ledger = (scope, spaceId, cellId = 'cell-a', collectionId = null, sourceId = null) => pool.query(`INSERT INTO erasure_ledger(scope,
    space_id,cell_id,collection_id,source_id,recorded_at) VALUES($1,$2,$3,$4,$5,'2000-01-01') RETURNING *`,
  [scope, spaceId, cellId, collectionId, sourceId]).then(result => result.rows[0]);

  await assert.rejects(ledger('space', live), check('erasure_ledger_lifecycle'));
  await assert.rejects(ledger('source', provisioning, 'cell-a', 'alpha', 'src_1'), check('erasure_ledger_lifecycle'));
  await assert.rejects(ledger('space', deleting, 'cell-b'), check('erasure_ledger_cell'));
  await assert.rejects(ledger('space', `sp_${randomUUID()}`), check('erasure_ledger_cell'));
  await assert.rejects(ledger('space', deleting, 'cell-a', 'alpha', 'src_1'), check('erasure_ledger_target'));
  await assert.rejects(ledger('source', live, 'cell-a', 'alpha'), check('erasure_ledger_target'));
  const entry = await ledger('space', deleting);
  assert.ok(Date.now() - entry.recorded_at.getTime() < 60_000, 'recorded at the database clock, not the writer\'s');
  await assert.rejects(ledger('space', deleting), refused('23505', 'erasure_ledger_once'));
  await ledger('source', live, 'cell-a', 'alpha', 'src_1');
  await assert.rejects(ledger('source', live, 'cell-a', 'alpha', 'src_1'), refused('23505', 'erasure_ledger_once'));
  await assert.rejects(pool.query(`INSERT INTO erasure_ledger(erasure_id,scope,space_id,cell_id) VALUES(1,'space',$1,'cell-a')`, [deleting]),
    refused('428C9'));

  for (const sql of ['UPDATE erasure_ledger SET cell_id=cell_id WHERE space_id=$1', 'DELETE FROM erasure_ledger WHERE space_id=$1'])
    await assert.rejects(pool.query(sql, [deleting]), check('erasure_ledger_immutable'), sql);
  await assert.rejects(pool.query('TRUNCATE erasure_ledger'), check('erasure_ledger_immutable'));
  // Its space's directory row stays while the entry does.
  await assert.rejects(pool.query('DELETE FROM space_directory WHERE space_id=$1', [deleting]), refused('23503'));
});

test('directory lifecycle stamps follow the spaces service through archive, restore, deletion and hard erasure', async () => {
  const actor = await owner();
  const spaces = spacesFor(pool, pool);
  const { spaceId } = await spaces.create(actor);
  assert.deepEqual(await directory(spaceId), { lifecycle: 'active', archived_at: null, tombstoned_at: null, hard_erased_at: null });
  await spaces.archive(actor, spaceId);
  const archived = (await directory(spaceId)).archived_at;
  assert.ok(archived);
  await spaces.update(actor, spaceId, 'active');
  assert.equal((await directory(spaceId)).archived_at, null, 'restoring an archive clears its stamp');
  await spaces.archive(actor, spaceId);
  const rearchived = (await directory(spaceId)).archived_at;
  assert.ok(rearchived > archived);
  await spaces.update(actor, spaceId, 'suspended');
  assert.deepEqual((await directory(spaceId)).archived_at, rearchived, 'suspension keeps the archive stamp');
  // Writers cannot forge or clear a stamp.
  await pool.query(`UPDATE space_directory SET archived_at='2000-01-01',tombstoned_at='2000-01-01' WHERE space_id=$1`, [spaceId]);
  assert.deepEqual(await directory(spaceId), { lifecycle: 'suspended', archived_at: rearchived, tombstoned_at: null, hard_erased_at: null });
  await assert.rejects(pool.query('UPDATE space_directory SET hard_erased_at=clock_timestamp() WHERE space_id=$1', [spaceId]),
    check('space_directory_hard_erased'));

  await spaces.delete(actor, spaceId);
  const deleted = await directory(spaceId);
  assert.equal(deleted.lifecycle, 'deleted');
  assert.ok(deleted.tombstoned_at >= rearchived);
  assert.deepEqual(deleted.archived_at, rearchived);
  await pool.query(`UPDATE space_directory SET tombstoned_at=NULL WHERE space_id=$1`, [spaceId]);
  assert.deepEqual((await directory(spaceId)).tombstoned_at, deleted.tombstoned_at, 'the tombstone stamp is kept');
  // Hard erasure needs a space entry in the ledger, takes the database clock, and is final.
  await assert.rejects(pool.query('UPDATE space_directory SET hard_erased_at=clock_timestamp() WHERE space_id=$1', [spaceId]),
    check('space_directory_hard_erased'));
  await pool.query(`INSERT INTO erasure_ledger(scope,space_id,cell_id) VALUES('space',$1,'cell-a')`, [spaceId]);
  await pool.query(`UPDATE space_directory SET hard_erased_at='2000-01-01' WHERE space_id=$1`, [spaceId]);
  const erased = (await directory(spaceId)).hard_erased_at;
  assert.ok(erased >= deleted.tombstoned_at, 'stamped with the database clock');
  for (const value of [null, '2001-01-01'])
    await assert.rejects(pool.query('UPDATE space_directory SET hard_erased_at=$2 WHERE space_id=$1', [spaceId, value]),
      check('space_directory_hard_erased'));
  await assert.rejects(pool.query(`UPDATE space_directory SET lifecycle='deleting' WHERE space_id=$1`, [spaceId]),
    check('space_directory_hard_erased'), 'a hard-erased space stays deleted');
  // An operator may still move a tombstone that is not hard-erased, as repairing an inconsistent restore does; its stamp follows.
  const repaired = await directoryRow(`sp_${randomUUID()}`, 'deleted');
  await pool.query(`UPDATE space_directory SET lifecycle='active' WHERE space_id=$1`, [repaired.space_id]);
  assert.equal((await directory(repaired.space_id)).tombstoned_at, null);
  // A row cannot be inserted already hard-erased, and an inserted deleted row is stamped as it is published.
  await assert.rejects(pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,
    hard_erased_at) VALUES($1,'owner','cell-a','cell-a','target-a','deleted',clock_timestamp())`, [`sp_${randomUUID()}`]),
  check('space_directory_hard_erased'));
  const inserted = await directoryRow(`sp_${randomUUID()}`, 'deleted');
  assert.ok(inserted.tombstoned_at && !inserted.archived_at);
});

test('a portability job is admitted by the owner of a live space under its current binding, an export at a watermark of its feed', async () => {
  const { spaceId, positions } = await space({ events: 2 });
  const empty = await space({ events: 0 });
  const other = await space();
  await assert.rejects(admit(spaceId, 'export', { principal_id: 'agent', credential_id: 'cred_agent' }), check('portability_jobs_owner'));
  await assert.rejects(admit(spaceId, 'export', { policy_version: 2 }), check('portability_jobs_binding'));
  await assert.rejects(admit(spaceId, 'import', { placement_generation: 2 }), check('portability_jobs_binding'));
  for (const watermark of [0, positions[0] - 1, other.positions[0]])
    await assert.rejects(admit(spaceId, 'export', { watermark }), check('portability_jobs_watermark'), String(watermark));
  await assert.rejects(admit(empty.spaceId, 'export', { watermark: positions[0] }), check('portability_jobs_watermark'));
  assert.equal((await admit(empty.spaceId, 'export')).watermark, '0');
  for (const watermark of positions) await admit(spaceId, 'export', { watermark });
  // An import binds the source export's watermark, digest and part count, whatever this cell's feed holds.
  const imported = await admit(empty.spaceId, 'import', { watermark: 999999 });
  assert.equal(imported.part_count, 2);
  await assert.rejects(admit(spaceId, 'import', { manifest_sha256: null }), check('portability_jobs_manifest'));
  await assert.rejects(admit(spaceId, 'export', { watermark: positions[0], part_count: 1, manifest_sha256: digest('m') }),
    check('portability_jobs_manifest'));
  await assert.rejects(admit(spaceId, 'export', { job_id: `imp_${randomUUID()}`, watermark: positions[0] }), check('portability_jobs_id'));
  await assert.rejects(admit(spaceId, 'export', { watermark: positions[0], state: 'running', lease_id: 'l',
    leased_until: new Date(Date.now() + 60_000) }), check('portability_jobs_transition'));
  await assert.rejects(admit(spaceId, 'export', { watermark: positions[0], checkpoint: {} }), check('portability_jobs_transition'));

  const archived = await space({ lifecycle: 'readOnly' });
  await admit(archived.spaceId, 'export', { watermark: archived.positions[0] });
  await assert.rejects(admit(archived.spaceId, 'import'), check('portability_jobs_admission'));
  for (const lifecycle of ['suspended', 'deleting']) {
    const unavailable = await space({ lifecycle });
    await assert.rejects(admit(unavailable.spaceId, 'export', { watermark: unavailable.positions[0] }), check('portability_jobs_admission'), lifecycle);
  }
  await assert.rejects(pool.query(`INSERT INTO portability_jobs(space_id,job_id,kind,principal_id,credential_id,policy_version,
    placement_generation,format_version,watermark,expires_at) VALUES($1,$2,'export','owner','c',1,1,1,0,clock_timestamp()+interval '1 hour')`,
  [`sp_${randomUUID()}`, `exp_${randomUUID()}`]), check('portability_jobs_admission'));
});

test('a portability job keeps its binding, moves forward only, and completes with every part before it expires', async () => {
  const { spaceId, positions } = await space();
  const job = await admit(spaceId, 'export', { watermark: positions[0] });
  await assert.rejects(update(job, `watermark=0`), check('portability_jobs_binding'));
  await assert.rejects(update(job, `expires_at=expires_at+interval '1 day'`), check('portability_jobs_binding'));
  await assert.rejects(update(job, `manifest_sha256=$3,part_count=0`, [digest('m')]), check('portability_jobs_binding'));
  await assert.rejects(update(job, `state='completed',manifest_sha256=$3,part_count=0`, [digest('m')]), check('portability_jobs_binding'));
  await assert.rejects(update(job, `state='completed'`), check('portability_jobs_transition'));
  await assert.rejects(update(job, `state='running'`), check('portability_jobs_lease'));
  await assert.rejects(update(job, `checkpoint='{"after":1}'`), check('portability_jobs_transition'));
  const running = await run(job);
  assert.ok(running.started_at && !running.finished_at);
  await update(job, `checkpoint='{"after":1}'`);
  await assert.rejects(update(job, `attempts=0`), check('portability_jobs_transition'));
  await part(job, 1);
  await part(job, 2);
  await assert.rejects(update(job, `state='completed'`), check('portability_jobs_parts'));
  await assert.rejects(update(job, `state='completed',part_count=2`), check('portability_jobs_manifest'));
  await assert.rejects(update(job, `state='completed',manifest_sha256=$3,part_count=1`, [digest('m')]), check('portability_jobs_parts'));
  const completed = await update(job, `state='completed',manifest_sha256=$3,part_count=2`, [digest('m')]);
  assert.deepEqual([completed.lease_id, completed.leased_until, Boolean(completed.finished_at)], [null, null, true]);
  await assert.rejects(update(job, `manifest_sha256=$3`, [digest('other')]), check('portability_jobs_binding'));
  await assert.rejects(update(job, `state='running',lease_id='l',leased_until=clock_timestamp()+interval '1 minute'`),
    check('portability_jobs_transition'));
  await assert.rejects(update(job, `state='expired'`), check('portability_jobs_expiry'));

  // An import completes once all of its manifest's parts are applied; a failure needs a code.
  const imported = await admit(spaceId, 'import');
  await run(imported);
  await part(imported, 1);
  await assert.rejects(update(imported, `state='completed'`), check('portability_jobs_parts'));
  await assert.rejects(update(imported, `state='failed'`), check('portability_jobs_failure'));
  await update(imported, `state='cancelled'`);

  // Expiry: nothing runs or completes once it has passed, and only then does a job expire.
  const brief = await admit(spaceId, 'export', { watermark: positions[0], expires_at: new Date(Date.now() + 300) });
  await assert.rejects(update(brief, `state='expired'`), check('portability_jobs_expiry'));
  await sleep(400);
  await assert.rejects(run(brief), check('portability_jobs_expiry'));
  assert.equal((await update(brief, `state='expired'`)).state, 'expired');
});

test('parts are written in order by their running job under its lease, are checked and immutable, and only an ended export\'s are removed', async () => {
  const { spaceId, positions } = await space();
  const job = await admit(spaceId, 'export', { watermark: positions[0] });
  await assert.rejects(part(job, 1), check('portability_parts_job'));
  await run(job);
  await assert.rejects(part(job, 2), check('portability_parts_order'));
  await part(job, 1);
  await assert.rejects(part(job, 1), refused('23505'));
  const wrongDigest = (overrides) => pool.query(`INSERT INTO portability_parts(space_id,job_id,kind,part_number,section,row_count,byte_size,
    content_sha256,content) VALUES($1,$2,$3,2,$4,1,$5,$6,$7)`, [spaceId, job.job_id, overrides.kind ?? 'export', overrides.section ?? 'records',
    overrides.size ?? 2, overrides.sha ?? digest('ab'), 'content' in overrides ? overrides.content : 'ab']);
  await assert.rejects(wrongDigest({ sha: digest('other') }), check('portability_parts_content'));
  await assert.rejects(wrongDigest({ size: 3 }), check('portability_parts_content'));
  await assert.rejects(wrongDigest({ content: null }), check('portability_parts_content'));
  await assert.rejects(wrongDigest({ section: 'Records' }), check('portability_parts_section_check'));
  await assert.rejects(wrongDigest({ kind: 'import', content: null }), refused('23503'));
  await assert.rejects(pool.query(`UPDATE portability_parts SET section='other' WHERE job_id=$1`, [job.job_id]), check('portability_parts_immutable'));
  await assert.rejects(pool.query('DELETE FROM portability_parts WHERE job_id=$1', [job.job_id]), check('portability_parts_kept'));
  // The erasing setting confers nothing on a writer that is not the purge routine's owner.
  const role = `sta69_writer_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    await pool.query(`GRANT SELECT, DELETE ON portability_parts TO ${role}; GRANT SELECT ON portability_jobs TO ${role}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('stateplane.erasing_space',$1,true)`, [spaceId]);
      await assert.rejects(client.query('DELETE FROM portability_parts WHERE job_id=$1', [job.job_id]), check('portability_parts_kept'));
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
  // A lapsed lease writes nothing.
  await update(job, `leased_until=clock_timestamp()+interval '200 milliseconds'`);
  await sleep(300);
  await assert.rejects(part(job, 2), check('portability_parts_job'));
  await update(job, `state='failed',failure_code='WORKER_LOST'`);
  assert.equal((await pool.query('DELETE FROM portability_parts WHERE job_id=$1', [job.job_id])).rowCount, 1);

  // An import's parts record what was applied: within its manifest's count, without content, kept after it ends.
  const imported = await admit(spaceId, 'import');
  await run(imported);
  await part(imported, 1);
  await assert.rejects(pool.query(`INSERT INTO portability_parts(space_id,job_id,kind,part_number,section,row_count,byte_size,content_sha256,content)
    VALUES($1,$2,'import',2,'records',1,1,$3,'x')`, [spaceId, imported.job_id, digest('x')]), check('portability_parts_content'));
  await part(imported, 2);
  await assert.rejects(part(imported, 3), check('portability_parts_order'));
  await update(imported, `state='failed',failure_code='CONFLICT'`);
  await assert.rejects(pool.query('DELETE FROM portability_parts WHERE job_id=$1', [imported.job_id]), check('portability_parts_kept'));
});

/** Wait until the session behind `client` waits for a lock. */
async function waiting(client) {
  const pid = client.processID;
  for (let attempt = 0; ; attempt += 1) {
    const { rows } = await pool.query(`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`, [pid]);
    if (rows[0]?.waiting) return;
    assert.ok(attempt < 500, `session ${pid} never waited for a lock`);
    await sleep(10);
  }
}

test('a part write and its job\'s completion take turns: completion counts a part in flight, and no part follows completion', async () => {
  const { spaceId, positions } = await space();
  const [writer, completer] = [await pool.connect(), await pool.connect()];
  try {
    const job = await admit(spaceId, 'export', { watermark: positions[0] });
    await run(job);
    await part(job, 1);
    // A second part in flight holds the job row; a completion stating one part waits, then counts two and is refused.
    await writer.query('BEGIN');
    await part(job, 2, undefined, writer);
    await completer.query('BEGIN');
    const completing = completer.query(`UPDATE portability_jobs SET state='completed',manifest_sha256=$3,part_count=1
      WHERE space_id=$1 AND job_id=$2`, [spaceId, job.job_id, digest('m')]).then(() => 'completed', error => error);
    await waiting(completer);
    await writer.query('COMMIT');
    const outcome = await completing;
    await completer.query('ROLLBACK');
    assert.ok(outcome instanceof Error && outcome.constraint === 'portability_jobs_parts', String(outcome));
    // A completion in flight, then a part: the part waits and is refused once the job has completed.
    await completer.query('BEGIN');
    await completer.query(`UPDATE portability_jobs SET state='completed',manifest_sha256=$3,part_count=2
      WHERE space_id=$1 AND job_id=$2`, [spaceId, job.job_id, digest('m')]);
    const late = part(job, 3, undefined, writer).then(() => 'written', error => error);
    await waiting(writer);
    await completer.query('COMMIT');
    const refusal = await late;
    assert.ok(refusal instanceof Error && refusal.constraint === 'portability_parts_job', String(refusal));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM portability_parts WHERE job_id=$1', [job.job_id])).rows[0].n, 2);
  } finally {
    writer.release();
    completer.release();
  }
});

test('an import maps its source owner to the importing owner and each grant holder once to a live reissued credential', async () => {
  const { spaceId, positions } = await space();
  const job = await admit(spaceId, 'import');
  await assert.rejects(map(job, 'src_owner', 'owner', 'agent'), check('portability_principal_map_target'));
  await assert.rejects(map(job, 'src_owner', 'owner', null), check('portability_principal_map_target'));
  const ownerRow = await map(job, 'src_owner', 'owner', 'owner');
  assert.ok(ownerRow.mapped_at);
  await assert.rejects(map(job, 'src_owner_2', 'owner', 'owner'), refused('23505', 'portability_principal_map_owner'));
  const holder = await map(job, 'src_agent', 'agent', null);
  assert.equal(holder.mapped_at, null);
  await assert.rejects(map(job, 'src_half', 'agent', 'agent'), check('portability_principal_map_target'));
  await assert.rejects(map(job, 'src_wrong', 'agent', 'someone', 'cred_agent'), check('portability_principal_map_target'));
  await assert.rejects(map(job, 'src_pending', 'agent', 'pending', 'cred_pending'), check('portability_principal_map_target'));
  await assert.rejects(map(job, 'src_missing', 'agent', 'agent', 'cred_missing'), check('portability_principal_map_target'));
  await run(job);
  const setTarget = (source, principal, credential) => pool.query(`UPDATE portability_principal_map SET target_principal_id=$3,
    target_credential_id=$4 WHERE job_id=$1 AND source_principal_id=$2 RETURNING *`, [job.job_id, source, principal, credential])
    .then(result => result.rows[0]);
  const mapped = await setTarget('src_agent', 'agent', 'cred_agent');
  assert.ok(mapped.mapped_at);
  await assert.rejects(map(job, 'src_agent_2', 'agent', 'agent', 'cred_agent'), refused('23505', 'portability_principal_map_credential'));
  await assert.rejects(setTarget('src_agent', 'pending', 'cred_pending'), check('portability_principal_map_immutable'));
  await assert.rejects(pool.query(`UPDATE portability_principal_map SET role='agent' WHERE job_id=$1 AND source_principal_id='src_owner'`,
    [job.job_id]), check('portability_principal_map_immutable'));
  await assert.rejects(pool.query('DELETE FROM portability_principal_map WHERE job_id=$1', [job.job_id]), check('portability_principal_map_immutable'));
  // A revoked credential is never a target.
  await map(job, 'src_late', 'agent', null);
  await pool.query(`UPDATE space_credentials SET revoked_at=clock_timestamp() WHERE space_id=$1 AND credential_id='cred_pending'`, [spaceId]);
  await pool.query(`UPDATE space_credentials SET confirmed_at=clock_timestamp() WHERE space_id=$1 AND credential_id='cred_pending'`, [spaceId]);
  await assert.rejects(setTarget('src_late', 'pending', 'cred_pending'), check('portability_principal_map_target'));
  // Mappings belong to a queued or running import only.
  await update(job, `state='cancelled'`);
  await assert.rejects(map(job, 'src_after', 'agent', null), check('portability_principal_map_job'));
  await assert.rejects(setTarget('src_late', 'agent', 'cred_agent'), check('portability_principal_map_job'));
  const exported = await admit(spaceId, 'export', { watermark: positions[0] });
  await assert.rejects(pool.query(`INSERT INTO portability_principal_map(space_id,job_id,kind,source_principal_id,role,target_principal_id)
    VALUES($1,$2,'export','src','owner','owner')`, [spaceId, exported.job_id]), check('portability_principal_map_kind_check'));
  await assert.rejects(map(exported, 'src', 'owner', 'owner'), refused('23503'));
});

test('space erasure removes every portability row of that space only, and the erasure report waits for any it misses', async () => {
  const fill = async spaceId => {
    const exported = await admit(spaceId, 'export', { watermark: (await pool.query('SELECT max(position) AS p FROM record_event_feed WHERE space_id=$1',
      [spaceId])).rows[0].p });
    await run(exported);
    await part(exported, 1);
    const imported = await admit(spaceId, 'import');
    await run(imported);
    await part(imported, 1);
    await map(imported, 'src_owner', 'owner', 'owner');
    await map(imported, 'src_agent', 'agent', 'agent', 'cred_agent');
  };
  const erased = await space();
  const kept = await space();
  await fill(erased.spaceId);
  await fill(kept.spaceId);
  const keptBefore = await counts(kept.spaceId);
  assert.deepEqual(keptBefore, { portability_jobs: 2, portability_parts: 2, portability_principal_map: 2 });
  await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [erased.spaceId]);
  await pool.query('SELECT stateplane_purge_space($1)', [erased.spaceId]);
  assert.deepEqual(await counts(erased.spaceId), { portability_jobs: 0, portability_parts: 0, portability_principal_map: 0 });
  assert.deepEqual(await counts(kept.spaceId), keptBefore);

  const actor = await owner();
  const spaces = spacesFor(pool, pool);
  const { spaceId } = await spaces.create(actor);
  await spaces.archive(actor, spaceId);
  await spaces.delete(actor, spaceId);
  assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
  for (const table of portabilityTables) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('session_replication_role','replica',true)");
      await client.query(table === 'portability_jobs'
        ? `INSERT INTO portability_jobs(space_id,job_id,kind,principal_id,credential_id,policy_version,placement_generation,format_version,
          watermark,expires_at) VALUES($1,'exp_00000000-0000-4000-8000-000000000000','export','o','c',1,1,1,0,clock_timestamp()+interval '1 hour')`
        : table === 'portability_parts'
          ? `INSERT INTO portability_parts(space_id,job_id,kind,part_number,section,row_count,byte_size,content_sha256)
            VALUES($1,'imp_x','import',1,'records',0,0,repeat('0',64))`
          : `INSERT INTO portability_principal_map(space_id,job_id,source_principal_id,role,target_principal_id,mapped_at)
            VALUES($1,'imp_x','s','owner','o',clock_timestamp())`, [spaceId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'pending', table);
    await spaces.repairDeletedErasure(actor, spaceId);
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased', table);
  }
});

test('the portability and control grants give operational roles only what their writers and the erasure proof need', async () => {
  const role = `sta69_ops_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    const env = { ...process.env, STATEPLANE_CELL_ADMIN_URL: urlFor(db.main), STATEPLANE_CELL_ROLE: role,
      STATEPLANE_CONTROL_URL: urlFor(db.main), STATEPLANE_CONTROL_ROLE: role };
    execFileSync(process.execPath, ['scripts/grant-portability.mjs'], { cwd: root, stdio: 'pipe', env });
    execFileSync(process.execPath, ['scripts/grant-control-journal.mjs'], { cwd: root, stdio: 'pipe', env });
    const tables = [...portabilityTables, 'erasure_ledger'];
    const privileges = Object.fromEntries((await pool.query(`SELECT t, has_table_privilege($1,t,'SELECT') AS r,
        has_table_privilege($1,t,'INSERT') AS i, has_table_privilege($1,t,'UPDATE') AS u, has_table_privilege($1,t,'DELETE') AS d,
        has_table_privilege($1,t,'TRUNCATE') AS x FROM unnest($2::text[]) t`, [role, tables])).rows
      .map(({ t, ...row }) => [t, Object.entries(row).filter(([, granted]) => granted).map(([privilege]) => privilege).join('')]));
    assert.deepEqual(privileges, { portability_jobs: 'riu', portability_parts: 'rid', portability_principal_map: 'riu', erasure_ledger: 'ri' });
    const missing = spawnSync(process.execPath, ['scripts/grant-portability.mjs'], { cwd: root, encoding: 'utf8',
      env: { ...env, STATEPLANE_CELL_ROLE: `${role}_absent` } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cell operational role does not exist/);
  } finally {
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

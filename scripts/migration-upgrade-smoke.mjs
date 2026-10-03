import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { backfillDirectory } from './backfill-directory-core.mjs';

const authorityModule = new URL('../packages/postgres/dist/index.js',import.meta.url);
if (!existsSync(authorityModule)) throw new Error('Build @stateplane/postgres before db:upgrade-smoke: pnpm --filter @stateplane/postgres build');
const { PostgresRoutingDirectory, PostgresSpaces } = await import(authorityModule.href);

if (process.env.DATABASE_URL) throw new Error('Upgrade smoke uses the isolated local Postgres database only');
const password = (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT || '55432'}/stateplane`;
const names = ['upgrade','fresh'].map(kind => `stateplane_${kind}_${randomBytes(4).toString('hex')}`);
const marker = new URL(`../.data/migration-upgrade-${process.pid}-${randomBytes(6).toString('hex')}.json`,import.meta.url);
const url = name => baseUrl.replace(/\/stateplane$/, `/${name}`);
const admin = new pg.Client({ connectionString:baseUrl });
const created = [];
const dropDatabase = async name => {
  if (!/^stateplane_(upgrade|fresh)_[0-9a-f]{8}$/.test(name)) throw new Error('Invalid upgrade smoke database name');
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
};
const recoverInterrupted = async () => {
  const directory=new URL('../.data/',import.meta.url);
  for (const filename of await readdir(directory)) {
    if (!/^migration-upgrade-\d+-[0-9a-f]{12}\.json$/.test(filename)) continue;
    const path=new URL(filename,directory);
    const entry=JSON.parse(await readFile(path,'utf8'));
    if (!Number.isSafeInteger(entry.pid) || !Array.isArray(entry.names) ||
      !entry.names.every(name=>/^stateplane_(upgrade|fresh)_[0-9a-f]{8}$/.test(name))) throw new Error(`Invalid upgrade cleanup marker: ${filename}`);
    try { process.kill(entry.pid,0); continue; }
    catch (error) { if (error.code!=='ESRCH') throw error; }
    for (const name of [...entry.names].reverse()) await dropDatabase(name);
    await unlink(path);
  }
};
const migration = async name => readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const runMigrator = (name, drained=false) => execFileSync(process.execPath,['scripts/migrate.mjs'],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,DATABASE_URL:url(name),
    ...(drained ? {STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'} : {})},encoding:'utf8'
});
const assertOnlineRefusal = name => {
  const refusal=spawnSync(process.execPath,['scripts/migrate.mjs'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,DATABASE_URL:url(name),
      STATEPLANE_POPULATED_INDEX_UPGRADE:''},encoding:'utf8'
  });
  assert.equal(refusal.status,1);
  assert.match(refusal.stderr,/Populated outbox index upgrade requires drained traffic/);
};
const index = async client => (await client.query(`SELECT indexdef FROM pg_indexes
  WHERE tablename='projection_outbox' AND indexname='projection_outbox_claim'`)).rows[0].indexdef;
const preservedTables = ['spaces','collections','collection_versions','collection_grants',
  'collection_unique_declarations','collection_index_declarations','records','record_unique_keys',
  'record_index_values','record_events','idempotency_receipts','record_tombstones','projection_outbox',
  'entity_refs'];
const facts = async client => {
  const result={};
  for (const table of preservedTables) {
    result[table]=(await client.query(`SELECT row_to_json(t) AS fact FROM ${table} t ORDER BY row_to_json(t)::text`))
      .rows.map(row=>row.fact);
  }
  return result;
};
const constraints = async client => (await client.query(`SELECT conrelid::regclass::text AS relation,conname,contype,
  pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows;
const enforceUniqueRecord = async client => {
  await client.query('BEGIN');
  try {
    await assert.rejects(client.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,
      key_mode,normalized_key,canonical_data,data)
      VALUES('sp_upgrade','entries','rec_duplicate_probe',1,1,'generated','rec_1','{}','{}'::jsonb)`),
    error=>error.code==='23505');
  } finally { await client.query('ROLLBACK'); }
};
try {
  await admin.connect();
  await recoverInterrupted();
  await writeFile(marker,JSON.stringify({pid:process.pid,names}),{flag:'wx',mode:0o600});
  for (const name of names) { await admin.query(`CREATE DATABASE ${name}`); created.push(name); }
  const upgraded = new pg.Client({connectionString:url(names[0])});
  const fresh = new pg.Client({connectionString:url(names[1])});
  try {
    await upgraded.connect();
    await upgraded.query('BEGIN');
    await upgraded.query(`CREATE TABLE stateplane_migrations
      (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const name of ['001_foundation.sql','002_authority.sql','003_immutable_facts.sql','004_instant_order.sql']) {
      const sql=await migration(name);
      await upgraded.query(sql);
      await upgraded.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
        [name,createHash('sha256').update(sql).digest('hex')]);
    }
    await upgraded.query('COMMIT');
    await upgraded.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES('sp_upgrade','owner','cell-a','cell-a','target-a')`);
    await upgraded.query('BEGIN');
    await upgraded.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_upgrade','entries')`);
    await upgraded.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES('sp_upgrade','entries',1,'{}')`);
    await upgraded.query('COMMIT');
    await upgraded.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      SELECT 'sp_upgrade','entries','rec_'||n,1,1,'generated','rec_'||n,'{}','{}'::jsonb FROM generate_series(1,2000) n`);
    await upgraded.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
      SELECT 'evt_'||n,'sp_upgrade','entries','rec_'||n,1,'create','writer',1,'{}' FROM generate_series(1,2000) n`);
    await upgraded.query(`INSERT INTO projection_outbox(event_id,space_id,collection_id,record_id,revision,generation,delivery_state)
      SELECT 'evt_'||n,'sp_upgrade','entries','rec_'||n,1,1,
        CASE WHEN n % 2=0 THEN 'delivered' ELSE 'pending' END FROM generate_series(1,2000) n`);
    await upgraded.query(`INSERT INTO idempotency_receipts(receipt_id,space_id,collection_id,credential_id,operation,idempotency_key,request_digest,record_id,response,expires_at)
      SELECT 'rcpt_'||n,'sp_upgrade','entries','writer','create','key_'||n,repeat('a',64),'rec_'||n,'{}'::jsonb,
        clock_timestamp()+interval '1 hour' FROM generate_series(1,2000) n`);
    const before=await facts(upgraded);
    assertOnlineRefusal(names[0]);
    assert.deepEqual(await facts(upgraded),before);
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM stateplane_migrations')).rows[0].n,4);
    const sql005=await migration('005_scoped_query_indexes.sql');
    const started=performance.now();
    await upgraded.query('BEGIN');
    await upgraded.query(sql005);
    await upgraded.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
      ['005_scoped_query_indexes.sql',createHash('sha256').update(sql005).digest('hex')]);
    await upgraded.query('COMMIT');
    const build005Ms=Math.round(performance.now()-started);
    assertOnlineRefusal(names[0]);
    assert.deepEqual(await facts(upgraded),before);
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM stateplane_migrations')).rows[0].n,5);
    const secondStart=performance.now();
    const output=runMigrator(names[0],true);
    const buildRemainingMs=Math.round(performance.now()-secondStart);
    assert.match(output,/Applied 006_outbox_due_order.sql/);
    assert.match(output,/Applied 007_receipt_reservations.sql/);
    assert.match(output,/Applied 008_receipt_reservation_scopes.sql/);
    assert.match(output,/Applied 010_receipt_scope_probe_rollback.sql/);
    assert.match(output,/Applied 016_existing_space_directory.sql/);
    assert.match(output,/Applied 017_agent_key_issuances.sql/);
    assert.match(output,/Applied 018_agent_key_no_key_settlement.sql/);
    assert.match(output,/Applied 019_space_provisioning_recovery.sql/);
    assert.match(output,/Applied 020_immutable_space_audits.sql/);
    assert.match(output,/Applied 023_agent_key_completion_fence.sql/);
    assert.deepEqual(await facts(upgraded),before);
    const actor={kind:'session',userPrincipalId:'owner',credentialId:'upgrade-session'};
    const pool=new pg.Pool({connectionString:url(names[0])});
    try {
      const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
      const spaces=new PostgresSpaces(pool,cells,'cell-a',
        {create:async () => { throw new Error('unexpected provider create'); },
          find:async () => null,revoke:async () => {}},{current:async () => true});
      const directory=new PostgresRoutingDirectory(pool,cells);
      const listed=await spaces.list(actor);
      assert.deepEqual(listed.map(space=>space.spaceId),['sp_upgrade']);
      assert.deepEqual(await spaces.get(actor,'sp_upgrade'),listed[0]);
      assert.deepEqual(await directory.lookup('sp_upgrade'),{
        spaceId:'sp_upgrade',cellId:'cell-a',lifecycle:'active',policyVersion:1,placementGeneration:1});
      assert.equal(await directory.authorized(actor,'sp_upgrade','entries','records:read'),true);
    } finally { await pool.end(); }
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM receipt_reservations')).rows[0].n,0);
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM receipt_reservation_scopes')).rows[0].n,0);
    assert.match(await index(upgraded),/\(space_id, collection_id, available_at, event_id\)/);
    await upgraded.query('SET enable_seqscan=off');
    const plan=(await upgraded.query(`EXPLAIN SELECT event_id FROM projection_outbox
      WHERE space_id='sp_upgrade' AND collection_id='entries'
        AND delivery_state IN ('pending','delivering','degraded') AND available_at<=clock_timestamp()
      ORDER BY available_at,event_id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows.map(row=>row['QUERY PLAN']).join('\n');
    assert.match(plan,/Index Scan using projection_outbox_claim/);
    assert.doesNotMatch(plan,/\bSort\b/);
    runMigrator(names[1]);
    await fresh.connect();
    assert.equal(await index(upgraded),await index(fresh));
    assert.deepEqual(await constraints(upgraded),await constraints(fresh));
    await upgraded.query("UPDATE spaces SET created_at='2026-01-02 03:04:05.123456+00' WHERE space_id='sp_upgrade'");
    await assert.rejects(backfillDirectory(fresh,[{cellId:'cell-a',client:upgraded}],
      {expectedCellIds:['cell-a','cell-b'],drained:true}),/every configured cell/);
    await assert.rejects(backfillDirectory(fresh,[{cellId:'cell-a',client:upgraded}],
      {expectedCellIds:['cell-a'],drained:false}),/drained traffic/);
    const writer=new pg.Client({connectionString:url(names[0])});
    await writer.connect();
    let attempted=false;
    let writerSettled=false;
    let writerUpdate;
    try {
      await writer.query('BEGIN');
      const guardedControl={query:async (sql,...args) => {
        if (!attempted && sql.startsWith('SELECT * FROM space_directory')) {
          attempted=true;
          writerUpdate=writer.query("UPDATE spaces SET policy_version=policy_version+1 WHERE space_id='sp_upgrade'")
            .then(() => { writerSettled=true; });
          await new Promise(resolve=>setTimeout(resolve,60));
          assert.equal(writerSettled,false,'source writer waits for the backfill snapshot lock');
        }
        return fresh.query(sql,...args);
      }};
      assert.deepEqual(await backfillDirectory(guardedControl,[{cellId:'cell-a',client:upgraded}],
        {expectedCellIds:['cell-a'],drained:true}),{copied:1,existing:0});
      await writerUpdate;
    } finally {
      await writer.query('ROLLBACK').catch(()=>{});
      await writer.end();
    }
    assert.deepEqual(await backfillDirectory(fresh,[{cellId:'cell-a',client:upgraded}],{expectedCellIds:['cell-a'],drained:true}),{copied:0,existing:1});
    assert.equal((await fresh.query("SELECT created_at::text AS created_at FROM space_directory WHERE space_id='sp_upgrade'")).rows[0].created_at,
      (await upgraded.query("SELECT created_at::text AS created_at FROM spaces WHERE space_id='sp_upgrade'")).rows[0].created_at);
    const splitCells=new Map([['cell-a',{pool:upgraded,storageTargetId:'target-a'}]]);
    const splitSpaces=new PostgresSpaces(fresh,splitCells,'cell-a',
      {create:async () => { throw new Error('unexpected provider create'); },
        find:async () => null,revoke:async () => {}},{current:async () => true});
    assert.equal((await splitSpaces.get({kind:'session',userPrincipalId:'owner',credentialId:'upgrade-session'},
      'sp_upgrade')).spaceId,'sp_upgrade');
    assert.equal((await new PostgresRoutingDirectory(fresh,splitCells).lookup('sp_upgrade')).cellId,'cell-a');
    await enforceUniqueRecord(upgraded);
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM stateplane_migrations')).rows[0].n,24);
    assert.equal(runMigrator(names[0]),'');
    console.log(`Upgrade smoke passed: 2000 record/event/receipt/outbox rows and upgraded owner route preserved; final index matches fresh install; 005 build ${build005Ms}ms, 006-024 migrator ${buildRemainingMs}ms`);
  } finally { await Promise.allSettled([upgraded.end(),fresh.end()]); }
} finally {
  created.reverse();
  let cleaned=true;
  for (const name of created) await dropDatabase(name).catch(() => { cleaned=false; });
  if (cleaned) await unlink(marker).catch(() => {});
  await admin.end().catch(() => {});
}

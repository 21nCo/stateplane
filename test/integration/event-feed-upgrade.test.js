import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const cwd=fileURLToPath(new URL('../..',import.meta.url));
const password=process.env.DATABASE_URL ? null :
  (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const baseUrl=process.env.DATABASE_URL ??
  `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;

async function applyFixtureMigration(client,file,sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
      [file,createHash('sha256').update(sql).digest('hex')]);
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('populated event-feed upgrade refuses live traffic and replays after a drained window',async()=>{
  const name=`stateplane_sta9_event_${randomUUID().replaceAll('-','')}`;
  const url=new URL(baseUrl); url.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:baseUrl});
  let upgrade;let writer;let blocker;let reader;let migration;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    upgrade=new pg.Client({connectionString:url.href});
    await upgrade.connect();
    await upgrade.query(`CREATE TABLE stateplane_migrations(name text PRIMARY KEY,sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files=(await readdir(new URL('../../migrations/',import.meta.url)))
      .filter(file=>/^\d{3}_.*\.sql$/.test(file)).sort();
    for (const file of files.filter(file=>file<'033_')) {
      const sql=await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8');
      await applyFixtureMigration(upgrade,file,sql);
    }
    await upgrade.query("INSERT INTO stateplane_migrations(name,sha256) VALUES('fixture_failure.sql','prior')");
    await assert.rejects(applyFixtureMigration(upgrade,'fixture_failure.sql',
      'CREATE TABLE sta9_ledger_failure_probe(id integer)'),{code:'23505'});
    assert.equal((await upgrade.query("SELECT to_regclass('public.sta9_ledger_failure_probe') AS relation")).rows[0].relation,null);
    await upgrade.query("DELETE FROM stateplane_migrations WHERE name='fixture_failure.sql'");
    await upgrade.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES('sta9-event','owner','cell-a','cell-a','target-a')`);
    await upgrade.query('BEGIN');
    await upgrade.query(`INSERT INTO collections(space_id,collection_id)
      VALUES('sta9-event','entries')`);
    await upgrade.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES('sta9-event','entries',1,'{}')`);
    await upgrade.query('COMMIT');
    await upgrade.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,
      key_mode,normalized_key,canonical_data,data)
      VALUES('sta9-event','entries','record-1',1,1,'generated','record-1','{}','{}'::jsonb)`);
    await upgrade.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,
      operation,credential_id,schema_version,canonical_data)
      VALUES('event-1','sta9-event','entries','record-1',1,'create','agent',1,'{}')`);
    const env={...process.env,DATABASE_URL:url.href};
    const migrate=(drained)=>execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd,encoding:'utf8',timeout:15_000,
      env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:drained?'drained':''}});
    let refused;
    try { migrate(false); } catch(error) { refused=error; }
    assert.match(String(refused?.stderr),/Populated event feed upgrade requires drained traffic/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,0);

    // Revisit the older ledger prefix and pause at 033, after its transaction
    // split. A writer starting now must be rejected by the 036 preflight.
    await upgrade.query("DELETE FROM stateplane_migrations WHERE name>='033_'");
    blocker=new pg.Client({connectionString:url.href});
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE batch_items IN ACCESS EXCLUSIVE MODE');
    migration=spawn(process.execPath,['scripts/migrate.mjs'],{cwd,
      env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'},stdio:['ignore','pipe','pipe']});
    const migrationClosed=once(migration,'close');
    let migrationError='';
    migration.stderr.setEncoding('utf8');
    migration.stderr.on('data',chunk=>{migrationError+=chunk;});
    let reachedSplit=false;
    for (let attempt=0;attempt<100;attempt++) {
      const waiting=await upgrade.query(`SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%VALIDATE CONSTRAINT batch_items_attempts_nonnegative%'`);
      if (waiting.rowCount) {reachedSplit=true;break;}
      if (migration.exitCode!==null) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(reachedSplit,true,'migrator reached 033 after releasing its previous transaction');
    writer=new pg.Client({connectionString:url.href});
    await writer.connect();
    await writer.query('BEGIN');
    await writer.query("UPDATE records SET data=data WHERE space_id='sta9-event' AND record_id='record-1'");
    await blocker.query('ROLLBACK');
    const [splitStatus]=await migrationClosed;
    migration=undefined;
    assert.equal(splitStatus,1);
    assert.match(migrationError,/Event feed upgrade requires drained traffic/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,0);
    await writer.query('ROLLBACK');
    await writer.end();
    writer=undefined;

    writer=new pg.Client({connectionString:url.href});
    await writer.connect();
    await writer.query('BEGIN');
    await writer.query("UPDATE records SET data=data WHERE space_id='sta9-event' AND record_id='record-1'");
    let contention;
    try { migrate(true); } catch(error) { contention=error; }
    assert.match(String(contention?.stderr),/Event feed upgrade requires drained traffic/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,0);
    await writer.query('ROLLBACK');

    migrate(true);
    assert.deepEqual((await upgrade.query(`SELECT event_id FROM record_event_feed`)).rows,
      [{event_id:'event-1'}]);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,3);
    assert.equal((await upgrade.query("SELECT to_regclass('public.record_events_scoped_cursor') AS name")).rows[0].name,null);
    migrate(false);

    // Recreate only the unapplied drop step to exercise a long-lived reader.
    // The old migrator waited indefinitely at DROP INDEX while this lock lived.
    await upgrade.query("DELETE FROM stateplane_migrations WHERE name='038_drop_superseded_event_cursor.sql'");
    await upgrade.query(`CREATE INDEX record_events_scoped_cursor
      ON record_events(space_id,collection_id,committed_at,event_id)`);
    reader=new pg.Client({connectionString:url.href});
    await reader.connect();
    await reader.query('BEGIN');
    await reader.query('LOCK TABLE record_events IN ACCESS SHARE MODE');
    migration=spawn(process.execPath,['scripts/migrate.mjs'],{cwd,
      env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'},stdio:['ignore','pipe','pipe']});
    const dropClosed=once(migration,'close');
    let dropError='';
    migration.stderr.setEncoding('utf8');
    migration.stderr.on('data',chunk=>{dropError+=chunk;});
    let waitingOnDrop=false;
    for (let attempt=0;attempt<100;attempt++) {
      const waiting=await upgrade.query(`SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%DROP INDEX IF EXISTS record_events_scoped_cursor%'`);
      if (waiting.rowCount) {waitingOnDrop=true;break;}
      if (migration.exitCode!==null) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(waitingOnDrop,true,'index removal waits behind the active reader');
    assert.deepEqual((await upgrade.query('SELECT event_id FROM record_event_feed')).rows,[{event_id:'event-1'}]);
    const [dropStatus]=await dropClosed;
    migration=undefined;
    assert.equal(dropStatus,1);
    assert.match(dropError,/Event cursor index removal requires drained readers/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name='038_drop_superseded_event_cursor.sql'")).rows[0].n,0);
    assert.notEqual((await upgrade.query("SELECT to_regclass('public.record_events_scoped_cursor') AS name")).rows[0].name,null);
    await reader.query('ROLLBACK');
    await reader.end();
    reader=undefined;
    migrate(true);
    assert.equal((await upgrade.query("SELECT to_regclass('public.record_events_scoped_cursor') AS name")).rows[0].name,null);
  } finally {
    if (migration) {
      migration.kill('SIGTERM');
      if (migration.exitCode===null && migration.signalCode===null)
        await once(migration,'close').catch(()=>{});
    }
    await blocker?.query('ROLLBACK').catch(()=>{});
    await blocker?.end().catch(()=>{});
    await writer?.query('ROLLBACK').catch(()=>{});
    await writer?.end().catch(()=>{});
    await reader?.query('ROLLBACK').catch(()=>{});
    await reader?.end().catch(()=>{});
    await upgrade?.end().catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

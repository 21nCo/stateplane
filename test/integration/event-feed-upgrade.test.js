import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const cwd=fileURLToPath(new URL('../..',import.meta.url));
const password=process.env.DATABASE_URL ? null :
  (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const baseUrl=process.env.DATABASE_URL ??
  `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;

test('populated event-feed upgrade refuses live traffic and replays after a drained window',async()=>{
  const name=`stateplane_sta9_event_${randomUUID().replaceAll('-','')}`;
  const url=new URL(baseUrl); url.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:baseUrl});
  let upgrade;let writer;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    upgrade=new pg.Client({connectionString:url.href});
    await upgrade.connect();
    await upgrade.query(`CREATE TABLE stateplane_migrations(name text PRIMARY KEY,sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files=(await readdir(new URL('../../migrations/',import.meta.url)))
      .filter(file=>/^\d{3}_.*\.sql$/.test(file)).sort();
    for (const file of files.filter(file=>file<'036_')) {
      const sql=await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8');
      await upgrade.query(sql);
      await upgrade.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
        [file,createHash('sha256').update(sql).digest('hex')]);
    }
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
    const migrate=(drained)=>execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd,encoding:'utf8',
      env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:drained?'drained':''}});
    let refused;
    try { migrate(false); } catch(error) { refused=error; }
    assert.match(String(refused?.stderr),/Populated event feed upgrade requires drained traffic/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,0);

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
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name>='036_'")).rows[0].n,2);
    migrate(false);
  } finally {
    await writer?.query('ROLLBACK').catch(()=>{});
    await writer?.end().catch(()=>{});
    await upgrade?.end().catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../..',import.meta.url));
const password=process.env.DATABASE_URL?null:
  (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const baseUrl=process.env.DATABASE_URL??
  `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;

function scannedRows(plan,relation) {
  return (plan['Relation Name']===relation ? plan['Actual Rows']*plan['Actual Loops'] : 0)+
    (plan.Plans??[]).reduce((sum,child)=>sum+scannedRows(child,relation),0);
}

test('quiet event tails use bounded pending discovery and a separate runtime role can publish',async()=>{
  const suffix=randomUUID().replaceAll('-','');
  const name=`sta9_event_${suffix}`;
  const role=`sta9_event_${suffix}`;
  const url=new URL(baseUrl);url.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:baseUrl});
  let db;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN`);
    await admin.query(`CREATE DATABASE ${name}`);
    execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:root,timeout:30_000,
      env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
    db=new pg.Client({connectionString:url.href});await db.connect();
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES('sp_event','owner','cell-a','cell-a','target-a')`);
    await db.query('BEGIN');
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_event','entries')`);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES('sp_event','entries',1,'{}')`);
    await db.query('COMMIT');
    await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,
      key_mode,normalized_key,canonical_data,data)
      SELECT 'sp_event','entries','rec-'||n,1,1,'generated','rec-'||n,'{}','{}'::jsonb
      FROM generate_series(1,2000) n`);
    await db.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,
      operation,credential_id,schema_version,canonical_data)
      SELECT 'evt-'||n,'sp_event','entries','rec-'||n,1,'create','writer',1,'{}'
      FROM generate_series(1,2000) n`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM record_event_pending')).rows[0].n,2000);
    await db.query(`INSERT INTO record_event_feed(event_id,space_id,collection_id)
      SELECT event_id,space_id,collection_id FROM record_events ORDER BY committed_at,event_id`);
    await db.query('DELETE FROM record_event_pending');
    const oldPlan=(await db.query(`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT e.event_id FROM record_events e LEFT JOIN record_event_feed f ON f.event_id=e.event_id
      WHERE e.space_id='sp_event' AND e.collection_id='entries' AND f.event_id IS NULL
      ORDER BY e.committed_at,e.event_id LIMIT 101`)).rows[0]['QUERY PLAN'][0].Plan;
    const newPlan=(await db.query(`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT event_id FROM record_event_pending WHERE space_id='sp_event' AND collection_id='entries'
      ORDER BY committed_at,event_id LIMIT 101`)).rows[0]['QUERY PLAN'][0].Plan;
    assert.ok(scannedRows(oldPlan,'record_events')>=2000,'old quiet poll inspected retained history');
    assert.equal(scannedRows(newPlan,'record_events'),0);
    assert.equal(scannedRows(newPlan,'record_event_pending'),0,'caught-up index reads no pending rows');

    await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await db.query(`GRANT SELECT, INSERT ON TABLE record_events TO ${role}`);
    execFileSync(process.execPath,['scripts/grant-event-feed.mjs'],{cwd:root,timeout:10_000,
      env:{...process.env,STATEPLANE_CELL_ADMIN_URL:url.href,STATEPLANE_CELL_ROLE:role},stdio:'pipe'});
    await db.query(`SET ROLE ${role}`);
    await db.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,
      operation,credential_id,schema_version,canonical_data)
      VALUES('evt-runtime','sp_event','entries','rec-1',2,'replace','writer',1,'{}')`);
    const published=await db.query(`WITH next AS (
        SELECT event_id,space_id,collection_id FROM record_event_pending
        WHERE space_id='sp_event' AND collection_id='entries'
        ORDER BY committed_at,event_id LIMIT 101
      ), published AS (
        INSERT INTO record_event_feed(event_id,space_id,collection_id)
        SELECT event_id,space_id,collection_id FROM next
        ON CONFLICT DO NOTHING RETURNING event_id
      ) DELETE FROM record_event_pending p USING published f WHERE p.event_id=f.event_id`);
    assert.equal(published.rowCount,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM record_event_feed WHERE event_id='evt-runtime'")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM record_event_pending WHERE event_id='evt-runtime'")).rows[0].n,0);
    await db.query('RESET ROLE');
  } finally {
    await db?.query('RESET ROLE').catch(()=>{});
    await db?.end().catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(()=>{});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(()=>{});
    await admin.end();
  }
});

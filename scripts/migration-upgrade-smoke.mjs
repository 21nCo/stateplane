import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (process.env.DATABASE_URL) throw new Error('Upgrade smoke uses the isolated local Postgres database only');
const password = (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
const names = ['upgrade','fresh'].map(kind => `stateplane_${kind}_${randomBytes(4).toString('hex')}`);
const url = name => baseUrl.replace(/\/stateplane$/, `/${name}`);
const admin = new pg.Client({ connectionString:baseUrl });
const created = [];
const migration = async name => readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const runMigrator = name => execFileSync(process.execPath,['scripts/migrate.mjs'],{
  cwd:new URL('..',import.meta.url), env:{...process.env,DATABASE_URL:url(name)},encoding:'utf8'
});
const index = async client => (await client.query(`SELECT indexdef FROM pg_indexes
  WHERE tablename='projection_outbox' AND indexname='projection_outbox_claim'`)).rows[0].indexdef;
const facts = async client => (await client.query(`SELECT
  (SELECT count(*)::int FROM records) AS records,
  (SELECT count(*)::int FROM record_events) AS events,
  (SELECT count(*)::int FROM idempotency_receipts) AS receipts,
  (SELECT count(*)::int FROM projection_outbox) AS outbox,
  (SELECT md5(string_agg(record_id || ':' || revision::text || ':' || canonical_data, ',' ORDER BY record_id)) FROM records) AS records_hash,
  (SELECT md5(string_agg(event_id || ':' || record_id || ':' || revision::text, ',' ORDER BY event_id)) FROM record_events) AS events_hash,
  (SELECT md5(string_agg(receipt_id || ':' || record_id || ':' || request_digest, ',' ORDER BY receipt_id)) FROM idempotency_receipts) AS receipts_hash,
  (SELECT md5(string_agg(event_id || ':' || delivery_state || ':' || attempts::text || ':' || available_at::text,
    ',' ORDER BY event_id)) FROM projection_outbox) AS outbox_hash`)).rows[0];
try {
  await admin.connect();
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
    const sql005=await migration('005_scoped_query_indexes.sql');
    const started=performance.now();
    await upgraded.query('BEGIN');
    await upgraded.query(sql005);
    await upgraded.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
      ['005_scoped_query_indexes.sql',createHash('sha256').update(sql005).digest('hex')]);
    await upgraded.query('COMMIT');
    const build005Ms=Math.round(performance.now()-started);
    const secondStart=performance.now();
    const output=runMigrator(names[0]);
    const build006And007Ms=Math.round(performance.now()-secondStart);
    assert.match(output,/Applied 006_outbox_due_order.sql/);
    assert.match(output,/Applied 007_receipt_reservations.sql/);
    assert.deepEqual(await facts(upgraded),before);
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM receipt_reservations')).rows[0].n,0);
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
    assert.equal((await upgraded.query('SELECT count(*)::int AS n FROM stateplane_migrations')).rows[0].n,7);
    assert.equal(runMigrator(names[0]),'');
    console.log(`Upgrade smoke passed: 2000 records/events/receipts/outbox rows preserved; final index matches fresh install; 005 build ${build005Ms}ms, 006-007 migrator ${build006And007Ms}ms`);
  } finally { await Promise.allSettled([upgraded.end(),fresh.end()]); }
} finally {
  for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name}`).catch(() => {});
  await admin.end().catch(() => {});
}

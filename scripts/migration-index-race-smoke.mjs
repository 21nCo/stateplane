import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrationInventory } from './migration-order.mjs';

if (process.env.DATABASE_URL) throw new Error('Index race smoke uses the isolated local Postgres database only');
const root = resolve(import.meta.dirname, '..');
const password = (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT || '55432'}/stateplane`;
const admin = new pg.Client({ connectionString: baseUrl });
const cases = process.argv.includes('--single')
  ? [[4, 'commit']]
  : [[4, 'commit'], [4, 'rollback'], [5, 'commit'], [5, 'rollback'],
    [4, 'timeout'], [4, 'interrupt'], [4, 'empty']];
const migrationNames = [
  '001_foundation.sql', '002_authority.sql', '003_immutable_facts.sql',
  '004_instant_order.sql', '005_scoped_query_indexes.sql'
];
const completeMigrationCount = (await migrationInventory(resolve(root,'migrations'))).length;
const markerDirectory = new URL('../.data/', import.meta.url);
const raceDatabase = /^stateplane_race_[0-9a-f]{8}$/;

async function dropDatabase(name) {
  if (!raceDatabase.test(name)) throw new Error('Invalid index race database name');
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

async function recoverInterrupted() {
  for (const filename of await readdir(markerDirectory)) {
    if (!/^migration-index-race-stateplane_race_[0-9a-f]{8}\.json$/.test(filename)) continue;
    const marker = new URL(filename, markerDirectory);
    const entry = JSON.parse(await readFile(marker, 'utf8'));
    if (!raceDatabase.test(entry.name) || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 ||
      filename !== `migration-index-race-${entry.name}.json`) {
      throw new Error(`Invalid index race cleanup marker: ${filename}`);
    }
    try { process.kill(entry.pid, 0); continue; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await dropDatabase(entry.name);
    await unlink(marker);
  }
}

function databaseUrl(name, app) {
  return baseUrl.replace(/\/stateplane$/, `/${name}?application_name=${app}`);
}

async function prepare(client, prefix) {
  await client.query('BEGIN');
  await client.query(`CREATE TABLE stateplane_migrations
    (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const name of migrationNames.slice(0, prefix)) {
    const sql = await readFile(resolve(root, 'migrations', name), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
      [name, createHash('sha256').update(sql).digest('hex')]);
  }
  await client.query('COMMIT');
  await client.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES('sp_race','owner','cell-a','cell-a','target-a')`);
  await client.query('BEGIN');
  await client.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_race','entries')`);
  await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
    VALUES('sp_race','entries',1,'{}')`);
  await client.query('COMMIT');
  await client.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT 'sp_race','entries','rec_'||n,1,1,'generated','rec_'||n,'{}','{}'::jsonb
    FROM generate_series(1,2000) n`);
  await client.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
    SELECT 'evt_'||n,'sp_race','entries','rec_'||n,1,'create','writer',1,'{}'
    FROM generate_series(1,2000) n`);
}

function startMigrator(url, drained = false) {
  const child = spawn(process.execPath, ['scripts/migrate.mjs'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url,
      STATEPLANE_POPULATED_INDEX_UPGRADE: drained ? 'drained' : '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let finished = false;
  const result = new Promise((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('close', (code, signal) => {
      finished = true;
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  return { child, result, isFinished: () => finished };
}

async function boundedResult(run) {
  let timer;
  try {
    return await Promise.race([run.result,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Migrator timed out')), 30000);
      })]);
  } finally {
    clearTimeout(timer);
  }
}

async function facts(client) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM records) AS records,
    (SELECT count(*)::int FROM record_events) AS events,
    (SELECT count(*)::int FROM projection_outbox) AS outbox,
    (SELECT md5(coalesce(string_agg(event_id, ',' ORDER BY event_id), '')) FROM projection_outbox) AS outbox_hash`);
  return rows[0];
}

async function migrationLedger(client) {
  return (await client.query('SELECT name,sha256 FROM stateplane_migrations ORDER BY name')).rows;
}

async function claimIndex(client) {
  return (await client.query(`SELECT indexdef FROM pg_indexes
    WHERE tablename='projection_outbox' AND indexname='projection_outbox_claim'`)).rows[0]?.indexdef ?? null;
}

async function waitForLock(app, run) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (run.isFinished()) throw new Error(`Migrator exited before writer release: ${JSON.stringify(await run.result)}`);
    const { rows } = await admin.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity
      WHERE application_name=$1 AND datname<>current_database()`, [app]);
    if (rows.some(row => row.wait_event_type === 'Lock')) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
  }
  throw new Error('Migrator did not reach a relation lock wait');
}

async function assertOutcome({ action, prefix, result, client, writer, name, beforeLedger, beforeIndex }) {
  if (action === 'timeout') {
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.match(result.stderr, /canceling statement due to lock timeout/);
  }
  if (action === 'timeout' || action === 'interrupt') await writer.query('ROLLBACK');
  const after = await facts(client);
  const afterLedger = await migrationLedger(client);
  if (action === 'commit') {
    assert.equal(result.code, 1, `Unflagged migration crossed a committed writer: ${JSON.stringify(result)}`);
    assert.match(result.stderr, /Populated outbox index upgrade requires drained traffic/);
    assert.deepEqual(afterLedger, beforeLedger);
    assert.equal(after.records, 2000);
    assert.equal(after.events, 2000);
    assert.equal(after.outbox, 2000);
    assert.match(after.outbox_hash, /^[0-9a-f]{32}$/);
    assert.equal(await claimIndex(client), beforeIndex);
    const drained = startMigrator(databaseUrl(name, 'sta5_race_drained'), true);
    const retry = await boundedResult(drained);
    assert.equal(retry.code, 0, JSON.stringify(retry));
    assert.deepEqual(await facts(client), after);
    assert.equal((await migrationLedger(client)).length, completeMigrationCount);
  } else {
    if (action === 'rollback' || action === 'empty') {
      // The outbox preflight passed after the writer rolled back (or with an
      // empty outbox). The later 031 preflight independently requires drained
      // traffic while the seeded records remain populated.
      assert.equal(result.code, 1, JSON.stringify(result));
      assert.match(result.stderr, /Populated projection upgrade requires drained traffic/);
    }
    assert.deepEqual(afterLedger, beforeLedger);
    assert.equal(after.outbox, 0);
    const retry = startMigrator(databaseUrl(name, 'sta5_race_retry'), true);
    assert.equal((await boundedResult(retry)).code, 0);
    assert.equal((await migrationLedger(client)).length, completeMigrationCount);
  }
  assert.match(await claimIndex(client), /\(space_id, collection_id, available_at, event_id\)/);
  const migrations = action === 'commit' ? `${prefix} then ${completeMigrationCount}` : String(completeMigrationCount);
  console.log(`Index race ${prefix}/${action} passed: outbox=${after.outbox}, migrations=${migrations}`);
}

async function runCase(prefix, action) {
  const name = `stateplane_race_${randomBytes(4).toString('hex')}`;
  const app = `sta5_race_${name.slice(-8)}`;
  const marker = new URL(`migration-index-race-${name}.json`, markerDirectory);
  const client = new pg.Client({ connectionString: databaseUrl(name, `${app}_setup`) });
  const writer = new pg.Client({ connectionString: databaseUrl(name, `${app}_writer`) });
  let run;
  let markerCreated = false;
  try {
    await writeFile(marker, JSON.stringify({ pid: process.pid, name }), { flag: 'wx', mode: 0o600 });
    markerCreated = true;
    await admin.query(`CREATE DATABASE ${name}`);
    if (process.env.STATEPLANE_TEST_CRASH_AFTER_CREATE === '1') process.kill(process.pid, 'SIGKILL');
    await Promise.all([client.connect(), writer.connect()]);
    await prepare(client, prefix);
    const beforeLedger = await migrationLedger(client);
    const beforeIndex = await claimIndex(client);
    if (action !== 'empty') {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO projection_outbox(event_id,space_id,collection_id,record_id,revision,generation,delivery_state)
        SELECT 'evt_'||n,'sp_race','entries','rec_'||n,1,1,'pending'
        FROM generate_series(1,2000) n`);
    }
    run = startMigrator(databaseUrl(name, app));
    if (action !== 'empty') {
      await waitForLock(app, run);
      if (action === 'interrupt') {
        run.child.kill('SIGKILL');
        assert.equal((await boundedResult(run)).signal, 'SIGKILL');
      } else if (action !== 'timeout') {
        await writer.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      }
    }
    const result = await boundedResult(run);
    await assertOutcome({ action, prefix, result, client, writer, name, beforeLedger, beforeIndex });
  } finally {
    if (run && !run.isFinished()) run.child.kill('SIGKILL');
    await writer.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([client.end(), writer.end()]);
    if (markerCreated) {
      await dropDatabase(name);
      await unlink(marker);
    }
  }
}

try {
  await admin.connect();
  await recoverInterrupted();
  if (!process.argv.includes('--recover-only')) {
    for (const [prefix, action] of cases) await runCase(prefix, action);
  }
} finally {
  await admin.end().catch(() => {});
}

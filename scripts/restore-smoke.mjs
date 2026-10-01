import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (process.env.DATABASE_URL) throw new Error('Local restore smoke uses the isolated Docker Compose database only');
const password = (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const root = fileURLToPath(new URL('..', import.meta.url));
const name = `stateplane_restore_${randomBytes(4).toString('hex')}`;
const docker = args => execFileSync('docker', ['compose','exec','-T','postgres',...args], { cwd:root, maxBuffer:64 * 1024 * 1024 });
const base = new pg.Pool({ connectionString:`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane` });
const restored = new pg.Pool({ connectionString:`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/${name}` });
const tables = ['stateplane_migrations','spaces','collections','collection_versions','collection_unique_declarations',
  'collection_index_declarations','collection_grants','records',
  'record_unique_keys','record_index_values','record_events','idempotency_receipts','record_tombstones','projection_outbox','entity_refs'];
async function snapshot(pool) {
  const result = {};
  for (const table of tables) {
    const rows = await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t`);
    result[table] = rows.rows.map(row => JSON.stringify(row.value)).sort();
  }
  return result;
}
try {
  const expected = await snapshot(base);
  assert.ok(expected.records.length && expected.record_events.length && expected.projection_outbox.length,
    'run the populated authority integration suite before the restore smoke');
  const archive = docker(['pg_dump','-U','stateplane','-Fc','stateplane']);
  docker(['createdb','-U','stateplane',name]);
  execFileSync('docker', ['compose','exec','-T','postgres','pg_restore','-U','stateplane','-d',name],
    { cwd:root, input:archive, maxBuffer:64 * 1024 * 1024 });
  assert.deepEqual(await snapshot(restored),expected);
  const constraints = await Promise.all([base,restored].map(async pool => (await pool.query(`SELECT conname,contype
    FROM pg_constraint WHERE conrelid='records'::regclass ORDER BY conname`)).rows));
  assert.deepEqual(constraints[1],constraints[0]);
  const existing = (await restored.query('SELECT space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data FROM records LIMIT 1')).rows[0];
  await assert.rejects(restored.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::text,$8::jsonb)`,
  [existing.space_id,existing.collection_id,`new_${randomBytes(4).toString('hex')}`,existing.revision,existing.schema_version,
    existing.key_mode,existing.normalized_key,existing.canonical_data]), error => error.code === '23505');
  console.log(`Restore smoke passed: ${tables.length} tables, ${expected.records.length} records, constraints and unique key enforced`);
} finally {
  await Promise.allSettled([base.end(),restored.end()]);
  try { docker(['dropdb','-U','stateplane','--if-exists',name]); } catch { /* Preserve original failure. */ }
}

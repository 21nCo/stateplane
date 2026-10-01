import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import pg from 'pg';

if (process.env.DATABASE_URL) throw new Error('Local restore smoke uses the isolated Docker Compose database only');
const authorityModule = new URL('../packages/postgres/dist/index.js', import.meta.url);
if (!existsSync(authorityModule)) throw new Error('Build @stateplane/postgres before db:restore-smoke: pnpm --filter @stateplane/postgres build');
const { PostgresAuthority } = await import(authorityModule.href);

const password = (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const root = fileURLToPath(new URL('..', import.meta.url));
const sourceName = `stateplane_restore_source_${randomBytes(4).toString('hex')}`;
const name = `stateplane_restore_${randomBytes(4).toString('hex')}`;
const configuredDocker = process.env.STATEPLANE_DOCKER_EXECUTABLE;
if (configuredDocker && !isAbsolute(configuredDocker))
  throw new Error('STATEPLANE_DOCKER_EXECUTABLE must name an absolute executable path');
const dockerExecutable = configuredDocker ?? ['/usr/local/bin/docker','/opt/homebrew/bin/docker','/usr/bin/docker'].find(existsSync);
if (!dockerExecutable) throw new Error('Docker executable not found; set STATEPLANE_DOCKER_EXECUTABLE to its absolute path');
try { accessSync(dockerExecutable,constants.X_OK); }
catch (cause) { throw new Error(`Docker executable is not runnable: ${dockerExecutable}`, { cause }); }
const docker = args => execFileSync(dockerExecutable, ['compose','exec','-T','postgres',...args], { cwd:root, maxBuffer:64 * 1024 * 1024 });
const sourceUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/${sourceName}`;
const targetUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/${name}`;
const base = new pg.Pool({ connectionString:sourceUrl });
const restored = new pg.Pool({ connectionString:targetUrl });
const tables = ['stateplane_migrations','spaces','collections','collection_versions','collection_unique_declarations',
  'collection_index_declarations','collection_grants','records',
  'record_unique_keys','record_index_values','record_events','idempotency_receipts','receipt_reservations',
  'record_tombstones','projection_outbox','entity_refs'];
async function snapshot(pool) {
  const entries = await Promise.all(tables.map(async table => {
    const rows = await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t`);
    return [table, rows.rows.map(row => JSON.stringify(row.value)).sort()];
  }));
  return Object.fromEntries(entries);
}
try {
  docker(['createdb','-U','stateplane',sourceName]);
  execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:root,env:{...process.env,DATABASE_URL:sourceUrl},stdio:'inherit'});
  const spaceId=`sp_restore_${randomBytes(6).toString('hex')}`;
  const collectionId='entries';
  const seed=await base.connect();
  try {
    await seed.query('BEGIN');
    await seed.query("INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES($1,'owner','cell-a','cell-a','target-a')",[spaceId]);
    await seed.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)',[spaceId,collectionId]);
    await seed.query("INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')",[spaceId,collectionId]);
    await seed.query("INSERT INTO collection_unique_declarations(space_id,collection_id,constraint_name,paths,accepted_version) VALUES($1,$2,'label',ARRAY['label'],1)",[spaceId,collectionId]);
    await seed.query("INSERT INTO collection_index_declarations(space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version) VALUES($1,$2,'score','number',TRUE,TRUE,TRUE,1)",[spaceId,collectionId]);
    await seed.query('COMMIT');
  } catch (error) { await seed.query('ROLLBACK'); throw error; }
  finally { seed.release(); }
  const authority=new PostgresAuthority(base,3600);
  const scope={spaceId,collectionId,principalId:'owner',credentialId:'restore',capability:'records:write',policyVersion:1,placementGeneration:1};
  const first=await authority.mutate(scope,{operation:'create',idempotencyKey:'first',requestDigest:'a'.repeat(64),canonicalData:'{"label":"one","score":1}',
    unique:[{name:'label',encodedValue:'s:3:one'}],indexes:[{field:'score',kind:'number',value:1}]});
  await authority.mutate(scope,{operation:'create',idempotencyKey:'second',requestDigest:'b'.repeat(64),canonicalData:'{"label":"two","score":2}',
    unique:[{name:'label',encodedValue:'s:3:two'}],indexes:[{field:'score',kind:'number',value:2}]});
  await authority.mutate(scope,{operation:'delete',idempotencyKey:'delete',requestDigest:'c'.repeat(64),recordId:first.ref.id,expectedRevision:1});
  const admin={...scope,capability:'space:admin'};
  const claimed=await authority.transaction(admin,tx=>tx.claimOutbox(1,30));
  await authority.transaction(admin,tx=>tx.finishOutbox(claimed[0],true));
  const expected = await snapshot(base);
  assert.ok(expected.records.length && expected.record_events.length && expected.projection_outbox.length,
    'expected this restore smoke seed to populate records, events, and outbox');
  const archive = docker(['pg_dump','-U','stateplane','-Fc',sourceName]);
  docker(['createdb','-U','stateplane',name]);
  execFileSync(dockerExecutable, ['compose','exec','-T','postgres','pg_restore','-U','stateplane','-d',name],
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
  try { docker(['dropdb','-U','stateplane','--if-exists',sourceName]); } catch { /* Preserve original failure. */ }
}

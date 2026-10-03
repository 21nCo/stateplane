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
const localPort = process.env.STATEPLANE_LOCAL_DB_PORT || '55432';
if (!/^\d{1,5}$/.test(localPort) || Number(localPort) < 1 || Number(localPort) > 65535)
  throw new Error('STATEPLANE_LOCAL_DB_PORT must be a TCP port');
const sourceUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${localPort}/${sourceName}`;
const targetUrl = `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${localPort}/${name}`;
const base = new pg.Pool({ connectionString:sourceUrl });
const restored = new pg.Pool({ connectionString:targetUrl });
const tables = ['stateplane_migrations','space_directory','space_provisioning_audit','agent_key_issuances','spaces','space_credentials','routing_nonces','space_audit',
  'collections','collection_versions','collection_unique_declarations',
  'collection_index_declarations','collection_grants','records',
  'record_unique_keys','record_index_values','record_events','idempotency_receipts','receipt_reservations',
  'receipt_reservation_scopes',
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
  const retiredSpaceId=`sp_retired_${randomBytes(6).toString('hex')}`;
  const collectionId='entries';
  const seed=await base.connect();
  try {
    await seed.query('BEGIN');
    await seed.query("INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES($1,'owner','cell-a','cell-a','target-a')",[spaceId]);
    await seed.query("INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle) VALUES($1,'owner','cell-a','cell-a','target-a','active')",[spaceId]);
    await seed.query("INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle) VALUES($1,'owner','cell-a','cell-a','target-a','deleted')",[retiredSpaceId]);
    await seed.query("INSERT INTO space_provisioning_audit(space_id,owner_principal_id,cell_id,action) VALUES($1,'owner','cell-a','space:provision-retired')",[retiredSpaceId]);
    await seed.query("INSERT INTO agent_key_issuances(issuance_id,space_id,owner_principal_id,cell_id,credential_id) VALUES('restore-issuance',$1,'owner','cell-a','restore-agent')",[spaceId]);
    await seed.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)',[spaceId,collectionId]);
    await seed.query("INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at) VALUES($1,'restore-agent','agent','owner',clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())",[spaceId]);
    await seed.query("INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities) VALUES($1,$2,'restore-agent',ARRAY['records:read']::text[])",[spaceId,collectionId]);
    await seed.query("INSERT INTO routing_nonces(space_id,nonce,expires_at) VALUES($1,'restore-nonce',clock_timestamp()+interval '1 hour')",[spaceId]);
    await seed.query("INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation) VALUES($1,$2,'owner','restore','space:create',1,1)",[`aud_${randomBytes(6).toString('hex')}`,spaceId]);
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
  const worker={...scope,principalId:'system:projection',credentialId:'system:projection',capability:'outbox:worker'};
  const claimed=await authority.transaction(worker,tx=>tx.claimOutbox(1,30));
  await authority.transaction(worker,tx=>tx.finishOutbox(claimed[0],true));
  const expected = await snapshot(base);
  assert.ok(expected.records.length && expected.record_events.length && expected.projection_outbox.length &&
    expected.space_directory.length && expected.agent_key_issuances.length &&
    expected.space_credentials.length && expected.collection_grants.length &&
    expected.routing_nonces.length && expected.space_audit.length && expected.space_provisioning_audit.length,
  'expected this restore smoke seed to populate records, outbox, and owned-space authority');
  const archive = docker(['pg_dump','-U','stateplane','-Fc',sourceName]);
  docker(['createdb','-U','stateplane',name]);
  execFileSync(dockerExecutable, ['compose','exec','-T','postgres','pg_restore','-U','stateplane','-d',name],
    { cwd:root, input:archive, maxBuffer:64 * 1024 * 1024 });
  assert.deepEqual(await snapshot(restored),expected);
  const journalRole=`sta6_restore_${randomBytes(8).toString('hex')}`;
  await restored.query(`CREATE ROLE ${journalRole} LOGIN`);
  try {
    execFileSync(process.execPath,['scripts/grant-control-journal.mjs'],{cwd:root,
      env:{...process.env,STATEPLANE_CONTROL_URL:targetUrl,STATEPLANE_CONTROL_ROLE:journalRole},stdio:'inherit'});
    const operational=await restored.connect();
    const issuance=`iss_restore_${randomBytes(8).toString('hex')}`;
    try {
      await operational.query(`SET ROLE ${journalRole}`);
      await operational.query(`INSERT INTO agent_key_issuances(issuance_id,space_id,owner_principal_id,cell_id)
        VALUES($1,$2,'owner','cell-a')`,[issuance,spaceId]);
      await operational.query('UPDATE agent_key_issuances SET create_failed_at=clock_timestamp() WHERE issuance_id=$1',[issuance]);
      assert.ok((await operational.query('SELECT create_failed_at FROM agent_key_issuances WHERE issuance_id=$1',[issuance]))
        .rows[0]?.create_failed_at,'restored operational role can use the journal');
    } finally {
      await operational.query('RESET ROLE').catch(()=>{});
      operational.release();
      await restored.query('DELETE FROM agent_key_issuances WHERE issuance_id=$1',[issuance]).catch(()=>{});
    }
  } finally {
    await restored.query(`REVOKE ALL ON agent_key_issuances FROM ${journalRole}`).catch(()=>{});
    await restored.query(`DROP ROLE IF EXISTS ${journalRole}`).catch(()=>{});
  }
  // A reserved-word role proves identifier quoting. Keep its creation and
  // ownership marker atomic so an interrupted run can safely reuse it.
  const reservedRole=await restored.connect();
  // Roles are cluster-wide. Every restore run locks the same maintenance DB,
  // even though each run restores into a different disposable database.
  const maintenanceUrl=new URL(targetUrl);
  maintenanceUrl.pathname='/postgres';
  const maintenance=new pg.Client({connectionString:maintenanceUrl.toString()});
  const marker='stateplane:restore-smoke:reserved-role:v1';
  let ownedRole=false;
  let locked=false;
  try {
    await maintenance.connect();
    await maintenance.query("SELECT pg_advisory_lock(hashtext('stateplane:restore-smoke:select'))");
    locked=true;
    const existing=(await reservedRole.query(`SELECT shobj_description(oid,'pg_authid') AS marker
      FROM pg_roles WHERE rolname='select'`)).rows[0];
    if (existing && existing.marker!==marker) throw new Error('Reserved restore fixture role is owned by another user');
    if (!existing) {
      await reservedRole.query('BEGIN');
      try {
        await reservedRole.query('CREATE ROLE "select" LOGIN');
        await reservedRole.query(`COMMENT ON ROLE "select" IS '${marker}'`);
        await reservedRole.query('COMMIT');
      } catch (error) { await reservedRole.query('ROLLBACK').catch(()=>{}); throw error; }
    }
    ownedRole=true;
    execFileSync(process.execPath,['scripts/grant-control-journal.mjs'],{cwd:root,
      env:{...process.env,STATEPLANE_CONTROL_URL:targetUrl,STATEPLANE_CONTROL_ROLE:'select'},stdio:'inherit'});
    const grants=(await restored.query(`SELECT has_table_privilege('select','public.agent_key_issuances','SELECT') AS can_read,
      has_table_privilege('select','public.agent_key_issuances','INSERT') AS can_create,
      has_table_privilege('select','public.agent_key_issuances','UPDATE') AS can_update`)).rows[0];
    assert.deepEqual(grants,{can_read:true,can_create:true,can_update:true});
  } finally {
    try {
      if (ownedRole) {
        await reservedRole.query('REVOKE ALL ON agent_key_issuances FROM "select"').catch(()=>{});
        // A killed earlier run may still have a disposable database dependency.
        // Retain only our marked role so the next run can reuse it safely.
        await reservedRole.query('DROP ROLE IF EXISTS "select"').catch(error=>{
          if (error.code!=='2BP01') throw error;
        });
      }
    } finally {
      try {
        if (locked) await maintenance.query("SELECT pg_advisory_unlock(hashtext('stateplane:restore-smoke:select'))");
      } finally {
        try { await maintenance.end(); }
        finally { reservedRole.release(); }
      }
    }
  }
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnIdentityVerifier, AuthFnAgentKeys } from '../../packages/auth/dist/index.js';
import { RegionalRouter, RegionalCell, RoutingKeys } from '../../packages/application/dist/index.js';
import { PostgresAuthority, PostgresSpaces, PostgresRoutingDirectory, PostgresCellPolicy } from '../../packages/postgres/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const databaseNames = [];
let controlUrl = url; let cellAUrl = url; let cellBUrl = url;
if (process.env.STATEPLANE_TEST_SEPARATE_DBS === '1') {
  const admin = new pg.Client({connectionString:url});
  await admin.connect();
  try {
    for (const suffix of ['control','a','b']) {
      const name = `sta6_${suffix}_${crypto.randomUUID().replaceAll('-','')}`;
      await admin.query(`CREATE DATABASE ${name}`);
      databaseNames.push(name);
      const target = new URL(url); target.pathname = `/${name}`;
      execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env:{...process.env,DATABASE_URL:target.toString()},stdio:'ignore'});
    }
  } finally { await admin.end(); }
  [controlUrl,cellAUrl,cellBUrl] = databaseNames.map(name => {const target=new URL(url);target.pathname=`/${name}`;return target.toString();});
}
const controlPool = new pg.Pool({ connectionString:controlUrl,max:5 });
const pool = new pg.Pool({ connectionString:cellAUrl,max:5 });
const cellBPool = new pg.Pool({ connectionString:cellBUrl,max:5 });
test.after(async () => {
  await Promise.all([controlPool.end(),pool.end(),cellBPool.end()]);
  if (databaseNames.length) {
    const admin = new pg.Client({connectionString:url});
    await admin.connect();
    try { for (const name of databaseNames) await admin.query(`DROP DATABASE ${name}`); }
    finally { await admin.end(); }
  }
});

async function collection(spaceId,collectionId,cellPool=pool) {
  const db = await cellPool.connect();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)',[spaceId,collectionId]);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,[spaceId,collectionId]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
const request = secret => new Request('https://gateway.example.invalid',{headers:{Authorization:`Bearer ${secret}`}});
const denied = code => error => error?.code === code;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

test('owned spaces, AuthFn identities and cell effects share a revocable authority boundary', async () => {
  const config = { database:memoryAdapter(),namespace:`sta6-${crypto.randomUUID()}`,plugins:[] };
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`owner-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, { userId:user.id,methods:['password'] });
  const identity = new AuthFnIdentityVerifier(config);
  const owner = await identity.verify(request(session.sessionToken));
  assert.equal(owner.kind,'session');
  const keyProvider = new AuthFnAgentKeys(config);
  // With STATEPLANE_TEST_SEPARATE_DBS=1 these are three isolated databases;
  // the default also exercises their logical routing and policy boundaries.
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}],['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]);
  const spaces = new PostgresSpaces(controlPool,cells,'cell-a',keyProvider,identity);
  const first = await spaces.create(owner);
  const second = await spaces.create(owner,'cell-b');
  assert.notEqual(first.spaceId,second.spaceId);
  if (databaseNames.length) {
    assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM spaces')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[second.spaceId])).rows[0].n,0);
    assert.equal((await cellBPool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[first.spaceId])).rows[0].n,0);
  }
  assert.deepEqual((await spaces.list(owner)).map(space => space.spaceId).sort(),[first.spaceId,second.spaceId].sort());
  await assert.rejects(spaces.create({kind:'api-key',credentialId:'key-untrusted'}),denied('FORBIDDEN'));
  await assert.rejects(spaces.create(owner,'unlisted-cell'),denied('INVALID_ARGUMENT'));
  const c1 = `entries_${crypto.randomUUID()}`;
  const c2 = `private_${crypto.randomUUID()}`;
  await collection(first.spaceId,c1); await collection(first.spaceId,c2); await collection(second.spaceId,c1,cellBPool);
  const expires = new Date(Date.now()+3_600_000);
  const key1 = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  const key2 = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c2,capabilities:['records:read']}]);
  const adminKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['space:admin']}]);
  const reviewerKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['claims:review']}]);
  const adminActor = await identity.verify(request(adminKey.secret));
  assert.equal((await spaces.get(adminActor,first.spaceId)).spaceId,first.spaceId);
  await assert.rejects(spaces.archive(adminActor,first.spaceId),denied('FORBIDDEN'));
  await assert.rejects(spaces.get(adminActor,second.spaceId),denied('NOT_FOUND'),
    'an admin grant on another space cannot disclose this space');
  await assert.rejects(spaces.get(adminActor,`sp_${crypto.randomUUID()}`),denied('NOT_FOUND'));
  await assert.rejects(spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read','schema:unknown']}]),denied('INVALID_ARGUMENT'));
  const signing = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const directory = new PostgresRoutingDirectory(controlPool,cells);
  const router = new RegionalRouter(identity,directory,signing);
  const cellA = new RegionalCell('cell-a',signing,new PostgresCellPolicy(pool,'cell-a',identity));
  const cellB = new RegionalCell('cell-b',signing,new PostgresCellPolicy(cellBPool,'cell-b',identity));
  const authority = new PostgresAuthority(pool,3600);
  const read = (cell,token) => cell.execute(token,(_principalId,context) => context.records(authority,tx => tx.countRecords([])));
  const route = (secret,spaceId,collectionId,capability='records:read') => router.assertion(request(secret),spaceId,collectionId,capability);
  let adminCallbacks = 0;
  for (const operation of [
    tx => tx.claimOutbox(1,30),
    tx => tx.finishOutbox({eventId:'untrusted',ref:{spaceId:first.spaceId,collectionId:c1,id:'record'},
      revision:1,generation:1,attempt:1},true),
  ]) {
    const assertion = await route(adminKey.secret,first.spaceId,c1,'space:admin');
    await assert.rejects(cellA.execute(assertion.token,(_principal,context) => {
      adminCallbacks++;
      return context.records(authority,operation);
    }),denied('FORBIDDEN'));
  }
  assert.equal(adminCallbacks,2,'admin is admitted only to metadata, never projection effects');
  await pool.query("UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id=$2",[first.spaceId,c1]);
  const collectionReview = await route(reviewerKey.secret,first.spaceId,c1,'claims:review');
  let reviewCallbacks = 0;
  await assert.rejects(cellA.execute(collectionReview.token,async () => { reviewCallbacks++; }),denied('SPACE_UNAVAILABLE'));
  assert.equal(reviewCallbacks,0);
  await pool.query("UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id=$2",[first.spaceId,c1]);
  const otherUser = await createUser(config,{primaryEmail:`other-${crypto.randomUUID()}@example.invalid`});
  const otherSession = await issueSession(config,{}, {userId:otherUser.id,methods:['password']});
  await assert.rejects(route(otherSession.sessionToken,first.spaceId,c1),denied('NOT_FOUND'));
  const otherOwner = await identity.verify(request(otherSession.sessionToken));
  const otherSpace = await spaces.create(otherOwner);
  let crossOwnerCellReads = 0;
  const guardedCell = {query:async () => { crossOwnerCellReads++; throw new Error('cross-owner cell read'); }};
  const concealedSpaces = new PostgresSpaces(controlPool,
    new Map([['cell-a',{pool:guardedCell,storageTargetId:'target-a'}],
      ['cell-b',{pool:guardedCell,storageTargetId:'target-b'}]]),
    'cell-a',keyProvider,identity);
  await assert.rejects(concealedSpaces.get(adminActor,otherSpace.spaceId),denied('NOT_FOUND'));
  await assert.rejects(concealedSpaces.get(adminActor,`sp_${crypto.randomUUID()}`),denied('NOT_FOUND'));
  assert.equal(crossOwnerCellReads,0,'cross-owner and unknown IDs never reach a regional cell');

  const routed = await route(key1.secret,first.spaceId,c1);
  assert.equal(routed.cellId,'cell-a');
  await assert.rejects(cellA.execute('',async () => { throw new Error('direct effect'); }),denied('FORBIDDEN'));
  assert.equal(await read(cellA,routed.token),0);
  await assert.rejects(read(cellA,routed.token),denied('FORBIDDEN')); // one-use assertion
  const failedEffect = await route(key1.secret,first.spaceId,c1);
  let callbacks = 0;
  await assert.rejects(cellA.execute(failedEffect.token,async () => { callbacks++; throw new Error('provider failed'); }),/provider failed/);
  await assert.rejects(cellA.execute(failedEffect.token,async () => { callbacks++; }),denied('FORBIDDEN'));
  assert.equal(callbacks,1,'failed effects still consume their assertion');
  await assert.rejects(read(cellB,(await route(key1.secret,first.spaceId,c1)).token),denied('FORBIDDEN'));
  const tampered = (await route(key1.secret,first.spaceId,c1)).token;
  const tamperedParts = tampered.split('.');
  tamperedParts[1] = (tamperedParts[1].startsWith('A')?'B':'A')+tamperedParts[1].slice(1);
  await assert.rejects(read(cellA,tamperedParts.join('.')),denied('FORBIDDEN'));
  await assert.rejects(route(key1.secret,first.spaceId,c2),denied('NOT_FOUND'));
  await assert.rejects(route(key2.secret,first.spaceId,c1),denied('NOT_FOUND'));
  await assert.rejects(route(key1.secret,second.spaceId,c1),denied('NOT_FOUND'));
  await assert.rejects(route(key1.secret,first.spaceId,c1,'schema:write'),denied('NOT_FOUND'));
  await assert.rejects(route(key1.secret,first.spaceId,c1,'sources:read'),denied('NOT_FOUND'));
  await assert.rejects(route(key1.secret,first.spaceId,c1,'export:read'),denied('NOT_FOUND'));
  const expiredAssertion = await route(key1.secret,first.spaceId,c1);
  const futureCell = new RegionalCell('cell-a',signing,new PostgresCellPolicy(pool,'cell-a',identity),() => Math.floor(Date.now()/1000)+61);
  await assert.rejects(read(futureCell,expiredAssertion.token),denied('FORBIDDEN'));

  const old = await route(key1.secret,first.spaceId,c1);
  let enter;
  const entered = new Promise(resolve => { enter=resolve; });
  let release;
  const held = new Promise(resolve => { release=resolve; });
  const inFlight = cellA.execute(old.token,async (_principalId,_client,_claims) => { enter(); await held; return 'committed'; });
  await entered;
  let revoked = false;
  const revocation = spaces.revokeAgentKey(owner,first.spaceId,key1.id).then(() => { revoked=true; });
  await pause(80);
  assert.equal(revoked,false,'revocation waits for the in-flight effect lock');
  release();
  assert.equal(await inFlight,'committed');
  await revocation;
  await assert.rejects(route(key1.secret,first.spaceId,c1),denied('UNAUTHENTICATED'));
  assert.equal(await read(cellA,(await route(key2.secret,first.spaceId,c2)).token),0);

  const expiredKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  await pool.query(`UPDATE space_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND credential_id=$2`,[first.spaceId,expiredKey.id]);
  await assert.rejects(route(expiredKey.secret,first.spaceId,c1),denied('NOT_FOUND'));
  const expiredGrant = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND credential_id=$2`,[first.spaceId,expiredGrant.id]);
  await assert.rejects(route(expiredGrant.secret,first.spaceId,c1),denied('NOT_FOUND'));
  const providerRevoked = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  const providerRevokedActor = await identity.verify(request(providerRevoked.secret));
  const preissued = await route(providerRevoked.secret,first.spaceId,c1);
  await keyProvider.revoke(providerRevoked.id,user.id);
  await assert.rejects(spaces.get(providerRevokedActor,first.spaceId),denied('FORBIDDEN'));
  await assert.rejects(cellA.execute(preissued.token,async () => { throw new Error('provider effect admitted'); }),denied('FORBIDDEN'));
  const midwayKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  const midwayAssertion = await route(midwayKey.secret,first.spaceId,c1);
  let allowBoundary;
  const boundaryWait = new Promise(resolve => { allowBoundary=resolve; });
  let enteredBoundary;
  const boundaryEntered = new Promise(resolve => { enteredBoundary=resolve; });
  let externalEffects = 0;
  const midway = cellA.execute(midwayAssertion.token,async (_principal,context) => {
    enteredBoundary();
    await boundaryWait;
    await context.authorizeEffect();
    externalEffects++;
  });
  await boundaryEntered;
  await keyProvider.revoke(midwayKey.id,user.id);
  allowBoundary();
  await assert.rejects(midway,denied('FORBIDDEN'));
  assert.equal(externalEffects,0);
  const transientSession = await issueSession(config,{}, { userId:user.id,methods:['password'] });
  const transientActor = await identity.verify(request(transientSession.sessionToken));
  const ownerPreissued = await route(transientSession.sessionToken,first.spaceId,c1);
  const { revokeSessionById } = await import('@authfn/core');
  await revokeSessionById(config,transientSession.session.id,{userId:user.id});
  await assert.rejects(cellA.execute(ownerPreissued.token,async () => { throw new Error('session effect admitted'); }),denied('FORBIDDEN'));
  for (const operation of [
    () => spaces.create(transientActor),
    () => spaces.list(transientActor),
    () => spaces.get(transientActor,first.spaceId),
    () => spaces.archive(transientActor,first.spaceId),
    () => spaces.issueAgentKey(transientActor,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]),
    () => spaces.revokeAgentKey(transientActor,first.spaceId,key2.id),
    () => spaces.rotateAgentKey(transientActor,first.spaceId,key2.id,expires,[{collectionId:c2,capabilities:['records:read']}]),
    () => spaces.audit(transientActor,first.spaceId),
    () => spaces.delete(transientActor,first.spaceId),
  ]) await assert.rejects(operation(),denied('FORBIDDEN'));
  const retryKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  const actualProviderRevoke = keyProvider.revoke.bind(keyProvider);
  let failRevoke = true;
  keyProvider.revoke = async (...args) => { if (failRevoke) throw new Error('provider revoke failed'); return actualProviderRevoke(...args); };
  await assert.rejects(spaces.revokeAgentKey(owner,first.spaceId,retryKey.id),/provider revoke failed/);
  assert.equal((await pool.query('SELECT revoked_at IS NOT NULL AS local,provider_revoked_at IS NOT NULL AS provider FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [first.spaceId,retryKey.id])).rows[0].local,true);
  await assert.rejects(route(retryKey.secret,first.spaceId,c1),denied('NOT_FOUND'));
  failRevoke = false;
  await spaces.revokeAgentKey(owner,first.spaceId,retryKey.id);
  assert.equal((await pool.query('SELECT provider_revoked_at IS NOT NULL AS provider FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [first.spaceId,retryKey.id])).rows[0].provider,true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2 AND action='key:provider-revoke'",
    [first.spaceId,retryKey.id])).rows[0].n,1);
  const rotateRetryKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  failRevoke = true;
  await assert.rejects(spaces.rotateAgentKey(owner,first.spaceId,rotateRetryKey.id,expires,
    [{collectionId:c1,capabilities:['records:read']}]),/provider revoke failed/);
  failRevoke = false;
  const rotatedRetry = await spaces.rotateAgentKey(owner,first.spaceId,rotateRetryKey.id,expires,
    [{collectionId:c1,capabilities:['records:read']}]);
  await assert.rejects(route(rotateRetryKey.secret,first.spaceId,c1),denied('UNAUTHENTICATED'));
  assert.equal(await read(cellA,(await route(rotatedRetry.secret,first.spaceId,c1)).token),0);
  const soon = await spaces.issueAgentKey(owner,first.spaceId,new Date(Date.now()+2_500),[{collectionId:c1,capabilities:['records:write']}]);
  const expiring = await route(soon.secret,first.spaceId,c1,'records:write');
  await assert.rejects(cellA.execute(expiring.token,async (_principalId,context) => {
    await context.records(authority,tx => tx.mutate({operation:'create',idempotencyKey:`expiry-${crypto.randomUUID()}`,
      requestDigest:createHash('sha256').update('expiry').digest('hex'),canonicalData:'{}'}));
    await pause(2_700);
  }),denied('FORBIDDEN'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1 AND collection_id=$2',[first.spaceId,c1])).rows[0].n,0,
    'expiry at the commit boundary rolls back the record and audit');
  const rotated = await spaces.rotateAgentKey(owner,first.spaceId,key2.id,expires,[{collectionId:c2,capabilities:['records:read']}]);
  await assert.rejects(route(key2.secret,first.spaceId,c2),denied('UNAUTHENTICATED'));
  assert.equal(await read(cellA,(await route(rotated.secret,first.spaceId,c2)).token),0);
  const pendingDeleteKey = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  failRevoke = true;
  await assert.rejects(spaces.revokeAgentKey(owner,first.spaceId,pendingDeleteKey.id),/provider revoke failed/);
  failRevoke = false;
  const data = '{}';
  await authority.mutate({ spaceId:first.spaceId,collectionId:c2,principalId:user.id,credentialId:session.session.id,
    capability:'records:write',policyVersion:(await spaces.get(owner,first.spaceId)).policyVersion,placementGeneration:1 },
  {operation:'create',idempotencyKey:`delete-${crypto.randomUUID()}`,requestDigest:createHash('sha256').update(data).digest('hex'),canonicalData:data});
  await assert.rejects(pool.query('DELETE FROM record_events WHERE space_id=$1',[first.spaceId]),/immutable/);
  await assert.rejects(pool.query('SELECT stateplane_purge_space($1)',[first.spaceId]),/not deleting/);
  assert.equal(await read(cellA,(await route(rotated.secret,first.spaceId,c2)).token),1);

  // A signed assertion from before the policy change is fenced at the cell.
  const stale = await route(rotated.secret,first.spaceId,c2);
  await spaces.archive(owner,first.spaceId);
  await assert.rejects(read(cellA,stale.token),denied('STALE_PLACEMENT'));
  assert.equal(await read(cellA,(await route(rotated.secret,first.spaceId,c2)).token),1);
  const spaceReview = await route(reviewerKey.secret,first.spaceId,c1,'claims:review');
  await assert.rejects(cellA.execute(spaceReview.token,async () => { reviewCallbacks++; }),denied('SPACE_UNAVAILABLE'));
  assert.equal(reviewCallbacks,0);
  const actualRevoke = keyProvider.revoke.bind(keyProvider);
  let unavailable = true;
  keyProvider.revoke = async (...args) => { if (unavailable) throw new Error('provider unavailable'); return actualRevoke(...args); };
  await assert.rejects(spaces.delete(owner,first.spaceId),/provider unavailable/);
  assert.equal((await spaces.get(owner,first.spaceId)).lifecycle,'deleting');
  await assert.rejects(route(rotated.secret,first.spaceId,c2),denied('SPACE_UNAVAILABLE'));
  unavailable = false;
  await spaces.delete(owner,first.spaceId);
  await assert.rejects(route(rotated.secret,first.spaceId,c2),denied('UNAUTHENTICATED'));
  await assert.rejects(route(pendingDeleteKey.secret,first.spaceId,c1),denied('UNAUTHENTICATED'));
  assert.equal((await spaces.list(owner)).length,1);
  for (const table of ['collections','collection_versions','collection_grants','space_credentials','records','record_events','idempotency_receipts','projection_outbox']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[first.spaceId])).rows[0].n,0,`${table} erased`);
  }
  const actions = (await pool.query('SELECT action FROM space_audit WHERE space_id=$1 ORDER BY recorded_at,audit_id',[first.spaceId])).rows.map(row => row.action);
  assert.ok(actions.includes('space:create') && actions.includes('key:issue') && actions.includes('key:revoke') && actions.includes('space:readOnly') && actions.includes('space:deleted'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2 AND action='key:provider-revoke'",
    [first.spaceId,pendingDeleteKey.id])).rows[0].n,1);
  const secondAssertion = await route(session.sessionToken,second.spaceId,c1);
  assert.equal(await spaces.fencePlacement(second.spaceId,'cell-b',1),2);
  await assert.rejects(read(cellB,secondAssertion.token),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.fencePlacement(second.spaceId,'cell-a',2),denied('STALE_PLACEMENT'));
  await cellBPool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[second.spaceId]);
  await assert.rejects(read(cellB,(await route(session.sessionToken,second.spaceId,c1)).token),denied('STALE_PLACEMENT'));
  assert.equal((await spaces.reconcile(second.spaceId)).policyVersion,2);
  assert.equal(await read(cellB,(await route(session.sessionToken,second.spaceId,c1)).token),0);
  const originalControlQuery = controlPool.query.bind(controlPool);
  let raced = false;
  controlPool.query = async (sql,...args) => {
    if (!raced && typeof sql === 'string' && sql.includes('UPDATE space_directory SET lifecycle=$2,policy_version=$3')) {
      raced = true;
      await originalControlQuery("UPDATE space_directory SET policy_version=policy_version+1,lifecycle='suspended' WHERE space_id=$1",[second.spaceId]);
    }
    return originalControlQuery(sql,...args);
  };
  try { await assert.rejects(spaces.reconcile(second.spaceId),denied('STALE_PLACEMENT')); }
  finally { controlPool.query = originalControlQuery; }
  assert.equal((await originalControlQuery('SELECT lifecycle FROM space_directory WHERE space_id=$1',[second.spaceId])).rows[0].lifecycle,'suspended');
});

test('archived spaces replay owner and agent receipts but deny external writes at the effect boundary', async () => {
  const config = { database:memoryAdapter(),namespace:`sta6-${crypto.randomUUID()}`,plugins:[] };
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`owner-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const owner = await identity.verify(request(session.sessionToken));
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(controlPool,cells,'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId} = await spaces.create(owner);
  const collectionId = `entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const agent = await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:write']}]);
  const reader = await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]);
  const keys = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router = new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),keys);
  const cell = new RegionalCell('cell-a',keys,new PostgresCellPolicy(pool,'cell-a',identity));
  const authority = new PostgresAuthority(pool,3600);
  const route = secret => router.assertion(request(secret),spaceId,collectionId,'records:write');
  const routeRead = secret => router.assertion(request(secret),spaceId,collectionId,'records:read');
  const actors = [session.sessionToken,agent.secret];
  const changes = actors.map(() => ({operation:'create',idempotencyKey:`write-${crypto.randomUUID()}`,
    requestDigest:createHash('sha256').update('{}').digest('hex'),canonicalData:'{}'}));
  const receipts = [];
  let externalEffects = 0;
  for (const [index,secret] of actors.entries()) {
    receipts.push(await cell.execute((await route(secret)).token,async (_principal,context) => {
      await context.authorizeEffect();
      externalEffects++;
      return context.records(authority,tx => tx.mutate(changes[index]));
    }));
  }
  assert.equal(externalEffects,2,'active owner and agent effects remain available');
  let externalReads = 0;
  const readers = [session.sessionToken,reader.secret];
  for (const secret of readers) await cell.execute((await routeRead(secret)).token,async (_principal,context) => {
    await context.authorizeEffect('read');
    externalReads++;
  });
  assert.equal(externalReads,2);
  await assert.rejects(cell.execute((await routeRead(reader.secret)).token,(_principal,context) =>
    context.authorizeEffect()),denied('FORBIDDEN'));

  await pool.query("UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id=$2",[spaceId,collectionId]);
  let collectionCallbacks = 0;
  await assert.rejects(cell.execute((await route(agent.secret)).token,async () => { collectionCallbacks++; }),denied('SPACE_UNAVAILABLE'));
  assert.equal(collectionCallbacks,0,'a readOnly collection denies writes before the callback');
  await cell.execute((await routeRead(reader.secret)).token,async (_principal,context) => {
    await context.authorizeEffect('read');
    externalReads++;
  });
  assert.equal(externalReads,3,'a readOnly collection permits granted external reads in an active space');
  await pool.query("UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id=$2",[spaceId,collectionId]);

  await spaces.archive(owner,spaceId);
  for (const secret of readers) await cell.execute((await routeRead(secret)).token,async (_principal,context) => {
    await context.authorizeEffect('read');
    externalReads++;
  });
  assert.equal(externalReads,5,'archived owner and agent can perform granted external reads');
  for (const [index,secret] of actors.entries()) {
    const replay = await cell.execute((await route(secret)).token,(_principal,context) =>
      context.records(authority,tx => tx.mutate(changes[index])));
    assert.equal(replay.replayed,true);
    assert.equal(replay.receiptId,receipts[index].receiptId);
    await assert.rejects(cell.execute((await route(secret)).token,async (_principal,context) => {
      await context.authorizeEffect();
      externalEffects++;
    }),denied('SPACE_UNAVAILABLE'));
  }
  assert.equal(externalEffects,2,'archived owner and agent assertions cannot start external writes');
  await pool.query("UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id=$2",[spaceId,collectionId]);
  for (const secret of readers) await cell.execute((await routeRead(secret)).token,async (_principal,context) => {
    await context.authorizeEffect('read');
    externalReads++;
  });
  assert.equal(externalReads,7,'collection readOnly also preserves granted external reads');
  const preRevocation = await routeRead(reader.secret);
  await spaces.revokeAgentKey(owner,spaceId,reader.id);
  await assert.rejects(cell.execute(preRevocation.token,async (_principal,context) => {
    await context.authorizeEffect('read');
    externalReads++;
  }),denied('STALE_PLACEMENT'));
  assert.equal(externalReads,7,'revocation prevents external reads at cell admission');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,2);
});

test('cell pool waits and ambiguous BEGIN fail before effects and discard uncertain clients', async () => {
  const claims = {spaceId:'space',collectionId:'collection',capability:'records:read',credentialId:'key',kind:'api-key',
    cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',issuedAt:1,expiresAt:30,nonce:'nonce'};
  let now = 1_000;
  let effects = 0;
  let releaseArgument;
  let connections = 0;
  const pool = {connect:async () => {
    connections++;
    if (connections === 1) return {query:async () => ({rowCount:1}),release:() => {}};
    now = 31_000;
    return {query:async () => { throw new Error('query should not run after expiry'); },release:argument => { releaseArgument=argument; }};
  }};
  const policy = new PostgresCellPolicy(pool,'cell-a',{current:async () => true},() => now);
  await assert.rejects(policy.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
  assert.equal(connections,2);
  assert.equal(releaseArgument,false);
  now = 1_000; connections = 0; releaseArgument = undefined;
  const beginFailurePool = {connect:async () => {
    connections++;
    return connections === 1 ? {query:async () => ({rowCount:1}),release:() => {}} :
      {query:async sql => {
        if (sql.includes('AS assertion_current')) return {rows:[{assertion_current:true}]};
        throw new Error('lost BEGIN');
      },release:argument => { releaseArgument=argument; }};
  }};
  await assert.rejects(new PostgresCellPolicy(beginFailurePool,'cell-a',{current:async () => true},() => now)
    .run(claims,async () => { effects++; }),/lost BEGIN/);
  assert.equal(releaseArgument,true);
  assert.equal(effects,0);
});

test('cell context closes on callback return and settles unawaited work before pool reuse', async () => {
  const claims = {spaceId:'space',collectionId:'collection',capability:'records:read',credentialId:'session',kind:'session',
    userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:1,expiresAt:30,nonce:'retained-context'};
  let released = false;
  let providerChecks = 0;
  let recordCalls = 0;
  let retained;
  let credentialActive = true;
  let now = 1_000;
  const client = {query:async sql => {
    if (sql.includes('AS assertion_current')) return {rows:[{assertion_current:true}]};
    if (sql.includes('SELECT s.owner_principal_id')) return {rows:[{owner_principal_id:'owner',lifecycle:'active',cell_id:'cell-a',
      policy_version:1,placement_generation:1,collection_lifecycle:'active'}]};
    return {rowCount:1};
  },release:() => { released=true; }};
  const policy = new PostgresCellPolicy({connect:async () => client},'cell-a',
    {current:async () => { providerChecks++; return credentialActive; }},() => now);
  await policy.run(claims,async (_principal,context) => { retained=context; });
  assert.equal(released,true);
  const checksAtRelease = providerChecks;
  await assert.rejects(retained.records({transactionOnClient:async () => { recordCalls++; }},async () => {}),denied('FORBIDDEN'));
  await assert.rejects(retained.authorizeEffect(),denied('FORBIDDEN'));
  assert.equal(recordCalls,0);
  assert.equal(providerChecks,checksAtRelease);

  released=false;
  const pending = {transactionOnClient:async () => { recordCalls++; await pause(10); }};
  await assert.rejects(policy.run({...claims,nonce:'unawaited'},async (_principal,context) => {
    void context.records(pending,async () => {}).catch(() => {});
  }),denied('FORBIDDEN'));
  assert.equal(released,true);
  assert.equal(recordCalls,0);

  await assert.rejects(policy.run({...claims,nonce:'revoked-during-record'},async (_principal,context) => {
    await context.records({transactionOnClient:async () => { credentialActive=false; recordCalls++; }},async () => {});
  }),denied('FORBIDDEN'));
  assert.equal(recordCalls,1);
  credentialActive=true;
  await assert.rejects(policy.run({...claims,nonce:'expired-during-record'},async (_principal,context) => {
    await context.records({transactionOnClient:async () => { now=31_000; recordCalls++; }},async () => {});
  }),denied('FORBIDDEN'));
  assert.equal(recordCalls,2);
});

test('space lifecycle discards a client after an ambiguous BEGIN', async () => {
  let discarded;
  const cellPool = {connect:async () => ({query:async () => { throw new Error('lost BEGIN'); },
    release:value => { discarded=value; }}),query:async () => ({rowCount:0})};
  const control = {query:async () => ({rowCount:1}),
    connect:async () => ({query:async sql => sql.includes('FOR UPDATE') ? {rows:[{one:1}]} : {rowCount:1},release:() => {}})};
  const spaces = new PostgresSpaces(control,new Map([['cell-a',{pool:cellPool,storageTargetId:'target'}]]),'cell-a',
    {create:async () => { throw new Error('unused'); },revoke:async () => {}},{current:async () => true});
  await assert.rejects(spaces.create({kind:'session',credentialId:'session',userPrincipalId:'owner'}),/lost BEGIN/);
  assert.equal(discarded,true);
});

test('an unavailable identity provider stops owner control reads and writes before SQL', async () => {
  let controlEffects = 0;
  const control = {query:async () => { controlEffects++; throw new Error('control should not be reached'); }};
  const cellPool = {connect:async () => { throw new Error('cell should not be reached'); },
    query:async () => { throw new Error('cell should not be reached'); }};
  const spaces = new PostgresSpaces(control,new Map([['cell-a',{pool:cellPool,storageTargetId:'target'}]]),
    'cell-a',{create:async () => { throw new Error('provider key should not be created'); },revoke:async () => {}},
    {current:async () => { throw new Error('identity provider unavailable'); }});
  const actor = {kind:'session',credentialId:'session',userPrincipalId:'owner'};
  for (const operation of [() => spaces.create(actor),() => spaces.list(actor),
    () => spaces.get(actor,'space'),() => spaces.archive(actor,'space'),() => spaces.audit(actor,'space')]) {
    await assert.rejects(operation(),/identity provider unavailable/);
  }
  assert.equal(controlEffects,0);
});

test('database-clock nonce admission stays closed across skew and bounded cleanup', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-nonce-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`nonce-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId} = await spaces.create(actor);
  const now = Math.floor(Date.now()/1000);
  for (let index = 0; index < 40; index++) await pool.query(
    'INSERT INTO routing_nonces(space_id,nonce,expires_at) VALUES($1,$2,to_timestamp($3))',
    [spaceId,`expired_${index}`,now-10]);
  const claims = {spaceId,collectionId:'collection',capability:'records:read',credentialId:'key',kind:'api-key',
    cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:now-30,expiresAt:now-5,nonce:'replay'};
  let effects = 0;
  // The Worker is behind Postgres and would accept this assertion by its own clock.
  const behind = new PostgresCellPolicy(pool,'cell-a',{current:async () => true},() => (now-20)*1000);
  await assert.rejects(behind.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1',[spaceId])).rows[0].n,8,
    'each admission prunes at most 32 expired rows');
  assert.equal(await behind.cleanupExpiredNonces(),8);
  await assert.rejects(behind.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0,'a pruned nonce cannot be replayed while the Worker clock lags');
  const ahead = new PostgresCellPolicy(pool,'cell-a',{current:async () => true},() => (now+60)*1000);
  await assert.rejects(ahead.run({...claims,expiresAt:now+30,nonce:'worker-ahead'},async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
});

test('a nonce consumed before expiry cannot reach an effect after waiting for the cell pool', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-pool-expiry-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`pool-expiry-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const owner = await identity.verify(request(session.sessionToken));
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId} = await spaces.create(owner);
  const expiry = Math.floor(Date.now()/1000)+2;
  const claims = {spaceId,collectionId:'unused',capability:'records:read',credentialId:owner.credentialId,
    kind:'session',userPrincipalId:owner.userPrincipalId,cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:expiry-30,expiresAt:expiry,nonce:`wait-${crypto.randomUUID()}`};
  let connections = 0;
  let effects = 0;
  const heldPool = {connect:async () => {
    connections++;
    if (connections === 2) await pause(Math.max(0,expiry*1000-Date.now()+50));
    return pool.connect();
  }};
  const behind = new PostgresCellPolicy(heldPool,'cell-a',identity,() => (expiry-20)*1000);
  await assert.rejects(behind.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(connections,2,'nonce admission precedes the delayed effect connection');
  assert.equal(effects,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1 AND nonce=$2',
    [spaceId,claims.nonce])).rows[0].n,1,'rejected effect cannot replay the consumed assertion');
});

test('database expiry denies later record and external effects and prevents commit', async () => {
  const claims = {spaceId:'space',collectionId:'collection',capability:'records:read',credentialId:'session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:1,expiresAt:30,nonce:'expired-at-boundary'};
  let databaseCurrent = true;
  let commits = 0;
  let recordEffects = 0;
  let externalEffects = 0;
  const client = {query:async sql => {
    if (sql.includes('AS assertion_current')) return {rows:[{assertion_current:databaseCurrent}]};
    if (sql.includes('SELECT s.owner_principal_id')) return {rows:[{owner_principal_id:'owner',lifecycle:'active',
      cell_id:'cell-a',policy_version:1,placement_generation:1,collection_lifecycle:'active'}]};
    if (sql === 'COMMIT') commits++;
    return {rowCount:1};
  },release:() => {}};
  const policy = new PostgresCellPolicy({connect:async () => client},'cell-a',
    {current:async () => true},() => 1000);
  await assert.rejects(policy.run(claims,async (_principal,context) => {
    databaseCurrent = false;
    await context.records({transactionOnClient:async () => { recordEffects++; }},async () => {});
  }),denied('FORBIDDEN'));
  assert.equal(recordEffects,0);
  databaseCurrent = true;
  await assert.rejects(policy.run({...claims,nonce:'external-boundary'},async (_principal,context) => {
    databaseCurrent = false;
    await context.authorizeEffect('read');
    externalEffects++;
  }),denied('FORBIDDEN'));
  assert.equal(externalEffects,0);
  databaseCurrent = true;
  await assert.rejects(policy.run({...claims,nonce:'commit-boundary'},async () => {
    databaseCurrent = false;
  }),denied('FORBIDDEN'));
  assert.equal(commits,0);
});

test('owner audit reads use bounded stable pages and reject cross-space cursors', async () => {
  const current = {current:async () => true};
  const keys = {create:async () => { throw new Error('unused'); },find:async () => null,revoke:async () => {}};
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',keys,current);
  const owner = {kind:'session',credentialId:'owner-session',userPrincipalId:`owner-${crypto.randomUUID()}`};
  const stranger = {kind:'session',credentialId:'other-session',userPrincipalId:`other-${crypto.randomUUID()}`};
  const first = await spaces.create(owner);
  const second = await spaces.create(owner);
  await pool.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,action,policy_version,placement_generation,recorded_at)
    SELECT $1 || lpad(n::text,3,'0'),$2,$3,'audit:page',1,1,clock_timestamp()
    FROM generate_series(1,205) AS n`,[`aud_page_${crypto.randomUUID()}_`,first.spaceId,owner.userPrincipalId]);
  const expected = (await pool.query(`SELECT audit_id FROM space_audit WHERE space_id=$1 ORDER BY recorded_at,audit_id`,
    [first.spaceId])).rows.map(row => row.audit_id);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await spaces.audit(owner,first.spaceId,cursor);
    pages++;
    assert.ok(page.entries.length <= 100);
    assert.equal(page.entries.some(entry => 'cursor_time' in entry),false);
    seen.push(...page.entries.map(entry => entry.audit_id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(pages,3);
  assert.deepEqual(seen,expected,'equal timestamps and page boundaries neither skip nor repeat audit rows');
  const firstPage = await spaces.audit(owner,first.spaceId);
  await assert.rejects(spaces.audit(owner,second.spaceId,firstPage.nextCursor),denied('INVALID_ARGUMENT'));
  await assert.rejects(spaces.audit(owner,first.spaceId,'malformed!'),denied('INVALID_ARGUMENT'));
  await assert.rejects(spaces.audit(stranger,first.spaceId),denied('NOT_FOUND'));
  await spaces.archive(owner,first.spaceId);
  assert.equal((await spaces.audit(owner,first.spaceId)).entries.length,100,
    'archived audit history remains readable and bounded');
});

test('interrupted lifecycle publication reconciles and deleted publication retries', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-publication-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`publication-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const cell = {pool,storageTargetId:'target-a'};
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',cell]]),'cell-a',new AuthFnAgentKeys(config),identity);
  const created = await spaces.create(actor);
  const original = controlPool.query.bind(controlPool);
  let failReadOnly = true;
  controlPool.query = async (sql,...args) => {
    if (failReadOnly && typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4') && args[0]?.[3] === 'readOnly') {
      failReadOnly = false;
      throw new Error('directory offline');
    }
    return original(sql,...args);
  };
  try { await assert.rejects(spaces.archive(actor,created.spaceId),/directory offline/); }
  finally { controlPool.query = original; }
  assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'active');
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[created.spaceId])).rows[0].lifecycle,'readOnly');
  await spaces.archive(actor,created.spaceId);
  assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'readOnly');

  let failSuspended = true;
  controlPool.query = async (sql,...args) => {
    if (failSuspended && typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4') && args[0]?.[3] === 'suspended') {
      failSuspended = false;
      throw new Error('directory offline');
    }
    return original(sql,...args);
  };
  try { await assert.rejects(spaces.update(actor,created.spaceId,'suspended'),/directory offline/); }
  finally { controlPool.query = original; }
  await spaces.update(actor,created.spaceId,'suspended');
  assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'suspended');

  let failDeleted = true;
  controlPool.query = async (sql,...args) => {
    if (failDeleted && typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4') && args[0]?.[3] === 'deleted') {
      failDeleted = false;
      throw new Error('directory offline');
    }
    return original(sql,...args);
  };
  try { await assert.rejects(spaces.delete(actor,created.spaceId),/directory offline/); }
  finally { controlPool.query = original; }
  assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'deleting');
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[created.spaceId])).rows[0].lifecycle,'deleted');
  await spaces.delete(actor,created.spaceId);
  await assert.rejects(spaces.get(actor,created.spaceId),denied('NOT_FOUND'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'",[created.spaceId])).rows[0].n,1);
});

test('lost control publication acknowledgements preserve create and make lifecycle retries idempotent', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-control-ack-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`control-ack-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const original = controlPool.query.bind(controlPool);
  let loseCreateAck = true;
  let loseReadback = false;
  let lostSpaceId;
  let loseLifecycleAck;
  const control = {connect:async () => {
    const client=await controlPool.connect();
    return {query:async (sql,...args) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO space_directory') && loseReadback) lostSpaceId=args[0][0];
      return client.query(sql,...args);
    },release:discard => client.release(discard)};
  },query:async (sql,...args) => {
    if (loseReadback && typeof sql === 'string' && sql === 'SELECT * FROM space_directory WHERE space_id=$1')
      throw new Error('control readback offline');
    const result = await original(sql,...args);
    if (typeof sql === 'string' && sql.includes("UPDATE space_directory SET lifecycle='active'") && loseCreateAck) {
      loseCreateAck = false;
      throw new Error('lost create acknowledgement');
    }
    if (typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4') &&
      args[0]?.[3] === loseLifecycleAck) {
      loseLifecycleAck = undefined;
      throw new Error('lost lifecycle acknowledgement');
    }
    return result;
  }};
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(control,cells,'cell-a',new AuthFnAgentKeys(config),identity);
  const created = await spaces.create(actor);
  assert.equal(created.lifecycle,'active','a committed create returns a live route after its lost acknowledgement');
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[created.spaceId])).rows[0].lifecycle,'active');

  loseCreateAck = true;
  loseReadback = true;
  await assert.rejects(spaces.create(actor),/lost create acknowledgement/);
  loseReadback = false;
  assert.equal((await original('SELECT lifecycle FROM space_directory WHERE space_id=$1',[lostSpaceId])).rows[0].lifecycle,'active');
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[lostSpaceId])).rows[0].lifecycle,'active',
    'an unavailable control readback cannot trigger cell deletion');
  assert.equal((await spaces.reconcile(lostSpaceId)).lifecycle,'active');

  loseLifecycleAck = 'readOnly';
  await spaces.archive(actor,created.spaceId);
  const archiveVersion = (await spaces.get(actor,created.spaceId)).policyVersion;
  await spaces.archive(actor,created.spaceId);
  assert.equal((await spaces.get(actor,created.spaceId)).policyVersion,archiveVersion);
  loseLifecycleAck = 'active';
  await spaces.update(actor,created.spaceId,'active');
  const restoreVersion = (await spaces.get(actor,created.spaceId)).policyVersion;
  await spaces.update(actor,created.spaceId,'active');
  assert.equal((await spaces.get(actor,created.spaceId)).policyVersion,restoreVersion);
  await spaces.archive(actor,created.spaceId);
  loseLifecycleAck = 'deleted';
  await spaces.delete(actor,created.spaceId);
  assert.equal((await original('SELECT lifecycle FROM space_directory WHERE space_id=$1',[created.spaceId])).rows[0].lifecycle,'deleted');
  await spaces.delete(actor,created.spaceId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'",
    [created.spaceId])).rows[0].n,1);
});

test('owner listing retires an interrupted reservation without a cell and publishes a committed cell once', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:'provision-owner'};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}],['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async () => { throw new Error('unexpected key'); },revoke:async () => {}},{current:async () => true});
  const directory=new PostgresRoutingDirectory(controlPool,cells);
  const retired=`sp_${crypto.randomUUID()}`;
  const completed=`sp_${crypto.randomUUID()}`;
  for (const spaceId of [retired,completed]) await controlPool.query(`INSERT INTO space_directory
    (space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','target-a','provisioning')`,[spaceId,actor.userPrincipalId]);
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'cell-a','cell-a','target-a')`,[completed,actor.userPrincipalId]);
  await pool.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
    VALUES($1,$2,$3,$4,'space:create',1,1)`,[`aud_${crypto.randomUUID()}`,completed,actor.userPrincipalId,actor.credentialId]);
  const router=new RegionalRouter({verify:async () => actor},directory,
    new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1'));
  await assert.rejects(router.assertion(new Request('https://gateway.example.invalid'),completed,'collection','records:read'),
    denied('SPACE_UNAVAILABLE'));
  assert.equal((await spaces.list(actor)).some(space => space.spaceId === completed),true);
  assert.equal((await spaces.list(actor)).some(space => space.spaceId === retired),false);
  assert.equal((await directory.lookup(completed)).lifecycle,'active');
  assert.equal((await directory.lookup(retired)).lifecycle,'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[retired])).rows[0].n,0);
  if (databaseNames.length) assert.equal((await cellBPool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=ANY($1)',
    [[retired,completed]])).rows[0].n,0);
  assert.equal((await controlPool.query(`SELECT count(*)::int AS n FROM space_provisioning_audit
    WHERE space_id=$1 AND owner_principal_id=$2 AND action='space:provision-retired'`,
  [retired,actor.userPrincipalId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",
    [completed])).rows[0].n,1);
  assert.equal((await spaces.list({...actor,userPrincipalId:'other-owner'})).some(space => space.spaceId === completed),false);
});

test('erasure mode cannot remove space or retired-provisioning audit rows', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:'audit-owner'};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async () => { throw new Error('unexpected key'); },revoke:async () => {}},{current:async () => true});
  const created=await spaces.create(actor);
  const pending=`sp_${crypto.randomUUID()}`;
  await controlPool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','target-a','provisioning')`,[pending,actor.userPrincipalId]);
  await spaces.list(actor);
  for (const [database,table,spaceId] of [[pool,'space_audit',created.spaceId],
    [controlPool,'space_provisioning_audit',pending]]) {
    const before=(await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n;
    assert.ok(before > 0);
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('stateplane.erasing_space',$1,true)",[spaceId]);
      await assert.rejects(client.query(`DELETE FROM ${table} WHERE space_id=$1`,[spaceId]),
        /space audit rows are immutable/);
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,before);
  }
});

test('unavailable pending cell does not hide healthy spaces in another cell', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:'listing-owner'};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}],['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]);
  const provider={create:async () => { throw new Error('unexpected key'); },revoke:async () => {}};
  const credentials={current:async () => true};
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',provider,credentials);
  const healthy=await spaces.create(actor,'cell-b');
  const pending=`sp_${crypto.randomUUID()}`;
  await controlPool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','target-a','provisioning')`,[pending,actor.userPrincipalId]);
  const unavailable=new Map(cells);
  unavailable.set('cell-a',{storageTargetId:'target-a',pool:{query:async () => { throw new Error('cell-a offline'); }}});
  const listed=await new PostgresSpaces(controlPool,unavailable,'cell-a',provider,credentials).list(actor);
  assert.deepEqual(listed.map(space => space.spaceId),[healthy.spaceId]);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[pending])).rows[0].lifecycle,
    'provisioning');
  const router=new RegionalRouter({verify:async () => actor},new PostgresRoutingDirectory(controlPool,cells),
    new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1'));
  await assert.rejects(router.assertion(new Request('https://gateway.example.invalid'),pending,'collection','records:read'),
    denied('SPACE_UNAVAILABLE'));
  assert.deepEqual((await spaces.list(actor)).map(space => space.spaceId),[healthy.spaceId]);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[pending])).rows[0].lifecycle,
    'deleted');
  assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM space_provisioning_audit WHERE space_id=$1',
    [pending])).rows[0].n,1);
});

test('owner recovery waits for a live create and cannot retire its reserved directory row', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:'concurrent-owner'};
  let releaseReservation;
  const reservationGate=new Promise(resolve => { releaseReservation=resolve; });
  let enteredReservation;
  const reservationEntered=new Promise(resolve => { enteredReservation=resolve; });
  let releaseCell;
  const cellGate=new Promise(resolve => { releaseCell=resolve; });
  let enteredCell;
  const cellEntered=new Promise(resolve => { enteredCell=resolve; });
  let sawPending;
  const pendingRead=new Promise(resolve => { sawPending=resolve; });
  let spaceId;
  const control={connect:async () => {
    const client=await controlPool.connect();
    return {query:async (sql,...args) => {
      const result=await client.query(sql,...args);
      if (typeof sql === 'string' && sql.includes('INSERT INTO space_directory')) {
        spaceId=args[0][0];
        enteredReservation();
        await reservationGate;
      }
      return result;
    },release:discard => client.release(discard)};
  },query:async (sql,...args) => {
    const result=await controlPool.query(sql,...args);
    if (typeof sql === 'string' && sql.includes("lifecycle='provisioning' ORDER BY")) sawPending();
    return result;
  }};
  const gatedCell={storageTargetId:'target-a',pool:{query:(...args) => pool.query(...args),
    connect:async () => {
      const client=await pool.connect();
      return {query:async (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('INSERT INTO spaces(')) {
          enteredCell();
          await cellGate;
        }
        return client.query(...args);
      },release:discard => client.release(discard)};
    }}};
  const spaces=new PostgresSpaces(control,new Map([['cell-a',gatedCell]]),'cell-a',
    {create:async () => { throw new Error('unexpected key'); },revoke:async () => {}},{current:async () => true});
  const creating=spaces.create(actor);
  await reservationEntered;
  const listing=spaces.list(actor);
  await pendingRead;
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
    'provisioning');
  releaseReservation();
  await cellEntered;
  releaseCell();
  const [created,listed]=await Promise.all([creating,listing]);
  assert.equal(created.spaceId,spaceId);
  assert.equal(listed.filter(space => space.spaceId === spaceId).length,1);
  assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM space_provisioning_audit WHERE space_id=$1',
    [spaceId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",
    [spaceId])).rows[0].n,1);
});

test('shared single-connection pool creates and recovers without waiting for itself', {timeout:10_000}, async () => {
  const single=new pg.Pool({connectionString:url,max:1});
  const actor={kind:'session',credentialId:'session',userPrincipalId:'single-pool-owner'};
  const spaces=new PostgresSpaces(single,new Map([['cell-a',{pool:single,storageTargetId:'target-a'}]]),'cell-a',
    {create:async () => { throw new Error('unexpected key'); },revoke:async () => {}},{current:async () => true});
  try {
    const created=await spaces.create(actor);
    assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'active');
    const pending=`sp_${crypto.randomUUID()}`;
    await single.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
      VALUES($1,$2,'cell-a','target-a','provisioning')`,[pending,actor.userPrincipalId]);
    await spaces.list(actor);
    assert.equal((await single.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[pending])).rows[0].lifecycle,
      'deleted');
  } finally { await single.end(); }
});

test('malformed grant arrays fail before issuance or rotation effects', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-grant-shape-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`grant-shape-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const actual = new AuthFnAgentKeys(config);
  let creates = 0;
  const keys = {create:async (...args) => { creates++; return actual.create(...args); },revoke:(...args) => actual.revoke(...args)};
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),'cell-a',keys,identity);
  const {spaceId} = await spaces.create(actor);
  const collectionId = `grant_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const old = await spaces.issueAgentKey(actor,spaceId,expires,[{collectionId,capabilities:['records:read']}]);
  const before = (await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version;
  const decorated = [{collectionId,capabilities:['records:read']}];
  Object.defineProperty(decorated,'extra',{value:true});
  const custom = [{collectionId,capabilities:['records:read']}];
  Object.setPrototypeOf(custom,Object.create(Array.prototype));
  const capabilityExtra = ['records:read'];
  Object.defineProperty(capabilityExtra,'extra',{value:true});
  const capabilityPrototype = ['records:read'];
  Object.setPrototypeOf(capabilityPrototype,Object.create(Array.prototype));
  const hiddenIndex = ['records:read'];
  Object.defineProperty(hiddenIndex,'0',{value:'records:read',enumerable:false});
  const duplicate = [{collectionId,capabilities:['records:read','records:read']}];
  const originalIterator = Array.prototype[Symbol.iterator];
  const withInheritedIterator = operation => {
    Array.prototype[Symbol.iterator] = function* () { yield 'records:read'; yield 'records:write'; };
    try { return operation(); }
    finally { Array.prototype[Symbol.iterator] = originalIterator; }
  };
  for (const malformed of [decorated,custom,[{collectionId,capabilities:capabilityExtra}],
    [{collectionId,capabilities:capabilityPrototype}],[{collectionId,capabilities:hiddenIndex}]]) {
    await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,malformed),denied('INVALID_ARGUMENT'));
    await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,malformed),denied('INVALID_ARGUMENT'));
  }
  await assert.rejects(withInheritedIterator(() => spaces.issueAgentKey(actor,spaceId,expires,duplicate)),denied('INVALID_ARGUMENT'));
  await assert.rejects(withInheritedIterator(() => spaces.rotateAgentKey(actor,spaceId,old.id,expires,duplicate)),denied('INVALID_ARGUMENT'));
  assert.equal(creates,1,'malformed arrays never reach AuthFn creation');
  assert.equal((await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version,before);
  assert.equal((await pool.query('SELECT revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,old.id])).rows[0].revoked_at,null,'malformed rotation leaves the prior key active');
});

test('grant snapshots ignore inherited numeric accessors on issue and rotation', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-grant-accessor-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`grant-accessor-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId} = await spaces.create(actor);
  const collectionId = `accessor_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const grants = [{collectionId,capabilities:['records:read']}];
  let intercepted = 0;
  const withInheritedSlot = operation => {
    Object.defineProperty(Array.prototype,'0',{configurable:true,
      get() { return {collectionId,capabilities:['schema:write']}; },
      set(value) { intercepted++; Object.defineProperty(this,'length',{value:0,writable:true}); }});
    try { return operation(); }
    finally { delete Array.prototype[0]; }
  };
  const first = await withInheritedSlot(() => spaces.issueAgentKey(actor,spaceId,expires,grants));
  const second = await withInheritedSlot(() => spaces.rotateAgentKey(actor,spaceId,first.id,expires,grants));
  assert.equal(intercepted,0,'snapshot and audit arrays never assign through inherited slots');
  for (const key of [first,second]) {
    const saved = (await pool.query('SELECT capabilities FROM collection_grants WHERE space_id=$1 AND credential_id=$2',
      [spaceId,key.id])).rows;
    if (key.id === first.id) assert.equal(saved.length,0,'rotation removes the old grant');
    else assert.deepEqual(saved.map(row => row.capabilities),[['records:read']]);
    const audit = (await pool.query(`SELECT details FROM space_audit WHERE space_id=$1 AND credential_id=$2
      AND action='key:issue-pending'`,[spaceId,key.id])).rows[0];
    assert.deepEqual(audit.details.grants,[{collectionId,capabilities:['records:read'],expiresAt:null}]);
  }
});

test('missing grants never create a key and a raced collection deletion retains failed issuance', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-grant-race-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`grant-race-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const realKeys = new AuthFnAgentKeys(config);
  let creates = 0;
  let issued;
  let deleteAfterCreate = false;
  let providerOffline = false;
  const collectionId = `race_${crypto.randomUUID()}`;
  const keys = {
    create:async (...args) => {
      creates++;
      issued = await realKeys.create(...args);
      if (deleteAfterCreate) {
        await pool.query("UPDATE collections SET lifecycle='deleted' WHERE collection_id=$1",[collectionId]);
        providerOffline = true;
      }
      return issued;
    },
    revoke:async (...args) => {
      if (providerOffline) throw new Error('provider revoke unavailable');
      return realKeys.revoke(...args);
    },
  };
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
  const {spaceId} = await spaces.create(actor);
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const valid = [{collectionId,capabilities:['records:read']}];
  const old = await spaces.issueAgentKey(actor,spaceId,expires,valid);
  const missing = [{collectionId:`missing_${crypto.randomUUID()}`,capabilities:['records:read']}];
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,missing),denied('INVALID_ARGUMENT'));
  await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,missing),denied('INVALID_ARGUMENT'));
  assert.equal(creates,1);
  assert.equal((await pool.query('SELECT revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,old.id])).rows[0].revoked_at,null);

  deleteAfterCreate = true;
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,valid),denied('INVALID_ARGUMENT'));
  deleteAfterCreate = false;
  await pool.query("UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id=$2",[spaceId,collectionId]);
  const failed = (await pool.query(`SELECT activated_at,confirmed_at,revoked_at,provider_revoked_at FROM space_credentials
    WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id])).rows[0];
  assert.ok(failed?.revoked_at,'failed key remains locally tracked and revoked');
  assert.equal(failed.activated_at,null);
  assert.equal(failed.confirmed_at,null);
  assert.equal(failed.provider_revoked_at,null);
  const signer = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router = new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collection_grants WHERE space_id=$1 AND credential_id=$2',
    [spaceId,issued.id])).rows[0].n,0);
  const placement = (await pool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',
    [spaceId])).rows[0];
  const now = Math.floor(Date.now()/1000);
  const assertion = await signer.sign({spaceId,collectionId,capability:'records:read',credentialId:issued.id,kind:'api-key',
    cellId:'cell-a',policyVersion:placement.policy_version,placementGeneration:placement.placement_generation,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
  let effects = 0;
  await assert.rejects(new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',identity))
    .execute(assertion,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2
    AND action IN ('key:created-pending','key:issue-failed')`,[spaceId,issued.id])).rows[0].n,2);
  await assert.rejects(spaces.reconcile(spaceId),/provider revoke unavailable/);
  providerOffline = false;
  await spaces.reconcile(spaceId);
  assert.ok((await pool.query('SELECT provider_revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,issued.id])).rows[0].provider_revoked_at);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
});

test('reconcile and delete refuse a deleted directory with unpurged cell content', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-erasure-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`erasure-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  const spaces = new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId} = await spaces.create(actor);
  const collectionId = `unpurged_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  await controlPool.query("UPDATE space_directory SET lifecycle='deleted' WHERE space_id=$1",[spaceId]);
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'active');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collections WHERE space_id=$1',[spaceId])).rows[0].n,1);
  await pool.query("UPDATE spaces SET lifecycle='deleted' WHERE space_id=$1",[spaceId]);
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
  await pool.query("UPDATE spaces SET lifecycle='active' WHERE space_id=$1",[spaceId]);
  await controlPool.query("UPDATE space_directory SET lifecycle='active' WHERE space_id=$1",[spaceId]);
  await spaces.archive(actor,spaceId);
  await spaces.delete(actor,spaceId);
  await spaces.reconcile(spaceId);
});

test('failed provider creation settles an empty journal for issue and rotation, while uncertain creation stays recoverable', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-create-failure-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`create-failure-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const actual=new AuthFnAgentKeys(config);
  let mode='normal'; let lastIssued; let revokeOffline=false; let findOffline=false;
  const keys={
    create:async (...args) => {
      if (mode==='empty') throw new Error('provider create rejected');
      const issued=await actual.create(...args);
      lastIssued=issued;
      if (mode==='lost-ack') throw new Error('provider create acknowledgement lost');
      return issued;
    },
    find:(...args)=>{if(findOffline) throw new Error('provider lookup offline');return actual.find(...args);},
    revoke:async (...args)=>{if(revokeOffline) throw new Error('provider revoke offline');return actual.revoke(...args);},
  };
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires=new Date(Date.now()+3_600_000);
  const grants=[{collectionId,capabilities:['records:read']}];
  mode='empty';findOffline=true;
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,grants),/provider create rejected/);
  let journal=(await controlPool.query(`SELECT credential_id,provider_revoked_at,settled_without_key_at,create_failed_at
    FROM agent_key_issuances WHERE space_id=$1 ORDER BY created_at`,[spaceId])).rows;
  assert.equal(journal.length,1);
  assert.equal(journal[0].credential_id,null);
  assert.equal(journal[0].provider_revoked_at,null);
  assert.equal(journal[0].settled_without_key_at,null);
  assert.ok(journal[0].create_failed_at);
  await assert.rejects(spaces.reconcile(spaceId),/provider lookup offline/);
  findOffline=false;
  await spaces.reconcile(spaceId);
  assert.ok((await controlPool.query(`SELECT settled_without_key_at FROM agent_key_issuances
    WHERE space_id=$1`,[spaceId])).rows[0].settled_without_key_at);
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,grants),/provider create rejected/);
  mode='normal';
  const old=await spaces.issueAgentKey(actor,spaceId,expires,grants);
  mode='empty';
  await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants),/provider create rejected/);
  journal=(await controlPool.query(`SELECT credential_id,settled_without_key_at
    FROM agent_key_issuances WHERE space_id=$1 AND credential_id IS NULL`,[spaceId])).rows;
  assert.equal(journal.length,3);
  assert.ok(journal.every(row=>row.settled_without_key_at));
  await spaces.reconcile(spaceId);
  const signer=new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  await assert.rejects(router.assertion(request(old.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
  mode='lost-ack';revokeOffline=true;
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,grants),/provider create acknowledgement lost/);
  await assert.rejects(router.assertion(request(lastIssued.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
  journal=(await controlPool.query(`SELECT credential_id,settled_without_key_at FROM agent_key_issuances
    WHERE space_id=$1 AND credential_id=$2`,[spaceId,lastIssued.id])).rows;
  assert.equal(journal.length,1);
  assert.equal(journal[0].settled_without_key_at,null);
  await assert.rejects(spaces.reconcile(spaceId),/provider revoke offline/);
  revokeOffline=false;
  await spaces.reconcile(spaceId);
  await assert.rejects(router.assertion(request(lastIssued.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
  await spaces.archive(actor,spaceId);
  await spaces.delete(actor,spaceId);
  await spaces.delete(actor,spaceId);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1
    AND action='space:deleted'`,[spaceId])).rows[0].n,1);
});

test('reconcile fails closed when the configured cell is missing or points at another database', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-missing-cell-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`missing-cell-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const actual=new AuthFnAgentKeys(config);
  const correct=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),'cell-a',actual,identity);
  const {spaceId}=await correct.create(actor);
  const wrong=new PostgresSpaces(controlPool,new Map([['cell-a',{pool:cellBPool,storageTargetId:'target-a'}]]),
    'cell-a',actual,identity);
  await assert.rejects(wrong.reconcile(spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'active');
  assert.equal((await correct.reconcile(spaceId)).lifecycle,'active');
  const missingPool={query:(sql,args)=>typeof sql==='string' && sql.includes('SELECT * FROM spaces WHERE space_id=$1')
    ? Promise.resolve({rows:[],rowCount:0}) : pool.query(sql,args),connect:()=>pool.connect()};
  const missing=new PostgresSpaces(controlPool,new Map([['cell-a',{pool:missingPool,storageTargetId:'target-a'}]]),
    'cell-a',actual,identity);
  await assert.rejects(missing.reconcile(spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'active');
  assert.equal((await correct.reconcile(spaceId)).lifecycle,'active');
});

test('interrupted create with no settled outcome blocks erasure until provider readback can settle it', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-create-stop-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`create-stop-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const keys=new AuthFnAgentKeys(config);
  const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const issuanceId=`iss_${crypto.randomUUID()}`;
  await controlPool.query(`INSERT INTO agent_key_issuances(issuance_id,space_id,owner_principal_id,cell_id)
    VALUES($1,$2,$3,'cell-a')`,[issuanceId,spaceId,user.id]);
  await spaces.archive(actor,spaceId);
  await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleting');
  assert.equal((await controlPool.query(`SELECT settled_without_key_at FROM agent_key_issuances
    WHERE issuance_id=$1`,[issuanceId])).rows[0].settled_without_key_at,null);
  // A durable provider failure outcome plus a fresh empty lookup resolves the
  // interrupted journal; an empty lookup alone was insufficient above.
  await controlPool.query(`UPDATE agent_key_issuances SET create_failed_at=clock_timestamp()
    WHERE issuance_id=$1`,[issuanceId]);
  await spaces.delete(actor,spaceId);
  assert.ok((await controlPool.query(`SELECT settled_without_key_at FROM agent_key_issuances
    WHERE issuance_id=$1`,[issuanceId])).rows[0].settled_without_key_at);
  await assert.rejects(spaces.get(actor,spaceId),denied('NOT_FOUND'));
});

test('reconcile preserves confirmed agent grants across interrupted archive publication and restore', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-archive-reconcile-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`archive-reconcile-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const actual=new AuthFnAgentKeys(config);
  let revocations=0;let publicationOffline=false;
  const keys={create:(...args)=>actual.create(...args),find:(...args)=>actual.find(...args),
    revoke:async (...args)=>{revocations++;return actual.revoke(...args);}};
  const control={connect:() => controlPool.connect(),query:async (sql,args)=>{
    if (publicationOffline && typeof sql==='string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4'))
      throw new Error('publication offline');
    return controlPool.query(sql,args);
  }};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(control,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const issued=await spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]);
  publicationOffline=true;
  await assert.rejects(spaces.archive(actor,spaceId),/publication offline/);
  publicationOffline=false;
  assert.equal((await spaces.reconcile(spaceId)).lifecycle,'readOnly');
  assert.equal(revocations,0);
  const signer=new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',identity));
  const route=()=>router.assertion(request(issued.secret),spaceId,collectionId,'records:read');
  assert.equal(await cell.execute((await route()).token,async()=> 'read'),'read');
  await spaces.restore(actor,spaceId);
  assert.equal(await cell.execute((await route()).token,async()=> 'read'),'read');
  assert.equal(revocations,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1
    AND action='key:provider-revoke'`,[spaceId])).rows[0].n,0);
});

test('deletion racing provider creation retains cleanup authority through provider outage', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-delete-create-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`delete-create-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const realKeys=new AuthFnAgentKeys(config);
  let issued; let providerOffline=false; let race=false;
  const keys={
    create:async (...args) => {
      issued=await realKeys.create(...args);
      if (race) {
        await spaces.archive(actor,spaceId);
        providerOffline=true;
        await assert.rejects(spaces.delete(actor,spaceId),/provider unavailable/);
      }
      return issued;
    },
    find:(...args) => realKeys.find(...args),
    revoke:async (...args) => { if (providerOffline) throw new Error('provider unavailable'); return realKeys.revoke(...args); },
  };
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  race=true;
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]),/provider unavailable|STALE_PLACEMENT/);
  const pending=(await controlPool.query(`SELECT credential_id,provider_revoked_at FROM agent_key_issuances
    WHERE space_id=$1`,[spaceId])).rows;
  assert.deepEqual(pending.map(row=>row.credential_id),[issued.id]);
  assert.equal(pending[0].provider_revoked_at,null);
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleting');
  const signer=new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
  await assert.rejects(spaces.reconcile(spaceId),/provider unavailable/);
  providerOffline=false;
  await spaces.reconcile(spaceId);
  await spaces.delete(actor,spaceId);
  await spaces.delete(actor,spaceId);
  assert.ok((await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances
    WHERE space_id=$1`,[spaceId])).rows[0].provider_revoked_at);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM space_credentials WHERE space_id=$1',[spaceId])).rows[0].n,0);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'`,
    [spaceId])).rows[0].n,1);
});

test('cell staging outage after AuthFn creation remains discoverable and revocable', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-stage-outage-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`stage-outage-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const realKeys=new AuthFnAgentKeys(config);
  let issued; let stageOffline=false; let providerOffline=false;
  const keys={
    create:async (...args) => { issued=await realKeys.create(...args); stageOffline=true; providerOffline=true; return issued; },
    find:(...args) => realKeys.find(...args),
    revoke:async (...args) => { if (providerOffline) throw new Error('provider unavailable'); return realKeys.revoke(...args); },
  };
  const cell={pool:{query:(...args)=>pool.query(...args),connect:() => {
    if (stageOffline) throw new Error('cell staging unavailable');
    return pool.connect();
  }},storageTargetId:'target-a'};
  const cells=new Map([['cell-a',cell]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]),/cell staging unavailable/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM space_credentials WHERE credential_id=$1',[issued.id])).rows[0].n,0);
  assert.equal((await controlPool.query(`SELECT credential_id FROM agent_key_issuances WHERE space_id=$1`,
    [spaceId])).rows[0].credential_id,issued.id);
  const signer=new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
  stageOffline=false;
  await assert.rejects(spaces.reconcile(spaceId),/provider unavailable/);
  providerOffline=false;
  await spaces.reconcile(spaceId);
  assert.ok((await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances WHERE space_id=$1`,
    [spaceId])).rows[0].provider_revoked_at);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
});

test('lost journal key-ID write recovers the AuthFn key by issuance correlation', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-id-write-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`id-write-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const actual=new AuthFnAgentKeys(config);
  let issued; let unavailable=true; let loseIdWrite=true;
  const keys={create:async (...args)=>{issued=await actual.create(...args);return issued;},
    find:(...args)=>actual.find(...args),
    revoke:async (...args)=>{if(unavailable) throw new Error('provider unavailable');return actual.revoke(...args);}};
  const control={connect:() => controlPool.connect(),query:async (sql,args)=>{
    if (loseIdWrite && typeof sql==='string' && sql.includes('UPDATE agent_key_issuances SET credential_id=$2')) {
      loseIdWrite=false;
      throw new Error('control ID write unavailable');
    }
    return controlPool.query(sql,args);
  }};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(control,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]),/control ID write unavailable/);
  const journal=(await controlPool.query('SELECT credential_id FROM agent_key_issuances WHERE space_id=$1',[spaceId])).rows[0];
  assert.equal(journal.credential_id,null);
  const signer=new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
  await assert.rejects(spaces.reconcile(spaceId),/provider unavailable/);
  unavailable=false;
  await spaces.reconcile(spaceId);
  const resolved=(await controlPool.query(`SELECT credential_id,provider_revoked_at FROM agent_key_issuances
    WHERE space_id=$1`,[spaceId])).rows[0];
  assert.equal(resolved.credential_id,issued.id);
  assert.ok(resolved.provider_revoked_at);
  await assert.rejects(router.assertion(request(issued.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
});

test('failed issuance and rotation never expose grants after publication and provider outages', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-failed-key-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`failed-key-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const owner = await identity.verify(request(session.sessionToken));
  const realProvider = new AuthFnAgentKeys(config);
  let issued;
  let providerOffline = false;
  const provider = {
    create:async (...args) => { issued = await realProvider.create(...args); return issued; },
    revoke:async (...args) => { if (providerOffline) throw new Error('provider revoke offline'); return realProvider.revoke(...args); },
  };
  const originalQuery = controlPool.query.bind(controlPool);
  let directoryOffline = false;
  const control = {connect:() => controlPool.connect(),query:async (sql,...args) => {
    if (directoryOffline && typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4')) {
      throw new Error('directory publish offline');
    }
    return originalQuery(sql,...args);
  }};
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(control,cells,'cell-a',provider,identity);
  const {spaceId} = await spaces.create(owner);
  const collectionId = `failed_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const grants = [{collectionId,capabilities:['records:read']}];
  const signer = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router = new RegionalRouter(identity,new PostgresRoutingDirectory(control,cells),signer);
  const cell = new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',identity));
  const route = secret => router.assertion(request(secret),spaceId,collectionId,'records:read');
  let effects = 0;
  async function assertFailedKeyIsDenied() {
    const row = (await pool.query(`SELECT sc.revoked_at,sc.activated_at,sc.provider_revoked_at,
      (SELECT count(*)::int FROM collection_grants g WHERE g.space_id=sc.space_id AND g.credential_id=sc.credential_id) AS grants
      FROM space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2`,[spaceId,issued.id])).rows[0];
    assert.ok(row.revoked_at,'failed issuance is locally revoked');
    assert.equal(row.activated_at,null);
    assert.equal(row.provider_revoked_at,null,'failed provider cleanup remains retryable');
    assert.equal(row.grants,0);
    await assert.rejects(route(issued.secret),denied('NOT_FOUND'));
    const placement = (await pool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId])).rows[0];
    const now = Math.floor(Date.now()/1000);
    const token = await signer.sign({spaceId,collectionId,capability:'records:read',credentialId:issued.id,kind:'api-key',
      cellId:'cell-a',policyVersion:placement.policyVersion,placementGeneration:placement.placementGeneration,
      audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
    await assert.rejects(cell.execute(token,async () => { effects++; }),denied('FORBIDDEN'));
    assert.equal(effects,0);
  }

  directoryOffline = true; providerOffline = true;
  await assert.rejects(spaces.issueAgentKey(owner,spaceId,expires,grants),/directory publish offline/);
  directoryOffline = false;
  await assertFailedKeyIsDenied();
  await assert.rejects(spaces.reconcile(spaceId),/provider revoke offline/);
  providerOffline = false;
  await spaces.reconcile(spaceId);
  assert.ok((await pool.query('SELECT provider_revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,issued.id])).rows[0].provider_revoked_at);
  await assert.rejects(route(issued.secret),denied('UNAUTHENTICATED'));

  const old = await spaces.issueAgentKey(owner,spaceId,expires,grants);
  directoryOffline = true; providerOffline = true;
  await assert.rejects(spaces.rotateAgentKey(owner,spaceId,old.id,expires,grants),/provider revoke offline/);
  // Rotation's old key is locally denied even when its provider revoke failed.
  directoryOffline = false;
  await assert.rejects(route(old.secret),denied('NOT_FOUND'));
  // Retry old-key revocation, then fail publication of the newly issued key.
  providerOffline = false;
  await spaces.revokeAgentKey(owner,spaceId,old.id);
  directoryOffline = true; providerOffline = true;
  await assert.rejects(spaces.rotateAgentKey(owner,spaceId,old.id,expires,grants),/directory publish offline/);
  directoryOffline = false;
  await assertFailedKeyIsDenied();
  providerOffline = false;
  await spaces.reconcile(spaceId);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2
    AND action='key:issue-failed'`,[spaceId,issued.id])).rows[0].n,1);
});

test('lost issuance acknowledgements keep unconfirmed issue and rotation keys inert and repairable', async () => {
  const config = {database:memoryAdapter(),namespace:`sta6-ack-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user = await createUser(config,{primaryEmail:`ack-${crypto.randomUUID()}@example.invalid`});
  const session = await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity = new AuthFnIdentityVerifier(config);
  const actor = await identity.verify(request(session.sessionToken));
  let revokeCalls = 0;
  let providerOffline = true;
  let offlineAfterCreate = false;
  let issued;
  const realKeys = new AuthFnAgentKeys(config);
  const keys = {
    create:async (...args) => { issued=await realKeys.create(...args); if (offlineAfterCreate) { providerOffline=true; compensationOffline=true; } return issued; },
    revoke:async (...args) => { revokeCalls++; if (providerOffline) throw new Error('provider unavailable'); return realKeys.revoke(...args); },
  };
  let loseAck = false;
  let loseConfirmationAck = false;
  let readbackOffline = false;
  let compensationOffline = false;
  let compensationCalls = 0;
  const cellPool = {
    query:(...args) => {
      if (readbackOffline && typeof args[0] === 'string' && args[0].includes('SELECT activated_at,revoked_at FROM space_credentials'))
        throw new Error('cell readback unavailable');
      return pool.query(...args);
    },
    connect:async () => {
      const client = await pool.connect();
      let activated = false;
      let confirmed = false;
      return {
        query:async (...args) => {
          const sql = args[0];
          if (typeof sql === 'string' && sql.includes('UPDATE space_credentials SET activated_at=')) activated=true;
          if (typeof sql === 'string' && sql.includes('UPDATE space_credentials SET confirmed_at=')) confirmed=true;
          if (compensationOffline && typeof sql === 'string' && sql.includes('UPDATE space_credentials SET revoked_at=')) {
            compensationCalls++;
            throw new Error('cell compensation unavailable');
          }
          const result = await client.query(...args);
          if (sql === 'COMMIT' && activated && loseAck) { loseAck=false; throw new Error('lost activation acknowledgement'); }
          if (sql === 'COMMIT' && confirmed && loseConfirmationAck) { loseConfirmationAck=false; throw new Error('lost confirmation acknowledgement'); }
          return result;
        },
        release:discard => client.release(discard),
      };
    },
  };
  const cells = new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
  const {spaceId} = await spaces.create(actor);
  const collectionId = `ack_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const grants = [{collectionId,capabilities:['records:read']}];
  loseAck=true;
  const first = await spaces.issueAgentKey(actor,spaceId,expires,grants);
  assert.equal(compensationCalls,0);
  assert.equal(revokeCalls,0);
  assert.ok((await pool.query('SELECT activated_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,first.id])).rows[0].activated_at);
  const signer = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router = new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  assert.ok((await router.assertion(request(first.secret),spaceId,collectionId,'records:read')).token);
  // Rotation first revokes the old provider primitive.
  providerOffline=false;
  loseAck=true;
  const second = await spaces.rotateAgentKey(actor,spaceId,first.id,expires,grants);
  assert.notEqual(second.id,first.id);
  assert.ok((await router.assertion(request(second.secret),spaceId,collectionId,'records:read')).token);
  await assert.rejects(router.assertion(request(first.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));

  const cell = new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',identity));
  let effects = 0;
  async function assertUnconfirmedDenied() {
    const key = issued;
    const row = (await pool.query(`SELECT activated_at,confirmed_at,revoked_at,provider_revoked_at,
      (SELECT count(*)::int FROM collection_grants g WHERE g.space_id=sc.space_id AND g.credential_id=sc.credential_id) AS grants
      FROM space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2`,[spaceId,key.id])).rows[0];
    assert.ok(row.activated_at,'activation really committed despite the lost acknowledgement');
    assert.equal(row.confirmed_at,null,'unconfirmed activation is inert');
    assert.equal(row.revoked_at,null,'cell compensation was unavailable');
    assert.equal(row.provider_revoked_at,null,'provider compensation was unavailable');
    assert.equal(row.grants,1);
    await assert.rejects(router.assertion(request(key.secret),spaceId,collectionId,'records:read'),denied('NOT_FOUND'));
    const placement = (await pool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId])).rows[0];
    const now = Math.floor(Date.now()/1000);
    const token = await signer.sign({spaceId,collectionId,capability:'records:read',credentialId:key.id,kind:'api-key',
      cellId:'cell-a',policyVersion:placement.policyVersion,placementGeneration:placement.placementGeneration,
      audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
    await assert.rejects(cell.execute(token,async () => { effects++; }),denied('FORBIDDEN'));
    assert.equal(effects,0);
  }
  async function repairFailedIssuance() {
    const keyId=issued.id;
    compensationOffline=false;
    await assert.rejects(spaces.reconcile(spaceId),/provider unavailable/);
    assert.ok((await pool.query('SELECT revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
      [spaceId,keyId])).rows[0].revoked_at);
    providerOffline=false;
    await spaces.reconcile(spaceId);
    assert.ok((await pool.query('SELECT provider_revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
      [spaceId,keyId])).rows[0].provider_revoked_at);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2
      AND action='key:issue-failed'`,[spaceId,keyId])).rows[0].n,1);
  }

  loseAck=true; readbackOffline=true; compensationOffline=true; providerOffline=true;
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,expires,grants),/cell readback unavailable/);
  readbackOffline=false;
  await assertUnconfirmedDenied();
  await repairFailedIssuance();

  loseAck=true; readbackOffline=true; compensationOffline=false; offlineAfterCreate=true;
  await assert.rejects(spaces.rotateAgentKey(actor,spaceId,second.id,expires,grants),/cell readback unavailable/);
  readbackOffline=false; offlineAfterCreate=false;
  await assertUnconfirmedDenied();
  await repairFailedIssuance();
  await assert.rejects(router.assertion(request(second.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));

  loseConfirmationAck=true;
  const uncertain = await spaces.issueAgentKey(actor,spaceId,expires,grants);
  assert.equal(uncertain.confirmation,'unknown');
  assert.ok((await router.assertion(request(uncertain.secret),spaceId,collectionId,'records:read')).token,
    'a confirmed key is returned rather than reported as a failed issuance after its acknowledgement is lost');
});

test('signing key rotation retains then retires old assertions', async () => {
  const v1 = crypto.getRandomValues(new Uint8Array(32));
  const v2 = crypto.getRandomValues(new Uint8Array(32));
  const old = new RoutingKeys([{id:'old',secret:v1}],'old');
  const claims = {spaceId:'space',collectionId:'collection',capability:'records:read',credentialId:'session',kind:'session',
    userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:100,expiresAt:130,nonce:'nonce'};
  const token = await old.sign(claims);
  const rotating = new RoutingKeys([{id:'old',secret:v1},{id:'new',secret:v2}],'new');
  assert.equal((await rotating.verify(token,'cell-a',101)).spaceId,'space');
  await assert.rejects(new RoutingKeys([{id:'new',secret:v2}],'new').verify(token,'cell-a',101),denied('FORBIDDEN'));
});

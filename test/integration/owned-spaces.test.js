import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnIdentityVerifier, AuthFnAgentKeys } from '../../packages/auth/dist/index.js';
import { RegionalRouter, RegionalCell, RoutingKeys } from '../../packages/application/dist/index.js';
import { PostgresAuthority, PostgresSpaces, PostgresRoutingDirectory, PostgresCellPolicy, CommitOutcomeUnknownError } from '../../packages/postgres/dist/index.js';

async function collectSpaces(spaces,actor) {
  const items=[];
  for await (const item of spaces.list(actor)) items.push(item);
  return items;
}

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
async function cellSpace(...collectionIds) {
  const spaceId=`sp_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  for (const collectionId of collectionIds) await collection(spaceId,collectionId);
  return spaceId;
}
function signRecordRoute(signer,spaceId,collectionId,credentialId='owner-session') {
  const now=Math.floor(Date.now()/1000);
  const identity=credentialId==='owner-session' ? {kind:'session',userPrincipalId:'owner'} : {kind:'api-key'};
  return signer.sign({spaceId,collectionId,capability:'records:write',credentialId,...identity,
    cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
}
const request = secret => new Request('https://gateway.example.invalid',{headers:{Authorization:`Bearer ${secret}`}});
const denied = code => error => error?.code === code;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
function controlWithQueryHook(hook) {
  return {
    query:(sql,...args)=>hook(sql,args,()=>controlPool.query(sql,...args)),
    connect:async () => {
      const client=await controlPool.connect();
      return {
        query:(sql,...args)=>hook(sql,args,()=>client.query(sql,...args)),
        release:discard=>client.release(discard),
      };
    },
  };
}

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
  assert.equal(first.homeCellId,'cell-a');
  assert.equal(second.homeCellId,'cell-b');
  if (databaseNames.length) {
    assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM spaces')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[second.spaceId])).rows[0].n,0);
    assert.equal((await cellBPool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[first.spaceId])).rows[0].n,0);
  }
  assert.deepEqual((await collectSpaces(spaces,owner)).map(space => space.spaceId).sort(),[first.spaceId,second.spaceId].sort());
  assert.equal((await spaces.get(owner,first.spaceId)).homeCellId,'cell-a');
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
  assert.equal((await spaces.get(adminActor,first.spaceId)).homeCellId,'cell-a');
  await assert.rejects(spaces.archive(adminActor,first.spaceId),denied('FORBIDDEN'));
  await assert.rejects(spaces.get(adminActor,second.spaceId),denied('NOT_FOUND'),
    'an admin grant on another space cannot disclose this space');
  await assert.rejects(spaces.get(adminActor,`sp_${crypto.randomUUID()}`),denied('NOT_FOUND'));
  const unknownCellSpaces=new PostgresSpaces(controlPool,new Map([['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]),
    'cell-b',keyProvider,identity);
  await assert.rejects(unknownCellSpaces.get(adminActor,first.spaceId),denied('NOT_FOUND'));
  await assert.rejects(spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read','schema:unknown']}]),denied('INVALID_ARGUMENT'));
  const signing = await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
    () => collectSpaces(spaces,transientActor),
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
  await assert.rejects(spaces.rotateAgentKey(owner,first.spaceId,rotateRetryKey.id,expires,
    [{collectionId:c1,capabilities:['records:read']}]),denied('STALE_PLACEMENT'));
  await spaces.revokeAgentKey(owner,first.spaceId,rotateRetryKey.id);
  const freshRotationSource = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  const rotatedRetry = await spaces.rotateAgentKey(owner,first.spaceId,freshRotationSource.id,expires,
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
  assert.equal((await collectSpaces(spaces,owner)).length,1);
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
  let raced = false;
  const racedControl=controlWithQueryHook(async (sql,args,next) => {
    if (!raced && typeof sql === 'string' && sql.includes('UPDATE space_directory SET lifecycle=$2,policy_version=$3')) {
      raced = true;
      await controlPool.query("UPDATE space_directory SET policy_version=policy_version+1,lifecycle='suspended' WHERE space_id=$1",[second.spaceId]);
    }
    return next();
  });
  const racedSpaces=new PostgresSpaces(racedControl,cells,'cell-a',keyProvider,identity);
  await assert.rejects(racedSpaces.reconcile(second.spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[second.spaceId])).rows[0].lifecycle,'suspended');
});

test('stable home metadata survives a different current cell and placement fencing', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`home-owner-${crypto.randomUUID()}`};
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  const credentialId=`home-admin-${crypto.randomUUID()}`;
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}],['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async () => { throw new Error('unexpected provider create'); },find:async () => null,revoke:async () => {}},
    {current:async () => true});
  await cellBPool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'cell-a','cell-b','target-b')`,[spaceId,actor.userPrincipalId]);
  await controlPool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','cell-b','target-b','active')`,[spaceId,actor.userPrincipalId]);
  await collection(spaceId,collectionId,cellBPool);
  await cellBPool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
    VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
  [spaceId,credentialId,`agent-${credentialId}`,actor.userPrincipalId]);
  await cellBPool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['space:admin']::text[])`,[spaceId,collectionId,credentialId]);
  for (const metadata of [await spaces.get(actor,spaceId),
    (await collectSpaces(spaces,actor)).find(row => row.spaceId === spaceId),
    await spaces.get({kind:'api-key',credentialId},spaceId)]) {
    assert.equal(metadata.homeCellId,'cell-a');
    assert.equal(metadata.cellId,'cell-b');
  }
  assert.equal(await spaces.fencePlacement(spaceId,'cell-b',1),2);
  assert.equal((await spaces.reconcile(spaceId)).homeCellId,'cell-a');
  assert.equal((await spaces.get({kind:'api-key',credentialId},spaceId)).placementGeneration,2);
  await controlPool.query("UPDATE space_directory SET home_cell_id='wrong-home' WHERE space_id=$1",[spaceId]);
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  await controlPool.query("UPDATE space_directory SET home_cell_id='cell-a' WHERE space_id=$1",[spaceId]);
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
  const keys = await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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

test('archived outbox jobs drain under current worker scope, while suspension and deletion close admission', async () => {
  const actor={kind:'session',credentialId:'owner-session',userPrincipalId:`owner-${crypto.randomUUID()}`};
  const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',{}, {current:async()=>true});
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const authority=new PostgresAuthority(pool,60);
  const scope={spaceId,collectionId,principalId:actor.userPrincipalId,credentialId:actor.credentialId,
    capability:'records:write',policyVersion:1,placementGeneration:1};
  for (let index=0;index<3;index++) await authority.mutate(scope,{operation:'create',
    idempotencyKey:`outbox-${index}`,requestDigest:String(index).repeat(64),canonicalData:'{}'});
  const worker=version=>({...scope,principalId:'system:projection',credentialId:'system:projection',
    capability:'outbox:worker',policyVersion:version});
  const [leased]=await authority.transaction(worker(1),tx=>tx.claimOutbox(1,30));
  await spaces.archive(actor,spaceId);
  await assert.rejects(authority.mutate({...scope,policyVersion:2},{operation:'create',
    idempotencyKey:'archived-write',requestDigest:'f'.repeat(64),canonicalData:'{}'}),denied('SPACE_UNAVAILABLE'));
  await assert.rejects(authority.transaction(worker(1),tx=>tx.finishOutbox(leased,true)),denied('FORBIDDEN'));
  for (const bad of [{principalId:'agent'},{credentialId:'agent'}])
    await assert.rejects(authority.transaction({...worker(2),...bad},tx=>tx.claimOutbox(1,30)),denied('FORBIDDEN'));
  assert.equal(await authority.transaction(worker(2),tx=>tx.finishOutbox(leased,true)),true);
  const [retry]=await authority.transaction(worker(2),tx=>tx.claimOutbox(1,30));
  assert.equal(await authority.transaction(worker(2),tx=>tx.finishOutbox(retry,false,'temporary failure')),true);
  await pool.query("UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[retry.eventId]);
  const [again]=await authority.transaction(worker(2),tx=>tx.claimOutbox(1,30));
  assert.equal(again.eventId,retry.eventId);
  assert.equal(await authority.transaction(worker(2),tx=>tx.finishOutbox(retry,true)),false);
  assert.equal(await authority.transaction(worker(2),tx=>tx.finishOutbox(again,true)),true);
  assert.deepEqual((await pool.query(`SELECT delivery_state,attempts FROM projection_outbox
    WHERE space_id=$1 ORDER BY attempts DESC,delivery_state`,[spaceId])).rows,
    [{delivery_state:'delivered',attempts:2},{delivery_state:'delivered',attempts:1},
      {delivery_state:'pending',attempts:0}]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_events WHERE space_id=$1',[spaceId])).rows[0].n,3);
  await spaces.suspend(actor,spaceId);
  await assert.rejects(authority.transaction(worker(3),tx=>tx.claimOutbox(1,30)),denied('SPACE_UNAVAILABLE'));
  await assert.rejects(authority.transaction(worker(3),tx=>tx.finishOutbox(again,true)),denied('SPACE_UNAVAILABLE'));
  await spaces.restore(actor,spaceId);
  const [beforeDelete]=await authority.transaction(worker(4),tx=>tx.claimOutbox(1,30));
  assert.ok(beforeDelete);
  await spaces.archive(actor,spaceId);
  await spaces.delete(actor,spaceId);
  await assert.rejects(authority.transaction(worker(6),tx=>tx.finishOutbox(beforeDelete,true)),
    error=>['SPACE_UNAVAILABLE','NOT_FOUND'].includes(error?.code));
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'",
    [spaceId])).rows[0].n,1);
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
    if (sql.includes('AS assertion_current')) return {rows:[{assertion_current:true,current_receipts:0}]};
    if (sql.includes('SELECT s.owner_principal_id')) return {rows:[{owner_principal_id:'owner',lifecycle:'active',cell_id:'cell-a',
      policy_version:1,placement_generation:1,collection_lifecycle:'active',validity_ms:claims.expiresAt*1000-now}]};
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
  for (const operation of [() => spaces.create(actor),() => collectSpaces(spaces,actor),
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
    [spaceId,`expired_${index}`,-now]);
  const claims = {spaceId,collectionId:'collection',capability:'records:read',credentialId:'key',kind:'api-key',
    cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:now-30,expiresAt:now-5,nonce:'replay'};
  let effects = 0;
  // The Worker is behind Postgres and would accept this assertion by its own clock.
  const behind = new PostgresCellPolicy(pool,'cell-a',{current:async () => true},() => (now-20)*1000);
  await assert.rejects(behind.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
  const remaining=(await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1',[spaceId])).rows[0].n;
  assert.ok(remaining<=8,'admission prunes at least 32 expired rows; other concurrent admissions may prune more');
  assert.ok(await behind.cleanupExpiredNonces()<=32,'each cleanup call stays bounded');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1',[spaceId])).rows[0].n,0);
  await assert.rejects(behind.run(claims,async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0,'a pruned nonce cannot be replayed while the Worker clock lags');
  const ahead = new PostgresCellPolicy(pool,'cell-a',{current:async () => true},() => (now+60)*1000);
  await assert.rejects(ahead.run({...claims,expiresAt:now+30,nonce:'worker-ahead'},async () => { effects++; }),denied('FORBIDDEN'));
  assert.equal(effects,0);
});

test('nonce admission racing space erasure cannot repopulate a deleted space', {timeout:10000}, async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let admissionStarted;
  const started=new Promise(resolve=>{admissionStarted=resolve;});
  const admissionPool={connect:async()=>{const client=await pool.connect();return {query:(...args)=>{
    if (typeof args[0]==='string' && args[0].includes('INSERT INTO routing_nonces')) admissionStarted();
    return client.query(...args);
  },release:discard=>client.release(discard)};}};
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(admissionPool,'cell-a',{current:async()=>true}));
  const eraser=await pool.connect();
  let effects=0;
  try {
    await eraser.query('BEGIN');
    await eraser.query("UPDATE spaces SET lifecycle='deleting',policy_version=policy_version+1 WHERE space_id=$1",[spaceId]);
    const attempt=cell.execute(await signRecordRoute(signer,spaceId,collectionId),async()=>{effects++;});
    await Promise.race([started,pause(3000).then(()=>{throw new Error('Nonce admission did not reach SQL');})]);
    await eraser.query('SELECT stateplane_purge_space($1)',[spaceId]);
    await eraser.query('COMMIT');
    await assert.rejects(attempt,denied('NOT_FOUND'));
    await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async()=>{effects++;}),
      denied('NOT_FOUND'));
  } catch (error) {
    await eraser.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { eraser.release(); }
  assert.equal(effects,0);
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1',[spaceId])).rows[0].n,0);
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
  let connections = 0;
  let effectCommits = 0;
  let recordEffects = 0;
  let externalEffects = 0;
  const client = {query:async sql => {
    if (sql.includes('AS assertion_current')) return {rows:[{assertion_current:databaseCurrent}]};
    if (sql.includes('SELECT s.owner_principal_id')) return {rows:[{owner_principal_id:'owner',lifecycle:'active',
      cell_id:'cell-a',policy_version:1,placement_generation:1,collection_lifecycle:'active'}]};
    if (sql === 'COMMIT' && connections % 2 === 0) effectCommits++;
    return {rowCount:1};
  },release:() => {}};
  const policy = new PostgresCellPolicy({connect:async () => {connections++;return client;}},'cell-a',
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
  assert.equal(effectCommits,0);
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
  const crafted = recordedAt => Buffer.from(JSON.stringify({spaceId:first.spaceId,recordedAt,
    auditId:'aud_cursor'})).toString('base64url');
  for (const invalid of ['2026-02-30T00:00:00.000000Z','2025-02-29T00:00:00.000000Z',
    '2026-04-31T00:00:00.000000Z','2026-13-01T00:00:00.000000Z','0000-01-01T00:00:00.000000Z']) {
    await assert.rejects(spaces.audit(owner,first.spaceId,crafted(invalid)),denied('INVALID_ARGUMENT'),invalid);
  }
  await spaces.audit(owner,first.spaceId,crafted('2024-02-29T23:59:59.123456Z'));
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
  try { await assert.rejects(spaces.archive(actor,created.spaceId),{name:'CommitOutcomeUnknownError'}); }
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
  try { await assert.rejects(spaces.update(actor,created.spaceId,'suspended'),{name:'CommitOutcomeUnknownError'}); }
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
    (space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','cell-a','target-a','provisioning')`,[spaceId,actor.userPrincipalId]);
  // Migration 025 cannot fill a split-control reservation before cell readback.
  await controlPool.query('UPDATE space_directory SET home_cell_id=NULL WHERE space_id=$1',[completed]);
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'cell-a','cell-a','target-a')`,[completed,actor.userPrincipalId]);
  await pool.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
    VALUES($1,$2,$3,$4,'space:create',1,1)`,[`aud_${crypto.randomUUID()}`,completed,actor.userPrincipalId,actor.credentialId]);
  const router=new RegionalRouter({verify:async () => actor},directory,
    await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1'));
  await assert.rejects(router.assertion(new Request('https://gateway.example.invalid'),completed,'collection','records:read'),
    denied('SPACE_UNAVAILABLE'));
  assert.equal((await collectSpaces(spaces,actor)).some(space => space.spaceId === completed),true);
  assert.equal((await spaces.get(actor,completed)).homeCellId,'cell-a');
  assert.equal((await controlPool.query('SELECT home_cell_id FROM space_directory WHERE space_id=$1',
    [completed])).rows[0].home_cell_id,'cell-a');
  assert.equal((await collectSpaces(spaces,actor)).some(space => space.spaceId === retired),false);
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
  assert.equal((await collectSpaces(spaces,{...actor,userPrincipalId:'other-owner'})).some(space => space.spaceId === completed),false);
  const unverified=`sp_${crypto.randomUUID()}`;
  await controlPool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
    VALUES($1,$2,'cell-a','target-a','provisioning')`,[unverified,actor.userPrincipalId]);
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'wrong-home','cell-a','target-a')`,[unverified,actor.userPrincipalId]);
  await pool.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
    VALUES($1,$2,$3,$4,'space:create',1,1)`,[`aud_${crypto.randomUUID()}`,unverified,actor.userPrincipalId,actor.credentialId]);
  const stillPending=async () => {
    assert.equal((await collectSpaces(spaces,actor)).some(space => space.spaceId === unverified),false);
    assert.deepEqual((await controlPool.query('SELECT lifecycle,home_cell_id FROM space_directory WHERE space_id=$1',
      [unverified])).rows[0],{lifecycle:'provisioning',home_cell_id:null});
  };
  await stillPending();
  await pool.query("UPDATE spaces SET home_cell_id='cell-a',owner_principal_id='wrong-owner' WHERE space_id=$1",[unverified]);
  await stillPending();
  await pool.query("UPDATE spaces SET owner_principal_id=$2,storage_target_id='wrong-target' WHERE space_id=$1",
    [unverified,actor.userPrincipalId]);
  await stillPending();
  await pool.query("UPDATE spaces SET storage_target_id='target-a' WHERE space_id=$1",[unverified]);
  assert.equal((await collectSpaces(spaces,actor)).find(space => space.spaceId === unverified)?.homeCellId,'cell-a');
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
  await collectSpaces(spaces,actor);
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
    const truncate = await database.connect();
    try {
      await truncate.query('BEGIN');
      await assert.rejects(truncate.query(`TRUNCATE ${table}`),/space audit rows are immutable/);
    } finally { await truncate.query('ROLLBACK'); truncate.release(); }
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,before);
  }
});

test('unavailable pending cell does not hide healthy spaces in another cell', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`listing-owner-${crypto.randomUUID()}`};
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
  const listed=await collectSpaces(new PostgresSpaces(controlPool,unavailable,'cell-a',provider,credentials),actor);
  assert.deepEqual(listed.map(space => space.spaceId),[healthy.spaceId]);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[pending])).rows[0].lifecycle,
    'provisioning');
  const router=new RegionalRouter({verify:async () => actor},new PostgresRoutingDirectory(controlPool,cells),
    await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1'));
  await assert.rejects(router.assertion(new Request('https://gateway.example.invalid'),pending,'collection','records:read'),
    denied('SPACE_UNAVAILABLE'));
  assert.deepEqual((await collectSpaces(spaces,actor)).map(space => space.spaceId),[healthy.spaceId]);
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
    if (typeof sql === 'string' && sql.includes("owner_principal_id=$1 AND lifecycle<>'deleted'")) sawPending();
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
  const listing=collectSpaces(spaces,actor);
  await pendingRead;
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
    'provisioning');
  releaseReservation();
  await cellEntered;
  releaseCell();
  const [created,listed]=await Promise.all([creating,listing]);
  assert.equal(created.spaceId,spaceId);
  assert.ok(listed.filter(space => space.spaceId === spaceId).length <= 1);
  assert.equal((await collectSpaces(spaces,actor)).filter(space => space.spaceId === spaceId).length,1);
  assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM space_provisioning_audit WHERE space_id=$1',
    [spaceId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",
    [spaceId])).rows[0].n,1);
});

test('provisioning recovery waits for its database claim and retires only after expiry', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`claim-owner-${crypto.randomUUID()}`};
  const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),'cell-a',
    {create:async () => { throw new Error('unexpected key'); },find:async () => null,revoke:async () => {}},
    {current:async () => true});
  const spaceId=`sp_${crypto.randomUUID()}`;
  await controlPool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,
    lifecycle,provisioning_lease_until) VALUES($1,$2,'cell-a','target-a','provisioning',clock_timestamp()+interval '60 seconds')`,
  [spaceId,actor.userPrincipalId]);
  assert.deepEqual(await collectSpaces(spaces,actor),[]);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
    'provisioning');
  await controlPool.query(`UPDATE space_directory SET provisioning_lease_until=clock_timestamp()-interval '1 second'
    WHERE space_id=$1`,[spaceId]);
  assert.deepEqual(await collectSpaces(spaces,actor),[]);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
    'deleted');
  assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM space_provisioning_audit WHERE space_id=$1',
    [spaceId])).rows[0].n,1);
});

test('selected space create retries recover failed cell insert and lost cell acknowledgement', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`retry-owner-${crypto.randomUUID()}`};
  const provider={create:async () => { throw new Error('unexpected key'); },revoke:async () => {}};
  let granted=true;
  const credentials={current:async () => granted};
  let failInsert=true;
  let loseCommit=false;
  const unreliableCell={storageTargetId:'target-a',pool:{query:(...args)=>pool.query(...args),connect:async()=>{
    const client=await pool.connect();
    return {query:async (sql,...args)=>{
      if (typeof sql==='string' && sql.includes('INSERT INTO spaces(') && failInsert) {
        failInsert=false;
        throw new Error('cell insert offline');
      }
      const result=await client.query(sql,...args);
      if (sql==='COMMIT' && loseCommit) {
        loseCommit=false;
        throw new Error('cell commit acknowledgement lost');
      }
      return result;
    },release:discard=>client.release(discard)};
  }}};
  const cells=new Map([['cell-a',unreliableCell],['cell-b',{pool:cellBPool,storageTargetId:'target-b'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',provider,credentials);
  const first=`sp_${crypto.randomUUID()}`;
  await assert.rejects(spaces.create(actor,'cell-a',first),denied('RECEIPT_PENDING'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[first])).rows[0].lifecycle,'provisioning');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[first])).rows[0].n,0);
  await assert.rejects(spaces.get(actor,first),denied('NOT_FOUND'));
  assert.equal((await collectSpaces(spaces,actor)).some(space=>space.spaceId===first),false);
  await assert.rejects(spaces.create({...actor,userPrincipalId:'other-owner'},'cell-a',first),denied('UNIQUE_CONFLICT'));
  await assert.rejects(spaces.create(actor,'cell-b',first),denied('UNIQUE_CONFLICT'));
  granted=false;
  await assert.rejects(spaces.create(actor,'cell-a',first),denied('FORBIDDEN'));
  granted=true;
  assert.equal((await spaces.create(actor,'cell-a',first)).lifecycle,'active');
  assert.equal((await spaces.create(actor,'cell-a',first)).spaceId,first);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",[first])).rows[0].n,1);

  const second=`sp_${crypto.randomUUID()}`;
  loseCommit=true;
  await assert.rejects(spaces.create(actor,'cell-a',second),denied('RECEIPT_PENDING'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[second])).rows[0].n,1);
  assert.equal((await spaces.create(actor,'cell-a',second)).lifecycle,'active');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",[second])).rows[0].n,1);
});

test('selected retry races lease recovery under one directory lock', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`lease-owner-${crypto.randomUUID()}`};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async () => { throw new Error('unexpected key'); },revoke:async () => {}},{current:async () => true});
  const absent=`sp_${crypto.randomUUID()}`;
  const committed=`sp_${crypto.randomUUID()}`;
  const retired=`sp_${crypto.randomUUID()}`;
  const malformed=`sp_${crypto.randomUUID()}`;
  for (const id of [absent,committed,retired,malformed]) await controlPool.query(`INSERT INTO space_directory
    (space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,provisioning_lease_until)
    VALUES($1,$2,'cell-a','cell-a','target-a','provisioning',clock_timestamp()-interval '1 second')`,[id,actor.userPrincipalId]);
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'cell-a','cell-a','target-a')`,[committed,actor.userPrincipalId]);
  await pool.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
    VALUES($1,$2,$3,$4,'space:create',1,1)`,[`aud_${crypto.randomUUID()}`,committed,actor.userPrincipalId,actor.credentialId]);
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,$2,'cell-a','cell-a','target-a')`,[malformed,actor.userPrincipalId]);
  await assert.rejects(spaces.create(actor,'cell-a',malformed),denied('STALE_PLACEMENT'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[malformed])).rows[0].lifecycle,'provisioning');
  assert.equal((await spaces.create(actor,'cell-a',committed)).lifecycle,'active');
  let signal,release;
  const selected=new Promise(resolve=>{signal=resolve;});
  const proceed=new Promise(resolve=>{release=resolve;});
  const racingControl={connect:()=>controlPool.connect(),query:async(sql,...args)=>{
    const result=await controlPool.query(sql,...args);
    if (String(sql).includes("owner_principal_id=$1 AND lifecycle<>'deleted'")) {
      signal();await proceed;
    }
    return result;
  }};
  const racing=new PostgresSpaces(racingControl,cells,'cell-a',
    {create:async()=>{throw new Error('unexpected key');},revoke:async()=>{}},{current:async()=>true});
  const listing=collectSpaces(racing,actor);
  await selected;
  const creating=racing.create(actor,'cell-a',absent);
  release();
  const [creation,list]=await Promise.allSettled([creating,listing]);
  assert.equal(list.status,'fulfilled');
  const lifecycle=(await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[absent])).rows[0].lifecycle;
  assert.ok(['active','deleted'].includes(lifecycle));
  if (lifecycle==='active') {
    assert.equal(creation.status,'fulfilled');
    assert.equal(creation.value.spaceId,absent);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:create'",[absent])).rows[0].n,1);
  } else {
    assert.equal(creation.status,'rejected');
    assert.equal(creation.reason.code,'UNIQUE_CONFLICT');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM spaces WHERE space_id=$1',[absent])).rows[0].n,0);
  }
  assert.equal((await collectSpaces(spaces,actor)).some(space=>space.spaceId===retired),false);
  await assert.rejects(spaces.create(actor,'cell-a',retired),denied('UNIQUE_CONFLICT'));
  assert.equal((await controlPool.query('SELECT count(*)::int AS n FROM space_provisioning_audit WHERE space_id=$1',[retired])).rows[0].n,1);
});

test('shared single-connection pool creates, issues, rotates and reconciles without waiting for itself', {timeout:10_000}, async () => {
  const single=new pg.Pool({connectionString:url,max:1});
  const actor={kind:'session',credentialId:'session',userPrincipalId:'single-pool-owner'};
  let nextKey=0;
  const revoked=[];
  const keys={create:async () => ({id:`single-key-${++nextKey}`,secret:`secret-${nextKey}`}),
    find:async () => null,revoke:async id => { revoked.push(id); }};
  const spaces=new PostgresSpaces(single,new Map([['cell-a',{pool:single,storageTargetId:'target-a'}]]),'cell-a',
    keys,{current:async () => true});
  try {
    const created=await spaces.create(actor);
    assert.equal((await spaces.get(actor,created.spaceId)).lifecycle,'active');
    const collectionId=`single_${crypto.randomUUID()}`;
    await collection(created.spaceId,collectionId,single);
    const expiry=new Date(Date.now()+3_600_000);
    const grants=[{collectionId,capabilities:['records:read']}];
    const first=await spaces.issueAgentKey(actor,created.spaceId,expiry,grants);
    assert.equal(first.id,'single-key-1');
    await spaces.reconcile(created.spaceId);
    const second=await spaces.rotateAgentKey(actor,created.spaceId,first.id,expiry,grants);
    assert.equal(second.id,'single-key-2');
    assert.deepEqual(revoked,['single-key-1']);
    assert.equal((await spaces.reconcile(created.spaceId)).lifecycle,'active');
    const pending=`sp_${crypto.randomUUID()}`;
    await single.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle)
      VALUES($1,$2,'cell-a','target-a','provisioning')`,[pending,actor.userPrincipalId]);
    await collectSpaces(spaces,actor);
    assert.equal((await single.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[pending])).rows[0].lifecycle,
      'deleted');
  } finally { await single.end(); }
});

test('paused provider creation leaves a one-connection pool available to archive and cancel deletion',
  {timeout:10_000}, async () => {
    const single=new pg.Pool({connectionString:url,max:1});
    const actor={kind:'session',credentialId:'session',userPrincipalId:`paused-${crypto.randomUUID()}`};
    let entered; let release;
    const atProvider=new Promise(resolve => { entered=resolve; });
    const providerGate=new Promise(resolve => { release=resolve; });
    let providerKey;
    const revoked=[];
    const keys={create:async (_owner,_expiry,issuanceId) => {
      entered(); await providerGate;
      providerKey={id:`paused-key-${crypto.randomUUID()}`,secret:'unused',issuanceId};
      return providerKey;
    },find:async () => providerKey?.id ?? null,revoke:async id => { revoked.push(id); }};
    const spaces=new PostgresSpaces(single,new Map([['cell-a',{pool:single,storageTargetId:'target-a'}]]),
      'cell-a',keys,{current:async () => true});
    try {
      const {spaceId}=await spaces.create(actor);
      const collectionId=`paused_${crypto.randomUUID()}`;
      await collection(spaceId,collectionId,single);
      const issuing=spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
        [{collectionId,capabilities:['records:read']}]);
      await atProvider;
      await spaces.archive(actor,spaceId);
      await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
      assert.equal((await single.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleting');
      assert.ok((await single.query(`SELECT cancelled_at FROM agent_key_issuances WHERE space_id=$1`,
        [spaceId])).rows[0].cancelled_at);
      release();
      await assert.rejects(issuing,denied('STALE_PLACEMENT'));
      assert.deepEqual(revoked,[providerKey.id]);
      await spaces.delete(actor,spaceId);
      assert.equal((await single.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
        'deleted');
      assert.equal((await single.query('SELECT count(*)::int AS n FROM space_credentials WHERE space_id=$1',
        [spaceId])).rows[0].n,0);
    } finally { release?.(); await single.end(); }
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
  const signer = await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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

test('deleted cell with retained records cannot publish until owner repairs erasure', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:'repair-owner'};
  const stranger={kind:'session',credentialId:'session',userPrincipalId:'other-owner'};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async () => { throw new Error('unexpected key'); },find:async () => null,revoke:async () => {}},
    {current:async () => true});
  const {spaceId}=await spaces.create(actor);
  const collectionId=`repair_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  await pool.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,
    normalized_key,canonical_data,data) VALUES($1,$2,$3,1,1,'generated',$3,'{}','{}')`,
  [spaceId,collectionId,`record_${crypto.randomUUID()}`]);
  await controlPool.query("UPDATE space_directory SET lifecycle='deleting' WHERE space_id=$1",[spaceId]);
  await pool.query("UPDATE spaces SET lifecycle='deleted' WHERE space_id=$1",[spaceId]);
  const before=(await pool.query('SELECT audit_id,action FROM space_audit WHERE space_id=$1 ORDER BY recorded_at,audit_id',
    [spaceId])).rows;
  await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.repairDeletedErasure(stranger,spaceId),denied('NOT_FOUND'));
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,
    'deleting','unproven erasure cannot publish deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT audit_id,action FROM space_audit WHERE space_id=$1 ORDER BY recorded_at,audit_id',
    [spaceId])).rows,before,'failed publication does not invent a deletion audit');

  await spaces.repairDeletedErasure(actor,spaceId);
  await spaces.delete(actor,spaceId);
  await spaces.delete(actor,spaceId);
  await spaces.reconcile(spaceId);
  assert.equal((await controlPool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collections WHERE space_id=$1',[spaceId])).rows[0].n,0);
  const actions=(await pool.query('SELECT action FROM space_audit WHERE space_id=$1',[spaceId])).rows.map(row => row.action);
  assert.equal(actions.filter(action => action==='space:erasure-repair').length,1);
  assert.equal(actions.filter(action => action==='space:deleted').length,1);
  await spaces.repairDeletedErasure(actor,spaceId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:erasure-repair'",
    [spaceId])).rows[0].n,1,'replayed repair cannot repeat its audit');

  // An inconsistent restore can also introduce data after directory publication.
  const restoredCollection=`restored_${crypto.randomUUID()}`;
  await collection(spaceId,restoredCollection);
  await assert.rejects(spaces.delete(actor,spaceId),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  await spaces.repairDeletedErasure(actor,spaceId);
  await spaces.delete(actor,spaceId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collections WHERE space_id=$1',[spaceId])).rows[0].n,0);
  assert.equal((await controlPool.query('SELECT policy_version FROM space_directory WHERE space_id=$1',[spaceId])).rows[0].policy_version,
    (await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version,
    'retry publishes the repaired tombstone version');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'",
    [spaceId])).rows[0].n,1,'repair of a published tombstone cannot duplicate deletion');
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
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
  if (databaseNames.length) await assert.rejects(wrong.reconcile(spaceId),denied('STALE_PLACEMENT'));
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
  await assert.rejects(spaces.archive(actor,spaceId),{name:'CommitOutcomeUnknownError'});
  publicationOffline=false;
  assert.equal((await spaces.reconcile(spaceId)).lifecycle,'readOnly');
  assert.equal(revocations,0);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
    [{collectionId,capabilities:['records:read']}]),error =>
      denied('STALE_PLACEMENT')(error) || /provider unavailable/.test(error?.message));
  const pending=(await controlPool.query(`SELECT credential_id,provider_revoked_at FROM agent_key_issuances
    WHERE space_id=$1`,[spaceId])).rows;
  assert.deepEqual(pending.map(row=>row.credential_id),[issued.id]);
  assert.equal(pending[0].provider_revoked_at,null);
  assert.equal((await pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId])).rows[0].lifecycle,'deleting');
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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

test('issuance staging and deletion or erasure repair serialize without late credentials', async () => {
  for (const order of ['delete-first','stage-first','repair-first']) {
    const config={database:memoryAdapter(),namespace:`sta6-issue-delete-${order}-${crypto.randomUUID()}`,plugins:[]};
    createAuthFn(config);
    const user=await createUser(config,{primaryEmail:`issue-delete-${crypto.randomUUID()}@example.invalid`});
    const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
    const identity=new AuthFnIdentityVerifier(config);
    const actor=await identity.verify(request(session.sessionToken));
    const realKeys=new AuthFnAgentKeys(config);
    let issued; let revocations=0; let reached; let release;
    const atBoundary=new Promise(resolve => { reached=resolve; });
    const resume=new Promise(resolve => { release=resolve; });
    const keys={
      create:async (...args) => {
        issued=await realKeys.create(...args);
        if (order !== 'stage-first') { reached(); await resume; }
        return issued;
      },
      find:(...args) => realKeys.find(...args),
      revoke:async (...args) => { revocations++; return realKeys.revoke(...args); },
    };
    const cellPool=order === 'stage-first' ? {
      query:(...args) => pool.query(...args),
      connect:async () => {
        const client=await pool.connect();
        let staged=false;
        return {
          query:async (...args) => {
            const sql=args[0];
            if (typeof sql === 'string' && sql.includes("'key:created-pending'")) staged=true;
            const result=await client.query(...args);
            if (sql === 'COMMIT' && staged) { staged=false; reached(); await resume; }
            return result;
          },
          release:discard => client.release(discard),
        };
      },
    } : pool;
    const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]),
      'cell-a',keys,identity);
    const {spaceId}=await spaces.create(actor);
    const collectionId=`race_${crypto.randomUUID()}`;
    await collection(spaceId,collectionId);
    await pool.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,
      normalized_key,canonical_data,data) VALUES($1,$2,$3,1,1,'generated',$3,'{}','{}')`,
    [spaceId,collectionId,`record_${crypto.randomUUID()}`]);
    const issuance=spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
      [{collectionId,capabilities:['records:read']}]);
    await atBoundary;
    try {
      await spaces.archive(actor,spaceId);
      if (order === 'repair-first') {
        // An interrupted restore left a deleted cell tombstone with content.
        await controlPool.query("UPDATE space_directory SET lifecycle='deleting' WHERE space_id=$1",[spaceId]);
        await pool.query("UPDATE spaces SET lifecycle='deleted' WHERE space_id=$1",[spaceId]);
        await spaces.repairDeletedErasure(actor,spaceId);
      }
      await spaces.delete(actor,spaceId);
      const directoryBefore=(await controlPool.query(`SELECT lifecycle,policy_version,placement_generation
        FROM space_directory WHERE space_id=$1`,[spaceId])).rows[0];
      const cellBefore=(await pool.query(`SELECT lifecycle,policy_version,placement_generation
        FROM spaces WHERE space_id=$1`,[spaceId])).rows[0];
      const auditsBefore=(await pool.query('SELECT audit_id,action FROM space_audit WHERE space_id=$1 ORDER BY audit_id',
        [spaceId])).rows;
      assert.equal(directoryBefore.lifecycle,'deleted');
      assert.equal(cellBefore.lifecycle,'deleted');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM space_credentials WHERE space_id=$1',[spaceId])).rows[0].n,0);
      const journalBefore=(await controlPool.query(`SELECT cancelled_at,provider_revoked_at FROM agent_key_issuances
        WHERE space_id=$1`,[spaceId])).rows[0];
      assert.ok(journalBefore.cancelled_at || journalBefore.provider_revoked_at,
        'deletion durably cancels or revokes the paused issuer before regional erasure');
      release();
      await assert.rejects(issuance,denied('STALE_PLACEMENT'));
      assert.ok(revocations > 0,'provider key was revoked');
      assert.equal(await identity.verify(request(issued.secret)),null);
      assert.deepEqual((await controlPool.query(`SELECT lifecycle,policy_version,placement_generation
        FROM space_directory WHERE space_id=$1`,[spaceId])).rows[0],directoryBefore);
      assert.deepEqual((await pool.query(`SELECT lifecycle,policy_version,placement_generation
        FROM spaces WHERE space_id=$1`,[spaceId])).rows[0],cellBefore);
      assert.deepEqual((await pool.query('SELECT audit_id,action FROM space_audit WHERE space_id=$1 ORDER BY audit_id',
        [spaceId])).rows,auditsBefore,'late compensation cannot mutate deleted audit');
      for (const table of ['space_credentials','collection_grants','collections','records'])
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
      assert.ok((await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances
        WHERE space_id=$1`,[spaceId])).rows[0].provider_revoked_at);
      await spaces.delete(actor,spaceId);
      await spaces.reconcile(spaceId);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND action='space:deleted'",
        [spaceId])).rows[0].n,1);
    } finally { release(); }
  }
});

test('live issue and rotation cannot be revoked by reconciliation before staging or confirmation', async () => {
  for (const operation of ['issue','rotate']) for (const boundary of ['staging','confirmation']) {
    const config={database:memoryAdapter(),namespace:`sta6-reconcile-issue-${crypto.randomUUID()}`,plugins:[]};
    createAuthFn(config);
    const user=await createUser(config,{primaryEmail:`reconcile-issue-${crypto.randomUUID()}@example.invalid`});
    const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
    const identity=new AuthFnIdentityVerifier(config);
    const actor=await identity.verify(request(session.sessionToken));
    const realKeys=new AuthFnAgentKeys(config);
    let armed=false; let issued; let revocations=0; let reached; let release;
    const atBoundary=new Promise(resolve => { reached=resolve; });
    const resume=new Promise(resolve => { release=resolve; });
    const keys={
      create:async (...args) => {
        issued=await realKeys.create(...args);
        if (armed && boundary==='staging') { reached(); await resume; }
        return issued;
      },
      find:(...args)=>realKeys.find(...args),
      revoke:async (...args)=>{ revocations++; return realKeys.revoke(...args); },
    };
    const cellPool={
      query:(...args)=>pool.query(...args),
      connect:async () => {
        const client=await pool.connect();
        return {
          query:async (...args) => {
            if (armed && boundary==='confirmation' && typeof args[0]==='string' &&
              args[0].includes('UPDATE space_credentials SET confirmed_at=')) {
              reached(); await resume;
            }
            return client.query(...args);
          },
          release:discard=>client.release(discard),
        };
      },
    };
    const cells=new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]);
    const spaces=new PostgresSpaces(controlPool,cells,'cell-a',keys,identity);
    const {spaceId}=await spaces.create(actor);
    const collectionId=`race_${crypto.randomUUID()}`;
    await collection(spaceId,collectionId);
    const expires=new Date(Date.now()+3_600_000);
    const grants=[{collectionId,capabilities:['records:read']}];
    const old=operation==='rotate' ? await spaces.issueAgentKey(actor,spaceId,expires,grants) : null;
    armed=true;
    const pending=operation==='rotate'
      ? spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants)
      : spaces.issueAgentKey(actor,spaceId,expires,grants);
    await atBoundary;
    try {
      await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
      assert.equal((await identity.verify(request(issued.secret)))?.credentialId,issued.id,
        'provider key remains present while its issuer is live');
      assert.equal(revocations,operation==='rotate' ? 1 : 0,
        'reconciliation did not revoke the new provider key');
    } finally { release(); }
    const result=await pending;
    assert.equal(result.id,issued.id);
    const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
    const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
    assert.ok((await router.assertion(request(result.secret),spaceId,collectionId,'records:read')).token);
    const local=(await pool.query(`SELECT activated_at,confirmed_at,revoked_at,
      (SELECT count(*)::int FROM collection_grants g WHERE g.space_id=sc.space_id AND g.credential_id=sc.credential_id) AS grants
      FROM space_credentials sc WHERE sc.space_id=$1 AND sc.credential_id=$2`,[spaceId,result.id])).rows[0];
    assert.ok(local.activated_at && local.confirmed_at);
    assert.equal(local.revoked_at,null);
    assert.equal(local.grants,1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
      WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,result.id])).rows[0].n,0);
    assert.equal((await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances
      WHERE space_id=$1 AND credential_id=$2`,[spaceId,result.id])).rows[0].provider_revoked_at,null);
    assert.equal((await spaces.reconcile(spaceId)).policyVersion,
      Number((await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version));
  }
});

test('reconciliation revokes a retained issuance after its bounded claim expires', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-issuer-stop-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`issuer-stop-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const keys=new AuthFnAgentKeys(config);
  const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const issuanceId=`iss_${crypto.randomUUID()}`;
  await controlPool.query(`UPDATE space_directory
    SET issuance_lease_token=$2,issuance_lease_until=clock_timestamp()+interval '60 seconds'
    WHERE space_id=$1`,[spaceId,'stopped-process']);
  await controlPool.query(`INSERT INTO agent_key_issuances(issuance_id,space_id,owner_principal_id,cell_id)
    VALUES($1,$2,$3,'cell-a')`,[issuanceId,spaceId,user.id]);
  const key=await keys.create(user.id,new Date(Date.now()+3_600_000),issuanceId);
  await controlPool.query('UPDATE agent_key_issuances SET credential_id=$2 WHERE issuance_id=$1',[issuanceId,key.id]);
  assert.equal((await identity.verify(request(key.secret)))?.credentialId,key.id);
  await assert.rejects(spaces.reconcile(spaceId),denied('STALE_PLACEMENT'));
  assert.equal((await identity.verify(request(key.secret)))?.credentialId,key.id);
  await controlPool.query(`UPDATE space_directory SET issuance_lease_until=clock_timestamp()-interval '1 second'
    WHERE space_id=$1`,[spaceId]);
  await spaces.reconcile(spaceId);
  assert.equal(await identity.verify(request(key.secret)),null);
  assert.ok((await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances
    WHERE issuance_id=$1`,[issuanceId])).rows[0].provider_revoked_at);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM space_credentials WHERE space_id=$1',[spaceId])).rows[0].n,0);
  await spaces.reconcile(spaceId);
});

test('expired live issuance cannot stage after reconciliation reclaims its provider key', {timeout:10_000}, async () => {
  const single=new pg.Pool({connectionString:url,max:1});
  const actor={kind:'session',credentialId:'session',userPrincipalId:`expired-${crypto.randomUUID()}`};
  let entered; let release;
  const atProvider=new Promise(resolve => { entered=resolve; });
  const providerGate=new Promise(resolve => { release=resolve; });
  const active=new Set();
  const keyId=`expired-key-${crypto.randomUUID()}`;
  const keys={create:async () => { active.add(keyId); entered(); await providerGate; return {id:keyId,secret:'unused'}; },
    find:async () => active.has(keyId) ? keyId : null,
    revoke:async id => { active.delete(id); }};
  const spaces=new PostgresSpaces(single,new Map([['cell-a',{pool:single,storageTargetId:'target-a'}]]),
    'cell-a',keys,{current:async () => true});
  let issuing;
  try {
    const {spaceId}=await spaces.create(actor);
    const collectionId=`expired_${crypto.randomUUID()}`;
    await collection(spaceId,collectionId,single);
    issuing=spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
      [{collectionId,capabilities:['records:read']}]);
    await atProvider;
    await single.query(`UPDATE space_directory SET issuance_lease_until=clock_timestamp()-interval '1 second'
      WHERE space_id=$1`,[spaceId]);
    await spaces.reconcile(spaceId);
    assert.equal(active.has(keyId),false);
    release();
    await assert.rejects(issuing,denied('STALE_PLACEMENT'));
    assert.equal((await single.query('SELECT count(*)::int AS n FROM space_credentials WHERE space_id=$1',
      [spaceId])).rows[0].n,0);
    assert.ok((await single.query(`SELECT provider_revoked_at FROM agent_key_issuances WHERE space_id=$1`,
      [spaceId])).rows[0].provider_revoked_at);
  } finally { release?.(); await issuing?.catch(() => {}); await single.end(); }
});

test('expired reconciliation cannot revoke an issue or rotation confirmed by the successor claim',
  {timeout:20_000}, async () => {
    for (const topology of ['separate','shared-one']) for (const operation of ['issue','rotate']) {
      const single=topology === 'shared-one' ? new pg.Pool({connectionString:url,max:1}) : null;
      const database=single ?? pool;
      const directory=single ?? controlPool;
      const actor={kind:'session',credentialId:'session',userPrincipalId:`lease-race-${crypto.randomUUID()}`};
      const active=new Set();
      const correlations=new Map();
      const revoked=[];
      let serial=0;
      const keys={
        create:async (_owner,_expiry,issuanceId) => {
          const id=`lease-key-${crypto.randomUUID()}-${++serial}`;
          correlations.set(issuanceId,id); active.add(id);
          return {id,secret:`secret-${id}`};
        },
        find:async (_owner,issuanceId) => correlations.get(issuanceId) ?? null,
        revoke:async id => { revoked.push(id); active.delete(id); },
      };
      let armed=false; let pauseConfirmation=false; let pendingRead; let releasePending; let staleRead; let releaseStale;
      let beforeConfirmation; let releaseConfirmation; let activationCommitted=false;
      const pendingGate=new Promise(resolve => { releasePending=resolve; });
      const staleGate=new Promise(resolve => { releaseStale=resolve; });
      const confirmationGate=new Promise(resolve => { releaseConfirmation=resolve; });
      const atPending=new Promise(resolve => { pendingRead=resolve; });
      const atStale=new Promise(resolve => { staleRead=resolve; });
      const atConfirmation=new Promise(resolve => { beforeConfirmation=resolve; });
      const proxy={
        query:async (...args) => {
          const sql=args[0];
          if (armed && typeof sql === 'string' && sql.includes('FROM agent_key_issuances WHERE space_id=$1') &&
            sql.includes('ORDER BY created_at')) {
            armed=false; pendingRead(); await pendingGate;
          }
          const result=await directory.query(...args);
          if (typeof sql === 'string' && sql.includes('SELECT sc.confirmed_at,sc.revoked_at,s.lifecycle') &&
            args[1]?.[1] === correlations.get(newIssuanceId)) {
            staleRead(); await staleGate;
          }
          return result;
        },
        connect:async () => {
          if (activationCommitted) {
            activationCommitted=false;
            if (pauseConfirmation) { pauseConfirmation=false; beforeConfirmation(); await confirmationGate; }
          }
          const client=await database.connect();
          let activating=false;
          return {query:async (...args) => {
            if (typeof args[0] === 'string' && args[0].includes('UPDATE space_credentials SET activated_at='))
              activating=true;
            const result=await client.query(...args);
            if (args[0] === 'COMMIT' && activating) { activating=false; activationCommitted=true; }
            return result;
          },release:discard => client.release(discard)};
        },
      };
      // With one connection the same proxy is both control and cell. With
      // separate databases only control queries use the directory wrapper.
      const control=topology === 'shared-one' ? proxy : {query:proxy.query,connect:() => directory.connect()};
      const cellPool=topology === 'shared-one' ? proxy : {
        query:async (...args) => {
          const result=await database.query(...args);
          if (typeof args[0] === 'string' && args[0].includes('SELECT sc.confirmed_at,sc.revoked_at,s.lifecycle') &&
            args[1]?.[1] === correlations.get(newIssuanceId)) {
            staleRead(); await staleGate;
          }
          return result;
        },
        connect:proxy.connect,
      };
      const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]),
        'cell-a',keys,{current:async () => true});
      let newIssuanceId;
      let reconciling; let issuing;
      try {
        const {spaceId}=await spaces.create(actor);
        const collectionId=`lease_${crypto.randomUUID()}`;
        await collection(spaceId,collectionId,database);
        const expires=new Date(Date.now()+3_600_000);
        const grants=[{collectionId,capabilities:['records:read']}];
        const old=operation==='rotate' ? await spaces.issueAgentKey(actor,spaceId,expires,grants) : null;
        const revokedBefore=revoked.length;
        armed=true;
        pauseConfirmation=true;
        reconciling=spaces.reconcile(spaceId);
        await atPending;
        await directory.query(`UPDATE space_directory SET issuance_lease_until=clock_timestamp()-interval '1 second'
          WHERE space_id=$1`,[spaceId]);
        issuing=operation==='rotate'
          ? spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants)
          : spaces.issueAgentKey(actor,spaceId,expires,grants);
        await atConfirmation;
        newIssuanceId=[...correlations.keys()].at(-1);
        releasePending();
        await atStale;
        releaseConfirmation();
        const result=await issuing;
        assert.equal(result.id,correlations.get(newIssuanceId));
        assert.equal(active.has(result.id),true,'provider key survives stale reconciliation');
        releaseStale();
        await assert.rejects(reconciling,denied('STALE_PLACEMENT'));
        assert.equal(active.has(result.id),true);
        assert.equal(revoked.length,revokedBefore+(operation==='rotate' ? 1 : 0));
        const journal=(await directory.query(`SELECT completed_at,cancelled_at,provider_revoked_at
          FROM agent_key_issuances WHERE issuance_id=$1`,[newIssuanceId])).rows[0];
        assert.ok(journal.completed_at);
        assert.equal(journal.cancelled_at,null);
        assert.equal(journal.provider_revoked_at,null);
        const credential=(await database.query(`SELECT activated_at,confirmed_at,revoked_at FROM space_credentials
          WHERE space_id=$1 AND credential_id=$2`,[spaceId,result.id])).rows[0];
        assert.ok(credential.activated_at && credential.confirmed_at);
        assert.equal(credential.revoked_at,null);
        assert.equal((await database.query(`SELECT count(*)::int AS n FROM collection_grants
          WHERE space_id=$1 AND credential_id=$2`,[spaceId,result.id])).rows[0].n,1);
        assert.equal((await database.query(`SELECT count(*)::int AS n FROM space_audit
          WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,result.id])).rows[0].n,0);
        const local=(await database.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0];
        const published=(await directory.query('SELECT policy_version FROM space_directory WHERE space_id=$1',[spaceId])).rows[0];
        assert.equal(published.policy_version,local.policy_version);
      } finally {
        releasePending(); releaseConfirmation(); releaseStale();
        await Promise.allSettled([reconciling,issuing]);
        await single?.end();
      }
    }
  });

test('reconciliation cancellation after cell confirmation prevents a late definite key success',
  {timeout:10_000}, async () => {
    const actor={kind:'session',credentialId:'session',userPrincipalId:`completion-race-${crypto.randomUUID()}`};
    const active=new Set();
    const correlations=new Map();
    let issued; let reached; let release;
    const atCompletion=new Promise(resolve => { reached=resolve; });
    const completionGate=new Promise(resolve => { release=resolve; });
    const keys={
      create:async (_owner,_expiry,issuanceId) => {
        issued={id:`completion-key-${crypto.randomUUID()}`,secret:'unused'};
        correlations.set(issuanceId,issued.id); active.add(issued.id);
        return issued;
      },
      find:async (_owner,issuanceId) => correlations.get(issuanceId) ?? null,
      revoke:async id => { active.delete(id); },
    };
    const control={
      query:async (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('UPDATE agent_key_issuances i SET completed_at=')) {
          reached(); await completionGate;
        }
        return controlPool.query(...args);
      },
      connect:() => controlPool.connect(),
    };
    const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
      'cell-a',keys,{current:async () => true});
    let pending;
    try {
      const {spaceId}=await spaces.create(actor);
      const collectionId=`completion_${crypto.randomUUID()}`;
      await collection(spaceId,collectionId);
      pending=spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
        [{collectionId,capabilities:['records:read']}]);
      await atCompletion;
      assert.equal(active.has(issued.id),true);
      assert.ok((await pool.query(`SELECT confirmed_at FROM space_credentials
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id])).rows[0].confirmed_at);
      await controlPool.query(`UPDATE space_directory SET issuance_lease_until=clock_timestamp()-interval '1 second'
        WHERE space_id=$1`,[spaceId]);
      await spaces.reconcile(spaceId);
      release();
      await assert.rejects(pending,denied('STALE_PLACEMENT'));
      assert.equal(active.has(issued.id),false);
      const journal=(await controlPool.query(`SELECT cancelled_at,completed_at,provider_revoked_at
        FROM agent_key_issuances WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id])).rows[0];
      assert.ok(journal.cancelled_at && journal.provider_revoked_at);
      assert.equal(journal.completed_at,null);
      const local=(await pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id])).rows[0];
      assert.ok(local.revoked_at && local.provider_revoked_at);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id])).rows[0].n,0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,issued.id])).rows[0].n,1);
      assert.equal((await controlPool.query('SELECT policy_version FROM space_directory WHERE space_id=$1',
        [spaceId])).rows[0].policy_version,
      (await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version);
    } finally { release(); await pending?.catch(() => {}); }
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
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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

test('issue and rotation reject keys that expire during confirmation or completion',
  {timeout:45_000}, async () => {
    for (const operation of ['issue','rotate']) for (const boundary of ['confirmation','completion','completion-ack']) {
      const actor={kind:'session',credentialId:'session',userPrincipalId:`expiry-owner-${crypto.randomUUID()}`};
      const live=new Set();
      let created; let armed=false; let expiry;
      const keys={
        create:async () => {
          created={id:`expiry-key-${crypto.randomUUID()}`,secret:'unused'};
          live.add(created.id);
          return created;
        },
        find:async () => null,
        revoke:async id => { live.delete(id); },
      };
      const expireAtBoundary=async sql => {
        if (!armed || typeof sql!=='string' ||
          !(boundary==='confirmation' && sql.includes('UPDATE space_credentials SET confirmed_at=') ||
            boundary==='completion' && sql.includes('UPDATE agent_key_issuances i SET completed_at='))) return;
        armed=false;
        await pause(Math.max(0,expiry.getTime()-Date.now()+75));
      };
      const control=controlWithQueryHook(async (sql,_args,next)=>{
        if (armed && boundary==='completion-ack' && typeof sql==='string' &&
          sql.includes('UPDATE agent_key_issuances i SET completed_at=')) {
          const result=await next();
          armed=false;
          await pause(Math.max(0,expiry.getTime()-Date.now()+75));
          assert.equal(result.rowCount,1,'completion committed before acknowledgement was lost');
          throw new Error('lost completion acknowledgement');
        }
        if (boundary==='completion') await expireAtBoundary(sql);
        return next();
      });
      const cellPool={query:(...args)=>pool.query(...args),connect:async()=>{
        const client=await pool.connect();
        return {query:async (...args)=>{
          if (boundary==='confirmation') await expireAtBoundary(args[0]);
          return client.query(...args);
        },release:discard=>client.release(discard)};
      }};
      const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]),
        'cell-a',keys,{current:async()=>true});
      const {spaceId}=await spaces.create(actor);
      const collectionId=`expiry_${crypto.randomUUID()}`;
      await collection(spaceId,collectionId);
      const grants=[{collectionId,capabilities:['records:read']}];
      const old=operation==='rotate' ? await spaces.issueAgentKey(actor,spaceId,
        new Date(Date.now()+3_600_000),grants) : null;
      expiry=new Date(Date.now()+1_500);
      armed=true;
      await assert.rejects(operation==='rotate'
        ? spaces.rotateAgentKey(actor,spaceId,old.id,expiry,grants)
        : spaces.issueAgentKey(actor,spaceId,expiry,grants));
      assert.equal(armed,false,`${operation} reached ${boundary}`);
      assert.equal(live.has(created.id),false,'provider key was revoked');
      const local=(await pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,created.id])).rows[0];
      assert.ok(local.revoked_at && local.provider_revoked_at);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,created.id])).rows[0].n,0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,created.id])).rows[0].n,1);
      const journal=(await controlPool.query(`SELECT completed_at,cancelled_at,provider_revoked_at FROM agent_key_issuances
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,created.id])).rows[0];
      assert.equal(Boolean(journal.completed_at),boundary==='completion-ack');
      assert.ok(journal.cancelled_at,'failed completion remains recoverable after a committed acknowledgement loss');
      assert.ok(journal.provider_revoked_at);
    }
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
  const control=controlWithQueryHook(async (sql,args,next)=>{
    if (loseIdWrite && typeof sql==='string' && sql.includes('UPDATE agent_key_issuances SET credential_id=$2')) {
      loseIdWrite=false;
      throw new Error('control ID write unavailable');
    }
    return next();
  });
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(control,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  await assert.rejects(spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read']}]),/control ID write unavailable/);
  const journal=(await controlPool.query('SELECT credential_id FROM agent_key_issuances WHERE space_id=$1',[spaceId])).rows[0];
  assert.equal(journal.credential_id,null);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
  let providerOfflineAfterCreate = false;
  let directoryOfflineAfterCreate = false;
  const provider = {
    create:async (...args) => {
      issued = await realProvider.create(...args);
      if (providerOfflineAfterCreate) providerOffline=true;
      if (directoryOfflineAfterCreate) directoryOffline=true;
      return issued;
    },
    revoke:async (...args) => { if (providerOffline) throw new Error('provider revoke offline'); return realProvider.revoke(...args); },
  };
  let directoryOffline = false;
  const control = controlWithQueryHook(async (sql,args,next) => {
    if (directoryOffline && typeof sql === 'string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4')) {
      throw new Error('directory publish offline');
    }
    return next();
  });
  const cells = new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces = new PostgresSpaces(control,cells,'cell-a',provider,identity);
  const {spaceId} = await spaces.create(owner);
  const collectionId = `failed_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const expires = new Date(Date.now()+3_600_000);
  const grants = [{collectionId,capabilities:['records:read']}];
  const signer = await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
  const usableOld = await spaces.issueAgentKey(owner,spaceId,expires,grants);
  directoryOfflineAfterCreate = true; providerOfflineAfterCreate = true;
  await assert.rejects(spaces.rotateAgentKey(owner,spaceId,usableOld.id,expires,grants),/directory publish offline/);
  providerOfflineAfterCreate = false; directoryOfflineAfterCreate = false;
  directoryOffline = false;
  await assertFailedKeyIsDenied();
  providerOffline = false;
  await spaces.reconcile(spaceId);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1 AND credential_id=$2
    AND action='key:issue-failed'`,[spaceId,issued.id])).rows[0].n,1);
});

test('rotation consumes its source once across failed validation, concurrent calls and response retries',
  {timeout:10_000}, async () => {
    const actor={kind:'session',credentialId:'session',userPrincipalId:`rotate-once-${crypto.randomUUID()}`};
    const active=new Set();
    const correlations=new Map();
    let creates=0; let failCreate=false; let pauseRevoke=false; let reached; let release;
    const atRevoke=new Promise(resolve => { reached=resolve; });
    const revokeGate=new Promise(resolve => { release=resolve; });
    const keys={
      create:async (_owner,_expiry,issuanceId) => {
        if (failCreate) { failCreate=false; throw new Error('provider create rejected'); }
        const id=`rotate-once-key-${++creates}-${crypto.randomUUID()}`;
        active.add(id); correlations.set(issuanceId,id);
        return {id,secret:`secret-${id}`};
      },
      find:async (_owner,issuanceId) => correlations.get(issuanceId) ?? null,
      revoke:async id => {
        if (pauseRevoke) { pauseRevoke=false; reached(); await revokeGate; }
        active.delete(id);
      },
    };
    const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
      'cell-a',keys,{current:async () => true});
    const {spaceId}=await spaces.create(actor);
    const collectionId=`rotate_once_${crypto.randomUUID()}`;
    await collection(spaceId,collectionId);
    const expires=new Date(Date.now()+3_600_000);
    const grants=[{collectionId,capabilities:['records:read']}];
    const old=await spaces.issueAgentKey(actor,spaceId,expires,grants);
    await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,
      [{collectionId:'missing',capabilities:['records:read']}]),denied('INVALID_ARGUMENT'));
    assert.equal(creates,1,'failed preflight leaves the source reusable');
    pauseRevoke=true;
    let rotating;
    try {
      rotating=spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants);
      await atRevoke;
      await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants),denied('STALE_PLACEMENT'));
      assert.equal(creates,1,'concurrent retry creates no provider key');
      release();
      const replacement=await rotating;
      assert.equal(creates,2);
      await assert.rejects(spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants),denied('STALE_PLACEMENT'));
      assert.deepEqual([...active],[replacement.id]);
      assert.equal((await controlPool.query(`SELECT count(*)::int AS n FROM agent_key_issuances
        WHERE space_id=$1`,[spaceId])).rows[0].n,2);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,replacement.id])).rows[0].n,1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:revoke'`,[spaceId,old.id])).rows[0].n,1);
      assert.equal((await controlPool.query(`SELECT policy_version FROM space_directory WHERE space_id=$1`,
        [spaceId])).rows[0].policy_version,
      (await pool.query(`SELECT policy_version FROM spaces WHERE space_id=$1`,[spaceId])).rows[0].policy_version);
      failCreate=true;
      await assert.rejects(spaces.rotateAgentKey(actor,spaceId,replacement.id,expires,grants),/provider create rejected/);
      await assert.rejects(spaces.rotateAgentKey(actor,spaceId,replacement.id,expires,grants),denied('STALE_PLACEMENT'));
      assert.equal(creates,2,'a failed replacement and retry do not overissue');
      assert.equal(active.size,0);
      const journals=(await controlPool.query(`SELECT credential_id,settled_without_key_at FROM agent_key_issuances
        WHERE space_id=$1 ORDER BY created_at`,[spaceId])).rows;
      assert.equal(journals.length,3);
      assert.equal(journals[2].credential_id,null);
      assert.ok(journals[2].settled_without_key_at);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,replacement.id])).rows[0].n,0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:revoke'`,[spaceId,replacement.id])).rows[0].n,1);
    } finally { release(); await rotating?.catch(() => {}); }
  });

test('reconcile clears local grants after provider revoke succeeds but cell compensation fails for issue and rotation',
  {timeout:10_000}, async () => {
    for (const operation of ['issue','rotate']) {
      const actor={kind:'session',credentialId:'session',userPrincipalId:`repair-key-${crypto.randomUUID()}`};
      const active=new Set();
      const correlations=new Map();
      let created; let arm=false; let failPublish=false; let failCellCompensation=false;
      const keys={
        create:async (_owner,_expiry,issuanceId) => {
          created={id:`repair-key-${crypto.randomUUID()}`,secret:'unused'};
          correlations.set(issuanceId,created.id); active.add(created.id);
          if (arm) { failPublish=true; failCellCompensation=true; }
          return created;
        },
        find:async (_owner,issuanceId) => correlations.get(issuanceId) ?? null,
        revoke:async id => { active.delete(id); },
      };
      const control=controlWithQueryHook((sql,_args,next) => {
        if (failPublish && typeof sql==='string' && sql.includes('UPDATE space_directory SET policy_version=$3,lifecycle=$4'))
          throw new Error('directory publish unavailable');
        return next();
      });
      const cellPool={
        query:(...args) => pool.query(...args),
        connect:async () => {
          const client=await pool.connect();
          return {query:(...args) => {
            if (failCellCompensation && typeof args[0]==='string' &&
              (args[0].includes('UPDATE space_credentials SET revoked_at=') ||
                args[0].includes('UPDATE space_credentials SET provider_revoked_at=')))
              throw new Error('cell compensation unavailable');
            return client.query(...args);
          },release:discard => client.release(discard)};
        },
      };
      const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]),
        'cell-a',keys,{current:async () => true});
      const {spaceId}=await spaces.create(actor);
      const collectionId=`repair_${crypto.randomUUID()}`;
      await collection(spaceId,collectionId);
      const expires=new Date(Date.now()+3_600_000);
      const grants=[{collectionId,capabilities:['records:read']}];
      const old=operation==='rotate' ? await spaces.issueAgentKey(actor,spaceId,expires,grants) : null;
      arm=true;
      await assert.rejects(operation==='rotate'
        ? spaces.rotateAgentKey(actor,spaceId,old.id,expires,grants)
        : spaces.issueAgentKey(actor,spaceId,expires,grants),/directory publish unavailable/);
      const failed=created;
      const journal=(await controlPool.query(`SELECT provider_revoked_at FROM agent_key_issuances
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,failed.id])).rows[0];
      assert.ok(journal.provider_revoked_at,'fallback records successful provider revocation');
      assert.equal(active.has(failed.id),false);
      const before=(await pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,failed.id])).rows[0];
      assert.equal(before.revoked_at,null,'injected cell outage leaves local authority to repair');
      assert.equal(before.provider_revoked_at,null);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,failed.id])).rows[0].n,1);
      failPublish=false; failCellCompensation=false;
      await spaces.reconcile(spaceId);
      const after=(await pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,failed.id])).rows[0];
      assert.ok(after.revoked_at && after.provider_revoked_at);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,failed.id])).rows[0].n,0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,failed.id])).rows[0].n,1);
      assert.equal((await controlPool.query(`SELECT policy_version FROM space_directory WHERE space_id=$1`,
        [spaceId])).rows[0].policy_version,
      (await pool.query(`SELECT policy_version FROM spaces WHERE space_id=$1`,[spaceId])).rows[0].policy_version);
      await spaces.reconcile(spaceId);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit
        WHERE space_id=$1 AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,failed.id])).rows[0].n,1);
    }
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
  const signer = await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
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
  assert.equal(uncertain.confirmation,undefined);
  const completed = await controlPool.query('SELECT completed_at,cancelled_at FROM agent_key_issuances WHERE credential_id=$1',[uncertain.id]);
  assert.ok(completed.rows[0]?.completed_at);
  assert.equal(completed.rows[0].cancelled_at,null);
  assert.ok((await router.assertion(request(uncertain.secret),spaceId,collectionId,'records:read')).token,
    'a confirmed key is returned rather than reported as a failed issuance after its acknowledgement is lost');
});

test('uncertain completion gives issue and rotation a recoverable bearer without claiming success', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-completion-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`completion-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const realKeys=new AuthFnAgentKeys(config);
  let compensationOffline=false;
  const keys={
    create:async (...args)=>{ const key=await realKeys.create(...args); compensationOffline=true; return key; },
    revoke:async (...args)=>{ if (compensationOffline) throw new Error('provider revoke unavailable'); return realKeys.revoke(...args); },
    find:async (...args)=>realKeys.find(...args),
  };
  let loseAck=false;
  let retryOffline=false;
  let updateApplied=false;
  const control=controlWithQueryHook(async (sql,_args,next)=>{
    if (loseAck && typeof sql==='string' && sql.includes('UPDATE agent_key_issuances i SET completed_at=')) {
      loseAck=false;
      if (updateApplied) await next();
      throw new Error('lost completion acknowledgement');
    }
    if (typeof sql==='string' && sql.includes('SELECT i.completed_at,i.cancelled_at') && sql.includes('FROM agent_key_issuances'))
      throw new Error('completion readback unavailable');
    if (retryOffline && typeof sql==='string' && sql.includes('SET completed_at=COALESCE(i.completed_at'))
      throw new Error('completion retry unavailable');
    return next();
  });
  const cellPool={query:(...args)=>pool.query(...args),connect:async()=>{
    const client=await pool.connect();
    return {query:(...args)=>{
      if (compensationOffline && typeof args[0]==='string' && args[0].includes('UPDATE space_credentials SET revoked_at='))
        throw new Error('cell compensation unavailable');
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const cells=new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(control,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`complete_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const grants=[{collectionId,capabilities:['records:read']}];
  const expires=new Date(Date.now()+3_600_000);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  for (const [operation,applied] of [['issue',true],['rotate',true],['issue',false],['rotate',false]]) {
    compensationOffline=false;
    loseAck=true;
    retryOffline=true;
    updateApplied=applied;
    const previous=operation==='rotate' ? await pool.query(`SELECT credential_id FROM space_credentials
      WHERE space_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,[spaceId]) : null;
    let uncertain;
    await assert.rejects(operation==='issue' ? spaces.issueAgentKey(actor,spaceId,expires,grants) :
      spaces.rotateAgentKey(actor,spaceId,previous.rows[0].credential_id,expires,grants),error=>{
      assert.equal(error.name,'AgentKeyOutcomeUnknownError');
      assert.equal(Object.keys(error).includes('key'),false,'bearer is not enumerable in error logs');
      uncertain=error.takeKey();
      assert.equal(inspect(error).includes(uncertain.secret),false,'ordinary error logs omit the bearer');
      assert.throws(()=>error.takeKey(),denied('INVALID_ARGUMENT'));
      return true;
    });
    const key=uncertain;
    assert.equal(loseAck,false);
    assert.ok((await router.assertion(request(key.secret),spaceId,collectionId,'records:read')).token);
    const journal=(await controlPool.query(`SELECT completed_at,cancelled_at FROM agent_key_issuances
      WHERE space_id=$1 AND credential_id=$2`,[spaceId,key.id])).rows[0];
    assert.equal(Boolean(journal.completed_at),applied);
    assert.equal(journal.cancelled_at,null);
    const local=(await pool.query(`SELECT confirmed_at,revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2`,
      [spaceId,key.id])).rows[0];
    assert.ok(local.confirmed_at);
    assert.equal(local.revoked_at,null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM collection_grants WHERE space_id=$1 AND credential_id=$2`,
      [spaceId,key.id])).rows[0].n,1);
    compensationOffline=false;
    retryOffline=false;
    await spaces.reconcile(spaceId);
    const settled=(await controlPool.query(`SELECT completed_at,cancelled_at,provider_revoked_at
      FROM agent_key_issuances WHERE space_id=$1 AND credential_id=$2`,[spaceId,key.id])).rows[0];
    if (applied) {
      assert.ok(settled.completed_at);
      assert.equal(settled.cancelled_at,null);
      assert.ok((await router.assertion(request(key.secret),spaceId,collectionId,'records:read')).token);
    } else {
      assert.ok(settled.cancelled_at && settled.provider_revoked_at);
      assert.ok((await pool.query(`SELECT revoked_at FROM space_credentials WHERE space_id=$1 AND credential_id=$2`,
        [spaceId,key.id])).rows[0].revoked_at);
      await assert.rejects(router.assertion(request(key.secret),spaceId,collectionId,'records:read'),denied('UNAUTHENTICATED'));
    }
  }
});

test('a committed completion retry with unavailable validation preserves issue and rotation recovery', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-retry-validation-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`retry-validation-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const realKeys=new AuthFnAgentKeys(config);
  let armed=false;
  let injectNext=false;
  let firstUpdateFailed=false;
  let retryCommitted=false;
  let validationFailed=false;
  let cancellationAttempts=0;
  let cellCompensationAttempts=0;
  let providerCompensationAttempts=0;
  const keys={
    create:async (...args)=>{
      const created=await realKeys.create(...args);
      if (injectNext) { armed=true; injectNext=false; }
      return created;
    },
    find:async (...args)=>realKeys.find(...args),
    revoke:async (...args)=>{
      if (armed) { providerCompensationAttempts++; throw new Error('provider compensation unavailable'); }
      return realKeys.revoke(...args);
    },
  };
  const control=controlWithQueryHook(async (sql,_args,next)=>{
    if (armed && typeof sql==='string') {
      if (sql.includes('UPDATE agent_key_issuances i SET completed_at=') && !firstUpdateFailed) {
        firstUpdateFailed=true;
        throw new Error('initial completion unavailable');
      }
      if (sql.includes('SELECT i.completed_at,i.cancelled_at') && sql.includes('FROM agent_key_issuances'))
        throw new Error('completion readback unavailable');
      if (sql.includes('SET completed_at=COALESCE(i.completed_at')) {
        const result=await next();
        retryCommitted=true;
        return result;
      }
      if (retryCommitted && sql.includes('SELECT 1 FROM agent_key_issuances i')) {
        validationFailed=true;
        throw new Error('completion validation unavailable');
      }
      if (sql.includes('UPDATE agent_key_issuances') && sql.includes('SET cancelled_at=')) {
        cancellationAttempts++;
        throw new Error('journal cancellation unavailable');
      }
    }
    return next();
  });
  const cellPool={query:(...args)=>pool.query(...args),connect:async()=>{
    const client=await pool.connect();
    return {query:(...args)=>{
      if (armed && typeof args[0]==='string' && args[0].includes('UPDATE space_credentials SET revoked_at=')) {
        cellCompensationAttempts++;
        throw new Error('cell compensation unavailable');
      }
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const cells=new Map([['cell-a',{pool:cellPool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(control,cells,'cell-a',keys,identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`retry_validation_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const grants=[{collectionId,capabilities:['records:read']}];
  const expires=new Date(Date.now()+3_600_000);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,cells),signer);
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',identity));
  const authority=new PostgresAuthority(pool,3600);
  let previous;
  for (const operation of ['issue','rotate']) {
    armed=false;
    injectNext=true;
    firstUpdateFailed=false;
    retryCommitted=false;
    validationFailed=false;
    cancellationAttempts=0;
    cellCompensationAttempts=0;
    providerCompensationAttempts=0;
    let recovered;
    await assert.rejects(operation==='issue' ? spaces.issueAgentKey(actor,spaceId,expires,grants) :
      spaces.rotateAgentKey(actor,spaceId,previous.id,expires,grants),error=>{
      assert.equal(error.name,'AgentKeyOutcomeUnknownError',`${operation}: ${error.message}`);
      recovered=error.takeKey();
      assert.throws(()=>error.takeKey(),denied('INVALID_ARGUMENT'));
      return true;
    });
    assert.equal(firstUpdateFailed,true);
    assert.equal(retryCommitted,true);
    assert.equal(validationFailed,true);
    assert.equal(cancellationAttempts,0,'uncertain completion cannot enter ordinary compensation');
    assert.equal(cellCompensationAttempts,0);
    assert.equal(providerCompensationAttempts,0);
    armed=false;
    const journal=(await controlPool.query(`SELECT completed_at,cancelled_at,provider_revoked_at
      FROM agent_key_issuances WHERE space_id=$1 AND credential_id=$2`,[spaceId,recovered.id])).rows[0];
    assert.ok(journal.completed_at);
    assert.equal(journal.cancelled_at,null);
    assert.equal(journal.provider_revoked_at,null);
    const local=(await pool.query(`SELECT confirmed_at,revoked_at,provider_revoked_at FROM space_credentials
      WHERE space_id=$1 AND credential_id=$2`,[spaceId,recovered.id])).rows[0];
    assert.ok(local.confirmed_at);
    assert.equal(local.revoked_at,null);
    assert.equal(local.provider_revoked_at,null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM space_audit WHERE space_id=$1
      AND credential_id=$2 AND action='key:issue-failed'`,[spaceId,recovered.id])).rows[0].n,0);
    await controlPool.query(`UPDATE space_directory SET issuance_lease_token='expired-lease',
      issuance_lease_until=clock_timestamp()-interval '1 second'
      WHERE space_id=$1`,[spaceId]);
    await spaces.reconcile(spaceId);
    await spaces.reconcile(spaceId);
    const assertion=await router.assertion(request(recovered.secret),spaceId,collectionId,'records:read');
    await cell.execute(assertion.token,(_principal,context)=>context.records(authority,tx=>tx.countRecords([])));
    if (previous) await assert.rejects(router.assertion(request(previous.secret),spaceId,collectionId,'records:read'),
      denied('UNAUTHENTICATED'));
    previous=recovered;
  }
});

test('joined record receipt starts its retry window at cell commit', async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let lookups=0;
  let delayedLookup=false;
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',{current:async () => {
    if (++lookups===5) { delayedLookup=true; await pause(1250); }
    return true;
  }}));
  const authority=new PostgresAuthority(pool,1);
  const now=Math.floor(Date.now()/1000);
  const token=await signer.sign({spaceId,collectionId,capability:'records:write',credentialId:'owner-session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
  const change={operation:'create',idempotencyKey:`joined-${crypto.randomUUID()}`,requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const first=await cell.execute(token,async (_principal,context) => {
    const receipt=await context.records(authority,tx=>tx.mutate(change));
    return receipt;
  });
  assert.equal(delayedLookup,true,'final provider lookup crossed the one-second retention window');
  const scope={spaceId,collectionId,principalId:'owner',credentialId:'owner-session',
    capability:'records:write',policyVersion:1,placementGeneration:1};
  const replay=await authority.mutate(scope,change);
  assert.equal(replay.replayed,true,'delayed callback must not consume the retry window');
  assert.equal(replay.receiptId,first.receiptId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,1);
  const stored=(await pool.query('SELECT committed_at,expires_at FROM idempotency_receipts WHERE receipt_id=$1',
    [first.receiptId])).rows[0];
  assert.equal(first.committedAt,stored.committed_at.toISOString());
  assert.equal(first.expiresAt,stored.expires_at.toISOString());
});

test('regional cell deadline bounds nonce and effect pool admission, releasing late clients', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const authority=new PostgresAuthority(pool,60);
  for (const delayedConnection of [1,2]) {
    let connections=0;
    let releaseLate;
    let lateReleases=0;
    let effects=0;
    const delayedPool={connect:async()=>{
      if (++connections!==delayedConnection) return pool.connect();
      await new Promise(resolve=>{releaseLate=resolve;});
      const client=await pool.connect();
      return {query:(...args)=>client.query(...args),release:discard=>{lateReleases++;client.release(discard);}};
    }};
    const cell=new RegionalCell('cell-a',signer,
      new PostgresCellPolicy(delayedPool,'cell-a',{current:async()=>true},undefined,120));
    const token=await signRecordRoute(signer,spaceId,collectionId);
    await assert.rejects(cell.execute(token,(_principal,context)=>{
      effects++;
      return context.records(authority,tx=>tx.countRecords([]));
    }),denied('RATE_LIMITED'));
    assert.equal(effects,0);
    releaseLate();
    for (let i=0;i<20 && lateReleases===0;i++) await pause(10);
    assert.equal(lateReleases,1,'an expired admission releases its late client');
    assert.equal(connections,delayedConnection);
  }
});

test('nonce admission timeout before commit requires a fresh assertion and has no effect',async()=>{
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let delayed=false,effects=0;
  const slowPool={connect:async()=>{
    const client=await pool.connect();
    return {query:async(...args)=>{
      const result=await client.query(...args);
      if (!delayed && String(args[0]).includes('INSERT INTO routing_nonces')) {
        delayed=true; await pause(400);
      }
      return result;
    },release:discard=>client.release(discard)};
  }};
  const token=await signRecordRoute(signer,spaceId,collectionId);
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',
    {current:async()=>true},undefined,250));
  await assert.rejects(cell.execute(token,async()=>{effects++;}),error=>
    error?.code==='RATE_LIMITED' && /new routing assertion/.test(error.message));
  assert.equal(effects,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM routing_nonces WHERE space_id=$1',[spaceId])).rows[0].n,0);
  const fresh=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',{current:async()=>true}));
  await fresh.execute(await signRecordRoute(signer,spaceId,collectionId),async()=>{effects++;});
  assert.equal(effects,1);
});

test('regional cell policy-lock wait consumes the same request budget', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,
    new PostgresCellPolicy(pool,'cell-a',{current:async()=>true},undefined,200));
  const locker=await pool.connect();
  let effects=0;
  try {
    await locker.query('BEGIN');
    await locker.query("UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id=$2",[spaceId,collectionId]);
    const started=Date.now();
    await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async()=>{effects++;}),
      denied('RATE_LIMITED'));
    assert.ok(Date.now()-started<2000,'policy lock wait must have a server-side bound');
    assert.equal(effects,0);
  } finally { await locker.query('ROLLBACK'); locker.release(); }
});

test('regional cell deadline rejects a pending provider authorization before any effect', {timeout:5000}, async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let finishLookup;
  let lookupStarted;
  const started=new Promise(resolve=>{lookupStarted=resolve;});
  const provider={current:async()=>{lookupStarted();await new Promise(resolve=>{finishLookup=resolve;});return true;}};
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',provider,undefined,1000));
  let effects=0;
  const pending=cell.execute(await signRecordRoute(signer,spaceId,collectionId),async()=>{effects++;});
  await Promise.race([started,pause(3000).then(()=>{throw new Error('Provider authorization was not reached');})]);
  await assert.rejects(pending,denied('RATE_LIMITED'));
  assert.equal(effects,0);
  finishLookup();
});

test('a hung cell effect expires, releases locks and hides its joined receipt', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,
    new PostgresCellPolicy(pool,'cell-a',{current:async()=>true},undefined,600));
  const authority=new PostgresAuthority(pool,60);
  let pendingReceipt,lateContext,finishEffect;
  const change={operation:'create',idempotencyKey:`hung-${crypto.randomUUID()}`,
    requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const started=Date.now();
  await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async (_principal,context)=>{
    lateContext=context;
    pendingReceipt=await context.records(authority,tx=>tx.mutate(change));
    return new Promise(resolve=>{finishEffect=resolve;});
  }),denied('RATE_LIMITED'));
  assert.ok(Date.now()-started<2000,'unsettled application callback must not retain the cell transaction');
  assert.ok(pendingReceipt);
  assert.throws(()=>JSON.stringify(pendingReceipt),denied('RECEIPT_PENDING'));
  await assert.rejects(lateContext.records(authority,tx=>tx.countRecords([])),denied('FORBIDDEN'));
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
  finishEffect();
});

test('server cancellation at cell commit rolls back a joined write with a retryable limit error', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const probe=`sta8_cell_cancel_${crypto.randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE TABLE ${probe}(id integer NOT NULL)`);
  await pool.query(`CREATE FUNCTION ${probe}_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE SQLSTATE '57014' USING MESSAGE='confirmed joined commit cancellation'; END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER ${probe}_cancel AFTER INSERT ON ${probe}
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${probe}_cancel()`);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const authority=new PostgresAuthority(pool,60);
  let commits=0,pendingReceipt;
  const slowPool={connect:async()=>{
    const client=await pool.connect();
    return {query:async(...args)=>{
      const result=await client.query(...args);
      if (args[0]==='BEGIN' && ++commits===2) await client.query(`INSERT INTO ${probe}(id) VALUES(1)`);
      return result;
    },release:discard=>client.release(discard)};
  }};
  const cell=new RegionalCell('cell-a',signer,
    new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>true},undefined,500));
  const change={operation:'create',idempotencyKey:`commit-timeout-${crypto.randomUUID()}`,
    requestDigest:'a'.repeat(64),canonicalData:'{}'};
  try {
    await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async (_principal,context)=>{
      pendingReceipt=await context.records(authority,tx=>tx.mutate(change));
      return pendingReceipt;
    }),denied('RATE_LIMITED'));
    assert.equal(commits,2);
    assert.throws(()=>JSON.stringify(pendingReceipt),denied('RECEIPT_PENDING'));
    for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
    const replay=await authority.mutate({spaceId,collectionId,principalId:'owner',credentialId:'owner-session',
      capability:'records:write',policyVersion:1,placementGeneration:1},change);
    assert.equal(replay.replayed,false,'a confirmed rollback permits the same record identity to commit once');
  } finally {
    await pool.query(`DROP TABLE ${probe}`);
    await pool.query(`DROP FUNCTION ${probe}_cancel()`);
  }
});

test('a delayed cell commit has an unknown outcome and never exposes a pending receipt',async()=>{
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const probe=`sta8_cell_commit_${crypto.randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE TABLE ${probe}(id integer NOT NULL)`);
  await pool.query(`CREATE FUNCTION ${probe}_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER ${probe}_delay AFTER INSERT ON ${probe}
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${probe}_sleep()`);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const authority=new PostgresAuthority(pool,60);
  let begins=0,pendingReceipt;
  const delayed={connect:async()=>{
    const client=await pool.connect();
    return {query:async(...args)=>{
      const result=await client.query(...args);
      if (args[0]==='BEGIN' && ++begins===2) await client.query(`INSERT INTO ${probe}(id) VALUES(1)`);
      return result;
    },release:discard=>client.release(discard)};
  }};
  const cell=new RegionalCell('cell-a',signer,
    new PostgresCellPolicy(delayed,'cell-a',{current:async()=>true},undefined,500));
  const change={operation:'create',idempotencyKey:`ambiguous-${crypto.randomUUID()}`,
    requestDigest:'a'.repeat(64),canonicalData:'{}'};
  try {
    await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async (_principal,context)=>{
      pendingReceipt=await context.records(authority,tx=>tx.mutate(change));
      return pendingReceipt;
    }),error=>error instanceof CommitOutcomeUnknownError);
    assert.ok(pendingReceipt);
    assert.throws(()=>JSON.stringify(pendingReceipt),denied('RECEIPT_PENDING'));
    await pause(1100);
    const result=await authority.mutate({spaceId,collectionId,principalId:'owner',credentialId:'owner-session',
      capability:'records:write',policyVersion:1,placementGeneration:1},change);
    assert.ok(result.receiptId);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,1);
  } finally {
    await pool.query(`DROP TABLE ${probe}`);
    await pool.query(`DROP FUNCTION ${probe}_sleep()`);
  }
});

test('sequential joined calls share the cell deadline and hide a rolled-back receipt', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,
    new PostgresCellPolicy(pool,'cell-a',{current:async()=>true},undefined,1000));
  const authority=new PostgresAuthority(pool,60);
  const change={operation:'create',idempotencyKey:`deadline-${crypto.randomUUID()}`,
    requestDigest:'a'.repeat(64),canonicalData:'{}'};
  let pending;
  await assert.rejects(cell.execute(await signRecordRoute(signer,spaceId,collectionId),async (_principal,context)=>{
    pending=await context.records(authority,tx=>tx.mutate(change));
    await pause(1100);
    await context.records(authority,tx=>tx.countRecords([]));
    return pending;
  }),denied('RATE_LIMITED'));
  assert.ok(pending,'the first joined mutation reached its pending receipt');
  assert.throws(()=>({...pending}),denied('RECEIPT_PENDING'));
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('a final cell check that outlasts receipt retention rolls the joined write back', async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionId);
  let inserted=false;
  let delayed=false;
  const slowPool={connect:async()=>{
    const client=await pool.connect();
    return {query:async (...args)=>{
      const sql=args[0];
      if (typeof sql==='string' && sql.includes('INSERT INTO idempotency_receipts')) inserted=true;
      if (inserted && !delayed && typeof sql==='string' && sql.startsWith('SELECT to_timestamp')) {
        delayed=true;
        await pause(1250);
      }
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>true}));
  const now=Math.floor(Date.now()/1000);
  const token=await signer.sign({spaceId,collectionId,capability:'records:write',credentialId:'owner-session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(new PostgresAuthority(pool,1),
    tx=>tx.mutate({operation:'create',idempotencyKey:`late-${crypto.randomUUID()}`,
      requestDigest:'a'.repeat(64),canonicalData:'{}'}))),denied('RECEIPT_EXPIRED'));
  assert.equal(delayed,true);
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('joined calls replay one pending receipt and reject copies before outer commit', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',{current:async () => true}));
  const authority=new PostgresAuthority(pool,60);
  const token=()=>signRecordRoute(signer,spaceId,collectionId);
  const change={operation:'create',idempotencyKey:`joined-${crypto.randomUUID()}`,requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const [first,replay]=await cell.execute(await token(),async (_principal,context) => {
    const original=await context.records(authority,tx=>tx.mutate(change));
    const repeated=await context.records(authority,tx=>tx.mutate(change));
    assert.throws(()=>({...original}),denied('RECEIPT_PENDING'));
    assert.throws(()=>JSON.stringify(repeated),denied('RECEIPT_PENDING'));
    return [original,repeated];
  });
  assert.equal(replay.receiptId,first.receiptId);
  assert.equal(replay.replayed,true);
  assert.equal(replay.committedAt,first.committedAt);
  assert.equal(replay.expiresAt,first.expiresAt);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_receipts WHERE space_id=$1',[spaceId])).rows[0].n,1);
  const mismatch={...change,requestDigest:'b'.repeat(64)};
  await assert.rejects(cell.execute(await token(),async (_principal,context) => {
    await context.records(authority,tx=>tx.mutate(change));
    await context.records(authority,tx=>tx.mutate(mismatch));
  }),denied('IDEMPOTENCY_MISMATCH'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_receipts WHERE space_id=$1',[spaceId])).rows[0].n,1);
});

test('concurrent joined calls serialize same-key admission and expose frozen receipts only after commit', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',{current:async()=>true}));
  const authority=new PostgresAuthority(pool,60);
  const token=()=>signRecordRoute(signer,spaceId,collectionId);
  const change={operation:'create',idempotencyKey:`parallel-${crypto.randomUUID()}`,requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const [first,replay]=await cell.execute(await token(),async (_principal,context) => {
    const receipts=await Promise.all([context.records(authority,tx=>tx.mutate(change)),
      context.records(authority,tx=>tx.mutate(change))]);
    for (const receipt of receipts) {
      Object.freeze(receipt);
      assert.throws(()=>receipt.committedAt,denied('RECEIPT_PENDING'));
    }
    return receipts;
  });
  assert.equal(first.receiptId,replay.receiptId);
  assert.equal(replay.replayed,true);
  const stored=(await pool.query('SELECT committed_at,expires_at FROM idempotency_receipts WHERE receipt_id=$1',
    [first.receiptId])).rows[0];
  assert.equal(first.committedAt,stored.committed_at.toISOString());
  assert.equal(replay.expiresAt,stored.expires_at.toISOString());
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,1,table);
  await assert.rejects(cell.execute(await token(),async (_principal,context) => Promise.all([
    context.records(authority,tx=>tx.mutate({...change,idempotencyKey:`mismatch-${spaceId}`})),
    context.records(authority,tx=>tx.mutate({...change,idempotencyKey:`mismatch-${spaceId}`,requestDigest:'b'.repeat(64)}))
  ])),denied('IDEMPOTENCY_MISMATCH'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,1);
  const standalone=await authority.transaction({spaceId,collectionId,principalId:'owner',credentialId:'owner-session',
    capability:'records:write',policyVersion:1,placementGeneration:1},async tx=>{
    const receipt=await tx.mutate({...change,idempotencyKey:`standalone-${spaceId}`});
    Object.freeze(receipt);
    assert.throws(()=>receipt.committedAt,denied('RECEIPT_PENDING'));
    return receipt;
  });
  assert.equal(standalone.committedAt,(await pool.query('SELECT committed_at FROM idempotency_receipts WHERE receipt_id=$1',
    [standalone.receiptId])).rows[0].committed_at.toISOString());
});

test('nested joined calls reject without holding the cell connection or policy lock', {timeout:5000}, async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionId);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let released=0;
  const checkedPool={connect:async()=>{const client=await pool.connect();return {
    query:(...args)=>client.query(...args),release:discard=>{released++;client.release(discard);}
  };}};
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(checkedPool,'cell-a',{current:async()=>true}));
  const authority=new PostgresAuthority(pool,60);
  const token=async()=>{const now=Math.floor(Date.now()/1000);return signer.sign({spaceId,collectionId,
    capability:'records:write',credentialId:'owner-session',kind:'session',userPrincipalId:'owner',cellId:'cell-a',
    policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,
    nonce:crypto.randomUUID()});};
  await assert.rejects(cell.execute(await token(),(_principal,context)=>context.records(authority,async tx=>{
    await tx.mutate({operation:'create',idempotencyKey:`nested-${spaceId}`,requestDigest:'a'.repeat(64),canonicalData:'{}'});
    return context.records(authority,inner=>inner.countRecords([]));
  })),denied('INVALID_ARGUMENT'));
  assert.equal(released,2,'nonce and cell transaction connections were returned');
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
  await pool.query(`UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1`,[spaceId]);
  const version=(await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version;
  assert.equal(Number(version),2,'the failed callback released its policy lock');
  await assert.rejects(cell.execute(await token(),(_principal,context)=>context.records(authority,
    tx=>tx.countRecords([]))),denied('STALE_PLACEMENT'));
});

test('provider revocation during joined receipt finalization rolls back all SQL effects', async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionId);
  let current=true; let staged=false; let revoked=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    const sql=args[0];
    const result=await client.query(...args);
    if (typeof sql==='string' && sql.includes('INSERT INTO idempotency_receipts')) staged=true;
    if (staged && !revoked && typeof sql==='string' && sql.includes('remaining_ms')) {current=false;revoked=true;}
    return result;
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>current}));
  const now=Math.floor(Date.now()/1000);
  const token=await signer.sign({spaceId,collectionId,capability:'records:write',credentialId:'owner-session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(new PostgresAuthority(pool,60),
    tx=>tx.mutate({operation:'create',idempotencyKey:`revoked-${spaceId}`,
      requestDigest:'a'.repeat(64),canonicalData:'{}'}))),denied('FORBIDDEN'));
  assert.equal(revoked,true);
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('a slow last provider lookup cannot consume the joined receipt retry window', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  let fenced=false; let delayed=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    const result=await client.query(...args);
    if (typeof args[0]==='string' && args[0].includes('remaining_ms')) fenced=true;
    return result;
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>{
    if (fenced && !delayed) {delayed=true;await pause(5250);}
    return true;
  }}));
  const token=await signRecordRoute(signer,spaceId,collectionId);
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(new PostgresAuthority(pool,5),
    tx=>tx.mutate({operation:'create',idempotencyKey:`late-provider-${spaceId}`,
      requestDigest:'a'.repeat(64),canonicalData:'{}'}))),denied('RECEIPT_EXPIRED'));
  assert.equal(fenced,true);
  assert.equal(delayed,true);
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('grant expiry during the final provider lookup denies the joined commit', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  const credentialId=`key_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
    VALUES($1,$2,'agent','owner',clock_timestamp()+interval '1 minute',clock_timestamp(),clock_timestamp())`,[spaceId,credentialId]);
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities,expires_at)
    VALUES($1,$2,$3,ARRAY['records:write']::text[],clock_timestamp()+interval '1 minute')`,
  [spaceId,collectionId,credentialId]);
  let fenced=false; let delayed=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    const result=await client.query(...args);
    if (typeof args[0]==='string' && args[0].includes('remaining_ms')) {
      fenced=true;
      await client.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '1 second'
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,collectionId,credentialId]);
    }
    return result;
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>{
    if (fenced && !delayed) {delayed=true;await pause(1250);}
    return true;
  }}));
  const token=await signRecordRoute(signer,spaceId,collectionId,credentialId);
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(new PostgresAuthority(pool,60),
    tx=>tx.mutate({operation:'create',idempotencyKey:`late-grant-${spaceId}`,
      requestDigest:'a'.repeat(64),canonicalData:'{}'}))),denied('FORBIDDEN'));
  assert.equal(fenced,true);
  assert.equal(delayed,true);
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('an original replay grant expiring during the final provider lookup rolls back a joined write', async () => {
  const collectionA=`a_${crypto.randomUUID()}`;
  const collectionB=`b_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionA,collectionB);
  const credentialId=`key_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
    VALUES($1,$2,'agent','owner',clock_timestamp()+interval '1 minute',clock_timestamp(),clock_timestamp())`,[spaceId,credentialId]);
  for (const collectionId of [collectionA,collectionB]) await pool.query(`INSERT INTO collection_grants
    (space_id,collection_id,credential_id,capabilities,expires_at)
    VALUES($1,$2,$3,ARRAY['records:write']::text[],clock_timestamp()+interval '1 minute')`,
  [spaceId,collectionId,credentialId]);
  const authority=new PostgresAuthority(pool,60);
  const replay={operation:'create',idempotencyKey:`original-${spaceId}`,requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const original=await authority.mutate({spaceId,collectionId:collectionA,principalId:'agent',credentialId,
    capability:'records:write',policyVersion:1,placementGeneration:1},replay);
  let fenced=false; let delayed=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    const result=await client.query(...args);
    if (!fenced && typeof args[0]==='string' && args[0].includes('remaining_ms')) {
      fenced=true;
      await client.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '1 second'
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,collectionA,credentialId]);
    }
    return result;
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>{
    if (fenced && !delayed) { delayed=true; await pause(1250); }
    return true;
  }}));
  const token=()=>signRecordRoute(signer,spaceId,collectionB,credentialId);
  const fresh={operation:'create',idempotencyKey:`fresh-${spaceId}`,requestDigest:'b'.repeat(64),canonicalData:'{}'};
  const execute=async()=>cell.execute(await token(),async (_principal,context)=>{
    const prior=await context.records(authority,tx=>tx.mutate(replay));
    const next=await context.records(authority,tx=>tx.mutate(fresh));
    return [prior,next];
  });
  await assert.rejects(execute(),denied('FORBIDDEN'));
  assert.equal(fenced,true);
  assert.equal(delayed,true);
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,1,table);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipt_reservations WHERE space_id=$1',[spaceId])).rows[0].n,0);
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '1 minute'
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,collectionA,credentialId]);
  const [replayed,written]=await execute();
  assert.equal(replayed.receiptId,original.receiptId);
  assert.equal(replayed.replayed,true);
  assert.notEqual(written.receiptId,original.receiptId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,2);
});

test('a persisted replay expiring during the final provider lookup rolls back a joined write and permits one retry', async () => {
  const collectionA=`a_${crypto.randomUUID()}`;
  const collectionB=`b_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionA,collectionB);
  const short=new PostgresAuthority(pool,5);
  const long=new PostgresAuthority(pool,60);
  const scope={spaceId,collectionId:collectionA,principalId:'owner',credentialId:'owner-session',
    capability:'records:write',policyVersion:1,placementGeneration:1};
  const replay={operation:'create',idempotencyKey:`replay-${spaceId}`,requestDigest:'a'.repeat(64),canonicalData:'{}'};
  const fresh={operation:'create',idempotencyKey:`fresh-${spaceId}`,requestDigest:'b'.repeat(64),canonicalData:'{}'};
  const original=await short.mutate(scope,replay);
  let fenced=false; let delayed=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    const result=await client.query(...args);
    if (typeof args[0]==='string' && args[0].includes('AS remaining_ms')) fenced=true;
    return result;
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>{
    if (fenced && !delayed) {
      delayed=true;
      const processNow=Date.now;
      Date.now=()=>processNow()+(databaseNames.length ? -60_000 : 60_000);
      try {
        const deadline=await pool.query(`SELECT GREATEST(0,CEIL(EXTRACT(EPOCH FROM
          ($1::timestamptz-clock_timestamp()))*1000))::int AS remaining_ms`,[original.expiresAt]);
        await pause(deadline.rows[0].remaining_ms+100);
        const reached=await pool.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[original.expiresAt]);
        assert.equal(reached.rows[0].expired,true,'the PostgreSQL receipt deadline must pass inside the provider hook');
      } finally { Date.now=processNow; }
    }
    return true;
  }}));
  const execute=async()=>cell.execute(await signRecordRoute(signer,spaceId,collectionB),async (_principal,context)=>[
    await context.records(short,tx=>tx.mutate(replay)),
    await context.records(long,tx=>tx.mutate(fresh))
  ]);
  await assert.rejects(execute(),denied('RECEIPT_EXPIRED'));
  assert.equal(fenced,true,'the final receipt deadline check must run');
  assert.equal(delayed,true,'the provider lookup must cross the replay deadline');
  for (const table of ['records','record_events','idempotency_receipts','projection_outbox']) {
    const rows=(await pool.query(`SELECT collection_id,count(*)::int AS n FROM ${table} WHERE space_id=$1 GROUP BY collection_id`,
      [spaceId])).rows;
    assert.deepEqual(rows,[{collection_id:collectionA,n:1}],table);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipt_reservations WHERE space_id=$1',[spaceId])).rows[0].n,0);
  const [retried,retriedFresh]=await execute();
  assert.notEqual(retried.receiptId,original.receiptId,'the expired replay can create one new effect');
  assert.equal(retried.replayed,false);
  assert.equal(retriedFresh.replayed,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1 AND collection_id=$2',
    [spaceId,collectionB])).rows[0].n,2);
});

test('joined receipts use one database clock query with per-authority retention', async () => {
  const collectionId=`entries_${crypto.randomUUID()}`;
  const spaceId=await cellSpace(collectionId);
  let clockQueries=0;
  const countingPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    if (typeof args[0]==='string' && args[0].includes('SELECT at AS committed_at')) clockQueries++;
    return client.query(...args);
  },release:discard=>client.release(discard)};}};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(countingPool,'cell-a',{current:async()=>true}));
  const now=Math.floor(Date.now()/1000);
  const token=await signer.sign({spaceId,collectionId,capability:'records:write',credentialId:'owner-session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});
  const retentions=[30,60,120];
  const receipts=await cell.execute(token,async(_principal,context)=>{
    const result=[];
    for (const retention of retentions) result.push(await context.records(new PostgresAuthority(pool,retention),
      tx=>tx.mutate({operation:'create',idempotencyKey:`batch-${retention}-${spaceId}`,
        requestDigest:'a'.repeat(64),canonicalData:'{}'})));
    return result;
  });
  assert.equal(clockQueries,1,'the same database instant stamps every pending receipt');
  const rows=(await pool.query(`SELECT receipt_id,committed_at,expires_at FROM idempotency_receipts
    WHERE space_id=$1 ORDER BY receipt_id`,[spaceId])).rows;
  assert.equal(rows.length,retentions.length);
  assert.equal(new Set(rows.map(row=>row.committed_at.toISOString())).size,1);
  assert.deepEqual(rows.map(row=>Math.round((row.expires_at-row.committed_at)/1000)).sort((a,b)=>a-b),retentions);
  for (const receipt of receipts) {
    const row=rows.find(row=>row.receipt_id===receipt.receiptId);
    assert.equal(receipt.committedAt,row.committed_at.toISOString());
    assert.equal(receipt.expiresAt,row.expires_at.toISOString());
  }
});

test('joined authorities retain each receipt policy and recheck replay grants after finalization', async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionA=`a_${crypto.randomUUID()}`;
  const collectionB=`b_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionA);
  await collection(spaceId,collectionB);
  const credentialId=`key_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
    VALUES($1,$2,'agent','owner',clock_timestamp()+interval '1 minute',clock_timestamp(),clock_timestamp())`,[spaceId,credentialId]);
  for (const collectionId of [collectionA,collectionB]) await pool.query(`INSERT INTO collection_grants
    (space_id,collection_id,credential_id,capabilities,expires_at) VALUES($1,$2,$3,ARRAY['records:write']::text[],clock_timestamp()+interval '1 minute')`,
  [spaceId,collectionId,credentialId]);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const token=()=>{const now=Math.floor(Date.now()/1000);return signer.sign({spaceId,collectionId:collectionB,
    capability:'records:write',credentialId,kind:'api-key',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+30,nonce:crypto.randomUUID()});};
  const long=new PostgresAuthority(pool,60);
  const short=new PostgresAuthority(pool,2);
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(pool,'cell-a',{current:async()=>true}));
  const change=key=>({operation:'create',idempotencyKey:key,requestDigest:'a'.repeat(64),canonicalData:'{}'});
  const [longReceipt,shortReceipt]=await cell.execute(await token(),async (_principal,context)=>[
    await context.records(long,tx=>tx.mutate(change(`long-${spaceId}`))),
    await context.records(short,tx=>tx.mutate(change(`short-${spaceId}`)))
  ]);
  const rows=(await pool.query(`SELECT receipt_id,EXTRACT(EPOCH FROM expires_at-committed_at)::int AS retention
    FROM idempotency_receipts WHERE receipt_id=ANY($1::text[])`,[[longReceipt.receiptId,shortReceipt.receiptId]])).rows;
  assert.deepEqual(Object.fromEntries(rows.map(row=>[row.receipt_id,row.retention])),
    {[longReceipt.receiptId]:60,[shortReceipt.receiptId]:2});
  const original=change(`original-${spaceId}`);
  const originalReceipt=await long.mutate({spaceId,collectionId:collectionA,principalId:'agent',credentialId,
    capability:'records:write',policyVersion:1,placementGeneration:1},original);
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '1 second'
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,collectionA,credentialId]);
  let delayed=false;
  const slowPool={connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{
    if (!delayed && typeof args[0]==='string' && args[0].includes('INSERT INTO idempotency_receipts')) {
      delayed=true;await pause(1400);
    }
    return client.query(...args);
  },release:discard=>client.release(discard)};}};
  const slowCell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async()=>true}));
  await assert.rejects(slowCell.execute(await token(),async (_principal,context)=>{
    await context.records(long,tx=>tx.mutate(original));
    return context.records(short,tx=>tx.mutate(change(`new-${spaceId}`)));
  }),denied('FORBIDDEN'));
  assert.equal(delayed,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[spaceId])).rows[0].n,3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_receipts WHERE space_id=$1',[spaceId])).rows[0].n,3);
  assert.equal(originalReceipt.replayed,false);
});

test('placement fence publishes the full cell tuple after interrupted lifecycle publication', async () => {
  const actor={kind:'session',credentialId:'session',userPrincipalId:`fence-${crypto.randomUUID()}`};
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(controlPool,cells,'cell-a',
    {create:async()=>{throw new Error('unexpected create');},find:async()=>null,revoke:async()=>{}},
    {current:async()=>true});
  const {spaceId,createdAt,updatedAt}=await spaces.create(actor);
  assert.ok(Number.isFinite(Date.parse(createdAt)) && Number.isFinite(Date.parse(updatedAt)));
  assert.equal((await collectSpaces(spaces,actor)).find(space=>space.spaceId===spaceId).createdAt,createdAt);
  assert.equal((await spaces.get(actor,spaceId)).createdAt,createdAt);
  await pool.query(`UPDATE spaces SET lifecycle='readOnly',policy_version=policy_version+1 WHERE space_id=$1`,[spaceId]);
  assert.equal(await spaces.fencePlacement(spaceId,'cell-a',1),2);
  const directory=(await controlPool.query(`SELECT lifecycle,policy_version,placement_generation
    FROM space_directory WHERE space_id=$1`,[spaceId])).rows[0];
  const local=(await pool.query(`SELECT lifecycle,policy_version,placement_generation
    FROM spaces WHERE space_id=$1`,[spaceId])).rows[0];
  assert.deepEqual(directory,local);
  assert.deepEqual({lifecycle:directory.lifecycle,policyVersion:Number(directory.policy_version),
    placementGeneration:Number(directory.placement_generation)},
  {lifecycle:'readOnly',policyVersion:2,placementGeneration:2});
});

test('a joined finalizer crossing assertion expiry rolls back its record and receipt', async () => {
  const spaceId=`sp_${crypto.randomUUID()}`;
  const collectionId=`entries_${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  await collection(spaceId,collectionId);
  let delayed=false;
  const slowPool={connect:async () => {
    const client=await pool.connect();
    return {query:async (...args) => {
      if (!delayed && typeof args[0]==='string' && args[0].includes('INSERT INTO idempotency_receipts')) {
        delayed=true;
        await pause(2400);
      }
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',{current:async () => true}));
  const authority=new PostgresAuthority(pool,60);
  const now=Math.floor(Date.now()/1000);
  const token=await signer.sign({spaceId,collectionId,capability:'records:write',credentialId:'owner-session',
    kind:'session',userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,
    audience:'stateplane-cell:cell-a',issuedAt:now,expiresAt:now+2,nonce:crypto.randomUUID()});
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(authority,tx=>tx.mutate({
    operation:'create',idempotencyKey:`expired-${crypto.randomUUID()}`,requestDigest:'a'.repeat(64),canonicalData:'{}'
  }))),denied('FORBIDDEN'));
  assert.equal(delayed,true);
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('a joined finalizer crossing grant expiry rolls back before the cell effect commits', async () => {
  const config={database:memoryAdapter(),namespace:`sta6-final-grant-${crypto.randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const user=await createUser(config,{primaryEmail:`final-grant-${crypto.randomUUID()}@example.invalid`});
  const session=await issueSession(config,{}, {userId:user.id,methods:['password']});
  const identity=new AuthFnIdentityVerifier(config);
  const actor=await identity.verify(request(session.sessionToken));
  const spaces=new PostgresSpaces(controlPool,new Map([['cell-a',{pool,storageTargetId:'target-a'}]]),
    'cell-a',new AuthFnAgentKeys(config),identity);
  const {spaceId}=await spaces.create(actor);
  const collectionId=`entries_${crypto.randomUUID()}`;
  await collection(spaceId,collectionId);
  const grantExpiry=new Date(Date.now()+60_000);
  const key=await spaces.issueAgentKey(actor,spaceId,new Date(Date.now()+60_000),
    [{collectionId,capabilities:['records:write'],expiresAt:grantExpiry}]);
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const router=new RegionalRouter(identity,new PostgresRoutingDirectory(controlPool,
    new Map([['cell-a',{pool,storageTargetId:'target-a'}]])),signer);
  const token=(await router.assertion(request(key.secret),spaceId,collectionId,'records:write')).token;
  let delayed=false;
  const slowPool={connect:async () => {
    const client=await pool.connect();
    return {query:async (...args) => {
      if (!delayed && typeof args[0]==='string' && args[0].includes('INSERT INTO idempotency_receipts')) {
        delayed=true;
        await pause(2400);
      }
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const cell=new RegionalCell('cell-a',signer,new PostgresCellPolicy(slowPool,'cell-a',identity));
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '2 seconds'
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,collectionId,key.id]);
  let pendingReceipt;
  await assert.rejects(cell.execute(token,(_principal,context)=>context.records(new PostgresAuthority(pool,60),
    tx=>tx.mutate({operation:'create',idempotencyKey:`expired-grant-${crypto.randomUUID()}`,
      requestDigest:'a'.repeat(64),canonicalData:'{}'}).then(receipt=>{pendingReceipt=receipt;return receipt;}))),denied('FORBIDDEN'));
  assert.equal(delayed,true);
  assert.throws(()=>JSON.stringify(pendingReceipt),denied('RECEIPT_PENDING'));
  for (const table of ['records','record_events','idempotency_receipts','receipt_reservations','projection_outbox'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[spaceId])).rows[0].n,0,table);
});

test('signing key rotation retains then retires old assertions', async () => {
  await assert.rejects(RoutingKeys.create([{id:'bad',secret:new Uint8Array(1)}],'bad'),/Invalid routing keyring/);
  const v1 = crypto.getRandomValues(new Uint8Array(32));
  const v2 = crypto.getRandomValues(new Uint8Array(32));
  const old = await RoutingKeys.create([{id:'old',secret:v1}],'old');
  const claims = {spaceId:'space',collectionId:'collection',capability:'records:read',credentialId:'session',kind:'session',
    userPrincipalId:'owner',cellId:'cell-a',policyVersion:1,placementGeneration:1,audience:'stateplane-cell:cell-a',
    issuedAt:100,expiresAt:130,nonce:'nonce'};
  const token = await old.sign(claims);
  assert.equal((await old.verify(token,'cell-a',99)).spaceId,'space','one-second gateway lead is tolerated');
  await assert.rejects(old.verify(token,'cell-a',94),denied('FORBIDDEN'));
  const rotating = await RoutingKeys.create([{id:'old',secret:v1},{id:'new',secret:v2}],'new');
  assert.equal((await rotating.verify(token,'cell-a',101)).spaceId,'space');
  await assert.rejects((await RoutingKeys.create([{id:'new',secret:v2}],'new')).verify(token,'cell-a',101),denied('FORBIDDEN'));
});

test('router rejects malformed verifier identifiers before signing or directory access', async () => {
  const signer=await RoutingKeys.create([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  let lookups=0;
  const directory={lookup:async () => { lookups++; return {spaceId:'space',cellId:'cell-a',lifecycle:'active',policyVersion:1,placementGeneration:1}; },
    authorized:async () => true};
  for (const actor of [
    {kind:'session',credentialId:'session',userPrincipalId:''},
    {kind:'session',credentialId:'x'.repeat(513),userPrincipalId:'owner'},
    {kind:'api-key',credentialId:'key',userPrincipalId:'owner'}
  ]) {
    const router=new RegionalRouter({verify:async () => actor},directory,signer);
    await assert.rejects(router.assertion(new Request('https://example.invalid'),'space','collection','records:read'),denied('FORBIDDEN'));
  }
  assert.equal(lookups,0);
});

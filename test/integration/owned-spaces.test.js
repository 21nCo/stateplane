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
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
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
  const spaces = new PostgresSpaces(controlPool,cells,'cell-a',keyProvider);
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
  const adminActor = await identity.verify(request(adminKey.secret));
  assert.equal((await spaces.get(adminActor,first.spaceId)).spaceId,first.spaceId);
  await assert.rejects(spaces.archive(adminActor,first.spaceId),denied('FORBIDDEN'));
  await assert.rejects(spaces.get(adminActor,second.spaceId),denied('FORBIDDEN'));
  await assert.rejects(spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read','schema:unknown']}]),denied('INVALID_ARGUMENT'));
  const signing = new RoutingKeys([{id:'v1',secret:crypto.getRandomValues(new Uint8Array(32))}],'v1');
  const directory = new PostgresRoutingDirectory(controlPool);
  const router = new RegionalRouter(identity,directory,signing);
  const cellA = new RegionalCell('cell-a',signing,new PostgresCellPolicy(pool,'cell-a'));
  const cellB = new RegionalCell('cell-b',signing,new PostgresCellPolicy(cellBPool,'cell-b'));
  const authority = new PostgresAuthority(pool,3600);
  const read = (cell,token) => cell.execute(token,(_principalId,context) => context.records(authority,tx => tx.countRecords([])));
  const route = (secret,spaceId,collectionId,capability='records:read') => router.assertion(request(secret),spaceId,collectionId,capability);

  const routed = await route(key1.secret,first.spaceId,c1);
  assert.equal(routed.cellId,'cell-a');
  await assert.rejects(cellA.execute('',async () => { throw new Error('direct effect'); }),denied('FORBIDDEN'));
  assert.equal(await read(cellA,routed.token),0);
  await assert.rejects(read(cellA,routed.token),denied('FORBIDDEN')); // one-use assertion
  await assert.rejects(read(cellB,(await route(key1.secret,first.spaceId,c1)).token),denied('FORBIDDEN'));
  const tampered = (await route(key1.secret,first.spaceId,c1)).token;
  const tamperedParts = tampered.split('.');
  tamperedParts[1] = (tamperedParts[1].startsWith('A')?'B':'A')+tamperedParts[1].slice(1);
  await assert.rejects(read(cellA,tamperedParts.join('.')),denied('FORBIDDEN'));
  await assert.rejects(read(cellA,(await route(key1.secret,first.spaceId,c2)).token),denied('FORBIDDEN'));
  await assert.rejects(read(cellA,(await route(key2.secret,first.spaceId,c1)).token),denied('FORBIDDEN'));
  await assert.rejects(read(cellB,(await route(key1.secret,second.spaceId,c1)).token),denied('FORBIDDEN'));
  await assert.rejects(read(cellA,(await route(key1.secret,first.spaceId,c1,'schema:write')).token),denied('FORBIDDEN'));
  await assert.rejects(read(cellA,(await route(key1.secret,first.spaceId,c1,'sources:read')).token),denied('FORBIDDEN'));
  await assert.rejects(read(cellA,(await route(key1.secret,first.spaceId,c1,'export:read')).token),denied('FORBIDDEN'));
  const expiredAssertion = await route(key1.secret,first.spaceId,c1);
  const futureCell = new RegionalCell('cell-a',signing,new PostgresCellPolicy(pool,'cell-a'),() => Math.floor(Date.now()/1000)+61);
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
  await assert.rejects(read(cellA,(await route(expiredKey.secret,first.spaceId,c1)).token),denied('FORBIDDEN'));
  const expiredGrant = await spaces.issueAgentKey(owner,first.spaceId,expires,[{collectionId:c1,capabilities:['records:read']}]);
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND credential_id=$2`,[first.spaceId,expiredGrant.id]);
  await assert.rejects(read(cellA,(await route(expiredGrant.secret,first.spaceId,c1)).token),denied('FORBIDDEN'));
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
  const actualRevoke = keyProvider.revoke.bind(keyProvider);
  let unavailable = true;
  keyProvider.revoke = async (...args) => { if (unavailable) throw new Error('provider unavailable'); return actualRevoke(...args); };
  await assert.rejects(spaces.delete(owner,first.spaceId),/provider unavailable/);
  assert.equal((await spaces.get(owner,first.spaceId)).lifecycle,'deleting');
  await assert.rejects(route(rotated.secret,first.spaceId,c2),denied('SPACE_UNAVAILABLE'));
  unavailable = false;
  await spaces.delete(owner,first.spaceId);
  await assert.rejects(route(rotated.secret,first.spaceId,c2),denied('UNAUTHENTICATED'));
  assert.equal((await spaces.list(owner)).length,1);
  for (const table of ['collections','collection_versions','collection_grants','space_credentials','records','record_events','idempotency_receipts','projection_outbox']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`,[first.spaceId])).rows[0].n,0,`${table} erased`);
  }
  const actions = (await pool.query('SELECT action FROM space_audit WHERE space_id=$1 ORDER BY recorded_at,audit_id',[first.spaceId])).rows.map(row => row.action);
  assert.ok(actions.includes('space:create') && actions.includes('key:issue') && actions.includes('key:revoke') && actions.includes('space:readOnly') && actions.includes('space:deleted'));
  const secondAssertion = await route(session.sessionToken,second.spaceId,c1);
  assert.equal(await spaces.fencePlacement(second.spaceId,'cell-b',1),2);
  await assert.rejects(read(cellB,secondAssertion.token),denied('STALE_PLACEMENT'));
  await assert.rejects(spaces.fencePlacement(second.spaceId,'cell-a',2),denied('STALE_PLACEMENT'));
  await cellBPool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[second.spaceId]);
  await assert.rejects(read(cellB,(await route(session.sessionToken,second.spaceId,c1)).token),denied('STALE_PLACEMENT'));
  assert.equal((await spaces.reconcile(second.spaceId)).policyVersion,2);
  assert.equal(await read(cellB,(await route(session.sessionToken,second.spaceId,c1)).token),0);
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

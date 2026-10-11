import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';

const password=process.env.DATABASE_URL?null:(await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url=process.env.DATABASE_URL??`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const pool=new pg.Pool({connectionString:url,max:6});
test.after(()=>pool.end());
const owner={kind:'session',userPrincipalId:`owner-${randomUUID()}`,credentialId:`session-${randomUUID()}`};
// A provider stand-in: Stateplane stores key IDs and grants, never these secrets.
const keys=new Map();
let created=0;
let failRevoke=false;
const provider={
  create:async(principal,expiresAt,issuanceId)=>{ created++; const key={id:`key-${randomUUID()}`,secret:`secret-${randomUUID()}`,principal,issuanceId,revoked:false};
    keys.set(key.secret,key); return {id:key.id,secret:key.secret}; },
  find:async(principal,issuanceId)=>[...keys.values()].find(key=>key.principal===principal && key.issuanceId===issuanceId)?.id??null,
  revoke:async id=>{
    if (failRevoke) { failRevoke=false; throw new Error('provider unavailable'); }
    for (const key of keys.values()) if (key.id===id) key.revoked=true;
  }
};
const identity={
  verify:async request=>{
    const token=request.headers.get('authorization')?.slice(7);
    if (token==='owner-token') return owner;
    const key=keys.get(token);
    return key && !key.revoked ? {kind:'api-key',credentialId:key.id} : null;
  },
  current:async claims=>claims.kind==='session' || [...keys.values()].some(key=>key.id===claims.credentialId && !key.revoked)
};
const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
const spaces=new PostgresSpaces(pool,cells,'cell-a',provider,identity,randomBytes(32));
const handler=createHttpHandler({services:postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600),identity});
const route=async(method,path,body,token='owner-token')=>{
  const response=await handler(new Request(`https://stateplane.example.invalid${path}`,{method,
    headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body)}));
  return {status:response.status,text:await response.text()};
};
const json=response=>JSON.parse(response.text);

test('owner key issuance, listing, revocation, audit and index backfill go through shared HTTP services',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  assert.equal((await route('POST','/v1/spaces',{spaceId})).status,201);
  t.after(async()=>{
    try { await spaces.archive(owner,spaceId); await spaces.delete(owner,spaceId); }
    catch { /* A failed test retains the disposable database for inspection. */ }
  });
  const base=`/v1/spaces/${spaceId}/collections/entries`;
  assert.equal((await route('PUT',base,{slug:'entries',version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    unique:[],filterable:['label'],sortable:[]})).status,201);
  assert.equal((await route('POST',`${base}/records`,{operation:'create',idempotencyKey:'one',data:{label:'One'}})).status,200);

  // A new filter field stays pending, so exact queries refuse it until the owner builds it.
  assert.deepEqual(json(await route('GET',base)).pending,['label']);
  const predicate=[{field:'label',kind:'string',operator:'eq',value:'One'}];
  assert.equal(json(await route('POST',`${base}/records/count`,predicate)).error.code,'SCHEMA_CONFLICT');
  assert.deepEqual(json(await route('POST',`${base}/indexes/label`)),{processed:1,ready:true});
  assert.equal(json(await route('POST',`${base}/records/count`,predicate)),1);

  const expiresAt=new Date(Date.now()+86_400_000).toISOString();
  for (const body of [{expiresAt,grants:[{collectionId:'entries',capabilities:['records:read']}],extra:true},
    {expiresAt:'tomorrow',grants:[{collectionId:'entries',capabilities:['records:read']}]},
    {expiresAt:'2099-02-30T00:00:00Z',grants:[{collectionId:'entries',capabilities:['records:read']}]},
    {expiresAt,grants:[{collectionId:'entries',capabilities:['records:everything']}]},
    {expiresAt,grants:[{collectionId:'missing',capabilities:['records:read']}]},
    {expiresAt,grants:[]}]) {
    const rejected=await route('POST',`/v1/spaces/${spaceId}/agent-keys`,body);
    assert.equal(rejected.status,400,rejected.text);
    assert.equal(json(rejected).error.code,'INVALID_ARGUMENT');
  }
  assert.equal(created,0,'rejected issuance never creates a provider key');

  const issued=await route('POST',`/v1/spaces/${spaceId}/agent-keys`,{expiresAt,grants:[{collectionId:'entries',capabilities:['records:read']}]});
  assert.equal(issued.status,201);
  const {keyId,secret}=json(issued);
  const listed=await route('GET',`/v1/spaces/${spaceId}/agent-keys`);
  assert.ok(!listed.text.includes(secret),'a listing never contains the secret');
  assert.deepEqual(json(listed).items.map(({keyId:id,status,grants})=>({id,status,grants})),
    [{id:keyId,status:'active',grants:[{collectionId:'entries',capabilities:['records:read'],expiresAt:null}]}]);

  // The key reads its collection but cannot administer the space or build indexes.
  assert.equal(json(await route('POST',`${base}/records/count`,[],secret)),1);
  for (const [method,path] of [['GET',`/v1/spaces/${spaceId}/agent-keys`],['GET',`/v1/spaces/${spaceId}/audit`],
    ['POST',`/v1/spaces/${spaceId}/agent-keys`],['DELETE',`/v1/spaces/${spaceId}/agent-keys/${keyId}`],['POST',`${base}/indexes/label`]]) {
    const denied=await route(method,path,method==='POST' && path.endsWith('agent-keys') ? {expiresAt,grants:[]} : undefined,secret);
    assert.equal(denied.status,403,`${method} ${path}`);
  }

  assert.equal(json(listed).items[0].providerRevokedAt,null);
  // A provider failure after the local revocation leaves cleanup visible and repeatable.
  failRevoke=true;
  assert.notEqual((await route('DELETE',`/v1/spaces/${spaceId}/agent-keys/${keyId}`)).status,200);
  const interrupted=json(await route('GET',`/v1/spaces/${spaceId}/agent-keys`)).items[0];
  assert.deepEqual([interrupted.status,interrupted.providerRevokedAt],['revoked',null]);
  assert.deepEqual(json(await route('DELETE',`/v1/spaces/${spaceId}/agent-keys/${keyId}`)),{keyId,revoked:true});
  const revoked=json(await route('GET',`/v1/spaces/${spaceId}/agent-keys`)).items[0];
  assert.equal(revoked.status,'revoked');
  assert.ok(revoked.providerRevokedAt);
  assert.deepEqual(revoked.grants,[]);
  assert.equal((await route('GET','/v1/auth/session',undefined,secret)).status,401);
  const audit=await route('GET',`/v1/spaces/${spaceId}/audit`);
  assert.ok(!audit.text.includes(secret));
  const actions=json(audit).entries.map(entry=>entry.action);
  for (const action of ['space:create','key:issue','key:revoke']) assert.ok(actions.includes(action),action);
  assert.equal(json(await route('GET',`/v1/spaces/${spaceId}/audit?cursor=a&cursor=b`)).error.code,'CURSOR_INVALID');

  // Listing is keyset-paged at 100 keys.
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at)
    SELECT $1,'key-bulk-'||lpad(n::text,3,'0'),'agent-bulk-'||n,$2,clock_timestamp()+interval '1 day' FROM generate_series(1,100) n`,
  [spaceId,owner.userPrincipalId]);
  const first=json(await route('GET',`/v1/spaces/${spaceId}/agent-keys`));
  assert.equal(first.items.length,100);
  const second=json(await route('GET',`/v1/spaces/${spaceId}/agent-keys?cursor=${encodeURIComponent(first.nextCursor)}`));
  assert.equal(second.items.length,1);
  assert.equal(second.nextCursor,null);
  // Unconfirmed issuance rows are reported as pending rather than usable.
  assert.equal([...first.items,...second.items].filter(item=>item.status==='pending').length,100);
  await pool.query(`DELETE FROM space_credentials WHERE space_id=$1 AND credential_id LIKE 'key-bulk-%'`,[spaceId]);
});

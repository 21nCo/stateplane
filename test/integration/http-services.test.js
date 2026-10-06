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
const actor={kind:'session',userPrincipalId:`owner-${randomUUID()}`,credentialId:`session-${randomUUID()}`};
let current=true;
const agent={kind:'api-key',credentialId:`agent-${randomUUID()}`};
const identity={verify:async request=>request.headers.get('authorization')==='Bearer fixture-token'?actor:
  request.headers.get('authorization')==='Bearer fixture-agent-key'?agent:null,
  current:async()=>current};
const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
const spaces=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
  find:async()=>null,revoke:async()=>{}},identity);
const services=postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600);
const handler=createHttpHandler({services,identity});
const route=async(method,path,body,token='fixture-token')=>handler(new Request(`https://stateplane.example.invalid${path}`,{
  method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body)}));

test('real Postgres HTTP operations preserve receipts, grant checks, events and batch progress',async t=>{
  const created=await route('POST','/v1/spaces',{});
  assert.equal(created.status,201);
  const space=await created.json();
  t.after(async()=>{
    current=true;
    try { await spaces.archive(actor,space.spaceId); await spaces.delete(actor,space.spaceId); }
    catch { /* A failed test retains the disposable database for inspection. */ }
  });
  const collection='entries';
  const base=`/v1/spaces/${space.spaceId}/collections/${collection}`;
  const definition={slug:collection,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    unique:[],filterable:[],sortable:[]};
  assert.equal((await route('PUT',base,definition)).status,201);
  const request={operation:'create',idempotencyKey:'first',data:{label:'One'}};
  const first=await route('POST',`${base}/records`,request);
  assert.equal(first.status,200);
  const receipt=await first.json();
  assert.equal(receipt.projection.state,'pending');
  const replay=await (await route('POST',`${base}/records`,request)).json();
  assert.equal(replay.receiptId,receipt.receiptId);
  assert.equal(replay.replayed,true);
  const id=receipt.ref.id;
  const record=await (await route('GET',`${base}/records/${id}`)).json();
  assert.equal(JSON.parse(record.canonicalData).label,'One');
  assert.equal(await (await route('POST',`${base}/records/count`,[])).json(),1);
  const page=await (await route('POST',`${base}/records/query`,{predicates:[],limit:10})).json();
  assert.equal(page.records.length,1);
  const eventPage=await (await route('GET',`${base}/events`)).json();
  assert.equal(eventPage.events.length,1);
  assert.equal(eventPage.events[0].recordId,id);
  const afterEvent=await (await route('GET',`${base}/events?cursor=${eventPage.events[0].eventId}`)).json();
  assert.deepEqual(afterEvent.events,[]);
  const badCursor=await route('GET',`${base}/events?cursor=bad`);
  assert.equal((await badCursor.json()).error.code,'CURSOR_INVALID');
  const projection=await (await route('GET',`${base}/records/${id}/projection`)).json();
  assert.equal(projection.state,'pending');
  const manifest=[JSON.stringify({operation:'create',data:{label:'Two'}})];
  const batch=await route('PUT',`${base}/batches/import-1`,manifest);
  assert.equal(batch.status,200);
  assert.equal((await batch.json()).items[0].state,'succeeded');
  assert.equal((await (await route('GET',`${base}/batches/import-1`)).json()).items[0].state,'succeeded');
  current=false;
  const denied=await route('GET',`${base}/records/${id}`);
  assert.equal(denied.status,403);
  assert.equal((await denied.json()).error.code,'FORBIDDEN');
  const deniedBatch=await route('GET',`${base}/batches/import-1`);
  assert.equal(deniedBatch.status,403);
  current=true;
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at,confirmed_at)
    VALUES($1,$2,'agent-principal',$3,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
    [space.spaceId,agent.credentialId,actor.userPrincipalId]);
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['schema:write']::text[])`,[space.spaceId,collection,agent.credentialId]);
  const discovered=await route('GET',`${base}`,undefined,'fixture-agent-key');
  assert.equal(discovered.status,200);
  assert.equal((await discovered.json()).definition.slug,collection);
  assert.equal((await route('GET',`${base}/records/${id}`,undefined,'fixture-agent-key')).status,403);
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['schema:write','records:read']::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  assert.equal((await route('GET',`${base}/records/${id}`,undefined,'fixture-agent-key')).status,200);
  await pool.query('UPDATE space_credentials SET revoked_at=clock_timestamp() WHERE space_id=$1 AND credential_id=$2',
    [space.spaceId,agent.credentialId]);
  assert.equal((await route('GET',`${base}/records/${id}`,undefined,'fixture-agent-key')).status,404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { PostgresAuthority, CollectionRegistry, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';

const password=process.env.DATABASE_URL?null:(await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url=process.env.DATABASE_URL??`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const pool=new pg.Pool({connectionString:url,max:6});
test.after(()=>pool.end());
const actor={kind:'session',userPrincipalId:`owner-${randomUUID()}`,credentialId:`session-${randomUUID()}`};
let current=true;
let currentProbe=()=>current;
const agent={kind:'api-key',credentialId:`agent-${randomUUID()}`};
const identity={verify:async request=>request.headers.get('authorization')==='Bearer fixture-token'?actor:
  request.headers.get('authorization')==='Bearer fixture-agent-key'?agent:null,
  current:async()=>currentProbe()};
const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
const spaces=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
  find:async()=>null,revoke:async()=>{}},identity);
const services=postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600);
const handler=createHttpHandler({services,identity});
const route=async(method,path,body,token='fixture-token')=>handler(new Request(`https://stateplane.example.invalid${path}`,{
  method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body)}));

test('real Postgres HTTP operations preserve receipts, grant checks, events and batch progress',async t=>{
  const created=await route('POST','/v1/spaces',{spaceId:`sp_${randomUUID()}`});
  assert.equal(created.status,201);
  const space=await created.json();
  const repeated=await route('POST','/v1/spaces',{spaceId:space.spaceId});
  assert.equal(repeated.status,201);
  assert.equal((await repeated.json()).spaceId,space.spaceId);
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
  assert.equal(afterEvent.nextCursor,eventPage.events[0].eventId);
  const badCursor=await route('GET',`${base}/events?cursor=bad`);
  assert.equal((await badCursor.json()).error.code,'CURSOR_INVALID');
  const projection=await (await route('GET',`${base}/records/${id}/projection`)).json();
  assert.equal(projection.state,'pending');
  const manifest=[JSON.stringify({operation:'create',data:{label:'Two'}})];
  const batch=await route('PUT',`${base}/batches/import-1`,manifest);
  assert.equal(batch.status,200);
  assert.equal((await batch.json()).items[0].state,'succeeded');
  assert.equal((await (await route('GET',`${base}/batches/import-1`)).json()).items[0].state,'succeeded');
  for (const [method,path,body] of [
    ['GET',`${base}/records/${id}`,undefined],
    ['POST',`${base}/records`,request],
    ['POST',`${base}/records`,{operation:'create',idempotencyKey:'revoked-pending',data:{label:'Denied'}}],
    ['GET',base,undefined],
    ['GET',`${base}/events`,undefined],
    ['GET',`${base}/batches/import-1`,undefined]
  ]) {
    let checks=0;
    currentProbe=()=>++checks===1;
    const deniedLate=await route(method,path,body);
    assert.equal((await deniedLate.json()).error.code,'FORBIDDEN',`${method} ${path}`);
    assert.equal(checks,2);
  }
  currentProbe=()=>current;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_events WHERE space_id=$1',
    [space.spaceId])).rows[0].n,2);
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
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['schema:write','records:read','records:write','events:read','space:admin']::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  const keyWrite={operation:'create',idempotencyKey:'agent-replay',data:{label:'Agent'}};
  assert.equal((await route('POST',`${base}/records`,keyWrite,'fixture-agent-key')).status,200);
  assert.equal((await route('PUT',`${base}/batches/agent-import`,
    [JSON.stringify({operation:'create',data:{label:'Agent batch'}})],'fixture-agent-key')).status,200);
  const writeOnlyManifest=[JSON.stringify({operation:'create',data:{label:'Write only batch'}})];
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['records:write']::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  assert.equal((await route('PUT',`${base}/batches/write-only`,writeOnlyManifest,'fixture-agent-key')).status,200);
  const writeOnlyProgress=await route('GET',`${base}/batches/write-only`,undefined,'fixture-agent-key');
  assert.equal(writeOnlyProgress.status,200);
  assert.equal((await writeOnlyProgress.json()).items[0].state,'succeeded');
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY[]::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  assert.equal((await route('GET',`${base}/batches/write-only`,undefined,'fixture-agent-key')).status,403);
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['records:write']::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  const recovered=await route('PUT',`${base}/batches/write-only`,writeOnlyManifest,'fixture-agent-key');
  assert.equal(recovered.status,200);
  assert.equal((await recovered.json()).items[0].receipt.receiptId,
    (await (await route('GET',`${base}/batches/write-only`,undefined,'fixture-agent-key')).json()).items[0].receipt.receiptId);
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['schema:write','records:read','records:write','events:read','space:admin']::text[]
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
  for (const [method,path,body] of [
    ['GET',`/v1/spaces/${space.spaceId}`,undefined],['GET',base,undefined],
    ['GET',`${base}/records/${id}`,undefined],['GET',`${base}/batches/agent-import`,undefined],
    ['GET',`${base}/events`,undefined],['POST',`${base}/records`,keyWrite]
  ]) {
    await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '800 milliseconds'
      WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[space.spaceId,collection,agent.credentialId]);
    let probes=0;
    currentProbe=async()=>{
      if (++probes===(path.includes('/collections/')?2:3))
        await new Promise(resolve=>setTimeout(resolve,1000));
      return true;
    };
    const expired=await route(method,path,body,'fixture-agent-key');
    assert.equal(expired.status,path.includes('/collections/')?403:404,path);
    assert.equal(probes,path.includes('/collections/')?2:3,path);
  }
  currentProbe=()=>current;
  await pool.query('UPDATE space_credentials SET revoked_at=clock_timestamp() WHERE space_id=$1 AND credential_id=$2',
    [space.spaceId,agent.credentialId]);
  assert.equal((await route('GET',`${base}/records/${id}`,undefined,'fixture-agent-key')).status,404);
});

test('schema lost COMMIT is uncertain and lifecycle returns its own transition',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  assert.equal((await route('POST','/v1/spaces',{spaceId})).status,201);
  t.after(async()=>{
    current=true; currentProbe=()=>current;
    try { await spaces.update(actor,spaceId,'readOnly'); await spaces.delete(actor,spaceId); } catch {}
  });
  const collectionId=`entries_${randomUUID()}`;
  const definition={slug:collectionId,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},additionalProperties:false},unique:[],filterable:[],sortable:[]};
  const admitted=await spaces.scope(actor,spaceId,collectionId,'schema:write');
  const lostAckPool={connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,values)=>{
      const result=await client.query(sql,values);
      if (sql==='COMMIT') throw Object.assign(new Error('lost schema acknowledgement'),{code:'EPIPE'});
      return result;
    },release:discard=>client.release(discard)};
  }};
  await assert.rejects(new CollectionRegistry(lostAckPool).defineSerialized(admitted.scope,JSON.stringify(definition)),
    {name:'CommitOutcomeUnknownError'});
  assert.equal((await route('GET',`/v1/spaces/${spaceId}/collections/${collectionId}`)).status,200);
  const originalGet=spaces.get;
  spaces.get=async(...args)=>{
    await spaces.update(actor,spaceId,'active');
    return originalGet.apply(spaces,args);
  };
  try {
    const changed=await services.spaces.update(actor,spaceId,'readOnly');
    assert.equal(changed.lifecycle,'readOnly');
    assert.equal(changed.policyVersion,2);
  } finally { spaces.get=originalGet; }
});

test('a live API key cannot enumerate another owner through collection siblings',async t=>{
  const other={kind:'session',userPrincipalId:`foreign-${randomUUID()}`,credentialId:`foreign-session-${randomUUID()}`};
  const foreign=await spaces.create(other);
  t.after(async()=>{ try { await spaces.update(other,foreign.spaceId,'readOnly'); await spaces.delete(other,foreign.spaceId); } catch {} });
  const key={kind:'api-key',credentialId:`foreign-probe-${randomUUID()}`};
  const guard=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
    find:async()=>null,revoke:async()=>{}},{current:async(_actor,owner)=>owner!==other.userPrincipalId});
  const guardHandler=createHttpHandler({services:postgresServices(guard,new Map([['cell-a',
    {pool,cursorSecret:randomBytes(32)}]]),3600),identity:{verify:async()=>key}});
  for (const suffix of ['/collections','/collections/entries/records/rec_probe',
    '/collections/entries/batches/probe','/collections/entries/events']) {
    const selected=await guardHandler(new Request(`https://example.invalid/v1/spaces/${foreign.spaceId}${suffix}`));
    const missing=await guardHandler(new Request(`https://example.invalid/v1/spaces/sp_${randomUUID()}${suffix}`));
    assert.equal(selected.status,404);
    assert.equal(missing.status,404);
    assert.equal((await selected.json()).error.code,(await missing.json()).error.code);
  }
});

test('event continuation survives two writers whose transactions finish in opposite order',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  assert.equal((await route('POST','/v1/spaces',{spaceId})).status,201);
  t.after(async()=>{
    try { await spaces.update(actor,spaceId,'readOnly'); await spaces.delete(actor,spaceId); } catch {}
  });
  const collectionId=`entries_${randomUUID()}`;
  const base=`/v1/spaces/${spaceId}/collections/${collectionId}`;
  const definition={slug:collectionId,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},additionalProperties:false},unique:[],filterable:[],sortable:[]};
  assert.equal((await route('PUT',base,definition)).status,201);
  const admitted=await spaces.scope(actor,spaceId,collectionId,'records:write');
  const authority=new PostgresAuthority(pool,3600,randomBytes(32));
  let inserted;
  const insertedSignal=new Promise(resolve=>{inserted=resolve;});
  let release;
  const releaseSignal=new Promise(resolve=>{release=resolve;});
  const first=authority.transaction(admitted.scope,async tx=>{
    const receipt=await tx.mutateRequest({operation:'create',idempotencyKey:'writer-a',data:{label:'A'}});
    inserted(); await releaseSignal; return receipt;
  });
  await insertedSignal;
  const second=authority.mutateRequest(admitted.scope,{operation:'create',idempotencyKey:'writer-b',data:{label:'B'}});
  let before;
  try {
    const early=await Promise.race([second.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),80))]);
    assert.equal(early,true,'independent record writes must remain concurrent');
    before=await (await route('GET',`${base}/events`)).json();
    assert.equal(before.events.length,1);
  } finally { release(); }
  const [a,b]=await Promise.all([first,second]);
  const events=(await (await route('GET',`${base}/events`)).json()).events;
  assert.deepEqual(events.map(item=>item.recordId),[b.ref.id,a.ref.id]);
  const continued=await (await route('GET',`${base}/events?cursor=${before.nextCursor}`)).json();
  assert.deepEqual(continued.events.map(item=>item.recordId),[a.ref.id]);
  assert.equal(continued.nextCursor,events[1].eventId);
  for (let ordinal=0;ordinal<99;ordinal++)
    await authority.mutateRequest(admitted.scope,{operation:'create',idempotencyKey:`page-${ordinal}`,
      data:{label:`Page ${ordinal}`}});
  const firstPage=await (await route('GET',`${base}/events`)).json();
  const lastPage=await (await route('GET',`${base}/events?cursor=${firstPage.nextCursor}`)).json();
  assert.equal(firstPage.events.length,100);
  assert.equal(lastPage.events.length,1);
  assert.equal(new Set([...firstPage.events,...lastPage.events].map(item=>item.eventId)).size,101);
  await spaces.update(actor,spaceId,'readOnly');
  await spaces.delete(actor,spaceId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_event_feed WHERE space_id=$1',
    [spaceId])).rows[0].n,0);
});

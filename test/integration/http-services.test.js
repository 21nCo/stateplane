import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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

async function collectSpaces(spaces,actor) {
  const items=[];
  for await (const item of spaces.list(actor)) items.push(item);
  return items;
}

test('space discovery pages bound directory work and reauthorize each continuation',async t=>{
  const prefix=`sta9-page-${randomUUID()}`;
  const owner={kind:'session',userPrincipalId:`owner-${randomUUID()}`,credentialId:`session-${randomUUID()}`};
  const secret=randomBytes(32);
  let live=true;
  const verifier={verify:async()=>owner,current:async()=>live};
  const listing=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
    find:async()=>null,revoke:async()=>{}},verifier,secret);
  const endpoint=createHttpHandler({services:postgresServices(listing,new Map(),3600),identity:verifier});
  const get=cursor=>endpoint(new Request(`https://stateplane.example.invalid/v1/spaces${cursor===undefined?'':`?cursor=${encodeURIComponent(cursor)}`}`));
  t.after(async()=>{
    live=true;
    await pool.query('DELETE FROM space_directory WHERE space_id LIKE $1',[`${prefix}%`]);
  });
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,created_at)
    SELECT $1 || '-' || lpad(n::text,3,'0'),$2,'cell-a','cell-a','target-a','active',
      '2026-01-01T00:00:00Z'::timestamptz+n*interval '2 microseconds' FROM generate_series(0,54) n`,
  [prefix,owner.userPrincipalId]);
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle,created_at,provisioning_lease_until)
    VALUES($1,$2,'cell-a','target-a','provisioning','2026-01-01T00:00:00Z'::timestamptz+interval '5 microseconds',clock_timestamp()+interval '1 hour')`,
  [`${prefix}-pending`,owner.userPrincipalId]);
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,created_at)
    VALUES($1,'foreign-owner','cell-a','cell-a','target-a','active','2026-01-01T00:00:00Z')`,[`${prefix}-foreign`]);
  const first=await get();
  assert.equal(first.status,200);
  const page1=await first.json();
  assert.equal(page1.items.length,7,'one pending reservation consumes one bounded scan slot');
  assert.equal(typeof page1.cursor,'string');
  assert.ok(page1.items.every(item=>item.ownerPrincipalId===owner.userPrincipalId));
  const direct=listing.list(owner);
  assert.equal(typeof direct[Symbol.asyncIterator],'function','direct discovery must stream bounded pages');
  const directItems=[];
  for (let index=0;index<page1.items.length;index++) directItems.push((await direct.next()).value);
  const actualNow=Date.now;
  try {
    Date.now=()=>actualNow()+16*60_000;
    for await (const item of direct) directItems.push(item);
  } finally { Date.now=actualNow; }
  assert.equal(directItems.length,55,'direct traversal stays complete past external cursor expiry');
  assert.equal(new Set(directItems.map(item=>item.spaceId)).size,55);
  const sibling=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
    find:async()=>null,revoke:async()=>{}},verifier,secret);
  assert.equal((await sibling.listPage(owner,page1.cursor)).items.length,8,
    'a continuation must work on another instance using the shared key');
  try {
    Date.now=()=>actualNow()+30_000;
    assert.equal((await sibling.listPage(owner,page1.cursor)).items.length,8,
      'a faster receiving instance retains the cursor within its age limit');
    Date.now=()=>actualNow()-30_000;
    assert.equal((await sibling.listPage(owner,page1.cursor)).items.length,8,
      'a slower instance must accept a fresh cursor from a faster issuer');
    Date.now=()=>actualNow()-61_000;
    await assert.rejects(sibling.listPage(owner,page1.cursor),{code:'CURSOR_INVALID'},
      'a cursor too far in the future remains invalid');
  } finally { Date.now=actualNow; }
  const unconfigured=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
    find:async()=>null,revoke:async()=>{}},verifier);
  await assert.rejects(unconfigured.listPage(owner),/Shared space cursor secret/);
  assert.equal((await pool.query('SELECT lifecycle FROM space_directory WHERE space_id=$1',
    [`${prefix}-pending`])).rows[0].lifecycle,'provisioning');
  await pool.query('UPDATE space_directory SET owner_principal_id=$2 WHERE space_id=$1',
    [`${prefix}-054`,'changed-owner']);
  const listed=[...page1.items];
  let next=page1.cursor;
  let pages=1;
  while (next) {
    const response=await get(next);
    assert.equal(response.status,200);
    const page=await response.json();
    assert.ok(page.items.length<=8);
    listed.push(...page.items);
    next=page.cursor;
    pages++;
    assert.ok(pages<=8,'continuation must advance through 56 candidates');
  }
  assert.equal(new Set(listed.map(item=>item.spaceId)).size,54);
  for (const bad of ['!',page1.cursor+'x']) {
    const response=await get(bad);
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'CURSOR_INVALID');
  }
  await assert.rejects(listing.listPage({...owner,credentialId:'other-credential'},page1.cursor),{code:'CURSOR_INVALID'});
  await assert.rejects(listing.listPage({...owner,userPrincipalId:'other-owner'},page1.cursor),{code:'CURSOR_INVALID'});
  const [body]=JSON.parse(Buffer.from(page1.cursor,'base64url').toString('utf8'));
  const old=JSON.parse(body);old[4]=Date.now()-16*60_000;
  const expiredBody=JSON.stringify(old);
  const expired=Buffer.from(JSON.stringify([expiredBody,createHmac('sha256',secret).update(expiredBody).digest('hex')])).toString('base64url');
  assert.equal((await (await get(expired)).json()).error.code,'CURSOR_INVALID');
  const directRevoked=listing.list(owner);
  for (let index=0;index<page1.items.length;index++) await directRevoked.next();
  live=false;
  await assert.rejects(directRevoked.next(),{code:'FORBIDDEN'});
  assert.equal((await (await get(page1.cursor)).json()).error.code,'FORBIDDEN');
});

test('direct space enumeration advances past a full page of pending reservations',async t=>{
  const prefix=`sta9-pending-${randomUUID()}`;
  const localActor={kind:'session',userPrincipalId:`owner-${randomUUID()}`,credentialId:`session-${randomUUID()}`};
  const verifier={current:async()=>true};
  const listing=new PostgresSpaces(pool,cells,'cell-a',{create:async()=>{throw Error('unused');},
    find:async()=>null,revoke:async()=>{}},verifier);
  t.after(()=>pool.query('DELETE FROM space_directory WHERE space_id LIKE $1',[`${prefix}%`]));
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle,created_at,provisioning_lease_until)
    SELECT $1 || '-pending-' || n,$2,'cell-a','target-a','provisioning',
      '2026-01-01T00:00:00Z'::timestamptz+n*interval '1 microsecond',clock_timestamp()+interval '1 hour'
    FROM generate_series(0,7) n`,[prefix,localActor.userPrincipalId]);
  await pool.query(`INSERT INTO space_directory(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle,created_at)
    VALUES($1,$2,'cell-a','cell-a','target-a','active','2026-01-01T00:00:01Z')`,
  [`${prefix}-active`,localActor.userPrincipalId]);
  assert.deepEqual((await collectSpaces(listing,localActor)).map(row=>row.spaceId),[`${prefix}-active`]);
});

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
  for (const [key,items] of [
    ['too-many',Array(21).fill('{}')],
    ['too-large',Array(3).fill('x'.repeat(750_000))]
  ]) {
    const rejected=await route('PUT',`${base}/batches/${key}`,items);
    assert.equal(rejected.status,400);
    const failure=(await rejected.json()).error;
    assert.deepEqual({code:failure.code,message:failure.message,retryable:failure.retryable},
      {code:'INVALID_ARGUMENT',message:'INVALID_ARGUMENT',retryable:false});
    assert.match(failure.requestId,/^[a-zA-Z0-9_-]+$/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM batch_operations
      WHERE space_id=$1 AND collection_id=$2 AND operation_key=$3`,
    [space.spaceId,collection,key])).rows[0].n,0);
  }
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

test('HTTP mutation variants reject malformed envelopes before writing',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  assert.equal((await route('POST','/v1/spaces',{spaceId})).status,201);
  t.after(async()=>{
    current=true; currentProbe=()=>current;
    try { await spaces.archive(actor,spaceId); await spaces.delete(actor,spaceId); }
    catch { /* Keep the disposable database for inspection if cleanup fails. */ }
  });
  const collection='entries';
  const base=`/v1/spaces/${spaceId}/collections/${collection}`;
  const definition={slug:collection,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    unique:[],filterable:[],sortable:[]};
  assert.equal((await route('PUT',base,definition)).status,201);
  const mutate=envelope=>route('POST',`${base}/records`,envelope);
  const assertNoWrite=async(expectedEvents,expectedReceipts)=>{
    const events=await pool.query('SELECT count(*)::int AS n FROM record_events WHERE space_id=$1',[spaceId]);
    const receipts=await pool.query('SELECT count(*)::int AS n FROM idempotency_receipts WHERE space_id=$1',[spaceId]);
    assert.deepEqual([events.rows[0].n,receipts.rows[0].n],[expectedEvents,expectedReceipts]);
  };
  await Promise.all([
    '', '\u0085 \u2003', 'a'.repeat(257), 'é'.repeat(129), '\ud800'
  ].map(async(externalKey,index)=>{
    const response=await mutate({operation:'create',idempotencyKey:`invalid-key-${index}`,
      externalKey,data:{label:'A'}});
    assert.equal(response.status,400,`invalid external key ${index}`);
    assert.equal((await response.json()).error.code,'INVALID_ARGUMENT');
  }));
  await assertNoWrite(0,0);
  const missingData=await mutate({operation:'create',idempotencyKey:'missing-data'});
  assert.equal(missingData.status,400);
  assert.equal((await missingData.json()).error.code,'INVALID_ARGUMENT');
  await assertNoWrite(0,0);
  const create={operation:'create',idempotencyKey:'create',externalKey:'\u0085 e\u0301 \u0085',data:{label:'A'}};
  const createdResponse=await mutate(create);
  assert.equal(createdResponse.status,200);
  const created=await createdResponse.json();
  const id=created.ref.id;
  const equivalent=await (await mutate({...create,externalKey:'é'})).json();
  assert.equal(equivalent.receiptId,created.receiptId);
  assert.equal(equivalent.replayed,true);
  const byKey=await route('GET',`${base}/records/by-key/${encodeURIComponent('é')}?mode=external`);
  assert.equal(byKey.status,200);
  assert.equal((await byKey.json()).ref.id,id);
  for (const invalid of [
    {operation:'create',idempotencyKey:'forbidden-id',id,data:{label:'B'}},
    {operation:'replace',idempotencyKey:'missing-revision',id,data:{label:'B'}},
    {operation:'replace',idempotencyKey:'forbidden-key',id,expectedRevision:1,data:{label:'B'},externalKey:'b'},
    {operation:'patch',idempotencyKey:'missing-unset',id,expectedRevision:1,set:{label:'B'}},
    {operation:'patch',idempotencyKey:'forbidden-data',id,expectedRevision:1,set:{label:'B'},unset:[],data:{}},
    {operation:'delete',idempotencyKey:'missing-id',expectedRevision:1},
    {operation:'delete',idempotencyKey:'forbidden-set',id,expectedRevision:1,set:{label:'B'}}
  ]) {
    const response=await mutate(invalid);
    assert.equal(response.status,400,invalid.idempotencyKey);
    assert.equal((await response.json()).error.code,'INVALID_ARGUMENT');
  }
  await assertNoWrite(1,1);
  const valid=[
    {operation:'replace',idempotencyKey:'replace',id,expectedRevision:1,data:{label:'B'}},
    {operation:'patch',idempotencyKey:'patch',id,expectedRevision:2,set:{label:'C'},unset:[]},
    {operation:'delete',idempotencyKey:'delete',id,expectedRevision:3}
  ];
  for (const [index,envelope] of valid.entries()) {
    const response=await mutate(envelope);
    assert.equal(response.status,200,envelope.operation);
    const receipt=await response.json();
    assert.equal(receipt.revision,index+2);
    assert.equal(receipt.operation,envelope.operation);
  }
  const replay=await (await mutate(valid[2])).json();
  assert.equal(replay.replayed,true);
  await assertNoWrite(4,4);
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

test('collection discovery checks one provider snapshot and set of grants',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  assert.equal((await route('POST','/v1/spaces',{spaceId})).status,201);
  t.after(async()=>{
    currentProbe=()=>current;
    try { await spaces.update(actor,spaceId,'readOnly'); await spaces.delete(actor,spaceId); } catch {}
  });
  const names=Array.from({length:12},(_,index)=>`collection_${String(index).padStart(2,'0')}`);
  for (const slug of names) {
    const definition={slug,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
      type:'object',properties:{label:{type:'string'}},additionalProperties:false},
      unique:[],filterable:[],sortable:[]};
    assert.equal((await route('PUT',`/v1/spaces/${spaceId}/collections/${slug}`,definition)).status,201);
  }
  await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,
    expires_at,activated_at,confirmed_at)
    VALUES($1,$2,'discovery-agent',$3,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
  [spaceId,agent.credentialId,actor.userPrincipalId]);
  for (const slug of names) await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['records:read']::text[])`,[spaceId,slug,agent.credentialId]);
  let checks=0;
  currentProbe=()=>{checks++;return true;};
  const response=await route('GET',`/v1/spaces/${spaceId}/collections`,undefined,'fixture-agent-key');
  assert.equal(response.status,200);
  const first=await response.json();
  assert.deepEqual(first.items.map(item=>item.definition.slug),names.slice(0,8));
  assert.equal(typeof first.cursor,'string');
  assert.equal(checks,2,'one admission and one final credential recheck regardless of collection count');
  await pool.query(`DELETE FROM collection_grants WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,
    [spaceId,names[10],agent.credentialId]);
  const second=await route('GET',`/v1/spaces/${spaceId}/collections?cursor=${encodeURIComponent(first.cursor)}`,
    undefined,'fixture-agent-key');
  assert.equal(second.status,200);
  assert.deepEqual((await second.json()).items.map(item=>item.definition.slug),[names[8],names[9],names[11]]);
  assert.equal(checks,4,'every page rechecks the provider credential');
  const invalid=await route('GET',`/v1/spaces/${spaceId}/collections?cursor=invalid!`,
    undefined,'fixture-agent-key');
  assert.equal(invalid.status,400);
  assert.equal((await invalid.json()).error.code,'CURSOR_INVALID');
  currentProbe=()=>current;
  let definitionRows=0;
  const tracked={connect:async()=>{
    const client=await pool.connect();
    return {query:async(...args)=>{
      const result=await client.query(...args);
      if (String(args[0]).includes('FROM collections c JOIN collection_versions'))
        definitionRows+=result.rows.length;
      return result;
    },release:discard=>client.release(discard)};
  }};
  const selectedHandler=createHttpHandler({services:postgresServices(spaces,new Map([['cell-a',
    {pool:tracked,cursorSecret:randomBytes(32)}]]),3600),identity});
  const selected=await selectedHandler(new Request(`https://stateplane.example.invalid/v1/spaces/${spaceId}/collections/${names[0]}`,
    {headers:{Authorization:'Bearer fixture-agent-key'}}));
  assert.equal(selected.status,200);
  assert.equal((await selected.json()).definition.slug,names[0]);
  assert.equal(definitionRows,1,'one-collection HTTP lookup fetches only its definition');
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['records:write']::text[]
    WHERE space_id=$1 AND credential_id=$2`,[spaceId,agent.credentialId]);
  const writeFirst=await route('GET',`/v1/spaces/${spaceId}/collections`,undefined,'fixture-agent-key');
  assert.equal(writeFirst.status,200);
  const writePage=await writeFirst.json();
  assert.deepEqual(writePage.items.map(item=>item.definition.slug),names.slice(0,8));
  const writeNext=await route('GET',
    `/v1/spaces/${spaceId}/collections?cursor=${encodeURIComponent(writePage.cursor)}`,
    undefined,'fixture-agent-key');
  assert.equal(writeNext.status,200);
  assert.deepEqual((await writeNext.json()).items.map(item=>item.definition.slug),[names[8],names[9],names[11]]);
  assert.equal((await route('GET',`/v1/spaces/${spaceId}/collections/${names[0]}`,
    undefined,'fixture-agent-key')).status,200);
  assert.equal((await route('GET',`/v1/spaces/${spaceId}/collections/${names[0]}/records/missing`,
    undefined,'fixture-agent-key')).status,403,'discovery does not authorize record reads');
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()+interval '5 minutes'
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[spaceId,names[0],agent.credentialId]);
  let finalChecks=0;
  currentProbe=async()=>{
    if (++finalChecks===2) {
      const live=await pool.query(`SELECT expires_at>clock_timestamp() AS live FROM collection_grants
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,
      [spaceId,names[0],agent.credentialId]);
      assert.equal(live.rows[0]?.live,true,'grant was live after the initial discovery query');
      await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second'
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,
      [spaceId,names[0],agent.credentialId]);
    }
    return true;
  };
  assert.equal((await route('GET',`/v1/spaces/${spaceId}/collections/${names[0]}`,
    undefined,'fixture-agent-key')).status,403,'write-only grant expiry is checked before response');
  assert.equal(finalChecks,2);
  currentProbe=()=>current;
  await pool.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
    WHERE space_id=$1 AND credential_id=$2`,[spaceId,agent.credentialId]);
  assert.notEqual((await route('GET',
    `/v1/spaces/${spaceId}/collections?cursor=${encodeURIComponent(writePage.cursor)}`,
    undefined,'fixture-agent-key')).status,200,'revoked key cannot continue discovery');
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
    const early=await Promise.race([second.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);
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

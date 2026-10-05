import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { types, promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAuthority, CollectionRegistry, validateDefinition, validateValue, compatible, externalKey, derivedValues } from '../../packages/postgres/dist/index.js';

const password=process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const baseUrl=process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const disposableName=process.env.DATABASE_URL ? null : `stateplane_collections_${randomUUID().replaceAll('-','')}`;
const url=disposableName ? baseUrl.replace(/\/stateplane$/,`/${disposableName}`) : baseUrl;
if (disposableName) {
  const admin=new pg.Client({connectionString:baseUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${disposableName}`); } finally { await admin.end(); }
  execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env:{...process.env,DATABASE_URL:url},stdio:'inherit'});
}
const pool=new pg.Pool({connectionString:url,max:6});
test.after(async()=>{
  await pool.end();
  if (disposableName) {
    const admin=new pg.Client({connectionString:baseUrl}); await admin.connect();
    try { await admin.query(`DROP DATABASE ${disposableName}`); } finally { await admin.end(); }
  }
});
const authority=new PostgresAuthority(pool,3600);
const registry=new CollectionRegistry(pool);
const schema={
  $schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,
  properties:{label:{type:'string'},score:{type:['number','null']},state:{type:'string',enum:['open','closed']}},required:['label']
};
const definition=(slug,overrides={})=>({slug,version:1,schema,unique:[{name:'label',paths:['label']}],filterable:['score'],sortable:[],...overrides});
async function fixture() {
  const suffix=randomUUID(); const spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'owner-session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await registry.define(owner,definition(collectionId));
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,'agent',ARRAY['records:read','records:write','schema:write'])`,[spaceId,collectionId]);
  const writer={...owner,principalId:'agent-principal',credentialId:'agent',capability:'records:write'};
  return {owner,writer};
}
const read=scope=>({...scope,capability:'records:read'});
function observedRegistry(matches) {
  let signal;
  const attempted=new Promise(resolve=>{signal=resolve;});
  const observed=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:(sql,...args)=>{
      if (matches(String(sql))) signal();
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }});
  return {observed,attempted};
}

test('definition subset, additive revisions and normalization have explicit failures',()=>{
  const d=definition('generic');
  assert.equal(validateDefinition(d).version,1);
  assert.equal(externalKey('\u0085 e\u0301 \u0085'),'é');
  assert.equal(externalKey('\ufeffx\ufeff'),'\ufeffx\ufeff');
  assert.equal(derivedValues({label:'e\u0301',score:null},d).unique[0].encodedValue,
    derivedValues({label:'é',score:null},d).unique[0].encodedValue);
  for (const [decomposed,composed] of [['e\u0301','é'],['A\u030a','Å'],['가','가']]) {
    assert.equal(externalKey(`\u0085 ${decomposed} \u0085`),externalKey(composed));
    assert.equal(externalKey(externalKey(decomposed)),externalKey(composed));
    assert.equal(derivedValues({label:decomposed},d).unique[0].encodedValue,
      derivedValues({label:composed},d).unique[0].encodedValue);
  }
  assert.deepEqual(derivedValues({label:'x'},d).indexes,[{field:'score',kind:'missing'}]);
  assert.equal(derivedValues({label:'x',score:null},d).indexes[0].kind,'null');
  assert.throws(()=>validateDefinition(definition('bad',{schema:{...schema,patternProperties:{}}})),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>validateDefinition(definition('bad',{unique:[{name:'dup',paths:['label']},{name:'dup',paths:['score']}]})),{code:'SCHEMA_UNSUPPORTED'});
  const indexed=Object.fromEntries(Array.from({length:17},(_,i)=>[`field${i}`,{type:'string'}]));
  assert.throws(()=>validateDefinition(definition('too-many-indexes',{
    schema:{...schema,properties:{...schema.properties,...indexed}},
    filterable:Object.keys(indexed)
  })),{code:'SCHEMA_UNSUPPORTED'});
  const uniqueFields=Object.fromEntries(Array.from({length:17},(_,i)=>[`unique${i}`,{type:'string'}]));
  assert.throws(()=>validateDefinition(definition('too-many-unique-fields',{
    schema:{...schema,properties:{...schema.properties,...uniqueFields}},
    unique:Object.keys(uniqueFields).map((field,i)=>({name:`u${i}`,paths:[field]})),filterable:[]
  })),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>validateDefinition(definition('too-many-total-indexed-fields',{
    schema:{...schema,properties:{...schema.properties,...uniqueFields}},
    unique:[{name:'one',paths:['unique0']}],filterable:Object.keys(uniqueFields).slice(1)
  })),{code:'SCHEMA_UNSUPPORTED'});
  const next=definition('generic',{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string',description:'optional'}}}});
  assert.doesNotThrow(()=>compatible(d,next));
  assert.throws(()=>compatible(d,{...next,schema:{...next.schema,required:['label','note']}}),{code:'SCHEMA_BREAKING'});
  assert.throws(()=>compatible(d,{...next,unique:[{name:'new',paths:['label']}]}),{code:'SCHEMA_BREAKING'});
});

test('a legacy collection above the new index cap can revise without adding paths',async()=>{
  const spaceId=`sp_${randomUUID()}`,collectionId=`legacy_${randomUUID()}`;
  const fields=Array.from({length:17},(_,index)=>`field${index}`);
  const legacySchema={...schema,properties:{...schema.properties,
    ...Object.fromEntries(fields.map(field=>[field,{type:'string'}]))}};
  const previous=definition(collectionId,{schema:legacySchema,
    unique:fields.map((field,i)=>({name:`u${i}`,paths:[field]})),filterable:fields,sortable:[]});
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'owner-session',capability:'schema:write',
    policyVersion:1,placementGeneration:1};
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const seed=await pool.connect();
  try {
    await seed.query('BEGIN');
    await seed.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)',[spaceId,collectionId]);
    await seed.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES($1,$2,1,$3)`,[spaceId,collectionId,JSON.stringify(previous)]);
    await seed.query('COMMIT');
  } catch(error) { await seed.query('ROLLBACK'); throw error; }
  finally { seed.release(); }
  for (const field of fields) await pool.query(`INSERT INTO collection_index_declarations
    (space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
    VALUES($1,$2,$3,'string',TRUE,FALSE,TRUE,1)`,[spaceId,collectionId,field]);
  const revised={...previous,version:2};
  assert.equal((await registry.revise(owner,1,revised)).version,2);
  const withNote={...revised,version:3,
    schema:{...legacySchema,properties:{...legacySchema.properties,note:{type:'string'}}}};
  assert.equal((await registry.reviseSerialized(owner,2,JSON.stringify(withNote))).version,3);
  const extra='newField';
  const attempted={...withNote,version:4,
    schema:{...withNote.schema,properties:{...withNote.schema.properties,[extra]:{type:'string'}}},
    filterable:[...fields,extra]};
  const originalFlatMap=Array.prototype.flatMap,originalSome=Array.prototype.some;
  try {
    Array.prototype.flatMap=function(){ return []; };
    Array.prototype.some=function(){ return false; };
    await assert.rejects(registry.revise(owner,3,attempted),{code:'SCHEMA_UNSUPPORTED'});
  } finally {
    Array.prototype.flatMap=originalFlatMap;
    Array.prototype.some=originalSome;
  }
  await assert.rejects(registry.reviseSerialized(owner,3,JSON.stringify(attempted)),{code:'SCHEMA_UNSUPPORTED'});
});

test('unindexed Unicode NUL survives writes and replay while indexed siblings fail explicitly',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const wide={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:wide,filterable:['score']}));
  const writer={...owner,capability:'records:write'};
  const nul='left\0right';
  assert.doesNotThrow(()=>validateValue({label:'one',note:nul},wide));
  const create={operation:'create',idempotencyKey:'nul-create',data:{label:'one',note:nul,score:3}};
  const created=await authority.mutateRequest(writer,create);
  assert.equal((await authority.mutateRequest(writer,create)).receiptId,created.receiptId);
  assert.equal((await pool.query('SELECT canonical_data,data FROM records WHERE record_id=$1',[created.ref.id])).rows[0].data,null);
  const replace={operation:'replace',idempotencyKey:'nul-replace',id:created.ref.id,expectedRevision:1,data:{label:'one',note:`${nul}!`,score:3}};
  const replaced=await authority.mutateRequest(writer,replace);
  assert.equal((await authority.mutateRequest(writer,replace)).receiptId,replaced.receiptId);
  const patch={operation:'patch',idempotencyKey:'nul-patch',id:created.ref.id,expectedRevision:2,set:{note:`${nul}?`},unset:[]};
  const patched=await authority.mutateRequest(writer,patch);
  assert.equal((await authority.mutateRequest(writer,patch)).receiptId,patched.receiptId);
  const stored=await authority.transaction(read(writer),tx=>tx.getRecord(created.ref.id));
  assert.equal(JSON.parse(stored.canonicalData).note,`${nul}?`);
  assert.equal((await pool.query('SELECT data FROM records WHERE record_id=$1',[created.ref.id])).rows[0].data,null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_index_values WHERE record_id=$1',[created.ref.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_unique_keys WHERE record_id=$1',[created.ref.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_events WHERE record_id=$1',[created.ref.id])).rows[0].n,3);
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'nul-unique',data:{label:nul}}),{code:'SCHEMA_INVALID'});
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:wide,filterable:['score','note']}));
  await assert.rejects(registry.backfill(owner,'note'),{code:'SCHEMA_INVALID'});
  assert.deepEqual((await registry.discover(owner))[0].pending,['note','score']);
  await authority.mutateRequest(writer,{operation:'replace',idempotencyKey:'clean-note',id:created.ref.id,expectedRevision:3,
    data:{label:'one',note:'clean',score:3}});
  assert.deepEqual(await registry.backfill(owner,'note'),{processed:1,ready:true});
  assert.equal((await pool.query('SELECT data FROM records WHERE record_id=$1',[created.ref.id])).rows[0].data.note,'clean');
});

test('NUL projection and ordinary JSONB remain atomic when string includes is replaced',async()=>{
  const {owner,writer}=await fixture();
  const wide={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:wide}));
  const original=String.prototype.includes;
  const withTamperedIncludes=async(answer,run)=>{
    String.prototype.includes=function(search,...rest){
      if (search==='\0' || search==='\\u0000') return answer;
      return Reflect.apply(original,this,[search,...rest]);
    };
    try { return await run(); } finally { String.prototype.includes=original; }
  };
  const nul='left\0right';
  const create={operation:'create',idempotencyKey:'nul-includes-create',data:{label:'nul-includes',score:1,note:nul}};
  const facts=async id=>(await pool.query(`SELECT r.canonical_data,r.data,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=r.space_id) AS receipts,
    (SELECT count(*)::int FROM record_events WHERE space_id=r.space_id) AS events,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=r.space_id) AS outbox,
    (SELECT count(*)::int FROM record_unique_keys WHERE space_id=r.space_id) AS unique_keys,
    (SELECT count(*)::int FROM record_index_values WHERE space_id=r.space_id) AS indexes
    FROM records r WHERE r.space_id=$1 AND r.record_id=$2`,[writer.spaceId,id])).rows[0];
  const first=await withTamperedIncludes(false,()=>authority.mutateRequest(writer,create));
  const replace={operation:'replace',idempotencyKey:'nul-includes-replace',id:first.ref.id,expectedRevision:1,
    data:{label:'nul-includes',score:1,note:`${nul}!`}};
  await withTamperedIncludes(false,()=>authority.mutateSerializedRequest(writer,JSON.stringify(replace)));
  const patch={operation:'patch',idempotencyKey:'nul-includes-patch',id:first.ref.id,expectedRevision:2,
    set:{score:2,note:`${nul}?`},unset:[]};
  await withTamperedIncludes(false,()=>authority.mutateRequest(writer,patch));
  const replay=await withTamperedIncludes(false,()=>authority.mutateRequest(writer,create));
  assert.equal(replay.replayed,true);
  assert.equal(replay.receiptId,first.receiptId);
  const stored=await facts(first.ref.id);
  assert.deepEqual({receipts:stored.receipts,events:stored.events,outbox:stored.outbox,uniqueKeys:stored.unique_keys,indexes:stored.indexes},
    {receipts:3,events:3,outbox:3,uniqueKeys:1,indexes:1});
  assert.equal(stored.data,null);
  assert.equal(JSON.parse(stored.canonical_data).note,`${nul}?`);
  const ordinary=await withTamperedIncludes(true,()=>authority.mutateSerializedRequest(writer,
    JSON.stringify({operation:'create',idempotencyKey:'ordinary-includes',data:{label:'ordinary',score:3}})));
  const ordinaryStored=await facts(ordinary.ref.id);
  assert.equal(ordinaryStored.data.label,'ordinary');
  assert.deepEqual({receipts:ordinaryStored.receipts,events:ordinaryStored.events,outbox:ordinaryStored.outbox,
    uniqueKeys:ordinaryStored.unique_keys,indexes:ordinaryStored.indexes},
  {receipts:4,events:4,outbox:4,uniqueKeys:2,indexes:2});
});

test('altered iterators cannot commit an active mutation or omit its receipt',async()=>{
  const {writer}=await fixture();
  const originalSetIterator=Set.prototype[Symbol.iterator];
  const originalEntries=Array.prototype.entries;
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const held=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('INSERT INTO records(')) { entered(); await gate; }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600);
  let pending;
  let completed=false;
  try {
    const committing=held.transaction(writer,async tx=>{
      pending=tx.mutateRequest({operation:'create',idempotencyKey:'iterated',data:{label:'iterated'}});
      void pending.catch(()=>{});
      await waiting;
      Set.prototype[Symbol.iterator]=function*(){};
      Array.prototype.entries=function*(){};
    }).then(value=>{completed=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(completed,false,'commit must wait for the pending record write');
    release();
    await committing;
    Set.prototype[Symbol.iterator]=originalSetIterator;
    Array.prototype.entries=originalEntries;
    const receipt=await pending;
    assert.equal(receipt.revision,1);
    const facts=await pool.query(`SELECT
      (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
      (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
      (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
      (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[writer.spaceId]);
    assert.deepEqual(facts.rows[0],{records:1,receipts:1,events:1,outbox:1});
    assert.equal((await held.mutateRequest(writer,{operation:'create',idempotencyKey:'iterated',data:{label:'iterated'}})).replayed,true);
  } finally {
    release?.();
    Set.prototype[Symbol.iterator]=originalSetIterator;
    Array.prototype.entries=originalEntries;
  }
});

test('altered Map methods cannot separate records from receipts or bypass replay',async()=>{
  const {writer}=await fixture();
  const original={set:Map.prototype.set,get:Map.prototype.get,has:Map.prototype.has,clear:Map.prototype.clear};
  const facts=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
    (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[writer.spaceId])).rows[0];
  try {
    Map.prototype.set=function(){return this;};
    const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'map-create',data:{label:'map'}});
    assert.ok(created.committedAt);
    assert.deepEqual(await facts(),{records:1,receipts:1,events:1,outbox:1});
    const replaced=await authority.mutateSerializedRequest(writer,JSON.stringify({operation:'replace',idempotencyKey:'map-replace',
      id:created.ref.id,expectedRevision:1,data:{label:'map',score:1}}));
    assert.equal(replaced.revision,2);
    const patched=await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'map-patch',
      id:created.ref.id,expectedRevision:2,set:{score:2},unset:[]});
    assert.equal(patched.revision,3);
    const deleted=await authority.mutateSerializedRequest(writer,JSON.stringify({operation:'delete',idempotencyKey:'map-delete',
      id:created.ref.id,expectedRevision:3}));
    assert.equal(deleted.revision,4);
    assert.deepEqual(await facts(),{records:1,receipts:4,events:4,outbox:4});
    await assert.rejects(authority.transaction(writer,async tx=>{
      await tx.mutateRequest({operation:'create',idempotencyKey:'map-batch-good',data:{label:'batch-good'}});
      await tx.mutateRequest({operation:'create',idempotencyKey:'map-batch-duplicate',data:{label:'batch-good'}});
    }),{code:'UNIQUE_CONFLICT'});
    assert.deepEqual(await facts(),{records:1,receipts:4,events:4,outbox:4},'failed batch rolls back every fact');
    const pair=await authority.transaction(writer,async tx=>[
      await tx.mutateRequest({operation:'create',idempotencyKey:'map-pair-a',data:{label:'pair-a'}}),
      await tx.mutateRequest({operation:'create',idempotencyKey:'map-pair-b',data:{label:'pair-b'}})]);
    assert.ok(pair.every(receipt=>receipt.committedAt));
    assert.deepEqual(await facts(),{records:3,receipts:6,events:6,outbox:6});
    Map.prototype.get=function(){return undefined;};
    Map.prototype.has=function(){return false;};
    Map.prototype.clear=function(){return this;};
    const replay=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'map-create',data:{label:'map'}});
    assert.equal(replay.replayed,true);
    assert.equal(replay.receiptId,created.receiptId);
    assert.deepEqual(await facts(),{records:3,receipts:6,events:6,outbox:6});
  } finally { Object.assign(Map.prototype,original); }
});

test('shared schema DAG expansion is bounded before canonical allocation',()=>{
  let child={type:'string'};
  for (let depth=0;depth<30;depth++) child={type:'object',additionalProperties:false,properties:{left:child,right:child}};
  const shared={...schema,properties:{branch:child}};
  assert.throws(()=>validateDefinition(definition('dag',{schema:shared})),{code:'SCHEMA_UNSUPPORTED'});
  const small={type:'string'};
  assert.equal(validateDefinition(definition('shared',{schema:{...schema,properties:{...schema.properties,left:small,right:small}}})).slug,'shared');
});

test('definitions and requests keep entry snapshots across pool and query waits',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const heldRegistry=new CollectionRegistry({connect:async()=>{entered();await gate;return pool.connect();}});
  const draft=structuredClone(definition(collectionId));
  const defining=heldRegistry.define(owner,draft);
  await waiting;
  draft.schema.properties.label.type='number';
  draft.filterable.length=0;
  release();
  assert.equal((await defining).schema.properties.label.type,'string');
  assert.deepEqual((await registry.discover(owner))[0].definition.filterable,['score']);

  const writer={...owner,capability:'records:write'};
  let queried,continueQuery;
  const queryStarted=new Promise(resolve=>queried=resolve),queryGate=new Promise(resolve=>continueQuery=resolve);
  const heldAuthority=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('stateplane_try_reserve_receipt')) { queried(); await queryGate; }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600);
  const request={operation:'create',idempotencyKey:'snapshot',data:{label:'original'}};
  const creating=heldAuthority.mutateRequest(writer,request);
  await queryStarted;
  request.data.label='changed';
  continueQuery();
  const receipt=await creating;
  assert.equal(JSON.parse((await authority.transaction(read(writer),tx=>tx.getRecord(receipt.ref.id))).canonicalData).label,'original');

  let connected,allowConnection;
  const poolWaiting=new Promise(resolve=>connected=resolve),poolGate=new Promise(resolve=>allowConnection=resolve);
  const poolHeld=new PostgresAuthority({connect:async()=>{connected();await poolGate;return pool.connect();}},3600);
  const queued={operation:'create',idempotencyKey:'pool-snapshot',data:{label:'before-pool'}};
  const queuedWrite=poolHeld.mutateRequest(writer,queued);
  await poolWaiting;
  queued.data.label='after-pool';
  allowConnection();
  const queuedReceipt=await queuedWrite;
  assert.equal(JSON.parse((await authority.transaction(read(writer),tx=>tx.getRecord(queuedReceipt.ref.id))).canonicalData).label,'before-pool');

  let revisingEntered,allowRevision;
  const revisionWaiting=new Promise(resolve=>revisingEntered=resolve),revisionGate=new Promise(resolve=>allowRevision=resolve);
  const revisionRegistry=new CollectionRegistry({connect:async()=>{revisingEntered();await revisionGate;return pool.connect();}});
  const next=definition(collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
  const revising=revisionRegistry.revise(owner,1,next);
  await revisionWaiting;
  next.schema.properties.note.type='number';
  allowRevision();
  assert.equal((await revising).schema.properties.note.type,'string');
});

test('schema authorization precedes malformed-definition disclosure',async()=>{
  const {owner}=await fixture();
  const stranger={...owner,principalId:'stranger',credentialId:'stranger'};
  const malformed=definition(owner.collectionId,{schema:{...schema,patternProperties:{}}});
  await assert.rejects(registry.revise(stranger,1,malformed),{code:'FORBIDDEN'});
  await assert.rejects(registry.define({...stranger,collectionId:`new_${randomUUID()}`},malformed),{code:'FORBIDDEN'});
});

test('a lost registry BEGIN response discards its possibly open pooled transaction',async()=>{
  const {owner}=await fixture();
  const single=new pg.Pool({connectionString:url,max:1});
  let discarded;
  const lostBegin=new CollectionRegistry({connect:async()=>{
    const client=await single.connect();
    return {query:async(...args)=>{
      const result=await client.query(...args);
      if (args[0]==='BEGIN') throw new Error('lost BEGIN response');
      return result;
    },release:discard=>{discarded=discard;client.release(discard);}};
  }});
  try {
    await assert.rejects(lostBegin.discover(owner),/lost BEGIN response/);
    assert.equal(discarded,true);
    const borrower=await single.connect();
    try { assert.equal((await borrower.query('SELECT txid_current_if_assigned() AS id')).rows[0].id,null); }
    finally { borrower.release(); }
    assert.equal((await new CollectionRegistry(single).discover(owner)).length,1);
  } finally { await single.end(); }
});

test('concurrent first definitions return the public schema conflict',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const results=await Promise.allSettled([registry.define(owner,definition(collectionId)),registry.define(owner,definition(collectionId))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'SCHEMA_CONFLICT');
});

test('schema and reservation decisions use own array members after iterator replacement',()=>{
  const original=Array.prototype[Symbol.iterator];
  let accepted,bad,derived;
  try {
    Array.prototype[Symbol.iterator]=function*(){};
    accepted=validateDefinition(definition('generic',{schema:{...schema,properties:{...schema.properties,tags:{type:'array',items:{type:'string'},maxItems:2}}}}));
    try { validateDefinition(definition('generic',{unique:[{name:'label',paths:['label','label']}]})); }
    catch (error) { bad=error; }
    derived=derivedValues({label:'x',score:2},accepted);
  } finally { Array.prototype[Symbol.iterator]=original; }
  assert.equal(accepted.schema.properties.tags.type,'array');
  assert.equal(bad?.code,'SCHEMA_UNSUPPORTED');
  assert.equal(derived.unique.length,1);
  assert.equal(derived.indexes.length,1);
});

test('absent optional schema keywords cannot be supplied by later prototype pollution',()=>{
  const schemaWithoutRequired={...schema};
  delete schemaWithoutRequired.required;
  const prior=Object.getOwnPropertyDescriptor(Object.prototype,'required');
  let accepted;
  try {
    Object.defineProperty(Object.prototype,'required',{value:['label'],configurable:true});
    accepted=validateDefinition(definition('generic',{schema:schemaWithoutRequired}));
    validateValue({},accepted.schema);
  } finally {
    if (prior) Object.defineProperty(Object.prototype,'required',prior);
    else delete Object.prototype.required;
  }
  assert.equal(Object.hasOwn(accepted.schema,'required'),false);
});

test('compatible optional additions ignore inherited required lists in direct and registry revisions',async()=>{
  const {owner}=await fixture();
  const scope={...owner,collectionId:`optional_${randomUUID()}`};
  const oldSchema={...schema};
  delete oldSchema.required;
  const oldDefinition=validateDefinition(definition('generic',{schema:oldSchema}));
  const nextSchema={...oldSchema,properties:{...oldSchema.properties,note:{type:'string'}}};
  const nextDefinition=validateDefinition(definition('generic',{version:2,schema:nextSchema}));
  await registry.define(scope,definition(scope.collectionId,{schema:oldSchema}));
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,'required');
  try {
    Object.defineProperty(Object.prototype,'required',{value:['note'],configurable:true});
    assert.doesNotThrow(()=>compatible(oldDefinition,nextDefinition));
    assert.throws(()=>compatible(oldDefinition,{...nextDefinition,schema:{...nextSchema,required:['note']}}),{code:'SCHEMA_BREAKING'});
    // The stored definition also lacks an own required keyword after parsing.
    const current=await registry.revise(scope,1,definition(scope.collectionId,{version:2,schema:nextSchema}));
    assert.equal(current.version,2);
    assert.equal(Object.hasOwn(current.schema,'required'),false);
  } finally {
    if (previous) Object.defineProperty(Object.prototype,'required',previous);
    else delete Object.prototype.required;
  }
});

test('registry, safe mutation, replay, races, tombstones and index readiness',async()=>{
  const {owner,writer}=await fixture();
  const create={operation:'create',idempotencyKey:'create-a',externalKey:' \u00e9 ',expectedSchemaVersion:1,data:{label:'A',score:null,state:'open'}};
  const saved=await authority.mutateRequest(writer,create);
  assert.equal(saved.revision,1);
  assert.equal((await authority.mutateRequest(writer,create)).replayed,true);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('external','é'))).ref.id,saved.ref.id);
  await assert.rejects(authority.mutateRequest(writer,{...create,idempotencyKey:'key-reuse'}),{code:'KEY_RESERVED'});
  await assert.rejects(authority.mutateRequest(writer,{...create,idempotencyKey:'unique',externalKey:'different',data:{label:'A'}}),{code:'UNIQUE_CONFLICT'});
  const replace=(key)=>({operation:'replace',idempotencyKey:key,id:saved.ref.id,expectedRevision:1,data:{label:'B',score:2,state:'open'}});
  const raced=await Promise.allSettled([authority.mutateRequest(writer,replace('r1')),authority.mutateRequest(writer,replace('r2'))]);
  assert.equal(raced.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(raced.map(x=>x.status==='rejected' ? {code:x.reason.code,message:x.reason.message} : {status:x.status})));
  const winningKey=raced[0].status==='fulfilled' ? 'r1' : 'r2';
  const conflict=raced.find(x=>x.status==='rejected').reason;
  assert.equal(conflict.code,'REVISION_CONFLICT');
  assert.equal(conflict.currentRevision,2);
  const next=await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'noop',id:saved.ref.id,expectedRevision:2,set:{},unset:[]});
  assert.equal(next.revision,3);
  const added=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string',description:'annotation'}}},filterable:['score','note']});
  await assert.rejects(registry.revise(owner,1,{...added,schema:{...added.schema,required:['label','note']}}),{code:'SCHEMA_BREAKING'});
  assert.equal((await registry.discover(owner))[0].definition.version,1);
  await registry.revise(owner,1,added);
  assert.deepEqual((await registry.discover(owner))[0].pending.sort(),['note','score']);
  await assert.rejects(authority.transaction(read(writer),tx=>tx.countRecords([{field:'note',kind:'string',operator:'eq',value:'x'}])),{code:'SCHEMA_CONFLICT'});
  assert.equal((await authority.mutateRequest(writer,replace(winningKey))).replayed,true);
  assert.equal((await authority.mutateRequest(writer,create)).receiptId,saved.receiptId);
  await assert.rejects(authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'version-fail',id:saved.ref.id,expectedRevision:3,expectedSchemaVersion:1,set:{note:'x'},unset:[]}),{code:'SCHEMA_CONFLICT'});
  const patch=await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'patch-new',id:saved.ref.id,expectedRevision:3,set:{note:'x'},unset:[]});
  assert.equal(patch.schemaVersion,2);
  await registry.backfill(owner,'score');
  await registry.backfill(owner,'note');
  assert.equal((await authority.transaction(read(writer),tx=>tx.countRecords([{field:'note',kind:'string',operator:'eq',value:'x'}]))),1);
  const deleted=await authority.mutateRequest(writer,{operation:'delete',idempotencyKey:'delete',id:saved.ref.id,expectedRevision:4});
  assert.equal(deleted.revision,5);
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'reused',externalKey:'é',data:{label:'new'}}),{code:'KEY_RESERVED'});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'reused-unique',data:{label:'B'}}),{code:'KEY_RESERVED'});
  assert.equal(await authority.transaction(read(writer),tx=>tx.getRecord(saved.ref.id)),null);
});

test('schema revision waits for an in-flight validated write and rollback has no facts',async()=>{
  const {owner,writer}=await fixture();
  let release,entered;
  const held=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const request={operation:'create',idempotencyKey:'held',data:{label:'held'}};
  const write=authority.transaction(writer,async tx=>{
    const receipt=await tx.mutateRequest(request);
    entered();
    await held;
    return receipt;
  });
  await started;
  const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
  let revised=false;
  const {observed,attempted}=observedRegistry(sql=>sql.includes('FROM collections') && sql.includes('FOR UPDATE'));
  const revision=observed.revise(owner,1,next).then(value=>{revised=true;return value;});
  await attempted;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(revised,false);
  release();
  const receipt=await write;
  await revision;
  assert.equal(receipt.schemaVersion,1);
  const later=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'later',data:{label:'later'}});
  assert.equal(later.schemaVersion,2);
  const before=await pool.query(`SELECT
    (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
    (SELECT count(*)::int FROM record_unique_keys WHERE space_id=$1) AS unique_keys,
    (SELECT count(*)::int FROM record_index_values WHERE space_id=$1) AS indexes,
    (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[owner.spaceId]);
  await assert.rejects(authority.transaction(writer,async tx=>{
    await tx.mutateRequest({operation:'create',idempotencyKey:'rollback',data:{label:'rollback',score:3}});
    throw new Error('abort');
  }),/abort/);
  const after=await pool.query(`SELECT
    (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
    (SELECT count(*)::int FROM record_unique_keys WHERE space_id=$1) AS unique_keys,
    (SELECT count(*)::int FROM record_index_values WHERE space_id=$1) AS indexes,
    (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[owner.spaceId]);
  assert.deepEqual(after.rows[0],before.rows[0]);
  const count=await pool.query(`SELECT count(*)::int AS n FROM record_events WHERE space_id=$1 AND collection_id=$2`,[owner.spaceId,owner.collectionId]);
  assert.equal(count.rows[0].n,2);
});

test('two concurrent revisions accept exactly one expected version',async()=>{
  const {owner}=await fixture();
  const added=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
  const raced=await Promise.allSettled([registry.revise(owner,1,added),registry.revise(owner,1,added)]);
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(raced.find(result=>result.status==='rejected').reason.code,'SCHEMA_CONFLICT');
  assert.equal((await registry.discover(owner))[0].definition.version,2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collection_versions WHERE space_id=$1 AND collection_id=$2',
    [owner.spaceId,owner.collectionId])).rows[0].n,2);
});

test('revision waits for a backfill batch and reads its committed readiness',async()=>{
  const {owner}=await fixture();
  let entered,release;
  const atBatch=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const held=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      const result=await client.query(sql,...args);
      if (String(sql).includes('FROM collection_index_declarations') && String(sql).includes('FOR NO KEY UPDATE')) { entered(); await gate; }
      return result;
    },release:discard=>client.release(discard)};
  }});
  const backfill=held.backfill(owner,'score');
  await atBatch;
  const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}},filterable:['score','note']});
  let revised=false;
  const {observed,attempted}=observedRegistry(sql=>sql.includes('FROM collections') && sql.includes('FOR UPDATE'));
  const revising=observed.revise(owner,1,next).then(value=>{revised=true;return value;});
  await attempted;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(revised,false);
  release();
  assert.deepEqual(await backfill,{processed:0,ready:true});
  assert.equal((await revising).version,2);
  const found=(await registry.discover(owner))[0];
  assert.deepEqual(found.ready,['score']);
  assert.deepEqual(found.pending,['note']);
});

test('backfill waits for a revision and reads the newly committed declaration',async()=>{
  const {owner}=await fixture();
  let entered,release;
  const atRevision=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const held=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      const result=await client.query(sql,...args);
      if (String(sql).includes('FROM collections') && String(sql).includes('FOR UPDATE')) { entered(); await gate; }
      return result;
    },release:discard=>client.release(discard)};
  }});
  const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}},filterable:['score','note']});
  const revising=held.revise(owner,1,next);
  await atRevision;
  let completed=false;
  const {observed,attempted}=observedRegistry(sql=>sql.includes('SELECT schema_version FROM collections') && sql.includes('FOR SHARE'));
  const backfilling=observed.backfill(owner,'note').then(result=>{completed=true;return result;});
  await attempted;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(completed,false);
  release();
  assert.equal((await revising).version,2);
  assert.deepEqual(await backfilling,{processed:0,ready:true});
  assert.deepEqual((await registry.discover(owner))[0].ready,['note']);
});

test('a partial backfill remains unavailable until a bounded final activation',async()=>{
  const suffix=randomUUID(); const spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const schemaWithNote={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:schemaWithNote,unique:[],filterable:[]}));
  await pool.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT $1,$2,'rec_'||lpad(g::text,3,'0'),1,1,'generated','rec_'||lpad(g::text,3,'0'),
      format('{"label":"x%s","note":"v%s"}',g,g),jsonb_build_object('label','x'||g,'note','v'||g)
    FROM generate_series(1,101) g`,[spaceId,collectionId]);
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:schemaWithNote,unique:[],filterable:['note']}));
  const reader={...owner,capability:'records:read'};
  const predicate=[{field:'note',kind:'string',operator:'eq',value:'v101'}];
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(predicate)),{code:'SCHEMA_CONFLICT'});
  const misleadingPredicate=[predicate[0]];
  misleadingPredicate.map=()=>[];
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(misleadingPredicate)),{code:'INVALID_ARGUMENT'});
  assert.deepEqual(await registry.backfill(owner,'note'),{processed:100,ready:false});
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(predicate)),{code:'SCHEMA_CONFLICT'});
  const interrupted=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:(sql,...args)=>{
      if (String(sql).includes('INSERT INTO record_index_values')) throw new Error('interrupted batch');
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }});
  await assert.rejects(interrupted.backfill(owner,'note'),/interrupted batch/);
  const cursor=await pool.query(`SELECT backfill_after,ready FROM collection_index_declarations
    WHERE space_id=$1 AND collection_id=$2 AND field_name='note'`,[spaceId,collectionId]);
  assert.deepEqual(cursor.rows[0],{backfill_after:'rec_100',ready:false});
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(predicate)),{code:'SCHEMA_CONFLICT'});
  await authority.mutateRequest({...owner,capability:'records:write'},
    {operation:'create',idempotencyKey:'between-batches',data:{label:'later',note:'v101'}});
  const remaining=(await pool.query(`SELECT count(*)::int AS n FROM records
    WHERE space_id=$1 AND collection_id=$2 AND record_id>'rec_100'`,[spaceId,collectionId])).rows[0].n;
  let locked,release,competing;
  const firstLocked=new Promise(resolve=>locked=resolve),gate=new Promise(resolve=>release=resolve);
  const secondEntered=new Promise(resolve=>competing=resolve);
  const worker=(pause,signal)=>new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('pg_advisory')) throw new Error('Hyperdrive rejects advisory locks');
      if (String(sql).includes('SELECT ready,backfill_after FROM collection_index_declarations')) {
        if (signal) signal();
        const result=await client.query(sql,...args);
        if (pause) { locked(); await gate; }
        return result;
      }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }});
  const first=worker(true).backfill(owner,'note');
  await firstLocked;
  const second=worker(false,competing).backfill(owner,'note');
  await secondEntered;
  release();
  const final=await Promise.all([first,second]);
  assert.deepEqual(final.map(result=>result.processed).sort((a,b)=>a-b),[0,remaining]);
  assert.ok(final.every(result=>result.ready));
  assert.equal(await authority.transaction(reader,tx=>tx.countRecords(predicate)),2);
});

test('space-scoped discovery, bounded backfill input and nonblocking readiness reads',async()=>{
  const {owner,writer}=await fixture();
  const spaceScope={...owner};
  delete spaceScope.collectionId;
  assert.equal((await registry.discover(spaceScope)).length,1);
  await assert.rejects(registry.backfill(owner,'x'.repeat(257)),{code:'INVALID_ARGUMENT'});
  const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'index-wait',data:{label:'index-wait',score:3}});
  let entered,release;
  const atLock=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const held=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      const result=await client.query(sql,...args);
      if (String(sql).includes('FOR NO KEY UPDATE')) { entered(); await gate; }
      return result;
    },release:discard=>client.release(discard)};
  }});
  const backfill=held.backfill(owner,'score');
  try {
    await atLock;
    const predicate={field:'score',kind:'number',operator:'eq',value:3};
    await assert.rejects(Promise.race([
      authority.transaction(read(writer),tx=>tx.queryRecords([predicate],10)),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('read blocked by backfill')),1000))
    ]),{code:'SCHEMA_CONFLICT'});
    release();
    assert.deepEqual(await backfill,{processed:1,ready:true});
    const rows=await authority.transaction(read(writer),tx=>tx.queryRecords([predicate],10));
    assert.equal(rows[0].ref.id,created.ref.id);
  } finally { release(); await backfill.catch(()=>{}); }
});

test('backfill activates one valid index independently of an invalid pending sibling',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const wide={...schema,properties:{...schema.properties,a:{type:'string'},b:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:wide,unique:[],filterable:[]}));
  const writer={...owner,capability:'records:write'},reader=read(owner);
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'old-wide',data:{label:'one',a:'valid',b:randomBytes(300).toString('hex')}});
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:wide,unique:[],filterable:['a','b']}));
  const a=[{field:'a',kind:'string',operator:'eq',value:'valid'}];
  const b=[{field:'b',kind:'string',operator:'eq',value:'anything'}];
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(a)),{code:'SCHEMA_CONFLICT'});
  assert.deepEqual(await registry.backfill(owner,'a'),{processed:1,ready:true});
  assert.equal(await authority.transaction(reader,tx=>tx.countRecords(a)),1);
  await assert.rejects(registry.backfill(owner,'b'),{code:'SCHEMA_INVALID'});
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(b)),{code:'SCHEMA_CONFLICT'});
  const declarations=await pool.query(`SELECT field_name,ready,backfill_after FROM collection_index_declarations
    WHERE space_id=$1 AND collection_id=$2 AND field_name IN ('a','b') ORDER BY field_name`,[spaceId,collectionId]);
  assert.equal(declarations.rows[0].field_name,'a');
  assert.equal(declarations.rows[0].ready,true);
  assert.ok(declarations.rows[0].backfill_after);
  assert.deepEqual(declarations.rows[1],{field_name:'b',ready:false,backfill_after:null});
});

test('oversized merged patch rolls back record, reservation, event, receipt and outbox',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const wide={...schema,properties:{...schema.properties,payload:{type:'string'},note:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:wide,filterable:[]}));
  const writer={...owner,capability:'records:write'};
  const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'base',
    data:{label:'base',payload:'x'.repeat(1_048_400)}});
  const state=()=>pool.query(`SELECT
    (SELECT revision FROM records WHERE space_id=$1 AND record_id=$2) AS revision,
    (SELECT count(*)::int FROM record_unique_keys WHERE space_id=$1) AS unique_keys,
    (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[spaceId,created.ref.id]);
  const before=(await state()).rows[0];
  await assert.rejects(authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'too-wide',
    id:created.ref.id,expectedRevision:1,set:{note:'y'.repeat(200)},unset:[]}),{code:'SCHEMA_INVALID'});
  assert.deepEqual((await state()).rows[0],before);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getRecord(created.ref.id))).revision,1);
});

test('indexed byte budgets reject long values before SQL and on backfill',async()=>{
  const long=randomBytes(300).toString('hex'),longName=randomBytes(140).toString('hex');
  assert.throws(()=>validateDefinition(definition(longName)),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>validateDefinition(definition('short',{unique:[{name:longName,paths:['label']}]})),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>validateDefinition(definition('short',{schema:{...schema,properties:{...schema.properties,[longName]:{type:'string'}}}})),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>externalKey(long),{code:'INVALID_ARGUMENT'});
  const withText=definition('short',{schema:{...schema,properties:{...schema.properties,note:{type:'string'},instant:{type:'string',format:'date-time'}}},
    unique:[{name:'pair',paths:['label','note']}],filterable:['note','instant']});
  assert.throws(()=>derivedValues({label:randomBytes(125).toString('hex'),note:randomBytes(125).toString('hex')},withText),{code:'SCHEMA_INVALID'});
  assert.throws(()=>derivedValues({label:'ok',note:long},withText),{code:'SCHEMA_INVALID'});
  assert.throws(()=>derivedValues({label:'ok',instant:`2024-01-01T00:00:00.${'1'.repeat(500)}Z`},withText),{code:'SCHEMA_INVALID'});
  const {writer}=await fixture();
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:long,data:{label:'short'}}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'long-key',externalKey:long,data:{label:'short'}}),{code:'INVALID_ARGUMENT'});

  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const indexedSchema={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:indexedSchema,unique:[],filterable:[]}));
  const writer2={...owner,capability:'records:write'};
  const created=await authority.mutateRequest(writer2,{operation:'create',idempotencyKey:'long-note',data:{label:'ok',note:long}});
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:indexedSchema,unique:[],filterable:['note']}));
  await assert.rejects(registry.backfill(owner,'note'),{code:'SCHEMA_INVALID'});
  const readiness=await pool.query(`SELECT ready,backfill_after FROM collection_index_declarations WHERE space_id=$1 AND collection_id=$2 AND field_name='note'`,[spaceId,collectionId]);
  assert.deepEqual(readiness.rows[0],{ready:false,backfill_after:null});
  await assert.rejects(authority.mutateRequest(writer2,{operation:'patch',idempotencyKey:'still-long',id:created.ref.id,
    expectedRevision:1,set:{label:'updated'},unset:[]}),{code:'SCHEMA_INVALID'});
});

test('proxy detection stays pinned after runtime method replacement',async()=>{
  const {writer}=await fixture();
  const original=types.isProxy;
  let traps=0;
  const proxy=new Proxy({operation:'create',idempotencyKey:'proxy',data:{label:'proxy'}},{get(){traps++;throw Error('proxy trap');}});
  try {
    for (const replacement of [undefined,()=>false]) {
      types.isProxy=replacement;
      await assert.rejects(authority.mutateRequest({...writer,credentialId:'revoked'},proxy),{code:'INVALID_ARGUMENT'});
      await assert.rejects(authority.mutateRequest(writer,proxy),{code:'INVALID_ARGUMENT'});
      const receipt=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:`valid-${String(replacement)}`,data:{label:`valid-${String(replacement)}`}});
      assert.equal(receipt.revision,1);
    }
    assert.equal(traps,0);
  } finally { types.isProxy=original; }
});

test('backfill lock orders preserve indexes across concurrent update and delete',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const withNote={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.define(owner,definition(collectionId,{schema:withNote,unique:[],filterable:[]}));
  const writer={...owner,capability:'records:write'};
  const changing=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'changing',data:{label:'a',note:'old'}});
  const removing=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'removing',data:{label:'b',note:'old'}});
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:withNote,unique:[],filterable:['note']}));
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const heldRegistry=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      const result=await client.query(sql,...args);
      if (String(sql).includes('LIMIT 100 FOR UPDATE')) { entered(); await gate; }
      return result;
    },release:discard=>client.release(discard)};
  }});
  const backfill=heldRegistry.backfill(owner,'note');
  await waiting;
  const update=authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'update',id:changing.ref.id,expectedRevision:1,set:{note:'new'},unset:[]});
  const deletion=authority.mutateRequest(writer,{operation:'delete',idempotencyKey:'delete',id:removing.ref.id,expectedRevision:1});
  release();
  await Promise.all([backfill,update,deletion]);
  const reader=read(writer);
  const count=value=>authority.transaction(reader,tx=>tx.countRecords([{field:'note',kind:'string',operator:'eq',value}]));
  assert.equal(await count('old'),0);
  assert.equal(await count('new'),1);
  assert.deepEqual((await registry.discover(owner))[0].ready,['note']);
});

test('composite uniqueness skips missing and null, then reserves normalized tombstones',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const composite={...schema,properties:{...schema.properties,group:{type:['string','null']}}};
  await registry.define(owner,definition(collectionId,{schema:composite,unique:[{name:'pair',paths:['label','group']}],filterable:[]}));
  const writer={...owner,capability:'records:write'};
  for (const [id,data] of [['missing-a',{label:'x'}],['missing-b',{label:'x'}],['null-a',{label:'x',group:null}],['null-b',{label:'x',group:null}]])
    await authority.mutateRequest(writer,{operation:'create',idempotencyKey:id,data});
  const saved=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'present',data:{label:'x',group:'e\u0301'}});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'normalized',data:{label:'x',group:'é'}}),{code:'UNIQUE_CONFLICT'});
  await authority.mutateRequest(writer,{operation:'delete',idempotencyKey:'tombstone',id:saved.ref.id,expectedRevision:1});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'reserved',data:{label:'x',group:'é'}}),{code:'KEY_RESERVED'});
  const rows=await pool.query('SELECT count(*)::int AS total FROM record_unique_keys WHERE space_id=$1',[spaceId]);
  assert.equal(rows.rows[0].total,1);
});

test('optional unique fields never read inherited values on writes or backfill',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const writer={...owner,capability:'records:write'};
  const optional='optionalUniqueSTA7';
  const withOptional={...schema,properties:{...schema.properties,[optional]:{type:['string','null']}}};
  await registry.define(owner,definition(collectionId,{schema:withOptional,unique:[{name:'pair',paths:['label',optional]}],filterable:[]}));
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,optional);
  let inheritedReads=0;
  Object.defineProperty(Object.prototype,optional,{configurable:true,get(){ inheritedReads++; throw new Error('inherited unique getter'); }});
  try {
    const missing=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'missing',data:{label:'missing',score:1}});
    await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'null',data:{label:'null',[optional]:null}});
    await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'present',data:{label:'present',[optional]:'value'}});
    await authority.mutateRequest(writer,{operation:'replace',idempotencyKey:'replace',id:missing.ref.id,expectedRevision:1,data:{label:'missing',score:2}});
    await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'patch',id:missing.ref.id,expectedRevision:2,set:{score:3},unset:[]});
    await registry.revise(owner,1,definition(collectionId,{version:2,schema:withOptional,
      unique:[{name:'pair',paths:['label',optional]}],filterable:['score']}));
    assert.deepEqual(await registry.backfill(owner,'score'),{processed:3,ready:true});
    assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([{field:'score',kind:'number',operator:'eq',value:3}])),1);
    assert.equal(inheritedReads,0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype,optional,previous);
    else delete Object.prototype[optional];
  }
});

test('readiness uses the same predicate snapshot as the indexed SQL',async()=>{
  const {owner,writer}=await fixture();
  const reader=read(writer);
  const predicate=[{field:'score',kind:'number',operator:'eq',value:1}];
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const held=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('FROM collection_index_declarations')) { entered(); await gate; }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600);
  const counting=held.transaction(reader,tx=>tx.countRecords(predicate));
  await waiting;
  predicate.length=0;
  release();
  await assert.rejects(counting,{code:'SCHEMA_CONFLICT'});
  assert.equal(await authority.transaction(reader,tx=>tx.countRecords([])),0);
  assert.deepEqual((await registry.discover(owner))[0].pending,['score']);
});

test('sealed transaction rejects late request entrypoints during receipt finalization',async()=>{
  const {owner,writer}=await fixture();
  let entered,release,escaped;
  const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const held=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('WITH stamp AS MATERIALIZED') && String(sql).includes('unnest')) { entered(); await gate; }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600);
  const first=held.transaction(writer,async tx=>{
    escaped=tx;
    return tx.mutateRequest({operation:'create',idempotencyKey:'first',data:{label:'first'}});
  });
  await waiting;
  await assert.rejects(escaped.mutateRequest({operation:'create',idempotencyKey:'late',data:{label:'late'}}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(escaped.mutateSerializedRequest(JSON.stringify({operation:'create',idempotencyKey:'later',data:{label:'later'}})),{code:'INVALID_ARGUMENT'});
  release();
  await first;
  const rows=await pool.query('SELECT canonical_data FROM records WHERE space_id=$1',[owner.spaceId]);
  assert.deepEqual(rows.rows.map(row=>JSON.parse(row.canonical_data).label),['first']);
});

test('generated and external keys are distinct, revoked retries disclose no receipt',async()=>{
  const {owner,writer}=await fixture();
  const generated=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'generated',data:{label:'generated'}});
  const external=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'external',externalKey:generated.ref.id,data:{label:'external'}});
  assert.notEqual(generated.ref.id,external.ref.id);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('generated',generated.ref.id))).ref.id,generated.ref.id);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('external',generated.ref.id))).ref.id,external.ref.id);
  await pool.query(`DELETE FROM collection_grants WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,
    [owner.spaceId,owner.collectionId,writer.credentialId]);
  await pool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[owner.spaceId]);
  await assert.rejects(authority.mutateRequest({...writer,policyVersion:2},{operation:'create',idempotencyKey:'external',externalKey:generated.ref.id,data:{label:'external'}}),{code:'FORBIDDEN'});
});

test('external keys keep one normalized identity across low-level writes and historical raw rows',async()=>{
  const {writer}=await fixture();
  const data={label:'low-level'};
  const values=derivedValues(data,definition(writer.collectionId));
  const raw=' e\u0301 ';
  const change={operation:'create',idempotencyKey:'low-level-key',
    requestDigest:'a'.repeat(64),canonicalData:JSON.stringify(data),normalizedExternalKey:raw,...values};
  const created=await authority.mutate(writer,change);
  assert.equal((await authority.mutate(writer,change)).receiptId,created.receiptId);
  const stored=(await pool.query('SELECT normalized_key FROM records WHERE record_id=$1',[created.ref.id])).rows[0];
  assert.equal(stored.normalized_key,'é');
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('external',raw))).ref.id,created.ref.id);
  await pool.query('UPDATE records SET normalized_key=$2 WHERE record_id=$1',[created.ref.id,raw]);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('external',raw))).ref.id,created.ref.id);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getByKey('external','é'))).ref.id,created.ref.id);
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'normalized-key',externalKey:'é',data:{label:'normalized-key'}}),
    {code:'KEY_RESERVED'});
  const collidingId=`rec_${randomUUID()}`;
  const collidingData=JSON.stringify({label:'historical-collision'});
  // Emulate an already populated database that predates normalized writes.
  const historical=await pool.connect();
  try {
    await historical.query('BEGIN');
    await historical.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      SELECT space_id,collection_id,$2,1,schema_version,'external',$3,$4::text,$4::jsonb FROM records WHERE record_id=$1`,
    [created.ref.id,collidingId,'é',collidingData]);
    await historical.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind)
      VALUES($1,$2,$3,'score','missing')`,[writer.spaceId,writer.collectionId,collidingId]);
    await historical.query('COMMIT');
  } finally { historical.release(); }
  await assert.rejects(authority.transaction(read(writer),tx=>tx.getByKey('external',raw)),{code:'SCHEMA_CONFLICT'});
  await assert.rejects(authority.transaction(read(writer),tx=>tx.getByKey('external','é')),{code:'SCHEMA_CONFLICT'});
  assert.equal((await authority.transaction(read(writer),tx=>tx.getRecord(created.ref.id))).ref.id,created.ref.id);
  assert.equal((await authority.transaction(read(writer),tx=>tx.getRecord(collidingId))).ref.id,collidingId);
});

test('database external-key identity matches the fixed Unicode trim and NFC rule',async()=>{
  const whitespace=[9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288];
  const raw=whitespace.map(code=>`${String.fromCodePoint(code)}e\u0301${String.fromCodePoint(code)}`);
  const rows=await pool.query('SELECT public.stateplane_external_key_identity(value) AS identity FROM unnest($1::text[]) AS value',[raw]);
  assert.deepEqual(rows.rows.map(row=>row.identity),raw.map(externalKey));
  assert.equal((await pool.query('SELECT public.stateplane_external_key_identity($1) AS identity',['\ufeffé\ufeff'])).rows[0].identity,'\ufeffé\ufeff');
});

test('patch unset ignores inherited properties and rejects invalid requests without effects',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await registry.define(owner,definition(collectionId,{schema:{$schema:schema.$schema,type:'object',additionalProperties:false},unique:[],filterable:[]}));
  const writer={...owner,capability:'records:write'};
  const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'empty',data:{}});
  const facts=async()=>(await pool.query(`SELECT
    (SELECT revision FROM records WHERE record_id=$2) AS revision,
    (SELECT count(*)::int FROM record_unique_keys WHERE space_id=$1) AS unique_keys,
    (SELECT count(*)::int FROM record_index_values WHERE space_id=$1) AS indexes,
    (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
    (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
    (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[spaceId,created.ref.id])).rows[0];
  const before=await facts();
  const request={operation:'patch',idempotencyKey:'ghost',id:created.ref.id,expectedRevision:1,set:{},unset:['ghost']};
  const original=Object.getOwnPropertyDescriptor(Object.prototype,'properties');
  try {
    for (const descriptor of [{value:{ghost:{type:'string'}},configurable:true},
      {get(){throw new Error('inherited getter executed');},configurable:true}]) {
      Object.defineProperty(Object.prototype,'properties',descriptor);
      for (const serialized of [false,true]) {
        const invoke=()=>serialized ? authority.mutateSerializedRequest(writer,JSON.stringify(request)) : authority.mutateRequest(writer,request);
        await assert.rejects(invoke(),{code:'INVALID_ARGUMENT'});
        assert.deepEqual(await facts(),before);
      }
    }
  } finally {
    if (original) Object.defineProperty(Object.prototype,'properties',original);
    else delete Object.prototype.properties;
  }
  const valid=await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'valid',id:created.ref.id,
    expectedRevision:1,set:{},unset:[]});
  assert.equal((await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'valid',id:created.ref.id,
    expectedRevision:1,set:{},unset:[]})).receiptId,valid.receiptId);
});

test('declared lifecycle transitions gate generic writes',async()=>{
  const suffix=randomUUID(); const spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const scope={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await assert.rejects(registry.define(scope,definition(collectionId,{lifecycle:{field:'state',initial:['open'],transitions:{open:['closed'],closed:[]}}})),{code:'SCHEMA_UNSUPPORTED'});
  await registry.define(scope,definition(collectionId,{schema:{...schema,required:['label','state']},
    lifecycle:{field:'state',initial:['open'],transitions:{open:['closed'],closed:[]}}}));
  const writer={...scope,capability:'records:write'};
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'missing-initial',data:{label:'x'}}),{code:'SCHEMA_INVALID'});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'wrong-initial',data:{label:'x',state:'closed'}}),{code:'SCHEMA_INVALID'});
  const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'initial',data:{label:'x',state:'open'}});
  await authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'advance',id:created.ref.id,expectedRevision:1,set:{state:'closed'},unset:[]});
  await assert.rejects(authority.mutateRequest(writer,{operation:'patch',idempotencyKey:'reverse',id:created.ref.id,expectedRevision:2,set:{state:'open'},unset:[]}),{code:'SCHEMA_INVALID'});
});

test('inherited lifecycle transitions cannot authorize undeclared replacement or patch',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const scope={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await registry.define(scope,definition(collectionId,{schema:{...schema,required:['label','state']},
    lifecycle:{field:'state',initial:['open'],transitions:{}}}));
  const writer={...scope,capability:'records:write'};
  const created=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'initial',data:{label:'x',state:'open'}});
  const previous=Object.getOwnPropertyDescriptor(Object.prototype,'open');
  try {
    Object.defineProperty(Object.prototype,'open',{value:['closed'],configurable:true});
    for (const request of [
      {operation:'replace',idempotencyKey:'replace',id:created.ref.id,expectedRevision:1,data:{label:'x',state:'closed'}},
      {operation:'patch',idempotencyKey:'patch',id:created.ref.id,expectedRevision:1,set:{state:'closed'},unset:[]}
    ]) await assert.rejects(authority.mutateRequest(writer,request),{code:'SCHEMA_INVALID'});
  } finally {
    if (previous) Object.defineProperty(Object.prototype,'open',previous);
    else delete Object.prototype.open;
  }
  const record=await authority.transaction(read(writer),tx=>tx.getRecord(created.ref.id));
  assert.equal(record.revision,1);
  assert.equal(JSON.parse(record.canonicalData).state,'open');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_events WHERE space_id=$1',[spaceId])).rows[0].n,1);
});

test('date-time validation and derived indexes use a pinned finite check',()=>{
  const withDate=definition('dated',{schema:{...schema,properties:{...schema.properties,instant:{type:'string',format:'date-time'}}},
    filterable:['instant']});
  const previous=Number.isFinite;
  try {
    Number.isFinite=()=>false;
    assert.doesNotThrow(()=>validateValue({label:'x',instant:'2024-01-02T03:04:05Z'},withDate.schema));
    assert.equal(derivedValues({label:'x',instant:'2024-01-02T03:04:05Z'},withDate).indexes[0].value,'2024-01-02T03:04:05Z');
  } finally { Number.isFinite=previous; }
});

test('date-time backfill and later writes survive numeric predicate replacement',async()=>{
  const suffix=randomUUID(),spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  const dated={...schema,properties:{...schema.properties,instant:{type:'string',format:'date-time'}}};
  await registry.define(owner,definition(collectionId,{schema:dated,filterable:[]}));
  const writer={...owner,capability:'records:write'};
  const first='2024-01-02T03:04:05Z';
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'before',data:{label:'before',instant:first}});
  await registry.revise(owner,1,definition(collectionId,{version:2,schema:dated,filterable:['instant']}));
  const previous=Number.isFinite;
  try {
    Number.isFinite=()=>false;
    assert.deepEqual(await registry.backfill(owner,'instant'),{processed:1,ready:true});
    await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'after',data:{label:'after',instant:first}});
  } finally { Number.isFinite=previous; }
  const rows=await pool.query(`SELECT time_value FROM record_index_values WHERE space_id=$1 AND collection_id=$2 AND field_name='instant' ORDER BY record_id`,
    [spaceId,collectionId]);
  assert.equal(rows.rowCount,2);
  assert.deepEqual(rows.rows.map(row=>row.time_value),[first,first]);
});

test('readOnly permits an authorized replay and denies a fresh malformed payload first',async()=>{
  const {owner,writer}=await fixture();
  const request={operation:'create',idempotencyKey:'one',data:{label:'one'}};
  const saved=await authority.mutateRequest(writer,request);
  await pool.query("UPDATE spaces SET lifecycle='readOnly' WHERE space_id=$1",[owner.spaceId]);
  assert.equal((await authority.mutateRequest(writer,request)).receiptId,saved.receiptId);
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'fresh',data:{label:undefined}}),{code:'SPACE_UNAVAILABLE'});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'one',data:{label:undefined}}),{code:'SCHEMA_INVALID'});
});

test('invalid patch set keeps schema errors after authorization, replay lookup and readOnly gating',async()=>{
  const {owner,writer}=await fixture();
  const saved=await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'base',data:{label:'base'}});
  const valid={operation:'patch',idempotencyKey:'replay',id:saved.ref.id,expectedRevision:1,set:{score:1},unset:[]};
  await authority.mutateRequest(writer,valid);
  const invalid={...valid,set:{label:undefined}};
  await assert.rejects(authority.mutateRequest({...writer,credentialId:'revoked'},invalid),{code:'FORBIDDEN'});
  await assert.rejects(authority.mutateRequest(writer,{...invalid,idempotencyKey:'fresh'}),{code:'SCHEMA_INVALID'});
  await assert.rejects(authority.mutateRequest(writer,invalid),{code:'SCHEMA_INVALID'});
  await pool.query("UPDATE spaces SET lifecycle='readOnly' WHERE space_id=$1",[owner.spaceId]);
  await assert.rejects(authority.mutateRequest(writer,{...invalid,idempotencyKey:'read-only-fresh'}),{code:'SPACE_UNAVAILABLE'});
  await assert.rejects(authority.mutateRequest(writer,invalid),{code:'SCHEMA_INVALID'});
});

test('a retained grant on another collection cannot disclose a revoked receipt',async()=>{
  const {owner,writer}=await fixture();
  const otherId=`other_${randomUUID()}`;
  await registry.define({...owner,collectionId:otherId},definition(otherId));
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['records:write'])`,[owner.spaceId,otherId,writer.credentialId]);
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'shared-key',data:{label:'first'}});
  await pool.query(`DELETE FROM collection_grants WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,
    [owner.spaceId,owner.collectionId,writer.credentialId]);
  await pool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[owner.spaceId]);
  await assert.rejects(authority.mutateRequest({...writer,collectionId:otherId,policyVersion:2},
    {operation:'create',idempotencyKey:'shared-key',data:{label:'second'}}),{code:'FORBIDDEN'});
});

test('serialized boundary supports schema and mutation without object input',async()=>{
  const suffix=randomUUID(); const spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const owner={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await registry.defineSerialized(owner,JSON.stringify(definition(collectionId)));
  const writer={...owner,capability:'records:write'};
  const bytes=JSON.stringify({operation:'create',idempotencyKey:'serialized',data:{label:'serialized'}});
  const saved=await authority.transaction(writer,tx=>tx.mutateSerializedRequest(bytes));
  assert.equal((await authority.mutateSerializedRequest(writer,bytes)).receiptId,saved.receiptId);
  const next=definition(collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
  assert.equal((await registry.reviseSerialized(owner,1,JSON.stringify(next))).version,2);
  await assert.rejects(authority.mutateSerializedRequest(writer,'{"operation":'),{code:'INVALID_ARGUMENT'});
});

test('object and serialized replay reject a changed payload without new facts',async()=>{
  const {owner,writer}=await fixture();
  for (const serialized of [false,true]) {
    const request={operation:'create',idempotencyKey:`replay-${serialized}`,data:{label:`original-${serialized}`}};
    const invoke=value=>serialized ? authority.mutateSerializedRequest(writer,JSON.stringify(value)) : authority.mutateRequest(writer,value);
    const receipt=await invoke(request);
    const before=(await pool.query(`SELECT
      (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
      (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
      (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
      (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[owner.spaceId])).rows[0];
    await assert.rejects(invoke({...request,data:{label:`changed-${serialized}`}}),{code:'IDEMPOTENCY_MISMATCH'});
    assert.equal((await invoke(request)).receiptId,receipt.receiptId);
    const after=(await pool.query(`SELECT
      (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
      (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
      (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts,
      (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`,[owner.spaceId])).rows[0];
    assert.deepEqual(after,before);
  }
});

test('current nonowner schema grant permits revision and backfill; expiry and stale policy deny both',async()=>{
  const {owner,writer}=await fixture();
  const grantee={...writer,capability:'schema:write'};
  const next=definition(owner.collectionId,{version:2,
    schema:{...schema,properties:{...schema.properties,note:{type:'string'}}},filterable:['score','note']});
  assert.equal((await registry.revise(grantee,1,next)).version,2);
  assert.deepEqual(await registry.backfill(grantee,'note'),{processed:0,ready:true});
  const third=definition(owner.collectionId,{version:3,
    schema:{...next.schema,properties:{...next.schema.properties,later:{type:'string'}}},filterable:['score','note','later']});
  await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second'
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[owner.spaceId,owner.collectionId,grantee.credentialId]);
  await assert.rejects(registry.revise(grantee,2,third),{code:'FORBIDDEN'});
  await assert.rejects(registry.backfill(grantee,'score'),{code:'FORBIDDEN'});
  await pool.query(`UPDATE collection_grants SET expires_at=NULL
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[owner.spaceId,owner.collectionId,grantee.credentialId]);
  await pool.query('UPDATE spaces SET policy_version=2 WHERE space_id=$1',[owner.spaceId]);
  await assert.rejects(registry.revise(grantee,2,third),{code:'FORBIDDEN'});
  await assert.rejects(registry.backfill(grantee,'score'),{code:'FORBIDDEN'});
  assert.equal((await registry.discover({...owner,policyVersion:2}))[0].definition.version,2);
  assert.deepEqual((await registry.discover({...owner,policyVersion:2}))[0].pending,['score']);
  assert.equal((await registry.revise({...grantee,policyVersion:2},2,third)).version,3);
  assert.deepEqual(await registry.backfill({...grantee,policyVersion:2},'score'),{processed:0,ready:true});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_commit_fences WHERE space_id=$1',[owner.spaceId])).rows[0].n,0);
});

test('schema revision and backfill serialize with the space-policy revocation fence',async()=>{
  for (const operation of ['revise','backfill']) {
    const {owner,writer}=await fixture();
    const grantee={...writer,capability:'schema:write'};
    let entered,release;
    const atFinalCheck=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    let authorizationCount=0;
    const held=new CollectionRegistry({connect:async()=>{
      const client=await pool.connect();
      return {query:async(sql,...args)=>{
        const result=await client.query(sql,...args);
        if (String(sql).includes('WHERE s.space_id=$1 FOR SHARE OF s') && ++authorizationCount===2) {
          entered(); await gate;
        }
        return result;
      },release:discard=>client.release(discard)};
    }});
    const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
    const schemaChange=operation==='revise' ? held.revise(grantee,1,next) : held.backfill(grantee,'score');
    const revoker=await pool.connect();
    try {
      await atFinalCheck;
      let revoked=false;
      let signalAttempt;
      const attempted=new Promise(resolve=>{signalAttempt=resolve;});
      const revoke=(async()=>{
        await revoker.query('BEGIN');
        // The supported key revocation path in spaces.ts takes this same lock before deleting grants.
        signalAttempt();
        await revoker.query('SELECT policy_version FROM spaces WHERE space_id=$1 FOR UPDATE',[owner.spaceId]);
        await revoker.query('DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2',[owner.spaceId,grantee.credentialId]);
        await revoker.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[owner.spaceId]);
        await revoker.query('COMMIT');
        revoked=true;
      })();
      void revoke.catch(()=>{});
      await attempted;
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(revoked,false);
      release();
      await schemaChange;
      await revoke;
      assert.equal(Number((await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[owner.spaceId])).rows[0].policy_version),2);
      await assert.rejects(registry.backfill({...grantee,policyVersion:2},'score'),{code:'FORBIDDEN'});
      if (operation==='revise') assert.equal((await registry.discover({...owner,policyVersion:2}))[0].definition.version,2);
      else assert.deepEqual((await registry.discover({...owner,policyVersion:2}))[0].ready,['score']);
    } finally { release(); await schemaChange.catch(()=>{}); revoker.release(); }
  }
});

test('schema revision and backfill roll back when grants expire while waiting for collection locks',async()=>{
  for (const operation of ['revise','backfill']) {
    const {owner,writer}=await fixture();
    const grantee={...writer,capability:'schema:write'};
    const blocker=await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM collections WHERE space_id=$1 AND collection_id=$2 FOR UPDATE',
      [owner.spaceId,owner.collectionId]);
    const {observed,attempted}=observedRegistry(sql=>sql.includes('FROM collections') &&
      sql.includes(operation==='revise' ? 'FOR UPDATE' : 'FOR SHARE'));
    const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
    const pending=operation==='revise' ? observed.revise(grantee,1,next) : observed.backfill(grantee,'score');
    void pending.catch(()=>{});
    try {
      await attempted;
      await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second'
        WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[owner.spaceId,owner.collectionId,grantee.credentialId]);
      await blocker.query('COMMIT');
      await assert.rejects(pending,{code:'FORBIDDEN'});
      const found=(await registry.discover(owner))[0];
      assert.equal(found.definition.version,1);
      assert.deepEqual(found.pending,['score']);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
    }
  }
});

test('schema revision and backfill reject natural grant expiry after their last application check',async()=>{
  for (const operation of ['revise','backfill','backfill-ready']) {
    const {owner,writer}=await fixture();
    const grantee={...writer,capability:'schema:write'};
    if (operation==='backfill-ready') await registry.backfill(owner,'score');
    let reachedCommit=false;
    const delayed=new CollectionRegistry({connect:async()=>{
      const client=await pool.connect();
      return {query:async(sql,...args)=>{
        if (sql==='COMMIT') {
          reachedCommit=true;
          // Begin the grant deadline only after the final application check,
          // then let the database clock cross it before COMMIT's deferred fence.
          const expiry=await client.query(`UPDATE collection_grants
            SET expires_at=clock_timestamp()+interval '200 milliseconds'
            WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3
            AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING expires_at`,
          [owner.spaceId,owner.collectionId,grantee.credentialId]);
          assert.equal(expiry.rowCount,1,'the grant must still be live after the final check');
          await client.query('SELECT pg_sleep(0.25)');
        }
        return client.query(sql,...args);
      },release:discard=>client.release(discard)};
    }});
    const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
    const effect=operation==='revise' ? delayed.revise(grantee,1,next) : delayed.backfill(grantee,'score');
    await assert.rejects(effect,{code:'FORBIDDEN'});
    assert.equal(reachedCommit,true,'the expiry must occur after the final application check');
    const found=(await registry.discover(owner))[0];
    assert.equal(found.definition.version,1);
    assert.deepEqual(found.pending,operation==='backfill-ready' ? [] : ['score']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_commit_fences WHERE space_id=$1',[owner.spaceId])).rows[0].n,0);
  }
});

test('waiting backfill cannot return ready after its schema grant expires',async()=>{
  const {owner,writer}=await fixture();
  const grantee={...writer,capability:'schema:write'};
  let held,release,attempted;
  const ownerLocked=new Promise(resolve=>held=resolve),gate=new Promise(resolve=>release=resolve);
  const granteeAttempted=new Promise(resolve=>attempted=resolve);
  const ownerRegistry=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      const result=await client.query(sql,...args);
      if (String(sql).includes('SELECT ready,backfill_after FROM collection_index_declarations')) {
        held(); await gate;
      }
      return result;
    },release:discard=>client.release(discard)};
  }});
  const granteeRegistry=new CollectionRegistry({connect:async()=>{
    const client=await pool.connect();
    return {query:(sql,...args)=>{
      if (String(sql).includes('SELECT ready,backfill_after FROM collection_index_declarations')) attempted();
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }});
  const winner=ownerRegistry.backfill(owner,'score');
  try {
    await ownerLocked;
    const waiting=granteeRegistry.backfill(grantee,'score');
    void waiting.catch(()=>{});
    await granteeAttempted;
    await pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second'
      WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[owner.spaceId,owner.collectionId,grantee.credentialId]);
    release();
    assert.deepEqual(await winner,{processed:0,ready:true});
    await assert.rejects(waiting,{code:'FORBIDDEN'});
    assert.deepEqual(await registry.backfill(owner,'score'),{processed:0,ready:true});
  } finally { release(); }
});

test('ordinary malformed envelopes are rejected after collection authorization without invoking accessors',async()=>{
  const {owner,writer}=await fixture();
  const denied={...writer,credentialId:'revoked'};
  const base={operation:'create',idempotencyKey:'malformed',data:{label:'malformed'}};
  let invoked=0;
  const variants=[
    Object.defineProperty({...base},'hidden',{value:true,enumerable:false}),
    Object.defineProperty({...base},'extra',{enumerable:true,get(){ invoked++; throw new Error('getter ran'); }}),
    Object.defineProperty({...base},Symbol('extra'),{value:true,enumerable:true}),
    Object.assign(Object.create({inherited:true}),base)
  ];
  for (const request of variants) {
    await assert.rejects(authority.mutateRequest(denied,request),{code:'FORBIDDEN'});
    await assert.rejects(authority.mutateRequest(writer,request),{code:'INVALID_ARGUMENT'});
  }
  assert.equal(invoked,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM records WHERE space_id=$1',[owner.spaceId])).rows[0].n,0);
});

test('request retry keeps the original authenticated scope for object and serialized boundaries',async()=>{
  const {owner,writer}=await fixture();
  for (const serialized of [false,true]) {
    let attempts=0;
    const retryScope={...writer};
    const retryAuthority=new PostgresAuthority({connect:async()=>{
      attempts++;
      if (attempts===1) {
        retryScope.spaceId='sp_replaced';
        retryScope.collectionId='collection_replaced';
        retryScope.principalId='principal_replaced';
        retryScope.credentialId='credential_replaced';
        retryScope.capability='records:read';
        retryScope.policyVersion=2;
        retryScope.placementGeneration=2;
        throw Object.assign(new Error('serialization rollback'),{code:'40001'});
      }
      return pool.connect();
    }},3600);
    const request={operation:'create',idempotencyKey:`scope-${serialized}`,data:{label:`scope-${serialized}`}};
    const receipt=serialized ?
      await retryAuthority.mutateSerializedRequest(retryScope,JSON.stringify(request)) :
      await retryAuthority.mutateRequest(retryScope,request);
    assert.equal(attempts,2);
    assert.equal(receipt.spaceId,owner.spaceId);
    assert.equal((await authority.transaction(read(writer),tx=>tx.getRecord(receipt.ref.id))).canonicalData,
      JSON.stringify(request.data));
  }
});

test('prototype tampering cannot grant schema rights, expose suspended discovery or admit invalid read arguments',async()=>{
  const {owner,writer}=await fixture();
  const readOnlyGrant={...writer,capability:'schema:write'};
  await pool.query(`UPDATE collection_grants SET capabilities=ARRAY['records:read']
    WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3`,[owner.spaceId,owner.collectionId,writer.credentialId]);
  const original=Array.prototype.includes;
  let suspendedGate=true;
  try {
    Array.prototype.includes=function(value){
      if (value==='schema:write' || value==='generated' || value==='number') return true;
      if (value==='suspended') return suspendedGate;
      return Reflect.apply(original,this,[value]);
    };
    await assert.rejects(registry.revise(readOnlyGrant,1,definition(owner.collectionId,{version:2})),{code:'FORBIDDEN'});
    await assert.rejects(authority.transaction({...writer,capability:'records:write'},tx=>tx.mutateSerializedRequest(
      JSON.stringify({operation:'create',idempotencyKey:'ungranted',data:{label:'ungranted'}}))),{code:'FORBIDDEN'});
    await assert.rejects(authority.transaction(read(writer),tx=>tx.getByKey('invalid','key')),{code:'INVALID_ARGUMENT'});
    await assert.rejects(authority.transaction(read(writer),tx=>tx.countRecords([{field:'score',kind:'invalid',operator:'eq',value:1}])),{code:'INVALID_ARGUMENT'});
    await pool.query("UPDATE spaces SET lifecycle='suspended' WHERE space_id=$1",[owner.spaceId]);
    await assert.rejects(registry.discover(owner),{code:'SPACE_UNAVAILABLE'});
    suspendedGate=false;
    await assert.rejects(authority.transaction(read(writer),tx=>tx.getRecord('missing')),{code:'SPACE_UNAVAILABLE'});
  } finally { Array.prototype.includes=original; }
});

test('predicate snapshots reject decorated objects before index readiness and preserve ready queries',async()=>{
  const {owner,writer}=await fixture();
  const reader=read(writer);
  const predicate={field:'score',kind:'number',operator:'eq',value:2};
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords([predicate])),{code:'SCHEMA_CONFLICT'});
  let invoked=0;
  const decorated=Object.defineProperty({...predicate},'extra',{enumerable:true,get(){ invoked++; throw new Error('getter ran'); }});
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords([decorated])),{code:'INVALID_ARGUMENT'});
  assert.equal(invoked,0);
  await registry.backfill(owner,'score');
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'indexed',data:{label:'indexed',score:2}});
  assert.equal(await authority.transaction(reader,tx=>tx.countRecords([predicate])),1);
  assert.equal(await authority.transaction(reader,tx=>tx.existsRecord([predicate])),true);
  assert.equal((await authority.transaction(reader,tx=>tx.queryRecords([predicate],10))).length,1);
});

test('a runtime without trap-free proxy detection fails closed for in-process predicates',()=>{
  const script=`import {types} from 'node:util';
    types.isProxy=undefined;
    const {AuthorityTransaction}=await import('./packages/postgres/dist/index.js');
    const tx=new AuthorityTransaction({query(){throw Error('query reached')}},
      {spaceId:'space',collectionId:'collection',principalId:'principal',credentialId:'credential',
       capability:'records:read',policyVersion:1,placementGeneration:1},3600);
    const predicate=[{field:'score',kind:'number',operator:'eq',value:2}];
    for (const run of [()=>tx.queryRecords(predicate,10),()=>tx.countRecords(predicate),()=>tx.existsRecord(predicate)]) {
      try { await run(); throw Error('accepted untrusted predicate'); }
      catch (error) { if (error.code!=='INVALID_ARGUMENT') throw error; }
    }
    process.stdout.write('closed');`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}),'closed');
});

test('public schema helpers reject proxies without detection while serialized writes remain usable',async()=>{
  const {owner,writer}=await fixture();
  const next=definition(owner.collectionId,{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string'}}}});
  const script=`import assert from 'node:assert/strict';
    import {types} from 'node:util';
    import pg from 'pg';
    types.isProxy=undefined;
    const {PostgresAuthority,CollectionRegistry,validateDefinition,validateValue,derivedValues,compatible}=await import('./packages/postgres/dist/index.js');
    const {url,owner,writer,next}=JSON.parse(process.env.STA7_TEST_CONTEXT);
    let traps=0;
    const proxy=new Proxy({label:'fabricated'}, {
      get(target,key,receiver){traps++;return Reflect.get(target,key,receiver)},
      getPrototypeOf(target){traps++;return Reflect.getPrototypeOf(target)},
      ownKeys(target){traps++;return Reflect.ownKeys(target)},
      getOwnPropertyDescriptor(target,key){traps++;return Reflect.getOwnPropertyDescriptor(target,key)}
    });
    assert.throws(()=>validateValue(proxy,next.schema),{code:'SCHEMA_INVALID'});
    assert.throws(()=>derivedValues(proxy,next),{code:'SCHEMA_INVALID'});
    assert.throws(()=>compatible(proxy,next),{code:'SCHEMA_UNSUPPORTED'});
    assert.throws(()=>validateDefinition(proxy,true),{code:'SCHEMA_UNSUPPORTED'});
    assert.equal(traps,0);
    const pool=new pg.Pool({connectionString:url});
    try {
      const registry=new CollectionRegistry(pool), authority=new PostgresAuthority(pool,3600);
      assert.equal((await registry.reviseSerialized(owner,1,JSON.stringify(next))).version,2);
      const receipt=await authority.mutateSerializedRequest(writer,JSON.stringify({operation:'create',idempotencyKey:'no-detector',data:{label:'parsed'}}));
      assert.equal(receipt.revision,1);
    } finally { await pool.end(); }
    process.stdout.write('closed');`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{
    cwd:fileURLToPath(new URL('../..',import.meta.url)),encoding:'utf8',
    env:{...process.env,STA7_TEST_CONTEXT:JSON.stringify({url,owner,writer,next})}
  }),'closed');
});

test('signed pages bind scope, query and schema; mutable sorts expose live traversal',async()=>{
  const {owner,writer}=await fixture();
  const key=randomBytes(32);
  const paged=new PostgresAuthority(pool,3600,key);
  await assert.rejects(paged.transaction(read(writer),tx=>tx.queryPage([],1,{field:'score',direction:'asc'})),{code:'SCHEMA_CONFLICT'});
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,sortable:['score']}));
  await registry.backfill(owner,'score');
  const created=[];
  for (const [i,score] of [1,2,3].entries())
    created.push(await authority.mutateRequest(writer,{operation:'create',idempotencyKey:`page-${i}`,data:{label:`page-${i}`,score}}));
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'page-missing',data:{label:'page-missing'}});
  const reader=read(writer),sort={field:'score',direction:'asc'};
  for (const malformed of [
    Object.defineProperty({direction:'asc'},'field',{value:'score',enumerable:false}),
    Object.defineProperty({field:'score'},'direction',{value:'asc',enumerable:false})
  ]) await assert.rejects(paged.transaction(reader,tx=>tx.queryPage([],1,malformed)),{code:'INVALID_ARGUMENT'});
  const positive=[{field:'score',kind:'number',operator:'gte',value:0}];
  const descending=await paged.transaction(reader,tx=>tx.queryPage(positive,3,{field:'score',direction:'desc'}));
  assert.deepEqual(descending.records.map(row=>JSON.parse(row.canonicalData).score),[3,2,1]);
  const first=await paged.transaction(reader,tx=>tx.queryPage(positive,1,sort));
  assert.equal(first.records.length,1);
  assert.equal(JSON.parse(first.records[0].canonicalData).score,1);
  assert.ok(first.nextCursor);
  await assert.rejects(paged.transaction(read(owner),tx=>tx.queryPage(positive,1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,'other-agent',ARRAY['records:read'])`,[owner.spaceId,owner.collectionId]);
  await assert.rejects(paged.transaction({...reader,credentialId:'other-agent'},tx=>
    tx.queryPage(positive,1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  await assert.rejects(paged.transaction({...reader,spaceId:'another-space'},tx=>tx.queryPage(positive,1,sort,first.nextCursor)),{code:'NOT_FOUND'});
  const other=await fixture();
  await registry.revise(other.owner,1,definition(other.owner.collectionId,{version:2,sortable:['score']}));
  await registry.backfill(other.owner,'score');
  await assert.rejects(paged.transaction(read(other.writer),tx=>tx.queryPage(positive,1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  await assert.rejects(paged.transaction(reader,tx=>tx.queryPage([{field:'score',kind:'number',operator:'gt',value:0}],1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  await assert.rejects(paged.transaction(reader,tx=>tx.queryPage(positive,1,sort,`${first.nextCursor[0]==='A' ? 'B' : 'A'}${first.nextCursor.slice(1)}`)),{code:'CURSOR_INVALID'});
  await authority.mutateRequest(writer,{operation:'replace',idempotencyKey:'move-before',id:created[1].ref.id,
    expectedRevision:1,data:{label:'page-1',score:0}});
  const second=await paged.transaction(reader,tx=>tx.queryPage(positive,1,sort,first.nextCursor));
  assert.equal(JSON.parse(second.records[0].canonicalData).score,3);
  assert.equal(second.nextCursor,null);
  assert.equal(await paged.transaction(reader,tx=>tx.countRecords([])),4);
  assert.equal(await paged.transaction(reader,tx=>tx.existsRecord([{field:'score',kind:'number',operator:'eq',value:0}])),true);
  await registry.revise(owner,2,definition(owner.collectionId,{version:3,sortable:['score']}));
  await assert.rejects(paged.transaction(reader,tx=>tx.queryPage(positive,1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  await pool.query('UPDATE spaces SET policy_version=2 WHERE space_id=$1',[owner.spaceId]);
  const afterPolicy={...reader,policyVersion:2};
  await assert.rejects(paged.transaction(afterPolicy,tx=>tx.queryPage(positive,1,sort,first.nextCursor)),{code:'CURSOR_INVALID'});
  const fresh=await paged.transaction(afterPolicy,tx=>tx.queryPage(positive,1,sort));
  assert.ok(fresh.nextCursor);
  await pool.query('UPDATE spaces SET placement_generation=2 WHERE space_id=$1',[owner.spaceId]);
  await assert.rejects(paged.transaction({...afterPolicy,placementGeneration:2},tx=>
    tx.queryPage(positive,1,sort,fresh.nextCursor)),{code:'CURSOR_INVALID'});
});

test('explicit sort pages preserve missing, null and value ranks in both directions',async()=>{
  const {owner,writer}=await fixture();
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,sortable:['score']}));
  await registry.backfill(owner,'score');
  const values=[undefined,null,2,1,null,undefined,1];
  const ids=[];
  for (let i=0;i<values.length;i++) ids.push((await authority.mutateRequest(writer,{operation:'create',
    idempotencyKey:`rank-${i}`,data:{label:`rank-${i}`,...(values[i]===undefined ? {} : {score:values[i]})}})).ref.id);
  const paged=new PostgresAuthority(pool,3600,randomBytes(32)),reader=read(writer);
  for (const direction of ['asc','desc']) {
    const seen=[];
    let cursor;
    do {
      const page=await paged.transaction(reader,tx=>tx.queryPage([],1,{field:'score',direction},cursor));
      assert.equal(page.records.length,1);
      seen.push(JSON.parse(page.records[0].canonicalData).label);
      cursor=page.nextCursor;
    } while(cursor);
    const expected=direction==='asc'
      ? [['rank-0','rank-5'],['rank-1','rank-4'],['rank-3','rank-6'],['rank-2']]
      : [['rank-2'],['rank-3','rank-6'],['rank-1','rank-4'],['rank-0','rank-5']];
    assert.deepEqual(seen.map(label=>expected.findIndex(group=>group.includes(label))),
      expected.flatMap((group,rank)=>group.map(()=>rank)));
    for (const group of expected) {
      assert.deepEqual(seen.filter(label=>group.includes(label)),[...group].sort((a,b)=>
        ids[Number(a.slice(5))].localeCompare(ids[Number(b.slice(5))])));
    }
  }
});

test('low-level mutations fill declared sort rows and a cutover writer cannot commit a gap',async()=>{
  const {owner,writer}=await fixture();
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,sortable:['score']}));
  await registry.backfill(owner,'score');
  const low={operation:'create',idempotencyKey:'low-index-create',requestDigest:'a'.repeat(64),
    canonicalData:'{"label":"low","score":7}',unique:[],indexes:[]};
  const created=await authority.mutate(writer,low);
  assert.equal((await authority.mutate(writer,low)).receiptId,created.receiptId);
  await assert.rejects(authority.mutate(writer,{...low,idempotencyKey:'wrong-index',requestDigest:'c'.repeat(64),
    indexes:[{field:'score',kind:'number',value:8}]}),{code:'SCHEMA_CONFLICT'});
  const replaced=await authority.mutate(writer,{operation:'replace',idempotencyKey:'low-index-replace',
    requestDigest:'b'.repeat(64),recordId:created.ref.id,expectedRevision:1,
    canonicalData:'{"label":"low"}',unique:[],indexes:[]});
  assert.equal(replaced.revision,2);
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'typed-neighbor',data:{label:'neighbor',score:2}});
  const reader=read(writer);
  const paged=new PostgresAuthority(pool,3600,randomBytes(32));
  const count=await authority.transaction(reader,tx=>tx.countRecords([]));
  assert.equal(count,2);
  for (const direction of ['asc','desc']) {
    const seen=[];
    let cursor;
    do {
      const page=await paged.transaction(reader,tx=>tx.queryPage([],1,{field:'score',direction},cursor));
      seen.push(...page.records.map(record=>record.ref.id));
      cursor=page.nextCursor;
    } while (cursor);
    assert.equal(seen.length,count);
    assert.equal(new Set(seen).size,count);
    assert.ok(seen.includes(created.ref.id));
  }
  const stored=await pool.query(`SELECT value_kind FROM record_index_values
    WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND field_name='score'`,
  [owner.spaceId,owner.collectionId,created.ref.id]);
  assert.deepEqual(stored.rows.map(row=>row.value_kind),['missing']);
  const old=await pool.connect();
  try {
    await old.query('BEGIN');
    await old.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      VALUES($1,$2,'old-writer',1,2,'generated','old-writer','{"label":"old","score":9}','{"label":"old","score":9}'::jsonb)`,
    [owner.spaceId,owner.collectionId]);
    await assert.rejects(old.query('COMMIT'),{code:'PZ003'});
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM records
      WHERE space_id=$1 AND collection_id=$2 AND record_id='old-writer'`,[owner.spaceId,owner.collectionId])).rows[0].n,0);
    await old.query('BEGIN');
    await old.query(`UPDATE records SET revision=revision+1,canonical_data='{"label":"low","score":10}',
      data='{"label":"low","score":10}'::jsonb WHERE space_id=$1 AND collection_id=$2 AND record_id=$3`,
    [owner.spaceId,owner.collectionId,created.ref.id]);
    await old.query(`DELETE FROM record_index_values WHERE space_id=$1 AND collection_id=$2 AND record_id=$3`,
    [owner.spaceId,owner.collectionId,created.ref.id]);
    await assert.rejects(old.query('COMMIT'),{code:'PZ003'});
    assert.equal((await authority.transaction(reader,tx=>tx.getRecord(created.ref.id))).revision,2);
    assert.equal(await authority.transaction(reader,tx=>tx.countRecords([])),count);
  } finally { old.release(); }
});

test('031 restarts a pre-upgrade partial backfill before publishing sorted pages',async()=>{
  const database=`stateplane_sta8_upgrade_${randomUUID().replaceAll('-','')}`;
  const location=new URL(baseUrl);
  location.pathname=`/${database}`;
  const admin=new pg.Client({connectionString:baseUrl});
  await admin.connect();
  let upgraded;
  let upgradePool;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    upgraded=new pg.Client({connectionString:location.href});
    await upgraded.connect();
    const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort();
    for (const file of files.filter(name=>name<'031_'))
      await upgraded.query(await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8'));
    const scope={spaceId:'sp_partial_upgrade',collectionId:'entries',principalId:'owner',credentialId:'owner-session',
      capability:'schema:write',policyVersion:1,placementGeneration:1};
    const accepted=definition('entries',{unique:[],sortable:['score','label']});
    await upgraded.query('BEGIN');
    await upgraded.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`,[scope.spaceId]);
    await upgraded.query(`INSERT INTO collections(space_id,collection_id) VALUES($1,$2)`,[scope.spaceId,scope.collectionId]);
    await upgraded.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES($1,$2,1,$3)`,[scope.spaceId,scope.collectionId,JSON.stringify(accepted)]);
    await upgraded.query(`INSERT INTO collection_index_declarations
      (space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version,backfill_after)
      VALUES($1,$2,'score','number',TRUE,TRUE,FALSE,1,'rec_100')`,[scope.spaceId,scope.collectionId]);
    await upgraded.query(`INSERT INTO collection_index_declarations
      (space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
      VALUES($1,$2,'label','string',FALSE,TRUE,TRUE,1)`,[scope.spaceId,scope.collectionId]);
    await upgraded.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      SELECT $1,$2,'rec_'||lpad(g::text,3,'0'),1,1,'generated','rec_'||lpad(g::text,3,'0'),payload::text,payload
      FROM generate_series(1,101) g CROSS JOIN LATERAL
        (SELECT CASE WHEN g%2=0 THEN jsonb_build_object('label','row-'||g,'score',g)
          ELSE jsonb_build_object('label','row-'||g) END AS payload) p`,[scope.spaceId,scope.collectionId]);
    await upgraded.query(`INSERT INTO record_index_values
      (space_id,collection_id,record_id,field_name,value_kind,number_value)
      SELECT $1,$2,'rec_'||lpad(g::text,3,'0'),'score','number',g
      FROM generate_series(1,100) g WHERE g%2=0`,[scope.spaceId,scope.collectionId]);
    await upgraded.query('COMMIT');
    const oldWriter=new pg.Client({connectionString:location.href});
    await oldWriter.connect();
    let migrating;
    try {
      await oldWriter.query('BEGIN');
      await oldWriter.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,$2,'rec_102',1,1,'generated','rec_102','{"label":"late"}','{"label":"late"}'::jsonb)`,
      [scope.spaceId,scope.collectionId]);
      let settled=false;
      const migratingPid=(await upgraded.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const oldWriterPid=(await oldWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      migrating=upgraded.query(await readFile(new URL('../../migrations/031_index_missing_projection.sql',import.meta.url),'utf8'))
        .finally(()=>{ settled=true; });
      let observed=false;
      for (let attempt=0;attempt<100;attempt++) {
        const blockers=(await admin.query('SELECT pg_blocking_pids($1) AS pids',[migratingPid])).rows[0].pids;
        if (blockers.includes(oldWriterPid)) { observed=true; break; }
        if (settled) break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(observed,true,'PostgreSQL reports the old writer blocking migration cutover');
      await oldWriter.query('COMMIT');
    } finally {
      await oldWriter.query('ROLLBACK').catch(()=>{});
      await oldWriter.end();
    }
    await migrating;
    assert.deepEqual((await upgraded.query(`SELECT ready,backfill_after FROM collection_index_declarations
      WHERE space_id=$1 AND collection_id=$2 AND field_name='score'`,[scope.spaceId,scope.collectionId])).rows[0],
    {ready:false,backfill_after:null});
    assert.equal((await upgraded.query(`SELECT ready FROM collection_index_declarations
      WHERE space_id=$1 AND collection_id=$2 AND field_name='label'`,[scope.spaceId,scope.collectionId])).rows[0].ready,false);
    upgradePool=new pg.Pool({connectionString:location.href,max:4});
    const upgrading=new CollectionRegistry(upgradePool);
    assert.deepEqual(await upgrading.backfill(scope,'score'),{processed:100,ready:false});
    assert.deepEqual(await upgrading.backfill(scope,'score'),{processed:2,ready:true});
    assert.deepEqual(await upgrading.backfill(scope,'label'),{processed:100,ready:false});
    assert.deepEqual(await upgrading.backfill(scope,'label'),{processed:2,ready:true});
    const reader={...scope,capability:'records:read'};
    const querying=new PostgresAuthority(upgradePool,3600,randomBytes(32));
    assert.equal(await querying.transaction(reader,tx=>tx.countRecords([])),102);
    for (const direction of ['asc','desc']) {
      for (const field of ['score','label']) {
        const seen=new Set();
        let cursor;
        do {
          const page=await querying.transaction(reader,tx=>tx.queryPage([],25,{field,direction},cursor));
          for (const row of page.records) seen.add(row.ref.id);
          cursor=page.nextCursor;
        } while (cursor);
        assert.equal(seen.size,102);
      }
    }
    assert.equal((await upgraded.query(`SELECT count(*)::int AS n FROM record_index_values
      WHERE space_id=$1 AND collection_id=$2 AND field_name='score'`,[scope.spaceId,scope.collectionId])).rows[0].n,102);
  } finally {
    await upgradePool?.end();
    await upgraded?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
});

test('populated 031 upgrade requires a drained gate before its projection sweep',async()=>{
  const database=`stateplane_sta8_drain_${randomUUID().replaceAll('-','')}`;
  const location=new URL(baseUrl); location.pathname=`/${database}`;
  const admin=new pg.Client({connectionString:baseUrl});
  await admin.connect();
  let upgrade;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    upgrade=new pg.Client({connectionString:location.href});
    await upgrade.connect();
    await upgrade.query(`CREATE TABLE stateplane_migrations(name text PRIMARY KEY,sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort();
    for (const file of files.filter(name=>name<'031_')) {
      const sql=await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8');
      await upgrade.query(sql);
      await upgrade.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)',
        [file,createHash('sha256').update(sql).digest('hex')]);
    }
    await upgrade.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES('sta8-drain','owner','cell-a','cell-a','target-a')`);
    await upgrade.query('BEGIN');
    await upgrade.query("INSERT INTO collections(space_id,collection_id) VALUES('sta8-drain','entries')");
    await upgrade.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      VALUES('sta8-drain','entries',1,$1)`,[JSON.stringify(definition('entries',{unique:[],sortable:['score']}))]);
    await upgrade.query('COMMIT');
    await upgrade.query(`INSERT INTO collection_index_declarations
      (space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
      VALUES('sta8-drain','entries','score','number',TRUE,TRUE,FALSE,1)`);
    await upgrade.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,
      key_mode,normalized_key,canonical_data,data)
      SELECT 'sta8-drain','entries','rec-'||g,1,1,'generated','rec-'||g,payload::text,payload
      FROM generate_series(1,2000) g CROSS JOIN LATERAL
        (SELECT jsonb_build_object('label','row-'||g,'score',g) AS payload) p`);
    await upgrade.query(`INSERT INTO batch_operations(space_id,collection_id,credential_id,operation_key,manifest_digest,item_count)
      VALUES('sta8-drain','entries','agent','legacy-attempt','digest',1)`);
    await upgrade.query(`INSERT INTO batch_items(space_id,collection_id,credential_id,operation_key,ordinal,request_text,attempts)
      VALUES('sta8-drain','entries','agent','legacy-attempt',0,'{}',-1)`);
    const env={...process.env,DATABASE_URL:location.href};
    const cwd=fileURLToPath(new URL('../..',import.meta.url));
    let failure;
    try { execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd,env,encoding:'utf8'}); }
    catch(error) { failure=error; }
    assert.match(String(failure?.stderr),/Populated projection upgrade requires drained traffic/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name LIKE '031_%'"))
      .rows[0].n,0,'refused migration leaves no partial ledger entry');
    const activeWriter=new pg.Client({connectionString:location.href});
    await activeWriter.connect();
    try {
      await activeWriter.query('BEGIN');
      await activeWriter.query("UPDATE records SET data=data WHERE space_id='sta8-drain' AND record_id='rec-1'");
      let contention;
      try { execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd,
        env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'},encoding:'utf8'}); }
      catch(error) { contention=error; }
      assert.match(String(contention?.stderr),/Projection upgrade requires drained traffic/);
      assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name LIKE '031_%'"))
        .rows[0].n,0,'contention refusal leaves no partial projection migration');
    } finally {
      await activeWriter.query('ROLLBACK').catch(()=>{});
      await activeWriter.end();
    }
    const blocker=new pg.Client({connectionString:location.href});
    await blocker.connect();
    const migrate=promisify(execFile);
    let migrating;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM collection_index_declarations
        WHERE space_id='sta8-drain' AND collection_id='entries' AND field_name='score' FOR NO KEY UPDATE`);
      const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      migrating=migrate(process.execPath,['scripts/migrate.mjs'],{cwd,
        env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'},encoding:'utf8'});
      migrating.catch(()=>{});
      let observed=false;
      for (let attempt=0;attempt<100;attempt++) {
        const activity=(await upgrade.query(`SELECT pid,wait_event_type,query FROM pg_stat_activity
          WHERE datname=$1 AND query LIKE 'SELECT count(*)::bigint FROM (%'`,[database])).rows[0];
        if (activity?.wait_event_type==='Lock' &&
          (await upgrade.query('SELECT pg_blocking_pids($1) AS pids',[activity.pid])).rows[0].pids.includes(blockerPid))
        { observed=true; break; }
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(observed,true,'PostgreSQL reports the migrator waiting for the backfill declaration lock');
      await blocker.query(`INSERT INTO record_index_values
        (space_id,collection_id,record_id,field_name,value_kind,number_value)
        VALUES('sta8-drain','entries','rec-1','score','number',1)`);
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(()=>{});
      await blocker.end();
    }
    const started=performance.now();
    await assert.rejects(migrating,'legacy negative attempts are found during the separate validation stage');
    assert.deepEqual((await upgrade.query(`SELECT name FROM stateplane_migrations WHERE name LIKE '03%'
      ORDER BY name`)).rows.map(row=>row.name),
    ['030_batch_ingestion.sql','031_index_missing_projection.sql','032_batch_slot_hardening.sql'],
    'the staged constraint and prior migrations remain committed for a safe retry');
    await assert.rejects(upgrade.query(`UPDATE batch_items SET attempts=-2 WHERE operation_key='legacy-attempt'`),
      {code:'23514'},'new writes obey the staged CHECK before validation');
    await upgrade.query(`UPDATE batch_items SET attempts=0 WHERE operation_key='legacy-attempt'`);
    execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd,
      env:{...env,STATEPLANE_POPULATED_INDEX_UPGRADE:'drained'},encoding:'utf8'});
    const elapsed=performance.now()-started;
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM stateplane_migrations WHERE name LIKE '031_%'"))
      .rows[0].n,1);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM records WHERE space_id='sta8-drain'"))
      .rows[0].n,2000);
    const attemptsGuard=(await upgrade.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='public.batch_items'::regclass AND conname='batch_items_attempts_nonnegative'`)).rows[0];
    assert.equal(attemptsGuard?.convalidated,true,'staged batch guard validates in the later migration transaction');
    assert.ok(elapsed<5000,`local 2000-row drained upgrade plus batch validation retry took ${elapsed.toFixed(0)}ms`);
  } finally {
    await upgrade?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
});

test('string, boolean and full-precision instant sorts page through null and missing ranks',async()=>{
  const {owner,writer}=await fixture();
  const expanded={...schema,properties:{...schema.properties,s:{type:['string','null']},
    b:{type:['boolean','null']},t:{type:['string','null'],format:'date-time'}}};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:expanded,sortable:['s','b','t']}));
  for (const field of ['s','b','t']) await registry.backfill(owner,field);
  const cases=[
    {label:'missing'},
    {label:'null',s:null,b:null,t:null},
    {label:'high',s:'é',b:true,t:'2026-01-01T00:00:00.1Z'},
    {label:'low',s:'a',b:false,t:'2026-01-01T00:00:00.01Z'}
  ];
  for (const data of cases) await authority.mutateRequest(writer,{operation:'create',idempotencyKey:`typed-sort-${data.label}`,data});
  const paged=new PostgresAuthority(pool,3600,randomBytes(32));
  for (const field of ['s','b','t']) for (const direction of ['asc','desc']) {
    let cursor,labels=[];
    do {
      const page=await paged.transaction(read(writer),tx=>tx.queryPage([],1,{field,direction},cursor));
      labels.push(JSON.parse(page.records[0].canonicalData).label);
      cursor=page.nextCursor;
    } while(cursor);
    assert.deepEqual(labels,direction==='asc' ? ['missing','null','low','high'] : ['high','low','null','missing']);
  }
});

test('cursor rejects noncanonical base64url and expiry without losing authorization order',async()=>{
  const {writer}=await fixture();
  const paged=new PostgresAuthority(pool,3600,randomBytes(32));
  for(let i=0;i<3;i++) await authority.mutateRequest(writer,{operation:'create',idempotencyKey:`cursor-${i}`,data:{label:`cursor-${i}`}});
  const reader=read(writer),first=await paged.transaction(reader,tx=>tx.queryPage([],1));
  const token=first.nextCursor;
  assert.ok(token);
  const alias=`${token}=`;
  assert.ok(Buffer.from(token,'base64url').equals(Buffer.from(alias,'base64url')));
  await assert.rejects(paged.transaction(reader,tx=>tx.queryPage([],1,undefined,alias)),{code:'CURSOR_INVALID'});
  const now=Date.now;
  try {
    Date.now=()=>now()+16*60_000;
    await assert.rejects(paged.transaction(reader,tx=>tx.queryPage([],1,undefined,token)),{code:'CURSOR_INVALID'});
  } finally { Date.now=now; }
});

test('typed IN uses authoritative indexes and rejects malformed or oversized lists',async()=>{
  const {owner,writer}=await fixture();
  const expanded={...schema,properties:{...schema.properties,active:{type:'boolean'},at:{type:'string',format:'date-time'}}};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:expanded,filterable:['score','label','active','at']}));
  for (const field of ['score','label','active','at']) await registry.backfill(owner,field);
  for (const [i,score,active,at] of [[0,1,true,'2026-01-01T00:00:00Z'],[1,2,false,'2026-01-02T00:00:00Z'],
    [2,3,true,'2026-01-03T00:00:00Z']].values()) await authority.mutateRequest(writer,{operation:'create',
      idempotencyKey:`in-${i}`,data:{label:`in-${i}`,score,active,at}});
  const reader=read(writer);
  for (const [field,kind,values] of [['score','number',[1,3]],['label','string',['in-0','in-2']],
    ['active','boolean',[true]],['at','date-time',['2026-01-01T00:00:00.000Z','2026-01-03T00:00:00Z']]]) {
    const predicate=[{field,kind,operator:'in',value:values}];
    assert.equal(await authority.transaction(reader,tx=>tx.countRecords(predicate)),2);
    assert.equal(await authority.transaction(reader,tx=>tx.existsRecord(predicate)),true);
  }
  for (const value of [[],Array(17).fill(1),[1,'2'],[NaN]])
    await assert.rejects(authority.transaction(reader,tx=>tx.countRecords([{field:'score',kind:'number',operator:'in',value}])),{code:'INVALID_ARGUMENT'});
});

test('durable batch checkpoint resumes partial success, rejects changed retries and permits failed-item retry',async()=>{
  const {owner,writer}=await fixture();
  const requests=[
    JSON.stringify({operation:'create',data:{label:'bulk-a',score:1}}),
    JSON.stringify({operation:'create',data:{label:'bulk-b',extra:'later'}}),
    JSON.stringify({operation:'create',data:{label:'bulk-c',score:3}})
  ];
  const key='bulk-operation';
  const digest=createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  await authority.transaction(writer,tx=>tx.startBatch(key,digest,requests));
  await authority.transaction(writer,tx=>tx.processBatchItem(key,0,false));
  let progress=await authority.batchProgress(writer,key);
  assert.deepEqual(progress.items.map(item=>item.state),['succeeded','pending','pending']);
  const firstReceipt=progress.items[0].receipt;
  assert.ok(firstReceipt?.committedAt);
  progress=await authority.ingestBatch(writer,key,requests);
  assert.deepEqual(progress.items.map(item=>item.state),['succeeded','failed','succeeded']);
  assert.equal(progress.items[1].failureCode,'SCHEMA_INVALID');
  assert.equal(progress.items[0].receipt.receiptId,firstReceipt.receiptId);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),2);
  await assert.rejects(authority.ingestBatch(writer,key,[requests[0],requests[1],requests[2]+' ']),{code:'BATCH_CONFLICT'});
  const expanded={...schema,properties:{...schema.properties,extra:{type:'string'}}};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:expanded}));
  progress=await authority.ingestBatch(writer,key,requests,true);
  assert.deepEqual(progress.items.map(item=>item.state),['succeeded','succeeded','succeeded']);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),3);
  assert.equal((await authority.ingestBatch(writer,key,requests)).items[0].receipt.receiptId,firstReceipt.receiptId);
  const cancelled=await authority.cancelBatch(writer,key);
  assert.equal(cancelled.state,'cancelled');
  await assert.rejects(authority.ingestBatch(writer,key,requests),{code:'BATCH_CANCELLED'});
  const pendingKey='cancel-pending';
  await authority.transaction(writer,tx=>tx.startBatch(pendingKey,digest,requests));
  await authority.cancelBatch(writer,pendingKey);
  await assert.rejects(authority.transaction(writer,tx=>tx.processBatchItem(pendingKey,0,false)),{code:'BATCH_CANCELLED'});
  assert.deepEqual((await authority.batchProgress(writer,pendingKey)).items.map(item=>item.state),['pending','pending','pending']);
  await pool.query("UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1",[writer.spaceId]);
  await pool.query('SELECT stateplane_purge_space($1)',[writer.spaceId]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM batch_operations WHERE space_id=$1',[writer.spaceId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM collection_write_slots WHERE space_id=$1',[writer.spaceId])).rows[0].n,0);
});

test('in-flight batch cancellation backs off, then preserves the committed item receipt',async()=>{
  const {writer}=await fixture();
  const key='cancel-in-flight',requests=[JSON.stringify({operation:'create',data:{label:'cancel-in-flight'}})];
  const digest=createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  await authority.transaction(writer,tx=>tx.startBatch(key,digest,requests));
  let entered,release;
  const processing=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const item=authority.transaction(writer,async tx=>{
    await tx.processBatchItem(key,0,false);
    entered();
    await held;
  });
  try {
    await processing;
    await assert.rejects(authority.cancelBatch(writer,key),{code:'BACKPRESSURE'});
  } finally { release(); await item; }
  const receipt=(await authority.batchProgress(writer,key)).items[0].receipt;
  assert.ok(receipt?.receiptId);
  assert.equal((await authority.cancelBatch(writer,key)).state,'cancelled');
  assert.equal((await authority.batchProgress(writer,key)).items[0].receipt.receiptId,receipt.receiptId);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),1);
});

test('rolled-back batch item reports stable backpressure and resumes its unchanged manifest',async()=>{
  const {writer}=await fixture();
  const key='transient-item',requests=[JSON.stringify({operation:'create',data:{label:'transient-item'}})];
  let interrupted=false;
  const flaky=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:(sql,...args)=>{
      if (!interrupted && String(sql).includes('SELECT state FROM batch_operations')) {
        interrupted=true;
        throw Object.assign(new Error('forced serialization rollback'),{code:'40001'});
      }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600);
  await assert.rejects(flaky.ingestBatch(writer,key,requests),{code:'BACKPRESSURE'});
  assert.equal(interrupted,true);
  assert.deepEqual((await authority.batchProgress(writer,key)).items.map(item=>item.state),['pending']);
  const resumed=await authority.ingestBatch(writer,key,requests);
  assert.equal(resumed.items[0].state,'succeeded');
  assert.equal((await authority.ingestBatch(writer,key,requests)).items[0].receipt.receiptId,
    resumed.items[0].receipt.receiptId);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),1);
});

test('a concurrently completed batch item does not cancel later ordinals',async()=>{
  const {writer}=await fixture();
  const key='terminal-item',requests=[0,1].map(i=>JSON.stringify({operation:'create',data:{label:`terminal-${i}`}}));
  const digest=createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  await authority.transaction(writer,tx=>tx.startBatch(key,digest,requests));
  await authority.transaction(writer,tx=>tx.processBatchItem(key,0,false));
  await authority.transaction(writer,tx=>tx.failBatchItem(key,0,'SCHEMA_INVALID'));
  await authority.transaction(writer,tx=>tx.processBatchItem(key,1,false));
  const progress=await authority.batchProgress(writer,key);
  assert.equal(progress.state,'active');
  assert.deepEqual(progress.items.map(item=>item.state),['succeeded','succeeded']);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),2);
});

test('batch item lock wait respects the remaining request budget',async()=>{
  const {writer}=await fixture();
  const key='budget-locked',requests=[JSON.stringify({operation:'create',data:{label:'budget-locked'}})];
  const digest=createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  await authority.transaction(writer,tx=>tx.startBatch(key,digest,requests));
  const blocker=await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM batch_operations WHERE space_id=$1 AND collection_id=$2
      AND credential_id=$3 AND operation_key=$4 FOR UPDATE`,[writer.spaceId,writer.collectionId,writer.credentialId,key]);
    await assert.rejects(authority.transaction(writer,tx=>tx.processBatchItem(key,0,false,25)),{code:'RATE_LIMITED'});
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  assert.deepEqual((await authority.batchProgress(writer,key)).items.map(item=>item.state),['pending']);
});

test('batch transaction budget also bounds pool admission and releases a late connection',async()=>{
  const {writer}=await fixture();
  let connect,releaseCount=0;
  const delayed=new PostgresAuthority({connect:()=>new Promise(resolve=>{connect=resolve;})},3600);
  await assert.rejects(delayed.transaction(writer,async()=>{},Date.now()+20),{code:'RATE_LIMITED'});
  connect({release:()=>{releaseCount++;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(releaseCount,1);
});

test('standalone exact reads and batch preflight bound pool admission before authorization',async()=>{
  const {writer}=await fixture();
  const pending=[];
  let released=0;
  const delayed=new PostgresAuthority({connect:()=>new Promise(resolve=>pending.push(resolve))},
    3600,randomBytes(32),30);
  const reader=read(writer);
  const requests=[
    delayed.transaction(reader,tx=>tx.queryPage([],1)),
    delayed.transaction(reader,tx=>tx.queryRecords([],1)),
    delayed.transaction(reader,tx=>tx.countRecords([])),
    delayed.transaction(reader,tx=>tx.existsRecord([])),
    delayed.transaction(reader,tx=>tx.countRecords([]),Date.now()+60_000),
    delayed.ingestSerializedBatch(writer,'pool-preflight',JSON.stringify(['{}'])),
    delayed.batchProgress(reader,'pool-preflight'),
    delayed.cancelBatch(writer,'pool-preflight')
  ];
  await Promise.all(requests.map(request=>assert.rejects(request,{code:'RATE_LIMITED'})));
  assert.equal(pending.length,requests.length);
  for (const connect of pending) connect({release:()=>{released++;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(released,requests.length);
});

test('read and serialized batch budgets cover authorization lock waits',async()=>{
  const {writer}=await fixture();
  const blocker=await pool.connect();
  const bounded=new PostgresAuthority(pool,3600,randomBytes(32),120);
  try {
    await blocker.query('BEGIN');
    await blocker.query('UPDATE spaces SET policy_version=policy_version WHERE space_id=$1',[writer.spaceId]);
    await assert.rejects(bounded.transaction(read(writer),tx=>tx.countRecords([])),{code:'RATE_LIMITED'});
    await assert.rejects(bounded.ingestSerializedBatch(writer,'locked-preflight',JSON.stringify(['{}'])),
      {code:'RATE_LIMITED'});
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM batch_operations WHERE space_id=$1',
    [writer.spaceId])).rows[0].n,0);
});

test('a late clock tick after the last item reports complete durable progress',async()=>{
  const {writer}=await fixture();
  const bounded=new PostgresAuthority(pool,3600,undefined,1500);
  const processOrdinal=bounded.processBatchOrdinal.bind(bounded);
  bounded.processBatchOrdinal=async (...args)=>{
    const result=await processOrdinal(...args);
    await new Promise(resolve=>setTimeout(resolve,1800));
    return result;
  };
  const key='expired-progress',requests=[JSON.stringify({operation:'create',data:{label:'expired-progress'}})];
  const completed=await bounded.ingestBatch(writer,key,requests);
  assert.equal(completed.items[0].state,'succeeded');
  const progress=await authority.batchProgress(writer,key);
  assert.equal(progress.items[0].state,'succeeded');
  assert.ok(progress.items[0].receipt?.receiptId);
  assert.equal(completed.items[0].receipt.receiptId,progress.items[0].receipt.receiptId);
  const replay=await authority.ingestBatch(writer,key,requests);
  assert.equal(replay.items[0].receipt.receiptId,progress.items[0].receipt.receiptId);
  assert.equal(await authority.transaction(read(writer),tx=>tx.countRecords([])),1);
});

test('batch attempts and slot seeding keep their database-level bounds',async()=>{
  const {writer}=await fixture();
  const key=`batch-domain-${randomUUID()}`;
  await authority.transaction(writer,tx=>tx.startBatch(key,'d'.repeat(64),['{}']));
  await assert.rejects(pool.query(`UPDATE batch_items SET attempts=-1 WHERE space_id=$1 AND collection_id=$2
    AND credential_id=$3 AND operation_key=$4`,[writer.spaceId,writer.collectionId,writer.credentialId,key]),
  {code:'23514'});
  const slots=await pool.query('SELECT count(*)::int AS n FROM collection_write_slots WHERE space_id=$1 AND collection_id=$2',
    [writer.spaceId,writer.collectionId]);
  assert.equal(slots.rows[0].n,8);
  const fn=(await pool.query(`SELECT proconfig FROM pg_proc WHERE oid='public.stateplane_seed_write_slots()'::regprocedure`))
    .rows[0].proconfig;
  assert.ok(fn.includes('search_path=pg_catalog, public, pg_temp'));
});

test('populated batch validation permits writes while its validation lock waits',async()=>{
  const {writer}=await fixture();
  const key=`batch-validate-${randomUUID()}`;
  await authority.transaction(writer,tx=>tx.startBatch(key,'d'.repeat(64),['{}']));
  await pool.query('ALTER TABLE batch_items DROP CONSTRAINT batch_items_attempts_nonnegative');
  await pool.query('ALTER TABLE batch_items ADD CONSTRAINT batch_items_attempts_nonnegative CHECK (attempts >= 0) NOT VALID');
  const blocker=await pool.connect(),validator=await pool.connect(),updater=await pool.connect();
  let validation;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE batch_items IN SHARE UPDATE EXCLUSIVE MODE');
    validation=validator.query(await readFile(new URL('../../migrations/033_validate_batch_attempts.sql',import.meta.url),'utf8'));
    validation.catch(()=>{});
    let waiting=false;
    for (let attempt=0;attempt<100;attempt++) {
      const row=(await pool.query(`SELECT wait_event_type FROM pg_stat_activity
        WHERE pid=$1`,[validator.processID])).rows[0];
      if (row?.wait_event_type==='Lock') { waiting=true; break; }
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'PostgreSQL reports validation waiting on the independent DDL lock');
    await updater.query("SET statement_timeout = '1500ms'");
    const updated=await updater.query(`UPDATE batch_items SET attempts=attempts+1
      WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3 AND operation_key=$4 AND ordinal=0`,
      [writer.spaceId,writer.collectionId,writer.credentialId,key]);
    assert.equal(updated.rowCount,1,'the validation lock does not block batch progress');
    await blocker.query('COMMIT');
    await validation;
    assert.equal((await pool.query(`SELECT convalidated FROM pg_constraint WHERE conrelid='public.batch_items'::regclass
      AND conname='batch_items_attempts_nonnegative'`)).rows[0].convalidated,true);
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{});
    if (validation) await validation.catch(()=>{});
    blocker.release(); validator.release(); updater.release();
  }
});

test('failing an absent batch operation or item reports NOT_FOUND without changing pending items',async()=>{
  const {writer}=await fixture();
  const missing=`missing-${randomUUID()}`;
  await assert.rejects(authority.transaction(writer,tx=>tx.failBatchItem(missing,0,'SCHEMA_INVALID')),
    {code:'NOT_FOUND'});
  const key=`batch-missing-item-${randomUUID()}`;
  await authority.transaction(writer,tx=>tx.startBatch(key,'d'.repeat(64),['{}']));
  await assert.rejects(authority.transaction(writer,tx=>tx.failBatchItem(key,1,'SCHEMA_INVALID')),
    {code:'NOT_FOUND'});
  assert.equal((await authority.batchProgress(writer,key)).items[0].state,'pending');
});

test('a 20-item indexed batch bounds timeout-setting round trips',async()=>{
  const {writer}=await fixture();
  let timeoutSets=0;
  const measured={connect:async()=>{
    const client=await pool.connect();
    return {query:(...args)=>{
      if (String(args[0]).startsWith('SET LOCAL statement_timeout')) timeoutSets++;
      return client.query(...args);
    },release:discard=>client.release(discard)};
  }};
  const batch=new PostgresAuthority(measured,3600);
  const requests=Array.from({length:20},(_,i)=>JSON.stringify({operation:'create',data:{label:`volume-${i}`,score:i}}));
  const result=await batch.ingestBatch(writer,`volume-${randomUUID()}`,requests);
  assert.equal(result.items.length,20);
  assert.ok(result.items.every(item=>item.state==='succeeded' && item.receipt?.receiptId));
  assert.ok(timeoutSets<=100,`20 items required ${timeoutSets} timeout-setting round trips`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_index_values WHERE space_id=$1',
    [writer.spaceId])).rows[0].n,20);
});

test('paged reads cap payload bytes and a 5000-row selective typed query uses the declared index',async()=>{
  const {owner,writer}=await fixture();
  const expanded={...schema,properties:{...schema.properties,note:{type:'string'}}};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:expanded,sortable:['score']}));
  await registry.backfill(owner,'score');
  const large='x'.repeat(750_000);
  for (let i=0;i<4;i++) await authority.mutateRequest(writer,{operation:'create',idempotencyKey:`wide-${i}`,
    data:{label:`wide-${i}`,score:i,note:large}});
  const paged=new PostgresAuthority(pool,3600,randomBytes(32));
  const first=await paged.transaction(read(writer),tx=>tx.queryPage([],100));
  assert.equal(first.records.length,2);
  assert.ok(first.records.reduce((n,r)=>n+Buffer.byteLength(r.canonicalData),0)<=2_097_152);
  assert.ok(first.nextCursor);
  const second=await paged.transaction(read(writer),tx=>tx.queryPage([],100,undefined,first.nextCursor));
  assert.equal(second.records.length,2);
  assert.equal(second.nextCursor,null);

  const volume=await pool.connect();
  try {
    await volume.query('BEGIN');
    await volume.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT $1,$2,'volume-'||g,1,2,'generated','volume-'||g,
      ('{"label":"volume-'||g||'","score":'||g||'}'),
      jsonb_build_object('label','volume-'||g,'score',g)
    FROM generate_series(1,5000) AS g`,[owner.spaceId,owner.collectionId]);
    await volume.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,number_value)
    SELECT $1,$2,'volume-'||g,'score','number',g FROM generate_series(1,5000) AS g`,[owner.spaceId,owner.collectionId]);
    await volume.query('COMMIT');
  } finally { volume.release(); }
  await pool.query('ANALYZE records');
  await pool.query('ANALYZE record_index_values');
  let plan;
  const observed=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('ranked AS MATERIALIZED')) {
        const explained=await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,...args);
        plan=explained.rows[0]['QUERY PLAN'][0];
      }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600,randomBytes(32));
  const result=await observed.transaction(read(writer),tx=>tx.queryPage(
    [{field:'score',kind:'number',operator:'gte',value:4900}],25,{field:'score',direction:'asc'}));
  assert.equal(result.records.length,25);
  assert.equal(JSON.parse(result.records[0].canonicalData).score,4900);
  assert.ok(JSON.stringify(plan.Plan).includes('record_index_number'),JSON.stringify(plan.Plan));
  const sortOnly=await observed.transaction(read(writer),tx=>tx.queryPage([],25,{field:'score',direction:'desc'}));
  assert.equal(sortOnly.records.length,25);
  assert.equal(JSON.parse(sortOnly.records[0].canonicalData).score,5000);
  assert.ok(JSON.stringify(plan.Plan).includes('record_index_number'),JSON.stringify(plan.Plan));
});

test('5000-row sort-only pages use indexed presence and typed order in both directions',async()=>{
  const {owner}=await fixture();
  const fields={...schema.properties,flag:{type:'boolean'},instant:{type:'string',format:'date-time'}};
  const expanded={...schema,properties:fields};
  await registry.revise(owner,1,definition(owner.collectionId,{version:2,schema:expanded,
    sortable:['score','label','flag','instant']}));
  for (const field of ['score','label','flag','instant']) await registry.backfill(owner,field);
  const volume=await pool.connect();
  try {
    await volume.query('BEGIN');
    await volume.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT $1,$2,'plan-'||g,1,2,'generated','plan-'||g,payload::text,payload
    FROM generate_series(1,5000) AS g
    CROSS JOIN LATERAL (SELECT jsonb_build_object('label','plan-'||g,'score',g,'flag',g%2=0,
      'instant','2026-01-01T00:00:'||lpad(((g-1)%60)::text,2,'0')||'Z') AS payload) p`,
  [owner.spaceId,owner.collectionId]);
    await volume.query(`INSERT INTO record_index_values
    (space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
    SELECT $1,$2,'plan-'||g,'score','number',NULL,g,NULL::boolean,NULL FROM generate_series(1,5000) AS g
    UNION ALL SELECT $1,$2,'plan-'||g,'label','string','plan-'||g,NULL,NULL,NULL FROM generate_series(1,5000) AS g
    UNION ALL SELECT $1,$2,'plan-'||g,'flag','boolean',NULL,NULL,g%2=0,NULL FROM generate_series(1,5000) AS g
    UNION ALL SELECT $1,$2,'plan-'||g,'instant','date-time',NULL,NULL,NULL,
      '2026-01-01T00:00:'||lpad(((g-1)%60)::text,2,'0')||'Z' FROM generate_series(1,5000) AS g`,
  [owner.spaceId,owner.collectionId]);
    await volume.query('COMMIT');
  } finally { volume.release(); }
  await pool.query('ANALYZE records');
  await pool.query('ANALYZE record_index_values');
  let plan;
  const observed=new PostgresAuthority({connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (String(sql).includes('ranked AS MATERIALIZED'))
        plan=(await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,...args)).rows[0]['QUERY PLAN'][0];
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }},3600,randomBytes(32));
  const names=node=>[node['Index Name'],...(node.Plans??[]).flatMap(names)].filter(Boolean);
  const scans=node=>[node,...(node.Plans??[]).flatMap(scans)].filter(part=>part['Node Type']==='Seq Scan' &&
    ['records','record_index_values'].includes(part['Relation Name']));
  for (const [field,index] of [['score','record_index_number'],['label','record_index_string'],
    ['flag','record_index_boolean'],['instant','record_index_instant_order']]) {
    for (const direction of ['asc','desc']) {
      const page=await observed.transaction(read(owner),tx=>tx.queryPage([],25,{field,direction}));
      assert.equal(page.records.length,25);
      assert.equal(scans(plan.Plan).length,0,JSON.stringify(plan.Plan));
      assert.ok(names(plan.Plan).includes('record_index_missing'),JSON.stringify(plan.Plan));
      assert.ok(names(plan.Plan).includes(index),JSON.stringify(plan.Plan));
      assert.ok(plan.Plan['Shared Hit Blocks']<2000,JSON.stringify(plan.Plan));
    }
  }
});

test('serialized exact reads work without an in-process proxy detector',async()=>{
  const {owner,writer}=await fixture();
  await registry.backfill(owner,'score');
  await authority.mutateRequest(writer,{operation:'create',idempotencyKey:'serialized-exact',data:{label:'serialized-exact',score:7}});
  const script=`import assert from 'node:assert/strict';
    import {types} from 'node:util';
    import pg from 'pg';
    types.isProxy=undefined;
    const {PostgresAuthority}=await import('./packages/postgres/dist/index.js');
    const {url,reader,writer}=JSON.parse(process.env.STA8_TEST_CONTEXT);
    const pool=new pg.Pool({connectionString:url});
    try {
      const {randomBytes}=await import('node:crypto');
      const authority=new PostgresAuthority(pool,3600,randomBytes(32));
      const filters=JSON.stringify([{field:'score',kind:'number',operator:'eq',value:7}]);
      assert.equal(await authority.transaction(reader,tx=>tx.countSerializedRecords(filters)),1);
      assert.equal(await authority.transaction(reader,tx=>tx.existsSerializedRecord(filters)),true);
      const page=await authority.transaction(reader,tx=>tx.querySerializedPage(JSON.stringify({predicates:JSON.parse(filters),limit:1})));
      assert.equal(page.records.length,1);
      await assert.rejects(authority.transaction(reader,tx=>tx.queryPage([],1)),{code:'INVALID_ARGUMENT'});
      const bulk=await authority.ingestSerializedBatch(writer,'worker-bulk',JSON.stringify([
        JSON.stringify({operation:'create',data:{label:'worker-bulk',score:8}})
      ]));
      assert.equal(bulk.items[0].state,'succeeded');
      await assert.rejects(authority.ingestBatch(writer,'direct-bulk',['{}']),{code:'INVALID_ARGUMENT'});
    } finally { await pool.end(); }
    process.stdout.write('closed');`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{
    cwd:fileURLToPath(new URL('../..',import.meta.url)),encoding:'utf8',
    env:{...process.env,STA8_TEST_CONTEXT:JSON.stringify({url,reader:read(writer),writer})}
  }),'closed');
});

test('ninth concurrent collection write reports backpressure and succeeds after a slot is released',async()=>{
  const {writer}=await fixture();
  const writerPool=new pg.Pool({connectionString:url,max:12});
  const bounded=new PostgresAuthority(writerPool,3600);
  let release;
  const hold=new Promise(resolve=>{release=resolve;});
  const entered=[];
  const active=[];
  try {
    for (let i=0;i<8;i++) {
      let signal;
      entered.push(new Promise(resolve=>{signal=resolve;}));
      active.push(bounded.transaction(writer,async tx=>{
        await tx.mutateRequest({operation:'create',idempotencyKey:`slot-${i}`,data:{label:`slot-${i}`}});
        signal();
        await hold;
      }));
    }
    await Promise.all(entered);
    const ninth={operation:'create',idempotencyKey:'slot-ninth',data:{label:'slot-ninth'}};
    await assert.rejects(bounded.mutateRequest(writer,ninth),{code:'BACKPRESSURE'});
    release();
    await Promise.all(active);
    assert.equal((await bounded.mutateRequest(writer,ninth)).revision,1);
    assert.equal(await bounded.transaction(read(writer),tx=>tx.countRecords([])),9);
  } finally { release?.(); await Promise.allSettled(active); await writerPool.end(); }
});

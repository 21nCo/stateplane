import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { execFileSync } from 'node:child_process';
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
  assert.equal(derivedValues({label:'x'},d).indexes.length,0);
  assert.equal(derivedValues({label:'x',score:null},d).indexes[0].kind,'null');
  assert.throws(()=>validateDefinition(definition('bad',{schema:{...schema,patternProperties:{}}})),{code:'SCHEMA_UNSUPPORTED'});
  assert.throws(()=>validateDefinition(definition('bad',{unique:[{name:'dup',paths:['label']},{name:'dup',paths:['score']}]})),{code:'SCHEMA_UNSUPPORTED'});
  const next=definition('generic',{version:2,schema:{...schema,properties:{...schema.properties,note:{type:'string',description:'optional'}}}});
  assert.doesNotThrow(()=>compatible(d,next));
  assert.throws(()=>compatible(d,{...next,schema:{...next.schema,required:['label','note']}}),{code:'SCHEMA_BREAKING'});
  assert.throws(()=>compatible(d,{...next,unique:[{name:'new',paths:['label']}]}),{code:'SCHEMA_BREAKING'});
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
  const revision=registry.revise(owner,1,next).then(value=>{revised=true;return value;});
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
  const revising=registry.revise(owner,1,next).then(value=>{revised=true;return value;});
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
  const backfilling=registry.backfill(owner,'note').then(result=>{completed=true;return result;});
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

test('declared lifecycle transitions gate generic writes',async()=>{
  const suffix=randomUUID(); const spaceId=`sp_${suffix}`,collectionId=`entries_${suffix}`;
  await pool.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
    VALUES($1,'owner','cell-a','cell-a','target-a')`,[spaceId]);
  const scope={spaceId,collectionId,principalId:'owner',credentialId:'session',capability:'schema:write',policyVersion:1,placementGeneration:1};
  await registry.define(scope,definition(collectionId,{lifecycle:{field:'state',initial:['open'],transitions:{open:['closed'],closed:[]}}}));
  const writer={...scope,capability:'records:write'};
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
  await registry.define(scope,definition(collectionId,{lifecycle:{field:'state',initial:['open'],transitions:{}}}));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(misleadingPredicate)),{code:'SCHEMA_CONFLICT'});
  assert.deepEqual(await registry.backfill(owner,'note'),{processed:100,ready:false});
  await assert.rejects(authority.transaction(reader,tx=>tx.countRecords(predicate)),{code:'SCHEMA_CONFLICT'});
  assert.deepEqual(await registry.backfill(owner,'note'),{processed:1,ready:true});
  assert.equal(await authority.transaction(reader,tx=>tx.countRecords(predicate)),1);
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

test('readOnly permits an authorized replay and denies a fresh malformed payload first',async()=>{
  const {owner,writer}=await fixture();
  const request={operation:'create',idempotencyKey:'one',data:{label:'one'}};
  const saved=await authority.mutateRequest(writer,request);
  await pool.query("UPDATE spaces SET lifecycle='readOnly' WHERE space_id=$1",[owner.spaceId]);
  assert.equal((await authority.mutateRequest(writer,request)).receiptId,saved.receiptId);
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'fresh',data:{label:undefined}}),{code:'SPACE_UNAVAILABLE'});
  await assert.rejects(authority.mutateRequest(writer,{operation:'create',idempotencyKey:'one',data:{label:undefined}}),{code:'SCHEMA_INVALID'});
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

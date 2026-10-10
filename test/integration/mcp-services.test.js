import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import Ajv2020 from 'ajv/dist/2020.js';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { McpFnTestClient, authenticatedHttpTarget } from '@mcpfn/testing';
import { AuthFnIdentityVerifier, AuthFnAgentKeys } from '../../packages/auth/dist/index.js';
import { CollectionRegistry, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { createMcpHandler, stateplaneMcpDeclaration } from '../../packages/mcp/dist/index.js';

const password=process.env.DATABASE_URL?null:(await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url=process.env.DATABASE_URL??`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const pool=new pg.Pool({connectionString:url,max:6});
test.after(()=>pool.end());

const config={database:memoryAdapter(),namespace:`sta10-${randomUUID()}`,plugins:[]};
createAuthFn(config);
const identity=new AuthFnIdentityVerifier(config);
const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
const spaces=new PostgresSpaces(pool,cells,'cell-a',new AuthFnAgentKeys(config),identity,randomBytes(32));
const services=postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600);
const http=createHttpHandler({services,identity});

async function host() {
  const holder={};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const response=await holder.handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{
      method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined}));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
  holder.handler=createMcpHandler({services,identity,resource:endpoint,
    authorizationServers:['http://127.0.0.1:9/'],allowInsecureLoopback:true});
  return {server,endpoint};
}
const connect=(endpoint,token,name)=>McpFnTestClient.connectTarget(authenticatedHttpTarget(endpoint,
  {credential:{kind:'api-key',headers:{authorization:`Bearer ${token}`}}}),{name,version:'1.0.0'});
const call=async(client,tool,args)=>{
  const result=await client.callTool(tool,args);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent,`${tool} text/structured parity`);
  return result;
};
const ok=async(client,tool,args)=>{
  const result=await call(client,tool,args);
  assert.equal(result.isError,undefined,`${tool}: ${result.content[0].text}`);
  return result.structuredContent;
};
const failed=async(client,tool,args)=>{
  const result=await call(client,tool,args);
  assert.equal(result.isError,true,`${tool} should fail`);
  return result.structuredContent.error.code;
};
const viaHttp=async(token,method,path,body)=>{
  const response=await http(new Request(`https://stateplane.example.invalid/v1/${path}`,{method,
    headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},
    body:body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body))}));
  const value=await response.json();
  return response.ok?value:value.error.code;
};
const effects=async spaceId=>(await pool.query(`SELECT
  (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
  (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
  (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts`,[spaceId])).rows[0];

test('two MCP credentials share exact state, conflicts, receipts and revocation through the Postgres authority',async t=>{
  const user=await createUser(config,{primaryEmail:`owner-${randomUUID()}@example.invalid`});
  const session=await issueSession(config,{},{userId:user.id,methods:['password']});
  const owner=await identity.verify(new Request('https://h.invalid',{headers:{authorization:`Bearer ${session.sessionToken}`}}));
  const spaceId=`sp_${randomUUID()}`;
  await spaces.create(owner,'cell-a',spaceId);
  const {server,endpoint}=await host();
  t.after(()=>server.close());
  const ownerClient=await connect(endpoint,session.sessionToken,'owner-client');
  t.after(()=>ownerClient.close());
  const collectionId='entries';
  const definition={slug:collectionId,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',
    properties:{label:{type:'string'},state:{type:'string',enum:['open','closed']},score:{type:'number'}},
    required:['label'],additionalProperties:false},unique:[{name:'by_label',paths:['label']}],filterable:['state'],sortable:[]};
  const defined=await ok(ownerClient,'collections_define',{spaceId,collectionId,definition});
  assert.equal(defined.slug,collectionId);
  assert.equal(await failed(ownerClient,'collections_define',{spaceId,collectionId,definition}),'SCHEMA_CONFLICT');
  const listedBefore=(await ownerClient.listTools()).map(tool=>tool.name);
  const other='private';
  await ok(ownerClient,'collections_define',{spaceId,collectionId:other,definition:{...definition,slug:other}});
  assert.deepEqual((await ownerClient.listTools()).map(tool=>tool.name),listedBefore,'collections never add tools');

  const key=await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId,capabilities:['records:read','records:write','events:read']}]);
  const agentClient=await connect(endpoint,key.secret,'agent-client');
  t.after(()=>agentClient.close().catch(()=>{}));

  const create={spaceId,collectionId,externalKey:' item-1 ',idempotencyKey:'create-1',data:{label:'Item 1',state:'open'}};
  const created=await ok(agentClient,'records_create',create);
  assert.deepEqual([created.operation,created.revision,created.beforeRevision,created.replayed],['create',1,null,false]);
  const id=created.ref.id;
  const seen=await ok(ownerClient,'records_get',{spaceId,collectionId,id});
  assert.equal(seen.revision,1);
  assert.deepEqual(await ok(ownerClient,'records_get_by_key',{spaceId,collectionId,mode:'external',key:'item-1'}),seen);
  assert.deepEqual(await viaHttp(session.sessionToken,'GET',`spaces/${spaceId}/collections/${collectionId}/records/${id}`),seen,
    'MCP and HTTP read the same authoritative record');

  // Lost response: the identical request and key returns the original receipt,
  // through MCP and through HTTP for the same credential.
  const replay=await ok(agentClient,'records_create',create);
  assert.deepEqual({...replay,replayed:false},created);
  assert.equal(replay.replayed,true);
  const httpReplay=await viaHttp(key.secret,'POST',`spaces/${spaceId}/collections/${collectionId}/records`,
    {operation:'create',idempotencyKey:'create-1',externalKey:' item-1 ',data:{label:'Item 1',state:'open'}});
  assert.equal(httpReplay.receiptId,created.receiptId);
  assert.equal(await failed(agentClient,'records_create',{...create,data:{label:'Changed'}}),'IDEMPOTENCY_MISMATCH');
  assert.equal(await failed(ownerClient,'records_create',{...create,idempotencyKey:'create-dup',data:{label:'Other'}}),'KEY_RESERVED',
    'another client cannot take a held external key');
  assert.equal(await failed(ownerClient,'records_create',{...create,idempotencyKey:'create-dup-2',externalKey:'item-2'}),'UNIQUE_CONFLICT',
    'another client cannot duplicate a declared unique value');

  const replaced=await ok(ownerClient,'records_replace',{spaceId,collectionId,id,expectedRevision:1,idempotencyKey:'replace-1',
    data:{label:'Item 1',state:'closed'}});
  assert.deepEqual([replaced.beforeRevision,replaced.revision],[1,2]);
  assert.equal(await failed(agentClient,'records_patch',{spaceId,collectionId,id,expectedRevision:1,idempotencyKey:'patch-stale',
    set:{score:1},unset:[]}),'REVISION_CONFLICT');
  const patched=await ok(agentClient,'records_patch',{spaceId,collectionId,id,expectedRevision:2,idempotencyKey:'patch-1',
    set:{score:1},unset:[]});
  assert.equal(patched.revision,3);
  const replacedAgain=await ok(ownerClient,'records_replace',{spaceId,collectionId,id,expectedRevision:1,idempotencyKey:'replace-1',
    data:{label:'Item 1',state:'closed'}});
  assert.equal(replacedAgain.replayed,true,'a committed old-revision retry replays before the stale check');

  const filter={spaceId,collectionId,predicates:[{field:'state',kind:'string',operator:'eq',value:'closed'}],limit:10};
  assert.equal(await failed(agentClient,'records_query',filter),'SCHEMA_CONFLICT','a pending filter index is never guessed');
  assert.deepEqual((await ok(agentClient,'collections_get',{spaceId,collectionId})).pending,['state']);
  const {scope}=await spaces.scope(owner,spaceId,collectionId,'schema:write');
  assert.equal((await new CollectionRegistry(pool).backfill(scope,'state')).ready,true);
  const page=await ok(agentClient,'records_query',{spaceId,collectionId,predicates:[{field:'state',kind:'string',operator:'eq',value:'closed'}],limit:10});
  assert.deepEqual(page.records.map(record=>[record.ref?.id??record.id,record.revision]),[[id,3]]);
  assert.deepEqual(await ok(ownerClient,'records_count',{spaceId,collectionId,predicates:[]}),{count:1});
  const events=await ok(agentClient,'events_list',{spaceId,collectionId});
  assert.equal(events.events.length,3);

  // The authority authorizes before rejecting an undeclared field. A collection
  // outside the key's grants is concealed exactly as through HTTP.
  const before=await effects(spaceId);
  const malformed={spaceId,collectionId,idempotencyKey:'odd',data:{label:'x'},unexpected:true};
  assert.equal(await failed(agentClient,'records_create',malformed),'INVALID_ARGUMENT');
  const hidden=await failed(agentClient,'records_create',{...malformed,collectionId:other});
  assert.equal(hidden,await viaHttp(key.secret,'POST',`spaces/${spaceId}/collections/${other}/records`,
    {operation:'create',idempotencyKey:'odd',data:{label:'x'},unexpected:true}));
  assert.notEqual(hidden,'INVALID_ARGUMENT');
  const big=JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'records_create',
    arguments:{spaceId,collectionId,idempotencyKey:'infinite',data:{label:'x',score:0}}}}).replace('"score":0','"score":1e400');
  const response=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json',
    accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:big});
  const rejected=(await response.json()).result.structuredContent.error.code;
  assert.equal(rejected,await viaHttp(key.secret,'POST',`spaces/${spaceId}/collections/${collectionId}/records`,
    '{"operation":"create","idempotencyKey":"infinite","data":{"label":"x","score":1e400}}'));
  assert.equal(rejected,'SCHEMA_INVALID');
  assert.deepEqual(await effects(spaceId),before,'rejected MCP writes leave no record, event or receipt');

  const deleted=await ok(agentClient,'records_delete',{spaceId,collectionId,id,expectedRevision:3,idempotencyKey:'delete-1'});
  assert.deepEqual([deleted.operation,deleted.revision],['delete',4]);
  assert.equal(await failed(ownerClient,'records_get',{spaceId,collectionId,id}),'NOT_FOUND');
  assert.equal(await failed(ownerClient,'records_create',{...create,idempotencyKey:'reuse',data:{label:'New'}}),'KEY_RESERVED');
  assert.deepEqual(await ok(agentClient,'records_delete',{spaceId,collectionId,id,expectedRevision:3,idempotencyKey:'delete-1'}),
    {...deleted,replayed:true});

  await spaces.revokeAgentKey(owner,spaceId,key.id);
  await assert.rejects(agentClient.callTool('records_count',{spaceId,collectionId,predicates:[]}),
    'a revoked AuthFn key is rejected at the MCP resource boundary');
  const revokedProbe=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${key.secret}`,'content-type':'application/json',
    accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(revokedProbe.status,401);
  assert.match(revokedProbe.headers.get('www-authenticate'),/resource_metadata=/);
  assert.deepEqual(await ok(ownerClient,'records_count',{spaceId,collectionId,predicates:[]}),{count:0},
    'the owner keeps working after the agent key is revoked');
  const audit=await spaces.audit(owner,spaceId);
  assert.ok(audit.entries.some(entry=>JSON.stringify(entry).includes('revok')),'revocation is audited');
});

test('a cell-revoked key whose provider still authenticates is denied by the shared services',async t=>{
  const user=await createUser(config,{primaryEmail:`owner-${randomUUID()}@example.invalid`});
  const session=await issueSession(config,{},{userId:user.id,methods:['password']});
  const owner=await identity.verify(new Request('https://h.invalid',{headers:{authorization:`Bearer ${session.sessionToken}`}}));
  const spaceId=`sp_${randomUUID()}`;
  await spaces.create(owner,'cell-a',spaceId);
  const {server,endpoint}=await host();
  t.after(()=>server.close());
  const ownerClient=await connect(endpoint,session.sessionToken,'owner-client');
  t.after(()=>ownerClient.close());
  const definition={slug:'entries',version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',
    properties:{label:{type:'string'}},required:['label'],additionalProperties:false},unique:[],filterable:[],sortable:[]};
  await ok(ownerClient,'collections_define',{spaceId,collectionId:'entries',definition});
  const key=await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),
    [{collectionId:'entries',capabilities:['records:read']}]);
  const agentClient=await connect(endpoint,key.secret,'agent-client');
  t.after(()=>agentClient.close());
  assert.deepEqual(await ok(agentClient,'records_count',{spaceId,collectionId:'entries',predicates:[]}),{count:0});
  assert.equal(await failed(agentClient,'records_create',{spaceId,collectionId:'entries',idempotencyKey:'w',data:{label:'x'}}),
    await viaHttp(key.secret,'POST',`spaces/${spaceId}/collections/entries/records`,{operation:'create',idempotencyKey:'w',data:{label:'x'}}),
    'a read-only grant cannot write through either transport');
  await pool.query('UPDATE space_credentials SET revoked_at=clock_timestamp() WHERE space_id=$1 AND credential_id=$2',[spaceId,key.id]);
  assert.equal(await failed(agentClient,'records_count',{spaceId,collectionId:'entries',predicates:[]}),'NOT_FOUND');
  assert.equal(await failed(agentClient,'collections_list',{spaceId}),'NOT_FOUND');
});

const trimmed=/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
/** The published schema with its x- extensions applied as a client must. */
function publishedValidator(name) {
  const ajv=new Ajv2020({strict:false,allErrors:true});
  ajv.addKeyword({keyword:'x-utf8MaxBytes',type:'string',validate:(limit,value)=>Buffer.byteLength(value)<=limit});
  ajv.addKeyword({keyword:'x-utf16MaxLength',type:'string',validate:(limit,value)=>value.length<=limit});
  ajv.addKeyword({keyword:'x-nfcTrimmedUtf8MaxBytes',type:'string',
    validate:(limit,value)=>Buffer.byteLength(value.normalize('NFC').replace(trimmed,''))<=limit});
  return ajv.compile(stateplaneMcpDeclaration().manifest().tools.find(tool=>tool.name===name).inputSchema);
}

test('published key and definition limits accept exactly what the authority accepts',async t=>{
  const user=await createUser(config,{primaryEmail:`owner-${randomUUID()}@example.invalid`});
  const session=await issueSession(config,{},{userId:user.id,methods:['password']});
  const owner=await identity.verify(new Request('https://h.invalid',{headers:{authorization:`Bearer ${session.sessionToken}`}}));
  const spaceId=`sp_${randomUUID()}`;
  await spaces.create(owner,'cell-a',spaceId);
  t.after(async()=>{ await spaces.archive(owner,spaceId); await spaces.delete(owner,spaceId); });
  const {server,endpoint}=await host();
  t.after(()=>server.close());
  const client=await connect(endpoint,session.sessionToken,'owner-client');
  t.after(()=>client.close());
  const collectionId='entries';
  const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{label:{type:'string'}},
    required:['label'],additionalProperties:false};
  // Every case is otherwise valid and unique, so only a successful call counts as acceptance.
  const accepted=async(tool,args)=>!(await call(client,tool,args)).isError;
  // Predicate cases query a collection whose filter indexes are ready.
  await ok(client,'collections_define',{spaceId,collectionId:'filters',definition:{slug:'filters',version:1,
    schema:{...schema,properties:{label:{type:'string'},at:{type:'string',format:'date-time'}}},
    unique:[],filterable:['label','at'],sortable:[]}});
  const {scope}=await spaces.scope(owner,spaceId,'filters','schema:write');
  for (const field of ['label','at']) assert.equal((await new CollectionRegistry(pool).backfill(scope,field)).ready,true);
  const query=(tool,predicates)=>[tool,{spaceId,collectionId:'filters',predicates,...tool==='records_query'?{limit:1}:{}}];
  const create=(idempotencyKey,externalKey)=>['records_create',{spaceId,collectionId,idempotencyKey,externalKey,data:{label:idempotencyKey}}];
  const cases=[
    ['collections_define',{spaceId,collectionId:'empty',definition:{slug:'empty',version:1,schema:{},unique:[],filterable:[],sortable:[]}}],
    ['collections_define',{spaceId,collectionId,definition:{slug:collectionId,version:1,schema,unique:[],filterable:[],sortable:[]}}],
    // 64 four-byte characters are 256 UTF-8 bytes; 65 are 260 bytes but only 65 code points.
    ['records_create',{spaceId,collectionId,idempotencyKey:'\u{1F600}'.repeat(64),data:{label:'a'}}],
    ['records_create',{spaceId,collectionId,idempotencyKey:'\u{1F600}'.repeat(65),data:{label:'b'}}],
    ['batches_status',{spaceId,collectionId,operationKey:'\u{1F600}'.repeat(65)}],
    ['batches_ingest',{spaceId,collectionId,operationKey:'\u{1F600}'.repeat(64),items:[JSON.stringify({operation:'create',data:{label:'c'}})]}],
    ['batches_ingest',{spaceId,collectionId,operationKey:'\u{1F600}'.repeat(65),items:[JSON.stringify({operation:'create',data:{label:'d'}})]}],
    // The external-key budget applies after NFC and the fixed trim: padding and decomposition do not count.
    create('padded',` ${'a'.repeat(256)}\u3000`),
    create('decomposed','e\u0301'.repeat(128)),
    create('padded-over',` ${'b'.repeat(257)} `),
    create('decomposed-over','o\u0301'.repeat(129)),
    create('blank','\u0085 \u2003'),
    // Predicate string values are limited to 512 UTF-8 bytes, scalar and in each `in` element: 128 four-byte
    // characters are 512 bytes, 129 are 516 bytes but only 129 code points. Instants are ASCII.
    query('records_query',[{field:'label',kind:'string',operator:'eq',value:'\u{1F600}'.repeat(128)}]),
    query('records_query',[{field:'label',kind:'string',operator:'eq',value:'\u{1F600}'.repeat(129)}]),
    query('records_count',[{field:'label',kind:'string',operator:'in',value:['a','\u{1F600}'.repeat(128)]}]),
    query('records_count',[{field:'label',kind:'string',operator:'in',value:['a','\u{1F600}'.repeat(129)]}]),
    query('records_query',[{field:'at',kind:'date-time',operator:'gte',value:`2026-01-31T12:00:00.${'0'.repeat(491)}Z`}]),
    query('records_count',[{field:'at',kind:'date-time',operator:'in',value:[`2026-01-31T12:00:00.${'0'.repeat(492)}Z`]}])
  ];
  for (const [index,[tool,args]] of cases.entries()) {
    const valid=publishedValidator(tool)(args);
    assert.equal(await accepted(tool,args),valid,`case ${index}: ${tool} ${JSON.stringify(args).slice(0,120)}`);
  }
  assert.deepEqual(cases.map(([tool,args])=>publishedValidator(tool)(args)),[false,true,true,false,false,true,false,true,true,false,false,false,true,false,true,false,true,false],
    'each boundary is exercised on both sides');
});

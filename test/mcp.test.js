import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { McpFnTestClient, authenticatedHttpTarget, assertManifestContract, checkHostCompatibility,
  MCPFN_HOST_PROFILES } from '@mcpfn/testing';
import { assertAuthRegressionSuite, createFetchAuthTarget, bearerCredential } from '@mcpfn/testing/auth';
import { diffManifests } from '@mcpfn/core';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { TransportFailure } from '../packages/application/dist/index.js';
import { createMcpEndpoint, createMcpHandler, stateplaneMcpDeclaration, serializeJson, tools, guidance, guidanceUri,
  instructions, maxRequestBytes } from '../packages/mcp/dist/index.js';

const owner={kind:'session',userPrincipalId:'owner',credentialId:'session-1'};
const agent={kind:'api-key',credentialId:'agent-1'};

/** Recording fixture: every call names its service method and arguments. */
function fixture() {
  const calls=[];
  let failure=null;
  let stall=null;
  const record=(name,value)=>async(...args)=>{
    calls.push({name,args:args.slice(1),actor:args[0]});
    if (stall) await stall;
    if (failure) throw failure;
    return typeof value==='function' ? value(...args) : value;
  };
  const services={
    spaces:{list:record('spaces.list',{items:[{spaceId:'sp_a'}],cursor:null}),create:record('spaces.create',{}),
      get:record('spaces.get',{spaceId:'sp_a',lifecycle:'active'}),update:record('spaces.update',{}),delete:record('spaces.delete',{})},
    collections:{list:record('collections.list',(_a,_s,collection)=>collection?{definition:{slug:collection}}:{items:[],cursor:null}),
      define:record('collections.define',{slug:'entries'}),revise:record('collections.revise',{slug:'entries',version:2})},
    records:{get:record('records.get',(_a,_s,_c,id)=>id==='missing'?null:{id,revision:1}),
      byKey:record('records.byKey',{id:'rec_1'}),
      mutate:record('records.mutate',(_a,space)=>({contractVersion:'1',receiptId:'r_1',spaceId:space,ref:{kind:'record',id:'rec_1'},
        operation:'create',beforeRevision:null,revision:1,schemaVersion:1,committedAt:new Date(0),replayed:false})),
      query:record('records.query',{records:[],nextCursor:null,schemaVersion:1}),count:record('records.count',3)},
    batches:{ingest:record('batches.ingest',{state:'complete',items:[]}),progress:record('batches.progress',{state:'complete'}),
      cancel:record('batches.cancel',{state:'cancelled'})},
    events:{list:record('events.list',{events:[],nextCursor:'c'}),projection:record('events.projection',{state:'pending',generation:1})}
  };
  let providerDown=false;
  const identity={verify:async request=>{
    if (providerDown) throw new Error(`provider failure ${request.headers.get('authorization')}`);
    const header=request.headers.get('authorization');
    if (header==='Bearer owner-token') return owner;
    if (header==='Bearer agent-token') return agent;
    return null;
  }};
  return {services,identity,calls,fail:error=>{failure=error;},hold:()=>{let release;stall=new Promise(r=>{release=r;});
    return ()=>{stall=null;release();};},providerDown:value=>{providerDown=value;}};
}

async function serve(handler) {
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const response=await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{
      method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined}));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return {server,base:`http://127.0.0.1:${server.address().port}`};
}
async function mcpServer(state,options={}) {
  const holder={};
  const {server,base}=await serve(request=>holder.handler(request));
  holder.handler=createMcpHandler({services:state.services,identity:state.identity,resource:`${base}/mcp`,
    authorizationServers:['http://127.0.0.1:9/'],allowInsecureLoopback:true,...options});
  return {server,base,url:`${base}/mcp`};
}
async function client(url,token) {
  return McpFnTestClient.connectTarget(authenticatedHttpTarget(url,{credential:{kind:'api-key',
    headers:{authorization:`Bearer ${token}`}}}),{name:'stateplane-test',version:'1.0.0'});
}
const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',
  accept:'application/json, text/event-stream',authorization:'Bearer owner-token','mcp-protocol-version':'2025-06-18',...headers},
  body:typeof body==='string'?body:JSON.stringify(body)});

test('the fixed registry publishes the committed manifest and annotations',async()=>{
  const manifest=stateplaneMcpDeclaration().manifest();
  const committed=JSON.parse(await readFile(new URL('../contracts/mcp-manifest.json',import.meta.url),'utf8'));
  const diff=diffManifests(committed,manifest);
  assert.deepEqual(diff.changes,[],'regenerate contracts/mcp-manifest.json with pnpm mcp:manifest --write after review');
  assert.equal(manifest.hash,committed.hash);
  const names=manifest.tools.map(tool=>tool.name);
  assert.deepEqual(names,[...names].sort());
  assert.ok(names.length<=20,'the registry is bounded');
  for (const tool of manifest.tools) {
    const own=tools.find(item=>item.name===tool.name);
    assert.equal(tool.annotations.readOnlyHint,own.read,`${tool.name} read annotation matches its error mapping`);
    assert.equal(tool.annotations.openWorldHint,false);
    assert.equal(tool.inputSchema.additionalProperties,false);
    if (own.read) assert.equal(tool.annotations.destructiveHint,false);
  }
  for (const name of ['records_replace','records_patch','records_delete','batches_ingest','batches_cancel'])
    assert.equal(manifest.tools.find(tool=>tool.name===name).annotations.destructiveHint,true,name);
  assert.ok(!names.some(name=>/entries|collection_[a-z]/.test(name)),'no tool is named after a collection');
  assert.equal(manifest.resources[0].uri,guidanceUri);
  assert.match(manifest.server.instructions,/untrusted data/);
  assert.match(manifest.server.instructions,/claims/);
  const compatibility=checkHostCompatibility(manifest,MCPFN_HOST_PROFILES.toolsOnly);
  assert.notEqual(compatibility.status,'incompatible');
});

test('published mutation and predicate schemas agree with the HTTP OpenAPI contract',async()=>{
  const document=YAML.parse(await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8'));
  const variants=document.components.schemas.RecordMutation.oneOf;
  const byOperation=Object.fromEntries(variants.map(variant=>[variant.properties.operation.const,variant]));
  const manifest=stateplaneMcpDeclaration().manifest();
  const input=name=>manifest.tools.find(tool=>tool.name===name).inputSchema;
  for (const operation of ['create','replace','patch','delete']) {
    const http=byOperation[operation];
    const mcp=input(`records_${operation}`);
    const fields=Object.keys(http.properties).filter(name=>name!=='operation').sort();
    assert.deepEqual(Object.keys(mcp.properties).filter(name=>!['spaceId','collectionId'].includes(name)).sort(),fields,operation);
    assert.deepEqual(mcp.required.filter(name=>!['spaceId','collectionId'].includes(name)).sort(),
      http.required.filter(name=>name!=='operation').sort(),operation);
    assert.equal(mcp.properties.idempotencyKey.pattern,http.properties.idempotencyKey.pattern);
    assert.equal(mcp.properties.idempotencyKey.maxLength,http.properties.idempotencyKey.maxLength);
    if (operation==='create') {
      assert.equal(mcp.properties.externalKey.pattern,http.properties.externalKey.pattern);
      // OpenAPI applies its externalKey byte budget after NFC and trim; MCP names that rule explicitly.
      assert.equal(mcp.properties.externalKey['x-nfcTrimmedUtf8MaxBytes'],http.properties.externalKey['x-utf8MaxBytes']);
      assert.equal(mcp.properties.externalKey['x-utf8MaxBytes'],undefined,'no raw byte limit on a normalized key');
    }
  }
  const predicate=input('records_query').properties.predicates.items;
  const published=document.components.schemas.Predicate;
  assert.equal(predicate.oneOf.length,published.oneOf.length);
  const strip=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='description'||key.startsWith('x-')?undefined:item));
  assert.deepEqual(strip(predicate.oneOf).map(item=>item.properties.kind.const).sort(),
    strip(published.oneOf).map(item=>item.properties.kind.const).sort());
  for (const variant of published.oneOf) {
    const match=predicate.oneOf.find(item=>item.properties.kind.const===variant.properties.kind.const &&
      JSON.stringify(item.properties.operator)===JSON.stringify(variant.properties.operator));
    assert.ok(match,`MCP publishes ${variant.properties.kind.const} ${JSON.stringify(variant.properties.operator)}`);
    assert.deepEqual(match.properties.value===undefined?null:strip(match.properties.value),
      variant.properties.value===undefined?null:strip(variant.properties.value));
  }
  assert.deepEqual(input('records_query').properties.limit,{type:'integer',minimum:1,maximum:100});
});

test('two credentials use one fixed tool list and every tool reaches the shared services',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  const first=await client(url,'owner-token');
  const second=await client(url,'agent-token');
  t.after(()=>Promise.all([first.close(),second.close()]));
  const manifest=stateplaneMcpDeclaration().manifest();
  const listed=await assertManifestContract(first,manifest);
  assert.deepEqual((await second.listTools()).map(tool=>tool.name),listed.map(tool=>tool.name));
  const s={spaceId:'sp_a',collectionId:'entries'};
  const cases=[
    ['spaces_list',{cursor:'next'},'spaces.list',['next']],
    ['spaces_get',{spaceId:'sp_a'},'spaces.get',['sp_a']],
    ['collections_list',{spaceId:'sp_a'},'collections.list',['sp_a',undefined,undefined]],
    ['collections_get',s,'collections.list',['sp_a','entries']],
    ['collections_define',{...s,definition:{slug:'entries'}},'collections.define',['sp_a','entries','{"slug":"entries"}']],
    ['collections_revise',{...s,expectedVersion:1,definition:{slug:'entries',version:2}},'collections.revise',
      ['sp_a','entries',1,'{"slug":"entries","version":2}']],
    ['records_get',{...s,id:'rec_1'},'records.get',['sp_a','entries','rec_1']],
    ['records_get_by_key',{...s,mode:'external',key:' k '},'records.byKey',['sp_a','entries','external',' k ']],
    ['records_query',{...s,predicates:[],limit:5},'records.query',['sp_a','entries','{"predicates":[],"limit":5}']],
    ['records_count',{...s,predicates:[]},'records.count',['sp_a','entries','[]']],
    ['records_create',{...s,idempotencyKey:'k',data:{label:'A'}},'records.mutate',
      ['sp_a','entries','{"operation":"create","idempotencyKey":"k","data":{"label":"A"}}']],
    ['records_replace',{...s,idempotencyKey:'k',id:'rec_1',expectedRevision:1,data:{}},'records.mutate',
      ['sp_a','entries','{"operation":"replace","idempotencyKey":"k","id":"rec_1","expectedRevision":1,"data":{}}']],
    ['records_patch',{...s,idempotencyKey:'k',id:'rec_1',expectedRevision:1,set:{},unset:[]},'records.mutate',
      ['sp_a','entries','{"operation":"patch","idempotencyKey":"k","id":"rec_1","expectedRevision":1,"set":{},"unset":[]}']],
    ['records_delete',{...s,idempotencyKey:'k',id:'rec_1',expectedRevision:2},'records.mutate',
      ['sp_a','entries','{"operation":"delete","idempotencyKey":"k","id":"rec_1","expectedRevision":2}']],
    ['batches_ingest',{...s,operationKey:'op',items:['{"operation":"create","data":{}}']},'batches.ingest',
      ['sp_a','entries','op','["{\\"operation\\":\\"create\\",\\"data\\":{}}"]',false]],
    ['batches_status',{...s,operationKey:'op'},'batches.progress',['sp_a','entries','op']],
    ['batches_cancel',{...s,operationKey:'op'},'batches.cancel',['sp_a','entries','op']],
    ['events_list',{...s,cursor:'c1'},'events.list',['sp_a','entries','c1']],
    ['projection_status',{...s,id:'rec_1'},'events.projection',['sp_a','entries','rec_1']]
  ];
  assert.deepEqual(cases.map(([name])=>name).sort(),listed.map(tool=>tool.name).sort(),'every tool is exercised');
  for (const [tool,args,service,expected] of cases) {
    state.calls.length=0;
    const result=await second.callTool(tool,args);
    assert.equal(result.isError,undefined,`${tool}: ${result.content?.[0]?.text}`);
    assert.deepEqual(state.calls.map(call=>call.name),[service],tool);
    assert.deepEqual(state.calls[0].args,expected,tool);
    assert.deepEqual(state.calls[0].actor,agent,`${tool} uses the verified credential, never an argument`);
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent,`${tool} structured/text parity`);
  }
  const count=await first.callTool('records_count',{...s,predicates:[]});
  assert.deepEqual(count.structuredContent,{count:3});
  const receipt=await first.callTool('records_create',{...s,idempotencyKey:'k',data:{}});
  assert.equal(receipt.structuredContent.committedAt,'1970-01-01T00:00:00.000Z','results are the JSON HTTP returns');
  assert.equal((await first.readResource(guidanceUri)).contents[0].mimeType,'text/markdown');
});

test('tool errors keep the HTTP code and retryability without provider details',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  const http=createHttpHandler(state);
  t.after(()=>server.close());
  const mcp=await client(url,'owner-token');
  t.after(()=>mcp.close());
  const s={spaceId:'sp_a',collectionId:'entries'};
  const pairs=[
    [Object.assign(new Error('secret REVISION'),{code:'REVISION_CONFLICT'}),'records_replace',
      {...s,idempotencyKey:'k',id:'r',expectedRevision:1,data:{}},'POST','/records',{operation:'replace',idempotencyKey:'k',id:'r',expectedRevision:1,data:{}}],
    [Object.assign(new Error('secret'),{name:'CommitOutcomeUnknownError'}),'records_create',
      {...s,idempotencyKey:'k',data:{}},'POST','/records',{operation:'create',idempotencyKey:'k',data:{}}],
    [Object.assign(new Error('cancel secret'),{code:'57014'}),'records_query',{...s,predicates:[],limit:1},
      'POST','/records/query',{predicates:[],limit:1}],
    [Object.assign(new Error('cancel secret'),{code:'57014'}),'records_delete',
      {...s,idempotencyKey:'k',id:'r',expectedRevision:1},'POST','/records',{operation:'delete',idempotencyKey:'k',id:'r',expectedRevision:1}],
    [new Error('postgres://user:password@db'),'records_get',{...s,id:'r'},'GET','/records/r',undefined],
    [Object.assign(new Error('Query read timeout'),{}),'records_patch',
      {...s,idempotencyKey:'k',id:'r',expectedRevision:1,set:{},unset:[]},'POST','/records',
      {operation:'patch',idempotencyKey:'k',id:'r',expectedRevision:1,set:{},unset:[]}],
    [Object.assign(new Error('x'),{code:'RECEIPT_PENDING'}),'records_create',{...s,idempotencyKey:'k',data:{}},
      'POST','/records',{operation:'create',idempotencyKey:'k',data:{}}]
  ];
  for (const [error,tool,args,method,path,body] of pairs) {
    state.fail(error);
    const response=await http(new Request(`https://h.invalid/v1/spaces/sp_a/collections/entries${path}`,{method,
      headers:{authorization:'Bearer owner-token',...(body?{'content-type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined}));
    const expected=(await response.json()).error;
    const result=await mcp.callTool(tool,args);
    assert.equal(result.isError,true);
    const actual=result.structuredContent.error;
    assert.deepEqual({code:actual.code,retryable:actual.retryable},{code:expected.code,retryable:expected.retryable},tool);
    assert.equal(result.structuredContent.contractVersion,'1');
    assert.match(actual.requestId,/^[0-9a-f-]{36}$/);
    assert.doesNotMatch(result.content[0].text,/secret|password|postgres|owner-token/);
  }
  state.fail(null);
  const missing=await mcp.callTool('records_get',{...s,id:'missing'});
  assert.equal(missing.structuredContent.error.code,'NOT_FOUND');
});

test('no retryable override makes a write with an unknown outcome retryable',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  const http=createHttpHandler(state);
  t.after(()=>server.close());
  const mcp=await client(url,'owner-token');
  t.after(()=>mcp.close());
  const s={spaceId:'sp_a',collectionId:'entries'};
  const errors=[new TransportFailure('COMMIT_OUTCOME_UNKNOWN',true),
    Object.assign(new Error('x'),{code:'COMMIT_OUTCOME_UNKNOWN',retryable:true})];
  for (const error of errors) {
    state.fail(error);
    const write=await http(new Request('https://h.invalid/v1/spaces/sp_a/collections/entries/records',{method:'POST',
      headers:{authorization:'Bearer owner-token','content-type':'application/json'},
      body:JSON.stringify({operation:'create',idempotencyKey:'k',data:{}})}));
    assert.deepEqual((await write.json()).error.retryable,false,'HTTP write');
    const viaMcp=(await mcp.callTool('records_create',{...s,idempotencyKey:'k',data:{}})).structuredContent.error;
    assert.deepEqual([viaMcp.code,viaMcp.retryable],['COMMIT_OUTCOME_UNKNOWN',false],'MCP write');
    const read=(await mcp.callTool('records_get',{...s,id:'r'})).structuredContent.error;
    assert.deepEqual([read.code,read.retryable],['COMMIT_OUTCOME_UNKNOWN',true],'a read stays retryable');
  }
});

/** The published schema with its x- extensions applied as a client must. */
function publishedValidator(schema) {
  const ajv=new Ajv2020({strict:false,allErrors:true});
  ajv.addKeyword({keyword:'x-utf8MaxBytes',type:'string',validate:(limit,value)=>Buffer.byteLength(value)<=limit});
  ajv.addKeyword({keyword:'x-utf16MaxLength',type:'string',validate:(limit,value)=>value.length<=limit});
  return ajv.compile(schema);
}

test('a published selector accepts exactly the values the handler accepts',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  const mcp=await client(url,'owner-token');
  t.after(()=>mcp.close());
  const valid=publishedValidator(stateplaneMcpDeclaration().manifest().tools.find(tool=>tool.name==='records_get').inputSchema);
  // 300 astral characters are 300 code points (within maxLength) but 600 UTF-16 units.
  for (const id of ['a'.repeat(512),'a'.repeat(513),'\u{1F600}'.repeat(256),'\u{1F600}'.repeat(300),'a\0b']) {
    const args={spaceId:'sp_a',collectionId:'entries',id};
    const result=await mcp.callTool('records_get',args);
    assert.equal(valid(args),result.structuredContent.error?.code!=='INVALID_ARGUMENT',`${id.length} UTF-16 units`);
  }
});

test('bearer verification sees the request headers and signal, never a cookie',async()=>{
  const state=fixture();
  const seen=[];
  const verify=state.identity.verify;
  state.identity.verify=async request=>{ seen.push(request); return verify(request); };
  const handler=createMcpHandler({services:state.services,identity:state.identity,resource:'https://stateplane.example/mcp',
    authorizationServers:['https://auth.example']});
  const controller=new AbortController();
  const response=await handler(new Request('https://stateplane.example/mcp',{method:'POST',signal:controller.signal,
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'spaces_list',arguments:{}}}),
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'bearer owner-token',
      'mcp-protocol-version':'2025-06-18','user-agent':'probe/1','x-forwarded-for':'203.0.113.7',cookie:'authfn_session=owner-token'}}));
  assert.equal(response.status,200);
  assert.equal(seen.length,1);
  const [request]=seen;
  assert.equal(request.headers.get('authorization'),'Bearer owner-token');
  assert.equal(request.headers.get('user-agent'),'probe/1');
  assert.equal(request.headers.get('x-forwarded-for'),'203.0.113.7');
  assert.equal(request.headers.get('cookie'),null,'cookies never reach the verifier');
  assert.equal(request.signal.aborted,false);
  controller.abort();
  assert.equal(request.signal.aborted,true,'the verifier observes the request signal');
  seen.length=0;
  const cookieOnly=await handler(new Request('https://stateplane.example/mcp',{method:'POST',body:'{}',
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',cookie:'authfn_session=owner-token'}}));
  assert.equal(cookieOnly.status,401);
  assert.deepEqual(seen,[],'a cookie-only request never authenticates');
});

test('authorization precedes argument shape, and selectors are validated locally',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  const mcp=await client(url,'owner-token');
  t.after(()=>mcp.close());
  const s={spaceId:'sp_a',collectionId:'entries'};
  // An undeclared mutation field still reaches the authority, which owns the
  // authorization-before-envelope ordering; a revoked caller sees FORBIDDEN.
  state.fail(Object.assign(new Error(),{code:'FORBIDDEN'}));
  const revoked=await mcp.callTool('records_create',{...s,idempotencyKey:'k',data:{},unexpected:true});
  assert.equal(revoked.structuredContent.error.code,'FORBIDDEN');
  assert.equal(state.calls.at(-1).args[2],'{"operation":"create","idempotencyKey":"k","data":{},"unexpected":true}');
  state.fail(Object.assign(new Error(),{code:'INVALID_ARGUMENT'}));
  const shaped=await mcp.callTool('records_create',{...s,idempotencyKey:'k',data:{},unexpected:true});
  assert.equal(shaped.structuredContent.error.code,'INVALID_ARGUMENT');
  assert.deepEqual(shaped.structuredContent.error.issues,[{instancePath:'/',keyword:'additionalProperties',rejectedProperty:'unexpected'}]);
  state.fail(null);
  state.calls.length=0;
  for (const [tool,args,code] of [
    ['records_create',{...s,operation:'delete',idempotencyKey:'k',data:{}},'INVALID_ARGUMENT'],
    ['records_get',{...s,id:''},'INVALID_ARGUMENT'],
    ['records_get',{...s,id:'a\u0000b'},'INVALID_ARGUMENT'],
    ['records_get',{...s,id:'x'.repeat(513)},'INVALID_ARGUMENT'],
    ['records_get',{spaceId:'sp_a',id:'r'},'INVALID_ARGUMENT'],
    ['records_get',{...s,id:'r',extra:1},'INVALID_ARGUMENT'],
    ['records_get_by_key',{...s,mode:'other',key:'k'},'INVALID_ARGUMENT'],
    ['spaces_list',{cursor:null},'CURSOR_INVALID'],
    ['events_list',{...s,cursor:5},'CURSOR_INVALID'],
    ['collections_revise',{...s,expectedVersion:1.5,definition:{}},'INVALID_ARGUMENT'],
    ['batches_ingest',{...s,operationKey:'op',items:[],retryFailed:'true'},'INVALID_ARGUMENT'],
    ['records_count',{...s},'INVALID_ARGUMENT']
  ]) {
    const result=await mcp.callTool(tool,args);
    assert.equal(result.structuredContent?.error?.code,code,`${tool} ${JSON.stringify(args).slice(0,60)}`);
    assert.equal(result.structuredContent.error.retryable,false);
  }
  assert.deepEqual(state.calls,[],'locally rejected selectors never reach a service');
  const astral='😀'.repeat(257);
  assert.equal((await mcp.callTool('records_get',{...s,id:astral})).structuredContent.error.code,'INVALID_ARGUMENT',
    'selectors use the HTTP 512 UTF-16 code-unit bound');
  const oversized=await mcp.callTool('records_create',{...s,idempotencyKey:'k',data:{text:'x'.repeat(1_048_576)}});
  assert.deepEqual([oversized.structuredContent.error.code,oversized.structuredContent.error.retryable],['RATE_LIMITED',false]);
  assert.deepEqual(state.calls,[]);
});

test('argument re-encoding preserves values that JSON.stringify would alias',()=>{
  assert.equal(serializeJson(JSON.parse('{"a":1e400,"b":-1e400,"c":-0,"d":0.1,"e":"\\ud800"}')),
    '{"a":1e400,"b":-1e400,"c":-0,"d":0.1,"e":"\\ud800"}');
  const proto=JSON.parse('{"__proto__":{"x":1},"y":[null,true]}');
  assert.equal(serializeJson(proto),'{"__proto__":{"x":1},"y":[null,true]}');
  assert.deepEqual(JSON.parse(serializeJson({n:Infinity})),{n:Infinity});
  assert.throws(()=>serializeJson({n:NaN}));
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>serializeJson(cyclic));
});

test('literal JSON numbers reach the services exactly as an HTTP body would',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  const message={jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'records_create',arguments:{spaceId:'sp_a',
    collectionId:'entries',idempotencyKey:'k',data:{big:Infinity,zero:-0}}}};
  const raw=JSON.stringify(message).replace('"big":null','"big":1e400').replace('"zero":0','"zero":-0');
  const response=await post(url,raw);
  assert.equal(response.status,200);
  assert.equal(state.calls.at(-1).args[2],'{"operation":"create","idempotencyKey":"k","data":{"big":1e400,"zero":-0}}');
  const proto=await post(url,'{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"records_create","arguments":'+
    '{"spaceId":"sp_a","collectionId":"entries","idempotencyKey":"k","data":{"__proto__":{"admin":true}}}}}');
  assert.equal(proto.status,200);
  assert.equal(state.calls.at(-1).args[2],'{"operation":"create","idempotencyKey":"k","data":{"__proto__":{"admin":true}}}');
});

test('the endpoint is an OAuth protected resource over bearer credentials only',async t=>{
  const state=fixture();
  const {server,base,url}=await mcpServer(state);
  t.after(()=>server.close());
  const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},
    clientInfo:{name:'probe',version:'1'}}};
  const metadataUrl=`${base}/.well-known/oauth-protected-resource/mcp`;
  const metadata=await fetch(metadataUrl);
  assert.equal(metadata.status,200);
  assert.deepEqual(await metadata.json(),{resource:url,authorization_servers:['http://127.0.0.1:9'],
    bearer_methods_supported:['header'],resource_name:'Stateplane'});
  for (const headers of [{authorization:''},{authorization:'Bearer wrong'},{authorization:'',cookie:'authfn_session=owner-token'},
    {authorization:'Basic b3duZXI6dG9rZW4='}]) {
    const response=await post(url,initialize,headers);
    assert.equal(response.status,401,JSON.stringify(headers));
    assert.match(response.headers.get('www-authenticate'),new RegExp(`^Bearer resource_metadata="${metadataUrl}"`));
  }
  const query=await post(`${url}?access_token=owner-token`,initialize,{authorization:''});
  assert.equal(query.status,401,'query-string tokens are never accepted');
  state.providerDown(true);
  const unavailable=await post(url,initialize);
  assert.equal(unavailable.status,503);
  assert.doesNotMatch(await unavailable.text(),/owner-token|provider failure/);
  state.providerDown(false);
  assert.equal((await post(url,initialize)).status,200);
  assert.equal((await post(url,initialize,{origin:'https://evil.example'})).status,403,'a foreign browser origin is a DNS-rebinding probe');
  assert.equal((await post(url,initialize,{origin:base})).status,200,'the resource origin itself is valid');
  for (const origin of ['null',`${base}.evil.example`,'not a url'])
    assert.equal((await post(url,initialize,{origin})).status,403,origin);
  assert.equal((await fetch(url,{headers:{authorization:'Bearer owner-token',accept:'text/event-stream'}})).status,405);
  assert.equal((await fetch(`${base}/other`,{method:'POST'})).status,404);
});

test('API-key revocation passes the McpFn transport regression suite',async t=>{
  const state=fixture();
  const keys=new Set();
  let counter=0;
  state.identity.verify=async request=>{
    const token=request.headers.get('authorization')?.slice(7);
    return keys.has(token)?{kind:'api-key',credentialId:token}:null;
  };
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  await assertAuthRegressionSuite({kind:'api-key',target:createFetchAuthTarget({url}),
    invalidCredentialHeaders:{authorization:'Bearer invalid-key'},
    provider:{capabilities:{revocation:true},
      async issue() { const key=`key-${++counter}`; keys.add(key); return bearerCredential(key); },
      async revoke(credential) { keys.delete(new Headers(credential.headers).get('authorization').slice(7)); }}});
});

test('bounded single-message requests and post-dispatch deadlines classify reads and writes',async t=>{
  const state=fixture();
  let timeouts=0;
  const {server,url}=await mcpServer(state,{requestTimeoutMs:50,onTimeout:()=>{timeouts++;}});
  t.after(()=>server.close());
  const call=(name,args,id=1)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
  const batched=await post(url,[call('spaces_list',{}),call('spaces_list',{},2)]);
  assert.equal(batched.status,400);
  const tooLarge=await post(url,'{"x":"'+'a'.repeat(maxRequestBytes)+'"}');
  assert.equal(tooLarge.status,413);
  assert.deepEqual((await tooLarge.json()).error.data.error.code,'RATE_LIMITED');
  const release=state.hold();
  const write=await (await post(url,call('records_create',{spaceId:'sp_a',collectionId:'entries',idempotencyKey:'k',data:{}},3))).json();
  assert.equal(write.id,3);
  assert.deepEqual([write.result.isError,write.result.structuredContent.error.code,write.result.structuredContent.error.retryable],
    [true,'COMMIT_OUTCOME_UNKNOWN',false]);
  assert.match(write.result.structuredContent.error.message,/same idempotencyKey/);
  const read=await (await post(url,call('records_get',{spaceId:'sp_a',collectionId:'entries',id:'r'},4))).json();
  assert.deepEqual([read.result.structuredContent.error.code,read.result.structuredContent.error.retryable],['PROVIDER_UNAVAILABLE',true]);
  const batch=await (await post(url,call('batches_ingest',{spaceId:'sp_a',collectionId:'entries',operationKey:'op',items:['{}']},5))).json();
  assert.equal(batch.result.structuredContent.error.code,'COMMIT_OUTCOME_UNKNOWN');
  assert.match(batch.result.structuredContent.error.message,/operationKey/);
  assert.doesNotMatch(batch.result.structuredContent.error.message,/idempotency/i);
  assert.equal(timeouts,3);
  assert.deepEqual(state.calls.map(call=>call.name),['records.mutate','records.get','batches.ingest'],
    'each dispatched call reached its service exactly once');
  release();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(state.calls.length,3,'the deadline never re-dispatches');
});

/** Calls the endpoint directly so a body or verification can stay unfinished. */
function direct(state,onTimeout) {
  const handler=createMcpHandler({services:state.services,identity:state.identity,resource:'https://stateplane.example/mcp',
    authorizationServers:['https://auth.example'],requestTimeoutMs:50,onTimeout});
  return (body,headers={})=>handler(new Request('https://stateplane.example/mcp',{method:'POST',body,duplex:'half',
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer owner-token',
      'mcp-protocol-version':'2025-06-18',...headers}}));
}
const bounded=(promise,label)=>Promise.race([promise,new Promise((_,reject)=>
  setTimeout(()=>reject(new Error(`${label} is unbounded`)),2_000))]);
const writeCall=JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'records_create',
  arguments:{spaceId:'sp_a',collectionId:'entries',idempotencyKey:'k',data:{}}}});
async function assertRetryableBeforeDispatch(response) {
  assert.equal(response.status,503);
  assert.equal(response.headers.get('retry-after'),'1');
  const body=await response.json();
  assert.equal(body.error.message,'PROVIDER_UNAVAILABLE');
  assert.deepEqual([body.error.data.error.code,body.error.data.error.retryable],['PROVIDER_UNAVAILABLE',true]);
}

test('one deadline bounds a stalled bearer verification and nothing dispatches later',async()=>{
  const state=fixture();
  let timeouts=0;
  let finish;
  const verify=state.identity.verify;
  state.identity.verify=request=>new Promise(resolve=>{finish=()=>resolve(verify(request));});
  const response=await bounded(direct(state,()=>{timeouts++;})(writeCall),'bearer verification');
  await assertRetryableBeforeDispatch(response);
  assert.equal(timeouts,1);
  finish();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(state.calls,[],'a late verification never reaches a service');
});

test('one deadline bounds an unfinished request body, cancels it and never dispatches',async()=>{
  const state=fixture();
  let timeouts=0;
  let cancelled=false;
  let controller;
  const body=new ReadableStream({start(c) { controller=c; c.enqueue(new TextEncoder().encode(writeCall.slice(0,40))); },
    cancel() { cancelled=true; }});
  const response=await bounded(direct(state,()=>{timeouts++;})(body),'body ingestion');
  await assertRetryableBeforeDispatch(response);
  assert.equal(timeouts,1);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(cancelled,true,'the body reader is cancelled');
  assert.throws(()=>controller.enqueue(new TextEncoder().encode(writeCall.slice(40))));
  assert.deepEqual(state.calls,[]);
});

test('a throwing timeout callback still delivers the deadline response',async()=>{
  const state=fixture();
  state.identity.verify=()=>new Promise(()=>{});
  const response=await bounded(direct(state,()=>{ throw new Error('pool already ended'); })(writeCall),'deadline response');
  await assertRetryableBeforeDispatch(response);
});

test('a body declared over the limit is cancelled unread',async()=>{
  const state=fixture();
  let cancelled=false;
  const body=new ReadableStream({cancel() { cancelled=true; }});
  const response=await direct(state)(body,{'content-length':String(2**30)});
  assert.equal(response.status,413);
  assert.equal(cancelled,true,'the declared-oversize body stream is cancelled');
  assert.deepEqual(state.calls,[]);
});

test('one endpoint serves concurrent requests with their own services and credentials',async()=>{
  const endpoint=createMcpEndpoint({resource:'https://stateplane.example/mcp',authorizationServers:['https://auth.example']});
  const a=fixture();
  const b=fixture();
  b.identity.verify=async request=>request.headers.get('authorization')==='Bearer agent-token'?agent:null;
  const releaseA=a.hold();
  const message=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'records_count',
    arguments:{spaceId:'sp_a',collectionId:'entries',predicates:[]}}});
  const request=token=>new Request('https://stateplane.example/mcp',{method:'POST',body:message,
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${token}`,
      'mcp-protocol-version':'2025-06-18'}});
  // Equal JSON-RPC IDs: the first request is still in its service call.
  const first=endpoint(request('owner-token'),a);
  await new Promise(resolve=>setTimeout(resolve,10));
  const second=await (await endpoint(request('agent-token'),b)).json();
  releaseA();
  const firstBody=await (await first).json();
  assert.deepEqual([firstBody.id,firstBody.result.structuredContent],[1,{count:3}]);
  assert.deepEqual([second.id,second.result.structuredContent],[1,{count:3}]);
  assert.deepEqual(a.calls.map(call=>call.actor),[owner],'each request uses its own services');
  assert.deepEqual(b.calls.map(call=>call.actor),[agent]);
  const denied=await endpoint(request('owner-token'),b);
  assert.equal(denied.status,401,'each request uses its own identity verifier');
  assert.equal(b.calls.length,1);
});

test('recovery guidance matches each write tool schema',async()=>{
  const manifest=stateplaneMcpDeclaration().manifest();
  const writes=tools.filter(tool=>!tool.read);
  assert.ok(writes.length>0);
  for (const tool of writes) {
    const keyed=Object.hasOwn(manifest.tools.find(item=>item.name===tool.name).inputSchema.properties,'idempotencyKey');
    assert.equal(keyed,tool.name.startsWith('records_'),`${tool.name}: only record mutations take idempotencyKey`);
    assert.ok(tool.recovery,`${tool.name} names its COMMIT_OUTCOME_UNKNOWN recovery`);
    assert.equal(/idempotencyKey/.test(tool.recovery),keyed,`${tool.name} recovery matches its schema`);
    if (tool.name.startsWith('batches_')) assert.match(tool.recovery,/batches_status/);
    if (tool.name.startsWith('collections_')) assert.match(tool.recovery,/collections_get/);
  }
  // Every sentence that requires an idempotencyKey names only keyed tools.
  for (const text of [instructions,guidance]) {
    assert.doesNotMatch(text,/every write (needs|takes) an idempotencyKey/i);
    for (const sentence of text.split(/(?<=\.)\s+|\n/).filter(item=>/idempotencyKey/.test(item) && !/no idempotencyKey/.test(item)))
      for (const name of sentence.match(/\b(collections|batches)_[a-z]+/g)??[])
        assert.fail(`${name} is described as keyed: ${sentence}`);
  }
  assert.match(guidance,/batches_status/);
  assert.match(guidance,/collections_get/);
});

test('a deployed resource accepts only its own or an allowlisted browser origin',async()=>{
  const state=fixture();
  const handler=createMcpHandler({services:state.services,identity:state.identity,resource:'https://stateplane.example/mcp',
    authorizationServers:['https://auth.example'],allowedOrigins:['https://console.example/']});
  const initialize=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',
    capabilities:{},clientInfo:{name:'probe',version:'1'}}});
  const status=async origin=>(await handler(new Request('https://stateplane.example/mcp',{method:'POST',body:initialize,
    headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
      authorization:'Bearer owner-token',...(origin?{origin}:{})}}))).status;
  assert.equal(await status(),200,'non-browser clients send no Origin');
  assert.equal(await status('https://stateplane.example'),200);
  assert.equal(await status('https://console.example'),200);
  for (const origin of ['http://127.0.0.1:8787','http://localhost','https://stateplane.example.evil','null'])
    assert.equal(await status(origin),403,origin);
  const metadata=await handler(new Request('https://stateplane.example/.well-known/oauth-protected-resource/mcp'));
  assert.deepEqual((await metadata.json()).authorization_servers,['https://auth.example']);
  assert.throws(()=>createMcpHandler({services:state.services,identity:state.identity,resource:'https://stateplane.example/mcp',
    authorizationServers:['http://auth.example']}),/HTTPS/,'a deployed issuer must use HTTPS');
});

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
import { createSchemaCompiler, diffManifests } from '@mcpfn/core';
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
    events:{list:record('events.list',{events:[],nextCursor:'c'}),projection:record('events.projection',{state:'pending',generation:1})},
    sources:{get:record('sources.get',{sourceId:'src_1'}),
      content:record('sources.content',(_a,_s,_c,id)=>id==='src_ref'?{source:{sourceId:id,original:{referenceOnly:true,byteSize:null}},body:null}:
        {source:{sourceId:id,original:{referenceOnly:false,byteSize:id==='src_big'?2_097_153:3}},body:new Blob([id==='src_big'?'':'abc']).stream()}),
      ingestText:record('sources.ingestText',{sourceId:'src_1'}),ingestReference:record('sources.ingestReference',{sourceId:'src_2'}),
      createUpload:record('sources.createUpload',{grantId:'upl_1'}),
      upload:record('sources.upload',async(_a,_s,_c,grantId,body,declared)=>({grantId,declared,
        received:Buffer.from(await new Response(body).arrayBuffer()).toString()})),
      finalizeUpload:record('sources.finalizeUpload',{sourceId:'src_3'}),revokeUpload:record('sources.revokeUpload',{grantId:'upl_1'}),
      delete:record('sources.delete',{sourceId:'src_1'}),extract:record('sources.extract',{version:1}),
      correctExtraction:record('sources.correctExtraction',{version:2}),extraction:record('sources.extraction',{version:1})},
    claims:{create:record('claims.create',{claimId:'clm_1'}),revise:record('claims.revise',{revision:2}),
      review:record('claims.review',{revision:3}),delete:record('claims.delete',{claimId:'clm_1'}),
      get:record('claims.get',{claimId:'clm_1'}),list:record('claims.list',{claims:[],next:null})},
    links:{create:record('links.create',{linkId:'lnk_1'}),get:record('links.get',{linkId:'lnk_1'}),
      delete:record('links.delete',{linkId:'lnk_1'}),list:record('links.list',{links:[],next:null})},
    retrieval:{search:record('retrieval.search',{results:[],complete:false}),
      bundle:record('retrieval.bundle',{context:'<stateplane-context trust="untrusted" complete="false"></stateplane-context>',
        excerpts:[{n:1,ref:{id:'rec_1'}}],complete:false}),
      status:record('retrieval.status',{state:'current',rebuild:null})},
    analysis:{aggregate:record('analysis.aggregate',{groups:[],complete:true}),submit:record('analysis.submit',{jobId:'anj_1',state:'queued'}),
      status:record('analysis.status',{jobId:'anj_1',state:'running'}),cancel:record('analysis.cancel',{jobId:'anj_1',state:'cancelled'}),
      page:record('analysis.page',{jobId:'anj_1',complete:true})}
  };
  services.spaces.erasure=record('spaces.erasure',{spaceId:'sp_a',database:'pending',originalBytes:'pending',backups:'retained'});
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
  assert.equal(names.length,50,'the registry is fixed; a new tool is a reviewed contract change');
  for (const tool of manifest.tools) {
    const own=tools.find(item=>item.name===tool.name);
    assert.equal(tool.annotations.readOnlyHint,own.read,`${tool.name} read annotation matches its error mapping`);
    assert.equal(tool.annotations.openWorldHint,false);
    assert.equal(tool.inputSchema.additionalProperties,false);
    if (own.read) assert.equal(tool.annotations.destructiveHint,false);
  }
  for (const name of ['records_replace','records_patch','records_delete','batches_ingest','batches_cancel',
    'sources_delete','uploads_revoke','claims_delete','links_delete','analysis_cancel'])
    assert.equal(manifest.tools.find(tool=>tool.name===name).annotations.destructiveHint,true,name);
  // Each call issues a new grant or attempt, so an identical repeat is not free of effects.
  for (const name of names) assert.equal(manifest.tools.find(tool=>tool.name===name).annotations.idempotentHint,
    !['uploads_create','uploads_send','analysis_submit'].includes(name),name);
  assert.ok(!names.some(name=>/entries|collection_[a-z]/.test(name)),'no tool is named after a collection');
  assert.equal(manifest.resources[0].uri,guidanceUri);
  assert.match(manifest.server.instructions,/untrusted data/);
  assert.match(manifest.server.instructions,/claims/);
  const compatibility=checkHostCompatibility(manifest,MCPFN_HOST_PROFILES.toolsOnly);
  assert.notEqual(compatibility.status,'incompatible');
});

// Drops prose only: SchemaNode also declares a `description` keyword whose value is a schema.
const strip=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='description'&&typeof item==='string'?undefined:item));
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
    // Every keyword, x- extensions included, matches; only prose may differ.
    assert.deepEqual(strip(mcp.properties.idempotencyKey),strip(http.properties.idempotencyKey),operation);
    if (operation==='create') {
      // OpenAPI applies its externalKey byte budget after NFC and trim; MCP names that rule explicitly.
      const {'x-utf8MaxBytes':budget,...rest}=strip(http.properties.externalKey);
      assert.deepEqual(strip(mcp.properties.externalKey),{...rest,'x-nfcTrimmedUtf8MaxBytes':budget});
    }
  }
  const predicate=input('records_query').properties.predicates.items;
  const published=document.components.schemas.Predicate;
  assert.equal(predicate.oneOf.length,published.oneOf.length);
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

test('both definition tools publish the OpenAPI CollectionDefinition with a closed recursive SchemaNode',async()=>{
  const {schemas}=YAML.parse(await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8')).components;
  // The OpenAPI component reference becomes the tool-local one; nothing else is renamed.
  const local=value=>JSON.parse(JSON.stringify(strip(value)).replaceAll('"#/components/schemas/SchemaNode"','"#/$defs/schemaNode"'));
  const expected=local(schemas.CollectionDefinition);
  expected.properties.schema=local(schemas.SchemaRoot);
  // The authority admits only safe-integer versions, which MCP publishes as a bound.
  expected.properties.version.maximum=Number.MAX_SAFE_INTEGER;
  const manifest=stateplaneMcpDeclaration().manifest();
  for (const name of ['collections_define','collections_revise']) {
    const {inputSchema}=manifest.tools.find(tool=>tool.name===name);
    assert.deepEqual(strip(inputSchema.properties.definition),expected,name);
    assert.deepEqual(Object.keys(inputSchema.$defs),['schemaNode'],name);
    assert.deepEqual(strip(inputSchema.$defs.schemaNode),local(schemas.SchemaNode),name);
  }
  assert.deepEqual(Object.keys(schemas.SchemaNode.properties).sort(),
    ['$schema','additionalProperties','description','enum','format','items','maxItems','maxLength','maximum',
      'minItems','minLength','minimum','properties','required','type'],'the 15 keywords the authority admits');
  assert.ok(manifest.tools.filter(tool=>tool.inputSchema.$defs).every(tool=>tool.name.startsWith('collections_')));
});

test('the Node and Worker schema engines compile every tool and agree on definition schemas',()=>{
  const root={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false};
  const field=node=>({...root,properties:{extra:node}});
  const cases=[
    [{...root,$ref:'#'},false],[{...root,allOf:[{type:'object'}]},false],[{...root,patternProperties:{}},false],
    [field({type:'object',properties:{}}),false],[field({type:'array'}),false],
    [field({type:'string',oneOf:[{type:'string'}]}),false],[field({type:'array',items:{$ref:'#'}}),false],
    [field({type:'object',additionalProperties:false,required:['tag'],properties:{tag:{type:'string',enum:['a']},
      at:{type:'string',format:'date-time'},score:{type:['integer','null'],minimum:0,maximum:9},
      tags:{type:'array',maxItems:3,items:{type:'string',maxLength:8}}}}),true]
  ];
  // McpFn validates with Ajv in Node and with @cfworker/json-schema in a Worker.
  for (const engine of ['ajv','cfworker']) {
    const compiler=createSchemaCompiler(engine);
    for (const tool of stateplaneMcpDeclaration().manifest().tools) {
      const validate=compiler.compile(tool.inputSchema);
      if (!['collections_define','collections_revise'].includes(tool.name)) continue;
      for (const [index,[schema,valid]] of cases.entries())
        assert.equal(validate({spaceId:'sp_a',collectionId:'c',...tool.name==='collections_revise'?{expectedVersion:1}:{},
          definition:{slug:'c',version:1,schema,unique:[],filterable:[],sortable:[]}}),valid,`${engine} ${tool.name} case ${index}`);
    }
  }
});

/** Every published x- extension as `tool pointer=value`, duplicates kept. */
const extensions=manifest=>{
  const found=[];
  const walk=(node,tool,pointer)=>{
    if (!node || typeof node!=='object') return;
    for (const [key,item] of Object.entries(node)) {
      const path=`${pointer}/${key.replaceAll('~','~0').replaceAll('/','~1')}`;
      if (key.startsWith('x-')) found.push(`${tool} ${path}=${item}`);
      else walk(item,tool,path);
    }
  };
  for (const tool of manifest.tools) walk(tool.inputSchema,tool.name,'');
  return found.sort();
};
test('every published x- extension is checked against OpenAPI or the authority',()=>{
  const manifest=stateplaneMcpDeclaration().manifest();
  const names=manifest.tools.map(tool=>tool.name);
  const expected=[];
  const each=(tools,pointer,value)=>{ for (const tool of tools) expected.push(`${tool} ${pointer}=${value}`); };
  // Authority parity: the selector test below and test/integration/mcp-services.test.js.
  each(names.filter(name=>name!=='spaces_list'),'/properties/spaceId/x-utf16MaxLength',512);
  // Search and bundles take a space; their collections filter is a body field, as over HTTP.
  each(names.filter(name=>!['spaces_list','spaces_get','spaces_erasure','collections_list','retrieval_search','retrieval_bundle']
    .includes(name)),'/properties/collectionId/x-utf16MaxLength',512);
  // Evidence selectors are HTTP path segments, like record IDs.
  each(names.filter(name=>name.startsWith('sources_') && !name.startsWith('sources_ingest')),'/properties/sourceId/x-utf16MaxLength',512);
  each(['uploads_send','uploads_finalize','uploads_revoke'],'/properties/grantId/x-utf16MaxLength',512);
  each(['claims_revise','claims_review','claims_delete','claims_get'],'/properties/claimId/x-utf16MaxLength',512);
  each(['links_get','links_delete'],'/properties/linkId/x-utf16MaxLength',512);
  each(['records_get','projection_status'],'/properties/id/x-utf16MaxLength',512);
  each(['records_get_by_key'],'/properties/key/x-utf16MaxLength',512);
  each(['batches_ingest','batches_status','batches_cancel'],'/properties/operationKey/x-utf8MaxBytes',256);
  // OpenAPI parity above; predicate string and instant values in scalar and `in` form.
  each(['records_create','records_replace','records_patch','records_delete'],'/properties/idempotencyKey/x-utf8MaxBytes',256);
  each(['records_create'],'/properties/externalKey/x-nfcTrimmedUtf8MaxBytes',256);
  for (const variant of ['1/properties/value','2/properties/value/items','7/properties/value','8/properties/value/items']) {
    each(['records_query','records_count'],`/properties/predicates/items/oneOf/${variant}/x-utf8MaxBytes`,512);
    // An aggregation's where takes the same predicates, directly or inside a job request's spec.
    each(['analysis_aggregate'],`/properties/where/items/oneOf/${variant}/x-utf8MaxBytes`,512);
    each(['analysis_submit'],`/properties/spec/properties/where/items/oneOf/${variant}/x-utf8MaxBytes`,512);
  }
  each(['analysis_status','analysis_cancel','analysis_page'],'/properties/jobId/x-utf16MaxLength',512);
  assert.deepEqual(extensions(manifest),expected.sort(),'a new extension needs a parity check');
  // Each mutation repeats a name, key and value published elsewhere, so only the tool and pointer reveal it.
  const mutate=change=>{ const copy=structuredClone(manifest); change(name=>copy.tools.find(tool=>tool.name===name).inputSchema); return extensions(copy); };
  for (const change of [
    input=>{ input('records_query').properties.predicates.items.oneOf[3].properties.value['x-utf8MaxBytes']=512; },
    input=>{ delete input('records_count').properties.predicates.items.oneOf[8].properties.value.items['x-utf8MaxBytes']; },
    input=>{ delete input('records_get').properties.id['x-utf16MaxLength']; }
  ]) assert.notDeepEqual(mutate(change),expected);
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
    ['projection_status',{...s,id:'rec_1'},'events.projection',['sp_a','entries','rec_1']],
    ['spaces_erasure',{spaceId:'sp_a'},'spaces.erasure',['sp_a']],
    ['sources_get',{...s,sourceId:'src_1'},'sources.get',['sp_a','entries','src_1']],
    ['sources_content',{...s,sourceId:'src_1'},'sources.content',['sp_a','entries','src_1']],
    ['sources_ingest_text',{...s,idempotencyKey:'k',text:'Hello'},'sources.ingestText',['sp_a','entries',{idempotencyKey:'k',text:'Hello'}]],
    ['sources_ingest_reference',{...s,idempotencyKey:'k',locator:'https://example.invalid/a'},'sources.ingestReference',
      ['sp_a','entries',{idempotencyKey:'k',locator:'https://example.invalid/a'}]],
    ['sources_delete',{...s,sourceId:'src_1'},'sources.delete',['sp_a','entries','src_1']],
    ['sources_extract',{...s,sourceId:'src_1'},'sources.extract',['sp_a','entries','src_1']],
    ['sources_extraction',{...s,sourceId:'src_1',version:2},'sources.extraction',['sp_a','entries','src_1',2]],
    ['sources_correct_extraction',{...s,sourceId:'src_1',baseVersion:1,content:'A',sourceOffsets:[]},'sources.correctExtraction',
      ['sp_a','entries','src_1',{baseVersion:1,content:'A',sourceOffsets:[]}]],
    ['uploads_create',{...s,mimeType:'text/plain',maxBytes:3},'sources.createUpload',['sp_a','entries',{mimeType:'text/plain',maxBytes:3}]],
    ['uploads_send',{...s,grantId:'upl_1',mimeType:'text/plain',contentBase64:'YWJj'},'sources.upload',
      ['sp_a','entries','upl_1',undefined,{bytes:3,mimeType:'text/plain'}]],
    ['uploads_finalize',{...s,grantId:'upl_1',attemptId:'att_1'},'sources.finalizeUpload',['sp_a','entries','upl_1',{attemptId:'att_1'}]],
    ['uploads_revoke',{...s,grantId:'upl_1'},'sources.revokeUpload',['sp_a','entries','upl_1']],
    ['claims_create',{...s,idempotencyKey:'k',statement:'S',attributedTo:'A'},'claims.create',
      ['sp_a','entries',{idempotencyKey:'k',statement:'S',attributedTo:'A'}]],
    ['claims_revise',{...s,claimId:'clm_1',baseRevision:1,statement:'S',attributedTo:'A'},'claims.revise',
      ['sp_a','entries','clm_1',{baseRevision:1,statement:'S',attributedTo:'A'}]],
    ['claims_review',{...s,claimId:'clm_1',baseRevision:2,status:'accepted'},'claims.review',
      ['sp_a','entries','clm_1',{baseRevision:2,status:'accepted'}]],
    ['claims_delete',{...s,claimId:'clm_1',baseRevision:3},'claims.delete',['sp_a','entries','clm_1',{baseRevision:3}]],
    ['claims_get',{...s,claimId:'clm_1'},'claims.get',['sp_a','entries','clm_1',undefined]],
    ['claims_list',{...s,status:'accepted',limit:5},'claims.list',['sp_a','entries',{status:'accepted',limit:5}]],
    ['links_create',{...s,idempotencyKey:'k',type:'cites',policy:'detach',from:{kind:'record',collectionId:'entries',id:'r'},
      to:{kind:'source',collectionId:'entries',id:'src_1'}},'links.create',['sp_a','entries',{idempotencyKey:'k',type:'cites',
      policy:'detach',from:{kind:'record',collectionId:'entries',id:'r'},to:{kind:'source',collectionId:'entries',id:'src_1'}}]],
    ['links_get',{...s,linkId:'lnk_1'},'links.get',['sp_a','entries','lnk_1']],
    ['links_list',{...s,endpoint:{kind:'record',id:'r'}},'links.list',['sp_a','entries',{endpoint:{kind:'record',id:'r'}}]],
    ['links_delete',{...s,linkId:'lnk_1'},'links.delete',['sp_a','entries','lnk_1']],
    ['retrieval_search',{spaceId:'sp_a',query:'fog',collections:['entries'],kinds:['record'],limit:3},'retrieval.search',
      ['sp_a',{query:'fog',collections:['entries'],kinds:['record'],limit:3}]],
    ['retrieval_bundle',{spaceId:'sp_a',task:'Summarize fog',budget:{bytes:2048}},'retrieval.bundle',
      ['sp_a',{task:'Summarize fog',budget:{bytes:2048}}]],
    ['retrieval_status',s,'retrieval.status',['sp_a','entries']],
    ['analysis_aggregate',{...s,groupBy:[{field:'team'}],metrics:[{op:'count'}]},'analysis.aggregate',
      ['sp_a','entries','{"groupBy":[{"field":"team"}],"metrics":[{"op":"count"}]}']],
    ['analysis_submit',{...s,kind:'aggregate',spec:{metrics:[{op:'count'}]}},'analysis.submit',
      ['sp_a','entries','aggregate','{"metrics":[{"op":"count"}]}']],
    ['analysis_status',{...s,jobId:'anj_1'},'analysis.status',['sp_a','entries','anj_1']],
    ['analysis_cancel',{...s,jobId:'anj_1'},'analysis.cancel',['sp_a','entries','anj_1']],
    ['analysis_page',{...s,jobId:'anj_1',page:2},'analysis.page',['sp_a','entries','anj_1',2]]
  ];
  assert.deepEqual(cases.map(([name])=>name).sort(),listed.map(tool=>tool.name).sort(),'every tool is exercised');
  for (const [tool,args,service,expected] of cases) {
    state.calls.length=0;
    const result=await second.callTool(tool,args);
    assert.equal(result.isError,undefined,`${tool}: ${result.content?.[0]?.text}`);
    assert.deepEqual(state.calls.map(call=>call.name),[service],tool);
    // An upload's body is a stream; the fixture reports what it received instead.
    assert.deepEqual(state.calls[0].args.map(arg=>arg instanceof ReadableStream?undefined:arg),expected,tool);
    assert.deepEqual(state.calls[0].actor,agent,`${tool} uses the verified credential, never an argument`);
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent,`${tool} structured/text parity`);
  }
  // Only the frame reaches a model over MCP; the unescaped excerpt metadata stays with HTTP and CLI callers.
  const bundle=await first.callTool('retrieval_bundle',{spaceId:'sp_a',query:'fog',budget:{tokens:1024}});
  assert.deepEqual(bundle.structuredContent,{context:'<stateplane-context trust="untrusted" complete="false"></stateplane-context>',
    complete:false});
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
function direct(state,onTimeout,requestTimeoutMs=50) {
  const handler=createMcpHandler({services:state.services,identity:state.identity,resource:'https://stateplane.example/mcp',
    authorizationServers:['https://auth.example'],requestTimeoutMs,onTimeout});
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

/** Records unhandled rejections raised while fn runs and shortly after. */
async function unhandledDuring(fn) {
  const seen=[];
  const listener=reason=>{ seen.push(reason); };
  process.on('unhandledRejection',listener);
  try { await fn(); await new Promise(resolve=>setTimeout(resolve,30)); }
  finally { process.off('unhandledRejection',listener); }
  return seen;
}

test('a failing timeout callback, sync or async, never delays the deadline response or leaks a rejection',async()=>{
  for (const [label,onTimeout] of [['sync',()=>{ throw new Error('pool already ended'); }],
    ['async',async()=>{ throw new Error('pool already ended'); }]]) {
    const state=fixture();
    state.identity.verify=()=>new Promise(()=>{});
    const leaked=await unhandledDuring(async()=>{
      await assertRetryableBeforeDispatch(await bounded(direct(state,onTimeout)(writeCall),`${label} deadline response`));
    });
    assert.deepEqual(leaked,[],`${label} callback failure is contained`);
  }
});

test('an oversized body answers 413 at once whatever its cancellation does',async()=>{
  const cancels={'never settles':()=>new Promise(()=>{}),rejects:()=>Promise.reject(new Error('source gone'))};
  for (const declared of [true,false])
    for (const [label,cancel] of Object.entries(cancels))
      for (const timeoutMs of [0,50]) {
        const name=`${declared?'declared':'streamed'} overflow, cancel ${label}, deadline ${timeoutMs}`;
        const state=fixture();
        let cancelled=false;
        let timeouts=0;
        const body=new ReadableStream({
          start(controller) { if (!declared) controller.enqueue(new Uint8Array(maxRequestBytes+1)); },
          cancel() { cancelled=true; return cancel(); }});
        const leaked=await unhandledDuring(async()=>{
          const response=await bounded(direct(state,()=>{timeouts++;},timeoutMs)(body,
            declared?{'content-length':String(2**30)}:{}),name);
          assert.equal(response.status,413,name);
          assert.equal((await response.json()).error.data.error.code,'RATE_LIMITED',name);
        });
        assert.equal(cancelled,true,`${name}: the body is cancelled`);
        assert.equal(timeouts,0,`${name}: the deadline never answers`);
        assert.deepEqual(state.calls,[],name);
        assert.deepEqual(leaked,[],`${name}: no unhandled rejection`);
      }
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
    assert.equal(keyed,tool.name.startsWith('records_') || ['sources_ingest_text','sources_ingest_reference',
      'claims_create','links_create'].includes(tool.name),`${tool.name}: only record mutations and evidence creation take idempotencyKey`);
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

test('the retrieval tools accept exactly the requests the OpenAPI SearchRequest and BundleRequest accept',async()=>{
  const document=YAML.parse(await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8'));
  const ajv=new Ajv2020({strict:false,allErrors:true});
  ajv.addSchema({$id:'openapi',components:document.components});
  const tools=stateplaneMcpDeclaration().manifest().tools;
  const budget={bytes:2048};
  for (const [tool,component,requests] of [
    ['retrieval_search','SearchRequest',[{query:'fog'},{query:'fog',limit:3,kinds:['record'],collections:['entries']},{},{limit:3},{query:''},
      {query:'fog',limit:51},{query:'fog',extra:true}]],
    ['retrieval_bundle','BundleRequest',[{task:'Summarize fog',budget},{query:'fog',budget},{task:'t',query:'q',budget:{tokens:4096}},{budget},
      {task:'t'},{task:'t',budget:{}},{task:'t',budget:{bytes:1}},{budget,limit:3},{task:'t',budget,extra:true}]]]) {
    const published=ajv.compile(tools.find(item=>item.name===tool).inputSchema);
    const openapi=ajv.getSchema(`openapi#/components/schemas/${component}`);
    for (const request of requests)
      assert.equal(published({spaceId:'sp_a',...request}),openapi(request),`${tool} ${JSON.stringify(request)}`);
  }
});

test('the analysis tools accept exactly the requests the OpenAPI AggregationSpec and AnalysisJobRequest accept',async()=>{
  const document=YAML.parse(await readFile(new URL('../contracts/openapi.yaml',import.meta.url),'utf8'));
  const ajv=new Ajv2020({strict:false,allErrors:true});
  ajv.addSchema({$id:'openapi',components:document.components});
  const tools=stateplaneMcpDeclaration().manifest().tools;
  const count={op:'count'};
  const specs=[{metrics:[count]},
    {where:[{field:'team',kind:'string',operator:'eq',value:'red'}],groupBy:[{field:'team'},{field:'at',bucket:{unit:'day',timeZone:'Europe/Paris'}}],
      metrics:[count,{op:'sum',field:'score'},{op:'avg',field:'score'},{op:'min',field:'at'},{op:'max',field:'team'}],maxGroups:1000},
    {groupBy:[],metrics:[count]},{},{metrics:[]},{metrics:Array(17).fill(count)},{metrics:[{op:'count',field:'score'}]},{metrics:[{op:'sum'}]},
    {metrics:[{op:'median',field:'score'}]},{metrics:[count],maxGroups:0},{metrics:[count],maxGroups:1001},{metrics:[count],maxGroups:null},
    {metrics:[count],groupBy:[{field:'a'},{field:'b'},{field:'c'},{field:'d'}]},{metrics:[count],groupBy:[{field:'at',bucket:{unit:'minute',timeZone:'UTC'}}]},
    {metrics:[count],groupBy:[{field:'at',bucket:{unit:'day',timeZone:'+05:00'}}]},{metrics:[count],groupBy:[{field:'at',bucket:{unit:'day'}}]},
    {metrics:[count],groupBy:[{field:''}]},{metrics:[count],where:[{field:'team',kind:'string',operator:'like',value:'r'}]},{metrics:[count],extra:true}];
  for (const [tool,component,requests] of [
    ['analysis_aggregate','AggregationSpec',specs],
    ['analysis_submit','AnalysisJobRequest',[{kind:'export'},{kind:'aggregate',spec:specs[1]},{kind:'aggregate'},{kind:'export',spec:specs[0]},
      {kind:'aggregate',spec:specs[4]},{kind:'snapshot'},{},{kind:'export',extra:true}]]]) {
    const published=ajv.compile(tools.find(item=>item.name===tool).inputSchema);
    const openapi=ajv.getSchema(`openapi#/components/schemas/${component}`);
    let accepted=0;
    for (const request of requests) {
      const valid=openapi(request);
      accepted+=valid?1:0;
      assert.equal(published({spaceId:'sp_a',collectionId:'entries',...request}),valid,`${tool} ${JSON.stringify(request)}`);
    }
    assert.ok(accepted>=2 && accepted<requests.length,`${tool} cases cover both outcomes`);
  }
});

test('analysis tools fail as HTTP does: reads as reads, a submission and a cancellation as writes',async t=>{
  const state=fixture();
  const {server,url}=await mcpServer(state);
  t.after(()=>server.close());
  const mcp=await client(url,'agent-token');
  t.after(()=>mcp.close());
  const s={spaceId:'sp_a',collectionId:'entries'};
  // The codes and retryability test/http-cli.test.js requires of the same routes.
  for (const [tool,args,code,retryable] of [['analysis_aggregate',{...s,metrics:[{op:'count'}]},'RATE_LIMITED',true],
    ['analysis_status',{...s,jobId:'anj_1'},'RATE_LIMITED',true],['analysis_page',{...s,jobId:'anj_1',page:1},'RATE_LIMITED',true],
    ['analysis_submit',{...s,kind:'export'},'COMMIT_OUTCOME_UNKNOWN',false],['analysis_cancel',{...s,jobId:'anj_1'},'COMMIT_OUTCOME_UNKNOWN',false]]) {
    state.fail(Object.assign(new Error('private cause'),{code:'57014'}));
    const result=await mcp.callTool(tool,args);
    assert.deepEqual([result.isError,result.structuredContent.error.code,result.structuredContent.error.retryable],[true,code,retryable],tool);
    assert.doesNotMatch(result.content[0].text,/private cause/);
  }
  state.fail(Object.assign(new Error('The job has no complete result (state running)'),{code:'CONFLICT'}));
  const conflict=(await mcp.callTool('analysis_page',{...s,jobId:'anj_1',page:1})).structuredContent.error;
  assert.deepEqual([conflict.code,conflict.retryable],['CONFLICT',false]);
  assert.doesNotMatch(conflict.message,/state running/);
  state.fail(null);
  // A job request that is not {kind, spec?}, or past the body budget, is refused before any service call.
  state.calls.length=0;
  for (const [args,code] of [[{...s,kind:'snapshot'},'INVALID_ARGUMENT'],[{...s,kind:'export',extra:1},'INVALID_ARGUMENT'],
    [{...s,kind:'aggregate',spec:{metrics:[{op:'count'}],x:'x'.repeat(33_792)}},'RATE_LIMITED']]) {
    const error=(await mcp.callTool('analysis_submit',args)).structuredContent.error;
    assert.deepEqual([error.code,error.retryable],[code,false],JSON.stringify(args).slice(0,80));
  }
  const oversized=(await mcp.callTool('analysis_aggregate',{...s,metrics:[{op:'count'}],x:'x'.repeat(32_768)})).structuredContent.error;
  assert.deepEqual([oversized.code,oversized.retryable],['RATE_LIMITED',false]);
  assert.deepEqual(state.calls,[]);
});

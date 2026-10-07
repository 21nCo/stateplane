import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { PostgresSpaces, AuthorityTransaction } from '../packages/postgres/dist/index.js';
import { StateplaneHttpClient, StateplaneCliError } from '../packages/cli/dist/index.js';
import { saveToken, loadToken, removeToken, configureToken, removeTrackedTokens,
  saveConfig, withConfigMutation, logoutConfig,
  storeSecretServiceToken, loadSecretServiceToken,
  loadOsSecretToken } from '../packages/cli/dist/config.js';

function fixture() {
  let granted=true; let providerDown=false; let commitUnknown=false; let calls=0; let deletes=0;
  const saved=new Map();
  const denied=()=>{ if (!granted) throw Object.assign(new Error('private data'),{code:'NOT_FOUND'}); };
  const services={
    spaces:{list:async()=>[],create:async()=>({spaceId:'sp_a'}),get:async()=>{denied();return {spaceId:'sp_a'};},
      update:async()=>({spaceId:'sp_a'}),delete:async()=>{deletes++;return {deleted:true};}},
    collections:{list:async(_actor,_space,collection)=>{denied();return collection?{slug:collection}:[];},
      define:async()=>({slug:'entries'}),revise:async()=>({slug:'entries'})},
    records:{
      get:async(_actor,_space,collection,id)=>{denied();return {collection,ref:{id},revision:1};},
      byKey:async(_actor,_space,collection,mode,key)=>{denied();return {collection,mode,key};},
      mutate:async(_actor,space,collection,body)=>{
        denied();calls++;
        if (commitUnknown) throw Object.assign(new Error('secret commit cause'),{name:'CommitOutcomeUnknownError'});
        const request=JSON.parse(body);
        const key=`${space}:${collection}:${request.idempotencyKey}`;
        if (!saved.has(key)) saved.set(key,{contractVersion:'1',receiptId:'r_1',spaceId:space,
          ref:{kind:'record',id:'rec_1'},operation:request.operation,revision:1,replayed:false});
        return {...saved.get(key),replayed:calls>1};
      },
      query:async(_actor,_space,_collection,body)=>{denied();const request=JSON.parse(body);
        if (request.cursor==='bad') throw Object.assign(new Error('secret cursor'),{code:'CURSOR_INVALID'});
        return {records:[{ref:{id:'rec_1'}}],nextCursor:'cursor-next',schemaVersion:1};},
      count:async()=>{denied();return 1;}
    },
    batches:{ingest:async()=>({operationKey:'batch-1',state:'active',items:[]}),
      progress:async(_actor,_space,collection,operationKey)=>{denied();return {collection,operationKey,state:'active',items:[]};},
      cancel:async()=>({operationKey:'batch-1',state:'cancelled',items:[]})},
    events:{list:async(_actor,_space,collection)=>{denied();return {collection,events:[],nextCursor:null};},
      projection:async(_actor,_space,collection,id)=>{denied();return {collection,id,state:'pending',generation:1,revision:1};}}
  };
  const identity={verify:async request=>{
    if (providerDown) throw new Error(`provider failure ${request.headers.get('authorization')}`);
    return request.headers.get('authorization')==='Bearer secret-test-token'
      ? {kind:'session',userPrincipalId:'owner',credentialId:'session-1'} : null;
  }};
  return {services,identity,revoke:()=>{granted=false;},failProvider:()=>{providerDown=true;},
    recoverProvider:()=>{providerDown=false;},
    unknownCommit:()=>{commitUnknown=true;},get calls(){return calls;},get deletes(){return deletes;}};
}

async function serve(handler) {
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const request=new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{
      method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined});
    const response=await handler(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return {server,endpoint:`http://127.0.0.1:${server.address().port}/`};
}
async function cliProcess(root,argv,input='',nodeArgs=[]) {
  const child=spawn(process.execPath,[...nodeArgs,'packages/cli/bin/stateplane.js',...argv],{
    cwd:process.cwd(),env:{...process.env,STATEPLANE_CONFIG_DIR:root},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(input);
  const [status]=await once(child,'close');
  return {status,stdout,stderr};
}
async function withConfigMutationInRoot(root,change) {
  const previous=process.env.STATEPLANE_CONFIG_DIR;
  process.env.STATEPLANE_CONFIG_DIR=root;
  try { return await withConfigMutation(change); }
  finally {
    if (previous===undefined) delete process.env.STATEPLANE_CONFIG_DIR;
    else process.env.STATEPLANE_CONFIG_DIR=previous;
  }
}
async function saveConfigWithRoot(root,value) {
  return withConfigMutationInRoot(root,async()=>saveConfig(value));
}
function assertErrorParity(http,cli) {
  assert.equal(cli.status,1);
  const direct=http.error,fromCli=JSON.parse(cli.stderr).error;
  assert.deepEqual({code:fromCli.code,message:fromCli.message,retryable:fromCli.retryable},
    {code:direct.code,message:direct.message,retryable:direct.retryable});
  assert.match(direct.requestId,/^[a-zA-Z0-9_-]{1,80}$/);
  assert.match(fromCli.requestId,/^[a-zA-Z0-9_-]{1,80}$/);
}

test('HTTP and installed CLI observe the same receipt; revocation and cursor errors stay structured',async t=>{
  const state=fixture();const handler=createHttpHandler(state);const {server,endpoint}=await serve(handler);
  t.after(()=>server.close());
  const client=new StateplaneHttpClient({endpoint,token:'secret-test-token'});
  const route='/v1/spaces/sp_a/collections/entries/records';
  const request={operation:'create',idempotencyKey:'req-a',data:{label:'A'}};
  const direct=await client.request('POST',route,request);
  const cliRoot=await mkdtemp(join(tmpdir(),'stateplane-cli-'));
  t.after(()=>rm(cliRoot,{recursive:true,force:true}));
  const cli=argv=>cliProcess(cliRoot,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  const login=await cliProcess(cliRoot,['auth','login','--token-stdin','--store','file'],'secret-test-token\n');
  assert.equal(login.status,0,login.stderr);
  assert.doesNotMatch(login.stdout+login.stderr,/secret-test-token/);
  assert.doesNotMatch(await readFile(join(cliRoot,'config.json'),'utf8'),/secret-test-token/);
  assert.equal((await stat(join(cliRoot,'token'))).mode&0o077,0);
  const selected=await cli(['spaces','select','--space','sp_a']);
  assert.equal(selected.status,0,selected.stderr);
  for (const args of [
    ['records','patch','--collection','entries','--id','rec_1','--expected-revision','1',
      '--idempotency-key','bad-patch','--data','null'],
    ['records','create','--collection','entries','--idempotency-key','missing-file',
      '--file',join(cliRoot,'missing.json')]
  ]) {
    const invalid=await cli(args);
    assert.equal(invalid.status,1);
    assert.deepEqual(JSON.parse(invalid.stderr).error,
      {code:'INVALID_ARGUMENT',message:'INVALID_ARGUMENT',retryable:false,requestId:null});
  }
  assert.equal(state.calls,1);
  const mistyped=await cli(['spaces','delete','--spcae','sp_intended']);
  assert.equal(JSON.parse(mistyped.stderr).error.code,'INVALID_ARGUMENT');
  for (const flag of ['--verbose','--debug']) {
    const rejected=await cli(['spaces','delete',flag]);
    assert.equal(JSON.parse(rejected.stderr).error.code,'INVALID_ARGUMENT');
    assert.doesNotMatch(rejected.stderr,/secret-test-token/);
  }
  assert.equal(state.deletes,0);
  const result=await cli(['records','create','--collection','entries','--data','{"label":"A"}',
    '--idempotency-key','req-a']);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual({...JSON.parse(result.stdout),replayed:false},direct);
  assert.equal(state.calls,2);
  state.unknownCommit();
  const uncertain=await cli(['records','create','--collection','entries','--data','{"label":"B"}',
    '--idempotency-key','req-b']);
  const uncertainHttp=await fetch(new URL(route,endpoint),{method:'POST',headers:{Authorization:'Bearer secret-test-token',
    'Content-Type':'application/json'},body:JSON.stringify({operation:'create',idempotencyKey:'req-c',data:{label:'C'}})});
  assertErrorParity(await uncertainHttp.json(),uncertain);
  assert.doesNotMatch(uncertain.stderr,/secret commit cause|secret-test-token/);
  const page=await cli(['records','query','--collection','entries','--predicates','[]','--limit','1']);
  assert.equal(JSON.parse(page.stdout).nextCursor,'cursor-next');
  for (const reserved of ['query','count','by-key']) {
    const wrongMethod=await fetch(endpoint+`v1/spaces/sp_a/collections/entries/records/${reserved}`,
      {headers:{Authorization:'Bearer secret-test-token'}});
    assert.equal(wrongMethod.status,404);
    assert.equal((await wrongMethod.json()).error.code,'NOT_FOUND');
  }
  const cursorHttp=await fetch(new URL(route+'/query',endpoint),{method:'POST',headers:{Authorization:'Bearer secret-test-token',
    'Content-Type':'application/json'},body:JSON.stringify({predicates:[],limit:1,cursor:'bad'})});
  assertErrorParity(await cursorHttp.json(),await cli(['records','query','--collection','entries',
    '--predicates','[]','--limit','1','--cursor','bad']));
  state.revoke();
  const denied=await cli(['records','get','--collection','entries','--id','rec_1']);
  assert.equal(denied.status,1);
  assert.equal(JSON.parse(denied.stderr).error.code,'NOT_FOUND');
  assert.doesNotMatch(denied.stderr,/private data|secret-test-token/);
  const invalidToken=await fetch(endpoint+'v1/spaces',{headers:{Authorization:'Bearer bad-secret'}});
  assert.equal(invalidToken.status,401);
  assert.doesNotMatch(await invalidToken.text(),/bad-secret/);
  state.failProvider();
  const failed=await cli(['records','get','--collection','entries','--id','rec_1']);
  const failedHttp=await fetch(new URL(route+'/rec_1',endpoint),{headers:{Authorization:'Bearer secret-test-token'}});
  assertErrorParity(await failedHttp.json(),failed);
  assert.doesNotMatch(failed.stderr,/provider failure|secret-test-token/);
  const badAuth=await fetch(endpoint+'v1/spaces',{headers:{Authorization:'Bearer bad-secret'}});
  assert.equal(badAuth.status,503);
  assert.doesNotMatch(await badAuth.text(),/provider failure|bad-secret/);
  state.recoverProvider();
  const changed=await cli(['config','endpoint','--url','http://127.0.0.1:43210/']);
  assert.equal(changed.status,0);
  assert.equal(JSON.parse(changed.stdout).space,null);
  await assert.rejects(readFile(join(cliRoot,'token'),'utf8'),{code:'ENOENT'});
  assert.deepEqual(JSON.parse((await cli(['config','show'])).stdout),
    {endpoint:'http://127.0.0.1:43210/',space:null,tokenStore:null});
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  const invalid=await cliProcess(cliRoot,['auth','login','--token-stdin','--store','file'],'bad-secret\n');
  const invalidHttp=await fetch(endpoint+'v1/auth/session',{headers:{Authorization:'Bearer bad-secret'}});
  assertErrorParity(await invalidHttp.json(),invalid);
  assert.doesNotMatch(invalid.stderr,/bad-secret/);
  await assert.rejects(readFile(join(cliRoot,'token'),'utf8'),{code:'ENOENT'});
});

test('CLI preserves JSON string types and rejects empty optional selectors before HTTP effects',async t=>{
  const state=fixture();
  const observed={define:0,revise:0,count:0,create:0,query:0};
  const schema=async(kind,_actor,_space,_collection,...args)=>{
    observed[kind]++;
    const value=JSON.parse(args.at(-1));
    if (!value || typeof value!=='object' || Array.isArray(value))
      throw Object.assign(new Error('invalid schema'),{code:'SCHEMA_UNSUPPORTED'});
    return {slug:'entries',version:1};
  };
  state.services.collections.define=(...args)=>schema('define',...args);
  state.services.collections.revise=(...args)=>schema('revise',...args);
  state.services.records.count=async(_actor,_space,_collection,body)=>{
    observed.count++;
    if (!Array.isArray(JSON.parse(body)))
      throw Object.assign(new Error('invalid predicates'),{code:'INVALID_ARGUMENT'});
    return 0;
  };
  state.services.spaces.create=async()=>{observed.create++;return {spaceId:'sp_created'};};
  state.services.records.query=async()=>{observed.query++;return {records:[],nextCursor:null};};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-json-types-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  const collection='/v1/spaces/sp_a/collections/entries';
  const headers={Authorization:'Bearer secret-test-token','Content-Type':'application/json'};
  const direct=async(method,path,body,extraHeaders={})=>
    (await fetch(new URL(path,endpoint),{method,headers:{...headers,...extraHeaders},body:JSON.stringify(body)})).json();
  const quotedSchema=JSON.stringify('{}');
  const schemaFile=join(root,'quoted-schema.json');
  await writeFile(schemaFile,quotedSchema);
  for (const [action,method,args] of [
    ['define','PUT',['--data',quotedSchema]],
    ['define','PUT',['--file',schemaFile]],
    ['revise','PATCH',['--data',quotedSchema,'--version','1']],
    ['revise','PATCH',['--file',schemaFile,'--version','1']]
  ]) {
    const http=await direct(method,collection,'{}',action==='revise'?{'If-Match':'1'}:{});
    const result=await cli(['collections',action,'--space','sp_a','--collection','entries',...args]);
    assertErrorParity(http,result);
  }
  const quotedPredicates=JSON.stringify('[]');
  assertErrorParity(await direct('POST',collection+'/records/count','[]'),
    await cli(['records','count','--space','sp_a','--collection','entries',
      '--predicates',quotedPredicates]));
  assert.equal(observed.define,4);
  assert.equal(observed.revise,4);
  assert.equal(observed.count,2);
  const goodSchema=await cli(['collections','define','--space','sp_a','--collection','entries',
    '--data','{}']);
  assert.equal(goodSchema.status,0,goodSchema.stderr);
  const goodCount=await cli(['records','count','--space','sp_a','--collection','entries',
    '--predicates','[]']);
  assert.equal(goodCount.status,0,goodCount.stderr);
  assert.equal(JSON.parse(goodCount.stdout),0);
  const emptyCell=await cli(['spaces','create','--space','sp_12345678-1234-1234-1234-123456789abc',
    '--cell','']);
  const emptySort=await cli(['records','query','--space','sp_a','--collection','entries',
    '--limit','1','--sort','']);
  for (const result of [emptyCell,emptySort]) {
    assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).error.code,'INVALID_ARGUMENT');
    assert.doesNotMatch(result.stdout+result.stderr,/secret-test-token/);
  }
  assert.equal(observed.create,0);
  assert.equal(observed.query,0);
});

test('CLI rejects empty record selectors and conflicting payload sources before writes',async t=>{
  const state=fixture();
  let schemas=0;
  state.services.collections.define=async()=>{schemas++;return {slug:'entries'};};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-empty-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'record.json');
  await writeFile(file,'{"label":"from file"}');
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);

  const create=['records','create','--collection','entries','--idempotency-key','invalid',
    '--data','{"label":"from data"}'];
  for (const args of [
    [...create,'--key',''],
    [...create,'--space',''],
    [...create,'--file',''],
    ['records','create','--collection','entries','--idempotency-key','invalid',
      '--data','','--file',file],
    ['collections','define','--collection','entries','--data','{}','--file','']
  ]) {
    const result=await cli(args);
    assert.equal(result.status,1,args.join(' '));
    assert.deepEqual(JSON.parse(result.stderr).error,
      {code:'INVALID_ARGUMENT',message:'INVALID_ARGUMENT',retryable:false,requestId:null});
    assert.doesNotMatch(result.stdout+result.stderr,/secret-test-token/);
    assert.equal(state.calls,0,'malformed record input reached HTTP');
    assert.equal(schemas,0,'malformed schema input reached HTTP');
  }

  for (const [source,args] of [
    ['data',['--data','{"label":"from data"}']],
    ['file',['--file',file]]
  ]) {
    const result=await cli(['records','create','--collection','entries',
      '--idempotency-key',source,'--key',source,...args]);
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).operation,'create');
  }
  assert.equal(state.calls,2);
});

test('endpoint changes clear saved space while same-endpoint configuration retains it',async t=>{
  const {server,endpoint}=await serve(createHttpHandler(fixture()));
  t.after(()=>server.close());
  const other=await serve(createHttpHandler(fixture()));
  t.after(()=>other.server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-endpoint-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_old'])).status,0);
  assert.equal(JSON.parse((await cli(['config','endpoint','--url',endpoint])).stdout).space,'sp_old');
  const switched=await cli(['config','endpoint','--url',other.endpoint]);
  assert.equal(switched.status,0,switched.stderr);
  assert.deepEqual(JSON.parse((await cli(['config','show'])).stdout),
    {endpoint:other.endpoint,space:null,tokenStore:null});
  const login=await cliProcess(root,['auth','login','--token-stdin','--store','file'],'secret-test-token\n');
  assert.equal(login.status,0,login.stderr);
  const withoutSpace=await cli(['records','get','--collection','entries','--id','rec_1']);
  assert.equal(JSON.parse(withoutSpace.stderr).error.code,'INVALID_ARGUMENT');
  const explicit=await cli(['records','get','--space','sp_new','--collection','entries','--id','rec_1']);
  assert.equal(explicit.status,0,explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).ref.id,'rec_1');
  assert.equal(JSON.parse((await cli(['config','show'])).stdout).space,null);
});

test('concurrent selection reloads the endpoint after another process changes it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-race-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const before='https://old.example.invalid/';
  const after='https://new.example.invalid/';
  await saveConfigWithRoot(root,{endpoint:before});
  let release;
  let entered;
  const locked=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const change=withConfigMutationInRoot(root,async current=>{
    entered();
    await gate;
    await saveConfig({...current,endpoint:after,space:undefined});
  });
  await locked;
  const selection=cliProcess(root,['spaces','select','--space','selected']);
  let settled=false;
  selection.then(()=>{settled=true;});
  try {
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(settled,false,'selection waits for the cross-process config lock');
  } finally { release(); }
  await change;
  assert.equal((await selection).status,0);
  assert.deepEqual(JSON.parse((await cliProcess(root,['config','show'])).stdout),
    {endpoint:after,space:'selected',tokenStore:null});
});

test('a killed config writer releases its lock and concurrent clients serialize mutations',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-lock-recovery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await saveConfigWithRoot(root,{endpoint:'https://original.example.invalid/'});
  const moduleUrl=new URL('../packages/cli/dist/config.js',import.meta.url).href;
  const holder=spawn(process.execPath,['--input-type=module','-e',
    `import {withConfigMutation} from ${JSON.stringify(moduleUrl)};
     await withConfigMutation(async()=>{process.stdout.write('locked\\n');await new Promise(()=>{});});`],
  {env:{...process.env,STATEPLANE_CONFIG_DIR:root},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    holder.stdout.once('data',resolve);
    holder.once('error',reject);
    holder.once('exit',()=>reject(new Error('lock holder exited before acquisition')));
  });
  holder.kill('SIGKILL');
  await once(holder,'exit');
  const journal=join(root,'intervals');
  const worker=`import {withConfigMutation,saveConfig} from ${JSON.stringify(moduleUrl)};
    import {appendFile} from 'node:fs/promises';
    await withConfigMutation(async current=>{
      await appendFile(${JSON.stringify(journal)},'start\\n');
      await new Promise(resolve=>setTimeout(resolve,40));
      await saveConfig({...current,space:'selected'});
      await appendFile(${JSON.stringify(journal)},'end\\n');
    });`;
  const clients=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',worker],
      {env:{...process.env,STATEPLANE_CONFIG_DIR:root},stdio:['ignore','pipe','pipe']});
    let diagnostics='';
    child.stderr.on('data',chunk=>{diagnostics+=chunk;});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve(code):reject(new Error(diagnostics)));
  })));
  assert.equal(clients.length,8);
  assert.deepEqual((await readFile(journal,'utf8')).trim().split('\n'),
    Array.from({length:8},()=>['start','end']).flat());
  assert.equal(JSON.parse(await readFile(join(root,'config.json'),'utf8')).space,'selected');
  assert.equal((await stat(join(root,'config.lock.sqlite'))).mode&0o077,0);
});

test('HTTP and CLI reject noncanonical integer spellings before schema revision',async t=>{
  const state=fixture();let revisions=0;
  state.services.collections.revise=async()=>{revisions++;return {schemaVersion:2};};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-numeric-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal((await cliProcess(root,['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  const route=new URL('v1/spaces/sp_a/collections/entries',endpoint);
  for (const value of ['1e2','0x10','01','+1','1.0']) {
    const response=await fetch(route,{method:'PATCH',headers:{Authorization:'Bearer secret-test-token',
      'Content-Type':'application/json','If-Match':value},body:'{}'});
    assert.equal(response.status,400,value);
    assert.equal((await response.json()).error.code,'INVALID_ARGUMENT');
    const cli=await cliProcess(root,['collections','revise','--space','sp_a','--collection','entries',
      '--version',value,'--data','{}']);
    assert.equal(cli.status,1,value);
    assert.equal(JSON.parse(cli.stderr).error.code,'INVALID_ARGUMENT');
  }
  const spaced=await cliProcess(root,['collections','revise','--space','sp_a','--collection','entries',
    '--version',' 1 ','--data','{}']);
  assert.equal(spaced.status,1);
  assert.equal(JSON.parse(spaced.stderr).error.code,'INVALID_ARGUMENT');
  assert.equal(revisions,0);
  const response=await fetch(route,{method:'PATCH',headers:{Authorization:'Bearer secret-test-token',
    'Content-Type':'application/json','If-Match':'1'},body:'{}'});
  assert.equal(response.status,200);
  assert.equal((await cliProcess(root,['collections','revise','--space','sp_a','--collection','entries',
    '--version','1','--data','{}'])).status,0);
  assert.equal(revisions,2);
});

test('HTTP and CLI address encoded collection, record, batch and external-key selectors',async t=>{
  const state=fixture();const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const cliRoot=await mkdtemp(join(tmpdir(),'stateplane-cli-paths-'));
  t.after(()=>rm(cliRoot,{recursive:true,force:true}));
  const cli=argv=>cliProcess(cliRoot,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(cliRoot,['auth','login','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);
  const cases=[
    ['/collections/a%2Fb',['collections','get','--collection','a/b'],{slug:'a/b'}],
    ['/collections/a%5Cb',['collections','get','--collection','a\\b'],{slug:'a\\b'}],
    ['/collections/;.',['collections','get','--collection','.'],{slug:'.'}],
    ['/collections/;..',['collections','get','--collection','..'],{slug:'..'}],
    ['/collections/%3B.',['collections','get','--collection',';.'],{slug:';.'}],
    ['/collections/a%2Fb/records/by-key/k%2Fv?mode=external',
      ['records','key','--collection','a/b','--key','k/v','--mode','external'],
      {collection:'a/b',mode:'external',key:'k/v'}],
    ['/collections/entries/records/by-key/;.?mode=external',
      ['records','key','--collection','entries','--key','.','--mode','external'],
      {collection:'entries',mode:'external',key:'.'}],
    ['/collections/entries/records/by-key/%3B.?mode=external',
      ['records','key','--collection','entries','--key',';.','--mode','external'],
      {collection:'entries',mode:'external',key:';.'}],
    ['/collections/entries/records/a%2Fb',
      ['records','get','--collection','entries','--id','a/b'],
      {collection:'entries',ref:{id:'a/b'},revision:1}],
    ['/collections/entries/batches/a%2Fb',
      ['batches','status','--collection','entries','--operation-key','a/b'],
      {collection:'entries',operationKey:'a/b',state:'active',items:[]}],
    ['/collections/a%2Fb/events',['events','list','--collection','a/b'],
      {collection:'a/b',events:[],nextCursor:null}],
    ['/collections/entries/records/a%2Fb/projection',
      ['records','projection','--collection','entries','--id','a/b'],
      {collection:'entries',id:'a/b',state:'pending',generation:1,revision:1}]
  ];
  for (const [suffix,args,expected] of cases) {
    const response=await fetch(endpoint+`v1/spaces/sp_a${suffix}`,
      {headers:{Authorization:'Bearer secret-test-token'}});
    assert.equal(response.status,200,suffix);
    assert.deepEqual(await response.json(),expected,suffix);
    const result=await cli(args);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),expected,args.join(' '));
  }
});

test('CLI sends schema preconditions on every record mutation',async t=>{
  const state=fixture();let effects=0;
  state.services.records.mutate=async(_actor,_space,_collection,serialized)=>{
    const request=JSON.parse(serialized);
    if (request.expectedSchemaVersion!==2)
      throw Object.assign(new Error('schema changed'),{code:'SCHEMA_CONFLICT'});
    effects++;
    return {schemaVersion:2,operation:request.operation};
  };
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-schema-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);
  const route='/v1/spaces/sp_a/collections/entries/records';
  for (const [operation,args,fields] of [
    ['create',['--data','{"label":"A"}'],{data:{label:'A'}}],
    ['replace',['--id','rec_1','--expected-revision','1','--data','{"label":"B"}'],
      {id:'rec_1',expectedRevision:1,data:{label:'B'}}],
    ['patch',['--id','rec_1','--expected-revision','1','--data','{"set":{"label":"B"},"unset":[]}'],
      {id:'rec_1',expectedRevision:1,set:{label:'B'},unset:[]}],
    ['delete',['--id','rec_1','--expected-revision','1'],{id:'rec_1',expectedRevision:1}]
  ]) {
    const key=`schema-${operation}`;
    const request={operation,idempotencyKey:key,expectedSchemaVersion:1,...fields};
    const http=await fetch(new URL(route,endpoint),{method:'POST',
      headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},body:JSON.stringify(request)});
    const stale=await cli(['records',operation,'--collection','entries','--idempotency-key',key,
      '--expected-schema-version','1',...args]);
    assertErrorParity(await http.json(),stale);
    assert.equal(JSON.parse(stale.stderr).error.code,'SCHEMA_CONFLICT');
    const fresh=await cli(['records',operation,'--collection','entries','--idempotency-key',key,
      '--expected-schema-version','2',...args]);
    assert.equal(fresh.status,0,fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout),{schemaVersion:2,operation});
  }
  assert.equal(effects,4);
});

test('CLI rejects a batch whose escaped HTTP envelope exceeds the server budget',async t=>{
  const state=fixture();let ingests=0;
  state.services.batches.ingest=async()=>{ingests++;return {state:'active',items:[]};};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-envelope-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'items.ndjson');
  const item=JSON.stringify({operation:'create',data:{label:'"'.repeat(500_000)}});
  await writeFile(file,`${item}\n${item}\n`);
  assert.ok(Buffer.byteLength(item)<1_048_576);
  assert.ok(Buffer.byteLength(JSON.stringify([item,item]))>3_145_728);
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);
  const oversized=await cli(['batches','ingest','--collection','entries','--operation-key','dense',
    '--file',file]);
  assert.equal(oversized.status,1);
  assert.deepEqual(JSON.parse(oversized.stderr).error,
    {code:'RATE_LIMITED',message:'RATE_LIMITED',retryable:false,requestId:null});
  assert.equal(ingests,0);
  await writeFile(file,'{"operation":"create","data":{"label":"small"}}\n');
  assert.equal((await cli(['batches','ingest','--collection','entries','--operation-key','small',
    '--file',file])).status,0);
  assert.equal(ingests,1);
});

test('CLI checks complete record and query bodies at the HTTP byte boundary',async t=>{
  const state=fixture();let mutations=0,queries=0,counts=0;
  state.services.records.mutate=async()=>{mutations++;return {ok:true};};
  state.services.records.query=async()=>{queries++;return {records:[],nextCursor:null};};
  state.services.records.count=async()=>{counts++;return 0;};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-wire-budget-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'payload.json');
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);

  const cases=[
    {name:'create',limit:1_048_576,wire:value=>({operation:'create',idempotencyKey:'budget',data:{label:value}}),
      args:()=>['records','create','--idempotency-key','budget','--file',file]},
    {name:'replace',limit:1_048_576,wire:value=>({operation:'replace',idempotencyKey:'budget',
      id:'rec_1',expectedRevision:1,data:{label:value}}),
      args:()=>['records','replace','--idempotency-key','budget','--id','rec_1',
        '--expected-revision','1','--file',file]},
    {name:'patch',limit:1_048_576,wire:value=>({operation:'patch',idempotencyKey:'budget',
      id:'rec_1',expectedRevision:1,set:{label:value},unset:[]}),
      args:()=>['records','patch','--idempotency-key','budget','--id','rec_1',
        '--expected-revision','1','--file',file]},
    {name:'query',limit:32_768,wire:value=>({predicates:[value],limit:1}),
      args:value=>['records','query','--predicates',JSON.stringify([value]),'--limit','1']},
    {name:'count',limit:32_768,wire:value=>[value],
      args:value=>['records','count','--predicates',JSON.stringify([value])]}
  ];
  for (const entry of cases) {
    const length=entry.limit-Buffer.byteLength(JSON.stringify(entry.wire('')));
    for (const [excess,expectedStatus] of [[0,0],[1,1]]) {
      const value='x'.repeat(length+excess);
      assert.equal(Buffer.byteLength(JSON.stringify(entry.wire(value))),entry.limit+excess);
      if (['create','replace','patch'].includes(entry.name)) {
        const data=entry.name==='patch'?{set:{label:value},unset:[]}:{label:value};
        await writeFile(file,JSON.stringify(data));
      }
      const result=await cli([...entry.args(value),'--collection','entries']);
      assert.equal(result.status,expectedStatus,`${entry.name}: ${result.stderr}`);
      if (excess) assert.deepEqual(JSON.parse(result.stderr).error,
        {code:'RATE_LIMITED',message:'RATE_LIMITED',retryable:false,requestId:null});
    }
  }
  assert.deepEqual([mutations,queries,counts],[3,1,1]);
});

test('HTTP body caps match CLI nonretryable errors while service throttles retain Retry-After',async t=>{
  const state=fixture();let effects=0;
  for (const [owner,method] of [
    [state.services.spaces,'create'],[state.services.collections,'define'],
    [state.services.records,'mutate'],[state.services.records,'query'],
    [state.services.records,'count'],[state.services.batches,'ingest']
  ]) owner[method]=async()=>{effects++;return {ok:true};};
  const handler=createHttpHandler(state);
  const {server,endpoint}=await serve(handler);
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-http-budgets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);

  const spaceId='sp_00000000-0000-0000-0000-000000000001';
  const collection='/v1/spaces/sp_a/collections/entries';
  const oversized=(limit,make)=>{
    const length=limit-Buffer.byteLength(JSON.stringify(make('')))+1;
    const value='x'.repeat(length);
    const serialized=JSON.stringify(make(value));
    assert.equal(Buffer.byteLength(serialized),limit+1);
    return {value,serialized};
  };
  const space=oversized(4096,value=>({spaceId,cellId:value}));
  const schema=oversized(1_048_576,value=>({label:value}));
  const record=oversized(1_048_576,value=>({operation:'create',idempotencyKey:'budget',data:{label:value}}));
  const query=oversized(32_768,value=>({predicates:[value],limit:1}));
  const count=oversized(32_768,value=>[value]);
  const schemaFile=join(root,'schema.json');
  const recordFile=join(root,'record.json');
  await writeFile(schemaFile,schema.serialized);
  await writeFile(recordFile,JSON.stringify({label:record.value}));
  const batchFile=join(root,'items.ndjson');
  const item=JSON.stringify({operation:'create',data:{label:'"'.repeat(500_000)}});
  await writeFile(batchFile,`${item}\n${item}\n`);
  const batch=JSON.stringify([item,item]);
  assert.ok(Buffer.byteLength(batch)>3_145_728);
  const cases=[
    {name:'space',method:'POST',route:'/v1/spaces',body:space.serialized,
      args:['spaces','create','--space',spaceId,'--cell',space.value]},
    {name:'collection',method:'PUT',route:collection,body:schema.serialized,
      args:['collections','define','--collection','entries','--file',schemaFile]},
    {name:'record',method:'POST',route:`${collection}/records`,body:record.serialized,
      args:['records','create','--collection','entries','--idempotency-key','budget',
        '--file',recordFile]},
    {name:'query',method:'POST',route:`${collection}/records/query`,body:query.serialized,
      args:['records','query','--collection','entries','--predicates',JSON.stringify([query.value]),'--limit','1']},
    {name:'count',method:'POST',route:`${collection}/records/count`,body:count.serialized,
      args:['records','count','--collection','entries','--predicates',count.serialized]},
    {name:'batch',method:'PUT',route:`${collection}/batches/budget`,body:batch,
      args:['batches','ingest','--collection','entries','--operation-key','budget','--file',batchFile]}
  ];
  for (const entry of cases) {
    const response=await fetch(new URL(entry.route,endpoint),{method:entry.method,
      headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},body:entry.body});
    assert.equal(response.status,429,entry.name);
    assert.equal(response.headers.get('Retry-After'),null,entry.name);
    const error=(await response.json()).error;
    assert.deepEqual({code:error.code,message:error.message,retryable:error.retryable},
      {code:'RATE_LIMITED',message:'RATE_LIMITED',retryable:false},entry.name);
    const command=await cli(entry.args);
    assert.equal(command.status,1,entry.name);
    assert.deepEqual(JSON.parse(command.stderr).error,
      {code:'RATE_LIMITED',message:'RATE_LIMITED',retryable:false,requestId:null},entry.name);
  }
  assert.equal(effects,0);

  const stream=new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode('x'.repeat(32_769)));
    controller.close();
  }});
  const streamed=new Request(new URL(`${collection}/records/query`,endpoint),{method:'POST',
    headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},
    body:stream,duplex:'half'});
  assert.equal(streamed.headers.get('Content-Length'),null);
  const streamResponse=await handler(streamed);
  assert.equal(streamResponse.status,429);
  assert.equal(streamResponse.headers.get('Retry-After'),null);
  assert.equal((await streamResponse.json()).error.retryable,false);
  assert.equal(effects,0);

  state.services.records.query=async()=>{throw Object.assign(new Error('busy'),{code:'RATE_LIMITED'});};
  const throttle=await fetch(new URL(`${collection}/records/query`,endpoint),{method:'POST',
    headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},
    body:JSON.stringify({predicates:[],limit:1})});
  assert.equal(throttle.status,429);
  assert.equal(throttle.headers.get('Retry-After'),'1');
  assert.equal((await throttle.json()).error.retryable,true);
});

test('empty CLI cursors fail before fetching; event polling preserves supplied cursor',async t=>{
  const state=fixture();const seen={queries:[],events:[]};
  state.services.records.query=async(_actor,_space,_collection,serialized)=>{
    const cursor=JSON.parse(serialized).cursor;
    if (cursor==='') throw Object.assign(new Error('invalid cursor'),{code:'CURSOR_INVALID'});
    seen.queries.push(cursor);
    return {records:[],nextCursor:'query-next'};
  };
  state.services.events.list=async(_actor,_space,_collection,cursor)=>{
    if (cursor==='') throw Object.assign(new Error('invalid cursor'),{code:'CURSOR_INVALID'});
    seen.events.push(cursor);return {events:[],nextCursor:cursor??null};
  };
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-cursors-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cli=argv=>cliProcess(root,argv);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  assert.equal((await cli(['spaces','select','--space','sp_a'])).status,0);
  const route=`${endpoint}v1/spaces/sp_a/collections/entries`;
  for (const [args,direct] of [
    [['records','query','--limit','1','--cursor',''],
      fetch(`${route}/records/query`,{method:'POST',headers:{Authorization:'Bearer secret-test-token',
        'Content-Type':'application/json'},body:JSON.stringify({predicates:[],limit:1,cursor:''})})],
    [['events','list','--cursor',''],
      fetch(`${route}/events?cursor=`,{headers:{Authorization:'Bearer secret-test-token'}})]
  ]) {
    const response=await direct;
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'CURSOR_INVALID');
    const rejected=await cli([...args,'--collection','entries']);
    assert.equal(rejected.status,1);
    assert.deepEqual(JSON.parse(rejected.stderr).error,
      {code:'CURSOR_INVALID',message:'CURSOR_INVALID',retryable:false,requestId:null});
  }
  assert.deepEqual(seen,{queries:[],events:[]});
  assert.equal((await cli(['records','query','--collection','entries','--limit','1',
    '--cursor','query-page-2'])).status,0);
  const first=await cli(['events','list','--collection','entries']);
  const next=await cli(['events','list','--collection','entries','--cursor','event-page-2']);
  assert.equal(first.status,0,first.stderr);
  assert.equal(next.status,0,next.stderr);
  assert.equal(JSON.parse(next.stdout).nextCursor,'event-page-2');
  assert.deepEqual(seen,{queries:['query-page-2'],events:[undefined,'event-page-2']});
});

test('malformed lifecycle PATCH returns an input error without invoking the transition',async t=>{
  const state=fixture();let updates=0;
  state.services.spaces.update=async()=>{updates++;return {lifecycle:'readOnly'};};
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  for (const lifecycle of [{toString:null},null,2,[]]) {
    const response=await fetch(`${endpoint}v1/spaces/sp_a`,{method:'PATCH',
      headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},
      body:JSON.stringify({lifecycle})});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'INVALID_ARGUMENT');
  }
  assert.equal(updates,0);
  const valid=await fetch(`${endpoint}v1/spaces/sp_a`,{method:'PATCH',
    headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},
    body:JSON.stringify({lifecycle:'readOnly'})});
  assert.equal(valid.status,200);
  assert.equal(updates,1);
});

test('Secret Service verification failure clears a stored token',async()=>{
  const endpoint='https://secret-test.example.invalid/';
  const token='private-test-token';
  let stored;
  const calls=[];
  const run=async(program,args,stdin)=>{
    assert.equal(program,'secret-tool');
    assert.deepEqual(args.slice(-4),['service','stateplane','endpoint',endpoint]);
    assert.ok(!args.includes(token));
    const action=args[0];calls.push(action);
    if (action==='store') { stored=stdin;return {ok:true,output:''}; }
    if (action==='lookup') return {ok:true,output:'wrong-token\n'};
    if (action==='clear') { stored=undefined;return {ok:true,output:''}; }
    throw new Error('unexpected secret-tool action');
  };
  await assert.rejects(storeSecretServiceToken(endpoint,token,run),{code:'KEYCHAIN_UNAVAILABLE'});
  assert.deepEqual(calls,['store','lookup','clear']);
  assert.equal(stored,undefined);
});

test('Secret Service load separates an absent item from a failed backend without exposing diagnostics',async()=>{
  const endpoint='https://secret-test.example.invalid/';
  for (const [result,code] of [
    [{ok:false,output:'',missing:true},'UNAUTHENTICATED'],
    [{ok:false,output:'private provider diagnostic',missing:false},'KEYCHAIN_UNAVAILABLE'],
    [{ok:true,output:''},'UNAUTHENTICATED']
  ]) {
    const run=async(program,args)=>{
      assert.equal(program,'secret-tool');
      assert.deepEqual(args,['lookup','service','stateplane','endpoint',endpoint]);
      return result;
    };
    await assert.rejects(loadSecretServiceToken(endpoint,run),{code});
  }
  assert.equal(await loadSecretServiceToken(endpoint,async()=>({ok:true,output:'token\n'})),'token');
});

test('OS secret load reports backend failure consistently and missing macOS items as unauthenticated',async()=>{
  const endpoint='https://secret-test.example.invalid/';
  await assert.rejects(loadOsSecretToken(endpoint,'win32',async()=>{
    throw new Error('unsupported OS invoked a store');
  }),{code:'KEYCHAIN_UNAVAILABLE'});
  for (const [result,code] of [
    [{ok:false,output:'',missing:false},'KEYCHAIN_UNAVAILABLE'],
    [{ok:false,output:'',missing:true},'UNAUTHENTICATED']
  ]) await assert.rejects(loadOsSecretToken(endpoint,'darwin',async(program,args)=>{
    assert.equal(program,'/usr/bin/xcrun');
    assert.deepEqual(args.slice(0,3),['--sdk','macosx','swift']);
    assert.deepEqual(args.slice(-2),['load',`stateplane:${endpoint}`]);
    return result;
  }),{code});
});

test('projection polling returns a deleted revision while record content remains hidden',async()=>{
  const scope={spaceId:'sp_a',collectionId:'entries',principalId:'owner',credentialId:'writer',
    capability:'records:read',policyVersion:1,placementGeneration:1};
  const client={query:async sql=>{
    if (sql.includes('JOIN projection_outbox')) return {rows:sql.includes('NOT r.tombstone')?[]:[
      {revision:2,generation:1,delivery_state:'pending'}]};
    if (sql.includes('FROM records')) return {rows:[]};
    throw new Error('unexpected SQL');
  }};
  const transaction=new AuthorityTransaction(client,scope,3600);
  assert.equal(await transaction.getRecord('deleted'),null);
  assert.deepEqual(await transaction.projection('deleted'),{state:'pending',generation:1,revision:2});
  const denied=new AuthorityTransaction(client,{...scope,capability:'records:write'},3600);
  await assert.rejects(denied.projection('deleted'),{code:'FORBIDDEN'});
});

test('CLI batch recovery preserves whitespace-bearing HTTP manifest item bytes',async t=>{
  const state=fixture();
  const item=' { "operation" : "create", "data": {"label":"one"} } ';
  const manifest=[item];
  let accepted;
  state.services.batches.ingest=async(_actor,_space,_collection,operationKey,serialized)=>{
    const items=JSON.parse(serialized);
    const digest=JSON.stringify(items);
    if (accepted && accepted!==digest) throw Object.assign(new Error('different manifest'),{code:'BATCH_CONFLICT'});
    const replayed=accepted!==undefined;
    accepted=digest;
    return {operationKey,state:'active',items:[],replayed};
  };
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-batch-replay-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'items.ndjson');
  await writeFile(file,`${item}\n`);
  const direct=await fetch(`${endpoint}v1/spaces/sp_a/collections/entries/batches/recover`,{
    method:'PUT',headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},
    body:JSON.stringify(manifest)});
  assert.equal(direct.status,200);
  assert.equal((await cliProcess(root,['config','endpoint','--url',endpoint])).status,0);
  assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store','file'],
    'secret-test-token\n')).status,0);
  const retry=await cliProcess(root,['batches','ingest','--space','sp_a','--collection','entries',
    '--operation-key','recover','--file',file]);
  assert.equal(retry.status,0,retry.stderr);
  assert.equal(accepted,JSON.stringify(manifest));
  await writeFile(file,' {bad json}\n');
  const malformed=await cliProcess(root,['batches','ingest','--space','sp_a','--collection','entries',
    '--operation-key','recover','--file',file]);
  assert.equal(JSON.parse(malformed.stderr).error.code,'INVALID_ARGUMENT');
  assert.equal(accepted,JSON.stringify(manifest));
});

test('GET honors Retry-After; writes never auto-retry after an uncertain outcome',async()=>{
  let calls=0;const client=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;if(calls===1)return Response.json({error:{code:'BACKPRESSURE',requestId:'r1'}},
      {status:503,headers:{'Retry-After':'0'}});return Response.json({ok:true});},sleep:async()=>{}});
  assert.deepEqual(await client.request('GET','/v1/spaces'),{ok:true});assert.equal(calls,2);
  calls=0;
  const lost=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;throw new Error('token secret');},sleep:async()=>{}});
  await assert.rejects(lost.request('POST','/v1/spaces',{}),error=>error instanceof StateplaneCliError && error.code==='OUTCOME_UNKNOWN');
  assert.equal(calls,1);
  calls=0;
  assert.deepEqual(await client.request('POST','/v1/spaces/sp_a/collections/entries/records/query',
    {predicates:[],limit:1}),{ok:true});
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(lost.request('POST','/v1/spaces/sp_a/collections/entries/records/count',[]),
    {code:'PROVIDER_UNAVAILABLE'});
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(lost.request('POST','/v1/spaces/sp_a/collections/entries/records',{operation:'create'}),
    {code:'OUTCOME_UNKNOWN'});
  assert.equal(calls,1);
  calls=0;
  const rejected=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;return Response.json({error:{code:'BACKPRESSURE',requestId:'r1'}},
      {status:503,headers:{'Retry-After':'0'}});},sleep:async()=>{}});
  await assert.rejects(rejected.request('POST','/v1/spaces',{}),{code:'BACKPRESSURE'});
  assert.equal(calls,1);
  calls=0;
  const nonJson=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;return calls===1
      ? new Response('upstream unavailable',{status:503,headers:{'Retry-After':'0'}})
      : Response.json({ok:true});},sleep:async()=>{}});
  assert.deepEqual(await nonJson.request('GET','/v1/spaces'),{ok:true});
  assert.equal(calls,2);
  calls=0;
  const alwaysNonJson=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;return new Response('upstream unavailable',
      {status:503,headers:{'Retry-After':'0'}});},sleep:async()=>{}});
  await assert.rejects(alwaysNonJson.request('GET','/v1/spaces'),
    {code:'PROVIDER_UNAVAILABLE',retryable:true});
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(alwaysNonJson.request('POST','/v1/spaces',{}),{code:'OUTCOME_UNKNOWN'});
  assert.equal(calls,1);
  let reads=0;
  const partial=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{
      reads++;
      return reads===1 ? new Response(new ReadableStream({pull(controller){controller.error(new Error('broken body'));}}))
        : Response.json({ok:true});
    },sleep:async()=>{}});
  assert.deepEqual(await partial.request('GET','/v1/spaces'),{ok:true});
  assert.equal(reads,2);
  reads=0;
  await assert.rejects(partial.request('POST','/v1/spaces',{}),{code:'OUTCOME_UNKNOWN'});
  assert.equal(reads,1);
  assert.throws(()=>new StateplaneHttpClient({endpoint:'not a URL',token:'secret'}),
    {code:'INVALID_CONFIGURATION'});
  let sent=0;
  const presend=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{sent++;return Response.json({ok:true});}});
  const circular={};circular.self=circular;
  await assert.rejects(presend.request('POST','/v1/spaces',circular),{code:'INVALID_ARGUMENT'});
  assert.equal(sent,0);
});

test('unknown COMMIT on a read retries safely while a write remains outcome-unknown',async()=>{
  const state=fixture();
  let readCalls=0,writeCalls=0;
  state.services.records.count=async()=>{
    readCalls++;
    if (readCalls===1) throw Object.assign(new Error('private commit cause'),{name:'CommitOutcomeUnknownError'});
    return 1;
  };
  state.services.records.mutate=async()=>{
    writeCalls++;
    throw Object.assign(new Error('private commit cause'),{name:'CommitOutcomeUnknownError'});
  };
  const handler=createHttpHandler(state);
  const readPath='/v1/spaces/sp_a/collections/entries/records/count';
  const writePath='/v1/spaces/sp_a/collections/entries/records';
  const request=(path,body)=>new Request(`http://127.0.0.1${path}`,{method:'POST',
    headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},body:JSON.stringify(body)});
  const first=await handler(request(readPath,[]));
  assert.equal(first.status,503);
  assert.equal(first.headers.get('Retry-After'),'1');
  assert.deepEqual((await first.json()).error.code,'COMMIT_OUTCOME_UNKNOWN');
  readCalls=0;
  const client=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret-test-token',
    fetch:(url,options)=>handler(new Request(url,options)),sleep:async()=>{}});
  assert.equal(await client.request('POST',readPath,[]),1);
  assert.equal(readCalls,2);
  const write=await handler(request(writePath,{operation:'create'}));
  assert.equal(write.status,503);
  assert.equal(write.headers.get('Retry-After'),null);
  assert.equal((await write.json()).error.retryable,false);
  await assert.rejects(client.request('POST',writePath,{operation:'create'}),
    {code:'COMMIT_OUTCOME_UNKNOWN',retryable:false});
  assert.equal(writeCalls,2);
});

test('decoded read routes retain safe retry and normalized paths cannot carry credentials elsewhere',async()=>{
  const state=fixture();
  let readCalls=0,writeCalls=0;
  state.services.records.query=async()=>{
    readCalls++;
    if (readCalls%2===1) throw Object.assign(new Error('private commit cause'),{name:'CommitOutcomeUnknownError'});
    return {records:[],nextCursor:null};
  };
  state.services.records.count=async()=>{
    readCalls++;
    if (readCalls%2===1) throw Object.assign(new Error('private commit cause'),{name:'CommitOutcomeUnknownError'});
    return 1;
  };
  state.services.records.mutate=async()=>{
    writeCalls++;
    throw Object.assign(new Error('private commit cause'),{name:'CommitOutcomeUnknownError'});
  };
  const handler=createHttpHandler(state);
  const client=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret-test-token',
    fetch:(url,options)=>handler(new Request(url,options)),sleep:async()=>{}});
  const base='/v1/spaces/sp_a/collections/entries/records';
  for (const action of ['%71uery','%63ount']) {
    const path=`${base}/${action}`;
    const first=await handler(new Request(`http://127.0.0.1${path}`,{method:'POST',
      headers:{Authorization:'Bearer secret-test-token','Content-Type':'application/json'},body:'[]'}));
    assert.equal((await first.json()).error.retryable,true);
    assert.equal(first.headers.get('Retry-After'),'1');
    readCalls=0;
    assert.deepEqual(await client.request('POST',path,[]),
      action==='%71uery'?{records:[],nextCursor:null}:1);
    assert.equal(readCalls,2);
    readCalls=0;
  }
  await assert.rejects(client.request('POST',base,{operation:'create'}),
    {code:'COMMIT_OUTCOME_UNKNOWN',retryable:false});
  assert.equal(writeCalls,1);
  let sent=0;
  const scoped=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret-test-token',
    fetch:async()=>{sent++;return Response.json({ok:true});}});
  for (const route of ['/v1/../api/health','/v1/%2e%2e/api/health',
    '/v1/spaces/sp_a/../../../api/health'])
    await assert.rejects(scoped.request('GET',route),{code:'INVALID_ARGUMENT'});
  assert.equal(sent,0);
});

test('a concurrent endpoint and token switch cannot mix credentials or selected spaces',async t=>{
  const receivedA=[],receivedB=[];
  const listener=requests=>createServer((req,res)=>{
    requests.push({path:req.url,authorization:req.headers.authorization});
    res.writeHead(200,{'Content-Type':'application/json'});res.end('[]');
  });
  const a=listener(receivedA),b=listener(receivedB);
  a.listen(0,'127.0.0.1');b.listen(0,'127.0.0.1');
  await Promise.all([once(a,'listening'),once(b,'listening')]);
  t.after(()=>{a.close();b.close();});
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-snapshot-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const endpointA=`http://127.0.0.1:${a.address().port}/`;
  const endpointB=`http://127.0.0.1:${b.address().port}/`;
  await saveConfigWithRoot(root,{endpoint:endpointA,space:'sp_old',tokenStore:'file'});
  await writeFile(join(root,'token'),'old-secret',{mode:0o600});
  const attempted=join(root,'lock-attempted');
  const preload=join(root,'observe-lock.mjs');
  await writeFile(preload,`import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const original=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql) {
  if (sql==='BEGIN IMMEDIATE') writeFileSync(${JSON.stringify(attempted)},'ready');
  return original.call(this,sql);
};`);
  let command;
  await withConfigMutationInRoot(root,async()=>{
    await writeFile(join(root,'token'),'new-secret',{mode:0o600});
    command=cliProcess(root,['collections','list'],'',['--import',preload]);
    // Observe the child's BEGIN attempt while this process holds the lock.
    // A fixed delay could pass without exercising the cross-process race.
    let ready=false;
    for (let i=0;i<200;i++) {
      try { ready=(await stat(attempted)).isFile(); } catch(error) {
        if (error.code!=='ENOENT') throw error;
      }
      if (ready) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(ready,true,'child attempted the configuration lock');
    await saveConfig({endpoint:endpointB,space:'sp_new',tokenStore:'file'});
  });
  const result=await command;
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(receivedA,[]);
  assert.deepEqual(receivedB,[{path:'/v1/spaces/sp_new/collections',authorization:'Bearer new-secret'}]);
  assert.doesNotMatch(result.stdout+result.stderr,/old-secret|new-secret/);
});

test('equals-form flags preserve identifiers beginning with option syntax',async t=>{
  const state=fixture();
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-flags-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await saveConfigWithRoot(root,{endpoint,space:'sp_a',tokenStore:'file'});
  await writeFile(join(root,'token'),'secret-test-token',{mode:0o600});
  const byKey=await cliProcess(root,['records','key','--collection','entries','--mode','external',
    '--key=--special']);
  assert.equal(byKey.status,0,byKey.stderr);
  assert.equal(JSON.parse(byKey.stdout).key,'--special');
  const byId=await cliProcess(root,['records','get','--collection','entries','--id=--special']);
  assert.equal(byId.status,0,byId.stderr);
  assert.equal(JSON.parse(byId.stdout).ref.id,'--special');
  const created=await cliProcess(root,['records','create','--collection','entries',
    '--idempotency-key=--special','--data','{}']);
  assert.equal(created.status,0,created.stderr);
  assert.equal(state.calls,1);
  const ambiguous=await cliProcess(root,['records','get','--collection','entries','--id','--special']);
  assert.equal(JSON.parse(ambiguous.stderr).error.code,'INVALID_ARGUMENT');
  assert.doesNotMatch(created.stdout+created.stderr,/secret-test-token/);
});

test('macOS Keychain stores and reloads a token without passing it as a process argument',
  {skip:platform()!=='darwin' || process.env.STATEPLANE_KEYCHAIN_INTERACTIVE_TESTS!=='1'},async()=>{
    const endpoint=`https://keychain-${randomUUID()}.example.invalid/`;
    const token=`token-${randomUUID()}`;
    const root=await mkdtemp(join(tmpdir(),'stateplane-cli-keychain-'));
    try {
      await saveToken(endpoint,token,'keychain');
      assert.equal(await loadToken({endpoint,tokenStore:'keychain'}),token);
      await removeToken({endpoint,tokenStore:'keychain'});
      await removeToken({endpoint,tokenStore:'keychain'});
      await writeFile(join(root,'config.json'),JSON.stringify({endpoint,tokenStore:'keychain'}),{mode:0o600});
      await saveToken(endpoint,token,'keychain');
      await assert.rejects(withConfigMutationInRoot(root,current=>logoutConfig(current,{
        removeTrackedTokens,
        saveConfig:async()=>{throw new Error('interrupted after keychain deletion');}
      })),/interrupted after keychain deletion/);
      await assert.rejects(loadToken({endpoint,tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
      assert.equal(JSON.parse(await readFile(join(root,'config.json'),'utf8')).tokenStore,'keychain');
      const logout=await cliProcess(root,['auth','logout']);
      assert.equal(logout.status,0,logout.stderr);
      assert.deepEqual(JSON.parse(logout.stdout),{configured:false});
      assert.equal(JSON.parse(await readFile(join(root,'config.json'),'utf8')).tokenStore,undefined);
    } finally {
      await removeToken({endpoint,tokenStore:'keychain'});
      await rm(root,{recursive:true,force:true});
    }
  });

test('macOS Keychain reports a missing item as unauthenticated',
  {skip:platform()!=='darwin'},async()=>{
    await assert.rejects(loadToken({endpoint:`https://missing-${randomUUID()}.example.invalid/`,
      tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
  });

test('macOS Keychain does not silently trust a second Swift script',
  {skip:platform()!=='darwin'},async()=>{
    const endpoint=`https://caller-${randomUUID()}.example.invalid/`;
    const service=`stateplane:${endpoint}`;
    const token=`disposable-${randomUUID()}`;
    const root=await mkdtemp(join(tmpdir(),'stateplane-keychain-caller-'));
    const probe=join(root,'alternate.swift');
    const helper='packages/cli/bin/keychain.swift';
    const swift=(script,operation,input='')=>spawnSync('/usr/bin/xcrun',
      ['--sdk','macosx','swift',script,operation,service],
      {encoding:'utf8',input,timeout:5000});
    try {
      await writeFile(probe,`import Foundation\nimport Security\nlet query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,\n  kSecAttrAccount as String:"default",kSecAttrService as String:CommandLine.arguments[2],\n  kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]\nvar result:CFTypeRef?\nlet status=SecItemCopyMatching(query as CFDictionary,&result)\nif status == errSecSuccess, let data=result as? Data { FileHandle.standardOutput.write(data) }\nelse { exit(1) }\n`);
      const stored=swift(helper,'store',token);
      assert.equal(stored.status,0,'disposable Keychain item must be created');
      const other=swift(probe,'load');
      assert.notEqual(other.stdout,token,'another Swift script must not decrypt silently');
      assert.ok(other.status!==0 || other.error?.code==='ETIMEDOUT');
    } finally {
      const removed=swift(helper,'remove');
      assert.equal(removed.status,0,'disposable Keychain item must be removed');
      await rm(root,{recursive:true,force:true});
    }
  });

test('interrupted credential store switches and logout remove both tracked secrets',async()=>{
  let initial={endpoint:'https://store-transition.example.invalid/'};
  await assert.rejects(configureToken(initial,'new-secret','file',{
    saveConfig:async value=>{initial=structuredClone(value);},
    saveToken:async()=>{throw new Error('interrupted');},
    removeToken:async()=>{throw new Error('unexpected cleanup');}
  }),/interrupted/);
  const initialCleanup=[];
  await removeTrackedTokens(initial,{removeToken:async config=>{initialCleanup.push(config.tokenStore);}});
  assert.deepEqual(initialCleanup,['file'],'first file login never probes an unavailable OS store');

  for (const from of ['file','keychain']) for (const failAt of [1,2,3,4,5]) {
    const to=from==='file'?'keychain':'file';
    const endpoint='https://store-transition.example.invalid/';
    let saved={endpoint,tokenStore:from};
    const secrets=new Map([[from,'old-secret']]);
    let step=0;
    const fail=()=>{ if (++step===failAt) throw new Error('interrupted'); };
    const io={
      saveConfig:async value=>{fail();saved=structuredClone(value);},
      saveToken:async (_endpoint,token,store)=>{fail();secrets.set(store,token);},
      removeToken:async config=>{fail();secrets.delete(config.tokenStore);}
    };
    await assert.rejects(configureToken(saved,'new-secret',to,io),/interrupted/);
    assert.ok(secrets.size>0 || failAt===5);
    const removed=[];
    const cleanup={removeToken:async config=>{
      removed.push(config.tokenStore);
      secrets.delete(config.tokenStore);
    }};
    await removeTrackedTokens(saved,cleanup);
    assert.equal(secrets.size,0,`${from} to ${to}, interruption ${failAt}`);
    assert.deepEqual(new Set(removed),new Set(saved.tokenLocations??[saved.tokenStore]));
  }

  // A failed old-store removal leaves the transition marker persisted. A
  // subsequent logout must retry both stores without printing either secret.
  let saved={endpoint:'https://store-transition.example.invalid/',tokenStore:'file'};
  const secrets=new Map([['file','old-secret']]);
  const io={
    saveConfig:async value=>{saved=structuredClone(value);},
    saveToken:async (_endpoint,token,store)=>{secrets.set(store,token);},
    removeToken:async config=>{if (config.tokenStore==='file') throw new Error('store unavailable');
      secrets.delete(config.tokenStore);}
  };
  await assert.rejects(configureToken(saved,'new-secret','keychain',io),/store unavailable/);
  assert.equal(saved.tokenStore,'keychain');
  assert.deepEqual(new Set(saved.tokenLocations),new Set(['file','keychain']));
  assert.equal(secrets.get('file'),'old-secret');
  assert.equal(secrets.get('keychain'),'new-secret');
  await removeTrackedTokens(saved,{removeToken:async config=>{secrets.delete(config.tokenStore);}});
  assert.equal(secrets.size,0);

  for (const from of ['file','keychain']) {
    const to=from==='file'?'keychain':'file';
    let journal={endpoint:'https://store-transition.example.invalid/',tokenStore:from};
    const credentials=new Map([[from,'old-secret']]);
    await assert.rejects(configureToken(journal,'new-secret',to,{
      saveConfig:async value=>{journal=structuredClone(value);},
      saveToken:async (_endpoint,token,store)=>{credentials.set(store,token);},
      removeToken:async config=>{if (config.tokenStore===from) throw new Error('old store failed');
        credentials.delete(config.tokenStore);}
    }),/old store failed/);
    const attempted=[];
    await assert.rejects(removeTrackedTokens(journal,{removeToken:async config=>{
      attempted.push(config.tokenStore);
      if (config.tokenStore===from) throw new Error('old store failed');
      credentials.delete(config.tokenStore);
    }}),/old store failed/);
    assert.deepEqual(attempted,[from,to]);
    assert.deepEqual([...credentials.keys()],[from],
      'logout removes the active credential even if obsolete storage fails');
    assert.deepEqual(journal.tokenLocations,[from,to],
      'failed cleanup retains both locations for retry');
    await removeTrackedTokens(journal,{removeToken:async config=>{credentials.delete(config.tokenStore);}});
    assert.equal(credentials.size,0);
  }
});

test('installed CLI switches file and macOS Keychain stores and cleans an interrupted switch',
  {skip:platform()!=='darwin' || process.env.STATEPLANE_KEYCHAIN_INTERACTIVE_TESTS!=='1'},async()=>{
    const root=await mkdtemp(join(tmpdir(),'stateplane-cli-switch-'));
    const endpoint=`https://switch-${randomUUID()}.example.invalid/`;
    const token=`secret-${randomUUID()}`;
    try {
      const cli=(args,input)=>cliProcess(root,args,input);
      assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
      for (const store of ['file','keychain','file']) {
        const result=await cli(['auth','import','--token-stdin','--store',store],token+'\n');
        assert.equal(result.status,0,result.stderr);
        assert.equal((result.stdout+result.stderr).includes(token),false);
        assert.equal(store==='file'?await readFile(join(root,'token'),'utf8'):
          await loadToken({endpoint,tokenStore:store}),token);
      }
      await assert.rejects(loadToken({endpoint,tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
      // Simulate a process stopping after the new Keychain item is written.
      await writeFile(join(root,'config.json'),JSON.stringify({endpoint,tokenStore:'file',
        tokenLocations:['file','keychain']}),{mode:0o600});
      await saveToken(endpoint,token,'keychain');
      const logout=await cli(['auth','logout']);
      assert.equal(logout.status,0,logout.stderr);
      assert.equal((logout.stdout+logout.stderr).includes(token),false);
      await assert.rejects(readFile(join(root,'token'),'utf8'),{code:'ENOENT'});
      await assert.rejects(loadToken({endpoint,tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
      // An obsolete file location fails cleanup, but the active Keychain
      // credential must still be removed and the journal kept for retry.
      await mkdir(join(root,'token'));
      await saveToken(endpoint,token,'keychain');
      await writeFile(join(root,'config.json'),JSON.stringify({endpoint,tokenStore:'keychain',
        tokenLocations:['file','keychain']}),{mode:0o600});
      const interrupted=await cli(['auth','logout']);
      assert.equal(interrupted.status,1);
      assert.equal((interrupted.stdout+interrupted.stderr).includes(token),false);
      assert.equal(JSON.parse((await readFile(join(root,'config.json'),'utf8')).trim()).tokenStore,'keychain');
      await assert.rejects(loadToken({endpoint,tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
      await rm(join(root,'token'),{recursive:true});
      const retry=await cli(['auth','logout']);
      assert.equal(retry.status,0,retry.stderr);
      assert.equal((retry.stdout+retry.stderr).includes(token),false);
    } finally {
      await removeToken({endpoint,tokenStore:'keychain'});
      await rm(root,{recursive:true,force:true});
    }
  });

test('HTTP and CLI no-op space updates deny metadata after owner revocation during regional read',async t=>{
  const spaceId='sp_a';
  const row={space_id:spaceId,owner_principal_id:'owner',home_cell_id:'cell-a',cell_id:'cell-a',
    storage_target_id:'target-a',lifecycle:'active',policy_version:1,placement_generation:1,
    created_at:new Date(),updated_at:new Date()};
  let current=true;let providerDown=false;let gate;
  const control={query:async()=>({rows:[row]})};
  const regional={query:async()=>{
    gate.enter();
    await gate.wait;
    return {rows:[{home_cell_id:'cell-a',lifecycle:'active',policy_version:1,placement_generation:1}]};
  }};
  const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool:regional,storageTargetId:'target-a'}]]),
    'cell-a',{}, {current:async()=>{
      if (providerDown) throw new Error('private provider failure');
      return current;
    }});
  const state=fixture();state.services.spaces.update=(...args)=>spaces.update(...args);
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const newGate=()=>{
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const wait=new Promise(resolve=>{release=resolve;});
    return {enter,entered,wait,release};
  };
  const headers={Authorization:'Bearer secret-test-token','Content-Type':'application/json'};
  gate=newGate();
  const directPending=fetch(new URL('v1/spaces/sp_a',endpoint),{
    method:'PATCH',headers,body:JSON.stringify({lifecycle:'active'})});
  await gate.entered;
  current=false;gate.release();
  const directResponse=await directPending;
  assert.equal(directResponse.status,403);
  const direct=await directResponse.json();
  assert.equal(direct.error.code,'FORBIDDEN');

  const root=await mkdtemp(join(tmpdir(),'stateplane-cli-lifecycle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'config.json'),JSON.stringify({endpoint,tokenStore:'file'}),{mode:0o600});
  await writeFile(join(root,'token'),'secret-test-token',{mode:0o600});
  current=true;gate=newGate();
  const cliPending=cliProcess(root,['spaces','update','--space',spaceId,'--lifecycle','active']);
  await gate.entered;
  current=false;gate.release();
  assertErrorParity(direct,await cliPending);

  current=true;providerDown=false;gate=newGate();
  const unavailablePending=fetch(new URL('v1/spaces/sp_a',endpoint),{
    method:'PATCH',headers,body:JSON.stringify({lifecycle:'active'})});
  await gate.entered;
  providerDown=true;gate.release();
  const unavailableResponse=await unavailablePending;
  assert.equal(unavailableResponse.status,503);
  const unavailable=await unavailableResponse.json();
  assert.equal(unavailable.error.code,'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailable),/private provider failure/);
  providerDown=false;gate=newGate();
  const cliUnavailable=cliProcess(root,['spaces','update','--space',spaceId,'--lifecycle','active']);
  await gate.entered;
  providerDown=true;gate.release();
  assertErrorParity(unavailable,await cliUnavailable);

  providerDown=false;gate=newGate();
  const recovered=fetch(new URL('v1/spaces/sp_a',endpoint),{
    method:'PATCH',headers,body:JSON.stringify({lifecycle:'active'})});
  await gate.entered;
  gate.release();
  assert.equal((await (await recovered).json()).lifecycle,'active');
});

test('concurrent logout and endpoint changes clean both secret stores after a switch',
  {skip:platform()!=='darwin' || process.env.STATEPLANE_KEYCHAIN_INTERACTIVE_TESTS!=='1'},async()=>{
    for (const from of ['file','keychain']) for (const action of ['logout','endpoint']) {
      const to=from==='file'?'keychain':'file';
      const root=await mkdtemp(join(tmpdir(),'stateplane-cli-race-secret-'));
      const endpoint=`https://race-${randomUUID()}.example.invalid/`;
      const token=`secret-${randomUUID()}`;
      let release;
      try {
        assert.equal((await cliProcess(root,['config','endpoint','--url',endpoint])).status,0);
        assert.equal((await cliProcess(root,['auth','import','--token-stdin','--store',from],token+'\n')).status,0);
        let entered;
        const locked=new Promise(resolve=>{entered=resolve;});
        const gate=new Promise(resolve=>{release=resolve;});
        const switchStore=withConfigMutationInRoot(root,async current=>{
          entered();
          await gate;
          await configureToken(current,token,to);
        });
        await locked;
        const args=action==='logout'?['auth','logout']:
          ['config','endpoint','--url',`https://next-${randomUUID()}.example.invalid/`];
        const cleanup=cliProcess(root,args);
        let settled=false;
        cleanup.then(()=>{settled=true;});
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.equal(settled,false,'cleanup waits for the in-progress store switch');
        release();release=undefined;
        await switchStore;
        const result=await cleanup;
        assert.equal(result.status,0,result.stderr);
        assert.equal((result.stdout+result.stderr).includes(token),false);
        await assert.rejects(readFile(join(root,'token'),'utf8'),{code:'ENOENT'});
        await assert.rejects(loadToken({endpoint,tokenStore:'keychain'}),{code:'UNAUTHENTICATED'});
        const saved=JSON.parse(await readFile(join(root,'config.json'),'utf8'));
        assert.equal(saved.tokenStore,undefined);
        assert.equal(saved.tokenLocations,undefined);
        if (action==='endpoint') assert.notEqual(saved.endpoint,endpoint);
      } finally {
        release?.();
        await removeToken({endpoint,tokenStore:'keychain'}).catch(()=>{});
        await rm(root,{recursive:true,force:true});
      }
    }
  });

test('HTTP and CLI selected-space retries deny metadata when owner access is revoked during the directory lock wait',async t=>{
  const spaceId=`sp_${randomUUID()}`;
  const owner='owner';
  const row={space_id:spaceId,owner_principal_id:owner,home_cell_id:'cell-a',cell_id:'cell-a',
    storage_target_id:'target-a',lifecycle:'provisioning',policy_version:1,placement_generation:1,
    created_at:new Date(),updated_at:new Date()};
  let granted=true;
  let gate;
  const control={
    query:async()=>({rows:[row]}),
    connect:async()=>({
      query:async sql=>{
        if (sql.includes('FOR UPDATE')) {
          gate.enter();
          await gate.wait;
          return {rows:[{...row,lifecycle:'active'}]};
        }
        return {rows:[]};
      },
      release:()=>{}
    })
  };
  const spaces=new PostgresSpaces(control,new Map([['cell-a',{pool:{},storageTargetId:'target-a'}]]),
    'cell-a',{}, {current:async()=>granted});
  const state=fixture();
  state.services.spaces.create=(...args)=>spaces.create(...args);
  const {server,endpoint}=await serve(createHttpHandler(state));
  t.after(()=>server.close());
  const retryBody=JSON.stringify({spaceId});
  const newGate=()=>{
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;});
    const wait=new Promise(resolve=>{release=resolve;});
    return {enter,entered,wait,release};
  };
  const headers={Authorization:'Bearer secret-test-token','Content-Type':'application/json'};
  gate=newGate();
  const directPending=fetch(new URL('v1/spaces',endpoint),{method:'POST',headers,body:retryBody});
  await gate.entered;
  granted=false;
  gate.release();
  const directResponse=await directPending;
  assert.equal(directResponse.status,403);
  const direct=await directResponse.json();
  assert.equal(direct.error.code,'FORBIDDEN');

  const cliRoot=await mkdtemp(join(tmpdir(),'stateplane-cli-revoked-'));
  t.after(()=>rm(cliRoot,{recursive:true,force:true}));
  await writeFile(join(cliRoot,'config.json'),JSON.stringify({endpoint,tokenStore:'file'}),{mode:0o600});
  await writeFile(join(cliRoot,'token'),'secret-test-token',{mode:0o600});
  granted=true;
  gate=newGate();
  const cliPending=cliProcess(cliRoot,['spaces','create','--space',spaceId]);
  await gate.entered;
  granted=false;
  gate.release();
  assertErrorParity(direct,await cliPending);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { StateplaneHttpClient, StateplaneCliError } from '../packages/cli/dist/index.js';
import { saveToken, loadToken, removeToken } from '../packages/cli/dist/config.js';

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
async function cliProcess(root,argv,input='') {
  const child=spawn(process.execPath,['packages/cli/bin/stateplane.js',...argv],{
    cwd:process.cwd(),env:{...process.env,STATEPLANE_CONFIG_DIR:root},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(input);
  const [status]=await once(child,'close');
  return {status,stdout,stderr};
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
  await assert.rejects(readFile(join(cliRoot,'token'),'utf8'),{code:'ENOENT'});
  assert.equal(JSON.parse((await cli(['config','show'])).stdout).tokenStore,null);
  assert.equal((await cli(['config','endpoint','--url',endpoint])).status,0);
  const invalid=await cliProcess(cliRoot,['auth','login','--token-stdin','--store','file'],'bad-secret\n');
  const invalidHttp=await fetch(endpoint+'v1/auth/session',{headers:{Authorization:'Bearer bad-secret'}});
  assertErrorParity(await invalidHttp.json(),invalid);
  assert.doesNotMatch(invalid.stderr,/bad-secret/);
  await assert.rejects(readFile(join(cliRoot,'token'),'utf8'),{code:'ENOENT'});
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
});

test('macOS Keychain stores and reloads a token without passing it as a process argument',
  {skip:platform()!=='darwin'},async()=>{
    const endpoint=`https://keychain-${randomUUID()}.example.invalid/`;
    const token=`token-${randomUUID()}`;
    try {
      await saveToken(endpoint,token,'keychain');
      assert.equal(await loadToken({endpoint,tokenStore:'keychain'}),token);
    } finally { await removeToken({endpoint,tokenStore:'keychain'}); }
  });

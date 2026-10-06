import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { StateplaneHttpClient, StateplaneCliError } from '../packages/cli/dist/index.js';

function fixture() {
  let granted=true; let providerDown=false; let commitUnknown=false; let calls=0;
  const saved=new Map();
  const denied=()=>{ if (!granted) throw Object.assign(new Error('private data'),{code:'NOT_FOUND'}); };
  const services={
    spaces:{list:async()=>[],create:async()=>({spaceId:'sp_a'}),get:async()=>{denied();return {spaceId:'sp_a'};},
      update:async()=>({spaceId:'sp_a'}),delete:async()=>({deleted:true})},
    collections:{list:async()=>{denied();return [];},define:async()=>({slug:'entries'}),revise:async()=>({slug:'entries'})},
    records:{
      get:async(_actor,_space,_collection,id)=>{denied();return {ref:{id},revision:1};},
      byKey:async()=>null,
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
      progress:async()=>{denied();return {operationKey:'batch-1',state:'active',items:[]};},
      cancel:async()=>({operationKey:'batch-1',state:'cancelled',items:[]})},
    events:{list:async()=>{denied();return {events:[],nextCursor:null};},
      projection:async()=>{denied();return {state:'pending',generation:1,revision:1};}}
  };
  const identity={verify:async request=>{
    if (providerDown) throw new Error(`provider failure ${request.headers.get('authorization')}`);
    return request.headers.get('authorization')==='Bearer secret-test-token'
      ? {kind:'session',userPrincipalId:'owner',credentialId:'session-1'} : null;
  }};
  return {services,identity,revoke:()=>{granted=false;},failProvider:()=>{providerDown=true;},
    unknownCommit:()=>{commitUnknown=true;},get calls(){return calls;}};
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
  const result=await cli(['records','create','--collection','entries','--data','{"label":"A"}',
    '--idempotency-key','req-a']);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual({...JSON.parse(result.stdout),replayed:false},direct);
  assert.equal(state.calls,2);
  state.unknownCommit();
  const uncertain=await cli(['records','create','--collection','entries','--data','{"label":"B"}',
    '--idempotency-key','req-b']);
  assert.equal(uncertain.status,1);
  assert.equal(JSON.parse(uncertain.stderr).error.code,'COMMIT_OUTCOME_UNKNOWN');
  assert.doesNotMatch(uncertain.stderr,/secret commit cause|secret-test-token/);
  const page=await cli(['records','query','--collection','entries','--predicates','[]','--limit','1']);
  assert.equal(JSON.parse(page.stdout).nextCursor,'cursor-next');
  await assert.rejects(client.request('POST',route+'/query',{predicates:[],limit:1,cursor:'bad'}),
    {code:'CURSOR_INVALID'});
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
  assert.equal(failed.status,1);
  assert.doesNotMatch(failed.stderr,/provider failure|secret-test-token/);
  const badAuth=await fetch(endpoint+'v1/spaces',{headers:{Authorization:'Bearer bad-secret'}});
  assert.equal(badAuth.status,503);
  assert.doesNotMatch(await badAuth.text(),/provider failure|bad-secret/);
  const changed=await cli(['config','endpoint','--url','http://127.0.0.1:43210/']);
  assert.equal(changed.status,0);
  await assert.rejects(readFile(join(cliRoot,'token'),'utf8'),{code:'ENOENT'});
  assert.equal(JSON.parse((await cli(['config','show'])).stdout).tokenStore,null);
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
  const rejected=new StateplaneHttpClient({endpoint:'http://127.0.0.1/',token:'secret',
    fetch:async()=>{calls++;return Response.json({error:{code:'BACKPRESSURE',requestId:'r1'}},
      {status:503,headers:{'Retry-After':'0'}});},sleep:async()=>{}});
  await assert.rejects(rejected.request('POST','/v1/spaces',{}),{code:'BACKPRESSURE'});
  assert.equal(calls,1);
});

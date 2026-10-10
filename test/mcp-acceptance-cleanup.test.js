import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitReady, finalizers, gateMode, hostBackend, loopbackForwarder, runGate, selectBackend, startLineProcess } from '../scripts/mcp-acceptance-hosts.mjs';

test('acceptance cleanup runs every step after a failure and reports it incomplete',async()=>{
  const cleanup=finalizers();
  const ran=[];
  cleanup.add(()=>{ ran.push('remove secrets'); });
  cleanup.add(()=>{ ran.push('stop app'); throw new Error('kill failed'); });
  cleanup.add(async()=>{ ran.push('end pool'); });
  cleanup.add(async()=>{ ran.push('erase spaces'); throw new Error('HTTP DELETE failed'); });
  assert.equal(cleanup.size,4);
  await assert.rejects(cleanup.run(),error=>error instanceof AggregateError && error.errors.length===2 &&
    /HTTP DELETE failed; kill failed/.test(error.message));
  assert.deepEqual(ran,['erase spaces','end pool','stop app','remove secrets'],'reverse order, nothing skipped');
  assert.equal(cleanup.size,0);
  await cleanup.run();
  assert.equal(ran.length,4,'a step runs once');
});

const missing=`stateplane-missing-command-${process.pid}`;

test('a client that cannot spawn fails the gate without an uncaught error and still runs backend cleanup',async()=>{
  const record={result:'failed'};
  const ran=[];
  const failure=await runGate(record,async cleanup=>{
    cleanup.add(()=>{ ran.push('backend'); });
    await startLineProcess(missing,[],{cleanup,env:{...process.env,STATEPLANE_MCP_TOKEN:'secret-token'},secrets:['secret-token'],timeoutMs:5_000});
  });
  assert.equal(failure?.message.includes('ENOENT'),true,String(failure?.message));
  assert.deepEqual(ran,['backend']);
  assert.deepEqual({result:record.result,cleanup:record.cleanup,cleanupSteps:record.cleanupSteps},
    {result:'failed',cleanup:'complete',cleanupSteps:2});
  assert.doesNotMatch(record.error,/secret-token/);
});

test('a client that stalls before ready is terminated and awaited by cleanup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stateplane-stall-'));
  try {
    const pidFile=join(directory,'pid');
    // The child ignores stdin EOF and SIGTERM, so only the SIGKILL step can end it.
    const child=`require('node:fs').writeFileSync(process.env.PID_FILE,String(process.pid));
      process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    const record={};
    const failure=await runGate(record,cleanup=>startLineProcess(process.execPath,['-e',child],
      {cleanup,env:{...process.env,PID_FILE:pidFile},timeoutMs:3_000,graceMs:100}));
    assert.match(String(failure?.message),/timed out after 3000 ms/);
    assert.deepEqual({result:record.result,cleanup:record.cleanup,cleanupSteps:record.cleanupSteps},
      {result:'failed',cleanup:'complete',cleanupSteps:1});
    const pid=Number(await readFile(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'the child is gone once cleanup reports complete');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('a client that answers but is not ready is terminated by cleanup',async()=>{
  const record={};
  let pid;
  const failure=await runGate(record,async cleanup=>{
    await startLineProcess(process.execPath,['-e',`console.log(JSON.stringify({ready:false,pid:process.pid}));setInterval(()=>{},1000);`],
      {cleanup,timeoutMs:10_000,graceMs:100}).catch(error=>{ pid=Number(/"pid":(\d+)/.exec(error.message)?.[1]); throw error; });
  });
  assert.match(String(failure?.message),/did not initialize/);
  assert.equal(record.cleanup,'complete');
  assert.ok(pid>0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('evidence names the backend that ran',()=>{
  assert.equal(gateMode({runtime:'node-in-process'}),'in-process-authfn');
  assert.equal(gateMode({runtime:'workerd'}),'local-workerd-host');
  assert.equal(gateMode({runtime:'external'}),'external-host');
});

test('an external endpoint without --host fails fast instead of running in process',()=>{
  const previous=process.env.STATEPLANE_MCP_ENDPOINT;
  process.env.STATEPLANE_MCP_ENDPOINT='https://preview.example/mcp';
  try { assert.throws(()=>selectBackend([],finalizers()),/add --host/); }
  finally { if (previous===undefined) delete process.env.STATEPLANE_MCP_ENDPOINT; else process.env.STATEPLANE_MCP_ENDPOINT=previous; }
});

async function listen(handler) {
  const server=createServer(handler);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return {server,origin:`http://127.0.0.1:${server.address().port}`,
    close:()=>new Promise(resolve=>{ server.closeAllConnections(); server.close(()=>resolve()); })};
}

test('the forwarder relays a compressed upstream faithfully and rewrites only its own origin',async()=>{
  let upstreamOrigin;
  let requests=0;
  // Like a deployed endpoint: gzip responses, and any foreign Origin is rejected.
  const upstream=await listen((req,res)=>{
    requests++;
    if (req.headers.origin!==undefined && req.headers.origin!==upstreamOrigin) { res.writeHead(403).end(); return; }
    const body=gzipSync(JSON.stringify({ok:true,padding:'x'.repeat(4096)}));
    res.writeHead(401,{'content-type':'application/json','content-encoding':'gzip','content-length':String(body.length),
      'www-authenticate':'Bearer resource_metadata="x"'});
    res.end(body);
  });
  upstreamOrigin=upstream.origin;
  const cleanup=finalizers();
  try {
    const forwarder=await loopbackForwarder(`${upstream.origin}/mcp`,{cleanup});
    const own=new URL(forwarder.url).origin;
    const relayed=await fetch(forwarder.url,{method:'POST',headers:{origin:own,'accept-encoding':'gzip'},body:'{}'});
    assert.equal(relayed.status,401);
    assert.equal(relayed.headers.get('content-encoding'),null,'the decoded body is not labelled as compressed');
    assert.equal((await relayed.json()).padding.length,4096);
    for (const origin of ['http://127.0.0.1:1','http://localhost:1',own.replace('127.0.0.1','localhost'),'http://evil.example.com'])
      assert.equal((await fetch(forwarder.url,{method:'POST',headers:{origin},body:'{}'})).status,403,origin);
    assert.deepEqual(forwarder.observed[0],{status:401,wwwAuthenticate:'Bearer resource_metadata="x"'});
    // A dropped response still reached the upstream: the caller sees only a lost answer.
    forwarder.dropNextResponse(message=>message?.drop===true);
    const before=requests;
    await assert.rejects(fetch(forwarder.url,{method:'POST',body:JSON.stringify({drop:true})}));
    assert.equal(requests,before+1);
    assert.equal((await fetch(forwarder.url,{method:'POST',body:JSON.stringify({drop:true})})).status,401,'only one response is dropped');
  } finally {
    await cleanup.run();
    await upstream.close();
  }
});

/** Run with an external host's fixture variables, restoring the environment. */
async function withExternalHost(endpoint,body) {
  const names=['STATEPLANE_MCP_ENDPOINT','DATABASE_URL','STATEPLANE_TEST_TOKEN','STATEPLANE_TEST_OWNER','STATEPLANE_TEST_CREDENTIAL',
    'STATEPLANE_TEST_AGENT_TOKEN','STATEPLANE_TEST_AGENT_CREDENTIAL'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  Object.assign(process.env,{STATEPLANE_MCP_ENDPOINT:endpoint,DATABASE_URL:'postgres://fixture:unused@127.0.0.1:1/none',
    STATEPLANE_TEST_TOKEN:'t',STATEPLANE_TEST_OWNER:'o',STATEPLANE_TEST_CREDENTIAL:'c',STATEPLANE_TEST_AGENT_TOKEN:'a',
    STATEPLANE_TEST_AGENT_CREDENTIAL:'ac'});
  try { return await body(); }
  finally { for (const [name,value] of Object.entries(previous)) if (value===undefined) delete process.env[name]; else process.env[name]=value; }
}

test('a host that never answers fails the gate within its deadline and every finalizer still runs',async()=>{
  for (const stallPath of ['/.well-known/oauth-protected-resource/mcp','/v1/spaces']) {
    let origin;
    const host=await listen((req,res)=>{
      if (req.url===stallPath) return; // Accept the request and never respond.
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({resource:`${origin}/mcp`}));
    });
    origin=host.origin;
    try {
      const record={};
      const ran=[];
      const started=Date.now();
      const failure=await withExternalHost(`${origin}/mcp`,()=>runGate(record,async cleanup=>{
        cleanup.add(()=>{ ran.push('earlier finalizer'); });
        const backend=await hostBackend({cleanup,httpTimeoutMs:300});
        await backend.createSpace();
      }));
      assert.ok(Date.now()-started<10_000,`${stallPath} is bounded`);
      assert.match(String(failure?.name),/TimeoutError/,`${stallPath}: ${failure?.message}`);
      assert.equal(record.result,'failed');
      assert.deepEqual(ran,['earlier finalizer'],`${stallPath}: later finalizers run`);
    } finally { await host.close(); }
  }
});

test('a host whose health check stalls fails readiness within one overall deadline',async()=>{
  const stalled=new Set();
  const server=createServer((req,res)=>{ stalled.add(res); }); // accepts and never answers
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/health`;
    const started=Date.now();
    // Each 2 s attempt alone would exceed the deadline; the overall bound must still hold.
    await assert.rejects(awaitReady(url,{child:{exitCode:null},failed:new Promise(()=>{})},{timeoutMs:500}),
      /did not become ready within 500 ms/);
    assert.ok(Date.now()-started<1_500,`failed after ${Date.now()-started} ms`);
    assert.ok(stalled.size>=1,'the stalled endpoint was reached');
  } finally { server.closeAllConnections(); server.close(); }
});

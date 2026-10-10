import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizers, gateMode, runGate, selectBackend, startLineProcess } from '../scripts/mcp-acceptance-hosts.mjs';

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

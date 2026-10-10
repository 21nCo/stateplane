import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizers } from '../scripts/mcp-acceptance-hosts.mjs';

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

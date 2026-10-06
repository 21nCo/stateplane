import test from 'node:test';
import assert from 'node:assert/strict';

const modulePath=process.env.STATEPLANE_POSTGRES_DIST ?? '../packages/postgres/dist/index.js';
const {PostgresAuthority}=await import(modulePath);
const scope={spaceId:'sp_batch',collectionId:'entries',principalId:'agent',credentialId:'agent',
  capability:'records:write',policyVersion:1,placementGeneration:1};
const requests=Array.from({length:4},(_,ordinal)=>JSON.stringify({operation:'create',data:{label:`item-${ordinal}`}}));

test('unchanged direct and serialized retries start at the durable pending item',async()=>{
  const originalNow=Date.now;
  let now=1_000;
  Date.now=()=>now;
  try {
    for (const serialized of [false,true]) {
      now=1_000;
      const states=['succeeded','succeeded','succeeded','pending'];
      const receipts=['r0','r1','r2',null];
      const visited=[];
      const authority=new PostgresAuthority({connect(){throw Error('unexpected database call');}},3600,undefined,250);
      authority.transaction=async (_scope,callback,deadline)=>callback({
        scope,
        startBatch:async(_key,_digest,_requests,retryFailed)=>states.flatMap((state,ordinal)=>
          state==='pending' || (retryFailed && state==='failed') ? [ordinal] : []),
        processBatchItem:async(_key,ordinal)=>{
          visited.push(ordinal);
          now+=90;
          if (now>=deadline) throw Object.assign(Error('budget exhausted'),{code:'RATE_LIMITED'});
          if (states[ordinal]==='pending') { states[ordinal]='succeeded'; receipts[ordinal]=`r${ordinal}`; }
        },
        batchProgress:async()=>({operationKey:'resume',state:'active',items:states.map((state,ordinal)=>({
          ordinal,state,receipt:receipts[ordinal] && {receiptId:receipts[ordinal]}}))})
      });
      const result=serialized
        ? await authority.ingestSerializedBatch(scope,'resume',JSON.stringify(requests))
        : await authority.ingestBatch(scope,'resume',requests);
      assert.deepEqual(result.items.map(item=>item.state),Array(4).fill('succeeded'));
      assert.deepEqual(result.items.map(item=>item.receipt.receiptId),['r0','r1','r2','r3']);
      assert.deepEqual(visited,[3]);
    }
  } finally {
    Date.now=originalNow;
  }
});

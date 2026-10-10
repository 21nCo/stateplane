// Two-client core-state gate: the official TypeScript MCP SDK (through the
// McpFn production client) and the official Python MCP SDK share one space.
//
//   node scripts/test-mcp-clients.mjs                 in-process AuthFn + Postgres composition
//   node scripts/test-mcp-clients.mjs --host          the app's opt-in /mcp host under vite (Node)
//   node scripts/test-mcp-clients.mjs --host --workerd   the built app under wrangler dev (workerd)
//   STATEPLANE_MCP_ENDPOINT=https://<preview>/mcp node scripts/test-mcp-clients.mjs --host
//                                                     an already running opt-in host, such as a Preview
//
// The --host modes use the fixture identity of the opt-in host. They need
// DATABASE_URL for that host's database (loopback, or sslmode=verify-full),
// and for an external endpoint STATEPLANE_TEST_TOKEN, STATEPLANE_TEST_OWNER,
// STATEPLANE_TEST_CREDENTIAL, STATEPLANE_TEST_AGENT_TOKEN and
// STATEPLANE_TEST_AGENT_CREDENTIAL matching its configuration. Evidence without credentials is written to
// .data/mcp-two-client-evidence.json (or --evidence <path>).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { stateplaneMcpDeclaration } from '../packages/mcp/dist/index.js';
import { gateMode, runGate, selectBackend, startLineProcess } from './mcp-acceptance-hosts.mjs';

const root=resolve(import.meta.dirname,'..');
const pythonSdk='mcp==2.3.0';
const args=process.argv.slice(2);
const evidencePath=resolve(args.includes('--evidence') ? args[args.indexOf('--evidence')+1] : join(root,'.data/mcp-two-client-evidence.json'));
const commandTimeoutMs=60_000;
const evidence={formatVersion:1,kind:'stateplane.mcp-two-client-gate',startedAt:new Date().toISOString(),
  mode:null,clients:[],toolLists:{},steps:[],result:'failed'};
function assert(condition,message) { if (!condition) throw new Error(message); }
function step(client,action,outcome) {
  evidence.steps.push({client,action,...outcome});
  console.log(`${client.padEnd(10)} ${action.padEnd(34)} ${JSON.stringify(outcome)}`);
}
const summary=result=>{
  if (result.transportError) return {transportError:result.transportError};
  if (result.isError) return {error:result.structuredContent?.error?.code};
  const value=result.structuredContent??{};
  if (value.receiptId) return {id:value.ref.id,operation:value.operation,beforeRevision:value.beforeRevision,
    revision:value.revision,replayed:value.replayed,receiptId:value.receiptId};
  if (Array.isArray(value.records)) return {records:value.records.map(record=>[record.ref?.id??record.id,record.revision])};
  if (typeof value.count==='number') return {count:value.count};
  if (value.ref?.id || value.id) return {id:value.ref?.id??value.id,revision:value.revision};
  if (Array.isArray(value.events)) return {events:value.events.length};
  return {ok:true};
};

/** Read the installed version of a dependency as its dependent resolves it. */
async function packageVersion(dependent,name,entry) {
  const dependentRequire=createRequire(createRequire(import.meta.url).resolve(dependent));
  for (let directory=dirname(dependentRequire.resolve(`${name}/${entry}`));directory!==dirname(directory);directory=dirname(directory)) {
    const manifest=await readFile(join(directory,'package.json'),'utf8').then(JSON.parse,()=>null);
    if (manifest?.name===name) return manifest.version;
  }
  throw new Error(`${name} version is unavailable`);
}

/** Official TypeScript SDK client used by McpFn applications and the inspector. */
async function typeScriptClient(endpoint,token,label,cleanup) {
  const { McpFnTestClient, authenticatedHttpTarget }=await import('@mcpfn/testing');
  const sdkVersion=await packageVersion('@mcpfn/testing','@modelcontextprotocol/sdk','client/index.js');
  const client=await McpFnTestClient.connectTarget(authenticatedHttpTarget(endpoint,{credential:{kind:'api-key',
    headers:{authorization:`Bearer ${token}`}}}),{name:label,version:'1.0.0'});
  cleanup.add(()=>client.close());
  evidence.clients.push({label,sdk:'@modelcontextprotocol/sdk (TypeScript) via @mcpfn/client',sdkVersion,
    protocolVersion:client.client.transport?.protocolVersion??null,server:client.client.getServerVersion()?.name});
  return {label,list:async()=>(await client.listTools()).map(tool=>tool.name).sort(),
    call:async(tool,input)=>{
      try { const result=await client.callTool(tool,input); return {isError:!!result.isError,structuredContent:result.structuredContent}; }
      catch(error) { return {transportError:error?.name??'Error'}; }
    }};
}

/** Official Python SDK in a separate pinned process that cleanup owns from
 * spawn; its bearer is passed by environment only. */
async function pythonClient(endpoint,token,label,cleanup) {
  const {ready,send}=await startLineProcess('uv',['run','--no-project','--isolated','--quiet','--with',pythonSdk,'python','-I',
    join(root,'scripts/mcp-python-client.py')],{cleanup,cwd:root,timeoutMs:commandTimeoutMs,secrets:[token],
    env:{...process.env,STATEPLANE_MCP_URL:endpoint,STATEPLANE_MCP_TOKEN:token}});
  evidence.clients.push({label,sdk:ready.sdk,sdkVersion:ready.sdkVersion,protocolVersion:ready.protocolVersion,server:ready.server});
  return {label,list:async()=>(await send({op:'list'})).tools,call:(tool,input)=>send({op:'call',tool,arguments:input})};
}

async function scenario(backend,cleanup) {
  const spaceId=await backend.createSpace();
  const collectionId='entries';
  // Both clients are closed by the gate's cleanup, before the space is erased.
  const owner=await typeScriptClient(backend.endpoint,backend.ownerToken,'ts-owner',cleanup);
  const expected=stateplaneMcpDeclaration().manifest().tools.map(tool=>tool.name).sort();
  const call=async(client,tool,input)=>{
    const result=await client.call(tool,input);
    step(client.label,tool,summary(result));
    return result;
  };
  const value=async(client,tool,input)=>{
    const result=await call(client,tool,input);
    assert(!result.isError && !result.transportError,`${client.label} ${tool} failed: ${JSON.stringify(summary(result))}`);
    return result.structuredContent;
  };
  const code=async(client,tool,input,wanted)=>{
    const result=await call(client,tool,input);
    assert(result.isError && result.structuredContent?.error?.code===wanted,
      `${client.label} ${tool} expected ${wanted}, got ${JSON.stringify(summary(result))}`);
  };
  const s={spaceId,collectionId};
  await value(owner,'collections_define',{...s,definition:{slug:collectionId,version:1,
    schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{label:{type:'string'},
      state:{type:'string',enum:['open','closed']},score:{type:'number'}},required:['label'],additionalProperties:false},
    unique:[{name:'by_label',paths:['label']}],filterable:['state'],sortable:[]}});
  const grant=await backend.grantAgent(spaceId,collectionId,['records:read','records:write','events:read']);
  const agent=await pythonClient(backend.endpoint,grant.token,'py-agent',cleanup);
  evidence.toolLists={[owner.label]:await owner.list(),[agent.label]:await agent.list()};
  assert(JSON.stringify(evidence.toolLists[owner.label])===JSON.stringify(expected),'TypeScript client sees the fixed registry');
  assert(JSON.stringify(evidence.toolLists[agent.label])===JSON.stringify(expected),'Python client sees the same fixed registry');

  const create={...s,externalKey:' item-1 ',idempotencyKey:'agent-create-1',data:{label:'Item 1',state:'open'}};
  const first=await value(agent,'records_create',create);
  const id1=first.ref.id;
  const seen=await value(owner,'records_get',{...s,id:id1});
  assert(seen.revision===1 && (seen.ref?.id??seen.id)===id1,'owner reads the agent record at revision 1');
  const byKey=await value(owner,'records_get_by_key',{...s,mode:'external',key:'item-1'});
  assert((byKey.ref?.id??byKey.id)===id1,'normalized external key resolves the same record');
  const second=await value(owner,'records_create',{...s,externalKey:'item-2',idempotencyKey:'owner-create-2',data:{label:'Item 2',state:'open'}});
  const id2=second.ref.id;
  const page=await value(agent,'records_query',{...s,predicates:[],limit:10});
  assert(JSON.stringify(page.records.map(record=>[record.ref?.id??record.id,record.revision]))===JSON.stringify([[id1,1],[id2,1]]),
    'both clients observe the same IDs and revisions');
  const replaced=await value(owner,'records_replace',{...s,id:id1,expectedRevision:1,idempotencyKey:'owner-replace-1',
    data:{label:'Item 1',state:'closed'}});
  assert(replaced.revision===2,'replace advances the revision');
  await code(agent,'records_patch',{...s,id:id1,expectedRevision:1,idempotencyKey:'agent-patch-stale',set:{score:1},unset:[]},'REVISION_CONFLICT');
  const reread=await value(agent,'records_get',{...s,id:id1});
  assert(reread.revision===2,'the agent observes the owner revision');
  const patched=await value(agent,'records_patch',{...s,id:id1,expectedRevision:2,idempotencyKey:'agent-patch-1',set:{score:1},unset:[]});
  assert(patched.revision===3,'patch at the current revision succeeds');
  await code(owner,'records_create',{...s,externalKey:'item-1',idempotencyKey:'owner-dup-key',data:{label:'Other'}},'KEY_RESERVED');
  await code(owner,'records_create',{...s,externalKey:'item-3',idempotencyKey:'owner-dup-unique',data:{label:'Item 2'}},'UNIQUE_CONFLICT');
  // A lost response is recovered by the identical request and key on the same credential.
  const replay=await value(agent,'records_create',create);
  assert(replay.replayed===true && replay.receiptId===first.receiptId && replay.revision===1,'lost-response replay returns the original receipt');
  await code(agent,'records_create',{...create,data:{label:'Changed'}},'IDEMPOTENCY_MISMATCH');
  await code(owner,'records_create',create,'KEY_RESERVED');
  assert(await backend.backfill(spaceId,collectionId,'state'),'filter index is ready');
  const closed=await value(owner,'records_query',{...s,predicates:[{field:'state',kind:'string',operator:'eq',value:'closed'}],limit:10});
  assert(JSON.stringify(closed.records.map(record=>[record.ref?.id??record.id,record.revision]))===JSON.stringify([[id1,3]]),'typed filter is exact');
  const ownerCount=await value(owner,'records_count',{...s,predicates:[]});
  const agentCount=await value(agent,'records_count',{...s,predicates:[]});
  assert(ownerCount.count===2 && agentCount.count===2,'counts agree');
  const deleted=await value(agent,'records_delete',{...s,id:id2,expectedRevision:1,idempotencyKey:'agent-delete-2'});
  assert(deleted.operation==='delete' && deleted.revision===2,'delete tombstones the owner record');
  await code(owner,'records_get',{...s,id:id2},'NOT_FOUND');
  const events=await value(agent,'events_list',s);
  assert(events.events.length===5,'five committed changes are visible in the event feed');
  await grant.revoke();
  step('owner','revoke agent credential',{ok:true});
  const denied=await call(agent,'records_count',{...s,predicates:[]});
  assert(backend.denial==='transport' ? !!denied.transportError : denied.structuredContent?.error?.code==='NOT_FOUND',
    'the revoked credential is denied');
  const after=await value(owner,'records_count',{...s,predicates:[]});
  assert(after.count===1,'the owner continues after revocation');
}

const failure=await runGate(evidence,async cleanup=>{
  const backend=await selectBackend(args,cleanup);
  evidence.mode=gateMode(backend.endpointInfo);
  evidence.endpoint=backend.endpointInfo;
  await scenario(backend,cleanup);
});
evidence.finishedAt=new Date().toISOString();
await mkdir(dirname(evidencePath),{recursive:true});
await writeFile(evidencePath,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600});
if (failure) throw failure;
console.log(`Two distinct MCP SDK clients passed the core-state gate (${evidence.mode}); evidence: ${evidencePath}`);

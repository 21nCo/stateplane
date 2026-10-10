// McpFn protocol and semantic scenarios, plus the applicable scenarios of the
// pinned official MCP conformance runner, against one authenticated endpoint.
//
//   node scripts/test-mcp-conformance.mjs           in-process AuthFn + Postgres composition
//   node scripts/test-mcp-conformance.mjs --host    the app's opt-in /mcp host (add --workerd
//                                                   for wrangler dev); set STATEPLANE_MCP_ENDPOINT
//                                                   and its fixture variables for a running one
//
// Reports without credentials are written under .data/mcp-conformance/.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { authenticatedHttpTarget, createMcpFnTargetSuiteJUnit, disposeMcpFnTargetSuiteReport,
  OFFICIAL_CONFORMANCE_VERSION, runAuthenticatedOfficialConformance, runMcpFnTargetSuite,
  serializeMcpFnTargetSuiteReport } from '@mcpfn/testing';
import { guidanceUri, stateplaneMcpDeclaration } from '../packages/mcp/dist/index.js';
import { hostBackend, inProcessBackend } from './mcp-acceptance-hosts.mjs';

const root=resolve(import.meta.dirname,'..');
const output=join(root,'.data/mcp-conformance');
// The official server suite also targets the reference server's fixture tools,
// prompts, logging, completions, sampling and elicitation. A fixed product
// registry does not publish those, so only protocol scenarios that apply to
// any server run here; the remainder is recorded as not applicable.
const applicable=['server-initialize','ping','tools-list','resources-list','dns-rebinding-protection'];
function assert(condition,message) { if (!condition) throw new Error(message); }

/** Official runners require a loopback URL. Forward one fixed path to a deployed endpoint. */
async function loopbackForwarder(endpoint) {
  const upstream=new URL(endpoint);
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const target=new URL(upstream);
    if (new URL(req.url,'http://127.0.0.1').pathname!==upstream.pathname) { res.writeHead(404).end(); return; }
    const headers=Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length'].includes(name)));
    // Loopback tooling origins in front of this forwarder stand for the deployed
    // origin. A foreign Origin passes through and must be rejected upstream.
    try {
      if (headers.origin && ['127.0.0.1','localhost','[::1]'].includes(new URL(headers.origin).hostname)) headers.origin=upstream.origin;
    } catch { /* A malformed Origin passes through unchanged. */ }
    const response=await fetch(target,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,redirect:'manual'});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return {url:`http://127.0.0.1:${server.address().port}${upstream.pathname}`,close:()=>new Promise(r=>server.close(r))};
}

const backend=process.argv.includes('--host') ? await hostBackend({workerd:process.argv.includes('--workerd')}) : await inProcessBackend();
let forwarder;
const summary={formatVersion:1,kind:'stateplane.mcp-conformance',startedAt:new Date().toISOString(),
  endpoint:backend.endpointInfo,officialSuiteVersion:OFFICIAL_CONFORMANCE_VERSION,official:[],notApplicable:[]};
let failure;
try {
  await mkdir(output,{recursive:true,mode:0o700});
  const spaceId=await backend.createSpace();
  const collectionId='entries';
  const s={spaceId,collectionId};
  const credential={kind:'api-key',headers:{authorization:`Bearer ${backend.ownerToken}`}};
  const manifest=stateplaneMcpDeclaration().manifest();
  const definition={slug:collectionId,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',
    properties:{label:{type:'string'}},required:['label'],additionalProperties:false},unique:[],filterable:[],sortable:[]};
  const create={...s,externalKey:'scenario-1',idempotencyKey:'scenario-create',data:{label:'A'}};
  const errorCode=code=>result=>assert(result.isError && result.structuredContent?.error?.code===code,
    `expected ${code}, got ${result.content?.[0]?.text}`);
  let recordId;
  const scenarios=[
    {name:'initialize advertises tools and resources',kind:'initialize',expectCapabilities:manifest.capabilities},
    {name:'fixed tool inventory',kind:'tools.list',expectNames:manifest.tools.map(tool=>tool.name)},
    {name:'guidance resource is listed',kind:'resources.list',expectNames:['stateplane-guidance']},
    {name:'guidance resource is readable',kind:'resources.read',uri:guidanceUri},
    {name:'define a collection',tool:'collections_define',sideEffect:'non-idempotent',arguments:{...s,definition},
      expect:{isError:false,structuredTextParity:true}},
    {name:'create a record',tool:'records_create',sideEffect:'idempotent',arguments:create,
      expect:{isError:false,structuredTextParity:true},verify:result=>{
        recordId=result.structuredContent.ref.id;
        assert(result.structuredContent.revision===1 && result.structuredContent.replayed===false,'fresh receipt');
      }},
    {name:'replay the identical create',tool:'records_create',sideEffect:'idempotent',arguments:create,
      expect:{isError:false},verify:result=>assert(result.structuredContent.replayed===true &&
        result.structuredContent.ref.id===recordId,'replayed receipt')},
    {name:'changed request under the same key',tool:'records_create',sideEffect:'none',
      arguments:{...create,data:{label:'B'}},expect:{isError:true},verify:errorCode('IDEMPOTENCY_MISMATCH')},
    {name:'exact count',tool:'records_count',sideEffect:'none',arguments:{...s,predicates:[]},
      expect:{isError:false,structuredContent:{count:1},structuredTextParity:true}},
    {name:'unknown record',tool:'records_delete',sideEffect:'none',
      arguments:{...s,id:'rec_unknown',expectedRevision:1,idempotencyKey:'scenario-missing'},expect:{isError:true},verify:errorCode('NOT_FOUND')},
    {name:'schema-invalid arguments keep the stable code',tool:'records_query',sideEffect:'none',
      arguments:{...s,predicates:[],limit:0},expect:{isError:true},verify:errorCode('INVALID_ARGUMENT')},
    {name:'undeclared collection is concealed',tool:'records_count',sideEffect:'none',
      arguments:{...s,collectionId:'absent',predicates:[]},expect:{isError:true},verify:errorCode('NOT_FOUND')}
  ];
  const report=await runMcpFnTargetSuite({target:authenticatedHttpTarget(backend.endpoint,{credential}),scenarios,manifest,
    clientInfo:{name:'stateplane-conformance',version:'1.0.0'}});
  try {
    await writeFile(join(output,'mcpfn-target-suite.json'),serializeMcpFnTargetSuiteReport(report,{space:2,trailingNewline:true}),{mode:0o600});
    await writeFile(join(output,'mcpfn-target-suite.xml'),createMcpFnTargetSuiteJUnit(report),{mode:0o600});
    summary.mcpfn={ok:report.ok,total:report.total,passed:report.passed,failed:report.failed,incomplete:report.incomplete,
      manifestChecked:report.manifestChecked,manifestHash:report.manifestHash,
      failures:report.results.filter(item=>item.status!=='passed').map(item=>({name:item.name,error:item.error}))};
  } finally { disposeMcpFnTargetSuiteReport(report); }
  console.log(`McpFn target suite: ${summary.mcpfn.passed}/${summary.mcpfn.total} passed`);
  assert(summary.mcpfn.ok && summary.mcpfn.failed===0 && summary.mcpfn.incomplete===0,
    `McpFn scenarios failed: ${JSON.stringify(summary.mcpfn.failures)}`);

  const loopback=/^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(backend.endpoint).hostname);
  if (!loopback) forwarder=await loopbackForwarder(backend.endpoint);
  const url=forwarder?.url??backend.endpoint;
  for (const scenario of applicable) {
    const result=await runAuthenticatedOfficialConformance({url,scenario,credential,cwd:output});
    summary.official.push({scenario,ok:result.ok,exitCode:result.exitCode,
      outcome:result.stdout.split('\n').find(line=>line.includes(`${scenario}:`))?.trim()??null});
    console.log(`official ${scenario}: ${result.ok?'passed':'failed'}`);
  }
  summary.notApplicable=['logging-set-level','completion-complete','tools-call-* (reference fixture tools)',
    'elicitation-*','resources-read-*/templates/subscribe (reference fixture resources)','prompts-*','server-sse-multiple-streams (JSON responses)'];
  assert(summary.official.every(item=>item.ok),'an applicable official conformance scenario failed');
  summary.result='passed';
} catch(error) { failure=error; summary.result='failed'; summary.error=String(error?.message??error); }
finally {
  try { await forwarder?.close(); await backend.cleanup(); summary.cleanup='complete'; }
  catch(error) { summary.cleanup='failed'; failure??=error; }
  summary.finishedAt=new Date().toISOString();
  await mkdir(output,{recursive:true,mode:0o700});
  await writeFile(join(output,'summary.json'),`${JSON.stringify(summary,null,2)}\n`,{mode:0o600});
}
if (failure) throw failure;
console.log(`MCP protocol and semantic conformance passed; reports: ${output}`);

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { acquireRemoteCredential, createAuthenticatedConformanceProxy, redactRemoteCredential, runOfficialConformance } from '@mcpfn/testing';
import { connectionOptions } from './db-connection.mjs';
import { wranglerInvocation } from './wrangler-command.mjs';
import { CollectionRegistry, PostgresSpaces, postgresServices } from '../packages/postgres/dist/index.js';
import { createMcpHandler } from '../packages/mcp/dist/index.js';

const root=resolve(import.meta.dirname,'..');
function assert(condition,message) { if (!condition) throw new Error(message); }
const loopbackHost=/^(?:127\.0\.0\.1|localhost|\[::1\])$/;

/** Cleanup owned by the caller from before initialization starts. Steps run in
 * reverse registration order, and each runs even when an earlier one fails. */
export function finalizers() {
  const steps=[];
  return {
    add(step) { steps.push(step); },
    get size() { return steps.length; },
    async run() {
      const errors=[];
      while (steps.length) {
        try { await steps.pop()(); } catch(error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors,`cleanup incomplete: ${errors.map(error=>error?.message??error).join('; ')}`);
    }
  };
}
/** Erase every disposable space; one failure does not skip the others. */
async function eraseAll(spaceIds,erase) {
  const errors=[];
  for (const spaceId of spaceIds) {
    try { await erase(spaceId); } catch(error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,`space cleanup failed for ${errors.length} space(s)`);
}
/** Terminate an owned child and wait for it: end stdin, then SIGTERM, then
 * SIGKILL. Each signal waits only while the child has not exited. */
async function stop(child,{exited,closed},graceMs) {
  if (child.pid===undefined) return; // It never started; spawnOwned saw the error.
  const done=()=>child.exitCode!==null || child.signalCode!==null;
  const within=async()=>{
    let timer;
    try { return await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),graceMs);})]); }
    finally { clearTimeout(timer); }
  };
  let stopped=done();
  if (!stopped && child.stdin) { child.stdin.end(); stopped=await within(); }
  if (!stopped) { child.kill('SIGTERM'); stopped=await within(); }
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  // A descendant may still hold a pipe after the child exits; release ours.
  for (const stream of [child.stdin,child.stdout,child.stderr]) stream?.destroy();
  await closed;
}

/** Spawn a child that cleanup owns from the moment it exists. A spawn failure
 * becomes the `failed` rejection, never an uncaught 'error' event. */
export function spawnOwned(command,args,options,cleanup,{graceMs=3_000}={}) {
  const child=spawn(command,args,options);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const closed=new Promise(resolve=>child.once('close',resolve));
  let fail;
  const failed=new Promise((_,reject)=>{ fail=reject; });
  failed.catch(()=>{});
  child.on('error',error=>fail(error));
  // Writes after the child exits surface through its exit, not as EPIPE.
  child.stdin?.on('error',()=>{});
  const terminate=()=>stop(child,{exited,closed},graceMs);
  cleanup.add(terminate);
  return {child,failed,terminate};
}

/** A child answering one JSON object per stdout line, owned by cleanup at
 * spawn. Its first line must be {ready:true}; that wait races spawn failure,
 * early exit and a timeout. Secrets never appear in an error message. */
export async function startLineProcess(command,args,{cleanup,cwd,env,timeoutMs=60_000,graceMs,secrets=[]}) {
  const {child,failed,terminate}=spawnOwned(command,args,{cwd,env,stdio:['pipe','pipe','pipe']},cleanup,{graceMs});
  let stderr='';
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
  const redacted=text=>secrets.reduce((value,secret)=>value.replaceAll(secret,'[redacted]'),text);
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>{
    let timer;
    try {
      const line=await Promise.race([lines.next(),failed,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`${command} timed out after ${timeoutMs} ms`)),timeoutMs);})]);
      if (line.done) return {transportError:'ProcessExited'};
      return JSON.parse(line.value);
    } finally { clearTimeout(timer); }
  };
  let ready;
  try { ready=await next(); } catch(error) { ready={error:String(error?.message??error)}; }
  if (!ready?.ready) throw new Error(redacted(`${command} did not initialize: ${ready?.error??JSON.stringify(ready)} ${stderr}`.trim()));
  return {ready,close:terminate,send:async message=>{
    if (child.exitCode!==null || child.signalCode!==null) return {transportError:'ProcessExited'};
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return next();
  }};
}

/** Run one acceptance gate with caller-owned cleanup. The record is passed
 * only when the body and every finalizer succeed; a body failure stays the
 * reported error and a cleanup failure is recorded beside it. Returns the
 * first failure. */
export async function runGate(record,body) {
  const cleanup=finalizers();
  const failures=[];
  try { await body(cleanup); }
  catch(error) { failures.push(error); record.error=String(error?.message??error); }
  record.cleanupSteps=cleanup.size;
  try { await cleanup.run(); record.cleanup='complete'; }
  catch(error) { failures.push(error); record.cleanup='failed'; record.cleanupError=String(error?.message??error); }
  if (!failures.length) { record.result='passed'; return undefined; }
  record.result='failed';
  record.error??=record.cleanupError;
  return failures[0]??new Error(record.error);
}

/** Run a gate and persist its record, readable only by the owner, before the
 * caller rethrows the returned failure. */
export async function recordGate(record,path,body,{directoryMode}={}) {
  const failure=await runGate(record,body);
  record.finishedAt=new Date().toISOString();
  await mkdir(dirname(path),{recursive:true,...directoryMode===undefined ? {} : {mode:directoryMode}});
  await writeFile(path,`${JSON.stringify(record,null,2)}\n`,{mode:0o600});
  return failure;
}

const requestHop=new Set(['host','connection','keep-alive','content-length','transfer-encoding','accept-encoding']);
// fetch has already decoded the body, so its encoding and framing headers no longer apply.
const responseHop=new Set(['connection','keep-alive','content-length','transfer-encoding','content-encoding']);
const parsed=body=>{ try { return JSON.parse(body); } catch { return null; } };

/** A loopback forwarder for one fixed upstream path. Only this forwarder's own
 * origin, and that of a loopback proxy registered in front of it, stands for
 * the upstream origin; any other Origin passes through for the upstream to
 * judge. It records each upstream status and can drop the next matching
 * response after the upstream answered: a real lost response. */
export async function loopbackForwarder(endpoint,{cleanup,timeoutMs=30_000}={}) {
  const upstream=new URL(endpoint);
  const observed=[];
  const standIns=new Set();
  let own;
  let drop=null;
  const server=createServer(async(req,res)=>{
    // An upstream failure is a 502, never an unhandled rejection that skips cleanup.
    try {
      if (new URL(req.url,'http://127.0.0.1').pathname!==upstream.pathname) { res.writeHead(404).end(); return; }
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const body=chunks.length?Buffer.concat(chunks):undefined;
      const headers=Object.fromEntries(Object.entries(req.headers).filter(([name])=>!requestHop.has(name)));
      if (standIns.has(headers.origin)) headers.origin=upstream.origin;
      const response=await fetch(upstream,{method:req.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
      const payload=Buffer.from(await response.arrayBuffer());
      observed.push({status:response.status,wwwAuthenticate:response.headers.get('www-authenticate')});
      if (drop?.(parsed(body?.toString('utf8')))) { drop=null; res.destroy(); return; }
      res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([name])=>!responseHop.has(name))));
      res.end(payload);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  own=`http://127.0.0.1:${server.address().port}`;
  standIns.add(own);
  const close=()=>new Promise(resolve=>{ server.closeAllConnections(); server.close(()=>resolve()); });
  cleanup?.add(close);
  return {url:`${own}${upstream.pathname}`,observed,close,
    /** Drop the response to the next request whose JSON-RPC message matches. */
    dropNextResponse(match) { drop=match; },
    /** Let the loopback proxy at this origin, placed in front of the forwarder,
     * also stand for the upstream origin until the returned function withdraws it. */
    standFor(origin) {
      const url=new URL(origin);
      assert(url.origin===origin && url.protocol==='http:' && loopbackHost.test(url.hostname) && origin!==own,
        `${origin} is not a separate loopback origin`);
      standIns.add(origin);
      return ()=>{ standIns.delete(origin); };
    }};
}

/** McpFn's credential proxy in front of the forwarder, as runAuthenticatedOfficialConformance
 * composes it, but with the proxy's origin standing for the upstream origin: the official
 * runner sends Host and Origin for the proxy it addresses. The result is redacted, and the
 * origin, proxy and credential lease are released even when the body fails. */
export async function withCredentialProxy(forwarder,credential,body) {
  const lease=await acquireRemoteCredential(credential,{url:forwarder.url,requestId:randomUUID()});
  let proxy;
  let withdraw;
  try {
    proxy=await createAuthenticatedConformanceProxy({url:forwarder.url,headers:lease.credential.headers});
    withdraw=forwarder.standFor(new URL(proxy.url).origin);
    return redactRemoteCredential(lease.credential,await body(proxy.url),{preserveKeys:true});
  } finally {
    withdraw?.();
    try { await proxy?.close(); } finally { await lease.release(); }
  }
}

/** One official conformance scenario against a deployed endpoint reached through the forwarder. */
export function forwardedOfficialConformance(forwarder,{scenario,credential,cwd}) {
  return withCredentialProxy(forwarder,credential,url=>runOfficialConformance({url,scenario,cwd,stdio:'pipe'}));
}

const modes={'node-in-process':'in-process-authfn','node-vite':'local-app-host',workerd:'local-workerd-host',external:'external-host'};
/** The evidence mode is the backend that ran, never the environment requested. */
export function gateMode(endpointInfo) { return modes[endpointInfo.runtime]; }

/** An external endpoint is only used through the explicit --host mode. */
export function selectBackend(argv,cleanup) {
  const host=argv.includes('--host');
  if (!host && process.env.STATEPLANE_MCP_ENDPOINT) throw new Error('STATEPLANE_MCP_ENDPOINT is set; add --host to target it');
  return host ? hostBackend({workerd:argv.includes('--workerd'),cleanup}) : inProcessBackend({cleanup});
}

export function loopbackUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return readFile(join(root,'.data/local-db-password'),'utf8').then(password=>
    `postgres://stateplane:${encodeURIComponent(password.trim())}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`);
}

/** Production composition outside Cloudflare: AuthFn sessions and keys, real issue and revoke. */
export async function inProcessBackend({cleanup}) {
  const { memoryAdapter }=await import('@superfunctions/db/testing');
  const { createAuthFn, createUser, issueSession }=await import('@authfn/core');
  const { AuthFnIdentityVerifier, AuthFnAgentKeys }=await import('../packages/auth/dist/index.js');
  const pool=new pg.Pool({...connectionOptions(await loopbackUrl()),max:6});
  cleanup.add(()=>pool.end());
  const config={database:memoryAdapter(),namespace:`sta10-gate-${randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const identity=new AuthFnIdentityVerifier(config);
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(pool,cells,'cell-a',new AuthFnAgentKeys(config),identity,randomBytes(32));
  const services=postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600);
  const holder={};
  // Only the fixed MCP and metadata routes reach the handler, at fixed loopback URLs.
  const routes=new Map();
  const server=createServer(async(req,res)=>{
    // An aborted request is a 500, never an unhandled rejection that skips cleanup.
    try {
      const target=routes.get(new URL(req.url,'http://127.0.0.1').pathname);
      if (!target) { res.writeHead(404).end(); return; }
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const response=await holder.handler(new Request(target,{
        method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined}));
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  cleanup.add(()=>new Promise(resolve=>{ server.closeAllConnections(); server.close(()=>resolve()); }));
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
  for (const path of ['/mcp','/.well-known/oauth-protected-resource/mcp']) routes.set(path,new URL(path,endpoint).href);
  holder.handler=createMcpHandler({services,identity,resource:endpoint,authorizationServers:['http://127.0.0.1:9/'],
    allowInsecureLoopback:true,requestTimeoutMs:12_000});
  const user=await createUser(config,{primaryEmail:`owner-${randomUUID()}@example.invalid`});
  const session=await issueSession(config,{},{userId:user.id,methods:['password']});
  const owner=await identity.verify(new Request(endpoint,{headers:{authorization:`Bearer ${session.sessionToken}`}}));
  const spaceIds=[];
  cleanup.add(()=>eraseAll(spaceIds,async spaceId=>{
    try { await spaces.archive(owner,spaceId); await spaces.delete(owner,spaceId); }
    catch(error) { if (error?.code!=='NOT_FOUND') throw error; }
  }));
  return {endpoint,ownerToken:session.sessionToken,denial:'transport',endpointInfo:{origin:'loopback',path:'/mcp',runtime:'node-in-process'},
    async createSpace() { const spaceId=`sp_${randomUUID()}`; spaceIds.push(spaceId); await spaces.create(owner,'cell-a',spaceId); return spaceId; },
    async grantAgent(spaceId,collectionId,capabilities) {
      const key=await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),[{collectionId,capabilities}]);
      return {token:key.secret,revoke:()=>spaces.revokeAgentKey(owner,spaceId,key.id)};
    },
    async backfill(spaceId,collectionId,field) {
      const {scope}=await spaces.scope(owner,spaceId,collectionId,'schema:write');
      return (await new CollectionRegistry(pool).backfill(scope,field)).ready;
    }};
}

/** Poll a started host's health URL under one overall deadline: each attempt
 * gets at most the time remaining, so a host that accepts connections but
 * never answers fails within timeoutMs instead of once per attempt. */
export async function awaitReady(url,{child,failed},{timeoutMs,attemptMs=2_000,intervalMs=100}) {
  const end=Date.now()+timeoutMs;
  for (let remaining=timeoutMs;remaining>0;remaining=end-Date.now()) {
    if (child.exitCode!==null) throw new Error('app host exited before readiness');
    try {
      if ((await fetch(url,{signal:AbortSignal.timeout(Math.min(attemptMs,remaining))})).ok) return; // NOSONAR -- readiness polling is sequential
    } catch { /* still starting */ }
    await Promise.race([new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(0,end-Date.now())))),failed]); // NOSONAR -- readiness polling is sequential
  }
  throw new Error(`app host did not become ready within ${timeoutMs} ms`);
}

/** The app's opt-in host with its fixture identity: an external endpoint, or a
 * local vite (Node) or wrangler (workerd) run. Every request to the host and
 * every fixture query has a deadline, so a stalled host cannot hold cleanup. */
export async function hostBackend({workerd=false,cleanup,httpTimeoutMs=30_000,readyTimeoutMs=120_000}) {
  const deadline=()=>AbortSignal.timeout(httpTimeoutMs);
  const external=process.env.STATEPLANE_MCP_ENDPOINT;
  const databaseUrl=external ? process.env.DATABASE_URL : await loopbackUrl();
  assert(databaseUrl,'DATABASE_URL is required for fixture grants');
  const env=external ? process.env : {STATEPLANE_TEST_TOKEN:randomBytes(32).toString('hex'),
    STATEPLANE_TEST_OWNER:`owner-${randomUUID()}`,STATEPLANE_TEST_CREDENTIAL:`session-${randomUUID()}`,
    STATEPLANE_TEST_AGENT_TOKEN:randomBytes(32).toString('hex'),STATEPLANE_TEST_AGENT_CREDENTIAL:`agent-${randomUUID()}`,
    STATEPLANE_TEST_CURSOR_SECRET:randomBytes(32).toString('hex')};
  for (const name of ['STATEPLANE_TEST_TOKEN','STATEPLANE_TEST_OWNER','STATEPLANE_TEST_CREDENTIAL','STATEPLANE_TEST_AGENT_TOKEN','STATEPLANE_TEST_AGENT_CREDENTIAL'])
    assert(env[name],`${name} is required`);
  let endpoint=external;
  if (!external) {
    const reservation=createNetServer();
    reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
    const port=reservation.address().port;
    reservation.close(); await once(reservation,'close');
    endpoint=`http://127.0.0.1:${port}/mcp`;
    const bindings={...env,STATEPLANE_TEST_HTTP:'1',STATEPLANE_TEST_DATABASE_URL:databaseUrl,
      STATEPLANE_MCP_AUTHORIZATION_SERVER:'http://127.0.0.1:9/'};
    let started;
    if (workerd) {
      // workerd receives the fixture secrets from a private file, never argv.
      const built=spawnSync(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'build'],{cwd:join(root,'app'),stdio:'ignore'});
      assert(built.status===0,'app build failed');
      const secrets=await mkdtemp(join(tmpdir(),'stateplane-workerd-'));
      cleanup.add(()=>rm(secrets,{recursive:true,force:true}));
      const file=join(secrets,'worker.env');
      bindings.STATEPLANE_MCP_RESOURCE=endpoint;
      await writeFile(file,Object.entries(bindings).map(([name,value])=>`${name}=${value}`).join('\n')+'\n',{mode:0o600});
      const {command,args}=wranglerInvocation(['dev','--config','wrangler.jsonc','--persist-to','../.data/wrangler/app',
        '--ip','127.0.0.1','--port',String(port),'--env-file',file]);
      started=spawnOwned(command,args,{cwd:join(root,'app'),stdio:'ignore',env:{...process.env,WRANGLER_SEND_METRICS:'false'}},cleanup);
    } else {
      // The Node host derives its loopback resource; the workerd run pins it as a Preview must.
      started=spawnOwned(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'dev','--host','127.0.0.1','--port',String(port),
        '--strictPort'],{cwd:join(root,'app'),stdio:'ignore',env:{...process.env,...bindings,STATEPLANE_ENV:'local'}},cleanup);
    }
    await awaitReady(new URL('/api/health',endpoint),started,{timeoutMs:readyTimeoutMs});
  }
  // The advertised resource must be this endpoint; a Preview pins it with STATEPLANE_MCP_RESOURCE.
  const origin=new URL(endpoint);
  const metadata=await fetch(new URL(`/.well-known/oauth-protected-resource${origin.pathname}`,endpoint),{signal:deadline()});
  assert(metadata.ok,`protected resource metadata returned ${metadata.status}; is STATEPLANE_MCP_RESOURCE set?`);
  const advertised=(await metadata.json()).resource;
  assert(new URL(advertised).href===origin.href,`the endpoint advertises resource ${advertised}, not ${origin.href}`);
  const pool=new pg.Pool({...connectionOptions(databaseUrl),max:2,connectionTimeoutMillis:httpTimeoutMs,query_timeout:httpTimeoutMs});
  cleanup.add(()=>pool.end());
  const http=async(method,path,body)=>{
    const response=await fetch(new URL(`/v1/${path}`,endpoint),{method,signal:deadline(),headers:{authorization:`Bearer ${env.STATEPLANE_TEST_TOKEN}`,
      ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    assert(response.ok,`HTTP ${method} ${path} failed with ${response.status}`);
    return response.json();
  };
  const spaceIds=[];
  const agent=env.STATEPLANE_TEST_AGENT_CREDENTIAL;
  // Registered last, so it runs first, while the app and pool still exist.
  cleanup.add(()=>eraseAll(spaceIds,async spaceId=>{
    await pool.query('DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2',[spaceId,agent]);
    await pool.query('DELETE FROM space_credentials WHERE space_id=$1 AND credential_id=$2',[spaceId,agent]);
    await http('PATCH',`spaces/${spaceId}`,{lifecycle:'readOnly'});
    await http('DELETE',`spaces/${spaceId}`);
    const left=(await pool.query(`SELECT (SELECT count(*)::int FROM spaces WHERE space_id=$1 AND lifecycle<>'deleted')+
      (SELECT count(*)::int FROM space_directory WHERE space_id=$1 AND lifecycle<>'deleted') AS n`,[spaceId])).rows[0].n;
    assert(left===0,'the disposable space is erased');
  }));
  let runtime='external';
  if (!external) runtime=workerd?'workerd':'node-vite';
  return {endpoint,ownerToken:env.STATEPLANE_TEST_TOKEN,denial:'service',
    endpointInfo:{origin:external?origin.origin:'loopback',path:origin.pathname,runtime},
    async createSpace() { const spaceId=`sp_${randomUUID()}`; spaceIds.push(spaceId); await http('POST','spaces',{spaceId}); return spaceId; },
    async grantAgent(spaceId,collectionId,capabilities) {
      // The fixture host authenticates one configured agent bearer; its cell
      // credential and grants are what the shared services authorize.
      await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,
        expires_at,activated_at,confirmed_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
      [spaceId,agent,`agent-principal-${randomUUID()}`,env.STATEPLANE_TEST_OWNER]);
      await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities) VALUES($1,$2,$3,$4::text[])`,
        [spaceId,collectionId,agent,capabilities]);
      return {token:env.STATEPLANE_TEST_AGENT_TOKEN,revoke:()=>pool.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,agent])};
    },
    async backfill(spaceId,collectionId,field) {
      const placement=(await pool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId])).rows[0];
      const scope={spaceId,collectionId,principalId:env.STATEPLANE_TEST_OWNER,credentialId:env.STATEPLANE_TEST_CREDENTIAL,
        capability:'schema:write',policyVersion:Number(placement.policy_version),placementGeneration:Number(placement.placement_generation)};
      return (await new CollectionRegistry(pool).backfill(scope,field)).ready;
    }};
}

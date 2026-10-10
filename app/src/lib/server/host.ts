import { createHash, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import pg from 'pg';
import { createHttpHandler } from '@stateplane/api';
import { isSafeHttpRead, parseV1Path } from '@stateplane/contracts';
import { createMcpHandler } from '@stateplane/mcp';
import { PostgresSpaces, postgresServices } from '@stateplane/postgres';

export type Bindings = App.Platform['env'];
type Handler=(request:Request)=>Promise<Response>;
/** Both transports share one pool, service composition and fixture identity. */
export interface Host { http:Handler; mcp:Handler }
let cached: { key:string; host:Host; retire:()=>void } | undefined;
const providerTimeoutMs=5_000;
// Let PostgreSQL's statement cancellation arrive before retiring a silent
// connection. A client-side query timeout rejects while its SQL may still run.
const socketTimeoutMs=7_000;
const requestTimeoutMs=12_000;
// A Preview can be reached through more than one hostname; bound the derived
// MCP resource handlers instead of growing with request Host headers.
const maxMcpResources=4;
class HostProviderTimeoutError extends Error {
  constructor() { super('Provider socket timeout'); this.name='HostProviderTimeoutError'; }
}

function safeRead(request:Request):boolean {
  const route=parseV1Path(new URL(request.url).pathname);
  return route!==null && isSafeHttpRead(request.method,route);
}

export function unavailable(request?:Request):Response {
  const retryable=!request || safeRead(request);
  const code=retryable?'PROVIDER_UNAVAILABLE':'COMMIT_OUTCOME_UNKNOWN';
  return Response.json({contractVersion:'1',error:{code,message:code,
    retryable,requestId:crypto.randomUUID()}},{status:503,
    headers:{'Cache-Control':'no-store',...(retryable?{'Retry-After':'1'}:{})}});
}
/** The MCP endpoint fails closed without every opt-in binding. */
export function mcpUnavailable():Response {
  return Response.json({jsonrpc:'2.0',id:null,error:{code:-32603,message:'PROVIDER_UNAVAILABLE'}},
    {status:503,headers:{'Cache-Control':'no-store','Retry-After':'1'}});
}
function clearHost():undefined {
  cached?.retire();
  cached=undefined;
  return undefined;
}

/** A deliberately opt-in host for isolated local and Preview acceptance. */
export function stateplaneHost(env:Bindings):Host | undefined {
  if (!['local','preview'].includes(env.STATEPLANE_ENV) || env.STATEPLANE_TEST_HTTP!=='1' ||
      !env.STATEPLANE_TEST_TOKEN || env.STATEPLANE_TEST_TOKEN.length<32 ||
      !env.STATEPLANE_TEST_OWNER || !env.STATEPLANE_TEST_CREDENTIAL ||
      !env.STATEPLANE_TEST_CURSOR_SECRET || !/^[0-9a-fA-F]{64,}$/.test(env.STATEPLANE_TEST_CURSOR_SECRET)) return clearHost();
  if ((env.STATEPLANE_TEST_AGENT_TOKEN || env.STATEPLANE_TEST_AGENT_CREDENTIAL) &&
      (!env.STATEPLANE_TEST_AGENT_TOKEN || env.STATEPLANE_TEST_AGENT_TOKEN.length<32 ||
       !env.STATEPLANE_TEST_AGENT_CREDENTIAL)) return clearHost();
  const connectionString=env.AUTHORITY?.connectionString ?? env.STATEPLANE_TEST_DATABASE_URL;
  if (!connectionString) return clearHost();
  const cellId=env.STATEPLANE_TEST_CELL_ID??'cell-a';
  const storageTargetId=env.STATEPLANE_TEST_STORAGE_TARGET??'target-a';
  const key=createHash('sha256').update(JSON.stringify([connectionString,cellId,storageTargetId,
    env.STATEPLANE_TEST_TOKEN,env.STATEPLANE_TEST_OWNER,env.STATEPLANE_TEST_CREDENTIAL,
    env.STATEPLANE_TEST_CURSOR_SECRET,env.STATEPLANE_TEST_AGENT_TOKEN,
    env.STATEPLANE_TEST_AGENT_CREDENTIAL,env.STATEPLANE_MCP_AUTHORIZATION_SERVER,
    env.STATEPLANE_MCP_RESOURCE])).digest('hex');
  // A Worker cannot reuse one request's socket in another request, so it gets a
  // pool per request; only the Node development host keeps one across requests.
  const perRequest=!!env.AUTHORITY || globalThis.navigator?.userAgent==='Cloudflare-Workers';
  if (!perRequest && cached?.key===key) return cached.host;
  // pg-pool applies this limit both to new connections and to clients queued
  // behind the four active connections. Without it a provider outage can leave
  // an authenticated HTTP request pending indefinitely.
  const pool=new pg.Pool({connectionString,max:4,connectionTimeoutMillis:providerTimeoutMs,
    statement_timeout:providerTimeoutMs});
  // An absolute query timer belongs to that query, not to a checked-out
  // client or an idle pool entry. A transaction may pause between statements.
  pool.on('connect',client=>{
    // pg-pool only listens for errors while a client is idle. A destroyed
    // checked-out socket can also emit a client error after rejecting query().
    client.on('error',()=>{});
    const stream=(client as pg.PoolClient & {connection:{stream:Socket}}).connection.stream;
    const query=client.query.bind(client) as (...args:unknown[])=>unknown;
    client.query=((...args:unknown[])=>{
      // Destroying the stream marks pg's client unqueryable; pg-pool discards
      // it on release instead of reusing a query that may still be executing.
      const timer=setTimeout(()=>stream.destroy(new HostProviderTimeoutError()),socketTimeoutMs);
      let finished=false;
      const finish=()=>{
        if (finished) return;
        finished=true;
        clearTimeout(timer);
      };
      const last=args.length-1;
      if (typeof args[last]==='function') {
        const callback=args[last] as (...values:unknown[])=>void;
        args[last]=(...values:unknown[])=>{ finish(); callback(...values); };
      }
      try {
        const result=query(...args);
        if (typeof args[last]!=='function' && result &&
            typeof (result as Promise<unknown>).then==='function')
          return (result as Promise<unknown>).finally(finish);
        return result;
      } catch (error) { finish(); throw error; }
    }) as typeof client.query;
  });
  // An idle connection can fail after a successful request when the provider
  // goes away. The pool removes that client; consume the event without logging
  // provider diagnostics or allowing an unhandled error to kill the host.
  pool.on('error',()=>{});
  const tokenDigest=createHash('sha256').update(env.STATEPLANE_TEST_TOKEN).digest();
  const agentDigest=env.STATEPLANE_TEST_AGENT_TOKEN ?
    createHash('sha256').update(env.STATEPLANE_TEST_AGENT_TOKEN).digest() : null;
  const actor={kind:'session' as const,userPrincipalId:env.STATEPLANE_TEST_OWNER,
    credentialId:env.STATEPLANE_TEST_CREDENTIAL};
  const agent=env.STATEPLANE_TEST_AGENT_CREDENTIAL ?
    {kind:'api-key' as const,credentialId:env.STATEPLANE_TEST_AGENT_CREDENTIAL} : null;
  const identity={
    verify:(request:Request)=>{
      const bearer=request.headers.get('authorization');
      if (!bearer?.startsWith('Bearer ')) return Promise.resolve(null);
      const candidate=createHash('sha256').update(bearer.slice(7)).digest();
      if (timingSafeEqual(candidate,tokenDigest)) return Promise.resolve(actor);
      return Promise.resolve(agent && agentDigest && timingSafeEqual(candidate,agentDigest) ? agent : null);
    },
    current:(claims:{credentialId:string},owner?:string)=>
      Promise.resolve((claims.credentialId===actor.credentialId ||
        claims.credentialId===agent?.credentialId) && (owner===undefined || owner===actor.userPrincipalId))
  };
  const cells=new Map([[cellId,{pool,storageTargetId}]]);
  const spaces=new PostgresSpaces(pool,cells,cellId,{
    create:()=>Promise.reject(new Error('Agent issuance is not configured')),
    find:()=>Promise.resolve(null),revoke:()=>Promise.reject(new Error('Agent revocation is not configured'))
  },identity,Buffer.from(env.STATEPLANE_TEST_CURSOR_SECRET,'hex'));
  const services=postgresServices(spaces,new Map([[cellId,{pool,cursorSecret:Buffer.from(env.STATEPLANE_TEST_CURSOR_SECRET,'hex')}]]),3600);
  const serve=createHttpHandler({services,identity});
  let active=0;let retired=false;let ended=false;
  const closeIfIdle=()=>{
    if (retired && active===0 && !ended) {
      ended=true;
      void pool.end().catch(()=>{});
    }
  };
  const retire=()=>{
    retired=true;
    if (cached?.retire===retire) cached=undefined;
    closeIfIdle();
  };
  const boundedServe=async(request:Request):Promise<Response>=>{
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([serve(request),new Promise<Response>(resolve=>{
        timer=setTimeout(()=>{retire();resolve(unavailable(request));},requestTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  // MCP owns its deadline because only the JSON-RPC message identifies whether
  // the stalled call can be retried. AuthFn issuers are configured, never derived.
  const issuer=env.STATEPLANE_MCP_AUTHORIZATION_SERVER;
  const mcpHandlers=new Map<string,Handler>();
  const mcpServe=(request:Request):Promise<Response>=>{
    if (!issuer) return Promise.resolve(mcpUnavailable());
    const resource=env.STATEPLANE_MCP_RESOURCE ?? new URL('/mcp',request.url).toString();
    let handler=mcpHandlers.get(resource);
    if (!handler) {
      try {
        handler=createMcpHandler({services,identity,resource,authorizationServers:[issuer],
          allowInsecureLoopback:env.STATEPLANE_ENV==='local',requestTimeoutMs,onTimeout:retire});
      } catch { return Promise.resolve(mcpUnavailable()); }
      if (mcpHandlers.size>=maxMcpResources) mcpHandlers.clear();
      mcpHandlers.set(resource,handler);
    }
    return handler(request);
  };
  const tracked=(handler:Handler,after:()=>void):Handler=>async request=>{
    active++;
    try { return await handler(request); }
    finally { active--; after(); }
  };
  if (perRequest) {
    clearHost();
    return {http:tracked(boundedServe,retire),mcp:tracked(mcpServe,retire)};
  }
  const previous=cached;
  cached={key,retire,host:{http:tracked(boundedServe,closeIfIdle),mcp:tracked(mcpServe,closeIfIdle)}};
  previous?.retire();
  return cached.host;
}

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import pg from 'pg';
import { createHttpHandler } from '@stateplane/api';
import { isSafeHttpRead, parseV1Path } from '@stateplane/contracts';
import { PostgresSpaces, postgresServices } from '@stateplane/postgres';
import type { RequestHandler } from './$types';

type Bindings = App.Platform['env'];
let cached: { key:string; handler:(request:Request)=>Promise<Response>; retire:()=>void } | undefined;
const providerTimeoutMs=5_000;
const requestTimeoutMs=12_000;
class HostProviderTimeoutError extends Error {
  constructor() { super('Provider socket timeout'); this.name='HostProviderTimeoutError'; }
}

function safeRead(request:Request):boolean {
  const route=parseV1Path(new URL(request.url).pathname);
  return route!==null && isSafeHttpRead(request.method,route);
}

function unavailable(request?:Request):Response {
  const retryable=!request || safeRead(request);
  const code=retryable?'PROVIDER_UNAVAILABLE':'COMMIT_OUTCOME_UNKNOWN';
  return Response.json({contractVersion:'1',error:{code,message:code,
    retryable,requestId:crypto.randomUUID()}},{status:503,
    headers:{'Cache-Control':'no-store',...(retryable?{'Retry-After':'1'}:{})}});
}
function clearHost():undefined {
  cached?.retire();
  cached=undefined;
  return undefined;
}

/** A deliberately opt-in host for isolated local and Preview acceptance. */
function host(env:Bindings):((request:Request)=>Promise<Response>) | undefined {
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
    env.STATEPLANE_TEST_AGENT_CREDENTIAL])).digest('hex');
  if (!env.AUTHORITY && cached?.key===key) return cached.handler;
  // pg-pool applies this limit both to new connections and to clients queued
  // behind the four active connections. Without it a provider outage can leave
  // an authenticated HTTP request pending indefinitely.
  const pool=new pg.Pool({connectionString,max:4,connectionTimeoutMillis:providerTimeoutMs,
    query_timeout:providerTimeoutMs+1_000,statement_timeout:providerTimeoutMs});
  // pg's query_timeout rejects the caller but leaves a silent socket in the
  // pool. Destroy that socket first, so a stalled query cannot poison reuse.
  pool.on('connect',client=>{
    const stream=(client as pg.PoolClient & {connection:{stream:Socket}}).connection.stream;
    stream.setTimeout(providerTimeoutMs,()=>{
      stream.destroy(new HostProviderTimeoutError());
    });
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
  const boundedServe=async(request:Request):Promise<Response>=>{
    let timer:ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([serve(request),new Promise<Response>(resolve=>{
        timer=setTimeout(()=>resolve(unavailable(request)),requestTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  if (env.AUTHORITY) {
    clearHost();
    return async request=>{
      try { return await boundedServe(request); }
      finally { void pool.end().catch(()=>{}); }
    };
  }
  let active=0;let retired=false;
  const retire=()=>{
    retired=true;
    if (active===0) void pool.end().catch(()=>{});
  };
  const previous=cached;
  cached={key,retire,handler:async request=>{
    active++;
    try { return await boundedServe(request); }
    finally {
      active--;
      if (retired && active===0) void pool.end().catch(()=>{});
    }
  }};
  previous?.retire();
  return cached.handler;
}

const handle:RequestHandler=({request,platform})=>{
  const env={...process.env,...platform?.env} as unknown as Bindings;
  return host(env)?.(request) ?? unavailable();
};
export const GET=handle;
export const POST=handle;
export const PUT=handle;
export const PATCH=handle;
export const DELETE=handle;

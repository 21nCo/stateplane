import { createHash, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { createHttpHandler } from '@stateplane/api';
import { PostgresSpaces, postgresServices } from '@stateplane/postgres';
import type { RequestHandler } from './$types';

type Bindings = App.Platform['env'];
let cached: { key:string; handler:(request:Request)=>Promise<Response>; retire:()=>void } | undefined;

function unavailable():Response {
  return Response.json({contractVersion:'1',error:{code:'PROVIDER_UNAVAILABLE',message:'PROVIDER_UNAVAILABLE',
    retryable:true,requestId:crypto.randomUUID()}},{status:503,headers:{'Cache-Control':'no-store','Retry-After':'1'}});
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
      !env.STATEPLANE_TEST_CURSOR_SECRET || !/^[0-9a-f]{64,}$/.test(env.STATEPLANE_TEST_CURSOR_SECRET)) return clearHost();
  const connectionString=env.AUTHORITY?.connectionString ?? env.STATEPLANE_TEST_DATABASE_URL;
  if (!connectionString) return clearHost();
  const cellId=env.STATEPLANE_TEST_CELL_ID??'cell-a';
  const storageTargetId=env.STATEPLANE_TEST_STORAGE_TARGET??'target-a';
  const key=createHash('sha256').update(JSON.stringify([connectionString,cellId,storageTargetId,
    env.STATEPLANE_TEST_TOKEN,env.STATEPLANE_TEST_OWNER,env.STATEPLANE_TEST_CREDENTIAL,
    env.STATEPLANE_TEST_CURSOR_SECRET])).digest('hex');
  if (cached?.key===key) return cached.handler;
  const pool=new pg.Pool({connectionString,max:4});
  const tokenDigest=createHash('sha256').update(env.STATEPLANE_TEST_TOKEN).digest();
  const actor={kind:'session' as const,userPrincipalId:env.STATEPLANE_TEST_OWNER,
    credentialId:env.STATEPLANE_TEST_CREDENTIAL};
  const identity={
    verify:async(request:Request)=>{
      const bearer=request.headers.get('authorization');
      if (!bearer?.startsWith('Bearer ')) return null;
      const candidate=createHash('sha256').update(bearer.slice(7)).digest();
      return timingSafeEqual(candidate,tokenDigest) ? actor : null;
    },
    current:async(claims:{credentialId:string},owner?:string)=>
      claims.credentialId===actor.credentialId && (owner===undefined || owner===actor.userPrincipalId)
  };
  const cells=new Map([[cellId,{pool,storageTargetId}]]);
  const spaces=new PostgresSpaces(pool,cells,cellId,{
    create:async()=>{ throw new Error('Agent issuance is not configured'); },
    find:async()=>null,revoke:async()=>{ throw new Error('Agent revocation is not configured'); }
  },identity);
  const services=postgresServices(spaces,new Map([[cellId,{pool,cursorSecret:Buffer.from(env.STATEPLANE_TEST_CURSOR_SECRET,'hex')}]]),3600);
  const serve=createHttpHandler({services,identity});
  let active=0;let retired=false;
  const retire=()=>{
    retired=true;
    if (active===0) void pool.end().catch(()=>{});
  };
  const previous=cached;
  cached={key,retire,handler:async request=>{
    active++;
    try { return await serve(request); }
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

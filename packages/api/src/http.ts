import type { StateplaneServices } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
import type { VerifiedCredential } from '@stateplane/contracts';
import { isSafeHttpRead, parseV1Path } from '@stateplane/contracts';

const headers = { 'Cache-Control':'no-store', 'Content-Type':'application/json; charset=utf-8' };
const status:Record<string,number> = {
  INVALID_ARGUMENT:400,SCHEMA_INVALID:400,SCHEMA_UNSUPPORTED:400,SCHEMA_BREAKING:400,CURSOR_INVALID:400,
  UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,SPACE_UNAVAILABLE:423,
  REVISION_CONFLICT:409,UNIQUE_CONFLICT:409,KEY_RESERVED:409,LINK_RESTRICTED:409,
  IDEMPOTENCY_MISMATCH:409,SCHEMA_CONFLICT:409,BATCH_CONFLICT:409,BATCH_CANCELLED:409,RECEIPT_EXPIRED:409,
  RECEIPT_PENDING:503,PROVIDER_UNAVAILABLE:503,BACKPRESSURE:503,RATE_LIMITED:429,
  COMMIT_OUTCOME_UNKNOWN:503,STALE_PLACEMENT:503
};
const retryable = new Set(['RECEIPT_PENDING','PROVIDER_UNAVAILABLE','BACKPRESSURE','RATE_LIMITED','STALE_PLACEMENT']);
class HttpFailure extends Error {
  constructor(readonly code:string,readonly retryableOverride?:boolean) { super(code); }
}
const fail=(code:string,retryableOverride?:boolean):never=>{ throw new HttpFailure(code,retryableOverride); };
const json=(value:unknown,code=200)=>Response.json(value,{status:code,headers});
function path(value:string):string[] {
  return parseV1Path(value)??fail('NOT_FOUND');
}
async function body(request:Request,limit=3_145_728):Promise<string> {
  const declared=request.headers.get('content-length');
  if (declared && Number(declared)>limit) fail('RATE_LIMITED',false);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')) fail('INVALID_ARGUMENT');
  if (!request.body) return fail('INVALID_ARGUMENT');
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  let oversized=false;
  try {
    while (true) {
      const next=await reader.read(); // NOSONAR -- a stream reader advances sequentially
      if (next.done) break;
      size+=next.value.byteLength;
      if (size>limit) {
        oversized=true;
        break;
      }
      chunks.push(next.value);
    }
    if (oversized) {
      try { await reader.cancel(); } catch { /* The size error still owns this response. */ }
      fail('RATE_LIMITED',false);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { return fail('INVALID_ARGUMENT'); }
}
function object(serialized:string):Record<string,unknown> {
  let parsed:unknown;
  try { parsed=JSON.parse(serialized); } catch { return fail('INVALID_ARGUMENT'); }
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) fail('INVALID_ARGUMENT');
  return parsed as Record<string,unknown>;
}
function safeRead(request:Request):boolean {
  try { const route=parseV1Path(new URL(request.url).pathname);
    return route!==null && isSafeHttpRead(request.method,route); }
  catch { return false; }
}
function hostWriteTimeout(error:unknown):boolean {
  return error instanceof Error && (error.name==='HostProviderTimeoutError' ||
    error.message==='Query read timeout');
}
function errorCode(error:unknown,read:boolean):string {
  const name=error instanceof Error ? error.name : '';
  const raw=(error as {code?:unknown})?.code;
  if (name==='CommitOutcomeUnknownError') return 'COMMIT_OUTCOME_UNKNOWN';
  if (typeof raw==='string' && Object.hasOwn(status,raw)) return raw;
  if (error instanceof HttpFailure) return error.code;
  if (raw==='57014') return read?'RATE_LIMITED':'COMMIT_OUTCOME_UNKNOWN';
  if (!read && hostWriteTimeout(error)) return 'COMMIT_OUTCOME_UNKNOWN';
  return 'PROVIDER_UNAVAILABLE';
}
function errorRetryable(error:unknown,code:string,read:boolean):boolean {
  let canRetry=retryable.has(code);
  if (code==='COMMIT_OUTCOME_UNKNOWN') canRetry=read;
  if (error instanceof HttpFailure && error.retryableOverride!==undefined)
    canRetry=error.retryableOverride;
  else if (typeof (error as {retryable?:unknown})?.retryable==='boolean')
    canRetry=(error as {retryable:boolean}).retryable;
  return canRetry;
}
function errorResponse(error:unknown,requestId:string,request:Request):Response {
  const read=safeRead(request);
  const code=errorCode(error,read);
  const canRetry=errorRetryable(error,code,read);
  const response=json({contractVersion:'1',error:{code,message:code,retryable:canRetry,requestId}},status[code]??503);
  if (canRetry) response.headers.set('Retry-After','1');
  return response;
}

async function rootSpaces(services:StateplaneServices,actor:VerifiedCredential,request:Request,url:URL):Promise<Response> {
  if (request.method==='GET') {
    if (url.searchParams.getAll('cursor').length>1) fail('CURSOR_INVALID');
    return json(await services.spaces.list(actor,url.searchParams.get('cursor')??undefined));
  }
  if (request.method!=='POST') return fail('NOT_FOUND');
  const value=object(await body(request,4096));
  if (Object.keys(value).some(k=>!['cellId','spaceId'].includes(k)) ||
    (value.cellId!==undefined && typeof value.cellId!=='string') ||
    typeof value.spaceId!=='string' || !/^sp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.spaceId)) fail('INVALID_ARGUMENT');
  return json(await services.spaces.create(actor,value.cellId as string|undefined,value.spaceId as string),201);
}

async function selectedSpace(services:StateplaneServices,actor:VerifiedCredential,space:string,
  request:Request):Promise<Response> {
  if (request.method==='GET') return json(await services.spaces.get(actor,space));
  if (request.method==='DELETE') return json(await services.spaces.delete(actor,space));
  if (request.method!=='PATCH') return fail('NOT_FOUND');
  await services.spaces.get(actor,space);
  const value=object(await body(request,4096));
  if (Object.keys(value).length!==1 || typeof value.lifecycle!=='string' ||
    !['active','readOnly','suspended'].includes(value.lifecycle)) fail('INVALID_ARGUMENT');
  return json(await services.spaces.update(actor,space,value.lifecycle as 'active'|'readOnly'|'suspended'));
}

async function selectedCollection(services:StateplaneServices,actor:VerifiedCredential,space:string,
  collection:string,request:Request):Promise<Response> {
  if (request.method==='GET') return json(await services.collections.list(actor,space,collection));
  if (request.method==='PUT') return json(await services.collections.define(actor,space,collection,
    await body(request,1_048_576)),201);
  if (request.method!=='PATCH') return fail('NOT_FOUND');
  const rawVersion=request.headers.get('if-match');
  if (!rawVersion || !/^[1-9]\d*$/.test(rawVersion)) fail('INVALID_ARGUMENT');
  const version=Number(rawVersion);
  if (!Number.isSafeInteger(version) || version<1) fail('INVALID_ARGUMENT');
  return json(await services.collections.revise(actor,space,collection,version,await body(request,1_048_576)));
}

/** Resolve the three read selectors without broadening path authorization. */
async function recordReadRoute(services:StateplaneServices,p:string[],url:URL,
  prefix:readonly [VerifiedCredential,string,string]):Promise<Response> {
  if (p.length===7 && p[5]==='by-key') {
    const mode=url.searchParams.get('mode');
    if (mode!=='generated' && mode!=='external') return fail('INVALID_ARGUMENT');
    const result=await services.records.byKey(...prefix,mode,p[6]);
    if (!result) fail('NOT_FOUND');
    return json(result);
  }
  if (p.length===6 && !['query','count','by-key'].includes(p[5])) {
    const result=await services.records.get(...prefix,p[5]);
    if (!result) fail('NOT_FOUND');
    return json(result);
  }
  if (p.length===7 && p[6]==='projection')
    return json(await services.events.projection(...prefix,p[5]));
  return fail('NOT_FOUND');
}

/** Dispatch record mutations and exact reads under the same admitted scope. */
async function recordsRoute(services:StateplaneServices,p:string[],request:Request,url:URL,
  prefix:readonly [VerifiedCredential,string,string]):Promise<Response> {
  if (p.length===5 && request.method==='POST')
    return json(await services.records.mutate(...prefix,await body(request,1_048_576)));
  if (p.length===6 && p[5]==='query' && request.method==='POST')
    return json(await services.records.query(...prefix,await body(request,32_768)));
  if (p.length===6 && p[5]==='count' && request.method==='POST')
    return json(await services.records.count(...prefix,await body(request,32_768)));
  if (request.method==='GET') return recordReadRoute(services,p,url,prefix);
  return fail('NOT_FOUND');
}

async function batchesRoute(services:StateplaneServices,p:string[],request:Request,url:URL,
  prefix:readonly [VerifiedCredential,string,string]):Promise<Response> {
  if (p.length!==6 || !p[5]) return fail('NOT_FOUND');
  if (request.method==='GET') return json(await services.batches.progress(...prefix,p[5]));
  if (request.method==='DELETE') return json(await services.batches.cancel(...prefix,p[5]));
  if (request.method!=='PUT') return fail('NOT_FOUND');
  const retry=url.searchParams.get('retryFailed');
  if (retry!==null && retry!=='true' && retry!=='false') fail('INVALID_ARGUMENT');
  return json(await services.batches.ingest(...prefix,p[5],await body(request),retry==='true'));
}

async function dispatch(services:StateplaneServices,actor:VerifiedCredential,request:Request,url:URL,p:string[]):Promise<Response> {
  if (p.length===2 && p[0]==='auth' && p[1]==='session' && request.method==='GET')
    return json({contractVersion:'1',kind:actor.kind});
  if (p[0]!=='spaces') return fail('NOT_FOUND');
  if (p.length===1) return rootSpaces(services,actor,request,url);
  const space=p[1];
  if (!space) return fail('NOT_FOUND');
  if (p.length===2) return selectedSpace(services,actor,space,request);
  if (p[2]!=='collections') return fail('NOT_FOUND');
  if (p.length===3 && request.method==='GET') return collectionDiscovery(services,actor,space,url);
  const collection=p[3];
  if (!collection) return fail('NOT_FOUND');
  if (p.length===4) return selectedCollection(services,actor,space,collection,request);
  const prefix=[actor,space,collection] as const;
  if (p[4]==='records') return recordsRoute(services,p,request,url,prefix);
  if (p[4]==='batches') return batchesRoute(services,p,request,url,prefix);
  if (p[4]==='events' && p.length===5 && request.method==='GET')
    return json(await services.events.list(...prefix,url.searchParams.get('cursor')??undefined));
  return fail('NOT_FOUND');
}
async function collectionDiscovery(services:StateplaneServices,actor:VerifiedCredential,space:string,url:URL):Promise<Response> {
  if (url.searchParams.getAll('cursor').length>1) fail('CURSOR_INVALID');
  return json(await services.collections.list(actor,space,undefined,url.searchParams.get('cursor')??undefined));
}
/** All v1 endpoints use the same services as other transports. No error includes
 * the provider exception, bearer value, body, or URL query string. */
export function createHttpHandler({services,identity}:{services:StateplaneServices;identity:IdentityVerifier}): (request:Request)=>Promise<Response> {
  return async request=>{
    const requestId=crypto.randomUUID();
    try {
      const url=new URL(request.url);
      const p=path(url.pathname);
      const actor:VerifiedCredential|null=await identity.verify(request);
      if (!actor) return fail('UNAUTHENTICATED');
      return await dispatch(services,actor,request,url,p);
    } catch(error) { return errorResponse(error,requestId,request); }
  };
}

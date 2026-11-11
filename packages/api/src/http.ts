import type { StateplaneServices } from '@stateplane/application';
import { TransportFailure, analysisSubmission, classifyError } from '@stateplane/application';
import type { IdentityVerifier } from '@stateplane/auth';
import type { VerifiedCredential } from '@stateplane/contracts';
import { isSafeHttpRead, parseV1Path } from '@stateplane/contracts';

const headers = { 'Cache-Control':'no-store', 'Content-Type':'application/json; charset=utf-8' };
const status:Record<string,number> = {
  INVALID_ARGUMENT:400,SCHEMA_INVALID:400,SCHEMA_UNSUPPORTED:400,SCHEMA_BREAKING:400,CURSOR_INVALID:400,
  UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,SPACE_UNAVAILABLE:423,
  REVISION_CONFLICT:409,UNIQUE_CONFLICT:409,KEY_RESERVED:409,LINK_RESTRICTED:409,
  IDEMPOTENCY_MISMATCH:409,SCHEMA_CONFLICT:409,CONFLICT:409,BATCH_CONFLICT:409,BATCH_CANCELLED:409,RECEIPT_EXPIRED:409,
  RECEIPT_PENDING:503,PROVIDER_UNAVAILABLE:503,BACKPRESSURE:503,RATE_LIMITED:429,
  COMMIT_OUTCOME_UNKNOWN:503,STALE_PLACEMENT:503
};
const fail=(code:string,retryableOverride?:boolean):never=>{ throw new TransportFailure(code,retryableOverride); };
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
function errorResponse(error:unknown,requestId:string,request:Request):Response {
  const {code,retryable:canRetry}=classifyError(error,safeRead(request));
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
  if (p[2]==='audit' && p.length===3 && request.method==='GET')
    return json(await services.spaces.audit(actor,space,singleCursor(url)));
  if (p[2]==='erasure' && p.length===3 && request.method==='GET')
    return json(await services.spaces.erasure(actor,space));
  if (p[2]==='agent-keys') return agentKeysRoute(services,actor,space,p,request,url);
  if (p.length===3 && request.method==='POST' && (p[2]==='search' || p[2]==='bundles')) {
    const body=await retrievalRequest(request);
    return json(await (p[2]==='search' ? services.retrieval.search(actor,space,body) : services.retrieval.bundle(actor,space,body)));
  }
  if (p[2]!=='collections') return fail('NOT_FOUND');
  if (p.length===3 && request.method==='GET') return collectionDiscovery(services,actor,space,url);
  return collectionRoute(services,actor,space,p,request,url);
}
/** Routes below one selected collection, all admitted under its scope. */
async function collectionRoute(services:StateplaneServices,actor:VerifiedCredential,space:string,p:string[],
  request:Request,url:URL):Promise<Response> {
  const collection=p[3];
  if (!collection) return fail('NOT_FOUND');
  if (p.length===4) return selectedCollection(services,actor,space,collection,request);
  const prefix=[actor,space,collection] as const;
  if (p[4]==='records') return recordsRoute(services,p,request,url,prefix);
  if (p[4]==='batches') return batchesRoute(services,p,request,url,prefix);
  if (p[4]==='indexes' && p.length===6 && request.method==='POST')
    return json(await services.collections.backfill(...prefix,p[5]));
  if (p[4]==='events' && p.length===5 && request.method==='GET')
    return json(await services.events.list(...prefix,url.searchParams.get('cursor')??undefined));
  if (p[4]==='projections' && p.length===5 && request.method==='GET')
    return json(await services.retrieval.status(...prefix));
  if (p[4]==='aggregate' && p.length===5 && request.method==='POST')
    return json(await services.analysis.aggregate(...prefix,await body(request,aggregationBody)));
  if (p[4]==='jobs') return jobsRoute(services,p,request,prefix);
  return evidenceRoute(services,p,request,url,prefix);
}
/* An aggregation spec is JSON text of at most 32 KiB (aggregationBounds.specBytes), the
 * records query budget; a job request is that spec inside its {"kind","spec"} envelope. */
const aggregationBody=32_768;
const jobBody=33_792;
/** Snapshot analysis and export jobs: submit, status, cancel and result pages, each reauthorized by the service. */
async function jobsRoute(services:StateplaneServices,p:string[],req:Request,prefix:Prefix):Promise<Response> {
  if (p.length===5 && req.method==='POST') {
    const {kind,spec}=analysisSubmission(await request(req,jobBody),aggregationBody);
    return json(await services.analysis.submit(...prefix,kind,spec),202);
  }
  const job=p[5];
  if (p.length===6 && req.method==='GET') return json(await services.analysis.status(...prefix,job));
  if (p.length===6 && req.method==='DELETE') return json(await services.analysis.cancel(...prefix,job));
  if (p.length===8 && p[6]==='pages' && req.method==='GET') {
    // A page number that is not a canonical decimal integer is NaN, which the service refuses.
    const page=integer(p[7]);
    return json(await services.analysis.page(...prefix,job,typeof page==='number' ? page : Number.NaN));
  }
  return fail('NOT_FOUND');
}
type Prefix = readonly [VerifiedCredential, string, string];
/* Body budgets. A text, claim or correction holds up to 1 MiB of text plus its
 * fields, and JSON escaping can grow it, so it takes the 3 MiB envelope the
 * batch route already uses. Every other evidence request is a few bounded
 * fields (IDs and types of at most 256 bytes, locators of at most 4,096). */
const largeBody = 3_145_728;
const smallBody = 32_768;
const digits = /^(?:0|[1-9]\d*)$/;

/** Parse a JSON body. Unparseable JSON becomes null, which the service refuses
 * after it has authorized the collection, as the authority does for records. */
async function request(req: Request, limit: number): Promise<unknown> {
  const text = await body(req, limit);
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
/** One query parameter: absent, its value, or every value when repeated, which
 * the service then refuses after authorization like any malformed field. */
function param(url: URL, name: string): string | string[] | undefined {
  const values = url.searchParams.getAll(name);
  return values.length > 1 ? values : values[0];
}
/** A canonical decimal integer becomes a number; anything else stays as sent, for the service to refuse. */
const integer = (value: string | string[] | undefined): unknown =>
  typeof value === 'string' && digits.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
/** An optional version or revision selector. A malformed one is NaN, which the service refuses after authorization. */
function selected(url: URL, name: string): number | undefined {
  const value = integer(param(url, name));
  return value === undefined ? undefined : typeof value === 'number' && value > 0 ? value : Number.NaN;
}
/** Build a query object from the parameters that were supplied. */
function query(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

/* A search or bundle request holds at most two texts of 4,000 bytes and 32
 * collection IDs of 256 bytes; JSON's six-byte escapes can grow that to
 * about 100 KiB, so 128 KiB admits every request the services accept. */
const retrievalBody = 131_072;
/** Parse a search or bundle body like an evidence body: the service validates it after admission. */
const retrievalRequest = (req: Request): Promise<unknown> => request(req, retrievalBody);

/** Base64 of a lowercase hex digest, without Node's Buffer. */
const base64 = (hex: string) => btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map(pair => Number.parseInt(pair, 16))));

/** Original bytes are untrusted content served from the API origin: never rendered, sniffed or cached. */
async function content(services: StateplaneServices, prefix: Prefix, sourceId: string): Promise<Response> {
  const { source, body: stream } = await services.sources.content(...prefix, sourceId);
  // no-transform keeps an intermediary from compressing the bytes Repr-Digest describes.
  const headers = new Headers({ 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'attachment' });
  if (!stream) {
    headers.set('X-Stateplane-Reference-Only', 'true');
    return new Response(null, { status: 204, headers });
  }
  const { mimeType, byteSize, sha256 } = source.original;
  headers.set('Content-Type', mimeType ?? 'application/octet-stream');
  if (byteSize !== null) headers.set('Content-Length', String(byteSize));
  if (sha256) headers.set('Repr-Digest', `sha-256=:${base64(sha256)}:`);
  return new Response(stream, { status: 200, headers });
}

/** Stream one upload attempt: Content-Length declares its size, Content-Type its MIME type, `sha256` an optional digest. */
async function upload(services: StateplaneServices, prefix: Prefix, grantId: string, req: Request, url: URL): Promise<Response> {
  const declared: Record<string, unknown> = {};
  const length = req.headers.get('content-length');
  if (length !== null) declared.bytes = integer(length);
  const type = req.headers.get('content-type');
  if (type !== null) declared.mimeType = type;
  const sha256 = param(url, 'sha256');
  if (sha256 !== undefined) declared.sha256 = sha256;
  const stream = req.body ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() });
  return json(await services.sources.upload(...prefix, grantId, stream, declared));
}

async function sourcesRoute(services: StateplaneServices, p: string[], req: Request, url: URL, prefix: Prefix): Promise<Response> {
  const method = req.method;
  const id = p[5];
  if (p.length === 6 && method === 'POST' && id === 'text')
    return json(await services.sources.ingestText(...prefix, await request(req, largeBody)));
  if (p.length === 6 && method === 'POST' && id === 'reference')
    return json(await services.sources.ingestReference(...prefix, await request(req, smallBody)));
  if (p.length === 6 && method === 'GET') return json(await services.sources.get(...prefix, id));
  if (p.length === 6 && method === 'DELETE') return json(await services.sources.delete(...prefix, id));
  if (p.length === 7 && p[6] === 'content' && method === 'GET') return content(services, prefix, id);
  if (p.length === 7 && p[6] === 'extraction' && method === 'GET')
    return json(await services.sources.extraction(...prefix, id, selected(url, 'version')));
  if (p.length === 7 && p[6] === 'extraction' && method === 'POST') return json(await services.sources.extract(...prefix, id));
  if (p.length === 8 && p[6] === 'extraction' && p[7] === 'corrections' && method === 'POST')
    return json(await services.sources.correctExtraction(...prefix, id, await request(req, largeBody)));
  return fail('NOT_FOUND');
}

async function uploadsRoute(services: StateplaneServices, p: string[], req: Request, url: URL, prefix: Prefix): Promise<Response> {
  if (p.length === 5 && req.method === 'POST')
    return json(await services.sources.createUpload(...prefix, await request(req, smallBody)), 201);
  if (p.length === 6 && req.method === 'DELETE') return json(await services.sources.revokeUpload(...prefix, p[5]));
  if (p.length === 7 && p[6] === 'attempts' && req.method === 'POST') return upload(services, prefix, p[5], req, url);
  if (p.length === 7 && p[6] === 'finalize' && req.method === 'POST')
    return json(await services.sources.finalizeUpload(...prefix, p[5], await request(req, smallBody)));
  return fail('NOT_FOUND');
}

async function claimsRoute(services: StateplaneServices, p: string[], req: Request, url: URL, prefix: Prefix): Promise<Response> {
  const method = req.method;
  if (p.length === 5 && method === 'POST') return json(await services.claims.create(...prefix, await request(req, largeBody)));
  if (p.length === 5 && method === 'GET') {
    const collectionId = param(url, 'citingCollection');
    const sourceId = param(url, 'citingSource');
    const citing = collectionId === undefined && sourceId === undefined ? undefined : query({ collectionId, sourceId });
    return json(await services.claims.list(...prefix, query({ citing, status: param(url, 'status'),
      after: param(url, 'after'), limit: integer(param(url, 'limit')) })));
  }
  if (p.length === 6 && method === 'GET') return json(await services.claims.get(...prefix, p[5], selected(url, 'revision')));
  if (p.length === 6 && method === 'DELETE')
    return json(await services.claims.delete(...prefix, p[5], query({ baseRevision: integer(param(url, 'baseRevision')) })));
  if (p.length === 7 && p[6] === 'revisions' && method === 'POST')
    return json(await services.claims.revise(...prefix, p[5], await request(req, largeBody)));
  if (p.length === 7 && p[6] === 'reviews' && method === 'POST')
    return json(await services.claims.review(...prefix, p[5], await request(req, smallBody)));
  return fail('NOT_FOUND');
}

async function linksRoute(services: StateplaneServices, p: string[], req: Request, url: URL, prefix: Prefix): Promise<Response> {
  if (p.length === 5 && req.method === 'POST') return json(await services.links.create(...prefix, await request(req, smallBody)));
  if (p.length === 5 && req.method === 'GET') {
    const kind = param(url, 'endpointKind');
    const id = param(url, 'endpointId');
    const endpoint = kind === undefined && id === undefined ? undefined : query({ kind, id });
    return json(await services.links.list(...prefix, query({ endpoint, after: param(url, 'after'),
      limit: integer(param(url, 'limit')) })));
  }
  if (p.length === 6 && req.method === 'GET') return json(await services.links.get(...prefix, p[5]));
  if (p.length === 6 && req.method === 'DELETE') return json(await services.links.delete(...prefix, p[5]));
  return fail('NOT_FOUND');
}

/** Sources, uploads, extractions, claims and links below one collection. The
 * services decide every permission; a route only frames the request. */
export async function evidenceRoute(services: StateplaneServices, p: string[], req: Request, url: URL, prefix: Prefix): Promise<Response> {
  if (p[4] === 'sources' && p.length >= 6) return sourcesRoute(services, p, req, url, prefix);
  if (p[4] === 'uploads') return uploadsRoute(services, p, req, url, prefix);
  if (p[4] === 'claims') return claimsRoute(services, p, req, url, prefix);
  if (p[4] === 'links') return linksRoute(services, p, req, url, prefix);
  return fail('NOT_FOUND');
}

function singleCursor(url:URL):string|undefined {
  if (url.searchParams.getAll('cursor').length>1) fail('CURSOR_INVALID');
  return url.searchParams.get('cursor')??undefined;
}
/** Owner agent access; the issuance response is the only place a secret appears. */
async function agentKeysRoute(services:StateplaneServices,actor:VerifiedCredential,space:string,p:string[],
  request:Request,url:URL):Promise<Response> {
  if (p.length===3 && request.method==='GET') return json(await services.agents.list(actor,space,singleCursor(url)));
  if (p.length===3 && request.method==='POST') return json(await services.agents.issue(actor,space,await body(request,16_384)),201);
  if (p.length===4 && request.method==='DELETE') return json(await services.agents.revoke(actor,space,p[3]));
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

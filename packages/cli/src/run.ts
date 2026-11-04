import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readConfig, saveConfig, configureToken, loadToken, logoutConfig, removeTrackedTokens, withConfigMutation } from './config.js';
import type { CliConfig } from './config.js';
import { StateplaneCliError, StateplaneHttpClient } from './transport.js';
import type { Deadline } from './transport.js';

type Flags=Record<string,string|boolean>;
const encoded=(value:string)=>value==='.' || value==='..' ? `;${value}` : encodeURIComponent(value);
const switches=new Set(['retry-failed','json','token-stdin','help']);
/** Consume one option and return the next unread argv position. */
function parseOption(argv:string[],index:number,flags:Flags):number {
  const item=argv[index];
  const equals=item.indexOf('=');
  const key=item.slice(2,equals<0?undefined:equals);
  if (!/^[a-z][a-z0-9-]*$/.test(key) || Object.hasOwn(flags,key)) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (switches.has(key)) {
    if (equals>=0) throw new StateplaneCliError('INVALID_ARGUMENT');
    flags[key]=true;
    return index;
  }
  const value=equals>=0 ? item.slice(equals+1) : argv[++index];
  if (value===undefined || (equals<0 && value.startsWith('--'))) throw new StateplaneCliError('INVALID_ARGUMENT');
  flags[key]=value;
  return index;
}
/** Keep explicit flag presence and JSON value spelling through dispatch. */
function parse(argv:string[]):{words:string[];flags:Flags} {
  const words:string[]=[]; const flags:Flags={};
  let i=0;
  while (i<argv.length) {
    const item=argv[i];
    if (!item.startsWith('--')) { words.push(item); i++; continue; }
    i=parseOption(argv,i,flags)+1;
  }
  return {words,flags};
}
/* HTTP body budgets of the evidence routes (largeBody and smallBody in packages/api/src/http.ts). */
const largeBody = 3_145_728;
const smallBody = 32_768;
/** The search and bundle body budget (retrievalBody in packages/api/src/http.ts). */
const retrievalBody = 131_072;
/** The service's upload bound (sourceBounds.uploadBytes, 25 MiB). */
const uploadBytes = 26_214_400;
/** The service's text bound (1 MiB of UTF-8). */
const textBytes = 1_048_576;

/** Flags accepted by each evidence command, beside --space, --json and --timeout. */
const evidenceCommands: Record<string, readonly string[]> = {
  'sources get': ['space', 'collection', 'id'],
  'sources content': ['space', 'collection', 'id', 'output'],
  'sources ingest-text': ['space', 'collection', 'idempotency-key', 'text', 'file', 'mime-type', 'locator', 'captured-at'],
  'sources ingest-reference': ['space', 'collection', 'idempotency-key', 'locator', 'mime-type', 'captured-at'],
  'sources delete': ['space', 'collection', 'id'],
  'sources extract': ['space', 'collection', 'id'],
  'sources extraction': ['space', 'collection', 'id', 'version'],
  'sources correct': ['space', 'collection', 'id', 'base-version', 'data', 'file'],
  'uploads create': ['space', 'collection', 'mime-type', 'max-bytes', 'sha256', 'expires-in'],
  'uploads send': ['space', 'collection', 'grant', 'file', 'mime-type', 'sha256'],
  'uploads finalize': ['space', 'collection', 'grant', 'attempt', 'locator', 'captured-at'],
  'uploads revoke': ['space', 'collection', 'grant'],
  'claims create': ['space', 'collection', 'idempotency-key', 'data', 'file'],
  'claims revise': ['space', 'collection', 'id', 'base-revision', 'data', 'file'],
  'claims review': ['space', 'collection', 'id', 'base-revision', 'status'],
  'claims delete': ['space', 'collection', 'id', 'base-revision'],
  'claims get': ['space', 'collection', 'id', 'revision'],
  'claims list': ['space', 'collection', 'status', 'citing-collection', 'citing-source', 'after', 'limit'],
  'links create': ['space', 'collection', 'idempotency-key', 'data', 'file'],
  'links get': ['space', 'collection', 'id'],
  'links delete': ['space', 'collection', 'id'],
  'links list': ['space', 'collection', 'endpoint-kind', 'endpoint-id', 'after', 'limit']
};

const common=['json'];
const allowed:Record<string,readonly string[]>={
  'config endpoint':['url'], 'config show':[],
  'auth login':['token-stdin','store','timeout'], 'auth import':['token-stdin','store'], 'auth logout':[],
  'spaces select':['space'], 'spaces list':['cursor'], 'spaces create':['cell','space'],
  'spaces get':['space'], 'spaces update':['space','lifecycle'], 'spaces delete':['space'], 'spaces erasure':['space'],
  'collections list':['space','cursor'], 'collections get':['space','collection'],
  'collections define':['space','collection','data','file'],
  'collections revise':['space','collection','data','file','version'],
  'records get':['space','collection','id'], 'records key':['space','collection','key','mode'],
  'records projection':['space','collection','id'],
  'records query':['space','collection','predicates','limit','sort','cursor'],
  'records count':['space','collection','predicates'],
  'records create':['space','collection','idempotency-key','expected-schema-version','data','file','key'],
  'records replace':['space','collection','idempotency-key','id','expected-revision','expected-schema-version','data','file'],
  'records patch':['space','collection','idempotency-key','id','expected-revision','expected-schema-version','data','file'],
  'records delete':['space','collection','idempotency-key','id','expected-revision','expected-schema-version'],
  'batches ingest':['space','collection','operation-key','file','retry-failed'],
  'batches status':['space','collection','operation-key'],
  'batches cancel':['space','collection','operation-key'],
  'events list':['space','collection','cursor'],
  'retrieval search':['space','data','file'], 'retrieval bundle':['space','data','file'],
  'retrieval status':['space','collection'],
  ...evidenceCommands
};
function validateFlags(resource:string,action:string|undefined,flags:Flags):void {
  const command=allowed[`${resource} ${action??''}`];
  if (!command) throw new StateplaneCliError('INVALID_ARGUMENT');
  const usesHttp=resource!=='config' && resource!=='auth' && !(resource==='spaces' && action==='select');
  const accepted=new Set([...command,...common,...(usesHttp?['timeout']:[])]);
  if (Object.keys(flags).some(key=>!accepted.has(key))) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (flags.space==='' || flags.cell==='' || flags.sort==='' || flags.key==='')
    throw new StateplaneCliError('INVALID_ARGUMENT');
  if (flags.timeout!==undefined) integer(required(flags,'timeout'));
}
function required(flags:Flags,key:string):string {
  const value=flags[key];
  if (typeof value!=='string' || !value) throw new StateplaneCliError('INVALID_ARGUMENT');
  return value;
}
function cursor(flags:Flags):string {
  const value=flags.cursor;
  if (typeof value!=='string' || !value) throw new StateplaneCliError('CURSOR_INVALID');
  return value;
}
function integer(value:string):number {
  if (!/^[1-9]\d*$/.test(value)) throw new StateplaneCliError('INVALID_ARGUMENT');
  const number=Number(value);
  if (!Number.isSafeInteger(number) || number<1) throw new StateplaneCliError('INVALID_ARGUMENT');
  return number;
}
/** Parse CLI JSON input. A number that overflows to Infinity is refused: JSON
 * would send it as null, which is a different request from the one given. */
function parsed(value:string):unknown {
  try {
    return JSON.parse(value,(_key,item:unknown)=>{
      if (typeof item==='number' && !Number.isFinite(item)) throw new StateplaneCliError('INVALID_ARGUMENT');
      return item;
    });
  } catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
}
/** The UTF-8 text of a file or stdin. keepBom keeps a leading byte order mark
 * so text stored as an original keeps every byte of the file; JSON and tokens
 * drop it. */
async function input(path:string,maxBytes:number,keepBom=false):Promise<string> {
  const source=path==='-'?process.stdin:createReadStream(path);
  const chunks:Buffer[]=[];let size=0;
  try {
    for await (const chunk of source) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;
      if (size>maxBytes) throw new StateplaneCliError('RATE_LIMITED',undefined,undefined,false);
      chunks.push(bytes);
    }
  } catch(error) {
    if (error instanceof StateplaneCliError) throw error;
    throw new StateplaneCliError('INVALID_ARGUMENT');
  }
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:keepBom}).decode(Buffer.concat(chunks)); }
  catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
}
/** The JSON of --data or --file, at most maxBytes: by default the record and
 * schema budget; an evidence command passes its route's body budget. */
async function payload(flags:Flags,maxBytes=1_048_576):Promise<unknown> {
  if (flags.data!==undefined && flags.file!==undefined) throw new StateplaneCliError('INVALID_ARGUMENT');
  const text=flags.file!==undefined ? await input(required(flags,'file'),maxBytes) : required(flags,'data');
  if (Buffer.byteLength(text)>maxBytes) throw new StateplaneCliError('RATE_LIMITED',undefined,undefined,false);
  return parsed(text);
}
function withinWireBudget<T>(value:T,maxBytes:number):T {
  // Match StateplaneHttpClient's JSON serialization for every JSON value.
  const serialized=JSON.stringify(value);
  if (serialized===undefined) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (Buffer.byteLength(serialized)>maxBytes)
    throw new StateplaneCliError('RATE_LIMITED',undefined,undefined,false);
  return value;
}
function endpoint(value:string):string {
  let url:URL;
  try { url=new URL(value); } catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
  if (url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
    (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw new StateplaneCliError('INVALID_ARGUMENT');
  return url.origin+'/';
}
function output(value:unknown):void { process.stdout.write(JSON.stringify(value)+'\n'); }
function help():void {
  output({usage:'stateplane <config|auth|spaces|collections|records|batches|events|sources|uploads|claims|links|retrieval> <command> [--space ID] [--collection ID] [options]',
    docs:'See docs/http-cli.md for examples and recovery rules.'});
}

async function runConfig(action:string|undefined,flags:Flags,config:CliConfig):Promise<unknown> {
  if (action==='show') return {endpoint:config.endpoint??null,space:config.space??null,tokenStore:config.tokenStore??null};
  if (action!=='endpoint') throw new StateplaneCliError('INVALID_ARGUMENT');
  const value=endpoint(required(flags,'url'));
  return withConfigMutation(async current=>{
    const changed=current.endpoint!==value;
    if (current.endpoint && changed) await removeTrackedTokens(current);
    await saveConfig({...current,endpoint:value,
      space:changed?undefined:current.space,
      tokenStore:changed?undefined:current.tokenStore,
      tokenLocations:changed?undefined:current.tokenLocations});
    return {endpoint:value,space:changed?null:current.space??null};
  });
}

async function runAuth(action:string|undefined,flags:Flags,config:CliConfig):Promise<unknown> {
  if (action==='logout') {
    await withConfigMutation(current=>logoutConfig(current));
    return {configured:false};
  }
  if (action!=='login' && action!=='import') throw new StateplaneCliError('INVALID_ARGUMENT');
  if (!config.endpoint || flags['token-stdin']!==true) throw new StateplaneCliError('INVALID_ARGUMENT');
  const store=flags.store ?? (process.platform==='linux'?'keychain':'file');
  if (store!=='file' && store!=='keychain') throw new StateplaneCliError('INVALID_ARGUMENT');
  const token=(await input('-',4096)).replace(/\r?\n$/,'');
  if (action==='login') await new StateplaneHttpClient({endpoint:config.endpoint,token,
    timeoutMs:flags.timeout ? integer(required(flags,'timeout')) : undefined}).request('GET','/v1/auth/session');
  await withConfigMutation(async current=>{
    if (current.endpoint!==config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
    await configureToken(current,token,store);
  });
  return {configured:true,store};
}

async function runSpaces(client:StateplaneHttpClient,action:string|undefined,flags:Flags,spacePath:string):Promise<unknown> {
  if (action==='list') {
    const suffix=flags.cursor===undefined ? '' : `?cursor=${encoded(cursor(flags))}`;
    return client.request('GET',`/v1/spaces${suffix}`);
  }
  if (action==='create') return client.request('POST','/v1/spaces',
    withinWireBudget({spaceId:required(flags,'space'),...(flags.cell ? {cellId:flags.cell}:{})},4096));
  if (action==='get' && spacePath) return client.request('GET',spacePath);
  if (action==='update' && spacePath) return client.request('PATCH',spacePath,
    withinWireBudget({lifecycle:required(flags,'lifecycle')},4096));
  if (action==='delete' && spacePath) return client.request('DELETE',spacePath);
  if (action==='erasure' && spacePath) return client.request('GET',`${spacePath}/erasure`);
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function runCollections(client:StateplaneHttpClient,action:string|undefined,flags:Flags,
  spacePath:string,collectionPath:string):Promise<unknown> {
  if (action==='list') {
    const suffix=flags.cursor!==undefined ? `?cursor=${encoded(cursor(flags))}` : '';
    return client.request('GET',`${spacePath}/collections${suffix}`);
  }
  if (action==='get' && collectionPath) return client.request('GET',collectionPath);
  if (action==='define' && collectionPath) return client.request('PUT',collectionPath,
    withinWireBudget(await payload(flags),1_048_576));
  if (action==='revise' && collectionPath) return client.request('PATCH',collectionPath,
    withinWireBudget(await payload(flags),1_048_576),
    {'If-Match':String(integer(required(flags,'version')))});
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function mutationRequest(action:string,flags:Flags):Promise<Record<string,unknown>> {
  const request:Record<string,unknown>={operation:action,idempotencyKey:required(flags,'idempotency-key')};
  if (flags['expected-schema-version']!==undefined)
    request.expectedSchemaVersion=integer(required(flags,'expected-schema-version'));
  if (action==='create') {
    request.data=await payload(flags);
    if (flags.key!==undefined) request.externalKey=required(flags,'key');
    return request;
  }
  request.id=required(flags,'id');
  request.expectedRevision=integer(required(flags,'expected-revision'));
  if (action==='replace') request.data=await payload(flags);
  if (action==='patch') {
    const patch=await payload(flags) as {set?:unknown;unset?:unknown}|null;
    if (!patch || typeof patch!=='object' || Array.isArray(patch) ||
      !patch.set || typeof patch.set!=='object' || Array.isArray(patch.set) ||
      !Array.isArray(patch.unset) || patch.unset.some(value=>typeof value!=='string'))
      throw new StateplaneCliError('INVALID_ARGUMENT');
    request.set=patch.set;
    request.unset=patch.unset;
  }
  return request;
}

async function runRecords(client:StateplaneHttpClient,action:string|undefined,flags:Flags,recordPath:string):Promise<unknown> {
  if (action==='get') return client.request('GET',`${recordPath}/${encoded(required(flags,'id'))}`);
  if (action==='key') return client.request('GET',`${recordPath}/by-key/${encoded(required(flags,'key'))}?mode=${encoded(required(flags,'mode'))}`);
  if (action==='projection') return client.request('GET',`${recordPath}/${encoded(required(flags,'id'))}/projection`);
  if (action==='query') return client.request('POST',`${recordPath}/query`,withinWireBudget({
    predicates:parsed(typeof flags.predicates==='string'?flags.predicates:'[]'),
    limit:integer(required(flags,'limit')),
    ...(flags.sort ? {sort:parsed(required(flags,'sort'))}:{}),
    ...(flags.cursor!==undefined ? {cursor:cursor(flags)}:{} )},32_768));
  if (action==='count') return client.request('POST',`${recordPath}/count`,
    withinWireBudget(parsed(typeof flags.predicates==='string'?flags.predicates:'[]'),32_768));
  if (action && ['create','replace','patch','delete'].includes(action))
    return client.request('POST',recordPath,withinWireBudget(await mutationRequest(action,flags),1_048_576));
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function runBatches(client:StateplaneHttpClient,action:string|undefined,flags:Flags,collectionPath:string):Promise<unknown> {
  const operation=required(flags,'operation-key');
  const url=`${collectionPath}/batches/${encoded(operation)}`;
  if (action==='status') return client.request('GET',url);
  if (action==='cancel') return client.request('DELETE',url);
  if (action!=='ingest') throw new StateplaneCliError('INVALID_ARGUMENT');
  const lines=(await input(required(flags,'file'),3_145_728)).split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.length>20) throw new StateplaneCliError('INVALID_ARGUMENT');
  // Preserve each item string for HTTP-to-CLI same-key recovery.
  const manifest=lines.map(line=>{ parsed(line); return line; });
  const itemBytes=manifest.map(item=>Buffer.byteLength(item));
  if (itemBytes.some(size=>size>1_048_576) ||
    itemBytes.reduce((sum,size)=>sum+size,0)>2_097_152)
    throw new StateplaneCliError('INVALID_ARGUMENT');
  return client.request('PUT',url+(flags['retry-failed']?'?retryFailed=true':''),
    withinWireBudget(manifest,3_145_728));
}

/** Optional string flags, copied under their request field names when supplied. */
function optional(flags: Flags, names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [flag, field] of Object.entries(names)) if (flags[flag] !== undefined) out[field] = required(flags, flag);
  return out;
}
/** A JSON object payload extended with one field taken from a flag; the payload may not set it too.
 * The payload is read within the route's body budget, which the caller checks again with the field added. */
async function objectWith(flags: Flags, field: string, value: unknown, maxBytes: number): Promise<Record<string, unknown>> {
  const data = await payload(flags, maxBytes);
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, field))
    throw new StateplaneCliError('INVALID_ARGUMENT');
  return { [field]: value, ...data };
}
/** The query string of the supplied parameters, each encoded once. */
function search(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.append(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
}
async function fileBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new StateplaneCliError('RATE_LIMITED', undefined, undefined, false);
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof StateplaneCliError) throw error;
    throw new StateplaneCliError('INVALID_ARGUMENT');
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Write all of one chunk at the file's current position; no progress is a
 * failure, and no write starts once the download's deadline has passed. */
async function writeAll(file: FileHandle, chunk: Uint8Array, deadline: Deadline): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    if (deadline.expired()) throw new Error('deadline passed');
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset); // NOSONAR -- writes keep stream order
    if (!(bytesWritten > 0)) throw new Error('short write');
    offset += bytesWritten;
  }
}

/**
 * Save a source's original to a new file and report it as JSON; stdout stays
 * one JSON value. The file must not exist. The bytes are hashed as they are
 * written, and the file counts as saved only once every byte is written and it
 * has closed, all before the download's deadline. Any failure removes the file,
 * once the pending write or close has settled, so cleanup never races a write.
 * A body whose stream fails or is aborted, or a download that ends past its
 * deadline (--timeout bounds the requests, the body, every local write and the
 * close), fails retryable PROVIDER_UNAVAILABLE: the same read may succeed again,
 * and no success is reported once the deadline has passed. Within the deadline, a
 * write or close that fails, a digest that differs from Repr-Digest (which is required),
 * or a length that differs from the Content-Length of an unencoded response
 * fails nonretryable PROVIDER_UNAVAILABLE. A response without Content-Length (a
 * chunked body) is verified by its digest alone.
 */
async function saveContent(client: StateplaneHttpClient, path: string, output: string): Promise<unknown> {
  const { response, deadline } = await client.download(path);
  if (response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return { referenceOnly: true, output: null };
  }
  const digest = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(response.headers.get('repr-digest') ?? '')?.[1];
  const declared = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  // The Content-Length of a content coding counts encoded bytes, which fetch has already decoded.
  const encoded = encoding !== null && encoding.trim().toLowerCase() !== 'identity';
  let length: number | null = null;
  if (declared !== null && !encoded) length = /^(?:0|[1-9]\d*)$/.test(declared) ? Number(declared) : Number.NaN;
  let file;
  try { file = await open(output, 'wx', 0o600); }
  catch {
    await response.body?.cancel().catch(() => {});
    throw new StateplaneCliError('INVALID_ARGUMENT');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  let complete = true;
  let interrupted = false;
  const reader = response.body?.getReader();
  while (reader && complete) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try { next = await reader.read(); }
    catch { interrupted = true; complete = false; break; }
    if (next.done) break;
    try { await writeAll(file, next.value, deadline); }
    catch { complete = false; await reader.cancel().catch(() => {}); break; }
    hash.update(next.value); bytes += next.value.byteLength;
  }
  complete &&= digest !== undefined && hash.digest('base64') === digest && (length === null || bytes === length);
  try { await file.close(); } catch { complete = false; }
  // Every write and the close have settled: a download that ended past its deadline is not saved.
  const late = deadline.expired();
  if (!complete || late) {
    await unlink(output).catch(() => {});
    throw new StateplaneCliError('PROVIDER_UNAVAILABLE', undefined, undefined, interrupted || late);
  }
  return { referenceOnly: false, output, bytes, sha256: Buffer.from(digest!, 'base64').toString('hex'),
    mimeType: response.headers.get('content-type') };
}

async function runSources(client: StateplaneHttpClient, action: string, flags: Flags, base: string): Promise<unknown> {
  const sources = `${base}/sources`;
  if (action === 'ingest-text') {
    if ((flags.text === undefined) === (flags.file === undefined)) throw new StateplaneCliError('INVALID_ARGUMENT');
    const text = flags.file !== undefined ? await input(required(flags, 'file'), textBytes, true) : required(flags, 'text');
    return client.request('POST', `${sources}/text`, withinWireBudget({ idempotencyKey: required(flags, 'idempotency-key'), text,
      ...optional(flags, { 'mime-type': 'mimeType', locator: 'locator', 'captured-at': 'capturedAt' }) }, largeBody));
  }
  if (action === 'ingest-reference')
    return client.request('POST', `${sources}/reference`, withinWireBudget({ idempotencyKey: required(flags, 'idempotency-key'),
      locator: required(flags, 'locator'), ...optional(flags, { 'mime-type': 'mimeType', 'captured-at': 'capturedAt' }) }, smallBody));
  const source = `${sources}/${encoded(required(flags, 'id'))}`;
  if (action === 'get') return client.request('GET', source);
  if (action === 'delete') return client.request('DELETE', source);
  if (action === 'content') return saveContent(client, `${source}/content`, required(flags, 'output'));
  if (action === 'extract') return client.request('POST', `${source}/extraction`);
  if (action === 'extraction') return client.request('GET', `${source}/extraction${search({
    version: flags.version === undefined ? undefined : String(integer(required(flags, 'version'))) })}`);
  if (action === 'correct')
    return client.request('POST', `${source}/extraction/corrections`, withinWireBudget(await objectWith(flags, 'baseVersion',
      integer(required(flags, 'base-version')), largeBody), largeBody));
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function runUploads(client: StateplaneHttpClient, action: string, flags: Flags, base: string): Promise<unknown> {
  const uploads = `${base}/uploads`;
  if (action === 'create')
    return client.request('POST', uploads, withinWireBudget({ mimeType: required(flags, 'mime-type'),
      maxBytes: integer(required(flags, 'max-bytes')), ...optional(flags, { sha256: 'sha256' }),
      ...(flags['expires-in'] === undefined ? {} : { expiresInSeconds: integer(required(flags, 'expires-in')) }) }, smallBody));
  const grant = `${uploads}/${encoded(required(flags, 'grant'))}`;
  if (action === 'revoke') return client.request('DELETE', grant);
  if (action === 'finalize')
    return client.request('POST', `${grant}/finalize`, withinWireBudget({ attemptId: required(flags, 'attempt'),
      ...optional(flags, { locator: 'locator', 'captured-at': 'capturedAt' }) }, smallBody));
  if (action === 'send') {
    const mimeType = required(flags, 'mime-type');
    const bytes = await fileBytes(required(flags, 'file'), uploadBytes);
    return client.upload(`${grant}/attempts${search({ sha256: flags.sha256 === undefined ? undefined : required(flags, 'sha256') })}`,
      bytes, mimeType);
  }
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function runClaims(client: StateplaneHttpClient, action: string, flags: Flags, base: string): Promise<unknown> {
  const claims = `${base}/claims`;
  if (action === 'create')
    return client.request('POST', claims, withinWireBudget(await objectWith(flags, 'idempotencyKey',
      required(flags, 'idempotency-key'), largeBody), largeBody));
  if (action === 'list')
    return client.request('GET', `${claims}${search({ status: flags.status === undefined ? undefined : required(flags, 'status'),
      citingCollection: flags['citing-collection'] === undefined ? undefined : required(flags, 'citing-collection'),
      citingSource: flags['citing-source'] === undefined ? undefined : required(flags, 'citing-source'),
      after: flags.after === undefined ? undefined : required(flags, 'after'),
      limit: flags.limit === undefined ? undefined : String(integer(required(flags, 'limit'))) })}`);
  const claim = `${claims}/${encoded(required(flags, 'id'))}`;
  if (action === 'get') return client.request('GET', `${claim}${search({
    revision: flags.revision === undefined ? undefined : String(integer(required(flags, 'revision'))) })}`);
  const baseRevision = integer(required(flags, 'base-revision'));
  if (action === 'revise')
    return client.request('POST', `${claim}/revisions`, withinWireBudget(await objectWith(flags, 'baseRevision', baseRevision, largeBody), largeBody));
  if (action === 'review')
    return client.request('POST', `${claim}/reviews`, withinWireBudget({ baseRevision, status: required(flags, 'status') }, smallBody));
  if (action === 'delete') return client.request('DELETE', `${claim}${search({ baseRevision: String(baseRevision) })}`);
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

async function runLinks(client: StateplaneHttpClient, action: string, flags: Flags, base: string): Promise<unknown> {
  const links = `${base}/links`;
  if (action === 'create')
    return client.request('POST', links, withinWireBudget(await objectWith(flags, 'idempotencyKey',
      required(flags, 'idempotency-key'), smallBody), smallBody));
  if (action === 'list')
    return client.request('GET', `${links}${search({ endpointKind: required(flags, 'endpoint-kind'),
      endpointId: required(flags, 'endpoint-id'), after: flags.after === undefined ? undefined : required(flags, 'after'),
      limit: flags.limit === undefined ? undefined : String(integer(required(flags, 'limit'))) })}`);
  const link = `${links}/${encoded(required(flags, 'id'))}`;
  if (action === 'get') return client.request('GET', link);
  if (action === 'delete') return client.request('DELETE', link);
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

/** Sources, uploads, claims and links of one collection, through the same HTTP routes as any client. */
async function runEvidence(client: StateplaneHttpClient, resource: string, action: string | undefined, flags: Flags,
  collectionPath: string): Promise<unknown> {
  if (!action) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (resource === 'sources') return runSources(client, action, flags, collectionPath);
  if (resource === 'uploads') return runUploads(client, action, flags, collectionPath);
  if (resource === 'claims') return runClaims(client, action, flags, collectionPath);
  if (resource === 'links') return runLinks(client, action, flags, collectionPath);
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

/** Route a selected collection without reading credentials again. */
async function runCollectionResource(client:StateplaneHttpClient,resource:string,action:string|undefined,
  flags:Flags,spacePath:string):Promise<unknown> {
  const collection=typeof flags.collection==='string' ? flags.collection : undefined;
  const collectionPath=collection ? `${spacePath}/collections/${encoded(collection)}` : '';
  if (resource==='collections') return runCollections(client,action,flags,spacePath,collectionPath);
  if (!collectionPath) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (resource==='records') return runRecords(client,action,flags,`${collectionPath}/records`);
  if (resource==='batches') return runBatches(client,action,flags,collectionPath);
  if (['sources','uploads','claims','links'].includes(resource)) return runEvidence(client,resource,action,flags,collectionPath);
  if (resource==='events' && action==='list') {
    const suffix=flags.cursor!==undefined ? `?cursor=${encoded(cursor(flags))}` : '';
    return client.request('GET',`${collectionPath}/events${suffix}`);
  }
  throw new StateplaneCliError('INVALID_ARGUMENT');
}

/** Search, bundles and projection status. A search or bundle request is the JSON object of --data or --file,
 * sent as the HTTP body, so every transport passes the service the same request. */
async function runRetrieval(client:StateplaneHttpClient,action:string|undefined,flags:Flags,spacePath:string):Promise<unknown> {
  if (action==='status') return client.request('GET',`${spacePath}/collections/${encoded(required(flags,'collection'))}/projections`);
  const data=await payload(flags,retrievalBody);
  if (!data || typeof data!=='object' || Array.isArray(data)) throw new StateplaneCliError('INVALID_ARGUMENT');
  return client.request('POST',`${spacePath}/${action==='search' ? 'search' : 'bundles'}`,withinWireBudget(data,retrievalBody));
}

/** Capture endpoint, selected space and token as one cross-process snapshot. */
async function runHttpCommand(resource:string,action:string|undefined,flags:Flags):Promise<unknown> {
  const snapshot=await withConfigMutation(async current=>({config:current,token:await loadToken(current)}));
  if (!snapshot.config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
  const client=new StateplaneHttpClient({endpoint:snapshot.config.endpoint,token:snapshot.token,
    timeoutMs:flags.timeout ? integer(required(flags,'timeout')) : undefined});
  const space=typeof flags.space==='string' ? flags.space : snapshot.config.space;
  const spacePath=space ? `/v1/spaces/${encoded(space)}` : '';
  if (resource==='spaces') return runSpaces(client,action,flags,spacePath);
  if (!spacePath) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (resource==='retrieval') return runRetrieval(client,action,flags,spacePath);
  return runCollectionResource(client,resource,action,flags,spacePath);
}

/** One command produces one JSON value. Errors contain only stable fields;
 * no token, provider response body, or input payload is printed. */
export async function runCli(argv:string[]):Promise<number> {
  try {
    const {words,flags}=parse(argv);
    const [resource,action,...rest]=words;
    if (!resource || resource==='help' || flags.help) { help(); return 0; }
    if (rest.length) throw new StateplaneCliError('INVALID_ARGUMENT');
    validateFlags(resource,action,flags);
    const config=await readConfig();
    if (resource==='config') output(await runConfig(action,flags,config));
    else if (resource==='auth') output(await runAuth(action,flags,config));
    else if (resource==='spaces' && action==='select') {
      const space=required(flags,'space');
      await withConfigMutation(async current=>{await saveConfig({...current,space});});
      output({space});
    } else output(await runHttpCommand(resource,action,flags));
    return 0;
  } catch(error) {
    const localCode=(error as NodeJS.ErrnoException)?.code;
    let failure:StateplaneCliError;
    if (error instanceof StateplaneCliError) failure=error;
    else if (typeof localCode==='string' &&
      ['EACCES','EPERM','ENOENT','ENOTDIR','EISDIR','EROFS','ENOSPC'].includes(localCode))
      failure=new StateplaneCliError('INVALID_CONFIGURATION');
    else failure=new StateplaneCliError('PROVIDER_UNAVAILABLE');
    process.stderr.write(JSON.stringify({contractVersion:'1',error:{code:failure.code,message:failure.code,
      retryable:failure.retryable,requestId:failure.requestId??null}})+'\n');
    return 1;
  }
}

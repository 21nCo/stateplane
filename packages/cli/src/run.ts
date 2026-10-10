import { createReadStream } from 'node:fs';
import { readConfig, saveConfig, configureToken, loadToken, logoutConfig, removeTrackedTokens, withConfigMutation } from './config.js';
import type { CliConfig } from './config.js';
import { StateplaneCliError, StateplaneHttpClient } from './transport.js';

type Flags=Record<string,string|boolean>;
const encoded=(value:string)=>value==='.' || value==='..' ? `;${value}` : encodeURIComponent(value);
const switches=new Set(['retry-failed','json','token-stdin','help']);
/** Consume one option and return the next unread argv position. */
function parseOption(argv:string[],index:number,flags:Flags):number {
  const item=argv[index];
  const equals=item.indexOf('=');
  const key=item.slice(2,equals<0?undefined:equals);
  if (!/^[a-z][a-z-]*$/.test(key) || Object.hasOwn(flags,key)) throw new StateplaneCliError('INVALID_ARGUMENT');
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
const common=['json'];
const allowed:Record<string,readonly string[]>={
  'config endpoint':['url'], 'config show':[],
  'auth login':['token-stdin','store','timeout'], 'auth import':['token-stdin','store'], 'auth logout':[],
  'spaces select':['space'], 'spaces list':['cursor'], 'spaces create':['cell','space'],
  'spaces get':['space'], 'spaces update':['space','lifecycle'], 'spaces delete':['space'],
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
  'events list':['space','collection','cursor']
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
function parsed(value:string):unknown {
  try { return JSON.parse(value); } catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
}
async function input(path:string,maxBytes:number):Promise<string> {
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
  try { return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)); }
  catch { throw new StateplaneCliError('INVALID_ARGUMENT'); }
}
async function payload(flags:Flags):Promise<unknown> {
  if (flags.data!==undefined && flags.file!==undefined) throw new StateplaneCliError('INVALID_ARGUMENT');
  const text=flags.file!==undefined ? await input(required(flags,'file'),1_048_576) : required(flags,'data');
  if (Buffer.byteLength(text)>1_048_576) throw new StateplaneCliError('RATE_LIMITED',undefined,undefined,false);
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
  output({usage:'stateplane <config|auth|spaces|collections|records|batches|events> <command> [--space ID] [--collection ID] [options]',
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

/** Route a selected collection without reading credentials again. */
async function runCollectionResource(client:StateplaneHttpClient,resource:string,action:string|undefined,
  flags:Flags,spacePath:string):Promise<unknown> {
  const collection=typeof flags.collection==='string' ? flags.collection : undefined;
  const collectionPath=collection ? `${spacePath}/collections/${encoded(collection)}` : '';
  if (resource==='collections') return runCollections(client,action,flags,spacePath,collectionPath);
  if (!collectionPath) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (resource==='records') return runRecords(client,action,flags,`${collectionPath}/records`);
  if (resource==='batches') return runBatches(client,action,flags,collectionPath);
  if (resource==='events' && action==='list') {
    const suffix=flags.cursor!==undefined ? `?cursor=${encoded(cursor(flags))}` : '';
    return client.request('GET',`${collectionPath}/events${suffix}`);
  }
  throw new StateplaneCliError('INVALID_ARGUMENT');
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

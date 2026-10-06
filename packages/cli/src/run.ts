import { createReadStream } from 'node:fs';
import { readConfig, saveConfig, saveToken, loadToken, removeToken } from './config.js';
import { StateplaneCliError, StateplaneHttpClient } from './transport.js';

type Flags=Record<string,string|boolean>;
const encoded=(value:string)=>value==='.' || value==='..' ? `;${value}` : encodeURIComponent(value);
function parse(argv:string[]):{words:string[];flags:Flags} {
  const words:string[]=[]; const flags:Flags={};
  const switches=new Set(['retry-failed','json','token-stdin','help','verbose','debug']);
  for (let i=0;i<argv.length;i++) {
    const item=argv[i];
    if (!item.startsWith('--')) { words.push(item); continue; }
    const key=item.slice(2);
    if (!/^[a-z][a-z-]*$/.test(key) || Object.hasOwn(flags,key)) throw new StateplaneCliError('INVALID_ARGUMENT');
    if (switches.has(key)) flags[key]=true;
    else {
      const value=argv[++i];
      if (value===undefined || value.startsWith('--')) throw new StateplaneCliError('INVALID_ARGUMENT');
      flags[key]=value;
    }
  }
  return {words,flags};
}
const common=['json','verbose','debug'];
const allowed:Record<string,readonly string[]>={
  'config endpoint':['url'], 'config show':[],
  'auth login':['token-stdin','store','timeout'], 'auth import':['token-stdin','store'], 'auth logout':[],
  'spaces select':['space'], 'spaces list':[], 'spaces create':['cell','space'],
  'spaces get':['space'], 'spaces update':['space','lifecycle'], 'spaces delete':['space'],
  'collections list':['space'], 'collections get':['space','collection'],
  'collections define':['space','collection','data','file'],
  'collections revise':['space','collection','data','file','version'],
  'records get':['space','collection','id'], 'records key':['space','collection','key','mode'],
  'records projection':['space','collection','id'],
  'records query':['space','collection','predicates','limit','sort','cursor'],
  'records count':['space','collection','predicates'],
  'records create':['space','collection','idempotency-key','data','file','key'],
  'records replace':['space','collection','idempotency-key','id','expected-revision','data','file'],
  'records patch':['space','collection','idempotency-key','id','expected-revision','data','file'],
  'records delete':['space','collection','idempotency-key','id','expected-revision'],
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
  if (flags.timeout!==undefined) integer(required(flags,'timeout'));
}
function required(flags:Flags,key:string):string {
  const value=flags[key];
  if (typeof value!=='string' || !value) throw new StateplaneCliError('INVALID_ARGUMENT');
  return value;
}
function integer(value:string):number {
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
  if (flags.data && flags.file) throw new StateplaneCliError('INVALID_ARGUMENT');
  const text=flags.file ? await input(required(flags,'file'),1_048_576) : required(flags,'data');
  if (Buffer.byteLength(text)>1_048_576) throw new StateplaneCliError('RATE_LIMITED',undefined,undefined,false);
  return parsed(text);
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
    if (resource==='config' && action==='endpoint') {
      const value=endpoint(required(flags,'url'));
      if (config.endpoint && config.endpoint!==value && config.tokenStore) await removeToken(config);
      await saveConfig({...config,endpoint:value,
        tokenStore:config.endpoint===value?config.tokenStore:undefined});
      output({endpoint:value,space:config.space??null}); return 0;
    }
    if (resource==='config' && action==='show') {
      output({endpoint:config.endpoint??null,space:config.space??null,tokenStore:config.tokenStore??null}); return 0;
    }
    if (resource==='auth' && (action==='login' || action==='import')) {
      if (!config.endpoint || flags['token-stdin']!==true) throw new StateplaneCliError('INVALID_ARGUMENT');
      const store=typeof flags.store==='string'?flags.store:'keychain';
      if (store!=='file' && store!=='keychain') throw new StateplaneCliError('INVALID_ARGUMENT');
      const token=(await input('-',4096)).replace(/\r?\n$/,'');
      if (action==='login') await new StateplaneHttpClient({endpoint:config.endpoint,token,
        timeoutMs:flags.timeout ? integer(required(flags,'timeout')) : undefined}).request('GET','/v1/auth/session');
      await saveToken(config.endpoint,token,store);
      if (config.tokenStore && config.tokenStore!==store) await removeToken(config);
      await saveConfig({...config,tokenStore:store}); output({configured:true,store}); return 0;
    }
    if (resource==='auth' && action==='logout') {
      await removeToken(config); await saveConfig({...config,tokenStore:undefined}); output({configured:false}); return 0;
    }
    if (resource==='spaces' && action==='select') {
      const space=required(flags,'space');
      await saveConfig({...config,space}); output({space}); return 0;
    }
    if (!config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
    const client=new StateplaneHttpClient({endpoint:config.endpoint,token:await loadToken(config),
      timeoutMs:flags.timeout ? integer(required(flags,'timeout')) : undefined});
    const space=typeof flags.space==='string' ? flags.space : config.space;
    const spacePath=space ? `/v1/spaces/${encoded(space)}` : '';
    if (resource==='spaces') {
      if (action==='list') output(await client.request('GET','/v1/spaces'));
      else if (action==='create') output(await client.request('POST','/v1/spaces',
        {spaceId:required(flags,'space'),...(flags.cell ? {cellId:flags.cell}:{})}));
      else if (action==='get' && spacePath) output(await client.request('GET',spacePath));
      else if (action==='update' && spacePath) output(await client.request('PATCH',spacePath,{lifecycle:required(flags,'lifecycle')}));
      else if (action==='delete' && spacePath) output(await client.request('DELETE',spacePath));
      else throw new StateplaneCliError('INVALID_ARGUMENT');
      return 0;
    }
    if (!spacePath) throw new StateplaneCliError('INVALID_ARGUMENT');
    const collection=typeof flags.collection==='string' ? flags.collection : undefined;
    const collectionPath=collection ? `${spacePath}/collections/${encoded(collection)}` : '';
    if (resource==='collections') {
      if (action==='list') output(await client.request('GET',`${spacePath}/collections`));
      else if (action==='get' && collectionPath) output(await client.request('GET',collectionPath));
      else if (action==='define' && collectionPath) output(await client.request('PUT',collectionPath,await payload(flags)));
      else if (action==='revise' && collectionPath) output(await client.request('PATCH',collectionPath,await payload(flags),
        {'If-Match':String(integer(required(flags,'version')))}));
      else throw new StateplaneCliError('INVALID_ARGUMENT');
      return 0;
    }
    if (!collectionPath) throw new StateplaneCliError('INVALID_ARGUMENT');
    const recordPath=`${collectionPath}/records`;
    if (resource==='records') {
      if (action==='get') output(await client.request('GET',`${recordPath}/${encoded(required(flags,'id'))}`));
      else if (action==='key') output(await client.request('GET',`${recordPath}/by-key/${encoded(required(flags,'key'))}?mode=${encoded(required(flags,'mode'))}`));
      else if (action==='projection') output(await client.request('GET',`${recordPath}/${encoded(required(flags,'id'))}/projection`));
      else if (action==='query') output(await client.request('POST',`${recordPath}/query`,{
        predicates:parsed(typeof flags.predicates==='string'?flags.predicates:'[]'),
        limit:integer(required(flags,'limit')),
        ...(flags.sort ? {sort:parsed(required(flags,'sort'))}:{}),
        ...(flags.cursor!==undefined ? {cursor:required(flags,'cursor')}:{} )}));
      else if (action==='count') output(await client.request('POST',`${recordPath}/count`,
        parsed(typeof flags.predicates==='string'?flags.predicates:'[]')));
      else if (['create','replace','patch','delete'].includes(action??'')) {
        const request:Record<string,unknown>={operation:action,idempotencyKey:required(flags,'idempotency-key')};
        if (action==='create') {
          request.data=await payload(flags);
          if (flags.key) request.externalKey=required(flags,'key');
        } else {
          request.id=required(flags,'id'); request.expectedRevision=integer(required(flags,'expected-revision'));
          if (action==='replace') request.data=await payload(flags);
          if (action==='patch') {
            const patch=await payload(flags) as {set?:unknown;unset?:unknown}|null;
            if (!patch || typeof patch!=='object' || Array.isArray(patch) ||
              !patch.set || typeof patch.set!=='object' || Array.isArray(patch.set) ||
              !Array.isArray(patch.unset) || patch.unset.some(value=>typeof value!=='string'))
              throw new StateplaneCliError('INVALID_ARGUMENT');
            request.set=patch.set; request.unset=patch.unset;
          }
        }
        output(await client.request('POST',recordPath,request));
      } else throw new StateplaneCliError('INVALID_ARGUMENT');
      return 0;
    }
    if (resource==='batches') {
      const operation=required(flags,'operation-key');
      const url=`${collectionPath}/batches/${encoded(operation)}`;
      if (action==='ingest') {
        const lines=(await input(required(flags,'file'),3_145_728)).split(/\r?\n/).filter(Boolean);
        if (!lines.length || lines.length>20) throw new StateplaneCliError('INVALID_ARGUMENT');
        const manifest=lines.map(line=>JSON.stringify(parsed(line)));
        output(await client.request('PUT',url+(flags['retry-failed']?'?retryFailed=true':''),manifest));
      } else if (action==='status') output(await client.request('GET',url));
      else if (action==='cancel') output(await client.request('DELETE',url));
      else throw new StateplaneCliError('INVALID_ARGUMENT');
      return 0;
    }
    if (resource==='events' && action==='list') {
      output(await client.request('GET',`${collectionPath}/events${flags.cursor?`?cursor=${encoded(required(flags,'cursor'))}`:''}`));
      return 0;
    }
    throw new StateplaneCliError('INVALID_ARGUMENT');
  } catch(error) {
    const localCode=(error as NodeJS.ErrnoException)?.code;
    const failure=error instanceof StateplaneCliError?error:
      typeof localCode==='string' && ['EACCES','EPERM','ENOENT','ENOTDIR','EISDIR','EROFS','ENOSPC'].includes(localCode)
        ? new StateplaneCliError('INVALID_CONFIGURATION') : new StateplaneCliError('PROVIDER_UNAVAILABLE');
    process.stderr.write(JSON.stringify({contractVersion:'1',error:{code:failure.code,message:failure.code,
      retryable:failure.retryable,requestId:failure.requestId??null}})+'\n');
    return 1;
  }
}

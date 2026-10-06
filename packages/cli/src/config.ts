import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateplaneCliError } from './transport.js';

type TokenStore = 'keychain'|'file';
export interface CliConfig { endpoint?:string; space?:string; tokenStore?:TokenStore; tokenLocations?:TokenStore[] }
export function configDir():string {
  return process.env.STATEPLANE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'stateplane');
}
async function secureDirectory():Promise<void> {
  await mkdir(configDir(),{recursive:true,mode:0o700});
  const stat=await lstat(configDir());
  if (!stat.isDirectory() || (stat.mode&0o077)!==0) throw new StateplaneCliError('INSECURE_CONFIGURATION');
}
const configPath=()=>join(configDir(),'config.json');
const tokenPath=()=>join(configDir(),'token');
async function privateFile(path:string):Promise<boolean> {
  try {
    const stat=await lstat(path);
    if (!stat.isFile() || (stat.mode&0o077)!==0) throw new StateplaneCliError('INSECURE_CONFIGURATION');
    return true;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;
    throw error;
  }
}
export async function readConfig():Promise<CliConfig> {
  try { await lstat(configDir()); await secureDirectory(); }
  catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  if (!await privateFile(configPath())) return {};
  try {
    const value=JSON.parse(await readFile(configPath(),'utf8')) as CliConfig;
    if (!value || typeof value!=='object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!['endpoint','space','tokenStore','tokenLocations'].includes(key)) ||
      (value.endpoint!==undefined && typeof value.endpoint!=='string') ||
      (value.space!==undefined && typeof value.space!=='string') ||
      (value.tokenStore!==undefined && !['file','keychain'].includes(value.tokenStore)) ||
      (value.tokenLocations!==undefined && (!value.endpoint || !Array.isArray(value.tokenLocations) ||
        value.tokenLocations.length<1 || value.tokenLocations.length>2 ||
        new Set(value.tokenLocations).size!==value.tokenLocations.length ||
        value.tokenLocations.some(store=>store!=='file' && store!=='keychain') ||
        (value.tokenStore!==undefined && !value.tokenLocations.includes(value.tokenStore)))))
      throw new Error('invalid');
    return value;
  } catch { throw new StateplaneCliError('INVALID_CONFIGURATION'); }
}
export async function saveConfig(value:CliConfig):Promise<void> {
  await secureDirectory();
  const temp=join(configDir(),`.config-${process.pid}-${crypto.randomUUID()}`);
  try {
    await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
    await rename(temp,configPath());
  } finally { await rm(temp,{force:true}); }
}
function keyArgs(endpoint:string):string[] { return ['service','stateplane','endpoint',endpoint]; }
const macKeychainScript=join(dirname(fileURLToPath(import.meta.url)),'../bin/keychain.swift');
function macKeychain(operation:'store'|'load'|'remove',endpoint:string,stdin?:string,
  run:typeof command=command) {
  return run('/usr/bin/swift',[macKeychainScript,operation,`stateplane:${endpoint}`],stdin);
}
interface CommandResult { ok:boolean; output:string; missing?:boolean }
function command(program:string,args:string[],stdin?:string):Promise<CommandResult> {
  return new Promise(resolve=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe']});
    const timer=setTimeout(()=>child.kill(),30_000);
    let output=''; let diagnostic=false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{ if (output.length<16_384) output+=chunk; });
    child.stderr.on('data',()=>{ diagnostic=true; });
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);resolve({ok:false,output:''});});
    child.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,output,
      missing:program==='/usr/bin/swift' ? code===2 : program==='secret-tool' && code===1 && !diagnostic});});
    child.stdin.end(stdin);
  });
}
export async function loadSecretServiceToken(endpoint:string,
  run:typeof command=command):Promise<string> {
  // An absent Secret Service item exits 1 without diagnostics. Backend
  // failures produce diagnostics, which are observed but never printed.
  const result=await run('secret-tool',['lookup',...keyArgs(endpoint)]);
  if (!result.ok) throw new StateplaneCliError(result.missing?'UNAUTHENTICATED':'KEYCHAIN_UNAVAILABLE');
  const token=result.output.replace(/\n$/,'');
  if (!token) throw new StateplaneCliError('UNAUTHENTICATED');
  return token;
}
export async function loadOsSecretToken(endpoint:string,os=platform(),
  run:typeof command=command):Promise<string> {
  if (os==='linux') return loadSecretServiceToken(endpoint,run);
  if (os!=='darwin') throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  const result=await macKeychain('load',endpoint,undefined,run);
  if (!result.ok) throw new StateplaneCliError(result.missing?'UNAUTHENTICATED':'KEYCHAIN_UNAVAILABLE');
  if (!result.output) throw new StateplaneCliError('UNAUTHENTICATED');
  return result.output;
}
export async function storeSecretServiceToken(endpoint:string,token:string,
  run:typeof command=command):Promise<void> {
  const args=keyArgs(endpoint);
  const stored=await run('secret-tool',['store','--label=Stateplane API key',...args],token);
  if (!stored.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  const checked=await run('secret-tool',['lookup',...args]);
  if (!checked.ok || checked.output.replace(/\n$/,'')!==token) {
    await run('secret-tool',['clear',...args]);
    throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  }
}
export async function saveToken(endpoint:string,token:string,store:'keychain'|'file'):Promise<void> {
  if (!token || /[\r\n\0]/.test(token)) throw new StateplaneCliError('INVALID_ARGUMENT');
  if (store==='file') {
    await secureDirectory();
    const temp=join(configDir(),`.token-${process.pid}-${crypto.randomUUID()}`);
    try { await writeFile(temp,token,{mode:0o600,flag:'wx'}); await rename(temp,tokenPath()); }
    finally { await rm(temp,{force:true}); }
    return;
  }
  if (platform()==='linux') return storeSecretServiceToken(endpoint,token);
  const result=platform()==='darwin' ? await macKeychain('store',endpoint,token) : {ok:false};
  if (!result.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  const checked=await macKeychain('load',endpoint);
  if (!checked.ok || checked.output!==token) {
    await macKeychain('remove',endpoint);
    throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  }
}
export async function loadToken(config:CliConfig):Promise<string> {
  if (process.env.STATEPLANE_TOKEN) return process.env.STATEPLANE_TOKEN;
  if (!config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
  if (config.tokenStore==='file') {
    if (!await privateFile(tokenPath())) throw new StateplaneCliError('UNAUTHENTICATED');
    const token=await readFile(tokenPath(),'utf8');
    if (!token || /[\r\n\0]/.test(token)) throw new StateplaneCliError('INVALID_CONFIGURATION');
    return token;
  }
  if (config.tokenStore==='keychain') {
    return loadOsSecretToken(config.endpoint);
  }
  throw new StateplaneCliError('UNAUTHENTICATED');
}
export async function removeToken(config:CliConfig):Promise<void> {
  if (config.tokenStore==='file') await rm(tokenPath(),{force:true});
  else if (config.tokenStore==='keychain' && config.endpoint) {
    const result=platform()==='darwin'
      ? await macKeychain('remove',config.endpoint)
      : platform()==='linux' ? await command('secret-tool',['clear',...keyArgs(config.endpoint)]) : {ok:false};
    if (!result.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  }
}

type TokenPersistence = {saveConfig:typeof saveConfig; saveToken:typeof saveToken; removeToken:typeof removeToken};
const persistence:TokenPersistence={saveConfig,saveToken,removeToken};

/** Keep both possible locations discoverable until the old secret is gone.
 * Each persisted step can be retried or cleaned up after process interruption. */
export async function configureToken(config:CliConfig,token:string,store:'keychain'|'file',
  io:TokenPersistence=persistence):Promise<void> {
  if (!config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
  const locations=[...new Set([...(config.tokenLocations??[]),...(config.tokenStore?[config.tokenStore]:[]),store])];
  await io.saveConfig({...config,tokenLocations:locations});
  await io.saveToken(config.endpoint,token,store);
  await io.saveConfig({...config,tokenStore:store,tokenLocations:locations});
  for (const previous of locations) if (previous!==store)
    await io.removeToken({...config,tokenStore:previous});
  await io.saveConfig({...config,tokenStore:store,tokenLocations:undefined});
}

/** Logout and endpoint changes also clean a transition interrupted at any step. */
export async function removeTrackedTokens(config:CliConfig,
  io:Pick<TokenPersistence,'removeToken'>=persistence):Promise<void> {
  const locations=new Set([...(config.tokenLocations??[]),...(config.tokenStore?[config.tokenStore]:[])]);
  for (const store of locations) await io.removeToken({...config,tokenStore:store});
}

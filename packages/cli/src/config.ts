import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, lstat, writeFile, open } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateplaneCliError } from './transport.js';

type TokenStore = 'keychain'|'file';
export interface CliConfig { endpoint?:string; space?:string; tokenStore?:TokenStore; tokenLocations?:TokenStore[] }
export function configDir():string {
  return process.env.STATEPLANE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'stateplane');
}
const windowsAclScript=join(dirname(fileURLToPath(import.meta.url)),'../bin/secure-acl.ps1');
/** fs.Stats.mode does not expose Windows ACLs. Keep only the current user,
 * SYSTEM and Administrators on configuration and file-secret paths. */
async function windowsAcl(path:string,action:'harden'|'verify'):Promise<void> {
  const powershell=join(process.env.SystemRoot??String.raw`C:\Windows`,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await command(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',windowsAclScript,'-TargetPath',path,'-Action',action]);
  if (!result.ok) throw new StateplaneCliError('INSECURE_CONFIGURATION');
}
async function secureDirectory():Promise<void> {
  await mkdir(configDir(),{recursive:true,mode:0o700});
  const stat=await lstat(configDir());
  if (!stat.isDirectory()) throw new StateplaneCliError('INSECURE_CONFIGURATION');
  if (platform()==='win32') await windowsAcl(configDir(),'harden');
  else if ((stat.mode&0o077)!==0) throw new StateplaneCliError('INSECURE_CONFIGURATION');
}
const configPath=()=>join(configDir(),'config.json');
const tokenPath=()=>join(configDir(),'token');
/** Serialize config and secret-location changes across CLI processes. The
 * durable journal remains the recovery source if a process exits mid-switch. */
let mutationTail:Promise<void>=Promise.resolve();
let sqliteModule:Promise<typeof import('node:sqlite')>|undefined;
function sqlite():Promise<typeof import('node:sqlite')> {
  if (!sqliteModule) {
    const emitWarning=process.emitWarning;
    // Node 22 emits this warning while importing its built-in SQLite module.
    // Keep all other diagnostics, including credential-store failures, intact.
    process.emitWarning=function(warning:string|Error,...args:unknown[]) {
      if (String(warning)==='SQLite is an experimental feature and might change at any time') return;
      return Reflect.apply(emitWarning,process,[warning,...args]);
    } as typeof process.emitWarning;
    sqliteModule=import('node:sqlite').finally(()=>{ process.emitWarning=emitWarning; });
  }
  return sqliteModule;
}
export async function withConfigMutation<T>(change:(current:CliConfig)=>Promise<T>):Promise<T> {
  // SQLite owns the cross-process lock. Its transaction is released by the OS
  // on process death, so no contender ever unlinks another contender's lock.
  // Queue this process too: DatabaseSync's busy wait would otherwise block a
  // callback holding the lock in the same event loop.
  const previous=mutationTail;
  let release!:()=>void;
  mutationTail=new Promise<void>(resolve=>{ release=resolve; });
  await previous;
  let database:import('node:sqlite').DatabaseSync|undefined;
  try {
    await secureDirectory();
    const path=join(configDir(),'config.lock.sqlite');
    try { const file=await open(path,'wx',0o600); await file.close(); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
    if (platform()==='win32') await windowsAcl(path,'harden');
    await privateFile(path);
    const {DatabaseSync}=await sqlite();
    database=new DatabaseSync(path);
    // PRAGMA works on the earliest supported Node 22.13 runtime; the
    // DatabaseSync constructor's timeout option arrived in Node 22.16.
    database.exec('PRAGMA busy_timeout = 120000');
    try { database.exec('BEGIN IMMEDIATE'); }
    catch(error) {
      if (String(error).includes('database is locked'))
        throw new StateplaneCliError('CONFIGURATION_BUSY',undefined,undefined,true);
      throw error;
    }
    try {
      const result=await change(await readConfig());
      database.exec('COMMIT');
      return result;
    } catch(error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database?.close();
    release();
  }
}
async function privateFile(path:string):Promise<boolean> {
  try {
    const stat=await lstat(path);
    if (!stat.isFile()) throw new StateplaneCliError('INSECURE_CONFIGURATION');
    if (platform()==='win32') await windowsAcl(path,'verify');
    else if ((stat.mode&0o077)!==0) throw new StateplaneCliError('INSECURE_CONFIGURATION');
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
    if (platform()==='win32') await windowsAcl(temp,'harden');
    await rename(temp,configPath());
  } finally { await rm(temp,{force:true}); }
}
function keyArgs(endpoint:string):string[] { return ['service','stateplane','endpoint',endpoint]; }
const macKeychainScript=join(dirname(fileURLToPath(import.meta.url)),'../bin/keychain.swift');
function macKeychain(operation:'store'|'load'|'remove',endpoint:string,stdin?:string,
  run:typeof command=command) {
  // xcrun selects a matching Swift toolchain and SDK. Direct /usr/bin/swift
  // can bind to an older CLT compiler with a newer active Xcode SDK.
  return run('/usr/bin/xcrun',['--sdk','macosx','swift',macKeychainScript,operation,`stateplane:${endpoint}`],stdin);
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
      missing:program==='/usr/bin/xcrun' ? code===2 : program==='secret-tool' && code===1 && !diagnostic});});
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
    try {
      await writeFile(temp,token,{mode:0o600,flag:'wx'});
      if (platform()==='win32') await windowsAcl(temp,'harden');
      await rename(temp,tokenPath());
    }
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
    let result:CommandResult;
    if (platform()==='darwin') result=await macKeychain('remove',config.endpoint);
    else if (platform()==='linux') result=await command('secret-tool',['clear',...keyArgs(config.endpoint)]);
    else result={ok:false,output:''};
    if (!result.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  }
}

type TokenPersistence = {saveConfig:typeof saveConfig; saveToken:typeof saveToken; removeToken:typeof removeToken};
const persistence:TokenPersistence={saveConfig,saveToken,removeToken};

/** Keep both possible locations discoverable until the old secret is gone.
 * Each persisted step can be retried or cleaned up after process interruption. */
export async function configureToken(config:CliConfig,token:string,store:'keychain'|'file',
  io:TokenPersistence=persistence):Promise<void> { // NOSONAR -- shared immutable adapter, not a per-call object
  if (!config.endpoint) throw new StateplaneCliError('INVALID_CONFIGURATION');
  const locations=[...new Set([...(config.tokenLocations??[]),...(config.tokenStore?[config.tokenStore]:[]),store])];
  await io.saveConfig({...config,tokenLocations:locations});
  await io.saveToken(config.endpoint,token,store);
  await io.saveConfig({...config,tokenStore:store,tokenLocations:locations});
  for (const previous of locations) if (previous!==store)
    await io.removeToken({...config,tokenStore:previous}); // NOSONAR -- locations must settle serially before the journal clears
  await io.saveConfig({...config,tokenStore:store,tokenLocations:undefined});
}

/** Logout and endpoint changes also clean a transition interrupted at any step. */
export async function removeTrackedTokens(config:CliConfig,
  io:Pick<TokenPersistence,'removeToken'>=persistence):Promise<void> {
  const locations=new Set([...(config.tokenLocations??[]),...(config.tokenStore?[config.tokenStore]:[])]);
  let failure:unknown;
  for (const store of locations) {
    try { await io.removeToken({...config,tokenStore:store}); } // NOSONAR -- preserve ordered cleanup and first failure
    catch(error) { failure??=error; }
  }
  // Leave the persisted location journal intact on any failure. A later
  // logout or endpoint change can retry every location, including one whose
  // removal already succeeded (both backends treat absence as success).
  if (failure) throw failure;
}

/** A completed logout clears the durable secret-location journal only after
 * every tracked backend has confirmed removal. */
const logoutPersistence={removeTrackedTokens,saveConfig};
export async function logoutConfig(config:CliConfig,
  io:{removeTrackedTokens:typeof removeTrackedTokens;saveConfig:typeof saveConfig}=logoutPersistence):Promise<void> {
  await io.removeTrackedTokens(config);
  await io.saveConfig({...config,tokenStore:undefined,tokenLocations:undefined});
}

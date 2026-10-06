import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { StateplaneCliError } from './transport.js';

export interface CliConfig { endpoint?:string; space?:string; tokenStore?:'keychain'|'file' }
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
      Object.keys(value).some(key=>!['endpoint','space','tokenStore'].includes(key)) ||
      (value.endpoint!==undefined && typeof value.endpoint!=='string') ||
      (value.space!==undefined && typeof value.space!=='string') ||
      (value.tokenStore!==undefined && !['file','keychain'].includes(value.tokenStore)))
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
function command(program:string,args:string[],stdin?:string):Promise<{ok:boolean;output:string}> {
  return new Promise(resolve=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','ignore']});
    const timer=setTimeout(()=>child.kill(),30_000);
    let output='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{ if (output.length<16_384) output+=chunk; });
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);resolve({ok:false,output:''});});
    child.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,output});});
    child.stdin.end(stdin);
  });
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
  const result=platform()==='darwin'
    ? await command('security',['add-generic-password','-a','default','-s',`stateplane:${endpoint}`,'-U','-w'],token+'\n')
    : platform()==='linux'
      ? await command('secret-tool',['store','--label=Stateplane API key',...keyArgs(endpoint)],token)
      : {ok:false};
  if (!result.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
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
    const result=platform()==='darwin'
      ? await command('security',['find-generic-password','-a','default','-s',`stateplane:${config.endpoint}`,'-w'])
      : platform()==='linux'
        ? await command('secret-tool',['lookup',...keyArgs(config.endpoint)])
        : {ok:false,output:''};
    if (!result.ok || !result.output.trim()) throw new StateplaneCliError('UNAUTHENTICATED');
    return result.output.trimEnd();
  }
  throw new StateplaneCliError('UNAUTHENTICATED');
}
export async function removeToken(config:CliConfig):Promise<void> {
  if (config.tokenStore==='file') await rm(tokenPath(),{force:true});
  else if (config.tokenStore==='keychain' && config.endpoint) {
    const result=platform()==='darwin'
      ? await command('security',['delete-generic-password','-a','default','-s',`stateplane:${config.endpoint}`])
      : platform()==='linux' ? await command('secret-tool',['clear',...keyArgs(config.endpoint)]) : {ok:false};
    if (!result.ok) throw new StateplaneCliError('KEYCHAIN_UNAVAILABLE');
  }
}

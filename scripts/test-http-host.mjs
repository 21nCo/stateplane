import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root=resolve(import.meta.dirname,'..');
const pnpmCli=process.env.npm_execpath;
const npmCandidates=[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
  join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
const npmCli=npmCandidates.find(existsSync);
if (!pnpmCli || !isAbsolute(pnpmCli) || !existsSync(pnpmCli) || !npmCli || !isAbsolute(npmCli))
  throw new Error('Trusted pnpm/npm CLI paths are unavailable');
const databaseUrl=process.env.DATABASE_URL;
if (!databaseUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('test:http-host requires a migrated disposable loopback DATABASE_URL');
const reservation=createServer();
reservation.listen(0,'127.0.0.1');
await once(reservation,'listening');
const port=reservation.address().port;
reservation.close(); await once(reservation,'close');
const endpoint=`http://127.0.0.1:${port}/`;
const token=randomBytes(32).toString('hex');
const spaceId=`sp_${randomUUID()}`;
const collectionId='entries/path';
const externalKey='key/part';
const temp=await mkdtemp(join(tmpdir(),'stateplane-host-consumer-'));
const appEnv={...process.env,STATEPLANE_ENV:'local',STATEPLANE_TEST_HTTP:'1',
  STATEPLANE_TEST_DATABASE_URL:databaseUrl,STATEPLANE_TEST_TOKEN:token,
  STATEPLANE_TEST_OWNER:`owner-${randomUUID()}`,STATEPLANE_TEST_CREDENTIAL:`session-${randomUUID()}`,
  STATEPLANE_TEST_CURSOR_SECRET:randomBytes(32).toString('hex')};
const app=spawn(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'dev','--host','127.0.0.1',
  '--port',String(port),'--strictPort'],{cwd:join(root,'app'),env:appEnv,stdio:'ignore'});
const cliEnv={...process.env,STATEPLANE_CONFIG_DIR:join(temp,'config')};
let cleanupError;
let testError;
function run(command,args,options={}) {
  const result=spawnSync(command,args,{cwd:temp,encoding:'utf8',...options});
  if (result.status!==0) throw new Error(`${command} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
async function request(method,path,body) {
  const response=await fetch(endpoint+path,{method,headers:{Authorization:`Bearer ${token}`,
    ...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if (!response.ok) throw new Error(`HTTP ${method} ${path}: ${value.error?.code}`);
  return value;
}
try {
  let ready=false;
  for (let attempt=0;attempt<100;attempt++) {
    if (app.exitCode!==null) throw new Error('app dev host exited before readiness');
    try { const health=await fetch(endpoint+'api/health'); if (health.ok) {ready=true;break;} }
    catch { /* The development host may still be starting. */ }
    await new Promise(resolve=>setTimeout(resolve,100)); // NOSONAR -- poll the child readiness in order
  }
  if (!ready) throw new Error('app dev host did not become ready');
  const tarball=join(temp,'stateplane-cli.tgz');
  const packed=spawnSync(process.execPath,[pnpmCli,'pack','--out',tarball],{cwd:join(root,'packages/cli'),encoding:'utf8'});
  if (packed.status!==0) throw new Error(`CLI pack failed: ${packed.stderr}`);
  const installed=spawnSync(process.execPath,[npmCli,'install','--no-audit','--no-fund','--prefix',temp,tarball],
    {cwd:temp,encoding:'utf8'});
  if (installed.status!==0) throw new Error(`CLI install failed: ${installed.stderr}`);
  const cli=join(temp,'node_modules/@stateplane/cli/bin/stateplane.js');
  const runCli=(args,options)=>run(process.execPath,[cli,...args],options);
  runCli(['config','endpoint','--url',endpoint],{env:cliEnv});
  runCli(['auth','login','--token-stdin','--store','file'],{env:cliEnv,input:`${token}\n`});
  const created=await request('POST','v1/spaces',{spaceId});
  assert(created.spaceId===spaceId,'created space ID');
  const observed=runCli(['spaces','get','--space',spaceId],{env:cliEnv});
  assert(JSON.stringify(observed)===JSON.stringify(created),'CLI and HTTP space parity');
  runCli(['spaces','select','--space',spaceId],{env:cliEnv});
  const definition={slug:collectionId,version:1,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    unique:[],filterable:[],sortable:[]};
  await writeFile(join(temp,'schema.json'),JSON.stringify(definition));
  runCli(['collections','define','--collection',collectionId,'--file',join(temp,'schema.json')],{env:cliEnv});
  const discovered=await request('GET',`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}`);
  assert(discovered.definition.slug===collectionId,'CLI schema is visible through HTTP');
  const path=`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}/records`;
  const mutation={operation:'create',idempotencyKey:'consumer-record',externalKey,data:{label:'A'}};
  const receipt=await request('POST',path,mutation);
  const replay=runCli(['records','create','--collection',collectionId,'--data','{"label":"A"}',
    '--idempotency-key','consumer-record','--key',externalKey],{env:cliEnv});
  assert(replay.receiptId===receipt.receiptId && replay.replayed===true,'CLI receipt replay parity');
  const record=runCli(['records','get','--collection',collectionId,'--id',receipt.ref.id],{env:cliEnv});
  const direct=await request('GET',`${path}/${receipt.ref.id}`);
  assert(JSON.stringify(record)===JSON.stringify(direct),'CLI and HTTP canonical record parity');
  const keyPath=`${path}/by-key/${encodeURIComponent(externalKey)}?mode=external`;
  const directByKey=await request('GET',keyPath);
  const cliByKey=runCli(['records','key','--collection',collectionId,'--key',externalKey,
    '--mode','external'],{env:cliEnv});
  assert(JSON.stringify(cliByKey)===JSON.stringify(directByKey),'CLI and HTTP encoded-key parity');
  // Report success after the disposable space and processes are gone.
} catch(error) {
  testError=error;
} finally {
  // The create response can be lost after COMMIT. Reconcile the selected ID
  // before cleanup, including when the command failed before seeing a receipt.
  try {
    const lookup=await fetch(endpoint+`v1/spaces/${spaceId}`,{
      headers:{Authorization:`Bearer ${token}`}});
    if (lookup.ok) {
      await request('PATCH',`v1/spaces/${spaceId}`,{lifecycle:'readOnly'});
      await request('DELETE',`v1/spaces/${spaceId}`);
    } else if (lookup.status!==404) {
      cleanupError=new Error(`HTTP cleanup lookup failed: ${lookup.status}`);
    }
  } catch(error) { cleanupError=error; }
  app.kill('SIGTERM');
  await Promise.race([once(app,'close'),new Promise(resolve=>setTimeout(resolve,3000))]);
  if (app.exitCode===null) app.kill('SIGKILL');
  await rm(temp,{recursive:true,force:true});
}
if (cleanupError) throw cleanupError;
if (testError) throw testError;
console.log('Installed CLI and independent HTTP client reached the live /v1 host with matching state and receipt');

function assert(condition,message) { if (!condition) throw new Error(message); }

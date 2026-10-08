import { randomBytes, randomUUID } from 'node:crypto';
import { fork, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { CollectionRegistry, PostgresSpaces } from '../packages/postgres/dist/index.js';

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
const agentToken=randomBytes(32).toString('hex');
const agentCredential=`agent-${randomUUID()}`;
const spaceId=`sp_${randomUUID()}`;
const collectionId='entries/path';
const externalKey='key/part';
const temp=await mkdtemp(join(tmpdir(),'stateplane-host-consumer-'));
// Route the host through a disposable TCP relay. It can stop answering new
// PostgreSQL handshakes after a successful connection, then resume without
// changing the HTTP host's configuration or its cached pool.
const databaseAddress=new URL(databaseUrl);
let provider;
let app;
let appEnv;
function relayReply(expected,command) {
  return new Promise((resolve,reject)=>{
    if (provider?.exitCode!==null || provider.signalCode!==null) {
      reject(new Error(`relay exited before ${expected}`));
      return;
    }
    let settled=false;
    const timeout=setTimeout(()=>finish(new Error(`relay ${expected} timed out`)),7_000);
    function finish(error,value) {
      if (settled) return;
      settled=true;
      clearTimeout(timeout);
      provider.off('message',message);
      provider.off('exit',exit);
      provider.off('error',exit);
      if (error) reject(error); else resolve(value);
    }
    function message(value) {
      let matches=value?.state===expected;
      if (expected==='ready') matches=Number.isSafeInteger(value?.port);
      if (matches)
        finish(null,value);
    }
    function exit() { finish(new Error(`relay exited before ${expected}`)); }
    provider.on('message',message);
    provider.once('exit',exit);
    provider.once('error',exit);
    if (command) provider.send(command,error=>{ if (error) finish(error); });
  });
}
async function providerMode(mode) {
  const states={stall:'stalled',silent:'silent',forward:'forwarding'};
  await relayReply(states[mode],mode);
}
async function waitClosed(child,timeoutMs) {
  if (child?.exitCode!==null || child.signalCode!==null) return;
  let timer;
  try {
    await Promise.race([once(child,'close'),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('child exit timed out')),timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const cliEnv={...process.env,STATEPLANE_CONFIG_DIR:join(temp,'config')};
const cleanupErrors=[];
let testError;
let fixturePool;
function run(command,args,options={}) {
  const result=spawnSync(command,args,{cwd:temp,encoding:'utf8',...options});
  if (result.status!==0) throw new Error(`${command} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
async function request(method,path,body,credential=token) {
  const response=await fetch(endpoint+path,{method,headers:{Authorization:`Bearer ${credential}`,
    ...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if (!response.ok) throw new Error(`HTTP ${method} ${path}: ${value.error?.code}`);
  return value;
}
try {
  provider=fork(join(root,'scripts/http-provider-relay.mjs'),
    [databaseAddress.hostname,databaseAddress.port || '5432'],{stdio:['ignore','ignore','ignore','ipc']});
  provider.on('error',()=>{});
  const {port:providerPort}=await relayReply('ready');
  const hostDatabaseUrl=new URL(databaseUrl);
  hostDatabaseUrl.hostname='127.0.0.1';
  hostDatabaseUrl.port=String(providerPort);
  appEnv={...process.env,STATEPLANE_ENV:'local',STATEPLANE_TEST_HTTP:'1',
    STATEPLANE_TEST_DATABASE_URL:hostDatabaseUrl.toString(),STATEPLANE_TEST_TOKEN:token,
    STATEPLANE_TEST_OWNER:`owner-${randomUUID()}`,STATEPLANE_TEST_CREDENTIAL:`session-${randomUUID()}`,
    STATEPLANE_TEST_AGENT_TOKEN:agentToken,STATEPLANE_TEST_AGENT_CREDENTIAL:agentCredential,
    STATEPLANE_TEST_CURSOR_SECRET:randomBytes(32).toString('hex')};
  app=spawn(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'dev','--host','127.0.0.1',
    '--port',String(port),'--strictPort'],{cwd:join(root,'app'),env:appEnv,stdio:'ignore'});
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
    type:'object',properties:{label:{type:'string'},score:{type:'number'},active:{type:'boolean'},
      at:{type:'string',format:'date-time'},note:{type:['string','null']}},required:['label'],additionalProperties:false},
    unique:[],filterable:['label','score','active','at','note'],sortable:[]};
  await writeFile(join(temp,'schema.json'),JSON.stringify(definition));
  runCli(['collections','define','--collection',collectionId,'--file',join(temp,'schema.json')],{env:cliEnv});
  const discovered=await request('GET',`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}`);
  assert(discovered.definition.slug===collectionId,'CLI schema is visible through HTTP');
  const path=`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}/records`;
  const data={label:'A',score:2,active:true,at:'2024-02-29T23:59:59Z',note:null};
  fixturePool=new pg.Pool({connectionString:databaseUrl,max:1});
  const effects=async()=>{
    const counts=await fixturePool.query(`SELECT
      (SELECT count(*)::int FROM records WHERE space_id=$1) AS records,
      (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
      (SELECT count(*)::int FROM idempotency_receipts WHERE space_id=$1) AS receipts`,[spaceId]);
    return counts.rows[0];
  };
  await Promise.all(['', '\u0085 \u2003', 'a'.repeat(257), 'é'.repeat(129)].map(async(key,index)=>{
    const denied=await fetch(endpoint+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'},body:JSON.stringify({operation:'create',
      idempotencyKey:`invalid-key-${index}`,externalKey:key,data})});
    assert(denied.status===400 && (await denied.json()).error.code==='INVALID_ARGUMENT',
      `HTTP rejects invalid key ${index}`);
    const cliDenied=spawnSync(process.execPath,[cli,'records','create','--collection',collectionId,
      '--idempotency-key',`invalid-cli-key-${index}`,'--key',key,'--data',JSON.stringify(data)],
      {cwd:temp,env:cliEnv,encoding:'utf8'});
    assert(cliDenied.status===1 && JSON.parse(cliDenied.stderr).error.code==='INVALID_ARGUMENT' &&
      !`${cliDenied.stdout}${cliDenied.stderr}`.includes(token),`installed CLI rejects invalid key ${index}`);
  }));
  assert(JSON.stringify(await effects())===JSON.stringify({records:0,events:0,receipts:0}),
    'invalid keys have no durable effect');
  await Promise.all(['create','replace','patch','delete'].flatMap(operation=>
    ['', 'a'.repeat(257), 'é'.repeat(129), '\ud800'].map(async key=>{
      const envelope={operation,idempotencyKey:key,
        ...(operation==='create'?{data}:{id:'missing',expectedRevision:1}),
        ...(operation==='replace'?{data}:{}),
        ...(operation==='patch'?{set:{label:'B'},unset:[]}:{})};
      const denied=await fetch(endpoint+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'},body:JSON.stringify(envelope)});
      assert(denied.status===400 && (await denied.json()).error.code==='INVALID_ARGUMENT',
        `HTTP rejects invalid ${operation} idempotency key`);
      // Process argv converts an unpaired surrogate to U+FFFD before the CLI can receive it.
      if (key==='\ud800') return;
      const args=['records',operation,'--collection',collectionId,'--idempotency-key',key];
      if (operation==='create' || operation==='replace') args.push('--data',JSON.stringify(data));
      if (operation!=='create') args.push('--id','missing','--expected-revision','1');
      if (operation==='patch') args.push('--data',JSON.stringify({set:{label:'B'},unset:[]}));
      const cliDenied=spawnSync(process.execPath,[cli,...args],{cwd:temp,env:cliEnv,encoding:'utf8'});
      const cliError=cliDenied.stderr ? JSON.parse(cliDenied.stderr).error.code : null;
      assert(cliDenied.status===1 && cliError==='INVALID_ARGUMENT',
        `installed CLI rejects invalid ${operation} idempotency key (${Buffer.byteLength(key)} bytes/${cliDenied.status}/${cliError})`);
    })));
  assert(JSON.stringify(await effects())===JSON.stringify({records:0,events:0,receipts:0}),
    'invalid idempotency keys have no durable record, event or receipt');
  const mutation={operation:'create',idempotencyKey:'consumer-record',externalKey,data};
  const receipt=await request('POST',path,mutation);
  const replay=runCli(['records','create','--collection',collectionId,'--data',JSON.stringify(data),
    '--idempotency-key','consumer-record','--key',externalKey],{env:cliEnv});
  assert(replay.receiptId===receipt.receiptId && replay.replayed===true,'CLI receipt replay parity');
  const record=runCli(['records','get','--collection',collectionId,'--id',receipt.ref.id],{env:cliEnv});
  const direct=await request('GET',`${path}/${receipt.ref.id}`);
  assert(JSON.stringify(record)===JSON.stringify(direct),'CLI and HTTP canonical record parity');
  if (process.env.STATEPLANE_TEST_RELAY_FAULT==='kill-after-create') {
    provider.kill('SIGKILL');
    await waitClosed(provider,3_000);
    throw new Error('injected relay exit after creating a custom-cell space');
  }
  const boundaryCreate={operation:'create',idempotencyKey:'a'.repeat(256),data:{...data,label:'Boundary'}};
  const boundary=runCli(['records','create','--collection',collectionId,
    '--idempotency-key',boundaryCreate.idempotencyKey,'--data',JSON.stringify(boundaryCreate.data)],{env:cliEnv});
  const boundaryReplay=await request('POST',path,boundaryCreate);
  assert(boundaryReplay.receiptId===boundary.receiptId && boundaryReplay.replayed,
    '256-byte create key replays from HTTP after installed CLI');
  const id=boundary.ref.id;
  const variants=[
    {operation:'replace',idempotencyKey:'é'.repeat(128),id,expectedRevision:1,data:{...data,label:'Replaced'}},
    {operation:'patch',idempotencyKey:'😀'.repeat(64),id,expectedRevision:2,set:{label:'Patched'},unset:[]},
    {operation:'delete',idempotencyKey:'z'.repeat(256),id,expectedRevision:3}
  ];
  for (const envelope of variants) {
    const httpReceipt=await request('POST',path,envelope); // NOSONAR -- each revision requires the previous mutation to commit
    const args=['records',envelope.operation,'--collection',collectionId,
      '--idempotency-key',envelope.idempotencyKey,'--id',id,
      '--expected-revision',String(envelope.expectedRevision)];
    if (envelope.operation==='replace') args.push('--data',JSON.stringify(envelope.data));
    if (envelope.operation==='patch') args.push('--data',JSON.stringify({set:envelope.set,unset:envelope.unset}));
    const cliReplay=runCli(args,{env:cliEnv});
    assert(cliReplay.receiptId===httpReceipt.receiptId && cliReplay.replayed,
      `256-byte ${envelope.operation} key replays through installed CLI`);
  }
  const placement=(await fixturePool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',
    [spaceId])).rows[0];
  const schemaScope={spaceId,collectionId,principalId:appEnv.STATEPLANE_TEST_OWNER,
    credentialId:appEnv.STATEPLANE_TEST_CREDENTIAL,capability:'schema:write',
    policyVersion:Number(placement.policy_version),placementGeneration:Number(placement.placement_generation)};
  const registry=new CollectionRegistry(fixturePool);
  for (const field of definition.filterable) {
    const result=await registry.backfill(schemaScope,field); // NOSONAR -- each index must be ready before the read matrix starts
    assert(result.ready,`index for ${field} is ready before querying`);
  }
  await Promise.all([
    {field:'label',kind:'string',operator:'eq',value:'A'},
    {field:'score',kind:'number',operator:'gte',value:2},
    {field:'active',kind:'boolean',operator:'eq',value:true},
    {field:'at',kind:'date-time',operator:'lte',value:'2024-02-29T23:59:59.000Z'},
    {field:'note',kind:'null',operator:'isNull'},
    {field:'label',kind:'string',operator:'in',value:['A']},
    {field:'score',kind:'number',operator:'in',value:[2]},
    {field:'score',kind:'number',operator:'in',value:new Array(16).fill(2)},
    {field:'active',kind:'boolean',operator:'in',value:[true]},
    {field:'at',kind:'date-time',operator:'in',value:['2024-02-29T23:59:59Z']}
  ].flatMap(predicate=>['query','count'].map(async action=>{
    const predicates=[predicate];
    const body=action==='query'?{predicates,limit:1}:predicates;
    const directResult=await request('POST',`${path}/${action}`,body);
    const args=['records',action,'--collection',collectionId,'--predicates',JSON.stringify(predicates)];
    if (action==='query') args.push('--limit','1');
    const cliResult=runCli(args,{env:cliEnv});
    assert(JSON.stringify(cliResult)===JSON.stringify(directResult),`installed CLI ${action} matches HTTP`);
    assert(action==='query'?directResult.records.length===1:directResult===1,`typed ${action} finds the record`);
  })));
  const beforeEvents=await request('GET',`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}/events`);
  async function expectPredicateError(predicate,code) {
    await Promise.all(['query','count'].map(async action=>{
      const predicates=[predicate];
      const body=action==='query'?{predicates,limit:1}:predicates;
      const response=await fetch(endpoint+`${path}/${action}`,{method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const error=(await response.json()).error;
      assert(response.status===(code==='SCHEMA_CONFLICT'?409:400) && error.code===code,
        `HTTP ${action} rejects ${JSON.stringify(predicate)} with ${code}`);
      const args=['records',action,'--collection',collectionId,'--predicates',JSON.stringify(predicates)];
      if (action==='query') args.push('--limit','1');
      const installedCli=spawnSync(process.execPath,[cli,...args],{cwd:temp,env:cliEnv,encoding:'utf8'});
      assert(installedCli.status!==0 && JSON.parse(installedCli.stderr).error.code===code,
        `installed CLI ${action} matches HTTP for ${code}`);
    }));
  }
  await Promise.all([
    {field:'label',kind:'string',operator:'eq'},
    {field:'label',kind:'number',operator:'eq',value:'oops'},
    {field:'label',kind:'number',operator:'in',value:7},
    {field:'label',kind:'number',operator:'in',value:[]},
    {field:'score',kind:'number',operator:'in',value:new Array(17).fill(2)},
    {field:'label',kind:'string',operator:'eq',value:'😀'.repeat(129)},
    {field:'label',kind:'date-time',operator:'eq',value:'2026-02-30T00:00:00Z'}
  ].map(predicate=>expectPredicateError(predicate,'INVALID_ARGUMENT')));
  await expectPredicateError({field:'absent',kind:'string',operator:'eq',value:'A'},'SCHEMA_CONFLICT');
  async function expectUnavailableIndex(column) {
    await fixturePool.query(`UPDATE collection_index_declarations SET ${column}=FALSE
      WHERE space_id=$1 AND collection_id=$2 AND field_name='label'`,[spaceId,collectionId]);
    try {
      await expectPredicateError({field:'label',kind:'string',operator:'eq',value:'A'},'SCHEMA_CONFLICT');
    } finally {
      await fixturePool.query(`UPDATE collection_index_declarations SET ${column}=TRUE
        WHERE space_id=$1 AND collection_id=$2 AND field_name='label'`,[spaceId,collectionId]);
    }
  }
  await expectUnavailableIndex('filterable');
  await expectUnavailableIndex('ready');
  assert(JSON.stringify(await request('GET',`v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}/events`))===
    JSON.stringify(beforeEvents),'rejected read requests cause no record events');
  const normalized=runCli(['records','create','--collection',collectionId,'--data',JSON.stringify(data),
    '--idempotency-key','normalized-key','--key','\u0085 e\u0301 \u0085'],{env:cliEnv});
  const normalizedReplay=await request('POST',path,{operation:'create',idempotencyKey:'normalized-key',
    externalKey:'é',data});
  assert(normalizedReplay.receiptId===normalized.receiptId && normalizedReplay.replayed,
    'installed CLI and HTTP replay one canonical NFC key');
  const beforeMismatch=await effects();
  async function expectFingerprintMismatch(changed) {
    const mismatch=await fetch(endpoint+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'},body:JSON.stringify({operation:'create',
      idempotencyKey:'normalized-key',...changed})});
    assert(mismatch.status===409 && (await mismatch.json()).error.code==='IDEMPOTENCY_MISMATCH',
      'changed canonical fingerprint cannot replay the normalized key');
  }
  await expectFingerprintMismatch({externalKey:'é',data:{...data,label:'Changed'}});
  await expectFingerprintMismatch({externalKey:'é',data,expectedSchemaVersion:2});
  const cliMismatch=spawnSync(process.execPath,[cli,'records','create','--collection',collectionId,
    '--idempotency-key','normalized-key','--key','é','--data',JSON.stringify({...data,label:'Changed'})],
    {cwd:temp,env:cliEnv,encoding:'utf8'});
  assert(cliMismatch.status===1 && JSON.parse(cliMismatch.stderr).error.code==='IDEMPOTENCY_MISMATCH',
    'installed CLI rejects changed canonical replay');
  assert(JSON.stringify(await effects())===JSON.stringify(beforeMismatch),
    'fingerprint mismatch leaves records, events and receipts unchanged');
  const normalizedLookup=await request('GET',`${path}/by-key/${encodeURIComponent('é')}?mode=external`);
  assert(normalizedLookup.ref.id===normalized.ref.id,'normalized key lookup resolves CLI record');
  await Promise.all(['a'.repeat(256),'é'.repeat(128)].map(async(key,index)=>{
    const accepted=runCli(['records','create','--collection',collectionId,'--data',JSON.stringify(data),
      '--idempotency-key',`boundary-key-${index}`,'--key',key],{env:cliEnv});
    const observed=await request('GET',`${path}/by-key/${encodeURIComponent(key)}?mode=external`);
    assert(observed.ref.id===accepted.ref.id,`installed CLI and HTTP accept 256-byte key ${index}`);
  }));
  const keyPath=`${path}/by-key/${encodeURIComponent(externalKey)}?mode=external`;
  const directByKey=await request('GET',keyPath);
  const cliByKey=runCli(['records','key','--collection',collectionId,'--key',externalKey,
    '--mode','external'],{env:cliEnv});
  assert(JSON.stringify(cliByKey)===JSON.stringify(directByKey),'CLI and HTTP encoded-key parity');
  for (let index=0;index<9;index++) {
    const slug=`entries_${String(index).padStart(2,'0')}`;
    await request('PUT',`v1/spaces/${spaceId}/collections/${slug}`,{...definition,slug}); // NOSONAR -- definitions must exist before granting the agent access
  }
  await fixturePool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,
    expires_at,activated_at,confirmed_at)
    VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
  [spaceId,agentCredential,`agent-principal-${randomUUID()}`,appEnv.STATEPLANE_TEST_OWNER]);
  for (const slug of [collectionId,...Array.from({length:9},(_,index)=>`entries_${String(index).padStart(2,'0')}`)])
    await fixturePool.query(/* NOSONAR -- each grant follows its committed collection definition */
      `INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
      VALUES($1,$2,$3,ARRAY['records:write']::text[])`,[spaceId,slug,agentCredential]);
  const beforeCredentialSwitch=await effects();
  const switched=await fetch(endpoint+path,{method:'POST',headers:{Authorization:`Bearer ${agentToken}`,
    'Content-Type':'application/json'},body:JSON.stringify(mutation)});
  const switchedBody=await switched.json();
  assert(switched.status===409 && switchedBody.error?.code==='KEY_RESERVED' &&
    !JSON.stringify(switchedBody).includes(receipt.receiptId) &&
    !JSON.stringify(switchedBody).includes(token) &&
    !JSON.stringify(switchedBody).includes(agentToken),
  'a new authorized credential receives KEY_RESERVED without recovering the original receipt or a token');
  assert(JSON.stringify(await effects())===JSON.stringify(beforeCredentialSwitch),
    'credential switch with the same reserved external key has no record, event or receipt effect');
  const ownerReplay=await request('POST',path,mutation);
  assert(ownerReplay.receiptId===receipt.receiptId && ownerReplay.replayed,
    'original credential still recovers the original receipt after a credential switch');
  runCli(['auth','login','--token-stdin','--store','file'],{env:cliEnv,input:`${agentToken}\n`});
  const switchedCli=spawnSync(process.execPath,[cli,'records','create','--collection',collectionId,
    '--idempotency-key',mutation.idempotencyKey,'--key',externalKey,'--data',JSON.stringify(data)],
    {cwd:temp,env:cliEnv,encoding:'utf8'});
  const switchedCliError=switchedCli.stderr ? JSON.parse(switchedCli.stderr).error : null;
  assert(switchedCli.status===1 && switchedCliError?.code==='KEY_RESERVED' &&
    !`${switchedCli.stdout}${switchedCli.stderr}`.includes(receipt.receiptId) &&
    !`${switchedCli.stdout}${switchedCli.stderr}`.includes(token) &&
    !`${switchedCli.stdout}${switchedCli.stderr}`.includes(agentToken),
  'installed CLI with a different authorized credential receives KEY_RESERVED without exposing the original receipt or a token');
  assert(JSON.stringify(await effects())===JSON.stringify(beforeCredentialSwitch),
    'CLI credential switch also has no record, event or receipt effect');
  const agentFirst=await request('GET',`v1/spaces/${spaceId}/collections`,undefined,agentToken);
  assert(JSON.stringify(runCli(['collections','list'],{env:cliEnv}))===JSON.stringify(agentFirst),
    'installed CLI write-only discovery matches HTTP first page');
  assert(agentFirst.items.length===8 && typeof agentFirst.cursor==='string','write-only page bound');
  const agentNext=await request('GET',
    `v1/spaces/${spaceId}/collections?cursor=${encodeURIComponent(agentFirst.cursor)}`,undefined,agentToken);
  assert(JSON.stringify(runCli(['collections','list','--cursor',agentFirst.cursor],{env:cliEnv}))===JSON.stringify(agentNext),
    'installed CLI write-only continuation matches HTTP');
  const agentSelected=await request('GET',
    `v1/spaces/${spaceId}/collections/${encodeURIComponent(collectionId)}`,undefined,agentToken);
  assert(JSON.stringify(runCli(['collections','get','--collection',collectionId],{env:cliEnv}))===
    JSON.stringify(agentSelected),'installed CLI write-only selected definition matches HTTP');
  const deniedRead=spawnSync(process.execPath,[cli,'records','get','--collection',collectionId,
    '--id',receipt.ref.id],{cwd:temp,env:cliEnv,encoding:'utf8'});
  assert(deniedRead.status!==0 && `${deniedRead.stdout}${deniedRead.stderr}`.includes('FORBIDDEN'),
    'write-only CLI cannot read records');
  await fixturePool.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
    WHERE space_id=$1 AND credential_id=$2`,[spaceId,agentCredential]);
  const deniedPage=spawnSync(process.execPath,[cli,'collections','list','--cursor',agentFirst.cursor],
    {cwd:temp,env:cliEnv,encoding:'utf8'});
  assert(deniedPage.status!==0 && !`${deniedPage.stdout}${deniedPage.stderr}`.includes(agentToken),
    'revoked write-only CLI continuation is denied without exposing its token');
  const beforeOutage=await effects();
  await providerMode('stall');
  const outageRequests=[
    ...Array.from({length:6},()=>({method:'GET',path:`v1/spaces/${spaceId}`})),
    {method:'GET',path:`${path}/${receipt.ref.id}`},
    ...['query','count'].map(action=>({method:'POST',path:`${path}/${action}`,
      body:action==='query'?{predicates:[],limit:1}:[]})),
    {method:'POST',path,body:{operation:'create',idempotencyKey:'outage-create',data}},
    {method:'POST',path,body:{operation:'replace',idempotencyKey:'outage-replace',
      id:receipt.ref.id,expectedRevision:1,data}},
    {method:'POST',path,body:{operation:'patch',idempotencyKey:'outage-patch',
      id:receipt.ref.id,expectedRevision:1,set:{label:'Outage'},unset:[]}},
    {method:'POST',path,body:{operation:'delete',idempotencyKey:'outage-delete',
      id:receipt.ref.id,expectedRevision:1}}
  ];
  await Promise.all(outageRequests.map(async({method,path:outagePath,body})=>{
    const started=Date.now();
    const response=await fetch(endpoint+outagePath,{method,signal:AbortSignal.timeout(8_000),
      headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();
    assert(Date.now()-started<8_000 && response.status===503 &&
      result.error?.code==='PROVIDER_UNAVAILABLE' &&
      result.error.retryable===true && response.headers.get('Retry-After')==='1' &&
      !JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(databaseUrl),
    `bounded redacted provider failure for ${method} ${outagePath}`);
  }));
  const cliOutage=spawnSync(process.execPath,[cli,'records','create','--collection',collectionId,
    '--idempotency-key','outage-cli','--data',JSON.stringify(data)],
  {cwd:temp,env:cliEnv,encoding:'utf8'});
  const cliOutageError=JSON.parse(cliOutage.stderr).error;
  assert(cliOutage.status!==0 && cliOutageError.code==='PROVIDER_UNAVAILABLE' &&
    cliOutageError.retryable===true &&
    !`${cliOutage.stdout}${cliOutage.stderr}`.includes(token) &&
    !`${cliOutage.stdout}${cliOutage.stderr}`.includes(databaseUrl),
  'installed CLI returns a redacted provider failure without replaying its write');
  await providerMode('forward');
  assert(JSON.stringify(await effects())===JSON.stringify(beforeOutage),
    'outage requests have no record, event or receipt effects');
  assert((await request('GET',`v1/spaces/${spaceId}`)).spaceId===spaceId,
    'the cached host pool recovers after the provider returns');
  runCli(['auth','login','--token-stdin','--store','file'],{env:cliEnv,input:`${token}\n`});
  const blocker=await fixturePool.connect();
  const cancelledSpace=`sp_${randomUUID()}`;
  const cancelledCliSpace=`sp_${randomUUID()}`;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE space_directory IN ACCESS EXCLUSIVE MODE');
    async function assertLockedCancellation(method,lockedPath,body) {
      const response=await fetch(endpoint+lockedPath,{method,signal:AbortSignal.timeout(8_000),
        headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},
        body:body?JSON.stringify(body):undefined});
      const value=await response.json();
      const code=method==='GET'?'RATE_LIMITED':'COMMIT_OUTCOME_UNKNOWN';
      assert(response.status===(method==='GET'?429:503) && value.error?.code===code &&
        value.error.retryable===(method==='GET') &&
        response.headers.get('Retry-After')===(method==='GET'?'1':null),
      'server cancellation wins over the socket timer for a locked request');
    }
    await assertLockedCancellation('GET',`v1/spaces/${spaceId}`);
    await assertLockedCancellation('POST','v1/spaces',{spaceId:cancelledSpace});
    const cliCancellation=spawnSync(process.execPath,[cli,'spaces','create','--space',cancelledCliSpace],
      {cwd:temp,env:cliEnv,encoding:'utf8',timeout:12_000});
    const cliError=JSON.parse(cliCancellation.stderr).error;
    assert(cliCancellation.status===1 && cliError.code==='COMMIT_OUTCOME_UNKNOWN' &&
      cliError.retryable===false &&
      !`${cliCancellation.stdout}${cliCancellation.stderr}`.includes(token) &&
      !`${cliCancellation.stdout}${cliCancellation.stderr}`.includes(databaseUrl),
    `installed CLI keeps a cancelled space publication nonretryable and redacted: ${JSON.stringify({status:cliCancellation.status,code:cliError.code,retryable:cliError.retryable})}`);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert((await fixturePool.query('SELECT count(*)::int AS n FROM space_directory WHERE space_id=$1',
    [cancelledSpace])).rows[0].n===0,'cancelled create has no durable space');
  assert((await fixturePool.query('SELECT count(*)::int AS n FROM space_directory WHERE space_id=$1',
    [cancelledCliSpace])).rows[0].n===0,'cancelled CLI create has no durable space');
  assert((await request('GET',`v1/spaces/${spaceId}`)).spaceId===spaceId,
    'the host reuses a healthy client after confirmed cancellation');
  const silentRequests=[
    {method:'GET',path:`v1/spaces/${spaceId}`},
    {method:'POST',path:`${path}/query`,body:{predicates:[],limit:1}},
    {method:'POST',path:`${path}/count`,body:[]},
    {method:'POST',path,body:{operation:'create',idempotencyKey:'silent-create',data}},
    {method:'POST',path,body:{operation:'replace',idempotencyKey:'silent-replace',
      id:receipt.ref.id,expectedRevision:1,data:{...data,label:'Silent replace'}}},
    {method:'POST',path,body:{operation:'patch',idempotencyKey:'silent-patch',
      id:receipt.ref.id,expectedRevision:2,set:{label:'Silent patch'},unset:[]}},
    {method:'POST',path,body:{operation:'delete',idempotencyKey:'silent-delete',
      id:receipt.ref.id,expectedRevision:3}}
  ];
  async function checkSilentRequest(item) {
    await request('GET',`v1/spaces/${spaceId}`);
    await providerMode('silent');
    const started=Date.now();
    const response=await fetch(endpoint+item.path,{method:item.method,signal:AbortSignal.timeout(8_000),
      headers:{Authorization:`Bearer ${token}`,...(item.body===undefined?{}:{'Content-Type':'application/json'})},
      body:item.body===undefined?undefined:JSON.stringify(item.body)});
    const result=await response.json();
    const safe=item.method==='GET' || item.path.endsWith('/query') || item.path.endsWith('/count');
    assert(Date.now()-started<8_000 && response.status===503 &&
      result.error?.code===(safe?'PROVIDER_UNAVAILABLE':'COMMIT_OUTCOME_UNKNOWN') &&
      result.error.retryable===safe && response.headers.get('Retry-After')===(safe?'1':null) &&
      !JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(databaseUrl),
    `bounded established-query failure for ${item.method} ${item.path}`);
    await providerMode('forward');
    if (!safe) {
      const first=await request('POST',path,item.body);
      const counts=await effects();
      const replay=await request('POST',path,item.body);
      assert(replay.replayed && replay.receiptId===first.receiptId &&
        JSON.stringify(await effects())===JSON.stringify(counts),
      `explicit original-credential ${item.body.operation} recovery has no duplicate effect`);
    }
  }
  // Each fault must be restored and its write reconciled before the next one.
  await silentRequests.reduce((previous,item)=>previous.then(()=>checkSilentRequest(item)),Promise.resolve());
  // Report success after the disposable space and processes are gone.
} catch(error) {
  testError=error;
} finally {
  async function cleanupStep(action) {
    try { await action(); } catch(error) { cleanupErrors.push(error); }
  }
  if (provider?.exitCode===null && provider.signalCode===null)
    await cleanupStep(()=>providerMode('forward'));
  // This synthetic agent key has no provider backing; remove it before the
  // real space erasure flow asks the provider to revoke remaining keys.
  await cleanupStep(()=>fixturePool?.query('DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2',
    [spaceId,agentCredential]));
  await cleanupStep(()=>fixturePool?.query('DELETE FROM space_credentials WHERE space_id=$1 AND credential_id=$2',
    [spaceId,agentCredential]));
  // The create response can be lost after COMMIT. Reconcile the selected ID
  // before cleanup, including when the command failed before seeing a receipt.
  await cleanupStep(async()=>{
    try {
      if (!app) throw new Error('HTTP host unavailable during cleanup');
      const lookup=await fetch(endpoint+`v1/spaces/${spaceId}`,{
        headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15_000)});
      if (lookup.ok) {
        await request('PATCH',`v1/spaces/${spaceId}`,{lifecycle:'readOnly'});
        await request('DELETE',`v1/spaces/${spaceId}`);
      } else if (lookup.status!==404) {
        throw new Error(`HTTP cleanup lookup failed: ${lookup.status}`);
      }
    } catch(httpError) {
      if (!appEnv) return;
      // The relay itself may be dead. Reconcile by the known space ID through
      // the same service against the direct disposable database.
      fixturePool ??= new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5_000,query_timeout:5_000});
      const actor={kind:'session',userPrincipalId:appEnv?.STATEPLANE_TEST_OWNER,
        credentialId:appEnv?.STATEPLANE_TEST_CREDENTIAL};
      const cellId=appEnv.STATEPLANE_TEST_CELL_ID??'cell-a';
      const storageTargetId=appEnv.STATEPLANE_TEST_STORAGE_TARGET??'target-a';
      const spaces=new PostgresSpaces(fixturePool,new Map([[cellId,{pool:fixturePool,storageTargetId}]]),
        cellId,{create:()=>Promise.reject(new Error('not configured')),
          find:()=>Promise.resolve(null),revoke:()=>Promise.reject(new Error('not configured'))},
        {current:()=>Promise.resolve(true)},Buffer.from(appEnv?.STATEPLANE_TEST_CURSOR_SECRET??'00'.repeat(32),'hex'));
      try {
        const space=await spaces.get(actor,spaceId);
        if (space.lifecycle==='active') await spaces.archive(actor,spaceId);
        await spaces.delete(actor,spaceId);
      } catch(directError) {
        if (directError?.code!=='NOT_FOUND')
          throw new AggregateError([httpError,directError],'HTTP and direct space cleanup failed',
            {cause:directError});
      }
    }
  });
  await cleanupStep(async()=>{
    if (!appEnv) return;
    const verifier=new pg.Client({connectionString:databaseUrl,connectionTimeoutMillis:5_000,query_timeout:5_000});
    try {
      await verifier.connect();
      const remaining=await verifier.query(`SELECT
        (SELECT count(*)::int FROM spaces WHERE space_id=$1 AND lifecycle<>'deleted') AS cells,
        (SELECT count(*)::int FROM space_directory WHERE space_id=$1 AND lifecycle<>'deleted') AS directory`,
      [spaceId]);
      assert(remaining.rows[0].cells===0 && remaining.rows[0].directory===0,
        'HTTP host smoke leaves no active disposable space after cleanup');
    } finally { await verifier.end().catch(()=>{}); }
  });
  await cleanupStep(()=>fixturePool?.end());
  await cleanupStep(async()=>{
    if (!app) return;
    if (app?.exitCode===null && app.signalCode===null) app.kill('SIGTERM');
    try { await waitClosed(app,3_000); }
    catch {
      app.kill('SIGKILL');
      await waitClosed(app,3_000);
    }
  });
  await cleanupStep(async()=>{
    if (provider?.exitCode!==null || provider?.signalCode!==null) return;
    provider.send('close');
    try { await waitClosed(provider,3_000); }
    catch {
      provider.kill('SIGKILL');
      await waitClosed(provider,3_000);
    }
  });
  await cleanupStep(()=>rm(temp,{recursive:true,force:true}));
}
if (testError && cleanupErrors.length) throw new AggregateError([testError,...cleanupErrors],
  'HTTP host smoke and cleanup both failed');
if (cleanupErrors.length) throw new AggregateError(cleanupErrors,'HTTP host smoke cleanup failed');
if (testError) throw testError;
console.log('Installed CLI and independent HTTP client reached the live /v1 host with matching state and receipt');

function assert(condition,message) { if (!condition) throw new Error(message); }

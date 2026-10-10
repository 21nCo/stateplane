import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { connectionOptions } from './db-connection.mjs';
import { wranglerInvocation } from './wrangler-command.mjs';
import { CollectionRegistry, PostgresSpaces, postgresServices } from '../packages/postgres/dist/index.js';
import { createMcpHandler } from '../packages/mcp/dist/index.js';

const root=resolve(import.meta.dirname,'..');
function assert(condition,message) { if (!condition) throw new Error(message); }

/** Cleanup owned by the caller from before initialization starts. Steps run in
 * reverse registration order, and each runs even when an earlier one fails. */
export function finalizers() {
  const steps=[];
  return {
    add(step) { steps.push(step); },
    get size() { return steps.length; },
    async run() {
      const errors=[];
      while (steps.length) {
        try { await steps.pop()(); } catch(error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors,`cleanup incomplete: ${errors.map(error=>error?.message??error).join('; ')}`);
    }
  };
}
/** Erase every disposable space; one failure does not skip the others. */
async function eraseAll(spaceIds,erase) {
  const errors=[];
  for (const spaceId of spaceIds) {
    try { await erase(spaceId); } catch(error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,`space cleanup failed for ${errors.length} space(s)`);
}
async function stop(child) {
  if (child.exitCode!==null || child.signalCode!==null) return;
  const closed=once(child,'close');
  child.kill('SIGTERM');
  if (await Promise.race([closed.then(()=>true),new Promise(r=>setTimeout(()=>r(false),3_000))])) return;
  child.kill('SIGKILL');
  await closed;
}

export function loopbackUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return readFile(join(root,'.data/local-db-password'),'utf8').then(password=>
    `postgres://stateplane:${encodeURIComponent(password.trim())}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`);
}

/** Production composition outside Cloudflare: AuthFn sessions and keys, real issue and revoke. */
export async function inProcessBackend({cleanup}) {
  const { memoryAdapter }=await import('@superfunctions/db/testing');
  const { createAuthFn, createUser, issueSession }=await import('@authfn/core');
  const { AuthFnIdentityVerifier, AuthFnAgentKeys }=await import('../packages/auth/dist/index.js');
  const pool=new pg.Pool({...connectionOptions(await loopbackUrl()),max:6});
  cleanup.add(()=>pool.end());
  const config={database:memoryAdapter(),namespace:`sta10-gate-${randomUUID()}`,plugins:[]};
  createAuthFn(config);
  const identity=new AuthFnIdentityVerifier(config);
  const cells=new Map([['cell-a',{pool,storageTargetId:'target-a'}]]);
  const spaces=new PostgresSpaces(pool,cells,'cell-a',new AuthFnAgentKeys(config),identity,randomBytes(32));
  const services=postgresServices(spaces,new Map([['cell-a',{pool,cursorSecret:randomBytes(32)}]]),3600);
  const holder={};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const response=await holder.handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{
      method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined}));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  cleanup.add(()=>new Promise(resolve=>{ server.closeAllConnections(); server.close(()=>resolve()); }));
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`;
  holder.handler=createMcpHandler({services,identity,resource:endpoint,authorizationServers:['http://127.0.0.1:9/'],
    allowInsecureLoopback:true,requestTimeoutMs:12_000});
  const user=await createUser(config,{primaryEmail:`owner-${randomUUID()}@example.invalid`});
  const session=await issueSession(config,{},{userId:user.id,methods:['password']});
  const owner=await identity.verify(new Request(endpoint,{headers:{authorization:`Bearer ${session.sessionToken}`}}));
  const spaceIds=[];
  cleanup.add(()=>eraseAll(spaceIds,async spaceId=>{
    try { await spaces.archive(owner,spaceId); await spaces.delete(owner,spaceId); }
    catch(error) { if (error?.code!=='NOT_FOUND') throw error; }
  }));
  return {endpoint,ownerToken:session.sessionToken,denial:'transport',endpointInfo:{origin:'loopback',path:'/mcp',runtime:'node-in-process'},
    async createSpace() { const spaceId=`sp_${randomUUID()}`; spaceIds.push(spaceId); await spaces.create(owner,'cell-a',spaceId); return spaceId; },
    async grantAgent(spaceId,collectionId,capabilities) {
      const key=await spaces.issueAgentKey(owner,spaceId,new Date(Date.now()+3_600_000),[{collectionId,capabilities}]);
      return {token:key.secret,revoke:()=>spaces.revokeAgentKey(owner,spaceId,key.id)};
    },
    async backfill(spaceId,collectionId,field) {
      const {scope}=await spaces.scope(owner,spaceId,collectionId,'schema:write');
      return (await new CollectionRegistry(pool).backfill(scope,field)).ready;
    }};
}

/** The app's opt-in host with its fixture identity: an external endpoint, or a
 * local vite (Node) or wrangler (workerd) run. */
export async function hostBackend({workerd=false,cleanup}) {
  const external=process.env.STATEPLANE_MCP_ENDPOINT;
  const databaseUrl=external ? process.env.DATABASE_URL : await loopbackUrl();
  assert(databaseUrl,'DATABASE_URL is required for fixture grants');
  const env=external ? process.env : {STATEPLANE_TEST_TOKEN:randomBytes(32).toString('hex'),
    STATEPLANE_TEST_OWNER:`owner-${randomUUID()}`,STATEPLANE_TEST_CREDENTIAL:`session-${randomUUID()}`,
    STATEPLANE_TEST_AGENT_TOKEN:randomBytes(32).toString('hex'),STATEPLANE_TEST_AGENT_CREDENTIAL:`agent-${randomUUID()}`,
    STATEPLANE_TEST_CURSOR_SECRET:randomBytes(32).toString('hex')};
  for (const name of ['STATEPLANE_TEST_TOKEN','STATEPLANE_TEST_OWNER','STATEPLANE_TEST_CREDENTIAL','STATEPLANE_TEST_AGENT_TOKEN','STATEPLANE_TEST_AGENT_CREDENTIAL'])
    assert(env[name],`${name} is required`);
  let app;
  let secrets;
  let endpoint=external;
  if (!external) {
    const reservation=createNetServer();
    reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
    const port=reservation.address().port;
    reservation.close(); await once(reservation,'close');
    endpoint=`http://127.0.0.1:${port}/mcp`;
    const bindings={...env,STATEPLANE_TEST_HTTP:'1',STATEPLANE_TEST_DATABASE_URL:databaseUrl,
      STATEPLANE_MCP_AUTHORIZATION_SERVER:'http://127.0.0.1:9/'};
    if (workerd) {
      // workerd receives the fixture secrets from a private file, never argv.
      const built=spawnSync(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'build'],{cwd:join(root,'app'),stdio:'ignore'});
      assert(built.status===0,'app build failed');
      secrets=await mkdtemp(join(tmpdir(),'stateplane-workerd-'));
      cleanup.add(()=>rm(secrets,{recursive:true,force:true}));
      const file=join(secrets,'worker.env');
      await writeFile(file,Object.entries(bindings).map(([name,value])=>`${name}=${value}`).join('\n')+'\n',{mode:0o600});
      const {command,args}=wranglerInvocation(['dev','--config','wrangler.jsonc','--persist-to','../.data/wrangler/app',
        '--ip','127.0.0.1','--port',String(port),'--env-file',file]);
      app=spawn(command,args,{cwd:join(root,'app'),stdio:'ignore',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
    } else {
      app=spawn(process.execPath,[join(root,'app/node_modules/vite/bin/vite.js'),'dev','--host','127.0.0.1','--port',String(port),
        '--strictPort'],{cwd:join(root,'app'),stdio:'ignore',env:{...process.env,...bindings,STATEPLANE_ENV:'local'}});
    }
    const child=app;
    cleanup.add(()=>stop(child));
    let ready=false;
    for (let attempt=0;attempt<600 && !ready;attempt++) {
      if (app.exitCode!==null) throw new Error('app host exited before readiness');
      try { ready=(await fetch(new URL('/api/health',endpoint))).ok; } catch { /* still starting */ }
      if (!ready) await new Promise(resolve=>setTimeout(resolve,100)); // NOSONAR -- readiness polling is sequential
    }
    assert(ready,'app host did not become ready');
  }
  const origin=new URL(endpoint);
  const pool=new pg.Pool({...connectionOptions(databaseUrl),max:2});
  cleanup.add(()=>pool.end());
  const http=async(method,path,body)=>{
    const response=await fetch(new URL(`/v1/${path}`,endpoint),{method,headers:{authorization:`Bearer ${env.STATEPLANE_TEST_TOKEN}`,
      ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    assert(response.ok,`HTTP ${method} ${path} failed with ${response.status}`);
    return response.json();
  };
  const spaceIds=[];
  const agent=env.STATEPLANE_TEST_AGENT_CREDENTIAL;
  // Registered last, so it runs first, while the app and pool still exist.
  cleanup.add(()=>eraseAll(spaceIds,async spaceId=>{
    await pool.query('DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2',[spaceId,agent]);
    await pool.query('DELETE FROM space_credentials WHERE space_id=$1 AND credential_id=$2',[spaceId,agent]);
    await http('PATCH',`spaces/${spaceId}`,{lifecycle:'readOnly'});
    await http('DELETE',`spaces/${spaceId}`);
    const left=(await pool.query(`SELECT (SELECT count(*)::int FROM spaces WHERE space_id=$1 AND lifecycle<>'deleted')+
      (SELECT count(*)::int FROM space_directory WHERE space_id=$1 AND lifecycle<>'deleted') AS n`,[spaceId])).rows[0].n;
    assert(left===0,'the disposable space is erased');
  }));
  return {endpoint,ownerToken:env.STATEPLANE_TEST_TOKEN,denial:'service',
    endpointInfo:{origin:external?origin.origin:'loopback',path:origin.pathname,runtime:external?'external':workerd?'workerd':'node-vite'},
    async createSpace() { const spaceId=`sp_${randomUUID()}`; spaceIds.push(spaceId); await http('POST','spaces',{spaceId}); return spaceId; },
    async grantAgent(spaceId,collectionId,capabilities) {
      // The fixture host authenticates one configured agent bearer; its cell
      // credential and grants are what the shared services authorize.
      await pool.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,
        expires_at,activated_at,confirmed_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
      [spaceId,agent,`agent-principal-${randomUUID()}`,env.STATEPLANE_TEST_OWNER]);
      await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities) VALUES($1,$2,$3,$4::text[])`,
        [spaceId,collectionId,agent,capabilities]);
      return {token:env.STATEPLANE_TEST_AGENT_TOKEN,revoke:()=>pool.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND credential_id=$2`,[spaceId,agent])};
    },
    async backfill(spaceId,collectionId,field) {
      const placement=(await pool.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId])).rows[0];
      const scope={spaceId,collectionId,principalId:env.STATEPLANE_TEST_OWNER,credentialId:env.STATEPLANE_TEST_CREDENTIAL,
        capability:'schema:write',policyVersion:Number(placement.policy_version),placementGeneration:Number(placement.placement_generation)};
      return (await new CollectionRegistry(pool).backfill(scope,field)).ready;
    }};
}

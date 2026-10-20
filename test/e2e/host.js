// Start the UI for Playwright. With a local or DATABASE_URL Postgres it
// creates a disposable database, migrates it and enables the opt-in fixture
// host; the database is dropped when Playwright stops this process. The UI
// reaches a plaintext database through a loopback proxy whose control port lets a
// test drop chosen replies, so a lost acknowledgement is reproducible, or fail the
// fixture provider's next key revocation. A database reached over TLS keeps its
// own host, so its certificate is verified as usual, and refuses SQL faults.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../..',import.meta.url));
const base=process.env.STATEPLANE_E2E_BASE_DATABASE;
const faultPort=5744;
let url;
let created=false;
// The running child (migration, then the UI) and a promise that settles once
// it has ended, whether it exited or was signalled.
let child;
let ended;
let server;
let control;
let stopping=false;
let startup;
const halted=new AbortController();
/** Shutdown waits for startup to settle; startup opens nothing once shutdown
 * has begun, so every child is killed and awaited before the DROP. The exit
 * status is the first failure: startup, the UI's own exit or the cleanup. */
async function stop(code=0) {
  if (stopping) return;
  stopping=true;
  halted.abort();
  try {
    child?.kill('SIGTERM');
    await startup?.catch(()=>{});
    child?.kill('SIGTERM');
    await ended;
    server?.close();
    control?.close();
    if (created) {
      const admin=new pg.Client({connectionString:base,connectionTimeoutMillis:10_000});
      // A lost connection also rejects the pending call, which reports it.
      admin.on('error',()=>{});
      await admin.connect();
      try { await admin.query(`DROP DATABASE IF EXISTS ${url.pathname.slice(1)} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  } catch (error) {
    console.error(`e2e cleanup failed; drop database ${url?.pathname.slice(1)} by hand:`,error.message || error.code);
    code||=1;
  } finally { process.exit(code); }
}
function run(args,options) {
  child=spawn(process.execPath,args,{stdio:'inherit',...options});
  // A signalled child has no exit code; it failed as surely as a nonzero exit.
  ended=new Promise(resolve=>{ child.once('exit',code=>resolve(code ?? 1)); child.once('error',()=>resolve(1)); });
  return ended;
}

/** The proxy reads protocol messages, so only a database reached without TLS
 * is proxied: any TLS setting in the URL, or PGSSLMODE, keeps the database's host. */
export const plaintext=(target,env=process.env)=>[...target.searchParams].every(([name,value])=>
  !/^ssl/.test(name) || (name==='sslmode' && value==='disable')) && [undefined,'','disable'].includes(env.PGSSLMODE);

/** Armed faults, applied in order: after a client message containing `after`
 * (or at once), the reply to the next message containing `match` is dropped and
 * both sockets close, as when a connection fails after the database acted. A
 * `refuse` fault closes them before that message is sent, so the database never
 * acts. Markers match whole protocol messages, however TCP splits them. */
export function faultProxy(target,faults) {
  return net.createServer(client=>{
    const upstream=net.connect(Number(target.port || 5432),target.hostname);
    let seen=null;
    let drop=false;
    // The startup message (or an SSL or GSSAPI request before it) has no type byte.
    let typed=false;
    let pending=Buffer.alloc(0);
    const close=()=>{ client.destroy(); upstream.destroy(); };
    client.on('data',chunk=>{
      pending=Buffer.concat([pending,chunk]);
      for (let start=typed ? 1 : 0;pending.length>=start+4;start=typed ? 1 : 0) {
        const size=start+pending.readUInt32BE(start);
        if (size<start+4) return close();
        if (pending.length<size) return;
        const message=pending.subarray(0,size);
        pending=pending.subarray(size);
        typed||=!(size===8 && [80877103,80877104].includes(message.readUInt32BE(4)));
        const text=message.toString('latin1');
        const [fault]=faults;
        if (fault && (!fault.after || text.includes(fault.after))) seen=fault;
        if (fault && seen===fault && text.includes(fault.match)) {
          faults.shift();
          if (fault.refuse) return close();
          drop=true;
        }
        upstream.write(message);
      }
    });
    upstream.on('data',chunk=>{ if (drop) close(); else client.write(chunk); });
    for (const socket of [client,upstream]) { socket.on('error',close); socket.on('close',close); }
  });
}
const faults=[];
let providerFault=false;
async function proxy(target) {
  const direct=!plaintext(target);
  if (!direct) {
    server=faultProxy(target,faults).listen(0,'127.0.0.1');
    await once(server,'listening');
  }
  control=createServer((request,response)=>{
    let body='';
    request.on('data',chunk=>{ body+=chunk; });
    request.on('end',()=>{
      // A test posts "arm"; the fixture provider's empty post consumes the
      // armed failure (200) or proceeds (204).
      if (request.url==='/provider-fault') {
        response.writeHead(body!=='arm' && providerFault ? 200 : 204).end();
        providerFault=body==='arm';
        return;
      }
      if (direct) return response.writeHead(409).end();
      try {
        const {match,after,refuse}=JSON.parse(body);
        if (typeof match!=='string' || !match) throw new Error('match');
        faults.push({match,after:typeof after==='string' ? after : null,refuse:refuse===true});
        response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
    });
  });
  // once() rejects on 'error', so EADDRINUSE fails startup inside its try.
  control.listen(faultPort,'127.0.0.1');
  await once(control,'listening');
  if (direct) return target;
  const proxied=new URL(target);
  proxied.hostname='127.0.0.1';
  proxied.port=String(server.address().port);
  return proxied;
}

async function start() {
  let databaseUrl;
  if (base) {
    url=new URL(base);
    url.pathname=`/stateplane_e2e_${randomUUID().replaceAll('-','')}`;
    const admin=new pg.Client({connectionString:base});
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${url.pathname.slice(1)}`);
      created=true;
    } finally { await admin.end(); }
    // Test-only: hold startup here so a launcher test can signal mid-startup.
    await delay(Number(process.env.STATEPLANE_E2E_TEST_STARTUP_DELAY_MS ?? 0),undefined,{signal:halted.signal});
    if (stopping) return;
    const code=await run(['scripts/migrate.mjs'],{cwd:root,env:{...process.env,DATABASE_URL:url.href}});
    if (stopping) return;
    if (code!==0) throw new Error(`migration exited with ${code}`);
    databaseUrl=(await proxy(url)).href;
    if (stopping) return;
  }
  void run(['node_modules/vite/bin/vite.js','dev','--host','127.0.0.1','--port','5743','--strictPort'],
    {cwd:`${root}/app`,env:{...process.env,...(databaseUrl ? {STATEPLANE_TEST_DATABASE_URL:databaseUrl,
      STATEPLANE_TEST_PROVIDER_FAULT_URL:`http://127.0.0.1:${faultPort}/provider-fault`} : {})}}).then(code=>stop(code));
}
if (process.argv[1]===fileURLToPath(import.meta.url)) {
  // A second signal during cleanup exits at once.
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ if (stopping) process.exit(1); void stop(); });
  startup=start();
  startup.catch(error=>{ if (!stopping) console.error(error); void stop(1); });
}

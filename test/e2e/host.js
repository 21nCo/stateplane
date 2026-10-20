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
import { realpathSync } from 'node:fs';
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
// The session running CREATE DATABASE until its outcome is known.
let creator;
// The running child (migration, then the UI) and a promise that settles once
// it has ended, whether it exited or was signalled.
let child;
let ended;
let server;
let control;
let stopping=false;
let startup;
const halted=new AbortController();
const within=(promise,ms)=>Promise.race([promise.then(()=>true,()=>true),delay(ms).then(()=>false)]);
/** Exit 1, naming the database if it may exist and was not dropped. */
function abandon(reason) {
  if (created) console.error(`e2e cleanup failed; drop database ${url.pathname.slice(1)} by hand:`,reason);
  process.exit(1);
}
/** Shutdown waits a bounded time for startup to settle; startup opens nothing
 * once shutdown has begun, so every child is killed and awaited before the
 * DROP. Playwright kills this process 15 s after SIGTERM, so a step that
 * stalls ends in a named database before then. The exit status is the first
 * failure: startup, the UI's own exit or the cleanup. */
async function stop(code=0) {
  if (stopping) return;
  stopping=true;
  halted.abort();
  setTimeout(()=>abandon('cleanup did not finish in time'),12_000);
  try {
    child?.kill('SIGTERM');
    if (!await within(startup ?? Promise.resolve(),3_000)) { console.error('e2e startup did not finish'); code||=1; }
    child?.kill('SIGTERM');
    if (child && !await within(ended,3_000)) { child.kill('SIGKILL'); await ended; }
    server?.close();
    control?.close();
    if (created) {
      const admin=new pg.Client({connectionString:base,connectionTimeoutMillis:5_000});
      // A lost connection also rejects the pending call, which reports it.
      admin.on('error',()=>{});
      await admin.connect();
      try {
        // An unanswered CREATE may still commit: end its session so the DROP is final.
        if (creator && !await endSession(admin,creator)) throw new Error('the CREATE DATABASE session did not end');
        await admin.query(`DROP DATABASE IF EXISTS ${url.pathname.slice(1)} WITH (FORCE)`);
      } finally { await admin.end(); }
    }
  } catch (error) { abandon(error.message || error.code); }
  process.exit(code);
}
/** A session's identity: its pid and start time, since a later session can reuse the pid. */
export async function sessionOf(client) {
  const {rows:[{started}]}=await client.query('SELECT extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()');
  return {pid:client.processID,started};
}
/** End that session if it is still running; false if it did not end in time. */
export async function endSession(admin,{pid,started}) {
  const {rows:[session]}=await admin.query(`SELECT pg_terminate_backend(pid,3000) AS ended FROM pg_stat_activity
    WHERE pid=$1 AND extract(epoch FROM backend_start)=$2::numeric`,[pid,started]);
  return !session || session.ended;
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
  !name.startsWith('ssl') || (name==='sslmode' && value==='disable')) && [undefined,'','disable'].includes(env.PGSSLMODE);

/** Armed faults, applied in order: after a client message containing `after`
 * (or at once), the reply to the next message containing `match` is dropped and
 * both sockets close, as when a connection fails after the database acted. A
 * `refuse` fault closes them before that message is sent, so the database never
 * acts. A `hold` fault keeps both sockets open and discards every later reply,
 * as when a connection stalls. A `fatal` fault replaces the reply with a server
 * FATAL error, as when the session is ended after the database acted. Markers
 * match whole protocol messages, however TCP splits them. */
export function faultProxy(target,faults) {
  return net.createServer(client=>{
    // URL.hostname keeps an IPv6 address in brackets; net.connect takes it bare.
    const upstream=net.connect(Number(target.port || 5432),target.hostname.replace(/^\[(.*)\]$/,'$1'));
    let seen=null;
    // What becomes of the replies: forward, close, hold or fatal.
    let reply='forward';
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
          reply=fault.hold ? 'hold' : fault.fatal ? 'fatal' : 'close';
        }
        upstream.write(message);
      }
    });
    upstream.on('data',chunk=>{
      if (reply==='forward') client.write(chunk);
      else if (reply==='close') close();
      else if (reply==='fatal') {
        // Later replies are discarded; both sockets close once the error is sent.
        reply='hold';
        client.end(serverError('FATAL','57P05','terminating connection due to idle-session timeout'),close);
      }
    });
    for (const socket of [client,upstream]) { socket.on('error',close); socket.on('close',close); }
  });
}
/** A server ErrorResponse message. */
function serverError(severity,code,text) {
  const body=Buffer.from(`S${severity}\0V${severity}\0C${code}\0M${text}\0\0`,'latin1');
  const head=Buffer.from('E\0\0\0\0','latin1');
  head.writeUInt32BE(body.length+4,1);
  return Buffer.concat([head,body]);
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
    // A launcher test names the database, so that it cleans up only its own.
    const id=process.env.STATEPLANE_E2E_TEST_DATABASE_ID ?? randomUUID().replaceAll('-','');
    if (!/^[a-z0-9]+$/.test(id)) throw new Error('the database id is lowercase letters and digits');
    url=new URL(base);
    url.pathname=`/stateplane_e2e_${id}`;
    const admin=new pg.Client({connectionString:base});
    admin.on('error',()=>{});
    await admin.connect();
    try {
      if (stopping) return;
      const session=await sessionOf(admin);
      if (stopping) return;
      // Once CREATE is sent the database may exist, unless Postgres refused it.
      created=true;
      creator=session;
      await admin.query(`CREATE DATABASE ${url.pathname.slice(1)}`);
      creator=undefined;
    } catch (error) {
      // Only a statement ERROR is a refusal; a FATAL can end the session after
      // the CREATE committed. pg reports the localized severity, so a refusal
      // in another language is cleaned up as uncertain, except for an existing
      // database of that name, which is never this launcher's to drop.
      if (error.severity==='ERROR' || error.code==='42P04') { created=false; creator=undefined; }
      throw error;
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
// import.meta.url is a real path; the script may be run through a symlink.
if (process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  // A second signal during cleanup exits at once, naming the database.
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ if (stopping) abandon(`second ${signal}`); void stop(); });
  startup=start();
  startup.catch(error=>{ if (!stopping) console.error(error); void stop(1); });
}

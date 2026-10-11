// Start the UI for Playwright. With a local or DATABASE_URL Postgres it
// creates a disposable database, migrates it and enables the opt-in fixture
// host; the database is dropped when Playwright stops this process. The UI
// reaches that database through a loopback proxy whose control port lets a
// test drop one reply, so a lost acknowledgement is reproducible.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../..',import.meta.url));
const base=process.env.STATEPLANE_E2E_BASE_DATABASE;
const faultPort=5744;
let url;
let creating;
let app;
let control;
let stopping=false;
async function stop(code=0) {
  if (stopping) return;
  stopping=true;
  if (app) {
    app.kill('SIGTERM');
    if (app.exitCode===null) await once(app,'exit');
  }
  control?.close();
  try {
    await creating?.catch(()=>{});
    if (url) {
      const admin=new pg.Client({connectionString:base});
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${url.pathname.slice(1)} WITH (FORCE)`);
      await admin.end();
    }
  } finally { process.exit(code); }
}
// Cleanup is registered before the database exists, so an interrupt or a failed
// migration during startup still drops it.
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void stop());

/** One armed fault: after a client message containing `after` (or at once),
 * the reply to the next message containing `match` is dropped and both sockets
 * close, as when a connection fails after the database acted. */
let fault=null;
async function proxy(target) {
  const server=net.createServer(client=>{
    const upstream=net.connect(Number(target.port || 5432),target.hostname);
    let seen=null;
    let drop=false;
    const close=()=>{ client.destroy(); upstream.destroy(); };
    client.on('data',chunk=>{
      const text=chunk.toString('latin1');
      if (fault && (!fault.after || text.includes(fault.after))) seen=fault;
      if (fault && seen===fault && text.includes(fault.match)) { drop=true; fault=null; }
      upstream.write(chunk);
    });
    upstream.on('data',chunk=>{ if (drop) close(); else client.write(chunk); });
    for (const socket of [client,upstream]) { socket.on('error',close); socket.on('close',close); }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const proxied=new URL(target);
  proxied.hostname='127.0.0.1';
  proxied.port=String(server.address().port);
  control=createServer((request,response)=>{
    let body='';
    request.on('data',chunk=>{ body+=chunk; });
    request.on('end',()=>{
      try {
        const {match,after}=JSON.parse(body);
        if (typeof match!=='string' || !match) throw new Error('match');
        fault={match,after:typeof after==='string' ? after : null};
        response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
    });
  }).listen(faultPort,'127.0.0.1');
  return proxied;
}

let databaseUrl;
if (base) {
  url=new URL(base);
  url.pathname=`/stateplane_e2e_${randomUUID().replaceAll('-','')}`;
  try {
    creating=(async()=>{
      const admin=new pg.Client({connectionString:base});
      await admin.connect();
      try { await admin.query(`CREATE DATABASE ${url.pathname.slice(1)}`); } finally { await admin.end(); }
    })();
    await creating;
    execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:root,env:{...process.env,DATABASE_URL:url.href},stdio:'inherit'});
    databaseUrl=(await proxy(url)).href;
  } catch (error) {
    console.error(error);
    await stop(1);
  }
}
app=spawn(process.execPath,['node_modules/vite/bin/vite.js','dev','--host','127.0.0.1','--port','5743','--strictPort'],
  {cwd:`${root}/app`,stdio:'inherit',env:{...process.env,...(databaseUrl ? {STATEPLANE_TEST_DATABASE_URL:databaseUrl} : {})}});
app.on('exit',()=>void stop());

// Start the UI for Playwright. With a local or DATABASE_URL Postgres it
// creates a disposable database, migrates it and enables the opt-in fixture
// host; the database is dropped when Playwright stops this process.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root=fileURLToPath(new URL('../..',import.meta.url));
const base=process.env.STATEPLANE_E2E_BASE_DATABASE;
let url;
if (base) {
  url=new URL(base);
  url.pathname=`/stateplane_e2e_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Client({connectionString:base});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${url.pathname.slice(1)}`);
  await admin.end();
  execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:root,env:{...process.env,DATABASE_URL:url.href},stdio:'inherit'});
}
const app=spawn(process.execPath,['node_modules/vite/bin/vite.js','dev','--host','127.0.0.1','--port','5743','--strictPort'],
  {cwd:`${root}/app`,stdio:'inherit',env:{...process.env,...(url ? {STATEPLANE_TEST_DATABASE_URL:url.href} : {})}});
let stopping=false;
async function stop() {
  if (stopping) return;
  stopping=true;
  app.kill('SIGTERM');
  if (app.exitCode===null) await once(app,'exit');
  if (url) {
    const admin=new pg.Client({connectionString:base});
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${url.pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  }
  process.exit(0);
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void stop());
app.on('exit',()=>void stop());

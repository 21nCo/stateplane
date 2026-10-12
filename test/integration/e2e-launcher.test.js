import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const password=process.env.DATABASE_URL?null:(await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url=process.env.DATABASE_URL??`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const root=new URL('../..',import.meta.url);

async function disposable() {
  const client=new pg.Client({connectionString:url});
  await client.connect();
  try {
    return (await client.query(`SELECT datname FROM pg_database WHERE datname LIKE 'stateplane\\_e2e\\_%'`)).rows.map(row=>row.datname);
  } finally { await client.end(); }
}

test('the e2e launcher drops its database when the UI process dies from a signal',{timeout:120_000},async()=>{
  const before=new Set(await disposable());
  const launcher=spawn(process.execPath,['test/e2e/host.js'],{cwd:root,stdio:'ignore',
    env:{...process.env,STATEPLANE_E2E_BASE_DATABASE:url}});
  const exited=once(launcher,'exit');
  let created;
  let ui;
  try {
    // Once the UI answers, migration has finished and the UI is the only child.
    for (let waited=0;!ui && waited<90_000;waited+=250) {
      await delay(250);
      created??=(await disposable()).find(name=>!before.has(name));
      if (created && (await fetch('http://127.0.0.1:5743/api/health').catch(()=>null))?.ok)
        ui=execFileSync('pgrep',['-P',String(launcher.pid)],{encoding:'utf8'}).trim();
    }
    assert.ok(created && ui,'the launcher created a database and started the UI');
    // A signalled child reports exitCode null; cleanup must still run.
    process.kill(Number(ui),'SIGKILL');
    const [code]=await Promise.race([exited,delay(30_000).then(()=>{ throw new Error('launcher did not exit'); })]);
    assert.equal(code,0);
    assert.ok(!(await disposable()).includes(created),'the disposable database is dropped');
  } finally { launcher.kill('SIGKILL'); }
});

test('the e2e launcher drops its database when its control port is taken',{timeout:120_000},async()=>{
  const before=new Set(await disposable());
  const taken=net.createServer().listen(5744,'127.0.0.1');
  await once(taken,'listening');
  try {
    const launcher=spawn(process.execPath,['test/e2e/host.js'],{cwd:root,stdio:'ignore',
      env:{...process.env,STATEPLANE_E2E_BASE_DATABASE:url}});
    const [code]=await Promise.race([once(launcher,'exit'),delay(90_000).then(()=>{ launcher.kill('SIGKILL'); throw new Error('launcher did not exit'); })]);
    assert.equal(code,1);
    assert.deepEqual((await disposable()).filter(name=>!before.has(name)),[],'no disposable database is left');
  } finally { taken.close(); }
});

test('the e2e launcher stopped during startup starts nothing and drops its database',{timeout:120_000},async()=>{
  const before=new Set(await disposable());
  const launcher=spawn(process.execPath,['test/e2e/host.js'],{cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,STATEPLANE_E2E_BASE_DATABASE:url,STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'}});
  let output='';
  for (const stream of [launcher.stdout,launcher.stderr]) stream.on('data',chunk=>{ output+=chunk; });
  const exited=once(launcher,'exit');
  try {
    let created;
    for (let waited=0;!created && waited<30_000;waited+=50) {
      await delay(50);
      created=(await disposable()).find(name=>!before.has(name));
    }
    assert.ok(created,'the launcher created a database');
    launcher.kill('SIGTERM');
    const [code]=await Promise.race([exited,delay(30_000).then(()=>{ throw new Error('launcher did not exit'); })]);
    assert.equal(code,0);
    assert.ok(!(await disposable()).includes(created),'the disposable database is dropped');
    // Startup ran no further step once shutdown began, so no migration or UI was started.
    assert.doesNotMatch(output,/Applied /);
    await delay(5_000);
    assert.equal(await fetch('http://127.0.0.1:5743/api/health').then(()=>'answered',()=>'refused'),'refused');
  } finally { launcher.kill('SIGKILL'); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { faultProxy, plaintext } from '../e2e/host.js';

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
const descendants=pid=>{
  let found='';
  try { found=execFileSync('pgrep',['-P',String(pid)],{encoding:'utf8'}); } catch { /* none */ }
  return found.split('\n').filter(Boolean).flatMap(child=>[...descendants(child),Number(child)]);
};
async function createdSince(before) {
  for (let waited=0;waited<30_000;waited+=50) {
    const created=(await disposable()).find(name=>!before.has(name));
    if (created) return created;
    await delay(50);
  }
}

/** Run one launcher. However the body ends, the launcher is stopped as
 * Playwright stops it; one that does not exit within `grace` is killed with its
 * children, and every database created since it started is dropped. */
async function launch(env,body,{grace=20_000,script='test/e2e/host.js',cwd=root}={}) {
  const before=new Set(await disposable());
  const launcher=spawn(process.execPath,[script],{cwd,stdio:['ignore','pipe','pipe'],
    env:{...process.env,STATEPLANE_E2E_BASE_DATABASE:url,...env}});
  let output='';
  for (const stream of [launcher.stdout,launcher.stderr]) stream.on('data',chunk=>{ output+=chunk; });
  const exited=once(launcher,'exit');
  const exit=async(ms=30_000)=>(await Promise.race([exited,delay(ms).then(()=>{ throw new Error('launcher did not exit'); })]))[0];
  try { return await body({launcher,before,exit,output:()=>output}); }
  finally {
    if (launcher.exitCode===null && launcher.signalCode===null) {
      launcher.kill('SIGTERM');
      if (!await Promise.race([exited.then(()=>true),delay(grace).then(()=>false)])) {
        for (const pid of descendants(launcher.pid)) process.kill(pid,'SIGKILL');
        launcher.kill('SIGKILL');
        await exited;
      }
    }
    const admin=new pg.Client({connectionString:url});
    await admin.connect();
    try { for (const name of (await disposable()).filter(name=>!before.has(name))) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}
const healthy=async()=>(await fetch('http://127.0.0.1:5743/api/health').catch(()=>null))?.ok===true;

test('the e2e launcher drops its database and fails when the UI process dies from a signal',{timeout:120_000},async()=>{
  await launch({},async({launcher,before,exit})=>{
    const created=await createdSince(before);
    // Once the UI answers, migration has finished and the UI is the only child.
    for (let waited=0;!await healthy() && waited<90_000;waited+=250) await delay(250);
    const ui=Number(execFileSync('pgrep',['-P',String(launcher.pid)],{encoding:'utf8'}).trim());
    assert.ok(created && ui,'the launcher created a database and started the UI');
    process.kill(ui,'SIGKILL');
    assert.equal(await exit(),1,'a UI that died on its own is a failed run');
    assert.ok(!(await disposable()).includes(created),'the disposable database is dropped');
  });
});

test('the e2e launcher fails with the UI exit status when the UI cannot start, and drops its database',{timeout:120_000},async()=>{
  const taken=net.createServer().listen(5743,'127.0.0.1');
  await once(taken,'listening');
  try {
    await launch({},async({before,exit,output})=>{
      const created=await createdSince(before);
      assert.equal(await exit(90_000),1,output());
      assert.ok(created && !(await disposable()).includes(created),'the disposable database is dropped');
    });
  } finally { taken.close(); }
});

test('the e2e launcher fails when the UI cannot be spawned',{timeout:60_000},async()=>{
  // A copy outside the checkout has no app directory to run the UI in.
  const copy=await mkdtemp(join(tmpdir(),'stateplane-launcher-'));
  try {
    await cp(fileURLToPath(new URL('test/e2e/host.js',root)),join(copy,'test/e2e/host.js'));
    await symlink(fileURLToPath(new URL('node_modules',root)),join(copy,'node_modules'));
    await launch({STATEPLANE_E2E_BASE_DATABASE:''},async({exit})=>assert.equal(await exit(),1),{cwd:copy});
  } finally { await rm(copy,{recursive:true,force:true}); }
});

test('the e2e launcher drops its database when its control port is taken',{timeout:120_000},async()=>{
  const taken=net.createServer().listen(5744,'127.0.0.1');
  await once(taken,'listening');
  try {
    await launch({},async({before,exit})=>{
      assert.equal(await exit(90_000),1);
      assert.deepEqual((await disposable()).filter(name=>!before.has(name)),[],'no disposable database is left');
    });
  } finally { taken.close(); }
});

test('the e2e launcher stopped during startup starts nothing and drops its database',{timeout:120_000},async()=>{
  await launch({STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,before,exit,output})=>{
    const created=await createdSince(before);
    assert.ok(created,'the launcher created a database');
    launcher.kill('SIGTERM');
    assert.equal(await exit(),0);
    assert.ok(!(await disposable()).includes(created),'the disposable database is dropped');
    // Startup ran no further step once shutdown began, so no migration or UI was started.
    assert.doesNotMatch(output(),/Applied /);
    await delay(5_000);
    assert.equal(await fetch('http://127.0.0.1:5743/api/health').then(()=>'answered',()=>'refused'),'refused');
  });
});

test('the e2e launcher reports a failed connection or DROP at shutdown instead of exiting cleanly',{timeout:120_000},async()=>{
  for (const failure of ['refuse DROP','close database']) {
    // The launcher reaches the database through this proxy, which fails its cleanup.
    const faults=[];
    const proxy=faultProxy(new URL(url),faults).listen(0,'127.0.0.1');
    await once(proxy,'listening');
    const proxied=new URL(url);
    proxied.port=String(proxy.address().port);
    try {
      await launch({STATEPLANE_E2E_BASE_DATABASE:proxied.href,STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,before,exit,output})=>{
        const created=await createdSince(before);
        if (failure==='refuse DROP') faults.push({match:'DROP DATABASE',after:null,refuse:true});
        else proxy.close();
        launcher.kill('SIGTERM');
        assert.equal(await exit(),1,failure);
        assert.match(output(),new RegExp(`e2e cleanup failed; drop database ${created} by hand`),failure);
      });
    } finally { proxy.close(); }
  }
});

test('a failed or stuck launcher test still kills the launcher and drops its database',{timeout:60_000},async()=>{
  let created;
  let pid;
  await assert.rejects(launch({STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,before})=>{
    created=await createdSince(before);
    pid=launcher.pid;
    // A stopped launcher cannot handle SIGTERM, so only the forced path can end it.
    process.kill(pid,'SIGSTOP');
    assert.fail('a failing assertion');
  },{grace:2_000}),/a failing assertion/);
  assert.ok(created && !(await disposable()).includes(created),'the disposable database is dropped');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('only a database reached without TLS goes through the fault proxy',()=>{
  const at=query=>new URL(`postgres://u:p@db.example.com:5432/stateplane${query}`);
  assert.equal(plaintext(at(''),{}),true);
  assert.equal(plaintext(at('?sslmode=disable&application_name=e2e'),{}),true);
  for (const query of ['?sslmode=verify-full','?sslmode=require','?ssl=true','?sslrootcert=/ca.pem','?sslnegotiation=direct'])
    assert.equal(plaintext(at(query),{}),false,query);
  assert.equal(plaintext(at(''),{PGSSLMODE:'verify-full'}),false);
});

test('a fault matches whole protocol messages however TCP splits its markers',{timeout:30_000},async()=>{
  const message=(type,text)=>{
    const body=Buffer.from(`${text}\0`,'latin1');
    const head=Buffer.alloc(5);
    head.write(type,'latin1');
    head.writeUInt32BE(body.length+4,1);
    return Buffer.concat([head,body]);
  };
  const startup=Buffer.alloc(8);
  startup.writeUInt32BE(8);
  startup.writeUInt32BE(196608,4);
  for (const refuse of [false,true]) {
    let received=Buffer.alloc(0);
    const upstream=net.createServer(socket=>socket.on('data',chunk=>{ received=Buffer.concat([received,chunk]); socket.write('R'); })).listen(0,'127.0.0.1');
    await once(upstream,'listening');
    const faults=[{match:'COMMIT\0',after:'INSERT INTO',refuse}];
    const proxy=faultProxy(new URL(`postgres://127.0.0.1:${upstream.address().port}/db`),faults).listen(0,'127.0.0.1');
    await once(proxy,'listening');
    try {
      const client=net.connect(proxy.address().port,'127.0.0.1').setNoDelay(true);
      client.on('error',()=>{});
      await once(client,'connect');
      let replies=0;
      client.on('data',chunk=>{ replies+=chunk.length; });
      const closed=once(client,'close');
      // A COMMIT before the INSERT is not the armed fault; the one after it is.
      const sent=[startup,message('Q','COMMIT'),message('Q','INSERT INTO t VALUES (1)'),message('Q','COMMIT')];
      for (const byte of Buffer.concat(sent)) {
        if (client.destroyed) break;
        client.write(Buffer.of(byte));
        await delay(1);
      }
      await Promise.race([closed,delay(5_000).then(()=>{ throw new Error('the proxy did not close the connection'); })]);
      assert.deepEqual(faults,[]);
      assert.ok(replies>0,'replies before the fault reach the client');
      assert.deepEqual(received,refuse ? Buffer.concat(sent.slice(0,3)) : Buffer.concat(sent),refuse ? 'refused before the database' : 'sent, then its reply dropped');
    } finally { proxy.close(); upstream.close(); }
  }
});

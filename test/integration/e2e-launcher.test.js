import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { endSession, faultProxy, plaintext, sessionOf } from '../e2e/host.js';

const password=process.env.DATABASE_URL?null:(await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const url=process.env.DATABASE_URL??`postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;
const root=new URL('../..',import.meta.url);

async function admin(sql,values) {
  const client=new pg.Client({connectionString:url,connectionTimeoutMillis:10_000,query_timeout:20_000});
  await client.connect();
  try { return (await client.query(sql,values)).rows; }
  finally { await client.end(); }
}
const exists=async name=>(await admin('SELECT 1 FROM pg_database WHERE datname=$1',[name])).length>0;
const descendants=pid=>{
  let found='';
  try { found=execFileSync('pgrep',['-P',String(pid)],{encoding:'utf8'}); } catch { /* none */ }
  return found.split('\n').filter(Boolean).flatMap(child=>[...descendants(child),Number(child)]);
};
async function created(name) {
  for (let waited=0;waited<30_000;waited+=50) {
    if (await exists(name)) return name;
    await delay(50);
  }
}

/** Run one launcher with a database name of its own. However the body ends, the
 * launcher is stopped as Playwright stops it; one that does not exit within
 * `grace` is killed with its children, and its database, and no other, is dropped.
 * A body still pending after `limit` fails, so a call that never answers cannot
 * skip that cleanup; the limit and grace fit within the test's own timeout. */
async function launch(env,body,{grace=20_000,limit=90_000,script='test/e2e/host.js',cwd=root}={}) {
  const id=randomUUID().replaceAll('-','');
  const name=`stateplane_e2e_${id}`;
  const launcher=spawn(process.execPath,[script],{cwd,stdio:['ignore','pipe','pipe'],
    env:{...process.env,STATEPLANE_E2E_BASE_DATABASE:url,STATEPLANE_E2E_TEST_DATABASE_ID:id,...env}});
  let output='';
  for (const stream of [launcher.stdout,launcher.stderr]) stream.on('data',chunk=>{ output+=chunk; });
  const exited=once(launcher,'exit');
  const exit=async(ms=30_000)=>(await Promise.race([exited,delay(ms).then(()=>{ throw new Error('launcher did not exit'); })]))[0];
  let timer;
  const expired=new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error(`the test body did not finish in ${limit} ms`)),limit); });
  try { return await Promise.race([body({launcher,name,exit,output:()=>output}),expired]); }
  finally {
    clearTimeout(timer);
    if (launcher.exitCode===null && launcher.signalCode===null) {
      launcher.kill('SIGTERM');
      if (!await Promise.race([exited.then(()=>true),delay(grace).then(()=>false)])) {
        for (const pid of descendants(launcher.pid)) process.kill(pid,'SIGKILL');
        launcher.kill('SIGKILL');
        await exited;
      }
    }
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}
const healthy=async()=>(await fetch('http://127.0.0.1:5743/api/health').catch(()=>null))?.ok===true;

test('the e2e launcher drops its database and fails when the UI process dies from a signal',{timeout:120_000},async()=>{
  await launch({},async({launcher,name,exit})=>{
    const database=await created(name);
    // Once the UI answers, migration has finished and the UI is the only child.
    for (let waited=0;!await healthy() && waited<90_000;waited+=250) await delay(250);
    const ui=Number(execFileSync('pgrep',['-P',String(launcher.pid)],{encoding:'utf8'}).trim());
    assert.ok(database && ui,'the launcher created a database and started the UI');
    process.kill(ui,'SIGKILL');
    assert.equal(await exit(),1,'a UI that died on its own is a failed run');
    assert.ok(!await exists(name),'the disposable database is dropped');
  });
});

test('the e2e launcher fails with the UI exit status when the UI cannot start, and drops its database',{timeout:120_000},async()=>{
  const taken=net.createServer().listen(5743,'127.0.0.1');
  await once(taken,'listening');
  try {
    await launch({},async({name,exit,output})=>{
      const database=await created(name);
      assert.equal(await exit(90_000),1,output());
      assert.ok(database && !await exists(name),'the disposable database is dropped');
    });
  } finally { taken.close(); }
});

test('the e2e launcher fails when the UI cannot be spawned',{timeout:60_000},async()=>{
  // A copy outside the checkout has no app directory to run the UI in.
  const copy=await mkdtemp(join(tmpdir(),'stateplane-launcher-'));
  try {
    await cp(fileURLToPath(new URL('test/e2e/host.js',root)),join(copy,'test/e2e/host.js'));
    await symlink(fileURLToPath(new URL('node_modules',root)),join(copy,'node_modules'));
    await launch({STATEPLANE_E2E_BASE_DATABASE:''},async({exit})=>assert.equal(await exit(),1),{cwd:copy,limit:30_000});
  } finally { await rm(copy,{recursive:true,force:true}); }
});

test('the e2e launcher drops its database when its control port is taken',{timeout:120_000},async()=>{
  const taken=net.createServer().listen(5744,'127.0.0.1');
  await once(taken,'listening');
  try {
    await launch({},async({name,exit})=>{
      assert.equal(await exit(90_000),1);
      assert.equal(await exists(name),false,'no disposable database is left');
    });
  } finally { taken.close(); }
});

test('the e2e launcher stopped during startup starts nothing and drops its database',{timeout:120_000},async()=>{
  await launch({STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,name,exit,output})=>{
    assert.ok(await created(name),'the launcher created a database');
    launcher.kill('SIGTERM');
    assert.equal(await exit(),0);
    assert.ok(!await exists(name),'the disposable database is dropped');
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
      await launch({STATEPLANE_E2E_BASE_DATABASE:proxied.href,STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,name,exit,output})=>{
        await created(name);
        if (failure==='refuse DROP') faults.push({match:'DROP DATABASE',after:null,refuse:true});
        else proxy.close();
        launcher.kill('SIGTERM');
        assert.equal(await exit(),1,failure);
        assert.match(output(),new RegExp(`e2e cleanup failed; drop database ${name} by hand`),failure);
      });
    } finally { proxy.close(); }
  }
});

test('the e2e launcher drops a database whose CREATE acknowledgement was lost or ended in a FATAL, or names it for a manual drop',{timeout:240_000},async()=>{
  for (const [reply,dropRefused] of [['lost',false],['lost',true],['FATAL',false],['FATAL',true]]) {
    // After Postgres created the database, the reply to CREATE DATABASE is lost,
    // or the server ends the session with a FATAL error instead.
    const faults=[{match:'CREATE DATABASE',after:null,refuse:false,fatal:reply==='FATAL'},...dropRefused ? [{match:'DROP DATABASE',after:null,refuse:true}] : []];
    const proxy=faultProxy(new URL(url),faults).listen(0,'127.0.0.1');
    await once(proxy,'listening');
    const proxied=new URL(url);
    proxied.port=String(proxy.address().port);
    try {
      await launch({STATEPLANE_E2E_BASE_DATABASE:proxied.href},async({name,exit,output})=>{
        assert.equal(await exit(),1,output());
        assert.deepEqual(faults,[]);
        if (reply==='FATAL') assert.match(output(),/idle-session timeout/);
        if (dropRefused) {
          assert.match(output(),new RegExp(`e2e cleanup failed; drop database ${name} by hand`));
          assert.equal(await exists(name),true,'the database was created');
        } else assert.equal(await exists(name),false,'the database is dropped');
      });
    } finally { proxy.close(); }
  }
});

test('the e2e launcher stopped while a reply stalls exits within Playwright\'s 15 s, dropping its database or naming it',{timeout:180_000},async()=>{
  for (const stall of ['CREATE','CREATE and DROP','CREATE and DROP, then a second signal']) {
    // Postgres acts on each held message, but its reply never arrives and no socket closes.
    const faults=[{match:'CREATE DATABASE',hold:true},...stall==='CREATE' ? [] : [{match:'DROP DATABASE',hold:true}]];
    const proxy=faultProxy(new URL(url),faults).listen(0,'127.0.0.1');
    await once(proxy,'listening');
    const proxied=new URL(url);
    proxied.port=String(proxy.address().port);
    try {
      await launch({STATEPLANE_E2E_BASE_DATABASE:proxied.href},async({launcher,name,exit,output})=>{
        assert.ok(await created(name),'Postgres created the database');
        const stopped=Date.now();
        launcher.kill('SIGTERM');
        if (stall.endsWith('second signal')) { await delay(4_000); launcher.kill('SIGTERM'); }
        assert.equal(await exit(15_000),1,output());
        assert.ok(Date.now()-stopped<(stall.endsWith('second signal') ? 10_000 : 15_000),stall);
        if (stall==='CREATE') assert.equal(await exists(name),false,'the database is dropped');
        else assert.match(output(),new RegExp(`e2e cleanup failed; drop database ${name} by hand`),stall);
      });
    } finally { proxy.close(); }
  }
});

test('the e2e launcher refused CREATE DATABASE for an existing name keeps that database',{timeout:60_000},async()=>{
  // Another run's database already has this launcher's name.
  const id=randomUUID().replaceAll('-','');
  const existing=`stateplane_e2e_${id}`;
  await admin(`CREATE DATABASE ${existing}`);
  try {
    await launch({STATEPLANE_E2E_TEST_DATABASE_ID:id},async({exit,output})=>{
      assert.equal(await exit(),1,output());
      assert.match(output(),/already exists/);
      assert.doesNotMatch(output(),/drop database/);
    },{limit:30_000});
    assert.equal(await exists(existing),true,'the existing database is kept');
  } finally { await admin(`DROP DATABASE IF EXISTS ${existing} WITH (FORCE)`); }
});

test('the launcher ends only the session that ran its CREATE, not a later one with the same pid',{timeout:30_000},async()=>{
  const client=new pg.Client({connectionString:url});
  client.on('error',()=>{});
  await client.connect();
  const control=new pg.Client({connectionString:url});
  await control.connect();
  try {
    const session=await sessionOf(client);
    // The CREATE's session ended and a later session reused its pid.
    assert.equal(await endSession(control,{pid:session.pid,started:String(Number(session.started)-60)}),true);
    assert.deepEqual((await client.query('SELECT 1 AS alive')).rows,[{alive:1}],'the later session is untouched');
    assert.equal(await endSession(control,session),true);
    await assert.rejects(client.query('SELECT 1'),'the CREATE session is ended');
    assert.equal((await control.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[session.pid])).rows[0].n,0);
  } finally { await control.end(); await client.end().catch(()=>{}); }
});

test('a launcher test drops only its own database',{timeout:60_000},async()=>{
  const foreign=`stateplane_e2e_${randomUUID().replaceAll('-','')}`;
  try {
    await launch({STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({name})=>{
      assert.ok(await created(name));
      // Another run's database appears while this launcher runs.
      await admin(`CREATE DATABASE ${foreign}`);
    },{limit:30_000});
    assert.equal(await exists(foreign),true,'the other run keeps its database');
  } finally { await admin(`DROP DATABASE IF EXISTS ${foreign} WITH (FORCE)`); }
});

test('a failed, stuck or never-finishing launcher test still kills the launcher and drops its database',{timeout:90_000},async()=>{
  for (const ending of ['fails','never finishes']) {
    let database;
    let pid;
    await assert.rejects(launch({STATEPLANE_E2E_TEST_STARTUP_DELAY_MS:'60000'},async({launcher,name})=>{
      database=await created(name);
      pid=launcher.pid;
      // A stopped launcher cannot handle SIGTERM, so only the forced path can end it.
      process.kill(pid,'SIGSTOP');
      if (ending==='fails') assert.fail('a failing assertion');
      // A database call or fetch that never answers.
      await new Promise(()=>{});
    },{grace:2_000,limit:10_000}),ending==='fails' ? /a failing assertion/ : /did not finish in 10000 ms/);
    assert.ok(database && !await exists(database),`${ending}: the disposable database is dropped`);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},ending);
  }
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

test('the fault proxy reaches a database at an IPv6 address',{timeout:30_000},async t=>{
  const upstream=net.createServer(socket=>socket.write('ok'));
  try {
    upstream.listen(0,'::1');
    await once(upstream,'listening');
  } catch { return t.skip('no IPv6 loopback'); }
  const proxy=faultProxy(new URL(`postgres://[::1]:${upstream.address().port}/db`),[]).listen(0,'127.0.0.1');
  await once(proxy,'listening');
  try {
    const client=net.connect(proxy.address().port,'127.0.0.1');
    client.on('error',()=>{});
    const reply=await Promise.race([once(client,'data').then(([chunk])=>String(chunk)),once(client,'close').then(()=>'closed')]);
    client.destroy();
    assert.equal(reply,'ok');
  } finally { proxy.close(); upstream.close(); }
});

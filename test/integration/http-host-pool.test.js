import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const password=process.env.DATABASE_URL?null:
  (await readFile(new URL('../../.data/local-db-password',import.meta.url),'utf8')).trim();
const databaseUrl=process.env.DATABASE_URL??
  `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT??'55432'}/stateplane`;

test('rotating the opt-in HTTP fixture ends retired pools after in-flight requests',async()=>{
  const previous=process.cwd();
  process.chdir(new URL('../../app/',import.meta.url).pathname);
  const {createServer}=await import('../../app/node_modules/vite/dist/node/index.js');
  const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
  const admin=new pg.Client({connectionString:databaseUrl});
  const blocker=new pg.Client({connectionString:databaseUrl});
  let blocked=false;
  try {
    await admin.connect();
    await blocker.connect();
    const route=await vite.ssrLoadModule('/src/routes/v1/[...path]/+server.ts');
    const url=new URL(databaseUrl);
    url.searchParams.set('application_name','sta9_http_pool_rotation');
    const count=async()=>Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='sta9_http_pool_rotation'`)).rows[0].n);
    const waitForCount=async expected=>{
      for (let attempt=0;attempt<100;attempt++) {
        if (await count()===expected) return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(await count(),expected);
    };
    const request=async(index)=>{
      const token=String(index).repeat(32);
      const env={STATEPLANE_ENV:'local',STATEPLANE_TEST_HTTP:'1',STATEPLANE_TEST_DATABASE_URL:url.href,
        STATEPLANE_TEST_TOKEN:token,STATEPLANE_TEST_OWNER:'owner',STATEPLANE_TEST_CREDENTIAL:'session',
        STATEPLANE_TEST_CURSOR_SECRET:'a'.repeat(64)};
      const result=await route.GET({request:new Request('http://localhost/v1/spaces',{
        headers:{Authorization:`Bearer ${token}`}}),platform:{env}});
      assert.equal(result.status,200);
    };
    await request(1);
    await waitForCount(1);
    for (const index of [2,3,4]) {
      await request(index);
      await waitForCount(1);
    }
    await blocker.query('BEGIN');blocked=true;
    await blocker.query('LOCK TABLE space_directory IN ACCESS EXCLUSIVE MODE');
    const inFlight=request(5);
    let waiting=false;
    for (let attempt=0;attempt<100;attempt++) {
      const active=await admin.query(`SELECT 1 FROM pg_stat_activity WHERE application_name='sta9_http_pool_rotation'
        AND wait_event_type='Lock'`);
      if (active.rowCount) {waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(waiting,true);
    const replacement=request(6);
    let overlap=false;
    for (let attempt=0;attempt<100;attempt++) {
      if (await count()===2) {overlap=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(overlap,true,'retired pool remains open while its request is active');
    await blocker.query('ROLLBACK');blocked=false;
    await Promise.all([inFlight,replacement]);
    await waitForCount(1);
    // Disable the fixture to close the last cached pool as well.
    await route.GET({request:new Request('http://localhost/v1/spaces'),platform:{env:{}}});
    await waitForCount(0);
    const hyperdriveUrl=new URL(databaseUrl);
    hyperdriveUrl.searchParams.set('application_name','sta9_hyperdrive_request');
    const hyperdriveCount=async()=>Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='sta9_hyperdrive_request'`)).rows[0].n);
    const token='H'.repeat(32);
    const previewEnv={STATEPLANE_ENV:'preview',STATEPLANE_TEST_HTTP:'1',
      AUTHORITY:{connectionString:hyperdriveUrl.href},STATEPLANE_TEST_TOKEN:token,
      STATEPLANE_TEST_OWNER:'owner',STATEPLANE_TEST_CREDENTIAL:'session',
      STATEPLANE_TEST_CURSOR_SECRET:'A'.repeat(64)};
    for (let attempt=0;attempt<2;attempt++) {
      const response=await route.GET({request:new Request('http://localhost/v1/spaces',{
        headers:{Authorization:`Bearer ${token}`}}),platform:{env:previewEnv}});
      assert.equal(response.status,200,'Preview accepts uppercase hex and consecutive requests');
      assert.equal(await hyperdriveCount(),0,'the Hyperdrive pool ends with its request');
    }
  } finally {
    if (blocked) await blocker.query('ROLLBACK').catch(()=>{});
    await blocker.end().catch(()=>{});
    await admin.end().catch(()=>{});
    await vite.close();
    process.chdir(previous);
  }
});

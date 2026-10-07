import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('event-feed grants reject an external admin URL without verified TLS before connecting',()=>{
  const result=spawnSync(process.execPath,['scripts/grant-event-feed.mjs'],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,STATEPLANE_CELL_ADMIN_URL:'postgres://admin:private-fixture@db.example.invalid/stateplane',
      STATEPLANE_CELL_ROLE:'cell_reader'}
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/External DATABASE_URL requires sslmode=verify-full/);
  assert.doesNotMatch(result.stdout+result.stderr,/private-fixture/);
});

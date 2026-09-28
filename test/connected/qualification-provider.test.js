import test from 'node:test';
import assert from 'node:assert/strict';
import { readRailwayQualification } from '../../scripts/qualification-target.mjs';

test('actual connected Railway query returns the target service, volume mount and deployment', { timeout: 25_000 }, async () => {
  const inventory = {
    serviceId: process.env.STATEPLANE_RAILWAY_TEST_SERVICE_ID,
    environmentId: process.env.STATEPLANE_RAILWAY_TEST_ENVIRONMENT_ID,
    volumeInstanceId: process.env.STATEPLANE_RAILWAY_TEST_VOLUME_INSTANCE_ID
  };
  for (const [key, value] of Object.entries(inventory)) assert.ok(value, `Missing ${key}`);
  assert.ok(process.env.STATEPLANE_RAILWAY_ACCOUNT, 'Missing connected Railway account');
  const data = await readRailwayQualification(inventory);
  assert.equal(data.service?.id?.toLowerCase(), inventory.serviceId.toLowerCase());
  assert.equal(data.volumeInstance?.id?.toLowerCase(), inventory.volumeInstanceId.toLowerCase());
  assert.ok(data.volumeInstance?.mountPath?.startsWith('/'));
  assert.equal(data.serviceInstance?.latestDeployment?.status, 'SUCCESS');
});

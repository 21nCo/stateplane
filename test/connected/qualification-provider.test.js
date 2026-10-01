import test from 'node:test';
import assert from 'node:assert/strict';
import { readRailwayQualification } from '../../scripts/qualification-target.mjs';

test('actual connected Railway query returns the target service, volume mount and deployment', { timeout: 25_000 }, async () => {
  const inventory = {
    serviceId: process.env.STATEPLANE_RAILWAY_TEST_SERVICE_ID,
    environmentId: process.env.STATEPLANE_RAILWAY_TEST_ENVIRONMENT_ID,
    volumeInstanceId: process.env.STATEPLANE_RAILWAY_TEST_VOLUME_INSTANCE_ID
  };
  const expectedRegion = process.env.STATEPLANE_RAILWAY_TEST_REGION;
  for (const [key, value] of Object.entries(inventory)) assert.ok(value, `Missing ${key}`);
  assert.ok(process.env.STATEPLANE_RAILWAY_ACCOUNT, 'Missing connected Railway account');
  assert.ok(expectedRegion, 'Missing expected Railway region');
  const data = await readRailwayQualification(inventory);
  assert.equal(data.service?.id?.toLowerCase(), inventory.serviceId.toLowerCase());
  assert.equal(data.service?.deletedAt, null);
  assert.equal(data.serviceInstance?.serviceId?.toLowerCase(), inventory.serviceId.toLowerCase());
  assert.equal(data.serviceInstance?.environmentId?.toLowerCase(), inventory.environmentId.toLowerCase());
  assert.equal(data.serviceInstance?.region, expectedRegion);
  assert.equal(data.serviceInstance?.deletedAt, null);
  assert.equal(data.volumeInstance?.id?.toLowerCase(), inventory.volumeInstanceId.toLowerCase());
  assert.equal(data.volumeInstance?.serviceId?.toLowerCase(), inventory.serviceId.toLowerCase());
  assert.equal(data.volumeInstance?.environmentId?.toLowerCase(), inventory.environmentId.toLowerCase());
  assert.equal(data.volumeInstance?.region, expectedRegion);
  assert.equal(data.volumeInstance?.deletedAt, null);
  assert.equal(data.volumeInstance?.isPendingDeletion, false);
  assert.ok(data.volumeInstance?.mountPath?.startsWith('/'));
  assert.equal(data.serviceInstance?.latestDeployment?.status, 'SUCCESS');
  assert.equal(data.serviceInstance?.source?.repo, null);
  assert.ok(data.serviceInstance?.source?.image);
  assert.equal(data.serviceInstance?.latestDeployment?.meta?.image, data.serviceInstance.source.image);
  assert.match(data.serviceInstance?.latestDeployment?.meta?.imageDigest ?? '', /^sha256:[a-f0-9]{64}$/i);
});

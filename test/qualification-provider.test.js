import test from 'node:test';
import assert from 'node:assert/strict';
import { readRailwayQualification } from '../scripts/qualification-target.mjs';

test('connected Railway readback rejects every GraphQL error and bounds a hung child', async () => {
  const previous = process.env.STATEPLANE_RAILWAY_ACCOUNT;
  process.env.STATEPLANE_RAILWAY_ACCOUNT = 'test-account';
  try {
    const inventory = { serviceId: 'service', environmentId: 'environment', volumeInstanceId: 'volume' };
    const run = async (command, args, options) => {
      assert.equal(command, 'composio');
      assert.match(args.join(' '), /mountPath/);
      assert.equal(options.timeout, 15_000);
      assert.equal(options.killSignal, 'SIGKILL');
      return { stdout: JSON.stringify({ data: { service: { id: 'service' } }, errors: [{ message: 'partial failure' }] }) };
    };
    await assert.rejects(readRailwayQualification(inventory, undefined, run), /readback failed/);
    await assert.rejects(readRailwayQualification(inventory, undefined,
      async () => ({ stdout: '{"data":null,"errors":[]}' })), /readback failed/);
    assert.deepEqual(await readRailwayQualification(inventory, undefined,
      async () => ({ stdout: '{"data":{"service":{"id":"service"}}}' })), { service: { id: 'service' } });
  } finally {
    if (previous === undefined) delete process.env.STATEPLANE_RAILWAY_ACCOUNT;
    else process.env.STATEPLANE_RAILWAY_ACCOUNT = previous;
  }
});

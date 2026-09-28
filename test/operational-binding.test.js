import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyOperationalBinding } from '../scripts/operational-binding.mjs';

const head = 'a'.repeat(40);
const resource = { hyperdriveId: 'b'.repeat(32), databaseRole: 'cell_reader' };
const database = 'stateplane_dev_ap_southeast';

function harness(response) {
  const calls = [];
  let config;
  let secret;
  let requests = 0;
  return {
    calls,
    get config() { return config; },
    get secret() { return secret; },
    get requests() { return requests; },
    dependencies: {
      token: 'private-test-token', getHead: async () => head,
      runWrangler: async args => {
        calls.push(args);
        const path = args[args.indexOf('--config') + 1];
        if (args[1] === 'delete') return '{}';
        if (args[1] === 'secret') return JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }]);
        config = JSON.parse(await readFile(path, 'utf8'));
        secret = JSON.parse(await readFile(args[args.indexOf('--secrets-file') + 1], 'utf8'));
        return JSON.stringify({ preview_urls: ['https://operational.example.workers.dev/'] });
      },
      request: async (url, init) => {
        requests++;
        assert.equal(url, 'https://operational.example.workers.dev/verify');
        assert.equal(init.headers.authorization, 'Bearer private-test-token');
        assert.equal(init.redirect, 'error');
        return response;
      }
    }
  };
}

test('each operational binding is proved through its exact Hyperdrive ID and Worker SQL identity', async () => {
  for (const [environment, label] of [
    ['development', 'control'], ['development', 'ap-southeast'],
    ['development', 'us-east'], ['development', 'eu-west'],
    ['production', 'control'], ['production', 'ap-southeast'], ['production', 'us-east']
  ]) {
    const h = harness({ ok: true, json: async () => ({ ok: true, database, role: resource.databaseRole, pgvector: true }) });
    const evidence = await verifyOperationalBinding(environment, label, resource, database, h.dependencies);
    assert.equal(evidence.hyperdriveId, resource.hyperdriveId);
    assert.equal(h.config.hyperdrive[0].id, resource.hyperdriveId);
    assert.deepEqual(h.config.previews.hyperdrive, h.config.hyperdrive);
    assert.equal(h.config.vars.STATEPLANE_PROBE_DATABASE, database);
    assert.equal(h.config.vars.STATEPLANE_PROBE_ROLE, resource.databaseRole);
    assert.deepEqual(h.secret, { PROBE_TOKEN: 'private-test-token' });
    assert.equal(JSON.stringify(h.config).includes('private-test-token'), false);
    assert.equal(h.requests, 1);
    assert.equal(h.calls.at(-1)[1], 'delete');
  }
});

test('provider SQL proof cannot mask broken operational Hyperdrive credentials', async () => {
  const h = harness({ ok: false, status: 500 });
  await assert.rejects(verifyOperationalBinding('development', 'control', resource, database, h.dependencies),
    /operational Hyperdrive Worker proof failed/);
  assert.equal(h.requests, 1);
  assert.equal(h.calls.at(-1)[1], 'delete');
});

test('wrong Worker database or role fails even when Preview returns HTTP 200', async () => {
  for (const body of [
    { ok: true, database: 'other', role: resource.databaseRole, pgvector: true },
    { ok: true, database, role: 'other', pgvector: true },
    { ok: true, database, role: resource.databaseRole, pgvector: false }
  ]) {
    const h = harness({ ok: true, json: async () => body });
    await assert.rejects(verifyOperationalBinding('development', 'control', resource, database, h.dependencies),
      /operational Hyperdrive Worker proof failed/);
    assert.equal(h.calls.at(-1)[1], 'delete');
  }
});

test('failed operational Preview deletion blocks an otherwise successful proof', async () => {
  const h = harness({ ok: true, json: async () => ({ ok: true, database, role: resource.databaseRole, pgvector: true }) });
  const normal = h.dependencies.runWrangler;
  h.dependencies.runWrangler = async args => {
    if (args[1] === 'delete') throw new Error('delete failed');
    return normal(args);
  };
  await assert.rejects(verifyOperationalBinding('development', 'control', resource, database, h.dependencies),
    /operational Preview cleanup failed/);
  assert.equal(h.requests, 1);
});

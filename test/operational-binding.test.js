import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyOperationalBinding } from '../scripts/operational-binding.mjs';
import { previewName } from '../scripts/preview-name.mjs';

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
    assert.equal(h.config.workers_dev, false);
    assert.equal(h.config.preview_urls, true);
    assert.ok(`${previewName(h.config.name)}-${h.config.name}`.length <= 63);
    for (const args of h.calls) assert.equal(args[args.indexOf('--name') + 1], previewName(h.config.name));
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

test('invalid token, target and configuration fail before deployment or verification request', async () => {
  for (const [environment, label, resourceValue, databaseValue, token] of [
    ['development', 'control', resource, database, ''],
    ['development', 'control', resource, database, 'bad\ntoken'],
    ['production', 'eu-west', resource, database, 'private-test-token'],
    ['development', 'control', { ...resource, hyperdriveId: 'bad' }, database, 'private-test-token'],
    ['development', 'control', resource, 'bad-database', 'private-test-token']
  ]) {
    const h = harness({ ok: true });
    await assert.rejects(verifyOperationalBinding(environment, label, resourceValue, databaseValue,
      { ...h.dependencies, token }), /Invalid operational binding probe/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.requests, 0);
  }
});

test('invalid Preview URL and missing secret readback prevent token-bearing verification and still delete Preview', async () => {
  for (const mode of ['url', 'ambiguous-url', 'secret']) {
    const h = harness({ ok: true });
    const normal = h.dependencies.runWrangler;
    h.dependencies.runWrangler = async args => {
      if (mode === 'url' && args[1] !== 'delete' && args[1] !== 'secret') {
        h.calls.push(args);
        return JSON.stringify({ preview_urls: ['http://untrusted.example/'] });
      }
      if (mode === 'ambiguous-url' && args[1] !== 'delete' && args[1] !== 'secret') {
        h.calls.push(args);
        return JSON.stringify({ preview_urls: ['https://one.example/', 'https://two.example/'] });
      }
      if (mode === 'secret' && args[1] === 'secret') {
        h.calls.push(args);
        return JSON.stringify([]);
      }
      return normal(args);
    };
    await assert.rejects(verifyOperationalBinding('development', 'control', resource, database, h.dependencies),
      /operational Hyperdrive Worker proof failed/);
    assert.equal(h.requests, 0);
    assert.equal(h.calls.at(-1)[1], 'delete');
  }
});

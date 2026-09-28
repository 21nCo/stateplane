import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runLoad } from '../scripts/qualification-load.mjs';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/qualification-load.mjs');
const name = `s4-${'a'.repeat(40)}-d-apse`;
const base = 'https://preview.example.workers.dev';
const url = `${base}/qualify`;
const deployPreview = async () => [base];
const result = observedConnections => ({ ok: true, json: async () => ({ ok: true, rollback: true, freshRead: true,
  observedConnections, maxConnections: 20, reservedConnections: 2, elapsedMs: observedConnections }) });
const residualResult = () => ({ ok: true, json: async () => ({ ok: true, residualRows: 0 }) });
const options = request => ({ token: 'test-only-token', deployPreview,
  request: (target, init) => target.endsWith('/residual') ? residualResult() : request(target, init) });

test('concurrent load rejects headroom consumed by other sessions and reserved slots', async () => {
  const request = async () => result(16);
  await assert.rejects(runLoad(name, url, 2, 5, options(request)), /Origin connection headroom below 5/);
  assert.deepEqual(await runLoad(name, undefined, 2, 2, options(request)), {
    previewName: name, previewUrl: url, requests: 2, success: 2, residualRows: 0, peakObservedConnections: 16,
    minMaxConnections: 20, maxReservedConnections: 2, minimumHeadroom: 2, maxElapsedMs: 16
  });
});

test('load rejects impossible counts and uses the worst reading across requests', async () => {
  let call = 0;
  const varied = async () => result([2, 16, 4][call++ % 3]);
  await assert.rejects(runLoad(name, url, 3, 3, options(varied)), /Origin connection headroom below 3/);
  call = 0;
  assert.equal((await runLoad(name, url, 3, 2, options(varied))).peakObservedConnections, 16);
  call = 0;
  const impossible = async () => result(call++ === 2 ? 1 : 2);
  await assert.rejects(runLoad(name, url, 3, 2, options(impossible)), /1\/3 concurrent qualification requests failed/);
});

test('first probe completes table bootstrap before concurrent load', async () => {
  let initialized = false;
  let creating = false;
  const request = async () => {
    if (!initialized) {
      if (creating) throw new Error('catalog uniqueness race');
      creating = true;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
      initialized = true;
      creating = false;
    }
    return result(2);
  };
  assert.equal((await runLoad(name, url, 3, 5, options(request))).success, 3);
});

test('final read detects an orphan from an earlier interrupted probe after clean concurrent probes', async () => {
  let completed = 0;
  const request = async target => {
    if (target.endsWith('/residual')) {
      assert.equal(completed, 3);
      return { ok: true, json: async () => ({ ok: true, residualRows: 1 }) };
    }
    completed++;
    return result(2);
  };
  await assert.rejects(runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request }), /Final residual readback failed/);
});

test('final read runs after failed concurrent requests settle and read failure keeps the load failed', async () => {
  let active = 0;
  let checked = false;
  let calls = 0;
  const request = async target => {
    if (target.endsWith('/residual')) {
      assert.equal(active, 0);
      checked = true;
      throw new Error('database read unavailable');
    }
    const call = calls++;
    if (call === 0) return result(2);
    active++;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    active--;
    if (call === 2) throw new Error('concurrent probe failed');
    return result(2);
  };
  await assert.rejects(runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request }),
    /1\/2 concurrent qualification requests failed; Final residual readback failed/);
  assert.equal(checked, true);
});

test('interrupted concurrent load still attempts the final read and cannot pass', async () => {
  const controller = new AbortController();
  let probes = 0;
  let residualReads = 0;
  const request = async target => {
    if (target.endsWith('/residual')) {
      residualReads++;
      return residualResult();
    }
    probes++;
    if (probes === 2) controller.abort();
    return result(2);
  };
  await assert.rejects(runLoad(name, url, 2, 5, {
    token: 'test-only-token', deployPreview, request, signal: controller.signal
  }), /Qualification load interrupted/);
  assert.equal(residualReads, 1);
});

test('mismatched host and URL suffix are rejected before the token is sent', async () => {
  let requests = 0;
  const request = async () => { requests++; return result(2); };
  for (const wrong of ['https://other.example/qualify', `${url}?redirect=other`, `${base}/other`,
    'https://preview.example.workers.dev.evil.example/qualify']) {
    await assert.rejects(runLoad(name, wrong, 2, 5, options(request)), /does not match the named Preview/);
  }
  assert.equal(requests, 0);
});

test('probe forbids redirects and cancelled Preview setup sends no request', async () => {
  let requests = 0;
  const request = async (target, init) => {
    assert.ok([url, `${url}/residual`].includes(target));
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer test-only-token');
    requests++;
    return target.endsWith('/residual') ? residualResult() : result(2);
  };
  assert.equal((await runLoad(name, undefined, 2, 5, { token: 'test-only-token', deployPreview, request })).success, 2);
  const controller = new AbortController();
  await assert.rejects(runLoad(name, undefined, 2, 5, {
    token: 'test-only-token', signal: controller.signal,
    deployPreview: async () => { controller.abort(); return [base]; }, request
  }), /Qualification load interrupted/);
  assert.equal(requests, 4);
});

test('CLI rejects a bare HTTPS destination before sending PROBE_TOKEN', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-load-target-'));
  const mock = join(directory, 'fetch.mjs');
  const marker = join(directory, 'sent');
  try {
    await writeFile(mock, `import { writeFileSync } from 'node:fs';
globalThis.fetch = async () => {
  writeFileSync(process.env.PROBE_SENT_MARKER, 'sent');
  return { ok: true, json: async () => ({ ok: true, rollback: true, freshRead: true,
    observedConnections: 2, maxConnections: 20, reservedConnections: 2, elapsedMs: 1 }) };
};`);
    const env = { ...process.env, PROBE_TOKEN: 'test-only-token', PROBE_SENT_MARKER: marker,
      NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` };
    await assert.rejects(run(process.execPath, [script, 'https://attacker.example/qualify', '2', '5'], { env }),
      /Invalid qualification load arguments/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

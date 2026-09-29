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
const startResult = () => ({ ok: true, json: async () => ({ ok: true, started: true }) });
const options = request => ({ token: 'test-only-token', deployPreview,
  request: (target, init) => target.endsWith('/start') ? startResult() : target.endsWith('/residual') ? residualResult() : request(target, init) });

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

test('failed first probe checks table-wide residuals before reporting its failure', async () => {
  let probes = 0;
  let residualReads = 0;
  const request = async target => {
    if (target.endsWith('/start')) return startResult();
    if (target.endsWith('/residual')) {
      residualReads++;
      return { ok: true, json: async () => ({ ok: true, residualRows: 1 }) };
    }
    probes++;
    // The Worker can commit an insert and then fail before returning its result.
    throw new Error('response lost after insert');
  };
  await assert.rejects(runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request }),
    /First qualification request failed; Final residual readback failed/);
  assert.equal(probes, 1, 'concurrent load must not run before bootstrap succeeds');
  assert.equal(residualReads, 1, 'post-commit failure still requires table-wide cleanup evidence');
});

test('unconfirmed attempt start never probes and cannot pass a clean residual read', async () => {
  let probes = 0;
  let residualReads = 0;
  const request = async target => {
    if (target.endsWith('/start')) throw new Error('start response lost');
    if (target.endsWith('/residual')) { residualReads++; return residualResult(); }
    probes++;
    return result(2);
  };
  await assert.rejects(runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request }),
    /Qualification attempt start failed; Qualification attempt was not confirmed/);
  assert.equal(probes, 0);
  assert.equal(residualReads, 1);
});

test('falsy first-probe rejection cannot start concurrent probes or pass cleanup', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    let probes = 0;
    let residualReads = 0;
    const request = async target => {
      if (target.endsWith('/start')) return startResult();
      if (target.endsWith('/residual')) {
        residualReads++;
        return residualResult();
      }
      probes++;
      throw reason;
    };
    await assert.rejects(runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request }),
      /First qualification request failed/);
    assert.equal(probes, 1, 'a failed bootstrap must not start concurrent probes');
    assert.equal(residualReads, 1, 'a failed bootstrap still needs the final residual read');
  }
});

test('final read detects an orphan from an earlier interrupted probe after clean concurrent probes', async () => {
  let probes = 0;
  let completed = 0;
  let residualReads = 0;
  let releasePending;
  let pendingStarted;
  const pending = new Promise(resolvePending => { releasePending = resolvePending; });
  const started = new Promise(resolveStarted => { pendingStarted = resolveStarted; });
  const request = async target => {
    if (target.endsWith('/start')) return startResult();
    if (target.endsWith('/residual')) {
      residualReads++;
      return { ok: true, json: async () => ({ ok: true, residualRows: 1 }) };
    }
    const probe = probes++;
    if (probe === 1) {
      pendingStarted();
      await pending;
    }
    completed++;
    return result(2);
  };
  const load = runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request });
  const rejection = assert.rejects(load, /Final residual readback failed/);
  try {
    await started;
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    assert.equal(probes, 3);
    assert.equal(completed, 2);
    assert.equal(residualReads, 0, 'final read must wait for the pending probe');
  } finally {
    releasePending();
  }
  await rejection;
  assert.equal(completed, 3);
  assert.equal(residualReads, 1);
});

test('final read runs after failed concurrent requests settle and read failure keeps the load failed', async () => {
  let active = 0;
  let residualReads = 0;
  let calls = 0;
  let releasePending;
  let pendingStarted;
  const pending = new Promise(resolvePending => { releasePending = resolvePending; });
  const started = new Promise(resolveStarted => { pendingStarted = resolveStarted; });
  const request = async target => {
    if (target.endsWith('/start')) return startResult();
    if (target.endsWith('/residual')) {
      residualReads++;
      throw new Error('database read unavailable');
    }
    const call = calls++;
    if (call === 0) return result(2);
    active++;
    if (call === 1) {
      pendingStarted();
      await pending;
    }
    active--;
    if (call === 2) throw new Error('concurrent probe failed');
    return result(2);
  };
  const load = runLoad(name, url, 2, 5, { token: 'test-only-token', deployPreview, request });
  const rejection = assert.rejects(load,
    /1\/2 concurrent qualification requests failed; Final residual readback failed/);
  try {
    await started;
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    assert.equal(calls, 3);
    assert.equal(active, 1);
    assert.equal(residualReads, 0, 'final read must wait for failed and pending probes to settle');
  } finally {
    releasePending();
  }
  await rejection;
  assert.equal(active, 0);
  assert.equal(residualReads, 1);
});

test('interrupted concurrent load still attempts the final read and cannot pass', async () => {
  const controller = new AbortController();
  let probes = 0;
  let residualReads = 0;
  const request = async target => {
    if (target.endsWith('/start')) return startResult();
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

test('late Worker work after client abort or timeout cannot write across a five-cell replay', async () => {
  for (const suffix of ['d-apse', 'd-use', 'd-euw', 'p-apse', 'p-use']) {
    for (const failure of ['abort', 'timeout']) {
      const previewName = `s4-${'a'.repeat(40)}-${suffix}`;
      const controller = new AbortController();
      let activeAttempt;
      let rows = 0;
      let firstAttempt;
      let calls = 0;
      let releaseLate;
      const late = new Promise(resolveLate => { releaseLate = resolveLate; });
      const request = async (target, init) => {
        const attempt = init.headers['x-stateplane-attempt'];
        if (target.endsWith('/start')) {
          activeAttempt = attempt;
          return startResult();
        }
        if (target.endsWith('/residual')) {
          if (activeAttempt === attempt) activeAttempt = undefined;
          return { ok: true, json: async () => ({ ok: true, residualRows: rows }) };
        }
        calls++;
        if (calls === 2) {
          firstAttempt = attempt;
          void late.then(() => { if (!attempt || activeAttempt === attempt) rows++; });
          if (failure === 'abort') controller.abort();
          throw new Error(failure === 'abort' ? 'client aborted' : 'client timed out');
        }
        return result(2);
      };
      await assert.rejects(runLoad(previewName, url, 2, 5, {
        token: 'test-only-token', deployPreview, request, signal: controller.signal
      }), /concurrent qualification requests failed/);
      assert.equal(rows, 0);
      const replay = await runLoad(previewName, url, 2, 5, { token: 'test-only-token', deployPreview, request });
      assert.equal(replay.success, 2);
      releaseLate();
      await late;
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      assert.equal(rows, 0, `${suffix} ${failure}: old Worker work must be fenced after replay`);
      assert.notEqual(firstAttempt, activeAttempt);
    }
  }
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
    assert.ok([url, `${url}/start`, `${url}/residual`].includes(target));
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer test-only-token');
    requests++;
    return target.endsWith('/start') ? startResult() : target.endsWith('/residual') ? residualResult() : result(2);
  };
  assert.equal((await runLoad(name, undefined, 2, 5, { token: 'test-only-token', deployPreview, request })).success, 2);
  const controller = new AbortController();
  await assert.rejects(runLoad(name, undefined, 2, 5, {
    token: 'test-only-token', signal: controller.signal,
    deployPreview: async () => { controller.abort(); return [base]; }, request
  }), /Qualification load interrupted/);
  assert.equal(requests, 5);
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

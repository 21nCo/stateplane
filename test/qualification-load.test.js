import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/qualification-load.mjs');

test('concurrent load rejects headroom consumed by other sessions and reserved slots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-load-'));
  const mock = join(directory, 'fetch.mjs');
  try {
    await writeFile(mock, `globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, rollback: true, freshRead: true, observedConnections: 16, maxConnections: 20, reservedConnections: 2, elapsedMs: 10 }) });`);
    const env = { ...process.env, PROBE_TOKEN: 'test-only-token', NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` };
    await assert.rejects(run(process.execPath, [script, 'https://preview.example/qualify', '2', '5'], { env }), /Origin connection headroom below 5/);
    const { stdout } = await run(process.execPath, [script, 'https://preview.example/qualify', '2', '2'], { env });
    assert.deepEqual(JSON.parse(stdout), { requests: 2, success: 2, peakObservedConnections: 16,
      minMaxConnections: 20, maxReservedConnections: 2, minimumHeadroom: 2, maxElapsedMs: 10 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('load rejects impossible counts and uses the worst reading across requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-load-varied-'));
  const mock = join(directory, 'fetch.mjs');
  try {
    await writeFile(mock, `let call = 0;
globalThis.fetch = async () => {
  const observedConnections = process.env.IMPOSSIBLE ? (call++ === 2 ? 1 : 2) : [2, 16, 4][call++ % 3];
  return { ok: true, json: async () => ({ ok: true, rollback: true, freshRead: true, observedConnections,
    maxConnections: 20, reservedConnections: 2, elapsedMs: observedConnections }) };
};`);
    const env = { ...process.env, PROBE_TOKEN: 'test-only-token', NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` };
    await assert.rejects(run(process.execPath, [script, 'https://preview.example/qualify', '3', '3'], { env }), /Origin connection headroom below 3/);
    const { stdout } = await run(process.execPath, [script, 'https://preview.example/qualify', '3', '2'], { env });
    assert.equal(JSON.parse(stdout).peakObservedConnections, 16);
    await assert.rejects(run(process.execPath, [script, 'https://preview.example/qualify', '3', '2'], { env: { ...env, IMPOSSIBLE: '1' } }), /1\/3 concurrent qualification requests failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first probe completes table bootstrap before concurrent load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-load-bootstrap-'));
  const mock = join(directory, 'fetch.mjs');
  try {
    await writeFile(mock, `let initialized = false;
let creating = false;
globalThis.fetch = async () => {
  if (!initialized) {
    if (creating) throw new Error('catalog uniqueness race');
    creating = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    initialized = true;
    creating = false;
  }
  return { ok: true, json: async () => ({ ok: true, rollback: true, freshRead: true,
    observedConnections: 2, maxConnections: 20, reservedConnections: 2, elapsedMs: 10 }) };
};`);
    const env = { ...process.env, PROBE_TOKEN: 'test-only-token', NODE_OPTIONS: `--import=${pathToFileURL(mock).href}` };
    const { stdout } = await run(process.execPath, [script, 'https://preview.example/qualify', '3', '5'], { env });
    assert.equal(JSON.parse(stdout).success, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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

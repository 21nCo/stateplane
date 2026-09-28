import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { dryRunTopology } from '../scripts/topology-dry-run.mjs';
import { readHyperdrive } from '../scripts/wrangler-command.mjs';

const root = resolve(import.meta.dirname, '..');

test('operational and disposable Hyperdrive readback launch pinned Wrangler through Node and preserve abort', async () => {
  const controller = new AbortController();
  const id = 'a'.repeat(32);
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: `Wrangler status\n${JSON.stringify({ id })}` };
  };
  assert.deepEqual(await readHyperdrive(id, { signal: controller.signal, runCommand }), { id });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [join(root, 'app/node_modules/wrangler/bin/wrangler.js'), 'hyperdrive', 'get', id]);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  const failure = new Error('Wrangler readback interrupted');
  await assert.rejects(readHyperdrive(id, { signal: controller.signal, runCommand: async () => { throw failure; } }),
    error => error === failure);
});

test('all generated cell and control dry runs launch pinned Wrangler through Node', async () => {
  const topology = JSON.parse(await readFile(join(root, 'deployment/topology.json')));
  const projectRoot = await mkdtemp(join(tmpdir(), 'sta4-wrangler-portability-'));
  const calls = [];
  try {
    const count = await dryRunTopology(topology, { projectRoot, runWrangler: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '' };
    } });
    assert.equal(count, 21);
    assert.equal(calls.length, count);
    const configs = new Set();
    for (const { command, args, options } of calls) {
      assert.equal(command, process.execPath);
      assert.equal(args[0], join(projectRoot, 'app/node_modules/wrangler/bin/wrangler.js'));
      assert.equal(args[1], 'deploy');
      assert.equal(args[2], '--config');
      assert.equal(args[4], '--dry-run');
      assert.equal(args[5], '--outdir');
      assert.equal(options.maxBuffer, 1024 * 1024);
      configs.add(args[3]);
    }
    assert.equal(configs.size, count);
    assert([...configs].some(config => config.includes(`${sep}development${sep}`)));
    assert([...configs].some(config => config.includes(`${sep}production${sep}`)));
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

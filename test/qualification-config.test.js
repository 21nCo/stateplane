import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/qualification-config.mjs');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const head = randomBytes(20).toString('hex');
const hyperdriveId = 'a'.repeat(32);

test('full-head qualification configs dry-run for every declared target cell', { timeout: 120_000 }, async () => {
  const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
  const retained = [];
  for (const [environment, definition] of Object.entries(topology.environments)) {
    for (const cell of definition.cells) {
      const name = `s4-${head}-${environment === 'development' ? 'd' : 'p'}-${cell.id}`;
      const id = environment === 'development' ? 'a'.repeat(32) : 'b'.repeat(32);
      const configPath = resolve(root, '.data/qualification', `${name}.json`);
      const bundlePath = resolve(root, '.data/qualification/bundles', environment, cell.id);
      try {
        const { stdout } = await run(process.execPath, [script, name, id]);
        assert.equal(stdout.trim().replaceAll('\\', '/'), `.data/qualification/${name}.json`);
        const config = JSON.parse(await readFile(configPath));
        assert.equal(config.name, name);
        assert.ok(name.length <= 54, `${name} exceeds Cloudflare's Preview script-name limit`);
        assert.deepEqual(config.hyperdrive, [{ binding: 'AUTHORITY', id }]);
        assert.deepEqual(config.previews.hyperdrive, config.hyperdrive);
        assert.deepEqual(config.previews.vars, { STATEPLANE_DISPOSABLE: '1', STATEPLANE_PROBE_DATABASE: `sta4_${head.slice(0, 16)}_${environment === 'development' ? 'dev' : 'prod'}_${cell.id.replaceAll('-', '_')}`, STATEPLANE_PROBE_ROLE: `sta4_probe_${head.slice(0, 16)}` });
        assert.equal(JSON.stringify(config).includes('password'), false);
        retained.push({ environment, cell: cell.id, name: config.name, id: config.previews.hyperdrive[0].id });
        await run(pnpm, ['--filter', '@stateplane/app', 'exec', 'wrangler', 'deploy', '--config', configPath, '--dry-run', '--outdir', bundlePath], { maxBuffer: 1024 * 1024 });
      } finally {
        await rm(configPath, { force: true });
        await rm(bundlePath, { recursive: true, force: true });
      }
    }
  }
  const dev = retained.find(entry => entry.environment === 'development' && entry.cell === 'in-south');
  const prod = retained.find(entry => entry.environment === 'production' && entry.cell === 'in-south');
  assert.equal(new Set(retained.map(entry => entry.name)).size, retained.length);
  assert.equal(dev.name.length, 54);
  assert.notEqual(dev.name, prod.name);
  assert.notEqual(dev.id, prod.id);
});

test('qualification config rejects truncated heads and undeclared cells before writing', async () => {
  for (const name of [`s4-${head.slice(0, 39)}-d-in-south`, `s4-${head}-d-unknown`, `s4-${head}-staging-in-south`, `s4-${head}-p-eu-west`, `sta-4-${head}-dev-in-south`]) {
    await assert.rejects(run(process.execPath, [script, name, hyperdriveId]), { code: 2 });
    await assert.rejects(readFile(resolve(root, '.data/qualification', `${name}.json`)), { code: 'ENOENT' });
  }
});

test('same cell in development and production retains separate Preview bindings', async () => {
  const devName = `s4-${head}-d-in-south`;
  const prodName = `s4-${head}-p-in-south`;
  const devPath = resolve(root, '.data/qualification', `${devName}.json`);
  const prodPath = resolve(root, '.data/qualification', `${prodName}.json`);
  const prodId = 'b'.repeat(32);
  try {
    await run(process.execPath, [script, devName, hyperdriveId]);
    await run(process.execPath, [script, prodName, prodId]);
    const [dev, prod] = await Promise.all([readFile(devPath, 'utf8'), readFile(prodPath, 'utf8')]);
    assert.equal(JSON.parse(dev).previews.hyperdrive[0].id, hyperdriveId);
    assert.equal(JSON.parse(prod).previews.hyperdrive[0].id, prodId);
  } finally {
    await Promise.all([rm(devPath, { force: true }), rm(prodPath, { force: true })]);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/qualification-config.mjs');
const previewSecretScript = resolve(root, 'scripts/qualification-preview-secret.mjs');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const head = randomBytes(20).toString('hex');
const hyperdriveId = 'a'.repeat(32);

test('full-head qualification configs dry-run for every declared target cell', { timeout: 120_000 }, async () => {
  const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
  const retained = [];
  for (const [environment, definition] of Object.entries(topology.environments)) {
    for (const cell of definition.cells) {
      const name = `s4-${head}-${environment === 'development' ? 'd' : 'p'}-${{ 'ap-southeast': 'apse', 'us-east': 'use', 'eu-west': 'euw' }[cell.id]}`;
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
        assert.deepEqual(config.secrets, { required: ['PROBE_TOKEN'] });
        assert.deepEqual(config.previews.secrets, { required: ['PROBE_TOKEN'] });
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
  const dev = retained.find(entry => entry.environment === 'development' && entry.cell === 'ap-southeast');
  const prod = retained.find(entry => entry.environment === 'production' && entry.cell === 'ap-southeast');
  assert.equal(new Set(retained.map(entry => entry.name)).size, retained.length);
  assert.equal(dev.name.length, 50);
  assert.notEqual(dev.name, prod.name);
  assert.notEqual(dev.id, prod.id);
});

test('qualification config rejects truncated heads and undeclared cells before writing', async () => {
  for (const name of [`s4-${head.slice(0, 39)}-d-apse`, `s4-${head}-d-unknown`, `s4-${head}-staging-in-south`, `s4-${head}-p-euw`, `sta-4-${head}-dev-apse`]) {
    await assert.rejects(run(process.execPath, [script, name, hyperdriveId]), { code: 2 });
    await assert.rejects(readFile(resolve(root, '.data/qualification', `${name}.json`)), { code: 'ENOENT' });
  }
});

test('same cell in development and production retains separate Preview bindings', async () => {
  const devName = `s4-${head}-d-apse`;
  const prodName = `s4-${head}-p-apse`;
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

test('Preview setup installs a protected token and fails if latest deployment omits it', async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-test-'));
  const fakePnpm = join(directory, 'pnpm');
  const calls = join(directory, 'calls.jsonl');
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    await writeFile(fakePnpm, `#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('--secrets-file')) {
  const path = args[args.indexOf('--secrets-file') + 1];
  if (statSync(path).mode & 0o077) process.exit(4);
  if (JSON.parse(readFileSync(path)).PROBE_TOKEN !== process.env.PROBE_TOKEN) process.exit(5);
} else if (args.includes('list')) {
  process.stdout.write(JSON.stringify(process.env.FAKE_SECRET_MISSING ? [] : [{ name: 'PROBE_TOKEN', type: 'secret_text' }]));
}
`);
    await chmod(fakePnpm, 0o700);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, PROBE_TOKEN: 'private-test-token', FAKE_CALLS: calls };
    const { stdout } = await run(process.execPath, [previewSecretScript, name], { env });
    assert.match(stdout, /PROBE_TOKEN binding verified/);
    assert.equal(stdout.includes(env.PROBE_TOKEN), false);
    const callText = await readFile(calls, 'utf8');
    assert.equal(callText.includes(env.PROBE_TOKEN), false);
    const previewCall = JSON.parse(callText.split('\n').find(line => line.includes('--secrets-file')));
    await assert.rejects(readFile(previewCall[previewCall.indexOf('--secrets-file') + 1]), { code: 'ENOENT' });
    assert.equal((await readFile(configPath, 'utf8')).includes(env.PROBE_TOKEN), false);
    await assert.rejects(run(process.execPath, [previewSecretScript, name], { env: { ...env, FAKE_SECRET_MISSING: '1' } }), /PROBE_TOKEN is absent/);
  } finally {
    await Promise.all([rm(configPath, { force: true }), rm(directory, { recursive: true, force: true })]);
  }
});

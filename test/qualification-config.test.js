import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readWranglerJson, setupPreview, wrangler, wranglerInvocation } from '../scripts/qualification-preview-secret.mjs';
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

test('Preview setup protects its token, requires a URL and verifies the latest binding', async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const calls = [];
  let secretFile;
  const runWrangler = async (args) => {
    calls.push(args);
    if (args.includes('--secrets-file')) {
      secretFile = args[args.indexOf('--secrets-file') + 1];
      assert.equal((await stat(secretFile)).mode & 0o077, 0);
      assert.equal(JSON.parse(await readFile(secretFile)).PROBE_TOKEN, 'private-test-token');
      return 'Wrangler 4.135\n' + JSON.stringify({ preview: { urls: ['https://probe.example.workers.dev'] }, deployment: { urls: [] } });
    }
    return 'Reading secrets...\n' + JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }]);
  };
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    assert.deepEqual(await setupPreview(name, 'private-test-token', { runWrangler }), ['https://probe.example.workers.dev']);
    assert.equal(JSON.stringify(calls).includes('private-test-token'), false);
    await assert.rejects(readFile(secretFile), { code: 'ENOENT' });
    assert.equal((await readFile(configPath, 'utf8')).includes('private-test-token'), false);
    await assert.rejects(setupPreview(name, 'private-test-token', { runWrangler: async args =>
      args.includes('--secrets-file') ? JSON.stringify({ preview: { urls: [] } }) : '[]' }), /no usable HTTPS URL/);
    await assert.rejects(setupPreview(name, 'private-test-token', { runWrangler: async args =>
      args.includes('--secrets-file') ? JSON.stringify({ preview: { urls: ['https://probe.example.workers.dev'] } }) : '[]' }), /PROBE_TOKEN is absent/);
    assert.throws(() => readWranglerJson('Wrangler banner without JSON'), /no valid JSON/);
  } finally {
    await rm(configPath, { force: true });
  }
});

test('Preview interruption removes its protected token file', async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const controller = new AbortController();
  let secretFile;
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    await assert.rejects(setupPreview(name, 'private-test-token', { signal: controller.signal, runWrangler: async (args, signal) => {
      secretFile = args[args.indexOf('--secrets-file') + 1];
      assert.equal(signal, controller.signal);
      controller.abort();
      throw new Error('interrupted');
    } }), /interrupted/);
    await assert.rejects(readFile(secretFile), { code: 'ENOENT' });
  } finally {
    await rm(configPath, { force: true });
  }
});

test('aborting a real child process waits for its exit before deleting the token file', { timeout: 15_000 }, async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-child-'));
  const entry = join(directory, 'wrangler-child.mjs');
  const marker = join(directory, 'marker.json');
  const controller = new AbortController();
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, file: args[args.indexOf('--secrets-file') + 1] }));
setInterval(() => {}, 1000);`);
    const previous = process.env.FAKE_MARKER;
    process.env.FAKE_MARKER = marker;
    try {
      const pending = setupPreview(name, 'private-test-token', { signal: controller.signal,
        runWrangler: (args, signal) => wrangler(args, signal, entry) });
      let observed;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { observed = JSON.parse(await readFile(marker, 'utf8')); break; }
        catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 25)); }
      }
      assert.ok(observed, 'child started');
      assert.equal(JSON.parse(await readFile(observed.file)).PROBE_TOKEN, 'private-test-token');
      controller.abort();
      await assert.rejects(pending, /Wrangler Preview secret command failed/);
      await assert.rejects(readFile(observed.file), { code: 'ENOENT' });
      if (process.platform !== 'win32') assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' });
    } finally {
      if (previous === undefined) delete process.env.FAKE_MARKER;
      else process.env.FAKE_MARKER = previous;
    }
  } finally {
    controller.abort();
    await Promise.all([rm(configPath, { force: true }), rm(directory, { recursive: true, force: true })]);
  }
});

test('Preview helper resolves project Wrangler through the trusted Node executable', () => {
  const invocation = wranglerInvocation(['preview', '--json']);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], resolve(root, 'app/node_modules/wrangler/bin/wrangler.js'));
  assert.deepEqual(invocation.args.slice(1), ['preview', '--json']);
});

test('documented Preview CLI reads protected token, prints Preview URL and handles interruption', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-cli-'));
  const name = `s4-${head}-d-apse`;
  const helper = join(directory, 'scripts/qualification-preview-secret.mjs');
  const fakeWrangler = join(directory, 'app/node_modules/wrangler/bin/wrangler.js');
  const marker = join(directory, 'marker.json');
  try {
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await mkdir(join(directory, 'app/node_modules/wrangler/bin'), { recursive: true });
    await mkdir(join(directory, '.data/qualification'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await copyFile(resolve(root, 'scripts/qualification-preview-secret.mjs'), helper);
    await writeFile(join(directory, '.data/qualification', `${name}.json`), JSON.stringify({ name, previews: { secrets: { required: ['PROBE_TOKEN'] } } }));
    await writeFile(fakeWrangler, `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--secrets-file')) {
  const file = args[args.indexOf('--secrets-file') + 1];
  if (readFileSync(file, 'utf8').includes('private-test-token') === false) process.exit(2);
  if (process.env.FAKE_WAIT) {
    writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ file }));
    setInterval(() => {}, 1000);
  } else console.log(JSON.stringify({ preview: { urls: ['https://probe.example.workers.dev'] }, deployment: { urls: [] } }));
} else console.log(JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }]));`);
    const env = { ...process.env, PROBE_TOKEN: 'private-test-token' };
    const { stdout } = await run(process.execPath, [helper, name], { env });
    assert.deepEqual(JSON.parse(stdout), { name, urls: ['https://probe.example.workers.dev'], probeTokenBound: true });
    await assert.rejects(run(process.execPath, [helper, name], { env: { ...env, PROBE_TOKEN: '' } }), /protected single-line PROBE_TOKEN/);
    if (process.platform !== 'win32') {
      const child = spawn(process.execPath, [helper, name], { env: { ...env, FAKE_WAIT: '1', FAKE_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise(resolveClose => child.on('close', resolveClose));
      let observed;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { observed = JSON.parse(await readFile(marker, 'utf8')); break; }
        catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 25)); }
      }
      assert.ok(observed, 'Wrangler child started');
      child.kill('SIGINT');
      assert.equal(await closed, 130);
      await assert.rejects(readFile(observed.file), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

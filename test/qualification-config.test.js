import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readWranglerJson, setupPreview, wrangler, wranglerInvocation } from '../scripts/qualification-preview-secret.mjs';
import { currentCleanHead, qualificationConfig } from '../scripts/qualification-artifact.mjs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/qualification-config.mjs');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hyperdriveId = 'a'.repeat(32);
const preview = (name, token, options) => setupPreview(name, token, { verifyTarget: async () => {}, ...options });

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
        assert.equal(config.workers_dev, false);
        assert.equal(config.preview_urls, true);
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

test('qualification config rejects truncated, stale and undeclared heads/cells before writing', async () => {
  const stale = `${head[0] === 'a' ? 'b' : 'a'}${head.slice(1)}`;
  for (const name of [`s4-${head.slice(0, 39)}-d-apse`, `s4-${stale}-d-apse`, `s4-${head}-d-unknown`, `s4-${head}-staging-in-south`, `s4-${head}-p-euw`, `sta-4-${head}-dev-apse`]) {
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
    if (args[1] === 'delete') return '{}';
    if (args.includes('--secrets-file')) {
      secretFile = args[args.indexOf('--secrets-file') + 1];
      assert.equal((await stat(secretFile)).mode & 0o077, 0);
      assert.equal(JSON.parse(await readFile(secretFile)).PROBE_TOKEN, 'private-test-token');
      return 'Wrangler 4.135\n' + JSON.stringify({ preview_urls: ['https://probe.example.workers.dev'], deployment_urls: [] });
    }
    assert.deepEqual(args, ['preview', 'secret', 'list', '--name', name, '--config', configPath, '--ignore-base-config', '--json']);
    return 'Reading secrets...\n' + JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }]);
  };
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    assert.deepEqual(await preview(name, 'private-test-token', { runWrangler }), ['https://probe.example.workers.dev']);
    assert.deepEqual(await preview(name, 'private-test-token', { runWrangler: async args =>
      args.includes('--secrets-file') ? JSON.stringify({ preview: { urls: ['https://probe.example.workers.dev'] } }) :
        JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }]) }), ['https://probe.example.workers.dev']);
    assert.deepEqual(await preview(name, 'private-test-token', { runWrangler: async args =>
      `Wrangler {status}\n${args.includes('--secrets-file')
        ? JSON.stringify({ preview_urls: ['https://probe.example.workers.dev'] })
        : JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }])}\nWrangler complete` }),
    ['https://probe.example.workers.dev']);
    assert.equal(JSON.stringify(calls).includes('private-test-token'), false);
    await assert.rejects(readFile(secretFile), { code: 'ENOENT' });
    assert.equal((await readFile(configPath, 'utf8')).includes('private-test-token'), false);
    await assert.rejects(preview(name, 'private-test-token', { runWrangler: async args =>
      args[1] === 'delete' ? '{}' : args.includes('--secrets-file') ? JSON.stringify({ preview: { urls: [] } }) : '[]' }), /no usable HTTPS URL/);
    await assert.rejects(preview(name, 'private-test-token', { runWrangler: async args =>
      args[1] === 'delete' ? '{}' : args.includes('--secrets-file') ? JSON.stringify({ preview: { urls: ['https://probe.example.workers.dev'] } }) : '[]' }), /PROBE_TOKEN is absent/);
    assert.throws(() => readWranglerJson('Wrangler banner without JSON'), /no valid JSON/);
    assert.deepEqual(readWranglerJson('Wrangler {status}\n' + JSON.stringify({ id: hyperdriveId, origin: { database: 'stateplane' } })),
      { id: hyperdriveId, origin: { database: 'stateplane' } });
    assert.deepEqual(readWranglerJson('Wrangler {status}\n' + JSON.stringify({ id: hyperdriveId }) + '\nPreview deployment complete'),
      { id: hyperdriveId });
    assert.throws(() => readWranglerJson('['.repeat(1024 * 1024)), /no valid JSON/);
    const malformed = '{]'.repeat(450_000);
    const started = performance.now();
    assert.deepEqual(readWranglerJson(malformed + '\n' + JSON.stringify([{ name: 'PROBE_TOKEN', type: 'secret_text' }])),
      [{ name: 'PROBE_TOKEN', type: 'secret_text' }]);
    assert.ok(performance.now() - started < 1500, 'malformed near-1MiB status fragments must scan linearly');
    assert.throws(() => readWranglerJson('x'.repeat(1024 * 1024 + 1)), /too large/);
    const altered = JSON.parse(await readFile(configPath));
    altered.previews.vars.STATEPLANE_PROBE_ROLE = 'admin';
    await writeFile(configPath, JSON.stringify(altered));
    const callsBefore = calls.length;
    await assert.rejects(preview(name, 'private-test-token', { runWrangler }), /exact-head qualification artifact/);
    assert.equal(calls.length, callsBefore, 'altered artifact must fail before Wrangler');
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
    await assert.rejects(preview(name, 'private-test-token', { signal: controller.signal, runWrangler: async (args, signal) => {
      if (args[1] === 'delete') return '{}';
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

test('matching edits to artifact and config cannot replace the protected disposable target', async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  let deployments = 0;
  try {
    await run(process.execPath, [script, name, 'b'.repeat(32)]);
    await assert.rejects(setupPreview(name, 'private-test-token', {
      verifyTarget: async (_root, _name, _head, id) => {
        assert.equal(id, 'b'.repeat(32));
        throw new Error('Disposable qualification target differs from protected inventory');
      },
      runWrangler: async () => { deployments++; return '{}'; }
    }), /protected inventory/);
    assert.equal(deployments, 0);
  } finally { await rm(configPath, { force: true }); }
});

test('failed Preview readback deletes attempted deployment for every qualification cell', async () => {
  for (const [short, cell] of [['d', 'apse'], ['d', 'use'], ['d', 'euw'], ['p', 'apse'], ['p', 'use']]) {
    const name = `s4-${head}-${short}-${cell}`;
    const configPath = resolve(root, '.data/qualification', `${name}.json`);
    const calls = [];
    try {
      await run(process.execPath, [script, name, hyperdriveId]);
      await assert.rejects(preview(name, 'private-test-token', { runWrangler: async args => {
        calls.push(args[1]);
        if (args[1] === 'delete') return '{}';
        if (args[1] === 'secret') return '[]';
        return JSON.stringify({ preview_urls: ['https://probe.example/'] });
      } }), /PROBE_TOKEN is absent/);
      assert.deepEqual(calls, ['--name', 'secret', 'delete']);
    } finally { await rm(configPath, { force: true }); }
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
if (args[0] === 'preview' && args[1] === 'delete') {
  console.log('{}');
  process.exit(0);
}
writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, file: args[args.indexOf('--secrets-file') + 1] }));
setInterval(() => {}, 1000);`);
    const previous = process.env.FAKE_MARKER;
    process.env.FAKE_MARKER = marker;
    try {
      const pending = preview(name, 'private-test-token', { signal: controller.signal,
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

test('pinned Wrangler exposes the Preview secret-list isolation arguments', async () => {
  const invocation = wranglerInvocation(['preview', 'secret', 'list', '--help']);
  const { stdout } = await run(invocation.command, invocation.args, { cwd: root });
  assert.match(stdout, /^wrangler preview secret list$/m);
  for (const option of ['--name', '--config', '--ignore-base-config', '--json']) {
    assert.match(stdout, new RegExp(`(^|\\s)${option}(?=\\s)`));
  }
});

test('documented Preview CLI refuses to deploy without the independent protected inventory', async () => {
  const name = `s4-${head}-d-apse`;
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  try {
    await run(process.execPath, [script, name, hyperdriveId]);
    await assert.rejects(run(process.execPath, [resolve(root, 'scripts/qualification-preview-secret.mjs'), name], {
      env: { ...process.env, PROBE_TOKEN: 'private-test-token', STATEPLANE_QUALIFICATION_INVENTORY_FILE: '' }
    }), error => error.stderr.includes('Protected qualification inventory path required'));
  } finally { await rm(configPath, { force: true }); }
});

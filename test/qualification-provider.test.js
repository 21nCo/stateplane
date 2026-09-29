import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRailwayQualification } from '../scripts/qualification-target.mjs';
import { assertProcessStopped } from './process-stopped.mjs';

test('connected Railway readback rejects every GraphQL error', async () => {
  const previous = process.env.STATEPLANE_RAILWAY_ACCOUNT;
  process.env.STATEPLANE_RAILWAY_ACCOUNT = 'test-account';
  try {
    const inventory = { serviceId: 'service', environmentId: 'environment', volumeInstanceId: 'volume' };
    const run = async (command, args, options) => {
      assert.equal(command, 'composio');
      assert.match(args.join(' '), /mountPath/);
      assert.equal(options.timeout, 15_000);
      assert.equal(options.errorMessage, 'Connected Railway readback failed');
      return { stdout: JSON.stringify({ data: { service: { id: 'service' } }, errors: [{ message: 'partial failure' }] }) };
    };
    await assert.rejects(readRailwayQualification(inventory, undefined, run), /readback failed/);
    await assert.rejects(readRailwayQualification(inventory, undefined,
      async () => ({ stdout: '{"data":null,"errors":[]}' })), /readback failed/);
    assert.deepEqual(await readRailwayQualification(inventory, undefined,
      async () => ({ stdout: '{"data":{"service":{"id":"service"}}}' })), { service: { id: 'service' } });
  } finally {
    if (previous === undefined) delete process.env.STATEPLANE_RAILWAY_ACCOUNT;
    else process.env.STATEPLANE_RAILWAY_ACCOUNT = previous;
  }
});

test('connected Railway readback cancellation settles a real descendant holding command pipes',
  { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-railway-child-'));
    const marker = join(directory, 'descendant.pid');
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const shim = join(bin, 'composio');
    await writeFile(shim, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.env.STA4_CHILD_PID,String(process.pid));setInterval(()=>{},1000)"],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
setTimeout(() => process.exit(0), 80);
`);
    await chmod(shim, 0o700);
    const prior = process.env.STATEPLANE_RAILWAY_ACCOUNT;
    const priorPath = process.env.PATH;
    const priorMarker = process.env.STA4_CHILD_PID;
    process.env.STATEPLANE_RAILWAY_ACCOUNT = 'test-account';
    process.env.PATH = `${bin}:${priorPath}`;
    process.env.STA4_CHILD_PID = marker;
    const controller = new AbortController();
    let pid;
    let request;
    try {
      request = readRailwayQualification({ serviceId: 's', environmentId: 'e', volumeInstanceId: 'v' },
        controller.signal);
      for (let attempt = 0; attempt < 120; attempt++) {
        try { pid = Number(await readFile(marker, 'utf8')); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      assert.ok(pid, 'descendant started before cancellation');
      const started = Date.now();
      controller.abort();
      await assert.rejects(request, /Connected Railway readback failed/);
      assert.ok(Date.now() - started < 3000, 'real child must settle before watchdog');
      await assertProcessStopped(pid, 'Railway descendant must stop executing');
    } finally {
      controller.abort();
      await request?.catch(() => {});
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      if (prior === undefined) delete process.env.STATEPLANE_RAILWAY_ACCOUNT;
      else process.env.STATEPLANE_RAILWAY_ACCOUNT = prior;
      process.env.PATH = priorPath;
      if (priorMarker === undefined) delete process.env.STA4_CHILD_PID;
      else process.env.STA4_CHILD_PID = priorMarker;
      await rm(directory, { recursive: true, force: true });
    }
  });

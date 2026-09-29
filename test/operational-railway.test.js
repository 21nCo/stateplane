import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOperationalRailway } from '../scripts/operational-railway.mjs';
import { assertProcessStopped } from './process-stopped.mjs';

const resource = { serviceId: 'service', volumeInstanceId: 'volume' };
const options = { projectId: 'project', environmentId: 'environment', account: 'test-account' };

test('operational Railway query retains region, backup, PITR and proxy readback', async () => {
  const result = await readOperationalRailway(resource, { ...options, runCommand: async (command, args, limits) => {
    assert.equal(command, 'composio');
    assert.equal(limits.timeout, 30_000);
    assert.equal(limits.maxBuffer, 1024 * 1024);
    const payload = JSON.parse(args.at(-1));
    assert.deepEqual(payload.variables.projectId, options.projectId);
    for (const field of ['regions', 'volumeInstanceBackupList', 'volumeInstancePitrRestoreEstimate', 'tcpProxies']) {
      assert.ok(payload.query.includes(field), field);
    }
    return { stdout: JSON.stringify({ data: { volumeInstanceBackupList: [1],
      volumeInstanceBackupScheduleList: [2], volumeInstancePitrRestoreEstimate: { likelyToFit: true } } }) };
  } });
  assert.deepEqual(result.backups, [1]);
  assert.deepEqual(result.backupSchedules, [2]);
  assert.equal(result.pitrEstimate.likelyToFit, true);
  await assert.rejects(readOperationalRailway(resource, { ...options, runCommand: async () =>
    ({ stdout: '{"errors":[{"message":"partial"}],"data":{}}' }) }), /readback failed/);
});

test('operational Railway cancellation and byte overflow stop inherited-pipe descendants',
  { skip: process.platform === 'win32', timeout: 12_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-operational-railway-'));
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const shim = join(bin, 'composio');
    await writeFile(shim, `#!/usr/bin/env node
const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.env.STA4_CHILD_PID,String(process.pid));if(process.env.STA4_OUTPUT)process[process.env.STA4_OUTPUT].write('€'.repeat(30000));setInterval(()=>{},1000)"],
  {stdio:['ignore','inherit','inherit'],env:process.env});
setTimeout(()=>process.exit(0),80);
`);
    await chmod(shim, 0o700);
    const priorPath = process.env.PATH;
    const priorMarker = process.env.STA4_CHILD_PID;
    const priorOutput = process.env.STA4_OUTPUT;
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      for (const failure of ['timeout', 'abort', 'overflow-stdout', 'overflow-stderr']) {
        const marker = join(directory, `${failure}.pid`);
        process.env.STA4_CHILD_PID = marker;
        process.env.STA4_OUTPUT = failure.startsWith('overflow-') ? failure.slice(9) : '';
        const controller = new AbortController();
        const started = Date.now();
        const request = readOperationalRailway(resource, { ...options, signal: controller.signal,
          timeout: failure === 'timeout' ? 700 : 3000,
          maxBuffer: failure.startsWith('overflow-') ? 64 * 1024 : 1024 * 1024 });
        request.catch(() => {});
        let pid;
        try {
          for (let attempt = 0; attempt < 120; attempt++) {
            try { pid = Number(await readFile(marker, 'utf8')); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 25)); }
          }
          assert.ok(pid, `${failure} descendant started`);
          if (failure === 'abort') controller.abort();
          await assert.rejects(request, /Connected Railway provider readback failed/);
          assert.ok(Date.now() - started < 2500, `${failure} must settle before command timeout`);
          await assertProcessStopped(pid, `${failure} operational Railway descendant must stop`);
        } finally {
          controller.abort();
          await request.catch(() => {});
          if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
        }
      }
    } finally {
      process.env.PATH = priorPath;
      if (priorMarker === undefined) delete process.env.STA4_CHILD_PID;
      else process.env.STA4_CHILD_PID = priorMarker;
      if (priorOutput === undefined) delete process.env.STA4_OUTPUT;
      else process.env.STA4_OUTPUT = priorOutput;
      await rm(directory, { recursive: true, force: true });
    }
  });

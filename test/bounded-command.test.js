import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedCommand } from '../scripts/bounded-command.mjs';

test('child output is bounded in combined bytes and the child is gone before rejection',
  { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-child-output-'));
    try {
      for (const stream of ['stdout', 'stderr']) {
        const marker = join(directory, `${stream}.pid`);
        const code = `require('node:fs').writeFileSync(process.env.STA4_CHILD_PID, String(process.pid));
          process.${stream}.write('€'.repeat(30_000)); setInterval(() => {}, 1000);`;
        const started = Date.now();
        await assert.rejects(runBoundedCommand(process.execPath, ['-e', code], {
          env: { ...process.env, STA4_CHILD_PID: marker }, maxBuffer: 64 * 1024, timeout: 3000,
          errorMessage: 'bounded child failed'
        }), /bounded child failed/);
        assert.ok(Date.now() - started < 1500, `${stream} must overflow before the timeout`);
        const pid = Number(await readFile(marker, 'utf8'));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${stream} child must settle`);
      }
      const result = await runBoundedCommand(process.execPath, ['-e',
        "process.stdout.write('ok'); process.stderr.write('diagnostic');"], { maxBuffer: 64 });
      assert.equal(result.stdout, 'ok');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('timeout, abort and overflow settle after terminating descendants holding command pipes',
  { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sta4-child-tree-'));
    try {
      for (const failure of ['timeout', 'abort', 'overflow']) {
        const marker = join(directory, `${failure}.pid`);
        const grandchild = `require('node:fs').writeFileSync(process.env.STA4_CHILD_PID,String(process.pid));
          if(process.env.STA4_OUTPUT)process.stderr.write('€'.repeat(30000));
          setTimeout(()=>process.exit(0),10000);`;
        const parent = `const {spawn}=require('node:child_process');
          spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],
            {stdio:['ignore','inherit','inherit'],env:process.env});
          setTimeout(()=>process.exit(0),80);`;
        const controller = new AbortController();
        const started = Date.now();
        const command = runBoundedCommand(process.execPath, ['-e', parent], {
          env: { ...process.env, STA4_CHILD_PID: marker, STA4_OUTPUT: failure === 'overflow' ? '1' : '' },
          maxBuffer: failure === 'overflow' ? 64 * 1024 : 1024 * 1024,
          timeout: failure === 'timeout' ? 200 : 3000, signal: controller.signal,
          errorMessage: 'bounded child failed'
        });
        if (failure === 'abort') setTimeout(() => controller.abort(), 200);
        try {
          await assert.rejects(Promise.race([command,
            new Promise((_, reject) => setTimeout(() => reject(new Error('command hung')), 1800))]),
          /bounded child failed/);
          assert.ok(Date.now() - started < 1800, `${failure} must settle before watchdog`);
          const pid = Number(await readFile(marker, 'utf8'));
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${failure} descendant must be gone`);
        } finally {
          try { process.kill(Number(await readFile(marker, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
          await command.catch(() => {});
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

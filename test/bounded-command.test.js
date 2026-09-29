import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedCommand } from '../scripts/bounded-command.mjs';
import { assertProcessStopped } from './process-stopped.mjs';

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
    await assert.rejects(assertProcessStopped(process.pid, undefined, { settleMs: 50 }), /process must stop executing/,
      'the liveness oracle must reject an executing process');
    await assert.rejects(assertProcessStopped(process.pid, undefined,
      { readState: async () => { throw new Error('OS process-state observer unavailable'); } }),
    /observer unavailable/, 'missing OS state cannot count as stopped');
    let observations = 0;
    await assertProcessStopped(process.pid, undefined, { settleMs: 200,
      readState: async () => ++observations < 3 ? 'S' : 'Z' });
    assert.equal(observations, 3, 'a live intermediate sample must be retried');
    const directory = await mkdtemp(join(tmpdir(), 'sta4-child-tree-'));
    try {
      for (const failure of ['timeout', 'abort', 'overflow-stdout', 'overflow-stderr']) {
        const marker = join(directory, `${failure}.pid`);
        const grandchild = `require('node:fs').writeFileSync(process.env.STA4_CHILD_PID,String(process.pid));
          if(process.env.STA4_OUTPUT)process[process.env.STA4_OUTPUT].write('€'.repeat(30000));
          setTimeout(()=>process.exit(0),10000);`;
        const parent = `const {spawn}=require('node:child_process');
          spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],
            {stdio:['ignore','inherit','inherit'],env:process.env});
          setTimeout(()=>process.exit(0),80);`;
        const controller = new AbortController();
        const started = Date.now();
        const command = runBoundedCommand(process.execPath, ['-e', parent], {
          env: { ...process.env, STA4_CHILD_PID: marker, STA4_OUTPUT: failure.startsWith('overflow-') ? failure.slice(9) : '' },
          maxBuffer: failure.startsWith('overflow-') ? 64 * 1024 : 1024 * 1024,
          timeout: failure === 'timeout' ? 5000 : 3000, signal: controller.signal,
          errorMessage: 'bounded child failed'
        });
        try {
          if (failure === 'abort') {
            for (let attempt = 0; attempt < 120; attempt++) {
              try { await readFile(marker, 'utf8'); break; }
              catch { await new Promise(resolve => setTimeout(resolve, 25)); }
            }
            assert.ok(await readFile(marker, 'utf8'), 'descendant started before abort');
            controller.abort();
          }
          let watchdog;
          try {
            await assert.rejects(Promise.race([command,
              new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('command hung')), 7000); })]),
            /bounded child failed/);
          } finally { clearTimeout(watchdog); }
          assert.ok(Date.now() - started < 7000, `${failure} must settle before watchdog`);
          if (failure.startsWith('overflow-')) {
            assert.ok(Date.now() - started < 1500, `${failure} must reject on bytes before the 3000ms timeout`);
          }
          const pid = Number(await readFile(marker, 'utf8'));
          await assertProcessStopped(pid, `${failure} descendant must stop executing`);
        } finally {
          try { process.kill(Number(await readFile(marker, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
          await command.catch(() => {});
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

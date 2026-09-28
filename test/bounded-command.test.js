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
        await assert.rejects(runBoundedCommand(process.execPath, ['-e', code], {
          env: { ...process.env, STA4_CHILD_PID: marker }, maxBuffer: 64 * 1024, timeout: 3000,
          errorMessage: 'bounded child failed'
        }), /bounded child failed/);
        const pid = Number(await readFile(marker, 'utf8'));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${stream} child must settle`);
      }
      const result = await runBoundedCommand(process.execPath, ['-e',
        "process.stdout.write('ok'); process.stderr.write('diagnostic');"], { maxBuffer: 64 });
      assert.equal(result.stdout, 'ok');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

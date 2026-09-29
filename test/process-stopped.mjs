import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** Assert OS-visible execution has stopped, including an orphan awaiting PID 1 reaping. */
export function assertProcessStopped(pid, message = 'process must stop executing') {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  const observed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (observed.error) throw observed.error;
  if (observed.status !== 0) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, message);
    return;
  }
  const state = observed.stdout.trim();
  assert.match(state, /^Z/, `${message}; observed process state ${state}`);
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Observe execution with a trusted OS source; an unreaped zombie is stopped. */
async function processState(pid) {
  if (!exists(pid)) return 'gone';
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    } catch (error) {
      if (error.code === 'ENOENT' && !exists(pid)) return 'gone';
      throw new Error('OS process-state observer unavailable', { cause: error });
    }
  }
  const observed = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (observed.error) throw new Error('OS process-state observer unavailable', { cause: observed.error });
  if (observed.status !== 0) {
    if (!exists(pid)) return 'gone';
    throw new Error('OS process-state observer unavailable');
  }
  return observed.stdout.trim().slice(0, 1);
}

/** Poll OS-visible state until execution stops or the bounded settle window expires. */
export async function assertProcessStopped(pid, message = 'process must stop executing',
  { readState = processState, settleMs = 500 } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'process ID must be a positive safe integer');
  const deadline = Date.now() + settleMs;
  let state;
  do {
    state = await readState(pid);
    if (state === 'gone' || state === 'Z' || state === 'X') return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
  assert.fail(`${message}; observed process state ${state}`);
}

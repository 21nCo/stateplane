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

/** Diagnostic only; liveness verdicts still use the fresh OS checks below. */
export function processIdentity(pid) {
  if (process.platform === 'win32') return `pid=${pid}`;
  const observed=spawnSync('/bin/ps',['-o','pid=,ppid=,pgid=,stat=,lstart=','-p',String(pid)],
    {encoding:'utf8',timeout:1000,maxBuffer:4096});
  return `pid=${pid}; ps=${observed.stdout?.trim() || observed.error?.code || 'absent'}; observedAt=${new Date().toISOString()}`;
}

function linuxFallback(pid, error) {
  if ((error.code === 'ENOENT' || error.code === 'ESRCH') && !exists(pid)) return 'gone';
  const observed = spawnSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=,lstart=', '-p', String(pid)],
    { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
  const detail = observed.error?.code ?? observed.stdout?.trim() ?? 'empty';
  const psState = new RegExp(String.raw`^${pid}\s+\d+\s+\d+\s+([A-Z])`).exec(detail)?.[1];
  if (observed.status === 0 && psState) return psState;
  // /proc and ps can both miss a descendant that exited between samples.
  // A fresh kernel liveness check distinguishes that race from a live child
  // whose OS observer failed.
  if ((error.code === 'ENOENT' || error.code === 'ESRCH') && !exists(pid)) return 'gone';
  throw new Error(`OS process-state observer unavailable for PID ${pid}: /proc ${error.code ?? 'unknown'}; ps ${detail || 'empty'}`,
    { cause: error });
}

/** Observe execution with a trusted OS source; an unreaped zombie is stopped. */
export async function processState(pid, { readLinuxStat = readFile } = {}) {
  if (!exists(pid)) return 'gone';
  if (process.platform === 'linux') {
    try {
      const stat = await readLinuxStat(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    } catch (error) { return linuxFallback(pid, error); }
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
  async function poll() {
    let state;
    let observerError;
    try {
      state = await readState(pid);
      observerError = undefined;
    } catch (error) {
      state = undefined;
      observerError = error;
    }
    if (state === 'gone' || state === 'Z' || state === 'X') return;
    if (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      return poll();
    }
    if (observerError) throw new Error(`${message}: ${observerError.message}`, { cause: observerError });
    assert.fail(`${message}; observed process state ${state}`);
  }
  await poll();
}

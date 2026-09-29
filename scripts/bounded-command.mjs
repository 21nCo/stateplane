import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Stop descendants even when the direct child has already exited but left its pipes open. */
async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // A dead parent is absent from taskkill /T. CIM retains each child's ParentProcessId.
    const script = `$root=${child.pid}; $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); ` +
      '$seen=@($root); do { $next=@($all | Where-Object { $seen -contains $_.ParentProcessId -and ' +
      '$seen -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId); $seen+= $next } ' +
      'while ($next.Count -gt 0); for ($i=$seen.Count-1; $i -ge 0; $i--) { ' +
      'Stop-Process -Id $seen[$i] -Force -ErrorAction SilentlyContinue }';
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

/** Collect bounded stdout while counting both child streams and owning process settlement. */
export async function runBoundedCommand(command, args, {
  cwd, env, maxBuffer, timeout, signal, errorMessage = 'Child command failed or interrupted'
}) {
  if (signal?.aborted) throw new Error(errorMessage);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    const chunks = [];
    let bytes = 0;
    let failed = false;
    let launchError;
    let drainTimer;
    let termination;
    const stop = () => {
      if (failed) return;
      failed = true;
      termination = terminateTree(child).catch(() => { failed = true; });
      // A descendant may keep inherited pipes open even if termination fails.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1200);
      drainTimer.unref();
    };
    const onAbort = () => stop();
    const timer = timeout ? setTimeout(stop, timeout) : undefined;
    const consume = (chunk, keep) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxBuffer) { stop(); return; }
      if (keep) chunks.push(chunk);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.on('error', error => { launchError = error; });
    child.on('close', async code => {
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      await termination;
      if (failed || signal?.aborted || launchError || code !== 0) reject(new Error(errorMessage));
      else resolveResult({ stdout: Buffer.concat(chunks).toString('utf8') });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

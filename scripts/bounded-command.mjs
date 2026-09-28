import { spawn } from 'node:child_process';

/** Collect bounded stdout while counting both child streams and owning process settlement. */
export async function runBoundedCommand(command, args, {
  cwd, env, maxBuffer, timeout, signal, errorMessage = 'Child command failed or interrupted'
}) {
  if (signal?.aborted) throw new Error(errorMessage);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let failed = false;
    let launchError;
    let killTimer;
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const onAbort = () => {
      failed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    const timer = timeout ? setTimeout(stop, timeout) : undefined;
    const consume = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { stop(); return; }
      if (keep) chunks.push(chunk);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.on('error', error => { launchError = error; });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (failed || signal?.aborted || launchError || code !== 0) reject(new Error(errorMessage));
      else resolveResult({ stdout: Buffer.concat(chunks).toString('utf8') });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

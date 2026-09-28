import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readWranglerJson } from './wrangler-json.mjs';

const root = resolve(import.meta.dirname, '..');

/** Resolve only after the Wrangler process closes, including on interruption. */
async function runWrangler(command, args, { maxBuffer, signal }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let failed = false;
    let launchError;
    let killTimer;
    const onAbort = () => {
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > maxBuffer) { failed = true; child.kill(); }
    });
    child.stderr.resume();
    child.on('error', error => { launchError = error; });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (signal?.aborted || launchError || code !== 0 || failed) reject(new Error('Wrangler Hyperdrive readback failed or interrupted'));
      else resolveResult({ stdout });
    });
  });
}

/** Execute the pinned Wrangler JavaScript entry through Node on every platform. */
export function wranglerInvocation(args, projectRoot = root) {
  return {
    command: process.execPath,
    args: [resolve(projectRoot, 'app/node_modules/wrangler/bin/wrangler.js'), ...args]
  };
}

export async function readHyperdrive(id, { signal, runCommand = runWrangler, projectRoot = root } = {}) {
  const invocation = wranglerInvocation(['hyperdrive', 'get', id], projectRoot);
  const { stdout } = await runCommand(invocation.command, invocation.args, { maxBuffer: 1024 * 1024, signal });
  return readWranglerJson(stdout);
}

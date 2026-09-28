import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readWranglerJson } from './wrangler-json.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

/** Execute the pinned Wrangler JavaScript entry through Node on every platform. */
export function wranglerInvocation(args, projectRoot = root) {
  return {
    command: process.execPath,
    args: [resolve(projectRoot, 'app/node_modules/wrangler/bin/wrangler.js'), ...args]
  };
}

export async function readHyperdrive(id, { signal, runCommand = run, projectRoot = root } = {}) {
  const invocation = wranglerInvocation(['hyperdrive', 'get', id], projectRoot);
  const { stdout } = await runCommand(invocation.command, invocation.args, { maxBuffer: 1024 * 1024, signal });
  return readWranglerJson(stdout);
}

import { resolve } from 'node:path';
import { readWranglerJson } from './wrangler-json.mjs';
import { runBoundedCommand } from './bounded-command.mjs';

const root = resolve(import.meta.dirname, '..');

/** Resolve only after the Wrangler process closes, including on interruption. */
const runWrangler = (command, args, options) => runBoundedCommand(command, args,
  { ...options, errorMessage: 'Wrangler Hyperdrive readback failed or interrupted' });

/** Execute the pinned Wrangler JavaScript entry through Node on every platform. */
export function wranglerInvocation(args, projectRoot = root) {
  return {
    command: process.execPath,
    args: [resolve(projectRoot, 'app/node_modules/wrangler/bin/wrangler.js'), ...args]
  };
}

export async function readHyperdrive(id, { signal, runCommand = runWrangler, projectRoot = root } = {}) {
  const invocation = wranglerInvocation(['hyperdrive', 'get', id], projectRoot);
  const { stdout } = await runCommand(invocation.command, invocation.args,
    { maxBuffer: 1024 * 1024, timeout: 30_000, signal });
  return readWranglerJson(stdout);
}

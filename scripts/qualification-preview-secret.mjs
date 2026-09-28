import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const wranglerEntry = resolve(root, 'app/node_modules/wrangler/bin/wrangler.js');
export const wranglerInvocation = (args, entry = wranglerEntry) => ({ command: process.execPath, args: [entry, ...args] });

/** Read one bounded JSON value after optional Wrangler status lines. */
export function readWranglerJson(output) {
  if (output.length > 1024 * 1024) throw new Error('Wrangler response is too large');
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== '{' && output[index] !== '[') continue;
    try { return JSON.parse(output.slice(index)); }
    catch { /* A status line may contain brackets; try the next JSON start. */ }
  }
  throw new Error('Wrangler returned no valid JSON');
}

/** Launch only the pinned project-local Wrangler entry with the trusted Node executable. */
export async function wrangler(args, signal, entry = wranglerEntry) {
  return new Promise((resolveResult, reject) => {
    const invocation = wranglerInvocation(args, entry);
    const child = spawn(invocation.command, invocation.args, {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], signal
    });
    let output = '';
    let launchError;
    let killTimer;
    const onAbort = () => {
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    // Deployment diagnostics can include credential-bearing metadata.
    child.stderr.resume();
    child.on('error', error => { launchError = error; });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (!launchError && code === 0 && !signal?.aborted) resolveResult(output);
      else reject(new Error('Wrangler Preview secret command failed'));
    });
  });
}

/** Own the temporary token file until deployment has exited or been cancelled. */
export async function setupPreview(name, token, { runWrangler = wrangler, signal } = {}) {
  if (!/^s4-[a-f0-9]{40}-[dp]-(apse|use|euw)$/.test(name ?? '') || !token || /[\r\n]/.test(token)) {
    throw new Error('Expected a full-head Preview name and a protected single-line PROBE_TOKEN');
  }
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.name !== name || !config.previews?.secrets?.required?.includes('PROBE_TOKEN')) throw new Error('Preview config does not declare PROBE_TOKEN');
  const target = ['--name', name, '--config', configPath, '--ignore-base-config'];
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-secret-'));
  let deployed;
  try {
    const secretFile = join(directory, 'secrets.json');
    await writeFile(secretFile, JSON.stringify({ PROBE_TOKEN: token }), { mode: 0o600 });
    deployed = readWranglerJson(await runWrangler(['preview', ...target, '--secrets-file', secretFile, '--json'], signal));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const urls = deployed?.preview?.urls;
  if (!Array.isArray(urls) || urls.length === 0 ||
      !urls.every(url => typeof url === 'string' && url.startsWith('https://'))) {
    throw new Error('Preview deployment returned no usable HTTPS URL');
  }
  const listed = readWranglerJson(await runWrangler(['preview', 'secret', 'list', ...target, '--json'], signal));
  if (!Array.isArray(listed) || !listed.some(entry => entry.name === 'PROBE_TOKEN' && entry.type === 'secret_text')) {
    throw new Error('PROBE_TOKEN is absent from the latest Preview deployment');
  }
  if (signal?.aborted) throw new Error('Preview setup interrupted');
  return urls;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const controller = new AbortController();
  let interrupted = false;
  const cancel = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const urls = await setupPreview(process.argv[2], process.env.PROBE_TOKEN, { signal: controller.signal });
    console.log(JSON.stringify({ name: process.argv[2], urls, probeTokenBound: true }));
  } catch (error) {
    let message = 'Preview secret setup failed';
    if (interrupted) message = 'Preview setup interrupted; temporary token removed';
    else if (error instanceof Error) message = error.message;
    console.error(message);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

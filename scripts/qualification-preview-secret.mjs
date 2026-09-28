import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { currentCleanHead, qualificationConfig } from './qualification-artifact.mjs';
import { verifyQualificationTarget } from './qualification-target.mjs';
import { readWranglerJson } from './wrangler-json.mjs';
import { runBoundedCommand } from './bounded-command.mjs';

export { readWranglerJson } from './wrangler-json.mjs';

const root = resolve(import.meta.dirname, '..');
const wranglerEntry = resolve(root, 'app/node_modules/wrangler/bin/wrangler.js');
export const wranglerInvocation = (args, entry = wranglerEntry) => ({ command: process.execPath, args: [entry, ...args] });

/** Launch only the pinned project-local Wrangler entry with the trusted Node executable. */
export async function wrangler(args, signal, entry = wranglerEntry) {
  const invocation = wranglerInvocation(args, entry);
  const { stdout } = await runBoundedCommand(invocation.command, invocation.args, {
    cwd: root, env: process.env, maxBuffer: 1024 * 1024, timeout: 60_000, signal,
    errorMessage: 'Wrangler Preview secret command failed'
  });
  return stdout;
}

/** Own the temporary token file until deployment has exited or been cancelled. */
export async function setupPreview(name, token, { runWrangler = wrangler, verifyTarget = verifyQualificationTarget, signal } = {}) {
  if (!/^s4-[a-f0-9]{40}-[dp]-(apse|use|euw)$/.test(name ?? '') || !token || /[\r\n]/.test(token)) {
    throw new Error('Expected a full-head Preview name and a protected single-line PROBE_TOKEN');
  }
  const configPath = resolve(root, '.data/qualification', `${name}.json`);
  const head = await currentCleanHead(root);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const id = config?.hyperdrive?.[0]?.id;
  const expected = await qualificationConfig(root, name, id, head);
  if (!isDeepStrictEqual(config, expected)) throw new Error('Preview config is not the exact-head qualification artifact');
  await verifyTarget(root, name, head, id, { signal });
  const target = ['--name', name, '--config', configPath, '--ignore-base-config'];
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-secret-'));
  let attempted = false;
  try {
    const secretFile = join(directory, 'secrets.json');
    await writeFile(secretFile, JSON.stringify({ PROBE_TOKEN: token }), { mode: 0o600 });
    attempted = true;
    const deployed = readWranglerJson(await runWrangler(['preview', ...target, '--secrets-file', secretFile, '--json'], signal));
    const urls = deployed?.preview_urls ?? deployed?.preview?.urls;
    const origins = Array.isArray(urls) ? urls.map(url => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
          parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : null;
      } catch { return null; }
    }) : [];
    if (origins.length !== 1 || !origins[0]) {
      throw new Error('Preview deployment returned no usable HTTPS URL');
    }
    const listed = readWranglerJson(await runWrangler(['preview', 'secret', 'list', ...target, '--json'], signal));
    if (!Array.isArray(listed) || !listed.some(entry => entry.name === 'PROBE_TOKEN' && entry.type === 'secret_text')) {
      throw new Error('PROBE_TOKEN is absent from the latest Preview deployment');
    }
    if (signal?.aborted) throw new Error('Preview setup interrupted');
    return urls;
  } catch (error) {
    if (attempted) {
      try { await runWrangler(['preview', 'delete', ...target, '--skip-confirmation', '--json']); }
      catch { throw new Error('Preview setup failed and cleanup failed'); }
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

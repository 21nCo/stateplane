import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [name] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const configPath = resolve(root, '.data/qualification', `${name}.json`);

async function wrangler(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('pnpm', ['--filter', '@stateplane/app', 'exec', 'wrangler', ...args], {
      cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
    // Wrangler errors may include deployment metadata. Do not echo them alongside a protected token.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(output) : reject(new Error('Wrangler Preview secret command failed')));
    child.stdin.end();
  });
}

try {
  if (!/^s4-[a-f0-9]{40}-[dp]-(apse|use|euw)$/.test(name ?? '') || !process.env.PROBE_TOKEN || /[\r\n]/.test(process.env.PROBE_TOKEN)) {
    throw new Error('Expected a full-head Preview name and a protected single-line PROBE_TOKEN');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.name !== name || !config.previews?.secrets?.required?.includes('PROBE_TOKEN')) throw new Error('Preview config does not declare PROBE_TOKEN');
  const target = ['--name', name, '--config', configPath, '--ignore-base-config'];
  const directory = await mkdtemp(join(tmpdir(), 'sta4-preview-secret-'));
  try {
    const secretFile = join(directory, 'secrets.json');
    await writeFile(secretFile, JSON.stringify({ PROBE_TOKEN: process.env.PROBE_TOKEN }), { mode: 0o600 });
    await wrangler(['preview', ...target, '--secrets-file', secretFile, '--json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const listed = JSON.parse(await wrangler(['preview', 'secret', 'list', ...target, '--json']));
  if (!Array.isArray(listed) || !listed.some(entry => entry.name === 'PROBE_TOKEN' && entry.type === 'secret_text')) {
    throw new Error('PROBE_TOKEN is absent from the latest Preview deployment');
  }
  console.log(`PROBE_TOKEN binding verified on Preview ${name}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Preview secret setup failed');
  process.exitCode = 1;
}

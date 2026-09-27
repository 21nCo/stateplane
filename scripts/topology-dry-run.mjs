import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderTopology } from './topology.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
export async function dryRunTopology(topology, { projectRoot = root, runWrangler = run } = {}) {
  const wrangler = resolve(projectRoot, 'app/node_modules/.bin/wrangler');
  if (runWrangler === run) {
    try { await access(resolve(projectRoot, 'app/.svelte-kit/cloudflare/_worker.js')); }
    catch { throw new Error('Build @stateplane/app before topology dry-run'); }
  }
  let count = 0;
  for (const [environment, env] of Object.entries(topology.environments)) {
    const out = resolve(projectRoot, '.data/topology-dry-run', environment);
    await mkdir(out, { recursive: true });
    const ids = environment === 'development' ? ['a', 'b', 'c', 'd'] : ['e', 'f', '1'];
    const inventory = {
      environment,
      control: { hyperdriveId: ids[0].repeat(32), rdsInstanceId: `${env.prefix}-control-db`, network: 'public-tls' },
      cells: Object.fromEntries(env.cells.map((cell, index) => [cell.id, { hyperdriveId: ids[index + 1].repeat(32), rdsInstanceId: `${env.prefix}-${cell.id}-db`, network: 'public-tls' }]))
    };
    const configs = renderTopology(topology, environment, inventory, out, projectRoot);
    for (const [file, config] of Object.entries(configs)) {
      const path = join(out, file);
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      try {
        await runWrangler(wrangler, ['deploy', '--config', path, '--dry-run', '--outdir', join(out, 'bundles', file)], { maxBuffer: 1024 * 1024 });
      } catch (error) {
        throw new Error(`${environment}/${file} dry-run failed: ${error.stderr ?? error.message}`, { cause: error });
      }
      count++;
    }
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
  const count = await dryRunTopology(topology);
  console.log(`Dry-ran ${count} generated Worker configurations with synthetic, non-live resource IDs`);
}

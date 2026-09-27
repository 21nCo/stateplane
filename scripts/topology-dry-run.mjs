import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderTopology } from './topology.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
const wrangler = resolve(root, 'app/node_modules/.bin/wrangler');
let count = 0;
for (const [environment, env] of Object.entries(topology.environments)) {
  const out = resolve(root, '.data/topology', environment);
  await mkdir(out, { recursive: true });
  const ids = environment === 'development' ? ['a', 'b', 'c', 'd'] : ['e', 'f', '1'];
  const inventory = {
    environment,
    control: { hyperdriveId: ids[0].repeat(32), rdsInstanceId: `${env.prefix}-control-db`, network: 'public-tls' },
    cells: Object.fromEntries(env.cells.map((cell, index) => [cell.id, { hyperdriveId: ids[index + 1].repeat(32), rdsInstanceId: `${env.prefix}-${cell.id}-db`, network: 'public-tls' }]))
  };
  const configs = renderTopology(topology, environment, inventory, out);
  for (const [file, config] of Object.entries(configs)) {
    const path = join(out, file);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      await run(wrangler, ['deploy', '--config', path, '--dry-run', '--outdir', join(out, 'bundles', file)], { maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(`${environment}/${file} dry-run failed: ${error.stderr ?? error.message}`, { cause: error });
    }
    count++;
  }
}
console.log(`Dry-ran ${count} generated Worker configurations with synthetic, non-live resource IDs`);

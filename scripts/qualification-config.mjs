import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const [name, hyperdriveId] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
const cellIds = new Set(Object.values(topology.environments).flatMap(environment => environment.cells.map(cell => cell.id)));
const match = /^sta-4-[a-f0-9]{40}-([a-z]+(?:-[a-z]+)*)$/.exec(name ?? '');
if (!match || !cellIds.has(match[1]) || !/^[a-f0-9]{32}$/i.test(hyperdriveId ?? '')) {
  console.error('Usage: node scripts/qualification-config.mjs sta-4-<head>-<cell> <disposable-hyperdrive-id>');
  process.exit(2);
}
const out = resolve(root, '.data/qualification');
await mkdir(out, { recursive: true });
const config = {
  $schema: relative(out, resolve(root, 'app/node_modules/wrangler/config-schema.json')),
  name,
  main: relative(out, resolve(root, 'deployment/workers/qualification.ts')),
  compatibility_date: '2026-09-25',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  hyperdrive: [{ binding: 'AUTHORITY', id: hyperdriveId }],
  vars: { STATEPLANE_DISPOSABLE: '1' },
  previews: {
    hyperdrive: [{ binding: 'AUTHORITY', id: hyperdriveId }],
    vars: { STATEPLANE_DISPOSABLE: '1' }
  }
};
await writeFile(resolve(out, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(relative(root, resolve(out, `${name}.json`)));

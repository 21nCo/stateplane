import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const [name, hyperdriveId] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
const match = /^sta-4-[a-f0-9]{40}-(dev|prod)-([a-z]+(?:-[a-z]+)*)$/.exec(name ?? '');
const environment = { dev: 'development', prod: 'production' }[match?.[1]];
if (!environment || !topology.environments[environment].cells.some(cell => cell.id === match[2]) || !/^[a-f0-9]{32}$/i.test(hyperdriveId ?? '')) {
  console.error('Usage: node scripts/qualification-config.mjs sta-4-<head>-<dev|prod>-<cell> <disposable-hyperdrive-id>');
  process.exit(2);
}
const probeDatabase = `sta4_${match[0].slice(6, 22)}_${match[1]}_${match[2].replaceAll('-', '_')}`;
const probeRole = `sta4_probe_${match[0].slice(6, 22)}`;
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
  vars: { STATEPLANE_DISPOSABLE: '1', STATEPLANE_PROBE_DATABASE: probeDatabase, STATEPLANE_PROBE_ROLE: probeRole },
  previews: {
    hyperdrive: [{ binding: 'AUTHORITY', id: hyperdriveId }],
    vars: { STATEPLANE_DISPOSABLE: '1', STATEPLANE_PROBE_DATABASE: probeDatabase, STATEPLANE_PROBE_ROLE: probeRole }
  }
};
await writeFile(resolve(out, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(relative(root, resolve(out, `${name}.json`)));

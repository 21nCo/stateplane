import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const [name, hyperdriveId] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
const match = /^s4-([a-f0-9]{40})-([dp])-(apse|use|euw)$/.exec(name ?? '');
const environment = { d: 'development', p: 'production' }[match?.[2]];
const cell = { apse: 'ap-southeast', use: 'us-east', euw: 'eu-west' }[match?.[3]];
if (!environment || name.length > 54 || !topology.environments[environment].cells.some(entry => entry.id === cell) || !/^[a-f0-9]{32}$/i.test(hyperdriveId ?? '')) {
  console.error('Usage: node scripts/qualification-config.mjs s4-<full-head>-<d|p>-<apse|use|euw> <disposable-hyperdrive-id> (name <= 54 characters)');
  process.exit(2);
}
const probeDatabase = `sta4_${match[1].slice(0, 16)}_${match[2] === 'd' ? 'dev' : 'prod'}_${cell.replaceAll('-', '_')}`;
const probeRole = `sta4_probe_${match[1].slice(0, 16)}`;
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

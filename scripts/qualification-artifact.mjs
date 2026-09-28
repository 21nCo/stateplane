import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cellIds = { apse: 'ap-southeast', use: 'us-east', euw: 'eu-west' };
const environments = { d: 'development', p: 'production' };

export async function currentCleanHead(root) {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }),
    run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root })
  ]);
  if (!/^[a-f0-9]{40}\n?$/.test(head) || status.trim()) {
    throw new Error('Qualification requires a clean checked-out commit');
  }
  return head.trim();
}

export function qualificationTarget(name, head, topology) {
  const match = /^s4-([a-f0-9]{40})-([dp])-(apse|use|euw)$/.exec(name ?? '');
  const environment = environments[match?.[2]];
  const cell = cellIds[match?.[3]];
  if (!match || match[1] !== head || name.length > 54 ||
      !topology.environments[environment]?.cells.some(entry => entry.id === cell)) {
    throw new Error('Qualification name must identify a declared cell at the clean checked-out head');
  }
  return { environment, cell, shortEnvironment: match[2] };
}

export async function qualificationConfig(root, name, hyperdriveId, head) {
  const topology = JSON.parse(await readFile(resolve(root, 'deployment/topology.json')));
  const { cell, shortEnvironment } = qualificationTarget(name, head, topology);
  if (!/^[a-f0-9]{32}$/i.test(hyperdriveId ?? '')) throw new Error('Disposable Hyperdrive ID is invalid');
  const out = resolve(root, '.data/qualification');
  const database = `sta4_${head.slice(0, 16)}_${shortEnvironment === 'd' ? 'dev' : 'prod'}_${cell.replaceAll('-', '_')}`;
  const role = `sta4_probe_${head.slice(0, 16)}`;
  const bindings = [{ binding: 'AUTHORITY', id: hyperdriveId }];
  const vars = { STATEPLANE_DISPOSABLE: '1', STATEPLANE_PROBE_DATABASE: database, STATEPLANE_PROBE_ROLE: role };
  return {
    $schema: relative(out, resolve(root, 'app/node_modules/wrangler/config-schema.json')),
    name,
    main: relative(out, resolve(root, 'deployment/workers/qualification.ts')),
    compatibility_date: '2026-09-25',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: true,
    secrets: { required: ['PROBE_TOKEN'] },
    hyperdrive: bindings,
    vars,
    previews: { secrets: { required: ['PROBE_TOKEN'] }, hyperdrive: bindings, vars }
  };
}

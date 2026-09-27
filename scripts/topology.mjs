import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hexId = /^[a-f0-9]{32}$/i;
const regionId = /^[a-z]{2}-[a-z]+$/;
const awsRegion = /^[a-z]{2}-[a-z]+-\d$/;
const safeName = /^[a-z][a-z0-9-]*$/;
const rdsDatabaseName = /^[a-z][a-z0-9_]{0,62}$/;
const allowedKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} has unsupported field ${key}`);
};
const check = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique across environments`);
};
export const cellDatabaseName = (env, cell) => `${env.prefix.replaceAll('-', '_')}_${cell.id.replaceAll('-', '_')}`;
const names = (env, cell) => {
  const prefix = env.prefix;
  return {
    database: cell ? cellDatabaseName(env, cell) : env.control.database,
    hyperdrive: `${prefix}-${cell?.id ?? 'control'}-authority`,
    bucket: cell ? `${prefix}-${cell.id}-originals` : undefined,
    queue: cell ? `${prefix}-${cell.id}-projection` : undefined,
    deadLetterQueue: cell ? `${prefix}-${cell.id}-projection-dlq` : undefined,
    api: cell ? `${prefix}-${cell.id}-api` : `${prefix}-app`,
    mcp: cell ? `${prefix}-${cell.id}-mcp` : `${prefix}-mcp`,
    jobs: cell ? `${prefix}-${cell.id}-jobs` : undefined
  };
};

export function validateTopology(topology) {
  allowedKeys(topology, ['version', 'provider', 'environments'], 'topology');
  if (topology.version !== 1 || topology.provider !== 'aws-rds-postgresql') throw new Error('Unsupported topology version or provider');
  allowedKeys(topology.environments, ['development', 'production'], 'environments');
  if (Object.keys(topology.environments).length !== 2) throw new Error('Development and production are required');
  const all = { databases: [], hyperdrives: [], buckets: [], queues: [], workers: [] };
  for (const [environment, env] of Object.entries(topology.environments)) {
    allowedKeys(env, ['prefix', 'control', 'cells'], environment);
    check(env.prefix, safeName, `${environment} prefix`);
    allowedKeys(env.control, ['awsRegion', 'database', 'originConnectionLimit'], `${environment} control`);
    check(env.control.awsRegion, awsRegion, `${environment} control region`);
    check(env.control.database, rdsDatabaseName, `${environment} control database`);
    if (!Number.isSafeInteger(env.control.originConnectionLimit) || env.control.originConnectionLimit < 1) throw new Error(`${environment} control connection limit is invalid`);
    if (!Array.isArray(env.cells) || env.cells.length === 0) throw new Error(`${environment} needs cells`);
    const expected = environment === 'production' ? ['in-south', 'us-east'] : ['in-south', 'us-east', 'eu-west'];
    if (env.cells.map(cell => cell.id).sort().join(',') !== expected.sort().join(',')) throw new Error(`${environment} has incomplete cell pattern`);
    all.databases.push(`${env.control.awsRegion}/${env.control.database}`);
    all.hyperdrives.push(names(env).hyperdrive);
    all.workers.push(names(env).api, names(env).mcp, `${env.prefix}-directory`);
    for (const cell of env.cells) {
      allowedKeys(cell, ['id', 'awsRegion', 'r2LocationHint', 'originConnectionLimit'], `${environment} cell`);
      check(cell.id, regionId, `${environment} cell ID`);
      check(cell.awsRegion, awsRegion, `${environment} cell AWS region`);
      if (!['apac', 'enam', 'weur'].includes(cell.r2LocationHint)) throw new Error(`${environment} cell R2 hint is invalid`);
      if (!Number.isSafeInteger(cell.originConnectionLimit) || cell.originConnectionLimit < 1) throw new Error(`${environment} cell connection limit is invalid`);
      if ({ 'in-south': 'ap-south-1', 'us-east': 'us-east-1', 'eu-west': 'eu-west-1' }[cell.id] !== cell.awsRegion) throw new Error(`${environment} ${cell.id} is mapped to the wrong provider region`);
      const resource = names(env, cell);
      check(resource.database, rdsDatabaseName, `${environment} ${cell.id} RDS database`);
      all.databases.push(`${cell.awsRegion}/${resource.database}`);
      all.hyperdrives.push(resource.hyperdrive);
      all.buckets.push(resource.bucket);
      all.queues.push(resource.queue, resource.deadLetterQueue);
      all.workers.push(resource.api, resource.mcp, resource.jobs);
    }
  }
  for (const [label, values] of Object.entries(all)) unique(values, label);
  return topology;
}

export function validateInventory(topology, environment, inventory) {
  const env = topology.environments[environment];
  if (!env) throw new Error('Unknown environment');
  allowedKeys(inventory, ['environment', 'control', 'cells', 'routes'], 'inventory');
  if (inventory.environment !== environment) throw new Error('Inventory environment mismatch');
  const network = (resource, label) => {
    if (resource.network !== 'public-tls') throw new Error(`${label} network mode is unsupported until private CA trust is proven`);
    if (resource.network === 'public-tls' && resource.vpcServiceId !== undefined) throw new Error(`${label} public network cannot include a VPC service`);
  };
  allowedKeys(inventory.control, ['hyperdriveId', 'rdsInstanceId', 'network', 'vpcServiceId'], 'control inventory');
  check(inventory.control.hyperdriveId, hexId, 'control Hyperdrive ID');
  if (inventory.control.rdsInstanceId !== `${env.prefix}-control-db`) throw new Error('Control RDS instance mismatch');
  network(inventory.control, 'control');
  allowedKeys(inventory.cells, env.cells.map(cell => cell.id), 'cell inventory');
  if (Object.keys(inventory.cells).length !== env.cells.length) throw new Error('Missing cell inventory');
  const ids = [inventory.control.hyperdriveId];
  for (const cell of env.cells) {
    allowedKeys(inventory.cells[cell.id], ['hyperdriveId', 'rdsInstanceId', 'network', 'vpcServiceId'], `${cell.id} inventory`);
    check(inventory.cells[cell.id].hyperdriveId, hexId, `${cell.id} Hyperdrive ID`);
    if (inventory.cells[cell.id].rdsInstanceId !== `${env.prefix}-${cell.id}-db`) throw new Error(`${cell.id} RDS instance mismatch`);
    network(inventory.cells[cell.id], cell.id);
    ids.push(inventory.cells[cell.id].hyperdriveId);
  }
  unique(ids, 'Hyperdrive IDs');
  if (inventory.routes !== undefined) {
    allowedKeys(inventory.routes, ['app', 'mcp'], 'routes');
    for (const key of ['app', 'mcp']) {
      if (typeof inventory.routes[key] !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(inventory.routes[key])) throw new Error(`Invalid ${key} route`);
    }
    if (inventory.routes.app === inventory.routes.mcp) throw new Error('Public routes must differ');
  }
  return inventory;
}

const workerPath = (out, path) => relative(out, resolve(root, path));
const service = (binding, name) => ({ binding, service: name });
const common = (out, name, main, role, environment) => ({
  $schema: workerPath(out, 'app/node_modules/wrangler/config-schema.json'),
  name,
  main: workerPath(out, main),
  compatibility_date: '2026-09-25',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  vars: { STATEPLANE_ENV: environment, STATEPLANE_ROLE: role }
});
const binding = (id) => [{ binding: 'AUTHORITY', id }];

export function renderTopology(topology, environment, inventory, out) {
  validateTopology(topology);
  validateInventory(topology, environment, inventory);
  const env = topology.environments[environment];
  const output = {};
  const local = names(env);
  const apiBindings = env.cells.map(cell => service(`CELL_${cell.id.replaceAll('-', '_').toUpperCase()}_API`, names(env, cell).api));
  const mcpBindings = env.cells.map(cell => service(`CELL_${cell.id.replaceAll('-', '_').toUpperCase()}_MCP`, names(env, cell).mcp));
  output['app.json'] = {
    ...common(out, local.api, 'app/.svelte-kit/cloudflare/_worker.js', 'gateway-app', environment),
    assets: { binding: 'ASSETS', directory: workerPath(out, 'app/.svelte-kit/cloudflare') },
    services: [service('DIRECTORY', `${env.prefix}-directory`), ...apiBindings]
  };
  output['mcp.json'] = {
    ...common(out, local.mcp, 'deployment/workers/gateway.ts', 'gateway-mcp', environment),
    services: [service('DIRECTORY', `${env.prefix}-directory`), ...mcpBindings]
  };
  if (inventory.routes) {
    for (const [key, route] of Object.entries(inventory.routes)) output[`${key}.json`].routes = [{ pattern: new URL(route).host, custom_domain: true }];
  }
  output['directory.json'] = {
    ...common(out, `${env.prefix}-directory`, 'deployment/workers/directory.ts', 'directory', environment),
    hyperdrive: binding(inventory.control.hyperdriveId)
  };
  for (const cell of env.cells) {
    const n = names(env, cell);
    const id = inventory.cells[cell.id].hyperdriveId;
    const suffix = cell.id;
    const regional = (name, role) => ({
      ...common(out, name, 'deployment/workers/cell.ts', role, environment),
      placement: { mode: 'smart' },
      vars: { STATEPLANE_ENV: environment, STATEPLANE_ROLE: role, STATEPLANE_CELL: cell.id },
      hyperdrive: binding(id),
      r2_buckets: [{ binding: 'ORIGINALS', bucket_name: n.bucket }],
      queues: { producers: [{ binding: 'PROJECTION_JOBS', queue: n.queue }] }
    });
    output[`${suffix}-api.json`] = regional(n.api, 'cell-api');
    output[`${suffix}-mcp.json`] = regional(n.mcp, 'cell-mcp');
    output[`${suffix}-jobs.json`] = {
      ...common(out, n.jobs, 'deployment/workers/jobs.ts', 'cell-jobs', environment),
      placement: { mode: 'smart' },
      vars: { STATEPLANE_ENV: environment, STATEPLANE_ROLE: 'cell-jobs', STATEPLANE_CELL: cell.id },
      hyperdrive: binding(id),
      r2_buckets: [{ binding: 'ORIGINALS', bucket_name: n.bucket }],
      queues: { consumers: [{ queue: n.queue, max_batch_size: 1, max_retries: 3, dead_letter_queue: n.deadLetterQueue }] }
    };
  }
  return output;
}

async function main() {
  const [command, environment, inventoryPath] = process.argv.slice(2);
  const topology = validateTopology(JSON.parse(await readFile(resolve(root, 'deployment/topology.json'), 'utf8')));
  if (command === 'validate' && !environment && !inventoryPath) {
    console.log('Topology valid: development 3 cells, production 2 cells');
    return;
  }
  if (command !== 'render' || !environment || !inventoryPath) throw new Error('Usage: node scripts/topology.mjs validate | render <environment> <private-inventory.json>');
  const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
  const out = resolve(root, '.data/topology', environment);
  const configs = renderTopology(topology, environment, inventory, out);
  await mkdir(out, { recursive: true });
  for (const [file, config] of Object.entries(configs)) await writeFile(join(out, file), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Rendered ${Object.keys(configs).length} ${environment} Worker configs in ${relative(root, out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

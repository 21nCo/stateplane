import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validVolumePath } from './topology-live.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hexId = /^[a-f0-9]{32}$/i;
const regionId = /^[a-z]{2}-[a-z]+$/;
const railwayRegion = /^[a-z]+(?:-[a-z0-9]+)+$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const safeName = /^[a-z][a-z0-9-]*$/;
const postgresDatabaseName = /^[a-z][a-z0-9_]{0,62}$/;
const postgresRoleName = /^[a-z][a-z0-9_]{0,62}$/;
const postgresImage = /^[a-z0-9][a-z0-9./_-]*:(?:[a-z0-9._-]+)$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/i;
const cloudflareName = /^[a-z][a-z0-9-]{0,62}$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Hyperdrive permits 5-20 origin connections on Free and 5-100 on Paid.
// The manifest does not attest a Workers plan, so admit only the shared range.
const validOriginConnectionLimit = value => Number.isSafeInteger(value) && value >= 5 && value <= 20;
const cellPlacement = {
  'ap-southeast': { railwayRegion: 'asia-southeast1-eqsg3a', r2LocationHint: 'apac' },
  'us-east': { railwayRegion: 'us-east4-eqdc4a', r2LocationHint: 'enam' },
  'eu-west': { railwayRegion: 'europe-west4-drams3a', r2LocationHint: 'weur' }
};
const allowedKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} has unsupported field ${key}`);
};
const check = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
};
const unique = (values, label) => {
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) throw new Error(`${label} must be unique across environments`);
};
export const cellDatabaseName = (env, cell) => `${env.prefix.replaceAll('-', '_')}_${cell.id.replaceAll('-', '_')}`;
export const railwayServiceName = (env, cell) => `${env.prefix}-${cell?.id ?? 'control'}-db`;
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

function assertDerivedNames(environment, resource) {
  check(resource.database, postgresDatabaseName, `${environment} PostgreSQL database`);
  for (const [kind, name] of Object.entries(resource)) {
    if (kind !== 'database' && name !== undefined) check(name, cloudflareName, `${environment} ${kind} name`);
  }
}

function validateEnvironment(environment, env, all) {
  allowedKeys(env, ['prefix', 'control', 'cells'], environment);
  check(env.prefix, safeName, `${environment} prefix`);
  allowedKeys(env.control, ['railwayRegion', 'database', 'originConnectionLimit'], `${environment} control`);
  check(env.control.railwayRegion, railwayRegion, `${environment} control region`);
  if (env.control.railwayRegion !== 'us-east4-eqdc4a') throw new Error(`${environment} control is mapped to the wrong provider region`);
  check(env.control.database, postgresDatabaseName, `${environment} control database`);
  if (!validOriginConnectionLimit(env.control.originConnectionLimit)) throw new Error(`${environment} control connection limit is invalid`);
  if (!Array.isArray(env.cells) || env.cells.length === 0) throw new Error(`${environment} needs cells`);
  const expected = environment === 'production' ? ['ap-southeast', 'us-east'] : ['ap-southeast', 'eu-west', 'us-east'];
  const actual = env.cells.map(cell => cell?.id);
  actual.sort((a, b) => String(a).localeCompare(String(b)));
  expected.sort((a, b) => a.localeCompare(b));
  if (actual.join(',') !== expected.join(',')) throw new Error(`${environment} has incomplete cell pattern`);
  assertDerivedNames(environment, names(env));
  check(railwayServiceName(env), cloudflareName, `${environment} control Railway service name`);
  const directory = `${env.prefix}-directory`;
  check(directory, cloudflareName, `${environment} directory name`);
  all.databases.push(`${env.control.railwayRegion}/${env.control.database}`);
  all.hyperdrives.push(names(env).hyperdrive);
  all.workers.push(names(env).api, names(env).mcp, directory);
  for (const cell of env.cells) validateCell(environment, env, cell, all);
}

function validateCell(environment, env, cell, all) {
  allowedKeys(cell, ['id', 'railwayRegion', 'r2LocationHint', 'originConnectionLimit'], `${environment} cell`);
  check(cell.id, regionId, `${environment} cell ID`);
  check(cell.railwayRegion, railwayRegion, `${environment} cell Railway region`);
  if (cell.r2LocationHint !== cellPlacement[cell.id]?.r2LocationHint) throw new Error(`${environment} ${cell.id} R2 hint differs from placement policy`);
  if (!validOriginConnectionLimit(cell.originConnectionLimit)) throw new Error(`${environment} cell connection limit is invalid`);
  if (cellPlacement[cell.id]?.railwayRegion !== cell.railwayRegion) throw new Error(`${environment} ${cell.id} is mapped to the wrong provider region`);
  const resource = names(env, cell);
  assertDerivedNames(`${environment} ${cell.id}`, resource);
  check(railwayServiceName(env, cell), cloudflareName, `${environment} ${cell.id} Railway service name`);
  all.databases.push(`${cell.railwayRegion}/${resource.database}`);
  all.hyperdrives.push(resource.hyperdrive);
  all.buckets.push(resource.bucket);
  all.queues.push(resource.queue, resource.deadLetterQueue);
  all.workers.push(resource.api, resource.mcp, resource.jobs);
}

/** Validate the complete cell pattern and every derived provider resource name. */
export function validateTopology(topology) {
  allowedKeys(topology, ['version', 'provider', 'environments'], 'topology');
  if (topology.version !== 2 || topology.provider !== 'railway-postgresql') throw new Error('Unsupported topology version or provider');
  allowedKeys(topology.environments, ['development', 'production'], 'environments');
  if (Object.keys(topology.environments).length !== 2) throw new Error('Development and production are required');
  const all = { databases: [], hyperdrives: [], buckets: [], queues: [], workers: [] };
  for (const [environment, env] of Object.entries(topology.environments)) validateEnvironment(environment, env, all);
  for (const [label, values] of Object.entries(all)) unique(values, label);
  return topology;
}

/**
 * Return the unchanged hostname of a bare HTTPS DNS authority suitable for a
 * Cloudflare custom domain. A numeric final label can be parsed as an IP
 * address by URL consumers. Ownership and resolution require a live check.
 */
function publicRouteHost(route) {
  if (typeof route !== 'string' || !route.startsWith('https://')) return null;
  const host = route.slice('https://'.length);
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every(label => dnsLabel.test(label)) || !/[a-z]/.test(labels.at(-1))) return null;
  try {
    if (new URL(route).host !== host) return null;
  } catch {
    return null;
  }
  return host;
}

/** Validate private resource IDs and optional public routes before rendering. */
export function validateInventory(topology, environment, inventory) {
  const env = topology.environments[environment];
  if (!env) throw new Error('Unknown environment');
  allowedKeys(inventory, ['environment', 'projectId', 'environmentId', 'control', 'cells', 'routes'], 'inventory');
  if (inventory.environment !== environment) throw new Error('Inventory environment mismatch');
  check(inventory.projectId, uuid, 'Railway project ID');
  check(inventory.environmentId, uuid, 'Railway environment ID');
  const resourceIds = [];
  const validateResource = (resource, label) => {
    allowedKeys(resource, ['hyperdriveId', 'serviceId', 'volumeInstanceId', 'volumeMountPath', 'network', 'postgresImage', 'postgresImageDigest', 'databaseRole'], `${label} inventory`);
    check(resource.hyperdriveId, hexId, `${label} Hyperdrive ID`);
    check(resource.serviceId, uuid, `${label} Railway service ID`);
    check(resource.volumeInstanceId, uuid, `${label} Railway volume instance ID`);
    if (!validVolumePath(resource.volumeMountPath)) throw new Error(`${label} Railway volume mount path is invalid`);
    check(resource.postgresImage, postgresImage, `${label} pinned PostgreSQL image`);
    check(resource.postgresImageDigest, imageDigest, `${label} approved PostgreSQL image digest`);
    check(resource.databaseRole, postgresRoleName, `${label} PostgreSQL role`);
    if (resource.network !== 'public-tls') throw new Error(`${label} network mode is unsupported until verified private connectivity is available`);
    resourceIds.push(resource.serviceId, resource.volumeInstanceId);
  };
  validateResource(inventory.control, 'control');
  allowedKeys(inventory.cells, env.cells.map(cell => cell.id), 'cell inventory');
  if (Object.keys(inventory.cells).length !== env.cells.length) throw new Error('Missing cell inventory');
  const ids = [inventory.control.hyperdriveId];
  for (const cell of env.cells) {
    validateResource(inventory.cells[cell.id], cell.id);
    ids.push(inventory.cells[cell.id].hyperdriveId);
  }
  unique(resourceIds, 'Railway service and volume IDs');
  unique(ids, 'Hyperdrive IDs');
  if (inventory.routes !== undefined) {
    allowedKeys(inventory.routes, ['app', 'mcp'], 'routes');
    for (const key of ['app', 'mcp']) {
      if (publicRouteHost(inventory.routes[key]) === null) throw new Error(`Invalid ${key} route`);
    }
    if (inventory.routes.app === inventory.routes.mcp) throw new Error('Public routes must differ');
  }
  return inventory;
}

/** Reject a provider environment or binding accidentally shared across dev/prod. */
export function validateDeploymentInventories(topology, development, production) {
  validateInventory(topology, 'development', development);
  validateInventory(topology, 'production', production);
  const values = inventory => [inventory.projectId, inventory.environmentId,
    ...[inventory.control, ...Object.values(inventory.cells)].flatMap(resource =>
      [resource.serviceId, resource.volumeInstanceId, resource.hyperdriveId])];
  unique([...values(development), ...values(production)], 'Development and production resource IDs');
  const routes = [development, production].flatMap(inventory =>
    inventory.routes ? Object.values(inventory.routes).map(publicRouteHost) : []);
  unique(routes, 'Public route hosts');
}

const workerPath = (out, path, projectRoot) => relative(out, resolve(projectRoot, path));
const service = (binding, name) => ({ binding, service: name });
const common = (out, name, main, role, environment, projectRoot) => ({
  $schema: workerPath(out, 'app/node_modules/wrangler/config-schema.json', projectRoot),
  name,
  main: workerPath(out, main, projectRoot),
  compatibility_date: '2026-09-25',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  vars: { STATEPLANE_ENV: environment, STATEPLANE_ROLE: role }
});
const binding = (id) => [{ binding: 'AUTHORITY', id }];

/** Render validated per-environment Worker configs without embedding secrets. */
export function renderTopology(topology, environment, inventory, counterpart, out, projectRoot = root) {
  validateTopology(topology);
  if (environment === 'development') validateDeploymentInventories(topology, inventory, counterpart);
  else if (environment === 'production') validateDeploymentInventories(topology, counterpart, inventory);
  else throw new Error('Unknown environment');
  const env = topology.environments[environment];
  const output = {};
  const local = names(env);
  const apiBindings = env.cells.map(cell => service(`CELL_${cell.id.replaceAll('-', '_').toUpperCase()}_API`, names(env, cell).api));
  const mcpBindings = env.cells.map(cell => service(`CELL_${cell.id.replaceAll('-', '_').toUpperCase()}_MCP`, names(env, cell).mcp));
  output['app.json'] = {
    ...common(out, local.api, 'app/.svelte-kit/cloudflare/_worker.js', 'gateway-app', environment, projectRoot),
    assets: { binding: 'ASSETS', directory: workerPath(out, 'app/.svelte-kit/cloudflare', projectRoot) },
    services: [service('DIRECTORY', `${env.prefix}-directory`), ...apiBindings]
  };
  output['mcp.json'] = {
    ...common(out, local.mcp, 'deployment/workers/gateway.ts', 'gateway-mcp', environment, projectRoot),
    services: [service('DIRECTORY', `${env.prefix}-directory`), ...mcpBindings]
  };
  if (inventory.routes) {
    for (const [key, route] of Object.entries(inventory.routes)) output[`${key}.json`].routes = [{ pattern: publicRouteHost(route), custom_domain: true }];
  }
  output['directory.json'] = {
    ...common(out, `${env.prefix}-directory`, 'deployment/workers/directory.ts', 'directory', environment, projectRoot),
    hyperdrive: binding(inventory.control.hyperdriveId)
  };
  for (const cell of env.cells) {
    const n = names(env, cell);
    const id = inventory.cells[cell.id].hyperdriveId;
    const suffix = cell.id;
    const regional = (name, role) => ({
      ...common(out, name, 'deployment/workers/cell.ts', role, environment, projectRoot),
      placement: { mode: 'smart' },
      vars: { STATEPLANE_ENV: environment, STATEPLANE_ROLE: role, STATEPLANE_CELL: cell.id },
      hyperdrive: binding(id),
      r2_buckets: [{ binding: 'ORIGINALS', bucket_name: n.bucket }],
      queues: { producers: [{ binding: 'PROJECTION_JOBS', queue: n.queue }] }
    });
    output[`${suffix}-api.json`] = regional(n.api, 'cell-api');
    output[`${suffix}-mcp.json`] = regional(n.mcp, 'cell-mcp');
    output[`${suffix}-jobs.json`] = {
      ...common(out, n.jobs, 'deployment/workers/jobs.ts', 'cell-jobs', environment, projectRoot),
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
  const [command, environment, inventoryPath, counterpartPath] = process.argv.slice(2);
  const topology = validateTopology(JSON.parse(await readFile(resolve(root, 'deployment/topology.json'), 'utf8')));
  if (command === 'validate' && !environment && !inventoryPath) {
    console.log('Topology valid: development 3 cells, production 2 cells');
    return;
  }
  if (command === 'compare' && environment && inventoryPath) {
    const development = JSON.parse(await readFile(resolve(environment), 'utf8'));
    const production = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
    validateDeploymentInventories(topology, development, production);
    console.log('Development and production inventories are isolated');
    return;
  }
  if (command === 'compare') throw new Error('Usage: node scripts/topology.mjs compare <development-inventory.json> <production-inventory.json>');
  if (command !== 'render' || !environment || !inventoryPath || !counterpartPath) throw new Error('Usage: node scripts/topology.mjs validate | render <environment> <private-inventory.json> <counterpart-inventory.json>');
  const inventory = JSON.parse(await readFile(resolve(inventoryPath), 'utf8'));
  const counterpart = JSON.parse(await readFile(resolve(counterpartPath), 'utf8'));
  const out = resolve(root, '.data/topology', environment);
  const configs = renderTopology(topology, environment, inventory, counterpart, out);
  await mkdir(out, { recursive: true });
  for (const [file, config] of Object.entries(configs)) await writeFile(join(out, file), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Rendered ${Object.keys(configs).length} ${environment} Worker configs in ${relative(root, out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

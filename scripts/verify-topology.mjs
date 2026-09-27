import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateTopology, validateInventory, cellDatabaseName } from './topology.mjs';
import { assertLiveResources } from './topology-live.mjs';
import { createVpcServiceReader } from './cloudflare-vpc.mjs';

const run = promisify(execFile);
const [environment, inventoryPath] = process.argv.slice(2);
if (!environment || !inventoryPath) {
  console.error('Usage: node scripts/verify-topology.mjs <environment> <private-inventory.json>');
  process.exit(2);
}

const topology = validateTopology(JSON.parse(await readFile(new URL('../deployment/topology.json', import.meta.url))));
const inventory = validateInventory(topology, environment, JSON.parse(await readFile(resolve(inventoryPath))));
const env = topology.environments[environment];
const wrangler = resolve(import.meta.dirname, '../app/node_modules/.bin/wrangler');
let readVpcService;

async function json(binary, args) {
  const { stdout } = await run(binary, args, { maxBuffer: 1024 * 1024 });
  // Wrangler prints a version banner before the JSON object.
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`${binary} returned no JSON`);
  return JSON.parse(stdout.slice(start));
}

async function verify(label, definition, resource, database) {
  const [hyperdrive, rds] = await Promise.all([
    json(wrangler, ['hyperdrive', 'get', resource.hyperdriveId]),
    json('aws', ['rds', 'describe-db-instances', '--region', definition.awsRegion, '--db-instance-identifier', resource.rdsInstanceId, '--output', 'json'])
  ]);
  const instance = rds.DBInstances?.[0];
  const vpcService = resource.network === 'workers-vpc' ? await readVpcService(resource.vpcServiceId) : undefined;
  assertLiveResources(label, environment, definition, resource, database, hyperdrive, instance, vpcService);
  console.log(`${label}: ${definition.awsRegion} RDS available, PITR ${instance.BackupRetentionPeriod}d, Hyperdrive fresh-read cache disabled, ${resource.network} TLS verified, origin limit ${definition.originConnectionLimit}`);
}

try {
  if ([inventory.control, ...Object.values(inventory.cells)].some(resource => resource.network === 'workers-vpc')) {
    readVpcService = await createVpcServiceReader(wrangler);
  }
  await verify('control', env.control, inventory.control, env.control.database);
  for (const cell of env.cells) await verify(cell.id, cell, inventory.cells[cell.id], cellDatabaseName(env, cell));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown verification failure');
  process.exitCode = 1;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateTopology, validateInventory, cellDatabaseName } from './topology.mjs';
import { assertLiveResources } from './topology-live.mjs';
import { selectRdsRoot, assertUploadedRdsRoot } from './rds-ca.mjs';

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
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !apiToken) throw new Error('Cloudflare account ID and protected API token required for CA verification');

const rangesResponse = await fetch('https://api.cloudflare.com/client/v4/ips');
if (!rangesResponse.ok) throw new Error(`Cloudflare IP ranges HTTP ${rangesResponse.status}`);
const rangesBody = await rangesResponse.json();
if (rangesBody.success !== true) throw new Error('Cloudflare IP ranges unavailable');
const approvedCidrs = rangesBody.result;

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
  const ids = instance?.VpcSecurityGroups?.map(group => group.VpcSecurityGroupId) ?? [];
  const groups = ids.length ? await json('aws', ['ec2', 'describe-security-groups', '--region', definition.awsRegion, '--group-ids', ...ids, '--output', 'json']) : undefined;
  assertLiveResources({ label, environment, definition, resource, database, hyperdrive, instance, securityGroups: groups?.SecurityGroups, approvedCidrs });
  const bundleResponse = await fetch(`https://truststore.pki.rds.amazonaws.com/${definition.awsRegion}/${definition.awsRegion}-bundle.pem`);
  if (!bundleResponse.ok) throw new Error(`${label}: regional RDS CA bundle unavailable`);
  const expectedRoot = selectRdsRoot(await bundleResponse.text(), definition.awsRegion, instance.CACertificateIdentifier);
  const certificateResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/mtls_certificates/${hyperdrive.mtls.ca_certificate_id}`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  if (!certificateResponse.ok) throw new Error(`${label}: uploaded Cloudflare CA lookup failed`);
  const uploaded = await certificateResponse.json();
  if (uploaded.success !== true) throw new Error(`${label}: uploaded Cloudflare CA lookup failed`);
  assertUploadedRdsRoot(uploaded.result, expectedRoot);
  console.log(`${label}: ${definition.awsRegion} RDS available, PITR ${instance.BackupRetentionPeriod}d, Hyperdrive cache disabled, ${resource.network} CA matched, origin limit ${definition.originConnectionLimit}; connection untested`);
}

try {
  await verify('control', env.control, inventory.control, env.control.database);
  for (const cell of env.cells) await verify(cell.id, cell, inventory.cells[cell.id], cellDatabaseName(env, cell));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown verification failure');
  process.exitCode = 1;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { verifySqlIdentity } from './topology-sql.mjs';
import { validateTopology, validateInventory, cellDatabaseName, railwayServiceName } from './topology.mjs';
import { assertLiveResources } from './topology-live.mjs';

const run = promisify(execFile);
const [environment, inventoryPath] = process.argv.slice(2);
if (!environment || !inventoryPath) {
  console.error('Usage: node scripts/verify-topology.mjs <environment> <private-inventory.json>');
  process.exit(2);
}
const account = process.env.STATEPLANE_RAILWAY_ACCOUNT;
if (!account) throw new Error('STATEPLANE_RAILWAY_ACCOUNT must select a connected Composio Railway account');
const topology = validateTopology(JSON.parse(await readFile(new URL('../deployment/topology.json', import.meta.url))));
const inventory = validateInventory(topology, environment, JSON.parse(await readFile(resolve(inventoryPath))));
if (!process.env.STATEPLANE_SQL_URLS_FILE) throw new Error('STATEPLANE_SQL_URLS_FILE must select protected per-resource SQL URLs');
const sqlUrlsPath = resolve(process.env.STATEPLANE_SQL_URLS_FILE);
if ((await stat(sqlUrlsPath)).mode & 0o077) throw new Error('Protected SQL URL file must be mode 0600');
const sqlUrls = JSON.parse(await readFile(sqlUrlsPath, 'utf8'));
const env = topology.environments[environment];
const wrangler = resolve(import.meta.dirname, '../app/node_modules/.bin/wrangler');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !apiToken) throw new Error('Protected Cloudflare account ID and API token required for CA readback');

const providerQuery = `query ReadCell($projectId: String!, $serviceId: String!, $environmentId: String!, $volumeInstanceId: String!, $targetTimestamp: DateTime!) {
  regions(projectId: $projectId) { name }
  service(id: $serviceId) { id name projectId deletedAt }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { serviceId environmentId region deletedAt source { image repo } latestDeployment { status meta } }
  volumeInstance(id: $volumeInstanceId) { id serviceId environmentId region deletedAt isPendingDeletion }
  volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) { id retentionSeconds }
  volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) { id createdAt expiresAt }
  volumeInstancePitrRestoreEstimate(volumeInstanceId: $volumeInstanceId, targetTimestamp: $targetTimestamp) { baseBackupLabel likelyToFit }
  tcpProxies(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId applicationPort domain proxyPort deletedAt }
}`;

async function railway(resource) {
  const payload = JSON.stringify({ query: providerQuery, variables: {
    projectId: inventory.projectId, serviceId: resource.serviceId, environmentId: inventory.environmentId, volumeInstanceId: resource.volumeInstanceId,
    targetTimestamp: new Date(Date.now() - 15 * 60_000).toISOString()
  } });
  const { stdout } = await run('composio', ['proxy', 'https://backboard.railway.com/graphql/v2', '--toolkit', 'railway', '--account', account,
    '-X', 'POST', '-H', 'content-type: application/json', '-d', payload], { maxBuffer: 1024 * 1024 });
  const response = JSON.parse(stdout);
  if (response.errors?.length || !response.data) throw new Error('Connected Railway provider readback failed');
  return { ...response.data, backupSchedules: response.data.volumeInstanceBackupScheduleList,
    backups: response.data.volumeInstanceBackupList, pitrEstimate: response.data.volumeInstancePitrRestoreEstimate };
}

async function hyperdrive(id) {
  const { stdout } = await run(wrangler, ['hyperdrive', 'get', id], { maxBuffer: 1024 * 1024 });
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('Wrangler Hyperdrive readback has no JSON');
  return JSON.parse(stdout.slice(start));
}

async function verifyUploadedCa(id) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/mtls_certificates/${id}`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  if (!response.ok) throw new Error('Uploaded Hyperdrive CA certificate is unavailable');
  const body = await response.json();
  if (body.success !== true || body.result?.id !== id || body.result?.ca !== true ||
      typeof body.result.certificates !== 'string' || !body.result.certificates.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Uploaded Hyperdrive CA certificate is unavailable');
  }
  const blocks = body.result.certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1 || Date.parse(new X509Certificate(blocks[0]).validTo) <= Date.now()) {
    throw new Error('Uploaded Hyperdrive CA must be one unexpired certificate');
  }
  return blocks[0];
}

async function verify(label, definition, resource, database, serviceName) {
  const [railwayReadback, hyperdriveReadback] = await Promise.all([railway(resource), hyperdrive(resource.hyperdriveId)]);
  if (!railwayReadback.regions?.some(region => region.name === definition.railwayRegion)) throw new Error(`${label}: target Railway region unavailable to project`);
  assertLiveResources({ label, environment, definition, resource, database, serviceName,
    projectId: inventory.projectId, environmentId: inventory.environmentId, railway: railwayReadback, hyperdrive: hyperdriveReadback });
  const ca = await verifyUploadedCa(hyperdriveReadback.mtls.ca_certificate_id);
  await verifySqlIdentity(label, resource, database, railwayReadback.tcpProxies[0], ca, sqlUrls[label]);
  console.log(`${label}: Railway ${definition.railwayRegion} service/volume, backup and PITR estimate, pinned PostgreSQL image, verified-TLS SQL identity/pgvector and cache-disabled Hyperdrive limit ${definition.originConnectionLimit}; Worker transaction and restore drill still required`);
}

try {
  await verify('control', env.control, inventory.control, env.control.database, railwayServiceName(env));
  for (const cell of env.cells) await verify(cell.id, cell, inventory.cells[cell.id], cellDatabaseName(env, cell), railwayServiceName(env, cell));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown verification failure');
  process.exitCode = 1;
}

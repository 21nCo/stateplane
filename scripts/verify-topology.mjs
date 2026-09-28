import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProtectedSqlUrls, verifySqlIdentity, verifyPgdataPlacement } from './topology-sql.mjs';
import { validateTopology, validateInventory, cellDatabaseName, railwayServiceName, readProtectedDeploymentInventory } from './topology.mjs';
import { assertLiveResources } from './topology-live.mjs';
import { readUploadedCa } from './topology-ca.mjs';
import { readHyperdrive } from './wrangler-command.mjs';
import { verifyOperationalBinding } from './operational-binding.mjs';
import { verifyBindingPreflight } from './topology-verification-flow.mjs';

const run = promisify(execFile);
const [environment, inventoryPath] = process.argv.slice(2);
if (!environment || !inventoryPath) {
  console.error('Usage: node scripts/verify-topology.mjs <environment> <private-inventory.json>');
  process.exit(2);
}
const account = process.env.STATEPLANE_RAILWAY_ACCOUNT;
if (!account) throw new Error('STATEPLANE_RAILWAY_ACCOUNT must select a connected Composio Railway account');
const topology = validateTopology(JSON.parse(await readFile(new URL('../deployment/topology.json', import.meta.url))));
const inventory = validateInventory(topology, environment, await readProtectedDeploymentInventory(resolve(inventoryPath)));
if (!process.env.STATEPLANE_SQL_URLS_FILE) throw new Error('STATEPLANE_SQL_URLS_FILE must select protected per-resource SQL URLs');
if (!process.env.STATEPLANE_PGDATA_URLS_FILE) throw new Error('STATEPLANE_PGDATA_URLS_FILE must select protected per-resource settings SQL URLs');
if (!process.env.PROBE_TOKEN || /[\r\n]/.test(process.env.PROBE_TOKEN)) throw new Error('Protected single-line PROBE_TOKEN required for operational Worker proof');
const sqlUrlsPath = resolve(process.env.STATEPLANE_SQL_URLS_FILE);
const sqlUrls = await readProtectedSqlUrls(sqlUrlsPath);
const pgdataUrls = await readProtectedSqlUrls(resolve(process.env.STATEPLANE_PGDATA_URLS_FILE));
const env = topology.environments[environment];

const providerQuery = `query ReadCell($projectId: String!, $serviceId: String!, $environmentId: String!, $volumeInstanceId: String!, $targetTimestamp: DateTime!) {
  regions(projectId: $projectId) { name }
  service(id: $serviceId) { id name projectId deletedAt }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { serviceId environmentId region deletedAt source { image repo } latestDeployment { status meta } }
  volumeInstance(id: $volumeInstanceId) { id serviceId environmentId region mountPath deletedAt isPendingDeletion }
  volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) { id retentionSeconds }
  volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) { id externalId createdAt expiresAt usedMB referencedMB volumeInstanceSizeMB }
  volumeInstancePitrRestoreEstimate(volumeInstanceId: $volumeInstanceId, targetTimestamp: $targetTimestamp) { baseBackupLabel likelyToFit }
  tcpProxies(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId applicationPort domain proxyPort deletedAt }
}`;

async function railway(resource, signal) {
  const payload = JSON.stringify({ query: providerQuery, variables: {
    projectId: inventory.projectId, serviceId: resource.serviceId, environmentId: inventory.environmentId, volumeInstanceId: resource.volumeInstanceId,
    targetTimestamp: new Date(Date.now() - 15 * 60_000).toISOString()
  } });
  const { stdout } = await run('composio', ['proxy', 'https://backboard.railway.com/graphql/v2', '--toolkit', 'railway', '--account', account,
    '-X', 'POST', '-H', 'content-type: application/json', '-d', payload],
  { maxBuffer: 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', signal });
  const response = JSON.parse(stdout);
  if (response.errors?.length || !response.data) throw new Error('Connected Railway provider readback failed');
  return { ...response.data, backupSchedules: response.data.volumeInstanceBackupScheduleList,
    backups: response.data.volumeInstanceBackupList, pitrEstimate: response.data.volumeInstancePitrRestoreEstimate };
}

async function hyperdrive(id, signal) {
  const value = await readHyperdrive(id, { signal });
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Wrangler Hyperdrive readback is invalid');
  return value;
}

async function verify(label, definition, resource, database, serviceName) {
  const worker = await verifyBindingPreflight(controller.signal, {
    railway: () => railway(resource, controller.signal),
    hyperdrive: () => hyperdrive(resource.hyperdriveId, controller.signal),
    validate: (railwayReadback, hyperdriveReadback) => {
      if (!railwayReadback.regions?.some(region => region.name === definition.railwayRegion)) throw new Error(`${label}: target Railway region unavailable to project`);
      assertLiveResources({ label, environment, definition, resource, database, serviceName,
        projectId: inventory.projectId, environmentId: inventory.environmentId, railway: railwayReadback, hyperdrive: hyperdriveReadback });
    },
    ca: hyperdriveReadback => readUploadedCa(hyperdriveReadback.mtls.ca_certificate_id, controller.signal),
    sql: async (railwayReadback, _hyperdriveReadback, ca) => {
      const proxy = railwayReadback.tcpProxies[0];
      await verifyPgdataPlacement({ label, volumeInstance: railwayReadback.volumeInstance,
        mountPath: resource.volumeMountPath, database, proxy, ca, value: pgdataUrls[label],
        operationalRole: resource.databaseRole, projectId: inventory.projectId,
        environmentId: inventory.environmentId, serviceId: resource.serviceId, signal: controller.signal });
      await verifySqlIdentity({ label, resource, database, proxy, ca, value: sqlUrls[label], signal: controller.signal });
    },
    worker: () => verifyOperationalBinding(environment, label, resource, database, { signal: controller.signal })
  });
  console.log(`${label}: Railway ${definition.railwayRegion} service/volume, backup and PITR estimate, pinned PostgreSQL image, verified-TLS SQL identity/pgvector, cache-disabled Hyperdrive limit ${definition.originConnectionLimit}, operational Worker binding ${worker.hyperdriveId} at ${worker.name}; transaction and restore drill still required`);
}

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await verify('control', env.control, inventory.control, env.control.database, railwayServiceName(env));
  for (const cell of env.cells) await verify(cell.id, cell, inventory.cells[cell.id], cellDatabaseName(env, cell), railwayServiceName(env, cell));
} catch (error) {
  let message = 'Unknown verification failure';
  if (error instanceof Error) message = error.message;
  if (controller.signal.aborted) message = 'Topology verification interrupted';
  console.error(message);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { qualificationRailwayServiceName, qualificationTarget } from './qualification-artifact.mjs';
import { readHyperdrive } from './wrangler-command.mjs';
import { assertPostgresImageProvenance, sameProviderId, validVolumePath } from './topology-live.mjs';
import { validateDeploymentInventories, validateTopology } from './topology.mjs';
import { readProtectedSqlUrls, verifyPgdataPlacement } from './topology-sql.mjs';
import { readUploadedCa } from './topology-ca.mjs';
import { runBoundedCommand } from './bounded-command.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{32}$/i;
export const qualificationProviderQuery = `query ReadDisposable($serviceId: String!, $environmentId: String!, $volumeInstanceId: String!) {
  service(id: $serviceId) { id name projectId deletedAt }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { serviceId environmentId region deletedAt source { image repo } latestDeployment { status meta } }
  volumeInstance(id: $volumeInstanceId) { id serviceId environmentId region mountPath deletedAt isPendingDeletion }
  tcpProxies(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId applicationPort domain proxyPort deletedAt }
}`;

export async function readQualificationInventory(path) {
  if (!path) throw new Error('Protected qualification inventory path required');
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error('Protected qualification inventory must be mode 0600');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Protected qualification inventory is invalid JSON'); }
}

export async function readRailwayQualification(inventory, signal, runCommand = runBoundedCommand) {
  const account = process.env.STATEPLANE_RAILWAY_ACCOUNT;
  if (!account) throw new Error('Connected Railway account required');
  const payload = JSON.stringify({ query: qualificationProviderQuery, variables: {
    serviceId: inventory.serviceId,
    environmentId: inventory.environmentId, volumeInstanceId: inventory.volumeInstanceId
  } });
  const { stdout } = await runCommand('composio', ['proxy', 'https://backboard.railway.com/graphql/v2',
    '--toolkit', 'railway', '--account', account, '-X', 'POST', '-H', 'content-type: application/json', '-d', payload],
  { maxBuffer: 1024 * 1024, timeout: 15_000, signal,
    errorMessage: 'Connected Railway readback failed' });
  let railway;
  try { railway = JSON.parse(stdout); }
  catch { throw new Error('Connected Railway readback is invalid JSON'); }
  if (!railway || !Array.isArray(railway.errors ?? []) || railway.errors?.length ||
      !railway.data || typeof railway.data !== 'object') throw new Error('Connected Railway readback failed');
  return railway.data;
}

export async function connectedQualificationReadback(inventory, signal) {
  const railway = await readRailwayQualification(inventory, signal);
  const hyperdrive = await readHyperdrive(inventory.hyperdriveId, { signal });
  return { railway, hyperdrive };
}

export async function connectedPgdataProof(inventory, railway, hyperdrive, signal) {
  if (!process.env.STATEPLANE_QUALIFICATION_PGDATA_URL_FILE) throw new Error('Protected disposable PGDATA SQL URL file required');
  const urls = await readProtectedSqlUrls(process.env.STATEPLANE_QUALIFICATION_PGDATA_URL_FILE);
  const ca = await readUploadedCa(hyperdrive.mtls.ca_certificate_id, signal);
  await verifyPgdataPlacement({ label: inventory.name, volumeInstance: railway.volumeInstance,
    mountPath: inventory.volumeMountPath, database: inventory.database, proxy: railway.tcpProxies[0],
    ca, value: urls.url, operationalRole: inventory.role, signal });
}

function assertDisposableInventory(inventory, { name, railwayServiceName, expectedDatabase, expectedRole, artifactId }) {
  if (!inventory || Array.isArray(inventory) || typeof inventory !== 'object' ||
      Object.keys(inventory).sort((a, b) => a.localeCompare(b)).join(',') !== ['database', 'environmentId', 'hyperdriveId', 'name', 'projectId',
        'railwayServiceName', 'role', 'serviceId', 'volumeInstanceId', 'volumeMountPath'].sort((a, b) => a.localeCompare(b)).join(',') ||
      inventory.name !== name || inventory.railwayServiceName !== railwayServiceName ||
      inventory.database !== expectedDatabase || inventory.role !== expectedRole ||
      ![inventory.projectId, inventory.environmentId, inventory.serviceId, inventory.volumeInstanceId].every(id => uuid.test(id ?? '')) ||
      !hex.test(inventory.hyperdriveId ?? '') || !validVolumePath(inventory.volumeMountPath) ||
      !sameProviderId(inventory.hyperdriveId, artifactId, hex)) {
    throw new Error('Disposable qualification target differs from protected inventory');
  }
}

function assertDisposableIsolation(inventory, operational) {
  for (const deployed of Object.values(operational)) {
    for (const resource of [deployed.control, ...Object.values(deployed.cells)]) {
      if (sameProviderId(inventory.serviceId, resource.serviceId) ||
          sameProviderId(inventory.volumeInstanceId, resource.volumeInstanceId) ||
          sameProviderId(inventory.hyperdriveId, resource.hyperdriveId, hex)) {
        throw new Error('Disposable target reuses an operational resource');
      }
    }
  }
}

function assertDisposableProvider(inventory, definition, railway) {
  const { service, serviceInstance, volumeInstance, tcpProxies } = railway ?? {};
  const proxy = Array.isArray(tcpProxies) && tcpProxies.length === 1 ? tcpProxies[0] : undefined;
  if (!sameProviderId(service?.id, inventory.serviceId) || service.name !== inventory.railwayServiceName ||
      !sameProviderId(service?.projectId, inventory.projectId) || service.deletedAt ||
      !sameProviderId(serviceInstance?.serviceId, inventory.serviceId) ||
      !sameProviderId(serviceInstance?.environmentId, inventory.environmentId) ||
      serviceInstance.region !== definition.railwayRegion || serviceInstance.deletedAt ||
      serviceInstance.latestDeployment?.status !== 'SUCCESS' ||
      !sameProviderId(volumeInstance?.id, inventory.volumeInstanceId) ||
      !sameProviderId(volumeInstance?.serviceId, inventory.serviceId) ||
      !sameProviderId(volumeInstance?.environmentId, inventory.environmentId) ||
      volumeInstance.region !== definition.railwayRegion || volumeInstance.mountPath !== inventory.volumeMountPath ||
      volumeInstance.deletedAt || volumeInstance.isPendingDeletion ||
      !sameProviderId(proxy?.serviceId, inventory.serviceId) ||
      !sameProviderId(proxy?.environmentId, inventory.environmentId) || proxy.deletedAt ||
      proxy.applicationPort !== 5432 || !proxy.domain || !Number.isInteger(proxy.proxyPort)) {
    throw new Error('Disposable Railway service, volume, region or proxy readback mismatch');
  }
  return proxy;
}

function assertDisposableHyperdrive(inventory, definition, proxy, hyperdrive) {
  if (!sameProviderId(hyperdrive?.id, inventory.hyperdriveId, hex) ||
      hyperdrive.caching?.disabled !== true || hyperdrive.origin_connection_limit !== definition.originConnectionLimit ||
      !['postgres', 'postgresql'].includes(hyperdrive.origin?.scheme) ||
      hyperdrive.origin.database !== inventory.database || hyperdrive.origin.user !== inventory.role ||
      hyperdrive.origin.host !== proxy.domain || hyperdrive.origin.port !== proxy.proxyPort ||
      hyperdrive.mtls?.sslmode !== 'verify-full' || !uuid.test(hyperdrive.mtls?.ca_certificate_id ?? '')) {
    throw new Error('Disposable Hyperdrive origin, role, cache or TLS readback mismatch');
  }
}

/** A separate protected target record and live provider reads must agree before disposable DDL. */
export async function verifyQualificationTarget(root, name, head, artifactId,
  { inventoryPath = process.env.STATEPLANE_QUALIFICATION_INVENTORY_FILE,
    operationalInventoryPaths = {
      development: process.env.STATEPLANE_DEVELOPMENT_INVENTORY_FILE,
      production: process.env.STATEPLANE_PRODUCTION_INVENTORY_FILE
    },
    readback = connectedQualificationReadback, pgdataProof = connectedPgdataProof, signal } = {}) {
  if (signal?.aborted) throw new Error('Qualification target verification interrupted');
  const topology = validateTopology(JSON.parse(await readFile(resolve(root, 'deployment/topology.json'), 'utf8')));
  const { environment, cell } = qualificationTarget(name, head, topology);
  const railwayServiceName = qualificationRailwayServiceName(name, head, topology);
  const definition = topology.environments[environment].cells.find(entry => entry.id === cell);
  const expectedDatabase = `sta4_${head.slice(0, 16)}_${environment === 'development' ? 'dev' : 'prod'}_${cell.replaceAll('-', '_')}`;
  const expectedRole = `sta4_probe_${head.slice(0, 16)}`;
  const inventory = await readQualificationInventory(inventoryPath);
  assertDisposableInventory(inventory, { name, railwayServiceName, expectedDatabase, expectedRole, artifactId });
  if (!operationalInventoryPaths?.development || !operationalInventoryPaths?.production) {
    throw new Error('Both protected operational inventory paths required');
  }
  const operational = {
    development: await readQualificationInventory(operationalInventoryPaths.development),
    production: await readQualificationInventory(operationalInventoryPaths.production)
  };
  validateDeploymentInventories(topology, operational.development, operational.production);
  assertDisposableIsolation(inventory, operational);
  const { railway, hyperdrive } = await readback(inventory, signal);
  if (signal?.aborted) throw new Error('Qualification target verification interrupted');
  const approvedImage = environment === 'development'
    ? operational.development.cells[cell] : operational.production.cells[cell];
  const proxy = assertDisposableProvider(inventory, definition, railway);
  assertPostgresImageProvenance(name, approvedImage, railway.serviceInstance);
  assertDisposableHyperdrive(inventory, definition, proxy, hyperdrive);
  await pgdataProof(inventory, railway, hyperdrive, signal);
  if (signal?.aborted) throw new Error('Qualification target verification interrupted');
  return { environment, cell, railwayRegion: definition.railwayRegion, database: inventory.database, role: inventory.role };
}

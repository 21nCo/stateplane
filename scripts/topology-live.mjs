const DAY_SECONDS = 86400;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hexId = /^[a-f0-9]{32}$/i;
const absoluteDirectory = /^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/;
export const validVolumePath = value => typeof value === 'string' && absoluteDirectory.test(value) &&
  !value.split('/').some(segment => segment === '.' || segment === '..');

export function assertVolumePlacement(label, volumeInstance, mountPath, dataDirectory) {
  if (!validVolumePath(mountPath) ||
      volumeInstance?.mountPath !== mountPath ||
      !validVolumePath(dataDirectory) ||
      !(dataDirectory === mountPath || dataDirectory.startsWith(`${mountPath}/`))) {
    throw new Error(`${label}: PostgreSQL data directory is outside the inventoried Railway volume mount`);
  }
}

/** Provider APIs may canonicalize the case of hexadecimal resource IDs. */
export const sameProviderId = (actual, expected, pattern = uuid) =>
  typeof actual === 'string' && typeof expected === 'string' &&
  pattern.test(actual) && pattern.test(expected) && actual.toLowerCase() === expected.toLowerCase();

/** Check provider readback and the corresponding cache-disabled Cloudflare origin. */
export function assertLiveResources({ label, environment, definition, resource, database, serviceName, projectId, environmentId, railway, hyperdrive }) {
  const { service, serviceInstance, volumeInstance, backupSchedules, backups, pitrEstimate, tcpProxies } = railway ?? {};
  if (!sameProviderId(service?.id, resource.serviceId) || service.name !== serviceName ||
      !sameProviderId(service.projectId, projectId) || service.deletedAt) {
    throw new Error(`${label}: Railway service identity mismatch`);
  }
  if (!sameProviderId(serviceInstance?.serviceId, resource.serviceId) ||
      !sameProviderId(serviceInstance.environmentId, environmentId) ||
      serviceInstance.region !== definition.railwayRegion || serviceInstance.deletedAt ||
      serviceInstance.latestDeployment?.status !== 'SUCCESS' ||
      serviceInstance.source?.image !== resource.postgresImage || serviceInstance.source?.repo ||
      serviceInstance.latestDeployment?.meta?.image !== resource.postgresImage ||
      serviceInstance.latestDeployment?.meta?.imageDigest?.toLowerCase() !== resource.postgresImageDigest.toLowerCase()) {
    throw new Error(`${label}: Railway deployment region, image or status mismatch`);
  }
  if (!sameProviderId(volumeInstance?.id, resource.volumeInstanceId) ||
      !sameProviderId(volumeInstance.serviceId, resource.serviceId) ||
      !sameProviderId(volumeInstance.environmentId, environmentId) || volumeInstance.region !== definition.railwayRegion ||
      volumeInstance.deletedAt || volumeInstance.isPendingDeletion) throw new Error(`${label}: Railway volume identity or region mismatch`);
  if (volumeInstance.mountPath !== resource.volumeMountPath) throw new Error(`${label}: Railway volume mount mismatch`);
  const requiredRetention = (environment === 'production' ? 7 : 1) * DAY_SECONDS;
  if (!Array.isArray(backupSchedules) || !backupSchedules.some(schedule =>
    Number.isInteger(schedule.retentionSeconds) && schedule.retentionSeconds >= requiredRetention) ||
      !Array.isArray(backups) || !backups.some(backup =>
        typeof backup.id === 'string' && backup.id.length > 0 &&
        typeof backup.externalId === 'string' && backup.externalId.length > 0 &&
        Number.isInteger(backup.usedMB) && backup.usedMB >= 0 &&
        Number.isInteger(backup.referencedMB) && backup.referencedMB >= 0 &&
        Number.isInteger(backup.volumeInstanceSizeMB) && backup.volumeInstanceSizeMB > 0 &&
        Number.isFinite(Date.parse(backup.createdAt)) && Date.parse(backup.createdAt) <= Date.now() &&
        (!backup.expiresAt || Date.parse(backup.expiresAt) > Date.now()))) {
    throw new Error(`${label}: Railway volume backup retention or completed backup missing`);
  }
  if (!pitrEstimate?.baseBackupLabel || pitrEstimate.likelyToFit !== true) {
    throw new Error(`${label}: Railway PITR restore point unavailable`);
  }
  if (!Array.isArray(tcpProxies) || tcpProxies.length !== 1 ||
      !sameProviderId(tcpProxies[0].serviceId, resource.serviceId) ||
      !sameProviderId(tcpProxies[0].environmentId, environmentId) || tcpProxies[0].deletedAt ||
      tcpProxies[0].applicationPort !== 5432 || !tcpProxies[0].domain || !Number.isInteger(tcpProxies[0].proxyPort)) {
    throw new Error(`${label}: Railway TCP proxy unavailable or ambiguous`);
  }
  const proxy = tcpProxies[0];
  if (!sameProviderId(hyperdrive?.id, resource.hyperdriveId, hexId) || hyperdrive.caching?.disabled !== true) {
    throw new Error(`${label}: Hyperdrive cache enabled or ID mismatch`);
  }
  if (hyperdrive.origin_connection_limit !== definition.originConnectionLimit) throw new Error(`${label}: Hyperdrive connection limit mismatch`);
  if (!['postgres', 'postgresql'].includes(hyperdrive.origin?.scheme) || hyperdrive.origin.database !== database ||
      hyperdrive.origin.user !== resource.databaseRole ||
      hyperdrive.origin.host !== proxy.domain || hyperdrive.origin.port !== proxy.proxyPort) {
    throw new Error(`${label}: Hyperdrive PostgreSQL origin differs from declared Railway proxy, database or role`);
  }
  if (resource.network !== 'public-tls' || hyperdrive.mtls?.sslmode !== 'verify-full' ||
      !uuid.test(hyperdrive.mtls.ca_certificate_id ?? '')) throw new Error(`${label}: Hyperdrive verified TLS CA missing`);
}

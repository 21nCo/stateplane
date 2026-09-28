const DAY_SECONDS = 86400;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

/** Check provider readback and the corresponding cache-disabled Cloudflare origin. */
export function assertLiveResources({ label, environment, definition, resource, database, serviceName, projectId, environmentId, railway, hyperdrive }) {
  const { service, serviceInstance, volumeInstance, backupSchedules, backups, pitrEstimate, tcpProxies } = railway ?? {};
  if (service?.id !== resource.serviceId || service.name !== serviceName || service.projectId !== projectId || service.deletedAt) {
    throw new Error(`${label}: Railway service identity mismatch`);
  }
  if (serviceInstance?.serviceId !== resource.serviceId || serviceInstance.environmentId !== environmentId ||
      serviceInstance.region !== definition.railwayRegion || serviceInstance.deletedAt ||
      serviceInstance.latestDeployment?.status !== 'SUCCESS' ||
      serviceInstance.source?.image !== resource.postgresImage || serviceInstance.source?.repo ||
      serviceInstance.latestDeployment?.meta?.image !== resource.postgresImage ||
      !/^sha256:[a-f0-9]{64}$/i.test(serviceInstance.latestDeployment?.meta?.imageDigest ?? '')) {
    throw new Error(`${label}: Railway deployment region, image or status mismatch`);
  }
  if (volumeInstance?.id !== resource.volumeInstanceId || volumeInstance.serviceId !== resource.serviceId ||
      volumeInstance.environmentId !== environmentId || volumeInstance.region !== definition.railwayRegion ||
      volumeInstance.deletedAt || volumeInstance.isPendingDeletion) throw new Error(`${label}: Railway volume identity or region mismatch`);
  const requiredRetention = (environment === 'production' ? 7 : 1) * DAY_SECONDS;
  if (!Array.isArray(backupSchedules) || !backupSchedules.some(schedule =>
    Number.isInteger(schedule.retentionSeconds) && schedule.retentionSeconds >= requiredRetention) ||
      !Array.isArray(backups) || !backups.some(backup => backup.id && backup.createdAt &&
        (!backup.expiresAt || Date.parse(backup.expiresAt) > Date.now()))) {
    throw new Error(`${label}: Railway volume backup retention or completed backup missing`);
  }
  if (!pitrEstimate?.baseBackupLabel || pitrEstimate.likelyToFit !== true) {
    throw new Error(`${label}: Railway PITR restore point unavailable`);
  }
  if (!Array.isArray(tcpProxies) || tcpProxies.length !== 1 || tcpProxies[0].serviceId !== resource.serviceId ||
      tcpProxies[0].environmentId !== environmentId || tcpProxies[0].deletedAt ||
      tcpProxies[0].applicationPort !== 5432 || !tcpProxies[0].domain || !Number.isInteger(tcpProxies[0].proxyPort)) {
    throw new Error(`${label}: Railway TCP proxy unavailable or ambiguous`);
  }
  const proxy = tcpProxies[0];
  if (hyperdrive?.id !== resource.hyperdriveId || hyperdrive.caching?.disabled !== true) throw new Error(`${label}: Hyperdrive cache enabled or ID mismatch`);
  if (hyperdrive.origin_connection_limit !== definition.originConnectionLimit) throw new Error(`${label}: Hyperdrive connection limit mismatch`);
  if (!['postgres', 'postgresql'].includes(hyperdrive.origin?.scheme) || hyperdrive.origin.database !== database ||
      hyperdrive.origin.host !== proxy.domain || hyperdrive.origin.port !== proxy.proxyPort) {
    throw new Error(`${label}: Hyperdrive PostgreSQL origin differs from Railway proxy`);
  }
  if (resource.network !== 'public-tls' || hyperdrive.mtls?.sslmode !== 'verify-full' ||
      !uuid.test(hyperdrive.mtls.ca_certificate_id ?? '')) throw new Error(`${label}: Hyperdrive verified TLS CA missing`);
}

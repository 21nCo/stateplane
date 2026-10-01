import { runBoundedCommand } from './bounded-command.mjs';

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

/** Read one operational Railway resource with the same child ownership as disposable checks. */
export async function readOperationalRailway(resource, { projectId, environmentId, account, signal,
  runCommand = runBoundedCommand, timeout = 30_000, maxBuffer = 1024 * 1024 }) {
  const payload = JSON.stringify({ query: providerQuery, variables: {
    projectId, serviceId: resource.serviceId, environmentId, volumeInstanceId: resource.volumeInstanceId,
    targetTimestamp: new Date(Date.now() - 15 * 60_000).toISOString()
  } });
  const { stdout } = await runCommand('composio', ['proxy', 'https://backboard.railway.com/graphql/v2', '--toolkit', 'railway', '--account', account,
    '-X', 'POST', '-H', 'content-type: application/json', '-d', payload],
  { maxBuffer, timeout, signal, errorMessage: 'Connected Railway provider readback failed' });
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw new Error('Connected Railway provider readback is invalid JSON'); }
  if (response.errors?.length || !response.data) throw new Error('Connected Railway provider readback failed');
  return { ...response.data, backupSchedules: response.data.volumeInstanceBackupScheduleList,
    backups: response.data.volumeInstanceBackupList, pitrEstimate: response.data.volumeInstancePitrRestoreEstimate };
}

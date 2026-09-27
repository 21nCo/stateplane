export function assertLiveResources(label, environment, definition, resource, database, hyperdrive, instance, vpcService) {
  if (!instance || instance.DBInstanceIdentifier !== resource.rdsInstanceId || instance.Engine !== 'postgres' || instance.DBName !== database) throw new Error(`${label}: RDS identity mismatch`);
  if (instance.DBInstanceStatus !== 'available') throw new Error(`${label}: RDS is not available`);
  if (instance.BackupRetentionPeriod < (environment === 'production' ? 7 : 1)) throw new Error(`${label}: RDS backups/PITR disabled or below policy`);
  if (hyperdrive?.id !== resource.hyperdriveId || hyperdrive.caching?.disabled !== true) throw new Error(`${label}: Hyperdrive cache is enabled or ID differs`);
  if (hyperdrive.origin_connection_limit !== definition.originConnectionLimit) throw new Error(`${label}: Hyperdrive origin connection limit differs`);
  if (hyperdrive.origin?.database !== database) throw new Error(`${label}: Hyperdrive points at another database`);
  if (!instance.Endpoint?.Address?.endsWith(`.${definition.awsRegion}.rds.amazonaws.com`)) throw new Error(`${label}: RDS endpoint region mismatch`);
  if (resource.network === 'public-tls') {
    if (!instance.PubliclyAccessible || hyperdrive.origin.host !== instance.Endpoint.Address) throw new Error(`${label}: public Hyperdrive origin mismatch`);
    if (hyperdrive.mtls?.sslmode !== 'verify-full') throw new Error(`${label}: Hyperdrive must verify origin TLS hostname`);
  } else if (resource.network === 'workers-vpc') {
    if (instance.PubliclyAccessible || hyperdrive.origin.service_id !== resource.vpcServiceId) throw new Error(`${label}: private VPC origin mismatch`);
    if (vpcService?.service_id !== resource.vpcServiceId || vpcService.type !== 'tcp' || vpcService.tcp_port !== 5432 || vpcService.app_protocol !== 'postgresql' || vpcService.host?.hostname !== instance.Endpoint.Address) throw new Error(`${label}: VPC service target mismatch`);
    if (vpcService.tls_settings?.cert_verification_mode !== 'verify_full') throw new Error(`${label}: VPC service TLS verification is not full`);
  } else throw new Error(`${label}: unsupported network mode`);
}

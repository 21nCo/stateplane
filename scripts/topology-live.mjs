import { isIP } from 'node:net';

const validCidr = (value, family) => {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  const bits = Number(parts[1]);
  return parts.length === 2 && isIP(parts[0]) === family && /^\d+$/.test(parts[1]) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
};

export function assertApprovedIngress(label, instance, securityGroups, approvedCidrs) {
  const ids = instance?.VpcSecurityGroups?.map(group => group.VpcSecurityGroupId);
  if (!ids?.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error(`${label}: RDS security groups missing`);
  if (!Array.isArray(securityGroups) || securityGroups.length !== ids.length || new Set(securityGroups.map(group => group.GroupId)).size !== ids.length || securityGroups.some(group => !ids.includes(group.GroupId))) throw new Error(`${label}: RDS security group inventory incomplete`);
  if (!Array.isArray(approvedCidrs?.ipv4_cidrs) || !Array.isArray(approvedCidrs?.ipv6_cidrs) || !approvedCidrs.ipv4_cidrs.length || !approvedCidrs.ipv4_cidrs.every(cidr => validCidr(cidr, 4)) || !approvedCidrs.ipv6_cidrs.every(cidr => validCidr(cidr, 6))) throw new Error(`${label}: Cloudflare ingress ranges unavailable`);
  const requiredIpv4 = new Set(approvedCidrs.ipv4_cidrs);
  const requiredIpv6 = instance.NetworkType === 'DUAL' ? new Set(approvedCidrs.ipv6_cidrs) : new Set();
  if (instance.NetworkType !== 'IPV4' && instance.NetworkType !== 'DUAL') throw new Error(`${label}: RDS address family unavailable`);
  const coveredIpv4 = new Set();
  const coveredIpv6 = new Set();
  for (const group of securityGroups) {
    if (!Array.isArray(group.IpPermissions)) throw new Error(`${label}: RDS security group rules unavailable`);
    for (const rule of group.IpPermissions) {
      if (rule.IpProtocol !== '-1' && rule.IpProtocol !== 'tcp') continue;
      if (rule.IpProtocol !== '-1') {
        if (!Number.isInteger(rule.FromPort) || !Number.isInteger(rule.ToPort)) throw new Error(`${label}: invalid RDS ingress port range`);
        if (rule.FromPort > 5432 || rule.ToPort < 5432) continue;
      }
      if ((rule.UserIdGroupPairs?.length ?? 0) || (rule.PrefixListIds?.length ?? 0)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
      for (const range of rule.IpRanges ?? []) {
        if (!requiredIpv4.has(range.CidrIp)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
        coveredIpv4.add(range.CidrIp);
      }
      for (const range of rule.Ipv6Ranges ?? []) {
        if (!requiredIpv6.has(range.CidrIpv6)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
        coveredIpv6.add(range.CidrIpv6);
      }
    }
  }
  if (coveredIpv4.size !== requiredIpv4.size || coveredIpv6.size !== requiredIpv6.size) throw new Error(`${label}: Cloudflare RDS port 5432 ingress coverage incomplete`);
}

export function assertLiveResources(label, environment, definition, resource, database, hyperdrive, instance, securityGroups, approvedCidrs) {
  if (!instance || instance.DBInstanceIdentifier !== resource.rdsInstanceId || instance.Engine !== 'postgres' || instance.DBName !== database) throw new Error(`${label}: RDS identity mismatch`);
  if (instance.DBInstanceStatus !== 'available') throw new Error(`${label}: RDS is not available`);
  const retention = instance.BackupRetentionPeriod;
  if (!Number.isInteger(retention) || retention < (environment === 'production' ? 7 : 1)) throw new Error(`${label}: RDS backups/PITR disabled, invalid or below policy`);
  if (hyperdrive?.id !== resource.hyperdriveId || hyperdrive.caching?.disabled !== true) throw new Error(`${label}: Hyperdrive cache is enabled or ID differs`);
  if (hyperdrive.origin_connection_limit !== definition.originConnectionLimit) throw new Error(`${label}: Hyperdrive origin connection limit differs`);
  if (hyperdrive.origin?.database !== database) throw new Error(`${label}: Hyperdrive points at another database`);
  if (!instance.Endpoint?.Address?.endsWith(`.${definition.awsRegion}.rds.amazonaws.com`)) throw new Error(`${label}: RDS endpoint region mismatch`);
  if (instance.Endpoint.Port !== 5432) throw new Error(`${label}: RDS PostgreSQL endpoint port mismatch`);
  if (!['postgres', 'postgresql'].includes(hyperdrive.origin?.scheme)) throw new Error(`${label}: Hyperdrive origin is not PostgreSQL`);
  if (resource.network === 'public-tls') {
    if (!instance.PubliclyAccessible || hyperdrive.origin.host !== instance.Endpoint.Address) throw new Error(`${label}: public Hyperdrive origin mismatch`);
    if (hyperdrive.origin.port !== instance.Endpoint.Port) throw new Error(`${label}: public Hyperdrive origin port mismatch`);
    if (hyperdrive.mtls?.sslmode !== 'verify-full') throw new Error(`${label}: Hyperdrive must verify origin TLS hostname`);
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(hyperdrive.mtls.ca_certificate_id ?? '')) throw new Error(`${label}: public Hyperdrive origin requires an uploaded CA certificate ID`);
    assertApprovedIngress(label, instance, securityGroups, approvedCidrs);
  } else throw new Error(`${label}: unsupported network mode`);
}

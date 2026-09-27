import { isIP } from 'node:net';

const MAX_PITR_LAG_MS = 30 * 60_000;

const validCidr = (value, family) => {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  const bits = Number(parts[1]);
  return parts.length === 2 && isIP(parts[0]) === family && /^\d+$/.test(parts[1]) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
};

const validRestorableTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const calendarDate = value.slice(0, 10);
  const midnight = Date.parse(`${calendarDate}T00:00:00Z`);
  const point = Date.parse(value);
  const now = Date.now();
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === calendarDate && Number.isFinite(point) && point <= now && now - point <= MAX_PITR_LAG_MS;
};

function requiredRanges(label, instance, approvedCidrs) {
  if (instance.NetworkType !== 'IPV4' && instance.NetworkType !== 'DUAL') throw new Error(`${label}: RDS address family unavailable`);
  const ipv4 = approvedCidrs?.ipv4_cidrs;
  const ipv6 = approvedCidrs?.ipv6_cidrs;
  if (!Array.isArray(ipv4) || !ipv4.length || !ipv4.every(cidr => validCidr(cidr, 4)) ||
      !Array.isArray(ipv6) || !ipv6.every(cidr => validCidr(cidr, 6)) ||
      (instance.NetworkType === 'DUAL' && !ipv6.length)) throw new Error(`${label}: Cloudflare ingress ranges unavailable`);
  return { ipv4: new Set(ipv4), ipv6: new Set(instance.NetworkType === 'DUAL' ? ipv6 : []) };
}

function assertGroupInventory(label, instance, securityGroups) {
  const ids = instance?.VpcSecurityGroups?.map(group => group.VpcSecurityGroupId);
  if (!ids?.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error(`${label}: RDS security groups missing`);
  if (!Array.isArray(securityGroups) || securityGroups.length !== ids.length ||
      new Set(securityGroups.map(group => group.GroupId)).size !== ids.length ||
      securityGroups.some(group => !ids.includes(group.GroupId))) throw new Error(`${label}: RDS security group inventory incomplete`);
}

function inspectPermission(label, rule, required, covered) {
  if (!['tcp', '6', 6].includes(rule.IpProtocol) || rule.FromPort !== 5432 || rule.ToPort !== 5432) {
    throw new Error(`${label}: unapproved RDS ingress protocol or port range`);
  }
  if (!Array.isArray(rule.UserIdGroupPairs ?? []) || !Array.isArray(rule.PrefixListIds ?? []) ||
      (rule.UserIdGroupPairs?.length ?? 0) || (rule.PrefixListIds?.length ?? 0)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
  const ipv4 = rule.IpRanges ?? [];
  const ipv6 = rule.Ipv6Ranges ?? [];
  if (!Array.isArray(ipv4) || !Array.isArray(ipv6) || (!ipv4.length && !ipv6.length)) throw new Error(`${label}: RDS ingress ranges unavailable`);
  for (const range of ipv4) {
    if (!required.ipv4.has(range.CidrIp)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
    covered.ipv4.add(range.CidrIp);
  }
  for (const range of ipv6) {
    if (!required.ipv6.has(range.CidrIpv6)) throw new Error(`${label}: unapproved RDS port 5432 ingress`);
    covered.ipv6.add(range.CidrIpv6);
  }
}

export function assertApprovedIngress(label, instance, securityGroups, approvedCidrs) {
  assertGroupInventory(label, instance, securityGroups);
  const required = requiredRanges(label, instance, approvedCidrs);
  const covered = { ipv4: new Set(), ipv6: new Set() };
  for (const group of securityGroups) {
    if (!Array.isArray(group.IpPermissions)) throw new Error(`${label}: RDS security group rules unavailable`);
    for (const rule of group.IpPermissions) inspectPermission(label, rule, required, covered);
  }
  if (covered.ipv4.size !== required.ipv4.size || covered.ipv6.size !== required.ipv6.size) {
    throw new Error(`${label}: Cloudflare RDS port 5432 ingress coverage incomplete`);
  }
}

function assertRds(label, environment, definition, resource, database, instance) {
  if (!instance || instance.DBInstanceIdentifier !== resource.rdsInstanceId || instance.Engine !== 'postgres' || instance.DBName !== database) throw new Error(`${label}: RDS identity mismatch`);
  if (instance.DBInstanceStatus !== 'available') throw new Error(`${label}: RDS is not available`);
  if (!['rds-ca-rsa2048-g1', 'rds-ca-rsa4096-g1', 'rds-ca-ecc384-g1'].includes(instance.CACertificateIdentifier)) throw new Error(`${label}: RDS CA identifier unavailable or unsupported`);
  const retention = instance.BackupRetentionPeriod;
  if (!Number.isInteger(retention) || retention < (environment === 'production' ? 7 : 1)) throw new Error(`${label}: RDS backups/PITR disabled, invalid or below policy`);
  if (!validRestorableTime(instance.LatestRestorableTime)) throw new Error(`${label}: RDS PITR latest restorable time unavailable, stale or invalid`);
  if (environment === 'production' && instance.DeletionProtection !== true) throw new Error(`${label}: production RDS deletion protection is disabled or unavailable`);
  if (!instance.Endpoint?.Address?.endsWith(`.${definition.awsRegion}.rds.amazonaws.com`)) throw new Error(`${label}: RDS endpoint region mismatch`);
  if (instance.Endpoint.Port !== 5432) throw new Error(`${label}: RDS PostgreSQL endpoint port mismatch`);
}

function assertHyperdrive(label, definition, resource, database, hyperdrive) {
  if (hyperdrive?.id !== resource.hyperdriveId || hyperdrive.caching?.disabled !== true) throw new Error(`${label}: Hyperdrive cache is enabled or ID differs`);
  if (hyperdrive.origin_connection_limit !== definition.originConnectionLimit) throw new Error(`${label}: Hyperdrive origin connection limit differs`);
  if (hyperdrive.origin?.database !== database) throw new Error(`${label}: Hyperdrive points at another database`);
  if (!['postgres', 'postgresql'].includes(hyperdrive.origin?.scheme)) throw new Error(`${label}: Hyperdrive origin is not PostgreSQL`);
}

function assertPublicOrigin(label, resource, hyperdrive, instance, securityGroups, approvedCidrs) {
  if (resource.network !== 'public-tls') throw new Error(`${label}: unsupported network mode`);
  if (!instance.PubliclyAccessible || hyperdrive.origin.host !== instance.Endpoint.Address) throw new Error(`${label}: public Hyperdrive origin mismatch`);
  if (hyperdrive.origin.port !== instance.Endpoint.Port) throw new Error(`${label}: public Hyperdrive origin port mismatch`);
  if (hyperdrive.mtls?.sslmode !== 'verify-full') throw new Error(`${label}: Hyperdrive must verify origin TLS hostname`);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(hyperdrive.mtls.ca_certificate_id ?? '')) throw new Error(`${label}: public Hyperdrive origin requires an uploaded CA certificate ID`);
  assertApprovedIngress(label, instance, securityGroups, approvedCidrs);
}

export function assertLiveResources({ label, environment, definition, resource, database, hyperdrive, instance, securityGroups, approvedCidrs }) {
  assertRds(label, environment, definition, resource, database, instance);
  assertHyperdrive(label, definition, resource, database, hyperdrive);
  assertPublicOrigin(label, resource, hyperdrive, instance, securityGroups, approvedCidrs);
}

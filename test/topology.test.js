import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTopology, validateInventory, renderTopology, cellDatabaseName } from '../scripts/topology.mjs';
import { dryRunTopology } from '../scripts/topology-dry-run.mjs';
import { assertLiveResources as assertRawLiveResources, assertApprovedIngress } from '../scripts/topology-live.mjs';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
const caCertificateId = '550e8400-e29b-41d4-a716-446655440001';
const groupId = 'sg-approved';
const approvedCidrs = { ipv4_cidrs: ['203.0.113.0/24', '198.51.100.0/24'], ipv6_cidrs: ['2001:db8::/32'] };
const approvedGroups = [{ GroupId: groupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: approvedCidrs.ipv4_cidrs.map(CidrIp => ({ CidrIp })) }] }];
const recentRestorableTime = new Date(Date.now() - 60_000).toISOString();
const assertLiveResources = (label, environment, definition, resource, database, hyperdrive, instance) =>
  assertRawLiveResources({ label, environment, definition, resource, database, hyperdrive,
    instance: { CACertificateIdentifier: 'rds-ca-rsa2048-g1', DeletionProtection: true, LatestRestorableTime: recentRestorableTime, ...instance, NetworkType: 'IPV4', VpcSecurityGroups: [{ VpcSecurityGroupId: groupId }] }, securityGroups: approvedGroups, approvedCidrs });
const copy = value => structuredClone(value);
const inventory = environment => ({
  environment,
  control: { hyperdriveId: 'a'.repeat(32), rdsInstanceId: `${topology.environments[environment].prefix}-control-db`, network: 'public-tls' },
  cells: Object.fromEntries(topology.environments[environment].cells.map((cell, index) => [cell.id, { hyperdriveId: String(index + 1).repeat(32), rdsInstanceId: `${topology.environments[environment].prefix}-${cell.id}-db`, network: 'public-tls' }]))
});

test('both environments have distinct provider databases, private cells and cache-free authority bindings', () => {
  validateTopology(topology);
  const configs = Object.fromEntries(['development', 'production'].map(env => [env, renderTopology(topology, env, inventory(env), '/tmp/stateplane-topology')]));
  assert.equal(Object.keys(configs.development).length, 12);
  assert.equal(Object.keys(configs.production).length, 9);
  for (const [env, workers] of Object.entries(configs)) {
    const prefix = topology.environments[env].prefix;
    assert.equal(workers['directory.json'].hyperdrive[0].binding, 'AUTHORITY');
    assert.equal(workers['app.json'].services.length, topology.environments[env].cells.length + 1);
    for (const [file, worker] of Object.entries(workers)) {
      assert.equal(worker.workers_dev, false, file);
      assert.equal(worker.name.startsWith(prefix), true, file);
      assert.equal(JSON.stringify(worker).includes('DATABASE_URL'), false, file);
      assert.equal(JSON.stringify(worker).includes('password'), false, file);
      if (/^(in-south|us-east|eu-west)-(api|mcp)\.json$/.test(file)) assert.equal(worker.hyperdrive[0].binding, 'AUTHORITY');
    }
  }
});

test('synthetic dry-run preserves a previously rendered operator config', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sta4-dry-run-'));
  try {
    const live = join(projectRoot, '.data/topology/production');
    await mkdir(live, { recursive: true });
    const config = renderTopology(topology, 'production', {
      ...inventory('production'),
      routes: { app: 'https://sta4-app.example.test', mcp: 'https://sta4-mcp.example.test' }
    }, live)['app.json'];
    const original = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(join(live, 'app.json'), original);
    const count = await dryRunTopology(topology, { projectRoot, runWrangler: async () => ({ stdout: '' }) });
    assert.equal(count, 21);
    assert.equal(await readFile(join(live, 'app.json'), 'utf8'), original);
    const synthetic = JSON.parse(await readFile(join(projectRoot, '.data/topology-dry-run/production/app.json'), 'utf8'));
    assert.equal(synthetic.routes, undefined);
    assert.notEqual(synthetic.services[0].service, undefined);
    assert.equal(synthetic.main, '../../../app/.svelte-kit/cloudflare/_worker.js');
    assert.equal(synthetic.$schema, '../../../app/node_modules/wrangler/config-schema.json');
    assert.equal(synthetic.assets.directory, '../../../app/.svelte-kit/cloudflare');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('rejects an incomplete cell pattern and a false regional label', () => {
  const incomplete = copy(topology);
  incomplete.environments.development.cells.pop();
  assert.throws(() => validateTopology(incomplete), /incomplete cell pattern/);
  const falseRegion = copy(topology);
  falseRegion.environments.production.cells[0].awsRegion = 'ap-southeast-1';
  assert.throws(() => validateTopology(falseRegion), /wrong provider region/);
});

test('control region and each cell R2 hint must match the declared placement policy', () => {
  for (const environment of ['development', 'production']) {
    const wrongControl = copy(topology);
    wrongControl.environments[environment].control.awsRegion = 'ap-south-1';
    assert.throws(() => validateTopology(wrongControl), /control is mapped to the wrong provider region/);
    for (const cell of topology.environments[environment].cells) {
      const wrongHint = copy(topology);
      wrongHint.environments[environment].cells.find(candidate => candidate.id === cell.id).r2LocationHint = cell.r2LocationHint === 'weur' ? 'apac' : 'weur';
      assert.throws(() => validateTopology(wrongHint), /R2 hint differs from placement policy/, `${environment}/${cell.id}`);
    }
  }
});

test('all RDS PostgreSQL database names are provisionable and match the regional inventory', () => {
  const names = [];
  for (const [environment, env] of Object.entries(topology.environments)) {
    names.push(env.control.database);
    for (const cell of env.cells) {
      const name = cellDatabaseName(env, cell);
      assert.match(name, /^[a-z][a-z0-9_]{0,62}$/, `${environment}/${cell.id}`);
      assert.equal(name, `${environment === 'development' ? 'stateplane_dev' : 'stateplane_prod'}_${cell.id.replaceAll('-', '_')}`);
      names.push(name);
    }
  }
  assert.equal(new Set(names).size, 7);
  const tooLong = copy(topology);
  tooLong.environments.development.prefix = `stateplane-${'a'.repeat(55)}`;
  assert.throws(() => validateTopology(tooLong), /name is invalid|RDS database is invalid/);
  const badControl = copy(topology);
  badControl.environments.production.control.database = 'bad-name';
  assert.throws(() => validateTopology(badControl), /control database is invalid/);
});

test('rejects cross-environment reuse and strict processing claims', () => {
  const reused = copy(topology);
  reused.environments.production.prefix = reused.environments.development.prefix;
  assert.throws(() => validateTopology(reused), /unique across environments/);
  const strict = copy(topology);
  strict.environments.production.cells[0].strictResidency = true;
  assert.throws(() => validateTopology(strict), /unsupported field/);
});

test('requires complete isolated Hyperdrive inventory and rejects secret-shaped fields', () => {
  const missing = inventory('development');
  delete missing.cells['eu-west'];
  assert.throws(() => validateInventory(topology, 'development', missing), /Missing cell inventory/);
  const reused = inventory('development');
  reused.cells['us-east'].hyperdriveId = reused.cells['in-south'].hyperdriveId;
  assert.throws(() => validateInventory(topology, 'development', reused), /unique/);
  const secret = inventory('development');
  secret.cells['us-east'].databaseUrl = 'private value';
  assert.throws(() => validateInventory(topology, 'development', secret), /unsupported field/);
  const untrustedPrivate = inventory('development');
  untrustedPrivate.cells['in-south'].network = 'workers-vpc';
  untrustedPrivate.cells['in-south'].vpcServiceId = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(() => validateInventory(topology, 'development', untrustedPrivate), /unsupported until private CA trust is proven/);
  const publicVpc = inventory('development');
  publicVpc.cells['in-south'].vpcServiceId = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(() => validateInventory(topology, 'development', publicVpc), /cannot include a VPC service/);
});

test('live gate rejects stale Hyperdrive caching, wrong origin and inadequate backup retention', () => {
  const definition = topology.environments.production.cells[0];
  const resource = inventory('production').cells['in-south'];
  const database = cellDatabaseName(topology.environments.production, definition);
  const host = 'sta-4.abcdefgh.ap-south-1.rds.amazonaws.com';
  const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: 7, PubliclyAccessible: true, Endpoint: { Address: host, Port: 5432 } };
  const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5, mtls: { sslmode: 'verify-full', ca_certificate_id: caCertificateId }, origin: { host, port: 5432, scheme: 'postgres', database } };
  assert.doesNotThrow(() => assertLiveResources('in-south', 'production', definition, resource, database, hyperdrive, instance));
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, { ...hyperdrive, caching: { disabled: false } }, instance), /cache is enabled/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, { ...hyperdrive, origin: { ...hyperdrive.origin, database: 'other' } }, instance), /another database/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, hyperdrive, { ...instance, BackupRetentionPeriod: 0 }), /backups\/PITR/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, { ...resource, network: 'workers-vpc' }, database, hyperdrive, instance), /unsupported network mode/);
});

test('live gate requires a valid backup retention period for every control and cell database', () => {
  for (const [environment, env] of Object.entries(topology.environments)) {
    const resources = inventory(environment);
    const targets = [
      ['control', env.control, resources.control, env.control.database],
      ...env.cells.map(cell => [cell.id, cell, resources.cells[cell.id], cellDatabaseName(env, cell)])
    ];
    const minimum = environment === 'production' ? 7 : 1;
    for (const [label, definition, resource, database] of targets) {
      const host = `sta-4.abcdefgh.${definition.awsRegion}.rds.amazonaws.com`;
      const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: minimum, PubliclyAccessible: true, Endpoint: { Address: host, Port: 5432 } };
      const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: definition.originConnectionLimit, mtls: { sslmode: 'verify-full', ca_certificate_id: caCertificateId }, origin: { host, port: 5432, scheme: 'postgres', database } };
      assert.doesNotThrow(() => assertLiveResources(label, environment, definition, resource, database, hyperdrive, instance), `${environment}/${label}: valid retention`);
      for (const retention of [undefined, NaN, 'unavailable', minimum - 1, minimum + 0.5]) {
        assert.throws(
          () => assertLiveResources(label, environment, definition, resource, database, hyperdrive, { ...instance, BackupRetentionPeriod: retention }),
          /backups\/PITR/,
          `${environment}/${label}: ${String(retention)} must fail closed`
        );
      }
      for (const restorable of [undefined, null, 'invalid', '2026-02-31T00:00:00Z', '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z']) {
        assert.throws(
          () => assertLiveResources(label, environment, definition, resource, database, hyperdrive, { ...instance, LatestRestorableTime: restorable }),
          /PITR latest restorable time/,
          `${environment}/${label}: ${String(restorable)} must fail closed`
        );
      }
    }
  }
});

test('production control and every cell require explicit RDS deletion protection', () => {
  for (const [environment, env] of Object.entries(topology.environments)) {
    const resources = inventory(environment);
    const targets = [
      ['control', env.control, resources.control, env.control.database],
      ...env.cells.map(cell => [cell.id, cell, resources.cells[cell.id], cellDatabaseName(env, cell)])
    ];
    for (const [label, definition, resource, database] of targets) {
      const host = `sta-4.abcdefgh.${definition.awsRegion}.rds.amazonaws.com`;
      const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: environment === 'production' ? 7 : 1, PubliclyAccessible: true, Endpoint: { Address: host, Port: 5432 } };
      const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: definition.originConnectionLimit, mtls: { sslmode: 'verify-full', ca_certificate_id: caCertificateId }, origin: { host, port: 5432, scheme: 'postgres', database } };
      for (const protection of [false, undefined]) {
        if (environment === 'production') {
          assert.throws(() => assertLiveResources(label, environment, definition, resource, database, hyperdrive, { ...instance, DeletionProtection: protection }), /deletion protection/, `${environment}/${label}: ${String(protection)}`);
        } else {
          assert.doesNotThrow(() => assertLiveResources(label, environment, definition, resource, database, hyperdrive, { ...instance, DeletionProtection: protection }), `${environment}/${label}: disposable`);
        }
      }
      assert.doesNotThrow(() => assertLiveResources(label, environment, definition, resource, database, hyperdrive, { ...instance, DeletionProtection: true }));
    }
  }
});

test('live gate verifies PostgreSQL origin identity and public CA for control and every cell', () => {
  for (const [environment, env] of Object.entries(topology.environments)) {
    const resources = inventory(environment);
    const targets = [
      ['control', env.control, resources.control, env.control.database],
      ...env.cells.map(cell => [cell.id, cell, resources.cells[cell.id], cellDatabaseName(env, cell)])
    ];
    for (const [label, definition, resource, database] of targets) {
      const host = `sta-4.abcdefgh.${definition.awsRegion}.rds.amazonaws.com`;
      const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: environment === 'production' ? 7 : 1, PubliclyAccessible: true, Endpoint: { Address: host, Port: 5432 } };
      const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: definition.originConnectionLimit, mtls: { sslmode: 'verify-full', ca_certificate_id: caCertificateId }, origin: { host, port: 5432, scheme: 'postgres', database } };
      const checkLive = (origin = hyperdrive, rds = instance, currentResource = resource, vpc) => assertLiveResources(label, environment, definition, currentResource, database, origin, rds, vpc);
      assert.doesNotThrow(() => checkLive(), `${environment}/${label}: valid public PostgreSQL origin`);
      assert.throws(() => checkLive({ ...hyperdrive, mtls: { sslmode: 'verify-full' } }), /CA certificate ID/, `${environment}/${label}: absent CA`);
      assert.throws(() => checkLive({ ...hyperdrive, mtls: { sslmode: 'verify-full', ca_certificate_id: 'invalid' } }), /CA certificate ID/, `${environment}/${label}: malformed CA`);
      assert.throws(() => checkLive(hyperdrive, { ...instance, CACertificateIdentifier: undefined }), /RDS CA identifier/, `${environment}/${label}: missing RDS CA`);
      assert.throws(() => checkLive({ ...hyperdrive, origin: { ...hyperdrive.origin, scheme: 'mysql' } }), /not PostgreSQL/, `${environment}/${label}: MySQL scheme`);
      assert.throws(() => checkLive({ ...hyperdrive, origin: { ...hyperdrive.origin, port: 3306 } }), /origin port mismatch/, `${environment}/${label}: MySQL port`);
      assert.throws(() => checkLive(hyperdrive, { ...instance, Endpoint: { Address: host, Port: 3306 } }), /endpoint port mismatch/, `${environment}/${label}: RDS port`);

      assert.throws(() => checkLive(hyperdrive, { ...instance, DBInstanceIdentifier: 'wrong-db' }), /RDS identity mismatch/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, Engine: 'mysql' }), /RDS identity mismatch/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, DBName: 'other' }), /RDS identity mismatch/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, DBInstanceStatus: 'creating' }), /not available/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, CACertificateIdentifier: 'unsupported' }), /CA identifier/);
      assert.throws(() => checkLive({ ...hyperdrive, id: 'f'.repeat(32) }), /ID differs/);
      assert.throws(() => checkLive({ ...hyperdrive, origin_connection_limit: 500 }), /connection limit differs/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, Endpoint: { Address: 'other.us-west-1.rds.amazonaws.com', Port: 5432 } }), /endpoint region mismatch/);
      assert.throws(() => checkLive(hyperdrive, { ...instance, PubliclyAccessible: false }), /public Hyperdrive origin mismatch/);
      assert.throws(() => checkLive({ ...hyperdrive, origin: { ...hyperdrive.origin, host: 'other.example' } }), /public Hyperdrive origin mismatch/);
      assert.throws(() => checkLive({ ...hyperdrive, mtls: { sslmode: 'require', ca_certificate_id: caCertificateId } }), /verify origin TLS/);
      assert.throws(() => checkLive(hyperdrive, instance, { ...resource, network: 'workers-vpc' }), /unsupported network mode/);
    }
  }
});

test('restore inventory accepts only a same-cell replacement name', () => {
  const restored = inventory('production');
  restored.cells['in-south'].rdsInstanceId += '-restore-abcdefgh';
  assert.doesNotThrow(() => validateInventory(topology, 'production', restored));
  for (const suffix of ['-restore-short', '-restore-ABCDEFGH', '-other-abcdefgh']) {
    const wrong = inventory('production');
    wrong.cells['in-south'].rdsInstanceId += suffix;
    assert.throws(() => validateInventory(topology, 'production', wrong), /RDS instance mismatch/);
  }
});

test('derived Cloudflare names are bounded even when an RDS database name fits', () => {
  const long = copy(topology);
  long.environments.development.prefix = `a${'b'.repeat(42)}`;
  assert.match(cellDatabaseName(long.environments.development, long.environments.development.cells[0]), /^[a-z][a-z0-9_]{0,62}$/);
  assert.throws(() => validateTopology(long), /name is invalid/);
});

test('PITR rejects a stalled latest-restorable point independent of retention', () => {
  const env = topology.environments.production;
  const resource = inventory('production').control;
  const host = 'sta4.abcdefgh.us-east-1.rds.amazonaws.com';
  const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: env.control.database, DBInstanceStatus: 'available', BackupRetentionPeriod: 7, PubliclyAccessible: true, Endpoint: { Address: host, Port: 5432 }, LatestRestorableTime: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
  const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5, mtls: { sslmode: 'verify-full', ca_certificate_id: caCertificateId }, origin: { host, port: 5432, scheme: 'postgres', database: env.control.database } };
  assert.throws(() => assertLiveResources('control', 'production', env.control, resource, env.control.database, hyperdrive, instance), /PITR latest restorable time/);
});

test('public RDS ingress is limited to current approved Cloudflare ranges for every control and cell', () => {
  for (const [environment, env] of Object.entries(topology.environments)) {
    for (const label of ['control', ...env.cells.map(cell => cell.id)]) {
      const instance = { NetworkType: 'IPV4', VpcSecurityGroups: [{ VpcSecurityGroupId: groupId }] };
      const check = (groups = approvedGroups, ranges = approvedCidrs, rds = instance) => assertApprovedIngress(label, rds, groups, ranges);
      assert.doesNotThrow(() => check(), `${environment}/${label}: approved ingress`);
      assert.doesNotThrow(() => check([{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], IpProtocol: '6' }] }]), `${environment}/${label}: approved numeric TCP ingress`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], IpRanges: [{ CidrIp: approvedCidrs.ipv4_cidrs[0] }] }] }]), /coverage incomplete/, `${environment}/${label}: one of two current IPv4 ranges`);
      assert.throws(() => check(approvedGroups, approvedCidrs, { ...instance, NetworkType: undefined }), /address family unavailable/);
      const dualGroup = [{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], Ipv6Ranges: approvedCidrs.ipv6_cidrs.map(CidrIpv6 => ({ CidrIpv6 })) }] }];
      assert.doesNotThrow(() => check(dualGroup, approvedCidrs, { ...instance, NetworkType: 'DUAL' }), `${environment}/${label}: complete dual-stack ingress`);
      assert.throws(() => check(approvedGroups, approvedCidrs, { ...instance, NetworkType: 'DUAL' }), /coverage incomplete/, `${environment}/${label}: missing IPv6 ingress`);
      assert.throws(() => check(dualGroup, { ...approvedCidrs, ipv6_cidrs: [] }, { ...instance, NetworkType: 'DUAL' }), /ranges unavailable/, `${environment}/${label}: DUAL requires nonempty IPv6 inventory`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: 'udp', FromPort: 0, ToPort: 65535, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved/, `${environment}/${label}: world-open UDP`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved/, `${environment}/${label}: off-port TCP`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: 'icmp', FromPort: -1, ToPort: -1, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved/, `${environment}/${label}: world-open ICMP`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved/);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], IpRanges: [], Ipv6Ranges: [{ CidrIpv6: '::/0' }] }] }]), /unapproved/);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ ...approvedGroups[0].IpPermissions[0], IpRanges: [{ CidrIp: '192.0.2.0/24' }] }] }]), /unapproved/);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved/);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ IpProtocol: '-1', IpRanges: approvedCidrs.ipv4_cidrs.map(CidrIp => ({ CidrIp })) }] }]), /unapproved/, `${environment}/${label}: approved CIDRs cannot use all protocols`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ IpProtocol: 'tcp', FromPort: 0, ToPort: 65535, IpRanges: approvedCidrs.ipv4_cidrs.map(CidrIp => ({ CidrIp })) }] }]), /unapproved RDS ingress protocol or port range/, `${environment}/${label}: broad TCP range`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: '6', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved RDS port 5432 ingress/, `${environment}/${label}: numeric TCP cannot bypass range checks`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: 6, FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved RDS port 5432 ingress/, `${environment}/${label}: numeric protocol value cannot bypass range checks`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [approvedGroups[0].IpPermissions[0], { IpProtocol: 'unknown', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }]), /unapproved RDS ingress protocol or port range/, `${environment}/${label}: unknown protocol cannot bypass range checks`);
      assert.throws(() => check([{ ...approvedGroups[0], IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: 'sg-other' }] }] }]), /unapproved/);
      assert.throws(() => check([], approvedCidrs), /inventory incomplete/);
      assert.throws(() => check(approvedGroups, null), /ranges unavailable/);
      assert.throws(() => check(approvedGroups, { ipv4_cidrs: [undefined], ipv6_cidrs: [] }), /ranges unavailable/);
      assert.throws(() => check([{ GroupId: groupId }]), /rules unavailable/);
      assert.throws(() => check(approvedGroups, approvedCidrs, {}), /security groups missing/);
    }
  }
});

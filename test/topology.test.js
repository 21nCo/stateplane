import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTopology, validateInventory, validateDeploymentInventories, renderTopology, cellDatabaseName, railwayServiceName } from '../scripts/topology.mjs';
import { assertLiveResources } from '../scripts/topology-live.mjs';
import { readProtectedSqlUrls, verifySqlIdentity } from '../scripts/topology-sql.mjs';
import { dryRunTopology, syntheticInventories } from '../scripts/topology-dry-run.mjs';
import { execFileSync } from 'node:child_process';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
const copy = value => structuredClone(value);
const uuid = digit => `${digit.repeat(8)}-1111-4111-8111-${digit.repeat(12)}`;
const inventory = environment => {
  const env = topology.environments[environment];
  const resources = [env.control, ...env.cells];
  const ids = resources.map((_, index) => ({
    hyperdriveId: `deadbee${index}`.repeat(4), serviceId: uuid('abcd'[index]),
    volumeInstanceId: uuid('ef12'[index]), network: 'public-tls',
    postgresImage: 'pgvector/pgvector:pg16', postgresImageDigest: `sha256:${'a'.repeat(64)}`, databaseRole: `probe_${index}`
  }));
  return { environment, projectId: uuid('a').replace('-1111-', '-5555-'), environmentId: uuid('b').replace('-1111-', '-6666-'), control: ids[0],
    cells: Object.fromEntries(env.cells.map((cell, index) => [cell.id, ids[index + 1]])) };
};

const live = (environment, label) => {
  const env = topology.environments[environment];
  const cell = env.cells.find(entry => entry.id === label);
  const definition = cell ?? env.control;
  const resource = cell ? inventory(environment).cells[label] : inventory(environment).control;
  const database = cell ? cellDatabaseName(env, cell) : env.control.database;
  const serviceName = railwayServiceName(env, cell);
  const railway = {
    service: { id: resource.serviceId, name: serviceName, projectId: inventory(environment).projectId, deletedAt: null },
    serviceInstance: { serviceId: resource.serviceId, environmentId: inventory(environment).environmentId, region: definition.railwayRegion,
      source: { image: resource.postgresImage, repo: null }, latestDeployment: { status: 'SUCCESS', meta: { image: resource.postgresImage, imageDigest: `sha256:${'a'.repeat(64)}` } }, deletedAt: null },
    volumeInstance: { id: resource.volumeInstanceId, serviceId: resource.serviceId, environmentId: inventory(environment).environmentId,
      region: definition.railwayRegion, deletedAt: null, isPendingDeletion: false },
    backupSchedules: [{ retentionSeconds: environment === 'production' ? 30 * 86400 : 6 * 86400 }],
    backups: [{ id: 'snapshot', externalId: 'railway-snapshot', usedMB: 0, referencedMB: 0, volumeInstanceSizeMB: 1024,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }],
    pitrEstimate: { baseBackupLabel: 'full', likelyToFit: true },
    tcpProxies: [{ serviceId: resource.serviceId, environmentId: inventory(environment).environmentId, applicationPort: 5432,
      domain: 'tcp.railway.app', proxyPort: 12345, deletedAt: null }]
  };
  const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5,
    origin: { scheme: 'postgres', database, user: resource.databaseRole, host: 'tcp.railway.app', port: 12345 },
    mtls: { sslmode: 'verify-full', ca_certificate_id: uuid('c') } };
  return { label, environment, definition, resource, database, serviceName, projectId: inventory(environment).projectId, environmentId: inventory(environment).environmentId, railway, hyperdrive };
};

test('Railway cell pattern, physical regions and legacy provider are enforced', () => {
  assert.equal(validateTopology(topology), topology);
  assert.deepEqual(topology.environments.development.cells.map(cell => cell.id), ['ap-southeast', 'us-east', 'eu-west']);
  assert.deepEqual(topology.environments.production.cells.map(cell => cell.id), ['ap-southeast', 'us-east']);
  const old = copy(topology);
  old.provider = 'aws-rds-postgresql';
  assert.throws(() => validateTopology(old), /Unsupported topology/);
  const oldCell = copy(topology);
  oldCell.environments.development.cells[0].id = 'in-south';
  assert.throws(() => validateTopology(oldCell), /incomplete cell pattern/);
  const wrongRegion = copy(topology);
  wrongRegion.environments.production.cells[0].railwayRegion = 'ap-south-1';
  assert.throws(() => validateTopology(wrongRegion), /wrong provider region/);
  const strict = copy(topology);
  strict.environments.production.cells[0].strictResidency = true;
  assert.throws(() => validateTopology(strict), /unsupported field/);
});

test('inventory isolates every Railway service, volume and Hyperdrive binding', () => {
  for (const environment of ['development', 'production']) {
    const good = inventory(environment);
    assert.doesNotThrow(() => validateInventory(topology, environment, good));
    const reused = copy(good);
    reused.cells['us-east'].serviceId = reused.control.serviceId;
    assert.throws(() => validateInventory(topology, environment, reused), /must be unique/);
    const caseReused = copy(good);
    caseReused.cells['us-east'].hyperdriveId = caseReused.control.hyperdriveId.toUpperCase();
    assert.throws(() => validateInventory(topology, environment, caseReused), /must be unique/);
    caseReused.cells['us-east'].hyperdriveId = good.cells['us-east'].hyperdriveId;
    caseReused.cells['us-east'].serviceId = caseReused.control.serviceId.toUpperCase();
    assert.throws(() => validateInventory(topology, environment, caseReused), /must be unique/);
    caseReused.cells['us-east'].serviceId = good.cells['us-east'].serviceId;
    caseReused.cells['us-east'].volumeInstanceId = caseReused.control.volumeInstanceId.toUpperCase();
    assert.throws(() => validateInventory(topology, environment, caseReused), /must be unique/);
    const missingVolume = copy(good);
    delete missingVolume.cells['us-east'].volumeInstanceId;
    assert.throws(() => validateInventory(topology, environment, missingVolume), /volume instance ID/);
    const old = copy(good);
    old.cells['ap-southeast'].rdsInstanceId = 'old';
    assert.throws(() => validateInventory(topology, environment, old), /unsupported field/);
    const wrongNetwork = copy(good);
    wrongNetwork.control.network = 'workers-vpc';
    assert.throws(() => validateInventory(topology, environment, wrongNetwork), /unsupported/);
    for (const label of ['control', ...Object.keys(good.cells)]) {
      const unapproved = copy(good);
      const target = label === 'control' ? unapproved.control : unapproved.cells[label];
      delete target.postgresImageDigest;
      assert.throws(() => validateInventory(topology, environment, unapproved), /approved PostgreSQL image digest/);
    }
  }
});

test('development and production cannot reuse provider scope or bindings', () => {
  const development = inventory('development');
  const production = inventory('production');
  assert.throws(() => validateDeploymentInventories(topology, development, production), /must be unique/);
  production.projectId = uuid('c').replace('-1111-', '-7777-');
  production.environmentId = uuid('d').replace('-1111-', '-8888-');
  for (const resource of [production.control, ...Object.values(production.cells)]) {
    resource.serviceId = resource.serviceId.replace('-1111-4111-', '-3333-4333-');
    resource.volumeInstanceId = resource.volumeInstanceId.replace('-1111-4111-', '-4444-4444-');
    resource.hyperdriveId = `9${resource.hyperdriveId.slice(1)}`;
  }
  assert.doesNotThrow(() => validateDeploymentInventories(topology, development, production));
  for (const key of ['projectId', 'environmentId']) {
    const reused = copy(production);
    reused[key] = development[key].toUpperCase();
    assert.throws(() => validateDeploymentInventories(topology, development, reused), /must be unique/);
  }
  for (const key of ['serviceId', 'volumeInstanceId', 'hyperdriveId']) {
    const reused = copy(production);
    reused.control[key] = development.control[key].toUpperCase();
    assert.throws(() => validateDeploymentInventories(topology, development, reused), /must be unique/);
  }
});

test('rendered control, gateways and every cell use isolated names and secret-free bindings', () => {
  for (const environment of ['development', 'production']) {
    const env = topology.environments[environment];
    const rendered = renderTopology(topology, environment, inventory(environment), '/tmp/stateplane-topology');
    assert.equal(Object.keys(rendered).length, 3 + 3 * env.cells.length);
    assert.equal(rendered['directory.json'].hyperdrive[0].id, inventory(environment).control.hyperdriveId);
    assert.equal(rendered['app.json'].services.length, 1 + env.cells.length);
    assert.equal(rendered['mcp.json'].services.length, 1 + env.cells.length);
    for (const config of Object.values(rendered)) {
      assert.equal(config.workers_dev, false);
      assert.match(config.name, new RegExp(`^${env.prefix}-`));
      assert.equal(config.vars.STATEPLANE_ENV, environment);
    }
    for (const cell of env.cells) {
      const regional = ['api', 'mcp', 'jobs'].map(role => rendered[`${cell.id}-${role}.json`]);
      for (const config of regional) {
        assert.equal(config.hyperdrive[0].id, inventory(environment).cells[cell.id].hyperdriveId);
        assert.deepEqual(config.placement, { mode: 'smart' });
        assert.equal(config.r2_buckets[0].binding, 'ORIGINALS');
        assert.equal(config.r2_buckets[0].bucket_name, `${env.prefix}-${cell.id}-originals`);
        assert.equal(config.vars.STATEPLANE_CELL, cell.id);
      }
      assert.equal(regional[0].queues.producers[0].binding, 'PROJECTION_JOBS');
      assert.equal(regional[1].queues.producers[0].binding, 'PROJECTION_JOBS');
      assert.equal(regional[0].queues.producers[0].queue, `${env.prefix}-${cell.id}-projection`);
      assert.equal(regional[1].queues.producers[0].queue, `${env.prefix}-${cell.id}-projection`);
      assert.equal(regional[2].queues.consumers[0].queue, `${env.prefix}-${cell.id}-projection`);
      assert.equal(regional[2].queues.consumers[0].dead_letter_queue, `${env.prefix}-${cell.id}-projection-dlq`);
    }
    assert.equal(/password|DATABASE_URL|POSTGRES_PASSWORD/i.test(JSON.stringify(rendered)), false);
  }
});

test('provider readback rejects wrong region, volume, origin, backup, PITR, TLS and cache for every resource', () => {
  for (const environment of ['development', 'production']) {
    for (const label of ['control', ...topology.environments[environment].cells.map(cell => cell.id)]) {
      const good = live(environment, label);
      assert.doesNotThrow(() => assertLiveResources(good), `${environment}/${label}`);
      const check = edit => { const bad = copy(good); edit(bad); assert.throws(() => assertLiveResources(bad), undefined, `${environment}/${label}`); };
      check(bad => { bad.railway.serviceInstance.region = 'us-west2'; });
      check(bad => { bad.railway.volumeInstance.region = 'us-west2'; });
      check(bad => { bad.railway.service.name = 'another-cell'; });
      check(bad => { bad.railway.serviceInstance.source.image = 'redis:7'; });
      check(bad => { bad.railway.serviceInstance.latestDeployment.meta.image = 'redis:7'; });
      check(bad => { bad.railway.serviceInstance.latestDeployment.meta.imageDigest = null; });
      check(bad => { bad.railway.serviceInstance.latestDeployment.meta.imageDigest = `sha256:${'b'.repeat(64)}`; });
      check(bad => { bad.railway.serviceInstance.source.repo = 'unrelated/repo'; });
      check(bad => { bad.railway.backupSchedules = []; });
      check(bad => { bad.railway.backups = []; });
      check(bad => { bad.railway.backups[0].externalId = ''; });
      check(bad => { bad.railway.backups[0].usedMB = null; });
      check(bad => { bad.railway.backups[0].referencedMB = null; });
      check(bad => { bad.railway.backups[0].volumeInstanceSizeMB = 0; });
      check(bad => { bad.railway.backups[0].createdAt = new Date(Date.now() + 86400_000).toISOString(); });
      check(bad => { bad.railway.pitrEstimate = null; });
      check(bad => { bad.railway.tcpProxies[0].proxyPort = 5432; });
      check(bad => { bad.hyperdrive.caching.disabled = false; });
      check(bad => { bad.hyperdrive.mtls.sslmode = 'require'; });
      check(bad => { bad.hyperdrive.origin.database = 'other'; });
      check(bad => { bad.hyperdrive.origin.user = 'postgres'; });
      check(bad => { bad.hyperdrive.origin.user = 'stale_role'; });
      check(bad => { delete bad.hyperdrive.origin.user; });
      check(bad => { bad.hyperdrive.origin_connection_limit = 100; });
    }
  }
});

test('live provider identity accepts canonical hex case but rejects different IDs for every resource', () => {
  const identities = [
    [['resource', 'serviceId'], ['railway', 'service', 'id']],
    [['resource', 'serviceId'], ['railway', 'serviceInstance', 'serviceId']],
    [['resource', 'serviceId'], ['railway', 'volumeInstance', 'serviceId']],
    [['resource', 'serviceId'], ['railway', 'tcpProxies', 0, 'serviceId']],
    [['resource', 'volumeInstanceId'], ['railway', 'volumeInstance', 'id']],
    [['resource', 'hyperdriveId'], ['hyperdrive', 'id']],
    [['projectId'], ['railway', 'service', 'projectId']],
    [['environmentId'], ['railway', 'serviceInstance', 'environmentId']],
    [['environmentId'], ['railway', 'volumeInstance', 'environmentId']],
    [['environmentId'], ['railway', 'tcpProxies', 0, 'environmentId']]
  ];
  const parent = (value, path) => path.slice(0, -1).reduce((current, key) => current[key], value);
  for (const environment of ['development', 'production']) {
    for (const label of ['control', ...topology.environments[environment].cells.map(cell => cell.id)]) {
      for (const [expectedPath, actualPath] of identities) {
        const sample = live(environment, label);
        const expected = parent(sample, expectedPath);
        const actual = parent(sample, actualPath);
        const expectedKey = expectedPath.at(-1);
        const actualKey = actualPath.at(-1);
        expected[expectedKey] = expected[expectedKey].toUpperCase();
        assert.doesNotThrow(() => assertLiveResources(sample), `${environment}/${label} ${actualPath.join('.')}`);
        actual[actualKey] = `0${actual[actualKey].slice(1)}`;
        assert.throws(() => assertLiveResources(sample), /mismatch|unavailable|ambiguous/, `${environment}/${label} ${actualPath.join('.')}`);
      }
    }
  }
});

test('protected SQL proof rejects wrong database, role and untrusted TLS for every resource', async () => {
  for (const environment of ['development', 'production']) {
    for (const label of ['control', ...topology.environments[environment].cells.map(cell => cell.id)]) {
      const sample = live(environment, label);
      const proxy = sample.railway.tcpProxies[0];
      const url = `postgres://${sample.resource.databaseRole}:private@${proxy.domain}:${proxy.proxyPort}/${sample.database}`;
      // Operational roles may access application tables after schema migration.
      let grantRow = { safe_login: true, no_elevated_membership: true, no_other_role_membership: true, can_connect: true,
        no_database_create: true, can_use_schema: true, no_other_schema_create: true };
      const FakeClient = class {
        constructor(options) { this.options = options; }
        async connect() {
          if (this.options.ssl.ca !== 'expected-ca' || this.options.ssl.rejectUnauthorized !== true ||
              this.options.ssl.servername !== proxy.domain) throw new Error('untrusted TLS');
        }
        async query(sql) {
          if (sql.includes('current_database() AS database')) return { rows: [{ database: sample.database, role: sample.resource.databaseRole, version: 'PostgreSQL 16' }] };
          if (sql.includes('FROM pg_roles')) {
            assert.equal(sql.includes('FROM pg_class'), false, 'operational check must allow application table grants');
            return { rows: grantRow ? [grantRow] : [] };
          }
          return { rows: [{ distance: Math.SQRT2 }] };
        }
        async end() {}
      };
      await verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url, FakeClient);
      grantRow = { ...grantRow, no_elevated_membership: false };
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url, FakeClient), /verified-TLS/);
      grantRow = { ...grantRow, no_elevated_membership: true, no_other_role_membership: false };
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url, FakeClient), /verified-TLS/);
      grantRow = null;
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url, FakeClient), /verified-TLS/);
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'unrelated-ca', url, FakeClient), /verified-TLS/);
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url.replace(sample.database, 'wrong_database'), FakeClient), /differs/);
      await assert.rejects(verifySqlIdentity(label, sample.resource, sample.database, proxy, 'expected-ca', url.replace(sample.resource.databaseRole, 'wrong_role'), FakeClient), /differs/);
    }
  }
});

test('synthetic dry run inventories pass cross-environment isolation and compare shows its own syntax', async () => {
  assert.equal(await dryRunTopology(topology, { runWrangler: async () => ({ stdout: '' }) }), 21);
  assert.throws(() => execFileSync(process.execPath, ['scripts/topology.mjs', 'compare'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' }), error =>
    error.stderr.toString().includes('compare <development-inventory.json> <production-inventory.json>'));
});

test('synthetic collision fails before any generated file or Wrangler invocation', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sta4-topology-preflight-'));
  const inventories = syntheticInventories(topology);
  inventories.production.control.serviceId = inventories.development.control.serviceId.toUpperCase();
  let calls = 0;
  try {
    await assert.rejects(dryRunTopology(topology, { projectRoot, inventories, runWrangler: async () => { calls++; } }), /must be unique/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(projectRoot, '.data/topology-dry-run/development/app.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(projectRoot, '.data/topology-dry-run/production/app.json')), { code: 'ENOENT' });
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test('protected SQL URL file requires exact mode 0600', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-sql-urls-'));
  const path = join(directory, 'urls.json');
  try {
    await writeFile(path, '{"control":"postgres://test"}', { mode: 0o600 });
    assert.deepEqual(await readProtectedSqlUrls(path), { control: 'postgres://test' });
    await chmod(path, 0o700);
    await assert.rejects(readProtectedSqlUrls(path), /mode 0600/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

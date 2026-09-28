import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTopology, validateInventory, validateDeploymentInventories, renderTopology, cellDatabaseName, railwayServiceName } from '../scripts/topology.mjs';
import { assertLiveResources } from '../scripts/topology-live.mjs';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
const copy = value => structuredClone(value);
const uuid = digit => `${digit.repeat(8)}-1111-4111-8111-${digit.repeat(12)}`;
const inventory = environment => {
  const env = topology.environments[environment];
  const resources = [env.control, ...env.cells];
  const ids = resources.map((_, index) => ({
    hyperdriveId: (index + 1).toString(16).repeat(32), serviceId: uuid((index + 1).toString()),
    volumeInstanceId: uuid((index + 5).toString()), network: 'public-tls'
  }));
  return { environment, projectId: uuid('a'), environmentId: uuid('b'), control: ids[0],
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
    service: { id: resource.serviceId, name: serviceName, projectId: uuid('a'), deletedAt: null },
    serviceInstance: { serviceId: resource.serviceId, environmentId: uuid('b'), region: definition.railwayRegion,
      latestDeployment: { status: 'SUCCESS' }, deletedAt: null },
    volumeInstance: { id: resource.volumeInstanceId, serviceId: resource.serviceId, environmentId: uuid('b'),
      region: definition.railwayRegion, deletedAt: null, isPendingDeletion: false },
    backupSchedules: [{ retentionSeconds: environment === 'production' ? 30 * 86400 : 6 * 86400 }],
    backups: [{ id: 'snapshot', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }],
    pitrEstimate: { baseBackupLabel: 'full', likelyToFit: true },
    tcpProxies: [{ serviceId: resource.serviceId, environmentId: uuid('b'), applicationPort: 5432,
      domain: 'tcp.railway.app', proxyPort: 12345, deletedAt: null }]
  };
  const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5,
    origin: { scheme: 'postgres', database, host: 'tcp.railway.app', port: 12345 },
    mtls: { sslmode: 'verify-full', ca_certificate_id: uuid('c') } };
  return { label, environment, definition, resource, database, serviceName, projectId: uuid('a'), environmentId: uuid('b'), railway, hyperdrive };
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
    const missingVolume = copy(good);
    delete missingVolume.cells['us-east'].volumeInstanceId;
    assert.throws(() => validateInventory(topology, environment, missingVolume), /volume instance ID/);
    const old = copy(good);
    old.cells['ap-southeast'].rdsInstanceId = 'old';
    assert.throws(() => validateInventory(topology, environment, old), /unsupported field/);
    const wrongNetwork = copy(good);
    wrongNetwork.control.network = 'workers-vpc';
    assert.throws(() => validateInventory(topology, environment, wrongNetwork), /unsupported/);
  }
});

test('development and production cannot reuse provider scope or bindings', () => {
  const development = inventory('development');
  const production = inventory('production');
  assert.throws(() => validateDeploymentInventories(topology, development, production), /must be unique/);
  production.projectId = uuid('c');
  production.environmentId = uuid('d');
  for (const resource of [production.control, ...Object.values(production.cells)]) {
    resource.serviceId = resource.serviceId.replace(/^./, 'e');
    resource.volumeInstanceId = resource.volumeInstanceId.replace(/^./, 'f');
    resource.hyperdriveId = resource.hyperdriveId.replace(/^./, 'f');
  }
  assert.doesNotThrow(() => validateDeploymentInventories(topology, development, production));
});

test('rendered control, gateways and every cell use isolated names and secret-free bindings', () => {
  for (const environment of ['development', 'production']) {
    const env = topology.environments[environment];
    const rendered = renderTopology(topology, environment, inventory(environment), '/tmp/stateplane-topology');
    assert.equal(Object.keys(rendered).length, 3 + 3 * env.cells.length);
    assert.equal(rendered['directory.json'].hyperdrive[0].id, inventory(environment).control.hyperdriveId);
    assert.equal(rendered['app.json'].services.length, 1 + env.cells.length);
    for (const cell of env.cells) {
      assert.equal(rendered[`${cell.id}-api.json`].hyperdrive[0].id, inventory(environment).cells[cell.id].hyperdriveId);
      assert.equal(rendered[`${cell.id}-mcp.json`].hyperdrive[0].id, inventory(environment).cells[cell.id].hyperdriveId);
      assert.equal(rendered[`${cell.id}-jobs.json`].hyperdrive[0].id, inventory(environment).cells[cell.id].hyperdriveId);
      assert.equal(cellDatabaseName(env, cell).includes('in_south'), false);
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
      check(bad => { bad.railway.backupSchedules = []; });
      check(bad => { bad.railway.backups = []; });
      check(bad => { bad.railway.pitrEstimate = null; });
      check(bad => { bad.railway.tcpProxies[0].proxyPort = 5432; });
      check(bad => { bad.hyperdrive.caching.disabled = false; });
      check(bad => { bad.hyperdrive.mtls.sslmode = 'require'; });
      check(bad => { bad.hyperdrive.origin.database = 'other'; });
      check(bad => { bad.hyperdrive.origin_connection_limit = 100; });
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTopology, validateInventory, renderTopology } from '../scripts/topology.mjs';
import { assertLiveResources } from '../scripts/topology-live.mjs';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
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

test('rejects an incomplete cell pattern and a false regional label', () => {
  const incomplete = copy(topology);
  incomplete.environments.development.cells.pop();
  assert.throws(() => validateTopology(incomplete), /incomplete cell pattern/);
  const falseRegion = copy(topology);
  falseRegion.environments.production.cells[0].awsRegion = 'ap-southeast-1';
  assert.throws(() => validateTopology(falseRegion), /wrong provider region/);
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
  const sharedTunnel = inventory('development');
  sharedTunnel.cells['in-south'].network = sharedTunnel.cells['us-east'].network = 'workers-vpc';
  sharedTunnel.cells['in-south'].vpcServiceId = sharedTunnel.cells['us-east'].vpcServiceId = 'private-svc-1234';
  assert.throws(() => validateInventory(topology, 'development', sharedTunnel), /VPC service IDs must be unique/);
});

test('live gate rejects stale Hyperdrive caching, wrong origin and inadequate backup retention', () => {
  const definition = topology.environments.production.cells[0];
  const resource = inventory('production').cells['in-south'];
  const database = 'stateplane_prod_in_south';
  const host = 'sta-4.abcdefgh.ap-south-1.rds.amazonaws.com';
  const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: 7, PubliclyAccessible: true, Endpoint: { Address: host } };
  const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5, mtls: { sslmode: 'verify-full' }, origin: { host, database } };
  assert.doesNotThrow(() => assertLiveResources('in-south', 'production', definition, resource, database, hyperdrive, instance));
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, { ...hyperdrive, caching: { disabled: false } }, instance), /cache is enabled/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, { ...hyperdrive, origin: { ...hyperdrive.origin, database: 'other' } }, instance), /another database/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, resource, database, hyperdrive, { ...instance, BackupRetentionPeriod: 0 }), /backups\/PITR/);
  const privateResource = { ...resource, network: 'workers-vpc', vpcServiceId: 'private-svc-1234' };
  const privateOrigin = { ...hyperdrive, origin: { service_id: 'private-svc-1234', database }, mtls: {} };
  const vpc = { service_id: 'private-svc-1234', type: 'tcp', tcp_port: 5432, app_protocol: 'postgresql', host: { hostname: host }, tls_settings: { cert_verification_mode: 'verify_full' } };
  assert.doesNotThrow(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, vpc));
  assert.throws(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, { ...vpc, tls_settings: { cert_verification_mode: 'disabled' } }), /TLS verification/);
});

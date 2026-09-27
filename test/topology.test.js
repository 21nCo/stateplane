import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTopology, validateInventory, renderTopology, cellDatabaseName } from '../scripts/topology.mjs';
import { assertLiveResources } from '../scripts/topology-live.mjs';
import { createVpcServiceReader, parseVpcServiceResponse } from '../scripts/cloudflare-vpc.mjs';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
const caCertificateId = '550e8400-e29b-41d4-a716-446655440001';
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
  assert.throws(() => validateTopology(tooLong), /RDS database is invalid/);
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
  const sharedTunnel = inventory('development');
  sharedTunnel.cells['in-south'].network = sharedTunnel.cells['us-east'].network = 'workers-vpc';
  sharedTunnel.cells['in-south'].vpcServiceId = sharedTunnel.cells['us-east'].vpcServiceId = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(() => validateInventory(topology, 'development', sharedTunnel), /VPC service IDs must be unique/);
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
  const privateResource = { ...resource, network: 'workers-vpc', vpcServiceId: '550e8400-e29b-41d4-a716-446655440000' };
  const privateOrigin = { ...hyperdrive, origin: { service_id: privateResource.vpcServiceId, scheme: 'postgresql', database }, mtls: {} };
  const vpc = { service_id: privateResource.vpcServiceId, type: 'tcp', tcp_port: 5432, app_protocol: 'postgresql', host: { hostname: host }, tls_settings: { cert_verification_mode: 'verify_full' } };
  assert.doesNotThrow(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, vpc));
  const { tls_settings: _omitted, ...defaultTlsVpc } = vpc;
  assert.doesNotThrow(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, defaultTlsVpc));
  assert.throws(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, { ...vpc, tls_settings: { cert_verification_mode: 'verify_ca' } }), /TLS verification/);
  assert.throws(() => assertLiveResources('in-south', 'production', definition, privateResource, database, privateOrigin, { ...instance, PubliclyAccessible: false }, { ...vpc, tls_settings: { cert_verification_mode: 'disabled' } }), /TLS verification/);
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
      assert.throws(() => checkLive({ ...hyperdrive, origin: { ...hyperdrive.origin, scheme: 'mysql' } }), /not PostgreSQL/, `${environment}/${label}: MySQL scheme`);
      assert.throws(() => checkLive({ ...hyperdrive, origin: { ...hyperdrive.origin, port: 3306 } }), /origin port mismatch/, `${environment}/${label}: MySQL port`);
      assert.throws(() => checkLive(hyperdrive, { ...instance, Endpoint: { Address: host, Port: 3306 } }), /endpoint port mismatch/, `${environment}/${label}: RDS port`);

      const privateResource = { ...resource, network: 'workers-vpc', vpcServiceId: '550e8400-e29b-41d4-a716-446655440000' };
      const privateInstance = { ...instance, PubliclyAccessible: false };
      const privateOrigin = { ...hyperdrive, mtls: undefined, origin: { service_id: privateResource.vpcServiceId, scheme: 'postgresql', database } };
      const vpc = { service_id: privateResource.vpcServiceId, type: 'tcp', tcp_port: 5432, app_protocol: 'postgresql', host: { hostname: host } };
      assert.doesNotThrow(() => checkLive(privateOrigin, privateInstance, privateResource, vpc), `${environment}/${label}: valid private PostgreSQL origin`);
      assert.throws(() => checkLive({ ...privateOrigin, origin: { ...privateOrigin.origin, scheme: 'mysql' } }, privateInstance, privateResource, vpc), /not PostgreSQL/, `${environment}/${label}: private MySQL scheme`);
      assert.throws(() => checkLive(privateOrigin, { ...privateInstance, Endpoint: { Address: host, Port: 3306 } }, privateResource, vpc), /endpoint port mismatch/, `${environment}/${label}: private RDS port`);
      assert.throws(() => checkLive(privateOrigin, privateInstance, privateResource, { ...vpc, tcp_port: 3306 }), /VPC service target mismatch/, `${environment}/${label}: private service port`);
    }
  }
});

test('Cloudflare structured VPC API reads verify account and service identity before checking control and cell targets', async () => {
  const accountId = 'a'.repeat(32);
  const serviceId = '550e8400-e29b-41d4-a716-446655440000';
  const calls = [];
  const service = { service_id: serviceId, type: 'tcp', tcp_port: 5432, app_protocol: 'postgresql', host: { hostname: 'sta-4.abcdefgh.us-east-1.rds.amazonaws.com' }, tls_settings: { cert_verification_mode: 'verify_full' } };
  const read = await createVpcServiceReader('/wrangler', {
    accountId,
    run: async (_, args) => ({ stdout: JSON.stringify(args[0] === 'whoami'
      ? { loggedIn: true, accounts: [{ id: accountId }] }
      : { type: 'oauth', token: 'test-token' }) }),
    request: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return { ok: true, json: async () => ({ success: true, errors: [], messages: [], result: service }) };
    }
  });
  const fetched = await read(serviceId);
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/connectivity/directory/services/${serviceId}`);
  assert.equal(calls[0].authorization, 'Bearer test-token');
  for (const label of ['control', 'us-east']) {
    const env = topology.environments.production;
    const definition = label === 'control' ? env.control : env.cells.find(cell => cell.id === label);
    const resource = { ...(label === 'control' ? inventory('production').control : inventory('production').cells[label]), network: 'workers-vpc', vpcServiceId: serviceId };
    const database = label === 'control' ? env.control.database : cellDatabaseName(env, definition);
    const instance = { DBInstanceIdentifier: resource.rdsInstanceId, Engine: 'postgres', DBName: database, DBInstanceStatus: 'available', BackupRetentionPeriod: 7, PubliclyAccessible: false, Endpoint: { Address: service.host.hostname, Port: 5432 } };
    const hyperdrive = { id: resource.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5, origin: { service_id: serviceId, scheme: 'postgres', database } };
    assert.doesNotThrow(() => assertLiveResources(label, 'production', definition, resource, database, hyperdrive, instance, fetched));
    const { tls_settings: _omitted, ...defaultTlsService } = fetched;
    assert.doesNotThrow(() => assertLiveResources(label, 'production', definition, resource, database, hyperdrive, instance, defaultTlsService));
    assert.throws(() => assertLiveResources(label, 'production', definition, resource, database, hyperdrive, instance, { ...fetched, tls_settings: { cert_verification_mode: 'verify_ca' } }), /TLS verification/);
    assert.throws(() => assertLiveResources(label, 'production', definition, resource, database, hyperdrive, instance, { ...fetched, tls_settings: { cert_verification_mode: 'disabled' } }), /TLS verification/);
    assert.throws(() => assertLiveResources(label, 'production', definition, resource, database, hyperdrive, instance, { ...fetched, tcp_port: 5442 }), /VPC service target mismatch/);
  }
  assert.throws(() => parseVpcServiceResponse({ success: false, result: service }, serviceId), /unsuccessful/);
  assert.throws(() => parseVpcServiceResponse({ success: true, result: null }, serviceId), /empty result/);
  assert.throws(() => parseVpcServiceResponse({ success: true, result: { ...service, service_id: 'another' } }, serviceId), /ID mismatch/);
  await assert.rejects(() => createVpcServiceReader('/wrangler', {
    accountId: 'f'.repeat(32),
    run: async () => ({ stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: accountId }] }) })
  }), /authenticated Wrangler account/);
  const denied = await createVpcServiceReader('/wrangler', {
    accountId,
    run: async (_, args) => ({ stdout: JSON.stringify(args[0] === 'whoami'
      ? { loggedIn: true, accounts: [{ id: accountId }] }
      : { type: 'oauth', token: 'test-token' }) }),
    request: async () => ({ ok: false, status: 403 })
  });
  await assert.rejects(() => denied(serviceId), /HTTP 403/);
});

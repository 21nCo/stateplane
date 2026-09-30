import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir, copyFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTopology, validateInventory, validateDeploymentInventories, renderTopology, cellDatabaseName, railwayServiceName, validateRailwayServiceName, readProtectedDeploymentInventory } from '../scripts/topology.mjs';
import { assertLiveResources } from '../scripts/topology-live.mjs';
import { readProtectedSqlUrls, verifySqlIdentity } from '../scripts/topology-sql.mjs';
import { dryRunTopology, syntheticInventories } from '../scripts/topology-dry-run.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

const topology = JSON.parse(readFileSync(new URL('../deployment/topology.json', import.meta.url)));
const copy = value => structuredClone(value);
const uuid = digit => `${digit.repeat(8)}-1111-4111-8111-${digit.repeat(12)}`;
const inventory = environment => {
  const env = topology.environments[environment];
  const resources = [env.control, ...env.cells];
  const ids = resources.map((_, index) => ({
    hyperdriveId: `deadbee${index}`.repeat(4), serviceId: uuid('abcd'[index]),
    volumeInstanceId: uuid('ef12'[index]), network: 'public-tls',
    volumeMountPath: '/var/lib/postgresql/data',
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
      region: definition.railwayRegion, mountPath: resource.volumeMountPath, deletedAt: null, isPendingDeletion: false },
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

test('operational Railway names obey the provider limit before render and dry run', async () => {
  for (const environment of ['development', 'production']) {
    const env = topology.environments[environment];
    for (const cell of [undefined, ...env.cells]) {
      const label = `${environment} ${cell?.id ?? 'control'}`;
      const suffixLength = railwayServiceName({ prefix: '' }, cell).length;
      const atLimit = railwayServiceName({ prefix: 'a'.repeat(32 - suffixLength) }, cell);
      const overLimit = railwayServiceName({ prefix: 'a'.repeat(33 - suffixLength) }, cell);
      assert.equal(atLimit.length, 32, label);
      assert.equal(overLimit.length, 33, label);
      assert.doesNotThrow(() => validateRailwayServiceName(atLimit, label));
      assert.throws(() => validateRailwayServiceName(overLimit, label), /Railway service name is invalid/);
      assert.throws(() => validateRailwayServiceName(`${atLimit.slice(0, -1)}/`, label), /Railway service name is invalid/);
    }
    const accepted = copy(topology);
    accepted.environments[environment].prefix = 'a'.repeat(16);
    assert.doesNotThrow(() => validateTopology(accepted));
    const rejected = copy(accepted);
    rejected.environments[environment].prefix += 'a';
    assert.throws(() => validateTopology(rejected), new RegExp(`${environment} ap-southeast Railway service name is invalid`));
    const inventories = syntheticInventories(rejected);
    const counterpart = environment === 'development' ? 'production' : 'development';
    assert.throws(() => renderTopology(rejected, environment, inventories[environment], inventories[counterpart], '/tmp/stateplane-topology'),
      /Railway service name is invalid/);
    await assert.rejects(() => dryRunTopology(rejected, { runWrangler: () => { throw new Error('provider reached'); } }),
      /Railway service name is invalid/);
  }
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
    const missingMount = copy(good);
    delete missingMount.cells['us-east'].volumeMountPath;
    assert.throws(() => validateInventory(topology, environment, missingMount), /volume mount path/);
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

test('all operational inventory roles reject PostgreSQL reserved names before rendering', () => {
  for (const environment of ['development', 'production']) {
    const labels = ['control', ...topology.environments[environment].cells.map(cell => cell.id)];
    for (const label of labels) {
      for (const role of ['pg_worker', 'pg_', 'PG_worker', 'Pg_worker']) {
        const inventories = syntheticInventories(topology);
        const target = label === 'control' ? inventories[environment].control : inventories[environment].cells[label];
        target.databaseRole = role;
        assert.throws(() => validateDeploymentInventories(topology, inventories.development, inventories.production),
          /PostgreSQL role is invalid/, `${environment}/${label} ${role}`);
        const counterpart = environment === 'development' ? inventories.production : inventories.development;
        assert.throws(() => renderTopology(topology, environment, inventories[environment], counterpart, '/tmp/stateplane-topology'),
          /PostgreSQL role is invalid/, `${environment}/${label} render`);
      }
      const inventories = syntheticInventories(topology);
      const target = label === 'control' ? inventories[environment].control : inventories[environment].cells[label];
      target.databaseRole = 'worker_pg_valid';
      assert.doesNotThrow(() => validateDeploymentInventories(topology, inventories.development, inventories.production));
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
  development.routes = { app: 'https://dev.example.com', mcp: 'https://dev-mcp.example.com' };
  production.routes = { app: 'https://prod.example.com', mcp: 'https://prod-mcp.example.com' };
  assert.doesNotThrow(() => validateDeploymentInventories(topology, development, production));
  for (const [key, shared] of [['app', development.routes.app], ['mcp', development.routes.app], ['app', development.routes.mcp], ['mcp', development.routes.mcp]]) {
    const collided = copy(production);
    collided.routes[key] = shared;
    assert.throws(() => validateDeploymentInventories(topology, development, collided), /Public route hosts must be unique across environments/);
  }
});

test('live verification rechecks both protected inventories before provider access on every invocation', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-live-inventories-'));
  const paths = { development: join(directory, 'development.json'), production: join(directory, 'production.json') };
  const inventories = syntheticInventories(topology);
  const write = async (environment, value) => writeFile(paths[environment], JSON.stringify(value), { mode: 0o600 });
  const run = environment => spawnSync(process.execPath,
    ['scripts/verify-topology.mjs', environment, paths[environment],
      paths[environment === 'development' ? 'production' : 'development']],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, STATEPLANE_RAILWAY_ACCOUNT: 'preflight-only',
        STATEPLANE_SQL_URLS_FILE: '', STATEPLANE_PGDATA_URLS_FILE: '' } });
  try {
    await write('development', inventories.development);
    await write('production', inventories.production);
    for (const environment of ['development', 'production']) {
      const counterpart = environment === 'development' ? 'production' : 'development';
      assert.match(run(environment).stderr, /STATEPLANE_SQL_URLS_FILE/, 'distinct inventories pass isolation preflight');
      for (const [label, mutate] of [
        ['project', (target, source) => { target.projectId = source.projectId.toUpperCase(); }],
        ['environment', (target, source) => { target.environmentId = source.environmentId.toUpperCase(); }],
        ['service', (target, source) => { target.control.serviceId = source.control.serviceId.toUpperCase(); }],
        ['volume', (target, source) => { target.control.volumeInstanceId = source.control.volumeInstanceId.toUpperCase(); }],
        ['Hyperdrive', (target, source) => { target.control.hyperdriveId = source.control.hyperdriveId.toUpperCase(); }]
      ]) {
        const changed = copy(inventories[counterpart]);
        mutate(changed, inventories[environment]);
        await write(counterpart, changed);
        const result = run(environment);
        assert.equal(result.status, 1, `${environment} retry with reused ${label} must fail`);
        assert.match(result.stderr, /Development and production resource IDs must be unique/, `${environment} reused ${label}`);
        await write(counterpart, inventories[counterpart]);
      }
    }
    await chmod(paths.production, 0o640);
    assert.match(run('development').stderr, /Protected operational inventory must be mode 0600/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rendered control, gateways and every cell use isolated names and secret-free bindings', () => {
  const inventories = syntheticInventories(topology);
  for (const environment of ['development', 'production']) {
    const env = topology.environments[environment];
    const counterpart = environment === 'development' ? inventories.production : inventories.development;
    const rendered = renderTopology(topology, environment, inventories[environment], counterpart, '/tmp/stateplane-topology');
    assert.equal(Object.keys(rendered).length, 3 + 3 * env.cells.length);
    assert.equal(rendered['directory.json'].hyperdrive[0].id, inventories[environment].control.hyperdriveId);
    assert.deepEqual(rendered['directory.json'].placement, { mode: 'smart' });
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
        assert.equal(config.hyperdrive[0].id, inventories[environment].cells[cell.id].hyperdriveId);
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

test('render requires paired inventory and rechecks public app/MCP hosts on retry', () => {
  const inventories = syntheticInventories(topology);
  inventories.development.routes = { app: 'https://shared.example.com', mcp: 'https://dev-mcp.example.com' };
  inventories.production.routes = { app: 'https://prod.example.com', mcp: 'https://shared.example.com' };
  assert.throws(() => renderTopology(topology, 'development', inventories.development, undefined, '/tmp/topology'), /inventory must be an object/);
  for (const environment of ['development', 'production']) {
    const counterpart = environment === 'development' ? inventories.production : inventories.development;
    assert.throws(() => renderTopology(topology, environment, inventories[environment], counterpart, '/tmp/topology'),
      /Public route hosts must be unique across environments/);
  }
  inventories.production.routes.mcp = 'https://prod-mcp.example.com';
  assert.equal(renderTopology(topology, 'production', inventories.production, inventories.development, '/tmp/topology')['mcp.json'].routes[0].pattern,
    'prod-mcp.example.com');
  inventories.production.routes.app = 'https://shared.example.com';
  assert.throws(() => renderTopology(topology, 'production', inventories.production, inventories.development, '/tmp/topology'),
    /Public route hosts must be unique across environments/);
});

test('render CLI fails before writing config when counterpart is missing or shares a route', { skip: process.platform === 'win32' }, async () => {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'sta4-render-preflight-')));
  const inventories = syntheticInventories(topology);
  inventories.development.routes = { app: 'https://shared.example.com', mcp: 'https://dev-mcp.example.com' };
  inventories.production.routes = { app: 'https://prod.example.com', mcp: 'https://shared.example.com' };
  try {
    await mkdir(join(projectRoot, 'scripts'));
    await mkdir(join(projectRoot, 'deployment'));
    await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../scripts/topology.mjs', import.meta.url), join(projectRoot, 'scripts/topology.mjs'));
    await copyFile(new URL('../scripts/topology-live.mjs', import.meta.url), join(projectRoot, 'scripts/topology-live.mjs'));
    await writeFile(join(projectRoot, 'deployment/topology.json'), JSON.stringify(topology));
    const devPath = join(projectRoot, 'development.json');
    const prodPath = join(projectRoot, 'production.json');
    await writeFile(devPath, JSON.stringify(inventories.development), { mode: 0o600 });
    await writeFile(prodPath, JSON.stringify(inventories.production), { mode: 0o600 });
    const script = join(projectRoot, 'scripts/topology.mjs');
    assert.throws(() => execFileSync(process.execPath, [script, 'render', 'development', devPath], { cwd: projectRoot, stdio: 'pipe' }),
      /counterpart-inventory/);
    assert.throws(() => execFileSync(process.execPath, [script, 'render', 'development', devPath, prodPath], { cwd: projectRoot, stdio: 'pipe' }),
      /Public route hosts must be unique across environments/);
    await assert.rejects(readFile(join(projectRoot, '.data/topology/development/app.json')), { code: 'ENOENT' });
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test('operational compare, render, and verifier reject permissive inventories on each retry', { skip: process.platform === 'win32' }, async () => {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'sta4-inventory-mode-')));
  const inventories = syntheticInventories(topology);
  const paths = { development: join(projectRoot, 'development.json'), production: join(projectRoot, 'production.json') };
  const run = (script, args, options = {}) => execFileSync(process.execPath, [script, ...args],
    { cwd: projectRoot, stdio: 'pipe', ...options });
  const rejectsMode = action => assert.throws(action, error =>
    error.stderr?.toString().includes('Protected operational inventory must be mode 0600'));
  try {
    await mkdir(join(projectRoot, 'scripts'));
    await mkdir(join(projectRoot, 'deployment'));
    await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../scripts/topology.mjs', import.meta.url), join(projectRoot, 'scripts/topology.mjs'));
    await copyFile(new URL('../scripts/topology-live.mjs', import.meta.url), join(projectRoot, 'scripts/topology-live.mjs'));
    await writeFile(join(projectRoot, 'deployment/topology.json'), JSON.stringify(topology));
    for (const environment of ['development', 'production']) {
      await writeFile(paths[environment], JSON.stringify(inventories[environment]), { mode: 0o600 });
    }
    const script = join(projectRoot, 'scripts/topology.mjs');
    const compare = () => run(script, ['compare', paths.development, paths.production]);
    const render = environment => run(script, ['render', environment, paths[environment],
      paths[environment === 'development' ? 'production' : 'development']]);
    assert.match(compare().toString(), /inventories are isolated/);
    for (const environment of ['development', 'production']) {
      const path = paths[environment];
      await chmod(path, 0o644);
      await assert.rejects(readProtectedDeploymentInventory(path), /mode 0600/);
      rejectsMode(compare);
      for (const target of ['development', 'production']) rejectsMode(() => render(target));
      for (const target of ['development', 'production']) {
        await assert.rejects(readFile(join(projectRoot, `.data/topology/${target}/app.json`)), { code: 'ENOENT' });
      }
      rejectsMode(() => execFileSync(process.execPath, ['scripts/verify-topology.mjs', environment, path,
        paths[environment === 'development' ? 'production' : 'development']], {
        cwd: new URL('..', import.meta.url), stdio: 'pipe',
        env: { ...process.env, STATEPLANE_RAILWAY_ACCOUNT: 'mode-check-only' }
      }));
      await chmod(path, 0o600);
      assert.equal((await readProtectedDeploymentInventory(path)).environment, environment);
      assert.match(compare().toString(), /inventories are isolated/);
      assert.match(render(environment).toString(), /Rendered/);
      // A later retry must recheck permissions even after a successful render.
      await chmod(path, 0o640);
      rejectsMode(() => render(environment));
      await chmod(path, 0o600);
      await rm(join(projectRoot, '.data/topology'), { recursive: true, force: true });
    }
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test('provider readback rejects wrong region, volume, origin, backup, PITR, TLS and cache for every resource', () => {
  for (const environment of ['development', 'production']) {
    for (const label of ['control', ...topology.environments[environment].cells.map(cell => cell.id)]) {
      const good = live(environment, label);
      assert.doesNotThrow(() => assertLiveResources(good), `${environment}/${label}`);
      const check = edit => { const bad = copy(good); edit(bad); assert.throws(() => assertLiveResources(bad), undefined, `${environment}/${label}`); };
      check(bad => { bad.railway.serviceInstance.region = 'us-west2'; });
      check(bad => { bad.railway.volumeInstance.region = 'us-west2'; });
      check(bad => { bad.railway.volumeInstance.mountPath = '/wrong-volume'; });
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
      let grantRow = { safe_login: true, no_elevated_membership: true, no_other_role_membership: true,
        no_parameter_admin: true, no_restricted_catalog_execute: true, can_connect: true,
        no_database_create: true, can_use_schema: true, no_public_schema_create: true,
        no_other_schema_create: true, no_owned_objects: true };
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
      const proof = (ca = 'expected-ca', value = url) => verifySqlIdentity({ label, resource: sample.resource,
        database: sample.database, proxy, ca, value, ClientType: FakeClient });
      await proof();
      grantRow = { ...grantRow, no_public_schema_create: false };
      await assert.rejects(proof(), /verified-TLS/);
      grantRow = { ...grantRow, no_public_schema_create: true };
      grantRow = { ...grantRow, no_owned_objects: false };
      await assert.rejects(proof(), /verified-TLS/);
      grantRow = { ...grantRow, no_owned_objects: true };
      grantRow = { ...grantRow, no_restricted_catalog_execute: false };
      await assert.rejects(proof(), /verified-TLS/);
      grantRow = { ...grantRow, no_restricted_catalog_execute: true };
      grantRow = { ...grantRow, no_elevated_membership: false };
      await assert.rejects(proof(), /verified-TLS/);
      grantRow = { ...grantRow, no_elevated_membership: true, no_other_role_membership: false };
      await assert.rejects(proof(), /verified-TLS/);
      grantRow = null;
      await assert.rejects(proof(), /verified-TLS/);
      await assert.rejects(proof('unrelated-ca'), /verified-TLS/);
      await assert.rejects(proof('expected-ca', url.replace(sample.database, 'wrong_database')), /differs/);
      await assert.rejects(proof('expected-ca', url.replace(sample.resource.databaseRole, 'wrong_role')), /differs/);
    }
  }
});

test('interrupted protected SQL read closes the client and stops before grant or vector queries', async () => {
  const sample = live('development', 'control');
  const proxy = sample.railway.tcpProxies[0];
  const url = `postgres://${sample.resource.databaseRole}:private@${proxy.domain}:${proxy.proxyPort}/${sample.database}`;
  const controller = new AbortController();
  const queries = [];
  let closed = 0;
  class FakeClient {
    async connect() {}
    async query(sql) {
      queries.push(sql);
      controller.abort();
      return { rows: [{ database: sample.database, role: sample.resource.databaseRole, version: 'PostgreSQL 17' }] };
    }
    async end() { closed++; }
  }
  await assert.rejects(verifySqlIdentity({ label: 'control', resource: sample.resource, database: sample.database,
    proxy, ca: 'expected-ca', value: url, ClientType: FakeClient, signal: controller.signal }), /topology verification interrupted/);
  assert.equal(queries.length, 1);
  assert.equal(closed, 1);
});

test('synthetic dry run inventories pass cross-environment isolation and compare shows its own syntax', async () => {
  // Each environment renders app, MCP gateway and directory plus API, MCP and jobs per cell.
  const expected = Object.values(topology.environments).reduce((count, env) => count + 3 + 3 * env.cells.length, 0);
  assert.equal(await dryRunTopology(topology, { runWrangler: async () => ({ stdout: '' }) }), expected);
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

test('shared public route fails before rendering either environment', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sta4-route-preflight-'));
  const inventories = syntheticInventories(topology);
  inventories.development.routes = { app: 'https://shared.example.com', mcp: 'https://dev-mcp.example.com' };
  inventories.production.routes = { app: 'https://prod.example.com', mcp: 'https://shared.example.com' };
  let calls = 0;
  try {
    await assert.rejects(dryRunTopology(topology, { projectRoot, inventories, runWrangler: async () => { calls++; } }), /Public route hosts must be unique across environments/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(projectRoot, '.data/topology-dry-run/development/app.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(projectRoot, '.data/topology-dry-run/production/mcp.json')), { code: 'ENOENT' });
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

test('malformed protected SQL URL file does not expose credentials through parser errors', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-sql-redaction-'));
  const path = join(directory, 'urls.json');
  const secret = 'private-password-fragment-12345';
  try {
    await writeFile(path, `{"control":"postgres://role:${secret}@db.example/stateplane"`, { mode: 0o600 });
    await assert.rejects(readProtectedSqlUrls(path), error => {
      assert.equal(error.message, 'Protected SQL URL file is unreadable or invalid JSON');
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

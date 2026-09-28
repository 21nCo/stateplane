import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyQualificationTarget } from '../scripts/qualification-target.mjs';
import { syntheticInventories } from '../scripts/topology-dry-run.mjs';

const root = resolve(import.meta.dirname, '..');
const head = 'a'.repeat(40);
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const targets = [
  ['d', 'apse', 'asia-southeast1-eqsg3a'], ['d', 'use', 'us-east4-eqdc4a'],
  ['d', 'euw', 'europe-west4-drams3a'], ['p', 'apse', 'asia-southeast1-eqsg3a'],
  ['p', 'use', 'us-east4-eqdc4a']
];

function fixture(short, cell, region, index) {
  const name = `s4-${head}-${short}-${cell}`;
  const inventory = {
    name, projectId: uuid(1), environmentId: uuid(2), serviceId: uuid(index * 2 + 10),
    volumeInstanceId: uuid(index * 2 + 11), hyperdriveId: index.toString(16).padStart(32, '0'),
    database: `sta4_${head.slice(0, 16)}_${short === 'd' ? 'dev' : 'prod'}_${{ apse: 'ap_southeast', use: 'us_east', euw: 'eu_west' }[cell]}`,
    role: `sta4_probe_${head.slice(0, 16)}`
  };
  const proxy = { serviceId: inventory.serviceId, environmentId: inventory.environmentId,
    applicationPort: 5432, domain: 'proxy.example', proxyPort: 19876, deletedAt: null };
  const readback = {
    railway: {
      service: { id: inventory.serviceId, name, projectId: inventory.projectId, deletedAt: null },
      serviceInstance: { serviceId: inventory.serviceId, environmentId: inventory.environmentId,
        region, deletedAt: null, latestDeployment: { status: 'SUCCESS' } },
      volumeInstance: { id: inventory.volumeInstanceId, serviceId: inventory.serviceId,
        environmentId: inventory.environmentId, region, deletedAt: null, isPendingDeletion: false },
      tcpProxies: [proxy]
    },
    hyperdrive: { id: inventory.hyperdriveId, caching: { disabled: true }, origin_connection_limit: 5,
      origin: { scheme: 'postgres', database: inventory.database, user: inventory.role,
        host: proxy.domain, port: proxy.proxyPort },
      mtls: { sslmode: 'verify-full', ca_certificate_id: uuid(99) } }
  };
  return { name, inventory, readback };
}

test('each disposable cell requires an independent protected ID and physical provider readback before Preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-target-'));
  try {
    const topology = JSON.parse(await readFile(join(root, 'deployment/topology.json')));
    const operational = syntheticInventories(topology);
    const operationalInventoryPaths = {
      development: join(directory, 'development.json'), production: join(directory, 'production.json')
    };
    for (const environment of Object.keys(operationalInventoryPaths)) {
      await writeFile(operationalInventoryPaths[environment], JSON.stringify(operational[environment]), { mode: 0o600 });
    }
    for (const [index, [short, cell, region]] of targets.entries()) {
      const { name, inventory, readback } = fixture(short, cell, region, index + 1);
      const inventoryPath = join(directory, `${index}.json`);
      await writeFile(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
      const verify = (value = readback, artifactId = inventory.hyperdriveId) =>
        verifyQualificationTarget(root, name, head, artifactId, { inventoryPath, operationalInventoryPaths, readback: async () => value });
      assert.equal((await verify()).railwayRegion, region);
      await assert.rejects(verify({ ...readback, railway: { ...readback.railway,
        service: { ...readback.railway.service, name: 'stateplane-dev-ap-southeast' } } }), /service, volume/);
      await assert.rejects(verify(readback, 'f'.repeat(32)), /protected inventory/);
      await assert.rejects(verify({ ...readback, railway: { ...readback.railway,
        serviceInstance: { ...readback.railway.serviceInstance, region: 'us-east4-eqdc4a' === region ? 'asia-southeast1-eqsg3a' : 'us-east4-eqdc4a' } } }), /region or proxy/);
      await assert.rejects(verify({ ...readback, hyperdrive: { ...readback.hyperdrive,
        origin: { ...readback.hyperdrive.origin, host: 'other.example' } } }), /origin, role/);
      await assert.rejects(verify({ ...readback, hyperdrive: { ...readback.hyperdrive,
        origin: { ...readback.hyperdrive.origin, user: 'postgres' } } }), /origin, role/);
      // A restored volume or retry with a changed provider ID must receive a new protected record.
      await assert.rejects(verify({ ...readback, railway: { ...readback.railway,
        volumeInstance: { ...readback.railway.volumeInstance, id: uuid(500) } } }), /region or proxy/);
      for (const key of ['serviceId', 'volumeInstanceId', 'hyperdriveId']) {
        const changed = structuredClone(operational);
        changed.development.control[key] = inventory[key].toUpperCase();
        await writeFile(operationalInventoryPaths.development, JSON.stringify(changed.development), { mode: 0o600 });
        let readbackCalled = false;
        await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
          inventoryPath, operationalInventoryPaths,
          readback: async () => { readbackCalled = true; return readback; }
        }), /reuses an operational resource/);
        assert.equal(readbackCalled, false);
        await writeFile(operationalInventoryPaths.development, JSON.stringify(operational.development), { mode: 0o600 });
      }
      await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
        inventoryPath, operationalInventoryPaths: {}, readback: async () => readback
      }), /operational inventory paths required/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

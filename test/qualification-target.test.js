import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyQualificationTarget } from '../scripts/qualification-target.mjs';
import { qualificationConfig } from '../scripts/qualification-artifact.mjs';
import { syntheticInventories } from '../scripts/topology-dry-run.mjs';

const root = resolve(import.meta.dirname, '..');
const head = 'a'.repeat(40);
const uuid = index => `00000000-0000-4000-8000-a${String(index).padStart(11, '0')}`;
const targets = [
  ['d', 'apse', 'asia-southeast1-eqsg3a'], ['d', 'use', 'us-east4-eqdc4a'],
  ['d', 'euw', 'europe-west4-drams3a'], ['p', 'apse', 'asia-southeast1-eqsg3a'],
  ['p', 'use', 'us-east4-eqdc4a']
];

test('generator and verifier reject invalid physical placement before provider or Preview work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sta4-invalid-placement-'));
  const topologyPath = join(directory, 'deployment', 'topology.json');
  const original = JSON.parse(await readFile(join(root, 'deployment/topology.json')));
  await mkdir(join(directory, 'deployment'));
  try {
    for (const [short, cell] of targets) {
      const environment = short === 'd' ? 'development' : 'production';
      const cellId = { apse: 'ap-southeast', use: 'us-east', euw: 'eu-west' }[cell];
      for (const defect of ['railwayRegion', 'originConnectionLimit']) {
        const topology = structuredClone(original);
        const entry = topology.environments[environment].cells.find(value => value.id === cellId);
        entry[defect] = defect === 'railwayRegion' ? 'wrong-region' : 9999;
        await writeFile(topologyPath, JSON.stringify(topology));
        const name = `s4-${head}-${short}-${cell}`;
        await assert.rejects(qualificationConfig(directory, name, 'a'.repeat(32), head),
          /wrong provider region|connection limit is invalid/);
        let providerCalled = false;
        await assert.rejects(verifyQualificationTarget(directory, name, head, 'a'.repeat(32), {
          readback: async () => { providerCalled = true; throw new Error('provider reached'); }
        }), /wrong provider region|connection limit is invalid/);
        assert.equal(providerCalled, false, `${name}: invalid ${defect} must block provider readback`);
      }
    }
    const topology = structuredClone(original);
    topology.environments.production.cells[1].id = 'eu-west';
    await writeFile(topologyPath, JSON.stringify(topology));
    await assert.rejects(qualificationConfig(directory, `s4-${head}-p-apse`, 'a'.repeat(32), head),
      /incomplete cell pattern/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fixture(short, cell, region, index) {
  const name = `s4-${head}-${short}-${cell}`;
  const inventory = {
    name, projectId: uuid(1), environmentId: uuid(2), serviceId: uuid(index * 2 + 10),
    volumeInstanceId: uuid(index * 2 + 11), volumeMountPath: '/var/lib/postgresql/data',
    hyperdriveId: index.toString(16).padStart(32, 'a'),
    database: `sta4_${head.slice(0, 16)}_${short === 'd' ? 'dev' : 'prod'}_${{ apse: 'ap_southeast', use: 'us_east', euw: 'eu_west' }[cell]}`,
    role: `sta4_probe_${head.slice(0, 16)}`
  };
  const proxy = { serviceId: inventory.serviceId, environmentId: inventory.environmentId,
    applicationPort: 5432, domain: 'proxy.example', proxyPort: 19876, deletedAt: null };
  const readback = {
    railway: {
      service: { id: inventory.serviceId, name, projectId: inventory.projectId, deletedAt: null },
      serviceInstance: { serviceId: inventory.serviceId, environmentId: inventory.environmentId,
        region, deletedAt: null, source: { image: 'pgvector/pgvector:pg16', repo: null },
        latestDeployment: { status: 'SUCCESS', meta: {
          image: 'pgvector/pgvector:pg16', imageDigest: `sha256:${'a'.repeat(64)}`
        } } },
      volumeInstance: { id: inventory.volumeInstanceId, serviceId: inventory.serviceId,
        environmentId: inventory.environmentId, region, mountPath: inventory.volumeMountPath,
        deletedAt: null, isPendingDeletion: false },
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
        verifyQualificationTarget(root, name, head, artifactId, { inventoryPath, operationalInventoryPaths,
          readback: async () => value, pgdataProof: async () => {} });
      assert.equal((await verify()).railwayRegion, region);
      const provenanceCases = [
        instance => { instance.source.image = 'redis:7'; },
        instance => { instance.source.repo = 'unapproved/repo'; },
        instance => { instance.latestDeployment.meta.image = 'redis:7'; },
        instance => { instance.latestDeployment.meta.imageDigest = `sha256:${'b'.repeat(64)}`; },
        instance => { delete instance.latestDeployment.meta.imageDigest; }
      ];
      for (const change of provenanceCases) {
        const bad = structuredClone(readback);
        change(bad.railway.serviceInstance);
        let pgdataCalled = false;
        await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
          inventoryPath, operationalInventoryPaths, readback: async () => bad,
          pgdataProof: async () => { pgdataCalled = true; }
        }), /image or digest differs from approved inventory/);
        assert.equal(pgdataCalled, false, `${name}: rejected image must block before SQL or DDL`);
      }
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
      await assert.rejects(verify({ ...readback, railway: { ...readback.railway,
        volumeInstance: { ...readback.railway.volumeInstance, mountPath: '/wrong-volume' } } }), /region or proxy/);
      // A protected restore/retry ID update does not waive deployment provenance.
      const restored = structuredClone(readback);
      restored.railway.volumeInstance.id = uuid(700 + index);
      const restoredInventory = { ...inventory, volumeInstanceId: restored.railway.volumeInstance.id };
      await writeFile(inventoryPath, JSON.stringify(restoredInventory), { mode: 0o600 });
      assert.equal((await verify(restored)).railwayRegion, region);
      delete restored.railway.serviceInstance.latestDeployment.meta.imageDigest;
      await assert.rejects(verify(restored), /image or digest differs from approved inventory/);
      await writeFile(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
      await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
        inventoryPath, operationalInventoryPaths, readback: async () => readback,
        pgdataProof: async () => { throw new Error('PGDATA outside mount'); }
      }), /PGDATA outside mount/);
      for (const key of ['serviceId', 'volumeInstanceId', 'hyperdriveId']) {
        const changed = structuredClone(operational);
        changed.development.control[key] = inventory[key].toUpperCase();
        await writeFile(operationalInventoryPaths.development, JSON.stringify(changed.development), { mode: 0o600 });
        let readbackCalled = false;
        await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
          inventoryPath, operationalInventoryPaths,
          readback: async () => { readbackCalled = true; return readback; }, pgdataProof: async () => {}
        }), /reuses an operational resource/);
        assert.equal(readbackCalled, false);
        await writeFile(operationalInventoryPaths.development, JSON.stringify(operational.development), { mode: 0o600 });
      }
      await assert.rejects(verifyQualificationTarget(root, name, head, inventory.hyperdriveId, {
        inventoryPath, operationalInventoryPaths: {}, readback: async () => readback, pgdataProof: async () => {}
      }), /operational inventory paths required/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

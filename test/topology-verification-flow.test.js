import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBindingPreflight } from '../scripts/topology-verification-flow.mjs';

test('an interrupted provider read settles both reads and never deploys the Worker', async () => {
  const controller = new AbortController();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const stages = [];
  const proof = verifyBindingPreflight(controller.signal, {
    railway: async () => { stages.push('railway'); await Promise.resolve(); controller.abort(); throw new Error('aborted'); },
    hyperdrive: async () => { stages.push('hyperdrive-start'); await pending; stages.push('hyperdrive-settled'); },
    validate: () => stages.push('validate'), ca: () => stages.push('ca'),
    sql: () => stages.push('sql'), worker: () => stages.push('worker')
  });
  const rejection = assert.rejects(proof, /Topology verification interrupted/);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(stages, ['railway', 'hyperdrive-start']);
  } finally { release(); }
  await rejection;
  assert.deepEqual(stages, ['railway', 'hyperdrive-start', 'hyperdrive-settled']);
});

test('an interruption during verified SQL closes that stage before Worker deployment', async () => {
  const controller = new AbortController();
  let release;
  let started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const stages = [];
  const proof = verifyBindingPreflight(controller.signal, {
    railway: async () => 'railway', hyperdrive: async () => 'hyperdrive',
    validate: () => stages.push('validate'), ca: () => 'ca',
    sql: async () => { stages.push('sql-start'); started(); await pending; stages.push('sql-settled'); },
    worker: () => stages.push('worker')
  });
  const rejection = assert.rejects(proof, /Topology verification interrupted/);
  try {
    await entered;
    controller.abort();
    assert.deepEqual(stages, ['validate', 'sql-start']);
  } finally { release(); }
  await rejection;
  assert.deepEqual(stages, ['validate', 'sql-start', 'sql-settled']);
});

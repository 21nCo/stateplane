import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('in-flight provider child exits before an interrupted preflight settles', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  let child;
  let exited = false;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const stages = [];
  const proof = verifyBindingPreflight(controller.signal, {
    railway: async () => {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
        { signal: controller.signal, stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', () => {});
      child.stdout.once('data', () => ready());
      await new Promise((resolve, reject) => child.once('close', code => {
        exited = true;
        code === 0 ? resolve() : reject(new Error('provider child interrupted'));
      }));
    },
    hyperdrive: async () => { stages.push('hyperdrive'); },
    validate: () => stages.push('validate'), ca: () => stages.push('ca'),
    sql: () => stages.push('sql'), worker: () => stages.push('worker')
  });
  const rejection = assert.rejects(proof, /Topology verification interrupted/);
  try {
    await started;
    controller.abort();
    await rejection;
    assert.equal(exited, true);
    assert.deepEqual(stages, ['hyperdrive']);
  } finally {
    if (child && !exited) child.kill('SIGKILL');
  }
});

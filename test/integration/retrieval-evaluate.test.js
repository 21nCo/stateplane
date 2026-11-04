import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { DrainStalledError, drainProjections } from '../../scripts/retrieval-drain.mjs';
import { Spy, authority, baseUrl, fixture, pool, registry } from './retrieval-harness.js';

// The retrieval evaluation (STA-49) drains projection itself. An embedder that keeps failing must end that drain with
// an error that names no provider answer, and the disposable database must still be dropped.
const root = fileURLToPath(new URL('../..', import.meta.url));
const outstanding = async () => (await pool.query(`SELECT
  (SELECT count(*) FROM projection_outbox WHERE delivery_state<>'delivered')::int AS records,
  (SELECT count(*) FROM retrieval_outbox WHERE delivery_state='pending')::int AS evidence`)).rows[0];
const bounded = { stalls: 2, deadline: Date.now() + 120_000 };

test('a failing embedder stops the record and the evidence drain, and a working one then finishes both', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'lantern', note: 'cleaned the harbor lantern' });
  await f.record('beta', { title: 'trellis', note: 'repaired the garden trellis' });
  // Record events fail first: an outage never spends the delivery's failure budget, so they would retry forever.
  await assert.rejects(drainProjections(pool, authority, new EmbeddingRegistry([new Spy({ down: true })]), bounded),
    error => error instanceof DrainStalledError && /^record events: 2 still outstanding after 2 rounds without progress$/.test(error.message));
  assert.deepEqual(await outstanding(), { records: 2, evidence: 0 });
  await drainProjections(pool, authority, registry, bounded);
  assert.deepEqual(await outstanding(), { records: 0, evidence: 0 });

  // Evidence reaches only the worker's queue; a refused input there is retried with backoff the drain skips.
  await f.source('alpha', 'The orchard ladder was oiled and stored for winter.');
  await assert.rejects(drainProjections(pool, authority, new EmbeddingRegistry([new Spy({ fail: true })]), bounded),
    error => error instanceof DrainStalledError
      && /^evidence projection jobs: \d+ still outstanding after 2 rounds without progress$/.test(error.message));
  assert.equal((await outstanding()).records, 0);
  assert.ok((await outstanding()).evidence > 0);
  await drainProjections(pool, authority, registry, bounded);
  assert.deepEqual(await outstanding(), { records: 0, evidence: 0 });
});

test('the drain deadline ends a drain that is still making progress', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'kiln', note: 'tested the workshop kiln' });
  await assert.rejects(drainProjections(pool, authority, registry, { stalls: 5, deadline: Date.now() - 1 }),
    error => error instanceof DrainStalledError && /^record events: 1 still outstanding at the drain deadline after 0 rounds$/.test(error.message));
  await drainProjections(pool, authority, registry, bounded);
});

for (const mode of ['outage', 'refuse']) test(`an evaluation whose embedder keeps failing (${mode}) exits, prints no provider text and drops its database`, async () => {
  const evaluations = async () => {
    const client = new pg.Client({ connectionString: baseUrl });
    await client.connect();
    try { return (await client.query(`SELECT datname FROM pg_database WHERE datname LIKE 'stateplane\\_eval\\_%' ORDER BY 1`)).rows.map(row => row.datname); }
    finally { await client.end(); }
  };
  const before = await evaluations();
  const secret = `provider-secret-${process.pid}-${mode}`;
  const result = await new Promise(resolve => execFile(process.execPath, ['scripts/retrieval-evaluate.mjs', '--embedder', 'test/fixtures/failing-embedder.js',
    '--runs', '1', '--scale', '0', '--drain-stalls', '2', '--drain-seconds', '300'],
  { cwd: root, timeout: 280_000, env: { ...process.env, DATABASE_URL: baseUrl, FAILING_EMBEDDER_SECRET: secret, FAILING_EMBEDDER_MODE: mode } },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr })));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /DrainStalledError: record events: \d+ still outstanding after 2 rounds without progress/);
  assert.ok(!result.stderr.includes(secret), result.stderr);
  assert.deepEqual(await evaluations(), before);
});

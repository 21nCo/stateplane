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
// Fresh for each drain, so slow setup or an earlier test never spends a later drain's time.
const bounded = () => ({ stalls: 2, deadline: Date.now() + 120_000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a failing embedder stops the record and the evidence drain, and a working one then finishes both', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'lantern', note: 'cleaned the harbor lantern' });
  await f.record('beta', { title: 'trellis', note: 'repaired the garden trellis' });
  // Record events fail first: an outage never spends the delivery's failure budget, so they would retry forever.
  await assert.rejects(drainProjections(pool, authority, new EmbeddingRegistry([new Spy({ down: true })]), bounded()),
    error => error instanceof DrainStalledError && /^record events: 2 still outstanding after 2 rounds without progress$/.test(error.message));
  assert.deepEqual(await outstanding(), { records: 2, evidence: 0 });
  await drainProjections(pool, authority, registry, bounded());
  assert.deepEqual(await outstanding(), { records: 0, evidence: 0 });

  // Evidence reaches only the worker's queue; a refused input there is retried with backoff the drain skips.
  await f.source('alpha', 'The orchard ladder was oiled and stored for winter.');
  await assert.rejects(drainProjections(pool, authority, new EmbeddingRegistry([new Spy({ fail: true })]), bounded()),
    error => error instanceof DrainStalledError
      && /^evidence projection jobs: \d+ still outstanding after 2 rounds without progress$/.test(error.message));
  assert.equal((await outstanding()).records, 0);
  assert.ok((await outstanding()).evidence > 0);
  await drainProjections(pool, authority, registry, bounded());
  assert.deepEqual(await outstanding(), { records: 0, evidence: 0 });
});

test('the drain deadline ends a drain that is still making progress', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'kiln', note: 'tested the workshop kiln' });
  // The deadline has passed, so the first count races a 0 ms timer: either outcome reports no round run.
  await assert.rejects(drainProjections(pool, authority, registry, { stalls: 5, deadline: Date.now() - 1 }),
    error => error instanceof DrainStalledError && /^record events: (1|work) still outstanding at the drain deadline after 0 rounds$/.test(error.message));
  await drainProjections(pool, authority, registry, bounded());
});

test('the drain deadline bounds a started record batch, evidence steps and stalled statements', { timeout: 120_000 }, async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) await f.record('alpha', { title: `bay ${i}`, note: `inspected the pump at bay ${i}` });
  // Every message of the batch hangs in its embedder: none may outlive the deadline, and none starts after it.
  const starts = [];
  const hanging = new EmbeddingRegistry([new Spy({ hang: true, before: async () => { starts.push(Date.now()); } })]);
  const ends = async (run, deadline, label) => {
    const outcome = await Promise.race([run.then(() => 'drained', error => error), sleep(deadline - Date.now() + 5_000).then(() => 'still running')]);
    assert.ok(outcome instanceof DrainStalledError && /at the drain deadline/.test(outcome.message), `${label}: ${outcome}`);
    assert.ok(Date.now() < deadline + 1_000, `${label}: ended ${Date.now() - deadline} ms after the deadline`);
  };
  let deadline = Date.now() + 2_500;
  await ends(drainProjections(pool, authority, hanging, { stalls: 5, deadline }), deadline, 'record batch');
  assert.ok(starts.length > 0 && starts.every(at => at < deadline), `embedder calls started at ${starts.map(at => at - deadline)} ms`);
  // A statement waiting on a lock is cut at the deadline too.
  const locker = await pool.connect();
  try {
    await locker.query('BEGIN'); await locker.query('LOCK TABLE projection_outbox IN ACCESS EXCLUSIVE MODE');
    deadline = Date.now() + 1_500;
    await ends(drainProjections(pool, authority, registry, { stalls: 5, deadline }), deadline, 'locked count');
  } finally { await locker.query('ROLLBACK'); locker.release(); }
  await sleep(1_000);
  await drainProjections(pool, authority, registry, bounded());
  // Evidence: with less left than a step's minimum budget, no step starts and its work is untouched.
  await f.source('alpha', 'The orchard ladder was oiled and stored for winter.');
  const jobs = `SELECT count(*)::int AS pending, coalesce(sum(attempts),0)::int AS attempts FROM retrieval_outbox WHERE delivery_state='pending'`;
  const before = (await pool.query(jobs)).rows[0];
  assert.ok(before.pending > 0 && (await outstanding()).records === 0, JSON.stringify(before));
  await assert.rejects(drainProjections(pool, authority, registry, { stalls: 5, deadline: Date.now() + 600 }),
    error => error instanceof DrainStalledError && /^evidence projection jobs: \d+ still outstanding at the drain deadline after 0 rounds$/.test(error.message));
  assert.deepEqual((await pool.query(jobs)).rows[0], before);
  await drainProjections(pool, authority, registry, bounded());
});

test('the drain deadline cuts a stalled outbox claim, which stays deliverable', { timeout: 60_000 }, async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'kiln', note: 'tested the workshop kiln' });
  // The claim statement first sleeps on its own session, far past the deadline and the 5 s statement cap.
  const CLAIM = /started_attempt IS DISTINCT FROM attempts FOR UPDATE/;
  let stalled = 0;
  const bound = (target, name) => typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  const stalling = new Proxy(pool, { get: (base, name) => name !== 'connect' ? bound(base, name) : async () => {
    const client = await base.connect();
    return new Proxy(client, { get: (c, key) => key !== 'query' ? bound(c, key) : async (sql, ...rest) => {
      if (CLAIM.test(typeof sql === 'string' ? sql : sql?.text ?? '')) { stalled++; await c.query('SELECT pg_sleep(30) /* sta49-claim-stall */'); }
      return c.query(sql, ...rest);
    } });
  } });
  const deadline = Date.now() + 2_500;
  const outcome = await drainProjections(stalling, authority, registry, { stalls: 5, deadline }).then(() => 'drained', error => error);
  assert.ok(outcome instanceof DrainStalledError && /at the drain deadline/.test(outcome.message), String(outcome));
  assert.ok(Date.now() < deadline + 1_000, `ended ${Date.now() - deadline} ms after the deadline`);
  assert.ok(stalled > 0, 'the claim was reached');
  await sleep(deadline + 500 - Date.now());
  const active = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE state='active' AND query LIKE '%sta49-claim-stall%' AND query NOT LIKE '%pg_stat_activity%'`);
  assert.equal(active.rows[0].n, 0, 'the stalled claim statement still runs 500 ms after the deadline');
  // The cut claim rolled back: the event is neither started nor dead-lettered, and the next drain projects it.
  const row = `SELECT count(*)::int AS n FROM projection_outbox
    WHERE delivery_state<>'delivered' AND dead_lettered_at IS NULL AND started_attempt IS DISTINCT FROM attempts`;
  assert.equal((await pool.query(row)).rows[0].n, 1);
  await drainProjections(pool, authority, registry, bounded());
  assert.deepEqual(await outstanding(), { records: 0, evidence: 0 });
});

const evaluations = async () => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { return (await client.query(`SELECT datname FROM pg_database WHERE datname LIKE 'stateplane\\_eval\\_%' ORDER BY 1`)).rows.map(row => row.datname); }
  finally { await client.end(); }
};
const evaluate = (args, env) => new Promise(resolve => execFile(process.execPath, ['scripts/retrieval-evaluate.mjs',
  '--embedder', 'test/fixtures/failing-embedder.js', '--runs', '1', ...args],
{ cwd: root, timeout: 280_000, env: { ...process.env, DATABASE_URL: baseUrl, ...env } },
(error, stdout, stderr) => resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr })));
// Load queries that are not relevance queries.
const LOAD_ONLY = 'garden trellis|kiln workshop bay';

test('an outage after indexing is measured as degraded load, and fails the run where it would hide a plan', { timeout: 600_000 }, async () => {
  const before = await evaluations();
  // 3,072 dimensions are searched exactly: no ANN index, and the measurements are still published.
  const loaded = await evaluate(['--scale', '30', '--load', '10', '--concurrency', '2'],
    { FAILING_EMBEDDER_MODE: 'queries', FAILING_EMBEDDER_QUERIES: LOAD_ONLY, FAILING_EMBEDDER_DIMENSIONS: '3072' });
  assert.equal(loaded.code, 0, loaded.stderr);
  const { scale, filters } = JSON.parse(loaded.stdout);
  // Every run of each filtered query is checked: no hit of any run falls outside its filter.
  assert.deepEqual(Object.values(filters).map(mode => mode.hitsOutsideFilter), [0, 0, 0]);
  // Of 10 searches over 5 queries, the 4 of the 2 failing ones fell back to lexical.
  assert.deepEqual([scale.load.errors, scale.load.degraded, scale.load.latencyMs.samples], [0, 4, 6]);
  assert.deepEqual(scale.indexBytes.vector, 'exact search, no ANN index');
  assert.deepEqual(scale.plans.map(plan => plan.list).sort(), ['lexical', 'vector']);
  // Chunks of the scale space alone, not the relevance spaces before it: one per Ref of this corpus.
  assert.deepEqual([scale.chunks.lexical, scale.chunks.vector], [scale.refs, scale.refs]);
  const capture = await evaluate(['--scale', '30', '--load', '1'], { FAILING_EMBEDDER_MODE: 'queries', FAILING_EMBEDDER_QUERIES: 'repaired lantern harbor' });
  assert.equal(capture.code, 1, capture.stderr);
  assert.match(capture.stderr, /plan capture: ran lexical with state degraded/);
  assert.deepEqual(await evaluations(), before);
});

for (const mode of ['outage', 'refuse']) test(`an evaluation whose embedder keeps failing (${mode}) exits, prints no provider text and drops its database`, async () => {
  const before = await evaluations();
  const secret = `provider-secret-${process.pid}-${mode}`;
  const result = await evaluate(['--scale', '0', '--drain-stalls', '2', '--drain-seconds', '300'],
    { FAILING_EMBEDDER_SECRET: secret, FAILING_EMBEDDER_MODE: mode });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /DrainStalledError: record events: \d+ still outstanding after 2 rounds without progress/);
  assert.ok(!result.stderr.includes(secret), result.stderr);
  assert.deepEqual(await evaluations(), before);
});

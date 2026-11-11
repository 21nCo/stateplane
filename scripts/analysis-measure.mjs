#!/usr/bin/env node
// Analysis measurements (STA-60). It creates a disposable database on the PostgreSQL server of DATABASE_URL (the
// local one by default), migrates it, seeds the named generic fixture below and, through the real services, measures:
//   1. each aggregation shape at each --scales collection size: service latency and the EXPLAIN (ANALYZE, BUFFERS)
//      plan of its statement exactly as the service issues it (captured, then replayed with the same settings);
//   2. the same with the candidate covering index (CANDIDATE) built, its build time, and the record write cost with
//      and without it, and without and with migration 050's records_byte_order;
//   3. at the largest scale, an export and an aggregate snapshot job run to completion by the jobs Worker step, with
//      the plan of its as-of page read, and the typed index reconciliation over the collection;
//   4. mixed load: interactive reads alone, then while the jobs Worker step, aggregations, or both saturate analytical
//      capacity (aggregations retrying a refusal after 5 or after 250 ms), from two composed application services (two
//      isolates) at an origin connection limit of 5.
// The fixture's other space (--noise records) keeps the measured collection a fraction of the shared tables, as in a
// cell holding many spaces. With --reconciliation-only it seeds the fixture at the largest scale and measures only the
// reconciliation, --runs times. The report is written once, as JSON on stdout, after the run and its cleanup (diagnostics go
// to stderr; redirect stdout to keep it): the script names no file and writes none. When stdout cannot be written the
// report goes to stderr instead and the exit status is 1. It measures this fixture and this server only; it is no
// guarantee. The database is dropped at the end, also after a failure; when the drop
// itself fails, the run's own failure is still the one thrown, with the undropped database named on it (`cleanup`).
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpus, loadavg } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../packages/auth/dist/index.js';
import { aggregationBounds, analysisJobBounds, analyticalSlots, PostgresAggregations, PostgresAnalysisJobs, PostgresAnalysisWorker,
  PostgresSpaces, postgresServices, reconcileIndexes, reconciliationBounds } from '../packages/postgres/dist/index.js';
import { connectionOptions } from './db-connection.mjs';
import { percentile, round } from './relevance-metrics.mjs';

export const FIXTURE = 'analysis-fixture/v1';
/** The candidate typed index: each declared field's rows of a collection in record order, with their values. */
export const CANDIDATE = `CREATE INDEX record_index_by_field ON record_index_values(space_id,collection_id,field_name,record_id)
  INCLUDE (value_kind,string_value,number_value,boolean_value,time_value)`;
/** Migration 050's index, rebuilt as the migration builds it, less CONCURRENTLY: nothing else writes meanwhile. */
const BYTE_ORDER = 'CREATE INDEX records_byte_order ON records(space_id, collection_id, record_id COLLATE "C")';
/** The fixture's aggregation shapes: an ungrouped count, value and time-bucket groupings, and filtered ones. */
export const SHAPES = {
  count: { metrics: [{ op: 'count' }] },
  byValue: { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'avg', field: 'score' }] },
  byMonth: { groupBy: [{ field: 'at', bucket: { unit: 'month', timeZone: 'America/New_York' } }],
    metrics: [{ op: 'count' }, { op: 'max', field: 'score' }] },
  threeDimensions: { groupBy: [{ field: 'team' }, { field: 'active' }, { field: 'at', bucket: { unit: 'year', timeZone: 'UTC' } }],
    metrics: [{ op: 'count' }, { op: 'min', field: 'at' }], maxGroups: 1000 },
  filteredBroad: { where: [{ field: 'team', kind: 'string', operator: 'eq', value: 'team-3' }], groupBy: [{ field: 'active' }],
    metrics: [{ op: 'count' }] },
  filteredSelective: { where: [{ field: 'score', kind: 'number', operator: 'lt', value: 1000 }],
    metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] }
};
const SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {
  team: { type: ['string', 'null'] }, score: { type: ['number', 'null'] }, active: { type: ['boolean', 'null'] },
  at: { type: ['string', 'null'], format: 'date-time' } } };
const INDEXED = ['team', 'score', 'active', 'at'];
// Record n: team-(n mod 20); score n, null when n mod 11 is 0; active n even, missing when n mod 13 is 0; at every 97 s from
// 2020-01-01T00:00:00Z, repeating after 1,000,000 records (about 3 years).
const DATA = `jsonb_build_object('team','team-'||(g%20),'score',CASE WHEN g%11=0 THEN NULL ELSE g END,
  'at',to_char((timestamptz '2020-01-01 00:00:00+00'+(g%1000000)*interval '97 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  || CASE WHEN g%13=0 THEN '{}'::jsonb ELSE jsonb_build_object('active',g%2=0) END`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: options } = parseArgs({ options: {
    scales: { type: 'string', default: '50000,200000' }, noise: { type: 'string', default: '1000000' },
    runs: { type: 'string', default: '3' }, 'load-seconds': { type: 'string', default: '5' }, writes: { type: 'string', default: '300' },
    'reconciliation-only': { type: 'boolean', default: false } } });
  const count = (text, name, min) => {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`--${name} must be an integer of at least ${min}`);
    return value;
  };
  const settings = { scales: options.scales.split(',').map(text => count(text, 'scales', 1)), noise: count(options.noise, 'noise', 0),
    runs: count(options.runs, 'runs', 1), loadSeconds: count(options['load-seconds'], 'load-seconds', 1),
    writes: count(options.writes, 'writes', 1), reconciliationOnly: options['reconciliation-only'] };
  process.exitCode = await emitReport(await measure(settings));
}

/**
 * Handles an 'error' a stream emits after its failed write was already reported: the failure is not reported twice. A
 * declaration, so it exists when the command above reaches emitReport before this module finishes evaluating.
 */
function lateError() {}

/**
 * Write the report, as JSON, to `stdout` once. When that write fails (a closed pipe, a full disk behind a redirect) the
 * completed report is not lost: it goes to `stderr` after the reason, and the result is 1, the exit status; otherwise 0.
 * The call's own 'error' listener is removed once the write settles, so repeated calls on one stream add none; after a
 * failure the stream keeps one shared handler (added once per stream), so an 'error' it emits later is never unhandled.
 */
export async function emitReport(report, stdout = process.stdout, stderr = process.stderr) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  // A failed write may be thrown (a file written synchronously), passed to the callback and emitted as 'error': each is
  // handled, the first decides.
  let settle;
  const failure = await new Promise(resolve => {
    settle = resolve;
    stdout.on('error', settle);
    try { stdout.write(text, settle); } catch (error) { settle(error); }
  });
  stdout.off('error', settle);
  if (!failure) return 0;
  if (!stdout.listeners('error').includes(lateError)) stdout.on('error', lateError);
  stderr.write(`The report could not be written to stdout (${failure.message ?? failure}); it follows on stderr.\n${text}`);
  return 1;
}

/**
 * Run every measurement in a disposable database and return the report. `scales` must be strictly ascending: the last is
 * the largest, which the jobs, reconciliation, mixed load and limits measure, at most reconciliationBounds.maxRecords.
 */
export async function measure(settings) {
  if (!settings.scales.length || settings.scales.some((scale, i) => i > 0 && scale <= settings.scales[i - 1]))
    throw new RangeError('scales must be strictly ascending');
  // The largest scale is reconciled in one call: refused before any database is created, not after seeding.
  if (settings.scales.at(-1) > reconciliationBounds.maxRecords)
    throw new RangeError(`the largest scale must be at most ${reconciliationBounds.maxRecords}, the reconciliation bound`);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
  const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
  const name = `stateplane_measure_${randomUUID().replaceAll('-', '')}`;
  // Every connection takes the operator scripts' TLS policy (loopback plaintext, otherwise sslmode=verify-full), checked for
  // the server and the run's database before anything connects; migrate.mjs applies it to the same URL.
  const url = Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
  const adminOptions = { ...connectionOptions(baseUrl), connectionTimeoutMillis: 60_000, query_timeout: 60_000 }, database = connectionOptions(url);
  const onServer = async sql => {
    const client = new pg.Client(adminOptions);
    await client.connect();
    try { return await client.query(sql); } finally { await client.end(); }
  };
  await onServer(`CREATE DATABASE ${name}`);
  const pools = [];
  const newPool = max => { const pool = new pg.Pool({ ...database, max }); pool.on('error', () => {}); pools.push(pool); return pool; };
  let failure = null, result;
  try {
    execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
    result = await run(settings, newPool);
  } catch (error) { failure = { error }; }
  await Promise.race([Promise.all(pools.map(pool => pool.end())), sleep(5_000, undefined, { ref: false })]);
  let cleanup = null;
  try { await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch (error) {
    cleanup = Object.assign(new Error(`The measurement database ${name} was not dropped; drop it by hand`, { cause: error }),
      { database: name });
  }
  // A failed drop never replaces the run's own failure: it is attached to it.
  if (failure) {
    if (cleanup && failure.error !== null && typeof failure.error === 'object') failure.error.cleanup = cleanup;
    else if (cleanup) process.stderr.write(`${cleanup.message}: ${cleanup.cause}\n`);
    throw failure.error;
  }
  if (cleanup) throw cleanup;
  return result;
}

async function run(settings, newPool) {
  const pool = newPool(12);
  const config = { database: memoryAdapter(), namespace: `measure-${randomUUID()}`, plugins: [] };
  createAuthFn(config);
  const identity = new AuthFnIdentityVerifier(config);
  const spacesOn = interactive => new PostgresSpaces(interactive, new Map([['cell-a', { pool: interactive, storageTargetId: 'target-a' }]]),
    'cell-a', new AuthFnAgentKeys(config), identity, randomBytes(32));
  const spaces = spacesOn(pool);
  const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const token = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  const owner = await identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
  const server = (await pool.query('SELECT version() AS version')).rows[0].version;
  // The host's load around the run: measurements on a shared host move with it.
  const loadAtStart = loadavg().map(round);
  const define = async (spaceId, collectionId) => {
    await services.collections.define(owner, spaceId, collectionId, JSON.stringify({ slug: collectionId, version: 1, schema: SCHEMA,
      unique: [], filterable: INDEXED, sortable: ['score'] }));
    for (const field of INDEXED) await services.collections.backfill(owner, spaceId, collectionId, field);
  };
  const space = async () => { const spaceId = `sp_${randomUUID()}`; await spaces.create(owner, 'cell-a', spaceId); return spaceId; };

  const noiseSpace = await space();
  if (settings.noise) { await define(noiseSpace, 'noise'); await seed(pool, noiseSpace, 'noise', settings.noise, false); }
  const spaceId = await space();
  const report = kind => ({ contractVersion: '1', kind, measuredAt: new Date().toISOString(),
    note: 'Measurements of this fixture on this server only; not guarantees.',
    environment: { server, node: process.version, statementTimeoutMs: aggregationBounds.maxStatementMs, parallelWorkers: 0,
      host: { cpus: cpus().length, loadAverage: { start: loadAtStart, end: loadavg().map(round) } } },
    fixture: { name: FIXTURE, fields: { team: 'string, 20 values', score: 'number, null every 11th', active: 'boolean, missing every 13th',
      at: 'date-time, every 97 s from 2020-01-01T00:00:00Z' }, noiseRecords: settings.noise, scales: settings.scales, runs: settings.runs } });
  const reconcile = async (collectionId, records) => {
    const started = performance.now();
    const reconciliation = await reconcileIndexes(pool, spaceId, collectionId, { maxRecords: records });
    const seconds = (performance.now() - started) / 1000;
    return { records: reconciliation.checked, fields: reconciliation.fields, driftCount: reconciliation.driftCount, seconds: round(seconds),
      recordsPerSecond: round(reconciliation.checked / seconds) };
  };
  if (settings.reconciliationOnly) {
    const records = settings.scales.at(-1), collectionId = `measured-${records}`;
    await define(spaceId, collectionId);
    const seedSeconds = await seed(pool, spaceId, collectionId, records, true);
    const runs = [];
    for (let i = 0; i < settings.runs; i++) runs.push(await reconcile(collectionId, records));
    return { ...report('stateplane.analysis-reconciliation-measurements'), reconciliation: { seedSeconds, runs } };
  }

  // Aggregations run on an analytical pool that records each statement with the transaction's settings before it.
  const captured = [];
  const capturing = { connect: async () => {
    const client = await pool.connect();
    const before = [];
    return new Proxy(client, { get(object, property) {
      if (property !== 'query') return typeof object[property] === 'function' ? object[property].bind(object) : object[property];
      return (sql, values) => {
        if (typeof sql === 'string') {
          if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) before.length = 0;
          else if (/^\s*WITH grouped AS/.test(sql)) captured.push({ before: [...before], sql, values });
          else if (/SELECT f\.revision FROM record_event_feed f/.test(sql)) captured.push({ before: [...before], sql, values, asOf: true });
          else if (/^\s*(BEGIN|SET )/i.test(sql)) before.push(sql);
        }
        return object.query(sql, values);
      };
    } });
  } };
  const aggregations = new PostgresAggregations(spaces, new Map([['cell-a', { pool: capturing, admission: pool, originConnectionLimit: 20 }]]),
    { statementTimeoutMs: aggregationBounds.maxStatementMs });
  const explain = async statement => {
    const client = await pool.connect();
    try {
      for (const sql of statement.before) await client.query(sql);
      await client.query("SET LOCAL statement_timeout = '120s'");
      const [plan] = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values)).rows[0]['QUERY PLAN'];
      return { settings: statement.before.filter(sql => /^\s*SET /i.test(sql)), planningMs: round(plan['Planning Time']),
        executionMs: round(plan['Execution Time']), sharedHit: plan.Plan['Shared Hit Blocks'], sharedRead: plan.Plan['Shared Read Blocks'],
        indexes: walk(plan.Plan, 'Index Name'), plan: compact(plan.Plan) };
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  };
  const shapes = async (collectionId, records) => {
    const results = {};
    for (const [shape, spec] of Object.entries(SHAPES)) {
      const ms = [];
      let outcome = null;
      for (let i = 0; i < settings.runs; i++) {
        captured.length = 0;
        const started = performance.now();
        try {
          const result = await aggregations.aggregate(owner, spaceId, collectionId, spec);
          outcome = { groups: result.groups.length };
        } catch (error) {
          if (error?.limit !== 'time') throw error;
          outcome = { limit: 'time' };
        }
        ms.push(performance.now() - started);
      }
      const statement = captured.find(item => !item.asOf);
      results[shape] = { ...outcome, serviceMs: latency(ms), usPerRecord: round(percentile(ms, 50) * 1000 / records),
        explain: statement ? await explain(statement) : null };
    }
    return results;
  };

  const scales = [];
  let collectionId = null, records = 0;
  for (const scale of settings.scales) {
    collectionId = `measured-${scale}`;
    records = scale;
    await define(spaceId, collectionId);
    const seeded = await seed(pool, spaceId, collectionId, scale, true);
    const baseline = await shapes(collectionId, scale);
    const built = performance.now();
    await pool.query(CANDIDATE);
    const buildMs = round(performance.now() - built);
    await pool.query('VACUUM ANALYZE record_index_values');
    const candidate = await shapes(collectionId, scale);
    await pool.query('DROP INDEX record_index_by_field');
    await pool.query('ANALYZE record_index_values');
    scales.push({ records: scale, seedSeconds: seeded, baseline, candidate: { buildMs, shapes: candidate,
      speedup: Object.fromEntries(Object.keys(SHAPES).map(shape => [shape,
        round(baseline[shape].serviceMs.p50 / candidate[shape].serviceMs.p50)])) } });
  }

  // Record writes through the real write path, in a small collection of the same shape, without and with the candidate.
  await define(spaceId, 'writes');
  const rounds = { without: [], with: [] }, byteOrder = { with: [], without: [] };
  let written = 0;
  const writes = async () => {
    const ms = [], offset = written++;
    for (let n = offset * settings.writes; n < (offset + 1) * settings.writes; n++) {
      const started = performance.now();
      await services.records.mutate(owner, spaceId, 'writes', JSON.stringify({ idempotencyKey: randomUUID(), operation: 'create',
        data: { team: `team-${n % 20}`, score: n, active: n % 2 === 0, at: new Date(Date.UTC(2020, 0, 1) + n * 97_000).toISOString() } }));
      ms.push(performance.now() - started);
    }
    return latency(ms);
  };
  // Alternating rounds without and with it, so a change in the host's load meanwhile falls on both.
  let candidateBytes = 0;
  for (let round = 0; round < 2; round++) {
    rounds.without.push(await writes());
    await pool.query(CANDIDATE);
    candidateBytes = Number((await pool.query("SELECT pg_relation_size('record_index_by_field') AS n")).rows[0].n);
    rounds.with.push(await writes());
    await pool.query('DROP INDEX record_index_by_field');
  }
  // Migration 050's records_byte_order, which every record write maintains, likewise: with it, then without it.
  for (let round = 0; round < 2; round++) {
    byteOrder.with.push(await writes());
    await pool.query('DROP INDEX records_byte_order');
    byteOrder.without.push(await writes());
    await pool.query(BYTE_ORDER);
  }
  const indexBytes = (await pool.query(`SELECT pg_relation_size('record_index_values') AS heap,
    (SELECT sum(pg_relation_size(i.indexrelid)) FROM pg_index i WHERE i.indrelid='record_index_values'::regclass) AS indexes`)).rows[0];

  // Snapshot jobs at the largest scale: run by the jobs Worker step until both complete.
  const jobs = new PostgresAnalysisJobs(spaces, new Map([['cell-a', { pool: capturing }]]));
  const worker = new PostgresAnalysisWorker(capturing, { originConnectionLimit: 20 });
  const job = async (kind, spec) => {
    captured.length = 0;
    const submitted = await jobs.submit(owner, spaceId, collectionId, kind, spec && JSON.stringify(spec));
    const started = performance.now();
    let steps = 0, pages = 0, status;
    do {
      const step = await worker.step({ budgetMs: 10_000 });
      steps++; pages += step.pages;
      status = await jobs.status(owner, spaceId, collectionId, submitted.jobId);
    } while (status.state === 'queued' || status.state === 'running');
    const seconds = (performance.now() - started) / 1000;
    if (status.state !== 'completed') throw new Error(`The ${kind} job ended ${status.state} (${status.failureCode})`);
    const asOf = captured.find(item => item.asOf);
    return { kind, records: status.progress.recordsScanned, pagesWritten: status.progress.pagesWritten, steps, pageTransactions: pages,
      seconds: round(seconds), recordsPerSecond: round(status.progress.recordsScanned / seconds), stepRuntimeMs: status.progress.runtimeMs,
      manifest: { pageCount: status.manifest.pageCount, byteSize: status.manifest.byteSize }, freshness: status.freshness.state,
      asOfPagePlan: asOf ? await explain(asOf) : null };
  };
  const exportJob = await job('export');
  const aggregateJob = await job('aggregate', SHAPES.byValue);

  const reconciliation = await reconcile(collectionId, records);

  // Mixed load: interactive reads from the first isolate, alone and then under each analytical load from both isolates.
  const isolate = () => {
    const interactive = newPool(2);
    return postgresServices(spacesOn(interactive), new Map([['cell-a', { pool: interactive, cursorSecret: randomBytes(32),
      analytics: { pool: newPool(1), originConnectionLimit: 5 } }]]), 3600);
  };
  const isolates = [isolate(), isolate()];
  const recordId = 'rec_00000001';
  const reads = async (seconds, during = () => true) => {
    const ms = [];
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until && during()) {
      const started = performance.now();
      await Promise.all([
        isolates[0].records.get(owner, spaceId, collectionId, recordId),
        isolates[0].records.count(owner, spaceId, collectionId, JSON.stringify(SHAPES.filteredSelective.where))]);
      ms.push(performance.now() - started);
    }
    return latency(ms);
  };
  const loadJobs = new PostgresAnalysisJobs(spaces, new Map([['cell-a', { pool }]]));
  const loadWorker = new PostgresAnalysisWorker(newPool(2), { originConnectionLimit: 5 });
  const heavy = JSON.stringify(SHAPES.byValue);
  // Job result pages written within [after, until] (database clock), whichever step wrote them and whenever it returned.
  const pagesWithin = async (after, until) => Number((await pool.query(`SELECT count(*) AS n FROM analysis_result_pages
    WHERE space_id=$1 AND collection_id=$2 AND created_at>$3::timestamptz AND created_at<=$4::timestamptz`,
  [spaceId, collectionId, after, until])).rows[0].n);
  const aggregationLoop = (composed, retryMs, outcomes) => async load => {
    while (!load.stop) {
      try { await composed.analysis.aggregate(owner, spaceId, collectionId, heavy); outcomes.answered++; } catch (error) {
        if (error?.limit !== 'slots' && error?.limit !== 'time') throw error;
        outcomes.refused++;
        await sleep(retryMs);
      }
    }
  };
  /**
   * Interactive reads while the given analytical load runs: aggregation loops, each retrying a refusal after `retryMs`, and
   * jobs Worker steps. Every outcome is counted over one interval, from the phase's start to the end of its interactive
   * reads: the read pairs and aggregations answered or refused that completed in it, and the job result pages written
   * (`created_at`, the database's clock) in it, counted once the phase has settled. The interval's ends on the database's
   * clock are read on a connection held for the phase; `pageCutoffLagMs` is how long after the last read pair its end was
   * read, the only time a page written after the reads can still be counted.
   */
  const phase = async ({ aggregating, stepping, retryMs = 5 }) => {
    let peak = 0;
    const outcomes = { answered: 0, refused: 0 };
    if (stepping) await loadJobs.submit(owner, spaceId, collectionId, 'export');
    const marker = await pool.connect();
    try {
      const clock = async () => (await marker.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      const startedAt = await clock();
      const { endedAt, ...result } = await underLoad([
        ...(aggregating ? isolates : []).flatMap(composed => Array.from({ length: 6 }, () => aggregationLoop(composed, retryMs, outcomes))),
        ...(stepping ? [async load => { while (!load.stop) await loadWorker.step({ budgetMs: 2_000 }); }] : []),
        async load => {
          while (!load.stop) {
            const running = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
              AND state='active' AND query LIKE 'WITH grouped AS%'`)).rows[0].n;
            peak = Math.max(peak, running);
            await sleep(5);
          }
        }], async load => {
        const interactiveReadPairMs = await reads(settings.loadSeconds, () => !load.stop);
        const readsEnded = performance.now();
        const aggregations = { answered: outcomes.answered, refused: outcomes.refused, peakConcurrentStatements: peak };
        const at = await clock();
        return { retryAfterRefusalMs: aggregating ? retryMs : null, interactiveReadPairMs, aggregations, endedAt: at,
          pageCutoffLagMs: round(performance.now() - readsEnded) };
      });
      return { ...result, jobPagesWritten: await pagesWithin(startedAt, endedAt) };
    } finally { marker.release(); }
  };
  const phases = { alone: await phase({}), jobsOnly: await phase({ stepping: true }),
    aggregationsOnly: await phase({ aggregating: true }), aggregationsBackingOff: await phase({ aggregating: true, retryMs: 250 }),
    both: await phase({ aggregating: true, stepping: true }),
    bothBackingOff: await phase({ aggregating: true, stepping: true, retryMs: 250 }) };

  const largest = scales.at(-1);
  return { ...report('stateplane.analysis-measurements'), aggregations: scales,
    candidateIndex: { sql: CANDIDATE.replace(/\s+/g, ' '), recordWriteMs: rounds,
      bytes: { candidate: candidateBytes, table: Number(indexBytes.heap), existingIndexes: Number(indexBytes.indexes) } },
    byteOrderIndex: { sql: BYTE_ORDER, recordWriteMs: byteOrder },
    jobs: [exportJob, aggregateJob],
    reconciliation,
    mixedLoad: { originConnectionLimit: 5, analyticalSlots: analyticalSlots(5), isolates: 2, interactivePoolPerIsolate: 2,
      aggregationLoopsPerIsolate: 6, records: largest.records, phases },
    limits: limits(scales, [exportJob, aggregateJob]) };
}

/**
 * Run `body` while every load loop runs until `stop` is set; each gets and the body gets the same `{ stop }`. The first
 * failure of a loop sets `stop` at once, so the body and the other loops end, and is thrown once every loop has settled; a
 * failure of the body does the same. No loop's failure goes unobserved, so the caller's cleanup (dropping the run's
 * database) always runs.
 */
export async function underLoad(loops, body) {
  const load = { stop: false };
  let failed = null;
  const fail = error => { failed ??= { error }; load.stop = true; };
  const settled = Promise.all(loops.map(loop => Promise.resolve().then(() => loop(load)).catch(fail)));
  let result;
  try { result = await body(load); } catch (error) { fail(error); }
  load.stop = true;
  await settled;
  if (failed) throw failed.error;
  return result;
}

/**
 * Seed `count` fixture records into a collection directly, with their index values and (for `events`) their create
 * events published to the feed, in one transaction per 100,000; returns the seconds taken.
 */
export async function seed(pool, spaceId, collectionId, count, events) {
  const started = performance.now();
  for (let start = 0; start < count; start += 100_000) {
    const end = Math.min(count, start + 100_000) - 1, args = [spaceId, collectionId, start, end];
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        SELECT $1,$2,id,1,1,'generated',id,d::text,d FROM (SELECT 'rec_'||lpad(g::text,8,'0') AS id,${DATA} AS d
          FROM generate_series($3::int,$4::int) g) x`, args);
      // Fresh statistics keep the per-row foreign key and deferred projection checks on their indexes.
      await db.query('ANALYZE records');
      await db.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,
          boolean_value,time_value)
        SELECT $1,$2,r.record_id,f.field,
          CASE WHEN NOT r.data ? f.field THEN 'missing' WHEN jsonb_typeof(r.data->f.field)='null' THEN 'null'
            WHEN f.field='at' THEN 'date-time' ELSE jsonb_typeof(r.data->f.field) END,
          CASE WHEN f.field='team' THEN r.data->>'team' END,
          CASE WHEN f.field='score' AND jsonb_typeof(r.data->'score')='number' THEN (r.data->>'score')::numeric END,
          CASE WHEN f.field='active' AND r.data ? 'active' THEN (r.data->>'active')::boolean END,
          CASE WHEN f.field='at' THEN r.data->>'at' END
        FROM records r CROSS JOIN unnest(ARRAY['team','score','active','at']) f(field)
        WHERE r.space_id=$1 AND r.collection_id=$2 AND r.record_id BETWEEN 'rec_'||lpad($3::text,8,'0') AND 'rec_'||lpad($4::text,8,'0')`, args);
      if (events) {
        await db.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,
            canonical_data)
          SELECT 'evt_'||md5($1||$2||r.record_id),$1,$2,r.record_id,1,'create','fixture',1,r.canonical_data FROM records r
          WHERE r.space_id=$1 AND r.collection_id=$2 AND r.record_id BETWEEN 'rec_'||lpad($3::text,8,'0') AND 'rec_'||lpad($4::text,8,'0')
          ORDER BY r.record_id`, args);
        await db.query(`WITH published AS (DELETE FROM record_event_pending WHERE space_id=$1 AND collection_id=$2 RETURNING *)
          INSERT INTO record_event_feed(event_id,space_id,collection_id)
          SELECT event_id,space_id,collection_id FROM published ORDER BY committed_at,event_id`, [spaceId, collectionId]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
  }
  for (const table of ['records', 'record_index_values', 'record_events', 'record_event_feed']) await pool.query(`VACUUM ANALYZE ${table}`);
  return round((performance.now() - started) / 1000);
}

/**
 * What the measurements say about each bound: per unfiltered shape, the records one interactive aggregation covers within the
 * statement budget at the largest scale's cost per record (cost grows linearly with records), and the largest measured
 * scale that answered within it; per job kind, the records its runtime budget covers at the measured rate per second of
 * step time (what that budget counts, not wall time between steps), and those its byte budget covers at the measured
 * result bytes per record.
 */
export function limits(scales, jobs) {
  const largest = scales.at(-1);
  // Filtered shapes cost what their predicates match, not the collection's size: they are reported as measured only.
  const interactive = Object.fromEntries(Object.keys(SHAPES).filter(shape => !SHAPES[shape].where).map(shape => {
    const us = largest.baseline[shape].usPerRecord;
    const within = scales.filter(scale => scale.baseline[shape].serviceMs.p50 <= aggregationBounds.statementMs);
    return [shape, { usPerRecord: us, recordsWithinStatementBudget: us > 0 ? Math.floor(aggregationBounds.statementMs * 1000 / us) : null,
      largestMeasuredWithinBudget: within.length ? within.at(-1).records : null }];
  }));
  return { statementMs: aggregationBounds.statementMs, interactive,
    jobs: Object.fromEntries(jobs.map(job => [job.kind, { recordsPerStepSecond: round(job.records * 1000 / job.stepRuntimeMs),
      recordsWithinRuntimeBudget: Math.floor(job.records * analysisJobBounds.budgetRuntimeMs / job.stepRuntimeMs),
      resultBytesPerRecord: round(job.manifest.byteSize / job.records),
      recordsWithinByteBudget: Math.floor(job.records * analysisJobBounds.budgetBytes / job.manifest.byteSize),
      budgetRecords: analysisJobBounds.budgetRecords }])) };
}

function latency(values) {
  return { samples: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)),
    max: values.length ? round(Math.max(...values)) : null };
}
/** Every distinct value of `key` in a plan tree. */
function walk(node, key, found = new Set()) {
  if (node[key]) found.add(node[key]);
  for (const child of node.Plans ?? []) walk(child, key, found);
  return [...found].sort((a, b) => (a < b ? -1 : Number(a > b)));
}
/** A plan tree with each node's type, relation or index, rows, time and buffers only. */
function compact(node) {
  const kept = { node: node['Node Type'] };
  if (node['Relation Name']) kept.relation = node['Relation Name'];
  if (node['Index Name']) kept.index = node['Index Name'];
  if (node['Join Type']) kept.join = node['Join Type'];
  Object.assign(kept, { rows: node['Actual Rows'], loops: node['Actual Loops'], ms: round(node['Actual Total Time']),
    hit: node['Shared Hit Blocks'], read: node['Shared Read Blocks'] });
  if (node.Plans?.length) kept.children = node.Plans.map(compact);
  return kept;
}

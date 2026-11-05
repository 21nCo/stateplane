#!/usr/bin/env node
// Retrieval evaluation and measurement (STA-49). It creates a disposable database on the PostgreSQL server of
// DATABASE_URL (the local one by default), migrates it, and through the real space, record, source, claim, worker
// and search services measures:
//   1. relevance of the lexical, vector and hybrid lists on the generic corpus in test/fixtures/relevance-corpus.js
//      (nDCG@10, recall@10, precision@5 and MRR, overall and by query class);
//   2. filter recall of collection and kind filters, and every hit outside a filter in any run (which must be none);
//   3. search and bundle latency on that corpus;
//   4. at --scale synthetic Refs, the EXPLAIN (ANALYZE, BUFFERS) plans of the lexical and vector candidate statements
//      exactly as search issues them, and a concurrent search load.
// The report (JSON on stdout, or --out FILE) measures this corpus, this embedder and this server; it is no
// guarantee. The database is dropped at the end. The default embedder is the deterministic feature-hash one, which
// is not a semantic model; --embedder MODULE uses the Embedder a module exports as default (for a provider sandbox,
// scripts/http-embedder.mjs). Projection is drained as scripts/retrieval-drain.mjs bounds it: a queue that makes no
// progress for --drain-stalls rounds, or work left after --drain-seconds, ends the run with an error and the database
// is still dropped. Every measured search and bundle must have run hybrid (or lexical, where only that is projected) and
// current: relevance, bundles and plans fail the run otherwise, and load reports such answers as `degraded`, apart.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../packages/auth/dist/index.js';
import { PostgresAuthority, PostgresClaims, PostgresRetrievalSearch, PostgresSources, PostgresSpaces, postgresServices }
  from '../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbeddingRegistry } from '../packages/retrieval/dist/index.js';
import { R2BlobStore } from '../packages/storage/dist/index.js';
import { relevanceCollections, relevanceDocuments, relevanceQueries } from '../test/fixtures/relevance-corpus.js';
import { drainProjections } from './retrieval-drain.mjs';
import { mean, ndcgAt, percentile, precisionAt, recallAt, reciprocalRank, repeatSearch, round } from './relevance-metrics.mjs';

const { values: options } = parseArgs({ options: {
  runs: { type: 'string', default: '5' }, scale: { type: 'string', default: '2000' }, load: { type: 'string', default: '200' },
  concurrency: { type: 'string', default: '8' }, 'drain-seconds': { type: 'string', default: '3600' },
  'drain-stalls': { type: 'string', default: '5' }, embedder: { type: 'string' }, out: { type: 'string' } } });
const count = (name, min) => {
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`--${name} must be an integer of at least ${min}`);
  return value;
};
const runs = count('runs', 1), scale = count('scale', 0), load = count('load', 1), concurrency = count('concurrency', 1);
// Projection is drained only while it progresses and until this deadline, so a failing embedder ends the run.
const drainSettings = { deadline: Date.now() + count('drain-seconds', 1) * 1000, stalls: count('drain-stalls', 1) };
const root = fileURLToPath(new URL('..', import.meta.url));
const embedder = options.embedder ? (await import(pathToFileURL(options.embedder).href)).default : new DeterministicEmbedder();
const registry = new EmbeddingRegistry([embedder]);
const { embedder: embedderName, model, modelVersion, dimensions, region } = embedder.profile;
const KINDS = ['record', 'source', 'claim'];

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_eval_${randomUUID().replaceAll('-', '')}`;
// Server statements (create, drop) on their own connection, each bounded.
const SERVER_MS = 60_000;
async function onServer(sql) {
  const client = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: SERVER_MS, query_timeout: SERVER_MS });
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
}
await onServer(`CREATE DATABASE ${name}`);
const target = new URL(baseUrl); target.pathname = `/${name}`;
const pool = new pg.Pool({ connectionString: target.toString(), max: Math.max(8, concurrency + 2) });
// Dropping the database ends its sessions, idle ones included.
pool.on('error', () => {});
try {
  execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'ignore' });
  const text = `${JSON.stringify(await evaluate(), null, 2)}\n`;
  if (options.out) await writeFile(options.out, text); else process.stdout.write(text);
} finally {
  // Work a failed drain abandoned may still hold sessions: FORCE ends them, so cleanup never waits on them.
  await onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await Promise.race([pool.end(), new Promise(resolve => setTimeout(resolve, 5_000).unref())]);
}

async function evaluate() {
  const config = { database: memoryAdapter(), namespace: `eval-${randomUUID()}`, plugins: [] };
  createAuthFn(config);
  const identity = new AuthFnIdentityVerifier(config);
  const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
    new AuthFnAgentKeys(config), identity, randomBytes(32));
  const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600, { embedders: registry });
  const sources = new PostgresSources(spaces, new Map([['cell-a', { pool, originals: new R2BlobStore(memoryR2()) }]]));
  const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
  const authority = new PostgresAuthority(pool, 3600);
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const token = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  const owner = await identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
  const environment = (await pool.query(`SELECT version() AS server, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector`)).rows[0];

  /** A space whose collections are projected under `policy`, holding `documents`; returns it and each Ref's document ID. */
  async function space(policy, documents) {
    const spaceId = `sp_${randomUUID()}`;
    await spaces.create(owner, 'cell-a', spaceId);
    for (const collectionId of relevanceCollections) {
      await services.collections.define(owner, spaceId, collectionId, JSON.stringify({ slug: collectionId, version: 1,
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { note: { type: 'string' } },
          additionalProperties: false }, unique: [], filterable: [], sortable: [] }));
      await pool.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
        lexical,vector,text_search_config,processing_regions,credential_id) VALUES($1,$2,1,'{/note}',true,true,$3,$4,'english',$5,'owner')`,
      [spaceId, collectionId, policy.lexical, policy.vector, [region]]);
      await pool.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
        model_version,dimensions) VALUES($1,$2,1,1,$3,$4,$5,$6)`, [spaceId, collectionId,
        ...(policy.vector ? [embedderName, model, modelVersion, dimensions] : [null, null, null, null])]);
      for (const state of ['verifying', 'active']) await pool.query(`UPDATE projection_generations SET state=$3
        WHERE space_id=$1 AND collection_id=$2 AND generation=1`, [spaceId, collectionId, state]);
    }
    const refs = new Map();
    const { policy_version: version } = (await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1', [spaceId])).rows[0];
    for (const document of documents) {
      const key = randomUUID();
      if (document.kind === 'record') {
        const receipt = await authority.mutate({ spaceId, collectionId: document.collection, principalId: user.id,
          credentialId: owner.credentialId, capability: 'records:write', policyVersion: Number(version), placementGeneration: 1 },
        { operation: 'create', idempotencyKey: key, requestDigest: createHash('sha256').update(key).digest('hex'),
          canonicalData: JSON.stringify({ note: document.text }) });
        refs.set(`${document.collection}/record/${receipt.ref.id}`, document.id);
      } else if (document.kind === 'source') {
        const created = await sources.ingestText(owner, spaceId, document.collection, { idempotencyKey: key, text: document.text });
        await sources.extract(owner, spaceId, document.collection, created.sourceId);
        refs.set(`${document.collection}/source/${created.sourceId}`, document.id);
      } else {
        const created = await claims.create(owner, spaceId, document.collection, { idempotencyKey: key, statement: document.text,
          attributedTo: 'Relevance corpus' });
        refs.set(`${document.collection}/claim/${created.claimId}`, document.id);
      }
    }
    await drainProjections(pool, authority, registry, drainSettings);
    return { spaceId, refs };
  }

  const policies = { lexical: { lexical: true, vector: false }, vector: { lexical: false, vector: true }, hybrid: { lexical: true, vector: true } };
  const relevance = {}, filters = {}, latencyMs = {}, budgets = {};
  for (const [mode, policy] of Object.entries(policies)) {
    const { spaceId, refs } = await space(policy, relevanceDocuments);
    const rows = [], searchMs = [];
    for (const query of relevanceQueries) {
      const request = { query: query.query, limit: 10, ...query.filter };
      // Every run's hits are checked against the filter; relevance ranks the first run's.
      const { first, outside } = await repeatSearch(runs, async () => {
        const { value, ms } = await timed(() => services.retrieval.search(owner, spaceId, request));
        searchMs.push(ms);
        return covered(`${mode} ${query.id}`, policy, value).results;
      }, query.filter);
      const ranked = first.map(hit => refs.get(`${hit.ref.collectionId}/${hit.ref.kind}/${hit.ref.id}`));
      rows.push({ id: query.id, class: query.class, ndcg10: ndcgAt(10, ranked, query.relevant), recall10: recallAt(10, ranked, query.relevant),
        precision5: precisionAt(5, ranked, query.relevant), rr: reciprocalRank(ranked, query.relevant), returned: ranked.length, outside });
    }
    relevance[mode] = { all: summary(rows), byClass: Object.fromEntries(['keyword', 'morphology', 'paraphrase', 'filtered']
      .map(cls => [cls, summary(rows.filter(row => row.class === cls))])),
    queries: rows.map(row => ({ id: row.id, ndcg10: round(row.ndcg10), recall10: round(row.recall10), returned: row.returned })) };
    const filtered = rows.filter(row => row.class === 'filtered');
    filters[mode] = { queries: filtered.length, recall10: round(mean(filtered.map(row => row.recall10))),
      hitsOutsideFilter: filtered.reduce((sum, row) => sum + row.outside.length, 0) };
    const bundleMs = [];
    for (const query of relevanceQueries.filter(item => item.class === 'keyword')) for (let run = 0; run < runs; run++)
      bundleMs.push((await timed(async () => covered(`${mode} bundle`, policy,
        await services.retrieval.bundle(owner, spaceId, { query: query.query, budget: { tokens: 4096 } })))).ms);
    latencyMs[mode] = { search: latency(searchMs), bundle: latency(bundleMs) };
    // What the budget bounds hold (STA-47 set them as protective bounds, not measured settings).
    budgets[mode] = {};
    for (const tokens of [1024, 4096, 16384]) {
      const bundles = [];
      for (const query of relevanceQueries.filter(item => item.class === 'keyword'))
        bundles.push(covered(`${mode} bundle`, policy, await services.retrieval.bundle(owner, spaceId, { query: query.query, budget: { tokens } })));
      budgets[mode][tokens] = { bundles: bundles.length, excerpts: round(mean(bundles.map(bundle => bundle.excerpts.length))),
        bytes: round(mean(bundles.map(bundle => bundle.usage.bytes))), truncated: bundles.filter(bundle => bundle.truncated).length };
    }
  }

  return { contractVersion: '1', kind: 'stateplane.retrieval-evaluation', measuredAt: new Date().toISOString(),
    note: 'Measurements of this corpus, embedder and server only; not guarantees.',
    environment: { server: environment.server, pgvector: environment.pgvector, node: process.version,
      embedder: { embedder: embedderName, model, modelVersion, dimensions, region } },
    corpus: { documents: relevanceDocuments.length, queries: relevanceQueries.length, runsPerQuery: runs },
    relevance, filters, latencyMs, bundleBudgets: budgets, scale: scale ? await atScale(space, spaces, services, owner) : null };
}

/** Plans and load at `scale` synthetic Refs in one hybrid space, the relevance corpus among them. */
async function atScale(space, spaces, services, owner) {
  const topics = ['harbor', 'orchard', 'workshop', 'garden', 'archive', 'kitchen', 'observatory', 'meadow', 'river', 'studio'];
  const verbs = ['inspected', 'cleaned', 'repaired', 'recorded', 'planted', 'measured', 'painted', 'sorted', 'oiled', 'tested'];
  const objects = ['lantern', 'fence', 'ledger', 'pump', 'trellis', 'gauge', 'kiln', 'loom', 'hinge', 'shelf'];
  const synthetic = Array.from({ length: scale }, (_, i) => ({ id: `synthetic-${i}`, collection: relevanceCollections[i % 3], kind: 'record',
    text: `Note ${i}: the ${topics[i % 10]} team ${verbs[Math.floor(i / 10) % 10]} the ${objects[Math.floor(i / 100) % 10]} near bay ${i % 37}.` }));
  const started = performance.now();
  const { spaceId } = await space({ lexical: true, vector: true }, [...relevanceDocuments, ...synthetic]);
  const loadSeconds = round((performance.now() - started) / 1000);
  for (const table of ['lexical_chunks', 'vector_chunks', 'projection_refs', 'records', 'entity_refs', 'collections'])
    await pool.query(`ANALYZE ${table}`);
  // Chunks of the scale space only; an index serves every space, so its size is the whole database's. A dimension
  // searched exactly (vector_index_strategies) has no ANN index.
  const sizes = (await pool.query(`SELECT (SELECT count(*) FROM lexical_chunks WHERE space_id=$1)::int AS lexical,
      (SELECT count(*) FROM vector_chunks WHERE space_id=$1)::int AS vector, pg_relation_size('lexical_chunks_tsv') AS gin,
      v.index_name AS ann, CASE WHEN v.index_name IS NULL THEN NULL ELSE pg_relation_size(v.index_name::regclass) END AS ann_bytes
    FROM vector_index_strategies v WHERE v.dimensions=$2`, [spaceId, dimensions])).rows[0];

  // One search over a pool that records each candidate statement with the transaction's statements before it; each is
  // then replayed under EXPLAIN (ANALYZE, BUFFERS) with the same settings, in a transaction that is rolled back.
  const captured = [];
  const capturing = { connect: async () => {
    const client = await pool.connect();
    const before = [];
    return new Proxy(client, { get(object, property) {
      if (property !== 'query') return typeof object[property] === 'function' ? object[property].bind(object) : object[property];
      return (sql, values) => {
        if (typeof sql === 'string') {
          if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) before.length = 0;
          else if (/websearch_to_tsquery/.test(sql) && /lexical_chunks/.test(sql)) captured.push({ list: 'lexical', before: [...before], sql, values });
          else if (/<=>/.test(sql)) captured.push({ list: 'vector', before: [...before], sql, values });
          else if (/^\s*(BEGIN|SET )/i.test(sql)) before.push(sql);
        }
        return object.query(sql, values);
      };
    } });
  } };
  const query = 'repaired lantern harbor';
  covered('plan capture', { vector: true }, await new PostgresRetrievalSearch(spaces, new Map([['cell-a', { pool: capturing }]]),
    { embedders: registry }).search(owner, spaceId, { query, limit: 10 }));
  if (!['lexical', 'vector'].every(list => captured.some(statement => statement.list === list)))
    throw new Error(`plan capture: captured ${captured.map(statement => statement.list).join(', ') || 'no'} candidate statements`);
  const plans = [];
  for (const statement of captured) {
    const client = await pool.connect();
    try {
      for (const sql of statement.before) await client.query(sql);
      const [plan] = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values)).rows[0]['QUERY PLAN'];
      plans.push({ list: statement.list, query, settings: statement.before.filter(sql => /^\s*SET /i.test(sql)),
        planningMs: round(plan['Planning Time']), executionMs: round(plan['Execution Time']), indexes: walk(plan.Plan, 'Index Name'),
        nodes: walk(plan.Plan, 'Node Type'), plan: plan.Plan });
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  }

  const queries = [query, 'garden trellis', 'kiln workshop bay', 'lighthouse lens cleaning', 'river flood'];
  const samples = [];
  let errors = 0, degraded = 0, next = 0;
  const loadStarted = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < load) {
      const text = queries[next++ % queries.length];
      try {
        const { value, ms } = await timed(() => services.retrieval.search(owner, spaceId, { query: text, limit: 10 }));
        // A lexical fallback or a degraded answer is not a hybrid sample.
        if (value.mode === 'hybrid' && value.state === 'current') samples.push(ms); else degraded++;
      } catch { errors++; }
    }
  }));
  const seconds = (performance.now() - loadStarted) / 1000;
  return { refs: scale + relevanceDocuments.length, kinds: KINDS, indexingSeconds: loadSeconds,
    chunks: { lexical: sizes.lexical, vector: sizes.vector },
    indexBytes: { scope: 'database', lexical_chunks_tsv: Number(sizes.gin),
      ...(sizes.ann ? { [sizes.ann]: Number(sizes.ann_bytes) } : { vector: 'exact search, no ANN index' }) }, plans,
    load: { searches: load, concurrency, errors, degraded, throughputPerSecond: round(samples.length / seconds), latencyMs: latency(samples) } };
}

async function timed(run) { const start = performance.now(); const value = await run(); return { value, ms: performance.now() - start }; }
function latency(values) {
  return { samples: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)),
    max: values.length ? round(Math.max(...values)) : null };
}
/** `answer` (a search, or a bundle's coverage), when it ran as `policy` projects and current; the run fails otherwise. */
function covered(label, policy, answer) {
  const { mode, state } = answer.coverage ?? answer;
  if (mode !== (policy.vector ? 'hybrid' : 'lexical') || state !== 'current') throw new Error(`${label}: ran ${mode} with state ${state}`);
  return answer;
}
function summary(rows) {
  return { queries: rows.length, ndcg10: round(mean(rows.map(row => row.ndcg10))), recall10: round(mean(rows.map(row => row.recall10))),
    precision5: round(mean(rows.map(row => row.precision5))), mrr: round(mean(rows.map(row => row.rr))) };
}
/** Every distinct value of `key` in a plan tree. */
function walk(node, key, found = new Set()) {
  if (node[key]) found.add(node[key]);
  for (const child of node.Plans ?? []) walk(child, key, found);
  return [...found].sort((a, b) => (a < b ? -1 : Number(a > b)));
}
function memoryR2() {
  const objects = new Map();
  const meta = key => {
    const object = objects.get(key);
    return object ? { size: object.bytes.length,
      checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} } : null;
  };
  return { async put(key, body, options = {}) {
    objects.set(key, { bytes: Buffer.from(await new Response(body).arrayBuffer()), sha256: options.sha256 });
    return meta(key);
  },
  async head(key) { return meta(key); },
  async get(key) { return meta(key) && { ...meta(key), body: new Blob([objects.get(key).bytes]).stream() }; },
    async delete(key) { objects.delete(key); }, async list() { return { objects: [], truncated: false }; } };
}

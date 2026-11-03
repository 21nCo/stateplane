import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresAuthority, PostgresCandidates, PostgresClaims, PostgresOutbox, PostgresRetrievalSearch, PostgresRetrievalWorker,
  PostgresSources, PostgresSpaces, RecordRetrievalProjector, postgresServices } from '../../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbedderUnavailableError, EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';
import { consume, dispatch } from '../../packages/workers/dist/index.js';

// STA-46: hybrid search over real projections, built by the STA-45 worker,
// with authority reread and reauthorization. The record dispatcher is
// cell-wide, so this suite owns its database.
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_retrieval_search_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: baseUrl });
await admin.connect();
try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
const target = new URL(baseUrl); target.pathname = `/${name}`;
async function dropDatabase() {
  const cleanup = new pg.Client({ connectionString: baseUrl });
  await cleanup.connect();
  try { await cleanup.query(`DROP DATABASE IF EXISTS ${name}`); } finally { await cleanup.end(); }
}
try {
  execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'ignore' });
} catch (error) { await dropDatabase(); throw error; }
const pool = new pg.Pool({ connectionString: target.toString(), max: 8 });
test.after(async () => { await pool.end(); await dropDatabase(); });

const sha = value => createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

/** Just enough of an R2 binding for text ingestion. */
class MemoryR2 {
  objects = new Map();
  async put(key, body, options = {}) {
    const chunks = [];
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    const bytes = Buffer.concat(chunks);
    this.objects.set(key, { bytes, sha256: options.sha256 });
    return this.meta(key);
  }
  meta(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} } : null;
  }
  async head(key) { return this.meta(key); }
  async get(key) { const meta = this.meta(key); return meta && { ...meta, body: new Blob([this.objects.get(key).bytes]).stream() }; }
  async delete(key) { this.objects.delete(key); }
  async list() { return { objects: [], truncated: false }; }
}

/** A pool whose hooks run once, just before the first statement containing their text. */
let hooks = [];
const hooked = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const hook = typeof sql === 'string' ? hooks.find(item => sql.includes(item.match)) : undefined;
      if (hook) { hooks = hooks.filter(item => item !== hook); await hook.run(target); }
      return target.query(sql, ...rest);
    };
  } });
} };
const REREAD = 'COALESCE(rec.revision,e.revision)';
const LOCK_SPACE = 'SELECT lifecycle,policy_version,placement_generation FROM spaces WHERE space_id=$1 FOR SHARE';

const config = { database: memoryAdapter(), namespace: `sta46-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const sources = new PostgresSources(spaces, new Map([['cell-a', { pool, originals: new R2BlobStore(new MemoryR2()) }]]));
const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
const authority = new PostgresAuthority(pool, 3600);
const outbox = new PostgresOutbox(pool, authority);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
  unique: [], filterable: [], sortable: [] });

/** A deterministic embedder in region `local`; `down` makes every call an outage, `fail` the input's fault, `hang` never answer. */
class Spy extends DeterministicEmbedder {
  constructor(behavior = {}) { super({ embedder: 'local-hash', region: 'local' }); this.behavior = behavior; this.queries = []; }
  async embed(texts, signal) {
    if (this.behavior.down) throw new EmbedderUnavailableError('provider unreachable');
    if (this.behavior.fail) throw new Error(`rejected input: ${texts[0]}`);
    if (this.behavior.hang) return new Promise(() => {});
    this.queries.push(...texts);
    return super.embed(texts, signal);
  }
}
const healthy = new Spy();
const registry = new EmbeddingRegistry([healthy]);
const search = (embedders = registry, cellPool = pool) => new PostgresRetrievalSearch(spaces, new Map([['cell-a', { pool: cellPool }]]),
  { embedders });

/** Deliver every due record event and evidence item until nothing is left. */
async function index(embedders = registry) {
  const projector = new RecordRetrievalProjector(pool, { embedders });
  for (;;) {
    await pool.query(`UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second'
      WHERE delivery_state<>'delivered' AND dead_lettered_at IS NULL`);
    const sent = [];
    await dispatch(outbox, { send: async messages => { sent.push(...messages); } });
    if (!sent.length) break;
    await consume(sent, message => outbox.process(message, projector), 8);
  }
  const worker = new PostgresRetrievalWorker(pool, { embedders });
  for (;;) {
    await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE delivery_state='pending'`);
    if (!(await worker.step()).claimed) break;
  }
}

/** Publish a policy and an active generation for `collectionId`, before content is written so the worker projects it. */
async function project(spaceId, collectionId, { lexical = true, vector = true, regions = ['local'] } = {}) {
  await pool.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
      lexical,vector,text_search_config,processing_regions,credential_id) VALUES($1,$2,1,'{/title,/note}',true,true,$3,$4,'english',$5,'owner')`,
  [spaceId, collectionId, lexical, vector, regions]);
  const model = vector ? ['local-hash', 'feature-hash', '1', 384] : [null, null, null, null];
  await pool.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
    model_version,dimensions) VALUES($1,$2,1,1,$3,$4,$5,$6)`, [spaceId, collectionId, ...model]);
  for (const state of ['verifying', 'active']) await pool.query(`UPDATE projection_generations SET state=$3
    WHERE space_id=$1 AND collection_id=$2 AND generation=1`, [spaceId, collectionId, state]);
}

/** A space with collections alpha and beta, each projected lexically and by vector. */
async function fixture({ collections = ['alpha', 'beta'], policy = {} } = {}) {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of collections) {
    await services.collections.define(owner, spaceId, id, definition(id));
    await project(spaceId, id, policy[id]);
  }
  const scope = collectionId => ({ spaceId, collectionId, principalId: user.id, credentialId: owner.credentialId,
    capability: 'records:write', policyVersion: 1, placementGeneration: 1 });
  const record = async (collectionId, data, extras = {}, operation = 'create') => {
    const key = randomUUID();
    return (await authority.mutate(scope(collectionId), { operation, idempotencyKey: key, requestDigest: sha(key),
      ...(data === undefined ? {} : { canonicalData: JSON.stringify(Object.fromEntries(Object.entries(data).sort())) }),
      ...(operation === 'replace' ? { unique: [], indexes: [] } : {}), ...extras })).ref.id;
  };
  const source = async (collectionId, text, key = randomUUID()) => {
    const created = await sources.ingestText(owner, spaceId, collectionId, { idempotencyKey: key, text });
    await sources.extract(owner, spaceId, collectionId, created.sourceId);
    return created.sourceId;
  };
  const agent = async grants => {
    const key = await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
      grants.map(([collectionId, capabilities]) => ({ collectionId, capabilities })));
    return Object.assign(await verify(key.secret), { keyId: key.id });
  };
  return { spaceId, owner, scope, record, source, agent };
}
const ids = result => result.results.map(hit => `${hit.ref.collectionId}/${hit.ref.kind}/${hit.ref.id}`);

test('hybrid search returns fused, deduplicated, cited and fresh hits from authority', async () => {
  const f = await fixture();
  const lantern = await f.record('alpha', { title: 'The harbor lantern was lit at dusk', note: 'a lantern by the harbor' });
  const other = await f.record('alpha', { title: 'Grain prices rose in spring' });
  const sourceId = await f.source('beta', 'Harbor records describe the lantern keeper and the lantern tower.');
  const claim = await claims.create(f.owner, f.spaceId, 'beta', { idempotencyKey: 'c1', statement: 'The harbor lantern burned whale oil.',
    attributedTo: 'harbor log', evidence: [{ collectionId: 'beta', sourceId }] });
  await claims.review(f.owner, f.spaceId, 'beta', claim.claimId, { baseRevision: 1, status: 'accepted' });
  await index();

  healthy.queries.length = 0;
  const result = await search().search(f.owner, f.spaceId, { query: 'harbor lantern' });
  assert.deepEqual(healthy.queries, ['harbor lantern'], 'one query embedding per identity and region');
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.state, 'current');
  assert.equal(result.complete, false);
  assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.generation, entry.lexical, entry.vector, entry.projection]),
    [['alpha', 1, true, 'used', 'current'], ['beta', 1, true, 'used', 'current']]);
  // Each Ref once, however many of its chunks and lists matched; the unrelated record is not a lexical match.
  assert.equal(new Set(ids(result)).size, result.results.length);
  for (const key of [`alpha/record/${lantern}`, `beta/source/${sourceId}`, `beta/claim/${claim.claimId}`]) assert.ok(ids(result).includes(key), key);
  const hit = result.results.find(entry => entry.ref.id === lantern);
  assert.equal(hit.revision, 1);
  assert.ok(hit.provenance.lexicalRank >= 1 && hit.provenance.vectorRank >= 1, 'found by both lists');
  assert.deepEqual(hit.provenance.embedder, { embedder: 'local-hash', model: 'feature-hash', modelVersion: '1', dimensions: 384 });
  assert.equal(hit.provenance.generation, 1);
  assert.equal(hit.review, null);
  assert.equal(hit.freshness.projection, 'current');
  assert.ok(Date.parse(hit.freshness.verifiedAt) > 0);
  // Citations are the authoritative text at the chunk's offsets.
  for (const citation of hit.citations) {
    const field = { '/title': 'The harbor lantern was lit at dusk', '/note': 'a lantern by the harbor' }[citation.field];
    assert.equal(citation.text, [...field].slice(citation.start, citation.end).join(''));
  }
  const claimHit = result.results.find(entry => entry.ref.kind === 'claim');
  assert.equal(claimHit.revision, 2, 'the reviewed revision');
  assert.equal(claimHit.review.status, 'accepted');
  assert.equal(claimHit.provenance.attributedTo, 'harbor log');
  assert.deepEqual(claimHit.provenance.evidence, [{ collectionId: 'beta', sourceId, extractionVersion: null, start: null, end: null }]);
  assert.equal(claimHit.citations[0].text, 'The harbor lantern burned whale oil.');
  const sourceHit = result.results.find(entry => entry.ref.kind === 'source');
  assert.equal(sourceHit.extractionVersion, 1);
  assert.equal(sourceHit.citations[0].text, 'Harbor records describe the lantern keeper and the lantern tower.');
  assert.ok(result.underfill === null || result.underfill.returned === result.results.length);
  assert.ok(!ids(result).includes(`alpha/record/${other}`) || result.results.at(-1).provenance.lexicalRank === null,
    'an unrelated record can only trail as a vector neighbour');

  // Collection and kind filters.
  const only = await search().search(f.owner, f.spaceId, { query: 'harbor lantern', collections: ['beta'], kinds: ['claim'] });
  assert.deepEqual(ids(only), [`beta/claim/${claim.claimId}`]);
  await rejects(search().search(f.owner, f.spaceId, { query: 'harbor', collections: ['missing'] }), 'NOT_FOUND');
  for (const bad of [{}, { query: ' ' }, { query: 'x', limit: 51 }, { query: 'x', kinds: ['link'] }, { query: 'x'.repeat(1001) },
    { query: 'x', collections: [] }, { query: 'x', extra: 1 }])
    await rejects(search().search(f.owner, f.spaceId, bad), 'INVALID_ARGUMENT');
});

test('deleted, tombstoned and stale hits are rejected at reread, never returned', async () => {
  const f = await fixture();
  const kept = await f.record('alpha', { title: 'beacon one' });
  const deleted = await f.record('alpha', { title: 'beacon two' });
  const revised = await f.record('alpha', { title: 'beacon three' });
  const sourceId = await f.source('alpha', 'A beacon source.');
  const corrected = await f.source('alpha', 'Another beacon source.');
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c', statement: 'A beacon claim.', attributedTo: 'x' });
  await index();
  assert.equal((await search().search(f.owner, f.spaceId, { query: 'beacon' })).results.length, 6);

  // Authority moves on; the projections are not delivered yet, so they still hold every old chunk.
  await f.record('alpha', undefined, { recordId: deleted, expectedRevision: 1 }, 'delete');
  await f.record('alpha', { title: 'lighthouse three' }, { recordId: revised, expectedRevision: 1 }, 'replace');
  await sources.delete(f.owner, f.spaceId, 'alpha', sourceId);
  await sources.correctExtraction(f.owner, f.spaceId, 'alpha', corrected, { baseVersion: 1, content: 'Another lighthouse source.', sourceOffsets: [] });
  await claims.delete(f.owner, f.spaceId, 'alpha', claim.claimId, { baseRevision: 1 });
  const stale = await search().search(f.owner, f.spaceId, { query: 'beacon' });
  assert.deepEqual(ids(stale), [`alpha/record/${kept}`]);
  assert.deepEqual(stale.rejected, { deleted: 3, stale: 2, unauthorized: 0 });
  assert.equal(stale.state, 'pending', 'undelivered work is reported');
  assert.deepEqual(stale.underfill, { returned: 1, requested: 10, reasons: ['rejected', 'exhausted', 'pending'] });

  // Once delivered, the new text is found and the old is gone.
  await index();
  const current = await search().search(f.owner, f.spaceId, { query: 'lighthouse' });
  // The lexical matches lead; the vector list may add unrelated nearest neighbours after them.
  assert.deepEqual(new Set(ids(current).slice(0, 2)), new Set([`alpha/record/${revised}`, `alpha/source/${corrected}`]));
  assert.ok(current.results.slice(2).every(hit => hit.provenance.lexicalRank === null));
  assert.equal(current.results.find(hit => hit.ref.id === revised).revision, 2);
  assert.equal(current.results.find(hit => hit.ref.id === corrected).extractionVersion, 2);
  assert.deepEqual((await search().search(f.owner, f.spaceId, { query: 'beacon' })).rejected, { deleted: 0, stale: 0, unauthorized: 0 });
});

test('a deletion or revision committed after the candidates are read is caught by the fresh reread', async () => {
  const f = await fixture();
  const deleted = await f.record('alpha', { title: 'compass rose' });
  const revised = await f.record('alpha', { title: 'compass needle' });
  await index();
  hooks = [{ match: REREAD, run: async () => {
    await f.record('alpha', undefined, { recordId: deleted, expectedRevision: 1 }, 'delete');
    await f.record('alpha', { title: 'compass needle, recalibrated' }, { recordId: revised, expectedRevision: 1 }, 'replace');
  } }];
  const result = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'compass' });
  assert.equal(hooks.length, 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.rejected, { deleted: 1, stale: 1, unauthorized: 0 });
  assert.equal(result.underfill.returned, 0, 'reported, never padded');
});

test('search reads only granted collections and kinds, and applies the claim read rule', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'orchard ledger' });
  await f.record('beta', { title: 'orchard map' });
  const betaSource = await f.source('beta', 'The orchard survey.');
  const citing = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The orchard was surveyed.',
    attributedTo: 'survey', evidence: [{ collectionId: 'beta', sourceId: betaSource }] });
  const plain = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c2', statement: 'The orchard has apples.',
    attributedTo: 'farmer' });
  await index();

  const recordsOnly = await f.agent([['alpha', ['records:read']]]);
  const result = await search().search(recordsOnly, f.spaceId, { query: 'orchard' });
  assert.deepEqual(result.collections.map(entry => entry.collectionId), ['alpha']);
  assert.deepEqual(result.results.map(hit => [hit.ref.collectionId, hit.ref.kind]), [['alpha', 'record']]);
  await rejects(search().search(recordsOnly, f.spaceId, { query: 'orchard', collections: ['beta'] }), 'NOT_FOUND');
  await rejects(search().search(recordsOnly, f.spaceId, { query: 'orchard', kinds: ['claim'] }), 'FORBIDDEN');

  // A claim citing a collection whose sources the key cannot read does not exist for it.
  const claimsOnly = await f.agent([['alpha', ['claims:read']]]);
  const visible = await search().search(claimsOnly, f.spaceId, { query: 'orchard' });
  assert.deepEqual(ids(visible), [`alpha/claim/${plain.claimId}`]);
  assert.equal(visible.rejected.unauthorized, 1);
  const both = await f.agent([['alpha', ['claims:read']], ['beta', ['sources:read']]]);
  assert.deepEqual(new Set(ids(await search().search(both, f.spaceId, { query: 'orchard' }))),
    new Set([`alpha/claim/${plain.claimId}`, `alpha/claim/${citing.claimId}`, `beta/source/${betaSource}`]));
});

test('a revocation committed before the reread fails the search; one committed during it waits for its commit', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'kestrel nest' });
  await index();
  const key = await f.agent([['alpha', ['records:read']]]);
  hooks = [{ match: LOCK_SPACE, run: () => spaces.revokeAgentKey(f.owner, f.spaceId, key.keyId) }];
  await rejects(search(registry, hooked).search(key, f.spaceId, { query: 'kestrel' }), 'FORBIDDEN');
  await rejects(search().search(key, f.spaceId, { query: 'kestrel' }), 'NOT_FOUND');

  // A grant that lapses between the plan and the reread: its collection's hits are unauthorized.
  const expiring = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']]]);
  hooks = [{ match: LOCK_SPACE, run: () => pool.query(`UPDATE collection_grants SET expires_at=clock_timestamp()
    WHERE space_id=$1 AND credential_id=$2 AND collection_id='alpha'`, [f.spaceId, expiring.credentialId]) }];
  const lapsed = await search(registry, hooked).search(expiring, f.spaceId, { query: 'kestrel' });
  assert.deepEqual(lapsed.results, []);
  assert.equal(lapsed.rejected.unauthorized, 1);

  // Revoking while the reread holds its locks waits, so what the search returns was authorized at its commit.
  const holder = await f.agent([['alpha', ['records:read']]]);
  const order = [];
  let revocation;
  hooks = [{ match: REREAD, run: async () => {
    revocation = spaces.revokeAgentKey(f.owner, f.spaceId, holder.keyId).then(() => order.push('revoked'));
    for (let tries = 0; ; tries++) {
      const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock'`)).rows[0].n;
      if (waiting) break;
      assert.ok(tries < 400, 'the revocation waits on the search');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } }];
  const held = await search(registry, hooked).search(holder, f.spaceId, { query: 'kestrel' });
  order.push('searched');
  await revocation;
  assert.equal(held.results.length, 1);
  assert.deepEqual(order, ['searched', 'revoked']);
  await rejects(search().search(holder, f.spaceId, { query: 'kestrel' }), 'NOT_FOUND');
});

test('an embedder or vector outage returns lexical results marked degraded while exact reads work', async () => {
  const f = await fixture({ collections: ['alpha', 'beta'], policy: { beta: { lexical: false } } });
  const id = await f.record('alpha', { title: 'heron migration' });
  await f.record('beta', { title: 'heron vectors only' });
  await index();

  for (const [embedders, error] of [[new EmbeddingRegistry([new Spy({ down: true })]), 'EMBEDDER_UNAVAILABLE'],
    [new EmbeddingRegistry([new Spy({ hang: true })]), 'EMBEDDER_UNAVAILABLE'],
    [new EmbeddingRegistry([new Spy({ fail: true })]), 'EMBEDDER_FAILED'], [new EmbeddingRegistry(), 'EMBEDDER_NOT_CONFIGURED']]) {
    const started = Date.now();
    const result = await search(embedders).search(f.owner, f.spaceId, { query: 'heron' });
    assert.ok(Date.now() - started < 4_000, 'an embedder that never answers is not waited for past its 2 s bound');
    assert.equal(result.mode, 'lexical');
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.collections.map(entry => [entry.collectionId, entry.lexical, entry.vector, entry.vectorError]),
      [['alpha', true, 'unavailable', error], ['beta', false, 'unavailable', error]]);
    assert.deepEqual(ids(result), [`alpha/record/${id}`], 'the lexical side still answers');
    assert.equal(result.results[0].provenance.vectorRank, null);
    assert.ok(result.underfill.reasons.includes('degraded'));
  }
  // The vector query itself failing is the same degradation.
  hooks = [{ match: 'hnsw.iterative_scan', run: async client => { await client.query('SELECT 1/0'); } }];
  const failed = await search(registry, hooked).search(f.owner, f.spaceId, { query: 'heron' });
  assert.deepEqual(failed.collections.map(entry => entry.vectorError), ['VECTOR_QUERY_FAILED', 'VECTOR_QUERY_FAILED']);
  assert.deepEqual(ids(failed), [`alpha/record/${id}`]);
  // Exact reads never depend on search or its embedder.
  assert.equal((await authority.transaction({ ...f.scope('alpha'), capability: 'records:read' }, tx => tx.getRecord(id))).ref.id, id);
  // Healthy again: the vector-only collection answers too.
  assert.equal((await search().search(f.owner, f.spaceId, { query: 'heron' })).results.length, 2);
});

test('underfill after filtering is explicit and bounded overfetch never pads', async () => {
  const f = await fixture({ collections: ['alpha'] });
  const made = [];
  for (let i = 0; i < 25; i++) made.push(await f.record('alpha', { title: `quarry stone ${i}` }));
  await index();
  for (const id of made) await f.record('alpha', undefined, { recordId: id, expectedRevision: 1 }, 'delete');
  const result = await search().search(f.owner, f.spaceId, { query: 'quarry', limit: 1 });
  assert.deepEqual(result.results, []);
  assert.equal(result.candidates.considered, 20, 'the overfetch bound for limit 1');
  assert.equal(result.rejected.deleted, 20);
  assert.deepEqual(result.underfill, { returned: 0, requested: 1, reasons: ['rejected', 'bounded', 'pending'] });
});

test('a filtered nearest-neighbour query keeps scanning the HNSW index past other spaces', async () => {
  // Noise in another space sits nearer the query than every target chunk, so an unfiltered top-k is all noise.
  const noise = await fixture({ collections: ['alpha'], policy: { alpha: { lexical: false } } });
  for (let i = 0; i < 40; i++) await noise.record('alpha', { title: `falcon falcon falcon ${i}` });
  const f = await fixture({ collections: ['alpha'], policy: { alpha: { lexical: false } } });
  const wanted = [];
  for (let i = 0; i < 6; i++) wanted.push(await f.record('alpha', { title: `falcon tower stairs number ${i}` }));
  await index();
  const generations = [{ collectionId: 'alpha', generation: 1, textSearchConfig: 'english', kinds: ['record'] }];
  const vector = healthy.vector('falcon');
  const model = { embedder: 'local-hash', model: 'feature-hash', modelVersion: '1', dimensions: 384 };
  // Prefer the index's order over sorting, so the plan is the filtered ANN scan this test is about.
  const planned = { connect: async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = (sql, ...rest) => typeof sql === 'string' && sql.startsWith('SET LOCAL hnsw.ef_search')
      ? query('SET LOCAL enable_sort = off').then(() => query(sql, ...rest)) : query(sql, ...rest);
    const release = client.release.bind(client);
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  const found = await new PostgresCandidates(planned).nearest({ spaceId: f.spaceId, generations }, model, vector, 20);
  assert.deepEqual(new Set(found.map(hit => hit.id)), new Set(wanted), 'every target chunk, none of the noise');

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL enable_sort = off');
    await db.query('SET LOCAL hnsw.ef_search = 20');
    const sql = `SELECT ref_id FROM vector_chunks v WHERE space_id=$1 AND collection_id='alpha' AND generation=1 AND dimensions=384
      ORDER BY (embedding::vector(384)) <=> $2::vector(384) LIMIT 20`;
    const plan = (await db.query(`EXPLAIN ${sql}`, [f.spaceId, `[${vector}]`])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /vector_chunks_hnsw_384/);
    // Without the iterative scan the same filtered top-k comes back short: it is never complete by itself.
    await db.query('SET LOCAL hnsw.iterative_scan = off');
    assert.ok((await db.query(sql, [f.spaceId, `[${vector}]`])).rows.length < wanted.length);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

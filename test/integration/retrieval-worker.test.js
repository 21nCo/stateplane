import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAuthority, PostgresOutbox, PostgresRetrievalWorker, RecordRetrievalProjector } from '../../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbedderUnavailableError, EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { consume, dispatch } from '../../packages/workers/dist/index.js';

// STA-45: the record projector and the evidence worker against real
// PostgreSQL with pgvector. The record dispatcher is cell-wide, so this suite
// owns its database.
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_retrieval_worker_${randomUUID().replaceAll('-', '')}`;
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
const pool = new pg.Pool({ connectionString: target.toString(), max: 6 });
// Watches the worker's sessions from outside: no embedding call may find one in a transaction.
const monitor = new pg.Client({ connectionString: target.toString() });
await monitor.connect();
test.after(async () => { await monitor.end(); await pool.end(); await dropDatabase(); });

const authority = new PostgresAuthority(pool, 3600);
const outbox = new PostgresOutbox(pool, authority);
const digest = value => createHash('sha256').update(value).digest('hex');
const due = table => pool.query(`UPDATE ${table} SET available_at=clock_timestamp()-interval '1 second'
  WHERE delivery_state${table === 'retrieval_outbox' ? "='pending'" : "<>'delivered' AND dead_lettered_at IS NULL"}`);

/**
 * A deterministic embedder that records every input and, at each call,
 * whether any session of the test database was inside a transaction.
 */
class Spy extends DeterministicEmbedder {
  constructor(profile = {}, behavior = {}) {
    super({ embedder: 'local-hash', model: 'feature-hash', modelVersion: '1', region: 'eu-west', ...profile });
    this.inputs = [];
    this.inTransaction = [];
    this.behavior = behavior;
  }
  async embed(texts, signal) {
    const open = (await monitor.query(`SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname=current_database()
      AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()`)).rows[0].open;
    this.inTransaction.push(open);
    if (this.behavior.down) throw new EmbedderUnavailableError('provider unreachable');
    // Like a fetch with the signal, a slow call gives up when it aborts.
    if (this.behavior.delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.behavior.delayMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new EmbedderUnavailableError('aborted')); }, { once: true });
    });
    await this.behavior.gate?.();
    this.inputs.push(...texts);
    return super.embed(texts, signal);
  }
}
const identity = spy => [spy.profile.embedder, spy.profile.model, spy.profile.modelVersion, spy.profile.dimensions];

async function space() {
  await pool.query("UPDATE projection_outbox SET delivery_state='delivered',available_at=clock_timestamp() WHERE delivery_state<>'delivered'");
  await pool.query("UPDATE retrieval_outbox SET delivery_state='delivered',delivered_at=clock_timestamp() WHERE delivery_state='pending'");
  const spaceId = `sp_${randomUUID()}`;
  const collectionId = 'alpha';
  await pool.query(`BEGIN;
    INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id) VALUES('${spaceId}','owner','cell-a','cell-a','target-a');
    INSERT INTO collections(space_id,collection_id) VALUES('${spaceId}','${collectionId}');
    INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('${spaceId}','${collectionId}',1,'{}');
    COMMIT`);
  const scope = { spaceId, collectionId, principalId: 'owner', credentialId: 'owner-session', capability: 'records:write',
    policyVersion: 1, placementGeneration: 1 };
  return { spaceId, collectionId, scope };
}

async function policy(spaceId, version, fields = {}) {
  const p = { recordFields: ['/title'], sourceContent: true, claimStatements: true, lexical: true, vector: true,
    regions: ['eu-west'], ...fields };
  await pool.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
      lexical,vector,text_search_config,processing_regions,credential_id) VALUES($1,'alpha',$2,$3,$4,$5,$6,$7,'english',$8,'owner')`,
  [spaceId, version, p.recordFields, p.sourceContent, p.claimStatements, p.lexical, p.vector, p.regions]);
}
async function generation(spaceId, number, policyVersion, model = null, state = 'active') {
  const [embedder, modelName, version, dimensions] = model ?? [null, null, null, null];
  await pool.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
    model_version,dimensions) VALUES($1,'alpha',$2,$3,$4,$5,$6,$7)`, [spaceId, number, policyVersion, embedder, modelName, version, dimensions]);
  for (const next of state === 'active' ? ['verifying', 'active'] : []) await pool.query(`UPDATE projection_generations SET state=$3
    WHERE space_id=$1 AND collection_id='alpha' AND generation=$2`, [spaceId, number, next]);
}

function write(scope, operation, data, extras = {}) {
  const key = randomUUID();
  const complete = operation === 'replace' ? { unique: [], indexes: [], ...extras } : extras;
  return authority.mutate(scope, { operation, idempotencyKey: key, requestDigest: digest(key),
    ...(data === undefined ? {} : { canonicalData: data }), ...complete });
}
/** Lease every due record event and return its hints in revision order. */
async function hints() {
  await due('projection_outbox');
  const sent = [];
  await dispatch(outbox, { send: async messages => { sent.push(...messages); } });
  const revisions = new Map((await pool.query('SELECT event_id,revision FROM projection_outbox WHERE event_id=ANY($1)',
    [sent.map(message => message.eventId)])).rows.map(row => [row.event_id, Number(row.revision)]));
  return sent.sort((a, b) => revisions.get(a.eventId) - revisions.get(b.eventId));
}
const deliver = (messages, projector) => consume(messages, message => outbox.process(message, projector), 1);

/** Every projection row of one Ref, per generation. */
async function projected(spaceId, kind, id) {
  const refs = (await pool.query(`SELECT generation,revision,extraction_version,deleted FROM projection_refs
    WHERE space_id=$1 AND ref_kind=$2 AND ref_id=$3 ORDER BY generation`, [spaceId, kind, id])).rows
    .map(row => ({ generation: Number(row.generation), revision: Number(row.revision),
      extraction: row.extraction_version === null ? null : Number(row.extraction_version), deleted: row.deleted }));
  const lexical = (await pool.query(`SELECT generation,revision,chunk_index,field,content FROM lexical_chunks
    WHERE space_id=$1 AND ref_kind=$2 AND ref_id=$3 ORDER BY generation,chunk_index`, [spaceId, kind, id])).rows
    .map(row => [Number(row.generation), Number(row.revision), row.field, row.content]);
  const vector = (await pool.query(`SELECT generation,revision,processing_region,content_sha256 FROM vector_chunks
    WHERE space_id=$1 AND ref_kind=$2 AND ref_id=$3 ORDER BY generation,chunk_index`, [spaceId, kind, id])).rows
    .map(row => [Number(row.generation), Number(row.revision), row.processing_region, row.content_sha256]);
  const checkpoints = Number((await pool.query(`SELECT count(*) FROM embedding_checkpoints WHERE space_id=$1 AND ref_kind=$2
    AND ref_id=$3`, [spaceId, kind, id])).rows[0].count);
  const receipts = (await pool.query(`SELECT generation,revision,chunks_removed FROM projection_deletion_receipts
    WHERE space_id=$1 AND ref_kind=$2 AND ref_id=$3 ORDER BY generation`, [spaceId, kind, id])).rows
    .map(row => [Number(row.generation), Number(row.revision), row.chunks_removed]);
  return { refs, lexical, vector, checkpoints, receipts };
}

/** A source with one extraction and a claim, written as their services do; their triggers enqueue retrieval work. */
async function evidence(spaceId, { extraction = 'The bridge opened in 1932 after four years.', statement = 'The bridge opened in 1932.' } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await insertEvidence(db, spaceId, extraction, statement);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function insertEvidence(db, spaceId, extraction, statement) {
  await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,'alpha','source','src_1'),($1,'alpha','claim','clm_1')`,
    [spaceId]);
  await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
    VALUES($1,'alpha','src_1','https://example.invalid/report','owner','owner-session')`, [spaceId]);
  await db.query(`INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,object_key)
    VALUES($1,'alpha','src_1',false,$2,14,'text/plain',clock_timestamp()-interval '1 minute','originals/src_1')`, [spaceId, digest('original bytes')]);
  await extract(spaceId, 1, extraction, db);
  await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id) VALUES($1,'alpha','clm_1','owner','owner-session')`,
    [spaceId]);
  await revise(spaceId, 1, statement, false, db);
}
const extract = (spaceId, version, content, db = pool) => db.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,
  source_sha256,parser,parser_version,content,credential_id) VALUES($1,'alpha','src_1',$2,$3,'text','1',$4,'owner-session')`,
[spaceId, version, digest('original bytes'), content]);
async function revise(spaceId, revision, statement, reviewed = false, db = pool) {
  await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,
      recorded_by,review_status,reviewed_by,reviewed_at)
    VALUES($1,'alpha','clm_1',$2,$3,'principal:owner','owner-session','owner',$4,$5,$6)`,
  [spaceId, revision, statement, reviewed ? 'accepted' : 'unreviewed', reviewed ? 'owner' : null, reviewed ? new Date() : null]);
  if (revision > 1) await pool.query(`UPDATE entity_refs SET revision=$2 WHERE space_id=$1 AND kind='claim' AND entity_id='clm_1'`,
    [spaceId, revision]);
}
const deleteEvidence = (spaceId, kind, id) => pool.query(`UPDATE entity_refs SET tombstone=true,revision=revision+1
  WHERE space_id=$1 AND kind=$2 AND entity_id=$3`, [spaceId, kind, id]);
const work = async spaceId => (await pool.query(`SELECT ref_kind,ref_id,revision,operation,delivery_state,attempts,last_error,
  available_at>clock_timestamp() AS waiting FROM retrieval_outbox WHERE space_id=$1 ORDER BY enqueued_at,job_id`, [spaceId])).rows;

test('records project only configured fields into every generation, embedding outside any transaction', async () => {
  const { spaceId, scope } = await space();
  const spy = new Spy();
  // Generation 1 is lexical only under policy 1; generation 2 is being built with vectors under policy 2.
  await policy(spaceId, 1, { vector: false, regions: [] });
  await generation(spaceId, 1, 1);
  await policy(spaceId, 2, { recordFields: ['/title', '/body'] });
  await generation(spaceId, 2, 2, identity(spy), 'building');
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([spy]) });
  const created = await write(scope, 'create', JSON.stringify({ body: 'Opened to traffic in 1932.', secret: 'do-not-index',
    title: 'Bridge opening' }));
  assert.deepEqual(await deliver(await hints(), projector), ['applied']);
  const view = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual(view.refs, [{ generation: 1, revision: 1, extraction: null, deleted: false },
    { generation: 2, revision: 1, extraction: null, deleted: false }]);
  assert.deepEqual(view.lexical, [[1, 1, '/title', 'Bridge opening'], [2, 1, '/title', 'Bridge opening'],
    [2, 1, '/body', 'Opened to traffic in 1932.']]);
  assert.deepEqual(view.vector, [[2, 1, 'eu-west', digest('Bridge opening')], [2, 1, 'eu-west', digest('Opened to traffic in 1932.')]]);
  assert.equal(view.checkpoints, 0, 'applied checkpoints are removed');
  assert.deepEqual(spy.inputs, ['Bridge opening', 'Opened to traffic in 1932.'], 'only configured fields reach the embedder');
  assert.ok(spy.inTransaction.length > 0 && spy.inTransaction.every(open => open === 0), 'no session was in a transaction');
  const leaked = (await pool.query(`SELECT count(*)::int AS n FROM lexical_chunks WHERE space_id=$1 AND content LIKE '%do-not-index%'`,
    [spaceId])).rows[0].n;
  assert.equal(leaked, 0);
  const tsv = (await pool.query(`SELECT count(*)::int AS n FROM lexical_chunks WHERE space_id=$1 AND tsv @@ to_tsquery('english','traffic')`,
    [spaceId])).rows[0].n;
  assert.equal(tsv, 1);
});

test('reordered, duplicate and deleted record deliveries cannot activate stale content in any generation', async () => {
  const { spaceId, scope } = await space();
  const spy = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([spy]) });
  const created = await write(scope, 'create', '{"title":"first draft"}');
  await write(scope, 'replace', '{"title":"second draft"}', { recordId: created.ref.id, expectedRevision: 1 });
  const [first, second] = await hints();
  // The newer revision arrives first; the older one is then superseded and never prepared.
  assert.deepEqual(await deliver([second, first, second], projector), ['applied', 'superseded', 'lost']);
  assert.deepEqual((await projected(spaceId, 'record', created.ref.id)).lexical, [[1, 2, '/title', 'second draft']]);
  assert.deepEqual(spy.inputs, ['second draft']);

  await write(scope, 'delete', undefined, { recordId: created.ref.id, expectedRevision: 2 });
  assert.deepEqual(await deliver(await hints(), projector), ['applied']);
  const deleted = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual(deleted.refs, [{ generation: 1, revision: 3, extraction: null, deleted: true }]);
  assert.deepEqual([deleted.lexical, deleted.vector, deleted.checkpoints, deleted.receipts], [[], [], 0, [[1, 3, 2]]]);

  // Even an apply that slipped past the outbox's latest-revision fence cannot
  // bring the deleted Ref back: the generation keeps it deleted.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await projector.apply({ ref: created.ref, revision: 2, generation: 1, deleted: false, canonicalData: '{"title":"second draft"}' },
      undefined, (sql, values) => client.query(sql, values));
    await client.query('COMMIT');
  } finally { client.release(); }
  assert.deepEqual(await projected(spaceId, 'record', created.ref.id), deleted);
});

test('an embedder outage leaves exact reads and writes available, releases record work uncounted and reports degraded', async () => {
  const { spaceId, scope, collectionId } = await space();
  const spy = new Spy({}, { down: true });
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([spy]) });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([spy]) });
  const created = await write(scope, 'create', '{"title":"outage"}');
  for (let round = 0; round < 3; round++) assert.deepEqual(await deliver(await hints(), projector), ['retry']);
  const row = (await pool.query('SELECT delivery_state,failures,last_error FROM projection_outbox WHERE space_id=$1', [spaceId])).rows[0];
  assert.deepEqual(row, { delivery_state: 'pending', failures: 0, last_error: 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE' });
  const status = await worker.status(spaceId, collectionId);
  assert.equal(status.state, 'degraded');
  assert.deepEqual(status.records, { pending: 0, degraded: 1, capped: false, lastError: 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE' });
  assert.deepEqual(status.generations.map(entry => [entry.generation, entry.state, entry.embedderAvailable]), [[1, 'active', true]]);
  // Authority is untouched by the outage: exact read and a conditional write succeed.
  const read = await authority.transaction({ ...scope, capability: 'records:read' }, tx => tx.getRecord(created.ref.id));
  assert.deepEqual([read.revision, read.canonicalData], [1, '{"title":"outage"}']);
  await write(scope, 'replace', '{"title":"recovered"}', { recordId: created.ref.id, expectedRevision: 1 });
  assert.equal((await projected(spaceId, 'record', created.ref.id)).lexical.length, 0, 'nothing was half applied');

  spy.behavior.down = false;
  const outcomes = await deliver(await hints(), projector);
  assert.deepEqual(outcomes.sort(), ['applied', 'superseded']);
  assert.deepEqual((await projected(spaceId, 'record', created.ref.id)).lexical, [[1, 2, '/title', 'recovered']]);
  assert.equal((await worker.status(spaceId, collectionId)).state, 'current');
});

test('source and claim work projects current authority; reorders, duplicates and deletions never activate stale text', async () => {
  const { spaceId, collectionId } = await space();
  const spy = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  await evidence(spaceId);
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([spy]) });
  assert.equal((await worker.status(spaceId, collectionId)).state, 'pending');
  assert.deepEqual(await worker.step(), { claimed: 2, applied: 2, released: 0, lost: 0, retried: 0, unknown: 0 });
  assert.deepEqual((await projected(spaceId, 'source', 'src_1')).lexical, [[1, 1, null, 'The bridge opened in 1932 after four years.']]);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).vector, [[1, 1, 'eu-west', digest('The bridge opened in 1932.')]]);
  assert.ok(spy.inTransaction.every(open => open === 0));

  // A review is a new revision with the same statement: its embedding is reused, not recomputed.
  const calls = spy.calls.length;
  await revise(spaceId, 2, 'The bridge opened in 1932.', true);
  await worker.step();
  assert.equal(spy.calls.length, calls);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).vector, [[1, 2, 'eu-west', digest('The bridge opened in 1932.')]]);

  // A new extraction, a revision and the claim's deletion all commit before
  // any delivery; the oldest item is made due last, the newest first.
  await extract(spaceId, 2, 'Corrected: the bridge opened in 1933.');
  await revise(spaceId, 3, 'The bridge opened in 1933.');
  await deleteEvidence(spaceId, 'claim', 'clm_1');
  await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-(revision * interval '1 minute')
    WHERE space_id=$1 AND delivery_state='pending'`, [spaceId]);
  const before = spy.inputs.length;
  assert.equal((await worker.step()).applied, 3);
  assert.deepEqual(spy.inputs.slice(before), ['Corrected: the bridge opened in 1933.'], 'the deleted claim\'s new text is never embedded');
  const claim = await projected(spaceId, 'claim', 'clm_1');
  assert.deepEqual([claim.refs, claim.lexical, claim.vector, claim.checkpoints, claim.receipts],
    [[{ generation: 1, revision: 4, extraction: null, deleted: true }], [], [], 0, [[1, 4, 2]]]);
  assert.deepEqual((await projected(spaceId, 'source', 'src_1')).refs, [{ generation: 1, revision: 1, extraction: 2, deleted: false }]);
  assert.ok((await work(spaceId)).every(row => row.delivery_state === 'delivered'));
  assert.equal((await worker.status(spaceId, collectionId)).state, 'current');
});

test('an item whose Ref changes while it is prepared, or whose lease another worker took, cannot apply what it prepared', async () => {
  const { spaceId } = await space();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const slow = new Spy({}, { gate: async () => { entered(); await blocked; } });
  await policy(spaceId, 1, { sourceContent: false });
  await generation(spaceId, 1, 1, identity(slow));
  await evidence(spaceId);
  const first = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([slow]) });
  const running = first.step({ budgetMs: 10_000 });
  await preparing;
  // While the first worker embeds revision 1, the claim is revised, and its lease is taken over after expiry.
  await revise(spaceId, 2, 'Revised while embedding.');
  await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-interval '1 second'
    WHERE space_id=$1 AND ref_kind='claim' AND revision=1`, [spaceId]);
  const fast = new Spy();
  const second = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([fast]) });
  const taken = await second.step();
  assert.equal(taken.applied, 2, 'the second worker applies the current revision for both items');
  release();
  const late = await running;
  assert.equal(late.lost + late.released, late.claimed - late.applied);
  assert.equal(late.lost, 1, 'the expired lease cannot complete');
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).lexical, [[1, 2, null, 'Revised while embedding.']]);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).vector, [[1, 2, 'eu-west', digest('Revised while embedding.')]]);
});

test('embedding runs only in a region both policies allow; an embedder outage keeps evidence pending and degraded', async () => {
  const { spaceId, collectionId } = await space();
  const us = new Spy({ region: 'us-east', costPerMillionCodePoints: 0 });
  const central = new Spy({ region: 'eu-central' });
  const west = new Spy({ region: 'eu-west' }, { down: true });
  await policy(spaceId, 1, { sourceContent: false, regions: ['eu-central', 'eu-west'] });
  await generation(spaceId, 1, 1, identity(us));
  await evidence(spaceId, { statement: 'Regional statement.' });
  const registry = new EmbeddingRegistry([us, central, west]);
  const worker = new PostgresRetrievalWorker(pool, { embedders: registry });
  await worker.step();
  assert.deepEqual([us.inputs, central.inputs], [[], ['Regional statement.']], 'the cheaper US embedder is never used');

  // Policy 2 narrows processing to eu-west, whose embedder is down: the next
  // revision is never sent to eu-central, and stays pending and degraded.
  await policy(spaceId, 2, { sourceContent: false, regions: ['eu-west'] });
  await revise(spaceId, 2, 'Narrowed statement.');
  const outage = await worker.step();
  assert.deepEqual([outage.retried, central.inputs.length, west.inTransaction.length > 0], [1, 1, true]);
  const [, , pending] = await work(spaceId);
  assert.deepEqual([pending.delivery_state, pending.last_error, pending.waiting], ['pending', 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE', true]);
  const status = await worker.status(spaceId, collectionId);
  assert.deepEqual([status.state, status.evidence.degraded, status.evidence.lastError],
    ['degraded', 1, 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE']);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).lexical, [[1, 1, null, 'Regional statement.']],
    'the generation keeps the older revision, which a search rereads at authority');

  // With no configured embedder in an allowed region, status says so before any call.
  const unconfigured = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([us, central]) });
  assert.equal((await unconfigured.status(spaceId, collectionId)).generations[0].embedderAvailable, false);

  west.behavior.down = false;
  await due('retrieval_outbox');
  assert.equal((await worker.step()).applied, 1);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).vector, [[1, 2, 'eu-west', digest('Narrowed statement.')]]);
  assert.equal((await worker.status(spaceId, collectionId)).state, 'current');
});

test('preparation stopped by its budget keeps its checkpoints and resumes without embedding them again', async () => {
  const { spaceId } = await space();
  const slow = new Spy({ maxBatch: 1 }, { delayMs: 60 });
  await policy(spaceId, 1, { claimStatements: false, lexical: false });
  await generation(spaceId, 1, 1, identity(slow));
  const words = Array.from({ length: 1_500 }, (_, i) => `w${i}`).join(' ');
  await evidence(spaceId, { extraction: words });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([slow]), prepareMs: 150 });
  // Each attempt embeds about two chunks before its budget ends; it is released
  // without an error and the next attempt continues from its checkpoints.
  const result = await worker.step({ budgetMs: 10_000 });
  assert.ok(result.retried >= 2, JSON.stringify(result));
  const [source] = await work(spaceId);
  assert.deepEqual([source.delivery_state, source.last_error], ['delivered', null]);
  assert.equal(source.attempts, result.retried + 1);
  const done = await projected(spaceId, 'source', 'src_1');
  const chunks = done.vector.length;
  assert.ok(chunks > 2);
  assert.equal(slow.inputs.length, chunks, 'each chunk was embedded once');
  assert.equal(done.checkpoints, 0);
});

test('the cell role projects records and evidence with only its base grants and db:grant-retrieval', async () => {
  const { spaceId, scope } = await space();
  const spy = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  await evidence(spaceId);
  const created = await write(scope, 'create', '{"title":"Granted"}');
  const retrievalTables = ['retrieval_policies', 'retrieval_collection_heads', 'vector_index_strategies', 'projection_generations',
    'projection_refs', 'projection_deletion_receipts', 'lexical_chunks', 'vector_chunks', 'embedding_checkpoints', 'retrieval_outbox'];
  const role = `sta45_cell_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: target.toString(), max: 2, options: `-c role=${role}` });
  // Routines PUBLIC may execute now, so exactly those are granted back afterwards.
  const publicRoutines = (await pool.query(`SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`)).rows.map(row => row.routine);
  try {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${retrievalTables.join(',')} FROM ${role}`);
    await pool.query('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC');
    execFileSync(process.execPath, ['scripts/grant-retrieval.mjs'], { cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: 'pipe', env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: target.toString(), STATEPLANE_CELL_ROLE: role } });
    const registry = new EmbeddingRegistry([spy]);
    const worker = new PostgresRetrievalWorker(cellPool, { embedders: registry });
    assert.equal((await worker.step()).applied, 2);
    const cellOutbox = new PostgresOutbox(cellPool, new PostgresAuthority(cellPool, 3600));
    const projector = new RecordRetrievalProjector(cellPool, { embedders: registry });
    assert.deepEqual(await consume(await hints(), message => cellOutbox.process(message, projector), 1), ['applied']);
    await deleteEvidence(spaceId, 'claim', 'clm_1');
    assert.equal((await worker.step()).applied, 1);
    assert.equal((await worker.status(spaceId, 'alpha')).state, 'current');
  } finally {
    await cellPool.end();
    for (const routine of publicRoutines) await pool.query(`GRANT EXECUTE ON ROUTINE ${routine} TO PUBLIC`);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
  assert.equal((await projected(spaceId, 'record', created.ref.id)).vector.length, 1);
  assert.equal((await projected(spaceId, 'source', 'src_1')).vector.length, 1);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).receipts, [[1, 2, 2]]);
});

test('a retired generation is never written, and a suspended space\'s work waits without failing', async () => {
  const { spaceId, collectionId } = await space();
  await policy(spaceId, 1, { vector: false, regions: [] });
  await generation(spaceId, 1, 1);
  await generation(spaceId, 2, 1, null, 'building');
  await evidence(spaceId);
  const worker = new PostgresRetrievalWorker(pool);
  assert.equal((await worker.step()).applied, 2, 'lexical generations need no embedder');
  await pool.query(`UPDATE projection_generations SET state='retired' WHERE space_id=$1 AND generation=1`, [spaceId]);
  await revise(spaceId, 2, 'Second statement.');
  await pool.query(`UPDATE spaces SET lifecycle='suspended' WHERE space_id=$1`, [spaceId]);
  assert.deepEqual(await worker.step(), { claimed: 0, applied: 0, released: 0, lost: 0, retried: 0, unknown: 0 });
  const [, , waiting] = await work(spaceId);
  assert.deepEqual([waiting.delivery_state, waiting.attempts, waiting.last_error], ['pending', 0, null]);
  await pool.query(`UPDATE spaces SET lifecycle='active' WHERE space_id=$1`, [spaceId]);
  assert.equal((await worker.step()).applied, 1);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).lexical, [[1, 1, null, 'The bridge opened in 1932.'],
    [2, 2, null, 'Second statement.']]);
  assert.deepEqual((await worker.status(spaceId, collectionId)).generations.map(entry => [entry.generation, entry.state]), [[2, 'building']]);
});

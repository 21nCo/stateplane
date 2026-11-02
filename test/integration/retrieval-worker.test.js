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
import { DeadlineExceededError, diagnostic, inTransaction } from '../../packages/postgres/dist/faults.js';

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
 * A deterministic embedder that records every input it returned an
 * embedding for and, at each call, whether any session of the test database
 * was inside a transaction. `before(call, signal)` runs at the start of each
 * call (numbered from 1); `down` fails every call and `failFirst` the first
 * n; `delayMs` waits, giving up on the signal unless `stubborn`.
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
    const call = this.inTransaction.length;
    await this.behavior.before?.(call, signal);
    if (this.behavior.down || call <= (this.behavior.failFirst ?? 0)) throw new EmbedderUnavailableError('provider unreachable');
    // Like a fetch with the signal, a slow call gives up when it aborts.
    if (this.behavior.delayMs) await new Promise((resolve, reject) => {
      if (!this.behavior.stubborn && signal.aborted) { reject(new EmbedderUnavailableError('aborted')); return; }
      const timer = setTimeout(resolve, this.behavior.delayMs);
      if (!this.behavior.stubborn) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new EmbedderUnavailableError('aborted')); }, { once: true });
    });
    await this.behavior.gate?.();
    const vectors = await super.embed(texts, signal);
    this.inputs.push(...texts);
    return vectors;
  }
}
/** Wait for `signal` to abort, then give up as a fetch with that signal would. */
const untilAborted = signal => new Promise((_, reject) => {
  const abort = () => reject(new EmbedderUnavailableError('aborted'));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
/** Poll until `count` sessions wait on a lock in a statement containing `text`. */
async function waitingOnLock(text, count = 1) {
  for (let tries = 0; ; tries++) {
    const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND position($1 in query)>0`, [text])).rows[0].n;
    if (waiting >= count) return;
    assert.ok(tries < 400, `no session waited on a lock in ${text}`);
    await new Promise(resolve => setTimeout(resolve, 5));
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
/** Lease every due record event (making every undelivered one due first, unless `makeDue` is false) and return its hints in revision order. */
async function hints(makeDue = true) {
  if (makeDue) await due('projection_outbox');
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
// As the services do: a source's extraction writers and its deletion hold
// its extraction lock, and a deletion tombstones the Ref at its revision.
const extractionLock = (db, spaceId) => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
  [JSON.stringify(['stateplane:extraction', spaceId, 'alpha', 'src_1'])]);
async function serviceTransaction(work) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await work(db); await db.query('COMMIT'); }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
const deleteEvidence = (spaceId, kind, id) => serviceTransaction(async db => {
  if (kind === 'source') await extractionLock(db, spaceId);
  await db.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind=$2 AND entity_id=$3 AND NOT tombstone`,
    [spaceId, kind, id]);
});
const extractLocked = (spaceId, version, content) => serviceTransaction(async db => {
  await extractionLock(db, spaceId);
  await extract(spaceId, version, content, db);
});
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
  // Its own last check, that the record still holds revision 2, refuses it
  // too; what it wrote before that check is committed here regardless.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(projector.apply({ ref: created.ref, revision: 2, generation: 1, deleted: false,
      canonicalData: '{"title":"second draft"}' }, undefined, (sql, values) => client.query(sql, values)), { code: 'PROJECTION_INCOMPLETE' });
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
  await extractLocked(spaceId, 2, 'Corrected: the bridge opened in 1933.');
  await revise(spaceId, 3, 'The bridge opened in 1933.');
  await deleteEvidence(spaceId, 'claim', 'clm_1');
  await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-(revision * interval '1 minute')
    WHERE space_id=$1 AND delivery_state='pending'`, [spaceId]);
  const before = spy.inputs.length;
  assert.equal((await worker.step()).applied, 3);
  assert.deepEqual(spy.inputs.slice(before), ['Corrected: the bridge opened in 1933.'], 'the deleted claim\'s new text is never embedded');
  const claim = await projected(spaceId, 'claim', 'clm_1');
  // The services tombstone a Ref at its revision; the receipt is at that same revision.
  assert.deepEqual([claim.refs, claim.lexical, claim.vector, claim.checkpoints, claim.receipts],
    [[{ generation: 1, revision: 3, extraction: null, deleted: true }], [], [], 0, [[1, 3, 2]]]);
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
  const claim = await projected(spaceId, 'claim', 'clm_1');
  assert.deepEqual(claim.vector, [[1, 2, 'eu-west', digest('Revised while embedding.')]]);
  assert.equal(claim.checkpoints, 0, 'the late preparation of revision 1 saved nothing');
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
  // One chunk per call; every third call is still in flight when the
  // preparation budget ends and gives up on its signal, so each attempt saves
  // exactly two chunks and the call cut short returns nothing.
  const slow = new Spy({ maxBatch: 1 }, { before: (call, signal) => call % 3 === 0 ? untilAborted(signal) : undefined });
  await policy(spaceId, 1, { claimStatements: false, lexical: false });
  await generation(spaceId, 1, 1, identity(slow));
  const words = Array.from({ length: 1_000 }, (_, i) => `w${i}`).join(' ');
  await evidence(spaceId, { extraction: words });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([slow]), prepareMs: 1_000 });
  const result = await worker.step({ budgetMs: 20_000 });
  const [source] = await work(spaceId);
  assert.deepEqual([source.delivery_state, source.last_error], ['delivered', null]);
  const done = await projected(spaceId, 'source', 'src_1');
  const chunks = done.vector.length;
  assert.ok(chunks > 4, `${chunks} chunks`);
  // Each interrupted attempt was released at once, without an error, and the next resumed from its checkpoints.
  assert.equal(result.retried, Math.ceil(chunks / 2) - 1, JSON.stringify(result));
  assert.equal(source.attempts, result.retried + 1);
  assert.deepEqual(slow.inputs.toSorted(), [...new Set(slow.inputs)].toSorted(), 'each chunk was embedded once');
  assert.equal(slow.inputs.length, chunks);
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
    'projection_refs', 'projection_deletion_receipts', 'lexical_chunks', 'vector_chunks', 'embedding_checkpoints', 'retrieval_outbox',
    'retrieval_dispatch_checkpoint'];
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
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).receipts, [[1, 1, 2]]);
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

test('one vector generation\'s outage or missing embedder never holds back the collection\'s other generations', async () => {
  const { spaceId, scope, collectionId } = await space();
  const spy = new Spy({}, { down: true });
  // Generation 1 serves lexical only; generation 2 is being built with vectors.
  await policy(spaceId, 1, { vector: false, regions: [] });
  await generation(spaceId, 1, 1);
  await policy(spaceId, 2);
  await generation(spaceId, 2, 2, identity(spy), 'building');
  await evidence(spaceId);
  const created = await write(scope, 'create', '{"title":"Mixed generations"}');
  const registry = new EmbeddingRegistry([spy]);
  const projector = new RecordRetrievalProjector(pool, { embedders: registry });

  // The record reaches generation 1 at once and stays due, uncounted, for generation 2.
  assert.deepEqual(await deliver(await hints(), projector), ['retry']);
  const record = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual([record.lexical, record.vector], [[[1, 1, '/title', 'Mixed generations']], []]);
  assert.deepEqual((await pool.query('SELECT delivery_state,failures,last_error FROM projection_outbox WHERE space_id=$1', [spaceId])).rows,
    [{ delivery_state: 'pending', failures: 0, last_error: 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE' }]);

  // Sources and claims under the jobs Worker's empty registry: generation 1
  // applies; each item stays pending with an outage's backoff and error.
  const unconfigured = new PostgresRetrievalWorker(pool);
  const step = await unconfigured.step();
  assert.deepEqual([step.claimed, step.applied, step.retried], [2, 0, 2]);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).lexical, [[1, 1, null, 'The bridge opened in 1932.']]);
  assert.deepEqual((await projected(spaceId, 'source', 'src_1')).lexical, [[1, 1, null, 'The bridge opened in 1932 after four years.']]);
  for (const row of await work(spaceId)) assert.deepEqual([row.delivery_state, row.attempts, row.last_error, row.waiting],
    ['pending', 1, 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE', true]);
  const status = await unconfigured.status(spaceId, collectionId);
  assert.equal(status.state, 'degraded');
  assert.deepEqual(status.generations.map(entry => [entry.generation, entry.embedderAvailable]), [[1, null], [2, false]]);

  // With the embedder configured and up, generation 2 catches up and nothing else changes.
  spy.behavior.down = false;
  await due('retrieval_outbox');
  assert.equal((await new PostgresRetrievalWorker(pool, { embedders: registry }).step()).applied, 2);
  assert.deepEqual(await deliver(await hints(), projector), ['applied']);
  const caught = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual([caught.lexical, caught.vector, caught.checkpoints], [[[1, 1, '/title', 'Mixed generations'],
    [2, 1, '/title', 'Mixed generations']], [[2, 1, 'eu-west', digest('Mixed generations')]], 0]);
  assert.deepEqual((await projected(spaceId, 'claim', 'clm_1')).vector, [[2, 1, 'eu-west', digest('The bridge opened in 1932.')]]);
  assert.equal((await unconfigured.status(spaceId, collectionId)).state, 'degraded', 'still no embedder in this worker');
  assert.equal((await new PostgresRetrievalWorker(pool, { embedders: registry }).status(spaceId, collectionId)).state, 'current');
});

test('a record string holding U+0000 projects as U+FFFD at the same offsets', async () => {
  const { spaceId, scope } = await space();
  const spy = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  const created = await write(scope, 'create', '{"title":"a\\u0000b c"}');
  assert.deepEqual(await deliver(await hints(), new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([spy]) })),
    ['applied']);
  const view = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual(view.lexical, [[1, 1, '/title', 'a\uFFFDb c']]);
  assert.deepEqual(view.vector, [[1, 1, 'eu-west', digest('a\uFFFDb c')]]);
  const [range] = (await pool.query('SELECT content_start,content_end FROM lexical_chunks WHERE space_id=$1', [spaceId])).rows;
  assert.deepEqual([Number(range.content_start), Number(range.content_end)], [0, 5]);
});

test('a narrower processing policy committed during a call or between retries stops embedding in the removed region', async () => {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const narrow = spaceId => policy(spaceId, 2, { claimStatements: false, regions: ['eu-central'] });

  // During a call: one chunk per call, and the policy drops eu-west while the
  // first is in flight. Its result is refused, no later batch goes to eu-west,
  // and the work runs again at once in eu-central, without an error of its own.
  const first = await space();
  const west = new Spy({ maxBatch: 1 }, { before: async call => { if (call === 1) await narrow(first.spaceId); } });
  const central = new Spy({ maxBatch: 1, region: 'eu-central' });
  await policy(first.spaceId, 1, { claimStatements: false, regions: ['eu-west', 'eu-central'] });
  await generation(first.spaceId, 1, 1, identity(west));
  await evidence(first.spaceId, { extraction: words });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([west, central]) });
  assert.ok((await worker.step()).applied >= 1);
  assert.equal(west.inTransaction.length, 1, 'no call to eu-west after the narrowing committed');
  const source = await projected(first.spaceId, 'source', 'src_1');
  assert.ok(source.vector.length >= 2 && source.vector.every(([, , region]) => region === 'eu-central'));
  assert.equal(source.checkpoints, 0);
  assert.deepEqual((await work(first.spaceId)).map(row => [row.ref_kind, row.delivery_state, row.last_error]),
    [['source', 'delivered', null], ['claim', 'delivered', null]]);

  // Between retries: the first call fails as an outage while the policy narrows; the retry never calls.
  const second = await space();
  const flaky = new Spy({}, { failFirst: 1, before: async call => { if (call === 1) await narrow(second.spaceId); } });
  await policy(second.spaceId, 1, { claimStatements: false, regions: ['eu-west', 'eu-central'] });
  await generation(second.spaceId, 1, 1, identity(flaky));
  await evidence(second.spaceId, { extraction: 'Short extraction.' });
  await new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([flaky]) }).step();
  assert.equal(flaky.inTransaction.length, 1, 'the retry rechecked the policy and did not call');
  const [pending] = await work(second.spaceId);
  assert.deepEqual([pending.delivery_state, pending.last_error], ['pending', 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE']);
});

test('a step out of time releases unstarted items without spending attempts, and a slow embedder at its tail is an outage', async () => {
  const { spaceId } = await space();
  // Ignores its signal, as a provider call that cannot be cancelled would.
  const stubborn = new Spy({}, { delayMs: 1_500, stubborn: true });
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(stubborn));
  await evidence(spaceId);
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([stubborn]) });
  const began = Date.now();
  // The first item starts with about 1.2 s; preparation gets half and its
  // grace a quarter, so it ends as an outage before the item's own budget.
  const result = await worker.step({ budgetMs: 1_200 });
  assert.ok(Date.now() - began < 1_600, 'the step ended within its budget');
  assert.deepEqual(result, { claimed: 2, applied: 0, released: 1, lost: 0, retried: 1, unknown: 0 });
  const rows = (await pool.query(`SELECT ref_kind,attempts,last_error,available_at>clock_timestamp() AS waiting,
      available_at<=clock_timestamp()+interval '5 seconds' AS outage_backoff
    FROM retrieval_outbox WHERE space_id=$1 ORDER BY enqueued_at,job_id`, [spaceId])).rows;
  assert.deepEqual(rows, [
    { ref_kind: 'source', attempts: 1, last_error: 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE', waiting: true, outage_backoff: true },
    { ref_kind: 'claim', attempts: 0, last_error: null, waiting: false, outage_backoff: true }]);
  // Let the abandoned call finish before the next test.
  await new Promise(resolve => setTimeout(resolve, 1_700));
});

test('a late record or extraction preparation leaves no checkpoints once a newer revision is applied', async () => {
  const { spaceId, scope } = await space();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const embedding = new Promise(resolve => { entered = resolve; });
  const slow = new Spy({}, { before: async () => { entered(); await gate; } });
  const fast = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(slow));
  const created = await write(scope, 'create', '{"title":"first"}');
  const late = deliver(await hints(), new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([slow]) }));
  await embedding;
  await write(scope, 'replace', '{"title":"second"}', { recordId: created.ref.id, expectedRevision: 1 });
  // Only the new revision's event is dispatched; revision 1 keeps its lease.
  assert.deepEqual(await deliver(await hints(false), new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([fast]) })),
    ['applied']);
  release();
  assert.deepEqual(await late, ['superseded']);
  const record = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual([record.vector, record.checkpoints], [[[1, 2, 'eu-west', digest('second')]], 0]);

  // The same for a source extraction prepared while a newer one is applied.
  const evidenceSpace = await space();
  let open;
  const extractionGate = new Promise(resolve => { open = resolve; });
  let started;
  const extracting = new Promise(resolve => { started = resolve; });
  const slowSource = new Spy({}, { before: async () => { started(); await extractionGate; } });
  await policy(evidenceSpace.spaceId, 1, { claimStatements: false });
  await generation(evidenceSpace.spaceId, 1, 1, identity(slowSource));
  await evidence(evidenceSpace.spaceId);
  const running = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([slowSource]) }).step();
  await extracting;
  await extractLocked(evidenceSpace.spaceId, 2, 'A newer extraction.');
  await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()-interval '1 second'
    WHERE space_id=$1 AND ref_kind='source' AND extraction_version=1`, [evidenceSpace.spaceId]);
  assert.ok((await new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([fast]) }).step()).applied >= 1);
  open();
  await running;
  const source = await projected(evidenceSpace.spaceId, 'source', 'src_1');
  assert.deepEqual([source.refs[0].extraction, source.vector, source.checkpoints], [2, [[1, 1, 'eu-west', digest('A newer extraction.')]], 0]);
});

/**
 * Hold the item's apply after its reread of authority (on the generation
 * lock, inside its 1 s lock wait), commit `change` meanwhile, keep the
 * change's own work from being due, then let the apply continue.
 */
async function changeDuringApply(spaceId, worker, change) {
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM projection_generations WHERE space_id=$1 FOR UPDATE', [spaceId]);
    const running = worker.step();
    for (let tries = 0; ; tries++) {
      const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%FROM projection_generations%'`)).rows[0].n;
      if (waiting) break;
      assert.ok(tries < 400, 'the apply never reached the generation lock');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await change();
    await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()+interval '1 hour'
      WHERE space_id=$1 AND delivery_state='pending' AND attempts=0`, [spaceId]);
    await blocker.query('ROLLBACK');
    return await running;
  } finally { blocker.release(); }
}

test('authority that changes between the item\'s reread and its commit is never projected over', async () => {
  const cases = [
    ['claim', 'a claim deletion', spaceId => deleteEvidence(spaceId, 'claim', 'clm_1'),
      view => assert.deepEqual([view.refs, view.lexical, view.receipts], [[{ generation: 1, revision: 1, extraction: null, deleted: true }], [], [[1, 1, 0]]])],
    ['claim', 'a claim revision', spaceId => revise(spaceId, 2, 'Revised during apply.'),
      view => assert.deepEqual(view.lexical, [[1, 2, null, 'Revised during apply.']])],
    ['source', 'a new extraction', spaceId => extractLocked(spaceId, 2, 'Extracted during apply.'),
      view => assert.deepEqual([view.refs[0].extraction, view.lexical], [2, [[1, 1, null, 'Extracted during apply.']]])],
    ['source', 'a source deletion', spaceId => deleteEvidence(spaceId, 'source', 'src_1'),
      view => assert.deepEqual([view.refs, view.lexical, view.receipts], [[{ generation: 1, revision: 1, extraction: null, deleted: true }], [], [[1, 1, 0]]])],
  ];
  for (const [kind, label, change, expect] of cases) {
    const { spaceId } = await space();
    await policy(spaceId, 1, { vector: false, regions: [], sourceContent: kind === 'source', claimStatements: kind === 'claim' });
    await generation(spaceId, 1, 1);
    await evidence(spaceId);
    // The other kind's item is not configured, so it applies without waiting.
    const result = await changeDuringApply(spaceId, new PostgresRetrievalWorker(pool), () => change(spaceId));
    assert.ok(result.released >= 1, `${label}: the stale apply rolled back (${JSON.stringify(result)})`);
    expect(await projected(spaceId, kind, kind === 'claim' ? 'clm_1' : 'src_1'));
  }
});

test('a record\'s fallback apply holds the scope fence: a suspension or placement fence it waited for leaves nothing applied', async () => {
  for (const [label, change] of [['suspension', "lifecycle='suspended'"], ['placement fence', 'placement_generation=placement_generation+1']]) {
    const { spaceId, scope } = await space();
    // Generation 1 is lexical; generation 2 needs vectors and has no embedder, so preparation fails at once.
    await policy(spaceId, 1, { vector: false, regions: [] });
    await generation(spaceId, 1, 1);
    await policy(spaceId, 2);
    await generation(spaceId, 2, 2, identity(new Spy()), 'building');
    const created = await write(scope, 'create', '{"title":"Fenced"}');
    const messages = await hints();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE spaces SET ${change} WHERE space_id=$1`, [spaceId]);
      const delivered = deliver(messages, new RecordRetrievalProjector(pool));
      // The fallback apply waits on the space row the change holds, then sees it committed.
      await waitingOnLock('s.placement_generation=$3::bigint');
      await writer.query('COMMIT');
      assert.deepEqual(await delivered, ['released'], label);
    } finally { writer.release(); }
    const record = await projected(spaceId, 'record', created.ref.id);
    assert.deepEqual([record.refs, record.lexical], [[], []], `${label}: nothing applied after the scope closed`);
  }
});

test('a suspension or deletion committed during preparation stops further calls and saves nothing', async () => {
  // Between retries: the first call fails as an outage while the space is suspended; the retry never calls.
  const first = await space();
  const suspend = () => pool.query(`UPDATE spaces SET lifecycle='suspended' WHERE space_id=$1`, [first.spaceId]);
  const flaky = new Spy({}, { failFirst: 1, before: async call => { if (call === 1) await suspend(); } });
  await policy(first.spaceId, 1, { claimStatements: false });
  await generation(first.spaceId, 1, 1, identity(flaky));
  await evidence(first.spaceId);
  await new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([flaky]) }).step();
  assert.equal(flaky.inTransaction.length, 1, 'no call after the suspension committed');
  const [suspended] = await work(first.spaceId);
  assert.deepEqual([suspended.delivery_state, suspended.last_error], ['pending', null], 'it waits, without an error of its own');
  assert.equal((await projected(first.spaceId, 'source', 'src_1')).checkpoints, 0);

  // Between batches: one chunk per call, and the space starts deletion during the first; nothing is saved or called after.
  const second = await space();
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
  const spy = new Spy({ maxBatch: 1 }, { before: async call => {
    if (call === 1) await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [second.spaceId]);
  } });
  await policy(second.spaceId, 1, { claimStatements: false });
  await generation(second.spaceId, 1, 1, identity(spy));
  await evidence(second.spaceId, { extraction: words });
  await new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([spy]) }).step();
  assert.equal(spy.inTransaction.length, 1, 'no call after the deletion committed');
  const source = await projected(second.spaceId, 'source', 'src_1');
  assert.deepEqual([source.vector, source.checkpoints], [[], 0]);
});

test('erasure that begins while an item is prepared succeeds, and the preparation writes nothing after it', async () => {
  const { spaceId } = await space();
  const locker = await pool.connect();
  const purger = await pool.connect();
  let hold = false;
  let purge;
  // During the call: deletion commits, and the purge starts and pauses on a
  // lexical chunk this test holds, after it removed the space's checkpoints.
  const spy = new Spy({}, { before: async () => {
    if (!hold) return;
    await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [spaceId]);
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM lexical_chunks WHERE space_id=$1 FOR UPDATE', [spaceId]);
    purge = purger.query('BEGIN').then(() => purger.query('SELECT stateplane_purge_space($1)', [spaceId]));
    purge.catch(() => {});
    await waitingOnLock('stateplane_purge_space');
  } });
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  await evidence(spaceId);
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([spy]) });
  try {
    assert.equal((await worker.step()).applied, 2);
    await extractLocked(spaceId, 2, 'A second extraction.');
    hold = true;
    await worker.step();
    await locker.query('COMMIT');
    await purge;
    await purger.query('COMMIT');
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    await purger.query('ROLLBACK').catch(() => {});
    locker.release();
    purger.release();
  }
  const left = (await pool.query(`SELECT (SELECT count(*) FROM embedding_checkpoints WHERE space_id=$1)::int AS checkpoints,
    (SELECT count(*) FROM projection_refs WHERE space_id=$1)::int AS refs`, [spaceId])).rows[0];
  assert.deepEqual(left, { checkpoints: 0, refs: 0 });
});

test('pairs with due work take turns across claims, steps and workers, however long another pair\'s backlog', async () => {
  const spaces = [];
  for (let i = 0; i < 3; i++) spaces.push((await space()).spaceId);
  const [a, b, c] = spaces.toSorted();
  for (const id of spaces) {
    await policy(id, 1, { vector: false, regions: [] });
    await generation(id, 1, 1);
    await evidence(id);
  }
  // Two long backlogs: twelve claim revisions each, plus the source.
  for (const id of [a, b]) for (let revision = 2; revision <= 12; revision++) await revise(id, revision, `Statement ${revision}.`);
  const order = async since => (await pool.query(`SELECT space_id FROM retrieval_outbox WHERE space_id=ANY($1)
    AND delivered_at>$2 ORDER BY delivered_at`, [spaces, since])).rows.map(row => row.space_id);
  await pool.query('UPDATE retrieval_dispatch_checkpoint SET after_space_id=NULL,after_collection_id=NULL');
  const options = { limit: 2, perPair: 1, pairs: 3 };
  const start = new Date();
  await new PostgresRetrievalWorker(pool).step(options);
  const delivered = await order(start);
  assert.equal(delivered.length, 13 + 13 + 2);
  assert.deepEqual(delivered.slice(0, 6), [a, b, c, a, b, c], 'the short pair is served in turn, not after the backlogs');

  // Another worker's step continues from the stored cursor.
  for (const id of spaces) await revise(id, id === c ? 2 : 13, 'Later statement.');
  await pool.query(`UPDATE retrieval_dispatch_checkpoint SET after_space_id=$1,after_collection_id='alpha'`, [b]);
  const later = new Date();
  await new PostgresRetrievalWorker(pool).step({ ...options, limit: 1 });
  assert.deepEqual(await order(later), [c, a, b]);
  assert.deepEqual((await pool.query('SELECT after_space_id,after_collection_id FROM retrieval_dispatch_checkpoint')).rows,
    [{ after_space_id: b, after_collection_id: 'alpha' }]);
});

test('a preparation that starts after a newer position without configured content applied records nothing and saves nothing', async () => {
  // A record: revision 2 drops the only configured field and applies before revision 1's preparation begins.
  const { spaceId, scope } = await space();
  const spy = new Spy();
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(spy));
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([spy]) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const late = { prepare: async (change, signal) => { entered(); await gate; return projector.prepare(change, signal); },
    apply: (change, prepared, query) => projector.apply(change, prepared, query) };
  const created = await write(scope, 'create', '{"title":"Removed later"}');
  const running = deliver(await hints(), late);
  await started;
  await write(scope, 'replace', '{"note":"no title"}', { recordId: created.ref.id, expectedRevision: 1 });
  assert.deepEqual(await deliver(await hints(false), projector), ['applied']);
  release();
  assert.deepEqual(await running, ['superseded']);
  const record = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual([record.refs, record.lexical, record.checkpoints],
    [[{ generation: 1, revision: 2, extraction: null, deleted: false }], [], 0]);
  assert.deepEqual(spy.inputs, [], 'the removed title was never embedded');

  // A source: a whitespace-only extraction applies to generation 2 while
  // extraction 1 is still being embedded for generation 1.
  const second = await space();
  let open;
  const opened = new Promise(resolve => { open = resolve; });
  let reached;
  const embedding = new Promise(resolve => { reached = resolve; });
  const slow = new Spy({}, { before: async () => { reached(); await opened; } });
  const other = new Spy({ model: 'feature-hash-b' });
  await policy(second.spaceId, 1, { claimStatements: false });
  await generation(second.spaceId, 1, 1, identity(slow));
  await generation(second.spaceId, 2, 1, identity(other), 'building');
  await evidence(second.spaceId);
  const running2 = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([slow, other]) }).step();
  await embedding;
  await extractLocked(second.spaceId, 2, '   ');
  const fast = new EmbeddingRegistry([new Spy(), new Spy({ model: 'feature-hash-b' })]);
  assert.equal((await new PostgresRetrievalWorker(pool, { embedders: fast }).step()).applied, 1);
  open();
  await running2;
  const source = await projected(second.spaceId, 'source', 'src_1');
  assert.deepEqual([source.refs.map(ref => [ref.generation, ref.extraction, ref.deleted]), source.lexical, source.vector, source.checkpoints],
    [[[1, 2, false], [2, 2, false]], [], [], 0]);
  assert.deepEqual(other.inputs, [], 'generation 2 never embedded the older extraction');
});

test('concurrent first applies of one Ref converge, neither counted as a failure', async () => {
  const { spaceId } = await space();
  await policy(spaceId, 1, { vector: false, regions: [], sourceContent: false });
  await generation(spaceId, 1, 1);
  await evidence(spaceId);
  await revise(spaceId, 2, 'The second statement.');
  // Only the two claim items are due; each worker takes one.
  await pool.query(`UPDATE retrieval_outbox SET available_at=clock_timestamp()+interval '1 hour'
    WHERE space_id=$1 AND ref_kind='source'`, [spaceId]);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM projection_generations WHERE space_id=$1 FOR UPDATE', [spaceId]);
    const options = { limit: 1, perPair: 1 };
    const runs = [new PostgresRetrievalWorker(pool).step(options), new PostgresRetrievalWorker(pool).step(options)];
    await waitingOnLock('FROM projection_generations', 2);
    await blocker.query('ROLLBACK');
    assert.deepEqual((await Promise.all(runs)).map(result => result.applied), [1, 1]);
  } finally { blocker.release(); }
  assert.deepEqual((await work(spaceId)).filter(row => row.ref_kind === 'claim')
    .map(row => [row.delivery_state, row.attempts, row.last_error]), [['delivered', 1, null], ['delivered', 1, null]]);
  const claim = await projected(spaceId, 'claim', 'clm_1');
  assert.deepEqual([claim.refs, claim.lexical], [[{ generation: 1, revision: 2, extraction: null, deleted: false }],
    [[1, 2, null, 'The second statement.']]]);
});

test('a provider error that quotes the input is recorded only by its category, on record and evidence work', async () => {
  const secret = 'Confidential bridge tender';
  const { spaceId, scope, collectionId } = await space();
  const quoting = new Spy({}, { before: () => { throw new Error(`model refused input: ${secret}`); } });
  await policy(spaceId, 1);
  await generation(spaceId, 1, 1, identity(quoting));
  await evidence(spaceId, { extraction: `${secret} opened.`, statement: `${secret} was signed.` });
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([quoting]) });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([quoting]) });
  await write(scope, 'create', JSON.stringify({ title: secret }));
  assert.deepEqual(await deliver(await hints(), projector), ['failed']);
  await worker.step();
  const failed = 'EmbedderFailedError: The embedder failed for this input';
  const record = (await pool.query('SELECT failures,last_error FROM projection_outbox WHERE space_id=$1', [spaceId])).rows[0];
  assert.deepEqual(record, { failures: 1, last_error: failed }, 'the input\'s own failure, without its text');
  assert.deepEqual((await work(spaceId)).map(row => [row.ref_kind, row.delivery_state, row.last_error]),
    [['source', 'pending', failed], ['claim', 'pending', failed]]);
  const status = await worker.status(spaceId, collectionId);
  assert.ok(!JSON.stringify(status).includes(secret), 'status discloses no input');

  // A coded transient error from the provider is an outage, and keeps no text either.
  quoting.behavior.before = () => { throw Object.assign(new Error(`socket reset sending ${secret}`), { code: 'ECONNRESET' }); };
  await due('retrieval_outbox');
  await worker.step();
  assert.deepEqual((await work(spaceId)).map(row => row.last_error),
    ['EmbedderUnavailableError EMBEDDER_UNAVAILABLE', 'EmbedderUnavailableError EMBEDDER_UNAVAILABLE']);

  // Other diagnostics stay within 1,024 UTF-8 bytes, cut on a code point.
  const long = diagnostic(new Error('é'.repeat(2_000)));
  assert.ok(Buffer.byteLength(long) <= 1_024 && Buffer.byteLength(long) > 1_020 && !long.includes('�'));
});

test('a bounded transaction issues nothing after its deadline, and an abort or deadline ends the statement in flight', async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS deadline_probe(n integer)');
  const log = [];
  const logged = { connect: async () => {
    const client = await pool.connect();
    return { query: (sql, values) => { log.push({ at: Date.now(), sql }); return client.query(sql, values); },
      release: discard => client.release(discard), on: (...args) => client.on(...args),
      removeListener: (...args) => client.removeListener(...args) };
  } };
  const running = async sleep => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND state='active' AND query LIKE $1`, [`%pg_sleep(${sleep})%`])).rows[0].n;
  const settled = async sleep => {
    for (let tries = 0; await running(sleep); tries++) {
      assert.ok(tries < 40, `pg_sleep(${sleep}) still running`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  // Several statements, each shorter than the budget, together longer: none starts after the deadline.
  const deadline = Date.now() + 200;
  await assert.rejects(inTransaction(logged, async db => {
    for (let n = 0; n < 10; n++) {
      await db.query('INSERT INTO deadline_probe VALUES($1)', [n]);
      await db.query('SELECT pg_sleep(0.04)');
    }
  }, { deadline }), DeadlineExceededError);
  const ended = Date.now();
  const late = log.filter(entry => entry.at >= deadline && entry.sql !== 'ROLLBACK');
  assert.deepEqual(late, [], 'no statement after the deadline');
  assert.ok(ended - deadline < 150, `rejected ${ended - deadline} ms after the deadline`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM deadline_probe')).rows[0].n, 0, 'nothing committed');

  // One statement longer than the time left is ended at the deadline, on the server too.
  let started = Date.now();
  await assert.rejects(inTransaction(logged, db => db.query('SELECT pg_sleep(3.1)'), { deadline: started + 150 }),
    DeadlineExceededError);
  assert.ok(Date.now() - started < 400, `${Date.now() - started} ms`);
  await settled('3.1');

  // An abort ends the statement in flight at once, well before its bound or the deadline, and cancels it.
  const controller = new AbortController();
  started = Date.now();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(inTransaction(logged, db => db.query('SELECT pg_sleep(3.2)'),
    { deadline: started + 4_000, signal: controller.signal }), DeadlineExceededError);
  assert.ok(Date.now() - started < 400, `${Date.now() - started} ms`);
  await settled('3.2');
  await pool.query('DROP TABLE deadline_probe');
});

test('a record fallback apply whose delivery aborts commits nothing, frees its locks and reports the outage', async () => {
  const { spaceId, collectionId, scope } = await space();
  // Generation 1 is lexical; generation 2 needs vectors and has no embedder, so preparation fails at once.
  await policy(spaceId, 1, { vector: false, regions: [] });
  await generation(spaceId, 1, 1);
  await policy(spaceId, 2);
  await generation(spaceId, 2, 2, identity(new Spy()), 'building');
  const created = await write(scope, 'create', '{"title":"Aborted"}');
  const change = { ref: { spaceId, collectionId, kind: 'record', id: created.ref.id }, revision: 1, generation: 1, deleted: false, canonicalData: '{"title":"Aborted"}' };
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    // As a record write does: it blocks the authority fence's share lock, not the key share of a projection's foreign key.
    await writer.query('SELECT 1 FROM records WHERE space_id=$1 AND record_id=$2 FOR NO KEY UPDATE', [spaceId, created.ref.id]);
    const controller = new AbortController();
    const prepared = new RecordRetrievalProjector(pool).prepare(change, controller.signal);
    prepared.catch(() => {});
    // The fallback apply waits on the record row the writer holds; the delivery's budget then ends.
    await waitingOnLock('FROM records WHERE');
    const aborted = Date.now();
    controller.abort();
    await assert.rejects(prepared, error => error.code === 'EMBEDDER_UNAVAILABLE');
    assert.ok(Date.now() - aborted < 300, `${Date.now() - aborted} ms`);
    // Its lock wait was cancelled, not left to its 1 s lock timeout, while the writer still holds the row.
    const waiting = async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM records WHERE%'`)).rows[0].n;
    for (let tries = 0; await waiting(); tries++) {
      assert.ok(tries < 30 && Date.now() - aborted < 600, 'the fallback still waits on the record row');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await writer.query('COMMIT');
  } finally { writer.release(); }
  const record = await projected(spaceId, 'record', created.ref.id);
  assert.deepEqual([record.refs, record.lexical], [[], []], 'nothing committed');
});

test('a deletion or newer revision committed between batches stops further calls for the superseded text', async () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
  // Evidence: the source is deleted, as its service does, during the first of several one-chunk calls.
  const first = await space();
  const spy = new Spy({ maxBatch: 1 }, { before: async call => { if (call === 1) await deleteEvidence(first.spaceId, 'source', 'src_1'); } });
  await policy(first.spaceId, 1, { claimStatements: false });
  await generation(first.spaceId, 1, 1, identity(spy));
  await evidence(first.spaceId, { extraction: words });
  const worker = new PostgresRetrievalWorker(pool, { embedders: new EmbeddingRegistry([spy]) });
  await worker.step();
  assert.equal(spy.inTransaction.length, 1, 'no call after the deletion committed');
  await due('retrieval_outbox');
  await worker.step();
  const source = await projected(first.spaceId, 'source', 'src_1');
  assert.deepEqual([source.refs.map(ref => ref.deleted), source.vector, source.checkpoints], [[true], [], 0]);
  assert.ok((await work(first.spaceId)).every(row => row.delivery_state === 'delivered' && row.last_error === null));

  // A record: revision 2 commits during the first call preparing revision 1.
  const second = await space();
  let created;
  const recordSpy = new Spy({ maxBatch: 1 }, { before: async call => {
    if (call === 1) await write(second.scope, 'replace', '{"title":"Short"}', { recordId: created.ref.id, expectedRevision: 1 });
  } });
  await policy(second.spaceId, 1);
  await generation(second.spaceId, 1, 1, identity(recordSpy));
  created = await write(second.scope, 'create', JSON.stringify({ title: words }));
  const projector = new RecordRetrievalProjector(pool, { embedders: new EmbeddingRegistry([recordSpy]) });
  const [outcome] = await deliver(await hints(), projector);
  assert.equal(recordSpy.inTransaction.length, 1, 'no call for revision 1 after revision 2 committed');
  assert.equal(outcome, 'retry');
  assert.equal((await pool.query('SELECT max(failures)::int AS n FROM projection_outbox WHERE space_id=$1', [second.spaceId])).rows[0].n, 0);
  assert.deepEqual((await deliver(await hints(), projector)).sort(), ['applied', 'superseded']);
  assert.deepEqual((await projected(second.spaceId, 'record', created.ref.id)).lexical, [[1, 2, '/title', 'Short']]);
});

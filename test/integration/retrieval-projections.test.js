import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresClaims, PostgresSources, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

// STA-44 storage only: no service writes projections yet, so projection
// fixtures use SQL; enqueueing is observed through the real evidence services.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const names = ['retrieval', 'retrieval_upgrade'].map(kind => `stateplane_${kind}_${randomUUID().replaceAll('-', '')}`);
const urlFor = name => { const url = new URL(baseUrl); url.pathname = `/${name}`; return url.toString(); };
async function admin(sql) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}
const dropDatabases = () => Promise.all(names.map(name => admin(`DROP DATABASE IF EXISTS ${name}`)));
const migrate = (name, env = {}) => spawnSync(process.execPath, ['scripts/migrate.mjs'],
  { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8' });
try {
  for (const name of names) await admin(`CREATE DATABASE ${name}`);
  execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(names[0]) }, stdio: 'ignore' });
} catch (error) { await dropDatabases(); throw error; }
const pool = new pg.Pool({ connectionString: urlFor(names[0]), max: 6 });
test.after(async () => { await pool.end(); await dropDatabases(); });

const digest = value => createHash('sha256').update(value).digest('hex');
const refused = (code, constraint) => error => {
  assert.equal(error.code, code, error.message);
  if (constraint) assert.equal(error.constraint, constraint, error.message);
  return true;
};
const check = constraint => refused('23514', constraint);
const missing = refused('23503');
const vector = (dimensions, seed = 1) => `[${Array.from({ length: dimensions }, (_, i) => Math.sin(seed * 31 + i * 7) || 0.5).join(',')}]`;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** A space with collections alpha and beta, a record in each, a source with an extraction and a claim in alpha. */
async function space() {
  const spaceId = `sp_${randomUUID()}`;
  await inTransaction(async db => {
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    for (const collectionId of ['alpha', 'beta']) {
      await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
      await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,$2,'rec_1',1,1,'generated','rec_1','{"title":"bridge"}','{"title":"bridge"}'::jsonb)`, [spaceId, collectionId]);
    }
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,'alpha','source','src_1'),($1,'alpha','claim','clm_1')`,
      [spaceId]);
    await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
      VALUES($1,'alpha','src_1','https://example.invalid/report','owner','owner-session')`, [spaceId]);
    await db.query(`INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,object_key)
      VALUES($1,'alpha','src_1',false,$2,14,'text/plain',clock_timestamp()-interval '1 minute','originals/src_1')`, [spaceId, digest('original bytes')]);
    await db.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,source_sha256,parser,parser_version,content,credential_id)
      VALUES($1,'alpha','src_1',1,$2,'text','1','The bridge opened in 1932.','owner-session')`, [spaceId, digest('original bytes')]);
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id) VALUES($1,'alpha','clm_1','owner','owner-session')`,
      [spaceId]);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES($1,'alpha','clm_1',1,'The bridge opened in 1932.','principal:owner','owner-session','owner')`, [spaceId]);
  });
  return spaceId;
}

/** Insert the next retrieval policy version of a collection. */
async function policy(spaceId, collectionId, version, fields = {}, db = pool) {
  const p = { recordFields: ['/title'], sourceContent: true, claimStatements: true, lexical: true, vector: true,
    textSearchConfig: 'english', regions: ['apac'], ...fields };
  await db.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
      lexical,vector,text_search_config,processing_regions,credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'owner-session')`,
  [spaceId, collectionId, version, p.recordFields, p.sourceContent, p.claimStatements, p.lexical, p.vector, p.textSearchConfig, p.regions]);
}
const embedder = ['local-test', 'hash-embedder', '1', 384];
async function generation(spaceId, collectionId, number, policyVersion, vectorEmbedder = embedder, db = pool) {
  const [name, model, version, dimensions] = vectorEmbedder ?? [null, null, null, null];
  await db.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,model_version,dimensions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [spaceId, collectionId, number, policyVersion, name, model, version, dimensions]);
}
const moveGeneration = (spaceId, collectionId, number, state, db = pool) => db.query(`UPDATE projection_generations SET state=$4
  WHERE space_id=$1 AND collection_id=$2 AND generation=$3 RETURNING *`, [spaceId, collectionId, number, state]);
async function projectRef(spaceId, number, kind, id, revision, extractionVersion = null, db = pool) {
  await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version)
    VALUES($1,'alpha',$2,$3,$4,$5,$6)`, [spaceId, number, kind, id, revision, extractionVersion]);
}
async function lexical(spaceId, number, kind, id, revision, { chunk = 0, field = kind === 'record' ? '/title' : null,
  extractionVersion = kind === 'source' ? 1 : null, content = 'The bridge opened in 1932.', start = 0, policyVersion = 1,
  sourceRange = null, tsv = null, db = pool } = {}) {
  await db.query(`INSERT INTO lexical_chunks(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version,policy_version,
      chunk_index,field,content_start,content_end,source_start,source_end,content${tsv ? ',tsv' : ''})
    VALUES($1,'alpha',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14${tsv ? ',$15::tsvector' : ''})`,
  [spaceId, number, kind, id, revision, extractionVersion, policyVersion, chunk, field, start, start + [...content].length,
    sourceRange?.[0] ?? null, sourceRange?.[1] ?? null, content, ...(tsv ? [tsv] : [])]);
}
async function vectorChunk(spaceId, number, kind, id, revision, { chunk = 0, field = kind === 'record' ? '/title' : null,
  extractionVersion = kind === 'source' ? 1 : null, values = vector(384), region = 'apac', model = embedder, policyVersion = 1,
  table = 'vector_chunks', db = pool } = {}) {
  const [name, modelName, version, dimensions] = model;
  if (table === 'embedding_checkpoints') {
    await db.query(`INSERT INTO embedding_checkpoints(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version,chunk_index,
        content_sha256,embedder,embedding_model,model_version,dimensions,processing_region,embedding)
      VALUES($1,'alpha',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector)`,
    [spaceId, number, kind, id, revision, extractionVersion, chunk, digest('chunk'), name, modelName, version, dimensions, region, values]);
    return;
  }
  await db.query(`INSERT INTO vector_chunks(space_id,collection_id,generation,ref_kind,ref_id,revision,extraction_version,policy_version,
      chunk_index,field,content_start,content_end,content_sha256,embedder,embedding_model,model_version,dimensions,processing_region,embedding)
    VALUES($1,'alpha',$2,$3,$4,$5,$6,$7,$8,$9,0,26,$10,$11,$12,$13,$14,$15,$16::vector)`,
  [spaceId, number, kind, id, revision, extractionVersion, policyVersion, chunk, field, digest('chunk'), name, modelName, version,
    dimensions, region, values]);
}
const work = async spaceId => (await pool.query(`SELECT ref_kind,ref_id,revision,extraction_version,operation,placement_generation,delivery_state
  FROM retrieval_outbox WHERE space_id=$1 ORDER BY enqueued_at,job_id`, [spaceId])).rows
  .map(row => ({ ...row, revision: Number(row.revision), extraction_version: row.extraction_version && Number(row.extraction_version),
    placement_generation: Number(row.placement_generation) }));

/** Just enough of an R2 binding for text ingestion. */
class MemoryR2 {
  objects = new Map();
  async put(key, body, options = {}) {
    const chunks = [];
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    const bytes = Buffer.concat(chunks);
    if (options.sha256 !== undefined && options.sha256 !== digest(bytes)) throw new Error('put: checksum mismatch');
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
const authConfig = { database: memoryAdapter(), namespace: `sta44-${randomUUID()}`, plugins: [] };
createAuthFn(authConfig);
const identity = new AuthFnIdentityVerifier(authConfig);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });
const spacesFor = cellPool => new PostgresSpaces(pool, new Map([['cell-a', { pool: cellPool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(authConfig), identity, randomBytes(32));
async function owner() {
  const user = await createUser(authConfig, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  return verify((await issueSession(authConfig, {}, { userId: user.id, methods: ['password'] })).sessionToken);
}

test('source extraction and claim create, revise, review and deletion enqueue retrieval work with the authoritative write', async () => {
  const actor = await owner();
  const spaces = spacesFor(pool);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(actor, 'cell-a', spaceId);
  await postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600)
    .collections.define(actor, spaceId, 'alpha', definition('alpha'));
  const sources = new PostgresSources(spaces, new Map([['cell-a', { pool, originals: new R2BlobStore(new MemoryR2()) }]]));
  const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
  const { sourceId } = await sources.ingestText(actor, spaceId, 'alpha', { idempotencyKey: 'src', text: 'The bridge opened in 1932.' });
  assert.deepEqual(await work(spaceId), [], 'a source without an extraction has nothing to project');
  await sources.extract(actor, spaceId, 'alpha', sourceId);
  const placement = Number((await pool.query('SELECT placement_generation FROM spaces WHERE space_id=$1', [spaceId])).rows[0].placement_generation);
  const upsert = (kind, id, revision, extraction = null) => ({ ref_kind: kind, ref_id: id, revision, extraction_version: extraction,
    operation: 'upsert', placement_generation: placement, delivery_state: 'pending' });
  assert.deepEqual(await work(spaceId), [upsert('source', sourceId, 1, 1)]);

  const created = await claims.create(actor, spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The bridge opened in 1932.',
    attributedTo: 'city archive', evidence: [{ collectionId: 'alpha', sourceId, extractionVersion: 1, start: 4, end: 10 }] });
  // A replayed create is not a second write and enqueues nothing.
  await claims.create(actor, spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The bridge opened in 1932.',
    attributedTo: 'city archive', evidence: [{ collectionId: 'alpha', sourceId, extractionVersion: 1, start: 4, end: 10 }] });
  await claims.revise(actor, spaceId, 'alpha', created.claimId, { baseRevision: 1, statement: 'The bridge opened in 1933.',
    attributedTo: 'city archive' });
  await claims.review(actor, spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' });
  await claims.delete(actor, spaceId, 'alpha', created.claimId, { baseRevision: 3 });
  await sources.delete(actor, spaceId, 'alpha', sourceId);
  assert.deepEqual(await work(spaceId), [upsert('source', sourceId, 1, 1), upsert('claim', created.claimId, 1),
    upsert('claim', created.claimId, 2), upsert('claim', created.claimId, 3),
    { ...upsert('claim', created.claimId, 3), operation: 'delete' }, { ...upsert('source', sourceId, 1), operation: 'delete' }]);

  // The work is part of the authoritative write: visible inside it, and gone with its rollback.
  const sql = await space();
  const before = await work(sql);
  await assert.rejects(inTransaction(async db => {
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES($1,'alpha','clm_1',2,'Revised.','principal:owner','owner-session','owner')`, [sql]);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM retrieval_outbox WHERE space_id=$1 AND ref_id='clm_1' AND revision=2`, [sql]))
      .rows[0].n, 1);
    throw new Error('abort the write');
  }), /abort the write/);
  assert.deepEqual(await work(sql), before);
  // Only delivery changes, delivery is final, and work is never removed outside erasure.
  await assert.rejects(pool.query(`UPDATE retrieval_outbox SET revision=9 WHERE space_id=$1`, [sql]), check('retrieval_outbox_transition'));
  await pool.query(`UPDATE retrieval_outbox SET attempts=1,last_error='embedder unavailable',available_at=clock_timestamp()+interval '5 seconds'
    WHERE space_id=$1 AND ref_kind='claim'`, [sql]);
  await pool.query(`UPDATE retrieval_outbox SET delivery_state='delivered',delivered_at=clock_timestamp() WHERE space_id=$1 AND ref_kind='claim'`, [sql]);
  await assert.rejects(pool.query(`UPDATE retrieval_outbox SET delivery_state='pending',delivered_at=NULL WHERE space_id=$1 AND ref_kind='claim'`,
    [sql]), check('retrieval_outbox_transition'));
  await assert.rejects(pool.query('DELETE FROM retrieval_outbox WHERE space_id=$1', [sql]), check('retrieval_outbox_immutable'));
});

test('retrieval policies are immutable gapless versions of valid configured content and regions', async () => {
  const spaceId = await space();
  await assert.rejects(policy(spaceId, 'alpha', 2), missing, 'versions start at 1 without gaps');
  await policy(spaceId, 'alpha', 1);
  await assert.rejects(policy(spaceId, 'alpha', 2, { recordFields: ['title'] }), check(), 'record fields are JSON Pointers');
  await assert.rejects(policy(spaceId, 'alpha', 2, { recordFields: ['/a', '/a'] }), check(), 'each field once');
  await assert.rejects(policy(spaceId, 'alpha', 2, { recordFields: Array.from({ length: 33 }, (_, i) => `/f${i}`) }), check());
  await assert.rejects(policy(spaceId, 'alpha', 2, { regions: [] }), check(), 'vectors need a processing region');
  await assert.rejects(policy(spaceId, 'alpha', 2, { regions: ['APAC'] }), check());
  await assert.rejects(policy(spaceId, 'alpha', 2, { textSearchConfig: 'klingon' }), check('retrieval_policies_text_search_config'));
  await policy(spaceId, 'alpha', 2, { vector: false, regions: [], recordFields: [] });
  await assert.rejects(pool.query(`UPDATE retrieval_policies SET vector=true WHERE space_id=$1`, [spaceId]), check('retrieval_policies_immutable'));
  await assert.rejects(pool.query(`DELETE FROM retrieval_policies WHERE space_id=$1`, [spaceId]), check('retrieval_policies_immutable'));
  await assert.rejects(pool.query('TRUNCATE retrieval_policies CASCADE'), check());
});

test('generations start under the current policy and move forward one state at a time, one active at once', async () => {
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1);
  await assert.rejects(generation(spaceId, 'alpha', 1, 1, null), check('projection_generations_policy'), 'a vector policy needs an embedder');
  await assert.rejects(generation(spaceId, 'alpha', 1, 1, ['local-test', 'hash-embedder', '1', 512]), missing,
    'an embedding dimension without a recorded ANN strategy');
  await generation(spaceId, 'alpha', 1, 1);
  await assert.rejects(generation(spaceId, 'alpha', 2, 1), refused('23505'), 'one generation is built at a time');
  for (const state of ['active', 'building']) await assert.rejects(moveGeneration(spaceId, 'alpha', 1, state), check('projection_generations_transition'));
  const verifying = (await moveGeneration(spaceId, 'alpha', 1, 'verifying')).rows[0];
  assert.ok(verifying.verifying_at && !verifying.activated_at);
  await assert.rejects(pool.query(`UPDATE projection_generations SET activated_at=clock_timestamp() WHERE space_id=$1`, [spaceId]),
    check('projection_generations_transition'), 'times are stamped by transitions only');
  const active = (await moveGeneration(spaceId, 'alpha', 1, 'active')).rows[0];
  assert.ok(active.activated_at >= active.verifying_at);

  await policy(spaceId, 'alpha', 2, { vector: false, regions: [] });
  await assert.rejects(generation(spaceId, 'alpha', 2, 1), check('projection_generations_policy'), 'only the current policy');
  await assert.rejects(generation(spaceId, 'alpha', 2, 2), check('projection_generations_policy'), 'no embedder without vectors');
  await assert.rejects(generation(spaceId, 'alpha', 1, 2, null), check('projection_generations_order'));
  await generation(spaceId, 'alpha', 2, 2, null);
  await moveGeneration(spaceId, 'alpha', 2, 'verifying');
  await assert.rejects(moveGeneration(spaceId, 'alpha', 2, 'active'), refused('23505'), 'retire the active generation first');
  // Cutover in one transaction: retire the old generation, then activate the new one.
  await inTransaction(async db => {
    await moveGeneration(spaceId, 'alpha', 1, 'retired', db);
    await moveGeneration(spaceId, 'alpha', 2, 'active', db);
  });
  await assert.rejects(moveGeneration(spaceId, 'alpha', 1, 'active'), check('projection_generations_transition'), 'retired is final');
  await generation(spaceId, 'alpha', 3, 2, null);
  await moveGeneration(spaceId, 'alpha', 3, 'retired');
  await assert.rejects(pool.query('DELETE FROM projection_generations WHERE space_id=$1', [spaceId]), check('projection_generations_immutable'));
});

test('chunks carry their Ref, revision, generation, offsets, policy and embedder, for configured live content only', async () => {
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1, { claimStatements: false });
  await generation(spaceId, 'alpha', 1, 1);
  // No chunk before its Ref is projected at that revision.
  await assert.rejects(lexical(spaceId, 1, 'record', 'rec_1', 1), missing);
  await projectRef(spaceId, 1, 'record', 'rec_1', 1);
  await projectRef(spaceId, 1, 'source', 'src_1', 1, 1);
  await projectRef(spaceId, 1, 'claim', 'clm_1', 1);
  await assert.rejects(lexical(spaceId, 1, 'record', 'rec_1', 2), missing, 'another revision than projected');
  await assert.rejects(lexical(spaceId, 1, 'source', 'src_1', 1, { extractionVersion: 2 }), missing, 'another extraction than projected');
  await assert.rejects(lexical(spaceId, 1, 'record', 'rec_1', 1, { field: '/body' }), check('lexical_chunks_configured'));
  await assert.rejects(lexical(spaceId, 1, 'claim', 'clm_1', 1), check('lexical_chunks_configured'), 'claim statements are not configured');
  await assert.rejects(lexical(spaceId, 1, 'record', 'rec_1', 1, { policyVersion: 2 }), missing);
  // Offsets name exactly the chunk's content; source offsets belong to sources.
  await assert.rejects(pool.query(`INSERT INTO lexical_chunks(space_id,collection_id,generation,ref_kind,ref_id,revision,policy_version,chunk_index,
    field,content_start,content_end,content) VALUES($1,'alpha',1,'record','rec_1',1,1,0,'/title',0,3,'bridge')`, [spaceId]), check());
  await assert.rejects(lexical(spaceId, 1, 'record', 'rec_1', 1, { sourceRange: [0, 6] }), check());
  // The stored tsvector is derived from the content with the policy's configuration, whatever the writer sends.
  await lexical(spaceId, 1, 'record', 'rec_1', 1, { content: 'bridges', tsv: 'forged' });
  await lexical(spaceId, 1, 'source', 'src_1', 1, { chunk: 0, sourceRange: [0, 26] });
  assert.deepEqual((await pool.query(`SELECT ref_kind,tsv::text,content_start,content_end,source_start,source_end,policy_version,
      revision,extraction_version,generation FROM lexical_chunks WHERE space_id=$1 ORDER BY ref_kind`, [spaceId])).rows.map(row => ({ ...row })), [
    { ref_kind: 'record', tsv: "'bridg':1", content_start: '0', content_end: '7', source_start: null, source_end: null, policy_version: '1',
      revision: '1', extraction_version: null, generation: '1' },
    { ref_kind: 'source', tsv: "'1932':5 'bridg':2 'open':3", content_start: '0', content_end: '26', source_start: '0', source_end: '26',
      policy_version: '1', revision: '1', extraction_version: '1', generation: '1' }]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM lexical_chunks WHERE space_id=$1 AND tsv @@ to_tsquery('english','bridge')`,
    [spaceId])).rows[0].n, 2);
  await assert.rejects(pool.query(`UPDATE lexical_chunks SET content='other' WHERE space_id=$1`, [spaceId]), check('lexical_chunks_immutable'));

  // Vector chunks carry their generation's embedder and a region the policy allows.
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 1);
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { region: 'weur' }), check('vector_chunks_region'));
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { values: vector(383) }), check('vector_chunks_dimensions'));
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { model: ['local-test', 'hash-embedder', '2', 384] }), missing);
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { model: ['local-test', 'hash-embedder', '1', 768], values: vector(768) }),
    missing);
  await vectorChunk(spaceId, 1, 'source', 'src_1', 1);
  assert.deepEqual((await pool.query(`SELECT ref_kind,revision::int,extraction_version::int,generation::int,policy_version::int,
      embedder,embedding_model,model_version,dimensions,processing_region,vector_dims(embedding) AS stored
    FROM vector_chunks WHERE space_id=$1 ORDER BY ref_kind`, [spaceId])).rows.map(row => ({ ...row })), [
    { ref_kind: 'record', revision: 1, extraction_version: null, generation: 1, policy_version: 1, embedder: 'local-test',
      embedding_model: 'hash-embedder', model_version: '1', dimensions: 384, processing_region: 'apac', stored: 384 },
    { ref_kind: 'source', revision: 1, extraction_version: 1, generation: 1, policy_version: 1, embedder: 'local-test',
      embedding_model: 'hash-embedder', model_version: '1', dimensions: 384, processing_region: 'apac', stored: 384 }]);
  // Checkpoints obey the same policy, region and dimension rules, and are replaced rather than changed.
  await vectorChunk(spaceId, 1, 'source', 'src_1', 1, { table: 'embedding_checkpoints' });
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { table: 'embedding_checkpoints' }), refused('23505'));
  await assert.rejects(vectorChunk(spaceId, 1, 'claim', 'clm_1', 1, { table: 'embedding_checkpoints' }), check('embedding_checkpoints_configured'));
  await assert.rejects(vectorChunk(spaceId, 1, 'source', 'src_1', 1, { table: 'embedding_checkpoints', chunk: 1, region: 'enam' }),
    check('embedding_checkpoints_region'));
  await assert.rejects(pool.query(`UPDATE embedding_checkpoints SET chunk_index=2 WHERE space_id=$1`, [spaceId]), check('embedding_checkpoints_immutable'));

  // A lexical-only generation takes no vector chunk, and a retired generation takes nothing.
  await moveGeneration(spaceId, 'alpha', 1, 'verifying');
  await moveGeneration(spaceId, 'alpha', 1, 'active');
  await policy(spaceId, 'alpha', 2, { vector: false, regions: [] });
  await generation(spaceId, 'alpha', 2, 2, null);
  await projectRef(spaceId, 2, 'record', 'rec_1', 1);
  await assert.rejects(vectorChunk(spaceId, 2, 'record', 'rec_1', 1, { policyVersion: 2 }), check('vector_chunks_configured'));
  await moveGeneration(spaceId, 'alpha', 2, 'retired');
  await assert.rejects(lexical(spaceId, 2, 'record', 'rec_1', 1, { policyVersion: 2 }), check('projection_generations_retired'));
  await assert.rejects(projectRef(spaceId, 2, 'source', 'src_1', 1, 1), check('projection_generations_retired'));
});

test('a projected Ref only moves forward, and a deletion receipt keeps a deleted Ref out of its generation', async () => {
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1, { vector: false, regions: [] });
  await generation(spaceId, 'alpha', 1, 1, null);
  await assert.rejects(inTransaction(db => projectRef(spaceId, 1, 'record', 'rec_missing', 1, null, db)), missing,
    'a projected Ref names an authoritative Ref');
  await assert.rejects(projectRef(spaceId, 1, 'source', 'src_1', 1), check(), 'a live source names its extraction');
  await projectRef(spaceId, 1, 'source', 'src_1', 1, 1);
  await lexical(spaceId, 1, 'source', 'src_1', 1);
  const advance = (revision, extraction, deleted = false) => pool.query(`UPDATE projection_refs SET revision=$2,extraction_version=$3,deleted=$4
    WHERE space_id=$1 AND ref_kind='source' AND ref_id='src_1'`, [spaceId, revision, extraction, deleted]);
  await assert.rejects(advance(1, 1), check('projection_refs_order'), 'no change is not forward');
  await assert.rejects(advance(2, 1), missing, 'older chunks block advancing their Ref');
  await pool.query(`DELETE FROM lexical_chunks WHERE space_id=$1`, [spaceId]);
  await pool.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,source_sha256,parser,parser_version,content,credential_id)
    VALUES($1,'alpha','src_1',2,$2,'text','2','The bridge opened in 1933.','owner-session')`, [spaceId, digest('original bytes')]);
  await advance(1, 2);
  await assert.rejects(advance(1, 1), check('projection_refs_order'), 'an older extraction never replaces a newer one');
  await assert.rejects(pool.query(`DELETE FROM projection_refs WHERE space_id=$1`, [spaceId]), check('projection_refs_immutable'));

  // A receipt needs the authoritative Ref deleted and no live projection of it.
  const receipt = () => pool.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
    VALUES($1,'alpha',1,'source','src_1',1,1)`, [spaceId]);
  await assert.rejects(receipt(), check('projection_deletion_receipts_live'));
  await advance(1, 2, true);
  await assert.rejects(receipt(), check('projection_deletion_receipts_authority'));
  await pool.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='source' AND entity_id='src_1'`, [spaceId]);
  await receipt();
  await assert.rejects(advance(2, 2, true), check('projection_refs_order'), 'a deleted Ref stays deleted');
  await assert.rejects(advance(2, 2), check('projection_refs_deleted'), 'and cannot become live again');
  await assert.rejects(pool.query(`UPDATE projection_deletion_receipts SET revision=2 WHERE space_id=$1`, [spaceId]),
    check('projection_deletion_receipts_immutable'));
  // A rebuilt generation cannot project a Ref deleted before it was built either.
  await pool.query(`UPDATE records SET tombstone=true,revision=2 WHERE space_id=$1 AND collection_id='alpha' AND record_id='rec_1'`, [spaceId]);
  await pool.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
    VALUES($1,'alpha',1,'record','rec_1',2,0)`, [spaceId]);
  await assert.rejects(projectRef(spaceId, 1, 'record', 'rec_1', 1), check('projection_refs_deleted'));
});

test('each recorded HNSW dimension has a partial expression index that a filtered nearest-neighbour query uses', async () => {
  const strategies = (await pool.query('SELECT dimensions,method,index_name,hnsw_m,hnsw_ef_construction FROM vector_index_strategies ORDER BY dimensions')).rows;
  assert.deepEqual(strategies.map(row => [row.dimensions, row.method]), [[384, 'hnsw'], [768, 'hnsw'], [1024, 'hnsw'], [1536, 'hnsw'], [3072, 'exact']]);
  const indexes = new Map((await pool.query(`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='vector_chunks'`)).rows
    .map(row => [row.indexname, row.indexdef]));
  for (const { dimensions, index_name: name, hnsw_m: m, hnsw_ef_construction: ef } of strategies.filter(row => row.method === 'hnsw'))
    assert.match(indexes.get(name) ?? '', new RegExp(`USING hnsw \\(\\(\\(embedding\\)::vector\\(${dimensions}\\)\\) vector_cosine_ops\\) `
      + `WITH \\(m='${m}', ef_construction='${ef}'\\) WHERE \\(dimensions = ${dimensions}\\)`), name);
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1);
  await generation(spaceId, 'alpha', 1, 1);
  await inTransaction(async db => {
    for (let n = 0; n < 200; n++) {
      await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,'alpha',$2,1,1,'generated',$2,'{}','{}'::jsonb)`, [spaceId, `rec_v${n}`]);
      await projectRef(spaceId, 1, 'record', `rec_v${n}`, 1, null, db);
      await vectorChunk(spaceId, 1, 'record', `rec_v${n}`, 1, { values: vector(384, n + 2), db });
    }
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan=off');
    // A query with the index's cast and predicate can use it.
    const plan = (await client.query(`EXPLAIN SELECT ref_id FROM vector_chunks WHERE dimensions=384
      ORDER BY embedding::vector(384) <=> $1::vector(384) LIMIT 10`, [vector(384, 7)])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /Index Scan using vector_chunks_hnsw_384/);
    // Narrowed to one generation of one collection, the planner reads that generation through its key and ranks it
    // exactly; ANN under filters is not complete recall, so search (STA-46) must not assume either plan.
    const filtered = (await client.query(`EXPLAIN SELECT ref_id FROM vector_chunks
      WHERE dimensions=384 AND space_id=$1 AND collection_id='alpha' AND generation=1
      ORDER BY embedding::vector(384) <=> $2::vector(384) LIMIT 10`, [spaceId, vector(384, 7)])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(filtered, /Index Scan using vector_chunks_(pkey|hnsw_384)/);
    const hits = (await client.query(`SELECT ref_id FROM vector_chunks WHERE dimensions=384 AND space_id=$1 AND collection_id='alpha' AND generation=1
      ORDER BY embedding::vector(384) <=> $2::vector(384) LIMIT 1`, [spaceId, vector(384, 7)])).rows;
    assert.deepEqual(hits, [{ ref_id: 'rec_v5' }], 'the nearest neighbour of a stored embedding is itself');
    // pgvector refuses to HNSW-index a vector above 2,000 dimensions, so 3,072 is recorded as exact.
    await client.query('SAVEPOINT wide');
    await assert.rejects(client.query(`CREATE INDEX probe_hnsw_3072 ON vector_chunks USING hnsw ((embedding::vector(3072)) vector_cosine_ops)
      WHERE dimensions=3072`), /cannot have more than 2000 dimensions for hnsw index/);
    await client.query('ROLLBACK TO SAVEPOINT wide');
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

const retrievalTables = ['retrieval_policies', 'projection_generations', 'projection_refs', 'projection_deletion_receipts', 'lexical_chunks',
  'vector_chunks', 'embedding_checkpoints', 'retrieval_outbox'];
const counts = async spaceId => Object.fromEntries(await Promise.all(retrievalTables.map(async table =>
  [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId])).rows[0].n])));
/** One row in every retrieval table of a space made by `space()`. */
async function populate(spaceId, db = pool) {
  await policy(spaceId, 'alpha', 1, {}, db);
  await generation(spaceId, 'alpha', 1, 1, embedder, db);
  await projectRef(spaceId, 1, 'record', 'rec_1', 1, null, db);
  await lexical(spaceId, 1, 'record', 'rec_1', 1, { db });
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { db });
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 2, { table: 'embedding_checkpoints', db });
  await db.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='claim' AND entity_id='clm_1'`, [spaceId]);
  await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
    VALUES($1,'alpha',1,'claim','clm_1',1,0)`, [spaceId]);
}

test('space erasure removes every retrieval row of that space only', async () => {
  const erased = await space();
  const kept = await space();
  await populate(erased);
  await populate(kept);
  const keptBefore = await counts(kept);
  assert.ok(Object.values(keptBefore).every(n => n > 0), JSON.stringify(keptBefore));
  await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [erased]);
  await pool.query('SELECT stateplane_purge_space($1)', [erased]);
  assert.deepEqual(await counts(erased), Object.fromEntries(retrievalTables.map(table => [table, 0])));
  assert.deepEqual(await counts(kept), keptBefore);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vector_index_strategies')).rows[0].n, 5, 'cell strategies are not space data');
});

test('a nonowner cell role writes projections and proves erasure only with the retrieval grants', async () => {
  const actor = await owner();
  const { spaceId } = await spacesFor(pool).create(actor);
  await inTransaction(async db => {
    for (const collectionId of ['alpha', 'beta']) {
      await db.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, collectionId]);
      await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,1,'{}')`,
        [spaceId, collectionId]);
      await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,$2,'rec_1',1,1,'generated','rec_1','{}','{}'::jsonb)`, [spaceId, collectionId]);
    }
  });
  // Stand-in for a pre-045 cell role: every other table and the purge routine, nothing on the retrieval tables,
  // and the hardened runbook's revocation of PUBLIC routine execution.
  const role = `sta44_cell_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: urlFor(names[0]), max: 2, options: `-c role=${role}` });
  // Routines PUBLIC may execute now, so exactly those are granted back afterwards.
  const publicRoutines = (await pool.query(`SELECT p.oid::regprocedure::text AS routine FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`)).rows.map(row => row.routine);
  assert.ok(publicRoutines.includes('vector(vector,integer,boolean)'));
  try {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${[...retrievalTables, 'vector_index_strategies'].join(',')} FROM ${role}`);
    await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await pool.query('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC');
    await pool.query(`GRANT EXECUTE ON FUNCTION stateplane_purge_space(text) TO ${role}`);
    const asRole = async fn => {
      const client = await cellPool.connect();
      try { return await fn(client); } finally { client.release(); }
    };
    await assert.rejects(asRole(db => policy(spaceId, 'alpha', 1, {}, db)), refused('42501'));

    execFileSync(process.execPath, ['scripts/grant-retrieval.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: urlFor(names[0]), STATEPLANE_CELL_ROLE: role } });
    const privileges = Object.fromEntries((await pool.query(`SELECT t, has_table_privilege($1,t,'SELECT') AS r,
        has_table_privilege($1,t,'INSERT') AS i, has_table_privilege($1,t,'UPDATE') AS u, has_table_privilege($1,t,'DELETE') AS d,
        has_table_privilege($1,t,'TRUNCATE') AS x FROM unnest($2::text[]) t`, [role, [...retrievalTables, 'vector_index_strategies']])).rows
      .map(({ t, ...row }) => [t, Object.entries(row).filter(([, granted]) => granted).map(([privilege]) => privilege).join('')]));
    assert.deepEqual(privileges, { retrieval_policies: 'ri', vector_index_strategies: 'r', projection_generations: 'riu', projection_refs: 'riu',
      projection_deletion_receipts: 'ri', lexical_chunks: 'rid', vector_chunks: 'rid', embedding_checkpoints: 'rid', retrieval_outbox: 'ru' });
    // The role builds a generation, including a vector chunk through the HNSW index's dimension cast.
    await asRole(async db => {
      await policy(spaceId, 'alpha', 1, {}, db);
      await generation(spaceId, 'alpha', 1, 1, embedder, db);
      await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision) VALUES($1,'alpha',1,'record','rec_1',1)`,
        [spaceId]);
      await lexical(spaceId, 1, 'record', 'rec_1', 1, { db });
      await vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { db });
      await vectorChunk(spaceId, 1, 'record', 'rec_1', 2, { table: 'embedding_checkpoints', db });
      await db.query(`DELETE FROM embedding_checkpoints WHERE space_id=$1`, [spaceId]);
      await moveGeneration(spaceId, 'alpha', 1, 'verifying', db);
      await assert.rejects(db.query(`DELETE FROM projection_refs WHERE space_id=$1`, [spaceId]), refused('42501'));
    });
    const spaces = spacesFor(cellPool);
    await spaces.archive(actor, spaceId);
    await spaces.delete(actor, spaceId);
    assert.deepEqual(await counts(spaceId), Object.fromEntries(retrievalTables.map(table => [table, 0])));
    assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
  } finally {
    await cellPool.end();
    for (const routine of publicRoutines) await pool.query(`GRANT EXECUTE ON ROUTINE ${routine} TO PUBLIC`);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

test('the erasure report waits for retrieval rows that outlive a purge', async () => {
  const actor = await owner();
  const spaces = spacesFor(pool);
  const { spaceId } = await spaces.create(actor);
  await spaces.archive(actor, spaceId);
  await spaces.delete(actor, spaceId);
  assert.equal((await spaces.erasure(actor, spaceId)).database, 'erased');
  // A row the purge missed, inserted as the owner would restore one, keeps the database pending.
  await inTransaction(async db => {
    await db.query("SELECT set_config('session_replication_role','replica',true)");
    await db.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,credential_id) VALUES($1,'gone',1,'owner-session')`, [spaceId]);
  });
  assert.equal((await spaces.erasure(actor, spaceId)).database, 'pending');
  await inTransaction(async db => {
    await db.query("SELECT set_config('session_replication_role','replica',true)");
    await db.query('DELETE FROM retrieval_policies WHERE space_id=$1', [spaceId]);
  });
});

test('migration 045 rolls back atomically while a claim writer holds its lock, then applies and enqueues existing evidence', { timeout: 60000 }, async () => {
  const name = names[1];
  const files = (await readdir(new URL('../../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  const target = files.indexOf('045_retrieval_projections.sql');
  assert.ok(target > 0, 'migration 045 exists');
  const db = new pg.Client({ connectionString: urlFor(name) });
  const writer = new pg.Client({ connectionString: urlFor(name) });
  await db.connect();
  await writer.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE TABLE stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files.slice(0, target)) {
      const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)', [file, digest(sql)]);
    }
    await db.query('COMMIT');
    // Evidence written before 045: a source with two extractions, a claim at revision 2 and a deleted claim.
    await db.query('BEGIN');
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,placement_generation)
      VALUES('sp_upgrade','owner','cell-a','cell-a','target-a',3)`);
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_upgrade','entries')`);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('sp_upgrade','entries',1,'{}')`);
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id,revision) VALUES('sp_upgrade','entries','source','src_1',1),
      ('sp_upgrade','entries','claim','clm_live',2),('sp_upgrade','entries','claim','clm_gone',1)`);
    await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
      VALUES('sp_upgrade','entries','src_1','https://example.invalid/upgrade','owner','owner-session')`);
    await db.query(`INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,object_key)
      VALUES('sp_upgrade','entries','src_1',false,$1,14,'text/plain',clock_timestamp()-interval '1 minute','originals/upgrade')`, [digest('original bytes')]);
    for (const version of [1, 2]) await db.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,source_sha256,parser,
      parser_version,content,credential_id) VALUES('sp_upgrade','entries','src_1',$1,$2,'text','1','Version text.','owner-session')`,
    [version, digest('original bytes')]);
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id)
      VALUES('sp_upgrade','entries','clm_live','owner','owner-session'),('sp_upgrade','entries','clm_gone','owner','owner-session')`);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES('sp_upgrade','entries','clm_live',1,'First.','principal:owner','owner-session','owner'),
        ('sp_upgrade','entries','clm_live',2,'Second.','principal:owner','owner-session','owner'),
        ('sp_upgrade','entries','clm_gone',1,'Gone.','principal:owner','owner-session','owner')`);
    await db.query('COMMIT');
    await db.query(`UPDATE entity_refs SET tombstone=true WHERE space_id='sp_upgrade' AND entity_id='clm_gone'`);
    const purgeBefore = (await db.query(`SELECT prosrc FROM pg_proc WHERE proname='stateplane_purge_space'`)).rows[0].prosrc;

    // An in-flight claim writer holds the table lock 045 needs: nothing of 045 is left behind.
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES('sp_upgrade','entries','clm_live',3,'Uncommitted.','principal:owner','owner-session','owner')`);
    const blocked = migrate(name);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Retrieval projection upgrade waits for record, extraction and claim writers/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stateplane_migrations WHERE name='045_retrieval_projections.sql'`)).rows[0].n, 0);
    assert.deepEqual((await db.query(`SELECT to_regclass('public.retrieval_outbox') AS outbox, to_regclass('public.vector_chunks') AS vectors,
      to_regclass('public.retrieval_policies') AS policies`)).rows[0], { outbox: null, vectors: null, policies: null });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN
      ('extraction_versions_retrieval','claim_revisions_retrieval','entity_refs_retrieval')`)).rows[0].n, 0);
    assert.equal((await db.query(`SELECT prosrc FROM pg_proc WHERE proname='stateplane_purge_space'`)).rows[0].prosrc, purgeBefore);
    await writer.query('ROLLBACK');

    const applied = migrate(name);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied 045_retrieval_projections.sql/);
    // Each live source's latest extraction and each live claim's current revision are enqueued once.
    assert.deepEqual((await db.query(`SELECT ref_kind,ref_id,revision::int,extraction_version::int,operation,placement_generation::int
      FROM retrieval_outbox ORDER BY ref_kind,ref_id`)).rows.map(row => ({ ...row })), [
      { ref_kind: 'claim', ref_id: 'clm_live', revision: 2, extraction_version: null, operation: 'upsert', placement_generation: 3 },
      { ref_kind: 'source', ref_id: 'src_1', revision: 1, extraction_version: 2, operation: 'upsert', placement_generation: 3 }]);
    // Upgraded and fresh schemas carry the same constraints and indexes.
    const schema = async client => ({
      constraints: (await client.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
      indexes: (await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)).rows,
      triggers: (await client.query(`SELECT tgrelid::regclass::text AS relation,tgname FROM pg_trigger WHERE NOT tgisinternal
        ORDER BY relation,tgname`)).rows });
    const fresh = await pool.connect();
    try { assert.deepEqual(await schema(db), await schema(fresh)); } finally { fresh.release(); }
    assert.equal(migrate(name).status, 0, 'a recorded 045 is skipped');
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([db.end(), writer.end()]);
  }
});

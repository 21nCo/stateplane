import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresClaims, PostgresSources, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

// STA-44 storage only: no service writes projections yet, so projection
// fixtures use SQL; enqueueing is observed through the real evidence services.
// A database for these tests and one for the upgrade test, both dropped afterwards.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const urlFor = name => Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const [testDatabase, upgradeDatabase] = ['retrieval', 'retrieval_upgrade'].map(kind => `stateplane_${kind}_${randomUUID().replaceAll('-', '')}`);
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
};
const dropDatabases = () => Promise.all([testDatabase, upgradeDatabase].map(name => admin(`DROP DATABASE IF EXISTS ${name}`)));
const migrate = (name, env = {}) => spawnSync(process.execPath, ['scripts/migrate.mjs'],
  { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env }, encoding: 'utf8' });
try {
  await Promise.all([testDatabase, upgradeDatabase].map(name => admin(`CREATE DATABASE ${name}`)));
  assert.equal(migrate(testDatabase).status, 0);
} catch (error) { await dropDatabases(); throw error; }
const pool = new pg.Pool({ connectionString: urlFor(testDatabase), max: 6 });
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
  async put(key, body, { sha256 } = {}) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    if (sha256 !== undefined && sha256 !== digest(bytes)) throw new Error('put: checksum mismatch');
    this.objects.set(key, { bytes, sha256 });
    return this.head(key);
  }
  async head(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.length, checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} };
  }
  async get(key) {
    const meta = await this.head(key);
    return meta && { ...meta, body: new Blob([this.objects.get(key).bytes]).stream() };
  }
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
  // A corrected extraction is a new extraction version; replaying the correction enqueues nothing.
  const correction = { baseVersion: 1, content: 'The bridge opened in 1933.', sourceOffsets: [{ start: 0, end: 26, sourceStart: 0, sourceEnd: 26 }] };
  assert.equal((await sources.correctExtraction(actor, spaceId, 'alpha', sourceId, correction)).version, 2);
  assert.equal((await sources.correctExtraction(actor, spaceId, 'alpha', sourceId, correction)).replayed, true);
  await sources.delete(actor, spaceId, 'alpha', sourceId);
  assert.deepEqual(await work(spaceId), [upsert('source', sourceId, 1, 1), upsert('claim', created.claimId, 1),
    upsert('claim', created.claimId, 2), upsert('claim', created.claimId, 3),
    { ...upsert('claim', created.claimId, 3), operation: 'delete' }, upsert('source', sourceId, 1, 2),
    { ...upsert('source', sourceId, 1), operation: 'delete' }]);

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

/** Publish policy versions of collection alpha in one multirow INSERT, in the given order: [version, regions] each. */
async function publishAll(spaceId, versions, db = pool) {
  const rows = versions.map((_, i) => `($1,'alpha',$${2 * i + 2}::bigint,'{/title}',true,$${2 * i + 3}::text[],'owner-session')`);
  await db.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,vector,processing_regions,credential_id)
    VALUES ${rows.join(',')}`, [spaceId, ...versions.flat()]);
}
const headPolicy = async spaceId => (await pool.query(`SELECT policy_version::int AS version FROM retrieval_collection_heads
  WHERE space_id=$1 AND collection_id='alpha'`, [spaceId])).rows[0]?.version ?? null;

test('policy versions are published in order, so the collection head names the highest version whatever the statement', async () => {
  const spaceId = await space();
  await assert.rejects(publishAll(spaceId, [[2, ['apac']], [1, ['apac']]]), check('retrieval_policies_order'), 'version 2 before 1');
  assert.equal(await headPolicy(spaceId), null);
  await publishAll(spaceId, [[1, ['apac', 'weur']]]);
  await generation(spaceId, 'alpha', 1, 1);
  await projectRef(spaceId, 1, 'record', 'rec_1', 1);
  // The self-referencing key alone is checked at statement end, so it would accept 3 before 2 and leave 2 as the head.
  await assert.rejects(publishAll(spaceId, [[3, ['apac']], [2, ['apac', 'weur']]]), check('retrieval_policies_order'), 'versions 3 then 2');
  assert.equal(await headPolicy(spaceId), 1);
  await publishAll(spaceId, [[2, ['apac', 'weur']], [3, ['apac']]]);
  assert.equal(await headPolicy(spaceId), 3);
  await assert.rejects(vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { region: 'weur' }), check('vector_chunks_region'));
  await assert.rejects(vectorChunk(spaceId, 1, 'record', 'rec_1', 2, { table: 'embedding_checkpoints', region: 'weur' }),
    check('embedding_checkpoints_region'));
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 1);
  await moveGeneration(spaceId, 'alpha', 1, 'retired');
  await assert.rejects(generation(spaceId, 'alpha', 2, 2), check('projection_generations_policy'), 'a superseded policy');
  await generation(spaceId, 'alpha', 2, 3);
});

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  test(`under ${isolation}, concurrent policy publications leave the head at the highest version`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1);
    const publish = version => db => policy(spaceId, 'alpha', version, {}, db);
    refused('23505')(await race(isolation, { first: publish(2), second: publish(2) }) ?? assert.fail('a version was published twice'));
    const stale = await race(isolation, { first: publish(3), second: publish(4), committed: true });
    if (isolation === 'READ COMMITTED') assert.equal(stale, null, stale?.message);
    // Its snapshot cannot see its predecessor, so the predecessor key refuses it before it reaches the head.
    else missing(stale ?? assert.fail('a publication from a stale snapshot committed'));
    assert.equal(await headPolicy(spaceId), isolation === 'READ COMMITTED' ? 4 : 3);
  });
}

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

test('a vector chunk or checkpoint is processed in a region both its generation policy and the current policy allow', async () => {
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1, { regions: ['apac', 'weur'] });
  await generation(spaceId, 'alpha', 1, 1);
  for (const state of ['verifying', 'active']) await moveGeneration(spaceId, 'alpha', 1, state);
  await projectRef(spaceId, 1, 'record', 'rec_1', 1);
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { region: 'weur' });
  // Policy 2 drops weur and adds eus. The active generation, built under policy 1, keeps only what both allow.
  await policy(spaceId, 'alpha', 2, { regions: ['apac', 'eus'] });
  await assert.rejects(vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { chunk: 1, region: 'weur' }), check('vector_chunks_region'));
  await assert.rejects(vectorChunk(spaceId, 1, 'record', 'rec_1', 2, { table: 'embedding_checkpoints', region: 'weur' }),
    check('embedding_checkpoints_region'));
  await assert.rejects(vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { chunk: 1, region: 'eus' }), check('vector_chunks_region'));
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { chunk: 1 });
  await vectorChunk(spaceId, 1, 'record', 'rec_1', 2, { table: 'embedding_checkpoints' });
});

/**
 * Race two transactions: `waiter` takes its snapshot, `holder` writes, and the waiter then writes `second`. Unless
 * `committed`, the holder stays open until the waiter waits on its lock, then runs `then` and commits. Returns the
 * waiter's error, or null after committing it.
 */
async function race(isolation, { first, then = async () => {}, second, committed = false }) {
  const holder = await pool.connect();
  const waiter = await pool.connect();
  try {
    await waiter.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await waiter.query('SELECT count(*) FROM retrieval_collection_heads');
    await holder.query('BEGIN');
    await first(holder);
    if (committed) { await then(holder); await holder.query('COMMIT'); }
    const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writing = second(waiter).then(() => null, error => error);
    if (!committed) { await waitsOnLock(pid); await then(holder); await holder.query('COMMIT'); }
    const error = await writing;
    if (!error) await waiter.query('COMMIT');
    return error;
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await waiter.query('ROLLBACK').catch(() => {});
    holder.release();
    waiter.release();
  }
}
const narrowed = (db, spaceId) => policy(spaceId, 'alpha', 2, { regions: ['apac'] }, db);
const embedIn = (region, table = 'vector_chunks') => (db, spaceId) =>
  vectorChunk(spaceId, 1, 'record', 'rec_1', table === 'vector_chunks' ? 1 : 2, { region, table, db });
const policyRaces = [
  { name: 'a generation numbered below an uncommitted one that then retires', setup: [],
    first: (db, spaceId) => generation(spaceId, 'alpha', 10, 1, embedder, db), then: (db, spaceId) => moveGeneration(spaceId, 'alpha', 10, 'retired', db),
    second: (db, spaceId) => generation(spaceId, 'alpha', 5, 1, embedder, db), constraint: 'projection_generations_order' },
  { name: 'a generation under the policy a concurrent publication replaces', setup: [],
    first: narrowed, second: (db, spaceId) => generation(spaceId, 'alpha', 1, 1, embedder, db), constraint: 'projection_generations_policy' },
  { name: 'a generation under a policy replaced after its snapshot', setup: [], committed: true,
    first: narrowed, second: (db, spaceId) => generation(spaceId, 'alpha', 1, 1, embedder, db), constraint: 'projection_generations_policy' },
  ...['vector_chunks', 'embedding_checkpoints'].flatMap(table => [
    { name: `a ${table} row in a region a concurrent publication removes`, setup: ['generation'],
      first: narrowed, second: embedIn('weur', table), constraint: `${table}_region` },
    { name: `a policy publication removing the region of an in-flight ${table} row`, setup: ['generation'],
      first: embedIn('weur', table), second: narrowed, constraint: null }])];
for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) for (const scenario of policyRaces) {
  test(`under ${isolation}, ${scenario.name} is serialized through the collection head`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1, { regions: ['apac', 'weur'] });
    if (scenario.setup.includes('generation')) {
      await generation(spaceId, 'alpha', 1, 1);
      await projectRef(spaceId, 1, 'record', 'rec_1', 1);
    }
    const error = await race(isolation, { ...scenario, first: db => scenario.first(db, spaceId),
      then: db => (scenario.then ?? (async () => {}))(db, spaceId), second: db => scenario.second(db, spaceId) });
    if (scenario.constraint === null) assert.equal(error, null, 'publishing waits for the embedder and then commits after it');
    else if (isolation === 'READ COMMITTED') refused('23514', scenario.constraint)(error ?? assert.fail('the stale write committed'));
    else assert.equal(error?.code, '40001', error?.message ?? 'the stale write committed');
    const head = (await pool.query(`SELECT policy_version::int AS policy, generation::int AS generation FROM retrieval_collection_heads
      WHERE space_id=$1`, [spaceId])).rows[0];
    const generations = (await pool.query(`SELECT generation::int AS generation, state FROM projection_generations WHERE space_id=$1
      ORDER BY generation`, [spaceId])).rows.map(row => `${row.generation}:${row.state}`);
    if (scenario.constraint === 'projection_generations_order') assert.deepEqual([head, generations], [{ policy: 1, generation: 10 }, ['10:retired']]);
    if (scenario.constraint === 'projection_generations_policy') assert.deepEqual([head, generations], [{ policy: 2, generation: 0 }, []]);
    if (scenario.setup.length) assert.equal(head.policy, 2);
  });
}

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

  // A receipt needs the authoritative Ref deleted and the projected Ref deleted at the receipt's revision.
  const receipt = (kind = 'source', id = 'src_1', revision = 1) => pool.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,
    generation,ref_kind,ref_id,revision,chunks_removed) VALUES($1,'alpha',1,$2,$3,$4,1)`, [spaceId, kind, id, revision]);
  await assert.rejects(receipt(), check('projection_deletion_receipts_authority'));
  await pool.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='source' AND entity_id='src_1'`, [spaceId]);
  await assert.rejects(receipt(), refused('23503', 'projection_deletion_receipts_deleted_ref'), 'a live projected Ref has no receipt');
  // Deleting at the same revision is forward, also when the deletion clears the extraction version.
  await advance(1, null, true);
  await receipt();
  await assert.rejects(advance(2, 2, true), check('projection_refs_order'), 'a deleted Ref stays deleted');
  await assert.rejects(advance(2, 2), check('projection_refs_order'), 'and cannot become live again');
  await assert.rejects(pool.query(`UPDATE projection_deletion_receipts SET revision=2 WHERE space_id=$1`, [spaceId]),
    check('projection_deletion_receipts_immutable'));
  // A Ref deleted before a generation is built is recorded deleted in it, and then cannot be projected there.
  await pool.query(`UPDATE records SET tombstone=true,revision=2 WHERE space_id=$1 AND collection_id='alpha' AND record_id='rec_1'`, [spaceId]);
  await pool.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
    VALUES($1,'alpha',1,'record','rec_1',2,true)`, [spaceId]);
  await assert.rejects(receipt('record', 'rec_1', 1), refused('23503', 'projection_deletion_receipts_deleted_ref'),
    'a receipt names the revision its Ref was deleted at');
  await receipt('record', 'rec_1', 2);
  await assert.rejects(projectRef(spaceId, 1, 'record', 'rec_1', 1), refused('23505', 'projection_refs_pkey'));
});

// Each scenario races a stale transaction against a committed one on one Ref of generation 1. `live` starts the Ref
// projected at extraction 1 with a chunk; otherwise it is not projected yet. The source is already deleted at authority.
const receiptOnly = async (db, spaceId) => db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,
  ref_id,revision,chunks_removed) VALUES($1,'alpha',1,'source','src_1',1,0)`, [spaceId]);
const fenceScenarios = [
  // A receipt is never the only write: it needs the projected Ref's deleted row, which a concurrent apply also writes.
  { name: 'an apply of a Ref new to its snapshot, after a receipt alone', live: false, committed: receiptOnly, committedRefusal: '23503',
    stale: async (db, spaceId) => {
      await projectRef(spaceId, 1, 'source', 'src_1', 1, 1, db);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { db });
    },
    refusal: { 'READ COMMITTED': null, 'REPEATABLE READ': null } },
  { name: 'a receipt alone, after a committed apply of a Ref new to its snapshot', live: false,
    committed: async (db, spaceId) => {
      await projectRef(spaceId, 1, 'source', 'src_1', 1, 1, db);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { db });
    },
    stale: receiptOnly, refusal: { 'READ COMMITTED': '23503', 'REPEATABLE READ': '23503' } },
  { name: 'an apply of a Ref new to its snapshot, after a committed receipt', live: false,
    committed: async (db, spaceId) => {
      await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
        VALUES($1,'alpha',1,'source','src_1',1,true)`, [spaceId]);
      await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
        VALUES($1,'alpha',1,'source','src_1',1,0)`, [spaceId]);
    },
    stale: async (db, spaceId) => {
      await projectRef(spaceId, 1, 'source', 'src_1', 1, 1, db);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { db });
    },
    refusal: { 'READ COMMITTED': '23505', 'REPEATABLE READ': '23505' } },
  { name: 'an apply of a live Ref, after a committed deletion and receipt', live: true,
    committed: async (db, spaceId) => {
      await db.query(`DELETE FROM lexical_chunks WHERE space_id=$1`, [spaceId]);
      await db.query(`UPDATE projection_refs SET deleted=true WHERE space_id=$1`, [spaceId]);
      await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
        VALUES($1,'alpha',1,'source','src_1',1,1)`, [spaceId]);
    },
    stale: async (db, spaceId) => {
      await db.query(`DELETE FROM lexical_chunks WHERE space_id=$1`, [spaceId]);
      await db.query(`UPDATE projection_refs SET extraction_version=2 WHERE space_id=$1`, [spaceId]);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { extractionVersion: 2, db });
    },
    refusal: { 'READ COMMITTED': '23514', 'REPEATABLE READ': '40001' } },
  { name: 'a receipt for a Ref new to its snapshot, after a committed apply', live: false,
    committed: async (db, spaceId) => {
      await projectRef(spaceId, 1, 'source', 'src_1', 1, 1, db);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { db });
    },
    stale: async (db, spaceId) => {
      await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
        VALUES($1,'alpha',1,'source','src_1',1,true)`, [spaceId]);
      await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
        VALUES($1,'alpha',1,'source','src_1',1,0)`, [spaceId]);
    },
    refusal: { 'READ COMMITTED': '23505', 'REPEATABLE READ': '23505' } },
  // Under READ COMMITTED each statement sees the committed apply, so the deletion removes the newer chunk too and
  // commits after it; under REPEATABLE READ the stale deletion is refused.
  { name: 'a receipt for a live Ref, after a committed apply of a newer extraction', live: true,
    committed: async (db, spaceId) => {
      await db.query(`DELETE FROM lexical_chunks WHERE space_id=$1`, [spaceId]);
      await db.query(`UPDATE projection_refs SET extraction_version=2 WHERE space_id=$1`, [spaceId]);
      await lexical(spaceId, 1, 'source', 'src_1', 1, { extractionVersion: 2, db });
    },
    stale: async (db, spaceId) => {
      await db.query(`DELETE FROM lexical_chunks WHERE space_id=$1`, [spaceId]);
      await db.query(`UPDATE projection_refs SET deleted=true WHERE space_id=$1`, [spaceId]);
      await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
        VALUES($1,'alpha',1,'source','src_1',1,1)`, [spaceId]);
    },
    refusal: { 'READ COMMITTED': null, 'REPEATABLE READ': '40001' } }];

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) for (const scenario of fenceScenarios) {
  test(`under ${isolation}, ${scenario.name} cannot leave a live Ref beside a deletion receipt`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1, { vector: false, regions: [] });
    await generation(spaceId, 'alpha', 1, 1, null);
    if (scenario.live) {
      await projectRef(spaceId, 1, 'source', 'src_1', 1, 1);
      await lexical(spaceId, 1, 'source', 'src_1', 1);
    }
    await pool.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='source' AND entity_id='src_1'`, [spaceId]);
    const stale = await pool.connect();
    let outcome = null;
    try {
      await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      // The stale transaction's snapshot is taken before the other transaction commits.
      await stale.query('SELECT count(*) FROM projection_refs WHERE space_id=$1', [spaceId]);
      const committed = await inTransaction(db => scenario.committed(db, spaceId)).then(() => null, error => error.code);
      assert.equal(committed, scenario.committedRefusal ?? null);
      try {
        await scenario.stale(stale, spaceId);
        await stale.query('COMMIT');
      } catch (error) {
        outcome = error.code;
        await stale.query('ROLLBACK');
      }
    } finally { stale.release(); }
    assert.equal(outcome, scenario.refusal[isolation]);
    const state = (await pool.query(`SELECT (SELECT bool_or(live) FROM projection_refs WHERE space_id=$1) AS live,
        (SELECT count(*)::int FROM projection_deletion_receipts WHERE space_id=$1) AS receipts,
        (SELECT count(*)::int FROM lexical_chunks WHERE space_id=$1) AS chunks`, [spaceId])).rows[0];
    assert.equal(state.receipts, state.live ? 0 : 1, JSON.stringify(state));
    assert.equal(state.chunks, state.live ? 1 : 0, JSON.stringify(state));
  });
}

test('an embedding checkpoint needs its Ref live in the generation, and a deletion or receipt needs its checkpoints gone', async () => {
  const spaceId = await space();
  await policy(spaceId, 'alpha', 1);
  await generation(spaceId, 'alpha', 1, 1);
  const checkpoint = (extractionVersion = 1, revision = 1) => vectorChunk(spaceId, 1, 'source', 'src_1', revision,
    { table: 'embedding_checkpoints', extractionVersion });
  const liveRef = refused('23503', 'embedding_checkpoints_live_ref');
  await assert.rejects(checkpoint(), liveRef, 'a Ref the generation has not recorded has no checkpoint');
  // A Ref projected for the first time is recorded at its target revision, with its chunks to follow.
  await projectRef(spaceId, 1, 'source', 'src_1', 1, 1);
  await checkpoint();
  await vectorChunk(spaceId, 1, 'source', 'src_1', 1);
  await pool.query(`DELETE FROM embedding_checkpoints WHERE space_id=$1`, [spaceId]);
  // A checkpoint for a newer extraction does not stop the apply that consumes it.
  await pool.query(`INSERT INTO extraction_versions(space_id,collection_id,source_id,version,source_sha256,parser,parser_version,content,credential_id)
    VALUES($1,'alpha','src_1',2,$2,'text','2','The bridge opened in 1933.','owner-session')`, [spaceId, digest('original bytes')]);
  await checkpoint(2);
  await pool.query(`DELETE FROM vector_chunks WHERE space_id=$1`, [spaceId]);
  await pool.query(`UPDATE projection_refs SET extraction_version=2 WHERE space_id=$1 AND ref_id='src_1'`, [spaceId]);
  await vectorChunk(spaceId, 1, 'source', 'src_1', 1, { extractionVersion: 2 });
  await checkpoint(2, 2);
  // Deleting the Ref, and so its receipt, waits for every checkpoint of it in the generation, whatever its revision.
  await pool.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='source' AND entity_id='src_1'`, [spaceId]);
  await pool.query(`DELETE FROM vector_chunks WHERE space_id=$1`, [spaceId]);
  const remove = () => pool.query(`UPDATE projection_refs SET deleted=true WHERE space_id=$1 AND ref_id='src_1'`, [spaceId]);
  const receipt = () => pool.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,
    chunks_removed) VALUES($1,'alpha',1,'source','src_1',1,1)`, [spaceId]);
  await assert.rejects(remove(), liveRef);
  await assert.rejects(receipt(), refused('23503', 'projection_deletion_receipts_deleted_ref'));
  await pool.query(`DELETE FROM embedding_checkpoints WHERE space_id=$1 AND revision=2`, [spaceId]);
  await assert.rejects(remove(), liveRef, 'a checkpoint of the projected revision blocks it too');
  await pool.query(`DELETE FROM embedding_checkpoints WHERE space_id=$1`, [spaceId]);
  await remove();
  await receipt();
  // After the receipt, no checkpoint of the Ref is saved in that generation.
  await assert.rejects(checkpoint(2), liveRef);
  await assert.rejects(checkpoint(2, 2), liveRef);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM embedding_checkpoints WHERE space_id=$1', [spaceId])).rows[0].n, 0);
});

// Each scenario races a stale transaction against a committed one on the deleted source's Ref in a vector generation:
// a checkpoint save against the Ref's deletion and receipt. `live` starts the Ref projected at extraction 1. A deletion
// checks for checkpoints with a current snapshot, so it sees one committed after its own snapshot at either level.
const saveCheckpoint = (db, spaceId) => vectorChunk(spaceId, 1, 'source', 'src_1', 1, { table: 'embedding_checkpoints', db });
const deleteLiveRef = async (db, spaceId) => {
  await db.query(`UPDATE projection_refs SET deleted=true WHERE space_id=$1`, [spaceId]);
  await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
    VALUES($1,'alpha',1,'source','src_1',1,0)`, [spaceId]);
};
const deleteNewRef = async (db, spaceId) => {
  await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
    VALUES($1,'alpha',1,'source','src_1',1,true)`, [spaceId]);
  await db.query(`INSERT INTO projection_deletion_receipts(space_id,collection_id,generation,ref_kind,ref_id,revision,chunks_removed)
    VALUES($1,'alpha',1,'source','src_1',1,0)`, [spaceId]);
};
const recordAndSave = async (db, spaceId) => {
  await projectRef(spaceId, 1, 'source', 'src_1', 1, 1, db);
  await saveCheckpoint(db, spaceId);
};
const deleted = { live: false, receipts: 1, checkpoints: 0 };
const saved = { live: true, receipts: 0, checkpoints: 1 };
const checkpointScenarios = [
  { name: 'a checkpoint of a live Ref, after a committed deletion and receipt', live: true, committed: deleteLiveRef,
    stale: saveCheckpoint, refusal: { 'READ COMMITTED': '23503', 'REPEATABLE READ': '40001' }, final: deleted },
  { name: 'a deletion and receipt of a live Ref, after a committed checkpoint', live: true, committed: saveCheckpoint,
    stale: deleteLiveRef, refusal: { 'READ COMMITTED': '23503', 'REPEATABLE READ': '23503' }, final: saved },
  { name: 'a checkpoint of a Ref new to its snapshot, after a committed deletion and receipt', live: false, committed: deleteNewRef,
    stale: saveCheckpoint, refusal: { 'READ COMMITTED': '23503', 'REPEATABLE READ': '23503' }, final: deleted },
  { name: 'recording a Ref new to its snapshot and its checkpoint, after a committed deletion and receipt', live: false,
    committed: deleteNewRef, stale: recordAndSave, refusal: { 'READ COMMITTED': '23505', 'REPEATABLE READ': '23505' }, final: deleted },
  { name: 'a deletion and receipt of a Ref new to its snapshot, after it was committed with a checkpoint', live: false,
    committed: recordAndSave, stale: deleteNewRef, refusal: { 'READ COMMITTED': '23505', 'REPEATABLE READ': '23505' }, final: saved }];

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) for (const scenario of checkpointScenarios) {
  test(`under ${isolation}, ${scenario.name} cannot leave a checkpoint beside a deletion receipt`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1);
    await generation(spaceId, 'alpha', 1, 1);
    if (scenario.live) await projectRef(spaceId, 1, 'source', 'src_1', 1, 1);
    await pool.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND kind='source' AND entity_id='src_1'`, [spaceId]);
    const stale = await pool.connect();
    let outcome = null;
    try {
      await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await stale.query('SELECT count(*) FROM projection_refs WHERE space_id=$1', [spaceId]);
      await inTransaction(db => scenario.committed(db, spaceId));
      try {
        await scenario.stale(stale, spaceId);
        await stale.query('COMMIT');
      } catch (error) {
        outcome = error.code;
        await stale.query('ROLLBACK');
      }
    } finally { stale.release(); }
    assert.equal(outcome, scenario.refusal[isolation]);
    const state = (await pool.query(`SELECT (SELECT bool_or(live) FROM projection_refs WHERE space_id=$1) AS live,
        (SELECT count(*)::int FROM projection_deletion_receipts WHERE space_id=$1) AS receipts,
        (SELECT count(*)::int FROM embedding_checkpoints WHERE space_id=$1) AS checkpoints`, [spaceId])).rows[0];
    assert.deepEqual({ ...state }, scenario.final);
  });
}

// Retirement and a chunk or checkpoint writer meet on the generation row: a writer share locks it, so retiring waits for a
// writer already in the generation, and a writer that reaches it during or after a retirement is refused.
const retirementWriters = {
  'lexical chunk': (db, spaceId) => lexical(spaceId, 1, 'record', 'rec_1', 1, { db }),
  'vector chunk': (db, spaceId) => vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { db }),
  'embedding checkpoint': (db, spaceId) => vectorChunk(spaceId, 1, 'record', 'rec_1', 1, { table: 'embedding_checkpoints', db }) };
const retire = (db, spaceId) => moveGeneration(spaceId, 'alpha', 1, 'retired', db);
async function waitsOnLock(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`backend ${pid} never waited on a lock`);
}
const generationRows = async spaceId => (await pool.query(`SELECT (SELECT state FROM projection_generations WHERE space_id=$1) AS state,
    (SELECT count(*)::int FROM lexical_chunks WHERE space_id=$1) + (SELECT count(*)::int FROM vector_chunks WHERE space_id=$1)
      + (SELECT count(*)::int FROM embedding_checkpoints WHERE space_id=$1) AS rows`, [spaceId])).rows[0];

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) for (const [writerName, write] of Object.entries(retirementWriters)) {
  test(`under ${isolation}, retiring a generation waits for an in-flight ${writerName} writer`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1);
    await generation(spaceId, 'alpha', 1, 1);
    await projectRef(spaceId, 1, 'record', 'rec_1', 1);
    const writer = await pool.connect();
    const retirer = await pool.connect();
    try {
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await write(writer, spaceId);
      await retirer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const pid = (await retirer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const retiring = retire(retirer, spaceId);
      await waitsOnLock(pid);
      await writer.query('COMMIT');
      await retiring;
      await retirer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      await retirer.query('ROLLBACK').catch(() => {});
      writer.release();
      retirer.release();
    }
    assert.deepEqual({ ...(await generationRows(spaceId)) }, { state: 'retired', rows: 1 });
  });

  test(`under ${isolation}, a ${writerName} writer that meets an in-flight retirement is refused`, async () => {
    const spaceId = await space();
    await policy(spaceId, 'alpha', 1);
    await generation(spaceId, 'alpha', 1, 1);
    await projectRef(spaceId, 1, 'record', 'rec_1', 1);
    const writer = await pool.connect();
    const retirer = await pool.connect();
    let outcome = null;
    try {
      // The writer's snapshot is taken before the retirement commits.
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await writer.query('SELECT count(*) FROM projection_generations WHERE space_id=$1', [spaceId]);
      await retirer.query('BEGIN');
      await retire(retirer, spaceId);
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const writing = write(writer, spaceId).then(() => null, error => error);
      await waitsOnLock(pid);
      await retirer.query('COMMIT');
      const error = await writing;
      outcome = error && error.code;
      if (outcome === '23514') assert.equal(error.constraint, 'projection_generations_retired');
    } finally {
      // The retirer holds the lock the writer may still wait on, so it is released first.
      await retirer.query('ROLLBACK').catch(() => {});
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      retirer.release();
    }
    assert.equal(outcome, isolation === 'READ COMMITTED' ? '23514' : '40001');
    assert.deepEqual({ ...(await generationRows(spaceId)) }, { state: 'retired', rows: 0 });
  });
}

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

  // A 3,072-dimension generation stores its embeddings beside the HNSW indexes and ranks them exactly.
  const wide = await space();
  const wideEmbedder = ['local-test', 'wide-embedder', '1', 3072];
  await policy(wide, 'alpha', 1);
  await generation(wide, 'alpha', 1, 1, wideEmbedder);
  await inTransaction(async db => {
    for (const [n, id] of ['rec_1', 'rec_w1', 'rec_w2'].entries()) {
      if (n) await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,'alpha',$2,1,1,'generated',$2,'{}','{}'::jsonb)`, [wide, id]);
      await projectRef(wide, 1, 'record', id, 1, null, db);
      await vectorChunk(wide, 1, 'record', id, 1, { values: vector(3072, n + 40), model: wideEmbedder, db });
    }
  });
  await assert.rejects(vectorChunk(wide, 1, 'record', 'rec_1', 1, { chunk: 1, values: vector(384), model: wideEmbedder }),
    check('vector_chunks_dimensions'));
  const exact = `SELECT ref_id, embedding <=> $2::vector AS distance FROM vector_chunks WHERE dimensions=3072 AND space_id=$1
    AND collection_id='alpha' AND generation=1 ORDER BY embedding <=> $2::vector LIMIT 2`;
  const ranked = (await pool.query(exact, [wide, vector(3072, 41)])).rows;
  assert.equal(ranked[0].ref_id, 'rec_w1');
  assert.ok(Math.abs(ranked[0].distance) < 1e-6 && ranked[1].distance > ranked[0].distance, JSON.stringify(ranked));
  const widePlan = (await pool.query(`EXPLAIN ${exact}`, [wide, vector(3072, 41)])).rows.map(row => row['QUERY PLAN']).join('\n');
  assert.doesNotMatch(widePlan, /hnsw/, 'no ANN index covers 3,072 dimensions');
});

const retrievalTables = ['retrieval_policies', 'retrieval_collection_heads', 'projection_generations', 'projection_refs', 'projection_deletion_receipts', 'lexical_chunks',
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
  await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision,deleted)
    VALUES($1,'alpha',1,'claim','clm_1',1,true)`, [spaceId]);
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

// PostgreSQL checks a deleted record's or identity's foreign keys from projection_refs with these queries (as
// ri_triggers.c builds them), once per deleted row at commit, so the space purge runs one per record and identity.
const riLookups = {
  record: { index: 'projection_refs_record', params: ['alpha', 'rec_00017'], sql: `SELECT 1 FROM ONLY public.projection_refs x
    WHERE $1 OPERATOR(pg_catalog.=) space_id AND $2 OPERATOR(pg_catalog.=) collection_id AND $3 OPERATOR(pg_catalog.=) record_id
    FOR KEY SHARE OF x` },
  identity: { index: 'projection_refs_entity', params: ['alpha', 'claim', 'clm_00017'], sql: `SELECT 1 FROM ONLY public.projection_refs x
    WHERE $1 OPERATOR(pg_catalog.=) space_id AND $2 OPERATOR(pg_catalog.=) collection_id AND $3 OPERATOR(pg_catalog.=) entity_kind
      AND $4 OPERATOR(pg_catalog.=) entity_id FOR KEY SHARE OF x` } };

test('deleting a projected record or identity checks projection_refs by index, so a populated space purges in time', { timeout: 120000 }, async t => {
  const spaceId = await space();
  const refs = 4000;
  await inTransaction(async db => {
    await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
      SELECT $1,'alpha',id,1,1,'generated',id,'{"title":"bridge"}','{"title":"bridge"}'::jsonb
      FROM (SELECT 'rec_' || lpad(n::text, 5, '0') AS id FROM generate_series(1, $2) n) ids`, [spaceId, refs]);
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id)
      SELECT $1,'alpha','claim','clm_' || lpad(n::text, 5, '0') FROM generate_series(1, $2) n`, [spaceId, refs]);
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id)
      SELECT $1,'alpha','clm_' || lpad(n::text, 5, '0'),'owner','owner-session' FROM generate_series(1, $2) n`, [spaceId, refs]);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      SELECT $1,'alpha','clm_' || lpad(n::text, 5, '0'),1,'The bridge opened in 1932.','principal:owner','owner-session','owner'
      FROM generate_series(1, $2) n`, [spaceId, refs]);
    await policy(spaceId, 'alpha', 1, { vector: false, regions: [] }, db);
    // Three generations of one collection (active, retired and building), each projecting every record and claim.
    for (const [number, states] of [[1, ['verifying', 'active']], [2, ['retired']], [3, []]]) {
      await generation(spaceId, 'alpha', number, 1, null, db);
      await db.query(`INSERT INTO projection_refs(space_id,collection_id,generation,ref_kind,ref_id,revision)
        SELECT $1,'alpha',$2,kind,(CASE kind WHEN 'record' THEN 'rec_' ELSE 'clm_' END) || lpad(n::text, 5, '0'),1
        FROM generate_series(1, $3) n CROSS JOIN (VALUES ('record'),('claim')) kinds(kind)`, [spaceId, number, refs]);
      for (const state of states) await moveGeneration(spaceId, 'alpha', number, state, db);
    }
  });
  await pool.query('ANALYZE projection_refs');
  const client = new pg.Client({ connectionString: urlFor(testDatabase) });
  await client.connect();
  try {
    for (const [name, lookup] of Object.entries(riLookups)) {
      await client.query(`PREPARE ri_${name} AS ${lookup.sql}`);
      const args = [spaceId, ...lookup.params].map(value => `'${value}'`).join(',');
      // RI checks run as saved plans, custom at first and then generic; both read the referencing index.
      for (const mode of ['force_custom_plan', 'force_generic_plan']) {
        await client.query(`SET plan_cache_mode = ${mode}`);
        const plan = (await client.query(`EXPLAIN EXECUTE ri_${name}(${args})`)).rows.map(row => row['QUERY PLAN']).join('\n');
        assert.match(plan, new RegExp(`Index (?:Only )?Scan using ${lookup.index}\\b`), `${name} ${mode}\n${plan}`);
      }
    }
  } finally { await client.end(); }
  await pool.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1`, [spaceId]);
  const started = performance.now();
  await pool.query('SELECT stateplane_purge_space($1)', [spaceId]);
  const elapsed = performance.now() - started;
  t.diagnostic(`purged ${refs * 2} records and claims with ${refs * 6} projected Refs in ${Math.round(elapsed)} ms`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM projection_refs WHERE space_id=$1', [spaceId])).rows[0].n, 0);
  assert.ok(elapsed < 60000, `purging ${refs * 6} projected Refs took ${Math.round(elapsed)} ms`);
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
  const cellPool = new pg.Pool({ connectionString: urlFor(testDatabase), max: 2, options: `-c role=${role}` });
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
    // Without any retrieval privilege, the role's evidence writes still enqueue their work through owner-rights triggers.
    await assert.rejects(asRole(db => db.query('SELECT 1 FROM retrieval_outbox')), refused('42501'));
    const cellSpaces = spacesFor(cellPool);
    await postgresServices(cellSpaces, new Map([['cell-a', { pool: cellPool, cursorSecret: randomBytes(32) }]]), 3600)
      .collections.define(actor, spaceId, 'gamma', definition('gamma'));
    const sources = new PostgresSources(cellSpaces, new Map([['cell-a', { pool: cellPool, originals: new R2BlobStore(new MemoryR2()) }]]));
    const claims = new PostgresClaims(cellSpaces, new Map([['cell-a', { pool: cellPool }]]));
    const { sourceId } = await sources.ingestText(actor, spaceId, 'gamma', { idempotencyKey: 'src', text: 'The bridge opened in 1932.' });
    await sources.extract(actor, spaceId, 'gamma', sourceId);
    const { claimId } = await claims.create(actor, spaceId, 'gamma', { idempotencyKey: 'c1', statement: 'The bridge opened in 1932.',
      attributedTo: 'city archive', evidence: [{ collectionId: 'gamma', sourceId, extractionVersion: 1, start: 4, end: 10 }] });
    await claims.revise(actor, spaceId, 'gamma', claimId, { baseRevision: 1, statement: 'The bridge opened in 1933.', attributedTo: 'city archive' });
    await claims.review(actor, spaceId, 'gamma', claimId, { baseRevision: 2, status: 'accepted' });
    await claims.delete(actor, spaceId, 'gamma', claimId, { baseRevision: 3 });
    await sources.delete(actor, spaceId, 'gamma', sourceId);
    assert.deepEqual((await work(spaceId)).map(row => [row.ref_kind, row.revision, row.extraction_version, row.operation]), [
      ['source', 1, 1, 'upsert'], ['claim', 1, null, 'upsert'], ['claim', 2, null, 'upsert'], ['claim', 3, null, 'upsert'],
      ['claim', 3, null, 'delete'], ['source', 1, null, 'delete']]);

    execFileSync(process.execPath, ['scripts/grant-retrieval.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: urlFor(testDatabase), STATEPLANE_CELL_ROLE: role } });
    const privileges = Object.fromEntries((await pool.query(`SELECT t, has_table_privilege($1,t,'SELECT') AS r,
        has_table_privilege($1,t,'INSERT') AS i, has_table_privilege($1,t,'UPDATE') AS u, has_table_privilege($1,t,'DELETE') AS d,
        has_table_privilege($1,t,'TRUNCATE') AS x FROM unnest($2::text[]) t`, [role, [...retrievalTables, 'vector_index_strategies']])).rows
      .map(({ t, ...row }) => [t, Object.entries(row).filter(([, granted]) => granted).map(([privilege]) => privilege).join('')]));
    assert.deepEqual(privileges, { retrieval_policies: 'ri', retrieval_collection_heads: 'r', vector_index_strategies: 'r', projection_generations: 'riu', projection_refs: 'riu',
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

/** Apply, in one transaction, every migration that precedes `migration`, recording each in the migrator's ledger. */
async function applyMigrationsBefore(client, migration) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  assert.ok(files.includes(migration), `${migration} exists`);
  const ledger = 'CREATE TABLE stateplane_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())';
  await client.query(`BEGIN; ${ledger}`);
  for (const file of files.slice(0, files.indexOf(migration))) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    await client.query(sql); // NOSONAR -- migrations apply in order
    await client.query('INSERT INTO stateplane_migrations(name,sha256) VALUES($1,$2)', [file, digest(sql)]); // NOSONAR -- recorded with its file
  }
  await client.query('COMMIT');
}

test('migration 045 rolls back atomically when claim writers hold or cross its locks, applies after a revision, and enqueues existing evidence', { timeout: 60000 }, async () => {
  const name = upgradeDatabase;
  const [db, writer, purger, ledger, deleter] = [0, 1, 2, 3, 4].map(() => new pg.Client({ connectionString: urlFor(name) }));
  await Promise.all([db, writer, purger, ledger, deleter].map(client => client.connect()));
  try {
    await applyMigrationsBefore(db, '045_retrieval_projections.sql');
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
    // A space being erased, with a live claim: its erasure runs migration 044's purge routine across the upgrade.
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES('sp_doomed','owner','cell-a','cell-a','target-a')`);
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_doomed','entries')`);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('sp_doomed','entries',1,'{}')`);
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES('sp_doomed','entries','claim','clm_doomed')`);
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id)
      VALUES('sp_doomed','entries','clm_doomed','owner','owner-session')`);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES('sp_doomed','entries','clm_doomed',1,'Doomed.','principal:owner','owner-session','owner')`);
    // An archived space with a live claim whose deletion starts while 045 is applying, after its backfill.
    await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id,lifecycle)
      VALUES('sp_late','owner','cell-a','cell-a','target-a','readOnly')`);
    await db.query(`INSERT INTO collections(space_id,collection_id) VALUES('sp_late','entries')`);
    await db.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES('sp_late','entries',1,'{}')`);
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES('sp_late','entries','claim','clm_late')`);
    await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id)
      VALUES('sp_late','entries','clm_late','owner','owner-session')`);
    await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES('sp_late','entries','clm_late',1,'Late.','principal:owner','owner-session','owner')`);
    await db.query('COMMIT');
    await db.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id='sp_doomed'`);
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
    const untouched = async () => {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM stateplane_migrations WHERE name='045_retrieval_projections.sql'`)).rows[0].n, 0);
      assert.equal(await db.query(`SELECT to_regclass('public.retrieval_outbox') AS outbox`).then(r => r.rows[0].outbox), null);
    };
    const migrating = (env = {}) => new Promise(resolve => {
      const child = spawn(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: urlFor(name), ...env } });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    const waitingFor = async table => {
      for (let attempt = 0; attempt < 3000; attempt++) {
        if ((await db.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND relation=to_regclass($1)) AS waiting`, [table]))
          .rows[0].waiting) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`migration 045 never waited for ${table}`);
    };

    // A claim create writes its identity before its revision, the opposite of 045's lock order. The cycle is
    // resolved by aborting the step (a deadlock, or the bounded wait if PostgreSQL has not detected it yet), which the
    // migrator reports as a retry; the writer then proceeds.
    await writer.query('BEGIN');
    await writer.query(`SET LOCAL deadlock_timeout = '60s'`);
    await writer.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES('sp_upgrade','entries','claim','clm_new')`);
    const crossed = migrating();
    await waitingFor('entity_refs');
    await writer.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id)
      VALUES('sp_upgrade','entries','clm_new','owner','owner-session')`);
    const revisionWrite = writer.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,
      recorded_by) VALUES('sp_upgrade','entries','clm_new',1,'New.','principal:owner','owner-session','owner')`);
    const deadlocked = await crossed;
    assert.equal(deadlocked.status, 1);
    assert.match(deadlocked.stderr, /Retrieval projection upgrade waits for record, extraction and claim writers/);
    await revisionWrite;
    await writer.query('ROLLBACK');
    await untouched();

    // Above 10,000 source and claim identities the backfill's lock hold is long enough to need a drained window. The
    // backfill reads deleted identities too, so they count toward the bound although they have nothing to enqueue.
    await db.query('BEGIN');
    await db.query(`SET LOCAL session_replication_role = replica`);
    await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id,tombstone)
      SELECT 'sp_upgrade','entries','claim','clm_bulk_'||n,true FROM generate_series(1,10000) n`);
    await db.query('COMMIT');
    const populated = migrate(name, { STATEPLANE_POPULATED_INDEX_UPGRADE: '' });
    assert.equal(populated.status, 1);
    assert.match(populated.stderr, /Populated retrieval projection upgrade requires drained traffic above 10000 source and claim identities/);
    await untouched();

    // A revise or review inserts the revision before it advances the identity, 045's own order: the step waits for
    // the writer, which finishes and commits, and then applies.
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,recorded_by)
      VALUES('sp_upgrade','entries','clm_live',3,'Third.','principal:owner','owner-session','owner')`);
    // Hold the step's ledger row, so the step stops after all of its SQL, backfill included, before it commits.
    await ledger.query('BEGIN');
    await ledger.query(`INSERT INTO stateplane_migrations(name,sha256) VALUES('045_retrieval_projections.sql','held')`);
    const applying = migrating({ STATEPLANE_POPULATED_INDEX_UPGRADE: 'drained' });
    await waitingFor('claim_revisions');
    // An erasure already inside migration 044's purge routine queues behind the step on claim revisions. It resumes with
    // that routine, which removes no retrieval work, and completes because the backfill skipped its space.
    await purger.query('BEGIN');
    const purgerPid = (await purger.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const purging = purger.query(`SELECT stateplane_purge_space('sp_doomed')`).then(() => null, error => error);
    await waitsOnLock(purgerPid);
    await writer.query(`UPDATE entity_refs SET revision=3 WHERE space_id='sp_upgrade' AND kind='claim' AND entity_id='clm_live'`);
    await writer.query('COMMIT');
    for (let attempt = 0; !(await db.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
      AND query LIKE 'INSERT INTO stateplane_migrations%') AS waiting`)).rows[0].waiting; attempt += 1) {
      assert.ok(attempt < 3000, 'migration 045 never reached its ledger write');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // The archived space's deletion starts after the backfill enqueued its claim. Its lifecycle change waits for the
    // step, so the purge that follows it runs 045's routine; had the change committed now, a purge started before the
    // step committed would run 044's routine and fail on the claim's retrieval work.
    const deleterPid = (await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let lifecycleDone = false;
    const deleting = deleter.query(`UPDATE spaces SET lifecycle='deleting' WHERE space_id='sp_late'`).finally(() => { lifecycleDone = true; });
    let lifecycleWaited = false;
    for (let attempt = 0; attempt < 200 && !lifecycleDone && !lifecycleWaited; attempt += 1) {
      lifecycleWaited = (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [deleterPid])).rows[0]?.wait_event_type === 'Lock';
      if (!lifecycleWaited) await new Promise(resolve => setTimeout(resolve, 25));
    }
    let latePurge = null;
    if (lifecycleDone) {
      await deleting;
      latePurge = deleter.query(`SELECT stateplane_purge_space('sp_late')`).then(() => null, error => error);
      await waitsOnLock(deleterPid);
    }
    await ledger.query('ROLLBACK');
    const applied = await applying;
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied 045_retrieval_projections.sql/);
    assert.equal(await purging, null);
    await purger.query('COMMIT');
    await deleting;
    latePurge ??= deleter.query(`SELECT stateplane_purge_space('sp_late')`).then(() => null, error => error);
    assert.equal(await latePurge, null);
    assert.ok(lifecycleWaited, 'the lifecycle change waited for migration 045');
    for (const spaceId of ['sp_doomed', 'sp_late']) {
      assert.deepEqual((await db.query(`SELECT lifecycle, (SELECT count(*)::int FROM entity_refs WHERE space_id=$1) AS identities,
        (SELECT count(*)::int FROM retrieval_outbox WHERE space_id=$1) AS work FROM spaces WHERE space_id=$1`, [spaceId])).rows[0],
      { lifecycle: 'deleted', identities: 0, work: 0 });
    }
    // Each live source's latest extraction and each live claim's current revision are enqueued once.
    assert.deepEqual((await db.query(`SELECT ref_kind,ref_id,revision::int,extraction_version::int,operation,placement_generation::int
      FROM retrieval_outbox ORDER BY ref_kind,ref_id`)).rows.map(row => ({ ...row })), [
      { ref_kind: 'claim', ref_id: 'clm_live', revision: 3, extraction_version: null, operation: 'upsert', placement_generation: 3 },
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
    await purger.query('ROLLBACK').catch(() => {});
    await ledger.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([db, writer, purger, ledger, deleter].map(client => client.end()));
  }
});

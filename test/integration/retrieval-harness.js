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
import { PostgresAuthority, PostgresClaims, PostgresOutbox, PostgresRetrievalSearch, PostgresRetrievalWorker, PostgresSources,
  PostgresSpaces, RecordRetrievalProjector, postgresServices } from '../../packages/postgres/dist/index.js';
import { DeterministicEmbedder, EmbedderUnavailableError, EmbeddingRegistry } from '../../packages/retrieval/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';
import { consume, dispatch } from '../../packages/workers/dist/index.js';

// The shared setup of the retrieval integration suites (STA-46 search,
// STA-47 bundles). Each test file runs in a process of its own, so each
// importing suite owns this module's database: the record dispatcher is
// cell-wide, so a suite needs one to itself. It is migrated on import and
// dropped after the suite.
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_retrieval_${randomUUID().replaceAll('-', '')}`;
/** Run one statement on the server's maintenance connection, which creates and drops the suite's database. */
async function onServer(sql) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}
await onServer(`CREATE DATABASE ${name}`);
const dropDatabase = () => onServer(`DROP DATABASE IF EXISTS ${name}`);
export const target = new URL(baseUrl); target.pathname = `/${name}`;
try {
  execFileSync(process.execPath, ['scripts/migrate.mjs'], { cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'ignore' });
} catch (error) { await dropDatabase(); throw error; }
export const pool = new pg.Pool({ connectionString: target.toString(), max: 8 });
test.after(async () => { await pool.end(); await dropDatabase(); });

const sha = value => createHash('sha256').update(value).digest('hex');
export const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

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

/**
 * A pool whose hooks run once on the first statement containing their text: `run` just before it, `after` just after it
 * (given its result, and returning the result the caller sees). `pending()` returns the suite's hooks and `used(hook)`
 * removes one, so a suite keeps its hooks in a variable of its own.
 */
export const hookedPool = (base, pending, used) => ({ connect: async () => {
  const client = await base.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const hook = typeof sql === 'string' ? pending().find(item => sql.includes(item.match)) : undefined;
      if (!hook) return target.query(sql, ...rest);
      used(hook);
      await hook.run?.(target);
      const result = await target.query(sql, ...rest);
      return hook.after ? hook.after(result) : result;
    };
  } });
} });
export const REREAD = 'COALESCE(rec.revision,e.revision)';
export const LOCK_SPACE = 'SELECT lifecycle,policy_version,placement_generation FROM spaces WHERE space_id=$1 FOR SHARE';

export const config = { database: memoryAdapter(), namespace: `retrieval-${randomUUID()}`, plugins: [] };
createAuthFn(config);
export const identity = new AuthFnIdentityVerifier(config);
export const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
export const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
export const sources = new PostgresSources(spaces, new Map([['cell-a', { pool, originals: new R2BlobStore(new MemoryR2()) }]]));
export const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
export const authority = new PostgresAuthority(pool, 3600);
const outbox = new PostgresOutbox(pool, authority);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
  unique: [], filterable: [], sortable: [] });

/**
 * A deterministic embedder (in region `local` by default); `down` makes every call an outage, `fail` the input's fault,
 * `hang` never answer, and `before` runs before a call answers.
 */
export class Spy extends DeterministicEmbedder {
  constructor(behavior = {}, region = 'local') { super({ embedder: 'local-hash', region }); this.behavior = behavior; this.queries = []; }
  async embed(texts, signal) {
    await this.behavior.before?.(texts);
    if (this.behavior.down) throw new EmbedderUnavailableError('provider unreachable');
    if (this.behavior.fail) throw new Error(`rejected input: ${texts[0]}`);
    if (this.behavior.hang) return new Promise(() => {});
    this.queries.push(...texts);
    return super.embed(texts, signal);
  }
}
export const healthy = new Spy();
export const registry = new EmbeddingRegistry([healthy]);
export const search = (embedders = registry, cellPool = pool) => new PostgresRetrievalSearch(spaces, new Map([['cell-a', { pool: cellPool }]]),
  { embedders });

/** Deliver every due record event and evidence item until nothing is left. */
export async function index(embedders = registry) {
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
async function project(spaceId, collectionId, { lexical = true, vector = true, regions = ['local'], fields = ['/title', '/note'],
  sources = true, claims = true, dimensions = 384 } = {}) {
  await pool.query(`INSERT INTO retrieval_policies(space_id,collection_id,version,record_fields,source_content,claim_statements,
      lexical,vector,text_search_config,processing_regions,credential_id) VALUES($1,$2,1,$6,$7,$8,$3,$4,'english',$5,'owner')`,
  [spaceId, collectionId, lexical, vector, regions, fields, sources, claims]);
  const model = vector ? ['local-hash', 'feature-hash', '1', dimensions] : [null, null, null, null];
  await pool.query(`INSERT INTO projection_generations(space_id,collection_id,generation,policy_version,embedder,embedding_model,
    model_version,dimensions) VALUES($1,$2,1,1,$3,$4,$5,$6)`, [spaceId, collectionId, ...model]);
  for (const state of ['verifying', 'active']) await pool.query(`UPDATE projection_generations SET state=$3
    WHERE space_id=$1 AND collection_id=$2 AND generation=1`, [spaceId, collectionId, state]);
}

/** A space with collections alpha and beta, each projected lexically and by vector. */
export async function fixture({ collections = ['alpha', 'beta'], policy = {} } = {}) {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of collections) {
    await services.collections.define(owner, spaceId, id, definition(id));
    await project(spaceId, id, policy[id]);
  }
  const scope = (collectionId, policyVersion = 1) => ({ spaceId, collectionId, principalId: user.id, credentialId: owner.credentialId,
    capability: 'records:write', policyVersion, placementGeneration: 1 });
  const record = async (collectionId, data, extras = {}, operation = 'create') => {
    const key = randomUUID();
    // Issuing a key moves the space's policy version; write at the current one.
    const { policy_version: version } = (await pool.query('SELECT policy_version FROM spaces WHERE space_id=$1', [spaceId])).rows[0];
    return (await authority.mutate(scope(collectionId, Number(version)), { operation, idempotencyKey: key, requestDigest: sha(key),
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
export const ids = result => result.results.map(hit => `${hit.ref.collectionId}/${hit.ref.kind}/${hit.ref.id}`);

/** Wait until a session of the suite's database waits on a lock, failing with `label` if none does. */
export async function lockWaited(label) {
  for (let tries = 0; ; tries++) {
    const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock'`)).rows[0].n;
    if (waiting) return;
    assert.ok(tries < 400, label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Beacon content in collection alpha of `f`, indexed: three records, two sources and a claim, all matching "beacon". */
export async function beacons(f) {
  const kept = await f.record('alpha', { title: 'beacon one' });
  const deleted = await f.record('alpha', { title: 'beacon two' });
  const revised = await f.record('alpha', { title: 'beacon three' });
  const sourceId = await f.source('alpha', 'A beacon source.');
  const corrected = await f.source('alpha', 'Another beacon source.');
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c', statement: 'A beacon claim.', attributedTo: 'x' });
  await index();
  return { kept, deleted, revised, sourceId, corrected, claim };
}

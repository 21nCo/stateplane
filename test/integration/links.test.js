import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresClaims, PostgresLinks, PostgresSources, PostgresSpaces, SourceUploadReconciler, postgresServices }
  from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const pool = new pg.Pool({ connectionString: url, max: 10 });
test.after(() => pool.end());
const sha = value => createHash('sha256').update(value).digest('hex');

/** An in-memory R2 bucket: atomic put with its checksum, ordered list and injectable delete faults and delays. */
class MemoryR2 {
  objects = new Map();
  failDelete = () => false;
  /** Milliseconds a delete of the key takes, or Infinity for one that never answers. */
  deleteDelay = () => 0;
  /** Milliseconds a listing after the cursor takes. */
  listDelay = () => 0;
  async put(key, body, options = {}) {
    const chunks = [];
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    const bytes = Buffer.concat(chunks);
    if (options.sha256 !== undefined && options.sha256 !== sha(bytes)) throw new Error('put: checksum mismatch');
    this.objects.set(key, { bytes, sha256: options.sha256 });
    return this.meta(key);
  }
  meta(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} } : null;
  }
  async head(key) { return this.meta(key); }
  async get(key) { const meta = this.meta(key); return meta && { ...meta, body: new Blob([this.objects.get(key).bytes]).stream() }; }
  async delete(key) {
    const delay = this.deleteDelay(key);
    if (delay === Infinity) return new Promise(() => {});
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (this.failDelete(key)) throw new Error('delete: provider unavailable');
    this.objects.delete(key);
  }
  async list({ startAfter = '', limit = 1000 } = {}) {
    const delay = this.listDelay(startAfter);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const after = [...this.objects.keys()].sort().filter(key => key > startAfter);
    return { objects: after.slice(0, limit).map(key => ({ key })), truncated: after.length > limit };
  }
  keys(prefix) { return [...this.objects.keys()].filter(key => key.startsWith(prefix)); }
}
const rejects = (promise, code, message) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `${message ?? ''}: ${error.code} ${error.message}`);
  return true;
}, message);

/**
 * A pool whose hooks run once before the first statement containing their text, or equal to it when `exact`, and
 * whose parameters satisfy `when`, if given.
 */
let hooks = [];
const hooked = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const hook = typeof sql === 'string' ? hooks.find(item => (item.exact ? sql === item.match : sql.includes(item.match)) &&
        (!item.when || item.when(rest[0] ?? []))) : undefined;
      if (hook) { hooks = hooks.filter(item => item !== hook); await hook.run(); }
      return target.query(sql, ...rest);
    };
  } });
} };
/** Hold the first statement containing `match`, with parameters satisfying `when`, until released. */
function hold(match, when) {
  let reached, release;
  const at = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  hooks.push({ match, when, run: async () => { reached(); await gate; } });
  return { at, release };
}

const config = { database: memoryAdapter(), namespace: `sta36-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const links = new PostgresLinks(spaces, new Map([['cell-a', { pool }]]));
const hookedLinks = new PostgresLinks(spaces, new Map([['cell-a', { pool: hooked }]]));
const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
const hookedClaims = new PostgresClaims(spaces, new Map([['cell-a', { pool: hooked }]]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });
const all = ['records:read', 'records:write', 'sources:read', 'sources:write', 'claims:read', 'claims:write'];

/**
 * A space with collections alpha and beta, a record and a stored text source in each, and an agent factory. Its
 * bytes go to `r2`, so a fixture given another's store shares that cell's bucket.
 */
async function fixture(r2 = new MemoryR2()) {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  buckets.set(Buffer.from(spaceId).toString('base64url'), r2);
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of ['alpha', 'beta']) await services.collections.define(owner, spaceId, id, definition(id));
  // `expiresAt` may end the key (`key`) or one collection's grant early.
  const agent = async (grants, expiresAt) => verify((await spaces.issueAgentKey(owner, spaceId,
    expiresAt?.key ?? new Date(Date.now() + 3_600_000), grants.map(([collectionId, capabilities]) => ({ collectionId, capabilities,
      ...(expiresAt?.[collectionId] ? { expiresAt: expiresAt[collectionId] } : {}) })))).secret);
  const cell = { pool, originals: new R2BlobStore(r2) };
  const sources = new PostgresSources(spaces, new Map([['cell-a', cell]]));
  const hookedSources = new PostgresSources(spaces, new Map([['cell-a', { pool: hooked, originals: cell.originals }]]));
  const record = async (collectionId, label = collectionId) => (await services.records.mutate(owner, spaceId, collectionId,
    JSON.stringify({ operation: 'create', idempotencyKey: `rec-${randomUUID()}`, data: { label } }))).ref.id;
  const source = async collectionId => (await sources.ingestText(owner, spaceId, collectionId,
    { idempotencyKey: `src-${randomUUID()}`, text: `The ${collectionId} report.` })).sourceId;
  const f = { spaceId, owner, agent, r2, cell, sources, hookedSources, record, source,
    reconciler: () => new SourceUploadReconciler(cell, 0) };
  f.alphaRecord = await record('alpha');
  f.betaRecord = await record('beta');
  f.alphaSource = await source('alpha');
  f.betaSource = await source('beta');
  return f;
}
const ref = (kind, collectionId, id) => ({ kind, collectionId, id });
let n = 0;
const create = (actor, f, owner, from, to, policy = 'detach', type = 'cites') =>
  links.create(actor, f.spaceId, owner, { idempotencyKey: `l${n++}`, type, policy, from, to });
const linkRows = async spaceId => (await pool.query(`SELECT link_id,tombstone,revision::int FROM links WHERE space_id=$1
  ORDER BY link_id`, [spaceId])).rows;
const events = async spaceId => (await pool.query(`SELECT e.kind,e.entity_id,e.revision::int,e.operation,
    e.credential_id IS NOT NULL AS by_request,o.delivery_state FROM evidence_events e JOIN evidence_outbox o USING (event_id)
  WHERE e.space_id=$1 ORDER BY e.committed_at,e.event_id`, [spaceId])).rows;
const deleteRecord = (actor, f, collectionId, id, revision = 1) => services.records.mutate(actor, f.spaceId, collectionId,
  JSON.stringify({ operation: 'delete', idempotencyKey: `del-${randomUUID()}`, id, expectedRevision: revision }));
/**
 * As if an hour passed for the space's writers: every upload grant, and every
 * erasure's writer bound and next attempt, moves an hour back. Only the clock
 * is simulated, so the guards that forbid such changes are bypassed for it.
 * With `grants` false only the erasures move, so the cell-wide upload
 * reconciler of other test files, each with its own store, leaves the
 * space's attempts alone.
 */
async function settle(f, grants = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    if (grants) await client.query(`UPDATE source_upload_grants SET issued_at=issued_at-interval '1 hour',
      expires_at=expires_at-interval '1 hour' WHERE space_id=$1`, [f.spaceId]);
    for (const table of ['original_erasures', 'space_erasures'])
      await client.query(`UPDATE ${table} SET writers_end_at=writers_end_at-interval '1 hour',
        next_attempt_at=next_attempt_at-interval '1 hour' WHERE space_id=$1`, [f.spaceId]);
    await client.query('COMMIT');
  } finally { client.release(); }
}
const objectKey = async (f, sourceId) => (await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND source_id=$2',
  [f.spaceId, sourceId])).rows[0].object_key;
const erasures = async spaceId => (await pool.query('SELECT count(*)::int AS n FROM original_erasures WHERE space_id=$1',
  [spaceId])).rows[0].n;
/** Each fixture's bucket by its space's key segment: the bytes of this file's spaces are only ever there. */
const buckets = new Map();
/** This file's erasures, due or else complete, with their bytes: a source's original key, or a space's (`key` null). */
const ownErasures = async complete => (await pool.query(`SELECT x.space_id,x.source_id AS id,o.object_key AS key
    FROM original_erasures x JOIN original_objects o USING (space_id,collection_id,source_id)
    WHERE x.space_id=ANY($1) AND CASE WHEN $2 THEN x.removed_at IS NOT NULL
      ELSE x.removed_at IS NULL AND x.next_attempt_at<=clock_timestamp() END
  UNION ALL SELECT space_id,space_id,NULL FROM space_erasures WHERE space_id=ANY($1) AND CASE WHEN $2
    THEN originals_removed_at IS NOT NULL ELSE originals_removed_at IS NULL AND next_attempt_at<=clock_timestamp() END`,
[[...buckets.keys()].map(segment => Buffer.from(segment, 'base64url').toString()), complete])).rows;
/** An error and every error an AggregateError holds, at any depth. */
const flat = error => error instanceof AggregateError ? error.errors.flatMap(flat) : [error];
/**
 * Complete every due erasure earlier tests of this file left, so a test's own erasures are the only ones of this file
 * due. Each key is erased from the bucket of the fixture that wrote it, past any fault a test left injected; another
 * file's space keeps its bytes in its own bucket, so its listing here fails and it is never recorded erased. It fails
 * when an erasure of this file is still due after it, or its last pass failed for any other reason.
 */
async function drain() {
  const foreign = 'drain: not this file\'s key';
  const owner = key => {
    const r2 = buckets.get(String(key).split('/')[1]);
    if (!r2) throw new Error(foreign);
    return r2;
  };
  const store = {
    async delete(key) { owner(key).objects.delete(key); },
    async list({ startAfter = '', limit = 1000 } = {}) {
      const after = [...owner(startAfter).objects.keys()].sort().filter(key => key > startAfter);
      return { objects: after.slice(0, limit).map(key => ({ key })), truncated: after.length > limit };
    },
  };
  const reconciler = new SourceUploadReconciler({ pool, originals: new R2BlobStore(store) }, 0);
  const due = await ownErasures(false);
  let errors = [];
  for (let i = 0; i < 20 && (await ownErasures(false)).length; i++) {
    errors = await reconciler.erase(500, 5000).then(() => [], error => flat(error).filter(item => item?.message !== foreign));
  }
  const left = await ownErasures(false);
  if (left.length || errors.length) throw new AggregateError(errors, `drain left ${left.map(row => row.key ?? row.id).join(', ') ||
    'no erasure'} of this file due`);
  // What it recorded erased has no bytes left in its own bucket.
  const complete = new Set((await ownErasures(true)).map(row => row.id));
  for (const { space_id: spaceId, key } of due.filter(row => complete.has(row.id))) {
    const segment = Buffer.from(spaceId).toString('base64url');
    const r2 = buckets.get(segment);
    const left = key ? [key].filter(item => r2.objects.has(item)) : [...r2.keys(`originals/${segment}/`), ...r2.keys(`staging/${segment}/`)];
    assert.deepEqual(left, [], `drain recorded ${key ?? spaceId} erased only with its bytes gone`);
  }
}
const retained = { originalBytes: 'none', metadata: 'retained', backups: 'retained' };
const recordLive = async (f, id) => (await pool.query('SELECT NOT tombstone AS live FROM records WHERE space_id=$1 AND record_id=$2',
  [f.spaceId, id])).rows[0].live;

test('links reach no endpoint the caller could not read directly, from either side, in any read', async () => {
  const f = await fixture();
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c-beta', statement: 'From the beta report.',
    attributedTo: 'archive', evidence: [{ collectionId: 'beta', sourceId: f.betaSource }] });
  const alpha = ref('record', 'alpha', f.alphaRecord);
  // Owned by alpha and by beta, to a beta source, and to an alpha claim that cites beta.
  const toSource = await create(f.owner, f, 'alpha', alpha, ref('source', 'beta', f.betaSource));
  const fromSource = await create(f.owner, f, 'beta', ref('source', 'beta', f.betaSource), alpha, 'restrict');
  const toClaim = await create(f.owner, f, 'alpha', alpha, ref('claim', 'alpha', claim.claimId));
  const visibleLink = await create(f.owner, f, 'alpha', alpha, ref('record', 'beta', f.betaRecord));
  assert.deepEqual({ ...toSource, linkId: null, createdAt: null }, { linkId: null, collectionId: 'alpha', type: 'cites',
    policy: 'detach', from: alpha, to: ref('source', 'beta', f.betaSource), revision: 1, deleted: false, createdAt: null,
    deletedAt: null, replayed: false });
  const alphaOnly = await f.agent([['alpha', all], ['beta', ['records:read']]]);
  const listed = await links.list(alphaOnly, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord } });
  assert.deepEqual(listed.links.map(link => link.linkId), [visibleLink.linkId], 'only the link to a readable beta record shows');
  assert.equal(listed.next, null);
  for (const hidden of [toSource, toClaim])
    await rejects(links.get(alphaOnly, f.spaceId, 'alpha', hidden.linkId), 'NOT_FOUND', 'an unreadable endpoint hides the link');
  await rejects(links.get(alphaOnly, f.spaceId, 'beta', fromSource.linkId), 'NOT_FOUND', 'and its owner does not matter');
  await rejects(links.delete(alphaOnly, f.spaceId, 'alpha', toSource.linkId), 'NOT_FOUND', 'nor can it be deleted');
  await rejects(links.list(alphaOnly, f.spaceId, 'alpha', { endpoint: { kind: 'claim', id: claim.claimId } }), 'NOT_FOUND',
    'a claim citing an unreadable collection has no links to list');
  await rejects(links.list(alphaOnly, f.spaceId, 'beta', { endpoint: { kind: 'source', id: f.betaSource } }), 'FORBIDDEN');
  // A reader of beta sources sees all of them; nothing else about the endpoints is in a view.
  const both = await f.agent([['alpha', ['records:read', 'claims:read']], ['beta', ['sources:read', 'records:read']]]);
  const full = await links.list(both, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord } });
  assert.deepEqual(full.links.map(link => link.linkId).sort(),
    [toSource, fromSource, toClaim, visibleLink].map(link => link.linkId).sort());
  for (const view of full.links) assert.deepEqual(Object.keys(view).sort(), ['collectionId', 'createdAt', 'deleted', 'deletedAt',
    'from', 'linkId', 'policy', 'replayed', 'revision', 'to', 'type']);
  const paged = await links.list(both, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord }, limit: 3 });
  assert.equal(paged.links.length, 3);
  const rest = await links.list(both, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord }, after: paged.next });
  assert.equal(rest.links.length, 1);
  assert.equal(rest.next, null);
  // Deleting the record refuses on beta's restrict link and says nothing about it.
  await assert.rejects(deleteRecord(f.owner, f, 'alpha', f.alphaRecord), error => {
    assert.equal(error.code, 'LINK_RESTRICTED');
    assert.equal(error.retryable, false);
    for (const secret of [f.betaSource, fromSource.linkId, 'beta']) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(await recordLive(f, f.alphaRecord), true);
});

test('a link page over many collections and citations is authorized with as many statements as a page over one', async () => {
  const f = await fixture();
  // 25 more collections: the alpha record links to a record and to a claim in each, and each claim cites the next's source.
  const wide = Array.from({ length: 25 }, (_, i) => `wide${String(i).padStart(2, '0')}`);
  for (const id of wide) await services.collections.define(f.owner, f.spaceId, id, definition(id));
  const alpha = ref('record', 'alpha', f.alphaRecord);
  for (let i = 0; i < wide.length; i++) {
    const cited = wide[(i + 1) % wide.length];
    const claim = await claims.create(f.owner, f.spaceId, wide[i], { idempotencyKey: `wide-${i}`, statement: `Claim ${i}.`,
      attributedTo: 'archive', evidence: [{ collectionId: cited, sourceId: await f.source(cited) }] });
    await create(f.owner, f, 'alpha', alpha, ref('record', wide[i], await f.record(wide[i])));
    await create(f.owner, f, 'alpha', alpha, ref('claim', wide[i], claim.claimId));
  }
  await create(f.owner, f, 'beta', ref('record', 'beta', f.betaRecord), alpha);
  const reader = await f.agent([['alpha', ['records:read']], ['beta', ['records:read']],
    ...wide.map(id => [id, ['records:read', 'sources:read', 'claims:read']])]);
  const statements = [];
  let counting = false;
  const counted = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return (sql, ...rest) => { if (counting) statements.push(sql); return target.query(sql, ...rest); };
    } });
  } };
  const countedLinks = new PostgresLinks(spaces, new Map([['cell-a', { pool: counted }]]));
  const list = async (collectionId, id) => {
    statements.length = 0;
    counting = true;
    try { return { page: await countedLinks.list(reader, f.spaceId, collectionId, { endpoint: { kind: 'record', id } }),
      count: statements.length, fences: statements.filter(sql => String(sql).includes('FOR SHARE')).length };
    } finally { counting = false; }
  };
  const narrow = await list('beta', f.betaRecord);
  assert.equal(narrow.page.links.length, 1);
  // 51 links touch the alpha record: a full page of 50, and the row past it, over 77 (collection, capability) pairs.
  const full = await list('alpha', f.alphaRecord);
  assert.equal(full.page.links.length, 50);
  assert.notEqual(full.page.next, null);
  assert.equal(full.count, narrow.count, `the full page took ${full.count} statements, one link took ${narrow.count}`);
  assert.ok(full.fences <= 3, `the full page's fences and recheck took ${full.fences} statements`);
  const rest = await countedLinks.list(reader, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord },
    after: full.page.next });
  assert.equal(rest.links.length, 1);
  assert.equal(rest.next, null);
});

test('creating a link needs read and write on both endpoints, refused before any lookup', async () => {
  const f = await fixture();
  const alpha = ref('record', 'alpha', f.alphaRecord);
  const before = await linkRows(f.spaceId);
  const cases = [
    [[['alpha', all]], ref('source', 'beta', f.betaSource), 'no grant on beta'],
    [[['alpha', all]], ref('source', 'beta', 'src_missing'), 'the same refusal when the source does not exist'],
    [[['alpha', all], ['beta', ['sources:read']]], ref('source', 'beta', f.betaSource), 'read without write'],
    [[['alpha', all], ['beta', ['sources:write']]], ref('source', 'beta', f.betaSource), 'write without read'],
    [[['alpha', ['records:read']], ['beta', all]], ref('source', 'beta', f.betaSource), 'the owning endpoint read-only'],
    [[['alpha', all], ['beta', ['records:read', 'records:write']]], ref('source', 'beta', f.betaSource), 'another kind\'s grant']
  ];
  for (const [grants, to, label] of cases)
    await rejects(create(await f.agent(grants), f, 'alpha', alpha, to), 'FORBIDDEN', label);
  await rejects(create(await f.agent([['beta', all]]), f, 'alpha', alpha, ref('source', 'beta', f.betaSource)), 'FORBIDDEN',
    'no access to the owning collection at all');
  assert.deepEqual(await linkRows(f.spaceId), before);
  const linker = await f.agent([['alpha', all], ['beta', all]]);
  await rejects(create(linker, f, 'alpha', alpha, ref('source', 'beta', 'src_missing')), 'NOT_FOUND', 'readable but missing');
  await rejects(create(linker, f, 'gamma', alpha, ref('source', 'beta', f.betaSource)), 'FORBIDDEN', 'an unknown owner');
  await rejects(links.create(linker, f.spaceId, 'alpha', { idempotencyKey: 'own', type: 'cites', policy: 'detach',
    from: ref('record', 'beta', f.betaRecord), to: ref('source', 'beta', f.betaSource) }), 'INVALID_ARGUMENT',
  'the owner must be an endpoint\'s collection');
  for (const bad of [{ policy: 'cascade' }, { type: '' }, { from: alpha, to: alpha }, { to: { kind: 'event', collectionId: 'beta', id: 'x' } },
    { extra: true }, { to: undefined }])
    await rejects(links.create(linker, f.spaceId, 'alpha', { idempotencyKey: 'bad', type: 'cites', policy: 'detach', from: alpha,
      to: ref('source', 'beta', f.betaSource), ...bad }), 'INVALID_ARGUMENT', JSON.stringify(bad));
  assert.deepEqual(await linkRows(f.spaceId), before, 'a refused request writes nothing');
  // A retry replays; the same key with other content or in another collection is a mismatch.
  const request = { idempotencyKey: 'same', type: 'cites', policy: 'restrict', from: alpha, to: ref('source', 'beta', f.betaSource) };
  const first = await links.create(linker, f.spaceId, 'alpha', request);
  assert.deepEqual(await links.create(linker, f.spaceId, 'alpha', request), { ...first, replayed: true });
  await rejects(links.create(linker, f.spaceId, 'alpha', { ...request, policy: 'detach' }), 'IDEMPOTENCY_MISMATCH');
  await rejects(links.create(linker, f.spaceId, 'beta', request), 'IDEMPOTENCY_MISMATCH');
  // A read-only endpoint collection takes no new links.
  await pool.query(`UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id='beta'`, [f.spaceId]);
  await rejects(create(linker, f, 'alpha', alpha, ref('record', 'beta', f.betaRecord)), 'SPACE_UNAVAILABLE');
  await pool.query(`UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id='beta'`, [f.spaceId]);
  assert.deepEqual(await events(f.spaceId), [{ kind: 'link', entity_id: first.linkId, revision: 1, operation: 'create', by_request: true,
    delivery_state: 'pending' }]);
  // Replays follow each endpoint kind's readOnly rule: a record endpoint's read-only collection refuses even a replay,
  // as record receipts do, while source and claim endpoints still replay a committed create or delete.
  const claim = await claims.create(f.owner, f.spaceId, 'beta', { idempotencyKey: 'ro', statement: 'ro', attributedTo: 'a' });
  const plain = { idempotencyKey: 'plain', type: 'cites', policy: 'detach', from: ref('source', 'alpha', f.alphaSource),
    to: ref('claim', 'beta', claim.claimId) };
  const kept = await links.create(linker, f.spaceId, 'alpha', plain);
  const gone = await links.delete(linker, f.spaceId, 'alpha',
    (await links.create(linker, f.spaceId, 'alpha', { ...plain, idempotencyKey: 'plain-gone' })).linkId);
  const recordGone = await links.delete(linker, f.spaceId, 'alpha', (await links.create(linker, f.spaceId, 'alpha',
    { ...request, idempotencyKey: 'record-gone', policy: 'detach' })).linkId);
  await pool.query(`UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1`, [f.spaceId]);
  assert.deepEqual(await links.create(linker, f.spaceId, 'alpha', plain), { ...kept, replayed: true });
  assert.deepEqual(await links.delete(linker, f.spaceId, 'alpha', gone.linkId), { ...gone, replayed: true });
  await rejects(links.create(linker, f.spaceId, 'alpha', { ...plain, idempotencyKey: 'plain-new' }), 'SPACE_UNAVAILABLE',
    'but takes no new source or claim link');
  await rejects(links.create(linker, f.spaceId, 'alpha', request), 'SPACE_UNAVAILABLE', 'a record endpoint refuses a create replay');
  await rejects(links.delete(linker, f.spaceId, 'alpha', recordGone.linkId), 'SPACE_UNAVAILABLE',
    'and a delete replay');
  await pool.query(`UPDATE collections SET lifecycle='active' WHERE space_id=$1`, [f.spaceId]);
  assert.equal((await links.delete(linker, f.spaceId, 'alpha', recordGone.linkId)).replayed, true);
});

test('record deletion follows its links: restrict refuses it whole, detach tombstones links with events and outbox', async () => {
  const f = await fixture();
  const target = ref('record', 'beta', f.betaRecord);
  const detaching = await create(f.owner, f, 'alpha', ref('record', 'alpha', f.alphaRecord), target, 'detach');
  const restricting = await create(f.owner, f, 'beta', target, ref('source', 'beta', f.betaSource), 'restrict');
  const outbox = async () => (await pool.query('SELECT count(*)::int AS n FROM projection_outbox WHERE space_id=$1 AND record_id=$2',
    [f.spaceId, f.betaRecord])).rows[0].n;
  const before = { links: await linkRows(f.spaceId), events: await events(f.spaceId), outbox: await outbox() };
  // Mixed policies refuse the whole deletion: no tombstone, no detach, no event, no outbox entry.
  await rejects(deleteRecord(f.owner, f, 'beta', f.betaRecord), 'LINK_RESTRICTED');
  assert.deepEqual({ links: await linkRows(f.spaceId), events: await events(f.spaceId), outbox: await outbox() }, before);
  // A batch item reports it as its own failure.
  const batch = await services.batches.ingest(f.owner, f.spaceId, 'beta', `b-${randomUUID()}`,
    JSON.stringify([JSON.stringify({ operation: 'delete', id: f.betaRecord, expectedRevision: 1 })]), false);
  assert.deepEqual(batch.items.map(item => [item.state, item.failureCode]), [['failed', 'LINK_RESTRICTED']]);
  assert.equal(await recordLive(f, f.betaRecord), true);
  await links.delete(f.owner, f.spaceId, 'beta', restricting.linkId);
  const deleted = await deleteRecord(f.owner, f, 'beta', f.betaRecord);
  assert.equal(deleted.revision, 2);
  assert.equal(await recordLive(f, f.betaRecord), false);
  assert.equal(await outbox(), before.outbox + 1, 'the record delete has its own projection entry');
  assert.deepEqual((await events(f.spaceId)).slice(-2), [
    { kind: 'link', entity_id: restricting.linkId, revision: 2, operation: 'delete', by_request: true, delivery_state: 'pending' },
    { kind: 'link', entity_id: detaching.linkId, revision: 2, operation: 'detach', by_request: false, delivery_state: 'pending' }]);
  const replayed = await links.delete(f.owner, f.spaceId, 'alpha', detaching.linkId);
  assert.deepEqual({ ...replayed, deletedAt: null }, { ...detaching, revision: 2, deleted: true, deletedAt: null, replayed: true,
    erasure: retained }, 'deleting a detached link replays, and its row is retained');
  assert.ok(replayed.deletedAt);
  await rejects(links.get(f.owner, f.spaceId, 'alpha', detaching.linkId), 'NOT_FOUND');
  await rejects(create(f.owner, f, 'alpha', ref('record', 'alpha', f.alphaRecord), target), 'NOT_FOUND', 'a deleted endpoint');
});

test('source deletion detaches links, erases the original bytes and reports what remains', async () => {
  const f = await fixture();
  const sourceRef = ref('source', 'alpha', f.alphaSource);
  const key = await objectKey(f, f.alphaSource);
  assert.equal(f.r2.objects.has(key), true);
  const citing = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'cites', statement: 'The alpha report.',
    attributedTo: 'archive', evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }] });
  const restricting = await create(f.owner, f, 'alpha', ref('record', 'alpha', f.alphaRecord), sourceRef, 'restrict');
  const detaching = await create(f.owner, f, 'beta', sourceRef, ref('record', 'beta', f.betaRecord), 'detach');
  const deleter = await f.agent([['alpha', ['sources:read', 'sources:write']]]);
  await rejects(f.sources.delete(await f.agent([['alpha', ['sources:write']]]), f.spaceId, 'alpha', f.alphaSource), 'FORBIDDEN',
    'deleting needs sources:read too');
  await rejects(f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource), 'LINK_RESTRICTED');
  assert.equal((await f.sources.get(f.owner, f.spaceId, 'alpha', f.alphaSource)).sourceId, f.alphaSource);
  await links.delete(f.owner, f.spaceId, 'alpha', restricting.linkId);
  // The grant that wrote the original has not ended, so a copy it started could still land: the bytes are
  // removed at once, but the erasure is pending.
  const deleted = await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource);
  assert.deepEqual({ ...deleted, deletedAt: null }, { sourceId: f.alphaSource, collectionId: 'alpha', deletedAt: null, replayed: false,
    erasure: { originalBytes: 'pending', metadata: 'retained', backups: 'retained' } });
  assert.equal(f.r2.objects.has(key), false, 'the original bytes are gone from the store');
  for (const read of [() => f.sources.get(f.owner, f.spaceId, 'alpha', f.alphaSource),
    () => f.sources.content(f.owner, f.spaceId, 'alpha', f.alphaSource),
    () => f.sources.extraction(f.owner, f.spaceId, 'alpha', f.alphaSource),
    () => f.sources.extract(f.owner, f.spaceId, 'alpha', f.alphaSource)]) await rejects(read(), 'NOT_FOUND');
  assert.deepEqual((await linkRows(f.spaceId)).find(row => row.link_id === detaching.linkId), { link_id: detaching.linkId,
    tombstone: true, revision: 2 });
  assert.deepEqual((await events(f.spaceId)).filter(e => e.operation !== 'create').map(e => [e.kind, e.operation]),
    [['link', 'delete'], ['link', 'detach'], ['source', 'delete']]);
  // Claims that cite it are not changed; citing it anew is NOT_FOUND.
  assert.equal((await claims.get(f.owner, f.spaceId, 'alpha', citing.claimId)).evidence[0].sourceId, f.alphaSource);
  await rejects(claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'late', statement: 'x', attributedTo: 'y',
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }] }), 'NOT_FOUND');
  assert.deepEqual(await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource), { ...deleted, replayed: true });
  await rejects(f.sources.delete(deleter, f.spaceId, 'alpha', 'src_missing'), 'NOT_FOUND');

  // A copy the grant started lands after the removal. The erasure is not due again until the grant's writers ended.
  f.r2.objects.set(key, { bytes: Buffer.from('late copy') });
  await f.reconciler().erase(500);
  assert.equal(f.r2.objects.has(key), true, 'not due while the grant could still write');
  assert.equal((await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource)).erasure.originalBytes, 'pending');
  await settle(f);
  await f.reconciler().erase(500);
  assert.equal(f.r2.objects.has(key), false);
  assert.equal((await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource)).erasure.originalBytes, 'removed');
  // A copy the store confirms later still is found by the sweep, which reopens the erasure before deleting it, so
  // the report reads pending until the key is gone, also when the sweep's own delete fails.
  f.r2.objects.set(key, { bytes: Buffer.from('later copy') });
  f.r2.failDelete = candidate => candidate === key;
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  assert.equal(f.r2.objects.has(key), true);
  assert.equal((await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase(500);
  assert.equal(f.r2.objects.has(key), false);
  assert.equal((await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource)).erasure.originalBytes, 'removed');

  // Once its writers ended, a deletion whose removal fails is pending until the reconciler removes the bytes.
  const other = await f.source('alpha');
  const otherKey = await objectKey(f, other);
  await settle(f);
  f.r2.failDelete = candidate => candidate === otherKey;
  const pending = await f.sources.delete(f.owner, f.spaceId, 'alpha', other);
  assert.equal(pending.erasure.originalBytes, 'pending');
  assert.equal(f.r2.objects.has(otherKey), true);
  await assert.rejects(f.reconciler().erase(500), AggregateError, 'a failing erasure is reported');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', other)).erasure.originalBytes, 'pending', 'and stays pending');
  f.r2.failDelete = () => false;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', other)).erasure.originalBytes, 'removed',
    'a settled removal at deletion is complete');
  assert.equal(f.r2.objects.has(otherKey), false);
  assert.equal(f.r2.objects.has(await objectKey(f, f.betaSource)), true, 'a live source keeps its bytes');

  // A reference-only source held no bytes: nothing is queued and none is reported.
  const reference = (await f.sources.ingestReference(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'ref',
    locator: 'https://example.invalid/report', mimeType: 'text/html' })).sourceId;
  const queued = await erasures(f.spaceId);
  assert.deepEqual((await f.sources.delete(deleter, f.spaceId, 'alpha', reference)).erasure,
    { originalBytes: 'none', metadata: 'retained', backups: 'retained' });
  assert.equal(await erasures(f.spaceId), queued, 'no erasure is queued for a reference');
});

test('erasure retries move behind later requests, share the budget and stop short of it without failing', async () => {
  const f = await fixture();
  await drain(f);
  const first = await f.source('alpha');
  const second = await f.source('alpha');
  const [firstKey, secondKey] = [await objectKey(f, first), await objectKey(f, second)];
  await settle(f);
  // Both removals fail at deletion, so both erasures are due, the first one oldest.
  f.r2.failDelete = key => key === firstKey || key === secondKey;
  for (const id of [first, second]) assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', id)).erasure.originalBytes, 'pending');
  f.r2.failDelete = key => key === firstKey;
  // Only this file deletes sources in the shared database, so these two are the only source erasures due.
  await assert.rejects(f.reconciler().erase(1, 5000), AggregateError, 'the oldest erasure fails');
  await f.reconciler().erase(1, 5000);
  assert.equal(f.r2.objects.has(secondKey), false, 'the failed one moved behind the later request');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', second)).erasure.originalBytes, 'removed');
  // A source erasure whose delete never answers ends with the sources' half of the budget, unfinished rather than
  // failed, and the space still gets its turn in the same call, at the smallest and the production budget.
  f.r2.failDelete = () => false;
  f.r2.deleteDelay = key => key === firstKey ? Infinity : 0;
  for (const budget of [1000, 5000]) {
    const erased = await fixture();
    await services.spaces.update(erased.owner, erased.spaceId, 'readOnly');
    await services.spaces.delete(erased.owner, erased.spaceId);
    await settle(erased);
    const segment = Buffer.from(erased.spaceId).toString('base64url');
    // The other fixture's keys are listed through this store, as one cell's bucket.
    for (let i = 0; i < 3; i++) f.r2.objects.set(`originals/${segment}/upl_${i}/att_${i}`, { bytes: Buffer.from('x') });
    // The stalled source is due first: its erasure is older than the space's.
    await pool.query(`UPDATE original_erasures SET next_attempt_at=clock_timestamp()-interval '2 hours'
      WHERE space_id=$1 AND source_id=$2`, [f.spaceId, first]);
    const started = performance.now();
    // Other test files delete spaces in the shared database, so the page bound leaves room for theirs.
    await f.reconciler().erase(25, budget);
    assert.ok(performance.now() - started < budget, `the call ends within its ${budget} ms budget`);
    assert.deepEqual(f.r2.keys(`originals/${segment}/`), [], `the space's page was erased in the same ${budget} ms call`);
    assert.equal(f.r2.objects.has(firstKey), true);
    assert.equal((await spaces.erasure(erased.owner, erased.spaceId)).originalBytes, 'pending', 'until a listing finds nothing');
    await f.reconciler().erase(25, budget);
    assert.equal((await spaces.erasure(erased.owner, erased.spaceId)).originalBytes, 'erased');
  }
  f.r2.deleteDelay = () => 0;
  await f.reconciler().erase(500, 5000);
  assert.equal(f.r2.objects.has(firstKey), false, 'and the stalled source was retried');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', first)).erasure.originalBytes, 'removed');
  // A slow store cuts a space's page short: no failure, and completion still waits for an empty listing.
  f.r2.deleteDelay = () => 40;
  const slow = await fixture();
  await services.spaces.update(slow.owner, slow.spaceId, 'readOnly');
  await services.spaces.delete(slow.owner, slow.spaceId);
  await settle(slow);
  const slowSegment = Buffer.from(slow.spaceId).toString('base64url');
  for (let i = 0; i < 60; i++) f.r2.objects.set(`staging/${slowSegment}/upl_${i}/att_${i}`, { bytes: Buffer.from('x') });
  let left = 60;
  // Each call must resolve; a page cut short by the budget is unfinished work, not a failure.
  for (let i = 0; i < 5 && left === 60; i++) {
    await f.reconciler().erase(500, 1000);
    left = f.r2.keys(`staging/${slowSegment}/`).length;
  }
  assert.ok(left > 0 && left < 60, `the page was cut short after some deletes (${left} left)`);
  assert.equal((await spaces.erasure(slow.owner, slow.spaceId)).originalBytes, 'pending');
  f.r2.deleteDelay = () => 0;
  for (let i = 0; i < 5 && (await spaces.erasure(slow.owner, slow.spaceId)).originalBytes === 'pending'; i++)
    await f.reconciler().erase(500, 5000);
  assert.deepEqual(f.r2.keys(`staging/${slowSegment}/`), []);
  assert.equal((await spaces.erasure(slow.owner, slow.spaceId)).originalBytes, 'erased');
});

test('a slow space at the head of the erasure page is moved behind every production tick, so the next space completes', async () => {
  const f = await fixture();
  await drain(f);
  const [slow, healthy] = [await fixture(), await fixture()];
  const segment = g => Buffer.from(g.spaceId).toString('base64url');
  for (const g of [slow, healthy]) {
    await services.spaces.update(g.owner, g.spaceId, 'readOnly');
    await services.spaces.delete(g.owner, g.spaceId);
    await settle(g);
  }
  // The slow space is due first. Both of its listings take 1.6 s and its staging delete never answers, so its store
  // calls would run into the budget's last tenth; the healthy space's keys are behind it.
  await pool.query(`UPDATE space_erasures SET next_attempt_at=clock_timestamp()-interval '3 hours' WHERE space_id=$1`,
    [slow.spaceId]);
  f.r2.objects.set(`staging/${segment(slow)}/upl_s/att_s`, { bytes: Buffer.from('x') });
  for (let i = 0; i < 3; i++) f.r2.objects.set(`originals/${segment(healthy)}/upl_${i}/att_${i}`, { bytes: Buffer.from('x') });
  f.r2.listDelay = after => after.includes(segment(slow)) ? 1600 : 0;
  f.r2.deleteDelay = key => key.includes(segment(slow)) ? Infinity : 0;
  const due = async g => (await pool.query(`SELECT extract(epoch FROM next_attempt_at)::float8 AS at FROM space_erasures WHERE space_id=$1`,
    [g.spaceId])).rows[0].at;
  const ticks = [];
  for (let tick = 0; tick < 4 && (await spaces.erasure(healthy.owner, healthy.spaceId)).originalBytes === 'pending'; tick++) {
    const before = await due(slow);
    const started = performance.now();
    // A call the budget cut short is unfinished, so the tick resolves.
    await f.reconciler().erase(25, 5000);
    const took = performance.now() - started;
    assert.ok(took < 5000, `tick ${tick + 1} ended within its budget (${Math.round(took)} ms)`);
    assert.ok(await due(slow) > before, `tick ${tick + 1} moved the slow space behind the due ones`);
    ticks.push(Math.round(took));
  }
  assert.deepEqual(f.r2.keys(`originals/${segment(healthy)}/`), []);
  assert.equal((await spaces.erasure(healthy.owner, healthy.spaceId)).originalBytes, 'erased',
    `the space behind it completed within bounded ticks (${ticks.join(', ')} ms)`);
  assert.equal(f.r2.objects.has(`staging/${segment(slow)}/upl_s/att_s`), true);
  assert.equal((await spaces.erasure(slow.owner, slow.spaceId)).originalBytes, 'pending');
  f.r2.listDelay = () => 0;
  f.r2.deleteDelay = () => 0;
  for (let i = 0; i < 4 && (await spaces.erasure(slow.owner, slow.spaceId)).originalBytes === 'pending'; i++)
    await f.reconciler().erase(25, 5000);
  assert.equal((await spaces.erasure(slow.owner, slow.spaceId)).originalBytes, 'erased', 'and the slow one once the store answers');
});

test('claim deletion follows the claim revision and read rules and its links', async () => {
  const f = await fixture();
  const writer = await f.agent([['alpha', ['claims:read', 'claims:write', 'sources:read']]]);
  const plain = await claims.create(writer, f.spaceId, 'alpha', { idempotencyKey: 'p', statement: 'plain', attributedTo: 'a' });
  const hidden = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'h', statement: 'beta', attributedTo: 'a',
    evidence: [{ collectionId: 'beta', sourceId: f.betaSource }] });
  await rejects(claims.delete(writer, f.spaceId, 'alpha', hidden.claimId, { baseRevision: 1 }), 'NOT_FOUND',
    'a claim citing an unreadable collection');
  await claims.revise(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 1, statement: 'plain 2', attributedTo: 'a' });
  await rejects(claims.delete(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 1 }), 'REVISION_CONFLICT');
  await rejects(claims.delete(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 3 }), 'NOT_FOUND');
  await rejects(claims.delete(writer, f.spaceId, 'alpha', plain.claimId, {}), 'INVALID_ARGUMENT');
  const claimRef = ref('claim', 'alpha', plain.claimId);
  const restricting = await create(f.owner, f, 'alpha', claimRef, ref('record', 'alpha', f.alphaRecord), 'restrict');
  await create(f.owner, f, 'alpha', ref('source', 'alpha', f.alphaSource), claimRef, 'detach');
  await rejects(claims.delete(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 2 }), 'LINK_RESTRICTED');
  assert.equal((await claims.get(writer, f.spaceId, 'alpha', plain.claimId)).revision, 2);
  await links.delete(f.owner, f.spaceId, 'alpha', restricting.linkId);
  const deleted = await claims.delete(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 2 });
  assert.deepEqual({ ...deleted, deletedAt: null }, { claimId: plain.claimId, collectionId: 'alpha', revision: 2, deletedAt: null,
    replayed: false, erasure: retained }, 'its revisions are retained, and no bytes were held');
  await rejects(claims.get(writer, f.spaceId, 'alpha', plain.claimId), 'NOT_FOUND');
  assert.equal((await claims.list(writer, f.spaceId, 'alpha')).claims.length, 0);
  assert.deepEqual(await claims.delete(writer, f.spaceId, 'alpha', plain.claimId, { baseRevision: 2 }), { ...deleted, replayed: true });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM links WHERE space_id=$1 AND NOT tombstone`, [f.spaceId])).rows[0].n, 0);
  assert.deepEqual((await events(f.spaceId)).filter(e => e.operation !== 'create').map(e => [e.kind, e.operation, e.revision]),
    [['link', 'delete', 2], ['link', 'detach', 2], ['claim', 'delete', 2]]);
});

test('a link racing its endpoint deletion through the services never leaves a live dangling link', async () => {
  for (const first of ['link', 'delete']) {
    const f = await fixture();
    const endpoint = ref('source', 'alpha', f.alphaSource);
    const anchor = ref('record', 'beta', f.betaRecord);
    if (first === 'delete') {
      // The link passed its endpoint checks and waits to insert while the deletion commits.
      const held = hold('INSERT INTO links');
      const linking = hookedLinks.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'race', type: 'cites', policy: 'detach',
        from: endpoint, to: anchor }).then(view => view, error => error);
      await held.at;
      const deleted = await f.sources.delete(f.owner, f.spaceId, 'alpha', f.alphaSource);
      assert.equal(deleted.replayed, false);
      held.release();
      const outcome = await linking;
      assert.equal(outcome.code, 'NOT_FOUND', `${first}: ${outcome.message}`);
    } else {
      // The deletion read its source live and waits to tombstone it while a detach link commits.
      const held = hold('UPDATE entity_refs SET tombstone=true');
      const deleting = f.hookedSources.delete(f.owner, f.spaceId, 'alpha', f.alphaSource);
      await held.at;
      const created = await links.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'race', type: 'cites', policy: 'detach',
        from: endpoint, to: anchor });
      held.release();
      assert.equal((await deleting).replayed, false);
      assert.deepEqual((await linkRows(f.spaceId)).find(row => row.link_id === created.linkId).tombstone, true,
        'the deletion detached the link committed while it waited');
    }
    const dangling = (await pool.query(`SELECT count(*)::int AS n FROM links l JOIN entity_refs e ON e.space_id=l.space_id
      AND e.collection_id=l.from_collection_id AND e.kind=l.from_kind AND e.entity_id=l.from_id
      WHERE l.space_id=$1 AND NOT l.tombstone AND e.tombstone`, [f.spaceId])).rows[0].n;
    assert.equal(dangling, 0, first);
  }
});

test('a restrict link created while its endpoint deletion waits refuses that deletion', async () => {
  const f = await fixture();
  const held = hold('UPDATE entity_refs SET tombstone=true');
  const deleting = f.hookedSources.delete(f.owner, f.spaceId, 'alpha', f.alphaSource).then(view => view, error => error);
  await held.at;
  await links.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'late-restrict', type: 'cites', policy: 'restrict',
    from: ref('source', 'alpha', f.alphaSource), to: ref('record', 'alpha', f.alphaRecord) });
  held.release();
  assert.equal((await deleting).code, 'LINK_RESTRICTED');
  assert.equal((await f.sources.get(f.owner, f.spaceId, 'alpha', f.alphaSource)).sourceId, f.alphaSource);
});

test('space deletion reports its blob-store erasure as pending until every original and staging key is gone', async () => {
  const f = await fixture();
  const segment = Buffer.from(f.spaceId).toString('base64url');
  // A staging object no ledger row knows, as a write that landed after its attempt settled.
  f.r2.objects.set(`staging/${segment}/upl_x/att_x`, { bytes: Buffer.from('stray') });
  const kept = await fixture();
  const keptKey = `originals/${Buffer.from(kept.spaceId).toString('base64url')}/upl_k/att_k`;
  f.r2.objects.set(keptKey, { bytes: Buffer.from('kept') });
  assert.ok(f.r2.keys(`originals/${segment}/`).length >= 2);
  await services.spaces.update(f.owner, f.spaceId, 'readOnly');
  const deleted = await services.spaces.delete(f.owner, f.spaceId);
  assert.deepEqual(deleted, { spaceId: f.spaceId, deleted: true,
    erasure: { spaceId: f.spaceId, database: 'erased', originalBytes: 'pending', backups: 'retained' } });
  // The space's upload grants have not ended, so a write they started could still land: keys are deleted, and
  // even an empty listing does not complete the erasure.
  await f.reconciler().erase(500, 5000);
  assert.deepEqual(f.r2.keys(`originals/${segment}/`), []);
  assert.deepEqual(f.r2.keys(`staging/${segment}/`), []);
  await f.reconciler().erase(500, 5000);
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).originalBytes, 'pending', 'writers could still land');
  f.r2.objects.set(`staging/${segment}/upl_z/att_z`, { bytes: Buffer.from('late') });
  await settle(f);
  await f.reconciler().erase(500, 5000);
  assert.deepEqual(f.r2.keys(`staging/${segment}/`), [], 'the late write was deleted');
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).originalBytes, 'pending', 'completion needs a listing that finds nothing');
  await f.reconciler().erase(500, 5000);
  assert.deepEqual(await spaces.erasure(f.owner, f.spaceId), { spaceId: f.spaceId, database: 'erased', originalBytes: 'erased',
    backups: 'retained' });
  // A write the store confirms after completion is found by the sweep, which reopens the erasure first, so the
  // report reads pending until the key is gone, also when the sweep's delete fails.
  const late = `originals/${segment}/upl_y/att_y`;
  f.r2.objects.set(late, { bytes: Buffer.from('late') });
  f.r2.failDelete = key => key === late;
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  assert.equal(f.r2.objects.has(late), true);
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).originalBytes, 'pending');
  f.r2.failDelete = () => false;
  for (let i = 0; i < 3 && (await spaces.erasure(f.owner, f.spaceId)).originalBytes === 'pending'; i++)
    await f.reconciler().erase(500, 5000);
  assert.deepEqual(f.r2.keys(`originals/${segment}/`), []);
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).originalBytes, 'erased');
  assert.equal(f.r2.objects.has(keptKey), true, 'another space keeps its bytes');
  await rejects(spaces.erasure(kept.owner, f.spaceId), 'NOT_FOUND', 'only the owner reads the report');
  assert.deepEqual(await spaces.erasure(kept.owner, kept.spaceId), { spaceId: kept.spaceId, database: 'pending',
    originalBytes: 'pending', backups: 'retained' }, 'a live space is not erased');
});

test('a committed space deletion whose erasure report cannot be read is reported deleted with its erasure pending', async () => {
  const f = await fixture();
  await services.spaces.update(f.owner, f.spaceId, 'readOnly');
  const erasure = spaces.erasure;
  spaces.erasure = async () => { throw new Error('cell unavailable'); };
  let deleted;
  try { deleted = await services.spaces.delete(f.owner, f.spaceId); } finally { spaces.erasure = erasure; }
  assert.deepEqual(deleted, { spaceId: f.spaceId, deleted: true,
    erasure: { spaceId: f.spaceId, database: 'pending', originalBytes: 'pending', backups: 'retained' } });
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).database, 'erased', 'the deletion committed');
});

test('an evidence mutation whose key or grant lapses after the final check, before COMMIT, rolls back whole', async () => {
  const f = await fixture();
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'cites-beta', statement: 'From beta.',
    attributedTo: 'archive', evidence: [{ collectionId: 'beta', sourceId: f.betaSource }] });
  const existing = await create(f.owner, f, 'alpha', ref('record', 'alpha', f.alphaRecord), ref('source', 'beta', f.betaSource));
  // Each deletion would also detach a link, so a rollback must take the detach with it.
  await create(f.owner, f, 'alpha', ref('claim', 'alpha', claim.claimId), ref('record', 'beta', f.betaRecord));
  await create(f.owner, f, 'alpha', ref('source', 'alpha', f.alphaSource), ref('record', 'beta', f.betaRecord));
  const sourceKey = await objectKey(f, f.alphaSource);
  const state = async () => ({ links: await linkRows(f.spaceId), events: await events(f.spaceId), erasures: await erasures(f.spaceId),
    live: (await pool.query(`SELECT kind,entity_id FROM entity_refs WHERE space_id=$1 AND NOT tombstone ORDER BY kind,entity_id`,
      [f.spaceId])).rows });
  const calls = {
    'link create': [[['alpha', all], ['beta', all]], actor => hookedLinks.create(actor, f.spaceId, 'alpha', { idempotencyKey: 'held',
      type: 'cites', policy: 'detach', from: ref('record', 'alpha', f.alphaRecord), to: ref('source', 'beta', f.betaSource) })],
    'link delete': [[['alpha', all], ['beta', all]], actor => hookedLinks.delete(actor, f.spaceId, 'alpha', existing.linkId)],
    'claim delete': [[['alpha', ['claims:read', 'claims:write']], ['beta', ['sources:read']]],
      actor => hookedClaims.delete(actor, f.spaceId, 'alpha', claim.claimId, { baseRevision: 1 })],
    'source delete': [[['alpha', ['sources:read', 'sources:write']], ['beta', []]],
      actor => f.hookedSources.delete(actor, f.spaceId, 'alpha', f.alphaSource)]
  };
  for (const [call, [grants, run]] of Object.entries(calls)) for (const lapsed of ['key', call === 'source delete' ? 'alpha' : 'beta']) {
    const expires = Date.now() + 3_000;
    const lapsing = await f.agent(grants.filter(([, capabilities]) => capabilities.length), { [lapsed]: new Date(expires) });
    const before = await state();
    // Every in-transaction check, the final grant statement included, has passed; only COMMIT is held past expiry.
    hooks.push({ match: 'COMMIT', exact: true, run: () => sleep(Math.max(0, expires + 300 - Date.now())) });
    await rejects(run(lapsing), 'FORBIDDEN', `${call} with ${lapsed} lapsed before COMMIT`);
    assert.equal(hooks.length, 0, 'the hook ran');
    assert.deepEqual(await state(), before, `${call} with ${lapsed} lapsed changed nothing`);
    assert.equal(f.r2.objects.has(sourceKey), true, 'no byte removal started');
  }
  // The same held COMMIT succeeds while every grant is still live.
  const live = await f.agent(calls['source delete'][0].filter(([, capabilities]) => capabilities.length));
  hooks.push({ match: 'COMMIT', exact: true, run: () => sleep(300) });
  assert.equal((await calls['source delete'][1](live)).replayed, false);
  assert.equal(hooks.length, 0, 'the hook ran');
});

test('a link replay is authorized against the stored link before its content is compared', async () => {
  const f = await fixture();
  const expires = Date.now() + 1_500;
  const linker = await f.agent([['alpha', all], ['beta', all]], { beta: new Date(expires) });
  const request = { idempotencyKey: 'stored', type: 'cites', policy: 'detach', from: ref('record', 'alpha', f.alphaRecord),
    to: ref('source', 'beta', f.betaSource) };
  const stored = await links.create(linker, f.spaceId, 'alpha', request);
  assert.deepEqual(await links.create(linker, f.spaceId, 'alpha', request), { ...stored, replayed: true });
  await rejects(links.create(linker, f.spaceId, 'alpha', { ...request, to: ref('source', 'alpha', f.alphaSource) }),
    'IDEMPOTENCY_MISMATCH', 'while the stored link is visible');
  await sleep(Math.max(0, expires + 200 - Date.now()));
  // The changed retry names only alpha endpoints, but the stored link reaches beta, which the key can no longer read.
  await rejects(links.create(linker, f.spaceId, 'alpha', { ...request, to: ref('source', 'alpha', f.alphaSource) }), 'NOT_FOUND',
    'an inaccessible stored link stays hidden from a changed retry');
  await rejects(links.get(linker, f.spaceId, 'alpha', stored.linkId), 'NOT_FOUND');
});

/** Upload `bytes` through a grant and finalize it; returns the source and its grant's staging and original keys. */
async function uploaded(f, bytes) {
  const grant = await f.sources.createUpload(f.owner, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 1024 });
  const attempt = await f.sources.upload(f.owner, f.spaceId, 'alpha', grant.grantId, new Blob([bytes]).stream(),
    { bytes: bytes.length, mimeType: 'application/octet-stream' });
  const source = await f.sources.finalizeUpload(f.owner, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  const segment = Buffer.from(f.spaceId).toString('base64url');
  return { sourceId: source.sourceId, staging: `staging/${segment}/${grant.grantId}/${attempt.attemptId}`,
    original: `originals/${segment}/${grant.grantId}/${attempt.attemptId}` };
}
const erasureRow = async (f, sourceId) => (await pool.query(`SELECT removed_at IS NOT NULL AS removed,observed::int
  FROM original_erasures WHERE space_id=$1 AND source_id=$2`, [f.spaceId, sourceId])).rows[0];

test('a deleted upload source is erased only once its staging copy is gone too', async () => {
  const f = await fixture();
  await drain(f);
  // Finalize tolerates a failed staging cleanup, so the committed attempt keeps a byte-identical staging copy.
  f.r2.failDelete = key => key.startsWith('staging/');
  const upload = await uploaded(f, randomBytes(300));
  assert.equal(f.r2.objects.has(upload.staging), true);
  assert.equal(f.r2.objects.has(upload.original), true);
  // Its writers ended; the deletion removes the original, but the staging copy's delete fails again.
  await settle(f);
  const deleted = await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId);
  assert.equal(deleted.erasure.originalBytes, 'pending', 'a staging copy that remains keeps the erasure pending');
  assert.equal(f.r2.objects.has(upload.original), false);
  assert.equal(f.r2.objects.has(upload.staging), true);
  assert.equal((await erasureRow(f, upload.sourceId)).removed, false);
  await assert.rejects(f.reconciler().erase(500, 5000), AggregateError);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase(500, 5000);
  assert.equal(f.r2.objects.has(upload.staging), false, 'the erasure removed the staging copy');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'removed');
  assert.equal((await pool.query(`SELECT staging_removed_at IS NOT NULL AS removed FROM source_upload_attempts
    WHERE space_id=$1 AND staging_key=$2`, [f.spaceId, upload.staging])).rows[0].removed, true, 'and recorded it in the ledger');
  // A staging copy the store confirms after completion is found by the sweep, which reopens the erasure.
  f.r2.objects.set(upload.staging, { bytes: Buffer.from('late staging') });
  f.r2.failDelete = key => key === upload.staging;
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase(500, 5000);
  assert.equal(f.r2.objects.has(upload.staging), false);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'removed');
});

test('a key the sweep finds while a removal is completing keeps the source and space erasures pending', async () => {
  const f = await fixture();
  await drain(f);
  const reconciler = new SourceUploadReconciler({ pool: hooked, originals: f.cell.originals }, 0);
  // Source: the removal has deleted the original and is about to record completion when a late copy lands; the
  // sweep finds it and its delete fails. The completion then records nothing.
  const sourceId = await f.source('alpha');
  const key = await objectKey(f, sourceId);
  f.r2.failDelete = candidate => candidate === key;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  await settle(f);
  f.r2.failDelete = () => false;
  const completing = hold('UPDATE original_erasures SET removed_at=clock_timestamp()', params => params[2] === sourceId);
  const erasing = reconciler.erase(500, 5000);
  await completing.at;
  assert.equal(f.r2.objects.has(key), false, 'the removal deleted the original first');
  f.r2.objects.set(key, { bytes: Buffer.from('late copy') });
  f.r2.failDelete = candidate => candidate === key;
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  completing.release();
  await erasing;
  assert.deepEqual(await erasureRow(f, sourceId), { removed: false, observed: 1 }, 'the stale completion did not land');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase(500, 5000);
  assert.equal(f.r2.objects.has(key), false);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
  // The count only grows.
  await assert.rejects(pool.query('UPDATE original_erasures SET observed=0 WHERE space_id=$1 AND source_id=$2',
    [f.spaceId, sourceId]), error => error.code === '23514' && error.constraint === 'original_erasures_transition');

  // Space: an empty listing is about to record completion when a late key lands, which the sweep finds and fails to delete.
  const erased = await fixture();
  await services.spaces.update(erased.owner, erased.spaceId, 'readOnly');
  await services.spaces.delete(erased.owner, erased.spaceId);
  await settle(erased);
  const late = `staging/${Buffer.from(erased.spaceId).toString('base64url')}/upl_l/att_l`;
  const listing = hold('UPDATE space_erasures SET originals_removed_at=clock_timestamp()', params => params[0] === erased.spaceId);
  const listed = reconciler.erase(500, 5000);
  await listing.at;
  f.r2.objects.set(late, { bytes: Buffer.from('late') });
  f.r2.failDelete = candidate => candidate === late;
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  listing.release();
  await listed;
  assert.equal((await spaces.erasure(erased.owner, erased.spaceId)).originalBytes, 'pending', 'the stale completion did not land');
  assert.equal(f.r2.objects.has(late), true);
  f.r2.failDelete = () => false;
  for (let i = 0; i < 3 && (await spaces.erasure(erased.owner, erased.spaceId)).originalBytes === 'pending'; i++)
    await f.reconciler().erase(500, 5000);
  assert.equal(f.r2.objects.has(late), false);
  assert.equal((await spaces.erasure(erased.owner, erased.spaceId)).originalBytes, 'erased');
  await assert.rejects(pool.query(`UPDATE space_erasures SET observed=0 WHERE space_id=$1`, [erased.spaceId]),
    error => error.code === '23514' && error.constraint === 'space_erasures_transition');
  assert.equal(hooks.length, 0, 'both completions were held');
});

test('link reads and writes still authorize each endpoint after array intrinsics are replaced', async () => {
  const f = await fixture();
  const alpha = ref('record', 'alpha', f.alphaRecord);
  const hidden = await create(f.owner, f, 'alpha', alpha, ref('source', 'beta', f.betaSource));
  const alphaOnly = await f.agent([['alpha', all], ['beta', ['records:read']]]);
  const nativeIterator = Array.prototype[Symbol.iterator];
  const nativeIncludes = Array.prototype.includes;
  // Any iteration repeats its first value in place of a beta endpoint, a beta collection, a fence or a sources capability,
  // and any includes admits them.
  const dropped = value => value === 'beta' || value?.collectionId === 'beta' || typeof value?.checkScope === 'function' ||
    (typeof value === 'string' && value.startsWith('sources:'));
  Array.prototype[Symbol.iterator] = function () {
    const inner = nativeIterator.call(this);
    let first;
    let started = false;
    return { next() {
      const step = inner.next();
      if (step.done) return step;
      if (!started) { started = true; first = step.value; return step; }
      return dropped(step.value) ? { value: first, done: false } : step;
    }, [Symbol.iterator]() { return this; } };
  };
  Array.prototype.includes = function (value, ...rest) { return dropped(value) || nativeIncludes.call(this, value, ...rest); };
  try {
    await rejects(links.get(alphaOnly, f.spaceId, 'alpha', hidden.linkId), 'NOT_FOUND');
    assert.deepEqual((await links.list(alphaOnly, f.spaceId, 'alpha', { endpoint: { kind: 'record', id: f.alphaRecord } })).links,
      []);
    await rejects(create(alphaOnly, f, 'alpha', alpha, ref('source', 'beta', f.betaSource)), 'FORBIDDEN');
    await rejects(links.delete(alphaOnly, f.spaceId, 'alpha', hidden.linkId), 'NOT_FOUND');
  } finally {
    Array.prototype[Symbol.iterator] = nativeIterator;
    Array.prototype.includes = nativeIncludes;
  }
  assert.equal((await links.get(f.owner, f.spaceId, 'alpha', hidden.linkId)).deleted, false);
});

/**
 * The erasure's keys left: the original unless removed at the current count, each unremoved attempt's staging copy and
 * its promoted copy unless that is the original, and found keys.
 */
async function erasureLeft(f, sourceId) {
  const row = (await pool.query(`SELECT x.removal_observed IS NOT DISTINCT FROM x.observed AS original_removed,
      cardinality(x.found_keys)::int AS found,x.removed_at IS NOT NULL AS removed,
      (SELECT coalesce(sum(CASE WHEN 'originals/'||substr(a.staging_key,9)=o.object_key THEN 1 ELSE 2 END),0)::int
        FROM source_upload_attempts a JOIN source_upload_grants g USING (space_id,collection_id,grant_id)
        WHERE g.space_id=x.space_id AND g.collection_id=x.collection_id AND g.source_id=x.source_id
          AND a.staging_removed_at IS NULL) AS attempts
    FROM original_erasures x JOIN original_objects o USING (space_id,collection_id,source_id)
    WHERE x.space_id=$1 AND x.source_id=$2`, [f.spaceId, sourceId])).rows[0];
  return { left: (row.original_removed ? 0 : 1) + row.attempts + row.found, removed: row.removed };
}

test('a removal against a slow store records each delete, so every production tick advances it until it completes', async () => {
  const f = await fixture();
  await drain(f);
  // The committed attempt keeps its staging copy; two failed attempts of the same grant left copies too.
  f.r2.failDelete = key => key.startsWith('staging/');
  const upload = await uploaded(f, randomBytes(200));
  const [, , grantId] = upload.staging.split('/');
  const segment = Buffer.from(f.spaceId).toString('base64url');
  const strays = [];
  for (const attemptId of ['att_x', 'att_y']) {
    const staging = `staging/${segment}/${grantId}/${attemptId}`;
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,failure_code,
        staging_removed_at) VALUES($1,'alpha',$2,$3,$4,'failed','abandoned',clock_timestamp())`, [f.spaceId, grantId, attemptId, staging]);
    for (const key of [staging, `originals/${segment}/${grantId}/${attemptId}`]) {
      f.r2.objects.set(key, { bytes: Buffer.from('stray') });
      strays.push(key);
    }
  }
  await settle(f);
  f.r2.failDelete = () => true;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
  // The sweep finds every key of the deleted source's grant, and its deletes fail.
  await assert.rejects(f.reconciler().sweep(1000), AggregateError);
  assert.deepEqual(await erasureLeft(f, upload.sourceId), { left: 8, removed: false }, 'original, attempt and six found keys');
  f.r2.failDelete = () => false;
  f.r2.deleteDelay = () => 800;
  const lefts = [8];
  for (let tick = 0; tick < 6 && !(await erasureLeft(f, upload.sourceId)).removed; tick++) {
    await f.reconciler().erase(25, 5000);
    const { left } = await erasureLeft(f, upload.sourceId);
    assert.ok(left < lefts.at(-1), `tick ${tick + 1} recorded progress (${lefts.join(' > ')} > ${left})`);
    lefts.push(left);
    if (tick === 0) {
      // Between checkpointed ticks a late copy of the original lands; the sweep finds it and cannot delete it.
      assert.equal(f.r2.objects.has(upload.original), false);
      f.r2.objects.set(upload.original, { bytes: Buffer.from('late copy') });
      f.r2.deleteDelay = () => 0;
      f.r2.failDelete = key => key === upload.original;
      await assert.rejects(f.reconciler().sweep(1000), AggregateError);
      lefts.push((await erasureLeft(f, upload.sourceId)).left);
      assert.ok(lefts.at(-1) > lefts.at(-2), 'the finding undid the original\'s recorded removal');
      // The deletion's replay cannot delete the original, but its failure no longer stops the erasure's other keys.
      assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
      lefts.push((await erasureLeft(f, upload.sourceId)).left);
      f.r2.failDelete = () => false;
      f.r2.deleteDelay = () => 800;
    }
  }
  f.r2.deleteDelay = () => 0;
  assert.equal((await erasureLeft(f, upload.sourceId)).removed, true, `completed within bounded ticks (${lefts.join(' > ')})`);
  assert.ok(lefts.length > 3, 'over more than one tick');
  for (const key of [upload.original, upload.staging, ...strays]) assert.equal(f.r2.objects.has(key), false, key);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'removed');
});

test('an erase transaction that stalls past its call bound with budget left is reported, not taken as unfinished', async () => {
  const f = await fixture();
  await drain(f);
  const reconciler = new SourceUploadReconciler({ pool: hooked, originals: f.cell.originals }, 0);
  const page = hold('ORDER BY x.next_attempt_at,x.space_id');
  const erasing = reconciler.erase(25, 10_000);
  await page.at;
  await assert.rejects(erasing, error => error instanceof AggregateError &&
    error.errors.some(item => item.message === 'Upload cleanup call timed out'));
  page.release();
});

/**
 * A deleted upload source whose committed attempt kept its staging copy and whose grant has two failed attempts the
 * ledger does not record removed, each with a staging and a promoted copy; and a deleted space with three keys behind it.
 */
async function slowErasure(f) {
  f.r2.failDelete = key => key.startsWith('staging/');
  const upload = await uploaded(f, randomBytes(200));
  const [, segment, grantId] = upload.staging.split('/');
  const keys = [upload.original, upload.staging];
  for (const attemptId of ['att_x', 'att_y']) {
    const staging = `staging/${segment}/${grantId}/${attemptId}`;
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,failure_code)
      VALUES($1,'alpha',$2,$3,$4,'failed','abandoned')`, [f.spaceId, grantId, attemptId, staging]);
    for (const key of [staging, `originals/${segment}/${grantId}/${attemptId}`]) {
      f.r2.objects.set(key, { bytes: Buffer.from('stray') });
      keys.push(key);
    }
  }
  f.r2.failDelete = () => true;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await settle(f, false);
  assert.deepEqual(await erasureLeft(f, upload.sourceId), { left: 6, removed: false }, 'the original, its staging copy and four stray keys');
  // The deleted space's own originals and three more keys are in the reconciler's bucket.
  const space = await deletedSpace(f, 3);
  return { ...upload, keys, segment, space };
}
/** A space deleted after storing its two sources in `f`'s bucket, with `extra` more original keys there, due now. */
async function deletedSpace(f, extra) {
  const space = await fixture(f.r2);
  await services.spaces.update(space.owner, space.spaceId, 'readOnly');
  await services.spaces.delete(space.owner, space.spaceId);
  await settle(space);
  space.prefixes = ['originals', 'staging'].map(kind => `${kind}/${Buffer.from(space.spaceId).toString('base64url')}/`);
  assert.equal(f.r2.keys(space.prefixes[0]).length, 2, 'its sources\' originals are in the shared bucket');
  for (let i = 0; i < extra; i++) f.r2.objects.set(`${space.prefixes[0]}upl_${i}/att_${i}`, { bytes: Buffer.from('x') });
  return space;
}
const spaceKeys = (f, space) => space.prefixes.flatMap(prefix => f.r2.keys(prefix));
/** Run production ticks until the source and the space are erased: each ends in budget and records a source delete. */
async function ticks(f, erasure, reconciler, most) {
  const lefts = [(await erasureLeft(f, erasure.sourceId)).left];
  const took = [];
  const pending = async () => !(await erasureLeft(f, erasure.sourceId)).removed ||
    (await spaces.erasure(erasure.space.owner, erasure.space.spaceId)).originalBytes === 'pending';
  for (let tick = 0; tick < most && await pending(); tick++) {
    const started = performance.now();
    await reconciler.erase(25, 5000);
    took.push(Math.round(performance.now() - started));
    assert.ok(took.at(-1) < 5000, `tick ${tick + 1} ended within its budget (${took.join(', ')} ms)`);
    const { left } = await erasureLeft(f, erasure.sourceId);
    if (lefts.at(-1) > 0) assert.ok(left < lefts.at(-1), `tick ${tick + 1} recorded a delete (${lefts.join(' > ')} > ${left})`);
    lefts.push(left);
  }
  f.r2.deleteDelay = () => 0;
  assert.equal((await erasureLeft(f, erasure.sourceId)).removed, true, `completed within bounded ticks (${lefts.join(' > ')})`);
  for (const key of erasure.keys) assert.equal(f.r2.objects.has(key), false, key);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', erasure.sourceId)).erasure.originalBytes, 'removed');
  assert.equal((await spaces.erasure(erasure.space.owner, erasure.space.spaceId)).originalBytes, 'erased',
    `the space behind it completed meanwhile (${took.join(', ')} ms)`);
  assert.deepEqual(spaceKeys(f, erasure.space), [], 'and none of its original or staging keys is left');
  return lefts;
}

test('every production tick records a delete of an erasure whose attempts have two slow keys each', async () => {
  const f = await fixture();
  await drain(f);
  const erasure = await slowErasure(f);
  // Each delete takes 1.1 s, so two do not fit the sources' store share; each key's delete is recorded on its own.
  f.r2.deleteDelay = key => key.includes(erasure.segment) ? 1100 : 0;
  const lefts = await ticks(f, erasure, f.reconciler(), 10);
  // Once the space behind it is erased, no space is due and the source's deletes may use the spaces' windows too.
  assert.ok(lefts.length > 3, `over several ticks (${lefts.join(' > ')})`);
});

test('an erasure whose page reads are slow still gets its store calls every production tick', async () => {
  const f = await fixture();
  await drain(f);
  const erasure = await slowErasure(f);
  // Every read of source erasure state takes 1.1 s; the store answers at once.
  const slow = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        if (typeof sql === 'string' && /^SELECT[\s\S]*FROM original_erasures/.test(sql)) await sleep(1100);
        return target.query(sql, ...rest);
      };
    } });
  } };
  await ticks(f, erasure, new SourceUploadReconciler({ pool: slow, originals: f.cell.originals }, 0), 4);
});

test('a slow source page, a stalled source delete and a slow retry never reach the spaces\' window of a production tick', async () => {
  // A 1.9 s page read, and one that reaches the page's 2 s deadline (two fifths of the 5 s budget).
  for (const pageMs of [1900, 2000]) {
    const f = await fixture();
    await drain(f);
    const sourceId = await f.source('alpha');
    const key = await objectKey(f, sourceId);
    f.r2.failDelete = candidate => candidate === key;
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
    f.r2.failDelete = () => false;
    await settle(f);
    // 150 more keys: listings of 100 take the space over several ticks.
    const space = await deletedSpace(f, 150);
    f.r2.deleteDelay = candidate => candidate === key ? Infinity : 0;
    // Each statement's end, by phase: the source page and retry turn are slow; the spaces' page read marks their window.
    let marks = { source: [], space: [] };
    let retries = 0;
    const timed = { connect: async () => {
      const client = await pool.connect();
      let phase;
      return new Proxy(client, { get(target, property) {
        if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
        return async (sql, ...rest) => {
          const text = typeof sql === 'string' ? sql : '';
          if (text.includes('original_erasures')) phase = 'source';
          if (text.includes('FROM space_erasures WHERE originals_removed_at IS NULL')) { phase = 'space'; marks.space.push(performance.now()); }
          if (text.includes('ORDER BY x.next_attempt_at')) await sleep(pageMs);
          if (/^UPDATE original_erasures SET next_attempt_at=/.test(text)) { retries++; await sleep(300); }
          const result = await target.query(sql, ...rest);
          if (phase === 'source') marks.source.push(performance.now());
          return result;
        };
      } });
    } };
    const reconciler = new SourceUploadReconciler({ pool: timed, originals: f.cell.originals }, 0);
    const took = [];
    for (let tick = 0; tick < 5 && (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'pending'; tick++) {
      const before = spaceKeys(f, space).length;
      marks = { source: [], space: [] };
      const started = performance.now();
      await reconciler.erase(25, 5000);
      took.push(Math.round(performance.now() - started));
      const label = `${pageMs} ms page, tick ${tick + 1} (${took.join(', ')} ms)`;
      assert.ok(took.at(-1) < 5000, `${label} ended within its budget`);
      assert.equal(marks.space.length, 1, `${label} read the space page`);
      // Source transactions end by 32/50 of the budget, 3.2 s; a timer may settle a few milliseconds late.
      const latest = Math.max(started, ...marks.source);
      assert.ok(latest <= marks.space[0] && latest - started <= 3200 + 25,
        `${label}: the last source statement ended at ${Math.round(latest - started)} ms, before the spaces' window`);
      assert.ok(spaceKeys(f, space).length < before ||
        (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'erased', `${label} advanced the space`);
    }
    assert.equal((await spaces.erasure(space.owner, space.spaceId)).originalBytes, 'erased',
      `the space completed within bounded ticks (${took.join(', ')} ms)`);
    assert.deepEqual(spaceKeys(f, space), []);
    if (pageMs < 2000) assert.ok(retries > 0, 'the stalled source was attempted and given its retry turn');
    assert.equal(f.r2.objects.has(key), true);
    f.r2.deleteDelay = () => 0;
    for (let i = 0; i < 5 && !(await erasureLeft(f, sourceId)).removed; i++) await f.reconciler().erase(25, 5000);
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
  }
});

test('a space page that cannot be read is reported with earlier source failures, and one cut at the budget is unfinished', async () => {
  const f = await fixture();
  await drain(f);
  const reconciler = new SourceUploadReconciler({ pool: hooked, originals: f.cell.originals }, 0);
  const sourceId = await f.source('alpha');
  const key = await objectKey(f, sourceId);
  f.r2.failDelete = candidate => candidate === key;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  await settle(f);
  const spacePage = 'FROM space_erasures WHERE originals_removed_at IS NULL';
  hooks.push({ match: spacePage, run: async () => { throw new Error('space page unavailable'); } });
  await assert.rejects(reconciler.erase(25, 5000), error => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors.some(item => item.message === 'space page unavailable'));
  f.r2.failDelete = () => false;
  hooks.push({ match: spacePage, run: () => sleep(1500) });
  await reconciler.erase(25, 1000);
  assert.equal(hooks.length, 0, 'the space page was read');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
});

test('a cleanup transaction that ends at its phase deadline is unfinished, however late its COMMIT is answered', async () => {
  // At erase(25, 5000): the source page ends by 2000 ms, source transactions by 3200 ms (after a page read of 900 ms or
  // more) and space records by 5000 ms. `holdTo` keeps a statement's answer until that instant after the tick started,
  // just inside its phase deadline, so COMMIT is sent at the edge; `commitTo` answers that COMMIT only at that instant.
  const page = 'ORDER BY x.next_attempt_at';
  // A stalled delete cut at its deadline records the source's retry turn itself; a failure's turn is taken by `erase`.
  const retry = 'UPDATE original_erasures SET next_attempt_at=';
  const spaceRecord = 'UPDATE space_erasures SET next_attempt_at=CASE';
  // A slow page and retry turn start the spaces' phase late enough that its record's transaction is bounded by the budget.
  const late = [{ match: page, holdTo: 900 }, { match: retry, holdTo: 3150 }];
  const cases = [
    ['source page answered 0.1 ms before its deadline', [{ match: page, holdTo: 1999.9 }]],
    ['source retry turn answered 0.1 ms before its deadline', [{ match: page, holdTo: 900 }, { match: retry, holdTo: 3199.9 }]],
    ['space record answered 0.1 ms before the budget', [...late, { match: spaceRecord, holdTo: 4999.9 }]],
    ['space record whose COMMIT is acknowledged after the budget', [...late, { match: spaceRecord, holdTo: 4900, commitTo: 5200 }]],
  ];
  for (const [label, rules] of cases) {
    const f = await fixture();
    await drain(f);
    const sourceId = await f.source('alpha');
    const key = await objectKey(f, sourceId);
    f.r2.failDelete = candidate => candidate === key;
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
    f.r2.failDelete = () => false;
    await settle(f);
    const space = await deletedSpace(f, 0);
    // The source's delete stalls, so its erasure stays due and takes its retry turn; the space's listing finds keys.
    f.r2.deleteDelay = candidate => candidate === key ? Infinity : 0;
    const edge = { rules, started: 0, spacePages: 0, discarded: 0 };
    const edgePool = { connect: async () => {
      const client = await pool.connect();
      let ruled;
      return new Proxy(client, { get(target, property) {
        if (property === 'release') return discard => { if (discard) edge.discarded++; return target.release(discard); };
        if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
        return async (sql, ...rest) => {
          const text = typeof sql === 'string' ? sql : '';
          if (text.includes('FROM space_erasures WHERE originals_removed_at IS NULL')) edge.spacePages++;
          const result = await target.query(sql, ...rest);
          const rule = edge.rules.find(item => text.includes(item.match));
          if (rule) { ruled = rule; while (performance.now() < edge.started + rule.holdTo); }
          if (text === 'COMMIT' && ruled?.commitTo) await sleep(edge.started + ruled.commitTo - performance.now());
          return result;
        };
      } });
    } };
    const reconciler = new SourceUploadReconciler({ pool: edgePool, originals: f.cell.originals }, 0);
    edge.started = performance.now();
    await reconciler.erase(25, 5000);
    const took = Math.round(performance.now() - edge.started);
    assert.ok(took < 5000 + 25, `${label}: the tick ended within its budget (${took} ms)`);
    assert.equal(edge.spacePages, 1, `${label}: the spaces' phase still ran`);
    assert.equal((await erasureLeft(f, sourceId)).removed, false, `${label}: the source erasure stays due`);
    assert.equal((await spaces.erasure(space.owner, space.spaceId)).originalBytes, 'pending', `${label}: so does the space`);
    if (rules.some(rule => rule.commitTo)) assert.ok(edge.discarded > 0, `${label}: the unacknowledged session was discarded`);
    // The next ticks, through the same pool, complete both.
    edge.rules = [];
    f.r2.deleteDelay = () => 0;
    for (let i = 0; i < 5 && (!(await erasureLeft(f, sourceId)).removed ||
      (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'pending'); i++) await reconciler.erase(25, 5000);
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed', label);
    assert.equal((await spaces.erasure(space.owner, space.spaceId)).originalBytes, 'erased', label);
    assert.deepEqual(spaceKeys(f, space), [], label);
  }
});

test('a cleanup COMMIT unanswered at the call bound with budget left is reported, not taken as unfinished', async () => {
  const f = await fixture();
  await drain(f);
  // The source page's transaction gets 2 s of its 4 s phase at erase(25, 10000); its COMMIT is answered after 2.5 s.
  let held = false;
  const stalled = { connect: async () => {
    const client = await pool.connect();
    let paged = false;
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        const result = await target.query(sql, ...rest);
        if (typeof sql === 'string' && sql.includes('ORDER BY x.next_attempt_at')) paged = true;
        if (sql === 'COMMIT' && paged && !held) { held = true; await sleep(2500); }
        return result;
      };
    } });
  } };
  await assert.rejects(new SourceUploadReconciler({ pool: stalled, originals: f.cell.originals }, 0).erase(25, 10_000),
    error => error instanceof AggregateError && error.errors.some(item => item.message === 'Upload cleanup call timed out'));
  assert.equal(held, true);
});

test('a slow space page after the sources\' latest phases still leaves the space a store call and a record every production tick', async () => {
  // At erase(25, 5000) source transactions end by 3200 ms, the space page by 4200 ms and space store calls by 4500 ms.
  const spacePage = 'FROM space_erasures WHERE originals_removed_at IS NULL';
  const cases = [
    ['a 900 ms space page', { delay: 900 }],
    ['a space page answered 50 ms before its 4200 ms deadline', { holdTo: 4150 }],
  ];
  for (const [label, slow] of cases) {
    const f = await fixture();
    await drain(f);
    const sourceId = await f.source('alpha');
    const key = await objectKey(f, sourceId);
    f.r2.failDelete = candidate => candidate === key;
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
    f.r2.failDelete = () => false;
    await settle(f);
    // 150 more keys: listings of 100 take the space over several ticks.
    const space = await deletedSpace(f, 150);
    // The source's delete stalls to its 2800 ms store deadline and its retry turn is held to 3150 ms, after a 900 ms page.
    f.r2.deleteDelay = candidate => candidate === key ? Infinity : 0;
    const mark = { started: 0, sources: [], spacePages: [], spaceStore: [], records: 0 };
    for (const call of ['list', 'delete']) {
      const original = f.r2[call].bind(f.r2);
      f.r2[call] = async (...args) => {
        const result = await original(...args);
        const subject = call === 'list' ? args[0]?.startAfter ?? '' : args[0];
        if (space.prefixes.some(prefix => subject.startsWith(prefix))) mark.spaceStore.push(performance.now() - mark.started);
        return result;
      };
    }
    const rules = [{ match: 'ORDER BY x.next_attempt_at', holdTo: 900 },
      { match: 'UPDATE original_erasures SET next_attempt_at=', holdTo: 3150 }, { match: spacePage, ...slow }];
    const timed = { connect: async () => {
      const client = await pool.connect();
      let phase;
      return new Proxy(client, { get(target, property) {
        if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
        return async (sql, ...rest) => {
          const text = typeof sql === 'string' ? sql : '';
          if (text.includes('original_erasures')) phase = 'source';
          if (text.includes(spacePage)) { phase = 'space'; mark.spacePages.push(performance.now() - mark.started); }
          if (text.startsWith('UPDATE space_erasures') && rest[0]?.[0] === space.spaceId) mark.records++;
          const result = await target.query(sql, ...rest);
          const rule = rules.find(item => text.includes(item.match));
          if (rule?.delay) await sleep(rule.delay);
          if (rule?.holdTo) while (performance.now() < mark.started + rule.holdTo);
          if (phase === 'source') mark.sources.push(performance.now() - mark.started);
          return result;
        };
      } });
    } };
    const reconciler = new SourceUploadReconciler({ pool: timed, originals: f.cell.originals }, 0);
    const took = [];
    for (let tick = 0; tick < 5 && (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'pending'; tick++) {
      const before = spaceKeys(f, space).length;
      Object.assign(mark, { sources: [], spacePages: [], spaceStore: [], records: 0 });
      mark.started = performance.now();
      await reconciler.erase(25, 5000);
      took.push(Math.round(performance.now() - mark.started));
      const at = `${label}, tick ${tick + 1} (${took.join(', ')} ms)`;
      assert.ok(took.at(-1) < 5000 + 25, `${at} ended within its budget`);
      assert.equal(mark.spacePages.length, 1, `${at} read the space page`);
      assert.ok(Math.max(0, ...mark.sources) <= mark.spacePages[0], `${at}: no source statement ended after the space page started`);
      assert.ok(mark.spaceStore.length > 0, `${at} made a space store call`);
      assert.ok(Math.max(...mark.spaceStore) <= 4500 + 25, `${at}: space store calls ended by ${Math.round(Math.max(...mark.spaceStore))} ms`);
      assert.ok(mark.records > 0, `${at} recorded the space's progress`);
      assert.ok(spaceKeys(f, space).length < before ||
        (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'erased', `${at} advanced the space`);
    }
    assert.equal((await spaces.erasure(space.owner, space.spaceId)).originalBytes, 'erased',
      `${label}: the space completed within bounded ticks (${took.join(', ')} ms)`);
    assert.deepEqual(spaceKeys(f, space), []);
    // A space page that runs past its deadline is unfinished: the tick resolves and the space it would have read stays due.
    // The source phases still run to their latest, so the page's own deadline, not its 2 s call bound, cuts it.
    const late = await deletedSpace(f, 0);
    const lateKeys = spaceKeys(f, late).length;
    rules.splice(2, 1, { match: spacePage, delay: 4500 });
    mark.started = performance.now();
    await reconciler.erase(25, 5000);
    assert.ok(performance.now() - mark.started < 5000 + 25, `${label}: a late space page ends within the budget`);
    assert.equal((await spaces.erasure(late.owner, late.spaceId)).originalBytes, 'pending');
    assert.equal(spaceKeys(f, late).length, lateKeys, `${label}: a space page cut at its deadline erased nothing`);
    rules.length = 0;
    f.r2.deleteDelay = () => 0;
    for (let i = 0; i < 5 && ((await spaces.erasure(late.owner, late.spaceId)).originalBytes === 'pending' ||
      !(await erasureLeft(f, sourceId)).removed); i++) await reconciler.erase(25, 5000);
    assert.equal((await spaces.erasure(late.owner, late.spaceId)).originalBytes, 'erased', `${label}: the next ticks complete it`);
    assert.deepEqual(spaceKeys(f, late), []);
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
  }
});

/** Reopen a settled source erasure as the sweep would on finding `keys`, which are put in `f`'s bucket. */
async function found(f, sourceId, keys) {
  for (const key of keys) f.r2.objects.set(key, { bytes: Buffer.from('found') });
  await pool.query(`UPDATE original_erasures SET removed_at=NULL,observed=observed+1,next_attempt_at=clock_timestamp(),
    found_keys=$3 WHERE space_id=$1 AND source_id=$2`, [f.spaceId, sourceId, keys]);
}
const foundKeys = async (f, sourceId) => (await pool.query(`SELECT found_keys FROM original_erasures WHERE space_id=$1
  AND source_id=$2`, [f.spaceId, sourceId])).rows[0].found_keys;
/** A deleted source whose original's delete failed, settled, and keys named `names` under its space's prefix. */
async function failedErasure(f, names) {
  const sourceId = await f.source('alpha');
  const original = await objectKey(f, sourceId);
  f.r2.failDelete = () => true;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await settle(f);
  const keys = names.map(name => `originals/${Buffer.from(f.spaceId).toString('base64url')}/upl_found/${name}`);
  return { sourceId, original, keys };
}

test('with no space due, a slow source page and slow deletes use the spaces\' windows and record progress every tick', async () => {
  const f = await fixture();
  await drain(f);
  const { sourceId, original, keys } = await failedErasure(f, ['att_a']);
  await found(f, sourceId, keys);
  // Other test files delete spaces in the shared database; this pool shows the ticks none due.
  const none = sql => typeof sql === 'string' ? sql.replace(/FROM space_erasures (s )?WHERE/g, 'FROM space_erasures $1WHERE false AND') : sql;
  let removalRecorded = 0;
  let started = 0;
  // The source page is answered 1.9 s after the tick started, inside its 2 s deadline.
  const slow = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        const result = await target.query(none(sql), ...rest);
        if (typeof sql === 'string' && sql.includes('ORDER BY x.next_attempt_at')) await sleep(started + 1900 - performance.now());
        if (typeof sql === 'string' && sql.includes('SET removal_observed=') && rest[0]?.[2] === sourceId) removalRecorded += result.rowCount;
        return result;
      };
    } });
  } };
  f.r2.deleteDelay = () => 1100;
  const reconciler = new SourceUploadReconciler({ pool: slow, originals: f.cell.originals }, 0);
  const took = [];
  for (let tick = 0; tick < 3 && !(await erasureLeft(f, sourceId)).removed; tick++) {
    started = performance.now();
    await reconciler.erase(25, 5000);
    took.push(Math.round(performance.now() - started));
    assert.ok(took.at(-1) < 5000 + 25, `tick ${tick + 1} ended within its budget (${took.join(', ')} ms)`);
    if (tick === 0) assert.equal(removalRecorded, 1, `tick 1 (${took[0]} ms) recorded the original's removal`);
  }
  f.r2.deleteDelay = () => 0;
  assert.equal((await erasureLeft(f, sourceId)).removed, true, `completed within 3 ticks (${took.join(', ')} ms)`);
  for (const key of [original, ...keys]) assert.equal(f.r2.objects.has(key), false, key);
});

test('a source key whose delete fails does not stop its erasure\'s other keys, and stays until it is deleted', async () => {
  const f = await fixture();
  await drain(f);
  const { sourceId, original, keys } = await failedErasure(f, ['att_a', 'att_b', 'att_c']);
  const [bad, ...good] = keys;
  await found(f, sourceId, keys);
  f.r2.failDelete = key => key === bad;
  await assert.rejects(f.reconciler().erase(25, 5000), error => error instanceof AggregateError &&
    error.errors.some(item => item.message === 'delete: provider unavailable'), 'the failure is reported');
  for (const key of [original, ...good]) assert.equal(f.r2.objects.has(key), false, `${key} was deleted in the same tick`);
  assert.deepEqual(await foundKeys(f, sourceId), [bad], 'and its delete recorded; the failed key remains');
  assert.equal((await erasureLeft(f, sourceId)).removed, false);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase(25, 5000);
  assert.equal(f.r2.objects.has(bad), false);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
});

test('a stalled source key, found or original, moves behind the erasure\'s other keys, which are deleted within two ticks', async () => {
  for (const stalls of ['found', 'original']) {
    const f = await fixture();
    await drain(f);
    const { sourceId, original, keys } = await failedErasure(f, stalls === 'found' ? ['att_a', 'att_b', 'att_c'] : ['att_b', 'att_c']);
    await found(f, sourceId, keys);
    const stalled = stalls === 'found' ? keys[0] : original;
    const healthy = [original, ...keys].filter(key => key !== stalled);
    // A space due through both ticks, its 150 keys listed 100 at a time, keeps the sources to their own window.
    const space = await deletedSpace(f, 150);
    f.r2.deleteDelay = key => key === stalled ? Infinity : 0;
    const took = [];
    for (let tick = 0; tick < 2 && healthy.some(key => f.r2.objects.has(key)); tick++) {
      const started = performance.now();
      await f.reconciler().erase(25, 5000);
      took.push(Math.round(performance.now() - started));
      assert.ok(took.at(-1) < 5000 + 25, `${stalls}: tick ${tick + 1} ended within its budget (${took.join(', ')} ms)`);
      assert.equal((await erasureLeft(f, sourceId)).removed, false, `${stalls}: never complete while the stalled key remains`);
    }
    for (const key of healthy) assert.equal(f.r2.objects.has(key), false, `${stalls}: ${key} deleted within 2 ticks`);
    const left = await erasureLeft(f, sourceId);
    assert.deepEqual(await foundKeys(f, sourceId), stalls === 'found' ? [stalled] : [], `${stalls}: and recorded`);
    assert.equal(left.left, 1, `${stalls}: only the stalled key is left`);
    f.r2.deleteDelay = () => 0;
    for (let i = 0; i < 5 && (!(await erasureLeft(f, sourceId)).removed ||
      (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'pending'); i++) await f.reconciler().erase(25, 5000);
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed', stalls);
    assert.equal(f.r2.objects.has(stalled), false);
    assert.deepEqual(spaceKeys(f, space), []);
  }
});

const deferredKeys = async (f, sourceId) => (await pool.query(`SELECT deferred_keys FROM original_erasures WHERE space_id=$1
  AND source_id=$2`, [f.spaceId, sourceId])).rows[0].deferred_keys;
const numbered = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
const unavailable = error => flat(error).filter(item => item?.message === 'delete: provider unavailable').length;
/** A pool whose ticks see no space erasure due: other test files delete spaces in the shared database. */
const noSpacesDue = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return (sql, ...rest) => target.query(typeof sql === 'string'
      ? sql.replace(/FROM space_erasures (s )?WHERE/g, 'FROM space_erasures $1WHERE false AND') : sql, ...rest);
  } });
} };

test('found keys that keep rejecting cannot fill every page: a key beyond the page is deleted within two ticks', async () => {
  const f = await fixture();
  await drain(f);
  const { sourceId, original, keys } = await failedErasure(f, [...numbered('att_bad_', 40), 'att_good']);
  const good = keys.at(-1);
  const bad = keys.slice(0, -1);
  await found(f, sourceId, keys);
  f.r2.failDelete = key => bad.includes(key);
  for (let tick = 0; tick < 2 && f.r2.objects.has(good); tick++) {
    await assert.rejects(f.reconciler().erase(25, 5000), error => unavailable(error) >= 39, `tick ${tick + 1} reports the failures`);
    assert.equal((await erasureLeft(f, sourceId)).removed, false, 'never complete while a failing key remains');
  }
  assert.equal(f.r2.objects.has(good), false, 'the key beyond the first page is deleted within 2 ticks');
  assert.equal(f.r2.objects.has(original), false);
  assert.deepEqual(await foundKeys(f, sourceId), bad, 'and recorded; only the failing keys remain');
  assert.deepEqual([...await deferredKeys(f, sourceId)].sort(), bad, 'each of them deferred once');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'pending');
  // The sweep advances the count after the deferrals; half the keys recover, and each leaves deferred_keys as recorded.
  await pool.query('UPDATE original_erasures SET observed=observed+1 WHERE space_id=$1 AND source_id=$2', [f.spaceId, sourceId]);
  f.r2.failDelete = key => bad.slice(20).includes(key);
  await assert.rejects(f.reconciler().erase(25, 5000), error => unavailable(error) === 20);
  assert.deepEqual([...await deferredKeys(f, sourceId)].sort(), bad.slice(20), 'a deferred key leaves deferred_keys once recorded');
  f.r2.failDelete = () => false;
  for (let tick = 0; tick < 2 && !(await erasureLeft(f, sourceId)).removed; tick++) await f.reconciler().erase(25, 5000);
  for (const key of [original, ...keys]) assert.equal(f.r2.objects.has(key), false, key);
  assert.deepEqual(await deferredKeys(f, sourceId), []);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed');
});

test('attempts whose staging copies keep rejecting cannot fill every page: one beyond it is removed within two ticks', async () => {
  const f = await fixture();
  await drain(f);
  const upload = await uploaded(f, randomBytes(200));
  const [, segment, grantId] = upload.staging.split('/');
  const staging = id => `staging/${segment}/${grantId}/${id}`;
  const promoted = id => `originals/${segment}/${grantId}/${id}`;
  const ids = [...numbered('att_0_', 20), 'att_z'];
  for (const id of ids) {
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,failure_code)
      VALUES($1,'alpha',$2,$3,$4,'failed','abandoned')`, [f.spaceId, grantId, id, staging(id)]);
    for (const key of [staging(id), promoted(id)]) f.r2.objects.set(key, { bytes: Buffer.from('stray') });
  }
  f.r2.failDelete = () => true;
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'pending');
  await settle(f, false);
  const bad = ids.slice(0, -1).map(staging);
  f.r2.failDelete = key => bad.includes(key);
  for (let tick = 0; tick < 2 && f.r2.objects.has(staging('att_z')); tick++) {
    await assert.rejects(f.reconciler().erase(25, 5000), error => unavailable(error) > 0, `tick ${tick + 1} reports the failures`);
    assert.equal((await erasureLeft(f, upload.sourceId)).removed, false, 'never complete while a failing key remains');
  }
  assert.equal(f.r2.objects.has(staging('att_z')), false, 'the attempt beyond the first page is removed within 2 ticks');
  assert.equal(f.r2.objects.has(promoted('att_z')), false, 'with its promoted copy');
  assert.equal((await pool.query(`SELECT staging_removed_at IS NOT NULL AS removed FROM source_upload_attempts
    WHERE space_id=$1 AND staging_key=$2`, [f.spaceId, staging('att_z')])).rows[0].removed, true, 'and recorded');
  assert.deepEqual([...await deferredKeys(f, upload.sourceId)].sort(), bad);
  f.r2.failDelete = () => false;
  for (let tick = 0; tick < 3 && !(await erasureLeft(f, upload.sourceId)).removed; tick++) await f.reconciler().erase(25, 5000);
  for (const key of [upload.original, upload.staging, ...ids.flatMap(id => [staging(id), promoted(id)])])
    assert.equal(f.r2.objects.has(key), false, key);
  assert.deepEqual(await deferredKeys(f, upload.sourceId), []);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', upload.sourceId)).erasure.originalBytes, 'removed');
});

test('keys that stall cannot fill every page: a key behind them is deleted within the documented bound, space due or not', async () => {
  for (const due of [true, false]) {
    const f = await fixture();
    await drain(f);
    // Two stalling keys not tried yet, then 38 that earlier removals deferred, fill the page ahead of a healthy key.
    const { sourceId, original, keys } = await failedErasure(f, [...numbered('att_a', 2), ...numbered('att_d', 38), 'att_z']);
    const healthy = keys.at(-1);
    await found(f, sourceId, keys);
    await pool.query('UPDATE original_erasures SET deferred_keys=$3 WHERE space_id=$1 AND source_id=$2',
      [f.spaceId, sourceId, keys.slice(2, -1)]);
    const space = due ? await deletedSpace(f, 250) : null;
    const reconciler = due ? f.reconciler() : new SourceUploadReconciler({ pool: noSpacesDue, originals: f.cell.originals }, 0);
    f.r2.deleteDelay = key => key !== healthy && keys.includes(key) ? Infinity : 0;
    // Behind k = 2 keys that stall or are cut: within k + 1 = 3 ticks.
    const took = [];
    for (let tick = 0; tick < 3 && f.r2.objects.has(healthy); tick++) {
      const spaceLeft = due && spaceKeys(f, space).length;
      const started = performance.now();
      const outcome = await reconciler.erase(25, 5000).then(() => null, error => error);
      took.push(Math.round(performance.now() - started));
      assert.ok(took.at(-1) < 5000 + 25, `${due}: tick ${tick + 1} ended within its budget (${took.join(', ')} ms)`);
      if (due) assert.ok(spaceKeys(f, space).length < spaceLeft, `${due}: tick ${tick + 1} still deleted space keys`);
      // With a space due, a stall is cut at the sources' store deadline, unfinished; with none, it hits the call bound.
      if (!due) assert.ok(flat(outcome).some(item => item?.message === 'Upload cleanup call timed out'), 'stalls are reported');
      assert.equal((await erasureLeft(f, sourceId)).removed, false, `${due}: never complete while a stalled key remains`);
    }
    assert.equal(f.r2.objects.has(healthy), false, `${due}: deleted within 3 ticks (${took.join(', ')} ms)`);
    assert.equal(f.r2.objects.has(original), false);
    assert.equal((await foundKeys(f, sourceId)).includes(healthy), false, `${due}: and recorded`);
    f.r2.deleteDelay = () => 0;
    for (let i = 0; i < 5 && (!(await erasureLeft(f, sourceId)).removed ||
      (due && (await spaces.erasure(space.owner, space.spaceId)).originalBytes === 'pending')); i++) await reconciler.erase(25, 5000);
    for (const key of keys) assert.equal(f.r2.objects.has(key), false, key);
    assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', sourceId)).erasure.originalBytes, 'removed', `${due}`);
    if (due) assert.deepEqual(spaceKeys(f, space), []);
  }
});

test('drain fails while an erasure of this file stays due, and passes once it can complete', async () => {
  const f = await fixture();
  await drain(f);
  const { sourceId, original, keys } = await failedErasure(f, ['att_a']);
  // A found key in no bucket of this file: drain can never delete it, so the erasure stays due.
  const stray = `originals/${Buffer.from(`sp_${randomUUID()}`).toString('base64url')}/upl_found/att_x`;
  await found(f, sourceId, [...keys, stray]);
  await assert.rejects(drain(), error => error instanceof AggregateError && error.message.includes(original), 'drain fails');
  assert.equal((await erasureLeft(f, sourceId)).removed, false);
  await pool.query('UPDATE original_erasures SET found_keys=array_remove(found_keys,$3) WHERE space_id=$1 AND source_id=$2',
    [f.spaceId, sourceId, stray]);
  await drain();
  assert.equal((await erasureLeft(f, sourceId)).removed, true);
});

/** Whether `promise` settles first or a backend waits on a lock in a statement containing `text`. */
async function settlesOrWaits(promise, text) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 250; i++) {
    if (settled) return 'settled';
    const waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock'
      AND position($1 in query)>0`, [text])).rows[0].n;
    if (waiting) return 'waits';
    await sleep(20);
  }
  return 'neither';
}
const citing = (f, sourceId, statement) => ({ statement, attributedTo: 'archive',
  evidence: [{ collectionId: 'alpha', sourceId }] });
const revisions = async (f, statement) => (await pool.query(`SELECT count(*)::int AS n FROM claim_revisions
  WHERE space_id=$1 AND statement=$2`, [f.spaceId, statement])).rows[0].n;

test('a claim citing a source serializes with its deletion, for create and revise, in both orders', async () => {
  const f = await fixture();
  const base = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'base', statement: 'base', attributedTo: 'a' });
  const writes = {
    create: (pooled, sourceId, statement) => pooled.create(f.owner, f.spaceId, 'alpha',
      { idempotencyKey: `c-${randomUUID()}`, ...citing(f, sourceId, statement) }),
    revise: (pooled, sourceId, statement) => pooled.revise(f.owner, f.spaceId, 'alpha', base.claimId,
      { baseRevision: 1, ...citing(f, sourceId, statement) }),
  };
  for (const [name, write] of Object.entries(writes)) {
    // The deletion commits first: the claim waits on the source's identity, then finds it deleted and writes nothing.
    const first = await f.source('alpha');
    const tombstoned = hold('INSERT INTO evidence_events', params => params[3] === 'source' && params[4] === first);
    const deleting = f.hookedSources.delete(f.owner, f.spaceId, 'alpha', first);
    await tombstoned.at;
    const refused = write(claims, first, `${name} after deletion`);
    assert.equal(await settlesOrWaits(refused, 'FOR SHARE'), 'waits', `${name}: the claim waits for the deletion`);
    tombstoned.release();
    await deleting;
    await rejects(refused, 'NOT_FOUND', `${name}: a source deleted first cannot be cited`);
    assert.equal(await revisions(f, `${name} after deletion`), 0);

    // The claim locks first: the deletion waits until the claim commits, and then finds it cited.
    const second = await f.source('alpha');
    const checked = hold('INSERT INTO claim_revisions');
    const writing = write(hookedClaims, second, `${name} before deletion`);
    await checked.at;
    const deleted = f.sources.delete(f.owner, f.spaceId, 'alpha', second);
    assert.equal(await settlesOrWaits(deleted, 'UPDATE entity_refs SET tombstone=true'), 'waits',
      `${name}: the deletion waits for the claim`);
    checked.release();
    const claim = await writing;
    assert.equal((await deleted).replayed, false);
    assert.equal(await revisions(f, `${name} before deletion`), 1);
    const order = (await pool.query(`SELECT (SELECT committed_at FROM evidence_events WHERE space_id=$1 AND kind='source'
        AND entity_id=$2 AND operation='delete') > (SELECT max(committed_at) FROM claim_revisions WHERE space_id=$1
        AND claim_id=$3) AS after`, [f.spaceId, second, claim.claimId])).rows[0];
    assert.equal(order.after, true, `${name}: the claim committed before the deletion`);
  }
  assert.equal(hooks.length, 0);
});

test('a claim revision and a link joining the claim and a cited source queue in either order, never deadlocking', async () => {
  const f = await fixture();
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'locks', statement: 'r1', attributedTo: 'a' });
  const join = key => ({ idempotencyKey: key, type: 'cites', policy: 'detach', from: ref('claim', 'alpha', claim.claimId),
    to: ref('source', 'alpha', f.alphaSource) });
  const revise = (pooled, baseRevision) => pooled.revise(f.owner, f.spaceId, 'alpha', claim.claimId,
    { baseRevision, ...citing(f, f.alphaSource, `r${baseRevision + 1}`) });

  // The revision holds its locks first: the link waits for it, then both commit.
  const checked = hold('INSERT INTO claim_revisions');
  const revising = revise(hookedClaims, 1);
  await checked.at;
  const linking = links.create(f.owner, f.spaceId, 'alpha', join('first'));
  assert.equal(await settlesOrWaits(linking, 'INSERT INTO links'), 'waits', 'the link waits for the revision');
  checked.release();
  assert.equal((await revising).revision, 2);
  assert.equal((await linking).replayed, false);

  // The link holds its locks first: the revision waits for it, then both commit.
  const linked = hold('INSERT INTO evidence_events', params => params[3] === 'link');
  const second = hookedLinks.create(f.owner, f.spaceId, 'alpha', join('second'));
  await linked.at;
  const revisingAgain = revise(claims, 2);
  assert.equal(await settlesOrWaits(revisingAgain, 'entity_refs'), 'waits', 'the revision waits for the link');
  linked.release();
  assert.equal((await second).replayed, false);
  assert.equal((await revisingAgain).revision, 3);
  assert.equal(hooks.length, 0);
});

test('claims citing sources lock them in the link guard\'s byte order, so a link between them never deadlocks', async () => {
  const f = await fixture();
  // The database's default collation must order the two collections differently from byte order, or this fixture
  // would not distinguish an order taken from the default collation from the guard's.
  const order = (await pool.query(`SELECT 'alpha'<'Beta' AS by_default,'alpha'<'Beta' COLLATE "C" AS by_bytes`)).rows[0];
  assert.deepEqual(order, { by_default: true, by_bytes: false });
  await services.collections.define(f.owner, f.spaceId, 'Beta', definition('Beta'));
  const upper = await f.source('Beta');
  const both = statement => ({ statement, attributedTo: 'archive',
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }, { collectionId: 'Beta', sourceId: upper }] });
  const base = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'order-base', statement: 'r1', attributedTo: 'a' });
  const writes = {
    create: (pooled, statement) => pooled.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: `o-${randomUUID()}`,
      ...both(statement) }),
    revise: async (pooled, statement) => pooled.revise(f.owner, f.spaceId, 'alpha', base.claimId,
      { baseRevision: (await claims.get(f.owner, f.spaceId, 'alpha', base.claimId)).revision, ...both(statement) })
  };
  const join = () => links.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: `j-${randomUUID()}`, type: 'cites',
    policy: 'detach', from: ref('source', 'alpha', f.alphaSource), to: ref('source', 'Beta', upper) });
  for (const [name, write] of Object.entries(writes)) {
    // The link rewrites Beta's row and waits for alpha's behind a share lock no one else conflicts with. A claim that
    // share-locked alpha before Beta would hold alpha against the link while it waits for Beta: a deadlock.
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM entity_refs WHERE space_id=$1 AND collection_id='alpha' AND kind='source'
        AND entity_id=$2 FOR SHARE`, [f.spaceId, f.alphaSource]);
      const linking = join();
      assert.equal(await settlesOrWaits(linking, 'INSERT INTO links'), 'waits', `${name}: the link waits for alpha`);
      const writing = write(claims, `${name} while linking`);
      assert.equal(await settlesOrWaits(writing, 'FOR SHARE'), 'waits', `${name}: the claim waits for the link`);
      await blocker.query('COMMIT');
      assert.equal((await linking).replayed, false, `${name}: the link commits`);
      assert.equal((await writing).statement, `${name} while linking`, `${name}: the claim commits`);
    } finally { blocker.release(); }

    // The claim holds both locks first: the link waits for it, then both commit.
    const checked = hold('INSERT INTO claim_revisions');
    const first = write(hookedClaims, `${name} before linking`);
    await checked.at;
    const linked = join();
    assert.equal(await settlesOrWaits(linked, 'INSERT INTO links'), 'waits', `${name}: the link waits for the claim`);
    checked.release();
    assert.equal((await first).statement, `${name} before linking`);
    assert.equal((await linked).replayed, false);
  }
  assert.equal(hooks.length, 0);
});

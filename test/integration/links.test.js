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

/** An in-memory R2 bucket: atomic put with its checksum, ordered list and an injectable delete fault. */
class MemoryR2 {
  objects = new Map();
  failDelete = () => false;
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
  async delete(key) { if (this.failDelete(key)) throw new Error('delete: provider unavailable'); this.objects.delete(key); }
  async list({ startAfter = '', limit = 1000 } = {}) {
    const after = [...this.objects.keys()].sort().filter(key => key > startAfter);
    return { objects: after.slice(0, limit).map(key => ({ key })), truncated: after.length > limit };
  }
  keys(prefix) { return [...this.objects.keys()].filter(key => key.startsWith(prefix)); }
}
const rejects = (promise, code, message) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `${message ?? ''}: ${error.code} ${error.message}`);
  return true;
}, message);

/** A pool whose hooks run once before the first statement containing their text. */
let hooks = [];
const hooked = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const hook = typeof sql === 'string' ? hooks.find(item => sql.includes(item.match)) : undefined;
      if (hook) { hooks = hooks.filter(item => item !== hook); await hook.run(); }
      return target.query(sql, ...rest);
    };
  } });
} };
/** Hold the first statement containing `match` until released. */
function hold(match) {
  let reached, release;
  const at = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  hooks.push({ match, run: async () => { reached(); await gate; } });
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
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });
const all = ['records:read', 'records:write', 'sources:read', 'sources:write', 'claims:read', 'claims:write'];

/** A space with collections alpha and beta, a record and a stored text source in each, and an agent factory. */
async function fixture() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of ['alpha', 'beta']) await services.collections.define(owner, spaceId, id, definition(id));
  const agent = async grants => verify((await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
    grants.map(([collectionId, capabilities]) => ({ collectionId, capabilities })))).secret);
  const r2 = new MemoryR2();
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
  assert.deepEqual({ ...replayed, deletedAt: null }, { ...detaching, revision: 2, deleted: true, deletedAt: null, replayed: true },
    'deleting a detached link replays');
  assert.ok(replayed.deletedAt);
  await rejects(links.get(f.owner, f.spaceId, 'alpha', detaching.linkId), 'NOT_FOUND');
  await rejects(create(f.owner, f, 'alpha', ref('record', 'alpha', f.alphaRecord), target), 'NOT_FOUND', 'a deleted endpoint');
});

test('source deletion detaches links, erases the original bytes and reports what remains', async () => {
  const f = await fixture();
  const sourceRef = ref('source', 'alpha', f.alphaSource);
  const key = (await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND source_id=$2',
    [f.spaceId, f.alphaSource])).rows[0].object_key;
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
  const deleted = await f.sources.delete(deleter, f.spaceId, 'alpha', f.alphaSource);
  assert.deepEqual({ ...deleted, deletedAt: null }, { sourceId: f.alphaSource, collectionId: 'alpha', deletedAt: null, replayed: false,
    erasure: { originalBytes: 'removed', metadata: 'retained', backups: 'retained' } });
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

  // A blob store that cannot delete leaves the erasure pending until the reconciler removes the bytes.
  const other = await f.source('alpha');
  const otherKey = (await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND source_id=$2',
    [f.spaceId, other])).rows[0].object_key;
  f.r2.failDelete = candidate => candidate === otherKey;
  const pending = await f.sources.delete(f.owner, f.spaceId, 'alpha', other);
  assert.equal(pending.erasure.originalBytes, 'pending');
  assert.equal(f.r2.objects.has(otherKey), true);
  await assert.rejects(f.reconciler().erase(), AggregateError, 'a failing erasure is reported');
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', other)).erasure.originalBytes, 'pending', 'and stays pending');
  f.r2.failDelete = () => false;
  await f.reconciler().erase();
  assert.equal(f.r2.objects.has(otherKey), false);
  assert.equal((await f.sources.delete(f.owner, f.spaceId, 'alpha', other)).erasure.originalBytes, 'removed');
  // A copy that lands after the erasure is found by the sweep, since the source's deletion is final.
  f.r2.objects.set(otherKey, { bytes: Buffer.from('late copy') });
  for (let page = 0; page < 20 && f.r2.objects.has(otherKey); page++) await f.reconciler().sweep(1000);
  assert.equal(f.r2.objects.has(otherKey), false);
  assert.equal(f.r2.objects.has((await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND source_id=$2',
    [f.spaceId, f.betaSource])).rows[0].object_key), true, 'a live source keeps its bytes');
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
    replayed: false });
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
  await f.reconciler().erase(25, 5000);
  assert.deepEqual(f.r2.keys(`originals/${segment}/`), []);
  assert.deepEqual(f.r2.keys(`staging/${segment}/`), []);
  assert.equal((await spaces.erasure(f.owner, f.spaceId)).originalBytes, 'pending', 'completion needs a listing that finds nothing');
  await f.reconciler().erase(25, 5000);
  assert.deepEqual(await spaces.erasure(f.owner, f.spaceId), { spaceId: f.spaceId, database: 'erased', originalBytes: 'erased',
    backups: 'retained' });
  // A write that lands after completion is still found: the sweep removes any key of a deleted space.
  f.r2.objects.set(`originals/${segment}/upl_y/att_y`, { bytes: Buffer.from('late') });
  for (let page = 0; page < 20 && f.r2.keys(`originals/${segment}/`).length; page++) await f.reconciler().sweep(1000);
  assert.deepEqual(f.r2.keys(`originals/${segment}/`), []);
  assert.equal(f.r2.objects.has(keptKey), true, 'another space keeps its bytes');
  await rejects(spaces.erasure(kept.owner, f.spaceId), 'NOT_FOUND', 'only the owner reads the report');
  assert.deepEqual(await spaces.erasure(kept.owner, kept.spaceId), { spaceId: kept.spaceId, database: 'pending',
    originalBytes: 'pending', backups: 'retained' }, 'a live space is not erased');
});

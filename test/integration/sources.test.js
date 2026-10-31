import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession, revokeSessionById } from '@authfn/core';
import { BlobWriteError, classifyError } from '../../packages/application/dist/index.js';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresSources, PostgresSpaces, SourceUploadReconciler, originalKey, postgresServices, sourceBounds }
  from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const pool = new pg.Pool({ connectionString: url, max: 8 });
test.after(() => pool.end());
const sha = value => createHash('sha256').update(value).digest('hex');

/** An in-memory R2 bucket with the binding's semantics: an atomic put that
 * stores nothing when its body errors, a SHA-256 option it verifies and keeps
 * as a checksum, and an idempotent delete. Faults are injectable per key. */
class MemoryR2 {
  objects = new Map();
  started = [];
  stored = [];
  failPut = () => false;
  failDelete = () => false;
  /** Runs before a put reads its body, so a test can hold a write in flight. */
  beforePut = async () => {};
  /** Runs after a put has read its whole body and before it stores and confirms. */
  afterBody = async () => {};
  /** Runs before a delete takes effect, so a test can hold one in flight. */
  beforeDelete = async () => {};
  async put(key, body, options = {}) {
    this.started.push(key);
    await this.beforePut(key);
    const chunks = [];
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    await this.afterBody(key);
    const bytes = Buffer.concat(chunks);
    if (options.sha256 !== undefined && options.sha256 !== sha(bytes)) throw new Error('put: checksum mismatch');
    if (this.failPut(key)) throw new Error('put: provider unavailable');
    this.objects.set(key, { bytes, sha256: options.sha256 });
    this.stored.push(key);
    return this.meta(key);
  }
  meta(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.length, checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} };
  }
  async head(key) { return this.meta(key); }
  async get(key) {
    const meta = this.meta(key);
    return meta && { ...meta, body: new Blob([this.objects.get(key).bytes]).stream() };
  }
  async delete(key) {
    await this.beforeDelete(key);
    if (this.failDelete(key)) throw new Error('delete: provider unavailable');
    this.objects.delete(key);
  }
  async list({ startAfter = '', limit = 1000 } = {}) {
    const after = [...this.objects.keys()].sort().filter(key => key > startAfter);
    return { objects: after.slice(0, limit).map(key => ({ key })), truncated: after.length > limit };
  }
  keys(prefix) { return [...this.objects.keys()].filter(key => key.startsWith(prefix)); }
}
const chunked = (bytes, { size = 3, fail, stallMs } = {}) => {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (stallMs && offset > 0) await sleep(stallMs);
      if (fail !== undefined && offset >= fail) { controller.error(new Error('socket closed')); return; }
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
      offset += size;
    }
  });
};
const read = async stream => {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) return Buffer.concat(chunks); chunks.push(Buffer.from(value)); }
};
const rejects = (promise, code, message) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `${message ?? ''}: ${error.code} ${error.message}`);
  return true;
}, message);

// One fault-injecting pool for metadata-commit failures and slow statements;
// other code uses the real pool. Each hook, fault or delay applies once; a
// hook or fault matches SQL containing its text, or equal to it when `exact`.
let faults = [];
let delays = [];
let hooks = [];
const faulty = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const matches = item => item.exact ? sql === item.match : sql.includes(item.match);
      const hook = typeof sql === 'string' ? hooks.find(matches) : undefined;
      if (hook) { hooks = hooks.filter(item => item !== hook); await hook.run(); }
      const fault = typeof sql === 'string' ? faults.find(matches) : undefined;
      if (fault) {
        faults = faults.filter(item => item !== fault);
        // A lost fault runs its statement, then loses the reply.
        if (fault.lost) await target.query(sql, ...rest);
        return Promise.reject(fault.error);
      }
      const delay = typeof sql === 'string' ? delays.find(item => sql === item.match) : undefined;
      if (delay) { delays = delays.filter(item => item !== delay); return sleep(delay.ms).then(() => target.query(sql, ...rest)); }
      return target.query(sql, ...rest);
    };
  } });
} };
/** A pool that holds its `n`th BEGIN until released, pausing a request between its transactions. */
function pauseAtBegin(n) {
  let count = 0;
  let reached, release;
  const at = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const paused = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        if (typeof sql === 'string' && sql.startsWith('BEGIN') && ++count === n) { reached(); await gate; }
        return target.query(sql, ...rest);
      };
    } });
  } };
  return { pool: paused, at, release };
}

const config = { database: memoryAdapter(), namespace: `sta33-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });

/** A space with collections alpha and beta, an owner, an alpha writer/reader agent and a second alpha agent. */
async function fixture() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of ['alpha', 'beta']) await services.collections.define(owner, spaceId, id, definition(id));
  const agentFor = async capabilities => verify((await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities }])).secret);
  const r2 = new MemoryR2();
  const blobs = new R2BlobStore(r2);
  return { spaceId, user, owner, r2, blobs, agent: await agentFor(['sources:read', 'sources:write']),
    other: await agentFor(['sources:read', 'sources:write']), writer: await agentFor(['sources:write']),
    sources: new PostgresSources(spaces, new Map([['cell-a', { pool, originals: blobs }]])),
    faulty: new PostgresSources(spaces, new Map([['cell-a', { pool: faulty, originals: blobs }]])),
    reconciler: grace => new SourceUploadReconciler({ pool, originals: blobs }, grace) };
}
const attempts = async (spaceId, grantId) => (await pool.query(`SELECT attempt_id,state,failure_code,observed_sha256,
  staging_removed_at IS NOT NULL AS removed FROM source_upload_attempts WHERE space_id=$1 AND grant_id=$2 ORDER BY started_at`,
[spaceId, grantId])).rows;
const sourceRows = async spaceId => (await pool.query(`SELECT (SELECT count(*)::int FROM sources WHERE space_id=$1) AS sources,
  (SELECT count(*)::int FROM original_objects WHERE space_id=$1) AS originals,
  (SELECT count(*)::int FROM entity_refs WHERE space_id=$1 AND kind='source') AS refs`, [spaceId])).rows[0];
const staging = (r2, spaceId) => r2.keys(`staging/${Buffer.from(spaceId).toString('base64url')}/`);
/** The blob key recorded for a committed source's original. */
const sourceKey = async (f, sourceId) => (await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND source_id=$2',
  [f.spaceId, sourceId])).rows[0].object_key;
/** Originals in a fixture's space that no committed source records. */
const strayOriginals = async f => {
  const kept = new Set((await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1', [f.spaceId])).rows.map(row => row.object_key));
  return f.r2.keys(`originals/${Buffer.from(f.spaceId).toString('base64url')}/`).filter(key => !kept.has(key));
};
/** Every grant, attempt, source and blob in a fixture's space. */
const effects = async f => ({ ...(await sourceRows(f.spaceId)), keys: f.r2.keys('').sort(), ledger: (await pool.query(
  `SELECT (SELECT count(*)::int FROM source_upload_grants WHERE space_id=$1) AS grants,
    (SELECT json_agg(json_build_array(attempt_id,state) ORDER BY attempt_id) FROM source_upload_attempts WHERE space_id=$1) AS attempts`,
  [f.spaceId])).rows[0] });

test('the R2 blob store stores nothing unless the streamed length and digest match, and keeps a SHA-256 checksum', async () => {
  const r2 = new MemoryR2();
  const blobs = new R2BlobStore(r2);
  const bytes = Buffer.from('immutable original bytes');
  assert.deepEqual(await blobs.put('k/ok', chunked(bytes), { bytes: bytes.length, sha256: sha(bytes) }), { sha256: sha(bytes), bytes: bytes.length });
  assert.deepEqual(await blobs.head('k/ok'), { bytes: bytes.length, sha256: sha(bytes) });
  assert.deepEqual(await read((await blobs.get('k/ok')).body), bytes);
  assert.deepEqual(await blobs.put('k/unchecked', bytes, { bytes: bytes.length }), { sha256: sha(bytes), bytes: bytes.length },
    'without an expected digest the digest is computed while streaming');
  const refused = async (key, body, options, reason) => {
    await assert.rejects(blobs.put(key, body, options), error => error instanceof BlobWriteError && error.reason === reason, reason);
    assert.equal(r2.objects.has(key), false, `${reason} stores nothing`);
  };
  await refused('k/long', chunked(bytes), { bytes: bytes.length - 1 }, 'length');
  await refused('k/short', chunked(bytes), { bytes: bytes.length + 1 }, 'length');
  await refused('k/digest', chunked(bytes), { bytes: bytes.length, sha256: sha('other') }, 'digest');
  await refused('k/interrupted', chunked(bytes, { fail: 6 }), { bytes: bytes.length }, 'interrupted');
  const aborted = new AbortController();
  setTimeout(() => aborted.abort(), 50);
  await refused('k/deadline', chunked(bytes, { stallMs: 200 }), { bytes: bytes.length, signal: aborted.signal }, 'deadline');
  await assert.rejects(blobs.put('k/bad', bytes, { bytes: -1 }), RangeError);
  r2.failPut = () => true;
  await assert.rejects(blobs.put('k/provider', bytes, { bytes: bytes.length }), /provider unavailable/,
    'a provider failure is not reported as a refused body');
  await blobs.delete('k/missing');
});

test('bounded text ingestion stores verified original bytes once and replays a retry with the same key', async () => {
  const f = await fixture();
  const text = 'Observed text é中';
  const request = { idempotencyKey: 'text-1', text, locator: 'https://example.invalid/page', capturedAt: '2026-01-02T03:04:05.123456Z' };
  const created = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', request);
  const bytes = Buffer.from(text);
  assert.equal(created.replayed, false);
  assert.deepEqual({ ...created.original, observedAt: null }, { referenceOnly: false, sha256: sha(bytes), byteSize: bytes.length,
    mimeType: 'text/plain', capturedAt: '2026-01-02T03:04:05.123Z', observedAt: null });
  assert.equal(created.locator, request.locator);
  const stored = f.r2.objects.get(await sourceKey(f, created.sourceId));
  assert.deepEqual(stored.bytes, bytes);
  assert.equal(stored.sha256, sha(bytes), 'the original carries its R2 checksum');
  const { source, body } = await f.sources.content(f.agent, f.spaceId, 'alpha', created.sourceId);
  assert.deepEqual(await read(body), bytes);
  assert.equal(source.sourceId, created.sourceId);

  const replay = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', request);
  assert.deepEqual({ ...replay, replayed: false }, created);
  assert.equal(replay.replayed, true);
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { ...request, text: 'changed' }), 'IDEMPOTENCY_MISMATCH');
  const { capturedAt: _capturedAt, ...uncaptured } = request;
  const { locator: _locator, ...unlocated } = request;
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', uncaptured), 'IDEMPOTENCY_MISMATCH');
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', unlocated), 'IDEMPOTENCY_MISMATCH');
  // Another credential's identical key is a different request identity.
  const other = await f.sources.ingestText(f.other, f.spaceId, 'alpha', request);
  assert.notEqual(other.sourceId, created.sourceId);
  assert.equal(f.r2.keys('originals/').length, 2, 'each source keeps its own copy of identical bytes');
  assert.notEqual(await sourceKey(f, other.sourceId), await sourceKey(f, created.sourceId));
  const unstated = await f.sources.ingestText(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'text-2', text });
  assert.equal(unstated.original.capturedAt, unstated.original.observedAt, 'an unstated capture time is the observation time');
  assert.equal((await f.sources.ingestText(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'text-2', text })).replayed, true);
  await rejects(f.sources.ingestText(f.owner, f.spaceId, 'beta', { idempotencyKey: 'text-2', text }), 'IDEMPOTENCY_MISMATCH',
    'the same key in another collection is not a second source');

  const before = await sourceRows(f.spaceId);
  for (const [bad, message] of [
    [{ idempotencyKey: 'big', text: 'x'.repeat(sourceBounds.textBytes + 1) }, 'over the text bound'],
    [{ idempotencyKey: 'empty', text: '' }, 'empty text'],
    [{ idempotencyKey: 'surrogate', text: 'a\ud800' }, 'malformed Unicode'],
    [{ idempotencyKey: 'binary', text: 'x', mimeType: 'application/pdf' }, 'a non-text MIME type'],
    [{ idempotencyKey: 'future', text: 'x', capturedAt: '2999-01-01T00:00:00Z' }, 'a future capture time'],
    [{ idempotencyKey: 'offset', text: 'x', capturedAt: '2026-01-01T00:00:00+01:00' }, 'a non-UTC capture time'],
    [{ idempotencyKey: 'extra', text: 'x', fetch: true }, 'an unknown field'],
  ]) await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', bad), 'INVALID_ARGUMENT', message);
  assert.deepEqual(await sourceRows(f.spaceId), before, 'refused ingestion writes no source rows');
  const ledger = (await pool.query(`SELECT g.finalized_at IS NOT NULL AS finalized,a.state,a.staging_removed_at IS NOT NULL AS removed
    FROM source_upload_grants g JOIN source_upload_attempts a USING (space_id,collection_id,grant_id) WHERE g.space_id=$1`, [f.spaceId])).rows;
  assert.ok(ledger.length >= 3 && ledger.every(row => row.finalized && row.state === 'committed' && row.removed));
  assert.deepEqual(staging(f.r2, f.spaceId), []);
  assert.deepEqual(await strayOriginals(f), []);
});

test('reference-only ingestion discloses absent bytes, never fetches, and requires a locator', async () => {
  const f = await fixture();
  const request = { idempotencyKey: 'ref-1', locator: 'https://example.invalid/never-fetched', mimeType: 'Text/HTML; charset=utf-8' };
  const created = await f.sources.ingestReference(f.agent, f.spaceId, 'alpha', request);
  assert.deepEqual({ ...created.original, capturedAt: null, observedAt: null },
    { referenceOnly: true, sha256: null, byteSize: null, mimeType: 'text/html', capturedAt: null, observedAt: null });
  assert.deepEqual(f.r2.keys(''), [], 'no bytes are fetched or stored');
  assert.deepEqual(await f.sources.content(f.agent, f.spaceId, 'alpha', created.sourceId), { source: created, body: null });
  assert.equal((await f.sources.ingestReference(f.agent, f.spaceId, 'alpha', request)).replayed, true);
  await rejects(f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { ...request, locator: 'https://example.invalid/other' }), 'IDEMPOTENCY_MISMATCH');
  await rejects(f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'ref-2' }), 'INVALID_ARGUMENT');
  await rejects(f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'ref-3', locator: 'x'.repeat(4097) }), 'INVALID_ARGUMENT');
  const twice = await Promise.allSettled([1, 2].map(() =>
    f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'ref-race', locator: 'urn:example:race' })));
  assert.deepEqual(twice.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(twice[0].value.sourceId, twice[1].value.sourceId, 'concurrent retries commit one source');
});

test('an upload grant streams, verifies and finalizes one immutable original bound to its actor', async () => {
  const f = await fixture();
  const bytes = randomBytes(5000);
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 8192 });
  assert.equal(grant.mimeType, 'application/octet-stream');
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), sourceBounds.grantSeconds * 1000);
  await rejects(f.sources.upload(f.other, f.spaceId, 'alpha', grant.grantId, chunked(bytes, { size: 512 }),
    { bytes: bytes.length, mimeType: 'application/octet-stream' }), 'NOT_FOUND', 'another credential cannot use the grant');
  const uploaded = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes, { size: 512 }),
    { bytes: bytes.length, mimeType: 'application/octet-stream' });
  assert.deepEqual({ sha256: uploaded.sha256, bytes: uploaded.bytes }, { sha256: sha(bytes), bytes: bytes.length });
  assert.equal(staging(f.r2, f.spaceId).length, 1);
  assert.equal(f.r2.keys('originals/').length, 0, 'nothing is an original before finalize');
  await rejects(f.sources.finalizeUpload(f.other, f.spaceId, 'alpha', grant.grantId, { attemptId: uploaded.attemptId }), 'NOT_FOUND');
  const finalized = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId,
    { attemptId: uploaded.attemptId, locator: 'upload:report.bin' });
  assert.deepEqual({ ...finalized.original, capturedAt: null, observedAt: null },
    { referenceOnly: false, sha256: sha(bytes), byteSize: bytes.length, mimeType: 'application/octet-stream', capturedAt: null, observedAt: null });
  assert.deepEqual(staging(f.r2, f.spaceId), [], 'staging is removed after commit');
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', finalized.sourceId)).body), bytes);
  assert.deepEqual(await attempts(f.spaceId, grant.grantId), [{ attempt_id: uploaded.attemptId, state: 'committed',
    failure_code: null, observed_sha256: sha(bytes), removed: true }]);
  const replay = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId,
    { attemptId: uploaded.attemptId, locator: 'upload:report.bin' });
  assert.deepEqual({ ...replay, replayed: false }, finalized);
  await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: uploaded.attemptId }), 'IDEMPOTENCY_MISMATCH');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes),
    { bytes: bytes.length, mimeType: 'application/octet-stream' }), 'FORBIDDEN', 'a finalized grant accepts no more bytes');
  await rejects(f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId), 'INVALID_ARGUMENT');
  // The committed original is immutable: rows refuse change, and bytes match their digest.
  await assert.rejects(pool.query('UPDATE original_objects SET byte_size=1 WHERE space_id=$1', [f.spaceId]), /immutable/);
  assert.equal(await sourceKey(f, finalized.sourceId), originalKey(f.spaceId, grant.grantId, uploaded.attemptId),
    'the original is stored under its attempt\'s own key');
  const stored = f.r2.objects.get(originalKey(f.spaceId, grant.grantId, uploaded.attemptId));
  assert.equal(sha(stored.bytes), finalized.original.sha256);
  stored.bytes = Buffer.from(stored.bytes); stored.bytes[0] ^= 1;
  const corrupt = await f.sources.content(f.agent, f.spaceId, 'alpha', finalized.sourceId);
  await rejects(read(corrupt.body), 'PROVIDER_UNAVAILABLE', 'bytes that no longer match their digest fail the read');
  stored.bytes = stored.bytes.subarray(1);
  await rejects(f.sources.content(f.agent, f.spaceId, 'alpha', finalized.sourceId), 'PROVIDER_UNAVAILABLE',
    'a stored size that differs from the record is refused before streaming');
});

test('declared and streamed MIME, size, digest and UTF-8 violations leave a failed attempt and no bytes', async () => {
  const f = await fixture();
  const bytes = Buffer.from('plain text body');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha',
    { mimeType: 'text/plain', maxBytes: 64, sha256: sha(bytes), expiresInSeconds: 60 });
  const upload = (body, declared) => f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, body, declared);
  // Declared violations are refused before any attempt or byte exists.
  await rejects(upload(chunked(bytes), { bytes: bytes.length, mimeType: 'text/html' }), 'INVALID_ARGUMENT', 'MIME');
  await rejects(upload(chunked(bytes), { bytes: 65, mimeType: 'text/plain' }), 'INVALID_ARGUMENT', 'size');
  await rejects(upload(chunked(bytes), { bytes: bytes.length, mimeType: 'text/plain', sha256: sha('x') }), 'INVALID_ARGUMENT', 'digest');
  await rejects(upload(chunked(bytes), { mimeType: 'text/plain' }), 'INVALID_ARGUMENT', 'an undeclared size');
  assert.deepEqual(await attempts(f.spaceId, grant.grantId), []);
  // Streamed violations fail their attempt and remove its staging.
  const streamed = [
    [chunked(Buffer.concat([bytes, Buffer.from('!')])), { bytes: bytes.length }, 'length_mismatch'],
    [chunked(bytes.subarray(1)), { bytes: bytes.length - 1 }, 'digest_mismatch'],
    [chunked(Buffer.from([0x61, 0xff, 0x62])), { bytes: 3 }, 'content_rejected'],
    [chunked(bytes, { fail: 6 }), { bytes: bytes.length }, 'interrupted'],
  ];
  for (const [body, declared] of streamed)
    await rejects(upload(body, { ...declared, mimeType: 'text/plain' }), 'INVALID_ARGUMENT');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    streamed.map(([, , code]) => ['failed', code, true]));
  const open = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'text/plain', maxBytes: 64 });
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', open.grantId, chunked(Buffer.from([0x61, 0xc3, 0x28])),
    { bytes: 3, mimeType: 'text/plain; charset=utf-8' }), 'INVALID_ARGUMENT', 'malformed UTF-8 text');
  assert.deepEqual((await attempts(f.spaceId, open.grantId)).map(row => row.failure_code), ['content_rejected']);
  assert.deepEqual(f.r2.keys(''), [], 'no refused byte is stored');
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 });
  // The grant is still usable for a valid attempt.
  const ok = await upload(chunked(bytes), { bytes: bytes.length, mimeType: 'text/plain' });
  assert.equal((await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: ok.attemptId })).original.sha256, sha(bytes));
  for (const request of [{ mimeType: 'text/plain', maxBytes: sourceBounds.uploadBytes + 1 }, { mimeType: 'text/plain', maxBytes: 0 },
    { mimeType: 'text/plain', maxBytes: 1, expiresInSeconds: sourceBounds.maxGrantSeconds + 1 }, { mimeType: 'not a type', maxBytes: 1 }])
    await rejects(f.sources.createUpload(f.agent, f.spaceId, 'alpha', request), 'INVALID_ARGUMENT');
});

test('grant expiry and revocation stop uploads and finalization with deterministic cleanup', async () => {
  const f = await fixture();
  const bytes = Buffer.from('expiring bytes');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const expired = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 1 });
  const cutOff = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 1 });
  const early = await f.sources.upload(f.agent, f.spaceId, 'alpha', expired.grantId, chunked(bytes), declared);
  const stalled = f.sources.upload(f.agent, f.spaceId, 'alpha', cutOff.grantId, chunked(bytes, { stallMs: 1500 }), declared);
  await rejects(stalled, 'FORBIDDEN', 'a stream still open at expiry is cut off');
  await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', expired.grantId, { attemptId: early.attemptId }), 'FORBIDDEN');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', cutOff.grantId, chunked(bytes), declared), 'FORBIDDEN');
  assert.deepEqual((await attempts(f.spaceId, expired.grantId)).map(row => [row.state, row.failure_code]), [['verified', null]]);
  assert.deepEqual((await attempts(f.spaceId, cutOff.grantId)).map(row => [row.state, row.failure_code]), [['failed', 'grant_expired']]);

  const revoked = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const streaming = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const verifiedAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', revoked.grantId, chunked(bytes), declared);
  const inFlight = f.sources.upload(f.agent, f.spaceId, 'alpha', streaming.grantId, chunked(bytes, { stallMs: 300 }), declared);
  await sleep(100);
  await rejects(f.sources.revokeUpload(f.other, f.spaceId, 'alpha', revoked.grantId), 'NOT_FOUND', 'another agent cannot revoke');
  const view = await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId);
  assert.ok(view.revokedAt);
  assert.equal((await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId)).revokedAt, view.revokedAt, 'revocation is idempotent');
  assert.ok((await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', streaming.grantId)).revokedAt);
  await rejects(inFlight, 'FORBIDDEN', 'a writer still streaming at revocation is refused');
  await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId, { attemptId: verifiedAttempt.attemptId }), 'FORBIDDEN');
  // The verified attempt's staging is gone, but it stays due until reconciliation rechecks its digest.
  assert.deepEqual((await attempts(f.spaceId, revoked.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_revoked', false]]);
  assert.deepEqual((await attempts(f.spaceId, streaming.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_revoked', true]]);
  assert.deepEqual(staging(f.r2, f.spaceId).length, 1, 'only the expired grant still holds staging, until reconciliation');

  const ownerRevokes = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  assert.ok((await f.sources.revokeUpload(f.owner, f.spaceId, 'alpha', ownerRevokes.grantId)).revokedAt, 'the space owner may revoke');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', ownerRevokes.grantId, chunked(bytes), declared), 'FORBIDDEN');
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 });
});

test('a failed metadata commit removes its own original but never bytes another source or attempt with the digest uses', async () => {
  const f = await fixture();
  const bytes = Buffer.from('shared digest bytes');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const start = async () => {
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 60 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
    return { grant, attempt, key: originalKey(f.spaceId, grant.grantId, attempt.attemptId) };
  };
  const refused = Object.assign(new Error('permission denied'), { code: 'FORBIDDEN' });

  // A transient failure leaves the promoted original and the verified attempt for a retry.
  const retried = await start();
  faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('could not serialize'), { code: '40001' }) }];
  await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', retried.grant.grantId, { attemptId: retried.attempt.attemptId }));
  assert.equal(f.r2.objects.has(retried.key), true);
  assert.deepEqual((await attempts(f.spaceId, retried.grant.grantId)).map(row => row.state), ['verified']);

  // A deterministic failure of another attempt with the same digest removes
  // only that attempt's bytes; the verified attempt above keeps its own.
  const blocked = await start();
  faults = [{ match: 'INSERT INTO sources', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', blocked.grant.grantId, { attemptId: blocked.attempt.attemptId }), 'FORBIDDEN');
  assert.deepEqual((await attempts(f.spaceId, blocked.grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'commit_failed', false]]);
  assert.deepEqual(staging(f.r2, f.spaceId), [`staging/${Buffer.from(f.spaceId).toString('base64url')}/${retried.grant.grantId}/${retried.attempt.attemptId}`],
    'only the verified attempt keeps staging');
  assert.equal(f.r2.objects.has(blocked.key), false, 'the failed attempt\'s original is removed');
  assert.equal(f.r2.objects.has(retried.key), true, 'another attempt with the same digest keeps its bytes');
  const committed = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', retried.grant.grantId, { attemptId: retried.attempt.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', committed.sourceId)).body), bytes);

  // Once a committed source has the digest, a failure of another attempt leaves its bytes too.
  const later = await start();
  faults = [{ match: 'INSERT INTO sources', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', later.grant.grantId, { attemptId: later.attempt.attemptId }), 'FORBIDDEN');
  assert.equal(f.r2.objects.has(later.key), false);
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', committed.sourceId)).body), bytes);

  // A digest nobody else has is removed with its failed attempt, and no metadata remains.
  const lone = Buffer.from('bytes nobody else has');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(lone), { ...declared, bytes: lone.length });
  faults = [{ match: 'UPDATE source_upload_grants SET finalized_at', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }), 'FORBIDDEN');
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, grant.grantId, attempt.attemptId)), false);
  assert.deepEqual(staging(f.r2, f.spaceId), []);
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 1, originals: 1, refs: 1 }, 'the failed commit wrote no source');

  // A failed text commit revokes its one-shot grant and leaves no bytes.
  faults = [{ match: 'INSERT INTO entity_refs', error: refused }];
  await rejects(f.faulty.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'lost', text: 'text nobody else has' }), 'FORBIDDEN');
  assert.deepEqual(await strayOriginals(f), []);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM source_upload_grants WHERE space_id=$1 AND revoked_at IS NOT NULL
    AND expected_sha256=$2`, [f.spaceId, sha('text nobody else has')])).rows[0].n, 1);
  assert.equal((await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'lost', text: 'text nobody else has' })).replayed, false,
    'the same key commits on retry');
});

test('reconciliation settles orphaned and partially finalized uploads only after their grant ends', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const bytes = Buffer.from('partially finalized');
  // A finalize that promoted bytes and then lost its commit to a transient fault.
  const partial = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
  const partialAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', partial.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
  faults = [{ match: 'INSERT INTO entity_refs', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }];
  await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', partial.grantId, { attemptId: partialAttempt.attemptId }));
  const partialKey = originalKey(f.spaceId, partial.grantId, partialAttempt.attemptId);
  assert.equal(f.r2.objects.has(partialKey), true);
  // An interrupted writer that never recorded its outcome.
  const orphan = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
  const orphanKey = `staging/${Buffer.from(f.spaceId).toString('base64url')}/${orphan.grantId}/att_orphan`;
  await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key)
    VALUES($1,'alpha',$2,'att_orphan',$3)`, [f.spaceId, orphan.grantId, orphanKey]);
  f.r2.objects.set(orphanKey, { bytes: Buffer.from('half') });
  // A committed source whose staging removal failed.
  const leftover = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
  const leftoverBytes = Buffer.from('committed, staging kept');
  const leftoverAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', leftover.grantId, chunked(leftoverBytes),
    { ...declared, bytes: leftoverBytes.length });
  f.r2.failDelete = key => key.startsWith('staging/');
  const kept = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', leftover.grantId, { attemptId: leftoverAttempt.attemptId });
  f.r2.failDelete = () => false;
  // A live grant's attempt is never touched.
  const live = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64 });
  const liveAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', live.grantId, chunked(bytes), { ...declared, bytes: bytes.length });

  const reconciler = f.reconciler(0);
  const due = async () => (await pool.query(`SELECT count(*)::int AS n FROM source_upload_attempts
    WHERE space_id=$1 AND staging_removed_at IS NULL`, [f.spaceId])).rows[0].n;
  assert.equal(await due(), 4);
  await f.reconciler(sourceBounds.reconcileGraceSeconds).step();
  assert.equal(await due(), 4, 'nothing settles within the grace period');
  await sleep(2100);
  // The reconciler is cell-wide; other spaces' ended attempts may share the page.
  while (await reconciler.step(500) === 500);
  assert.deepEqual(await attempts(f.spaceId, partial.grantId), [{ attempt_id: partialAttempt.attemptId, state: 'failed',
    failure_code: 'abandoned', observed_sha256: sha(bytes), removed: true }]);
  assert.deepEqual((await attempts(f.spaceId, orphan.grantId)).map(row => [row.state, row.failure_code, row.removed]), [['failed', 'abandoned', true]]);
  assert.deepEqual((await attempts(f.spaceId, leftover.grantId)).map(row => [row.state, row.removed]), [['committed', true]]);
  assert.equal(f.r2.objects.has(partialKey), false, 'the partially finalized attempt\'s original is removed');
  assert.deepEqual(staging(f.r2, f.spaceId).length, 1, 'only the live attempt keeps staging');
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', kept.sourceId)).body), leftoverBytes);
  assert.deepEqual((await attempts(f.spaceId, live.grantId)).map(row => row.state), ['verified']);
  await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', live.grantId);
  assert.equal(liveAttempt.sha256, sha(bytes));

  // One failing attempt does not stop the others and is retried later.
  const failing = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
  await f.sources.upload(f.agent, f.spaceId, 'alpha', failing.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
  await sleep(2100);
  f.r2.failDelete = () => true;
  await assert.rejects(reconciler.step(500), AggregateError);
  f.r2.failDelete = () => false;
  while (await reconciler.step(500) === 500);
  assert.equal(await due(), 1, 'the revoked live attempt stays due until its grant ends');
  assert.deepEqual(f.r2.keys(''), [await sourceKey(f, kept.sourceId)]);
});

test('source reads are scoped to collections the caller can read, without disclosing other collections', async () => {
  const f = await fixture();
  const alpha = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'a', text: 'alpha evidence' });
  const beta = await f.sources.ingestText(f.owner, f.spaceId, 'beta', { idempotencyKey: 'b', text: 'beta evidence' });
  assert.equal((await f.sources.get(f.agent, f.spaceId, 'alpha', alpha.sourceId)).sourceId, alpha.sourceId);
  assert.equal((await f.sources.get(f.owner, f.spaceId, 'beta', beta.sourceId)).sourceId, beta.sourceId);
  for (const read of [f.sources.get.bind(f.sources), f.sources.content.bind(f.sources)]) {
    // The ID of a source in an unreadable collection, asked through a readable one, is not found.
    await rejects(read(f.agent, f.spaceId, 'alpha', beta.sourceId), 'NOT_FOUND');
    // An unreadable collection fails the same way whether or not the source exists.
    await rejects(read(f.agent, f.spaceId, 'beta', beta.sourceId), 'FORBIDDEN');
    await rejects(read(f.agent, f.spaceId, 'beta', 'src_missing'), 'FORBIDDEN');
    await rejects(read(f.writer, f.spaceId, 'alpha', alpha.sourceId), 'FORBIDDEN', 'sources:write does not grant reads');
    await rejects(read(f.agent, f.spaceId, 'missing', alpha.sourceId), 'NOT_FOUND');
  }
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'beta', { idempotencyKey: 'c', text: 'x' }), 'FORBIDDEN');
  await rejects(f.sources.createUpload(f.agent, f.spaceId, 'beta', { mimeType: 'text/plain', maxBytes: 1 }), 'FORBIDDEN');
  // Authorization precedes request validation, so a caller without the grant learns nothing from its input.
  for (const [name, call] of [
    ['ingestText', () => f.sources.ingestText(f.agent, f.spaceId, 'beta', { idempotencyKey: '', text: '' })],
    ['ingestReference', () => f.sources.ingestReference(f.agent, f.spaceId, 'beta', { unknown: true })],
    ['createUpload', () => f.sources.createUpload(f.agent, f.spaceId, 'beta', { mimeType: 'bad', maxBytes: 0 })],
    ['upload', () => f.sources.upload(f.agent, f.spaceId, 'beta', '', chunked(Buffer.from('x')), {})],
    ['finalizeUpload', () => f.sources.finalizeUpload(f.agent, f.spaceId, 'beta', '', { attemptId: 1 })],
    ['revokeUpload', () => f.sources.revokeUpload(f.agent, f.spaceId, 'beta', '')],
    ['get', () => f.sources.get(f.agent, f.spaceId, 'beta', '')],
  ]) await rejects(call(), 'FORBIDDEN', name);
  // A read-only space refuses new sources and grants but still replays committed ones.
  await spaces.update(f.owner, f.spaceId, 'readOnly');
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'new', text: 'x' }), 'SPACE_UNAVAILABLE');
  await rejects(f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'text/plain', maxBytes: 1 }), 'SPACE_UNAVAILABLE');
  assert.equal((await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'a', text: 'alpha evidence' })).replayed, true);
  assert.equal((await f.sources.get(f.agent, f.spaceId, 'alpha', alpha.sourceId)).sourceId, alpha.sourceId);
  await spaces.update(f.owner, f.spaceId, 'suspended');
  await rejects(f.sources.get(f.agent, f.spaceId, 'alpha', alpha.sourceId), 'SPACE_UNAVAILABLE');
});

/** Hold the next R2 delete of a key under `prefix` until released. */
function holdDelete(r2, prefix) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const atDelete = new Promise(resolve => { reached = resolve; });
  r2.beforeDelete = async target => { if (target.startsWith(prefix)) { r2.beforeDelete = async () => {}; reached(); await held; } };
  return { atDelete, release };
}
/** A pool that records the backend of each connection while it is checked out. */
function trackedPool() {
  const busy = new Set();
  return { busy, pool: { connect: async () => {
    const client = await pool.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    busy.add(pid);
    return new Proxy(client, { get(target, property) {
      if (property === 'release') return (...args) => { busy.delete(pid); return target.release(...args); };
      return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    } });
  } } };
}

test('an original delete that lands after its remover\'s session ended never strands a source with the same digest', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const removers = {
    revocation: async (cell, grant) => {
      await new PostgresSources(spaces, new Map([['cell-a', cell]])).revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId);
    },
    reconciliation: async (cell, grant) => {
      await sleep(Math.max(0, Date.parse(grant.expiresAt) - Date.now()) + 50);
      while (await new SourceUploadReconciler(cell, 0).step(500) === 500);
    }
  };
  for (const [name, remove] of Object.entries(removers)) {
    const bytes = Buffer.from(`removed by ${name} while the digest is uploaded again`);
    // Attempt A promotes its bytes, then its metadata commit fails transiently.
    const first = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 128, expiresInSeconds: 1 });
    const firstAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', first.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('could not serialize'), { code: '40001' }) }];
    await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', first.grantId, { attemptId: firstAttempt.attemptId }));
    assert.equal((await strayOriginals(f)).length, 1, `${name}: A promoted its original`);

    // The remover fails A and sends its original's delete, which R2 holds.
    // Its database session then ends, releasing whatever it held.
    const { atDelete, release } = holdDelete(f.r2, `originals/${Buffer.from(f.spaceId).toString('base64url')}/`);
    const tracked = trackedPool();
    const removal = remove({ pool: tracked.pool, originals: f.blobs }, first).catch(error => error);
    await atDelete;
    for (const pid of tracked.busy) await pool.query('SELECT pg_terminate_backend($1)', [pid]);

    // Meanwhile another grant uploads and commits the same bytes.
    const second = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 128 });
    const secondAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', second.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', second.grantId, { attemptId: secondAttempt.attemptId });
    release();
    await removal;
    assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes,
      `${name}: the committed source keeps its bytes after the delete lands`);
    assert.deepEqual((await attempts(f.spaceId, first.grantId)).map(row => row.state), ['failed'], name);
    assert.deepEqual(await strayOriginals(f), [], `${name}: A's original is gone`);
  }
});

/** Hold the next R2 put of `key` before it reads its body, until released. */
function holdPut(r2, key) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const atPut = new Promise(resolve => { reached = resolve; });
  r2.beforePut = async target => { if (target === key) { r2.beforePut = async () => {}; reached(); await held; } };
  return { atPut, release };
}

test('a finalize copy that lands after revocation leaves no original of the failed attempt, at once or after reconciliation', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const race = async (text, sources) => {
    const bytes = Buffer.from(text);
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const key = originalKey(f.spaceId, grant.grantId, attempt.attemptId);
    const { atPut, release } = holdPut(f.r2, key);
    const finalize = sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
    await atPut;
    await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId);
    assert.equal(f.r2.objects.has(key), false, 'revocation found nothing to remove yet');
    return { key, grant, finalize: () => { release(); return finalize; } };
  };

  // The refused finalize removes the copy that landed late.
  const late = await race('copied after revocation', f.sources);
  await rejects(late.finalize(), 'FORBIDDEN');
  assert.equal(f.r2.stored.includes(late.key), true, 'the held copy did land');
  assert.equal(f.r2.objects.has(late.key), false, 'and was removed when its commit was refused');

  // A finalize that dies before its own removal leaves the copy for reconciliation.
  const crashed = await race('copied, then the worker died', f.faulty);
  faults = [{ match: 'SELECT state,staging_key,observed_sha256,observed_bytes,staging_removed_at',
    error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }];
  await rejects(crashed.finalize(), 'FORBIDDEN');
  faults = [];
  assert.equal(f.r2.objects.has(crashed.key), true, 'the finalize\'s own removal did not run');
  assert.deepEqual((await attempts(f.spaceId, crashed.grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_revoked', false]], 'the attempt stays due');
  await sleep(2100);
  while (await f.reconciler(0).step(500) === 500);
  assert.equal(f.r2.objects.has(crashed.key), false, 'reconciliation removes the failed attempt\'s original');
  for (const grant of [late.grant, crashed.grant])
    assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
      [['failed', 'grant_revoked', true]]);
  assert.deepEqual(f.r2.keys(''), []);
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 });
});

test('a finalize copy still running at its grant expiry stores nothing', async () => {
  const f = await fixture();
  const bytes = Buffer.from('copied too late');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 1 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
  const key = originalKey(f.spaceId, grant.grantId, attempt.attemptId);
  const { atPut, release } = holdPut(f.r2, key);
  const finalize = rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }), 'FORBIDDEN');
  await atPut;
  await sleep(1200);
  release();
  await finalize;
  await sleep(20);
  assert.equal(f.r2.stored.includes(key), false, 'the copy was cut off at expiry, so no write can land after reconciliation');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code]), [['failed', 'commit_failed']]);
});

test('a caller whose authority ends while streaming verifies nothing and leaves no staging', async () => {
  const f = await fixture();
  const bytes = Buffer.from('streamed across a policy change');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  /** A body that sends its first chunk, then waits for `finish` before the rest. */
  const paused = () => {
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let sent = false;
    const body = new ReadableStream({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(bytes.subarray(0, 4))); return; }
        await gate;
        controller.enqueue(new Uint8Array(bytes.subarray(4)));
        controller.close();
      }
    });
    return { body, finish };
  };
  const streamAcross = async (actor, change) => {
    const grant = await f.sources.createUpload(actor, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
    const { body, finish } = paused();
    const upload = f.sources.upload(actor, f.spaceId, 'alpha', grant.grantId, body, declared);
    await sleep(100);
    await change();
    finish();
    await assert.rejects(upload, error => typeof error.code === 'string');
    const rows = await attempts(f.spaceId, grant.grantId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'failed');
    assert.match(rows[0].failure_code, /^refused_[a-z_]+$/);
    assert.equal(rows[0].removed, true);
  };
  const key = await spaces.issueAgentKey(f.owner, f.spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['sources:write'] }]);
  await streamAcross(await verify(key.secret), () => spaces.revokeAgentKey(f.owner, f.spaceId, key.id));
  await streamAcross(f.owner, () => spaces.update(f.owner, f.spaceId, 'suspended'));
  assert.deepEqual(f.r2.keys(''), [], 'no staging or original remains');
});

test('revocation while the digest commits elsewhere, and same-key ingestion, stay correct under snapshot isolation session defaults', async () => {
  for (const level of ['repeatable read', 'serializable']) {
    const sessionPool = new pg.Pool({ connectionString: url, max: 6,
      options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` });
    try {
      assert.equal((await sessionPool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, level);
      const f = await fixture();
      const sessions = new PostgresSources(spaces, new Map([['cell-a', { pool: sessionPool, originals: f.blobs }]]));
      const bytes = Buffer.from(`shared under ${level}`);
      const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
      // A promoted attempt is revoked; its original's delete is held while
      // another grant uploads and commits the same digest.
      const grant = await sessions.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
      const attempt = await sessions.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
      faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('could not serialize'), { code: '40001' }) }];
      await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }));
      const { atDelete, release } = holdDelete(f.r2, 'originals/');
      const revocation = sessions.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId);
      await atDelete;
      const other = await sessions.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
      const otherAttempt = await sessions.upload(f.agent, f.spaceId, 'alpha', other.grantId, chunked(bytes), declared);
      const committed = await sessions.finalizeUpload(f.agent, f.spaceId, 'alpha', other.grantId, { attemptId: otherAttempt.attemptId });
      release();
      assert.ok((await revocation).revokedAt, level);
      assert.deepEqual(await read((await sessions.content(f.agent, f.spaceId, 'alpha', committed.sourceId)).body), bytes,
        `${level}: the committed source keeps its original`);
      assert.deepEqual(await strayOriginals(f), [], level);

      // Concurrent retries of one text ingestion commit one source and all succeed.
      const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
        sessions.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: `race-${level}`, text: `raced under ${level}` })));
      assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'ok' : `${result.reason.code} ${result.reason.message}`),
        Array(6).fill('ok'), level);
      assert.equal(new Set(results.map(result => result.value.sourceId)).size, 1, level);
      assert.equal(results.filter(result => !result.value.replayed).length, 1, level);
      assert.deepEqual(await strayOriginals(f), [], `${level}: the losing retries leave no bytes`);
    } finally { await sessionPool.end(); }
  }
});

test('a blob write never starts after its deadline and reports one whose confirmation stalls past it at once', async () => {
  const r2 = new MemoryR2();
  const blobs = new R2BlobStore(r2);
  const bytes = Buffer.from('confirmed too late');
  const isDeadline = error => error instanceof BlobWriteError && error.reason === 'deadline';
  await assert.rejects(blobs.put('k/expired', chunked(bytes), { bytes: bytes.length, signal: AbortSignal.abort() }), isDeadline);
  assert.deepEqual(r2.started, [], 'no write starts once the deadline has passed');
  // The body ends before the deadline; the store's confirmation stalls past it.
  const deadline = new AbortController();
  let confirm;
  const confirmation = new Promise(resolve => { confirm = resolve; });
  r2.afterBody = async () => { deadline.abort(); await confirmation; };
  await assert.rejects(blobs.put('k/late', chunked(bytes), { bytes: bytes.length, sha256: sha(bytes), signal: deadline.signal }),
    isDeadline, 'a write whose confirmation stalls past its deadline is reported at once, not as a success');
  assert.equal(r2.objects.has('k/late'), false, 'reported before the store answered');
  confirm();
  await sleep(10);
  assert.equal(r2.objects.has('k/late'), true, 'the caller must treat the key as possibly written');
});

test('a grant deadline is fixed when the grant is read, so no upload or promotion write starts after expiry', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const prefix = grantId => `staging/${Buffer.from(f.spaceId).toString('base64url')}/${grantId}/`;
  // The authorizing transaction samples the grant, then its COMMIT stalls past expiry.
  const uploadBytes = Buffer.from('upload after a slow commit');
  const uploading = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  delays = [{ match: 'COMMIT', ms: 1300 }];
  await rejects(f.faulty.upload(f.agent, f.spaceId, 'alpha', uploading.grantId, chunked(uploadBytes),
    { ...declared, bytes: uploadBytes.length }), 'FORBIDDEN');
  assert.deepEqual(f.r2.started.filter(key => key.startsWith(prefix(uploading.grantId))), [], 'no staging write started');
  assert.deepEqual((await attempts(f.spaceId, uploading.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_expired', true]]);

  const promoteBytes = Buffer.from('promotion after a slow commit');
  const promoting = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', promoting.grantId, chunked(promoteBytes),
    { ...declared, bytes: promoteBytes.length });
  delays = [{ match: 'COMMIT', ms: 1300 }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', promoting.grantId, { attemptId: attempt.attemptId }), 'FORBIDDEN');
  delays = [];
  assert.equal(f.r2.started.includes(originalKey(f.spaceId, promoting.grantId, attempt.attemptId)), false, 'no promotion write started');
  assert.deepEqual((await attempts(f.spaceId, promoting.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'commit_failed', false]], 'the attempt that held a digest stays due');
  assert.deepEqual(f.r2.keys(''), []);
});

/** Hold the store's answer to the next put whose key matches, after it has read the whole body, until released. */
function holdConfirmation(r2, matches) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const atConfirm = new Promise(resolve => { reached = resolve; });
  r2.afterBody = async target => { if (matches(target)) { r2.afterBody = async () => {}; reached(); await held; } };
  return { atConfirm, release };
}
const untilExpired = grant => sleep(Math.max(0, Date.parse(grant.expiresAt) - Date.now()) + 150);

test('bytes the store confirms after their attempt settled are found and removed by the sweep, never a committed original', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const promptly = (request, grant) => Promise.race([request.then(() => 'succeeded', error => error.code),
    untilExpired(grant).then(() => sleep(500)).then(() => 'still waiting on the store')]);
  const keptBytes = Buffer.from('committed and kept');
  const keptGrant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64 });
  const keptAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', keptGrant.grantId, chunked(keptBytes),
    { ...declared, bytes: keptBytes.length });
  const kept = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', keptGrant.grantId, { attemptId: keptAttempt.attemptId });

  // An upload's staging write ends its body before expiry; the store answers only much later.
  const staged = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  const stagedBytes = Buffer.from('staging confirmed late');
  const stagingHold = holdConfirmation(f.r2, key => key.startsWith('staging/') && key.includes(staged.grantId));
  const upload = f.sources.upload(f.agent, f.spaceId, 'alpha', staged.grantId, chunked(stagedBytes), { ...declared, bytes: stagedBytes.length });
  await stagingHold.atConfirm;
  assert.equal(await promptly(upload, staged), 'FORBIDDEN', 'the upload reports expiry without waiting for the store');
  // So does a finalize's promotion.
  const promoted = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  const promotedBytes = Buffer.from('original confirmed late');
  const promotedAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', promoted.grantId, chunked(promotedBytes),
    { ...declared, bytes: promotedBytes.length });
  const promotedKey = originalKey(f.spaceId, promoted.grantId, promotedAttempt.attemptId);
  const promotionHold = holdConfirmation(f.r2, key => key === promotedKey);
  const finalize = f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', promoted.grantId, { attemptId: promotedAttempt.attemptId });
  await promotionHold.atConfirm;
  assert.equal(await promptly(finalize, promoted), 'FORBIDDEN', 'the finalize reports expiry without waiting for the store');

  // The writers' own cleanup has run, and reconciliation settles both attempts; only then do both writes land.
  while (await f.reconciler(0).step(500) === 500);
  for (const grant of [staged, promoted])
    assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.removed]), [['failed', true]]);
  stagingHold.release();
  promotionHold.release();
  await sleep(50);
  const late = () => f.r2.keys('').filter(key => key.includes(staged.grantId) || key.includes(promoted.grantId)).sort();
  assert.equal(late().length, 2, 'both writes landed after their attempts settled');
  while (await f.reconciler(0).step(500) === 500);
  assert.equal(late().length, 2, 'the ledger no longer lists them');
  await f.reconciler(0).sweep(1000);
  assert.deepEqual(late(), [], 'the sweep finds and removes them');
  assert.deepEqual(f.r2.keys(''), [await sourceKey(f, kept.sourceId)]);
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', kept.sourceId)).body), keptBytes);
});

test('the sweep keeps live and unknown bytes and continues across pages from its cursor', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const bytes = Buffer.from('a failed attempt left bytes');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64 });
  for (let i = 0; i < 3; i++)
    await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes.subarray(1)), { ...declared, bytes: bytes.length }),
      'INVALID_ARGUMENT');
  // Bytes that landed for each failed attempt after its cleanup, at its staging and original keys.
  const failed = (await attempts(f.spaceId, grant.grantId)).map(row => row.attempt_id);
  for (const attemptId of failed) for (const key of [originalKey(f.spaceId, grant.grantId, attemptId),
    originalKey(f.spaceId, grant.grantId, attemptId).replace(/^originals\//, 'staging/')]) f.r2.objects.set(key, { bytes });
  const live = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
  for (const key of ['misc/other', 'staging/not base64/upl_x/att_y', 'originals/x/y']) f.r2.objects.set(key, { bytes });
  const before = f.r2.keys('').sort();
  const sweeper = f.reconciler(0);
  assert.equal(await sweeper.sweep(3), 3);
  assert.equal(f.r2.objects.has('reconcile/sweep-cursor'), true, 'an unfinished pass records its cursor');
  assert.equal(failed.some(id => f.r2.keys('').some(key => key.endsWith(id))), true, 'one page does not finish the pass');
  for (let page = 0; page < 10 && failed.some(id => f.r2.keys('').some(key => key.endsWith(id))); page++) await sweeper.sweep(3);
  assert.deepEqual(f.r2.keys('').filter(key => key !== 'reconcile/sweep-cursor').sort(),
    before.filter(key => !failed.some(id => key.endsWith(id))), 'only the failed attempts\' bytes are removed');
  const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: live.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes);
});

test('an attempt verifies, and a grant finalizes, only in a transaction that commits before the grant expires', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const current = spaces.assertScopeCurrent;
  let delayUntil = null;
  let delayed = 0;
  // The final authority check runs after the guarded UPDATE and before COMMIT; hold it until the grant has expired.
  spaces.assertScopeCurrent = async function (...args) {
    if (delayUntil !== null) { const grant = delayUntil; delayUntil = null; delayed++; await untilExpired(grant); }
    return current.apply(this, args);
  };
  try {
    const verifyBytes = Buffer.from('verified at commit after expiry');
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
    f.r2.afterBody = async () => { f.r2.afterBody = async () => {}; delayUntil = grant; };
    await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(verifyBytes), { ...declared, bytes: verifyBytes.length }),
      'FORBIDDEN', 'a verification that commits after expiry');
    assert.equal(delayed, 1);
    assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
      [['failed', 'grant_expired', true]]);
    assert.deepEqual(staging(f.r2, f.spaceId), []);

    const finalBytes = Buffer.from('finalized at commit after expiry');
    const late = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', late.grantId, chunked(finalBytes), { ...declared, bytes: finalBytes.length });
    const key = originalKey(f.spaceId, late.grantId, attempt.attemptId);
    f.r2.afterBody = async target => { if (target === key) { f.r2.afterBody = async () => {}; delayUntil = late; } };
    await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', late.grantId, { attemptId: attempt.attemptId }),
      'FORBIDDEN', 'a finalize that commits after expiry');
    assert.equal(delayed, 2);
    assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 }, 'no source commits after expiry');
    assert.equal((await pool.query(`SELECT finalized_at FROM source_upload_grants WHERE space_id=$1 AND grant_id=$2`,
      [f.spaceId, late.grantId])).rows[0].finalized_at, null);
    assert.deepEqual((await attempts(f.spaceId, late.grantId)).map(row => [row.state, row.failure_code]), [['failed', 'commit_failed']]);
    assert.equal(f.r2.objects.has(key), false, 'its original is removed');
    assert.deepEqual(staging(f.r2, f.spaceId), [], 'and so is its staging');
  } finally { spaces.assertScopeCurrent = current; }
});

test('reconciliation bounds each store call and its budget, so a stalled delete or slow statement holds no healthy attempt', async () => {
  const f = await fixture();
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 64,
    expiresInSeconds: 1 });
  const prefix = `staging/${Buffer.from(f.spaceId).toString('base64url')}/${grant.grantId}/`;
  // Oldest first, so these lead the cell-wide page.
  for (const [i, attemptId] of ['att_a_stalled', 'att_b_healthy', 'att_c_slow', 'att_d_next'].entries()) {
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,updated_at)
      VALUES($1,'alpha',$2,$3,$4,timestamptz '2000-01-01'+make_interval(days=>$5))`, [f.spaceId, grant.grantId, attemptId, `${prefix}${attemptId}`, i]);
    f.r2.objects.set(`${prefix}${attemptId}`, { bytes: Buffer.from(attemptId) });
  }
  const row = async attemptId => (await pool.query(`SELECT staging_removed_at IS NOT NULL AS removed, updated_at
    FROM source_upload_attempts WHERE space_id=$1 AND attempt_id=$2`, [f.spaceId, attemptId])).rows[0];
  await untilExpired(grant);
  let releaseStall;
  const stalled = new Promise(resolve => { releaseStall = resolve; });
  f.r2.beforeDelete = async key => { if (key.endsWith('att_a_stalled')) await stalled; };
  const started = performance.now();
  const outcome = await Promise.race([f.reconciler(0).step(2).then(() => 'settled', error => error),
    sleep(5000).then(() => 'still held by the stalled delete')]);
  assert.equal(outcome instanceof AggregateError, true, String(outcome));
  assert.equal(performance.now() - started < 4000, true, 'the stalled call is bounded');
  assert.equal((await row('att_b_healthy')).removed, true, 'the healthy attempt behind it settles');
  const deferred = await row('att_a_stalled');
  assert.equal(deferred.removed, false, 'the stalled attempt stays due');
  assert.equal(deferred.updated_at > new Date('2001-01-01'), true, 'and moves behind due attempts not tried since');
  releaseStall();
  await sleep(20);
  assert.equal(f.r2.objects.has(`${prefix}att_a_stalled`), false, 'its delete landed late, safely');

  // A statement still running when the budget ends is cut off there; its attempt and the next stay due.
  f.r2.beforeDelete = async () => {};
  hooks = [{ match: 'FOR UPDATE SKIP LOCKED', run: () => sleep(400) }];
  const slow = new SourceUploadReconciler({ pool: faulty, originals: f.blobs }, 0);
  const cutOff = performance.now();
  await assert.rejects(slow.step(2, 300), AggregateError);
  assert.equal(performance.now() - cutOff < 400, true, 'the slow statement does not overrun the budget');
  assert.deepEqual([(await row('att_c_slow')).removed, (await row('att_d_next')).removed], [false, false]);
  hooks = [];
  while (await f.reconciler(0).step(500) === 500);
  for (const attemptId of ['att_a_stalled', 'att_d_next']) assert.equal((await row(attemptId)).removed, true, attemptId);
  assert.deepEqual(f.r2.keys(prefix), []);
});

test('cleanup transactions end by the page budget: a late connection, slow statements, deferral and the sweep query', async () => {
  const f = await fixture();
  const reconciler = cell => new SourceUploadReconciler({ originals: f.blobs, ...cell }, 0);
  const endsBy = async (label, budget, run) => {
    const started = performance.now();
    const outcome = await Promise.race([run().then(() => 'settled', () => 'rejected'), sleep(3000).then(() => 'still waiting')]);
    assert.equal(outcome, 'rejected', label);
    assert.equal(performance.now() - started < budget + 100, true, `${label} ends by its budget`);
  };
  // A connection that arrives after the budget is released, not kept.
  const released = [];
  const late = { connect: () => sleep(600).then(() => ({ release: discard => { released.push(discard); } })) };
  await endsBy('a step waiting for a connection', 300, () => reconciler({ pool: late }).step(25, 300));
  await endsBy('a sweep waiting for a connection', 300, () => reconciler({ pool: late }).sweep(100, 300));
  await sleep(700);
  assert.equal(released.length, 2, 'each late connection is released');

  // A pool whose statements can be slowed, logging when each starts and whether each session is discarded.
  const log = [];
  const discarded = [];
  const slowed = (ms, match = () => true) => ({ connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property === 'release') return discard => { discarded.push(discard === true); target.release(discard); };
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        log.push(performance.now());
        if (match(String(sql))) await sleep(ms);
        return target.query(sql, ...rest);
      };
    } });
  } });
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 64,
    expiresInSeconds: 1 });
  const prefix = `staging/${Buffer.from(f.spaceId).toString('base64url')}/${grant.grantId}/`;
  // Older than any other test's attempts, so these lead the cell-wide page.
  for (const [i, attemptId] of ['att_a', 'att_b', 'att_c'].entries()) {
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,updated_at)
      VALUES($1,'alpha',$2,$3,$4,timestamptz '1990-01-01'+make_interval(days=>$5))`, [f.spaceId, grant.grantId, attemptId, `${prefix}${attemptId}`, i]);
    f.r2.objects.set(`${prefix}${attemptId}`, { bytes: Buffer.from(attemptId) });
  }
  await untilExpired(grant);
  // Slow statements add up: the transaction in flight when the budget ends is cut off and its session discarded.
  await endsBy('a step whose statements are slow', 500, () => reconciler({ pool: slowed(80) }).step(25, 500));
  assert.equal(discarded.includes(true), true, 'the cut-off session is discarded');
  assert.equal((await attempts(f.spaceId, grant.grantId)).every(row => !row.removed), true, 'no attempt settles past the budget');

  // A store call that fails at the budget's end starts no deferral after it; the attempt stays due.
  let releaseStall;
  const stalled = new Promise(resolve => { releaseStall = resolve; });
  f.r2.beforeDelete = async key => { if (key.endsWith('att_a')) await stalled; };
  log.length = 0;
  const started = performance.now();
  await assert.rejects(reconciler({ pool: slowed(0) }).step(25, 400), AggregateError);
  assert.deepEqual(log.filter(at => at >= started + 400), [], 'no statement starts after the budget');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).find(row => row.attempt_id === 'att_a'),
    { attempt_id: 'att_a', state: 'failed', failure_code: 'abandoned', observed_sha256: null, removed: false });
  releaseStall();
  f.r2.beforeDelete = async () => {};

  // A slow ownership query ends the sweep at its budget, deleting nothing and keeping its cursor.
  await pool.query(`UPDATE source_upload_attempts SET state='failed',failure_code='abandoned' WHERE space_id=$1 AND grant_id=$2`,
    [f.spaceId, grant.grantId]);
  await endsBy('a sweep whose ownership query is slow', 300, () => reconciler({ pool: slowed(1500, sql => sql.includes('unnest')) }).sweep(100, 300));
  assert.equal(f.r2.objects.has(`${prefix}att_b`), true, 'nothing is deleted');
  assert.equal(f.r2.objects.has('reconcile/sweep-cursor'), false, 'the cursor does not move');
  while (await f.reconciler(0).step(500) === 500);
  assert.deepEqual(f.r2.keys(prefix), []);
});

test('a failed cleanup transaction ends by the page budget even when its ROLLBACK stalls, and no store call starts after it', async () => {
  const f = await fixture();
  const reconciler = cell => new SourceUploadReconciler({ originals: f.blobs, ...cell }, 0);
  const endsBy = async (label, budget, run) => {
    const started = performance.now();
    await assert.rejects(run(), label);
    assert.equal(performance.now() - started < budget + 100, true, `${label} ends by its budget`);
  };
  // A pool whose matching statement fails with a SQL error and whose ROLLBACK then stalls, recording each release.
  const released = [];
  const failing = match => ({ connect: async () => {
    const client = await pool.connect();
    let gone = false;
    return new Proxy(client, { get(target, property) {
      if (property === 'release') return discard => { gone = true; released.push(discard === true); target.release(discard); };
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (sql, ...rest) => {
        if (String(sql).includes(match)) return target.query('SELECT 1/0');
        if (sql === 'ROLLBACK') { await sleep(600); return gone ? { rows: [] } : target.query(sql); }
        return target.query(sql, ...rest);
      };
    } });
  } });
  await endsBy('a step whose due query fails', 300, () => reconciler({ pool: failing('SELECT a.space_id') }).step(25, 300));
  await endsBy('a sweep whose ownership query fails', 300, () => reconciler({ pool: failing('unnest') }).sweep(100, 300));
  assert.deepEqual(released, [true, true], 'each session cut off mid-ROLLBACK is discarded');

  // A statement still waiting on the server when the budget ends is cut off there too.
  const locker = await pool.connect();
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE source_upload_attempts IN ACCESS EXCLUSIVE MODE');
  try {
    await endsBy('a step whose due query waits on a lock', 300, () => reconciler({ pool }).step(25, 300));
    await endsBy('a sweep whose ownership query waits on a lock', 300, () => reconciler({ pool }).sweep(100, 300));
  } finally { await locker.query('ROLLBACK'); locker.release(); }

  // A sweep whose deletes stall starts no store call after its budget and still advances its cursor.
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 64,
    expiresInSeconds: 1 });
  const prefix = `staging/${Buffer.from(f.spaceId).toString('base64url')}/${grant.grantId}/`;
  for (const attemptId of ['att_a', 'att_b', 'att_c']) {
    await pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,failure_code)
      VALUES($1,'alpha',$2,$3,$4,'failed','abandoned')`, [f.spaceId, grant.grantId, attemptId, `${prefix}${attemptId}`]);
    f.r2.objects.set(`${prefix}${attemptId}`, { bytes: Buffer.from(attemptId) });
  }
  const calls = [];
  f.r2.beforeDelete = async () => { calls.push(performance.now()); await sleep(1000); };
  f.r2.beforePut = async () => { calls.push(performance.now()); };
  const started = performance.now();
  await assert.rejects(reconciler({ pool }).sweep(100, 300), AggregateError);
  assert.equal(calls.length > 0, true);
  assert.deepEqual(calls.filter(at => at >= started + 300), [], 'no store call starts after the budget');
  assert.equal(f.r2.objects.has('reconcile/sweep-cursor'), true, 'the cursor advances past the slow key');
  await sleep(1000);
  f.r2.beforeDelete = async () => {};
  f.r2.beforePut = async () => {};
});

test('a sweep cut off while reading its cursor cancels the provider body, releases it and starts nothing after', async () => {
  for (const [label, pull] of [['stalls', () => new Promise(() => {})],
    ['trickles', async controller => { await sleep(20); controller.enqueue(new Uint8Array([0x61])); }]]) {
    const calls = [];
    let body;
    let cancelled = 0;
    const originals = {
      get: async () => { body = new ReadableStream({ pull, cancel() { cancelled++; } }); return { body }; },
      list: async () => { calls.push('list'); return { keys: [], done: true }; },
      delete: async () => { calls.push('delete'); },
      put: async () => { calls.push('put'); },
    };
    const cell = { originals, pool: { connect: async () => { calls.push('connect'); throw new Error('unreachable'); } } };
    const started = performance.now();
    await assert.rejects(new SourceUploadReconciler(cell, 0).sweep(100, 200), /timed out/, label);
    assert.equal(performance.now() - started < 300, true, `a cursor that ${label} ends by the budget`);
    await sleep(300);
    assert.equal(cancelled, 1, `a cursor that ${label} is cancelled through the provider`);
    assert.equal(body.locked, false, `a cursor that ${label} is released`);
    assert.deepEqual(calls, [], `a cursor that ${label} starts nothing after it`);
  }
});

test('attempts that keep failing to settle cannot hold the oldest reconciliation page', async () => {
  const f = await fixture();
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'application/octet-stream', maxBytes: 64,
    expiresInSeconds: 1 });
  const prefix = `staging/${Buffer.from(f.spaceId).toString('base64url')}/${grant.grantId}/`;
  const insert = attemptId => pool.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key)
    VALUES($1,'alpha',$2,$3,$4)`, [f.spaceId, grant.grantId, attemptId, `${prefix}${attemptId}`]);
  // Already failed attempts whose staging delete keeps failing change nothing when they fail again.
  for (let i = 0; i < 26; i++) await insert(`att_failing_${String(i).padStart(2, '0')}`);
  await pool.query(`UPDATE source_upload_attempts SET state='failed',failure_code='interrupted' WHERE space_id=$1 AND grant_id=$2`,
    [f.spaceId, grant.grantId]);
  await insert('att_healthy');
  f.r2.failDelete = key => key.startsWith(`${prefix}att_failing_`);
  await sleep(1100);
  const healthySettled = async () => (await attempts(f.spaceId, grant.grantId)).find(row => row.attempt_id === 'att_healthy').removed;
  // Other spaces' ended attempts may share a page, so allow a few more pages.
  for (let page = 0; page < 4 && !await healthySettled(); page++) await f.reconciler(0).step(25).catch(() => {});
  assert.equal(await healthySettled(), true, 'an attempt beyond a page of failing ones settles');
  const failing = (await attempts(f.spaceId, grant.grantId)).filter(row => row.attempt_id !== 'att_healthy');
  assert.equal(failing.every(row => row.state === 'failed' && !row.removed), true, 'failing attempts stay due');
  f.r2.failDelete = () => false;
  while (await f.reconciler(0).step(500) === 500);
  assert.equal((await attempts(f.spaceId, grant.grantId)).every(row => row.removed), true, 'and settle once they can');
});

test('a malformed source request or upload body is refused before any trap or getter runs, with no effects', async () => {
  const f = await fixture();
  const declared = { bytes: 4, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')), declared);
  const before = await effects(f);
  let calls = 0;
  const counted = value => { calls++; return value; };
  const proxies = {
    transparentProxy: target => new Proxy(target, new Proxy({}, { get(_, trap) { calls++; return Reflect[trap]; } })),
    throwingProxy: target => new Proxy(target, new Proxy({}, { get() { calls++; return () => { throw new Error('proxy trap'); }; } })),
    revokedProxy: target => { const { proxy, revoke } = Proxy.revocable(target, {}); revoke(); return proxy; }
  };
  // Each kind changes one valid request in one way; `required` and `optional` name one field of each.
  const kinds = {
    ...proxies,
    accessor: (base, { required }) => Object.defineProperty({ ...base }, required,
      { enumerable: true, get: () => counted(base[required]) }),
    symbolMember: base => ({ ...base, [Symbol('extra')]: 1 }),
    hiddenUnknown: base => Object.defineProperty({ ...base }, 'extra', { value: 1, enumerable: false }),
    hiddenAllowed: (base, { required }) => Object.defineProperty({ ...base }, required, { value: base[required], enumerable: false }),
    unknown: base => ({ ...base, extra: 1 }),
    inheritedRequired: (base, { required }) => {
      const { [required]: value, ...rest } = base;
      return Object.assign(Object.create({ get [required]() { return counted(value); } }), rest);
    },
    decorated: base => Object.assign(Object.create({ decorated: true }), base),
    array: base => Object.assign([], base),
    missingRequired: (base, { required }) => { const { [required]: _, ...rest } = base; return rest; },
    requiredUndefined: (base, { required }) => ({ ...base, [required]: undefined }),
    optionalUndefined: (base, { optional }) => ({ ...base, [optional]: undefined })
  };
  const entrypoints = {
    ingestText: { required: 'text', optional: 'locator', base: { idempotencyKey: 'malformed', text: 'malformed text' },
      run: request => f.sources.ingestText(f.agent, f.spaceId, 'alpha', request) },
    ingestReference: { required: 'locator', optional: 'mimeType', base: { idempotencyKey: 'malformed', locator: 'https://example.invalid/a' },
      run: request => f.sources.ingestReference(f.agent, f.spaceId, 'alpha', request) },
    createUpload: { required: 'maxBytes', optional: 'sha256', base: { mimeType: 'text/plain', maxBytes: 8 },
      run: request => f.sources.createUpload(f.agent, f.spaceId, 'alpha', request) },
    uploadDeclaration: { required: 'bytes', optional: 'sha256', base: { ...declared },
      run: request => f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')), request) },
    finalizeUpload: { required: 'attemptId', optional: 'capturedAt', base: { attemptId: attempt.attemptId },
      run: request => f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, request) }
  };
  for (const [entrypoint, { run, base, ...names }] of Object.entries(entrypoints)) for (const [kind, malform] of Object.entries(kinds)) {
    calls = 0;
    await rejects(run(malform(base, names)), 'INVALID_ARGUMENT', `${entrypoint} with ${kind}`);
    assert.equal(calls, 0, `${entrypoint} ran no ${kind} trap or getter`);
  }
  for (const [kind, wrap] of Object.entries(proxies)) {
    calls = 0;
    await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, wrap(chunked(Buffer.from('four'))), declared),
      'INVALID_ARGUMENT', `upload body as a ${kind}`);
    assert.equal(calls, 0, `the upload body ran no ${kind} trap`);
  }
  assert.deepEqual(await effects(f), before, 'no grant, attempt, source or blob changed');
  // A plain request without a prototype is still accepted.
  const plain = Object.assign(Object.create(null), { idempotencyKey: 'null-prototype', locator: 'https://example.invalid/b' });
  assert.equal((await f.sources.ingestReference(f.agent, f.spaceId, 'alpha', plain)).locator, 'https://example.invalid/b');
});

test('a cleanup that rolls back after failing an attempt never strands a finalize of that attempt that commits', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const connectionLost = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  // Finalize A has copied the original and is paused before its metadata
  // transaction while `cleanup` fails the same attempt and then rolls back.
  const race = async (text, cleanup) => {
    const bytes = Buffer.from(text);
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const paused = pauseAtBegin(2);
    const finalize = new PostgresSources(spaces, new Map([['cell-a', { pool: paused.pool, originals: f.blobs }]]))
      .finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
    await paused.at;
    assert.equal(f.r2.objects.has(originalKey(f.spaceId, grant.grantId, attempt.attemptId)), true, `${text}: A promoted the original`);
    await cleanup(grant, attempt);
    assert.deepEqual([...hooks, ...faults], [], `${text}: every injected hook and fault ran`);
    assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => row.state), ['verified'], `${text}: the cleanup rolled back`);
    paused.release();
    const source = await finalize;
    assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes,
      `${text}: the committed source has its original bytes`);
  };

  // The owner's session ends after the revocation failed the attempt, so its final scope check refuses it.
  const session = await issueSession(config, {}, { userId: f.user.id, methods: ['password'] });
  const revoker = await verify(session.sessionToken);
  await race('revocation refused at its scope recheck', async grant => {
    hooks = [{ match: 'UPDATE source_upload_grants SET revoked_at',
      run: () => revokeSessionById(config, session.session.id, { userId: f.user.id }) }];
    await rejects(f.faulty.revokeUpload(revoker, f.spaceId, 'alpha', grant.grantId), 'FORBIDDEN');
  });
  await race('revocation whose COMMIT is lost', async grant => {
    faults = [{ match: 'COMMIT', exact: true, error: connectionLost() }];
    await assert.rejects(f.faulty.revokeUpload(f.owner, f.spaceId, 'alpha', grant.grantId));
  });
  // A competing finalize of the same attempt fails deterministically; its cleanup's COMMIT is lost.
  await race('failed-finalize cleanup whose COMMIT is lost', async (grant, attempt) => {
    hooks = [{ match: 'INSERT INTO sources', run: () => { faults.push({ match: 'COMMIT', exact: true, error: connectionLost() }); } }];
    faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('duplicate key'), { code: '23505' }) }];
    await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }));
  });
});

test('finalize refuses an original that disappeared after promotion, before its metadata commit, and a retry copies it again', async () => {
  const f = await fixture();
  const bytes = Buffer.from('deleted behind the finalize');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
  const key = originalKey(f.spaceId, grant.grantId, attempt.attemptId);
  // The object vanishes outside the service after the promotion stored it.
  const head = f.r2.head.bind(f.r2);
  f.r2.head = async name => {
    if (name === key && f.r2.stored.includes(key)) { f.r2.head = head; f.r2.objects.delete(key); }
    return head(name);
  };
  const finalize = f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  await assert.rejects(finalize, error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true);
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 }, 'no metadata commits without bytes');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => row.state), ['verified'], 'the attempt stays retryable');
  const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes);
});

test('a refused or failed blob write cancels its input, including through the UTF-8 check', async () => {
  const bytes = Buffer.from('a body longer than its declaration');
  const watched = () => {
    let offset = 0;
    const state = { cancelled: false };
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 4)));
        offset += 4;
      },
      cancel() { state.cancelled = true; }
    });
    return { body, state };
  };
  const r2 = new MemoryR2();
  const blobs = new R2BlobStore(r2);
  const overflow = watched();
  await assert.rejects(blobs.put('k/overflow', overflow.body, { bytes: 5 }), error => error instanceof BlobWriteError && error.reason === 'length');
  await sleep(10);
  assert.equal(overflow.state.cancelled, true, 'an overflowing body is cancelled');
  const refusedByStore = watched();
  r2.beforePut = async () => { throw new Error('put: provider unavailable'); };
  await assert.rejects(blobs.put('k/provider', refusedByStore.body, { bytes: bytes.length }), /provider unavailable/);
  await sleep(10);
  assert.equal(refusedByStore.state.cancelled, true, 'a body the store never read is cancelled');

  const f = await fixture();
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'text/plain', maxBytes: 64 });
  const text = watched();
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, text.body, { bytes: 5, mimeType: 'text/plain' }), 'INVALID_ARGUMENT');
  await sleep(10);
  assert.equal(text.state.cancelled, true, 'cancellation reaches a text body through its UTF-8 check');
  assert.deepEqual(f.r2.keys(''), []);
});

test('a source read rechecks the caller and the source once its original is open, and cancels the body on refusal', async () => {
  const f = await fixture();
  /** Hold the next get of `key` until released; its body records whether it was cancelled. */
  const holdGet = key => {
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const atGet = new Promise(resolve => { reached = resolve; });
    const state = { cancelled: false };
    const get = f.r2.get.bind(f.r2);
    f.r2.get = async target => {
      if (target !== key) return get(target);
      f.r2.get = get;
      reached();
      await held;
      const object = await get(target);
      const reader = object.body.getReader();
      return { ...object, body: new ReadableStream({ pull: async controller => {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      }, cancel: reason => { state.cancelled = true; return reader.cancel(reason); } }) };
    };
    return { atGet, release, state };
  };
  const readAcross = async (actor, collectionId, text, change, code) => {
    const source = await f.sources.ingestText(actor, f.spaceId, collectionId, { idempotencyKey: text, text });
    const { atGet, release, state } = holdGet(await sourceKey(f, source.sourceId));
    const content = f.sources.content(actor, f.spaceId, collectionId, source.sourceId);
    await atGet;
    await change();
    release();
    await rejects(content, code, text);
    assert.equal(state.cancelled, true, `${text}: the opened body is cancelled`);
  };
  const key = await spaces.issueAgentKey(f.owner, f.spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['sources:read', 'sources:write'] }]);
  await readAcross(await verify(key.secret), 'alpha', 'read across an agent key revocation',
    () => spaces.revokeAgentKey(f.owner, f.spaceId, key.id), 'FORBIDDEN');
  const session = await issueSession(config, {}, { userId: f.user.id, methods: ['password'] });
  await readAcross(await verify(session.sessionToken), 'beta', 'read across the end of the owner session',
    () => revokeSessionById(config, session.session.id, { userId: f.user.id }), 'FORBIDDEN');
  await readAcross(f.agent, 'alpha', 'read across a space suspension',
    () => spaces.update(f.owner, f.spaceId, 'suspended'), 'FORBIDDEN');
});

test('grant expiry is checked again by the verify and finalize transitions, after their lock waits', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };

  // Verification waits on the grant row, locked here after the body began streaming, until the grant has expired.
  const lateVerify = Buffer.from('verified after expiry');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let sent = false;
  const body = new ReadableStream({ async pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new Uint8Array(lateVerify.subarray(0, 4))); return; }
    await gate;
    controller.enqueue(new Uint8Array(lateVerify.subarray(4)));
    controller.close();
  } });
  const holder = await pool.connect();
  try {
    const upload = f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, body, { ...declared, bytes: lateVerify.length });
    while (!f.r2.started.some(key => key.includes(grant.grantId))) await sleep(10);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM source_upload_grants WHERE space_id=$1 AND grant_id=$2 FOR UPDATE', [f.spaceId, grant.grantId]);
    finish();
    await untilExpired(grant);
    await holder.query('COMMIT');
    await rejects(upload, 'FORBIDDEN', 'an upload verified only after expiry');
  } finally { holder.release(); }
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_expired', true]]);

  // The metadata transaction has locked the unexpired grant and attempt, then stalls until the grant has expired.
  const lateFinalize = Buffer.from('finalized after expiry');
  const late = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', late.grantId, chunked(lateFinalize), { ...declared, bytes: lateFinalize.length });
  const key = originalKey(f.spaceId, late.grantId, attempt.attemptId);
  let stalled = false;
  hooks = [{ match: 'INSERT INTO entity_refs', run: async () => { stalled = true; await untilExpired(late); } }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', late.grantId, { attemptId: attempt.attemptId }),
    'FORBIDDEN', 'a finalize whose commit reaches the grant only after expiry');
  assert.equal(stalled, true, 'the metadata transaction stalled after its checks');
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 }, 'no source commits after expiry');
  assert.equal((await pool.query(`SELECT finalized_at FROM source_upload_grants WHERE space_id=$1 AND grant_id=$2`,
    [f.spaceId, late.grantId])).rows[0].finalized_at, null);
  assert.deepEqual((await attempts(f.spaceId, late.grantId)).map(row => [row.state, row.failure_code]), [['failed', 'commit_failed']]);
  assert.equal(f.r2.objects.has(key), false, 'its original is removed');
  assert.deepEqual(staging(f.r2, f.spaceId), [], 'and so is its staging');
});

test('a promotion whose staging read is interrupted leaves its attempt verified and retryable', async () => {
  const f = await fixture();
  const bytes = Buffer.from('staging read cut short');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
  const get = f.r2.get.bind(f.r2);
  f.r2.get = async target => {
    f.r2.get = get;
    const object = await get(target);
    return { ...object, body: chunked(object && bytes, { fail: 6 }) };
  };
  await assert.rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }),
    error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true);
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => row.state), ['verified']);
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, grant.grantId, attempt.attemptId)), false, 'nothing was stored');
  const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes);
});

test('a sources transaction whose BEGIN got no reply, or whose read timed out, discards its session', async () => {
  const run = async failing => {
    const sent = [];
    const released = [];
    const client = { on() {}, removeListener() {}, release: discard => { released.push(discard); },
      query: async sql => {
        sent.push(sql);
        const error = failing(sql);
        if (error) throw error;
        return { rows: [], rowCount: 0 };
      } };
    await assert.rejects(new SourceUploadReconciler({ pool: { connect: async () => client }, originals: new R2BlobStore(new MemoryR2()) }).step());
    return { sent, released };
  };
  const timedOut = () => new Error('Query read timeout');
  const lostBegin = await run(sql => sql.startsWith('BEGIN') ? timedOut() : null);
  assert.deepEqual(lostBegin.released, [true], 'a BEGIN that may have opened a transaction never returns to the pool');
  const lostRead = await run(sql => sql.includes('FROM source_upload_attempts') ? timedOut() : null);
  assert.deepEqual(lostRead.released, [true], 'a session with an unanswered statement never returns to the pool');
  assert.equal(lostRead.sent.includes('ROLLBACK'), false, 'no ROLLBACK queues behind the unanswered statement');
  const refused = await run(sql => sql.includes('FROM source_upload_attempts') ? Object.assign(new Error('relation missing'), { code: '42P01' }) : null);
  assert.deepEqual(refused.released, [false], 'a statement the server refused rolls back and keeps its session');
  assert.equal(refused.sent.at(-1), 'ROLLBACK');
});

test('finalize checks its original before the metadata transaction, so a stalled store holds no lock', async () => {
  const f = await fixture();
  const bytes = Buffer.from('head that never answers');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 4 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
  const key = originalKey(f.spaceId, grant.grantId, attempt.attemptId);
  const head = f.r2.head.bind(f.r2);
  let stalled, unblock;
  const reached = new Promise(resolve => { stalled = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  f.r2.head = async name => {
    if (name !== key || !f.r2.stored.includes(key)) return head(name);
    stalled();
    await blocked;
    return head(name);
  };
  try {
    const finalize = f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
    await reached;
    const started = Date.now();
    assert.ok((await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId)).revokedAt,
      'revocation does not wait on a finalize whose store call is stalled');
    assert.ok(Date.now() - started < 1_500, 'revocation waited on no lock');
    await rejects(finalize, 'FORBIDDEN', 'the stalled check is cut off at the grant deadline');
    assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 }, 'nothing commits without its bytes');
    assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => [row.state, row.failure_code]), [['failed', 'grant_revoked']]);
    assert.equal(f.r2.objects.has(key), false, 'the failed attempt\'s original is removed');
  } finally { f.r2.head = head; unblock(); }
});

test('a grant takes one live attempt at a time, so it stages at most one body of its bound', async () => {
  const f = await fixture();
  const bytes = Buffer.from('one attempt at a time');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const raced = await Promise.allSettled([1, 2].map(() =>
    f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes, { stallMs: 50 }), declared)));
  assert.deepEqual(raced.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'FORBIDDEN');
  assert.equal(f.r2.started.length, 1, 'the refused attempt writes no staging');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared), 'FORBIDDEN',
    'a verified attempt still blocks another');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => row.state), ['verified']);
  assert.deepEqual(staging(f.r2, f.spaceId).length, 1);
  const verified = raced.find(result => result.status === 'fulfilled').value;
  assert.equal((await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: verified.attemptId })).original.sha256,
    sha(bytes));
});

test('oversized text is refused before it is encoded', async () => {
  const f = await fixture();
  const text = 'x'.repeat(sourceBounds.textBytes + 1);
  const before = await effects(f);
  const from = Buffer.from;
  const byteLength = Buffer.byteLength;
  let encoded = 0;
  Buffer.from = function (value, ...rest) { if (value === text) encoded++; return from.call(this, value, ...rest); };
  Buffer.byteLength = function (value, ...rest) { if (value === text) encoded++; return byteLength.call(this, value, ...rest); };
  try {
    await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'huge', text }), 'INVALID_ARGUMENT');
  } finally { Buffer.from = from; Buffer.byteLength = byteLength; }
  assert.equal(encoded, 0);
  assert.deepEqual(await effects(f), before, 'no effects');
});

test('source request decisions use intrinsics captured at load, so later prototype or global changes alter none', async () => {
  const f = await fixture();
  const octet = 'application/octet-stream';
  const badMime = 'Not A Mime';
  const nonIntegers = new Set([1.5, 2.5, 3.5]);
  const fieldNames = new Set(['maxBytes', 'attemptId', 'locator', 'bytes', 'text']);
  // Each replacement lies only for this test's sentinels, so the rest of the process keeps working.
  const replace = (target, name, make) => {
    const native = target[name];
    target[name] = make(native);
    return () => { target[name] = native; };
  };
  const replacements = {
    arrayIterator: () => replace(Array.prototype, Symbol.iterator, native => function () {
      const inner = native.call(this);
      return { next() { for (;;) { const step = inner.next(); if (step.done || (step.value !== 'sha256' && step.value !== 'extra')) return step; } },
        [Symbol.iterator]() { return this; } };
    }),
    arrayIncludes: () => replace(Array.prototype, 'includes', native => function (value, ...rest) {
      return value === 'extra' || native.call(this, value, ...rest);
    }),
    arraySome: () => replace(Array.prototype, 'some', native => function (...args) {
      return native.call(this, value => typeof value === 'string' && fieldNames.has(value)) ? false : native.apply(this, args);
    }),
    stringSplit: () => replace(String.prototype, 'split', native => function (...args) {
      return String(this) === badMime ? ['text/plain'] : native.apply(this, args);
    }),
    stringTrim: () => replace(String.prototype, 'trim', native => function () { return String(this) === badMime ? 'text/plain' : native.call(this); }),
    stringToLowerCase: () => replace(String.prototype, 'toLowerCase', native => function () {
      return String(this) === badMime ? 'text/plain' : native.call(this);
    }),
    stringIncludes: () => replace(String.prototype, 'includes', native => function (value, ...rest) {
      return value === '\0' ? false : native.call(this, value, ...rest);
    }),
    stringStartsWith: () => replace(String.prototype, 'startsWith', native => function (value, ...rest) {
      return (String(this) === 'application/json' && value === 'text/') || native.call(this, value, ...rest);
    }),
    regexTest: () => replace(RegExp.prototype, 'test', native => function (value) {
      return value === badMime.toLowerCase() || value === 'not-a-digest' || native.call(this, value);
    }),
    numberIsSafeInteger: () => replace(Number, 'isSafeInteger', native => value => nonIntegers.has(value) || native(value)),
    jsonStringify: () => replace(JSON, 'stringify', native => (value, ...rest) =>
      Array.isArray(value) && value[0] === 'text' ? '"same"' : native(value, ...rest))
  };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet, maxBytes: 64 });
  const verified = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')),
    { bytes: 4, mimeType: octet });
  const extracted = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'extracted', text: 'three' });
  await f.sources.extract(f.agent, f.spaceId, 'alpha', extracted.sourceId);
  const segment = { start: 0, end: 5, sourceStart: 0, sourceEnd: 5 };
  const correct = request => () => f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', extracted.sourceId,
    { baseVersion: 1, content: 'three', sourceOffsets: [segment], ...request });
  let round = 0;
  const probe = async label => {
    round++;
    // A supplied digest stays bound to the grant, so a different body fails verification.
    const bound = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet, maxBytes: 64, sha256: sha('expected') });
    assert.equal(bound.sha256, sha('expected'), `${label}: the grant keeps its digest`);
    await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', bound.grantId, chunked(Buffer.from('different')),
      { bytes: 9, mimeType: octet }), 'INVALID_ARGUMENT', `${label}: a different body`);
    // Two text sources with different keys stay distinct.
    const one = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: `one-${round}`, text: 'one' });
    const two = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: `two-${round}`, text: 'two' });
    assert.notEqual(one.sourceId, two.sourceId, `${label}: distinct keys derive distinct sources`);
    const before = await effects(f);
    const refused = {
      unknownReference: () => f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'k', locator: 'https://example.invalid/r', extra: 1 }),
      missingLocator: () => f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'k' }),
      nulLocator: () => f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'k', locator: 'https://example.invalid/\0' }),
      nonTextMime: () => f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'k', text: '{}', mimeType: 'application/json' }),
      missingMaxBytes: () => f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet }),
      badMime: () => f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: badMime, maxBytes: 8 }),
      badDigest: () => f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet, maxBytes: 8, sha256: 'not-a-digest' }),
      fractionalMaxBytes: () => f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet, maxBytes: 1.5 }),
      fractionalLifetime: () => f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: octet, maxBytes: 8, expiresInSeconds: 2.5 }),
      fractionalDeclaration: () => f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')),
        { bytes: 3.5, mimeType: octet }),
      unknownFinalize: () => f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: verified.attemptId, extra: 1 }),
      missingAttempt: () => f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, {}),
      unknownCorrection: correct({ extra: 1 }),
      fractionalBase: correct({ baseVersion: 2.5 }),
      fractionalOffset: correct({ sourceOffsets: [{ ...segment, end: 3.5 }] }),
      unknownSegmentKey: correct({ sourceOffsets: [{ ...segment, extra: 1 }] }),
      nulCorrection: correct({ content: 'thr\0e', sourceOffsets: [] })
    };
    for (const [name, run] of Object.entries(refused)) await rejects(run(), 'INVALID_ARGUMENT', `${label}: ${name}`);
    assert.deepEqual(await effects(f), before, `${label}: refused requests have no effects`);
    assert.deepEqual((await extractionRows(f.spaceId)).map(row => row.version), [1], `${label}: no refused correction wrote a version`);
  };
  await probe('control');
  for (const [name, install] of Object.entries(replacements)) {
    const restore = install();
    try { await probe(name); } finally { restore(); }
  }
});

test('a database read timeout before COMMIT leaves a finalize verified for a retry', async () => {
  const f = await fixture();
  const bytes = Buffer.from('read timeout before commit');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
  faults = [{ match: 'INSERT INTO entity_refs', error: new Error('Query read timeout') }];
  await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }),
    error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true);
  assert.equal(faults.length, 0, 'the fault fired');
  assert.deepEqual((await attempts(f.spaceId, grant.grantId)).map(row => row.state), ['verified']);
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, grant.grantId, attempt.attemptId)), true, 'the original is kept');
  const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes);
});

test('an upload whose verification fails for any reason releases its attempt, so the same grant takes a retry', async () => {
  const f = await fixture();
  const declared = { bytes: 0, mimeType: 'application/octet-stream' };
  const timedOut = () => [{ match: "SET state='verified'", error: new Error('Query read timeout') }];
  const coded = code => () => [{ match: "SET state='verified'", error: Object.assign(new Error(`injected ${code}`), { code }) }];
  // An unacknowledged COMMIT, whether or not the server ran it, is installed once verification has reached its update.
  const unacknowledged = lost => () => {
    hooks = [{ match: "SET state='verified'", run: () => { faults = [{ match: 'COMMIT', exact: true, lost, error: new Error('Connection terminated') }]; } }];
    return [];
  };
  const cases = {
    readTimeout: { install: timedOut, code: 'PROVIDER_UNAVAILABLE' },
    lockTimeout: { install: coded('55P03'), code: 'BACKPRESSURE' },
    serialization: { install: coded('40001'), code: '40001' },
    commitNotRun: { install: unacknowledged(false), code: 'PROVIDER_UNAVAILABLE' },
    commitLost: { install: unacknowledged(true), code: 'PROVIDER_UNAVAILABLE' }
  };
  for (const [name, { install, code }] of Object.entries(cases)) {
    const bytes = Buffer.from(`verification ${name}`);
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
    faults = install();
    await assert.rejects(f.faulty.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length }),
      error => error.code === code && classifyError(error, false).retryable, name);
    assert.deepEqual([faults.length, hooks.length], [0, 0], `${name}: the fault fired`);
    const failed = await attempts(f.spaceId, grant.grantId);
    assert.deepEqual(failed.map(row => [row.state, row.failure_code]), [['failed', 'verify_failed']], `${name}: the attempt is released`);
    assert.deepEqual(staging(f.r2, f.spaceId).filter(key => key.includes(`/${grant.grantId}/`)), [], `${name}: its staging is removed`);
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
    assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes, name);
  }
});

test('an upload grant defaults its lifetime only when none is supplied', async () => {
  const f = await fixture();
  const before = await effects(f);
  await rejects(f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'text/plain', maxBytes: 8, expiresInSeconds: null }),
    'INVALID_ARGUMENT');
  assert.deepEqual(await effects(f), before, 'no grant');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: 'text/plain', maxBytes: 8 });
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), sourceBounds.grantSeconds * 1000);
});

// STA-34: versioned text extraction.
const extractionRows = async spaceId => (await pool.query(`SELECT source_id,version::int,parser,content FROM extraction_versions
  WHERE space_id=$1 ORDER BY source_id,version`, [spaceId])).rows;
/** Commit an uploaded original of `bytes` with `mimeType`. */
async function uploadSource(f, bytes, mimeType) {
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType, maxBytes: Math.max(1, bytes.length) });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes, { size: 65536 }),
    { bytes: bytes.length, mimeType });
  return f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
}
/** Record every R2 get, so a test can tell whether an original was read. */
function countGets(r2) {
  const gets = [];
  const get = r2.get.bind(r2);
  r2.get = async key => { gets.push(key); return get(key); };
  return gets;
}

test('a corrected extraction is the next version, and every earlier version stays readable', async () => {
  const f = await fixture();
  const source = await f.sources.ingestText(f.agent, f.spaceId, 'alpha',
    { idempotencyKey: 'notes', text: '﻿First line\nSecond lnie\n', mimeType: 'text/markdown' });
  await rejects(f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId), 'NOT_FOUND', 'nothing extracted yet');
  const first = await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId);
  assert.match(first.createdAt, /Z$/);
  assert.deepEqual({ ...first, createdAt: null }, { sourceId: source.sourceId, collectionId: 'alpha', version: 1, latestVersion: 1,
    previousVersion: null, sourceSha256: source.original.sha256, parser: 'stateplane.text', parserVersion: '1',
    content: 'First line\nSecond lnie\n', sourceOffsets: [{ start: 0, end: 23, sourceStart: 3, sourceEnd: 26 }], createdAt: null,
    replayed: false });
  assert.deepEqual(await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId), { ...first, replayed: true },
    'the same parser and version replays its version');

  const corrected = { baseVersion: 1, content: 'First line\nSecond line\n', sourceOffsets: [
    { start: 0, end: 11, sourceStart: 3, sourceEnd: 14 }, { start: 11, end: 23, sourceStart: 14, sourceEnd: 26 }] };
  const second = await f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, corrected);
  assert.deepEqual({ ...second, createdAt: null }, { ...first, version: 2, latestVersion: 2, previousVersion: 1,
    parser: 'stateplane.correction', parserVersion: '1', content: corrected.content, sourceOffsets: corrected.sourceOffsets,
    createdAt: null });
  assert.deepEqual(await f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, corrected),
    { ...second, replayed: true }, 'repeating a committed correction replays it');
  // Any other version after the base conflicts: different text, or the same text from another credential.
  await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId,
    { ...corrected, content: 'First line\nSecond line!\n' }), 'REVISION_CONFLICT');
  await rejects(f.sources.correctExtraction(f.other, f.spaceId, 'alpha', source.sourceId, corrected), 'REVISION_CONFLICT');
  await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, { ...corrected, baseVersion: 3 }), 'NOT_FOUND');

  assert.deepEqual(await f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId, 1), { ...first, latestVersion: 2 },
    'the corrected version is unchanged and still readable');
  assert.deepEqual(await f.sources.extraction(f.other, f.spaceId, 'alpha', source.sourceId), second, 'the latest is the correction');
  assert.deepEqual(await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId), { ...first, latestVersion: 2, replayed: true },
    'extracting again does not undo the correction');
  const third = await f.sources.correctExtraction(f.other, f.spaceId, 'alpha', source.sourceId,
    { baseVersion: 2, content: 'Second line\n', sourceOffsets: [{ start: 0, end: 12, sourceStart: 14, sourceEnd: 26 }] });
  assert.deepEqual([third.version, third.previousVersion], [3, 2]);
  assert.deepEqual((await extractionRows(f.spaceId)).map(row => [row.version, row.parser, row.content]), [
    [1, 'stateplane.text', 'First line\nSecond lnie\n'], [2, 'stateplane.correction', corrected.content],
    [3, 'stateplane.correction', 'Second line\n']]);
  for (const version of [0, -1, 1.5, '1', null, 2 ** 53])
    await rejects(f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId, version), 'INVALID_ARGUMENT', String(version));
  await rejects(f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId, 4), 'NOT_FOUND');
});

test('unsupported, reference-only and oversized sources are refused before their bytes are read, and leave no extraction', async () => {
  const f = await fixture();
  const gets = countGets(f.r2);
  const refused = [
    await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'html', text: '<p>markup</p>', mimeType: 'text/html' }),
    await f.sources.ingestReference(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'ref', locator: 'https://example.invalid/a.txt',
      mimeType: 'text/plain' }),
    await uploadSource(f, Buffer.from('%PDF-1.7 binary'), 'application/pdf'),
    await uploadSource(f, Buffer.alloc(1_048_577, 0x61), 'text/plain')
  ];
  gets.length = 0;
  for (const source of refused)
    await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId), 'INVALID_ARGUMENT', source.original.mimeType);
  assert.deepEqual(gets, [], 'no original was read');
  assert.deepEqual(await extractionRows(f.spaceId), []);
  // A correction needs an extraction to correct, which these sources cannot have.
  for (const source of refused) await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId,
    { baseVersion: 1, content: 'x', sourceOffsets: [] }), 'NOT_FOUND');
  const limit = await uploadSource(f, Buffer.alloc(1_048_576, 0x61), 'text/csv');
  const extracted = await f.sources.extract(f.agent, f.spaceId, 'alpha', limit.sourceId);
  assert.deepEqual(extracted.sourceOffsets, [{ start: 0, end: 1_048_576, sourceStart: 0, sourceEnd: 1_048_576 }], 'exactly the bound is extracted');
  assert.deepEqual((await extractionRows(f.spaceId)).map(row => row.source_id), [limit.sourceId]);
});

test('malformed, corrupted or unreadable originals are refused without a partial extraction', async () => {
  const f = await fixture();
  const ingest = (key, text) => f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: key, text });
  // Text ingestion accepts NUL, which extraction content cannot hold.
  const nul = await ingest('nul', 'a\u0000b');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', nul.sourceId), 'INVALID_ARGUMENT', 'NUL');
  const swapped = await ingest('swapped', 'original text');
  const stored = f.r2.objects.get(await sourceKey(f, swapped.sourceId));
  stored.bytes = Buffer.from('replaced text');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', swapped.sourceId), 'PROVIDER_UNAVAILABLE', 'same size, other digest');
  const longer = await ingest('longer', 'short');
  f.r2.objects.get(await sourceKey(f, longer.sourceId)).bytes = Buffer.from('shorter');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', longer.sourceId), 'PROVIDER_UNAVAILABLE', 'other size');
  const missing = await ingest('missing', 'gone');
  f.r2.objects.delete(await sourceKey(f, missing.sourceId));
  await assert.rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', missing.sourceId),
    error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false);
  assert.deepEqual(await extractionRows(f.spaceId), []);

  // A body that fails mid-read is a retryable provider failure; the retry extracts.
  const interrupted = await ingest('interrupted', 'x'.repeat(64));
  const key = await sourceKey(f, interrupted.sourceId);
  const get = f.r2.get.bind(f.r2);
  f.r2.get = async target => {
    const object = await get(target);
    if (target !== key) return object;
    f.r2.get = get;
    return { ...object, body: new ReadableStream({ start(controller) { controller.error(new Error('socket closed')); } }) };
  };
  await assert.rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', interrupted.sourceId), error =>
    error.code === 'PROVIDER_UNAVAILABLE' && classifyError(error, false).retryable === true);
  assert.deepEqual(await extractionRows(f.spaceId), []);
  assert.equal((await f.sources.extract(f.agent, f.spaceId, 'alpha', interrupted.sourceId)).version, 1);
});

test('a correction is validated against the contract and its original only after the caller is authorized', async () => {
  const f = await fixture();
  const source = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'base', text: 'abcdef' });
  await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId);
  await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'beta', source.sourceId, { unknown: true }), 'FORBIDDEN',
    'an unauthorized caller learns nothing from its input');
  const segment = { start: 0, end: 6, sourceStart: 0, sourceEnd: 6 };
  const valid = { baseVersion: 1, content: 'abcdef', sourceOffsets: [segment] };
  const extra = Object.assign([segment], { note: 'x' });
  const holey = [segment, , segment]; // eslint-disable-line no-sparse-arrays
  const accessor = Object.defineProperty({ ...segment }, 'end', { get: () => 6, enumerable: true });
  const subclass = class extends Array {};
  const hidden = Object.defineProperty([], '0', { value: segment, enumerable: false });
  for (const [name, request] of [
    ['an array request', [valid]], ['a proxy request', new Proxy({ ...valid }, {})], ['an unknown field', { ...valid, parser: 'x' }],
    ['a missing field', { baseVersion: 1, content: 'abcdef' }], ['an undefined field', { ...valid, sourceOffsets: undefined }],
    ['a zero base', { ...valid, baseVersion: 0 }], ['a fractional base', { ...valid, baseVersion: 1.5 }],
    ['a string base', { ...valid, baseVersion: '1' }], ['numeric content', { ...valid, content: 7 }],
    ['content with NUL', { ...valid, content: 'abc\u0000ef' }], ['content with a lone surrogate', { ...valid, content: 'abc\uD800ef' }],
    ['content over the bound', { ...valid, content: 'é'.repeat(524_289), sourceOffsets: [] }],
    ['offsets that are not an array', { ...valid, sourceOffsets: { 0: segment, length: 1 } }],
    ['a proxy offsets array', { ...valid, sourceOffsets: new Proxy([segment], {}) }],
    ['an offsets array with another member', { ...valid, sourceOffsets: extra }],
    ['an offsets array with a hole', { ...valid, sourceOffsets: holey }],
    ['an offsets array of another class', { ...valid, sourceOffsets: subclass.from([segment]) }],
    ['a hidden offsets item', { ...valid, sourceOffsets: hidden }],
    ['a segment with an unknown key', { ...valid, sourceOffsets: [{ ...segment, kind: 'x' }] }],
    ['a segment with a missing key', { ...valid, sourceOffsets: [{ start: 0, end: 6, sourceStart: 0 }] }],
    ['a segment accessor', { ...valid, sourceOffsets: [accessor] }],
    ['a proxy segment', { ...valid, sourceOffsets: [new Proxy({ ...segment }, {})] }],
    ['a fractional offset', { ...valid, sourceOffsets: [{ ...segment, end: 5.5 }] }],
    ['a content range past the content', { ...valid, sourceOffsets: [{ ...segment, end: 7 }] }],
    ['a byte range past the original', { ...valid, sourceOffsets: [{ ...segment, sourceEnd: 7 }] }],
    ['overlapping segments', { ...valid, sourceOffsets: [segment, { ...segment, start: 5 }] }],
    ['too many segments', { ...valid, content: 'a'.repeat(4097), sourceOffsets: Array.from({ length: 4097 },
      (_, i) => ({ start: i, end: i + 1, sourceStart: 0, sourceEnd: 0 })) }]
  ]) await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, request), 'INVALID_ARGUMENT', name);
  assert.deepEqual((await extractionRows(f.spaceId)).map(row => row.version), [1], 'no refused correction wrote a version');
  assert.equal((await f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, valid)).version, 2);
});

test('extraction needs sources:read and sources:write on the owning collection, and a read-only space only replays', async () => {
  const f = await fixture();
  const reader = await verify((await spaces.issueAgentKey(f.owner, f.spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['sources:read'] }])).secret);
  const source = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'scoped', text: 'scoped text' });
  const correction = { baseVersion: 1, content: 'scoped', sourceOffsets: [] };
  // Extraction returns the source's text, so a writer without read access cannot extract.
  await rejects(f.sources.extract(f.writer, f.spaceId, 'alpha', source.sourceId), 'FORBIDDEN', 'writer only');
  await rejects(f.sources.extract(reader, f.spaceId, 'alpha', source.sourceId), 'FORBIDDEN', 'reader only');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'beta', source.sourceId), 'FORBIDDEN', 'ungranted collection');
  assert.deepEqual(await extractionRows(f.spaceId), []);
  const first = await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId);
  await rejects(f.sources.extraction(f.writer, f.spaceId, 'alpha', source.sourceId), 'FORBIDDEN', 'writer reads');
  assert.equal((await f.sources.extraction(reader, f.spaceId, 'alpha', source.sourceId)).content, 'scoped text');
  await rejects(f.sources.correctExtraction(reader, f.spaceId, 'alpha', source.sourceId, correction), 'FORBIDDEN', 'reader corrects');
  await rejects(f.sources.correctExtraction(f.writer, f.spaceId, 'alpha', source.sourceId, correction), 'FORBIDDEN', 'writer corrects');
  // A source is reached only through its owning collection, even by the owner.
  const betaSource = await f.sources.ingestText(f.owner, f.spaceId, 'beta', { idempotencyKey: 'beta', text: 'beta text' });
  await rejects(f.sources.extract(f.owner, f.spaceId, 'alpha', betaSource.sourceId), 'NOT_FOUND');
  await rejects(f.sources.extraction(f.agent, f.spaceId, 'alpha', betaSource.sourceId), 'NOT_FOUND');
  await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', betaSource.sourceId, correction), 'NOT_FOUND');
  assert.equal((await f.sources.extract(f.owner, f.spaceId, 'beta', betaSource.sourceId)).collectionId, 'beta');
  const corrected = await f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, correction);

  const unextracted = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'later', text: 'later text' });
  await spaces.update(f.owner, f.spaceId, 'readOnly');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', unextracted.sourceId), 'SPACE_UNAVAILABLE');
  await rejects(f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, { ...correction, baseVersion: 2 }),
    'SPACE_UNAVAILABLE');
  assert.equal((await f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId)).replayed, true);
  assert.deepEqual(await f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, correction),
    { ...corrected, replayed: true });
  assert.equal((await f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId, 1)).content, first.content);
  await spaces.update(f.owner, f.spaceId, 'suspended');
  await rejects(f.sources.extraction(f.agent, f.spaceId, 'alpha', source.sourceId), 'SPACE_UNAVAILABLE');
  await rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId), 'SPACE_UNAVAILABLE');
});

test('concurrent extractions commit one version, and concurrent corrections of one base commit one', async () => {
  const f = await fixture();
  const source = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'race', text: 'race text' });
  const extracted = await Promise.all(Array.from({ length: 4 }, () => f.sources.extract(f.agent, f.spaceId, 'alpha', source.sourceId)));
  assert.deepEqual(extracted.map(view => view.version), [1, 1, 1, 1]);
  assert.equal(extracted.filter(view => !view.replayed).length, 1);
  const settled = await Promise.allSettled(['race text!', 'race text?'].map(content =>
    f.sources.correctExtraction(f.agent, f.spaceId, 'alpha', source.sourceId, { baseVersion: 1, content, sourceOffsets: [] })));
  assert.deepEqual(settled.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(settled.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.deepEqual((await extractionRows(f.spaceId)).map(row => row.version), [1, 2]);
});

test('an extraction rechecks its caller after reading the original, and a stalled read ends at its bound', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const holdGet = (key, stall = false) => {
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const atGet = new Promise(resolve => { reached = resolve; });
    const state = { cancelled: false };
    const get = f.r2.get.bind(f.r2);
    f.r2.get = async target => {
      if (target !== key) return get(target);
      f.r2.get = get;
      reached();
      await held;
      const object = await get(target);
      return stall ? { ...object, body: new ReadableStream({ pull: () => new Promise(() => {}),
        cancel: () => { state.cancelled = true; } }) } : object;
    };
    return { atGet, release, state };
  };
  const key = await spaces.issueAgentKey(f.owner, f.spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['sources:read', 'sources:write'] }]);
  const actor = await verify(key.secret);
  const source = await f.sources.ingestText(actor, f.spaceId, 'alpha', { idempotencyKey: 'revoked', text: 'revoked text' });
  const hold = holdGet(await sourceKey(f, source.sourceId));
  const extracting = f.sources.extract(actor, f.spaceId, 'alpha', source.sourceId);
  await hold.atGet;
  await spaces.revokeAgentKey(f.owner, f.spaceId, key.id);
  hold.release();
  await rejects(extracting, 'FORBIDDEN');
  assert.deepEqual(await extractionRows(f.spaceId), []);

  const stalled = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'stalled', text: 'stalled text' });
  const stall = holdGet(await sourceKey(f, stalled.sourceId), true);
  stall.release();
  const started = performance.now();
  await assert.rejects(f.sources.extract(f.agent, f.spaceId, 'alpha', stalled.sourceId), error =>
    error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true);
  assert.ok(performance.now() - started < 12_000, 'the read ends at its 10-second bound');
  await sleep(10);
  assert.equal(stall.state.cancelled, true, 'the stalled body is cancelled');
  assert.deepEqual(await extractionRows(f.spaceId), []);
});

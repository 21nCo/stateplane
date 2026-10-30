import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { BlobWriteError } from '../../packages/application/dist/index.js';
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
  async delete(key) { if (this.failDelete(key)) throw new Error('delete: provider unavailable'); this.objects.delete(key); }
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
// other code uses the real pool. Each fault or delay applies once.
let faults = [];
let delays = [];
const faulty = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return (sql, ...rest) => {
      const fault = typeof sql === 'string' ? faults.find(item => sql.includes(item.match)) : undefined;
      if (fault) { faults = faults.filter(item => item !== fault); return Promise.reject(fault.error); }
      const delay = typeof sql === 'string' ? delays.find(item => sql === item.match) : undefined;
      if (delay) { delays = delays.filter(item => item !== delay); return sleep(delay.ms).then(() => target.query(sql, ...rest)); }
      return target.query(sql, ...rest);
    };
  } });
} };

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
  return { spaceId, owner, r2, blobs, agent: await agentFor(['sources:read', 'sources:write']),
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
  assert.deepEqual(f.r2.objects.get(originalKey(f.spaceId, sha(bytes))).bytes, bytes);
  assert.equal(f.r2.objects.get(originalKey(f.spaceId, sha(bytes))).sha256, sha(bytes), 'the original carries its R2 checksum');
  const { source, body } = await f.sources.content(f.agent, f.spaceId, 'alpha', created.sourceId);
  assert.deepEqual(await read(body), bytes);
  assert.equal(source.sourceId, created.sourceId);

  const replay = await f.sources.ingestText(f.agent, f.spaceId, 'alpha', request);
  assert.deepEqual({ ...replay, replayed: false }, created);
  assert.equal(replay.replayed, true);
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { ...request, text: 'changed' }), 'IDEMPOTENCY_MISMATCH');
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { ...request, capturedAt: undefined }), 'IDEMPOTENCY_MISMATCH');
  await rejects(f.sources.ingestText(f.agent, f.spaceId, 'alpha', { ...request, locator: undefined }), 'IDEMPOTENCY_MISMATCH');
  // Another credential's identical key is a different request identity.
  const other = await f.sources.ingestText(f.other, f.spaceId, 'alpha', request);
  assert.notEqual(other.sourceId, created.sourceId);
  assert.equal(f.r2.keys('originals/').length, 1, 'identical bytes share one content-addressed original');
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
  const stored = f.r2.objects.get(originalKey(f.spaceId, sha(bytes)));
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
  const early = await f.sources.upload(f.agent, f.spaceId, 'alpha', expired.grantId, chunked(bytes), declared);
  const stalled = f.sources.upload(f.agent, f.spaceId, 'alpha', expired.grantId, chunked(bytes, { stallMs: 1500 }), declared);
  await rejects(stalled, 'FORBIDDEN', 'a stream still open at expiry is cut off');
  await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', expired.grantId, { attemptId: early.attemptId }), 'FORBIDDEN');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', expired.grantId, chunked(bytes), declared), 'FORBIDDEN');
  assert.deepEqual((await attempts(f.spaceId, expired.grantId)).map(row => [row.state, row.failure_code]),
    [['verified', null], ['failed', 'grant_expired']]);

  const revoked = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const verifiedAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', revoked.grantId, chunked(bytes), declared);
  const inFlight = f.sources.upload(f.agent, f.spaceId, 'alpha', revoked.grantId, chunked(bytes, { stallMs: 300 }), declared);
  await sleep(100);
  await rejects(f.sources.revokeUpload(f.other, f.spaceId, 'alpha', revoked.grantId), 'NOT_FOUND', 'another agent cannot revoke');
  const view = await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId);
  assert.ok(view.revokedAt);
  assert.equal((await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId)).revokedAt, view.revokedAt, 'revocation is idempotent');
  await rejects(inFlight, 'FORBIDDEN', 'a writer still streaming at revocation is refused');
  await rejects(f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', revoked.grantId, { attemptId: verifiedAttempt.attemptId }), 'FORBIDDEN');
  // The verified attempt's staging is gone, but it stays due until reconciliation rechecks its digest.
  assert.deepEqual((await attempts(f.spaceId, revoked.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_revoked', false], ['failed', 'grant_revoked', true]]);
  assert.deepEqual(staging(f.r2, f.spaceId).length, 1, 'only the expired grant still holds staging, until reconciliation');

  const ownerRevokes = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  assert.ok((await f.sources.revokeUpload(f.owner, f.spaceId, 'alpha', ownerRevokes.grantId)).revokedAt, 'the space owner may revoke');
  await rejects(f.sources.upload(f.agent, f.spaceId, 'alpha', ownerRevokes.grantId, chunked(bytes), declared), 'FORBIDDEN');
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 });
});

test('a failed metadata commit removes an unreferenced original but never one another source or intent needs', async () => {
  const f = await fixture();
  const bytes = Buffer.from('shared digest bytes');
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const start = async () => {
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64, expiresInSeconds: 60 });
    return { grant, attempt: await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared) };
  };
  const key = originalKey(f.spaceId, sha(bytes));
  const refused = Object.assign(new Error('permission denied'), { code: 'FORBIDDEN' });

  // A transient failure leaves the promoted original and the verified attempt for a retry.
  const retried = await start();
  faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('could not serialize'), { code: '40001' }) }];
  await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', retried.grant.grantId, { attemptId: retried.attempt.attemptId }));
  assert.equal(f.r2.objects.has(key), true);
  assert.deepEqual((await attempts(f.spaceId, retried.grant.grantId)).map(row => row.state), ['verified']);

  // A deterministic failure of another attempt with the same digest keeps the
  // original: the verified attempt above still intends to commit it.
  const blocked = await start();
  faults = [{ match: 'INSERT INTO sources', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', blocked.grant.grantId, { attemptId: blocked.attempt.attemptId }), 'FORBIDDEN');
  assert.deepEqual((await attempts(f.spaceId, blocked.grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'commit_failed', false]]);
  assert.deepEqual(staging(f.r2, f.spaceId), [`staging/${Buffer.from(f.spaceId).toString('base64url')}/${retried.grant.grantId}/${retried.attempt.attemptId}`],
    'only the verified attempt keeps staging');
  assert.equal(f.r2.objects.has(key), true, 'a verified intent keeps the shared original');
  const committed = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', retried.grant.grantId, { attemptId: retried.attempt.attemptId });
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', committed.sourceId)).body), bytes);

  // Once a committed source references the digest, a failure keeps it too.
  const later = await start();
  faults = [{ match: 'INSERT INTO sources', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', later.grant.grantId, { attemptId: later.attempt.attemptId }), 'FORBIDDEN');
  assert.equal(f.r2.objects.has(key), true);

  // An unreferenced digest is removed with its failed attempt, and no metadata remains.
  const lone = Buffer.from('bytes nobody else has');
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(lone), { ...declared, bytes: lone.length });
  faults = [{ match: 'UPDATE source_upload_grants SET finalized_at', error: refused }];
  await rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }), 'FORBIDDEN');
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, sha(lone))), false);
  assert.deepEqual(staging(f.r2, f.spaceId), []);
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 1, originals: 1, refs: 1 }, 'the failed commit wrote no source');

  // A failed text commit revokes its one-shot grant and leaves no bytes.
  faults = [{ match: 'INSERT INTO entity_refs', error: refused }];
  await rejects(f.faulty.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: 'lost', text: 'text nobody else has' }), 'FORBIDDEN');
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, sha('text nobody else has'))), false);
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
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, sha(bytes))), true);
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
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, sha(bytes))), true,
    'the live verified attempt with the same digest keeps the original');
  assert.deepEqual(staging(f.r2, f.spaceId).length, 1, 'only the live attempt keeps staging');
  assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', kept.sourceId)).body), leftoverBytes);
  assert.deepEqual((await attempts(f.spaceId, live.grantId)).map(row => row.state), ['verified']);
  await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', live.grantId);
  assert.equal(f.r2.objects.has(originalKey(f.spaceId, sha(bytes))), false, 'the last intent gone, the orphaned original is removed');
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
  assert.deepEqual(f.r2.keys(''), [originalKey(f.spaceId, sha(leftoverBytes))]);
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

test('a removal in flight cannot strand bytes that a new upload intent relies on', async () => {
  const f = await fixture();
  const bytes = Buffer.from('raced digest');
  const key = originalKey(f.spaceId, sha(bytes));
  const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
  const first = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const firstAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', first.grantId, chunked(bytes), declared);
  faults = [{ match: 'INSERT INTO sources', error: Object.assign(new Error('could not serialize'), { code: '40001' }) }];
  await assert.rejects(f.faulty.finalizeUpload(f.agent, f.spaceId, 'alpha', first.grantId, { attemptId: firstAttempt.attemptId }));
  assert.equal(f.r2.objects.has(key), true, 'the first attempt promoted the original');
  // A removal holds the digest's exclusive lock, has found no reference and
  // has deleted the object, but has not committed yet.
  const remover = await pool.connect();
  try {
    await remover.query('BEGIN');
    await remover.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['stateplane:original', f.spaceId, sha(bytes)])]);
    f.r2.objects.delete(key);
    const second = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
    let settled = false;
    const intent = f.sources.upload(f.agent, f.spaceId, 'alpha', second.grantId, chunked(bytes), declared)
      .finally(() => { settled = true; });
    await sleep(300);
    assert.equal(settled, false, 'the new intent waits for the removal to commit');
    await remover.query('COMMIT');
    const secondAttempt = await intent;
    const source = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', second.grantId, { attemptId: secondAttempt.attemptId });
    assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', source.sourceId)).body), bytes,
      'finalize copies the bytes again from its own staging');
  } finally { remover.release(); }
  const retried = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', first.grantId, { attemptId: firstAttempt.attemptId });
  assert.equal(retried.original.sha256, sha(bytes));
});

/** Hold the next R2 put of `key` before it reads its body, until released. */
function holdPut(r2, key) {
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const atPut = new Promise(resolve => { reached = resolve; });
  r2.beforePut = async target => { if (target === key) { r2.beforePut = async () => {}; reached(); await held; } };
  return { atPut, release };
}

test('a finalize copy that lands after revocation leaves no unreferenced original, at once or after reconciliation', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const race = async (text, sources) => {
    const bytes = Buffer.from(text);
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 2 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const key = originalKey(f.spaceId, sha(bytes));
    const { atPut, release } = holdPut(f.r2, key);
    const finalize = sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
    await atPut;
    await f.sources.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId);
    assert.equal(f.r2.objects.has(key), false, 'revocation found nothing to remove yet');
    return { key, grant, finalize: () => { release(); return finalize; } };
  };

  // The refused finalize rechecks its digest and removes the copy that landed late.
  const late = await race('copied after revocation', f.sources);
  await rejects(late.finalize(), 'FORBIDDEN');
  assert.equal(f.r2.stored.includes(late.key), true, 'the held copy did land');
  assert.equal(f.r2.objects.has(late.key), false, 'and was removed when its commit was refused');

  // A finalize that dies before its own recheck leaves the copy for reconciliation.
  const crashed = await race('copied, then the worker died', f.faulty);
  faults = [{ match: 'SELECT state,staging_key,observed_sha256,observed_bytes,staging_removed_at',
    error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }];
  await rejects(crashed.finalize(), 'FORBIDDEN');
  faults = [];
  assert.equal(f.r2.objects.has(crashed.key), true, 'the recheck did not run');
  assert.deepEqual((await attempts(f.spaceId, crashed.grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'grant_revoked', false]], 'the attempt stays due');
  await sleep(2100);
  while (await f.reconciler(0).step(500) === 500);
  assert.equal(f.r2.objects.has(crashed.key), false, 'reconciliation removes the unreferenced original');
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
  const key = originalKey(f.spaceId, sha(bytes));
  const { atPut, release } = holdPut(f.r2, key);
  const finalize = f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId });
  await atPut;
  await sleep(1200);
  release();
  await rejects(finalize, 'FORBIDDEN');
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

test('original removal and same-key ingestion stay correct under snapshot isolation session defaults', async () => {
  for (const level of ['repeatable read', 'serializable']) {
    const sessionPool = new pg.Pool({ connectionString: url, max: 6,
      options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` });
    try {
      assert.equal((await sessionPool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, level);
      const f = await fixture();
      // Hold one removal after its transaction has read (and so taken any
      // snapshot) but before it takes the digest's exclusive lock.
      let hold = null;
      const gated = { connect: async () => {
        const client = await sessionPool.connect();
        return new Proxy(client, { get(target, property) {
          if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
          return async (sql, params, ...rest) => {
            if (hold && typeof sql === 'string' && sql.includes('pg_advisory_xact_lock(') &&
              String(params?.[0]).includes('"stateplane:original"')) {
              const current = hold; hold = null; current.reached(); await current.held;
            }
            return target.query(sql, params, ...rest);
          };
        } });
      } };
      const sessions = new PostgresSources(spaces, new Map([['cell-a', { pool: gated, originals: f.blobs }]]));
      const bytes = Buffer.from(`shared under ${level}`);
      const declared = { bytes: bytes.length, mimeType: 'application/octet-stream' };
      const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
      const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), declared);
      let release, reached;
      hold = { held: new Promise(resolve => { release = resolve; }), reached: () => reached() };
      const atLock = new Promise(resolve => { reached = resolve; });
      const revocation = sessions.revokeUpload(f.agent, f.spaceId, 'alpha', grant.grantId);
      await atLock;
      // Another grant commits a source with the same digest meanwhile.
      const other = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
      const otherAttempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', other.grantId, chunked(bytes), declared);
      const committed = await f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', other.grantId, { attemptId: otherAttempt.attemptId });
      release();
      assert.ok((await revocation).revokedAt, level);
      assert.deepEqual(await read((await f.sources.content(f.agent, f.spaceId, 'alpha', committed.sourceId)).body), bytes,
        `${level}: the removal saw the committed source and kept its original`);

      // Concurrent retries of one text ingestion commit one source and all succeed.
      const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
        sessions.ingestText(f.agent, f.spaceId, 'alpha', { idempotencyKey: `race-${level}`, text: `raced under ${level}` })));
      assert.deepEqual(results.map(result => result.status === 'fulfilled' ? 'ok' : `${result.reason.code} ${result.reason.message}`),
        Array(6).fill('ok'), level);
      assert.equal(new Set(results.map(result => result.value.sourceId)).size, 1, level);
      assert.equal(results.filter(result => !result.value.replayed).length, 1, level);
    } finally { await sessionPool.end(); }
  }
});

test('a blob write never starts after its deadline and reports one the store confirmed after it', async () => {
  const r2 = new MemoryR2();
  const blobs = new R2BlobStore(r2);
  const bytes = Buffer.from('confirmed too late');
  const isDeadline = error => error instanceof BlobWriteError && error.reason === 'deadline';
  await assert.rejects(blobs.put('k/expired', chunked(bytes), { bytes: bytes.length, signal: AbortSignal.abort() }), isDeadline);
  assert.deepEqual(r2.started, [], 'no write starts once the deadline has passed');
  // The body ends before the deadline; the store confirms only after it.
  const deadline = new AbortController();
  r2.afterBody = async () => { deadline.abort(); await sleep(20); };
  await assert.rejects(blobs.put('k/late', chunked(bytes), { bytes: bytes.length, sha256: sha(bytes), signal: deadline.signal }),
    isDeadline, 'a write confirmed after its deadline is not reported as a success');
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
  assert.equal(f.r2.started.includes(originalKey(f.spaceId, sha(promoteBytes))), false, 'no promotion write started');
  assert.deepEqual((await attempts(f.spaceId, promoting.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'commit_failed', false]], 'the attempt that held a digest stays due');
  assert.deepEqual(f.r2.keys(''), []);
});

test('a promotion the store confirms after expiry is rechecked, at once or by reconciliation', async () => {
  const f = await fixture();
  const declared = { mimeType: 'application/octet-stream' };
  const lateCopy = async (text, sources, beforeConfirm = () => {}) => {
    const bytes = Buffer.from(text);
    const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { ...declared, maxBytes: 64, expiresInSeconds: 1 });
    const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(bytes), { ...declared, bytes: bytes.length });
    const key = originalKey(f.spaceId, sha(bytes));
    f.r2.afterBody = async target => {
      if (target !== key) return;
      f.r2.afterBody = async () => {};
      beforeConfirm();
      await sleep(1300);
    };
    await rejects(sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, { attemptId: attempt.attemptId }), 'FORBIDDEN');
    assert.equal(f.r2.stored.includes(key), true, 'the copy landed after expiry');
    return { key, grant };
  };
  const checked = await lateCopy('confirmed after expiry', f.sources);
  assert.equal(f.r2.objects.has(checked.key), false, 'the finalize rechecked its digest after the store answered');
  // The worker loses its connection before its own recheck.
  const crashed = await lateCopy('confirmed after expiry, then the worker died', f.faulty, () => {
    faults = [{ match: 'SELECT state,staging_key,observed_sha256,observed_bytes,staging_removed_at',
      error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }];
  });
  faults = [];
  assert.equal(f.r2.objects.has(crashed.key), true);
  assert.deepEqual((await attempts(f.spaceId, checked.grant.grantId)).map(row => [row.state, row.failure_code, row.removed]),
    [['failed', 'commit_failed', false]], 'an attempt that held a digest stays due');
  while (await f.reconciler(0).step(500) === 500);
  assert.equal(f.r2.objects.has(crashed.key), false, 'reconciliation removes the unreferenced original');
  for (const grant of [checked.grant, crashed.grant])
    assert.equal((await attempts(f.spaceId, grant.grantId))[0].removed, true);
  assert.deepEqual(f.r2.keys(''), []);
  assert.deepEqual(await sourceRows(f.spaceId), { sources: 0, originals: 0, refs: 0 });
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

test('source requests and upload bodies that are proxies are refused before any trap runs, with no effects', async () => {
  const f = await fixture();
  const declared = { bytes: 4, mimeType: 'application/octet-stream' };
  const grant = await f.sources.createUpload(f.agent, f.spaceId, 'alpha', { mimeType: declared.mimeType, maxBytes: 64 });
  const attempt = await f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')), declared);
  const effects = async () => ({ ...(await sourceRows(f.spaceId)), keys: f.r2.keys('').sort(), ledger: (await pool.query(
    `SELECT (SELECT count(*)::int FROM source_upload_grants WHERE space_id=$1) AS grants,
      (SELECT json_agg(json_build_array(attempt_id,state) ORDER BY attempt_id) FROM source_upload_attempts WHERE space_id=$1) AS attempts`,
    [f.spaceId])).rows[0] });
  const before = await effects();
  let traps = 0;
  const kinds = {
    transparent: target => new Proxy(target, new Proxy({}, { get(_, trap) { traps++; return Reflect[trap]; } })),
    throwing: target => new Proxy(target, new Proxy({}, { get() { traps++; return () => { throw new Error('proxy trap'); }; } })),
    revoked: target => { const { proxy, revoke } = Proxy.revocable(target, {}); revoke(); return proxy; }
  };
  const calls = {
    ingestText: wrap => f.sources.ingestText(f.agent, f.spaceId, 'alpha', wrap({ idempotencyKey: 'proxy', text: 'proxied text' })),
    ingestReference: wrap => f.sources.ingestReference(f.agent, f.spaceId, 'alpha', wrap({ idempotencyKey: 'proxy', locator: 'https://example.invalid/a' })),
    createUpload: wrap => f.sources.createUpload(f.agent, f.spaceId, 'alpha', wrap({ mimeType: 'text/plain', maxBytes: 8 })),
    uploadDeclaration: wrap => f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, chunked(Buffer.from('four')), wrap({ ...declared })),
    uploadBody: wrap => f.sources.upload(f.agent, f.spaceId, 'alpha', grant.grantId, wrap(chunked(Buffer.from('four'))), declared),
    finalizeUpload: wrap => f.sources.finalizeUpload(f.agent, f.spaceId, 'alpha', grant.grantId, wrap({ attemptId: attempt.attemptId }))
  };
  for (const [call, run] of Object.entries(calls)) for (const [kind, wrap] of Object.entries(kinds)) {
    traps = 0;
    await rejects(run(wrap), 'INVALID_ARGUMENT', `${call} with a ${kind} proxy`);
    assert.equal(traps, 0, `${call} ran no ${kind} proxy trap`);
  }
  assert.deepEqual(await effects(), before, 'no grant, attempt, source or blob changed');
});

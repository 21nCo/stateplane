import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { BlobWriteError, classifyError } from '@stateplane/application';
import type { BlobStore } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { commitBeforeDeadline, CommitNotSentDeadlineExceeded } from './commit-deadline.js';
import { AuthorityError, AuthorityTransaction, clientReadTimedOut, CommitOutcomeUnknownError } from './index.js';
import type { AuthorityScope } from './index.js';
import { acceptsInProcessObjects, includes, isInProcessProxy, scalarString, utcInstant } from './schema.js';
import type { PostgresSpaces } from './spaces.js';

/** One cell's authority pool and original-bytes store. */
export interface SourceCell { pool: Pick<pg.Pool, 'connect'>; originals: BlobStore }
export interface OriginalView {
  /** True when no bytes were fetched; `sha256` and `byteSize` are then null. */
  referenceOnly: boolean; sha256: string | null; byteSize: number | null; mimeType: string | null;
  capturedAt: string; observedAt: string;
}
export interface SourceView {
  sourceId: string; collectionId: string; locator: string | null; createdBy: string; createdAt: string;
  original: OriginalView; replayed: boolean;
}
export interface UploadGrantView {
  grantId: string; collectionId: string; mimeType: string; maxBytes: number; sha256: string | null;
  issuedAt: string; expiresAt: string; revokedAt: string | null; finalizedAt: string | null; sourceId: string | null;
}
export interface UploadAttemptView { grantId: string; attemptId: string; sha256: string; bytes: number; mimeType: string }

/** Initial bounds; docs/evidence-storage.md records the evidence for each. */
export const sourceBounds = Object.freeze({
  textBytes: 1_048_576, uploadBytes: 26_214_400, grantSeconds: 300, maxGrantSeconds: 900,
  textGrantSeconds: 60, reconcileGraceSeconds: 300
});
const REQUEST_BUDGET_MS = 30_000;
const STATEMENT_MS = 5_000;
const LOCK_MS = 2_000;
const sha256Pattern = /^[0-9a-f]{64}$/;
const mimePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
// Decisions on caller input use intrinsics captured at module load, so a later
// change to an inherited method or a global cannot alter what a request means.
const apply = Reflect.apply;
const isSafeInteger = Number.isSafeInteger;
const stringify = JSON.stringify;
const nativeIndexOf = String.prototype.indexOf;
const nativeSlice = String.prototype.slice;
const nativeTrim = String.prototype.trim;
const nativeLowerCase = String.prototype.toLowerCase;
const nativeStartsWith = String.prototype.startsWith;
const nativeRegexExec = RegExp.prototype.exec;
const matches = (pattern: RegExp, value: string) => apply(nativeRegexExec, pattern, [value]) !== null;
const startsWith = (value: string, prefix: string) => apply(nativeStartsWith, value, [prefix]) as boolean;
/** `JSON.stringify` of a string list, read by own index rather than through the array's iterator or `toJSON`. */
function serialized(parts: readonly string[]): string {
  let text = '[';
  for (let i = 0; i < parts.length; i++) text += (i ? ',' : '') + stringify(Object.getOwnPropertyDescriptor(parts, i)!.value);
  return `${text}]`;
}
type Db = pg.PoolClient;
type Key = [spaceId: string, collectionId: string, grantId: string, attemptId: string];
interface Admitted { cell: SourceCell; ownerPrincipalId: string; scope: AuthorityScope; capability: Capability }
interface Wanted {
  sourceId: string; locator: string | null; capturedAt: string | null;
  referenceOnly: boolean; sha256: string | null; mimeType: string | null;
}

const spaceSegment = (spaceId: string) => Buffer.from(spaceId, 'utf8').toString('base64url');
/**
 * Each attempt promotes its bytes to a key of its own, which `original_objects`
 * records when the attempt commits. No other attempt ever writes or deletes it.
 */
export const originalKey = (spaceId: string, grantId: string, attemptId: string) =>
  `originals/${spaceSegment(spaceId)}/${grantId}/${attemptId}`;
const stagingKey = (spaceId: string, grantId: string, attemptId: string) =>
  `staging/${spaceSegment(spaceId)}/${grantId}/${attemptId}`;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const derivedSourceId = (parts: readonly string[]) => `src_${digest(serialized(parts))}`;
const lockKey = (parts: readonly string[]) => serialized(parts);
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
const pgCode = (error: unknown) => (error as { code?: unknown })?.code;

function invalid(message?: string): never { throw new AuthorityError('INVALID_ARGUMENT', message); }
/** True for an object the runtime cannot inspect without running caller code: any proxy, or every object without a detector. */
const untrusted = (value: object) => !acceptsInProcessObjects || isInProcessProxy(value);
/**
 * Snapshot a request: a plain object (prototype `Object.prototype` or null)
 * whose own members are all enumerable data fields with allowed string keys.
 * A proxy is refused before any reflective read can run its traps, and no
 * accessor is invoked. A field given as `undefined` is supplied, not omitted,
 * so it is refused like any other invalid value. Keys and lists are read by
 * own index, never through an inherited iterator or array method.
 */
function fields(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || untrusted(value) || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = Object.getOwnPropertyDescriptor(keys, i)!.value as PropertyKey;
    if (typeof key !== 'string' || !includes(allowed, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) invalid();
    copy[key] = descriptor.value;
  }
  for (let i = 0; i < required.length; i++) if (!Object.hasOwn(copy, Object.getOwnPropertyDescriptor(required, i)!.value)) invalid();
  return copy;
}
/** Well-formed Unicode text without NUL, within a UTF-8 byte bound. */
function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes && scalarString(value) &&
    Buffer.byteLength(value) <= maxBytes;
}
const reference = (value: unknown): value is string => boundedText(value, 256);
/** The lowercase type/subtype essence of a media type; parameters are dropped. */
function mimeEssence(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) invalid('Invalid MIME type');
  const end = apply(nativeIndexOf, value, [';']) as number;
  const type = end < 0 ? value : apply(nativeSlice, value, [0, end]) as string;
  const essence = apply(nativeLowerCase, apply(nativeTrim, type, []), []) as string;
  if (!matches(mimePattern, essence)) invalid('Invalid MIME type');
  return essence;
}
function optionalDigest(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !matches(sha256Pattern, value)) invalid('Invalid SHA-256 digest');
  return value;
}
function optionalLocator(value: unknown): string | null {
  if (value === undefined) return null;
  if (!boundedText(value, 4096)) invalid('Invalid locator');
  return value;
}
function optionalInstant(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') invalid('Invalid capturedAt');
  try { return utcInstant(value); } catch { return invalid('Invalid capturedAt'); }
}
function idempotencyKey(value: unknown): string {
  if (!boundedText(value, 512)) invalid('Invalid idempotency key');
  return value;
}

/**
 * Run one transaction under the authority's budget. A COMMIT the server
 * refused for a constraint or serialization error rolled back; any other
 * missing acknowledgement leaves the outcome unknown. Every read that follows
 * an advisory or row lock here must see rows committed before that lock was
 * granted, so the isolation level is fixed rather than the session default.
 * A session that may still hold an open transaction or an unanswered
 * statement, after a BEGIN without a reply, a read timeout or an
 * unacknowledged COMMIT, is discarded rather than returned to the pool.
 * A read timeout or lost session before COMMIT is sent committed nothing,
 * so it is a retryable provider failure, never an unknown outcome.
 */
async function transact<T>(pool: Pick<pg.Pool, 'connect'>, fn: (db: Db) => Promise<T>): Promise<T> {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const client = await pool.connect();
  let beginAttempted = false;
  let begun = false;
  let discard = false;
  let lost = false;
  let commitSent = false;
  const onError = () => { discard = true; lost = true; };
  client.on?.('error', onError);
  try {
    beginAttempted = true;
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
    const result = await fn(client);
    begun = false;
    commitSent = true;
    try { await commitBeforeDeadline(client, deadline); }
    catch (error) {
      discard = true;
      if (error instanceof CommitNotSentDeadlineExceeded) throw new AuthorityError('RATE_LIMITED', 'Request time budget exceeded');
      // Migration 041's commit-time check: the transition reached COMMIT after its grant expired, so it rolled back.
      if (error instanceof pg.DatabaseError && error.constraint === 'source_upload_attempts_expiry') throw grantExpired();
      if (error instanceof pg.DatabaseError && matches(/^(?:23|40)/, error.code ?? '')) throw error;
      throw new CommitOutcomeUnknownError(error);
    }
    return result;
  } catch (error) {
    if (begun && !clientReadTimedOut(error)) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    else if (beginAttempted) discard = true;
    if (pgCode(error) === '57014') throw new AuthorityError('RATE_LIMITED', 'Database statement time limit exceeded');
    if (pgCode(error) === '55P03') throw new AuthorityError('BACKPRESSURE', 'Database lock budget exceeded');
    if (!commitSent && !(error instanceof AuthorityError) && !(error instanceof pg.DatabaseError) &&
      (lost || clientReadTimedOut(error) || (error instanceof Error && error.name === 'HostProviderTimeoutError')))
      throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Database session failed before commit; retry the request', undefined, true);
    throw error;
  } finally { client.release(discard); client.removeListener?.('error', onError); }
}

async function writable(db: Db, scope: AuthorityScope): Promise<void> {
  const row = (await db.query(`SELECT s.lifecycle,c.lifecycle AS collection_lifecycle FROM spaces s
    JOIN collections c ON c.space_id=s.space_id WHERE s.space_id=$1 AND c.collection_id=$2`,
  [scope.spaceId, scope.collectionId])).rows[0];
  if (row?.lifecycle !== 'active' || row.collection_lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
}
async function capturedNotFuture(db: Db, capturedAt: string | null): Promise<void> {
  if (capturedAt === null) return;
  const row = (await db.query('SELECT $1::timestamptz <= clock_timestamp() AS past', [capturedAt])).rows[0];
  if (row?.past !== true) invalid('capturedAt is in the future');
}

/**
 * An attempt's original key is referenced only once the attempt commits, and
 * removed only once it has failed. Both states are final, so a removal can
 * never target bytes a commit relies on, however late its delete lands, and
 * it needs no lock. It must run only after the failure has committed.
 *
 * A revocation can fail an attempt while its promotion is still writing, so
 * the write may land after the removal. Promotion therefore stops at its
 * grant's expiry, the finalize that promoted removes its original again
 * whenever it fails, a failed attempt that held a digest stays due for
 * reconciliation, which removes it once more after the grace period, and the
 * sweep removes a copy that R2 confirms later still.
 */
const attemptOriginal = (key: Key) => originalKey(key[0], key[2], key[3]);
const removeOriginal = (cell: SourceCell, key: Key) => cell.originals.delete(attemptOriginal(key));
/** Make an attempt's original present, copying its verified bytes when absent, before `signal` aborts. */
async function ensureOriginal(blobs: BlobStore, key: string, sha256: string, bytes: number,
  mimeType: string, from: string | Uint8Array, signal: AbortSignal): Promise<void> {
  const existing = await beforeAbort(blobs.head(key), signal);
  if (existing && existing.bytes === bytes && existing.sha256 === sha256) return;
  const staged = typeof from === 'string' ? (await beforeAbort(blobs.get(from), signal,
    late => void late?.body.cancel().catch(() => {})))?.body : from;
  if (!staged) throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Staged upload bytes are missing', undefined, false);
  if (signal.aborted) {
    if (!(staged instanceof Uint8Array)) await staged.cancel().catch(() => {});
    throw new BlobWriteError('deadline');
  }
  // The store rechecks length and digest, so corrupted staging stores nothing.
  await blobs.put(key, staged, { bytes, sha256, contentType: mimeType, signal });
}
/**
 * Settle with `pending`, or fail with a deadline error once `signal` aborts
 * first; a value that arrives after that is passed to `late` to release it.
 */
function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal, late: (value: T) => void = () => {}): Promise<T> {
  let settled = false;
  const abandoned = () => { void pending.then(value => { if (!settled) late(value); }, () => {}); };
  if (signal.aborted) { abandoned(); return Promise.reject(new BlobWriteError('deadline')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { abandoned(); reject(new BlobWriteError('deadline')); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { settled = !signal.aborted; resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
/**
 * A deterministic or refused failure ends the attempt now; a transient one
 * leaves it for retry. A copy whose staging read was interrupted is transient.
 */
function settlesNow(error: unknown): boolean {
  if (error instanceof CommitOutcomeUnknownError) return false;
  if (error instanceof BlobWriteError) return error.reason !== 'interrupted';
  if (pgCode(error) === '23505') return true;
  return !classifyError(error, false).retryable;
}
/** Text bodies must be well-formed UTF-8; a refused body fails the write. */
function utf8Checked(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try { decoder.decode(chunk, { stream: true }); } catch (error) { throw new BlobWriteError('content', { cause: error }); }
      controller.enqueue(chunk);
    },
    flush() {
      try { decoder.decode(); } catch (error) { throw new BlobWriteError('content', { cause: error }); }
    }
  }));
}
/** Pass stored bytes through, erroring the stream if they differ from the recorded digest or size. */
function verified(body: ReadableStream<Uint8Array>, sha256: string, bytes: number): ReadableStream<Uint8Array> {
  const hash = createHash('sha256');
  let seen = 0;
  const corrupt = () => new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes failed verification', undefined, false);
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > bytes) throw corrupt();
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() { if (seen !== bytes || hash.digest('hex') !== sha256) throw corrupt(); }
  }));
}
const failureCodes: Record<BlobWriteError['reason'], string> = {
  length: 'length_mismatch', digest: 'digest_mismatch', content: 'content_rejected',
  interrupted: 'interrupted', deadline: 'grant_expired'
};
/**
 * Promotion copies already verified bytes, so only expiry is the caller's
 * failure; an interrupted read of staging may be retried, and anything else
 * means staging no longer matches its verification.
 */
function promotionFailure(error: unknown): unknown {
  if (!(error instanceof BlobWriteError)) return error;
  if (error.reason === 'deadline') return new AuthorityError('FORBIDDEN', 'Upload grant expired');
  if (error.reason === 'interrupted')
    return new AuthorityError('PROVIDER_UNAVAILABLE', 'Reading staged upload bytes failed; retry the request', undefined, true);
  return new AuthorityError('PROVIDER_UNAVAILABLE', 'Staged upload bytes failed verification', undefined, false);
}
function uploadFailure(error: unknown): unknown {
  if (!(error instanceof BlobWriteError)) return error;
  if (error.reason === 'deadline') return new AuthorityError('FORBIDDEN', 'Upload grant expired');
  return new AuthorityError('INVALID_ARGUMENT', {
    length: 'Upload size differs from its declaration', digest: 'Upload digest does not match',
    content: 'Upload content is not valid for its MIME type', interrupted: 'Upload body failed before completion'
  }[error.reason], undefined, false);
}

const viewColumns = `s.collection_id,s.source_id,s.locator,s.principal_id,s.created_at,o.reference_only,o.sha256,
  o.byte_size,o.mime_type,o.captured_at,o.observed_at,o.object_key,e.tombstone`;
const viewSources = `FROM sources s JOIN original_objects o USING (space_id,collection_id,source_id)
  JOIN entity_refs e ON e.space_id=s.space_id AND e.collection_id=s.collection_id AND e.kind='source' AND e.entity_id=s.source_id`;
function sourceView(row: Record<string, unknown>, replayed: boolean): SourceView {
  return { sourceId: String(row.source_id), collectionId: String(row.collection_id), locator: row.locator as string | null,
    createdBy: String(row.principal_id), createdAt: iso(row.created_at)!,
    original: { referenceOnly: row.reference_only === true, sha256: row.sha256 as string | null,
      byteSize: row.byte_size === null ? null : Number(row.byte_size), mimeType: row.mime_type as string | null,
      capturedAt: iso(row.captured_at)!, observedAt: iso(row.observed_at)! }, replayed };
}
function grantView(row: Record<string, unknown>): UploadGrantView {
  return { grantId: String(row.grant_id), collectionId: String(row.collection_id), mimeType: String(row.mime_type),
    maxBytes: Number(row.max_bytes), sha256: row.expected_sha256 as string | null, issuedAt: iso(row.issued_at)!,
    expiresAt: iso(row.expires_at)!, revokedAt: iso(row.revoked_at), finalizedAt: iso(row.finalized_at),
    sourceId: row.source_id as string | null };
}
/** A live source in the scope's collection, with the key of its original bytes, which the view does not disclose. */
async function readSourceKey(db: Db, scope: AuthorityScope, sourceId: string, replayed: boolean):
  Promise<{ source: SourceView; objectKey: string | null }> {
  const row = (await db.query(`SELECT ${viewColumns} ${viewSources} WHERE s.space_id=$1 AND s.collection_id=$2 AND s.source_id=$3`,
    [scope.spaceId, scope.collectionId, sourceId])).rows[0];
  if (!row || row.tombstone) throw new AuthorityError('NOT_FOUND');
  return { source: sourceView(row, replayed), objectKey: row.object_key as string | null };
}
const readSource = async (db: Db, scope: AuthorityScope, sourceId: string, replayed: boolean) =>
  (await readSourceKey(db, scope, sourceId, replayed)).source;
/**
 * A request's source ID is derived from its credential and idempotency key, so
 * a retry finds the committed source. A different payload, or the same key
 * in another collection after that collection is authorized, is a mismatch.
 */
async function replay(db: Db, scope: AuthorityScope, wanted: Wanted): Promise<SourceView | null> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [lockKey(['stateplane:source', scope.spaceId, wanted.sourceId])]);
  const row = (await db.query(`SELECT ${viewColumns},
      CASE WHEN $3::timestamptz IS NULL THEN o.captured_at=o.observed_at ELSE o.captured_at=$3::timestamptz END AS same_capture
    ${viewSources} WHERE s.space_id=$1 AND s.source_id=$2`, [scope.spaceId, wanted.sourceId, wanted.capturedAt])).rows[0];
  if (!row) return null;
  if (row.collection_id !== scope.collectionId) {
    const original = new AuthorityTransaction(db, { ...scope, collectionId: row.collection_id }, 1);
    try { await original.checkScope(); } finally { original.close(); }
    throw new AuthorityError('IDEMPOTENCY_MISMATCH');
  }
  if (row.tombstone) throw new AuthorityError('NOT_FOUND');
  if (row.locator !== wanted.locator || row.reference_only !== wanted.referenceOnly || row.sha256 !== wanted.sha256 ||
    row.mime_type !== wanted.mimeType || row.same_capture !== true) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
  return sourceView(row, true);
}
/** Insert a source's identity, payload and original together, after `replay` found none. */
async function insertSource(db: Db, scope: AuthorityScope, wanted: Wanted, byteSize: number | null,
  objectKey: string | null): Promise<SourceView> {
  await capturedNotFuture(db, wanted.capturedAt);
  const ids = [scope.spaceId, scope.collectionId, wanted.sourceId];
  await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'source',$3)`, ids);
  await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [...ids, wanted.locator, scope.principalId, scope.credentialId]);
  // One clock reading marks an unstated capture time as the observation time.
  await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
    INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,observed_at,
      object_key) SELECT $1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,stamp.at),stamp.at,$9 FROM stamp`,
  [...ids, wanted.referenceOnly, wanted.sha256, byteSize, wanted.mimeType, wanted.capturedAt, objectKey]);
  return readSource(db, scope, wanted.sourceId, false);
}
const grantKey = (scope: AuthorityScope, grantId: string) => [scope.spaceId, scope.collectionId, grantId];
/** A grant's lifetime is measured from its own issue time, read once from the database clock. */
async function insertGrant(db: Db, scope: AuthorityScope, grantId: string, mimeType: string, maxBytes: number,
  sha256: string | null, seconds: number): Promise<Record<string, unknown>> {
  return (await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
    INSERT INTO source_upload_grants(space_id,collection_id,grant_id,principal_id,credential_id,mime_type,max_bytes,
      expected_sha256,issued_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,stamp.at,stamp.at+make_interval(secs=>$9) FROM stamp RETURNING *`,
  [...grantKey(scope, grantId), scope.principalId, scope.credentialId, mimeType, maxBytes, sha256, seconds])).rows[0];
}
/**
 * Lock a grant. Its `deadline` is a local monotonic instant (`performance.now`)
 * no later than its expiry: the remaining lifetime the database computes is
 * added to a reading taken before the query was sent.
 */
async function lockGrant(db: Db, scope: AuthorityScope, grantId: string, ownerPrincipalId?: string): Promise<Record<string, unknown>> {
  const sent = performance.now();
  const row = (await db.query(`SELECT *,expires_at<=clock_timestamp() AS expired,
      GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp())*1000) AS remaining_ms
    FROM source_upload_grants WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 FOR UPDATE`,
  grantKey(scope, grantId))).rows[0];
  // Another credential's grant is not disclosed; the space owner may revoke any.
  if (!row || (row.credential_id !== scope.credentialId && scope.principalId !== ownerPrincipalId))
    throw new AuthorityError('NOT_FOUND');
  return { ...row, deadline: sent + Number(row.remaining_ms) };
}
/**
 * A signal that aborts at a grant's deadline. Writes must not start once it
 * has aborted; the countdown is never restarted from a later reading.
 */
function writeWindow(deadline: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const remaining = deadline - performance.now();
  if (remaining <= 0) { controller.abort(); return { signal: controller.signal, close: () => {} }; }
  const timer = setTimeout(() => controller.abort(), Math.floor(remaining));
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}
const stream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof value === 'object' && value !== null && !untrusted(value) && value instanceof ReadableStream;
function usable(grant: Record<string, unknown>): void {
  if (grant.revoked_at) throw new AuthorityError('FORBIDDEN', 'Upload grant revoked');
  if (grant.finalized_at) throw new AuthorityError('FORBIDDEN', 'Upload grant already finalized');
  if (grant.expired) throw new AuthorityError('FORBIDDEN', 'Upload grant expired');
}
async function lockAttempt(db: Db, key: Key): Promise<Record<string, unknown> | undefined> {
  return (await db.query(`SELECT state,staging_key,observed_sha256,observed_bytes,staging_removed_at FROM source_upload_attempts
    WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 FOR UPDATE`, key)).rows[0];
}
async function failAttempt(db: Db, key: Key, code: string): Promise<void> {
  await db.query(`UPDATE source_upload_attempts SET state='failed',failure_code=$5,updated_at=clock_timestamp()
    WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4`, [...key, code]);
}
/**
 * Remove an attempt's staging blob, then record that the attempt holds no
 * bytes. A failed attempt that held a digest is recorded only once its
 * promotion window has closed (`settled`), by reconciliation. Removal
 * precedes the record, so a crash only repeats it.
 */
async function removeStaging(cell: SourceCell, key: Key, staging: string, settled = false,
  bounded: (pending: Promise<void>) => Promise<void> = pending => pending): Promise<void> {
  await bounded(cell.originals.delete(staging));
  await transact(cell.pool, db => db.query(`UPDATE source_upload_attempts
    SET staging_removed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 AND staging_removed_at IS NULL
      AND (state='committed' OR (state='failed' AND (observed_sha256 IS NULL OR $5::boolean)))`, [...key, settled]));
}
/**
 * Cleanup for an attempt that cannot commit now. With a code, a receiving or
 * verified attempt fails, and a one-shot text grant is revoked with it. Once
 * the attempt is durably failed, its original is removed, which also catches
 * a promotion that landed after a revocation removed it, and so is its
 * staging blob.
 */
async function abandon(cell: SourceCell, key: Key, code: string | null, revokeGrant = false): Promise<void> {
  const ended = await transact(cell.pool, async db => {
    const attempt = await lockAttempt(db, key);
    if (!attempt) return null;
    let state = attempt.state;
    if (code !== null && (state === 'receiving' || state === 'verified')) {
      await failAttempt(db, key, code);
      state = 'failed';
      if (revokeGrant) await db.query(`UPDATE source_upload_grants SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND revoked_at IS NULL AND finalized_at IS NULL`, key.slice(0, 3));
    }
    if (state !== 'failed') return null;
    return { promoted: attempt.observed_sha256 !== null, staging: attempt.staging_removed_at ? null : String(attempt.staging_key) };
  });
  if (ended?.promoted) await removeOriginal(cell, key);
  if (ended?.staging) await removeStaging(cell, key, ended.staging);
}
/** The attempt failure code for a caller whose authority or grant ended mid-request. */
const refusalCode = (error: unknown) => isGrantExpired(error) ? 'grant_expired' :
  error instanceof AuthorityError ? `refused_${error.code.toLowerCase()}` : 'commit_failed';

/**
 * Sources and short-lived upload grants for one owning collection. Every call
 * is admitted for the caller's own grant on that collection, and its
 * transaction rechecks policy, lifecycle and credential before COMMIT.
 */
export class PostgresSources {
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, SourceCell>) {}

  private async admit(actor: VerifiedCredential, spaceId: string, collectionId: string, capability: Capability): Promise<Admitted> {
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, capability);
    const cell = this.cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return { cell, ownerPrincipalId: admitted.ownerPrincipalId, scope: admitted.scope, capability };
  }

  private actorTx<T>(actor: VerifiedCredential, admitted: Admitted, fn: (db: Db) => Promise<T>): Promise<T> {
    return transact(admitted.cell.pool, async db => {
      const fence = new AuthorityTransaction(db, admitted.scope, 1);
      try {
        await fence.checkScope();
        const result = await fn(db);
        await fence.checkScope();
        await this.spaces.assertScopeCurrent(actor, admitted.ownerPrincipalId, admitted.scope, db,
          admitted.scope.collectionId, [admitted.capability]);
        return result;
      } finally { fence.close(); }
    });
  }

  /** Read one live source in the collection. Another collection's source is NOT_FOUND. */
  async get(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string): Promise<SourceView> {
    return (await this.read(actor, spaceId, collectionId, sourceId)).source;
  }

  private async read(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string):
    Promise<{ admitted: Admitted; source: SourceView; objectKey: string | null }> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:read');
    return { admitted, ...await this.actorTx(actor, admitted, db => {
      if (!reference(sourceId)) throw new AuthorityError('NOT_FOUND');
      return readSourceKey(db, admitted.scope, sourceId, false);
    }) };
  }

  /**
   * Stream a source's original bytes, verified against the recorded digest;
   * null body when reference-only. Authorization is evaluated when the
   * response starts: the caller's authority and the source are checked again
   * once the object is open, but a body already streaming is not cut off.
   */
  async content(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string):
    Promise<{ source: SourceView; body: ReadableStream<Uint8Array> | null }> {
    const { admitted, source, objectKey } = await this.read(actor, spaceId, collectionId, sourceId);
    const { referenceOnly, sha256, byteSize } = source.original;
    if (referenceOnly || sha256 === null || byteSize === null) return { source, body: null };
    const stored = objectKey === null ? null : await admitted.cell.originals.get(objectKey);
    if (!stored) throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes are missing', undefined, false);
    try {
      if (stored.bytes !== byteSize || (stored.sha256 !== null && stored.sha256 !== sha256))
        throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes failed verification', undefined, false);
      await this.actorTx(actor, admitted, db => readSource(db, admitted.scope, sourceId, false));
    } catch (error) {
      await stored.body.cancel(error).catch(() => {});
      throw error;
    }
    return { source, body: verified(stored.body, sha256, byteSize) };
  }

  /** Store bounded UTF-8 text as a source's original. A retry with the same key replays. */
  async ingestText(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<SourceView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
    const scope = admitted.scope;
    const grantId = `upl_${randomUUID()}`;
    const attemptId = `att_${randomUUID()}`;
    let parsed: { wanted: Wanted; content: Buffer } | undefined;
    // A one-shot grant and a verified attempt record the intent before any
    // bytes are written; the staging key is never used for text.
    const replayed = await this.actorTx(actor, admitted, async db => {
      parsed = textRequest(request, scope);
      const { wanted, content } = parsed;
      const existing = await replay(db, scope, wanted);
      if (existing) return existing;
      await writable(db, scope);
      await capturedNotFuture(db, wanted.capturedAt);
      await insertGrant(db, scope, grantId, wanted.mimeType!, content.byteLength, wanted.sha256, sourceBounds.textGrantSeconds);
      await db.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key,state,
          observed_sha256,observed_bytes,observed_mime_type) VALUES($1,$2,$3,$4,$5,'verified',$6,$7,$8)`,
      [...grantKey(scope, grantId), attemptId, stagingKey(spaceId, grantId, attemptId), wanted.sha256, content.byteLength,
        wanted.mimeType]);
      return null;
    });
    if (replayed) return replayed;
    const { wanted, content } = parsed!;
    try { return await this.complete(actor, admitted, grantId, () => ({ attemptId, wanted }), content); }
    catch (error) {
      if (!isDuplicateSource(error)) throw error;
      // A concurrent request with the same key committed first.
      return this.actorTx(actor, admitted, async db => (await replay(db, scope, wanted)) ?? Promise.reject(error));
    }
  }

  /** Record a source whose bytes were not fetched. The locator is never fetched. */
  async ingestReference(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<SourceView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
    const scope = admitted.scope;
    return this.actorTx(actor, admitted, async db => {
      const input = fields(request, ['idempotencyKey', 'locator', 'mimeType', 'capturedAt'], ['idempotencyKey', 'locator']);
      const wanted: Wanted = { sourceId: derivedSourceId(['reference', scope.credentialId, idempotencyKey(input.idempotencyKey)]),
        locator: optionalLocator(input.locator), capturedAt: optionalInstant(input.capturedAt), referenceOnly: true,
        sha256: null, mimeType: input.mimeType === undefined ? null : mimeEssence(input.mimeType) };
      const existing = await replay(db, scope, wanted);
      if (existing) return existing;
      await writable(db, scope);
      return insertSource(db, scope, wanted, null, null);
    });
  }

  /** Issue a short-lived grant to stream one original of a declared type and bound. */
  async createUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<UploadGrantView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
    const scope = admitted.scope;
    return this.actorTx(actor, admitted, async db => {
      const input = fields(request, ['mimeType', 'maxBytes', 'sha256', 'expiresInSeconds'], ['mimeType', 'maxBytes']);
      const mimeType = mimeEssence(input.mimeType);
      const maxBytes = input.maxBytes;
      if (!isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > sourceBounds.uploadBytes)
        invalid('maxBytes is outside the upload bound');
      // A supplied field is never undefined, so only an absent lifetime takes the default; a supplied null is refused.
      const seconds = input.expiresInSeconds === undefined ? sourceBounds.grantSeconds : input.expiresInSeconds;
      if (!isSafeInteger(seconds) || (seconds as number) < 1 || (seconds as number) > sourceBounds.maxGrantSeconds)
        invalid('expiresInSeconds is outside the grant lifetime bound');
      const sha256 = optionalDigest(input.sha256);
      await writable(db, scope);
      return grantView(await insertGrant(db, scope, `upl_${randomUUID()}`, mimeType, maxBytes as number, sha256, seconds as number));
    });
  }

  /**
   * Stream one upload attempt into staging. The declared size, MIME type and
   * any digest must fit the grant; the body is hashed and counted as it
   * streams, text must be UTF-8, and the write stops at the grant's expiry.
   * A refused or interrupted body leaves a failed attempt and no bytes. A
   * grant takes a new attempt only once every earlier one has failed.
   */
  async upload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string,
    body: ReadableStream<Uint8Array>, declared: unknown): Promise<UploadAttemptView> {
    let consumed = false;
    try {
      const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
      const scope = admitted.scope;
      const attemptId = `att_${randomUUID()}`;
      const key: Key = [spaceId, collectionId, grantId, attemptId];
      const staging = stagingKey(spaceId, grantId, attemptId);
      const grant = await this.actorTx(actor, admitted, async db => {
        if (!reference(grantId)) throw new AuthorityError('NOT_FOUND');
        if (!stream(body)) invalid();
        const input = fields(declared, ['bytes', 'mimeType', 'sha256'], ['bytes', 'mimeType']);
        if (!isSafeInteger(input.bytes) || (input.bytes as number) < 0) invalid('Upload size must be declared');
        const bytes = input.bytes as number;
        const mimeType = mimeEssence(input.mimeType);
        const claimed = optionalDigest(input.sha256);
        const row = await lockGrant(db, scope, grantId);
        usable(row);
        if (row.mime_type !== mimeType) invalid('Upload MIME type differs from its grant');
        if (bytes > Number(row.max_bytes)) invalid('Upload size exceeds its grant');
        if (claimed && row.expected_sha256 && claimed !== row.expected_sha256) invalid('Upload digest differs from its grant');
        // The grant row lock serializes attempts, so a grant stages at most one live attempt's bytes.
        const live = await db.query(`SELECT 1 FROM source_upload_attempts WHERE space_id=$1 AND collection_id=$2
          AND grant_id=$3 AND state IN ('receiving','verified') LIMIT 1`, grantKey(scope, grantId));
        if (live.rows.length) throw new AuthorityError('FORBIDDEN', 'Upload grant already has an attempt in progress or verified');
        await writable(db, scope);
        await db.query(`INSERT INTO source_upload_attempts(space_id,collection_id,grant_id,attempt_id,staging_key)
          VALUES($1,$2,$3,$4,$5)`, [...key, staging]);
        return { bytes, mimeType, sha256: claimed ?? (row.expected_sha256 as string | null) ?? undefined,
          deadline: Number(row.deadline) };
      });
      consumed = true;
      const { bytes, mimeType } = grant;
      const expiry = writeWindow(grant.deadline);
      let stored: { sha256: string; bytes: number };
      try {
        if (expiry.signal.aborted) {
          await body.cancel().catch(() => {});
          throw new BlobWriteError('deadline');
        }
        stored = await admitted.cell.originals.put(staging, startsWith(mimeType, 'text/') ? utf8Checked(body) : body,
          { bytes, sha256: grant.sha256, contentType: mimeType, signal: expiry.signal });
      } catch (error) {
        // A write refused at its deadline may still have landed, so the staging key is always deleted.
        const code = error instanceof BlobWriteError ? failureCodes[error.reason] : 'store_failed';
        await abandon(admitted.cell, key, code).catch(() => {});
        throw uploadFailure(error);
      } finally { expiry.close(); }
      // Verification needs the caller's authority to be current after the stream.
      let refused: string | null;
      try {
        refused = await this.actorTx(actor, admitted, async db => {
          const row = (await db.query(`SELECT revoked_at,finalized_at,expires_at<=clock_timestamp() AS expired
            FROM source_upload_grants WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 FOR UPDATE`, key.slice(0, 3))).rows[0];
          const attempt = await lockAttempt(db, key);
          let problem: string | null = null;
          if (row?.revoked_at) problem = 'grant_revoked';
          else if (row?.finalized_at) problem = 'grant_finalized';
          else if (!row || row.expired) problem = 'grant_expired';
          else if (attempt?.state !== 'receiving') problem = 'superseded';
          if (problem) {
            if (attempt?.state === 'receiving') await failAttempt(db, key, problem);
            return problem;
          }
          // Expiry is checked again by the transition itself, after the lock waits above.
          const verifiedNow = await db.query(`UPDATE source_upload_attempts a SET state='verified',observed_sha256=$5,
              observed_bytes=$6,observed_mime_type=$7,updated_at=clock_timestamp()
            WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 AND EXISTS (SELECT 1
              FROM source_upload_grants g WHERE g.space_id=a.space_id AND g.collection_id=a.collection_id
                AND g.grant_id=a.grant_id AND g.expires_at>clock_timestamp())`, [...key, stored.sha256, stored.bytes, mimeType]);
          if (verifiedNow.rowCount === 1) return null;
          await failAttempt(db, key, 'grant_expired');
          return 'grant_expired';
        });
      } catch (error) {
        // The body is consumed, so no later call can verify this attempt, and the caller
        // never learned its ID: whatever failed, it is released so the grant takes a new one.
        const transient = !settlesNow(error);
        try { await abandon(admitted.cell, key, transient ? 'verify_failed' : refusalCode(error)); }
        catch {
          if (transient) throw new AuthorityError('PROVIDER_UNAVAILABLE',
            'Upload verification failed and its attempt could not be released; request a new upload grant', undefined, false);
        }
        if (error instanceof CommitOutcomeUnknownError)
          throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Upload verification was not confirmed; its attempt was released, retry the upload',
            undefined, true);
        throw error;
      }
      if (refused) {
        await removeStaging(admitted.cell, key, staging).catch(() => {});
        throw new AuthorityError('FORBIDDEN', refused === 'grant_expired' ? 'Upload grant expired' :
          refused === 'grant_revoked' ? 'Upload grant revoked' : 'Upload grant no longer accepts this attempt');
      }
      return { grantId, attemptId, sha256: stored.sha256, bytes: stored.bytes, mimeType };
    } finally {
      if (!consumed && stream(body)) await body.cancel().catch(() => {});
    }
  }

  /** Commit a verified attempt as the grant's one source. Repeating the same finalize replays it. */
  async finalizeUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string,
    request: unknown): Promise<SourceView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
    return this.complete(actor, admitted, grantId, () => {
      const input = fields(request, ['attemptId', 'locator', 'capturedAt'], ['attemptId']);
      if (!reference(input.attemptId)) throw new AuthorityError('NOT_FOUND');
      return { attemptId: input.attemptId, wanted: { sourceId: derivedSourceId(['upload', grantId]),
        locator: optionalLocator(input.locator), capturedAt: optionalInstant(input.capturedAt), referenceOnly: false,
        sha256: null, mimeType: null } };
    }, null);
  }

  /**
   * Revoke an unfinalized grant. Its in-progress and verified attempts fail
   * at once; after that commits, the verified ones' originals and staging
   * bytes are removed; a still-streaming writer removes its own.
   * Reconciliation records the verified ones as settled after the grant ends.
   */
  async revokeUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string): Promise<UploadGrantView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:write');
    const scope = admitted.scope;
    const { view, staged } = await this.actorTx(actor, admitted, async db => {
      if (!reference(grantId)) throw new AuthorityError('NOT_FOUND');
      const grant = await lockGrant(db, scope, grantId, admitted.ownerPrincipalId);
      if (grant.finalized_at) invalid('A finalized upload grant cannot be revoked');
      const attempts = grant.revoked_at ? [] : (await db.query(`SELECT attempt_id,state,staging_key,observed_sha256
        FROM source_upload_attempts WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3
          AND state IN ('receiving','verified') ORDER BY attempt_id FOR UPDATE`, grantKey(scope, grantId))).rows;
      const row = grant.revoked_at ? grant : (await db.query(`UPDATE source_upload_grants SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 RETURNING *`, grantKey(scope, grantId))).rows[0];
      for (const attempt of attempts) await failAttempt(db, [spaceId, collectionId, grantId, attempt.attempt_id], 'grant_revoked');
      return { view: grantView(row), staged: attempts.filter(a => a.state === 'verified') };
    });
    // The failed attempts are durable now; reconciliation repeats whatever this misses.
    for (const attempt of staged) {
      const key: Key = [spaceId, collectionId, grantId, attempt.attempt_id];
      await removeOriginal(admitted.cell, key).catch(() => {});
      await removeStaging(admitted.cell, key, attempt.staging_key).catch(() => {});
    }
    return view;
  }

  /**
   * Promote a verified attempt's bytes to its original key, then commit the
   * source metadata. Bytes are always verified and present before the
   * metadata commits, which finalizes the grant only if it has not expired;
   * no store call runs while it holds locks. A refusal by the first
   * transaction leaves the attempt verified until reconciliation; a later
   * deterministic failure abandons it at once; a transient one leaves it
   * verified for retry until reconciliation. The request is parsed only after the first
   * transaction authorizes it.
   */
  private async complete(actor: VerifiedCredential, admitted: Admitted, grantId: string,
    prepare: () => { attemptId: string; wanted: Wanted }, content: Uint8Array | null): Promise<SourceView> {
    const scope = admitted.scope;
    let prepared: { key: Key; wanted: Wanted } | undefined;
    const request = () => {
      if (prepared) return prepared;
      if (!reference(grantId)) throw new AuthorityError('NOT_FOUND');
      const { attemptId, wanted } = prepare();
      prepared = { key: [scope.spaceId, scope.collectionId, grantId, attemptId], wanted };
      return prepared;
    };
    const check = async (db: Db): Promise<{ replay: SourceView } |
      { attempt: Record<string, unknown>; mimeType: string; deadline: number }> => {
      const { key, wanted } = request();
      const grant = await lockGrant(db, scope, grantId);
      if (grant.finalized_at) {
        const committed = (await db.query(`SELECT 1 FROM source_upload_attempts WHERE space_id=$1 AND collection_id=$2
          AND grant_id=$3 AND attempt_id=$4 AND state='committed'`, key)).rows.length === 1;
        const source = committed && grant.source_id === wanted.sourceId ? await readSource(db, scope, wanted.sourceId, true) : null;
        const capture = source && (await db.query(`SELECT CASE WHEN $4::timestamptz IS NULL THEN captured_at=observed_at
            ELSE captured_at=$4::timestamptz END AS same
          FROM original_objects WHERE space_id=$1 AND collection_id=$2 AND source_id=$3`,
        [scope.spaceId, scope.collectionId, wanted.sourceId, wanted.capturedAt])).rows[0]?.same === true;
        if (!source || source.locator !== wanted.locator || !capture) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
        return { replay: source };
      }
      usable(grant);
      const attempt = await lockAttempt(db, key);
      if (!attempt) throw new AuthorityError('NOT_FOUND');
      if (attempt.state !== 'verified') invalid('Upload attempt is not verified');
      await writable(db, scope);
      await capturedNotFuture(db, wanted.capturedAt);
      return { attempt, mimeType: String(grant.mime_type), deadline: Number(grant.deadline) };
    };
    const first = await this.actorTx(actor, admitted, check);
    if ('replay' in first) return first.replay;
    const { key, wanted } = request();
    const sha256 = String(first.attempt.observed_sha256);
    const bytes = Number(first.attempt.observed_bytes);
    const staging = String(first.attempt.staging_key);
    const objectKey = attemptOriginal(key);
    const expiry = writeWindow(first.deadline);
    try {
      try {
        await ensureOriginal(admitted.cell.originals, objectKey, sha256, bytes, first.mimeType, content ?? staging, expiry.signal);
        // Checked before the metadata transaction, so no lock waits on the store. Only a
        // removal deletes this key, and only after the attempt's failure commits, which is
        // final: the commit below finds the attempt verified only if no removal ever started.
        const present = await beforeAbort(admitted.cell.originals.head(objectKey), expiry.signal);
        if (present?.bytes !== bytes || present.sha256 !== sha256)
          throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes are not present; retry the request', undefined, true);
      } finally { expiry.close(); }
      const committed = await this.actorTx(actor, admitted, async db => {
        const current = await check(db);
        if ('replay' in current) return current;
        if (await sourceExists(db, scope.spaceId, wanted.sourceId)) throw duplicateSource();
        const source = await insertSource(db, scope, { ...wanted, sha256, mimeType: current.mimeType }, bytes, objectKey);
        await db.query(`UPDATE source_upload_attempts SET state='committed',updated_at=clock_timestamp()${content ?
          ',staging_removed_at=clock_timestamp()' : ''}
          WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4`, key);
        // Expiry is checked again by the transition itself, after the lock waits above.
        const finalized = await db.query(`UPDATE source_upload_grants SET finalized_at=clock_timestamp(),source_id=$4
          WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND expires_at>clock_timestamp()`,
        [...key.slice(0, 3), wanted.sourceId]);
        if (finalized.rowCount !== 1) throw new AuthorityError('FORBIDDEN', 'Upload grant expired');
        return { source };
      });
      if ('replay' in committed) {
        // A concurrent finalize of this attempt committed first.
        return committed.replay;
      }
      if (!content) await removeStaging(admitted.cell, key, staging).catch(() => {});
      return committed.source;
    } catch (error) {
      // After any failure that leaves the attempt failed, remove its original:
      // a revocation may have removed it while this promotion was still writing it.
      await abandon(admitted.cell, key, settlesNow(error) ? 'commit_failed' : null, content !== null).catch(() => {});
      throw promotionFailure(error);
    }
  }
}

/** Validate a text ingestion after its transaction has authorized the caller. */
function textRequest(request: unknown, scope: AuthorityScope): { wanted: Wanted; content: Buffer } {
  const input = fields(request, ['idempotencyKey', 'text', 'mimeType', 'locator', 'capturedAt'], ['idempotencyKey', 'text']);
  const key = idempotencyKey(input.idempotencyKey);
  if (typeof input.text !== 'string') invalid('Text must be well-formed Unicode');
  // UTF-8 needs at least one byte per UTF-16 code unit, so a longer string is refused before it is encoded.
  if (input.text.length > sourceBounds.textBytes) invalid('Text size is outside the ingestion bound');
  if (!scalarString(input.text, true)) invalid('Text must be well-formed Unicode');
  const content = Buffer.from(input.text, 'utf8');
  if (content.byteLength < 1 || content.byteLength > sourceBounds.textBytes) invalid('Text size is outside the ingestion bound');
  const mimeType = input.mimeType === undefined ? 'text/plain' : mimeEssence(input.mimeType);
  if (!startsWith(mimeType, 'text/')) invalid('Text ingestion requires a text/* MIME type');
  return { content, wanted: { sourceId: derivedSourceId(['text', scope.credentialId, key]), locator: optionalLocator(input.locator),
    capturedAt: optionalInstant(input.capturedAt), referenceOnly: false, sha256: digest(content), mimeType } };
}

// sources.js loads inside index.js's export list, so it cannot subclass at module load.
const duplicate = Symbol('duplicate source');
const duplicateSource = () => Object.assign(new AuthorityError('IDEMPOTENCY_MISMATCH',
  'A source with this identity already exists', undefined, false), { [duplicate]: true });
const isDuplicateSource = (error: unknown) => (error as { [duplicate]?: unknown } | null)?.[duplicate] === true;
const expired = Symbol('grant expired at commit');
const grantExpired = () => Object.assign(new AuthorityError('FORBIDDEN', 'Upload grant expired'), { [expired]: true });
const isGrantExpired = (error: unknown) => (error as { [expired]?: unknown } | null)?.[expired] === true;
/** Serialize on the source identity, which a retry in another collection would share. */
async function sourceExists(db: Db, spaceId: string, sourceId: string): Promise<boolean> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(['stateplane:source', spaceId, sourceId])]);
  return (await db.query('SELECT 1 FROM sources WHERE space_id=$1 AND source_id=$2', [spaceId, sourceId])).rows.length > 0;
}

/** Each provider call during cleanup gets at most this long, so one stalled call cannot hold a page. */
const CLEANUP_CALL_MS = 2_000;
const SWEEP_CURSOR = 'reconcile/sweep-cursor';
/**
 * Settle with `pending`, or fail once `CLEANUP_CALL_MS` or the budget ending at
 * `until` (a `performance.now` instant) has passed. A call that settles later
 * is ignored: every cleanup call is safe to land late.
 */
function within<T>(until: number, pending: Promise<T>): Promise<T> {
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Upload cleanup call timed out')),
      Math.max(0, Math.min(until - performance.now(), CLEANUP_CALL_MS)));
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
/** The attempt a stored key belongs to: its space and staging key, and whether it is the original. */
function storedAttempt(key: string): { spaceId: string; stagingKey: string; original: boolean } | null {
  const parts = key.split('/');
  if (parts.length !== 4 || (parts[0] !== 'staging' && parts[0] !== 'originals') || !parts[2] || !parts[3]) return null;
  const spaceId = Buffer.from(parts[1], 'base64url').toString('utf8');
  if (!spaceId || spaceSegment(spaceId) !== parts[1]) return null;
  return { spaceId, stagingKey: stagingKey(spaceId, parts[2], parts[3]), original: parts[0] === 'originals' };
}

/**
 * Settles upload attempts whose grant ended more than the grace period ago:
 * an interrupted or abandoned attempt fails, a failed attempt's original is
 * removed, and every remaining staging blob is removed
 * and recorded. Each attempt settles in its own transaction, and one failure
 * does not stop the rest. A failing attempt's `updated_at` is advanced, so it
 * moves behind every due attempt not tried since and cannot hold the oldest page.
 * `sweep` then finds bytes that landed after their attempt was settled.
 */
export class SourceUploadReconciler {
  constructor(private readonly cell: SourceCell, private readonly graceSeconds = sourceBounds.reconcileGraceSeconds) {
    if (!isSafeInteger(graceSeconds) || graceSeconds < 0) throw new RangeError('Invalid reconciliation grace');
  }

  /**
   * Settle up to `limit` due attempts within `budgetMs`; returns how many were
   * due, so a page cut short by the budget still reads as unfinished. No
   * attempt starts after the budget, and each store call is bounded; a call
   * that times out leaves its attempt due and is safe to land later.
   */
  async step(limit = 25, budgetMs = 10_000): Promise<number> {
    if (!isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Invalid reconciliation limit');
    if (!isSafeInteger(budgetMs) || budgetMs < 1) throw new RangeError('Invalid reconciliation budget');
    const until = performance.now() + budgetMs;
    const due = await transact(this.cell.pool, db => db.query(`SELECT a.space_id,a.collection_id,a.grant_id,a.attempt_id
      FROM source_upload_attempts a JOIN source_upload_grants g USING (space_id,collection_id,grant_id)
      WHERE a.staging_removed_at IS NULL AND g.expires_at < clock_timestamp()-make_interval(secs=>$2)
      ORDER BY a.updated_at LIMIT $1`, [limit, this.graceSeconds]));
    const errors: unknown[] = [];
    let failed = 0;
    for (const row of due.rows) {
      if (performance.now() >= until) break;
      const key: Key = [row.space_id, row.collection_id, row.grant_id, row.attempt_id];
      try {
        const attempt = await transact(this.cell.pool, async db => {
          const row = (await db.query(`SELECT state,staging_key,observed_sha256 FROM source_upload_attempts
            WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 AND staging_removed_at IS NULL
            FOR UPDATE SKIP LOCKED`, key)).rows[0];
          if (row && (row.state === 'receiving' || row.state === 'verified')) await failAttempt(db, key, 'abandoned');
          return row;
        });
        if (!attempt) continue;
        // No write starts after the grant's expiry, and one refused at it
        // reports failure promptly, so a copy can still land after this
        // removal; `sweep` finds it once the attempt has settled.
        if (attempt.state !== 'committed' && attempt.observed_sha256) await within(until, removeOriginal(this.cell, key));
        await removeStaging(this.cell, key, String(attempt.staging_key), true, pending => within(until, pending));
      } catch (error) {
        failed++;
        errors.push(error);
        await transact(this.cell.pool, db => db.query(`UPDATE source_upload_attempts SET updated_at=clock_timestamp()
          WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 AND staging_removed_at IS NULL`, key))
          .catch((deferral: unknown) => { errors.push(deferral); });
      }
    }
    if (errors.length) throw new AggregateError(errors, `${failed} upload attempts did not settle`);
    return due.rows.length;
  }

  /**
   * Delete stored bytes no attempt needs any more, found by listing the bucket
   * rather than by the ledger, so a write R2 confirmed after its attempt
   * settled is found on a later pass however late it landed. A failed
   * attempt's staging and original and a committed attempt's staging are
   * deleted; a committed original, a live attempt's bytes and keys the ledger
   * does not know are kept. Both states are final, so a delete that lands
   * late is safe. Each call examines up to `limit` keys after a cursor kept in
   * the bucket, within `budgetMs`; a lost cursor restarts the pass. Returns
   * how many keys it examined.
   */
  async sweep(limit = 100, budgetMs = 5_000): Promise<number> {
    if (!isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid sweep limit');
    if (!isSafeInteger(budgetMs) || budgetMs < 1) throw new RangeError('Invalid sweep budget');
    const until = performance.now() + budgetMs;
    const blobs = this.cell.originals;
    const stored = await within(until, blobs.get(SWEEP_CURSOR));
    const cursor = stored ? await within(until, new Response(stored.body).text()) : '';
    const page = await within(until, blobs.list(cursor, limit));
    const owners = page.keys.map(storedAttempt);
    const known = owners.flatMap((owner, index) => owner ? [{ ...owner, index }] : []);
    const ended = new Set((await transact(this.cell.pool, db => db.query(`SELECT k.index FROM
      unnest($1::text[],$2::text[],$3::boolean[],$4::int[]) AS k(space_id,staging_key,original,index)
      JOIN source_upload_attempts a ON a.space_id=k.space_id AND a.staging_key=k.staging_key
      WHERE a.state='failed' OR (a.state='committed' AND NOT k.original)`,
    [known.map(k => k.spaceId), known.map(k => k.stagingKey), known.map(k => k.original), known.map(k => k.index)])))
      .rows.map(row => Number(row.index)));
    const errors: unknown[] = [];
    let examined = 0;
    for (const [index, key] of page.keys.entries()) {
      if (performance.now() >= until) break;
      if (ended.has(index)) await within(until, blobs.delete(key)).catch((error: unknown) => { errors.push(error); });
      examined++;
    }
    // A finished pass starts over; a failed delete is retried on the next pass.
    const next = page.done && examined === page.keys.length ? '' : page.keys[examined - 1] ?? cursor;
    if (next !== cursor) {
      const bytes = Buffer.from(next, 'utf8');
      await within(until, blobs.put(SWEEP_CURSOR, bytes, { bytes: bytes.byteLength, contentType: 'text/plain' }))
        .catch((error: unknown) => { errors.push(error); });
    }
    if (errors.length) throw new AggregateError(errors, 'Stored upload bytes sweep did not finish');
    return examined;
  }
}

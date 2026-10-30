import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { BlobWriteError, classifyError } from '@stateplane/application';
import type { BlobStore } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { commitBeforeDeadline, CommitNotSentDeadlineExceeded } from './commit-deadline.js';
import { AuthorityError, AuthorityTransaction, CommitOutcomeUnknownError } from './index.js';
import type { AuthorityScope } from './index.js';
import { acceptsInProcessObjects, isInProcessProxy, utcInstant } from './schema.js';
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
type Db = pg.PoolClient;
type Key = [spaceId: string, collectionId: string, grantId: string, attemptId: string];
interface Admitted { cell: SourceCell; ownerPrincipalId: string; scope: AuthorityScope; capability: Capability }
interface Wanted {
  sourceId: string; locator: string | null; capturedAt: string | null;
  referenceOnly: boolean; sha256: string | null; mimeType: string | null;
}

const spaceSegment = (spaceId: string) => Buffer.from(spaceId, 'utf8').toString('base64url');
/** Originals are content-addressed within a space: (space, digest) is the pointer. */
export const originalKey = (spaceId: string, sha256: string) => `originals/${spaceSegment(spaceId)}/${sha256}`;
const stagingKey = (spaceId: string, grantId: string, attemptId: string) =>
  `staging/${spaceSegment(spaceId)}/${grantId}/${attemptId}`;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const derivedSourceId = (parts: readonly string[]) => `src_${digest(JSON.stringify(parts))}`;
const lockKey = (parts: readonly string[]) => JSON.stringify(parts);
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
const pgCode = (error: unknown) => (error as { code?: unknown })?.code;

function invalid(message?: string): never { throw new AuthorityError('INVALID_ARGUMENT', message); }
/** True for an object the runtime cannot inspect without running caller code: any proxy, or every object without a detector. */
const untrusted = (value: object) => !acceptsInProcessObjects || isInProcessProxy(value);
/** Snapshot a plain request's own data fields; a proxy is refused before any reflective read can run its traps. */
function fields(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || untrusted(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => !allowed.includes(key)))
    invalid();
  const copy: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) invalid();
    if (descriptor && descriptor.value !== undefined) copy[key] = descriptor.value;
    // A required field present as `undefined` is as absent as a missing one.
    else if (required.includes(key)) invalid();
  }
  return copy;
}
/** Well-formed UTF-8 text without NUL, within a byte bound. */
function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value) <= maxBytes && Buffer.from(value, 'utf8').toString('utf8') === value;
}
const reference = (value: unknown): value is string => boundedText(value, 256);
/** The lowercase type/subtype essence of a media type; parameters are dropped. */
function mimeEssence(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) invalid('Invalid MIME type');
  const essence = value.split(';', 1)[0].trim().toLowerCase();
  if (!mimePattern.test(essence)) invalid('Invalid MIME type');
  return essence;
}
function optionalDigest(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !sha256Pattern.test(value)) invalid('Invalid SHA-256 digest');
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
 */
async function transact<T>(pool: Pick<pg.Pool, 'connect'>, fn: (db: Db) => Promise<T>): Promise<T> {
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const client = await pool.connect();
  let begun = false;
  let discard = false;
  const onError = () => { discard = true; };
  client.on?.('error', onError);
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_MS}ms'`);
    const result = await fn(client);
    begun = false;
    try { await commitBeforeDeadline(client, deadline); }
    catch (error) {
      discard = true;
      if (error instanceof CommitNotSentDeadlineExceeded) throw new AuthorityError('RATE_LIMITED', 'Request time budget exceeded');
      if (error instanceof pg.DatabaseError && /^(?:23|40)/.test(error.code ?? '')) throw error;
      throw new CommitOutcomeUnknownError(error);
    }
    return result;
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    if (pgCode(error) === '57014') throw new AuthorityError('RATE_LIMITED', 'Database statement time limit exceeded');
    if (pgCode(error) === '55P03') throw new AuthorityError('BACKPRESSURE', 'Database lock budget exceeded');
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
 * Original blobs are shared by digest within a space. A verified upload
 * attempt is the durable intent to commit one, and takes the shared lock when
 * it records that intent; removal takes the exclusive lock and deletes only a
 * digest no original row and no verified attempt references. Promotion
 * happens after the intent commits, so a removal can never interleave with a
 * commit that relies on bytes it saw. A deleted object cannot be restored by
 * a rollback, so removal runs in its own transaction, only after the end of
 * the intent it follows has committed; the metadata commit also rechecks the
 * object under the shared lock.
 *
 * A revocation can fail an attempt while its promotion is still writing, so
 * the write may land after the removal. Promotion therefore stops at its
 * grant's expiry, the finalize that promoted rechecks its digest whenever it
 * fails, and a failed attempt that held a digest stays due for
 * reconciliation, which rechecks it again once no promotion can be running.
 */
const intentLock = (db: Db, spaceId: string, sha256: string) =>
  db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [lockKey(['stateplane:original', spaceId, sha256])]);
/** Remove a digest's original when nothing references it. Call only after the caller's end of intent committed. */
function removeUnreferencedOriginal(cell: SourceCell, spaceId: string, sha256: string): Promise<void> {
  return transact(cell.pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(['stateplane:original', spaceId, sha256])]);
    // Verified attempts keep their staging blob, so the staged partial index finds them.
    const row = (await db.query(`SELECT EXISTS (SELECT 1 FROM original_objects WHERE space_id=$1 AND sha256=$2)
        OR EXISTS (SELECT 1 FROM source_upload_attempts WHERE staging_removed_at IS NULL AND space_id=$1
          AND observed_sha256=$2 AND state='verified') AS referenced`, [spaceId, sha256])).rows[0];
    if (row?.referenced === false) await cell.originals.delete(originalKey(spaceId, sha256));
  });
}
/** Make the original for a digest present, copying verified bytes when absent, before `signal` aborts. */
async function ensureOriginal(blobs: BlobStore, spaceId: string, sha256: string, bytes: number,
  mimeType: string, from: string | Uint8Array, signal: AbortSignal): Promise<void> {
  const key = originalKey(spaceId, sha256);
  const existing = await blobs.head(key);
  if (existing && existing.bytes === bytes && existing.sha256 === sha256) return;
  const staged = typeof from === 'string' ? (await blobs.get(from))?.body : from;
  if (!staged) throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Staged upload bytes are missing', undefined, false);
  if (signal.aborted) {
    if (!(staged instanceof Uint8Array)) await staged.cancel().catch(() => {});
    throw new BlobWriteError('deadline');
  }
  // The store rechecks length and digest, so corrupted staging stores nothing.
  await blobs.put(key, staged, { bytes, sha256, contentType: mimeType, signal });
}
/** A deterministic or refused failure ends the attempt now; a transient one leaves it for retry. */
function settlesNow(error: unknown): boolean {
  if (error instanceof CommitOutcomeUnknownError) return false;
  if (error instanceof BlobWriteError || pgCode(error) === '23505') return true;
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
/** Promotion copies already verified bytes, so only expiry is the caller's failure. */
function promotionFailure(error: unknown): unknown {
  if (!(error instanceof BlobWriteError)) return error;
  if (error.reason === 'deadline') return new AuthorityError('FORBIDDEN', 'Upload grant expired');
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
  o.byte_size,o.mime_type,o.captured_at,o.observed_at,e.tombstone`;
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
async function readSource(db: Db, scope: AuthorityScope, sourceId: string, replayed: boolean): Promise<SourceView> {
  const row = (await db.query(`SELECT ${viewColumns} ${viewSources} WHERE s.space_id=$1 AND s.collection_id=$2 AND s.source_id=$3`,
    [scope.spaceId, scope.collectionId, sourceId])).rows[0];
  if (!row || row.tombstone) throw new AuthorityError('NOT_FOUND');
  return sourceView(row, replayed);
}
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
async function insertSource(db: Db, scope: AuthorityScope, wanted: Wanted, byteSize: number | null): Promise<SourceView> {
  await capturedNotFuture(db, wanted.capturedAt);
  const ids = [scope.spaceId, scope.collectionId, wanted.sourceId];
  await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'source',$3)`, ids);
  await db.query(`INSERT INTO sources(space_id,collection_id,source_id,locator,principal_id,credential_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [...ids, wanted.locator, scope.principalId, scope.credentialId]);
  // One clock reading marks an unstated capture time as the observation time.
  await db.query(`WITH stamp AS (SELECT clock_timestamp() AS at)
    INSERT INTO original_objects(space_id,collection_id,source_id,reference_only,sha256,byte_size,mime_type,captured_at,observed_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,stamp.at),stamp.at FROM stamp`,
  [...ids, wanted.referenceOnly, wanted.sha256, byteSize, wanted.mimeType, wanted.capturedAt]);
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
async function removeStaging(cell: SourceCell, key: Key, staging: string, settled = false): Promise<void> {
  await cell.originals.delete(staging);
  await transact(cell.pool, db => db.query(`UPDATE source_upload_attempts
    SET staging_removed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4 AND staging_removed_at IS NULL
      AND (state='committed' OR (state='failed' AND (observed_sha256 IS NULL OR $5::boolean)))`, [...key, settled]));
}
/**
 * Cleanup for an attempt that cannot commit now. With a code, a receiving or
 * verified attempt fails, and a one-shot text grant is revoked with it. Once
 * the attempt is durably failed, the original for its digest is removed when
 * nothing references it, which also catches a promotion that landed after a
 * revocation removed it, and its staging blob is removed.
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
    return { sha256: attempt.observed_sha256 ? String(attempt.observed_sha256) : null,
      staging: attempt.staging_removed_at ? null : String(attempt.staging_key) };
  });
  if (ended?.sha256) await removeUnreferencedOriginal(cell, key[0], ended.sha256);
  if (ended?.staging) await removeStaging(cell, key, ended.staging);
}
/** The attempt failure code for a caller whose authority ended mid-request. */
const refusalCode = (error: unknown) => error instanceof AuthorityError ? `refused_${error.code.toLowerCase()}` : 'commit_failed';

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
    Promise<{ admitted: Admitted; source: SourceView }> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'sources:read');
    return { admitted, source: await this.actorTx(actor, admitted, db => {
      if (!reference(sourceId)) throw new AuthorityError('NOT_FOUND');
      return readSource(db, admitted.scope, sourceId, false);
    }) };
  }

  /** Stream a source's original bytes, verified against the recorded digest; null body when reference-only. */
  async content(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string):
    Promise<{ source: SourceView; body: ReadableStream<Uint8Array> | null }> {
    const { admitted, source } = await this.read(actor, spaceId, collectionId, sourceId);
    const { referenceOnly, sha256, byteSize } = source.original;
    if (referenceOnly || sha256 === null || byteSize === null) return { source, body: null };
    const stored = await admitted.cell.originals.get(originalKey(spaceId, sha256));
    if (!stored) throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes are missing', undefined, false);
    if (stored.bytes !== byteSize || (stored.sha256 !== null && stored.sha256 !== sha256)) {
      await stored.body.cancel().catch(() => {});
      throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes failed verification', undefined, false);
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
      await intentLock(db, scope.spaceId, wanted.sha256!);
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
      return insertSource(db, scope, wanted, null);
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
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > sourceBounds.uploadBytes)
        invalid('maxBytes is outside the upload bound');
      const seconds = input.expiresInSeconds ?? sourceBounds.grantSeconds;
      if (!Number.isSafeInteger(seconds) || (seconds as number) < 1 || (seconds as number) > sourceBounds.maxGrantSeconds)
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
   * A refused or interrupted body leaves a failed attempt and no bytes.
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
        if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 0) invalid('Upload size must be declared');
        const bytes = input.bytes as number;
        const mimeType = mimeEssence(input.mimeType);
        const claimed = optionalDigest(input.sha256);
        const row = await lockGrant(db, scope, grantId);
        usable(row);
        if (row.mime_type !== mimeType) invalid('Upload MIME type differs from its grant');
        if (bytes > Number(row.max_bytes)) invalid('Upload size exceeds its grant');
        if (claimed && row.expected_sha256 && claimed !== row.expected_sha256) invalid('Upload digest differs from its grant');
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
        stored = await admitted.cell.originals.put(staging, mimeType.startsWith('text/') ? utf8Checked(body) : body,
          { bytes, sha256: grant.sha256, contentType: mimeType, signal: expiry.signal });
      } catch (error) {
        // A write refused at its deadline may still have landed, so the staging key is always deleted.
        const code = error instanceof BlobWriteError ? failureCodes[error.reason] : 'store_failed';
        await abandon(admitted.cell, key, code).catch(() => {});
        throw uploadFailure(error);
      } finally { expiry.close(); }
      // Verification is the commit intent for the digest, under its shared
      // lock, and needs the caller's authority to be current after the stream.
      let refused: string | null;
      try {
        refused = await this.actorTx(actor, admitted, async db => {
          const row = (await db.query(`SELECT revoked_at,finalized_at,expires_at<=clock_timestamp() AS expired
            FROM source_upload_grants WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 FOR UPDATE`, key.slice(0, 3))).rows[0];
          await intentLock(db, spaceId, stored.sha256);
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
          await db.query(`UPDATE source_upload_attempts SET state='verified',observed_sha256=$5,observed_bytes=$6,
              observed_mime_type=$7,updated_at=clock_timestamp()
            WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4`, [...key, stored.sha256, stored.bytes, mimeType]);
          return null;
        });
      } catch (error) {
        if (settlesNow(error)) await abandon(admitted.cell, key, refusalCode(error)).catch(() => {});
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
   * at once; after that commits, an original only they referenced is removed,
   * and verified staging bytes are removed; a still-streaming writer removes its own.
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
    for (const sha256 of [...new Set(staged.map(a => String(a.observed_sha256)))].sort())
      await removeUnreferencedOriginal(admitted.cell, spaceId, sha256).catch(() => {});
    for (const attempt of staged)
      await removeStaging(admitted.cell, [spaceId, collectionId, grantId, attempt.attempt_id], attempt.staging_key).catch(() => {});
    return view;
  }

  /**
   * Promote a verified attempt's bytes to the original location, then commit
   * the source metadata. Bytes are always verified and present before the
   * metadata commits, which rechecks them under the digest's shared lock. A deterministic failure abandons the attempt at once; a
   * transient one leaves it verified for retry until reconciliation. The
   * request is parsed only after the first transaction authorizes it.
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
    const expiry = writeWindow(first.deadline);
    try {
      try {
        await ensureOriginal(admitted.cell.originals, scope.spaceId, sha256, bytes, first.mimeType, content ?? staging, expiry.signal);
      } finally { expiry.close(); }
      const committed = await this.actorTx(actor, admitted, async db => {
        const current = await check(db);
        if ('replay' in current) return current;
        // No removal can run while the shared lock is held, so bytes present now stay.
        await intentLock(db, scope.spaceId, sha256);
        const present = await admitted.cell.originals.head(originalKey(scope.spaceId, sha256));
        if (present?.bytes !== bytes || present.sha256 !== sha256)
          throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Original bytes are not present; retry the request', undefined, true);
        if (await sourceExists(db, scope.spaceId, wanted.sourceId)) throw duplicateSource();
        const source = await insertSource(db, scope, { ...wanted, sha256, mimeType: current.mimeType }, bytes);
        await db.query(`UPDATE source_upload_attempts SET state='committed',updated_at=clock_timestamp()${content ?
          ',staging_removed_at=clock_timestamp()' : ''}
          WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3 AND attempt_id=$4`, key);
        await db.query(`UPDATE source_upload_grants SET finalized_at=clock_timestamp(),source_id=$4
          WHERE space_id=$1 AND collection_id=$2 AND grant_id=$3`, [...key.slice(0, 3), wanted.sourceId]);
        return { source };
      });
      if ('replay' in committed) {
        // A concurrent finalize of this attempt committed first.
        return committed.replay;
      }
      if (!content) await removeStaging(admitted.cell, key, staging).catch(() => {});
      return committed.source;
    } catch (error) {
      // Recheck the digest after any failure: a revocation may have removed
      // the original while this promotion was still writing it.
      await abandon(admitted.cell, key, settlesNow(error) ? 'commit_failed' : null, content !== null).catch(() => {});
      throw promotionFailure(error);
    }
  }
}

/** Validate a text ingestion after its transaction has authorized the caller. */
function textRequest(request: unknown, scope: AuthorityScope): { wanted: Wanted; content: Buffer } {
  const input = fields(request, ['idempotencyKey', 'text', 'mimeType', 'locator', 'capturedAt'], ['idempotencyKey', 'text']);
  const key = idempotencyKey(input.idempotencyKey);
  if (typeof input.text !== 'string' || Buffer.from(input.text, 'utf8').toString('utf8') !== input.text)
    invalid('Text must be well-formed Unicode');
  const content = Buffer.from(input.text, 'utf8');
  if (content.byteLength < 1 || content.byteLength > sourceBounds.textBytes) invalid('Text size is outside the ingestion bound');
  const mimeType = input.mimeType === undefined ? 'text/plain' : mimeEssence(input.mimeType);
  if (!mimeType.startsWith('text/')) invalid('Text ingestion requires a text/* MIME type');
  return { content, wanted: { sourceId: derivedSourceId(['text', scope.credentialId, key]), locator: optionalLocator(input.locator),
    capturedAt: optionalInstant(input.capturedAt), referenceOnly: false, sha256: digest(content), mimeType } };
}

// sources.js loads inside index.js's export list, so it cannot subclass at module load.
const duplicate = Symbol('duplicate source');
const duplicateSource = () => Object.assign(new AuthorityError('IDEMPOTENCY_MISMATCH',
  'A source with this identity already exists', undefined, false), { [duplicate]: true });
const isDuplicateSource = (error: unknown) => (error as { [duplicate]?: unknown } | null)?.[duplicate] === true;
/** Serialize on the source identity, which a retry in another collection would share. */
async function sourceExists(db: Db, spaceId: string, sourceId: string): Promise<boolean> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(['stateplane:source', spaceId, sourceId])]);
  return (await db.query('SELECT 1 FROM sources WHERE space_id=$1 AND source_id=$2', [spaceId, sourceId])).rows.length > 0;
}

/**
 * Settles upload attempts whose grant ended more than the grace period ago:
 * an interrupted or abandoned attempt fails, an original only a failed
 * attempt referenced is removed, and every remaining staging blob is removed
 * and recorded. Each attempt settles in its own transaction, and one failure
 * does not stop the rest. A failing attempt's `updated_at` is advanced, so it
 * moves behind every due attempt not tried since and cannot hold the oldest page.
 */
export class SourceUploadReconciler {
  constructor(private readonly cell: SourceCell, private readonly graceSeconds = sourceBounds.reconcileGraceSeconds) {
    if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) throw new RangeError('Invalid reconciliation grace');
  }

  /** Settle up to `limit` due attempts; returns how many were due. */
  async step(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Invalid reconciliation limit');
    const due = await transact(this.cell.pool, db => db.query(`SELECT a.space_id,a.collection_id,a.grant_id,a.attempt_id
      FROM source_upload_attempts a JOIN source_upload_grants g USING (space_id,collection_id,grant_id)
      WHERE a.staging_removed_at IS NULL AND g.expires_at < clock_timestamp()-make_interval(secs=>$2)
      ORDER BY a.updated_at LIMIT $1`, [limit, this.graceSeconds]));
    const errors: unknown[] = [];
    let failed = 0;
    for (const row of due.rows) {
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
        // reports failure only after the store answered, so a copy that
        // landed late was already rechecked by its finalize unless that
        // worker died; the grace is assumed to cover that copy's landing
        // (docs/evidence-storage.md records the assumption).
        if (attempt.state !== 'committed' && attempt.observed_sha256)
          await removeUnreferencedOriginal(this.cell, key[0], String(attempt.observed_sha256));
        await removeStaging(this.cell, key, String(attempt.staging_key), true);
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
}

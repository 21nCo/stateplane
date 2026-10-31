import type pg from 'pg';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, AuthorityTransaction } from './index.js';
import type { AuthorityScope } from './index.js';
import { includes, utcInstant } from './schema.js';
import type { PostgresSpaces } from './spaces.js';
import { boundedText, digest, evidenceEvent, evidenceRefusal, fields, idempotencyKey, invalid, iso, lockKey, reference, rowsRetained,
  serialized, transact, untrusted, writable } from './sources.js';
import type { Db, DeletionErasure } from './sources.js';

/** One cell's authority pool. */
export interface ClaimCell { pool: Pick<pg.Pool, 'connect'> }
export type ClaimReviewStatus = 'unreviewed' | 'accepted' | 'rejected';
/** A cited source, optionally a half-open code-point range of one of its extraction versions. */
export interface ClaimEvidenceView {
  collectionId: string; sourceId: string; extractionVersion: number | null; start: number | null; end: number | null;
}
/**
 * One immutable claim revision. Review status belongs to the revision, so a
 * new revision starts unreviewed. `createdBy` is the principal that created
 * the claim, and `recordedBy` the principal that recorded this revision: its
 * writer, or for a review its reviewer. `recordedBy` is null only for a
 * revision stored before migration 042, which no service wrote.
 */
export interface ClaimView {
  claimId: string; collectionId: string; revision: number; latestRevision: number; previousRevision: number | null;
  statement: string; attributedTo: string; observedAt: string | null; validFrom: string | null; validUntil: string | null;
  review: { status: ClaimReviewStatus; reviewedBy: string | null; reviewedAt: string | null };
  evidence: ClaimEvidenceView[]; createdBy: string; recordedBy: string | null; createdAt: string; committedAt: string;
  replayed: boolean;
}
/**
 * A deleted claim: its last revision, when the deletion committed, and what
 * remains: its revisions and evidence stay in the database, unreadable, until
 * the space is erased, and backups keep earlier copies.
 */
export interface ClaimDeletion {
  claimId: string; collectionId: string; revision: number; deletedAt: string; replayed: boolean; erasure: DeletionErasure;
}
/** `next` is the `after` value for the following page, or null on the last page. */
export interface ClaimPage { claims: ClaimView[]; next: string | null }

/** Initial bounds; docs/evidence-storage.md records the evidence for each. */
export const claimBounds = Object.freeze({ statementBytes: 1_048_576, attributionBytes: 1_024, evidence: 32, page: 25 });

const isSafeInteger = Number.isSafeInteger;
const stringify = JSON.stringify;
const reviewStatuses: readonly string[] = Object.freeze(['unreviewed', 'accepted', 'rejected']);
// Request field lists are fixed at module load and read by own index, never through an array iterator.
const createFields = Object.freeze(['idempotencyKey', 'statement', 'attributedTo', 'observedAt', 'validFrom', 'validUntil',
  'evidence']);
const reviseFields = Object.freeze(['baseRevision', 'statement', 'attributedTo', 'observedAt', 'validFrom', 'validUntil',
  'evidence']);
const createRequired = Object.freeze(['idempotencyKey', 'statement', 'attributedTo']);
const reviseRequired = Object.freeze(['baseRevision', 'statement', 'attributedTo']);
const reviewFields = Object.freeze(['baseRevision', 'status']);
const deleteFields = Object.freeze(['baseRevision']);
const listFields = Object.freeze(['citing', 'status', 'after', 'limit']);
const sourceFields = Object.freeze(['collectionId', 'sourceId']);
const evidenceFields = Object.freeze(['collectionId', 'sourceId', 'extractionVersion', 'start', 'end']);

interface Admitted { cell: ClaimCell; ownerPrincipalId: string; scope: AuthorityScope; capability: Capability; also?: Capability }
interface Content {
  statement: string; attributedTo: string; observedAt: string | null; validFrom: string | null; validUntil: string | null;
  evidence: ClaimEvidenceView[];
}

/** Append to a list this module owns without an inherited setter or `push`. */
function put<T>(list: T[], value: T): void {
  Object.defineProperty(list, list.length, { value, writable: true, enumerable: true, configurable: true });
}
const at = <T>(list: readonly T[], index: number): T => Object.getOwnPropertyDescriptor(list, index)!.value as T;
const derivedClaimId = (credentialId: string, key: string) => `clm_${digest(serialized(['claim', credentialId, key]))}`;
/**
 * A UTC instant of at most millisecond precision, which views report
 * exactly. `utcInstant` drops trailing zeros, so a normalized instant has
 * at most three fraction digits when it is at most 24 characters long.
 * `utcInstant` also accepts an announced leap second, which `timestamptz`
 * cannot store as itself, so a claim time refuses second 60.
 */
function optionalInstant(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') invalid(`Invalid ${name}`);
  let instant: string;
  try { instant = utcInstant(value); } catch { return invalid(`Invalid ${name}`); }
  if (instant.length > 24) invalid(`${name} has more than millisecond precision`);
  if (instant[17] === '6') invalid(`${name} is a leap second, which claim times cannot represent`);
  return instant;
}
const positive = (value: unknown): value is number => isSafeInteger(value) && (value as number) >= 1;

/** One evidence item; ranges are code points of the cited extraction version's content. */
function evidenceItem(value: unknown): ClaimEvidenceView {
  const item = fields(value, evidenceFields, sourceFields);
  if (!reference(item.collectionId) || !reference(item.sourceId)) invalid('Invalid evidence source');
  const version = item.extractionVersion === undefined ? null : item.extractionVersion;
  if (version !== null && !positive(version)) invalid('Evidence extractionVersion must be a positive integer');
  if ((item.start === undefined) !== (item.end === undefined)) invalid('Evidence start and end go together');
  let start: number | null = null;
  let end: number | null = null;
  if (item.start !== undefined) {
    if (version === null) invalid('An evidence range needs an extractionVersion');
    if (!isSafeInteger(item.start) || !isSafeInteger(item.end) || (item.start as number) < 0 ||
      (item.start as number) >= (item.end as number)) invalid('Evidence range must be a nonempty half-open range');
    start = item.start as number;
    end = item.end as number;
  }
  return { collectionId: item.collectionId, sourceId: item.sourceId, extractionVersion: version, start, end };
}
/** A plain array of evidence items, read by own index. */
function evidenceList(value: unknown): ClaimEvidenceView[] {
  const evidence: ClaimEvidenceView[] = [];
  if (value === undefined) return evidence;
  if (!value || typeof value !== 'object' || untrusted(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) invalid('evidence must be an array');
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length > claimBounds.evidence) invalid('Too many evidence items');
  // Every index is checked below, so exactly `length` indices plus `length` admits no other member.
  if (Reflect.ownKeys(value).length !== length + 1) invalid('evidence must be a plain array');
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, i);
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) invalid('evidence must be a plain array');
    put(evidence, evidenceItem(item.value));
  }
  return evidence;
}
/** Validate a claim's content after its transaction has authorized the caller. */
function claimContent(input: Record<string, unknown>): Content {
  if (!boundedText(input.statement, claimBounds.statementBytes)) invalid('Invalid statement');
  if (!boundedText(input.attributedTo, claimBounds.attributionBytes)) invalid('Invalid attributedTo');
  return { statement: input.statement, attributedTo: input.attributedTo,
    observedAt: optionalInstant(input.observedAt, 'observedAt'), validFrom: optionalInstant(input.validFrom, 'validFrom'),
    validUntil: optionalInstant(input.validUntil, 'validUntil'), evidence: evidenceList(input.evidence) };
}
/** Evidence as JSON rows `[collection, source, version, start, end]`, built from checked values only. */
function evidenceJson(evidence: readonly ClaimEvidenceView[]): string {
  let text = '[';
  for (let i = 0; i < evidence.length; i++) {
    const { collectionId, sourceId, extractionVersion, start, end } = at(evidence, i);
    const number = (value: number | null) => value === null ? 'null' : `${value}`;
    text += `${i ? ',' : ''}[${stringify(collectionId)},${stringify(sourceId)},${number(extractionVersion)},${number(start)},${number(end)}]`;
  }
  return `${text}]`;
}

/** Writers on one claim, including a create and its retries, serialize on its identity. */
async function lockClaim(db: Db, spaceId: string, claimId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey(['stateplane:claim', spaceId, claimId])]);
}
/** Times are in order and the observation is not in the future; every cited source and range exists. */
async function checkContent(db: Db, scope: AuthorityScope, content: Content): Promise<void> {
  const times = (await db.query(`SELECT ($1::timestamptz IS NULL OR $1::timestamptz<=clock_timestamp()) AS observed,
    ($2::timestamptz IS NULL OR $3::timestamptz IS NULL OR $2::timestamptz<=$3::timestamptz) AS ordered`,
  [content.observedAt, content.validFrom, content.validUntil])).rows[0];
  if (times?.observed !== true) invalid('observedAt is in the future');
  if (times.ordered !== true) invalid('validFrom is after validUntil');
  if (!content.evidence.length) return;
  const rows = (await db.query(`SELECT e.ordinal,r.tombstone IS FALSE AS live,
      (e.item->>2) IS NULL OR v.version IS NOT NULL AS has_version,char_length(v.content) AS length
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(item,ordinal)
    LEFT JOIN entity_refs r ON r.space_id=$1 AND r.collection_id=e.item->>0 AND r.kind='source' AND r.entity_id=e.item->>1
    LEFT JOIN extraction_versions v ON v.space_id=$1 AND v.collection_id=e.item->>0 AND v.source_id=e.item->>1
      AND v.version=(e.item->>2)::bigint
    ORDER BY e.ordinal`, [scope.spaceId, evidenceJson(content.evidence)])).rows;
  for (let i = 0; i < content.evidence.length; i++) {
    const row = rows[i];
    if (row?.live !== true) throw new AuthorityError('NOT_FOUND', 'Cited source not found');
    if (row.has_version !== true) throw new AuthorityError('NOT_FOUND', 'Cited extraction version not found');
    const end = at(content.evidence, i).end;
    if (end !== null && end > Number(row.length)) invalid('Evidence range is outside the extraction content');
  }
}
/** A revision's evidence as stored, `[collection, source, version, start, end]` rows in order. */
const evidenceOf = (r: string) => `COALESCE((SELECT jsonb_agg(jsonb_build_array(v.source_collection_id,v.source_id,
    v.extraction_version,v.start_offset,v.end_offset) ORDER BY v.ordinal) FROM claim_evidence v WHERE v.space_id=${r}.space_id
    AND v.collection_id=${r}.collection_id AND v.claim_id=${r}.claim_id AND v.revision=${r}.revision),'[]'::jsonb)`;
/** Make `revision` the claim's current revision; another writer moving it first is a conflict. */
async function advance(db: Db, scope: AuthorityScope, claimId: string, revision: number): Promise<void> {
  const moved = await db.query(`UPDATE entity_refs SET revision=$4 WHERE space_id=$1 AND collection_id=$2 AND kind='claim'
    AND entity_id=$3 AND revision=$4-1 AND NOT tombstone`, [scope.spaceId, scope.collectionId, claimId, revision]);
  if (moved.rowCount !== 1) throw new AuthorityError('REVISION_CONFLICT', 'The claim changed');
}
/** Insert one unreviewed revision and its evidence, and make it the claim's current revision. */
async function insertRevision(db: Db, scope: AuthorityScope, claimId: string, revision: number, content: Content): Promise<void> {
  const { spaceId, collectionId } = scope;
  await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,
      recorded_by,observed_at,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [spaceId, collectionId, claimId, revision, content.statement, content.attributedTo, scope.credentialId, scope.principalId,
    content.observedAt, content.validFrom, content.validUntil]);
  if (content.evidence.length) await db.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,
      source_collection_id,source_id,extraction_version,start_offset,end_offset)
    SELECT $1,$2,$3,$4,e.ordinal-1,e.item->>0,e.item->>1,(e.item->>2)::bigint,(e.item->>3)::bigint,(e.item->>4)::bigint
    FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY AS e(item,ordinal)`, [spaceId, collectionId, claimId, revision,
    evidenceJson(content.evidence)]);
  if (revision > 1) await advance(db, scope, claimId, revision);
}
/**
 * Review `base` as the revision after it: the stored content and evidence
 * are copied in SQL, never through a view, with the reviewer and review time.
 */
async function insertReview(db: Db, scope: AuthorityScope, claimId: string, base: number,
  status: ClaimReviewStatus): Promise<void> {
  const key = [scope.spaceId, scope.collectionId, claimId, base];
  const copied = await db.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,
      credential_id,recorded_by,observed_at,valid_from,valid_until,review_status,reviewed_by,reviewed_at)
    SELECT space_id,collection_id,claim_id,revision+1,statement,attributed_to,$5,$7,observed_at,valid_from,valid_until,$6,$7,
      clock_timestamp()
    FROM claim_revisions WHERE space_id=$1 AND collection_id=$2 AND claim_id=$3 AND revision=$4`,
  [...key, scope.credentialId, status, scope.principalId]);
  if (copied.rowCount !== 1) throw new AuthorityError('REVISION_CONFLICT', 'The claim changed');
  await db.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id,
      extraction_version,start_offset,end_offset)
    SELECT space_id,collection_id,claim_id,revision+1,ordinal,source_collection_id,source_id,extraction_version,start_offset,
      end_offset
    FROM claim_evidence WHERE space_id=$1 AND collection_id=$2 AND claim_id=$3 AND revision=$4`, key);
  await advance(db, scope, claimId, base + 1);
}
/**
 * Whether a stored revision has exactly this content, from this credential,
 * unreviewed: the test for replaying a retried create or revision.
 */
async function sameRevision(db: Db, scope: AuthorityScope, claimId: string, revision: number,
  content: Content): Promise<boolean> {
  const row = (await db.query(`SELECT r.statement=$5 AND r.attributed_to=$6 AND r.credential_id=$7
      AND r.recorded_by IS NOT DISTINCT FROM $12 AND r.review_status='unreviewed'
      AND r.observed_at IS NOT DISTINCT FROM $8::timestamptz
      AND r.valid_from IS NOT DISTINCT FROM $9::timestamptz AND r.valid_until IS NOT DISTINCT FROM $10::timestamptz
      AND ${evidenceOf('r')}=$11::jsonb AS same
    FROM claim_revisions r WHERE r.space_id=$1 AND r.collection_id=$2 AND r.claim_id=$3 AND r.revision=$4`,
  [scope.spaceId, scope.collectionId, claimId, revision, content.statement, content.attributedTo, scope.credentialId,
    content.observedAt, content.validFrom, content.validUntil, evidenceJson(content.evidence), scope.principalId])).rows[0];
  return row?.same === true;
}
/**
 * Whether the revision after `base` is this credential's review of it with
 * this status and exactly the stored content of `base`: the test for
 * replaying a retried review.
 */
async function sameReview(db: Db, scope: AuthorityScope, claimId: string, base: number,
  status: ClaimReviewStatus): Promise<boolean> {
  const row = (await db.query(`SELECT n.statement=b.statement AND n.attributed_to=b.attributed_to AND n.credential_id=$5
      AND n.review_status=$6 AND n.recorded_by IS NOT DISTINCT FROM $7 AND n.observed_at IS NOT DISTINCT FROM b.observed_at
      AND n.valid_from IS NOT DISTINCT FROM b.valid_from AND n.valid_until IS NOT DISTINCT FROM b.valid_until
      AND ${evidenceOf('n')}=${evidenceOf('b')} AS same
    FROM claim_revisions b JOIN claim_revisions n ON n.space_id=b.space_id AND n.collection_id=b.collection_id
      AND n.claim_id=b.claim_id AND n.revision=b.revision+1
    WHERE b.space_id=$1 AND b.collection_id=$2 AND b.claim_id=$3 AND b.revision=$4`,
  [scope.spaceId, scope.collectionId, claimId, base, scope.credentialId, status, scope.principalId])).rows[0];
  return row?.same === true;
}
/**
 * The final authority check, run after the call's last provider await with
 * no other await after it: one statement, against one clock reading, checks
 * the credential, every claim capability the call needs on the owning
 * collection, and `sources:read` on every cited collection it relied on.
 */
async function assertGrantsCurrent(db: Db, scope: AuthorityScope, ownerPrincipalId: string, capabilities: readonly string[],
  cited: readonly string[]): Promise<void> {
  const row = (await db.query(`WITH t AS (SELECT clock_timestamp() AS now),
    live AS (SELECT g.collection_id,g.capabilities FROM t,space_credentials sc
      JOIN collection_grants g ON g.space_id=sc.space_id AND g.credential_id=sc.credential_id
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
      WHERE sc.space_id=$1 AND sc.credential_id=$2 AND sc.owner_principal_id=$3 AND c.lifecycle<>'deleted'
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at>t.now
        AND (g.expires_at IS NULL OR g.expires_at>t.now))
    SELECT EXISTS (SELECT 1 FROM live WHERE collection_id=$4 AND capabilities @> $5::text[])
      AND NOT EXISTS (SELECT 1 FROM unnest($6::text[]) AS x(id) WHERE NOT EXISTS (SELECT 1 FROM live
        WHERE live.collection_id=x.id AND 'sources:read'=ANY(live.capabilities))) AS current`,
  [scope.spaceId, scope.credentialId, ownerPrincipalId, scope.collectionId, capabilities, cited])).rows[0];
  if (row?.current !== true) throw new AuthorityError('FORBIDDEN');
}

/**
 * The view columns, and `cited`: every collection any revision of the claim
 * cites. One statement reads both, so the visibility decision and the
 * revision it admits come from one snapshot.
 */
const viewSelect = `SELECT c.claim_id,c.collection_id,c.principal_id,c.created_at,e.revision AS latest,e.tombstone,r.revision,
    r.previous_revision,r.statement,r.attributed_to,r.observed_at,r.valid_from,r.valid_until,r.review_status,r.reviewed_by,
    r.reviewed_at,r.recorded_by,r.committed_at,
    ${evidenceOf('r')} AS evidence,
    ARRAY(SELECT DISTINCT a.source_collection_id FROM claim_evidence a WHERE a.space_id=c.space_id
      AND a.collection_id=c.collection_id AND a.claim_id=c.claim_id) AS cited
  FROM claims c JOIN entity_refs e ON e.space_id=c.space_id AND e.collection_id=c.collection_id AND e.kind='claim'
    AND e.entity_id=c.claim_id`;
const nullable = (value: unknown) => value === null ? null : Number(value);
function claimView(row: Record<string, unknown>, replayed: boolean): ClaimView {
  const stored = row.evidence as unknown[][];
  const evidence: ClaimEvidenceView[] = [];
  for (let i = 0; i < stored.length; i++) {
    const item = stored[i];
    put(evidence, { collectionId: String(item[0]), sourceId: String(item[1]), extractionVersion: nullable(item[2]),
      start: nullable(item[3]), end: nullable(item[4]) });
  }
  return { claimId: String(row.claim_id), collectionId: String(row.collection_id), revision: Number(row.revision),
    latestRevision: Number(row.latest), previousRevision: nullable(row.previous_revision), statement: String(row.statement),
    attributedTo: String(row.attributed_to), observedAt: iso(row.observed_at), validFrom: iso(row.valid_from),
    validUntil: iso(row.valid_until), review: { status: row.review_status as ClaimReviewStatus,
      reviewedBy: row.reviewed_by as string | null, reviewedAt: iso(row.reviewed_at) },
    evidence, createdBy: String(row.principal_id), recordedBy: row.recorded_by === null ? null : String(row.recorded_by),
    createdAt: iso(row.created_at)!, committedAt: iso(row.committed_at)!, replayed };
}

/**
 * The caller's source access inside one claims transaction. A claim is
 * visible only to a caller who may read sources in every collection any of
 * its revisions cites, so a claim never discloses evidence, or text derived
 * from it, beyond that evidence's own collections. Each cited collection the
 * call relies on is fenced like the claim's own collection.
 */
class SourceAccess {
  private readable: string[] | null = null;
  readonly fenced: string[] = [];
  private readonly fences: AuthorityTransaction[] = [];
  constructor(private readonly db: Db, private readonly scope: AuthorityScope) {}

  /** Collections in the space whose sources the caller may read now. */
  async collections(): Promise<string[]> {
    if (this.readable) return this.readable;
    const rows = (await this.db.query(`SELECT c.collection_id FROM collections c JOIN spaces s ON s.space_id=c.space_id
      LEFT JOIN collection_grants g ON g.space_id=c.space_id AND g.collection_id=c.collection_id AND g.credential_id=$2
      WHERE c.space_id=$1 AND c.lifecycle<>'deleted' AND (s.owner_principal_id=$3 OR ('sources:read'=ANY(g.capabilities)
        AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))`,
    [this.scope.spaceId, this.scope.credentialId, this.scope.principalId])).rows;
    const readable: string[] = [];
    for (let i = 0; i < rows.length; i++) put(readable, String(rows[i].collection_id));
    this.readable = readable;
    return readable;
  }
  async canRead(collectionIds: readonly string[]): Promise<boolean> {
    const readable = await this.collections();
    for (let i = 0; i < collectionIds.length; i++) if (!includes(readable, at(collectionIds, i))) return false;
    return true;
  }
  /** Hold a readable collection's grant, lifecycle and policy through commit. */
  async fence(collectionIds: readonly string[]): Promise<void> {
    for (let i = 0; i < collectionIds.length; i++) {
      const collectionId = at(collectionIds, i);
      if (includes(this.fenced, collectionId)) continue;
      const fence = new AuthorityTransaction(this.db, { ...this.scope, collectionId: collectionId as AuthorityScope['collectionId'],
        capability: 'sources:read' }, 1);
      put(this.fences, fence);
      put(this.fenced, collectionId);
      await fence.checkScope();
    }
  }
  /** Authorize citing these sources: FORBIDDEN, before any lookup, unless every collection is readable. */
  async cite(evidence: readonly ClaimEvidenceView[]): Promise<void> {
    const ids: string[] = [];
    for (let i = 0; i < evidence.length; i++) put(ids, at(evidence, i).collectionId);
    if (!await this.canRead(ids)) throw new AuthorityError('FORBIDDEN', 'Evidence cites a collection the caller cannot read');
    await this.fence(ids);
  }
  /** Admit a view row: NOT_FOUND when it cites a collection the caller cannot read. */
  async admit(row: Record<string, unknown> | undefined, replayed: boolean): Promise<ClaimView> {
    if (!row || row.tombstone) throw new AuthorityError('NOT_FOUND');
    const cited = row.cited as string[];
    if (!await this.canRead(cited)) throw new AuthorityError('NOT_FOUND');
    await this.fence(cited);
    return claimView(row, replayed);
  }
  async recheck(): Promise<void> {
    for (let i = 0; i < this.fences.length; i++) await at(this.fences, i).checkScope();
  }
  close(): void { for (let i = 0; i < this.fences.length; i++) at(this.fences, i).close(); }
}
/** One claim revision in the scope's collection, the current one when `revision` is null. */
async function readClaim(db: Db, access: SourceAccess, scope: AuthorityScope, claimId: string, revision: number | null,
  replayed: boolean): Promise<ClaimView> {
  const row = (await db.query(`${viewSelect} JOIN claim_revisions r ON r.space_id=c.space_id AND r.collection_id=c.collection_id
      AND r.claim_id=c.claim_id AND r.revision=COALESCE($4::bigint,e.revision)
    WHERE c.space_id=$1 AND c.collection_id=$2 AND c.claim_id=$3`, [scope.spaceId, scope.collectionId, claimId, revision])).rows[0];
  return access.admit(row, replayed);
}

/**
 * Explicit claims for one owning collection: attributed statements with
 * evidence references, valid and observed time, and review. Claims never
 * write records. Every call is admitted for the caller's own grant on the
 * collection, and its transaction rechecks policy, lifecycle and credential
 * before COMMIT, for the claim's collection and every cited one.
 */
export class PostgresClaims {
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, ClaimCell>) {}

  private async admit(actor: VerifiedCredential, spaceId: string, collectionId: string, capability: Capability,
    also?: Capability): Promise<Admitted> {
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, capability);
    const cell = this.cells.get(admitted.cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return { cell, ownerPrincipalId: admitted.ownerPrincipalId, scope: admitted.scope, capability, also };
  }

  private async tx<T>(actor: VerifiedCredential, admitted: Admitted, fn: (db: Db, access: SourceAccess) => Promise<T>): Promise<T> {
    try { return await this.checkedTx(actor, admitted, fn); }
    catch (error) {
      // Migration 043's commit-time check: a grant or key lapsed after the final statement, so COMMIT rolled back.
      if ((error as { constraint?: unknown })?.constraint === 'claim_revisions_authority') throw new AuthorityError('FORBIDDEN');
      throw error;
    }
  }

  private checkedTx<T>(actor: VerifiedCredential, admitted: Admitted, fn: (db: Db, access: SourceAccess) => Promise<T>): Promise<T> {
    const { scope, ownerPrincipalId } = admitted;
    return transact(admitted.cell.pool, async db => {
      // Direct calls, not iteration, so a later change to Array.prototype cannot skip a check.
      const fence = new AuthorityTransaction(db, scope, 1);
      const also = admitted.also ? new AuthorityTransaction(db, { ...scope, capability: admitted.also }, 1) : null;
      const access = new SourceAccess(db, scope);
      const checkScope = async () => { await fence.checkScope(); if (also) await also.checkScope(); };
      try {
        await checkScope();
        const result = await fn(db, access);
        await checkScope();
        await access.recheck();
        // The provider is asked last, then every grant is checked in one statement with no await between them,
        // so no grant can lapse unchecked while another is checked.
        await this.spaces.assertCurrent(actor, ownerPrincipalId);
        if (actor.kind === 'api-key') await assertGrantsCurrent(db, scope, ownerPrincipalId,
          admitted.also ? [admitted.capability, admitted.also] : [admitted.capability], access.fenced);
        return result;
      } finally { fence.close(); also?.close(); access.close(); }
    });
  }

  /**
   * Record a claim as revision 1, unreviewed. The caller needs `claims:write`
   * here and `sources:read` on every cited source's collection. A retry with
   * the same idempotency key and content replays revision 1.
   */
  async create(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<ClaimView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:write');
    const scope = admitted.scope;
    return this.tx(actor, admitted, async (db, access) => {
      const input = fields(request, createFields, createRequired);
      const key = idempotencyKey(input.idempotencyKey);
      const content = claimContent(input);
      await access.cite(content.evidence);
      const claimId = derivedClaimId(scope.credentialId, key);
      await lockClaim(db, scope.spaceId, claimId);
      const existing = (await db.query('SELECT collection_id FROM claims WHERE space_id=$1 AND claim_id=$2',
        [scope.spaceId, claimId])).rows[0];
      if (existing) {
        if (existing.collection_id !== scope.collectionId) {
          const original = new AuthorityTransaction(db, { ...scope, collectionId: existing.collection_id }, 1);
          try { await original.checkScope(); } finally { original.close(); }
          throw new AuthorityError('IDEMPOTENCY_MISMATCH');
        }
        if (!await sameRevision(db, scope, claimId, 1, content)) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
        return readClaim(db, access, scope, claimId, 1, true);
      }
      await writable(db, scope);
      await checkContent(db, scope, content);
      await db.query(`INSERT INTO entity_refs(space_id,collection_id,kind,entity_id) VALUES($1,$2,'claim',$3)`,
        [scope.spaceId, scope.collectionId, claimId]);
      await db.query(`INSERT INTO claims(space_id,collection_id,claim_id,principal_id,credential_id) VALUES($1,$2,$3,$4,$5)`,
        [scope.spaceId, scope.collectionId, claimId, scope.principalId, scope.credentialId]);
      await insertRevision(db, scope, claimId, 1, content);
      return readClaim(db, access, scope, claimId, 1, false);
    });
  }

  /**
   * Replace a claim's content as the revision after `baseRevision`, which
   * must be the latest. The new revision is unreviewed; earlier revisions,
   * and their reviews, stay readable. Repeating a revision with the same
   * credential and content replays it; any other revision after the base is
   * a REVISION_CONFLICT. Needs `claims:write` and `claims:read`.
   */
  async revise(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string,
    request: unknown): Promise<ClaimView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:write', 'claims:read');
    const scope = admitted.scope;
    return this.tx(actor, admitted, async (db, access) => {
      if (!reference(claimId)) throw new AuthorityError('NOT_FOUND');
      const input = fields(request, reviseFields, reviseRequired);
      if (!positive(input.baseRevision)) invalid('baseRevision must be a positive integer');
      const base = input.baseRevision;
      const content = claimContent(input);
      await access.cite(content.evidence);
      await lockClaim(db, scope.spaceId, claimId);
      const latest = (await readClaim(db, access, scope, claimId, null, false)).revision;
      if (base > latest) throw new AuthorityError('NOT_FOUND');
      if (base < latest) {
        if (await sameRevision(db, scope, claimId, base + 1, content))
          return readClaim(db, access, scope, claimId, base + 1, true);
        throw new AuthorityError('REVISION_CONFLICT', 'A later claim revision exists', latest);
      }
      await writable(db, scope);
      await checkContent(db, scope, content);
      await insertRevision(db, scope, claimId, latest + 1, content);
      return readClaim(db, access, scope, claimId, latest + 1, false);
    });
  }

  /**
   * Accept or reject the claim's latest revision, `baseRevision`, as a new
   * revision with the same content, recording the reviewer and review time.
   * Needs the privileged `claims:review` and `claims:read`. Reviewing a claim
   * changes no other claim, so conflicting claims stay as they are.
   */
  async review(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string,
    request: unknown): Promise<ClaimView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:review', 'claims:read');
    const scope = admitted.scope;
    return this.tx(actor, admitted, async (db, access) => {
      if (!reference(claimId)) throw new AuthorityError('NOT_FOUND');
      const input = fields(request, reviewFields, reviewFields);
      if (!positive(input.baseRevision)) invalid('baseRevision must be a positive integer');
      const base = input.baseRevision;
      const status = input.status;
      if (status !== 'accepted' && status !== 'rejected') invalid('status must be accepted or rejected');
      await lockClaim(db, scope.spaceId, claimId);
      const latest = (await readClaim(db, access, scope, claimId, null, false)).revision;
      if (base > latest) throw new AuthorityError('NOT_FOUND');
      if (base < latest) {
        if (await sameReview(db, scope, claimId, base, status)) return readClaim(db, access, scope, claimId, base + 1, true);
        throw new AuthorityError('REVISION_CONFLICT', 'A later claim revision exists', latest);
      }
      await writable(db, scope);
      await insertReview(db, scope, claimId, base, status);
      return readClaim(db, access, scope, claimId, latest + 1, false);
    });
  }

  /**
   * Delete a claim at `baseRevision`, which must be its latest: tombstone it,
   * with every incident `detach` link, a deletion event and its projection
   * invalidation. A live `restrict` link on it is `LINK_RESTRICTED` and
   * changes nothing. Needs `claims:write` and `claims:read`, and the claim
   * must be visible to the caller. Its revisions stay in the database,
   * unreadable, until the space is erased. Deleting it again at the same base
   * replays the deletion.
   */
  async delete(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string,
    request: unknown): Promise<ClaimDeletion> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:write', 'claims:read');
    const scope = admitted.scope;
    try {
      return await this.tx(actor, admitted, async (db, access) => {
        if (!reference(claimId)) throw new AuthorityError('NOT_FOUND');
        const input = fields(request, deleteFields, deleteFields);
        if (!positive(input.baseRevision)) invalid('baseRevision must be a positive integer');
        const base = input.baseRevision;
        await lockClaim(db, scope.spaceId, claimId);
        const row = (await db.query(`SELECT e.revision,e.tombstone,
            ARRAY(SELECT DISTINCT a.source_collection_id FROM claim_evidence a WHERE a.space_id=e.space_id
              AND a.collection_id=e.collection_id AND a.claim_id=e.entity_id) AS cited,
            (SELECT v.committed_at FROM evidence_events v WHERE v.space_id=e.space_id AND v.collection_id=e.collection_id
              AND v.kind='claim' AND v.entity_id=e.entity_id AND v.operation='delete') AS deleted_at
          FROM entity_refs e WHERE e.space_id=$1 AND e.collection_id=$2 AND e.kind='claim' AND e.entity_id=$3`,
        [scope.spaceId, scope.collectionId, claimId])).rows[0];
        // The claim read rule: a claim citing a collection the caller cannot read does not exist for it.
        if (!row || !await access.canRead(row.cited as string[])) throw new AuthorityError('NOT_FOUND');
        await access.fence(row.cited as string[]);
        const latest = Number(row.revision);
        if (row.tombstone) {
          if (row.deleted_at && base === latest)
            return { claimId, collectionId: scope.collectionId, revision: latest, deletedAt: iso(row.deleted_at)!, replayed: true,
              erasure: { ...rowsRetained } };
          throw new AuthorityError('NOT_FOUND');
        }
        if (base > latest) throw new AuthorityError('NOT_FOUND');
        if (base < latest) throw new AuthorityError('REVISION_CONFLICT', 'A later claim revision exists', latest);
        await writable(db, scope);
        // Migration 044's guard refuses a restrict link and detaches the rest.
        await db.query(`UPDATE entity_refs SET tombstone=true WHERE space_id=$1 AND collection_id=$2 AND kind='claim'
          AND entity_id=$3 AND revision=$4 AND NOT tombstone`, [scope.spaceId, scope.collectionId, claimId, base]);
        const deletedAt = await evidenceEvent(db, scope, 'claim', claimId, base, 'delete');
        return { claimId, collectionId: scope.collectionId, revision: base, deletedAt, replayed: false, erasure: { ...rowsRetained } };
      });
    } catch (error) { throw evidenceRefusal(error); }
  }

  /** Read one revision of a live claim in the collection, the latest when `revision` is omitted. */
  async get(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string,
    revision?: number): Promise<ClaimView> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:read');
    return this.tx(actor, admitted, async (db, access) => {
      if (!reference(claimId)) throw new AuthorityError('NOT_FOUND');
      if (revision !== undefined && !positive(revision)) invalid('revision must be a positive integer');
      return readClaim(db, access, admitted.scope, claimId, revision ?? null, false);
    });
  }

  /**
   * List the current revisions of live claims in the collection, by claim ID,
   * whatever their review status, so conflicting claims are all listed.
   * `citing` keeps claims whose current revision cites that source, and
   * `status` one review status. A claim the caller may not see is omitted.
   */
  async list(actor: VerifiedCredential, spaceId: string, collectionId: string, query: unknown = {}): Promise<ClaimPage> {
    const admitted = await this.admit(actor, spaceId, collectionId, 'claims:read');
    const scope = admitted.scope;
    return this.tx(actor, admitted, async (db, access) => {
      const input = fields(query, listFields, []);
      let citing: { collectionId: string; sourceId: string } | null = null;
      if (input.citing !== undefined) {
        const cited = fields(input.citing, sourceFields, sourceFields);
        if (!reference(cited.collectionId) || !reference(cited.sourceId)) invalid('Invalid citing source');
        citing = { collectionId: cited.collectionId, sourceId: cited.sourceId };
      }
      const status = input.status === undefined ? null : input.status;
      if (status !== null && (typeof status !== 'string' || !includes(reviewStatuses, status))) invalid('Invalid status');
      const after = input.after === undefined ? null : input.after;
      if (after !== null && !reference(after)) invalid('Invalid after');
      const limit = input.limit === undefined ? claimBounds.page : input.limit;
      if (!positive(limit) || limit > claimBounds.page) invalid('limit is outside the page bound');
      if (citing) {
        if (!await access.canRead([citing.collectionId]))
          throw new AuthorityError('FORBIDDEN', 'The cited collection is not readable');
        await access.fence([citing.collectionId]);
      }
      const readable = await access.collections();
      const rows = (await db.query(`${viewSelect} JOIN claim_revisions r ON r.space_id=c.space_id
          AND r.collection_id=c.collection_id AND r.claim_id=c.claim_id AND r.revision=e.revision
        WHERE c.space_id=$1 AND c.collection_id=$2 AND NOT e.tombstone AND ($3::text IS NULL OR c.claim_id COLLATE "C">$3::text)
          AND ($4::text IS NULL OR r.review_status=$4::text)
          AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM claim_evidence x WHERE x.space_id=c.space_id
            AND x.collection_id=c.collection_id AND x.claim_id=c.claim_id AND x.revision=e.revision
            AND x.source_collection_id=$5::text AND x.source_id=$6::text))
          AND NOT EXISTS (SELECT 1 FROM claim_evidence a WHERE a.space_id=c.space_id AND a.collection_id=c.collection_id
            AND a.claim_id=c.claim_id AND NOT (a.source_collection_id=ANY($7::text[])))
        ORDER BY c.claim_id COLLATE "C" LIMIT $8`,
      [scope.spaceId, scope.collectionId, after, status, citing?.collectionId ?? null, citing?.sourceId ?? null, readable,
        limit + 1])).rows;
      // The row past the page decides `next`, so it is admitted and fenced like the page's own rows.
      const admitted: ClaimView[] = [];
      for (let i = 0; i < rows.length; i++) put(admitted, await access.admit(rows[i], false));
      const claims: ClaimView[] = [];
      for (let i = 0; i < admitted.length && i < limit; i++) put(claims, at(admitted, i));
      const next = admitted.length > limit ? at(claims, limit - 1).claimId : null;
      return { claims, next };
    });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { exportSections, portabilityFormat, portabilityFormatVersion } from '@stateplane/contracts';
import type { ExportManifest, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, CommitOutcomeUnknownError } from './index.js';
import type { AuthorityScope } from './index.js';
import { finalCheck, lockedOut, probing, publish, released } from './analysis-jobs.js';
import type { Deadline } from './analysis-jobs.js';
import { DeadlineExceededError, inTransaction } from './faults.js';
import type { PoolLike, Session } from './faults.js';
import { transact } from './sources.js';
import type { Db } from './sources.js';
import type { PostgresSpaces } from './spaces.js';

/**
 * Protective bounds, not measured capacity (docs/portability-export.md#budgets):
 * per export, 1 GiB of parts, 4,096 parts (the manifest included, so its part
 * list stays far inside one 1 MiB part), 3,600,000 ms of step time and a 24 h
 * lifetime, completed result included; at most 2 unfinished exports per
 * space, and at most 4 held (unfinished, or completed until a worker ends it
 * and removes its parts), so a space holds at most 4 GiB of export parts; parts of at most 1 MiB
 * (migration 051's bound) read 1,000 rows at a time; a 30 s lease extended by
 * every part; pending record events published at submission in rounds of
 * 5,000, at most 20; 30 s for a submission to admit its queued export once
 * its final credential check is released, after which a worker cancels it unrun.
 */
export const portabilityExportBounds = Object.freeze({ budgetBytes: 1_073_741_824, maxParts: 4_096, budgetRuntimeMs: 3_600_000,
  lifetimeMs: 86_400_000, activePerSpace: 2, heldPerSpace: 4, partBytes: 1_048_576, readRows: 1_000, leaseMs: 30_000,
  publishBatch: 5_000, publishRounds: 20, admissionMs: 30_000 });

export type PortabilityJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
/** The state a space export is read at: records as of the watermark, everything else as of the snapshot instant. */
export interface PortabilityBoundary {
  spaceId: string; watermark: number; snapshotAt: string; records: 'as-of-watermark'; evidence: 'as-of-snapshot';
  policyVersion: number; placementGeneration: number; formatVersion: number;
}
export interface PortabilityExportStatus {
  jobId: string; kind: 'export'; state: PortabilityJobState; failureCode: string | null; boundary: PortabilityBoundary;
  progress: { section: string | null; partsWritten: number; attempts: number; runtimeMs: number };
  budgets: { bytes: number; parts: number; runtimeMs: number };
  /**
   * UTC to the microsecond, as stored. `createdAt` is the snapshot instant; `startedAt` is when the export was admitted
   * to run (its submission's final check passed), shown only once a worker has claimed it.
   */
  createdAt: string; startedAt: string | null; finishedAt: string | null; expiresAt: string;
  /** Present only once the manifest, the last part, has sealed a complete export. */
  manifest: { sha256: string; partCount: number } | null;
  complete: boolean;
}
export interface PortabilityExportPart {
  jobId: string; manifest: { sha256: string; partCount: number };
  part: { number: number; section: string; rowCount: number; byteSize: number; sha256: string; content: string };
}
export interface PortabilityStep {
  expired: number; claimed: number; parts: number; completed: number; failed: number;
  /** Exports whose submission never admitted them (its final check failed or never finished), cancelled unrun. */
  unadmitted: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver rows, read by column name
type Row = Record<string, any>;

const JOB_ID = /^exp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNFINISHED = `('queued','running')`;
/**
 * Admission. Submission inserts an export `queued`, makes its final credential
 * check in a transaction of its own and, only once that check's COMMIT is
 * acknowledged with the access it relied on unexpired, admits it in a third:
 * `running` with no attempt yet and a lease that has already ended, so it is
 * due at once. Workers claim only admitted exports; a queued export is never
 * run. One still queued once `admissionMs` has passed was never admitted (its
 * check failed, or its submitter stopped) and a worker cancels it.
 */
const UNADMITTED = `(j.state='queued' AND j.created_at<=clock_timestamp()-${portabilityExportBounds.admissionMs}*interval '1 millisecond')`;
/** An admitted export a worker may claim: running, its lease ended, before its expiry. */
const CLAIMABLE = `j.kind='export' AND j.state='running' AND j.leased_until<=clock_timestamp() AND j.expires_at>clock_timestamp()`;
/** An export a worker ends: past its expiry (a completed one included), or never admitted. */
const ENDING = `j.kind='export' AND ((j.state IN ('queued','running','completed') AND j.expires_at<=clock_timestamp()) OR ${UNADMITTED})`;
const MIN_PART_MS = 1_000;
const RELEASE_MS = 500;
/**
 * A timestamptz as UTC RFC 3339 text to the microsecond, exactly as the database stores it: every instant an export or
 * a status carries is read this way, never through a JavaScript Date, which keeps milliseconds only. An infinite value
 * reads as its own text, which `instant` refuses.
 */
const utc = (column: string) =>
  `CASE WHEN isfinite(${column}) THEN to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE (${column})::text END`;
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** An instant `utc` read, or null; anything else (an infinite timestamp) is no instant the format carries. */
function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !STORED_INSTANT.test(value)) throw new TypeError(`An instant the export format cannot carry: ${String(value)}`);
  return value;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const cutShort = (error: unknown) => error instanceof DeadlineExceededError;
/** What no export carries, whatever the space holds: the manifest states it. */
const EXCLUDED = ['credential-secrets', 'session-tokens', 'storage-object-keys', 'original-bytes', 'derived-projections'];

/**
 * One section: its rows after a cursor of its key columns `k1..kn`, in key
 * order, each with `size` (about the bytes of its line), and the NDJSON line
 * of a row ('' for a row the section skips but its cursor passes).
 * Parameters: $1 the space, $2 the snapshot instant, $3 the watermark. `AFTER`
 * is the cursor condition. Each reads the state as of the boundary: rows
 * created after the snapshot instant are left out, rows deleted before it are
 * left out, and a row changed in place since (a link tombstoned) is read as it
 * was. A deleted source or claim is only its deletion event, never content.
 */
interface Section { keys: number; sql: string; line: (row: Row) => string }
const notDeleted = (kind: string, collection: string, id: string) => `NOT EXISTS (SELECT 1 FROM evidence_events v
  WHERE v.space_id=$1 AND v.collection_id=${collection} AND v.kind='${kind}' AND v.entity_id=${id} AND v.operation='delete'
    AND v.committed_at<=$2)`;
/** A JSON line with `raw`, canonical JSON text kept byte for byte, as its last member. */
const withRaw = (fields: object, name: string, raw: string | null) =>
  `${JSON.stringify(fields).slice(0, -1)},${JSON.stringify(name)}:${raw ?? 'null'}}`;
const at = (value: unknown, snapshot = true) => snapshot ? instant(value) : null;
const integer = (value: unknown) => value === null || value === undefined ? null : Number(value);

const SECTIONS: Record<typeof exportSections[number], Section> = {
  // Identifiers, times and grants only: no credential row holds secret material, and none is read. Grants have no
  // history (issuance adds them after the credential row, revocation removes them), and every change of them changes
  // the policy version, so this section is read first and only under the policy version the export was admitted under.
  permissions: { keys: 1, sql: `SELECT sc.credential_id AS k1,sc.principal_id,${utc('sc.created_at')} AS created_at,
      ${utc('sc.expires_at')} AS expires_at,sc.activated_at<=$2 AS activated,${utc('sc.activated_at')} AS activated_at,
      sc.confirmed_at<=$2 AS confirmed,${utc('sc.confirmed_at')} AS confirmed_at,sc.revoked_at<=$2 AS revoked,
      ${utc('sc.revoked_at')} AS revoked_at,
      COALESCE((SELECT json_agg(json_build_object('collectionId',g.collection_id,'capabilities',g.capabilities,
        'expiresAt',${utc('g.expires_at')}) ORDER BY g.collection_id) FROM collection_grants g
        WHERE g.space_id=sc.space_id AND g.credential_id=sc.credential_id),'[]') AS grants,256 AS size
    FROM space_credentials sc WHERE sc.space_id=$1 AND sc.created_at<=$2 AND AFTER(sc.credential_id) ORDER BY sc.credential_id`,
  line: r => JSON.stringify({ credentialId: r.k1, principalId: r.principal_id, createdAt: instant(r.created_at), expiresAt: instant(r.expires_at),
    activatedAt: at(r.activated_at, r.activated === true), confirmedAt: at(r.confirmed_at, r.confirmed === true),
    revokedAt: at(r.revoked_at, r.revoked === true),
    grants: (r.grants as Row[]).map(g => ({ collectionId: g.collectionId, capabilities: g.capabilities,
      expiresAt: instant(g.expiresAt) })) }) },
  schemas: { keys: 2, sql: `SELECT v.collection_id AS k1,v.version AS k2,${utc('v.accepted_at')} AS accepted_at,v.canonical_definition,
      octet_length(v.canonical_definition) AS size
    FROM collection_versions v WHERE v.space_id=$1 AND v.accepted_at<=$2 AND AFTER(v.collection_id,v.version)
    ORDER BY v.collection_id,v.version`,
  line: r => withRaw({ collectionId: r.k1, version: Number(r.k2), acceptedAt: instant(r.accepted_at) }, 'definition', r.canonical_definition) },
  retrieval: { keys: 2, sql: `SELECT p.collection_id AS k1,p.version AS k2,p.previous_version,p.record_fields,p.source_content,
      p.claim_statements,p.lexical,p.vector,p.text_search_config,p.processing_regions,p.credential_id,
      ${utc('p.created_at')} AS created_at,256 AS size
    FROM retrieval_policies p WHERE p.space_id=$1 AND p.created_at<=$2 AND AFTER(p.collection_id,p.version)
    ORDER BY p.collection_id,p.version`,
  line: r => JSON.stringify({ collectionId: r.k1, version: Number(r.k2), previousVersion: r.previous_version === null ? null : Number(r.previous_version),
    recordFields: r.record_fields, sourceContent: r.source_content, claimStatements: r.claim_statements, lexical: r.lexical,
    vector: r.vector, textSearchConfig: r.text_search_config, processingRegions: r.processing_regions, credentialId: r.credential_id,
    createdAt: instant(r.created_at) }) },
  // A source's original is its digest, size and type; its bytes and storage key are never in an export.
  sources: { keys: 2, sql: `SELECT s.collection_id AS k1,s.source_id AS k2,s.kind,s.locator,s.principal_id,s.credential_id,
      ${utc('s.created_at')} AS created_at,o.reference_only,o.sha256,o.byte_size,o.mime_type,${utc('o.captured_at')} AS captured_at,
      ${utc('o.observed_at')} AS observed_at,octet_length(s.locator) AS size
    FROM sources s LEFT JOIN original_objects o ON o.space_id=s.space_id AND o.collection_id=s.collection_id AND o.source_id=s.source_id
    WHERE s.space_id=$1 AND s.created_at<=$2 AND ${notDeleted('source', 's.collection_id', 's.source_id')}
      AND AFTER(s.collection_id,s.source_id) ORDER BY s.collection_id,s.source_id`,
  line: r => JSON.stringify({ collectionId: r.k1, sourceId: r.k2, kind: r.kind, locator: r.locator, principalId: r.principal_id,
    credentialId: r.credential_id, createdAt: instant(r.created_at), original: { referenceOnly: r.reference_only ?? true,
      sha256: r.sha256 ?? null, byteSize: r.byte_size === null || r.byte_size === undefined ? null : Number(r.byte_size),
      mimeType: r.mime_type ?? null, capturedAt: instant(r.captured_at), observedAt: instant(r.observed_at) } }) },
  extractions: { keys: 3, sql: `SELECT x.collection_id AS k1,x.source_id AS k2,x.version AS k3,x.previous_version,x.source_sha256,
      x.parser,x.parser_version,x.content,x.source_offsets::text AS source_offsets,x.credential_id,${utc('x.created_at')} AS created_at,
      octet_length(x.content)+octet_length(x.source_offsets::text) AS size
    FROM extraction_versions x WHERE x.space_id=$1 AND x.created_at<=$2 AND ${notDeleted('source', 'x.collection_id', 'x.source_id')}
      AND AFTER(x.collection_id,x.source_id,x.version) ORDER BY x.collection_id,x.source_id,x.version`,
  line: r => withRaw({ collectionId: r.k1, sourceId: r.k2, version: Number(r.k3),
    previousVersion: r.previous_version === null ? null : Number(r.previous_version), sourceSha256: r.source_sha256, parser: r.parser,
    parserVersion: r.parser_version, credentialId: r.credential_id, createdAt: instant(r.created_at), content: r.content },
  'sourceOffsets', r.source_offsets) },
  claims: { keys: 3, sql: `SELECT r.collection_id AS k1,r.claim_id AS k2,r.revision AS k3,c.kind,c.principal_id,
      ${utc('c.created_at')} AS created_at,r.previous_revision,r.statement,r.attributed_to,r.credential_id,r.recorded_by,
      ${utc('r.observed_at')} AS observed_at,${utc('r.valid_from')} AS valid_from,${utc('r.valid_until')} AS valid_until,
      r.review_status,r.reviewed_by,${utc('r.reviewed_at')} AS reviewed_at,${utc('r.committed_at')} AS committed_at,
      octet_length(r.statement) AS size
    FROM claim_revisions r JOIN claims c ON c.space_id=r.space_id AND c.collection_id=r.collection_id AND c.claim_id=r.claim_id
    WHERE r.space_id=$1 AND r.committed_at<=$2 AND ${notDeleted('claim', 'r.collection_id', 'r.claim_id')}
      AND AFTER(r.collection_id,r.claim_id,r.revision) ORDER BY r.collection_id,r.claim_id,r.revision`,
  line: r => JSON.stringify({ collectionId: r.k1, claimId: r.k2, revision: Number(r.k3), kind: r.kind, principalId: r.principal_id,
    createdAt: instant(r.created_at), previousRevision: r.previous_revision === null ? null : Number(r.previous_revision),
    statement: r.statement, attributedTo: r.attributed_to, credentialId: r.credential_id, recordedBy: r.recorded_by,
    observedAt: instant(r.observed_at), validFrom: instant(r.valid_from), validUntil: instant(r.valid_until),
    reviewStatus: r.review_status, reviewedBy: r.reviewed_by, reviewedAt: instant(r.reviewed_at),
    committedAt: instant(r.committed_at) }) },
  provenance: { keys: 4, sql: `SELECT e.collection_id AS k1,e.claim_id AS k2,e.revision AS k3,e.ordinal AS k4,e.source_collection_id,
      e.source_id,e.extraction_version,e.start_offset,e.end_offset,128 AS size
    FROM claim_evidence e JOIN claim_revisions r ON r.space_id=e.space_id AND r.collection_id=e.collection_id
      AND r.claim_id=e.claim_id AND r.revision=e.revision
    WHERE e.space_id=$1 AND r.committed_at<=$2 AND ${notDeleted('claim', 'e.collection_id', 'e.claim_id')}
      AND AFTER(e.collection_id,e.claim_id,e.revision,e.ordinal) ORDER BY e.collection_id,e.claim_id,e.revision,e.ordinal`,
  line: r => JSON.stringify({ collectionId: r.k1, claimId: r.k2, revision: Number(r.k3), ordinal: r.k4,
    // A whole-source citation has no extraction version and no offsets, a whole-extraction one no offsets: null as stored.
    source: { collectionId: r.source_collection_id, sourceId: r.source_id, extractionVersion: integer(r.extraction_version),
      startOffset: integer(r.start_offset), endOffset: integer(r.end_offset) } }) },
  // A link tombstoned after the snapshot was live at it, one revision earlier (a tombstone adds one).
  links: { keys: 2, sql: `SELECT l.collection_id AS k1,l.link_id AS k2,l.link_type,l.deletion_policy,l.from_kind,l.from_collection_id,
      l.from_id,l.to_kind,l.to_collection_id,l.to_id,l.credential_id,${utc('l.created_at')} AS created_at,
      l.revision-CASE WHEN l.tombstone THEN 1 ELSE 0 END AS revision,128 AS size
    FROM links l WHERE l.space_id=$1 AND l.created_at<=$2 AND (NOT l.tombstone OR l.tombstoned_at>$2)
      AND AFTER(l.collection_id,l.link_id) ORDER BY l.collection_id,l.link_id`,
  line: r => JSON.stringify({ collectionId: r.k1, linkId: r.k2, revision: Number(r.revision), linkType: r.link_type,
    deletionPolicy: r.deletion_policy, from: { kind: r.from_kind, collectionId: r.from_collection_id, id: r.from_id },
    to: { kind: r.to_kind, collectionId: r.to_collection_id, id: r.to_id }, credentialId: r.credential_id, createdAt: instant(r.created_at) }) },
  events: { keys: 4, sql: `SELECT v.collection_id AS k1,v.kind AS k2,v.entity_id AS k3,v.revision AS k4,v.event_id,v.operation,
      v.credential_id,${utc('v.committed_at')} AS committed_at,128 AS size
    FROM evidence_events v WHERE v.space_id=$1 AND v.committed_at<=$2 AND AFTER(v.collection_id,v.kind,v.entity_id,v.revision)
    ORDER BY v.collection_id,v.kind,v.entity_id,v.revision`,
  line: r => JSON.stringify({ eventId: r.event_id, collectionId: r.k1, kind: r.k2, entityId: r.k3, revision: Number(r.k4),
    operation: r.operation, credentialId: r.credential_id, committedAt: instant(r.committed_at) }) },
  // Each record at its highest revision published at or below the watermark (migration 049's as-of index, as STA-59
  // reads it); a record deleted there is passed with no line, one first written later is no candidate.
  // A record's key mode and normalized key are set when it is created and never change, so the record row states them
  // at any boundary; an external key is the record's identity to an importer.
  records: { keys: 2, sql: `SELECT r.collection_id AS k1,r.record_id AS k2,r.key_mode,r.normalized_key,e.revision,e.operation,
      e.schema_version,e.canonical_data,octet_length(COALESCE(e.canonical_data,''))+octet_length(r.normalized_key) AS size
    FROM records r CROSS JOIN LATERAL (SELECT f.revision FROM record_event_feed f WHERE f.space_id=r.space_id
      AND f.collection_id=r.collection_id AND f.record_id=r.record_id AND f.position<=$3 ORDER BY f.revision DESC LIMIT 1) a
    JOIN record_events e ON e.space_id=r.space_id AND e.collection_id=r.collection_id AND e.record_id=r.record_id
      AND e.revision=a.revision
    WHERE r.space_id=$1 AND AFTER(r.collection_id,r.record_id) ORDER BY r.collection_id,r.record_id`,
  line: r => r.operation === 'delete' ? '' : withRaw({ collectionId: r.k1, id: r.k2, keyMode: r.key_mode, key: r.normalized_key,
    revision: Number(r.revision), schemaVersion: Number(r.schema_version) }, 'data', r.canonical_data) },
  // Every record event published at or below the watermark, deletions included, with its feed position and the
  // record's key, so a record deleted by then (and so absent from records) keeps its external key.
  revisions: { keys: 3, sql: `SELECT e.collection_id AS k1,e.record_id AS k2,e.revision AS k3,e.event_id,e.operation,e.schema_version,
      e.canonical_data,e.credential_id,${utc('e.committed_at')} AS committed_at,f.position,r.key_mode,r.normalized_key,
      octet_length(COALESCE(e.canonical_data,''))+octet_length(r.normalized_key) AS size
    FROM record_events e JOIN record_event_feed f ON f.event_id=e.event_id
      JOIN records r ON r.space_id=e.space_id AND r.collection_id=e.collection_id AND r.record_id=e.record_id
    WHERE e.space_id=$1 AND f.position<=$3 AND AFTER(e.collection_id,e.record_id,e.revision)
    ORDER BY e.collection_id,e.record_id,e.revision`,
  line: r => withRaw({ collectionId: r.k1, id: r.k2, keyMode: r.key_mode, key: r.normalized_key, revision: Number(r.k3),
    eventId: r.event_id, position: Number(r.position),
    operation: r.operation, schemaVersion: Number(r.schema_version), credentialId: r.credential_id, committedAt: instant(r.committed_at) },
  'data', r.canonical_data) }
};

/** The next rows of `section` after `cursor`, at most `readRows` of them and, past the first, about `bytes` of lines. */
async function read(db: Session, job: Row, section: Section, cursor: unknown[] | null, bytes: number): Promise<Row[]> {
  const keys = Array.from({ length: section.keys }, (_, i) => `k${i + 1}`).join(',');
  // The snapshot instant as the database's own text, to the microsecond (a JavaScript Date keeps milliseconds only).
  const params: unknown[] = [job.space_id, job.snapshot, job.watermark];
  const sql = section.sql.replace(/AFTER\(([^)]*)\)/, (_, columns: string) => {
    if (cursor === null) return 'TRUE';
    const placeholders = cursor.map(value => `$${params.push(value)}`).join(',');
    return `(${columns})>(${placeholders})`;
  });
  const limit = `$${params.push(portabilityExportBounds.readRows)}`, budget = `$${params.push(bytes)}`;
  return (await db.query(`SELECT * FROM (SELECT x.*,sum(COALESCE(x.size,0)) OVER (ORDER BY ${keys}) AS running
      FROM (${sql.replace(/\$2(?!\d)/g, () => '$2::timestamptz')} LIMIT ${limit}) x) y
    WHERE y.running-COALESCE(y.size,0)<${budget} AND $2::timestamptz IS NOT NULL AND $3::bigint IS NOT NULL
    ORDER BY ${keys}`, params)).rows;
}

/** Cancelled, failed and expired exports are never read again: their parts go (migration 051 allows it once ended). */
async function discard(db: Session, key: unknown[]): Promise<void> {
  await db.query('DELETE FROM portability_parts WHERE space_id=$1 AND job_id=$2', key);
}

/** The snapshot instant as UTC RFC 3339 text to the microsecond, as the database stores it (a Date keeps milliseconds). */
const SNAPSHOT_AT = `${utc('j.created_at')} AS snapshot_at`;
// An admitted export no worker has claimed yet is still queued to its owner.
const STATUS = `SELECT j.*,${SNAPSHOT_AT},${utc('j.started_at')} AS started_text,${utc('j.finished_at')} AS finished_text,
    ${utc('j.expires_at')} AS expires_text,CASE WHEN j.state IN ('queued','running','completed') AND j.expires_at<=clock_timestamp() THEN 'expired'
    WHEN j.state='running' AND j.attempts=0 THEN 'queued' ELSE j.state END AS effective,
    (SELECT count(*) FROM portability_parts p WHERE p.space_id=j.space_id AND p.job_id=j.job_id)::int AS parts_written
  FROM portability_jobs j WHERE j.space_id=$1 AND j.job_id=$2 AND j.kind='export'`;
function view(row: Row): PortabilityExportStatus {
  const sealed = row.effective === 'completed' ? { sha256: row.manifest_sha256 as string, partCount: Number(row.part_count) } : null;
  const checkpoint = row.checkpoint ?? {};
  return { jobId: row.job_id, kind: 'export', state: row.effective, failureCode: row.failure_code ?? null,
    boundary: { spaceId: row.space_id, watermark: Number(row.watermark), snapshotAt: row.snapshot_at, records: 'as-of-watermark',
      evidence: 'as-of-snapshot', policyVersion: Number(row.policy_version), placementGeneration: Number(row.placement_generation),
      formatVersion: Number(row.format_version) },
    progress: { section: row.state === 'completed' ? null : exportSections[checkpoint.section ?? 0] ?? null,
      partsWritten: Number(row.parts_written ?? 0), attempts: Number(row.attempts), runtimeMs: Number(checkpoint.runtimeMs ?? 0) },
    budgets: { bytes: portabilityExportBounds.budgetBytes, parts: portabilityExportBounds.maxParts,
      runtimeMs: portabilityExportBounds.budgetRuntimeMs },
    // Migration 051 stamps started_at when the export first runs, which is its admission: shown once a worker has claimed it.
    createdAt: row.snapshot_at, startedAt: Number(row.attempts) > 0 ? instant(row.started_text) : null,
    finishedAt: instant(row.finished_text), expiresAt: row.expires_text,
    manifest: sealed, complete: sealed !== null };
}

/**
 * The space as a job reads it, or why it no longer may: NOT_FOUND without
 * it, SPACE_UNAVAILABLE unless active or read-only, STALE_PLACEMENT once moved
 * (`placement`), FORBIDDEN if `principal` no longer owns it, and
 * POLICY_CHANGED once its policy version is no longer `policy` (a request's
 * own, or an export's while it reads permissions). Locked (share by default),
 * as every reader and writer of the space locks it, so none of this changes
 * while the transaction runs.
 */
async function spaceCheck(db: Session, spaceId: string, expect: { principal: string; placement: number; policy?: number },
  lock = 'FOR SHARE'): Promise<string | null> {
  const row = (await db.query(`SELECT lifecycle,policy_version,placement_generation,owner_principal_id FROM spaces WHERE space_id=$1 ${lock}`,
    [spaceId])).rows[0];
  if (!row) return 'NOT_FOUND';
  if (row.lifecycle !== 'active' && row.lifecycle !== 'readOnly') return 'SPACE_UNAVAILABLE';
  if (Number(row.placement_generation) !== expect.placement) return 'STALE_PLACEMENT';
  if (row.owner_principal_id !== expect.principal) return 'FORBIDDEN';
  if (expect.policy !== undefined && Number(row.policy_version) !== expect.policy) return 'POLICY_CHANGED';
  return null;
}

/**
 * Owner exports of a whole space (docs/portability-export.md): submission,
 * status, cancellation and part retrieval. Submission holds the space's
 * writes while it publishes every collection's pending record events and pins
 * the watermark and snapshot instant together, so the records as of the one
 * and the evidence as of the other are the same state. The jobs Worker's
 * snapshot step (`PostgresAnalysisWorker`) writes the parts. Every call
 * authorizes the owner again, and a part is released only while the owner's
 * credential is still current once COMMIT is acknowledged.
 */
export class PostgresPortabilityExports {
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, { pool: PoolLike }>) {}

  private pool(cellId: string): PoolLike {
    const cell = this.cells.get(cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return cell.pool;
  }

  /** The owner session admitted to the space; an agent key is never one. */
  private async owner(actor: VerifiedCredential, spaceId: string) {
    const admitted = await this.spaces.scope(actor, spaceId, undefined, 'export:read');
    if (actor.kind !== 'session' || admitted.scope.principalId !== admitted.ownerPrincipalId)
      throw new AuthorityError('FORBIDDEN', 'Only the space owner exports a space');
    return admitted;
  }

  private async recheck(db: Db, actor: VerifiedCredential, admitted: Awaited<ReturnType<PostgresPortabilityExports['owner']>>):
    Promise<Deadline> {
    return finalCheck(this.spaces, db, actor, admitted.ownerPrincipalId, admitted.scope as AuthorityScope, 'export:read');
  }

  /**
   * Export the space as of a boundary pinned now. Writes to the space wait
   * while the boundary is pinned (a busy space is retryable BACKPRESSURE); a
   * space with 2 unfinished or 4 held exports, or more unpublished record
   * events than 20 rounds publish, is refused with retryable BACKPRESSURE. A
   * submission whose admission was sent but not acknowledged, or acknowledged
   * after its access expired once a worker had claimed the export, throws
   * `ExportAdmissionUnconfirmed` (a `CommitOutcomeUnknownError`, never
   * retryable), whose `jobId` names the export.
   */
  async submit(actor: VerifiedCredential, spaceId: string): Promise<PortabilityExportStatus> {
    const admitted = await this.owner(actor, spaceId);
    const pool = this.pool(admitted.cellId), scope = admitted.scope;
    for (let round = 0; round < portabilityExportBounds.publishRounds; round++) {
      const submitted = await transact(pool, async db => {
        // Every writer share-locks the space first: this waits for those in flight and holds new ones until COMMIT, so
        // every write is wholly before the boundary (published, stamped before the snapshot instant) or after it.
        const refused = await spaceCheck(db, spaceId, { principal: scope.principalId, placement: scope.placementGeneration,
          policy: scope.policyVersion }, 'FOR NO KEY UPDATE');
        if (refused && refused !== 'NOT_FOUND' && refused !== 'SPACE_UNAVAILABLE') throw new AuthorityError('FORBIDDEN', 'Policy or placement changed');
        if (refused) throw new AuthorityError(refused);
        // Held: unfinished or completed, so its parts are still stored, until a worker or a cancellation ends it and
        // removes them (past its expiry too). One never admitted holds nothing.
        const { active, held } = (await db.query(`SELECT count(*) FILTER (WHERE j.state IN ${UNFINISHED}
            AND j.expires_at>clock_timestamp())::int AS active,count(*)::int AS held FROM portability_jobs j
          WHERE j.space_id=$1 AND j.kind='export' AND (j.state='completed' OR (j.state IN ${UNFINISHED} AND NOT ${UNADMITTED}))`,
        [spaceId])).rows[0];
        if (active >= portabilityExportBounds.activePerSpace || held >= portabilityExportBounds.heldPerSpace)
          throw new AuthorityError('BACKPRESSURE', `The space holds ${held} exports, ${active} of them unfinished; retry later`,
            undefined, true);
        const collections = (await db.query('SELECT collection_id FROM collections WHERE space_id=$1 ORDER BY collection_id',
          [spaceId])).rows.map(row => row.collection_id as string);
        let left = portabilityExportBounds.publishBatch;
        for (const collectionId of collections) {
          left -= await publish(db, { spaceId: scope.spaceId, collectionId: collectionId as AuthorityScope['collectionId'] }, left);
          // A full round may leave more to publish: commit it and go again, so a backlog drains across rounds.
          if (left <= 0) return null;
        }
        const watermark = (await db.query(`SELECT COALESCE(max(m.position),0)::text AS w FROM collections c
          CROSS JOIN LATERAL (SELECT f.position FROM record_event_feed f WHERE f.space_id=c.space_id AND f.collection_id=c.collection_id
            ORDER BY f.position DESC LIMIT 1) m WHERE c.space_id=$1`, [spaceId])).rows[0].w;
        // Migration 051 stamps created_at with the database clock: the snapshot instant every evidence section is read at.
        const jobId = `exp_${randomUUID()}`;
        await db.query(`INSERT INTO portability_jobs(space_id,job_id,kind,principal_id,credential_id,policy_version,placement_generation,
            format_version,watermark,expires_at) VALUES($1,$2,'export',$3,$4,$5,$6,$7,$8::bigint,
            clock_timestamp()+$9::int*interval '1 millisecond')`,
        [spaceId, jobId, scope.principalId, actor.credentialId, scope.policyVersion, scope.placementGeneration,
          portabilityFormatVersion, watermark, portabilityExportBounds.lifetimeMs]);
        return view((await db.query(STATUS, [spaceId, jobId])).rows[0]);
      });
      if (!submitted) continue;
      // The final credential check runs after the hold is released, so writers never wait on the provider. The export
      // stays queued, which no worker runs, until the check's COMMIT is acknowledged with its access unexpired; a
      // refused or lapsed check cancels it here, before it could ever run.
      let deadline: Deadline;
      try {
        deadline = released(await transact(pool, async db => {
          const checked = await this.recheck(db, actor, admitted);
          return { value: checked, deadline: checked };
        }));
      } catch (error) {
        // The check changes nothing, so its unacknowledged COMMIT is a check that never answered: a definite refusal.
        throw await this.refusal(pool, spaceId, submitted.jobId, error instanceof CommitOutcomeUnknownError
          ? new AuthorityError('PROVIDER_UNAVAILABLE', 'The final credential check was not acknowledged; the export was not admitted',
            undefined, true) : error);
      }
      // The admission commits while that access is still unexpired, or not at all. It share-locks the space first, so a
      // submission counting the space's held exports waits for it, and the admission time is read under that lock.
      const lease = randomUUID();
      let admission: { rowCount: number | null };
      try {
        admission = await inTransaction(pool, async db => {
          await db.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR SHARE', [spaceId]);
          return db.query(`UPDATE portability_jobs j SET state='running',lease_id=$3,leased_until=clock_timestamp()
            WHERE j.space_id=$1 AND j.job_id=$2 AND NOT ${UNADMITTED} AND j.state='queued'`, [spaceId, submitted.jobId, lease]);
        }, { deadline: Math.min(Date.now() + deadline.monotonic - performance.now(),
          deadline.wallUntil, Date.now() + portabilityExportBounds.admissionMs) });
      } catch (error) {
        // Sent but unacknowledged, the admission may have committed: the caller reads or cancels the export it names.
        if (error instanceof CommitOutcomeUnknownError) throw Object.assign(error, { jobId: submitted.jobId });
        throw await this.refusal(pool, spaceId, submitted.jobId, cutShort(error)
          ? new AuthorityError('FORBIDDEN', 'Access expired before the export was admitted') : error);
      }
      if (!admission.rowCount)
        throw await this.refusal(pool, spaceId, submitted.jobId,
          new AuthorityError('BACKPRESSURE', 'The export was not admitted in time; submit again', undefined, true));
      // Acknowledged, but only a reply the access still covers is released (a stalled process may outlive it).
      try { return released({ value: submitted, deadline }); }
      catch (expired) { throw await this.withdrawal(pool, spaceId, submitted.jobId, lease, expired); }
    }
    throw new AuthorityError('BACKPRESSURE', 'The space has more unpublished events than one submission publishes; retry',
      undefined, true);
  }

  /** Cancel a refused submission's export, still queued, so never run and without parts: returns the error to throw. */
  private async refusal(pool: PoolLike, spaceId: string, jobId: string, error: unknown): Promise<unknown> {
    try {
      await transact(pool, db => db.query(`UPDATE portability_jobs SET state='cancelled' WHERE space_id=$1 AND job_id=$2
        AND state='queued'`, [spaceId, jobId]));
      return error;
    } catch (cleanup) {
      // Still queued: never run, and cancelled by a worker once its admission time passes.
      return new AggregateError([error, cleanup], 'The export was refused and could not be cancelled at once', { cause: cleanup });
    }
  }

  /**
   * Withdraw an admission acknowledged only after its access expired: cancelled while it still holds the admission's
   * lease (no worker has claimed it, so it has no parts), the call refused with `expired`; otherwise, or if that cannot
   * be done, an `ExportAdmissionUnconfirmed` naming the export, which may run.
   */
  private async withdrawal(pool: PoolLike, spaceId: string, jobId: string, lease: string, expired: unknown): Promise<unknown> {
    const withdrawn = await transact(pool, async db => (await db.query(`UPDATE portability_jobs SET state='cancelled'
      WHERE space_id=$1 AND job_id=$2 AND state='running' AND lease_id=$3`, [spaceId, jobId, lease])).rowCount)
      .catch((error: unknown) => error);
    if (withdrawn === 1) return expired;
    return Object.assign(new CommitOutcomeUnknownError(withdrawn instanceof Error ? withdrawn : expired), { jobId });
  }

  /** The export's state, progress and boundary, and its manifest digest once complete. */
  status(actor: VerifiedCredential, spaceId: string, jobId: string): Promise<PortabilityExportStatus> {
    return this.access(actor, spaceId, jobId, async (db, key) => view((await db.query(STATUS, key)).rows[0]));
  }

  /**
   * Cancel a queued or running export: it ends cancelled and its parts are
   * removed at once; a worker writing a part meanwhile finishes it first and
   * then finds the export ended. One past its expiry ends expired instead. A
   * completed or ended export is reported as it is.
   */
  cancel(actor: VerifiedCredential, spaceId: string, jobId: string): Promise<PortabilityExportStatus> {
    return this.access(actor, spaceId, jobId, async (db, key) => {
      const job = (await db.query(`SELECT state,expires_at<=clock_timestamp() AS lapsed FROM portability_jobs
        WHERE space_id=$1 AND job_id=$2 FOR UPDATE`, key)).rows[0];
      const end = (state: string) => db.query('UPDATE portability_jobs SET state=$3 WHERE space_id=$1 AND job_id=$2', [...key, state]);
      if (['queued', 'running', 'completed'].includes(job.state) && job.lapsed) { await end('expired'); await discard(db, key); }
      else if (job.state === 'queued' || job.state === 'running') { await end('cancelled'); await discard(db, key); }
      return view((await db.query(STATUS, key)).rows[0]);
    });
  }

  /**
   * Part `n` (1 to the manifest's part count; the last is the manifest) of a
   * complete, unexpired export. An export without its manifest is CONFLICT
   * (its state says why), a part outside it NOT_FOUND.
   */
  async part(actor: VerifiedCredential, spaceId: string, jobId: string, n: number): Promise<PortabilityExportPart> {
    if (!Number.isSafeInteger(n) || n < 1 || n > portabilityExportBounds.maxParts)
      throw new AuthorityError('INVALID_ARGUMENT', `part must be an integer from 1 to ${portabilityExportBounds.maxParts}`);
    return this.access(actor, spaceId, jobId, async (db, key) => {
      const status = view((await db.query(STATUS, key)).rows[0]);
      if (!status.manifest) throw new AuthorityError('CONFLICT', `The export has no complete result (state ${status.state})`);
      const part = (await db.query(`SELECT part_number,section,row_count,byte_size,content_sha256,content FROM portability_parts
        WHERE space_id=$1 AND job_id=$2 AND part_number=$3`, [...key, n])).rows[0];
      if (!part) throw new AuthorityError('NOT_FOUND', `The export has ${status.manifest.partCount} parts`);
      return { jobId, manifest: status.manifest, part: { number: part.part_number, section: part.section, rowCount: part.row_count,
        byteSize: part.byte_size, sha256: part.content_sha256, content: part.content } };
    });
  }

  /**
   * Authorize a read of one of the owner's exports: the directory and the
   * owner's credential, then the space share-locked under the request's
   * policy and placement, and, after `run`, the bounded final credential check
   * inside the same transaction, whose deadline must lie ahead once COMMIT is
   * acknowledged.
   */
  private async access<T>(actor: VerifiedCredential, spaceId: string, jobId: string,
    run: (db: Db, key: string[]) => Promise<T>): Promise<T> {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new AuthorityError('NOT_FOUND');
    const admitted = await this.owner(actor, spaceId), scope = admitted.scope;
    return released(await transact(this.pool(admitted.cellId), async db => {
      const refused = await spaceCheck(db, spaceId, { principal: scope.principalId, placement: scope.placementGeneration,
        policy: scope.policyVersion });
      if (refused && refused !== 'NOT_FOUND' && refused !== 'SPACE_UNAVAILABLE') throw new AuthorityError('FORBIDDEN', 'Policy or placement changed');
      if (refused) throw new AuthorityError(refused);
      const key = [spaceId, jobId];
      const job = (await db.query(`SELECT principal_id FROM portability_jobs WHERE space_id=$1 AND job_id=$2 AND kind='export'`, key)).rows[0];
      if (!job || job.principal_id !== scope.principalId) throw new AuthorityError('NOT_FOUND');
      const value = await run(db, key);
      return { value, deadline: await this.recheck(db, actor, admitted) };
    }));
  }
}

/**
 * A submission authorized and released whose admission was sent but not
 * acknowledged (the export either runs or, never admitted, is cancelled unrun
 * once its admission time passes), or was acknowledged after its access
 * expired and could not be withdrawn (the export may run). Read or cancel it
 * by `jobId`; submitting again starts another export.
 */
export interface ExportAdmissionUnconfirmed extends CommitOutcomeUnknownError { jobId: string }

// ---- The jobs Worker's export step ----

/** An export failure the step records: the job ends failed with `code`. */
class ExportFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
/** Migration 051's guards that refuse an export's write only because its expiry or its lease passed meanwhile. */
const TIMED = new Set(['portability_jobs_expiry', 'portability_parts_job']);
const timed = (error: unknown) => TIMED.has((error as { constraint?: unknown } | null)?.constraint as string);
/** A part error every retry would meet again (as STA-59 settles a page error), or null for one a later step may not. */
function settled(error: unknown): string | null {
  if (error instanceof ExportFailure) return error.code;
  if (timed(error)) return null;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^(22|23|54)[0-9A-Z]{3}$/.test(code)) return 'UNPROCESSABLE';
  return error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 'UNPROCESSABLE' : null;
}
const pk = (job: Row) => [job.space_id, job.job_id];
interface Checkpoint { section: number; cursor: unknown[] | null; offset: number; runtimeMs: number }

/**
 * The export half of the snapshot job step (docs/portability-export.md#worker),
 * run by `PostgresAnalysisWorker.step` on the jobs Worker's one connection:
 * it ends exports past their expiry, then claims due exports one at a time
 * (queued, or running with a lapsed lease; least recently run first) and
 * writes their parts under a 30 s lease, one part per transaction, as STA-59
 * writes pages: the space share-locked and its binding checked, the job
 * locked at its exact lease, the next rows of the current section read after
 * the checkpoint, and the part committed with the checkpoint. An interruption
 * rolls back that part only and a later claim continues from the checkpoint,
 * writing the same parts. When no section has rows left, the manifest part
 * seals the export.
 */
export class PortabilityExportWorker {
  /** `budgetBytes`, each export's byte budget, its manifest included (a smaller one only to exercise that bound). */
  constructor(private readonly pool: PoolLike, private readonly budgetBytes: number = portabilityExportBounds.budgetBytes) {}

  /**
   * When the export the claim takes next began waiting (epoch ms): admitted, since its admission or its lease's end,
   * unless another transaction holds its row or its space locked. Null when none is due.
   */
  async waiting(until: number): Promise<number | null> {
    const since = (await inTransaction(this.pool, async db => (await probing(db)).query(`SELECT (extract(epoch FROM
        (SELECT x.leased_until FROM (SELECT j.leased_until FROM portability_jobs j JOIN spaces s ON s.space_id=j.space_id
          WHERE ${CLAIMABLE} ORDER BY j.leased_until,j.created_at,j.job_id LIMIT 1 FOR SHARE OF j,s SKIP LOCKED) x))*1000)::float8 AS since`),
    { deadline: until })).rows[0].since;
    return since === null ? null : Number(since);
  }

  /** End expired and never admitted exports, then write parts until `until`. */
  async step(until: number, result: PortabilityStep = { expired: 0, claimed: 0, parts: 0, completed: 0, failed: 0, unadmitted: 0 }):
    Promise<PortabilityStep> {
    try { await this.expire(until, result); } catch (error) { if (!cutShort(error)) throw error; }
    return this.turn(until, result);
  }

  /** Claim due exports and write their parts until `until`, ending none (the snapshot step ends them in a slice of its own). */
  async turn(until: number, result: PortabilityStep): Promise<PortabilityStep> {
    const passed: string[] = [];
    while (until - RELEASE_MS - Date.now() >= MIN_PART_MS) {
      let job: Row | null | 'busy' | 'failed';
      try { job = await this.claim(until - RELEASE_MS, passed); } catch (error) { if (cutShort(error)) break; throw error; }
      if (job === null) break;
      if (job === 'failed') result.failed++;
      if (job === 'busy' || job === 'failed') continue;
      result.claimed++;
      await this.run(job, until, result);
    }
    return result;
  }

  /**
   * End exports past their expiry (`expired`) and those never admitted
   * (`cancelled`), one per transaction, removing their parts. A submission
   * admitting its export holds it locked, so is never cancelled under it.
   */
  async expire(until: number, result: PortabilityStep): Promise<void> {
    while (Date.now() < until) {
      const ended = await inTransaction(this.pool, async db => {
        const due = (await db.query(`SELECT j.space_id,j.job_id,j.expires_at<=clock_timestamp() AS expired FROM portability_jobs j
          WHERE ${ENDING} ORDER BY least(j.expires_at,j.created_at) LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (!due) return null;
        await db.query(`UPDATE portability_jobs SET state=$3 WHERE space_id=$1 AND job_id=$2`,
          [...pk(due), due.expired ? 'expired' : 'cancelled']);
        await discard(db, pk(due));
        return due.expired ? 'expired' : 'unadmitted';
      }, { deadline: until });
      if (!ended) return;
      result[ended]++;
    }
  }

  /**
   * Claim the next due export not passed over in this step and whose space no other transaction holds locked: null
   * when none, `busy` when taken or locked meanwhile, `failed` when its binding failed it.
   */
  private async claim(until: number, passed: string[]): Promise<Row | null | 'busy' | 'failed'> {
    // Only admitted exports: running (from admission or a lost lease) with their lease ended. A queued one is never run.
    // As the probe does, it passes over one whose row or space is locked; a table held locked past the lock bound leaves none.
    const next = (await inTransaction(this.pool, async db => (await probing(db)).query(`SELECT j.space_id,j.job_id
      FROM portability_jobs j JOIN spaces s ON s.space_id=j.space_id
      WHERE ${CLAIMABLE} AND NOT j.job_id=ANY($1::text[]) ORDER BY j.leased_until,j.created_at,j.job_id LIMIT 1
      FOR SHARE OF j,s SKIP LOCKED`, [passed]), { deadline: until })
      .catch((error: unknown) => { if (lockedOut(error)) return { rows: [] }; throw error; })).rows[0];
    if (!next) return null;
    passed.push(next.job_id);
    return inTransaction(this.pool, async db => {
      await probing(db);
      const job = (await db.query('SELECT * FROM portability_jobs WHERE space_id=$1 AND job_id=$2', pk(next))).rows[0];
      if (!job) return 'busy' as const;
      const failure = await spaceCheck(db, job.space_id, { principal: job.principal_id, placement: Number(job.placement_generation) });
      const locked = (await db.query(`SELECT *,least(clock_timestamp()+$3::int*interval '1 millisecond',expires_at) AS until
        FROM portability_jobs WHERE space_id=$1 AND job_id=$2
          AND state='running' AND leased_until<=clock_timestamp() AND expires_at>clock_timestamp()
        FOR UPDATE SKIP LOCKED`, [...pk(next), portabilityExportBounds.leaseMs])).rows[0];
      if (!locked) return 'busy' as const;
      if (failure) { await this.fail(db, locked, failure); return 'failed' as const; }
      return (await db.query(`UPDATE portability_jobs SET state='running',lease_id=$3,leased_until=$4,attempts=attempts+1
        WHERE space_id=$1 AND job_id=$2 RETURNING *`, [...pk(locked), randomUUID(), locked.until])).rows[0];
    }, { deadline: until }).catch((error: unknown) => {
      // A space changing meanwhile refuses the claim: retry later.
      const code = (error as { code?: unknown }).code;
      if (code === '55P03' || code === '23514' || code === '40001') return 'busy' as const;
      throw error;
    });
  }

  /** Write the claimed export's parts until it ends, its lease is lost or the budget ends; then give the lease back. */
  private async run(claimed: Row, until: number, result: PortabilityStep): Promise<void> {
    try {
      while (until - RELEASE_MS - Date.now() >= MIN_PART_MS) {
        let outcome: 'part' | 'completed' | 'failed' | 'expired' | 'lost';
        try { outcome = await inTransaction(this.pool, db => this.part(db, claimed), { deadline: until - RELEASE_MS }); }
        catch (error) { if (cutShort(error)) break; throw error; }
        if (outcome === 'part') { result.parts++; continue; }
        if (outcome === 'completed') result.completed++;
        if (outcome === 'failed') result.failed++;
        if (outcome === 'expired') result.expired++;
        return;
      }
    } finally {
      // Its lease ends now, so the export is due again at once. A failure here only leaves the lease to lapse.
      await inTransaction(this.pool, db => db.query(`UPDATE portability_jobs SET leased_until=clock_timestamp()
        WHERE space_id=$1 AND job_id=$2 AND state='running' AND lease_id=$3 AND leased_until>clock_timestamp()`,
      [...pk(claimed), claimed.lease_id]), { deadline: until }).catch(() => {});
    }
  }

  private async fail(db: Session, job: Row, code: string): Promise<void> {
    await db.query(`UPDATE portability_jobs SET state='failed',failure_code=$3 WHERE space_id=$1 AND job_id=$2`, [...pk(job), code]);
    await discard(db, pk(job));
  }

  /** One part of the export under its exact lease, committed with its checkpoint; or its manifest once no row is left. */
  private async part(db: Session, claimed: Row): Promise<'part' | 'completed' | 'failed' | 'expired' | 'lost'> {
    const started = Date.now(), key = pk(claimed);
    // Until permissions are read, a policy change (a key issued or revoked, which adds or removes grants) fails the export.
    const reading = (await db.query('SELECT checkpoint FROM portability_jobs WHERE space_id=$1 AND job_id=$2', key)).rows[0];
    const permissions = ((reading?.checkpoint as Checkpoint | null)?.section ?? 0) <= exportSections.indexOf('permissions');
    const failure = await spaceCheck(db, claimed.space_id, { principal: claimed.principal_id,
      placement: Number(claimed.placement_generation), policy: permissions ? Number(claimed.policy_version) : undefined });
    const job = (await db.query(`SELECT j.*,j.created_at::text AS snapshot,${SNAPSHOT_AT},least(clock_timestamp()+$4::int*interval '1 millisecond',expires_at) AS until
      FROM portability_jobs j WHERE space_id=$1 AND job_id=$2 AND state='running' AND lease_id=$3
        AND leased_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,
    [...key, claimed.lease_id, portabilityExportBounds.leaseMs])).rows[0];
    if (!job) return 'lost';
    if (failure) { await this.fail(db, job, failure); return 'failed'; }
    await db.query('SET LOCAL max_parallel_workers_per_gather = 0');
    await db.query('UPDATE portability_jobs SET leased_until=$3 WHERE space_id=$1 AND job_id=$2', [...key, job.until]);
    await db.query('SAVEPOINT export_part');
    try {
      return await this.advance(db, job, started);
    } catch (error) {
      const code = settled(error);
      if (code === null && !timed(error)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT export_part');
      // The job's clock decides first, as STA-59's does: expired past its expiry, left to a later claim past its lease.
      const clock = (await db.query(`SELECT expires_at<=clock_timestamp() AS expired,leased_until<=clock_timestamp() AS lapsed
        FROM portability_jobs WHERE space_id=$1 AND job_id=$2`, key)).rows[0];
      if (clock.expired) {
        await db.query(`UPDATE portability_jobs SET state='expired' WHERE space_id=$1 AND job_id=$2`, key);
        await discard(db, key);
        return 'expired';
      }
      if (clock.lapsed || code === null) return 'lost';
      await this.fail(db, job, code);
      return 'failed';
    }
  }

  private async advance(db: Session, job: Row, started: number): Promise<'part' | 'completed'> {
    const key = pk(job);
    let { section, cursor, offset, runtimeMs }: Checkpoint = job.checkpoint ?? { section: 0, cursor: null, offset: 0, runtimeMs: 0 };
    const last = (await db.query(`SELECT count(*)::int AS parts,COALESCE(sum(byte_size),0)::bigint AS bytes FROM portability_parts
      WHERE space_id=$1 AND job_id=$2`, key)).rows[0];
    const save = async () => {
      runtimeMs += Math.max(0, Date.now() - started);
      if (runtimeMs > portabilityExportBounds.budgetRuntimeMs) throw new ExportFailure('BUDGET_EXCEEDED', 'The export ran past its runtime budget');
      await db.query('UPDATE portability_jobs SET checkpoint=$3::jsonb WHERE space_id=$1 AND job_id=$2',
        [...key, JSON.stringify({ section, cursor, offset, runtimeMs })]);
    };
    const write = async (name: string, rows: number, content: string) => {
      await db.query(`INSERT INTO portability_parts(space_id,job_id,kind,part_number,section,row_count,byte_size,content_sha256,content)
        VALUES($1,$2,'export',$3,$4,$5,$6,$7,$8)`, [...key, last.parts + 1, name, rows, Buffer.byteLength(content), sha256(content), content]);
    };
    for (; section < exportSections.length; section++, cursor = null, offset = 0) {
      const definition = SECTIONS[exportSections[section]];
      const rows = await read(db, job, definition, cursor, offset + portabilityExportBounds.partBytes);
      if (!rows.length) continue;
      // The section's NDJSON from where its last part stopped: `offset` bytes into the first row's line.
      const lines = rows.map(row => { const line = definition.line(row); return Buffer.from(line ? `${line}\n` : '', 'utf8'); });
      const whole = Buffer.concat(lines);
      if (offset >= lines[0].length && offset > 0) throw new ExportFailure('UNPROCESSABLE', 'The export changed under its checkpoint');
      let end = Math.min(whole.length, offset + portabilityExportBounds.partBytes);
      // A line may continue into the next part, but a part never splits a character.
      while (end < whole.length && (whole[end] & 0xc0) === 0x80) end--;
      let done = -1, completed = 0, doneEnd = 0, position = 0;
      for (const [i, line] of lines.entries()) {
        position += line.length;
        if (position > end) break;
        done = i; doneEnd = position;
        if (line.length) completed++;
      }
      const content = whole.subarray(offset, end).toString('utf8');
      if (content) {
        if (last.parts + 1 >= portabilityExportBounds.maxParts)
          throw new ExportFailure('RESULT_TOO_LARGE', `More than ${portabilityExportBounds.maxParts - 1} parts`);
        if (Number(last.bytes) + Buffer.byteLength(content) > this.budgetBytes)
          throw new ExportFailure('BUDGET_EXCEEDED', 'The export exceeds its byte budget');
        await write(exportSections[section], completed, content);
      }
      if (done >= 0) cursor = Array.from({ length: definition.keys }, (_, i) => rows[done][`k${i + 1}`]);
      offset = end - doneEnd;
      await save();
      return 'part';
    }
    // No section has rows left: the manifest, its last part, seals the export with every part's digest.
    const parts = (await db.query(`SELECT part_number,section,row_count,byte_size,content_sha256 FROM portability_parts
      WHERE space_id=$1 AND job_id=$2 ORDER BY part_number`, key)).rows;
    const space = (await db.query('SELECT owner_principal_id FROM spaces WHERE space_id=$1', [job.space_id])).rows[0];
    const manifest: ExportManifest = { format: portabilityFormat,
      formatVersion: Number(job.format_version) as typeof portabilityFormatVersion, jobId: job.job_id,
      space: { spaceId: job.space_id, ownerPrincipalId: space.owner_principal_id, policyVersion: Number(job.policy_version),
        placementGeneration: Number(job.placement_generation) },
      boundary: { watermark: Number(job.watermark), snapshotAt: job.snapshot_at, records: 'as-of-watermark', evidence: 'as-of-snapshot' },
      sections: exportSections.map(name => {
        const own = parts.filter(p => p.section === name);
        return { name, rows: own.reduce((n, p) => n + p.row_count, 0), bytes: own.reduce((n, p) => n + p.byte_size, 0), accelerator: false };
      }),
      parts: parts.map(p => ({ number: p.part_number, section: p.section, rows: p.row_count, bytes: p.byte_size, sha256: p.content_sha256 })),
      excluded: EXCLUDED };
    const text = JSON.stringify(manifest);
    // The byte budget holds the manifest too: an export whose manifest would pass it fails rather than seal over it.
    if (Number(last.bytes) + Buffer.byteLength(text) > this.budgetBytes)
      throw new ExportFailure('BUDGET_EXCEEDED', 'The export and its manifest exceed its byte budget');
    await write('manifest', 1, text);
    await save();
    await db.query(`UPDATE portability_jobs SET state='completed',manifest_sha256=$3,part_count=$4 WHERE space_id=$1 AND job_id=$2`,
      [...key, sha256(text), parts.length + 1]);
    return 'completed';
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, AuthorityTransaction, CommitOutcomeUnknownError, predicateFilter } from './index.js';
import type { AuthorityScope } from './index.js';
import { admit, aggregationBounds, analyticalSlots, declarations, describe, formatGroups, jsonBytes, parse, recheckWithin,
  statement, zones } from './aggregations.js';
import type { Declared, Spec, ValueKind } from './aggregations.js';
import { bounded, DeadlineExceededError, inTransaction } from './faults.js';
import type { PoolLike, Session } from './faults.js';
import { scalarString, utcInstant } from './schema.js';
import { invalid, transact } from './sources.js';
import type { Db } from './sources.js';
import type { PostgresSpaces } from './spaces.js';
import { PortabilityExportWorker, removeNext } from './portability-exports.js';
import type { PortabilityStep } from './portability-exports.js';

/**
 * Protective bounds, with their evidence (or that a bound is structural and
 * not measured) in docs/analysis-measurements.md#limits (STA-60): per job, 10,000,000 records
 * scanned, 64 MiB of result pages, 600,000 ms of step time and a 24 h
 * lifetime; at most 8 unfinished jobs per space; pages of at most 1,000
 * records and 1 MiB (the page bound of migration 049); a 30 s lease,
 * extended by every page; event publication before pinning in rounds of
 * 5,000 events, at most 20 rounds per submission.
 */
export const analysisJobBounds = Object.freeze({ budgetRecords: 10_000_000, budgetBytes: 67_108_864, budgetRuntimeMs: 600_000,
  lifetimeMs: 86_400_000, activePerSpace: 8, pageRecords: 1_000, pageBytes: 1_048_576, maxPages: 10_000, leaseMs: 30_000,
  publishBatch: 5_000, publishRounds: 20, checkpointBytes: 1_048_576 });

export type AnalysisJobKind = 'aggregate' | 'export';
export type AnalysisJobState = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'expired';
/** The consistent boundary every page and the manifest of a job derive from. */
export interface AnalysisBoundary {
  spaceId: string; collectionId: string;
  /** The collection's records as of this event feed position: every write published at or below it, none after. */
  watermark: number; records: 'as-of-watermark';
  schemaVersion: number; policyVersion: number; placementGeneration: number; capability: Capability; specDigest: string;
}
/**
 * Whether a job's records are still the collection's, read when the status or
 * page is: `exact` when no write to the collection was published past the
 * watermark, none awaits publication and the schema version is the one
 * pinned, as of `checkedAt` (the reading statement's snapshot); otherwise
 * `stale`: the result is exact as of its watermark only, and later writes are
 * not in it. `latestPosition` is the collection's last published feed position
 * (0 before its first), `unpublished` whether committed events await
 * publication, `schemaVersion` the collection's current one.
 */
export interface AnalysisFreshness {
  state: 'exact' | 'stale'; checkedAt: string; latestPosition: number; unpublished: boolean; schemaVersion: number;
}
export interface AnalysisManifest { pageCount: number; rowCount: number; byteSize: number; resultSha256: string;
  format: 'application/x-ndjson' | 'application/json' }
export interface AnalysisJobStatus {
  jobId: string; kind: AnalysisJobKind; state: AnalysisJobState; failureCode: string | null;
  spec: unknown; boundary: AnalysisBoundary; freshness: AnalysisFreshness;
  progress: { recordsScanned: number; runtimeMs: number; attempts: number; pagesWritten: number };
  budgets: { records: number; bytes: number; runtimeMs: number };
  createdAt: string; startedAt: string | null; finishedAt: string | null; expiresAt: string;
  /** Present only once the manifest has sealed a complete result; pages without it are never a result. */
  manifest: AnalysisManifest | null;
  complete: boolean;
}
export interface AnalysisPage {
  jobId: string; boundary: AnalysisBoundary; freshness: AnalysisFreshness; manifest: AnalysisManifest;
  page: { number: number; rowOffset: number; rowCount: number; byteOffset: number; byteSize: number; sha256: string; content: string };
  complete: true;
}
export interface AnalysisStep { expired: number; claimed: number; pages: number; completed: number; failed: number;
  /** Owner space exports the same step advanced (docs/portability-export.md#worker). */
  exports: PortabilityStep }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver rows, read by column name
type Row = Record<string, any>;

const JOB_ID = /^anj_[0-9a-f-]{36}$/;
const ACTIVE = `('queued','running','cancelling','completed')`;
const MIN_PAGE_MS = 1_000;
/** A step's least budget: the jobs tick's own step minimum, enough for its expiry pass, a claim and a page. */
const MIN_STEP_MS = 2_000;
const RELEASE_MS = 500;
const iso = (value: Date | null) => value === null ? null : new Date(value).toISOString();
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const pk = (job: Row): string[] => [job.space_id, job.collection_id, job.job_id];
const cutShort = (error: unknown) => error instanceof DeadlineExceededError;


const STATUS = `SELECT j.*,CASE WHEN j.state IN ${ACTIVE} AND j.expires_at<=clock_timestamp() THEN 'expired' ELSE j.state END AS effective,
    (SELECT count(*) FROM analysis_result_pages p WHERE p.space_id=j.space_id AND p.collection_id=j.collection_id
      AND p.job_id=j.job_id)::int AS pages_written,
    m.page_count,m.row_count AS manifest_rows,m.byte_size AS manifest_bytes,m.result_sha256,
    (SELECT COALESCE(max(f.position),0) FROM record_event_feed f WHERE f.space_id=j.space_id
      AND f.collection_id=j.collection_id)::text AS latest_position,
    EXISTS (SELECT 1 FROM record_event_pending q WHERE q.space_id=j.space_id AND q.collection_id=j.collection_id) AS unpublished,
    (SELECT c.schema_version FROM collections c WHERE c.space_id=j.space_id AND c.collection_id=j.collection_id) AS current_schema_version,
    statement_timestamp() AS checked_at
  FROM analysis_jobs j LEFT JOIN analysis_result_manifests m
    ON m.space_id=j.space_id AND m.collection_id=j.collection_id AND m.job_id=j.job_id
  WHERE j.space_id=$1 AND j.collection_id=$2 AND j.job_id=$3`;

function boundary(row: Row): AnalysisBoundary {
  return { spaceId: row.space_id, collectionId: row.collection_id, watermark: Number(row.watermark), records: 'as-of-watermark',
    schemaVersion: Number(row.schema_version), policyVersion: Number(row.policy_version),
    placementGeneration: Number(row.placement_generation), capability: row.capability, specDigest: row.spec_digest };
}
/** The manifest of a sealed, unexpired result; null otherwise. */
function manifest(row: Row): AnalysisManifest | null {
  if (row.effective !== 'completed' || row.page_count === null || row.page_count === undefined) return null;
  return { pageCount: Number(row.page_count), rowCount: Number(row.manifest_rows), byteSize: Number(row.manifest_bytes),
    resultSha256: row.result_sha256, format: row.kind === 'export' ? 'application/x-ndjson' : 'application/json' };
}
/** The job's records against the collection's now (`STATUS` reads both in one statement). */
function freshness(row: Row): AnalysisFreshness {
  const latestPosition = Number(row.latest_position), schemaVersion = Number(row.current_schema_version);
  const exact = latestPosition <= Number(row.watermark) && row.unpublished === false && schemaVersion === Number(row.schema_version);
  return { state: exact ? 'exact' : 'stale', checkedAt: iso(row.checked_at)!, latestPosition, unpublished: row.unpublished === true,
    schemaVersion };
}
function view(row: Row): AnalysisJobStatus {
  const sealed = manifest(row);
  return { jobId: row.job_id, kind: row.kind, state: row.effective, failureCode: row.failure_code ?? null,
    spec: JSON.parse(row.canonical_spec), boundary: boundary(row), freshness: freshness(row),
    progress: { recordsScanned: Number(row.records_scanned), runtimeMs: Number(row.runtime_ms), attempts: Number(row.attempts),
      pagesWritten: Number(row.pages_written ?? 0) },
    budgets: { records: Number(row.budget_records), bytes: Number(row.budget_bytes), runtimeMs: Number(row.budget_runtime_ms) },
    createdAt: iso(row.created_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), expiresAt: iso(row.expires_at)!,
    manifest: sealed, complete: sealed !== null };
}

/**
 * When the caller's access lapses, as search states it: `monotonic`, the
 * earliest expiry on `performance.now()`'s clock, each measured from before
 * its read, and `wallUntil`, the provider credential's own absolute expiry
 * (Infinity when none), so a wall-clock step past it is caught too.
 */
export interface Deadline { monotonic: number; wallUntil: number }
const lapsed = (deadline: Deadline) => performance.now() >= deadline.monotonic || Date.now() >= deadline.wallUntil;
/** The final credential check's bound, STA-58's: its provider call and statement together. */
const RECHECK_MS = aggregationBounds.statementMs;

/**
 * The final credential check of a job transaction, after its last read:
 * the provider confirms the credential (a session or a key) with its expiry,
 * then, for a key, one statement against one clock reading confirms the
 * regional key and its grant of `capability` on the collection. Bounded as
 * STA-58's recheck: past `RECHECK_MS` the request fails with retryable
 * PROVIDER_UNAVAILABLE and rolls back, and a late provider answer runs no
 * statement. Returns the `Deadline` the caller requires unexpired once COMMIT
 * is acknowledged: locks fence revocation, not time.
 */
export async function finalCheck(spaces: PostgresSpaces, db: Db, actor: VerifiedCredential, ownerPrincipalId: string,
  scope: Readonly<AuthorityScope>, capability: Capability): Promise<Deadline> {
  await db.query(`SET LOCAL statement_timeout = '${RECHECK_MS}ms'`);
  let deadline: Deadline = { monotonic: -Infinity, wallUntil: -Infinity };
  await recheckWithin(RECHECK_MS, db, async session => {
    const started = performance.now(), wall = Date.now();
    const until = await spaces.assertCurrentUntil(actor, ownerPrincipalId);
    const provider = until === null ? Infinity : started + until - wall, wallUntil = until ?? Infinity;
    if (actor.kind !== 'api-key') { deadline = { monotonic: provider, wallUntil }; return; }
    const at = performance.now();
    // The latest-lasting grant holding the capability; the key's expiry is finite, so the earlier of the two is too.
    const row = (await session.query(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS now)
      SELECT EXTRACT(EPOCH FROM LEAST(sc.expires_at,g.until)-t.now)*1000 AS remaining_ms
      FROM t CROSS JOIN space_credentials sc
      CROSS JOIN LATERAL (SELECT max(COALESCE(g.expires_at,'infinity'::timestamptz)) AS until FROM collection_grants g
        JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
        WHERE g.space_id=sc.space_id AND g.credential_id=sc.credential_id AND g.collection_id=$4 AND $5::text=ANY(g.capabilities)
          AND c.lifecycle<>'deleted' AND (g.expires_at IS NULL OR g.expires_at>t.now)) g
      WHERE sc.space_id=$1 AND sc.credential_id=$2 AND sc.owner_principal_id=$3 AND sc.activated_at IS NOT NULL
        AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at>t.now AND g.until IS NOT NULL`,
    [scope.spaceId, actor.credentialId, ownerPrincipalId, scope.collectionId, capability])).rows[0];
    const remainingMs = Number(row?.remaining_ms);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new AuthorityError('FORBIDDEN');
    deadline = { monotonic: Math.min(provider, at + remainingMs), wallUntil };
  });
  return deadline;
}
/** A reply is released only while the access its final check relied on is unexpired, once COMMIT was acknowledged. */
export function released<T>({ value, deadline }: { value: T; deadline: Deadline }): T {
  if (lapsed(deadline)) throw new AuthorityError('FORBIDDEN', 'Access expired before the request committed');
  return value;
}

/** Remove an ended job's pages and manifest: cancelled, failed and expired results are never read again. */
async function discard(db: Session, key: unknown[]): Promise<void> {
  await db.query('DELETE FROM analysis_result_manifests WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', key);
  await db.query('DELETE FROM analysis_result_pages WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', key);
}

/**
 * Publish up to `limit` of the collection's pending events to its feed, under
 * the lock `events()` publishes under, so publications of one collection take
 * turns. One statement sees every pending event committed before it, so a
 * writer's events are published together or after the boundary pinned next.
 */
export async function publish(db: Session, scope: Readonly<Pick<AuthorityScope, 'spaceId' | 'collectionId'>>, limit: number): Promise<number> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [JSON.stringify([scope.spaceId, scope.collectionId])]);
  const published = await db.query(`WITH next AS (
      SELECT event_id,space_id,collection_id FROM record_event_pending WHERE space_id=$1 AND collection_id=$2
      ORDER BY committed_at,event_id LIMIT $3
    ), published AS (
      INSERT INTO record_event_feed(event_id,space_id,collection_id) SELECT event_id,space_id,collection_id FROM next
      ON CONFLICT DO NOTHING RETURNING event_id
    )
    DELETE FROM record_event_pending p USING published f WHERE p.event_id=f.event_id`, [scope.spaceId, scope.collectionId, limit]);
  return published.rowCount ?? 0;
}

/** The aggregate spec admitted as STA-58 admits one, with the declared kind of every field it names, as canonical JSON. */
async function aggregateSpec(db: Db, scope: Readonly<AuthorityScope>, serialized: unknown): Promise<string> {
  if (typeof serialized !== 'string' || serialized.length > aggregationBounds.specBytes ||
    Buffer.byteLength(serialized) > aggregationBounds.specBytes)
    invalid(`The spec must be JSON text of at most ${aggregationBounds.specBytes} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { invalid('The spec must be JSON text'); }
  const spec = await zones(db, parse(parsed, true));
  predicateFilter(scope, spec.where);
  const { declared } = await declarations(db, scope, spec);
  admit(spec, declared);
  // A dictionary without a prototype, so every field name, `__proto__` included, is its own entry.
  const fields: Record<string, ValueKind> = Object.create(null);
  for (const name of named(spec)) fields[name] = declared.get(name)!.kind;
  return JSON.stringify({ kind: 'aggregate', spec: { where: spec.where,
    groupBy: spec.groupBy.map(d => d.bucket ? { field: d.field, bucket: d.bucket } : { field: d.field }),
    metrics: spec.metrics.map(m => m.field === null ? { op: m.op } : { op: m.op, field: m.field }), maxGroups: spec.maxGroups }, fields });
}
/** Every field a spec groups, measures or filters, once each, in that order. */
function named(spec: Spec): string[] {
  return [...new Set([...spec.groupBy.map(d => d.field), ...spec.metrics.flatMap(m => m.field === null ? [] : [m.field]),
    ...spec.where.map(p => p.field)])];
}

/**
 * Snapshot analysis and export jobs: submission, status, cancellation and
 * bounded result retrieval (docs/analysis-jobs.md#jobs-sta-59). A submission pins
 * the collection's consistent boundary: it publishes the collection's pending
 * events, takes the feed's last position as the watermark and binds it, the
 * schema version, policy version, placement generation, credential and
 * capability to the job. `PostgresAnalysisWorker` computes the result as of
 * that watermark. Every read of a job, its status as much as its pages,
 * authorizes the caller again (directory, scope locks and a final credential
 * check, with the job's capability), so a revoked key or grant cuts off a
 * result already materialized. Only the job's own principal reads it, and an
 * agent key only through the credential that submitted it.
 */
export class PostgresAnalysisJobs {
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, { pool: PoolLike }>) {}

  private pool(cellId: string): PoolLike {
    const cell = this.cells.get(cellId);
    if (!cell) throw new AuthorityError('STALE_PLACEMENT');
    return cell.pool;
  }

  /**
   * Submit a job over `collectionId`: an `export` of its records (needs
   * `export:read`; takes no spec) or an `aggregate` of the STA-58 spec
   * `serialized` (needs `records:read`), both as of the watermark pinned now.
   * A space with 8 unfinished jobs, or a collection whose unpublished events
   * outnumber 20 rounds, is refused with retryable BACKPRESSURE (the rounds
   * published stay published).
   */
  async submit(actor: VerifiedCredential, spaceId: string, collectionId: string, kind: AnalysisJobKind,
    serialized?: string): Promise<AnalysisJobStatus> {
    if (kind !== 'aggregate' && kind !== 'export') invalid('kind must be aggregate or export');
    const capability: Capability = kind === 'export' ? 'export:read' : 'records:read';
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, capability);
    const pool = this.pool(admitted.cellId), scope = admitted.scope;
    for (let round = 0; round < analysisJobBounds.publishRounds; round++) {
      const submitted = await transact(pool, async db => {
        const tx = new AuthorityTransaction(db, scope, 1);
        try { await tx.checkScope(); } finally { tx.close(); }
        let canonical = JSON.stringify({ kind: 'export' });
        if (kind === 'export') { if (serialized !== undefined) invalid('An export takes no spec'); }
        else canonical = await aggregateSpec(db, scope, serialized);
        // Submissions to one space take turns, so the unfinished-job bound holds under concurrency.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [`analysis:${spaceId}`]);
        const active = (await db.query(`SELECT count(*)::int AS n FROM analysis_jobs WHERE space_id=$1
          AND state IN ('queued','running','cancelling') AND expires_at>clock_timestamp()`, [spaceId])).rows[0].n;
        if (active >= analysisJobBounds.activePerSpace)
          throw new AuthorityError('BACKPRESSURE', `The space has ${active} unfinished analysis jobs; retry later`, undefined, true);
        // A full round leaves more to publish: commit it and go again, so a backlog drains across rounds.
        if (await publish(db, scope, analysisJobBounds.publishBatch) >= analysisJobBounds.publishBatch) return null;
        const watermark = (await db.query(`SELECT COALESCE(max(position),0)::text AS w FROM record_event_feed
          WHERE space_id=$1 AND collection_id=$2`, [spaceId, collectionId])).rows[0].w;
        const inserted = (await db.query(`INSERT INTO analysis_jobs(space_id,collection_id,job_id,kind,principal_id,credential_id,
            capability,policy_version,placement_generation,schema_version,watermark,canonical_spec,spec_digest,budget_records,
            budget_bytes,budget_runtime_ms,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,c.schema_version,$10::bigint,$11,$12,$13,$14,$15,
            clock_timestamp()+$16::int*interval '1 millisecond'
          FROM collections c WHERE c.space_id=$1 AND c.collection_id=$2 RETURNING *`,
        [spaceId, collectionId, `anj_${randomUUID()}`, kind, scope.principalId, actor.credentialId, capability, scope.policyVersion,
          scope.placementGeneration, watermark, canonical, sha256(canonical), analysisJobBounds.budgetRecords,
          analysisJobBounds.budgetBytes, analysisJobBounds.budgetRuntimeMs, analysisJobBounds.lifetimeMs])).rows[0];
        return { value: view((await db.query(STATUS, [spaceId, collectionId, inserted.job_id])).rows[0]),
          deadline: await finalCheck(this.spaces, db, actor, admitted.ownerPrincipalId, scope, capability) };
      });
      if (submitted) return released(submitted);
    }
    throw new AuthorityError('BACKPRESSURE', 'The collection has more unpublished events than one submission publishes; retry',
      undefined, true);
  }

  /** The job's state, progress and boundary, and its manifest once complete. */
  status(actor: VerifiedCredential, spaceId: string, collectionId: string, jobId: string): Promise<AnalysisJobStatus> {
    return this.access(actor, spaceId, collectionId, jobId, async (db, key) => view((await db.query(STATUS, key)).rows[0]));
  }

  /**
   * Cancel a queued or running job: it ends cancelled at once (a running one
   * through cancelling), which releases its slots and removes its pages; a
   * worker writing a page meanwhile finishes it first and then finds the job
   * ended. A job past its expiry ends expired instead. A completed or ended
   * job is reported as it is.
   */
  cancel(actor: VerifiedCredential, spaceId: string, collectionId: string, jobId: string): Promise<AnalysisJobStatus> {
    return this.access(actor, spaceId, collectionId, jobId, async (db, key) => {
      const job = (await db.query(`SELECT state,expires_at<=clock_timestamp() AS lapsed FROM analysis_jobs
        WHERE space_id=$1 AND collection_id=$2 AND job_id=$3 FOR UPDATE`, key)).rows[0];
      const ending = async (state: string) => {
        await db.query('UPDATE analysis_jobs SET state=$4 WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', [...key, state]);
      };
      if (['queued', 'running', 'cancelling', 'completed'].includes(job.state) && job.lapsed) await ending('expired');
      else if (job.state === 'running') { await ending('cancelling'); await ending('cancelled'); }
      else if (job.state === 'queued' || job.state === 'cancelling') await ending('cancelled');
      const ended = (await db.query('SELECT state FROM analysis_jobs WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', key)).rows[0];
      if (ended.state === 'cancelled' || ended.state === 'expired') await discard(db, key);
      return view((await db.query(STATUS, key)).rows[0]);
    });
  }

  /**
   * One page of a complete, unexpired result, with the boundary and manifest
   * it belongs to. A job without a sealed result is CONFLICT (its state says
   * why); a page number outside the manifest is NOT_FOUND.
   */
  async page(actor: VerifiedCredential, spaceId: string, collectionId: string, jobId: string, pageNumber: number): Promise<AnalysisPage> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > analysisJobBounds.maxPages)
      invalid(`page must be an integer from 1 to ${analysisJobBounds.maxPages}`);
    return this.access(actor, spaceId, collectionId, jobId, async (db, key) => {
      const row = (await db.query(STATUS, key)).rows[0];
      const sealed = manifest(row);
      if (!sealed) throw new AuthorityError('CONFLICT', `The job has no complete result (state ${row.effective})`);
      const page = (await db.query(`SELECT page_number,row_offset,row_count,byte_offset,byte_size,content_sha256,content
        FROM analysis_result_pages WHERE space_id=$1 AND collection_id=$2 AND job_id=$3 AND page_number=$4`, [...key, pageNumber])).rows[0];
      if (!page) throw new AuthorityError('NOT_FOUND', `The result has ${sealed.pageCount} pages`);
      return { jobId: row.job_id, boundary: boundary(row), freshness: freshness(row), manifest: sealed, complete: true as const,
        page: { number: page.page_number, rowOffset: Number(page.row_offset), rowCount: page.row_count,
          byteOffset: Number(page.byte_offset), byteSize: page.byte_size, sha256: page.content_sha256, content: page.content } };
    });
  }

  /**
   * Authorize a read of the caller's own job: the directory and credential,
   * then the scope locks and grant for the job's capability, and, after `run`,
   * the bounded final check inside the same transaction, whose deadline must
   * still lie ahead once COMMIT is acknowledged.
   */
  private async access<T>(actor: VerifiedCredential, spaceId: string, collectionId: string, jobId: string,
    run: (db: Db, key: string[]) => Promise<T>): Promise<T> {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new AuthorityError('NOT_FOUND');
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, 'records:read');
    return released(await transact(this.pool(admitted.cellId), async db => {
      const key = [spaceId, collectionId, jobId];
      const job = (await db.query(`SELECT principal_id,credential_id,capability FROM analysis_jobs
        WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`, key)).rows[0];
      // Another principal's job, or another key's, is indistinguishable from none.
      if (!job || job.principal_id !== admitted.scope.principalId || (actor.kind !== 'session' && job.credential_id !== actor.credentialId))
        throw new AuthorityError('NOT_FOUND');
      const scope: AuthorityScope = { ...admitted.scope, capability: job.capability };
      const tx = new AuthorityTransaction(db, scope, 1);
      try { await tx.checkScope(); } finally { tx.close(); }
      const value = await run(db, key);
      return { value, deadline: await finalCheck(this.spaces, db, actor, admitted.ownerPrincipalId, scope, job.capability) };
    }));
  }
}

// ---- The jobs Worker step ----

/** Why a job can no longer run, as its failure code, or null while its binding still authorizes it. */
async function binding(db: Session, job: Row): Promise<string | null> {
  const row = (await db.query(`SELECT s.lifecycle,s.placement_generation,s.owner_principal_id,c.lifecycle AS collection_lifecycle,
      EXISTS (SELECT 1 FROM space_credentials sc JOIN collection_grants g ON g.space_id=sc.space_id AND g.credential_id=sc.credential_id
        WHERE sc.space_id=s.space_id AND sc.credential_id=$3 AND g.collection_id=c.collection_id AND $4=ANY(g.capabilities)
          AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL
          AND sc.expires_at>clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())) AS granted
    FROM spaces s JOIN collections c ON c.space_id=s.space_id
    WHERE s.space_id=$1 AND c.collection_id=$2 FOR SHARE OF s,c`, [job.space_id, job.collection_id, job.credential_id, job.capability])).rows[0];
  if (!row || row.collection_lifecycle === 'deleted') return 'NOT_FOUND';
  if (row.lifecycle !== 'active' && row.lifecycle !== 'readOnly') return 'SPACE_UNAVAILABLE';
  if (Number(row.placement_generation) !== Number(job.placement_generation)) return 'STALE_PLACEMENT';
  if (job.principal_id !== row.owner_principal_id && row.granted !== true) return 'FORBIDDEN';
  return null;
}

/**
 * The collection's records that existed at `watermark`, after `cursor`, in
 * record ID byte order (`COLLATE "C"` throughout, read through migration
 * 050's index, so neither page cuts nor output depend on the database's
 * default collation): each one's highest revision published at or below it (migration
 * 049's as-of index), with its operation and canonical data. A record first
 * written later is no candidate at all, so it takes no place in the `limit`
 * and pages cut the same whatever is written after the watermark. At most
 * `limit` records, and no more once the data read reaches `bytes` (always at
 * least one).
 */
async function asOf(db: Session, job: Row, cursor: string, limit: number, bytes: number): Promise<Row[]> {
  return (await db.query(`SELECT * FROM (
      SELECT x.*,sum(octet_length(COALESCE(x.canonical_data,''))) OVER (ORDER BY x.record_id COLLATE "C") AS running FROM (
        SELECT r.record_id,e.revision,e.operation,e.canonical_data FROM records r
        CROSS JOIN LATERAL (SELECT f.revision FROM record_event_feed f WHERE f.space_id=r.space_id AND f.collection_id=r.collection_id
          AND f.record_id=r.record_id AND f.position<=$3 ORDER BY f.revision DESC LIMIT 1) a
        JOIN record_events e ON e.space_id=r.space_id AND e.collection_id=r.collection_id AND e.record_id=r.record_id
          AND e.revision=a.revision
        WHERE r.space_id=$1 AND r.collection_id=$2 AND r.record_id COLLATE "C">$4::text COLLATE "C"
        ORDER BY r.record_id COLLATE "C" LIMIT $5) x
    ) y WHERE y.running-octet_length(COALESCE(y.canonical_data,''))<$6 ORDER BY y.record_id COLLATE "C"`,
  [job.space_id, job.collection_id, job.watermark, cursor, limit, bytes])).rows;
}

/** A record field's index value as a declared index of `kind` holds it; a value of another shape keeps its own kind. */
function indexed(data: Record<string, unknown>, field: string, kind: ValueKind): { kind: string; value: unknown } {
  if (!Object.hasOwn(data, field)) return { kind: 'missing', value: null };
  const value = data[field];
  if (value === null) return { kind: 'null', value: null };
  if (typeof value === 'boolean' || typeof value === 'number') return { kind: typeof value, value };
  if (typeof value !== 'string' || !scalarString(value)) return { kind: 'other', value: null };
  if (kind !== 'date-time') return { kind: 'string', value };
  try { return { kind: 'date-time', value: utcInstant(value) }; } catch { return { kind: 'string', value }; }
}

/** A job failure the step records: the job ends failed with `code`. */
class JobFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
/** Migration 049's guards that refuse a job's write only because its expiry or its lease passed meanwhile. */
const TIMED = new Set(['analysis_jobs_expiry', 'analysis_result_pages_job', 'analysis_result_manifests_job']);
const timed = (error: unknown) => TIMED.has((error as { constraint?: unknown } | null)?.constraint as string);
/**
 * The failure code of a page error that every retry would meet again, or
 * null for one a later step may not: a data or integrity violation or a
 * program limit of the database (SQLSTATE classes 22, 23 and 54) other than
 * a guard of the job's expiry or lease, or a fault of the job's own
 * reconstruction (a type, range or syntax error).
 */
function settled(error: unknown): string | null {
  if (error instanceof JobFailure) return error.code;
  if (timed(error)) return null;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^(22|23|54)[0-9A-Z]{3}$/.test(code)) return 'UNPROCESSABLE';
  return error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 'UNPROCESSABLE' : null;
}

/** Exact sum of two decimal texts (no exponent), as PostgreSQL numeric text. */
function addDecimal(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  const part = (text: string) => {
    const negative = text.startsWith('-'), [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    return { digits: (negative ? -1n : 1n) * BigInt(whole + fraction), scale: fraction.length };
  };
  const x = part(a), y = part(b), scale = Math.max(x.scale, y.scale);
  const digits = x.digits * 10n ** BigInt(scale - x.scale) + y.digits * 10n ** BigInt(scale - y.scale);
  let text = (digits < 0n ? -digits : digits).toString().padStart(scale + 1, '0');
  if (scale) text = `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return `${digits < 0n ? '-' : ''}${text}`;
}
/** Order two values of an index kind as the aggregate statement does: strings by UTF-8 bytes, instants by sort key. */
function compare(kind: ValueKind, a: unknown, b: unknown): number {
  if (kind === 'number') return Math.sign(Number(a) - Number(b));
  if (kind === 'boolean') return (a === true ? 1 : 0) - (b === true ? 1 : 0);
  if (kind === 'string') return Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
  return a === b ? 0 : String(a) < String(b) ? -1 : 1;
}
const rank = (key: unknown) => key === 'null' ? 1 : key === 'missing' ? 2 : 0;

/**
 * Partial aggregate groups, as checkpointed: the aggregate statement's row
 * shape per group, reduced to JSON values, so `formatGroups` formats merged
 * groups exactly as it formats one statement's.
 */
class Groups {
  private readonly index = new Map<string, Row>();
  constructor(private readonly spec: Spec, private readonly kinds: Record<string, ValueKind>, readonly rows: Row[] = []) {
    for (const row of rows) this.index.set(this.key(row), row);
  }
  private key(row: Row): string {
    return JSON.stringify(this.spec.groupBy.map((d, i) => [row[`k${i}`], d.bucket ? row[`e${i}`] : row[`v${i}`]]));
  }
  /** Fold one page statement's group row in. */
  add(source: Row): void {
    const row: Row = { n: Number(source.n) };
    this.spec.groupBy.forEach((d, i) => {
      row[`k${i}`] = source[`k${i}`];
      if (!d.bucket) { row[`v${i}`] = source[`v${i}`] ?? null; return; }
      // A key's kind is its value's kind, or null or missing.
      const value = source[`k${i}`] !== 'null' && source[`k${i}`] !== 'missing';
      row[`v${i}`] = null; row[`e${i}`] = value ? Number(source[`e${i}`]) : null; row[`o${i}`] = value ? Number(source[`o${i}`]) : null;
    });
    this.spec.metrics.forEach((m, j) => {
      if (m.field === null) { row[`m${j}`] = Number(source[`m${j}`]); return; }
      row[`m${j}`] = source[`m${j}`] ?? null;
      for (const count of ['values', 'nulls', 'missing']) row[`m${j}_${count}`] = Number(source[`m${j}_${count}`]);
    });
    const id = this.key(row), held = this.index.get(id);
    if (!held) { this.rows.push(row); this.index.set(id, row); return; }
    held.n += row.n;
    // An hour bucket is one UTC offset; its label keeps the earliest, as the statement's min() does.
    this.spec.groupBy.forEach((d, i) => { if (d.bucket?.unit === 'hour' && row[`o${i}`] !== null) held[`o${i}`] = Math.min(held[`o${i}`], row[`o${i}`]); });
    this.spec.metrics.forEach((m, j) => {
      const at = `m${j}`;
      if (m.field === null) { held[at] += row[at]; return; }
      for (const count of ['values', 'nulls', 'missing']) held[`${at}_${count}`] += row[`${at}_${count}`];
      if (m.op === 'sum' || m.op === 'avg') held[at] = addDecimal(held[at], row[at]);
      else if (held[at] === null || (row[at] !== null && compare(this.kinds[m.field], row[at], held[at]) * (m.op === 'min' ? 1 : -1) < 0))
        held[at] = row[at];
    });
  }
  /** The groups in the statement's order: by each key's value ascending, then null, then missing. */
  ordered(): Row[] {
    return [...this.rows].sort((a, b) => {
      for (let i = 0; i < this.spec.groupBy.length; i++) {
        const d = this.spec.groupBy[i], order = rank(a[`k${i}`]) - rank(b[`k${i}`]);
        if (order) return order;
        if (rank(a[`k${i}`])) continue;
        const by = d.bucket ? Math.sign(a[`e${i}`] - b[`e${i}`]) : compare(this.kinds[d.field], a[`v${i}`], b[`v${i}`]);
        if (by) return by;
      }
      return 0;
    });
  }
}

/** The STA-58 aggregate statement over `records`, with the page's as-of records and their derived index values in their place. */
async function aggregatePage(db: Session, job: Row, spec: Spec, kinds: Record<string, ValueKind>, live: Row[]) {
  const declared = new Map<string, Declared>(Object.entries(kinds).map(([field, kind]) =>
    [field, { kind, ready: true, filterable: true, acceptedVersion: 0 }]));
  // The page's groups are bounded by maxGroups, which the statement checks; the byte cap applies to the merged result only.
  const { sql, params } = statement({ spaceId: job.space_id, collectionId: job.collection_id } as AuthorityScope, spec, declared,
    Number.MAX_SAFE_INTEGER);
  const ids: string[] = [], record: string[] = [], field: string[] = [], kind: string[] = [], strings: (string | null)[] = [];
  const numbers: (number | null)[] = [], booleans: (boolean | null)[] = [], times: (string | null)[] = [];
  for (const row of live) {
    ids.push(row.record_id);
    const data = JSON.parse(row.canonical_data) as Record<string, unknown>;
    for (const [name, declaredKind] of Object.entries(kinds)) {
      const value = indexed(data, name, declaredKind);
      record.push(row.record_id); field.push(name); kind.push(value.kind);
      strings.push(value.kind === 'string' ? value.value as string : null);
      numbers.push(value.kind === 'number' ? value.value as number : null);
      booleans.push(value.kind === 'boolean' ? value.value as boolean : null);
      times.push(value.kind === 'date-time' ? value.value as string : null);
    }
  }
  const at = (value: unknown) => `$${params.push(value)}`;
  // Named as the tables the statement reads, these take their place in it: the collection's live records as of the
  // watermark, and each one's value of every declared field the spec names, derived from that revision's data.
  const prelude = `records AS (SELECT $1::text AS space_id,$2::text AS collection_id,id AS record_id,false AS tombstone
      FROM unnest(${at(ids)}::text[]) AS id),
    record_index_values AS (SELECT $1::text AS space_id,$2::text AS collection_id,v.record_id,v.field_name,v.value_kind,
      v.string_value COLLATE "C" AS string_value,v.number_value,v.boolean_value,v.time_value COLLATE "C" AS time_value
      FROM unnest(${at(record)}::text[],${at(field)}::text[],${at(kind)}::text[],${at(strings)}::text[],${at(numbers)}::numeric[],
        ${at(booleans)}::boolean[],${at(times)}::text[]) AS v(record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value))`;
  if (!sql.startsWith('WITH ')) throw new Error('The aggregate statement begins with its WITH list');
  const rows = (await db.query(`WITH ${prelude},${sql.slice('WITH'.length)}`, params)).rows;
  const totals = rows[0];
  if (totals.total_inconsistent === true)
    throw new JobFailure('SCHEMA_CONFLICT', 'A record holds a value its declared index kind does not take at the watermark');
  if (Number(totals.total_groups) > spec.maxGroups) throw new JobFailure('GROUP_LIMIT', `More than ${spec.maxGroups} groups`);
  return Number(totals.total_groups) === 0 ? [] : rows;
}

export interface AnalysisWorkerOptions {
  /** The cell's Hyperdrive origin connection limit (5 to 20), from which its analytical slots derive (STA-58). */
  originConnectionLimit: number;
}

/**
 * How long a step's probe or claim waits for one lock (on its job table, from DDL, `VACUUM FULL` or `LOCK TABLE`, or on
 * a space row a claim's own probe found free): past that the probe is cut short and the claim finds its job busy, so a
 * stalled lock never takes the other kind's window. A job whose space (or collection) another transaction holds locked
 * is not due at all: probes and claims pass it over (`SKIP LOCKED`), so it never keeps first place.
 */
const PROBE_LOCK_MS = 100;
/** A due probe's whole bound, connection checkout, lock waits and execution together: an eighth of the smallest budget. */
const PROBE_MS = 250;
/** Time a step keeps, past its preparation, for the first turn to begin its page or part. */
const PREPARE_SLACK_MS = 100;
/** The least time a turn needs: one page or part (each needs 1 s), its lease release, and the slack to begin it. */
const TURN_MS = MIN_PAGE_MS + RELEASE_MS + PREPARE_SLACK_MS;
/** The cell jobs Worker's tick, which creates its worker afresh each time (deployment/workers/jobs.ts). */
const TICK_MS = 60_000;
/** The bound on reading and passing on the cell's turn record, kept back from preparation. */
const TAKE_MS = 100;
export async function probing<T extends Session>(db: T): Promise<T> {
  await db.query(`SET LOCAL lock_timeout = '${PROBE_LOCK_MS}ms'`);
  return db;
}
export const lockedOut = (error: unknown) => (error as { code?: unknown } | null)?.code === '55P03';

/**
 * The jobs Worker's analysis step (docs/analysis-jobs.md#worker). Each step
 * expires jobs past their expiry, then claims due jobs one at a time (queued,
 * or running with a lapsed lease; least recently run first), each with one
 * analytical slot of its cell and of its space, and runs it page by page under
 * its lease until the step's budget ends. Every page is one transaction that
 * locks the space and collection, then the job at its exact lease, checks the
 * job's binding still authorizes it, reads the next records as of the
 * watermark, and commits the page (an export) or the merged partial groups
 * (an aggregate) with the checkpoint, so an interruption at any point resumes
 * from the last committed page and writes the same pages and manifest. When
 * no record is left, the manifest seals the result and the job completes. A
 * step gives its lease and slot holds back when it stops, so the next step
 * (or an interactive aggregation) can take them at once.
 *
 * The same step writes owner space exports (`PortabilityExportWorker`,
 * docs/portability-export.md#worker). Every step first ends expired jobs of
 * each kind, each in a slice of its own (a tenth of the budget, within the
 * preparation time), whichever kind claims first, and a finished pass is not
 * repeated. A job of either kind ends by its state alone and its result goes
 * in committed batches, so every slice makes progress, and a pass its slice
 * did not finish continues only in what both turns leave. It then probes each kind,
 * bounded alone, for the wait of the job its claim would take next (one whose
 * row, space or collection is locked is not due). All of that ends early
 * enough to leave one turn; a kind whose probe is locked out or fails is not
 * due, and one left unprobed or cut short is due with its wait unknown. A
 * kind due alone takes the whole budget. Two due kinds share a step that has
 * room for a turn of each: the one waiting longer first, stopping at its
 * share (analysis three fifths, exports two fifths) yet leaving the other its
 * turn, and getting back what the other leaves unused. With room for one turn
 * only they alternate step by step, whatever their waits, by the cell's turn
 * record (migration 052), so each gets a turn within two steps. A failure of either kind, a failed probe included, never
 * stops the other: the step throws it once both have run.
 */
export class PostgresAnalysisWorker {
  readonly #exports: PortabilityExportWorker;
  /**
   * The kind that goes first in preparation (0 analysis, 1 exports), and, when two due kinds cannot share a step and the
   * cell's turn record cannot be read, in the turns too: from the parity of the minute the worker was created in, then
   * the kind the last such step put second.
   */
  #alternate = Math.floor(Date.now() / TICK_MS) % 2;
  constructor(private readonly pool: PoolLike, private readonly options: AnalysisWorkerOptions) {
    this.#exports = new PortabilityExportWorker(pool);
  }

  /** The cell's analytical slots, derived when analysis runs: an invalid origin limit fails analysis only, never exports. */
  get #slots(): { cell: number; space: number } { return analyticalSlots(this.options.originConnectionLimit); }

  async step(settings: { budgetMs?: number } = {}): Promise<AnalysisStep> {
    const budgetMs = bounded(settings.budgetMs ?? 5_000, MIN_STEP_MS, 60_000);
    const end = Date.now() + budgetMs;
    const result: AnalysisStep = { expired: 0, claimed: 0, pages: 0, completed: 0, failed: 0,
      exports: { expired: 0, claimed: 0, parts: 0, completed: 0, failed: 0, unadmitted: 0, removed: 0 } };
    // The first failure of each kind, thrown once both kinds have run. A slice or turn whose deadline ends it, at its
    // COMMIT too (that transaction is retried or resumed from its checkpoint), has only run out of time.
    const failures = new Map<'analysis' | 'exports', unknown>();
    const ended = (error: unknown) => cutShort(error) || (error instanceof CommitOutcomeUnknownError && cutShort(error.cause));
    const settle = async (kind: 'analysis' | 'exports', run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { if (!ended(error) && !failures.has(kind)) failures.set(kind, error); }
    };
    // An invalid origin connection limit fails analysis at every step, whatever is due, and never stops exports.
    await settle('analysis', async () => this.#slots);
    // Preparation ends by `readyBy`, which leaves the first turn one page or part and its lease release. First each kind's
    // expiry, every step, in a slice of its own: a tenth of the budget, and at most two fifths of the preparation time
    // left for the first kind and two thirds of what is then left for the second, so both slices fit at the 2 s minimum
    // (120 ms each there when both are used up) and the probes keep the rest. An export's parts go in committed batches, so every
    // slice makes progress however large the export. Then each kind's due probe, bounded alone: a kind whose probe is
    // locked out or fails (reported) is not due this step, and one left unprobed or whose probe is cut short is due
    // with its wait unknown. A job of either kind ends by its state alone and its result goes in committed batches, so
    // cleanup never makes a kind due: an expiry pass its slice did not finish continues only in what both turns leave.
    const readyBy = end - TURN_MS - TAKE_MS;
    const unfinished = new Set<'analysis' | 'exports'>();
    const finishing = (pass: Promise<boolean>) => pass.catch((error: unknown) => { if (ended(error)) return false; throw error; });
    const kinds = [
      { kind: 'analysis' as const, share: 3, expire: (until: number, lockBound = false) => this.expire(until, result, lockBound),
        waiting: (until: number) => this.waiting(until) },
      { kind: 'exports' as const, share: 2, expire: (until: number, lockBound = false) => this.#exports.expire(until, result.exports, lockBound),
        waiting: (until: number) => this.#exports.waiting(until) }];
    // The kind whose turn it is goes first, in preparation too, so neither's preparation always takes the other's slack.
    if (this.#alternate) kinds.reverse();
    for (const [i, { kind, expire }] of kinds.entries()) {
      const slice = Math.min(Math.floor(budgetMs / 10), Math.floor((readyBy - Date.now()) * (i === 0 ? 2 / 5 : 2 / 3)));
      await settle(kind, async () => { if (!await finishing(expire(Date.now() + Math.max(0, slice)))) unfinished.add(kind); });
    }
    const due: { kind: 'analysis' | 'exports'; share: number; since: number }[] = [];
    for (const { kind, share, waiting } of kinds) {
      const since = await waiting(Math.min(readyBy, Date.now() + PROBE_MS)).catch((error: unknown) => {
        if (ended(error)) return Infinity;
        if (!lockedOut(error) && !failures.has(kind)) failures.set(kind, error);
        return null;
      });
      if (since !== null) due.push({ kind, share, since });
    }
    // Two kinds due share the step when it has room for a turn of each: the one waiting longer first, stopping at its share
    // and never later than leaves the other its turn. Otherwise they alternate, step by step, whatever their waits: the
    // kind the cell's turn record names goes first and the record names the other (this worker's own turn if unreadable).
    const left = end - Date.now(), shared = due.length === 2 && left >= 2 * TURN_MS;
    if (shared) due.sort((a, b) => a.since - b.since || a.share - b.share);
    else if (due.length === 2) {
      const exportsFirst = await this.#taking(Math.min(end - TURN_MS, Date.now() + TAKE_MS)).catch(() => this.#alternate === 1);
      if ((due[0].kind === 'exports') !== exportsFirst) due.reverse();
      this.#alternate = exportsFirst ? 0 : 1;
    }
    const turn = (kind: 'analysis' | 'exports', until: number) => settle(kind, () =>
      kind === 'analysis' ? this.analyse(until, result) : this.#exports.turn(until, result.exports));
    const [first, second] = due;
    if (first) await turn(first.kind, shared
      ? Math.min(end - TURN_MS, Date.now() + Math.max(TURN_MS, Math.floor(left * first.share / 5))) : end);
    if (second) await turn(second.kind, end);
    // What the second kind left unused (nothing it could run, or a failure) goes back to the first.
    if (shared && end - RELEASE_MS - Date.now() >= MIN_PAGE_MS) await turn(first.kind, end);
    // Only now, in what both turns left, do the expiry passes their slices did not finish continue, in the step's order;
    // each transaction waits at most the lock bound, so a locked table ends the pass.
    for (const { kind, expire } of kinds)
      if (unfinished.has(kind) && Date.now() < end)
        await settle(kind, () => finishing(expire(end, true)).catch((error: unknown) => { if (lockedOut(error)) return false; throw error; }));
    if (failures.size > 1) throw new AggregateError([...failures.values()], 'The analysis and export steps failed');
    if (failures.size) throw [...failures.values()][0];
    return result;
  }

  /** Whether exports go first at this step, as the cell's turn record says, which then names the other kind. */
  async #taking(until: number): Promise<boolean> {
    const row = (await inTransaction(this.pool, async db => (await probing(db)).query(`UPDATE snapshot_step_turn
      SET exports_next=NOT exports_next RETURNING NOT exports_next AS exports_first`), { deadline: until })).rows[0];
    if (!row) throw new Error('The snapshot step turn record is missing');
    return row.exports_first === true;
  }

  /**
   * When the analysis job the step would claim next began waiting (epoch ms): the first in the claim's own order whose
   * row, space and collection no other transaction holds locked, a queued one since its submission and a lapsed one
   * since its lease ended. Null when none is due.
   */
  private async waiting(until: number): Promise<number | null> {
    const since = (await inTransaction(this.pool, async db => (await probing(db)).query(`SELECT (extract(epoch FROM
        (SELECT x.waited FROM (SELECT CASE WHEN j.state='queued' THEN j.created_at ELSE j.leased_until END AS waited
          FROM analysis_jobs j JOIN spaces s ON s.space_id=j.space_id
            JOIN collections c ON c.space_id=j.space_id AND c.collection_id=j.collection_id
          WHERE (j.state='queued' OR (j.state='running' AND j.leased_until<=clock_timestamp())) AND j.expires_at>clock_timestamp()
          ORDER BY j.leased_until NULLS FIRST,j.created_at,j.job_id LIMIT 1 FOR SHARE OF j,s,c SKIP LOCKED) x))*1000)::float8 AS since`),
    { deadline: until })).rows[0].since;
    return since === null ? null : Number(since);
  }

  /** Claim and run analysis jobs until `until` (the step ended expired ones in its own slice). */
  private async analyse(until: number, result: AnalysisStep): Promise<void> {
    // An invalid origin connection limit fails the analysis half here, and the step reports it once exports have run.
    analyticalSlots(this.options.originConnectionLimit);
    const passed: { s: string; c: string; j: string }[] = [];
    while (until - RELEASE_MS - Date.now() >= MIN_PAGE_MS) {
      let job: Row | null | 'busy' | 'failed';
      try { job = await this.claim(until - RELEASE_MS, passed); } catch (error) { if (cutShort(error)) break; throw error; }
      if (job === null) break;
      if (job === 'failed') result.failed++;
      if (job === 'busy' || job === 'failed') continue;
      result.claimed++;
      await this.run(job, until, result);
    }
  }

  /**
   * End jobs past their expiry, one per transaction, with their manifest: their slots are released as they end, and
   * none is read again. Then remove expired jobs' pages in committed batches (`removeNext`, from migration 052's
   * removal queue), the job with the fewest left first and each at most once a round, so one large result never holds
   * up the others. With `lockBound`, each transaction waits at most the probe's lock bound. True once nothing is left
   * to end or remove.
   */
  private async expire(until: number, result: AnalysisStep, lockBound = false): Promise<boolean> {
    const passed: string[] = [];
    while (Date.now() < until) {
      const done = await inTransaction(this.pool, async db => {
        if (lockBound) await probing(db);
        // By `now()`, the transaction's start, so the bound is a range of `analysis_jobs_expiry`, never a scan of every
        // completed result the cell retains.
        const due = (await db.query(`SELECT space_id,collection_id,job_id FROM analysis_jobs
          WHERE state IN ${ACTIVE} AND expires_at<=now() ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (due) {
          await db.query(`UPDATE analysis_jobs SET state='expired' WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`, pk(due));
          await db.query('DELETE FROM analysis_result_manifests WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', pk(due));
          return 'expired' as const;
        }
        return removeNext(db, 'analysis', until, passed);
      }, { deadline: until });
      if (done === 'expired') result.expired++;
      // Each expired job holding pages has had its batch this round: another round, or nothing is left.
      else if (done === null) { if (!passed.length) return true; passed.length = 0; }
    }
    return false;
  }

  /**
   * Claim the next due job not passed over in this step, with a slot of its
   * cell and of its space: null when none is due or no slot is free, `busy`
   * when the job was taken meanwhile, `failed` when its binding failed it.
   */
  private async claim(until: number, passed: { s: string; c: string; j: string }[]): Promise<Row | null | 'busy' | 'failed'> {
    // Passing over a job whose row, space or collection another transaction holds locked, as the probe does; a table
    // held locked past the probe's lock bound leaves nothing to claim this step.
    const next = (await inTransaction(this.pool, async db => (await probing(db)).query(`SELECT j.space_id,j.collection_id,j.job_id
      FROM analysis_jobs j JOIN spaces s ON s.space_id=j.space_id JOIN collections c ON c.space_id=j.space_id AND c.collection_id=j.collection_id
      WHERE (j.state='queued' OR (j.state='running' AND j.leased_until<=clock_timestamp())) AND j.expires_at>clock_timestamp()
        AND NOT $1::jsonb @> jsonb_build_array(jsonb_build_object('s',j.space_id,'c',j.collection_id,'j',j.job_id))
      ORDER BY j.leased_until NULLS FIRST,j.created_at,j.job_id LIMIT 1 FOR SHARE OF j,s,c SKIP LOCKED`, [JSON.stringify(passed)]),
    { deadline: until }).catch((error: unknown) => { if (lockedOut(error)) return { rows: [] }; throw error; })).rows[0];
    if (!next) return null;
    passed.push({ s: next.space_id, c: next.collection_id, j: next.job_id });
    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = randomUUID();
      const claimed = await inTransaction(this.pool, async db => {
        // Space and collection first, as the purge and every reader lock them; then the job; then its slots. A lock held
        // past the probe's bound leaves the job busy, so the claim never waits out the step.
        await probing(db);
        const job = (await db.query('SELECT * FROM analysis_jobs WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', pk(next))).rows[0];
        if (!job) return 'busy' as const;
        const failure = await binding(db, job);
        const locked = (await db.query(`SELECT *,least(clock_timestamp()+$4::int*interval '1 millisecond',expires_at) AS until
          FROM analysis_jobs WHERE space_id=$1 AND collection_id=$2 AND job_id=$3
            AND (state='queued' OR (state='running' AND leased_until<=clock_timestamp())) AND expires_at>clock_timestamp()
          FOR UPDATE SKIP LOCKED`, [...pk(next), analysisJobBounds.leaseMs])).rows[0];
        if (!locked) return 'busy' as const;
        if (failure) { await this.fail(db, locked, failure); return 'failed' as const; }
        const cell = (await db.query('SELECT cell_id FROM spaces WHERE space_id=$1', [locked.space_id])).rows[0].cell_id;
        await this.take(db, locked, cell);
        return (await db.query(`UPDATE analysis_jobs SET state='running',lease_id=$4,leased_until=$5,attempts=attempts+1
          WHERE space_id=$1 AND collection_id=$2 AND job_id=$3 RETURNING *`, [...pk(locked), lease, locked.until])).rows[0];
      }, { deadline: until }).catch((error: unknown) => {
        if (error instanceof SlotOutcome) return error.outcome;
        // Taking a slot that another transaction holds meanwhile, or in a space changing meanwhile, is refused: retry later.
        const code = (error as { code?: unknown }).code;
        if (code === '55P03' || code === '23505' || code === '23514' || code === '40001') return 'busy' as const;
        throw error;
      });
      if (claimed === 'busy' || claimed === 'failed') return claimed;
      if (claimed === 'full') return null;
      if (claimed !== 'unprovisioned') return claimed;
      await inTransaction(this.pool, async db => {
        const cell = (await db.query('SELECT cell_id FROM spaces WHERE space_id=$1', [next.space_id])).rows[0]?.cell_id;
        if (!cell) return;
        await db.query(`INSERT INTO analysis_cell_slots(cell_id,slot) SELECT $1,s FROM generate_series(1,$2::int) s
          WHERE NOT EXISTS (SELECT 1 FROM analysis_cell_slots x WHERE x.cell_id=$1 AND x.slot=s) ON CONFLICT DO NOTHING`,
        [cell, this.#slots.cell]);
        await db.query(`INSERT INTO analysis_space_slots(space_id,slot) SELECT $1,s FROM generate_series(1,$2::int) s
          WHERE NOT EXISTS (SELECT 1 FROM analysis_space_slots x WHERE x.space_id=$1 AND x.slot=s) ON CONFLICT DO NOTHING`,
        [next.space_id, this.#slots.space]);
      }, { deadline: until }).catch((error: unknown) => { if ((error as { code?: unknown }).code !== '23514') throw error; });
    }
    return 'busy';
  }

  /**
   * Hold a cell slot and a space slot for the locked job until its lease
   * ends: one it still holds, else a free or lapsed one, never one an
   * interactive aggregation holds by row lock. Without both it throws, so the
   * claim rolls back: `unprovisioned` when fewer slot rows exist than the
   * limits allow, else `full` without a cell slot and `busy` without a space slot.
   */
  private async take(db: Session, job: Row, cell: string): Promise<void> {
    const free = `(holder_job_id IS NULL OR held_until<=clock_timestamp() OR holder_job_id=$3)
      ORDER BY (holder_job_id IS NOT DISTINCT FROM $3) DESC,slot LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const cellSlot = (await db.query(`UPDATE analysis_cell_slots SET holder_space_id=$1,holder_collection_id=$2,holder_job_id=$3,
        held_until=$4 WHERE cell_id=$5 AND slot=(SELECT slot FROM analysis_cell_slots WHERE cell_id=$5 AND slot<=$6 AND ${free})
      RETURNING slot`, [...pk(job), job.until, cell, this.#slots.cell])).rows[0];
    const spaceSlot = cellSlot && (await db.query(`UPDATE analysis_space_slots SET holder_collection_id=$2,holder_job_id=$3,held_until=$4
      WHERE space_id=$1 AND slot=(SELECT slot FROM analysis_space_slots WHERE space_id=$1 AND slot<=$5 AND ${free})
      RETURNING slot`, [...pk(job), job.until, this.#slots.space])).rows[0];
    if (cellSlot && spaceSlot) return;
    const rows = (await db.query(`SELECT (SELECT count(*) FROM analysis_cell_slots WHERE cell_id=$1 AND slot<=$2)::int AS cell,
      (SELECT count(*) FROM analysis_space_slots WHERE space_id=$3 AND slot<=$4)::int AS space`,
    [cell, this.#slots.cell, job.space_id, this.#slots.space])).rows[0];
    if (rows.cell < this.#slots.cell || rows.space < this.#slots.space) throw new SlotOutcome('unprovisioned');
    // The cell's slots in use end the step; only this space's in use, another space's job may still run.
    throw new SlotOutcome(cellSlot ? 'busy' : 'full');
  }

  /** Run the claimed job page by page until it ends, its lease is lost or the budget ends; then give the lease back. */
  private async run(claimed: Row, until: number, result: AnalysisStep): Promise<void> {
    try {
      while (until - RELEASE_MS - Date.now() >= MIN_PAGE_MS) {
        let outcome: 'page' | 'completed' | 'failed' | 'expired' | 'lost';
        try { outcome = await inTransaction(this.pool, db => this.page(db, claimed), { deadline: until - RELEASE_MS }); }
        catch (error) { if (cutShort(error)) break; throw error; }
        if (outcome === 'page') { result.pages++; continue; }
        if (outcome === 'completed') result.completed++;
        if (outcome === 'failed') result.failed++;
        if (outcome === 'expired') result.expired++;
        return;
      }
    } finally {
      // Its lease and slot holds end now, so the job is due again and its slots free. A failure here only leaves them to lapse.
      await inTransaction(this.pool, async db => {
        const held = (await db.query(`UPDATE analysis_jobs SET leased_until=clock_timestamp() WHERE space_id=$1 AND collection_id=$2
          AND job_id=$3 AND state='running' AND lease_id=$4 AND leased_until>clock_timestamp() RETURNING job_id`,
        [...pk(claimed), claimed.lease_id])).rows[0];
        if (!held) return;
        await db.query(`UPDATE analysis_cell_slots SET held_until=clock_timestamp() WHERE holder_space_id=$1 AND holder_collection_id=$2
          AND holder_job_id=$3`, pk(claimed));
        await db.query(`UPDATE analysis_space_slots SET held_until=clock_timestamp() WHERE space_id=$1 AND holder_collection_id=$2
          AND holder_job_id=$3`, pk(claimed));
      }, { deadline: until }).catch(() => {});
    }
  }

  private async fail(db: Session, job: Row, code: string): Promise<void> {
    await db.query(`UPDATE analysis_jobs SET state='failed',failure_code=$4 WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`,
      [...pk(job), code]);
    await discard(db, pk(job));
  }

  /** One page of the job under its exact lease, committed with its checkpoint; or its manifest once no record is left. */
  private async page(db: Session, claimed: Row): Promise<'page' | 'completed' | 'failed' | 'expired' | 'lost'> {
    const started = Date.now();
    const key = pk(claimed);
    const failure = await binding(db, claimed);
    const job = (await db.query(`SELECT *,least(clock_timestamp()+$5::int*interval '1 millisecond',expires_at) AS until
      FROM analysis_jobs WHERE space_id=$1 AND collection_id=$2 AND job_id=$3 AND state='running' AND lease_id=$4
        AND leased_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`, [...key, claimed.lease_id, analysisJobBounds.leaseMs])).rows[0];
    if (!job) return 'lost';
    if (failure) { await this.fail(db, job, failure); return 'failed'; }
    // One slot is one backend: no parallel workers outside the analytical budget.
    await db.query('SET LOCAL max_parallel_workers_per_gather = 0');
    // The slot holds and the lease reach past this transaction first, so its work runs on analytical capacity and its
    // writes under an unexpired lease. A job that no longer holds both slots stops; its next claim takes them again.
    const cellHeld = await db.query(`UPDATE analysis_cell_slots SET held_until=$4 WHERE holder_space_id=$1 AND holder_collection_id=$2
      AND holder_job_id=$3`, [...key, job.until]);
    const spaceHeld = await db.query(`UPDATE analysis_space_slots SET held_until=$4 WHERE space_id=$1 AND holder_collection_id=$2
      AND holder_job_id=$3`, [...key, job.until]);
    if (!cellHeld.rowCount || !spaceHeld.rowCount) return 'lost';
    await db.query('UPDATE analysis_jobs SET leased_until=$4 WHERE space_id=$1 AND collection_id=$2 AND job_id=$3', [...key, job.until]);
    // A page error that would recur ends the job failed (its partial page undone), rather than retry it until expiry.
    await db.query('SAVEPOINT analysis_page');
    try {
      return await this.advance(db, job, started);
    } catch (error) {
      const code = settled(error);
      if (code === null && !timed(error)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT analysis_page');
      // The job's clock decides first: a page its expiry overtook ends the job expired; one that outlived its lease is
      // left to a later claim, as an interrupted page is. Only a job still within both fails.
      const clock = (await db.query(`SELECT expires_at<=clock_timestamp() AS expired,leased_until<=clock_timestamp() AS lapsed
        FROM analysis_jobs WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`, key)).rows[0];
      if (clock.expired) {
        await db.query(`UPDATE analysis_jobs SET state='expired' WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`, key);
        await discard(db, key);
        return 'expired';
      }
      if (clock.lapsed || code === null) return 'lost';
      await this.fail(db, job, code);
      return 'failed';
    }
  }

  private async advance(db: Session, job: Row, started: number): Promise<'page' | 'completed'> {
    const key = pk(job);
    const scanned = Number(job.records_scanned), remaining = Number(job.budget_records) - scanned;
    const rows = await asOf(db, job, job.cursor_record_id ?? '', Math.max(1, Math.min(analysisJobBounds.pageRecords, remaining)),
      analysisJobBounds.pageBytes);
    if (rows.length && remaining <= 0) throw new JobFailure('BUDGET_EXCEEDED', 'The job scanned its record budget');
    const last = (await db.query(`SELECT page_number,row_offset+row_count AS rows,byte_offset+byte_size AS bytes FROM analysis_result_pages
      WHERE space_id=$1 AND collection_id=$2 AND job_id=$3 ORDER BY page_number DESC LIMIT 1`, key)).rows[0]
      ?? { page_number: 0, rows: 0, bytes: 0 };
    const writePage = async (content: string, rowCount: number) => {
      if (last.page_number >= analysisJobBounds.maxPages) throw new JobFailure('RESULT_TOO_LARGE', `More than ${analysisJobBounds.maxPages} pages`);
      if (Number(last.bytes) + Buffer.byteLength(content) > Number(job.budget_bytes))
        throw new JobFailure('BUDGET_EXCEEDED', 'The result exceeds the job\'s byte budget');
      await db.query(`INSERT INTO analysis_result_pages(space_id,collection_id,job_id,credential_id,spec_digest,schema_version,watermark,
          page_number,row_offset,row_count,byte_offset,content,content_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [...key, job.credential_id, job.spec_digest, job.schema_version, job.watermark, last.page_number + 1, last.rows, rowCount,
        last.bytes, content, sha256(content)]);
    };
    const canonical = JSON.parse(job.canonical_spec);
    const spec = canonical.kind === 'aggregate' ? parse(canonical.spec, true) : null;
    const kinds: Record<string, ValueKind> = Object.assign(Object.create(null), canonical.fields);
    if (!rows.length) {
      // No record is left: seal the result. An aggregate's one page is its merged groups, formatted as STA-58 formats them.
      if (spec) {
        const kindOf = (name: string) => kinds[name];
        const merged = new Groups(spec, kinds, job.checkpoint?.groups ?? []);
        // Without groupBy every result is one group, of no records if the collection had none at the watermark.
        if (!spec.groupBy.length && !merged.rows.length) for (const row of await aggregatePage(db, job, spec, kinds, [])) merged.add(row);
        const groups = formatGroups(spec, kindOf, merged.ordered());
        if (jsonBytes(groups) > aggregationBounds.resultBytes)
          throw new JobFailure('RESULT_TOO_LARGE', `The groups exceed ${aggregationBounds.resultBytes} bytes`);
        const described = describe(spec, kindOf);
        await writePage(JSON.stringify({
          source: { spaceId: job.space_id, collectionId: job.collection_id, records: 'as-of-watermark', where: spec.where,
            policyVersion: Number(job.policy_version), placementGeneration: Number(job.placement_generation) },
          collection: { schemaVersion: Number(job.schema_version), fields: named(spec).map(name => ({ field: name, kind: kinds[name] })) },
          snapshot: { scope: 'watermark', watermark: Number(job.watermark) },
          groupBy: described.groupBy, metrics: described.metrics, groups, complete: true }), 1);
      }
      await db.query(`INSERT INTO analysis_result_manifests(space_id,collection_id,job_id,credential_id,spec_digest,schema_version,watermark,
          page_count,row_count,byte_size,result_sha256)
        SELECT $1,$2,$3,$4,$5,$6,$7,count(*),COALESCE(sum(row_count),0),COALESCE(sum(byte_size),0),
          encode(sha256(convert_to(COALESCE(string_agg(content_sha256,'' ORDER BY page_number),''),'UTF8')),'hex')
        FROM analysis_result_pages WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`,
      [...key, job.credential_id, job.spec_digest, job.schema_version, job.watermark]);
      await db.query(`UPDATE analysis_jobs SET state='completed' WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`, key);
      return 'completed';
    }
    let consumed = 0, checkpoint: Row | null = job.checkpoint;
    if (spec) {
      const groups = new Groups(spec, kinds, job.checkpoint?.groups ?? []);
      for (const row of await aggregatePage(db, job, spec, kinds, rows.filter(row => row.operation !== 'delete')))
        groups.add(row);
      if (groups.rows.length > spec.maxGroups) throw new JobFailure('GROUP_LIMIT', `More than ${spec.maxGroups} groups`);
      checkpoint = { groups: groups.rows };
      // Measured as migration 049's bound measures it: the stored jsonb's text, which spaces its members.
      const stored = (await db.query('SELECT octet_length($1::jsonb::text) AS n', [JSON.stringify(checkpoint)])).rows[0].n;
      if (Number(stored) > analysisJobBounds.checkpointBytes)
        throw new JobFailure('RESULT_TOO_LARGE', 'The partial groups exceed the checkpoint bound');
      consumed = rows.length;
    } else {
      // One NDJSON line per record live at the watermark, as many as fit one page; a page is a function of its cursor alone.
      let content = '', lines = 0;
      for (const row of rows) {
        if (row.operation !== 'delete') {
          const line = `{"id":${JSON.stringify(row.record_id)},"revision":${Number(row.revision)},"data":${row.canonical_data}}\n`;
          if (Buffer.byteLength(content) + Buffer.byteLength(line) > analysisJobBounds.pageBytes) {
            if (!lines) throw new JobFailure('RESULT_TOO_LARGE', `Record ${row.record_id} does not fit one ${analysisJobBounds.pageBytes}-byte page`);
            break;
          }
          content += line; lines++;
        }
        consumed++;
      }
      if (lines) await writePage(content, lines);
    }
    const runtime = Number(job.runtime_ms) + Math.max(0, Date.now() - started);
    if (runtime > Number(job.budget_runtime_ms)) throw new JobFailure('BUDGET_EXCEEDED', 'The job ran past its runtime budget');
    await db.query(`UPDATE analysis_jobs SET cursor_record_id=$4,checkpoint=$5::jsonb,records_scanned=$6,runtime_ms=$7
      WHERE space_id=$1 AND collection_id=$2 AND job_id=$3`,
    [...key, rows[consumed - 1].record_id, checkpoint === null ? null : JSON.stringify(checkpoint), scanned + consumed, runtime]);
    return 'page';
  }
}

/** Taking slots found none free: the claim rolls back and reports why. */
class SlotOutcome extends Error { constructor(readonly outcome: 'full' | 'busy' | 'unprovisioned') { super(outcome); } }

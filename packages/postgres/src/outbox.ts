import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AuthorityError, CommitOutcomeUnknownError } from './index.js';
import type { AuthorityScope, OutboxDelivery, PostgresAuthority, ProjectionChange, ProjectionOutcome, ProjectionQuery } from './index.js';
import { claimOutboxSql, failOutboxSql, LIVE_OUTBOX } from './outbox-sql.js';
import { scalarString } from './schema.js';

type PoolLike = Pick<pg.Pool, 'connect'>;

/** A queue message is only a hint; SQL decides whether its lease is still current. */
export interface DeliveryMessage { eventId: string; attempt: number }
/** Product-internal projection port. `prepare` runs outside SQL, `apply` inside the fenced completion. */
export interface Projector<P = unknown> {
  prepare?(change: ProjectionChange, signal: AbortSignal): Promise<P>;
  apply(change: ProjectionChange, prepared: P | undefined, query: ProjectionQuery): Promise<void>;
}
export type ProcessOutcome = ProjectionOutcome | 'failed' | 'released';
export interface DispatchLimits { limit?: number; perSpace?: number; pairs?: number; leaseSeconds?: number }
export interface CollectionOutboxStatus {
  spaceId: string; collectionId: string; pending: number; delivering: number; degraded: number; deadLettered: number;
  oldestUndeliveredAt: string | null; lagSeconds: number | null; lastError: string | null;
}
export interface ReconciliationStatus {
  jobId: string; spaceId: string; collectionId: string; state: 'running' | 'completed' | 'cancelled';
  scanned: number; requeued: number; createdAt: string; updatedAt: string;
}
export interface CellOutboxStatus {
  lastDispatchAt: string | null; collections: CollectionOutboxStatus[]; reconciliations: ReconciliationStatus[];
}

const EVENT_ID = /^evt_[0-9a-f-]{36}$/;
const JOB_ID = /^rcn_[0-9a-f-]{36}$/;
const WORKER = { principalId: 'system:projection', credentialId: 'system:projection', capability: 'outbox:worker' } as const;
// Initial protective bounds, not measured provider capacity: one statement
// stays short, and one started item must finish well inside its lease.
const STATEMENT_MS = 5_000;
const PROCESSING_LEASE_MS = 60_000;
const PROCESSING_BUDGET_MS = 45_000;
const STATUS_ROWS = 1_000;
const PAUSED_STEP_SECONDS = 60;

class ProjectorFailure extends Error {}

/** Run one short cell transaction; a missing COMMIT acknowledgement stays ambiguous. */
async function inTransaction<T>(pool: PoolLike, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  // An unacknowledged BEGIN or COMMIT leaves the session state unknown.
  let discard = true;
  try {
    await client.query('BEGIN'); begun = true; discard = false;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    const result = await fn(client);
    try { await client.query('COMMIT'); begun = false; }
    catch (error) { discard = true; begun = false; throw new CommitOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => { discard = true; });
    throw error;
  } finally { client.release(discard); }
}

function bounded(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new AuthorityError('INVALID_ARGUMENT');
  return value as number;
}

function text(value: unknown, maxBytes: number): string {
  if (!scalarString(value) || !value || Buffer.byteLength(value) > maxBytes) throw new AuthorityError('INVALID_ARGUMENT');
  return value;
}

/** Keep a bounded, NUL-free diagnostic. Projectors must not put record content in errors. */
function diagnostic(error: unknown): string {
  const cause = error instanceof ProjectorFailure ? error.cause : error;
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Projection failed';
  return message.replaceAll('\0', '').slice(0, 1024) || 'Projection failed';
}

/** Settle when the work does or the budget expires, whichever is first. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AuthorityError('RATE_LIMITED', 'Projection time budget exceeded'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Cell-wide durable outbox operations. The dispatcher leases due rows fairly
 * and sends hints; workers start, complete or fail exactly the lease they
 * were given; operators read status, retry dead letters and reconcile.
 */
export class PostgresOutbox {
  constructor(private readonly pool: PoolLike, private readonly authority: PostgresAuthority) {}

  /**
   * Lease due work for dispatch. A rotating cursor bounds each scan to
   * `pairs` space/collection pairs and each space to `perSpace` rows per
   * tick. A dispatch lease is not started: if the hint is lost, the lease
   * expires and is reclaimed without spending the row's failure budget.
   */
  async claim(limits: DispatchLimits = {}): Promise<DeliveryMessage[]> {
    const limit = bounded(limits.limit ?? 100, 1, 100);
    const perSpace = bounded(limits.perSpace ?? Math.min(25, limit), 1, limit);
    const pairs = bounded(limits.pairs ?? 200, 1, 1_000);
    const leaseSeconds = bounded(limits.leaseSeconds ?? 300, 1, 3_600);
    return inTransaction(this.pool, async db => {
      const cursor = (await db.query(`SELECT after_space_id,after_collection_id FROM outbox_dispatch_checkpoint
        FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!cursor) return [];
      const after: [string, string] | null = cursor.after_space_id === null ? null : [cursor.after_space_id, cursor.after_collection_id];
      let scanned = await this.scanPairs(db, after, null, pairs);
      let next = scanned.length === pairs ? scanned.at(-1)! : null;
      if (after && scanned.length < pairs) {
        // Wrap to the start and stop at the old cursor; a short wrap means
        // every live pair was visited and the next tick starts over.
        const budget = pairs - scanned.length;
        const wrapped = await this.scanPairs(db, null, after, budget);
        scanned = [...scanned, ...wrapped];
        next = wrapped.length === budget ? wrapped.at(-1)! : null;
      }
      const due = `SELECT o.event_id FROM projection_outbox o JOIN (
          SELECT event_id FROM (
            SELECT due.event_id,due.available_at,
              row_number() OVER (PARTITION BY p.space_id ORDER BY due.available_at,due.event_id) AS turn
            FROM unnest($1::text[],$2::text[]) AS p(space_id,collection_id)
            JOIN spaces s ON s.space_id=p.space_id AND s.lifecycle IN ('active','readOnly')
            JOIN collections c ON c.space_id=p.space_id AND c.collection_id=p.collection_id AND c.lifecycle<>'deleted'
            CROSS JOIN LATERAL (SELECT event_id,available_at FROM projection_outbox
              WHERE space_id=p.space_id AND collection_id=p.collection_id AND ${LIVE_OUTBOX}
                AND available_at<=clock_timestamp()
              ORDER BY available_at,event_id LIMIT $3) due
          ) ranked WHERE turn<=$3 ORDER BY turn,available_at,event_id LIMIT $4
        ) picked ON picked.event_id=o.event_id
        WHERE o.${LIVE_OUTBOX} AND o.available_at<=clock_timestamp()
        FOR UPDATE OF o SKIP LOCKED`;
      const claimed = await db.query(claimOutboxSql(due, '$5', 'false'),
        [scanned.map(pair => pair[0]), scanned.map(pair => pair[1]), perSpace, limit, leaseSeconds]);
      await db.query(`UPDATE outbox_dispatch_checkpoint SET after_space_id=$1,after_collection_id=$2,
        dispatched_at=clock_timestamp()`, [next?.[0] ?? null, next?.[1] ?? null]);
      return claimed.rows.map(row => ({ eventId: row.event_id, attempt: row.attempts }));
    });
  }

  /** Walk distinct live pairs through the claim index, after one bound and up to another. */
  private async scanPairs(db: pg.PoolClient, after: [string, string] | null, through: [string, string] | null,
    count: number): Promise<[string, string][]> {
    if (count < 1) return [];
    const values: unknown[] = [count];
    const bound = (pair: [string, string]) => { values.push(...pair); return `($${values.length - 1}::text,$${values.length}::text)`; };
    const start = after ? `AND (space_id,collection_id)>${bound(after)}` : '';
    const end = through ? `WHERE (space_id,collection_id)<=${bound(through)}` : '';
    const rows = await db.query(`WITH RECURSIVE pairs(space_id,collection_id,n) AS (
        (SELECT space_id,collection_id,1 FROM projection_outbox WHERE ${LIVE_OUTBOX} ${start}
          ORDER BY space_id,collection_id LIMIT 1)
        UNION ALL
        SELECT next.space_id,next.collection_id,p.n+1 FROM pairs p CROSS JOIN LATERAL (
          SELECT space_id,collection_id FROM projection_outbox
          WHERE ${LIVE_OUTBOX} AND (space_id,collection_id)>(p.space_id,p.collection_id)
          ORDER BY space_id,collection_id LIMIT 1) next
        WHERE p.n<$1)
      SELECT space_id,collection_id FROM pairs ${end} ORDER BY n`, values);
    return rows.rows.map(row => [row.space_id, row.collection_id]);
  }

  /** Undo leases whose hints were not sent, or whose work must re-run under fresh scope. */
  async release(messages: readonly DeliveryMessage[]): Promise<number> {
    const fixed = messages.map(message => this.message(message));
    if (!fixed.length) return 0;
    return inTransaction(this.pool, async db => (await db.query(`UPDATE projection_outbox o
      SET delivery_state=CASE WHEN o.failures>0 THEN 'degraded' ELSE 'pending' END,
        started_attempt=NULL,available_at=clock_timestamp()
      FROM unnest($1::text[],$2::integer[]) AS m(event_id,attempt)
      WHERE o.event_id=m.event_id AND o.attempts=m.attempt AND o.delivery_state='delivering'`,
    [fixed.map(message => message.eventId), fixed.map(message => message.attempt)])).rowCount ?? 0);
  }

  /**
   * Process one hint at least once. Only the first start of a current lease
   * proceeds, so duplicate and late messages are no-ops. A projector failure
   * or overrun is recorded against the lease; a policy, placement or
   * lifecycle change releases it so a later claim re-runs under fresh scope.
   */
  async process(message: DeliveryMessage, projector?: Projector): Promise<ProcessOutcome> {
    const { eventId, attempt } = this.message(message);
    const deadline = Date.now() + PROCESSING_BUDGET_MS;
    const row = await inTransaction(this.pool, async db => (await db.query(`UPDATE projection_outbox o
      SET started_attempt=o.attempts,available_at=clock_timestamp()+($3::integer * interval '1 millisecond')
      FROM spaces s, record_events e
      WHERE o.event_id=$1 AND o.attempts=$2 AND o.delivery_state='delivering' AND o.available_at>clock_timestamp()
        AND o.started_attempt IS DISTINCT FROM o.attempts AND s.space_id=o.space_id AND e.event_id=o.event_id
      RETURNING o.space_id,o.collection_id,o.record_id,o.revision,o.generation,
        s.policy_version,s.placement_generation,e.operation,e.canonical_data`,
    [eventId, attempt, PROCESSING_LEASE_MS])).rows[0]);
    if (!row) return 'lost';
    const ref = { spaceId: row.space_id, collectionId: row.collection_id, id: row.record_id };
    const delivery: OutboxDelivery = { eventId, ref, revision: Number(row.revision), generation: Number(row.generation), attempt };
    const scope: AuthorityScope = { spaceId: row.space_id, collectionId: row.collection_id, ...WORKER,
      policyVersion: Number(row.policy_version), placementGeneration: Number(row.placement_generation) };
    const deleted = row.operation === 'delete';
    const change: ProjectionChange = { ref, revision: delivery.revision, generation: delivery.generation, deleted,
      canonicalData: deleted ? null : row.canonical_data };
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      let prepared: unknown;
      if (projector?.prepare) {
        try { prepared = await within(projector.prepare(change, signal), signal); }
        catch (error) { throw new ProjectorFailure('prepare failed', { cause: error }); }
      }
      const apply = projector && (async (current: ProjectionChange, query: ProjectionQuery) => {
        try { await projector.apply(current, prepared, query); }
        catch (error) { throw new ProjectorFailure('apply failed', { cause: error }); }
      });
      return await this.authority.transaction(scope, tx => tx.completeProjection(delivery, apply), deadline);
    } catch (error) {
      if (error instanceof ProjectorFailure || (error instanceof AuthorityError && error.code === 'RATE_LIMITED')) {
        await this.fail(delivery, diagnostic(error));
        return 'failed';
      }
      if (error instanceof AuthorityError && ['FORBIDDEN', 'SPACE_UNAVAILABLE', 'NOT_FOUND'].includes(error.code)) {
        await this.release([message]);
        return 'released';
      }
      throw error;
    }
  }

  /** Record a failed lease outside the rolled-back completion transaction. */
  private fail(delivery: OutboxDelivery, error: string): Promise<boolean> {
    return inTransaction(this.pool, async db => (await db.query(failOutboxSql, [delivery.ref.spaceId, delivery.ref.collectionId,
      delivery.eventId, delivery.attempt, delivery.revision, delivery.generation, error])).rowCount === 1);
  }

  private message(message: DeliveryMessage): DeliveryMessage {
    if (typeof message?.eventId !== 'string' || !EVENT_ID.test(message.eventId)) throw new AuthorityError('INVALID_ARGUMENT');
    return { eventId: message.eventId, attempt: bounded(message.attempt, 1, 2_147_483_647) };
  }

  /** Report backlog, lag and failures per space/collection, plus the dispatcher's last tick. */
  async status(spaceId?: string): Promise<CellOutboxStatus> {
    const space = spaceId === undefined ? null : text(spaceId, 512);
    return inTransaction(this.pool, async db => {
      const collections = await db.query(`SELECT o.space_id,o.collection_id,
          count(*) FILTER (WHERE o.delivery_state='pending')::int AS pending,
          count(*) FILTER (WHERE o.delivery_state='delivering')::int AS delivering,
          count(*) FILTER (WHERE o.delivery_state='degraded' AND o.dead_lettered_at IS NULL)::int AS degraded,
          count(*) FILTER (WHERE o.dead_lettered_at IS NOT NULL)::int AS dead_lettered,
          min(e.committed_at) AS oldest,
          extract(epoch FROM clock_timestamp()-min(e.committed_at))::float8 AS lag,
          (array_agg(o.last_error ORDER BY e.committed_at DESC) FILTER (WHERE o.last_error IS NOT NULL))[1] AS last_error
        FROM projection_outbox o JOIN record_events e ON e.event_id=o.event_id
        WHERE o.${LIVE_OUTBOX} AND ($1::text IS NULL OR o.space_id=$1)
        GROUP BY o.space_id,o.collection_id ORDER BY o.space_id,o.collection_id LIMIT ${STATUS_ROWS}`, [space]);
      const jobs = await db.query(`SELECT * FROM projection_reconciliations
        WHERE ($1::text IS NULL OR space_id=$1) AND (state='running' OR updated_at>clock_timestamp()-interval '1 day')
        ORDER BY created_at DESC,job_id LIMIT ${STATUS_ROWS}`, [space]);
      const checkpoint = (await db.query('SELECT dispatched_at FROM outbox_dispatch_checkpoint')).rows[0];
      return {
        lastDispatchAt: checkpoint?.dispatched_at ? new Date(checkpoint.dispatched_at).toISOString() : null,
        collections: collections.rows.map(row => ({ spaceId: row.space_id, collectionId: row.collection_id,
          pending: row.pending, delivering: row.delivering, degraded: row.degraded, deadLettered: row.dead_lettered,
          oldestUndeliveredAt: row.oldest ? new Date(row.oldest).toISOString() : null,
          lagSeconds: row.lag === null ? null : Math.max(0, Math.floor(row.lag)), lastError: row.last_error })),
        reconciliations: jobs.rows.map(row => this.job(row))
      };
    });
  }

  /** Return a space's dead letters to the due queue with a fresh failure budget. Audited. */
  async retry(operator: string, spaceId: string, collectionId: string | null, reason: string): Promise<number> {
    const who = text(operator, 256);
    const why = text(reason, 1024);
    const space = text(spaceId, 512);
    const collection = collectionId === null ? null : text(collectionId, 512);
    return inTransaction(this.pool, async db => {
      await this.lockSpace(db, space, ['active', 'readOnly', 'suspended']);
      const retried = await db.query(`UPDATE projection_outbox SET delivery_state='pending',failures=0,started_attempt=NULL,
          dead_lettered_at=NULL,available_at=clock_timestamp()
        WHERE space_id=$1 AND ($2::text IS NULL OR collection_id=$2) AND ${LIVE_OUTBOX} AND dead_lettered_at IS NOT NULL`,
      [space, collection]);
      const affected = retried.rowCount ?? 0;
      await this.audit(db, { space, collection, action: 'retry', who, why, job: null, affected });
      return affected;
    });
  }

  /** Start, or return, the one running reconciliation for a collection. Audited when started. */
  async reconcile(operator: string, spaceId: string, collectionId: string, reason: string): Promise<{ jobId: string; created: boolean }> {
    const who = text(operator, 256);
    const why = text(reason, 1024);
    const space = text(spaceId, 512);
    const collection = text(collectionId, 512);
    return inTransaction(this.pool, async db => {
      await this.lockSpace(db, space, ['active', 'readOnly']);
      const found = await db.query(`SELECT lifecycle FROM collections WHERE space_id=$1 AND collection_id=$2 FOR SHARE`, [space, collection]);
      if (!found.rows[0] || found.rows[0].lifecycle === 'deleted') throw new AuthorityError('NOT_FOUND');
      const inserted = await db.query(`INSERT INTO projection_reconciliations(job_id,space_id,collection_id) VALUES($1,$2,$3)
        ON CONFLICT (space_id,collection_id) WHERE state='running' DO NOTHING RETURNING job_id`, [`rcn_${randomUUID()}`, space, collection]);
      if (!inserted.rows[0]) {
        const running = await db.query(`SELECT job_id FROM projection_reconciliations
          WHERE space_id=$1 AND collection_id=$2 AND state='running'`, [space, collection]);
        return { jobId: running.rows[0].job_id, created: false };
      }
      const jobId = inserted.rows[0].job_id;
      await this.audit(db, { space, collection, action: 'reconcile', who, why, job: jobId, affected: 0 });
      return { jobId, created: true };
    });
  }

  /** Stop a running reconciliation before its next page. Requeued work stays queued. Audited. */
  async cancel(operator: string, jobId: string, reason: string): Promise<ReconciliationStatus> {
    const who = text(operator, 256);
    const why = text(reason, 1024);
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new AuthorityError('INVALID_ARGUMENT');
    return inTransaction(this.pool, async db => {
      const cancelled = await db.query(`UPDATE projection_reconciliations SET state='cancelled',updated_at=clock_timestamp()
        WHERE job_id=$1 AND state='running' RETURNING *`, [jobId]);
      const row = cancelled.rows[0] ?? (await db.query('SELECT * FROM projection_reconciliations WHERE job_id=$1', [jobId])).rows[0];
      if (!row) throw new AuthorityError('NOT_FOUND');
      if (cancelled.rows[0]) await this.audit(db, { space: row.space_id, collection: row.collection_id, action: 'cancel',
        who, why, job: jobId, affected: 0 });
      return this.job(row);
    });
  }

  /**
   * Advance up to `jobs` reconciliations by one keyset page each, oldest turn
   * first. A record is requeued when its latest revision was delivered but
   * its head is missing, behind, or from an earlier placement generation.
   * Live and dead-lettered rows are left to delivery and operator retry.
   */
  async stepReconciliations(jobs = 4, pageSize = 100): Promise<number> {
    bounded(jobs, 1, 32);
    bounded(pageSize, 1, 500);
    let stepped = 0;
    for (let index = 0; index < jobs; index++) {
      const advanced = await inTransaction(this.pool, async db => {
        const job = (await db.query(`SELECT j.job_id,j.space_id,j.collection_id,j.after_record_id,
            s.lifecycle,s.placement_generation,c.lifecycle AS collection_lifecycle
          FROM projection_reconciliations j JOIN spaces s ON s.space_id=j.space_id
          JOIN collections c ON c.space_id=j.space_id AND c.collection_id=j.collection_id
          WHERE j.state='running' AND j.next_step_at<=clock_timestamp()
          ORDER BY j.next_step_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1`)).rows[0];
        if (!job) return false;
        if (job.collection_lifecycle === 'deleted') {
          await db.query(`UPDATE projection_reconciliations SET state='cancelled',updated_at=clock_timestamp() WHERE job_id=$1`, [job.job_id]);
          return true;
        }
        if (!['active', 'readOnly'].includes(job.lifecycle)) {
          await db.query(`UPDATE projection_reconciliations SET next_step_at=clock_timestamp()+($2::integer * interval '1 second')
            WHERE job_id=$1`, [job.job_id, PAUSED_STEP_SECONDS]);
          return true;
        }
        const page = (await db.query(`WITH page AS (
            SELECT record_id,revision FROM records WHERE space_id=$1 AND collection_id=$2
              AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4
          ), stale AS (
            SELECT o.event_id FROM page p
            JOIN record_events e ON e.space_id=$1 AND e.collection_id=$2 AND e.record_id=p.record_id AND e.revision=p.revision
            JOIN projection_outbox o ON o.event_id=e.event_id
            LEFT JOIN projection_heads h ON h.space_id=$1 AND h.collection_id=$2 AND h.record_id=p.record_id
            WHERE o.delivery_state='delivered' AND (h.record_id IS NULL OR h.generation<>$5 OR h.revision<p.revision)
          ), requeued AS (
            UPDATE projection_outbox o SET delivery_state='pending',generation=$5,outcome=NULL,delivered_at=NULL,
              failures=0,started_attempt=NULL,last_error=NULL,available_at=clock_timestamp()
            FROM stale WHERE o.event_id=stale.event_id AND o.delivery_state='delivered' RETURNING 1
          )
          SELECT (SELECT count(*) FROM page)::int AS scanned,(SELECT count(*) FROM requeued)::int AS requeued,
            (SELECT max(record_id) FROM page) AS last`,
        [job.space_id, job.collection_id, job.after_record_id, pageSize, job.placement_generation])).rows[0];
        await db.query(`UPDATE projection_reconciliations SET after_record_id=COALESCE($2,after_record_id),
            scanned=scanned+$3,requeued=requeued+$4,state=CASE WHEN $3<$5 THEN 'completed' ELSE 'running' END,
            next_step_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE job_id=$1`, [job.job_id, page.last, page.scanned, page.requeued, pageSize]);
        return true;
      });
      if (!advanced) break;
      stepped++;
    }
    return stepped;
  }

  /** Read one reconciliation's durable progress. */
  async reconciliation(jobId: string): Promise<ReconciliationStatus> {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new AuthorityError('INVALID_ARGUMENT');
    return inTransaction(this.pool, async db => {
      const row = (await db.query('SELECT * FROM projection_reconciliations WHERE job_id=$1', [jobId])).rows[0];
      if (!row) throw new AuthorityError('NOT_FOUND');
      return this.job(row);
    });
  }

  /** Serialize operator effects with lifecycle changes and erasure of the space. */
  private async lockSpace(db: pg.PoolClient, spaceId: string, allowed: readonly string[]): Promise<void> {
    const row = (await db.query('SELECT lifecycle FROM spaces WHERE space_id=$1 FOR SHARE', [spaceId])).rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    if (!allowed.includes(row.lifecycle)) throw new AuthorityError('SPACE_UNAVAILABLE');
  }

  private async audit(db: pg.PoolClient, entry: { space: string; collection: string | null; action: string; who: string;
    why: string; job: string | null; affected: number }): Promise<void> {
    await db.query(`INSERT INTO outbox_operator_audit(audit_id,space_id,collection_id,action,operator,reason,job_id,affected)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [`oba_${randomUUID()}`, entry.space, entry.collection, entry.action, entry.who,
      entry.why, entry.job, entry.affected]);
  }

  private job(row: Record<string, unknown>): ReconciliationStatus {
    return { jobId: String(row.job_id), spaceId: String(row.space_id), collectionId: String(row.collection_id),
      state: row.state as ReconciliationStatus['state'], scanned: Number(row.scanned), requeued: Number(row.requeued),
      createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
  }
}

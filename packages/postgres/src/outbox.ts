import { randomUUID } from 'node:crypto';
import { MAX_DELIVERY_ATTEMPT } from '@stateplane/contracts';
import type pg from 'pg';
import { AuthorityError, clientReadTimedOut, CommitOutcomeUnknownError } from './index.js';
import type { AuthorityScope, OutboxDelivery, PostgresAuthority, ProjectionChange, ProjectionOutcome, ProjectionQuery } from './index.js';
import { claimOutboxSql, FAILED_OUTBOX, failOutboxSql, LIVE_OUTBOX } from './outbox-sql.js';
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
export interface DispatchLimits { limit?: number; perSpace?: number; pairs?: number; leaseSeconds?: number; inFlight?: number }
/**
 * How far one claim's pair walk got: `whole` visited every live pair,
 * `wrapped` began at or passed the start of the pair order, `partial` did
 * neither. An empty claim alone does not mean nothing is due. `parked`
 * counts rows the claim moved to the dead letter instead of leasing, so a
 * claim with no messages may still have made progress. `full` means the
 * cell's unstarted dispatch leases reached `inFlight`, so dispatch waits for
 * consumers to start them.
 */
export interface ClaimResult { messages: DeliveryMessage[]; scan: 'whole' | 'wrapped' | 'partial'; parked: number; full: boolean }
export interface OutboxOptions { processingMs?: number; retryPage?: number; statusPairs?: number }
/** A status page's last pair; the next page starts strictly after it. */
export interface StatusCursor { spaceId: string; collectionId: string }
/**
 * `pending`, `delivering` and lag cover at most the oldest-due
 * `STATUS_SAMPLE` live rows, and `capped` marks them as lower bounds.
 * `degraded`, `deadLettered` and `lastError` come from a separate sample of
 * up to `STATUS_SAMPLE` failed rows, wherever they are parked;
 * `failuresCapped` marks those counts as lower bounds. Without a failed
 * row, `lastError` is the live sample's latest uncounted release reason.
 */
export interface CollectionOutboxStatus {
  spaceId: string; collectionId: string; pending: number; delivering: number; degraded: number; deadLettered: number;
  capped: boolean; failuresCapped: boolean; oldestUndeliveredAt: string | null; lagSeconds: number | null; lastError: string | null;
}
export interface ReconciliationStatus {
  jobId: string; spaceId: string; collectionId: string; state: 'running' | 'completed' | 'cancelled';
  cause: 'operator' | 'placement'; scanned: number; requeued: number; createdAt: string; updatedAt: string;
}
/**
 * `more` means further collections with live rows exist beyond the reported
 * page, and `next` is then the cursor to pass for the following page.
 */
export interface CellOutboxStatus {
  lastDispatchAt: string | null; collections: CollectionOutboxStatus[]; more: boolean; next: StatusCursor | null;
  reconciliations: ReconciliationStatus[];
}

const EVENT_ID = /^evt_[0-9a-f-]{36}$/;
const JOB_ID = /^rcn_[0-9a-f-]{36}$/;
const WORKER = { principalId: 'system:projection', credentialId: 'system:projection', capability: 'outbox:worker' } as const;
// Initial protective bounds, not measured provider capacity: one statement
// stays short, and one started item must finish well inside its lease. The
// processing budget is the authority's request budget (at most 30 s), and
// the stalled-apply backstop adds 5 s.
const STATEMENT_MS = 5_000;
const PROCESSING_LEASE_MS = 60_000;
const STATUS_ROWS = 1_000;
// Status reads at most STATUS_PAIRS × 2 × STATUS_SAMPLE live rows, so it stays
// usable during the backlog it reports. See docs/durable-outbox.md.
const STATUS_PAIRS = 200;
const STATUS_SAMPLE = 500;
const PAUSED_STEP_SECONDS = 60;
const RETRY_PAGE = 1_000;
// A started lease released uncounted waits this long, so a fault that is
// misclassified as infrastructure cannot retry in a tight loop.
const RELEASE_BACKOFF_MS = 5_000;
/**
 * Release leases $1/$2 that are started ($4) or not, due again after $3 ms.
 * A non-null $5 records why, without spending the failure budget.
 */
const RELEASE_SQL = `UPDATE projection_outbox o
  SET delivery_state=CASE WHEN o.failures>0 THEN 'degraded' ELSE 'pending' END,
    started_attempt=NULL,available_at=clock_timestamp()+($3::integer * interval '1 millisecond'),
    last_error=COALESCE($5::text,o.last_error)
  FROM unnest($1::text[],$2::integer[]) AS m(event_id,attempt)
  WHERE o.event_id=m.event_id AND o.attempts=m.attempt AND o.delivery_state='delivering'
    AND (o.started_attempt IS NOT DISTINCT FROM o.attempts)=$4::boolean`;

class ProjectorFailure extends Error {}

// A lost session, a rolled-back serialization or deadlock, exhausted
// resources, a lock budget, a server shutdown or a system I/O error, plus the
// driver's socket, connection and client read errors. A statement timeout is
// not here: an overrun is the item's. The client read bound sits past every
// server bound (CLIENT_READ_TIMEOUT_MS), so it fires only on a lost session.
const INFRASTRUCTURE_SQLSTATE = /^(?:(?:08|40|53|58)[0-9A-Z]{3}|55P03|57P0[0-9])$/;
function infrastructureFault(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AuthorityError) return false;
  const code = (error as { code?: unknown }).code;
  // Socket errnos such as ECONNRESET, not Node's ERR_* programming errors.
  if (typeof code === 'string') return INFRASTRUCTURE_SQLSTATE.test(code) || (/^E[A-Z_]+$/.test(code) && !code.startsWith('ERR_'));
  return clientReadTimedOut(error) || /^Connection terminated|not queryable|^timeout exceeded when trying to connect/.test(error.message);
}

// An error reply from a live session means the server rolled COMMIT back.
// Session loss, shutdown, resource and internal errors may arrive at FATAL or
// PANIC after the commit record, so they stay ambiguous.
function rolledBack(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^(?:08|53|57P|58|XX)/.test(code);
}

/** Run one short cell transaction; a missing COMMIT acknowledgement stays ambiguous. */
async function inTransaction<T>(pool: PoolLike, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  // An unacknowledged BEGIN or COMMIT leaves the session state unknown.
  let discard = true;
  // The pool detaches its listener on checkout; a server-ended session must
  // fail this transaction, not the process.
  const onError = () => { discard = true; };
  client.on?.('error', onError);
  try {
    await client.query('BEGIN'); begun = true; discard = false;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    const result = await fn(client);
    try { await client.query('COMMIT'); begun = false; }
    catch (error) { discard = true; begun = false; throw new CommitOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (clientReadTimedOut(error)) discard = true;
    else if (begun) await client.query('ROLLBACK').catch(() => { discard = true; });
    throw error;
  } finally { client.release(discard); client.removeListener?.('error', onError); }
}

function bounded(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new AuthorityError('INVALID_ARGUMENT');
  return value as number;
}

function text(value: unknown, maxBytes: number): string {
  if (!scalarString(value) || !value || Buffer.byteLength(value) > maxBytes) throw new AuthorityError('INVALID_ARGUMENT');
  return value;
}

/**
 * Keep a bounded, NUL-free diagnostic. Projectors must not put record content
 * in errors. Postgres and Node errors can quote the values they rejected, so
 * an error with a SQLSTATE or ERR_* code keeps only its name and code.
 */
function diagnostic(error: unknown): string {
  const cause = error instanceof ProjectorFailure ? error.cause : error;
  if (!(cause instanceof Error)) return 'Projection failed';
  const code = (cause as { code?: unknown }).code;
  const coded = !(cause instanceof AuthorityError) && typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || code.startsWith('ERR_'));
  const message = coded ? `${cause.name} ${code}` : `${cause.name}: ${cause.message}`;
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
  private readonly processingMs: number;
  private readonly retryPage: number;
  private readonly statusPairs: number;
  /**
   * `processingMs` bounds one item's prepare, apply and completion. Its
   * default and maximum is the authority's request budget, so one deadline
   * drives the abort signal, every statement timeout and the stalled-apply
   * backstop, and the worker's own rollback always comes first.
   * `retryPage` (at most 1,000) sizes operator retry's keyset pages, and
   * `statusPairs` (at most 200) the collections in one status page.
   */
  constructor(private readonly pool: PoolLike, private readonly authority: PostgresAuthority, options: OutboxOptions = {}) {
    this.processingMs = bounded(options.processingMs ?? authority.requestBudgetMs, 1, authority.requestBudgetMs);
    this.retryPage = bounded(options.retryPage ?? RETRY_PAGE, 1, RETRY_PAGE);
    this.statusPairs = bounded(options.statusPairs ?? STATUS_PAIRS, 1, STATUS_PAIRS);
  }

  /**
   * Lease due work for dispatch. A rotating cursor bounds each scan to
   * `pairs` space/collection pairs and each space to `perSpace` rows per
   * claim. Spaces are served by turn and then in cursor order; when `limit`
   * cuts a claim short, the cursor moves past the last pair served, so the
   * next claim starts with the pairs that missed out. A dispatch lease is not
   * started: if the hint is lost, the lease expires and is reclaimed without
   * spending the row's failure budget. A row whose failure budget is spent
   * is parked instead and counts as served. While another dispatcher holds the
   * cursor, a claim returns nothing as a `whole` scan. At most `inFlight`
   * unexpired dispatch leases stay unstarted per cell, so dispatch cannot
   * outrun its consumers by more than that.
   */
  async claim(limits: DispatchLimits = {}): Promise<ClaimResult> {
    const most = bounded(limits.limit ?? 100, 1, 100);
    const perSpace = bounded(limits.perSpace ?? Math.min(25, most), 1, most);
    const pairs = bounded(limits.pairs ?? 200, 1, 1_000);
    const leaseSeconds = bounded(limits.leaseSeconds ?? 300, 1, 3_600);
    const inFlight = bounded(limits.inFlight ?? 5_000, 1, 100_000);
    return inTransaction(this.pool, async db => {
      const cursor = (await db.query(`SELECT after_space_id,after_collection_id FROM outbox_dispatch_checkpoint
        FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!cursor) return { messages: [], scan: 'whole', parked: 0, full: false };
      // The cursor lock serializes dispatchers, so this bounded count holds for the claim.
      const { unstarted } = (await db.query(`SELECT count(*)::int AS unstarted FROM (SELECT 1 FROM projection_outbox
        WHERE delivery_state='delivering' AND started_attempt IS NULL AND available_at>clock_timestamp() LIMIT $1) o`,
      [inFlight])).rows[0];
      const limit = Math.min(most, inFlight - unstarted);
      if (limit < 1) {
        await db.query('UPDATE outbox_dispatch_checkpoint SET dispatched_at=clock_timestamp()');
        return { messages: [], scan: 'partial', parked: 0, full: true };
      }
      const after: [string, string] | null = cursor.after_space_id === null ? null : [cursor.after_space_id, cursor.after_collection_id];
      let scanned = await this.scanPairs(db, after, null, pairs);
      let next = scanned.length === pairs ? scanned.at(-1)! : null;
      let scan: ClaimResult['scan'] = after ? 'partial' : next ? 'wrapped' : 'whole';
      if (after && scanned.length < pairs) {
        // Wrap to the start and stop at the old cursor; a short wrap means
        // every live pair was visited and the next claim starts over.
        const budget = pairs - scanned.length;
        const wrapped = await this.scanPairs(db, null, after, budget);
        scanned = [...scanned, ...wrapped];
        next = wrapped.length === budget ? wrapped.at(-1)! : null;
        scan = next ? 'wrapped' : 'whole';
      }
      const due = `SELECT o.event_id FROM projection_outbox o JOIN (
          SELECT event_id FROM (
            SELECT due.event_id,due.available_at,p.n,
              row_number() OVER (PARTITION BY p.space_id ORDER BY due.available_at,due.event_id) AS turn
            FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS p(space_id,collection_id,n)
            JOIN spaces s ON s.space_id=p.space_id AND s.lifecycle IN ('active','readOnly')
            JOIN collections c ON c.space_id=p.space_id AND c.collection_id=p.collection_id AND c.lifecycle<>'deleted'
            CROSS JOIN LATERAL (SELECT event_id,available_at FROM projection_outbox
              WHERE space_id=p.space_id AND collection_id=p.collection_id AND ${LIVE_OUTBOX}
                AND available_at<=clock_timestamp()
              ORDER BY available_at,event_id LIMIT $3) due
          ) ranked WHERE turn<=$3 ORDER BY turn,n,available_at,event_id LIMIT $4
        ) picked ON picked.event_id=o.event_id
        WHERE o.${LIVE_OUTBOX} AND o.available_at<=clock_timestamp()
        FOR UPDATE OF o SKIP LOCKED`;
      const claimed = await db.query(claimOutboxSql(due, '$5', 'false'),
        [scanned.map(pair => pair[0]), scanned.map(pair => pair[1]), perSpace, limit, leaseSeconds]);
      if (claimed.rows.length >= limit) {
        const served = new Set(claimed.rows.map(row => JSON.stringify([row.space_id, row.collection_id])));
        next = [...scanned].reverse().find(pair => served.has(JSON.stringify(pair))) ?? next;
      }
      await db.query(`UPDATE outbox_dispatch_checkpoint SET after_space_id=$1,after_collection_id=$2,
        dispatched_at=clock_timestamp()`, [next?.[0] ?? null, next?.[1] ?? null]);
      const leased = claimed.rows.filter(row => !row.parked);
      return { messages: leased.map(row => ({ eventId: row.event_id, attempt: row.attempts })), scan,
        parked: claimed.rows.length - leased.length, full: unstarted + leased.length >= inFlight };
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

  /** Undo unstarted leases whose hints were not sent. A lease a worker has started is left to it. */
  release(messages: readonly DeliveryMessage[]): Promise<number> { return this.releaseLeases(messages, false); }

  private async releaseLeases(messages: readonly DeliveryMessage[], started: boolean, error: string | null = null): Promise<number> {
    const fixed = messages.map(message => this.message(message));
    if (!fixed.length) return 0;
    return inTransaction(this.pool, async db => (await db.query(RELEASE_SQL, [fixed.map(message => message.eventId),
      fixed.map(message => message.attempt), started ? RELEASE_BACKOFF_MS : 0, started, error])).rowCount ?? 0);
  }

  /**
   * Process one hint at least once. A hint starts the row's current
   * dispatch lease if no worker has started it, even when the hint is from
   * an earlier lease, so a backlog converges however late its hints arrive.
   * Only one start per lease proceeds, so duplicates are no-ops. Start fences the
   * space, collection, placement and latest revision before any projector
   * sees content: a closed scope releases the lease, and work from an earlier
   * placement or below the record's committed revision is requeued or
   * superseded without running the projector. A projector
   * failure, overrun or any unclassified error is recorded against the
   * lease; a policy, placement or lifecycle change at completion releases it
   * so a later claim re-runs it under fresh scope. The budget bounds prepare,
   * apply and completion. An infrastructure fault or lock budget with a
   * known rollback, including one from apply's query port or an error reply
   * to COMMIT, releases the lease uncounted after a short backoff, records
   * its bounded diagnostic and is rethrown.
   */
  async process(message: DeliveryMessage, projector?: Projector): Promise<ProcessOutcome> {
    const { eventId, attempt: hinted } = this.message(message);
    const deadline = Date.now() + this.processingMs;
    const row = await inTransaction(this.pool, async db => {
      // Lock the row alone, then read scope and content in a later statement.
      // A lock wait rechecks only the locked row, so a suspension, delete or
      // fence that commits while start waits would otherwise go unseen.
      const locked = await db.query(`SELECT 1 FROM projection_outbox WHERE event_id=$1 AND attempts>=$2
        AND delivery_state='delivering' AND started_attempt IS DISTINCT FROM attempts FOR UPDATE`, [eventId, hinted]);
      if (!locked.rows[0]) return null;
      const found = (await db.query(`SELECT o.space_id,o.collection_id,o.record_id,o.revision,o.generation,o.attempts,
          s.policy_version,s.placement_generation,e.operation,
          s.lifecycle IN ('active','readOnly') AND c.lifecycle<>'deleted' AS open,
          o.generation=s.placement_generation AS placed,r.revision IS NOT DISTINCT FROM o.revision AS latest,
          CASE WHEN s.lifecycle IN ('active','readOnly') AND c.lifecycle<>'deleted' AND o.generation=s.placement_generation
            AND r.revision=o.revision AND e.operation<>'delete' THEN e.canonical_data END AS canonical_data
        FROM projection_outbox o JOIN spaces s ON s.space_id=o.space_id
        JOIN collections c ON c.space_id=o.space_id AND c.collection_id=o.collection_id
        JOIN record_events e ON e.event_id=o.event_id
        LEFT JOIN records r ON r.space_id=o.space_id AND r.collection_id=o.collection_id AND r.record_id=o.record_id
        WHERE o.event_id=$1`, [eventId])).rows[0];
      if (!found) return null;
      if (!found.open) await db.query(RELEASE_SQL, [[eventId], [found.attempts], 0, false, null]);
      else await db.query(`UPDATE projection_outbox SET started_attempt=attempts,
          available_at=clock_timestamp()+($2::integer * interval '1 millisecond') WHERE event_id=$1`,
      [eventId, PROCESSING_LEASE_MS]);
      return found;
    });
    if (!row) return 'lost';
    if (!row.open) return 'released';
    const attempt = Number(row.attempts);
    const ref = { spaceId: row.space_id, collectionId: row.collection_id, id: row.record_id };
    const delivery: OutboxDelivery = { eventId, ref, revision: Number(row.revision), generation: Number(row.generation), attempt };
    const scope: AuthorityScope = { spaceId: row.space_id, collectionId: row.collection_id, ...WORKER,
      policyVersion: Number(row.policy_version), placementGeneration: Number(row.placement_generation) };
    const deleted = row.operation === 'delete';
    const change: ProjectionChange = { ref, revision: delivery.revision, generation: delivery.generation, deleted,
      canonicalData: deleted ? null : row.canonical_data };
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    // Without a current placement, completion only requeues or supersedes,
    // and a revision whose successor already committed is only superseded.
    // A successor that commits after start can still be prepared here, and
    // completion then supersedes it.
    const active = row.placed && row.latest ? projector : undefined;
    // The first infrastructure fault apply's port saw, before any mapping.
    let fault: unknown;
    try {
      let prepared: unknown;
      if (active?.prepare) {
        try { prepared = await within(active.prepare(change, signal), signal); }
        catch (error) { throw new ProjectorFailure('prepare failed', { cause: error }); }
      }
      const apply = active && (async (current: ProjectionChange, query: ProjectionQuery) => {
        // The transaction is lost once its session faults, whatever apply
        // does with the error: later SQL gets the fault back instead of an
        // aborted-transaction error, and once apply settles, either way, the
        // fault decides the outcome.
        fault = undefined;
        const port: ProjectionQuery = (sql, values) => fault ? Promise.reject(fault) : query(sql, values).catch(error => {
          if (infrastructureFault(error)) fault ??= error;
          throw error;
        });
        let failure: unknown;
        try { await within(active.apply(current, prepared, port), signal); }
        catch (error) { failure = new ProjectorFailure('apply failed', { cause: error }); }
        if (fault) throw fault;
        if (failure) throw failure;
      });
      return await this.authority.transaction(scope, tx => tx.completeProjection(delivery, apply), deadline, signal);
    } catch (error) {
      // An unknown COMMIT outcome keeps the lease; if it did not commit, its
      // expiry counts. A server error reply to COMMIT is a known rollback.
      const cause = error instanceof CommitOutcomeUnknownError && rolledBack(error.cause) ? error.cause : error;
      if (cause instanceof CommitOutcomeUnknownError) throw error;
      if (cause instanceof AuthorityError && ['FORBIDDEN', 'SPACE_UNAVAILABLE', 'NOT_FOUND'].includes(cause.code)) {
        await this.releaseLeases([delivery], true);
        return 'released';
      }
      // Only a positively classified infrastructure failure or lock budget is
      // not the item's fault; everything else spends the failure budget. If
      // this release cannot commit, the started lease stays and its expiry
      // counts, like a crash after start.
      if (infrastructureFault(cause) || (cause instanceof AuthorityError && cause.code === 'BACKPRESSURE')) {
        await this.releaseLeases([delivery], true, diagnostic(fault ?? cause)).catch(() => 0);
        throw error;
      }
      await this.fail(delivery, diagnostic(cause));
      return 'failed';
    }
  }

  /** Record a failed lease outside the rolled-back completion transaction. */
  private fail(delivery: OutboxDelivery, error: string): Promise<boolean> {
    return inTransaction(this.pool, async db => (await db.query(failOutboxSql, [delivery.ref.spaceId, delivery.ref.collectionId,
      delivery.eventId, delivery.attempt, delivery.revision, delivery.generation, error])).rowCount === 1);
  }

  private message(message: DeliveryMessage): DeliveryMessage {
    if (typeof message?.eventId !== 'string' || !EVENT_ID.test(message.eventId)) throw new AuthorityError('INVALID_ARGUMENT');
    return { eventId: message.eventId, attempt: bounded(message.attempt, 1, MAX_DELIVERY_ATTEMPT) };
  }

  /**
   * Report backlog, lag and failures per space/collection, plus the
   * dispatcher's last tick and running or recent reconciliations, including
   * placement repairs. Work is bounded by STATUS_PAIRS × 2 × STATUS_SAMPLE rows.
   * Pages are keyset over (space, collection): pass a page's `next` as
   * `after` to read the collections strictly after it.
   */
  async status(spaceId?: string, after?: StatusCursor): Promise<CellOutboxStatus> {
    const space = spaceId === undefined ? null : text(spaceId, 512);
    const from = after === undefined ? null : [text(after?.spaceId, 512), text(after?.collectionId, 512)];
    const scope = `${LIVE_OUTBOX} AND ($1::text IS NULL OR space_id=$1)`;
    return inTransaction(this.pool, async db => {
      const collections = await db.query(`WITH RECURSIVE pairs(space_id,collection_id,n) AS (
          (SELECT space_id,collection_id,1 FROM projection_outbox
            WHERE ${scope} AND ($4::text IS NULL OR (space_id,collection_id)>($4,$5))
            ORDER BY space_id,collection_id LIMIT 1)
          UNION ALL
          SELECT next.space_id,next.collection_id,p.n+1 FROM pairs p CROSS JOIN LATERAL (
            SELECT space_id,collection_id FROM projection_outbox
            WHERE ${scope} AND (space_id,collection_id)>(p.space_id,p.collection_id)
            ORDER BY space_id,collection_id LIMIT 1) next
          WHERE p.n<=$2)
        SELECT p.space_id,p.collection_id,d.pending,d.delivering,d.capped,f.degraded,f.dead_lettered,f.failures_capped,
          COALESCE(f.last_error,d.last_error) AS last_error,LEAST(d.oldest,f.oldest) AS oldest,
          extract(epoch FROM clock_timestamp()-LEAST(d.oldest,f.oldest))::float8 AS lag
        FROM pairs p CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE o.delivery_state='pending')::int AS pending,
            count(*) FILTER (WHERE o.delivery_state='delivering')::int AS delivering,
            count(*)>=$3 AS capped, min(e.committed_at) AS oldest,
            (array_agg(o.last_error ORDER BY e.committed_at DESC) FILTER (WHERE o.last_error IS NOT NULL))[1] AS last_error
          FROM (SELECT event_id,delivery_state,last_error FROM projection_outbox
            WHERE space_id=p.space_id AND collection_id=p.collection_id AND ${LIVE_OUTBOX}
            ORDER BY available_at,event_id LIMIT $3) o JOIN record_events e ON e.event_id=o.event_id) d
        -- Dead letters and rows in backoff sort after due work, so they are
        -- sampled through their own partial index, wherever they are parked.
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE o.delivery_state='degraded' AND o.dead_lettered_at IS NULL)::int AS degraded,
            count(*) FILTER (WHERE o.dead_lettered_at IS NOT NULL)::int AS dead_lettered,
            count(*)>=$3 AS failures_capped, min(e.committed_at) AS oldest,
            (array_agg(o.last_error ORDER BY e.committed_at DESC) FILTER (WHERE o.last_error IS NOT NULL))[1] AS last_error
          FROM (SELECT event_id,delivery_state,dead_lettered_at,last_error FROM projection_outbox
            WHERE space_id=p.space_id AND collection_id=p.collection_id AND ${FAILED_OUTBOX} LIMIT $3) o
          JOIN record_events e ON e.event_id=o.event_id) f
        ORDER BY p.n`, [space, this.statusPairs, STATUS_SAMPLE, from?.[0] ?? null, from?.[1] ?? null]);
      const jobs = await db.query(`SELECT * FROM projection_reconciliations
        WHERE ($1::text IS NULL OR space_id=$1) AND (state='running' OR updated_at>clock_timestamp()-interval '1 day')
        ORDER BY created_at DESC,job_id LIMIT ${STATUS_ROWS}`, [space]);
      const checkpoint = (await db.query('SELECT dispatched_at FROM outbox_dispatch_checkpoint')).rows[0];
      const more = collections.rows.length > this.statusPairs;
      const last = collections.rows[this.statusPairs - 1];
      return {
        lastDispatchAt: checkpoint?.dispatched_at ? new Date(checkpoint.dispatched_at).toISOString() : null,
        more, next: more ? { spaceId: last.space_id, collectionId: last.collection_id } : null,
        collections: collections.rows.slice(0, this.statusPairs).map(row => ({ spaceId: row.space_id, collectionId: row.collection_id,
          pending: row.pending, delivering: row.delivering, degraded: row.degraded, deadLettered: row.dead_lettered,
          capped: row.capped, failuresCapped: row.failures_capped, oldestUndeliveredAt: row.oldest ? new Date(row.oldest).toISOString() : null,
          lagSeconds: row.lag === null ? null : Math.max(0, Math.floor(row.lag)), lastError: row.last_error })),
        reconciliations: jobs.rows.map(row => this.job(row))
      };
    });
  }

  /**
   * Return a space's dead letters to the due queue with a fresh failure
   * budget. Audited once. Keyset pages over failed rows keep each statement
   * within the statement bound however many dead letters there are.
   */
  async retry(operator: string, spaceId: string, collectionId: string | null, reason: string): Promise<number> {
    const who = text(operator, 256);
    const why = text(reason, 1024);
    const space = text(spaceId, 512);
    const collection = collectionId === null ? null : text(collectionId, 512);
    return inTransaction(this.pool, async db => {
      await this.lockSpace(db, space, ['active', 'readOnly', 'suspended']);
      let affected = 0;
      let page: { retried: number; scanned: number; collection_id: string; event_id: string } | undefined;
      do {
        page = (await db.query(`WITH page AS (
            SELECT collection_id,event_id FROM projection_outbox
            WHERE space_id=$1 AND ($2::text IS NULL OR collection_id=$2) AND ${FAILED_OUTBOX}
              AND ($3::text IS NULL OR (collection_id,event_id)>($3,$4)) ORDER BY collection_id,event_id LIMIT $5
          ), retried AS (
            UPDATE projection_outbox o SET delivery_state='pending',failures=0,started_attempt=NULL,
              dead_lettered_at=NULL,available_at=clock_timestamp()
            FROM page WHERE o.event_id=page.event_id AND o.dead_lettered_at IS NOT NULL RETURNING 1
          ) SELECT (SELECT count(*) FROM retried)::int AS retried,(SELECT count(*) FROM page)::int AS scanned,
            last.collection_id,last.event_id
          FROM (SELECT collection_id,event_id FROM page ORDER BY collection_id DESC,event_id DESC LIMIT 1) last`,
        [space, collection, page?.collection_id ?? null, page?.event_id ?? null, this.retryPage])).rows[0];
        affected += page?.retried ?? 0;
      } while (page?.scanned === this.retryPage);
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
      // The running job can end between the conflict and the lookup; try again.
      for (let tries = 0; tries < 3; tries++) {
        const inserted = await db.query(`INSERT INTO projection_reconciliations(job_id,space_id,collection_id) VALUES($1,$2,$3)
          ON CONFLICT (space_id,collection_id) WHERE state='running' DO NOTHING RETURNING job_id`, [`rcn_${randomUUID()}`, space, collection]);
        const jobId = inserted.rows[0]?.job_id;
        if (jobId) {
          await this.audit(db, { space, collection, action: 'reconcile', who, why, job: jobId, affected: 0 });
          return { jobId, created: true };
        }
        const running = await db.query(`SELECT job_id FROM projection_reconciliations
          WHERE space_id=$1 AND collection_id=$2 AND state='running'`, [space, collection]);
        if (running.rows[0]) return { jobId: running.rows[0].job_id, created: false };
      }
      throw new AuthorityError('BACKPRESSURE', 'Reconciliation changed concurrently');
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
        const job = (await db.query(`SELECT job_id,space_id,collection_id,after_record_id FROM projection_reconciliations
          WHERE state='running' AND next_step_at<=clock_timestamp()
          ORDER BY next_step_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
        if (!job) return false;
        // Scope is read by a later statement than the job lock. A fence that
        // reset this job committed before the lock was granted, so this
        // snapshot sees its generation; a later fence waits for this step
        // and then resets the job again.
        Object.assign(job, (await db.query(`SELECT s.lifecycle,s.placement_generation,c.lifecycle AS collection_lifecycle
          FROM spaces s JOIN collections c ON c.space_id=s.space_id AND c.collection_id=$2 WHERE s.space_id=$1`,
        [job.space_id, job.collection_id])).rows[0]);
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
      state: row.state as ReconciliationStatus['state'], cause: row.cause as ReconciliationStatus['cause'], scanned: Number(row.scanned), requeued: Number(row.requeued),
      createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
  }
}

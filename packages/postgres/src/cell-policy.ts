import type pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CellPolicy, RouteClaims } from '@stateplane/application';
import type { SpaceId, CollectionId } from '@stateplane/contracts';
import { AuthorityError, CommitOutcomeUnknownError, PostgresAuthority } from './index.js';
import type { AuthorityScope, AuthorityTransaction, JoinedReceiptState } from './index.js';

type PoolLike = Pick<pg.Pool, 'connect'>;
const CELL_REQUEST_TIMEOUT_MS = 30_000;
const recordsCallback = new AsyncLocalStorage<symbol>();
type JoinedAuthority = { finish: () => Promise<void>; verify: () => Promise<void>; ensureCurrent: () => Promise<number>;
  expose: () => void; close: () => void };
export interface CurrentCredential {
  current(claims: Pick<RouteClaims, 'kind' | 'credentialId'>, ownerPrincipalId?: string): Promise<boolean>;
}
export interface AuthorizedCellContext {
  readonly scope: Readonly<AuthorityScope>;
  /** Call immediately before a blob or provider effect that cannot join the SQL transaction. */
  authorizeEffect(kind?: 'read' | 'write'): Promise<void>;
  /** The caller cannot substitute a second space, collection or capability. */
  records<T>(authority: PostgresAuthority, fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T>;
}

/** The cell never accepts a bearer credential or requested principal directly. */
export class PostgresCellPolicy implements CellPolicy<AuthorizedCellContext> {
  constructor(private readonly pool: PoolLike, private readonly cellId: string,
    private readonly credentials: CurrentCredential, private readonly clock: () => number = () => Date.now(),
    private readonly requestTimeoutMs = CELL_REQUEST_TIMEOUT_MS) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > CELL_REQUEST_TIMEOUT_MS)
      throw new RangeError('Invalid cell request time budget');
  }

  private remaining(deadline: number): number {
    const left = deadline - Date.now();
    if (left <= 0) throw new AuthorityError('RATE_LIMITED', 'Cell request time budget exceeded');
    return Math.max(1, Math.trunc(left));
  }

  private async connect(deadline: number): Promise<pg.PoolClient> {
    const remaining = this.remaining(deadline);
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new AuthorityError('RATE_LIMITED', 'Cell request time budget exceeded'));
      }, remaining);
      this.pool.connect().then(client => {
        clearTimeout(timer);
        if (expired) client.release();
        else resolve(client);
      }, error => { clearTimeout(timer); if (!expired) reject(error); });
    });
  }

  /** Provider authorization is read-only; a late result cannot reopen admission. */
  private async authorizeWithin<T>(work: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = this.remaining(deadline);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AuthorityError('RATE_LIMITED', 'Cell request time budget exceeded')), remaining);
      try { work().then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  /** Reset the server-side bound before every statement so earlier work cannot extend the request. */
  private boundedClient(client: pg.PoolClient, deadline: number): pg.PoolClient {
    return { query: async (sql: string, values?: unknown[]) => {
      await client.query(`SET LOCAL statement_timeout = '${this.remaining(deadline)}ms'`);
      const result = await client.query(sql, values);
      this.remaining(deadline);
      return result;
    } } as pg.PoolClient;
  }

  private checkAssertionTime(claims: RouteClaims): void {
    if (claims.expiresAt * 1000 <= this.clock()) throw new AuthorityError('FORBIDDEN', 'Routing assertion expired');
  }

  /** A separately committed nonce keeps replay denied even if the effect rolls back. */
  private async consume(claims: RouteClaims, deadline: number): Promise<void> {
    const client = await this.connect(deadline);
    let discard = false;
    let begun = false;
    try {
      await client.query('BEGIN'); begun = true;
      const bounded = this.boundedClient(client, deadline);
      this.checkAssertionTime(claims);
      // Bound maintenance to each admission so idle Workers do not need a timer.
      // The same database clock governs pruning and insertion; Worker clock skew
      // cannot make a pruned assertion admissible again.
      await this.prune(bounded);
      const nonce = await bounded.query(`WITH eligible AS MATERIALIZED (
          SELECT 1 FROM spaces s WHERE s.space_id=$1 AND s.cell_id=$4
            AND s.policy_version=$5 AND s.placement_generation=$6
            AND s.lifecycle IN ('active','readOnly') FOR SHARE OF s
        ) INSERT INTO routing_nonces(space_id,nonce,expires_at)
        SELECT $1,$2,to_timestamp($3) FROM eligible WHERE to_timestamp($3)>clock_timestamp()
        ON CONFLICT DO NOTHING RETURNING nonce`,
      [claims.spaceId,claims.nonce,claims.expiresAt,claims.cellId,claims.policyVersion,claims.placementGeneration]);
      let admissionError: AuthorityError | undefined;
      if (nonce.rowCount !== 1) {
        const state = await bounded.query(`SELECT lifecycle,cell_id,policy_version,placement_generation
          FROM spaces WHERE space_id=$1`,[claims.spaceId]);
        const row = state.rows[0];
        if (!row || row.lifecycle === 'deleted') admissionError = new AuthorityError('NOT_FOUND');
        else if (row.cell_id !== claims.cellId || Number(row.policy_version) !== claims.policyVersion ||
          Number(row.placement_generation) !== claims.placementGeneration) admissionError = new AuthorityError('STALE_PLACEMENT');
        else if (row.lifecycle !== 'active' && row.lifecycle !== 'readOnly') admissionError = new AuthorityError('SPACE_UNAVAILABLE');
        else admissionError = new AuthorityError('FORBIDDEN', 'Routing assertion already consumed');
      }
      this.remaining(deadline);
      try { await client.query('COMMIT'); begun = false; }
      catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      if (admissionError) throw admissionError;
    } catch (error) {
      if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      if (!(error instanceof AuthorityError)) { discard = true; }
      if ((error as {code?:string}).code === '57014') throw new AuthorityError('RATE_LIMITED', 'Database statement time limit exceeded');
      throw error;
    }
    finally { client.release(discard); }
  }

  private async prune(client: pg.PoolClient): Promise<number> {
    return (await client.query(`DELETE FROM routing_nonces WHERE ctid IN (
      SELECT ctid FROM routing_nonces WHERE expires_at<=clock_timestamp()
      ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED)`)).rowCount ?? 0;
  }

  private async checkDatabaseTime(client: pg.PoolClient, claims: RouteClaims): Promise<void> {
    const result = await client.query('SELECT to_timestamp($1) > clock_timestamp() AS assertion_current', [claims.expiresAt]);
    if (result.rows[0]?.assertion_current !== true) throw new AuthorityError('FORBIDDEN', 'Routing assertion expired');
  }

  private checkAgentGrant(row: { key_principal_id?: string; key_owner_id?: string; owner_principal_id: string;
    activated_at?: Date; confirmed_at?: Date; revoked_at?: Date; key_current?: boolean;
    capabilities?: string[]; grant_current?: boolean }, claims: RouteClaims): string {
    if (!row.key_principal_id || row.key_owner_id !== row.owner_principal_id || !row.activated_at || !row.confirmed_at || row.revoked_at ||
      !row.key_current || !row.capabilities?.includes(claims.capability) || !row.grant_current) throw new AuthorityError('FORBIDDEN');
    return row.key_principal_id;
  }

  /** Optional maintenance uses the same bounded database-clock rule as admission. */
  async cleanupExpiredNonces(): Promise<number> {
    const result = await this.pool.connect();
    try { return await this.prune(result); }
    finally { result.release(); }
  }

  private async check(client: pg.PoolClient, claims: RouteClaims, deadline: number, requireActiveSpace = false): Promise<string> {
    const checkStarted = performance.now();
    const result = await client.query(`SELECT s.owner_principal_id,s.lifecycle,s.cell_id,s.policy_version,s.placement_generation,
      c.lifecycle AS collection_lifecycle, sc.principal_id AS key_principal_id,
      sc.owner_principal_id AS key_owner_id,sc.revoked_at,sc.activated_at,sc.confirmed_at,
      sc.expires_at > clock_timestamp() AS key_current,
      g.capabilities,(g.expires_at IS NULL OR g.expires_at > clock_timestamp()) AS grant_current,
      EXTRACT(EPOCH FROM (CASE WHEN $5='session' THEN to_timestamp($4)
        ELSE LEAST(to_timestamp($4),COALESCE(sc.expires_at,'infinity'::timestamptz),
          COALESCE(g.expires_at,'infinity'::timestamptz)) END - clock_timestamp())) * 1000 AS validity_ms
      FROM spaces s JOIN collections c ON c.space_id=s.space_id AND c.collection_id=$2
      LEFT JOIN LATERAL (SELECT principal_id,owner_principal_id,revoked_at,activated_at,confirmed_at,expires_at FROM space_credentials
        WHERE space_id=s.space_id AND credential_id=$3 FOR SHARE) sc ON TRUE
      LEFT JOIN LATERAL (SELECT capabilities,expires_at FROM collection_grants
        WHERE space_id=s.space_id AND collection_id=c.collection_id AND credential_id=$3 FOR SHARE) g ON TRUE
      WHERE s.space_id=$1 FOR SHARE OF s,c`, [claims.spaceId,claims.collectionId,claims.credentialId,claims.expiresAt,claims.kind]);
    const row = result.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    const policyVersion = Number(row.policy_version);
    const placementGeneration = Number(row.placement_generation);
    if (row.cell_id !== this.cellId || row.cell_id !== claims.cellId ||
      !Number.isSafeInteger(policyVersion) || !Number.isSafeInteger(placementGeneration) ||
      policyVersion !== claims.policyVersion || placementGeneration !== claims.placementGeneration) throw new AuthorityError('STALE_PLACEMENT');
    if (row.lifecycle === 'deleted' || row.collection_lifecycle === 'deleted') throw new AuthorityError('NOT_FOUND');
    if (!['active','readOnly'].includes(row.lifecycle)) throw new AuthorityError('SPACE_UNAVAILABLE');
    if (requireActiveSpace && row.lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    const mutates = claims.capability.endsWith(':write') || claims.capability === 'claims:review';
    if (row.collection_lifecycle === 'readOnly' && mutates) throw new AuthorityError('SPACE_UNAVAILABLE');
    if (row.lifecycle === 'readOnly' && mutates && claims.capability !== 'records:write') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (!await this.authorizeWithin(() => this.credentials.current(claims,row.owner_principal_id),deadline))
      throw new AuthorityError('FORBIDDEN');
    // The provider call is outside PostgreSQL. Reject if its latency crossed
    // any deadline observed by the database query before that call.
    const validityMs = Number(row.validity_ms);
    if (!Number.isFinite(validityMs) || performance.now() - checkStarted >= validityMs)
      throw new AuthorityError('FORBIDDEN');
    if (claims.kind === 'session') {
      if (claims.userPrincipalId !== row.owner_principal_id) throw new AuthorityError('FORBIDDEN');
      return row.owner_principal_id;
    }
    return this.checkAgentGrant(row,claims);
  }

  /** One database instant fences every time-based authority after the last provider await. */
  private async fenceCommit(client: pg.PoolClient, claims: RouteClaims, receipts: JoinedReceiptState,
    receiptRemaining: number, fenceStarted: number): Promise<void> {
    const collections = [...new Set([claims.collectionId,...[...receipts.replayed.values()].map(replay => replay.collectionId)])];
    const receiptIds = [...new Set([...receipts.ready.map(receipt => receipt.receiptId),
      ...[...receipts.replayed.values()].map(replay => replay.response.receiptId)])];
    const result = await client.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT to_timestamp($3)>stamp.at AS assertion_current,
        (SELECT sc.expires_at>stamp.at AND sc.revoked_at IS NULL FROM space_credentials sc
          WHERE sc.space_id=$1 AND sc.credential_id=$2) AS credential_current,
        NOT EXISTS (SELECT 1 FROM unnest($4::text[]) AS required(collection_id)
          LEFT JOIN collection_grants g ON g.space_id=$1 AND g.collection_id=required.collection_id AND g.credential_id=$2
          WHERE g.collection_id IS NULL OR NOT ($5=ANY(g.capabilities)) OR
            (g.expires_at IS NOT NULL AND g.expires_at<=stamp.at)) AS grants_current,
        (SELECT count(*)::int FROM idempotency_receipts r
          WHERE r.receipt_id=ANY($6::text[]) AND r.expires_at>stamp.at) AS current_receipts
      FROM stamp`, [claims.spaceId,claims.credentialId,claims.expiresAt,collections,claims.capability,receiptIds]);
    const row = result.rows[0];
    if (!row?.assertion_current) throw new AuthorityError('FORBIDDEN', 'Routing assertion expired');
    if (claims.kind !== 'session' && (!row.credential_current || !row.grants_current)) throw new AuthorityError('FORBIDDEN');
    if (Number(row.current_receipts) !== receiptIds.length || performance.now() - fenceStarted >= receiptRemaining)
      throw new AuthorityError('RECEIPT_EXPIRED', 'Receipt expired before commit');
  }

  async run<T>(claims: RouteClaims, effect: (principalId: string, context: AuthorizedCellContext) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.requestTimeoutMs;
    claims = Object.freeze({ ...claims });
    this.checkAssertionTime(claims);
    await this.consume(claims, deadline);
    const client = await this.connect(deadline);
    const bounded = this.boundedClient(client, deadline);
    let begun = false;
    let beginAttempted = false;
    let discard = false;
    const joined: JoinedAuthority[] = [];
    const joinedReceipts: JoinedReceiptState = {pending:new Map(),replayed:new Map(),ready:[]};
    try {
      this.checkAssertionTime(claims);
      beginAttempted = true;
      await client.query('BEGIN'); begun = true;
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(bounded,claims);
      const principalId = await this.check(bounded, claims, deadline);
      this.remaining(deadline);
      const scope: Readonly<AuthorityScope> = Object.freeze({ spaceId:claims.spaceId as SpaceId,collectionId:claims.collectionId as CollectionId,
        principalId,credentialId:claims.credentialId,capability:claims.capability,
        policyVersion:claims.policyVersion,placementGeneration:claims.placementGeneration });
      let accepting = true;
      let operationError: unknown;
      const operations = new Set<Promise<unknown>>();
      let recordsTail: Promise<void> = Promise.resolve();
      const callbackToken = Symbol('records callback');
      const admit = <TResult>(work: () => Promise<TResult>, requireActiveSpace = false,
        previous?: Promise<void>): Promise<TResult> => {
        if (!accepting) return Promise.reject(new AuthorityError('FORBIDDEN', 'Cell effect context ended'));
        const running = (async () => {
          if (previous) await previous;
          this.checkAssertionTime(claims);
          await this.check(bounded,claims,deadline,requireActiveSpace);
          await this.checkDatabaseTime(bounded,claims);
          if (!accepting) throw new AuthorityError('FORBIDDEN', 'Cell effect context ended');
          const value = await work();
          if (!accepting) throw new AuthorityError('FORBIDDEN', 'Cell effect context ended');
          this.checkAssertionTime(claims);
          await this.check(bounded,claims,deadline,requireActiveSpace);
          await this.checkDatabaseTime(bounded,claims);
          if (!accepting) throw new AuthorityError('FORBIDDEN', 'Cell effect context ended');
          return value;
        })();
        operations.add(running);
        void running.then(() => operations.delete(running), error => {
          operationError ??= error;
          operations.delete(running);
        });
        return running;
      };
      const context: AuthorizedCellContext = Object.freeze({ scope,
        authorizeEffect: (kind = 'write') => {
          if (kind !== 'read' && kind !== 'write') return Promise.reject(new AuthorityError('INVALID_ARGUMENT'));
          const allowed = kind === 'read' ? claims.capability.endsWith(':read') :
            claims.capability.endsWith(':write') || claims.capability === 'claims:review';
          if (!allowed) return Promise.reject(new AuthorityError('FORBIDDEN'));
          return admit(async () => {}, kind === 'write');
        },
        records: <TResult>(authority: PostgresAuthority, fn: (tx: AuthorityTransaction) => Promise<TResult>) => {
          // A nested awaited call would queue behind the callback awaiting it.
          // Async context distinguishes it from independent sibling calls.
          if (recordsCallback.getStore() === callbackToken)
            return Promise.reject(new AuthorityError('INVALID_ARGUMENT', 'Nested records calls are not supported'));
          const previous = recordsTail;
          const running = admit(async () => {
            return authority.transactionOnClient(client,scope,
              tx => recordsCallback.run(callbackToken, () => fn(tx)),
              (finish,verify,ensureCurrent,expose,close) => { joined.push({finish,verify,ensureCurrent,expose,close}); },joinedReceipts,deadline);
          }, false, previous);
          recordsTail = running.then(() => {}, () => {});
          return running;
        } });
      let result: T;
      try { result = await effect(principalId, context); }
      finally {
        accepting = false;
        await Promise.allSettled(operations);
      }
      if (operationError) throw operationError;
      // Clock-based expiry can occur while locks are held. Recheck immediately before commit.
      await this.check(bounded, claims, deadline);
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(bounded,claims);
      // Check provider freshness before starting the receipt retry window.
      // Joined record work remains live until the enclosing cell commit.
      for (const entry of joined) await entry.finish();
      this.checkAssertionTime(claims);
      await this.check(bounded,claims,deadline);
      await this.checkDatabaseTime(bounded,claims);
      for (const entry of joined) await entry.verify();
      // Finalization may wait on SQL. Every joined call, including a replay of
      // an original collection, must still be authorized after that wait.
      for (const entry of joined) await entry.finish();
      await this.check(bounded,claims,deadline);
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(bounded,claims);
      // The final provider lookup follows all joined SQL work. A slow lookup
      // must not consume the retry window stamped by the database clock.
      const receiptFenceStarted = performance.now();
      const receiptRemaining = joined.length ? await joined[0].ensureCurrent() : Infinity;
      await this.check(bounded,claims,deadline);
      await this.fenceCommit(bounded,claims,joinedReceipts,receiptRemaining,receiptFenceStarted);
      this.remaining(deadline);
      try { await client.query('COMMIT'); begun = false; }
      catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      for (const entry of joined) entry.expose();
      return result;
    } catch (error) {
      if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      else if (beginAttempted) discard = true;
      if ((error as {code?:string}).code === '57014') throw new AuthorityError('RATE_LIMITED', 'Database statement time limit exceeded');
      throw error;
    } finally {
      for (const entry of joined) entry.close();
      client.release(discard);
    }
  }
}

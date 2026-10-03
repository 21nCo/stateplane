import type pg from 'pg';
import type { CellPolicy, RouteClaims } from '@stateplane/application';
import type { SpaceId, CollectionId } from '@stateplane/contracts';
import { AuthorityError, CommitOutcomeUnknownError, PostgresAuthority } from './index.js';
import type { AuthorityScope, AuthorityTransaction } from './index.js';

type PoolLike = Pick<pg.Pool, 'connect'>;
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
    private readonly credentials: CurrentCredential, private readonly clock: () => number = () => Date.now()) {}

  private checkAssertionTime(claims: RouteClaims): void {
    if (claims.expiresAt * 1000 <= this.clock()) throw new AuthorityError('FORBIDDEN', 'Routing assertion expired');
  }

  /** Autocommit on a separate connection keeps replay denied even if the effect rolls back. */
  private async consume(claims: RouteClaims): Promise<void> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      this.checkAssertionTime(claims);
      // Bound maintenance to each admission so idle Workers do not need a timer.
      // The same database clock governs pruning and insertion; Worker clock skew
      // cannot make a pruned assertion admissible again.
      await this.prune(client);
      const nonce = await client.query(`INSERT INTO routing_nonces(space_id,nonce,expires_at)
        SELECT $1,$2,to_timestamp($3) WHERE to_timestamp($3)>clock_timestamp()
        ON CONFLICT DO NOTHING RETURNING nonce`,
      [claims.spaceId,claims.nonce,claims.expiresAt]);
      if (nonce.rowCount !== 1) throw new AuthorityError('FORBIDDEN', 'Routing assertion already consumed');
    } catch (error) {
      if (!(error instanceof AuthorityError)) { discard = true; }
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

  /** Optional maintenance uses the same bounded database-clock rule as admission. */
  async cleanupExpiredNonces(): Promise<number> {
    const result = await this.pool.connect();
    try { return await this.prune(result); }
    finally { result.release(); }
  }

  private async check(client: pg.PoolClient, claims: RouteClaims, requireActiveSpace = false): Promise<string> {
    const result = await client.query(`SELECT s.owner_principal_id,s.lifecycle,s.cell_id,s.policy_version,s.placement_generation,
      c.lifecycle AS collection_lifecycle, sc.principal_id AS key_principal_id,
      sc.owner_principal_id AS key_owner_id,sc.revoked_at,sc.activated_at,sc.confirmed_at,
      sc.expires_at > clock_timestamp() AS key_current,
      g.capabilities,(g.expires_at IS NULL OR g.expires_at > clock_timestamp()) AS grant_current
      FROM spaces s JOIN collections c ON c.space_id=s.space_id AND c.collection_id=$2
      LEFT JOIN LATERAL (SELECT principal_id,owner_principal_id,revoked_at,activated_at,confirmed_at,expires_at FROM space_credentials
        WHERE space_id=s.space_id AND credential_id=$3 FOR SHARE) sc ON TRUE
      LEFT JOIN LATERAL (SELECT capabilities,expires_at FROM collection_grants
        WHERE space_id=s.space_id AND collection_id=c.collection_id AND credential_id=$3 FOR SHARE) g ON TRUE
      WHERE s.space_id=$1 FOR SHARE OF s,c`, [claims.spaceId,claims.collectionId,claims.credentialId]);
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
    if (!await this.credentials.current(claims,row.owner_principal_id)) throw new AuthorityError('FORBIDDEN');
    if (claims.kind === 'session') {
      if (claims.userPrincipalId !== row.owner_principal_id) throw new AuthorityError('FORBIDDEN');
      return row.owner_principal_id;
    }
    if (!row.key_principal_id || row.key_owner_id !== row.owner_principal_id || !row.activated_at || !row.confirmed_at || row.revoked_at ||
      !row.key_current || !row.capabilities?.includes(claims.capability) || !row.grant_current) throw new AuthorityError('FORBIDDEN');
    return row.key_principal_id;
  }

  async run<T>(claims: RouteClaims, effect: (principalId: string, context: AuthorizedCellContext) => Promise<T>): Promise<T> {
    claims = Object.freeze({ ...claims });
    this.checkAssertionTime(claims);
    await this.consume(claims);
    const client = await this.pool.connect();
    let begun = false;
    let beginAttempted = false;
    let discard = false;
    const joined: Array<{ finish: () => Promise<void>; close: () => void }> = [];
    try {
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(client,claims);
      beginAttempted = true;
      await client.query('BEGIN'); begun = true;
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(client,claims);
      const principalId = await this.check(client, claims);
      const scope: Readonly<AuthorityScope> = Object.freeze({ spaceId:claims.spaceId as SpaceId,collectionId:claims.collectionId as CollectionId,
        principalId,credentialId:claims.credentialId,capability:claims.capability,
        policyVersion:claims.policyVersion,placementGeneration:claims.placementGeneration });
      let accepting = true;
      let operationError: unknown;
      const operations = new Set<Promise<unknown>>();
      const admit = <TResult>(work: () => Promise<TResult>, requireActiveSpace = false): Promise<TResult> => {
        if (!accepting) return Promise.reject(new AuthorityError('FORBIDDEN', 'Cell effect context ended'));
        const running = (async () => {
          this.checkAssertionTime(claims);
          await this.check(client,claims,requireActiveSpace);
          await this.checkDatabaseTime(client,claims);
          if (!accepting) throw new AuthorityError('FORBIDDEN', 'Cell effect context ended');
          const value = await work();
          if (!accepting) throw new AuthorityError('FORBIDDEN', 'Cell effect context ended');
          this.checkAssertionTime(claims);
          await this.check(client,claims,requireActiveSpace);
          await this.checkDatabaseTime(client,claims);
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
        records: <TResult>(authority: PostgresAuthority, fn: (tx: AuthorityTransaction) => Promise<TResult>) =>
          admit(() => authority.transactionOnClient(client,scope,fn,
            (finish,close) => { joined.push({finish,close}); })) });
      let result: T;
      try { result = await effect(principalId, context); }
      finally {
        accepting = false;
        await Promise.allSettled(operations);
      }
      if (operationError) throw operationError;
      // Clock-based expiry can occur while locks are held. Recheck immediately before commit.
      await this.check(client, claims);
      this.checkAssertionTime(claims);
      await this.checkDatabaseTime(client,claims);
      // Joined record work remains live until the enclosing cell transaction's
      // final boundary. A later callback cannot consume grant or receipt time.
      for (const entry of joined) await entry.finish();
      try { await client.query('COMMIT'); begun = false; }
      catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      return result;
    } catch (error) {
      if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      else if (beginAttempted) discard = true;
      throw error;
    } finally {
      for (const entry of joined) entry.close();
      client.release(discard);
    }
  }
}

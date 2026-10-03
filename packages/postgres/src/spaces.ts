import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type pg from 'pg';
import type { DirectoryPlacement, RoutingDirectory } from '@stateplane/application';
import type { Capability, VerifiedCredential } from '@stateplane/contracts';
import { AuthorityError, CommitOutcomeUnknownError } from './index.js';
import type { CurrentCredential } from './cell-policy.js';

type PoolLike = Pick<pg.Pool, 'connect' | 'query'>;
export interface CellDatabase { pool: PoolLike; storageTargetId: string }
export interface AgentKeyProvider {
  create(ownerPrincipalId: string, expiresAt: Date, issuanceId: string): Promise<{ id: string; secret: string }>;
  find(ownerPrincipalId: string, issuanceId: string): Promise<string | null>;
  revoke(id: string, ownerPrincipalId: string): Promise<void>;
}
export interface SpaceInfo extends DirectoryPlacement {
  ownerPrincipalId: string; storageTargetId: string;
}
export interface CollectionGrant { collectionId: string; capabilities: readonly Capability[]; expiresAt?: Date }
export interface IssuedAgentKey { id: string; secret: string; confirmation?: 'unknown' }
export interface SpaceAuditPage { entries: ReadonlyArray<Record<string, unknown>>; nextCursor: string | null }
/** A fixed cap bounds one owner audit read even when audit history is retained after deletion. */
const auditPageSize = 100;
const capabilities = new Set<Capability>(['schema:write','records:read','records:write','sources:read','sources:write','claims:read','claims:write','claims:review','events:read','export:read','space:admin']);
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !id.includes('\0');
function safeVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AuthorityError('STALE_PLACEMENT');
  return parsed;
}

async function transaction<T>(pool: PoolLike, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  let beginAttempted = false;
  let discard = false;
  try {
    beginAttempted = true;
    await client.query('BEGIN'); begun = true;
    const result = await fn(client);
    try { await client.query('COMMIT'); begun = false; }
    catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
    return result;
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => { discard = true; });
    else if (beginAttempted) discard = true;
    throw error;
  } finally { client.release(discard); }
}

function owner(actor: VerifiedCredential): string {
  if (actor?.kind !== 'session' || !validId(actor.userPrincipalId)) throw new AuthorityError('FORBIDDEN');
  return actor.userPrincipalId;
}
function ownData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source,key);
  if (!descriptor || !('value' in descriptor)) throw new AuthorityError('INVALID_ARGUMENT');
  return descriptor.value;
}
function snapshotOwner(actor: VerifiedCredential): VerifiedCredential {
  if (!actor || types.isProxy(actor)) throw new AuthorityError('FORBIDDEN');
  const kind = ownData(actor,'kind');
  if (kind !== 'session') throw new AuthorityError('FORBIDDEN');
  const userPrincipalId = ownData(actor,'userPrincipalId');
  const credentialId = ownData(actor,'credentialId');
  if (!validId(userPrincipalId) || !validId(credentialId)) throw new AuthorityError('FORBIDDEN');
  return Object.freeze({kind:'session',userPrincipalId,credentialId});
}
function ordinaryDenseArray(value: unknown): value is readonly unknown[] {
  return !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1;
}
function snapshotGrants(grants: readonly CollectionGrant[], keyExpiry: Date): ReadonlyArray<CollectionGrant> {
  if (!ordinaryDenseArray(grants) || grants.length === 0) throw new AuthorityError('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const copied: CollectionGrant[] = [];
  for (let index = 0; index < grants.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(grants,index);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !descriptor.value ||
      types.isProxy(descriptor.value)) throw new AuthorityError('INVALID_ARGUMENT');
    const grant = descriptor.value as CollectionGrant;
    const collectionId = ownData(grant,'collectionId');
    const grantCapabilities = ownData(grant,'capabilities');
    const grantExpiry = Object.hasOwn(grant,'expiresAt') ? ownData(grant,'expiresAt') : undefined;
    if (!validId(collectionId) || seen.has(collectionId) ||
      !ordinaryDenseArray(grantCapabilities) || !grantCapabilities.length) throw new AuthorityError('INVALID_ARGUMENT');
    const values: Capability[] = [];
    const seenCapabilities = new Set<Capability>();
    for (let member = 0; member < grantCapabilities.length; member++) {
      const item = Object.getOwnPropertyDescriptor(grantCapabilities,member);
      if (!item || !item.enumerable || !('value' in item) || !capabilities.has(item.value) ||
        seenCapabilities.has(item.value)) throw new AuthorityError('INVALID_ARGUMENT');
      seenCapabilities.add(item.value);
      Object.defineProperty(values,member,{value:item.value,writable:true,enumerable:true,configurable:true});
    }
    if (grantExpiry !== undefined && (types.isProxy(grantExpiry) || !(grantExpiry instanceof Date) ||
      !Number.isFinite(grantExpiry.getTime()) || grantExpiry.getTime() > keyExpiry.getTime())) throw new AuthorityError('INVALID_ARGUMENT');
    seen.add(collectionId);
    Object.defineProperty(copied,index,{value:Object.freeze({collectionId,capabilities:Object.freeze(values),
      ...(grantExpiry ? {expiresAt:new Date(grantExpiry.getTime())} : {})}),writable:true,enumerable:true,configurable:true});
  }
  return Object.freeze(copied);
}
function info(row: Record<string, unknown>): SpaceInfo {
  return { spaceId:String(row.space_id),ownerPrincipalId:String(row.owner_principal_id),
    cellId:String(row.cell_id),storageTargetId:String(row.storage_target_id),lifecycle:String(row.lifecycle),
    policyVersion:safeVersion(row.policy_version),placementGeneration:safeVersion(row.placement_generation) };
}

/** Control authority contains placement and owner metadata, never agent grants. */
export class PostgresRoutingDirectory implements RoutingDirectory {
  constructor(private readonly control: PoolLike, private readonly cells: ReadonlyMap<string, CellDatabase>) {}
  async lookup(spaceId: string): Promise<DirectoryPlacement | null> {
    if (!validId(spaceId)) return null;
    const result = await this.control.query(`SELECT space_id,cell_id,lifecycle,policy_version,placement_generation
      FROM space_directory WHERE space_id=$1`,[spaceId]);
    const row = result.rows[0];
    return row ? { spaceId:row.space_id,cellId:row.cell_id,lifecycle:row.lifecycle,
      policyVersion:safeVersion(row.policy_version),placementGeneration:safeVersion(row.placement_generation) } : null;
  }
  async authorized(actor: VerifiedCredential, spaceId: string, collectionId: string, capability: Capability): Promise<boolean> {
    const directory = await this.control.query('SELECT owner_principal_id,cell_id FROM space_directory WHERE space_id=$1 AND lifecycle<>$2',
      [spaceId,'deleted']);
    const row = directory.rows[0];
    if (!row) return false;
    if (actor.kind === 'session') return actor.userPrincipalId === row.owner_principal_id;
    const cell = this.cells.get(row.cell_id);
    if (!cell) return false;
    const result = await cell.pool.query(`SELECT 1 FROM space_credentials sc
      JOIN collection_grants g ON g.space_id=sc.space_id AND g.credential_id=sc.credential_id
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
      WHERE sc.space_id=$1 AND sc.credential_id=$2 AND sc.owner_principal_id=$3
        AND g.collection_id=$4 AND $5=ANY(g.capabilities) AND c.lifecycle<>'deleted'
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at>clock_timestamp()
        AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) LIMIT 1`,
    [spaceId,actor.credentialId,row.owner_principal_id,collectionId,capability]);
    return result.rowCount === 1;
  }
}

/** Personal-space lifecycle. Cell changes precede directory publication; a sync failure makes old assertions stale. */
export class PostgresSpaces {
  constructor(private readonly control: PoolLike, private readonly cells: ReadonlyMap<string, CellDatabase>,
    private readonly defaultCellId: string, private readonly keys: AgentKeyProvider,
    private readonly credentials: CurrentCredential) {
    if (!cells.has(defaultCellId)) throw new Error('Default cell is not configured');
  }
  private cell(id: string): CellDatabase {
    const cell = this.cells.get(id);
    if (!cell) throw new AuthorityError('INVALID_ARGUMENT', 'Home cell is not selectable');
    return cell;
  }
  private async current(actor: VerifiedCredential, ownerPrincipalId: string = owner(actor)): Promise<void> {
    if (!await this.credentials.current(actor,ownerPrincipalId)) throw new AuthorityError('FORBIDDEN');
  }
  private async owned(actor: VerifiedCredential, spaceId: string, includeDeleted = false,
    control: Pick<pg.Pool, 'query'> = this.control): Promise<SpaceInfo> {
    const principal = owner(actor);
    if (!validId(spaceId)) throw new AuthorityError('NOT_FOUND');
    await this.current(actor);
    const result = await control.query(`SELECT * FROM space_directory WHERE space_id=$1 AND owner_principal_id=$2`,[spaceId,principal]);
    if (!result.rows[0] || result.rows[0].lifecycle === 'provisioning' ||
      (!includeDeleted && result.rows[0].lifecycle === 'deleted')) throw new AuthorityError('NOT_FOUND');
    await this.current(actor);
    return info(result.rows[0]);
  }
  async create(actor: VerifiedCredential, requestedCellId?: string): Promise<SpaceInfo> {
    actor = snapshotOwner(actor);
    const principal = owner(actor);
    const cellId = requestedCellId ?? this.defaultCellId;
    const cell = this.cell(cellId); // only server-configured cells are selectable
    const spaceId = `sp_${randomUUID()}`;
    await this.current(actor);
    let publicationAttempted = false;
    try {
      const directory = await this.control.connect();
      let beginAttempted = false;
      let begun = false;
      let discard = false;
      try {
        await this.current(actor);
        // Recovery may see this committed reservation before the creator can
        // lock it. A bounded claim keeps it pending; after expiry the creator
        // must win the row lock and verify provisioning before cell effects.
        await directory.query(`INSERT INTO space_directory(space_id,owner_principal_id,cell_id,storage_target_id,lifecycle,provisioning_lease_until)
          VALUES($1,$2,$3,$4,'provisioning',clock_timestamp()+interval '60 seconds')`,
        [spaceId,principal,cellId,cell.storageTargetId]);
        beginAttempted = true;
        await directory.query('BEGIN'); begun = true;
        const reserved = await directory.query(`SELECT 1 FROM space_directory
          WHERE space_id=$1 AND owner_principal_id=$2 AND lifecycle='provisioning' FOR UPDATE`,[spaceId,principal]);
        if (!reserved.rows[0]) throw new AuthorityError('STALE_PLACEMENT');
        const insertCell = async (db: pg.PoolClient): Promise<void> => {
          await this.current(actor);
          await db.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
            VALUES($1,$2,$3,$3,$4)`,[spaceId,principal,cellId,cell.storageTargetId]);
          await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
            VALUES($1,$2,$3,$4,'space:create',1,1)`,[`aud_${randomUUID()}`,spaceId,principal,actor.credentialId]);
          await this.current(actor);
        };
        if (cell.pool === this.control) await insertCell(directory);
        else await transaction(cell.pool,insertCell);
        try { await directory.query('COMMIT'); begun = false; }
        catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      } catch (error) {
        if (begun) await directory.query('ROLLBACK').catch(() => { discard = true; });
        else if (beginAttempted) discard = true;
        throw error;
      } finally {
        directory.release(discard);
      }
      await this.current(actor);
      publicationAttempted = true;
      const published = await this.control.query(`UPDATE space_directory SET lifecycle='active',provisioning_lease_until=NULL,updated_at=clock_timestamp()
        WHERE space_id=$1 AND lifecycle='provisioning' RETURNING *`,[spaceId]);
      if (!published.rows[0]) throw new Error('Space publication was interrupted');
      return info(published.rows[0]);
    } catch (error) {
      if (publicationAttempted) {
        // A control write may have committed even when its acknowledgement was
        // lost. Never delete its live cell until the directory is known to be
        // unrouteable. An unavailable readback leaves reconciliation possible.
        const observed = await this.control.query('SELECT * FROM space_directory WHERE space_id=$1',[spaceId]).catch(() => null);
        if (!observed) throw error;
        const row = observed.rows[0];
        if (row?.lifecycle === 'active' && row.owner_principal_id === principal && row.cell_id === cellId &&
          row.storage_target_id === cell.storageTargetId) return info(row);
        if (row?.lifecycle !== 'provisioning') throw error;
      }
      // The cell commit may have succeeded even when its acknowledgement was
      // lost. Leave the reservation for owner recovery to inspect under lock.
      throw error;
    }
  }
  private async recoverProvisioning(spaceId: string, ownerPrincipalId: string): Promise<void> {
    await transaction(this.control, async directory => {
      const result = await directory.query(`SELECT *, provisioning_lease_until>clock_timestamp() AS provisioning_claim_live FROM space_directory
        WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,ownerPrincipalId]);
      const row = result.rows[0];
      if (!row || row.lifecycle !== 'provisioning') return;
      if (row.provisioning_claim_live === true) return;
      const cell = this.cell(row.cell_id);
      if (cell.storageTargetId !== row.storage_target_id) throw new AuthorityError('STALE_PLACEMENT');
      const local = await (cell.pool === this.control ? directory : cell.pool).query(`SELECT s.owner_principal_id,s.cell_id,s.storage_target_id,s.lifecycle,
        s.policy_version,s.placement_generation,
        EXISTS (SELECT 1 FROM space_audit a WHERE a.space_id=s.space_id AND a.action='space:create') AS created
        FROM spaces s WHERE s.space_id=$1`,[spaceId]);
      const existing = local.rows[0];
      if (!existing) {
        await directory.query(`UPDATE space_directory SET lifecycle='deleted',provisioning_lease_until=NULL,updated_at=clock_timestamp()
          WHERE space_id=$1 AND lifecycle='provisioning'`,[spaceId]);
        await directory.query(`INSERT INTO space_provisioning_audit(space_id,owner_principal_id,cell_id,action)
          VALUES($1,$2,$3,'space:provision-retired')`,[spaceId,ownerPrincipalId,row.cell_id]);
        return;
      }
      if (existing.owner_principal_id !== ownerPrincipalId || existing.cell_id !== row.cell_id ||
        existing.storage_target_id !== row.storage_target_id || existing.lifecycle !== 'active' ||
        safeVersion(existing.policy_version) !== 1 || safeVersion(existing.placement_generation) !== 1 ||
        existing.created !== true) throw new AuthorityError('STALE_PLACEMENT');
      await directory.query(`UPDATE space_directory SET lifecycle='active',provisioning_lease_until=NULL,updated_at=clock_timestamp()
        WHERE space_id=$1 AND lifecycle='provisioning'`,[spaceId]);
    });
  }
  async list(actor: VerifiedCredential): Promise<SpaceInfo[]> {
    actor = snapshotOwner(actor);
    await this.current(actor);
    const pending = await this.control.query(`SELECT space_id FROM space_directory
      WHERE owner_principal_id=$1 AND lifecycle='provisioning' ORDER BY created_at,space_id`,[owner(actor)]);
    for (const row of pending.rows) {
      await this.current(actor);
      // A pending cell can be offline while the owner's other spaces remain
      // available. Its directory row stays unrouteable until a later retry.
      try { await this.recoverProvisioning(row.space_id,owner(actor)); }
      catch { /* Keep this reservation pending and continue with healthy cells. */ }
    }
    const rows = await this.control.query(`SELECT * FROM space_directory WHERE owner_principal_id=$1 AND lifecycle NOT IN ('provisioning','deleted')
      ORDER BY created_at,space_id`,[owner(actor)]);
    await this.current(actor);
    return rows.rows.map(info);
  }
  async get(actor: VerifiedCredential, spaceId: string): Promise<SpaceInfo> {
    if (!actor || types.isProxy(actor) || !validId(spaceId)) throw new AuthorityError('NOT_FOUND');
    const kind = ownData(actor,'kind');
    if (kind === 'session') return this.owned(snapshotOwner(actor),spaceId);
    if (kind !== 'api-key') throw new AuthorityError('FORBIDDEN');
    const credentialId = ownData(actor,'credentialId');
    if (!validId(credentialId)) throw new AuthorityError('FORBIDDEN');
    if (!await this.credentials.current({kind:'api-key',credentialId})) throw new AuthorityError('FORBIDDEN');
    const control = await this.control.query('SELECT * FROM space_directory WHERE space_id=$1 AND lifecycle<>$2',[spaceId,'deleted']);
    const row = control.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    // A live key for another owner must not reveal that this selector exists.
    if (!await this.credentials.current({kind:'api-key',credentialId},row.owner_principal_id))
      throw new AuthorityError('NOT_FOUND');
    const cell = await this.cell(row.cell_id).pool.query(`SELECT s.policy_version,s.placement_generation,s.cell_id
      FROM spaces s JOIN space_credentials sc ON sc.space_id=s.space_id AND sc.credential_id=$2
      JOIN collection_grants g ON g.space_id=s.space_id AND g.credential_id=sc.credential_id
      JOIN collections c ON c.space_id=g.space_id AND c.collection_id=g.collection_id
      WHERE s.space_id=$1 AND s.lifecycle<>'deleted' AND c.lifecycle<>'deleted'
        AND sc.owner_principal_id=s.owner_principal_id
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at>clock_timestamp()
        AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
        AND g.capabilities @> ARRAY['space:admin']::text[] LIMIT 1`,[spaceId,credentialId]);
    const local = cell.rows[0];
    if (!local) throw new AuthorityError('NOT_FOUND');
    if (local.cell_id !== row.cell_id || safeVersion(local.policy_version) !== safeVersion(row.policy_version) ||
      safeVersion(local.placement_generation) !== safeVersion(row.placement_generation)) throw new AuthorityError('STALE_PLACEMENT');
    await this.current({kind:'api-key',credentialId},row.owner_principal_id);
    return info(row);
  }

  private async publish(space: SpaceInfo, policyVersion: number, lifecycle: string,
    control: Pick<pg.Pool, 'query'> = this.control): Promise<void> {
    try {
      const updated = await control.query(`UPDATE space_directory SET policy_version=$3,lifecycle=$4,updated_at=clock_timestamp()
        WHERE space_id=$1 AND policy_version=$2 AND placement_generation=$5 AND cell_id=$6 RETURNING 1`,
      [space.spaceId,space.policyVersion,policyVersion,lifecycle,space.placementGeneration,space.cellId]);
      if (updated.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT');
    } catch (error) {
      const observed = await control.query('SELECT * FROM space_directory WHERE space_id=$1',[space.spaceId]).catch(() => null);
      const row = observed?.rows[0];
      if (row?.owner_principal_id === space.ownerPrincipalId && row.cell_id === space.cellId &&
        row.storage_target_id === space.storageTargetId && row.lifecycle === lifecycle &&
        safeVersion(row.policy_version) === policyVersion && safeVersion(row.placement_generation) === space.placementGeneration) return;
      throw error;
    }
  }
  /** Recover a cell-first transition before retrying an owner's control request. */
  private async publicationForRetry(actor: VerifiedCredential, space: SpaceInfo): Promise<SpaceInfo> {
    await this.current(actor);
    const local = await this.cell(space.cellId).pool.query(
      'SELECT lifecycle,policy_version,placement_generation FROM spaces WHERE space_id=$1',[space.spaceId]);
    const row = local.rows[0];
    if (!row) throw new AuthorityError('STALE_PLACEMENT');
    const version = safeVersion(row.policy_version);
    const generation = safeVersion(row.placement_generation);
    if (version < space.policyVersion || generation < space.placementGeneration) throw new AuthorityError('STALE_PLACEMENT');
    if (version === space.policyVersion && generation === space.placementGeneration && row.lifecycle === space.lifecycle) return space;
    await this.current(actor);
    return this.reconcile(space.spaceId);
  }
  private async changeLifecycle(actor: VerifiedCredential, spaceId: string, lifecycle: 'active' | 'readOnly' | 'suspended' | 'deleting'): Promise<void> {
    actor = snapshotOwner(actor);
    const observed = await this.owned(actor,spaceId);
    const space = await this.publicationForRetry(actor,observed);
    const prior = space.lifecycle;
    if (prior === lifecycle) return;
    if (prior === 'deleting' || prior === 'deleted') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (lifecycle === 'deleting' && prior !== 'readOnly' && prior !== 'suspended') throw new AuthorityError('INVALID_ARGUMENT', 'Archive or suspend before deletion');
    const next = lifecycle;
    const version = await transaction(this.cell(space.cellId).pool, async db => {
      await this.current(actor);
      const changed = await db.query(`UPDATE spaces SET lifecycle=$3,policy_version=policy_version+1
        WHERE space_id=$1 AND owner_principal_id=$2 AND policy_version=$4 AND lifecycle=$5 RETURNING policy_version,placement_generation`,
      [spaceId,owner(actor),next,space.policyVersion,prior]);
      if (!changed.rows[0]) throw new AuthorityError('STALE_PLACEMENT');
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[`aud_${randomUUID()}`,spaceId,owner(actor),actor.credentialId,
        `space:${next}`,changed.rows[0].policy_version,changed.rows[0].placement_generation]);
      await this.current(actor);
      return Number(changed.rows[0].policy_version);
    });
    await this.current(actor);
    await this.publish(space,version,next);
  }
  archive(actor: VerifiedCredential, spaceId: string): Promise<void> { return this.changeLifecycle(actor,spaceId,'readOnly'); }
  restore(actor: VerifiedCredential, spaceId: string): Promise<void> { return this.changeLifecycle(actor,spaceId,'active'); }
  suspend(actor: VerifiedCredential, spaceId: string): Promise<void> { return this.changeLifecycle(actor,spaceId,'suspended'); }
  async delete(actor: VerifiedCredential, spaceId: string): Promise<void> {
    actor = snapshotOwner(actor);
    const observed = await this.owned(actor,spaceId,true);
    if (observed.lifecycle === 'deleted') {
      await this.cleanupIssuances(observed,true);
      if (!await this.erased(this.cell(observed.cellId).pool,spaceId)) throw new AuthorityError('STALE_PLACEMENT');
      return;
    }
    const current = await this.publicationForRetry(actor,observed);
    if (current.lifecycle === 'deleted') {
      await this.cleanupIssuances(current,true);
      if (!await this.erased(this.cell(current.cellId).pool,spaceId)) throw new AuthorityError('STALE_PLACEMENT');
      return;
    }
    if (current.lifecycle !== 'deleting') await this.changeLifecycle(actor,spaceId,'deleting');
    const space = await this.owned(actor,spaceId);
    const cell = this.cell(space.cellId);
    await this.current(actor);
    const local = await cell.pool.query('SELECT lifecycle,policy_version FROM spaces WHERE space_id=$1',[spaceId]);
    if (local.rows[0]?.lifecycle === 'deleting') {
      await this.current(actor);
      const keys = await cell.pool.query('SELECT credential_id FROM space_credentials WHERE space_id=$1 AND provider_revoked_at IS NULL',[spaceId]);
      // Provider revocation is retryable. Until it succeeds, deleting denies every content effect.
      for (const row of keys.rows) {
        await this.current(actor);
        await this.revokeProvider(cell,space,owner(actor),row.credential_id);
      }
      await this.cleanupIssuances(space,true);
      await transaction(cell.pool, async db => {
        await this.current(actor);
        await db.query('SELECT stateplane_purge_space($1)',[spaceId]);
        const version = await db.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId]);
        await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
          VALUES($1,$2,$3,$4,'space:deleted',$5,$6)`,[`aud_${randomUUID()}`,spaceId,owner(actor),actor.credentialId,
          version.rows[0].policy_version,version.rows[0].placement_generation]);
        await this.current(actor);
      });
    } else if (local.rows[0]?.lifecycle !== 'deleted') throw new AuthorityError('STALE_PLACEMENT');
    await this.cleanupIssuances(space,true);
    await this.current(actor);
    const deleted = await cell.pool.query('SELECT policy_version FROM spaces WHERE space_id=$1 AND lifecycle=$2',[spaceId,'deleted']);
    if (!deleted.rows[0]) throw new AuthorityError('STALE_PLACEMENT');
    if (!await this.erased(cell.pool,spaceId)) throw new AuthorityError('STALE_PLACEMENT');
    await this.current(actor);
    await this.publish(space,Number(deleted.rows[0].policy_version),'deleted');
  }
  /** Explicit owner recovery for an inconsistent deleted cell tombstone. No directory publication occurs here. */
  async repairDeletedErasure(actor: VerifiedCredential, spaceId: string): Promise<void> {
    actor = snapshotOwner(actor);
    const space = await this.owned(actor,spaceId,true);
    if (space.lifecycle !== 'deleting' && space.lifecycle !== 'deleted') throw new AuthorityError('SPACE_UNAVAILABLE');
    const cell = this.cell(space.cellId);
    await this.current(actor);
    const local = await cell.pool.query('SELECT * FROM spaces WHERE space_id=$1',[spaceId]);
    const row = local.rows[0];
    if (!row || row.lifecycle !== 'deleted' || row.owner_principal_id !== space.ownerPrincipalId ||
      row.cell_id !== space.cellId || row.storage_target_id !== space.storageTargetId ||
      safeVersion(row.policy_version) < space.policyVersion ||
      safeVersion(row.placement_generation) !== space.placementGeneration) throw new AuthorityError('STALE_PLACEMENT');
    if (await this.erased(cell.pool,spaceId)) return;
    await this.cleanupIssuances(space,true);
    const keys = await cell.pool.query('SELECT credential_id FROM space_credentials WHERE space_id=$1 AND provider_revoked_at IS NULL',[spaceId]);
    for (const key of keys.rows) {
      await this.current(actor);
      await this.revokeProvider(cell,space,owner(actor),key.credential_id);
    }
    await transaction(cell.pool, async db => {
      await this.current(actor);
      const locked = await db.query(`SELECT lifecycle,owner_principal_id,cell_id,storage_target_id,
        policy_version,placement_generation FROM spaces WHERE space_id=$1 FOR UPDATE`,[spaceId]);
      const current = locked.rows[0];
      if (!current || current.lifecycle !== 'deleted' || current.owner_principal_id !== space.ownerPrincipalId ||
        current.cell_id !== space.cellId || current.storage_target_id !== space.storageTargetId ||
        safeVersion(current.policy_version) < space.policyVersion ||
        safeVersion(current.placement_generation) !== space.placementGeneration) throw new AuthorityError('STALE_PLACEMENT');
      if (await this.erased(db,spaceId)) return;
      // The purge routine accepts only deleting. Keep this transition and the
      // purge in one transaction, so no other session observes a usable state.
      await db.query("UPDATE spaces SET lifecycle='deleting' WHERE space_id=$1",[spaceId]);
      await db.query('SELECT stateplane_purge_space($1)',[spaceId]);
      if (!await this.erased(db,spaceId)) throw new AuthorityError('STALE_PLACEMENT');
      const version = await db.query('SELECT policy_version,placement_generation FROM spaces WHERE space_id=$1',[spaceId]);
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        VALUES($1,$2,$3,$4,'space:erasure-repair',$5,$6)`,[`aud_${randomUUID()}`,spaceId,owner(actor),actor.credentialId,
        version.rows[0].policy_version,version.rows[0].placement_generation]);
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        SELECT $1,$2,$3,$4,'space:deleted',$5,$6 WHERE NOT EXISTS
          (SELECT 1 FROM space_audit WHERE space_id=$2 AND action='space:deleted')`,
      [`aud_${randomUUID()}`,spaceId,owner(actor),actor.credentialId,
        version.rows[0].policy_version,version.rows[0].placement_generation]);
      await this.current(actor);
    });
  }
  update(actor: VerifiedCredential, spaceId: string, lifecycle: 'active' | 'readOnly' | 'suspended'): Promise<void> {
    if (!['active','readOnly','suspended'].includes(lifecycle)) throw new AuthorityError('INVALID_ARGUMENT');
    return this.changeLifecycle(actor,spaceId,lifecycle);
  }

  private async erased(db: Pick<pg.Pool, 'query'>, spaceId: string): Promise<boolean> {
    const result = await db.query(`SELECT lifecycle='deleted' AND
      NOT EXISTS (SELECT 1 FROM projection_outbox WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM receipt_reservation_scopes WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM receipt_reservations WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM idempotency_receipts WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM record_tombstones WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM record_unique_keys WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM record_index_values WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM record_events WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM records WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM entity_refs WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM collection_grants WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM collection_unique_declarations WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM collection_index_declarations WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM collection_versions WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM collections WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM space_credentials WHERE space_id=$1) AND
      NOT EXISTS (SELECT 1 FROM routing_nonces WHERE space_id=$1) AS erased
      FROM spaces WHERE space_id=$1`,[spaceId]);
    return result.rows[0]?.erased === true;
  }

  /** A database-clock claim distinguishes live issuance from an interrupted
   * journal. No connection is held during provider I/O. Expiry fences a slow
   * issuer; its eventual result is compensated, and reconciliation can retry. */
  private async withIssuanceLease<T>(spaceId: string,
    operation: (leaseToken: string) => Promise<T>): Promise<T> {
    await Promise.resolve();
    const token = `lease_${randomUUID()}`;
    const claimed = await this.control.query(`UPDATE space_directory
      SET issuance_lease_token=$2,issuance_lease_until=clock_timestamp()+interval '60 seconds'
      WHERE space_id=$1 AND (issuance_lease_token IS NULL OR issuance_lease_until<=clock_timestamp())
      RETURNING 1`,[spaceId,token]);
    if (claimed.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT','Issuance is still active');
    try { return await operation(token); }
    finally {
      await this.control.query(`UPDATE space_directory SET issuance_lease_token=NULL,issuance_lease_until=NULL
        WHERE space_id=$1 AND issuance_lease_token=$2`,[spaceId,token]).catch(() => {});
    }
  }

  /** The control journal survives cell erasure and ambiguous cell commits. */
  private async cleanupIssuances(space: SpaceInfo, force: boolean,
    lockedControl?: Pick<pg.Pool, 'query'>, leaseToken?: string): Promise<void> {
    // Deletion has already fenced the cell lifecycle. It must be able to
    // cancel a paused provider create without waiting for that promise.
    if (!lockedControl && force) return this.cleanupIssuances(space,force,this.control);
    if (!lockedControl) return this.withIssuanceLease(space.spaceId,
      token => this.cleanupIssuances(space,force,this.control,token));
    const pending = await lockedControl.query(`SELECT issuance_id,credential_id,owner_principal_id,cell_id,
      create_failed_at,requires_completion,completed_at
      FROM agent_key_issuances WHERE space_id=$1 AND provider_revoked_at IS NULL
        AND settled_without_key_at IS NULL ORDER BY created_at,issuance_id`,[space.spaceId]);
    for (const row of pending.rows) {
      if (row.owner_principal_id !== space.ownerPrincipalId || row.cell_id !== space.cellId) throw new AuthorityError('STALE_PLACEMENT');
      if (!force && row.completed_at) continue;
      const cell = this.cell(space.cellId);
      const local = row.credential_id ? await cell.pool.query(`SELECT sc.confirmed_at,sc.revoked_at,s.lifecycle FROM spaces s
        LEFT JOIN space_credentials sc ON sc.space_id=s.space_id AND sc.credential_id=$2
        WHERE s.space_id=$1`,[space.spaceId,row.credential_id]) : null;
      const record = local?.rows[0];
      if (!force && !row.requires_completion && record?.confirmed_at && !record.revoked_at &&
        ['active','readOnly','suspended'].includes(record.lifecycle)) continue;
      // Claim ownership and cancellation are one control write. A reconciler
      // whose claim expired cannot revoke an issuance owned by its successor.
      const cancelled = await lockedControl.query(`UPDATE agent_key_issuances i
        SET cancelled_at=COALESCE(i.cancelled_at,clock_timestamp())
        FROM space_directory d WHERE i.issuance_id=$1 AND d.space_id=i.space_id
          AND i.provider_revoked_at IS NULL AND i.settled_without_key_at IS NULL
          AND ($2::boolean OR (i.completed_at IS NULL AND d.issuance_lease_token=$3
            AND d.issuance_lease_until>clock_timestamp())) RETURNING 1`,
      [row.issuance_id,force,leaseToken ?? null]);
      if (cancelled.rowCount !== 1) {
        if (!force) throw new AuthorityError('STALE_PLACEMENT','Reconciliation claim expired');
        continue;
      }
      const id = row.credential_id ?? await this.keys.find(space.ownerPrincipalId,row.issuance_id);
      if (!id) {
        if (row.create_failed_at) {
          // The create promise rejected. A successful provider lookup now proves
          // that no bearer was issued, even if lookup was unavailable at failure.
          await lockedControl.query(`UPDATE agent_key_issuances SET settled_without_key_at=clock_timestamp()
            WHERE issuance_id=$1 AND credential_id IS NULL AND settled_without_key_at IS NULL`,[row.issuance_id]);
          continue;
        }
        if (force) throw new AuthorityError('STALE_PLACEMENT','Provider issuance has not settled');
        continue;
      }
      await lockedControl.query(`UPDATE agent_key_issuances SET credential_id=$2
        WHERE issuance_id=$1 AND (credential_id IS NULL OR credential_id=$2)`,[row.issuance_id,id]);
      const current = await cell.pool.query(`SELECT sc.confirmed_at,sc.revoked_at,s.lifecycle FROM spaces s
        LEFT JOIN space_credentials sc ON sc.space_id=s.space_id AND sc.credential_id=$2
        WHERE s.space_id=$1`,[space.spaceId,id]);
      const currentRecord = current.rows[0];
      if (currentRecord && currentRecord.lifecycle !== 'deleted' && currentRecord.revoked_at == null)
        await this.failIssuedKey(cell,space.spaceId,space.ownerPrincipalId,id);
      await this.keys.revoke(id,space.ownerPrincipalId);
      await lockedControl.query(`UPDATE agent_key_issuances SET provider_revoked_at=clock_timestamp()
        WHERE issuance_id=$1 AND provider_revoked_at IS NULL`,[row.issuance_id]);
      if (currentRecord && currentRecord.lifecycle !== 'deleted') await cell.pool.query(`UPDATE space_credentials
        SET provider_revoked_at=COALESCE(provider_revoked_at,clock_timestamp())
        WHERE space_id=$1 AND credential_id=$2`,[space.spaceId,id]);
    }
  }

  /** Control-plane operation after a verified placement configuration change. No data move occurs here. */
  async fencePlacement(spaceId: string, expectedCellId: string, expectedGeneration: number): Promise<number> {
    if (!validId(spaceId) || !this.cells.has(expectedCellId) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new AuthorityError('INVALID_ARGUMENT');
    const directory = await this.control.query('SELECT * FROM space_directory WHERE space_id=$1',[spaceId]);
    const row = directory.rows[0];
    if (!row || row.cell_id !== expectedCellId || Number(row.placement_generation) !== expectedGeneration || row.lifecycle === 'deleted') throw new AuthorityError('STALE_PLACEMENT');
    const next = await transaction(this.cell(expectedCellId).pool, async db => {
      const changed = await db.query(`UPDATE spaces SET placement_generation=placement_generation+1
        WHERE space_id=$1 AND cell_id=$2 AND placement_generation=$3 RETURNING placement_generation,policy_version`,
      [spaceId,expectedCellId,expectedGeneration]);
      if (!changed.rows[0]) throw new AuthorityError('STALE_PLACEMENT');
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,action,policy_version,placement_generation)
        VALUES($1,$2,'system:placement','placement:fence',$3,$4)`,[`aud_${randomUUID()}`,spaceId,
        changed.rows[0].policy_version,changed.rows[0].placement_generation]);
      return Number(changed.rows[0].placement_generation);
    });
    const published = await this.control.query(`UPDATE space_directory SET placement_generation=$3,updated_at=clock_timestamp()
      WHERE space_id=$1 AND cell_id=$2 AND placement_generation=$4 RETURNING 1`,[spaceId,expectedCellId,next,expectedGeneration]);
    if (published.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT');
    return next;
  }

  /** Repair an interrupted cell-first publication from the cell's current authority. */
  async reconcile(spaceId: string): Promise<SpaceInfo> {
    if (!validId(spaceId)) throw new AuthorityError('INVALID_ARGUMENT');
    // A deleted cell cannot accept staging or confirmation. Its retained
    // journal must remain repairable even if an old provider create is paused.
    const directory = await this.control.query('SELECT cell_id FROM space_directory WHERE space_id=$1',[spaceId]);
    if (!directory.rows[0]) throw new AuthorityError('NOT_FOUND');
    const cell = this.cell(directory.rows[0].cell_id);
    const lifecycle = await cell.pool.query('SELECT lifecycle FROM spaces WHERE space_id=$1',[spaceId]);
    if (lifecycle.rows[0]?.lifecycle === 'deleted') return this.reconcileLocked(spaceId,this.control,true);
    return this.withIssuanceLease(spaceId,token => this.reconcileLocked(spaceId,this.control,false,token));
  }
  private async reconcileLocked(spaceId: string, controlClient: Pick<pg.Pool, 'query'>,
    requireDeleted = false, leaseToken?: string): Promise<SpaceInfo> {
    const control = await controlClient.query('SELECT * FROM space_directory WHERE space_id=$1',[spaceId]);
    const row = control.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    const first = await this.cell(row.cell_id).pool.query(`SELECT * FROM spaces WHERE space_id=$1`,[spaceId]);
    if (!first.rows[0] || (first.rows[0].owner_principal_id !== row.owner_principal_id || first.rows[0].cell_id !== row.cell_id ||
      first.rows[0].storage_target_id !== row.storage_target_id)) throw new AuthorityError('STALE_PLACEMENT');
    if (requireDeleted && first.rows[0].lifecycle !== 'deleted') throw new AuthorityError('STALE_PLACEMENT');
    await this.cleanupIssuances(info(row),row.lifecycle === 'deleted' || first.rows[0]?.lifecycle === 'deleting' ||
      first.rows[0]?.lifecycle === 'deleted',controlClient,leaseToken);
    if (first.rows[0] && first.rows[0].lifecycle !== 'deleted') {
      // A provider revoke can succeed while cell compensation fails. The
      // durable journal is terminal even then: clear any remaining local
      // authority before publishing the repaired directory version.
      const providerRevoked = await controlClient.query(`SELECT credential_id FROM agent_key_issuances
        WHERE space_id=$1 AND provider_revoked_at IS NOT NULL AND credential_id IS NOT NULL`,[spaceId]);
      for (const key of providerRevoked.rows) {
        const localKey = await this.cell(row.cell_id).pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
          WHERE space_id=$1 AND credential_id=$2`,[spaceId,key.credential_id]);
        if (!localKey.rows[0]) continue;
        if (!localKey.rows[0].revoked_at)
          await this.failIssuedKey(this.cell(row.cell_id),spaceId,row.owner_principal_id,key.credential_id);
        if (!localKey.rows[0].provider_revoked_at)
          await this.markProviderRevoked(this.cell(row.cell_id),info(row),row.owner_principal_id,key.credential_id);
      }
      // An interrupted issuance is never promoted by directory repair. Locally
      // revoke it first, then retry the external provider revocation below.
      const unconfirmed = await this.cell(row.cell_id).pool.query(`SELECT credential_id FROM space_credentials
        WHERE space_id=$1 AND confirmed_at IS NULL AND revoked_at IS NULL`,[spaceId]);
      for (const key of unconfirmed.rows) {
        const journal = await controlClient.query(`SELECT 1 FROM agent_key_issuances
          WHERE space_id=$1 AND credential_id=$2`,[spaceId,key.credential_id]);
        if (journal.rowCount === 0) await this.failIssuedKey(this.cell(row.cell_id),spaceId,row.owner_principal_id,key.credential_id);
      }
      const pending = await this.cell(row.cell_id).pool.query(`SELECT credential_id FROM space_credentials
        WHERE space_id=$1 AND revoked_at IS NOT NULL AND provider_revoked_at IS NULL`,[spaceId]);
      for (const key of pending.rows) await this.revokeProvider(this.cell(row.cell_id),info(row),row.owner_principal_id,key.credential_id,controlClient);
    }
    const current = await this.cell(row.cell_id).pool.query(`SELECT * FROM spaces WHERE space_id=$1`,[spaceId]);
    const local = current.rows[0];
    if (!local || local.owner_principal_id !== row.owner_principal_id || local.cell_id !== row.cell_id ||
      local.storage_target_id !== row.storage_target_id) throw new AuthorityError('STALE_PLACEMENT');
    if (row.lifecycle === 'deleted') {
      if (!await this.erased(this.cell(row.cell_id).pool,spaceId)) throw new AuthorityError('STALE_PLACEMENT');
      return info(row);
    }
    const lifecycle = local.lifecycle;
    if (lifecycle === 'deleted' && !await this.erased(this.cell(row.cell_id).pool,spaceId))
      throw new AuthorityError('STALE_PLACEMENT');
    if (safeVersion(local.policy_version) < safeVersion(row.policy_version) ||
      safeVersion(local.placement_generation) < safeVersion(row.placement_generation)) throw new AuthorityError('STALE_PLACEMENT');
    const updated = await controlClient.query(`UPDATE space_directory SET lifecycle=$2,policy_version=$3,
      placement_generation=$4,updated_at=clock_timestamp()
      WHERE space_id=$1 AND lifecycle=$5 AND policy_version=$6 AND placement_generation=$7
        AND cell_id=$8 AND owner_principal_id=$9 AND storage_target_id=$10
        AND ($11::text IS NULL OR (issuance_lease_token=$11 AND issuance_lease_until>clock_timestamp())) RETURNING *`,
    [spaceId,lifecycle,local.policy_version,local.placement_generation,
      row.lifecycle,row.policy_version,row.placement_generation,row.cell_id,row.owner_principal_id,row.storage_target_id,
      leaseToken ?? null]);
    if (!updated.rows[0]) throw new AuthorityError('STALE_PLACEMENT');
    return info(updated.rows[0]);
  }

  private async failIssuedKey(cell: CellDatabase, spaceId: string, ownerPrincipalId: string, keyId: string): Promise<void> {
    await transaction(cell.pool, async db => {
      const revoked = await db.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND credential_id=$2 AND owner_principal_id=$3
          AND revoked_at IS NULL RETURNING 1`,
      [spaceId,keyId,ownerPrincipalId]);
      if (revoked.rowCount !== 1) return;
      await db.query('DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2',[spaceId,keyId]);
      const changed = await db.query(`UPDATE spaces SET policy_version=policy_version+1
        WHERE space_id=$1 RETURNING policy_version,placement_generation`,[spaceId]);
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        VALUES($1,$2,$3,$4,'key:issue-failed',$5,$6)`,[`aud_${randomUUID()}`,spaceId,ownerPrincipalId,keyId,
        changed.rows[0].policy_version,changed.rows[0].placement_generation]);
    });
  }

  private async requireGrantCollections(db: PoolLike | pg.PoolClient, spaceId: string,
    grants: ReadonlyArray<CollectionGrant>): Promise<void> {
    for (let index = 0; index < grants.length; index++) {
      const found = await db.query(`SELECT 1 FROM collections
        WHERE space_id=$1 AND collection_id=$2 AND lifecycle<>'deleted' FOR SHARE`,[spaceId,grants[index].collectionId]);
      if (found.rowCount !== 1) throw new AuthorityError('INVALID_ARGUMENT', 'Grant collection does not exist');
    }
  }

  private async requireLiveIssuance(control: Pick<pg.Pool, 'query'>, issuanceId: string,
    leaseToken: string): Promise<void> {
    const live = await control.query(`SELECT 1 FROM agent_key_issuances i
      JOIN space_directory d ON d.space_id=i.space_id
      WHERE i.issuance_id=$1 AND i.cancelled_at IS NULL AND i.provider_revoked_at IS NULL
        AND i.settled_without_key_at IS NULL AND d.issuance_lease_token=$2
        AND d.issuance_lease_until>clock_timestamp()`,[issuanceId,leaseToken]);
    if (live.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT','Issuance was cancelled');
  }

  async issueAgentKey(actor: VerifiedCredential, spaceId: string, expiresAt: Date, grants: readonly CollectionGrant[]): Promise<IssuedAgentKey> {
    actor = snapshotOwner(actor);
    if (!expiresAt || types.isProxy(expiresAt) || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new AuthorityError('INVALID_ARGUMENT');
    expiresAt = new Date(expiresAt.getTime());
    grants = snapshotGrants(grants,expiresAt);
    if (!validId(spaceId)) throw new AuthorityError('NOT_FOUND');
    await this.owned(actor,spaceId);
    return this.withIssuanceLease(spaceId,leaseToken => this.issueAgentKeyLocked(actor,spaceId,expiresAt,grants,leaseToken));
  }
  private async issueAgentKeyLocked(actor: VerifiedCredential, spaceId: string, expiresAt: Date,
    grants: readonly CollectionGrant[], leaseToken: string): Promise<IssuedAgentKey> {
    const control = this.control;
    const expiryMs = expiresAt.getTime();
    const space = await this.owned(actor,spaceId,false,control);
    if (space.lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    await this.current(actor);
    // Reject bad selectors before AuthFn creates a bearer. Recheck under row
    // locks in the grant transaction because a collection can change meanwhile.
    await this.requireGrantCollections(this.cell(space.cellId).pool,spaceId,grants);
    await this.current(actor);
    const issuanceId = `iss_${randomUUID()}`;
    const reserved = await control.query(`INSERT INTO agent_key_issuances(issuance_id,space_id,owner_principal_id,cell_id,requires_completion)
      SELECT $1,space_id,owner_principal_id,cell_id,true FROM space_directory
      WHERE space_id=$2 AND owner_principal_id=$3 AND cell_id=$4 AND lifecycle='active'
        AND policy_version=$5 AND placement_generation=$6 RETURNING 1`,
    [issuanceId,spaceId,owner(actor),space.cellId,space.policyVersion,space.placementGeneration]);
    if (reserved.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT');
    let created: {id: string; secret: string} | undefined;
    let createFailed = false;
    try {
      let issued: {id: string; secret: string};
      try { issued = await this.keys.create(owner(actor),new Date(expiryMs),issuanceId); }
      catch (error) { createFailed = true; throw error; }
      created = issued;
      if (!validId(issued.id)) throw new AuthorityError('INVALID_ARGUMENT','Provider returned an invalid key ID');
      await this.requireLiveIssuance(control,issuanceId,leaseToken);
      await control.query(`UPDATE agent_key_issuances SET credential_id=$2
        WHERE issuance_id=$1 AND (credential_id IS NULL OR credential_id=$2)`,[issuanceId,issued.id]);
      // This independent commit keeps a provider key discoverable by reconcile
      // if a later grant FK, publication or activation transaction fails.
      await transaction(this.cell(space.cellId).pool, async db => {
        await this.requireLiveIssuance(this.cell(space.cellId).pool === this.control ? db : control,issuanceId,leaseToken);
        // Serialize staging with deletion and erasure repair. A provider create
        // can finish after either path has purged the cell; its old directory
        // snapshot must never insert a credential into the deleted tombstone.
        const locked = await db.query(`SELECT lifecycle,policy_version,placement_generation,cell_id,storage_target_id
          FROM spaces WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,owner(actor)]);
        const local = locked.rows[0];
        if (!local || local.lifecycle !== 'active' || local.cell_id !== space.cellId ||
          local.storage_target_id !== space.storageTargetId ||
          safeVersion(local.policy_version) !== space.policyVersion ||
          safeVersion(local.placement_generation) !== space.placementGeneration)
          throw new AuthorityError('STALE_PLACEMENT');
        await db.query(`INSERT INTO space_credentials(space_id,credential_id,principal_id,owner_principal_id,expires_at,activated_at)
          VALUES($1,$2,$3,$4,$5,NULL)`,[spaceId,issued.id,`agent_${randomUUID()}`,owner(actor),new Date(expiryMs)]);
        await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
          SELECT $1,$2,$3,$4,'key:created-pending',policy_version,placement_generation FROM spaces WHERE space_id=$2`,
        [`aud_${randomUUID()}`,spaceId,owner(actor),issued.id]);
      });
      const version = await transaction(this.cell(space.cellId).pool, async db => {
        await this.requireLiveIssuance(this.cell(space.cellId).pool === this.control ? db : control,issuanceId,leaseToken);
        await this.current(actor);
        const locked = await db.query(`SELECT policy_version,lifecycle FROM spaces WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,owner(actor)]);
        if (!locked.rows[0] || Number(locked.rows[0].policy_version) !== space.policyVersion || locked.rows[0].lifecycle !== 'active') throw new AuthorityError('STALE_PLACEMENT');
        await this.requireGrantCollections(db,spaceId,grants);
        const auditGrants: {collectionId: string; capabilities: readonly Capability[]; expiresAt: string | null}[] = [];
        for (let index = 0; index < grants.length; index++) {
          const grant = grants[index];
          await db.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities,expires_at)
            VALUES($1,$2,$3,$4,$5)`,[spaceId,grant.collectionId,issued.id,grant.capabilities,grant.expiresAt ?? null]);
          Object.defineProperty(auditGrants,index,{value:{collectionId:grant.collectionId,capabilities:grant.capabilities,
            expiresAt:grant.expiresAt?.toISOString() ?? null},writable:true,enumerable:true,configurable:true});
        }
        const changed = await db.query(`UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1 RETURNING policy_version,placement_generation`,[spaceId]);
        await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation,details)
          VALUES($1,$2,$3,$4,'key:issue-pending',$5,$6,$7::jsonb)`,[`aud_${randomUUID()}`,spaceId,owner(actor),issued.id,
          changed.rows[0].policy_version,changed.rows[0].placement_generation,JSON.stringify({ expiresAt:new Date(expiryMs).toISOString(),
            grants:auditGrants })]);
        await this.current(actor);
        return Number(changed.rows[0].policy_version);
      });
      await this.current(actor);
      await this.requireLiveIssuance(control,issuanceId,leaseToken);
      await this.publish(space,version,space.lifecycle,control);
      try { await transaction(this.cell(space.cellId).pool, async db => {
        await this.requireLiveIssuance(this.cell(space.cellId).pool === this.control ? db : control,issuanceId,leaseToken);
        await this.current(actor);
        const locked = await db.query(`SELECT policy_version,lifecycle,placement_generation FROM spaces
          WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,owner(actor)]);
        if (!locked.rows[0] || Number(locked.rows[0].policy_version) !== version ||
          Number(locked.rows[0].placement_generation) !== space.placementGeneration ||
          locked.rows[0].lifecycle !== 'active') throw new AuthorityError('STALE_PLACEMENT');
        const active = await db.query(`UPDATE space_credentials SET activated_at=clock_timestamp()
          WHERE space_id=$1 AND credential_id=$2 AND revoked_at IS NULL AND activated_at IS NULL
            AND expires_at>clock_timestamp() RETURNING 1`,[spaceId,issued.id]);
        if (active.rowCount !== 1) throw new AuthorityError('FORBIDDEN');
        await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
          VALUES($1,$2,$3,$4,'key:issue',$5,$6)`,[`aud_${randomUUID()}`,spaceId,owner(actor),issued.id,
          version,space.placementGeneration]);
        await this.current(actor);
      }); }
      catch (error) {
        if (!(error instanceof CommitOutcomeUnknownError)) throw error;
        // A lost COMMIT acknowledgement is not proof of failed activation.
        // Resolve it by readback before entering failure compensation: returning
        // a failure for an already active key would strand usable authority.
        const observed = await this.cell(space.cellId).pool.query(`SELECT activated_at,revoked_at FROM space_credentials
          WHERE space_id=$1 AND credential_id=$2`,[spaceId,issued.id]);
        if (!observed.rows[0]?.activated_at || observed.rows[0].revoked_at) throw error;
      }
      // Only confirmation grants authority. Activation alone can commit while
      // its acknowledgement or the recovery read fails, so it remains inert.
      try { await transaction(this.cell(space.cellId).pool, async db => {
        await this.current(actor);
        const local = await db.query(`SELECT lifecycle,policy_version,placement_generation FROM spaces
          WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,owner(actor)]);
        if (!local.rows[0] || local.rows[0].lifecycle !== 'active' ||
          Number(local.rows[0].policy_version) !== version ||
          Number(local.rows[0].placement_generation) !== space.placementGeneration)
          throw new AuthorityError('STALE_PLACEMENT');
        await this.requireLiveIssuance(this.cell(space.cellId).pool === this.control ? db : control,issuanceId,leaseToken);
        const confirmed = await db.query(`UPDATE space_credentials SET confirmed_at=clock_timestamp()
          WHERE space_id=$1 AND credential_id=$2 AND activated_at IS NOT NULL
            AND confirmed_at IS NULL AND revoked_at IS NULL RETURNING 1`,[spaceId,issued.id]);
        if (confirmed.rowCount !== 1) throw new AuthorityError('FORBIDDEN');
        await this.current(actor);
      }); }
      catch (error) {
        if (!(error instanceof CommitOutcomeUnknownError)) throw error;
        // A final confirmation COMMIT may have succeeded. Returning the key
        // with an explicit uncertain outcome avoids rejecting a live bearer.
        // If it did not commit, regional admission keeps it inert and
        // reconciliation revokes it; the caller must check before using it.
        return { ...issued, confirmation: 'unknown' };
      }
      // Completion and reconciliation cancellation contend on this journal
      // row. Once completion wins, a later routine reconcile must leave the
      // provider key alone; if cancellation wins, the issuer cannot succeed.
      let completed;
      try {
        completed = await control.query(`UPDATE agent_key_issuances i SET completed_at=clock_timestamp()
          FROM space_directory d WHERE i.issuance_id=$1 AND i.space_id=d.space_id
            AND i.credential_id=$2 AND i.cancelled_at IS NULL AND i.provider_revoked_at IS NULL
            AND i.settled_without_key_at IS NULL AND i.completed_at IS NULL
            AND d.issuance_lease_token=$3 AND d.issuance_lease_until>clock_timestamp()
          RETURNING 1`,[issuanceId,issued.id,leaseToken]);
      } catch (error) {
        // An unavailable acknowledgement cannot establish whether the control
        // commit happened. A successful readback of an incomplete journal is
        // a definite failure; only an unavailable or committed readback can
        // leave the caller with an uncertain result.
        const observed = await control.query(`SELECT completed_at FROM agent_key_issuances
          WHERE issuance_id=$1`,[issuanceId]).catch(() => null);
        if (observed && !observed.rows[0]?.completed_at) throw error;
        return { ...issued, confirmation: 'unknown' };
      }
      if (completed.rowCount !== 1) throw new AuthorityError('STALE_PLACEMENT','Issuance was cancelled');
      return issued;
    } catch (error) {
      if (createFailed) {
        // The create call has settled, but a lost provider acknowledgement can
        // still hide a key. Correlation readback must succeed before declaring
        // an empty issuance settled; provider outages leave it retryable.
        await control.query(`UPDATE agent_key_issuances SET create_failed_at=clock_timestamp()
          WHERE issuance_id=$1 AND create_failed_at IS NULL`,[issuanceId]).catch(() => {});
        let found: string | null | undefined;
        try { found = await this.keys.find(owner(actor),issuanceId); }
        catch { found = undefined; }
        if (found === null) await control.query(`UPDATE agent_key_issuances
          SET settled_without_key_at=clock_timestamp() WHERE issuance_id=$1 AND credential_id IS NULL
            AND provider_revoked_at IS NULL AND settled_without_key_at IS NULL`,[issuanceId]);
        else if (found) {
          await control.query(`UPDATE agent_key_issuances SET credential_id=$2
            WHERE issuance_id=$1 AND (credential_id IS NULL OR credential_id=$2)`,[issuanceId,found]).catch(() => {});
          await this.keys.revoke(found,owner(actor)).then(() => control.query(`UPDATE agent_key_issuances
            SET credential_id=$2,provider_revoked_at=clock_timestamp()
            WHERE issuance_id=$1 AND (credential_id IS NULL OR credential_id=$2)`,[issuanceId,found])).catch(() => {});
        }
      }
      // Compensation is cell-first so an interrupted directory publication or
      // later reconcile cannot turn a rejected issuance into usable authority.
      if (created) {
        const failed = created;
        await this.failIssuedKey(this.cell(space.cellId),spaceId,owner(actor),failed.id).catch(() => {});
        await this.revokeProvider(this.cell(space.cellId),space,owner(actor),failed.id,control).catch(async () => {
          await this.keys.revoke(failed.id,owner(actor)).then(() => control.query(`UPDATE agent_key_issuances
            SET credential_id=$2,provider_revoked_at=clock_timestamp()
            WHERE issuance_id=$1 AND (credential_id IS NULL OR credential_id=$2)`,[issuanceId,failed.id])).catch(() => {});
        });
      }
      throw error;
    }
  }
  private async revokeProvider(cell: CellDatabase, space: SpaceInfo, ownerPrincipalId: string, keyId: string,
    control: Pick<pg.Pool, 'query'> = this.control): Promise<void> {
    await this.keys.revoke(keyId,ownerPrincipalId);
    await this.markProviderRevoked(cell,space,ownerPrincipalId,keyId);
    await control.query(`UPDATE agent_key_issuances SET provider_revoked_at=clock_timestamp()
      WHERE space_id=$1 AND credential_id=$2 AND provider_revoked_at IS NULL`,[space.spaceId,keyId]);
  }
  private async markProviderRevoked(cell: CellDatabase, space: SpaceInfo, ownerPrincipalId: string,
    keyId: string): Promise<void> {
    await transaction(cell.pool, async db => {
      const changed = await db.query(`UPDATE space_credentials SET provider_revoked_at=clock_timestamp()
        WHERE space_id=$1 AND credential_id=$2 AND provider_revoked_at IS NULL RETURNING 1`,[space.spaceId,keyId]);
      if (changed.rowCount === 1) await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        SELECT $1,$2,$3,$4,'key:provider-revoke',policy_version,placement_generation FROM spaces WHERE space_id=$2`,
      [`aud_${randomUUID()}`,space.spaceId,ownerPrincipalId,keyId]);
    });
  }
  async revokeAgentKey(actor: VerifiedCredential, spaceId: string, keyId: string): Promise<void> {
    return this.revokeAgentKeyInternal(actor,spaceId,keyId,false);
  }
  private async revokeAgentKeyInternal(actor: VerifiedCredential, spaceId: string, keyId: string,
    requireActive: boolean): Promise<void> {
    actor = snapshotOwner(actor);
    const space = await this.owned(actor,spaceId);
    if (!validId(keyId)) throw new AuthorityError('INVALID_ARGUMENT');
    await this.current(actor);
    const existing = await this.cell(space.cellId).pool.query(`SELECT revoked_at,provider_revoked_at FROM space_credentials
      WHERE space_id=$1 AND credential_id=$2 AND owner_principal_id=$3`,[spaceId,keyId,owner(actor)]);
    if (!existing.rows[0]) throw new AuthorityError('NOT_FOUND');
    if (existing.rows[0].revoked_at) {
      if (requireActive) throw new AuthorityError('STALE_PLACEMENT','Rotation source already revoked');
      if (!existing.rows[0].provider_revoked_at) {
        await this.current(actor);
        await this.revokeProvider(this.cell(space.cellId),space,owner(actor),keyId);
      }
      await this.current(actor);
      if (space.policyVersion !== safeVersion((await this.cell(space.cellId).pool.query('SELECT policy_version FROM spaces WHERE space_id=$1',[spaceId])).rows[0].policy_version)) {
        await this.current(actor);
        await this.reconcile(spaceId);
      }
      return;
    }
    const version = await transaction(this.cell(space.cellId).pool, async db => {
      await this.current(actor);
      const locked = await db.query(`SELECT policy_version FROM spaces WHERE space_id=$1 AND owner_principal_id=$2 FOR UPDATE`,[spaceId,owner(actor)]);
      if (!locked.rows[0] || Number(locked.rows[0].policy_version) !== space.policyVersion) throw new AuthorityError('STALE_PLACEMENT');
      const revoked = await db.query(`UPDATE space_credentials SET revoked_at=clock_timestamp()
        WHERE space_id=$1 AND credential_id=$2 AND owner_principal_id=$3 AND revoked_at IS NULL RETURNING 1`,[spaceId,keyId,owner(actor)]);
      if (revoked.rowCount !== 1) throw new AuthorityError(requireActive ? 'STALE_PLACEMENT' : 'NOT_FOUND');
      await db.query(`DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2`,[spaceId,keyId]);
      const changed = await db.query(`UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1 RETURNING policy_version,placement_generation`,[spaceId]);
      await db.query(`INSERT INTO space_audit(audit_id,space_id,actor_principal_id,credential_id,action,policy_version,placement_generation)
        VALUES($1,$2,$3,$4,'key:revoke',$5,$6)`,[`aud_${randomUUID()}`,spaceId,owner(actor),keyId,
        changed.rows[0].policy_version,changed.rows[0].placement_generation]);
      await this.current(actor);
      return Number(changed.rows[0].policy_version);
    });
    let publishError: unknown;
    try { await this.current(actor); await this.publish(space,version,space.lifecycle); }
    catch (error) { publishError = error; }
    // Local revocation is authoritative. Revoke the AuthFn primitive even when
    // the control directory is unavailable, then report the failed publication.
    await this.current(actor);
    await this.revokeProvider(this.cell(space.cellId),space,owner(actor),keyId);
    if (publishError) throw publishError;
  }
  async rotateAgentKey(actor: VerifiedCredential, spaceId: string, oldKeyId: string, expiresAt: Date,
    grants: readonly CollectionGrant[]): Promise<IssuedAgentKey> {
    actor = snapshotOwner(actor);
    if (!expiresAt || types.isProxy(expiresAt) || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new AuthorityError('INVALID_ARGUMENT');
    expiresAt = new Date(expiresAt.getTime());
    grants = snapshotGrants(grants,expiresAt);
    const space = await this.owned(actor,spaceId);
    if (space.lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    await this.requireGrantCollections(this.cell(space.cellId).pool,spaceId,grants);
    // Rotation consumes the old key once. A repeated or concurrent request
    // cannot turn an idempotent revoke into another provider issuance.
    await this.revokeAgentKeyInternal(actor,spaceId,oldKeyId,true);
    return this.issueAgentKey(actor,spaceId,expiresAt,grants);
  }
  async audit(actor: VerifiedCredential, spaceId: string, cursor?: string): Promise<SpaceAuditPage> {
    actor = snapshotOwner(actor);
    let after: { recordedAt: string; auditId: string } | undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new AuthorityError('INVALID_ARGUMENT');
      }
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || types.isProxy(decoded)) throw new Error('Invalid cursor');
        const value = decoded as Record<string, unknown>;
        if (value.spaceId !== spaceId || typeof value.recordedAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.recordedAt) ||
          !Number.isFinite(Date.parse(value.recordedAt)) || !validId(value.auditId)) throw new Error('Invalid cursor');
        after = {recordedAt:value.recordedAt,auditId:value.auditId};
      } catch { throw new AuthorityError('INVALID_ARGUMENT'); }
    }
    const space = await this.owned(actor,spaceId);
    await this.current(actor);
    const rows = await this.cell(space.cellId).pool.query(`SELECT audit_id,action,credential_id,policy_version,placement_generation,recorded_at,details,
        to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM space_audit WHERE space_id=$1 AND ($2::timestamptz IS NULL OR (recorded_at,audit_id)>($2::timestamptz,$3))
      ORDER BY recorded_at,audit_id LIMIT $4`,[spaceId,after?.recordedAt ?? null,after?.auditId ?? null,auditPageSize+1]);
    await this.current(actor);
    const page = rows.rows.slice(0,auditPageSize);
    const entries = page.map(row => ({audit_id:row.audit_id,action:row.action,credential_id:row.credential_id,
      policy_version:row.policy_version,placement_generation:row.placement_generation,
      recorded_at:row.recorded_at,details:row.details}));
    const last = page.at(-1);
    return { entries, nextCursor: rows.rows.length > auditPageSize && last ?
      Buffer.from(JSON.stringify({spaceId,recordedAt:last.cursor_time,auditId:last.audit_id})).toString('base64url') : null };
  }
}

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseRevision } from '@stateplane/contracts';
import type { Capability, CollectionId, RecordRef, Revision, SpaceId } from '@stateplane/contracts';

export type RecordMutation = 'create' | 'replace' | 'patch' | 'delete';
export type IndexValue =
  | { field: string; kind: 'null' }
  | { field: string; kind: 'string' | 'date-time'; value: string }
  | { field: string; kind: 'number'; value: number }
  | { field: string; kind: 'boolean'; value: boolean };
export interface UniqueValue { name: string; encodedValue: string }
export interface AuthorityScope {
  spaceId: SpaceId; collectionId: CollectionId; principalId: string; credentialId: string;
  /** outbox:worker is internal and is never grantable or routable. */
  capability: Capability | 'outbox:worker'; policyVersion: number; placementGeneration: number;
}
export interface RecordChange {
  operation: RecordMutation; idempotencyKey: string;
  /** SHA-256 of the validated canonical request, excluding the current schema version. */
  requestDigest: string;
  recordId?: string; expectedRevision?: Revision; expectedSchemaVersion?: number;
  /** Canonical UTF-8 JSON object; omitted on delete. */
  canonicalData?: string; normalizedExternalKey?: string;
  /** Complete derived sets are required for replace and patch, including empty arrays. */
  unique?: readonly UniqueValue[]; indexes?: readonly IndexValue[];
}
export interface Receipt {
  contractVersion: '1'; receiptId: string; spaceId: SpaceId;
  ref: { kind: 'record'; id: string }; operation: RecordMutation;
  beforeRevision: number | null; revision: number; schemaVersion: number;
  committedAt: string; expiresAt: string;
  projection: { generation: number; state: 'pending' }; replayed: boolean;
}
export interface AuthorityRecord {
  ref: RecordRef; revision: number; schemaVersion: number; canonicalData: string;
  keyMode: 'generated' | 'external'; normalizedKey: string; tombstone: boolean;
}
export interface OutboxDelivery {
  eventId: string; ref: RecordRef; revision: number; generation: number; attempt: number;
}
export type ScalarPredicate =
  | { field: string; kind: 'null'; operator: 'isNull' }
  | { field: string; kind: 'string' | 'date-time' | 'number' | 'boolean'; operator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: string | number | boolean };

function comparison(predicate: Exclude<ScalarPredicate, { kind: 'null' }>, alias: string, params: unknown[]): string {
  const column = { string:'string_value','date-time':'time_value',number:'number_value',boolean:'boolean_value' }[predicate.kind];
  const operator = { eq:'=',lt:'<',lte:'<=',gt:'>',gte:'>=' }[predicate.operator];
  if (!operator) throw new AuthorityError('INVALID_ARGUMENT');
  if ((predicate.kind === 'number' && (typeof predicate.value !== 'number' || !Number.isFinite(predicate.value)))
    || (predicate.kind === 'boolean' && typeof predicate.value !== 'boolean')
    || (predicate.kind === 'string' && !valueString(predicate.value))
    || (predicate.kind === 'date-time' && !scalarString(predicate.value))) throw new AuthorityError('INVALID_ARGUMENT');
  params.push(predicate.value);
  if (predicate.kind === 'date-time') {
    return ` AND stateplane_instant_sort_key(${alias}.${column}) COLLATE "C" ${operator} stateplane_instant_sort_key($${params.length}::text) COLLATE "C"`;
  }
  return ` AND ${alias}.${column} ${operator} $${params.length}`;
}

export class AuthorityError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = 'AuthorityError'; }
}
export class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) { super('Commit outcome unknown; retry with the same idempotency key', { cause }); }
}

const MAX_JSON_BYTES = 1_048_576;
const MAX_PAGE = 100;
const retryCodes = new Set(['40P01', '40001']);
const validDigest = /^[0-9a-f]{64}$/;
const isSafeInteger = Number.isSafeInteger;
const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function copyReceipt(receipt: Receipt, replayed = receipt.replayed): Receipt {
  return { ...receipt, ref: { ...receipt.ref }, projection: { ...receipt.projection }, replayed };
}
function pendingReceipt(receipt: Receipt, replayed = receipt.replayed): Receipt {
  const result = copyReceipt(receipt, replayed);
  for (const field of ['committedAt', 'expiresAt'] as const) {
    Object.defineProperty(result, field, { configurable: true, enumerable: true,
      get() { throw new AuthorityError('RECEIPT_PENDING', 'Receipt has not committed'); } });
  }
  return result;
}
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const point = value.codePointAt(i)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return false;
    if (point > 0xffff) i++;
  }
  return true;
}
function scalarString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && validUnicode(value);
}
function valueString(value: unknown): value is string {
  return typeof value === 'string' && validUnicode(value);
}

function canonicalValue(value: unknown, depth: number): string {
  if (depth > 64) throw new AuthorityError('SCHEMA_INVALID');
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!validUnicode(value)) throw new AuthorityError('SCHEMA_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuthorityError('SCHEMA_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) parts.push(canonicalValue(value[i], depth + 1));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const parts = Object.keys(object).sort(utf8Compare).map(key => canonicalValue(key, depth + 1) + ':' + canonicalValue(object[key], depth + 1));
    return `{${parts.join(',')}}`;
  }
  throw new AuthorityError('SCHEMA_INVALID');
}

/** Admit serialized JSON only. Never stringify caller-owned objects or proxies. */
export function canonicalJsonObject(serialized: string): string {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw new AuthorityError('SCHEMA_INVALID');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new AuthorityError('SCHEMA_INVALID'); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new AuthorityError('SCHEMA_INVALID');
  const result = canonicalValue(parsed, 0);
  if (result !== serialized || Buffer.byteLength(result, 'utf8') > MAX_JSON_BYTES) throw new AuthorityError('SCHEMA_INVALID', 'JSON must be canonical and within the byte limit');
  return result;
}

type PoolLike = Pick<pg.Pool, 'connect'>;
type Client = pg.PoolClient;
type PendingReceipt = { response: Receipt; returned: Receipt[]; digest: string; collectionId: CollectionId; key: string };
type ReadyReceipt = { receiptId: string; returned: Receipt[]; committedAt: string; expiresAt: string };
export interface JoinedReceiptState {
  pending: Map<string, PendingReceipt>;
  replayed: Map<string, { collectionId: CollectionId; digest: string; response: Receipt }>;
  ready: ReadyReceipt[];
}
const scopeIds = (scope: AuthorityScope) => [scope.spaceId, scope.collectionId];

function validateChangeShape(change: RecordChange): void {
  if (!['create','replace','patch','delete'].includes(change.operation) || !scalarString(change.idempotencyKey)
    || typeof change.requestDigest !== 'string' || !validDigest.test(change.requestDigest)) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.operation === 'create') {
    if (change.recordId !== undefined || change.expectedRevision !== undefined) throw new AuthorityError('INVALID_ARGUMENT');
  } else if (!scalarString(change.recordId) || change.expectedRevision === undefined) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.normalizedExternalKey !== undefined && (change.operation !== 'create' || !scalarString(change.normalizedExternalKey))) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.expectedRevision !== undefined) parseRevision(change.expectedRevision);
  if (change.expectedSchemaVersion !== undefined && (!isSafeInteger(change.expectedSchemaVersion) || change.expectedSchemaVersion < 1)) throw new AuthorityError('INVALID_ARGUMENT');
  if (change.operation === 'delete' && (change.canonicalData !== undefined || change.unique?.length || change.indexes?.length)) throw new AuthorityError('INVALID_ARGUMENT');
  if ((change.operation === 'replace' || change.operation === 'patch') && (!change.unique || !change.indexes)) throw new AuthorityError('INVALID_ARGUMENT');
}

function snapshotUnique(source: readonly UniqueValue[] | undefined): readonly UniqueValue[] | undefined {
  if (source === undefined) return undefined;
  if (!Array.isArray(source)) throw new AuthorityError('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const values: UniqueValue[] = [];
  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    if (!entry || !scalarString(entry.name) || !scalarString(entry.encodedValue)) throw new AuthorityError('INVALID_ARGUMENT');
    const key = JSON.stringify([entry.name, entry.encodedValue]);
    if (seen.has(key)) throw new AuthorityError('INVALID_ARGUMENT');
    seen.add(key);
    values.push(Object.freeze({ name: entry.name, encodedValue: entry.encodedValue }));
  }
  return Object.freeze(values);
}

function snapshotIndexes(source: readonly IndexValue[] | undefined): readonly IndexValue[] | undefined {
  if (source === undefined) return undefined;
  if (!Array.isArray(source)) throw new AuthorityError('INVALID_ARGUMENT');
  const seen = new Set<string>();
  const values: IndexValue[] = [];
  for (let i = 0; i < source.length; i++) {
    const entry = source[i];
    if (!entry || !scalarString(entry.field) || seen.has(entry.field)) throw new AuthorityError('INVALID_ARGUMENT');
    seen.add(entry.field);
    const value = 'value' in entry ? entry.value : null;
    if ((entry.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      || (entry.kind === 'string' && !valueString(value))
      || (entry.kind === 'date-time' && !scalarString(value))
      || (entry.kind === 'boolean' && typeof value !== 'boolean')
      || (entry.kind === 'null' && value !== null && value !== undefined)
      || !['null','string','date-time','number','boolean'].includes(entry.kind)) throw new AuthorityError('INVALID_ARGUMENT');
    values.push(Object.freeze({ ...entry }));
  }
  return Object.freeze(values);
}

/** Detach caller-owned fields before any await, including the first retry attempt. */
function snapshotChange(source: RecordChange): Readonly<RecordChange> {
  if (!source || typeof source !== 'object') throw new AuthorityError('INVALID_ARGUMENT');
  const change: RecordChange = {
    operation: source.operation, idempotencyKey: source.idempotencyKey, requestDigest: source.requestDigest,
    recordId: source.recordId, expectedRevision: source.expectedRevision,
    expectedSchemaVersion: source.expectedSchemaVersion, canonicalData: source.canonicalData,
    normalizedExternalKey: source.normalizedExternalKey,
    unique: snapshotUnique(source.unique), indexes: snapshotIndexes(source.indexes)
  };
  validateChangeShape(change);
  return Object.freeze(change);
}

export class PostgresAuthority {
  constructor(private readonly pool: PoolLike, private readonly receiptRetentionSeconds: number) {
    if (!isSafeInteger(receiptRetentionSeconds) || receiptRetentionSeconds < 1) throw new RangeError('Invalid receipt retention');
  }

  /** Callback side effects are never retried. A COMMIT failure is deliberately ambiguous. */
  async transaction<T>(scope: AuthorityScope, fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T> {
    // Capture the authenticated identity before waiting for a pooled connection.
    const fixedScope = Object.freeze({ ...scope });
    if (![fixedScope.spaceId,fixedScope.collectionId,fixedScope.principalId,fixedScope.credentialId].every(scalarString) ||
      !isSafeInteger(fixedScope.policyVersion) || fixedScope.policyVersion < 1 ||
      !isSafeInteger(fixedScope.placementGeneration) || fixedScope.placementGeneration < 1) throw new AuthorityError('INVALID_ARGUMENT');
    const client = await this.pool.connect();
    let begun = false;
    let beginAttempted = false;
    let discard = false;
    let tx: AuthorityTransaction | undefined;
    try {
      beginAttempted = true;
      await client.query('BEGIN'); begun = true;
      tx = new AuthorityTransaction(client, fixedScope, this.receiptRetentionSeconds);
      await tx.checkScope();
      const result = await fn(tx);
      tx.sealMutations();
      await tx.settleMutations();
      tx.assertCommittable();
      await tx.checkScope();
      await tx.checkReplayScopes();
      await tx.finalizeReceipts();
      await tx.checkScope();
      await tx.checkReplayScopes();
      await tx.ensureReceiptsCurrent();
      try { await client.query('COMMIT'); begun = false; }
      catch (error) { discard = true; throw new CommitOutcomeUnknownError(error); }
      tx.exposeReceipts();
      return result;
    } catch (error) {
      if (tx) { tx.sealMutations(); await tx.settleMutations(); }
      if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      else if (beginAttempted) discard = true;
      throw error;
    } finally { tx?.close(); client.release(discard); }
  }

  /** Join an already authorized cell transaction; the caller owns COMMIT/ROLLBACK. */
  async transactionOnClient<T>(client: Client, scope: AuthorityScope, fn: (tx: AuthorityTransaction) => Promise<T>,
    deferUntilCommit: (finish: () => Promise<void>, verify: () => Promise<void>, ensureCurrent: () => Promise<void>, expose: () => void,
      close: () => void) => void,
    joinedReceipts?: JoinedReceiptState): Promise<T> {
    const fixedScope = Object.freeze({ ...scope });
    if (![fixedScope.spaceId,fixedScope.collectionId,fixedScope.principalId,fixedScope.credentialId].every(scalarString) ||
      !isSafeInteger(fixedScope.policyVersion) || fixedScope.policyVersion < 1 ||
      !isSafeInteger(fixedScope.placementGeneration) || fixedScope.placementGeneration < 1) throw new AuthorityError('INVALID_ARGUMENT');
    const tx = new AuthorityTransaction(client, fixedScope, this.receiptRetentionSeconds, joinedReceipts);
    let deferred = false;
    try {
      await tx.checkScope();
      const result = await fn(tx);
      tx.sealMutations();
      await tx.settleMutations();
      tx.assertCommittable();
      const finish = async () => {
        tx.assertCommittable();
        await tx.checkScope();
        await tx.checkReplayScopes();
      };
      const verify = async () => {
        tx.assertCommittable();
        await tx.checkScope();
        await tx.checkReplayScopes();
        await tx.finalizeReceipts();
      };
      deferUntilCommit(finish, verify, () => tx.ensureReceiptsCurrent(), () => tx.exposeReceipts(), () => tx.close());
      deferred = true;
      return result;
    } catch (error) {
      tx.sealMutations();
      await tx.settleMutations();
      throw error;
    } finally { if (!deferred) tx.close(); }
  }

  /** Retry only server-confirmed deadlock/serialization rollbacks, never failed COMMIT. */
  async mutate(scope: AuthorityScope, change: RecordChange): Promise<Receipt> {
    const fixedScope = Object.freeze({ ...scope });
    const fixedChange = snapshotChange(change);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.transaction(fixedScope, tx => tx.mutate(fixedChange)); }
      catch (error) {
        if (!retryCodes.has((error as { code?: string }).code ?? '') || attempt === 2) throw error;
      }
    }
    throw new Error('unreachable');
  }
}

export class AuthorityTransaction {
  private active = true;
  private mutationFailed = false;
  private mutationError: unknown;
  private readonly pendingReceipts: JoinedReceiptState['pending'];
  private readonly joinedReplays: JoinedReceiptState['replayed'];
  private readonly readyReceipts: JoinedReceiptState['ready'];
  private readonly activeOperations = new Set<Promise<unknown>>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly reservedIdentities = new Map<string, { operation: RecordMutation; key: string }>();
  private admittingMutations = true;
  private readonly replayCollections = new Set<CollectionId>();
  readonly #scope: Readonly<AuthorityScope>;
  get scope(): Readonly<AuthorityScope> { return this.#scope; }
  constructor(private readonly client: Client, scope: AuthorityScope, private readonly retentionSeconds: number,
    joinedReceipts?: JoinedReceiptState) {
    this.#scope = Object.freeze({ ...scope });
    this.pendingReceipts = joinedReceipts?.pending ?? new Map();
    this.joinedReplays = joinedReceipts?.replayed ?? new Map();
    this.readyReceipts = joinedReceipts?.ready ?? [];
  }
  close() { this.active = false; this.admittingMutations = false; this.activeOperations.clear(); this.reservedIdentities.clear(); this.replayCollections.clear(); }
  /** A caught mutation error must not turn a partial write into a successful commit. */
  assertCommittable() {
    if (this.mutationFailed) throw this.mutationError;
  }
  sealMutations() { this.admittingMutations = false; }
  async settleMutations() { await Promise.allSettled(this.activeOperations); }
  private admitOperation<T>(work: () => Promise<T>, rollbackOnError = false): Promise<T> {
    if (!this.admittingMutations || !this.active) return Promise.reject(new AuthorityError('INVALID_ARGUMENT', 'Transaction admission ended'));
    const running = Promise.resolve().then(() => { this.assertCommittable(); return work(); })
      .catch(error => { if (rollbackOnError) { this.mutationFailed = true; this.mutationError = error; } throw error; });
    this.activeOperations.add(running);
    void running.then(() => this.activeOperations.delete(running), () => this.activeOperations.delete(running));
    return running;
  }
  private query(sql: string, values: unknown[] = []) {
    if (!this.active) throw new AuthorityError('INVALID_ARGUMENT', 'Transaction ended');
    return this.client.query(sql, values);
  }

  /** Hold shared policy/placement/collection locks through commit. Application policy remains explicit. */
  async checkScope(): Promise<void> {
    const { spaceId, collectionId, principalId, credentialId, capability, policyVersion, placementGeneration } = this.#scope;
    const result = await this.query(`SELECT s.owner_principal_id, s.lifecycle, s.policy_version, s.placement_generation,
      c.lifecycle AS collection_lifecycle, g.capabilities, g.expires_at, g.grant_current
      FROM spaces s JOIN collections c ON c.space_id=s.space_id
      LEFT JOIN LATERAL (
        SELECT capabilities,expires_at,expires_at > clock_timestamp() AS grant_current FROM collection_grants
        WHERE space_id=c.space_id AND collection_id=c.collection_id AND credential_id=$3
          AND s.owner_principal_id<>$4 FOR SHARE
      ) g ON TRUE
      WHERE s.space_id=$1 AND c.collection_id=$2 FOR SHARE OF s,c`, [spaceId, collectionId, credentialId, principalId]);
    const row = result.rows[0];
    if (!row) throw new AuthorityError('NOT_FOUND');
    if (Number(row.policy_version) !== policyVersion || Number(row.placement_generation) !== placementGeneration) throw new AuthorityError('FORBIDDEN', 'Policy or placement changed');
    if (['suspended','deleting','deleted'].includes(row.lifecycle)) throw new AuthorityError('SPACE_UNAVAILABLE');
    if (row.collection_lifecycle === 'deleted') throw new AuthorityError('NOT_FOUND');
    if (capability === 'outbox:worker' && (principalId !== 'system:projection' || credentialId !== 'system:projection'))
      throw new AuthorityError('FORBIDDEN');
    if (capability === 'outbox:worker' && row.lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (row.owner_principal_id !== principalId && capability !== 'outbox:worker' &&
      (!row.capabilities?.includes(capability) || (row.expires_at && !row.grant_current))) throw new AuthorityError('FORBIDDEN');
    if (row.collection_lifecycle === 'readOnly' && (capability === 'records:write' || capability === 'claims:review')) throw new AuthorityError('SPACE_UNAVAILABLE');
  }

  private ref(id: string): RecordRef { return { spaceId: this.#scope.spaceId, collectionId: this.#scope.collectionId, id }; }
  getRecord(recordId: string, includeTombstone = false): Promise<AuthorityRecord | null> {
    return this.admitOperation(() => this.readRecord(recordId,includeTombstone));
  }
  private async readRecord(recordId: string, includeTombstone = false): Promise<AuthorityRecord | null> {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!scalarString(recordId)) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`SELECT record_id,revision,schema_version,canonical_data,key_mode,normalized_key,tombstone FROM records
      WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 ${includeTombstone ? '' : 'AND NOT tombstone'}`, [...scopeIds(this.#scope), recordId]);
    const row = result.rows[0];
    return row ? { ref: this.ref(row.record_id), revision: Number(row.revision), schemaVersion: Number(row.schema_version),
      canonicalData: row.canonical_data, keyMode: row.key_mode, normalizedKey: row.normalized_key, tombstone: row.tombstone } : null;
  }
  getByKey(mode: 'generated' | 'external', key: string): Promise<AuthorityRecord | null> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!['generated','external'].includes(mode) || !scalarString(key)) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`SELECT record_id FROM records WHERE space_id=$1 AND collection_id=$2
      AND key_mode=$3 AND normalized_key=$4 AND NOT tombstone`, [...scopeIds(this.#scope), mode, key]);
    return result.rows[0] ? this.readRecord(result.rows[0].record_id) : null;
    });
  }
  private async findReceipt(operation: RecordMutation, key: string): Promise<{ collectionId: CollectionId; requestDigest: string; response: Receipt } | null> {
    const result = await this.query(`SELECT collection_id,request_digest,response FROM idempotency_receipts
      WHERE space_id=$1 AND credential_id=$2 AND operation=$3 AND idempotency_key=$4 AND expires_at>clock_timestamp()`,
    [this.#scope.spaceId, this.#scope.credentialId, operation, key]);
    const row = result.rows[0];
    return row ? { collectionId: row.collection_id, requestDigest: row.request_digest, response: row.response } : null;
  }
  private async receiptTimes(): Promise<{ committedAt: string; expiresAt: string }> {
    const clock = await this.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at AS committed_at, at + ($1::bigint * interval '1 second') AS expires_at FROM stamp`, [this.retentionSeconds]);
    return { committedAt:(clock.rows[0].committed_at as Date).toISOString(),
      expiresAt:(clock.rows[0].expires_at as Date).toISOString() };
  }
  /** Stamp receipts using the database clock after callback work, immediately before COMMIT. */
  async finalizeReceipts(): Promise<void> {
    if (this.pendingReceipts.size) {
      const { committedAt, expiresAt } = await this.receiptTimes();
      for (const pending of this.pendingReceipts.values()) {
        pending.response.committedAt = committedAt;
        pending.response.expiresAt = expiresAt;
        await this.query(`INSERT INTO idempotency_receipts(receipt_id,space_id,collection_id,credential_id,operation,idempotency_key,request_digest,record_id,response,committed_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [pending.response.receiptId,this.#scope.spaceId,pending.collectionId,
          this.#scope.credentialId,pending.response.operation,pending.key,pending.digest,pending.response.ref.id,
          JSON.stringify(pending.response),committedAt,expiresAt]);
        this.readyReceipts.push({receiptId:pending.response.receiptId,returned:pending.returned,committedAt,expiresAt});
      }
      this.pendingReceipts.clear();
    }
    for (const { operation, key } of this.reservedIdentities.values()) {
      await this.query(`WITH identity AS (DELETE FROM receipt_reservations
          WHERE space_id=$1 AND credential_id=$3 AND operation=$4 AND idempotency_key=$5 RETURNING 1)
        DELETE FROM receipt_reservation_scopes WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3
          AND operation=$4 AND idempotency_key=$5 AND EXISTS(SELECT 1 FROM identity)`,
        [this.#scope.spaceId,this.#scope.collectionId,this.#scope.credentialId,operation,key]);
    }
    this.reservedIdentities.clear();
  }
  /** A slow final cell check must abort rather than commit an already expired
   * receipt and let an immediate retry create a second record. */
  async ensureReceiptsCurrent(): Promise<void> {
    if (!this.readyReceipts.length) return;
    const ids=this.readyReceipts.map(ready=>ready.receiptId);
    const result=await this.query(`SELECT count(*)::int AS expired FROM idempotency_receipts
      WHERE receipt_id=ANY($1::text[]) AND expires_at<=clock_timestamp()`,[ids]);
    if (result.rows[0]?.expired !== 0) throw new AuthorityError('RECEIPT_PENDING','Receipt expired before commit');
  }
  exposeReceipts(): void {
    for (const ready of this.readyReceipts) for (const returned of ready.returned) {
      Object.defineProperty(returned, 'committedAt', { value:ready.committedAt, writable:true, enumerable:true, configurable:true });
      Object.defineProperty(returned, 'expiresAt', { value:ready.expiresAt, writable:true, enumerable:true, configurable:true });
    }
    this.readyReceipts.length = 0;
  }
  private async authorizeOriginal(collectionId: CollectionId): Promise<void> {
    if (collectionId === this.#scope.collectionId) return;
    await new AuthorityTransaction(this.client, { ...this.#scope, collectionId }, this.retentionSeconds).checkScope();
    this.replayCollections.add(collectionId);
  }

  async checkReplayScopes(): Promise<void> {
    for (const collectionId of this.replayCollections) {
      await new AuthorityTransaction(this.client, { ...this.#scope, collectionId }, this.retentionSeconds).checkScope();
    }
  }

  async mutate(change: RecordChange): Promise<Receipt> {
    try {
      if (!this.admittingMutations || !this.active) throw new AuthorityError('INVALID_ARGUMENT', 'Transaction mutation admission ended');
      this.assertCommittable();
      const fixed = snapshotChange(change);
      const tail = this.mutationTail;
      const work = (async () => { await tail; this.assertCommittable(); return this.mutateOnce(fixed); })()
        .catch(error => { this.mutationFailed = true; this.mutationError = error; throw error; });
      this.mutationTail = work.then(() => {}, () => {});
      this.activeOperations.add(work);
      try { return await work; }
      finally {
        this.activeOperations.delete(work);
      }
    }
    catch (error) {
      this.mutationFailed = true;
      this.mutationError = error;
      throw error;
    }
  }

  /** Uncommitted unique rows provide Hyperdrive-compatible, scoped try-locks. */
  private async reserveIdentity(change: Readonly<RecordChange>, identity: string): Promise<void> {
    if (this.reservedIdentities.has(identity)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.query(`SELECT reservation_state,original_collection_id FROM stateplane_try_reserve_receipt($1,$2,$3,$4,$5,$6)`,
        [this.#scope.spaceId,this.#scope.collectionId,this.#scope.credentialId,this.#scope.principalId,
          change.operation,change.idempotencyKey]);
      const row = result.rows[0];
      if (row?.reservation_state === 'reserved') {
        this.reservedIdentities.set(identity,{operation:change.operation,key:change.idempotencyKey});
        return;
      }
      if (row?.reservation_state === 'pending' && scalarString(row.original_collection_id)) {
        // The owner can finish between the server probe and response delivery.
        // Retry once before disclosing pending state or denying a fresh write.
        if (attempt === 0) continue;
        await this.checkScope();
        await this.authorizeOriginal(row.original_collection_id);
        throw new AuthorityError('RECEIPT_PENDING');
      }
      if (row?.reservation_state === 'unresolved') throw new AuthorityError('FORBIDDEN');
      throw new Error('Invalid receipt reservation result');
    }
  }

  private async lookupReplay(change: RecordChange, identity: string): Promise<Receipt | null> {
    const scope = this.#scope;
    const pending = this.pendingReceipts.get(identity);
    if (pending) {
      await this.authorizeOriginal(pending.collectionId);
      if (change.operation !== 'delete') canonicalJsonObject(change.canonicalData!);
      if (pending.digest !== change.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      const replay = pendingReceipt(pending.response, true);
      pending.returned.push(replay);
      return replay;
    }
    const joinedReplay = this.joinedReplays.get(identity);
    if (joinedReplay) {
      await this.authorizeOriginal(joinedReplay.collectionId);
      if (change.operation !== 'delete') canonicalJsonObject(change.canonicalData!);
      if (joinedReplay.digest !== change.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      return copyReceipt(joinedReplay.response, true);
    }
    await this.reserveIdentity(change,identity);
    const previous = await this.findReceipt(change.operation, change.idempotencyKey);
    if (previous) {
      await this.authorizeOriginal(previous.collectionId);
      if (change.operation !== 'delete') canonicalJsonObject(change.canonicalData!);
      if (previous.requestDigest !== change.requestDigest) throw new AuthorityError('IDEMPOTENCY_MISMATCH');
      this.joinedReplays.set(identity,{collectionId:previous.collectionId,digest:previous.requestDigest,response:previous.response});
      return copyReceipt(previous.response, true);
    }
    await this.query(`DELETE FROM idempotency_receipts WHERE space_id=$1 AND credential_id=$2
      AND operation=$3 AND idempotency_key=$4 AND expires_at<=clock_timestamp()`,
    [scope.spaceId,scope.credentialId,change.operation,change.idempotencyKey]);
    return null;
  }

  private async currentVersion(change: RecordChange): Promise<{ schemaVersion: number; generation: number }> {
    const scope = this.#scope;
    const versions = await this.query(`SELECT s.lifecycle,s.placement_generation,c.lifecycle AS collection_lifecycle,c.schema_version
      FROM spaces s JOIN collections c ON c.space_id=s.space_id WHERE s.space_id=$1 AND c.collection_id=$2`, scopeIds(scope));
    const version = versions.rows[0];
    if (version.lifecycle !== 'active' || version.collection_lifecycle !== 'active') throw new AuthorityError('SPACE_UNAVAILABLE');
    if (change.operation !== 'delete') canonicalJsonObject(change.canonicalData!);
    if (change.expectedSchemaVersion !== undefined && change.expectedSchemaVersion !== Number(version.schema_version)) throw new AuthorityError('SCHEMA_CONFLICT');
    return { schemaVersion:Number(version.schema_version), generation:Number(version.placement_generation) };
  }

  private async writeRecord(change: RecordChange, schemaVersion: number): Promise<{ recordId: string; beforeRevision: number | null; revision: number }> {
    const scope = this.#scope;
    const recordId = change.operation === 'create' ? `rec_${randomUUID()}` : change.recordId!;
    if (change.operation === 'create') {
      const mode = change.normalizedExternalKey === undefined ? 'generated' : 'external';
      await this.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
        VALUES($1,$2,$3,1,$4,$5,$6,$7::text,$7::jsonb)`, [...scopeIds(scope),recordId,schemaVersion,mode,change.normalizedExternalKey ?? recordId,change.canonicalData]);
      return { recordId, beforeRevision:null, revision:1 };
    }
    const updated = await this.query(`UPDATE records SET revision=revision+1,schema_version=$5,
      canonical_data=CASE WHEN $6::boolean THEN canonical_data ELSE $7::text END,
      data=CASE WHEN $6::boolean THEN data ELSE $7::jsonb END,
      tombstone=$6,updated_at=clock_timestamp()
      WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND revision=$4 AND NOT tombstone RETURNING revision`,
    [...scopeIds(scope),recordId,change.expectedRevision,schemaVersion,change.operation === 'delete',change.canonicalData ?? null]);
    if (!updated.rowCount) {
      const exists = await this.query('SELECT 1 FROM records WHERE space_id=$1 AND collection_id=$2 AND record_id=$3 AND NOT tombstone',
        [...scopeIds(scope),recordId]);
      throw new AuthorityError(exists.rowCount ? 'REVISION_CONFLICT' : 'NOT_FOUND');
    }
    const revision = Number(updated.rows[0].revision);
    if (change.operation === 'delete') {
      await this.query('INSERT INTO record_tombstones(space_id,collection_id,record_id,revision) VALUES($1,$2,$3,$4)', [...scopeIds(scope),recordId,revision]);
    } else {
      await this.query('DELETE FROM record_unique_keys WHERE space_id=$1 AND collection_id=$2 AND record_id=$3', [...scopeIds(scope),recordId]);
      await this.query('DELETE FROM record_index_values WHERE space_id=$1 AND collection_id=$2 AND record_id=$3', [...scopeIds(scope),recordId]);
    }
    return { recordId, beforeRevision:change.expectedRevision!, revision };
  }

  private async reserveUnique(unique: UniqueValue, recordId: string): Promise<void> {
    const scope = this.#scope;
    const inserted = await this.query(`INSERT INTO record_unique_keys(space_id,collection_id,constraint_name,encoded_value,record_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT (space_id,collection_id,constraint_name,encoded_value) DO NOTHING
      RETURNING record_id`, [...scopeIds(scope),unique.name,unique.encodedValue,recordId]);
    if (inserted.rowCount) return;
    const holder = await this.query(`SELECT r.tombstone FROM record_unique_keys u JOIN records r
      ON r.space_id=u.space_id AND r.collection_id=u.collection_id AND r.record_id=u.record_id
      WHERE u.space_id=$1 AND u.collection_id=$2 AND u.constraint_name=$3 AND u.encoded_value=$4`,
    [...scopeIds(scope),unique.name,unique.encodedValue]);
    throw new AuthorityError(holder.rows[0]?.tombstone ? 'KEY_RESERVED' : 'UNIQUE_CONFLICT');
  }

  private async writeIndex(field: IndexValue, recordId: string): Promise<void> {
    const value = 'value' in field ? field.value : null;
    await this.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [...scopeIds(this.#scope),recordId,field.field,field.kind,
      field.kind === 'string' ? value : null,field.kind === 'number' ? value : null,
      field.kind === 'boolean' ? value : null,field.kind === 'date-time' ? value : null]);
  }

  private async writeValues(change: RecordChange, recordId: string): Promise<void> {
    if (change.operation === 'delete') return;
    const uniqueValues = change.unique ?? [];
    for (let i = 0; i < uniqueValues.length; i++) await this.reserveUnique(uniqueValues[i], recordId);
    const indexValues = change.indexes ?? [];
    for (let i = 0; i < indexValues.length; i++) await this.writeIndex(indexValues[i], recordId);
  }

  private async appendFacts(change: RecordChange, identity: string, version: { schemaVersion: number; generation: number },
    written: { recordId: string; beforeRevision: number | null; revision: number }): Promise<Receipt> {
    const scope = this.#scope;
    const { recordId, beforeRevision, revision } = written;
    const eventId = `evt_${randomUUID()}`;
    await this.query(`INSERT INTO record_events(event_id,space_id,collection_id,record_id,revision,operation,credential_id,schema_version,canonical_data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [eventId,...scopeIds(scope),recordId,revision,change.operation,scope.credentialId,version.schemaVersion,change.canonicalData ?? '{}']);
    const receiptId = `rcpt_${randomUUID()}`;
    const response: Receipt = { contractVersion:'1',receiptId,spaceId:scope.spaceId,ref:{kind:'record',id:recordId},operation:change.operation,
      beforeRevision,revision,schemaVersion:version.schemaVersion,committedAt:'',expiresAt:'',
      projection:{generation:version.generation,state:'pending'},replayed:false };
    await this.query('INSERT INTO projection_outbox(event_id,space_id,collection_id,record_id,revision,generation) VALUES($1,$2,$3,$4,$5,$6)',
      [eventId,...scopeIds(scope),recordId,revision,version.generation]);
    const returned = pendingReceipt(response);
    this.pendingReceipts.set(identity, { response, returned: [returned], digest:change.requestDigest, collectionId:scope.collectionId, key:change.idempotencyKey });
    return returned;
  }

  private async mutateOnce(change: RecordChange): Promise<Receipt> {
    const scope = this.#scope;
    if (scope.capability !== 'records:write') throw new AuthorityError('FORBIDDEN');
    const identity = JSON.stringify([scope.spaceId,scope.credentialId,change.operation,change.idempotencyKey]);
    const replay = await this.lookupReplay(change, identity);
    if (replay) return replay;
    const version = await this.currentVersion(change);
    try {
      const written = await this.writeRecord(change, version.schemaVersion);
      await this.writeValues(change, written.recordId);
      return await this.appendFacts(change, identity, version, written);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const constraint = (error as { constraint?: string }).constraint;
        throw new AuthorityError(constraint === 'records_space_id_collection_id_key_mode_normalized_key_key' ? 'KEY_RESERVED' : 'UNIQUE_CONFLICT');
      }
      if ((error as { code?: string }).code === '23503') throw new AuthorityError('SCHEMA_CONFLICT');
      throw error;
    }
  }

  /** Shared AND predicate compiler for exact page, count and exists statement snapshots. */
  private compilePredicates(predicates: readonly ScalarPredicate[]) {
    if (this.#scope.capability !== 'records:read') throw new AuthorityError('FORBIDDEN');
    if (!Array.isArray(predicates) || predicates.length > 16) throw new AuthorityError('INVALID_ARGUMENT');
    const params: unknown[] = [...scopeIds(this.#scope)];
    const fragments: string[] = [];
    for (let index = 0; index < predicates.length; index++) {
      const predicate = predicates[index];
      if (!predicate) throw new AuthorityError('INVALID_ARGUMENT');
      if (!scalarString(predicate.field) || !['null','string','date-time','number','boolean'].includes(predicate.kind)) throw new AuthorityError('INVALID_ARGUMENT');
      const alias = `v${index}`;
      params.push(predicate.field,predicate.kind);
      const fieldParam = `$${params.length - 1}`;
      const kindParam = `$${params.length}`;
      let compare = '';
      if (predicate.kind === 'null') {
        if (predicate.operator !== 'isNull') throw new AuthorityError('INVALID_ARGUMENT');
      } else compare = comparison(predicate, alias, params);
      fragments.push(`EXISTS (SELECT 1 FROM record_index_values ${alias} WHERE ${alias}.space_id=r.space_id
        AND ${alias}.collection_id=r.collection_id AND ${alias}.record_id=r.record_id
        AND ${alias}.field_name=${fieldParam} AND ${alias}.value_kind=${kindParam}${compare})`);
    }
    return { params, where:'r.space_id=$1 AND r.collection_id=$2 AND NOT r.tombstone ' + fragments.map(x => `AND ${x}`).join(' ') };
  }

  /** Declaration allowlists, signed cursors and public sort behavior belong to STA-8. */
  queryRecords(predicates: readonly ScalarPredicate[], limit: number): Promise<AuthorityRecord[]> {
    return this.admitOperation(async () => {
    if (!isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new AuthorityError('INVALID_ARGUMENT');
    const { params, where } = this.compilePredicates(predicates);
    params.push(limit);
    const result = await this.query(`SELECT record_id,revision,schema_version,canonical_data,key_mode,normalized_key,tombstone FROM records r
      WHERE ${where}
      ORDER BY r.created_at,r.record_id LIMIT $${params.length}`, params);
    return result.rows.map(row => ({ ref:this.ref(row.record_id),revision:Number(row.revision),schemaVersion:Number(row.schema_version),
      canonicalData:row.canonical_data,keyMode:row.key_mode,normalizedKey:row.normalized_key,tombstone:row.tombstone }));
    });
  }

  countRecords(predicates: readonly ScalarPredicate[]): Promise<number> {
    return this.admitOperation(async () => {
    const { params, where } = this.compilePredicates(predicates);
    const result = await this.query(`SELECT count(*)::bigint AS total FROM records r WHERE ${where}`,params);
    const count = Number(result.rows[0].total);
    if (!isSafeInteger(count)) throw new RangeError('Count exceeds JavaScript safe integer range');
    return count;
    });
  }

  existsRecord(predicates: readonly ScalarPredicate[]): Promise<boolean> {
    return this.admitOperation(async () => {
    const { params, where } = this.compilePredicates(predicates);
    const result = await this.query(`SELECT EXISTS(SELECT 1 FROM records r WHERE ${where}) AS found`,params);
    return result.rows[0].found;
    });
  }

  /** Claim only this collection's due jobs. Attempt number fences late workers after lease expiry. */
  claimOutbox(limit: number, leaseSeconds: number): Promise<OutboxDelivery[]> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'outbox:worker') throw new AuthorityError('FORBIDDEN');
    if (!isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE || !isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`UPDATE projection_outbox o SET delivery_state='delivering',attempts=o.attempts+1,
      available_at=clock_timestamp()+($3::integer * interval '1 second')
      FROM (SELECT event_id FROM projection_outbox WHERE space_id=$1 AND collection_id=$2
        AND delivery_state IN ('pending','delivering','degraded') AND available_at<=clock_timestamp()
        ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT $4) due
      WHERE o.event_id=due.event_id RETURNING o.event_id,o.record_id,o.revision,o.generation,o.attempts`,
    [...scopeIds(this.#scope),leaseSeconds,limit]);
    return result.rows.map(row => ({ eventId:row.event_id,ref:this.ref(row.record_id),revision:Number(row.revision),
      generation:Number(row.generation),attempt:row.attempts }));
    },true);
  }

  finishOutbox(delivery: OutboxDelivery, success: boolean, error?: string): Promise<boolean> {
    return this.admitOperation(async () => {
    if (this.#scope.capability !== 'outbox:worker') throw new AuthorityError('FORBIDDEN');
    if (!scalarString(delivery.eventId) || typeof success !== 'boolean' || !isSafeInteger(delivery.attempt) || delivery.attempt < 1 ||
      (error !== undefined && (typeof error !== 'string' || error.includes('\0') || error.length > 4096))) throw new AuthorityError('INVALID_ARGUMENT');
    const result = await this.query(`UPDATE projection_outbox SET delivery_state=$5,
      delivered_at=CASE WHEN $5='delivered' THEN clock_timestamp() ELSE NULL END,
      last_error=$6,available_at=CASE WHEN $5='delivered' THEN clock_timestamp()
        ELSE clock_timestamp() + (LEAST(3600, 5 * (1 << LEAST(attempts-1, 10))) * interval '1 second') END
      WHERE space_id=$1 AND collection_id=$2 AND event_id=$3 AND attempts=$4
        AND revision=$7 AND generation=$8 AND delivery_state='delivering'
        AND available_at>clock_timestamp()`,
    [...scopeIds(this.#scope),delivery.eventId,delivery.attempt,success ? 'delivered' : 'degraded',success ? null : (error ?? 'projection failed'),
      delivery.revision,delivery.generation]);
    return result.rowCount === 1;
    },true);
  }
}

export * from './spaces.js';
export * from './cell-policy.js';

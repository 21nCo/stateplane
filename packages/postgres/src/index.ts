import type { CollectionId, RecordRef, Revision, SpaceId } from '@stateplane/contracts';
export interface MutationPrecondition { ref: RecordRef; expectedRevision: Revision; idempotencyKey: string; }
export interface UniqueReservation { ref: RecordRef; key: string; value: string; }
export interface AuthorityRecordWrite { ref: RecordRef; revision: Revision; data: unknown; tombstone: boolean; }
export type RecordMutation = 'create' | 'replace' | 'patch' | 'delete';
// Receipt identity is scoped by actor credential and operation; create has no ref yet.
export interface AuthorityReceiptIdentity { spaceId: SpaceId; credentialId: string; operation: RecordMutation; idempotencyKey: string; }
export interface AuthorityReceiptWrite extends AuthorityReceiptIdentity { ref: RecordRef; requestDigest: string; response: unknown; }
// Reservations retain the original collection even before a create has a record ID.
export type AuthorityReceiptLookup = { state: 'pending'; collectionId: CollectionId } | { state: 'committed'; receipt: AuthorityReceiptWrite };
// All methods run on one transaction-scoped writer. STA-5 supplies the SQL implementation.
// Callers authorize the requested collection before lookup, then authorize a returned
// receipt's original collection for both pending and committed states before
// reporting a reservation, comparing its digest or replaying its response.
// A pending identity denies a second write. A matching committed receipt replays
// before current revision checks; a mismatch aborts. Authorization is rechecked
// at commit, and receipt, record, audit and outbox writes roll back together.
export interface AuthorityTransaction {
  findReceipt(identity: AuthorityReceiptIdentity): Promise<AuthorityReceiptLookup | null>;
  verifyRevision(precondition: MutationPrecondition): Promise<void>;
  reserveUnique(reservation: UniqueReservation): Promise<void>;
  writeRecord(record: AuthorityRecordWrite): Promise<void>;
  writeReceipt(receipt: AuthorityReceiptWrite): Promise<void>;
  appendAudit(ref: RecordRef, revision: Revision): Promise<void>;
  enqueueProjection(ref: RecordRef, revision: Revision): Promise<void>;
}
export interface PostgresAuthority { transaction<T>(fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T>; }

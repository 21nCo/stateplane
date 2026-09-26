import type { RecordRef, Revision } from '@stateplane/contracts';
export interface MutationPrecondition { ref: RecordRef; expectedRevision: Revision; idempotencyKey: string; }
export interface UniqueReservation { ref: RecordRef; key: string; value: string; }
export interface AuthorityRecordWrite { ref: RecordRef; revision: Revision; data: unknown; tombstone: boolean; }
export interface AuthorityReceiptWrite { ref: RecordRef; idempotencyKey: string; requestDigest: string; response: unknown; }
// All methods run on one transaction-scoped writer. STA-5 supplies the SQL implementation.
export interface AuthorityTransaction {
  verifyRevision(precondition: MutationPrecondition): Promise<void>;
  reserveUnique(reservation: UniqueReservation): Promise<void>;
  writeRecord(record: AuthorityRecordWrite): Promise<void>;
  writeReceipt(receipt: AuthorityReceiptWrite): Promise<void>;
  appendAudit(ref: RecordRef, revision: Revision): Promise<void>;
  enqueueProjection(ref: RecordRef, revision: Revision): Promise<void>;
}
export interface PostgresAuthority { transaction<T>(fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T>; }

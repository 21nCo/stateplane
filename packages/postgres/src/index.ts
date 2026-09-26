import type { RecordRef, Revision } from '@stateplane/contracts';
export interface MutationPrecondition { ref: RecordRef; expectedRevision: Revision; idempotencyKey: string; }
export interface AuthorityTransaction { verifyRevision(precondition: MutationPrecondition): Promise<void>; appendAudit(ref: RecordRef, revision: Revision): Promise<void>; enqueueProjection(ref: RecordRef, revision: Revision): Promise<void>; }
export interface PostgresAuthority { transaction<T>(fn: (tx: AuthorityTransaction) => Promise<T>): Promise<T>; }

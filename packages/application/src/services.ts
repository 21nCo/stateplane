import type { VerifiedCredential } from '@stateplane/contracts';

/** Public transports share this application boundary. Implementations must recheck
 * the credential and the selected space at every call, including replay reads. */
export interface StateplaneServices {
  spaces: {
    list(actor: VerifiedCredential, cursor?: string): Promise<unknown>;
    create(actor: VerifiedCredential, cellId?: string, spaceId?: string): Promise<unknown>;
    get(actor: VerifiedCredential, spaceId: string): Promise<unknown>;
    update(actor: VerifiedCredential, spaceId: string, lifecycle: 'active' | 'readOnly' | 'suspended'): Promise<unknown>;
    delete(actor: VerifiedCredential, spaceId: string): Promise<unknown>;
  };
  collections: {
    list(actor: VerifiedCredential, spaceId: string, collectionId?: string, cursor?: string): Promise<unknown>;
    define(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<unknown>;
    revise(actor: VerifiedCredential, spaceId: string, collectionId: string, version: number, serialized: string): Promise<unknown>;
  };
  records: {
    get(actor: VerifiedCredential, spaceId: string, collectionId: string, recordId: string): Promise<unknown>;
    byKey(actor: VerifiedCredential, spaceId: string, collectionId: string, mode: 'generated' | 'external', key: string): Promise<unknown>;
    mutate(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<unknown>;
    query(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<unknown>;
    count(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<unknown>;
  };
  batches: {
    ingest(actor: VerifiedCredential, spaceId: string, collectionId: string, operationKey: string, serialized: string, retryFailed: boolean): Promise<unknown>;
    progress(actor: VerifiedCredential, spaceId: string, collectionId: string, operationKey: string): Promise<unknown>;
    cancel(actor: VerifiedCredential, spaceId: string, collectionId: string, operationKey: string): Promise<unknown>;
  };
  events: {
    list(actor: VerifiedCredential, spaceId: string, collectionId: string, cursor?: string): Promise<unknown>;
    projection(actor: VerifiedCredential, spaceId: string, collectionId: string, recordId: string): Promise<unknown>;
  };
}

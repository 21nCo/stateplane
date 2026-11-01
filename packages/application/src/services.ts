import type { VerifiedCredential } from '@stateplane/contracts';

/** A source's original as a transport needs it to describe the bytes it returns. */
export interface SourceContent {
  source: { sourceId: string; original: { referenceOnly: boolean; sha256: string | null; byteSize: number | null; mimeType: string | null } };
  /** Null for a reference-only source. The stream errors at its end if the bytes differ from the record. */
  body: ReadableStream<Uint8Array> | null;
}

/** Public transports share this application boundary. Implementations must recheck
 * the credential and the selected space at every call, including replay reads.
 * Evidence requests (`request`, `query`, `declared`) are parsed JSON data; the
 * services authorize the collection before they validate them. */
export interface StateplaneServices {
  spaces: {
    list(actor: VerifiedCredential, cursor?: string): Promise<unknown>;
    create(actor: VerifiedCredential, cellId?: string, spaceId?: string): Promise<unknown>;
    get(actor: VerifiedCredential, spaceId: string): Promise<unknown>;
    update(actor: VerifiedCredential, spaceId: string, lifecycle: 'active' | 'readOnly' | 'suspended'): Promise<unknown>;
    delete(actor: VerifiedCredential, spaceId: string): Promise<unknown>;
    audit(actor: VerifiedCredential, spaceId: string, cursor?: string): Promise<unknown>;
    /** Owner only: what a space deletion has erased so far. */
    erasure(actor: VerifiedCredential, spaceId: string): Promise<unknown>;
  };
  sources: {
    get(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string): Promise<unknown>;
    content(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string): Promise<SourceContent>;
    ingestText(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<unknown>;
    ingestReference(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<unknown>;
    createUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<unknown>;
    upload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string,
      body: ReadableStream<Uint8Array>, declared: unknown): Promise<unknown>;
    finalizeUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string, request: unknown): Promise<unknown>;
    revokeUpload(actor: VerifiedCredential, spaceId: string, collectionId: string, grantId: string): Promise<unknown>;
    delete(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string): Promise<unknown>;
    extract(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string): Promise<unknown>;
    correctExtraction(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string, request: unknown): Promise<unknown>;
    /** The latest version when `version` is omitted. */
    extraction(actor: VerifiedCredential, spaceId: string, collectionId: string, sourceId: string, version?: number): Promise<unknown>;
  };
  claims: {
    create(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<unknown>;
    revise(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string, request: unknown): Promise<unknown>;
    review(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string, request: unknown): Promise<unknown>;
    delete(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string, request: unknown): Promise<unknown>;
    /** The latest revision when `revision` is omitted. */
    get(actor: VerifiedCredential, spaceId: string, collectionId: string, claimId: string, revision?: number): Promise<unknown>;
    list(actor: VerifiedCredential, spaceId: string, collectionId: string, query: unknown): Promise<unknown>;
  };
  links: {
    create(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<unknown>;
    get(actor: VerifiedCredential, spaceId: string, collectionId: string, linkId: string): Promise<unknown>;
    delete(actor: VerifiedCredential, spaceId: string, collectionId: string, linkId: string): Promise<unknown>;
    list(actor: VerifiedCredential, spaceId: string, collectionId: string, query: unknown): Promise<unknown>;
  };
  /** Owner-session agent access. An issued secret is returned once and never listed. */
  agents: {
    list(actor: VerifiedCredential, spaceId: string, cursor?: string): Promise<unknown>;
    issue(actor: VerifiedCredential, spaceId: string, serialized: string): Promise<unknown>;
    revoke(actor: VerifiedCredential, spaceId: string, keyId: string): Promise<unknown>;
  };
  collections: {
    list(actor: VerifiedCredential, spaceId: string, collectionId?: string, cursor?: string): Promise<unknown>;
    define(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<unknown>;
    revise(actor: VerifiedCredential, spaceId: string, collectionId: string, version: number, serialized: string): Promise<unknown>;
    /** Advance one bounded batch of a pending filter/sort index. */
    backfill(actor: VerifiedCredential, spaceId: string, collectionId: string, field: string): Promise<unknown>;
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

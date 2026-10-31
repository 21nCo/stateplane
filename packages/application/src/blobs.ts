/** Why a blob write failed. `length`: the body was longer or shorter than
 * declared. `digest`: its SHA-256 differs from the expected one. `content`: a
 * caller-supplied body check refused it. `interrupted`: reading the body
 * failed. These store nothing. `deadline`: the signal aborted before the store
 * confirmed the write. No write starts after the abort, the body errors at its
 * next chunk or its end, and the failure is reported at once without waiting
 * for the store, but a body that had already ended may still be stored later:
 * the caller must treat the key as possibly written. */
export type BlobWriteFailure = 'length' | 'digest' | 'content' | 'interrupted' | 'deadline';
export class BlobWriteError extends Error {
  constructor(readonly reason: BlobWriteFailure, options?: { cause?: unknown }) {
    super(`Blob write refused: ${reason}`, options); this.name = 'BlobWriteError';
  }
}
export interface BlobWrite {
  /** Exact body length. A longer or shorter body stores nothing. */
  bytes: number;
  /** Lowercase hex SHA-256 the body must have. */
  sha256?: string;
  contentType?: string;
  signal?: AbortSignal;
}
/** `sha256` is the store's own checksum of the stored bytes, when it kept one. */
export interface BlobHead { bytes: number; sha256: string | null }
export interface BlobBody extends BlobHead { body: ReadableStream<Uint8Array> }
/**
 * Object storage for original bytes, such as one cell's R2 bucket. A write is
 * atomic: it hashes and counts the body as it streams and stores nothing
 * unless the length, and any expected digest, match. Keys are opaque.
 */
export interface BlobStore {
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: BlobWrite): Promise<{ sha256: string; bytes: number }>;
  head(key: string): Promise<BlobHead | null>;
  get(key: string): Promise<BlobBody | null>;
  /** Removing a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Up to `limit` keys after `startAfter` (all keys when empty), in key order; `done` when no key follows them. */
  list(startAfter: string, limit: number): Promise<{ keys: string[]; done: boolean }>;
}

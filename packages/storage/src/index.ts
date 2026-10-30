import { createHash } from 'node:crypto';
import { BlobWriteError } from '@stateplane/application';
import type { BlobBody, BlobHead, BlobStore, BlobWrite } from '@stateplane/application';

/** The subset of a Workers R2 binding that BlobStore uses. */
export interface R2ObjectLike { size: number; checksums: { sha256?: ArrayBuffer } }
export interface R2BucketLike {
  put(key: string, value: ReadableStream<Uint8Array>, options: { sha256?: string; httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<(R2ObjectLike & { body: ReadableStream<Uint8Array> }) | null>;
  delete(key: string): Promise<void>;
}
/** Give a stream the known length R2 requires; Workers provide FixedLengthStream. */
export type KnownLength = (stream: ReadableStream<Uint8Array>, bytes: number) => ReadableStream<Uint8Array>;
const sha256Pattern = /^[0-9a-f]{64}$/;

function fixedLength(stream: ReadableStream<Uint8Array>, bytes: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return stream;
  const fixed = new Fixed(bytes);
  // A source error aborts the writable side, which errors R2's read of it.
  void stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}
const hex = (value: ArrayBuffer | undefined): string | null => value ? Buffer.from(value).toString('hex') : null;
const head = (object: R2ObjectLike): BlobHead => ({ bytes: object.size, sha256: hex(object.checksums?.sha256) });

/** BlobStore over one cell's R2 binding, such as `ORIGINALS`. */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2BucketLike, private readonly knownLength: KnownLength = fixedLength) {}

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: BlobWrite): Promise<{ sha256: string; bytes: number }> {
    const { bytes, sha256, contentType, signal } = options;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || (sha256 !== undefined && !sha256Pattern.test(sha256)))
      throw new RangeError('Invalid blob write');
    const source = body instanceof Uint8Array ? new Blob([new Uint8Array(body)]).stream() : body;
    const reader = source.getReader();
    const hash = createHash('sha256');
    let seen = 0;
    let digest: string | undefined;
    let failure: BlobWriteError | undefined;
    const fail = (reason: BlobWriteError['reason'], cause?: unknown): never => {
      failure ??= cause instanceof BlobWriteError ? cause : new BlobWriteError(reason, { cause });
      throw failure;
    };
    // Every check runs before the chunk or the end reaches R2, so a refused
    // body errors R2's read and its atomic put stores nothing.
    const checked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) fail('deadline');
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); } catch (error) { return fail('interrupted', error); }
        if (signal?.aborted) fail('deadline');
        if (next.done) {
          if (seen !== bytes) fail('length');
          digest = hash.digest('hex');
          if (sha256 !== undefined && digest !== sha256) fail('digest');
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) fail('interrupted');
        seen += next.value.byteLength;
        if (seen > bytes) fail('length');
        hash.update(next.value);
        controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); }
    });
    const abort = () => { void reader.cancel(new BlobWriteError('deadline')).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const stored = await this.bucket.put(key, this.knownLength(checked, bytes),
        { ...(sha256 === undefined ? {} : { sha256 }), ...(contentType === undefined ? {} : { httpMetadata: { contentType } }) });
      if (failure) throw failure;
      if (!stored || digest === undefined || stored.size !== bytes) throw new Error('Blob store did not confirm the write');
      return { sha256: digest, bytes };
    } catch (error) {
      if (failure) throw failure;
      if (signal?.aborted) throw new BlobWriteError('deadline', { cause: error });
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock?.();
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    const object = await this.bucket.head(key);
    return object ? head(object) : null;
  }

  async get(key: string): Promise<BlobBody | null> {
    const object = await this.bucket.get(key);
    return object ? { ...head(object), body: object.body } : null;
  }

  async delete(key: string): Promise<void> { await this.bucket.delete(key); }
}

/** Stable v1 error codes shared by every public transport. */
export const stableErrorCodes: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT','SCHEMA_INVALID','SCHEMA_UNSUPPORTED','SCHEMA_BREAKING','CURSOR_INVALID',
  'UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','SPACE_UNAVAILABLE',
  'REVISION_CONFLICT','UNIQUE_CONFLICT','KEY_RESERVED','LINK_RESTRICTED',
  'IDEMPOTENCY_MISMATCH','SCHEMA_CONFLICT','BATCH_CONFLICT','BATCH_CANCELLED','RECEIPT_EXPIRED',
  'RECEIPT_PENDING','PROVIDER_UNAVAILABLE','BACKPRESSURE','RATE_LIMITED',
  'COMMIT_OUTCOME_UNKNOWN','STALE_PLACEMENT'
]);
const retryableCodes = new Set(['RECEIPT_PENDING','PROVIDER_UNAVAILABLE','BACKPRESSURE','RATE_LIMITED','STALE_PLACEMENT']);

/** A transport-detected failure. The override fixes retryability for limits
 * that cannot succeed when repeated unchanged, such as an oversized body. */
export class TransportFailure extends Error {
  constructor(readonly code: string, readonly retryableOverride?: boolean) {
    super(code); this.name = 'TransportFailure';
  }
}

function hostWriteTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'HostProviderTimeoutError' ||
    error.message === 'Query read timeout');
}

/** Map a thrown value to a stable code without reading provider messages.
 * A write that may have committed is never reported as a retryable read. */
export function errorCode(error: unknown, read: boolean): string {
  const name = error instanceof Error ? error.name : '';
  const raw = (error as { code?: unknown })?.code;
  if (name === 'CommitOutcomeUnknownError') return 'COMMIT_OUTCOME_UNKNOWN';
  if (typeof raw === 'string' && stableErrorCodes.has(raw)) return raw;
  if (raw === '57014') return read ? 'RATE_LIMITED' : 'COMMIT_OUTCOME_UNKNOWN';
  if (!read && hostWriteTimeout(error)) return 'COMMIT_OUTCOME_UNKNOWN';
  return 'PROVIDER_UNAVAILABLE';
}

/** Repeating a read is safe; an unknown write outcome needs receipt recovery. */
export function errorRetryable(error: unknown, code: string, read: boolean): boolean {
  let canRetry = retryableCodes.has(code);
  if (code === 'COMMIT_OUTCOME_UNKNOWN') canRetry = read;
  if (error instanceof TransportFailure && error.retryableOverride !== undefined)
    canRetry = error.retryableOverride;
  else if (typeof (error as { retryable?: unknown })?.retryable === 'boolean')
    canRetry = (error as { retryable: boolean }).retryable;
  return canRetry;
}

export function classifyError(error: unknown, read: boolean): { code: string; retryable: boolean } {
  const code = errorCode(error, read);
  return { code, retryable: errorRetryable(error, code, read) };
}

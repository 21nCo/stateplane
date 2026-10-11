export interface ApiError { code:string; retryable:boolean; requestId:string|null }

/** Plain-language guidance for stable v1 error codes. The API never returns provider detail. */
const guidance:Record<string,string>={
  UNAUTHENTICATED:'The credential is missing, expired or revoked. Sign in again.',
  FORBIDDEN:'This credential is not permitted to perform this action.',
  NOT_FOUND:'Not found, or this credential cannot see it.',
  SPACE_UNAVAILABLE:'The space or collection lifecycle does not allow this operation now.',
  REVISION_CONFLICT:'The record changed after you loaded it. Nothing was overwritten.',
  UNIQUE_CONFLICT:'Another record or space already holds this unique value or identifier.',
  KEY_RESERVED:'This external key is reserved by an existing or deleted record.',
  IDEMPOTENCY_MISMATCH:'This request key was already used for a different request. Reload the form.',
  SCHEMA_INVALID:'The data does not satisfy the collection schema.',
  SCHEMA_UNSUPPORTED:'The definition uses a keyword Stateplane does not support.',
  SCHEMA_BREAKING:'The revision changes an existing field, constraint or index incompatibly.',
  SCHEMA_CONFLICT:'A field is undeclared, not filterable or sortable, or its index is still pending.',
  INVALID_ARGUMENT:'The request is malformed. Check the highlighted values.',
  CURSOR_INVALID:'The page position expired or no longer applies. Start again from the first page.',
  COMMIT_OUTCOME_UNKNOWN:'The write may or may not have committed. Retry the identical request to recover its result.',
  PROVIDER_UNAVAILABLE:'The service is temporarily unavailable. Try again shortly.',
  RATE_LIMITED:'The request exceeded a time or size limit.',
  BACKPRESSURE:'The collection is busy. Try again shortly.',
  STALE_PLACEMENT:'The space placement or key state changed. Reload and try again.',
  BATCH_CONFLICT:'This operation key was already used with different items.',
  BATCH_CANCELLED:'This ingestion was cancelled.',
  RECEIPT_EXPIRED:'The retry window for this request has passed. Read the record before writing again.',
  RECEIPT_PENDING:'The original request is still being processed. Try again shortly.'
};
export const describe=(code:string)=>guidance[code] ?? 'The request failed.';

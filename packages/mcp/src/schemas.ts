import type { McpFnJsonSchema, McpFnObjectSchema } from '@mcpfn/core';

/* Input schemas follow contracts/openapi.yaml. They are published guidance:
 * the shared services remain the only validator, so a request that a client
 * sends despite a schema violation receives the same stable code as HTTP. */

const scalarPattern = '^(?:[^\\u0000\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';

/* JSON Schema maxLength counts code points. A unit or byte limit that it
 * cannot express is published as an x- extension that clients must enforce,
 * as in contracts/openapi.yaml; maxLength remains a sound upper bound. */
export const selector = (description: string): McpFnJsonSchema => ({
  type: 'string', minLength: 1, maxLength: 512, 'x-utf16MaxLength': 512, pattern: '^[^\\u0000]+$',
  description: `${description} At most 512 UTF-16 code units (x-utf16MaxLength; clients must enforce it); no NUL.`
});
const spaceId = selector('Space ID, for example sp_123e4567-e89b-42d3-a456-426614174000.');
const collectionId = selector('Collection ID (the definition slug).');
const recordId = { type: 'string', minLength: 1, description: 'Canonical record ID from a receipt or read.' };
const cursor = (description: string): McpFnJsonSchema => ({ type: 'string', minLength: 1,
  description: `${description} Omit it for the first page; never send an empty or null cursor.` });
const positive = (description: string): McpFnJsonSchema => ({ type: 'integer', minimum: 1, maximum: 9007199254740991, description });

export const idempotencyKey: McpFnJsonSchema = {
  type: 'string', minLength: 1, maxLength: 256, 'x-utf8MaxBytes': 256, pattern: scalarPattern,
  description: 'Nonempty Unicode-scalar key of at most 256 UTF-8 bytes (x-utf8MaxBytes; clients must enforce it). Reuse it only with an identical request to recover a lost response.'
};
/* The external-key byte budget applies after NFC and the fixed trim, so a raw
 * x-utf8MaxBytes would reject padded or decomposed keys the authority admits.
 * It is published under its own extension name instead. */
export const externalKey: McpFnJsonSchema = {
  type: 'string', minLength: 1, 'x-nfcTrimmedUtf8MaxBytes': 256,
  pattern: '^(?![\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*$)[^\\u0000\\ud800-\\udfff]+$',
  description: 'Optional create-only key. Normalized to NFC, then trimmed of U+0009–000D, U+0020, U+0085, U+00A0, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F and U+3000; the result must be nonempty and at most 256 UTF-8 bytes (x-nfcTrimmedUtf8MaxBytes; clients must enforce it on the normalized, trimmed key, not on the raw value).'
};
const expectedRevision = positive('Current record revision. A stale value fails REVISION_CONFLICT.');
const expectedSchemaVersion = positive('Optional exact collection schema version precondition.');

const field = { type: 'string', minLength: 1, pattern: scalarPattern };
const shortString = { type: 'string', maxLength: 512, 'x-utf8MaxBytes': 512,
  pattern: '^(?:[^\\u0000\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
  description: 'At most 512 UTF-8 bytes (x-utf8MaxBytes; clients must enforce it).' };
const instant = { type: 'string', maxLength: 512, 'x-utf8MaxBytes': 512,
  description: 'UTC instant such as 2026-01-31T12:00:00.5Z with a valid Gregorian date; at most 512 UTF-8 bytes (x-utf8MaxBytes). Leap seconds are limited to the listed UTC dates.',
  anyOf: [
    { pattern: '^(?:(?!0000)[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:(?!0000)(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00))-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$' },
    { pattern: '^(?:1972-(?:06-30|12-31)|1973-12-31|1974-12-31|1975-12-31|1976-12-31|1977-12-31|1978-12-31|1979-12-31|1981-06-30|1982-06-30|1983-06-30|1985-06-30|1987-12-31|1989-12-31|1990-12-31|1992-06-30|1993-06-30|1994-06-30|1995-12-31|1997-06-30|1998-12-31|2005-12-31|2008-12-31|2012-06-30|2015-06-30|2016-12-31)T23:59:60(?:\\.[0-9]+)?Z$' }
  ] };
const finite = { type: 'number', description: 'A finite JSON number.' };
const comparison = { enum: ['eq', 'lt', 'lte', 'gt', 'gte'] };
const typed = (kind: string, value: McpFnJsonSchema): McpFnJsonSchema[] => [
  { type: 'object', required: ['field', 'kind', 'operator', 'value'], additionalProperties: false,
    properties: { field, kind: { const: kind }, operator: comparison, value } },
  { type: 'object', required: ['field', 'kind', 'operator', 'value'], additionalProperties: false,
    properties: { field, kind: { const: kind }, operator: { const: 'in' },
      value: { type: 'array', minItems: 1, maxItems: 16, items: value } } }
];
export const predicate: McpFnJsonSchema = {
  oneOf: [
    { type: 'object', required: ['field', 'kind', 'operator'], additionalProperties: false,
      properties: { field, kind: { const: 'null' }, operator: { const: 'isNull' } } },
    ...typed('string', shortString), ...typed('number', finite), ...typed('boolean', { type: 'boolean' }),
    ...typed('date-time', instant)
  ],
  description: 'Typed predicate on a declared filterable top-level field. Predicates combine with AND; isNull matches explicit null only.'
};
const predicates = { type: 'array', maxItems: 16, items: predicate, description: 'Up to 16 typed predicates; [] matches every live record.' };

/* contracts/openapi.yaml SchemaNode and SchemaRoot. A node recurses through
 * the tool's own $defs, so every node is closed to the 15 supported keywords,
 * an object node declares additionalProperties false and an array node
 * declares items. The authority alone checks the remaining node-kind
 * restrictions (for example $schema only at the root), nullable unions,
 * depth, field count, bounds and enum members. */
// A fresh object per use: McpFn rewrites each $ref in place, once per object.
const nodeRef = () => ({ $ref: '#/$defs/schemaNode' });
const size = { type: 'integer', minimum: 0 };
export const schemaNode: McpFnJsonSchema = {
  type: 'object', required: ['type'], additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    type: { oneOf: [{ enum: ['string', 'integer', 'number', 'boolean', 'object', 'array'] },
      { type: 'array', minItems: 2, maxItems: 2, items: { enum: ['string', 'integer', 'number', 'boolean', 'null'] } }] },
    properties: { type: 'object', additionalProperties: nodeRef() },
    required: { type: 'array', items: { type: 'string' } },
    additionalProperties: { const: false },
    items: nodeRef(),
    minItems: size, maxItems: size, minLength: size, maxLength: size,
    minimum: { type: 'number' }, maximum: { type: 'number' },
    enum: { type: 'array', minItems: 1 },
    format: { const: 'date-time' },
    description: { type: 'string' }
  },
  allOf: [{ if: { properties: { type: { const: 'object' } } }, then: { required: ['additionalProperties'] } },
    { if: { properties: { type: { const: 'array' } } }, then: { required: ['items'] } }],
  description: 'Closed schema node: only these 15 keywords. An object node requires additionalProperties false and an array node requires items. type is one name or a two-member scalar type plus "null". The service also checks keyword placement by type, $schema only at the root, depth, field count, bounds and enum members.'
};
const schemaRoot: McpFnJsonSchema = {
  allOf: [nodeRef(), { type: 'object', required: ['$schema', 'type', 'additionalProperties'],
    properties: { $schema: { const: 'https://json-schema.org/draft/2020-12/schema' }, type: { const: 'object' },
      additionalProperties: { const: false } } }],
  description: 'Closed JSON Schema Draft 2020-12 root: a schema node with $schema "https://json-schema.org/draft/2020-12/schema", type "object" and additionalProperties false.'
};

const definition: McpFnJsonSchema = {
  type: 'object', required: ['slug', 'version', 'schema', 'unique', 'filterable', 'sortable'], additionalProperties: false,
  description: 'Collection definition. slug must equal collectionId.',
  properties: {
    slug: { type: 'string', minLength: 1 },
    version: positive('1 for collections_define; the next version for collections_revise.'),
    schema: schemaRoot,
    unique: { type: 'array', items: { type: 'object', required: ['name', 'paths'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1 }, paths: { type: 'array', minItems: 1, items: { type: 'string' } } } } },
    filterable: { type: 'array', items: { type: 'string' } },
    sortable: { type: 'array', items: { type: 'string' } },
    lifecycle: { type: 'object', required: ['field', 'initial', 'transitions'], additionalProperties: false,
      properties: { field: { type: 'string' }, initial: { type: 'array', items: { type: 'string' } },
        transitions: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } }
  }
};

/* Both definition tools resolve nodeRef() against their own $defs. */
const withSchemaNode = (schema: McpFnObjectSchema): McpFnObjectSchema => ({ ...schema, $defs: { schemaNode } });
const object = (properties: Record<string, McpFnJsonSchema>, required: string[]): McpFnObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const scoped = (properties: Record<string, McpFnJsonSchema> = {}, required: string[] = []): McpFnObjectSchema =>
  object({ spaceId, collectionId, ...properties }, ['spaceId', 'collectionId', ...required]);
const operationKey: McpFnJsonSchema = { type: 'string', minLength: 1, maxLength: 256, 'x-utf8MaxBytes': 256, pattern: scalarPattern,
  description: 'Immutable batch operation key: a nonempty Unicode-scalar string of at most 256 UTF-8 bytes (x-utf8MaxBytes; clients must enforce it).' };

/* Evidence requests (STA-37) follow the OpenAPI request bodies of the same
 * operations; test/mcp.test.js compares them. Their bounds are the services':
 * the descriptions name byte limits that JSON Schema cannot express. */
const evidenceKey: McpFnJsonSchema = { type: 'string', minLength: 1, pattern: scalarPattern,
  description: 'Idempotency key: a nonempty Unicode-scalar string of at most 512 UTF-8 bytes. Repeat the identical request with the same key and credential to replay a committed write; a changed request fails IDEMPOTENCY_MISMATCH.' };
const reference = (description: string): McpFnJsonSchema => ({ type: 'string', minLength: 1,
  description: `${description} At most 256 UTF-8 bytes.` });
const utcTime = (description: string): McpFnJsonSchema => ({ type: 'string', minLength: 1,
  description: `${description} A UTC instant such as 2026-01-31T12:00:00.5Z.` });
const mimeType = (description: string): McpFnJsonSchema => ({ type: 'string', minLength: 1,
  description: `${description} A media type; parameters are dropped and the type/subtype essence is compared lowercase.` });
const sha256: McpFnJsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Lowercase hex SHA-256 the bytes must have.' };
const locator: McpFnJsonSchema = { type: 'string', minLength: 1,
  description: 'Where the evidence came from, such as a URL; at most 4,096 UTF-8 bytes. It is stored, never fetched, and never proof of the bytes.' };
const offset: McpFnJsonSchema = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
const segment: McpFnJsonSchema = { type: 'object', required: ['start', 'end', 'sourceStart', 'sourceEnd'], additionalProperties: false,
  properties: { start: offset, end: offset, sourceStart: offset, sourceEnd: offset },
  description: 'start and end: a nonempty half-open range of the content in Unicode code points; sourceStart and sourceEnd: a half-open byte range of the original.' };
const citation: McpFnJsonSchema = { type: 'object', required: ['collectionId', 'sourceId'], additionalProperties: false,
  properties: { collectionId: reference('Collection of the cited source.'), sourceId: reference('Cited source ID.'),
    extractionVersion: positive('Optional cited extraction version.'), start: offset, end: offset },
  description: 'A cited live source, optionally one extraction version and a nonempty half-open code-point range of its content (start and end). Citing needs sources:read on the cited collection and grants no access.' };
const claimContent = {
  statement: { type: 'string', minLength: 1, description: 'The asserted statement: 1 to 1,048,576 UTF-8 bytes.' },
  attributedTo: { type: 'string', minLength: 1, description: 'Who asserts the statement, such as a person, publication or agent: at most 1,024 UTF-8 bytes. Separate from the principal that records it.' },
  observedAt: utcTime('When the asserted fact was observed; not in the future, at most millisecond precision.'),
  validFrom: utcTime('Start of the time the statement holds; at most millisecond precision.'),
  validUntil: utcTime('End of the time the statement holds, after validFrom; at most millisecond precision.'),
  evidence: { type: 'array', maxItems: 32, items: citation, description: 'Up to 32 cited sources.' }
} satisfies Record<string, McpFnJsonSchema>;
const baseRevision = positive('The claim\'s latest revision. A later one fails REVISION_CONFLICT.');
const endpoint: McpFnJsonSchema = { type: 'object', required: ['kind', 'collectionId', 'id'], additionalProperties: false,
  properties: { kind: { enum: ['record', 'source', 'claim'] }, collectionId: reference('Endpoint collection.'), id: reference('Record, source or claim ID.') },
  description: 'A link endpoint in this space. The caller needs the read and write capability of its kind on its collection.' };
const pageLimit = (maximum: number): McpFnJsonSchema => ({ type: 'integer', minimum: 1, maximum, description: `Page size, at most ${maximum}.` });
const after = reference('The previous page\'s next value; omit it for the first page.');
const sourceId = selector('Source ID.');
const claimId = selector('Claim ID.');
const grantId = selector('Upload grant ID.');
const linkId = selector('Link ID.');

export const evidenceInputs = {
  spaces_erasure: object({ spaceId }, ['spaceId']),
  sources_get: scoped({ sourceId }, ['sourceId']),
  sources_content: scoped({ sourceId }, ['sourceId']),
  sources_ingest_text: scoped({ idempotencyKey: evidenceKey,
    text: { type: 'string', minLength: 1, description: 'Well-formed Unicode text of 1 to 1,048,576 UTF-8 bytes, stored verbatim as the original.' },
    mimeType: mimeType('A text/* type; text/plain when omitted.'), locator,
    capturedAt: utcTime('When the text was captured; not in the future. The observation time when omitted.') }, ['idempotencyKey', 'text']),
  sources_ingest_reference: scoped({ idempotencyKey: evidenceKey, locator, mimeType: mimeType('Optional type of the referenced evidence.'),
    capturedAt: utcTime('When the reference was captured; not in the future.') }, ['idempotencyKey', 'locator']),
  sources_delete: scoped({ sourceId }, ['sourceId']),
  sources_extract: scoped({ sourceId }, ['sourceId']),
  sources_extraction: scoped({ sourceId, version: positive('Extraction version; the latest when omitted.') }, ['sourceId']),
  sources_correct_extraction: scoped({ sourceId, baseVersion: positive('The latest extraction version, which the correction follows.'),
    content: { type: 'string', description: 'Corrected text: well-formed Unicode without NUL, at most 1,048,576 UTF-8 bytes.' },
    sourceOffsets: { type: 'array', maxItems: 4096, items: segment, description: 'Up to 4,096 segments in content order.' } },
  ['sourceId', 'baseVersion', 'content', 'sourceOffsets']),
  uploads_create: scoped({ mimeType: mimeType('The one type the upload may have.'),
    maxBytes: { type: 'integer', minimum: 1, maximum: 26214400, description: 'Largest accepted upload, at most 25 MiB.' },
    sha256, expiresInSeconds: { type: 'integer', minimum: 1, maximum: 900, description: 'Grant lifetime; 300 seconds when omitted.' } },
  ['mimeType', 'maxBytes']),
  uploads_send: scoped({ grantId, mimeType: mimeType('Must equal the grant\'s type.'),
    contentBase64: { type: 'string', maxLength: 2796204, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
      description: 'The bytes in canonical padded base64, at most 2 MiB decoded over MCP; use HTTP or the CLI for larger uploads.' },
    sha256 }, ['grantId', 'mimeType', 'contentBase64']),
  uploads_finalize: scoped({ grantId, attemptId: reference('The verified attempt from uploads_send.'), locator,
    capturedAt: utcTime('When the bytes were captured; not in the future.') }, ['grantId', 'attemptId']),
  uploads_revoke: scoped({ grantId }, ['grantId']),
  claims_create: scoped({ idempotencyKey: evidenceKey, ...claimContent }, ['idempotencyKey', 'statement', 'attributedTo']),
  claims_revise: scoped({ claimId, baseRevision, ...claimContent }, ['claimId', 'baseRevision', 'statement', 'attributedTo']),
  claims_review: scoped({ claimId, baseRevision, status: { enum: ['accepted', 'rejected'], description: 'The review decision. Needs claims:review.' } },
    ['claimId', 'baseRevision', 'status']),
  claims_delete: scoped({ claimId, baseRevision }, ['claimId', 'baseRevision']),
  claims_get: scoped({ claimId, revision: positive('Claim revision; the latest when omitted.') }, ['claimId']),
  claims_list: scoped({ citing: { type: 'object', required: ['collectionId', 'sourceId'], additionalProperties: false,
    properties: { collectionId: reference('Collection of the cited source.'), sourceId: reference('Cited source ID.') },
    description: 'Keep claims whose current revision cites this source.' },
  status: { enum: ['unreviewed', 'accepted', 'rejected'], description: 'Keep one review status.' }, after, limit: pageLimit(25) }),
  links_create: scoped({ idempotencyKey: evidenceKey,
    type: { type: 'string', minLength: 1, description: 'Link type: 1 to 256 UTF-8 bytes.' },
    policy: { enum: ['restrict', 'detach'], description: 'restrict refuses deleting either endpoint while the link is live; detach tombstones the link with the endpoint.' },
    from: endpoint, to: endpoint }, ['idempotencyKey', 'type', 'policy', 'from', 'to']),
  links_get: scoped({ linkId }, ['linkId']),
  links_list: scoped({ endpoint: { type: 'object', required: ['kind', 'id'], additionalProperties: false,
    properties: { kind: { enum: ['record', 'source', 'claim'] }, id: reference('Record, source or claim ID in this collection.') },
    description: 'The endpoint in this collection whose live links to list.' }, after, limit: pageLimit(50) }, ['endpoint']),
  links_delete: scoped({ linkId }, ['linkId'])
} satisfies Record<string, McpFnObjectSchema>;

/* Search and bundle requests (STA-49) follow the OpenAPI SearchRequest and
 * BundleRequest; their byte bounds are the services' and only described. */
const retrievalText = (description: string): McpFnJsonSchema => ({ type: 'string', minLength: 1, maxLength: 1000,
  description: `${description} Nonblank, at most 1,000 code points and 4,000 UTF-8 bytes.` });
const retrievalFilters = {
  collections: { type: 'array', minItems: 1, maxItems: 32, items: reference('Collection ID.'),
    description: 'Search only these collections, each readable for a requested kind (NOT_FOUND otherwise). Every readable one, up to 32, when omitted.' },
  kinds: { type: 'array', minItems: 1, maxItems: 3, items: { enum: ['record', 'source', 'claim'] },
    description: 'Kinds to search; all three when omitted. A kind is searched only where the credential may read it.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Hits to return, at most 50; 10 when omitted.' }
} satisfies Record<string, McpFnJsonSchema>;
const budgetLimit = (unit: string): McpFnJsonSchema => ({ type: 'integer', minimum: 1024, maximum: 262144,
  description: `Most ${unit} the context may take, 1,024 to 262,144.` });

export const retrievalInputs = {
  retrieval_search: object({ spaceId, query: retrievalText('The search text.'), ...retrievalFilters }, ['spaceId', 'query']),
  retrieval_bundle: object({ spaceId, task: retrievalText('The task the excerpts are for; searched when there is no query.'),
    query: retrievalText('The search text.'), budget: { type: 'object', additionalProperties: false, minProperties: 1,
      properties: { bytes: budgetLimit('UTF-8 bytes'), tokens: budgetLimit('tokens (enforced as bytes, an upper bound for byte-level tokenizers)') },
      description: 'At least one limit.' }, ...retrievalFilters }, ['spaceId', 'budget']),
  retrieval_status: scoped()
} satisfies Record<string, McpFnObjectSchema>;

export const inputs = {
  ...evidenceInputs,
  ...retrievalInputs,
  spaces_list: object({ cursor: cursor('Opaque cursor from a previous spaces_list page.') }, []),
  spaces_get: object({ spaceId }, ['spaceId']),
  collections_list: object({ spaceId, cursor: cursor('Opaque cursor from a previous collections_list page.') }, ['spaceId']),
  collections_get: scoped(),
  collections_define: withSchemaNode(scoped({ definition }, ['definition'])),
  collections_revise: withSchemaNode(scoped({ expectedVersion: positive('Current collection version.'), definition },
    ['expectedVersion', 'definition'])),
  records_get: scoped({ id: selector('Canonical record ID.') }, ['id']),
  records_get_by_key: scoped({ mode: { enum: ['generated', 'external'], description: 'generated looks up a record ID; external normalizes the key as on create.' },
    key: selector('Key to resolve in the selected mode.') }, ['mode', 'key']),
  records_query: scoped({ predicates, limit: { type: 'integer', minimum: 1, maximum: 100 },
    sort: { type: 'object', required: ['field', 'direction'], additionalProperties: false,
      properties: { field: { type: 'string' }, direction: { enum: ['asc', 'desc'] } },
      description: 'Optional declared sortable field. Default order is creation time, then ID.' },
    cursor: cursor('Opaque nextCursor from the same query.') }, ['predicates', 'limit']),
  records_count: scoped({ predicates }, ['predicates']),
  records_create: scoped({ idempotencyKey, externalKey, data: { type: 'object', description: 'Record data valid for the current schema.' },
    expectedSchemaVersion }, ['idempotencyKey', 'data']),
  records_replace: scoped({ idempotencyKey, id: recordId, expectedRevision,
    data: { type: 'object', description: 'Complete replacement data; omitted optional fields are removed.' }, expectedSchemaVersion },
  ['idempotencyKey', 'id', 'expectedRevision', 'data']),
  records_patch: scoped({ idempotencyKey, id: recordId, expectedRevision,
    set: { type: 'object', description: 'Top-level fields to write, including explicit null.' },
    unset: { type: 'array', items: { type: 'string' }, description: 'Distinct declared optional top-level fields to remove.' },
    expectedSchemaVersion }, ['idempotencyKey', 'id', 'expectedRevision', 'set', 'unset']),
  records_delete: scoped({ idempotencyKey, id: recordId, expectedRevision, expectedSchemaVersion },
    ['idempotencyKey', 'id', 'expectedRevision']),
  batches_ingest: scoped({ operationKey,
    items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' },
      description: 'One to 20 serialized record requests without idempotencyKey, each at most 1 MiB and 2 MiB combined. Keep the exact strings for recovery.' },
    retryFailed: { type: 'boolean', description: 'Retry items that previously failed.' } }, ['operationKey', 'items']),
  batches_status: scoped({ operationKey }, ['operationKey']),
  batches_cancel: scoped({ operationKey }, ['operationKey']),
  events_list: scoped({ cursor: cursor('Opaque nextCursor from a previous events_list page.') }),
  projection_status: scoped({ id: selector('Canonical record ID.') }, ['id'])
} satisfies Record<string, McpFnObjectSchema>;

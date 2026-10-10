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

const definition: McpFnJsonSchema = {
  type: 'object', required: ['slug', 'version', 'schema', 'unique', 'filterable', 'sortable'], additionalProperties: false,
  description: 'Collection definition. slug must equal collectionId.',
  properties: {
    slug: { type: 'string', minLength: 1 },
    version: positive('1 for collections_define; the next version for collections_revise.'),
    schema: { type: 'object', required: ['$schema', 'type', 'additionalProperties'],
      properties: { $schema: { const: 'https://json-schema.org/draft/2020-12/schema' }, type: { const: 'object' },
        properties: { type: 'object' }, additionalProperties: { const: false } },
      description: 'Closed JSON Schema Draft 2020-12 root: $schema "https://json-schema.org/draft/2020-12/schema", type "object", properties and additionalProperties false at every object node. Only type, properties, required, additionalProperties, items, minItems, maxItems, minLength, maxLength, minimum, maximum, enum, format "date-time" and description are supported.' },
    unique: { type: 'array', items: { type: 'object', required: ['name', 'paths'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1 }, paths: { type: 'array', minItems: 1, items: { type: 'string' } } } } },
    filterable: { type: 'array', items: { type: 'string' } },
    sortable: { type: 'array', items: { type: 'string' } },
    lifecycle: { type: 'object', required: ['field', 'initial', 'transitions'], additionalProperties: false,
      properties: { field: { type: 'string' }, initial: { type: 'array', items: { type: 'string' } },
        transitions: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } }
  }
};

const object = (properties: Record<string, McpFnJsonSchema>, required: string[]): McpFnObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const scoped = (properties: Record<string, McpFnJsonSchema> = {}, required: string[] = []): McpFnObjectSchema =>
  object({ spaceId, collectionId, ...properties }, ['spaceId', 'collectionId', ...required]);
const operationKey: McpFnJsonSchema = { type: 'string', minLength: 1, maxLength: 256, 'x-utf8MaxBytes': 256, pattern: scalarPattern,
  description: 'Immutable batch operation key: a nonempty Unicode-scalar string of at most 256 UTF-8 bytes (x-utf8MaxBytes; clients must enforce it).' };

export const inputs = {
  spaces_list: object({ cursor: cursor('Opaque cursor from a previous spaces_list page.') }, []),
  spaces_get: object({ spaceId }, ['spaceId']),
  collections_list: object({ spaceId, cursor: cursor('Opaque cursor from a previous collections_list page.') }, ['spaceId']),
  collections_get: scoped(),
  collections_define: scoped({ definition }, ['definition']),
  collections_revise: scoped({ expectedVersion: positive('Current collection version.'), definition }, ['expectedVersion', 'definition']),
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

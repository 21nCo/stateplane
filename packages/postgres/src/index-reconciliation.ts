import { inTransaction } from './faults.js';
import type { PoolLike } from './faults.js';
import type { IndexValue } from './index.js';
import { derivedIndexValue, validateParsedValue } from './schema.js';
import type { CollectionDefinition, Json, SchemaNode } from './schema.js';

/**
 * Bounds of one reconciliation call (docs/analysis-measurements.md#reconciliation):
 * pages of at most 1,000 records and 1 MiB of canonical data (at least one
 * record), as snapshot job pages, each one read-only snapshot; 10,000 records
 * per call unless `maxRecords` says otherwise (at most 1,000,000); at most 100
 * drift samples reported, every drifted row counted.
 */
export const reconciliationBounds = Object.freeze({ pageRecords: 1_000, pageBytes: 1_048_576, defaultRecords: 10_000,
  maxRecords: 1_000_000, samples: 100 });

/**
 * One typed index row that differs from what the record's canonical data
 * derives: `missing` (a live record has no row for a ready field),
 * `unexpected` (a deleted record still has one), `kind` or `value` (the row
 * holds another kind or value), or `underivable` (the record writers would not
 * accept the record under the current definition, or its value past the
 * index's byte limit, so it derives no row). A rejected record is underivable
 * for the ready fields that explain the rejection (a value outside its field's
 * schema, a required field missing, a null on a non-nullable field), and for
 * every ready field when the rejection is the whole record's: an undeclared
 * property, a field outside the ready ones invalid or required and missing, a
 * whole-record constraint such as a root `enum`, or canonical data that is not
 * a JSON object. A record the writers accept is never underivable for a schema
 * reason. Kinds only, never values.
 */
export interface IndexDrift {
  recordId: string; field: string; reason: 'missing' | 'unexpected' | 'kind' | 'value' | 'underivable';
  expectedKind: string | null; actualKind: string | null;
}
export interface IndexReconciliation {
  spaceId: string; collectionId: string;
  /**
   * The ready declared fields checked on every page, in name order; a field still backfilling is not checked, and one that
   * turned ready during the call is not listed.
   */
  fields: string[];
  /** Records checked (live and deleted), after `after`, in record ID order. */
  checked: number; after: string | null;
  /** The last record checked when a record follows it, to pass as `after`; null once the collection was read to its end. */
  next: string | null;
  driftCount: number; drift: IndexDrift[];
}

/**
 * Compare a collection's typed index projection (`record_index_values`, which
 * record writers and backfill maintain and every exact filter, sort and
 * aggregation over a declared field reads) with what each record's canonical data
 * derives under the collection's current definition, as the writers and
 * backfill derive it. Each page reads the records, their index rows, the
 * definition and the declarations in one REPEATABLE READ, READ ONLY
 * snapshot, so a write committing meanwhile is never reported as drift. An
 * operator check: it reads every record of the collection and authorizes
 * nothing; it never repairs.
 */
export async function reconcileIndexes(pool: PoolLike, spaceId: string, collectionId: string,
  options: { after?: string | null; maxRecords?: number } = {}): Promise<IndexReconciliation> {
  const maxRecords = options.maxRecords ?? reconciliationBounds.defaultRecords;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > reconciliationBounds.maxRecords)
    throw new RangeError(`maxRecords must be an integer from 1 to ${reconciliationBounds.maxRecords}`);
  if (typeof spaceId !== 'string' || typeof collectionId !== 'string' || (options.after != null && typeof options.after !== 'string'))
    throw new TypeError('Invalid reconciliation scope');
  const result: IndexReconciliation = { spaceId, collectionId, fields: [], checked: 0, after: options.after ?? null, next: null,
    driftCount: 0, drift: [] };
  let cursor = options.after ?? null;
  for (;;) {
    const limit = Math.min(reconciliationBounds.pageRecords, maxRecords - result.checked);
    const page = await inTransaction(pool, async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const version = (await db.query(`SELECT v.canonical_definition FROM collections c JOIN collection_versions v
        ON v.space_id=c.space_id AND v.collection_id=c.collection_id AND v.version=c.schema_version
        WHERE c.space_id=$1 AND c.collection_id=$2`, [spaceId, collectionId])).rows[0];
      if (!version) throw new RangeError('No such collection');
      const definition = JSON.parse(version.canonical_definition) as CollectionDefinition;
      const fields: string[] = (await db.query(`SELECT field_name FROM collection_index_declarations
        WHERE space_id=$1 AND collection_id=$2 AND ready ORDER BY field_name COLLATE "C"`, [spaceId, collectionId])).rows
        .map(row => row.field_name);
      // At most `limit` records and pageBytes of canonical data, the first record always (octet_length reads the stored size
      // only). One record past `limit` is read and not taken: it shows, in this snapshot, whether any record follows the page.
      const records = (await db.query(`SELECT record_id,tombstone,canonical_data,fetched FROM (
          SELECT record_id,tombstone,canonical_data,sum(octet_length(COALESCE(canonical_data,''))) OVER (ORDER BY record_id) AS running,
            row_number() OVER (ORDER BY record_id) AS position,count(*) OVER () AS fetched FROM (
            SELECT record_id,tombstone,canonical_data FROM records
            WHERE space_id=$1 AND collection_id=$2 AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4::int+1) x
        ) y WHERE position<=$4::int AND (running<=$5 OR position=1) ORDER BY record_id`,
      [spaceId, collectionId, cursor, limit, reconciliationBounds.pageBytes])).rows;
      const { drift, expected, owners } = expectedRows(records, fields, definition);
      const valueOf = (value: IndexValue, kind: string) => value.kind === kind && 'value' in value ? value.value : null;
      // Expected rows of the live records against every row the page's records hold for a ready field, both read in this
      // snapshot; values compare in the database's own types (numeric, text COLLATE "C", boolean), as the writers store them.
      const differing = fields.length && records.length ? (await db.query(`WITH expected AS (
          SELECT * FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::numeric[],$8::boolean[],$9::text[])
            AS e(record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
        ), actual AS (
          SELECT v.record_id,v.field_name,v.value_kind,v.string_value,v.number_value,v.boolean_value,v.time_value
          FROM record_index_values v WHERE v.space_id=$1 AND v.collection_id=$2 AND v.record_id=ANY($10::text[])
            AND v.field_name=ANY($11::text[])
        )
        SELECT COALESCE(e.record_id,a.record_id) AS record_id,COALESCE(e.field_name,a.field_name) AS field_name,
          e.value_kind AS expected_kind,a.value_kind AS actual_kind
        FROM expected e FULL JOIN actual a ON a.record_id=e.record_id AND a.field_name=e.field_name
        WHERE e.record_id IS NULL OR a.record_id IS NULL OR e.value_kind<>a.value_kind
          OR e.string_value IS DISTINCT FROM a.string_value COLLATE "C" OR e.number_value IS DISTINCT FROM a.number_value
          OR e.boolean_value IS DISTINCT FROM a.boolean_value OR e.time_value IS DISTINCT FROM a.time_value COLLATE "C"
        ORDER BY 1,2`,
      [spaceId, collectionId, owners, expected.map(value => value.field), expected.map(value => value.kind), expected.map(value => valueOf(value, 'string')),
        expected.map(value => valueOf(value, 'number')), expected.map(value => valueOf(value, 'boolean')),
        expected.map(value => valueOf(value, 'date-time')), records.map(record => record.record_id), fields])).rows : [];
      const underivable = new Set(drift.map(item => `${item.recordId}\u0000${item.field}`));
      for (const row of differing) {
        // A row the data no longer derives is reported once, as underivable.
        if (underivable.has(`${row.record_id}\u0000${row.field_name}`)) continue;
        drift.push({ recordId: row.record_id, field: row.field_name, reason: driftReason(row.expected_kind, row.actual_kind),
          expectedKind: row.expected_kind, actualKind: row.actual_kind });
      }
      // More follows exactly when a record read past the page (by its record or byte bound) exists.
      const more = records.length > 0 && Number(records[0].fetched) > records.length;
      return { fields, records: records.length, more, last: records.length ? records[records.length - 1].record_id as string : null, drift };
    });
    // A declaration that turned ready during the call was not checked on its earlier pages: list only fields every page checked.
    result.fields = result.checked ? result.fields.filter(field => page.fields.includes(field)) : page.fields;
    result.checked += page.records;
    result.driftCount += page.drift.length;
    for (const item of page.drift) if (result.drift.length < reconciliationBounds.samples) result.drift.push(item);
    if (!page.more) { result.next = null; return result; }
    cursor = page.last;
    if (result.checked >= maxRecords) { result.next = cursor; return result; }
  }
}

/**
 * The typed index rows the page's live records derive for the ready fields, with the record owning each, and an
 * `underivable` drift for each ready field a record derives no row for. Damaged stored data derives nothing: it is drift of
 * its ready fields, never a failure of the whole call.
 */
function expectedRows(records: { record_id: string; tombstone: boolean; canonical_data: string | null }[], fields: string[],
  definition: CollectionDefinition): { drift: IndexDrift[]; expected: IndexValue[]; owners: string[] } {
  const drift: IndexDrift[] = [], expected: IndexValue[] = [], owners: string[] = [];
  for (const record of records) {
    if (record.tombstone) continue;
    const data = parsedObject(record.canonical_data);
    const rejected = data ? rejectedFields(data, definition.schema, fields) : new Set(fields);
    for (const field of fields) {
      const value = data && !rejected.has(field) ? derivedOrNull(data, definition, field) : null;
      if (value) { expected.push(value); owners.push(record.record_id); }
      else drift.push({ recordId: record.record_id, field, reason: 'underivable', expectedKind: null, actualKind: null });
    }
  }
  return { drift, expected, owners };
}

/** The row an accepted record derives for a field, or null when it derives none (a value past the index's byte limit). */
function derivedOrNull(data: Record<string, Json>, definition: CollectionDefinition, field: string): IndexValue | null {
  try { return derivedIndexValue(data, definition, field); } catch { return null; }
}

/** Stored canonical data as a JSON object, or null when it is not JSON or not an object. */
function parsedObject(text: string | null): Record<string, Json> | null {
  try {
    const parsed = JSON.parse(text ?? '') as Json;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Json> : null;
  } catch { return null; }
}

/** Why a row differs from the expected one: no expected row, no actual row, another kind, or another value. */
function driftReason(expectedKind: string | null, actualKind: string | null): IndexDrift['reason'] {
  if (expectedKind === null) return 'unexpected';
  if (actualKind === null) return 'missing';
  return expectedKind === actualKind ? 'value' : 'kind';
}

/**
 * The ready fields of a record the writers would reject under the current definition, validated as they validate it
 * (`validateParsedValue` of the whole record): none when the record is accepted. A rejected record is attributed to the
 * ready fields that fail their own schema (a missing one only when required) when the root holds only per-field
 * constraints and the rest of the record is accepted; otherwise (a root `enum`, an undeclared property, a field outside
 * the ready ones invalid or required and missing) to every ready field. Definitions only add optional fields, so data a
 * writer accepted stays accepted.
 */
function rejectedFields(data: Record<string, Json>, schema: SchemaNode, fields: string[]): Set<string> {
  try { validateParsedValue(data, schema); return new Set(); } catch { /* attributed below */ }
  // A whole-record constraint cannot be attributed to fields: the record is rejected as a whole.
  if (Object.hasOwn(schema, 'enum')) return new Set(fields);
  const required = schema.required ?? [], properties = schema.properties ?? {};
  try {
    // fromEntries keeps a `__proto__` member an own property, as the parsed data holds it.
    const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !fields.includes(key))) as Json;
    validateParsedValue(rest, { ...schema, required: required.filter(name => !fields.includes(name)) });
  } catch { return new Set(fields); }
  const rejected = new Set<string>();
  for (const field of fields) {
    try {
      if (!Object.hasOwn(properties, field)) rejected.add(field);
      else if (Object.hasOwn(data, field)) validateParsedValue(data[field], properties[field]);
      else if (required.includes(field)) rejected.add(field);
    } catch { rejected.add(field); }
  }
  // A rejection no ready field explains is the whole record's.
  return rejected.size ? rejected : new Set(fields);
}

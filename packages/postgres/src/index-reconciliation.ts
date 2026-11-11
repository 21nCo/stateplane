import { inTransaction } from './faults.js';
import type { PoolLike } from './faults.js';
import type { IndexValue } from './index.js';
import { derivedIndexValue, validateParsedValue } from './schema.js';
import type { CollectionDefinition, Json, SchemaNode } from './schema.js';

/**
 * Bounds of one reconciliation call (docs/analysis-measurements.md#reconciliation):
 * pages of 1,000 records, each one read-only snapshot; 10,000 records per call
 * unless `maxRecords` says otherwise (at most 1,000,000); at most 100 drift
 * samples reported, every drifted row counted.
 */
export const reconciliationBounds = Object.freeze({ pageRecords: 1_000, defaultRecords: 10_000, maxRecords: 1_000_000, samples: 100 });

/**
 * One typed index row that differs from what the record's canonical data
 * derives: `missing` (a live record has no row for a ready field),
 * `unexpected` (a deleted record still has one), `kind` or `value` (the row
 * holds another kind or value), or `underivable` (the record writers would not
 * accept the stored value under the current definition, so it derives no row:
 * a value outside its field's schema, a required field missing, a null on a
 * non-nullable field, or one past the index's byte limit; for every ready
 * field when the rest of the record is not accepted either, such as an
 * undeclared property, a required field missing outside the ready fields, or
 * canonical data that is not a JSON object). Kinds only, never values.
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
  /** The last record checked when more may follow, to pass as `after`; null once the collection was read to its end. */
  next: string | null;
  driftCount: number; drift: IndexDrift[];
}

/**
 * Compare a collection's typed index projection (`record_index_values`, which
 * record writers and backfill maintain and every exact query, count and
 * interactive aggregation reads) with what each record's canonical data
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
      const records = (await db.query(`SELECT record_id,tombstone,canonical_data FROM records
        WHERE space_id=$1 AND collection_id=$2 AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4`,
      [spaceId, collectionId, cursor, limit])).rows;
      const drift: IndexDrift[] = [];
      const expected: IndexValue[] = [], owners: string[] = [];
      for (const record of records) {
        if (record.tombstone) continue;
        // Damaged stored data derives nothing: it is drift of its ready fields, never a failure of the whole call.
        let data: Record<string, Json> | null = null;
        try {
          const parsed = JSON.parse(record.canonical_data) as Json;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, Json>;
        } catch { /* reported below */ }
        const rejected = data ? rejectedFields(data, definition.schema, fields) : new Set(fields);
        for (const field of fields) {
          let value: IndexValue | null = null;
          try { if (!rejected.has(field)) value = derivedIndexValue(data!, definition, field); } catch { /* reported below */ }
          if (!value) {
            drift.push({ recordId: record.record_id, field, reason: 'underivable', expectedKind: null, actualKind: null });
            continue;
          }
          expected.push(value); owners.push(record.record_id);
        }
      }
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
        const reason = row.expected_kind === null ? 'unexpected' : row.actual_kind === null ? 'missing'
          : row.expected_kind !== row.actual_kind ? 'kind' : 'value';
        drift.push({ recordId: row.record_id, field: row.field_name, reason, expectedKind: row.expected_kind, actualKind: row.actual_kind });
      }
      return { fields, records: records.length, last: records.length ? records[records.length - 1].record_id as string : null, drift };
    });
    // A declaration that turned ready during the call was not checked on its earlier pages: list only fields every page checked.
    result.fields = result.checked ? result.fields.filter(field => page.fields.includes(field)) : page.fields;
    result.checked += page.records;
    result.driftCount += page.drift.length;
    for (const item of page.drift) if (result.drift.length < reconciliationBounds.samples) result.drift.push(item);
    if (page.records < limit) { result.next = null; return result; }
    cursor = page.last;
    if (result.checked >= maxRecords) { result.next = cursor; return result; }
  }
}

/**
 * The ready fields whose stored value the record writers would reject under the current definition, validated as they
 * validate it (`validateParsedValue`): each ready field against its own schema (a missing one only when required); every
 * ready field when the rest of the record is rejected (an undeclared property, a required field missing, an invalid value
 * of a field not checked here). Definitions only add optional fields, so data a writer accepted stays accepted.
 */
function rejectedFields(data: Record<string, Json>, schema: SchemaNode, fields: string[]): Set<string> {
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
  return rejected;
}

import type pg from 'pg';
import type { VerifiedCredential } from '@stateplane/contracts';
import { AggregationLimitError, AuthorityError, AuthorityTransaction, predicateFilter, snapshotPredicates } from './index.js';
import type { AuthorityScope, ScalarPredicate } from './index.js';
import { includes, MAX_INDEX_PART_BYTES, scalarString } from './schema.js';
import { fields, invalid, transact, untrusted } from './sources.js';
import type { Db } from './sources.js';
import type { PostgresSpaces } from './spaces.js';

/**
 * One cell's analytical capacity: `pool`, the cell's analytical pool, apart
 * from its interactive pool and sized to `analyticalSlots(...).cell`; the
 * cell's configured Hyperdrive `originConnectionLimit` (5 to 20), from which
 * its analytical slots are derived; and `admission`, the interactive pool on
 * which an aggregation's collection and grant are authorized, in one short
 * transaction, before it takes analytical capacity.
 */
export interface AggregationCell { pool: Pick<pg.Pool, 'connect'>; admission: Pick<pg.Pool, 'connect'>; originConnectionLimit: number }
export interface AggregationOptions {
  /** The aggregate statement's `statement_timeout`, 1 to 15,000 ms; 5,000 by default. */
  statementTimeoutMs?: number;
}
export type AggregationUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
export type AggregationOperator = 'count' | 'sum' | 'avg' | 'min' | 'max';
type ValueKind = 'string' | 'number' | 'boolean' | 'date-time';
/** One group's value of one `groupBy` dimension; a time bucket's value is its start instant, with its local wall time. */
export type GroupKey = { kind: 'missing' } | { kind: 'null' } | { kind: 'value'; value: string | number | boolean; local?: string };
/**
 * One metric of one group: `count` is the group's record count; for a field
 * metric, `values`, `nulls` and `missing` count the group's records whose
 * field holds a value, an explicit null or nothing, and `value` is computed
 * over the values only (null when there are none). A sum and an average are
 * decimal strings; a minimum or maximum has the field's own type.
 */
export interface AggregationMetricValue {
  value: string | number | null; values: number | null; nulls: number | null; missing: number | null;
}
export interface AggregationResult {
  /** The records aggregated: the collection's live (not deleted) records matching every `where` predicate. */
  source: { spaceId: string; collectionId: string; records: 'live'; where: ScalarPredicate[]; policyVersion: number;
    placementGeneration: number };
  /** The schema version the statement read, and the declared index of each grouped or measured field. */
  collection: { schemaVersion: number; fields: { field: string; kind: ValueKind; acceptedVersion: number }[] };
  /** Every group and metric comes from this one statement's snapshot, taken at `takenAt`. */
  snapshot: { scope: 'statement'; takenAt: string };
  groupBy: { field: string; kind: ValueKind; bucket: { unit: AggregationUnit; timeZone: string } | null;
    semantics: 'exact' | 'derived' }[];
  metrics: { op: AggregationOperator; field: string | null; semantics: 'exact' | 'derived'; precision: string | null }[];
  /** Every group, in key order: values first (ascending), then null, then missing. Never truncated. */
  groups: { key: GroupKey[]; count: number; metrics: AggregationMetricValue[] }[];
  complete: true;
}

/**
 * Initial protective bounds, not measured capacity (STA-60 measures them):
 * at most 3 group dimensions and 16 metrics, at most 1,000 groups (100 unless
 * `maxGroups` says otherwise), 256 KiB of groups as JSON text, 5 s of
 * statement time, averages to 20 significant digits, and a serialized spec of
 * at most 32 KiB.
 */
export const aggregationBounds = Object.freeze({ groupBy: 3, metrics: 16, maxGroups: 1_000, defaultMaxGroups: 100,
  resultBytes: 262_144, statementMs: 5_000, maxStatementMs: 15_000, averageDigits: 20, specBytes: 32_768 });

/**
 * A cell's analytical slots for an origin connection limit of 5 to 20: one
 * fifth of the origin connections (1 at 5, 4 at 20), of which one space may
 * use half (at least 1). The jobs Worker holds up to half of the connections
 * and the API and MCP Workers the rest (3 of 5), so interactive authoritative
 * reads keep at least 2 of 5 under any analytical load.
 */
export function analyticalSlots(originConnectionLimit: number): { cell: number; space: number } {
  if (!Number.isSafeInteger(originConnectionLimit) || originConnectionLimit < 5 || originConnectionLimit > 20)
    throw new RangeError('Invalid origin connection limit');
  const cell = Math.floor(originConnectionLimit / 5);
  return { cell, space: Math.max(1, Math.floor(cell / 2)) };
}

/*
 * Admission, bounds and statement text use only intrinsics captured here at load and own array slots read by index:
 * a replaced Array.prototype.includes, map, flatMap, join or iterator, Map.prototype.get, set or has, or
 * String.prototype.includes never admits input, skips a capacity bound or yields an untyped error.
 */
const nativeJoin = Array.prototype.join;
const nativeMapGet = Map.prototype.get, nativeMapSet = Map.prototype.set, nativeMapHas = Map.prototype.has;
const nativeMapForEach = Map.prototype.forEach;
const nativeStringIncludes = String.prototype.includes;
const joined = (values: readonly string[], separator: string) => Reflect.apply(nativeJoin, values, [separator]) as string;
const mapGet = <K, V>(map: ReadonlyMap<K, V>, key: K) => Reflect.apply(nativeMapGet, map, [key]) as V | undefined;
const mapHas = <K, V>(map: ReadonlyMap<K, V>, key: K) => Reflect.apply(nativeMapHas, map, [key]) as boolean;
const mapSet = <K, V>(map: Map<K, V>, key: K, value: V) => { Reflect.apply(nativeMapSet, map, [key, value]); };
/** Append as an own data slot, never through an inherited push or index setter. */
const append = <T>(values: T[], value: T) => {
  Object.defineProperty(values, values.length, { value, writable: true, configurable: true, enumerable: true });
};
/** `f` of each own slot of an array this module built or the driver returned, in order. */
function each<T, U>(values: readonly T[], f: (value: T, index: number) => U): U[] {
  const result: U[] = [];
  for (let i = 0; i < values.length; i++) append(result, f(values[i], i));
  return result;
}
/** The distinct values, in first-seen order. */
function distinct<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < values.length; i++) if (!includes(result, values[i])) append(result, values[i]);
  return result;
}

const UNITS: readonly string[] = Object.freeze(['hour', 'day', 'week', 'month', 'quarter', 'year']);
const OPERATORS: readonly string[] = Object.freeze(['count', 'sum', 'avg', 'min', 'max']);
/** What each operator accepts: a sum or average only numbers; a minimum or maximum ordered kinds. */
const accepts = (op: AggregationOperator, kind: ValueKind) => op === 'sum' || op === 'avg' ? kind === 'number'
  : kind === 'number' || kind === 'string' || kind === 'date-time';
const COLUMN: Readonly<Record<ValueKind, string>> = Object.freeze({ string: 'string_value', number: 'number_value',
  boolean: 'boolean_value', 'date-time': 'time_value' });
// An IANA name: letters first, so no POSIX offset string ("+05:00", "UTC+3") with its inverted sign is accepted.
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

interface Dimension { field: string; bucket: { unit: AggregationUnit; timeZone: string } | null }
interface Metric { op: AggregationOperator; field: string | null }
interface Spec { where: readonly ScalarPredicate[]; groupBy: Dimension[]; metrics: Metric[]; maxGroups: number }
interface Declared { kind: ValueKind; ready: boolean; filterable: boolean; acceptedVersion: number }

/** A plain array's own items, read by index without an inherited iterator. */
function items(value: unknown, max: number, name: string, trustedParsed: boolean): unknown[] {
  if (!value || typeof value !== 'object' || (!trustedParsed && untrusted(value)) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) invalid(`${name} must be an array`);
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length < 1 || length > max || Reflect.ownKeys(value).length !== length + 1) invalid(`${name} must hold 1 to ${max} items`);
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, i);
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) invalid(`Invalid ${name}`);
    append(result, item.value);
  }
  return result;
}
function field(value: unknown): string {
  if (!scalarString(value) || !value || Buffer.byteLength(value) > MAX_INDEX_PART_BYTES) invalid('Invalid field');
  return value;
}
function timeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !ZONE.test(value)) invalid('timeZone must be an IANA time zone name');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); } catch { invalid('timeZone must be an IANA time zone name'); }
  return value;
}

/**
 * Admit a typed spec: declared field names, allowlisted operators and units,
 * AND-only scalar predicates. An object from the caller is admitted only where
 * the runtime detects proxies; `trustedParsed` data, just parsed from JSON
 * text, everywhere.
 */
function parse(request: unknown, trustedParsed: boolean): Spec {
  const input = fields(request, ['where', 'groupBy', 'metrics', 'maxGroups'], ['metrics'], trustedParsed);
  const where = input.where === undefined ? [] : snapshotPredicates(input.where as ScalarPredicate[], trustedParsed);
  const groupBy = input.groupBy === undefined ? [] : each(items(input.groupBy, aggregationBounds.groupBy, 'groupBy', trustedParsed), item => {
    const dimension = fields(item, ['field', 'bucket'], ['field'], trustedParsed);
    if (dimension.bucket === undefined) return { field: field(dimension.field), bucket: null };
    const bucket = fields(dimension.bucket, ['unit', 'timeZone'], ['unit', 'timeZone'], trustedParsed);
    if (typeof bucket.unit !== 'string' || !includes(UNITS, bucket.unit)) invalid(`bucket unit must be one of ${joined(UNITS, ', ')}`);
    return { field: field(dimension.field), bucket: { unit: bucket.unit as AggregationUnit, timeZone: timeZone(bucket.timeZone) } };
  });
  if (distinct(each(groupBy, dimension => dimension.field)).length !== groupBy.length) invalid('A field is grouped at most once');
  const metrics = each(items(input.metrics, aggregationBounds.metrics, 'metrics', trustedParsed), item => {
    const metric = fields(item, ['op', 'field'], ['op'], trustedParsed);
    if (typeof metric.op !== 'string' || !includes(OPERATORS, metric.op)) invalid(`op must be one of ${joined(OPERATORS, ', ')}`);
    if (metric.op === 'count') {
      if (metric.field !== undefined) invalid('count counts records and takes no field');
      return { op: 'count' as const, field: null };
    }
    if (metric.field === undefined) invalid(`${String(metric.op)} needs a field`);
    return { op: metric.op as AggregationOperator, field: field(metric.field) };
  });
  // Only an absent maxGroups takes the default; null or any other non-integer is refused.
  const maxGroups = input.maxGroups === undefined ? aggregationBounds.defaultMaxGroups : input.maxGroups;
  if (!Number.isSafeInteger(maxGroups) || (maxGroups as number) < 1 || (maxGroups as number) > aggregationBounds.maxGroups)
    invalid(`maxGroups must be an integer from 1 to ${aggregationBounds.maxGroups}`);
  return { where, groupBy, metrics, maxGroups: maxGroups as number };
}

/** Check every field against its ready declaration and every operator against its kind. */
function admit(spec: Spec, declared: ReadonlyMap<string, Declared>): void {
  for (let i = 0; i < spec.where.length; i++) {
    const predicate = spec.where[i], declaration = mapGet(declared, predicate.field);
    if (!declaration?.ready || !declaration.filterable || (predicate.kind !== 'null' && declaration.kind !== predicate.kind))
      throw new AuthorityError('SCHEMA_CONFLICT', 'Filter index is not ready');
  }
  const ready = (name: string) => {
    const declaration = mapGet(declared, name);
    if (!declaration?.ready) throw new AuthorityError('SCHEMA_CONFLICT', `Aggregated field ${name} is not a ready declared index`);
    return declaration.kind;
  };
  for (let i = 0; i < spec.groupBy.length; i++) {
    const dimension = spec.groupBy[i], kind = ready(dimension.field);
    if (dimension.bucket ? kind !== 'date-time' : kind === 'date-time')
      invalid(`${dimension.field} is a ${kind} index: date-time fields are grouped by time bucket only, and only they are`);
  }
  for (let i = 0; i < spec.metrics.length; i++) {
    const metric = spec.metrics[i];
    if (metric.field === null) continue;
    const kind = ready(metric.field);
    if (!accepts(metric.op, kind)) invalid(`${metric.op} does not accept the ${kind} index ${metric.field}`);
  }
}

/**
 * A stored instant as `timestamptz` for bucketing: its fraction cut to the
 * microseconds `timestamptz` holds (never rounded into the next second), and
 * a leap second (23:59:60) kept in the minute it ends rather than the next.
 */
const instant = (alias: string) => `(CASE WHEN substr(${alias}.time_value,18,2)='60'
  THEN substr(${alias}.time_value,1,17)||'59.999999Z'
  ELSE substring(${alias}.time_value from '^.{19}(?:\\.[0-9]{1,6})?')||'Z' END)::timestamptz`;

/**
 * The one aggregate statement: grouped, measured, sized and checked against
 * its caps in one snapshot. Its size of a group is a lower bound of the group's
 * JSON: the text of its key kinds and string and boolean keys, its counts, its
 * sums and its string and date-time extremes, each no longer than in the JSON
 * (numbers, averages and buckets are left to the full check after formatting).
 * So a result it refuses is over the byte cap, and it never sends one far
 * past it.
 */
function statement(scope: Readonly<AuthorityScope>, spec: Spec, declared: ReadonlyMap<string, Declared>) {
  const { params, where } = predicateFilter(scope, spec.where);
  const bind = (value: unknown) => { append(params, value); return `$${params.length}`; };
  const aliases = new Map<string, string>(), aliased: string[] = [];
  const joins: string[] = [];
  const kindOf = (name: string) => mapGet(declared, name)!.kind;
  const alias = (name: string) => {
    if (!mapHas(aliases, name)) {
      const next = `f${aliased.length}`;
      mapSet(aliases, name, next);
      append(aliased, name);
      append(joins, `LEFT JOIN record_index_values ${next} ON ${next}.space_id=r.space_id AND ${next}.collection_id=r.collection_id
        AND ${next}.record_id=r.record_id AND ${next}.field_name=${bind(name)}`);
    }
    return mapGet(aliases, name)!;
  };
  const grouped: string[] = ['count(*) AS n'], keys: string[] = [], texts: string[] = ['n::text'], labels: string[] = [],
    order: string[] = [];
  each(spec.groupBy, (dimension, i) => {
    const a = alias(dimension.field), kind = kindOf(dimension.field);
    const value = dimension.bucket ? `date_trunc(${bind(dimension.bucket.unit)},${instant(a)},${bind(dimension.bucket.timeZone)})`
      : `${a}.${COLUMN[kind]}`;
    append(grouped, `${a}.value_kind AS k${i}`); append(grouped, `${value} AS v${i}`);
    append(keys, `k${i}`); append(keys, `v${i}`);
    append(texts, `k${i}`);
    if (kind === 'string' || kind === 'boolean') append(texts, `v${i}::text`);
    append(order, `CASE s.k${i} WHEN 'null' THEN 1 WHEN 'missing' THEN 2 ELSE 0 END`); append(order, `s.v${i}`);
    if (dimension.bucket) {
      // A bucket's local label is its start at its UTC offset: for an hour, its members' own offset (date_trunc keeps it,
      // so ambiguous and shifted hours stay apart, and it is one offset per bucket); for a day or more, the offset at its start.
      // Its start leaves as epoch seconds, formatted with proleptic ISO years (to_char would write 1 BC as 0001).
      const zone = bind(dimension.bucket.timeZone);
      const at = (instant: string) => `EXTRACT(EPOCH FROM (${instant} AT TIME ZONE ${zone})-(${instant} AT TIME ZONE 'UTC'))::int`;
      const hour = dimension.bucket.unit === 'hour';
      if (hour) append(grouped, `min(${at(instant(a))}) AS o${i}`);
      append(labels, `EXTRACT(EPOCH FROM v${i})::bigint AS e${i}`);
      if (!hour) append(labels, `${at(`v${i}`)} AS o${i}`);
    }
  });
  each(spec.metrics, (metric, j) => {
    if (metric.field === null) { append(grouped, `count(*) AS m${j}`); append(texts, `m${j}::text`); return; }
    const a = alias(metric.field), kind = kindOf(metric.field);
    const present = `FILTER (WHERE ${a}.value_kind=${bind(kind)})`;
    let value = `${metric.op === 'avg' ? 'sum' : metric.op}(${a}.${COLUMN[kind]}) ${present}`;
    if (kind === 'date-time') value = `${metric.op}(stateplane_instant_sort_key(${a}.time_value) COLLATE "C") ${present}`;
    append(grouped, `${value} AS m${j}`); append(grouped, `count(*) ${present} AS m${j}_values`);
    append(grouped, `count(*) FILTER (WHERE ${a}.value_kind='null') AS m${j}_nulls`);
    append(grouped, `count(*) FILTER (WHERE ${a}.value_kind='missing') AS m${j}_missing`);
    append(texts, `m${j}_values::text`); append(texts, `m${j}_nulls::text`); append(texts, `m${j}_missing::text`);
    if (metric.op === 'sum') append(texts, `trim_scale(m${j})::text`);
    else if (metric.op !== 'avg' && kind !== 'number') append(texts, `m${j}::text`);
  });
  // Readiness promises one value row per live record and declared field, of its kind, null or missing; anything else fails.
  const consistent = each(aliased, name =>
    `COALESCE(${mapGet(aliases, name)!}.value_kind IN (${bind(kindOf(name))},'null','missing'),false)`);
  append(grouped, `bool_or(NOT (${consistent.length ? joined(consistent, ' AND ') : 'true'})) AS inconsistent`);
  const maxGroups = bind(spec.maxGroups), maxBytes = bind(aggregationBounds.resultBytes);
  const sql = `WITH grouped AS (
      SELECT ${joined(grouped, ',')} FROM records r ${joined(joins, ' ')}
      WHERE ${where}${keys.length ? ` GROUP BY ${joined(keys, ',')}` : ''}
    ), sized AS (
      SELECT g.*,${labels.length ? `${joined(labels, ',')},` : ''}octet_length(concat(${texts.length ? joined(texts, ',') : `''`})) AS bytes
      FROM grouped g
    ), totals AS (
      SELECT count(*) AS total_groups,COALESCE(sum(bytes),0) AS total_bytes,COALESCE(bool_or(inconsistent),false) AS total_inconsistent,
        statement_timestamp() AS taken_at FROM sized
    )
    SELECT t.*,s.* FROM totals t
    LEFT JOIN LATERAL (SELECT * FROM sized WHERE t.total_groups<=${maxGroups} AND t.total_bytes<=${maxBytes}
      AND NOT t.total_inconsistent) s ON true
    ${order.length ? `ORDER BY ${joined(order, ',')}` : ''}`;
  return { sql, params };
}

/** A numeric's text without trailing fractional zeros or a negative zero. */
function decimal(text: string): string {
  const trimmed = Reflect.apply(nativeStringIncludes, text, ['.']) ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * The exact average `sum / count` rounded half away from zero to 20
 * significant digits, as a plain decimal string; null without values.
 */
function roundedAverage(sum: string, count: number): string | null {
  if (count === 0) return null;
  const negative = sum.startsWith('-');
  const parts = (negative ? sum.slice(1) : sum).split('.'), whole = parts[0], fraction = parts.length > 1 ? parts[1] : '';
  const numerator = BigInt(whole + fraction), denominator = 10n ** BigInt(fraction.length) * BigInt(count);
  if (numerator === 0n) return '0';
  const digits = BigInt(aggregationBounds.averageDigits), low = 10n ** (digits - 1n), high = 10n ** digits;
  // value = numerator / denominator; find q = floor(value * 10^shift) with low <= q < high.
  let shift = aggregationBounds.averageDigits - numerator.toString().length + denominator.toString().length;
  const scaled = (by: number): [bigint, bigint] => by >= 0 ? [numerator * 10n ** BigInt(by), denominator]
    : [numerator, denominator * 10n ** BigInt(-by)];
  let pair = scaled(shift);
  while (pair[0] / pair[1] >= high) pair = scaled(--shift);
  while (pair[0] / pair[1] < low) pair = scaled(++shift);
  const n = pair[0], d = pair[1];
  let q = n / d;
  if (2n * (n - q * d) >= d) q++;
  if (q === high) { q /= 10n; shift--; }
  let text = q.toString();
  if (shift <= 0) text += '0'.repeat(-shift);
  else {
    text = text.padStart(shift + 1, '0');
    text = `${text.slice(0, -shift)}.${text.slice(-shift)}`;
  }
  return `${negative ? '-' : ''}${decimal(text)}`;
}

/**
 * Epoch seconds as ISO 8601 date and time without zone, in proleptic Gregorian
 * years: 0000 is 1 BC, and a year past 9999 (only a local label east of UTC
 * can reach one) is written expanded, as +010000, as JavaScript writes it.
 */
const wallTime = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, -5);
/** A UTC offset in seconds as ±HH:MM (±HH:MM:SS for a historical offset with seconds). */
function offset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+', magnitude = Math.abs(seconds);
  const part = (value: number) => String(value).padStart(2, '0');
  const rest = magnitude % 60 ? `:${part(magnitude % 60)}` : '';
  return `${sign}${part(Math.floor(magnitude / 3600))}:${part(Math.floor(magnitude / 60) % 60)}${rest}`;
}

/** Zone names that are also abbreviations of UTC itself: their IANA zones are UTC at every instant. */
const UTC_NAMES: readonly string[] = Object.freeze(['utc', 'uct', 'zulu', 'gmt']);
/**
 * Each bucket's time zone, resolved by IANA rules only. PostgreSQL reads a
 * zone name as a `timezone_abbreviations` entry (a fixed offset) before its
 * time zone database, so a CET, EET, MET, WET or PST bucket would keep its
 * winter offset all summer. A name that is such an abbreviation is refused,
 * except UTC, UCT, Zulu and GMT, which name UTC either way and become
 * `Etc/UTC`; so is a name the database's time zone database does not know.
 */
async function zones(db: Db, spec: Spec): Promise<Spec> {
  const names: string[] = [];
  for (let i = 0; i < spec.groupBy.length; i++) {
    const bucket = spec.groupBy[i].bucket;
    if (bucket && !includes(names, bucket.timeZone)) append(names, bucket.timeZone);
  }
  if (!names.length) return spec;
  let rows: { z: string; offset: number | null }[];
  try {
    rows = (await db.query(`SELECT z,(SELECT EXTRACT(EPOCH FROM utc_offset)::int FROM pg_timezone_abbrevs WHERE lower(abbrev)=lower(z)
      LIMIT 1) AS offset,clock_timestamp() AT TIME ZONE z AS probe FROM unnest($1::text[]) z`, [names])).rows;
  } catch (error) {
    if ((error as { code?: string }).code === '22023') invalid('timeZone is not a time zone this database knows');
    throw error;
  }
  const resolved = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.offset === null) mapSet(resolved, row.z, row.z);
    else if (row.offset === 0 && includes(UTC_NAMES, row.z.toLowerCase())) mapSet(resolved, row.z, 'Etc/UTC');
    else invalid(`timeZone ${row.z} is also a fixed-offset time zone abbreviation; name a region's zone, such as Europe/Paris`);
  }
  return { ...spec, groupBy: each(spec.groupBy, dimension => dimension.bucket ? { field: dimension.field,
    bucket: { unit: dimension.bucket.unit, timeZone: mapGet(resolved, dimension.bucket.timeZone)! } } : dimension) };
}

const lockSlots = `SELECT
  (SELECT slot FROM analysis_cell_slots WHERE cell_id=$1 AND slot<=$2
    AND (holder_job_id IS NULL OR held_until<=clock_timestamp()) ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED) AS cell_slot,
  (SELECT slot FROM analysis_space_slots WHERE space_id=$3 AND slot<=$4
    AND (holder_job_id IS NULL OR held_until<=clock_timestamp()) ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED) AS space_slot,
  (SELECT count(*)::int FROM analysis_cell_slots WHERE cell_id=$1 AND slot<=$2) AS cell_rows,
  (SELECT count(*)::int FROM analysis_space_slots WHERE space_id=$3 AND slot<=$4) AS space_rows`;
/** The lock found no free slot where fewer slot rows exist than the derived limit allows. */
class Unprovisioned extends Error {}

/**
 * Add the missing slots up to the derived limits, in a transaction of its
 * own, so no aggregation ever waits for another's uncommitted slot rows. Rows
 * past a limit are ignored, so lowering the limit lowers capacity. The scope
 * is locked and checked first, so a space suspended or deleted meanwhile is
 * refused with its typed authority error, never a slot constraint violation.
 */
async function provision(db: Db, scope: Readonly<AuthorityScope>, cellId: string, slots: { cell: number; space: number }): Promise<void> {
  const spaceId = scope.spaceId;
  const tx = new AuthorityTransaction(db, scope, 1);
  try { await tx.checkScope(); } finally { tx.close(); }
  await db.query(`INSERT INTO analysis_cell_slots(cell_id,slot) SELECT $1,s FROM generate_series(1,$2::int) s
    WHERE NOT EXISTS (SELECT 1 FROM analysis_cell_slots x WHERE x.cell_id=$1 AND x.slot=s) ON CONFLICT DO NOTHING`, [cellId, slots.cell]);
  await db.query(`INSERT INTO analysis_space_slots(space_id,slot) SELECT $1,s FROM generate_series(1,$2::int) s
    WHERE NOT EXISTS (SELECT 1 FROM analysis_space_slots x WHERE x.space_id=$1 AND x.slot=s) ON CONFLICT DO NOTHING`, [spaceId, slots.space]);
}

/**
 * Bounded interactive aggregations over one collection's declared index
 * fields: count, sum, average, minimum and maximum, grouped by up to three
 * fields or time buckets, over the live records matching AND-only scalar
 * predicates. No raw SQL, join or user code: every field is a ready declared
 * index, every operator and unit is allowlisted, and every value is bound.
 *
 * Each aggregation is one statement, so every group and metric comes from one
 * snapshot, in one READ COMMITTED transaction that first share locks the scope
 * (the space at the admitted policy and placement, the collection, a key's
 * grant) through commit and finally rechecks the caller's credential. It runs
 * only on analytical capacity, after the collection and grant are authorized
 * on the interactive admission pool: on the cell's analytical pool, at most
 * `analyticalSlots(...).cell` at once per process before it connects, and in
 * the database a free slot of the cell and of the space (migration 049),
 * held by row lock for its transaction, so
 * aggregations across processes stay within the cell's analytical budget.
 * Over budget, over its group or byte cap or past its statement time, it fails
 * with a typed `AggregationLimitError`, never with a partial result.
 */
export class PostgresAggregations {
  readonly #running = new Map<string, number>();
  readonly #statementMs: number;
  constructor(private readonly spaces: PostgresSpaces, private readonly cells: ReadonlyMap<string, AggregationCell>,
    options: AggregationOptions = {}) {
    Reflect.apply(nativeMapForEach, cells, [(cell: AggregationCell, id: string) => {
      analyticalSlots(cell.originConnectionLimit);
      // Fail closed: an aggregation never runs on the pool interactive reads are admitted on.
      if (cell.pool === cell.admission) throw new Error(`Cell ${id} needs an analytical pool apart from its admission pool`);
    }]);
    const ms = options.statementTimeoutMs ?? aggregationBounds.statementMs;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > aggregationBounds.maxStatementMs) throw new RangeError('Invalid statement time budget');
    this.#statementMs = ms;
  }

  /**
   * Aggregate `collectionId` for `request`: `{ where?, groupBy?, metrics, maxGroups? }`.
   * `where` is the exact query's scalar predicates (AND); `groupBy` holds
   * `{ field }` or `{ field, bucket: { unit, timeZone } }`; `metrics` holds
   * `{ op: 'count' }` or `{ op: 'sum' | 'avg' | 'min' | 'max', field }`.
   * Requires `records:read` on the collection. An object request is refused
   * (INVALID_ARGUMENT) where the runtime cannot detect proxies, such as a
   * Worker: use `aggregateSerialized` there.
   */
  aggregate(actor: VerifiedCredential, spaceId: string, collectionId: string, request: unknown): Promise<AggregationResult> {
    return this.admit(actor, spaceId, collectionId, () => parse(request, false));
  }

  /**
   * As `aggregate`, for the spec as JSON text (at most 32 KiB), parsed only
   * after the collection is authorized: the entrypoint for every runtime.
   */
  aggregateSerialized(actor: VerifiedCredential, spaceId: string, collectionId: string, serialized: string): Promise<AggregationResult> {
    return this.admit(actor, spaceId, collectionId, () => {
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > aggregationBounds.specBytes)
        invalid(`The spec must be JSON text of at most ${aggregationBounds.specBytes} bytes`);
      let parsed: unknown;
      try { parsed = JSON.parse(serialized); } catch { invalid('The spec must be JSON text'); }
      return parse(parsed, true);
    });
  }

  private async admit(actor: VerifiedCredential, spaceId: string, collectionId: string, request: () => Spec): Promise<AggregationResult> {
    const admitted = await this.spaces.scope(actor, spaceId, collectionId, 'records:read');
    const cell = mapGet(this.cells, admitted.cellId);
    if (!cell) throw new AuthorityError('PROVIDER_UNAVAILABLE', 'Analytical capacity is not configured for this cell', undefined, false);
    // Authorize the collection and grant before taking capacity, so a caller without records:read, or a collection that does
    // not exist, is refused as such and never holds or waits on a slot. The analytical transaction locks and checks them again.
    await transact(cell.admission, async db => {
      const tx = new AuthorityTransaction(db, admitted.scope, 1);
      try { await tx.checkScope(); } finally { tx.close(); }
    });
    // The spec is validated once authorized, before any capacity is taken and before any member reaches a query: every
    // predicate is compiled here, so a malformed one is INVALID_ARGUMENT and never a bound parameter or declaration lookup.
    const spec = request();
    predicateFilter(admitted.scope, spec.where);
    const slots = analyticalSlots(cell.originConnectionLimit);
    const running = mapGet(this.#running, admitted.cellId) ?? 0;
    if (running >= slots.cell) throw new AggregationLimitError('slots', 'Analytical capacity is in use; retry later');
    mapSet(this.#running, admitted.cellId, running + 1);
    try {
      try { return await transact(cell.pool, db => this.run(db, actor, admitted, spec, slots, true)); }
      catch (error) { if (!(error instanceof Unprovisioned)) throw error; }
      await transact(cell.pool, db => provision(db, admitted.scope, admitted.cellId, slots));
      return await transact(cell.pool, db => this.run(db, actor, admitted, spec, slots, false));
    } finally {
      mapSet(this.#running, admitted.cellId, mapGet(this.#running, admitted.cellId)! - 1);
    }
  }

  private async run(db: Db, actor: VerifiedCredential, admitted: Awaited<ReturnType<PostgresSpaces['scope']>>, admittedSpec: Spec,
    slots: { cell: number; space: number }, provisionable: boolean): Promise<AggregationResult> {
    const { scope, cellId, ownerPrincipalId } = admitted;
    // Space, collection and grant first, as every reader takes them, then at once the slots (a purge locks its space before
    // its slots), so all further analytical work on this connection is within the slot budget.
    const tx = new AuthorityTransaction(db, scope, 1);
    try { await tx.checkScope(); } finally { tx.close(); }
    const held = (await db.query(lockSlots, [cellId, slots.cell, scope.spaceId, slots.space])).rows[0];
    const missing = held.cell_rows < slots.cell || held.space_rows < slots.space;
    if (held.cell_slot === null || held.space_slot === null) {
      if (missing && provisionable) throw new Unprovisioned();
      throw new AggregationLimitError('slots', `The ${held.cell_slot === null ? "cell's" : "space's"} analytical slots are in use; retry later`);
    }
    const spec = await zones(db, admittedSpec);
    const named: string[] = [];
    for (let i = 0; i < spec.where.length; i++) append(named, spec.where[i].field);
    for (let i = 0; i < spec.groupBy.length; i++) append(named, spec.groupBy[i].field);
    for (let i = 0; i < spec.metrics.length; i++) if (spec.metrics[i].field !== null) append(named, spec.metrics[i].field!);
    const names = distinct(named);
    const rows = (await db.query(`SELECT c.schema_version,d.field_name,d.value_kind,d.ready,d.filterable,d.accepted_version
      FROM collections c LEFT JOIN collection_index_declarations d ON d.space_id=c.space_id AND d.collection_id=c.collection_id
        AND d.field_name=ANY($3::text[])
      WHERE c.space_id=$1 AND c.collection_id=$2`, [scope.spaceId, scope.collectionId, names])).rows;
    const schemaVersion = Number(rows[0]?.schema_version);
    if (!Number.isSafeInteger(schemaVersion)) throw new AuthorityError('SCHEMA_CONFLICT');
    const declared = new Map<string, Declared>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.field_name !== null) mapSet(declared, String(row.field_name), { kind: row.value_kind, ready: row.ready === true,
        filterable: row.filterable === true, acceptedVersion: Number(row.accepted_version) });
    }
    admit(spec, declared);
    const { sql, params } = statement(scope, spec, declared);

    // One slot is one backend: no parallel workers outside the analytical budget.
    await db.query('SET LOCAL max_parallel_workers_per_gather = 0');
    await db.query(`SET LOCAL statement_timeout = '${this.#statementMs}ms'`);
    let result: pg.QueryResult;
    try { result = await db.query(sql, params); }
    catch (error) {
      if ((error as { code?: string }).code === '57014')
        throw new AggregationLimitError('time', `The aggregation ran past its ${this.#statementMs} ms statement budget and was cancelled`);
      throw error;
    }
    const totals = result.rows[0];
    if (totals.total_inconsistent === true) throw new AuthorityError('SCHEMA_CONFLICT', 'Record index projection incomplete');
    const groupCount = Number(totals.total_groups);
    if (groupCount > spec.maxGroups)
      throw new AggregationLimitError('groups', `The aggregation has ${groupCount} groups, more than maxGroups (${spec.maxGroups})`);
    const overBytes = () => new AggregationLimitError('bytes', `The aggregation's groups exceed ${aggregationBounds.resultBytes} bytes`);
    if (Number(totals.total_bytes) > aggregationBounds.resultBytes) throw overBytes();
    const kindOf = (name: string) => mapGet(declared, name)!.kind;
    const groups = groupCount === 0 ? [] : each(result.rows, row => ({
      key: each(spec.groupBy, (dimension, i): GroupKey => {
        if (row[`k${i}`] === 'null' || row[`k${i}`] === 'missing') return { kind: row[`k${i}`] };
        if (dimension.bucket) {
          const start = Number(row[`e${i}`]), shift = Number(row[`o${i}`]);
          return { kind: 'value', value: `${wallTime(start)}Z`, local: `${wallTime(start + shift)}${offset(shift)}` };
        }
        const kind = kindOf(dimension.field);
        return { kind: 'value', value: kind === 'number' ? Number(row[`v${i}`]) : row[`v${i}`] };
      }),
      count: Number(row.n),
      metrics: each(spec.metrics, (metric, j): AggregationMetricValue => {
        if (metric.field === null) return { value: Number(row[`m${j}`]), values: null, nulls: null, missing: null };
        const raw = row[`m${j}`] as string | null, values = Number(row[`m${j}_values`]);
        let value: string | number | null = raw;
        if (raw !== null && metric.op === 'sum') value = decimal(raw);
        else if (metric.op === 'avg') value = roundedAverage(raw ?? '0', values);
        else if (raw !== null && kindOf(metric.field) === 'number') value = Number(raw);
        else if (raw !== null && kindOf(metric.field) === 'date-time') value = `${raw}Z`;
        if (metric.op === 'sum' && raw === null) value = '0';
        return { value, values, nulls: Number(row[`m${j}_nulls`]), missing: Number(row[`m${j}_missing`]) };
      })
    }));
    // The cap holds for every returned key and metric value, counts and rounded averages included.
    if (Buffer.byteLength(JSON.stringify(groups)) > aggregationBounds.resultBytes) throw overBytes();
    await db.query(`SET LOCAL statement_timeout = '${aggregationBounds.statementMs}ms'`);
    await this.spaces.assertScopeCurrent(actor, ownerPrincipalId, scope, db, scope.collectionId, ['records:read']);
    const measured: string[] = each(spec.groupBy, item => item.field);
    for (let i = 0; i < spec.metrics.length; i++) if (spec.metrics[i].field !== null) append(measured, spec.metrics[i].field!);
    const used = distinct(measured);
    return {
      source: { spaceId: scope.spaceId, collectionId: scope.collectionId, records: 'live', where: each(spec.where, item => item),
        policyVersion: scope.policyVersion, placementGeneration: scope.placementGeneration },
      collection: { schemaVersion, fields: each(used, name => ({ field: name, kind: kindOf(name),
        acceptedVersion: mapGet(declared, name)!.acceptedVersion })) },
      snapshot: { scope: 'statement', takenAt: new Date(totals.taken_at).toISOString() },
      groupBy: each(spec.groupBy, dimension => ({ field: dimension.field, kind: kindOf(dimension.field), bucket: dimension.bucket,
        semantics: dimension.bucket ? 'derived' : 'exact' })),
      metrics: each(spec.metrics, metric => ({ op: metric.op, field: metric.field, semantics: metric.op === 'avg' ? 'derived' : 'exact',
        precision: metric.op === 'avg' ? `${aggregationBounds.averageDigits} significant digits, half away from zero` : null })),
      groups, complete: true
    };
  }
}

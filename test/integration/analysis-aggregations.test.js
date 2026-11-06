import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { AggregationLimitError, PostgresAggregations, PostgresSpaces, aggregationBounds, analyticalSlots, postgresServices }
  from '../../packages/postgres/dist/index.js';

// STA-58: bounded interactive aggregations, checked against an independent
// reference oracle computed in JavaScript from the data the tests wrote
// (exact decimals with BigInt, time zones with Intl), never from the index
// tables the implementation reads. The suite owns its database.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_aggregations_${randomUUID().replaceAll('-', '')}`;
const url = Object.assign(new URL(baseUrl), { pathname: `/${name}` }).toString();
const admin = async sql => {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
};
await admin(`CREATE DATABASE ${name}`);
const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
if (migrated.status !== 0) { await admin(`DROP DATABASE IF EXISTS ${name}`); throw new Error(migrated.stderr); }
const pool = new pg.Pool({ connectionString: url, max: 8 });
const extraPools = [];
const newPool = (max = 2) => { const created = new pg.Pool({ connectionString: url, max }); extraPools.push(created); return created; };
test.after(async () => { await Promise.all([pool, ...extraPools].map(item => item.end())); await admin(`DROP DATABASE IF EXISTS ${name}`); });

const config = { database: memoryAdapter(), namespace: `aggregations-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
// The fixture services configure no analytical pool, so they refuse every aggregation; analyticServices configure one.
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const analyticServices = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32),
  analytics: { pool: newPool(1), originConnectionLimit: 5 } }]]), 3600);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
// The direct adapter runs on an analytical pool of its own, as in production; `pool` is only its admission (interactive) pool.
const analyticalPool = newPool(6);
const aggregations = (cellPool = analyticalPool, originConnectionLimit = 5, options = {}) =>
  new PostgresAggregations(spaces, new Map([['cell-a', { pool: cellPool, admission: pool, originConnectionLimit }]]), options);
const rejects = (promise, code, check = () => {}) => assert.rejects(promise, error => {
  assert.equal(error.code, code, error.message); check(error); return true;
});
const limited = (promise, limit) => rejects(promise, limit === 'slots' ? 'BACKPRESSURE' : 'RATE_LIMITED', error => {
  assert.ok(error instanceof AggregationLimitError, error.message);
  assert.equal(error.limit, limit);
  assert.equal(error.retryable, limit === 'slots');
});

const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {
  team: { type: ['string', 'null'] }, score: { type: ['number', 'null'] }, active: { type: ['boolean', 'null'] },
  at: { type: ['string', 'null'], format: 'date-time' }, note: { type: 'string' } } };
const INDEXED = ['team', 'score', 'active', 'at'];

/** A space whose collections each index team, score, active and at (note is not indexed), all backfilled ready. */
async function fixture(collections = ['items']) {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of collections) {
    await services.collections.define(owner, spaceId, id, JSON.stringify({ slug: id, version: 1, schema, unique: [],
      filterable: INDEXED, sortable: ['score'] }));
    for (const field of INDEXED) await services.collections.backfill(owner, spaceId, id, field);
  }
  const ids = new Map();
  const write = async (collectionId, request) => {
    const receipt = await services.records.mutate(owner, spaceId, collectionId, JSON.stringify({ idempotencyKey: randomUUID(), ...request }));
    return receipt.ref.id;
  };
  const agent = async capabilities => {
    const key = await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000), [{ collectionId: collections[0], capabilities }]);
    return verify(key.secret);
  };
  return { spaceId, owner, ids, write, agent };
}

// ---- The reference oracle: plain JavaScript over the records as written. ----

/** A JS number's decimal (as `String` writes it, exponent included) as an exact scaled BigInt. */
function scaled(number) {
  const [mantissa, exponent = '0'] = String(number).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = mantissa.replace('-', '').split('.');
  let digits = BigInt(whole + fraction), scale = fraction.length - Number(exponent);
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  return { digits: negative ? -digits : digits, scale };
}
function addDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return { digits: a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale), scale };
}
function decimalText({ digits, scale }) {
  const negative = digits < 0n;
  let text = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  if (scale) text = `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  return negative && text !== '0' ? `-${text}` : text;
}
/** sum / count by long division, digit by digit, rounded half away from zero to 20 significant digits. */
function averageText(sum, count) {
  if (!count) return null;
  const negative = sum.digits < 0n;
  const numerator = negative ? -sum.digits : sum.digits;
  if (numerator === 0n) return '0';
  const denominator = BigInt(count) * 10n ** BigInt(sum.scale);
  const integer = numerator / denominator;
  let remainder = numerator % denominator;
  // The value is 0.<digits> x 10^exponent, digits starting at the first nonzero one.
  let digits = integer === 0n ? '' : integer.toString(), exponent = digits.length;
  while (digits.length < 21) {
    remainder *= 10n;
    const digit = remainder / denominator;
    remainder %= denominator;
    if (digits === '' && digit === 0n) { exponent--; continue; }
    digits += digit.toString();
  }
  let text = (BigInt(digits.slice(0, 20)) + (Number(digits[20]) >= 5 ? 1n : 0n)).toString();
  if (text.length > 20) { exponent++; text = text.slice(0, 20); }
  let out;
  if (exponent <= 0) out = `0.${'0'.repeat(-exponent)}${text}`;
  else if (exponent >= text.length) out = text + '0'.repeat(exponent - text.length);
  else out = `${text.slice(0, exponent)}.${text.slice(exponent)}`;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return negative ? `-${out}` : out;
}
/** An instant string compared by time: base seconds, then fraction as a decimal. */
function compareInstant(a, b) {
  const split = value => { const [base, fraction = ''] = value.slice(0, -1).split('.'); return [base, fraction]; };
  const [baseA, fractionA] = split(a), [baseB, fractionB] = split(b);
  if (baseA !== baseB) return baseA < baseB ? -1 : 1;
  const width = Math.max(fractionA.length, fractionB.length);
  const left = fractionA.padEnd(width, '0'), right = fractionB.padEnd(width, '0');
  return left === right ? 0 : left < right ? -1 : 1;
}
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** Local wall-clock parts of an epoch millisecond in an IANA zone, with its offset as ±HH:MM. */
function local(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' }).formatToParts(new Date(ms))
    .map(part => [part.type, part.value]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), offset };
}
const pad = (value, width = 2) => String(value).padStart(width, '0');
/** The bucket a stored instant falls in, as its local start label (with the offset for hour buckets, where it disambiguates). */
function bucketLabel(value, unit, timeZone) {
  // A leap second belongs to the minute it ends; the fraction never moves an instant into the next second.
  const ms = Date.parse(value.endsWith(':60Z') || /:60\./.test(value) ? `${value.slice(0, 17)}59.999Z` : value.replace(/(\.\d{3})\d+Z$/, '$1Z'));
  const at = local(ms, timeZone);
  if (unit === 'hour') return `${at.year}-${pad(at.month)}-${pad(at.day)}T${pad(at.hour)}:00:00${at.offset}`;
  let { year, month, day } = at;
  if (unit === 'week') {
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  }
  if (unit === 'month' || unit === 'quarter' || unit === 'year') day = 1;
  if (unit === 'quarter') month = Math.floor((month - 1) / 3) * 3 + 1;
  if (unit === 'year') month = 1;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T00:00:00`;
}
const keyRank = key => ({ value: 0, null: 1, missing: 2 })[key.kind];
const keyOf = (data, dimension) => {
  if (!Object.hasOwn(data, dimension.field)) return { kind: 'missing' };
  if (data[dimension.field] === null) return { kind: 'null' };
  const value = data[dimension.field];
  return { kind: 'value', value: dimension.bucket ? bucketLabel(value, dimension.bucket.unit, dimension.bucket.timeZone) : value };
};
function compareValue(a, b) {
  if (typeof a === 'number') return a - b;
  if (typeof a === 'boolean') return Number(a) - Number(b);
  return compareBytes(a, b);
}
const matches = (data, predicate) => {
  const present = Object.hasOwn(data, predicate.field) ? data[predicate.field] : undefined;
  if (predicate.operator === 'isNull') return present === null;
  if (present === undefined || present === null) return false;
  if (predicate.operator === 'in') return predicate.value.includes(present);
  const compare = compareValue(present, predicate.value);
  return { eq: compare === 0, lt: compare < 0, lte: compare <= 0, gt: compare > 0, gte: compare >= 0 }[predicate.operator];
};
/** The oracle's answer: groups (keys as plain values, bucket labels compared as described), counts and metrics. */
function oracle(records, spec) {
  const groups = new Map();
  for (const data of records.values()) {
    if (!(spec.where ?? []).every(predicate => matches(data, predicate))) continue;
    const key = (spec.groupBy ?? []).map(dimension => keyOf(data, dimension));
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id).rows.push(data);
  }
  if (!(spec.groupBy ?? []).length && !groups.size) groups.set('[]', { key: [], rows: [] });
  const sorted = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const rank = keyRank(a.key[i]) - keyRank(b.key[i]);
      if (rank) return rank;
      if (a.key[i].kind !== 'value') continue;
      const dimension = spec.groupBy[i];
      // Buckets are disjoint intervals, so any members order them by start.
      const order = dimension.bucket ? compareInstant(a.rows[0][dimension.field], b.rows[0][dimension.field])
        : compareValue(a.key[i].value, b.key[i].value);
      if (order) return order;
    }
    return 0;
  });
  return sorted.map(({ key, rows }) => ({ key, count: rows.length, metrics: spec.metrics.map(metric => {
    if (metric.op === 'count') return { value: rows.length, values: null, nulls: null, missing: null };
    const values = rows.filter(row => Object.hasOwn(row, metric.field) && row[metric.field] !== null).map(row => row[metric.field]);
    const counts = { values: values.length, nulls: rows.filter(row => row[metric.field] === null).length,
      missing: rows.filter(row => !Object.hasOwn(row, metric.field)).length };
    if (metric.op === 'sum' || metric.op === 'avg') {
      const sum = values.reduce((total, value) => addDecimal(total, scaled(value)), { digits: 0n, scale: 0 });
      return { value: metric.op === 'sum' ? decimalText(sum) : averageText(sum, values.length), ...counts };
    }
    let compare = compareBytes;
    if (typeof values[0] === 'number') compare = (a, b) => a - b;
    else if (metric.field === 'at') compare = compareInstant;
    const ordered = [...values].sort(compare);
    return { value: (metric.op === 'min' ? ordered[0] : ordered.at(-1)) ?? null, ...counts };
  }) }));
}

/** The result in the oracle's terms: a bucket key becomes its local label (with its offset for hour buckets). */
function comparable(result) {
  return result.groups.map(group => ({ key: group.key.map((key, i) => {
    const bucket = result.groupBy[i].bucket;
    if (key.kind !== 'value' || !bucket) return key;
    // The local label names the start instant at its offset.
    assert.equal(Date.parse(key.local), Date.parse(key.value), `${key.local} is ${key.value}`);
    return { kind: 'value', value: bucket.unit === 'hour' ? key.local : key.local.slice(0, 19) };
  }), count: group.count, metrics: group.metrics }));
}
const sameAsOracle = (result, records, spec, label) => {
  assert.deepEqual(comparable(result), oracle(records, spec), label ?? JSON.stringify(spec));
};

// Generic data with every edge: explicit nulls and missing fields, decimals whose float sum is inexact, huge and tiny
// magnitudes, instants around DST changes in several zones, a leap second, and fractions past microseconds.
const INSTANTS = ['2026-03-08T06:59:59.9999999Z', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00.25Z', '2026-11-01T05:30:00Z',
  '2026-11-01T06:30:00Z', '2026-11-01T04:59:59.999999Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:30:00Z',
  '2026-10-25T01:30:00Z', '2016-12-31T23:59:60Z', '2016-12-31T23:59:60.5Z', '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z',
  '2026-10-03T15:45:00Z', '2026-12-31T18:29:59Z', '2026-12-31T18:30:00Z', '2027-01-03T23:00:00Z', '2026-06-30T23:59:59.5Z'];
const SCORES = [0.1, 0.2, 0.3, 1, -2.5, 1e21, 5e-324, 123456789.123, -0.1, 7, 2 ** 53, 1e-7, 42];
function generic(seed = 7, count = 90) {
  let state = seed;
  const next = n => { state = (state * 1103515245 + 12345) % 2147483648; return state % n; };
  const pick = (values, absent = 2) => { const choice = next(values.length + absent); return choice < values.length ? values[choice] : choice === values.length ? null : undefined; };
  return Array.from({ length: count }, () => {
    const data = {};
    for (const [field, values] of [['team', ['red', 'blue', 'green', 'Ä', 'a']], ['score', SCORES], ['active', [true, false]],
      ['at', INSTANTS]]) {
      const value = pick(values);
      if (value !== undefined) data[field] = value;
    }
    if (next(3) === 0) data.note = 'unindexed';
    return data;
  });
}

test('aggregations equal the reference oracle over nulls, missing values, exact decimals and DST time buckets', async () => {
  const f = await fixture();
  const records = new Map();
  for (const data of generic()) records.set(await f.write('items', { operation: 'create', data }), data);
  // Replace, patch and delete some, so only live current revisions count.
  const ids = [...records.keys()];
  for (const id of ids.slice(0, 6)) {
    await f.write('items', { operation: 'delete', id, expectedRevision: 1 });
    records.delete(id);
  }
  for (const id of ids.slice(6, 12)) {
    const data = { team: 'blue', score: 0.7 };
    await f.write('items', { operation: 'replace', id, expectedRevision: 1, data });
    records.set(id, data);
  }
  for (const id of ids.slice(12, 16)) {
    const data = { ...records.get(id) };
    delete data.score;
    await f.write('items', { operation: 'patch', id, expectedRevision: 1, set: { team: null }, unset: ['score'] });
    records.set(id, { ...data, team: null });
  }
  const service = aggregations();
  const all = [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'avg', field: 'score' }, { op: 'min', field: 'score' },
    { op: 'max', field: 'score' }, { op: 'min', field: 'at' }, { op: 'max', field: 'at' }, { op: 'min', field: 'team' },
    { op: 'max', field: 'team' }];
  const specs = [
    { metrics: all },
    { groupBy: [{ field: 'team' }], metrics: all },
    { groupBy: [{ field: 'team' }, { field: 'active' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] },
    { groupBy: [{ field: 'score' }], metrics: [{ op: 'count' }, { op: 'max', field: 'at' }] },
    { where: [{ field: 'team', kind: 'string', operator: 'in', value: ['red', 'blue'] },
      { field: 'score', kind: 'number', operator: 'gte', value: 0 }], groupBy: [{ field: 'team' }], metrics: all },
    { where: [{ field: 'team', kind: 'null', operator: 'isNull' }], metrics: all },
    ...[['hour', 'America/New_York'], ['day', 'America/New_York'], ['day', 'Europe/Berlin'], ['week', 'Australia/Lord_Howe'],
      ['month', 'Pacific/Kiritimati'], ['quarter', 'UTC'], ['year', 'UTC'], ['hour', 'Asia/Kolkata'], ['hour', 'Australia/Lord_Howe'],
      ['day', 'UTC']].map(([unit, timeZone]) => ({ groupBy: [{ field: 'at', bucket: { unit, timeZone } }],
      metrics: [{ op: 'count' }, { op: 'avg', field: 'score' }, { op: 'min', field: 'at' }] })),
    { groupBy: [{ field: 'team' }, { field: 'at', bucket: { unit: 'day', timeZone: 'America/New_York' } }], metrics: [{ op: 'count' }],
      maxGroups: 1000 }
  ];
  for (const spec of specs) {
    const result = await service.aggregate(f.owner, f.spaceId, 'items', spec);
    sameAsOracle(result, records, spec);
    assert.equal(result.complete, true);
    assert.deepEqual(result.source, { spaceId: f.spaceId, collectionId: 'items', records: 'live', where: spec.where ?? [],
      policyVersion: 1, placementGeneration: 1 });
    assert.equal(result.collection.schemaVersion, 1);
    assert.equal(result.snapshot.scope, 'statement');
    assert.ok(Math.abs(Date.parse(result.snapshot.takenAt) - Date.now()) < 60_000);
    for (const metric of result.metrics) assert.equal(metric.semantics, metric.op === 'avg' ? 'derived' : 'exact');
    for (const dimension of result.groupBy) assert.equal(dimension.semantics, dimension.bucket ? 'derived' : 'exact');
  }
  // Spot checks the oracle shares with the contract: an exact decimal sum, an explicit null apart from a missing value.
  const exact = await service.aggregate(f.owner, f.spaceId, 'items', { where: [{ field: 'score', kind: 'number', operator: 'in',
    value: [0.1, 0.2] }], metrics: [{ op: 'sum', field: 'score' }] });
  const tenths = [...records.values()].filter(data => data.score === 0.1 || data.score === 0.2);
  assert.equal(exact.groups[0].metrics[0].value, decimalText(tenths.reduce((sum, data) => addDecimal(sum, scaled(data.score)), { digits: 0n, scale: 0 })));
  const byTeam = await service.aggregate(f.owner, f.spaceId, 'items', { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }] });
  assert.deepEqual(byTeam.groups.slice(-2).map(group => group.key[0].kind), ['null', 'missing']);
  // An empty selection: one group of zero without groupBy, no groups with it.
  const none = [{ field: 'team', kind: 'string', operator: 'eq', value: 'nobody' }];
  assert.deepEqual((await service.aggregate(f.owner, f.spaceId, 'items', { where: none, metrics: all })).groups,
    oracle(records, { where: none, metrics: all }));
  assert.deepEqual((await service.aggregate(f.owner, f.spaceId, 'items', { where: none, groupBy: [{ field: 'team' }],
    metrics: all })).groups, []);
});

test('the oracle and the service round averages the same way at the 20th significant digit', async () => {
  const f = await fixture();
  const records = new Map();
  // Thirds, a tie exactly half way at the 21st digit, huge and tiny magnitudes and a negative average.
  for (const [team, score] of [['third', 1], ['third', 0], ['third', 0], ['tie', 1], ['tie', 1e-20], ['small', 1e-20], ['small', 1.5e-20],
    ['huge', 1e21], ['huge', 2], ['huge', 2], ['tiny', 5e-324], ['tiny', 5e-324], ['tiny', 0], ['minus', -2], ['minus', -1], ['minus', 0]]) {
    const data = { team, score };
    records.set(await f.write('items', { operation: 'create', data }), data);
  }
  const spec = { groupBy: [{ field: 'team' }], metrics: [{ op: 'avg', field: 'score' }, { op: 'sum', field: 'score' }] };
  const result = await aggregations().aggregate(f.owner, f.spaceId, 'items', spec);
  sameAsOracle(result, records, spec);
  const average = Object.fromEntries(result.groups.map(group => [group.key[0].value, group.metrics[0].value]));
  assert.equal(average.third, '0.33333333333333333333');
  assert.equal(average.huge, '333333333333333333330');
  assert.equal(average.minus, '-1');
  assert.equal(average.tie, '0.50000000000000000001', '0.500000000000000000005 rounds away from zero');
  assert.equal(average.small, '0.0000000000000000000125');
  assert.equal(average.tiny, `0.${'0'.repeat(323)}33333333333333333333`);
});

test('a typed spec admits only declared ready index fields, allowlisted operators and AND-only predicates', async () => {
  const f = await fixture();
  await f.write('items', { operation: 'create', data: { team: 'red', score: 1, at: '2026-01-01T00:00:00Z', note: 'x' } });
  const service = aggregations();
  const run = request => service.aggregate(f.owner, f.spaceId, 'items', request);
  for (const request of [{}, { metrics: [] }, { metrics: [{ op: 'median', field: 'score' }] }, { metrics: [{ op: 'sum' }] },
    { metrics: [{ op: 'count', field: 'score' }] }, { metrics: [{ op: 'count' }], sql: 'SELECT 1' },
    { metrics: [{ op: 'count' }], where: { or: [] } },
    { metrics: [{ op: 'count' }], where: [{ field: 'team', kind: 'string', operator: 'or', value: 'red' }] },
    { metrics: [{ op: 'count' }], where: [{ field: 'team', kind: 'string', operator: 'eq', value: 'red', or: true }] },
    { metrics: Array.from({ length: 17 }, () => ({ op: 'count' })) },
    { metrics: [{ op: 'count' }], groupBy: [{ field: 'team' }, { field: 'team' }] },
    { metrics: [{ op: 'count' }], groupBy: Array.from({ length: 4 }, (_, i) => ({ field: `f${i}` })) },
    { metrics: [{ op: 'count' }], maxGroups: 0 }, { metrics: [{ op: 'count' }], maxGroups: 1001 },
    { metrics: [{ op: 'sum', field: 'team' }] }, { metrics: [{ op: 'avg', field: 'at' }] }, { metrics: [{ op: 'min', field: 'active' }] },
    { metrics: [{ op: 'count' }], groupBy: [{ field: 'at' }] },
    { metrics: [{ op: 'count' }], groupBy: [{ field: 'score', bucket: { unit: 'day', timeZone: 'UTC' } }] },
    { metrics: [{ op: 'count' }], groupBy: [{ field: 'at', bucket: { unit: 'second', timeZone: 'UTC' } }] },
    ...['+05:00', 'UTC+3', 'Mars/Olympus_Mons', "UTC'; DROP TABLE records; --", ''].map(timeZone =>
      ({ metrics: [{ op: 'count' }], groupBy: [{ field: 'at', bucket: { unit: 'day', timeZone } }] }))])
    await rejects(run(request), 'INVALID_ARGUMENT', error => assert.ok(error.message, JSON.stringify(request)));
  // Undeclared or unindexed fields, raw SQL among them, are schema conflicts: names are bound, never interpolated.
  for (const field of ['note', 'nothing', 'score) OR (1=1', 'r.canonical_data'])
    await rejects(run({ metrics: [{ op: 'max', field }] }), 'SCHEMA_CONFLICT');
  await rejects(run({ metrics: [{ op: 'count' }], where: [{ field: 'note', kind: 'string', operator: 'eq', value: 'x' }] }), 'SCHEMA_CONFLICT');
  // A pending index cannot be aggregated until it is backfilled.
  await pool.query(`UPDATE collection_index_declarations SET ready=false WHERE space_id=$1 AND field_name='score'`, [f.spaceId]);
  await rejects(run({ metrics: [{ op: 'sum', field: 'score' }] }), 'SCHEMA_CONFLICT');
  await pool.query(`UPDATE collection_index_declarations SET ready=true WHERE space_id=$1 AND field_name='score'`, [f.spaceId]);
  // Authorization comes first: a key needs records:read on the collection; nothing else is disclosed.
  const writer = await f.agent(['records:write']);
  await rejects(service.aggregate(writer, f.spaceId, 'items', { metrics: [{ op: 'count' }] }), 'FORBIDDEN');
  await rejects(service.aggregate(writer, f.spaceId, 'items', { bogus: true }), 'FORBIDDEN');
  const reader = await f.agent(['records:read']);
  assert.equal((await service.aggregate(reader, f.spaceId, 'items', { metrics: [{ op: 'count' }] })).groups[0].count, 1);
  await rejects(service.aggregate(reader, f.spaceId, 'missing', { metrics: [{ op: 'count' }] }), 'NOT_FOUND');
  // The application service composes the same aggregation from JSON text, parsed only after authorization.
  const serialized = spec => analyticServices.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify(spec));
  assert.equal((await serialized({ metrics: [{ op: 'count' }] })).groups[0].count, 1);
  assert.equal((await service.aggregateSerialized(reader, f.spaceId, 'items', JSON.stringify({ metrics: [{ op: 'count' }] })))
    .groups[0].count, 1);
  for (const text of ['{', 'null', '[]', JSON.stringify({ metrics: [{ op: 'count' }], sql: 'x' }), ' '.repeat(32_769), 42])
    await rejects(analyticServices.analysis.aggregate(f.owner, f.spaceId, 'items', text), 'INVALID_ARGUMENT');
  await rejects(analyticServices.analysis.aggregate(writer, f.spaceId, 'items', '{'), 'FORBIDDEN');
  // Without an analytical pool of its own a cell runs no aggregation at all, rather than borrow interactive capacity.
  await rejects(services.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify({ metrics: [{ op: 'count' }] })),
    'PROVIDER_UNAVAILABLE', error => assert.equal(error.retryable, false));
  assert.throws(() => postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32),
    analytics: { pool, originConnectionLimit: 5 } }]]), 3600), /analytical pool apart/);
  // The adapter itself refuses an analytical pool that is its admission pool, whoever composes it.
  assert.throws(() => new PostgresAggregations(spaces, new Map([['cell-a', { pool, admission: pool, originConnectionLimit: 5 }]])),
    /analytical pool apart/);
});

test('every predicate member is validated before it reaches a query, through both entrypoints', async () => {
  const f = await fixture();
  await f.write('items', { operation: 'create', data: { team: 'red', score: 1 } });
  const service = aggregations();
  const count = where => ({ metrics: [{ op: 'count' }], where });
  // Malformed fields are INVALID_ARGUMENT, never a schema conflict from a declaration lookup.
  for (const where of [[{ field: 42, kind: 'string', operator: 'eq', value: 'red' }],
    [{ field: {}, kind: 'string', operator: 'eq', value: 'red' }], [{ field: 'team', kind: 'text', operator: 'eq', value: 'red' }],
    [{ field: 'team', kind: 'string', operator: 'like', value: 'red' }], [{ field: 'team', kind: 'string', operator: 'eq', value: 1 }],
    [{ field: 'team', kind: 'null', operator: 'eq' }], [{ field: 'score', kind: 'number', operator: 'in', value: [1, '2'] }]]) {
    await rejects(service.aggregateSerialized(f.owner, f.spaceId, 'items', JSON.stringify(count(where))), 'INVALID_ARGUMENT');
    await rejects(service.aggregate(f.owner, f.spaceId, 'items', count(where)), 'INVALID_ARGUMENT');
    await rejects(analyticServices.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify(count(where))), 'INVALID_ARGUMENT');
  }
  // An object field with its own serialization hooks is refused before any of them runs.
  const ran = [];
  const hooked = { toPostgres: () => { ran.push('toPostgres'); return 'team'; }, toJSON: () => { ran.push('toJSON'); return 'team'; },
    toString: () => { ran.push('toString'); return 'team'; } };
  await rejects(service.aggregate(f.owner, f.spaceId, 'items', count([{ field: hooked, kind: 'string', operator: 'eq', value: 'red' }])),
    'INVALID_ARGUMENT');
  await rejects(service.aggregate(f.owner, f.spaceId, 'items', count([{ field: 'team', kind: 'string', operator: 'eq', value: hooked }])),
    'INVALID_ARGUMENT');
  assert.deepEqual(ran, []);
  // An operator is a primitive allowlisted string: inherited names, arrays and objects never reach a lookup or SQL text.
  for (const operator of ['constructor', 'toString', '__proto__', 'hasOwnProperty', ['eq'], {}]) {
    const where = [{ field: 'team', kind: 'string', operator, value: 'red' }];
    await rejects(service.aggregateSerialized(f.owner, f.spaceId, 'items', JSON.stringify(count(where))), 'INVALID_ARGUMENT');
    await rejects(analyticServices.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify(count(where))), 'INVALID_ARGUMENT');
    await rejects(analyticServices.records.count(f.owner, f.spaceId, 'items', JSON.stringify(where)), 'INVALID_ARGUMENT');
    await rejects(analyticServices.records.query(f.owner, f.spaceId, 'items', JSON.stringify({ predicates: where, limit: 10 })),
      'INVALID_ARGUMENT');
  }
  await rejects(analyticServices.records.count(f.owner, f.spaceId, 'items',
    JSON.stringify([{ field: 'team', kind: 'null', operator: 'constructor' }])), 'INVALID_ARGUMENT');
  const trapped = new Proxy({}, { get: (_, key) => { ran.push(`get ${String(key)}`); return undefined; },
    getPrototypeOf: () => { ran.push('getPrototypeOf'); return Object.prototype; } });
  for (const operator of [{ toString: () => { ran.push('toString'); return 'eq'; } },
    { [Symbol.toPrimitive]: () => { ran.push('toPrimitive'); return 'eq'; } }, trapped]) {
    await rejects(service.aggregate(f.owner, f.spaceId, 'items', count([{ field: 'team', kind: 'string', operator, value: 'red' }])),
      'INVALID_ARGUMENT');
  }
  assert.deepEqual(ran, []);
  assert.equal(await analyticServices.records.count(f.owner, f.spaceId, 'items',
    JSON.stringify([{ field: 'team', kind: 'string', operator: 'eq', value: 'red' }])), 1);
  // Only an absent maxGroups takes the default: null is refused through both entrypoints.
  await rejects(service.aggregate(f.owner, f.spaceId, 'items', { metrics: [{ op: 'count' }], maxGroups: null }), 'INVALID_ARGUMENT');
  await rejects(service.aggregateSerialized(f.owner, f.spaceId, 'items', JSON.stringify({ metrics: [{ op: 'count' }], maxGroups: null })),
    'INVALID_ARGUMENT');
  assert.equal((await service.aggregate(f.owner, f.spaceId, 'items', { metrics: [{ op: 'count' }] })).groups[0].count, 1);
});

test('a runtime without proxy detection aggregates serialized specs and refuses object specs', () => {
  const script = `import assert from 'node:assert/strict';
    import { types } from 'node:util';
    import pg from 'pg';
    types.isProxy = undefined;
    const { PostgresAggregations, PostgresSpaces, postgresServices } = await import('./packages/postgres/dist/index.js');
    const { url, owner, spaceId } = JSON.parse(process.env.STA58_TEST_CONTEXT);
    const interactive = new pg.Pool({ connectionString: url, max: 2 }), analytical = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const spaces = new PostgresSpaces(interactive, new Map([['cell-a', { pool: interactive, storageTargetId: 'target-a' }]]), 'cell-a',
        {}, { current: async () => true });
      const services = postgresServices(spaces, new Map([['cell-a', { pool: interactive, cursorSecret: new Uint8Array(32),
        analytics: { pool: analytical, originConnectionLimit: 5 } }]]), 3600);
      const spec = { where: [{ field: 'team', kind: 'string', operator: 'eq', value: 'red' }],
        groupBy: [{ field: 'at', bucket: { unit: 'day', timeZone: 'Europe/Paris' } }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] };
      const result = await services.analysis.aggregate(owner, spaceId, 'items', JSON.stringify(spec));
      assert.deepEqual(result.groups.map(group => [group.key[0].local, group.count, group.metrics[1].value]),
        [['2026-07-02T00:00:00+02:00', 1, '2']]);
      const direct = new PostgresAggregations(spaces, new Map([['cell-a', { pool: analytical, admission: interactive, originConnectionLimit: 5 }]]));
      await assert.rejects(direct.aggregate(owner, spaceId, 'items', spec), { code: 'INVALID_ARGUMENT' });
      assert.equal((await direct.aggregateSerialized(owner, spaceId, 'items', JSON.stringify(spec))).groups[0].count, 1);
    } finally { await Promise.all([interactive.end(), analytical.end()]); }
    process.stdout.write('closed');`;
  return (async () => {
    const f = await fixture();
    await f.write('items', { operation: 'create', data: { team: 'red', score: 2, at: '2026-07-01T22:30:00Z' } });
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8',
      env: { ...process.env, STA58_TEST_CONTEXT: JSON.stringify({ url, owner: f.owner, spaceId: f.spaceId }) } }), 'closed');
  })();
});

test('time buckets follow IANA zone rules, never a fixed-offset abbreviation of the same name', async () => {
  const f = await fixture();
  // A summer instant: an abbreviation's fixed winter offset would put it on another day (or hour) than the zone's own rules.
  const records = new Map();
  for (const at of ['2026-07-01T22:30:00Z', '2026-07-01T21:30:00Z', '2026-07-02T06:30:00Z', '2026-01-15T23:30:00Z']) {
    const data = { at };
    records.set(await f.write('items', { operation: 'create', data }), data);
  }
  const service = aggregations();
  const byDay = timeZone => ({ groupBy: [{ field: 'at', bucket: { unit: 'day', timeZone } }], metrics: [{ op: 'count' }] });
  for (const timeZone of ['Europe/Paris', 'Europe/Athens', 'Europe/Lisbon', 'America/Los_Angeles', 'Etc/UTC'])
    sameAsOracle(await service.aggregate(f.owner, f.spaceId, 'items', byDay(timeZone)), records, byDay(timeZone));
  const paris = await service.aggregate(f.owner, f.spaceId, 'items', byDay('Europe/Paris'));
  assert.deepEqual(paris.groups.map(group => group.key[0].local), ['2026-01-16T00:00:00+01:00', '2026-07-01T00:00:00+02:00',
    '2026-07-02T00:00:00+02:00']);
  // CET, EET, MET, WET and PST are also PostgreSQL abbreviations with fixed offsets: refused, never bucketed at those offsets.
  for (const timeZone of ['CET', 'EET', 'MET', 'WET', 'PST', 'cet', 'EST', 'MST', 'HST'])
    await rejects(service.aggregate(f.owner, f.spaceId, 'items', byDay(timeZone)), 'INVALID_ARGUMENT',
      error => assert.match(error.message, /abbreviation/, timeZone));
  await rejects(service.aggregateSerialized(f.owner, f.spaceId, 'items', JSON.stringify(byDay('CET'))), 'INVALID_ARGUMENT');
  // Names of UTC itself run as Etc/UTC, and the result reports the zone it used.
  for (const timeZone of ['UTC', 'utc', 'GMT', 'Zulu', 'UCT']) {
    const result = await service.aggregate(f.owner, f.spaceId, 'items', byDay(timeZone));
    assert.deepEqual(result.groupBy[0].bucket, { unit: 'day', timeZone: 'Etc/UTC' });
    sameAsOracle(result, records, byDay('Etc/UTC'));
  }
});

test('bucket starts and local labels agree in proleptic ISO years at both ends of the instant range', async () => {
  const f = await fixture();
  for (const at of ['0001-01-01T00:30:00Z', '0001-01-01T03:00:00Z', '9999-12-31T12:00:00Z'])
    await f.write('items', { operation: 'create', data: { at } });
  const service = aggregations();
  const keys = async (unit, timeZone) => (await service.aggregate(f.owner, f.spaceId, 'items',
    { groupBy: [{ field: 'at', bucket: { unit, timeZone } }], metrics: [{ op: 'count' }] })).groups.map(group => [group.key[0], group.count]);
  // A label minus its offset is its start: parse both by their own fields, years 0000 and +010000 included.
  const seconds = text => {
    const [, year, rest, zone] = /^([+-]\d{6}|\d{4})(-.+?)(Z|[+-]\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
    const [sign, h, m, s = '0'] = zone === 'Z' ? ['+', '0', '0'] : [zone[0], ...zone.slice(1).split(':')];
    const date = new Date(`2000${rest}Z`);
    date.setUTCFullYear(Number(year));
    return date.getTime() / 1000 - (sign === '-' ? -1 : 1) * (Number(h) * 3600 + Number(m) * 60 + Number(s));
  };
  const agree = list => { for (const [key] of list) assert.equal(seconds(key.local), seconds(key.value), JSON.stringify(key)); };
  // East of UTC, the first instant's local day starts in 1 BC: year 0000, never 0001-12-31.
  const east = await keys('day', 'Etc/GMT-1');
  assert.deepEqual(east, [[{ kind: 'value', value: '0000-12-31T23:00:00Z', local: '0001-01-01T00:00:00+01:00' }, 2],
    [{ kind: 'value', value: '9999-12-30T23:00:00Z', local: '9999-12-31T00:00:00+01:00' }, 1]]);
  // West of UTC, at New York's local mean time, the first two instants' local year is 1 BC.
  const west = await keys('year', 'America/New_York');
  assert.deepEqual(west, [[{ kind: 'value', value: '0000-01-01T04:56:02Z', local: '0000-01-01T00:00:00-04:56:02' }, 2],
    [{ kind: 'value', value: '9999-01-01T05:00:00Z', local: '9999-01-01T00:00:00-05:00' }, 1]]);
  // At +14, the last instant's local day is in year 10000, written expanded; its start is still in 9999 UTC.
  const kiritimati = await keys('day', 'Pacific/Kiritimati');
  assert.deepEqual(kiritimati.at(-1), [{ kind: 'value', value: '9999-12-31T10:00:00Z', local: '+010000-01-01T00:00:00+14:00' }, 1]);
  for (const list of [east, west, kiritimati, await keys('hour', 'Pacific/Kiritimati'), await keys('week', 'Etc/GMT-1')]) agree(list);
});

/** Insert `count` records into `collectionId` of `spaceId` directly, with their index values, in one transaction. */
async function bulk(spaceId, count, team = n => `team-${n % 7}`, collectionId = 'bulk', score = n => n + 1) {
  const teams = Array.from({ length: count }, (_, n) => team(n)), scores = Array.from({ length: count }, (_, n) => score(n));
  // One transaction: the deferred projection check requires every record's index values at commit. Fresh statistics
  // keep the per-row foreign key and projection checks on their indexes.
  const db = await pool.connect();
  try {
  await db.query('BEGIN');
  await db.query(`INSERT INTO records(space_id,collection_id,record_id,revision,schema_version,key_mode,normalized_key,canonical_data,data)
    SELECT $1,$3,r.id,1,1,'generated',r.id,json_build_object('score',r.s,'team',r.team)::text,jsonb_build_object('score',r.s,'team',r.team)
    FROM (SELECT 'rec_'||lpad(n::text,8,'0') AS id,s,t AS team FROM unnest($2::text[],$4::numeric[]) WITH ORDINALITY u(t,s,n)) r`,
  [spaceId, teams, collectionId, scores]);
  await db.query('ANALYZE records');
  await db.query(`INSERT INTO record_index_values(space_id,collection_id,record_id,field_name,value_kind,string_value,number_value,boolean_value,time_value)
    SELECT $1,$3,'rec_'||lpad(n::text,8,'0'),f.field,
      CASE f.field WHEN 'team' THEN 'string' WHEN 'score' THEN 'number' ELSE 'missing' END,
      CASE WHEN f.field='team' THEN t END, CASE WHEN f.field='score' THEN s END, NULL, NULL
    FROM unnest($2::text[],$4::numeric[]) WITH ORDINALITY u(t,s,n) CROSS JOIN unnest(ARRAY['team','score','active','at']) f(field)`,
  [spaceId, teams, collectionId, scores]);
  await db.query('ANALYZE record_index_values');
  await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}

test('over-cardinality, over-byte and over-time aggregations fail with typed errors and never return partial results', async () => {
  const f = await fixture(['items', 'bulk', 'large', 'counts', 'thirds']);
  for (let n = 0; n < 5; n++) await f.write('items', { operation: 'create', data: { team: `t${n}`, score: n } });
  const service = aggregations();
  await limited(service.aggregate(f.owner, f.spaceId, 'items', { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }], maxGroups: 4 }),
    'groups');
  assert.equal((await service.aggregate(f.owner, f.spaceId, 'items', { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }],
    maxGroups: 5 })).groups.length, 5, 'exactly at the cap is complete');
  // 600 distinct 500-byte keys are within the group cap but past the 256 KiB byte cap.
  await bulk(f.spaceId, 600, n => `${String(n).padStart(4, '0')}${'x'.repeat(496)}`);
  await limited(service.aggregate(f.owner, f.spaceId, 'bulk', { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }], maxGroups: 1000 }),
    'bytes');
  const fits = await service.aggregate(f.owner, f.spaceId, 'bulk', { where: [{ field: 'score', kind: 'number', operator: 'lte', value: 400 }],
    groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }], maxGroups: 1000 });
  assert.equal(fits.groups.length, 400);
  assert.ok(Buffer.byteLength(JSON.stringify(fits.groups)) <= aggregationBounds.resultBytes);
  // Every returned value counts: 16 counts over 1,000 short keys pass the cap only through their metrics.
  await bulk(f.spaceId, 1000, n => `k${n}`, 'counts');
  const counts = { groupBy: [{ field: 'team' }], metrics: Array.from({ length: 16 }, () => ({ op: 'count' })), maxGroups: 1000 };
  await limited(service.aggregate(f.owner, f.spaceId, 'counts', counts), 'bytes');
  assert.equal((await service.aggregate(f.owner, f.spaceId, 'counts', { ...counts, metrics: [{ op: 'count' }] })).groups.length, 1000);
  // Averages are sized as returned: 300 groups of [1, 0, 0] fit as 16 sums of "1" but not as 16 averages of 0.333...
  await bulk(f.spaceId, 900, n => `g${String(Math.floor(n / 3)).padStart(3, '0')}`, 'thirds', n => (n % 3 === 0 ? 1 : 0));
  const thirds = op => ({ groupBy: [{ field: 'team' }], metrics: Array.from({ length: 16 }, () => ({ op, field: 'score' })), maxGroups: 1000 });
  const sums = await service.aggregate(f.owner, f.spaceId, 'thirds', thirds('sum'));
  assert.equal(sums.groups.length, 300);
  assert.ok(sums.groups.every(group => group.metrics.every(metric => metric.value === '1')));
  assert.ok(Buffer.byteLength(JSON.stringify(sums.groups)) <= aggregationBounds.resultBytes);
  await limited(service.aggregate(f.owner, f.spaceId, 'thirds', thirds('avg')), 'bytes');
  await limited(analyticServices.analysis.aggregate(f.owner, f.spaceId, 'thirds', JSON.stringify(thirds('avg'))), 'bytes');
  // The statement budget cancels a long aggregation.
  await bulk(f.spaceId, 60_000, undefined, 'large');
  const slow = aggregations(analyticalPool, 5, { statementTimeoutMs: 5 });
  await limited(slow.aggregate(f.owner, f.spaceId, 'large', { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] }),
    'time');
  // Nothing stays held: the same service answers next, within the default budget.
  const answered = await service.aggregate(f.owner, f.spaceId, 'large', { metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] });
  assert.deepEqual(answered.groups[0].metrics.map(metric => metric.value), [60_000, String(60_000 * 60_001 / 2)]);
  assert.throws(() => aggregations(analyticalPool, 5, { statementTimeoutMs: 0 }), RangeError);
  assert.throws(() => aggregations(analyticalPool, 4), RangeError);
});

/** Every gate a test opened, released after it so a failed assertion reports instead of holding a session forever. */
const gates = [];
test.afterEach(() => { for (const release of gates.splice(0)) release(); });
/** A pool whose sessions pause, once each `pause()`, right after the aggregation takes its slots. */
function pausingPool(base) {
  const waiting = [];
  return { pool: { connect: async () => {
    const client = await base.connect();
    return new Proxy(client, { get(target, property) {
      if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
      return async (...args) => {
        const result = await target.query(...args);
        // Only an attempt that took both slots pauses; one that must first add slots retries and pauses then.
        const took = result.rows?.[0]?.cell_slot != null && result.rows[0].space_slot != null;
        if (typeof args[0] === 'string' && args[0].includes('AS space_slot') && took && waiting.length) {
          const gate = waiting.shift();
          gate.reached();
          await gate.released;
        }
        return result;
      };
    } });
  } }, pause() {
    let reached, release;
    const gate = { reached: null, released: new Promise(resolve => { release = resolve; }) };
    const arrived = new Promise(resolve => { reached = resolve; });
    gate.reached = reached;
    waiting.push(gate);
    gates.push(release);
    return { arrived, release };
  } };
}

test('analytical slots bound aggregations per process, per cell and per space, apart from interactive reads', async () => {
  assert.deepEqual([5, 9, 10, 15, 20].map(analyticalSlots), [{ cell: 1, space: 1 }, { cell: 1, space: 1 }, { cell: 2, space: 1 },
    { cell: 3, space: 1 }, { cell: 4, space: 2 }]);
  const f = await fixture();
  const g = await fixture();
  for (const space of [f, g]) await space.write('items', { operation: 'create', data: { team: 'red', score: 1 } });
  const count = { metrics: [{ op: 'count' }] };

  // In process: the second aggregation is refused before it takes a connection.
  const writer = await f.agent(['records:write']);
  const counted = { connects: 0 };
  const paused = pausingPool(analyticalPool);
  const one = aggregations({ connect: () => { counted.connects++; return paused.pool.connect(); } }, 5);
  const hold = paused.pause();
  const first = one.aggregate(f.owner, f.spaceId, 'items', count);
  await hold.arrived;
  const connected = counted.connects;
  await limited(one.aggregate(g.owner, g.spaceId, 'items', count), 'slots');
  assert.equal(counted.connects, connected, 'refused without connecting');
  // Authorization comes before capacity: with the slot held, a key without records:read and an unknown collection are refused as
  // such, not told to retry, and take no analytical connection.
  await rejects(one.aggregate(writer, f.spaceId, 'items', count), 'FORBIDDEN');
  await rejects(one.aggregateSerialized(writer, f.spaceId, 'items', '{'), 'FORBIDDEN');
  await rejects(one.aggregate(f.owner, f.spaceId, 'nothing', count), 'NOT_FOUND');
  assert.equal(counted.connects, connected, 'refusals took no analytical connection');
  // Across processes: another service (another isolate) finds the cell's only slot locked and is refused at once.
  const other = aggregations(analyticalPool, 5);
  await limited(other.aggregate(g.owner, g.spaceId, 'items', count), 'slots');
  // Interactive authoritative reads are untouched by the held analytical slot.
  assert.equal(await services.records.count(g.owner, g.spaceId, 'items', JSON.stringify([])), 1);
  hold.release();
  assert.equal((await first).groups[0].count, 1);
  assert.equal((await other.aggregate(g.owner, g.spaceId, 'items', count)).groups[0].count, 1, 'the slot is free after commit');

  // At an origin limit of 20 a cell has 4 slots and a space 2: a third aggregation in one space waits for its space, not the cell.
  const wide = pausingPool(analyticalPool);
  const service = aggregations(wide.pool, 20);
  const holds = [wide.pause(), wide.pause()];
  const running = [service.aggregate(f.owner, f.spaceId, 'items', count), service.aggregate(f.owner, f.spaceId, 'items', count)];
  await Promise.all(holds.map(item => item.arrived));
  await limited(service.aggregate(f.owner, f.spaceId, 'items', count), 'slots');
  assert.equal((await service.aggregate(g.owner, g.spaceId, 'items', count)).groups[0].count, 1, 'another space still has slots');
  for (const item of holds) item.release();
  for (const result of await Promise.all(running)) assert.equal(result.groups[0].count, 1);
  // Slots were added for the cell and both spaces only up to the derived limits.
  const slots = (await pool.query(`SELECT (SELECT count(*)::int FROM analysis_cell_slots WHERE cell_id='cell-a') AS cell,
    (SELECT count(*)::int FROM analysis_space_slots WHERE space_id=$1) AS space`, [f.spaceId])).rows[0];
  assert.deepEqual(slots, { cell: 4, space: 2 });
  // With every slot held, a refusal waits for none.
  const gate = pausingPool(analyticalPool);
  const only = aggregations(gate.pool, 5);
  const blocked = gate.pause();
  const holding = only.aggregate(f.owner, f.spaceId, 'items', count);
  await blocked.arrived;
  const started = performance.now();
  await limited(aggregations(analyticalPool, 5).aggregate(g.owner, g.spaceId, 'items', count), 'slots');
  assert.ok(performance.now() - started < 1_000, 'a refusal never waits for a slot');
  blocked.release();
  await holding;
});

test('interactive reads stay within their budget while analytical load saturates its slots', async t => {
  const f = await fixture(['items', 'bulk']);
  const ids = [];
  for (let n = 0; n < 5; n++) ids.push(await f.write('items', { operation: 'create', data: { team: 'red', score: n } }));
  await bulk(f.spaceId, 60_000);
  // Two isolates' application services as composed in production: each has a constrained interactive pool of 2 connections and
  // an analytical pool of its own. The interactive reads below go through the first isolate's services and its interactive pool.
  const isolate = () => {
    const interactive = newPool(2);
    const own = new PostgresSpaces(interactive, new Map([['cell-a', { pool: interactive, storageTargetId: 'target-a' }]]), 'cell-a',
      new AuthFnAgentKeys(config), identity, randomBytes(32));
    return postgresServices(own, new Map([['cell-a', { pool: interactive, cursorSecret: randomBytes(32),
      analytics: { pool: newPool(1), originConnectionLimit: 5 } }]]), 3600);
  };
  const isolates = [isolate(), isolate()];
  const heavy = JSON.stringify({ groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'avg', field: 'score' },
    { op: 'max', field: 'team' }] });
  let stop = false, peak = 0;
  const outcomes = { ok: 0, refused: 0 };
  const load = isolates.flatMap(composed => Array.from({ length: 6 }, async () => {
    while (!stop) {
      try {
        const result = await composed.analysis.aggregate(f.owner, f.spaceId, 'bulk', heavy);
        assert.equal(result.groups.reduce((sum, group) => sum + group.count, 0), 60_000);
        outcomes.ok++;
      } catch (error) {
        assert.ok(error instanceof AggregationLimitError && error.limit === 'slots', error.message);
        outcomes.refused++;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
  }));
  const watch = (async () => {
    while (!stop) {
      const running = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND backend_type='client backend' AND state='active' AND query LIKE 'WITH grouped AS%'`)).rows[0].n;
      const workers = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND backend_type<>'client backend' AND query LIKE 'WITH grouped AS%'`)).rows[0].n;
      assert.equal(workers, 0, 'an aggregation uses no parallel workers');
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  })();
  const latencies = [];
  const budgetMs = 1_000;
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    const started = performance.now();
    await Promise.all([
      isolates[0].records.count(f.owner, f.spaceId, 'items', JSON.stringify([{ field: 'team', kind: 'string', operator: 'eq', value: 'red' }]))
        .then(total => assert.equal(total, 5)),
      isolates[0].records.get(f.owner, f.spaceId, 'items', ids[0]).then(record => assert.equal(record.ref.id, ids[0]))]);
    latencies.push(performance.now() - started);
  }
  stop = true;
  await Promise.all([...load, watch]);
  assert.ok(outcomes.ok >= 2 && outcomes.refused > 0, JSON.stringify(outcomes));
  assert.ok(peak <= analyticalSlots(5).cell, `at most the cell's analytical slots ran at once (saw ${peak})`);
  latencies.sort((a, b) => a - b);
  t.diagnostic(`aggregations ${outcomes.ok} answered, ${outcomes.refused} refused; peak ${peak} running; ${latencies.length} interactive `
    + `read pairs, median ${latencies[latencies.length >> 1].toFixed(1)} ms, max ${latencies.at(-1).toFixed(1)} ms`);
  assert.ok(latencies.length >= 10, `interactive reads kept flowing (${latencies.length})`);
  assert.ok(latencies.at(-1) < budgetMs, `every interactive read pair finished within ${budgetMs} ms (max ${latencies.at(-1).toFixed(1)} ms)`);
});

test('aggregations read one statement snapshot while writes commit concurrently', async () => {
  const f = await fixture();
  const state = new Map();
  for (let n = 0; n < 24; n++) {
    const data = { team: ['red', 'blue', 'green'][n % 3], score: n / 10, ...(n % 4 ? { active: n % 2 === 0 } : {}) };
    state.set(await f.write('items', { operation: 'create', data }), data);
  }
  const revisions = new Map([...state.keys()].map(id => [id, 1]));
  // One writer: each committed write appends the whole resulting state, so every snapshot is one of these states.
  const states = [new Map(state)];
  let inflight = null, done = false, failed = false;
  const writer = (async () => {
    let seed = 1;
    for (let step = 0; step < 120 && !failed; step++) {
      seed = (seed * 48271) % 2147483647;
      const current = new Map(states.at(-1));
      const ids = [...current.keys()];
      const id = ids[seed % ids.length];
      if (step % 10 === 9) {
        const data = { team: 'new', score: step };
        // The new record's id is known only once its write returns; the oracle reads content, never ids.
        inflight = new Map(current).set('pending', data);
        const created = await f.write('items', { operation: 'create', data });
        current.set(created, data);
        revisions.set(created, 1);
      } else if (step % 10 === 5) {
        current.delete(id);
        inflight = current;
        await f.write('items', { operation: 'delete', id, expectedRevision: revisions.get(id) });
      } else {
        const data = { team: ['red', 'blue', 'green', null][seed % 4], score: (seed % 1000) / 7, active: seed % 3 === 0 };
        current.set(id, data);
        inflight = current;
        await f.write('items', { operation: 'replace', id, expectedRevision: revisions.get(id), data });
        revisions.set(id, revisions.get(id) + 1);
      }
      states.push(current);
      inflight = null;
    }
    done = true;
  })();
  const spec = { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'avg', field: 'score' },
    { op: 'min', field: 'score' }, { op: 'max', field: 'score' }, { op: 'max', field: 'team' }] };
  const service = aggregations(analyticalPool, 20);
  let checked = 0;
  try {
  while (!done) {
    const from = states.length - 1;
    const result = await service.aggregate(f.owner, f.spaceId, 'items', spec);
    const candidates = [...states.slice(from), ...(inflight ? [inflight] : [])];
    const answer = JSON.stringify(comparable(result));
    assert.ok(candidates.some(candidate => JSON.stringify(oracle(candidate, spec)) === answer),
      `aggregation ${checked} matched no committed state among ${candidates.length}`);
    checked++;
  }
  } catch (error) { failed = true; throw error; } finally { await writer.catch(() => {}); }
  assert.ok(checked >= 10, `${checked} aggregations ran during the writes`);
  sameAsOracle(await service.aggregate(f.owner, f.spaceId, 'items', spec), states.at(-1), spec);
});

test('a space suspended before its slots are added is refused with a typed authority error', async () => {
  const f = await fixture();
  await f.write('items', { operation: 'create', data: { team: 'red' } });
  // The first attempt finds no slot rows for the new space; the space is suspended just before the provisioning transaction.
  let connects = 0;
  const service = aggregations({ connect: async () => {
    if (++connects === 2) await spaces.suspend(f.owner, f.spaceId);
    return analyticalPool.connect();
  } });
  await assert.rejects(service.aggregate(f.owner, f.spaceId, 'items', { metrics: [{ op: 'count' }] }), error => {
    assert.equal(error.name, 'AuthorityError', `${error.name}: ${error.message}`);
    // Suspension advances the space's policy version, so the stale scope is refused before its lifecycle is read.
    assert.deepEqual([error.code, error.message], ['FORBIDDEN', 'Policy or placement changed']);
    return true;
  });
  assert.equal(connects, 2, 'refused in the provisioning transaction');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analysis_space_slots WHERE space_id=$1', [f.spaceId])).rows[0].n, 0);
});

test('bounds are the documented protective values', () => {
  assert.deepEqual({ ...aggregationBounds }, { groupBy: 3, metrics: 16, maxGroups: 1_000, defaultMaxGroups: 100, resultBytes: 262_144,
    statementMs: 5_000, maxStatementMs: 15_000, averageDigits: 20, specBytes: 32_768 });
});

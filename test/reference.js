// Contract oracle only: synchronous single-process model, NOT a production repository.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';

export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ContractError(code); };
const clone = value => structuredClone(value);
// Never assign into an empty array through an inherited numeric setter.
const appendOwn = (array, value) => Object.defineProperty(array, array.length,
  { value, enumerable: true, writable: true, configurable: true });
// Indexed scans below are intentional: S4138's for-of rewrite would invoke
// a mutable inherited iterator after input validation and change decisions.
const someOwn = (array, predicate) => {
  for (let index = 0; index < array.length; index++) { // NOSONAR
    if (predicate(Object.getOwnPropertyDescriptor(array, index).value, index)) return true;
  }
  return false;
};
const includesOwn = (array, value) => someOwn(array, item => item === value);
const hasDuplicateOwn = array => {
  const seen = new Set();
  for (let index = 0; index < array.length; index++) { // NOSONAR
    const item = Object.getOwnPropertyDescriptor(array, index).value;
    if (seen.has(item)) return true;
    seen.add(item);
  }
  return false;
};
const sortIntrinsic = Array.prototype.sort;
// Canonical object-key ordering is UTF-8 byte order, independent of host locale/ICU.
const stableArray = value => {
  let items = '';
  for (let index = 0; index < value.length; index++) { // NOSONAR
    if (index) items += ',';
    items += stable(Object.getOwnPropertyDescriptor(value, index)?.value) ?? 'null';
  }
  return `[${items}]`;
};
const stableObject = value => {
  const keys = Object.keys(value);
  Reflect.apply(sortIntrinsic, keys, [(a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))]);
  let fields = '';
  for (let index = 0; index < keys.length; index++) { // NOSONAR
    const key = keys[index], item = Object.getOwnPropertyDescriptor(value, key).value;
    if (item === undefined) continue;
    if (fields) fields += ',';
    fields += `${JSON.stringify(key)}:${stable(item)}`;
  }
  return `{${fields}}`;
};
const stable = value => {
  if (Array.isArray(value)) return stableArray(value);
  if (value !== null && typeof value === 'object') return stableObject(value);
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
// A caller may change the inherited string method after the module loads.
// Capture its UTF-16-unit semantics for trimming, validation and length checks.
const stringCodeUnitAt = String.prototype.charCodeAt;
const codeUnitAt = (value, index) => Reflect.apply(stringCodeUnitAt, value, [index]);
const stringNormalize = String.prototype.normalize;
const normalizeNfc = value => Reflect.apply(stringNormalize, value, ['NFC']);
const stringSlice = String.prototype.slice;
const sliceString = (value, start, end) => Reflect.apply(stringSlice, value, [start, end]);
const stringStartsWith = String.prototype.startsWith;
const startsWithString = (value, prefix) => Reflect.apply(stringStartsWith, value, [prefix]);
const stringEndsWith = String.prototype.endsWith;
const endsWithString = (value, suffix) => Reflect.apply(stringEndsWith, value, [suffix]);
const stringPadEnd = String.prototype.padEnd;
const padEndString = (value, length, fill) => Reflect.apply(stringPadEnd, value, [length, fill]);
// RegExp.prototype.test delegates to the current exec method. Use the captured
// matcher for every contract decision, including cursor syntax checks.
const regexpExec = RegExp.prototype.exec;
const matchRegex = (pattern, value) => Reflect.apply(regexpExec, pattern, [value]);
// Date validation and synthetic timestamps must use the same trusted clock
// operations after callers have had a chance to change inherited methods.
const NativeDate = Date;
const dateUtc = Date.UTC;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const getTime = value => Reflect.apply(dateGetTime, value, []);
const toISOString = value => Reflect.apply(dateToISOString, value, []);
const syntheticTimestamp = sequence => toISOString(new NativeDate(Reflect.apply(dateUtc, NativeDate,
  [2020, 0, 1, 0, 0, 0, sequence])));
// Fixed Unicode White_Space set (not JS trim, which includes FEFF but excludes 0085).
const whitespace = new Set([0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
for (let code = 0x09; code <= 0x0d; code++) whitespace.add(code);
for (let code = 0x2000; code <= 0x200a; code++) whitespace.add(code);
const trimKey = value => {
  let start = 0;
  let end = value.length;
  // The fixed White_Space set consists entirely of BMP code points. Scan
  // actual UTF-16 units; String.prototype[Symbol.iterator] is mutable.
  while (start < end && whitespace.has(codeUnitAt(value, start))) start++;
  while (end > start && whitespace.has(codeUnitAt(value, end - 1))) end--;
  return sliceString(value, start, end);
};
// A lone UTF-16 surrogate has no Unicode scalar value and cannot encode as UTF-8.
const wellFormed = value => {
  for (let index = 0; index < value.length; index++) {
    const unit = codeUnitAt(value, index);
    if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = codeUnitAt(value, ++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    }
  }
  return true;
};
// Called only after wellFormed: a surrogate pair is one Unicode scalar.
const scalarLength = value => {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = codeUnitAt(value, index);
    if (unit >= 0xD800 && unit <= 0xDBFF) index++;
    count++;
  }
  return count;
};
const keyOf = key => {
  if (typeof key !== 'string' || !wellFormed(key)) fail('INVALID_ARGUMENT');
  const normalized = trimKey(normalizeNfc(key));
  if (!normalized) fail('INVALID_ARGUMENT');
  return normalized;
};
// Positive UTC leap seconds from IERS Leap_Second.dat (Bulletin 72, July 2026).
// The oracle pins this table; deployed validators must update it from IERS.
const leapDays = new Set([
  '1972-06-30', '1972-12-31', '1973-12-31', '1974-12-31', '1975-12-31',
  '1976-12-31', '1977-12-31', '1978-12-31', '1979-12-31', '1981-06-30',
  '1982-06-30', '1983-06-30', '1985-06-30', '1987-12-31', '1989-12-31',
  '1990-12-31', '1992-06-30', '1993-06-30', '1994-06-30', '1995-12-31',
  '1997-06-30', '1998-12-31', '2005-12-31', '2008-12-31', '2012-06-30',
  '2015-06-30', '2016-12-31'
]);
const utcInstant = value => {
  const match = matchRegex(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/, value);
  if (!match || startsWithString(match[1], '0000-')) fail('SCHEMA_INVALID');
  const leap = endsWithString(match[1], 'T23:59:60');
  if (endsWithString(match[1], ':60') && (!leap || !leapDays.has(sliceString(match[1], 0, 10)))) fail('SCHEMA_INVALID');
  const check = leap ? `${sliceString(match[1], 0, -2)}59` : match[1];
  const parsed = new NativeDate(`${check}Z`);
  if (!Number.isFinite(getTime(parsed)) || sliceString(toISOString(parsed), 0, 19) !== check) fail('SCHEMA_INVALID');
  let fraction = match[2] ?? '';
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === '0') end--;
  fraction = sliceString(fraction, 0, end);
  return match[1] + (fraction ? '.' + fraction : '') + 'Z';
};
// Stored schema nodes are cloned into ordinary objects; a later prototype
// change must never supply an optional keyword they did not declare.
const schemaProperties = schema => Object.hasOwn(schema, 'properties') ? schema.properties : {};
const dateTimeField = (schema, field) => Object.hasOwn(schemaProperties(schema)[field], 'format') &&
  schemaProperties(schema)[field].format === 'date-time';
const tupleOf = (data, paths, schema) => {
  let tuple = '';
  for (let index = 0; index < paths.length; index++) { // NOSONAR
    const path = Object.getOwnPropertyDescriptor(paths, index).value;
    const v = Object.hasOwn(data, path) ? data[path] : undefined;
    if (v === undefined || v === null) return null;
    if (!includesOwn(['string', 'number', 'boolean'], typeof v) || (typeof v === 'number' && !Number.isFinite(v))) fail('SCHEMA_INVALID');
    let value;
    if (dateTimeField(schema, path)) value = utcInstant(v);
    else if (typeof v === 'string') value = normalizeNfc(v); // reservation only; stored data is unchanged
    else value = JSON.stringify(v);
    tuple += `${typeof v}:${Buffer.byteLength(value)}:${value}`;
  }
  return tuple;
};
const allowedKeywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'format', 'description']);
const plainObject = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
// A receipt may only fingerprint JSON-compatible payloads. In particular, JSON
// serialization must not silently omit an object field or turn an array slot into null.
const validateJsonArray = (value, ancestors) => {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('SCHEMA_INVALID');
  for (let index = 0; index < value.length; index++) { // NOSONAR
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SCHEMA_INVALID');
    validateJsonPayload(descriptor.value, ancestors);
  }
};
const validateJsonObject = (value, ancestors) => {
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index++) { // NOSONAR
    const key = keys[index];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !wellFormed(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('SCHEMA_INVALID');
    validateJsonPayload(descriptor.value, ancestors);
  }
};
const validateJsonPayload = (value, ancestors = new Set()) => {
  // A transparent Proxy can impersonate plain JSON yet fail structuredClone
  // (or alias a committed receipt). Reject it before any reflective reads.
  if (types.isProxy(value)) fail('SCHEMA_INVALID');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && wellFormed(value)) return;
  if (!Array.isArray(value) && !plainObject(value)) fail('SCHEMA_INVALID');
  if (ancestors.has(value)) fail('SCHEMA_INVALID');
  ancestors.add(value);
  if (Array.isArray(value)) validateJsonArray(value, ancestors);
  else validateJsonObject(value, ancestors);
  ancestors.delete(value);
};
// Keyword arrays are JSON arrays, not sparse or decorated in-process arrays.
// Validate them before set comparisons, where holes or duplicates could disappear.
const schemaArrayMembers = (value, errorCode = 'SCHEMA_UNSUPPORTED') => {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1) fail(errorCode);
  const members = [];
  for (let index = 0; index < value.length; index++) { // NOSONAR
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(errorCode);
    appendOwn(members, descriptor.value);
  }
  return members;
};
const uniqueDescriptors = (uniques, scalarPath) => {
  const entries = [];
  const descriptors = schemaArrayMembers(uniques);
  for (let index = 0; index < descriptors.length; index++) { // NOSONAR
    const value = descriptors[index];
    if (types.isProxy(value) || !plainObject(value)) fail('SCHEMA_UNSUPPORTED');
    // Inspect own descriptors, never caller getters; retain only validated data.
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 2 || !includesOwn(keys, 'name') || !includesOwn(keys, 'paths') ||
      someOwn(keys, key => !fields[key].enumerable || !Object.hasOwn(fields[key], 'value'))) fail('SCHEMA_UNSUPPORTED');
    const name = fields.name.value;
    const paths = schemaArrayMembers(fields.paths.value);
    if (typeof name !== 'string' || !name || !wellFormed(name) || !paths.length ||
      hasDuplicateOwn(paths) || someOwn(paths, path => !scalarPath(path))) fail('SCHEMA_UNSUPPORTED');
    appendOwn(entries, { name, paths });
  }
  const names = new Set();
  for (let index = 0; index < entries.length; index++) { // NOSONAR
    if (names.has(entries[index].name)) fail('SCHEMA_UNSUPPORTED');
    names.add(entries[index].name);
  }
  return entries;
};
const definitionType = (s, root) => {
  if (!plainObject(s) || someOwn(Object.keys(s), name => !allowedKeywords.has(name))) fail('SCHEMA_UNSUPPORTED');
  if (root ? (!Object.hasOwn(s, '$schema') || s.$schema !== 'https://json-schema.org/draft/2020-12/schema') : Object.hasOwn(s, '$schema')) fail('SCHEMA_UNSUPPORTED');
  if (!Object.hasOwn(s, 'type')) fail('SCHEMA_UNSUPPORTED');
  const types = Array.isArray(s.type) ? schemaArrayMembers(s.type) : [s.type];
  if (root && s.type !== 'object') fail('SCHEMA_UNSUPPORTED');
  if ((Array.isArray(s.type) && types.length !== 2) || types.length === 0 || types.length > 2 ||
    (types.length === 2 && (types[0] === types[1] ||
    (types[0] !== 'null' && types[1] !== 'null') ||
    !includesOwn(['string', 'number', 'integer', 'boolean'], types[0] === 'null' ? types[1] : types[0]))) ||
    someOwn(types, t => !includesOwn(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'], t)) ||
    (types.length === 1 && types[0] === 'null')) fail('SCHEMA_UNSUPPORTED');
  return types[0] === 'null' ? types[1] : types[0];
};
const validateSizeBounds = s => {
  const bounds = [['minLength', 'maxLength'], ['minItems', 'maxItems']];
  for (let index = 0; index < bounds.length; index++) { // NOSONAR
    const min = bounds[index][0], max = bounds[index][1];
    for (let side = 0; side < 2; side++) {
      const key = bounds[index][side];
      if (s[key] !== undefined && (!Number.isInteger(s[key]) || s[key] < 0)) fail('SCHEMA_UNSUPPORTED');
    }
    if (s[min] !== undefined && s[max] !== undefined && s[min] > s[max]) fail('SCHEMA_UNSUPPORTED');
  }
};
const validateNumericBounds = s => {
  for (let index = 0; index < 2; index++) {
    const key = index === 0 ? 'minimum' : 'maximum';
    if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) fail('SCHEMA_UNSUPPORTED');
  }
  if (s.minimum !== undefined && s.maximum !== undefined && s.minimum > s.maximum) fail('SCHEMA_UNSUPPORTED');
};
const validateBounds = (s, type) => {
  if (s.description !== undefined && (typeof s.description !== 'string' || !wellFormed(s.description))) fail('SCHEMA_UNSUPPORTED');
  validateSizeBounds(s);
  validateNumericBounds(s);
  if (s.format !== undefined && (type !== 'string' || s.format !== 'date-time')) fail('SCHEMA_UNSUPPORTED');
  if (type !== 'string' && (s.minLength !== undefined || s.maxLength !== undefined)) fail('SCHEMA_UNSUPPORTED');
  if (!includesOwn(['number', 'integer'], type) && (s.minimum !== undefined || s.maximum !== undefined)) fail('SCHEMA_UNSUPPORTED');
};
const validateDefinitionStructure = (s, type) => {
  if (type === 'object') validateObjectDefinition(s);
  else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) fail('SCHEMA_UNSUPPORTED');
  if (type === 'array') validateDefinition(s.items, false);
  else if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) fail('SCHEMA_UNSUPPORTED');
};
const validateObjectDefinition = s => {
  if (s.additionalProperties !== false || (s.properties !== undefined && !plainObject(s.properties))) fail('SCHEMA_UNSUPPORTED');
  if (someOwn(Object.keys(s.properties ?? {}), name => !wellFormed(name))) fail('SCHEMA_UNSUPPORTED');
  const children = Object.values(s.properties ?? {});
  for (let index = 0; index < children.length; index++) validateDefinition(children[index], false); // NOSONAR
  if (s.required === undefined) return;
  const required = schemaArrayMembers(s.required);
  if (someOwn(required, k => typeof k !== 'string' || !Object.hasOwn(s.properties ?? {}, k)) ||
    hasDuplicateOwn(required)) fail('SCHEMA_UNSUPPORTED');
};
const validateEnumMember = (value, schema) => {
  try {
    validateJsonPayload(value);
    validateData(value, { ...schema, enum: undefined });
  } catch (error) {
    if (error instanceof ContractError && error.code === 'SCHEMA_INVALID') fail('SCHEMA_UNSUPPORTED');
    throw error;
  }
};
const validateDefinitionEnum = s => {
  if (s.enum !== undefined) {
    const members = schemaArrayMembers(s.enum);
    if (members.length === 0) fail('SCHEMA_UNSUPPORTED');
    const seen = new Set();
    for (let index = 0; index < members.length; index++) { // NOSONAR
      const value = members[index];
      validateEnumMember(value, s);
      const canonical = stable(value);
      if (seen.has(canonical)) fail('SCHEMA_UNSUPPORTED');
      seen.add(canonical);
    }
  }
};
const validateDefinition = (s, root = true) => {
  // Presence, not undefined-value comparison, determines whether a keyword was supplied.
  // Reject all non-JSON definition nodes before checking the supported keyword subset.
  try { validateJsonPayload(s); } catch (error) {
    if (error instanceof ContractError && error.code === 'SCHEMA_INVALID') fail('SCHEMA_UNSUPPORTED');
    throw error;
  }
  // Validation reads only the supplied keywords, never Object.prototype defaults.
  const node = Object.assign(Object.create(null), s);
  const type = definitionType(node, root);
  validateBounds(node, type);
  validateDefinitionStructure(node, type);
  validateDefinitionEnum(node);
};
const validateObject = (data, schema) => {
  if (!plainObject(data)) fail('SCHEMA_INVALID');
  const keys = Object.keys(data);
  for (let index = 0; index < keys.length; index++) { // NOSONAR
    const k = keys[index];
    if (!wellFormed(k) || !Object.hasOwn(schema.properties ?? {}, k)) fail('SCHEMA_INVALID');
    validateData(data[k], schema.properties[k]);
  }
  const required = schema.required ?? [];
  for (let index = 0; index < required.length; index++) if (!Object.hasOwn(data, required[index])) fail('SCHEMA_INVALID'); // NOSONAR
};
const validateStringScalar = (data, schema) => {
  if (!wellFormed(data)) fail('SCHEMA_INVALID');
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    const length = scalarLength(data);
    if ((schema.minLength !== undefined && length < schema.minLength) ||
      (schema.maxLength !== undefined && length > schema.maxLength)) fail('SCHEMA_INVALID');
  }
  if (schema.format === 'date-time') utcInstant(data);
};
const validateScalar = (data, schema, type) => {
  if (typeof data !== (type === 'integer' || type === 'number' ? 'number' : type)) fail('SCHEMA_INVALID');
  if (type === 'string') validateStringScalar(data, schema);
  if (type === 'integer' && !Number.isSafeInteger(data)) fail('SCHEMA_INVALID');
  if (typeof data === 'number' && (!Number.isFinite(data) || (schema.minimum !== undefined && data < schema.minimum) || (schema.maximum !== undefined && data > schema.maximum))) fail('SCHEMA_INVALID');
};
const validateArray = (data, schema) => {
  if (!Array.isArray(data) || (schema.minItems !== undefined && data.length < schema.minItems) || (schema.maxItems !== undefined && data.length > schema.maxItems)) fail('SCHEMA_INVALID');
  // JSON validation already checked dense own data slots. Never use a later
  // inherited iterator to decide which values satisfy the item schema.
  for (let index = 0; index < data.length; index++) { // NOSONAR
    validateData(Object.getOwnPropertyDescriptor(data, index).value, schema.items);
  }
};
const schemaType = schema => {
  if (!Array.isArray(schema.type)) return schema.type;
  return schema.type[0] === 'null' ? schema.type[1] : schema.type[0];
};
const validateEnumValue = (data, schema) => {
  if (!schema.enum) return;
  const value = stable(data);
  if (!someOwn(schema.enum, member => stable(member) === value)) fail('SCHEMA_INVALID');
};
const validateData = (data, schema) => {
  // Schema validation and enum checking never borrow optional keywords from a prototype.
  schema = Object.assign(Object.create(null), schema);
  if (data === null && !(Array.isArray(schema.type) ? includesOwn(schema.type, 'null') : schema.type === 'null')) fail('SCHEMA_INVALID');
  const type = schemaType(schema);
  if (data === null) { /* A nullable value must still satisfy enum below. */ }
  else if (type === 'object') validateObject(data, schema);
  else if (type === 'array') validateArray(data, schema);
  else validateScalar(data, schema, type);
  validateEnumValue(data, schema);
};
const mutationFields = new Set(['spaceId', 'credential', 'collection', 'operation', 'id', 'externalKey', 'data', 'set', 'unset',
  'expectedRevision', 'expectedSchemaVersion', 'idempotencyKey']);
// Authorization uses only own target fields; never invoke an inherited getter
// while locating the requested collection. The remaining envelope is checked
// after target authorization, before looking up or disclosing any receipt.
const mutationTarget = request => {
  // No target can be trusted from a Proxy: even descriptor reads can invoke
  // caller traps or throw before authorization and envelope validation.
  if (types.isProxy(request) || request === null || typeof request !== 'object') fail('INVALID_ARGUMENT');
  const target = Object.create(null);
  const keys = ['spaceId', 'credential', 'collection'];
  for (let index = 0; index < keys.length; index++) { // NOSONAR
    const key = keys[index];
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_ARGUMENT');
    target[key] = descriptor.value;
  }
  return target;
};
const mutationEnvelope = request => {
  if (!plainObject(request)) fail('INVALID_ARGUMENT');
  const fields = Object.create(null);
  const keys = Reflect.ownKeys(request);
  for (let index = 0; index < keys.length; index++) { // NOSONAR
    const key = keys[index];
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (typeof key !== 'string' || !mutationFields.has(key) || !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')) fail('INVALID_ARGUMENT');
    fields[key] = descriptor.value;
  }
  return fields;
};
const validateMutationInput = ({ operation, id, externalKey, expectedRevision, expectedSchemaVersion, idempotencyKey, supplied }) => {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey ||
    !includesOwn(['create', 'replace', 'patch', 'delete'], operation) || someOwn([...supplied], field => !mutationFields.has(field))) fail('INVALID_ARGUMENT');
  if (operation !== 'create' && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENT');
  if (operation !== 'create' && (typeof id !== 'string' || !id || !wellFormed(id))) fail('INVALID_ARGUMENT');
  if ((operation === 'create' && someOwn(['id', 'set', 'unset', 'expectedRevision'], field => supplied.has(field))) ||
    (operation === 'replace' && someOwn(['externalKey', 'set', 'unset'], field => supplied.has(field))) ||
    (operation === 'patch' && someOwn(['externalKey', 'data'], field => supplied.has(field))) ||
    (operation === 'delete' && someOwn(['externalKey', 'data', 'set', 'unset'], field => supplied.has(field)))) fail('INVALID_ARGUMENT');
  if (supplied.has('externalKey') && externalKey === undefined) fail('INVALID_ARGUMENT');
  if (supplied.has('expectedSchemaVersion') && (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 1)) fail('INVALID_ARGUMENT');
  return externalKey === undefined ? undefined : keyOf(externalKey);
};
const validatePatchShape = (set, unset) => {
  if (types.isProxy(set) || !plainObject(set) || types.isProxy(unset) || !Array.isArray(unset) || Object.getPrototypeOf(unset) !== Array.prototype ||
    Reflect.ownKeys(unset).length !== unset.length + 1) fail('INVALID_ARGUMENT');
  const paths = new Set();
  for (let index = 0; index < unset.length; index++) { // NOSONAR
    const descriptor = Object.getOwnPropertyDescriptor(unset, index);
    const path = descriptor?.value;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || typeof path !== 'string' || !wellFormed(path) ||
      paths.has(path) || Object.hasOwn(set, path)) fail('INVALID_ARGUMENT');
    paths.add(path);
  }
};
const validateFingerprintPayload = (operation, data, set, unset) => {
  if (operation === 'create' || operation === 'replace') validateJsonPayload(data);
  if (operation === 'patch') {
    validatePatchShape(set, unset);
    validateJsonPayload(set);
  }
};
const mutationData = (operation, data, set, unset, current, schema) => {
  if (operation === 'delete') return undefined;
  if (operation === 'create' || operation === 'replace') {
    if (data === undefined) fail('SCHEMA_INVALID');
    return clone(data);
  }
  const required = Object.hasOwn(schema, 'required') ? schema.required : [];
  const properties = schemaProperties(schema);
  if (someOwn(unset, k => !Object.hasOwn(properties, k) || includesOwn(required, k))) fail('INVALID_ARGUMENT');
  const next = { ...clone(current.data), ...clone(set) };
  for (let index = 0; index < unset.length; index++) delete next[unset[index]]; // NOSONAR
  return next;
};
const reservationsFor = (current, normalized, nextData, operation, c, recordId) => {
  const recordKey = current?.key ?? normalized ?? recordId;
  const wanted = current?.keyMode === 'external' || (!current && normalized !== undefined)
    ? [stable(['external', recordKey])] : [];
  if (operation !== 'delete') for (let index = 0; index < c.uniques.length; index++) { // NOSONAR
    const u = c.uniques[index];
    const tuple = tupleOf(nextData, u.paths, c.schema);
    if (tuple !== null) appendOwn(wanted, stable(['unique', u.name, tuple]));
  }
  for (let index = 0; index < wanted.length; index++) { // NOSONAR
    const reservation = wanted[index];
    const holder = c.reserved.get(reservation);
    if (holder && holder.id !== recordId) fail(holder.deleted ? 'KEY_RESERVED' : 'UNIQUE_CONFLICT');
  }
  return { wanted, recordKey };
};
const scalarCompare = (a, b) => {
  if (typeof a === 'string') return Buffer.compare(Buffer.from(a), Buffer.from(b));
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
const queryOrder = (sort, sortable) => {
  if (sort === undefined) return null;
  // A proxy can run caller traps during reflection, even when later rejected.
  if (!sort || typeof sort !== 'object' || types.isProxy(sort) || Array.isArray(sort) || !plainObject(sort)) fail('INVALID_ARGUMENT');
  const keys = Reflect.ownKeys(sort);
  if (keys.length !== 2 || !includesOwn(keys, 'field') || !includesOwn(keys, 'direction')) fail('INVALID_ARGUMENT');
  const field = Object.getOwnPropertyDescriptor(sort, 'field');
  const direction = Object.getOwnPropertyDescriptor(sort, 'direction');
  if (!field?.enumerable || !Object.hasOwn(field, 'value') ||
    !direction?.enumerable || !Object.hasOwn(direction, 'value')) fail('INVALID_ARGUMENT');
  const order = { field: field.value, direction: direction.value };
  if (!includesOwn(sortable, order.field) || !includesOwn(['asc', 'desc'], order.direction)) fail('INVALID_ARGUMENT');
  return order;
};
const sortTuple = (record, order, schema) => {
  if (!order) return { value: record.createdAt, id: record.id };
  const has = Object.hasOwn(record.data, order.field);
  // A missing optional field must not traverse Object.prototype (or run a getter).
  const value = has ? record.data[order.field] : undefined;
  let rank = 2;
  if (!has) rank = 0;
  else if (value === null) rank = 1;
  const sortableValue = rank === 2 && dateTimeField(schema, order.field) ? utcInstant(value) : value;
  return { rank, value: rank === 2 ? sortableValue : null, id: record.id };
};
const compareSortValues = (a, b, order, schema) => {
  if (!order || !dateTimeField(schema, order.field)) return scalarCompare(a, b);
  const whole = scalarCompare(sliceString(a, 0, 19), sliceString(b, 0, 19));
  if (whole) return whole;
  const fraction = value => {
    const digits = sliceString(value, 19, -1);
    return startsWithString(digits, '.') ? sliceString(digits, 1) : digits;
  };
  const left = fraction(a), right = fraction(b);
  return scalarCompare(padEndString(left, Math.max(left.length, right.length), '0'),
    padEndString(right, Math.max(left.length, right.length), '0'));
};
const compareTuples = (a, b, order, schema) => {
  let primary;
  if (!order) primary = scalarCompare(a.value, b.value);
  else if (a.rank !== b.rank) primary = a.rank < b.rank ? -1 : 1;
  else if (a.rank !== 2) primary = 0;
  else primary = compareSortValues(a.value, b.value, order, schema);
  if (primary) return order?.direction === 'desc' ? -primary : primary;
  return scalarCompare(a.id, b.id);
};

// Canonicalize only set-valued schema keywords; arrays inside enum members
// remain ordered data. All construction uses own slots, even under pollution.
const canonicalSchemaSet = members => {
  const byValue = new Map();
  for (let index = 0; index < members.length; index++) { // NOSONAR
    const member = Object.getOwnPropertyDescriptor(members, index).value;
    byValue.set(stable(member), member);
  }
  const entries = [];
  for (const entry of byValue) appendOwn(entries, entry);
  Reflect.apply(sortIntrinsic, entries, [(a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))]);
  const values = [];
  for (let index = 0; index < entries.length; index++) appendOwn(values, entries[index][1]); // NOSONAR
  return values;
};
const canonicalSchemaKeywords = value => {
  const keywords = Object.assign(Object.create(null), value);
  const setKeywords = ['required', 'type', 'enum'];
  for (let index = 0; index < setKeywords.length; index++) { // NOSONAR
    const keyword = setKeywords[index];
    if (Array.isArray(keywords[keyword])) keywords[keyword] = canonicalSchemaSet(keywords[keyword]);
  }
  return keywords;
};
const withoutDescription = value => {
  // Traverse schema nodes, not arbitrary object keys: "description" may itself be a property name.
  const { description, properties, items, ...rest } = Object.assign(Object.create(null), value);
  const keywords = canonicalSchemaKeywords(rest);
  if (properties !== undefined) {
    const children = Object.create(null);
    const names = Object.keys(properties);
    for (let index = 0; index < names.length; index++) { // NOSONAR
      const name = names[index];
      Object.defineProperty(children, name, { value: withoutDescription(properties[name]),
        enumerable: true, writable: true, configurable: true });
    }
    keywords.properties = children;
  }
  if (items !== undefined) keywords.items = withoutDescription(items);
  return keywords;
};
const compatibleSchemaAddition = (old, next) => {
  const oldProperties = schemaProperties(old);
  const nextProperties = schemaProperties(next);
  const oldNames = Object.keys(oldProperties);
  return stable(withoutDescription({ ...old, properties: {} })) ===
    stable(withoutDescription({ ...next, properties: {} })) &&
    !someOwn(oldNames, name => !Object.hasOwn(nextProperties, name) ||
      stable(withoutDescription(oldProperties[name])) !== stable(withoutDescription(nextProperties[name])));
};

export class ReferenceState {
  constructor() { this.spaces = new Map(); this.events = []; this.outbox = []; this.receipts = new Map(); this.seq = 0; this.generation = 1; this.projection = new Map(); this.cursorSecret = randomBytes(32); }
  #sign(value) { return createHmac('sha256', this.cursorSecret).update(stable(value)).digest('hex'); }
  addSpace(id, owner) { this.spaces.set(id, { owner, lifecycle: 'active', policyVersion: 1, collections: new Map(), grants: new Map() }); }
  grant(spaceId, credential, collection, permissions) {
    if (collection === '*') fail('INVALID_ARGUMENT');
    const capabilities = schemaArrayMembers(permissions, 'INVALID_ARGUMENT');
    if (someOwn(capabilities, p => !includesOwn(['records:read', 'records:write'], p))) fail('INVALID_ARGUMENT');
    const s = this.spaces.get(spaceId);
    if (!s.grants.has(credential)) s.grants.set(credential, new Map());
    const granted = new Set();
    for (let index = 0; index < capabilities.length; index++) granted.add(capabilities[index]); // NOSONAR
    s.grants.get(credential).set(collection, granted);
    s.policyVersion++;
  }
  revoke(spaceId, credential, collection) { const s = this.spaces.get(spaceId); if (collection === undefined) s.grants.delete(credential); else { s.grants.get(credential)?.delete(collection); if (!s.grants.get(credential)?.size) s.grants.delete(credential); } s.policyVersion++; }
  lifecycle(spaceId, state) { const s = this.spaces.get(spaceId); s.lifecycle = state; s.policyVersion++; }
  define(spaceId, slug, schema, uniques = [], sortable = []) {
    validateDefinition(schema);
    const scalarPath = path => {
      const properties = schemaProperties(schema);
      if (typeof path !== 'string' || !path || !wellFormed(path) || !Object.hasOwn(properties, path)) return false;
      const shape = properties[path];
      const type = schemaType(shape);
      return includesOwn(['string', 'number', 'integer', 'boolean'], type);
    };
    const uniqueEntries = uniqueDescriptors(uniques, scalarPath);
    const sortPaths = schemaArrayMembers(sortable);
    if (hasDuplicateOwn(sortPaths) || someOwn(sortPaths, path => !scalarPath(path))) fail('SCHEMA_UNSUPPORTED');
    const s = this.spaces.get(spaceId);
    if (s.collections.has(slug)) fail('SCHEMA_CONFLICT');
    s.collections.set(slug, { schema: clone(schema), uniques: uniqueEntries, sortable: sortPaths, records: new Map(), reserved: new Map(), version: 1 });
  }
  revise(spaceId, slug, expectedVersion, schema) {
    validateDefinition(schema);
    const c = this.spaces.get(spaceId)?.collections.get(slug);
    if (!c) fail('NOT_FOUND');
    if (c.version !== expectedVersion) fail('SCHEMA_CONFLICT');
    if (!compatibleSchemaAddition(c.schema, schema)) fail('SCHEMA_BREAKING');
    c.schema = clone(schema);
    c.version++;
    return c.version;
  }
  #access(spaceId, credential, collection, capability, replay = false) {
    const s = this.spaces.get(spaceId);
    if (!s) fail('NOT_FOUND');
    if (s.lifecycle === 'deleted') fail('NOT_FOUND');
    if (includesOwn(['suspended', 'deleting'], s.lifecycle) || (s.lifecycle === 'readOnly' && capability === 'records:write' && !replay)) fail('SPACE_UNAVAILABLE');
    const permissions = s.grants.get(credential)?.get(collection);
    if (!permissions?.has(capability)) fail('FORBIDDEN');
    const c = s.collections.get(collection);
    if (!c) fail('NOT_FOUND');
    return { s, c };
  }
  get({ spaceId, credential, collection, id }) {
    const { c } = this.#access(spaceId, credential, collection, 'records:read');
    const r = c.records.get(id);
    return r && !r.deleted ? clone(r) : null;
  }
  getByKey({ spaceId, credential, collection, mode, key }) {
    const { c } = this.#access(spaceId, credential, collection, 'records:read');
    if (!includesOwn(['generated', 'external'], mode)) fail('INVALID_ARGUMENT');
    let r;
    if (mode === 'external') {
      r = c.reserved.get(stable(['external', keyOf(key)]));
    } else {
      if (typeof key !== 'string' || !key || !wellFormed(key)) fail('INVALID_ARGUMENT');
      r = c.records.get(key);
    }
    return r && !r.deleted && r.keyMode === mode ? clone(r) : null;
  }
  mutate(request) {
    const target = mutationTarget(request);
    const { spaceId, credential, collection } = target;
    const { c } = this.#access(spaceId, credential, collection, 'records:write', true);
    const fields = mutationEnvelope(request);
    if (fields.spaceId !== spaceId || fields.credential !== credential || fields.collection !== collection) fail('INVALID_ARGUMENT');
    const { operation, id, externalKey, data, set, unset, expectedRevision, expectedSchemaVersion, idempotencyKey } = fields;
    const normalized = validateMutationInput({ operation, id, externalKey, expectedRevision, expectedSchemaVersion,
      idempotencyKey, supplied: new Set(Object.keys(fields)) });
    const identity = stable([spaceId, credential, operation, idempotencyKey]);
    const previous = this.receipts.get(identity);
    // Before parsing a receipt's payload, check that its original collection is still visible.
    if (previous) this.#access(spaceId, credential, previous.collection, 'records:write', true);
    // A readOnly space accepts only committed retries; fresh writes are denied
    // before inspecting their payload, without hiding malformed committed retries.
    else this.#access(spaceId, credential, collection, 'records:write');
    validateFingerprintPayload(operation, data, set, unset);
    // Caller-supplied schema precondition is stable across compatible schema additions.
    // Do not fingerprint the server's current schema version: a lost response must replay.
    const fingerprint = digest({ actor: credential, operation, collection, id, externalKey: normalized, data, set, unset, expectedRevision, expectedSchemaVersion });
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_MISMATCH');
      return { ...clone(previous.receipt), replayed: true };
    }
    if (expectedSchemaVersion !== undefined && expectedSchemaVersion !== c.version) fail('SCHEMA_CONFLICT');
    const current = operation === 'create' ? null : c.records.get(id);
    if (operation !== 'create' && (!current || current.deleted)) fail('NOT_FOUND');
    if (operation !== 'create' && current.revision !== expectedRevision) fail('REVISION_CONFLICT');
    const nextData = mutationData(operation, data, set, unset, current, c.schema);
    if (operation !== 'delete') validateData(nextData, c.schema);
    const recordId = current?.id ?? `rec_${this.seq + 1}`;
    // Record IDs, external keys and named constraint tuples occupy separate namespaces.
    const { wanted, recordKey } = reservationsFor(current, normalized, nextData, operation, c, recordId);
    return this.#commitMutation({ spaceId, collection, operation, normalized, current, nextData, c, recordId, recordKey, wanted, identity, fingerprint });
  }
  #commitMutation({ spaceId, collection, operation, normalized, current, nextData, c, recordId, recordKey, wanted, identity, fingerprint }) {
    // Stage all validation before any state/event/outbox mutation. The oracle is synchronous.
    const record = { id: recordId, key: recordKey, keyMode: current?.keyMode ?? (normalized === undefined ? 'generated' : 'external'), createdAt: current?.createdAt ?? syntheticTimestamp(this.seq + 1), revision: (current?.revision ?? 0) + 1, data: operation === 'delete' ? clone(current.data) : nextData, deleted: operation === 'delete', schemaVersion: c.version };
    if (current) for (const [reservation, holder] of c.reserved) if (holder === current) {
      if (operation === 'delete' || JSON.parse(reservation)[0] === 'external') c.reserved.set(reservation, record);
      else c.reserved.delete(reservation);
    }
    if (!current) this.seq++;
    c.records.set(recordId, record);
    for (let index = 0; index < wanted.length; index++) c.reserved.set(wanted[index], record); // NOSONAR
    const receipt = { contractVersion: '1', receiptId: `receipt_${this.events.length + 1}`, spaceId, ref: { kind: 'record', id: recordId }, operation, beforeRevision: current?.revision ?? null, revision: record.revision, schemaVersion: c.version, committedAt: 'synthetic', expiresAt: 'configured-by-adapter', projection: { generation: this.generation, state: 'pending' }, replayed: false };
    appendOwn(this.events, { spaceId, collection, id: recordId, revision: record.revision });
    appendOwn(this.outbox, { spaceId, collection, id: recordId, revision: record.revision, generation: this.generation });
    this.receipts.set(identity, { collection, fingerprint, receipt });
    return clone(receipt);
  }
  #cursorAfter(cursor, { spaceId, credential, collection, order, policyVersion, schemaVersion }) {
    if (cursor === undefined) return null;
    if (typeof cursor !== 'string' || !cursor || !matchRegex(/^[A-Za-z0-9_-]+$/, cursor)) fail('CURSOR_INVALID');
    let decoded;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) fail('CURSOR_INVALID');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) fail('CURSOR_INVALID');
      decoded = JSON.parse(text);
      // Authenticate the single emitted wire form, not a binding reconstructed
      // from alternate JSON spellings (duplicate keys, order or whitespace).
      if (stable(decoded) !== text) fail('CURSOR_INVALID');
    } catch { fail('CURSOR_INVALID'); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('CURSOR_INVALID');
    const { signature, ...binding } = decoded;
    if (binding.spaceId !== spaceId || binding.credential !== credential || binding.collection !== collection ||
      binding.policyVersion !== policyVersion || binding.schemaVersion !== schemaVersion ||
      stable(binding.sort) !== stable(order) || typeof signature !== 'string' ||
      !matchRegex(/^[a-f0-9]{64}$/, signature) ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.#sign(binding), 'hex'))) fail('CURSOR_INVALID');
    if (!binding.after || typeof binding.after.id !== 'string' || (!order && typeof binding.after.value !== 'string') ||
      (order && !includesOwn([0, 1, 2], binding.after.rank))) fail('CURSOR_INVALID');
    return binding.after;
  }
  query({ spaceId, credential, collection, limit, cursor, sort, filter }) {
    const { s, c } = this.#access(spaceId, credential, collection, 'records:read');
    if (!Number.isSafeInteger(limit) || limit < 1) fail('INVALID_ARGUMENT');
    // This oracle has no typed-filter compiler. Never return unfiltered exact results.
    if (filter !== undefined) fail('INVALID_ARGUMENT');
    const order = queryOrder(sort, c.sortable);
    const tuple = record => sortTuple(record, order, c.schema);
    const compare = (a, b) => compareTuples(a, b, order, c.schema);
    const after = this.#cursorAfter(cursor, { spaceId, credential, collection, order, policyVersion: s.policyVersion, schemaVersion: c.version });
    const sorted = [];
    for (const record of c.records.values()) {
      if (!record.deleted && (!after || compare(tuple(record), after) > 0)) appendOwn(sorted, record);
    }
    Reflect.apply(sortIntrinsic, sorted, [(a, b) => compare(tuple(a), tuple(b))]);
    const items = [];
    for (let index = 0; index < Math.min(sorted.length, limit); index++) appendOwn(items, clone(sorted[index])); // NOSONAR
    const last = items[items.length - 1]; // NOSONAR -- .at would call a mutable inherited array method.
    const payload = { spaceId, credential, collection, policyVersion: s.policyVersion, schemaVersion: c.version, sort: order, after: last && tuple(last) };
    return { items, cursor: sorted.length > limit ? Buffer.from(stable({ ...payload, signature: this.#sign(payload) })).toString('base64url') : null };
  }
  count({ cursor, ...args }) {
    if (cursor !== undefined) fail('INVALID_ARGUMENT');
    return this.query({ ...args, limit: Number.MAX_SAFE_INTEGER }).items.length;
  }
  exists({ cursor, ...args }) {
    if (cursor !== undefined) fail('INVALID_ARGUMENT');
    return this.query({ ...args, limit: 1 }).items.length > 0;
  }
  rebuild() {
    this.generation++;
    const projected = new Map();
    for (const [spaceId, s] of this.spaces) for (const [collection, c] of s.collections) for (const r of c.records.values()) if (!r.deleted) projected.set(`${spaceId}/${collection}/${r.id}`, { revision: r.revision, generation: this.generation });
    this.projection = projected;
  }
  projectionStatus({ spaceId, credential, collection, id }) {
    const { c } = this.#access(spaceId, credential, collection, 'records:read');
    const r = c.records.get(id);
    if (!r || r.deleted) return null;
    const p = this.projection.get(`${spaceId}/${collection}/${id}`);
    return p?.revision === r.revision && p?.generation === this.generation ? 'current' : 'pending';
  }
}

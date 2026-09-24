// Contract oracle only: synchronous single-process model, NOT a production repository.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ContractError(code); };
const clone = value => structuredClone(value);
// Canonical object-key ordering is UTF-8 byte order, independent of host locale/ICU.
const stable = value => {
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index++) {
      items.push(stable(Object.getOwnPropertyDescriptor(value, index)?.value) ?? 'null');
    }
    return `[${items.join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .filter(key => Object.getOwnPropertyDescriptor(value, key).value !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable(Object.getOwnPropertyDescriptor(value, key).value)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
};
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
// Fixed Unicode White_Space set (not JS trim, which includes FEFF but excludes 0085).
const whitespace = new Set([0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
for (let code = 0x09; code <= 0x0d; code++) whitespace.add(code);
for (let code = 0x2000; code <= 0x200a; code++) whitespace.add(code);
const trimKey = value => {
  const scalars = [...value];
  let start = 0;
  let end = scalars.length;
  while (start < end && whitespace.has(scalars[start].codePointAt(0))) start++;
  while (end > start && whitespace.has(scalars[end - 1].codePointAt(0))) end--;
  return scalars.slice(start, end).join('');
};
// A lone UTF-16 surrogate has no Unicode scalar value and cannot encode as UTF-8.
const wellFormed = value => [...value].every(scalar => scalar.length !== 1 || scalar < '\uD800' || scalar > '\uDFFF');
const keyOf = key => {
  if (typeof key !== 'string' || !wellFormed(key)) fail('INVALID_ARGUMENT');
  const normalized = trimKey(key.normalize('NFC'));
  if (!normalized) fail('INVALID_ARGUMENT');
  return normalized;
};
const utcInstant = value => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(value);
  if (!match || match[1].startsWith('0000-')) fail('SCHEMA_INVALID');
  const parsed = new Date(`${match[1]}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== match[1]) fail('SCHEMA_INVALID');
  let fraction = match[2] ?? '';
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === '0') end--;
  fraction = fraction.slice(0, end);
  return match[1] + (fraction ? '.' + fraction : '') + 'Z';
};
const tupleOf = (data, paths, schema) => {
  const parts = paths.map(path => Object.hasOwn(data, path) ? data[path] : undefined);
  if (parts.some(v => v === undefined || v === null)) return null;
  return parts.map((v, index) => {
    if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) fail('SCHEMA_INVALID');
    let value;
    if (schema.properties[paths[index]].format === 'date-time') value = utcInstant(v);
    else if (typeof v === 'string') value = v.normalize('NFC'); // reservation only; stored data is unchanged
    else value = JSON.stringify(v);
    return `${typeof v}:${Buffer.byteLength(value)}:${value}`;
  }).join('');
};
const allowedKeywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'format', 'description']);
const plainObject = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
// A receipt may only fingerprint JSON-compatible payloads. In particular, JSON
// serialization must not silently omit an object field or turn an array slot into null.
const validateJsonArray = (value, ancestors) => {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('SCHEMA_INVALID');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SCHEMA_INVALID');
    validateJsonPayload(descriptor.value, ancestors);
  }
};
const validateJsonObject = (value, ancestors) => {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !wellFormed(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('SCHEMA_INVALID');
    validateJsonPayload(descriptor.value, ancestors);
  }
};
const validateJsonPayload = (value, ancestors = new Set()) => {
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
const definitionType = (s, root) => {
  if (!plainObject(s) || Object.keys(s).some(name => !allowedKeywords.has(name))) fail('SCHEMA_UNSUPPORTED');
  if (root ? s.$schema !== 'https://json-schema.org/draft/2020-12/schema' : Object.hasOwn(s, '$schema')) fail('SCHEMA_UNSUPPORTED');
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (root && s.type !== 'object') fail('SCHEMA_UNSUPPORTED');
  if (types.length === 0 || types.length > 2 || new Set(types).size !== types.length || (types.length === 2 &&
    (!types.includes('null') || !['string', 'number', 'integer', 'boolean'].includes(types.find(t => t !== 'null')))) ||
    types.some(t => !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t)) ||
    (types.length === 1 && types[0] === 'null')) fail('SCHEMA_UNSUPPORTED');
  return types.find(t => t !== 'null');
};
const validateSizeBounds = s => {
  for (const [min, max] of [['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
    for (const key of [min, max]) if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || s[key] < 0)) fail('SCHEMA_UNSUPPORTED');
    if (s[min] !== undefined && s[max] !== undefined && s[min] > s[max]) fail('SCHEMA_UNSUPPORTED');
  }
};
const validateNumericBounds = s => {
  for (const key of ['minimum', 'maximum']) if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) fail('SCHEMA_UNSUPPORTED');
  if (s.minimum !== undefined && s.maximum !== undefined && s.minimum > s.maximum) fail('SCHEMA_UNSUPPORTED');
};
const validateBounds = (s, type) => {
  if (s.description !== undefined && (typeof s.description !== 'string' || !wellFormed(s.description))) fail('SCHEMA_UNSUPPORTED');
  validateSizeBounds(s);
  validateNumericBounds(s);
  if (s.format !== undefined && (type !== 'string' || s.format !== 'date-time')) fail('SCHEMA_UNSUPPORTED');
  if (type !== 'string' && (s.minLength !== undefined || s.maxLength !== undefined)) fail('SCHEMA_UNSUPPORTED');
  if (!['number', 'integer'].includes(type) && (s.minimum !== undefined || s.maximum !== undefined)) fail('SCHEMA_UNSUPPORTED');
};
const validateDefinitionStructure = (s, type) => {
  if (type === 'object') {
    if (s.additionalProperties !== false || (s.properties !== undefined && !plainObject(s.properties))) fail('SCHEMA_UNSUPPORTED');
    if (Object.keys(s.properties ?? {}).some(name => !wellFormed(name))) fail('SCHEMA_UNSUPPORTED');
    for (const child of Object.values(s.properties ?? {})) validateDefinition(child, false);
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties ?? {}, k)) || new Set(s.required).size !== s.required.length)) fail('SCHEMA_UNSUPPORTED');
  } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) fail('SCHEMA_UNSUPPORTED');
  if (type === 'array') validateDefinition(s.items, false);
  else if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) fail('SCHEMA_UNSUPPORTED');
};
const validateDefinitionEnum = s => {
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0) fail('SCHEMA_UNSUPPORTED');
    for (const value of s.enum) {
      try { validateData(value, { ...s, enum: undefined }); }
      catch (error) {
        if (error instanceof ContractError && error.code === 'SCHEMA_INVALID') fail('SCHEMA_UNSUPPORTED');
        throw error;
      }
    }
  }
};
const validateDefinition = (s, root = true) => {
  const type = definitionType(s, root);
  validateBounds(s, type);
  validateDefinitionStructure(s, type);
  validateDefinitionEnum(s);
};
const validateObject = (data, schema) => {
  if (!plainObject(data)) fail('SCHEMA_INVALID');
  for (const k of Object.keys(data)) {
    if (!wellFormed(k) || !Object.hasOwn(schema.properties ?? {}, k)) fail('SCHEMA_INVALID');
    validateData(data[k], schema.properties[k]);
  }
  for (const k of schema.required ?? []) if (!Object.hasOwn(data, k)) fail('SCHEMA_INVALID');
};
const validateScalar = (data, schema, type) => {
  if (typeof data !== (type === 'integer' || type === 'number' ? 'number' : type)) fail('SCHEMA_INVALID');
  if (type === 'string' && !wellFormed(data)) fail('SCHEMA_INVALID');
  if (type === 'integer' && !Number.isSafeInteger(data)) fail('SCHEMA_INVALID');
  if (typeof data === 'number' && (!Number.isFinite(data) || (schema.minimum !== undefined && data < schema.minimum) || (schema.maximum !== undefined && data > schema.maximum))) fail('SCHEMA_INVALID');
  if (type === 'string' && ((schema.minLength !== undefined && [...data].length < schema.minLength) || (schema.maxLength !== undefined && [...data].length > schema.maxLength))) fail('SCHEMA_INVALID');
  if (schema.format === 'date-time') utcInstant(data);
};
const validateArray = (data, schema) => {
  if (!Array.isArray(data) || (schema.minItems !== undefined && data.length < schema.minItems) || (schema.maxItems !== undefined && data.length > schema.maxItems)) fail('SCHEMA_INVALID');
  for (const value of data) validateData(value, schema.items);
};
const validateData = (data, schema) => {
  if (data === null && !(Array.isArray(schema.type) ? schema.type.includes('null') : schema.type === 'null')) fail('SCHEMA_INVALID');
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (data === null) { /* A nullable value must still satisfy enum below. */ }
  else if (type === 'object') validateObject(data, schema);
  else if (type === 'array') validateArray(data, schema);
  else validateScalar(data, schema, type);
  if (schema.enum && !schema.enum.some(value => stable(value) === stable(data))) fail('SCHEMA_INVALID');
};
const mutationFields = new Set(['spaceId', 'credential', 'collection', 'operation', 'id', 'externalKey', 'data', 'set', 'unset',
  'expectedRevision', 'expectedSchemaVersion', 'idempotencyKey']);
const validateMutationInput = ({ operation, externalKey, expectedRevision, expectedSchemaVersion, idempotencyKey, supplied }) => {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey ||
    !['create', 'replace', 'patch', 'delete'].includes(operation) || [...supplied].some(field => !mutationFields.has(field))) fail('INVALID_ARGUMENT');
  if (operation !== 'create' && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENT');
  if ((operation === 'create' && ['id', 'set', 'unset', 'expectedRevision'].some(field => supplied.has(field))) ||
    (operation === 'replace' && ['externalKey', 'set', 'unset'].some(field => supplied.has(field))) ||
    (operation === 'patch' && ['externalKey', 'data'].some(field => supplied.has(field))) ||
    (operation === 'delete' && ['externalKey', 'data', 'set', 'unset'].some(field => supplied.has(field)))) fail('INVALID_ARGUMENT');
  if (supplied.has('externalKey') && externalKey === undefined) fail('INVALID_ARGUMENT');
  if (supplied.has('expectedSchemaVersion') && (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 1)) fail('INVALID_ARGUMENT');
  return externalKey === undefined ? undefined : keyOf(externalKey);
};
const validatePatchShape = (set, unset) => {
  if (!plainObject(set) || !Array.isArray(unset) || Object.getPrototypeOf(unset) !== Array.prototype ||
    Reflect.ownKeys(unset).length !== unset.length + 1) fail('INVALID_ARGUMENT');
  const paths = new Set();
  for (let index = 0; index < unset.length; index++) {
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
  if (unset.some(k => !Object.hasOwn(schema.properties ?? {}, k) || schema.required?.includes(k))) fail('INVALID_ARGUMENT');
  const next = { ...clone(current.data), ...clone(set) };
  for (const k of unset) delete next[k];
  return next;
};
const reservationsFor = (current, normalized, nextData, operation, c, recordId) => {
  const recordKey = current?.key ?? normalized ?? recordId;
  const wanted = current?.keyMode === 'external' || (!current && normalized !== undefined)
    ? [stable(['external', recordKey])] : [];
  if (operation !== 'delete') for (const u of c.uniques) {
    const tuple = tupleOf(nextData, u.paths, c.schema);
    if (tuple !== null) wanted.push(stable(['unique', u.name, tuple]));
  }
  for (const reservation of wanted) {
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
const sortTuple = (record, order, schema) => {
  if (!order) return { value: record.createdAt, id: record.id };
  const has = Object.hasOwn(record.data, order.field);
  const value = record.data[order.field];
  let rank = 2;
  if (!has) rank = 0;
  else if (value === null) rank = 1;
  const sortableValue = rank === 2 && schema.properties[order.field].format === 'date-time' ? utcInstant(value) : value;
  return { rank, value: rank === 2 ? sortableValue : null, id: record.id };
};
const compareSortValues = (a, b, order, schema) => {
  if (!order || schema.properties[order.field].format !== 'date-time') return scalarCompare(a, b);
  const whole = scalarCompare(a.slice(0, 19), b.slice(0, 19));
  if (whole) return whole;
  const fraction = value => value.slice(19, -1).replace(/^\./, '');
  const left = fraction(a), right = fraction(b);
  return scalarCompare(left.padEnd(Math.max(left.length, right.length), '0'), right.padEnd(Math.max(left.length, right.length), '0'));
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

export class ReferenceState {
  constructor() { this.spaces = new Map(); this.events = []; this.outbox = []; this.receipts = new Map(); this.seq = 0; this.generation = 1; this.projection = new Map(); this.cursorSecret = randomBytes(32); }
  #sign(value) { return createHmac('sha256', this.cursorSecret).update(stable(value)).digest('hex'); }
  addSpace(id, owner) { this.spaces.set(id, { owner, lifecycle: 'active', policyVersion: 1, collections: new Map(), grants: new Map() }); }
  grant(spaceId, credential, collection, permissions) {
    if (collection === '*' || !Array.isArray(permissions) || permissions.some(p => !['records:read', 'records:write'].includes(p))) fail('INVALID_ARGUMENT');
    const s = this.spaces.get(spaceId);
    if (!s.grants.has(credential)) s.grants.set(credential, new Map());
    s.grants.get(credential).set(collection, new Set(permissions));
    s.policyVersion++;
  }
  revoke(spaceId, credential, collection) { const s = this.spaces.get(spaceId); if (collection === undefined) s.grants.delete(credential); else { s.grants.get(credential)?.delete(collection); if (!s.grants.get(credential)?.size) s.grants.delete(credential); } s.policyVersion++; }
  lifecycle(spaceId, state) { const s = this.spaces.get(spaceId); s.lifecycle = state; s.policyVersion++; }
  define(spaceId, slug, schema, uniques = [], sortable = []) {
    validateDefinition(schema);
    const scalarPath = path => {
      if (typeof path !== 'string' || !path || !wellFormed(path) || !Object.hasOwn(schema.properties ?? {}, path)) return false;
      const shape = schema.properties[path];
      const type = Array.isArray(shape.type) ? shape.type.find(t => t !== 'null') : shape.type;
      return ['string', 'number', 'integer', 'boolean'].includes(type);
    };
    if (!Array.isArray(uniques) || new Set(uniques.map(u => u?.name)).size !== uniques.length) fail('SCHEMA_UNSUPPORTED');
    for (const u of uniques) if (!u || typeof u.name !== 'string' || !u.name || !wellFormed(u.name) ||
      !Array.isArray(u.paths) || !u.paths.length || new Set(u.paths).size !== u.paths.length ||
      u.paths.some(path => !scalarPath(path))) fail('SCHEMA_UNSUPPORTED');
    if (!Array.isArray(sortable) || new Set(sortable).size !== sortable.length ||
      sortable.some(path => !scalarPath(path))) fail('SCHEMA_UNSUPPORTED');
    const s = this.spaces.get(spaceId);
    if (s.collections.has(slug)) fail('SCHEMA_CONFLICT');
    s.collections.set(slug, { schema: clone(schema), uniques: clone(uniques), sortable: clone(sortable), records: new Map(), reserved: new Map(), version: 1 });
  }
  revise(spaceId, slug, expectedVersion, schema) {
    validateDefinition(schema);
    const c = this.spaces.get(spaceId)?.collections.get(slug);
    if (!c) fail('NOT_FOUND');
    if (c.version !== expectedVersion) fail('SCHEMA_CONFLICT');
    // Traverse schema nodes, not arbitrary object keys: "description" may itself be a property name.
    const withoutDescription = value => {
      const { description, properties, items, ...keywords } = value;
      for (const keyword of ['required', 'type', 'enum']) {
        if (Array.isArray(keywords[keyword])) {
          const members = new Map(keywords[keyword].map(member => [stable(member), member]));
          keywords[keyword] = [...members].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .map(([, member]) => member);
        }
      }
      return { ...keywords, ...(properties === undefined ? {} : { properties: Object.fromEntries(Object.entries(properties).map(([name, shape]) => [name, withoutDescription(shape)])) }),
        ...(items === undefined ? {} : { items: withoutDescription(items) }) };
    };
    const old = c.schema;
    if (stable(withoutDescription({ ...old, properties: {} })) !== stable(withoutDescription({ ...schema, properties: {} })) ||
      Object.entries(old.properties ?? {}).some(([name, shape]) => !schema.properties?.[name] || stable(withoutDescription(shape)) !== stable(withoutDescription(schema.properties[name])))) fail('SCHEMA_BREAKING');
    c.schema = clone(schema);
    c.version++;
    return c.version;
  }
  #access(spaceId, credential, collection, capability, replay = false) {
    const s = this.spaces.get(spaceId);
    if (!s) fail('NOT_FOUND');
    if (s.lifecycle === 'deleted') fail('NOT_FOUND');
    if (['suspended', 'deleting'].includes(s.lifecycle) || (s.lifecycle === 'readOnly' && capability === 'records:write' && !replay)) fail('SPACE_UNAVAILABLE');
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
    if (!['generated', 'external'].includes(mode)) fail('INVALID_ARGUMENT');
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
    const { spaceId, credential, collection, operation, id, externalKey, data, set, unset, expectedRevision, expectedSchemaVersion, idempotencyKey } = request;
    const { c } = this.#access(spaceId, credential, collection, 'records:write', true);
    const normalized = validateMutationInput({ operation, externalKey, expectedRevision, expectedSchemaVersion,
      idempotencyKey, supplied: new Set(Reflect.ownKeys(request)) });
    const identity = stable([spaceId, credential, operation, idempotencyKey]);
    const previous = this.receipts.get(identity);
    // Before parsing a receipt's payload, check that its original collection is still visible.
    if (previous) this.#access(spaceId, credential, previous.collection, 'records:write', true);
    validateFingerprintPayload(operation, data, set, unset);
    // Caller-supplied schema precondition is stable across compatible schema additions.
    // Do not fingerprint the server's current schema version: a lost response must replay.
    const fingerprint = digest({ actor: credential, operation, collection, id, externalKey: normalized, data, set, unset, expectedRevision, expectedSchemaVersion });
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_MISMATCH');
      return { ...clone(previous.receipt), replayed: true };
    }
    this.#access(spaceId, credential, collection, 'records:write');
    if (expectedSchemaVersion !== undefined && expectedSchemaVersion !== c.version) fail('SCHEMA_CONFLICT');
    const current = id ? c.records.get(id) : null;
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
    const record = { id: recordId, key: recordKey, keyMode: current?.keyMode ?? (normalized === undefined ? 'generated' : 'external'), createdAt: current?.createdAt ?? new Date(Date.UTC(2020, 0, 1, 0, 0, 0, this.seq + 1)).toISOString(), revision: (current?.revision ?? 0) + 1, data: operation === 'delete' ? clone(current.data) : nextData, deleted: operation === 'delete', schemaVersion: c.version };
    if (current) for (const [reservation, holder] of c.reserved) if (holder === current) {
      if (operation === 'delete' || JSON.parse(reservation)[0] === 'external') c.reserved.set(reservation, record);
      else c.reserved.delete(reservation);
    }
    if (!current) this.seq++;
    c.records.set(recordId, record);
    for (const reservation of wanted) c.reserved.set(reservation, record);
    const receipt = { contractVersion: '1', receiptId: `receipt_${this.events.length + 1}`, spaceId, ref: { kind: 'record', id: recordId }, operation, beforeRevision: current?.revision ?? null, revision: record.revision, schemaVersion: c.version, committedAt: 'synthetic', expiresAt: 'configured-by-adapter', projection: { generation: this.generation, state: 'pending' }, replayed: false };
    this.events.push({ spaceId, collection, id: recordId, revision: record.revision });
    this.outbox.push({ spaceId, collection, id: recordId, revision: record.revision, generation: this.generation });
    this.receipts.set(identity, { collection, fingerprint, receipt });
    return clone(receipt);
  }
  #cursorAfter(cursor, { spaceId, credential, collection, order, policyVersion, schemaVersion }) {
    if (cursor === undefined) return null;
    if (typeof cursor !== 'string' || !cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('CURSOR_INVALID');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail('CURSOR_INVALID'); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('CURSOR_INVALID');
    const { signature, ...binding } = decoded;
    if (binding.spaceId !== spaceId || binding.credential !== credential || binding.collection !== collection || binding.policyVersion !== policyVersion || binding.schemaVersion !== schemaVersion || stable(binding.sort) !== stable(order) || signature !== this.#sign(binding)) fail('CURSOR_INVALID');
    if (!binding.after || typeof binding.after.id !== 'string' || (!order && typeof binding.after.value !== 'string') ||
      (order && ![0, 1, 2].includes(binding.after.rank))) fail('CURSOR_INVALID');
    return binding.after;
  }
  query({ spaceId, credential, collection, limit, cursor, sort, filter }) {
    const { s, c } = this.#access(spaceId, credential, collection, 'records:read');
    if (!Number.isSafeInteger(limit) || limit < 1) fail('INVALID_ARGUMENT');
    // This oracle has no typed-filter compiler. Never return unfiltered exact results.
    if (filter !== undefined) fail('INVALID_ARGUMENT');
    if (sort !== undefined && (!sort || Array.isArray(sort) || typeof sort !== 'object' ||
      Object.keys(sort).some(key => !['field', 'direction'].includes(key)) ||
      !c.sortable.includes(sort.field) || !['asc', 'desc'].includes(sort.direction))) fail('INVALID_ARGUMENT');
    const order = sort === undefined ? null : { field: sort.field, direction: sort.direction };
    const tuple = record => sortTuple(record, order, c.schema);
    const compare = (a, b) => compareTuples(a, b, order, c.schema);
    const after = this.#cursorAfter(cursor, { spaceId, credential, collection, order, policyVersion: s.policyVersion, schemaVersion: c.version });
    const sorted = [...c.records.values()].filter(r => !r.deleted && (!after || compare(tuple(r), after) > 0)).sort((a, b) => compare(tuple(a), tuple(b)));
    const items = sorted.slice(0, limit).map(clone);
    const last = items.at(-1);
    const payload = { spaceId, credential, collection, policyVersion: s.policyVersion, schemaVersion: c.version, sort: order, after: last && tuple(last) };
    return { items, cursor: sorted.length > limit ? Buffer.from(JSON.stringify({ ...payload, signature: this.#sign(payload) })).toString('base64url') : null };
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

// Contract oracle only: synchronous single-process model, NOT a production repository.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ContractError(code); };
const clone = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const keyOf = key => {
  if (typeof key !== 'string') fail('INVALID_ARGUMENT');
  const normalized = key.normalize('NFC').trim();
  if (!normalized) fail('INVALID_ARGUMENT');
  return normalized;
};
const utcInstant = value => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(value);
  if (!match || match[1].startsWith('0000-')) fail('SCHEMA_INVALID');
  const parsed = new Date(`${match[1]}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== match[1]) fail('SCHEMA_INVALID');
  const fraction = match[2]?.replace(/0+$/, '');
  return `${match[1]}${fraction ? `.${fraction}` : ''}Z`;
};
const tupleOf = (data, paths, schema) => {
  const parts = paths.map(path => data[path]);
  if (parts.some(v => v === undefined || v === null)) return null;
  return parts.map((v, index) => {
    if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) fail('SCHEMA_INVALID');
    const value = schema.properties[paths[index]].format === 'date-time'
      ? utcInstant(v) : typeof v === 'string' ? v.normalize('NFC') : JSON.stringify(v);
    return `${typeof v}:${Buffer.byteLength(value)}:${value}`;
  }).join('');
};
const allowedKeywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'format', 'description']);
const validateDefinition = (s, root = true) => {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('SCHEMA_INVALID');
  for (const name of Object.keys(s)) if (!allowedKeywords.has(name)) fail('SCHEMA_UNSUPPORTED');
  if (root && s.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('SCHEMA_UNSUPPORTED');
  if (!root && Object.hasOwn(s, '$schema')) fail('SCHEMA_UNSUPPORTED');
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (root && s.type !== 'object') fail('SCHEMA_UNSUPPORTED');
  if (types.length === 0 || types.length > 2 || (types.length === 2 &&
    (!types.includes('null') || !['string', 'number', 'integer', 'boolean'].includes(types.find(t => t !== 'null')))) ||
    types.some(t => !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t)) ||
    (types.length === 1 && types[0] === 'null')) fail('SCHEMA_UNSUPPORTED');
  const type = types.find(t => t !== 'null');
  if (s.format !== undefined && (type !== 'string' || s.format !== 'date-time')) fail('SCHEMA_UNSUPPORTED');
  if (type === 'object') {
    if (s.additionalProperties !== false || (s.properties !== undefined && (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)))) fail('SCHEMA_UNSUPPORTED');
    for (const child of Object.values(s.properties ?? {})) validateDefinition(child, false);
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties ?? {}, k)) || new Set(s.required).size !== s.required.length)) fail('SCHEMA_UNSUPPORTED');
  } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) fail('SCHEMA_UNSUPPORTED');
  if (type === 'array') validateDefinition(s.items, false);
  else if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) fail('SCHEMA_UNSUPPORTED');
  if (type !== 'string' && (s.minLength !== undefined || s.maxLength !== undefined)) fail('SCHEMA_UNSUPPORTED');
  if (!['number', 'integer'].includes(type) && (s.minimum !== undefined || s.maximum !== undefined)) fail('SCHEMA_UNSUPPORTED');
};
const validateData = (data, schema) => {
  if (data === null && !(Array.isArray(schema.type) ? schema.type.includes('null') : schema.type === 'null')) fail('SCHEMA_INVALID');
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (data === null) {
    // A nullable type still has to satisfy enum; no other scalar constraint applies.
  } else if (type === 'object') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SCHEMA_INVALID');
    for (const k of Object.keys(data)) { if (!schema.properties?.[k]) fail('SCHEMA_INVALID'); validateData(data[k], schema.properties[k]); }
    for (const k of schema.required ?? []) if (!Object.hasOwn(data, k)) fail('SCHEMA_INVALID');
  } else if (type === 'array') {
    if (!Array.isArray(data) || (schema.minItems !== undefined && data.length < schema.minItems) || (schema.maxItems !== undefined && data.length > schema.maxItems)) fail('SCHEMA_INVALID');
    for (const value of data) validateData(value, schema.items);
  } else {
    if (typeof data !== (type === 'integer' || type === 'number' ? 'number' : type)) fail('SCHEMA_INVALID');
    if (type === 'integer' && !Number.isSafeInteger(data)) fail('SCHEMA_INVALID');
    if (typeof data === 'number' && (!Number.isFinite(data) || (schema.minimum !== undefined && data < schema.minimum) || (schema.maximum !== undefined && data > schema.maximum))) fail('SCHEMA_INVALID');
    if (type === 'string' && ((schema.minLength !== undefined && data.length < schema.minLength) || (schema.maxLength !== undefined && data.length > schema.maxLength))) fail('SCHEMA_INVALID');
    if (schema.format === 'date-time') utcInstant(data);
  }
  if (schema.enum && !schema.enum.some(value => stable(value) === stable(data))) fail('SCHEMA_INVALID');
};

export class ReferenceState {
  constructor() { this.spaces = new Map(); this.events = []; this.outbox = []; this.receipts = new Map(); this.seq = 0; this.generation = 1; this.projection = new Map(); this.cursorSecret = randomBytes(32); }
  #sign(value) { return createHmac('sha256', this.cursorSecret).update(stable(value)).digest('hex'); }
  addSpace(id, owner) { this.spaces.set(id, { owner, lifecycle: 'active', policyVersion: 1, collections: new Map(), grants: new Map() }); }
  grant(spaceId, credential, collection, permissions) { if (collection === '*') fail('INVALID_ARGUMENT'); const s = this.spaces.get(spaceId); if (!s.grants.has(credential)) s.grants.set(credential, new Map()); s.grants.get(credential).set(collection, new Set(permissions)); s.policyVersion++; }
  revoke(spaceId, credential, collection) { const s = this.spaces.get(spaceId); if (collection === undefined) s.grants.delete(credential); else { s.grants.get(credential)?.delete(collection); if (!s.grants.get(credential)?.size) s.grants.delete(credential); } s.policyVersion++; }
  lifecycle(spaceId, state) { const s = this.spaces.get(spaceId); s.lifecycle = state; s.policyVersion++; }
  define(spaceId, slug, schema, uniques = []) {
    validateDefinition(schema);
    for (const u of uniques) if (!u.name || !u.paths?.length || u.paths.some(path => {
      const shape = schema.properties?.[path];
      const type = Array.isArray(shape?.type) ? shape.type.find(t => t !== 'null') : shape?.type;
      return !['string', 'number', 'integer', 'boolean'].includes(type);
    })) fail('SCHEMA_UNSUPPORTED');
    const s = this.spaces.get(spaceId);
    if (s.collections.has(slug)) fail('SCHEMA_CONFLICT');
    s.collections.set(slug, { schema: clone(schema), uniques: clone(uniques), records: new Map(), reserved: new Map(), version: 1 });
  }
  revise(spaceId, slug, expectedVersion, schema) {
    validateDefinition(schema);
    const c = this.spaces.get(spaceId)?.collections.get(slug);
    if (!c) fail('NOT_FOUND');
    if (c.version !== expectedVersion) fail('SCHEMA_CONFLICT');
    const withoutDescription = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'description' ? undefined : v));
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
    if (['suspended', 'deleting'].includes(s.lifecycle) || (s.lifecycle === 'readOnly' && capability === 'write' && !replay)) fail('SPACE_UNAVAILABLE');
    const permissions = s.grants.get(credential)?.get(collection);
    if (!permissions?.has(capability)) fail('FORBIDDEN');
    const c = s.collections.get(collection);
    if (!c) fail('NOT_FOUND');
    return { s, c };
  }
  get({ spaceId, credential, collection, id }) {
    const { c } = this.#access(spaceId, credential, collection, 'read');
    const r = c.records.get(id);
    return r && !r.deleted ? clone(r) : null;
  }
  mutate({ spaceId, credential, collection, operation, id, externalKey, data, set, unset, expectedRevision, expectedSchemaVersion, idempotencyKey }) {
    const { c } = this.#access(spaceId, credential, collection, 'write', true);
    if (!idempotencyKey || !['create', 'replace', 'patch', 'delete'].includes(operation)) fail('INVALID_ARGUMENT');
    if (operation !== 'create' && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail('INVALID_ARGUMENT');
    if (operation === 'create' && expectedRevision !== undefined) fail('INVALID_ARGUMENT');
    if (operation !== 'create' && externalKey !== undefined) fail('INVALID_ARGUMENT');
    if (expectedSchemaVersion !== undefined && (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 1)) fail('INVALID_ARGUMENT');
    const normalized = externalKey === undefined ? undefined : keyOf(externalKey);
    // Caller-supplied schema precondition is stable across compatible schema additions.
    // Do not fingerprint the server's current schema version: a lost response must replay.
    const fingerprint = digest({ actor: credential, operation, collection, id, externalKey: normalized, data, set, unset, expectedRevision, expectedSchemaVersion });
    const identity = stable([spaceId, credential, operation, idempotencyKey]);
    const previous = this.receipts.get(identity);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_MISMATCH');
      return { ...clone(previous.receipt), replayed: true };
    }
    this.#access(spaceId, credential, collection, 'write');
    if (expectedSchemaVersion !== undefined && expectedSchemaVersion !== c.version) fail('SCHEMA_CONFLICT');
    const current = id ? c.records.get(id) : null;
    if (operation !== 'create' && (!current || current.deleted)) fail('NOT_FOUND');
    if (operation !== 'create' && current.revision !== expectedRevision) fail('REVISION_CONFLICT');
    if (operation === 'create' && id !== undefined) fail('INVALID_ARGUMENT');
    let nextData;
    if (operation === 'create' || operation === 'replace') {
      if (data === undefined) fail('SCHEMA_INVALID');
      nextData = clone(data);
    }
    if (operation === 'patch') {
      if (!set || typeof set !== 'object' || !Array.isArray(unset) || unset.some(k => Object.hasOwn(set, k))) fail('INVALID_ARGUMENT');
      nextData = { ...clone(current.data), ...clone(set) };
      for (const k of unset) delete nextData[k];
    }
    if (operation !== 'delete') validateData(nextData, c.schema);
    const recordId = current?.id ?? `rec_${this.seq + 1}`;
    const recordKey = current?.key ?? normalized ?? recordId;
    // Record IDs are a separate namespace from caller-provided external keys.
    // Array encoding keeps constraint names/tuples distinct from either key namespace.
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
    this.receipts.set(identity, { fingerprint, receipt });
    return clone(receipt);
  }
  query({ spaceId, credential, collection, limit, cursor }) {
    const { s, c } = this.#access(spaceId, credential, collection, 'read');
    if (!Number.isSafeInteger(limit) || limit < 1) fail('INVALID_ARGUMENT');
    let after = null;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail('CURSOR_INVALID'); }
      const { signature, ...binding } = decoded;
      if (binding.spaceId !== spaceId || binding.credential !== credential || binding.collection !== collection || binding.policyVersion !== s.policyVersion || binding.schemaVersion !== c.version || signature !== this.#sign(binding)) fail('CURSOR_INVALID');
      if (!binding.after || typeof binding.after.createdAt !== 'string' || typeof binding.after.id !== 'string') fail('CURSOR_INVALID');
      after = binding.after;
    }
    const compare = (a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    const sorted = [...c.records.values()].filter(r => !r.deleted && (!after || compare(r, after) > 0)).sort(compare);
    const items = sorted.slice(0, limit).map(clone);
    const last = items.at(-1);
    const payload = { spaceId, credential, collection, policyVersion: s.policyVersion, schemaVersion: c.version, after: last && { createdAt: last.createdAt, id: last.id } };
    return { items, cursor: sorted.length > limit ? Buffer.from(JSON.stringify({ ...payload, signature: this.#sign(payload) })).toString('base64url') : null };
  }
  count(args) { return this.query({ ...args, limit: Number.MAX_SAFE_INTEGER }).items.length; }
  exists(args) { return this.query({ ...args, limit: 1 }).items.length > 0; }
  rebuild() {
    this.generation++;
    const projected = new Map();
    for (const [spaceId, s] of this.spaces) for (const [collection, c] of s.collections) for (const r of c.records.values()) if (!r.deleted) projected.set(`${spaceId}/${collection}/${r.id}`, { revision: r.revision, generation: this.generation });
    this.projection = projected;
  }
  projectionStatus({ spaceId, credential, collection, id }) {
    const { c } = this.#access(spaceId, credential, collection, 'read');
    const r = c.records.get(id);
    if (!r || r.deleted) return null;
    const p = this.projection.get(`${spaceId}/${collection}/${id}`);
    return p?.revision === r.revision && p?.generation === this.generation ? 'current' : 'pending';
  }
}

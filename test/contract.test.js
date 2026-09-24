import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ReferenceState } from './reference.js';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { label: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, ordinal: { type: ['integer', 'null'] } },
  required: ['label'], additionalProperties: false
};
const uniques = [{ name: 'label_state', paths: ['label', 'state'] }];
const recordAccess = ['records:read', 'records:write'];
const setup = () => {
  const store = new ReferenceState();
  for (const space of ['sp_a', 'sp_b']) {
    store.addSpace(space, 'owner');
    store.define(space, 'entries', schema, uniques);
    store.grant(space, 'agent', 'entries', recordAccess);
  }
  return store;
};
const scope = { spaceId: 'sp_a', credential: 'agent', collection: 'entries' };
const create = (store, externalKey, data, idempotencyKey) => store.mutate({ ...scope, operation: 'create', externalKey, data, idempotencyKey });
const write = (store, operation, id, expectedRevision, idempotencyKey, other = {}) => store.mutate({ ...scope, operation, id, expectedRevision, idempotencyKey, ...other });
const code = (fn, expected) => assert.throws(fn, e => e.code === expected);

test('space and collection scope isolate IDs, unique keys and credentials', () => {
  const db = setup();
  const a = create(db, 'same', { label: 'a', state: 'open' }, 'one');
  db.mutate({ ...scope, spaceId: 'sp_b', operation: 'create', externalKey: 'same', data: { label: 'a', state: 'open' }, idempotencyKey: 'one' });
  assert.equal(db.get({ ...scope, id: a.ref.id }).data.label, 'a');
  assert.equal(db.get({ ...scope, spaceId: 'sp_b', id: a.ref.id }), null); // no lookup may escape its requested space
  code(() => db.get({ ...scope, credential: 'stranger', id: a.ref.id }), 'FORBIDDEN');
  db.revoke('sp_a', 'agent');
  code(() => db.get({ ...scope, id: a.ref.id }), 'FORBIDDEN');
  code(() => db.mutate({ ...scope, operation: 'create', externalKey: 'same', data: { label: 'a' }, idempotencyKey: 'one' }), 'FORBIDDEN');
});

test('create only, NFC key, typed composite uniqueness and null/missing', () => {
  const db = setup();
  const first = create(db, ' e\u0301 ', { label: 'same', state: 'open' }, 'one');
  code(() => create(db, '\u00e9', { label: 'other' }, 'two'), 'UNIQUE_CONFLICT');
  code(() => create(db, 'two', { label: 'same', state: 'open' }, 'three'), 'UNIQUE_CONFLICT');
  create(db, 'three', { label: 'same', ordinal: null }, 'four');
  create(db, 'four', { label: 'same' }, 'five');
  assert.equal(db.get({ ...scope, id: first.ref.id }).key, '\u00e9');
  assert.equal(db.count(scope), 3);
  assert.equal(db.exists(scope), true);
});

test('mutation envelopes cannot inherit IDs or dispatch fields and overwrite a create', () => {
  const db = setup();
  const created = create(db, 'original', { label: 'original' }, 'first');
  const id = created.ref.id;
  const c = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ records: structuredClone([...c.records]),
    reservations: [...c.reserved].map(([key, row]) => [key, row.id, row.revision, row.deleted]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]), seq: db.seq });
  const before = snapshot();
  const base = { ...scope, operation: 'create', data: { label: 'changed' }, idempotencyKey: 'second' };
  let getterCalls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'id', { enumerable: true, get() { getterCalls++; return id; } });
  const hidden = { ...base };
  Object.defineProperty(hidden, 'id', { enumerable: false, value: id });
  const targetAccessor = { ...base };
  Object.defineProperty(targetAccessor, 'collection', { enumerable: true, get() { getterCalls++; return 'entries'; } });
  const hiddenTarget = { ...base };
  Object.defineProperty(hiddenTarget, 'collection', { enumerable: false, value: 'entries' });
  const decorated = { ...base, [Symbol('extra')]: true };
  const attempts = [Object.assign(Object.create({ id }), base),
    Object.assign(Object.create({ id }), { ...base, idempotencyKey: 'first', data: { label: 'original' } }),
    Object.assign(Object.create({ operation: 'create' }), { ...scope, data: base.data, idempotencyKey: 'second' }),
    Object.assign(Object.create({ collection: 'entries' }), { spaceId: scope.spaceId, credential: scope.credential, operation: 'create', data: base.data, idempotencyKey: 'second' }),
    accessor, hidden, hiddenTarget, targetAccessor, decorated, { ...base, unknown: true }];
  for (const request of attempts) {
    code(() => db.mutate(request), 'INVALID_ARGUMENT');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(getterCalls, 0);
  db.revoke('sp_a', 'agent', 'entries');
  code(() => db.mutate(attempts[0]), 'FORBIDDEN');
  code(() => db.mutate(hiddenTarget), 'FORBIDDEN');
  assert.deepEqual(snapshot(), before);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  assert.equal(db.mutate(Object.assign(Object.create(null), { ...base, idempotencyKey: 'null-prototype', data: { label: 'fresh' } })).beforeRevision, null);
  const replace = write(db, 'replace', id, 1, 'replace', { data: { label: 'updated' } });
  assert.equal(replace.beforeRevision, 1);
  assert.equal(db.mutate({ ...scope, operation: 'replace', id, expectedRevision: 1, idempotencyKey: 'replace', data: { label: 'updated' } }).replayed, true);
  assert.equal(db.get({ ...scope, id }).data.label, 'updated');
});

test('definition and revision require own keywords despite polluted prototypes', () => {
  const db = setup();
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ collections: [...db.spaces.get('sp_a').collections.keys()],
    version: collection.version, schema: structuredClone(collection.schema), rows: structuredClone([...collection.records]),
    reservations: structuredClone([...collection.reserved]), events: structuredClone(db.events),
    outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  const uri = schema.$schema;
  const inheritedRoot = { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } }, required: ['label'] };
  const inheritedChild = { ...schema, properties: { label: {} } };
  const inheritedClosed = { $schema: uri, type: 'object', properties: {} };
  const inheritedNestedClosed = { ...schema, properties: { label: { type: 'object', properties: {} } } };
  const previous = Object.fromEntries(['$schema', 'type', 'additionalProperties', 'enum', 'minLength', 'properties']
    .map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  try {
    Object.defineProperties(Object.prototype, {
      $schema: { configurable: true, value: uri },
      type: { configurable: true, value: 'string' },
      additionalProperties: { configurable: true, value: false },
      enum: { configurable: true, value: ['blocked'] },
      minLength: { configurable: true, value: 100 },
      properties: { configurable: true, value: { label: { type: 'string' } } }
    });
    for (const [name, malformed] of [
      ['missing-root-uri', inheritedRoot], ['missing-child-type', inheritedChild],
      ['missing-closed-flag', inheritedClosed], ['missing-nested-closed-flag', inheritedNestedClosed]
    ]) {
      code(() => db.define('sp_a', name, malformed), 'SCHEMA_UNSUPPORTED');
      code(() => db.revise('sp_a', 'entries', 1, malformed), 'SCHEMA_UNSUPPORTED');
      assert.deepEqual(snapshot(), before);
    }
    code(() => db.revise('sp_a', 'entries', 1, { $schema: uri, type: 'object', additionalProperties: false }), 'SCHEMA_BREAKING');
    assert.deepEqual(snapshot(), before);
    const valid = { ...schema, properties: { ...schema.properties, note: { type: 'string' } } };
    db.define('sp_a', 'valid', valid);
    assert.equal(db.revise('sp_a', 'entries', 1, valid), 2);
    assert.equal(create(db, 'valid', { label: 'ok' }, 'valid').beforeRevision, null);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
  assert.equal(collection.version, 2);
  assert.equal(db.spaces.get('sp_a').collections.has('valid'), true);
});

test('stored optional format remains own-only across reservations, sorts and cursors', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', {
    $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { label: { type: 'string' } }, required: ['label']
  }, [{ name: 'label', paths: ['label'] }], ['label']);
  db.define('sp_a', 'dated', {
    $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { observedAt: { type: 'string', format: 'date-time' } }, required: ['observedAt']
  }, [{ name: 'instant', paths: ['observedAt'] }], ['observedAt']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  db.grant('sp_a', 'agent', 'dated', recordAccess);
  const put = (collection, field, value, key) => db.mutate({ ...scope, collection, operation: 'create',
    data: { [field]: value }, idempotencyKey: key });
  const first = put('entries', 'label', '2020-01-01T00:00:00.1Z', 'first');
  const second = put('entries', 'label', '2020-01-01T00:00:00Z', 'second');
  const snapshot = () => ({ seq: db.seq, events: structuredClone(db.events), outbox: structuredClone(db.outbox),
    receipts: structuredClone([...db.receipts]), collections: [...db.spaces.get('sp_a').collections].map(([name, c]) =>
      [name, structuredClone([...c.records]), structuredClone([...c.reserved])]) });
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'format');
  try {
    Object.defineProperty(Object.prototype, 'format', { configurable: true, value: 'date-time' });
    const third = put('entries', 'label', 'ordinary', 'third');
    assert.equal(db.get({ ...scope, id: third.ref.id }).data.label, 'ordinary');
    const beforeFailure = snapshot();
    code(() => put('entries', 'label', 'ordinary', 'duplicate'), 'UNIQUE_CONFLICT');
    assert.deepEqual(snapshot(), beforeFailure);
    for (const [direction, expected] of [
      ['asc', [first.ref.id, second.ref.id, third.ref.id]],
      ['desc', [third.ref.id, second.ref.id, first.ref.id]]
    ]) {
      const sort = { field: 'label', direction };
      assert.deepEqual(db.query({ ...scope, limit: 3, sort }).items.map(row => row.id), expected);
      let cursor;
      const paged = [];
      do {
        const page = db.query({ ...scope, limit: 1, sort, ...(cursor ? { cursor } : {}) });
        paged.push(...page.items.map(row => row.id));
        cursor = page.cursor;
      } while (cursor);
      assert.deepEqual(paged, expected);
    }
    const later = put('dated', 'observedAt', '2020-01-01T00:00:00.1Z', 'later');
    const earlier = put('dated', 'observedAt', '2020-01-01T00:00:00Z', 'earlier');
    const dated = { ...scope, collection: 'dated', limit: 1, sort: { field: 'observedAt', direction: 'asc' } };
    const firstPage = db.query(dated);
    assert.deepEqual(firstPage.items.map(row => row.id), [earlier.ref.id]);
    assert.deepEqual(db.query({ ...dated, cursor: firstPage.cursor }).items.map(row => row.id), [later.ref.id]);
    const beforeInvalid = snapshot();
    code(() => put('dated', 'observedAt', 'ordinary', 'invalid-date'), 'SCHEMA_INVALID');
    assert.deepEqual(snapshot(), beforeInvalid);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'format', previous);
    else delete Object.prototype.format;
  }
});

test('generated IDs and external keys have separate namespaces, including tombstones', () => {
  const db = setup();
  const external = create(db, 'rec_2', { label: 'external' }, 'one');
  const generated = db.mutate({ ...scope, operation: 'create', data: { label: 'generated' }, idempotencyKey: 'two' });
  assert.equal(generated.ref.id, 'rec_2');
  assert.equal(db.get({ ...scope, id: generated.ref.id }).keyMode, 'generated');
  assert.equal(db.get({ ...scope, id: external.ref.id }).keyMode, 'external');
  write(db, 'delete', external.ref.id, 1, 'delete');
  code(() => create(db, 'rec_2', { label: 'new' }, 'three'), 'KEY_RESERVED');
});

test('key lookup requires a mode, isolates colliding ID text, and hides tombstones', () => {
  const db = setup();
  const external = create(db, ' rec_2 ', { label: 'external' }, 'one');
  const generated = db.mutate({ ...scope, operation: 'create', data: { label: 'generated' }, idempotencyKey: 'two' });
  const lookup = (mode, key, other = {}) => db.getByKey({ ...scope, mode, key, ...other });
  assert.equal(lookup('external', 'rec_2').id, external.ref.id);
  assert.equal(lookup('external', ' rec_2 ').id, external.ref.id);
  assert.equal(lookup('generated', 'rec_2').id, generated.ref.id);
  assert.equal(lookup('generated', ` ${generated.ref.id} `), null);
  assert.equal(lookup('generated', external.ref.id), null);
  assert.equal(lookup('external', external.ref.id), null);
  assert.equal(lookup('generated', 'rec_2', { spaceId: 'sp_b' }), null);
  for (const mode of [undefined, 'any', null]) code(() => lookup(mode, 'rec_2'), 'INVALID_ARGUMENT');
  code(() => lookup('external', '\u0085'), 'INVALID_ARGUMENT');
  db.revoke('sp_a', 'agent');
  code(() => lookup('external', 'rec_2'), 'FORBIDDEN');
  code(() => lookup('external', '\u0085'), 'FORBIDDEN');
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  write(db, 'delete', external.ref.id, 1, 'delete-external');
  assert.equal(lookup('external', 'rec_2'), null);
  assert.equal(lookup('generated', 'rec_2').id, generated.ref.id);
  write(db, 'delete', generated.ref.id, 1, 'delete-generated');
  assert.equal(lookup('generated', 'rec_2'), null);
});

test('external keys cannot collide with constraint namespaces, and replacement releases live tuples only', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', schema, [{ name: 'key', paths: ['label'] }]);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const first = create(db, 'seed', { label: 'x' }, 'one');
  create(db, 'string:1:x', { label: 'y' }, 'two');
  write(db, 'replace', first.ref.id, 1, 'three', { data: { label: 'z' } });
  create(db, 'third', { label: 'x' }, 'four');
  code(() => create(db, 'seed', { label: 'fresh' }, 'five'), 'UNIQUE_CONFLICT');
  write(db, 'delete', first.ref.id, 2, 'delete');
  code(() => create(db, 'fourth', { label: 'z' }, 'six'), 'KEY_RESERVED');
});

test('nullable enum still validates null, UTC dates reject rollover and compare equivalent instants', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', {
    $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { state: { type: ['integer', 'null'], enum: [1] }, observedAt: { type: 'string', format: 'date-time' } }
  }, [{ name: 'instant', paths: ['observedAt'] }]);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  code(() => create(db, 'bad-null', { state: null }, 'one'), 'SCHEMA_INVALID');
  for (const bad of ['2026-02-30T25:99:99Z', '2026-02-30T12:00:00Z', '2026-09-23T12:00:60Z']) {
    code(() => create(db, bad, { observedAt: bad }, bad), 'SCHEMA_INVALID');
  }
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  create(db, 'valid', { state: 1, observedAt: '2026-09-23T12:00:00Z' }, 'valid');
  code(() => create(db, 'same', { observedAt: '2026-09-23T12:00:00.0Z' }, 'same'), 'UNIQUE_CONFLICT');
  create(db, 'fraction', { observedAt: '2026-09-23T12:00:00.1230Z' }, 'fraction');
  code(() => create(db, 'same-fraction', { observedAt: '2026-09-23T12:00:00.123Z' }, 'same-fraction'), 'UNIQUE_CONFLICT');
});

test('integer records and enum definitions use v1 safe-integer boundaries', () => {
  const db = setup();
  db.define('sp_a', 'bounded', { ...schema, properties: { ordinal: { type: 'integer', enum: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] } }, required: ['ordinal'] });
  db.grant('sp_a', 'agent', 'bounded', recordAccess);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    code(() => db.define('sp_a', `enum-${value}`, { ...schema, properties: { ordinal: { type: 'integer', enum: [value] } } }), 'SCHEMA_UNSUPPORTED');
    const before = [db.events.length, db.outbox.length, db.receipts.size];
    code(() => create(db, `outside-${value}`, { label: 'outside', ordinal: value }, `outside-${value}`), 'SCHEMA_INVALID');
    assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  }
  for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    const receipt = db.mutate({ ...scope, collection: 'bounded', operation: 'create', data: { ordinal: value }, idempotencyKey: `edge-${value}` });
    assert.equal(db.get({ ...scope, collection: 'bounded', id: receipt.ref.id }).data.ordinal, value);
  }
  db.define('sp_a', 'finite-number', { ...schema, properties: { ordinal: { type: 'number' } }, required: ['ordinal'] });
  db.grant('sp_a', 'agent', 'finite-number', recordAccess);
  assert.equal(db.mutate({ ...scope, collection: 'finite-number', operation: 'create', data: { ordinal: Number.MAX_SAFE_INTEGER + 1 }, idempotencyKey: 'number' }).revision, 1);
});

test('existing-record key input is rejected before side effects, even when normalized key matches', () => {
  const db = setup();
  const id = create(db, 'original', { label: 'entry' }, 'one').ref.id;
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  for (const externalKey of ['other', ' original ']) {
    code(() => write(db, 'replace', id, 1, externalKey, { externalKey, data: { label: 'changed' } }), 'INVALID_ARGUMENT');
  }
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  assert.equal(db.get({ ...scope, id }).revision, 1);
  code(() => create(db, 'original', { label: 'other' }, 'two'), 'UNIQUE_CONFLICT');
});

test('atomic validation failure leaves record, event, receipt, reservations and outbox untouched', () => {
  const db = setup();
  const a = create(db, 'a', { label: 'a', state: 'open' }, 'one');
  create(db, 'b', { label: 'b', state: 'open' }, 'two');
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ records: structuredClone([...collection.records]),
    reservations: [...collection.reserved].map(([key, record]) => [key, record.id, record.revision, record.deleted]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  code(() => write(db, 'replace', a.ref.id, 1, 'bad', { data: { label: 'b', state: 'open' } }), 'UNIQUE_CONFLICT');
  assert.deepEqual(snapshot(), before);
  code(() => write(db, 'replace', a.ref.id, 1, 'invalid', { data: { label: 'a', secret: true } }), 'SCHEMA_INVALID');
  assert.deepEqual(snapshot(), before);
  code(() => create(db, 'third', { label: 'a', state: 'open' }, 'third'), 'UNIQUE_CONFLICT');
  assert.deepEqual(snapshot(), before);
  const good = write(db, 'replace', a.ref.id, 1, 'good', { data: { label: 'a', state: 'open' } });
  assert.equal(good.revision, 2);
});

test('two conditional writers: exactly one revision wins; patch null vs missing and replacement omission', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry', ordinal: null }, 'one').ref.id;
  code(() => write(db, 'patch', id, undefined, 'missing', { set: { state: 'open' }, unset: [] }), 'INVALID_ARGUMENT');
  write(db, 'patch', id, 1, 'two', { set: { state: 'open' }, unset: ['ordinal'] });
  code(() => write(db, 'replace', id, 1, 'three', { data: { label: 'stale' } }), 'REVISION_CONFLICT');
  assert.equal(Object.hasOwn(db.get({ ...scope, id }).data, 'ordinal'), false);
  write(db, 'patch', id, 2, 'four', { set: { ordinal: null }, unset: [] });
  assert.equal(db.get({ ...scope, id }).data.ordinal, null);
  write(db, 'replace', id, 3, 'five', { data: { label: 'entry' } });
  assert.deepEqual(db.get({ ...scope, id }).data, { label: 'entry' });
});

test('lost committed response: matching old expectedRevision replays before stale check, without effects', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry' }, 'create').ref.id;
  const req = { data: { label: 'entry', state: 'closed' } };
  const committed = write(db, 'replace', id, 1, 'lost-response', req); // client never receives this response
  assert.equal(db.get({ ...scope, id }).revision, 2);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  const replay = write(db, 'replace', id, 1, 'lost-response', req);
  assert.equal(replay.receiptId, committed.receiptId);
  assert.equal(replay.replayed, true);
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  code(() => write(db, 'replace', id, 1, 'lost-response', { data: { label: 'different' } }), 'IDEMPOTENCY_MISMATCH');
  code(() => write(db, 'replace', id, 1, 'new-request', req), 'REVISION_CONFLICT');
  db.revoke('sp_a', 'agent');
  code(() => write(db, 'replace', id, 1, 'lost-response', req), 'FORBIDDEN');
});

test('invalid JSON data and patch shapes cannot alias receipts or produce effects', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { label: { type: 'string' }, tags: { type: 'array', items: { type: ['string', 'null'] } }, optional: { type: 'string' } } });
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const created = { ...scope, operation: 'create', data: { label: 'item', tags: [null] }, idempotencyKey: 'create' };
  const id = db.mutate(created).ref.id;
  const replaced = { ...scope, operation: 'replace', id, expectedRevision: 1, data: { label: 'next' }, idempotencyKey: 'replace' };
  db.mutate(replaced);
  const patched = { ...scope, operation: 'patch', id, expectedRevision: 2, set: { optional: 'ok' }, unset: [], idempotencyKey: 'patch' };
  db.mutate(patched);
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ records: structuredClone([...collection.records]), reserved: [...collection.reserved].map(([k, r]) => [k, r.id, r.revision]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  const sparse = [,];
  const circular = { label: 'cycle' };
  circular.self = circular;
  for (const request of [
    { ...created, data: { label: 'item', tags: [undefined] } },
    { ...created, idempotencyKey: 'fresh-array', data: { label: 'item', tags: [undefined] } },
    { ...replaced, data: { label: 'next', optional: undefined } },
    { ...replaced, idempotencyKey: 'fresh-object', data: { label: 'next', optional: undefined } },
    { ...patched, set: { optional: 'ok', extra: undefined } },
    { ...patched, idempotencyKey: 'fresh-set', set: { optional: 'ok', extra: undefined } },
    { ...patched, unset: [undefined] },
    { ...patched, unset: 'optional' },
    { ...patched, unset: ['optional', 'optional'] },
    { ...patched, unset: ['optional'], set: { optional: 'ok' } },
    { ...created, idempotencyKey: 'sparse', data: { label: 'item', tags: sparse } },
    { ...created, idempotencyKey: 'circular', data: circular },
    { ...created, idempotencyKey: 'nonfinite', data: { label: 'item', optional: Infinity } }
  ]) {
    code(() => db.mutate(request), request.operation === 'patch' && request.unset !== patched.unset ? 'INVALID_ARGUMENT' : 'SCHEMA_INVALID');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.mutate(replaced).replayed, true);
  assert.deepEqual(snapshot(), before);
  db.revoke('sp_a', 'agent');
  code(() => db.mutate(created), 'FORBIDDEN');
  code(() => db.mutate({ ...created, data: { label: 'item', tags: [undefined] } }), 'FORBIDDEN');
});

test('delete tombstones prevent key reuse and projection resurrection', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry', state: 'open' }, 'one').ref.id;
  db.rebuild();
  assert.equal(db.projectionStatus({ ...scope, id }), 'current');
  write(db, 'delete', id, 1, 'delete');
  assert.equal(db.get({ ...scope, id }), null);
  assert.equal(db.count(scope), 0);
  code(() => create(db, 'item', { label: 'new' }, 'two'), 'KEY_RESERVED');
  code(() => create(db, 'different', { label: 'entry', state: 'open' }, 'three'), 'KEY_RESERVED');
  db.rebuild();
  assert.equal(db.projectionStatus({ ...scope, id }), null);
  assert.equal(db.projection.size, 0);
});

test('live keyset cursor is bound to credential/policy/schema and pages are not snapshots', () => {
  const db = setup();
  for (const n of ['a', 'b', 'c']) create(db, n, { label: n }, `create-${n}`);
  const first = db.query({ ...scope, limit: 1 });
  assert.equal(first.items.length, 1);
  const second = db.query({ ...scope, limit: 1, cursor: first.cursor });
  assert.notEqual(first.items[0].id, second.items[0].id);
  code(() => db.query({ ...scope, spaceId: 'sp_b', limit: 1, cursor: first.cursor }), 'CURSOR_INVALID');
  code(() => db.query({ ...scope, limit: 1, cursor: `${first.cursor}garbage` }), 'CURSOR_INVALID');
  const forged = JSON.parse(Buffer.from(first.cursor, 'base64url').toString());
  forged.after = 'rec_999';
  code(() => db.query({ ...scope, limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }), 'CURSOR_INVALID');
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  code(() => db.query({ ...scope, limit: 1, cursor: first.cursor }), 'CURSOR_INVALID');
  db.revoke('sp_a', 'agent');
  code(() => db.query({ ...scope, limit: 1, cursor: second.cursor }), 'FORBIDDEN');
});

test('default keyset ordering uses creation time then ID across ID width boundaries', () => {
  const db = setup();
  const ids = [];
  for (let n = 1; n <= 12; n++) ids.push(create(db, `key-${n}`, { label: `entry-${n}` }, `create-${n}`).ref.id);
  // Force a timestamp tie across the ID-width boundary; the oracle's synthetic clock normally never ties.
  for (const record of db.spaces.get('sp_a').collections.get('entries').records.values()) record.createdAt = '2020-01-01T00:00:00.001Z';
  const byId = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const received = [];
  let cursor;
  do {
    const page = db.query({ ...scope, limit: 3, cursor });
    received.push(...page.items.map(item => item.id));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(received, byId);
  assert.deepEqual(received.slice(0, 4), ['rec_1', 'rec_10', 'rec_11', 'rec_12']);
  assert.equal(db.get({ ...scope, id: ids[0] }).createdAt, db.get({ ...scope, id: ids[9] }).createdAt);
  const first = db.query({ ...scope, limit: 2 });
  create(db, 'later', { label: 'later' }, 'later');
  const rest = db.query({ ...scope, limit: 20, cursor: first.cursor });
  assert.deepEqual(rest.items.map(item => item.id), [...byId.slice(2), 'rec_13']);
});

test('grants remain independent by credential and collection, with no implicit wildcard', () => {
  const db = setup();
  db.define('sp_a', 'notes', schema);
  db.grant('sp_a', 'agent', 'notes', recordAccess);
  const a = create(db, 'a', { label: 'entry' }, 'one');
  const b = db.mutate({ ...scope, collection: 'notes', operation: 'create', data: { label: 'memo' }, idempotencyKey: 'two' });
  assert.equal(db.get({ ...scope, id: a.ref.id }).data.label, 'entry');
  assert.equal(db.get({ ...scope, collection: 'notes', id: b.ref.id }).data.label, 'memo');
  code(() => db.grant('sp_a', 'wild', '*', recordAccess), 'INVALID_ARGUMENT');
  code(() => db.get({ ...scope, credential: 'wild', id: a.ref.id }), 'FORBIDDEN');
  db.revoke('sp_a', 'agent', 'notes');
  code(() => db.get({ ...scope, collection: 'notes', id: b.ref.id }), 'FORBIDDEN');
  code(() => db.mutate({ ...scope, collection: 'notes', operation: 'create', data: { label: 'memo' }, idempotencyKey: 'two' }), 'FORBIDDEN');
  assert.equal(db.get({ ...scope, id: a.ref.id }).data.label, 'entry');
  db.grant('sp_a', 'agent', 'entries', ['records:read']);
  code(() => create(db, 'another', { label: 'entry' }, 'three'), 'FORBIDDEN');
});

test('rebuild projects current revisions only and never changes authoritative record fields', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry', state: 'open' }, 'one').ref.id;
  assert.equal(db.projectionStatus({ ...scope, id }), 'pending');
  const exact = db.get({ ...scope, id });
  db.rebuild();
  assert.equal(db.projectionStatus({ ...scope, id }), 'current');
  assert.deepEqual(db.get({ ...scope, id }), exact);
  write(db, 'replace', id, 1, 'two', { data: { label: 'entry', state: 'closed' } });
  assert.equal(db.projectionStatus({ ...scope, id }), 'pending');
  db.rebuild();
  assert.equal(db.projectionStatus({ ...scope, id }), 'current');
  assert.equal(db.get({ ...scope, id }).data.state, 'closed');
});

test('definition fails closed on unsupported schema, and suspended/readOnly lifecycle gates writes and replay', () => {
  const db = setup();
  code(() => db.define('sp_a', 'invalid', { ...schema, $ref: 'whatever' }), 'SCHEMA_UNSUPPORTED');
  const id = create(db, 'item', { label: 'entry' }, 'one').ref.id;
  db.lifecycle('sp_a', 'readOnly');
  assert.equal(db.get({ ...scope, id }).revision, 1);
  const replay = db.mutate({ ...scope, operation: 'create', externalKey: 'item', data: { label: 'entry' }, idempotencyKey: 'one' });
  assert.equal(replay.replayed, true);
  code(() => create(db, 'new', { label: 'new' }, 'two'), 'SPACE_UNAVAILABLE');
  db.lifecycle('sp_a', 'suspended');
  code(() => db.get({ ...scope, id }), 'SPACE_UNAVAILABLE');
  code(() => db.mutate({ ...scope, operation: 'create', externalKey: 'item', data: { label: 'entry' }, idempotencyKey: 'one' }), 'SPACE_UNAVAILABLE');
});

test('definition rejects scalar roots, open nested objects and nullable non-scalars before writes', () => {
  const db = setup();
  const closed = { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false };
  for (const [name, invalid] of [
    ['scalar', { ...schema, type: 'string' }],
    ['nullable-root', { ...schema, type: ['object', 'null'] }],
    ['open-child', { ...schema, required: [], properties: { item: { type: 'object', properties: closed.properties } } }],
    ['nullable-child', { ...schema, required: [], properties: { item: { ...closed, type: ['object', 'null'] } } }],
    ['open-array-item', { ...schema, required: [], properties: { items: { type: 'array', items: { type: 'object', properties: closed.properties } } } }],
    ['nullable-array-item', { ...schema, required: [], properties: { items: { type: 'array', items: { ...closed, type: ['object', 'null'] } } } }],
    ['untyped', { ...schema, required: [], properties: { item: { description: 'missing type' } } }]
  ]) code(() => db.define('sp_a', name, invalid), 'SCHEMA_UNSUPPORTED');
  db.define('sp_a', 'nested', { ...schema, required: ['item'], properties: { item: { type: 'array', items: closed } } });
  db.grant('sp_a', 'agent', 'nested', recordAccess);
  const valid = db.mutate({ ...scope, collection: 'nested', operation: 'create', data: { item: [{ label: 'fine' }] }, idempotencyKey: 'valid' });
  assert.equal(valid.revision, 1);
  code(() => db.mutate({ ...scope, collection: 'nested', operation: 'create', data: { item: [{ label: 'fine', surprise: true }] }, idempotencyKey: 'bad' }), 'SCHEMA_INVALID');
});

test('schema type arrays require a two-member nullable scalar union at define and revise', () => {
  const db = setup();
  const c = db.spaces.get('sp_a').collections.get('entries');
  const first = create(db, 'first', { label: 'first' }, 'first');
  const before = [db.events.length, db.outbox.length, db.receipts.size, c.records.size, c.reserved.size];
  const child = shape => ({ ...schema, properties: { ...schema.properties, optional: shape } });
  const invalid = [
    { type: ['string'] },
    { type: ['object'], additionalProperties: false, properties: {} },
    { type: ['array'], items: { type: 'string' } },
    { type: 'array', items: { type: ['string'] } }
  ];
  for (const [index, shape] of invalid.entries()) {
    const candidate = child(shape);
    code(() => db.define('sp_a', `invalid-${index}`, candidate), 'SCHEMA_UNSUPPORTED');
    code(() => db.revise('sp_a', 'entries', 1, candidate), 'SCHEMA_UNSUPPORTED');
    assert.equal(c.version, 1);
    assert.equal(db.spaces.get('sp_a').collections.has(`invalid-${index}`), false);
    assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size, c.records.size, c.reserved.size], before);
  }
  assert.equal(db.get({ ...scope, id: first.ref.id }).revision, 1);
  db.define('sp_a', 'scalar', child({ type: 'string' }));
  assert.equal(db.revise('sp_a', 'entries', 1, child({ type: ['string', 'null'] })), 2);
});

test('accepted schema and uniqueness definitions are snapshots of caller input', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const input = structuredClone(schema);
  const constraints = [{ name: 'label', paths: ['label'] }];
  db.define('sp_a', 'entries', input, constraints);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const first = create(db, 'first', { label: 'shared' }, 'one');
  input.properties.label.type = 'number';
  input.properties.state.enum.push('invented');
  constraints[0].paths[0] = 'state';
  constraints[0].name = 'changed';
  code(() => create(db, 'second', { label: 'shared' }, 'two'), 'UNIQUE_CONFLICT');
  code(() => create(db, 'third', { label: 'different', state: 'invented' }, 'three'), 'SCHEMA_INVALID');
  const replacement = write(db, 'replace', first.ref.id, 1, 'four', { data: { label: 'updated' } });
  assert.equal(replacement.schemaVersion, 1);
  create(db, 'fourth', { label: 'shared' }, 'five');
});

test('schema versions admit only compatible optional additions and stale schema change fails', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry' }, 'one').ref.id;
  const added = { ...schema, properties: { ...schema.properties, note: { type: 'string' } } };
  code(() => db.revise('sp_a', 'entries', 1, { ...schema, required: ['label', 'state'] }), 'SCHEMA_BREAKING');
  assert.equal(db.revise('sp_a', 'entries', 1, added), 2);
  code(() => db.revise('sp_a', 'entries', 1, added), 'SCHEMA_CONFLICT');
  assert.equal(db.get({ ...scope, id }).schemaVersion, 1);
  write(db, 'patch', id, 1, 'two', { set: { note: 'synthetic' }, unset: [] });
  assert.equal(db.get({ ...scope, id }).schemaVersion, 2);
});

test('caller schema precondition participates in fingerprint but compatible revision does not break replay', () => {
  const db = setup();
  const id = create(db, 'item', { label: 'entry' }, 'one').ref.id;
  const request = { data: { label: 'entry', state: 'open' }, expectedSchemaVersion: 1 };
  const receipt = write(db, 'replace', id, 1, 'lost', request);
  const added = { ...schema, properties: { ...schema.properties, note: { type: 'string' } } };
  db.revise('sp_a', 'entries', 1, added);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  assert.equal(write(db, 'replace', id, 1, 'lost', request).receiptId, receipt.receiptId);
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  code(() => write(db, 'replace', id, 1, 'lost', { data: request.data, expectedSchemaVersion: 2 }), 'IDEMPOTENCY_MISMATCH');
  code(() => write(db, 'replace', id, 1, 'new', request), 'SCHEMA_CONFLICT');
  write(db, 'replace', id, 2, 'next', { data: request.data, expectedSchemaVersion: 2 });
  assert.equal(db.get({ ...scope, id }).revision, 3);
});

test('definition rejects invalid keyword values and measures string lengths in Unicode codepoints', () => {
  const db = setup();
  const withLabel = shape => ({ ...schema, properties: { ...schema.properties, label: shape } });
  for (const [name, shape] of [
    ['negative-length', { type: 'string', minLength: -1 }],
    ['fractional-length', { type: 'string', maxLength: 1.5 }],
    ['inverted-length', { type: 'string', minLength: 2, maxLength: 1 }],
    ['bad-minimum', { type: 'number', minimum: 'a' }],
    ['infinite-maximum', { type: 'number', maximum: Infinity }],
    ['inverted-bounds', { type: 'number', minimum: 2, maximum: 1 }],
    ['scalar-enum', { type: 'string', enum: 'x' }],
    ['empty-enum', { type: 'string', enum: [] }],
    ['wrong-type-enum', { type: 'string', enum: [1] }],
    ['wrong-description', { type: 'string', description: false }],
    ['duplicate-type', { type: ['string', 'string'] }],
    ['bad-item-bounds', { type: 'array', items: { type: 'string' }, minItems: -1 }]
  ]) code(() => db.define('sp_a', name, withLabel(shape)), 'SCHEMA_UNSUPPORTED');
  db.define('sp_a', 'unicode', withLabel({ type: 'string', minLength: 2, maxLength: 2 }));
  db.grant('sp_a', 'agent', 'unicode', recordAccess);
  const unicodeScope = { ...scope, collection: 'unicode', operation: 'create' };
  code(() => db.mutate({ ...unicodeScope, data: { label: '💫' }, idempotencyKey: 'one' }), 'SCHEMA_INVALID');
  const receipt = db.mutate({ ...unicodeScope, data: { label: '💫a' }, idempotencyKey: 'two' });
  assert.equal(receipt.revision, 1);
  code(() => db.mutate({ ...unicodeScope, data: { label: '💫ab' }, idempotencyKey: 'three' }), 'SCHEMA_INVALID');
});

test('compatibility compares the schema of a field literally named description', () => {
  const db = setup();
  const original = { ...schema, properties: { ...schema.properties, description: { type: 'string', description: 'annotation one' } } };
  assert.equal(db.revise('sp_a', 'entries', 1, original), 2);
  const id = create(db, 'item', { label: 'entry', description: 'value' }, 'one').ref.id;
  const changed = { ...original, properties: { ...original.properties, description: { type: 'number' } } };
  code(() => db.revise('sp_a', 'entries', 2, changed), 'SCHEMA_BREAKING');
  assert.equal(db.get({ ...scope, id }).data.description, 'value');
  assert.equal(db.revise('sp_a', 'entries', 2, { ...original, properties: { ...original.properties, description: { ...original.properties.description, description: 'annotation two' } } }), 3);
  assert.equal(write(db, 'replace', id, 1, 'two', { data: { label: 'entry', description: 'still valid' } }).schemaVersion, 3);
});

test('key normalization uses the fixed Unicode White_Space set, not JS trim', () => {
  const db = setup();
  create(db, '\u0085e\u0301\u2000', { label: 'a' }, 'one');
  code(() => create(db, '\u00e9', { label: 'b' }, 'two'), 'UNIQUE_CONFLICT');
  code(() => create(db, '\u0085', { label: 'b' }, 'three'), 'INVALID_ARGUMENT');
  create(db, '\ufeff\u00e9', { label: 'b' }, 'four'); // FEFF is not in the published set
});

test('optional sort keyset distinguishes missing/null/value in either direction with ID ties', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', schema, [], ['ordinal']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const entries = [
    ['value-2', { label: 'v2', ordinal: 2 }],
    ['missing-1', { label: 'm1' }],
    ['null-1', { label: 'n1', ordinal: null }],
    ['value-1', { label: 'v1', ordinal: 1 }],
    ['missing-2', { label: 'm2' }],
    ['null-2', { label: 'n2', ordinal: null }],
    ['value-1b', { label: 'v1b', ordinal: 1 }]
  ];
  for (const [key, data] of entries) create(db, key, data, key);
  const pageAll = direction => {
    const seen = [];
    let cursor;
    do {
      const page = db.query({ ...scope, limit: 2, sort: { field: 'ordinal', direction }, cursor });
      seen.push(...page.items.map(item => item.key));
      if (cursor === undefined && page.cursor) code(() => db.query({ ...scope, limit: 2, cursor: page.cursor }), 'CURSOR_INVALID');
      cursor = page.cursor;
    } while (cursor);
    return seen;
  };
  assert.deepEqual(pageAll('asc'), ['missing-1', 'missing-2', 'null-1', 'null-2', 'value-1', 'value-1b', 'value-2']);
  assert.deepEqual(pageAll('desc'), ['value-2', 'value-1', 'value-1b', 'null-1', 'null-2', 'missing-1', 'missing-2']);
  code(() => db.query({ ...scope, limit: 2, sort: { field: 'label', direction: 'asc' } }), 'INVALID_ARGUMENT');
});

test('query, count and exists validate one own-data sort snapshot before cursor binding', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', schema, [], ['label']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  create(db, 'one', { label: 'a', ordinal: 2 }, 'one');
  create(db, 'two', { label: 'b', ordinal: 1 }, 'two');
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const effects = () => structuredClone({ records: [...collection.records], reserved: [...collection.reserved],
    events: db.events, outbox: db.outbox, receipts: [...db.receipts], seq: db.seq });
  const before = effects();
  let getterCalls = 0;
  const fieldGetter = { direction: 'asc' };
  Object.defineProperty(fieldGetter, 'field', { enumerable: true, get() {
    getterCalls++;
    return getterCalls === 1 ? 'label' : 'ordinal';
  } });
  const directionGetter = { field: 'label' };
  Object.defineProperty(directionGetter, 'direction', { enumerable: true, get() {
    getterCalls++;
    return getterCalls === 1 ? 'asc' : 'desc';
  } });
  const throwing = { direction: 'asc' };
  Object.defineProperty(throwing, 'field', { enumerable: true, get() { throw Error('getter invoked'); } });
  const hidden = { field: 'label', direction: 'asc' };
  Object.defineProperty(hidden, 'field', { value: 'label', enumerable: false });
  const hiddenDirection = { field: 'label', direction: 'asc' };
  Object.defineProperty(hiddenDirection, 'direction', { value: 'asc', enumerable: false });
  const inherited = Object.assign(Object.create({ field: 'label' }), { direction: 'asc' });
  const inheritedDirection = Object.assign(Object.create({ direction: 'asc' }), { field: 'label' });
  const symbol = { field: 'label', direction: 'asc', [Symbol('extra')]: true };
  const decorated = { field: 'label', direction: 'asc', extra: true };
  let proxyTraps = 0;
  const proxy = new Proxy({ field: 'label', direction: 'asc' }, { ownKeys() {
    proxyTraps++;
    throw Error('proxy trap invoked');
  } });
  const revoked = Proxy.revocable({ field: 'label', direction: 'asc' }, {});
  revoked.revoke();
  for (const sort of [fieldGetter, directionGetter, throwing, hidden, hiddenDirection, inherited,
    inheritedDirection, symbol, decorated, new Proxy({ field: 'label', direction: 'asc' }, {}),
    proxy, revoked.proxy, { field: 'ordinal', direction: 'asc' }, { field: 'label', direction: 'up' }, null]) {
    for (const run of [() => db.query({ ...scope, limit: 1, sort }),
      () => db.count({ ...scope, sort }), () => db.exists({ ...scope, sort })]) {
      code(run, 'INVALID_ARGUMENT');
      assert.deepEqual(effects(), before);
    }
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
  const sort = { field: 'label', direction: 'asc' };
  assert.deepEqual(db.query({ ...scope, limit: 2,
    sort: Object.assign(Object.create(null), sort) }).items.map(row => row.key), ['one', 'two']);
  const page = db.query({ ...scope, limit: 1, sort });
  assert.deepEqual(page.items.map(row => row.key), ['one']);
  assert.deepEqual(db.query({ ...scope, limit: 1, sort, cursor: page.cursor }).items.map(row => row.key), ['two']);
  code(() => db.query({ ...scope, limit: 1, cursor: page.cursor, sort: { field: 'label', direction: 'desc' } }), 'CURSOR_INVALID');
  assert.deepEqual(db.query({ ...scope, limit: 2, sort: { field: 'label', direction: 'desc' } }).items.map(row => row.key), ['two', 'one']);
  assert.equal(db.count({ ...scope, sort }), 2);
  assert.equal(db.exists({ ...scope, sort }), true);
  code(() => db.count({ ...scope, sort, cursor: page.cursor }), 'INVALID_ARGUMENT');
  code(() => db.exists({ ...scope, sort, cursor: page.cursor }), 'INVALID_ARGUMENT');
  db.revoke('sp_a', 'agent', 'entries');
  code(() => db.query({ ...scope, limit: 1, sort: fieldGetter }), 'FORBIDDEN');
  code(() => db.count({ ...scope, sort: fieldGetter }), 'FORBIDDEN');
  code(() => db.exists({ ...scope, sort: fieldGetter }), 'FORBIDDEN');
  assert.equal(getterCalls, 0);
});

test('date-time sort compares UTC instants including fractional seconds, not encoded text', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', {
    $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { observedAt: { type: 'string', format: 'date-time' } }
  }, [], ['observedAt']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  for (const [key, observedAt] of [
    ['later', '2026-09-23T12:00:00.12Z'],
    ['whole', '2026-09-23T12:00:00Z'],
    ['early', '2026-09-23T12:00:00.003Z'],
    ['equal', '2026-09-23T12:00:00.0Z']
  ]) create(db, key, { observedAt }, key);
  const sort = { field: 'observedAt', direction: 'asc' };
  const first = db.query({ ...scope, limit: 2, sort });
  assert.deepEqual(first.items.map(item => item.key), ['whole', 'equal']);
  assert.deepEqual(db.query({ ...scope, limit: 2, sort, cursor: first.cursor }).items.map(item => item.key), ['early', 'later']);
});

test('receipt identity cannot disclose a revoked original collection through another collection', () => {
  const db = setup();
  db.define('sp_a', 'other', schema);
  db.grant('sp_a', 'agent', 'other', recordAccess);
  const original = { ...scope, operation: 'create', externalKey: 'first', data: { label: 'first' }, idempotencyKey: 'shared' };
  db.mutate(original);
  db.revoke('sp_a', 'agent', 'entries');
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  code(() => db.mutate({ ...original, collection: 'other', externalKey: 'second' }), 'FORBIDDEN');
  code(() => db.mutate({ ...original, collection: 'other', data: { label: undefined } }), 'FORBIDDEN');
  code(() => db.mutate(original), 'FORBIDDEN');
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  assert.equal(db.mutate({ ...original, collection: 'other', externalKey: 'second', idempotencyKey: 'fresh' }).revision, 1);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  assert.equal(db.mutate(original).replayed, true);
  code(() => db.mutate({ ...original, collection: 'other', externalKey: 'second' }), 'IDEMPOTENCY_MISMATCH');
});

test('unsupported filters fail closed for pages, exact count and exists', () => {
  const db = setup();
  create(db, 'one', { label: 'present' }, 'one');
  const filter = { field: 'label', op: 'eq', value: 'absent' };
  for (const run of [() => db.query({ ...scope, limit: 1, filter }),
    () => db.count({ ...scope, filter }), () => db.exists({ ...scope, filter }),
    () => db.query({ ...scope, limit: 1, filter: null })]) code(run, 'INVALID_ARGUMENT');
  assert.equal(db.count(scope), 1);
  assert.equal(db.exists(scope), true);
});

test('malformed child schema nodes fail as unsupported definitions and revisions', () => {
  const db = setup();
  const invalid = [null, 'string', [], { type: 'array' }, { type: 'object', properties: { inner: null }, additionalProperties: false }];
  for (const [index, child] of invalid.entries()) {
    const malformed = { ...schema, properties: { ...schema.properties, bad: child } };
    code(() => db.define('sp_a', `bad-${index}`, malformed), 'SCHEMA_UNSUPPORTED');
    code(() => db.revise('sp_a', 'entries', 1, malformed), 'SCHEMA_UNSUPPORTED');
  }
  assert.equal(db.revise('sp_a', 'entries', 1, { ...schema, properties: { ...schema.properties, valid: { type: 'string' } } }), 2);
});

test('v1 compatible schema additions are top-level only', () => {
  const db = setup();
  const nested = { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false };
  const first = { ...schema, properties: { ...schema.properties, detail: nested } };
  assert.equal(db.revise('sp_a', 'entries', 1, first), 2);
  const nestedAddition = { ...first, properties: { ...first.properties, detail: { ...nested, properties: { ...nested.properties, note: { type: 'string' } } } } };
  code(() => db.revise('sp_a', 'entries', 2, nestedAddition), 'SCHEMA_BREAKING');
  assert.equal(db.revise('sp_a', 'entries', 2, { ...first, properties: { ...first.properties, topLevelNote: { type: 'string' } } }), 3);
});

test('fingerprint uses locale-independent UTF-8 key ordering and replays reordered objects', () => {
  const db = setup();
  db.define('sp_a', 'unicode', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { 'é': { type: 'string' }, z: { type: 'string' } } });
  db.grant('sp_a', 'agent', 'unicode', recordAccess);
  const request = { ...scope, collection: 'unicode', operation: 'create', externalKey: 'key', data: { 'é': 'accent', z: 'plain' }, idempotencyKey: 'unicode-key' };
  const committed = db.mutate(request);
  const expected = createHash('sha256').update('{"actor":"agent","collection":"unicode","data":{"z":"plain","é":"accent"},"externalKey":"key","operation":"create"}').digest('hex');
  assert.equal([...db.receipts.values()].at(-1).fingerprint, expected);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  const replay = db.mutate({ ...request, data: { z: 'plain', 'é': 'accent' } });
  assert.equal(replay.receiptId, committed.receiptId);
  assert.equal(replay.replayed, true);
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  db.define('sp_a', 'indexed', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { '2': { type: 'string' }, '10': { type: 'string' } } });
  db.grant('sp_a', 'agent', 'indexed', recordAccess);
  db.mutate({ ...request, collection: 'indexed', data: { '2': 'second', '10': 'tenth' }, idempotencyKey: 'numeric-keys' });
  const numeric = createHash('sha256').update('{"actor":"agent","collection":"indexed","data":{"10":"tenth","2":"second"},"externalKey":"key","operation":"create"}').digest('hex');
  assert.equal([...db.receipts.values()].at(-1).fingerprint, numeric);
});

test('unique constraint names are distinct within a collection and independent across constraints', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const constraints = [{ name: 'dup', paths: ['label'] }, { name: 'dup', paths: ['state'] }];
  code(() => db.define('sp_a', 'entries', schema, constraints), 'SCHEMA_UNSUPPORTED');
  db.define('sp_a', 'entries', schema, [{ name: 'by_label', paths: ['label'] }, { name: 'by_state', paths: ['state'] }]);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  create(db, 'one', { label: 'x', state: 'open' }, 'one');
  create(db, 'two', { label: 'open', state: 'closed' }, 'two');
  code(() => create(db, 'three', { label: 'x', state: 'closed' }, 'three'), 'UNIQUE_CONFLICT');
  assert.equal(db.count(scope), 2);
});

test('patch rejects unknown or required unset without effects, but permits absent optional unset', () => {
  const db = setup();
  const id = create(db, 'one', { label: 'entry' }, 'one').ref.id;
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  for (const unset of [['misspelled'], ['label'], ['state', 'state']]) {
    code(() => write(db, 'patch', id, 1, `bad-${unset.join('-')}`, { set: {}, unset }), 'INVALID_ARGUMENT');
    assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
    assert.equal(db.get({ ...scope, id }).revision, 1);
  }
  assert.equal(write(db, 'patch', id, 1, 'noop', { set: {}, unset: ['state'] }).revision, 2);
  assert.deepEqual(db.get({ ...scope, id }).data, { label: 'entry' });
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before.map(n => n + 1));
});

test('unpaired surrogate external keys and composite string data fail before effects', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  code(() => db.define('sp_a', 'bad-property', { ...schema, properties: { '\uD800': { type: 'string' } } }), 'SCHEMA_UNSUPPORTED');
  code(() => db.define('sp_a', 'bad-description', { ...schema, description: '\uDC00' }), 'SCHEMA_UNSUPPORTED');
  code(() => db.define('sp_a', 'bad-constraint', schema, [{ name: '\uD800', paths: ['label'] }]), 'SCHEMA_UNSUPPORTED');
  db.define('sp_a', 'entries', schema, [{ name: 'label', paths: ['label'] }]);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  for (const invalid of ['\uD800x', 'x\uDC00', '\uD800']) {
    code(() => create(db, invalid, { label: 'valid' }, `key-${invalid}`), 'INVALID_ARGUMENT');
    code(() => create(db, 'valid', { label: invalid }, `data-${invalid}`), 'SCHEMA_INVALID');
    assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  }
  const good = create(db, '\uD83D\uDCAB', { label: '\uD83D\uDCAB' }, 'pair');
  assert.equal(db.get({ ...scope, id: good.ref.id }).key, '\uD83D\uDCAB');
  code(() => create(db, 'second', { label: '\uD83D\uDCAB' }, 'collision'), 'UNIQUE_CONFLICT');
});

test('unique and sortable paths must be declared scalar property names, not coerced values', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const numericProperty = { ...schema, properties: { ...schema.properties, '1': { type: 'string' } } };
  for (const path of [1, '', 'missing', 'label.part', '\uD800']) {
    code(() => db.define('sp_a', 'entries', numericProperty, [{ name: 'key', paths: [path] }]), 'SCHEMA_UNSUPPORTED');
    code(() => db.define('sp_a', 'entries', numericProperty, [], [path]), 'SCHEMA_UNSUPPORTED');
  }
  db.define('sp_a', 'entries', numericProperty, [{ name: 'key', paths: ['1'] }], ['1']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  create(db, 'one', { label: 'first', '1': 'same' }, 'one');
  code(() => create(db, 'two', { label: 'second', '1': 'same' }, 'two'), 'UNIQUE_CONFLICT');
});

test('only an absent cursor starts a first page; malformed supplied tokens fail with a stable code', () => {
  const db = setup();
  for (const key of ['one', 'two']) create(db, key, { label: key }, key);
  const first = db.query({ ...scope, limit: 1 });
  assert.ok(first.cursor);
  for (const cursor of ['', null, 0, false, {}, 'not-base64!',
    ...['null', '[]', '"text"', '0', '{}'].map(value => Buffer.from(value).toString('base64url'))]) {
    code(() => db.query({ ...scope, limit: 1, cursor }), 'CURSOR_INVALID');
  }
  assert.equal(db.query({ ...scope, limit: 1, cursor: first.cursor }).items[0].key, 'two');
  assert.equal(db.query({ ...scope, limit: 1 }).items[0].key, 'one');
});

test('mutation-specific payloads reject ignored fields before receipt lookup or effects', () => {
  const db = setup();
  const request = { ...scope, operation: 'create', externalKey: 'first', data: { label: 'first' }, idempotencyKey: 'first' };
  const first = db.mutate(request);
  const snapshot = () => ({ record: db.get({ ...scope, id: first.ref.id }),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox),
    receipts: db.receipts.size, reserved: db.spaces.get('sp_a').collections.get('entries').reserved.size });
  const before = snapshot();
  const failures = [
    { ...request, id: first.ref.id },
    { ...request, set: { label: 'ignored' } },
    { ...request, unset: ['state'] },
    { ...request, unused: 'ignored' },
    { ...scope, operation: 'replace', id: first.ref.id, expectedRevision: 1, data: { label: 'changed' }, set: {}, idempotencyKey: 'bad-replace' },
    { ...scope, operation: 'replace', id: first.ref.id, expectedRevision: 1, data: { label: 'changed' }, unset: [], idempotencyKey: 'bad-replace-unset' },
    { ...scope, operation: 'patch', id: first.ref.id, expectedRevision: 1, set: {}, unset: [], data: { label: 'ignored' }, idempotencyKey: 'bad-patch' },
    { ...scope, operation: 'delete', id: first.ref.id, expectedRevision: 1, data: { label: 'ignored' }, idempotencyKey: 'bad-delete' },
    { ...scope, operation: 'delete', id: first.ref.id, expectedRevision: 1, set: {}, idempotencyKey: 'bad-delete-set' },
    { ...scope, operation: 'delete', id: first.ref.id, expectedRevision: 1, unset: [], idempotencyKey: 'bad-delete-unset' }
  ];
  for (const invalid of failures) {
    code(() => db.mutate(invalid), 'INVALID_ARGUMENT');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.mutate(request).replayed, true);
  assert.deepEqual(snapshot(), before);
  assert.equal(write(db, 'delete', first.ref.id, 1, 'valid-delete').revision, 2);
});

test('replay needs a current write grant on both requested and original collections', () => {
  const db = setup();
  db.define('sp_a', 'other', schema);
  db.grant('sp_a', 'agent', 'other', recordAccess);
  const request = { ...scope, operation: 'create', externalKey: 'first', data: { label: 'first' }, idempotencyKey: 'shared' };
  const committed = db.mutate(request);
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  db.grant('sp_a', 'agent', 'entries', ['records:read']);
  assert.equal(db.count(scope), 1);
  code(() => db.mutate(request), 'FORBIDDEN');
  code(() => db.mutate({ ...request, collection: 'other', externalKey: 'different' }), 'FORBIDDEN');
  db.grant('sp_a', 'agent', 'entries', ['records:write']);
  assert.equal(db.mutate(request).receiptId, committed.receiptId);
  db.grant('sp_a', 'agent', 'other', ['records:read']);
  code(() => db.mutate({ ...request, collection: 'other', externalKey: 'different' }), 'FORBIDDEN');
  db.lifecycle('sp_a', 'readOnly');
  assert.equal(db.mutate(request).replayed, true);
  code(() => db.mutate({ ...request, idempotencyKey: 'new' }), 'SPACE_UNAVAILABLE');
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
});

test('count and exists reject page cursors rather than narrowing the exact query', () => {
  const db = setup();
  for (const key of ['a', 'b', 'c']) create(db, key, { label: key }, key);
  const first = db.query({ ...scope, limit: 1 });
  assert.ok(first.cursor);
  for (const cursor of [first.cursor, null, '']) {
    code(() => db.count({ ...scope, cursor }), 'INVALID_ARGUMENT');
    code(() => db.exists({ ...scope, cursor }), 'INVALID_ARGUMENT');
  }
  assert.equal(db.count(scope), 3);
  assert.equal(db.exists(scope), true);
  assert.equal(db.count({ ...scope, cursor: undefined }), 3);
  for (const id of db.query({ ...scope, limit: 3 }).items.slice(1).map(record => record.id)) {
    write(db, 'delete', id, 1, `delete-${id}`);
  }
  assert.equal(db.count(scope), 1);
  assert.equal(db.exists(scope), true);
  code(() => db.exists({ ...scope, cursor: first.cursor }), 'INVALID_ARGUMENT');
});

test('composite string reservations use NFC but never change stored data spelling', () => {
  const db = setup();
  const original = 'e\u0301';
  const first = create(db, 'first', { label: original, state: 'open' }, 'one');
  assert.equal(db.get({ ...scope, id: first.ref.id }).data.label, original);
  code(() => create(db, 'second', { label: '\u00e9', state: 'open' }, 'two'), 'UNIQUE_CONFLICT');
  assert.equal(db.get({ ...scope, id: first.ref.id }).data.label, original);
  create(db, 'third', { label: '\u00e9', state: 'closed' }, 'three');
});

test('optional prototype-named unique fields are absent unless own, even on null-prototype data', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const named = { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { toString: { type: 'string' }, constructor: { type: 'string' } } };
  db.define('sp_a', 'entries', named, [{ name: 'named', paths: ['toString', 'constructor'] }]);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const one = create(db, 'one', {}, 'one');
  create(db, 'two', { toString: 'a' }, 'two');
  const data = Object.assign(Object.create(null), { toString: 'a', constructor: 'b' });
  const third = create(db, 'three', data, 'three');
  assert.equal(Object.hasOwn(db.get({ ...scope, id: one.ref.id }).data, 'toString'), false);
  assert.deepEqual(db.get({ ...scope, id: third.ref.id }).data, { toString: 'a', constructor: 'b' });
  code(() => create(db, 'four', { toString: 'a', constructor: 'b' }, 'four'), 'UNIQUE_CONFLICT');
});

test('non-JSON object instances fail at root and nested schema paths without effects', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const nested = { type: 'object', properties: {}, additionalProperties: false };
  db.define('sp_a', 'entries', { $schema: schema.$schema, type: 'object', properties: { child: nested }, additionalProperties: false });
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  for (const [index, data] of [new Date(), new Map(), { child: new Date() }, { child: new Map() }].entries()) {
    code(() => create(db, `bad-${index}`, data, `bad-${index}`), 'SCHEMA_INVALID');
  }
  assert.equal(db.count(scope), 0);
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], [0, 0, 0]);
  assert.equal(create(db, 'plain', { child: {} }, 'plain').revision, 1);
});

test('proxied JSON-shaped inputs cannot escape definition, fingerprint or receipt validation', () => {
  const db = setup();
  const space = db.spaces.get('sp_a');
  const collection = space.collections.get('entries');
  const proxy = value => new Proxy(value, {});
  const revoked = Proxy.revocable({ type: 'string' }, {});
  revoked.revoke();
  const committed = create(db, 'original', { label: 'original' }, 'original');
  const snapshot = () => ({ collections: [...space.collections.keys()], version: collection.version,
    schema: structuredClone(collection.schema), rows: structuredClone([...collection.records]),
    reservations: [...collection.reserved].map(([key, row]) => [key, row.id, row.revision]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox),
    receipts: structuredClone([...db.receipts]), seq: db.seq });
  const before = snapshot();
  const invalidSchemas = [proxy(schema), { ...schema, properties: { ...schema.properties, label: proxy({ type: 'string' }) } },
    { ...schema, required: proxy(['label']) }, { ...schema, properties: proxy({ ...schema.properties }) },
    { ...schema, properties: { ...schema.properties, label: revoked.proxy } }];
  for (const [index, invalid] of invalidSchemas.entries()) {
    code(() => db.define('sp_a', `proxied-${index}`, invalid), 'SCHEMA_UNSUPPORTED');
    code(() => db.revise('sp_a', 'entries', 1, invalid), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual(snapshot(), before);
  }
  for (const [index, descriptors, sortable] of [
    [0, proxy(uniques), []], [1, [proxy({ name: 'other', paths: ['label'] })], []],
    [2, [{ name: 'other', paths: proxy(['label']) }], []], [3, [], proxy(['label'])]
  ]) {
    code(() => db.define('sp_a', `descriptor-${index}`, schema, descriptors, sortable), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual(snapshot(), before);
  }
  const createRequest = { ...scope, operation: 'create', externalKey: 'original', data: { label: 'original' }, idempotencyKey: 'original' };
  const invalidMutations = [
    { ...createRequest, data: proxy({ label: 'original' }) },
    { ...createRequest, data: { label: 'original', nested: proxy({}) } },
    { ...createRequest, idempotencyKey: 'fresh-proxy', data: proxy({ label: 'fresh' }) },
    { ...scope, operation: 'replace', id: committed.ref.id, expectedRevision: 1,
      idempotencyKey: 'replace-proxy', data: proxy({ label: 'next' }) },
    { ...scope, operation: 'patch', id: committed.ref.id, expectedRevision: 1,
      idempotencyKey: 'patch-proxy', set: proxy({ label: 'next' }), unset: [] }
  ];
  for (const invalid of invalidMutations) {
    code(() => db.mutate(invalid), invalid.operation === 'patch' ? 'INVALID_ARGUMENT' : 'SCHEMA_INVALID');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.mutate(createRequest).replayed, true);
  const patch = { ...scope, operation: 'patch', id: committed.ref.id, expectedRevision: 1,
    idempotencyKey: 'valid-patch', set: { label: 'next' }, unset: [] };
  assert.equal(db.mutate(patch).revision, 2);
  const afterPatch = snapshot();
  code(() => db.mutate({ ...patch, set: proxy({ label: 'next' }) }), 'INVALID_ARGUMENT');
  assert.deepEqual(snapshot(), afterPatch);
  assert.equal(db.mutate(patch).replayed, true);
});

test('proxied mutation envelopes fail before traps, receipts or writes across operations', () => {
  const db = setup();
  const created = { ...scope, operation: 'create', data: { label: 'one' }, idempotencyKey: 'create' };
  const id = db.mutate(created).ref.id;
  const replaced = { ...scope, operation: 'replace', id, expectedRevision: 1,
    data: { label: 'two' }, idempotencyKey: 'replace' };
  db.mutate(replaced);
  const patched = { ...scope, operation: 'patch', id, expectedRevision: 2,
    set: { label: 'three' }, unset: [], idempotencyKey: 'patch' };
  db.mutate(patched);
  const deleted = { ...scope, operation: 'delete', id, expectedRevision: 3, idempotencyKey: 'delete' };
  db.mutate(deleted);
  const c = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ rows: structuredClone([...c.records]),
    reservations: [...c.reserved].map(([key, row]) => [key, row.id, row.revision, row.deleted]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox),
    receipts: structuredClone([...db.receipts]), seq: db.seq });
  const committed = [created, replaced, patched, deleted];
  const fresh = committed.map(request => ({ ...request, idempotencyKey: `fresh-${request.operation}` }));
  for (const request of [...committed, ...fresh]) {
    let trapCalls = 0;
    const throwing = new Proxy(request, { getOwnPropertyDescriptor() {
      trapCalls++;
      throw new Error('descriptor trap invoked');
    } });
    const revoked = Proxy.revocable(request, {});
    revoked.revoke();
    for (const envelope of [new Proxy(request, {}), throwing, revoked.proxy]) {
      const before = snapshot();
      code(() => db.mutate(envelope), 'INVALID_ARGUMENT');
      assert.equal(trapCalls, 0);
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const request of committed) assert.equal(db.mutate(request).replayed, true);
  assert.equal(db.mutate({ ...scope, operation: 'create', data: { label: 'fresh' },
    idempotencyKey: 'ordinary-fresh' }).revision, 1);
});

test('schema size keywords accept nonnegative integer bounds beyond safe record-integer range', () => {
  const db = setup();
  const space = db.spaces.get('sp_a');
  const bound = 9007199254740992;
  const shape = property => ({ ...schema, properties: { ...schema.properties, extra: property } });
  for (const [index, property] of [
    { type: 'string', maxLength: bound }, { type: 'string', minLength: bound },
    { type: 'array', items: { type: 'string' }, maxItems: bound },
    { type: 'array', items: { type: 'string' }, minItems: bound }
  ].entries()) {
    db.define('sp_a', `large-${index}`, shape(property));
    const keyword = Object.keys(property).find(key => key.startsWith('min') || key.startsWith('max'));
    assert.equal(space.collections.get(`large-${index}`).schema.properties.extra[keyword], bound);
  }
  assert.equal(db.revise('sp_a', 'entries', 1, shape({ type: 'string', maxLength: bound })), 2);
  const before = { collections: space.collections.size, version: space.collections.get('entries').version,
    events: db.events.length, outbox: db.outbox.length, receipts: db.receipts.size };
  for (const [index, invalid] of [-1, 0.5, Infinity, NaN, '10'].entries()) {
    const malformed = shape({ type: 'string', maxLength: invalid });
    code(() => db.define('sp_a', `bad-${index}`, malformed), 'SCHEMA_UNSUPPORTED');
    code(() => db.revise('sp_a', 'entries', 2, malformed), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual({ collections: space.collections.size, version: space.collections.get('entries').version,
      events: db.events.length, outbox: db.outbox.length, receipts: db.receipts.size }, before);
  }
  assert.equal(create(db, 'normal', { label: 'normal' }, 'normal').revision, 1);
});

test('grant rejects non-contract capability tokens before policy changes', () => {
  const db = setup();
  const policy = db.spaces.get('sp_a').policyVersion;
  for (const invalid of [['read'], ['WRITE'], ['records:reed'], ['records:read', 'other'], 'records:read']) {
    code(() => db.grant('sp_a', 'new-agent', 'entries', invalid), 'INVALID_ARGUMENT');
  }
  assert.equal(db.spaces.get('sp_a').policyVersion, policy);
  code(() => db.get({ ...scope, credential: 'new-agent', id: 'rec_1' }), 'FORBIDDEN');
  db.grant('sp_a', 'new-agent', 'entries', ['records:read']);
  assert.equal(db.spaces.get('sp_a').grants.get('new-agent').get('entries').has('records:read'), true);
});

test('grant rejects sparse and decorated capability lists without changing existing grants', () => {
  const db = setup();
  const space = db.spaces.get('sp_a');
  const before = space.policyVersion;
  const permissions = () => [...space.grants.get('agent').get('entries')];
  const original = permissions();
  const decorated = ['records:write'];
  decorated.extra = true;
  const hidden = ['records:write'];
  Object.defineProperty(hidden, 'hidden', { value: true });
  const accessor = ['records:write'];
  Object.defineProperty(accessor, 0, { get() { throw Error('getter invoked'); }, enumerable: true });
  const custom = ['records:write'];
  Object.setPrototypeOf(custom, Object.create(Array.prototype));
  for (const invalid of [[, 'records:write'], decorated, hidden, accessor, custom, ['records:reed']]) {
    code(() => db.grant('sp_a', 'agent', 'entries', invalid), 'INVALID_ARGUMENT');
    assert.equal(space.policyVersion, before);
    assert.deepEqual(permissions(), original);
  }
  db.grant('sp_a', 'agent', 'entries', ['records:write']);
  assert.equal(space.policyVersion, before + 1);
  assert.deepEqual(permissions(), ['records:write']);
});

test('unique descriptors must be snapshot-safe JSON data before name, path or clone checks', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const space = db.spaces.get('sp_a');
  const before = { collections: [...space.collections], events: [...db.events], outbox: [...db.outbox], receipts: [...db.receipts] };
  let reads = 0;
  const changing = { get name() { return ++reads === 1 ? 'first' : 'second'; }, paths: ['label'] };
  const throwing = { get name() { throw Error('getter invoked'); }, paths: ['label'] };
  const extraFunction = { name: 'first', paths: ['label'], extra: () => null };
  const hidden = { name: 'first', paths: ['label'] };
  Object.defineProperty(hidden, 'extra', { value: 1 });
  const inherited = Object.assign(Object.create({ name: 'first' }), { paths: ['label'] });
  const invalid = [
    [changing, { name: 'second', paths: ['label'] }], [throwing], [extraFunction], [hidden], [inherited],
    [{ name: 'first', paths: ['label'] }, { name: 'first', paths: ['label'] }],
    [{ name: 'first', paths: [, 'label'] }], [{ name: 'first', paths: ['label'], extra: 'unsupported' }]
  ];
  for (const [index, descriptors] of invalid.entries()) {
    code(() => db.define('sp_a', `invalid-${index}`, schema, descriptors), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual({ collections: [...space.collections], events: [...db.events], outbox: [...db.outbox], receipts: [...db.receipts] }, before);
  }
  assert.equal(reads, 0);
  db.define('sp_a', 'valid', schema, [{ name: 'first', paths: ['label'] }, { name: 'second', paths: ['label'] }]);
  db.grant('sp_a', 'agent', 'valid', recordAccess);
  assert.deepEqual(space.collections.get('valid').uniques.map(({ name }) => name), ['first', 'second']);
  db.mutate({ ...scope, collection: 'valid', operation: 'create', data: { label: 'taken' }, idempotencyKey: 'first' });
  code(() => db.mutate({ ...scope, collection: 'valid', operation: 'create', data: { label: 'taken' }, idempotencyKey: 'second' }), 'UNIQUE_CONFLICT');
  assert.equal(space.collections.get('valid').reserved.size, 2);
});

test('long key edges and fractional seconds use bounded linear trimming with unchanged normalization', () => {
  const db = setup();
  const key = ' \u0085'.repeat(20000) + 'x' + '\u3000'.repeat(20000);
  const first = create(db, key, { label: 'x' }, 'long');
  assert.equal(db.get({ ...scope, id: first.ref.id }).key, 'x');
  const dated = new ReferenceState();
  dated.addSpace('sp_a', 'owner');
  dated.define('sp_a', 'entries', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { observedAt: { type: 'string', format: 'date-time' } } }, [{ name: 'time', paths: ['observedAt'] }]);
  dated.grant('sp_a', 'agent', 'entries', recordAccess);
  const manyZeros = '2026-09-23T12:00:00.' + '0'.repeat(20000) + '1Z';
  create(dated, 'one', { observedAt: manyZeros }, 'one');
  code(() => create(dated, 'two', { observedAt: manyZeros }, 'two'), 'UNIQUE_CONFLICT');
});

test('present undefined operation fields and custom-prototype arrays never alias receipts', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { label: { type: 'string' }, tags: { type: 'array', items: { type: ['string', 'null'] } } } });
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const created = { ...scope, operation: 'create', data: { label: 'item', tags: [null] }, idempotencyKey: 'create' };
  const id = db.mutate(created).ref.id;
  const replaced = { ...scope, operation: 'replace', id, expectedRevision: 1, data: { label: 'next' }, idempotencyKey: 'replace' };
  db.mutate(replaced);
  const patched = { ...scope, operation: 'patch', id, expectedRevision: 2, set: {}, unset: [], idempotencyKey: 'patch' };
  db.mutate(patched);
  const deleted = { ...scope, operation: 'delete', id, expectedRevision: 3, idempotencyKey: 'delete' };
  db.mutate(deleted);
  const snapshot = () => ({ collections: [...db.spaces.get('sp_a').collections].map(([name, state]) => ({ name,
    rows: structuredClone([...state.records]),
    reservations: [...state.reserved].map(([key, record]) => [key, record.id, record.revision]) })),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  const changed = ['different'];
  Object.setPrototypeOf(changed, Object.assign(Object.create(Array.prototype), { map: () => ['null'] }));
  const wrongFields = [
    [created, ['id', 'set', 'unset', 'expectedRevision']],
    [replaced, ['set', 'unset', 'externalKey']],
    [patched, ['data', 'externalKey']],
    [deleted, ['data', 'set', 'unset', 'externalKey']]
  ];
  for (const [original, fields] of wrongFields) for (const field of fields) {
    for (const key of [original.idempotencyKey, `${original.idempotencyKey}-${field}`]) {
      code(() => db.mutate({ ...original, idempotencyKey: key, [field]: undefined }), 'INVALID_ARGUMENT');
      assert.deepEqual(snapshot(), before);
    }
  }
  const hidden = Object.defineProperty({ ...created }, 'set', { value: undefined });
  code(() => db.mutate(hidden), 'INVALID_ARGUMENT');
  code(() => db.mutate({ ...created, [Symbol('unrecognized')]: undefined }), 'INVALID_ARGUMENT');
  assert.deepEqual(snapshot(), before);
  for (const original of [created, replaced, patched, deleted]) {
    code(() => db.mutate({ ...original, expectedSchemaVersion: undefined }), 'INVALID_ARGUMENT');
    assert.deepEqual(snapshot(), before);
  }
  for (const key of ['create', 'fresh-array']) {
    code(() => db.mutate({ ...created, idempotencyKey: key, data: { label: 'item', tags: changed } }), 'SCHEMA_INVALID');
    assert.deepEqual(snapshot(), before);
    code(() => db.mutate({ ...patched, idempotencyKey: key, set: { tags: changed } }), 'SCHEMA_INVALID');
    assert.deepEqual(snapshot(), before);
  }
  db.define('sp_a', 'nested', { $schema: schema.$schema, type: 'object', additionalProperties: false,
    properties: { tags: { type: 'array', items: { type: 'array', items: { type: ['string', 'null'] } } } } });
  db.grant('sp_a', 'agent', 'nested', recordAccess);
  const nested = { ...created, collection: 'nested', idempotencyKey: 'nested', data: { tags: [[null]] } };
  db.mutate(nested);
  const nestedBefore = snapshot();
  code(() => db.mutate({ ...nested, data: { tags: [changed] } }), 'SCHEMA_INVALID');
  assert.deepEqual(snapshot(), nestedBefore);
  code(() => db.mutate({ ...nested, idempotencyKey: 'nested-fresh', data: { tags: [changed] } }), 'SCHEMA_INVALID');
  assert.deepEqual(snapshot(), nestedBefore);
  assert.equal(db.mutate(created).replayed, true);
  assert.equal(db.mutate(deleted).replayed, true);
  db.revoke('sp_a', 'agent');
  code(() => db.mutate({ ...created, set: undefined }), 'FORBIDDEN');
  assert.deepEqual(snapshot(), nestedBefore);
});

test('schema compatibility treats required, enum and nullable type members as sets', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const original = { ...schema, required: ['label', 'state'] };
  db.define('sp_a', 'entries', original);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const id = create(db, 'entry', { label: 'entry', state: 'open', ordinal: null }, 'create').ref.id;
  const reordered = { ...original, required: ['state', 'label'], properties: { ...original.properties,
    state: { ...original.properties.state, enum: ['closed', 'open'] },
    ordinal: { type: ['null', 'integer'] } } };
  assert.equal(db.revise('sp_a', 'entries', 1, reordered), 2);
  assert.equal(write(db, 'replace', id, 1, 'replace', { data: { label: 'entry', state: 'closed', ordinal: null } }).schemaVersion, 2);
  const changedEnum = { ...reordered, properties: { ...reordered.properties, state: { type: 'string', enum: ['open', 'other'] } } };
  code(() => db.revise('sp_a', 'entries', 2, changedEnum), 'SCHEMA_BREAKING');
  code(() => db.revise('sp_a', 'entries', 2, { ...reordered, required: ['label'] }), 'SCHEMA_BREAKING');
  code(() => db.revise('sp_a', 'entries', 2, { ...reordered, properties: { ...reordered.properties, ordinal: { type: 'integer' } } }), 'SCHEMA_BREAKING');
  code(() => write(db, 'replace', id, 2, 'invalid', { data: { label: 'entry', state: 'other' } }), 'SCHEMA_INVALID');
  assert.equal(db.get({ ...scope, id }).revision, 2);
  const arrayEnum = { ...schema, required: [], properties: { tags: { type: 'array', items: { type: 'integer' }, enum: [[1, 2], [2, 1]] } } };
  db.define('sp_a', 'array-enum', arrayEnum);
  assert.equal(db.revise('sp_a', 'array-enum', 1, { ...arrayEnum, properties: { tags: { ...arrayEnum.properties.tags, enum: [[2, 1], [1, 2]] } } }), 2);
  code(() => db.revise('sp_a', 'array-enum', 2, { ...arrayEnum, properties: { tags: { ...arrayEnum.properties.tags, enum: [[1, 2]] } } }), 'SCHEMA_BREAKING');
  code(() => db.revise('sp_a', 'array-enum', 2, { ...arrayEnum, properties: { tags: { ...arrayEnum.properties.tags, enum: [[1, 2], [1, 2]] } } }), 'SCHEMA_UNSUPPORTED');
  code(() => db.revise('sp_a', 'array-enum', 2, { ...arrayEnum, properties: { tags: { ...arrayEnum.properties.tags, enum: [[1, 2], [2, 1], [1, 2]] } } }), 'SCHEMA_UNSUPPORTED');
  assert.equal(db.spaces.get('sp_a').collections.get('array-enum').version, 2);
});

test('schema keyword arrays reject sparse and duplicate members at definition and revision without effects', () => {
  const db = setup();
  const collection = db.spaces.get('sp_a').collections.get('entries');
  create(db, 'existing', { label: 'existing', state: 'open' }, 'existing');
  const snapshot = () => ({ version: collection.version, schema: structuredClone(collection.schema),
    records: structuredClone([...collection.records]), reservations: structuredClone([...collection.reserved]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  const scalarEnum = { ...schema, properties: { ...schema.properties, state: { type: 'string', enum: ['open', 'open'] } } };
  const structuralEnum = { ...schema, properties: { ...schema.properties,
    tags: { type: 'array', items: { type: 'integer' }, enum: [[1, 2], [1, 2]] } } };
  const objectEnum = { ...schema, properties: { ...schema.properties,
    detail: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, additionalProperties: false,
      enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] } } };
  const sparseRequired = { ...schema, required: new Array(1) };
  const sparseTypes = { ...schema, properties: { ...schema.properties, ordinal: { type: ['integer', ,] } } };
  const sparseEnum = { ...schema, properties: { ...schema.properties, state: { type: 'string', enum: new Array(1) } } };
  for (const [index, invalid] of [scalarEnum, structuralEnum, objectEnum, sparseRequired, sparseTypes, sparseEnum].entries()) {
    code(() => db.define('sp_a', `invalid-${index}`, invalid), 'SCHEMA_UNSUPPORTED');
    assert.equal(db.spaces.get('sp_a').collections.has(`invalid-${index}`), false);
    code(() => db.revise('sp_a', 'entries', 1, invalid), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.revise('sp_a', 'entries', 1, { ...schema, required: ['label'], properties: { ...schema.properties,
    tags: { type: 'array', items: { type: 'integer' }, enum: [[1, 2], [2, 1]] } } }), 2);
});

test('collection unique and sort path lists reject non-JSON arrays without reservations', () => {
  const db = setup();
  const s = db.spaces.get('sp_a');
  const before = { collections: s.collections.size, events: db.events.length, outbox: db.outbox.length, receipts: db.receipts.size };
  const decorated = ['label'];
  decorated.extra = true;
  const wrong = [1];
  const cases = [
    [new Array(1), []],
    [[{ name: 'key', paths: new Array(1) }], []],
    [[{ name: 'key', paths: decorated }], []],
    [[{ name: 'key', paths: wrong }], []],
    [[], new Array(1)],
    [[], decorated]
  ];
  for (const [index, [unique, sortable]] of cases.entries()) {
    code(() => db.define('sp_a', `bad-path-${index}`, schema, unique, sortable), 'SCHEMA_UNSUPPORTED');
    assert.equal(s.collections.has(`bad-path-${index}`), false);
    assert.deepEqual({ collections: s.collections.size, events: db.events.length, outbox: db.outbox.length, receipts: db.receipts.size }, before);
  }
  db.define('sp_a', 'good-paths', schema, [{ name: 'pair', paths: ['label', 'state'] }], ['label']);
  db.grant('sp_a', 'agent', 'good-paths', recordAccess);
  const make = (key, data) => db.mutate({ ...scope, collection: 'good-paths', operation: 'create', externalKey: key, data, idempotencyKey: key });
  make('first', { label: 'x', state: 'open' });
  make('second', { label: 'y', state: 'open' });
  assert.equal(db.count({ ...scope, collection: 'good-paths' }), 2);
});

test('present undefined schema keywords fail closed at definition and revision', () => {
  const db = setup();
  const c = db.spaces.get('sp_a').collections.get('entries');
  create(db, 'existing', { label: 'existing' }, 'existing');
  const snapshot = () => ({ schema: structuredClone(c.schema), version: c.version, rows: structuredClone([...c.records]),
    reservations: structuredClone([...c.reserved]), events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  const field = (type, name) => ({ ...schema, properties: { ...schema.properties, label: { type, [name]: undefined } } });
  const variants = ['minLength', 'maxLength', 'format', 'description', 'enum'].map(name => field('string', name));
  variants.push(...['minimum', 'maximum'].map(name => field('number', name)));
  variants.push(...['minItems', 'maxItems', 'items'].map(name => field('array', name)));
  variants.push({ ...schema, properties: undefined }, { ...schema, required: undefined }, { ...schema, additionalProperties: undefined });
  variants.push({ ...schema, properties: { ...schema.properties, nested: { type: 'object', properties: undefined, additionalProperties: false } } });
  for (const [index, invalid] of variants.entries()) {
    code(() => db.define('sp_a', `undefined-${index}`, invalid), 'SCHEMA_UNSUPPORTED');
    assert.equal(db.spaces.get('sp_a').collections.has(`undefined-${index}`), false);
    code(() => db.revise('sp_a', 'entries', 1, invalid), 'SCHEMA_UNSUPPORTED');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.revise('sp_a', 'entries', 1, { ...schema, properties: { ...schema.properties, extra: { type: 'string', minLength: 0 } } }), 2);
});

test('announced UTC leap second validates and sorts between adjacent seconds', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const dated = { ...schema, properties: { observedAt: { type: 'string', format: 'date-time' } }, required: ['observedAt'] };
  db.define('sp_a', 'entries', dated, [], ['observedAt']);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  const instants = ['2017-01-01T00:00:00Z', '2016-12-31T23:59:60.5000Z',
    '2016-12-31T23:59:59.999Z', '2016-12-31T23:59:60Z'];
  for (const [index, observedAt] of instants.entries()) create(db, `instant-${index}`, { observedAt }, `instant-${index}`);
  const pageOrder = direction => {
    const result = [];
    let cursor;
    do {
      const page = db.query({ ...scope, limit: 1, sort: { field: 'observedAt', direction }, cursor });
      result.push(...page.items.map(row => row.data.observedAt));
      cursor = page.cursor;
    } while (cursor);
    return result;
  };
  const chronological = [instants[2], instants[3], instants[1], instants[0]];
  assert.deepEqual(pageOrder('asc'), chronological);
  assert.deepEqual(pageOrder('desc'), [...chronological].reverse());
  const before = [db.events.length, db.receipts.size, db.outbox.length];
  for (const invalid of ['2016-06-30T23:59:60Z', '2016-12-31T22:59:60Z', '2016-02-30T23:59:60Z']) {
    code(() => create(db, invalid, { observedAt: invalid }, invalid), 'SCHEMA_INVALID');
  }
  assert.deepEqual([db.events.length, db.receipts.size, db.outbox.length], before);
  db.define('sp_a', 'unique-instants', dated, [{ name: 'instant', paths: ['observedAt'] }]);
  db.grant('sp_a', 'agent', 'unique-instants', recordAccess);
  const unique = observedAt => db.mutate({ ...scope, collection: 'unique-instants', operation: 'create', data: { observedAt }, idempotencyKey: observedAt });
  unique('2016-12-31T23:59:60.5000Z');
  code(() => unique('2016-12-31T23:59:60.5Z'), 'UNIQUE_CONFLICT');
  unique('2017-01-01T00:00:00Z');
  assert.equal(db.count({ ...scope, collection: 'unique-instants' }), 2);
});

test('noncanonical base64url aliases cannot reuse signed page cursors', () => {
  const db = setup();
  for (let index = 0; index < 3; index++) create(db, `page-${index}`, { label: `page-${index}` }, `page-${index}`);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const seen = new Set();
  for (let length = 1; length <= 12 && seen.size < 2; length++) {
    const credential = 'c'.repeat(length);
    db.grant('sp_a', credential, 'entries', recordAccess);
    const args = { ...scope, credential, limit: 1 };
    const cursor = db.query(args).cursor;
    const remainder = Buffer.from(cursor, 'base64url').length % 3;
    if (remainder === 0 || seen.has(remainder)) continue;
    seen.add(remainder);
    const last = cursor.at(-1);
    const alias = cursor.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
    assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(cursor, 'base64url'));
    assert.equal(db.query({ ...args, cursor }).items.length, 1);
    code(() => db.query({ ...args, cursor: alias }), 'CURSOR_INVALID');
    db.revoke('sp_a', credential, 'entries');
    code(() => db.query({ ...args, cursor: alias }), 'FORBIDDEN');
  }
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test('JSON envelope aliases cannot reuse a signed page cursor', () => {
  const db = setup();
  for (let index = 0; index < 3; index++) create(db, `page-${index}`, { label: `page-${index}` }, `page-${index}`);
  const args = { ...scope, limit: 1 };
  const cursor = db.query(args).cursor;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const envelope = JSON.parse(text);
  const aliases = [
    ` ${text} `,
    text.replace('"spaceId":', '"spaceId":"sp_a","spaceId":'),
    JSON.stringify(Object.fromEntries(Object.entries(envelope).reverse()))
  ];
  for (const aliasText of aliases) {
    assert.notEqual(aliasText, text);
    assert.deepEqual(JSON.parse(aliasText), envelope); // same signed binding, different wire bytes
    const alias = Buffer.from(aliasText, 'utf8').toString('base64url');
    assert.equal(Buffer.from(alias, 'base64url').toString('base64url'), alias);
    code(() => db.query({ ...args, cursor: alias }), 'CURSOR_INVALID');
  }
  code(() => db.query({ ...args, cursor: Buffer.from([0xff]).toString('base64url') }), 'CURSOR_INVALID');
  assert.equal(db.query({ ...args, cursor }).items[0].key, 'page-1');
  db.revoke('sp_a', 'agent', 'entries');
  code(() => db.query({ ...args, cursor: Buffer.from(aliases[1]).toString('base64url') }), 'FORBIDDEN');
});

test('readOnly denies fresh malformed writes before payload validation but permits authorized committed replay', () => {
  const db = setup();
  const created = { ...scope, operation: 'create', externalKey: 'item', data: { label: 'entry' }, idempotencyKey: 'create' };
  const saved = db.mutate(created);
  const patched = { ...scope, operation: 'patch', id: saved.ref.id, expectedRevision: 1,
    set: { state: 'open' }, unset: [], idempotencyKey: 'patch' };
  const patchReceipt = db.mutate(patched);
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ rows: structuredClone([...collection.records]),
    reservations: [...collection.reserved].map(([key, record]) => [key, record.id, record.revision]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  db.lifecycle('sp_a', 'readOnly');
  for (const invalid of [
    { ...created, idempotencyKey: 'fresh-bad-create', data: { label: undefined } },
    { ...patched, idempotencyKey: 'fresh-bad-patch', set: { state: undefined } },
    { ...patched, idempotencyKey: 'fresh-bad-shape', unset: 'state' }
  ]) {
    code(() => db.mutate(invalid), 'SPACE_UNAVAILABLE');
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(db.mutate(created).receiptId, saved.receiptId);
  assert.equal(db.mutate(patched).receiptId, patchReceipt.receiptId);
  for (const [invalid, expected] of [
    [{ ...created, data: { label: undefined } }, 'SCHEMA_INVALID'],
    [{ ...patched, set: { state: undefined } }, 'SCHEMA_INVALID'],
    [{ ...patched, unset: 'state' }, 'INVALID_ARGUMENT']
  ]) {
    code(() => db.mutate(invalid), expected);
    assert.deepEqual(snapshot(), before);
  }
  code(() => db.mutate({ ...created, data: { label: 'changed' } }), 'IDEMPOTENCY_MISMATCH');
  assert.deepEqual(snapshot(), before);
  db.grant('sp_a', 'agent', 'entries', ['records:read']);
  code(() => db.mutate(created), 'FORBIDDEN');
  code(() => db.mutate({ ...created, idempotencyKey: 'fresh-bad-create', data: { label: undefined } }), 'FORBIDDEN');
  assert.deepEqual(snapshot(), before);
  db.grant('sp_a', 'agent', 'entries', recordAccess);
  db.lifecycle('sp_a', 'active');
  code(() => db.mutate({ ...created, idempotencyKey: 'active-bad-create', data: { label: undefined } }), 'SCHEMA_INVALID');
  code(() => db.mutate({ ...patched, idempotencyKey: 'active-bad-patch', set: { state: undefined } }), 'SCHEMA_INVALID');
  assert.deepEqual(snapshot(), before);
  assert.equal(db.mutate(patched).replayed, true); // expectedRevision 1 is stale; the receipt wins
});

test('existing-record mutations require well-formed nonempty IDs before receipt lookup and record inspection', () => {
  const db = setup();
  const created = create(db, 'item', { label: 'entry' }, 'create');
  const operations = [
    { operation: 'replace', data: { label: 'changed' } },
    { operation: 'patch', set: {}, unset: [] },
    { operation: 'delete' }
  ];
  const collection = db.spaces.get('sp_a').collections.get('entries');
  const snapshot = () => ({ rows: structuredClone([...collection.records]),
    reservations: [...collection.reserved].map(([key, record]) => [key, record.id, record.revision]),
    events: structuredClone(db.events), outbox: structuredClone(db.outbox), receipts: structuredClone([...db.receipts]) });
  const before = snapshot();
  for (const fields of operations) for (const id of [undefined, null, 0, '', '\uD800']) {
    for (const request of [
      { ...scope, ...fields, id, expectedRevision: 1, idempotencyKey: `bad-${fields.operation}` },
      { ...scope, ...fields, id, expectedRevision: 1, idempotencyKey: 'create' }
    ]) {
      code(() => db.mutate(request), 'INVALID_ARGUMENT');
      assert.deepEqual(snapshot(), before);
    }
  }
  for (const fields of operations) {
    code(() => db.mutate({ ...scope, ...fields, id: 'rec_missing', expectedRevision: 1,
      idempotencyKey: `missing-${fields.operation}` }), 'NOT_FOUND');
    assert.deepEqual(snapshot(), before);
  }
  const committedRequests = [
    { ...scope, operation: 'replace', id: created.ref.id, expectedRevision: 1,
      data: { label: 'changed' }, idempotencyKey: 'valid-replace' },
    { ...scope, operation: 'patch', id: created.ref.id, expectedRevision: 2,
      set: {}, unset: [], idempotencyKey: 'valid-patch' },
    { ...scope, operation: 'delete', id: created.ref.id, expectedRevision: 3,
      idempotencyKey: 'valid-delete' }
  ];
  const committed = committedRequests.map(request => db.mutate(request));
  const after = snapshot();
  for (const [index, request] of committedRequests.entries()) {
    for (const id of [undefined, null, 0, '', '\uD800']) {
      code(() => db.mutate({ ...request, id }), 'INVALID_ARGUMENT');
      assert.deepEqual(snapshot(), after);
    }
    code(() => db.mutate({ ...request, id: 'rec_missing' }), 'IDEMPOTENCY_MISMATCH');
    assert.deepEqual(snapshot(), after);
    const replay = db.mutate(request);
    assert.equal(replay.receiptId, committed[index].receiptId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(snapshot(), after);
  }
  assert.equal(collection.records.get(created.ref.id).revision, 4);
  assert.equal(db.get({ ...scope, id: created.ref.id }), null);
});

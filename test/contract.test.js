import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceState } from './reference.js';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { label: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, ordinal: { type: ['integer', 'null'] } },
  required: ['label'], additionalProperties: false
};
const uniques = [{ name: 'label_state', paths: ['label', 'state'] }];
const setup = () => {
  const store = new ReferenceState();
  for (const space of ['sp_a', 'sp_b']) {
    store.addSpace(space, 'owner');
    store.define(space, 'entries', schema, uniques);
    store.grant(space, 'agent', 'entries', ['read', 'write']);
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

test('external keys cannot collide with constraint namespaces, and replacement releases live tuples only', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  db.define('sp_a', 'entries', schema, [{ name: 'key', paths: ['label'] }]);
  db.grant('sp_a', 'agent', 'entries', ['read', 'write']);
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
  db.grant('sp_a', 'agent', 'entries', ['read', 'write']);
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
  const a = create(db, 'a', { label: 'a' }, 'one');
  create(db, 'b', { label: 'b', state: 'open' }, 'two');
  const before = [db.events.length, db.outbox.length, db.receipts.size];
  code(() => write(db, 'replace', a.ref.id, 1, 'bad', { data: { label: 'b', state: 'open' } }), 'UNIQUE_CONFLICT');
  code(() => write(db, 'replace', a.ref.id, 1, 'invalid', { data: { label: 'a', secret: true } }), 'SCHEMA_INVALID');
  assert.deepEqual([db.events.length, db.outbox.length, db.receipts.size], before);
  assert.equal(db.get({ ...scope, id: a.ref.id }).revision, 1);
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
  db.grant('sp_a', 'agent', 'entries', ['read', 'write']);
  code(() => db.query({ ...scope, limit: 1, cursor: first.cursor }), 'CURSOR_INVALID');
  db.revoke('sp_a', 'agent');
  code(() => db.query({ ...scope, limit: 1, cursor: second.cursor }), 'FORBIDDEN');
});

test('default keyset ordering uses creation time then ID across ID width boundaries', () => {
  const db = setup();
  const ids = [];
  for (let n = 1; n <= 12; n++) ids.push(create(db, `key-${n}`, { label: `entry-${n}` }, `create-${n}`).ref.id);
  const received = [];
  let cursor;
  do {
    const page = db.query({ ...scope, limit: 3, cursor });
    received.push(...page.items.map(item => item.id));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(received, ids);
  assert.equal(db.get({ ...scope, id: ids[0] }).createdAt < db.get({ ...scope, id: ids[1] }).createdAt, true);
  const first = db.query({ ...scope, limit: 2 });
  create(db, 'later', { label: 'later' }, 'later');
  const rest = db.query({ ...scope, limit: 20, cursor: first.cursor });
  assert.deepEqual(rest.items.map(item => item.id), [...ids.slice(2), 'rec_13']);
});

test('grants remain independent by credential and collection, with no implicit wildcard', () => {
  const db = setup();
  db.define('sp_a', 'notes', schema);
  db.grant('sp_a', 'agent', 'notes', ['read', 'write']);
  const a = create(db, 'a', { label: 'entry' }, 'one');
  const b = db.mutate({ ...scope, collection: 'notes', operation: 'create', data: { label: 'memo' }, idempotencyKey: 'two' });
  assert.equal(db.get({ ...scope, id: a.ref.id }).data.label, 'entry');
  assert.equal(db.get({ ...scope, collection: 'notes', id: b.ref.id }).data.label, 'memo');
  code(() => db.grant('sp_a', 'wild', '*', ['read', 'write']), 'INVALID_ARGUMENT');
  code(() => db.get({ ...scope, credential: 'wild', id: a.ref.id }), 'FORBIDDEN');
  db.revoke('sp_a', 'agent', 'notes');
  code(() => db.get({ ...scope, collection: 'notes', id: b.ref.id }), 'FORBIDDEN');
  code(() => db.mutate({ ...scope, collection: 'notes', operation: 'create', data: { label: 'memo' }, idempotencyKey: 'two' }), 'FORBIDDEN');
  assert.equal(db.get({ ...scope, id: a.ref.id }).data.label, 'entry');
  db.grant('sp_a', 'agent', 'entries', ['read']);
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
  db.grant('sp_a', 'agent', 'nested', ['read', 'write']);
  const valid = db.mutate({ ...scope, collection: 'nested', operation: 'create', data: { item: [{ label: 'fine' }] }, idempotencyKey: 'valid' });
  assert.equal(valid.revision, 1);
  code(() => db.mutate({ ...scope, collection: 'nested', operation: 'create', data: { item: [{ label: 'fine', surprise: true }] }, idempotencyKey: 'bad' }), 'SCHEMA_INVALID');
});

test('accepted schema and uniqueness definitions are snapshots of caller input', () => {
  const db = new ReferenceState();
  db.addSpace('sp_a', 'owner');
  const input = structuredClone(schema);
  const constraints = [{ name: 'label', paths: ['label'] }];
  db.define('sp_a', 'entries', input, constraints);
  db.grant('sp_a', 'agent', 'entries', ['read', 'write']);
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

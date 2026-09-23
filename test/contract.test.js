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

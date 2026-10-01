import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { PostgresAuthority, AuthorityError, CommitOutcomeUnknownError } from '../../packages/postgres/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
const pool = new pg.Pool({ connectionString: url, max: 5 });
const authority = new PostgresAuthority(pool, 3600);
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const suffix = randomUUID();
  const spaceId = `sp_${suffix}`;
  const collectionId = `entries_${suffix}`;
  const otherId = `other_${suffix}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO spaces(space_id,owner_principal_id,home_cell_id,cell_id,storage_target_id)
      VALUES($1,'owner','cell-a','cell-a','target-a')`, [spaceId]);
    for (const id of [collectionId, otherId]) {
      await client.query('INSERT INTO collections(space_id,collection_id) VALUES($1,$2)', [spaceId, id]);
      await client.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
        VALUES($1,$2,1,'{}')`, [spaceId, id]);
    }
    await client.query(`INSERT INTO collection_unique_declarations(space_id,collection_id,constraint_name,paths,accepted_version)
      VALUES($1,$2,'label',ARRAY['label'],1)`, [spaceId, collectionId]);
    await client.query(`INSERT INTO collection_index_declarations(space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
      VALUES($1,$2,'score','number',TRUE,TRUE,TRUE,1)`, [spaceId, collectionId]);
    await client.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
      VALUES($1,$2,'writer',ARRAY['records:write','records:read'])`, [spaceId, collectionId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const scope = { spaceId, collectionId, principalId: 'non-owner', credentialId: 'writer',
    capability: 'records:write', policyVersion: 1, placementGeneration: 1 };
  return { scope, otherId };
}

function change(operation, idempotencyKey, data, extras = {}) {
  return { operation, idempotencyKey, requestDigest: digest(JSON.stringify([operation,idempotencyKey,data,extras])),
    ...(data === undefined ? {} : { canonicalData: data }), ...extras };
}

async function counts(spaceId) {
  const result = {};
  for (const table of ['records','record_unique_keys','record_index_values','record_events','idempotency_receipts','record_tombstones','projection_outbox']) {
    const row = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [spaceId]);
    result[table] = row.rows[0].n;
  }
  return result;
}

test('atomic mutation, real competing writers, rollback, replay and scope', async () => {
  const { scope, otherId } = await fixture();
  const first = change('create','create-a','{"label":"A","score":1}', {
    normalizedExternalKey:'a', unique:[{name:'label',encodedValue:'s:1:A'}], indexes:[{field:'score',kind:'number',value:1}] });
  const created = await authority.mutate(scope, first);
  assert.equal(created.revision, 1);
  assert.deepEqual(await counts(scope.spaceId), {
    records:1,record_unique_keys:1,record_index_values:1,record_events:1,idempotency_receipts:1,record_tombstones:0,projection_outbox:1 });

  // The transport loses the response after COMMIT. The retry returns the saved receipt.
  const replay = await authority.mutate(scope, first);
  assert.equal(replay.receiptId, created.receiptId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await counts(scope.spaceId), {
    records:1,record_unique_keys:1,record_index_values:1,record_events:1,idempotency_receipts:1,record_tombstones:0,projection_outbox:1 });

  const replace = key => change('replace',key,'{"label":"B","score":2}', {
    recordId:created.ref.id, expectedRevision:1, unique:[{name:'label',encodedValue:'s:1:B'}], indexes:[{field:'score',kind:'number',value:2}] });
  const racers = await Promise.allSettled([authority.mutate(scope,replace('race-1')),authority.mutate(scope,replace('race-2'))]);
  assert.equal(racers.filter(x => x.status === 'fulfilled').length,1);
  assert.equal(racers.find(x => x.status === 'rejected')?.reason.code,'REVISION_CONFLICT');
  assert.equal((await authority.transaction({ ...scope,capability:'records:read' }, tx => tx.getRecord(created.ref.id))).revision,2);
  assert.deepEqual(await counts(scope.spaceId), {
    records:1,record_unique_keys:1,record_index_values:1,record_events:2,idempotency_receipts:2,record_tombstones:0,projection_outbox:2 });

  const duplicate = change('create','duplicate','{"label":"B"}', { unique:[{name:'label',encodedValue:'s:1:B'}] });
  await assert.rejects(authority.mutate(scope,duplicate), error => error instanceof AuthorityError && error.code === 'UNIQUE_CONFLICT');
  assert.equal((await counts(scope.spaceId)).records,1);
  await assert.rejects(authority.mutate(scope,change('create','undeclared','{"label":"X"}',
    { unique:[{name:'unknown',encodedValue:'s:1:X'}] })),error => error.code === 'SCHEMA_CONFLICT');
  assert.equal((await counts(scope.spaceId)).records,1);
  await assert.rejects(authority.mutate(scope,change('create','key-duplicate','{"label":"C"}', { normalizedExternalKey:'a' })),
    error => error.code === 'KEY_RESERVED');

  await assert.rejects(authority.transaction(scope, async tx => {
    await tx.mutate(change('create','aborted','{"label":"temporary"}', { normalizedExternalKey:'temporary' }));
    throw new Error('injected before commit');
  }), /injected before commit/);
  assert.equal((await counts(scope.spaceId)).records,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM idempotency_receipts WHERE space_id=$1 AND idempotency_key='aborted'`,[scope.spaceId])).rows[0].n,0);

  const read = await authority.transaction({ ...scope, capability:'records:read' }, async tx => ({
    matches: await tx.queryRecords([{field:'score',kind:'number',operator:'gte',value:2}],10),
    count: await tx.countRecords([{field:'score',kind:'number',operator:'gte',value:2}]),
    exists: await tx.existsRecord([{field:'score',kind:'number',operator:'gte',value:3}]),
    wrongCollection: await tx.getRecord('missing')
  }));
  assert.equal(read.matches.length,1);
  assert.equal(read.count,1);
  assert.equal(read.exists,false);
  assert.equal(read.wrongCollection,null);
  await assert.rejects(authority.transaction(scope,tx => tx.getRecord(created.ref.id)),error => error.code === 'FORBIDDEN');
  await assert.rejects(authority.transaction({ ...scope, collectionId:otherId }, tx => tx.getRecord(created.ref.id)),
    error => error.code === 'FORBIDDEN');

  // A revoked grant denies even a committed retry; the next pool borrower is clean.
  await pool.query('DELETE FROM collection_grants WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3',
    [scope.spaceId,scope.collectionId,scope.credentialId]);
  await pool.query('UPDATE spaces SET policy_version=policy_version+1 WHERE space_id=$1',[scope.spaceId]);
  await assert.rejects(authority.mutate({ ...scope,policyVersion:2 },first), error => error.code === 'FORBIDDEN');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_events WHERE space_id=$1',[scope.spaceId])).rows[0].n,2);
});

test('readOnly replays authorized receipt, stale and malformed inputs do not commit', async () => {
  const { scope } = await fixture();
  const request = change('create','one','{"label":"one"}');
  const saved = await authority.mutate(scope,request);
  await pool.query("UPDATE spaces SET lifecycle='readOnly' WHERE space_id=$1",[scope.spaceId]);
  assert.equal((await authority.mutate(scope,request)).receiptId,saved.receiptId);
  await assert.rejects(authority.mutate(scope,change('create','fresh','{"label":"two"}')), error => error.code === 'SPACE_UNAVAILABLE');
  await assert.rejects(authority.mutate(scope,change('create','fresh-malformed','{"z":1,"a":2}')), error => error.code === 'SPACE_UNAVAILABLE');
  await assert.rejects(authority.mutate(scope,{ ...request,canonicalData:'{"z":1,"a":2}' }), error => error.code === 'SCHEMA_INVALID');
  await assert.rejects(authority.mutate(scope,{ ...request,requestDigest:digest('different') }),error => error.code === 'IDEMPOTENCY_MISMATCH');
  await pool.query("UPDATE spaces SET lifecycle='active' WHERE space_id=$1",[scope.spaceId]);
  for (const malformed of ['{"z":1,"a":2}','{"label":"\\ud800"}','[]']) {
    await assert.rejects(authority.mutate(scope,change('create',`bad-${malformed}`,malformed)),error => error.code === 'SCHEMA_INVALID');
  }
  let tooDeep = '0';
  for (let i = 0; i < 66; i++) tooDeep = `{"a":${tooDeep}}`;
  await assert.rejects(authority.mutate(scope,change('create','too-deep',tooDeep)),error => error.code === 'SCHEMA_INVALID');
  await assert.rejects(authority.mutate(scope,change('delete','bad-id',undefined,{ recordId:'\ud800',expectedRevision:1 })),
    error => error.code === 'INVALID_ARGUMENT');
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('an in-flight receipt cannot cause a duplicate write', async () => {
  const { scope } = await fixture();
  const request = change('create','pending','{"label":"pending"}');
  let release;
  let entered;
  const inTransaction = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = authority.transaction(scope, async tx => {
    const receipt = await tx.mutate(request);
    entered();
    await held;
    return receipt;
  });
  await inTransaction;
  await assert.rejects(authority.mutate(scope,request), error => error.code === 'RECEIPT_PENDING');
  release();
  const receipt = await first;
  assert.equal((await authority.mutate(scope,request)).receiptId,receipt.receiptId);
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('audit facts stay immutable while outbox delivery is leased and fenced', async () => {
  const { scope } = await fixture();
  await authority.mutate(scope,change('create','outbox','{"label":"outbox"}'));
  const admin = { ...scope,principalId:'owner',capability:'space:admin' };
  const first = await authority.transaction(admin,tx => tx.claimOutbox(10,30));
  assert.equal(first.length,1);
  assert.deepEqual(await authority.transaction(admin,tx => tx.claimOutbox(10,30)),[]);
  assert.equal(await authority.transaction(admin,tx => tx.finishOutbox({ ...first[0],attempt:first[0].attempt+1 },true)),false);
  assert.equal(await authority.transaction(admin,tx => tx.finishOutbox(first[0],true)),true);
  assert.equal((await pool.query('SELECT delivery_state,attempts FROM projection_outbox WHERE event_id=$1',[first[0].eventId])).rows[0].delivery_state,'delivered');
  await assert.rejects(pool.query('UPDATE record_events SET operation=$1 WHERE event_id=$2',['patch',first[0].eventId]),
    error => error.message.includes('record events are immutable'));
  await assert.rejects(pool.query('UPDATE idempotency_receipts SET request_digest=$1 WHERE space_id=$2',
    [digest('tampered'),scope.spaceId]),error => error.message.includes('accepted authority facts are immutable'));
  assert.equal((await pool.query('SELECT operation FROM record_events WHERE event_id=$1',[first[0].eventId])).rows[0].operation,'create');
});

test('schema pointer requires an accepted version and old records retain their version', async () => {
  const { scope } = await fixture();
  const old = change('create','schema-old','{"label":"old"}');
  const receipt = await authority.mutate(scope,old);
  await assert.rejects(pool.query('UPDATE collections SET schema_version=2 WHERE space_id=$1 AND collection_id=$2',
    [scope.spaceId,scope.collectionId]),error => error.code === '23503');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition) VALUES($1,$2,2,$3)',
      [scope.spaceId,scope.collectionId,'{"added":"optional"}']);
    await client.query('UPDATE collections SET schema_version=2 WHERE space_id=$1 AND collection_id=$2',
      [scope.spaceId,scope.collectionId]);
    await client.query('COMMIT');
  } finally { client.release(); }
  assert.equal((await authority.mutate(scope,old)).receiptId,receipt.receiptId);
  const newer = await authority.mutate(scope,change('create','schema-new','{"added":"yes","label":"new"}'));
  assert.equal(newer.schemaVersion,2);
  assert.equal((await authority.transaction({ ...scope,capability:'records:read' },tx => tx.getRecord(receipt.ref.id))).schemaVersion,1);
  assert.equal((await authority.transaction({ ...scope,capability:'records:read' },tx => tx.getRecord(newer.ref.id))).schemaVersion,2);
});

test('a failed transaction cannot leak state into the next borrower of one pooled client', async () => {
  const { scope } = await fixture();
  const single = new pg.Pool({ connectionString:url,max:1 });
  const repository = new PostgresAuthority(single,3600);
  const request = change('create','single-pool','{"label":"safe"}');
  let escaped;
  try {
    await assert.rejects(repository.transaction(scope, async tx => {
      escaped = tx;
      await tx.mutate(request);
      throw new Error('abort borrowed client');
    }),/abort borrowed client/);
    await assert.rejects(escaped.checkScope(),error => error.code === 'INVALID_ARGUMENT');
    const receipt = await repository.mutate(scope,request);
    assert.equal(receipt.revision,1);
    assert.equal((await counts(scope.spaceId)).record_events,1);
  } finally { await single.end(); }
});

test('receipt retention starts at the database precommit clock, even after a held write and app clock skew', async () => {
  const { scope } = await fixture();
  const short = new PostgresAuthority(pool,1);
  const request = change('create','delayed-commit','{"label":"delayed"}');
  const originalNow = Date.now;
  let receipt;
  let sameTransactionReplay;
  try {
    Date.now = () => originalNow() - 86_400_000;
    receipt = await short.transaction(scope,async tx => {
      const pending = await tx.mutate(request);
      sameTransactionReplay = await tx.mutate(request);
      assert.equal(sameTransactionReplay.receiptId,pending.receiptId);
      await new Promise(resolve => setTimeout(resolve,1400));
      return pending;
    });
  } finally { Date.now = originalNow; }
  assert.ok(Date.parse(receipt.expiresAt) > Date.now());
  assert.equal(sameTransactionReplay.expiresAt,receipt.expiresAt);
  const replay = await short.mutate(scope,request);
  assert.equal(replay.receiptId,receipt.receiptId);
  assert.equal(replay.replayed,true);
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('date-time filters compare full UTC instants across query, count and exists', async () => {
  const { scope } = await fixture();
  await pool.query(`INSERT INTO collection_index_declarations(space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
    VALUES($1,$2,'observedAt','date-time',TRUE,TRUE,TRUE,1)`,[scope.spaceId,scope.collectionId]);
  for (const [key,time] of [
    ['whole','2020-01-01T00:00:00Z'],
    ['fraction','2020-01-01T00:00:00.1Z'],
    ['precise','2020-01-01T00:00:00.100000001Z'],
    ['next','2020-01-01T00:00:01Z']
  ]) await authority.mutate(scope,change('create',key,JSON.stringify({observedAt:time}),
    { indexes:[{field:'observedAt',kind:'date-time',value:time}] }));
  const readScope = { ...scope,capability:'records:read' };
  const predicate = (operator,value) => [{field:'observedAt',kind:'date-time',operator,value}];
  const result = await authority.transaction(readScope, async tx => ({
    afterWhole:await tx.queryRecords(predicate('gt','2020-01-01T00:00:00Z'),10),
    beforeFraction:await tx.countRecords(predicate('lt','2020-01-01T00:00:00.1Z')),
    equalFraction:await tx.countRecords(predicate('eq','2020-01-01T00:00:00.10Z')),
    precise:await tx.existsRecord(predicate('gt','2020-01-01T00:00:00.100000000Z'))
  }));
  assert.equal(result.afterWhole.length,3);
  assert.equal(result.beforeFraction,1);
  assert.equal(result.equalFraction,1);
  assert.equal(result.precise,true);
  for (const [key,time] of [
    ['leap','2016-12-31T23:59:60.000000001Z'],
    ['next-day','2017-01-01T00:00:00Z']
  ]) await authority.mutate(scope,change('create',key,JSON.stringify({observedAt:time}),
    {indexes:[{field:'observedAt',kind:'date-time',value:time}]}));
  assert.equal(await authority.transaction(readScope,tx => tx.countRecords(predicate('lt','2017-01-01T00:00:00Z'))),1);
});

test('patch/delete, key lookup and tombstoned external and composite reservations are atomic', async () => {
  const { scope } = await fixture();
  const initial = await authority.mutate(scope,change('create','key-first','{"label":"first"}',
    { normalizedExternalKey:'name',unique:[{name:'label',encodedValue:'s:5:first'}] }));
  const read = { ...scope,capability:'records:read' };
  assert.equal((await authority.transaction(read,tx => tx.getByKey('external','name'))).ref.id,initial.ref.id);
  const patched = await authority.mutate(scope,change('patch','key-patch','{"label":"second"}',
    { recordId:initial.ref.id,expectedRevision:1,unique:[{name:'label',encodedValue:'s:6:second'}] }));
  assert.equal(patched.revision,2);
  await authority.mutate(scope,change('delete','key-delete',undefined,{recordId:initial.ref.id,expectedRevision:2}));
  assert.equal(await authority.transaction(read,tx => tx.getByKey('external','name')),null);
  const before = await counts(scope.spaceId);
  for (const extras of [
    {normalizedExternalKey:'name'},
    {unique:[{name:'label',encodedValue:'s:6:second'}]}
  ]) await assert.rejects(authority.mutate(scope,change('create',`reuse-${JSON.stringify(extras)}`,'{"label":"new"}',extras)),
    error => error.code === 'KEY_RESERVED');
  assert.deepEqual(await counts(scope.spaceId),before);
});

test('collection readOnly blocks replay on the requested and original collection', async () => {
  const { scope,otherId } = await fixture();
  const request = change('create','lifecycle','{"label":"one"}');
  const receipt = await authority.mutate(scope,request);
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['records:write'])`,[scope.spaceId,otherId,scope.credentialId]);
  await pool.query("UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id=$2",[scope.spaceId,scope.collectionId]);
  await assert.rejects(authority.mutate(scope,request),error => error.code === 'SPACE_UNAVAILABLE');
  await assert.rejects(authority.mutate({...scope,collectionId:otherId},request),error => error.code === 'SPACE_UNAVAILABLE');
  await pool.query("UPDATE collections SET lifecycle='active' WHERE space_id=$1 AND collection_id=$2",[scope.spaceId,scope.collectionId]);
  assert.equal((await authority.mutate(scope,request)).receiptId,receipt.receiptId);
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('ambiguous committed response replays, expired grant denies, and expired outbox lease is fenced', async () => {
  const { scope } = await fixture();
  const request = change('create','lost-commit','{"label":"committed"}');
  const faultPool = { connect: async () => {
    const client = await pool.connect();
    return { query: async (...args) => {
      const result = await client.query(...args);
      if (args[0] === 'COMMIT') throw new Error('lost response after commit');
      return result;
    }, release: discard => client.release(discard) };
  } };
  await assert.rejects(new PostgresAuthority(faultPool,3600).mutate(scope,request),error => error instanceof CommitOutcomeUnknownError);
  const receipt = await authority.mutate(scope,request);
  assert.equal(receipt.replayed,true);
  assert.equal((await counts(scope.spaceId)).record_events,1);
  const admin = {...scope,principalId:'owner',capability:'space:admin'};
  const first = (await authority.transaction(admin,tx => tx.claimOutbox(1,1)))[0];
  await pool.query("UPDATE projection_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[first.eventId]);
  const second = (await authority.transaction(admin,tx => tx.claimOutbox(1,1)))[0];
  assert.equal(second.attempt,first.attempt+1);
  assert.equal(await authority.transaction(admin,tx => tx.finishOutbox(first,true)),false);
  assert.equal(await authority.transaction(admin,tx => tx.finishOutbox(second,true)),true);
  await pool.query("UPDATE collection_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3",
    [scope.spaceId,scope.collectionId,scope.credentialId]);
  await assert.rejects(authority.mutate(scope,request),error => error.code === 'FORBIDDEN');
});

test('concurrent external and composite conflicts leave only winning rows', async () => {
  const { scope } = await fixture();
  const external = await Promise.allSettled(['a','b'].map(key => authority.mutate(scope,
    change('create',`external-${key}`,JSON.stringify({label:key}),{normalizedExternalKey:'shared'}))));
  assert.equal(external.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(external.find(result => result.status === 'rejected').reason.code,'KEY_RESERVED');
  const composite = await Promise.allSettled(['a','b'].map(key => authority.mutate(scope,
    change('create',`composite-${key}`,JSON.stringify({label:key}),
      {unique:[{name:'label',encodedValue:'s:6:shared'}]}))));
  assert.equal(composite.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(composite.find(result => result.status === 'rejected').reason.code,'UNIQUE_CONFLICT');
  assert.deepEqual(await counts(scope.spaceId),{
    records:2,record_unique_keys:1,record_index_values:0,record_events:2,
    idempotency_receipts:2,record_tombstones:0,projection_outbox:2 });
});

test('a server-confirmed serialization rollback retries once without duplicate receipts', async () => {
  const { scope } = await fixture();
  let injected = false;
  const retryPool = { connect: async () => {
    const client = await pool.connect();
    return { query: async (...args) => {
      if (!injected && String(args[0]).includes('pg_try_advisory_xact_lock')) {
        injected = true;
        await client.query("DO $$BEGIN RAISE EXCEPTION 'forced serialization' USING ERRCODE='40001'; END$$");
      }
      return client.query(...args);
    }, release: discard => client.release(discard) };
  } };
  const receipt = await new PostgresAuthority(retryPool,3600).mutate(scope,change('create','retry','{"label":"retry"}'));
  assert.equal(injected,true);
  assert.equal(receipt.revision,1);
  assert.equal((await counts(scope.spaceId)).idempotency_receipts,1);
});

test('failed ROLLBACK discards the pooled client and its uncommitted receipt', async () => {
  const { scope } = await fixture();
  const single = new pg.Pool({connectionString:url,max:1});
  const brokenRollbackPool = { connect: async () => {
    const client = await single.connect();
    return {query:(sql,...args) => sql === 'ROLLBACK'
      ? Promise.reject(new Error('lost rollback connection')) : client.query(sql,...args),
    release:discard => client.release(discard)};
  } };
  const request = change('create','rollback-loss','{"label":"rolled back"}');
  try {
    await assert.rejects(new PostgresAuthority(brokenRollbackPool,3600).transaction(scope,async tx => {
      await tx.mutate(request);
      throw new Error('abort before commit');
    }),/abort before commit/);
    const receipt = await new PostgresAuthority(single,3600).mutate(scope,request);
    assert.equal(receipt.replayed,false);
    assert.equal((await counts(scope.spaceId)).record_events,1);
  } finally { await single.end(); }
});

test.after(async () => { await pool.end(); });

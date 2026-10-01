import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAuthority, AuthorityError, CommitOutcomeUnknownError } from '../../packages/postgres/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:55432/stateplane`;
const disposableName = process.env.DATABASE_URL ? null : `stateplane_test_${randomUUID().replaceAll('-', '')}`;
const url = disposableName ? baseUrl.replace(/\/stateplane$/, `/${disposableName}`) : baseUrl;
if (disposableName) {
  const admin = new pg.Client({ connectionString:baseUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${disposableName}`); }
  finally { await admin.end(); }
  execFileSync(process.execPath,['scripts/migrate.mjs'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env:{...process.env,DATABASE_URL:url},stdio:'inherit'});
}
const pool = new pg.Pool({ connectionString: url, max: 5 });
test.after(async () => {
  await pool.end();
  if (disposableName) {
    const admin = new pg.Client({ connectionString:baseUrl });
    await admin.connect();
    try { await admin.query(`DROP DATABASE ${disposableName}`); }
    finally { await admin.end(); }
  }
});
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
  const complete = operation === 'replace' || operation === 'patch'
    ? { unique:[], indexes:[], ...extras } : extras;
  return { operation, idempotencyKey, requestDigest: digest(JSON.stringify([operation,idempotencyKey,data,complete])),
    ...(data === undefined ? {} : { canonicalData: data }), ...complete };
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

test('an in-flight receipt returns pending before commit, then replays one effect', async () => {
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
  const contender = authority.mutate(scope,request);
  try {
    await assert.rejects(Promise.race([
      contender,
      new Promise((_,reject) => setTimeout(() => reject(new Error('pending response timed out while owner was held')),250))
    ]),error => error.code === 'RECEIPT_PENDING');
  } finally { release(); }
  await Promise.allSettled([contender]);
  const receipt = await first;
  assert.equal((await authority.mutate(scope,request)).receiptId,receipt.receiptId);
  assert.deepEqual(await counts(scope.spaceId),{
    records:1,record_unique_keys:0,record_index_values:0,record_events:1,
    idempotency_receipts:1,record_tombstones:0,projection_outbox:1
  });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipt_reservations WHERE space_id=$1',[scope.spaceId])).rows[0].n,0);
});

test('receipt reservation is scoped by identity and rolls back cleanly', async () => {
  const { scope } = await fixture();
  const firstRequest=change('create','held-rollback','{"label":"held"}');
  let release;
  let entered;
  const held=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{entered=resolve;});
  const owner=authority.transaction(scope,async tx=>{
    await tx.mutate(firstRequest);
    entered();
    await held;
    throw new Error('owner interrupted before commit');
  });
  await ready;
  try {
    await assert.rejects(authority.mutate(scope,{...firstRequest,requestDigest:digest('different')}),
      error=>error.code==='RECEIPT_PENDING');
    const independent=await authority.mutate(scope,change('create','independent','{"label":"other"}'));
    assert.equal(independent.revision,1);
  } finally {release();}
  await assert.rejects(owner,/owner interrupted/);
  const replacement=await authority.mutate(scope,firstRequest);
  assert.equal(replacement.replayed,false);
  assert.deepEqual(await counts(scope.spaceId),{
    records:2,record_unique_keys:0,record_index_values:0,record_events:2,
    idempotency_receipts:2,record_tombstones:0,projection_outbox:2
  });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipt_reservations WHERE space_id=$1',[scope.spaceId])).rows[0].n,0);
});

test('receipt lock timeout and reservation leave no pooled session state', async () => {
  const { scope } = await fixture();
  const single=new pg.Pool({connectionString:url,max:1});
  try {
    await new PostgresAuthority(single,3600).mutate(scope,change('create','pool-clean','{"label":"clean"}'));
    const borrowed=await single.connect();
    try {
      assert.equal((await borrowed.query('SHOW lock_timeout')).rows[0].lock_timeout,'0');
      assert.equal((await borrowed.query('SELECT count(*)::int AS n FROM receipt_reservations WHERE space_id=$1',[scope.spaceId])).rows[0].n,0);
    } finally { borrowed.release(); }
  } finally { await single.end(); }
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

test('caller changes to create, replace and delete receipts cannot alter saved facts or replay', async () => {
  const { scope } = await fixture();
  let recordId;
  for (const [operation, key, data, extras, revision] of [
    ['create','alias-create','{"label":"one"}',{},1],
    ['replace','alias-replace','{"label":"two"}',() => ({recordId,expectedRevision:1}),2],
    ['delete','alias-delete',undefined,() => ({recordId,expectedRevision:2}),3]
  ]) {
    const request = change(operation,key,data,typeof extras === 'function' ? extras() : extras);
    const result = await authority.transaction(scope,async tx => {
      const original = await tx.mutate(request);
      const actualId = original.ref.id;
      original.revision = 999;
      original.ref.id = 'rec_corrupted';
      original.projection.generation = 999;
      const replay = await tx.mutate(request);
      assert.equal(replay.revision,revision);
      assert.equal(replay.ref.id,actualId);
      assert.equal(replay.projection.generation,1);
      replay.revision = 888;
      replay.ref.id = 'rec_replay_corrupted';
      replay.projection.generation = 888;
      return {actualId,receiptId:original.receiptId};
    });
    recordId ??= result.actualId;
    const saved = (await pool.query(`SELECT response,record_id FROM idempotency_receipts
      WHERE space_id=$1 AND operation=$2 AND idempotency_key=$3`,[scope.spaceId,operation,key])).rows[0];
    assert.equal(saved.response.revision,revision);
    assert.equal(saved.response.ref.id,recordId);
    assert.equal(saved.response.projection.generation,1);
    assert.equal(saved.record_id,recordId);
    const replay = await authority.mutate(scope,request);
    assert.equal(replay.receiptId,result.receiptId);
    assert.equal(replay.revision,revision);
    assert.equal(replay.ref.id,recordId);
    assert.equal(replay.projection.generation,1);
    assert.equal(replay.replayed,true);
  }
  const record = (await pool.query('SELECT revision,tombstone FROM records WHERE space_id=$1 AND record_id=$2',
    [scope.spaceId,recordId])).rows[0];
  assert.deepEqual({revision:Number(record.revision),tombstone:record.tombstone},{revision:3,tombstone:true});
  assert.deepEqual(await counts(scope.spaceId),{
    records:1,record_unique_keys:0,record_index_values:0,record_events:3,
    idempotency_receipts:3,record_tombstones:1,projection_outbox:3 });
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
  assert.equal(await authority.transaction(admin,tx => tx.finishOutbox(first,true)),false);
  assert.deepEqual((await pool.query('SELECT delivery_state,attempts FROM projection_outbox WHERE event_id=$1',
    [first.eventId])).rows[0],{delivery_state:'delivering',attempts:1});
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
  const { scope,otherId } = await fixture();
  const originalId = scope.collectionId;
  let injected = false;
  const request=change('create','retry','{"label":"retry"}');
  const retryPool = { connect: async () => {
    const client = await pool.connect();
    return { query: async (...args) => {
      if (!injected && String(args[0]).includes('SELECT s.lifecycle,s.placement_generation,c.lifecycle')) {
        injected = true;
        scope.collectionId = otherId;
        request.idempotencyKey='changed-on-retry';
        request.requestDigest=digest('changed-on-retry');
        request.canonicalData='{"label":"changed"}';
        await client.query("DO $$BEGIN RAISE EXCEPTION 'forced serialization' USING ERRCODE='40001'; END$$");
      }
      return client.query(...args);
    }, release: discard => client.release(discard) };
  } };
  let receipt;
  try {
    receipt = await new PostgresAuthority(retryPool,3600).mutate(scope,request);
  } finally { scope.collectionId = originalId; }
  assert.equal(injected,true);
  assert.equal(receipt.revision,1);
  assert.equal((await counts(scope.spaceId)).idempotency_receipts,1);
  const rows = await pool.query(`SELECT r.collection_id,r.canonical_data,i.idempotency_key FROM records r
    JOIN idempotency_receipts i USING(space_id,collection_id,record_id) WHERE r.space_id=$1 AND r.record_id=$2`,
    [scope.spaceId,receipt.ref.id]);
  assert.deepEqual(rows.rows,[{collection_id:originalId,canonical_data:'{"label":"retry"}',idempotency_key:'retry'}]);
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

test('a transaction keeps its entry scope when the caller changes and restores its scope object', async () => {
  const { scope, otherId } = await fixture();
  const originalId = scope.collectionId;
  const request = change('create','scope-snapshot','{"label":"kept"}');
  const receipt = await authority.transaction(scope,async tx => {
    scope.collectionId = otherId;
    try {
      assert.equal(tx.scope.collectionId,originalId);
      assert.throws(() => { tx.scope.collectionId = otherId; },TypeError);
      return await tx.mutate(request);
    } finally { scope.collectionId = originalId; }
  });
  const rows = await pool.query('SELECT collection_id FROM records WHERE space_id=$1 AND record_id=$2',
    [scope.spaceId,receipt.ref.id]);
  assert.deepEqual(rows.rows.map(row => row.collection_id),[originalId]);
  assert.equal((await counts(scope.spaceId)).idempotency_receipts,1);
  const readScope = { ...scope,capability:'records:read' };
  const read = await authority.transaction(readScope,async tx => {
    readScope.collectionId = otherId;
    try { return await tx.getRecord(receipt.ref.id); }
    finally { readScope.collectionId = originalId; }
  });
  assert.equal(read.ref.collectionId,originalId);
});

test('a lost BEGIN response discards a possibly open transaction before pool reuse', async () => {
  const { scope } = await fixture();
  const single = new pg.Pool({connectionString:url,max:1});
  let discarded;
  const beginLossPool = { connect: async () => {
    const client = await single.connect();
    return {query: async (...args) => {
      const result = await client.query(...args);
      if (args[0] === 'BEGIN') throw new Error('lost BEGIN response');
      return result;
    },release: discard => { discarded = discard; client.release(discard); }};
  } };
  try {
    await assert.rejects(new PostgresAuthority(beginLossPool,3600).transaction(scope,async () => {
      throw new Error('callback must not run');
    }),/lost BEGIN response/);
    assert.equal(discarded,true);
    assert.deepEqual(await counts(scope.spaceId),{
      records:0,record_unique_keys:0,record_index_values:0,record_events:0,
      idempotency_receipts:0,record_tombstones:0,projection_outbox:0 });
    const borrower = await single.connect();
    try {
      assert.equal((await borrower.query('SELECT txid_current_if_assigned() AS id')).rows[0].id,null);
    } finally { borrower.release(); }
    assert.equal((await new PostgresAuthority(single,3600).mutate(scope,
      change('create','after-begin-loss','{"label":"safe"}'))).revision,1);
  } finally { await single.end(); }
});

test('caught create, replace and patch mutation errors make the transaction rollback-only', async () => {
  const { scope } = await fixture();
  const badCreate = change('create','bad-create','{"label":"bad"}',
    {unique:[{name:'',encodedValue:'s:3:bad'}]});
  await assert.rejects(authority.transaction(scope,async tx => {
    await assert.rejects(tx.mutate(badCreate),error => error.code === 'INVALID_ARGUMENT');
    return 'caught';
  }),error => error.code === 'INVALID_ARGUMENT');
  assert.equal((await counts(scope.spaceId)).records,0);

  const initial = await authority.mutate(scope,change('create','good-create','{"label":"good","score":1}',{
    unique:[{name:'label',encodedValue:'s:4:good'}],indexes:[{field:'score',kind:'number',value:1}]
  }));
  const before = await counts(scope.spaceId);
  for (const [operation,extras] of [
    ['replace',{unique:[{name:'',encodedValue:'s:3:bad'}]}],
    ['patch',{indexes:[{field:'',kind:'number',value:2}]}]
  ]) {
    const bad = change(operation,`bad-${operation}`,'{"label":"changed","score":2}',{
      recordId:initial.ref.id,expectedRevision:1,...extras
    });
    await assert.rejects(authority.transaction(scope,async tx => {
      await assert.rejects(tx.mutate(bad),error => error.code === 'INVALID_ARGUMENT');
      return 'caught';
    }),error => error.code === 'INVALID_ARGUMENT');
    assert.deepEqual(await counts(scope.spaceId),before);
    const stored = await authority.transaction({ ...scope,capability:'records:read' },
      tx => tx.getRecord(initial.ref.id));
    assert.equal(stored.revision,1);
    assert.equal(stored.canonicalData,'{"label":"good","score":1}');
  }
});

test('overlapping same-key calls inside one transaction reserve one effect and mismatches roll back', async () => {
  const { scope } = await fixture();
  const request=change('create','same-transaction','{"label":"one"}');
  const [first,second]=await authority.transaction(scope,tx=>Promise.all([tx.mutate(request),tx.mutate(request)]));
  assert.equal(second.receiptId,first.receiptId);
  assert.equal(second.replayed,true);
  assert.deepEqual(await counts(scope.spaceId),{
    records:1,record_unique_keys:0,record_index_values:0,record_events:1,idempotency_receipts:1,record_tombstones:0,projection_outbox:1
  });
  await assert.rejects(authority.transaction(scope,async tx => {
    const results=await Promise.allSettled([
      tx.mutate(change('create','mismatch','{"label":"two"}')),
      tx.mutate(change('create','mismatch','{"label":"three"}'))
    ]);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
  }),error=>error.code==='IDEMPOTENCY_MISMATCH');
  assert.equal((await counts(scope.spaceId)).records,1);
});

test('callback interruption waits for an unawaited mutation before rollback and pool reuse', async () => {
  const { scope } = await fixture();
  const single=new pg.Pool({connectionString:url,max:1});
  const repository=new PostgresAuthority(single,3600);
  try {
    await assert.rejects(repository.transaction(scope,async tx=>{
      void tx.mutate(change('create','abandoned','{"label":"temporary"}'));
      throw new Error('interrupted callback');
    }),/interrupted callback/);
    assert.equal((await counts(scope.spaceId)).records,0);
    const safe=await repository.mutate(scope,change('create','after-interruption','{"label":"safe"}'));
    assert.equal(safe.revision,1);
    assert.equal((await counts(scope.spaceId)).record_events,1);
  } finally { await single.end(); }
});

test('chained mutations after callback admission closes cannot commit partial facts', async () => {
  const { scope } = await fixture();
  const single = new pg.Pool({connectionString:url,max:1});
  const repository = new PostgresAuthority(single,3600);
  let follow;
  try {
    await assert.rejects(repository.transaction(scope,async tx => {
      const first=tx.mutate(change('create','chained-first','{"label":"first"}'));
      follow=first.then(()=>tx.mutate(change('create','chained-second','{"label":"second"}')));
      void follow.catch(()=>{});
      return 'callback finished';
    }),error=>error.code==='INVALID_ARGUMENT');
    await assert.rejects(follow,error=>error.code==='INVALID_ARGUMENT');
    assert.deepEqual(await counts(scope.spaceId),{
      records:0,record_unique_keys:0,record_index_values:0,record_events:0,
      idempotency_receipts:0,record_tombstones:0,projection_outbox:0
    });
    const safe=await repository.mutate(scope,change('create','after-chain','{"label":"safe"}'));
    assert.equal(safe.revision,1);
    assert.equal((await counts(scope.spaceId)).record_events,1);
  } finally { await single.end(); }
});

test('runtime mutations use shared policy locks and no advisory SQL', async () => {
  const { scope } = await fixture();
  let sawPolicyLock=false;
  const supportedPool={connect:async()=>{
    const client=await pool.connect();
    return {query:(sql,...args)=>{
      if (String(sql).includes('advisory')) throw new Error('Hyperdrive rejects advisory locks');
      if (String(sql).includes('FOR SHARE OF s,c')) sawPolicyLock=true;
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }};
  const repository=new PostgresAuthority(supportedPool,3600);
  const request=change('create','supported-lock','{"label":"one"}');
  const first=await repository.mutate(scope,request);
  const replay=await repository.mutate(scope,request);
  assert.equal(replay.receiptId,first.receiptId);
  assert.equal(replay.replayed,true);
  assert.equal(sawPolicyLock,true);
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('replace and patch require complete declared values and keep read indexes consistent', async () => {
  const { scope } = await fixture();
  const initial=await authority.mutate(scope,change('create','complete-first','{"label":"one","score":1}',{
    unique:[{name:'label',encodedValue:'s:3:one'}],indexes:[{field:'score',kind:'number',value:1}]
  }));
  const read={...scope,capability:'records:read'};
  const score=value=>[{field:'score',kind:'number',operator:'eq',value}];
  const incomplete=change('patch','incomplete','{"label":"two","score":2}',{recordId:initial.ref.id,expectedRevision:1});
  delete incomplete.unique;
  delete incomplete.indexes;
  await assert.rejects(authority.mutate(scope,incomplete),error=>error.code==='INVALID_ARGUMENT');
  assert.equal(await authority.transaction(read,tx=>tx.countRecords(score(1))),1);
  const patched=await authority.mutate(scope,change('patch','complete-patch','{"label":"two","score":2}',{
    recordId:initial.ref.id,expectedRevision:1,
    unique:[{name:'label',encodedValue:'s:3:two'}],indexes:[{field:'score',kind:'number',value:2}]
  }));
  assert.equal(patched.revision,2);
  assert.equal(await authority.transaction(read,tx=>tx.countRecords(score(1))),0);
  assert.equal(await authority.transaction(read,tx=>tx.countRecords(score(2))),1);
  assert.equal(await authority.transaction(read,tx=>tx.existsRecord(score(2))),true);
  await assert.rejects(authority.mutate(scope,change('create','conflict-after-patch','{"label":"two"}',{
    unique:[{name:'label',encodedValue:'s:3:two'}]
  })),error=>error.code==='UNIQUE_CONFLICT');
  const replay=await authority.mutate(scope,change('patch','complete-patch','{"label":"two","score":2}',{
    recordId:initial.ref.id,expectedRevision:1,
    unique:[{name:'label',encodedValue:'s:3:two'}],indexes:[{field:'score',kind:'number',value:2}]
  }));
  assert.equal(replay.receiptId,patched.receiptId);
  assert.equal((await counts(scope.spaceId)).record_events,2);
});

test('empty indexed strings work and malformed null values and outbox booleans fail', async () => {
  const { scope } = await fixture();
  await pool.query(`INSERT INTO collection_index_declarations(space_id,collection_id,field_name,value_kind,filterable,sortable,ready,accepted_version)
    VALUES($1,$2,'text','string',TRUE,TRUE,TRUE,1),($1,$2,'nothing','string',TRUE,FALSE,TRUE,1)`,
  [scope.spaceId,scope.collectionId]);
  const saved=await authority.mutate(scope,change('create','empty-string','{"text":""}',{
    indexes:[{field:'text',kind:'string',value:''},{field:'nothing',kind:'null'}]
  }));
  const read={...scope,capability:'records:read'};
  const predicate=[{field:'text',kind:'string',operator:'eq',value:''}];
  assert.equal(await authority.transaction(read,tx=>tx.countRecords(predicate)),1);
  assert.equal(await authority.transaction(read,tx=>tx.existsRecord(predicate)),true);
  assert.equal((await authority.transaction(read,tx=>tx.queryRecords(predicate,10)))[0].ref.id,saved.ref.id);
  await assert.rejects(authority.mutate(scope,change('create','bad-null','{}',{
    indexes:[{field:'nothing',kind:'null',value:'ignored'}]
  })),error=>error.code==='INVALID_ARGUMENT');
  const admin={...scope,principalId:'owner',capability:'space:admin'};
  const [delivery]=await authority.transaction(admin,tx=>tx.claimOutbox(1,30));
  await assert.rejects(authority.transaction(admin,tx=>tx.finishOutbox(delivery,'false')),error=>error.code==='INVALID_ARGUMENT');
  assert.equal((await pool.query('SELECT delivery_state FROM projection_outbox WHERE event_id=$1',[delivery.eventId])).rows[0].delivery_state,'delivering');
});

test('mutation facts use entry snapshots across waits and indexed list traversal', async () => {
  const { scope } = await fixture();
  let entered,release;
  const queryStarted=new Promise(resolve=>entered=resolve);
  const queryHeld=new Promise(resolve=>release=resolve);
  const heldPool={connect:async()=>{
    const client=await pool.connect();
    return {query:async(sql,...args)=>{
      if (typeof sql==='string' && sql.includes('SELECT s.lifecycle,s.placement_generation,c.lifecycle')) {
        entered(); await queryHeld;
      }
      return client.query(sql,...args);
    },release:discard=>client.release(discard)};
  }};
  const original=change('create','entry-key','{"label":"entry"}');
  const moving=new PostgresAuthority(heldPool,3600).mutate(scope,original);
  await queryStarted;
  original.idempotencyKey='changed-key';
  original.requestDigest=digest('changed');
  original.canonicalData='{"label":"changed"}';
  release();
  const saved=await moving;
  const facts=await pool.query(`SELECT r.canonical_data,e.canonical_data AS event_data,i.idempotency_key,i.request_digest
    FROM records r JOIN record_events e USING(space_id,collection_id,record_id)
    JOIN idempotency_receipts i USING(space_id,collection_id,record_id)
    WHERE r.space_id=$1 AND r.record_id=$2`,[scope.spaceId,saved.ref.id]);
  assert.equal(facts.rows[0].canonical_data,'{"label":"entry"}');
  assert.equal(facts.rows[0].event_data,'{"label":"entry"}');
  assert.equal(facts.rows[0].idempotency_key,'entry-key');
  assert.equal(facts.rows[0].request_digest,digest(JSON.stringify(['create','entry-key','{"label":"entry"}',{}])));
  const unique=[{name:'label',encodedValue:'s:4:list'}];
  unique[Symbol.iterator]=function* () {};
  const indexed=await authority.mutate(scope,change('create','indexed','{"label":"list"}',{unique}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM record_unique_keys WHERE space_id=$1 AND record_id=$2',
    [scope.spaceId,indexed.ref.id])).rows[0].n,1);
});

test('NUL in identifiers, JSON and typed values is a typed rejection without rows', async () => {
  const { scope } = await fixture();
  for (const request of [
    change('create','bad\0key','{"label":"one"}'),
    change('create','bad-json','{"label":"\\u0000"}'),
    change('create','bad-unique','{"label":"one"}',{unique:[{name:'label',encodedValue:'bad\0key'}]}),
    change('create','bad-index','{"label":"one"}',{indexes:[{field:'score',kind:'string',value:'bad\0value'}]})
  ]) await assert.rejects(authority.mutate(scope,request),error=>error instanceof AuthorityError &&
    ['INVALID_ARGUMENT','SCHEMA_INVALID'].includes(error.code));
  assert.equal((await counts(scope.spaceId)).records,0);
});

test('original collection grant must remain live at replay commit', async () => {
  const { scope,otherId } = await fixture();
  const request=change('create','expiring-original','{"label":"one"}');
  await authority.mutate(scope,request);
  await pool.query(`INSERT INTO collection_grants(space_id,collection_id,credential_id,capabilities)
    VALUES($1,$2,$3,ARRAY['records:write'])`,[scope.spaceId,otherId,scope.credentialId]);
  await pool.query("UPDATE collection_grants SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE space_id=$1 AND collection_id=$2 AND credential_id=$3",
    [scope.spaceId,scope.collectionId,scope.credentialId]);
  await assert.rejects(authority.transaction({...scope,collectionId:otherId},async tx=>{
    const replay=await tx.mutate(request);
    assert.equal(replay.replayed,true);
    await new Promise(resolve=>setTimeout(resolve,450));
  }),error=>error.code==='FORBIDDEN');
  assert.equal((await counts(scope.spaceId)).record_events,1);
});

test('failed outbox delivery is not claimable on every poll', async () => {
  const { scope } = await fixture();
  await authority.mutate(scope,change('create','backoff','{"label":"one"}'));
  const admin={...scope,principalId:'owner',capability:'space:admin'};
  const [delivery]=await authority.transaction(admin,tx=>tx.claimOutbox(1,30));
  assert.equal(await authority.transaction(admin,tx=>tx.finishOutbox(delivery,false,'projection failed')),true);
  assert.deepEqual(await authority.transaction(admin,tx=>tx.claimOutbox(1,30)),[]);
  const row=await pool.query('SELECT delivery_state,available_at>clock_timestamp() AS delayed FROM projection_outbox WHERE event_id=$1',[delivery.eventId]);
  assert.equal(row.rows[0].delivery_state,'degraded');
  assert.equal(row.rows[0].delayed,true);
});

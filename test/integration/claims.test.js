import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresClaims, PostgresSources, PostgresSpaces, claimBounds, postgresServices } from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const pool = new pg.Pool({ connectionString: url, max: 8 });
const root = fileURLToPath(new URL('../..', import.meta.url));
test.after(() => pool.end());
const sha = value => createHash('sha256').update(value).digest('hex');

/** Just enough of an R2 binding for text ingestion: atomic put with its checksum, head and get. */
class MemoryR2 {
  objects = new Map();
  async put(key, body, options = {}) {
    const chunks = [];
    const reader = body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    const bytes = Buffer.concat(chunks);
    if (options.sha256 !== undefined && options.sha256 !== sha(bytes)) throw new Error('put: checksum mismatch');
    this.objects.set(key, { bytes, sha256: options.sha256 });
    return this.meta(key);
  }
  meta(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, checksums: object.sha256 ? { sha256: new Uint8Array(Buffer.from(object.sha256, 'hex')).buffer } : {} } : null;
  }
  async head(key) { return this.meta(key); }
  async get(key) { const meta = this.meta(key); return meta && { ...meta, body: new Blob([this.objects.get(key).bytes]).stream() }; }
  async delete(key) { this.objects.delete(key); }
  async list() { return { objects: [], truncated: false }; }
}
const rejects = (promise, code, message) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `${message ?? ''}: ${error.code} ${error.message}`);
  return true;
}, message);

/** A pool whose hooks run once before the first statement containing their text. */
let hooks = [];
const hooked = { connect: async () => {
  const client = await pool.connect();
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return async (sql, ...rest) => {
      const hook = typeof sql === 'string' ? hooks.find(item => sql.includes(item.match)) : undefined;
      if (hook) { hooks = hooks.filter(item => item !== hook); await hook.run(); }
      return target.query(sql, ...rest);
    };
  } });
} };

const config = { database: memoryAdapter(), namespace: `sta35-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
const hookedClaims = new PostgresClaims(spaces, new Map([['cell-a', { pool: hooked }]]));
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });

/**
 * A space with collections alpha and beta, a text source with an extraction
 * in each, and agents whose grants differ only where a test needs them to.
 */
async function fixture() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const owner = await verify((await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  for (const id of ['alpha', 'beta']) await services.collections.define(owner, spaceId, id, definition(id));
  const agent = async (grants, expiresAt) => {
    const key = await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
      grants.map(([collectionId, capabilities]) => ({ collectionId, capabilities, ...(expiresAt?.[collectionId] ? { expiresAt: expiresAt[collectionId] } : {}) })));
    return Object.assign(await verify(key.secret), { keyId: key.id });
  };
  const sources = new PostgresSources(spaces, new Map([['cell-a', { pool, originals: new R2BlobStore(new MemoryR2()) }]]));
  const source = async collectionId => {
    const created = await sources.ingestText(owner, spaceId, collectionId, { idempotencyKey: `src-${collectionId}`,
      text: `The ${collectionId} report says the bridge opened in 1932.` });
    await sources.extract(owner, spaceId, collectionId, created.sourceId);
    return created.sourceId;
  };
  const writer = ['claims:write', 'claims:read', 'sources:read'];
  return { spaceId, owner, agent, sources, alphaSource: await source('alpha'), betaSource: await source('beta'),
    writer: await agent([['alpha', writer]]), reviewer: await agent([['alpha', ['claims:review', 'claims:read', 'sources:read']]]),
    reader: await agent([['alpha', ['claims:read', 'sources:read']]]),
    both: await agent([['alpha', ['claims:read', 'sources:read']], ['beta', ['sources:read']]]) };
}
const claimRows = async spaceId => (await pool.query(`SELECT (SELECT count(*)::int FROM claims WHERE space_id=$1) AS claims,
  (SELECT count(*)::int FROM claim_revisions WHERE space_id=$1) AS revisions,
  (SELECT count(*)::int FROM claim_evidence WHERE space_id=$1) AS evidence,
  (SELECT count(*)::int FROM entity_refs WHERE space_id=$1 AND kind='claim') AS refs`, [spaceId])).rows[0];
const principal = async actor => (await pool.query('SELECT principal_id FROM space_credentials WHERE credential_id=$1',
  [actor.credentialId])).rows[0].principal_id;
const statement = (n = 1) => ({ statement: `The bridge opened in ${1930 + n}.`, attributedTo: 'city archive' });

test('a claim is created unreviewed with attribution, times and evidence, revised, reviewed and replayed', async () => {
  const f = await fixture();
  const request = { idempotencyKey: 'c1', ...statement(2), observedAt: '2026-03-04T05:06:07.123Z',
    validFrom: '1932-01-01T00:00:00Z', validUntil: '2999-01-01T00:00:00Z',
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }, { collectionId: 'alpha', sourceId: f.alphaSource,
      extractionVersion: 1, start: 4, end: 16 }] };
  const created = await claims.create(f.writer, f.spaceId, 'alpha', request);
  assert.deepEqual({ ...created, claimId: null, createdAt: null, committedAt: null }, {
    claimId: null, collectionId: 'alpha', revision: 1, latestRevision: 1, previousRevision: null,
    statement: 'The bridge opened in 1932.', attributedTo: 'city archive', observedAt: '2026-03-04T05:06:07.123Z',
    validFrom: '1932-01-01T00:00:00.000Z', validUntil: '2999-01-01T00:00:00.000Z',
    review: { status: 'unreviewed', reviewedBy: null, reviewedAt: null },
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource, extractionVersion: null, start: null, end: null },
      { collectionId: 'alpha', sourceId: f.alphaSource, extractionVersion: 1, start: 4, end: 16 }],
    createdBy: created.createdBy, createdAt: null, committedAt: null, replayed: false });
  assert.match(created.claimId, /^clm_[0-9a-f]{64}$/);

  // A retry replays revision 1; another payload or collection under the key is a mismatch.
  assert.deepEqual(await claims.create(f.writer, f.spaceId, 'alpha', request), { ...created, replayed: true });
  await rejects(claims.create(f.writer, f.spaceId, 'alpha', { ...request, attributedTo: 'someone else' }), 'IDEMPOTENCY_MISMATCH');
  await rejects(claims.create(f.writer, f.spaceId, 'alpha', { ...request, evidence: request.evidence.slice(1) }), 'IDEMPOTENCY_MISMATCH');
  const { observedAt: _observed, ...unobserved } = request;
  await rejects(claims.create(f.writer, f.spaceId, 'alpha', unobserved), 'IDEMPOTENCY_MISMATCH');
  const ownerClaim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'k', ...statement() });
  await rejects(claims.create(f.owner, f.spaceId, 'beta', { idempotencyKey: 'k', ...statement() }), 'IDEMPOTENCY_MISMATCH',
    'the same key in another collection is not a second claim');
  assert.deepEqual(ownerClaim.evidence, []);
  assert.equal(ownerClaim.observedAt, null, 'an unstated observation time stays unstated');

  // Revision 2 replaces the content and is unreviewed; revision 1 stays readable.
  const revision = { baseRevision: 1, ...statement(3), evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }] };
  const revised = await claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, revision);
  assert.deepEqual([revised.revision, revised.previousRevision, revised.latestRevision, revised.statement, revised.observedAt,
    revised.review.status], [2, 1, 2, 'The bridge opened in 1933.', null, 'unreviewed']);
  assert.deepEqual(await claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, revision), { ...revised, replayed: true });
  await rejects(claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { ...revision, statement: 'Other.' }),
    'REVISION_CONFLICT', 'another revision after an old base conflicts');
  await rejects(claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { ...revision, baseRevision: 3 }), 'NOT_FOUND');
  assert.equal((await claims.get(f.reader, f.spaceId, 'alpha', created.claimId, 1)).statement, 'The bridge opened in 1932.');

  // Review is a new revision with the same content, the reviewer and the review time.
  const accepted = await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' });
  assert.deepEqual({ ...accepted, review: { ...accepted.review, reviewedAt: null }, committedAt: null }, {
    ...revised, revision: 3, previousRevision: 2, latestRevision: 3, committedAt: null,
    review: { status: 'accepted', reviewedBy: await principal(f.reviewer), reviewedAt: null } });
  assert.equal(created.createdBy, await principal(f.writer));
  assert.notEqual(accepted.review.reviewedBy, created.createdBy);
  assert.ok(Date.parse(accepted.review.reviewedAt) >= Date.parse(revised.committedAt));
  assert.deepEqual(await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' }),
    { ...accepted, replayed: true });
  await rejects(claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'rejected' }),
    'REVISION_CONFLICT');
  assert.deepEqual(await claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, revision),
    { ...revised, latestRevision: 3, replayed: true }, 'a revision retried after a review replays the revision, not the review');
  await rejects(claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, status: 'accepted' }),
    'REVISION_CONFLICT', 'a review never replays as a revision');
  const rejected = await claims.review(f.owner, f.spaceId, 'alpha', created.claimId, { baseRevision: 3, status: 'rejected' });
  assert.equal(rejected.review.status, 'rejected');
  // A later revision starts unreviewed again; the reviews stay in history.
  const again = await claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { ...revision, baseRevision: 4 });
  assert.equal(again.review.status, 'unreviewed');
  assert.deepEqual((await Promise.all([1, 2, 3, 4, 5].map(n => claims.get(f.reader, f.spaceId, 'alpha', created.claimId, n))))
    .map(view => view.review.status), ['unreviewed', 'unreviewed', 'accepted', 'rejected', 'unreviewed']);
  assert.equal((await claims.get(f.reader, f.spaceId, 'alpha', created.claimId)).revision, 5);
  await rejects(claims.get(f.reader, f.spaceId, 'alpha', created.claimId, 6), 'NOT_FOUND');
  await rejects(claims.get(f.reader, f.spaceId, 'alpha', 'clm_missing'), 'NOT_FOUND');
});

test('a review copies the reviewed revision exactly, and times finer than a millisecond are refused', async () => {
  const f = await fixture();
  const stored = async claimId => (await pool.query(`SELECT revision,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS o,
      to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS f,to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS u,
      statement,attributed_to,(SELECT json_agg(json_build_array(source_collection_id,source_id,extraction_version,start_offset,end_offset)
        ORDER BY ordinal) FROM claim_evidence v WHERE v.space_id=r.space_id AND v.claim_id=r.claim_id AND v.revision=r.revision) AS evidence
    FROM claim_revisions r WHERE space_id=$1 AND claim_id=$2 ORDER BY revision`, [f.spaceId, claimId])).rows;
  const before = await claimRows(f.spaceId);
  for (const [name, value] of [['observedAt', '2026-03-04T05:06:07.1234Z'], ['validFrom', '2026-03-04T05:06:07.123456Z'],
    ['validUntil', '2999-01-01T00:00:00.0001Z']])
    await rejects(claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: name, ...statement(), [name]: value }),
      'INVALID_ARGUMENT', `${name} ${value}`);
  assert.deepEqual(await claimRows(f.spaceId), before, 'a refused time writes nothing');
  // Trailing zeros carry no precision, so they are accepted.
  const created = await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'ms', ...statement(),
    observedAt: '2026-03-04T05:06:07.123000Z', validFrom: '2026-03-04T05:06:07.001Z', validUntil: '2026-03-04T05:06:07.999Z',
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource, extractionVersion: 1, start: 1, end: 5 }] });
  assert.deepEqual([created.observedAt, created.validFrom, created.validUntil],
    ['2026-03-04T05:06:07.123Z', '2026-03-04T05:06:07.001Z', '2026-03-04T05:06:07.999Z'], 'views report stored times exactly');
  // A revision stored with microseconds, such as one written before this bound, is reviewed without losing them.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO claim_revisions(space_id,collection_id,claim_id,revision,statement,attributed_to,credential_id,
        observed_at,valid_from,valid_until) VALUES($1,'alpha',$2,2,'Precise.','a lab',$3,'2026-03-04T05:06:07.123456Z',
        '2026-03-04T05:06:07.123456Z','2026-03-04T05:06:07.123457Z')`, [f.spaceId, created.claimId, f.writer.credentialId]);
    await client.query(`INSERT INTO claim_evidence(space_id,collection_id,claim_id,revision,ordinal,source_collection_id,source_id,
        extraction_version,start_offset,end_offset) VALUES($1,'alpha',$2,2,0,'alpha',$3,1,2,9)`, [f.spaceId, created.claimId, f.alphaSource]);
    await client.query(`UPDATE entity_refs SET revision=2 WHERE space_id=$1 AND kind='claim' AND entity_id=$2`, [f.spaceId, created.claimId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const accepted = await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' });
  const [, base, review] = await stored(created.claimId);
  assert.equal(review.revision, '3');
  assert.deepEqual({ ...review, revision: null }, { ...base, revision: null }, 'content, times and evidence are copied exactly');
  assert.equal(review.u, '2026-03-04T05:06:07.123457');
  assert.equal(accepted.review.status, 'accepted');
  assert.deepEqual(await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' }),
    { ...accepted, replayed: true }, 'a retried review replays against the stored base');
  await rejects(claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'rejected' }),
    'REVISION_CONFLICT');
  assert.equal((await stored(created.claimId)).length, 3);
});

test('only claims:review accepts or rejects a claim, and writes cannot set a review status', async () => {
  const f = await fixture();
  const created = await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'c', ...statement() });
  const accept = { baseRevision: 1, status: 'accepted' };
  const reviewOnly = await f.agent([['alpha', ['claims:review']]]);
  const betaReviewer = await f.agent([['alpha', ['claims:read']], ['beta', ['claims:review', 'claims:read']]]);
  for (const [actor, name] of [[f.writer, 'a writer and reader'], [f.reader, 'a reader'], [reviewOnly, 'a reviewer who cannot read'],
    [betaReviewer, 'a reviewer of another collection']])
    await rejects(claims.review(actor, f.spaceId, 'alpha', created.claimId, accept), 'FORBIDDEN', name);
  for (const field of [{ status: 'accepted' }, { reviewStatus: 'accepted' }, { reviewedBy: 'me' }])
    await rejects(claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'self', ...statement(), ...field }),
      'INVALID_ARGUMENT', `create refuses ${Object.keys(field)[0]}`);
  await rejects(claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, ...statement(), status: 'accepted' }),
    'INVALID_ARGUMENT');
  for (const status of ['unreviewed', 'ACCEPTED', undefined, null])
    await rejects(claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, status }), 'INVALID_ARGUMENT');
  assert.equal((await claims.get(f.reader, f.spaceId, 'alpha', created.claimId)).review.status, 'unreviewed');
  assert.equal((await claimRows(f.spaceId)).revisions, 1, 'refused reviews write nothing');

  // Writing needs claims:write; revising and reviewing also need claims:read.
  const writeOnly = await f.agent([['alpha', ['claims:write']]]);
  assert.equal((await claims.create(writeOnly, f.spaceId, 'alpha', { idempotencyKey: 'w', ...statement() })).revision, 1);
  await rejects(claims.revise(writeOnly, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, ...statement(2) }), 'FORBIDDEN');
  await rejects(claims.create(f.reader, f.spaceId, 'alpha', { idempotencyKey: 'r', ...statement() }), 'FORBIDDEN');
  await rejects(claims.get(writeOnly, f.spaceId, 'alpha', created.claimId), 'FORBIDDEN');
  await rejects(claims.get(f.reviewer, f.spaceId, 'beta', created.claimId), 'FORBIDDEN', 'an ungranted collection');

  // A read-only collection refuses review, even a replay, and new claims, but replays a committed create.
  const reviewed = await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, accept);
  await pool.query(`UPDATE collections SET lifecycle='readOnly' WHERE space_id=$1 AND collection_id='alpha'`, [f.spaceId]);
  await rejects(claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, accept), 'SPACE_UNAVAILABLE');
  await rejects(claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'new', ...statement() }), 'SPACE_UNAVAILABLE');
  await rejects(claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, ...statement(2) }), 'SPACE_UNAVAILABLE');
  assert.equal((await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'c', ...statement() })).replayed, true);
  assert.deepEqual(await claims.get(f.reader, f.spaceId, 'alpha', created.claimId), reviewed);
  await spaces.update(f.owner, f.spaceId, 'suspended');
  await rejects(claims.get(f.reader, f.spaceId, 'alpha', created.claimId), 'SPACE_UNAVAILABLE');
});

test('conflicting claims stay visible: reviewing one changes no other, and all are listed by source and status', async () => {
  const f = await fixture();
  const cite = [{ collectionId: 'alpha', sourceId: f.alphaSource, extractionVersion: 1, start: 0, end: 10 }];
  const made = [];
  for (const [n, who] of [[2, 'city archive'], [5, 'a newspaper'], [7, 'a guidebook']])
    made.push(await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: `c${n}`, statement: `The bridge opened in ${1930 + n}.`,
      attributedTo: who, evidence: cite }));
  const unrelated = await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'other', ...statement(9) });
  const [first, second, third] = made;
  await claims.review(f.reviewer, f.spaceId, 'alpha', first.claimId, { baseRevision: 1, status: 'accepted' });
  await claims.review(f.reviewer, f.spaceId, 'alpha', second.claimId, { baseRevision: 1, status: 'rejected' });
  assert.deepEqual(await claims.get(f.reader, f.spaceId, 'alpha', third.claimId), third, 'accepting one claim leaves the others');
  assert.equal((await claims.get(f.reader, f.spaceId, 'alpha', second.claimId)).statement, 'The bridge opened in 1935.',
    'a rejected claim stays readable');

  const citing = { citing: { collectionId: 'alpha', sourceId: f.alphaSource } };
  const page = await claims.list(f.reader, f.spaceId, 'alpha', citing);
  const byId = id => page.claims.find(view => view.claimId === id);
  assert.equal(page.claims.length, 3);
  assert.equal(page.next, null);
  assert.deepEqual([byId(first.claimId).review.status, byId(second.claimId).review.status, byId(third.claimId).review.status],
    ['accepted', 'rejected', 'unreviewed']);
  assert.deepEqual(page.claims.map(view => view.claimId), [...page.claims.map(view => view.claimId)].sort());
  assert.deepEqual((await claims.list(f.reader, f.spaceId, 'alpha', { ...citing, status: 'rejected' })).claims.map(view => view.claimId),
    [second.claimId]);
  assert.equal((await claims.list(f.reader, f.spaceId, 'alpha')).claims.length, 4);
  // Pages follow claim ID order without gaps or repeats.
  const seen = [];
  let after;
  do {
    const next = await claims.list(f.reader, f.spaceId, 'alpha', { limit: 1, ...(after ? { after } : {}) });
    seen.push(...next.claims.map(view => view.claimId));
    after = next.next;
  } while (after);
  assert.deepEqual(seen, [...made, unrelated].map(view => view.claimId).sort());
  // A revision that drops the citation removes the claim from the source's list; history is unchanged.
  await claims.revise(f.writer, f.spaceId, 'alpha', third.claimId, { baseRevision: 1, ...statement(7) });
  assert.equal((await claims.list(f.reader, f.spaceId, 'alpha', citing)).claims.length, 2);
  for (const query of [{ limit: 0 }, { limit: claimBounds.page + 1 }, { status: 'pending' }, { after: '' }, { citing: {} }, { cursor: 'x' }])
    await rejects(claims.list(f.reader, f.spaceId, 'alpha', query), 'INVALID_ARGUMENT', JSON.stringify(query));
});

test('claims never write records', async () => {
  const f = await fixture();
  const receipt = await services.records.mutate(f.owner, f.spaceId, 'alpha',
    JSON.stringify({ operation: 'create', idempotencyKey: 'r1', data: { label: 'Opened 1932' } }));
  const records = async () => (await pool.query(`SELECT (SELECT json_agg(row_to_json(r) ORDER BY record_id) FROM records r
      WHERE space_id=$1) AS records, (SELECT count(*)::int FROM record_events WHERE space_id=$1) AS events,
      (SELECT count(*)::int FROM projection_outbox WHERE space_id=$1) AS outbox`, [f.spaceId])).rows[0];
  const before = await records();
  assert.equal(before.records.length, 1);
  const created = await claims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'about-record',
    statement: JSON.stringify({ recordId: receipt.ref.id, label: 'Opened 1933' }), attributedTo: 'an agent',
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }] });
  await claims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, statement: 'label=Opened 1934',
    attributedTo: 'an agent' });
  await claims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' });
  assert.deepEqual(await records(), before, 'an accepted claim leaves records, their events and the outbox unchanged');
});

test('a claim and its evidence are visible only to callers who may read every cited collection', async () => {
  const f = await fixture();
  const mixed = await f.agent([['alpha', ['claims:write', 'claims:read', 'sources:read']]]);
  const beta = { collectionId: 'beta', sourceId: f.betaSource };
  const before = await claimRows(f.spaceId);
  // Citing an unreadable collection is refused whether or not the source exists, and writes nothing.
  for (const sourceId of [f.betaSource, 'src_missing'])
    await rejects(claims.create(mixed, f.spaceId, 'alpha', { idempotencyKey: `x-${sourceId}`, ...statement(),
      evidence: [{ collectionId: 'beta', sourceId }] }), 'FORBIDDEN', sourceId);
  await rejects(claims.create(mixed, f.spaceId, 'alpha', { idempotencyKey: 'x', ...statement(),
    evidence: [{ collectionId: 'gamma', sourceId: 'src_missing' }] }), 'FORBIDDEN', 'an absent collection looks the same');
  assert.deepEqual(await claimRows(f.spaceId), before);

  // The owner cites beta from alpha. Readers of alpha alone never see the claim or its evidence.
  const derived = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'derived', ...statement(),
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }, beta] });
  const local = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'local', ...statement(4),
    evidence: [{ collectionId: 'alpha', sourceId: f.alphaSource }] });
  await rejects(claims.get(mixed, f.spaceId, 'alpha', derived.claimId), 'NOT_FOUND', 'withheld like a missing claim');
  await rejects(claims.get(mixed, f.spaceId, 'alpha', derived.claimId, 1), 'NOT_FOUND');
  assert.deepEqual((await claims.list(mixed, f.spaceId, 'alpha')).claims.map(view => view.claimId), [local.claimId]);
  await rejects(claims.list(mixed, f.spaceId, 'alpha', { citing: beta }), 'FORBIDDEN');
  await rejects(claims.revise(mixed, f.spaceId, 'alpha', derived.claimId, { baseRevision: 1, ...statement(2) }), 'NOT_FOUND');
  const reviewer = await f.agent([['alpha', ['claims:review', 'claims:read', 'sources:read']]]);
  await rejects(claims.review(reviewer, f.spaceId, 'alpha', derived.claimId, { baseRevision: 1, status: 'accepted' }), 'NOT_FOUND',
    'a reviewer cannot accept evidence they cannot read');
  const claimsOnly = await f.agent([['alpha', ['claims:read']]]);
  await rejects(claims.get(claimsOnly, f.spaceId, 'alpha', derived.claimId), 'NOT_FOUND', 'claims:read alone reads no evidence');
  const bare = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'bare', ...statement() });
  assert.equal((await claims.get(claimsOnly, f.spaceId, 'alpha', bare.claimId)).evidence.length, 0,
    'a claim without evidence needs no source access');

  // A caller who may read both collections sees it whole.
  assert.deepEqual(await claims.get(f.both, f.spaceId, 'alpha', derived.claimId), derived);
  assert.deepEqual((await claims.list(f.both, f.spaceId, 'alpha', { citing: beta })).claims.map(view => view.claimId), [derived.claimId]);
  // Declassification is unsupported: a revision that drops beta still carries beta-derived history.
  await claims.revise(f.owner, f.spaceId, 'alpha', derived.claimId, { baseRevision: 1, ...statement(2) });
  await rejects(claims.get(mixed, f.spaceId, 'alpha', derived.claimId), 'NOT_FOUND');
  assert.equal((await claims.get(f.both, f.spaceId, 'alpha', derived.claimId)).revision, 2);
  // A claim in beta is not reachable through alpha.
  const inBeta = await claims.create(f.owner, f.spaceId, 'beta', { idempotencyKey: 'beta', ...statement(), evidence: [beta] });
  await rejects(claims.get(f.both, f.spaceId, 'alpha', inBeta.claimId), 'NOT_FOUND');
  await rejects(claims.get(f.both, f.spaceId, 'beta', inBeta.claimId), 'FORBIDDEN');
  // Removing only the beta source grant from the same credential withholds the claim again; alpha still answers.
  await pool.query(`DELETE FROM collection_grants WHERE space_id=$1 AND credential_id=$2 AND collection_id='beta'`,
    [f.spaceId, f.both.credentialId]);
  await rejects(claims.get(f.both, f.spaceId, 'alpha', derived.claimId), 'NOT_FOUND');
  assert.deepEqual((await claims.list(f.both, f.spaceId, 'alpha')).claims.map(view => view.claimId).sort(),
    [local.claimId, bare.claimId].sort());
  await rejects(claims.list(f.both, f.spaceId, 'alpha', { citing: beta }), 'FORBIDDEN');
});

/** The final grant statement, which runs after the last provider call. */
const finalCheck = 'live AS (SELECT g.collection_id';
test('an owning or evidence grant that lapses before the final check refuses the call and writes nothing', async () => {
  const f = await fixture();
  const derived = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'derived', ...statement(),
    evidence: [{ collectionId: 'beta', sourceId: f.betaSource }] });
  for (const lapsed of ['alpha', 'beta']) for (const call of ['get', 'review']) {
    const expires = Date.now() + 1_500;
    const capabilities = call === 'get' ? ['claims:read', 'sources:read'] : ['claims:review', 'claims:read', 'sources:read'];
    const lapsing = await f.agent([['alpha', capabilities], ['beta', ['sources:read']]], { [lapsed]: new Date(expires) });
    const run = () => call === 'get' ? hookedClaims.get(lapsing, f.spaceId, 'alpha', derived.claimId)
      : hookedClaims.review(lapsing, f.spaceId, 'alpha', derived.claimId, { baseRevision: 1, status: 'accepted' });
    if (call === 'get') assert.equal((await run()).claimId, derived.claimId, 'the grants admit the call before they lapse');
    const before = await claimRows(f.spaceId);
    // Hold the final check, after every fence passed and the provider answered, until one grant has expired.
    hooks.push({ match: finalCheck, run: () => sleep(Math.max(0, expires + 300 - Date.now())) });
    await rejects(run(), 'FORBIDDEN', `${call} with ${lapsed} lapsed`);
    assert.equal(hooks.length, 0, 'the hook ran');
    assert.deepEqual(await claimRows(f.spaceId), before);
  }
  assert.equal((await claims.get(f.both, f.spaceId, 'alpha', derived.claimId)).revision, 1, 'no review committed');
});

test('a nonowner cell role with the evidence grants creates, revises, reviews and reads claims', async () => {
  const f = await fixture();
  // Stand-in for the role's pre-040 provisioning: every other table, and nothing on the evidence tables until the script.
  const role = `sta35_cell_${randomUUID().replaceAll('-', '')}`;
  const evidenceTables = ['sources', 'original_objects', 'source_upload_grants', 'source_upload_attempts', 'extraction_versions',
    'claims', 'claim_revisions', 'claim_evidence', 'links'];
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const cellPool = new pg.Pool({ connectionString: url, max: 2, options: `-c role=${role}` });
  try {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`REVOKE ALL ON ${evidenceTables.join(',')} FROM ${role}`);
    await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const roleClaims = new PostgresClaims(spaces, new Map([['cell-a', { pool: cellPool }]]));
    await assert.rejects(roleClaims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'before', ...statement() }),
      error => error.code === '42501', 'claims need the evidence grants');
    execFileSync(process.execPath, ['scripts/grant-evidence.mjs'], { cwd: root, stdio: 'pipe',
      env: { ...process.env, STATEPLANE_CELL_ADMIN_URL: url, STATEPLANE_CELL_ROLE: role } });
    const cite = [{ collectionId: 'alpha', sourceId: f.alphaSource, extractionVersion: 1, start: 0, end: 3 }];
    const created = await roleClaims.create(f.writer, f.spaceId, 'alpha', { idempotencyKey: 'role', ...statement(), evidence: cite });
    const revised = await roleClaims.revise(f.writer, f.spaceId, 'alpha', created.claimId, { baseRevision: 1, ...statement(2), evidence: cite });
    const accepted = await roleClaims.review(f.reviewer, f.spaceId, 'alpha', created.claimId, { baseRevision: 2, status: 'accepted' });
    assert.deepEqual([revised.revision, accepted.revision, accepted.review.status, accepted.evidence], [2, 3, 'accepted', revised.evidence]);
    assert.deepEqual(await roleClaims.get(f.reader, f.spaceId, 'alpha', created.claimId), accepted);
    assert.deepEqual((await roleClaims.list(f.reader, f.spaceId, 'alpha')).claims, [accepted]);
    assert.equal((await cellPool.query('SELECT current_user AS who')).rows[0].who, role, 'the calls ran as the nonowner role');
  } finally {
    await cellPool.end();
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

test('malformed claims are refused after authorization and write nothing', async () => {
  const f = await fixture();
  const ok = { idempotencyKey: 'bad', ...statement() };
  const at = { collectionId: 'alpha', sourceId: f.alphaSource };
  const extracted = (await f.sources.extraction(f.owner, f.spaceId, 'alpha', f.alphaSource)).content;
  const length = [...extracted].length;
  const before = await claimRows(f.spaceId);
  const proxy = new Proxy({ ...ok }, {});
  for (const [request, code, message] of [
    [{ ...ok, statement: '' }, 'INVALID_ARGUMENT', 'an empty statement'],
    [{ ...ok, statement: 'a\u0000b' }, 'INVALID_ARGUMENT', 'NUL'],
    [{ ...ok, statement: 'a\ud800' }, 'INVALID_ARGUMENT', 'a lone surrogate'],
    [{ ...ok, statement: 'x'.repeat(claimBounds.statementBytes + 1) }, 'INVALID_ARGUMENT', 'an oversized statement'],
    [{ ...ok, attributedTo: undefined }, 'INVALID_ARGUMENT', 'an undefined attribution'],
    [{ idempotencyKey: 'bad', statement: 'x' }, 'INVALID_ARGUMENT', 'no attribution'],
    [{ ...ok, attributedTo: 'é'.repeat(513) }, 'INVALID_ARGUMENT', 'attribution over 1,024 bytes'],
    [{ ...ok, observedAt: '2999-01-01T00:00:00Z' }, 'INVALID_ARGUMENT', 'a future observation'],
    [{ ...ok, observedAt: '2026-01-01T00:00:00+01:00' }, 'INVALID_ARGUMENT', 'a non-UTC time'],
    [{ ...ok, validFrom: '2020-01-02T00:00:00Z', validUntil: '2020-01-01T00:00:00Z' }, 'INVALID_ARGUMENT', 'valid times out of order'],
    [{ ...ok, evidence: {} }, 'INVALID_ARGUMENT', 'evidence that is not an array'],
    [{ ...ok, evidence: Array(claimBounds.evidence + 1).fill(at) }, 'INVALID_ARGUMENT', 'too much evidence'],
    [{ ...ok, evidence: [{ ...at, start: 0, end: 1 }] }, 'INVALID_ARGUMENT', 'a range without a version'],
    [{ ...ok, evidence: [{ ...at, extractionVersion: 1, start: 3, end: 3 }] }, 'INVALID_ARGUMENT', 'an empty range'],
    [{ ...ok, evidence: [{ ...at, extractionVersion: 1, start: 0 }] }, 'INVALID_ARGUMENT', 'a start without an end'],
    [{ ...ok, evidence: [{ ...at, extractionVersion: 1, start: 0, end: length + 1 }] }, 'INVALID_ARGUMENT', 'a range past the content'],
    [{ ...ok, evidence: [{ ...at, extractionVersion: 0 }] }, 'INVALID_ARGUMENT', 'version 0'],
    [{ ...ok, evidence: [{ ...at, quote: 'x' }] }, 'INVALID_ARGUMENT', 'an unknown evidence field'],
    [{ ...ok, evidence: [{ ...at, extractionVersion: 2 }] }, 'NOT_FOUND', 'a missing extraction version'],
    [{ ...ok, evidence: [{ ...at, sourceId: 'src_missing' }] }, 'NOT_FOUND', 'a missing source in a readable collection'],
    [{ ...ok, status: 'accepted' }, 'INVALID_ARGUMENT', 'an unknown field'],
    [proxy, 'INVALID_ARGUMENT', 'a proxy'],
  ]) await rejects(claims.create(f.writer, f.spaceId, 'alpha', request), code, message);
  assert.deepEqual(await claimRows(f.spaceId), before);
  const full = await claims.create(f.writer, f.spaceId, 'alpha', { ...ok, evidence: [{ ...at, extractionVersion: 1, start: 0, end: length }] });
  assert.equal(full.evidence[0].end, length, 'a range may end at the content end, in code points');
  // A refused request is refused only after the collection is authorized.
  const outsider = await f.agent([['beta', ['claims:write']]]);
  await rejects(claims.create(outsider, f.spaceId, 'alpha', { statement: '' }), 'FORBIDDEN');
});

test('concurrent writers on one claim commit one revision each base', async () => {
  const f = await fixture();
  const request = { idempotencyKey: 'race', ...statement() };
  const creates = await Promise.all(Array.from({ length: 4 }, () => claims.create(f.writer, f.spaceId, 'alpha', request)));
  assert.equal(new Set(creates.map(view => view.claimId)).size, 1);
  assert.equal(creates.filter(view => !view.replayed).length, 1);
  const { claimId } = creates[0];
  const outcomes = await Promise.allSettled([2, 3, 4].map(n => claims.revise(f.writer, f.spaceId, 'alpha', claimId,
    { baseRevision: 1, ...statement(n) })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.deepEqual(outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason.code),
    ['REVISION_CONFLICT', 'REVISION_CONFLICT']);
  const reviews = await Promise.allSettled([
    claims.review(f.reviewer, f.spaceId, 'alpha', claimId, { baseRevision: 2, status: 'accepted' }),
    claims.revise(f.writer, f.spaceId, 'alpha', claimId, { baseRevision: 2, ...statement(8) })]);
  assert.equal(reviews.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(reviews.find(outcome => outcome.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.deepEqual(await claimRows(f.spaceId), { claims: 1, revisions: 3, evidence: 0, refs: 1 });
});

test('evidence access and request fields still decide every claim call after array intrinsics are replaced', async () => {
  const f = await fixture();
  const mixed = await f.agent([['alpha', ['claims:write', 'claims:read', 'sources:read']]]);
  const beta = { collectionId: 'beta', sourceId: f.betaSource };
  const derived = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'derived', ...statement(), evidence: [beta] });
  const nativeIterator = Array.prototype[Symbol.iterator];
  const nativeIncludes = Array.prototype.includes;
  // Drops fences, the cited collection and review-status names from any iteration, and admits them to any includes.
  const dropped = value => typeof value?.checkScope === 'function' || value === 'beta' || value === 'status' ||
    (typeof value === 'string' && value.startsWith('sources:'));
  Array.prototype[Symbol.iterator] = function () {
    const inner = nativeIterator.call(this);
    return { next() { for (;;) { const step = inner.next(); if (step.done || !dropped(step.value)) return step; } },
      [Symbol.iterator]() { return this; } };
  };
  Array.prototype.includes = function (value, ...rest) { return dropped(value) || nativeIncludes.call(this, value, ...rest); };
  try {
    await rejects(claims.get(mixed, f.spaceId, 'alpha', derived.claimId), 'NOT_FOUND');
    await rejects(claims.create(mixed, f.spaceId, 'alpha', { idempotencyKey: 'cite', ...statement(), evidence: [beta] }), 'FORBIDDEN');
    await rejects(claims.create(mixed, f.spaceId, 'alpha', { idempotencyKey: 'self', ...statement(), status: 'accepted' }),
      'INVALID_ARGUMENT');
    await rejects(claims.list(mixed, f.spaceId, 'alpha', { citing: beta }), 'FORBIDDEN');
    assert.deepEqual((await claims.list(mixed, f.spaceId, 'alpha')).claims, []);
  } finally {
    Array.prototype[Symbol.iterator] = nativeIterator;
    Array.prototype.includes = nativeIncludes;
  }
  assert.equal((await claims.get(f.both, f.spaceId, 'alpha', derived.claimId)).claimId, derived.claimId);
});

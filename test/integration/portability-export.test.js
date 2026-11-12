import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Ajv2020 from 'ajv/dist/2020.js';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { exportSections, verifyExportManifest } from '../../packages/contracts/dist/index.js';
import { PostgresAnalysisWorker, PostgresClaims, PostgresLinks, PostgresSources, PostgresSpaces,
  postgresServices } from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';

// STA-70: owner exports of a whole space in the open versioned format. Every
// expectation is what the test wrote before the export's boundary, never what
// the worker read; later writes must not appear. The suite owns its database.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_portability_export_${randomUUID().replaceAll('-', '')}`;
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
const newPool = (max = 1) => { const created = new pg.Pool({ connectionString: url, max }); extraPools.push(created); return created; };
test.after(async () => { await Promise.all([pool, ...extraPools].map(item => item.end())); await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); });

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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
  async list({ startAfter = '', limit = 1000 } = {}) {
    const after = [...this.objects.keys()].sort().filter(key => key > startAfter);
    return { objects: after.slice(0, limit).map(key => ({ key })), truncated: after.length > limit };
  }
}

const config = { database: memoryAdapter(), namespace: `portability-export-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32),
  analytics: { pool: newPool(1), originConnectionLimit: 5 } }]]), 3600);
const cell = { pool, originals: new R2BlobStore(new MemoryR2()) };
const sources = new PostgresSources(spaces, new Map([['cell-a', cell]]));
const claims = new PostgresClaims(spaces, new Map([['cell-a', { pool }]]));
const links = new PostgresLinks(spaces, new Map([['cell-a', { pool }]]));
const portability = services.portability;
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
const rejects = (promise, code, label = '') => assert.rejects(promise, error => { assert.equal(error.code, code, `${label} ${error.message}`); return true; });
const definition = slug => JSON.stringify({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { label: { type: 'string' }, body: { type: 'string' } }, additionalProperties: false },
  unique: [], filterable: [], sortable: [] });

const schema = JSON.parse(await readFile(new URL('../../contracts/portability-manifest.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, 'manifest');
const validators = Object.fromEntries([...exportSections].map(section => [section, ajv.getSchema(`manifest#/$defs/${section}`)]));
const validManifest = ajv.getSchema('manifest');

/** A jobs Worker on a one-connection pool of its own; `fault(sql)` may throw to cut a step at that statement. */
function worker(fault = () => {}) {
  const own = newPool(1);
  own.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (sql, ...rest) => { fault(typeof sql === 'string' ? sql : sql.text); return query(sql, ...rest); };
  });
  return new PostgresAnalysisWorker(own, { originConnectionLimit: 5 });
}
/** Run steps until no export is left to claim, as successive ticks would. */
async function drain(jobs = worker()) {
  for (let i = 0; i < 200; i++) if (!(await jobs.step({ budgetMs: 10_000 })).exports.claimed) return;
  throw new Error('exports did not finish');
}
async function owner() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const token = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  return Object.assign(await verify(token), { token });
}
async function space(actor) {
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(actor, 'cell-a', spaceId);
  for (const id of ['alpha', 'beta']) await services.collections.define(actor, spaceId, id, definition(id));
  return spaceId;
}
const mutate = async (actor, spaceId, collectionId, request) => (await services.records.mutate(actor, spaceId, collectionId,
  JSON.stringify({ idempotencyKey: randomUUID(), ...request })));
/** Every part of a completed export, its manifest text and digest, and each section's parsed lines. */
async function result(actor, spaceId, jobId) {
  const status = await portability.exportStatus(actor, spaceId, jobId);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  const parts = [];
  for (let n = 1; n <= status.manifest.partCount; n++) parts.push((await portability.exportPart(actor, spaceId, jobId, n)).part);
  const manifestPart = parts.pop();
  assert.equal(manifestPart.section, 'manifest');
  const streams = new Map();
  for (const part of parts) streams.set(part.section, (streams.get(part.section) ?? '') + part.content);
  const lines = Object.fromEntries([...exportSections].map(section => [section,
    (streams.get(section) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))]));
  return { status, parts, manifestText: manifestPart.content, manifest: JSON.parse(manifestPart.content), lines, streams };
}

test('an owner export carries the space as of its boundary, verifies against its digest and fails verification when tampered', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  const key = await spaces.issueAgentKey(actor, spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['records:write', 'records:read', 'claims:write', 'claims:read', 'sources:read'] }]);
  const agent = await verify(key.secret);
  // Before the boundary: records created, replaced and deleted, a source with an extraction, claims and links, some deleted.
  const r1 = (await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'one' } })).ref.id;
  await mutate(actor, spaceId, 'alpha', { operation: 'replace', id: r1, expectedRevision: 1, data: { label: 'one, revised' } });
  const r2 = (await mutate(agent, spaceId, 'alpha', { operation: 'create', data: { label: 'two' } })).ref.id;
  const r3 = (await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'three' } })).ref.id;
  await mutate(actor, spaceId, 'alpha', { operation: 'delete', id: r3, expectedRevision: 1 });
  const b1 = (await mutate(actor, spaceId, 'beta', { operation: 'create', data: { label: 'beta é' } })).ref.id;
  // External keys: one live, one held by a record deleted before the boundary (the key stays reserved).
  const e1 = (await mutate(actor, spaceId, 'beta', { operation: 'create', externalKey: ' Ext-é ', data: { label: 'keyed' } })).ref.id;
  const e2 = (await mutate(actor, spaceId, 'beta', { operation: 'create', externalKey: 'ext-gone', data: { label: 'keyed, gone' } })).ref.id;
  await mutate(actor, spaceId, 'beta', { operation: 'delete', id: e2, expectedRevision: 1 });
  const text = 'The alpha report says the bridge opened in 1932.';
  const source = (await sources.ingestText(actor, spaceId, 'alpha', { idempotencyKey: 'src-1', text })).sourceId;
  await sources.extract(actor, spaceId, 'alpha', source);
  const gone = (await sources.ingestText(actor, spaceId, 'alpha', { idempotencyKey: 'src-2', text: 'Removed before.' })).sourceId;
  await sources.delete(actor, spaceId, 'alpha', gone);
  const claim = await claims.create(agent, spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The bridge opened in 1932.',
    attributedTo: 'city archive', evidence: [{ collectionId: 'alpha', sourceId: source, extractionVersion: 1, start: 4, end: 16 },
      { collectionId: 'alpha', sourceId: source, extractionVersion: 1 }, { collectionId: 'alpha', sourceId: source }] });
  const dropped = await claims.create(actor, spaceId, 'alpha', { idempotencyKey: 'c2', statement: 'Withdrawn.', attributedTo: 'x' });
  await claims.delete(actor, spaceId, 'alpha', dropped.claimId, { baseRevision: dropped.revision });
  const ref = (collectionId, id) => ({ kind: 'record', collectionId, id });
  const kept = await links.create(actor, spaceId, 'alpha', { idempotencyKey: 'l1', type: 'cites', policy: 'detach', from: ref('alpha', r1), to: ref('beta', b1) });
  const removed = await links.create(actor, spaceId, 'alpha', { idempotencyKey: 'l2', type: 'cites', policy: 'detach', from: ref('alpha', r2), to: ref('beta', b1) });
  await links.delete(actor, spaceId, 'alpha', removed.linkId);

  const submitted = await portability.submitExport(actor, spaceId);
  assert.equal(submitted.state, 'queued');
  assert.deepEqual([submitted.boundary.records, submitted.boundary.evidence, submitted.boundary.formatVersion],
    ['as-of-watermark', 'as-of-snapshot', 1]);
  await rejects(portability.exportPart(actor, spaceId, submitted.jobId, 1), 'CONFLICT', 'no part before the manifest');

  // After the boundary, before any part is written: none of this may appear, and what it changed is read as it was.
  await mutate(actor, spaceId, 'alpha', { operation: 'replace', id: r2, expectedRevision: 1, data: { label: 'two, later' } });
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'later' } });
  await mutate(actor, spaceId, 'beta', { operation: 'delete', id: b1, expectedRevision: 1 });
  await claims.review(actor, spaceId, 'alpha', claim.claimId, { baseRevision: claim.revision, status: 'accepted' });
  await claims.create(actor, spaceId, 'alpha', { idempotencyKey: 'c3', statement: 'Later.', attributedTo: 'y' });
  await sources.delete(actor, spaceId, 'alpha', source);
  await sources.ingestText(actor, spaceId, 'alpha', { idempotencyKey: 'src-3', text: 'Later source.' });
  await drain();

  const { status, parts, manifestText, manifest, lines } = await result(actor, spaceId, submitted.jobId);
  // Records as of the watermark: r1 at its replacement, r2 before its later replacement, r3 deleted, b1 live (deleted later).
  assert.deepEqual(lines.records.map(({ collectionId, id, revision, data }) => [collectionId, id, revision, data]).sort(),
    [['alpha', r1, 2, { label: 'one, revised' }], ['alpha', r2, 1, { label: 'two' }], ['beta', b1, 1, { label: 'beta é' }],
      ['beta', e1, 1, { label: 'keyed' }]].sort());
  assert.deepEqual(lines.revisions.map(({ id, revision, operation }) => [id, revision, operation]).sort(),
    [[r1, 1, 'create'], [r1, 2, 'replace'], [r2, 1, 'create'], [r3, 1, 'create'], [r3, 2, 'delete'], [b1, 1, 'create'],
      [e1, 1, 'create'], [e2, 1, 'create'], [e2, 2, 'delete']].sort());
  // Each record's identity: the normalized external key, or its own ID when generated; a deleted record keeps its key.
  assert.deepEqual(lines.records.map(({ id, keyMode, key }) => [id, keyMode, key]).sort(),
    [[r1, 'generated', r1], [r2, 'generated', r2], [b1, 'generated', b1], [e1, 'external', 'Ext-é']].sort());
  assert.deepEqual([...new Set(lines.revisions.filter(line => line.id === e2 || line.id === r3)
    .map(({ id, keyMode, key }) => JSON.stringify([id, keyMode, key])))].sort(),
  [JSON.stringify([e2, 'external', 'ext-gone']), JSON.stringify([r3, 'generated', r3])].sort());
  assert.ok(lines.revisions.every(line => line.position <= status.boundary.watermark));
  assert.equal(lines.revisions.find(line => line.id === r2).credentialId, key.id, 'provenance keeps the writing credential');
  assert.deepEqual(lines.schemas.map(({ collectionId, version }) => [collectionId, version]), [['alpha', 1], ['beta', 1]]);
  // The source deleted later is live at the boundary with its original's digest; the one deleted before is only its event.
  assert.deepEqual(lines.sources.map(line => [line.sourceId, line.original.sha256, line.original.byteSize]),
    [[source, sha(text), Buffer.byteLength(text)]]);
  assert.deepEqual(lines.extractions.map(line => [line.sourceId, line.version, line.content]), [[source, 1, text]]);
  // The claim at its revision before the later review; the claim deleted before is only its event.
  assert.deepEqual(lines.claims.map(line => [line.claimId, line.revision, line.statement, line.reviewStatus]),
    [[claim.claimId, claim.revision, 'The bridge opened in 1932.', 'unreviewed']]);
  // Provenance exactly as cited: a span, a whole extraction version (no offsets) and a whole source (no version either).
  assert.deepEqual(lines.provenance.map(line => [line.claimId, line.ordinal, line.source.sourceId, line.source.extractionVersion,
    line.source.startOffset, line.source.endOffset]),
  [[claim.claimId, 0, source, 1, 4, 16], [claim.claimId, 1, source, 1, null, null], [claim.claimId, 2, source, null, null, null]]);
  // The schema refuses what the old export invented for a whole-source citation, and offsets without a version.
  const cited = lines.provenance[2];
  for (const invented of [{ extractionVersion: 0, startOffset: 0, endOffset: 0 }, { extractionVersion: null, startOffset: 0, endOffset: 1 },
    { extractionVersion: 1, startOffset: 0, endOffset: null }])
    assert.equal(validators.provenance({ ...cited, source: { ...cited.source, ...invented } }), false, JSON.stringify(invented));
  // The link detached later (b1's deletion) is live at the boundary at its revision there.
  assert.deepEqual(lines.links.map(line => [line.linkId, line.revision, line.to.id]), [[kept.linkId, 1, b1]]);
  const events = lines.events.map(line => [line.kind, line.entityId, line.operation]);
  for (const expected of [['source', gone, 'delete'], ['claim', dropped.claimId, 'delete'], ['link', removed.linkId, 'delete']])
    assert.ok(events.some(event => JSON.stringify(event) === JSON.stringify(expected)), JSON.stringify(expected));
  assert.ok(!events.some(([kind, id, operation]) => (kind === 'source' && id === source) || (kind === 'link' && id === kept.linkId && operation !== 'create')),
    'no event after the boundary');
  assert.deepEqual(lines.permissions.map(line => [line.credentialId, line.grants.map(g => g.collectionId)]), [[key.id, ['alpha']]]);

  // Every line and the manifest match the open schema; the manifest names every part's digest.
  for (const section of exportSections) for (const line of lines[section])
    assert.ok(validators[section](line), `${section}: ${JSON.stringify(validators[section].errors)}`);
  assert.ok(validManifest(manifest), JSON.stringify(validManifest.errors));
  assert.deepEqual([manifest.space.spaceId, manifest.space.ownerPrincipalId, manifest.boundary.watermark],
    [spaceId, actor.userPrincipalId, status.boundary.watermark]);
  // The boundary instant is published exactly as stored, to the microsecond, in the manifest and the status alike.
  const stored = (await pool.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM portability_jobs WHERE job_id=$1`, [submitted.jobId])).rows[0].at;
  assert.deepEqual([manifest.boundary.snapshotAt, status.boundary.snapshotAt, submitted.boundary.snapshotAt], [stored, stored, stored]);
  assert.match(stored, /\.\d{6}Z$/);
  assert.equal(sha(manifestText), status.manifest.sha256);
  const contents = parts.map(part => part.content);
  assert.deepEqual(await verifyExportManifest(manifestText, status.manifest.sha256, contents), { ok: true, manifest });

  // Tampering with any byte the digest covers fails verification.
  const tampered = manifestText.replace('"rows":', '"rows":1');
  assert.equal((await verifyExportManifest(tampered, status.manifest.sha256, contents)).ok, false);
  assert.match((await verifyExportManifest(tampered, status.manifest.sha256)).reason, /does not match its digest/);
  const edited = [...contents];
  edited[0] = edited[0].replace('alpha', 'alphb');
  assert.match((await verifyExportManifest(manifestText, status.manifest.sha256, edited)).reason, /part 1 does not match/);
  assert.match((await verifyExportManifest(manifestText, status.manifest.sha256, contents.slice(1))).reason, /lists/);
  // A manifest re-sealed without a part's entry is refused for its structure, not trusted for its digest.
  const resealed = JSON.stringify({ ...manifest, parts: manifest.parts.slice(1) });
  assert.equal((await verifyExportManifest(resealed, sha(resealed))).ok, false);
  assert.equal((await verifyExportManifest(manifestText, '0'.repeat(64))).ok, false);
});

test('a real export excludes credential secrets, session tokens and storage keys', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  const keys = [];
  for (const capabilities of [['records:write', 'records:read'], ['claims:read']])
    keys.push(await spaces.issueAgentKey(actor, spaceId, new Date(Date.now() + 3_600_000), [{ collectionId: 'alpha', capabilities }]));
  const agent = await verify(keys[0].secret);
  await mutate(agent, spaceId, 'alpha', { operation: 'create', data: { label: 'written by a key' } });
  const source = (await sources.ingestText(actor, spaceId, 'alpha', { idempotencyKey: 's', text: 'Original bytes.' })).sourceId;
  await spaces.revokeAgentKey(actor, spaceId, keys[1].id);
  const { jobId } = await portability.submitExport(actor, spaceId);
  await drain();
  const { parts, manifestText, lines } = await result(actor, spaceId, jobId);
  const exported = [...parts.map(part => part.content), manifestText].join('\n');
  // The control: identifiers of the same credentials are exported, so the scan sees credential data.
  for (const key of keys) assert.ok(exported.includes(key.id), `credential ${key.id} is identified`);
  assert.equal(lines.permissions.find(line => line.credentialId === keys[1].id).revokedAt !== null, true);
  const storageKeys = (await pool.query('SELECT object_key FROM original_objects WHERE space_id=$1 AND object_key IS NOT NULL',
    [spaceId])).rows.map(row => row.object_key);
  assert.equal(storageKeys.length, 1, 'the source has a stored original');
  const secrets = [...keys.map(key => key.secret), actor.token, ...storageKeys];
  for (const secret of secrets) {
    assert.ok(secret.length >= 16);
    assert.equal(exported.includes(secret), false, 'a secret is in the export');
    // No fragment of a secret either: every 16-character window of each is absent.
    for (let i = 0; i + 16 <= secret.length; i++) assert.equal(exported.includes(secret.slice(i, i + 16)), false, `a fragment at ${i}`);
  }
  // No member anywhere is named for secret material, and every line is a closed object of the schema.
  const named = [];
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [member, inner] of Object.entries(value)) { named.push(member); walk(inner); }
  };
  for (const section of exportSections) for (const line of lines[section]) {
    walk(section === 'records' || section === 'revisions' ? { ...line, data: null } : line);
    assert.ok(validators[section](line), `${section}: ${JSON.stringify(validators[section].errors)}`);
  }
  walk(JSON.parse(manifestText));
  assert.deepEqual(named.filter(member => /secret|token|password|hash|object_?key|storage/i.test(member)), []);
  assert.deepEqual(lines.sources.map(line => line.sourceId), [source]);
  assert.ok(JSON.parse(manifestText).excluded.includes('credential-secrets'));
});

test('an export interrupted at any part resumes from its checkpoint and writes the same parts, lines continuing across parts', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  // Records near a part each, of two-byte characters, so part cuts land inside lines and between a character's bytes.
  for (let i = 0; i < 4; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'é'.repeat(300_000)}${i}` } });
  for (let i = 0; i < 30; i++) await mutate(actor, spaceId, 'beta', { operation: 'create', data: { label: `small ${i}` } });
  const straight = await portability.submitExport(actor, spaceId);
  await drain();
  const reference = await result(actor, spaceId, straight.jobId);
  assert.ok(reference.parts.filter(part => part.section === 'records').length >= 3, 'records span several parts');
  assert.ok(reference.parts.some(part => !part.content.endsWith('\n')), 'a line continues into the next part');
  assert.ok(reference.parts.every(part => Buffer.byteLength(part.content) <= 1_048_576));
  assert.equal(reference.lines.records.length, 34);
  assert.equal(reference.lines.records.filter(line => line.data.body?.length === 300_001).length, 4);

  // Interrupted once at a checkpoint and at two part writes: each time the lease lapses and a later worker continues
  // from the last committed part.
  const resumed = await portability.submitExport(actor, spaceId);
  // Cut first at a checkpoint, after its part was written in the same transaction.
  const checkpointCut = worker(sql => { if (/SET checkpoint=/.test(sql)) throw new Error('cut at checkpoint'); });
  await assert.rejects(checkpointCut.step({ budgetMs: 10_000 }), /cut at checkpoint/);
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [resumed.jobId]);
  let writes = 0;
  const cuts = new Set([2, 4]);
  const failing = worker(sql => {
    if (/^\s*INSERT INTO portability_parts/.test(sql) && cuts.has(++writes)) throw new Error('isolate lost');
  });
  let cut = 0;
  for (let round = 0; round < 3; round++) {
    await failing.step({ budgetMs: 10_000 }).catch(error => { assert.match(error.message, /isolate lost/); cut++; });
    await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [resumed.jobId]);
  }
  assert.equal(cut, 2, 'both part writes were cut');
  await drain();
  const again = await result(actor, spaceId, resumed.jobId);
  assert.ok(again.status.progress.attempts > 1, 'the export was claimed again');
  assert.deepEqual(again.manifest.parts, reference.manifest.parts, 'the same parts, digests and cuts');
  assert.deepEqual(again.manifest.sections, reference.manifest.sections);
  assert.deepEqual(await verifyExportManifest(again.manifestText, again.status.manifest.sha256, again.parts.map(part => part.content)),
    { ok: true, manifest: again.manifest });
});

test('only the owner exports, every read authorizes again, and cancellation and lifecycle end an export', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const key = await spaces.issueAgentKey(actor, spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'alpha', capabilities: ['export:read', 'records:read'] }]);
  const agent = await verify(key.secret);
  await rejects(portability.submitExport(agent, spaceId), 'FORBIDDEN', 'an agent key, even with export:read');
  const stranger = await owner();
  await rejects(portability.submitExport(stranger, spaceId), 'NOT_FOUND', 'another owner');

  const cancelled = await portability.submitExport(actor, spaceId);
  await rejects(portability.exportStatus(stranger, spaceId, cancelled.jobId), 'NOT_FOUND');
  await rejects(portability.exportStatus(agent, spaceId, cancelled.jobId), 'FORBIDDEN');
  await rejects(portability.exportStatus(actor, spaceId, 'exp_not-a-job'), 'NOT_FOUND');
  const third = await portability.submitExport(actor, spaceId);
  await rejects(portability.submitExport(actor, spaceId), 'BACKPRESSURE', 'two unfinished exports per space');
  assert.equal((await portability.cancelExport(actor, spaceId, cancelled.jobId)).state, 'cancelled');
  await rejects(portability.exportPart(actor, spaceId, cancelled.jobId, 1), 'CONFLICT');
  await drain();
  const done = await portability.exportStatus(actor, spaceId, third.jobId);
  assert.equal(done.state, 'completed');
  assert.equal((await portability.cancelExport(actor, spaceId, third.jobId)).state, 'completed', 'a completed export is reported as it is');
  await rejects(portability.exportPart(actor, spaceId, third.jobId, done.manifest.partCount + 1), 'NOT_FOUND');
  await rejects(portability.exportPart(actor, spaceId, third.jobId, 0), 'INVALID_ARGUMENT');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM portability_parts WHERE job_id=$1', [cancelled.jobId])).rows[0].n, 0);
  // Cancelling a running export removes the parts it has already written, and no later step writes more.
  const running = await portability.submitExport(actor, spaceId);
  let partWrites = 0;
  await assert.rejects(worker(sql => { if (/^\s*INSERT INTO portability_parts/.test(sql) && ++partWrites === 2) throw new Error('cut'); })
    .step({ budgetMs: 10_000 }), /cut/);
  const partsOf = async jobId => (await pool.query('SELECT count(*)::int AS n FROM portability_parts WHERE job_id=$1', [jobId])).rows[0].n;
  assert.deepEqual([(await portability.exportStatus(actor, spaceId, running.jobId)).state, await partsOf(running.jobId)], ['running', 1]);
  assert.equal((await portability.cancelExport(actor, spaceId, running.jobId)).state, 'cancelled');
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [running.jobId]);
  await drain();
  assert.deepEqual([(await portability.exportStatus(actor, spaceId, running.jobId)).state, await partsOf(running.jobId)], ['cancelled', 0]);

  // A read-only space exports; a suspended one fails its queued export and serves nothing.
  await services.spaces.update(actor, spaceId, 'readOnly');
  const archived = await portability.submitExport(actor, spaceId);
  await drain();
  assert.equal((await portability.exportStatus(actor, spaceId, archived.jobId)).state, 'completed');
  await services.spaces.update(actor, spaceId, 'active');
  // Grants have no history: a key issued (or revoked) before the export reads permissions fails it, never a guess.
  const reissued = await portability.submitExport(actor, spaceId);
  await spaces.issueAgentKey(actor, spaceId, new Date(Date.now() + 3_600_000), [{ collectionId: 'beta', capabilities: ['records:read'] }]);
  await drain();
  const changed = await portability.exportStatus(actor, spaceId, reissued.jobId);
  assert.deepEqual([changed.state, changed.failureCode], ['failed', 'POLICY_CHANGED']);
  // Once permissions are read, a later policy change does not stop the export.
  const after = await portability.submitExport(actor, spaceId);
  let written = 0;
  // Permissions are read once the part after them, the schemas', commits (its transaction finds none left); the step is
  // cut at the part after that.
  await assert.rejects(worker(sql => { if (/^\s*INSERT INTO portability_parts/.test(sql) && ++written === 3) throw new Error('cut'); })
    .step({ budgetMs: 10_000 }), /cut/);
  const first = (await pool.query('SELECT section FROM portability_parts WHERE job_id=$1 ORDER BY part_number', [after.jobId])).rows;
  assert.deepEqual(first.map(row => row.section), ['permissions', 'schemas']);
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [after.jobId]);
  await spaces.revokeAgentKey(actor, spaceId, key.id);
  await drain();
  assert.equal((await portability.exportStatus(actor, spaceId, after.jobId)).state, 'completed');
  const stopped = await portability.submitExport(actor, spaceId);
  await services.spaces.update(actor, spaceId, 'suspended');
  await rejects(portability.exportPart(actor, spaceId, archived.jobId, 1), 'SPACE_UNAVAILABLE');
  await drain();
  const job = (await pool.query('SELECT state,failure_code FROM portability_jobs WHERE job_id=$1', [stopped.jobId])).rows[0];
  assert.deepEqual(job, { state: 'failed', failure_code: 'SPACE_UNAVAILABLE' });
});

test('submission waits for writes to the space in flight, so each lands wholly on one side of the boundary', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'before' } });
  // A writer in flight holds the space's share lock, as every writer does, and has stamped a row before the export starts.
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR SHARE', [spaceId]);
    await writer.query(`INSERT INTO collection_versions(space_id,collection_id,version,canonical_definition)
      SELECT space_id,collection_id,2,canonical_definition FROM collection_versions WHERE space_id=$1 AND collection_id='beta'`, [spaceId]);
    let settled = false;
    const submitted = portability.submitExport(actor, spaceId).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(settled, false, 'submission waits for the writer');
    await writer.query('COMMIT');
    const { jobId } = await submitted;
    await drain();
    const { lines } = await result(actor, spaceId, jobId);
    // Stamped before the snapshot instant and committed before it was taken: inside the boundary.
    assert.deepEqual(lines.schemas.map(({ collectionId, version }) => [collectionId, version]), [['alpha', 1], ['beta', 1], ['beta', 2]]);
  } finally { writer.release(); }
});

test('exports and analysis jobs share the jobs Worker step: neither starves at the minimum budget, and an export failure never stops analysis', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  // Four records of about 700 KB: an analysis export job of four pages and a manifest, a space export of several parts.
  for (let i = 0; i < 4; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  const analysisJob = await services.analysis.submit(actor, spaceId, 'alpha', 'export');
  const exportJob = await portability.submitExport(actor, spaceId);
  // Every page and part write takes 700 ms, so at the 2 s minimum budget one turn writes one of them and leaves no room
  // for the other kind: the step must choose, and the choice must alternate.
  const spin = ms => { const until = Date.now() + ms; while (Date.now() < until); };
  const slow = worker(sql => { if (/^\s*INSERT INTO (portability_parts|analysis_result_pages|analysis_result_manifests)/.test(sql)) spin(700); });
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const step = await slow.step({ budgetMs: 2_000 });
    turns.push([step.pages + step.completed > 0 ? 'analysis' : '', step.exports.parts + step.exports.completed > 0 ? 'export' : ''].join(''));
  }
  // The analysis job was submitted first, so it waited longer and goes first; each turn then moves its kind's wait to now.
  assert.deepEqual(turns, ['analysis', 'export', 'analysis', 'export']);
  const analysisState = async () => (await services.analysis.status(actor, spaceId, 'alpha', analysisJob.jobId)).state;
  assert.equal(await analysisState(), 'running', 'the analysis job has work left');

  // A failed export probe (a role without its portability grant) is reported, but the analysis job still runs to completion.
  const denied = worker(sql => {
    if (/portability_jobs/.test(sql)) throw Object.assign(new Error('permission denied for table portability_jobs'), { code: '42501' });
  });
  await assert.rejects(denied.step({ budgetMs: 10_000 }), /permission denied for table portability_jobs/);
  assert.equal(await analysisState(), 'completed');
  // A failing export step is reported too, and a queued analysis job submitted after the export still runs in the same step.
  const later = await services.analysis.submit(actor, spaceId, 'alpha', 'export');
  await assert.rejects(worker(sql => { if (/^\s*INSERT INTO portability_parts/.test(sql)) throw new Error('export part failed'); })
    .step({ budgetMs: 10_000 }), /export part failed/);
  assert.equal((await services.analysis.status(actor, spaceId, 'alpha', later.jobId)).state, 'completed');
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [exportJob.jobId]);
  await drain();
  const { status, parts, manifestText } = await result(actor, spaceId, exportJob.jobId);
  assert.equal((await verifyExportManifest(manifestText, status.manifest.sha256, parts.map(part => part.content))).ok, true);
});

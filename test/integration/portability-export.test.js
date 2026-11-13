import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { exportSections, verifyExportManifest } from '../../packages/contracts/dist/index.js';
import { classifyError } from '../../packages/application/dist/index.js';
import { AuthorityError, PortabilityExportWorker, PostgresAnalysisWorker, PostgresClaims, PostgresLinks, PostgresPortabilityExports,
  PostgresSources, PostgresSpaces, portabilityExportBounds, postgresServices } from '../../packages/postgres/dist/index.js';
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
/** An R2 binding in memory, objects by key with the SHA-256 their writer stated: what sources read and write. */
class MemoryR2 {
  objects = new Map();
  async put(key, body, { sha256 } = {}) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    if (sha256 !== undefined && sha256 !== sha(bytes)) throw new Error('put: checksum mismatch');
    this.objects.set(key, { bytes, sha256 });
    return this.head(key);
  }
  async head(key) {
    const { bytes, sha256 } = this.objects.get(key) ?? {};
    if (!bytes) return null;
    return { size: bytes.length, checksums: sha256 ? { sha256: new Uint8Array(Buffer.from(sha256, 'hex')).buffer } : {} };
  }
  async get(key) { const head = await this.head(key); return head && { ...head, body: new Blob([this.objects.get(key).bytes]).stream() }; }
  async delete(key) { this.objects.delete(key); }
  async list() { return { objects: [...this.objects.keys()].sort().map(key => ({ key })), truncated: false }; }
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
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
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
/** Page and part writes that take 700 ms each: at the 2 s minimum budget one turn writes one, and no other kind fits. */
const spin = ms => { const until = Date.now() + ms; while (Date.now() < until); };
const slow = () => worker(sql => { if (/^\s*INSERT INTO (portability_parts|analysis_result_pages|analysis_result_manifests)/.test(sql)) spin(700); });
const partsOf = async jobId => (await pool.query('SELECT count(*)::int AS n FROM portability_parts WHERE job_id=$1', [jobId])).rows[0].n;
/** Run `sql` with triggers off, as only a test moves the stamps migrations 049 and 051 keep. */
async function bypassing(sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(sql, params);
    await client.query('COMMIT');
  } finally { client.release(); }
}
/** A cell pool whose `n`-th COMMIT reaches the database and then runs `after`, which may throw in place of its acknowledgement. */
function committing(n, after) {
  let commits = 0;
  return { connect: async () => {
    const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = async (sql, ...rest) => { const done = await query(sql, ...rest); if (sql === 'COMMIT' && ++commits === n) await after(); return done; };
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
}
/** End every export due to end and remove every ended export's parts, as a step's expiry passes would given the time. */
async function sweep() {
  const step = { expired: 0, claimed: 0, parts: 0, completed: 0, failed: 0, unadmitted: 0, removed: 0 };
  assert.equal(await new PortabilityExportWorker(newPool(1)).expire(Date.now() + 30_000, step), true, 'the sweep finished');
  return step;
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
  // Claim instants are given to the millisecond; the export states every instant to the microsecond.
  const claim = await claims.create(agent, spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The bridge opened in 1932.',
    attributedTo: 'city archive', observedAt: '2026-01-02T03:04:05.123Z', validFrom: '1932-05-01T00:00:00Z',
    validUntil: '2099-12-31T23:59:59.999Z', evidence: [{ collectionId: 'alpha', sourceId: source, extractionVersion: 1, start: 4, end: 16 },
      { collectionId: 'alpha', sourceId: source, extractionVersion: 1 }, { collectionId: 'alpha', sourceId: source }] });
  const dropped = await claims.create(actor, spaceId, 'alpha', { idempotencyKey: 'c2', statement: 'Withdrawn.', attributedTo: 'x' });
  await claims.delete(actor, spaceId, 'alpha', dropped.claimId, { baseRevision: dropped.revision });
  const ref = (collectionId, id) => ({ kind: 'record', collectionId, id });
  const kept = await links.create(actor, spaceId, 'alpha', { idempotencyKey: 'l1', type: 'cites', policy: 'detach', from: ref('alpha', r1), to: ref('beta', b1) });
  const removed = await links.create(actor, spaceId, 'alpha', { idempotencyKey: 'l2', type: 'cites', policy: 'detach', from: ref('alpha', r2), to: ref('beta', b1) });
  await links.delete(actor, spaceId, 'alpha', removed.linkId);
  // A stamp with non-zero sub-millisecond digits, set exactly (and earlier than it was, so still before the boundary);
  // migration-time guards keep created_at, so they are bypassed here.
  const stamp = await pool.connect();
  try {
    await stamp.query('BEGIN');
    await stamp.query("SET LOCAL session_replication_role = 'replica'");
    await stamp.query(`UPDATE links SET created_at=date_trunc('second',created_at)-interval '1 second'+interval '0.123456 second'
      WHERE space_id=$1 AND link_id=$2`, [spaceId, kept.linkId]);
    await stamp.query('COMMIT');
  } finally { stamp.release(); }

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
  assert.equal(status.createdAt, stored);
  const [expires] = (await pool.query(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM portability_jobs WHERE job_id=$1`, [submitted.jobId])).rows;
  assert.equal(status.expiresAt, expires.at);
  // Every instant in every section is exported exactly as stored, to the microsecond, never through a millisecond Date.
  assert.deepEqual([lines.claims[0].observedAt, lines.claims[0].validFrom, lines.claims[0].validUntil],
    ['2026-01-02T03:04:05.123000Z', '1932-05-01T00:00:00.000000Z', '2099-12-31T23:59:59.999000Z']);
  assert.match(lines.links[0].createdAt, /:\d{2}\.123456Z$/, 'sub-millisecond digits survive');
  const us = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const storedInstants = {
    permissions: line => [`SELECT ${us('created_at')} AS "createdAt",${us('expires_at')} AS "expiresAt",
      ${us('activated_at')} AS "activatedAt",${us('confirmed_at')} AS "confirmedAt",${us('revoked_at')} AS "revokedAt"
      FROM space_credentials WHERE space_id=$1 AND credential_id=$2`, [line.credentialId]],
    schemas: line => [`SELECT ${us('accepted_at')} AS "acceptedAt" FROM collection_versions WHERE space_id=$1 AND collection_id=$2
      AND version=$3`, [line.collectionId, line.version]],
    retrieval: line => [`SELECT ${us('created_at')} AS "createdAt" FROM retrieval_policies WHERE space_id=$1 AND collection_id=$2
      AND version=$3`, [line.collectionId, line.version]],
    sources: line => [`SELECT ${us('s.created_at')} AS "createdAt",${us('o.captured_at')} AS "original.capturedAt",
      ${us('o.observed_at')} AS "original.observedAt" FROM sources s LEFT JOIN original_objects o ON o.space_id=s.space_id
      AND o.collection_id=s.collection_id AND o.source_id=s.source_id WHERE s.space_id=$1 AND s.collection_id=$2 AND s.source_id=$3`,
    [line.collectionId, line.sourceId]],
    extractions: line => [`SELECT ${us('created_at')} AS "createdAt" FROM extraction_versions WHERE space_id=$1 AND collection_id=$2
      AND source_id=$3 AND version=$4`, [line.collectionId, line.sourceId, line.version]],
    claims: line => [`SELECT ${us('c.created_at')} AS "createdAt",${us('r.observed_at')} AS "observedAt",
      ${us('r.valid_from')} AS "validFrom",${us('r.valid_until')} AS "validUntil",${us('r.reviewed_at')} AS "reviewedAt",
      ${us('r.committed_at')} AS "committedAt" FROM claim_revisions r JOIN claims c ON c.space_id=r.space_id
      AND c.collection_id=r.collection_id AND c.claim_id=r.claim_id WHERE r.space_id=$1 AND r.collection_id=$2 AND r.claim_id=$3
      AND r.revision=$4`, [line.collectionId, line.claimId, line.revision]],
    links: line => [`SELECT ${us('created_at')} AS "createdAt" FROM links WHERE space_id=$1 AND collection_id=$2 AND link_id=$3`,
      [line.collectionId, line.linkId]],
    events: line => [`SELECT ${us('committed_at')} AS "committedAt" FROM evidence_events WHERE space_id=$1 AND event_id=$2`,
      [line.eventId]],
    revisions: line => [`SELECT ${us('committed_at')} AS "committedAt" FROM record_events WHERE space_id=$1 AND event_id=$2`,
      [line.eventId]]
  };
  const pick = (line, path) => path.split('.').reduce((value, member) => value?.[member], line);
  const compared = {};
  for (const [section, query] of Object.entries(storedInstants)) for (const line of lines[section]) {
    const [sql, params] = query(line);
    const [row] = (await pool.query(sql, [spaceId, ...params])).rows;
    assert.ok(row, `${section}: no stored row for ${JSON.stringify(line)}`);
    for (const [path, value] of Object.entries(row)) {
      // An instant after the snapshot (a later activation, say) is exported as null; every other one exactly as stored.
      if (pick(line, path) === null) continue;
      assert.equal(pick(line, path), value, `${section} ${path}`);
      compared[section] = (compared[section] ?? 0) + 1;
    }
    for (const grant of line.grants ?? []) {
      const [stored] = (await pool.query(`SELECT ${us('expires_at')} AS at FROM collection_grants WHERE space_id=$1
        AND credential_id=$2 AND collection_id=$3`, [spaceId, line.credentialId, grant.collectionId])).rows;
      assert.equal(grant.expiresAt, stored.at, 'grant expiresAt');
    }
  }
  for (const section of ['permissions', 'schemas', 'sources', 'extractions', 'claims', 'links', 'events', 'revisions'])
    assert.ok(compared[section] > 0, `${section} carries instants`);
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

test('an export is never run unless its submission\'s final check admits it: a refused or interrupted submission leaves nothing runnable', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const jobOf = async () => (await pool.query(`SELECT job_id,state FROM portability_jobs WHERE space_id=$1 ORDER BY created_at DESC
    LIMIT 1`, [spaceId])).rows[0];

  // The provider's final check pauses, then refuses the owner. A worker step meanwhile finds nothing to run.
  let reach, release;
  const reached = new Promise(resolve => { reach = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const refusing = { scope: (...args) => spaces.scope(...args), assertCurrentUntil: async () => {
    reach(); await gate; throw new AuthorityError('FORBIDDEN', 'The session was revoked');
  } };
  const exports = new PostgresPortabilityExports(refusing, new Map([['cell-a', { pool }]]));
  const refused = exports.submit(actor, spaceId);
  await reached;
  const paused = await jobOf();
  assert.equal(paused.state, 'queued');
  const meanwhile = await worker().step({ budgetMs: 2_000 });
  assert.deepEqual([meanwhile.exports.claimed, meanwhile.exports.parts, await partsOf(paused.job_id)], [0, 0, 0],
    'no worker runs an export its final check has not admitted');
  release();
  await rejects(refused, 'FORBIDDEN');
  assert.deepEqual(await jobOf(), { job_id: paused.job_id, state: 'cancelled' });
  await drain();
  assert.deepEqual([(await jobOf()).state, await partsOf(paused.job_id)], ['cancelled', 0]);

  // The submitter stops right after pinning the boundary: neither its check nor its cleanup reaches the database.
  let gone = false;
  const dying = { connect: async () => {
    if (gone) throw new Error('the submitter stopped');
    const client = await pool.connect(), query = client.query.bind(client);
    client.query = async (sql, ...rest) => { const done = await query(sql, ...rest); if (sql === 'COMMIT') gone = true; return done; };
    const release = client.release.bind(client);
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  await assert.rejects(new PostgresPortabilityExports(spaces, new Map([['cell-a', { pool: dying }]])).submit(actor, spaceId),
    error => error instanceof AggregateError && error.errors.every(item => /the submitter stopped/.test(item.message)));
  const orphan = await jobOf();
  assert.equal(orphan.state, 'queued');
  assert.equal((await worker().step({ budgetMs: 2_000 })).exports.claimed, 0, 'an unadmitted export is never claimed');
  assert.equal((await portability.exportStatus(actor, spaceId, orphan.job_id)).state, 'queued');
  // Once its admission time has passed (backdated here; migration 051 keeps created_at, so its trigger is bypassed),
  // a worker cancels it unrun, and it no longer holds one of the space's two export slots.
  await bypassing(`UPDATE portability_jobs SET created_at=created_at-$2::int*interval '1 millisecond' WHERE job_id=$1`,
    [orphan.job_id, portabilityExportBounds.admissionMs + 1_000]);
  const swept = await worker().step({ budgetMs: 2_000 });
  assert.deepEqual([swept.exports.unadmitted, swept.exports.claimed], [1, 0]);
  assert.deepEqual([(await jobOf()).state, await partsOf(orphan.job_id)], ['cancelled', 0]);
  // An admitted export reads as queued until a worker claims it, then runs to completion.
  const admitted = await portability.submitExport(actor, spaceId);
  const waiting = await portability.exportStatus(actor, spaceId, admitted.jobId);
  assert.deepEqual([waiting.state, waiting.startedAt], ['queued', null]);
  await drain();
  assert.equal((await portability.exportStatus(actor, spaceId, admitted.jobId)).state, 'completed');
});

test('an export becomes claimable only once its submission\'s authorization is released, and a lost admission names it', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const jobs = async () => (await pool.query(`SELECT job_id,state,(SELECT count(*)::int FROM portability_parts p WHERE p.job_id=j.job_id)
    AS parts FROM portability_jobs j WHERE space_id=$1 ORDER BY created_at`, [spaceId])).rows;
  // The provider confirms the owner for 300 ms. The check's COMMIT (the submission's second) is acknowledged only after
  // that has passed, so the call is refused; worker steps meanwhile find nothing they may run.
  const brief = { scope: (...args) => spaces.scope(...args), assertCurrentUntil: async () => Date.now() + 300 };
  let meanwhile;
  const late = committing(2, async () => {
    meanwhile = [await worker().step({ budgetMs: 2_000 }), await worker().step({ budgetMs: 2_000 })];
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  await rejects(new PostgresPortabilityExports(brief, new Map([['cell-a', { pool: late }]])).submit(actor, spaceId), 'FORBIDDEN');
  assert.deepEqual(meanwhile.map(step => step.exports.claimed + step.exports.parts), [0, 0], 'no worker runs an unreleased export');
  const [refused] = await jobs();
  assert.deepEqual([refused.state, refused.parts], ['cancelled', 0]);
  await drain();
  assert.deepEqual((await jobs()).map(job => job.state), ['cancelled'], 'nothing completes for a refused submission');

  // The check is acknowledged at once, but the admission's connection arrives only after the 300 ms: the admission is
  // bounded by that access, so it never commits, and the export is cancelled unrun.
  let connects = 0;
  const slowAdmission = { connect: async () => {
    if (++connects === 3) await new Promise(resolve => setTimeout(resolve, 1_000));
    return pool.connect();
  } };
  await rejects(new PostgresPortabilityExports(brief, new Map([['cell-a', { pool: slowAdmission }]])).submit(actor, spaceId), 'FORBIDDEN');
  // An admission that fails before its COMMIT surely rolled back: its own error, and the export cancelled.
  const failing = { connect: async () => {
    const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = (sql, ...rest) => /^UPDATE portability_jobs j SET state='running'/.test(sql)
      ? Promise.reject(Object.assign(new Error('the admission statement failed'), { code: '40001' })) : query(sql, ...rest);
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  await assert.rejects(new PostgresPortabilityExports(spaces, new Map([['cell-a', { pool: failing }]])).submit(actor, spaceId),
    /the admission statement failed/);
  assert.deepEqual((await jobs()).map(job => [job.state, job.parts]), [['cancelled', 0], ['cancelled', 0], ['cancelled', 0]]);

  // Released, then the admission's COMMIT (the third) reaches the database and its acknowledgement is lost: the outcome
  // is unknown, never retryable, and the error names the export, which the owner reads and cancels by that ID.
  const lossy = committing(3, () => { throw new Error('the connection dropped after COMMIT'); });
  let lost;
  await assert.rejects(new PostgresPortabilityExports(spaces, new Map([['cell-a', { pool: lossy }]])).submit(actor, spaceId), error => {
    lost = error;
    return /the connection dropped/.test(error.cause?.message);
  });
  assert.deepEqual(classifyError(lost, false), { code: 'COMMIT_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(lost.jobId, (await jobs())[3].job_id);
  assert.equal((await portability.exportStatus(actor, spaceId, lost.jobId)).state, 'queued', 'admitted, not yet claimed');
  assert.equal((await portability.cancelExport(actor, spaceId, lost.jobId)).state, 'cancelled');
  await drain();
  assert.deepEqual((await jobs()).map(job => [job.state, job.parts]), Array.from({ length: 4 }, () => ['cancelled', 0]));

  // The admission's COMMIT is acknowledged, but the process stalls past the 300 ms access before it can read that: the
  // export, which no worker has claimed, is withdrawn and the call refused, never released after its access expired.
  await rejects(new PostgresPortabilityExports(brief, new Map([['cell-a', { pool: committing(3, () => spin(500)) }]]))
    .submit(actor, spaceId), 'FORBIDDEN');
  const withdrawn = (await jobs())[4];
  assert.deepEqual([withdrawn.state, withdrawn.parts], ['cancelled', 0]);
  // Stalled likewise while a worker claims it: it may run, so the outcome is unknown and the error names it.
  const claimedMeanwhile = committing(3, async () => { await worker().step({ budgetMs: 2_000 }); spin(300); });
  let unconfirmed;
  await assert.rejects(new PostgresPortabilityExports(brief, new Map([['cell-a', { pool: claimedMeanwhile }]])).submit(actor, spaceId),
    error => { unconfirmed = error; return typeof error.jobId === 'string'; });
  assert.deepEqual(classifyError(unconfirmed, false), { code: 'COMMIT_OUTCOME_UNKNOWN', retryable: false });
  assert.equal(unconfirmed.jobId, (await jobs())[5].job_id);
  assert.ok(['running', 'completed'].includes((await jobs())[5].state), 'the claimed export runs');
  // The final check changes nothing: its COMMIT unacknowledged is a check that never answered, a definite retryable
  // refusal, and the export is cancelled unrun.
  let unanswered;
  await assert.rejects(new PostgresPortabilityExports(spaces, new Map([['cell-a', { pool: committing(2, () => {
    throw new Error('the connection dropped after the check'); }) }]])).submit(actor, spaceId), error => { unanswered = error; return true; });
  assert.deepEqual(classifyError(unanswered, false), { code: 'PROVIDER_UNAVAILABLE', retryable: true });
  const refusedCheck = (await jobs())[6];
  assert.deepEqual([refusedCheck.state, refusedCheck.parts], ['cancelled', 0]);
});

test('an admission kept waiting on its locked space is retryable BACKPRESSURE, and one whose access lapses meanwhile FORBIDDEN', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const holders = [];
  /** A cell pool whose admission finds the space row locked by another transaction until the submission settles. */
  const contended = { connect: async () => {
    const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = async (sql, ...rest) => {
      if (sql === 'SELECT 1 FROM spaces WHERE space_id=$1 FOR SHARE') {
        const holder = await pool.connect();
        holders.push(holder);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR UPDATE', [spaceId]);
      }
      return query(sql, ...rest);
    };
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  const brief = { scope: (...args) => spaces.scope(...args), assertCurrentUntil: async () => Date.now() + 300 };
  // With access for 300 ms, the access lapsed while it waited: FORBIDDEN. With access unexpired, the space stayed busy
  // past the admission's bound: retryable BACKPRESSURE. Either way the export is cancelled unrun.
  for (const [authority, code, retryable] of [[brief, 'FORBIDDEN', false], [spaces, 'BACKPRESSURE', true]]) {
    try {
      await assert.rejects(new PostgresPortabilityExports(authority, new Map([['cell-a', { pool: contended }]])).submit(actor, spaceId),
        error => { assert.deepEqual([error.code, error.retryable === true], [code, retryable], error.message); return true; });
    } finally {
      for (const holder of holders.splice(0)) { await holder.query('ROLLBACK'); holder.release(); }
    }
    const job = (await pool.query(`SELECT state,(SELECT count(*)::int FROM portability_parts p WHERE p.job_id=j.job_id) AS parts
      FROM portability_jobs j WHERE space_id=$1 ORDER BY created_at DESC LIMIT 1`, [spaceId])).rows[0];
    assert.deepEqual(job, { state: 'cancelled', parts: 0 });
  }
  // Uncontended, the space takes an export at once.
  assert.equal((await portability.submitExport(actor, spaceId)).state, 'queued');
  await drain();
});

test('a space holds at most 4 exports at once, completed ones until they expire, and the byte budget holds the manifest', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const held = [];
  for (let i = 0; i < portabilityExportBounds.heldPerSpace; i++) { held.push((await portability.submitExport(actor, spaceId)).jobId); await drain(); }
  await rejects(portability.submitExport(actor, spaceId), 'BACKPRESSURE', 'a fifth export while four completed ones are held');
  // Once one expires and a step ends it (its parts removed), the space takes another.
  await bypassing(`UPDATE portability_jobs SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '24 hours',
    started_at=started_at-interval '25 hours',finished_at=finished_at-interval '25 hours' WHERE job_id=$1`, [held[0]]);
  await rejects(portability.submitExport(actor, spaceId), 'BACKPRESSURE', 'an expired export holds its parts until a step ends it');
  assert.equal((await worker().step({ budgetMs: 2_000 })).exports.expired, 1);
  assert.equal(await partsOf(held[0]), 0);
  const { status, parts, manifestText } = await result(actor, spaceId, held[1]);
  const bytes = parts.reduce((n, part) => n + part.byteSize, 0) + Buffer.byteLength(manifestText);
  // The same space exported again writes the same bytes. A budget of exactly them seals; one byte less fails the
  // export at its manifest, its data parts all written and then removed.
  assert.equal(status.manifest.partCount, parts.length + 1);
  for (const [budget, expected] of [[bytes, 'completed'], [bytes - 1, 'failed']]) {
    const { jobId } = await portability.submitExport(actor, spaceId);
    const exporter = new PortabilityExportWorker(newPool(1), budget);
    while ((await exporter.step(Date.now() + 10_000)).claimed);
    const ended = await portability.exportStatus(actor, spaceId, jobId);
    assert.deepEqual([ended.state, ended.failureCode, await partsOf(jobId)],
      expected === 'completed' ? ['completed', null, parts.length + 1] : ['failed', 'BUDGET_EXCEEDED', 0], `a budget of ${budget} bytes`);
    if (expected === 'completed') {
      await bypassing(`UPDATE portability_jobs SET state='expired',finished_at=clock_timestamp() WHERE job_id=$1`, [jobId]);
      // Ended, it is held until a step removes its parts.
      await rejects(portability.submitExport(actor, spaceId), 'BACKPRESSURE', 'an ended export holds its parts until they are removed');
      assert.equal((await sweep()).removed, parts.length + 1);
    }
  }
});

test('an admission crossing its admission time is counted by a concurrent submission, so a space never holds a fifth export', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  for (let i = 0; i < portabilityExportBounds.heldPerSpace - 1; i++) { await portability.submitExport(actor, spaceId); await drain(); }
  // The fourth submission's admission passes its admission-time check 300 ms before that time ends and commits 1 s later;
  // 500 ms in, another submission counts the space's held exports.
  let concurrent;
  const crossing = { connect: async () => {
    const client = await pool.connect(), query = client.query.bind(client), release = client.release.bind(client);
    let admitting = false;
    client.query = async (sql, ...rest) => {
      if (/^UPDATE portability_jobs j SET state='running'/.test(sql)) {
        admitting = true;
        await bypassing(`UPDATE portability_jobs SET created_at=clock_timestamp()-$2*interval '1 millisecond' WHERE job_id=$1`,
          [rest[0][1], portabilityExportBounds.admissionMs - 300]);
      }
      if (sql === 'COMMIT' && admitting) {
        // The other submission counts once the admission time has ended, before the admission commits.
        await new Promise(resolve => setTimeout(resolve, 500));
        concurrent = portability.submitExport(actor, spaceId).then(() => 'admitted', error => error);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return query(sql, ...rest);
    };
    client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
    return client;
  } };
  const fourth = await new PostgresPortabilityExports(spaces, new Map([['cell-a', { pool: crossing }]])).submit(actor, spaceId);
  const outcome = await concurrent;
  assert.equal(outcome.code, 'BACKPRESSURE', String(outcome?.message ?? outcome));
  assert.match(outcome.message, /holds 4 exports/);
  const held = (await pool.query(`SELECT count(*)::int AS n FROM portability_jobs WHERE space_id=$1 AND state IN ('queued','running','completed')`,
    [spaceId])).rows[0].n;
  assert.equal(held, portabilityExportBounds.heldPerSpace);
  await drain();
  assert.equal((await portability.exportStatus(actor, spaceId, fourth.jobId)).state, 'completed');
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
  } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); }
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
  // for the other kind: the step must choose, and the choice must alternate, here with a new worker at every step (as
  // the jobs Worker creates one each tick, mostly within one minute, so of the same minute parity).
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const step = await slow().step({ budgetMs: 2_000 });
    turns.push([step.pages + step.completed > 0 ? 'analysis' : '', step.exports.parts + step.exports.completed > 0 ? 'export' : ''].join(''));
  }
  // One step cannot hold a turn of each, so they alternate step by step, whichever goes first.
  assert.deepEqual(turns, turns[0] === 'analysis' ? ['analysis', 'export', 'analysis', 'export'] : ['export', 'analysis', 'export', 'analysis']);
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

test('a probe follows its claim, passing over locked jobs; a locked job, a busy export or a failing expiry never holds the other back', async t => {
  const actor = await owner();
  const [spaceId, other, locked] = [await space(actor), await space(actor), await space(actor)];
  for (let i = 0; i < 4; i++) for (const [id, fill] of [[spaceId, 'x'], [other, 'y']])
    await mutate(actor, id, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${fill.repeat(700_000)}${i}` } });
  await mutate(actor, locked, 'alpha', { operation: 'create', data: { label: 'z' } });
  // The oldest analysis job of all waits in a space another transaction holds locked throughout: it is not due, so it
  // never puts analysis first.
  await services.analysis.submit(actor, locked, 'alpha', 'export');
  const purge = await pool.connect();
  await purge.query('BEGIN');
  await purge.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR UPDATE', [locked]);
  t.after(async () => { await purge.query('ROLLBACK').catch(() => {}); purge.release(); });
  const jobs = slow();
  const turn = step => [step.pages + step.completed > 0 ? 'analysis' : '', step.exports.parts + step.exports.completed > 0 ? 'export' : ''].join('');
  const epoch = async (sql, params) => Number((await pool.query(`SELECT (extract(epoch FROM (${sql}))*1000)::float8 AS t`, params)).rows[0].t);
  const exporter = new PortabilityExportWorker(newPool(1));
  // An analysis job whose lease ended long ago, then a fresh one queued: the probe reports the fresh one, which the
  // claim takes first (queued before lapsed), not the one waiting longest.
  const lapsed = await services.analysis.submit(actor, other, 'alpha', 'export');
  assert.equal(turn(await jobs.step({ budgetMs: 2_000 })), 'analysis');
  const fresh = await services.analysis.submit(actor, other, 'alpha', 'export');
  const freshSince = await epoch('SELECT created_at FROM analysis_jobs WHERE job_id=$1', [fresh.jobId]);
  assert.equal(await jobs.waiting(Date.now() + 1_000), freshSince);
  // A job row another transaction holds locked is passed over by the probe, as by the claim: the next one reports instead,
  // and with none left the kind is not due. The same for an export.
  const { jobId } = await portability.submitExport(actor, spaceId);
  const rowHolder = await pool.connect();
  try {
    await rowHolder.query('BEGIN');
    await rowHolder.query('SELECT 1 FROM analysis_jobs WHERE job_id=$1 FOR UPDATE', [fresh.jobId]);
    await rowHolder.query('SELECT 1 FROM portability_jobs WHERE job_id=$1 FOR UPDATE', [jobId]);
    assert.equal(await jobs.waiting(Date.now() + 1_000), await epoch('SELECT leased_until FROM analysis_jobs WHERE job_id=$1', [lapsed.jobId]));
    assert.equal(await exporter.waiting(Date.now() + 1_000), null, 'a locked export is not due');
    await rowHolder.query('SELECT 1 FROM analysis_jobs WHERE job_id=$1 FOR UPDATE', [lapsed.jobId]);
    assert.equal(await jobs.waiting(Date.now() + 1_000), null, 'no unlocked analysis job is due');
    await rowHolder.query('ROLLBACK');
    assert.equal(await exporter.waiting(Date.now() + 1_000), await epoch('SELECT leased_until FROM portability_jobs WHERE job_id=$1', [jobId]));
    // An expired job, here held locked so the step's expiry slice passes over it, is no claimable work: the probe never
    // reports its expiry.
    await bypassing(`UPDATE analysis_jobs SET created_at=created_at-interval '2 days',expires_at=clock_timestamp()-interval '1 hour'
      WHERE job_id=$1`, [fresh.jobId]);
    await rowHolder.query('BEGIN');
    await rowHolder.query('SELECT 1 FROM analysis_jobs WHERE job_id=$1 FOR UPDATE', [fresh.jobId]);
    assert.equal(await jobs.waiting(Date.now() + 1_000), await epoch('SELECT leased_until FROM analysis_jobs WHERE job_id=$1', [lapsed.jobId]));
  } finally { await rowHolder.query('ROLLBACK').catch(() => {}); rowHolder.release(); }
  // With both kinds due and room for one turn only, the steps alternate.
  const turns = [];
  for (let i = 0; i < 2; i++) {
    await services.analysis.submit(actor, other, 'alpha', 'export');
    turns.push(turn(await jobs.step({ budgetMs: 2_000 })));
  }
  assert.deepEqual([...turns].sort(), ['analysis', 'export']);
  // The export's space is locked now: the export is not due, and analysis takes the step at once.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM spaces WHERE space_id=$1 FOR UPDATE', [spaceId]);
    const step = await jobs.step({ budgetMs: 2_000 });
    assert.deepEqual([turn(step), step.exports.claimed], ['analysis', 0], 'analysis runs while the export\'s space is locked');
    await holder.query('COMMIT');
  } finally { await holder.query('ROLLBACK').catch(() => {}); holder.release(); }

  // Both an analysis job holding pages and slots and the export have expired, and removing the export's parts fails:
  // the analysis job still ends in that step (pages and slots released), another analysis job advances, and the
  // failure is reported.
  await bypassing(`UPDATE analysis_jobs SET created_at=created_at-interval '2 days',expires_at=clock_timestamp()-interval '1 second',
    leased_until=clock_timestamp()-interval '2 seconds' WHERE job_id=$1`, [lapsed.jobId]);
  await bypassing(`UPDATE portability_jobs SET created_at=created_at-interval '2 days',expires_at=clock_timestamp()-interval '1 second',
    leased_until=clock_timestamp()-interval '2 seconds' WHERE job_id=$1`, [jobId]);
  const pages = async () => (await pool.query(`SELECT count(*) FILTER (WHERE job_id=$2)::int AS lapsed,count(*)::int AS all
    FROM analysis_result_pages WHERE space_id=$1`, [other, lapsed.jobId])).rows[0];
  const before = await pages();
  assert.ok(before.lapsed > 0);
  await assert.rejects(worker(sql => {
    if (/^\s*DELETE FROM portability_parts/.test(sql)) throw new Error('removing the parts failed');
    if (/^\s*INSERT INTO analysis_result_pages/.test(sql)) spin(700);
  }).step({ budgetMs: 2_000 }), /removing the parts failed/);
  const after = await pages();
  assert.equal((await services.analysis.status(actor, other, 'alpha', lapsed.jobId)).state, 'expired');
  assert.equal(after.lapsed, 0);
  assert.ok(after.all - after.lapsed > before.all - before.lapsed, 'another analysis job wrote a page in the same step');
  assert.equal((await pool.query(`SELECT (SELECT count(*) FROM analysis_space_slots WHERE holder_job_id=$1)
    +(SELECT count(*) FROM analysis_cell_slots WHERE holder_job_id=$1) AS n`, [lapsed.jobId])).rows[0].n, '0');
  await drain();
  assert.deepEqual([(await portability.exportStatus(actor, spaceId, jobId)).state, await partsOf(jobId)], ['expired', 0]);
});

test('a slow due probe of either kind is cut at its bound, and the other kind still runs in that step', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  for (let i = 0; i < 4; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  /** A jobs Worker whose statements matching each pattern wait its milliseconds first, holding no lock, or fail. */
  const delaying = delays => {
    const own = newPool(1);
    own.on('connect', client => {
      const query = client.query.bind(client);
      client.query = async (sql, ...rest) => {
        for (const [pattern, ms] of delays) if (typeof sql === 'string' && pattern.test(sql.trim())) {
          if (ms === 'fail') throw Object.assign(new Error('the probe failed'), { code: 'XX000' });
          if (ms === 'spin') spin(700);
          else await new Promise(resolve => setTimeout(resolve, ms));
        }
        return query(sql, ...rest);
      };
    });
    return new PostgresAnalysisWorker(own, { originConnectionLimit: 5 });
  };
  const exportProbe = /^SELECT \(extract\(epoch[\s\S]*FROM portability_jobs j JOIN spaces/;
  const analysisProbe = /^SELECT \(extract\(epoch[\s\S]*FROM analysis_jobs j JOIN spaces/;
  const exportExpiry = /ORDER BY least\(j\.expires_at,j\.created_at\) LIMIT 1 FOR UPDATE SKIP LOCKED/;
  const progress = async () => (await pool.query(`SELECT (SELECT count(*) FROM analysis_result_pages WHERE space_id=$1)
    +(SELECT count(*) FROM portability_parts WHERE space_id=$1) AS n`, [spaceId])).rows[0].n;
  // Run every job here to its end, none lost or failed; completed exports then end as their expiry would, so the space
  // keeps taking exports.
  const finish = async () => {
    await drain();
    for (let i = 0; i < 40 && (await pool.query(`SELECT 1 FROM analysis_jobs WHERE space_id=$1 AND state IN ('queued','running')`,
      [spaceId])).rowCount; i++) await worker().step({ budgetMs: 5_000 });
    const unfinished = await pool.query(`SELECT job_id,state FROM analysis_jobs WHERE space_id=$1 AND state<>'completed'
      UNION ALL SELECT job_id,state FROM portability_jobs WHERE space_id=$1 AND state NOT IN ('completed','expired')`, [spaceId]);
    assert.deepEqual(unfinished.rows, [], 'every job of both kinds completes in later steps');
    await bypassing(`UPDATE portability_jobs SET state='expired' WHERE space_id=$1 AND state='completed'`, [spaceId]);
    await sweep();
  };
  const freshAnalysis = () => services.analysis.submit(actor, spaceId, 'alpha', 'export');
  const freshExport = () => portability.submitExport(actor, spaceId);
  // A probe cut short leaves its kind's wait unknown, which never puts it last for good. Every page and part write takes
  // 700 ms, so neither kind's work ends in a step: each probe in turn waits 1.5 s at every step; both wait past their
  // bound; the export's expiry nearly fills its slice and its probe is slow while the analysis probe takes 60 ms. At the
  // 2 s minimum, each kind still writes within two steps of the same worker, each step within its budget.
  const writes = [/^INSERT INTO (portability_parts|analysis_result_pages|analysis_result_manifests)/, 'spin'];
  for (const delays of [[[exportProbe, 1_500]], [[analysisProbe, 1_500]], [[exportProbe, 300], [analysisProbe, 300]],
    [[analysisProbe, 60], [exportExpiry, 190], [exportProbe, 1_500]]]) {
    await finish();
    await freshAnalysis();
    await freshExport();
    const jobs = delaying([...delays, writes]), advanced = { analysis: 0, exports: 0 };
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const step = await jobs.step({ budgetMs: 2_000 });
      assert.ok(Date.now() - started < 2_500, `the step took ${Date.now() - started} ms`);
      advanced.analysis += step.pages + step.completed;
      advanced.exports += step.exports.parts + step.exports.completed;
    }
    assert.ok(advanced.analysis > 0 && advanced.exports > 0, `both kinds wrote within two steps: ${JSON.stringify(advanced)}`);
  }
  // A probe that fails (not cut short, not locked out) is reported, and the other kind, given fresh work, still runs in
  // that step.
  for (const [probe, fresh] of [[exportProbe, freshAnalysis], [analysisProbe, freshExport]]) {
    await finish();
    await fresh();
    const before = await progress();
    await assert.rejects(delaying([[probe, 'fail']]).step({ budgetMs: 2_000 }), /the probe failed/);
    assert.ok(await progress() > before, 'the other kind advanced in the step that reported the failure');
  }
  // At the 5 s budget, preparation that succeeds within its bounds yet takes over 500 ms (each expiry pass 80 ms, each
  // probe 180 ms) still leaves the export, which waited longer, room for a part in its share ahead of backlogged analysis.
  await finish();
  const older = await freshExport();
  await freshAnalysis();
  const prepared = delaying([[exportExpiry, 80], [/ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED/, 80], [exportProbe, 180],
    [analysisProbe, 180], [/^INSERT INTO (portability_parts|analysis_result_pages|analysis_result_manifests)/, 'spin']]);
  const shared = await prepared.step({ budgetMs: 5_000 });
  assert.ok(shared.exports.parts > 0 && shared.pages > 0, `both kinds wrote in a 5 s step after slow preparation: ${JSON.stringify(shared)}`);
  await drain();
  assert.equal((await portability.exportStatus(actor, spaceId, older.jobId)).state, 'completed');
  await finish();
});

test('each kind ends its expired jobs in one pass per step, in its own slice and then in what both turns leave', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  for (let i = 0; i < 4; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  const analysisJob = await services.analysis.submit(actor, spaceId, 'alpha', 'export');
  await portability.submitExport(actor, spaceId);
  const passes = { analysis: 0, exports: 0 };
  const jobs = worker(sql => {
    if (/ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED/.test(sql)) passes.analysis++;
    if (/ORDER BY least\(j\.expires_at,j\.created_at\) LIMIT 1 FOR UPDATE SKIP LOCKED/.test(sql)) passes.exports++;
    if (/^\s*INSERT INTO (portability_parts|analysis_result_pages|analysis_result_manifests)/.test(sql)) spin(700);
  });
  // With nothing expired, one expiry pass of each kind is one statement: a 5 s step shares itself between both kinds
  // (and gives unused time back), a 2 s step runs one of them, and neither repeats a pass.
  for (const budgetMs of [5_000, 2_000, 2_000]) {
    passes.analysis = passes.exports = 0;
    const step = await jobs.step({ budgetMs });
    assert.deepEqual(passes, { analysis: 1, exports: 1 }, `one expiry pass of each kind in a ${budgetMs} ms step`);
    assert.ok(step.pages + step.completed + step.exports.parts + step.exports.completed > 0, JSON.stringify(step));
  }
  await drain();
  for (let i = 0; i < 20 && (await services.analysis.status(actor, spaceId, 'alpha', analysisJob.jobId)).state !== 'completed'; i++)
    await worker().step({ budgetMs: 5_000 });
  assert.equal((await services.analysis.status(actor, spaceId, 'alpha', analysisJob.jobId)).state, 'completed');

  // A removal that outlasts every turn gets only what the turns leave, so it never takes the kind's live work: another
  // space's admitted export writes parts within two steps at 2 s and at 5 s, while the expired export keeps its parts.
  const stuckSpace = await space(actor), liveSpace = await space(actor);
  await mutate(actor, stuckSpace, 'alpha', { operation: 'create', data: { label: 'x' } });
  const stuck = (await portability.submitExport(actor, stuckSpace)).jobId;
  await drain();
  await bypassing(`UPDATE portability_jobs SET created_at=created_at-interval '25 hours',expires_at=expires_at-interval '24 hours',
    started_at=started_at-interval '25 hours',finished_at=finished_at-interval '25 hours' WHERE job_id=$1`, [stuck]);
  for (let i = 0; i < 4; i++)
    await mutate(actor, liveSpace, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  const { jobId: live } = await portability.submitExport(actor, liveSpace);
  const own = newPool(1);
  own.on('connect', client => {
    const query = client.query.bind(client);
    client.query = async (sql, ...rest) => {
      if (typeof sql === 'string' && /^\s*DELETE FROM portability_parts/.test(sql)) await new Promise(resolve => setTimeout(resolve, 10_000));
      if (typeof sql === 'string' && /^\s*INSERT INTO portability_parts/.test(sql)) spin(700);
      return query(sql, ...rest);
    };
  });
  const blocked = new PostgresAnalysisWorker(own, { originConnectionLimit: 5 });
  for (const budgetMs of [2_000, 5_000]) {
    const before = await partsOf(live);
    for (let i = 0; i < 2 && await partsOf(live) === before; i++) await blocked.step({ budgetMs });
    assert.ok(await partsOf(live) > before, `the live export wrote parts at ${budgetMs} ms while another's removal is stuck`);
  }
  assert.ok(await partsOf(stuck) > 0, 'the expired export whose removal never fits keeps its parts');
  await drain();
  assert.deepEqual([await partsOf(stuck), (await portability.exportStatus(actor, liveSpace, live)).state], [0, 'completed']);
});

/**
 * Removal that costs `ms` an export part or analysis page in `spaceId` (a trigger sleeping before each one's DELETE), as
 * a large result's removal costs on a slow disk; 0 removes the cost.
 */
async function slowRemoval(spaceId, ms) {
  await pool.query(`CREATE TABLE IF NOT EXISTS test_slow_removal (space_id text PRIMARY KEY, ms integer NOT NULL);
    CREATE OR REPLACE FUNCTION test_slow_removal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(r.ms / 1000.0) FROM test_slow_removal r WHERE r.space_id = OLD.space_id; RETURN OLD; END $$;
    CREATE OR REPLACE TRIGGER test_slow_removal BEFORE DELETE ON portability_parts FOR EACH ROW EXECUTE FUNCTION test_slow_removal();
    CREATE OR REPLACE TRIGGER test_slow_removal BEFORE DELETE ON analysis_result_pages FOR EACH ROW EXECUTE FUNCTION test_slow_removal();`);
  await pool.query(`INSERT INTO test_slow_removal VALUES ($1,$2) ON CONFLICT (space_id) DO UPDATE SET ms=EXCLUDED.ms`, [spaceId, ms]);
}
/** A space of `n` records of 700 KB, whose export holds well over one part per record (its records and revisions sections). */
async function bulky(actor, n) {
  const spaceId = await space(actor);
  for (let i = 0; i < n; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  return spaceId;
}
const pastExpiry = jobIds => bypassing(`UPDATE portability_jobs SET created_at=created_at-interval '25 hours',
  expires_at=expires_at-interval '24 hours',started_at=started_at-interval '25 hours',finished_at=finished_at-interval '25 hours'
  WHERE job_id=ANY($1)`, [jobIds]);
/** The export's parts left: how many, and whether they are numbered 1 to that many. */
const left = async jobId => {
  const row = (await pool.query(`SELECT count(*)::int AS n,COALESCE(max(part_number),0)::int AS top FROM portability_parts
    WHERE job_id=$1`, [jobId])).rows[0];
  assert.equal(row.top, row.n, 'the parts left are numbered from 1 without gaps');
  return row.n;
};

test('an expired export\'s parts go in committed batches that fit any step, held until the last, while other spaces\' expired exports end and live exports run', async () => {
  for (const budgetMs of [5_000, 2_000]) {
    const actor = await owner();
    // Space A: four completed exports of about 30 parts each, the oldest past its expiry and each of its parts taking a
    // twentieth of the budget to remove, so its whole removal (over a budget) never fits one transaction of any step.
    const a = await bulky(actor, 20);
    const held = [];
    for (let i = 0; i < portabilityExportBounds.heldPerSpace; i++) { held.push((await portability.submitExport(actor, a)).jobId); await drain(); }
    const [oversized] = held, total = await left(oversized);
    assert.ok(total * budgetMs / 20 > budgetMs, `${total} parts`);
    // Space B: a small expired export. Space L: a live export whose every part takes 700 ms to write, so it fills each turn.
    const b = await space(actor);
    await mutate(actor, b, 'alpha', { operation: 'create', data: { label: 'x' } });
    const smallExport = (await portability.submitExport(actor, b)).jobId;
    await drain();
    await pastExpiry([oversized, smallExport]);
    await slowRemoval(a, budgetMs / 20);
    const live = (await portability.submitExport(actor, await bulky(actor, 8))).jobId;
    const jobs = slow();
    // A batch removes at most 16 parts and each step's expiry slice and what its turns leave make progress, so the
    // oversized export is gone within N = ceil(parts / 2) steps (at least two parts a step, measured margin aside).
    const most = Math.ceil(total / 2);
    let previous = total, steps = 0, idle = 0;
    while (await left(oversized) > 0) {
      assert.ok(++steps <= most, `the oversized export was removed within ${most} steps at ${budgetMs} ms`);
      // Ticks come a minute apart, so the next finds the live export's 30 s lease lapsed even when a step had no time
      // left to give it back.
      await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'
        AND leased_until>clock_timestamp()`, [live]);
      const liveBefore = await partsOf(live), liveState = (await pool.query('SELECT state FROM portability_jobs WHERE job_id=$1', [live])).rows[0].state;
      const started = Date.now();
      const step = await jobs.step({ budgetMs });
      assert.ok(Date.now() - started < budgetMs + 500, `the step took ${Date.now() - started} ms`);
      const now = await left(oversized);
      assert.ok(now <= previous, `parts left only fall: ${previous} then ${now}`);
      previous = now;
      // Ended at the first step, it is never readable, verifiable or claimable again while its parts are removed.
      const status = await portability.exportStatus(actor, a, oversized);
      assert.deepEqual([status.state, status.manifest, status.complete, status.progress.partsWritten],
        ['expired', null, false, now]);
      if (now > 0) {
        await rejects(portability.exportPart(actor, a, oversized, 1), 'CONFLICT', 'a part of an export being removed');
        await rejects(portability.submitExport(actor, a), 'BACKPRESSURE', 'the space holds the export until its last part is removed');
      }
      // The small expired export in another space ends, its parts removed, at the first step, while the oversized one is
      // still being removed.
      if (steps === 1) {
        assert.ok(now > 0, 'the oversized export is still being removed after one step');
        assert.deepEqual([(await portability.exportStatus(actor, b, smallExport)).state, await partsOf(smallExport)], ['expired', 0]);
      }
      // The live export writes a part at least every two steps while it runs.
      if (liveState === 'running') idle = step.exports.parts + step.exports.completed > 0 ? 0 : idle + 1;
      assert.ok(idle < 2, `the live export wrote nothing for ${idle} steps at ${budgetMs} ms`);
      assert.ok(await partsOf(live) >= liveBefore);
    }
    assert.ok(steps >= 2, `the removal spanned ${steps} steps`);
    // Its last part gone, the space takes an export again.
    assert.equal((await portability.submitExport(actor, a)).state, 'queued');
    await slowRemoval(a, 0);
    await drain();
  }
});

test('cleanup never takes analysis\'s window: an export kind with only a removal that does not fit leaves analysis its pages', async () => {
  const actor = await owner();
  const removing = await bulky(actor, 10);
  const expired = (await portability.submitExport(actor, removing)).jobId;
  await drain();
  await pastExpiry([expired]);
  // Every part takes 400 ms to remove (the export's whole removal over 6 s) and every analysis page 700 ms to write.
  await slowRemoval(removing, 400);
  const events = [];
  const jobs = worker(sql => {
    if (/^\s*DELETE FROM portability_parts/.test(sql)) events.push(['remove', Date.now()]);
    if (/^\s*INSERT INTO analysis_result_pages/.test(sql)) { const at = Date.now(); spin(700); events.push(['page', at, Date.now()]); }
  });
  // Pages a step writes for a backlogged analysis job, with the export removal pending (`during`) and then without.
  const pages = async () => {
    const analysed = await bulky(actor, 10);
    const { jobId } = await services.analysis.submit(actor, analysed, 'alpha', 'export');
    const written = [];
    for (const budgetMs of [5_000, 2_000]) {
      events.length = 0;
      const step = await jobs.step({ budgetMs });
      written.push(step.pages);
      const page = events.filter(([kind]) => kind === 'page');
      assert.ok(page.length > 0, `analysis wrote a page at ${budgetMs} ms`);
      // No removal runs between analysis's first page and its last page's end: only before its turn or after it.
      const from = page[0][1], to = page.at(-1)[2];
      assert.deepEqual(events.filter(([kind, at]) => kind === 'remove' && at > from && at < to), [], `removal inside analysis's turn at ${budgetMs} ms`);
    }
    return { written, jobId, analysed };
  };
  const during = await pages();
  assert.ok(await partsOf(expired) > 0, 'the removal was still pending through both steps');
  await slowRemoval(removing, 0);
  await sweep();
  const without = await pages();
  for (const [i, budgetMs] of [5_000, 2_000].entries())
    assert.ok(during.written[i] >= without.written[i] - 1, `${budgetMs} ms: ${during.written[i]} pages with the removal pending, ${without.written[i]} without`);
  // Both analysis jobs run to their end, so no later step meets them.
  for (const { jobId, analysed } of [during, without]) {
    for (let i = 0; i < 40 && (await services.analysis.status(actor, analysed, 'alpha', jobId)).state !== 'completed'; i++)
      await worker().step({ budgetMs: 5_000 });
    assert.equal((await services.analysis.status(actor, analysed, 'alpha', jobId)).state, 'completed');
  }
});

test('cancelling an export with many parts returns at once; a worker removes them in batches and the space holds it until then', async () => {
  const actor = await owner();
  const spaceId = await bulky(actor, 10);
  const completed = (await portability.submitExport(actor, spaceId)).jobId;
  await drain();
  // A running export with parts written, cut at its fourth part.
  const running = (await portability.submitExport(actor, spaceId)).jobId;
  let writes = 0;
  await assert.rejects(worker(sql => { if (/^\s*INSERT INTO portability_parts/.test(sql) && ++writes === 4) throw new Error('cut'); })
    .step({ budgetMs: 10_000 }), /cut/);
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [running]);
  await pastExpiry([completed]);
  // Each part takes 150 ms to remove: removing the completed export's in the request would take over 2 s.
  await slowRemoval(spaceId, 150);
  const before = { completed: await left(completed), running: await left(running) };
  assert.ok(before.completed >= 15 && before.running === 3, JSON.stringify(before));
  for (const [jobId, state] of [[completed, 'expired'], [running, 'cancelled']]) {
    const started = Date.now();
    assert.equal((await portability.cancelExport(actor, spaceId, jobId)).state, state);
    assert.ok(Date.now() - started < 1_000, `cancelling took ${Date.now() - started} ms`);
    await rejects(portability.exportPart(actor, spaceId, jobId, 1), 'CONFLICT');
  }
  assert.deepEqual({ completed: await left(completed), running: await left(running) }, before, 'cancellation removes no part itself');
  // Both are held until their parts are removed: with two more exports submitted, the space holds four.
  for (let i = 0; i < 2; i++) await portability.submitExport(actor, spaceId);
  await assert.rejects(portability.submitExport(actor, spaceId), error => error.code === 'BACKPRESSURE'
    && /holds 4 exports, 2 of them unfinished/.test(error.message), 'cancelled and expired exports hold their parts');
  for (let i = 0; i < 20 && (await left(completed)) + (await left(running)) > 0; i++) {
    const was = (await left(completed)) + (await left(running));
    await worker().step({ budgetMs: 2_000 });
    assert.ok((await left(completed)) + (await left(running)) <= was);
  }
  assert.deepEqual([await left(completed), await left(running)], [0, 0]);
  await slowRemoval(spaceId, 0);
  await drain();
  assert.equal((await portability.submitExport(actor, spaceId)).state, 'queued', 'removed, they no longer count');
  await drain();
});

test('an expired analysis result goes in committed batches while both kinds keep a backlog, never holding up the expired jobs behind it', async () => {
  const actor = await owner();
  /** A completed analysis job of `n` records of 700 KB. */
  const completedAnalysis = async n => {
    const analysed = await bulky(actor, n);
    const { jobId } = await services.analysis.submit(actor, analysed, 'alpha', 'export');
    for (let i = 0; i < 40 && (await services.analysis.status(actor, analysed, 'alpha', jobId)).state !== 'completed'; i++)
      await worker().step({ budgetMs: 5_000 });
    return { analysed, jobId };
  };
  const pagesOf = async jobId => {
    const row = (await pool.query(`SELECT count(*)::int AS n,COALESCE(max(page_number),0)::int AS top FROM analysis_result_pages
      WHERE job_id=$1`, [jobId])).rows[0];
    assert.equal(row.top, row.n, 'the pages left are numbered from 1 without gaps');
    return row.n;
  };
  for (const budgetMs of [5_000, 2_000]) {
    // The oldest expired result: 6 pages, each taking 9 % of the budget to remove, so its removal outlasts the expiry
    // slice and what the turns leave. Behind it, a small expired result in another space.
    const large = await completedAnalysis(6);
    const small = await completedAnalysis(1);
    // The large one expired first, so it is ended first.
    await bypassing(`UPDATE analysis_jobs SET created_at=created_at-interval '2 days',started_at=started_at-interval '2 days',
      finished_at=finished_at-interval '2 days',expires_at=clock_timestamp()-CASE WHEN job_id=$1 THEN interval '2 seconds'
      ELSE interval '1 second' END WHERE job_id IN ($1,$2)`, [large.jobId, small.jobId]);
    const total = await pagesOf(large.jobId);
    assert.ok(total >= 6, `${total} pages`);
    await slowRemoval(large.analysed, Math.round(budgetMs * 0.09));
    // Both kinds keep a backlog: an analysis job and an export, each page or part taking 700 ms to write.
    const busy = await bulky(actor, 20);
    const backlog = await services.analysis.submit(actor, busy, 'alpha', 'export');
    const live = (await portability.submitExport(actor, busy)).jobId;
    const jobs = slow();
    let steps = 0, previous = total;
    while (await pagesOf(large.jobId) > 0) {
      assert.ok(++steps <= total, `the large expired result was removed within ${total} steps at ${budgetMs} ms`);
      // Ticks come a minute apart, so the next finds every lease lapsed.
      await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'
        AND leased_until>clock_timestamp()`, [live]);
      await jobs.step({ budgetMs });
      const now = await pagesOf(large.jobId);
      assert.ok(now <= previous, `pages left only fall: ${previous} then ${now}`);
      previous = now;
      assert.equal((await services.analysis.status(actor, large.analysed, 'alpha', large.jobId)).state, 'expired');
      // The small result behind it ends with its pages removed at the first step.
      if (steps === 1)
        assert.deepEqual([(await services.analysis.status(actor, small.analysed, 'alpha', small.jobId)).state, await pagesOf(small.jobId)],
          ['expired', 0]);
    }
    assert.notEqual((await services.analysis.status(actor, busy, 'alpha', backlog.jobId)).state, 'completed', 'the analysis backlog lasted');
    await slowRemoval(large.analysed, 0);
    await drain();
    for (let i = 0; i < 40 && (await services.analysis.status(actor, busy, 'alpha', backlog.jobId)).state !== 'completed'; i++)
      await worker().step({ budgetMs: 5_000 });
  }
});

test('submission counts held exports without reading the space\'s ended history, and a step counts only parts it writes', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  // A record created and then deleted before the boundary: the records section reads it and writes no line.
  const created = (await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } })).ref.id;
  await mutate(actor, spaceId, 'alpha', { operation: 'delete', id: created, expectedRevision: 1 });
  const first = (await portability.submitExport(actor, spaceId)).jobId;
  const exporter = new PortabilityExportWorker(newPool(1));
  let parts = 0, step;
  while ((step = await exporter.step(Date.now() + 10_000)).claimed) parts += step.parts;
  const { status } = await result(actor, spaceId, first);
  assert.equal(parts, status.manifest.partCount - 1, 'every data part counted once, a read that wrote nothing not at all');
  // 20,000 ended exports retained in the space, as its history keeps them until erasure.
  await bypassing(`INSERT INTO portability_jobs(space_id,job_id,kind,principal_id,credential_id,policy_version,placement_generation,
      format_version,watermark,state,created_at,expires_at,finished_at)
    SELECT space_id,'exp_'||gen_random_uuid(),kind,principal_id,credential_id,policy_version,placement_generation,format_version,
      watermark,'expired',created_at-interval '2 days',created_at-interval '1 day',created_at-interval '1 day'
    FROM portability_jobs, generate_series(1,20000) WHERE job_id=$1`, [first]);
  const held = await pool.connect();
  try {
    await held.query('BEGIN');
    await held.query('SET LOCAL enable_seqscan = off');
    // The held count's plan reads the space's live exports and exports holding parts, never its ended rows.
    const plan = JSON.stringify((await held.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM portability_jobs j
      WHERE j.space_id=$1 AND j.kind='export' AND j.state IN ('queued','running','completed')`, [spaceId])).rows[0]['QUERY PLAN']);
    assert.match(plan, /portability_jobs_live_space/);
    await held.query('ROLLBACK');
  } finally { held.release(); }
  const started = Date.now();
  const next = await portability.submitExport(actor, spaceId);
  assert.equal(next.state, 'queued');
  assert.ok(Date.now() - started < 2_000, `submission took ${Date.now() - started} ms with 20,000 ended exports`);
  await drain();
});

test('a probe stalled on a table lock leaves the other kind its window', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: 'x' } });
  const analysisJob = await services.analysis.submit(actor, spaceId, 'alpha', 'export');
  const holder = await pool.connect();
  try {
    // Maintenance holds the export table: the export probe gives up at its lock bound, and analysis still runs.
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE portability_jobs IN ACCESS EXCLUSIVE MODE');
    const step = await worker().step({ budgetMs: 2_000 });
    assert.equal(step.claimed, 1, 'the analysis job is claimed while the export table is locked');
    assert.ok(step.pages + step.completed > 0, JSON.stringify(step));
    await holder.query('COMMIT');
    // And the other way round: with the analysis table locked, a due export still writes its parts.
    const { jobId } = await portability.submitExport(actor, spaceId);
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE analysis_jobs IN ACCESS EXCLUSIVE MODE');
    const other = await worker().step({ budgetMs: 2_000 });
    assert.equal(other.exports.claimed, 1, JSON.stringify(other));
    assert.ok(other.exports.parts + other.exports.completed > 0, JSON.stringify(other));
    await holder.query('COMMIT');
    await drain();
    assert.equal((await portability.exportStatus(actor, spaceId, jobId)).state, 'completed');
  } finally { await holder.query('ROLLBACK').catch(() => {}); holder.release(); }
  for (let i = 0; i < 20 && (await services.analysis.status(actor, spaceId, 'alpha', analysisJob.jobId)).state !== 'completed'; i++)
    await worker().step({ budgetMs: 5_000 });
  assert.equal((await services.analysis.status(actor, spaceId, 'alpha', analysisJob.jobId)).state, 'completed');
});

test('an export due alone takes the whole step budget, and an invalid origin connection limit fails analysis only', async () => {
  const actor = await owner();
  const spaceId = await space(actor);
  for (let i = 0; i < 4; i++)
    await mutate(actor, spaceId, 'alpha', { operation: 'create', data: { label: `big ${i}`, body: `${'x'.repeat(700_000)}${i}` } });
  const { jobId } = await portability.submitExport(actor, spaceId);
  // Every part write takes 700 ms. Capped at exports' 2 s share, a step would write one; with no analysis job due, the
  // export takes all 5 s.
  const step = await worker(sql => { if (/^\s*INSERT INTO portability_parts/.test(sql)) spin(700); }).step({ budgetMs: 5_000 });
  assert.ok(step.exports.parts >= 3, `a lone export wrote ${step.exports.parts} parts in a 5 s step`);
  await pool.query(`UPDATE portability_jobs SET leased_until=clock_timestamp() WHERE job_id=$1 AND state='running'`, [jobId]);

  // A cell with an invalid origin connection limit still runs its exports; the step then reports the analysis failure.
  const own = newPool(1);
  const misconfigured = new PostgresAnalysisWorker(own, { originConnectionLimit: Number(undefined) });
  // One unhindered step finishes the export's few remaining parts and seals it.
  await assert.rejects(misconfigured.step({ budgetMs: 10_000 }), error => error instanceof RangeError
    && /Invalid origin connection limit/.test(error.message));
  const { status, parts, manifestText } = await result(actor, spaceId, jobId);
  assert.equal((await verifyExportManifest(manifestText, status.manifest.sha256, parts.map(part => part.content))).ok, true);
});

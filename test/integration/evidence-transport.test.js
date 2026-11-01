import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { McpFnTestClient, authenticatedHttpTarget } from '@mcpfn/testing';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';
import { R2BlobStore } from '../../packages/storage/dist/index.js';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { createMcpHandler } from '../../packages/mcp/dist/index.js';

const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const url = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const pool = new pg.Pool({ connectionString: url, max: 8 });
test.after(() => pool.end());
const sha = value => createHash('sha256').update(value).digest('hex');

/** An in-memory R2 bucket with the binding's atomic put, sha256 check and checksum. */
class MemoryR2 {
  objects = new Map();
  async put(key, body, options = {}) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
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

const config = { database: memoryAdapter(), namespace: `sta37-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const r2 = new MemoryR2();
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32), originals: new R2BlobStore(r2) }]]), 3600);
const http = createHttpHandler({ services, identity });

// Every JSON view is checked against the published OpenAPI schema of its operation.
const openapi = YAML.parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date-time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
ajv.addSchema({ $id: 'openapi', components: openapi.components });
function conforms(schema, value, label = schema) {
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  assert.ok(validate(value), `${label} conforms to OpenAPI ${schema}: ${JSON.stringify(validate.errors)}`);
  return value;
}

const definition = slug => ({ slug, version: 1, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { label: { type: 'string' } }, additionalProperties: false }, unique: [], filterable: [], sortable: [] });
const api = async (token, method, path, body) => {
  const response = await http(new Request(`https://stateplane.example.invalid${path}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: response.status, response, body: response.status === 204 || !response.headers.get('content-type')?.startsWith('application/json')
    ? null : await response.json() };
};
const code = result => result.body?.error?.code ?? result.error?.code;

async function host() {
  const holder = {};
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await (req.url === '/mcp' ? holder.mcp(request) : http(request));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  holder.mcp = createMcpHandler({ services, identity, resource: `${origin}/mcp`, authorizationServers: ['http://127.0.0.1:9/'],
    allowInsecureLoopback: true });
  return { server, origin };
}
async function run(root, argv, input = '') {
  const child = spawn(process.execPath, ['packages/cli/bin/stateplane.js', ...argv], {
    cwd: process.cwd(), env: { ...process.env, STATEPLANE_CONFIG_DIR: root, STATEPLANE_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return status === 0 ? JSON.parse(stdout) : JSON.parse(stderr);
}

test('upload, extraction, claim review, linking and deletion over HTTP, CLI and MCP under one access rule', async t => {
  const { server, origin } = await host();
  t.after(() => server.close());
  const temp = await mkdtemp(join(tmpdir(), 'stateplane-sta37-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const ownerToken = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  const owner = await identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${ownerToken}` } }));
  const spaceId = `sp_${randomUUID()}`;
  assert.equal((await api(ownerToken, 'POST', '/v1/spaces', { spaceId })).status, 201);
  for (const slug of ['alpha', 'beta'])
    assert.equal((await api(ownerToken, 'PUT', `/v1/spaces/${spaceId}/collections/${slug}`, definition(slug))).status, 201);
  const key = async grants => (await spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
    Object.entries(grants).map(([collectionId, capabilities]) => ({ collectionId, capabilities })))).secret;
  const evidence = ['records:read', 'records:write', 'sources:read', 'sources:write', 'claims:read', 'claims:write'];
  const writer = await key({ alpha: evidence, beta: ['claims:read', 'claims:write'] });
  // Reads claims in beta but cannot read alpha's sources, which the claim cites.
  const outsider = await key({ beta: ['claims:read', 'claims:write'] });
  const reviewer = await key({ alpha: ['sources:read'], beta: ['claims:read', 'claims:review'] });
  const mcp = async token => {
    const client = await McpFnTestClient.connectTarget(authenticatedHttpTarget(`${origin}/mcp`, { credential: { kind: 'api-key',
      headers: { authorization: `Bearer ${token}` } } }), { name: 'sta37', version: '1.0.0' });
    t.after(() => client.close());
    return async (tool, args) => {
      const result = await client.callTool(tool, { spaceId, ...args });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${tool} structured/text parity`);
      return result.isError ? { error: result.structuredContent.error } : result.structuredContent;
    };
  };
  const cliAs = async (token, name) => {
    const root = join(temp, name);
    await run(root, ['config', 'endpoint', '--url', `${origin}/`]);
    await run(root, ['auth', 'import', '--token-stdin', '--store', 'file'], `${token}\n`);
    await run(root, ['spaces', 'select', '--space', spaceId]);
    return argv => run(root, argv);
  };
  const [writerMcp, outsiderMcp, reviewerMcp] = await Promise.all([mcp(writer), mcp(outsider), mcp(reviewer)]);
  const [writerCli, outsiderCli, ownerCli] = await Promise.all([cliAs(writer, 'writer'), cliAs(outsider, 'outsider'), cliAs(ownerToken, 'owner')]);
  const alpha = `/v1/spaces/${spaceId}/collections/alpha`;
  const beta = `/v1/spaces/${spaceId}/collections/beta`;

  // Upload through the CLI: a grant, the raw bytes, then the committed source.
  const text = 'Alpha observed the beacon at dawn.\n';
  const file = join(temp, 'report.txt');
  await writeFile(file, text);
  const grant = conforms('UploadGrant', await writerCli(['uploads', 'create', '--collection', 'alpha', '--mime-type', 'text/plain',
    '--max-bytes', '1024', '--sha256', sha(text)]));
  const attempt = conforms('UploadAttempt', await writerCli(['uploads', 'send', '--collection', 'alpha', '--grant', grant.grantId,
    '--file', file, '--mime-type', 'text/plain']));
  assert.deepEqual([attempt.bytes, attempt.sha256], [Buffer.byteLength(text), sha(text)]);
  const source = conforms('Source', await writerCli(['uploads', 'finalize', '--collection', 'alpha', '--grant', grant.grantId,
    '--attempt', attempt.attemptId, '--locator', 'https://example.invalid/report']));
  assert.deepEqual([source.original.sha256, source.replayed], [sha(text), false]);
  const replay = conforms('Source', (await api(writer, 'POST', `${alpha}/uploads/${grant.grantId}/finalize`,
    { attemptId: attempt.attemptId, locator: 'https://example.invalid/report' })).body);
  assert.deepEqual([replay.sourceId, replay.replayed], [source.sourceId, true], 'HTTP replays the CLI finalize');
  const sourcePath = `${alpha}/sources/${source.sourceId}`;
  conforms('Source', (await api(writer, 'GET', sourcePath)).body);

  // The same verified bytes over HTTP and MCP.
  const content = await api(writer, 'GET', `${sourcePath}/content`);
  assert.equal(content.status, 200);
  assert.equal(await content.response.text(), text);
  assert.equal(content.response.headers.get('repr-digest'), `sha-256=:${Buffer.from(sha(text), 'hex').toString('base64')}:`);
  assert.equal(Buffer.from((await writerMcp('sources_content', { collectionId: 'alpha', sourceId: source.sourceId })).contentBase64,
    'base64').toString(), text);

  // Extraction over MCP, its replay over HTTP, a correction over HTTP, and the first version over the CLI.
  const v1 = conforms('Extraction', await writerMcp('sources_extract', { collectionId: 'alpha', sourceId: source.sourceId }));
  assert.deepEqual([v1.version, v1.content, v1.sourceSha256], [1, text, sha(text)]);
  assert.equal(conforms('Extraction', (await api(writer, 'POST', `${sourcePath}/extraction`)).body).replayed, true);
  const v2 = conforms('Extraction', (await api(writer, 'POST', `${sourcePath}/extraction/corrections`, { baseVersion: 1,
    content: 'Alpha observed the beacon.', sourceOffsets: [{ start: 0, end: 26, sourceStart: 0, sourceEnd: 34 }] })).body);
  assert.deepEqual([v2.version, v2.previousVersion, v2.parser], [2, 1, 'stateplane.correction']);
  assert.equal(conforms('Extraction', await writerCli(['sources', 'extraction', '--collection', 'alpha', '--id', source.sourceId,
    '--version', '1'])).content, text, 'an earlier version stays readable');

  // A claim in beta citing alpha's source, created over MCP.
  const cite = [{ collectionId: 'alpha', sourceId: source.sourceId, extractionVersion: 2, start: 0, end: 5 }];
  const claim = conforms('Claim', await writerMcp('claims_create', { collectionId: 'beta', idempotencyKey: 'claim-1',
    statement: 'The beacon was lit.', attributedTo: 'Field report', observedAt: '2026-10-01T06:00:00.000Z', evidence: cite }));
  assert.deepEqual([claim.revision, claim.review.status, claim.evidence[0].extractionVersion], [1, 'unreviewed', 2]);
  const claimPath = `${beta}/claims/${claim.claimId}`;

  // No declassification: a caller who cannot read alpha's sources sees nothing of the claim on any transport,
  // and cannot cite them, whatever else is wrong with the request.
  assert.equal(code(await api(outsider, 'GET', claimPath)), 'NOT_FOUND');
  assert.equal(code(await outsiderMcp('claims_get', { collectionId: 'beta', claimId: claim.claimId })), 'NOT_FOUND');
  assert.equal(code(await outsiderCli(['claims', 'get', '--collection', 'beta', '--id', claim.claimId])), 'NOT_FOUND');
  assert.deepEqual(conforms('ClaimPage', (await api(outsider, 'GET', `${beta}/claims`)).body).claims, []);
  assert.deepEqual((await outsiderMcp('claims_list', { collectionId: 'beta' })).claims, []);
  assert.equal(code(await api(outsider, 'POST', `${beta}/claims`, { idempotencyKey: 'x', statement: 'S', attributedTo: 'A', evidence: cite })), 'FORBIDDEN');
  assert.equal(code(await outsiderMcp('claims_create', { collectionId: 'beta', idempotencyKey: 'x', statement: 'S', attributedTo: 'A',
    evidence: cite })), 'FORBIDDEN');
  // The owning collection is authorized before the request shape: without claims:write a malformed request is FORBIDDEN too.
  assert.equal(code(await reviewerMcp('claims_create', { collectionId: 'beta', idempotencyKey: 'x', statement: 'S', attributedTo: 'A',
    unexpected: true })), 'FORBIDDEN', 'access is decided before the request shape');
  assert.equal(code(await api(reviewer, 'POST', `${beta}/claims`, '{malformed')), 'FORBIDDEN');
  assert.equal(code(await api(outsider, 'POST', `${alpha}/sources/text`, '{malformed')), 'FORBIDDEN');
  assert.equal(code(await outsiderCli(['sources', 'get', '--collection', 'alpha', '--id', source.sourceId])), 'FORBIDDEN');

  // Review needs claims:review: the writer is refused on every transport; the reviewer accepts over HTTP.
  assert.equal(code(await api(writer, 'POST', `${claimPath}/reviews`, { baseRevision: 1, status: 'accepted' })), 'FORBIDDEN');
  assert.equal(code(await writerMcp('claims_review', { collectionId: 'beta', claimId: claim.claimId, baseRevision: 1, status: 'accepted' })), 'FORBIDDEN');
  assert.equal(code(await writerCli(['claims', 'review', '--collection', 'beta', '--id', claim.claimId, '--base-revision', '1',
    '--status', 'accepted'])), 'FORBIDDEN');
  const reviewed = conforms('Claim', (await api(reviewer, 'POST', `${claimPath}/reviews`, { baseRevision: 1, status: 'accepted' })).body);
  assert.deepEqual([reviewed.revision, reviewed.review.status, reviewed.recordedBy], [2, 'accepted', reviewed.review.reviewedBy]);
  assert.equal(conforms('Claim', await reviewerMcp('claims_get', { collectionId: 'beta', claimId: claim.claimId, revision: 1 }))
    .review.status, 'unreviewed', 'the unreviewed revision stays readable');
  assert.deepEqual((await writerCli(['claims', 'list', '--collection', 'beta', '--status', 'accepted', '--citing-collection', 'alpha',
    '--citing-source', source.sourceId])).claims.map(item => item.claimId), [claim.claimId]);

  // A record restricts the source's deletion through a link created over the CLI.
  const record = (await api(writer, 'POST', `${alpha}/records`, { operation: 'create', idempotencyKey: 'r-1', data: { label: 'beacon' } })).body.ref.id;
  const link = conforms('Link', await writerCli(['links', 'create', '--collection', 'alpha', '--idempotency-key', 'link-1', '--data',
    JSON.stringify({ type: 'evidence', policy: 'restrict', from: { kind: 'record', collectionId: 'alpha', id: record },
      to: { kind: 'source', collectionId: 'alpha', id: source.sourceId } })]));
  assert.deepEqual(conforms('LinkPage', await writerMcp('links_list', { collectionId: 'alpha', endpoint: { kind: 'record', id: record } }))
    .links.map(item => item.linkId), [link.linkId]);
  conforms('Link', (await api(writer, 'GET', `${alpha}/links/${link.linkId}`)).body);
  assert.equal(code(await writerMcp('sources_delete', { collectionId: 'alpha', sourceId: source.sourceId })), 'LINK_RESTRICTED');
  assert.equal(code(await api(writer, 'DELETE', sourcePath)), 'LINK_RESTRICTED');
  assert.equal(code(await writerCli(['sources', 'delete', '--collection', 'alpha', '--id', source.sourceId])), 'LINK_RESTRICTED');
  assert.equal((await api(writer, 'GET', `${sourcePath}/content`)).status, 200, 'a refused deletion changes nothing');

  // Delete the link over HTTP, then the source over the CLI: its bytes go, its metadata and citing claims stay.
  const unlinked = conforms('LinkDeletion', (await api(writer, 'DELETE', `${alpha}/links/${link.linkId}`)).body);
  assert.deepEqual([unlinked.deleted, unlinked.erasure], [true, { originalBytes: 'none', metadata: 'retained', backups: 'retained' }]);
  const objectKey = [...r2.objects.keys()].find(item => item.startsWith('originals/'));
  assert.ok(objectKey);
  const deleted = conforms('SourceDeletion', await writerCli(['sources', 'delete', '--collection', 'alpha', '--id', source.sourceId]));
  assert.ok(['pending', 'removed'].includes(deleted.erasure.originalBytes));
  assert.deepEqual([deleted.erasure.metadata, deleted.erasure.backups], ['retained', 'retained']);
  assert.equal(r2.objects.has(objectKey), false, 'the original bytes are removed after the deletion commits');
  assert.equal(code(await api(writer, 'GET', `${sourcePath}/content`)), 'NOT_FOUND');
  assert.equal(code(await writerMcp('sources_extraction', { collectionId: 'alpha', sourceId: source.sourceId })), 'NOT_FOUND');
  assert.equal(conforms('SourceDeletion', (await api(writer, 'DELETE', sourcePath)).body).replayed, true);
  assert.deepEqual(conforms('Claim', (await api(reviewer, 'GET', claimPath)).body).evidence.map(item => item.sourceId), [source.sourceId],
    'claims citing a deleted source keep the reference as provenance');

  // Claim deletion over MCP follows the revision rule.
  assert.equal(code(await writerMcp('claims_delete', { collectionId: 'beta', claimId: claim.claimId, baseRevision: 1 })), 'REVISION_CONFLICT');
  const claimGone = conforms('ClaimDeletion', await writerMcp('claims_delete', { collectionId: 'beta', claimId: claim.claimId, baseRevision: 2 }));
  assert.equal(claimGone.erasure.originalBytes, 'none');
  assert.equal(code(await api(reviewer, 'GET', claimPath)), 'NOT_FOUND');

  // A reference-only source has no bytes on any transport.
  const reference = conforms('Source', (await api(writer, 'POST', `${alpha}/sources/reference`, { idempotencyKey: 'ref-1',
    locator: 'https://example.invalid/elsewhere' })).body);
  assert.equal((await api(writer, 'GET', `${alpha}/sources/${reference.sourceId}/content`)).status, 204);
  assert.equal((await writerMcp('sources_content', { collectionId: 'alpha', sourceId: reference.sourceId })).contentBase64, null);

  // Space deletion reports what remains; the owner reads the report again over the CLI. Agents cannot.
  assert.equal(code(await api(writer, 'GET', `/v1/spaces/${spaceId}/erasure`)), 'FORBIDDEN', 'owner sessions only, as for the audit');
  assert.equal((await api(ownerToken, 'PATCH', `/v1/spaces/${spaceId}`, { lifecycle: 'suspended' })).status, 200, 'suspend before deletion');
  const removed = (await api(ownerToken, 'DELETE', `/v1/spaces/${spaceId}`)).body;
  assert.equal(removed.deleted, true, JSON.stringify(removed));
  conforms('SpaceErasure', removed.erasure);
  const report = conforms('SpaceErasure', await ownerCli(['spaces', 'erasure']));
  assert.deepEqual([report.spaceId, report.backups], [spaceId, 'retained']);
});

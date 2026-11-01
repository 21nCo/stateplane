import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { McpFnTestClient, authenticatedHttpTarget } from '@mcpfn/testing';
import { createHttpHandler } from '../packages/api/dist/index.js';
import { createMcpHandler, stateplaneMcpDeclaration } from '../packages/mcp/dist/index.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const owner = { kind: 'session', userPrincipalId: 'owner', credentialId: 'session-1' };
const document = YAML.parse(await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'));

/** Recording services: every call names its service method and arguments; an upload reports the bytes it received. */
function fixture() {
  const calls = [];
  const state = { calls, failure: null, digest: sha('abc') };
  const record = (name, value) => async (...args) => {
    const call = { name, args: args.slice(1) };
    calls.push(call);
    if (state.failure) throw state.failure;
    return typeof value === 'function' ? value(call, ...args.slice(1)) : value;
  };
  const view = id => ({ sourceId: id, original: { referenceOnly: false, sha256: state.digest, byteSize: 3, mimeType: 'text/html' } });
  state.services = {
    spaces: { erasure: record('spaces.erasure', { spaceId: 'sp_a', database: 'pending', originalBytes: 'pending', backups: 'retained' }) },
    sources: {
      get: record('sources.get', { sourceId: 'src_1' }),
      content: record('sources.content', (_call, _s, _c, id) => id === 'src_ref'
        ? { source: { sourceId: id, original: { referenceOnly: true, sha256: null, byteSize: null, mimeType: null } }, body: null }
        : { source: view(id), body: new Blob(['abc']).stream() }),
      ingestText: record('sources.ingestText', { sourceId: 'src_1' }),
      ingestReference: record('sources.ingestReference', { sourceId: 'src_2' }),
      createUpload: record('sources.createUpload', { grantId: 'upl_1' }),
      upload: record('sources.upload', async (call, _s, _c, grantId, body) => {
        call.received = Buffer.from(await new Response(body).arrayBuffer()).toString();
        return { grantId, attemptId: 'att_1' };
      }),
      finalizeUpload: record('sources.finalizeUpload', { sourceId: 'src_3' }),
      revokeUpload: record('sources.revokeUpload', { grantId: 'upl_1' }),
      delete: record('sources.delete', { sourceId: 'src_1' }),
      extract: record('sources.extract', { version: 1 }),
      correctExtraction: record('sources.correctExtraction', { version: 2 }),
      extraction: record('sources.extraction', { version: 1 })
    },
    claims: {
      create: record('claims.create', { claimId: 'clm_1' }), revise: record('claims.revise', { revision: 2 }),
      review: record('claims.review', { revision: 3 }), delete: record('claims.delete', { claimId: 'clm_1' }),
      get: record('claims.get', { claimId: 'clm_1' }), list: record('claims.list', { claims: [], next: null })
    },
    links: {
      create: record('links.create', { linkId: 'lnk_1' }), get: record('links.get', { linkId: 'lnk_1' }),
      delete: record('links.delete', { linkId: 'lnk_1' }), list: record('links.list', { links: [], next: null })
    }
  };
  state.identity = { verify: async request => request.headers.get('authorization') === 'Bearer secret-test-token' ? owner : null };
  return state;
}
const base = 'https://stateplane.example.invalid';
const c = '/v1/spaces/sp_a/collections/c';
const send = (handler, method, path, { body, headers = {} } = {}) => handler(new Request(`${base}${path}`, { method,
  headers: { authorization: 'Bearer secret-test-token', ...(typeof body === 'object' && !(body instanceof Uint8Array) ?
    { 'content-type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body }));
const scoped = (...rest) => ['sp_a', 'c', ...rest];
const endpoint = (kind, id) => ({ kind, collectionId: 'c', id });

/** Every evidence route: method, path, body, the service it reaches and that service's arguments, and the status. */
const routes = [
  ['GET', '/v1/spaces/sp_a/erasure', undefined, 'spaces.erasure', ['sp_a']],
  ['POST', `${c}/sources/text`, { idempotencyKey: 'k', text: 'T' }, 'sources.ingestText', scoped({ idempotencyKey: 'k', text: 'T' })],
  ['POST', `${c}/sources/reference`, { idempotencyKey: 'k', locator: 'L' }, 'sources.ingestReference', scoped({ idempotencyKey: 'k', locator: 'L' })],
  ['GET', `${c}/sources/src%2F1`, undefined, 'sources.get', scoped('src/1')],
  ['DELETE', `${c}/sources/src_1`, undefined, 'sources.delete', scoped('src_1')],
  ['GET', `${c}/sources/src_1/content`, undefined, 'sources.content', scoped('src_1')],
  ['GET', `${c}/sources/src_1/extraction`, undefined, 'sources.extraction', scoped('src_1', undefined)],
  ['GET', `${c}/sources/src_1/extraction?version=2`, undefined, 'sources.extraction', scoped('src_1', 2)],
  ['POST', `${c}/sources/src_1/extraction`, undefined, 'sources.extract', scoped('src_1')],
  ['POST', `${c}/sources/src_1/extraction/corrections`, { baseVersion: 1, content: 'A', sourceOffsets: [] }, 'sources.correctExtraction',
    scoped('src_1', { baseVersion: 1, content: 'A', sourceOffsets: [] })],
  ['POST', `${c}/uploads`, { mimeType: 'text/plain', maxBytes: 3 }, 'sources.createUpload', scoped({ mimeType: 'text/plain', maxBytes: 3 }), 201],
  ['DELETE', `${c}/uploads/upl_1`, undefined, 'sources.revokeUpload', scoped('upl_1')],
  ['POST', `${c}/uploads/upl_1/finalize`, { attemptId: 'att_1' }, 'sources.finalizeUpload', scoped('upl_1', { attemptId: 'att_1' })],
  ['POST', `${c}/claims`, { idempotencyKey: 'k', statement: 'S', attributedTo: 'A' }, 'claims.create',
    scoped({ idempotencyKey: 'k', statement: 'S', attributedTo: 'A' })],
  ['GET', `${c}/claims?status=accepted&citingCollection=b&citingSource=src_9&after=clm_0&limit=5`, undefined, 'claims.list',
    scoped({ citing: { collectionId: 'b', sourceId: 'src_9' }, status: 'accepted', after: 'clm_0', limit: 5 })],
  ['GET', `${c}/claims/clm_1?revision=3`, undefined, 'claims.get', scoped('clm_1', 3)],
  ['DELETE', `${c}/claims/clm_1?baseRevision=3`, undefined, 'claims.delete', scoped('clm_1', { baseRevision: 3 })],
  ['POST', `${c}/claims/clm_1/revisions`, { baseRevision: 1, statement: 'S', attributedTo: 'A' }, 'claims.revise',
    scoped('clm_1', { baseRevision: 1, statement: 'S', attributedTo: 'A' })],
  ['POST', `${c}/claims/clm_1/reviews`, { baseRevision: 2, status: 'accepted' }, 'claims.review', scoped('clm_1', { baseRevision: 2, status: 'accepted' })],
  ['POST', `${c}/links`, { idempotencyKey: 'k', type: 't', policy: 'detach', from: endpoint('record', 'r'), to: endpoint('source', 's') },
    'links.create', scoped({ idempotencyKey: 'k', type: 't', policy: 'detach', from: endpoint('record', 'r'), to: endpoint('source', 's') })],
  ['GET', `${c}/links?endpointKind=record&endpointId=r&limit=5`, undefined, 'links.list', scoped({ endpoint: { kind: 'record', id: 'r' }, limit: 5 })],
  ['GET', `${c}/links/lnk_1`, undefined, 'links.get', scoped('lnk_1')],
  ['DELETE', `${c}/links/lnk_1`, undefined, 'links.delete', scoped('lnk_1')]
];

test('every evidence HTTP route reaches its one service with the framed request', async () => {
  const state = fixture();
  const handler = createHttpHandler(state);
  for (const [method, path, body, service, args, status = 200] of routes) {
    state.calls.length = 0;
    const response = await send(handler, method, path, { body });
    assert.equal(response.status, status, `${method} ${path}: ${response.status === 200 ? '' : await response.clone().text()}`);
    assert.deepEqual(state.calls.map(call => call.name), [service], `${method} ${path}`);
    assert.deepEqual(state.calls[0].args, args, `${method} ${path}`);
    await response.body?.cancel();
  }
  for (const [method, path] of [['PUT', `${c}/sources/src_1`], ['GET', `${c}/sources`], ['POST', `${c}/sources/other`],
    ['GET', `${c}/uploads/upl_1`], ['PUT', `${c}/claims/clm_1`], ['PATCH', `${c}/links/lnk_1`], ['GET', `${c}/sources/src_1/extraction/corrections`],
    ['POST', '/v1/spaces/sp_a/erasure']]) {
    state.calls.length = 0;
    const response = await send(handler, method, path);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
    assert.equal(state.calls.length, 0, `${method} ${path} reaches no service`);
  }
});

test('malformed evidence inputs reach the service, which refuses them after authorizing the collection', async () => {
  const state = fixture();
  const handler = createHttpHandler(state);
  const cases = [
    ['POST', `${c}/claims`, '{not json', 'claims.create', scoped(null)],
    ['POST', `${c}/links`, '[1]', 'links.create', scoped([1])],
    ['GET', `${c}/sources/src_1/extraction?version=02`, undefined, 'sources.extraction', scoped('src_1', Number.NaN)],
    ['GET', `${c}/claims/clm_1?revision=0`, undefined, 'claims.get', scoped('clm_1', Number.NaN)],
    ['GET', `${c}/claims?limit=05&status=a&status=b`, undefined, 'claims.list', scoped({ status: ['a', 'b'], limit: '05' })],
    ['GET', `${c}/claims?citingSource=src_9`, undefined, 'claims.list', scoped({ citing: { sourceId: 'src_9' } })],
    ['DELETE', `${c}/claims/clm_1`, undefined, 'claims.delete', scoped('clm_1', {})],
    ['GET', `${c}/links?endpointId=r`, undefined, 'links.list', scoped({ endpoint: { id: 'r' } })]
  ];
  for (const [method, path, body, service, args] of cases) {
    state.calls.length = 0;
    const response = await handler(new Request(`${base}${path}`, { method, body,
      headers: { authorization: 'Bearer secret-test-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }));
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.deepEqual(state.calls.map(call => call.name), [service]);
    assert.deepEqual(state.calls[0].args, args, `${method} ${path}`);
  }
  // A refusal is the service's own code, and an unauthorized caller learns nothing more for a malformed body.
  state.failure = Object.assign(new Error('private detail'), { code: 'FORBIDDEN' });
  const refused = await handler(new Request(`${base}${c}/claims`, { method: 'POST', body: '{not json',
    headers: { authorization: 'Bearer secret-test-token', 'content-type': 'application/json' } }));
  assert.equal(refused.status, 403);
  assert.doesNotMatch(await refused.text(), /private detail/);
  // Framing is still checked first, as for records: a non-JSON media type or an oversized body never reaches a service.
  state.failure = null; state.calls.length = 0;
  const wrongType = await send(handler, 'POST', `${c}/links`, { body: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal((await wrongType.json()).error.code, 'INVALID_ARGUMENT');
  const oversized = await send(handler, 'POST', `${c}/links`, { body: `{"type":"${'x'.repeat(32_768)}"}`,
    headers: { 'content-type': 'application/json' } });
  assert.deepEqual([oversized.status, (await oversized.json()).error.retryable], [429, false]);
  assert.equal(state.calls.length, 0);
});

test('original bytes are served as a verified, uncached, unrendered attachment and uploads frame the raw body', async () => {
  const state = fixture();
  const handler = createHttpHandler(state);
  const response = await send(handler, 'GET', `${c}/sources/src_1/content`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'abc');
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('repr-digest'), `sha-256=:${Buffer.from(sha('abc'), 'hex').toString('base64')}:`);
  const reference = await send(handler, 'GET', `${c}/sources/src_ref/content`);
  assert.equal(reference.status, 204);
  assert.equal(reference.headers.get('x-stateplane-reference-only'), 'true');
  assert.equal(await reference.text(), '');
  // A failed content read is an ordinary JSON error, retryable as a GET.
  state.failure = Object.assign(new Error('r2 detail'), { code: 'PROVIDER_UNAVAILABLE' });
  const failed = await send(handler, 'GET', `${c}/sources/src_1/content`);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('retry-after'), '1');
  assert.equal((await failed.json()).error.retryable, true);
  state.failure = null;

  const digest = sha('abc');
  for (const [headers, query, declared] of [
    [{ 'content-type': 'text/plain; charset=utf-8' }, `?sha256=${digest}`, { bytes: 3, mimeType: 'text/plain; charset=utf-8', sha256: digest }],
    [{}, '', { bytes: 3 }],
    [{ 'content-type': 'text/plain' }, '?sha256=a&sha256=b', { bytes: 3, mimeType: 'text/plain', sha256: ['a', 'b'] }]
  ]) {
    state.calls.length = 0;
    // Bytes, not a string, so Request adds no Content-Type of its own.
    const sent = await handler(new Request(`${base}${c}/uploads/upl_1/attempts${query}`, { method: 'POST', body: new TextEncoder().encode('abc'),
      headers: { authorization: 'Bearer secret-test-token', 'content-length': '3', ...headers } }));
    assert.equal(sent.status, 200);
    const [call] = state.calls;
    assert.equal(call.name, 'sources.upload');
    assert.deepEqual(call.args.slice(0, 3), scoped('upl_1'));
    assert.ok(call.args[3] instanceof ReadableStream);
    assert.deepEqual(call.args[4], declared, 'Content-Length, Content-Type and sha256 become the declaration');
    assert.equal(call.received, 'abc');
  }
  // An empty body still reaches the service as an empty stream with its declared length.
  state.calls.length = 0;
  await handler(new Request(`${base}${c}/uploads/upl_1/attempts`, { method: 'POST',
    headers: { authorization: 'Bearer secret-test-token', 'content-length': '0', 'content-type': 'text/plain' } }));
  assert.deepEqual([state.calls[0].args[4], state.calls[0].received], [{ bytes: 0, mimeType: 'text/plain' }, '']);
});

/** OpenAPI path template matching one concrete v1 path, with its parameters. */
function operationOf(method, path) {
  const [pathname] = path.split('?');
  for (const [template, item] of Object.entries(document.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    if (pattern.test(pathname) && item[method.toLowerCase()]) {
      // A literal path wins over a template, as OpenAPI resolves them.
      const literal = Object.keys(document.paths).find(other => other === pathname && document.paths[other][method.toLowerCase()]);
      return document.paths[literal ?? template][method.toLowerCase()];
    }
  }
  return undefined;
}
const evidencePath = template => /\/(sources|uploads|claims|links)(\/|$)|\/erasure$/.test(template);

test('OpenAPI documents exactly the evidence routes the handler serves, with their statuses', async () => {
  const documented = Object.entries(document.paths).filter(([template]) => evidencePath(template))
    .flatMap(([template, item]) => Object.keys(item).filter(key => key !== 'parameters').map(method => [method.toUpperCase(), template]));
  const served = new Set();
  for (const [method, path, , , , status = 200] of routes) {
    const operation = operationOf(method, path);
    assert.ok(operation, `${method} ${path} is documented`);
    assert.ok(operation.responses[String(status)] || (status === 200 && operation.responses['204']), `${operation.operationId} documents ${status}`);
    served.add(operation.operationId);
  }
  const upload = operationOf('POST', `${c}/uploads/upl_1/attempts`);
  served.add(upload.operationId);
  assert.deepEqual(documented.map(([method, template]) => document.paths[template][method.toLowerCase()].operationId).sort(),
    [...served].sort(), 'every documented evidence operation is served and every served one documented');
  for (const [, template] of documented) {
    for (const parameter of template.match(/\{[^}]+\}/g) ?? [])
      assert.ok(document.paths[template].parameters.some(item => document.components.parameters[item.$ref?.split('/').pop()]?.name ===
        parameter.slice(1, -1)), `${template} declares ${parameter}`);
  }
});

/** Resolve local $refs so two published schemas compare by value; prose is dropped. */
function resolved(node) {
  if (Array.isArray(node)) return node.map(resolved);
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) return resolved(document.components.schemas[node.$ref.split('/').pop()]);
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
    .map(([key, value]) => [key, resolved(value)]));
}
test('MCP evidence tools publish the OpenAPI request bodies of the same operations', () => {
  const manifest = stateplaneMcpDeclaration().manifest();
  const input = name => resolved(manifest.tools.find(tool => tool.name === name).inputSchema);
  const body = schema => resolved(document.components.schemas[schema]);
  const pairs = [
    ['sources_ingest_text', 'IngestText', []], ['sources_ingest_reference', 'IngestReference', []],
    ['sources_correct_extraction', 'ExtractionCorrection', ['sourceId']], ['uploads_create', 'UploadGrantRequest', []],
    ['uploads_finalize', 'UploadFinalize', ['grantId']], ['claims_create', 'ClaimCreate', []],
    ['claims_revise', 'ClaimRevision', ['claimId']], ['claims_review', 'ClaimReview', ['claimId']], ['links_create', 'LinkCreate', []]
  ];
  for (const [tool, schema, selectors] of pairs) {
    const mcp = input(tool);
    const http = body(schema);
    const own = ['spaceId', 'collectionId', ...selectors];
    assert.deepEqual(Object.keys(mcp.properties).filter(key => !own.includes(key)).sort(), Object.keys(http.properties).sort(), tool);
    assert.deepEqual(mcp.required.filter(key => !own.includes(key)), http.required, tool);
    for (const key of Object.keys(http.properties)) assert.deepEqual(mcp.properties[key], http.properties[key], `${tool}.${key}`);
    assert.equal(http.additionalProperties, false);
  }
  // Query and header inputs: the same names and bounds as the tool arguments.
  const query = (operationPath, method) => Object.fromEntries((document.paths[operationPath][method].parameters ?? [])
    .map(parameter => [parameter.name, resolved(parameter.schema)]));
  const claims = query('/v1/spaces/{spaceId}/collections/{collectionId}/claims', 'get');
  assert.deepEqual(claims.status, { enum: input('claims_list').properties.status.enum });
  assert.equal(claims.limit.maximum, input('claims_list').properties.limit.maximum);
  assert.equal(query('/v1/spaces/{spaceId}/collections/{collectionId}/links', 'get').limit.maximum,
    input('links_list').properties.limit.maximum);
  assert.deepEqual(query('/v1/spaces/{spaceId}/collections/{collectionId}/uploads/{grantId}/attempts', 'post').sha256,
    input('uploads_send').properties.sha256);
});

async function serve(handler) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function cliProcess(root, argv, input = '', { nodeArgs = [], env = {} } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, 'packages/cli/bin/stateplane.js', ...argv], {
    cwd: process.cwd(), env: { ...process.env, STATEPLANE_CONFIG_DIR: root, STATEPLANE_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

test('every evidence CLI command sends its HTTP route; content is saved, verified and never overwrites', async t => {
  const state = fixture();
  const { server, origin } = await serve(createHttpHandler(state));
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'stateplane-evidence-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = (argv, input) => cliProcess(root, argv, input);
  assert.equal((await cli(['config', 'endpoint', '--url', `${origin}/`])).status, 0);
  assert.equal((await cli(['auth', 'import', '--token-stdin', '--store', 'file'], 'secret-test-token\n')).status, 0);
  assert.equal((await cli(['spaces', 'select', '--space', 'sp_a'])).status, 0);
  const text = join(root, 'text.md');
  await writeFile(text, 'From a file');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bomText = join(root, 'bom.md');
  await writeFile(bomText, Buffer.concat([bom, Buffer.from('From a file')]));
  const bomOnly = join(root, 'bom-only.md');
  await writeFile(bomOnly, bom);
  const bytes = join(root, 'bytes.txt');
  await writeFile(bytes, 'abc');
  const digest = sha('abc');
  const cl = ['--collection', 'c'];
  const commands = [
    [['spaces', 'erasure'], 'spaces.erasure', ['sp_a']],
    [['sources', 'get', ...cl, '--id', 'src/1'], 'sources.get', scoped('src/1')],
    [['sources', 'ingest-text', ...cl, '--idempotency-key', 'k', '--text', 'T', '--mime-type', 'text/markdown', '--captured-at', '2026-01-01T00:00:00Z'],
      'sources.ingestText', scoped({ idempotencyKey: 'k', text: 'T', mimeType: 'text/markdown', capturedAt: '2026-01-01T00:00:00Z' })],
    [['sources', 'ingest-text', ...cl, '--idempotency-key', 'k', '--file', text], 'sources.ingestText', scoped({ idempotencyKey: 'k', text: 'From a file' })],
    // Text from a file is sent byte for byte: a leading byte order mark is part of the original.
    [['sources', 'ingest-text', ...cl, '--idempotency-key', 'k', '--file', bomText], 'sources.ingestText',
      scoped({ idempotencyKey: 'k', text: '\uFEFFFrom a file' })],
    [['sources', 'ingest-text', ...cl, '--idempotency-key', 'k', '--file', bomOnly], 'sources.ingestText', scoped({ idempotencyKey: 'k', text: '\uFEFF' })],
    [['sources', 'ingest-reference', ...cl, '--idempotency-key', 'k', '--locator', 'https://example.invalid/a'], 'sources.ingestReference',
      scoped({ idempotencyKey: 'k', locator: 'https://example.invalid/a' })],
    [['sources', 'delete', ...cl, '--id', 'src_1'], 'sources.delete', scoped('src_1')],
    [['sources', 'extract', ...cl, '--id', 'src_1'], 'sources.extract', scoped('src_1')],
    [['sources', 'extraction', ...cl, '--id', 'src_1', '--version', '2'], 'sources.extraction', scoped('src_1', 2)],
    [['sources', 'correct', ...cl, '--id', 'src_1', '--base-version', '1', '--data', '{"content":"A","sourceOffsets":[]}'],
      'sources.correctExtraction', scoped('src_1', { baseVersion: 1, content: 'A', sourceOffsets: [] })],
    [['uploads', 'create', ...cl, '--mime-type', 'text/plain', '--max-bytes', '3', '--expires-in', '60', '--sha256', digest],
      'sources.createUpload', scoped({ mimeType: 'text/plain', maxBytes: 3, sha256: digest, expiresInSeconds: 60 })],
    [['uploads', 'send', ...cl, '--grant', 'upl_1', '--file', bytes, '--mime-type', 'text/plain', '--sha256', digest], 'sources.upload',
      [...scoped('upl_1'), 'stream', { bytes: 3, mimeType: 'text/plain', sha256: digest }]],
    [['uploads', 'finalize', ...cl, '--grant', 'upl_1', '--attempt', 'att_1', '--locator', 'L'], 'sources.finalizeUpload',
      scoped('upl_1', { attemptId: 'att_1', locator: 'L' })],
    [['uploads', 'revoke', ...cl, '--grant', 'upl_1'], 'sources.revokeUpload', scoped('upl_1')],
    [['claims', 'create', ...cl, '--idempotency-key', 'k', '--data', '{"statement":"S","attributedTo":"A"}'], 'claims.create',
      scoped({ idempotencyKey: 'k', statement: 'S', attributedTo: 'A' })],
    [['claims', 'revise', ...cl, '--id', 'clm_1', '--base-revision', '1', '--data', '{"statement":"S2","attributedTo":"A"}'], 'claims.revise',
      scoped('clm_1', { baseRevision: 1, statement: 'S2', attributedTo: 'A' })],
    [['claims', 'review', ...cl, '--id', 'clm_1', '--base-revision', '2', '--status', 'accepted'], 'claims.review',
      scoped('clm_1', { baseRevision: 2, status: 'accepted' })],
    [['claims', 'delete', ...cl, '--id', 'clm_1', '--base-revision', '3'], 'claims.delete', scoped('clm_1', { baseRevision: 3 })],
    [['claims', 'get', ...cl, '--id', 'clm_1', '--revision', '2'], 'claims.get', scoped('clm_1', 2)],
    [['claims', 'list', ...cl, '--status', 'accepted', '--citing-collection', 'b', '--citing-source', 'src_9', '--after', 'clm_0', '--limit', '5'],
      'claims.list', scoped({ citing: { collectionId: 'b', sourceId: 'src_9' }, status: 'accepted', after: 'clm_0', limit: 5 })],
    [['links', 'create', ...cl, '--idempotency-key', 'k', '--data', JSON.stringify({ type: 't', policy: 'restrict', from: endpoint('record', 'r'),
      to: endpoint('claim', 'clm_1') })], 'links.create',
    scoped({ idempotencyKey: 'k', type: 't', policy: 'restrict', from: endpoint('record', 'r'), to: endpoint('claim', 'clm_1') })],
    [['links', 'get', ...cl, '--id', 'lnk_1'], 'links.get', scoped('lnk_1')],
    [['links', 'delete', ...cl, '--id', 'lnk_1'], 'links.delete', scoped('lnk_1')],
    [['links', 'list', ...cl, '--endpoint-kind', 'source', '--endpoint-id', 's', '--limit', '5'], 'links.list',
      scoped({ endpoint: { kind: 'source', id: 's' }, limit: 5 })]
  ];
  for (const [argv, service, args] of commands) {
    state.calls.length = 0;
    const run = await cli(argv);
    assert.equal(run.status, 0, `${argv.join(' ')}: ${run.stderr}`);
    assert.deepEqual(state.calls.map(call => call.name), [service], argv.join(' '));
    assert.deepEqual(state.calls[0].args.map(arg => arg instanceof ReadableStream ? 'stream' : arg), args, argv.join(' '));
    if (service === 'sources.upload') assert.equal(state.calls[0].received, 'abc');
  }
  // Local refusals happen before any request: a payload setting a flag's field, both text inputs, or an invalid integer.
  state.calls.length = 0;
  for (const argv of [
    ['claims', 'create', ...cl, '--idempotency-key', 'k', '--data', '{"idempotencyKey":"other","statement":"S","attributedTo":"A"}'],
    ['sources', 'ingest-text', ...cl, '--idempotency-key', 'k', '--text', 'T', '--file', text],
    ['claims', 'delete', ...cl, '--id', 'clm_1', '--base-revision', '01'],
    ['links', 'list', ...cl, '--endpoint-kind', 'record'],
    ['sources', 'content', ...cl, '--id', 'src_1']
  ]) assert.equal(JSON.parse((await cli(argv)).stderr).error.code, 'INVALID_ARGUMENT', argv.join(' '));
  assert.equal(state.calls.length, 0);

  const output = join(root, 'original.bin');
  const saved = await cli(['sources', 'content', ...cl, '--id', 'src_1', '--output', output]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { referenceOnly: false, output, bytes: 3, sha256: digest, mimeType: 'text/html' });
  assert.equal(await readFile(output, 'utf8'), 'abc');
  const again = await cli(['sources', 'content', ...cl, '--id', 'src_1', '--output', output]);
  assert.equal(JSON.parse(again.stderr).error.code, 'INVALID_ARGUMENT', 'an existing file is never overwritten');
  assert.equal(await readFile(output, 'utf8'), 'abc');
  assert.deepEqual(JSON.parse((await cli(['sources', 'content', ...cl, '--id', 'src_ref', '--output', join(root, 'none')])).stdout),
    { referenceOnly: true, output: null });
  // Bytes that do not match the published digest are removed and reported as nonretryable corruption.
  state.digest = sha('abd');
  const corrupt = join(root, 'corrupt.bin');
  const refused = await cli(['sources', 'content', ...cl, '--id', 'src_1', '--output', corrupt]);
  assert.deepEqual(JSON.parse(refused.stderr).error, { code: 'PROVIDER_UNAVAILABLE', message: 'PROVIDER_UNAVAILABLE', retryable: false, requestId: null });
  await assert.rejects(readFile(corrupt), { code: 'ENOENT' });
});

/** A CLI configured for an endpoint, with its config in a temporary directory. */
async function configuredCli(t, origin) {
  const root = await mkdtemp(join(tmpdir(), 'stateplane-evidence-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await cliProcess(root, ['config', 'endpoint', '--url', `${origin}/`])).status, 0);
  assert.equal((await cliProcess(root, ['auth', 'import', '--token-stdin', '--store', 'file'], 'secret-test-token\n')).status, 0);
  assert.equal((await cliProcess(root, ['spaces', 'select', '--space', 'sp_a'])).status, 0);
  return { root, cli: (argv, options) => cliProcess(root, argv, '', options) };
}

test('CLI evidence payloads from --file are bounded by their route body budget, not the record budget', async t => {
  const state = fixture();
  const { server, origin } = await serve(createHttpHandler(state));
  t.after(() => server.close());
  const { root, cli } = await configuredCli(t, origin);
  const cl = ['--collection', 'c'];
  // Each command adds one flag field before the payload; the body on the wire is exactly the budget, then one byte over.
  for (const [argv, field, value, filler, budget, service] of [
    [['claims', 'create', ...cl, '--idempotency-key', 'k'], 'idempotencyKey', 'k', 'statement', 3_145_728, 'claims.create'],
    [['claims', 'revise', ...cl, '--id', 'clm_1', '--base-revision', '1'], 'baseRevision', 1, 'statement', 3_145_728, 'claims.revise'],
    [['sources', 'correct', ...cl, '--id', 'src_1', '--base-version', '1'], 'baseVersion', 1, 'content', 3_145_728, 'sources.correctExtraction'],
    [['links', 'create', ...cl, '--idempotency-key', 'k'], 'idempotencyKey', 'k', 'type', 32_768, 'links.create']
  ]) {
    const data = size => ({ [filler]: 'x'.repeat(size), attributedTo: 'A' });
    const overhead = Buffer.byteLength(JSON.stringify({ [field]: value, ...data(0) }));
    for (const [extra, accepted] of [[0, true], [1, false]]) {
      const file = join(root, 'payload.json');
      await writeFile(file, JSON.stringify(data(budget - overhead + extra)));
      state.calls.length = 0;
      const run = await cli([...argv, '--file', file]);
      if (accepted) {
        assert.equal(run.status, 0, `${argv.join(' ')}: ${run.stderr}`);
        assert.deepEqual(state.calls.map(call => call.name), [service]);
        assert.equal(Buffer.byteLength(JSON.stringify(state.calls[0].args.at(-1))), budget, argv.join(' '));
      } else {
        assert.deepEqual(JSON.parse(run.stderr).error, { code: 'RATE_LIMITED', message: 'RATE_LIMITED', retryable: false, requestId: null });
        assert.equal(state.calls.length, 0, `${argv.join(' ')} over budget is refused before any request`);
      }
    }
  }
});

test('CLI JSON input with a number that overflows to Infinity is refused before any request', async t => {
  const state = fixture();
  const { server, origin } = await serve(createHttpHandler(state));
  t.after(() => server.close());
  const { root, cli } = await configuredCli(t, origin);
  const cl = ['--collection', 'c'];
  // JSON.stringify would send Infinity as null, and a null extractionVersion is an unversioned citation.
  const body = number => `{"statement":"S","attributedTo":"A","evidence":[{"collectionId":"c","sourceId":"src_1","extractionVersion":${number}}]}`;
  const file = join(root, 'claim.json');
  for (const number of ['1e400', '-1e400']) {
    await writeFile(file, body(number));
    for (const argv of [
      ['claims', 'create', ...cl, '--idempotency-key', 'k', '--data', body(number)],
      ['claims', 'create', ...cl, '--idempotency-key', 'k', '--file', file],
      ['claims', 'revise', ...cl, '--id', 'clm_1', '--base-revision', '1', '--data', body(number)],
      ['claims', 'revise', ...cl, '--id', 'clm_1', '--base-revision', '1', '--file', file],
      ['records', 'query', ...cl, '--predicates', `[{"field":"n","op":"eq","value":${number}}]`]
    ]) {
      state.calls.length = 0;
      const run = await cli(argv);
      assert.deepEqual(JSON.parse(run.stderr).error, { code: 'INVALID_ARGUMENT', message: 'INVALID_ARGUMENT', retryable: false, requestId: null },
        `${argv.join(' ')} ${number}`);
      assert.equal(state.calls.length, 0, `${argv.join(' ')} ${number} sends no request`);
    }
  }
  // A large finite number is still sent as written.
  state.calls.length = 0;
  assert.equal((await cli(['claims', 'create', ...cl, '--idempotency-key', 'k', '--data', body('1e300')])).status, 0);
  assert.equal(state.calls[0].args.at(-1).evidence[0].extractionVersion, 1e300);
});

test('CLI content is saved from a chunked body by its digest, written in full, and removed when a write or close fails', async t => {
  const bytes = Buffer.from('chunked original');
  let digest = createHash('sha256').update(bytes).digest('base64');
  const encodings = [];
  const server = createServer((req, res) => {
    encodings.push(req.headers['accept-encoding']);
    // No Content-Length: Node sends the body chunked, as a streamed Worker or edge-compressed response would.
    res.writeHead(200, { 'content-type': 'text/plain', 'repr-digest': `sha-256=:${digest}:`, 'cache-control': 'no-store, no-transform' });
    res.write(bytes.subarray(0, 5));
    setTimeout(() => res.end(bytes.subarray(5)), 10);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const { root, cli } = await configuredCli(t, `http://127.0.0.1:${server.address().port}`);
  const content = ['sources', 'content', '--collection', 'c', '--id', 'src_1', '--output'];
  const output = join(root, 'chunked.txt');
  const saved = await cli([...content, output]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { referenceOnly: false, output, bytes: bytes.length, sha256: sha(bytes), mimeType: 'text/plain' });
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(encodings, ['identity'], 'the CLI asks for the bytes unencoded');

  // The child's file handles write at most one byte per call (short writes), make no progress, or fail to close.
  const faults = join(root, 'faults.mjs');
  await writeFile(faults, `import { open } from 'node:fs/promises';
const probe = await open(process.execPath, 'r'); const proto = Object.getPrototypeOf(probe); await probe.close();
const { write } = proto; const mode = process.env.STATEPLANE_TEST_FS_FAULT;
proto.write = function (buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
  // close is an own property of each handle; only a handle that was written to fails to close.
  if (mode === 'close' && !Object.hasOwn(this, 'faulted')) {
    const close = this.close; this.faulted = true;
    this.close = async () => { await close(); throw new Error('close failed'); };
  }
  if (mode === 'zero') return Promise.resolve({ bytesWritten: 0, buffer });
  return write.call(this, buffer, offset, mode === 'short' ? Math.min(length, 1) : length, position);
};
`);
  const nodeArgs = ['--import', pathToFileURL(faults).href];
  const short = join(root, 'short.txt');
  const partial = await cli([...content, short], { nodeArgs, env: { STATEPLANE_TEST_FS_FAULT: 'short' } });
  assert.equal(partial.status, 0, partial.stderr);
  assert.deepEqual(await readFile(short), bytes, 'every chunk is written in full across short writes');
  for (const mode of ['zero', 'close']) {
    const failed = join(root, `${mode}.txt`);
    const run = await cli([...content, failed], { nodeArgs, env: { STATEPLANE_TEST_FS_FAULT: mode } });
    assert.deepEqual(JSON.parse(run.stderr).error, { code: 'PROVIDER_UNAVAILABLE', message: 'PROVIDER_UNAVAILABLE', retryable: false, requestId: null }, mode);
    assert.equal(run.stdout, '', mode);
    await assert.rejects(readFile(failed), { code: 'ENOENT' }, mode);
  }
  // Repr-Digest stays mandatory without Content-Length: a mismatch removes the file.
  digest = createHash('sha256').update('other').digest('base64');
  const mismatch = join(root, 'mismatch.txt');
  assert.equal(JSON.parse((await cli([...content, mismatch])).stderr).error.code, 'PROVIDER_UNAVAILABLE');
  await assert.rejects(readFile(mismatch), { code: 'ENOENT' });
});

test('CLI content whose body stalls past --timeout or breaks mid-stream fails retryable and leaves no file', async t => {
  const bytes = Buffer.from('an original that never finishes');
  const digest = createHash('sha256').update(bytes).digest('base64');
  let mode = 'stall';
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'repr-digest': `sha-256=:${digest}:`, 'content-length': String(bytes.length) });
    res.write(bytes.subarray(0, 5));
    // A stall keeps the connection open with the rest unsent; a break drops it after the first bytes.
    if (mode === 'break') setTimeout(() => res.socket.destroy(), 20);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const { root, cli } = await configuredCli(t, `http://127.0.0.1:${server.address().port}`);
  for (const next of ['stall', 'break']) {
    mode = next;
    const output = join(root, `${next}.txt`);
    const started = Date.now();
    const run = await cli(['sources', 'content', '--collection', 'c', '--id', 'src_1', '--output', output, '--timeout', '500']);
    assert.deepEqual(JSON.parse(run.stderr).error, { code: 'PROVIDER_UNAVAILABLE', message: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: null }, next);
    assert.equal(run.stdout, '', next);
    await assert.rejects(readFile(output), { code: 'ENOENT' }, next);
    if (next === 'stall') assert.ok(Date.now() - started >= 500, 'the timeout bounds the body, not only the headers');
  }
});

test('CLI content --timeout bounds the whole download: repeats and their pauses share one deadline', async t => {
  // silent never answers; busy answers 503 with a Retry-After longer than the deadline.
  let mode = 'silent';
  let requests = 0;
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests++;
    if (mode === 'busy') {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { code: 'BACKPRESSURE', message: 'BACKPRESSURE', retryable: true } }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const { root, cli } = await configuredCli(t, `http://127.0.0.1:${server.address().port}`);
  for (const [next, code] of [['silent', 'PROVIDER_UNAVAILABLE'], ['busy', 'BACKPRESSURE']]) {
    mode = next; requests = 0;
    const output = join(root, `${next}.txt`);
    const run = await cli(['sources', 'content', '--collection', 'c', '--id', 'src_1', '--output', output, '--timeout', '500']);
    assert.deepEqual(JSON.parse(run.stderr).error, { code, message: code, retryable: true, requestId: null }, next);
    // Each repeat would get a fresh timeout or wait past the deadline, so the deadline allows only the first request.
    assert.equal(requests, 1, `${next}: no repeat once the deadline cannot be met`);
    assert.equal(run.stdout, '', next);
    await assert.rejects(readFile(output), { code: 'ENOENT' }, next);
  }
});

test('CLI content --timeout also bounds local writes and the close: nothing finished past it is reported saved', async t => {
  const bytes = Buffer.from('an original written to a slow disk');
  const digest = createHash('sha256').update(bytes).digest('base64');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'repr-digest': `sha-256=:${digest}:`, 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const { root, cli } = await configuredCli(t, `http://127.0.0.1:${server.address().port}`);
  // The child's first write, or the close of a handle written to, takes 1 s and then completes or fails.
  const faults = join(root, 'slow-disk.mjs');
  await writeFile(faults, `import { open } from 'node:fs/promises';
const probe = await open(process.execPath, 'r'); const proto = Object.getPrototypeOf(probe); await probe.close();
const { write } = proto; const [stage, outcome] = process.env.STATEPLANE_TEST_FS_SLOW.split(':');
const slow = async run => { await new Promise(resolve => setTimeout(resolve, 1000)); if (outcome === 'fails') throw new Error('EIO'); return run(); };
proto.write = function (...args) {
  if (stage === 'close' && !Object.hasOwn(this, 'slowed')) { const close = this.close; this.slowed = true; this.close = () => slow(close); }
  return stage === 'write' ? slow(() => write.apply(this, args)) : write.apply(this, args);
};
`);
  for (const mode of ['write:completes', 'write:fails', 'close:completes', 'close:fails']) {
    const output = join(root, `${mode.replace(':', '-')}.txt`);
    const started = Date.now();
    const run = await cli(['sources', 'content', '--collection', 'c', '--id', 'src_1', '--output', output, '--timeout', '500'],
      { nodeArgs: ['--import', pathToFileURL(faults).href], env: { STATEPLANE_TEST_FS_SLOW: mode } });
    // The deadline passed during the write or close: a retryable timeout, never a saved result or a local failure.
    assert.deepEqual(JSON.parse(run.stderr).error, { code: 'PROVIDER_UNAVAILABLE', message: 'PROVIDER_UNAVAILABLE', retryable: true, requestId: null }, mode);
    assert.equal(run.stdout, '', mode);
    // The file is removed only after the pending write or close has returned.
    assert.ok(Date.now() - started >= 1000, `${mode}: cleanup waits for the pending operation`);
    await assert.rejects(readFile(output), { code: 'ENOENT' }, mode);
  }
});

test('HTTP, CLI and MCP report one service refusal with the same code and retryability', async t => {
  const state = fixture();
  const http = createHttpHandler(state);
  const { server, origin } = await serve(request => new URL(request.url).pathname === '/mcp' ? mcp(request) : http(request));
  t.after(() => server.close());
  const mcp = createMcpHandler({ services: state.services, identity: state.identity, resource: `${origin}/mcp`,
    authorizationServers: ['http://127.0.0.1:9/'], allowInsecureLoopback: true });
  const client = await McpFnTestClient.connectTarget(authenticatedHttpTarget(`${origin}/mcp`, { credential: { kind: 'api-key',
    headers: { authorization: 'Bearer secret-test-token' } } }), { name: 'evidence-test', version: '1.0.0' });
  t.after(() => client.close());
  const root = await mkdtemp(join(tmpdir(), 'stateplane-evidence-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await cliProcess(root, ['config', 'endpoint', '--url', `${origin}/`])).status, 0);
  assert.equal((await cliProcess(root, ['auth', 'import', '--token-stdin', '--store', 'file'], 'secret-test-token\n')).status, 0);
  const s = { spaceId: 'sp_a', collectionId: 'c' };
  for (const [code, retryable] of [['FORBIDDEN', false], ['NOT_FOUND', false], ['LINK_RESTRICTED', false],
    ['REVISION_CONFLICT', false], ['IDEMPOTENCY_MISMATCH', false], ['SPACE_UNAVAILABLE', false]]) {
    state.failure = Object.assign(new Error(`secret ${code}`), { code });
    const viaHttp = await (await send(http, 'DELETE', `${c}/claims/clm_1?baseRevision=1`)).json();
    const viaCli = JSON.parse((await cliProcess(root, ['claims', 'delete', '--space', 'sp_a', '--collection', 'c', '--id', 'clm_1',
      '--base-revision', '1'])).stderr);
    const viaMcp = (await client.callTool('claims_delete', { ...s, claimId: 'clm_1', baseRevision: 1 })).structuredContent;
    for (const envelope of [viaHttp, viaCli, viaMcp]) {
      assert.equal(envelope.error.code, code);
      assert.equal(envelope.error.retryable, retryable);
      assert.doesNotMatch(JSON.stringify(envelope), /secret/);
    }
  }
  // An unacknowledged write is never retryable, on any transport.
  state.failure = Object.assign(new Error('lost'), { name: 'CommitOutcomeUnknownError' });
  const unknown = (await client.callTool('links_create', { ...s, idempotencyKey: 'k', type: 't', policy: 'detach',
    from: endpoint('record', 'r'), to: endpoint('record', 'q') })).structuredContent.error;
  assert.deepEqual([unknown.code, unknown.retryable], ['COMMIT_OUTCOME_UNKNOWN', false]);
  assert.match(unknown.message, /same idempotencyKey/);
  const httpUnknown = (await (await send(http, 'POST', `${c}/links`, { body: {} })).json()).error;
  assert.deepEqual([httpUnknown.code, httpUnknown.retryable], ['COMMIT_OUTCOME_UNKNOWN', false]);
});

test('MCP carries original bytes as bounded base64 and refuses what it cannot carry', async t => {
  const state = fixture();
  // Record each MCP response's size on the wire.
  const responseBytes = [];
  const { server, origin } = await serve(async request => {
    const response = await mcp(request);
    const body = Buffer.from(await response.arrayBuffer());
    responseBytes.push(body.length);
    return new Response(body, { status: response.status, headers: response.headers });
  });
  t.after(() => server.close());
  const mcp = createMcpHandler({ services: state.services, identity: state.identity, resource: `${origin}/mcp`,
    authorizationServers: ['http://127.0.0.1:9/'], allowInsecureLoopback: true });
  const client = await McpFnTestClient.connectTarget(authenticatedHttpTarget(`${origin}/mcp`, { credential: { kind: 'api-key',
    headers: { authorization: 'Bearer secret-test-token' } } }), { name: 'evidence-test', version: '1.0.0' });
  t.after(() => client.close());
  const s = { spaceId: 'sp_a', collectionId: 'c' };
  const content = await client.callTool('sources_content', { ...s, sourceId: 'src_1' });
  assert.equal(Buffer.from(content.structuredContent.contentBase64, 'base64').toString(), 'abc');
  assert.equal((await client.callTool('sources_content', { ...s, sourceId: 'src_ref' })).structuredContent.contentBase64, null);
  // Exactly 2 MiB is read in full. MCP carries the result twice (structuredContent and its JSON text), so the
  // response is about 5.3 MiB: inside the 5.5 MiB the docs record for it.
  const most = Buffer.alloc(2_097_152, 7);
  state.services.sources.content = async () => ({ source: { sourceId: 'src_2m', original: { referenceOnly: false, byteSize: most.length } },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(most)); controller.close(); } }) });
  responseBytes.length = 0;
  const largest = await client.callTool('sources_content', { ...s, sourceId: 'src_2m' });
  assert.equal(largest.isError, undefined, JSON.stringify(largest.structuredContent?.error));
  assert.deepEqual(Buffer.from(largest.structuredContent.contentBase64, 'base64'), most);
  assert.equal(responseBytes.length, 1);
  assert.ok(responseBytes[0] > 2 * 2_796_204 && responseBytes[0] <= 5_767_168, `a 2 MiB read answers ${responseBytes[0]} bytes`);
  // An original over 2 MiB is refused from its recorded size, without reading it, and cannot succeed by retrying.
  state.services.sources.content = async () => ({ source: { sourceId: 'src_big', original: { referenceOnly: false, byteSize: 2_097_153 } },
    body: new ReadableStream({ pull() { assert.fail('the body is not read'); } }) });
  const big = (await client.callTool('sources_content', { ...s, sourceId: 'src_big' })).structuredContent.error;
  assert.deepEqual([big.code, big.retryable], ['RATE_LIMITED', false]);
  // A body that fails verification while it is read keeps the service's nonretryable code.
  state.services.sources.content = async () => ({ source: { sourceId: 'src_1', original: { referenceOnly: false, byteSize: 3 } },
    body: new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('corrupt'), { code: 'PROVIDER_UNAVAILABLE', retryable: false })); } }) });
  const corrupt = (await client.callTool('sources_content', { ...s, sourceId: 'src_1' })).structuredContent.error;
  assert.deepEqual([corrupt.code, corrupt.retryable], ['PROVIDER_UNAVAILABLE', false]);

  state.calls.length = 0;
  const sent = await client.callTool('uploads_send', { ...s, grantId: 'upl_1', mimeType: 'text/plain', contentBase64: 'YWJj', sha256: sha('abc') });
  assert.equal(sent.isError, undefined);
  assert.deepEqual(state.calls[0].args[4], { bytes: 3, mimeType: 'text/plain', sha256: sha('abc') });
  assert.equal(state.calls[0].received, 'abc');
  // Exactly 2 MiB decoded is carried; one byte more, or base64 with nonzero pad bits, is refused before the service.
  state.calls.length = 0;
  const full = await client.callTool('uploads_send', { ...s, grantId: 'upl_1', mimeType: 'text/plain', contentBase64: most.toString('base64') });
  assert.equal(full.isError, undefined, JSON.stringify(full.structuredContent?.error));
  assert.equal(state.calls[0].args[4].bytes, 2_097_152);
  for (const contentBase64 of ['YWJ', 'YW=j', 'YWJj\n', 'Y'.repeat(2_796_204) + 'AAAA', Buffer.alloc(2_097_153).toString('base64'), 'YR==', 'YWJ=']) {
    state.calls.length = 0;
    const result = await client.callTool('uploads_send', { ...s, grantId: 'upl_1', mimeType: 'text/plain', contentBase64 });
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT', JSON.stringify(contentBase64.slice(0, 8)));
    assert.equal(state.calls.length, 0, 'malformed or oversized base64 never reaches the service');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { McpFnTestClient, authenticatedHttpTarget } from '@mcpfn/testing';
import { PostgresProjectionGenerations, postgresServices } from '../../packages/postgres/dist/index.js';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { createMcpHandler } from '../../packages/mcp/dist/index.js';
import { claims, config, fixture, hookedPool, identity, index, pool, registry, spaces } from './retrieval-harness.js';

// STA-49: search, bundles and projection status over HTTP, the CLI (which speaks HTTP) and MCP, through one
// composition of the real services on PostgreSQL 17 + pgvector, with the deterministic embedder configured.
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600, { embedders: registry });
const http = createHttpHandler({ services, identity });

const openapi = YAML.parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date-time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
ajv.addSchema({ $id: 'openapi', components: openapi.components });
function conforms(schema, value) {
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  assert.ok(validate(value), `conforms to OpenAPI ${schema}: ${JSON.stringify(validate.errors)}`);
  return value;
}

async function host(t) {
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
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  holder.mcp = createMcpHandler({ services, identity, resource: `${origin}/mcp`, authorizationServers: ['http://127.0.0.1:9/'],
    allowInsecureLoopback: true });
  return origin;
}
async function cliRun(root, argv, input = '') {
  const child = spawn(process.execPath, ['packages/cli/bin/stateplane.js', ...argv], {
    cwd: process.cwd(), env: { ...process.env, STATEPLANE_CONFIG_DIR: root, STATEPLANE_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return status === 0 ? JSON.parse(stdout) : JSON.parse(stderr);
}

/** One caller on all three transports; each call returns the JSON body or `{ error }`. */
async function caller(t, origin, temp, token, name, spaceId) {
  const api = async (method, path, body) => {
    const response = await http(new Request(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return response.json();
  };
  let client = null;
  // MCP is an OAuth protected resource: a credential that does not verify is refused with HTTP 401 invalid_token
  // before any tool runs, the transport's form of UNAUTHENTICATED (not retryable, as over HTTP).
  const unauthenticated = error => {
    if (error?.code !== 401 && error?.cause?.code !== 401) throw error;
    return { error: { code: 'UNAUTHENTICATED', retryable: false } };
  };
  const mcp = async (tool, args) => {
    try {
      if (!client) {
        client = await McpFnTestClient.connectTarget(authenticatedHttpTarget(`${origin}/mcp`, { credential: { kind: 'api-key',
          headers: { authorization: `Bearer ${token}` } } }), { name: 'sta49', version: '1.0.0' });
        const connected = client;
        t.after(() => connected.close());
      }
      const result = await client.callTool(tool, { spaceId, ...args });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${tool} structured/text parity`);
      return result.structuredContent;
    } catch (error) { return unauthenticated(error); }
  };
  const root = join(temp, name);
  await cliRun(root, ['config', 'endpoint', '--url', `${origin}/`]);
  await cliRun(root, ['auth', 'import', '--token-stdin', '--store', 'file'], `${token}\n`);
  await cliRun(root, ['spaces', 'select', '--space', spaceId]);
  const space = `/v1/spaces/${encodeURIComponent(spaceId)}`;
  return {
    search: async request => ({ http: await api('POST', `${space}/search`, request), mcp: await mcp('retrieval_search', request),
      cli: await cliRun(root, ['retrieval', 'search', '--data', JSON.stringify(request)]) }),
    bundle: async request => ({ http: await api('POST', `${space}/bundles`, request), mcp: await mcp('retrieval_bundle', request),
      cli: await cliRun(root, ['retrieval', 'bundle', '--data', JSON.stringify(request)]) }),
    status: async collectionId => ({ http: await api('GET', `${space}/collections/${collectionId}/projections`),
      mcp: await mcp('retrieval_status', { collectionId }), cli: await cliRun(root, ['retrieval', 'status', '--collection', collectionId]) })
  };
}

/**
 * The outcome a transport gave, comparable across transports: the error code and retryability, or what was
 * returned (Refs in rank order for a search, the framed context for a bundle, the state and generations for status).
 */
function outcome(operation, value) {
  if (value.error) return { error: value.error.code, retryable: value.error.retryable };
  if (operation === 'search') return { refs: value.results.map(hit => `${hit.ref.collectionId}/${hit.ref.kind}/${hit.ref.id}@${hit.revision}`),
    mode: value.mode, state: value.state, complete: value.complete };
  if (operation === 'bundle') return { context: value.context, complete: value.complete, trust: value.trust };
  return { state: value.state, generations: value.generations.map(entry => `${entry.generation}:${entry.state}`) };
}
const schemaOf = { search: 'SearchResult', bundle: 'ContextBundle', status: 'ProjectionStatus' };
/** Run one operation over the three transports, require one outcome, check the HTTP body against OpenAPI, and return it. */
async function same(label, operation, results) {
  const outcomes = Object.fromEntries(Object.entries(results).map(([transport, value]) => [transport, outcome(operation, value)]));
  assert.deepEqual(outcomes.mcp, outcomes.http, `${label}: MCP matches HTTP`);
  assert.deepEqual(outcomes.cli, outcomes.http, `${label}: CLI matches HTTP`);
  if (!results.http.error) conforms(schemaOf[operation], results.http);
  // The CLI prints the HTTP body; only the reread's database time differs between two calls.
  const timeless = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'verifiedAt' ? undefined : item));
  if (!results.http.error && operation !== 'search') assert.deepEqual(timeless(results.cli), timeless(results.http), `${label}: CLI prints the HTTP body`);
  return outcomes.http;
}

test('HTTP, CLI and MCP give one authorization outcome for search, bundles and projection status', async t => {
  const f = await fixture();
  const kept = await f.record('alpha', { title: 'beacon harbor log', note: 'The harbor beacon was relit at dusk.' });
  const sourceId = await f.source('alpha', 'Keeper notes: the beacon lens was cleaned.');
  const claim = await claims.create(f.owner, f.spaceId, 'alpha', { idempotencyKey: 'c1', statement: 'The beacon is visible from the cape.',
    attributedTo: 'Survey' });
  const betaRecord = await f.record('beta', { title: 'beacon tower survey' });
  await index();

  const origin = await host(t);
  const temp = await mkdtemp(join(tmpdir(), 'stateplane-sta49-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const issue = async grants => (await spaces.issueAgentKey(f.owner, f.spaceId, new Date(Date.now() + 3_600_000),
    grants.map(([collectionId, capabilities]) => ({ collectionId, capabilities }))));
  const reader = await issue([['alpha', ['records:read', 'sources:read', 'claims:read']]]);
  const claimsOnly = await issue([['alpha', ['claims:read']]]);
  const betaOnly = await issue([['beta', ['records:read']]]);
  const writeOnly = await issue([['alpha', ['records:write']]]);
  const revoked = await issue([['alpha', ['records:read']]]);
  const foreign = await fixture();
  const as = (token, name) => caller(t, origin, temp, token, name, f.spaceId);
  const callers = {
    owner: await as(f.ownerToken, 'owner'), reader: await as(reader.secret, 'reader'), claimsOnly: await as(claimsOnly.secret, 'claims'),
    betaOnly: await as(betaOnly.secret, 'beta'), writeOnly: await as(writeOnly.secret, 'write'), revoked: await as(revoked.secret, 'revoked'),
    foreignOwner: await as(foreign.ownerToken, 'foreign'), unknown: await as('not-a-credential', 'unknown')
  };
  await spaces.revokeAgentKey(f.owner, f.spaceId, revoked.id);

  const budget = { bytes: 4096 };
  const operations = [
    ['search', { query: 'beacon' }],
    ['search', { query: 'beacon', collections: ['alpha'], kinds: ['record', 'claim'] }],
    ['search', { query: 'beacon', collections: ['beta'] }],
    ['search', { query: 'beacon', unexpected: true }],
    ['bundle', { query: 'beacon', budget }],
    ['bundle', { task: 'Summarize the beacon notes', collections: ['alpha'], budget }],
    ['bundle', { task: 'How many beacons are there?', budget }],
    ['status', 'alpha']
  ];
  const seen = {};
  for (const [name, transport] of Object.entries(callers)) {
    for (const [operation, request] of operations) {
      const label = `${name} ${operation} ${JSON.stringify(request)}`;
      seen[label] = await same(label, operation, await transport[operation](request));
    }
  }
  const at = (name, index) => seen[`${name} ${operations[index][0]} ${JSON.stringify(operations[index][1])}`];
  const ref = (collection, kind, id, revision = 1) => `${collection}/${kind}/${id}@${revision}`;
  const sorted = value => [...value].sort();

  // The outcomes themselves, so agreement is not agreement on a failure.
  assert.deepEqual(sorted(at('owner', 0).refs), sorted([ref('alpha', 'record', kept), ref('alpha', 'source', sourceId),
    ref('alpha', 'claim', claim.claimId), ref('beta', 'record', betaRecord)]));
  assert.deepEqual([at('owner', 0).mode, at('owner', 0).complete], ['hybrid', false]);
  assert.deepEqual(sorted(at('owner', 1).refs), sorted([ref('alpha', 'record', kept), ref('alpha', 'claim', claim.claimId)]));
  assert.deepEqual(sorted(at('reader', 0).refs), sorted([ref('alpha', 'record', kept), ref('alpha', 'source', sourceId),
    ref('alpha', 'claim', claim.claimId)]), 'a key reads only its granted collection');
  assert.deepEqual(at('claimsOnly', 0).refs, [ref('alpha', 'claim', claim.claimId)], 'and only its granted kinds');
  assert.deepEqual(at('betaOnly', 0).refs, [ref('beta', 'record', betaRecord)]);
  assert.deepEqual(at('betaOnly', 1).error, 'NOT_FOUND', 'an unreadable listed collection is NOT_FOUND');
  assert.deepEqual(at('reader', 2).error, 'NOT_FOUND');
  assert.deepEqual(at('writeOnly', 0).error, 'FORBIDDEN', 'a key that can read no kind is FORBIDDEN');
  assert.deepEqual(at('owner', 3).error, 'INVALID_ARGUMENT', 'an unknown field is refused after admission');
  assert.deepEqual(at('foreignOwner', 3).error, 'NOT_FOUND', 'admission precedes validation');
  for (const name of ['revoked', 'unknown']) for (let i = 0; i < operations.length; i++)
    assert.equal(at(name, i).error, 'UNAUTHENTICATED', `${name} ${i}`);
  for (let i = 0; i < 6; i++) assert.equal(at('foreignOwner', i).error, 'NOT_FOUND', `foreign ${i}`);
  assert.match(at('owner', 4).context, /^<stateplane-context trust="untrusted" complete="false">/);
  assert.match(at('reader', 5).context, new RegExp(`id="${kept}"`));
  assert.doesNotMatch(at('betaOnly', 4).context, new RegExp(`id="${kept}"`), 'a bundle quotes only what its search authorized');
  // A count question is refused before admission, so every authenticated caller, whatever its access, gets INVALID_ARGUMENT.
  for (const name of ['owner', 'reader', 'betaOnly', 'writeOnly', 'foreignOwner']) assert.equal(at(name, 6).error, 'INVALID_ARGUMENT', name);
  assert.deepEqual(at('owner', 7), { state: 'current', generations: ['1:active'] });
  for (const name of ['reader', 'claimsOnly', 'betaOnly', 'writeOnly']) assert.equal(at(name, 7).error, 'FORBIDDEN', `${name} status`);
  assert.equal(at('foreignOwner', 7).error, 'NOT_FOUND');

  // A host composed without embedders, as every deployed host is until a provider is qualified, answers lexically and says so.
  const unconfigured = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600);
  const lexical = conforms('SearchResult', await unconfigured.retrieval.search(f.owner, f.spaceId, { query: 'beacon', collections: ['alpha'] }));
  assert.deepEqual([lexical.mode, lexical.state, lexical.collections[0].vector, lexical.collections[0].vectorError],
    ['lexical', 'degraded', 'unavailable', 'EMBEDDER_NOT_CONFIGURED']);
  assert.ok(lexical.results.length > 0, 'the lexical list still answers');
  const status = conforms('ProjectionStatus', await unconfigured.retrieval.status(f.owner, f.spaceId, 'alpha'));
  assert.deepEqual([status.state, status.generations[0].embedderAvailable], ['degraded', false]);

  // A revocation committed after a caller's first search fails its next one on every transport.
  await spaces.revokeAgentKey(f.owner, f.spaceId, reader.id);
  assert.equal((await same('revoked reader', 'search', await callers.reader.search({ query: 'beacon' }))).error, 'UNAUTHENTICATED');
  // A deleted collection is gone for its owner's status too.
  await pool.query(`UPDATE collections SET lifecycle='deleted' WHERE space_id=$1 AND collection_id='beta'`, [f.spaceId]);
  assert.equal((await same('deleted collection status', 'status', await callers.owner.status('beta'))).error, 'NOT_FOUND');
});

test('projection status shows a rebuild in progress on every transport and refuses a suspension committed during its reads', async t => {
  const f = await fixture();
  await f.record('alpha', { title: 'beacon harbor log', note: 'The harbor beacon was relit at dusk.' });
  await index();
  const generations = new PostgresProjectionGenerations(pool, { embedders: registry });
  await generations.start(f.spaceId, 'alpha');
  // One step backfills and verifies this single record; the generation then waits, verifying, for activation.
  await generations.step();
  const origin = await host(t);
  const temp = await mkdtemp(join(tmpdir(), 'stateplane-sta49-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const owner = await caller(t, origin, temp, f.ownerToken, 'owner', f.spaceId);
  const results = await owner.status('alpha');
  assert.deepEqual(await same('rebuilding status', 'status', results), { state: results.http.state, generations: ['1:active', '2:verifying'] });
  const { rebuild } = results.http;
  assert.deepEqual([rebuild.generation, rebuild.state, rebuild.rebuild.phase, rebuild.rebuild.backfilled, rebuild.rebuild.verified],
    [2, 'verifying', 'verified', 1, 1], JSON.stringify(rebuild));
  assert.ok(rebuild.rebuild.cursor !== null && rebuild.rebuild.verifiedAt !== null, JSON.stringify(rebuild));

  // A suspension that commits after the leading fence, while the generations are read, refuses the answer.
  let hooks = [{ match: 'FROM projection_generations g LEFT JOIN projection_rebuilds',
    run: () => pool.query(`UPDATE spaces SET lifecycle='suspended' WHERE space_id=$1`, [f.spaceId]) }];
  const hooked = postgresServices(spaces, new Map([['cell-a', { pool: hookedPool(pool, () => hooks, used => { hooks = hooks.filter(hook => hook !== used); }),
    cursorSecret: randomBytes(32) }]]), 3600, { embedders: registry });
  await assert.rejects(hooked.retrieval.status(f.owner, f.spaceId, 'alpha'), error => { assert.equal(error.code, 'SPACE_UNAVAILABLE', error.message); return true; });
  assert.equal(hooks.length, 0, 'the suspension ran between the reads');
});

const REBUILDS = 'FROM projection_generations g LEFT JOIN projection_rebuilds';
const CHECK_SCOPE = 'c.lifecycle AS collection_lifecycle';
const statusOver = cellPool => {
  const { retrieval } = postgresServices(spaces, new Map([['cell-a', { pool: cellPool, cursorSecret: randomBytes(32) }]]), 3600,
    { embedders: registry });
  return (...args) => retrieval.status(...args);
};

test('projection status reads its generations and rebuild in one snapshot while generations change between its reads', async () => {
  const f = await fixture();
  await f.record('alpha', { title: 'beacon harbor log', note: 'The harbor beacon was relit at dusk.' });
  await index();
  const generations = new PostgresProjectionGenerations(pool, { embedders: registry });
  await generations.start(f.spaceId, 'alpha');
  await generations.step();
  let hooks = [];
  const status = statusOver(hookedPool(pool, () => hooks, used => { hooks = hooks.filter(hook => hook !== used); }));
  // An activation, then a new rebuild, commits after the status's first read and before its rebuild read.
  for (const [change, run] of [['activation', () => generations.activate(f.spaceId, 'alpha', 2)],
    ['rebuild start', () => generations.start(f.spaceId, 'alpha')]]) {
    hooks = [{ match: REBUILDS, run }];
    const view = await status(f.owner, f.spaceId, 'alpha');
    assert.equal(hooks.length, 0, `${change} ran between the reads`);
    const pending = view.generations.filter(entry => entry.state === 'building' || entry.state === 'verifying');
    assert.deepEqual(view.rebuild ? [[view.rebuild.generation, view.rebuild.state]] : [],
      pending.map(entry => [entry.generation, entry.state]), `${change}: rebuild and generations agree ${JSON.stringify(view)}`);
  }
});

test('projection status refuses a session that expired before its trailing fence committed', async () => {
  const f = await fixture();
  await index();
  const sessionExpiry = expiresAt => config.database.update({ model: 'sessions', where: [{ field: 'id', operator: 'eq',
    value: f.owner.credentialId }], data: { expiresAt }, namespace: config.namespace });
  let hooks = [];
  const status = statusOver(hookedPool(pool, () => hooks, used => { hooks = hooks.filter(hook => hook !== used); }));
  const now = Date.now;
  // The session lasts 2 s more when the trailing fence checks it, and the clock passes that just before its COMMIT.
  hooks = [{ match: REBUILDS, run: async () => {
    await sessionExpiry(new Date(Date.now() + 2_000));
    hooks.push({ match: CHECK_SCOPE, run: async () => { hooks.push({ match: 'COMMIT', run: async () => { Date.now = () => now() + 5_000; } }); } });
  } }];
  try {
    await assert.rejects(status(f.owner, f.spaceId, 'alpha'), error => { assert.equal(error.code, 'FORBIDDEN', error.message); return true; });
  } finally { Date.now = now; }
  assert.equal(hooks.length, 0, 'the clock stepped just before the trailing COMMIT');
  // The same expiry without the step still answers, and so does a session that lasts an hour.
  hooks = [{ match: REBUILDS, run: () => sessionExpiry(new Date(Date.now() + 2_000)) }];
  assert.equal((await status(f.owner, f.spaceId, 'alpha')).collectionId, 'alpha');
  assert.equal(hooks.length, 0);
  await sessionExpiry(new Date(Date.now() + 3_600_000));
  assert.equal((await status(f.owner, f.spaceId, 'alpha')).collectionId, 'alpha');
});

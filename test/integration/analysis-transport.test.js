import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { McpFnTestClient, authenticatedHttpTarget } from '@mcpfn/testing';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createAuthFn, createUser, issueSession } from '@authfn/core';
import { AuthFnAgentKeys, AuthFnIdentityVerifier } from '../../packages/auth/dist/index.js';
import { PostgresAnalysisWorker, PostgresSpaces, postgresServices } from '../../packages/postgres/dist/index.js';
import { createHttpHandler } from '../../packages/api/dist/index.js';
import { createMcpHandler } from '../../packages/mcp/dist/index.js';

// STA-61: interactive aggregations and snapshot jobs over HTTP, the CLI (which speaks HTTP) and MCP, through one
// composition of the real services on PostgreSQL 17. Every operation runs on all three transports for every caller,
// and each must give the same outcome: the same result, or the same error code and retryability. The suite owns its
// database.
const root = fileURLToPath(new URL('../..', import.meta.url));
const password = process.env.DATABASE_URL ? null : (await readFile(new URL('../../.data/local-db-password', import.meta.url), 'utf8')).trim();
const baseUrl = process.env.DATABASE_URL ?? `postgres://stateplane:${encodeURIComponent(password)}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane`;
const name = `stateplane_analysis_transport_${randomUUID().replaceAll('-', '')}`;
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
const analyticalPool = new pg.Pool({ connectionString: url, max: 1 });
const workerPool = new pg.Pool({ connectionString: url, max: 1 });
test.after(async () => { await Promise.all([pool, analyticalPool, workerPool].map(item => item.end())); await admin(`DROP DATABASE IF EXISTS ${name}`); });

const config = { database: memoryAdapter(), namespace: `analysis-transport-${randomUUID()}`, plugins: [] };
createAuthFn(config);
const identity = new AuthFnIdentityVerifier(config);
const spaces = new PostgresSpaces(pool, new Map([['cell-a', { pool, storageTargetId: 'target-a' }]]), 'cell-a',
  new AuthFnAgentKeys(config), identity, randomBytes(32));
// The deployed composition: aggregations on an analytical pool of their own, at the smallest origin connection limit.
const services = postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32),
  analytics: { pool: analyticalPool, originConnectionLimit: 5 } }]]), 3600);
const verify = token => identity.verify(new Request('https://h.invalid', { headers: { authorization: `Bearer ${token}` } }));
/** Run jobs Worker steps until no job is left to claim, as successive ticks would. */
async function drain() {
  const jobs = new PostgresAnalysisWorker(workerPool, { originConnectionLimit: 5 });
  for (let i = 0; i < 50; i++) if (!(await jobs.step({ budgetMs: 10_000 })).claimed) return;
  throw new Error('jobs did not finish');
}

const openapi = YAML.parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat('date-time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
ajv.addSchema({ $id: 'openapi', components: openapi.components });
function conforms(schema, value) {
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  assert.ok(validate(value), `conforms to OpenAPI ${schema}: ${JSON.stringify(validate.errors)}`);
  return value;
}

const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {
  team: { type: ['string', 'null'] }, score: { type: ['number', 'null'] }, at: { type: 'string', format: 'date-time' },
  note: { type: 'string' } } };
async function fixture() {
  const user = await createUser(config, { primaryEmail: `owner-${randomUUID()}@example.invalid` });
  const ownerToken = (await issueSession(config, {}, { userId: user.id, methods: ['password'] })).sessionToken;
  const owner = await verify(ownerToken);
  const spaceId = `sp_${randomUUID()}`;
  await spaces.create(owner, 'cell-a', spaceId);
  await services.collections.define(owner, spaceId, 'items', JSON.stringify({ slug: 'items', version: 1, schema, unique: [],
    filterable: ['team', 'score', 'at'], sortable: [] }));
  for (const field of ['team', 'score', 'at']) await services.collections.backfill(owner, spaceId, 'items', field);
  const write = async data => (await services.records.mutate(owner, spaceId, 'items',
    JSON.stringify({ operation: 'create', idempotencyKey: randomUUID(), data }))).ref.id;
  const issue = async capabilities => spaces.issueAgentKey(owner, spaceId, new Date(Date.now() + 3_600_000),
    [{ collectionId: 'items', capabilities }]);
  return { spaceId, owner, ownerToken, write, issue };
}

async function host(t, composed) {
  const http = createHttpHandler({ services: composed, identity });
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
  holder.mcp = createMcpHandler({ services: composed, identity, resource: `${origin}/mcp`, authorizationServers: ['http://127.0.0.1:9/'],
    allowInsecureLoopback: true });
  return origin;
}
async function cliRun(home, argv, input = '') {
  const child = spawn(process.execPath, ['packages/cli/bin/stateplane.js', ...argv], {
    cwd: root, env: { ...process.env, STATEPLANE_CONFIG_DIR: home, STATEPLANE_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [status] = await once(child, 'close');
  return status === 0 ? JSON.parse(stdout) : JSON.parse(stderr);
}

/** One caller on all three transports; each call returns the JSON body (with its HTTP status) or `{ error }`. */
async function caller(t, origin, temp, token, label, spaceId) {
  let lastStatus = null;
  const api = async (method, path, body) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`,
      ...(text === undefined ? {} : { 'content-type': 'application/json' }) }, body: text });
    lastStatus = response.status;
    return response.json();
  };
  let client = null;
  // MCP is an OAuth protected resource: a credential that does not verify is refused with HTTP 401 before any tool runs.
  const unauthenticated = error => {
    if (error?.code !== 401 && error?.cause?.code !== 401) throw error;
    return { error: { code: 'UNAUTHENTICATED', retryable: false } };
  };
  const mcp = async (tool, args) => {
    try {
      if (!client) {
        client = await McpFnTestClient.connectTarget(authenticatedHttpTarget(`${origin}/mcp`, { credential: { kind: 'api-key',
          headers: { authorization: `Bearer ${token}` } } }), { name: 'sta61', version: '1.0.0' });
        const connected = client;
        t.after(() => connected.close());
      }
      const result = await client.callTool(tool, { spaceId, collectionId: 'items', ...args });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${tool} structured/text parity`);
      return result.structuredContent;
    } catch (error) { return unauthenticated(error); }
  };
  const home = join(temp, label);
  await cliRun(home, ['config', 'endpoint', '--url', `${origin}/`]);
  await cliRun(home, ['auth', 'import', '--token-stdin', '--store', 'file'], `${token}\n`);
  await cliRun(home, ['spaces', 'select', '--space', spaceId]);
  const cli = argv => cliRun(home, ['analysis', ...argv, '--collection', 'items']);
  const collection = `/v1/spaces/${encodeURIComponent(spaceId)}/collections/items`;
  const job = id => `${collection}/jobs/${encodeURIComponent(id)}`;
  return {
    status: () => lastStatus,
    aggregate: async spec => ({ http: await api('POST', `${collection}/aggregate`, spec), mcp: await mcp('analysis_aggregate', spec),
      cli: await cli(['aggregate', '--data', JSON.stringify(spec)]) }),
    // A spec as JSON text, so a literal such as 1e400 reaches each transport as written: the raw HTTP body, raw MCP
    // JSON-RPC (a client would re-encode it as null; skipped for text that is not JSON) and the CLI's --data and --file.
    literal: async (kind, text, viaMcp = true) => {
      const file = join(home, 'literal.json');
      await writeFile(file, text);
      const scope = `"spaceId":${JSON.stringify(spaceId)},"collectionId":"items"`;
      const args = kind ? `{${scope},"kind":${JSON.stringify(kind)},"spec":${text}}` : `{${scope},${text.slice(1)}`;
      const rpc = viaMcp && await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${kind ? 'analysis_submit' : 'analysis_aggregate'}","arguments":${args}}}` });
      const argv = kind ? ['submit', '--kind', kind] : ['aggregate'];
      return { http: kind ? await api('POST', `${collection}/jobs`, `{"kind":${JSON.stringify(kind)},"spec":${text}}`)
        : await api('POST', `${collection}/aggregate`, text), ...(rpc ? { mcp: (await rpc.json()).result.structuredContent } : {}),
      cli: await cli([...argv, '--data', text]), cliFile: await cli([...argv, '--file', file]) };
    },
    // The CLI sends {kind} or {kind, spec}; a request it cannot express is compared over HTTP and MCP only. `encode` writes
    // the HTTP body and the CLI's --data as sent; MCP's arguments are objects.
    submit: async (request, viaCli = true, encode = value => JSON.stringify(value)) => ({
      http: await api('POST', `${collection}/jobs`, encode(request)), mcp: await mcp('analysis_submit', request),
      ...(viaCli ? { cli: await cli(['submit', '--kind', request.kind,
        ...(Object.hasOwn(request, 'spec') ? ['--data', encode(request.spec)] : [])]) } : {}) }),
    jobStatus: async id => ({ http: await api('GET', job(id)), mcp: await mcp('analysis_status', { jobId: id }),
      cli: await cli(['status', '--job', id]) }),
    cancel: async id => ({ http: await api('DELETE', job(id)), mcp: await mcp('analysis_cancel', { jobId: id }),
      cli: await cli(['cancel', '--job', id]) }),
    page: async (id, n) => ({ http: await api('GET', `${job(id)}/pages/${encodeURIComponent(String(n))}`),
      mcp: await mcp('analysis_page', { jobId: id, page: n }), cli: await cli(['page', '--job', id, '--page', String(n)]) })
  };
}

/** A value without the times its read took, which differ between two reads of the same state. */
const timeless = value => JSON.parse(JSON.stringify(value, (key, item) => ['takenAt', 'checkedAt'].includes(key) ? undefined : item));
/** What a transport gave, comparable across transports: the error code and retryability, or the result itself. */
const outcome = value => value.error ? { error: value.error.code, retryable: value.error.retryable } : timeless(value);
/** Require one outcome from every transport, check the HTTP body against OpenAPI, and return it. */
function same(label, results, schemaName, comparable = outcome) {
  const outcomes = Object.fromEntries(Object.entries(results).map(([transport, value]) => [transport, comparable(value)]));
  for (const transport of ['mcp', 'cli', 'cliFile']) if (transport in outcomes)
    assert.deepEqual(outcomes[transport], outcomes.http, `${label}: ${transport} matches HTTP`);
  if (!results.http.error) conforms(schemaName, results.http);
  return outcomes.http;
}

test('HTTP, CLI and MCP give one outcome for every aggregation, caller and refusal', async t => {
  const f = await fixture();
  const at = hour => new Date(Date.UTC(2026, 2, 8, hour)).toISOString();
  for (const [team, score, hour] of [['red', 0.1, 1], ['red', 0.2, 2], ['blue', 3, 3], [null, 4, 4]])
    await f.write({ team, score, at: at(hour), note: 'n' });
  await f.write({ score: 5, at: at(30), note: 'no team' });
  const origin = await host(t, services);
  const temp = await mkdtemp(join(tmpdir(), 'stateplane-sta61-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const reader = await f.issue(['records:read']);
  const exporter = await f.issue(['export:read']);
  const writer = await f.issue(['records:write']);
  const revoked = await f.issue(['records:read']);
  const foreign = await fixture();
  const as = (token, label) => caller(t, origin, temp, token, label, f.spaceId);
  const callers = { owner: await as(f.ownerToken, 'owner'), reader: await as(reader.secret, 'reader'),
    exporter: await as(exporter.secret, 'exporter'), writer: await as(writer.secret, 'writer'), revoked: await as(revoked.secret, 'revoked'),
    foreignOwner: await as(foreign.ownerToken, 'foreign'), unknown: await as('not-a-credential', 'unknown') };
  await spaces.revokeAgentKey(f.owner, f.spaceId, revoked.id);

  const grouped = { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }, { op: 'max', field: 'at' }] };
  const specs = [
    grouped,
    { where: [{ field: 'score', kind: 'number', operator: 'gte', value: 3 }],
      groupBy: [{ field: 'at', bucket: { unit: 'day', timeZone: 'America/New_York' } }], metrics: [{ op: 'avg', field: 'score' }] },
    { metrics: [] },
    { metrics: [{ op: 'count' }], unexpected: true },
    { groupBy: [{ field: 'note' }], metrics: [{ op: 'count' }] },
    { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }], maxGroups: 2 },
    // Past the 32 KiB body budget on every transport.
    { metrics: [{ op: 'count' }], where: Array.from({ length: 16 }, () => ({ field: 'team', kind: 'string', operator: 'in',
      value: Array.from({ length: 16 }, () => 'x'.repeat(200)) })) }
  ];
  const seen = {};
  // HTTP and MCP measure a body after authentication; the CLI refuses an oversized one before it sends anything, so the
  // oversized spec is compared for authenticated callers only.
  for (const [label, transport] of Object.entries(callers))
    for (let i = 0; i < specs.length - (['revoked', 'unknown'].includes(label) ? 1 : 0); i++)
      seen[`${label} ${i}`] = same(`${label} aggregate ${i}`, await transport.aggregate(specs[i]), 'AggregationResult');

  // The outcomes themselves, so agreement is not agreement on a failure.
  const groups = seen['owner 0'].groups.map(group => [group.key[0], group.count, group.metrics[1].value]);
  assert.deepEqual(groups, [[{ kind: 'value', value: 'blue' }, 1, '3'], [{ kind: 'value', value: 'red' }, 2, '0.3'],
    [{ kind: 'null' }, 1, '4'], [{ kind: 'missing' }, 1, '5']]);
  assert.deepEqual(seen['reader 0'], seen['owner 0'], 'a key with records:read reads the same groups');
  assert.deepEqual(seen['owner 1'].groups.map(group => [group.key[0].local, group.metrics[0].value]),
    [['2026-03-07T00:00:00-05:00', '3.5'], ['2026-03-09T00:00:00-04:00', '5']]);
  for (const label of ['owner', 'reader']) {
    assert.deepEqual(seen[`${label} 2`], { error: 'INVALID_ARGUMENT', retryable: false });
    assert.deepEqual(seen[`${label} 3`], { error: 'INVALID_ARGUMENT', retryable: false }, 'an unknown spec field is refused after admission');
    assert.deepEqual(seen[`${label} 4`], { error: 'SCHEMA_CONFLICT', retryable: false });
    assert.deepEqual(seen[`${label} 5`], { error: 'RATE_LIMITED', retryable: false }, 'no partial groups past maxGroups');
  }
  // Admission precedes validation: a caller without records:read, or without the space, never learns about the spec.
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(seen[`exporter ${i}`], { error: 'FORBIDDEN', retryable: false }, `exporter ${i}`);
    assert.deepEqual(seen[`writer ${i}`], { error: 'FORBIDDEN', retryable: false }, `writer ${i}`);
    assert.deepEqual(seen[`foreignOwner ${i}`], { error: 'NOT_FOUND', retryable: false }, `foreign ${i}`);
  }
  for (const label of ['revoked', 'unknown']) for (let i = 0; i < 6; i++)
    assert.deepEqual(seen[`${label} ${i}`], { error: 'UNAUTHENTICATED', retryable: false }, `${label} ${i}`);
  for (const label of ['owner', 'reader', 'exporter', 'writer', 'foreignOwner'])
    assert.deepEqual(seen[`${label} 6`], { error: 'RATE_LIMITED', retryable: false }, `${label} oversized spec`);

  // A host composed without analytical capacity authorizes first, then refuses without borrowing the interactive pool.
  const bare = await host(t, postgresServices(spaces, new Map([['cell-a', { pool, cursorSecret: randomBytes(32) }]]), 3600));
  const unprovisioned = await caller(t, bare, temp, f.ownerToken, 'owner-bare', f.spaceId);
  assert.deepEqual(same('no analytics', await unprovisioned.aggregate(grouped), 'AggregationResult'),
    { error: 'PROVIDER_UNAVAILABLE', retryable: false });
  assert.deepEqual(same('no analytics, malformed', await unprovisioned.aggregate(specs[2]), 'AggregationResult'),
    { error: 'INVALID_ARGUMENT', retryable: false });
  const foreignBare = await caller(t, bare, temp, foreign.ownerToken, 'foreign-bare', f.spaceId);
  assert.deepEqual(same('no analytics, foreign', await foreignBare.aggregate(grouped), 'AggregationResult'),
    { error: 'NOT_FOUND', retryable: false });
});

test('HTTP, CLI and MCP give one outcome for job submission, status, pages and cancellation', async t => {
  const f = await fixture();
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const written = new Map();
  for (const [team, score] of [['red', 1], ['blue', 2], ['red', 3]]) {
    const data = { team, score, at, note: `${team} ${score}` };
    written.set(await f.write(data), data);
  }
  const origin = await host(t, services);
  const temp = await mkdtemp(join(tmpdir(), 'stateplane-sta61-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const exporter = await f.issue(['export:read']);
  const other = await f.issue(['export:read', 'records:read']);
  const reader = await f.issue(['records:read']);
  const foreign = await fixture();
  const as = (token, label) => caller(t, origin, temp, token, label, f.spaceId);
  const owner = await as(f.ownerToken, 'owner');
  const callers = { owner, exporter: await as(exporter.secret, 'exporter'), other: await as(other.secret, 'other'),
    reader: await as(reader.secret, 'reader'), foreignOwner: await as(foreign.ownerToken, 'foreign'),
    unknown: await as('not-a-credential', 'unknown') };

  // Submission: each transport queues its own job, at the same watermark with the same boundary.
  const aggregate = { groupBy: [{ field: 'team' }], metrics: [{ op: 'count' }, { op: 'sum', field: 'score' }] };
  const queued = Object.values(await owner.submit({ kind: 'export' }));
  assert.equal(owner.status(), 202, 'a submission is accepted for later work');
  assert.equal(new Set(queued.map(status => status.jobId)).size, 3);
  const comparableJob = value => value.error ? outcome(value) : timeless({ ...value, jobId: undefined, createdAt: undefined, expiresAt: undefined });
  same('export submission', { http: queued[0], mcp: queued[1], cli: queued[2] }, 'AnalysisJobStatus', comparableJob);
  assert.deepEqual([queued[0].kind, queued[0].state, queued[0].complete, queued[0].boundary.capability, queued[0].freshness.state],
    ['export', 'queued', false, 'export:read', 'exact']);
  const exportJob = queued[0].jobId;

  const refusals = [
    ['exporter', { kind: 'aggregate', spec: aggregate }, 'FORBIDDEN'],
    ['reader', { kind: 'export' }, 'FORBIDDEN'],
    ['foreignOwner', { kind: 'export' }, 'NOT_FOUND'],
    ['foreignOwner', { kind: 'aggregate', spec: { metrics: [] } }, 'NOT_FOUND'],
    ['unknown', { kind: 'export' }, 'UNAUTHENTICATED'],
    ['owner', { kind: 'aggregate', spec: { metrics: [] } }, 'INVALID_ARGUMENT'],
    ['owner', { kind: 'aggregate' }, 'INVALID_ARGUMENT'],
    ['owner', { kind: 'export', spec: aggregate }, 'INVALID_ARGUMENT'],
    ['owner', { kind: 'aggregate', spec: { groupBy: [{ field: 'note' }], metrics: [{ op: 'count' }] } }, 'SCHEMA_CONFLICT'],
    ['owner', { kind: 'snapshot' }, 'INVALID_ARGUMENT']
  ];
  for (const [label, request, code] of refusals)
    assert.deepEqual(same(`${label} submit ${JSON.stringify(request)}`, await callers[label].submit(request), 'AnalysisJobStatus', comparableJob),
      { error: code, retryable: false }, `${label} ${JSON.stringify(request)}`);
  // A spec over the 32,768-byte spec bound but inside a job request's 33,792-byte envelope: alone or in an aggregate
  // job, every transport refuses it RATE_LIMITED (HTTP 429, not retryable) for every authenticated caller.
  const oversized = { metrics: [{ op: 'count' }], where: [{ field: 'team', kind: 'string', operator: 'in',
    value: Array.from({ length: 162 }, () => 'x'.repeat(200)) }] };
  const specBytes = Buffer.byteLength(JSON.stringify(oversized));
  assert.ok(specBytes > 32_768 && Buffer.byteLength(JSON.stringify({ kind: 'aggregate', spec: oversized })) <= 33_700, `${specBytes}`);
  for (const label of ['owner', 'reader', 'exporter', 'foreignOwner']) {
    assert.deepEqual(same(`${label} oversized aggregation`, await callers[label].aggregate(oversized), 'AggregationResult'),
      { error: 'RATE_LIMITED', retryable: false }, `${label} oversized aggregation`);
    assert.equal(callers[label].status(), 429);
    assert.deepEqual(same(`${label} oversized job`, await callers[label].submit({ kind: 'aggregate', spec: oversized }), 'AnalysisJobStatus',
      comparableJob), { error: 'RATE_LIMITED', retryable: false }, `${label} oversized aggregate job`);
    assert.equal(callers[label].status(), 429);
  }
  // The size is checked before the spec's shape: an oversized array or string is RATE_LIMITED too, for either kind.
  for (const spec of [['x'.repeat(32_950)], 'x'.repeat(32_950)]) for (const kind of ['aggregate', 'export'])
    assert.deepEqual(same(`oversized ${Array.isArray(spec) ? 'array' : 'string'} ${kind}`, await owner.submit({ kind, spec }),
      'AnalysisJobStatus', comparableJob), { error: 'RATE_LIMITED', retryable: false });
  // The kind is checked before the spec's size, on every transport.
  assert.deepEqual(same('unknown kind, oversized spec', await owner.submit({ kind: 'snapshot', spec: oversized }), 'AnalysisJobStatus',
    comparableJob), { error: 'INVALID_ARGUMENT', retryable: false });
  // The CLI refuses it before sending anything: its endpoint here has nothing listening.
  const offline = join(temp, 'offline');
  await cliRun(offline, ['config', 'endpoint', '--url', 'http://127.0.0.1:9/']);
  await cliRun(offline, ['auth', 'import', '--token-stdin', '--store', 'file'], `${f.ownerToken}\n`);
  await cliRun(offline, ['spaces', 'select', '--space', f.spaceId]);
  for (const argv of [['aggregate'], ['submit', '--kind', 'aggregate']])
    assert.deepEqual(outcome(await cliRun(offline, ['analysis', ...argv, '--collection', 'items', '--data', JSON.stringify(oversized)])),
      { error: 'RATE_LIMITED', retryable: false }, `the CLI refuses an oversized spec to ${argv[0]} locally`);

  // Sizes come before the spec's values: an oversized spec holding 1e400 is RATE_LIMITED too, on every transport and
  // from an offline CLI, and one within the budget is INVALID_ARGUMENT before admission for every caller, never sent
  // on as null (JSON's re-encoding of the Infinity it parses as). No job is queued for any of them.
  const infinite = value => JSON.stringify(value).replace('"value":"INFINITE"', '"value":1e400');
  const overflowing = infinite({ ...oversized, where: [{ field: 'score', kind: 'number', operator: 'gte', value: 'INFINITE' },
    ...oversized.where] });
  const finiteBytes = Buffer.byteLength(overflowing.replace('1e400', 'null'));
  assert.ok(overflowing.includes('1e400') && finiteBytes > 32_768 && Buffer.byteLength(`{"kind":"aggregate","spec":${overflowing}}`) <= 33_700,
    `${finiteBytes}`);
  const small = infinite({ metrics: [{ op: 'count' }], where: [{ field: 'score', kind: 'number', operator: 'gte', value: 'INFINITE' }] });
  const jobsBefore = (await pool.query('SELECT count(*)::int AS n FROM analysis_jobs WHERE space_id=$1', [f.spaceId])).rows[0].n;
  for (const label of ['owner', 'reader', 'exporter', 'foreignOwner']) for (const kind of [undefined, 'aggregate']) {
    const operation = kind ? 'aggregate job' : 'aggregation';
    const schemaName = kind ? 'AnalysisJobStatus' : 'AggregationResult';
    assert.deepEqual(same(`${label} oversized 1e400 ${operation}`, await callers[label].literal(kind, overflowing), schemaName),
      { error: 'RATE_LIMITED', retryable: false }, `${label} oversized 1e400 ${operation}`);
    assert.equal(callers[label].status(), 429);
    assert.deepEqual(same(`${label} 1e400 ${operation}`, await callers[label].literal(kind, small), schemaName),
      { error: 'INVALID_ARGUMENT', retryable: false }, `${label} 1e400 ${operation}`);
  }
  // A spec that is not an object is refused before admission as well: a foreign owner learns no more than the CLI says.
  assert.deepEqual(same('foreign array spec', await callers.foreignOwner.submit({ kind: 'aggregate', spec: [1] }), 'AnalysisJobStatus',
    comparableJob), { error: 'INVALID_ARGUMENT', retryable: false });

  // One table of texts, each sent as written as an aggregation and as an aggregate job by every caller: the checks before
  // admission measure the compact text with its literals (1e400 stays 1e400, never JSON's null), then its syntax, nesting
  // (at most 16 levels in a spec) and values, so each is refused with one code on every transport, before admission.
  const nested = levels => `{"metrics":[{"op":"count"}],"x":${'['.repeat(levels - 1)}0${']'.repeat(levels - 1)}}`;
  const literals = `{"metrics":[{"op":"count"}],"x":[${Array.from({ length: 1_300 }, () => '1e400').join(',')}],"pad":"`;
  const envelope = text => `{"kind":"aggregate","spec":${text}}`;
  const edge = `${literals}${'p'.repeat(33_793 - Buffer.byteLength(envelope(`${literals}"}`)))}"}`;
  assert.ok(Buffer.byteLength(envelope(edge)) === 33_793 && Buffer.byteLength(JSON.stringify(JSON.parse(edge))) <= 32_768,
    'over the envelope as written, within the spec bound as JSON would re-encode it');
  // Each 1e20 is 4 bytes as written and 21 in compact JSON: within every body budget as sent, over both once encoded.
  const expanding = `{"metrics":[{"op":"count"}],"x":[${Array.from({ length: 1_700 }, () => '1e20').join(',')}]}`;
  const table = [
    ['envelope-edge 1e400', edge, 'RATE_LIMITED'], ['compact form over the budget', expanding, 'RATE_LIMITED'],
    ['unparseable', '{"metrics":[{"op":"count"}]', 'INVALID_ARGUMENT', false],
    ['nested past the limit', nested(17), 'INVALID_ARGUMENT'], ['nested past the stack', nested(10_001), 'INVALID_ARGUMENT']];
  for (const [row, text, code, viaMcp] of table) for (const label of ['owner', 'reader', 'exporter', 'foreignOwner'])
    for (const kind of [undefined, 'aggregate']) {
      const operation = `${label} ${row} ${kind ? 'aggregate job' : 'aggregation'}`;
      assert.deepEqual(same(operation, await callers[label].literal(kind, text, viaMcp), kind ? 'AnalysisJobStatus' : 'AggregationResult'),
        { error: code, retryable: false }, operation);
    }
  // Admitted on every transport, where the service then authorizes before it refuses the field: a spec at the nesting
  // limit, and one whose escapes make it over 33,792 bytes as sent but about 6,000 in compact form, which MCP measures.
  const escaped = `{"metrics":[{"op":"count"}],"x":"${'\\u0078'.repeat(6_000)}"}`;
  assert.ok(Buffer.byteLength(envelope(escaped)) > 33_792 && Buffer.byteLength(JSON.stringify(JSON.parse(escaped))) < 6_100);
  for (const [row, text] of [['at the nesting limit', nested(16)], ['escaped', escaped]])
    for (const [label, code] of [['owner', 'INVALID_ARGUMENT'], ['reader', 'INVALID_ARGUMENT'], ['exporter', 'FORBIDDEN'],
      ['foreignOwner', 'NOT_FOUND']]) for (const kind of [undefined, 'aggregate'])
      assert.deepEqual(same(`${label} ${row} ${kind ?? ''}`, await callers[label].literal(kind, text),
        kind ? 'AnalysisJobStatus' : 'AggregationResult'), { error: code, retryable: false }, `${label} ${row} ${kind ?? ''}`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analysis_jobs WHERE space_id=$1', [f.spaceId])).rows[0].n, jobsBefore,
    'no refused spec queues a job');
  const deep = nested(10_001);
  for (const [text, code] of [[overflowing, 'RATE_LIMITED'], [small, 'INVALID_ARGUMENT'], [deep, 'INVALID_ARGUMENT'],
    ...table.map(([, value, refusal]) => [value, refusal])]) for (const argv of [['aggregate'],
    ['submit', '--kind', 'aggregate']])
    assert.deepEqual(outcome(await cliRun(offline, ['analysis', ...argv, '--collection', 'items', '--data', text])),
      { error: code, retryable: false }, `the CLI refuses a ${code} 1e400 spec to ${argv[0]} locally`);

  // A request envelope the CLI cannot send is refused alike over HTTP and MCP.
  assert.deepEqual(same('envelope', await owner.submit({ kind: 'export', extra: true }, false), 'AnalysisJobStatus', comparableJob),
    { error: 'INVALID_ARGUMENT', retryable: false });

  const [aggregateJob] = Object.values(await owner.submit({ kind: 'aggregate', spec: aggregate }, false)).map(status => status.jobId);
  const keyJob = (await callers.exporter.submit({ kind: 'export' }, false)).http.jobId;

  // Before the jobs Worker runs, no page is a result: CONFLICT, which no retry of the page alone resolves.
  for (const job of [exportJob, aggregateJob])
    assert.deepEqual(same('page before completion', await owner.page(job, 1), 'AnalysisPage'), { error: 'CONFLICT', retryable: false });
  assert.equal(owner.status(), 409);
  assert.equal(same('queued status', await owner.jobStatus(exportJob), 'AnalysisJobStatus').state, 'queued');

  // The foreign owner's collection has no record: its export completes with no page.
  const empty = await caller(t, origin, temp, foreign.ownerToken, 'foreign-own', foreign.spaceId);
  const emptyJob = (await empty.submit({ kind: 'export' }, false)).http.jobId;

  await drain();
  const emptyStatus = same('empty export status', await empty.jobStatus(emptyJob), 'AnalysisJobStatus');
  assert.deepEqual([emptyStatus.state, emptyStatus.complete, emptyStatus.manifest], ['completed', true, { pageCount: 0, rowCount: 0,
    byteSize: 0, resultSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', format: 'application/x-ndjson' }]);
  assert.deepEqual(same('empty export page', await empty.page(emptyJob, 1), 'AnalysisPage'), { error: 'NOT_FOUND', retryable: false },
    'an empty export has no page 1');
  const status = same('completed status', await owner.jobStatus(exportJob), 'AnalysisJobStatus');
  assert.deepEqual([status.state, status.complete, status.manifest.pageCount, status.manifest.rowCount], ['completed', true, 1, 3]);
  const page = same('export page', await owner.page(exportJob, 1), 'AnalysisPage');
  const lines = page.page.content.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(new Map(lines.map(line => [line.id, line.data])), written, 'the page states the records written before submission');
  const aggregated = JSON.parse(same('aggregate page', await owner.page(aggregateJob, 1), 'AnalysisPage').page.content);
  const interactive = await services.analysis.aggregate(f.owner, f.spaceId, 'items', JSON.stringify(aggregate));
  assert.deepEqual(aggregated.groups, interactive.groups, 'the job aggregates as the interactive aggregation does');
  for (const [n, code] of [[2, 'NOT_FOUND'], [0, 'INVALID_ARGUMENT'], [10_001, 'INVALID_ARGUMENT'], ['x', 'INVALID_ARGUMENT']])
    assert.deepEqual(same(`page ${n}`, await owner.page(exportJob, n), 'AnalysisPage'), { error: code, retryable: false }, `page ${n}`);

  // A job is its submitter's: another key, the owner or a foreign owner finds none, for every job read.
  assert.equal(same('own key', await callers.exporter.jobStatus(keyJob), 'AnalysisJobStatus').state, 'completed');
  for (const [label, job] of [['other', keyJob], ['owner', keyJob], ['other', exportJob], ['foreignOwner', exportJob], ['reader', keyJob]]) {
    for (const [operation, results] of [['status', await callers[label].jobStatus(job)], ['page', await callers[label].page(job, 1)]])
      assert.deepEqual(same(`${label} ${operation}`, results, operation === 'page' ? 'AnalysisPage' : 'AnalysisJobStatus'),
        { error: 'NOT_FOUND', retryable: false }, `${label} ${operation} ${job}`);
  }
  for (const job of ['anj_not-a-job', `anj_${randomUUID()}`])
    assert.deepEqual(same(`unknown job ${job}`, await owner.jobStatus(job), 'AnalysisJobStatus'), { error: 'NOT_FOUND', retryable: false });

  // The spec bound applies to the re-encoded spec: one sent formatted, over 32,768 bytes as sent but within them re-encoded,
  // in an envelope within 33,792 bytes, is queued on every transport, from the CLI's --data and --file alike.
  const wide = { metrics: [{ op: 'count' }], where: Array.from({ length: 4 }, () => ({ field: 'team', kind: 'string', operator: 'in',
    value: Array.from({ length: 16 }, () => 'x'.repeat(500)) })) };
  const pretty = value => JSON.stringify(value, null, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= 32_768 && Buffer.byteLength(pretty(wide)) > 32_768 &&
    Buffer.byteLength(pretty({ kind: 'aggregate', spec: wide })) <= 33_792);
  const formatted = await owner.submit({ kind: 'aggregate', spec: wide }, true, pretty);
  same('formatted spec', formatted, 'AnalysisJobStatus', comparableJob);
  assert.equal(formatted.http.state, 'queued');
  const wideFile = join(temp, 'wide.json');
  await writeFile(wideFile, pretty(wide));
  assert.equal((await cliRun(join(temp, 'owner'), ['analysis', 'submit', '--kind', 'aggregate', '--file', wideFile, '--collection', 'items']))
    .state, 'queued', 'a formatted --file spec is queued');

  // Cancellation: the first transport cancels and removes the pages; the others report the ended job as it is.
  const [cancellable] = Object.values(await owner.submit({ kind: 'export' }, false)).map(value => value.jobId);
  const cancelled = await owner.cancel(cancellable);
  assert.equal(cancelled.http.state, 'cancelled');
  same('cancellation', cancelled, 'AnalysisJobStatus');
  assert.deepEqual(same('cancelled page', await owner.page(cancellable, 1), 'AnalysisPage'), { error: 'CONFLICT', retryable: false });
  assert.equal(same('cancel completed', await owner.cancel(exportJob), 'AnalysisJobStatus').state, 'completed',
    'a completed job is reported as it is');
  assert.deepEqual(same('foreign cancel', await callers.foreignOwner.cancel(exportJob), 'AnalysisJobStatus'),
    { error: 'NOT_FOUND', retryable: false });
  assert.deepEqual(same('unknown cancel', await callers.unknown.cancel(exportJob), 'AnalysisJobStatus'),
    { error: 'UNAUTHENTICATED', retryable: false });
});

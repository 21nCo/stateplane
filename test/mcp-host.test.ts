import { beforeEach, expect, it, vi } from 'vitest';

/* The app host inside a Worker opens storage per request. These doubles record
 * which endpoint and services each /mcp request used; the real endpoint's
 * scope handling is covered by test/mcp.test.js. */
const state = vi.hoisted(() => ({ endpoints: 0, pools: 0, ended: 0, resources: [] as string[],
  scopes: [] as Array<{ services: unknown; identity: unknown; onTimeout?: () => void }>,
  services: [] as unknown[], http: null as null | ((request: Request) => Response) }));
vi.mock('pg', () => ({ default: { Pool: class {
  constructor() { state.pools++; }
  on() { return this; }
  async end() { state.ended++; }
} } }));
vi.mock('../packages/postgres/dist/index.js', () => ({
  PostgresSpaces: class {},
  postgresServices: () => { const services = { request: state.services.length + 1 }; state.services.push(services); return services; }
}));
vi.mock('../packages/api/dist/index.js', () => ({ createHttpHandler: () => async (request: Request) =>
  state.http ? state.http(request) : new Response(null, { status: 204 }) }));
vi.mock('../packages/mcp/dist/index.js', () => ({
  createMcpEndpoint: (options: { resource: string }) => {
    state.endpoints++;
    state.resources.push(options.resource);
    return async (_request: Request, scope: (typeof state.scopes)[number]) => {
      state.scopes.push(scope);
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    };
  }
}));

import { stateplaneHost } from '../app/src/lib/server/host';
import { api } from '../app/src/lib/server/api';
import { checkKey } from '../app/src/lib/server/keycheck';
import { jsonObject } from '../app/src/lib/server/forms';
import { carriedId, carry, segment, selectors, shown } from '../app/src/lib/paths';
import { predicates } from '../app/src/lib/query';
import { handle } from '../app/src/hooks.server';

const env = { STATEPLANE_ENV: 'preview', STATEPLANE_TEST_HTTP: '1', STATEPLANE_TEST_TOKEN: 'o'.repeat(32),
  STATEPLANE_TEST_OWNER: 'owner', STATEPLANE_TEST_CREDENTIAL: 'session-1', STATEPLANE_TEST_CURSOR_SECRET: 'a'.repeat(64),
  STATEPLANE_MCP_AUTHORIZATION_SERVER: 'https://auth.example', STATEPLANE_MCP_RESOURCE: 'https://preview.example/mcp',
  AUTHORITY: { connectionString: 'postgres://example/db' } };
const call = (host = 'preview.example', origin?: string) => new Request(`${host.startsWith('http') ? '' : 'https://'}${host}/mcp`,
  { method: 'POST', body: '{}', headers: origin ? { origin } : {} });

beforeEach(() => { state.scopes.length = 0; state.services.length = 0; state.http = null; });

it('a Worker builds the MCP endpoint once while each request brings its own services', async () => {
  const before = state.endpoints;
  const first = stateplaneHost(env as never)!;
  await first.mcp(call());
  const second = stateplaneHost(env as never)!;
  await second.mcp(call());
  expect(state.endpoints - before).toBe(1);
  expect(state.pools).toBe(2);
  expect(state.scopes.map(scope => scope.services)).toEqual(state.services);
  expect(state.scopes[0].services).not.toBe(state.scopes[1].services);
  expect(state.scopes[0].identity).not.toBe(state.scopes[1].identity);
  // Each request retires its own pool once it settles.
  expect(state.ended).toBe(2);
  state.scopes[0].onTimeout?.();
  expect(state.ended).toBe(2);
});

it('a Preview without a configured resource fails closed instead of trusting the request Host', async () => {
  const unconfigured = { ...env, STATEPLANE_MCP_RESOURCE: undefined };
  const response = await stateplaneHost(unconfigured as never)!.mcp(call('rebound.example', 'https://rebound.example'));
  expect(response.status).toBe(503);
  expect(state.scopes).toHaveLength(0);
});

it('a configured resource is used whatever Host and Origin the request presents', async () => {
  // The endpoint allows only the configured resource origin, so a rebinding
  // request whose Host and Origin agree is refused there (test/mcp.test.js).
  await stateplaneHost(env as never)!.mcp(call());
  const before = state.endpoints;
  await stateplaneHost(env as never)!.mcp(call('rebound.example', 'https://rebound.example'));
  expect(state.endpoints - before).toBe(0);
  expect(new Set(state.resources)).not.toContain('https://rebound.example/mcp');
  expect(state.resources).toContain('https://preview.example/mcp');
});

it('a local host derives bounded resources only from loopback request hosts', async () => {
  const unconfigured = { ...env, STATEPLANE_MCP_RESOURCE: undefined };
  const local = { ...unconfigured, STATEPLANE_ENV: 'local' };
  const before = state.endpoints;
  const rebound = await stateplaneHost(local as never)!.mcp(call('http://rebound.example:5173', 'http://rebound.example:5173'));
  expect(rebound.status).toBe(503);
  expect(state.scopes).toHaveLength(0);
  for (const host of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5173'])
    expect((await stateplaneHost(local as never)!.mcp(call(host))).status).toBe(200);
  expect(state.endpoints - before).toBe(2);
  expect(state.resources.slice(-2)).toEqual(['http://127.0.0.1:5173/mcp', 'http://localhost:5173/mcp']);
});

it('a full resource cache evicts only its oldest endpoint', async () => {
  const local = { ...env, STATEPLANE_MCP_RESOURCE: undefined, STATEPLANE_ENV: 'local' };
  const serve = (port: number) => stateplaneHost(local as never)!.mcp(call(`http://127.0.0.1:${port}`));
  // Across more inserts than the cap, the previous resource always survives the next insert.
  for (let port = 6101; port <= 6106; port++) {
    await serve(port);
    const before = state.endpoints;
    if (port > 6101) await serve(port - 1);
    expect(state.endpoints - before, `resource ${port - 1} after inserting ${port}`).toBe(0);
  }
});

it('a Node host rebuilds when STATEPLANE_ENV changes and accepts any bearer scheme case', async () => {
  const node = { ...env, AUTHORITY: undefined, STATEPLANE_TEST_DATABASE_URL: 'postgres://example/db',
    STATEPLANE_MCP_RESOURCE: undefined, STATEPLANE_TEST_AGENT_TOKEN: 'g'.repeat(32), STATEPLANE_TEST_AGENT_CREDENTIAL: 'agent-1' };
  expect((await stateplaneHost({ ...node, STATEPLANE_ENV: 'local' } as never)!.mcp(call('http://127.0.0.1:6201'))).status).toBe(200);
  const identity = state.scopes.at(-1)!.identity as { verify(request: Request): Promise<unknown> };
  const bearer = (value: string) => identity.verify(new Request('http://127.0.0.1:6201/mcp', { headers: { authorization: value } }));
  expect(await bearer(`bearer ${'o'.repeat(32)}`)).toMatchObject({ kind: 'session', credentialId: 'session-1' });
  expect(await bearer(`BEARER ${'g'.repeat(32)}`)).toMatchObject({ kind: 'api-key', credentialId: 'agent-1' });
  expect(await bearer(`Basic ${'o'.repeat(32)}`)).toBeNull();
  // The same bindings as a Preview no longer derive a loopback resource.
  const preview = await stateplaneHost({ ...node, STATEPLANE_ENV: 'preview' } as never)!.mcp(call('http://127.0.0.1:6201'));
  expect(preview.status).toBe(503);
});

it('a UI write without a configured host reports a retryable unsent request, as /v1 does', async () => {
  const context = { cookies: { get: () => 'o'.repeat(32) }, url: new URL('http://127.0.0.1/spaces'),
    platform: { env: { STATEPLANE_ENV: 'local', STATEPLANE_TEST_HTTP: '0' } } };
  const result = await api(context as never, 'POST', ['spaces'], { body: { spaceId: 'sp_unsent' } });
  expect(result).toMatchObject({ ok: false, status: 503, error: { code: 'PROVIDER_UNAVAILABLE', retryable: true } });
});

it('a key check reports provider rejection only for UNAUTHENTICATED; other failures do not verify revocation', async () => {
  const context = { cookies: { get: () => undefined }, url: new URL('https://preview.example/spaces/sp/access'), platform: { env } };
  const outcome = async (status: number, code: string) => {
    state.http = () => Response.json({ error: { code, retryable: status !== 401, requestId: 'r' } }, { status });
    return checkKey(context as never, 'sp', 'k'.repeat(32));
  };
  expect(await outcome(401, 'UNAUTHENTICATED')).toMatchObject({ kind: null, rejected: true, code: 'UNAUTHENTICATED' });
  for (const [status, code] of [[503, 'PROVIDER_UNAVAILABLE'], [429, 'RATE_LIMITED'], [500, 'INTERNAL']] as const)
    expect(await outcome(status, code)).toMatchObject({ kind: null, rejected: false, code, space: null });
  // A provider-accepted key revoked in this space is denied here, not rejected.
  state.http = request => new URL(request.url).pathname === '/v1/auth/session' ? Response.json({ kind: 'api-key' }) :
    Response.json({ error: { code: 'NOT_FOUND', retryable: false } }, { status: 404 });
  expect(await checkKey(context as never, 'sp', 'k'.repeat(32))).toMatchObject({ kind: 'api-key', rejected: false,
    space: { allowed: false, code: 'NOT_FOUND', denied: true } });
  // An active key with only events:read or space:admin is FORBIDDEN by discovery, which is not a denial.
  state.http = request => new URL(request.url).pathname === '/v1/auth/session' ? Response.json({ kind: 'api-key' }) :
    Response.json({ error: { code: 'FORBIDDEN', retryable: false } }, { status: 403 });
  expect(await checkKey(context as never, 'sp', 'k'.repeat(32))).toMatchObject({ kind: 'api-key',
    space: { allowed: false, code: 'FORBIDDEN', denied: false } });
});

it('an identifier with any non-printing character is displayed quoted and escaped wherever the character occurs', () => {
  expect(shown('items')).toBe('items');
  expect(shown('two words')).toBe('two words');
  expect(shown('\u200b')).toBe('"\\u200b"');
  expect(shown('a\ufeffb')).toBe('"a\\ufeffb"');
  expect(shown('a\u00a0b\u2028c\u{e0001}')).toBe('"a\\u00a0b\\u2028c\\u{e0001}"');
  expect(shown(' items ')).toBe('" items "');
  expect(new Set(['ab', 'a\ufeffb', 'a\u200bb', 'a\u2060b'].map(shown)).size).toBe(4);
});

it('a default-ignorable character is escaped even outside the format and separator categories', () => {
  expect(shown('a\u034fb')).toBe('"a\\u034fb"');
  expect(shown('a\ufe0f')).toBe('"a\\ufe0f"');
  expect(shown('\u3164')).toBe('"\\u3164"');
  expect(new Set(['ab', 'a\u034fb', 'a\ufe0fb', 'a\u3164b'].map(shown)).size).toBe(4);
});

it('a listed identifier survives the line-break rewriting of form submission exactly', () => {
  // Browsers submit every CR, LF and CRLF in form data as CRLF.
  const submitted = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n');
  const ids = ['a\nb', 'a\r\nb', 'a\rb', '%', '%25', '%0A', 'a%0D%0Ab', '\u200b', 'plain'];
  for (const id of ids) expect(carriedId(submitted(carry(id)))).toBe(id);
  expect(new Set(ids.map(carry)).size).toBe(ids.length);
  expect(carry('\u200c')).toBe('\u200c');
});

it('no two identifiers share a display, even when one spells out the quoted form of the other', () => {
  const pairs = [[' items ', '" items "'], ['\u200b', '"\\u200b"'], ['a\u200bb', '"a\\u200bb"'], ['"items"', 'items'], ['a\\u200bb', 'a\u200bb']];
  for (const [one, other] of pairs) expect(shown(one)).not.toBe(shown(other));
  expect(shown('"items"')).toBe('"\\"items\\""');
  expect(shown('a"b')).toBe('a"b');
});

it('a key secret no header can carry is never checked, so it never reads as a provider rejection', async () => {
  let sent = 0;
  state.http = () => { sent++; return Response.json({ kind: 'api-key' }); };
  const context = { cookies: { get: () => undefined }, url: new URL('https://preview.example/spaces/sp/access'), platform: { env } };
  expect(await checkKey(context as never, 'sp', `${'k'.repeat(16)}\u200b${'k'.repeat(16)}`)).toBeNull();
  expect(sent).toBe(0);
});

it('a selector SvelteKit would read as a data or route request is escaped and read back exactly', () => {
  for (const name of ['__data.json', 'page.html__data.json', '__route.js', '.', '..', 'plain_name']) {
    const path = `/spaces/${segment('sp')}/collections/${segment(name)}`;
    expect(path.endsWith('__data.json') || path.endsWith('__route.js')).toBe(false);
    expect(selectors(new URL(path, 'https://preview.example')).collection).toBe(name);
  }
});

it('a filter value is sent only when it is JSON number syntax or a real calendar instant', () => {
  const definition = { slug: 'c', version: 1, unique: [], filterable: ['n', 't'], sortable: [],
    schema: { type: 'object', properties: { n: { type: 'number' }, t: { type: 'string', format: 'date-time' } } } };
  const check = (field: string, op: string, value: string) => predicates(definition as never, [{ field, op, value }]);
  for (const value of ['0x10', '0b11', '1_000', '.5', '+1', 'Infinity', '1e400']) expect(check('n', 'eq', value).errors).toHaveProperty('0');
  expect(check('n', 'in', '-1.5e3, 0').predicates).toEqual([{ field: 'n', kind: 'number', operator: 'in', value: [-1500, 0] }]);
  for (const value of ['2026-02-30T12:00:00Z', '2026-01-31T24:00:00Z', '2026-01-31T12:60:00Z', '0000-01-01T00:00:00Z', '2026-13-01T00:00:00Z'])
    expect(check('t', 'eq', value).errors).toHaveProperty('0');
  expect(check('t', 'in', '2026-01-31T12:00:00Z, 2026-02-29T00:00:00Z').errors).toHaveProperty('0');
  for (const value of ['2024-02-29T23:59:59.5Z', '2016-12-31T23:59:60Z'])
    expect(check('t', 'gte', value).predicates).toEqual([{ field: 't', kind: 'date-time', operator: 'gte', value }]);
});

it('a JSON field with a number JSON cannot carry is rejected instead of sent as null', () => {
  for (const raw of ['{"n":1e400}', '{"n":-1e400}', '{"a":[{"n":1e999}]}']) expect(jsonObject(raw)).toBeNull();
  expect(JSON.stringify(jsonObject('{"n":1.5e300,"a":[0,null,"1e400"]}'))).toBe('{"n":1.5e+300,"a":[0,null,"1e400"]}');
});

it('a Worker page render shares one host and pool, which the hook retires after the response', async () => {
  const before = { pools: state.pools, ended: state.ended };
  const event = { url: new URL('https://preview.example/spaces/sp/access'), cookies: { get: () => 'o'.repeat(32) },
    platform: { env }, locals: {} as App.Locals };
  const response = await handle({ event: event as never, resolve: async () => {
    for (let call = 0; call < 3; call++) expect((await api(event as never, 'GET', ['spaces'])).ok).toBe(true);
    expect(state.ended).toBe(before.ended);
    return new Response('page');
  } } as never);
  expect(response.status).toBe(200);
  expect(state.pools - before.pools).toBe(1);
  expect(state.ended - before.ended).toBe(1);
  // A retired host, for example after a request timeout, is replaced rather than reused.
  expect((await api(event as never, 'GET', ['spaces'])).ok).toBe(true);
  expect(state.pools - before.pools).toBe(2);
  event.locals.hostLease?.retire();
  expect(state.ended - before.ended).toBe(2);
});

import { beforeEach, expect, it, vi } from 'vitest';

/* The app host inside a Worker opens storage per request. These doubles record
 * which endpoint and services each /mcp request used; the real endpoint's
 * scope handling is covered by test/mcp.test.js. */
const state = vi.hoisted(() => ({ endpoints: 0, pools: 0, ended: 0, resources: [] as string[],
  scopes: [] as Array<{ services: unknown; identity: unknown; onTimeout?: () => void }>,
  services: [] as unknown[] }));
vi.mock('pg', () => ({ default: { Pool: class {
  constructor() { state.pools++; }
  on() { return this; }
  async end() { state.ended++; }
} } }));
vi.mock('../packages/postgres/dist/index.js', () => ({
  PostgresSpaces: class {},
  postgresServices: () => { const services = { request: state.services.length + 1 }; state.services.push(services); return services; }
}));
vi.mock('../packages/api/dist/index.js', () => ({ createHttpHandler: () => async () => new Response(null, { status: 204 }) }));
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

const env = { STATEPLANE_ENV: 'preview', STATEPLANE_TEST_HTTP: '1', STATEPLANE_TEST_TOKEN: 'o'.repeat(32),
  STATEPLANE_TEST_OWNER: 'owner', STATEPLANE_TEST_CREDENTIAL: 'session-1', STATEPLANE_TEST_CURSOR_SECRET: 'a'.repeat(64),
  STATEPLANE_MCP_AUTHORIZATION_SERVER: 'https://auth.example', STATEPLANE_MCP_RESOURCE: 'https://preview.example/mcp',
  AUTHORITY: { connectionString: 'postgres://example/db' } };
const call = (host = 'preview.example', origin?: string) => new Request(`${host.startsWith('http') ? '' : 'https://'}${host}/mcp`,
  { method: 'POST', body: '{}', headers: origin ? { origin } : {} });

beforeEach(() => { state.scopes.length = 0; state.services.length = 0; });

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

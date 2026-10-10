import { beforeEach, expect, it, vi } from 'vitest';

/* The app host inside a Worker opens storage per request. These doubles record
 * which endpoint and services each /mcp request used; the real endpoint's
 * scope handling is covered by test/mcp.test.js. */
const state = vi.hoisted(() => ({ endpoints: 0, pools: 0, ended: 0,
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
  createMcpEndpoint: () => {
    state.endpoints++;
    return async (_request: Request, scope: (typeof state.scopes)[number]) => {
      state.scopes.push(scope);
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    };
  }
}));

import { stateplaneHost } from '../app/src/lib/server/host';

const env = { STATEPLANE_ENV: 'preview', STATEPLANE_TEST_HTTP: '1', STATEPLANE_TEST_TOKEN: 'o'.repeat(32),
  STATEPLANE_TEST_OWNER: 'owner', STATEPLANE_TEST_CREDENTIAL: 'session-1', STATEPLANE_TEST_CURSOR_SECRET: 'a'.repeat(64),
  STATEPLANE_MCP_AUTHORIZATION_SERVER: 'https://auth.example', AUTHORITY: { connectionString: 'postgres://example/db' } };
const call = (host = 'preview.example') => new Request(`https://${host}/mcp`, { method: 'POST', body: '{}' });

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

it('distinct derived resources get bounded, separate endpoints', async () => {
  const before = state.endpoints;
  for (const host of ['a.example', 'b.example', 'a.example'])
    await stateplaneHost(env as never)!.mcp(call(host));
  expect(state.endpoints - before).toBe(2);
});

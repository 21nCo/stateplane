import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { classifyError } from '../packages/application/dist/index.js';

/* The app host chooses its agent key provider; these doubles record the one a
 * Worker host hands to the space services. */
const state = vi.hoisted(() => ({ providers: [] as Array<Record<'create' | 'find' | 'revoke', (...args: unknown[]) => Promise<unknown>>>, pools: 0, ends: 0 }));
vi.mock('pg', () => ({ default: { Pool: class { constructor() { state.pools++; } on() { return this; } async end() { state.ends++; } } } }));
vi.mock('../packages/postgres/dist/index.js', () => ({
  PostgresSpaces: class { constructor(...args: unknown[]) { state.providers.push(args[3] as never); } },
  postgresServices: () => ({})
}));
vi.mock('../packages/api/dist/index.js', () => ({ createHttpHandler: () => async () => new Response(null, { status: 204 }) }));
vi.mock('../packages/mcp/dist/index.js', () => ({ createMcpEndpoint: () => async () => new Response(null, { status: 204 }) }));

import { stateplaneHost } from '../app/src/lib/server/host';

const worker = { STATEPLANE_ENV: 'preview', STATEPLANE_TEST_HTTP: '1', STATEPLANE_TEST_TOKEN: 'o'.repeat(32),
  STATEPLANE_TEST_OWNER: 'owner', STATEPLANE_TEST_CREDENTIAL: 'session-1', STATEPLANE_TEST_CURSOR_SECRET: 'a'.repeat(64),
  AUTHORITY: { connectionString: 'postgres://example/db' } };

it('a Worker host without a key provider refuses issuance and revocation with a code no retry changes', async () => {
  stateplaneHost(worker as never);
  const [provider] = state.providers;
  for (const attempt of [provider.create('owner', new Date(), 'iss_1'), provider.revoke('key_1', 'owner')])
    expect(classifyError(await attempt.catch((error: unknown) => error), false)).toEqual({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  expect(await provider.find('owner', 'iss_1')).toBeNull();
});

it('a page request without a session goes to sign-in as a document, data, remote or form action request, however its path is encoded', async () => {
  const { isRedirect } = await import('../app/node_modules/@sveltejs/kit');
  const { handle } = await import('../app/src/hooks.server');
  const request = (path: string, init: { method?: string; isDataRequest?: boolean; isRemoteRequest?: boolean } = {}) => handle({
    event: { url: new URL(path, 'http://127.0.0.1'), request: new Request(new URL(path, 'http://127.0.0.1'), { method: init.method ?? 'GET' }),
      cookies: { get: () => undefined }, locals: {}, isDataRequest: init.isDataRequest ?? false, isRemoteRequest: init.isRemoteRequest ?? false },
    resolve: async () => new Response('page')
  } as never);
  for (const path of ['/spaces', '/%73paces/s1']) {
    const document = await request(path);
    expect([document.status, document.headers.get('location'), document.headers.get('cache-control')]).toEqual([303, '/', 'no-store']);
  }
  // SvelteKit turns a thrown redirect into the JSON redirect each of these clients follows.
  for (const init of [{ isDataRequest: true }, { isRemoteRequest: true }, { method: 'POST' }])
    expect(await request('/spaces/s1', init).then(() => null, (error: unknown) => isRedirect(error) && [error.status, error.location])).toEqual([303, '/']);
  expect(await (await request('/%2Fspaces')).text()).toBe('page');
});

it('a Worker page render opens one pool for all its API calls and ends it once after the response, even when rendering fails', async () => {
  const { api } = await import('../app/src/lib/server/api');
  const { handle } = await import('../app/src/hooks.server');
  for (const fails of [false, true]) {
    const [pools, ends] = [state.pools, state.ends];
    const event = { url: new URL('http://127.0.0.1/spaces'), request: new Request('http://127.0.0.1/spaces'), cookies: { get: () => 's'.repeat(32) },
      locals: {}, platform: { env: worker }, isDataRequest: false, isRemoteRequest: false };
    const rendered = handle({ event, resolve: async () => {
      for (const path of [['spaces'], ['spaces', 's1']]) expect((await api(event as never, 'GET', path)).ok).toBe(true);
      expect([state.pools - pools, state.ends - ends]).toEqual([1, 0]);
      if (fails) throw new Error('render failed');
      return new Response('page');
    } } as never);
    await (fails ? expect(rendered).rejects.toThrow('render failed') : expect(rendered).resolves.toBeInstanceOf(Response));
    expect([state.pools - pools, state.ends - ends]).toEqual([1, 1]);
  }
});

it('a deployed e2e run without its owner bearer stops before any test, and only a local run generates one', async () => {
  const env = { ...process.env };
  delete env.STATEPLANE_E2E_TOKEN;
  delete env.STATEPLANE_E2E_BASE_URL;
  const list = (extra: Record<string, string>) => promisify(execFile)('node_modules/.bin/playwright', ['test', '--list'], { env: { ...env, ...extra } })
    .then(() => 'listed', (error: { stderr: string }) => error.stderr);
  const deployed = { STATEPLANE_E2E_BASE_URL: 'https://stateplane.invalid' };
  for (const token of [{}, { STATEPLANE_E2E_TOKEN: '' }]) expect(await list({ ...deployed, ...token })).toContain('needs the target owner bearer in STATEPLANE_E2E_TOKEN');
  expect([await list({ ...deployed, STATEPLANE_E2E_TOKEN: 't'.repeat(64) }), await list({})]).toEqual(['listed', 'listed']);
}, 60_000);

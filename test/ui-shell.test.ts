import { expect, it, vi } from 'vitest';
import { classifyError } from '../packages/application/dist/index.js';

/* The app host chooses its agent key provider; these doubles record the one a
 * Worker host hands to the space services. */
const state = vi.hoisted(() => ({ providers: [] as Array<Record<'create' | 'find' | 'revoke', (...args: unknown[]) => Promise<unknown>>> }));
vi.mock('pg', () => ({ default: { Pool: class { on() { return this; } async end() {} } } }));
vi.mock('../packages/postgres/dist/index.js', () => ({
  PostgresSpaces: class { constructor(...args: unknown[]) { state.providers.push(args[3] as never); } },
  postgresServices: () => ({})
}));
vi.mock('../packages/api/dist/index.js', () => ({ createHttpHandler: () => async () => new Response(null, { status: 204 }) }));
vi.mock('../packages/mcp/dist/index.js', () => ({ createMcpEndpoint: () => async () => new Response(null, { status: 204 }) }));

import { stateplaneHost } from '../app/src/lib/server/host';

it('a Worker host without a key provider refuses issuance and revocation with a code no retry changes', async () => {
  stateplaneHost({ STATEPLANE_ENV: 'preview', STATEPLANE_TEST_HTTP: '1', STATEPLANE_TEST_TOKEN: 'o'.repeat(32),
    STATEPLANE_TEST_OWNER: 'owner', STATEPLANE_TEST_CREDENTIAL: 'session-1', STATEPLANE_TEST_CURSOR_SECRET: 'a'.repeat(64),
    AUTHORITY: { connectionString: 'postgres://example/db' } } as never);
  const [provider] = state.providers;
  for (const attempt of [provider.create('owner', new Date(), 'iss_1'), provider.revoke('key_1', 'owner')])
    expect(classifyError(await attempt.catch((error: unknown) => error), false)).toEqual({ code: 'PROVIDER_UNAVAILABLE', retryable: false });
  expect(await provider.find('owner', 'iss_1')).toBeNull();
});

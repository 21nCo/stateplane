import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// A deployed development target supplies STATEPLANE_E2E_BASE_URL and its owner
// bearer as STATEPLANE_E2E_TOKEN. Otherwise a local fixture host is started,
// with Postgres when DATABASE_URL or the local Compose password is available.
const deployed = process.env.STATEPLANE_E2E_BASE_URL;
const passwordFile = '.data/local-db-password';
const database = process.env.DATABASE_URL ?? (existsSync(passwordFile) ?
  `postgres://stateplane:${encodeURIComponent(readFileSync(passwordFile, 'utf8').trim())}@127.0.0.1:${process.env.STATEPLANE_LOCAL_DB_PORT ?? '55432'}/stateplane` : undefined);
// Workers re-read this file; the runner's values are inherited, so all agree.
process.env.STATEPLANE_E2E_TOKEN ??= randomBytes(32).toString('hex');
// Tests sign a backdated unresolved write with it to stand in for elapsed time.
process.env.STATEPLANE_E2E_CURSOR_SECRET ??= randomBytes(32).toString('hex');
if (deployed || database) process.env.STATEPLANE_E2E_STATE = '1';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  use: { baseURL: deployed ?? 'http://127.0.0.1:5743' },
  webServer: deployed ? undefined : {
    command: 'node test/e2e/host.js', url: 'http://127.0.0.1:5743/api/health', reuseExistingServer: false,
    // SIGTERM lets the launcher drop its disposable database.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: database ? { STATEPLANE_E2E_BASE_DATABASE: database, STATEPLANE_ENV: 'local', STATEPLANE_TEST_HTTP: '1',
      STATEPLANE_TEST_TOKEN: process.env.STATEPLANE_E2E_TOKEN, STATEPLANE_TEST_OWNER: 'owner-e2e',
      STATEPLANE_TEST_CREDENTIAL: 'session-e2e', STATEPLANE_TEST_CURSOR_SECRET: process.env.STATEPLANE_E2E_CURSOR_SECRET } : {}
  }
});

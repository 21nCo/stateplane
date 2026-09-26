import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL: 'http://127.0.0.1:5743' },
  webServer: { command: 'pnpm --filter @stateplane/app dev --host 127.0.0.1 --port 5743 --strictPort', url: 'http://127.0.0.1:5743', reuseExistingServer: false }
});

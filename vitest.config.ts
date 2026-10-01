import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/qualification.test.ts', 'test/qualification-worker.test.ts',
  'test/qualification-worker-postgres.test.ts', 'test/operational-worker.test.ts'] } });

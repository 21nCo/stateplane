import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/ui-shell.test.ts', 'test/ui-errors.test.ts', 'test/ui-query.test.ts'] } });

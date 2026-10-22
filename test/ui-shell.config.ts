import { defineConfig } from 'vitest/config';
import render from './ui-render.config';

export default defineConfig({ test: { projects: [
  { test: { name: 'ui', include: ['test/ui-shell.test.ts', 'test/ui-errors.test.ts', 'test/ui-query.test.ts', 'test/ui-access.test.ts'] } },
  render] } });

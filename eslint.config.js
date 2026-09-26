import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['**/dist/**', '**/.svelte-kit/**', '.data/**', 'node_modules/**', 'pnpm-lock.yaml'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js', 'app/vite.config.ts', 'app/svelte.config.js', 'playwright.config.ts', 'vitest.config.ts'], languageOptions: { globals: globals.node } },
  { files: ['app/src/**/*.{js,ts,svelte}'], languageOptions: { globals: globals.browser } }
];

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The Svelte plugin is the app workspace's; pages render with server-side Svelte
// and $app stand-ins, without a SvelteKit host.
const app = (path: string) => fileURLToPath(new URL(`../app/${path}`, import.meta.url));
const { svelte } = await import(app('node_modules/@sveltejs/vite-plugin-svelte/src/index.js'));
const stub = fileURLToPath(new URL('fixtures/sveltekit-app.ts', import.meta.url));
// The app is the root, so Svelte resolves from its workspace.
export default defineConfig({ root: app(''), plugins: [svelte({ configFile: false })],
  resolve: { alias: [{ find: '$lib', replacement: app('src/lib') }, { find: /^\$app\/(forms|navigation|state)$/, replacement: stub }] },
  test: { name: 'ui-render', dir: fileURLToPath(new URL('.', import.meta.url)), include: ['**/ui-render.test.ts'] } });

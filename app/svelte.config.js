import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// SvelteKit's cross-site form check runs before routing, so it would also refuse
// raw bearer uploads to /v1 (text/plain, multipart/form-data) from clients that
// send no Origin. src/hooks.server.ts applies the same check to every other
// route instead. The CSP keeps scripts, forms and framing on this origin.
export default { preprocess: vitePreprocess(), kit: { adapter: adapter(), csrf: { trustedOrigins: ['*'] }, csp: { mode: 'auto', directives: {
  'default-src': ['self'], 'script-src': ['self'], 'style-src': ['self', 'unsafe-inline'], 'img-src': ['self', 'data:'],
  'form-action': ['self'], 'frame-ancestors': ['none'], 'base-uri': ['none'], 'object-src': ['none'] } } } };

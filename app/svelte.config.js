import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// SvelteKit rejects cross-origin form posts by default; the CSP keeps scripts,
// forms and framing on this origin.
export default { preprocess: vitePreprocess(), kit: { adapter: adapter(), csp: { mode: 'auto', directives: {
  'default-src': ['self'], 'script-src': ['self'], 'style-src': ['self', 'unsafe-inline'], 'img-src': ['self', 'data:'],
  'form-action': ['self'], 'frame-ancestors': ['none'], 'base-uri': ['none'], 'object-src': ['none'] } } } };

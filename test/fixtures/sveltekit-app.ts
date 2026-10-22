/* Stand-ins for SvelteKit's $app modules when a page is rendered outside the app. */
export const enhance = () => ({});
export const page = { url: new URL('https://stateplane.example/spaces/sp/access') };
export const invalidateAll = async () => {};

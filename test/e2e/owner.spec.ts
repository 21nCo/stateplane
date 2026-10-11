import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';

test.skip(process.env.STATEPLANE_E2E_STATE !== '1', 'Needs Postgres or a deployed development target');
test.describe.configure({ mode: 'serial' });

const ownerToken = process.env.STATEPLANE_E2E_TOKEN!;
// The local host reaches Postgres through test/e2e/host.js's fault proxy.
const local = !process.env.STATEPLANE_E2E_BASE_URL;
let spaceUrl = '';
const itemsUrl = () => `${spaceUrl}/collections/items`;

// Svelte hydration rewrites field values, so wait for it before typing.
async function go(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}
async function settle(page: Page) { await page.waitForLoadState('networkidle'); }
async function signIn(page: Page, token: string) {
  await go(page, '/');
  await page.getByLabel('Bearer credential').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function audit(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(item => `${item.id}: ${item.nodes.map(node => node.target).join(' ')}`)).toEqual([]);
}
async function createRecord(page: Page, data: object) {
  await go(page, itemsUrl());
  await page.getByLabel('Data JSON').fill(JSON.stringify(data));
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('status')).toContainText('at revision 1');
  return page.getByRole('status').getByRole('link').innerText();
}
/** Drop the database reply to the next message containing `match` (after one containing `after`). */
async function dropReply(match: string, after?: string) {
  const response = await fetch('http://127.0.0.1:5744/fault', { method: 'POST', body: JSON.stringify({ match, after }) });
  expect(response.status).toBe(204);
}
/** Fail the fixture provider's next key revocation. */
async function failProviderRevocation() {
  const response = await fetch('http://127.0.0.1:5744/provider-fault', { method: 'POST', body: 'arm' });
  expect(response.status).toBe(204);
}
async function checkKey(page: Page, secret: string) {
  await settle(page);
  await page.getByLabel('Key secret').fill(secret);
  await page.getByRole('button', { name: 'Check key' }).click();
  return page.getByRole('status');
}
const definition = (properties: object) => ({ schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, ...properties } }, unique: [], filterable: [], sortable: [] });
async function defineCollection(request: APIRequestContext, name: string) {
  const response = await request.put(`/v1${spaceUrl}/collections/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${ownerToken}` }, data: { ...definition({}), slug: name, version: 1 } });
  expect(response.status()).toBe(201);
}
async function asAgent(browser: Browser, secret: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, secret);
  return page;
}

test('owner creates a space, defines a schema and edits records', async ({ page }) => {
  await signIn(page, ownerToken);
  await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create space' }).click();
  await expect(page.getByRole('heading', { name: 'Space overview' })).toBeVisible();
  spaceUrl = new URL(page.url()).pathname;
  const placement = page.getByRole('region', { name: 'Placement' });
  await expect(placement).toContainText('Home cell');
  await expect(placement).toContainText('Storage target');

  await page.getByRole('link', { name: 'Define collection' }).click();
  await settle(page);
  await page.getByLabel('Collection name').fill('items');
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page.getByText('pending', { exact: true })).toHaveCount(2);
  for (const field of ['rank', 'state']) await page.getByRole('button', { name: `Build ${field} index` }).click();
  await expect(page.getByText('ready', { exact: true })).toHaveCount(2);

  const first = await createRecord(page, { title: 'First', state: 'open', rank: 1 });
  await createRecord(page, { title: 'Second', state: 'done', rank: 2 });
  await createRecord(page, { title: 'Third', state: 'open', rank: 3 });
  await go(page, itemsUrl());
  await page.getByLabel('Field').first().selectOption('state');
  await page.getByLabel('Value').first().fill('open');
  await page.getByLabel('Sort by').selectOption('rank');
  await page.getByLabel('Direction').selectOption('desc');
  await page.getByLabel('Page size (1–100)').fill('1');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('heading', { name: /2 matching/ })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Third');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('table')).toContainText('First');
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);

  // A filter value that does not match the declared kind is reported on its field.
  await go(page, `${itemsUrl()}?field=rank&op=gt&value=many`);
  await expect(page.getByLabel('Value').first()).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a number.')).toBeVisible();

  await go(page, `${itemsUrl()}/records/${first}`);
  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'First edited', state: 'open', rank: 1 }));
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 2 (was 1)');
  await expect(page.getByText('Revision', { exact: true }).locator('..')).toContainText('2');
});

test('a stale edit opens a conflict instead of replacing data', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Shared', state: 'open', rank: 5 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await go(other, `${itemsUrl()}/records/${id}`);
  await other.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'Theirs', state: 'done', rank: 5 }));
  await other.getByRole('button', { name: 'Save revision' }).click();
  await expect(other.getByRole('status')).toContainText('Saved revision 2');

  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'Mine', state: 'open', rank: 5 }));
  await page.getByRole('button', { name: 'Save revision' }).click();
  const conflict = page.getByRole('alert', { name: 'Edit conflict' });
  await expect(conflict).toContainText('You edited revision 1, but revision 2 is now current');
  await expect(conflict).toContainText('Theirs');
  await expect(page.getByLabel(/Data JSON/)).toHaveValue(/Mine/);
  await other.reload();
  await expect(other.getByLabel(/Data JSON/)).toHaveValue(/Theirs/);

  // Apply sends the merge the owner made in the editor, not the original draft.
  await expect(conflict).toContainText('Apply saves the text in the editor below');
  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'Merged', state: 'done', rank: 5 }));
  await conflict.getByRole('button', { name: 'Apply my edit to revision 2' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 3 (was 2)');
  await expect(page.getByLabel(/Data JSON/)).toHaveValue(/Merged/);
});

test('an edit to a concurrently deleted record keeps the draft', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Doomed', state: 'open', rank: 6 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await go(other, `${itemsUrl()}/records/${id}`);
  await other.getByRole('button', { name: 'Delete revision 1' }).click();
  await expect(other).toHaveURL(new RegExp(`${itemsUrl()}$`));

  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'Unsaved draft', state: 'open', rank: 6 }));
  await page.getByRole('button', { name: 'Save revision' }).click();
  const conflict = page.getByRole('alert', { name: 'Edit conflict' });
  await expect(conflict).toContainText('This record was deleted');
  await expect(conflict).toContainText('Unsaved draft');
  await expect(conflict.getByRole('button')).toHaveCount(0);
});

test('an uncertain delete is replayed with its original request key', async ({ page }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Lost acknowledgement', state: 'open', rank: 7 });
  await go(page, `${itemsUrl()}/records/${id}`);
  // The delete commits, but its COMMIT acknowledgement never reaches the host.
  await dropReply('COMMIT\0', 'record_tombstones');
  await page.getByRole('button', { name: 'Delete revision 1' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not deleted' })).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(page.getByRole('alert').filter({ hasText: 'Record could not be read' })).toContainText('NOT_FOUND');
  await page.getByRole('button', { name: 'Retry deletion of revision 1' }).click();
  await expect(page).toHaveURL(new RegExp(`${itemsUrl()}$`));
});

test('after a delete conflict the displayed record saves at its current revision', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Contested', state: 'open', rank: 9 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await go(other, `${itemsUrl()}/records/${id}`);
  await other.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'Changed elsewhere', state: 'done', rank: 9 }));
  await other.getByRole('button', { name: 'Save revision' }).click();
  await expect(other.getByRole('status')).toContainText('Saved revision 2');

  await page.getByRole('button', { name: 'Delete revision 1' }).click();
  await expect(page.getByRole('alert', { name: 'Edit conflict' })).toContainText('revision 2 is now current');
  await expect(page.getByLabel(/Data JSON/)).toHaveValue(/Changed elsewhere/);
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 3 (was 2)');
});

test('a create whose acknowledgement and reload both fail keeps its form and request key', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  await go(page, itemsUrl());
  const title = `Unacknowledged ${randomUUID()}`;
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title, state: 'open', rank: 8 }));
  // The create commits but its acknowledgement is lost; then the page's collection read fails.
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await dropReply('c.collection_id=$3 ORDER BY');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Collection could not be read' })).toBeVisible();
  const notice = page.getByRole('alert').filter({ hasText: 'Record was not created' });
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(notice).toContainText('Submit again unchanged');
  await expect(page.getByLabel('Data JSON')).toHaveValue(new RegExp(title));

  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
  const listed = await request.post(`/v1${itemsUrl()}/records/query`,
    { headers: { authorization: `Bearer ${ownerToken}` }, data: { predicates: [], limit: 100 } });
  const records: { canonicalData: string }[] = (await listed.json()).records;
  expect(records.filter(record => JSON.parse(record.canonicalData).title === title)).toHaveLength(1);
});

test('a schema revision whose reload fails keeps the draft and its version', async ({ browser, page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'drafts');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/drafts/schema`);
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await go(other, `${spaceUrl}/collections/drafts/schema`);
  await other.getByLabel('Definition JSON').fill(JSON.stringify(definition({ theirs: { type: 'string' } })));
  await other.getByRole('button', { name: 'Save revision' }).click();
  await expect(other.getByRole('status')).toContainText('Saved as version 2');

  await page.getByLabel('Definition JSON').fill(JSON.stringify(definition({ mine: { type: 'string' } })));
  await dropReply('c.collection_id=$3 ORDER BY');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Collection could not be read' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Definition was not saved' })).toContainText('SCHEMA_CONFLICT');
  await expect(page.getByText('Another revision was saved first')).toBeVisible();
  await expect(page.getByLabel('Definition JSON')).toHaveValue(/"mine"/);
  await expect(page.locator('input[name="version"]')).toHaveValue('1');
});

test('collection names that look like routes or dot segments stay reachable', async ({ page }) => {
  await signIn(page, ownerToken);
  // SvelteKit strips a trailing __data.json or __route.js, so the UI escapes it.
  for (const [name, segment] of [['new', 'new'], ['.', ';.'], ['..', ';..'], ['__data.json', '%5F_data.json'], ['__route.js', '%5F_route.js']]) {
    await go(page, spaceUrl);
    await page.getByRole('link', { name: 'Define collection' }).click();
    await settle(page);
    await page.getByLabel('Collection name').fill(name);
    await page.getByRole('button', { name: 'Define collection' }).click();
    await expect(page).toHaveURL(`${spaceUrl}/collections/${segment}/schema`);
    await expect(page.getByRole('main')).toContainText(`${name} · version 1`);
    await page.getByRole('link', { name: 'Records', exact: true }).click();
    await expect(page).toHaveURL(`${spaceUrl}/collections/${segment}`);
    await expect(page.getByRole('link', { name: 'Schema v1' })).toBeVisible();
  }
  await go(page, `${spaceUrl}/collections/;.`);
  await settle(page);
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'Dot', state: 'open', rank: 1 }));
  await page.getByRole('button', { name: 'Create record' }).click();
  await page.getByRole('status').getByRole('link').click();
  await expect(page.getByText('Revision', { exact: true }).locator('..')).toContainText('1');
  await expect(page.getByLabel(/Data JSON/)).toHaveValue(/Dot/);
});

test('the space switcher keeps the open space selected past the first page', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${ownerToken}` };
  for (let created = 0; created < 9; created++)
    expect((await request.post('/v1/spaces', { headers, data: { spaceId: `sp_${randomUUID()}` } })).status()).toBe(201);
  const first = await (await request.get('/v1/spaces', { headers })).json();
  const later = await (await request.get(`/v1/spaces?cursor=${encodeURIComponent(first.cursor)}`, { headers })).json();
  const spaceId: string = later.items[0].spaceId;
  await signIn(page, ownerToken);
  await go(page, `/spaces/${encodeURIComponent(spaceId)}`);
  await expect(page.getByLabel('Switch space')).toHaveValue(spaceId);
  await expect(page.getByRole('link', { name: 'More spaces' })).toBeVisible();
});

test('validation failures are announced on their fields', async ({ page }) => {
  await signIn(page, ownerToken);
  await go(page, itemsUrl());
  await page.getByLabel('Data JSON').fill('{not json');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByLabel('Data JSON')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Data must be one JSON object with finite numbers.')).toBeVisible();
  await settle(page);
  await page.getByLabel('Data JSON').fill(JSON.stringify({ state: 'open' }));
  await page.getByRole('button', { name: 'Create record' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('SCHEMA_INVALID');
  await expect(alert).toBeFocused();
  // An empty page position is a position the API judges, not the first page.
  await go(page, `${itemsUrl()}?cursor=`);
  await expect(page.getByRole('alert')).toContainText('CURSOR_INVALID');
  await expect(page.getByRole('link', { name: 'Restart from the first page' })).toBeVisible();

  // A taken collection name is reported on the name field, with a link to the collection.
  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill('items');
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page.getByRole('alert')).toContainText('A collection with this name already exists');
  await expect(page.getByRole('alert')).not.toContainText('A field is undeclared');
  await expect(page.getByLabel('Collection name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Collection name')).toHaveAccessibleDescription(/A collection named items already exists/);
  await page.getByRole('link', { name: 'Open its definition' }).click();
  await expect(page.getByRole('main')).toContainText('items · version');

  // A blank-looking key secret passes the browser's required check; the server names the field.
  await go(page, `${spaceUrl}/access`);
  await page.getByLabel('Key secret', { exact: true }).fill('  ');
  await page.getByRole('button', { name: 'Check key', exact: true }).click();
  await expect(page.getByLabel('Key secret', { exact: true })).toHaveAccessibleDescription('Enter a key secret.');
  // A space ID is an identifier: only empty is absent, so the API judges a blank-looking one.
  await go(page, '/spaces');
  await page.getByLabel('Space ID', { exact: true }).fill('  ');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(/\/spaces\/%20%20$/);
  await expect(page.getByRole('alert').first()).toBeVisible();
});

test('a number JSON cannot carry is rejected on create and replace, never stored as null', async ({ page }) => {
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill('measures');
  await page.getByLabel('Definition JSON').fill(JSON.stringify({ schema: { $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false, properties: { n: { type: ['number', 'null'] } } }, unique: [], filterable: [], sortable: [] }));
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page).toHaveURL(`${spaceUrl}/collections/measures/schema`);
  const rejected = async () => {
    await expect(page.getByLabel(/Data JSON/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Data must be one JSON object with finite numbers.')).toBeVisible();
  };
  await go(page, `${spaceUrl}/collections/measures`);
  await page.getByLabel('Data JSON').fill('{"n":1e400}');
  await page.getByRole('button', { name: 'Create record' }).click();
  await rejected();
  await expect(page.getByRole('heading', { name: 'Results · 0 matching' })).toBeVisible();

  await settle(page);
  await page.getByLabel('Data JSON').fill('{"n":1}');
  await page.getByRole('button', { name: 'Create record' }).click();
  await page.getByRole('status').getByRole('link').click();
  await settle(page);
  await page.getByLabel(/Data JSON/).fill('{"n":1e400}');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await rejected();
  await go(page, page.url());
  await expect(page.getByText('Revision', { exact: true }).locator('..')).toContainText('1');
  await expect(page.getByLabel(/Data JSON/)).toHaveValue(/"n": 1\n/);
});

test('an invalid credential is rejected without a session', async ({ page }) => {
  await signIn(page, 'not a valid bearer');
  await expect(page.getByRole('alert')).toContainText('UNAUTHENTICATED');
  await go(page, '/spaces');
  await expect(page).toHaveURL(/\/$/);
});

test('the UI cannot select an unconfigured region', async ({ page }) => {
  await signIn(page, ownerToken);
  await go(page, '/spaces');
  await page.getByLabel('Home cell (optional)').fill('cell-elsewhere');
  await page.getByRole('button', { name: 'Create space' }).click();
  await expect(page.getByRole('alert')).toContainText('INVALID_ARGUMENT');
  await expect(page).toHaveURL(/\/spaces(\?.*)?$/);
});

test('owner grants an agent key, the API enforces it and revocation is verified', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/access`);
  const items = page.getByRole('group', { name: 'Collection items' });
  await items.getByLabel('records:read').check();
  await page.getByRole('button', { name: 'Issue key' }).click();
  const secret = await page.getByLabel('Secret', { exact: true }).inputValue();
  expect(secret.length).toBeGreaterThan(20);
  await go(page, `${spaceUrl}/access`);
  expect(await page.content()).not.toContain(secret);
  await expect(page.getByRole('table')).toContainText('records:read');
  await expect(page.getByRole('table')).toContainText('active');

  const agent = await asAgent(browser, secret);
  await expect(agent.getByRole('alert')).toContainText('FORBIDDEN');
  await go(agent, itemsUrl());
  await expect(agent.getByRole('table')).toContainText('Merged');
  await agent.getByLabel('Data JSON').fill(JSON.stringify({ title: 'Agent', state: 'open', rank: 9 }));
  await agent.getByRole('button', { name: 'Create record' }).click();
  await expect(agent.getByRole('alert')).toContainText('FORBIDDEN');
  await go(agent, `${spaceUrl}/access`);
  await expect(agent.getByRole('alert').first()).toContainText(/FORBIDDEN|NOT_FOUND/);
  await go(page, `${spaceUrl}/access`);
  const live = await checkKey(page, secret);
  await expect(live).toContainText('Provider: accepted as api-key.');
  await expect(live).toContainText('This space: allowed.');

  await page.getByRole('button', { name: /^Revoke key_/ }).click();
  await expect(page.getByRole('status')).toContainText('revoked');
  await expect(await checkKey(page, secret)).toContainText('Provider: rejected (UNAUTHENTICATED).');
  await go(agent, itemsUrl());
  await expect(agent.getByRole('alert')).toContainText('UNAUTHENTICATED');

  // A failed provider revocation leaves the key denied here, visibly pending cleanup.
  if (local) {
    await go(page, `${spaceUrl}/access`);
    await items.getByLabel('records:read').check();
    await page.getByRole('button', { name: 'Issue key' }).click();
    const interrupted = await page.getByLabel('Secret', { exact: true }).inputValue();
    await go(page, `${spaceUrl}/access`);
    await failProviderRevocation();
    await page.getByRole('button', { name: /^Revoke key_/ }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Denied here; provider cleanup pending');
    const pending = await checkKey(page, interrupted);
    await expect(pending).toContainText('Provider: accepted as api-key.');
    await expect(pending).toContainText('This space: denied (NOT_FOUND).');
    await page.getByRole('button', { name: /^Retry provider revocation for key_/ }).click();
    await expect(page.getByRole('status')).toContainText('revoked');
    await expect(page.getByRole('table')).not.toContainText('provider cleanup pending');
    await expect(page.getByRole('button', { name: /^Retry provider revocation/ })).toHaveCount(0);
    await expect(await checkKey(page, interrupted)).toContainText('Provider: rejected (UNAUTHENTICATED).');
  }

  await go(page, `${spaceUrl}/audit`);
  await expect(page.getByRole('table')).toContainText('key:issue');
  await expect(page.getByRole('table')).toContainText('key:revoke');
});

test('ingestion reports per-item progress', async ({ page }) => {
  await signIn(page, ownerToken);
  await go(page, `${itemsUrl()}/batches`);
  await page.getByLabel('Operation key').first().fill('import-1');
  await page.getByLabel(/Record requests/).fill([
    JSON.stringify({ operation: 'create', data: { title: 'Bulk one', state: 'open' } }),
    JSON.stringify({ operation: 'create', data: { state: 'open' } })].join('\n'));
  await page.getByRole('button', { name: 'Submit batch' }).click();
  await expect(page.getByRole('status')).toContainText('1 succeeded');
  await expect(page.getByRole('status')).toContainText('1 failed');
  await expect(page.getByRole('table')).toContainText('SCHEMA_INVALID');
});

test('identifiers that differ only by surrounding whitespace stay distinct', async ({ page, request }) => {
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill(' items ');
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page).toHaveURL(`${spaceUrl}/collections/%20items%20/schema`);

  // The grant reaches only the selected siblings, including a whitespace-only name.
  await defineCollection(request, ' ');
  await go(page, `${spaceUrl}/access`);
  await page.getByRole('group', { name: 'Collection " items "' }).getByLabel('records:read').check();
  await page.getByRole('group', { name: 'Collection " "' }).getByLabel('records:read').check();
  await page.getByRole('button', { name: 'Issue key' }).click();
  const headers = { authorization: `Bearer ${await page.getByLabel('Secret', { exact: true }).inputValue()}` };
  expect((await request.get(`/v1${spaceUrl}/collections/%20items%20`, { headers })).status()).toBe(200);
  expect((await request.get(`/v1${spaceUrl}/collections/%20`, { headers })).status()).toBe(200);
  expect((await request.get(`/v1${spaceUrl}/collections/items`, { headers })).status()).toBe(404);

  // A padded operation key resumes its own batch, not its trimmed sibling.
  await go(page, `${itemsUrl()}/batches`);
  const line = JSON.stringify({ operation: 'create', data: { title: 'Padded', state: 'open' } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await settle(page);
    await page.getByLabel('Operation key').first().fill(' import-1 ');
    await page.getByLabel(/Record requests/).fill(line);
    await page.getByRole('button', { name: 'Submit batch' }).click();
    await expect(page).toHaveURL(/\?operation=%20import-1%20$/);
    await expect(page.getByRole('status')).toContainText('1 succeeded');
    await expect(page.getByRole('status')).not.toContainText('failed');
  }
});

test('an identifier field is absent only when empty; any other value reaches the API unchanged', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${ownerToken}` };
  const count = async () => (await request.post(`/v1${itemsUrl()}/records/count`, { headers, data: [] })).json();
  await signIn(page, ownerToken);
  // The API keeps U+FEFF in an external key, so the record is created under it.
  await go(page, itemsUrl());
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'Marked key', state: 'open' }));
  await page.getByLabel('External key (optional)').fill('﻿');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('status')).toContainText('at revision 1');
  const id = await page.getByRole('status').getByRole('link').innerText();
  const read = await request.get(`/v1${itemsUrl()}/records/${encodeURIComponent(id)}`, { headers });
  expect(JSON.stringify(await read.json())).toContain('"keyMode":"external"');
  // An invisible key is listed with a visible escape, so its link has a name.
  await go(page, itemsUrl());
  await expect(page.getByRole('link', { name: '"\\ufeff"' })).toBeVisible();

  // A whitespace-only key is the API's to reject; no generated-key record is written.
  const before = await count();
  await go(page, itemsUrl());
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'Blank key', state: 'open' }));
  await page.getByLabel('External key (optional)').fill('   ');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not created' })).toContainText('INVALID_ARGUMENT');
  expect(await count()).toBe(before);

  // A whitespace-only home cell is rejected by the API, never replaced by the default cell.
  await go(page, '/spaces');
  const spaceId = await page.locator('input[name="spaceId"]').first().inputValue();
  await page.getByLabel('Home cell (optional)').fill('   ');
  await page.getByRole('button', { name: 'Create space' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Space was not created' })).toBeVisible();
  expect((await request.get(`/v1/spaces/${spaceId}`, { headers })).status()).toBe(404);

  // A whitespace-only collection name is a valid API selector.
  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill('  ');
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page).toHaveURL(`${spaceUrl}/collections/%20%20/schema`);
  await expect(page.getByText('Enter a collection name.')).toHaveCount(0);
});

test('a schema revision with an unknown outcome is never reported as not applied', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'revisions');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/revisions/schema`);
  await page.getByLabel('Definition JSON').fill(JSON.stringify(definition({ added: { type: 'string' } })));
  // The revision commits but its acknowledgement is lost.
  await dropReply('COMMIT\0', 'UPDATE collections SET schema_version');
  await page.getByRole('button', { name: 'Save revision' }).click();
  const notice = page.getByRole('alert').filter({ hasText: 'Definition was not saved' });
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(notice).toContainText('may have committed');
  await expect(notice).not.toContainText('Retry the identical request');

  await settle(page);
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(notice).toContainText('SCHEMA_CONFLICT');
  await expect(page.getByText('The current version may already hold this edit.')).toBeVisible();
  await expect(page.getByText('your edit was not applied')).toHaveCount(0);
  await page.getByRole('link', { name: 'Load version 2' }).click();
  await expect(page.getByLabel('Definition JSON')).toHaveValue(/"added"/);
});

test('an uncertain key issuance or definition asks the owner to inspect state, never to retry for recovery', async ({ page }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/access`);
  await page.getByRole('group', { name: 'Collection items' }).getByLabel('records:read').check();
  // Issuance completion, its readback and its retry all lose their replies.
  await dropReply('SET completed_at=clock_timestamp()');
  await dropReply('SELECT i.completed_at');
  await dropReply('SET completed_at=COALESCE');
  await page.getByRole('button', { name: 'Issue key' }).click();
  const issue = page.getByRole('alert').filter({ hasText: 'Key was not issued' });
  await expect(issue).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(issue).toContainText('Check the key list');
  await expect(issue).not.toContainText('Retry the identical request');

  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill('uncertain');
  await dropReply('COMMIT\0', 'INSERT INTO collection_versions');
  await page.getByRole('button', { name: 'Define collection' }).click();
  const notice = page.getByRole('alert').filter({ hasText: 'Definition was not saved' });
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(notice).toContainText('Check whether it exists before submitting again');
  await expect(notice).not.toContainText('Retry the identical request');
  await settle(page);
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(notice).toContainText('SCHEMA_CONFLICT');
  await expect(notice).toContainText('A collection with this name already exists');
  await expect(page.getByLabel('Collection name')).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('link', { name: 'Open its definition' }).click();
  await expect(page.getByRole('main')).toContainText('uncertain · version 1');
});

test('failed listings are reported, not shown as empty or truncated', async ({ page }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  await dropReply('ORDER BY c.collection_id LIMIT 9)');
  await go(page, `${spaceUrl}/access`);
  await expect(page.getByRole('alert').filter({ hasText: 'Collections could not all be listed' })).toContainText('PROVIDER_UNAVAILABLE');
  await expect(page.getByText('Only the first 96 collections')).toHaveCount(0);

  await go(page, `${spaceUrl}/audit?cursor=malformed`);
  await expect(page.getByRole('alert')).toContainText('CURSOR_INVALID');
  await page.getByRole('link', { name: 'Start again from the first page' }).click();
  await expect(page.getByRole('table')).toContainText('space:create');
});

test('pages pass accessibility checks, keyboard use and small screens', async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await go(page, '/');
    await audit(page);
    await signIn(page, ownerToken);
    const id = await createRecord(page, { title: 'Layout', state: 'open', rank: 1 });
    for (const path of ['/spaces', spaceUrl, itemsUrl(), `${itemsUrl()}/schema`, `${itemsUrl()}/records/${id}`,
      `${itemsUrl()}/events`, `${itemsUrl()}/batches`, `${spaceUrl}/access`, `${spaceUrl}/audit`, `${spaceUrl}/new-collection`]) {
      await go(page, path);
      await audit(page);
      await expect(page.locator('title')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} at ${width}px`).toBe(true);
    }
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
  await settle(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Bearer credential')).toBeFocused();
  await page.keyboard.type(ownerToken);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible();
});

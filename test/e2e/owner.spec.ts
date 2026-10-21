import { createHmac, randomUUID } from 'node:crypto';
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
async function createRecord(page: Page, data: object, url = itemsUrl()) {
  await go(page, url);
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
/** Fail the next message containing `match` before the database receives it. */
async function refuse(match: string) {
  const response = await fetch('http://127.0.0.1:5744/fault', { method: 'POST', body: JSON.stringify({ match, refuse: true }) });
  expect(response.status).toBe(204);
}
const definition = (properties: object) => ({ schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, ...properties } }, unique: [], filterable: [], sortable: [] });
async function defineCollection(request: APIRequestContext, name: string, overrides: object = {}) {
  const response = await request.put(`/v1${spaceUrl}/collections/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${ownerToken}` }, data: { ...definition({}), slug: name, version: 1, ...overrides } });
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
  await expect(page).toHaveURL(/dir=desc/);
  await settle(page);
  await expect(page.getByRole('table')).toContainText('Third');
  // Counting is a separate request the owner asks for; it keeps the page and its query.
  await expect(page.getByRole('heading', { name: /matching/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Count matching records' }).click();
  await expect(page.getByRole('heading', { name: 'Results · 2 matching' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Third');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('table')).toContainText('First');
  await expect(page.getByRole('heading', { name: /matching/ })).toHaveCount(0);
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

test('a delete that finds the record gone never claims the deletion was not applied', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Already gone', state: 'open', rank: 6 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await go(other, `${itemsUrl()}/records/${id}`);
  await other.getByRole('button', { name: 'Delete revision 1' }).click();
  await expect(other).toHaveURL(new RegExp(`${itemsUrl()}$`));

  // Another writer removed it here; an expired retry of this same deletion reads the same way.
  await page.getByRole('button', { name: 'Delete revision 1' }).click();
  const gone = page.getByRole('alert', { name: 'Record is gone' });
  await expect(gone).toContainText('This deletion may already have removed it, or another writer did.');
  await expect(gone).not.toContainText('not applied');
  await expect(gone.getByRole('button')).toHaveCount(0);
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
  await expect(page.getByLabel('Data JSON')).toHaveValue(new RegExp(title));
  const titles = async () => {
    const listed = await request.post(`/v1${itemsUrl()}/records/query`,
      { headers: { authorization: `Bearer ${ownerToken}` }, data: { predicates: [], limit: 100 } });
    return ((await listed.json()).records as { canonicalData: string }[]).map(record => JSON.parse(record.canonicalData).title);
  };

  // Retry unchanged resends the retained request, not the editor's changed text.
  await settle(page);
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: `${title} changed`, state: 'open', rank: 8 }));
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
  expect((await titles()).filter(item => item.startsWith(title))).toEqual([title]);
});

test('an unresolved create stays on the page until it is retried, whatever later requests return', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'creates');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/creates`);
  const editor = page.getByLabel('Data JSON');
  const notice = page.getByRole('alert').filter({ hasText: 'Record was not created' });
  const unresolved = page.getByText('An earlier create may have committed');
  const retry = page.getByRole('button', { name: 'Retry unchanged' });
  const sendNew = page.getByRole('button', { name: 'Send as new request' });
  const titles = async () => {
    const listed = await request.post(`/v1${spaceUrl}/collections/creates/records/query`,
      { headers: { authorization: `Bearer ${ownerToken}` }, data: { predicates: [], limit: 100 } });
    return ((await listed.json()).records as { canonicalData: string }[]).map(record => JSON.parse(record.canonicalData).title).sort();
  };
  await editor.fill(JSON.stringify({ title: 'original' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');

  // Drafts that are malformed, or refused by the schema, wrote nothing: the first create stays unresolved.
  for (const typo of ['{"title": "changed"', '{"title": "changed"']) {
    await settle(page);
    await editor.fill(typo);
    await sendNew.click();
    await expect(editor).toHaveAccessibleDescription('Data must be one JSON object with finite numbers.');
    await expect(unresolved).toBeVisible();
    await expect(retry).toBeVisible();
  }
  await settle(page);
  await editor.fill(JSON.stringify({ name: 'no title' }));
  await sendNew.click();
  await expect(notice).toContainText('SCHEMA_INVALID');
  await expect(unresolved).toBeVisible();
  await audit(page);
  expect(await titles()).toEqual(['original']);

  // Retry unchanged, by keyboard, recovers the first create once and keeps the unsent draft.
  await settle(page);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
  await expect(unresolved).toHaveCount(0);
  await expect(editor).toHaveValue(JSON.stringify({ name: 'no title' }));
  expect(await titles()).toEqual(['original']);

  // A changed draft sent as new is created, and the unresolved create stays until it is retried.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(unresolved).toBeVisible();
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second changed' }));
  await sendNew.click();
  await expect(page.getByRole('status')).toContainText('at revision 1.');
  await expect(unresolved).toBeVisible();
  expect(await titles()).toEqual(['original', 'second', 'second changed']);
  await settle(page);
  await retry.click();
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
  await expect(unresolved).toHaveCount(0);
  expect(await titles()).toEqual(['original', 'second', 'second changed']);
});

test('a retry whose key now belongs to another request says the write is no longer tracked', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'rekeyed');
  await signIn(page, ownerToken);
  const rekeyed = `${spaceUrl}/collections/rekeyed`;
  await go(page, rekeyed);
  const headers = { authorization: `Bearer ${ownerToken}` };
  const keyedWrite = async (path: string, key: string, body: object) =>
    expect((await request.post(`/v1${path}/records`, { headers, data: { ...body, idempotencyKey: key } })).ok()).toBe(true);
  // The create never reaches the database, so its key is still free for another request.
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'never sent' }));
  await refuse('INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByText('An earlier create may have committed')).toBeVisible();
  await keyedWrite(rekeyed, await page.locator('input[name="pendingKey"]').inputValue(), { operation: 'create', data: { title: 'other' } });
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  const created = page.getByRole('region', { name: 'Create a record' }).getByRole('alert');
  await expect(created).toContainText('The earlier create is no longer tracked: IDEMPOTENCY_MISMATCH');
  await expect(created).toContainText('Check the records list');
  await expect(created).not.toContainText(/still unresolved|Retry that request/);
  await expect(page.getByRole('button', { name: 'Retry unchanged' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create record' })).toBeVisible();

  // The same for a save whose request never reached the database.
  const id = await createRecord(page, { title: 'saved' }, rekeyed);
  await go(page, `${rekeyed}/records/${id}`);
  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ title: 'never saved' }));
  await refuse('UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('An earlier save may have committed')).toBeVisible();
  await keyedWrite(rekeyed, await page.locator('input[name="pendingKey"]').first().inputValue(),
    { operation: 'replace', id, expectedRevision: 1, data: { title: 'other save' } });
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  const saved = page.getByRole('region', { name: 'Edit data' }).getByRole('alert');
  await expect(saved).toContainText('The earlier save is no longer tracked: IDEMPOTENCY_MISMATCH');
  await expect(saved).toContainText('Check the current record');
  await expect(saved).not.toContainText(/still unresolved|Retry that request/);
  await expect(page.getByRole('button', { name: 'Retry unchanged' })).toHaveCount(0);
});

test('a records table shows an absent field named like an Object member as absent', async ({ page, request }) => {
  await defineCollection(request, 'members', definition({ constructor: { type: 'string' }, toString: { type: ['number', 'null'] }, valueOf: { type: 'string' } }));
  await signIn(page, ownerToken);
  await createRecord(page, { title: 'bare' }, `${spaceUrl}/collections/members`);
  await createRecord(page, { title: 'set', constructor: 'built', toString: null, valueOf: '' }, `${spaceUrl}/collections/members`);
  await go(page, `${spaceUrl}/collections/members`);
  const cells = (title: string) => page.getByRole('row').filter({ hasText: title }).getByRole('cell');
  // Columns follow the stored definition: constructor, title, toString, valueOf.
  await expect(cells('bare')).toHaveText([/./, '1', '—', 'bare', '—', '—']);
  await expect(cells('set')).toHaveText([/./, '1', 'built', 'set', 'null', '']);
});

test('a size rejection is a known outcome, so no retry is offered', async ({ page }) => {
  await signIn(page, ownerToken);
  await go(page, itemsUrl());
  // Over the 1 MiB record body limit: nonretryable RATE_LIMITED before any write.
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'x'.repeat(1_100_000), state: 'open', rank: 1 }));
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not created' })).toContainText('RATE_LIMITED');
  await expect(page.getByText('may have committed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry unchanged' })).toHaveCount(0);
});

test('after a lost save acknowledgement, retry recovers it and a changed draft is compared first', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Acknowledged later', state: 'open', rank: 11 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const editor = page.getByLabel(/Data JSON/);
  const notice = page.getByRole('alert').filter({ hasText: 'Record was not saved' });
  const read = async () => (await request.get(`/v1${itemsUrl()}/records/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${ownerToken}` } })).json();

  // The replace commits but its acknowledgement is lost; the owner then changes the draft.
  await editor.fill(JSON.stringify({ title: 'first edit', state: 'open', rank: 11 }));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');
  // A malformed draft is refused on its field and leaves the unresolved save.
  const unresolved = page.getByText('An earlier save may have committed');
  await settle(page);
  await editor.fill('{"title":');
  await page.getByRole('button', { name: 'Send as new request' }).click();
  await expect(editor).toHaveAccessibleDescription('Data must be one JSON object with finite numbers.');
  await expect(unresolved).toBeVisible();
  // A changed draft sent as new meets the first save's revision instead of replacing it.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second edit', state: 'open', rank: 11 }));
  await page.getByRole('button', { name: 'Send as new request' }).click();
  const conflict = page.getByRole('alert', { name: 'Edit conflict' });
  await expect(conflict).toContainText('You edited revision 1, but revision 2 is now current');
  await expect(conflict).toContainText('first edit');
  await expect(editor).toHaveValue(/second edit/);
  await conflict.getByRole('button', { name: 'Apply my edit to revision 2' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 3 (was 2)');
  // The first save stays unresolved until its retry recovers it; the editor keeps revision 3.
  await expect(unresolved).toBeVisible();
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 2 (was 1), recovered from an earlier identical request');
  await expect(unresolved).toHaveCount(0);
  await expect(editor).toHaveValue(/second edit/);
  await expect(page.locator('input[name="expectedRevision"]').first()).toHaveValue('3');

  // Retry unchanged resends the lost request, whatever the editor now holds, and keeps that text.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'third edit', state: 'open', rank: 11 }));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(notice).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await settle(page);
  await editor.fill('{"title": "not sent"');
  await page.getByRole('button', { name: 'Send as new request' }).click();
  await expect(unresolved).toBeVisible();
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'not sent', state: 'open', rank: 11 }));
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 4 (was 3), recovered from an earlier identical request');
  const record = await read();
  expect([record.revision, JSON.parse(record.canonicalData).title]).toEqual([4, 'third edit']);
  await expect(editor).toHaveValue(/not sent/);
  // The kept text saves on top of the recovered revision.
  await settle(page);
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 5 (was 4)');
  expect(JSON.parse((await read()).canonicalData).title).toBe('not sent');
});

test('keeping the current revision after a conflict keeps every unresolved save', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Kept', state: 'open', rank: 13 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const editor = page.getByLabel(/Data JSON/);
  const unresolved = page.getByText('An earlier save may have committed');
  const conflict = page.getByRole('alert', { name: 'Edit conflict' });
  await editor.fill(JSON.stringify({ title: 'lost ack', state: 'open', rank: 13 }));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(unresolved).toBeVisible();
  await expect(page.getByText('Only this page tracks them: leaving or reloading it stops tracking them.')).toBeVisible();
  // An edit conflict, then Keep: the draft goes, the unresolved save stays retryable.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'discarded', state: 'open', rank: 13 }));
  await page.getByRole('button', { name: 'Send as new request' }).click();
  await conflict.getByRole('button', { name: 'Keep current revision' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(unresolved).toBeVisible();
  await expect(editor).toHaveValue(/lost ack/);
  // A delete conflict, then Keep: the deletion goes, the unresolved save stays retryable.
  const other = await request.post(`/v1${itemsUrl()}/records`, { headers: { authorization: `Bearer ${ownerToken}` },
    data: { operation: 'replace', id, expectedRevision: 2, idempotencyKey: `e2e-${randomUUID()}`, data: { title: 'elsewhere', state: 'open', rank: 13 } } });
  expect(other.ok()).toBe(true);
  await settle(page);
  await page.getByRole('button', { name: 'Delete revision 2' }).click();
  await expect(conflict).toContainText('revision 3 is now current');
  await conflict.getByRole('button', { name: 'Keep current revision' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(editor).toHaveValue(/elsewhere/);
  await expect(page.getByRole('button', { name: 'Retry unchanged' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 2 (was 1), recovered from an earlier identical request');
  await expect(unresolved).toHaveCount(0);
});

/** Suspend the test space, or make it active again. */
async function setLifecycle(request: APIRequestContext, lifecycle: string) {
  const response = await request.patch(`/v1${spaceUrl}`, { headers: { authorization: `Bearer ${ownerToken}` }, data: { lifecycle } });
  expect(response.status()).toBe(200);
}

test('a refused retry keeps an unresolved create, and each lost create stays recoverable', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'refused');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/refused`);
  const editor = page.getByLabel('Data JSON');
  const entries = page.locator('#create-pending li');
  const titles = async () => {
    const listed = await request.post(`/v1${spaceUrl}/collections/refused/records/query`,
      { headers: { authorization: `Bearer ${ownerToken}` }, data: { predicates: [], limit: 100 } });
    return ((await listed.json()).records as { canonicalData: string }[]).map(record => JSON.parse(record.canonicalData).title).sort();
  };
  await editor.fill(JSON.stringify({ title: 'original' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not created' })).toContainText('COMMIT_OUTCOME_UNKNOWN');
  const key = await page.locator('input[name="pendingKey"]').inputValue();

  // Refusals before the key is looked up say nothing about the first create: it stays.
  const refusal = (code: string) => page.getByRole('region', { name: 'Create a record' }).getByRole('alert').filter({ hasText: code });
  try {
    await setLifecycle(request, 'suspended');
    await settle(page);
    await page.getByRole('button', { name: 'Retry unchanged' }).click();
    await expect(refusal('SPACE_UNAVAILABLE')).toBeVisible();
  } finally { await setLifecycle(request, 'active'); }
  await expect(page.locator('input[name="pendingKey"]')).toHaveValue(key);
  await expect(refusal('SPACE_UNAVAILABLE')).toContainText('The earlier create is still unresolved');
  await expect(entries).toHaveCount(1);
  const session = (await page.context().cookies()).find(cookie => cookie.name === 'stateplane_session')!;
  await page.context().addCookies([{ ...session, value: 'not-a-session' }]);
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  // Another session is another credential, so nothing is sent.
  await expect(refusal('OTHER_CREDENTIAL')).toBeVisible();
  await expect(page.locator('input[name="pendingKey"]')).toHaveValue(key);
  await page.context().addCookies([session]);

  // A second lost create joins the first instead of replacing it.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Send as new request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not created' })).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(page.getByText('2 earlier creates may have committed')).toBeVisible();
  await expect(entries.nth(0)).toContainText('"original"');
  await expect(entries.nth(1)).toContainText('"second"');
  // Each control is described by the explanation and its own request only.
  const firstRetry = entries.nth(0).getByRole('button', { name: 'Retry unchanged' });
  await expect(firstRetry).toHaveAccessibleDescription(/^The outcome is unknown\..*"original".*retry window closes at/);
  await expect(firstRetry).not.toHaveAccessibleDescription(/"second"|Forget this request/);
  await expect(entries.nth(1).getByRole('button', { name: 'Forget this request' })).toHaveAccessibleDescription(/^\{.*"second".*\}.*retry window closes at[^.]*\.$/);
  await audit(page);
  expect(await titles()).toEqual(['original', 'second']);
  for (const recovered of ['original', 'second']) {
    await settle(page);
    await entries.first().getByRole('button', { name: 'Retry unchanged' }).click();
    await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
    await expect(entries.filter({ hasText: `"${recovered}"` })).toHaveCount(0);
  }
  await expect(entries).toHaveCount(0);
  expect(await titles()).toEqual(['original', 'second']);
});

test('an unresolved create is retried only under the credential that sent it', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'bound');
  const headers = { authorization: `Bearer ${ownerToken}` };
  const issued = await request.post(`/v1${spaceUrl}/agent-keys`, { headers, data: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    grants: [{ collectionId: 'bound', capabilities: ['records:read', 'records:write'] }] } });
  expect(issued.status()).toBe(201);
  const titles = async () => {
    const listed = await request.post(`/v1${spaceUrl}/collections/bound/records/query`, { headers, data: { predicates: [], limit: 100 } });
    return ((await listed.json()).records as { canonicalData: string }[]).map(record => JSON.parse(record.canonicalData).title);
  };
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/bound`);
  await page.getByLabel('Data JSON').fill(JSON.stringify({ title: 'once' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not created' })).toContainText('COMMIT_OUTCOME_UNKNOWN');
  const key = await page.locator('input[name="pendingKey"]').inputValue();
  expect(await titles()).toEqual(['once']);

  // Another tab signs in with a records:write agent key; tabs share the session cookie.
  const session = (await page.context().cookies()).find(cookie => cookie.name === 'stateplane_session')!;
  await page.context().addCookies([{ ...session, value: (await issued.json()).secret }]);
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  const refusal = page.getByRole('region', { name: 'Create a record' }).getByRole('alert');
  await expect(refusal).toContainText('OTHER_CREDENTIAL');
  await expect(refusal).toContainText('The earlier create is still unresolved');
  await expect(refusal).toContainText('Nothing was sent. Another credential sent it, and only that credential can recover it');
  await expect(page.locator('input[name="pendingKey"]')).toHaveValue(key);
  // The write stays listed for the credential that sent it, never as an expired window.
  const entry = page.locator('#create-pending li');
  await expect(entry).toContainText('sign in with that credential to retry it');
  await expect(entry).not.toContainText('retry window');
  await expect(page.locator('input[name="pendingBy"]')).not.toHaveValue(/^$|agent|sp_/);
  expect(await titles()).toEqual(['once']);

  // Back under the credential that sent it, the retry recovers the create instead of repeating it.
  await page.context().addCookies([session]);
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
  await expect(entry).toHaveCount(0);
  expect(await titles()).toEqual(['once']);
});

test('a refused save retry keeps the unresolved save until it recovers', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Suspended later', state: 'open', rank: 12 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const editor = page.getByLabel(/Data JSON/);
  await editor.fill(JSON.stringify({ title: 'first edit', state: 'open', rank: 12 }));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Record was not saved' })).toContainText('COMMIT_OUTCOME_UNKNOWN');
  try {
    await setLifecycle(request, 'suspended');
    await settle(page);
    await page.getByRole('button', { name: 'Retry unchanged' }).click();
    await expect(page.getByRole('region', { name: 'Edit data' }).getByRole('alert')).toContainText('SPACE_UNAVAILABLE');
  } finally { await setLifecycle(request, 'active'); }
  await expect(page.getByText('An earlier save may have committed')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Edit data' }).getByRole('alert')).toContainText('The earlier save is still unresolved');
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('Saved revision 2 (was 1), recovered from an earlier identical request');
  const read = async () => (await request.get(`/v1${itemsUrl()}/records/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${ownerToken}` } })).json();
  const record = await read();
  expect([record.revision, JSON.parse(record.canonicalData).title]).toEqual([2, 'first edit']);

  // Only the owner's explicit Forget stops tracking a save; it sends nothing and keeps the draft.
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second edit', state: 'open', rank: 12 }));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('An earlier save may have committed')).toBeVisible();
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'kept draft', state: 'open', rank: 12 }));
  await page.getByRole('button', { name: 'Forget this request' }).click();
  await expect(page.getByText('An earlier save may have committed')).toHaveCount(0);
  await expect(editor).toHaveValue(/kept draft/);
  await expect(page.getByRole('button', { name: 'Save revision' })).toBeVisible();
  expect((await read()).revision).toBe(3);
});

test('unresolved saves and the editor stay when a later save succeeds but the record cannot be reread', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  const id = await createRecord(page, { title: 'Reread fails', state: 'open', rank: 13 });
  await go(page, `${itemsUrl()}/records/${id}`);
  const editor = page.getByLabel(/Data JSON/);
  const entries = page.locator('#save-pending li');
  const conflict = page.getByRole('alert', { name: 'Edit conflict' });
  const edit = (title: string) => JSON.stringify({ title, state: 'open', rank: 13 });
  // Two saves commit with lost acknowledgements; the second is applied over the first.
  await editor.fill(edit('first edit'));
  await dropReply('COMMIT\0', 'UPDATE records SET');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(entries).toHaveCount(1);
  for (const [title, revision] of [['second edit', 2], ['third edit', 3]] as const) {
    await settle(page);
    await editor.fill(edit(title));
    await page.getByRole('button', { name: 'Send as new request' }).click();
    await expect(conflict).toContainText(`revision ${revision} is now current`);
    if (revision === 2) await dropReply('COMMIT\0', 'UPDATE records SET');
    // The last Apply succeeds, but the page's record read after it is refused.
    else await refuse('tombstone FROM records');
    await conflict.getByRole('button', { name: `Apply my edit to revision ${revision}` }).click();
    if (revision === 2) {
      await expect(entries).toHaveCount(2);
      const retry = entries.nth(1).getByRole('button', { name: 'Retry unchanged' });
      await expect(retry).toHaveAccessibleDescription(/"second edit"/);
      await expect(retry).not.toHaveAccessibleDescription(/"first edit"|Forget this request/);
      await audit(page);
    }
  }
  await expect(page.getByRole('status')).toContainText('Saved revision 4 (was 3)');
  await expect(page.getByRole('alert').filter({ hasText: 'Record could not be read' })).toContainText('PROVIDER_UNAVAILABLE');
  await expect(editor).toHaveValue(/third edit/);
  await expect(entries).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Forget this request' })).toHaveCount(2);
  // Each still recovers its own receipt, and nothing is written twice.
  for (const recovered of ['Saved revision 2 (was 1)', 'Saved revision 3 (was 2)']) {
    await settle(page);
    await entries.first().getByRole('button', { name: 'Retry unchanged' }).click();
    await expect(page.getByRole('status')).toContainText(`${recovered}, recovered from an earlier identical request`);
  }
  await expect(entries).toHaveCount(0);
  const record = await (await request.get(`/v1${itemsUrl()}/records/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${ownerToken}` } })).json();
  expect([record.revision, JSON.parse(record.canonicalData).title]).toEqual([4, 'third edit']);
});

test('an unresolved create stays when a later create succeeds but the collection cannot be reread', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'rereads');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/rereads`);
  const editor = page.getByLabel('Data JSON');
  await editor.fill(JSON.stringify({ title: 'original' }));
  await dropReply('COMMIT\0', 'INSERT INTO records(');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByText('An earlier create may have committed')).toBeVisible();
  await settle(page);
  await editor.fill(JSON.stringify({ title: 'second' }));
  await dropReply('c.collection_id=$3 ORDER BY');
  await page.getByRole('button', { name: 'Send as new request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Collection could not be read' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('at revision 1.');
  await expect(page.getByText('An earlier create may have committed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forget this request' })).toHaveCount(1);
  await settle(page);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(page.getByRole('status')).toContainText('(recovered earlier result)');
});

test('a create is retried only within its receipt window, which a posted time cannot extend', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy and host secret');
  await defineCollection(request, 'windows');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/windows`);
  const editor = page.getByLabel('Data JSON');
  const entry = page.locator('#create-pending li');
  const refusal = page.getByRole('region', { name: 'Create a record' }).getByRole('alert');
  const count = async () => (await (await request.post(`/v1${spaceUrl}/collections/windows/records/count`,
    { headers: { authorization: `Bearer ${ownerToken}` }, data: [] })).json()) as number;
  // The COMMIT never reaches the database: nothing is written, and the outcome is unknown.
  // A retry that was sent would therefore create the record.
  const lose = async () => {
    const response = await fetch('http://127.0.0.1:5744/fault', { method: 'POST', body: JSON.stringify({ match: 'COMMIT\0', after: 'INSERT INTO records(', refuse: true }) });
    expect(response.status).toBe(204);
    await page.getByRole('button', { name: 'Create record' }).click();
    await expect(refusal).toContainText('COMMIT_OUTCOME_UNKNOWN');
    await settle(page);
  };
  const stamp = async (at: (current: string) => string, signed: boolean) => {
    const key = await entry.locator('input[name="pendingKey"]').inputValue();
    const sent = await entry.locator('input[name="pendingSent"]').inputValue();
    const host = createHmac('sha256', Buffer.from(process.env.STATEPLANE_E2E_CURSOR_SECRET!, 'hex')).update('stateplane-ui-unresolved-write-v1').digest();
    // Each write is sealed for the credential that sent it.
    const secret = createHmac('sha256', host).update(`seal\0${ownerToken}`).digest();
    const time = at(await entry.locator('input[name="pendingAt"]').inputValue());
    const seal = createHmac('sha256', secret).update(JSON.stringify([key, sent, time])).digest('base64url');
    await entry.locator('input[name="pendingAt"]').evaluate((input: HTMLInputElement, value) => { input.value = value; }, time);
    if (signed) await entry.locator('input[name="pendingSeal"]').evaluate((input: HTMLInputElement, value) => { input.value = value; }, seal);
  };
  await editor.fill(JSON.stringify({ title: 'original' }));
  await lose();
  await expect(entry).toContainText(/Its retry window closes at \d{4}-\d\d-\d\d \d\d:\d\d UTC\./);

  // Two hours later, as the server would have signed it then: the receipt has expired, so nothing is sent.
  await stamp(current => String(Number(current) - 2 * 3600_000), true);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(refusal).toContainText('The earlier create is still unresolved');
  await expect(refusal).toContainText('RECEIPT_EXPIRED');
  await expect(entry).toContainText(/Its retry window closed at .* UTC, so a retry could create it again\. Check the records list/);
  await expect(page.getByRole('button', { name: 'Retry unchanged' })).toBeDisabled();
  expect(await count()).toBe(0);
  await audit(page);
  // Only Forget removes it.
  await page.getByRole('button', { name: 'Forget this request' }).click();
  await expect(entry).toHaveCount(0);
  expect(await count()).toBe(0);

  // A later time without the server's signature cannot extend the window.
  await settle(page);
  await lose();
  await stamp(current => String(Number(current) + 3600_000), false);
  await page.getByRole('button', { name: 'Retry unchanged' }).click();
  await expect(refusal).toContainText('RECEIPT_EXPIRED');
  await expect(entry).toContainText('Its retry window cannot be confirmed');
  expect(await count()).toBe(0);
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
  await expect(page.getByLabel('Data JSON')).toHaveAccessibleDescription(/does not satisfy the collection schema/);
  // The edit form describes a schema failure on its field too.
  const id = await createRecord(page, { title: 'Valid', state: 'open' });
  await go(page, `${itemsUrl()}/records/${id}`);
  await page.getByLabel(/Data JSON/).fill(JSON.stringify({ state: 'open' }));
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByLabel(/Data JSON/)).toHaveAccessibleDescription(/does not satisfy the collection schema/);
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
  await expect(page.getByText('No records yet.')).toBeVisible();

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

test('long and invisible identifiers stay distinct, named and inside a small screen', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${ownerToken}` };
  const created = await request.post('/v1/spaces', { headers, data: { spaceId: `sp_${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const previous = spaceUrl;
  spaceUrl = `/spaces/${(await created.json()).spaceId}`;
  const long = 'a'.repeat(256);
  try {
    for (const name of [long, '\u200b', 'a\ufeffb', 'ab']) await defineCollection(request, name);
    await page.setViewportSize({ width: 390, height: 900 });
    await signIn(page, ownerToken);
    for (const path of [spaceUrl, `${spaceUrl}/collections/${long}`, `${spaceUrl}/collections/${long}/schema`]) {
      await go(page, path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
      await audit(page);
    }
    await go(page, spaceUrl);
    for (const name of ['"\\u200b"', '"a\\ufeffb"', 'ab']) await expect(page.getByRole('link', { name, exact: true })).toBeVisible();

    // Field names are displayed by the same rule, wherever they appear.
    const fields = ['\u200b', '\u200c', 'f'.repeat(256)];
    const named = ['"\\u200b"', '"\\u200c"', 'f'.repeat(256)];
    await defineCollection(request, 'fields', { ...definition(Object.fromEntries(fields.map(field => [field, { type: 'string' }]))),
      filterable: fields, sortable: fields });
    await go(page, `${spaceUrl}/collections/fields/schema`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await audit(page);
    for (const name of named) {
      await page.getByRole('button', { name: `Build ${name} index`, exact: true }).click();
      await expect(page.getByRole('status')).toHaveText(`Index ${name} is ready.`);
    }
    for (const name of named) await expect(page.getByRole('listitem').getByText(name, { exact: true })).toBeVisible();
    await createRecord(page, { title: 'Shown' }, `${spaceUrl}/collections/fields`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await audit(page);
    expect((await page.getByLabel('Field').first().locator('option').allInnerTexts()).slice(1).sort())
      .toEqual(named.map(name => `${name} (string)`).sort());
    expect((await page.getByLabel('Sort by').locator('option').allInnerTexts()).slice(1).sort()).toEqual([...named].sort());
    for (const name of named) await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
    await page.getByLabel('Sort by').selectOption({ label: '"\\u200c"' });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/sort=%E2%80%8C/);
    await settle(page);
    await page.getByRole('link', { name: 'Count matching records' }).click();
    await expect(page.getByRole('heading', { name: /1 matching/ })).toBeVisible();
  } finally { spaceUrl = previous; }
});

test('identifiers with line breaks travel through index, filter and sort forms exactly', async ({ browser, page, request }) => {
  const headers = { authorization: `Bearer ${ownerToken}` };
  const created = await request.post('/v1/spaces', { headers, data: { spaceId: `sp_${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const previous = spaceUrl;
  spaceUrl = `/spaces/${(await created.json()).spaceId}`;
  try {
    await defineCollection(request, 'lines', { ...definition({ 'x\ny': { type: 'string' } }), filterable: ['x\ny'], sortable: ['x\ny'] });
    // Native form posts submit a line break as CRLF, so the no-script forms must carry it escaped.
    const native = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
    for (const viewer of [native, page]) await signIn(viewer, ownerToken);

    // No-script form posts and GET forms reach the field "x\ny"; so does the hydrated filter.
    await go(native, `${spaceUrl}/collections/lines/schema`);
    await native.getByRole('button', { name: 'Build "x\\ny" index', exact: true }).click();
    await expect(native.getByRole('status')).toHaveText('Index "x\\ny" is ready.');
    for (const value of ['v', 'w']) await createRecord(page, { title: value, 'x\ny': value }, `${spaceUrl}/collections/lines`);
    for (const viewer of [native, page]) {
      await go(viewer, `${spaceUrl}/collections/lines`);
      await viewer.getByLabel('Field').first().selectOption({ label: '"x\\ny" (string)' });
      await viewer.getByLabel('Value').first().fill('w');
      await viewer.getByLabel('Sort by').selectOption({ label: '"x\\ny"' });
      await viewer.getByRole('button', { name: 'Apply' }).click();
      await expect(viewer).toHaveURL(/sort=/);
      await settle(viewer);
      await viewer.getByRole('link', { name: 'Count matching records' }).click();
      await expect(viewer.getByRole('heading', { name: /1 matching/ })).toBeVisible();
      await expect(viewer.getByLabel('Sort by').locator('option:checked')).toHaveText('"x\\ny"');
    }
  } finally { spaceUrl = previous; }
});

test('page navigation never counts, and a failed count leaves the records in place', async ({ page }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  await go(page, `${itemsUrl()}?limit=1`);
  // An armed count failure survives page navigation: no page load counts.
  await refuse('SELECT count(*)::bigint');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByRole('link', { name: 'First page', exact: true })).toBeVisible();
  await settle(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('table')).toBeVisible();
  // The owner's count is the request that meets it, and the page's records stay.
  await page.getByRole('link', { name: 'Count matching records' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Matching records could not be counted' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Records could not be read' })).toHaveCount(0);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page).toHaveURL(/cursor=/);
  // The failed count offers its retry in place.
  await page.getByRole('link', { name: 'Count matching records' }).click();
  await expect(page.getByRole('heading', { name: /matching$/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a filter or sort the authority would refuse is reported on its field and never sent', async ({ page, request }) => {
  await defineCollection(request, 'checks', { ...definition({ note: { type: 'string' }, size: { type: 'number' } }),
    filterable: ['note'], sortable: ['note'] });
  await signIn(page, ownerToken);
  const checks = `${spaceUrl}/collections/checks`;
  // The note index is declared but not yet built; size is declared but not filterable.
  await go(page, `${checks}?field=note&op=eq&value=x&sort=note`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Value').first()).toHaveAccessibleDescription(/still being built/);
  await expect(page.getByLabel('Field').first()).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Sort by')).toHaveAccessibleDescription(/still being built/);
  await expect(page.getByLabel('Sort by').locator('option:checked')).toHaveText('note (unavailable)');
  await go(page, `${checks}?field=size&op=eq&value=1`);
  await expect(page.getByLabel('Value').first()).toHaveAccessibleDescription('This field is not filterable.');

  const headers = { authorization: `Bearer ${ownerToken}` };
  expect((await request.post(`/v1${checks}/indexes/note`, { headers })).status()).toBe(200);
  // A seventeenth filter and a value past 512 UTF-8 bytes are refused before any request.
  await go(page, `${checks}?${Array.from({ length: 17 }, () => 'field=note&op=eq&value=x').join('&')}`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Value').nth(16)).toHaveAccessibleDescription(/At most 16 filters/);
  await expect(page.getByLabel('Value')).toHaveCount(17);
  await go(page, `${checks}?field=note&op=eq&value=${encodeURIComponent('é'.repeat(257))}`);
  await expect(page.getByLabel('Value').first()).toHaveAccessibleDescription(/512 bytes/);
  // The authority refuses U+0000 in text, so the row says so instead of a refused query.
  await go(page, `${checks}?field=note&op=in&value=ok,%00`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Value').first()).toHaveAccessibleDescription(/U\+0000/);
  await go(page, `${checks}?field=note&op=eq&value=${encodeURIComponent('é'.repeat(256))}&sort=note`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('No records match these filters.')).toBeVisible();
});

test('a key granted only changes opens them from the space page, and still reads no records', async ({ browser, request }) => {
  const headers = { authorization: `Bearer ${ownerToken}` };
  const issued = await request.post(`/v1${spaceUrl}/agent-keys`, { headers, data: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    grants: [{ collectionId: 'items', capabilities: ['events:read'] }] } });
  expect(issued.status()).toBe(201);
  const agent = await asAgent(browser, (await issued.json()).secret);
  await go(agent, spaceUrl);
  // Discovery needs record or schema access, so the collection is opened by name.
  await expect(agent.getByRole('alert').filter({ hasText: 'Collections could not be listed' })).toContainText('FORBIDDEN');
  await audit(agent);
  await agent.getByLabel('Collection to open').fill('items');
  await agent.getByRole('button', { name: 'Open changes' }).click();
  await expect(agent.getByRole('heading', { name: 'Committed changes' })).toBeVisible();
  await expect(agent.getByRole('table')).toContainText('create');
  await go(agent, itemsUrl());
  await expect(agent.getByRole('alert')).toContainText(/FORBIDDEN|NOT_FOUND/);
  await expect(agent.getByRole('table')).toHaveCount(0);
  // An empty name is reported on its field.
  await go(agent, spaceUrl);
  await agent.getByLabel('Collection to open').evaluate(input => input.removeAttribute('required'));
  await agent.getByRole('button', { name: 'Open changes' }).click();
  await expect(agent.getByLabel('Collection to open')).toHaveAccessibleDescription(/Enter a collection name/);
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

test('a partly failed batch keeps its lines, so failed items can be retried', async ({ page, request }) => {
  await defineCollection(request, 'bulk');
  await signIn(page, ownerToken);
  const lines = [JSON.stringify({ operation: 'create', data: { title: 'kept' } }),
    JSON.stringify({ operation: 'create', data: { title: 'noted', note: 'later' } })].join('\n');
  await go(page, `${spaceUrl}/collections/bulk/batches`);
  await page.getByLabel('Operation key').first().fill('partial-1');
  await page.getByLabel(/Record requests/).fill(lines);
  await page.getByRole('button', { name: 'Submit batch' }).click();
  await expect(page.getByRole('status')).toContainText('1 failed');
  await expect(page.getByLabel(/Record requests/)).toHaveValue(lines);
  await expect(page.getByLabel('Operation key').first()).toHaveValue('partial-1');
  await settle(page);

  // A compatible revision admits the failed line; retrying resends the identical manifest.
  const revised = await request.patch(`/v1${spaceUrl}/collections/bulk`, { headers: { authorization: `Bearer ${ownerToken}`, 'if-match': '1' },
    data: { ...definition({ note: { type: 'string' } }), slug: 'bulk', version: 2 } });
  expect(revised.status()).toBe(200);
  await page.getByLabel('Retry failed items').check();
  await page.getByRole('button', { name: 'Submit batch' }).click();
  await expect(page.getByRole('status')).toContainText('2 succeeded');
  await expect(page.getByRole('row').filter({ hasText: 'succeeded' }).nth(1)).toContainText(/succeeded\s*2/);
  const listed = await request.post(`/v1${spaceUrl}/collections/bulk/records/query`,
    { headers: { authorization: `Bearer ${ownerToken}` }, data: { predicates: [], limit: 100 } });
  expect(((await listed.json()).records as { canonicalData: string }[]).map(record => JSON.parse(record.canonicalData).title).sort()).toEqual(['kept', 'noted']);

  // Progress alone cannot supply the lines, so they are not prefilled under its key.
  await go(page, `${spaceUrl}/collections/bulk/batches?operation=partial-1`);
  await expect(page.getByLabel(/Record requests/)).toHaveValue('');
  await expect(page.getByLabel(/Record requests/)).toHaveAccessibleDescription(/enter its exact original lines/);
});

test('a refused cancel stays on its operation, without pairing its key with other lines', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await defineCollection(request, 'halted');
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/collections/halted/batches`);
  await page.getByLabel('Operation key').first().fill('halt-1');
  await page.getByLabel(/Record requests/).fill([JSON.stringify({ operation: 'create', data: { title: 'one' } }),
    JSON.stringify({ operation: 'create', data: { title: 'two' } })].join('\n'));
  // The first item's transaction fails, so both items stay pending.
  await refuse('SELECT state FROM batch_operations WHERE');
  await page.getByRole('button', { name: 'Submit batch' }).click();
  await expect(page.getByRole('alert')).toContainText('Batch was not accepted');
  await go(page, `${spaceUrl}/collections/halted/batches?operation=halt-1`);
  await expect(page.getByRole('status')).toContainText('2 pending');

  await refuse("UPDATE batch_operations SET state='cancelled'");
  await page.getByRole('button', { name: 'Cancel remaining items' }).click();
  await expect(page.getByRole('alert')).toContainText('Remaining items were not cancelled');
  await expect(page.getByRole('alert')).not.toContainText('may have taken effect');
  await expect(page.getByRole('status')).toContainText('2 pending');
  await expect(page.getByRole('table')).toContainText('pending');
  for (const key of await page.getByLabel('Operation key').all()) await expect(key).toHaveValue('halt-1');
  await expect(page.getByLabel(/Record requests/)).toHaveValue('');
  await expect(page.getByLabel(/Record requests/)).toHaveAccessibleDescription(/enter its exact original lines/);
  // The same page cancels it once the authority accepts.
  await page.getByRole('button', { name: 'Cancel remaining items' }).click();
  await expect(page.getByRole('status')).toContainText('cancelled');
});

test('identifiers that differ only by surrounding whitespace stay distinct', async ({ page, request }) => {
  await signIn(page, ownerToken);
  await go(page, `${spaceUrl}/new-collection`);
  await page.getByLabel('Collection name').fill(' items ');
  await page.getByRole('button', { name: 'Define collection' }).click();
  await expect(page).toHaveURL(`${spaceUrl}/collections/%20items%20/schema`);

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

test('an uncertain definition asks the owner to inspect state, never to retry for recovery', async ({ page }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
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
  await go(page, spaceUrl);
  await expect(page.getByRole('alert').filter({ hasText: 'Collections could not be listed' })).toContainText('PROVIDER_UNAVAILABLE');
  await expect(page.getByText('No collections are visible')).toHaveCount(0);

  await go(page, `${spaceUrl}/audit?cursor=malformed`);
  await expect(page.getByRole('alert')).toContainText('CURSOR_INVALID');
  await page.getByRole('link', { name: 'Start again from the first page' }).click();
  await expect(page.getByRole('table')).toContainText('space:create');
});

test('an empty cursor opens the first page and a rejected one offers a restart', async ({ page }) => {
  await signIn(page, ownerToken);
  const pages = [['/spaces', 'Spaces could not be listed'], [spaceUrl, 'Collections could not be listed'],
    [`${spaceUrl}/audit`, 'Audit could not be read'],
    [`${itemsUrl()}/events`, 'Changes could not be read'], [itemsUrl(), 'Records could not be read']];
  for (const [path, title] of pages) {
    await go(page, `${path}?cursor=`);
    await expect(page.getByRole('alert'), path).toHaveCount(0);
    // A repeated cursor is rejected as /v1 rejects it, never reduced to its first value,
    // and the restart is offered whichever value comes first.
    const restart = page.getByRole('link', { name: /Start again from the (first page|beginning)/ });
    for (const query of ['cursor=malformed', 'cursor=a&cursor=b', 'cursor=&cursor=second', 'cursor=second&cursor=']) {
      await go(page, `${path}?${query}`);
      await expect(page.getByRole('alert').filter({ hasText: title }), `${path}?${query}`).toContainText('CURSOR_INVALID');
      await expect(restart, `${path}?${query}`).toHaveCount(1);
    }
    await restart.focus();
    await page.keyboard.press('Enter');
    await settle(page);
    await expect(page.getByRole('alert'), path).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('cursor'), path).toBe(false);
  }
});

test('pages pass accessibility checks, keyboard use and small screens', async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await go(page, '/');
    await audit(page);
    await signIn(page, ownerToken);
    const id = await createRecord(page, { title: 'Layout', state: 'open', rank: 1 });
    for (const path of ['/spaces', spaceUrl, itemsUrl(), `${itemsUrl()}/schema`, `${itemsUrl()}/records/${id}`,
      `${itemsUrl()}/events`, `${itemsUrl()}/batches`, `${spaceUrl}/audit`, `${spaceUrl}/new-collection`]) {
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

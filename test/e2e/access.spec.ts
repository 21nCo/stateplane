import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';

test.skip(process.env.STATEPLANE_E2E_STATE !== '1', 'Needs Postgres or a deployed development target');
test.describe.configure({ mode: 'serial' });

const ownerToken = process.env.STATEPLANE_E2E_TOKEN!;
const headers = { authorization: `Bearer ${ownerToken}` };
// The local host reaches Postgres through test/e2e/host.js's fault proxy.
const local = !process.env.STATEPLANE_E2E_BASE_URL;
const everyCapability = ['records:read', 'records:write', 'events:read', 'schema:write', 'sources:read', 'sources:write',
  'claims:read', 'claims:write', 'claims:review', 'export:read', 'space:admin'];
let spaceUrl = '';
const accessUrl = () => `${spaceUrl}/access`;
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
/** Drop the database reply to the next message containing `match`. */
async function dropReply(match: string) {
  const response = await fetch('http://127.0.0.1:5744/fault', { method: 'POST', body: JSON.stringify({ match }) });
  expect(response.status).toBe(204);
}
/** Fail the next message containing `match` before the database receives it. */
async function refuse(match: string) {
  const response = await fetch('http://127.0.0.1:5744/fault', { method: 'POST', body: JSON.stringify({ match, refuse: true }) });
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
async function defineCollection(request: APIRequestContext, name: string) {
  const response = await request.put(`/v1${spaceUrl}/collections/${encodeURIComponent(name)}`, { headers, data: { slug: name, version: 1,
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['title'],
      properties: { title: { type: 'string' } } }, unique: [], filterable: [], sortable: [] } });
  expect(response.status()).toBe(201);
}
/** A space of its own, holding an "items" collection with one record. */
async function freshSpace(request: APIRequestContext) {
  const created = await request.post('/v1/spaces', { headers, data: { spaceId: `sp_${randomUUID()}` } });
  expect(created.status()).toBe(201);
  spaceUrl = `/spaces/${(await created.json()).spaceId}`;
  await defineCollection(request, 'items');
  expect((await request.post(`/v1${itemsUrl()}/records`, { headers,
    data: { operation: 'create', idempotencyKey: randomUUID(), data: { title: 'Seed' } } })).status()).toBe(200);
}
const issuedSecret = (page: Page) => page.getByLabel('Secret', { exact: true }).inputValue();
const issuedId = async (page: Page) => (await page.getByRole('heading', { name: /^Key .* issued$/ }).innerText()).split(' ')[1];
const keyCount = async (request: APIRequestContext) => (await (await request.get(`/v1${spaceUrl}/agent-keys`, { headers })).json()).items.length;
async function asAgent(browser: Browser, secret: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, secret);
  return page;
}

test.beforeAll(async ({ request }, testInfo) => {
  // Every spec file shares the host's fault proxy, whose armed faults match SQL
  // text: owner.spec.ts arms faults on queries this page also sends, and these
  // journeys arm faults on queries it sends. Beside another file a fault can be
  // consumed by the wrong test, so these journeys need a single worker.
  test.skip(testInfo.config.workers > 1, 'Shares the e2e fault proxy with owner.spec.ts; run with --workers=1');
  await freshSpace(request);
});

test('owner grants an agent key, the API enforces it and revocation is verified', async ({ browser, page }) => {
  await signIn(page, ownerToken);
  // The space's section navigation leads to the access page.
  await go(page, spaceUrl);
  const sections = page.getByRole('navigation', { name: 'Space sections' });
  await sections.getByRole('link', { name: 'Agent access' }).click();
  await page.waitForURL(url => url.pathname === accessUrl());
  await expect(sections.getByRole('link', { name: 'Agent access' })).toHaveAttribute('aria-current', 'page');
  await settle(page);
  const items = page.getByRole('group', { name: 'Collection items' });
  await items.getByLabel('records:read', { exact: true }).check();
  await page.getByRole('button', { name: 'Issue key' }).click();
  const secret = await issuedSecret(page);
  expect(secret.length).toBeGreaterThan(20);
  await go(page, accessUrl());
  expect(await page.content()).not.toContain(secret);
  await expect(page.getByRole('table')).toContainText('records:read');
  await expect(page.getByRole('table')).toContainText('active');

  const agent = await asAgent(browser, secret);
  await expect(agent.getByRole('alert')).toContainText('FORBIDDEN');
  await go(agent, itemsUrl());
  await expect(agent.getByRole('table')).toContainText('Seed');
  await agent.getByLabel('Data JSON').fill(JSON.stringify({ title: 'Agent' }));
  await agent.getByRole('button', { name: 'Create record' }).click();
  await expect(agent.getByRole('alert')).toContainText('FORBIDDEN');
  await go(agent, accessUrl());
  await expect(agent.getByRole('alert').first()).toContainText(/FORBIDDEN|NOT_FOUND/);
  await go(page, accessUrl());
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
    await go(page, accessUrl());
    await items.getByLabel('records:read', { exact: true }).check();
    await page.getByRole('button', { name: 'Issue key' }).click();
    const interrupted = await issuedSecret(page);
    const interruptedId = await issuedId(page);
    await go(page, accessUrl());
    await failProviderRevocation();
    await page.getByRole('button', { name: `Revoke ${interruptedId}`, exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Denied here; provider cleanup pending');
    const pending = await checkKey(page, interrupted);
    await expect(pending).toContainText('Provider: accepted as api-key.');
    await expect(pending).toContainText('This space: denied (NOT_FOUND).');
    await page.getByRole('button', { name: `Finish revocation ${interruptedId}`, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('revoked');
    await expect(page.getByRole('table')).not.toContainText('provider cleanup pending');
    await expect(await checkKey(page, interrupted)).toContainText('Provider: rejected (UNAUTHENTICATED).');
  }

  await go(page, `${spaceUrl}/audit`);
  await expect(page.getByRole('table')).toContainText('key:issue');
  await expect(page.getByRole('table')).toContainText('key:revoke');
});

test('the form issues every public capability, and the authority holds each one', async ({ page, request }) => {
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const items = page.getByRole('group', { name: 'Collection items' });
  for (const capability of everyCapability) await items.getByLabel(capability, { exact: true }).check();
  await expect(items.getByRole('checkbox')).toHaveCount(everyCapability.length);
  await page.getByRole('button', { name: 'Issue key' }).click();
  const keyId = await issuedId(page);
  const listed = (await (await request.get(`/v1${spaceUrl}/agent-keys`, { headers })).json()).items.find((key: { keyId: string }) => key.keyId === keyId);
  expect(listed.grants).toEqual([{ collectionId: 'items', capabilities: everyCapability, expiresAt: null }]);
});

test('naming a listed collection again merges its capabilities into one grant', async ({ page, request }) => {
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  await page.getByRole('group', { name: 'Collection items' }).getByLabel('records:read', { exact: true }).check();
  const other = page.getByRole('group', { name: 'Another collection' });
  await other.getByLabel('Collection name').fill('items');
  await other.getByLabel('records:write', { exact: true }).check();
  await page.getByRole('button', { name: 'Issue key' }).click();
  const agent = { authorization: `Bearer ${await issuedSecret(page)}` };
  expect((await request.post(`/v1${itemsUrl()}/records/query`, { headers: agent, data: { predicates: [], limit: 1 } })).status()).toBe(200);
  expect((await request.post(`/v1${itemsUrl()}/records`, { headers: agent,
    data: { operation: 'create', idempotencyKey: randomUUID(), data: { title: 'Merged grant' } } })).status()).toBe(200);
});

test('each grant shows its own deadline, and one past it is expired here and refused by the API', async ({ page, request }) => {
  for (const name of ['gone', 'live']) await defineCollection(request, name);
  const gone = new Date(Date.now() + 2_000).toISOString();
  const live = new Date(Date.now() + 3_600_000).toISOString();
  const issued = await request.post(`/v1${spaceUrl}/agent-keys`, { headers, data: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    grants: [{ collectionId: 'gone', capabilities: ['records:read'], expiresAt: gone },
      { collectionId: 'live', capabilities: ['records:read'], expiresAt: live }, { collectionId: 'items', capabilities: ['records:read'] }] } });
  expect(issued.status()).toBe(201);
  const { keyId, secret } = await issued.json();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(gone) - Date.now()) + 500));
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const row = page.getByRole('row').filter({ hasText: keyId });
  await expect(row).toContainText('active');
  await expect(row).toContainText(`gone: records:read (expired ${gone})`);
  await expect(row).toContainText(`live: records:read (expires ${live})`);
  await expect(row.locator('td div').filter({ hasText: /^items:/ })).not.toContainText('expire');
  await audit(page);
  const agent = { authorization: `Bearer ${secret}` };
  const count = async (name: string) => (await request.post(`/v1${spaceUrl}/collections/${name}/records/count`, { headers: agent, data: [] })).status();
  expect(await count('gone')).not.toBe(200);
  expect([await count('live'), await count('items')]).toEqual([200, 200]);
});

test('an issuance larger than the route accepts is refused on the page, keeps its choices and sends nothing', async ({ page, request }) => {
  // Forty collections with long names and every capability exceed 16,384 request bytes.
  const names = Array.from({ length: 40 }, (_, index) => `${'n'.repeat(220)}${String(index).padStart(2, '0')}`);
  for (const name of names) await defineCollection(request, name);
  const before = await keyCount(request);
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  await page.locator('input[type=checkbox]').evaluateAll(inputs => { for (const input of inputs) (input as HTMLInputElement).checked = true; });
  await page.getByRole('button', { name: 'Issue key' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing was sent.' })).toContainText(/These grants need \d+ bytes; one key's issuance accepts at most 16384\./);
  expect(await keyCount(request)).toBe(before);
  // The enhanced form keeps the selection, so the owner can narrow it and issue.
  await expect(page.getByRole('group', { name: `Collection ${names[0]}` }).getByLabel('space:admin', { exact: true })).toBeChecked();
  for (const name of names.slice(10)) await page.getByRole('group', { name: `Collection ${name}` }).getByRole('checkbox')
    .evaluateAll(inputs => { for (const input of inputs) (input as HTMLInputElement).checked = false; });
  await page.getByRole('button', { name: 'Issue key' }).click();
  await expect(page.getByRole('heading', { name: /^Key .* issued$/ })).toBeVisible();
  expect(await keyCount(request)).toBe(before + 1);
});

test('a revocation whose policy publication fails stays retryable after the provider revoked the key', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await freshSpace(request);
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const before = await keyCount(request);
  // Issuance is not a replayable document POST: a reload shows no secret and issues nothing.
  const documentPosts: string[] = [];
  page.on('request', item => { if (item.method() === 'POST' && item.resourceType() === 'document') documentPosts.push(item.url()); });
  await page.getByRole('group', { name: 'Collection items' }).getByLabel('records:read', { exact: true }).check();
  await page.getByRole('button', { name: 'Issue key' }).click();
  const secret = await issuedSecret(page);
  const keyId = await issuedId(page);
  expect(documentPosts).toEqual([]);
  await page.reload();
  await settle(page);
  await expect(page.getByLabel('Secret', { exact: true })).toHaveCount(0);
  expect(await keyCount(request)).toBe(before + 1);

  // The cell commits the revocation and the provider revokes the key, but the
  // directory never receives the new policy version.
  await refuse('UPDATE space_directory SET policy_version');
  await page.getByRole('button', { name: `Revoke ${keyId}` }).click();
  const failed = page.getByRole('alert').filter({ hasText: 'Revocation did not finish' });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('Retry until it finishes.');
  await expect(page.getByRole('row').filter({ hasText: keyId })).toContainText('Provider key revoked');
  await expect(failed.getByRole('button', { name: `Retry revocation of ${keyId}` })).toBeVisible();
  // Until the publication finishes, owner operations in the space are refused.
  expect((await request.post(`/v1${itemsUrl()}/records/count`, { headers, data: [] })).status()).toBe(403);
  // The failed response is gone after a reload and another submit; the key list still finishes it.
  await page.reload();
  await settle(page);
  await expect(await checkKey(page, secret)).toContainText('Provider: rejected (UNAUTHENTICATED).');
  await expect(failed).toHaveCount(0);
  expect((await request.post(`/v1${itemsUrl()}/records/count`, { headers, data: [] })).status()).toBe(403);
  await page.getByRole('row').filter({ hasText: keyId }).getByRole('button', { name: `Finish revocation ${keyId}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`Key ${keyId} revoked.`);
  expect((await request.post(`/v1${itemsUrl()}/records/count`, { headers, data: [] })).status()).toBe(200);
});

test('an uncertain key issuance asks the owner to inspect the key list, never to retry for recovery', async ({ page, request }) => {
  test.skip(!local, 'Needs the local fault proxy');
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const keyIds = async () => (await (await request.get(`/v1${spaceUrl}/agent-keys`, { headers })).json()).items.map((key: { keyId: string }) => key.keyId);
  const before = await keyIds();
  await page.getByRole('group', { name: 'Collection items' }).getByLabel('records:read', { exact: true }).check();
  // Issuance completion, its readback and its retry all lose their replies.
  await dropReply('SET completed_at=clock_timestamp()');
  await dropReply('SELECT i.completed_at');
  await dropReply('SET completed_at=COALESCE');
  await page.getByRole('button', { name: 'Issue key' }).click();
  const issue = page.getByRole('alert').filter({ hasText: 'Key was not issued' });
  await expect(issue).toContainText('COMMIT_OUTCOME_UNKNOWN');
  await expect(issue).toContainText('Check the key list');
  await expect(issue).not.toContainText('Retry the identical request');
  // The key the uncertain issuance created is in the list the owner is sent to, without a reload.
  const created = (await keyIds()).filter((keyId: string) => !before.includes(keyId));
  expect(created).toHaveLength(1);
  await expect(page.getByRole('row').filter({ hasText: created[0] })).toBeVisible();
  await expect(issue).toBeVisible();
});

test('an issuance in flight sends no second request on a repeated click or Enter, so one key is issued and its secret stays shown', async ({ page, request }) => {
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const before = await keyCount(request);
  // Hold every issuance post until the repeats have been tried.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let posts = 0;
  await page.route(url => url.search === '?/issue', async route => { posts++; await held; await route.continue(); });
  await page.getByRole('group', { name: 'Collection items' }).getByLabel('records:read', { exact: true }).check();
  const issue = page.getByRole('button', { name: 'Issue key' });
  await issue.click();
  await expect.poll(() => posts).toBe(1);
  await issue.dblclick({ force: true });
  await page.getByRole('group', { name: 'Another collection' }).getByLabel('Collection name').press('Enter');
  await page.waitForTimeout(500); // Time for a repeat to be sent, were one allowed.
  release();
  const keyId = await issuedId(page);
  const secret = await issuedSecret(page);
  await expect(issue).toBeEnabled();
  await settle(page);
  expect(posts).toBe(1);
  const keys = (await (await request.get(`/v1${spaceUrl}/agent-keys`, { headers })).json()).items;
  expect(keys).toHaveLength(before + 1);
  expect(keys.map((key: { keyId: string }) => key.keyId)).toContain(keyId);
  expect(await issuedId(page)).toBe(keyId);
  expect(await issuedSecret(page)).toBe(secret);
});

test('a failed issuance reloads the collections, and each choice stays with the collection it was made for', async ({ page, request }) => {
  await freshSpace(request);
  await defineCollection(request, 'zeta');
  await signIn(page, ownerToken);
  await go(page, accessUrl());
  const group = (name: string) => page.getByRole('group', { name });
  await group('Collection zeta').getByLabel('records:read', { exact: true }).check();
  // A grant on a collection that does not exist is refused before any key is created.
  await group('Another collection').getByLabel('Collection name').fill('missing');
  await group('Another collection').getByLabel('records:write', { exact: true }).check();
  // Created elsewhere meanwhile, it sorts before every group already on the page.
  await defineCollection(request, 'aaa');
  const before = await keyCount(request);
  await page.getByRole('button', { name: 'Issue key' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Key was not issued' })).toContainText('INVALID_ARGUMENT');
  await expect(group('Collection aaa')).toBeVisible();
  expect(await keyCount(request)).toBe(before);
  for (const name of ['Collection aaa', 'Collection items']) await expect(group(name).locator('input:checked')).toHaveCount(0);
  await expect(group('Collection zeta').locator('input:checked')).toHaveCount(1);
  await expect(group('Collection zeta').getByLabel('records:read', { exact: true })).toBeChecked();
  await expect(group('Another collection').getByLabel('Collection name')).toHaveValue('missing');
  await expect(group('Another collection').getByLabel('records:write', { exact: true })).toBeChecked();
  // Corrected, the issuance grants only what was chosen for zeta.
  await group('Another collection').getByLabel('Collection name').fill('');
  await page.getByRole('button', { name: 'Issue key' }).click();
  const keyId = await issuedId(page);
  const listed = (await (await request.get(`/v1${spaceUrl}/agent-keys`, { headers })).json()).items.find((key: { keyId: string }) => key.keyId === keyId);
  expect(listed.grants).toEqual([{ collectionId: 'zeta', capabilities: ['records:read'], expiresAt: null }]);
});

test('identifiers with line breaks travel through the grant form exactly, with and without scripts', async ({ browser, page, request }) => {
  for (const name of ['a\nb', 'a\r\nb']) await defineCollection(request, name);
  // Native form posts submit a line break as CRLF; neither the no-script nor the
  // enhanced issuance may grant "a\r\nb" when only "a\nb" is selected.
  const native = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  for (const issuer of [native, page]) {
    await signIn(issuer, ownerToken);
    await go(issuer, accessUrl());
    await issuer.getByRole('group', { name: 'Collection "a\\nb"' }).getByLabel('records:read', { exact: true }).check();
    await issuer.getByRole('button', { name: 'Issue key' }).click();
    const agent = { authorization: `Bearer ${await issuedSecret(issuer)}` };
    expect((await request.get(`/v1${spaceUrl}/collections/a%0Ab`, { headers: agent })).status()).toBe(200);
    expect((await request.get(`/v1${spaceUrl}/collections/a%0D%0Ab`, { headers: agent })).status()).toBe(404);
  }
});

test('the access page passes accessibility checks and fits small screens, with long and invisible names', async ({ page, request }) => {
  await freshSpace(request);
  for (const name of ['a'.repeat(256), '​', 'a﻿b']) await defineCollection(request, name);
  await signIn(page, ownerToken);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await go(page, accessUrl());
    await audit(page);
    await expect(page.locator('title')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px`).toBe(true);
  }
  for (const name of ['Collection "\\u200b"', 'Collection "a\\ufeffb"', `Collection ${'a'.repeat(256)}`])
    await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
});

import { test, expect } from '@playwright/test';

test('scaffold UI and health route', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Stateplane');
  await expect(page.locator('head title')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Stateplane' })).toBeVisible();
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ service: 'stateplane', status: 'scaffold' });
});

test('a page request without a session goes to sign-in, as a document or as client navigation data', async ({ request }) => {
  const document = await request.get('/spaces', { maxRedirects: 0 });
  expect(document.status()).toBe(303);
  expect(document.headers().location).toBe('/');
  const data = await request.get('/spaces/__data.json', { maxRedirects: 0 });
  expect(await data.json()).toEqual({ type: 'redirect', location: '/' });
});

import { test, expect } from '@playwright/test';

test('scaffold UI and health route', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Stateplane' })).toBeVisible();
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ service: 'stateplane', status: 'scaffold' });
});

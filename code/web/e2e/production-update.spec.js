import { test, expect } from '@playwright/test';

test('built application updates through its real banner', async ({ page, request }) => {
  await request.get('http://127.0.0.1:5189/deploy?version=one');
  await page.goto('http://127.0.0.1:5189/production/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const previous = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
  await request.get('http://127.0.0.1:5189/deploy?version=two');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const update = page.getByRole('button', { name: '更新并刷新' });
  await expect(update).toBeVisible();
  await Promise.all([page.waitForEvent('load'), update.click()]);
  expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(previous);
  expect(await page.evaluate(() => [...document.scripts].some((s) => s.src.includes('/assets/')))).toBe(true);
  await expect(page.locator('.update-notice')).toHaveCount(0);
});

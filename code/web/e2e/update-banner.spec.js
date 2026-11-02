import { test, expect } from '@playwright/test';

const base = 'http://127.0.0.1:5189';

test('update action protects open editors and other tabs', async ({ page, context, request }) => {
  await request.get(`${base}/deploy?version=one`);
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const other = await context.newPage();
  await other.goto(base);
  for (const tab of [page, other]) {
    await tab.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<input value="unsaved draft">';
      document.body.append(dialog);
    });
  }
  await request.get(`${base}/deploy?version=two`);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const update = page.getByRole('button', { name: '更新并刷新' });
  await expect(update).toBeVisible();
  await expect(other.getByRole('button', { name: '更新并刷新' })).toBeVisible();
  await update.click();
  await expect(page.locator('.update-notice')).toContainText('请先保存或关闭');
  await expect(page.locator('input')).toHaveValue('unsaved draft');
  await page.locator('[role="dialog"]').evaluate((node) => node.remove());
  await update.click();
  await expect(page.locator('h1')).toHaveText('two');
  await expect(other.locator('.update-notice')).toContainText('其他页面已更新');
  await expect(other.locator('input')).toHaveValue('unsaved draft');
  await other.getByRole('button', { name: '刷新页面' }).click();
  await expect(other.locator('h1')).toHaveText('one');
  await other.locator('[role="dialog"]').evaluate((node) => node.remove());
  await other.getByRole('button', { name: '刷新页面' }).click();
  await expect(other.locator('h1')).toHaveText('two');
});

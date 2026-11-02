import { test, expect } from '@playwright/test';

test('settings switches remain centered and tabs are keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { openAccountDialog } = await import('/src/js/account-dialog.js');
    const { DEFAULT_SETTINGS } = await import('/src/js/store.js');
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }), getCalendars: () => [],
      saveSettings: async () => {}, subscribe: () => () => {},
    };
    openAccountDialog({ store, user: { username: 'preview' } });
  });
  const toggle = page.locator('.settings__page:not([hidden]) .switch input').first();
  const checked = await toggle.isChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !checked });
  const geometry = await toggle.locator('..').evaluate((node) => {
    const track = node.querySelector('.switch__track').getBoundingClientRect();
    const thumb = node.querySelector('.switch__thumb').getBoundingClientRect();
    return Math.abs(track.y + track.height / 2 - thumb.y - thumb.height / 2);
  });
  expect(geometry).toBeLessThan(1);
  const tab = page.getByRole('tab', { name: '一般', exact: true });
  await tab.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: '快捷键', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { test, expect } from '@playwright/test';

const base = 'http://127.0.0.1:5291';
const USER = 'caldav';
const PASS = 'e2e-backend-pass';

test.describe.configure({ mode: 'serial' });

test('真实后端：登录、新建日程、刷新回读、改名、登出', async ({ page }, testInfo) => {
  // 桌面与移动共用一个后端实例，各用一天，避免互相压到同一时段。
  const dayIndex = testInfo.project.name === 'mobile' ? 1 : 0;
  const editor = page.locator('.modal--editor');
  const viewCard = page.locator('.modal--view');
  // 两个标题刻意互不包含，方便断言"旧标题真的没了"。
  const stamp = Date.now();
  const title = `E2E 事件 ${stamp}`;
  const renamed = `E2E 改名 ${stamp}`;

  // ---- 登录：真实表单 + 真实会话 Cookie ----
  await page.goto(base);
  await page.locator('#login-username').fill(USER);
  await page.locator('#login-password').fill(PASS);
  await page.locator('.auth-form button[type="submit"]').click();
  await expect(page.locator('.month__grid')).toBeVisible();

  // ---- 新建日程：点日号进日视图，再点时段 ----
  await page.locator('.month__daynum').nth(dayIndex).click();
  await expect(page.locator('.timegrid__slot').first()).toBeVisible();
  await page.locator('.timegrid__slot').nth(9).click();
  await expect(editor).toBeVisible();
  await editor.locator('.input--title').fill(title);
  await editor.locator('.modal__foot button[type="submit"]').click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.tevent__title', { hasText: title })).toBeVisible();

  // ---- 刷新回读：事件必须来自服务端，而不是内存里的临时状态 ----
  await page.reload();
  await expect(page.locator('.month__grid')).toBeVisible();
  await page.locator('.month__daynum').nth(dayIndex).click();
  await expect(page.locator('.tevent__title', { hasText: title })).toBeVisible();
  const stored = await page.evaluate(async (needle) => {
    const res = await fetch('/api/v1/kv?pattern=cal:evt:*', { credentials: 'same-origin' });
    return (await res.text()).includes(needle);
  }, title);
  expect(stored).toBe(true);

  // ---- 修改：事件是只读详情卡，编辑要从详情卡里进编辑器 ----
  await page.locator('.tevent__title', { hasText: title }).first().click();
  await expect(viewCard).toBeVisible();
  await viewCard.getByRole('button', { name: '编辑事件' }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator('.input--title')).toHaveValue(title);
  await editor.locator('.input--title').fill(renamed);
  await editor.locator('.modal__foot button[type="submit"]').click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.tevent__title', { hasText: renamed })).toBeVisible();

  await page.reload();
  await page.locator('.month__daynum').nth(dayIndex).click();
  await expect(page.locator('.tevent__title', { hasText: renamed })).toBeVisible();
  await expect(page.locator('.tevent__title', { hasText: title })).toHaveCount(0);

  // ---- 清理：删掉测试事件，下一条用例从干净数据开始 ----
  await page.locator('.tevent__title', { hasText: renamed }).first().click();
  await expect(viewCard).toBeVisible();
  await viewCard.getByRole('button', { name: '删除事件' }).click();
  await expect(page.locator('.tevent__title', { hasText: renamed })).toHaveCount(0);

  // ---- 登出：回到登录页，刷新后仍是未登录 ----
  await page.locator('.avatar').click();
  await page.locator('.menu-item', { hasText: '登出' }).click();
  await expect(page.locator('#login-username')).toBeVisible();
  await page.reload();
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('.month__grid')).toHaveCount(0);
});

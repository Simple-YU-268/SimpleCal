import { test, expect } from '@playwright/test';
import { createDAVClient } from 'tsdav';

/**
 * 0.5.0 客户端兼容：Web ↔ CalDAV 双向一致。
 *
 * tsdav（npm 上的 CalDAV 客户端，第三方实现里最常被引用的一个）代表
 * "外部客户端"这一侧：它按 RFC 4791 的方式发现日历、列对象、PUT / GET /
 * DELETE。这里的断言不是"tsdav 能用"，而是**两侧操作的是同一个对象**：
 *
 *   1. Web 建事件 → tsdav 能读到（且 UID 带域后缀时也读得到）
 *   2. tsdav 改事件 → Web 刷新后看到新标题
 *   3. tsdav 删事件 → Web 刷新后看不到
 *
 * 后端是真实产品进程（e2e/backend-server.mjs），不是 mock。
 */

const base = 'http://127.0.0.1:5291';
const USER = 'caldav';
const PASS = 'e2e-backend-pass';

const icsFor = (uid, summary, { start = '20261105T090000Z', end = '20261105T100000Z' } = {}) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//SimpleCal//DAV Client Interop//EN',
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20261102T000000Z',
  `DTSTART:${start}`,
  `DTEND:${end}`,
  `SUMMARY:${summary}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** 连上真实后端的 DAV 端点，取第一个 VEVENT 日历。 */
async function davClient() {
  const client = await createDAVClient({
    serverUrl: base,
    credentials: { username: USER, password: PASS },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  const calendars = await client.fetchCalendars();
  const calendar = calendars.find((c) => c.components?.includes('VEVENT')) || calendars[0];
  if (!calendar) throw new Error(`DAV 没有发现任何日历：${JSON.stringify(calendars)}`);
  return { client, calendar };
}

test.describe.configure({ mode: 'serial' });

test('tsdav 能读 Web 建的事件、并且能改回去', async ({ page }) => {
  const stamp = Date.now();
  const title = `DAV 互操作 ${stamp}`;
  const editor = page.locator('.modal--editor');

  // ---- Web 侧建事件（走真实表单 + 真实后端） ----
  await page.goto(base);
  await page.locator('#login-username').fill(USER);
  await page.locator('#login-password').fill(PASS);
  await page.locator('.auth-form button[type="submit"]').click();
  await expect(page.locator('.month__grid')).toBeVisible();

  await page.locator('.month__daynum').nth(0).click();
  await expect(page.locator('.timegrid__slot').first()).toBeVisible();
  await page.locator('.timegrid__slot').nth(9).click();
  await expect(editor).toBeVisible();
  await editor.locator('.input--title').fill(title);
  await editor.locator('.modal__foot button[type="submit"]').click();
  await expect(editor).toBeHidden();

  // ---- tsdav 侧读到同一个事件 ----
  const { client, calendar } = await davClient();
  const objects = await client.fetchCalendarObjects({ calendar });
  const found = objects.find((o) => String(o.data || '').includes(title));
  expect(found, 'tsdav 应该能读到 Web 建的事件').toBeTruthy();
  const uid = String(found.data).match(/UID:(.+)/)?.[1]?.trim();
  expect(uid, '事件必须带 UID').toBeTruthy();

  // ---- tsdav 侧改标题（走 If-Match 的标准更新） ----
  const renamed = `DAV 改名 ${stamp}`;
  const updated = await client.updateCalendarObject({
    calendarObject: {
      ...found,
      data: String(found.data).replace(`SUMMARY:${title}`, `SUMMARY:${renamed}`),
    },
  });
  expect(updated.status, 'tsdav 更新事件应成功').toBeLessThan(300);

  // ---- Web 刷新后看到新标题：两侧是同一个对象 ----
  await page.reload();
  await expect(page.locator('.month__grid')).toBeVisible();
  await page.locator('.month__daynum').nth(0).click();
  await expect(page.locator('.tevent__title', { hasText: renamed })).toBeVisible();

  // ---- tsdav 侧删除，Web 刷新后看不到 ----
  const after = await client.fetchCalendarObjects({ calendar });
  const target = after.find((o) => String(o.data || '').includes(renamed));
  expect(target).toBeTruthy();
  const deleted = await client.deleteCalendarObject({ calendarObject: target });
  expect(deleted.status, 'tsdav 删除事件应成功').toBeLessThan(300);

  await page.reload();
  await page.locator('.month__daynum').nth(0).click();
  await expect(page.locator('.tevent__title', { hasText: renamed })).toHaveCount(0);
});

test('tsdav 能用带域后缀的 UID 建事件，Web 能看到', async ({ page }) => {
  const stamp = Date.now();
  const title = `DAV 域后缀 UID ${stamp}`;
  // 真实客户端（Apple Calendar `…@apple`、Thunderbird `…@mozilla.org`）都这么干。
  const uid = `dav-${stamp}@client.example`;
  const start = '20261105T090000Z';

  const { client, calendar } = await davClient();
  const created = await client.createCalendarObject({
    calendar,
    iCalString: icsFor(uid, title, { start, end: '20261105T100000Z' }),
    filename: `${uid}.ics`,
  });
  expect(created.status, '带 @ 的 UID 应能被 PUT').toBe(201);

  // ---- Web 侧看得到这条由 DAV 客户端创建的事件 ----
  await page.goto(base);
  await page.locator('#login-username').fill(USER);
  await page.locator('#login-password').fill(PASS);
  await page.locator('.auth-form button[type="submit"]').click();
  await expect(page.locator('.month__grid')).toBeVisible();
  // 事件落在 11 月 5 日；月视图头一天未必是 5 号，按日期戳精确定位那一格。
  const dayMs = await page.evaluate((iso) => {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, '2026-11-05T09:00:00Z');
  await page.locator(`.month__cell[data-day="${dayMs}"] .month__daynum`).click();
  await expect(page.locator('.tevent__title', { hasText: title })).toBeVisible();

  // ---- 清理：别把测试事件留给后面的用例 ----
  const objects = await client.fetchCalendarObjects({ calendar });
  const target = objects.find((o) => String(o.data || '').includes(uid));
  expect(target).toBeTruthy();
  await client.deleteCalendarObject({ calendarObject: target });
});

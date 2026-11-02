import { test, expect } from '@playwright/test';

const base = 'http://127.0.0.1:5190';

test.describe.configure({ mode: 'serial' });

/** 页面当前引用的 /assets/ 资源（JS + CSS）。 */
async function documentAssets(page) {
  try {
    return await page.evaluate(() => {
      const urls = [...document.querySelectorAll('script[src*="/assets/"]'), ...document.querySelectorAll('link[href*="/assets/"]')];
      return urls.map((node) => new URL(node.src || node.href).pathname);
    });
  } catch {
    return [];
  }
}

/** 读取构建指纹；刷新途中上下文会被销毁，返回 null 让调用方重试。 */
async function buildFingerprint(page) {
  try {
    return await page.evaluate(() => document.querySelector('meta[name="simplecal-build"]')?.content);
  } catch {
    return null;
  }
}

test('升级到新构建后只使用新资源，缓存不混且离线可打开', async ({ page, context, request }) => {
  // 桌面/移动项目共用同一个服务，先回到第一份构建。
  await request.get(`${base}/switch?build=a`);
  const fixture = await (await request.get(`${base}/fixture`)).json();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // 离线阶段 API 请求失败是预期行为，不算问题。
    if (msg.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(msg.text())) {
      problems.push(`console: ${msg.text()}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`);
  });

  // ---- 第一份构建上线：SW 安装并接管页面 ----
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(async () => {
      try {
        return await page.evaluate(() => !!navigator.serviceWorker.controller);
      } catch {
        return false;
      }
    })
    .toBe(true);

  expect(await buildFingerprint(page)).toBe(fixture.a.fingerprint);
  await expect(page.locator('.auth-card__title')).toHaveText('SimpleCal');
  const accentA = await page.evaluate(
    () => getComputedStyle(document.querySelector('.btn--primary')).backgroundColor,
  );
  for (const asset of await documentAssets(page)) {
    expect(fixture.a.assets.some((name) => asset.endsWith(name))).toBe(true);
  }

  // ---- 发布第二份构建：SW 等待用户确认后再切换 ----
  await request.get(`${base}/switch?build=b`);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const notice = page.locator('.update-notice');
  await expect(notice).toBeVisible();
  await notice.locator('button').click();
  await expect.poll(() => buildFingerprint(page)).toBe(fixture.b.fingerprint);

  // ---- 新页面必须整体切换到新构建：JS 文案、CSS 主题色、资源清单 ----
  await expect(page.locator('.auth-card__title')).toHaveText('SimpleCal B');
  const accentB = await page.evaluate(
    () => getComputedStyle(document.querySelector('.btn--primary')).backgroundColor,
  );
  expect(accentB).not.toBe(accentA);
  const assetsAfter = await documentAssets(page);
  expect(assetsAfter.length).toBeGreaterThan(0);
  for (const asset of assetsAfter) {
    expect(fixture.b.assets.some((name) => asset.endsWith(name))).toBe(true);
    expect(fixture.a.assets.some((name) => asset.endsWith(name))).toBe(false);
  }

  // ---- 缓存里不应同时存在两个版本的资源 ----
  const cacheState = await page.evaluate(async () => {
    const state = {};
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      state[key] = (await cache.keys()).map((req) => new URL(req.url).pathname);
    }
    return state;
  });
  const cacheNames = Object.keys(cacheState);
  expect(cacheNames).toHaveLength(1);
  const cachedAssets = cacheState[cacheNames[0]].filter((path) => path.includes('/assets/'));
  expect(cachedAssets.length).toBeGreaterThan(0);
  for (const asset of cachedAssets) {
    expect(fixture.b.assets.some((name) => asset.endsWith(name))).toBe(true);
  }

  // ---- 离线仍能打开：新构建的资源已经完整预缓存 ----
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.auth-card')).toBeVisible();
  const offlineAssets = await documentAssets(page);
  for (const asset of offlineAssets) {
    expect(fixture.b.assets.some((name) => asset.endsWith(name))).toBe(true);
  }
  await context.setOffline(false);

  expect(problems).toEqual([]);
});

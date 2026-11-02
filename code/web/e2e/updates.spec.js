import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const base = 'http://127.0.0.1:5189';

test('production worker waits for consent, survives a broken update and boots offline', async ({ page, context, request }) => {
  await request.get(`${base}/deploy?version=one`);
  await page.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const other = await context.newPage();
  await other.goto(base);
  await other.evaluate(() => {
    const input = document.createElement('input');
    input.value = 'unsaved draft';
    document.body.append(input);
  });
  await request.get(`${base}/deploy?version=two`);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)).toBe(true);
  await expect(page.locator('h1')).toHaveText('one');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
  });
  await page.reload();
  await expect(page.locator('h1')).toHaveText('two');
  await expect(other.locator('h1')).toHaveText('one');
  await expect(other.locator('input')).toHaveValue('unsaved draft');
  await request.get(`${base}/deploy?version=broken`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const failed = new Promise((resolve) => registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
    }, { once: true }));
    await registration.update();
    await failed;
  });
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)).toBe(false);
  await request.get(`${base}/deploy?version=interrupted`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const failed = new Promise((resolve) => registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
    }, { once: true }));
    await registration.update();
    await failed;
  });
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('h1')).toHaveText('two');
  expect(await page.evaluate(() => window.assetLoaded)).toBe(true);
});

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5188', channel: 'msedge' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [{
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5188 --strictPort',
    url: 'http://127.0.0.1:5188',
    reuseExistingServer: !process.env.CI,
  }, {
    command: 'node e2e/update-server.mjs',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
  }, {
    // 两份真实构建的升级测试：启动时会真的跑两次 Vite 构建。
    command: 'node e2e/build-server.mjs',
    url: 'http://127.0.0.1:5190/fixture',
    reuseExistingServer: false,
    timeout: 300000,
  }, {
    // 真实后端：跑产品的 server.mjs，临时数据目录，退出即清理。
    command: 'node e2e/backend-server.mjs',
    url: 'http://127.0.0.1:5291/api/version',
    reuseExistingServer: false,
    timeout: 120000,
  }],
});

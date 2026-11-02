/**
 * 为端到端测试拉起**真实后端**（code/app/server.mjs）。
 *
 * 与 update-server.mjs / build-server.mjs 那种静态夹具不同，这里跑的是产品后端：
 * 真实会话 Cookie、真实 KV 存储、真实数据目录，测试结束时删掉临时数据目录。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..', '..');
const port = Number(process.env.E2E_BACKEND_PORT || 5291);
const adminPassword = process.env.E2E_BACKEND_PASSWORD || 'e2e-backend-pass';
const webDir = path.join(webRoot, 'dist');

await access(path.join(webDir, 'index.html')).catch(() => {
  throw new Error(`前端产物缺失：${webDir}，请先执行 npm run build`);
});

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'simplecal-e2e-'));
const child = spawn(process.execPath, [path.join(repoRoot, 'code', 'app', 'server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CALDAV_DATA_DIR: dataDir,
    CALDAV_ADMIN_PASSWORD: adminPassword,
    CALDAV_USER: 'caldav',
    CALDAV_HOST: '127.0.0.1',
    CALDAV_PORT: String(port),
    CALDAV_WEB_DIR: webDir,
  },
  stdio: 'inherit',
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  child.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('exit', () => {
  child.kill('SIGKILL');
});

child.on('exit', (code) => {
  if (!closing) {
    console.error(`[backend] 后端进程退出（code=${code}）`);
    process.exit(code ?? 1);
  }
});

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    if (res.ok) {
      console.log(`[backend] 就绪 http://127.0.0.1:${port}（数据目录 ${dataDir}）`);
      break;
    }
  } catch {
    /* 还没起来 */
  }
  if (attempt === 119) throw new Error('后端未能在 60 秒内启动');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

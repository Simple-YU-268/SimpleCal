/**
 * 静态服务：按需切换「当前生效的构建」，模拟线上发版。
 *
 *   GET /fixture              -> 两份构建的元数据（指纹、资源清单）
 *   GET /switch?build=b       -> 切换生效的构建
 *   GET /api/version          -> 后端版本探测桩
 *   GET /api/v1/auth/session  -> 未登录会话
 *   其余路径                   -> 当前构建的静态文件
 */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildFixture } from './build-fixture.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const builds = await buildFixture();
let active = builds.a;

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');

  if (url.pathname === '/fixture') {
    json(res, {
      a: { fingerprint: builds.a.fingerprint, assets: builds.a.assets, swCache: builds.a.swCache },
      b: { fingerprint: builds.b.fingerprint, assets: builds.b.assets, swCache: builds.b.swCache },
    });
    return;
  }
  if (url.pathname === '/switch') {
    const next = builds[url.searchParams.get('build')];
    if (!next) {
      res.writeHead(400).end('unknown build');
      return;
    }
    active = next;
    res.end('ok');
    return;
  }
  if (url.pathname === '/api/version') {
    json(res, { version: active.version, https: { enabled: false, serving: false, port: 5243 } });
    return;
  }
  if (url.pathname === '/api/v1/auth/session') {
    json(res, { signedIn: false, csrf: 'e2e-csrf', user: null });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, { error: 'not_found' }, 404);
    return;
  }

  let name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!name || name.endsWith('/')) name += 'index.html';
  const file = path.join(active.distDir, name);
  if (!file.startsWith(active.distDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(5190, '127.0.0.1');

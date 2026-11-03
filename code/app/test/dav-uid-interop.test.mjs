import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';

/**
 * 0.5.0 客户端兼容：UID 允许域后缀。
 *
 * Apple Calendar（`…@apple`）、Thunderbird（`…@mozilla.org`）、DAVx5 都会用带 `@`
 * 的 UID。早先资源名只允许 `[A-Za-z0-9._-]`，这些客户端 PUT 事件直接 400
 * "invalid resource path"。这里既锁住放宽后的行为，也锁住路径穿越仍然被拒。
 */

const icsFor = (uid, summary = '域后缀 UID') => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//SimpleCal//UID Interop//EN',
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20261102T000000Z',
  'DTSTART:20261105T090000Z',
  'DTEND:20261105T100000Z',
  `SUMMARY:${summary}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** 递归收集目录下的文件名（用于定位落盘的 `<uid>.ics`）。 */
async function fileNames(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) out.push(...await fileNames(path.join(dir, entry.name)));
    else out.push(entry.name);
  }
  return out;
}

async function fixture(run) {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-uid-interop-'));
  let app;
  try {
    app = await createApp(resolveConfig({
      CALDAV_DATA_DIR: data,
      CALDAV_ADMIN_PASSWORD: 'Uid-Interop-42!',
      CALDAV_USER: 'probe',
    }), { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Uid-Interop-42!' }),
    });
    assert.equal(login.status, 200);
    const auth = {
      Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    const request = async (method, url, { body, headers = {} } = {}) => {
      const response = await fetch(`${origin}${url}`, {
        method,
        body,
        headers: { ...auth, ...headers },
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    await run(request, data);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
}

test('DAV 接受带域名后缀的 UID，且 Web 侧能读到同一个事件', { timeout: 30000 }, () => fixture(async (request, data) => {
  const uid = 'interop-001@client.example';
  const created = await request('PUT', `/calendars/probe/default/${encodeURIComponent(uid)}.ics`, {
    body: icsFor(uid),
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  assert.equal(created.status, 201, created.text);

  const read = await request('GET', `/calendars/probe/default/${encodeURIComponent(uid)}.ics`);
  assert.equal(read.status, 200);
  assert.match(read.text, /UID:interop-001@client\.example/);

  // Web 侧（KV 门面）必须看得到同一条事件，两侧才是同一个对象。
  const listed = await request('GET', '/api/v1/kv?pattern=cal:default:evt:*');
  assert.equal(listed.status, 200, listed.text);
  assert.match(listed.text, /interop-001@client\.example/);

  // 落盘文件名也要保持 UID 原样（不转义、不丢字符）。
  const objects = await fileNames(path.join(data, 'calendars'));
  assert.ok(objects.includes(`${uid}.ics`), `落盘文件缺失：${objects.join(', ')}`);
}));

test('Web 侧写入的域后缀 UID 也能从 DAV 读回', { timeout: 30000 }, () => fixture(async (request) => {
  const uid = 'web-002@client.example';
  const start = Date.parse('2026-11-05T09:00:00.000Z');
  const written = await request('POST', '/api/v1/kv', {
    body: JSON.stringify([{
      key: `cal:default:evt:${uid}`,
      value: {
        id: uid,
        uid,
        title: '来自 Web 的事件',
        start,
        end: start + 3600000,
        allDay: false,
      },
    }]),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(written.status, 200, written.text);

  const read = await request('GET', `/calendars/probe/default/${encodeURIComponent(uid)}.ics`);
  assert.equal(read.status, 200);
  assert.match(read.text, /UID:web-002@client\.example/);
}));

test('放宽 UID 字符集后，路径穿越与非法字符仍被拒绝', { timeout: 30000 }, () => fixture(async (request) => {
  const rejected = [
    '/calendars/probe/default/..%2F..%2Fevil.ics',
    '/calendars/probe/default/a%2Fb.ics',
    '/calendars/probe/default/bad%20space.ics',
    '/calendars/probe/default/ctrl%00.ics',
    '/calendars/probe/default/plain.txt',
  ];
  for (const url of rejected) {
    const response = await request('PUT', url, {
      body: icsFor('probe'),
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
    assert.ok(response.status === 400 || response.status === 404, `${url} -> ${response.status}`);
  }
}));

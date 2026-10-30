import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const { createApp, resolveConfig } = await import((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR)
  ? pathToFileURL(path.join((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR), 'server.mjs')).href
  : new URL('../server.mjs', import.meta.url).href);

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Share Test//EN\r\nBEGIN:VEVENT\r\nUID:private-title\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261101T090000Z\r\nDTEND:20261101T100000Z\r\nSUMMARY:Confidential meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('share links expose only their capability and revoke immediately', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-shares-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Share-Pass-42!', CALDAV_USER: 'probe' }), {
      skipAutoReconcile: true,
      logger: { event() {}, access() {} },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Share-Pass-42!' }),
    });
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    async function request(method, url, { body, headers = {}, anonymous = false } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...(anonymous ? {} : auth), ...headers }, body });
      const text = await response.text();
      let json = null;
      if (/application\/json/.test(response.headers.get('content-type') || '')) json = JSON.parse(text);
      return { status: response.status, text, json, headers: response.headers };
    }
    assert.equal((await request('PUT', '/calendars/probe/default/private-title.ics', {
      body: ics, headers: { 'Content-Type': 'text/calendar' },
    })).status, 201);

    const created = await request('POST', '/api/v1/shares', {
      body: JSON.stringify({ calendarId: 'default', mode: 'freebusy', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.share.mode, 'freebusy');
    assert.match(created.json.token, /^simplecal_share_[a-f0-9]{64}$/);
    assert.ok(!('tokenHash' in created.json.share));
    const freebusyUrl = `/share/${created.json.token}?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`;
    const busy = await request('GET', freebusyUrl, { anonymous: true });
    assert.equal(busy.status, 200, busy.text);
    assert.deepEqual(busy.json.busy, [{ start: '2026-11-01T09:00:00.000Z', end: '2026-11-01T10:00:00.000Z' }]);
    assert.doesNotMatch(busy.text, /Confidential|private-title/);
    assert.equal((await request('GET', `/share/${created.json.token}?unexpected=1`, { anonymous: true })).status, 400);

    const listed = await request('GET', '/api/v1/shares');
    assert.equal(listed.status, 200);
    assert.equal(listed.json.shares.length, 1);
    assert.ok(!('token' in listed.json.shares[0]) && !('tokenHash' in listed.json.shares[0]));

    const full = await request('POST', '/api/v1/shares', {
      body: JSON.stringify({ calendarId: 'default', mode: 'calendar', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(full.status, 201, full.text);
    const exported = await request('GET', `/share/${full.json.token}`, { anonymous: true });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /^text\/calendar/);
    assert.match(exported.text, /SUMMARY:Confidential meeting/);

    const revoked = await request('DELETE', `/api/v1/shares/${created.json.share.id}`);
    assert.equal(revoked.status, 200);
    assert.equal((await request('GET', freebusyUrl, { anonymous: true })).status, 404);
    assert.equal((await request('DELETE', `/api/v1/shares/${created.json.share.id}`)).status, 404);

    assert.equal((await request('PATCH', '/api/v1/calendars/default', {
      body: JSON.stringify({ davAccess: 'hidden' }), headers: { 'Content-Type': 'application/json' },
    })).status, 200);
    assert.equal((await request('GET', `/share/${full.json.token}`, { anonymous: true })).status, 404);
    assert.equal((await request('POST', '/api/v1/shares', {
      body: JSON.stringify({ calendarId: 'default', mode: 'calendar' }), headers: { 'Content-Type': 'application/json' },
    })).status, 403);
    assert.equal((await request('POST', '/api/v1/shares', {
      body: JSON.stringify({ calendarId: 'tasks', mode: 'freebusy' }), headers: { 'Content-Type': 'application/json' },
    })).status, 409);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

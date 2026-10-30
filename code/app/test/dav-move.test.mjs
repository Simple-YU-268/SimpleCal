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

const xml = 'application/xml; charset=utf-8';
const calendar = 'text/calendar; charset=utf-8';
const event = (uid, title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//MOVE Test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const syncBody = (token) => `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;
const tokenOf = (body) => /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(body)?.[1];

test('DAV MOVE preserves content and commits source/target sync history', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-dav-move-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Move-Pass-42!', CALDAV_USER: 'probe' }), {
      skipAutoReconcile: true,
      logger: { event() {}, access() {} },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Move-Pass-42!' }),
    });
    assert.equal(login.status, 200);
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    async function request(method, url, { body, headers = {} } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...auth, ...headers }, body });
      return { status: response.status, text: await response.text(), headers: response.headers };
    }
    const source = '/calendars/probe/default/';
    const target = '/calendars/probe/archive/';
    assert.equal((await request('MKCALENDAR', target, { body: '', headers: { 'Content-Type': xml } })).status, 201);
    for (const [file, uid, title] of [['sample.ics', 'sample', 'Move me'], ['other.ics', 'other', 'Other'], ['third.ics', 'third', 'Third']]) {
      assert.equal((await request('PUT', `${source}${file}`, { body: event(uid, title), headers: { 'Content-Type': calendar } })).status, 201);
    }
    assert.equal((await request('PUT', `${target}occupied.ics`, { body: event('occupied', 'Occupied'), headers: { 'Content-Type': calendar } })).status, 201);
    const sourceSync = await request('REPORT', source, { body: syncBody(''), headers: { 'Content-Type': xml, Depth: '1' } });
    const targetSync = await request('REPORT', target, { body: syncBody(''), headers: { 'Content-Type': xml, Depth: '1' } });
    const sourceToken = tokenOf(sourceSync.text);
    const targetToken = tokenOf(targetSync.text);
    assert.ok(sourceToken && targetToken);

    const created = await request('MOVE', `${source}sample.ics`, {
      headers: { Destination: `${base}${target}moved.ics`, Overwrite: 'F' },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('location'), `${target}moved.ics`);
    const moved = await request('GET', `${target}moved.ics`);
    assert.equal(moved.status, 200);
    assert.match(moved.text, /SUMMARY:Move me/);
    assert.equal(moved.headers.get('etag'), created.headers.get('etag'));
    assert.equal((await request('GET', `${source}sample.ics`)).status, 404);

    const sourceChanges = await request('REPORT', source, { body: syncBody(sourceToken), headers: { 'Content-Type': xml, Depth: '1' } });
    const targetChanges = await request('REPORT', target, { body: syncBody(targetToken), headers: { 'Content-Type': xml, Depth: '1' } });
    assert.match(sourceChanges.text, /sample\.ics<\/D:href><D:status>HTTP\/1\.1 404/);
    assert.match(targetChanges.text, /moved\.ics/);
    assert.doesNotMatch(targetChanges.text, /moved\.ics<\/D:href><D:status>HTTP\/1\.1 404/);

    const refused = await request('MOVE', `${source}other.ics`, {
      headers: { Destination: `${target}moved.ics`, Overwrite: 'F' },
    });
    assert.equal(refused.status, 412);
    assert.match((await request('GET', `${target}moved.ics`)).text, /SUMMARY:Move me/);
    assert.equal((await request('GET', `${source}other.ics`)).status, 200);

    const stale = await request('MOVE', `${source}other.ics`, {
      headers: { Destination: `${target}moved.ics`, 'If-Match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
    });
    assert.equal(stale.status, 412);
    assert.equal((await request('GET', `${source}other.ics`)).status, 200);

    const current = await request('GET', `${source}other.ics`);
    const overwritten = await request('MOVE', `${source}other.ics`, {
      headers: { Destination: `${target}moved.ics`, 'If-Match': current.headers.get('etag'), Overwrite: 'T' },
    });
    assert.equal(overwritten.status, 204, overwritten.text);
    assert.match((await request('GET', `${target}moved.ics`)).text, /SUMMARY:Other/);
    assert.equal((await request('GET', `${source}other.ics`)).status, 404);

    const crossOrigin = await request('MOVE', `${source}third.ics`, {
      headers: { Destination: `https://example.invalid${target}stolen.ics` },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await request('GET', `${source}third.ics`)).status, 200);

    const wrongType = await request('MOVE', `${source}third.ics`, {
      headers: { Destination: '/calendars/probe/tasks/third.ics' },
    });
    assert.equal(wrongType.status, 403);
    assert.equal((await request('GET', `${source}third.ics`)).status, 200);

    assert.equal((await request('PATCH', '/api/v1/calendars/archive', {
      body: JSON.stringify({ davAccess: 'ro' }),
      headers: { 'Content-Type': 'application/json' },
    })).status, 200);
    const readOnly = await request('MOVE', `${source}third.ics`, {
      headers: { Destination: `${target}third.ics` },
    });
    assert.equal(readOnly.status, 403);
    assert.equal((await request('GET', `${source}third.ics`)).status, 200);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

test('Windows rejects case-only MOVE aliases without losing the source', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-dav-move-case-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Move-Pass-42!', CALDAV_USER: 'probe' }), {
      skipAutoReconcile: true,
      logger: { event() {}, access() {} },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Move-Pass-42!' }),
    });
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    async function request(method, url, { body, headers = {} } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...auth, ...headers }, body });
      return { status: response.status, text: await response.text() };
    }
    assert.equal((await request('PUT', '/calendars/probe/default/Sample.ics', {
      body: event('case-only', 'Preserve me'), headers: { 'Content-Type': calendar },
    })).status, 201);
    const moved = await request('MOVE', '/calendars/probe/default/Sample.ics', {
      headers: { Destination: `${base}/calendars/probe/default/sample.ics` },
    });
    assert.equal(moved.status, 403, moved.text);
    const source = await request('GET', '/calendars/probe/default/Sample.ics');
    assert.equal(source.status, 200, source.text);
    assert.match(source.text, /SUMMARY:Preserve me/);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

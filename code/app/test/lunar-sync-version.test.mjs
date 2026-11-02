import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';
import { etagOf } from '../store/file-store.mjs';
import { parseXml, find } from '../lib/xml.mjs';

test('lunar rollover commits one version shared by reads, sync and conditional writes, surviving restart', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-lunar-sync-'));
  let instant = Date.parse('2026-12-31T12:00:00Z');
  let app, origin, auth;
  const config = resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Lunar-Sync-42!', CALDAV_USER: 'probe' });
  const collection = '/calendars/probe/default/';
  const object = `${collection}lunar.ics`;
  const start = async () => {
    app = await createApp(config, { now: () => instant, skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Lunar-Sync-42!' }) });
    assert.equal(login.status, 200);
    auth = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'X-CSRF-Token': (await login.json()).csrf };
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); app = null; };
  const request = async (method, url, body, headers = {}) => {
    const r = await fetch(origin + url, { method, body, headers: { ...auth, 'Content-Type': 'application/xml', ...headers } });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const sync = (token = '') => request('REPORT', collection,
    `<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/><C:calendar-data/></D:prop></D:sync-collection>`);
  try {
    await start();
    const source = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:lunar\r\nDTSTAMP:20261030T000000Z\r\nDTSTART;VALUE=DATE:20260925\r\nDTEND;VALUE=DATE:20260926\r\nSUMMARY:Lunar\r\nX-FNCAL-LUNAR:1\r\nX-FNCAL-LUNAR-DATE:8-15\r\nX-FNCAL-LUNAR-RULE:YEARLY-LUNAR\r\nX-CUSTOM:preserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    assert.equal((await request('PUT', object, source, { 'Content-Type': 'text/calendar' })).status, 201);
    const before = await request('GET', object);
    const oldTag = before.headers.get('etag');
    assert.equal(oldTag, `"${etagOf(before.text)}"`);
    const initial = await sync();
    const oldToken = find(parseXml(initial.text), 'sync-token').text;
    instant = Date.parse('2027-03-02T12:00:00Z');
    const changed = await request('GET', object, undefined, { 'If-None-Match': oldTag });
    assert.equal(changed.status, 200);
    const tag = changed.headers.get('etag');
    assert.notEqual(tag, oldTag);
    assert.equal(tag, `"${etagOf(changed.text)}"`);
    assert.match(changed.text, /X-CUSTOM:preserved/);
    const delta = await sync(oldToken);
    const tree = parseXml(delta.text);
    const token = find(tree, 'sync-token').text;
    assert.notEqual(token, oldToken);
    assert.equal(find(tree, 'getetag').text, tag);
    assert.equal(find(tree, 'calendar-data').text, changed.text.replace(/\r\n/g, '\n'));
    const properties = await request('PROPFIND', object, '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getcontentlength/></D:prop></D:propfind>');
    assert.equal(find(parseXml(properties.text), 'getetag').text, tag);
    assert.equal((await request('HEAD', object, undefined, { 'If-None-Match': tag })).status, 304);
    assert.equal((await request('PUT', object, source, { 'Content-Type': 'text/calendar', 'If-Match': oldTag })).status, 412);
    const races = await Promise.all([sync(token), request('GET', object), sync(token)]);
    assert.equal(find(parseXml(races[0].text), 'sync-token').text, token);
    assert.equal(find(parseXml(races[2].text), 'sync-token').text, token);
    const exported = await request('GET', collection);
    assert.ok(exported.text.includes(changed.text.match(/^RDATE[^\r\n]*/m)[0]));
    await stop(); await start();
    assert.equal((await request('GET', object)).headers.get('etag'), tag);
    assert.equal(find(parseXml((await sync(token)).text), 'sync-token').text, token);
    assert.equal((await request('PUT', object, changed.text.replace('SUMMARY:Lunar', 'SUMMARY:Updated'),
      { 'Content-Type': 'text/calendar', 'If-Match': tag })).status, 204);
  } finally {
    if (app) await stop();
    await rm(data, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { checkEntityConditions } from '../dav/preconditions.mjs';
const { createApp, resolveConfig } = await import((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR)
  ? pathToFileURL(path.join((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR), 'server.mjs')).href
  : new URL('../server.mjs', import.meta.url).href);

test('HTTP tag comparisons distinguish strong, weak, wildcard and quoted lists', () => {
  const current = { etag: 'abc' };
  assert.equal(checkEntityConditions({ 'if-match': 'W/"abc"' }, current).status, 412);
  assert.equal(checkEntityConditions({ 'if-match': '"a,b", "abc"' }, current), null);
  assert.equal(checkEntityConditions({ 'if-match': '*' }, null).status, 412);
  assert.equal(checkEntityConditions({ 'if-none-match': '*' }, null), null);
  assert.equal(checkEntityConditions({ 'if-none-match': 'W/"abc"' }, current).status, 412);
  assert.equal(checkEntityConditions({ 'if-none-match': 'W/"abc"' }, current, { read: true }).status, 304);
  assert.equal(checkEntityConditions({ 'if-match': 'unquoted' }, current).status, 400);
  assert.equal(checkEntityConditions({ 'if-match': '"abc",' }, current).status, 400);
});

test('DAV conditional writes share the event API queue; collections export ICS', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-dav-fusion-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Fusion-Pass-42!',
      CALDAV_USER: 'probe' }), { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Fusion-Pass-42!' }) });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf };
    async function request(method, url, { body, headers = {}, anonymous = false } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...(anonymous ? {} : auth), ...headers }, body });
      return { status: response.status, text: await response.text(), headers: response.headers };
    }
    const collection = '/calendars/probe/default/';
    const url = `${collection}sample.ics`;
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Fusion Test//EN\r\nBEGIN:VEVENT\r\nUID:sample\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Original\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const content = { 'Content-Type': 'text/calendar' };
    const options = await request('OPTIONS', '/', { anonymous: true });
    assert.equal(options.status, 200);
    const methods = options.headers.get('allow').split(/,\s*/);
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'MOVE', 'MKCALENDAR', 'REPORT']) assert.ok(methods.includes(method));
    for (const method of ['LOCK', 'UNLOCK', 'MKCOL']) assert.ok(!methods.includes(method));
    assert.ok(!options.headers.get('dav').split(/,\s*/).includes('2'));
    assert.ok(!options.headers.get('dav').includes('addressbook'));
    const created = await Promise.all([1, 2].map(() => request('PUT', url,
      { body: ics, headers: { ...content, 'If-None-Match': '*' } })));
    assert.deepEqual(created.map((r) => r.status).sort(), [201, 412]);
    let etag = created.find((r) => r.status === 201).headers.get('etag');
    assert.equal((await request('PUT', url, { body: ics, headers: { ...content, 'If-Match': `W/${etag}` } })).status, 412);
    const edits = await Promise.all(['First', 'Second'].map((title) => request('PUT', url,
      { body: ics.replace('Original', title), headers: { ...content, 'If-Match': etag } })));
    assert.deepEqual(edits.map((r) => r.status).sort(), [204, 412]);
    etag = edits.find((r) => r.status === 204).headers.get('etag');
    const mixed = await Promise.all([
      request('PUT', url, { body: ics.replace('Original', 'DAV writer'), headers: { ...content, 'If-Match': etag } }),
      request('PATCH', '/api/v1/calendars/default/events/sample', { body: JSON.stringify({ title: 'API writer' }),
        headers: { 'Content-Type': 'application/json', 'If-Match': etag } }),
    ]);
    assert.equal(mixed.filter((r) => r.status >= 200 && r.status < 300).length, 1);
    assert.equal(mixed.filter((r) => r.status === 412).length, 1);

    const exported = await request('GET', collection);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /^text\/calendar/);
    assert.match(exported.headers.get('content-disposition'), /default\.ics/);
    assert.equal((exported.text.match(/BEGIN:VCALENDAR/g) || []).length, 1);
    assert.match(exported.text, /UID:sample/);
    const property = await request('PROPFIND', collection, { headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>' });
    assert.equal(property.status, 207);
    assert.ok(property.text.includes(`<D:getetag>${exported.headers.get('etag')}</D:getetag>`));
    assert.equal((await request('GET', collection, { headers: { 'If-None-Match': exported.headers.get('etag') } })).status, 304);
    const head = await request('HEAD', collection);
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(exported.text));
    assert.equal(head.headers.get('etag'), exported.headers.get('etag'));
    const second = await request('PUT', `${collection}second.ics`, { body: ics.replace('UID:sample', 'UID:second'), headers: content });
    assert.equal(second.status, 201);
    const changed = await request('GET', collection, { headers: { 'If-None-Match': exported.headers.get('etag') } });
    assert.equal(changed.status, 200);
    assert.equal((changed.text.match(/BEGIN:VEVENT/g) || []).length, 2);
    const object = await request('GET', url);
    const deleted = await Promise.all([1, 2].map(() => request('DELETE', url,
      { headers: { 'If-Match': object.headers.get('etag') } })));
    assert.deepEqual(deleted.map((r) => r.status).sort(), [204, 412]);
    await request('DELETE', `${collection}second.ics`);
    const empty = await request('GET', collection);
    assert.equal(empty.status, 200);
    assert.match(empty.text, /BEGIN:VCALENDAR/);
    assert.doesNotMatch(empty.text, /BEGIN:VEVENT/);
    // HTTP import/export and DAV collection GET share SimpleCal's serializer.
    const zoned = ics.replace('BEGIN:VEVENT',
      'BEGIN:VTIMEZONE\r\nTZID:Etc/UTC\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT');
    for (const uid of ['import-one', 'import-two']) {
      const imported = await request('POST', '/api/v1/import?calendar=default',
        { body: zoned.replace('UID:sample', `UID:${uid}`), headers: content });
      assert.equal(imported.status, 200, imported.text);
    }
    const apiExport = await request('GET', '/api/v1/export?calendar=default');
    const davExport = await request('GET', collection);
    assert.equal(apiExport.status, 200);
    assert.equal(davExport.status, 200);
    for (const exported of [apiExport, davExport]) {
      assert.equal((exported.text.match(/BEGIN:VEVENT/g) || []).length, 2);
      assert.equal((exported.text.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
      assert.match(exported.text, /UID:import-one/);
      assert.match(exported.text, /UID:import-two/);
    }
    const patchMeta = (body) => request('PATCH', '/api/v1/calendars/default',
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await patchMeta({ davAccess: 'ro' })).status, 200);
    assert.equal((await request('PUT', url, { body: ics, headers: content })).status, 403);
    assert.equal((await request('GET', collection)).status, 200);
    assert.equal((await patchMeta({ davAccess: 'hidden' })).status, 200);
    assert.equal((await request('GET', collection)).status, 404);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

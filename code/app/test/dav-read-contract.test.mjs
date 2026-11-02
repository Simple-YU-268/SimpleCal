import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';

const xml = 'application/xml';
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Read Contract//EN\r\nBEGIN:VEVENT\r\nUID:sample\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Visible object\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const card = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:sample\r\nFN:Visible contact\r\nEND:VCARD\r\n';
const publicBase = 'https://calendar.example/simplecal';

async function fixture(run) {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-read-contract-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Read-Contract-42!',
      CALDAV_USER: 'probe', CALDAV_DAV_PREFIX: '/dav', CALDAV_PUBLIC_BASE_URL: publicBase }),
    { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Read-Contract-42!' }) });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf };
    const request = async (method, url, { body, headers = {} } = {}) => {
      const response = await fetch(`${origin}${url}`, { method, body, headers: { ...auth, ...headers } });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    await run(request, origin);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
}

test('CalDAV and CardDAV objects share conditional GET/HEAD behavior', { timeout: 30000 }, () => fixture(async (request) => {
  for (const [url, content, type] of [
    ['/dav/calendars/probe/default/sample.ics', ics, 'text/calendar'],
    ['/dav/addressbooks/probe/contacts/sample.vcf', card, 'text/vcard'],
  ]) {
    const created = await request('PUT', url, { body: content, headers: { 'Content-Type': type } });
    assert.equal(created.status, 201, created.text);
    const get = await request('GET', url);
    assert.equal(get.status, 200);
    const etag = get.headers.get('etag');
    assert.equal(etag, created.headers.get('etag'));
    for (const method of ['GET', 'HEAD']) {
      for (const value of [etag, `W/${etag}`, '*', `"other,tag", ${etag}`]) {
        const cached = await request(method, url, { headers: { 'If-None-Match': value } });
        assert.equal(cached.status, 304, `${method} ${url} ${value}`);
        assert.equal(cached.text, '');
        assert.equal(cached.headers.get('etag'), etag);
        assert.equal(Number(cached.headers.get('content-length')), Buffer.byteLength(get.text));
      }
      assert.equal((await request(method, url, { headers: { 'If-Match': '"stale"', 'If-None-Match': etag } })).status, 412);
      assert.equal((await request(method, url, { headers: { 'If-Match': `W/${etag}` } })).status, 412);
      assert.equal((await request(method, url, { headers: { 'If-None-Match': 'malformed' } })).status, 400);
      assert.equal((await request(method, url, { headers: { 'If-None-Match': '"other"' } })).status, 200);
    }
    const head = await request('HEAD', url);
    assert.equal(head.text, '');
    assert.equal(head.headers.get('etag'), etag);
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(get.text));
    const replacement = content.replace('Visible', 'Updated');
    assert.equal((await request('PUT', url, { body: replacement, headers: { 'Content-Type': type, 'If-Match': etag } })).status, 204);
    const changed = await request('GET', url, { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal((await request('GET', url.replace('/sample.', '/missing.'), { headers: { 'If-None-Match': '*' } })).status, 404);
  }
  // Materialized lunar projections now share their stored version with caching.
  const lunarUrl = '/dav/calendars/probe/default/lunar.ics';
  const lunar = ics.replace('UID:sample', 'UID:lunar').replace('SUMMARY:Visible object',
    'SUMMARY:Lunar\r\nX-FNCAL-LUNAR:1\r\nX-FNCAL-LUNAR-DATE:8-15\r\nX-FNCAL-LUNAR-RULE:YEARLY-LUNAR');
  const created = await request('PUT', lunarUrl, { body: lunar, headers: { 'Content-Type': 'text/calendar' } });
  assert.equal(created.status, 201);
  const refreshed = await request('GET', lunarUrl, { headers: { 'If-None-Match': created.headers.get('etag') } });
  assert.equal(refreshed.status, 304);
  assert.match((await request('GET', lunarUrl)).text, /RDATE/);
}));

test('multiget is confined to its authenticated collection and resolves public/relative hrefs', { timeout: 30000 }, () => fixture(async (request, origin) => {
  const collection = '/dav/calendars/probe/default/';
  const object = `${collection}sample.ics`;
  assert.equal((await request('PUT', object, { body: ics, headers: { 'Content-Type': 'text/calendar' } })).status, 201);
  const hidden = '/dav/calendars/probe/private/';
  assert.equal((await request('MKCALENDAR', hidden)).status, 201);
  assert.equal((await request('PUT', `${hidden}secret.ics`, { body: ics.replace('UID:sample', 'UID:secret').replace('Visible object', 'Hidden secret'), headers: { 'Content-Type': 'text/calendar' } })).status, 201);
  assert.equal((await request('PATCH', '/api/v1/calendars/private', { body: JSON.stringify({ davAccess: 'hidden' }), headers: { 'Content-Type': 'application/json' } })).status, 200);
  assert.equal((await request('GET', `${hidden}secret.ics`)).status, 404);
  const report = (href, root = collection) => request('REPORT', root, {
    body: `<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>${href}</D:href></C:calendar-multiget>`, headers: { 'Content-Type': xml } });
  for (const href of [object, `${origin}${object}`, `${publicBase}${object}`, `/simplecal${object}`, 'sample.ics']) {
    const result = await report(href);
    assert.equal(result.status, 207, href);
    assert.match(result.text, /HTTP\/1\.1 200 OK/);
    assert.match(result.text, /Visible object/);
  }
  for (const href of [`${hidden}secret.ics`, '/dav/calendars/other/default/sample.ics',
    `https://outside.invalid${object}`, `//outside.invalid${object}`, `http://user:password@127.0.0.1${object}`,
    `${object}?query=1`, `${object}#fragment`, '../default/sample.ics', '%2e%2e/default/sample.ics',
    '/dav/calendars/probe/default/%73%61%6d%70%6c%65%2f.ics', 'http://[invalid', '%invalid']) {
    const result = await report(href);
    assert.equal(result.status, 207, href);
    assert.match(result.text, /HTTP\/1\.1 404 Not Found/, href);
    assert.doesNotMatch(result.text, /calendar-data>|Visible object|Hidden secret/);
  }
  assert.equal((await report(object, '/dav/calendars/probe/')).status, 403);
  const book = '/dav/addressbooks/probe/contacts/';
  assert.equal((await request('PUT', `${book}sample.vcf`, { body: card, headers: { 'Content-Type': 'text/vcard' } })).status, 201);
  for (const [href, status] of [['sample.vcf', 200], [`/simplecal${book}sample.vcf`, 200],
    [`${publicBase}${book}sample.vcf`, 200], [`https://outside.invalid${book}sample.vcf`, 404],
    ['../contacts/sample.vcf', 404], ['/dav/addressbooks/other/contacts/sample.vcf', 404]]) {
    const result = await request('REPORT', book, { headers: { 'Content-Type': xml },
      body: `<A:addressbook-multiget xmlns:A="urn:ietf:params:xml:ns:carddav" xmlns:D="DAV:"><D:prop><A:address-data/></D:prop><D:href>${href}</D:href></A:addressbook-multiget>` });
    assert.equal(result.status, 207);
    assert.ok(result.text.includes(`HTTP/1.1 ${status}`), href);
  }
}));

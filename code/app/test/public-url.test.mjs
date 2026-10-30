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

const publicOrigin = 'https://calendar.example';
const publicBase = `${publicOrigin}/fncal`;
const xml = 'application/xml; charset=utf-8';
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:public\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Public URL\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const card = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:public-card\r\nFN:Public Card\r\nEND:VCARD\r\n';

test('explicit public base unifies discovery, locations, API and share URLs', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-public-url-'));
  let app;
  try {
    const config = resolveConfig({
      CALDAV_DATA_DIR: data,
      CALDAV_ADMIN_PASSWORD: 'Public-Pass-42!',
      CALDAV_USER: 'probe',
      CALDAV_DAV_PREFIX: '/dav',
      CALDAV_PUBLIC_BASE_URL: `${publicBase}/`,
    });
    assert.equal(config.publicBaseUrl, publicBase);
    app = await createApp(config, { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Public-Pass-42!' }),
    });
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    async function request(method, url, { body, headers = {} } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...auth, ...headers }, body, redirect: 'manual' });
      const text = await response.text();
      let json = null;
      if (/application\/json/.test(response.headers.get('content-type') || '')) json = JSON.parse(text);
      return { status: response.status, text, json, headers: response.headers };
    }
    const principal = await request('PROPFIND', '/dav/principals/probe/', {
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:prop><C:calendar-home-set/><A:addressbook-home-set/></D:prop></D:propfind>',
      headers: { 'Content-Type': xml, Depth: '0' },
    });
    assert.equal(principal.status, 207);
    assert.match(principal.text, new RegExp(`${publicBase}/dav/calendars/probe/`));
    assert.match(principal.text, new RegExp(`${publicBase}/dav/addressbooks/probe/`));

    const created = await request('PUT', '/dav/calendars/probe/default/public.ics', {
      body: ics, headers: { 'Content-Type': 'text/calendar' },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('location'), `${publicBase}/dav/calendars/probe/default/public.ics`);
    const moved = await request('MOVE', '/dav/calendars/probe/default/public.ics', {
      headers: { Destination: `${publicBase}/dav/calendars/probe/default/moved.ics` },
    });
    assert.equal(moved.status, 201, moved.text);
    assert.equal(moved.headers.get('location'), `${publicBase}/dav/calendars/probe/default/moved.ics`);
    const calendarMultiget = await request('REPORT', '/dav/calendars/probe/default/', {
      body: `<?xml version="1.0"?><C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><D:href>${publicBase}/dav/calendars/probe/default/moved.ics</D:href></C:calendar-multiget>`,
      headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(calendarMultiget.status, 207);
    assert.match(calendarMultiget.text, /HTTP\/1\.1 200 OK/);
    assert.doesNotMatch(calendarMultiget.text, /HTTP\/1\.1 404 Not Found/);

    const contact = await request('PUT', '/dav/addressbooks/probe/contacts/public.vcf', {
      body: card, headers: { 'Content-Type': 'text/vcard' },
    });
    assert.equal(contact.status, 201, contact.text);
    assert.equal(contact.headers.get('location'), `${publicBase}/dav/addressbooks/probe/contacts/public.vcf`);
    const multiget = await request('REPORT', '/dav/addressbooks/probe/contacts/', {
      body: `<?xml version="1.0"?><A:addressbook-multiget xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/></D:prop><D:href>${publicBase}/dav/addressbooks/probe/contacts/public.vcf</D:href></A:addressbook-multiget>`,
      headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(multiget.status, 207);
    assert.match(multiget.text, /HTTP\/1\.1 200 OK/);
    assert.doesNotMatch(multiget.text, /HTTP\/1\.1 404 Not Found/);

    const info = await request('GET', '/api/v1/calendars/server-info');
    assert.equal(info.status, 200);
    assert.equal(info.json.davBase, `${publicBase}/dav/calendars/probe/`);
    assert.equal(info.json.webBase, `${publicBase}/`);
    assert.equal(info.json.host, 'calendar.example');

    const share = await request('POST', '/api/v1/shares', {
      body: JSON.stringify({ calendarId: 'default', mode: 'freebusy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(share.status, 201, share.text);
    assert.equal(share.json.url, `${publicBase}/share/${share.json.token}`);

    const wellKnown = await request('GET', '/.well-known/carddav');
    assert.equal(wellKnown.status, 302);
    assert.equal(wellKnown.headers.get('location'), `${publicBase}/dav/principals/`);
    assert.throws(() => resolveConfig({ CALDAV_PUBLIC_BASE_URL: 'not a URL' }), /PUBLIC_BASE_URL/);
    assert.throws(() => resolveConfig({ CALDAV_PUBLIC_BASE_URL: 'https://user:secret@example.test/root' }), /PUBLIC_BASE_URL/);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

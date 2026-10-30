import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const { createApp, resolveConfig } = await import((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR)
  ? pathToFileURL(path.join((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR), 'server.mjs')).href
  : new URL('../server.mjs', import.meta.url).href);

const xml = 'application/xml; charset=utf-8';
const vcard = (uid, name, email) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nFN:${name}\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
const syncBody = (token) => `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/><A:address-data xmlns:A="urn:ietf:params:xml:ns:carddav"/></D:prop></D:sync-collection>`;
const tokenOf = (body) => /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(body)?.[1];

test('CardDAV discovers contacts and supports vCard conditions, reports and sync', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-carddav-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Card-Pass-42!', CALDAV_USER: 'probe' }), {
      skipAutoReconcile: true,
      logger: { event() {}, access() {} },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Card-Pass-42!' }),
    });
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    async function request(method, url, { body, headers = {}, anonymous = false } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...(anonymous ? {} : auth), ...headers }, body });
      return { status: response.status, text: await response.text(), headers: response.headers };
    }
    const home = '/addressbooks/probe/';
    const book = `${home}contacts/`;
    const options = await request('OPTIONS', book, { anonymous: true });
    assert.equal(options.status, 200);
    assert.match(options.headers.get('dav'), /addressbook/);
    assert.match(options.headers.get('allow'), /REPORT/);

    const principal = await request('PROPFIND', '/principals/probe/', {
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:prop><A:addressbook-home-set/></D:prop></D:propfind>',
      headers: { 'Content-Type': xml, Depth: '0' },
    });
    assert.equal(principal.status, 207);
    assert.match(principal.text, /addressbook-home-set/);
    assert.match(principal.text, /\/addressbooks\/probe\//);

    const discovered = await request('PROPFIND', home, {
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/></D:prop></D:propfind>',
      headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(discovered.status, 207, discovered.text);
    assert.match(discovered.text, /\/addressbooks\/probe\/contacts\//);
    assert.match(discovered.text, /<A:addressbook\/>/);

    const alice = vcard('alice-uid', 'Alice Example', 'alice@example.test');
    const created = await request('PUT', `${book}alice.vcf`, {
      body: alice, headers: { 'Content-Type': 'text/vcard', 'If-None-Match': '*' },
    });
    assert.equal(created.status, 201, created.text);
    const etag = created.headers.get('etag');
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    const fetched = await request('GET', `${book}alice.vcf`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.text, alice);
    assert.equal((await request('GET', `${book}alice.vcf`, { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal((await request('PUT', `${book}alice.vcf`, {
      body: vcard('alice-uid', 'Stale Alice', 'stale@example.test'),
      headers: { 'Content-Type': 'text/vcard', 'If-Match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
    })).status, 412);
    assert.equal((await request('PUT', `${book}duplicate.vcf`, {
      body: alice, headers: { 'Content-Type': 'text/vcard' },
    })).status, 403);

    await request('PUT', `${book}bob.vcf`, {
      body: vcard('bob-uid', 'Bob Example', 'bob@example.test'), headers: { 'Content-Type': 'text/vcard' },
    });
    const query = await request('REPORT', book, {
      body: '<?xml version="1.0"?><A:addressbook-query xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><A:address-data/></D:prop><A:filter><A:prop-filter name="FN"><A:text-match>Alice</A:text-match></A:prop-filter></A:filter></A:addressbook-query>',
      headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(query.status, 207, query.text);
    assert.match(query.text, /alice\.vcf/);
    assert.doesNotMatch(query.text, /bob\.vcf/);

    const multiget = await request('REPORT', book, {
      body: `<?xml version="1.0"?><A:addressbook-multiget xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><A:address-data/></D:prop><D:href>${book}alice.vcf</D:href><D:href>${book}missing.vcf</D:href></A:addressbook-multiget>`,
      headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(multiget.status, 207);
    assert.match(multiget.text, /Alice Example/);
    assert.match(multiget.text, /missing\.vcf<\/D:href><D:status>HTTP\/1\.1 404/);

    const initialSync = await request('REPORT', book, {
      body: syncBody(''), headers: { 'Content-Type': xml, Depth: '1' },
    });
    const token = tokenOf(initialSync.text);
    assert.ok(token);
    const updated = await request('PUT', `${book}alice.vcf`, {
      body: vcard('alice-uid', 'Alice Updated', 'alice@example.test'),
      headers: { 'Content-Type': 'text/vcard', 'If-Match': etag },
    });
    assert.equal(updated.status, 204);
    assert.equal((await request('DELETE', `${book}bob.vcf`)).status, 204);
    const incremental = await request('REPORT', book, {
      body: syncBody(token), headers: { 'Content-Type': xml, Depth: '1' },
    });
    assert.equal(incremental.status, 207);
    assert.match(incremental.text, /Alice Updated/);
    assert.match(incremental.text, /bob\.vcf<\/D:href><D:status>HTTP\/1\.1 404/);

    const extended = '<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:set><D:prop><D:resourcetype><D:collection/><A:addressbook/></D:resourcetype><D:displayname>Team</D:displayname><A:addressbook-description>Shared team contacts</A:addressbook-description></D:prop></D:set></D:mkcol>';
    const made = await request('MKCOL', `${home}team/`, { body: extended, headers: { 'Content-Type': xml } });
    assert.equal(made.status, 201, made.text);
    const patched = await request('PROPPATCH', `${home}team/`, {
      body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>Team Updated</D:displayname></D:prop></D:set></D:propertyupdate>',
      headers: { 'Content-Type': xml },
    });
    assert.equal(patched.status, 207);
    assert.match(patched.text, /Team Updated/);

    const other = await request('POST', '/api/v1/admin/users', {
      body: JSON.stringify({ username: 'other', password: 'Other-Pass-42!', role: 'user' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(other.status, 201, other.text);
    assert.equal((await request('GET', '/addressbooks/other/contacts/alice.vcf')).status, 403);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

test('deleting an account removes its CardDAV data', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-carddav-delete-'));
  let app;
  try {
    const config = resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Card-Pass-42!', CALDAV_USER: 'probe' });
    app = await createApp(config, { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function login(username, password) {
      const response = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return {
        Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
        'X-CSRF-Token': (await response.json()).csrf,
      };
    }
    const admin = await login('probe', 'Card-Pass-42!');
    async function request(method, url, { body, headers = {}, session = admin } = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { ...session, ...headers }, body });
      const text = await response.text();
      return { status: response.status, text, json: text ? JSON.parse(text) : null };
    }
    const created = await request('POST', '/api/v1/admin/users', {
      body: JSON.stringify({ username: 'other', password: 'Other-Pass-42!', role: 'user' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(created.status, 201, created.text);
    const userId = created.json.user.id;
    const other = await login('other', 'Other-Pass-42!');
    const contact = await request('PUT', '/addressbooks/other/contacts/alice.vcf', {
      session: other,
      body: vcard('alice-uid', 'Alice Example', 'alice@example.test'),
      headers: { 'Content-Type': 'text/vcard' },
    });
    assert.equal(contact.status, 201, contact.text);
    const userDirectory = path.join(config.varDir, 'addressbooks', userId);
    assert.equal((await stat(userDirectory)).isDirectory(), true);

    const removed = await request('DELETE', `/api/v1/admin/users/${userId}`);
    assert.equal(removed.status, 200, removed.text);
    await assert.rejects(stat(userDirectory), { code: 'ENOENT' });
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
});

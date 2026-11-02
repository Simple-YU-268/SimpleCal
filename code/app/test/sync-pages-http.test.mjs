import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';
import { parseXml, find, findAll } from '../lib/xml.mjs';

const DAV = 'DAV:', CAL = 'urn:ietf:params:xml:ns:caldav';
const collection = '/calendars/probe/default/';
const content = (uid, title = uid) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test('HTTP sync limit continuation preserves snapshot across edits, deletes, restart and hidden access', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-page-http-'));
  const config = resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_USER: 'probe', CALDAV_ADMIN_PASSWORD: 'Pages-HTTP-42!' });
  let app, origin, auth;
  const start = async () => {
    app = await createApp(config, { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Pages-HTTP-42!' }) });
    assert.equal(login.status, 200);
    auth = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'X-CSRF-Token': (await login.json()).csrf };
  };
  const stop = async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); app = null; };
  const request = async (method, url, body, headers = {}) => {
    const r = await fetch(origin + url, { method, body, headers: { ...auth, ...headers } });
    return { status: r.status, text: await r.text() };
  };
  const page = async (token = '', limit = 1) => {
    const result = await request('REPORT', collection,
      `<D:sync-collection xmlns:D="${DAV}" xmlns:C="${CAL}"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:limit><D:nresults>${limit}</D:nresults></D:limit><D:prop><D:getetag/><C:calendar-data/></D:prop></D:sync-collection>`, { 'Content-Type': 'application/xml' });
    if (result.status !== 207) return result;
    const tree = parseXml(result.text);
    return { ...result, token: find(tree, 'sync-token', DAV)?.text,
      objects: findAll(tree, 'calendar-data', CAL).map((node) => node.text),
      more: findAll(tree, 'status', DAV).some((node) => node.text.includes('507')) };
  };
  try {
    await start();
    for (const uid of ['a', 'b', 'c']) assert.equal((await request('PUT', `${collection}${uid}.ics`, content(uid), { 'Content-Type': 'text/calendar' })).status, 201);
    const first = await page();
    assert.equal(first.status, 207); assert.equal(first.objects.length, 1); assert.equal(first.more, true);
    assert.match(first.token, /^urn:simplecal:page:/);
    await request('PUT', `${collection}b.ics`, content('b', 'edited'), { 'Content-Type': 'text/calendar' });
    await request('DELETE', `${collection}c.ics`);
    await request('PUT', `${collection}d.ics`, content('d'), { 'Content-Type': 'text/calendar' });
    await stop(); await start();
    const captured = [...first.objects]; let token = first.token;
    for (let count = 0; count < 5; count += 1) {
      const next = await page(token); assert.equal(next.status, 207, next.text);
      captured.push(...next.objects); token = next.token;
      if (!next.more) break;
    }
    assert.match(token, /^urn:uuid:/);
    assert.deepEqual(captured.map((text) => /^UID:(.*)$/m.exec(text)[1]).sort(), ['a', 'b', 'c']);
    assert.match(captured.find((text) => /UID:b/.test(text)), /SUMMARY:b\n/);
    const delta = await page(token, 100);
    assert.equal(delta.status, 207);
    assert.match(delta.text, /SUMMARY:edited/); assert.match(delta.text, /UID:d/);
    assert.match(delta.text, /c\.ics/); assert.match(delta.text, /404 Not Found/);
    assert.equal((await page('', 0)).status, 400);
    assert.equal((await request('PATCH', '/api/v1/calendars/default', JSON.stringify({ davAccess: 'hidden' }), { 'Content-Type': 'application/json' })).status, 200);
    const denied = await page(first.token);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(denied.text, /BEGIN:VCALENDAR|SUMMARY:/);
    const book = '/addressbooks/probe/contacts/';
    const card = (uid, name = uid) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nFN:${name}\r\nEND:VCARD\r\n`;
    const cardPage = async (token = '', limit = 1) => {
      const r = await request('REPORT', book,
        `<D:sync-collection xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:limit><D:nresults>${limit}</D:nresults></D:limit><D:prop><D:getetag/><A:address-data/></D:prop></D:sync-collection>`,
        { 'Content-Type': 'application/xml' });
      assert.equal(r.status, 207, r.text);
      const tree = parseXml(r.text);
      return { token: find(tree, 'sync-token', DAV).text,
        cards: findAll(tree, 'address-data', 'urn:ietf:params:xml:ns:carddav').map((n) => n.text),
        more: findAll(tree, 'status', DAV).some((n) => n.text.includes('507')), text: r.text };
    };
    for (const uid of ['a', 'b', 'c']) assert.equal((await request('PUT', `${book}${uid}.vcf`, card(uid), { 'Content-Type': 'text/vcard' })).status, 201);
    const cardFirst = await cardPage();
    assert.equal(cardFirst.more, true);
    await request('PUT', `${book}b.vcf`, card('b', 'Changed'), { 'Content-Type': 'text/vcard' });
    await request('DELETE', `${book}c.vcf`);
    let cardToken = cardFirst.token;
    const cards = [...cardFirst.cards];
    for (let count = 0; count < 5; count += 1) {
      const next = await cardPage(cardToken); cards.push(...next.cards); cardToken = next.token;
      if (!next.more) break;
    }
    assert.deepEqual(cards.map((value) => /^UID:(.*)$/m.exec(value)[1]).sort(), ['a', 'b', 'c']);
    assert.match(cards.find((value) => /UID:b/.test(value)), /FN:b\n/);
    const cardDelta = await cardPage(cardToken, 100);
    assert.match(cardDelta.text, /FN:Changed/);
    assert.match(cardDelta.text, /c\.vcf/);
    assert.match(cardDelta.text, /404 Not Found/);
  } finally {
    if (app) await stop();
    await rm(data, { recursive: true, force: true });
  }
});

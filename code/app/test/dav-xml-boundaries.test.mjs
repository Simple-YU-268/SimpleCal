import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';
import { parseXml, find, findAll } from '../lib/xml.mjs';

const DAV = 'DAV:', CAL = 'urn:ietf:params:xml:ns:caldav', CARD = 'urn:ietf:params:xml:ns:carddav';
const namespaces = `xmlns:D="${DAV}" xmlns:C="${CAL}" xmlns:A="${CARD}" xmlns:e="urn:foreign"`;
const calendar = '/calendars/probe/default/';
const book = '/addressbooks/probe/contacts/';
const series = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//XML Boundaries//EN\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Private fixture body\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

async function fixture(run) {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-xml-boundaries-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_USER: 'probe',
      CALDAV_ADMIN_PASSWORD: 'XML-Boundaries-42!' }), { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'XML-Boundaries-42!' }) });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf };
    const request = async (method, url, body, contentType = 'application/xml') => {
      const response = await fetch(`${origin}${url}`, { method, body, headers: { ...auth, 'Content-Type': contentType } });
      return { status: response.status, text: await response.text() };
    };
    assert.equal((await request('PUT', `${calendar}series.ics`, series, 'text/calendar')).status, 201);
    await run(request);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
}

function rejected(result) {
  if ([400, 403].includes(result.status)) return true;
  assert.equal(result.status, 207, result.text);
  return false;
}

test('multiget and sync controls nested inside requested properties are never executed', { timeout: 30000 }, () => fixture(async (request) => {
  const multiget = await request('REPORT', calendar, `<C:calendar-multiget ${namespaces}><D:prop><D:getetag/><C:calendar-data/><e:payload><D:href>${calendar}series.ics</D:href></e:payload></D:prop><D:href>${calendar}missing.ics</D:href></C:calendar-multiget>`);
  assert.doesNotMatch(multiget.text, /Private fixture body|UID:series/);
  if (!rejected(multiget)) {
    assert.equal(findAll(parseXml(multiget.text), 'response', DAV).length, 1);
    assert.match(multiget.text, /404 Not Found/);
  }
  const initial = await request('REPORT', calendar, `<D:sync-collection ${namespaces}><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`);
  assert.equal(initial.status, 207, initial.text);
  const token = find(parseXml(initial.text), 'sync-token', DAV)?.text;
  assert.ok(token);
  const next = await request('REPORT', calendar, `<D:sync-collection ${namespaces}><D:prop><D:getetag/><e:payload><e:sync-token>urn:poison</e:sync-token><e:sync-level>bogus</e:sync-level></e:payload></D:prop><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level></D:sync-collection>`);
  assert.doesNotMatch(next.text, /valid-sync-token/);
  if (!rejected(next)) {
    assert.equal(findAll(parseXml(next.text), 'response', DAV).length, 0);
    assert.equal(find(parseXml(next.text), 'sync-token', DAV)?.text, token);
  }
}));

test('calendar-data honors supported expansion and rejects foreign or unsupported projections', { timeout: 30000 }, () => fixture(async (request) => {
  const report = (data) => request('REPORT', calendar,
    `<C:calendar-multiget ${namespaces}><D:prop><D:getetag/>${data}</D:prop><D:href>${calendar}series.ics</D:href></C:calendar-multiget>`);
  for (const data of [
    '<C:calendar-data><e:expand start="20261030T000000Z" end="20261102T000000Z"/></C:calendar-data>',
    '<C:calendar-data><C:comp name="VCALENDAR"><C:comp name="VEVENT"><C:prop name="SUMMARY"/></C:comp></C:comp></C:calendar-data>',
    '<C:calendar-data content-type="application/calendar+json"/>',
    '<C:calendar-data version="1.0"/>',
  ]) {
    const result = await report(data);
    assert.equal(result.status, 403, `${data}: ${result.text}`);
    assert.doesNotMatch(result.text, /Private fixture body|UID:series/);
  }
  const expanded = await report('<C:calendar-data><C:expand start="20261030T000000Z" end="20261102T000000Z"/></C:calendar-data>');
  assert.equal(expanded.status, 207, expanded.text);
  const content = find(parseXml(expanded.text), 'calendar-data', CAL)?.text || '';
  assert.doesNotMatch(content, /RRULE:/);
  assert.match(content, /RECURRENCE-ID/);
  const invalid = await report('<C:calendar-data><C:expand start="20261102T000000Z" end="20261030T000000Z"/></C:calendar-data>');
  assert.equal(invalid.status, 400, invalid.text);
}));

test('CardDAV uses its direct filter rather than an unrelated filter inside requested property data', { timeout: 30000 }, () => fixture(async (request) => {
  const card = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:contact\r\nFN:Existing Contact\r\nEND:VCARD\r\n';
  assert.equal((await request('PUT', `${book}contact.vcf`, card, 'text/vcard')).status, 201);
  const result = await request('REPORT', book,
    `<A:addressbook-query ${namespaces}><D:prop><A:address-data/><e:payload><e:filter/></e:payload></D:prop><A:filter><A:prop-filter name="FN"><A:text-match>Does Not Exist</A:text-match></A:prop-filter></A:filter></A:addressbook-query>`);
  assert.doesNotMatch(result.text, /Existing Contact|UID:contact/);
  if (!rejected(result)) assert.equal(findAll(parseXml(result.text), 'response', DAV).length, 0);
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';
import { parseXml, find, findAll } from '../lib/xml.mjs';

const DAV = 'DAV:';
const CAL = 'urn:ietf:params:xml:ns:caldav';
const EVIL = 'urn:simplecal:test:foreign';
const collection = '/calendars/probe/default/';
const fixtures = [
  { uid: 'alpha', summary: 'Team Planning', start: '20261030T090000Z', end: '20261030T100000Z',
    extra: ['LOCATION:Studio', 'ATTENDEE;CN="Alice Example":mailto:alice@example.test'] },
  { uid: 'beta', summary: 'Budget Review', start: '20261030T120000Z', end: '20261030T130000Z',
    extra: ['ATTENDEE;CN="Bob Example":mailto:bob@example.test'] },
  { uid: 'gamma', summary: 'team\\, Roadmap', start: '20261102T090000Z', end: '20261102T100000Z',
    extra: ['LOCATION:Remote'] },
];

async function fixture(run) {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-query-contract-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Query-Contract-42!',
      CALDAV_USER: 'probe' }), { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Query-Contract-42!' }) });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf };
    const request = async (method, url, { body, headers = {} } = {}) => {
      const response = await fetch(`${origin}${url}`, { method, body,
        headers: { ...auth, 'Content-Type': 'application/xml', ...headers } });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    for (const event of fixtures) {
      const content = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SimpleCal//Query Contract//EN',
        'BEGIN:VEVENT', `UID:${event.uid}`, 'DTSTAMP:20261030T000000Z', `DTSTART:${event.start}`,
        `DTEND:${event.end}`, `SUMMARY:${event.summary}`, ...event.extra,
        'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
      const created = await request('PUT', `${collection}${event.uid}.ics`,
        { body: content, headers: { 'Content-Type': 'text/calendar' } });
      assert.equal(created.status, 201, created.text);
    }
    await run(request);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(data, { recursive: true, force: true });
  }
}

const query = (conditions = '') => `<C:calendar-query xmlns:C="${CAL}" xmlns:D="${DAV}">`
  + '<D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR">'
  + `<C:comp-filter name="VEVENT">${conditions}</C:comp-filter>`
  + '</C:comp-filter></C:filter></C:calendar-query>';
const property = (name, children = '') => `<C:prop-filter name="${name}">${children}</C:prop-filter>`;
const textMatch = (text, attributes = '') => `<C:text-match ${attributes}>${text}</C:text-match>`;
const members = (body) => findAll(parseXml(body), 'response').map((node) => find(node, 'href')?.text)
  .filter(Boolean).map((href) => new URL(href, 'http://localhost').pathname.split('/').at(-1)).sort();

test('calendar-query evaluates property, text, parameter and component time filters', { timeout: 30000 }, () => fixture(async (request) => {
  const cases = [
    ['SUMMARY ASCII case folding', property('SUMMARY', textMatch('TEAM', 'collation="i;ascii-casemap"')), ['alpha.ics', 'gamma.ics']],
    ['SUMMARY octet comparison', property('SUMMARY', textMatch('Team', 'collation="i;octet"')), ['alpha.ics']],
    ['SUMMARY negation', property('SUMMARY', textMatch('team', 'negate-condition="yes"')), ['beta.ics']],
    ['property present', property('LOCATION'), ['alpha.ics', 'gamma.ics']],
    ['property absent', property('LOCATION', '<C:is-not-defined/>'), ['beta.ics']],
    ['multiple property filters are conjunctive', property('SUMMARY', textMatch('team')) + property('LOCATION', textMatch('Remote')), ['gamma.ics']],
    ['parameter text matching', property('ATTENDEE', '<C:param-filter name="CN">' + textMatch('alice') + '</C:param-filter>'), ['alpha.ics']],
    ['parameter absent', property('ATTENDEE', '<C:param-filter name="ROLE"><C:is-not-defined/></C:param-filter>'), ['alpha.ics', 'beta.ics']],
    ['parameter present', property('ATTENDEE', '<C:param-filter name="CN"/>'), ['alpha.ics', 'beta.ics']],
    ['time range', '<C:time-range start="20261030T083000Z" end="20261030T110000Z"/>', ['alpha.ics']],
    ['time and property are conjunctive', '<C:time-range start="20261030T083000Z" end="20261030T110000Z"/>' + property('SUMMARY', textMatch('Budget')), []],
    ['iCalendar TEXT escape decoding', property('SUMMARY', textMatch('team, Roadmap')), ['gamma.ics']],
  ];
  // Secondary differential assertion: the independent semantic expectations
  // above must also agree with UIDs returned by a real fixed-version server.
  const reference = JSON.parse(await readFile(new URL('../../../docs/research/evidence/radicale-query.results.json', import.meta.url), 'utf8'));
  assert.deepEqual(reference.reference, { name: 'Radicale', version: '3.9.0' });
  assert.deepEqual(reference.fixtures, fixtures, 'reference capture must use the same event data');
  assert.deepEqual(reference.results.map((item) => item.case), cases.map(([label]) => label),
    'every recorded supported-query case must be exercised');
  const referenceCases = new Map(reference.results.map((item) => [item.case, item]));
  for (const [label, condition, expected] of cases) {
    const result = await request('REPORT', collection, { body: query(condition) });
    assert.equal(result.status, 207, `${label}: ${result.text}`);
    assert.deepEqual(members(result.text), expected, label);
    const observed = referenceCases.get(label);
    assert.equal(result.status, observed.status, `${label}: Radicale status`);
    assert.deepEqual(members(result.text), observed.uids.map((uid) => `${uid}.ics`).sort(),
      `${label}: recorded Radicale result`);
  }
}));

test('REPORT and PROPFIND use namespace URIs rather than client prefixes', { timeout: 30000 }, () => fixture(async (request) => {
  const alternate = `<a:calendar-query xmlns:a="${CAL}" xmlns:z="${DAV}">`
    + '<z:prop><z:getetag/></z:prop><a:filter><a:comp-filter name="VCALENDAR">'
    + '<a:comp-filter name="VEVENT"><a:prop-filter name="SUMMARY"><a:text-match>Budget</a:text-match>'
    + '</a:prop-filter></a:comp-filter></a:comp-filter></a:filter></a:calendar-query>';
  const alternateResult = await request('REPORT', collection, { body: alternate });
  assert.equal(alternateResult.status, 207, alternateResult.text);
  assert.deepEqual(members(alternateResult.text), ['beta.ics']);
  const defaultNamespace = `<calendar-query xmlns="${CAL}" xmlns:d="${DAV}">`
    + '<d:prop><d:getetag/></d:prop><filter><comp-filter name="VCALENDAR"><comp-filter name="VEVENT">'
    + '<prop-filter name="SUMMARY"><text-match>Budget</text-match></prop-filter>'
    + '</comp-filter></comp-filter></filter></calendar-query>';
  const defaultResult = await request('REPORT', collection, { body: defaultNamespace });
  assert.equal(defaultResult.status, 207, defaultResult.text);
  assert.deepEqual(members(defaultResult.text), ['beta.ics']);
  const object = `${collection}alpha.ics`;
  for (const [method, body] of [
    ['PROPFIND', `<d:propfind xmlns:d="${DAV}" xmlns:e="${EVIL}"><d:prop><d:getetag/><e:getetag/></d:prop></d:propfind>`],
    ['REPORT', `<c:calendar-multiget xmlns:c="${CAL}" xmlns:d="${DAV}" xmlns:e="${EVIL}"><d:prop><d:getetag/><e:getetag/><e:calendar-data/></d:prop><d:href>${object}</d:href></c:calendar-multiget>`],
  ]) {
    const result = await request(method, method === 'REPORT' ? collection : object,
      { body, headers: { Depth: '0' } });
    assert.equal(result.status, 207, result.text);
    const tree = parseXml(result.text);
    const propstats = findAll(tree, 'propstat');
    const good = propstats.find((node) => find(node, 'status')?.text.includes('200'));
    const missing = propstats.find((node) => find(node, 'status')?.text.includes('404'));
    assert.ok(good, `${method}: real DAV property must resolve`);
    assert.ok(missing, `${method}: foreign property must have a 404 propstat`);
    assert.equal(find(good, 'getetag')?.namespaceURI, DAV);
    const foreignTag = findAll(missing, 'getetag').find((node) => node.namespaceURI === EVIL);
    assert.ok(foreignTag, `${method}: preserve requested namespace in missing property`);
    assert.equal(foreignTag.text, '');
    assert.doesNotMatch(result.text, /BEGIN:VCALENDAR/);
    if (method === 'REPORT') assert.ok(findAll(missing, 'calendar-data').some((node) => node.namespaceURI === EVIL));
  }
}));

test('unsupported REPORT filters and collations fail explicitly', { timeout: 30000 }, () => fixture(async (request) => {
  const cases = [
    ['foreign report root', query().replace('C:calendar-query', 'E:calendar-query').replace('</C:calendar-query>', '</E:calendar-query>').replace('xmlns:C=', `xmlns:E="${EVIL}" xmlns:C=`), 'supported-report'],
    ['foreign filter namespace', query('<E:prop-filter xmlns:E="' + EVIL + '" name="SUMMARY"/>'), 'supported-filter'],
    ['unsupported component time range', query('<C:comp-filter name="VALARM"><C:time-range start="20261030T000000Z" end="20261031T000000Z"/></C:comp-filter>'), 'supported-filter'],
    ['property time range', query(property('DTSTAMP', '<C:time-range start="20261030T000000Z" end="20261031T000000Z"/>')), 'supported-filter'],
    ['unsupported collation', query(property('SUMMARY', textMatch('team', 'collation="i;unicode-casemap"'))), 'supported-collation'],
  ];
  for (const [label, body, error] of cases) {
    const result = await request('REPORT', collection, { body });
    assert.equal(result.status, 403, `${label}: ${result.text}`);
    assert.ok(find(parseXml(result.text), error), `${label}: ${error} error body expected`);
    assert.doesNotMatch(result.text, /BEGIN:VCALENDAR/);
  }
}));

test('malformed request XML and invalid filter values return 400', { timeout: 30000 }, () => fixture(async (request) => {
  const malformed = [
    `<C:calendar-query xmlns:C="${CAL}"><C:filter></C:calendar-query>`,
    `<C:calendar-query xmlns:C="${CAL}"/><C:calendar-query xmlns:C="${CAL}"/>`,
    `<C:calendar-query xmlns:C="${CAL}"><C:filter>&unrecognized;</C:filter></C:calendar-query>`,
    '<C:calendar-query/>',
    `<!DOCTYPE calendar-query [<!ENTITY probe "expanded">]><calendar-query xmlns="${CAL}"/>`,
  ];
  for (const body of malformed) {
    const result = await request('REPORT', collection, { body });
    assert.equal(result.status, 400, body);
  }
  for (const condition of [
    '<C:time-range start="20261030T120000Z" end="20261030T090000Z"/>',
    '<C:time-range start="20260230T090000Z" end="20261030T100000Z"/>',
    property('SUMMARY', textMatch('team', 'negate-condition="perhaps"')),
  ]) {
    const result = await request('REPORT', collection, { body: query(condition) });
    assert.equal(result.status, 400, condition);
  }
  const propfind = await request('PROPFIND', collection, {
    body: `<D:propfind xmlns:D="${DAV}"><D:prop><D:getetag/></D:propfind>`, headers: { Depth: '0' } });
  assert.equal(propfind.status, 400);
}));

test('CardDAV rejects foreign report roots and preserves foreign requested properties', { timeout: 30000 }, () => fixture(async (request) => {
  const book = '/addressbooks/probe/contacts/';
  const object = `${book}alice.vcf`;
  const created = await request('PUT', object, { headers: { 'Content-Type': 'text/vcard' },
    body: 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:alice\r\nFN:Alice Example\r\nEND:VCARD\r\n' });
  assert.equal(created.status, 201, created.text);
  const foreign = await request('REPORT', book, { body:
    `<E:addressbook-query xmlns:E="${EVIL}" xmlns:D="${DAV}"><D:prop><D:getetag/></D:prop></E:addressbook-query>` });
  assert.equal(foreign.status, 403, foreign.text);
  assert.ok(find(parseXml(foreign.text), 'supported-report'));
  const propfind = await request('PROPFIND', object, { headers: { Depth: '0' }, body:
    `<D:propfind xmlns:D="${DAV}" xmlns:E="${EVIL}"><D:prop><D:getetag/><E:getetag/></D:prop></D:propfind>` });
  assert.equal(propfind.status, 207, propfind.text);
  const propstats = findAll(parseXml(propfind.text), 'propstat');
  const missing = propstats.find((node) => find(node, 'status')?.text.includes('404'));
  assert.ok(missing);
  assert.ok(findAll(missing, 'getetag').some((node) => node.namespaceURI === EVIL && node.text === ''));
  const malformed = await request('REPORT', book, {
    body: '<A:addressbook-query xmlns:A="urn:ietf:params:xml:ns:carddav"><A:filter></A:addressbook-query>' });
  assert.equal(malformed.status, 400);
}));

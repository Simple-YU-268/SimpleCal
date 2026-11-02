import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';
import { assertCalendarObject, preserveUnmodeledProperties } from '../lib/event-constraints.mjs';

const raw = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Domain test//EN\r\nBEGIN:VEVENT\r\nUID:opaque\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Original\r\nX-OPAQUE;VENDOR="one":first\r\n second\r\nX-OPAQUE:another\r\nATTENDEE;CN="One":mailto:one@example.test\r\nORGANIZER:mailto:organizer@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('raw calendar domain validation rejects malformed framing, mixed identity and oversized objects', () => {
  assert.equal(assertCalendarObject(raw, { type: 'vevent' }).uid, 'opaque');
  for (const input of [raw.replace('END:VEVENT', 'END:VTODO'),
    raw + raw, raw.replace('UID:opaque\r\n', ''), raw.replace('UID:opaque', 'UID:opaque\r\nUID:second'),
    raw.replace('END:VCALENDAR', 'BEGIN:VTODO\r\nUID:another\r\nEND:VTODO\r\nEND:VCALENDAR')]) {
    assert.throws(() => assertCalendarObject(input), (err) => err.status === 403);
  }
  assert.throws(() => assertCalendarObject(raw, { maxObjectBytes: 10 }), (err) => err.status === 413);
  assert.throws(() => assertCalendarObject(raw, { type: 'vtodo' }), (err) => err.code === 'component_not_supported');
  assert.throws(() => preserveUnmodeledProperties(raw.replace('END:VEVENT', 'BEGIN:X-VENDOR\r\nX-PROP:opaque\r\nEND:X-VENDOR\r\nEND:VEVENT'), raw),
    (err) => err.status === 409 && err.code === 'unsupported_ical_edit');
});

test('JSON edits preserve opaque ICS properties and race safely with DAV writes', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-domain-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Domain-42-Pass!', CALDAV_USER: 'probe' }),
      { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Domain-42-Pass!' }) });
    assert.equal(login.status, 200);
    const auth = { Cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'X-CSRF-Token': (await login.json()).csrf };
    const request = async (method, url, body, headers = {}) => {
      const response = await fetch(origin + url, { method, body, headers: { ...auth, ...headers } });
      return { status: response.status, text: await response.text(), headers: response.headers };
    };
    const object = '/calendars/probe/default/opaque.ics';
    const event = '/api/v1/calendars/default/events/opaque';
    assert.equal((await request('PUT', object, raw, { 'Content-Type': 'text/calendar' })).status, 201);
    const before = await request('GET', object);
    const patched = await request('PATCH', event, JSON.stringify({ title: 'JSON edited' }),
      { 'Content-Type': 'application/json', 'If-Match': before.headers.get('etag') });
    assert.equal(patched.status, 200, patched.text);
    const edited = await request('GET', object);
    assert.match(edited.text, /SUMMARY:JSON edited/);
    for (const property of ['X-OPAQUE;VENDOR="one":first\r\n second', 'X-OPAQUE:another',
      'ATTENDEE;CN="One":mailto:one@example.test', 'ORGANIZER:mailto:organizer@example.test']) assert.ok(edited.text.includes(property), property);
    const tag = edited.headers.get('etag');
    const racers = await Promise.all([
      request('PATCH', event, JSON.stringify({ title: 'JSON racer' }), { 'Content-Type': 'application/json', 'If-Match': tag }),
      request('PUT', object, edited.text.replace('SUMMARY:JSON edited', 'SUMMARY:DAV racer'), { 'Content-Type': 'text/calendar', 'If-Match': tag }),
      request('PUT', '/api/v1/kv/cal:default:evt:opaque', JSON.stringify({ title: 'KV racer', start: Date.UTC(2026, 9, 30, 9), end: Date.UTC(2026, 9, 30, 10) }),
        { 'Content-Type': 'application/json', 'If-Match': tag }),
    ]);
    assert.equal(racers.filter((r) => r.status >= 200 && r.status < 300).length, 1);
    assert.equal(racers.filter((r) => r.status === 412).length, 2);
    const current = await request('GET', object);
    const deletes = await Promise.all([request('DELETE', '/api/v1/kv/cal:default:evt:opaque', undefined, { 'If-Match': current.headers.get('etag') }),
      request('DELETE', event, undefined, { 'If-Match': current.headers.get('etag') })]);
    assert.equal(deletes.filter((r) => r.status >= 200 && r.status < 300).length, 1);
    assert.equal(deletes.filter((r) => [404, 412].includes(r.status)).length, 1);
  } finally {
    if (app) { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); }
    await rm(data, { recursive: true, force: true });
  }
});

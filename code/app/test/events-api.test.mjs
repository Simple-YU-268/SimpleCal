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

test('user event API interoperates with KV and DAV and serializes conditional writes', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fncal-events-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: dir, CALDAV_ADMIN_PASSWORD: 'Events-Pass-123!',
      CALDAV_USER: 'alice', CALDAV_HOST: '127.0.0.1', CALDAV_PORT: '0' }),
    { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function request(url, { method = 'GET', session, body, headers = {}, csrf = true, raw } = {}) {
      const response = await fetch(`${base}${url}`, { method,
        headers: { ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { /* ICS */ }
      return { status: response.status, json, text, headers: response.headers };
    }
    async function login(username) {
      const r = await request('/api/v1/auth/login', { method: 'POST', body: { username, password: 'Events-Pass-123!' } });
      assert.equal(r.status, 200);
      return { cookie: r.headers.getSetCookie().map((v) => v.split(';')[0]).join('; '), csrf: r.json.csrf };
    }
    const alice = await login('alice');
    assert.equal((await request('/api/v1/admin/users', { method: 'POST', session: alice,
      body: { username: 'bob', password: 'Events-Pass-123!' } })).status, 201);
    const bob = await login('bob');
    const collection = '/api/v1/calendars/default/events';
    const event = { title: 'REST event', start: Date.UTC(2026, 9, 30, 9), end: Date.UTC(2026, 9, 30, 10),
      timezone: 'Asia/Shanghai', recurrence: { freq: 'DAILY', count: 3 }, reminders: [15] };
    assert.equal((await request(collection)).status, 401);
    assert.equal((await request(collection, { headers: { Authorization: 'Bearer simplecal_ai_fake' } })).status, 401);
    assert.equal((await request(collection, { method: 'POST', session: alice, csrf: false, body: event })).status, 403);
    const basic = { Authorization: `Basic ${Buffer.from('alice:Events-Pass-123!').toString('base64')}` };
    assert.equal((await request(collection, { method: 'POST', body: event, headers: basic })).status, 401);
    assert.equal((await request(collection, { headers: basic })).status, 200);
    for (const body of [{ ...event, title: '' }, { ...event, start: '2026-10-30' },
      { ...event, end: event.start - 1 }, { ...event, createdBy: { uid: 'spoof' } }, { ...event, allDay: 'true' }]) {
      assert.equal((await request(collection, { method: 'POST', session: alice, body })).status, 400);
    }
    assert.equal((await request(collection, { method: 'POST', session: alice, raw: '{broken',
      headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await request(collection, { method: 'POST', session: alice, raw: 'x',
      headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request(collection, { method: 'POST', session: alice, raw: 'x'.repeat(1024 * 1024 + 1),
      headers: { 'Content-Type': 'application/json' } })).status, 413);
    assert.equal((await request('/api/v1/calendars/missing/events', { session: alice })).status, 404);
    assert.equal((await request('/api/v1/calendars/tasks/events', { session: alice })).status, 409);

    const created = await request(collection, { method: 'POST', session: alice, body: event });
    assert.equal(created.status, 201, created.text);
    const location = created.headers.get('location');
    const id = created.json.event.id;
    const uid = created.json.event.uid;
    let etag = created.headers.get('etag');
    assert.equal(created.json.event.createdBy.username, 'alice');
    assert.equal((await request(location, { session: alice })).json.event.title, event.title);
    assert.equal((await request(collection, { session: alice })).json.items.length, 1);
    assert.equal((await request(collection, { session: bob })).json.items.length, 0);
    assert.equal((await request(location, { session: bob })).status, 404);
    assert.equal((await request(location, { method: 'DELETE', session: bob, headers: { 'If-Match': etag } })).status, 404);
    assert.equal((await request(location, { method: 'PATCH', session: alice, body: { title: 'missing condition' } })).status, 428);
    assert.equal((await request(location, { method: 'PATCH', session: alice, body: { title: 'stale' }, headers: { 'If-Match': '"bad"' } })).status, 412);
    assert.equal((await request(location, { method: 'PUT', session: alice, body: event })).status, 405);
    assert.equal((await request(`${collection}?from=0`, { session: alice })).status, 400);

    const concurrent = await Promise.all(['Winner A', 'Winner B'].map((title) => request(location,
      { method: 'PATCH', session: alice, body: { title }, headers: { 'If-Match': etag } })));
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 412]);
    const winner = concurrent.find((r) => r.status === 200);
    etag = winner.headers.get('etag');
    assert.equal(winner.json.event.uid, uid);
    assert.equal(winner.json.event.timezone, 'Asia/Shanghai');
    assert.equal(winner.json.event.reminders[0], 15);

    const kv = `/api/v1/kv/cal:default:evt:${id}`;
    const kvRead = await request(kv, { session: alice });
    assert.equal(kvRead.json.value.title, winner.json.event.title);
    const dav = `/calendars/alice/default/${id}.ics`;
    const davRead = await request(dav, { headers: basic });
    assert.equal(davRead.status, 200);
    assert.equal(davRead.headers.get('etag'), etag);
    assert.match(davRead.text, /RRULE:.*COUNT=3/);
    assert.match(davRead.text, /BEGIN:VALARM/);
    assert.equal((await request(dav, { method: 'PUT', headers: { ...basic, 'Content-Type': 'text/calendar' },
      raw: davRead.text.replace(winner.json.event.title, 'DAV updated') })).status, 204);
    assert.equal((await request(location, { method: 'PATCH', session: alice, body: { title: 'stale after DAV' },
      headers: { 'If-Match': etag } })).status, 412);
    const reread = await request(location, { session: alice });
    assert.equal(reread.json.event.title, 'DAV updated');
    const edited = await request(location, { method: 'PATCH', session: alice,
      headers: { 'If-Match': reread.headers.get('etag') }, body: { recurrence: null, reminders: [5] } });
    assert.equal(edited.status, 200, edited.text);
    const editedIcs = await request(dav, { headers: basic });
    assert.doesNotMatch(editedIcs.text, /RRULE:/);
    assert.match(editedIcs.text, /TRIGGER:-PT5M/);
    assert.equal((await request(kv, { method: 'PUT', session: alice,
      body: { ...edited.json.event, title: 'KV updated' } })).status, 200);
    const afterKv = await request(location, { session: alice });
    assert.equal(afterKv.json.event.title, 'KV updated');
    assert.equal((await request(location, { method: 'DELETE', session: alice })).status, 428);
    assert.equal((await request(location, { method: 'DELETE', session: alice,
      headers: { 'If-Match': afterKv.headers.get('etag') } })).status, 200);
    assert.equal((await request(dav, { headers: basic })).status, 404);
    const allDay = await request(collection, { method: 'POST', session: alice,
      body: { title: 'One day', start: event.start, end: event.start, allDay: true } });
    assert.equal(allDay.status, 201, allDay.text);
  } finally {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

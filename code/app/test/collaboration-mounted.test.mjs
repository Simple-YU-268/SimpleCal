import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp, resolveConfig } from '../server.mjs';

test('mounted collaboration authenticates accounts, applies DAV delegation and revokes immediately', { timeout: 60000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'simplecal-collaboration-mounted-'));
  let app;
  try {
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Owner-Collab-42!', CALDAV_USER: 'owner' }),
      { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = async (username, password) => {
      const r = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(r.status, 200);
      return { Cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'X-CSRF-Token': (await r.json()).csrf };
    };
    const request = async (auth, method, url, body, headers = {}) => {
      const r = await fetch(origin + url, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        headers: { ...auth, 'Content-Type': 'application/json', ...headers } });
      const text = await r.text();
      return { status: r.status, headers: r.headers, text, json: r.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
    };
    const owner = await login('owner', 'Owner-Collab-42!');
    const accounts = {};
    for (const username of ['reader', 'writer']) {
      const created = await request(owner, 'POST', '/api/v1/admin/users', { username, displayName: username, password: 'Guest-Collab-42!', role: 'user' });
      assert.equal(created.status, 201, created.text);
      accounts[username] = { id: created.json.user.id, auth: await login(username, 'Guest-Collab-42!') };
    }
    const reader = accounts.reader.auth, writer = accounts.writer.auth;
    const collection = '/calendars/owner/default/';
    const object = `${collection}sample.ics`;
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sample\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261101T090000Z\r\nDTEND:20261101T100000Z\r\nSUMMARY:Shared fixture\r\nX-CUSTOM:preserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const calendarHeaders = { 'Content-Type': 'text/calendar' };
    assert.equal((await request(owner, 'PUT', object, ics, calendarHeaders)).status, 201);
    assert.equal((await request(owner, 'MKCALENDAR', '/calendars/owner/private/')).status, 201);
    const grants = '/api/v1/calendars/default/grants';
    const configured = [{ userId: accounts.reader.id, perm: 'read' }, { userId: accounts.writer.id, perm: 'write' }];
    assert.equal((await request(owner, 'PUT', grants, { grants: configured })).status, 200);
    assert.deepEqual((await request(owner, 'GET', grants)).json.grants, configured);
    assert.deepEqual((await request(reader, 'GET', grants)).json.grants, [], 'reader manages only their own same-named collection');
    const shared = await request(reader, 'GET', object);
    assert.equal(shared.status, 200, shared.text);
    assert.match(shared.text, /Shared fixture/);
    const privileges = await request(reader, 'PROPFIND', collection,
      '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-privilege-set/></D:prop></D:propfind>', { 'Content-Type': 'application/xml', Depth: '0' });
    assert.equal(privileges.status, 207);
    assert.doesNotMatch(privileges.text, /<D:write(?:\s|\/|>)/, 'read-only delegate must not be advertised write privileges');
    assert.equal((await request(reader, 'PUT', object, ics, calendarHeaders)).status, 403);
    assert.equal((await request(reader, 'DELETE', object)).status, 403);
    assert.equal((await request(reader, 'PROPPATCH', collection,
      '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>Hijack</D:displayname></D:prop></D:set></D:propertyupdate>', { 'Content-Type': 'application/xml' })).status, 403);
    const etag = shared.headers.get('etag');
    const edited = await request(writer, 'PUT', object, ics.replace('Shared fixture', 'Writer edit'), { ...calendarHeaders, 'If-Match': etag });
    assert.equal(edited.status, 204, edited.text);
    assert.equal((await request(writer, 'PUT', object, ics, { ...calendarHeaders, 'If-Match': etag })).status, 412);
    assert.equal((await request(writer, 'GET', '/calendars/owner/private/')).status, 403);
    assert.equal((await request(writer, 'GET', '/calendars/owner/')).status, 403);
    const move = await request(writer, 'MOVE', object, undefined,
      { Destination: `${origin}/calendars/owner/private/moved.ics`, 'If-Match': edited.headers.get('etag') });
    assert.ok([403, 404].includes(move.status), move.text);
    assert.equal((await request(owner, 'GET', object)).status, 200);
    assert.equal((await request(owner, 'PUT', grants, { grants: [] })).status, 200);
    assert.equal((await request(reader, 'GET', object)).status, 403);
    assert.equal((await request(writer, 'PUT', object, ics, calendarHeaders)).status, 403);
    const scheduling = '/api/v1/scheduling';
    const invitation = ics.replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST')
      .replace('UID:sample', 'UID:local-invitation').replace('SUMMARY:Shared fixture',
        'SUMMARY:Local invitation\r\nORGANIZER:mailto:owner@simplecal.local\r\nATTENDEE:mailto:reader@simplecal.local');
    assert.equal((await request(reader, 'POST', scheduling, { content: invitation })).status, 403);
    assert.equal((await request(owner, 'POST', scheduling, { content: invitation }, { 'X-CSRF-Token': '' })).status, 403);
    const queued = await request(owner, 'POST', scheduling, { content: invitation });
    assert.equal(queued.status, 201, queued.text);
    const delivered = await request(owner, 'POST', `${scheduling}/outbox/${queued.json.ids[0]}/deliver`);
    assert.equal(delivered.status, 200, delivered.text);
    assert.equal(delivered.json.message.status, 'delivered', delivered.text);
    const inbox = await request(reader, 'GET', scheduling);
    assert.equal(inbox.json.identity, 'reader@simplecal.local');
    assert.equal(inbox.json.invitations[0].uid, 'local-invitation');
    assert.equal((await request(writer, 'GET', scheduling)).json.invitations.length, 0);
  } finally {
    if (app) { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); }
    await rm(data, { recursive: true, force: true });
  }
});

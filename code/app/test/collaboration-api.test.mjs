import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { currentContext } from '../lib/request-context.mjs';
import { createCollaborationApi } from '../api/collaboration.mjs';

const users = [{ id: 'owner-id', username: 'owner' }, { id: 'guest-id', username: 'guest' },
  { id: 'other-id', username: 'other' }, { id: 'disabled-id', username: 'disabled', disabled: true }];
const content = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:api-meeting\r\nDTSTAMP:20261030T090000Z\r\nDTSTART:20261101T090000Z\r\nORGANIZER:mailto:owner@simplecal.local\r\nATTENDEE:mailto:guest@simplecal.local\r\nSUMMARY:Local meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

async function fixture(run) {
  const data = new Map(), calendars = new Map([['owner-id/default', { id: 'default', shares: [] }]]);
  const key = (name) => `${currentContext()?.userId}/${name}`;
  const store = {
    readUserData: async (name) => structuredClone(data.get(key(name)) || null),
    writeUserData: async (name, value) => data.set(key(name), structuredClone(value)),
    calendarExists: async (id) => calendars.has(key(id)),
    readCalendarMeta: async (id) => structuredClone(calendars.get(key(id))),
    updateCalendarMeta: async (id, patch) => calendars.set(key(id), { ...calendars.get(key(id)), ...patch }),
  };
  const auth = {
    authenticate: async (req) => ({ ok: Boolean(req.headers['x-test-user']),
      account: users.find((u) => u.username === req.headers['x-test-user']), via: req.headers['x-test-basic'] ? 'basic' : 'session' }),
    validateCsrf: (req) => req.headers['x-csrf-token'] === 'valid',
  };
  const api = createCollaborationApi({ store, auth, accounts: { all: async () => users } });
  const server = createServer((req, res) => { if (!api.owns(new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); return; } api.handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = async (method, path, user, body, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { ...(user ? { 'x-test-user': user } : {}), 'x-csrf-token': 'valid', 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await run(request); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('scheduling HTTP API derives identities and delivers only to enabled local recipients', () => fixture(async (request) => {
  const base = '/api/v1/scheduling';
  assert.equal((await request('GET', base)).status, 401);
  assert.equal((await request('POST', base, 'owner', { content }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await request('POST', base, 'guest', { content })).status, 403);
  assert.equal((await request('POST', base, 'owner', { content, actor: { userId: 'guest-id' } })).status, 400);
  const sent = await request('POST', base, 'owner', { content });
  assert.equal(sent.status, 201);
  const id = sent.body.ids[0];
  assert.equal((await request('POST', `${base}/outbox/${id}/deliver`, 'other')).status, 404);
  assert.equal((await request('POST', `${base}/outbox/${id}/deliver`, 'owner')).body.message.status, 'delivered');
  const received = await request('GET', base, 'guest');
  assert.equal(received.body.identity, 'guest@simplecal.local');
  assert.equal(received.body.invitations[0].uid, 'api-meeting');
  assert.equal((await request('GET', base, 'other')).body.invitations.length, 0);
  const external = await request('POST', base, 'owner', { content: content.replace('UID:api-meeting', 'UID:external').replace('guest@simplecal.local', 'external@example.test') });
  const outcome = await request('POST', `${base}/outbox/${external.body.ids[0]}/deliver`, 'owner');
  assert.equal(outcome.body.message.status, 'retry');
  assert.equal(outcome.body.message.lastError, 'local_delivery_failed');
  assert.equal((await request('DELETE', `${base}/outbox/${id}`, 'owner')).body.removed, 1);
}));

test('calendar grants are owner-only, bounded and resolved against enabled account IDs', () => fixture(async (request) => {
  const url = '/api/v1/calendars/default/grants';
  assert.equal((await request('GET', url, 'guest')).status, 404);
  assert.equal((await request('PUT', url, 'owner', { grants: [{ userId: 'guest-id', perm: 'write' }] }, { 'x-csrf-token': '' })).status, 403);
  for (const grants of [[{ userId: 'missing', perm: 'read' }], [{ userId: 'disabled-id', perm: 'read' }],
    [{ userId: 'owner-id', perm: 'read' }], [{ userId: 'guest-id', perm: 'admin' }],
    [{ userId: 'guest-id', perm: 'read' }, { userId: 'guest-id', perm: 'write' }]]) {
    assert.equal((await request('PUT', url, 'owner', { grants })).status, 400);
  }
  const grants = [{ userId: 'guest-id', perm: 'read' }];
  assert.equal((await request('PUT', url, 'owner', { grants }, { 'x-test-basic': 'yes', 'x-csrf-token': '' })).status, 200);
  assert.deepEqual((await request('GET', url, 'owner')).body.grants, grants);
  assert.equal((await request('PUT', url, 'owner', { grants: [] })).status, 200);
  assert.deepEqual((await request('GET', url, 'owner')).body.grants, []);
}));

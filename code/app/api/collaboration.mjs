// Explicit local scheduling and owner-managed calendar grants. Addresses and
// actors come only from authenticated/server account data, never request JSON.
import { runWithContext } from '../lib/request-context.mjs';
import { createCalendarScheduling } from '../lib/calendar-scheduling.mjs';

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const BASE = '/api/v1/scheduling';
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const normalize = (value) => String(value || '').replace(/^mailto:/i, '').toLowerCase();
function actor(account) {
  const email = typeof account.email === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(account.email)
    ? account.email : `${account.username}@simplecal.local`;
  return { userId: account.id, addresses: [normalize(email)] };
}
function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(payload);
}
async function bodyOf(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'unsupported_media_type', 'application/json required');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks.push(chunk); }
  if (bytes > 2 * 1024 * 1024) throw fail(413, 'body_too_large', 'Request body exceeds limit');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return body;
  } catch { throw fail(400, 'invalid_json', 'JSON object required'); }
}

export function createCollaborationApi({ store, auth, accounts, now = Date.now }) {
  const withUser = (id, task) => runWithContext({ userId: id }, task);
  const scheduling = createCalendarScheduling({ now,
    readState: (id) => withUser(id, () => store.readUserData('scheduling')),
    writeState: (id, state) => withUser(id, () => store.writeUserData('scheduling', state)) });
  const grantMatch = (pathname) => /^\/api\/v1\/calendars\/([^/]+)\/grants\/?$/.exec(pathname);
  const owns = (pathname) => pathname === BASE || pathname.startsWith(`${BASE}/`) || Boolean(grantMatch(pathname));
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!owns(url.pathname)) return false;
    try {
      if (url.search) throw fail(400, 'unsupported_query', 'Query parameters are not supported');
      const identity = await auth.authenticate(req, { allowMfaPending: true });
      if (!identity.ok || !identity.account || identity.account.disabled) throw fail(401, 'unauthorized', 'Authentication required');
      const account = identity.account;
      if (account.mustChangePassword || identity.mfaPending) throw fail(403,
        account.mustChangePassword ? 'password_change_required' : 'mfa_required', 'Complete account security setup first');
      if (identity.via === 'session' && req.method !== 'GET' && !auth.validateCsrf(req, account)) throw fail(403, 'csrf', 'CSRF validation failed');
      if (identity.refreshCookie) res.setHeader('Set-Cookie', identity.refreshCookie);
      const current = actor(account);
      const grants = grantMatch(url.pathname);
      if (grants) {
        if (!['GET', 'PUT'].includes(req.method)) return send(res, 405, { ok: false, code: 'method_not_allowed' }, { Allow: 'GET, PUT' });
        let id; try { id = decodeURIComponent(grants[1]); } catch { throw fail(400, 'invalid_id', 'Invalid calendar ID'); }
        if (!ID.test(id)) throw fail(400, 'invalid_id', 'Invalid calendar ID');
        const result = await withUser(account.id, async () => {
          if (!(await store.calendarExists(id))) throw fail(404, 'calendar_not_found', 'Owned calendar not found');
          if (req.method === 'GET') {
            const meta = await store.readCalendarMeta(id);
            return (meta.shares || []).map((entry) => ({ userId: entry.uid, perm: entry.perm }));
          }
          const body = await bodyOf(req);
          if (Object.keys(body).some((key) => key !== 'grants') || !Array.isArray(body.grants) || body.grants.length > 100) throw fail(400, 'invalid_grants', 'At most 100 grants required');
          const all = await accounts.all();
          const ids = new Set();
          for (const entry of body.grants) {
            if (!entry || Object.keys(entry).some((key) => !['userId', 'perm'].includes(key)) || !ID.test(entry.userId || '')
              || !['read', 'write'].includes(entry.perm) || entry.userId === account.id || ids.has(entry.userId)) throw fail(400, 'invalid_grants', 'Invalid or duplicate grant');
            if (!all.some((a) => a.id === entry.userId && !a.disabled)) throw fail(400, 'invalid_grantee', 'Grant recipient is unavailable');
            ids.add(entry.userId);
          }
          await store.updateCalendarMeta(id, { shares: body.grants.map((entry) => ({ uid: entry.userId, perm: entry.perm })) });
          return body.grants;
        });
        send(res, 200, { ok: true, grants: result }); return true;
      }
      const suffix = url.pathname.slice(BASE.length).replace(/\/$/, '');
      if (!suffix && req.method === 'GET') { send(res, 200, { ok: true, identity: current.addresses[0], ...await scheduling.list(current) }); return true; }
      if (!suffix && req.method === 'POST') {
        const body = await bodyOf(req);
        if (Object.keys(body).some((key) => key !== 'content') || typeof body.content !== 'string') throw fail(400, 'invalid_message', 'Only scheduling content is accepted');
        send(res, 201, { ok: true, ...await scheduling.submit(current, body) }); return true;
      }
      const message = /^\/outbox\/([a-f0-9]{64})(\/deliver)?$/.exec(suffix);
      if (message && message[2] && req.method === 'POST') {
        const result = await scheduling.attempt(current, message[1], async (item) => {
          const all = await accounts.all();
          const matches = all.filter((a) => !a.disabled && !a.mustChangePassword && actor(a).addresses.includes(normalize(item.recipient)));
          if (matches.length !== 1) throw new Error('local_recipient_unavailable');
          const freshSender = all.find((a) => a.id === account.id && !a.disabled);
          if (!freshSender) throw new Error('local_sender_unavailable');
          await scheduling.receive(actor(matches[0]), { sender: actor(freshSender), content: item.content });
        });
        send(res, 200, { ok: true, message: result }); return true;
      }
      if (message && !message[2] && req.method === 'DELETE') {
        send(res, 200, { ok: true, ...await scheduling.purge(current, [message[1]]) }); return true;
      }
      if (!suffix || message) return send(res, 405, { ok: false, code: 'method_not_allowed' });
      throw fail(404, 'not_found', 'Route not found');
    } catch (error) {
      send(res, error.status || 500, { ok: false, code: error.status ? error.code : 'internal',
        message: error.status ? error.message : 'Internal error' });
      return true;
    }
  }
  return { owns, handle };
}

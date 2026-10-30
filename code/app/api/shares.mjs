// Read-only capability links are separate from ordinary sessions and AI grants.
// No source calendars or credentials are copied into this share registry.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runWithContext } from '../lib/request-context.mjs';
import { mergeCalendars } from '../lib/calendar-export.mjs';
import { busyIntervals } from '../lib/ical.mjs';
import { publicHref } from '../lib/public-url.mjs';

const PREFIX = '/api/v1/shares';
const TOKEN = /^(?:simplecal|fncal)_share_[a-f0-9]{64}$/;
const ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const DAY = 86400000;
const NOT_FOUND = { ok: false, code: 'not_found' };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const invalid = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid' });

function send(req, res, status, content, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 65536) chunks.push(chunk);
  }
  if (size > 65536) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('请求体须为 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('需要 JSON 对象');
  return body;
}

function publicShare(share) {
  return { id: share.id, calendarId: share.calendarId, mode: share.mode,
    createdAt: share.createdAt, expiresAt: share.expiresAt, enabled: share.enabled !== false };
}

function mergeBusy(intervals) {
  const output = [];
  for (const pair of intervals.sort((a, b) => a[0] - b[0])) {
    const last = output.at(-1);
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
    else output.push([...pair]);
  }
  return output;
}

export function createSharesApi({ store, auth, accounts, config = {}, logger = null, now = Date.now }) {
  if (!store || !auth || !accounts) throw new Error('createSharesApi requires store, auth and accounts');
  const queues = new Map();
  const withUser = (userId, task) => runWithContext({ userId }, task);
  function enqueue(userId, task) {
    const previous = queues.get(userId) || Promise.resolve();
    const result = previous.then(() => withUser(userId, task), () => withUser(userId, task));
    const settled = result.catch(() => {});
    queues.set(userId, settled);
    settled.finally(() => { if (queues.get(userId) === settled) queues.delete(userId); });
    return result;
  }
  async function readShares() {
    const data = await store.readUserData('shares');
    if (data === null) return [];
    if (data?.version !== 1 || !Array.isArray(data.shares)) throw new Error('invalid share registry');
    return data.shares.filter((share) => share && ID.test(share.id) && ID.test(share.calendarId)
      && /^[a-f0-9]{64}$/.test(share.tokenHash) && ['calendar', 'freebusy'].includes(share.mode)
      && Number.isFinite(Date.parse(share.expiresAt)));
  }
  async function writeShares(shares) { return store.writeUserData('shares', { version: 1, shares }); }
  function log(event, detail) { if (logger?.event) logger.event(event, detail); }

  async function identity(req, res) {
    const found = await auth.authenticate(req, { allowMfaPending: true });
    if (!found.ok || !found.account || found.account.disabled) {
      send(req, res, 401, { ok: false, code: 'unauthorized' }); return null;
    }
    if (found.via !== 'session') {
      send(req, res, 403, { ok: false, code: 'session_required' }); return null;
    }
    if (found.account.mustChangePassword || found.mfaPending) {
      send(req, res, 403, { ok: false, code: found.account.mustChangePassword ? 'password_change_required' : 'mfa_required' });
      return null;
    }
    if (req.method !== 'GET' && !auth.validateCsrf(req, found.account)) {
      send(req, res, 403, { ok: false, code: 'csrf' }); return null;
    }
    return found.account;
  }

  async function manage(req, res, url) {
    const owner = await identity(req, res);
    if (!owner) return;
    const suffix = url.pathname.slice(PREFIX.length).replace(/\/+$/, '');
    const collection = suffix === '';
    const id = collection ? null : suffix.slice(1);
    if (!collection && (!suffix.startsWith('/') || !ID.test(id))) return send(req, res, 404, NOT_FOUND);
    const methods = collection ? ['GET', 'POST'] : ['DELETE'];
    if (!methods.includes(req.method)) return send(req, res, 405, { ok: false, code: 'method_not_allowed' },
      undefined, { Allow: methods.join(', ') });
    if (req.method === 'GET') {
      const shares = await enqueue(owner.id, readShares);
      return send(req, res, 200, { ok: true, shares: shares.map(publicShare) });
    }
    if (req.method === 'DELETE') {
      const deleted = await enqueue(owner.id, async () => {
        const shares = await readShares();
        const filtered = shares.filter((share) => share.id !== id);
        if (filtered.length === shares.length) return false;
        await writeShares(filtered);
        return true;
      });
      if (deleted) log('share-revoked', { userId: owner.id, shareId: id });
      return send(req, res, deleted ? 200 : 404, deleted ? { ok: true } : NOT_FOUND);
    }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(req, res, 415, { ok: false, code: 'unsupported_media_type' });
    }
    const body = await readBody(req);
    if (Object.keys(body).some((key) => !['calendarId', 'mode', 'expiresAt'].includes(key))) throw invalid('不支持的共享字段');
    if (typeof body.calendarId !== 'string' || !ID.test(body.calendarId)) throw invalid('calendarId 无效');
    const mode = body.mode === undefined ? 'freebusy' : body.mode;
    if (!['calendar', 'freebusy'].includes(mode)) throw invalid('mode 须为 calendar 或 freebusy');
    const createdAt = now();
    const expiry = body.expiresAt === undefined ? createdAt + 7 * DAY
      : (typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN);
    if (!Number.isFinite(expiry) || expiry <= createdAt || expiry > createdAt + 366 * DAY) throw invalid('有效期须在未来 366 天内');
    const token = `simplecal_share_${randomBytes(32).toString('hex')}`;
    const share = { id: randomUUID(), calendarId: body.calendarId, mode, tokenHash: digest(token),
      enabled: true, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiry).toISOString() };
    await enqueue(owner.id, async () => {
      if (!(await store.calendarExists(body.calendarId))) throw Object.assign(invalid('日历不存在'), { status: 404, code: 'calendar_not_found' });
      const metadata = await store.readCalendarMeta(body.calendarId);
      if (metadata.davAccess === 'hidden') throw Object.assign(invalid('日历不可共享'), { status: 403, code: 'forbidden' });
      if (mode === 'freebusy' && metadata.type === 'vtodo') throw Object.assign(invalid('任务日历不支持忙闲共享'), { status: 409, code: 'calendar_type_mismatch' });
      const shares = await readShares();
      if (shares.length >= 100) throw Object.assign(invalid('共享链接数量达到上限'), { status: 409, code: 'share_limit' });
      await writeShares([...shares, share]);
    });
    log('share-created', { userId: owner.id, shareId: share.id, mode });
    return send(req, res, 201, { ok: true, share: publicShare(share), token, url: publicHref(config, `/share/${token}`) });
  }

  async function shared(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) return send(req, res, 404, NOT_FOUND);
    const token = url.pathname.slice('/share/'.length);
    if (!TOKEN.test(token)) return send(req, res, 404, NOT_FOUND);
    const tokenHash = digest(token);
    const currentTime = now();
    for (const account of await accounts.all()) {
      if (account.disabled || account.mustChangePassword) continue;
      const result = await enqueue(account.id, async () => {
        const share = (await readShares()).find((entry) => entry.tokenHash === tokenHash
          && entry.enabled !== false && Date.parse(entry.expiresAt) > currentTime);
        if (!share || !(await store.calendarExists(share.calendarId))) return null;
        const metadata = await store.readCalendarMeta(share.calendarId);
        if (metadata.davAccess === 'hidden') return null;
        if (share.mode === 'calendar') {
          if ([...url.searchParams.keys()].length) return { invalidQuery: true };
          const objects = await store.snapshotEvents(share.calendarId);
          return objects === null ? null : { type: 'text/calendar; charset=utf-8', content: mergeCalendars(objects) };
        }
        if ([...url.searchParams.keys()].some((key) => !['from', 'to'].includes(key))
          || url.searchParams.getAll('from').length > 1 || url.searchParams.getAll('to').length > 1) return { invalidQuery: true };
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const start = from === null ? currentTime : Date.parse(from);
        const end = to === null ? start + 7 * DAY : Date.parse(to);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * DAY) return { invalidQuery: true };
        const objects = await store.snapshotEvents(share.calendarId);
        if (objects === null) return null;
        const intervals = [];
        for (const object of objects) intervals.push(...await busyIntervals(object.content, { start, end }));
        return { type: 'application/json; charset=utf-8', content: {
          from: new Date(start).toISOString(), to: new Date(end).toISOString(),
          busy: mergeBusy(intervals).map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() })) } };
      });
      if (!result) continue;
      if (result.invalidQuery) return send(req, res, 400, { ok: false, code: 'invalid_range' });
      return send(req, res, 200, result.content, result.type);
    }
    return send(req, res, 404, NOT_FOUND);
  }

  function owns(pathname) {
    return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`) || pathname === '/share' || pathname.startsWith('/share/');
  }
  async function handle(req, res, url = new URL(req.url || '/', 'http://localhost')) {
    try {
      if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) return await manage(req, res, url);
      return await shared(req, res, url);
    } catch (error) {
      if (error.status) return send(req, res, error.status, { ok: false, code: error.code || 'invalid', message: error.message });
      // Public failures stay indistinguishable from an unavailable link.
      if (url.pathname.startsWith('/share')) return send(req, res, 404, NOT_FOUND);
      log('share-management-error', { reason: 'registry-or-storage-failed' });
      return send(req, res, 500, { ok: false, code: 'internal_error' });
    }
  }
  return { owns, handle };
}

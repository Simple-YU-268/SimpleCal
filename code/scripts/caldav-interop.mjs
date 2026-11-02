#!/usr/bin/env node
// Synthetic black-box protocol runner. External mutation requires an explicit
// home URL; credentials are read from the environment and never logged.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { parseXml, find, findAll, escapeXml } from '../app/lib/xml.mjs';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--url', '--home', '--user', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: caldav-interop.mjs [--url ORIGIN --home HOME_URL --user USER] [--output JSON_PATH]');
  options[args[i].slice(2)] = args[i + 1];
}
const report = { createdAt: new Date().toISOString(), target: options.url ? 'external-explicit' : 'local-ephemeral',
  platform: process.platform, node: process.version, cases: [], exchanges: [], cleanup: { ok: false } };
let app, data, root, home, auth = {}, collection, owned = false;
const files = new Set();
const DAV = 'DAV:', CAL = 'urn:ietf:params:xml:ns:caldav';
const namespaces = `xmlns:D="${DAV}" xmlns:C="${CAL}"`;
const event = (uid, title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Interop//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
async function request(method, target, body, headers = {}) {
  const url = new URL(target, root);
  ensure(url.origin === root.origin && !url.username && !url.password, 'out-of-origin request refused');
  const response = await fetch(url, { method, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { ...auth, 'Content-Type': 'application/xml; charset=utf-8', ...headers } });
  const text = await response.text();
  report.exchanges.push({ method, path: url.pathname, status: response.status });
  return { status: response.status, headers: response.headers, text };
}
async function check(name, run) {
  try { await run(); report.cases.push({ name, pass: true }); }
  catch (error) { report.cases.push({ name, pass: false, error: error.message }); throw error; }
}
const sync = (token) => request('REPORT', collection,
  `<D:sync-collection ${namespaces}><D:sync-token>${escapeXml(token)}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`);
try {
  if (options.url) {
    root = new URL(options.url);
    ensure(['http:', 'https:'].includes(root.protocol) && !root.username && !root.password, 'invalid server URL');
    ensure(options.home && options.user && process.env.CALDAV_INTEROP_PASSWORD, 'external run requires --home, --user and CALDAV_INTEROP_PASSWORD');
    home = new URL(options.home, root);
    ensure(home.origin === root.origin && home.pathname.endsWith('/') && !home.search && !home.hash, 'home must be a same-origin collection URL ending in /');
    auth = { Authorization: `Basic ${Buffer.from(`${options.user}:${process.env.CALDAV_INTEROP_PASSWORD}`).toString('base64')}` };
  } else {
    const { createApp, resolveConfig } = await import('../app/server.mjs');
    data = await mkdtemp(path.join(tmpdir(), 'simplecal-interop-'));
    const password = `Interop-${randomUUID()}!`;
    app = await createApp(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_USER: 'interop', CALDAV_ADMIN_PASSWORD: password }),
      { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    root = new URL(`http://127.0.0.1:${app.server.address().port}/`);
    home = new URL('/calendars/interop/', root);
    const login = await request('POST', '/api/v1/auth/login', JSON.stringify({ username: 'interop', password }), { 'Content-Type': 'application/json' });
    ensure(login.status === 200, 'local login failed');
    auth = { Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '), 'X-CSRF-Token': JSON.parse(login.text).csrf };
  }
  await check('OPTIONS capabilities', async () => {
    const result = await request('OPTIONS', home);
    ensure(result.status === 200 && /calendar-access/.test(result.headers.get('dav') || ''), 'missing CalDAV capabilities');
  });
  await check('principal and calendar-home discovery', async () => {
    const result = await request('PROPFIND', home, `<D:propfind ${namespaces}><D:prop><D:current-user-principal/></D:prop></D:propfind>`, { Depth: '0' });
    ensure(result.status === 207, 'principal discovery failed');
    const principal = find(find(parseXml(result.text), 'current-user-principal', DAV), 'href', DAV)?.text;
    ensure(principal, 'principal href missing');
    const found = await request('PROPFIND', principal, `<D:propfind ${namespaces}><D:prop><C:calendar-home-set/></D:prop></D:propfind>`, { Depth: '0' });
    ensure(found.status === 207 && find(parseXml(found.text), 'calendar-home-set', CAL), 'calendar home discovery failed');
  });
  collection = new URL(`simplecal-interop-${randomUUID()}/`, home);
  await check('MKCALENDAR synthetic collection', async () => {
    const result = await request('MKCALENDAR', collection);
    ensure(result.status === 201, `MKCALENDAR returned ${result.status}`); owned = true;
  });
  const uid = randomUUID(), resource = new URL(`${uid}.ics`, collection), moved = new URL(`${uid}-moved.ics`, collection);
  let etag, token;
  await check('PUT create and GET raw data', async () => {
    const created = await request('PUT', resource, event(uid, 'Synthetic interop'), { 'Content-Type': 'text/calendar', 'If-None-Match': '*' });
    ensure(created.status === 201, 'create failed');
    files.add(resource.href);
    const get = await request('GET', resource); etag = get.headers.get('etag');
    ensure(get.status === 200 && get.text.includes(`UID:${uid}`) && etag, 'GET/ETag mismatch');
  });
  await check('calendar-multiget found and missing', async () => {
    const result = await request('REPORT', collection, `<C:calendar-multiget ${namespaces}><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>${escapeXml(resource.pathname)}</D:href><D:href>${escapeXml(collection.pathname)}missing.ics</D:href></C:calendar-multiget>`);
    ensure(result.status === 207 && result.text.includes(uid) && /404 Not Found/.test(result.text), 'multiget result mismatch');
  });
  await check('calendar-query component/time-range', async () => {
    const result = await request('REPORT', collection, `<C:calendar-query ${namespaces}><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261030T000000Z" end="20261031T000000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
    ensure(result.status === 207 && result.text.includes(uid), 'query mismatch');
  });
  await check('initial sync token', async () => {
    const result = await sync(''); ensure(result.status === 207, 'initial sync failed');
    token = find(parseXml(result.text), 'sync-token', DAV)?.text; ensure(token, 'sync token missing');
  });
  await check('conditional update and stale-write rejection', async () => {
    const updated = await request('PUT', resource, event(uid, 'Updated synthetic'), { 'Content-Type': 'text/calendar', 'If-Match': etag });
    ensure(updated.status === 204, 'conditional update failed');
    const stale = await request('PUT', resource, event(uid, 'Stale synthetic'), { 'Content-Type': 'text/calendar', 'If-Match': etag });
    ensure(stale.status === 412, 'stale version was accepted');
  });
  await check('MOVE and source disappearance', async () => {
    const result = await request('MOVE', resource, undefined, { Destination: moved.href, Overwrite: 'F' });
    ensure(result.status === 201, 'MOVE failed');
    files.add(moved.href);
    ensure((await request('GET', resource)).status === 404 && (await request('GET', moved)).status === 200, 'MOVE content visibility mismatch');
  });
  await check('incremental sync includes deletion and destination', async () => {
    const result = await sync(token);
    ensure(result.status === 207 && /404 Not Found/.test(result.text) && result.text.includes(`${uid}-moved.ics`), 'incremental history mismatch');
  });
  await check('DELETE synthetic object', async () => {
    ensure([200, 204].includes((await request('DELETE', moved)).status), 'delete failed');
    ensure((await request('GET', moved)).status === 404, 'deleted resource remains visible');
  });
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (owned) {
    for (const file of files) try { await request('DELETE', file); } catch { /* collection cleanup below */ }
    try {
      const deleted = await request('DELETE', collection);
      report.cleanup = { ok: [200, 204, 404].includes(deleted.status), collectionPath: collection.pathname, status: deleted.status };
    } catch (error) { report.cleanup = { ok: false, collectionPath: collection.pathname, error: error.message }; }
  }
  if (app) { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); }
  if (data) {
    ensure(path.dirname(path.resolve(data)) === path.resolve(tmpdir()) && path.basename(data).startsWith('simplecal-interop-'), 'unexpected temporary store path');
    await rm(data, { recursive: true, force: true }); report.cleanup = { ok: true, mode: 'ephemeral-store-removed' };
  }
  if (options.url && !report.cleanup.ok) process.exitCode = 1;
  report.pass = !report.error && report.cleanup.ok;
  const json = JSON.stringify(report, null, 2);
  if (options.output) await writeFile(options.output, json + '\n', 'utf8');
  console.log(json);
}

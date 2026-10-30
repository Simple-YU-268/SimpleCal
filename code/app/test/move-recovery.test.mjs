import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const { createApp, resolveConfig } = await import((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR)
  ? pathToFileURL(path.join((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR), 'server.mjs')).href
  : new URL('../server.mjs', import.meta.url).href);

const xml = 'application/xml; charset=utf-8';
const syncBody = (token) => `<?xml version="1.0"?><D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;
const tokenOf = (body) => /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(body)?.[1];

test('startup rolls a journaled MOVE forward with both collections metadata', { timeout: 30000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fncal-move-recovery-'));
  const config = resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_ADMIN_PASSWORD: 'Move-Pass-42!', CALDAV_USER: 'probe' });
  let app;
  async function stop() {
    if (!app) return;
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = null;
  }
  async function boot() {
    app = await createApp(config, { skipAutoReconcile: true, logger: { event() {}, access() {} } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'Move-Pass-42!' }),
    });
    const auth = {
      Cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; '),
      'X-CSRF-Token': (await login.json()).csrf,
    };
    return async (method, url, { body, headers = {} } = {}) => {
      const response = await fetch(`${base}${url}`, { method, headers: { ...auth, ...headers }, body });
      return { status: response.status, text: await response.text() };
    };
  }
  try {
    let request = await boot();
    await request('MKCALENDAR', '/calendars/probe/archive/', { body: '', headers: { 'Content-Type': xml } });
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:recover\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Recover\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    assert.equal((await request('PUT', '/calendars/probe/default/recover.ics', {
      body: ics, headers: { 'Content-Type': 'text/calendar' },
    })).status, 201);
    const oldSource = await request('REPORT', '/calendars/probe/default/', { body: syncBody(''), headers: { 'Content-Type': xml, Depth: '1' } });
    const oldTarget = await request('REPORT', '/calendars/probe/archive/', { body: syncBody(''), headers: { 'Content-Type': xml, Depth: '1' } });
    const sourceToken = tokenOf(oldSource.text);
    const targetToken = tokenOf(oldTarget.text);
    const userId = (await app.accounts.all())[0].id;
    const sourcePaths = app.store.calendarPaths(userId, 'default');
    const targetPaths = app.store.calendarPaths(userId, 'archive');
    await stop();

    const sourceFile = path.join(sourcePaths.objectsDir, 'recover.ics');
    const targetFile = path.join(targetPaths.objectsDir, 'recovered.ics');
    const sourceMeta = JSON.parse(await readFile(sourcePaths.metaPath, 'utf8'));
    const targetMeta = JSON.parse(await readFile(targetPaths.metaPath, 'utf8'));
    const sourceState = JSON.parse(await readFile(sourcePaths.statePath, 'utf8'));
    const targetState = JSON.parse(await readFile(targetPaths.statePath, 'utf8'));
    sourceMeta.ctag += 1;
    targetMeta.ctag += 1;
    delete sourceState.ctags.recover;
    sourceMeta.tombstones.push({ uid: 'recover', ctag: sourceMeta.ctag, deletedAt: '2026-10-30T00:00:00.000Z' });
    targetState.ctags.recovered = targetMeta.ctag;
    const journal = {
      version: 1,
      source: `${userId}/default/objects/recover.ics`,
      target: `${userId}/archive/objects/recovered.ics`,
      backup: `${userId}/archive/objects/recovered.ics.move-test.bak`,
      sourceHash: createHash('sha256').update(ics).digest('hex'),
      targetHash: null,
      writes: [
        { path: `${userId}/default/meta.json`, text: `${JSON.stringify(sourceMeta)}\n` },
        { path: `${userId}/default/objects/.state.json`, text: `${JSON.stringify(sourceState)}\n` },
        { path: `${userId}/archive/meta.json`, text: `${JSON.stringify(targetMeta)}\n` },
        { path: `${userId}/archive/objects/.state.json`, text: `${JSON.stringify(targetState)}\n` },
      ],
    };
    await mkdir(path.join(config.calendarsDir, '.moves'), { recursive: true });
    await writeFile(path.join(config.calendarsDir, '.moves', '00000000-0000-4000-8000-000000000001.json'), JSON.stringify(journal));
    await rename(sourceFile, targetFile);

    request = await boot();
    assert.equal((await request('GET', '/calendars/probe/default/recover.ics')).status, 404);
    assert.equal((await request('GET', '/calendars/probe/archive/recovered.ics')).status, 200);
    const sourceChanges = await request('REPORT', '/calendars/probe/default/', { body: syncBody(sourceToken), headers: { 'Content-Type': xml, Depth: '1' } });
    const targetChanges = await request('REPORT', '/calendars/probe/archive/', { body: syncBody(targetToken), headers: { 'Content-Type': xml, Depth: '1' } });
    assert.match(sourceChanges.text, /recover\.ics<\/D:href><D:status>HTTP\/1\.1 404/);
    assert.match(targetChanges.text, /recovered\.ics/);
    assert.deepEqual(await readdir(path.join(config.calendarsDir, '.moves')), []);
  } finally {
    await stop();
    await rm(data, { recursive: true, force: true });
  }
});

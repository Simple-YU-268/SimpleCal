import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { resolveConfig } from '../server.mjs';

const sourceApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional: exercise the actual portable output instead of the source runtime.
const app = (process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR) || sourceApp;
const temporary = await mkdtemp(path.join(tmpdir(), 'fncal-deploy-'));

test('portable configuration, password secrets, HTTP/DAV and restart persistence', async () => {
  let child;
  let base;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    child = null;
  }
  async function start(data, extra = {}) {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CALDAV_|TRIM_)/.test(key)));
    child = spawn(process.execPath, [path.join(app, 'server.mjs')], {
      cwd: temporary,
      env: { ...env, CALDAV_DATA_DIR: data, CALDAV_HOST: '127.0.0.1',
        CALDAV_PORT: String(port), CALDAV_STDIN_EXIT: '1', ...extra },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (part) => { errors += part; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
      try {
        if ((await fetch(`${base}/api/version`)).ok) return;
      } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Startup timeout');
  }
  async function login(password) {
    return fetch(`${base}/api/v1/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'caldav', password }),
    });
  }
  try {
    const data = path.join(temporary, 'data');
    const legacy = path.join(temporary, 'legacy');
    await mkdir(data);
    await writeFile(path.join(data, 'config.json'), JSON.stringify({ port: 8765 }));
    assert.equal(resolveConfig({ CALDAV_DATA_DIR: data, TRIM_PKGVAR: legacy }).varDir, data);
    assert.equal(resolveConfig({ TRIM_PKGVAR: legacy }).varDir, legacy);
    assert.equal(resolveConfig({ CALDAV_DATA_DIR: data }).port, 8765);
    assert.equal(resolveConfig({ CALDAV_DATA_DIR: data, CALDAV_PORT: '9876' }).port, 9876);
    assert.equal(resolveConfig({ CALDAV_DATA_DIR: data }).adminPassword, '');
    assert.equal(resolveConfig({ TRIM_PKGVAR: legacy }).adminPassword, 'caldav');
    const secret = path.join(temporary, 'password');
    const password = 'Server-Secret-42!';
    await writeFile(secret, `${password}\r\n`);
    assert.equal(resolveConfig({ CALDAV_ADMIN_PASSWORD_FILE: secret }).adminPassword, password);
    assert.throws(() => resolveConfig({ CALDAV_ADMIN_PASSWORD_FILE: secret, CALDAV_ADMIN_PASSWORD: '' }), /only one/);
    assert.throws(() => resolveConfig({ CALDAV_ADMIN_PASSWORD_FILE: `${secret}.missing` }), /Cannot read/);
    await writeFile(secret, '\n');
    assert.throws(() => resolveConfig({ CALDAV_ADMIN_PASSWORD_FILE: secret }), /empty/);
    await writeFile(secret, `${password}\n`);

    await start(path.join(temporary, 'generated'));
    const generated = (await readFile(path.join(temporary, 'generated/admin-initial-password.txt'), 'utf8')).trim();
    assert.notEqual(generated, 'caldav');
    const initialLogin = await login(generated);
    assert.equal(initialLogin.status, 200);
    assert.equal((await initialLogin.json()).user.mustChangePassword, true);
    await stop();

    await start(data, { CALDAV_ADMIN_PASSWORD_FILE: secret });
    assert.equal((await login(password)).status, 200);
    if ((process.env.SIMPLECAL_TEST_SERVER_DIR || process.env.FNCAL_TEST_SERVER_DIR)) {
      const root = await fetch(`${base}/`);
      assert.equal(root.status, 200);
      assert.match(await root.text(), /<title>SimpleCal<\/title>/);
    }
    const headers = { Authorization: `Basic ${Buffer.from(`caldav:${password}`).toString('base64')}` };
    const discovery = await fetch(`${base}/`, { method: 'PROPFIND', headers: { ...headers, Depth: '0' } });
    assert.equal(discovery.status, 207);
    const xml = await discovery.text();
    const principal = /<[^>]*current-user-principal[^>]*>\s*<[^>]*href[^>]*>([^<]+)/.exec(xml)?.[1];
    assert.ok(principal, 'DAV principal discovery');
    const uid = principal.split('/').filter(Boolean).at(-1);
    const url = `${base}/calendars/${uid}/default/deployment.ics`;
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Test//EN\r\nBEGIN:VEVENT\r\nUID:deployment\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Portable persistence\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/calendar' }, body: ics })).status, 201);
    const objectPath = new URL(url).pathname;
    await stop();
    await start(data, { CALDAV_ADMIN_PASSWORD: 'Changed-environment-42!' });
    assert.equal((await login(password)).status, 200, 'restart must preserve account password');
    const persisted = await fetch(`${base}${objectPath}`, { headers });
    assert.equal(persisted.status, 200);
    assert.match(await persisted.text(), /Portable persistence/);
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

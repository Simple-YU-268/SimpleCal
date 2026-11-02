import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../store/file-store.mjs';
import { runWithContext } from '../lib/request-context.mjs';
const content = (uid, title = uid) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'simplecal-source-cache-'));
  try {
    const store = createStore({ root, now: () => Date.parse('2027-03-02T000000Z') });
    await store.ensureRoot(); await store.ensureUser('alice');
    await runWithContext({ userId: 'alice' }, () => run(store, root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('warm source cache detects hand-copied objects, same-size edits and removal', () => fixture(async (store, root) => {
  assert.deepEqual(await store.listObjects('default'), []);
  const file = path.join(root, 'alice/default/objects/copied.ics');
  const before = content('copied', 'First');
  await writeFile(file, before);
  const copied = await store.listObjects('default');
  assert.equal(copied.length, 1); assert.equal(copied[0].content, before);
  const stamp = await stat(file);
  await writeFile(file, content('copied', 'Other'));
  await utimes(file, stamp.atime, new Date(stamp.mtimeMs + 2000));
  const edited = await store.listObjects('default');
  assert.equal(Buffer.byteLength(edited[0].content), Buffer.byteLength(before));
  assert.match(edited[0].content, /SUMMARY:Other/);
  assert.notEqual(edited[0].etag, copied[0].etag);
  const batch = await store.getEvents('default', ['copied.ics']);
  assert.equal(batch[0].etag, edited[0].etag);
  await unlink(file);
  assert.deepEqual(await store.listObjects('default'), []);
  assert.deepEqual(await store.getEvents('default', ['copied.ics']), [null]);
}));

test('newly hand-copied lunar content is versioned before the first returned list', () => fixture(async (store, root) => {
  await store.listObjects('default');
  const token = await store.syncToken('default');
  const lunar = content('lunar').replace('SUMMARY:lunar',
    'SUMMARY:lunar\r\nX-FNCAL-LUNAR:1\r\nX-FNCAL-LUNAR-DATE:8-15\r\nX-FNCAL-LUNAR-RULE:YEARLY-LUNAR');
  await writeFile(path.join(root, 'alice/default/objects/lunar.ics'), lunar);
  const first = await store.listObjects('default');
  assert.match(first[0].content, /^RDATE/m);
  const batch = await store.getEvents('default', ['lunar.ics']);
  assert.equal(batch[0].etag, first[0].etag);
  assert.notEqual(await store.syncToken('default'), token);
  assert.equal((await store.changesSince('default', token)).changes.some((c) => c.uid === 'lunar' && !c.deleted), true);
}));

test('sync coalesces delete and recreate UID, and calendar recreation invalidates its epoch', () => fixture(async (store) => {
  await store.putEvent('default', 'again.ics', content('again', 'Before'));
  const baseline = await store.syncToken('default');
  await store.deleteEvent('default', 'again.ics');
  await store.putEvent('default', 'again.ics', content('again', 'Newest'));
  const delta = await store.changesSince('default', baseline);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0].deleted, false);
  assert.equal(delta.changes[0].uid, 'again');
  await store.createCalendar('custom');
  await store.putEvent('custom', 'old.ics', content('old'));
  const oldToken = await store.syncToken('custom');
  assert.equal((await store.deleteCalendar('custom')).deleted, true);
  await store.createCalendar('custom');
  await store.putEvent('custom', 'new.ics', content('new'));
  assert.ok((await store.changesSince('custom', oldToken)).error);
  assert.notEqual(await store.syncToken('custom'), oldToken);
}));

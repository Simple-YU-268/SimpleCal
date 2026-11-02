import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../store/file-store.mjs';
import { runWithContext } from '../lib/request-context.mjs';
const content = (id, title = id) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${id}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test('durable sync pages preserve watermark and contents across writes, MOVE and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'simplecal-pages-'));
  try {
    let store = createStore({ root });
    await store.ensureRoot(); await store.ensureUser('alice'); await store.ensureUser('bob');
    await runWithContext({ userId: 'alice' }, async () => {
      for (const id of ['a', 'b', 'c', 'd']) await store.putEvent('default', `${id}.ics`, content(id));
      const first = await store.syncPage('default', '', 1);
      assert.equal(first.more, true);
      assert.equal(first.changes.length, 1);
      const baseline = await store.syncToken('default');
      await store.putEvent('default', 'b.ics', content('b', 'changed'));
      await store.deleteEvent('default', 'c.ics');
      await store.putEvent('default', 'e.ics', content('e'));
      await store.moveEvent('default', 'd.ics', 'tasks', 'd.ics', async () => {});
      store = createStore({ root });
      const captured = [...first.changes];
      let token = first.token;
      for (let page = 0; page < 10; page += 1) {
        const next = await store.syncPage('default', token, 1);
        assert.ok(!next.error, JSON.stringify(next));
        captured.push(...next.changes); token = next.token;
        if (!next.more) break;
      }
      assert.equal(token, baseline);
      assert.deepEqual(captured.map((c) => c.uid).sort(), ['a', 'b', 'c', 'd']);
      assert.match(captured.find((c) => c.uid === 'b').event.content, /SUMMARY:b\r/);
      const delta = await store.syncPage('default', token, 100);
      assert.deepEqual(delta.changes.map((c) => c.uid).sort(), ['b', 'c', 'd', 'e']);
      assert.equal(delta.changes.find((c) => c.uid === 'c').deleted, true);
      assert.equal(delta.changes.find((c) => c.uid === 'd').deleted, true);
      const replay = await store.syncPage('default', first.token, 1);
      assert.equal(replay.changes[0].uid, captured[1].uid);
      assert.equal((await store.syncPage('tasks', first.token, 1)).error, 'expired');
      const batch = await store.getEvents('default', ['a.ics', 'missing.ics', 'b.ics']);
      assert.equal(batch[0].uid, 'a'); assert.equal(batch[1], null); assert.equal(batch[2].uid, 'b');
      assert.deepEqual((await store.queryCandidates('default', { component: 'VTODO' })), []);
      await assert.rejects(store.getEvents('default', ['../escape.ics']));
      await assert.rejects(store.syncPage('default', '', 0), (e) => e.status === 400);
      await runWithContext({ userId: 'bob' }, async () => assert.ok((await store.syncPage('default', first.token, 1)).error));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../store/file-store.mjs';
import { runWithContext } from '../lib/request-context.mjs';
import {
  assertStorageProvider,
  createParsedObjectCache,
  validateStorageProvider,
  verifyStorage,
} from '../lib/storage-provider.mjs';

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Provider Test//EN\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:One\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('parsed object cache keys by content and isolates returned models', async () => {
  let calls = 0;
  const cache = createParsedObjectCache({ parser: async (content) => {
    calls += 1;
    return { content, nested: { value: calls } };
  } });
  const first = await cache.parse('same');
  const second = await cache.parse('same');
  assert.equal(calls, 1);
  assert.notEqual(first, second);
  first.nested.value = 99;
  assert.equal((await cache.parse('same')).nested.value, 1);
  assert.equal((await cache.parse('changed')).content, 'changed');
  assert.equal(calls, 2);
  const stats = cache.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 2);
  assert.equal(stats.inFlight, 0);
  assert.ok(stats.bytes > 0 && stats.bytes <= stats.maxBytes);
});

test('file provider satisfies its contract, emits committed changes and verifies storage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fncal-provider-'));
  try {
    const store = createStore({ root });
    assert.equal(validateStorageProvider(store).ok, true);
    assert.equal(assertStorageProvider(store), store);
    assert.equal(validateStorageProvider({ maxObjectBytes: 1024 }).ok, false);
    await store.ensureRoot();
    await store.ensureUser('alice');
    const changes = [];
    const unsubscribe = store.subscribeChanges((change) => changes.push(change));
    await runWithContext({ userId: 'alice' }, () => store.putEvent('default', 'one.ics', ics));
    unsubscribe();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, 'create');
    assert.equal(changes[0].calendarId, 'default');
    assert.equal(changes[0].id, 'one');
    assert.ok(!('content' in changes[0]));

    const healthy = await verifyStorage({ store, accounts: [{ id: 'alice' }] });
    assert.equal(healthy.ok, true, JSON.stringify(healthy.issues));
    assert.equal(healthy.objects, 1);
    assert.equal(healthy.calendars, 2);
    assert.equal(healthy.readOnly, true);

    const paths = store.calendarPaths('alice', 'default');
    await writeFile(paths.statePath, JSON.stringify({ ctags: {}, tombstoneFloor: 0 }));
    const broken = await verifyStorage({ store, accounts: [{ id: 'alice' }] });
    assert.equal(broken.ok, false);
    assert.ok(broken.issues.some((issue) => issue.code === 'object_state_mismatch' && issue.id === 'one'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

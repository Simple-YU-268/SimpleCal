import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCalendarScheduling } from '../lib/calendar-scheduling.mjs';

const organizer = { userId: 'organizer', addresses: ['host@example.test'] };
const attendee = { userId: 'attendee', addresses: ['guest@example.test'] };
const stranger = { userId: 'stranger', addresses: ['stranger@example.test'] };
const message = (method = 'REQUEST', sequence = 0, partstat = 'ACCEPTED') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:meeting\r\nDTSTAMP:20261030T090000Z\r\nSEQUENCE:${sequence}\r\nDTSTART:20261101T090000Z\r\nDTEND:20261101T100000Z\r\nORGANIZER:mailto:host@example.test\r\nATTENDEE;CN="Guest: Test";PARTSTAT=${partstat}:mailto:guest@example.test\r\nSUMMARY:Planning\r\nX-CUSTOM:preserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

async function fixture(run, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'simplecal-scheduling-'));
  let instant = 0;
  const adapter = { now: () => instant, ...options,
    readState: async (userId) => { try { return JSON.parse(await readFile(path.join(root, userId + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    writeState: async (userId, state) => {
      const file = path.join(root, userId + '.json');
      await writeFile(file + '.tmp', JSON.stringify(state)); await rename(file + '.tmp', file);
    } };
  try { await run(createCalendarScheduling(adapter), () => createCalendarScheduling(adapter), (time) => { instant = time; }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('local organizer invitation, attendee reply and cancellation authorize roles and survive restart', () => fixture(async (service, restart) => {
  await assert.rejects(service.submit(stranger, { content: message() }), (e) => e.status === 403);
  const sent = await service.submit(organizer, { content: message() });
  assert.equal(sent.ids.length, 1);
  assert.equal((await service.submit(organizer, { content: message() })).duplicate, true);
  assert.equal((await service.list(organizer)).outbox.length, 1);
  await assert.rejects(service.receive(stranger, { sender: organizer, content: message() }), (e) => e.status === 403);
  const delivered = await service.attempt(organizer, sent.ids[0], async (item) => {
    assert.equal(item.recipient, 'guest@example.test');
    assert.equal(item.idempotencyKey, sent.ids[0]);
    await service.receive(attendee, { sender: organizer, content: item.content });
  });
  assert.equal(delivered.status, 'delivered');
  const reply = await service.submit(attendee, { content: message('REPLY') });
  await service.attempt(attendee, reply.ids[0], async (item) => service.receive(organizer, { sender: attendee, content: item.content }));
  assert.equal((await service.list(organizer)).invitations[0].responses['guest@example.test'], 'ACCEPTED');
  service = restart();
  assert.equal((await service.list(attendee)).invitations[0].uid, 'meeting');
  await service.submit(organizer, { content: message('REQUEST', 2) });
  await assert.rejects(service.receive(organizer, { sender: attendee, content: message('REPLY', 1) }), (e) => e.code === 'stale_reply');
  await assert.rejects(service.submit(organizer, { content: message('REQUEST', 1) }), (e) => e.code === 'stale_sequence');
  const cancelled = await service.submit(organizer, { content: message('CANCEL', 3) });
  await service.attempt(organizer, cancelled.ids[0], async (item) => service.receive(attendee, { sender: organizer, content: item.content }));
  assert.equal((await service.list(attendee)).invitations[0].cancelled, true);
  await assert.rejects(service.submit(attendee, { content: message('REPLY', 3) }), (e) => e.code === 'stale_reply');
  assert.match((await service.list(attendee)).invitations[0].content, /X-CUSTOM:preserved/);
}));

test('outbox retries, backoff, failures and limits are durable; no delivery occurs implicitly', () => fixture(async (service, restart, clock) => {
  const submitted = await service.submit(organizer, { content: message() });
  await assert.rejects(service.attempt(organizer, submitted.ids[0]), (e) => e.code === 'delivery_unconfigured');
  assert.equal((await service.list(organizer)).outbox[0].attempts, 0);
  const broken = async () => { throw new Error('secret transport failure'); };
  assert.equal((await service.attempt(organizer, submitted.ids[0], broken)).status, 'retry');
  service = restart();
  await assert.rejects(service.attempt(organizer, submitted.ids[0], broken), (e) => e.code === 'retry_not_due');
  clock(1001);
  assert.equal((await service.attempt(organizer, submitted.ids[0], broken)).status, 'failed');
  assert.equal((await service.list(organizer)).outbox[0].lastError, 'local_delivery_failed');
  await assert.rejects(service.submit(organizer, { content: message('REQUEST', 1) }), (e) => e.code === 'outbox_full');
  assert.equal((await service.list(organizer)).invitations[0].sequence, 0, 'rejected enqueue must not commit invitation change');
  assert.equal((await service.purge(organizer, submitted.ids)).removed, 1);
  assert.equal((await service.submit(organizer, { content: message('REQUEST', 1) })).ids.length, 1);
}, { maxAttempts: 2, maxMessages: 1 }));

test('unsupported recurring and malformed scheduling input is rejected', () => fixture(async (service) => {
  for (const content of [message().replace('UID:meeting', 'UID:meeting\r\nRRULE:FREQ=DAILY'),
    message('PUBLISH'), message('REPLY', 0, 'NEEDS-ACTION')]) {
    await assert.rejects(service.submit(organizer, { content }), (e) => [400, 403].includes(e.status));
  }
  assert.equal((await service.list(organizer)).outbox.length, 0);
}));

test('delivery lease survives restart and prevents simultaneous attempts or unbounded crash retries', () => fixture(async (service, restart, clock) => {
  const { ids } = await service.submit(organizer, { content: message() });
  let release, entered;
  const active = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const first = service.attempt(organizer, ids[0], async () => { entered(); await waiting; });
  await active;
  const recovered = restart();
  await assert.rejects(recovered.attempt(organizer, ids[0], async () => {}), (e) => e.code === 'retry_not_due');
  clock(300001);
  let duplicateDelivery = false;
  const failed = await recovered.attempt(organizer, ids[0], async () => { duplicateDelivery = true; });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'delivery_outcome_unknown');
  assert.equal(duplicateDelivery, false);
  release();
  await first;
  assert.equal((await recovered.list(organizer)).outbox[0].status, 'failed', 'late callback cannot overwrite a recovered terminal state');
}, { maxAttempts: 1 }));

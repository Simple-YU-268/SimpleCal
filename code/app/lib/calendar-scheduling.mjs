// Bounded local iTIP workflow, not RFC 6638 auto-scheduling or an SMTP client.
// RFC 5546 sections 2.1.5, 3.2.2-3.2.5 specify organizer/attendee roles and
// REQUEST/REPLY/CANCEL revisions: https://www.rfc-editor.org/rfc/rfc5546
import { createHash } from 'node:crypto';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const address = (value) => String(value || '').replace(/^mailto:/i, '').toLowerCase();
const hash = (value) => createHash('sha256').update(value).digest('hex');

function property(line) {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && line[i] === ':') { colon = i; break; }
  }
  if (colon < 0 || quoted) throw fail(400, 'invalid_itip', 'Invalid iCalendar property');
  const head = line.slice(0, colon);
  const name = head.split(';')[0].toUpperCase();
  return { name, head, value: line.slice(colon + 1) };
}

export function parseSchedulingMessage(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw fail(413, 'message_too_large', 'iTIP message exceeds limit');
  const lines = content.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  const stack = [], calendar = [], event = [];
  let events = 0, calendars = 0;
  for (const line of lines) {
    const p = property(line);
    if (p.name === 'BEGIN') {
      if ((stack.length === 0 && p.value !== 'VCALENDAR') || (stack.length === 1 && p.value !== 'VEVENT') || stack.length > 1) {
        throw fail(403, 'unsupported_itip', 'Only a single nonrecurring VEVENT is supported');
      }
      if (p.value === 'VEVENT') events += 1;
      if (p.value === 'VCALENDAR') calendars += 1;
      stack.push(p.value);
    } else if (p.name === 'END') {
      if (stack.pop() !== p.value) throw fail(400, 'invalid_itip', 'Unbalanced iCalendar components');
    } else if (stack.length === 1) calendar.push(p);
    else if (stack.length === 2) event.push(p);
    else throw fail(400, 'invalid_itip', 'Property outside VCALENDAR');
  }
  if (stack.length || events !== 1 || calendars !== 1 || lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') throw fail(400, 'invalid_itip', 'Invalid scheduling message');
  const one = (items, name, required = true) => {
    const found = items.filter((p) => p.name === name);
    if (found.length > 1 || (required && !found.length)) throw fail(400, 'invalid_itip', `Invalid ${name}`);
    return found[0]?.value;
  };
  const method = one(calendar, 'METHOD');
  if (!['REQUEST', 'REPLY', 'CANCEL'].includes(method)) throw fail(403, 'unsupported_method', 'Supported scheduling methods are REQUEST, REPLY and CANCEL');
  if (one(calendar, 'VERSION') !== '2.0') throw fail(400, 'invalid_itip', 'VERSION must be 2.0');
  if (event.some((p) => ['RRULE', 'RDATE', 'RECURRENCE-ID', 'EXDATE'].includes(p.name))) throw fail(403, 'unsupported_itip', 'Recurring scheduling is not supported');
  const uid = one(event, 'UID');
  const stamp = one(event, 'DTSTAMP');
  const sequenceText = one(event, 'SEQUENCE', false) ?? '0';
  if (!uid || uid.length > 255 || /[\x00-\x1f]/.test(uid) || !/^\d{8}T\d{6}Z$/.test(stamp) || !/^\d+$/.test(sequenceText)) throw fail(400, 'invalid_itip', 'Invalid UID, DTSTAMP or SEQUENCE');
  const stampIso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  if (!Number.isFinite(Date.parse(stampIso)) || new Date(stampIso).toISOString().slice(0, 19) !== stampIso.slice(0, 19)) throw fail(400, 'invalid_itip', 'Invalid DTSTAMP date');
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) throw fail(400, 'invalid_itip', 'Invalid SEQUENCE');
  const organizer = address(one(event, 'ORGANIZER'));
  const attendees = event.filter((p) => p.name === 'ATTENDEE').map((p) => ({
    address: address(p.value), partstat: /(?:^|;)PARTSTAT=([^;]+)/i.exec(p.head)?.[1]?.toUpperCase() || 'NEEDS-ACTION',
  }));
  if (![organizer, ...attendees.map((p) => p.address)].every((a) => /^[^\s@<>]+@[^\s@<>]+$/.test(a)) || !attendees.length
    || new Set(attendees.map((p) => p.address)).size !== attendees.length) throw fail(400, 'invalid_itip', 'Invalid or duplicate calendar addresses');
  if (method === 'REQUEST') one(event, 'DTSTART');
  if (method === 'REPLY' && (attendees.length !== 1 || !['ACCEPTED', 'DECLINED', 'TENTATIVE'].includes(attendees[0].partstat))) throw fail(400, 'invalid_reply', 'REPLY requires one attendee and an explicit participation status');
  return { method, uid, sequence, organizer, attendees, stamp, content, digest: hash(content) };
}

export function createCalendarScheduling({ readState, writeState, now = Date.now, maxMessages = 1000, maxAttempts = 5,
  maxStateBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof readState !== 'function' || typeof writeState !== 'function') throw new TypeError('Scheduling requires atomic readState/writeState adapters');
  if (![maxMessages, maxAttempts, maxStateBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Scheduling limits must be positive safe integers');
  const queues = new Map();
  const identity = (actor) => {
    if (!actor || typeof actor.userId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(actor.userId)
      || !Array.isArray(actor.addresses) || !actor.addresses.length) throw fail(403, 'identity_required', 'Trusted local calendar identity required');
    return new Set(actor.addresses.map(address));
  };
  const keyOf = (message) => hash(`${message.organizer}\n${message.uid}`);
  const operation = (actor, task) => {
    identity(actor);
    const previous = queues.get(actor.userId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const loaded = await readState(actor.userId);
      const state = loaded ? structuredClone(loaded) : { version: 1, invitations: {}, outbox: [] };
      if (state.version !== 1 || !state.invitations || !Array.isArray(state.outbox)) throw fail(503, 'invalid_scheduling_state', 'Invalid scheduling state');
      const result = await task(state);
      if (Buffer.byteLength(JSON.stringify(state)) > maxStateBytes) throw fail(507, 'scheduling_full', 'Scheduling state limit reached');
      await writeState(actor.userId, state);
      return structuredClone(result);
    });
    queues.set(actor.userId, next.catch(() => {}));
    return next;
  };
  function apply(state, message, senderAddresses, recipientAddresses, outbound) {
    const key = keyOf(message), existing = state.invitations[key];
    if (message.method === 'REPLY') {
      if (!senderAddresses.has(message.attendees[0].address) || (!outbound && !recipientAddresses.has(message.organizer))) throw fail(403, 'not_attendee', 'Only the replying attendee may send REPLY to the organizer');
      if (!existing || existing.cancelled || existing.sequence !== message.sequence
        || !existing.attendees.includes(message.attendees[0].address)) throw fail(409, 'stale_reply', 'Reply does not match an active invitation');
      const replyKey = `${message.attendees[0].address}:${message.digest}`;
      if (existing.replyDigests?.includes(replyKey)) return false;
      const previousReply = existing.replyStamps?.[message.attendees[0].address];
      if (previousReply && message.stamp <= previousReply) throw fail(409, 'stale_reply', 'Reply timestamp is stale or conflicts');
      existing.replyDigests = [...(existing.replyDigests || []), replyKey].slice(-100);
      existing.replyStamps = { ...existing.replyStamps, [message.attendees[0].address]: message.stamp };
      existing.responses = { ...existing.responses, [message.attendees[0].address]: message.attendees[0].partstat };
      return true;
    }
    if (!senderAddresses.has(message.organizer)) throw fail(403, 'not_organizer', 'Only the organizer may send REQUEST or CANCEL');
    if (!outbound && !message.attendees.some((a) => recipientAddresses.has(a.address))) throw fail(403, 'not_recipient', 'Local identity is not an invited attendee');
    if (existing) {
      if (existing.digest === message.digest) return false;
      if (message.sequence < existing.sequence || (message.sequence === existing.sequence && (message.method !== 'CANCEL' || existing.cancelled))) throw fail(409, 'stale_sequence', 'Scheduling revision is stale or conflicts');
    } else if (message.method === 'CANCEL') throw fail(409, 'invitation_missing', 'Cancellation requires an existing invitation');
    state.invitations[key] = { uid: message.uid, organizer: message.organizer, sequence: message.sequence,
      attendees: message.attendees.map((a) => a.address), cancelled: message.method === 'CANCEL', digest: message.digest,
      content: message.content, responses: {}, replyDigests: [], replyStamps: {}, receivedAt: now() };
    return true;
  }
  async function submit(actor, { content }) {
    const sender = identity(actor), message = parseSchedulingMessage(content);
    return operation(actor, async (state) => {
      const changed = apply(state, message, sender, sender, true);
      if (!changed) return { duplicate: true, ids: [] };
      const recipients = message.method === 'REPLY' ? [message.organizer] : message.attendees.map((a) => a.address);
      if (state.outbox.length + recipients.length > maxMessages) throw fail(507, 'outbox_full', 'Outbox limit reached');
      const ids = recipients.map((recipient) => {
        const id = hash(`${message.digest}\n${recipient}`);
        state.outbox.push({ id, recipient, sender: message.method === 'REPLY' ? message.attendees[0].address : message.organizer,
          content, status: 'pending', attempts: 0, nextAttemptAt: now(), lastError: null });
        return id;
      });
      return { duplicate: false, ids };
    });
  }
  async function receive(actor, { sender, content }) {
    const recipient = identity(actor), senderAddresses = identity(sender), message = parseSchedulingMessage(content);
    return operation(actor, async (state) => ({ duplicate: !apply(state, message, senderAddresses, recipient, false),
      invitation: structuredClone(state.invitations[keyOf(message)]) }));
  }
  const list = (actor) => operation(actor, async (state) => ({ invitations: Object.values(state.invitations), outbox: state.outbox }));
  // Delivery is invoked only by the authenticated adapter's explicit action.
  // Callback must support idempotencyKey: interruption gives at-least-once delivery.
  async function attempt(actor, id, deliver) {
    if (typeof deliver !== 'function') throw fail(503, 'delivery_unconfigured', 'No local delivery adapter configured');
    const claimed = await operation(actor, async (state) => {
      const item = state.outbox.find((entry) => entry.id === id);
      if (!item) throw fail(404, 'message_missing', 'Outbox message not found');
      if (item.status === 'delivered' || item.status === 'failed') return structuredClone(item);
      if (now() < item.nextAttemptAt) throw fail(409, 'retry_not_due', 'Retry backoff has not elapsed');
      if (item.attempts >= maxAttempts) { item.status = 'failed'; item.lastError = 'delivery_outcome_unknown'; return item; }
      item.attempts += 1;
      item.status = 'delivering';
      item.nextAttemptAt = now() + 300000;
      return item;
    });
    if (claimed.status === 'delivered' || claimed.status === 'failed') return claimed;
    let delivered = false;
    try { await deliver({ ...claimed, idempotencyKey: claimed.id }); delivered = true; } catch { /* durable retry below */ }
    return operation(actor, async (state) => {
      const item = state.outbox.find((entry) => entry.id === id);
      if (!item || item.attempts !== claimed.attempts || item.status !== 'delivering') return item;
      if (delivered) { item.status = 'delivered'; item.lastError = null; }
      else {
        item.status = item.attempts >= maxAttempts ? 'failed' : 'retry';
        item.lastError = 'local_delivery_failed';
        item.nextAttemptAt = now() + Math.min(3600000, 1000 * 2 ** (item.attempts - 1));
      }
      return structuredClone(item);
    });
  }
  const purge = (actor, ids) => operation(actor, async (state) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw fail(400, 'invalid_ids', 'Message IDs must be an array');
    const before = state.outbox.length;
    state.outbox = state.outbox.filter((item) => !ids.includes(item.id) || !['failed', 'delivered'].includes(item.status));
    return { removed: before - state.outbox.length };
  });
  return { submit, receive, list, attempt, purge };
}

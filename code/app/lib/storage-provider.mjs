// Explicit contracts and support services for the built-in calendar provider.
// This module contains no automatic repair and never executes external hooks.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { componentOf, componentsOf, eventFromIcs, taskFromIcs, uidOf } from './ical.mjs';

export const STORAGE_PROVIDER_VERSION = 1;
export const STORAGE_PROVIDER_METHODS = Object.freeze([
  'ensureRoot', 'ensureUser', 'listCalendars', 'calendarExists', 'readCalendarMeta',
  'createCalendar', 'listEvents', 'getEvent', 'putEvent', 'deleteEvent',
  'mutateEvent', 'snapshotEvents', 'ctag', 'syncToken', 'changesSince',
  'readUserData', 'writeUserData', 'deleteUserData', 'userPaths', 'calendarPaths',
]);

/** Validate the interface only; this does not claim durable or distributed locks. */
export function validateStorageProvider(store) {
  const missing = STORAGE_PROVIDER_METHODS.filter((method) => typeof store?.[method] !== 'function');
  const invalid = [];
  if (!Number.isSafeInteger(store?.maxObjectBytes) || store.maxObjectBytes < 1) invalid.push('maxObjectBytes');
  return { ok: missing.length === 0 && invalid.length === 0, version: STORAGE_PROVIDER_VERSION, missing, invalid };
}

export function assertStorageProvider(store) {
  const validation = validateStorageProvider(store);
  if (!validation.ok) {
    throw Object.assign(new Error(`Invalid calendar storage provider: ${[...validation.missing, ...validation.invalid].join(', ')}`),
      { code: 'INVALID_STORAGE_PROVIDER', validation });
  }
  return store;
}

/**
 * Provider-local content-addressed parse cache. A cache has exactly one parser;
 * parserVersion must change whenever its interpretation changes. Each caller
 * receives a clone, so editing a returned model cannot poison another request.
 * maxBytes bounds retained source/result estimates, not process RSS or parsing.
 */
export function createParsedObjectCache({ parser, parserVersion = 'ical-v1', maxEntries = 256,
  maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof parser !== 'function') throw new TypeError('parser must be a function');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('cache limits must be positive safe integers');
  }
  const entries = new Map();
  let bytes = 0, hits = 0, misses = 0;
  const discard = (key, entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
  };
  const trim = () => {
    while (entries.size > maxEntries || bytes > maxBytes) {
      const [key, entry] = entries.entries().next().value;
      discard(key, entry);
    }
  };
  async function parse(content, { version = parserVersion } = {}) {
    const text = String(content ?? '');
    const contentBytes = Buffer.byteLength(text);
    const key = `${String(version)}:${createHash('sha256').update(text).digest('hex')}`;
    const cached = entries.get(key);
    if (cached) {
      hits += 1;
      entries.delete(key); entries.set(key, cached);
      return structuredClone(await cached.promise);
    }
    misses += 1;
    if (contentBytes > maxBytes) return structuredClone(await parser(text));
    const entry = { bytes: contentBytes, pending: true, promise: null };
    entries.set(key, entry); bytes += entry.bytes;
    entry.promise = Promise.resolve().then(() => parser(text)).then((value) => {
      entry.pending = false;
      if (entries.get(key) === entry) {
        let resultBytes;
        try { resultBytes = Buffer.byteLength(JSON.stringify(value) ?? 'null'); }
        catch { discard(key, entry); return value; }
        bytes += Math.max(contentBytes, resultBytes) - entry.bytes;
        entry.bytes = Math.max(contentBytes, resultBytes);
        trim();
      }
      return value;
    }, (error) => { entry.pending = false; discard(key, entry); throw error; });
    trim();
    return structuredClone(await entry.promise);
  }
  return {
    parse,
    clear() { entries.clear(); bytes = 0; },
    stats() { return { entries: entries.size, bytes, hits, misses,
      inFlight: [...entries.values()].filter((entry) => entry.pending).length, maxEntries, maxBytes }; },
  };
}

const IDENTIFIER = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const ACTIONS = new Set(['create', 'update', 'delete', 'move', 'calendar-create', 'calendar-update', 'calendar-delete']);

/** Explicit subscribers only. Emit only after a successful storage commit. */
export function createStorageChangeHub() {
  const listeners = new Set();
  let listenerFailures = 0;
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function emit(change) {
    if (!ACTIONS.has(change?.action)) throw new TypeError('unknown storage change action');
    const event = { version: 1, action: change.action, at: new Date().toISOString() };
    for (const key of ['userId', 'calendarId', 'id', 'destinationCalendarId', 'destinationId', 'source']) {
      if (typeof change[key] === 'string' && IDENTIFIER.test(change[key])) event[key] = change[key];
    }
    if (typeof change.etag === 'string' && /^"?[a-f0-9]{64}"?$/i.test(change.etag)) event.etag = change.etag;
    if (Number.isSafeInteger(change.ctag) && change.ctag >= 0) event.ctag = change.ctag;
    Object.freeze(event);
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => { listenerFailures += 1; });
      } catch { listenerFailures += 1; }
    }
    return event;
  }
  return { subscribe, emit, stats: () => ({ subscribers: listeners.size, listenerFailures }) };
}

/**
 * Read-only verifier for the built-in file layout, not an arbitrary provider.
 * accounts accepts an account array or the normal store's .file. Raw file reads
 * intentionally avoid accounts.all()/readCalendarMeta(), which can migrate or
 * self-heal. Findings contain identifiers and codes only, never object bodies,
 * account hashes, secret material, titles, absolute paths or parser messages.
 * Run against stopped storage/snapshot for a consistent result.
 */
export async function verifyStorage({ store, accounts, maxIssues = 1000 } = {}) {
  if (typeof store?.root !== 'string') throw new TypeError('file-backed store.root is required');
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1) throw new TypeError('maxIssues must be a positive safe integer');
  const report = { ok: true, provider: 'file-store', readOnly: true, consistentSnapshot: false,
    users: 0, calendars: 0, objects: 0, issueCount: 0, issuesTruncated: false, issues: [], warnings: [] };
  const issue = (code, scope = {}) => {
    report.ok = false; report.issueCount += 1;
    if (report.issues.length < maxIssues) report.issues.push({ code, ...scope });
    else report.issuesTruncated = true;
  };
  let identities;
  if (Array.isArray(accounts)) identities = accounts;
  else if (typeof accounts?.file === 'string') {
    try {
      const value = JSON.parse(await fs.readFile(accounts.file, 'utf8'));
      if (!value || !Array.isArray(value.accounts)) throw new Error('invalid');
      identities = value.accounts;
    } catch { issue('accounts_unreadable'); return report; }
  } else throw new TypeError('accounts must be an account snapshot or expose a file path');

  const root = path.resolve(store.root);
  async function entries(directory, scope, missingCode) {
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { issue('unsafe_directory', scope); return null; }
      return await fs.readdir(directory, { withFileTypes: true });
    } catch { issue(missingCode, scope); return null; }
  }
  async function text(file, scope, missingCode) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) { issue('unsafe_file', scope); return null; }
      if (stat.size > Math.max(store.maxObjectBytes || 1024 * 1024, 8 * 1024 * 1024)) {
        issue('file_too_large', scope); return null;
      }
      return await fs.readFile(file, 'utf8');
    } catch { issue(missingCode, scope); return null; }
  }
  async function json(file, scope, missingCode, malformedCode) {
    const content = await text(file, scope, missingCode);
    if (content === null) return null;
    try {
      const value = JSON.parse(content);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      return value;
    } catch { issue(malformedCode, scope); return null; }
  }
  const rootEntries = await entries(root, {}, 'storage_missing');
  if (!rootEntries) return report;
  const movesEntry = rootEntries.find((entry) => entry.name === '.moves');
  if (movesEntry) {
    if (!movesEntry.isDirectory() || movesEntry.isSymbolicLink()) issue('unsafe_move_journal_directory');
    else {
      const journals = await entries(path.join(root, '.moves'), {}, 'move_journal_directory_unreadable');
      const count = journals?.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length || 0;
      if (count) report.warnings.push({ code: 'pending_move_recovery', count });
    }
  }
  const known = new Set();
  for (const account of identities) {
    const userId = account?.id;
    if (typeof userId !== 'string' || !IDENTIFIER.test(userId)) { issue('invalid_account_id'); continue; }
    if (known.has(userId)) { issue('duplicate_account_id', { userId }); continue; }
    known.add(userId); report.users += 1;
    const userScope = { userId };
    const calendars = await entries(path.join(root, userId), userScope, 'user_storage_missing');
    if (!calendars) continue;
    for (const directory of calendars) {
      if (directory.name.startsWith('.')) continue;
      if (!IDENTIFIER.test(directory.name)) { issue('invalid_calendar_entry', userScope); continue; }
      const scope = { userId, calendarId: directory.name };
      if (directory.isSymbolicLink()) { issue('unsafe_directory', scope); continue; }
      if (!directory.isDirectory()) continue;
      report.calendars += 1;
      const calendarRoot = path.join(root, userId, directory.name);
      const meta = await json(path.join(calendarRoot, 'meta.json'), scope, 'meta_missing', 'meta_invalid_json');
      const objectRoot = path.join(calendarRoot, 'objects');
      const objectEntries = await entries(objectRoot, scope, 'objects_directory_missing');
      if (!objectEntries) continue;
      const state = await json(path.join(objectRoot, '.state.json'), scope, 'state_missing', 'state_invalid_json');
      if (meta && (meta.id !== directory.name || typeof meta.displayName !== 'string'
        || typeof meta.color !== 'string' || !Number.isSafeInteger(meta.ctag) || meta.ctag < 0
        || typeof meta.syncUuid !== 'string' || !Array.isArray(meta.tombstones)
        || !['vevent', 'vtodo'].includes(meta.type || 'vevent'))) issue('meta_invalid', scope);
      const ctags = state?.ctags;
      const validCtags = ctags && typeof ctags === 'object' && !Array.isArray(ctags);
      if (state && (!validCtags || !Number.isSafeInteger(state.tombstoneFloor) || state.tombstoneFloor < 0)) {
        issue('state_invalid', scope);
      }
      const present = new Set();
      for (const object of objectEntries) {
        if (object.name.startsWith('.')) continue;
        if (!object.name.toLowerCase().endsWith('.ics')) { issue('unexpected_object_entry', scope); continue; }
        const id = object.name.slice(0, -4);
        if (!IDENTIFIER.test(id)) { issue('invalid_object_id', scope); continue; }
        const objectScope = { ...scope, id };
        if (object.isSymbolicLink() || !object.isFile()) { issue('unsafe_file', objectScope); continue; }
        present.add(id); report.objects += 1;
        const content = await text(path.join(objectRoot, object.name), objectScope, 'object_unreadable');
        if (content === null) continue;
        if (Buffer.byteLength(content) > (store.maxObjectBytes || 1024 * 1024)) issue('object_too_large', objectScope);
        const unfolded = content.replace(/\r?\n[ \t]/g, '');
        const component = componentOf(unfolded);
        // The model parsers deliberately tolerate broken ICS. Check balanced
        // component framing and required identity before using those parsers.
        const stack = [];
        let framingValid = true;
        for (const line of unfolded.split(/\r?\n/)) {
          const boundary = /^(BEGIN|END):([A-Z0-9-]+)\s*$/i.exec(line);
          if (!boundary) continue;
          if (boundary[1].toUpperCase() === 'BEGIN') stack.push(boundary[2].toUpperCase());
          else if (stack.pop() !== boundary[2].toUpperCase()) framingValid = false;
        }
        if (stack.length || !framingValid || !/^BEGIN:VCALENDAR\s*$/im.test(unfolded)
          || !/^END:VCALENDAR\s*$/im.test(unfolded) || !component || !uidOf(unfolded)) {
          issue('object_invalid_ical', objectScope);
        } else {
          if (componentsOf(unfolded).size > 1) issue('object_mixed_components', objectScope);
          if (meta && (meta.type === 'vtodo' ? component !== 'VTODO' : component !== 'VEVENT')) {
            issue('object_component_mismatch', objectScope);
          }
          try {
            if (component === 'VTODO') taskFromIcs(content);
            else await eventFromIcs(content);
          } catch { issue('object_parse_failed', objectScope); }
        }
        if (validCtags && (!Object.hasOwn(ctags, id) || !Number.isSafeInteger(ctags[id])
          || ctags[id] < 0 || (meta && ctags[id] > meta.ctag))) issue('object_state_mismatch', objectScope);
      }
      if (validCtags) for (const id of Object.keys(ctags)) {
        if (!IDENTIFIER.test(id)) { issue('invalid_state_object_id', scope); continue; }
        if (!present.has(id)) issue('state_object_missing', { ...scope, id });
      }
      if (meta && state && state.tombstoneFloor > meta.ctag) issue('tombstone_floor_ahead', scope);
    }
  }
  for (const entry of rootEntries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && IDENTIFIER.test(entry.name) && !known.has(entry.name)) {
      issue('orphan_user_storage', { userId: entry.name });
    }
  }
  return report;
}

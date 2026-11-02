// Shared user-event mutation rules. Authentication and AI authorization remain
// with their adapters; this module never grants access to a calendar.
import { checkEntityConditions } from '../dav/preconditions.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, davFailure: true });

export function assertCalendarObject(content, { type, maxObjectBytes = 1024 * 1024 } = {}) {
  const text = String(content);
  if (Buffer.byteLength(text) > maxObjectBytes) throw fail(413, 'too_large', 'calendar object too large');
  const stack = [];
  let roots = 0, kind = '', uid = null, componentUid = '', count = 0;
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line);
    if (boundary) {
      const name = boundary[2].toUpperCase();
      if (boundary[1].toUpperCase() === 'BEGIN') {
        if (!stack.length) { roots += 1; if (name !== 'VCALENDAR') throw fail(403, 'invalid_ical', 'VCALENDAR required'); }
        if (['VEVENT', 'VTODO'].includes(name)) {
          if (stack.length !== 1 || stack[0] !== 'VCALENDAR' || (kind && kind !== name)) throw fail(403, 'invalid_ical', 'mixed calendar components');
          kind = name; componentUid = ''; count += 1;
        }
        stack.push(name);
      } else {
        if (stack.pop() !== name) throw fail(403, 'invalid_ical', 'unbalanced calendar component');
        if (['VEVENT', 'VTODO'].includes(name)) {
          if (!componentUid || (uid !== null && uid !== componentUid)) throw fail(403, 'invalid_ical', 'one UID required per calendar object');
          uid = componentUid;
        }
      }
    } else if (stack.length === 2 && /^UID:/i.test(line)) {
      if (componentUid) throw fail(403, 'invalid_ical', 'duplicate UID property');
      componentUid = line.slice(4).trim();
    }
  }
  if (stack.length || roots !== 1 || !count) throw fail(403, 'invalid_ical', 'invalid calendar object');
  if (type && (type === 'vtodo' ? kind !== 'VTODO' : kind !== 'VEVENT')) throw fail(403, 'component_not_supported', 'unsupported calendar component');
  return { content: text, component: kind, uid };
}

export function mutateCalendarObject({ store, calendarId, file, headers = {}, before, transform, type }) {
  return store.mutateEvent(calendarId, file, async (current) => {
    if (before) await before(current);
    const condition = checkEntityConditions(headers, current);
    if (condition) throw fail(condition.status, 'conflict', condition.reason);
    const result = await transform(current);
    if (!result.delete) assertCalendarObject(result.content, { type, maxObjectBytes: store.maxObjectBytes });
    return result;
  });
}

// Property names serialized by the JSON event model. Everything else remains
// opaque source data when an adapter edits known fields.
const MANAGED = new Set(['UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'DTSTART', 'DTEND', 'DURATION',
  'SUMMARY', 'DESCRIPTION', 'LOCATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'STATUS', 'TRANSP',
  'CATEGORIES', 'COLOR', 'X-APPLE-CALENDAR-COLOR', 'X-FNCAL-CREATED-BY', 'X-FNCAL-CREATED-BY-UID',
  'X-FNCAL-CREATED-BY-NAME', 'X-FNCAL-CREATED-BY-DISPLAY', 'X-FNCAL-LUNAR',
  'X-FNCAL-LUNAR-DATE', 'X-FNCAL-LUNAR-LEAP', 'X-FNCAL-LUNAR-RULE']);

function componentProperties(text) {
  const result = [];
  const lines = String(text).split(/\r?\n/);
  let depth = 0, item = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^BEGIN:/i.test(line)) {
      depth += 1;
      if (/^BEGIN:VEVENT$/i.test(line) && depth === 2) item = { start: i, end: 0, key: 'master', properties: [] };
    } else if (/^END:/i.test(line)) {
      if (item && depth === 2 && /^END:VEVENT$/i.test(line)) { item.end = i; result.push(item); item = null; }
      depth -= 1;
    } else if (item && depth === 2 && line && !/^[ \t]/.test(line)) {
      let raw = line;
      while (/^[ \t]/.test(lines[i + 1] || '')) raw += '\r\n' + lines[++i];
      const name = /^([^;:]+)[;:]/.exec(line)?.[1]?.toUpperCase();
      if (name === 'RECURRENCE-ID') item.key = raw.replace(/\r?\n[ \t]/g, '');
      if (name && !MANAGED.has(name)) item.properties.push({ name, raw });
    }
  }
  return { lines, components: result };
}

export function preserveUnmodeledProperties(previous, generated) {
  if (!previous) return generated;
  // The JSON model cannot represent arbitrary component trees. Refuse that
  // edit instead of silently deleting an opaque vendor component.
  const supported = new Set(['VCALENDAR', 'VEVENT', 'VALARM', 'VTIMEZONE', 'STANDARD', 'DAYLIGHT']);
  for (const match of String(previous).matchAll(/^BEGIN:([^\r\n]+)$/gim)) {
    if (!supported.has(match[1].toUpperCase())) throw fail(409, 'unsupported_ical_edit', 'JSON editing cannot preserve this calendar component');
  }
  const old = componentProperties(previous), next = componentProperties(generated);
  for (const component of next.components.slice().reverse()) {
    const source = old.components.find((candidate) => candidate.key === component.key);
    if (!source) continue;
    const existing = new Set(component.properties.map((p) => p.raw));
    const retained = source.properties.filter((p) => !existing.has(p.raw)).map((p) => p.raw);
    if (retained.length) next.lines.splice(component.end, 0, ...retained);
  }
  return next.lines.join('\r\n');
}

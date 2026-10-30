// User event application service. HTTP auth stays in the adapters; account
// isolation comes from request-context. AI keeps its separate policy service.
import { randomUUID } from 'node:crypto';
import { eventFromIcs, eventToIcs } from './ical.mjs';
import { currentContext } from './request-context.mjs';
import { createParsedObjectCache } from './storage-provider.mjs';

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const FIELDS = new Set(['title', 'start', 'end', 'allDay', 'location', 'description',
  'timezone', 'endTimezone', 'startDate', 'endDate', 'recurrence', 'exdates',
  'overrides', 'reminders', 'alarms', 'categories', 'status', 'transp', 'color']);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function inheritedExtras(previous, value) {
  if (!previous) return {};
  const out = {};
  if (value.timezone === undefined && previous.timezone !== undefined) {
    for (const key of ['timezone', 'endTimezone', 'startWall', 'endWall']) {
      if (previous[key] !== undefined) out[key] = previous[key];
    }
  }
  for (const key of ['status', 'transp', 'createdBy']) {
    if (value[key] === undefined && previous[key] !== undefined) out[key] = previous[key];
  }
  if (value.categories === undefined && previous.categories?.length) out.categories = previous.categories;
  if (value.lunar !== false) {
    for (const key of ['lunar', 'lunarMonth', 'lunarDay', 'lunarLeap', 'lunarRule']) {
      if (value[key] === undefined && previous[key] !== undefined) out[key] = previous[key];
    }
  }
  return out;
}

export function createEventService({ store }) {
  const parsedObjects = createParsedObjectCache({ parser: eventFromIcs });
  function identifiers(calendarId, id) {
    if (!ID.test(calendarId) || (id !== undefined && !ID.test(id))) {
      throw fail(400, 'invalid_id', '日历或事件标识无效');
    }
  }
  async function calendar(calendarId, legacy = false) {
    identifiers(calendarId);
    if (!(await store.calendarExists(calendarId))) {
      throw fail(legacy ? 400 : 404, 'calendar_not_found', '日历不存在');
    }
    if ((await store.readCalendarMeta(calendarId))?.type === 'vtodo') {
      throw fail(409, 'calendar_type_mismatch', '该日历不是事件日历');
    }
  }
  async function project(object, calendarId, id) {
    if (!object || /BEGIN:VTODO/.test(object.content)) return null;
    return { event: { ...await parsedObjects.parse(object.content), id, calendarId }, etag: `"${object.etag}"` };
  }
  function encode(value, previous, id, preserveUid) {
    const ctx = currentContext();
    const extras = inheritedExtras(previous, value);
    const createdBy = extras.createdBy || (value.createdBy?.uid ? value.createdBy : null) || (ctx?.userId
      ? { uid: ctx.userId, username: ctx.username || '', displayName: ctx.displayName || ctx.username || '' }
      : null);
    return eventToIcs({ ...extras, ...value, calendarId: undefined, createdBy, id,
      uid: preserveUid ? previous?.uid : undefined });
  }
  function validate(value, patch = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid_event', '需要事件 JSON 对象');
    for (const key of Object.keys(value)) {
      if (!FIELDS.has(key)) throw fail(400, 'invalid_field', `不支持的事件字段：${key}`);
    }
    if ((!patch || value.title !== undefined) && (typeof value.title !== 'string' || !value.title.trim())) {
      throw fail(400, 'invalid_event', '事件标题不能为空');
    }
    for (const key of ['start', 'end']) {
      if ((!patch || value[key] !== undefined) && (typeof value[key] !== 'number' || !Number.isFinite(value[key])
        || !Number.isFinite(new Date(value[key]).getTime()))) throw fail(400, 'invalid_event', '时间须为有效毫秒时间戳');
    }
    for (const key of ['location', 'description', 'timezone', 'endTimezone', 'startDate', 'endDate', 'status', 'transp', 'color']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw fail(400, 'invalid_event', `${key} 须为字符串`);
    }
    if (value.allDay !== undefined && typeof value.allDay !== 'boolean') throw fail(400, 'invalid_event', 'allDay 须为布尔值');
    for (const key of ['exdates', 'reminders', 'alarms', 'categories']) {
      if (value[key] !== undefined && !Array.isArray(value[key])) throw fail(400, 'invalid_event', `${key} 须为数组`);
    }
    for (const key of ['recurrence', 'overrides']) {
      if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'object' || Array.isArray(value[key]))) {
        throw fail(400, 'invalid_event', `${key} 须为对象或 null`);
      }
    }
  }
  async function get(calendarId, id) {
    identifiers(calendarId, id);
    await calendar(calendarId);
    const result = await project(await store.getEvent(calendarId, `${id}.ics`), calendarId, id);
    if (!result) throw fail(404, 'event_not_found', '事件不存在');
    return result;
  }
  async function list(calendarId) {
    await calendar(calendarId);
    const items = [];
    for (const object of await store.listEvents(calendarId)) {
      const item = await project(object, calendarId, object.file.replace(/\.ics$/i, ''));
      if (item) items.push(item);
    }
    return items.sort((a, b) => a.event.id.localeCompare(b.event.id));
  }
  // Legacy KV upsert preserves its permissive model and return shape.
  async function putLegacy(calendarId, id, value) {
    identifiers(calendarId, id);
    await calendar(calendarId, true);
    if (!Number.isFinite(Number(value.start)) || !Number.isFinite(Number(value.end))) {
      throw fail(400, 'invalid_value', 'event requires numeric start/end');
    }
    const current = await store.getEvent(calendarId, `${id}.ics`);
    let previous = null;
    try { if (current) previous = await parsedObjects.parse(current.content); } catch { /* legacy tolerance */ }
    const result = await store.putEvent(calendarId, `${id}.ics`, encode(value, previous, id, false));
    return { etag: result.etag, created: result.created, calendarId };
  }
  async function mutate(calendarId, id, value, { create = false, remove = false, ifMatch } = {}) {
    identifiers(calendarId, id);
    await calendar(calendarId);
    if (!create && !ifMatch) throw fail(428, 'precondition_required', '修改或删除事件需要 If-Match');
    if (!remove) validate(value, !create);
    const result = await store.mutateEvent(calendarId, `${id}.ics`, async (current) => {
      if (create && current) throw fail(409, 'event_exists', '事件已存在');
      if (!create && (!current || /BEGIN:VTODO/.test(current.content))) throw fail(404, 'event_not_found', '事件不存在');
      if (!create && ifMatch !== `"${current.etag}"`) throw fail(412, 'conflict', '事件已被修改，请重新读取后再试');
      if (remove) return { delete: true };
      const previous = current ? await parsedObjects.parse(current.content) : null;
      const next = { ...previous, ...value, updatedAt: Date.now() };
      if (next.end < next.start || (!next.allDay && next.end === next.start)) {
        throw fail(400, 'invalid_event', '事件起止时间无效');
      }
      // Parsed wall-clock hints describe the old instant; recompute on time/zone edits.
      if (['start', 'end', 'timezone', 'endTimezone'].some((key) => value[key] !== undefined)) {
        delete next.startWall; delete next.endWall;
        if (value.startDate === undefined) delete next.startDate;
        if (value.endDate === undefined) delete next.endDate;
      }
      if (value.recurrence !== undefined) delete next.rruleRaw;
      if (value.reminders !== undefined && value.alarms === undefined) next.alarms = [];
      return { content: encode(next, previous, id, true) };
    });
    if (result.missingCalendar) throw fail(404, 'calendar_not_found', '日历不存在');
    return remove ? { deleted: result.deleted } : project(result, calendarId, id);
  }
  return { get, list, putLegacy,
    create: (calendarId, value) => mutate(calendarId, randomUUID(), value, { create: true }),
    patch: (calendarId, id, value, ifMatch) => mutate(calendarId, id, value, { ifMatch }),
    remove: (calendarId, id, ifMatch) => mutate(calendarId, id, null, { remove: true, ifMatch }),
  };
}

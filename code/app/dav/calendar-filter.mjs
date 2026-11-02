// RFC 4791 sections 9.7-9.9: https://www.rfc-editor.org/rfc/rfc4791#section-9.7
// Compile the supported filter subset once per REPORT, before reading objects.
// Unsupported predicates fail closed instead of silently broadening a query.
import { matchesTimeRange } from '../lib/ical.mjs';

const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const TOKEN = /^[A-Za-z0-9-]+$/;
const failure = (message, status = 400, davError) => Object.assign(new Error(message), { status, davError });
const unsupported = (message) => failure(message, 403, 'supported-filter');
const children = (node, local) => node.children.filter((c) => c.namespaceURI === CALDAV && c.local === local);
const asciiFold = (value) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

function shape(node, allowedChildren = [], allowedAttrs = [], allowText = false) {
  if (node.namespaceURI !== CALDAV) throw unsupported('filter element has an unsupported namespace');
  if (!allowText && node.text.trim()) throw failure(`${node.local} must not contain character data`);
  for (const name of Object.keys(node.attrs)) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (!allowedAttrs.includes(name)) throw unsupported(`unsupported ${node.local} attribute: ${name}`);
  }
  for (const child of node.children) {
    if (child.namespaceURI !== CALDAV || !allowedChildren.includes(child.local)) {
      throw unsupported(`unsupported ${node.local} child: ${child.name}`);
    }
  }
}

function named(node) {
  if (!TOKEN.test(node.attrs.name || '')) throw failure(`${node.local} needs a valid name`);
  return node.attrs.name.toUpperCase();
}

function absent(node) {
  const nodes = children(node, 'is-not-defined');
  if (!nodes.length) return false;
  if (nodes.length !== 1 || node.children.length !== 1) throw failure('is-not-defined must be the only child');
  shape(nodes[0]);
  return true;
}

function compileText(node) {
  shape(node, [], ['collation', 'negate-condition'], true);
  const collation = node.attrs.collation ?? 'i;ascii-casemap';
  if (!['i;ascii-casemap', 'i;octet'].includes(collation)) {
    throw failure(`unsupported text-match collation: ${collation}`, 403, 'supported-collation');
  }
  const negate = node.attrs['negate-condition'] ?? 'no';
  if (!['yes', 'no'].includes(negate)) throw failure('negate-condition must be yes or no');
  const normalize = collation === 'i;ascii-casemap' ? asciiFold : (value) => value;
  const needle = normalize(node.text);
  return (value) => normalize(value).includes(needle) !== (negate === 'yes');
}

function compileParam(node) {
  shape(node, ['is-not-defined', 'text-match'], ['name']);
  const name = named(node);
  if (absent(node)) return (prop) => !prop.params.has(name);
  if (node.children.length > 1) throw failure('param-filter accepts at most one text-match');
  const match = node.children.length ? compileText(node.children[0]) : () => true;
  return (prop) => prop.params.has(name) && prop.params.get(name).some(match);
}

function compileProp(node) {
  shape(node, ['is-not-defined', 'text-match', 'time-range', 'param-filter'], ['name']);
  const name = named(node);
  if (absent(node)) return (component) => !component.properties.some((p) => p.name === name);
  if (children(node, 'time-range').length) throw unsupported('property time-range filtering is not supported');
  const textNodes = children(node, 'text-match');
  if (textNodes.length > 1) throw failure('prop-filter accepts at most one text-match');
  const match = textNodes.length ? compileText(textNodes[0]) : () => true;
  const params = children(node, 'param-filter').map(compileParam);
  // A property's text and every parameter predicate must match that same
  // property instance, never different ATTENDEE lines in the resource.
  return (component) => component.properties.some((p) => p.name === name && match(p.value) && params.every((test) => test(p)));
}

function utcDate(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value)) throw failure('time-range must use UTC iCalendar date-times');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const hour = Number(value.slice(9, 11)), minute = Number(value.slice(11, 13)), second = Number(value.slice(13, 15));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw failure('time-range contains an invalid date-time');
  }
  return date.getTime();
}

function compileRange(node) {
  shape(node, [], ['start', 'end']);
  if (!Object.hasOwn(node.attrs, 'start') && !Object.hasOwn(node.attrs, 'end')) throw failure('time-range needs at least one bound');
  const start = Object.hasOwn(node.attrs, 'start') ? utcDate(node.attrs.start) : undefined;
  const end = Object.hasOwn(node.attrs, 'end') ? utcDate(node.attrs.end) : undefined;
  if (start !== undefined && end !== undefined && end <= start) throw failure('time-range end must follow start');
  return { start, end };
}

function compileComponent(node, parentName = null, depth = 0) {
  if (depth > 8) throw unsupported('component filter nesting is too deep');
  shape(node, ['is-not-defined', 'time-range', 'prop-filter', 'comp-filter'], ['name']);
  const name = named(node);
  if ((!parentName && name !== 'VCALENDAR') || (parentName && (parentName !== 'VCALENDAR' || !['VEVENT', 'VTODO'].includes(name)))) {
    throw unsupported('only VCALENDAR with direct VEVENT or VTODO filters is supported');
  }
  if (absent(node)) return async (scope) => !scope.children.some((component) => component.name === name);
  const ranges = children(node, 'time-range');
  if (ranges.length > 1) throw failure('comp-filter accepts at most one time-range');
  if (ranges.length && !['VEVENT', 'VTODO'].includes(name)) throw unsupported('time-range requires a VEVENT or VTODO component');
  const range = ranges.length ? compileRange(ranges[0]) : null;
  const props = children(node, 'prop-filter').map(compileProp);
  const nested = children(node, 'comp-filter').map((child) => compileComponent(child, name, depth + 1));
  return async (scope) => {
    const candidates = scope.children.filter((component) => component.name === name);
    if (!candidates.length) return false;
    if (props.length && candidates.length > 1) {
      throw unsupported('combined time/property filtering of multiple component instances is not supported');
    }
    if (range && (range.start === undefined || range.end === undefined)
      && candidates.some((c) => c.properties.some((p) => ['RRULE', 'RDATE'].includes(p.name)))) {
      throw unsupported('recurring time-range queries require both UTC bounds');
    }
    if (range && name === 'VTODO' && candidates.some((c) => c.properties.some((p) => ['RRULE', 'RDATE', 'RECURRENCE-ID'].includes(p.name)))) {
      throw unsupported('time-range filtering of recurring VTODO is not supported');
    }
    // Time-only recurrence predicates must see the whole series, including all
    // exceptions/overrides. Restrict the serialized resource to this component
    // type so VTODO and VEVENT matches cannot satisfy each other's conditions.
    if (range) {
      let inRange = false;
      const series = name === 'VTODO' ? candidates.map((component) => seriesContent({ children: [component] }, name))
        : [seriesContent(scope, name)];
      for (const content of series) if (await matchesTimeRange(content, range)) { inRange = true; break; }
      if (!inRange) return false;
    }
    for (const candidate of candidates) {
      if (!props.every((test) => test(candidate))) continue;
      let accepted = true;
      for (const test of nested) if (!(await test(candidate))) { accepted = false; break; }
      if (accepted) return true;
    }
    return false;
  };
}

// Split separators outside quoted parameter strings. Colons/semicolons in CN
// and other quoted parameters are data, not content-line syntax.
function splitOutside(value, delimiter, first = false) {
  let quoted = false, start = 0;
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === delimiter) {
      values.push(value.slice(start, index));
      start = index + 1;
      if (first) return [values[0], value.slice(start)];
    }
  }
  values.push(value.slice(start));
  return values;
}

const unescapeText = (value) => value.replace(/\\([nN,;\\])/g, (_, escaped) => /[nN]/.test(escaped) ? '\n' : escaped);
const unescapeParam = (value) => value.replace(/^"([\s\S]*)"$/, '$1').replace(/\^([nN'^])/g,
  (_, escaped) => /[nN]/.test(escaped) ? '\n' : escaped === "'" ? '"' : '^');

function parseContent(content) {
  const root = { name: '#document', children: [], properties: [] };
  const stack = [root];
  const lines = String(content).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const [head, value] = splitOutside(line, ':', true);
    if (value === undefined) continue;
    const tokens = splitOutside(head, ';');
    const name = tokens.shift().toUpperCase();
    if (name === 'BEGIN') {
      if (stack.length > 32) return null;
      const component = { name: value.toUpperCase(), children: [], properties: [], lines: [line] };
      stack.at(-1).children.push(component);
      stack.push(component);
    } else if (name === 'END') {
      if (stack.length < 2 || stack.at(-1).name !== value.toUpperCase()) return null;
      const closed = stack.pop();
      closed.lines.push(line);
      if (stack.length > 1) stack.at(-1).lines.push(...closed.lines);
    } else if (stack.length > 1) {
      const params = new Map();
      for (const token of tokens) {
        const [key, values] = splitOutside(token, '=', true);
        if (values !== undefined) params.set(key.toUpperCase(), [
          ...(params.get(key.toUpperCase()) || []), ...splitOutside(values, ',').map(unescapeParam),
        ]);
      }
      const nonText = new Set(['ATTENDEE', 'ORGANIZER', 'URL', 'TZURL', 'SOURCE', 'ATTACH']);
      const type = params.get('VALUE')?.[0]?.toUpperCase();
      stack.at(-1).properties.push({ name,
        value: type === 'TEXT' || (!type && !nonText.has(name)) ? unescapeText(value) : value, params });
      stack.at(-1).lines.push(line);
    }
  }
  return stack.length === 1 ? root : null;
}

function seriesContent(scope, name) {
  const components = scope.children.filter((component) => component.name === name || component.name === 'VTIMEZONE');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...components.flatMap((component) => component.lines), 'END:VCALENDAR', ''].join('\r\n');
}

export function compileCalendarFilter(doc) {
  const report = doc.local === '#document' ? doc.children[0] : doc;
  if (!report) return async () => true;
  const filters = report.local === 'filter' ? [report] : report.children.filter((node) => node.local === 'filter');
  if (!filters.length) return async () => true;
  if (filters.length !== 1) throw failure('calendar-query accepts at most one filter');
  const filter = filters[0];
  shape(filter, ['comp-filter']);
  // Preserve the server's historical empty-filter compatibility.
  if (!filter.children.length) return async () => true;
  if (filter.children.length !== 1) throw failure('filter accepts one VCALENDAR comp-filter');
  const predicate = compileComponent(filter.children[0]);
  const compiled = async (content) => {
    const tree = parseContent(content);
    return tree ? predicate(tree) : false;
  };
  const components = children(filter.children[0], 'comp-filter');
  if (components.length === 1 && !children(components[0], 'is-not-defined').length) {
    const ranges = children(components[0], 'time-range');
    compiled.candidates = { component: components[0].attrs.name.toUpperCase(),
      ...(ranges.length ? { range: compileRange(ranges[0]) } : {}) };
  }
  return compiled;
}

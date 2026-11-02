import { escapeXml, parseXml } from '../lib/xml.mjs';

export const NS = Object.freeze({ DAV: 'DAV:', CAL: 'urn:ietf:params:xml:ns:caldav',
  CARD: 'urn:ietf:params:xml:ns:carddav', CS: 'http://calendarserver.org/ns/', IC: 'http://apple.com/ns/ical/' });

export function protocolError(status, message, davError, errorNamespace = NS.DAV) {
  return Object.assign(new Error(message), { status, davFailure: true, davError, errorNamespace });
}

const CAL_PROPERTIES = new Set(['calendar-home-set', 'calendar-user-address-set', 'supported-calendar-component-set',
  'calendar-description', 'calendar-data', 'supported-calendar-data', 'supported-collation-set']);
const CARD_PROPERTIES = new Set(['addressbook-home-set', 'addressbook-description', 'supported-address-data', 'address-data']);
export function propertyNamespace(local, carddav = false) {
  if (CAL_PROPERTIES.has(local)) return NS.CAL;
  if (CARD_PROPERTIES.has(local)) return NS.CARD;
  if (local === 'max-resource-size') return carddav ? NS.CARD : NS.CAL;
  if (local === 'getctag') return NS.CS;
  if (local === 'calendar-color') return NS.IC;
  return NS.DAV;
}

export function propertyKey(node, carddav = false) {
  return node.namespaceURI === propertyNamespace(node.local, carddav) ? node.local
    : { local: node.local, namespaceURI: node.namespaceURI };
}

export function propertyElement(key, carddav = false) {
  const local = typeof key === 'string' ? key : key.local;
  const namespace = typeof key === 'string' ? propertyNamespace(key, carddav) : key.namespaceURI;
  return namespace ? `<Q:${local} xmlns:Q="${escapeXml(namespace)}"/>` : `<${local} xmlns=""/>`;
}

export const direct = (node, local, namespace) => node.children.filter((child) => child.local === local && child.namespaceURI === namespace);

export function utcRange(node, { requiredBoth = false } = {}) {
  const values = {};
  for (const key of ['start', 'end']) {
    const value = node.attrs[key];
    if (value === undefined && !requiredBoth) continue;
    if (!/^\d{8}T\d{6}Z$/.test(value || '')) throw protocolError(400, 'time range requires UTC date-times');
    const formatted = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    const time = Date.parse(formatted);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== formatted.slice(0, 19)) {
      throw protocolError(400, 'invalid time range date');
    }
    values[key] = time;
  }
  if (!Object.keys(values).length || (values.start !== undefined && values.end !== undefined && values.end <= values.start)) {
    throw protocolError(400, 'invalid time range bounds');
  }
  return values;
}

function validateCalendarData(node) {
  if (node.namespaceURI !== NS.CAL || node.local !== 'calendar-data') return;
  const fail = () => { throw protocolError(403, 'unsupported calendar-data projection or format', 'supported-calendar-data', NS.CAL); };
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    if (!((key === 'content-type' && value === 'text/calendar') || (key === 'version' && value === '2.0'))) fail();
  }
  if (node.children.length > 1) fail();
  for (const child of node.children) {
    if (child.namespaceURI !== NS.CAL || child.local !== 'expand' || child.children.length || child.text.trim()) fail();
    if (Object.keys(child.attrs).some((key) => !['start', 'end', 'xmlns'].includes(key) && !key.startsWith('xmlns:'))) fail();
    utcRange(child, { requiredBoth: true });
  }
}

// Validate request envelopes before interpreting any local names. Namespace
// prefixes are aliases; only expanded names select DAV operations/properties.
export function parseDavRequest(body, method, { carddav = false } = {}) {
  const doc = parseXml(body);
  const root = doc.children[0];
  if (!root) {
    if (['PROPFIND', 'MKCALENDAR'].includes(method)) return doc;
    throw protocolError(400, 'XML request body required');
  }
  const reports = carddav ? { 'addressbook-query': NS.CARD, 'addressbook-multiget': NS.CARD, 'sync-collection': NS.DAV }
    : { 'calendar-query': NS.CAL, 'calendar-multiget': NS.CAL, 'free-busy-query': NS.CAL, 'sync-collection': NS.DAV };
  const expected = { PROPFIND: ['propfind', NS.DAV], PROPPATCH: ['propertyupdate', NS.DAV],
    MKCALENDAR: ['mkcalendar', NS.CAL], MKCOL: ['mkcol', NS.DAV] }[method];
  if (method === 'REPORT') {
    if (!reports[root.local] || root.namespaceURI !== reports[root.local]) {
      throw protocolError(403, 'unsupported REPORT expanded name', 'supported-report');
    }
  } else if (expected && (root.local !== expected[0] || root.namespaceURI !== expected[1])) {
    throw protocolError(400, `invalid ${method} XML root`);
  }
  if (!['PROPFIND', 'REPORT'].includes(method)) return doc;
  const vocabulary = method === 'PROPFIND' ? { prop: NS.DAV, propname: NS.DAV, allprop: NS.DAV, include: NS.DAV }
    : root.local === 'sync-collection' ? { prop: NS.DAV, 'sync-token': NS.DAV, 'sync-level': NS.DAV, limit: NS.DAV }
      : root.local === 'free-busy-query' ? { 'time-range': NS.CAL }
        : { prop: NS.DAV, allprop: NS.DAV, propname: NS.DAV,
          ...(root.local.endsWith('-multiget') ? { href: NS.DAV } : { filter: carddav ? NS.CARD : NS.CAL }) };
  const seen = new Set();
  if (root.text.trim()) throw protocolError(400, 'unexpected request character data');
  for (const child of root.children) {
    if (vocabulary[child.local] !== child.namespaceURI) {
      throw protocolError(method === 'REPORT' ? 403 : 400, 'unsupported XML request element',
        method === 'REPORT' ? 'supported-filter' : undefined, carddav ? NS.CARD : NS.CAL);
    }
    if (child.local !== 'href' && seen.has(child.local)) throw protocolError(400, 'duplicate XML request element');
    seen.add(child.local);
    if (method === 'REPORT' && child.local === 'prop' && !carddav) {
      for (const property of child.children) validateCalendarData(property);
    }
    if (['allprop', 'propname', 'href', 'sync-token', 'sync-level', 'time-range'].includes(child.local) && child.children.length) {
      throw protocolError(400, 'unexpected nested XML request element');
    }
    if (child.local === 'limit') {
      const count = direct(child, 'nresults', NS.DAV);
      if (child.children.length !== 1 || count.length !== 1 || count[0].children.length
        || !/^[1-9]\d{0,3}$/.test(count[0].text.trim()) || Number(count[0].text.trim()) > 1000) {
        throw protocolError(400, 'sync limit must contain nresults in 1..1000');
      }
    }
    if (carddav && child.local === 'filter') {
      const visit = (node) => {
        if (node.namespaceURI !== NS.CARD) throw protocolError(403, 'unsupported filter namespace', 'supported-filter', NS.CARD);
        for (const nested of node.children) visit(nested);
      };
      visit(child);
    }
  }
  if (['prop', 'allprop', 'propname'].filter((name) => seen.has(name)).length > 1
    || (seen.has('include') && !seen.has('allprop'))) throw protocolError(400, 'conflicting property selectors');
  return doc;
}

export function requestedPropertyKeys(doc, defaults, carddav = false) {
  const root = doc.children[0];
  if (!root) return defaults;
  const prop = direct(root, 'prop', NS.DAV)[0];
  if (prop) return prop.children.map((node) => propertyKey(node, carddav));
  const include = direct(root, 'include', NS.DAV)[0];
  return include ? [...(defaults || []), ...include.children.map((node) => propertyKey(node, carddav))] : defaults;
}

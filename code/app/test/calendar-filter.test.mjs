import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCalendarFilter } from '../dav/calendar-filter.mjs';
import { parseXml } from '../lib/xml.mjs';

const ns = 'urn:ietf:params:xml:ns:caldav';
const query = (body = '', component = 'VEVENT') => parseXml(`<C:calendar-query xmlns:C="${ns}"><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${component}">${body}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`);
const calendar = (lines, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\n${lines}\r\nEND:VEVENT\r\n${extra}END:VCALENDAR\r\n`;
const matches = async (filter, content) => compileCalendarFilter(query(filter))(content);

test('component and property predicates respect scope, absence and AND semantics', async () => {
  const source = calendar('SUMMARY:Planning\r\nSTATUS:CONFIRMED\r\nBEGIN:VALARM\r\nDESCRIPTION:Secret alarm\r\nEND:VALARM');
  assert.equal(await matches('<C:prop-filter name="SUMMARY"/>', source), true);
  assert.equal(await matches('<C:prop-filter name="DESCRIPTION"/>', source), false);
  assert.equal(await matches('<C:prop-filter name="DESCRIPTION"><C:is-not-defined/></C:prop-filter>', source), true);
  assert.equal(await matches('<C:prop-filter name="SUMMARY"/><C:prop-filter name="LOCATION"/>', source), false);
  assert.equal(await compileCalendarFilter(query('', 'VTODO'))(source), false);
  assert.equal(await compileCalendarFilter(query('<C:is-not-defined/>', 'VTODO'))(source), true);
  assert.equal(await compileCalendarFilter(parseXml(`<filter xmlns="${ns}"/>`))(source), true);
});

test('text matching preserves spaces, unfolds content, decodes TEXT, and folds ASCII only', async () => {
  const source = calendar('SUMMARY:Team\\,  Planning\\nRoom\\;B\\\\\r\nDESCRIPTION:Ma\r\n tch Ä');
  assert.equal(await matches(String.raw`<C:prop-filter name="SUMMARY"><C:text-match>team,  planning&#10;room;b\</C:text-match></C:prop-filter>`, source), true);
  assert.equal(await matches('<C:prop-filter name="SUMMARY"><C:text-match collation="i;octet">team</C:text-match></C:prop-filter>', source), false);
  assert.equal(await matches('<C:prop-filter name="SUMMARY"><C:text-match negate-condition="yes">cancelled</C:text-match></C:prop-filter>', source), true);
  assert.equal(await matches('<C:prop-filter name="DESCRIPTION"><C:text-match>Match Ä</C:text-match></C:prop-filter>', source), true);
  assert.equal(await matches('<C:prop-filter name="DESCRIPTION"><C:text-match>match ä</C:text-match></C:prop-filter>', source), false);
});

test('parameter predicates and property values must match the same ATTENDEE', async () => {
  const source = calendar('ATTENDEE;CN="Other; Name: Room";PARTSTAT=ACCEPTED:mailto:other@example.test\r\nATTENDEE;CN="Alice, A";PARTSTAT=DECLINED:mailto:alice@example.test');
  const attendee = (value, param) => `<C:prop-filter name="ATTENDEE"><C:text-match>${value}</C:text-match>${param}</C:prop-filter>`;
  assert.equal(await matches(attendee('alice', '<C:param-filter name="PARTSTAT"><C:text-match>ACCEPTED</C:text-match></C:param-filter>'), source), false);
  assert.equal(await matches(attendee('alice', '<C:param-filter name="PARTSTAT"><C:text-match>DECLINED</C:text-match></C:param-filter>'), source), true);
  assert.equal(await matches(attendee('alice', '<C:param-filter name="CN"><C:text-match>Alice, A</C:text-match></C:param-filter>'), source), true);
  assert.equal(await matches(attendee('other', '<C:param-filter name="CN"><C:text-match>Other; Name: Room</C:text-match></C:param-filter>'), source), true);
  assert.equal(await matches(attendee('alice', '<C:param-filter name="RSVP"><C:is-not-defined/></C:param-filter>'), source), true);
  assert.equal(await matches(attendee('alice', '<C:param-filter name="RSVP"/>'), source), false);
});

test('component time ranges share recurrence-aware existing matching and validate UTC bounds', async () => {
  const source = calendar('SUMMARY:Planning\r\nRRULE:FREQ=DAILY;COUNT=3');
  assert.equal(await matches('<C:time-range start="20261031T093000Z" end="20261031T094500Z"/>', source), true);
  assert.equal(await matches('<C:time-range start="20261110T093000Z" end="20261110T094500Z"/>', source), false);
  await assert.rejects(matches('<C:time-range end="20261030T090000Z"/>', source), (err) => err.status === 403);
  assert.equal(await matches('<C:time-range end="20261030T090000Z"/>', calendar('SUMMARY:Single')), false);
  assert.equal(await matches('<C:time-range start="20261030T093000Z" end="20261030T094500Z"/><C:prop-filter name="SUMMARY"><C:text-match>planning</C:text-match></C:prop-filter>', source), true);
  for (const range of ['<C:time-range/>', '<C:time-range start="20260230T000000Z"/>', '<C:time-range start="20261030"/>', '<C:time-range start="20261031T000000Z" end="20261030T000000Z"/>']) {
    assert.throws(() => compileCalendarFilter(query(range)), (err) => err.status === 400);
  }
});

test('VTODO filters use properties and time ranges of the requested component type', async () => {
  const todo = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo\r\nDTSTART:20261030T090000Z\r\nDUE:20261030T100000Z\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
  assert.equal(await compileCalendarFilter(query('<C:time-range start="20261030T093000Z" end="20261030T094500Z"/><C:prop-filter name="STATUS"><C:text-match>NEEDS-ACTION</C:text-match></C:prop-filter>', 'VTODO'))(todo), true);
  assert.equal(await compileCalendarFilter(query('<C:time-range start="20261031T093000Z" end="20261031T094500Z"/>', 'VTODO'))(todo), false);
  assert.equal(await compileCalendarFilter(query('<C:time-range start="20261030T093000Z" end="20261030T094500Z"/>', 'VEVENT'))(todo), false);
  await assert.rejects(compileCalendarFilter(query('<C:time-range start="20261031T093000Z" end="20261031T094500Z"/>', 'VTODO'))(todo.replace('STATUS:NEEDS-ACTION', 'STATUS:NEEDS-ACTION\r\nRRULE:FREQ=DAILY;COUNT=3')),
    (err) => err.status === 403 && err.davError === 'supported-filter');
});

test('unsupported filters, collations, namespaces and structural mistakes fail closed', () => {
  for (const filter of [
    '<C:prop-filter name="DTSTART"><C:time-range start="20261030T000000Z"/></C:prop-filter>',
    '<C:comp-filter name="VALARM"><C:time-range start="20261030T000000Z"/></C:comp-filter>',
    '<C:prop-filter name="SUMMARY" test="anyof"/>',
    '<X:prop-filter xmlns:X="urn:other" name="SUMMARY"/>',
  ]) assert.throws(() => compileCalendarFilter(query(filter)), (err) => err.status === 403 && err.davError === 'supported-filter');
  assert.throws(() => compileCalendarFilter(query('<C:prop-filter name="SUMMARY"><C:text-match collation="i;unicode-casemap">x</C:text-match></C:prop-filter>')), (err) => err.davError === 'supported-collation');
  assert.throws(() => compileCalendarFilter(query('<C:prop-filter name="SUMMARY"><C:is-not-defined/><C:text-match>x</C:text-match></C:prop-filter>')), (err) => err.status === 400);
  assert.throws(() => compileCalendarFilter(query('<C:prop-filter/>')), (err) => err.status === 400);
  assert.throws(() => compileCalendarFilter(query('<C:prop-filter name="SUMMARY"><C:text-match negate-condition="maybe">x</C:text-match></C:prop-filter>')), (err) => err.status === 400);
});

test('time plus metadata over overrides is explicitly unsupported rather than matching unrelated instances', async () => {
  const source = calendar('SUMMARY:Master\r\nRRULE:FREQ=DAILY;COUNT=3', 'BEGIN:VEVENT\r\nUID:one\r\nRECURRENCE-ID:20261031T090000Z\r\nDTSTART:20261031T090000Z\r\nDTEND:20261031T100000Z\r\nSUMMARY:Override\r\nEND:VEVENT\r\n');
  await assert.rejects(matches('<C:time-range start="20261031T093000Z" end="20261031T094500Z"/><C:prop-filter name="SUMMARY"><C:text-match>Master</C:text-match></C:prop-filter>', source), (err) => err.status === 403 && err.davError === 'supported-filter');
});

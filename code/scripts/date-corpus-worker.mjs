// Independent processes keep TZ changes away from the application and test runner.
import { readFileSync } from 'node:fs';
import ICAL from '../web/node_modules/ical.js/dist/ical.js';
import { parseICS as webParse } from '../web/src/js/ics.js';
import { expandOccurrences as webExpand } from '../web/src/js/recurrence.js';
import { parseICS as serverParse } from '../app/vendor/ical/ics.js';
import { expandOccurrences as serverExpand } from '../app/vendor/ical/recurrence.js';

const corpus = JSON.parse(readFileSync(new URL('../test-fixtures/date-corpus.json', import.meta.url)));
// Fixed, reviewable US zone rules, independent of SimpleCal's VTIMEZONE generator.
const newYork = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
];
const civil = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function calendar(fixture) {
  const event = (lines) => ['BEGIN:VEVENT', `UID:${fixture.id}@corpus`, 'DTSTAMP:20260101T000000Z', 'SUMMARY:Corpus', ...lines, 'END:VEVENT'];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SimpleCal//Date Corpus//EN',
    ...(fixture.timezone ? newYork : []), ...event(fixture.lines),
    ...(fixture.override ? event(fixture.override) : []), 'END:VCALENDAR', ''].join('\r\n');
}

function reference(text, dateOnly) {
  ICAL.TimezoneService.reset();
  const component = new ICAL.Component(ICAL.parse(text));
  for (const zone of component.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(new ICAL.Timezone(zone));
  }
  const event = new ICAL.Event(component.getAllSubcomponents('vevent').find((e) => !e.hasProperty('recurrence-id')));
  const iterator = event.iterator();
  const starts = [];
  let slot;
  for (let count = 0; count < 100 && (slot = iterator.next()); count++) {
    const details = event.getOccurrenceDetails(slot);
    starts.push(dateOnly ? details.startDate.toString() : details.startDate.toJSDate().toISOString());
  }
  if (!iterator.complete && starts.length >= 100) throw new Error('Corpus rule exceeded its finite bound');
  return starts.sort();
}

const observations = [];
for (const fixture of corpus.cases) {
  const text = calendar(fixture);
  const expected = [...fixture.expected].sort();
  const oracle = reference(text, fixture.dateOnly);
  const from = Date.parse(expected[0].slice(0, 10)) - 3 * 86400000;
  const to = Date.parse(expected.at(-1).slice(0, 10)) + 3 * 86400000;
  const implementations = {};
  for (const [name, parse, expand] of [['web', webParse, webExpand], ['server', serverParse, serverExpand]]) {
    const master = parse(text)[0];
    implementations[name] = expand(master, from, to)
      .map((o) => fixture.dateOnly ? civil(o.start) : new Date(o.start).toISOString()).sort();
  }
  observations.push({ id: fixture.id, expected, oracle, ...implementations, oracleDifference: fixture.oracleDifference || null, knownDifference: fixture.knownDifference?.[process.env.TZ] || null });
}
process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, observations }));

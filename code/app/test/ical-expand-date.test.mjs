import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Each child starts in its own zone before the parser is imported. This also
// checks the DST boundary without changing process-global TZ during other tests.
const moduleUrl = new URL('../lib/ical.mjs', import.meta.url).href;
const child = `
  import { expandToIcs } from ${JSON.stringify(moduleUrl)};
  const calendar = (body) => ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:date-expand', ...body, 'END:VEVENT',
    'END:VCALENDAR', ''].join('\\r\\n');
  const range = { start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2027-01-01T00:00:00Z') };
  const fixtures = [
    ['DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104'],
    ['DTSTART;VALUE=DATE:20260307', 'DTEND;VALUE=DATE:20260309', 'RRULE:FREQ=DAILY;COUNT=3'],
    ['DTSTART;VALUE=DATE:20260307', 'DTEND;VALUE=DATE:20260308', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20260308'],
    ['DTSTART:20261103T090000Z', 'DTEND:20261103T100000Z', 'RRULE:FREQ=DAILY;COUNT=2'],
  ];
  const outputs = [];
  for (const body of fixtures) {
    const result = await expandToIcs(calendar(body), range);
    outputs.push({ emitted: result.emitted, lines: result.ics.split('\\r\\n')
      .filter((line) => /^(?:DTSTART|DTEND|RECURRENCE-ID)[;:]/.test(line)) });
  }
  console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, outputs }));
`;

for (const zone of ['Asia/Shanghai', 'America/New_York']) {
  test(`expanded DATEs keep calendar days and exclusive ends in ${zone}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const { zone: actualZone, outputs } = JSON.parse(result.stdout.trim());
    assert.equal(actualZone, zone);
    assert.deepEqual(outputs, [
      { emitted: 1, lines: ['DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104'] },
      { emitted: 3, lines: [
        'DTSTART;VALUE=DATE:20260307', 'DTEND;VALUE=DATE:20260309', 'RECURRENCE-ID;VALUE=DATE:20260307',
        'DTSTART;VALUE=DATE:20260308', 'DTEND;VALUE=DATE:20260310', 'RECURRENCE-ID;VALUE=DATE:20260308',
        'DTSTART;VALUE=DATE:20260309', 'DTEND;VALUE=DATE:20260311', 'RECURRENCE-ID;VALUE=DATE:20260309',
      ] },
      { emitted: 2, lines: [
        'DTSTART;VALUE=DATE:20260307', 'DTEND;VALUE=DATE:20260308', 'RECURRENCE-ID;VALUE=DATE:20260307',
        'DTSTART;VALUE=DATE:20260309', 'DTEND;VALUE=DATE:20260310', 'RECURRENCE-ID;VALUE=DATE:20260309',
      ] },
      { emitted: 2, lines: [
        'DTSTART:20261103T090000Z', 'DTEND:20261103T100000Z', 'RECURRENCE-ID:20261103T090000Z',
        'DTSTART:20261104T090000Z', 'DTEND:20261104T100000Z', 'RECURRENCE-ID:20261104T090000Z',
      ] },
    ]);
  });
}

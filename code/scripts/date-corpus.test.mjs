import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const corpus = JSON.parse(readFileSync(new URL('../test-fixtures/date-corpus.json', import.meta.url)));
const strict = process.env.SIMPLECAL_DATES_STRICT === '1';
for (const zone of corpus.zones) {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./date-corpus-worker.mjs', import.meta.url))], {
    env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 30000,
  }));
  assert.equal(result.zone, zone, 'Child must actually run in the requested host timezone');
  assert.equal(result.observations.length, corpus.cases.length);
  for (const row of result.observations) {
    test(`${zone}: ${row.id}: fixed expectations agree with ical.js 2.2.1`, { todo: !strict && row.oracleDifference?.issue || false }, () => assert.deepEqual(row.oracle, row.expected));
    if (row.oracleDifference) {
      test(`${zone}: ${row.id}: reference-library difference remains exactly characterized`, () => {
        assert.deepEqual(row.oracle, row.oracleDifference.actual);
        assert.notDeepEqual(row.oracle, row.expected, 'Fixed: remove the reference-library TODO');
      });
    }
    for (const implementation of ['web', 'server']) {
      // TODO stays visible in TAP totals: a known defect is never reported as conformance.
      test(`${zone}: ${row.id}: ${implementation}`, { todo: !strict && row.knownDifference?.issue || false }, () => {
        assert.deepEqual(row[implementation], row.expected);
      });
    }
    if (row.knownDifference) {
      test(`${zone}: ${row.id}: tracked difference still reproduces`, () => {
        for (const implementation of ['web', 'server']) {
          const baseline = row.expected.map((value, i) => new Date(Date.parse(value) + row.knownDifference.shiftMinutes[i] * 60000).toISOString());
          assert.deepEqual(row[implementation], baseline, 'Deviation changed: fix it or explicitly review the new evidence');
          assert.notDeepEqual(row[implementation], row.expected, 'Fixed: remove the knownDifference marker and its TODO');
        }
        assert.deepEqual(row.web, row.server, 'Front/back drift must not hide inside a known deviation');
      });
    }
  }
}

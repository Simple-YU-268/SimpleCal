#!/usr/bin/env node
// Reproducible synthetic provider benchmark, not an HTTP/client load test.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createStore } from '../app/store/file-store.mjs';
import { runWithContext } from '../app/lib/request-context.mjs';

const output = process.argv[2] || new URL('../../docs/research/evidence/store-benchmark.json', import.meta.url);
const report = { createdAt: new Date().toISOString(), platform: process.platform, node: process.version,
  sizes: [1000, 10000], notes: ['Synthetic VEVENT only; no recurrence or lunar projection writes.',
    'Cold means provider projection cache cold, not OS filesystem cache cold.',
    'Seeding is excluded from operation timings. Memory samples are not a process peak or retained-cache estimate.',
    'Sequential operation timings on this host are observations, not latency guarantees.'], runs: [] };
const uid = (i) => `event-${String(i).padStart(5, '0')}`;
const ics = (i) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Benchmark//EN\r\nBEGIN:VEVENT\r\nUID:${uid(i)}\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Synthetic ${i}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const sample = () => { const memory = process.memoryUsage(); return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external }; };
const round = (number) => Math.round(number * 1000) / 1000;
for (const count of report.sizes) {
  const root = await mkdtemp(path.join(tmpdir(), 'simplecal-store-benchmark-'));
  const run = { count, operations: {}, memory: {}, cleanup: false };
  try {
    const seed = createStore({ root });
    await seed.ensureRoot(); await seed.ensureUser('benchmark');
    const paths = seed.calendarPaths('benchmark', 'default');
    const prefix = path.resolve(root) + path.sep;
    for (const target of [paths.objectsDir, paths.metaPath, paths.statePath]) {
      if (!path.resolve(target).startsWith(prefix)) throw new Error('unexpected seed path');
    }
    const seedingAt = performance.now();
    const ctags = {};
    // At most 64 concurrent writes; never Promise.all over all 10k files.
    for (let offset = 0; offset < count; offset += 64) {
      const end = Math.min(count, offset + 64);
      await Promise.all(Array.from({ length: end - offset }, (_, n) => {
        const i = offset + n;
        ctags[uid(i)] = i + 1;
        return writeFile(path.join(paths.objectsDir, `${uid(i)}.ics`), ics(i), 'utf8');
      }));
    }
    const meta = JSON.parse(await readFile(paths.metaPath, 'utf8'));
    meta.ctag = count;
    await writeFile(paths.metaPath, JSON.stringify(meta), 'utf8');
    await writeFile(paths.statePath, JSON.stringify({ ctags, tombstoneFloor: 0 }), 'utf8');
    run.seedMs = round(performance.now() - seedingAt);
    // Fresh provider after raw seeding: external writes are not supported while
    // a provider is serving requests, so never seed behind its live cache.
    const store = createStore({ root });
    const measure = async (name, expected, task) => {
      const started = performance.now();
      const result = await task();
      const actual = Array.isArray(result) ? result.length : result;
      if (actual !== expected) throw new Error(`${name} returned ${actual}, expected ${expected}`);
      run.operations[name] = { ms: round(performance.now() - started), objects: actual };
      run.memory[name] = sample();
    };
    run.memory.before = sample();
    await runWithContext({ userId: 'benchmark' }, async () => {
      await measure('coldProjectionAndSingleRead', 1, async () => (await store.getEvent('default', `${uid(0)}.ics`)) ? 1 : 0);
      const files = Array.from({ length: 100 }, (_, i) => `${uid(i)}.ics`);
      await measure('warmBatch100', 100, () => store.getEvents('default', files));
      await measure('warmSequential100', 100, async () => {
        let found = 0;
        for (const file of files) if (await store.getEvent('default', file)) found += 1;
        return found;
      });
      await measure('componentCandidates', count, () => store.queryCandidates('default', { component: 'VEVENT' }));
      await measure('snapshot', count, () => store.snapshotEvents('default'));
    });
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('simplecal-store-benchmark-')) {
      throw new Error('unexpected benchmark cleanup path');
    }
    await rm(root, { recursive: true, force: true });
    run.cleanup = true;
  }
  report.runs.push(run);
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));

// Persistent, collection-scoped immutable sync snapshots. No network or auth.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const MAX_BYTES = 32 * 1024 * 1024;
export function createSyncPages({ now = Date.now, writeAtomic }) {
  return async function page(directory, token, limit, capture, epoch) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Object.assign(new Error('sync limit must be 1..1000'), { status: 400 });
    const continuation = String(token).startsWith('urn:simplecal:page:');
    let snapshot, id, offset = 0;
    if (continuation) {
      const match = /^urn:simplecal:page:([0-9a-f-]{36}):(\d+)$/.exec(token);
      if (!match) return { error: 'invalid' };
      id = match[1]; offset = Number(match[2]);
      try {
        const file = path.join(directory, `${id}.json`);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return { error: 'invalid' };
        snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch { return { error: 'expired' }; }
      if (!snapshot || !Array.isArray(snapshot.changes) || typeof snapshot.token !== 'string'
        || !Number.isFinite(snapshot.expires) || snapshot.changes.some((change) => !change || typeof change.uid !== 'string'
          || (change.event && typeof change.event.content !== 'string')
          || (change.record && typeof change.record.content !== 'string'))) return { error: 'invalid' };
      if (snapshot.epoch !== epoch || snapshot.expires < now() || !Number.isSafeInteger(offset)
        || offset < 1 || offset >= snapshot.changes.length) return { error: 'invalid' };
    } else {
      const outcome = await capture();
      if (outcome.error) return outcome;
      if (outcome.changes.length <= limit) return outcome;
      snapshot = { ...outcome, epoch, expires: now() + 24 * 60 * 60 * 1000 };
      const text = JSON.stringify(snapshot);
      if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('sync snapshot byte limit exceeded'), { status: 507 });
      await fs.mkdir(directory, { recursive: true });
      const entries = await fs.readdir(directory);
      for (const name of entries.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        if (stat.isFile() && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.unlink(file);
      }
      if ((await fs.readdir(directory)).length >= 32) throw Object.assign(new Error('too many active sync snapshots'), { status: 507 });
      id = randomUUID();
      await writeAtomic(path.join(directory, `${id}.json`), text);
    }
    const end = Math.min(snapshot.changes.length, offset + limit);
    return { changes: snapshot.changes.slice(offset, end), more: end < snapshot.changes.length,
      token: end < snapshot.changes.length ? `urn:simplecal:page:${id}:${end}` : snapshot.token };
  };
}

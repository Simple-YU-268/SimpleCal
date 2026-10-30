// Durable intent for same-volume rename plus the corresponding sync metadata.
// Recovery rolls forward; never infer "request failed => nothing changed".
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || path.isAbsolute(relative)) throw new Error('Invalid MOVE journal path');
  const base = await fs.realpath(root);
  const full = path.resolve(base, relative);
  if (!full.startsWith(base + path.sep)) throw new Error('MOVE journal escaped storage root');
  // Reject a symlink in any existing path segment, including the final file.
  let cursor = base;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((err) => { if (err.code !== 'ENOENT') throw err; return null; });
    if (stat?.isSymbolicLink()) throw new Error('MOVE journal path contains a symlink');
  }
  return full;
}
async function hashFile(file) {
  try { return digest(await fs.readFile(file)); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
async function atomic(file, bytes) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, bytes, { mode: 0o600 });
  const handle = await fs.open(tmp, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, file);
}
async function finish(root, journal, file) {
  if (journal.version !== 1 || !Array.isArray(journal.writes) || !/^[a-f0-9]{64}$/.test(journal.sourceHash)) {
    throw new Error('Invalid MOVE journal');
  }
  const source = await safePath(root, journal.source);
  const target = await safePath(root, journal.target);
  const backup = await safePath(root, journal.backup);
  const writes = await Promise.all(journal.writes.map(async (write) => {
    const destination = await safePath(root, write.path);
    if (!/\/(?:meta\.json|objects\/\.state\.json)$/.test(write.path) || typeof write.text !== 'string') {
      throw new Error('Invalid MOVE metadata record');
    }
    JSON.parse(write.text);
    return { destination, text: write.text };
  }));
  const sourceHash = await hashFile(source);
  if (sourceHash !== null) {
    if (sourceHash !== journal.sourceHash) throw new Error('MOVE source changed during recovery');
    const targetHash = await hashFile(target);
    const backupHash = await hashFile(backup);
    if (targetHash !== null) {
      if (backupHash !== null || targetHash !== journal.targetHash) throw new Error('MOVE target changed during recovery');
      await fs.rename(target, backup);
    } else if (journal.targetHash !== null && backupHash !== journal.targetHash) {
      throw new Error('MOVE overwrite backup is missing');
    }
    await fs.rename(source, target);
  } else if (await hashFile(target) !== journal.sourceHash) {
    throw new Error('MOVE content cannot be recovered');
  }
  for (const write of writes) await atomic(write.destination, write.text);
  await fs.rm(backup, { force: true });
  await fs.unlink(file);
}

export async function commitMove(root, intent) {
  const folder = path.join(root, '.moves');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${randomUUID()}.json`);
  const journal = { version: 1, ...intent };
  await atomic(file, JSON.stringify(journal));
  await finish(root, journal, file);
}

export async function recoverMoves(root) {
  const folder = path.join(root, '.moves');
  let files;
  try { files = await fs.readdir(folder); }
  catch (err) { if (err.code === 'ENOENT') return { recovered: 0 }; throw err; }
  let recovered = 0;
  for (const name of files.sort()) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const file = path.join(folder, name);
    await finish(root, JSON.parse(await fs.readFile(file, 'utf8')), file);
    recovered++;
  }
  return { recovered };
}

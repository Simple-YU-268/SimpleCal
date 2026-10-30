#!/usr/bin/env node
// Build a portable runtime without fnOS tooling or platform-specific binaries.
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stampDist } from './stamp-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'code/app');
const web = path.join(root, 'code/web');
const source = await readFile(path.join(app, 'server.mjs'), 'utf8');
const version = /export const VERSION = '([^']+)'/.exec(source)?.[1];
if (!version) throw new Error('Cannot resolve server version');
const nameIndex = process.argv.indexOf('--name');
const bundleName = nameIndex < 0 ? `SimpleCal-server-${version}` : process.argv[nameIndex + 1];
if (!bundleName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundleName)) {
  throw new Error('--name must be a directory name containing letters, digits, dots, underscores or hyphens');
}
const output = path.join(root, 'dist', bundleName);
await mkdir(path.dirname(output), { recursive: true });
const stage = await mkdtemp(path.join(root, 'dist', '.server-build-'));
try {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    cwd: web, stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('Frontend build failed; run npm ci in code/web first');
  stampDist({ distDir: path.join(web, 'dist'), version });
  for (const name of ['api', 'auth', 'dav', 'lib', 'security', 'store', 'vendor',
    'server.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(app, name), path.join(stage, 'server', name), { recursive: true });
  }
  await cp(path.join(web, 'dist'), path.join(stage, 'www'), {
    recursive: true, filter: (file) => !file.endsWith('.map'),
  });
  for (const name of ['deploy', 'SERVER.md', 'DOCKER.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  await mkdir(path.join(stage, 'docs'), { recursive: true });
  await cp(path.join(root, 'docs/EVENTS_API.md'), path.join(stage, 'docs/EVENTS_API.md'));
  await cp(path.join(root, 'docs/DAV_API.md'), path.join(stage, 'docs/DAV_API.md'));
  await writeFile(path.join(stage, 'VERSION'), `${version}\n`);
  // Fail safely if a previous bundle exists; never delete user runtime data.
  try { await rename(stage, output); }
  catch (err) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code)) {
      throw new Error(`Output already exists or cannot be replaced: ${output}. Move it before rebuilding.`);
    }
    throw err;
  }
  console.log(`Portable server: ${output}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

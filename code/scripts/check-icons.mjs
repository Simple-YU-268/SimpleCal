#!/usr/bin/env node
/**
 * Verify the original SimpleCal identity across web and fnOS assets.
 * Frozen SHA-256 values bind this check to the reviewed indigo/calendar/C mark.
 * Historical v6-v9 artwork remains archival and is never a build source.
 * No image library, network request, or application runtime is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? path.resolve(process.argv[i + 1]) : fallback;
};
const PUBLIC = option('public', path.join(codeDir, 'web/public'));
const FNOS = option('fnos', path.join(codeDir, 'fnos'));
const MAX_BYTES = 1024 * 1024;
const WEB = {
  'apple-touch-icon.png': [180, '9dcc8b332922c2607df09613bb60fc5236246ebff37b0cb4c46703d4c370a460'],
  'favicon-16x16.png': [16, '7dd63b610f7ebfce6eb36fe3edd033c266cccf1821482eda8682c06632fa9eb2'],
  'favicon-32x32.png': [32, '11d7289529532aa9f52216b94d9d0882bf6c8123cd038031db6cd99579acf42f'],
  'favicon-48x48.png': [48, '0ba78deebf91ec404530f2b181de90c76a75b3e0129e02cb16fcd9a0cb653844'],
  'favicon.ico': [0, '0c6a08c998c8bbcac12fc73ecef9a3fd58f0faa6cb5685edb0f6fa00c7a44c79'],
  'icon-192-maskable.png': [192, 'a3c856238c4633cb291537b3962afcc5232cd52bd5b65a4bf3b6e8392709fa16'],
  'icon-192.png': [192, '2ca088da7db25dc59c6ff5f2839b92bdd28d13103332da0ceead6bb2d5bcb99a'],
  'icon-512-maskable.png': [512, 'aa3341fb4cf97c5264727fa07f6bed9a7a0ddace03f37ef7c68b53d3f5b8c9a7'],
  'icon-512.png': [512, '0184fa38b7919f9d336b43a5e04a32a0ce575acd45b3011dadc7864861929f39'],
  'simplecal-logo.svg': [0, '1ebab8ba2b63758a3b2e3da18b250d31d3570920d602854978ba8bd45f38c90d'],
  'simplecal-mark.svg': [0, '1ebab8ba2b63758a3b2e3da18b250d31d3570920d602854978ba8bd45f38c90d'],
  'simplecal-mark-monochrome.svg': [0, 'f878cd577818d905540407e57af7e7ffac261c2955f54f122dc4fa8b4289628a'],
};
const PACKAGE = {
  'ICON.PNG': [64, '2715cd802f3b5c2dd51940dd5b90d6f62eeb053e1ffd17b0a4269d44d213a7d0'],
  'ICON_256.PNG': [256, '235d4c2e2042820456c64afe7e09874e945112417acd382445c65987a53d14b4'],
  'app/ui/images/icon_64.png': [64, '2715cd802f3b5c2dd51940dd5b90d6f62eeb053e1ffd17b0a4269d44d213a7d0'],
  'app/ui/images/icon_256.png': [256, '235d4c2e2042820456c64afe7e09874e945112417acd382445c65987a53d14b4'],
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let failures = 0, checks = 0;
function check(name, ok) {
  checks++;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
}
const oldHashes = new Set();
for (const dir of ['icon-approved-v6', 'icon-approved-v7', 'icon-approved-v8', 'icon-approved-v9']) {
  const source = path.join(here, dir);
  check(`Historical baseline ${dir} exists`, fs.existsSync(source));
  if (!fs.existsSync(source)) continue;
  for (const file of fs.readdirSync(source).filter(file => /\.(png|ico)$/i.test(file))) {
    oldHashes.add(digest(fs.readFileSync(path.join(source, file))));
  }
}
function verifyAssets(root, specs, label) {
  for (const [file, [size, expected]] of Object.entries(specs)) {
    const target = path.join(root, file);
    check(`${label}/${file} exists`, fs.existsSync(target));
    if (!fs.existsSync(target)) continue;
    const bytes = fs.readFileSync(target);
    const hash = digest(bytes);
    check(`${label}/${file} matches SimpleCal source`, hash === expected);
    check(`${label}/${file} differs from historical artwork`, !oldHashes.has(hash));
    check(`${label}/${file} <= 1 MiB`, bytes.length <= MAX_BYTES);
    if (size) {
      const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      check(`${label}/${file} is ${size}x${size} RGB/RGBA PNG`, png
        && bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size
        && bytes[24] === 8 && [2,6].includes(bytes[25]));
    }
  }
}
verifyAssets(PUBLIC, WEB, 'public');
verifyAssets(FNOS, PACKAGE, 'fnos');
const icoPath = path.join(PUBLIC, 'favicon.ico');
if (fs.existsSync(icoPath)) {
  const ico = fs.readFileSync(icoPath);
  const header = ico.length >= 54 && ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3;
  check('ICO has exactly three icon entries', header);
  if (header) for (const [index, size] of [16,32,48].entries()) {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    const pngPath = path.join(PUBLIC, `favicon-${size}x${size}.png`);
    check(`ICO ${size}px embeds the exact standalone PNG`, ico[entry] === size && ico[entry + 1] === size
      && offset >= 54 && offset + length <= ico.length && fs.existsSync(pngPath)
      && ico.subarray(offset, offset + length).equals(fs.readFileSync(pngPath)));
  }
}
try {
  const wm = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'site.webmanifest'), 'utf8'));
  check('Manifest has independent SimpleCal name and indigo theme', wm.name === 'SimpleCal'
    && wm.short_name === 'SimpleCal' && wm.theme_color.toLowerCase() === '#3b54c4'
    && wm.background_color.toLowerCase() === '#f4f6f8');
  check('Manifest preserves install icon sizes and safe-area variants', JSON.stringify(wm.icons.map(icon => [icon.src.split('?')[0],icon.sizes,icon.purpose])) === JSON.stringify([
    ['/icon-192.png','192x192','any'], ['/icon-512.png','512x512','any'],
    ['/icon-192-maskable.png','192x192','maskable'], ['/icon-512-maskable.png','512x512','maskable'],
  ]));
} catch (error) { check(`Manifest readable: ${error.message}`, false); }
// If assembled output exists, verify its shipped icons too; source-only runs are supported.
const assembled = path.join(FNOS, 'app/www');
if (fs.existsSync(assembled)) verifyAssets(assembled, WEB, 'fnos/app/www');
console.log(`\nSUMMARY: checks=${checks} checks_failed=${failures}`);
process.exitCode = failures ? 1 : 0;

#!/usr/bin/env node
// Original SimpleCal vector identity. Rasterization is a development-only step.
// npm install --prefix <temporary-directory> @resvg/resvg-js
// node code/scripts/generate-brand.mjs --renderer <temporary-directory>/node_modules/@resvg/resvg-js
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'code/web/public');
const fnos = path.join(root, 'code/fnos');
const rendererArg = process.argv.indexOf('--renderer');
const require = createRequire(import.meta.url);
const { Resvg } = require(rendererArg < 0 ? '@resvg/resvg-js' : path.resolve(process.argv[rendererArg + 1]));

// The open C is the recognizable feature at 16px. The yellow date point marks
// the opening; two calendar bindings identify the product without tiny lettering.
const glyph = `<path d="M22 17H42C49 17 53 21 53 28V45C53 52 49 56 42 56H22C15 56 11 52 11 45V28C11 21 15 17 22 17Z" fill="#FCFFF9"/>
  <path d="M23 12V21M41 12V21" stroke="#A9BEE4" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M39 29.7C37.2 28.2 34.9 27.4 32.5 27.4C26.8 27.4 22.3 31.9 22.3 37.5C22.3 43.1 26.8 47.6 32.5 47.6C34.9 47.6 37.2 46.8 39 45.3" fill="none" stroke="#3B54C4" stroke-width="5.5" stroke-linecap="round"/>
  <circle cx="42.5" cy="37.5" r="5.5" fill="#FFD94D"/>`;

const svg = (maskable = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <title>SimpleCal</title>
  <rect width="64" height="64" rx="${maskable ? 0 : 17}" fill="#3B54C4"/>
  <g${maskable ? ' transform="translate(32 32) scale(.82) translate(-32 -32)"' : ''}>${glyph}</g>
</svg>
`;

await writeFile(path.join(output, 'simplecal-mark.svg'), svg());
await writeFile(path.join(output, 'simplecal-logo.svg'), svg());
await writeFile(path.join(output, 'simplecal-mark-monochrome.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><title>SimpleCal</title><path d="M22 17H42C49 17 53 21 53 28V45C53 52 49 56 42 56H22C15 56 11 52 11 45V28C11 21 15 17 22 17Z" stroke="currentColor" stroke-width="3"/><path d="M23 12V21M41 12V21M39 29.7C37.2 28.2 34.9 27.4 32.5 27.4C26.8 27.4 22.3 31.9 22.3 37.5C22.3 43.1 26.8 47.6 32.5 47.6C34.9 47.6 37.2 46.8 39 45.3" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/><circle cx="42.5" cy="37.5" r="4.5" fill="currentColor"/></svg>\n`);

const files = [
  ['favicon-16x16.png', 16, false], ['favicon-32x32.png', 32, false], ['favicon-48x48.png', 48, false],
  ['apple-touch-icon.png', 180, true], ['icon-192.png', 192, false], ['icon-512.png', 512, false],
  ['icon-192-maskable.png', 192, true], ['icon-512-maskable.png', 512, true],
];
const buffers = new Map();
for (const [name, width, maskable] of files) {
  // Every raster comes from the same vector geometry, so a favicon and a 512px
  // icon can never drift apart.
  const png = new Resvg(svg(maskable), { fitTo: { mode: 'width', value: width } }).render().asPng();
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== width) throw new Error(`Unexpected raster size: ${name}`);
  await writeFile(path.join(output, name), png);
  buffers.set(width, png);
  console.log(`${name}: ${width}×${width}, ${png.length} bytes`);
}
// fnOS launchers share the vector geometry, with no image rescaling in assembly.
for (const width of [64, 256]) {
  const png = new Resvg(svg(), { fitTo: { mode: 'width', value: width } }).render().asPng();
  await writeFile(path.join(fnos, width === 64 ? 'ICON.PNG' : 'ICON_256.PNG'), png);
  await writeFile(path.join(fnos, 'app/ui/images', `icon_${width}.png`), png);
}
// ICO embeds the same lossless PNG payloads used by explicit favicon links.
const sizes = [16, 32, 48];
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let index = 0; index < sizes.length; index += 1) {
  const size = sizes[index], png = buffers.get(size), entry = 6 + index * 16;
  header[entry] = size; header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(path.join(output, 'favicon.ico'), Buffer.concat([header, ...sizes.map((size) => buffers.get(size))]));
const manifest = JSON.parse(await readFile(path.join(output, 'site.webmanifest'), 'utf8'));
manifest.name = 'SimpleCal'; manifest.short_name = 'SimpleCal';
manifest.description = 'SimpleCal：明亮、有序的日历与任务工作台。';
manifest.background_color = '#F4F6F8'; manifest.theme_color = '#3B54C4';
await writeFile(path.join(output, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

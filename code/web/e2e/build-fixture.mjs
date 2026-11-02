/**
 * 为「两份真实构建之间的升级」测试准备产物。
 *
 * 构建 A：当前源码原样打包。
 * 构建 B：同一份源码，但改掉一段文案与一个主题色，因此 JS/CSS 内容与哈希都不同，
 *        正好模拟一次真实的前端发版（而不是换一个 SW 标识符）。
 *
 * 两份产物都会打上版本戳（与 Dockerfile 里的 stamp-version 一致），
 * 因此 Service Worker 的缓存名、index.html 的 meta 指纹都能区分版本。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { stampDist } from '../../scripts/stamp-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
export const tmpRoot = path.join(here, '.tmp-builds');

async function prepareSource(name) {
  const srcDir = path.join(tmpRoot, `${name}-src`);
  await fs.rm(srcDir, { recursive: true, force: true });
  await fs.mkdir(srcDir, { recursive: true });
  await fs.copyFile(path.join(webRoot, 'index.html'), path.join(srcDir, 'index.html'));
  await fs.cp(path.join(webRoot, 'src'), path.join(srcDir, 'src'), { recursive: true });
  await fs.cp(path.join(webRoot, 'public'), path.join(srcDir, 'public'), { recursive: true });
  return srcDir;
}

/** 构建 B 用的真实改动：文案（进 JS bundle）+ 主题色（进 CSS）。 */
async function mutateSource(srcDir) {
  const i18nPath = path.join(srcDir, 'src', 'i18n', 'zh-CN.js');
  let i18n = await fs.readFile(i18nPath, 'utf8');
  for (const key of ['app.title', 'login.title']) {
    const from = `'${key}': 'SimpleCal'`;
    if (!i18n.includes(from)) throw new Error(`fixture: 找不到 ${from}`);
    i18n = i18n.replace(from, `'${key}': 'SimpleCal B'`);
  }
  await fs.writeFile(i18nPath, i18n);

  const cssPath = path.join(srcDir, 'src', 'styles', 'tokens.css');
  let css = await fs.readFile(cssPath, 'utf8');
  if (!css.includes('--accent: #3b54c4;')) throw new Error('fixture: 找不到 --accent 主题色');
  css = css.replace('--accent: #3b54c4;', '--accent: #b4341f;');
  await fs.writeFile(cssPath, css);
}

async function buildVariant({ name, version, mutate }) {
  const srcDir = await prepareSource(name);
  if (mutate) await mutate(srcDir);
  const distDir = path.join(srcDir, 'dist');
  await build({
    root: srcDir,
    configFile: false,
    base: './',
    logLevel: 'warn',
    build: { outDir: distDir, emptyOutDir: true, sourcemap: false, target: 'es2020' },
  });
  const stamped = stampDist({ distDir, version });
  const assets = (await fs.readdir(path.join(distDir, 'assets'))).filter((file) => /\.(js|css)$/.test(file));
  if (!assets.length) throw new Error('fixture: 构建产物没有 assets');
  return {
    name,
    version,
    distDir,
    fingerprint: stamped.fingerprint,
    swCache: stamped.swCache,
    assets: assets.sort(),
  };
}

export async function buildFixture() {
  await fs.mkdir(tmpRoot, { recursive: true });
  const a = await buildVariant({ name: 'a', version: '0.4.4' });
  const b = await buildVariant({ name: 'b', version: '0.4.5', mutate: mutateSource });
  const overlap = a.assets.filter((file) => b.assets.includes(file));
  if (overlap.length) throw new Error(`fixture: 两份构建的资源名重合：${overlap.join(', ')}`);
  return { a, b };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fixture = await buildFixture();
  console.log('[fixture] A', fixture.a.fingerprint, fixture.a.assets.join(' '));
  console.log('[fixture] B', fixture.b.fingerprint, fixture.b.assets.join(' '));
}

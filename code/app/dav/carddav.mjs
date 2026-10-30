// Independent CardDAV adapter. A book's content and sync journal are committed
// as one atomic JSON replacement. The queue is process-local, not a cluster lock.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseXml, find, findAll, escapeXml } from '../lib/xml.mjs';
import { checkEntityConditions } from './preconditions.mjs';
import { challengeHeaders } from '../auth/index.mjs';
import { publicHref, pathFromPublicUrl } from '../lib/public-url.mjs';

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const FILE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}\.vcf$/i;
const MAX_CARD = 1024 * 1024;
const MAX_BOOK = 16 * 1024 * 1024;
const JOURNAL_LIMIT = 5000;
const METHODS = ['OPTIONS', 'GET', 'HEAD', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'PUT', 'DELETE', 'REPORT'];
const WRITE_METHODS = new Set(['MKCOL', 'PUT', 'DELETE', 'PROPPATCH']);
const NAMESPACES = 'xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/"';
const REPORTS = '<D:supported-report-set>' + ['A:addressbook-query', 'A:addressbook-multiget', 'D:sync-collection']
  .map((name) => `<D:supported-report><D:report><${name}/></D:report></D:supported-report>`).join('') + '</D:supported-report-set>';
const error = (status, message, xml = '') => Object.assign(new Error(message), { status, xml });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const tag = (book) => `urn:uuid:${book.epoch}:${book.seq}`;
const statusLine = (status) => `HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Forbidden'}`;
const cardError = (name) => `<?xml version="1.0"?><D:error ${NAMESPACES}><A:${name}/></D:error>`;
const davError = (name) => `<?xml version="1.0"?><D:error ${NAMESPACES}><D:${name}/></D:error>`;

export function validateVcard(content) {
  const lines = String(content).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
  if (lines[0] !== 'BEGIN:VCARD' || lines.at(-1) !== 'END:VCARD'
    || lines.filter((line) => line === 'BEGIN:VCARD').length !== 1
    || lines.filter((line) => line === 'END:VCARD').length !== 1) {
    throw error(403, '需要单个完整 vCard', cardError('valid-address-data'));
  }
  const properties = new Map();
  for (const line of lines.slice(1, -1)) {
    const colon = line.indexOf(':');
    if (colon < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) {
      throw error(403, 'vCard 属性无效', cardError('valid-address-data'));
    }
    const key = line.slice(0, colon).split(';')[0].split('.').at(-1).toUpperCase();
    const values = properties.get(key) || [];
    values.push(line.slice(colon + 1)); properties.set(key, values);
  }
  const versions = properties.get('VERSION') || [];
  if (versions.length !== 1 || !['3.0', '4.0'].includes(versions[0])) {
    throw error(403, '支持 vCard 3.0 或 4.0', cardError('supported-address-data'));
  }
  if ((properties.get('UID') || []).length !== 1 || !properties.get('UID')[0].trim()
    || !(properties.get('FN') || []).some((name) => name.trim())) {
    throw error(403, 'vCard 需要唯一 UID 与非空 FN', cardError('valid-address-data'));
  }
  return { uid: properties.get('UID')[0], version: versions[0], properties };
}

async function readBody(req, limit = MAX_CARD) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(chunk);
  }
  if (bytes > limit) throw error(413, '请求体超过限制');
  return Buffer.concat(chunks).toString('utf8');
}

function xmlTree(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw error(400, '不接受 XML DTD 或自定义实体');
  if (!text.trim()) return null;
  try {
    const tree = parseXml(text);
    if (tree.children.length !== 1) throw new Error('root');
    return tree;
  } catch { throw error(400, 'XML 无效'); }
}

function requestedProperties(tree) {
  const prop = tree && find(tree, 'prop');
  if (!prop || (tree && find(tree, 'allprop'))) return null;
  return prop.children.map((node) => node.local);
}

function queryPredicate(tree) {
  const filter = find(tree, 'filter');
  if (!filter) return () => true;
  const matchMode = filter.attrs.test || 'anyof';
  if (!['anyof', 'allof'].includes(matchMode)) throw error(403, '筛选器不受支持', cardError('supported-filter'));
  const predicates = filter.children.map((prop) => {
    if (prop.local !== 'prop-filter' || !/^[A-Za-z0-9-]+$/.test(prop.attrs.name || '')) {
      throw error(403, '筛选器不受支持', cardError('supported-filter'));
    }
    const name = prop.attrs.name.toUpperCase();
    if (prop.children.length > 1) throw error(403, '组合属性筛选不受支持', cardError('supported-filter'));
    const condition = prop.children[0];
    if (!condition) return (card) => card.properties.has(name);
    if (condition.local === 'is-not-defined') return (card) => !card.properties.has(name);
    if (condition.local !== 'text-match' || condition.children.length) throw error(403, '筛选器不受支持', cardError('supported-filter'));
    const collation = condition.attrs.collation || 'i;unicode-casemap';
    if (!['i;unicode-casemap', 'i;ascii-casemap', 'i;octet'].includes(collation)) {
      throw error(403, '排序规则不受支持', cardError('supported-collation'));
    }
    const matchType = condition.attrs['match-type'] || 'contains';
    if (!['contains', 'equals', 'starts-with', 'ends-with'].includes(matchType)) throw error(403, '匹配类型不受支持', cardError('supported-filter'));
    const fold = (value) => collation === 'i;octet' ? value : collation === 'i;ascii-casemap'
      ? value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : value.toLowerCase();
    const needle = fold(condition.text);
    const negate = condition.attrs['negate-condition'] || 'no';
    if (!['yes', 'no'].includes(negate)) throw error(403, '否定条件无效', cardError('supported-filter'));
    return (card) => {
      const values = card.properties.get(name) || [];
      return values.some((value) => {
        const haystack = fold(value);
        const result = matchType === 'contains' ? haystack.includes(needle) : matchType === 'equals' ? haystack === needle
          : matchType === 'starts-with' ? haystack.startsWith(needle) : haystack.endsWith(needle);
        return negate === 'yes' ? !result : result;
      });
    };
  });
  return (card) => predicates.length === 0 || (matchMode === 'anyof'
    ? predicates.some((predicate) => predicate(card)) : predicates.every((predicate) => predicate(card)));
}

export function createCardDavHandler({ auth, config, logger = { event() {}, access() {} } }) {
  const prefix = config.davPrefix || '';
  const base = `${prefix}/addressbooks`;
  const root = path.resolve(config.varDir, 'addressbooks');
  const queues = new Map();
  const encode = encodeURIComponent;
  const homeHref = (username) => publicHref(config, `${base}/${encode(username)}/`);
  const bookHref = (username, id) => `${homeHref(username)}${encode(id)}/`;
  const objectHref = (username, id, file) => `${bookHref(username, id)}${encode(file)}`;
  function owns(pathname) { return pathname === base || pathname.startsWith(`${base}/`); }
  function targetOf(pathname) {
    let parts;
    try { parts = pathname.slice(base.length).split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw error(400, '路径编码无效'); }
    if (parts.length < 1 || parts.length > 3 || parts.some((part) => part.includes('/') || part.includes('\\') || !ID.test(part))) {
      // Object names also fit ID, with a separately enforced vcf suffix.
      throw error(400, '通讯录资源路径无效');
    }
    if (parts.length === 3 && !FILE.test(parts[2])) throw error(400, '联系人资源必须为 .vcf');
    return { username: parts[0], bookId: parts[1], file: parts[2],
      kind: parts.length === 1 ? 'home' : parts.length === 2 ? 'book' : 'card' };
  }
  function enqueue(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => {}));
    return next;
  }
  async function userDirectory(userId) {
    if (!ID.test(userId)) throw error(400, '账号标识无效');
    await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    const directory = path.join(realRoot, userId);
    await fs.mkdir(directory, { recursive: true });
    const resolved = await fs.realpath(directory);
    if (!resolved.startsWith(realRoot + path.sep)) throw error(403, '数据目录越界');
    return resolved;
  }
  async function bookPath(userId, bookId) {
    if (!ID.test(bookId)) throw error(400, '通讯录标识无效');
    const directory = await userDirectory(userId);
    const filename = path.join(directory, `${bookId}.json`);
    try {
      const resolved = await fs.realpath(filename);
      if (!resolved.startsWith(directory + path.sep)) throw error(403, '数据文件越界');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return filename;
  }
  async function readBook(userId, bookId) {
    try {
      const parsed = JSON.parse(await fs.readFile(await bookPath(userId, bookId), 'utf8'));
      if (parsed.version !== 1 || parsed.id !== bookId || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0
        || !parsed.records || Array.isArray(parsed.records) || typeof parsed.records !== 'object'
        || !Array.isArray(parsed.tombstones) || typeof parsed.epoch !== 'string') throw new Error('invalid state');
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err.status) throw err;
      logger.event('addressbook-state-error', { bookId, code: err.code || 'invalid_state' });
      throw error(500, '通讯录状态无法读取，请恢复备份');
    }
  }
  async function saveBook(userId, book) {
    const serialized = JSON.stringify(book);
    if (Buffer.byteLength(serialized) > MAX_BOOK) throw error(507, '通讯录超过 16 MB 存储上限');
    const filename = await bookPath(userId, book.id);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, filename);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  function newBook(id, displayName) {
    return { version: 1, id, displayName, description: '', epoch: randomUUID(), seq: 0, floor: 0,
      modified: new Date().toISOString(), records: {}, tombstones: [] };
  }
  async function ensureDefault(userId) {
    return enqueue(`${userId}/contacts`, async () => {
      if (!await readBook(userId, 'contacts')) await saveBook(userId, newBook('contacts', '联系人'));
    });
  }
  async function listBooks(userId) {
    const directory = await userDirectory(userId);
    const result = [];
    for (const file of (await fs.readdir(directory)).sort()) {
      if (!file.endsWith('.json') || !ID.test(file.slice(0, -5))) continue;
      const book = await readBook(userId, file.slice(0, -5));
      if (book) result.push(book);
    }
    return result;
  }
  function send(req, res, status, headers = {}, body = '') {
    const payload = Buffer.from(body);
    res.writeHead(status, { 'Content-Length': payload.length, 'Cache-Control': 'no-store', ...headers });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }
  function multistatus(req, res, entries, token = '') {
    return send(req, res, 207, { 'Content-Type': 'application/xml; charset=utf-8' },
      `<?xml version="1.0" encoding="utf-8"?><D:multistatus ${NAMESPACES}>${entries.join('')}${token ? `<D:sync-token>${escapeXml(token)}</D:sync-token>` : ''}</D:multistatus>`);
  }
  function href(target) {
    return target.kind === 'home' ? homeHref(target.username) : target.kind === 'book' ? bookHref(target.username, target.bookId)
      : objectHref(target.username, target.bookId, target.file);
  }
  function responseXml(target, book, record, requested, propname = false) {
    const standard = target.kind === 'home' ? ['resourcetype', 'displayname', 'current-user-principal', 'addressbook-home-set']
      : target.kind === 'book' ? ['resourcetype', 'displayname', 'addressbook-description', 'getetag', 'getctag', 'sync-token',
        'supported-address-data', 'supported-report-set', 'max-resource-size', 'current-user-principal', 'current-user-privilege-set']
        : ['resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified'];
    const values = {
      resourcetype: target.kind === 'home' ? '<D:collection/>' : target.kind === 'book' ? '<D:collection/><A:addressbook/>' : '',
      displayname: escapeXml(target.kind === 'home' ? '通讯录' : target.kind === 'book' ? book.displayName : target.file),
      'current-user-principal': `<D:href>${escapeXml(publicHref(config, `${prefix}/principals/${encode(target.username)}/`))}</D:href>`,
      'addressbook-home-set': `<D:href>${escapeXml(homeHref(target.username))}</D:href>`,
      'current-user-privilege-set': '<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>',
    };
    if (book) Object.assign(values, {
      'addressbook-description': escapeXml(book.description),
      getetag: `"${digest(Object.values(book.records).map((card) => card.content).join(''))}"`,
      getctag: String(book.seq), 'sync-token': escapeXml(tag(book)),
      'supported-address-data': '<A:address-data-type content-type="text/vcard" version="3.0"/><A:address-data-type content-type="text/vcard" version="4.0"/>',
      'supported-report-set': REPORTS.slice('<D:supported-report-set>'.length, -'</D:supported-report-set>'.length),
      'max-resource-size': String(MAX_CARD),
    });
    if (record) Object.assign(values, { getetag: `"${record.etag}"`, getcontenttype: 'text/vcard; charset=utf-8',
      getcontentlength: String(Buffer.byteLength(record.content)), getlastmodified: new Date(record.modified).toUTCString(),
      'address-data': escapeXml(record.content) });
    const ok = [], missing = [];
    for (const name of requested || standard) {
      const ns = ['addressbook-home-set', 'addressbook-description', 'supported-address-data', 'max-resource-size', 'address-data'].includes(name) ? 'A'
        : name === 'getctag' ? 'CS' : 'D';
      const empty = `<${ns}:${name}/>`;
      if (Object.prototype.hasOwnProperty.call(values, name)) ok.push(propname ? empty : `<${ns}:${name}>${values[name]}</${ns}:${name}>`);
      else missing.push(empty);
    }
    return `<D:response><D:href>${escapeXml(href(target))}</D:href><D:propstat><D:prop>${ok.join('')}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat>`
      + (missing.length ? `<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>${statusLine(404)}</D:status></D:propstat>` : '') + '</D:response>';
  }
  const notFoundXml = (url) => `<D:response><D:href>${escapeXml(url)}</D:href><D:status>${statusLine(404)}</D:status></D:response>`;

  async function handle(req, res) {
    const started = Date.now();
    let target;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (!owns(url.pathname)) return false;
      // Inspect raw segments before URL normalization can erase '..'.
      for (const segment of String(req.url).split('?')[0].split('/')) {
        let decoded; try { decoded = decodeURIComponent(segment); } catch { throw error(400, '路径编码无效'); }
        if (decoded === '.' || decoded === '..') throw error(400, '路径越界');
      }
      if (req.method === 'OPTIONS') {
        send(req, res, 200, { Allow: METHODS.join(', '), DAV: '1, 3, addressbook, extended-mkcol, sync-collection' }); return true;
      }
      target = targetOf(url.pathname);
      const identity = await auth.authenticate(req, { allowMfaPending: true });
      if (!identity.ok || !identity.account) { send(req, res, 401, challengeHeaders(), 'authentication required\n'); return true; }
      if (identity.account.mustChangePassword || identity.mfaPending) throw error(403, '请先修改初始密码或完成两步验证');
      const named = await auth.lookupAccountExact(target.username);
      if (!named) throw error(404, '账号不存在');
      if (named.id !== identity.account.id) throw error(403, '无权访问其他账号通讯录');
      if (WRITE_METHODS.has(req.method) && identity.via === 'session' && !auth.validateCsrf(req, identity.account)) throw error(403, 'CSRF 校验失败');
      if (identity.refreshCookie) res.setHeader('Set-Cookie', identity.refreshCookie);
      const userId = identity.account.id;
      await ensureDefault(userId);
      if (!METHODS.includes(req.method)) { send(req, res, 405, { Allow: METHODS.join(', ') }); return true; }
      const body = ['MKCOL', 'PROPFIND', 'PROPPATCH', 'REPORT', 'PUT'].includes(req.method) ? await readBody(req) : '';
      const tree = req.method !== 'PUT' ? xmlTree(body) : null;
      if (req.method === 'MKCOL') {
        if (target.kind !== 'book') throw error(405, 'MKCOL 需要通讯录集合路径');
        if (!tree || !find(tree, 'addressbook') || !find(tree, 'collection')) throw error(403, '需要 addressbook 集合类型', davError('valid-resourcetype'));
        if (find(tree, 'calendar')) throw error(403, '此路径不接受日历集合', davError('valid-resourcetype'));
        const displayName = find(tree, 'displayname')?.text || target.bookId;
        const description = find(tree, 'addressbook-description')?.text || '';
        if (displayName.length > 255 || description.length > 2000) throw error(400, '集合元数据过长');
        await enqueue(`${userId}/${target.bookId}`, async () => {
          if (await readBook(userId, target.bookId)) throw error(405, '集合已存在');
          await saveBook(userId, { ...newBook(target.bookId, displayName), description });
        });
        send(req, res, 201, { Location: bookHref(target.username, target.bookId) }); return true;
      }
      if (target.kind === 'home') {
        if (req.method === 'PROPFIND') {
          const depth = req.headers.depth ?? '1';
          if (!['0', '1'].includes(depth)) throw error(403, '仅支持 Depth 0 或 1', davError('propfind-finite-depth'));
          const requested = requestedProperties(tree);
          const entries = [responseXml(target, null, null, requested, Boolean(tree && find(tree, 'propname')))];
          if (depth === '1') for (const book of await listBooks(userId)) entries.push(responseXml({ ...target, kind: 'book', bookId: book.id }, book, null, requested));
          multistatus(req, res, entries); return true;
        }
        if (['GET', 'HEAD'].includes(req.method)) { send(req, res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, (await listBooks(userId)).map((book) => book.id).join('\n')); return true; }
        throw error(405, '此方法需要通讯录或联系人路径');
      }
      await enqueue(`${userId}/${target.bookId}`, async () => {
        const book = await readBook(userId, target.bookId);
        if (!book) throw error(req.method === 'PUT' ? 409 : 404, '通讯录不存在');
        const record = target.file ? book.records[target.file] : null;
        if (req.method === 'PUT' || req.method === 'DELETE') {
          if (target.kind !== 'card') throw error(405, '本轮只支持单联系人写入和删除');
          const failure = checkEntityConditions(req.headers, record);
          if (failure) throw error(failure.status, failure.reason);
          if (req.method === 'DELETE' && !record) throw error(404, '联系人不存在');
          if (req.method === 'PUT') {
            const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (type && !['text/vcard', 'text/x-vcard'].includes(type)) throw error(415, '需要 text/vcard');
            const parsed = validateVcard(body);
            const duplicate = Object.entries(book.records).find(([file, card]) => file !== target.file && card.uid === parsed.uid);
            if (duplicate) throw error(403, '通讯录内 UID 已存在', cardError('no-uid-conflict'));
            book.seq += 1; book.modified = new Date().toISOString();
            book.records[target.file] = { content: body, uid: parsed.uid, etag: digest(body), seq: book.seq, modified: book.modified };
            await saveBook(userId, book);
            send(req, res, record ? 204 : 201, { ETag: `"${book.records[target.file].etag}"`, ...(!record ? { Location: href(target) } : {}) });
          } else {
            book.seq += 1; book.modified = new Date().toISOString(); delete book.records[target.file];
            book.tombstones.push({ file: target.file, seq: book.seq });
            while (book.tombstones.length > JOURNAL_LIMIT) book.floor = book.tombstones.shift().seq;
            await saveBook(userId, book); send(req, res, 204);
          }
          return;
        }
        if (target.kind === 'card' && !record) throw error(404, '联系人不存在');
        if (['GET', 'HEAD'].includes(req.method)) {
          const content = record ? record.content : Object.keys(book.records).sort().map((file) => book.records[file].content.trimEnd() + '\r\n').join('');
          const etag = record ? record.etag : digest(content);
          const failure = checkEntityConditions(req.headers, { etag }, { read: true });
          const headers = { 'Content-Type': 'text/vcard; charset=utf-8', ETag: `"${etag}"`,
            ...(record ? { 'Last-Modified': new Date(record.modified).toUTCString() } : { 'Content-Disposition': `attachment; filename="${book.id}.vcf"` }) };
          if (failure) send(req, res, failure.status, headers, failure.status === 304 ? '' : failure.reason);
          else send(req, res, 200, headers, content);
          return;
        }
        if (req.method === 'PROPFIND') {
          const depth = req.headers.depth ?? '1';
          if (!['0', '1'].includes(depth)) throw error(403, '仅支持 Depth 0 或 1', davError('propfind-finite-depth'));
          const requested = requestedProperties(tree);
          const propname = Boolean(tree && find(tree, 'propname'));
          const entries = [responseXml(target, book, record, requested, propname)];
          if (target.kind === 'book' && depth === '1') for (const file of Object.keys(book.records).sort()) {
            entries.push(responseXml({ ...target, kind: 'card', file }, book, book.records[file], requested, propname));
          }
          multistatus(req, res, entries); return;
        }
        if (req.method === 'PROPPATCH') {
          if (target.kind !== 'book' || !tree) throw error(400, '需要集合属性更新');
          const set = find(tree, 'set'), remove = find(tree, 'remove');
          const updates = [...(set ? findAll(set, 'prop').flatMap((node) => node.children).map((node) => ({ node, remove: false })) : []),
            ...(remove ? findAll(remove, 'prop').flatMap((node) => node.children).map((node) => ({ node, remove: true })) : [])];
          if (!updates.length || updates.some(({ node }) => !['displayname', 'addressbook-description'].includes(node.local))) throw error(403, '只允许更新名称与描述', davError('cannot-modify-protected-property'));
          for (const { node, remove: erase } of updates) {
            const value = erase ? '' : node.text;
            if (value.length > (node.local === 'displayname' ? 255 : 2000)) throw error(400, '属性过长');
            book[node.local === 'displayname' ? 'displayName' : 'description'] = value;
          }
          book.seq += 1; book.modified = new Date().toISOString(); await saveBook(userId, book);
          multistatus(req, res, [responseXml(target, book, null, updates.map(({ node }) => node.local))]); return;
        }
        if (req.method !== 'REPORT' || target.kind !== 'book' || !tree) throw error(405, '方法不支持');
        const report = tree.children[0];
        const requested = requestedProperties(tree) || ['getetag', 'address-data'];
        const addressData = find(tree, 'address-data');
        if (addressData && (addressData.children.length || (addressData.attrs['content-type'] && addressData.attrs['content-type'] !== 'text/vcard') || addressData.attrs.version)) {
          throw error(403, '本轮不支持 vCard 投影或版本转换', cardError('supported-address-data'));
        }
        if (find(tree, 'limit')) throw error(403, '本轮不支持报告分页', davError('number-of-matches-within-limits'));
        const entries = [];
        if (report.local === 'addressbook-query') {
          const matches = queryPredicate(tree);
          for (const file of Object.keys(book.records).sort()) {
            const card = book.records[file];
            if (matches(validateVcard(card.content))) entries.push(responseXml({ ...target, kind: 'card', file }, book, card, requested));
          }
        } else if (report.local === 'addressbook-multiget') {
          for (const node of findAll(tree, 'href')) {
            let picked;
            try {
              const pickedUrl = new URL(node.text, url.origin);
              const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : null;
              if (![url.origin, publicOrigin].includes(pickedUrl.origin) || pickedUrl.username || pickedUrl.password
                || pickedUrl.search || pickedUrl.hash) throw new Error('outside');
              const pickedPath = pathFromPublicUrl(config, pickedUrl);
              if (!pickedPath || !owns(pickedPath)) throw new Error('outside');
              picked = targetOf(pickedPath);
            } catch { entries.push(notFoundXml(node.text)); continue; }
            if (picked.username !== target.username || picked.bookId !== target.bookId || picked.kind !== 'card' || !book.records[picked.file]) entries.push(notFoundXml(node.text));
            else entries.push(responseXml(picked, book, book.records[picked.file], requested));
          }
        } else if (report.local === 'sync-collection') {
          const level = find(tree, 'sync-level')?.text;
          if (level && level !== '1') throw error(403, '仅支持 sync-level 1', davError('sync-traversal-supported'));
          const token = find(tree, 'sync-token')?.text || '';
          let since = -1;
          if (token) {
            const tokenMatch = /^urn:uuid:([0-9a-f-]+):(\d+)$/.exec(token);
            since = tokenMatch ? Number(tokenMatch[2]) : NaN;
            if (!tokenMatch || tokenMatch[1] !== book.epoch || !Number.isSafeInteger(since) || since > book.seq || since < book.floor) {
              throw error(403, '同步令牌过期或无效', davError('valid-sync-token'));
            }
          }
          for (const file of Object.keys(book.records).sort()) if (book.records[file].seq > since) {
            entries.push(responseXml({ ...target, kind: 'card', file }, book, book.records[file], requested));
          }
          if (since >= 0) for (const file of new Set(book.tombstones.filter((entry) => entry.seq > since && !book.records[entry.file]).map((entry) => entry.file))) {
            entries.push(notFoundXml(objectHref(target.username, target.bookId, file)));
          }
          multistatus(req, res, entries, tag(book)); return;
        } else throw error(403, '报告不支持', davError('supported-report'));
        multistatus(req, res, entries);
      });
      return true;
    } catch (err) {
      if (!err.status) logger.event('carddav-request-error', { method: req.method, code: err.code || 'internal' });
      if (!res.headersSent) send(req, res, err.status || 500,
        { 'Content-Type': err.xml ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' }, err.xml || `${err.status ? err.message : 'internal error'}\n`);
      return true;
    } finally {
      logger.access({ method: req.method, path: target ? href(target) : base, status: res.statusCode, ms: Date.now() - started, carddav: true });
    }
  }
  async function deleteUser(userId) {
    if (!ID.test(userId)) throw error(400, '账号标识无效');
    await fs.rm(path.join(root, userId), { recursive: true, force: true });
  }
  return { owns, handle, homeHref, deleteUser };
}

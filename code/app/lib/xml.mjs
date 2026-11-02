// Bounded XML 1.0 reader for DAV protocol messages. Namespace bindings are
// resolved at each element; DTDs and custom entities are never processed.

/** `D:prop` -> `prop`; `prop` -> `prop`. */
export function localName(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 10000;
const MAX_ATTRIBUTES = 256;
// XML 1.0 fifth-edition NCName ranges. A QName has at most one colon.
const START = 'A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}';
const PART = `${START}\\-.0-9\\u00b7\\u0300-\\u036f\\u203f-\\u2040`;
const NCNAME = `[${START}][${PART}]*`;
const NAME = new RegExp(`${NCNAME}(?::${NCNAME})?`, 'uy');
const SPACE = /[ \t\n\r]/;

function invalid(message) {
  return Object.assign(new Error(`Invalid XML: ${message}`), { status: 400, code: 'INVALID_XML' });
}

function validCharacter(code) {
  return code === 0x9 || code === 0xa || code === 0xd
    || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)
    || (code >= 0x10000 && code <= 0x10ffff);
}

function decodeEntities(text) {
  let result = '', offset = 0;
  while (offset < text.length) {
    const start = text.indexOf('&', offset);
    if (start < 0) return result + text.slice(offset);
    result += text.slice(offset, start);
    const end = text.indexOf(';', start + 1);
    if (end < 0) throw invalid('unterminated entity reference');
    const body = text.slice(start + 1, end);
    if (ENTITIES.has(body)) result += ENTITIES.get(body);
    else {
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(body)) throw invalid('unknown entity reference');
      const hex = body.startsWith('#x');
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!validCharacter(code)) throw invalid('invalid character reference');
      result += String.fromCodePoint(code);
    }
    offset = end + 1;
  }
  return result;
}

// Preserve the existing {} attribute shape without prototype mutation.
function setOwn(object, name, value) {
  Object.defineProperty(object, name, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Nodes retain {name, local, attrs, children, text} and add namespaceURI ('' for
 * unqualified elements). Whitespace is preserved after XML newline normalization.
 * Empty request bodies are allowed. Invalid/over-budget input throws status=400.
 */
export function parseXml(xml) {
  let source = xml == null ? '' : String(xml);
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw invalid('document size limit exceeded');
  for (const character of source) {
    if (!validCharacter(character.codePointAt(0))) throw invalid('invalid XML character');
  }
  source = source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const root = { name: '#document', local: '#document', namespaceURI: '', attrs: {}, children: [], text: '' };
  if (/^[ \t\n]*$/.test(source)) return root;
  const stack = [{ node: root, namespaces: new Map([['xml', XML], ['', '']]) }];
  let offset = 0, nodeCount = 0;
  const readName = () => {
    NAME.lastIndex = offset;
    const match = NAME.exec(source);
    if (!match) throw invalid('expected a qualified name');
    offset = NAME.lastIndex;
    return match[0];
  };
  const skipSpace = () => {
    const start = offset;
    while (offset < source.length && SPACE.test(source[offset])) offset += 1;
    return offset > start;
  };
  while (offset < source.length) {
    const current = stack[stack.length - 1];
    if (source[offset] !== '<') {
      const next = source.indexOf('<', offset);
      const end = next < 0 ? source.length : next;
      const text = source.slice(offset, end);
      if (text.includes(']]>')) throw invalid('CDATA terminator in character data');
      if (stack.length === 1 && !/^[ \t\n]*$/.test(text)) throw invalid('text outside the document element');
      current.node.text += decodeEntities(text);
      offset = end;
      continue;
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0) throw invalid('unterminated comment');
      const text = source.slice(offset + 4, end);
      if (text.includes('--') || text.endsWith('-')) throw invalid('invalid comment');
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<?', offset)) {
      const start = offset;
      offset += 2;
      const name = readName();
      const end = source.indexOf('?>', offset);
      if (end < 0) throw invalid('unterminated processing instruction');
      if (offset !== end && !SPACE.test(source[offset])) throw invalid('invalid processing instruction');
      if (name.toLowerCase() === 'xml') {
        const declaration = source.slice(start, end + 2);
        if (name !== 'xml' || start !== 0
          || !/^<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/.test(declaration)) {
          throw invalid('invalid or misplaced XML declaration');
        }
      }
      offset = end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', offset)) {
      if (stack.length === 1) throw invalid('CDATA outside the document element');
      const end = source.indexOf(']]>', offset + 9);
      if (end < 0) throw invalid('unterminated CDATA');
      current.node.text += source.slice(offset + 9, end);
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<!', offset)) throw invalid('DTD and markup declarations are unsupported');
    if (source.startsWith('</', offset)) {
      offset += 2;
      const name = readName();
      skipSpace();
      if (source[offset] !== '>' || stack.length === 1 || current.node.name !== name) {
        throw invalid('mismatched closing element');
      }
      stack.pop();
      offset += 1;
      continue;
    }
    offset += 1;
    const name = readName();
    const attrs = {};
    let attributeCount = 0;
    while (true) {
      const spaced = skipSpace();
      if (source[offset] === '>' || source.startsWith('/>', offset)) break;
      if (!spaced) throw invalid('attributes must be separated by whitespace');
      const attributeName = readName();
      if (Object.hasOwn(attrs, attributeName)) throw invalid('duplicate attribute');
      if (++attributeCount > MAX_ATTRIBUTES) throw invalid('attribute count limit exceeded');
      skipSpace();
      if (source[offset++] !== '=') throw invalid('expected attribute assignment');
      skipSpace();
      const quote = source[offset++];
      if (quote !== '"' && quote !== "'") throw invalid('attribute values must be quoted');
      const end = source.indexOf(quote, offset);
      if (end < 0) throw invalid('unterminated attribute');
      const value = source.slice(offset, end);
      if (value.includes('<')) throw invalid('markup inside an attribute');
      setOwn(attrs, attributeName, decodeEntities(value.replace(/[\t\n]/g, ' ')));
      offset = end + 1;
    }
    const selfClosing = source.startsWith('/>', offset);
    offset += selfClosing ? 2 : 1;
    if (stack.length === 1 && root.children.length) throw invalid('multiple document elements');
    if (stack.length > MAX_DEPTH) throw invalid('element depth limit exceeded');
    if (++nodeCount > MAX_NODES) throw invalid('element count limit exceeded');
    const namespaces = new Map(current.namespaces);
    for (const [attributeName, value] of Object.entries(attrs)) {
      if (attributeName !== 'xmlns' && !attributeName.startsWith('xmlns:')) continue;
      const prefix = attributeName === 'xmlns' ? '' : attributeName.slice(6);
      if (prefix === 'xmlns' || value === XMLNS || (prefix === 'xml') !== (value === XML)
        || (prefix && !value)) throw invalid('invalid namespace declaration');
      namespaces.set(prefix, value);
    }
    const namespaceOf = (qualifiedName, attribute = false) => {
      const separator = qualifiedName.indexOf(':');
      if (separator < 0) return attribute ? '' : namespaces.get('');
      const prefix = qualifiedName.slice(0, separator);
      if (prefix === 'xmlns' || !namespaces.has(prefix)) throw invalid('undeclared namespace prefix');
      return namespaces.get(prefix);
    };
    const namespaceURI = namespaceOf(name);
    const expandedAttributes = new Set();
    for (const attributeName of Object.keys(attrs)) {
      if (attributeName === 'xmlns' || attributeName.startsWith('xmlns:')) continue;
      const expanded = `${namespaceOf(attributeName, true)}\u0000${localName(attributeName)}`;
      if (expandedAttributes.has(expanded)) throw invalid('duplicate expanded attribute name');
      expandedAttributes.add(expanded);
    }
    const node = { name, local: localName(name), namespaceURI, attrs, children: [], text: '' };
    current.node.children.push(node);
    if (!selfClosing) stack.push({ node, namespaces });
  }
  if (stack.length !== 1) throw invalid('unclosed element');
  if (!root.children.length) throw invalid('missing document element');
  return root;
}

/** Depth-first elements by local name; optionally require a namespace URI. */
export function findAll(node, local, namespaceURI) {
  const out = [];
  const walk = (n) => {
    for (const child of n.children) {
      if (child.local === local && (namespaceURI === undefined || child.namespaceURI === namespaceURI)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** First matching descendant, optionally constrained by namespace URI. */
export function find(node, local, namespaceURI) {
  for (const child of node.children) {
    if (child.local === local && (namespaceURI === undefined || child.namespaceURI === namespaceURI)) return child;
    const nested = find(child, local, namespaceURI);
    if (nested) return nested;
  }
  return null;
}

/** Attributes of the first matching descendant, or {} when absent. */
export function attrsOf(node, local, namespaceURI) {
  return find(node, local, namespaceURI)?.attrs || {};
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

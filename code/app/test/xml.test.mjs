import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, find, findAll, attrsOf, escapeXml } from '../lib/xml.mjs';

test('XML resolves default, prefixed and rebound namespace scopes without losing text', () => {
  const tree = parseXml('<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><C:filter name="VEVENT">  Team &amp; Friends\r\n<![CDATA[<literal>]]></C:filter><filter xmlns="unrelated"/><C:filter xmlns:C="other"/><filter xmlns=""/></prop></propfind>');
  assert.equal(tree.children[0].namespaceURI, 'DAV:');
  assert.equal(find(tree, 'prop', 'DAV:').namespaceURI, 'DAV:');
  assert.equal(findAll(tree, 'filter').length, 4);
  const filter = find(tree, 'filter', 'urn:ietf:params:xml:ns:caldav');
  assert.equal(filter.text, '  Team & Friends\n<literal>');
  assert.deepEqual(attrsOf(tree, 'filter', 'urn:ietf:params:xml:ns:caldav'), { name: 'VEVENT' });
  assert.equal(find(tree, 'filter', '').namespaceURI, '');
  assert.equal(find(tree, 'filter', 'missing'), null);
  assert.deepEqual(attrsOf(tree, 'missing', 'DAV:'), {});
  assert.equal(find(tree, 'filter', 'other').namespaceURI, 'other');
});

test('XML entities, comments, attributes and Unicode names preserve protocol data', () => {
  const tree = parseXml('\ufeff<?xml version="1.0"?><!--before--><?example data?><属性 xmlns="urn:test" xml:lang="zh" title="a\tb&#10;c" __proto__="safe">&#x1f600; &quot;&apos;&lt;&gt;&amp;<!--inside--></属性>');
  const node = tree.children[0];
  assert.equal(node.local, '属性');
  assert.equal(node.text, '😀 "\'<>&');
  assert.equal(node.attrs.title, 'a b\nc');
  assert.equal(node.attrs.__proto__, 'safe');
  assert.equal(Object.getPrototypeOf(node.attrs), Object.prototype);
  assert.equal(escapeXml('a"<&>'), 'a&quot;&lt;&amp;&gt;');
  assert.equal(parseXml(' \r\n ').children.length, 0);
  assert.equal(parseXml(null).children.length, 0);
});

test('malformed XML and unsupported declarations fail with a protocol 400 error', () => {
  const cases = [
    '<a><b></a></b>', '<a>', '<a/><b/>', '</a>', 'before<a/>', '<a/>after', '<!--only-->', '\u00a0<a/>', '\u00a0',
    '<a x="one" x="two"/>', '<a x=one/>', '<a x="unterminated/>', '<a x="<"/>', '<a x="one"y="two"/>',
    '<a>&unknown;</a>', '<a>&amp</a>', '<a>&#x110000;</a>', '<a>&#0;</a>', '<a>&#xD800;</a>', '<a>&#12foo;</a>',
    '<a>&#x;</a>', '<a>&#X41;</a>', '<a>]]></a>', '<a>\u0000</a>', '<a>\ud800</a>',
    '<!DOCTYPE a><a/>', '<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>',
    '<a><!--not--valid--></a>', '<a><!--bad---></a>', '<a><![CDATA[unterminated</a>',
    '<![CDATA[outside]]><a/>', '<a><?pi unterminated</a>', '<?xml version="1.1"?><a/>',
    '<a/><?xml version="1.0"?>', ' <?xml version="1.0"?><a/>', '<?XML version="1.0"?><a/>',
    '<D:prop/>', '<a p:x="v"/>', '<a:b:c xmlns:a="urn:a"/>', '<a xmlns:p=""/>',
    '<a xmlns:xml="wrong"/>', '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
    '<a xmlns="http://www.w3.org/2000/xmlns/"/>', '<xmlns:a xmlns:xmlns="urn:a"/>',
    '<a xmlns:p="urn:same" xmlns:q="urn:same" p:x="1" q:x="2"/>',
  ];
  for (const source of cases) {
    assert.throws(() => parseXml(source), (error) => error.status === 400 && error.code === 'INVALID_XML', source);
  }
});

test('XML parser enforces bounded size, nesting, node and attribute counts', () => {
  for (const source of [
    '<a>'.repeat(129) + '</a>'.repeat(129),
    '<a>' + '<b/>'.repeat(10000) + '</a>',
    '<a ' + Array.from({ length: 257 }, (_, i) => `a${i}="v"`).join(' ') + '/>',
    '<a>' + 'x'.repeat(5 * 1024 * 1024) + '</a>',
  ]) {
    assert.throws(() => parseXml(source), (error) => error.status === 400 && /limit exceeded/.test(error.message));
  }
  assert.equal(parseXml('<a>'.repeat(128) + '</a>'.repeat(128)).children[0].local, 'a');
});

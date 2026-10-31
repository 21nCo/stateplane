import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExtraction, ExtractionError, extractionBounds, parserFor, textParser } from '../packages/application/dist/index.js';

const bytes = text => new TextEncoder().encode(text);
const refused = (run, reason, message) => assert.throws(run, error => error instanceof ExtractionError && error.reason === reason, message);

test('only the explicit text MIME types have a parser', () => {
  assert.deepEqual([...textParser.mimeTypes], ['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values']);
  for (const type of textParser.mimeTypes) assert.equal(parserFor(type), textParser, type);
  for (const type of ['text/html', 'text/xml', 'application/json', 'application/pdf', 'application/octet-stream', 'image/png',
    'TEXT/PLAIN', 'text/plain; charset=utf-8', '', null]) assert.equal(parserFor(type), null, String(type));
  assert.equal(Object.isFrozen(textParser) && Object.isFrozen(textParser.mimeTypes), true);
  assert.deepEqual({ name: textParser.name, version: textParser.version }, { name: 'stateplane.text', version: '1' });
});

test('the text parser keeps content verbatim and maps it to the original with code point and byte offsets', () => {
  assert.deepEqual(textParser.parse(bytes('line one\r\nline two\n')), { content: 'line one\r\nline two\n',
    sourceOffsets: [{ start: 0, end: 19, sourceStart: 0, sourceEnd: 19 }] }, 'newlines are not normalized');
  // 'é' is two bytes and one code point; the emoji is four bytes, two UTF-16 units and one code point.
  assert.deepEqual(textParser.parse(bytes('é😀x')), { content: 'é😀x', sourceOffsets: [{ start: 0, end: 3, sourceStart: 0, sourceEnd: 7 }] });
  assert.deepEqual(textParser.parse(bytes('﻿body')), { content: 'body', sourceOffsets: [{ start: 0, end: 4, sourceStart: 3, sourceEnd: 7 }] },
    'one leading byte order mark is skipped and the offsets say so');
  assert.deepEqual(textParser.parse(bytes('﻿﻿x')).content, '﻿x', 'only the first byte order mark is dropped');
  assert.deepEqual(textParser.parse(bytes('a﻿')).content, 'a﻿', 'a later U+FEFF is content');
  assert.deepEqual(textParser.parse(new Uint8Array(0)), { content: '', sourceOffsets: [] });
  assert.deepEqual(textParser.parse(bytes('﻿')), { content: '', sourceOffsets: [] });
});

test('the text parser refuses oversized, malformed and unstorable input', () => {
  const limit = new Uint8Array(extractionBounds.sourceBytes).fill(0x61);
  assert.equal(textParser.parse(limit).sourceOffsets[0].end, extractionBounds.sourceBytes, 'exactly the bound is accepted');
  refused(() => textParser.parse(new Uint8Array(extractionBounds.sourceBytes + 1).fill(0x61)), 'size', 'one byte over the bound');
  for (const [name, input] of [
    ['an invalid byte', [0x61, 0xff]], ['a truncated sequence', [0x61, 0xc3]], ['an overlong encoding', [0xc0, 0x80]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]], ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['a UTF-16 byte order mark', [0xff, 0xfe, 0x61, 0x00]], ['a lone continuation byte', [0x80]]
  ]) refused(() => textParser.parse(new Uint8Array(input)), 'encoding', name);
  refused(() => textParser.parse(bytes('a\u0000b')), 'content', 'NUL cannot be stored as extraction text');
});

test('every extraction, parsed or corrected, must satisfy the bounded offset contract', () => {
  const ok = (content, sourceOffsets, sourceBytes = 100) => checkExtraction({ content, sourceOffsets }, sourceBytes);
  ok('abcdef', [{ start: 0, end: 2, sourceStart: 10, sourceEnd: 12 }, { start: 2, end: 3, sourceStart: 0, sourceEnd: 0 },
    { start: 4, end: 6, sourceStart: 50, sourceEnd: 100 }]);
  ok('', []);
  ok('😀', [{ start: 0, end: 1, sourceStart: 0, sourceEnd: 4 }], 4);
  const segment = { start: 0, end: 1, sourceStart: 0, sourceEnd: 1 };
  for (const [name, content, sourceOffsets] of [
    ['an end past the content in code points', '😀', [{ ...segment, end: 2 }]],
    ['an empty content range', 'ab', [{ ...segment, end: 0 }]],
    ['a reversed content range', 'ab', [{ ...segment, start: 2, end: 1 }]],
    ['overlapping segments', 'abc', [{ ...segment, end: 2 }, { ...segment, start: 1, end: 3 }]],
    ['segments out of content order', 'abc', [{ ...segment, start: 2, end: 3 }, segment]],
    ['a negative offset', 'ab', [{ ...segment, sourceStart: -1 }]],
    ['a reversed source range', 'ab', [{ ...segment, sourceStart: 2, sourceEnd: 1 }]],
    ['a source range past the original', 'ab', [{ ...segment, sourceEnd: 101 }]],
    ['a fractional offset', 'ab', [{ ...segment, end: 1.5 }]],
    ['an unsafe integer', 'ab', [{ ...segment, sourceStart: 2 ** 53 }]],
    ['a string offset', 'ab', [{ ...segment, end: '1' }]],
    ['a hole', 'ab', new Array(1)],
    ['a null segment', 'ab', [null]],
    ['a primitive segment', 'ab', [1]],
    ['an accessor segment', 'ab', Object.defineProperty([], 0, { get: () => segment, enumerable: true })],
    ['too many segments', 'a'.repeat(extractionBounds.segments + 1),
      Array.from({ length: extractionBounds.segments + 1 }, (_, i) => ({ start: i, end: i + 1, sourceStart: 0, sourceEnd: 0 }))]
  ]) refused(() => ok(content, sourceOffsets), 'offsets', name);
  ok('a'.repeat(extractionBounds.segments),
    Array.from({ length: extractionBounds.segments }, (_, i) => ({ start: i, end: i + 1, sourceStart: 0, sourceEnd: 0 })));
  for (const [name, content] of [
    ['a NUL', 'a\u0000'], ['a lone high surrogate', 'a\uD800'], ['a lone low surrogate', '\uDC00a'],
    ['content over the byte bound', 'é'.repeat(extractionBounds.contentBytes / 2 + 1)],
    ['content over the bound in code units', 'a'.repeat(extractionBounds.contentBytes + 1)]
  ]) refused(() => ok(content, []), 'content', name);
  ok('é'.repeat(extractionBounds.contentBytes / 2), []);
});

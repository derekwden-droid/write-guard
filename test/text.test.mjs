import test from 'node:test';
import assert from 'node:assert/strict';
import { damageCounts, decode, encode, lineEndings, profile } from '../scripts/lib/text.mjs';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

test('decodes UTF-8 with and without a byte-order mark', () => {
  assert.deepEqual(decode(Buffer.from('caf' + String.fromCodePoint(0xe9), 'utf8')), {
    encoding: 'utf8',
    bom: false,
    text: 'caf' + String.fromCodePoint(0xe9),
  });
  assert.deepEqual(decode(Buffer.from([...UTF8_BOM, 0x61])), { encoding: 'utf8', bom: true, text: 'a' });
});

test('decodes UTF-16 with a byte-order mark in either byte order', () => {
  assert.deepEqual(decode(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), { encoding: 'utf16le', bom: true, text: 'hi' });
  assert.deepEqual(decode(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])), { encoding: 'utf16be', bom: true, text: 'hi' });
});

test('leaves UTF-32, legacy 8-bit and binary files undecoded', () => {
  assert.equal(decode(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x68, 0x00, 0x00, 0x00])).encoding, 'unknown');
  assert.equal(decode(Buffer.from([0x63, 0x61, 0x66, 0xe9])).encoding, 'unknown');
  assert.equal(decode(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])).encoding, 'binary');
  assert.equal(decode(Buffer.from([0xef, 0xbb, 0xbf, 0xff])).encoding, 'unknown');
  assert.equal(decode(Buffer.from([0xff, 0xfe, 0x68])).encoding, 'unknown');
});

test('encodes back to the same bytes', () => {
  const samples = [
    Buffer.from('plain\n', 'utf8'),
    Buffer.from([...UTF8_BOM, 0x61, 0x0d, 0x0a]),
    Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x0a, 0x00]),
    Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x0a]),
  ];
  for (const bytes of samples) {
    const { encoding, bom, text } = decode(bytes);
    assert.deepEqual(encode(text, encoding, bom), bytes);
  }
});

test('names the line-ending style', () => {
  assert.equal(lineEndings('a\nb\n').style, 'lf');
  assert.equal(lineEndings('a\r\nb\r\n').style, 'crlf');
  assert.equal(lineEndings('a\rb\r').style, 'cr');
  assert.equal(lineEndings('a\r\nb\n').style, 'mixed');
  assert.equal(lineEndings('no breaks').style, 'none');
  assert.deepEqual(lineEndings('a\r\r\nb\r\n'), { style: 'mixed', crlf: 2, lf: 0, cr: 1, crcrlf: 1 });
});

test('counts NUL bytes, replacement characters and other controls', () => {
  const text = 'a' + String.fromCharCode(0) + String.fromCodePoint(0xfffd) + String.fromCharCode(0x1b, 0x85) + '\t\r\n';
  assert.deepEqual(damageCounts(text), { nul: 1, replacement: 1, controls: 2 });
});

test('profiles a file in one call', () => {
  const info = profile(Buffer.from([...UTF8_BOM, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]));
  assert.equal(info.encoding, 'utf8');
  assert.equal(info.bom, true);
  assert.equal(info.eol.style, 'crlf');
  assert.equal(info.nul, 0);
  assert.equal(profile(Buffer.from([0x63, 0xe9])).text, null);
});

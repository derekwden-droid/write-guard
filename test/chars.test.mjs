import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKSLASH,
  CONTEXTUAL,
  CONTROL,
  INVISIBLE,
  PRIVATE_USE,
  classify,
  describe,
  escapeCodePoint,
  isBidi,
} from '../scripts/lib/chars.mjs';

test('ordinary characters, including tab and line breaks, are not classified', () => {
  for (const cp of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x5d0, 0x4e2d, 0x1f600, 0xfe0f]) {
    assert.equal(classify(cp), null, describe(cp));
  }
});

test('C0 controls, DEL and C1 controls are control characters', () => {
  for (const cp of [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
    assert.equal(classify(cp), CONTROL, describe(cp));
  }
});

test('invisible, bidi, separator, tag and non-character code points are invisible', () => {
  const cps = [
    0xad, 0x34f, 0x115f, 0x180e, 0x200b, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069,
    0x206f, 0x3164, 0xfeff, 0xffa0, 0xfff9, 0xfffd, 0x1d173, 0xe0001, 0xe0041, 0xe007f, 0xd800, 0xdfff,
    0xfdd0, 0xfffe, 0x1ffff, 0x10ffff,
  ];
  for (const cp of cps) assert.equal(classify(cp), INVISIBLE, describe(cp));
});

test('joiners and direction marks depend on context', () => {
  for (const cp of [0x61c, 0x200c, 0x200d, 0x200e, 0x200f]) assert.equal(classify(cp), CONTEXTUAL, describe(cp));
});

test('private-use code points are their own class', () => {
  for (const cp of [0xe000, 0xe010, 0xf8ff, 0xf0000, 0x10fffd]) assert.equal(classify(cp), PRIVATE_USE, describe(cp));
});

test('bidi controls are flagged as bidi', () => {
  assert.ok(isBidi(0x202e));
  assert.ok(isBidi(0x2067));
  assert.ok(!isBidi(0x200b));
});

test('escapes are spelled with four hex digits, as surrogate pairs above U+FFFF', () => {
  assert.equal(escapeCodePoint(0x200b), BACKSLASH + 'u200b');
  assert.equal(escapeCodePoint(0x200b, true), BACKSLASH + 'u200B');
  assert.equal(escapeCodePoint(0x1b), BACKSLASH + 'u001b');
  assert.equal(escapeCodePoint(0x1f600), BACKSLASH + 'ud83d' + BACKSLASH + 'ude00');
  assert.equal(escapeCodePoint(0xe0041), BACKSLASH + 'udb40' + BACKSLASH + 'udc41');
});

test('descriptions name the characters people need to recognise', () => {
  assert.equal(describe(0x202e), 'U+202E RIGHT-TO-LEFT OVERRIDE');
  assert.equal(describe(0x200b), 'U+200B ZERO WIDTH SPACE');
  assert.equal(describe(0x1b), 'U+001B ESC');
  assert.equal(describe(0x85), 'U+0085 C1 CONTROL');
  assert.equal(describe(0xe0041), 'U+E0041 TAG CHARACTER');
  assert.equal(describe(0xe010), 'U+E010 PRIVATE USE CHARACTER');
  assert.equal(describe(0xe9), 'U+00E9');
});

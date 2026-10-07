import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKSLASH } from '../scripts/lib/chars.mjs';
import {
  ALL_CLASSES,
  DEFAULT_CLASSES,
  FILE_STYLE,
  escapesMeaningfulIn,
  findEscapes,
  parseClasses,
  restoreText,
} from '../scripts/lib/restore.mjs';

// Strings are built from code points so this file never holds the characters it tests.
const ch = (...cps) => String.fromCodePoint(...cps);
const esc = (hex) => BACKSLASH + 'u' + hex;

test('restores an invisible character in a new file', () => {
  const r = restoreText('const sep = "' + ch(0x200b) + '";');
  assert.equal(r.text, 'const sep = "' + esc('200b') + '";');
  assert.deepEqual([...r.restored], [[0x200b, { count: 1, reason: 'invisible', escape: esc('200b') }]]);
});

test('restores bidi overrides and isolates, the Trojan Source pattern', () => {
  const r = restoreText('if (role == "user' + ch(0x202e, 0x2066) + '") {}');
  assert.equal(r.text, 'if (role == "user' + esc('202e') + esc('2066') + '") {}');
});

test('restores line and paragraph separators and a mid-text U+FEFF', () => {
  const r = restoreText('a' + ch(0x2028) + 'b' + ch(0x2029) + 'c' + ch(0xfeff) + 'd');
  assert.equal(r.text, 'a' + esc('2028') + 'b' + esc('2029') + 'c' + esc('feff') + 'd');
});

test('restores control characters, which Claude Code before 2.1.277 decoded too', () => {
  const r = restoreText("const red = '" + ch(0x1b) + "[31m';" + ch(0) + ch(0x85));
  assert.equal(r.text, "const red = '" + esc('001b') + "[31m';" + esc('0000') + esc('0085'));
});

test('restores lone surrogates and replacement characters', () => {
  const r = restoreText('x' + String.fromCharCode(0xd83d) + 'y' + ch(0xfffd));
  assert.equal(r.text, 'x' + esc('d83d') + 'y' + esc('fffd'));
});

test('leaves ordinary non-ASCII text alone', () => {
  const text = 'caf' + ch(0xe9) + ' ' + ch(0x4e2d, 0x6587) + ' ' + ch(0x1f600) + ' ' + ch(0x5e9, 0x5dc, 0x5d5, 0x5dd);
  const r = restoreText(text);
  assert.equal(r.text, text);
  assert.equal(r.restored.size, 0);
});

test('leaves joiners inside emoji sequences alone', () => {
  const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.equal(restoreText('family: ' + family).text, 'family: ' + family);
});

test('restores a joiner between ASCII characters', () => {
  assert.equal(restoreText('admin' + ch(0x200d) + 'user').text, 'admin' + esc('200d') + 'user');
  assert.equal(restoreText(ch(0x200c)).text, esc('200c'));
});

test('leaves a right-to-left mark inside Hebrew text alone', () => {
  const text = ch(0x5e9, 0x5dc, 0x5d5, 0x5dd, 0x200f) + '!';
  assert.equal(restoreText(text).text, text);
});

test('restores a right-to-left mark between ASCII quotes', () => {
  assert.equal(restoreText('"' + ch(0x200f) + '"').text, '"' + esc('200f') + '"');
});

test('leaves the tag characters of a subdivision flag alone', () => {
  const scotland = ch(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
  assert.equal(restoreText('flag ' + scotland).text, 'flag ' + scotland);
});

test('restores tag characters used to hide text', () => {
  const r = restoreText('hello' + ch(0xe0041, 0xe0042));
  assert.equal(r.text, 'hello' + esc('db40') + esc('dc41') + esc('db40') + esc('dc42'));
});

test('never touches a character the replaced text already had', () => {
  const zwsp = 'a' + ch(0x200b) + 'b';
  assert.equal(restoreText(zwsp, { oldText: 'x' + ch(0x200b) }).text, zwsp);
  assert.equal(restoreText(zwsp, { oldText: 'x' }).text, 'a' + esc('200b') + 'b');
});

test('treats a leading U+FEFF at the start of a file as a byte-order mark', () => {
  const text = ch(0xfeff) + 'csv,header';
  assert.equal(restoreText(text, { atFileStart: true }).text, text);
  assert.equal(restoreText(text).text, esc('feff') + 'csv,header');
});

test('leaves private-use characters raw and reports them unless enabled', () => {
  const text = 'icon = "' + ch(0xe010) + '"';
  const r = restoreText(text);
  assert.equal(r.text, text);
  assert.deepEqual([...r.leftRaw], [[0xe010, { count: 1, reason: 'private-use' }]]);
  const on = restoreText(text, { classes: parseClasses('control,invisible,private-use') });
  assert.equal(on.text, 'icon = "' + esc('e010') + '"');
});

test('the non-ascii class restores every non-ASCII character', () => {
  const r = restoreText('caf' + ch(0xe9) + ' ' + ch(0x1f600), { classes: parseClasses('non-ascii') });
  assert.equal(r.text, 'caf' + esc('00e9') + ' ' + esc('d83d') + esc('de00'));
});

test('restores characters that the file already spells as escapes', () => {
  const fileText = '{"name": "caf' + esc('00e9') + '"}\n';
  const r = restoreText('{"name": "caf' + ch(0xe9) + '", "other": "na' + ch(0xef) + 've"}\n', { oldText: fileText, fileText });
  assert.equal(r.text, '{"name": "caf' + esc('00e9') + '", "other": "na' + esc('00ef') + 've"}\n');
  assert.equal(r.restored.get(0xe9).reason, FILE_STYLE);
});

test('follows the file when it writes hex digits in upper case', () => {
  const fileText = 'msg = "' + esc('00E9') + '"\n';
  const r = restoreText('msg = "' + ch(0xe9) + ch(0x200b) + '"\n', { oldText: fileText, fileText });
  assert.equal(r.text, 'msg = "' + esc('00E9') + esc('200B') + '"\n');
  assert.equal(r.restored.get(0xe9).escape, esc('00E9'));
});

test('does not apply the file style when the file also has the raw character', () => {
  const fileText = 'a = "caf' + esc('00e9') + '"\nb = "caf' + ch(0xe9) + '"\n';
  const text = fileText + 'c = "caf' + ch(0xe9) + '"\n';
  assert.equal(restoreText(text, { oldText: fileText, fileText }).text, text);
});

test('ignores escapes of control characters when reading the file style', () => {
  const fileText = "const red = '" + esc('001b') + "[31m';\n";
  const text = fileText + "const greeting = 'caf" + ch(0xe9) + "';\n";
  assert.equal(restoreText(text, { oldText: fileText, fileText }).text, text);
});

test('turns the file style off where backslash-u is not an escape', () => {
  const fileText = 'caf' + esc('00e9') + '\n';
  const text = 'caf' + ch(0xe9) + '\n';
  assert.equal(restoreText(text, { oldText: '', fileText, escapesMeaningful: false }).text, text);
  assert.ok(escapesMeaningfulIn('C:\\repo\\src\\app.TS'));
  assert.ok(escapesMeaningfulIn('/repo/data/fr.json'));
  assert.ok(!escapesMeaningfulIn('/repo/README.md'));
  assert.ok(!escapesMeaningfulIn('/repo/Makefile'));
});

test('finds escapes, skipping escaped backslashes and pairing surrogates', () => {
  assert.deepEqual(findEscapes(esc('00e9')).map((e) => e.cp), [0xe9]);
  assert.deepEqual(findEscapes(BACKSLASH + esc('00e9')), []);
  assert.deepEqual(findEscapes(BACKSLASH + BACKSLASH + esc('00e9')).map((e) => e.cp), [0xe9]);
  assert.deepEqual(findEscapes(esc('d83d') + esc('de00')).map((e) => e.cp), [0x1f600]);
  assert.deepEqual(findEscapes(esc('12') + ' ' + BACKSLASH + 'x41').length, 0);
});

test('returns plain ASCII text untouched', () => {
  const text = 'export const x = 1;\n';
  const r = restoreText(text);
  assert.equal(r.text, text);
  assert.equal(r.restored.size, 0);
});

test('parses WRITE_GUARD_RESTORE', () => {
  assert.deepEqual(parseClasses(undefined), DEFAULT_CLASSES);
  assert.deepEqual(parseClasses(''), DEFAULT_CLASSES);
  assert.deepEqual(parseClasses('all'), new Set(ALL_CLASSES));
  assert.deepEqual(parseClasses(' Invisible , bogus '), new Set(['invisible']));
});

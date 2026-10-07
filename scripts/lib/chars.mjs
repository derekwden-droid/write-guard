// Which characters write-guard treats as suspicious, and how to spell one as an escape.
//
// Every code point in this file is written as a number. Claude Code decodes
// backslash-u escapes in Write and Edit text before it reaches the file, which is
// the bug this plugin exists for, so the source never spells one out.

export const BACKSLASH = String.fromCharCode(92);

// Character classes, from most to least certain that a raw occurrence is a decoded escape.
export const CONTROL = 'control';
export const INVISIBLE = 'invisible';
export const CONTEXTUAL = 'contextual';
export const PRIVATE_USE = 'private-use';

// Characters that render as nothing, reorder the text around them, or split lines where
// editors don't. Claude essentially never means to type one raw into a file.
const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xfffd, 0xfffd],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

// Characters that belong in real text: joiners inside emoji and Indic or Persian words,
// direction marks inside Arabic and Hebrew. Treated as suspicious only between ASCII.
const CONTEXTUAL_RANGES = [
  [0x061c, 0x061c],
  [0x200c, 0x200f],
];

const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

const NAMES = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x115f, 'HANGUL CHOSEONG FILLER'],
  [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x17b4, 'KHMER VOWEL INHERENT AQ'],
  [0x17b5, 'KHMER VOWEL INHERENT AA'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x3164, 'HANGUL FILLER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
  [0xffa0, 'HALFWIDTH HANGUL FILLER'],
  [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'],
  [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
  [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
  [0xfffd, 'REPLACEMENT CHARACTER'],
  [0xe0001, 'LANGUAGE TAG'],
]);

const C0_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US',
];

function inRanges(cp, ranges) {
  for (const [first, last] of ranges) {
    if (cp < first) return false;
    if (cp <= last) return true;
  }
  return false;
}

export function isPrivateUse(cp) {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

export function isNoncharacter(cp) {
  return (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
}

export function isSurrogate(cp) {
  return cp >= 0xd800 && cp <= 0xdfff;
}

export function isTagCharacter(cp) {
  return cp >= 0xe0020 && cp <= 0xe007f;
}

export function isBidi(cp) {
  return BIDI.has(cp);
}

// Returns the class of a code point, or null for an ordinary character. Tab, line feed
// and carriage return are ordinary.
export function classify(cp) {
  if (cp < 0x20) return cp === 0x09 || cp === 0x0a || cp === 0x0d ? null : CONTROL;
  if (cp < 0x7f) return null;
  if (cp <= 0x9f) return CONTROL;
  if (cp < 0xad) return null;
  if (isSurrogate(cp) || isNoncharacter(cp)) return INVISIBLE;
  if (isPrivateUse(cp)) return PRIVATE_USE;
  if (inRanges(cp, CONTEXTUAL_RANGES)) return CONTEXTUAL;
  if (inRanges(cp, INVISIBLE_RANGES)) return INVISIBLE;
  return null;
}

export function hex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

export function label(cp) {
  return 'U+' + hex(cp);
}

export function describe(cp) {
  let name = NAMES.get(cp);
  if (!name) {
    if (cp < 0x20) name = C0_NAMES[cp];
    else if (cp === 0x7f) name = 'DEL';
    else if (cp <= 0x9f) name = 'C1 CONTROL';
    else if (isSurrogate(cp)) name = 'LONE SURROGATE';
    else if (isNoncharacter(cp)) name = 'NONCHARACTER';
    else if (isTagCharacter(cp)) name = 'TAG CHARACTER';
    else if (cp >= 0x1d173 && cp <= 0x1d17a) name = 'MUSICAL FORMATTING CHARACTER';
    else if (isPrivateUse(cp)) name = 'PRIVATE USE CHARACTER';
  }
  return name ? label(cp) + ' ' + name : label(cp);
}

// Spells a code point the way Claude would have typed it: backslash-u and four hex
// digits, or a surrogate pair of them above U+FFFF.
export function escapeCodePoint(cp, upper = false) {
  if (cp > 0xffff) {
    const v = cp - 0x10000;
    return escapeCodePoint(0xd800 + (v >> 10), upper) + escapeCodePoint(0xdc00 + (v & 0x3ff), upper);
  }
  const digits = cp.toString(16).padStart(4, '0');
  return BACKSLASH + 'u' + (upper ? digits.toUpperCase() : digits);
}

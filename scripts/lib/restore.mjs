// Turning decoded characters back into the escapes Claude typed.
//
// Claude Code decodes backslash-u escapes in Write and Edit text before hooks run, so a
// hook sees the raw characters. A raw character can't say whether it was typed raw or
// typed as an escape, so write-guard restores only characters that are almost never
// typed raw, plus characters that the file being written already spells as escapes.

import path from 'node:path';
import { CONTEXTUAL, CONTROL, INVISIBLE, PRIVATE_USE, classify, escapeCodePoint, isTagCharacter } from './chars.mjs';

// The reasons a character can be restored. Each is also a value of WRITE_GUARD_RESTORE.
export const FILE_STYLE = 'file-style';
export const NON_ASCII = 'non-ascii';
export const ALL_CLASSES = [CONTROL, INVISIBLE, FILE_STYLE, PRIVATE_USE, NON_ASCII];
export const DEFAULT_CLASSES = new Set([CONTROL, INVISIBLE, FILE_STYLE]);

// Languages where backslash-u followed by four hex digits is an escape inside strings.
// The file-style rule applies only to these; in prose a backslash-u is just text.
const ESCAPE_LANGUAGES = new Set([
  'c', 'cc', 'cjs', 'clj', 'cljc', 'cljs', 'cpp', 'cs', 'cts', 'cxx', 'dart', 'edn', 'ex', 'exs', 'fs',
  'go', 'groovy', 'h', 'hh', 'hpp', 'java', 'jl', 'js', 'json', 'json5', 'jsonc', 'jsx', 'kt', 'kts',
  'm', 'mjs', 'mm', 'mts', 'properties', 'py', 'pyi', 'r', 'rb', 'scala', 'toml', 'ts', 'tsx', 'yaml', 'yml',
]);

export function escapesMeaningfulIn(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return ESCAPE_LANGUAGES.has(ext);
}

// True when the text holds anything other than printable ASCII, tab, LF and CR.
export function needsScan(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x7f || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) return true;
  }
  return false;
}

// Counts each code point that isn't printable ASCII, tab, LF or CR.
export function countCodePoints(text) {
  const counts = new Map();
  if (typeof text !== 'string') return counts;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if ((cp >= 0x20 && cp < 0x7f) || cp === 9 || cp === 10 || cp === 13) continue;
    counts.set(cp, (counts.get(cp) || 0) + 1);
  }
  return counts;
}

function hexValue(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

// Reads four hex digits at `at`. Returns the value, or -1 if they aren't there.
function readHex4(text, at) {
  let value = 0;
  for (let k = 0; k < 4; k++) {
    const d = hexValue(text.charCodeAt(at + k));
    if (d < 0) return -1;
    value = value * 16 + d;
  }
  return value;
}

// Finds the backslash-u escapes in a text. A backslash-u counts only when the backslash
// isn't itself escaped, and a surrogate pair of escapes counts as one code point.
export function findEscapes(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  for (let i = text.indexOf('\\'); i !== -1; i = text.indexOf('\\', i)) {
    let run = 1;
    while (text.charCodeAt(i + run) === 92) run++;
    const u = i + run;
    i = u;
    if (run % 2 === 0 || text.charCodeAt(u) !== 117) continue;
    const first = readHex4(text, u + 1);
    if (first < 0) continue;
    let cp = first;
    let end = u + 5;
    if (first >= 0xd800 && first <= 0xdbff && text.charCodeAt(end) === 92 && text.charCodeAt(end + 1) === 117) {
      const second = readHex4(text, end + 2);
      if (second >= 0xdc00 && second <= 0xdfff) {
        cp = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        end += 6;
      }
    }
    found.push({ cp, digits: text.slice(u + 1, u + 5) });
    i = end;
  }
  return found;
}

// How a file spells characters: the code points it writes as escapes, whether it writes
// hex digits in upper case, and whether it is ASCII apart from escaped text characters.
export function escapeStyle(text) {
  const escaped = new Set();
  let upper = 0;
  let lower = 0;
  let textEscapes = 0;
  for (const { cp, digits } of findEscapes(text)) {
    escaped.add(cp);
    if (cp >= 0xa0 && classify(cp) === null) textEscapes++;
    if (/[a-f]/.test(digits)) lower++;
    if (/[A-F]/.test(digits)) upper++;
  }
  let ascii = true;
  if (typeof text === 'string') {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) >= 0x80) {
        ascii = false;
        break;
      }
    }
  }
  return { escaped, upper: upper > lower, asciiWithEscapes: ascii && textEscapes > 0 };
}

function isQuiet(cp) {
  const cls = classify(cp);
  return cls === INVISIBLE || cls === CONTEXTUAL || cls === CONTROL;
}

// True when the nearest ordinary characters on both sides are ASCII, or the text ends.
function asciiAround(cps, k) {
  let j = k - 1;
  while (j >= 0 && isQuiet(cps[j])) j--;
  if (j >= 0 && cps[j] >= 0x80) return false;
  j = k + 1;
  while (j < cps.length && isQuiet(cps[j])) j++;
  return !(j < cps.length && cps[j] >= 0x80);
}

// Tag characters after U+1F3F4 spell a subdivision flag, such as Scotland's.
function inFlagSequence(cps, k) {
  let j = k;
  while (j >= 0 && isTagCharacter(cps[j])) j--;
  return j >= 0 && cps[j] === 0x1f3f4;
}

function bump(map, cp, reason, escape) {
  const entry = map.get(cp);
  if (entry) entry.count++;
  else map.set(cp, escape === undefined ? { count: 1, reason } : { count: 1, reason, escape });
}

// Restores the decoded characters in `newText` that write-guard is confident were typed
// as escapes. Options:
//   oldText     the text this write replaces: the whole file for Write, old_string for
//               Edit. A character it already contains is never touched.
//   fileText    the whole current file, read for its escape style. Null for a new file.
//   classes     which reasons to act on (see ALL_CLASSES).
//   atFileStart true when newText starts the file, so a leading U+FEFF is a byte-order mark.
//   escapesMeaningful  false for files where backslash-u isn't an escape, which turns
//               the file-style rule off.
// Returns the new text, the restored characters (code point to count and reason), and
// the private-use characters it left raw.
export function restoreText(newText, options = {}) {
  const {
    oldText = '',
    fileText = null,
    classes = DEFAULT_CLASSES,
    atFileStart = false,
    escapesMeaningful = true,
  } = options;
  const result = { text: newText, restored: new Map(), leftRaw: new Map() };
  if (typeof newText !== 'string' || !needsScan(newText)) return result;

  const before = countCodePoints(oldText);
  const style = escapesMeaningful && typeof fileText === 'string' ? escapeStyle(fileText) : null;
  const rawInFile = style ? countCodePoints(fileText) : null;

  const cps = [];
  const starts = [];
  for (let i = 0; i < newText.length; ) {
    const cp = newText.codePointAt(i);
    cps.push(cp);
    starts.push(i);
    i += cp > 0xffff ? 2 : 1;
  }

  let out = '';
  let copied = 0;
  for (let k = 0; k < cps.length; k++) {
    const cp = cps[k];
    if ((cp >= 0x20 && cp < 0x7f) || cp === 9 || cp === 10 || cp === 13) continue;
    const cls = classify(cp);
    let reason = null;
    if (cls === CONTROL || cls === INVISIBLE || cls === PRIVATE_USE) reason = cls;
    else if (cls === CONTEXTUAL) reason = asciiAround(cps, k) ? INVISIBLE : null;
    else if (cp >= 0xa0 && classes.has(NON_ASCII)) reason = NON_ASCII;
    else if (cp >= 0xa0 && style && (style.asciiWithEscapes || (style.escaped.has(cp) && !rawInFile.has(cp)))) {
      reason = FILE_STYLE;
    }
    if (!reason || before.has(cp)) continue;
    if (cp === 0xfeff && k === 0 && atFileStart) continue;
    if (isTagCharacter(cp) && inFlagSequence(cps, k)) continue;
    if (!classes.has(reason)) {
      if (reason === PRIVATE_USE) bump(result.leftRaw, cp, reason);
      continue;
    }
    const at = starts[k];
    const escape = escapeCodePoint(cp, style ? style.upper : false);
    out += newText.slice(copied, at) + escape;
    copied = at + (cp > 0xffff ? 2 : 1);
    bump(result.restored, cp, reason, escape);
  }
  if (copied > 0) result.text = out + newText.slice(copied);
  return result;
}

// Parses WRITE_GUARD_RESTORE: a comma-separated list of ALL_CLASSES, or "all".
export function parseClasses(value) {
  if (typeof value !== 'string' || value.trim() === '') return new Set(DEFAULT_CLASSES);
  const names = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.includes('all')) return new Set(ALL_CLASSES);
  return new Set(names.filter((n) => ALL_CLASSES.includes(n)));
}

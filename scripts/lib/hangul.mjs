// Spotting Hangul that was most likely typed as mis-spelled backslash-u escapes.
//
// Claude sometimes writes Korean in tool input as backslash-u escapes and gets a hex digit
// wrong (anthropics/claude-code#83033). The escape still decodes, to a real but wrong
// syllable, so nothing fails. A wrong code point lands outside the 2,350 everyday
// syllables of KS X 1001 about four times in five, while real Korean text almost never
// leaves them. write-guard can't know what was meant, so it only points these out.

import { COMMON, FIRST, LAST } from './ksx1001.mjs';

export function isSyllable(cp) {
  return cp >= FIRST && cp <= LAST;
}

export function isCommon(cp) {
  if (!isSyllable(cp)) return false;
  const i = cp - FIRST;
  return (COMMON[i >> 3] & (1 << (i & 7))) !== 0;
}

// The run of Hangul syllables around position `at`, for quoting the word a rare one is in.
function wordAround(text, at) {
  let from = at;
  while (from > 0 && isSyllable(text.charCodeAt(from - 1))) from--;
  let to = at + 1;
  while (to < text.length && isSyllable(text.charCodeAt(to))) to++;
  return text.slice(from, to);
}

// Finds the rare syllables in `newText` that `knownText` (the file, or the text being
// replaced) doesn't already use. Returns code point to { count, words }, at most three
// distinct words each.
export function rareHangul(newText, knownText = '') {
  const found = new Map();
  if (typeof newText !== 'string') return found;
  const known = typeof knownText === 'string' ? knownText : '';
  for (let i = 0; i < newText.length; i++) {
    const cp = newText.charCodeAt(i);
    if (!isSyllable(cp) || isCommon(cp)) continue;
    let entry = found.get(cp);
    if (!entry) {
      if (known.includes(newText[i])) continue;
      entry = { count: 0, words: [] };
      found.set(cp, entry);
    }
    entry.count++;
    const word = wordAround(newText, i);
    if (entry.words.length < 3 && !entry.words.includes(word)) entry.words.push(word);
  }
  return found;
}

// The note for Claude, or null when there is nothing to say.
export function rareHangulNote(tool, name, found) {
  if (found.size === 0) return null;
  const rows = [...found.entries()].slice(0, 10).map(([cp, entry]) =>
    '- ' + String.fromCharCode(cp) + ' (U+' + cp.toString(16).toUpperCase() + ') in ' + entry.words.join(', '));
  if (found.size > 10) rows.push('- and ' + (found.size - 10) + ' more');
  return (
    'write-guard: this ' + tool + ' to ' + name + ' has Hangul syllables outside the 2,350 that everyday Korean uses (KS X 1001):\n' +
    rows.join('\n') + '\n' +
    'Claude sometimes types Korean as backslash-u escapes and gets a hex digit wrong (anthropics/claude-code#83033), which ' +
    'turns into a real but wrong syllable. Check these words. If one is wrong, fix it with literal Hangul, never with an escape. ' +
    'If they are right (a name, slang, an old spelling), carry on.'
  );
}

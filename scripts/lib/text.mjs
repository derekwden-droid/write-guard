// Reading a file the way write-guard needs to see it: its encoding, byte-order mark,
// line endings, and the counts of bytes that mean damage.

import fs from 'node:fs';

export const MAX_BYTES = 16 * 1024 * 1024;

// ignoreBOM keeps a U+FEFF at the start of the input in the text instead of dropping it,
// so a second byte-order mark after the first one stays visible.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUtf16(bytes, bigEndian) {
  if (bytes.length % 2 !== 0) return null;
  const copy = Buffer.from(bytes);
  if (bigEndian) copy.swap16();
  return copy.toString('utf16le');
}

// Works out how a buffer is encoded. Returns the encoding, whether it starts with a
// byte-order mark, and the text without that mark. `utf8`, `utf16le` and `utf16be` are
// text; `binary` (has NUL bytes, not UTF-8) and `unknown` (an 8-bit legacy encoding,
// most likely) are files write-guard leaves alone.
export function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try {
      return { encoding: 'utf8', bom: true, text: utf8.decode(buf.subarray(3)) };
    } catch {
      return { encoding: 'unknown', bom: true, text: null };
    }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    if (buf.length >= 4 && buf[2] === 0 && buf[3] === 0) return { encoding: 'unknown', bom: true, text: null };
    const text = decodeUtf16(buf.subarray(2), false);
    return text === null ? { encoding: 'unknown', bom: true, text: null } : { encoding: 'utf16le', bom: true, text };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = decodeUtf16(buf.subarray(2), true);
    return text === null ? { encoding: 'unknown', bom: true, text: null } : { encoding: 'utf16be', bom: true, text };
  }
  try {
    return { encoding: 'utf8', bom: false, text: utf8.decode(buf) };
  } catch {
    return { encoding: buf.includes(0) ? 'binary' : 'unknown', bom: false, text: null };
  }
}

// Turns text back into bytes in a given encoding, with or without a byte-order mark.
export function encode(text, encoding, bom) {
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    if (encoding === 'utf16be') body.swap16();
    const mark = encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
    return bom ? Buffer.concat([mark, body]) : body;
  }
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// Counts line endings. A file is `lf`, `crlf` or `cr` when it uses one kind only,
// `mixed` when it uses more than one, and `none` when it has no line breaks.
export function lineEndings(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  let crcrlf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        if (i > 0 && text.charCodeAt(i - 1) === 13) crcrlf++;
        i++;
      } else {
        cr++;
      }
    } else if (c === 10) {
      lf++;
    }
  }
  const kinds = (crlf > 0) + (lf > 0) + (cr > 0);
  let style = 'none';
  if (kinds > 1) style = 'mixed';
  else if (crlf > 0) style = 'crlf';
  else if (lf > 0) style = 'lf';
  else if (cr > 0) style = 'cr';
  return { style, crlf, lf, cr, crcrlf };
}

// Counts the characters whose arrival in a file means something went wrong: NUL,
// the U+FFFD replacement character, and other control characters.
export function damageCounts(text) {
  let nul = 0;
  let replacement = 0;
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) nul++;
    else if (c === 0xfffd) replacement++;
    else if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f)) controls++;
  }
  return { nul, replacement, controls };
}

export function profile(buf) {
  const decoded = decode(buf);
  const result = { size: buf.length, encoding: decoded.encoding, bom: decoded.bom, text: decoded.text };
  if (decoded.text !== null) {
    result.eol = lineEndings(decoded.text);
    Object.assign(result, damageCounts(decoded.text));
  }
  return result;
}

// Reads a file for inspection. `exists` is false for a file that isn't there yet;
// `skip` is true for anything write-guard shouldn't touch: a directory, an unreadable
// path, a file over MAX_BYTES, or a file that isn't UTF-8 or UTF-16 text.
export function readFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { exists: false, skip: false };
    return { exists: false, skip: true };
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return { exists: true, skip: true };
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { exists: true, skip: true };
  }
  const info = profile(buf);
  return { exists: true, skip: info.text === null, buf, info };
}

#!/usr/bin/env node
// Scans files for what a diff doesn't show: invisible and bidirectional control
// characters, control and NUL bytes, U+FFFD replacement characters, text that isn't
// UTF-8 or UTF-16, mixed line endings, and byte-order marks.
//
//   node scan.mjs [path ...] [--json] [--fail] [--private-use]
//
// A folder inside a Git repository is listed with `git ls-files`, so ignored files are
// skipped; any other folder is walked, skipping dependency and build folders. Nothing is
// written. --fail exits with status 1 when hidden characters, damage or mixed line
// endings are found, for use in CI. --private-use also reports private-use characters,
// which icon fonts use legitimately.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTEXTUAL, CONTROL, INVISIBLE, PRIVATE_USE, classify, describe, isBidi, isTagCharacter } from './lib/chars.mjs';
import { decode, lineEndings } from './lib/text.mjs';

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_PER_FILE = 20;
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vs',
]);
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'pdf', 'zip', 'gz', 'tgz',
  'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'class', 'dll', 'exe', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'pdb',
  'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'flac', 'mov', 'avi', 'mkv',
  'webm', 'sqlite', 'db', 'bin', 'dat', 'pyc', 'pyo', 'npy', 'npz', 'parquet', 'xlsx', 'xls', 'docx', 'doc',
  'pptx', 'ppt', 'odt', 'ods', 'key', 'numbers', 'pages', 'heic', 'avif', 'blend', 'glb', 'fbx', 'unitypackage',
]);

function parseArgs(argv) {
  const options = { paths: [], json: false, fail: false, privateUse: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--fail') options.fail = true;
    else if (arg === '--private-use') options.privateUse = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.paths.push(arg);
  }
  if (options.paths.length === 0) options.paths.push('.');
  return options;
}

function gitFiles(dir) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean).map((rel) => path.join(dir, rel));
}

function gitAutocrlf(dir) {
  const result = spawnSync('git', ['config', '--get', 'core.autocrlf'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().toLowerCase() : '';
}

function walk(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, found);
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
}

function listFiles(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { files: [], missing: true };
  }
  if (stat.isFile()) return { files: [target] };
  const fromGit = gitFiles(target);
  if (fromGit) return { files: fromGit, git: true, autocrlf: gitAutocrlf(target) };
  const found = [];
  walk(target, found);
  return { files: found };
}

function asciiAround(text, start, end) {
  const before = start > 0 ? text.codePointAt(start - 1) : 0x20;
  const after = end < text.length ? text.codePointAt(end) : 0x20;
  return before < 0x80 && after < 0x80;
}

function flagTag(text, start) {
  let i = start;
  while (i >= 2) {
    const cp = text.codePointAt(i - 2);
    if (isTagCharacter(cp)) i -= 2;
    else break;
  }
  return i >= 2 && text.codePointAt(i - 2) === 0x1f3f4;
}

// UTF-16 text that lost its byte-order mark decodes as valid UTF-8 full of NUL bytes:
// mostly-ASCII text has a zero in every other byte. Returns the likely byte order.
export function utf16WithoutBom(buf) {
  if (buf.length < 4 || buf.length % 2 !== 0) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i % 2 === 0) even++;
      else odd++;
    }
  }
  const half = buf.length / 2;
  if (odd >= half * 0.4 && even <= half * 0.05) return 'UTF-16 LE';
  if (even >= half * 0.4 && odd <= half * 0.05) return 'UTF-16 BE';
  return null;
}

// Finds the hidden characters in one text, with their line and column.
export function findHidden(text, options = {}) {
  const hits = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    if (cp === 10) {
      line++;
      lineStart = i + 1;
    } else if (cp >= 0x7f || (cp < 0x20 && cp !== 9 && cp !== 13)) {
      const cls = classify(cp);
      let kind = null;
      if (cls === CONTROL) kind = cp === 0 ? 'nul' : 'control';
      else if (cls === INVISIBLE) kind = cp === 0xfffd ? 'replacement' : isBidi(cp) ? 'bidi' : 'invisible';
      else if (cls === CONTEXTUAL && asciiAround(text, i, i + width)) kind = isBidi(cp) ? 'bidi' : 'invisible';
      else if (cls === PRIVATE_USE && options.privateUse) kind = 'private-use';
      if (kind && isTagCharacter(cp) && flagTag(text, i)) kind = null;
      if (kind) hits.push({ line, column: i - lineStart + 1, cp, kind, what: describe(cp) });
    }
    i += width;
  }
  return hits;
}

export function scanFile(file, options = {}) {
  const report = { file, findings: [], bom: false, eol: null, encoding: null };
  const ext = path.extname(file).slice(1).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return null;
  let buf;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  const decoded = decode(buf);
  report.encoding = decoded.encoding;
  if (decoded.encoding === 'binary') return null;
  if (decoded.text === null) {
    report.findings.push({ kind: 'encoding', what: 'not valid UTF-8 or UTF-16 text (a legacy 8-bit encoding, or damaged)' });
    return report;
  }
  if (decoded.encoding === 'utf8' && !decoded.bom) {
    const guess = utf16WithoutBom(buf);
    if (guess) {
      report.findings.push({ kind: 'encoding', what: 'looks like ' + guess + ' text without a byte-order mark, so most tools will read it as binary' });
      return report;
    }
  }
  report.bom = decoded.bom;
  const text = decoded.text;
  const eol = lineEndings(text);
  report.eol = eol.style;
  if (eol.style === 'mixed') {
    report.findings.push({ kind: 'mixed-eol', what: 'mixed line endings (' + eol.crlf + ' CRLF, ' + eol.lf + ' LF' + (eol.cr ? ', ' + eol.cr + ' CR' : '') + ')' });
  }
  for (const hit of findHidden(text, options)) report.findings.push(hit);
  return report;
}

const SERIOUS = new Set(['bidi', 'invisible', 'control', 'nul', 'replacement', 'encoding', 'mixed-eol', 'private-use']);

export function scan(paths, options = {}) {
  const reports = [];
  const roots = [];
  for (const target of paths) {
    const listed = listFiles(path.resolve(target));
    roots.push({
      path: target,
      missing: Boolean(listed.missing),
      git: Boolean(listed.git),
      autocrlf: listed.autocrlf || '',
      files: listed.files.length,
    });
    for (const file of listed.files) {
      const report = scanFile(file, options);
      if (report) reports.push(report);
    }
  }
  const withFindings = reports.filter((r) => r.findings.length > 0);
  const counts = {};
  for (const r of withFindings) for (const f of r.findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const boms = reports.filter((r) => r.bom).map((r) => r.file);
  const crlf = reports.filter((r) => r.eol === 'crlf').map((r) => r.file);
  const lf = reports.filter((r) => r.eol === 'lf').map((r) => r.file);
  return { roots, scanned: reports.length, withFindings, counts, boms, crlf, lf };
}

function relative(file) {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function printText(result) {
  const out = [];
  for (const root of result.roots) {
    if (root.missing) out.push('Not found: ' + root.path);
  }
  out.push('Scanned ' + result.scanned + ' text ' + (result.scanned === 1 ? 'file' : 'files') + '.');
  if (result.withFindings.length === 0) {
    out.push('No hidden characters, control bytes, replacement characters, encoding damage or mixed line endings.');
  } else {
    for (const report of result.withFindings) {
      out.push('');
      out.push(relative(report.file));
      for (const f of report.findings.slice(0, MAX_PER_FILE)) {
        const where = f.line ? '  ' + f.line + ':' + f.column + '  ' : '  ';
        const tag = f.kind === 'bidi' ? 'bidi control (Trojan Source pattern)' : f.kind;
        out.push(where + f.what + (f.line ? '  [' + tag + ']' : ''));
      }
      if (report.findings.length > MAX_PER_FILE) out.push('  ... and ' + (report.findings.length - MAX_PER_FILE) + ' more');
    }
    out.push('');
    out.push('Totals: ' + Object.entries(result.counts).map(([k, n]) => n + ' ' + k).join(', '));
  }
  if (result.boms.length > 0) {
    out.push('');
    out.push(result.boms.length + ' ' + (result.boms.length === 1 ? 'file starts' : 'files start') + ' with a byte-order mark:');
    for (const f of result.boms.slice(0, MAX_PER_FILE)) out.push('  ' + relative(f));
    if (result.boms.length > MAX_PER_FILE) out.push('  ... and ' + (result.boms.length - MAX_PER_FILE) + ' more');
  }
  if (result.crlf.length > 0 && result.lf.length > 0) {
    const minority = result.crlf.length <= result.lf.length ? ['CRLF', result.crlf, 'LF', result.lf.length] : ['LF', result.lf, 'CRLF', result.crlf.length];
    out.push('');
    out.push(minority[1].length + ' ' + (minority[1].length === 1 ? 'file uses' : 'files use') + ' ' + minority[0] + ' line endings while ' + minority[3] + ' use ' + minority[2] + ':');
    for (const f of minority[1].slice(0, MAX_PER_FILE)) out.push('  ' + relative(f));
    if (minority[1].length > MAX_PER_FILE) out.push('  ... and ' + (minority[1].length - MAX_PER_FILE) + ' more');
    if (result.roots.some((r) => r.autocrlf === 'true')) {
      out.push("Git's core.autocrlf is true here, so Git stores LF for text files when you commit and the mix exists only in your working copy.");
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: node scan.mjs [path ...] [--json] [--fail] [--private-use]\n');
    return;
  }
  const result = scan(options.paths, options);
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printText(result);
  const serious = Object.keys(result.counts).some((k) => SERIOUS.has(k));
  if (options.fail && serious) process.exitCode = 1;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'scan.mjs') main();

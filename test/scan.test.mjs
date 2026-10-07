import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findHidden, scan, utf16WithoutBom } from '../scripts/scan.mjs';

const SCAN = fileURLToPath(new URL('../scripts/scan.mjs', import.meta.url));
const ch = (...cps) => String.fromCodePoint(...cps);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-guard-scan-'));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function tree(name, files) {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function cli(args) {
  const result = spawnSync(process.execPath, [SCAN, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

const sample = tree('sample', {
  'clean.js': 'const a = 1;\n',
  'zwsp.js': 'const a = "' + ch(0x200b) + '";\n',
  'bidi.js': 'const b = 1;\nif (x' + ch(0x202e) + ') {}\n',
  'emoji.md': 'family ' + ch(0x1f468, 0x200d, 0x1f469) + '\n',
  'hebrew.md': ch(0x5e9, 0x5dc, 0x5d5, 0x5dd, 0x200f) + '!\n',
  'flag.md': ch(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f) + '\n',
  'icons.toml': 'home = "' + ch(0xe010) + '"\n',
  'mixed.txt': 'a\r\nb\n',
  'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  'utf16-no-bom.txt': Buffer.from('hello world\n', 'utf16le'),
  'bom.txt': Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0a]),
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  'node_modules/dep/index.js': 'x = "' + ch(0x200b) + '"\n',
});

test('reports the line and column of each hidden character', () => {
  const hits = findHidden('ab\nc' + ch(0x200b) + 'd' + ch(0x202e) + ch(0) + ch(0xfffd));
  assert.deepEqual(hits.map((h) => [h.line, h.column, h.kind]), [
    [2, 2, 'invisible'],
    [2, 4, 'bidi'],
    [2, 5, 'nul'],
    [2, 6, 'replacement'],
  ]);
});

test('does not report emoji joiners, Hebrew direction marks or flag tags', () => {
  assert.deepEqual(findHidden(ch(0x1f468, 0x200d, 0x1f469)), []);
  assert.deepEqual(findHidden(ch(0x5d0, 0x200f) + '!'), []);
  assert.deepEqual(findHidden(ch(0x1f3f4, 0xe0067, 0xe0062, 0xe007f)), []);
});

test('scans a folder and groups findings by file', () => {
  const result = scan([sample]);
  const byName = Object.fromEntries(result.withFindings.map((r) => [path.basename(r.file), r.findings.map((f) => f.kind)]));
  assert.deepEqual(byName, {
    'zwsp.js': ['invisible'],
    'bidi.js': ['bidi'],
    'mixed.txt': ['mixed-eol'],
    'latin1.txt': ['encoding'],
    'utf16-no-bom.txt': ['encoding'],
  });
  assert.deepEqual(result.boms.map((f) => path.basename(f)), ['bom.txt']);
  assert.equal(result.withFindings.some((r) => r.file.includes('node_modules')), false);
});

test('reports private-use characters only when asked', () => {
  const quiet = scan([path.join(sample, 'icons.toml')]);
  assert.equal(quiet.withFindings.length, 0);
  const loud = scan([path.join(sample, 'icons.toml')], { privateUse: true });
  assert.equal(loud.withFindings[0].findings[0].kind, 'private-use');
});

test('recognises UTF-16 text that lost its byte-order mark', () => {
  assert.equal(utf16WithoutBom(Buffer.from('hello', 'utf16le')), 'UTF-16 LE');
  assert.equal(utf16WithoutBom(Buffer.from('hello', 'utf16le').swap16()), 'UTF-16 BE');
  assert.equal(utf16WithoutBom(Buffer.from('hello!', 'utf8')), null);
});

test('--fail exits 1 when something is found and 0 when the files are clean', () => {
  const dirty = cli([sample, '--fail']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /RIGHT-TO-LEFT OVERRIDE/);
  assert.match(dirty.stdout, /Trojan Source/);
  const clean = cli([path.join(sample, 'clean.js'), '--fail']);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /No hidden characters/);
});

test('--json prints the result as JSON', () => {
  const { status, stdout } = cli([path.join(sample, 'zwsp.js'), '--json']);
  assert.equal(status, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.scanned, 1);
  assert.equal(result.counts.invisible, 1);
});

test('skips files that Git ignores', (t) => {
  const repo = tree('repo', {
    '.gitignore': 'ignored.js\n',
    'ignored.js': 'x = "' + ch(0x200b) + '"\n',
    'tracked.js': 'x = 1\n',
  });
  const init = spawnSync('git', ['init', '-q'], { cwd: repo });
  if (init.error || init.status !== 0) {
    t.skip('git is not available');
    return;
  }
  const result = scan([repo]);
  assert.equal(result.withFindings.length, 0);
  assert.equal(result.scanned, 2);
});

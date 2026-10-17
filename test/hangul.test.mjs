// The Hangul check: syllables outside KS X 1001 in new text, the likely result of
// mis-spelled backslash-u escapes (anthropics/claude-code#83033). Hangul is built from code
// points so this file stays plain ASCII.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCommon, rareHangul, rareHangulNote } from '../scripts/lib/hangul.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/write-guard.mjs', import.meta.url));
const k = (...cps) => String.fromCharCode(...cps);

// The words from the issue, as meant and as the mis-spelled escapes decoded.
const DONE = k(0xc644, 0xb8cc, 0xb41c);
const DONE_BAD = k(0xc644, 0xb9b7, 0xb41c);
const CODING = k(0xcf54, 0xb529, 0xd558, 0xae30);
const CODING_BAD = k(0xcf54, 0xb505, 0xd558, 0xae30);
const HELLO = k(0xc548, 0xb155, 0xd558, 0xc138, 0xc694);
const TOM = k(0xb620); // a real syllable outside KS X 1001, as in the Thai dish's name

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-guard-hangul-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the table holds exactly the 2,350 KS X 1001 syllables', () => {
  let n = 0;
  for (let cp = 0xac00; cp <= 0xd7a3; cp++) if (isCommon(cp)) n++;
  assert.equal(n, 2350);
  // KS X 1001's last syllable is U+D79D; U+D7A3, the last precomposed one, isn't in it.
  for (const cp of [0xac00, 0xd79d, 0xc548, 0xb155, 0xb8cc, 0xb529]) assert.ok(isCommon(cp), cp.toString(16));
  for (const cp of [0xb9b7, 0xb505, 0xb620, 0xd7a3]) assert.ok(!isCommon(cp), cp.toString(16));
  assert.ok(!isCommon(0x41));
});

test('finds the mis-spelled syllables from the issue and quotes their words', () => {
  const found = rareHangul(HELLO + ' ' + DONE_BAD + ', ' + CODING_BAD + ' ' + DONE + ' ' + CODING);
  assert.deepEqual([...found.keys()], [0xb9b7, 0xb505]);
  assert.deepEqual(found.get(0xb9b7), { count: 1, words: [DONE_BAD] });
  assert.deepEqual(found.get(0xb505), { count: 1, words: [CODING_BAD] });
});

test('says nothing for ordinary Korean or text without Hangul', () => {
  assert.equal(rareHangul(HELLO + ' ' + DONE + ' ' + CODING).size, 0);
  assert.equal(rareHangul('plain ASCII').size, 0);
  assert.equal(rareHangul(null).size, 0);
});

test('skips a rare syllable the file already uses', () => {
  assert.equal(rareHangul(TOM + ' ' + HELLO, 'menu: ' + TOM).size, 0);
  assert.equal(rareHangul(TOM + ' ' + HELLO, HELLO).size, 1);
});

test('the note names each syllable, its code point and the issue', () => {
  const note = rareHangulNote('Write', 'ko.md', rareHangul(DONE_BAD));
  assert.match(note, /U\+B9B7/);
  assert.ok(note.includes(DONE_BAD));
  assert.match(note, /83033/);
  assert.match(note, /never with an escape/);
  assert.equal(rareHangulNote('Write', 'ko.md', new Map()), null);
});

function pre(toolName, toolInput, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, 'pre'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_use_id: 'toolu_hangul_' + Math.random(), tool_input: toolInput }),
    encoding: 'utf8',
    env: { CLAUDE_PLUGIN_DATA: path.join(root, 'data'), SystemRoot: process.env.SystemRoot, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('a Write with a mis-spelled syllable gets a note and is left unchanged', () => {
  const target = path.join(root, 'notes.md');
  const reply = pre('Write', { file_path: target, content: '# ' + HELLO + '\n\n' + DONE_BAD + '\n' });
  const out = reply.hookSpecificOutput;
  assert.equal(out.updatedInput, undefined);
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /outside the 2,350/);
  assert.match(reply.systemMessage, /unusual Hangul in notes\.md/);
});

test('an Edit is checked against the file and its old_string', () => {
  const target = path.join(root, 'menu.md');
  fs.writeFileSync(target, TOM + ' soup\n');
  assert.equal(pre('Edit', { file_path: target, old_string: 'soup', new_string: TOM + ' ' + HELLO }), null);
  const reply = pre('Edit', { file_path: target, old_string: 'soup', new_string: CODING_BAD });
  assert.match(reply.hookSpecificOutput.additionalContext, /U\+B505/);
  assert.doesNotMatch(reply.hookSpecificOutput.additionalContext, /U\+B620/);
});

test('ordinary Korean passes silently, and WRITE_GUARD_MODE=off turns the check off', () => {
  const target = path.join(root, 'ok.md');
  assert.equal(pre('Write', { file_path: target, content: HELLO + ' ' + DONE + '\n' }), null);
  assert.equal(pre('Write', { file_path: target, content: DONE_BAD + '\n' }, { WRITE_GUARD_MODE: 'off' }), null);
});

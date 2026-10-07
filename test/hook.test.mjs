// Runs scripts/write-guard.mjs the way Claude Code does: hook input as JSON on stdin,
// reply as JSON on stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKSLASH } from '../scripts/lib/chars.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/write-guard.mjs', import.meta.url));
const ch = (...cps) => String.fromCodePoint(...cps);
const esc = (hex) => BACKSLASH + 'u' + hex;
const BOM = ch(0xfeff);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-guard-test-'));
const dataDir = path.join(root, 'data');
let counter = 0;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function file(name, bytes) {
  const p = path.join(root, name);
  if (bytes !== undefined) fs.writeFileSync(p, bytes);
  return p;
}

function run(phase, input, settings = {}) {
  const vars = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  for (const k of Object.keys(vars)) if (k.startsWith('WRITE_GUARD_')) delete vars[k];
  const result = spawnSync(process.execPath, [SCRIPT, phase], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...vars, ...settings },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    reply: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function call(tool, toolInput, event = 'PreToolUse') {
  counter += 1;
  return { hook_event_name: event, tool_name: tool, tool_use_id: 'toolu_test_' + counter, tool_input: toolInput };
}

test('restores a decoded escape in a Write to a new file', () => {
  const target = file('new.ts');
  const { status, reply } = run('pre', call('Write', { file_path: target, content: 'const s = "' + ch(0x200b) + '";\n' }));
  assert.equal(status, 0);
  const out = reply.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, undefined);
  assert.deepEqual(out.updatedInput, { file_path: target, content: 'const s = "' + esc('200b') + '";\n' });
  assert.match(out.additionalContext, /U\+200B ZERO WIDTH SPACE/);
  assert.match(out.additionalContext, /72957/);
  assert.match(reply.systemMessage, /restored 1 escape in new\.ts/);
});

test('keeps the byte-order mark and CRLF endings of a file that Write overwrites', () => {
  const target = file('crlf-bom.txt', Buffer.concat([UTF8_BOM, Buffer.from('old\r\nlines\r\n')]));
  const { reply } = run('pre', call('Write', { file_path: target, content: 'new\nlines\n' }));
  assert.equal(reply.hookSpecificOutput.updatedInput.content, BOM + 'new\r\nlines\r\n');
  assert.match(reply.hookSpecificOutput.additionalContext, /byte-order mark and CRLF line endings/);
  assert.equal(reply.systemMessage, undefined);
});

test('keeps the byte-order mark of a UTF-16 file', () => {
  const target = file('utf16.txt', Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
  const { reply } = run('pre', call('Write', { file_path: target, content: 'hello' }));
  assert.equal(reply.hookSpecificOutput.updatedInput.content, BOM + 'hello');
});

test('says nothing about a plain Write to a plain file', () => {
  const target = file('plain.txt', 'old\n');
  const { status, reply } = run('pre', call('Write', { file_path: target, content: 'new\n' }));
  assert.equal(status, 0);
  assert.equal(reply, null);
});

test('respects WRITE_GUARD_KEEP_FORMAT=0', () => {
  const target = file('keep-off.txt', Buffer.concat([UTF8_BOM, Buffer.from('a\r\n')]));
  const { reply } = run('pre', call('Write', { file_path: target, content: 'b\n' }), { WRITE_GUARD_KEEP_FORMAT: '0' });
  assert.equal(reply, null);
});

test('restores a decoded escape in an Edit without touching old_string', () => {
  const target = file('edit.js', 'const x = 1;\n');
  const input = { file_path: target, old_string: 'const x = 1;', new_string: 'const x = "' + ch(0x202e) + '";', replace_all: false };
  const { reply } = run('pre', call('Edit', input));
  assert.deepEqual(reply.hookSpecificOutput.updatedInput, { ...input, new_string: 'const x = "' + esc('202e') + '";' });
  assert.match(reply.hookSpecificOutput.additionalContext, /Trojan Source/);
});

test('leaves an Edit alone when old_string already holds the character', () => {
  const target = file('edit-same.js', 'a = "' + ch(0x200b) + '"\n');
  const input = { file_path: target, old_string: 'a = "' + ch(0x200b) + '"', new_string: 'b = "' + ch(0x200b) + '"' };
  assert.equal(run('pre', call('Edit', input)).reply, null);
});

test('restores every edit in a MultiEdit', () => {
  const target = file('multi.js', 'a\nb\n');
  const input = {
    file_path: target,
    edits: [
      { old_string: 'a', new_string: 'a' + ch(0x2066) },
      { old_string: 'b', new_string: 'b' },
    ],
  };
  const { reply } = run('pre', call('MultiEdit', input));
  assert.equal(reply.hookSpecificOutput.updatedInput.edits[0].new_string, 'a' + esc('2066'));
  assert.equal(reply.hookSpecificOutput.updatedInput.edits[1].new_string, 'b');
});

test('restores a decoded escape in a NotebookEdit', () => {
  const target = file('nb.ipynb', JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1\n'] }] }));
  const input = { notebook_path: target, cell_id: 'c1', new_source: 'x = "' + ch(0x200b) + '"', cell_type: 'code' };
  const { reply } = run('pre', call('NotebookEdit', input));
  assert.equal(reply.hookSpecificOutput.updatedInput.new_source, 'x = "' + esc('200b') + '"');
});

test('warn mode reports without changing the input', () => {
  const target = file('warn.ts');
  const { reply } = run('pre', call('Write', { file_path: target, content: ch(0x200b) }), { WRITE_GUARD_MODE: 'warn' });
  assert.equal(reply.hookSpecificOutput.updatedInput, undefined);
  assert.match(reply.hookSpecificOutput.additionalContext, /warn mode/);
});

test('block mode denies the call', () => {
  const target = file('block.ts');
  const { reply } = run('pre', call('Write', { file_path: target, content: ch(0x202e) }), { WRITE_GUARD_MODE: 'block' });
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /WRITE_GUARD_MODE is block/);
});

test('off mode does nothing', () => {
  const target = file('off.ts');
  assert.equal(run('pre', call('Write', { file_path: target, content: ch(0x202e) }), { WRITE_GUARD_MODE: 'off' }).reply, null);
});

test('skips files that are not UTF-8 or UTF-16 text', () => {
  const target = file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.equal(run('pre', call('Write', { file_path: target, content: ch(0x200b) })).reply, null);
});

test('ignores tools it does not handle', () => {
  assert.equal(run('pre', call('Bash', { command: 'ls' })).reply, null);
});

test('fails open with status 1 on bad input', () => {
  const bad = run('pre', 'not json');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^write-guard: /);
  const usage = run('sideways', {});
  assert.equal(usage.status, 1);
});

// The post hook needs the record the pre hook left, so these run pre, change the file
// the way the tool (or a bug) would, then run post with the same tool_use_id.
function prePost(tool, target, toolInput, mutate, settings = {}) {
  const pre = call(tool, toolInput);
  const before = run('pre', pre, settings).reply;
  const writtenInput = before && before.hookSpecificOutput.updatedInput ? before.hookSpecificOutput.updatedInput : toolInput;
  mutate(writtenInput);
  const after = run('post', { ...pre, hook_event_name: 'PostToolUse', tool_input: writtenInput }, settings);
  return after.reply;
}

test('post reports line endings that a write flipped', () => {
  const target = file('flip.txt', 'a\nb\n');
  const reply = prePost('Edit', target, { file_path: target, old_string: 'a', new_string: 'A' }, () => {
    fs.writeFileSync(target, 'A\r\nb\r\n');
  });
  assert.match(reply.hookSpecificOutput.additionalContext, /changed line endings from LF to CRLF/);
  assert.match(reply.systemMessage, /^write-guard: flip\.txt /);
});

test('post reports a lost byte-order mark when write-guard was told not to keep it', () => {
  const target = file('lost-bom.txt', Buffer.concat([UTF8_BOM, Buffer.from('a\n')]));
  const reply = prePost('Write', target, { file_path: target, content: 'b\n' }, (input) => {
    fs.writeFileSync(target, input.content);
  }, { WRITE_GUARD_KEEP_FORMAT: '0' });
  assert.match(reply.hookSpecificOutput.additionalContext, /lost its byte-order mark/);
});

test('post is quiet when the write landed as intended', () => {
  const target = file('fine.txt', Buffer.concat([UTF8_BOM, Buffer.from('a\r\n')]));
  const reply = prePost('Write', target, { file_path: target, content: 'b\n' }, (input) => {
    fs.writeFileSync(target, Buffer.from(input.content, 'utf8'));
  });
  assert.deepEqual(fs.readFileSync(target), Buffer.concat([UTF8_BOM, Buffer.from('b\r\n')]));
  assert.equal(reply, null);
});

test('post removes a byte-order mark and carriage returns that ended up doubled', () => {
  const target = file('doubled.txt', Buffer.concat([UTF8_BOM, Buffer.from('a\r\n')]));
  const reply = prePost('Write', target, { file_path: target, content: 'b\nc\n' }, (input) => {
    // A future Claude Code that keeps both itself would write its own on top of ours.
    const text = input.content.replace(/\r\n/g, '\r\r\n');
    fs.writeFileSync(target, Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]));
  });
  assert.deepEqual(fs.readFileSync(target), Buffer.concat([UTF8_BOM, Buffer.from('b\r\nc\r\n')]));
  assert.match(reply.hookSpecificOutput.additionalContext, /doubled byte-order mark and doubled carriage returns/);
});

test('post reports NUL bytes and replacement characters the write did not contain', () => {
  const target = file('nul.txt');
  const reply = prePost('Write', target, { file_path: target, content: 'box: ' + ch(0x2500) + '\n' }, () => {
    fs.writeFileSync(target, Buffer.from([0x62, 0x6f, 0x78, 0x3a, 0x20, 0x00, 0x0a]));
  });
  assert.match(reply.hookSpecificOutput.additionalContext, /1 NUL byte the write did not contain/);
});

test('post reports a file that stopped being UTF-8', () => {
  const target = file('broken.txt', 'caf' + ch(0xe9) + '\n');
  const reply = prePost('Edit', target, { file_path: target, old_string: 'caf', new_string: 'Caf' }, () => {
    fs.writeFileSync(target, Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]));
  });
  assert.match(reply.hookSpecificOutput.additionalContext, /no longer UTF-8 or UTF-16 text \(it was UTF-8\)/);
});

test('post skips the damage check for replace_all edits', () => {
  const target = file('replace-all.txt', 'a a\n');
  const reply = prePost('Edit', target, { file_path: target, old_string: 'a', new_string: 'b', replace_all: true }, () => {
    fs.writeFileSync(target, 'b' + ch(0) + ' b\n');
  });
  assert.equal(reply, null);
});

test('cleanup drops the record so post has nothing to check', () => {
  const target = file('failed.txt', 'a\n');
  const pre = call('Edit', { file_path: target, old_string: 'zzz', new_string: 'y' });
  run('pre', pre);
  run('cleanup', { ...pre, hook_event_name: 'PostToolUseFailure', error: 'String to replace not found' });
  fs.writeFileSync(target, 'a\r\n');
  assert.equal(run('post', { ...pre, hook_event_name: 'PostToolUse' }).reply, null);
});

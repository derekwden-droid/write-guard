// What write-guard does before and after each Write, Edit, MultiEdit and NotebookEdit.
// scripts/write-guard.mjs feeds it the hook input and prints the reply.
//
// Settings come from the environment:
//   WRITE_GUARD_MODE         restore (default), warn, block or off
//   WRITE_GUARD_RESTORE      comma-separated: control, invisible, file-style (the default
//                            three), private-use, non-ascii, or all
//   WRITE_GUARD_KEEP_FORMAT  0 stops write-guard keeping byte-order marks and CRLF endings

import fs from 'node:fs';
import path from 'node:path';
import { CONTROL, describe, escapeCodePoint, isBidi, label } from './chars.mjs';
import { FILE_STYLE, escapesMeaningfulIn, parseClasses, restoreText } from './restore.mjs';
import { rareHangul, rareHangulNote } from './hangul.mjs';
import { damageCounts, encode, profile, readFile } from './text.mjs';
import * as state from './state.mjs';

const MODES = new Set(['restore', 'warn', 'block', 'off']);
const BOM = String.fromCharCode(0xfeff);
const ISSUE = 'anthropics/claude-code#72957';

// Reads the three WRITE_GUARD_ variables by name and nothing else from the environment.
export function readSettings() {
  const mode = String(process.env.WRITE_GUARD_MODE || 'restore').trim().toLowerCase();
  return {
    mode: MODES.has(mode) ? mode : 'restore',
    classes: parseClasses(process.env.WRITE_GUARD_RESTORE),
    keepFormat: String(process.env.WRITE_GUARD_KEEP_FORMAT || '1').trim() !== '0',
  };
}

// ---------------------------------------------------------------------------- messages

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function total(map) {
  let n = 0;
  for (const entry of map.values()) n += entry.count;
  return n;
}

function listCharacters(map, withEscape) {
  const rows = [...map.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);
  const lines = rows.slice(0, 10).map(([cp, entry]) => {
    let line = '- ' + entry.count + 'x ' + describe(cp);
    if (entry.reason === FILE_STYLE) line += ' (this file spells it as an escape)';
    else if (isBidi(cp)) line += ' (a bidirectional control, the Trojan Source pattern)';
    else if (entry.reason === CONTROL) line += ' (a control character)';
    if (withEscape) line += ', now written as ' + (entry.escape || escapeCodePoint(cp));
    return line;
  });
  if (rows.length > 10) lines.push('- and ' + (rows.length - 10) + ' more');
  return lines.join('\n');
}

function shortList(map) {
  const cps = [...map.keys()];
  return cps.slice(0, 4).map(label).join(', ') + (cps.length > 4 ? ', ...' : '');
}

function formatParts(format) {
  const parts = [];
  if (format.includes('bom')) parts.push('byte-order mark');
  if (format.includes('crlf')) parts.push('CRLF line endings');
  return parts.join(' and ');
}

function restoredMessage(tool, name, restored) {
  const n = total(restored);
  return (
    'write-guard restored ' + plural(n, 'escape', 'escapes') + ' in this ' + tool + ' to ' + name + '. ' +
    'Claude Code decodes backslash-u escapes in Write and Edit text into raw characters before the file is written (' + ISSUE + '). ' +
    'These would have reached the file raw, so write-guard put back the escape text:\n' +
    listCharacters(restored, true) + '\n' +
    'If you wanted the raw characters themselves, write them with a shell command.'
  );
}

function warnMessage(tool, name, restored) {
  return (
    'write-guard (warn mode): this ' + tool + ' puts raw characters into ' + name + ' that were most likely typed as ' +
    'backslash-u escapes and decoded by Claude Code before the write (' + ISSUE + '):\n' +
    listCharacters(restored, false) + '\n' +
    'Nothing was changed. Set WRITE_GUARD_MODE to restore to have write-guard put the escapes back.'
  );
}

function blockReason(tool, name, restored) {
  return (
    'write-guard blocked this ' + tool + ' to ' + name + ' because WRITE_GUARD_MODE is block. ' +
    'Claude Code decoded backslash-u escapes in it into raw characters (' + ISSUE + '):\n' +
    listCharacters(restored, false) + '\n' +
    'To keep the escape text, write the file with a shell command. To leave these characters out, send the call again without them.'
  );
}

function leftRawNote(name, leftRaw) {
  return (
    'Note: ' + name + ' received private-use characters raw:\n' + listCharacters(leftRaw, false) + '\n' +
    'If you typed them as escapes and wanted the escape text kept, add private-use to WRITE_GUARD_RESTORE.'
  );
}

// ---------------------------------------------------------------------------- pre

function notebookText(text) {
  if (typeof text !== 'string') return '';
  try {
    const notebook = JSON.parse(text);
    const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
    return cells.map((cell) => (Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || ''))).join('\n');
  } catch {
    return '';
  }
}

function summarize(info) {
  return {
    encoding: info.encoding,
    bom: info.bom,
    style: info.eol.style,
    nul: info.nul,
    replacement: info.replacement,
    controls: info.controls,
  };
}

// PreToolUse. Restores decoded escapes in the text Claude is about to write and, for a
// Write over an existing file, keeps the file's byte-order mark and CRLF line endings.
// Returns the hook reply, or null to let the call through unchanged.
export function pre(input, settings) {
  const tool = input.tool_name;
  const args = input.tool_input;
  if (!args || typeof args !== 'object') return null;
  const target = tool === 'NotebookEdit' ? args.notebook_path : args.file_path;
  if (typeof target !== 'string' || target === '') return null;

  const file = readFile(target);
  if (file.skip) return null;
  const fileText = file.exists ? file.info.text : null;
  const common = { classes: settings.classes, escapesMeaningful: escapesMeaningfulIn(target) };

  const updated = { ...args };
  const restored = new Map();
  const leftRaw = new Map();
  const format = [];
  const merge = (result) => {
    for (const [from, to] of [[result.restored, restored], [result.leftRaw, leftRaw]]) {
      for (const [cp, entry] of from) {
        const seen = to.get(cp);
        if (seen) seen.count += entry.count;
        else to.set(cp, { ...entry });
      }
    }
    return result.text;
  };

  if (tool === 'Write' && typeof args.content === 'string') {
    let content = merge(restoreText(args.content, { ...common, oldText: fileText || '', fileText, atFileStart: true }));
    if (file.exists) {
      if (file.info.bom && content.charCodeAt(0) !== 0xfeff) format.push('bom');
      if (file.info.eol.style === 'crlf' && content.includes('\n') && !content.includes('\r')) format.push('crlf');
      if (settings.keepFormat && settings.mode !== 'warn') {
        if (format.includes('bom')) content = BOM + content;
        if (format.includes('crlf')) content = content.replace(/\n/g, '\r\n');
      }
    }
    updated.content = content;
  } else if (tool === 'Edit' && typeof args.new_string === 'string') {
    const oldText = typeof args.old_string === 'string' ? args.old_string : '';
    updated.new_string = merge(restoreText(args.new_string, { ...common, oldText, fileText }));
  } else if (tool === 'MultiEdit' && Array.isArray(args.edits)) {
    updated.edits = args.edits.map((edit) => {
      if (!edit || typeof edit.new_string !== 'string') return edit;
      const oldText = typeof edit.old_string === 'string' ? edit.old_string : '';
      return { ...edit, new_string: merge(restoreText(edit.new_string, { ...common, oldText, fileText })) };
    });
  } else if (tool === 'NotebookEdit' && typeof args.new_source === 'string') {
    const cells = notebookText(fileText);
    const options = { ...common, oldText: cells, fileText: cells, escapesMeaningful: args.cell_type !== 'markdown' };
    updated.new_source = merge(restoreText(args.new_source, options));
  } else {
    return null;
  }

  const name = path.basename(target);
  // Hangul that looks like a mis-spelled escape: each new text, with the text it can be
  // compared against so a rare syllable the file already uses isn't reported.
  const rare = new Map();
  let written;
  if (tool === 'Write') written = [[args.content, fileText]];
  else if (tool === 'NotebookEdit') written = [[args.new_source, notebookText(fileText)]];
  else {
    const edits = tool === 'Edit' ? [args] : args.edits;
    written = edits.filter(Boolean).map((edit) => [edit.new_string, String(edit.old_string || '') + (fileText || '')]);
  }
  for (const [text, known] of written) {
    for (const [cp, entry] of rareHangul(text, known)) {
      const seen = rare.get(cp);
      if (!seen) rare.set(cp, entry);
      else {
        seen.count += entry.count;
        for (const word of entry.words) if (seen.words.length < 3 && !seen.words.includes(word)) seen.words.push(word);
      }
    }
  }
  const found = restored.size > 0;
  const keptFormat = format.length > 0 && settings.keepFormat && settings.mode !== 'warn';
  const blocking = settings.mode === 'block' && found;

  if (tool !== 'NotebookEdit' && !blocking) {
    state.save(input.tool_use_id, {
      v: 1,
      tool,
      file: target,
      before: file.exists ? summarize(file.info) : null,
      added: keptFormat ? format : [],
    });
  }

  const reply = { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
  if (blocking) {
    reply.hookSpecificOutput.permissionDecision = 'deny';
    reply.hookSpecificOutput.permissionDecisionReason = blockReason(tool, name, restored);
    return reply;
  }
  const notes = [];
  if (settings.mode === 'warn') {
    if (found) notes.push(warnMessage(tool, name, restored));
    if (format.length > 0) notes.push('write-guard (warn mode): this Write drops the ' + formatParts(format) + ' of ' + name + '.');
  } else {
    if (found) {
      notes.push(restoredMessage(tool, name, restored));
      reply.systemMessage = 'write-guard restored ' + plural(total(restored), 'escape', 'escapes') + ' in ' + name + ': ' + shortList(restored);
    }
    if (keptFormat) {
      notes.push('write-guard kept the ' + formatParts(format) + ' of ' + name + ', which Claude Code\'s Write tool drops when it overwrites a file. ' +
        'If removing ' + (format.length > 1 ? 'them' : 'it') + ' was the point, do it with a short script; write-guard only acts on Write and Edit.');
    }
    if (found || keptFormat) reply.hookSpecificOutput.updatedInput = updated;
  }
  if (leftRaw.size > 0) notes.push(leftRawNote(name, leftRaw));
  const hangulNote = rareHangulNote(tool, name, rare);
  if (hangulNote) {
    notes.push(hangulNote);
    const flagged = [...rare.keys()].slice(0, 4).map((cp) => String.fromCharCode(cp)).join(', ');
    reply.systemMessage = (reply.systemMessage ? reply.systemMessage + '; ' : 'write-guard: ') +
      'unusual Hangul in ' + name + ' (' + flagged + '), possibly mis-spelled escapes';
  }
  if (notes.length === 0) return null;
  reply.hookSpecificOutput.additionalContext = notes.join('\n\n');
  return reply;
}

// ---------------------------------------------------------------------------- post

const ENCODING_NAMES = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', binary: 'binary', unknown: 'an unknown encoding' };
const STYLE_NAMES = { lf: 'LF', crlf: 'CRLF', cr: 'CR', mixed: 'a mix of line endings', none: 'no line breaks' };

// How much damage the file should hold after this call: what it held before, plus what
// the call itself wrote. Null when that can't be worked out, as with replace_all.
function expectedDamage(tool, args, before) {
  if (tool === 'Write') return typeof args.content === 'string' ? damageCounts(args.content) : null;
  if (!before) return null;
  const edits = tool === 'Edit' ? [args] : Array.isArray(args.edits) ? args.edits : [];
  const expected = { nul: before.nul, replacement: before.replacement, controls: before.controls };
  for (const edit of edits) {
    if (!edit || typeof edit.new_string !== 'string' || edit.replace_all) return null;
    const added = damageCounts(edit.new_string);
    const removed = damageCounts(typeof edit.old_string === 'string' ? edit.old_string : '');
    for (const k of Object.keys(expected)) expected[k] += Math.max(0, added[k] - removed[k]);
  }
  return expected;
}

// Removes a byte-order mark or carriage return that write-guard added on top of one
// Claude Code kept by itself. Returns what it fixed.
function undoDoubling(target, info, added) {
  let text = info.text;
  const fixed = [];
  if (added.includes('bom') && info.bom && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    fixed.push('a doubled byte-order mark');
  }
  if (added.includes('crlf') && info.eol.crcrlf > 0) {
    text = text.replace(/\r\r\n/g, '\r\n');
    fixed.push('doubled carriage returns');
  }
  if (fixed.length > 0) fs.writeFileSync(target, encode(text, info.encoding, info.bom));
  return fixed;
}

// PostToolUse. Checks the file on disk against what it was before the call and what the
// call wrote, and reports anything that changed without being asked for.
export function post(input) {
  const record = state.take(input.tool_use_id);
  if (!record || typeof record.file !== 'string') return null;
  const target = record.file;
  const name = path.basename(target);
  const before = record.before;
  const file = readFile(target);
  if (!file.exists || (file.skip && !file.info)) return null;

  const problems = [];
  let fixed = [];
  if (file.skip) {
    problems.push('is no longer UTF-8 or UTF-16 text' + (before ? ' (it was ' + ENCODING_NAMES[before.encoding] + ')' : ''));
  } else {
    let info = file.info;
    fixed = undoDoubling(target, info, Array.isArray(record.added) ? record.added : []);
    if (fixed.length > 0) info = profile(fs.readFileSync(target));

    if (before) {
      if (before.encoding !== info.encoding) {
        problems.push('changed encoding from ' + ENCODING_NAMES[before.encoding] + ' to ' + ENCODING_NAMES[info.encoding]);
      }
      if (before.bom && !info.bom) problems.push('lost its byte-order mark');
      if (!before.bom && info.bom) problems.push('gained a byte-order mark it did not have before');
      const was = before.style;
      const now = info.eol.style;
      if ((was === 'lf' || was === 'crlf') && now !== was && now !== 'none') {
        problems.push('changed line endings from ' + STYLE_NAMES[was] + ' to ' + STYLE_NAMES[now] +
          (now === 'mixed' ? ' (' + info.eol.crlf + ' CRLF, ' + info.eol.lf + ' LF)' : ''));
      }
    } else if (info.eol.style === 'mixed') {
      problems.push('has mixed line endings (' + info.eol.crlf + ' CRLF, ' + info.eol.lf + ' LF)');
    }

    const expected = expectedDamage(record.tool, input.tool_input || {}, before);
    if (expected) {
      if (info.nul > expected.nul) {
        problems.push('holds ' + plural(info.nul - expected.nul, 'NUL byte', 'NUL bytes') + ' the write did not contain');
      }
      if (info.replacement > expected.replacement) {
        problems.push('holds ' + plural(info.replacement - expected.replacement, 'U+FFFD replacement character', 'U+FFFD replacement characters') +
          ' the write did not contain, a sign that bytes were decoded with the wrong encoding');
      }
      if (info.controls > expected.controls) {
        problems.push('holds ' + plural(info.controls - expected.controls, 'control character', 'control characters') + ' the write did not contain');
      }
    }
  }

  if (problems.length === 0 && fixed.length === 0) return null;
  const notes = [];
  const user = [];
  if (fixed.length > 0) {
    notes.push('write-guard removed ' + fixed.join(' and ') + ' from ' + name + '. Claude Code kept the original itself this time, ' +
      'so the one write-guard added was extra. The file is correct now.');
    user.push('fixed ' + fixed.join(' and '));
  }
  if (problems.length > 0) {
    notes.push('write-guard checked ' + name + ' after this ' + record.tool + '. The file ' + problems.join('; ') + '. ' +
      'If that was not intended, fix it before going on. Write and Edit work on text and cannot set these bytes directly, so use a short script.');
    user.push(problems.join('; '));
  }
  return {
    systemMessage: 'write-guard: ' + name + ' ' + user.join('; '),
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n\n') },
  };
}

// PostToolUseFailure. The call failed, so there is nothing on disk to check.
export function cleanup(input) {
  state.discard(input.tool_use_id);
  return null;
}

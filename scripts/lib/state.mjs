// What the PreToolUse hook hands to the PostToolUse hook for the same tool call.
//
// Each record is a few hundred bytes of metadata (encoding, byte-order mark, line-ending
// counts, what write-guard changed). File contents are never stored. Records live in the
// plugin's data folder, or the system temp folder when Claude Code doesn't provide one,
// and are deleted as soon as the matching PostToolUse or PostToolUseFailure hook runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 6 * 60 * 60 * 1000;

function folder() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'write-guard');
  return path.join(base, 'pending');
}

function recordPath(id) {
  return path.join(folder(), String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

// Deletes records whose tool call never finished, such as a write the user declined.
function sweep(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      // Another hook may have removed it first.
    }
  }
}

export function save(id, record) {
  if (!id) return;
  const dir = folder();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath(id), JSON.stringify(record), { mode: 0o600 });
  if (Math.random() < 0.05) sweep(dir);
}

export function take(id) {
  if (!id) return null;
  const p = recordPath(id);
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  discard(id);
  return record;
}

export function discard(id) {
  if (!id) return;
  try {
    fs.unlinkSync(recordPath(id));
  } catch {
    // Already gone.
  }
}

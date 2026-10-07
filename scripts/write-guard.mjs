#!/usr/bin/env node
// write-guard's hook entry point. The plugin's hooks.json runs it as:
//   node write-guard.mjs pre      PreToolUse, for Write, Edit, MultiEdit and NotebookEdit
//   node write-guard.mjs post     PostToolUse, for Write, Edit and MultiEdit
//   node write-guard.mjs cleanup  PostToolUseFailure, for the same three
// It reads the hook input as JSON on standard input and prints a JSON reply, or nothing.
// Any error exits with status 1, which Claude Code reports without blocking the call.

import { cleanup, post, pre, readSettings } from './lib/hook.mjs';

const phase = process.argv[2];
const handlers = { pre, post, cleanup };

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (!Object.hasOwn(handlers, phase)) {
    process.stderr.write('usage: node write-guard.mjs pre|post|cleanup, with the hook input as JSON on stdin\n');
    process.exitCode = 1;
    return;
  }
  const input = JSON.parse(await readStdin());
  const settings = readSettings();
  const reply = settings.mode === 'off' ? cleanup(input) : handlers[phase](input, settings);
  if (reply) process.stdout.write(JSON.stringify(reply));
}

main().catch((err) => {
  process.stderr.write('write-guard: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exitCode = 1;
});

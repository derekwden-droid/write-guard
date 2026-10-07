# Changelog

## 1.0.0 - 2026-10-07

- PreToolUse hook for Write, Edit, MultiEdit and NotebookEdit that restores backslash-u escapes
  Claude Code decodes into control, invisible and bidirectional characters, and keeps a file's
  escape style for ordinary characters.
- Write over an existing file keeps its UTF-8 or UTF-16 byte-order mark and CRLF line endings.
- PostToolUse hook that reports encoding changes, byte-order marks that appeared or disappeared,
  flipped or mixed line endings, and NUL bytes, U+FFFD and control characters a write didn't
  contain.
- `/write-guard:scan` skill and `scripts/scan.mjs` for finding the same problems in existing files.

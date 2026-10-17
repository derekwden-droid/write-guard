# Changelog

## 1.1.0 - 2026-10-17

- Before each Write, Edit, MultiEdit and NotebookEdit, flags Hangul syllables outside the 2,350
  of KS X 1001 that the file doesn't already use. These are the usual result of Claude typing
  Korean as escapes with a wrong hex digit (anthropics/claude-code#83033). Claude gets a note
  quoting each word to check; the text is never changed. `WRITE_GUARD_MODE=off` turns it off.

## 1.0.0 - 2026-10-07

- PreToolUse hook for Write, Edit, MultiEdit and NotebookEdit that restores backslash-u escapes
  Claude Code decodes into control, invisible and bidirectional characters, and keeps a file's
  escape style for ordinary characters.
- Write over an existing file keeps its UTF-8 or UTF-16 byte-order mark and CRLF line endings.
- PostToolUse hook that reports encoding changes, byte-order marks that appeared or disappeared,
  flipped or mixed line endings, and NUL bytes, U+FFFD and control characters a write didn't
  contain.
- `/write-guard:scan` skill and `scripts/scan.mjs` for finding the same problems in existing files.

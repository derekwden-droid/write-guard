---
name: scan
description: Scan a folder or repository for what a diff won't show - invisible and bidirectional control characters (the Trojan Source pattern), stray control and NUL bytes, U+FFFD replacement characters left by mojibake, text that isn't valid UTF-8 or UTF-16, UTF-16 files that lost their byte-order mark, mixed line endings, and byte-order marks. Use when someone asks to check files for hidden or invisible characters, encoding damage or line-ending problems, or wants to know whether earlier edits planted any.
license: MIT
compatibility: Needs Node.js 20 or later and a folder on the user's computer, as in Claude Code. It can't run in claude.ai chat.
---

# Scan for hidden characters and byte damage

write-guard ships a scanner that reads text files and reports what a diff doesn't show. Run it with Node:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan.mjs" <path> [more paths]
```

Use the folders or files the user names. With none named, scan the project root. Inside a Git repository the scanner lists files with `git ls-files`, so ignored files are skipped. Elsewhere it walks the folder and skips dependency and build folders such as `node_modules`, `dist` and `.venv`. It reads files and writes nothing.

- `--private-use` also lists private-use characters. Icon fonts use these on purpose, so they're off by default.
- `--json` prints the result as JSON, if you need to process it.
- `--fail` exits with status 1 when it finds anything, for CI.

If `node` isn't available, say so plainly. Never report a file as clean without running the scanner: these characters are invisible by design and easy to miss when reading a file.

## Reading the report

Each finding shows `line:column`, the code point, its name and a kind:

- **bidi control (Trojan Source pattern)**: U+202A to U+202E and U+2066 to U+2069 reorder how text is displayed, so source code can read differently from how it runs (CVE-2021-42574). Treat one in source code as a security problem until shown otherwise.
- **invisible**: zero-width spaces, word joiners, soft hyphens, line and paragraph separators, a U+FEFF that isn't a byte-order mark, and tag characters, which can hide text from a reviewer.
- **control** and **nul**: control bytes that don't belong in text.
- **replacement**: U+FFFD, left behind when bytes were decoded with the wrong encoding. The original character is gone from the file.
- **encoding**: the file isn't valid UTF-8 or UTF-16, or it is UTF-16 that lost its byte-order mark, which most tools then read as binary.
- **mixed-eol**: the file uses more than one kind of line ending.

After the findings, the report lists files that start with a byte-order mark and files whose line endings differ from most of the others. Those are information, not errors. Windows PowerShell 5.1 needs a byte-order mark to read a script with non-ASCII text correctly, and Windows batch files are safest with CRLF.

## Fixing what it finds

Summarize the findings first, worst first, and ask before changing any file. When the user agrees:

- **Deleting an invisible character.** Use Edit with the character typed as a backslash-u escape in `old_string`. Claude Code currently decodes that escape into the raw character, so it matches the file, and `new_string` leaves it out. If Edit can't find the text, or the character is a control byte, use a short script instead.
- **Replacing a raw character with its escape text.** Use a short script, not Write or Edit. Claude Code decodes the escape you type back into the raw character, and write-guard leaves a character alone when `old_string` contains it too.
- **Mixed line endings or an unwanted byte-order mark.** Use a short script, or the user's formatter. A `.gitattributes` line such as `* text=auto eol=lf` stops mixed endings from coming back.
- **U+FFFD.** The file can't tell you what was there. Look in version control, for example with `git log -p`, for the original character.

Run the scanner again afterwards to confirm the fix.

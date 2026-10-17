# write-guard

Claude Code turns backslash-u escapes in the text of every Write and Edit into real characters before the file is written ([anthropics/claude-code#72957](https://github.com/anthropics/claude-code/issues/72957), open since July 2026). Ask for a JavaScript string holding `"\u200b"` and the file gets an actual zero-width space, which no diff shows. Ask for `"\u202e"` and it gets an actual right-to-left override, the character behind the Trojan Source attack. Overwriting a file with Write also drops its byte-order mark and turns its CRLF line endings into LF, and a UTF-16 file that loses its byte-order mark becomes unreadable to most tools.

write-guard is a set of Claude Code hooks that catch these as they happen:

- **Before each Write, Edit and NotebookEdit**, it turns decoded characters that are almost never meant raw back into the escape text Claude typed: control characters, zero-width and other invisible characters, bidirectional controls, line and paragraph separators, a stray U+FEFF, and tag characters. In code and data files that already spell a character as an escape, such as a translation file written by Python's `json.dump`, it writes new occurrences the same way.
- **When Write overwrites a file**, it keeps the file's UTF-8 or UTF-16 byte-order mark and its CRLF line endings.
- **After each write**, it reads the file back and tells Claude and you if the encoding changed, a byte-order mark appeared or disappeared, line endings flipped or got mixed, or NUL bytes, U+FFFD replacement characters or control characters arrived that the write didn't contain.
- **When Korean comes out wrong.** Claude sometimes writes Korean as escapes and gets a hex digit wrong, which decodes to a real but wrong syllable ([anthropics/claude-code#83033](https://github.com/anthropics/claude-code/issues/83033)). Before each write, write-guard looks for Hangul syllables outside the 2,350 that everyday Korean uses (KS X 1001) and that the file doesn't already contain, and asks Claude to check those words. It never changes them.

Whenever it changes something, Claude gets a note next to the tool result saying exactly what changed and why, so its picture of the file stays accurate. A short line tells you too.

It also ships a scanner for problems that are already in your files, from earlier sessions or anywhere else.

## Try it

1. "Scan this repository for invisible characters, bidi controls and encoding damage."
2. "Create `demo.js` exporting a constant that holds a zero-width space, written as an escape, then show me the file's bytes." With write-guard the file holds the six characters of the escape. Without it, it holds the invisible character.
3. "Make a file with Windows line endings, overwrite it with Write, and show me whether the CRLF endings survived."

## What's included

- **Hooks.** PreToolUse on Write, Edit, MultiEdit and NotebookEdit. PostToolUse and PostToolUseFailure on Write, Edit and MultiEdit. Each runs `node scripts/write-guard.mjs` from this plugin.
- **`/write-guard:scan` skill.** Runs `scripts/scan.mjs` over a folder or files and explains the findings: hidden characters with line and column, files that aren't valid UTF-8 or UTF-16, UTF-16 files without a byte-order mark, mixed line endings, and which files start with a byte-order mark or differ from the rest in line endings. `node scripts/scan.mjs --fail` works in CI too.

## What it restores, and what it leaves alone

A hook only ever sees the decoded character, not what Claude typed, so write-guard acts only where a raw character is almost certainly a mistake.

| Characters | What write-guard does |
| :- | :- |
| Control characters, including NUL and ESC (Claude Code before 2.1.277 decoded these too) | Restores the escape |
| Zero-width space U+200B, word joiner and invisible operators U+2060 to U+2064, soft hyphen U+00AD, U+034F, U+180E | Restores the escape |
| Bidirectional controls U+202A to U+202E and U+2066 to U+2069 | Restores the escape |
| Line and paragraph separators U+2028 and U+2029, U+FEFF after the first character, U+FFFD, noncharacters, lone surrogates, Hangul fillers | Restores the escape |
| Tag characters U+E0001 and U+E0020 to U+E007F | Restores the escape, except inside a flag emoji |
| Joiners U+200C and U+200D, direction marks U+200E, U+200F and U+061C | Restores the escape only between ASCII characters. Inside emoji, Arabic, Hebrew, Persian or Indic text they stay raw |
| Private-use characters, which icon fonts use | Left raw, with a note to Claude |
| Everything else, such as accented letters, CJK and emoji | Left raw. In a JavaScript or JSON string a raw letter means the same as its escape |

Two rules override the table. A character that the text being replaced already contains is never touched, so write-guard never rewrites what was in the file before. And in a code or data file (JSON, JavaScript, TypeScript, Python, Java, C#, Go, Ruby, YAML, TOML and similar) that writes a character only as an escape, or that is ASCII apart from escapes, new occurrences of ordinary characters are written as escapes too.

## Settings

Set these in the `env` block of your Claude Code settings.

| Variable | Values | Default |
| :- | :- | :- |
| `WRITE_GUARD_MODE` | `restore` changes the call, `warn` only tells Claude, `block` denies the call, `off` does nothing | `restore` |
| `WRITE_GUARD_RESTORE` | Comma-separated: `control`, `invisible`, `file-style`, `private-use`, `non-ascii`, or `all` | `control,invisible,file-style` |
| `WRITE_GUARD_KEEP_FORMAT` | `0` stops write-guard keeping byte-order marks and CRLF line endings | `1` |

`non-ascii` escapes every non-ASCII character a write introduces, for code bases that are ASCII by policy.

## What it reads, writes, runs and sends

- **Reads** the file that a Write, Edit or NotebookEdit targets, before and after the call, up to 16 MB. Files that aren't UTF-8 or UTF-16 text are left alone. The scanner reads the files under the paths you give it, up to 4 MB each.
- **Writes** nothing to your files, with one exception: if Claude Code ever keeps a byte-order mark or CRLF ending by itself, so that the one write-guard added comes out doubled, the after-hook removes the extra one. Between the before-hook and the after-hook it keeps a few hundred bytes of metadata about the file (encoding, byte-order mark, line-ending style), never its contents, in the plugin's data folder, and deletes it when the call finishes.
- **Runs** `node scripts/write-guard.mjs` for each hook. The scanner runs `git ls-files` in the folder it scans.
- **Sends** nothing over the network. There is no telemetry and no account. See [PRIVACY.md](PRIVACY.md).

## Limits

- It sees Write, Edit, MultiEdit and NotebookEdit only. Text written by a shell command (a heredoc, `echo`, `sed`) never passes through it.
- It can't know what Claude typed, only what Claude Code decoded. A decoded accented letter or emoji in a new file stays raw unless you turn on `non-ascii`.
- If you ask Claude to remove a byte-order mark or convert CRLF to LF and it uses Write, write-guard puts them back and says so, and Claude then needs a shell command. Set `WRITE_GUARD_KEEP_FORMAT=0` if you do that often.
- If another plugin's hook also rewrites the input of the same Write or Edit, Claude Code keeps whichever reply arrives last.
- The Hangul check catches about four in five mis-spelled syllables: a wrong digit that lands on another common syllable looks like ordinary Korean. Real words outside KS X 1001, such as some slang and loanwords, get a note too; Claude checks them and moves on.
- Files in a legacy encoding such as Windows-1252, Shift-JIS or GBK are left alone. Claude Code 2.1.299 and later refuse to Edit or Write them at all, so they can't be damaged that way.

## Requirements

- Claude Code 2.1.139 or later, which runs hooks without a shell.
- Node.js 20 or later on your `PATH`. If `node` is missing, Claude Code reports a hook error on each write and lets the write through unchanged.

## Development

`node --test` runs the tests. They need nothing beyond Node and, for one scanner test, Git.

The behavior write-guard corrects was observed on Claude Code 2.1.281 on Windows 11: control-character escapes stay as text, every other backslash-u escape in Write and Edit text is decoded, Write drops a UTF-8 or UTF-16 byte-order mark and writes LF over CRLF files, and Edit keeps both. Hook input arrives already decoded, a hook's `updatedInput` reaches the disk unchanged, and PostToolUse receives the updated input.

## License

MIT. See [LICENSE](LICENSE).

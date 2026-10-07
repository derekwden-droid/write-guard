# write-guard plugin privacy policy

Last updated: October 7, 2026

The write-guard plugin for Claude Code collects no data. It has no servers, no accounts, no analytics
and no telemetry, and it never connects to the network.

## What the plugin accesses

Before and after Claude writes or edits a file with the Write, Edit, MultiEdit or NotebookEdit tool,
the plugin reads that one file from your computer to check its encoding, byte-order mark, line
endings and characters. It reads only the file named in that tool call.

When you or Claude run the scan skill, the scanner reads the text files under the paths it is
given. Inside a Git repository it asks Git for the list of files, so ignored files are skipped.

## What happens to that data

The hooks compare the file with the text Claude is about to write, and may change that text before
it is written, as described in the README. They return a short note to Claude and to you. The
scanner prints its findings in your session.

Between the hook that runs before a write and the hook that runs after it, the plugin keeps a small
record about the file in the plugin's data folder on your computer: its path, encoding, whether it
has a byte-order mark, its line-ending style, and counts of control characters. It never stores
file contents. The record is deleted when the write finishes, and a record left behind by a write
that never finished is deleted within a few hours.

The notes the plugin returns become part of your conversation with Claude, like any other tool
output. How Anthropic handles your conversations is covered by Anthropic's own privacy policy, not
this one.

## Retention

Nothing outlives the tool call it was made for, apart from records of interrupted writes, which
are removed within a few hours.

## Changes and contact

Changes to this policy are made in this file and recorded in the repository's history. Questions go
to [github.com/derekwden-droid/write-guard/issues](https://github.com/derekwden-droid/write-guard/issues).

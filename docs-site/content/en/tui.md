---
title: Interactive terminal
description: opencode-style full-screen TUI — rendering, permission confirmation, multi-line input, slash commands, shortcuts.
---

# Interactive terminal

AIH's interactive terminal is an opencode / MiMo-Code-style full-screen TUI.

## Rendering

- **light Markdown**: headings→bold, code blocks→dark + **syntax highlighting** (keywords/strings/numbers/comments colorized), quotes→dark, lists→`•`/numbered, inline code→cyan, inline links dual-color underline, tables `|`→`·`
- **tool icons** inline: `$` bash / `→` read / `✱` search / `%` web / `←` write / `#` todo / `⚙` other
- **same-kind tools auto-group and collapse** (`$ bash ×3 click to expand`)
- `run_cmd` etc. results show a **three-line preview** (`… N more · click to expand`)

## Input

- **multi-line input box**: wraps by display width (CJK wide-char aware, precise cursor positioning), scrolls within the box
- `/` triggers **Tab ghost completion**
- busy shows a spinner + elapsed seconds
- up/down keys browse input history

## Permission confirmation (folder-level memory)

```
⚠ approval requested: run_cmd { "command": "rm -rf build" }
  [y] once · [n] no · [a] always <scope>
```

- `scope` is auto-derived from the target path to its parent directory
- choosing `a` (always) persists to aih.json as **last-match-wins**
- submissions while busy are queued automatically (`queued: …`)

## Bottom

- heavy border (shows `↑N` when scrolling) + hint line (cwd · shortcuts · right-side context usage `used/limit (pct%)`)
- status line (`⊙ N MCP` badge · app · version · session name)

## Interaction & shortcuts

| Action | Effect |
|---|---|
| mouse wheel / PgUp / PgDn | scroll |
| up/down keys | browse input history |
| `exit` (or `/quit`) | restore terminal and exit |
| `ctrl-c` while busy | cancel the current round (doesn't exit) |
| `ctrl-c` when idle | clear input, press again to exit |
| `ctrl-p` | open the model picker |
| `tab` | slash-command completion |
| `?` | help |

## Session title

After the first round, the LLM auto-generates a 2–6 word title (`<name>.jsonl.meta.json`), shown in the status bar and `session list`.

## /vivid minimal rendering

Toggles plain mode — strips borders/background/sidebar/status hints and other chrome, leaving only the body (good for low-bandwidth/remote/log replay); press again to restore the full theme.

## /find search

Searches across all tool outputs line by line (including expanded content within the 32KB in-band cap); matched tools auto-expand and scroll the first hit into view, listing the last 12 hits (`tool · line · snippet`). Full output beyond the in-band cap is persisted via `run_cmd keep_output=true` to `.aih/outputs/*.log`.

## Intelligent Terminal (IT#1–IT#5)

- **`/sessions` (IT#4)** — session-management panel: lists active + saved agent sessions with status, token usage and cost. `/sessions kill <id>` cancels a running job; `/sessions view <name>` shows a per-session summary.
- **`/shell` (IT#1)** — print the recent shell context (last commands, exit codes, cwd, output tails). With `AIH_SHELL_CONTEXT=auto` this context is auto-injected every turn.
- **`/fix` (IT#2)** — deterministic (no LLM) failure detection lights a red `⚠ N failed` badge on `run_cmd` errors; `/fix` sends the failure context to the agent for a fix suggestion.
- **`?` prefix (IT#3)** — a TUI input line starting with `?` starts an agent task with the current shell context auto-injected (a quick way to ask about the recent shell).
- **run-or-copy approval (IT#5)** — a write-kind `run_cmd` approval is an explicit `[R]un / [C]opy / [N]o` choice (copy degrades to printing the command when no clipboard is available); it never auto-runs.

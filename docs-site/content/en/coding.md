---
title: Coding agent
description: aih --dev coding agent — local general toolset (files/commands/search/web), chat vs run differences, aligned with opencode builtin tools.
---

# Coding agent

AIH's agent kernel is **general**: tools come from the connected app, and the interactive terminal mounts a set of **local general tools** by default (aligned with opencode's builtin toolset) — so it is itself a **coding agent** that can read files, run commands, edit code, and look things up. `--dev` toggles this toolset.

## Toolset (aligned with opencode builtin tools)

| Tool | Description | Permission |
|---|---|---|
| `list_dir` / `read_file` | list dir / read file (64KB truncation, line offset) | allow |
| `write_file` / `run_cmd` | write file / run command (default 120s timeout, `timeout_ms` up to 600s; background children don't block) | ask |
| `edit` | exact string-replace edit (errors on ambiguity, `replace_all` for all) | ask |
| `glob` / `grep` | find files by pattern / regex content search | allow |
| `webfetch` / `websearch` | fetch URL / web search | allow |
| `todo` | session task list (state stamped into tool-result, rolls back with branches) | allow |
| `remember` | persist knowledge to memory.md (project / user tiers) | allow |
| `question` | ask the user and wait for an answer (interactive) | allow |
| `task` / `best_of_n` | serial subagent / parallel subagents + judge (Max Mode) | ask |
| `apply_patch` | multi-file patch | ask |
| `load_skill` | load a skill's full text | allow |
| `archive_read` | read back pruned/archived tool output | allow |

These tools **coexist** with any MCP app tools; **on name collision, the app tool wins**.

## chat vs run

| Form | Local toolset | Notes |
|---|---|---|
| `aih chat` (interactive) | **on by default** (`--no-dev` to disable) | the interactive terminal is the coding agent |
| `aih run "<msg>"` | **off by default** (`--dev` to enable) | one-shot Q&A only touches app tools by default; explicit `--dev` mounts local tools |

> Design intent: `run` is often used in scripts/pipelines, so it defaults to the minimal surface; `chat` is the interactive scenario, so it defaults to the full set.

## Typical usage

```sh
# interactive: use it as a coding agent directly (local tools on by default)
aih

# one-shot: explicitly mount the local toolset
aih run "find all TODO comments in src and summarize" --dev

# read-only analysis (plan mode + auto: read-only commands auto-allowed)
aih run "review the risk in this diff" --dev

# run tests and fix
aih run "run npm test, fix if red" --dev -y
```

## Relationship to external app tools

- **app tools** (AppAdapter Actions): your business actions (e.g. `create_order`)
- **local tools** (`--dev`): general coding capabilities (files / commands / search / web)
- both coexist in the same `ToolRegistry`, with independent permissions and unified audit

## Security defaults

- write tools (`write_file` / `run_cmd` / `edit` / `apply_patch`) default to `ask`
- `run_cmd` child-process env key filtering (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`-like variables are stripped)
- redaction hook on by default (secret-shaped values in tool results are masked)
- sandbox seam: `run_cmd` can switch to `local` / `bwrap` / `remote` backends

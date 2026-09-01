---
title: Introduction
description: AIH (App Intelligence Harness) — a general framework that gives any ordinary app AI capabilities through a standardized adapter.
---

# Introduction

**AIH (App Intelligence Harness)** makes "connecting an app to an agent" a standard thing: implement a lightweight `AppAdapter` (read Context / write Action / receive Event), and your business app gains three-tier allow/ask/deny permissions, append-only session audit, a pluggable skill layer, and three integration forms (MCP plugin / CLI / embedded SDK) — **without changing any business code**.

AIH is a fusion of the design ideas of [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and [opencode](https://github.com/anomalyco/opencode): the former contributes the append-only Session Log, the guarded tool pipeline, and replaceable capability seams; the latter contributes the build/plan dual mode, the permission model, the skill layer, and the TUI interaction paradigm.

## Core ideas

| Idea | Meaning |
|---|---|
| **AppAdapter** | One app = one adapter: `descriptor` + `context(query)` + `actions` — three primitives to integrate |
| **L0 contract** | `Context` (read) / `Action` (write) / `Event` (change stream) is the only integration surface; `APP.md` is the single source of truth |
| **Three-tier permissions** | `allow` runs directly · `ask` confirmed via the approval gate · `deny` rejected by the registry |
| **append-only audit** | Sessions are a line-by-line JSONL event stream — "if the model can see it, it can be replayed"; tool calls are also logged |
| **Replaceable seams** | LLM adapter, sandbox backend, approval gate, skill loading are all seams — pluggable, never locked in |

## Three integration forms

| Form | Scenario | Entry point |
|---|---|---|
| **MCP plugin** (zero-intrusion, recommended start) | Plug into any MCP client: opencode / codex / claude code | `mcp-server/dist/index.js` |
| **CLI integration** | Interactive terminal, one-shot Q&A, script pipelines | `aih` / `aih run` / `aih chat` |
| **Embedded Copilot** (SDK) | Reuse the L1 kernel directly, register tools into `AgentLoop` | `@aih/core` |

## In action

Open the interactive terminal (opencode-style TUI), type a sentence, and the model calls the app's tools. Below is a **real run** captured from the terminal (`--mock` offline demo, no API key) — the model plans, calls `add_todo`, returns the result; the right side shows live context usage and the bottom is the status bar:

<figure>
  <img src="assets/aih-tui.png" alt="AIH interactive terminal in a real run: typing 'add a todo buy milk', the model calls add_todo and returns 'Added via mock'" loading="lazy">
  <figcaption>AIH interactive terminal — one sentence drives the <code>add_todo</code> tool, with live context usage and status bar</figcaption>
</figure>

> This image is a cell-by-cell capture of real TUI output (PTY + terminal emulation), not a hand-drawn mockup.
> See the one-shot form at [`aih run`](quickstart).

## Feature highlights

- **General agent kernel**: tools come from the connected app; the interactive terminal also mounts a set of local general tools (files / commands / search / web) by default
- **build / plan dual mode**: plan is read-only analysis; all write tools are hidden from the registry
- **Goal judge**: `/goal <condition>` gets an independent LLM judge at the end of each round, preventing "optimistic stopping"
- **Subagent system**: `task` serial subagents + `best_of_n` parallel judge (Max Mode)
- **Deterministic workflow**: `.aih/workflows/*.mjs` multi-phase runs with `aih workflow run`
- **Auto-format on write**: prettier / biome / eslint --fix auto-detected from lockfile/config
- **Parallel read-only tools**: consecutive read calls run concurrently (≤ `AIH_TOOL_CONCURRENCY`); writes stay serial
- **Checkpoint & rollback**: `/checkpoint` + `/restore` fork the prefix into a new session (original file untouched)
- **Persistent memory**: `remember` writes knowledge to `memory.md` across sessions
- **Intelligent context management**: pruning + lazy archive, relevance-based skill loading, compaction

## Quick start

```sh
# one-shot (offline demo, no API key)
npm run cli -- run "add a todo buy milk" --mock

# interactive terminal (opencode-style TUI, needs a TTY)
aih
```

## Next steps

- Want to learn AIH properly? → **"AIH: A Learner's Guide & Source Deep-Dive"** (a five-part, eighteen-chapter tutorial; [start with the reader's guide](tutorial/index))
- Install → [Installation](install)
- Three integration forms → [Quick start](quickstart)
- Configure providers & models → [Configuration](config)
- Connect your own app → [Integrate your app](adapter)

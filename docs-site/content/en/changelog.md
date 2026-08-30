---
title: Changelog
description: AIH release notes — key changes in 0.4.0 / 0.3.0 / 0.2.0 / 0.1.0.
---

# Changelog

The full itemized record lives in the repo [`CHANGELOG.md`](https://github.com/summit4you/aih/blob/main/CHANGELOG.md) (Keep a Changelog format, SemVer). This page is a per-version summary.

## 0.4.0 (2026-08-29)

**Added**

- **Safety seam (PE#1 / PE#2 / PE#4)** — the harness enforces safety, not the model. **PE#2 budget**: `maxCostUsd` / `maxWrites` / `timeoutMs` / `denyPaths` hard bounds stop the turn with an `escalate` event; a soft tripwire (task cost ≥ 2× session mean) hints once without blocking (`AIH_BUDGET` or `safety.budget`). **PE#1 sensors**: after a write, run a declared check (`AIH_SENSORS`), red → bounded retry → escalate; sensor children inherit no secrets. **PE#4 escalate**: a model-invisible `escalate` event (`reason` + `options` + `safestDefault`); non-interactive `run` exits **code 3**, the TUI renders the options. **`test/recovery.sh`**: crash → resume parks the tool (outcome unknown) and does not re-dispatch it.
- **Intelligent Terminal UX (IT#1–IT#5)** — **IT#1** `shell_context` tool + `/shell` + `AIH_SHELL_CONTEXT=auto`; **IT#2** deterministic failure detection + red `⚠ N failed` badge + `/fix`; **IT#3** `?` prefix starts an agent task with shell context auto-injected; **IT#4** `/sessions` panel (dashboard / `kill <id>` / `view <name>`); **IT#5** run-or-copy approval `[R]un / [C]opy / [N]o` for write commands.
- **`aih measure` distance ruler (PR#2)** — `distance` / `stream` (seeded permutation test) / `crystallize`; pure functions, `--json` out.
- **`aih session rm --all`** — real `-a/--all` flag to clear every saved session.
- **Quota auto-resume (CC#51)**, **read-only auto-allow (CC#54)**, **credential scope (CC#59)**, **BOM tolerance (CC#55)**, **MCP empty-schema (CC#56)**, **`/usage` per-loop breakdown (CC#57)**, **TUI truncation (CC#58)**, **injected-source isolation (CC#60)**, **question tool**, **bilingual docs site + GitHub Pages**, **harness scorecard (PE#3)**, **`escalate` event (PE#4 foundation)**.

**Fixed**

- **Tool-output budget marker (FA#2)**: the old cryptic truncation marker no longer blind-loops the model — it now tells it to stop re-issuing tools and wrap up.
- **Language rule covers progress notes**: every user-facing text (final answer *and* mid-task progress notes) matches the user's language.
- **Slash-command parsing**, **subagent partial results (CC#50)**, **`load_skill` dedup (CC#52)**, **permission ask for write tools (CC#53)**.

## 0.3.0 (2026-08-26)

**Added**

- **Per-event session durability**: `chat` now appends every event to the session file as it happens (byte-watermarked incremental flush), so a long multi-tool turn survives a crash or kill instead of living only in memory
- **Extension API (P#39)**: `.aih/extensions/*.mjs` modules — `registerTool`, `registerCommand`, `on("tool:before" | "tool:after" | "turn:end")` handlers that can cancel calls or rewrite results in place; `--no-extensions` disables loading; gated by the project trust decision
- **Session tree (P#37)**: events carry optional parent links; `aih session tree` renders the branch structure and TUI `/tree` navigates it, with fork from any historical point
- **Steering + follow-up queues (P#35)**: input typed while busy now lands mid-turn (between tool batches) instead of waiting; follow-up queue drains at the natural stop point
- **Project trust gate (P#40)**: repo-supplied extensions/skills/config stay dormant until the directory is trusted; decisions persist per-path in the user dir; `--trust` / `--no-trust` one-shot overrides
- **Eval framework phase 1 (P#46)**: Experiment → Cells → Attempts → Results data model for measuring harness changes against fixed task sets
- **Context prune + lazy archive (MK#43)**: oversized old tool results are pruned once per session start and retrievable verbatim via `archive_read`
- **Compaction coverage digest (MK#42)**: summaries stamp what they replace
- **User-level memory + background jobs + memory tidy**: `remember` gains `scope: project|user`; `/bg <prompt>` dispatches isolated background agent turns; `aih tidy` / `aih distill` dedup memory and mine repeated flows
- **BM25 skill relevance + streaming TPS**: installed skills are ranked against the user query and auto-surfaced before each turn; per-request streaming throughput shown in `/usage`, `aih stats`, and the TUI context panel
- **Skill-driven hook config (D#11)**: a skill's front matter may declare `secretPatterns` that the built-in redaction hook masks
- **Agent Teams (minimal) (D#15)**: `aih team` manages a roster, a task board, and a per-agent mailbox
- **`/find` tool-output search (T#22)**: search across every tool's output, expand matched tools and scroll the first hit into view

**Fixed**

- **Context panel truthfulness**: free-tier gateways reporting cumulative or garbage `prompt_tokens` no longer reach the display — usage samples are window-bounded, a compaction is a hard provenance cutoff, and stale samples fall back to local estimation
- **CJK-aware token estimation**: flat chars÷4 undercounted Chinese + JSON sessions ~3×; now corrected

## 0.2.0

**Added**

- **Codex-inspired hardening**: child-process env policy strips secret-like variables (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`, `AIH_*API*`) before spawning tools; `--debug-prompt` prints the exact model-visible messages per LLM call; skill roster injected into the system prompt within a ~2% context budget
- **Multi-model catalogs**: providers may declare `models[]`; ctrl-p and `/model` switch between verified models at runtime
- **Live context-window detection and proactive / reactive / manual compaction** with verbatim recent-tail preservation and rolling summaries (`compactNow()`, `/compact`); user-query invariant keeps strict chat templates working after compaction
- **TUI design pass** (split/unified layouts, paste fix) and richer session introspection

## 0.1.0

**Added**

- Initial harness: `AgentLoop` step engine with max-steps handoff prefill, `SessionLog` append-only JSONL persistence + fork/replay, `ToolRegistry`, `PolicyGate` / `RulesetGate` approval flows, path-scoped write approvals, plan/read-only mode
- MCP server exposing app context/actions; CLI entry points (`run` / `chat` / `tools` / `describe` / `sessions`), bundled todo-app example, OpenAI-compatible adapter with SSE streaming and 429/5xx retries
- Contract docs (`APP.md`, `harness.yml`) and gates: `doctor`, `check`, smoke tests, full `eval`

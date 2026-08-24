# Changelog

All notable changes to AIH are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). The installer validates release tarballs against
the versions listed here (`scripts/package` derives the version from
`cli/src/index.ts` → `VERSION`).

## [Unreleased]

### Added
- **Deterministic workflows** (F#33 / P1#6): `.aih/workflows/<name>.mjs` modules
  exporting `phases`; `aih workflow list` / `aih workflow run <name>
  [--format json]`. Phases run sequentially; each phase is one agent call
  (`prompt`) or a parallel fan-out (`prompts`). Substring gate (`expect`) and
  bounded `retries` per phase; fail-fast on the first failing phase.
- **Goal/judge events** (P0#3): `goal/judge` structured event appended to
  session logs whenever the TUI runs a `/goal` verdict check; `aih run --goal
  <condition>` performs bounded auto-continuation until the judge reports the
  goal met or the round budget (`AIH_GOAL_ROUNDS`) is exhausted.
- **Post-write auto-formatting** (F#27): `write_file` / `edit` / `apply_patch`
  detect prettier > biome > eslint `--fix` by walking up from the written file;
  formatting failures never block the write and surface as a `formatNote`
  (`AIH_FORMAT_TIMEOUT_MS`, default 15000).
- **Parallel read-only tool calls** (F#29): consecutive read-only tool calls in
  one step execute concurrently, capped at `AIH_TOOL_CONCURRENCY` (default 4);
  write tools stay serial; results are logged in the original call order
  regardless of completion order (codex `parallel.rs` parity).
- **Repo hygiene** (F#32): this changelog and `.devcontainer/` giving
  in-container agents a stable environment (`postCreateCommand` bootstraps and
  builds automatically).

## [0.2.0]

### Added
- Codex-inspired hardening: child-process env policy strips secret-like
  variables (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`, `AIH_*API*`) before spawning
  tools; `--debug-prompt` prints the exact model-visible messages per LLM call;
  skill roster injected into the system prompt within a ~2% context budget.
- Multi-model catalogs: providers may declare `models[]`; ctrl-p and `/model`
  switch between verified models at runtime.
- Live context-window detection and proactive / reactive / manual compaction
  with verbatim recent-tail preservation and rolling summaries
  (`compactNow()`, `/compact`); user-query invariant keeps Qwen3-style strict
  chat templates working after compaction.
- TUI design pass (split/unified layouts, paste fix) and richer session
  introspection.

## [0.1.0]

### Added
- Initial harness: `AgentLoop` step engine with max-steps handoff prefill,
  `SessionLog` append-only JSONL persistence + fork/replay, `ToolRegistry`,
  `PolicyGate` / `RulesetGate` approval flows, path-scoped write approvals,
  plan/read-only mode.
- MCP server exposing app context/actions; CLI entry points
  (`run` / `chat` / `tools` / `describe` / `sessions`), bundled todo-app
  example, OpenAI-compatible adapter with SSE streaming and 429/5xx retries.
- Contract docs (`APP.md`, `harness.yml`) and gates: `doctor`, `check`,
  smoke tests, full `eval`.

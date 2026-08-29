# Changelog

All notable changes to AIH are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). The installer validates release tarballs against
the versions listed here (`scripts/package` derives the version from
`cli/src/index.ts` → `VERSION`).

## [Unreleased]

## [0.3.0] - 2026-08-26

### Added
- **Per-event session durability**: chat now appends every event to the
  session file as it happens (byte-watermarked incremental flush), so a long
  multi-tool turn survives a crash or kill instead of living only in memory.
- **Extension API (P#39)**: `.aih/extensions/*.mjs` modules — `registerTool`,
  `registerCommand`, `on("tool:before" | "tool:after" | "turn:end")` handlers
  that can cancel calls or rewrite results in place. `--no-extensions`
  disables loading; gated by the project trust decision.
- **Session tree (P#37)**: events carry optional parent links; `aih session
  tree` renders the branch structure and TUI `/tree` navigates it, with fork
  from any historical point (D#10 CLI already existed).
- **Steering + follow-up queues (P#35)**: input typed while busy now lands
  mid-turn (between tool batches) instead of waiting; follow-up queue drains
  at the natural stop point.
- **Project trust gate (P#40)**: repo-supplied extensions/skills/config stay
  dormant until the directory is trusted; decisions persist per-path in the
  user dir; `--trust` / `--no-trust` one-shot overrides.
- **Eval framework phase 1 (P#46)**: Experiment → Cells → Attempts → Results
  data model for measuring harness changes against fixed task sets.
- **Context prune + lazy archive (MK#43)**: oversized old tool results are
  pruned once per session start and retrievable verbatim via `archive_read`.
- **Compaction coverage digest (MK#42)**: summaries stamp what they replace;
  derivation verifies coverage before honoring them.
- **Offline installer**: `scripts/offline-package` builds a self-extracting
  POSIX `.sh` + Windows `.ps1` bundling runtime deps and a merged global
  config (providers/models included); sandboxed install/uninstall sanity
  tests run at build time. Uninstall never touches `$PWD/aih.json`.
- **Cache-hit rate (#41)**: `/usage` reports prompt-cache hit rate when the
  provider returns cached-token counts.
- **Per-model context window (F#34)**: `providers.<name>.models[]` entries now accept
  the object form `{ "model": "<id>", "contextWindow": <n> }` (mixable with plain
  model-id strings). The model-level value overrides the provider-level
  `contextWindow` for that model only, so one provider can serve models with very
  different windows (e.g. 1M vs 190k) and the TUI context panel, `/model` picker
  and `aih config` all report the right number. Resolution order:
  `--context-window` > `AIH_CONTEXT_WINDOW` > live llama.cpp `/slots` probe >
  `models[<id>].contextWindow` > `providers.<name>.contextWindow` > global > 128k.
  `aih.json` for the bundled opencode provider now declares each model's real
  window (x-preview-f-free / nemotron-3-ultra-free = 1M).
- **One-line installer**: `scripts/install` (bash, macOS/Linux/WSL) and
  `scripts/install.ps1` (PowerShell, Windows) — curl|bash / irm|iex installers
  that download from GitHub Releases, detect platform, check Node.js ≥ 20,
  extract to `~/.local/share/aih` (XDG), symlink to `~/.local/bin`, and auto-
  configure PATH. Supports `--binary` (local tarball), `--version`, `--dir`,
  `--no-modify-path`. Idempotent (skips if already at same version).
- **Package script rewrite**: `scripts/package` now produces a self-contained
  tarball with an ESM launcher (`aih`) + bundled `node_modules/` — no
  `npm install` needed at install time. Release flow: `gh release create`.
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
- **User-level memory + background jobs + memory tidy** (P0#2 / D#13 / E#17):
  `remember` gains `scope: project|user`; `/bg <prompt>` dispatches isolated
  background agent turns with a live status line; `aih tidy` / `aih distill`
  dedup memory and mine repeated flows.
- **BM25 skill relevance + streaming TPS** (P1#4 / F#30): installed skills are
  ranked against the user query and auto-surfaced before each turn; per-request
  streaming throughput (completion tokens / real generation ms) is shown in
  `/usage`, `aih stats`, and the TUI context panel.
- **Skill-driven hook config** (D#11): a skill's `SKILL.md` front matter may
  declare `secretPatterns` (semicolon-separated regex sources) that the
  built-in redaction hook masks in addition to the credential table; invalid
  patterns are skipped and never break the turn.
- **Agent Teams (minimal)** (D#15): `aih team` manages a roster, a task board,
  and a per-agent mailbox under `.aih/team/`; `dispatch` runs one agent turn
  against a claimed task and mirrors the outcome back onto the board.
- **`/find` tool-output search** (T#22): search across every tool's output
  (the expanded content, including the 32KB in-band cap), expand matched tools
  and scroll the first hit into view; `run_cmd keep_output=true` still persists
  the full uncapped output for external inspection.

### Fixed
- **Context panel truthfulness**: free-tier gateways reporting cumulative or
  garbage `prompt_tokens` (observed 28M on a ~500k-token conversation) no
  longer reach the display — usage samples are window-bounded, a compaction
  is a hard provenance cutoff, and stale samples outgrown by the log fall
  back to local estimation. `-c` resume, `/model` switch and post-compact
  views all show the real current size.
- **CJK-aware token estimation**: flat chars÷4 undercounted Chinese + JSON
  sessions ~3×, hiding context overflow until providers failed; estimation
  now weights CJK ≈1 token/char and prices assistant toolCall args.
- **Opaque-500 overflow recovery**: near-window HTTP 4xx/5xx / transport
  failures are treated as suspected overflow — compact then retry once
  (free-tier gateways hide real context overflows behind generic 500s).
- **Compaction recent-tail guarantee**: giant turns no longer collapse the
  entire conversation into the summary; the newest user turn is kept
  budget-truncated (with marker) plus as many whole follow-up messages as
  fit, keeping call↔result pairing intact.
- **LLM retries were silently disabled**: the `AIH_RETRIES` parse produced
  `retries: 0` when unset. Default is now 6 attempts with exponential
  backoff (400ms→8s, ±25% jitter) so provider blips ride out invisibly.
- **question tool renders once** with the user's answer shown (`→ answer`);
  cancelled questions render a `(no answer)` marker instead of duplicating.
- **Session store hardening**: atomic publish via temp+rename, torn-tail
  repair on load, and an empty log never truncates an existing session file.
- **TUI flush row-diff**: only changed rows are written and shrinking frames
  erase surplus lines — geometry changes no longer clear the whole screen.
- **tool-call pairing invariant**: length-truncated responses fail their
  tool calls synthetically ("arguments may be truncated; re-issue") and
  aborted batches pair skipped calls with cancelled results.
- **steering while busy** lands mid-turn instead of waiting for turn end.
- **Capacity-burst retry patience**: gateway capacity failures (zen's
  "Upstream request failed: Endpoint is unavailable") triple the retry
  budget — ~2 minutes of backoff patience at the 8s cap instead of ~20s —
  so free-tier flaps ride out invisibly. Plain 5xx keeps the base budget.

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

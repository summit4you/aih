# Changelog

All notable changes to AIH are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). The installer validates release tarballs against
the versions listed here (`scripts/package` derives the version from
`cli/src/index.ts` → `VERSION`).

## [Unreleased]

## [0.5.2] - 2026-09-03

### Added
- **Shell execution for `aih run` on by default (opencode parity)**: the `run_cmd`
  shell tool (plus the rest of the local coding toolset) is now registered by
  default for `aih run`, `aih chat`, and `aih tools` — no `--dev` flag required.
  `--no-dev` disables it uniformly on all three paths. Previously the one-shot
  `run` command kept the whole set opt-in via `--dev`.
  (`cli/src/index.ts`)
- **Command workspace-boundary analysis (`shell-scan`)**: `run_cmd` now pre-analyzes
  each command for file-system writes and workspace-external paths (inspired by
  opencode's tree-sitter shell tool, dependency-free regex version). Detects write
  operations (`rm`/`mv`/`cp`/`mkdir`/`chmod`/`git add`…), resolves relative/`~`
  paths against the workspace, and flags external directories. The scan result
  (`isWrite`, `externalDirs`, `touchedPaths`) is surfaced in the tool result; a
  human-readable summary is attached. (`cli/src/shell-scan.ts`)
- **Shell-aware tool description (`shell-prompt`)**: `run_cmd`'s description now
  adapts to the detected OS/shell and documents workdir/timeout/keep_output all in
  one place, plus guidance to prefer dedicated tools over shell file ops.
  (`cli/src/shell-prompt.ts`)
- **TUI `!` prefix directly runs shell commands (opencode/mimo-code parity)**:
  typing `!ls` in the input line executes `ls` locally through the same
  `runShellCommand` executor as the `run_cmd` tool (sandbox + env filter + timeout
  + middle-truncation) — it is **never sent to the LLM**. Runs even mid-turn
  (not steered), and is recorded as `run_cmd` tool/call+result events so the
  existing `/shell` (IT#1) and `/fix` (IT#2) shell-context machinery picks it up.
  (`cli/src/index.ts`) — mirrors opencode/mimo-code's `!` shell mode and codex's
  `!` prefix direct-exec "You ran" behavior.

### Changed
- `run_cmd` gains a `workdir` parameter (alias recommended over `cd`; `cwd` kept
  for backward compatibility).

## [0.5.1] - 2026-09-02

### Added
- **Deep code-review pipeline (AC#1, AtomCode borrow)**: the `code-review` skill now
  supports a deep mode — four parallel read-only review dimensions
  (correctness / security / performance / tests-contracts) each reviewing the full
  diff through its own lens → deterministic `mergeFindings` dedup (file + line
  overlap + title similarity, high-priority wins, cross-dimension credit) → an
  **independent verify agent per candidate finding** (KEEP/DROP, diff is
  authoritative) → human-readable report by priority + append-only JSONL audit trail
  (`.aih/reviews/`). Also derives a deterministic **impact plan** from the diff
  (changed files + high-risk symbols) to bound reviewer exploration.
  (`cli/src/review-pipeline.ts`, `.aih/skills/code-review/SKILL.md`)
- **Lightweight code-intel tools (AC#2, AtomCode borrow)**: three read-only tools —
  `list_symbols` (per-file outline), `read_symbol` (signature + docs), and
  `find_references` (workspace-wide, cross-file) — backed by an on-demand language
  server pool (`cli/src/codeintel.ts`). Zero new dependencies: a minimal JSON-RPC
  2.0 / stdio LSP client (`Content-Length` framing, bounded parser) plus a
  `tsserver` native-protocol adapter (1-based coordinate normalization, serialized
  `open` handshake that waits for project load, identifier-hit positioning via
  `navtoLocate` — quickinfo/references return nothing at the span start).
  Servers resolve per workspace (local `node_modules/typescript` first, real PATH
  `tsserver` second; npm-lifecycle `.bin` shims are excluded as false positives);
  child processes get the same secret-filtered env as run_cmd and are `unref`ed so
  a live server never keeps the agent hanging on exit. Missing servers degrade to
  a clear error; all three tools join the parallel read-only class (F#29).
  (`cli/src/codeintel.ts`, `cli/src/dev-tools.ts`)

### Fixed
- **Context window fell back to 131072 for models known only to models.dev
  (P#48 gap)**: `resolveContextWindow` never consulted the committed snapshot —
  a model whose window was not declared in `aih.json` (e.g. `glm-5.3-flash`
  on a catalog-connected provider) landed on the hardcoded 128k default even
  though models.dev reports 1M. The snapshot is now the last data-driven tier
  (flag > env > live probe > config > **snapshot** > default), matched on the
  bare model name with an optional provider-scoped pin; when providers
  disagree on a window the MODE wins (tie → smaller) — claiming more than the
  model supports hard-fails requests, under-claiming only compacts earlier.
  Also refreshed the committed snapshot (27 → 7408 entries, adds
  glm-5.3*/deepseek-v4* windows and prices). (`cli/src/cost.ts`,
  `cli/src/index.ts`, `scripts/model-metadata.snapshot.json`)
- **TUI side panel truncated the cost/throughput row**: the CONTEXT panel
  joined cost + tok/s + stream tok/s + CH% into one dot-joined line that
  overflowed the ~24-32 col panel and cut off mid-number. Layout is now:
  cost on its own line, the two throughput figures sharing the next
  (`N tok/s · stream M tok/s`), cache rate on its own line. Adds
  `Tui.panelLinesForTest()` + 9 smoke assertions. (`cli/src/tui.ts`)

## [0.5.0] - 2026-09-02

### Added
- **Provider catalog + `/connect` interactive login (opencode `/connect` parity,
  OpenAI-compatible scope)**: `connectCatalog()` returns a curated catalog of
  OpenAI-compatible providers (popular first, then alphabetical; native-SDK
  providers like Anthropic/Google excluded) with stable baseUrl / apiKeyEnv /
  default model. `/connect` (TUI) and `aih connect [<id>]` walk the user through
  provider selection → API key entry (persisted to the AIH env file chmod 600,
  NEVER written into aih.json) → provider saved into aih.json via
  `saveProvider()` (credential-safe: `apiKeyEnv` names the env var, key itself
  never stored) → model applied immediately. Providers not yet configured
  surface as "+ connect" entries at the bottom of the `/model` picker.
  (`cli/src/provider-catalog.ts`, `cli/src/config.ts` `saveProvider`,
  `cli/src/index.ts` `/connect` + `openConnectPicker`, `cli/src/slash.ts`)
- **Docs-site tutorial extension, batch 3 (zh + en)**: applied the same "beginner primer + real code walkthrough + logic diagram" treatment to the remaining mechanism chapters — Ch.2 (project structure & dev env: monorepo layer map + root `package.json` walkthrough, reuses `arch-overview.svg`), Ch.6 (agent system: bounded-retry fallback constants + `StallError`/`QuotaError` handling walkthrough, reuses `agent-loop.svg`), Ch.12 (CLI & TUI: `main()` dispatch walkthrough — trust gate → TTY default → `switch` routing, new `cli-dispatch.svg`), Ch.14 (skill system: `discoverSkills` name-dedup + `parseSkillMd` + BM25 `tokenize` CJK-bigram walkthrough, new `skill-load.svg`), Ch.15 (community & reusable skills: `installRemoteSkill` staging + atomic-rename + version-aware no-op walkthrough). Added two new SVG logic diagrams (`cli-dispatch.svg`, `skill-load.svg`); now 9 tutorial SVG diagrams total. Build/check PASS, all chapters + diagrams served with correct depth-aware paths (200).
- **Docs-site tutorial extension (zh + en)**: extended the same "beginner primer + real code walkthrough + logic diagram" treatment to more mechanism chapters — Ch.5 (tool system: `ToolDefinition`/`register`/`invoke` five-stage guard, reuses `guard-pipeline.svg`), Ch.10 (snapshots & file system: sandbox-backend resolution priority, env-policy), Ch.11 (event stream: observer `LoopObserver` code + `goal/judge` three-state verdict), Ch.13 (plugin/extension: `ExtensionApi` code + load-order + hook-waterfall placement). Added two new SVG logic diagrams (`event-stream.svg`, `extension-hooks.svg`) alongside the earlier `session-fork.svg`/`permission-floor.svg`. Build/check PASS, all 7 tutorial SVG diagrams served and embedded with correct depth-aware paths.
- **Docs-site tutorial refinement (zh + en)**: index ("导读 / How to read") table of contents now lists every chapter on its own line instead of merging several `·`-joined entries; repeated "three integration shapes" content is de-duplicated into a single canonical home in Ch.8 with cross-references from Ch.1/Ch.3/Ch.16; all bare `(chNN)` / `(../page)` cross-references converted to real clickable links. Deepened Ch.4 (session system) and Ch.9 (permission system) with beginner-friendly primers, real code walkthroughs (append/fork/restoreTo/coverageDigest; PolicyGate request), and two new SVG logic diagrams (`session-fork.svg`, `permission-floor.svg`). Added a Runoob-style "first use" beginner case to Ch.1 that exercises the real offline `--mock` pipeline.
- **Docs-site tutorial book (`docs-site`)**: a five-part, eighteen-chapter bilingual
  (zh + en) "AIH: A Learner's Guide & Source Deep-Dive" modeled chapter-by-chapter on
  opencodebook.xyz, from install to kernel and mechanisms to ecosystem/practice. Added
  grouped sidebar navigation (build.mjs / check.mjs now support nested nav groups and
  nested `tutorial/*` pages, with depth-aware relative links and assets) plus three SVG
  diagrams (layered architecture, tool guard pipeline, agent loop). Served from the
  existing GitHub Pages `docs.yml` workflow.
- **Rules loading (opencode `rules` parity)**: AIH now reads and injects project
  `AGENTS.md` (falling back to `CLAUDE.md` walking up from cwd), global
  `~/.claude/CLAUDE.md` (Claude-Code compat, disable via
  `AIH_DISABLE_CLAUDE_CODE[_{PROMPT,SKILLS}]`), and config `instructions`
  (paths/globs/URLs) into the system prompt as mandatory `# Project rules`.
  (`cli/src/rules.ts`)
- **Provider policies (opencode `policies` parity)**: `policies` config controls
  which configured LLM providers are usable — `provider.use` with `*`/`?`
  wildcards, last-match-wins, global-over-project; a denied provider is blocked
  at resolve and hidden from the model catalog even if configured.
  (`cli/src/policies.ts`)
- **Configurable keybinds (opencode `keybinds` parity)**: `tui.json` (project +
  `~/.aih` global) remaps the core single-byte actions `palette` (default
  ctrl-p), `help` (default `?`), `toggleMode`; collisions with reserved keys are
  dropped with a warning. (`cli/src/keybinds.ts`)
- **Credential ownership isolation (OC#7, OpenClaw "secrets have owners")**:
  a credential-class failure (auth 401/403, or quota exhaustion) on a provider
  DEGRADES THAT OWNER — recorded in a user-level `owner.json` with a redacted
  reason; the error still propagates (no silent auto-fallback to another
  credential). A later successful call auto-clears the degradation. `aih models`
  marks degraded owners (`⚠ degraded`), and `aih models`/`aih stats` print a
  redacted "degraded owners" report with `--clear-degraded` to reset.
  Hard-fail still blocks: missing key / unknown provider / policy-denied
  providers throw at resolve time. (`cli/src/owner-state.ts`,
  `core/src/seams/llm-openai.ts`)
- **Live-verify & check-existing-first disciplines (OC#3, OpenClaw "Start"
  borrow)**: two default working rules injected into the system prompt —
  ① a user-visible behavior must be exercised through the REAL production
  path before it is claimed done (skipping requires a concrete infeasibility,
  never "to save effort"); ② before proposing/building anything custom, do a
  BRIEF gate for an existing OSS library / installed skill / already-shipped
  capability (a brief gate, not a research assignment). (`core/src/prompts.ts`
  `LIVE_VERIFY_DISCIPLINE`, injected in `loadSystemPrompt()`)
- **Core per-call tax + repeat-demand→seam governance (OC#2, OpenClaw "Two
  layers, two bars" borrow)**: an explicit decision heuristic — every core
  tool/prompt line/config key reaches EVERY operator's EVERY model request, so
  core admission is reviewed strictly (default: don't); one-off / domain logic
  goes to skills (`.aih/skills`) or extensions (`.aih/extensions`) which carry
  no such tax and are encouraged to grow. When the same capability is
  independently wired in ≥2 places, the right response is a CONTRACT not a
  string of merges: land the seam in core/SDK, migrate the bundled impl onto
  it, hang the rest as plugins. Decision rule in `docs/decisions.md` + `APP.md`
  §6 rule 4.
- **Trust model statement (OC#4, OpenClaw "trust boundary" borrow)**: AIH is a
  LOCAL SINGLE-OPERATOR trust model — the trust boundary is the host OS user,
  session ownership/visibility is an availability feature NOT a security
  boundary, and a prompt-injection-only chain is not a security bug unless it
  crosses a hard boundary (allow/ask/deny gate, credential redaction + owner
  isolation, sandbox seam, tool `deny` red line). Documented in `APP.md`
  §3 (capability boundary → new "trust model" subsection) and `README.md`
  (permissions section).
- **Config self-healing via `aih doctor --fix` (OC#5 residual)**: the OC#5
  guard makes an OLD build refuse to open a NEWER config (fail-closed); this
  adds the complementary direction — a NEW build helps a user migrate a legacy
  config UP. `aih doctor --fix` scans the global user config + project
  `aih.json` / `.aih/config.json`, detects legacy shapes (currently the missing
  `schemaVersion` stamp — rule `M1-schema-version-stamp`), backs up each changed
  file to `<path>.bak.<ts>`, and rewrites it in the canonical stamped form.
  Idempotent (a second run is a no-op); unparseable files are left for the user
  to fix. The top-level flat `model`/`baseUrl` are still a valid current shape
  and are deliberately NOT touched. (`cli/src/migrate.ts`, `cli/src/index.ts`)
- **Maturity scorecard / coverage-ID + evidence-mode classification (OC#6,
  OpenClaw taxonomy.yaml borrow)**: `aih coverage [--profile NAME]` derives a
  STABLE coverage registry directly from the smoke test's section headers (so
  it never drifts from the tests), tags each group with an evidence mode (`mock`
  / `live`), and selects a subset per profile — `smoke-ci` runs only mock
  groups, `release` additionally runs `live` groups (real provider/channel,
  currently TP#6's API-key bench), and `personal-agent` sits in between.
  `npm run eval:quality` runs the release coverage matrix. (`cli/src/coverage.ts`,
  `cli/src/index.ts` `cmdCoverage`, `package.json` `eval:quality`)
- **BuffBench-style quality eval suite + baseline regression gate (FB#4)**:
  `aih quality [--mock] [--json]` runs the committed quality task suite
  (`evals/quality.tasks.json` — fixed tasks with expected products, auto-scored
  against `expect` substrings), then compares pass/fail against
  `evals/quality.baseline.json` (cellId / `task__*__rN` wildcard patterns that
  MUST pass) to catch "改 A 坏 B" regressions. Reuses the P#46 `runExperiment`
  runner. A `live` run (real model) gates on regressions; a `--mock`/CI run is
  deterministic and informational (mock subjects can't demonstrate real
  quality). `npm run eval:quality` runs the suite (mock) then the coverage
  matrix. (`cli/src/eval.ts` `loadQualitySuite`+`compareToBaseline`,
  `cli/src/index.ts` `cmdQuality`, `evals/`)

### Fixed
- **Overlay picker scroll highlight drift ("chose one, got another")**: the
  `/model` / ctrl-p palette rendered its selection mark by comparing a
  window-relative loop index against the GLOBAL `sel`, so once the list
  exceeded the visible rows the highlighted row and the actually-selected
  entry drifted apart. Extracted `paletteWindow(sel, len, maxRows)` returning
  `{ top, highlight }` and render with the window-relative `highlight`.
  (`cli/src/tui.ts`)
- **Phantom near-full context / false compaction on model switch**: free-tier
  gateways (opencode zen go) report CUMULATIVE/garbage `prompt_tokens`
  (observed 949K / 3.2M on a ~78K-token conversation). The old plausibility
  gate (`prompt_tokens ≤ 2×window`) admitted those once the window grew to 1M
  (deepseek-v4-flash), so switching big-pickle (200k) → deepseek-v4-flash
  (1M) flashed "949K / compact needed" (949K ≥ 0.8×1M). Plausibility now also
  cross-checks the local chars÷4 estimate in BOTH directions — report ≫
  estimate → cumulative garbage (estimate wins); estimate ≫ report → stale
  sample (estimate wins). Mirror guard in `agent-loop.ts` (`plausible`) and
  `cost.ts` `lastContextTokens`. (`core/src/agent-loop.ts`, `cli/src/cost.ts`)

## [0.4.0] - 2026-08-29

### Added
- **Quota auto-resume (CC#51)**: when the provider reports usage-limit
  exhaustion (429/402 + quota/limit/credits, or `Retry-After` ≥ 60 s), the
  interactive session waits for the reset (default 60 s, cap 1800 s) and
  re-issues the **same** rejected call — not a re-run of the turn. Bounded to
  2 waits (`MAX_QUOTA_WAITS`); TUI shows a wait line; `AIH_QUOTA_AUTO_RESUME=0`
  disables. Non-interactive `run` fails fast. `quota_wait` session event.
- **Read-only auto-allow (CC#54)**: read-only tool calls (list, read, glob,
  grep, etc.) are auto-allowed without an `ask` prompt, reducing approval
  friction for safe operations while write/dangerous calls still require
  confirmation.
- **Credential scope (CC#59)**: sensitive headers (`api-key`, `x-api-key`,
  `x-goog-api-key`, `x-nano-fp`, `x-amz-security-token`, etc.) are dropped
  when the effective request host differs from the provider's home host,
  preventing key leakage to third-party or proxy endpoints.
- **BOM tolerance (CC#55)**: `readJson` strips a UTF-8 BOM so config and
  JSON state files saved with a BOM prefix parse correctly.
- **MCP empty-schema (CC#56)**: tools with an empty or missing `inputSchema`
  no longer break the MCP handshake; they are exposed with a no-arg schema.
- **/usage Loops (CC#57)**: `/usage` now shows a per-loop (per-tool-call)
  token breakdown alongside the session totals.
- **TUI truncation (CC#58)**: long lines in the TUI transcript truncate
  cleanly at the terminal width instead of wrapping and overflowing.
- **Injected-source isolation (CC#60)**: approval requests with
  `source: "injected"` (from `serve`/`attach` remote `POST /message`) are
  rejected directly without a human prompt — a remote message cannot spoof
  an approval. TTY keyboard approvals are unaffected.
- **Question tool (35cec96)**: the agent must use the `question` tool for
  user decisions instead of writing the question as assistant text and
  continuing to act. The user actually sees and answers the question before
  the agent proceeds (opencode / Claude Code parity).
- **Bilingual docs site (77dfa9a, 5811654, 72456f3)**: static zh + en docs
  at `docs-site/` with opencode.ai / Starlight typography, 8 new page pairs
  (agents, commands, coding, tui, architecture, troubleshooting, development,
  changelog), language switcher, real TUI screenshots, and a GitHub Pages
  deploy workflow (`.github/workflows/docs.yml`). Live at
  `https://summit4you.github.io/aih/`.
- **Harness health scorecard (PE#3)**: `aih scorecard [--format json]`
  reports the six playbook metrics — completion rate, rework rate,
  escalation rate, recovery time, cost per verified result, and guide
  growth — computed purely over the existing append-only session log +
  `.aih/memory.md` (no new storage, zero new dependencies).
- **`escalate` session event (PE#4 foundation)**: a first-class
  "stop and hand a human a decision" primitive (distinct from `ask`), with
  `reason` / `options` / `safestDefault`. Gives the scorecard's escalation
  metric a real data source and sets up bounded sensor/budget escalation.
- **Safety seam (PE#1 / PE#2 / PE#4)**: the harness enforces safety, not the
  model. Three pieces, all pure-function seams (zero new dependencies),
  adjudicated by the kernel after every tool batch:
  - **PE#2 budget hard constraint + tripwire** — `BudgetTracker`
    (`core/src/budget.ts`) accumulates cost / write-count / wall-clock and
    guards a `denyPaths` scope list. A hard bound (`maxCostUsd` / `maxWrites`
    / `timeoutMs` / `denyPaths`) → `escalate` + `stopReason="escalated"`,
    stopping the turn. A soft **tripwire** (task cost ≥ 2× session mean) →
    `onTripwire` hint once (latched per task), non-blocking. Configure via
    `aih.json` `safety.budget` or `AIH_BUDGET`
    (`maxCostUsd=1|maxWrites=5|timeoutMs=60000|denyPaths=a|b`).
  - **PE#1 computational sensors** — `SensorLoop` (`core/src/budget.ts`) +
    `cli/src/safety.ts` executor. After a write tool succeeds, run a declared
    `{name, command, onTools?, pathPrefix?, timeoutMs?}` check (children get
    `buildChildEnv`, so they inherit **no secrets**). Exit 0 = green; red →
    bounded retry (`AIH_SENSOR_RETRIES`, default 1) → escalate. Configure via
    `safety.sensors` / `AIH_SENSORS`.
  - **PE#4 escalate primitive** — `AgentLoop.escalate()` emits a
    **model-invisible** `escalate` event (`reason` + `options[2-4]` +
    `safestDefault`; `deriveMessages` skips it). Non-interactive `run` prints
    the options + safest default then **exits code 3** (`ESCALATE_EXIT_CODE`);
    the TUI renders the options for a human to choose.
  - **Recovery test** — `test/recovery.sh` drives the real CLI + mock LLM over a
    real persisted session: escalate event persisted & replayable, exit code 3,
    and a mid-turn crash (dispatch, no result) → resume reads the checkpoint,
    parks the tool (indeterminate, outcome UNKNOWN) and does **not** re-dispatch
    it. 10/10, stable.
- **Intelligent Terminal UX group (IT#1–IT#5)**: context flow + deterministic
  error-detection + session management, borrowed as pure seams:
  - **IT#1 shell context** — `shell_context` tool + TUI `/shell` +
    `AIH_SHELL_CONTEXT=auto`: the agent proactively reads recent shell
    commands / exit codes / cwd / output tails (`cli/src/shell-context.ts`).
  - **IT#2 error detection + one-click fix** — `cli/src/error-detect.ts`
    deterministically (no LLM) detects `run_cmd` failures, lights a red
    `⚠ N failed` status badge, and TUI `/fix` sends the failure context to the
    agent for a fix suggestion.
  - **IT#3 `?` prefix quick task** — `cli/src/question.ts`
    (`classifyQuestionPrefix` / `buildQuestionContext` / `composeQuestionPrompt`):
    a TUI input line starting with `?` starts an agent task with the current
    shell context auto-injected.
  - **IT#4 `/sessions` panel** — `cli/src/sessions.ts`
    (`buildDashboard` / `formatDashboard`): a TUI session-management surface
    listing active + saved agent sessions with status, token usage and cost;
    `/sessions kill <id>` cancels a running job, `/sessions view <name>` shows
    a per-session summary.
  - **IT#5 run-or-copy approval** — `cli/src/clipboard.ts` + TUI `askRunOrCopy`:
    a write-kind `run_cmd` approval is now explicit `[R]un / [C]opy / [N]o`
    (copy degrades to printing the command when no clipboard is available),
    never auto-running.
- **`aih measure` distance ruler (PR#2)** — `cli/src/measure.ts` answers
  "how much did it change, and how" (vs the scorecard's "how good is it
  now"): `measure distance <a> <b>` (per-surface structural diff, missing
  snapshot → explicit degraded, exit 1), `measure stream <traces>` (tool-flow
  L1 + bigram Jaccard with a seeded permutation test), and
  `measure crystallize <evolved> <neutral>` (disposition stability; drift →
  exit 1 + `DRIFTED`). Pure functions, `--json` out.
- **`aih session rm --all`**: a real `-a/--all` boolean flag removes every
  saved session (the correct bulk-clear); per-name guards unchanged (path
  traversal still rejected, non-session names still error instead of a fake
  "removed"). Fixes `aih session rm *` where the shell expanded `*` into CWD
  files and the old per-file loop errored with no way to bulk-delete.

- **Multi-strategy `best_of_n` (Freebuff FB#1, borrowed from CodebuffAI/freebuff
  `editor-multi-prompt.ts`)**: pass `prompts` (an array of short strategy
  prompts) and each candidate works the SHARED task context plus its own
  strategy direction (candidate i follows `prompts[i % len]`) — wider
  exploration than N samples of one prompt. The result carries `strategies`;
  the judge labels each candidate with its strategy so it can weigh "right
  approach" as well as "right answer". Omit `prompts` → unchanged
  single-prompt behavior. `cli/src/maxmode.ts` + `cli/src/general-tools.ts`
  + smoke coverage.
- **Two-judge panel for `best_of_n` (Freebuff FB#2, borrowed from freebuff
  BuffBench independent-judging)**: opt-in via `AIH_SECOND_JUDGE_MODEL`
  (`buildJudge2Llm` reuses the primary model's provider/base-url/api-key,
  only the model id differs). The two judges run in PARALLEL
  (`Promise.allSettled`); the primary's pick is kept (median of two). A
  disagreement or a failed judge is flagged (`judgeDegraded`) and warned on
  stderr — a silently-dropped judge would turn the panel into one opinion.
  Both judges failing → hard error. The panel is a generic `judgePanel<V>()`
  helper so the `/goal` judge can share the same discipline (roadmap FB#6).
  Absent → single-judge behavior (unchanged). `cli/src/maxmode.ts` +
  `cli/src/index.ts` + smoke coverage (agreement / disagreement / second
  failed / primary failed / both failed).
- **Compaction "historical memory only" guard (Freebuff FB#3, borrowed from
  freebuff `context-pruner.ts` summary positioning)**: the compaction
  `SUMMARY_TEMPLATE` now tells the model the summary is HISTORICAL MEMORY
  ONLY — not dialogue, not an output template, not a tool-call format;
  continue from the live user message and use real tool calls when actions
  are needed. Guards against the model copying the summary's structure into
  its live output after compaction. `core/src/agent-loop.ts` + smoke
  coverage.

### Changed
- **webfetch hardening (opencode/MiMo parity, zero new deps)**: the old
  implementation was one-shot — a single 20s fetch with a bot UA, no Accept
  header, body downloaded before the size check, and bare error text
  ("webfetch failed: HTTP 403") that told the model nothing it could act on.
  In flaky networks every transient blip became a visible failure. Now:
  browser-grade UA + Accept/Accept-Language headers (bot-block resistance);
  one bounded retry on network failures (connect/DNS/TLS/abort); Cloudflare
  `403 + cf-mitigated: challenge` → honest-UA retry (opencode pattern);
  configurable timeout — tool `timeout` arg (seconds) > `AIH_FETCH_TIMEOUT_MS`
  > 30s default, hard cap 120s; `content-length` precheck before downloading;
  actionable failure messages (FA#2: state what happened AND what to try next —
  alternate endpoint / websearch).
  `cli/src/general-tools.ts` + smoke coverage (timeout resolution, challenge
  detection, retry bounds, honest-UA path, tool surface).

### Fixed
- **Slash-command parsing**: pasted code whose comment starts with `//`
  (e.g. `// setvbuf(stdout, …)`) is no longer parsed as a slash command;
  unknown `/…` reaches the model as a normal message (opencode
  `parseSlashCommand` parity).
- **Subagent partial results (CC#50)**: subagent turns that produce partial
  output before an error no longer lose the partial text.
- **load_skill dedup (CC#52)**: loading an already-loaded skill is a no-op
  instead of duplicating its instructions in context.
- **Permission ask for write tools (CC#53)**: write-kind tools that are
  marked `ask` now consistently prompt before executing (previously some
  paths bypassed the gate).
- **Tool-output budget marker (FA#2)**: when a turn's total tool output
  exceeds `TURN_TOOL_BUDGET_CHARS` (12K), later results are replaced by a
  marker. The old cryptic `[turn budget: truncated]` made the model
  blind-loop (30+ steps re-issuing tools, each also truncated, wrongly
  inferring the environment had failed). The marker is now an explicit,
  actionable directive — stop running read/debug tools, wrap up from what it
  has, and that a new message resets the budget on a fresh turn — appended as
  a trailing user message so tool-call pairing is preserved.
- **Language rule covers progress notes**: the system-prompt language rule
  now requires **every** user-facing text — the final answer *and* the short
  progress notes written before/between tool calls — to match the user's
  major language, so a Chinese user no longer sees a wall of English
  tool-narration mid-task.

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

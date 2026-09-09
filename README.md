<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

<h1 align="center">AIH — App Intelligence Harness</h1>

<p align="center"><strong>A general framework that gives any ordinary app (Web / Desktop / Mobile / backend service) AI capabilities through a standardized adapter.</strong></p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness">deepseek-harness</a> · <a href="https://github.com/anomalyco/opencode">opencode</a> · MIT
</p>

---

AIH (App Intelligence Harness) standardizes "connecting an app to an agent": implement a lightweight
`AppAdapter` (read Context / write Action / receive Event), and your business app gains
three-tier allow/ask/deny permissions, append-only session audit, a pluggable skill layer and
three integration forms (MCP plugin / CLI / embedded SDK) — **without changing any business code**.

---

## Installation

**macOS / Linux / WSL** — one-line install (requires [Node.js](https://nodejs.org/) ≥ 20):

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

**Windows PowerShell**:

```powershell
irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex
```

**Options**: `--version <ver>` (pin a version), `--dir <path>` (custom install dir), `--no-modify-path`

**Offline installers** (fully self-contained, no network needed): download `aih-<version>-offline.sh`
(macOS/Linux) or `aih-<version>-offline.ps1` (Windows) from the
[releases page](https://github.com/summit4you/aih/releases), then run
`sh aih-*-offline.sh` / `powershell -ep Bypass -File aih-*-offline.ps1`.

**From source** (developers):

```sh
git clone https://github.com/summit4you/aih && cd aih
npm run bootstrap   # install dependencies
npm run doctor      # readiness check
npm run check       # build + contract consistency check
npm test            # smoke tests (core / mcp / cli)
npm run eval        # full handoff gate (doctor + bootstrap + check + test)
```

## Updating

AIH checks the [GitHub releases](https://github.com/summit4you/aih/releases) page in the
background at startup (silent on failure, never blocks). When a newer release exists the
TUI shows a nudge: `✨ vN available — /update to upgrade now`.

```sh
/update              # in the TUI: check → confirm → download to local staging → apply
/update 0.9.0        # pin a specific version
aih update --check   # report current vs latest only
aih update --yes     # non-interactive (skips the confirm prompt)
```

The update is downloaded to a local staging dir **first**, extracted, verified
(`aih --version`), and only then swapped in atomically — the previous install is never
removed before the new one is proven good. Skipping a version is remembered (per version;
a newer release re-triggers the nudge). In-place update applies to the tarball install
layout (`~/.local/share/aih/app`); source checkouts and npm installs print the official
install command instead. Disable all of it with `AIH_DISABLE_UPDATE_CHECK=1`.

```sh
# Run aih directly to enter the interactive terminal (opencode-style TUI, needs TTY)
aih

# One-shot Q&A (--mock offline demo, no API key needed)
npm run cli -- run "add a todo buy milk" --mock

# Real model (any OpenAI-compatible endpoint, SSE streaming)
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "what todos do I have today?"
```

---

## Core Features

AIH's four-layer kernel splits "integration" into clearly separated responsibilities, fusing
design ideas from deepseek-harness / opencode:

| Source | Borrowed | Landing |
|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | append-only Session Log ("what the model sees can be replayed"), guarded tool pipeline, Agent Loop, replaceable capability seams | `core/` (L1 kernel) |
| [Harness-for-codex](https://github.com/ganimjeong/Harness-for-codex) | AGENTS.md-style instruction contract, standard commands (bootstrap/check/test/eval/doctor), task briefs & decision logs | `APP.md`, `harness.yml`, `scripts/`, `tasks/`, `docs/` (L2 protocol) |
| open agent skills ecosystem | SKILL.md progressive disclosure, self-evolving skills | `skills/` (L3 skill layer) |

### L0 Adapter Layer (AppAdapter)

Implement one `AppAdapter` to integrate any app: `descriptor` + `context(query)` +
`actions` (action params defined with zod). Three primitives:

| Primitive | Meaning |
|---|---|
| **Context** | Read, `allow` tier, executes directly |
| **Action** | Write, carries `allow/ask/deny` permission |
| **Event** | Change-event stream, optional |

### Three Integration Forms

| Form | Scenario | Entry |
|---|---|---|
| **MCP plugin** (zero-intrusion, recommended start) | Plug into any MCP client: opencode / codex / claude code | `mcp-server/dist/index.js` |
| **CLI integration** | Interactive terminal, one-shot Q&A, script pipelines | `aih` / `aih run` / `aih chat` |
| **Embedded Copilot** (SDK) | Reuse the L1 kernel directly, register tools into `AgentLoop` | `@aih/core` |

### serve / attach (remote mode)

`aih serve` runs the harness (MCP + loop) as a headless HTTP/SSE service, solving SSH
latency and separating UI from backend:

```sh
aih serve --port 8787 --session work   # headless harness (MCP + loop)
aih attach http://127.0.0.1:8787       # attach a REPL from another machine
```

- `GET /health`: readiness (tool count / session name / version)
- `GET /events`: SSE event stream (incl. streaming `app/event` delta frames)
- `POST /message`: submit a turn, returns a structured result
- `GET /tools`: list the current toolset
- `aih attach` is an SSE client: replays existing events + live tail, optional `--min-events` /
  `--timeout`; `attachInteractive` provides a REPL. Implementation: `cli/src/serve.ts`.

### Multiple Agents (build / plan)

Aligned with opencode's build/plan split:

- **build**: default, full tool permissions for development
- **plan**: read-only analysis mode, all `kind=write` tools are hidden from the registry
  (incl. write_file/run_cmd), meta line shows `plan · …` (yellow)

Switch with Tab (when no completion) or `/mode <build|plan>`.

### Goal / Stop Condition

After `/goal <condition>`, an independent LLM call judges whether the condition is truly met
at the end of each round — met stops (`✅ goal met`), not-met auto-injects a continuation
prompt and tries again, up to `AIH_GOAL_ROUNDS` (default 3) extra rounds; `/goal clear`
cancels. Prevents "optimistic stopping"; a key reliability switch for batch/inspection tasks.

The judge prompt embeds **completion honesty rules** (borrowing LongHorizon-Harness's
Final-State Guard and Task Contract, arXiv 2608.01964): the agent's own claim of "done" is
not evidence — it must be judged from real state carriers in the conversation (file contents
read back by tools, command exit codes, test output); supports extended verdicts
`{"met": bool, "reason": str, "unmet": [...]}` — unmet acceptance criteria are injected
back as continuation instructions requiring item-by-item re-verification against persisted
state. The system prompt carries the same guard; `/goal` echoes a structured contract
template (Objective / Acceptance criteria / Constraints / Current state / Next move).

**Contract-style example** — turning a vague goal into a "verifiable target state", three
elements: what counts as done (state carrier), how to verify (executable check), what must
not change (constraint):

```
/goal Fix the bug where deny rules in cli/src/gate.ts don't take effect
Acceptance criteria:
1. npm test all green (read back exit code)
2. node -e "new Gate().request('write_file')" returns denied
Constraints: don't touch any file under core/src/; keep existing export signatures
```

One-liners also work: `/goal README.md contains a section "v0.2.0 release notes"; visible
via cat README.md; other sections unchanged`. Write verification as commands that produce
real evidence (`npm test`, `grep … file`) rather than "looks right". Without `/goal`, behavior
is unchanged — the system prompt just carries ~550 tokens of guard rules; the goal judge
costs nothing when unset.

CLI side works too: `aih run --goal "<condition>" "<task>"` does bounded auto-continuation
non-interactively; judge events are written to the session log as structured `goal/judge`
entries (append-only JSONL, auditable replay).

#### MEA Independent Judgment Layer (write-action Guardian + completion Auditor)

The roadmap's highest-priority item (LH#1 LongHorizon Auditor + CX-R#1 codex Guardian
merged) — filling AIH's previously unimplemented "independent judge" role, a second pair of
eyes outside the main agent:

- **Write-action Guardian (enabled by default, takes over the ask flow)**: before a human
  confirmation prompt for a write op, an independent tool-less LLM evaluates
  `risk × authorization → allow/deny/ask` against a declarative policy
  (`AIH_GUARDIAN_POLICY`, built-in policy default). Low-risk allow passes without bothering
  you; deny rejects and injects "do not circumvent to achieve the same outcome"; consecutive
  denials ≥3 trigger a circuit-breaker stop directive. **fail-closed**: timeout / parse
  failure / LLM error → deny (`AIH_GUARDIAN_FAIL_CLOSED=1`), otherwise degrades safely to
  human confirmation. No API key / no configurable LLM → auto-degrades to the original human
  gate (zero behavior change) — the local deterministic default. Disable with `--no-guardian`
  or `AIH_GUARDIAN=0`.
  **UX-relief trio (2026-09-05)**: (1) built-in policy treats "routine workspace writes =
  low-risk → allow-leaning", keeping only real red lines (credentials/secrets, data
  exfiltration, destructive bulk deletes, policy circumvention) as deny grounds, cutting
  false denials at the source; (2) `AIH_GUARDIAN_TRUST=1` trust mode — Guardian's allow
  passes at **any** risk level (medium no longer falls back to human), deny still blocks;
  (3) on deny the keyboard prompt shows `[g] grant <scope>` — one keystroke writes a session
  allow rule, permanently short-circuiting the Guardian for that scope (press `[n]` to reject
  for this call only).
- **Completion Auditor (/goal independent verification)**: after the goal judge rules met,
  an independent Auditor LLM audits the real artifact against a **verified-state ledger**
  (collected from real tool output in the session log, not agent self-narration) and produces
  an AuditReport; only `complete + contract_aligned + integrity≥0.9` counts as a trusted
  state — missing/blocked degrades to not-met with a resume injection. Both interactive
  `/goal` and `aih run --goal` paths are wired in.
### Deterministic Workflow (`.aih/workflows/*.mjs`)

Write fixed flows as code instead of prompts — borrowing MiMo-Code's `.mimocode/workflows`
and opencode's deterministic pipeline. A workflow is an ESM module exporting a `phases` array:

```js
// .aih/workflows/example.mjs
export default {
  name: "example",
  phases: [
    { name: "check", prompt: "Run npm test and summarize the result", expect: "passed" }, // single agent call
    { name: "fanout", prompts: ["review core/", "review cli/"] },               // parallel fan-out
  ],
};
```

Phases run in order; `expect` is an output-substring gate (fail-fast if unmet), `retries`
bounds extra retries. Running produces a JSON report:

```sh
aih workflow list                      # list workflows under .aih/workflows/
aih workflow run example               # non-interactive run → report
aih workflow run example --format json # JSON report (CI-friendly)
```

First use case: one-shot regression of the acceptance items in the APP.md generated by `aih init`.

### Post-write Auto-formatting

After `write_file` / `edit` / `apply_patch` succeed, AIH auto-detects the project formatter
and runs it (borrowing opencode formatters): probing upward from the written file for config
files and lockfiles, priority prettier > biome > eslint `--fix`; with a timeout
(`AIH_FORMAT_TIMEOUT_MS`, default 15s). Format failure **never blocks the write** — it only
attaches a `formatNote` hint to the tool result; success is folded into the `formatted: true`
flag.

### Parallel Read-only Tool Calls

**Consecutive read-only tool calls within one step run concurrently** (same-origin design as
codex `parallel.rs`): read-class batch concurrency, capped at `AIH_TOOL_CONCURRENCY`
(default 4); write-class stays serial — ordering semantics and doom-loop detection are
unaffected. Completion order doesn't affect persistence: `tool/result` events are always
written to the session log in **original call order**, so replay/audit sees exactly what the
model saw.

### Shell Context Awareness (IT#1)

The agent can **proactively pull** this session's recent shell context, saving the user from
manually pasting errors/output (borrowing Intelligent Terminal's "agent has context on your
shell output, no copy-pasting needed"). A pure seam `cli/src/shell-context.ts` (no I/O, no
LLM, unit-testable) extracts the recent N commands (command · exit code · cwd · output tail;
full-output file path when `keep_output`) on top of the session log's `run_cmd`
`tool/call`+`tool/result` events; reads only `run_cmd`'s `stdout` field, never leaks other
tool output; uses `result.code` for success (non-zero exit is still `ok:true`, hence reading
`code` not `ok`). Three usages:

- **`shell_context` tool** (read/allow): agent pulls on demand, tunable `max_commands`
  (default 3, cap 10) / `max_output_chars` (default 4000); no shell history → `{ found:false }`
  explicit empty state.
- **TUI `/shell`**: shows recent shell context; `/shell --send` injects the context block into
  the next turn.
- **`AIH_SHELL_CONTEXT=auto`**: auto-attached at the start of every normal message turn
  (empty state → no-op, no noise injected).

### Deterministic Shell Failure Detection + One-click Fix (IT#2)

When `run_cmd` fails (non-zero exit / timeout), AIH **deterministically** (not LLM) detects
it and lights the status-bar error indicator; one keystroke sends the failure context to the
agent for a fix (borrowing Intelligent Terminal's "auto-detect command failures, send to
agent for fix suggestions"). Pure seam `cli/src/error-detect.ts` (no I/O, no LLM,
unit-testable) reuses IT#1 `extractShellContext`:

- **Failure detection**: non-zero exit or timeout (`isFailed`). **Exit 0 is never a false
  positive** — classification only **annotates** the kind (fixed regex set
  `crash/network/js/test/fs/build/unknown`), doesn't decide success, so green commands are
  never misjudged and unknown-pattern failures still report `unknown`.
- **Status-bar indication**: red `⚠ N failed` (`tui.ts` `shellErrorBadge?()`, hidden when all
  green). Recomputed+cached at `tool/result`/`turn/end`, back-filled on startup (resume lights
  up too).
- **TUI `/fix`**: detect failure → show summary → assemble a fix-request block (command +
  exit code + classification + output tail + full-output path) through `evalTurn` to the
  agent. `/fix --show`/`--dry` preview only; rejected when `busy`.
- **`AIH_ERROR_DETECT=0`**: disable auto-indication (explicit `/fix` always available).

### `?`-prefix Quick Task + Context Injection (IT#3)

A TUI input line starting with **`?`** launches an agent task with **current context
auto-injected** (borrowing Intelligent Terminal's "type `?` + prompt, injects active pane
context"). Pure seam `cli/src/question.ts` (no I/O, no LLM, unit-testable):

- **`classifyQuestionPrefix`**: `?` + space + text / `?` + CJK (no space) → task; bare `?`,
  `?foo` (`?` immediately followed by ascii), trailing `?`, no `?` → **not** misclassified
  (literal).
- **`buildQuestionContext`**: reuses IT#1 shell-context to assemble the context block (recent
  shell output + cwd + active session); empty log → cwd only, no noise.
- **`composeQuestionPrompt`**: context block + `Task: <prompt>` into one prompt for the agent.

### `!`-prefix Direct Shell Execution (opencode / mimo-code parity)

A TUI input line starting with **`!`** runs as a **direct shell command** in place (opencode/
mimo-code's "Start a message with `!` to run shell commands directly (e.g. `!ls -la`)"),
**never sent to the LLM** — `!ls` runs `ls` in the terminal and echoes output:

- **Unified executor**: shares `runShellCommand` with the `run_cmd` tool
  (`cli/src/dev-tools.ts`) — the same sandbox + env filter + timeout + middle-truncation
  pipeline, so tool and input-prefix never drift.
- **Runs even while busy**: `!cmd` during a running turn still executes directly (opencode/
  codex behavior), never steered into an injection message for the running turn.
- **Entered into session history**: persisted as `run_cmd` `tool/call` + `tool/result` events,
  so the existing IT#1 (`/shell`) and IT#2 (`/fix`) shell-context mechanisms pick it up — no
  separate side channel.
- **Bare `!`** shows usage; `!` is special only as the **first character** of a line
  (mid-line `!` is ordinary text).

Reference implementations (all three repos read): opencode/mimo-code use an input-box
**keybind** (cursor at position 0, press `!` to enter shell mode, Enter submits via the
`session.shell()` endpoint); codex uses the `!` prefix directly and marks output as
**"You ran"** in the conversation. AIH takes the middle — line-leading `!` executes natively
on submit, interaction intuition matches codex, executor aligns with opencode's
sandbox/env/timeout.

### Multi-agent Session Panel (IT#4)

TUI **`/sessions`** is a resident session-management surface: lists active agent sessions +
status + token usage and cost (borrowing Intelligent Terminal's "track active agent sessions
and their status"). Pure seam `cli/src/sessions.ts` (no I/O, no LLM, unit-testable):

- **dashboard**: active (job-backed, newest-first) + saved (non-job, idle) zones, aggregating
  `totalTokens` + `totalCost` (when a price table exists).
- **`/sessions kill <id>`**: cancel a running background job.
- **`/sessions view <name>`**: token/cost summary for one session.
- Status mapping running / done / failed / cancelled; empty → `(no sessions yet)`.

### Command Approval run-or-copy (IT#5)

When the agent proposes a **write-class** `run_cmd` command, approval is no longer a vague
`[y]es/[n]o/[a]lways` but an explicit **`[R]un / [C]opy / [N]o`** (borrowing Intelligent
Terminal's "gives you the option to run or copy it rather than running it automatically") —
**never auto-runs**:

- **`R` (run)**: approve and execute.
- **`C` (copy)**: copy the command to the clipboard (`pbcopy`/`wl-copy`/`xclip`/`xsel`/`clip`
  probe, `cli/src/clipboard.ts`), **without executing**; no clipboard → degrades to
  **printing the command** for manual paste.
- **`N` (no)**: reject.
- **Read-class commands** still go through the CC#54 auto-allow whitelist
  (`ls`/`cat`/`grep`… auto-pass, no run-or-copy prompt); non-`run_cmd` write asks keep the
  generic `[y]/[n]/[a]`.
- Compatibility: TUIs without `askRunOrCopy` (e.g. test stubs) auto-fall back to
  `askConfirm`; CC#54 contract intact (`gate.ts` probes at routing).

### Change Visualization (diff rendering)

After edit-class tools (`write_file` / `edit` / `apply_patch`) execute, the TUI renders a
before/after diff: green `+` additions / red `-` deletions, LCS line-level alignment,
auto-truncation past 80 lines with `… N more line(s)`. Implemented in `cli/src/diff.ts`
(also returned as the `_diff` field of MCP tool results, renderable by any client).

Wide terminals (≥100 cols) render side-by-side dual columns: left-delete (red bg, old line
numbers) / right-add (green bg, new line numbers), line-number slots auto-sized to the actual
max; narrow terminals (<100 cols) auto-fall back to unified single column (inline numbers);
light/dark dual theme palettes. TUI constructor option `width` can lock the column width
(testing/embedding).

### Checkpoint & Rollback (checkpoint / restore)

Structured "rollback-able snapshot points" (roadmap F#28, upgraded P0#1 remainder):

- `checkpoint` events are **append-only markers** (`SessionLog.checkpoint(note?, contextTokens?)`),
  never rewriting history; `restoreTo(seq)` derives the prefix "up to this marker",
  `adopt()` switches the pointer in place
- CLI: `aih session checkpoint [name] [note...]` records a marker;
  `aih session restore <name> [seq]` forks the prefix into a new `<name>-restore-<seq>`
  session — **the original session file is untouched**, full append-only history stays auditable
- TUI: `/checkpoint [note]` and `/restore [seq]`; before rollback the full history is
  auto-snapshotted to `*-pre-restore-<timestamp>.jsonl`, the discarded suffix is queryable anytime
- **worktree summary**: the checkpoint event carries a git workspace snapshot
  (`WorktreeSummary`: branch, HEAD short sha, changed-file list capped at 50 + total) — a
  restore point also tells you "what the code looked like then"; silently omitted when git is
  missing / not a repo / timeout (5s), never blocking checkpoint; CLI & TUI print the summary
  when recording and echo it on restore
- Smoke coverage: marker append, prefix derivation, seq continuation after pointer switch,
  `deriveMessages` skipping markers, overwrite rejection, bad seq / no-marker errors; worktree
  snapshot (non-repo undefined, branch/sha/dirty files, capped count, structured summary on
  the event)

### Branch Distillation (distill-branch, P#37)

When abandoning a branch, "what was learned on the discarded path" doesn't have to die with
it:

- `aih session distill-branch <discarded> <target> [--from seq]` uses **one tool-less LLM
  call** to distill the discarded branch's transcript (tool bodies truncated, input capped at
  24k chars) into 3–6 transferable lessons, appended as a `branch_summary` event to the
  target session — original file untouched, append-only auditable
- `deriveMessages` folds branch_summary into the first system message (coexisting with the
  compaction projection), so the surviving branch keeps the dead path's knowledge without
  bearing its token cost; the distillation prompt takes only "why it failed / constraints
  discovered / key paths and commands", never secrets
- Smoke coverage: projection folding (incl. coexisting with compaction), CLI distillation
  persistence, missing-target rejection

### Eval Experiment Framework (P#46)

"A/B two models running the same batch of tasks N times each, producing a comparable result
kernel" — the credibility bar for modern agent projects:

```sh
# Programming interface (cli/src/eval.ts): tasks × models × repetitions → cell matrix
runExperiment(tasks, models, reps, subject, { outDir, budget })
```

- **SubjectAdapter seam**: eval only owns experiment semantics; execution reuses each
  subject's own runtime — built-in CLI (`cliSubjectAdapter`), any external command
  (`externalSubjectAdapter`, `{prompt}`/`{workdir}` template expansion, can compare other
  agent CLIs), HTTP endpoint (`httpSubjectAdapter`, hitting `aih serve POST /message`)
- **Budget control**: wall-clock (`budgetMs`) and cost cap (`maxCostUsd`, priced from each
  attempt's session-log turn/end usage via the F#30 price table); cells not started after
  budget exhaustion go into `skippedCells` — honest bookkeeping, never fabricated results;
  concurrency cap defaults to `AIH_TOOL_CONCURRENCY`
- **Result kernel**: `{ status, durationMs, outputTail, failureReason, usage, costUsd }`;
  attempts immutable, multi-attempt takes the earliest valid one (anti-Goodhart)
- **CLI surface (FA#6 failed-item rerun)**: `aih experiment` (eval is the repo QA gate, so the
  experiment framework gets its own command) —
  ```sh
  aih experiment run <spec.json> [--exp-id id] [--mock] [--reps N] [--concurrency N]
  aih experiment retry <spec.json> --exp-id id   # == run --retry-failed: only rerun non-passed cells
  aih experiment status <exp-id> [--json]         # passed/failed/error distribution
  ```
  spec: `{ "tasks": [{id, prompt, expect[]}], "models": [{model, provider?, baseUrl?}],
  "repetitions": N }`. Each cell's `status` persists to `.aih/eval/<exp-id>.results.json`;
  `retry` only reruns last `failed`/`error`/unrun cells and merges back into the same result
  set (saves tokens/time), short-circuits when all green.
- Smoke coverage: cell expansion, mock full flow 4 cells, tight-budget skip accounting, usage
  aggregation, cost-cap shutdown, external echo subject judgment, **FA#6 persistence +
  failed-item rerun (only failed cells, passed preserved) + status distribution inspection**

### Quality Eval Suite + Regression Baseline (FB#4, BuffBench-style)

Turn "agent performance on real tasks" into a repeatable eval suite — fixed tasks + expected
artifacts + auto-scoring, preventing "fix A, break B":

```sh
npm run eval:quality      # aih quality --mock && aih coverage --profile release
aih quality [--mock] [--json]   # run evals/quality.tasks.json + regression vs baseline
```

- **Task suite** (`evals/quality.tasks.json`): 5 fixed quality tasks (tool calls / read-then-
  summarize / multi-tool composition / search reporting / instruction following), each with
  `expect` expected artifacts
- **auto-scoring**: deterministic scoring of each task's output against the expected
  artifacts — no LLM judging, no subjective grading, reproducible across runs
- **baseline regression**: scores compared against a committed baseline
  (`evals/baseline.json`); a drop below the threshold fails the gate (`aih coverage` outside
  the release pipeline too), so quality improvements are locked in as a regression test
- Smoke coverage: task suite loads, mock run scores, baseline comparison, threshold logic

### Cost & Throughput (cost / TPS)

- **Live TUI**: the context panel shows `cost $x.xx · N tok/s`; `/usage` shows per-loop
  (per-tool-call) token breakdown + session totals; `aih stats` aggregates across sessions
- **Price table**: builtin `DEFAULT_PRICES` (known model ids), `aih.json` `prices` overrides;
  `resolvePrice` normalizes substring matching (supports dated ids); TPS = session average
  throughput (total tokens / wall-clock span)
- Smoke coverage: price parsing, cost computation, TPS boundaries, formatting

### Prefix Stability (prompt-cache prefix stability, CC-R#3)

- System prompt carries a prefix-stability discipline paragraph (stable content in the
  prefix, volatile content via messages)
- `toolsetFingerprint()` byte-level fingerprint of the toolset; chat TUI registry rebuilds
  (plan↔build, extension registration) compare and emit a system-row warning + log the
  breakage point on change
- `/usage` prefix-stability attribution (cold starts unattributed, idle-TTL consumed by
  `cacheTtlWaste` without double counting, remaining misses listed by prefix breakage)

### Scorecard (harness scorecard, PE#3)

```sh
aih scorecard [--format json]   # six playbook metrics
```

Reports six metrics — completion rate, rework rate, escalation rate, recovery time, cost per
verified result, guide growth — computed purely over the existing append-only session log +
`.aih/memory.md` (no new storage, zero new dependencies). Pure implementation
(`cli/src/scorecard.ts`, same discipline as cost.ts).

### Safety Seam (PE#1 / PE#2 / PE#4)

The harness enforces safety, **not the model**. Three pieces, all pure-function seams (zero
new dependencies), adjudicated by the kernel after every tool batch:

- **PE#2 budget hard constraint + tripwire** — `BudgetTracker` (`core/src/budget.ts`)
  accumulates cost / write-count / wall-clock and guards a `denyPaths` scope list. A hard
  bound (`maxCostUsd` / `maxWrites` / `timeoutMs` / `denyPaths`) → `escalate` +
  `stopReason="escalated"`, stopping the turn. A soft **tripwire** (task cost ≥ 2× session
  mean) → `onTripwire` hint once (latched per task), non-blocking. Configure via `aih.json`
  `safety.budget` or `AIH_BUDGET`
  (`maxCostUsd=1|maxWrites=5|timeoutMs=60000|denyPaths=a|b`).
- **PE#1 computational sensors** — `SensorLoop` (`core/src/budget.ts`) + `cli/src/safety.ts`
  executor. After a write tool succeeds, run a declared `{name, command, onTools?,
  pathPrefix?, timeoutMs?}` check (children get `buildChildEnv`, so they inherit **no
  secrets**). Exit 0 = green; red → bounded retry (`AIH_SENSOR_RETRIES`, default 1) →
  escalate. Configure via `safety.sensors` / `AIH_SENSORS`.
- **PE#4 escalate primitive** — `AgentLoop.escalate()` emits a **model-invisible**
  `escalate` event (`reason` + `options[2-4]` + `safestDefault`; `deriveMessages` skips it).
  Non-interactive `run` prints the options + safest default then **exits code 3**
  (`ESCALATE_EXIT_CODE`); the TUI renders the options for a human to choose.
- **Recovery test** — `test/recovery.sh` drives the real CLI + mock LLM over a real persisted
  session: escalate event persisted & replayable, exit code 3, and a mid-turn crash
  (dispatch, no result) → resume reads the checkpoint, parks the tool (indeterminate, outcome
  UNKNOWN) and does **not** re-dispatch it. 10/10, stable.
### Distance Measure (`aih measure`, PR#2)

scorecard answers "how good is it now" (a point); `aih measure` answers "how much
changed, and how" — a Proteus-style "measurement instrument, not just a score"
ruler. Pure functions (`cli/src/measure.ts`, same discipline as cost.ts/
scorecard.ts, no LLM, unit-testable), **read only declared surfaces + normalized
traces — never reads agent self-narration, never instruments the harness**. Three
subcommands, `--json` for structured output:

- **`aih measure distance <a.json> <b.json>`** — structural distance per surface:
  `added`/`dropped`/`revised` + `pathLength`; `--revised surface=entry,entry`
  declares "present in both but changed" entries. **Missing snapshot → explicit
  degraded (exit 1), never a fabricated large distance**.
- **`aih measure stream <traces.json> [--perms N] [--seed N]`** — behavioral
  distance: tool-stream frequency L1 + transition bigram Jaccard, with a **seeded
  permutation test** (between/within ratio R + p; same seed fully reproducible;
  arm<2 → degraded, no forced computation).
- **`aih measure crystallize <evolved.json> <neutral.json>`** — does the evolved
  state read back equal to itself when mounted on neutral conditions (disposition
  stability)? drift → **exit 1 with signal**, `DRIFTED` marker.

Input schema: `{ "surfaces": [ { "surface": "skills", "entries": ["a","b"] } ] }`
and `{ "traces": [ { "label": "arm", "events": [...] } ] }`. Smoke coverage for
structural-distance exact diff, reproducible permutation test, missing-snapshot
degradation, CLI end-to-end — see the PR#2 block in `cli/src/smoke.ts`.

### Persistent Memory

`.aih/memory.md` is persistent knowledge maintained by the agent itself (separate
from APP.md, the "human-written contract"):

- `remember` tool writes: `action=append` appends dated entries / `action=set`
  rewrites wholesale; `scope` optional `project` (`.aih/memory.md`) / `user`
  (XDG user dir `memory.md`)
- Auto-injected into the system prompt each turn (project + user merged, budget
  `AIH_MEMORY_BUDGET`, default 4000 chars, truncated when over; on truncation an
  actionable hint is appended — the agent knows it was cut and knows to go fetch
  the full text)
- **`memory_recall` read-only tool (KL-R#2, token-overlap retrieval)**: after the
  injected block is truncated by budget, the agent can recall the most relevant
  memory entries with a free-text query (`{"query": "...", "top_k": 8}`).
  Scoring = query token hit count (not vector / not FTS / zero deps): NFKC
  normalization, camelCase splitting, lowercasing, CJK bigrams (Chinese entries
  searchable), static stop words for English function words; generic words
  dynamically suppressed (tokens appearing in >80% of entries with corpus ≥3
  entries don't score, preventing "memory"/"session" from inflating — threshold
  not kilo's original 0.5, since 60% domain-word occurrence is normal in small
  corpora); ordering = score → freshness (date desc) → lexicographic; `restates`
  dedups near-duplicates at ≥85% token overlap; queries both project + user
  levels, returns `score`/`matched`/`scope`
- TUI `/memory` views current memory; `/tidy [project|user]` deterministic dedup
  (keeps newest-dated copy, `/tidy apply` writes)

### Dream / Distill (sessions as assets)

Treat historical sessions as compoundable assets (roadmap P2#7,
`cli/src/dream.ts` pure-function module + TUI commands):

- **`/dream`**: scans the last 5 sessions (≤40 turns each, capped), extracts
  "worth remembering" material — user corrections/preferences (zh/en keyword
  heuristics), checkpoint notes, goal/judge reasons, repeated flows; one
  tool-less LLM call distills the material into ≤5 memory candidates.
  **Suggest-only, never auto-writes** — the user reviews, then `remember` persists
  (keeping the "memory writes need human confirmation" boundary)
- **`/distill`**: deterministically extracts repeated flows — same tool + same
  normalized-argument signature appearing ≥3 times (`run_cmd` commands /
  `webfetch` URLs minus trailing slash / file-class paths) is a skill/workflow
  candidate, with a suggestion (e.g. `npm test` ×N → "wrap as a workflow phase")
- Boundaries: `/dream` reports "nothing notable" without calling the LLM when
  there's no material; LLM failure falls back to printing raw material; scanning
  is fully bounded (5 sessions × 40 turns), big logs don't blow up
- Smoke coverage: flow threshold/sorting/URL normalization, four dream material
  classes, formatted rendering, empty-session no-op

### Intelligent Context Management

Usage hints are computed from the last request's prompt tokens (real window
occupancy): ≥80% yellow, ≥95% red. Over-limit handling aligns with opencode /
MiMo-Code compaction design (`session/compaction.ts`):

- **Keep recent tail verbatim**: `clamp(usable×0.25, 500, 15000)` tokens of the
  most recent conversation are kept **unsummarized**, with split points on user
  message (turn) boundaries so tool calls/results are never torn; only the older
  head goes into the summary
- **user-query invariant** (aligned with opencode/MiMo-Code replay): after
  compaction the model-visible session **must contain a user message** — if the
  tail budget can't fit it, this turn's user text is replayed as the new tail;
  with no user message in history, a synthetic "Continue…" fallback. Otherwise
  strict chat templates like Qwen3 400 directly (`No user query found in messages`)
- **Rolling summary**: each new summary folds into the previous one
  (`<prior-summary>`), produced with a structured template (goal/constraints/
  decisions/current state/next move); tool outputs truncated to 2000 chars when
  serialized
- **Proactive**: after each step `promptTokens ≥ AIH_COMPACT_AT`(0.8) `× context
  window`(default 128k) → summarize old head, write a `compaction` event
  (`summary` + `recent` + `trigger`); thereafter "summary + recent tail"
  replaces the full prior history
- **Passive**: provider returns context-over-limit error → auto-compact and retry
  that step
- **Manual**: `/compact [focus]` compacts anytime (focus can target the summary,
  e.g. "keep all file paths"); compacts the whole conversation when there's no
  old head (refreshes the rolling summary); echoes token count before/after and
  the reduction; session JSONL stays append-only (summary is just a view,
  history stays auditable)
- **File-change manifest (M-R#1)**: on compaction, `buildFileManifest` rebuilds
  the **touched-file list** from the session's read/patch tool events (each file
  recorded as `edited`/`written`/`read: full`/`read: lines x-y`, deduped by last
  touch per path), injected as extra summary input — after compaction the agent
  directly knows "which files were changed/read, which lines", reducing
  re-reads/re-edits; the manifest lands fully in the `compaction` event's
  `fileManifest` field (auditable), rendered capped at `MAX_FILE_MANIFEST_ENTRIES`
  (120) with `… N more` for overflow

**Window per-model + auto-detection** (precedence: `--context-window` >
`AIH_CONTEXT_WINDOW` > **live probe** (llama.cpp `/slots`, taking the min `n_ctx`
across slots = effective single-request window) > aih.json **model-level**
`models[<id>].contextWindow` > `providers.<name>.contextWindow` / `contextWindow`
> default 128k). When the llama.cpp server splits the total window across parallel
slots, `/slots` reports each slot's `n_ctx`, so "2-parallel 256k" resolves to
128k automatically, no manual math; non-llama.cpp endpoints or probe failure
silently fall back to configured values:

```jsonc
// aih.json — configured values as fallback when the probe fails (optional)
{ "defaultProvider": "qwen",
  "providers": {
    "qwen":     { "model": "qwen3-27b",  "contextWindow": 131072 },
    "deepseek": { "model": "deepseek",   "contextWindow": 65536  }
  } }
```

**Per-model declared windows (F#34)**: with multiple models on one provider, a
provider-level `contextWindow` applies uniformly. `models[]` supports object form
`{ "model": "<id>", "contextWindow": <n> }`, applying only to that model (strings
and objects mixable); TUI panel / `/model` switching / `aih config` all follow:

```jsonc
{ "providers": {
    "opencode": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "model": "big-pickle",
      "contextWindow": 200000,                       // primary model (provider-level)
      "models": [
        { "model": "x-preview-f-free", "contextWindow": 1000000 },  // 1M
        { "model": "hy3-free",         "contextWindow": 190000 }    // 190k
      ]
    } } }
```

```sh
AIH_CONTEXT_WINDOW=65536 AIH_COMPACT_AT=0.7 npm run cli -- chat   # temporary override: small window / earlier trigger
```

### Session Persistence & Audit

`chat` and `run` persist sessions to `.aih/sessions/default.jsonl` by default
(saved on exit, including Ctrl-C/exit interruption), auto-resuming next entry;
resume auto-**replays history** (`replayHistory`: user/assistant messages, tool
calls & results, compaction events rendered in order, full context restored);
`--ephemeral` disables persistence.

```sh
npm run cli -- chat                                # default persists to default, auto-recovers next time
npm run cli -- run "add todo A" --session work     # named session → .aih/sessions/work.jsonl
npm run cli -- run "add B too" -c                  # resume most recent session (full context kept)
npm run cli -- session list                       # list
npm run cli -- session show work                  # human-readable replay
npm run cli -- session export work  > work.json   # export as JSON
npm run cli -- session fork default branch-a --from 7   # fork new session from event seq 7
npm run cli -- session checkpoint work "before risky refactor"   # record checkpoint (F#28)
npm run cli -- session restore work   # rollback: prefix forks to work-restore-<seq> (original file untouched)
npm run cli -- session distill-branch branch-a default --from 7  # distill abandoned branch into branch_summary injected into target session
# Inside TUI: /checkpoint [note] and /restore [seq] (full history auto-snapshotted before rollback)
npm run cli -- session rm work                    # delete
npm run cli -- stats                              # all-session token usage summary
npm run cli -- scorecard [--format json]          # harness health scorecard (6 metrics, PE#3)
npm run cli -- measure distance <a.json> <b.json> # structural distance (added/dropped/revised+len, PR#2)
npm run cli -- measure stream <traces.json>       # behavioral distance + permutation-test R (seeded, PR#2)
npm run cli -- measure crystallize <e> <n>        # evolved-state neutral read-back vs endpoint (drift→exit 1)
```

Session files are append-only JSONL (one SessionEvent per line), directly
auditable or programmatically replayable. Every tool call is additionally
appended to `.aih/tool-audit.jsonl` (ts/tool/args[4KB]/ok/error), including
`task` subagent internal calls; `--no-audit` disables. The "model-visible =
already recorded" invariant.

### Subagent System

The `task` tool dispatches subagents: independent context, ≤8 steps, no further
nesting, returns the final answer. `task` itself is approval-free, but every tool
its subagents call still goes through its own permission gate.

### Max Mode (parallel subagents + best-of-N judge)

The `best_of_n` tool dispatches N independent subagents in parallel on the same
prompt (N default 3, cap 8; concurrency bounded by `AIH_TOOL_CONCURRENCY`,
results collected in order), then one **tool-less** LLM judge call picks the best
(`{"best": <index>, "reason": "..."}`; out-of-range/parse failure falls back to
the first successful candidate). All-fail → overall error; exactly one success →
adopt directly (skip the judge). Implementation: `cli/src/maxmode.ts`
(`runSubagent` / `mapOrdered` / `parseJudgeVerdict` / `bestOfN`), zero new deps,
reuses core `AgentLoop` + `ToolRegistry`. Smoke coverage: judge parsing/
out-of-range fallback, `mapOrdered` ordering + concurrency cap, N=3 full flow,
n clamping, all-fail path, subagent anti-recursion (task/question/best_of_n
excluded).

Two optional enhancements (borrowed from CodebuffAI/freebuff, roadmap FB#1 /
FB#2):

- **Multi-strategy mode (FB#1)**: pass `prompts` (a short strategy-prompt array)
  and candidate i layers its own strategy direction on the **shared task context**
  (`prompts[i % len]`) — wider exploration than N samples of the same prompt.
  Results carry a `strategies` field and the judge annotates each candidate
  `[strategy: …]`, letting you weigh "was the approach right" rather than only
  "was the answer right". Omitting `prompts` → single-prompt behavior unchanged.
- **Dual-judge panel (FB#2)**: set `AIH_SECOND_JUDGE_MODEL` to enable a second
  judge — both run **in parallel** (`Promise.allSettled`), keeping the primary's
  choice (the median of two opinions); **disagreement** or **any judge failure**
  marks `judgeDegraded` and warns on stderr (never silently drops a judge —
  dropping would degrade the panel to a single opinion); both judges fail → hard
  error. Default → single-judge behavior unchanged. The panel is a generic
  `judgePanel<V>()`; the `/goal` judge can share the same discipline (roadmap FB#6).

### Agent Teams (roster + task board + mailbox)

A collaboration layer above the subagent primitive (roadmap D#15): a pure-file
team workspace under `.aih/team/`; `aih team` manages the roster, task board and
per-agent mailboxes:

```sh
aih team add-agent scout --role research --prompt "You are a careful researcher."
aih team add-task "write the report" --detail "draft v1"
aih team claim <task> --as scout
aih team dispatch <task> --as scout   # run one synchronous agent turn, result mirrored back to the board
aih team done <task> --note "shipped"
aih team mail builder "report ready" --sender scout
aih team inbox builder [--unread]
aih team list                         # roster + task board + inbox counts
```

Task ids support unique-prefix resolution; `dispatch` reuses D#13's `spawnJob`
(job board `.aih/jobs.json` records running state) and writes done/failed +
preview back to the board after completion; use TUI `/bg` for background
parallelism (long-running processes hold the child-process handle).

### Builtin Skills

Skills are reusable instruction packs (YAML frontmatter + body) that make the
agent "domain-savvy on arrival":

```sh
npm run cli -- skills list                        # list: project > user > builtin three tiers
npm run cli -- skills find tour                   # keyword search (name-hit weighted)
npm run cli -- skills install app-tour            # materialize builtin skill into .aih/skills/
npm run cli -- skills show app-tour               # view the body
```

Builtin:

| Skill | Description |
|---|---|
| `app-tour` | Explore the connected app's tools and produce a capability tour |
| `batch-ops` | plan-execute-verify pattern for bulk data operations |
| `session-report` | turn the current session history into a structured report |

Same name → project overrides user overrides builtin; in sessions and `run`, the
skill roster is injected into the system prompt and the model calls `load_skill`
on demand to load full text; TUI `/skills` lists, `/<skill-name>` injects
directly.

**Skill-relevance auto-loading** (roadmap P1#4, `cli/src/bm25.ts`): before each
turn, BM25 ranks installed skills by relevance (CJK tokenized by character
bigrams); hit skills inject a "suggested load" hint into this turn's context, and
the model can `load_skill` directly; `aih skills suggest <query>` shows the same
ranking offline. Also: `SKILL.md` front matter supports `secretPatterns` (see
"Security & debugging").

### Background Tasks (`/bg`) & the Sandbox Seam

- **Background tasks** (roadmap D#13): TUI `/bg <prompt>` spawns one agent turn
  as a background subprocess (`aih run --session bg-<id>`), keeping the TUI
  responsive; the status bar shows running/done/failed counts live, and the final
  answer is echoed back as a system message on completion; `/bg list` /
  `/bg cancel <id>` manage; the job board lands in `.aih/jobs.json`, surviving
  TUI restarts. Pure-CLI subcommands like `distill` / `tidy` can also be
  dispatched as background jobs.
- **Sandbox seam** (roadmap D#12): `run_cmd`'s execution backend is replaceable
  — `local` (default) / `bwrap` / `remote` (the `SandboxBackend` interface in
  `cli/src/sandbox.ts`, chosen via `AIH_SANDBOX` or the tool's `sandbox`
  parameter); interface first, default local.

### Permission Model (allow / ask / deny)

| Tier | Default object | Behavior |
|---|---|---|
| `allow` | read operations | execute directly |
| `ask` | write operations | human/policy confirmation via `ApprovalGate` |
| `deny` | business red lines | registry rejects directly |

Implement the `ApprovalGate` policy to plug in your own approval system
(`PolicyGate` provides a rule-engine prototype). TUI inline confirmation:
`⚠ approval requested: <tool> <args>` → `[y] once · [n] no · [a] always <scope>`;
`scope` is auto-derived from the target path's parent dir; `a` persists to
aih.json with last-match-wins (project > global).

**Read-only bash guardrail + guarded write tools (KL-R#4, defense-in-depth not a
sandbox)**:
- **Read-only auto-allow**: under `autoAllowReadonly`, `run_cmd` classifies via
  `isReadonlyCommand` prefix whitelist (`ls`/`git status`/`grep`…) — whitelist hit
  executes without confirmation; non-readonly commands fall back to human
  confirmation.
- **Defensive blacklist** (`hasDefensiveVeto`, vetoes **before** the readonly
  check): even a command starting with a readonly prefix is vetoed for readonly
  classification (falls back to human confirmation) if it contains
  `;`/`&&`/`||`/`|`/`>`/`<`/`&`/backtick/`$(`/`${`/`sudo`/`env`/`eval`/`exec`/
  `source`/`--pre`/`-exec`/`-delete`/`--pager`/`sh -c`/`bash -c`/`rm`/`mv`/`cp`/
  `chmod`/`curl`/`wget`/`nc` etc. injection/execution/dangerous substrings —
  blocking `ls; rm -rf`, `grep … | sh`, `rg --pre '…'`, `man -P '…'`-style
  arbitrary-command injection through a readonly shell.
- **Guarded write-tool floor** (`GUARDED_WRITE_TOOLS`): for author-marked
  human-guarded write tools (`run_cmd`/`write_file`/`edit`/`apply_patch`/
  `append_text`/`patch`/`permissions`/`toggle_todo`/`remove_todo`/`add_todo`),
  their `allow` rules are **lowered to `ask`** in `RulesetGate` (`deny` still
  wins) — configuration (including allow-everything or machine-written config)
  **can never auto-allow them**; human confirmation is a floor that config cannot
  bypass. Readonly calls unaffected.

**Execution policy (AC#3, session-level command-category hard floor)**:
- Bitmask categories: `NO_BUILD` (build/compile: `npm run build`, `tsc`, `cargo build`,
  `make`…), `NO_TEST` (test/verify: `npm test`, `jest`, `pytest`, `cargo test`…),
  `NO_SHELL` (direct script execution: `bash x.sh`, `pwsh x.ps1`, `python x.py`…).
- Deterministic classifier (prefix + token scan, same style as the readonly
  whitelist) — **fail-open**: only positively-identified commands are blocked;
  the approval gate remains the real boundary.
- Checked **before** the ruleset in `SessionGate.request()`: an explicit
  `allow` rule cannot override it (session-level hard restriction, same
  semantics as plan mode hiding write tools). Only `run_cmd` is classified.
- Configuration (later wins): `aih.json` `executionPolicy` (number or
  `"build,test"` string) < `AIH_EXEC_POLICY` env var < CLI flags
  `--no-build` / `--no-test` / `--no-shell` (each sets one bit; OR-combined).

### Trust Model (OC#4 — local single operator, not a multi-tenant security boundary)

AIH's threat model is **local single operator**:

- **Trust boundary = the host OS user**. Anyone who can operate the agent can
  make it do anything the agent can do. Session ownership/visibility is a
  **usability feature, not a security boundary** — don't treat it as isolation.
- **Prompt-injection-only chains are not security bugs**: a path relying solely
  on "the model being induced" that does **not** cross any hard boundary below is
  outside the threat model. Hard boundaries = `allow/ask/deny` permission gates
  (`ApprovalGate`), credential redaction + owner isolation
  (`redactCredential` / degrade-not-fallback), the sandbox seam (default local,
  switchable bwrap/remote), the tool registry's `deny` red lines. Crossing any of
  these is a security event.
- **When you need real isolation**: build a new trust boundary with an
  independent agent / independent host (separate OS user or container) — don't
  rely on prompt or session isolation.
- **Adversary model**: the default adversaries are "same-host users" and
  "untrusted external content (web pages/tool output)"; external content can only
  influence model intent, it cannot directly touch deny red lines or credentials
  — unless it induces the model to proactively call an allow/ask-granted tool,
  which is the user's decision about permission configuration.

### TUI (interactive terminal)

opencode / MiMo-Code style full-screen TUI:

- **Light Markdown rendering**: headings→bold, code blocks→dark + **syntax
  highlighting** (keywords/strings/numbers/comments color-coded), quotes→dark,
  lists→`•`/numbers, inline code→cyan, inline links two-tone underlined,
  tables `|`→`·`; tool-call icons inline (`$` bash / `→` read / `✱` search /
  `%` web / `←` write / `#` todo / `⚙` other); same-class tools auto-group
  collapsed (`$ bash ×3 · enter to expand`); `run_cmd` etc. first-three-line
  preview (`… N more · enter to expand`)
- **Permission confirmation (folder-level memory)**: submissions while busy
  auto-queue (`queued: …`)
- **Multiline input box**: wraps by display width (CJK wide-char aware, cursor
  precisely positioned), in-box scrolling; `/` triggers Tab ghost completion;
  spinner + elapsed seconds while busy
- **Bottom**: heavy border (scroll indicator `↑N`) + hint line (cwd · shortcuts ·
  right-side context usage `used/limit (pct%)`) + status line (`⊙ N MCP` badge ·
  app · version · session name)
- **Interaction**: mouse wheel / PgUp/PgDn scroll; up/down arrows walk input
  history; `Enter` on an empty box or `o` expands/collapses the selected tool
  block (**legacy Windows conhost has no mouse events — this is the only expand
  path**; regular terminals also support mouse click); `exit` (or `/quit`,
  `ctrl-c` clears input then exits) restores the terminal; `ctrl-c` while busy
  cancels the current turn without exiting
- **Windows display**: `aih.cmd` launcher from `install.ps1` auto-runs
  `chcp 65001` (UTF-8), so legacy conhost box-drawing/block chars don't garble;
  the context progress bar uses ASCII `#`/`-` (block chars render double-width
  wrong under GBK), the rest of the sidebar uses text lines (`Nk / Mk · X%`)
- Slash commands: `/mode` `/goal` `/tools` `/model <id>` (hot switch) `/usage`
  `/compact [focus]` `/clear` `/inject <text>` `/events` `/skills` `/vivid`
  `/bg <prompt>` `/find <text>` `/shell [--send]` `/fix [--show]`
  `/<skill-name>`
- **`/find <text>`**: line-by-line search across all tool outputs (incl. expanded
  content within the 32KB inline cap); hit tools auto-expand and scroll to the
  first hit, listing the 12 most recent hits (`tool · line · snippet`); full
  outputs beyond the cap are captured with `run_cmd keep_output=true` to
  `.aih/outputs/*.log`
- **`/shell [--send]`** (IT#1 shell context awareness): shows this session's
  recent `run_cmd` context (command · exit code · cwd · output tail, full-output
  file path when `keep_output`); `--send` injects the context block into the next
  turn. Agent-side `shell_context` tool can also pull it on demand
  (`max_commands`/`max_output_chars` adjustable), or set `AIH_SHELL_CONTEXT=auto`
  to attach it at the start of every normal message turn — no more manual
  pasting of shell errors/output
- **`/fix [--show]`** (IT#2 deterministic error-detection): detects this
  session's failed `run_cmd`s (non-zero exit / timeout), shows a summary
  (command · exit code · classification), assembles a fix-request block sent to
  the agent; `--show`/`--dry` show only, don't send. The status bar lights red
  `⚠ N failed` after a failure (hidden when all green; `AIH_ERROR_DETECT=0`
  disables auto-indication)
- **`/vivid` minimal rendering**: toggle plain mode — strips chrome (borders/
  background/sidebar/status hints), leaves only the body (good for low-bandwidth/
  remote/log replay); toggle again to restore the full theme
- Session titles: after the first turn, an LLM auto-generates a 2–6 word title
  (`<name>.jsonl.meta.json`), shown in the status bar and `session list`

### General/Programming Capabilities (local toolset, aligned with opencode built-ins)

AIH's agent kernel is generic — tools come from the connected app; the
interactive terminal additionally mounts a local toolset by default (coexisting
with any MCP app tools; same-name → app tool wins):

| Tool | Description | Permission |
|---|---|---|
| `list_dir` / `read_file` | list dir / read file (dual budget 3000 lines/50KB + 512 chars/line; full/head/tail/middle four-state truncation, middle keeps head+tail + `… N lines elided …` marker, giant lines keep only a byte window without materializing the whole string; line offset) | allow |
| `write_file` / `run_cmd` | write file / run command (default 120s timeout, `timeout_ms` up to 600s; background child processes don't block the return) | ask |
| `edit` | exact string-replacement edit (errors on ambiguity, `replace_all` for all) | ask |
| `glob` | `**/*.ts` patterns find files (`/`-less patterns match at any depth) | allow |
| `grep` | regex content search + `include` filename filter | allow |
| `todo` | task list (`.aih/todos.json`, at most one in_progress) | allow |
| `remember` | project memory: append/rewrite `.aih/memory.md`, cross-session persistent knowledge | allow |
| `memory_recall` | retrieve project+user memory: free-text query → token-overlap scoring returns the most relevant entries (zero deps; fallback recall when the injected block is budget-truncated) | allow |
| `question` | the model asks the user a question and waits (TUI inline Q&A line) | allow |
| `webfetch` | fetch URL → plain text (HTML→text, 64KB cap). Browser-grade UA + Accept headers, one bounded network retry, Cloudflare 403 challenge auto-retries with an honest UA, `timeout` param (seconds, default 30, cap 120), content-length precheck before download, actionable failure messages (suggests alternate endpoint/websearch) | allow |
| `websearch` | DuckDuckGo search (titles/URLs/snippets, key-free) | allow |
| `task` | dispatch subagent (independent context, ≤8 steps, no further nesting) | allow* |
| `apply_patch` | multi-file patch (Add/Update/Delete/Move, opencode format) | ask |

In plan mode all `ask` write tools auto-hide. The only opencode capabilities not
aligned are `lsp` (language-server infra) and experimental `execute` (code-mode)
— the former belongs in the MCP plugin domain, the latter is covered by run_cmd +
the roadmap sandbox seam. Beyond the toolset, opencode's `rules`
(AGENTS.md/CLAUDE.md/instructions), `policies` (provider.use) and `keybinds`
(tui.json) are all aligned — see the Configuration section.

### Security & Debugging

- **Shell environment policy** (borrowed from Codex CLI's
  `shell_environment_policy`): `run_cmd` child processes **no longer inherit the
  host's full environment** — variables whose names contain sensitive words like
  `KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL`, plus `AIH_*API*` credentials,
  are stripped; benign variables (`PATH / HOME / TERM`) kept. Commands the agent
  runs can't get your API key / database password, preventing secret leakage via
  child processes or `env` printing. Implementation: `cli/src/env-policy.ts`
  (`buildChildEnv`).
- **`--debug-prompt`**: before every LLM call, prints the **full messages the
  model actually sees** (system prompt + history + this turn's input) to stderr,
  for debugging prompt assembly, skill injection, memory blocks, goal guards.
  Corresponds to Codex's `codex debug prompt-input`; kernel-side provided by the
  `AgentLoop.onPromptInput` hook (`core/src/agent-loop.ts`).
- **Skill-roster context budget**: the `## Skills` roster in the system prompt is
  budget-constrained (2% of the window when known, 8000-char cap when unknown).
  Over-limit → truncate each skill's description first, drop trailing skills with
  a hint if still over — more skills don't crowd out body context.
- **Tool-result redaction + timing hooks** (roadmap D#11): a default-on built-in
  hook replaces common credential shapes (`sk-…` / `ghp_…` / `AKIA…` / `xox…` /
  `api_key=…` etc.) with `[REDACTED]` plus a `redacted: N` count and `duration_ms`
  timing before tool results enter the LLM / session log / audit; `--no-redact`
  disables. Skills can declare extra secret shapes with `secretPatterns`
  (semicolon-separated regex sources) in `SKILL.md` front matter; invalid regexes
  are skipped automatically; the built-in table always applies. Implementation:
  `cli/src/hooks.ts`.
## Architecture

```
L3 skill layer   skills/aih-app-integration   on-demand domain knowledge, self-evolving via skill-creator
L2 procedure     APP.md · harness.yml · scripts · tasks · docs/decisions.md
L1 kernel        core/   SessionLog · ToolRegistry(guarded pipeline) · AgentLoop(turn/step) · Seams(LLM/permissions)
L0 integration   mcp-server/   AppAdapter: Context(read) / Action(write, with permissions) / Event(stream)
cross-cutting    allow/ask/deny permissions · audit log · eval handoff gate
```

## Configuration

Precedence: **flag > environment variable > project `aih.json`/`.aih/config.json` > global user config**.

Global user config follows the **XDG data-directory spec** (`cli/src/paths.ts`):
`AIH_HOME` > `$XDG_DATA_HOME/aih` > `~/.local/share/aih`; the legacy `~/.aih`
directory is **still readable** when XDG does not exist (smooth migration, existing
config is never lost).

```json
{
  "$schema": "https://aih.dev/schema/aih.schema.json",
  "defaultProvider": "zen",
  "providers": {
    "zen": {
      "baseUrl": "https://opencode.ai/zen/go/v1/chat/completions",
      "model": "deepseek-v4-flash",
      "models": ["deepseek-v4-flash-free", "hy3-free"],
      "apiKeyEnv": "ZEN_KEY"
    }
  }
}
```

`aih config` prints the effective config and the source of each field; `aih models`
lists every provider.

**Editor completion (`$schema` injection)**: adding
`"$schema": "https://aih.dev/schema/aih.schema.json"` at the top of `aih.json` /
`config.json` gives field autocompletion and validation; `aih config --schema`
prints the JSON Schema directly (local file `cli/schema/aih.schema.json`).

**One provider, multiple models**: `model` is the primary model, `models[]` lists
extra switchable models under the same endpoint (sharing that provider's `baseUrl` /
`headers` / `apiKeyEnv`). Each model gets its own row in `aih models` and the TUI's
`ctrl-p` model picker — hot-switch with `/model <provider>/<model>` or by selecting
directly. Great for hanging free-tier / multi-tier models off one endpoint.

### Rules (`AGENTS.md` / `CLAUDE.md` / `instructions` — opencode `rules` parity)

AIH reads and injects project/global rule files as **mandatory instructions**
(aligning with opencode's `rules` mechanism; previously only the APP.md app contract
was read). Load order (first hit wins within each class):

1. **Project rules** — walk up from `cwd` looking for `AGENTS.md` (fallback `CLAUDE.md`);
2. **Global rules** — `~/.claude/CLAUDE.md` (Claude Code compatible;
   `AIH_DISABLE_CLAUDE_CODE=1` disables, `AIH_DISABLE_CLAUDE_CODE_PROMPT=1` disables only this file);
3. **Config `instructions`** — the `instructions` array of any trusted config layer
   (paths / globs / remote URLs).

```json
{
  "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]
}
```

Rule content is merged into the `# Project rules` section of the system prompt
(6000-char budget each), marked `mandatory`, and overrides default behavior. Claude
Code compatibility can be turned off via the `AIH_DISABLE_CLAUDE_CODE` env family.

### Policies (`policies` — opencode `policies` parity)

`policies` controls **which configured LLM providers are usable**, orthogonal to
`permissions` (which governs tools) — a denied provider is not selectable or
usable even with credentials configured. Resources support `*` / `?` wildcards;
**the last matching statement wins** (so put broad rules first, special cases
after); global policies take precedence over project policies (a repo cannot
re-enable a provider you denied globally); no match → allow by default.

```json
{
  "policies": [
    { "effect": "deny", "action": "provider.use", "resource": "*" },
    { "effect": "allow", "action": "provider.use", "resource": "opencode" }
  ]
}
```

The config above allows only the `opencode` provider; everything else is unusable.

### Keybinds (`tui.json` — opencode `keybinds` parity)

Core operation keybindings can be rebound via `tui.json` (cwd project-level +
`~/.aih/tui.json` global; global overrides project). Supports `ctrl+<letter>`,
`tab`, single printable characters, `none` (disable). Mappings that conflict with
built-in reserved keys (Enter/Ctrl+C etc.) are dropped with a warning.

```json
{
  "keybinds": {
    "palette": "ctrl+x",
    "toggleMode": "none",
    "help": "?"
  }
}
```

Defaults: `palette=ctrl+p`, `help=?`; `toggleMode` has no dedicated key by default
(Tab already drives both completion and build/plan switching). `Alt+…`/function
keys are escape sequences, outside single-byte rebinding scope.

### Credential-owner isolation (OC#7 — OpenClaw "secrets have owners")

When one credential fails, **only its owner degrades** — never silently fall back
to another credential. An AIH owner is a configured LLM provider (`empero` /
`llamacpp` / `zhipu` / `opencode` …). Semantics:

- **Isolated degradation** — on credential-class failure (401/403 auth, or quota
  exhaustion), that owner is marked unavailable, with a **redacted** reason recorded
  in the user-level `owner.json`; the original error still propagates (no automatic
  switch to another credential). The next **successful call clears** the degradation.
- **Hard failure blocks startup** — missing required API key, unknown provider,
  or a policy-denied provider all throw at parse time (fail-closed), no degraded
  pretending.
- **Reporting** — `aih models` marks degraded providers with `⚠ degraded` and prints
  a `degraded owners` report (with redacted reasons) at the end; `aih stats` prints
  the same report. `aih models --clear-degraded` resets the degraded registry.

```text
$ aih models
provider               model                       base-url
...
opencode ⚠ degraded    gpt-5.1-codex              https://opencode.ai

degraded owners:
  - opencode [credential] x2 @ 2026-08-31T…: llm request failed: HTTP 401 [redacted]
  (clear with: aih models --clear-degraded)
```

Choosing another (non-degraded) owner is still an **explicit user decision** — not
automatic fallback; `/model`, `--provider` switching to another usable provider
works normally. Implementation: `cli/src/owner-state.ts` +
`core/src/seams/llm-openai.ts` (`onCredentialFailure` / `onOwnerSuccess` hooks).

### Multiple MCP servers (`mcpServers`)

Besides `-s/--server` for a single MCP server, the config can declare **multiple**
MCP servers — AIH connects to all in parallel and aggregates their tools;
same-named tools are renamed `<server>_<tool>` to disambiguate:

```json
{
  "mcpServers": {
    "todos": {
      "command": "node",
      "args": ["/abs/path/aih/mcp-server/dist/index.js"],
      "enabled": true
    },
    "search": {
      "command": "npx",
      "args": ["-y", "@some/search-mcp"],
      "name": "web-index"
    }
  }
}
```

- `command` required, `args` optional, `enabled: false` temporarily disables a server.
- Connection precedence: `-s/--server` (single) > `mcpServers` (multiple) > built-in todo-app.
- Same-named tools from different servers get a server prefix (e.g. two servers both
  exporting `ping` → `todos_ping` and `search_ping`), and the tool comment marks the
  source (`(from <server>)`); tools under a single server keep their names.
- `aih tools` lists aggregated tools of all connected servers; `aih config` prints
  the `servers` array and `serverSource` (`flag` / `mcpServers` / `bundled`).

### Environment variables

| Variable | Purpose |
|---|---|
| `AIH_MODEL` / `AIH_BASE_URL` / `AIH_API_KEY` | model, endpoint, key (any OpenAI-compatible API) |
| `AIH_HOME` | global user config/data directory (highest priority, overrides XDG default) |
| `XDG_DATA_HOME` | XDG data base dir (global config lands in `$XDG_DATA_HOME/aih`) |
| `AIH_RETRIES` (1) | automatic retry count for LLM 429/5xx (auth errors not retried) |
| `AIH_FIRST_TOKEN_TIMEOUT_MS` (180000) | streaming first-token timeout (0 disables); timeout with partial content triggers **stall-resume** (keeps partial text + one bounded re-run), no content counts into retry budget |
| `AIH_STALL_TIMEOUT_MS` (60000) | streaming inter-frame stall timeout (0 disables); same semantics |
| `AIH_QUOTA_AUTO_RESUME` (1) | on quota exhaustion (429/402 + quota/limit/credits or Retry-After ≥ 60s) interactive sessions auto-wait for reset then **re-send the rejected call** (bounded 2×, TUI shows a waiting line); `0` disables. Non-interactive `run` always fails fast. **Spend-limit/billing terminal quotas are not waited on** — fail immediately (CC-R#2) |
| `NO_COLOR` | disable colored output |
| `AIH_CONTEXT_WINDOW` (default 131072) / `AIH_COMPACT_AT` (0.8) | context window & compaction threshold (window precedence: `--context-window` > env > llama.cpp `/slots` live probe > aih.json `models[<id>].contextWindow` > `providers.<name>.contextWindow` / `contextWindow`) |
| `AIH_GOAL_ROUNDS` (3) | max extra resume rounds for `/goal` and `run --goal` |
| `AIH_MEMORY_BUDGET` (4000) | per-turn memory.md injection char budget |
| `AIH_CMD_TIMEOUT_MS` (120000) | run_cmd default timeout |
| `AIH_TOOL_CONCURRENCY` (4) | concurrency cap for consecutive read-only tool calls in one step (writes stay serial) |
| `AIH_FORMAT_TIMEOUT_MS` (15000) | post-write auto-format timeout (failure never blocks the write) |
| `AIH_FETCH_TIMEOUT_MS` (30000) | webfetch default timeout (tool `timeout` param wins; hard cap 120000) |
| `AIH_MOCK_AUX_TEXT` | mock-mode reply text for tool-less auxiliary calls (goal judge / branch distillation; test hook) |
| `AIH_SECOND_JUDGE_MODEL` | model id for the `best_of_n` second judge (FB#2 dual-judge panel; reuses the primary provider's base-url/api-key; default → single judge) |
| `AIH_BUDGET` | PE#2 hard budget constraint: JSON or `maxCostUsd=1\|maxWrites=5\|timeoutMs=60000\|denyPaths=a\|b` (overrun → escalate, exit code 3) |
| `AIH_SENSORS` | PE#1 computational sensors: SensorConfig JSON array or single object (post-write verification commands, red → bounded retry → escalate) |
| `AIH_SENSOR_RETRIES` (1) | PE#1 retries before a red sensor escalates |
| `AIH_SENSOR_TIMEOUT_MS` (60000) | PE#1 per-sensor command timeout |
| `AIH_GUARDIAN` (1) | MEA write-action Guardian: ask-level writes are first assessed by an independent tool-less LLM against a declarative policy (`0` and `--no-guardian` disable, falling back to pure human confirmation) |
| `AIH_GUARDIAN_FAIL_CLOSED` | Guardian review timeout/parse failure/LLM error → fail-closed deny (unset → safe degradation to human confirmation) |
| `AIH_GUARDIAN_POLICY` | declarative policy.md text for the Guardian (default built-in policy, incl. "routine workspace writes = low-risk → allow-leaning") |
| `AIH_GUARDIAN_TRUST` (0) | trust mode: Guardian's allow passes at **any** risk level (medium no longer falls back to human); deny still blocks |

### Session titles (hidden system agent)

After the first turn ends, one lightweight LLM call generates a 2–6 word title:
written to `<name>.jsonl.meta.json`, shown in the TUI status bar `S:` slot and the
`session list` title column; an existing title is reused.

### Scaffolding & standalone services

```sh
npm run cli -- init my-app            # generate full scaffold: APP.md/AGENTS.md/CLAUDE.md/harness.yml/scripts/mcp-server
npm run cli -- mcp                    # run the built-in todo-app MCP server as a standalone process
```

### Token usage stats

Each LLM response's usage is accumulated into the `turn/end` event and persisted
with the session:

```sh
npm run cli -- run "..."          # text-mode footer: [turn xxx, 2 step(s), end_turn, tokens 512/89/601]
npm run cli -- run "..." -f json  # JSON mode: turn/end event carries the usage field
```

### Performance benchmark

```sh
AIH_API_KEY=sk-... npm run bench   # compare with opencode (needs local install + opencode.json in cwd)
```

Measured (deepseek-v4-flash @ OpenCode Go, mean of 3 rounds each): single-turn
conversation AIH ~2.4s vs opencode ~7.4s; tool task ~5.9s vs ~11.2s; correctness
14/14 for both. Details in `.aih/bench.tsv`.

---

## Development

```sh
npm run build       # tsc -b builds the three workspaces
npm test            # smoke tests: node core/dist/smoke.js && mcp-server && cli
npm run eval        # full handoff gate (doctor + bootstrap + check + test)
```

## Connect AIH to Your App

### Option 1: MCP (zero-invasion, recommended start)

After building, register `mcp-server/dist/index.js` as an MCP server. With opencode
for example, see `examples/opencode.json`:

```json
{
  "mcp": {
    "aih": { "type": "local", "command": ["node", "/abs/path/aih/mcp-server/dist/index.js"] }
  }
}
```

Any opencode session can then call `app_describe` / `app_context` / `add_todo` etc.
to operate the app. codex, claude code and other MCP-capable agents work the same way.

### Option 2: CLI (opencode-style run/chat)

`run` supports piped input (like opencode): `echo "extra note" | aih run "handle this"`.
Text mode streams by default (token-by-token rendering, `--no-stream` disables); tool
calls are shown inline on stderr as `⚙ name {args}`, keeping stdout clean and
redirectable. Write operations require confirmation by default: `[y/N]` prompt on TTY;
non-TTY must pass explicit `--yes`. Color auto-disables (non-TTY or `NO_COLOR` set).

### Option 3: Embedded Copilot (SDK mode)

Reuse the L1 kernel directly:

```ts
import { AgentLoop, SessionLog, ToolRegistry, AutoApprove } from "@aih/core";

const tools = new ToolRegistry(new AutoApprove());
tools.register(myAppTool);          // your app's actions
const loop = new AgentLoop({ llm: myLLMAdapter, tools, systemPrompt: "..." });
await loop.send("export last week's orders");
```

`llm` only needs to implement the `LLMAdapter` interface (OpenAI-compatible /
DeepSeek / local models all work).

## Integrate Your Own App

1. Create your Adapter next to `mcp-server/src/app-adapter.ts` (implement `AppAdapter`:
   `descriptor` + `context(query)` + `actions`, action params defined with zod).
2. Replace `TodoAppAdapter` in `mcp-server/src/index.ts`.
3. Update `APP.md` section 4 (the primitive list) in sync.
4. Extend `mcp-server/src/smoke.ts` to cover one read + one write of the new adapter.
5. Run `npm run eval` to pass the handoff gate.

Full procedure in the skill file `skills/aih-app-integration/SKILL.md`
(installable for any agent with `npx skills add <this repo>`).

## Comparison: deepseek-harness / opencode / MiMo-Code / Harness-for-codex

AIH positions differently from the four mainstream open-source projects, each with
its own focus. The table below compares features and relevance from a user's perspective:

| Dimension | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [opencode](https://github.com/anomalyco/opencode) | [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) | [Harness-for-codex](https://github.com/ganimjeong/Harness-for-codex) | AIH (this repo) |
|---|---|---|---|---|---|
| Positioning | Agent runtime framework ("everything is a plugin") | General AI coding agent (terminal-native) | opencode's enterprise fork (interaction/safety enhancements) | Project-level AI collaboration scaffold (template repo) | App-Intelligence Harness |
| Serves | devs building their own agent systems | devs writing code | coding teams needing enterprise guardrails | teams wanting AI collaboration conventions for one repo | connecting **any business app** (Web/desktop/backend) to AI |
| Core abstraction | plugin (Cordis-based) | build/plan dual agent + built-in tools + MCP | agent guardrails/interaction polish on opencode | AGENTS.md + harness.yml + scripts/tasks/docs | L0 AppAdapter (Context/Action/Event) + four-layer kernel (L1 kernel/L2 procedures/L3 skills) + built-in general toolset |
| Run form | Web UI (`npx @deepseek-ai/dsh web`, default 127.0.0.1:3080) | TUI / CLI / desktop app | TUI / CLI (fork of opencode) | repo template (used with codex/claude) | TUI / CLI / SDK, plus MCP server for plugging into apps |
| Relationship to MCP | plugin ecosystem (incl. MCP capability) | consumes external tools as MCP client | same as opencode (MCP client) | none (AGENTS.md conventions for codex) | is itself an MCP server, consumable by opencode / codex / claude code etc. |
| Permission model | plugin-level permission declaration | per-agent (build/plan) tiers + rule approval (incl. doom_loop behavioral guard) | same as opencode (fork inheritance), enterprise-hardened | `verification.default/handoff` gates | tool-level allow/ask/deny + pluggable ApprovalGate |
| Connecting business apps | write a plugin | write an MCP server / tools | write an MCP server / tools | write AGENTS.md / harness.yml | built-in general coding toolset (default on: read/write/edit/glob/grep/run_cmd/apply_patch/search/subagents; `--no-dev` off) + implement AppAdapter to connect business apps |
| Sessions & audit | Session Log ("model-visible = replayable") | session persistence + LSP context | same as opencode + enterprise audit | decision log docs/decisions.md | append-only JSONL SessionEvent + tool audit |
| License | MIT | MIT | MIT (opencode fork) | MIT | MIT |

**Feature matrix** (four-repo cross-check 2026-08-22; ✅ complete / ◐ partial or
planned / — none):

| Capability | dsh | opencode | MiMo | HfC | **AIH** |
|---|---|---|---|---|---|
| MCP bidirectional (server+client) | ◐ inside plugin | ◐ client | ◐ client | — | ✅ **server+client** |
| Zero-code app integration (AppAdapter) | — | — | — | — | ✅ **unique** |
| append-only session replay/fork | ✅ | ✅ | ✅ | — | ✅ |
| Permission rule set (pattern/path scope/last-match) | ◐ sandbox view | ✅ | ✅ | — | ✅ |
| doom_loop dead-loop guard | ◐ hook interception | ✅ | ✅ | — | ✅ |
| Context compaction (proactive+passive+manual /compact) | — | ✅ | ✅ | — | ✅ all three + manual |
| Stream stall protection + honest resume (stall watchdog) | — | ◐ | ◐ | — | ✅ CC#49 (first-token/inter-frame timeout, partial kept + bounded resume) |
| Quota-exhaustion auto-wait + resend rejected call | — | ◐ | ◐ | — | ✅ CC#51 (quota/limit/credits or Retry-After≥60s, interactive auto-resume, run fails fast) + CC-R#2 (spend-limit/billing **terminal** quotas fail immediately; goal chain auto-clears on unrecoverable errors, `isUnrecoverableTurnError`: auth/terminal quota/escape overflow/policy) |
| Structured checkpoint rollback | — | ◐ snapshot | ◐ | — | ✅ `/checkpoint`+`/restore` (F#28, append-only) |
| Project memory (memory.md + injection budget + token-overlap recall) | — | — | ✅ | — | ✅ (KL-R#2 `memory_recall`) |
| Goal judge auto-resume | ✅ goals | — | ✅ | — | ✅ |
| Subagents / multi-agent | ✅ teams | ✅ subagent | ✅ | — | ✅ serial `task` + **parallel `best_of_n`** (Max Mode, P2#9) + **Agent Teams** (D#15) |
| Parallel tool calls (read-class bounded concurrency) | ✅ ≤10 | ◐ | ◐ | — | ✅ F#29 (writes always serial) |
| Skill layer (SKILL.md three-tier loading) | — | ✅ | ✅ | — | ✅ |
| plan/build dual mode | — | ✅ | ✅ | — | ✅ |
| TUI: streaming/markdown/sidebar/mouse | ◐ Web | ✅ | ✅ | — | ✅ |
| Cost / TPS live display | — | ◐ | ✅ | — | ✅ panel + /usage + stats (F#30, session-average TPS) |
| Session self-evolution (dream/distill mining memory+flows) | — | — | ◐ MEMORY | — | ✅ `/dream`+`/distill` (P2#7, suggest-only, never auto-writes) |
| Deterministic workflow (phase scripts) | — | — | ✅ | — | ✅ `.aih/workflows/*.mjs` |
| Post-write auto-formatting (formatter integration) | — | ✅ | — | ◐ pre-commit | ✅ prettier>biome>eslint |
| Session titles/audit trail/tool hooks | ✅ | ✅ | ✅ | ✅ decisions | ✅ audit + **redaction/timing + skill-driven `secretPatterns`** (D#11) |
| Tool-output search / full capture-to-disk | — | ◐ | ◐ | — | ✅ `/find` + `run_cmd keep_output` (T#22) |
| Shell context awareness (agent pulls shell output/exit codes) | — | — | — | — | ✅ `/shell` + `shell_context` tool + `AIH_SHELL_CONTEXT=auto` (IT#1) |
| Deterministic shell failure detect + one-click fix (status-bar red badge + `/fix`) | — | — | — | — | ✅ `error-detect.ts` + status-bar `⚠ N failed` + `/fix` (IT#2) |
| Cross-agent instruction contract (AGENTS.md) | — | ◐ | ◐ | ✅ | ✅ |
| curl\|bash one-line install | ✅ | ◐ | ✅ | — | ✅ |
| CI gate / repo hygiene (CHANGELOG, devcontainer) | ✅ | ◐ | ✅ | ✅ | ✅ ci.yml + CHANGELOG.md + .devcontainer |
| serve/attach multi-frontend | ✅ Web | ✅ | ✅ | — | ✅ **HTTP/SSE** `serve`+`attach` (P2#8) |
| XDG data-directory spec | ✅ | ◐ | ◐ | — | ✅ `AIH_HOME`>XDG>default + `~/.aih` compat (P2#9) |
| Config `$schema` injection (editor completion) | — | ◐ | ◐ | — | ✅ `aih config --schema` + `aih.schema.json` (P2#9) |
| Minimal/no-chrome render mode | — | ◐ | — | — | ✅ `/vivid` plain mode (P2#9) |
| Project trust gate (anti cloned-repo poisoning) | — | ◐ trust | ◐ | — | ✅ `--trust`/trust.json (P#40, fail-closed) |
| Tool-result pruning + archive_read lazy retrieval | — | ✅ prune | ◐ | — | ✅ `.aih/archives` + placeholder projection (MK#43) |
| Crash recovery (T1 dispatch fact + park, no guessing) | — | ✅ Runtime Resume | ◐ | — | ✅ tool/dispatch + scanRecovery + PARK code (MK#44/45) |
| Safety seam (budget hard bound + sensors + escalate primitive) | — | ◐ | — | — | ✅ PE#1 sensors + PE#2 budget/tripwire + PE#4 escalate (exit code 3, `test/recovery.sh`) |
| Workspace identity UUID / coverage-verified compaction digest | — | ✅ | — | — | ✅ `.aih/workspace.json` + coverage digest (MK#47/#42) |
| Extension API (code-level plugins) | — | ◐ | ✅ Pi | — | ✅ `.aih/extensions/*.mjs` registerTool/Command/on (P#39, trust-gated) + result-carrying events (before veto / after rewrite / turn:end) + `init` self-extension example |
| Steering mid-turn / follow-up queue + Alt+Up retrieval | — | ✅ | ◐→✅ | ✅ Pi | ✅ busy input auto-steers; follow-up auto-resumes; Alt+Up retrieves queued message for edit-and-resend (P#35) |
| Cache-hit observation (CH%) | — | ◐ | ◐ | — | ✅ `/usage` line + panel CH% (P#41, needs provider reporting) |
| Model metadata snapshot sync (models.dev) | — | ✅ refresh | — | — | ✅ fail-closed refresh script + 27-model snapshot (P#48) |
| Session tree / branch navigation + branch distillation | — | ◐→✅ | ✅ Pi | — | ✅ parentId chain + `/tree` view + `distill-branch` branch_summary (P#37) |
| Eval experiment framework (cells/budget/subject seam) | — | ◐ | — | ✅ Maka | ✅ runExperiment bounded concurrency + wall-clock/cost budgets + CLI/external-command/HTTP three subjects (P#46) |
| Deep code review (multi-dim fanout + verify loop) | ✅ code-review | ✅ | — | — | ✅ AC#1: 4-dim parallel review + finding dedup + independent verify KEEP/DROP + JSONL audit (`review-pipeline.ts`) |
| Lightweight LSP code graph (symbols/signatures/references) | ✅ built-in | ✅ | — | — | ✅ AC#2: `list_symbols` / `read_symbol` / `find_references` three read-only tools, on-demand tsserver/standard-LSP pooling, zero new deps, graceful degradation (`codeintel.ts`) |

**Relevance / borrowings** (all code-read; the absorption map is in
`docs/review-three-harnesses.md`, `docs/comparison-dsh.md`):

- **deepseek-harness** (agent runtime platform) → borrowed `Session Log` replay
  invariant, `sessions.fork`, `pre/post-execute` hooks (✅ D#11 redaction/timing +
  skill-driven), goals/continue direction, parallel read-only tools (bounded ≤N,
  ✅ F#29), background jobs (✅ D#13), Agent Teams (✅ D#15) — remaining: sandbox
  seam (✅ D#12 interface reserved, default local).
- **opencode** (terminal coding agent) → borrowed `build/plan`, **built-in general
  toolset** (→ AIH `--dev`/general-tools), pattern+path permissions, `doom_loop`,
  hidden system agent (compaction/title landed); TUI interaction (busy queue /
  markdown / Tab completion / scroll wheel) aligned; post-write formatter
  (prettier>biome>eslint, ✅ F#27); checkpoint rollback (✅ F#28 `/checkpoint`+`/restore`).
- **MiMo-Code** (opencode fork, interaction enhancements) → borrowed `/goal` judge
  auto-resume ✅, MEMORY.md memory ✅, sidebar Context/Todo panels ✅, skill layer ✅,
  curl|bash installer ✅, usage display ✅, deterministic workflow
  (`.aih/workflows/*.mjs` + `aih workflow run`, ✅ F#33). Remaining: cost/TPS ✅ F#30;
  side-by-side diff ✅ F#31 (two-color cells + line-number column + narrow-screen fallback).
- **LongHorizon-Harness** (AMAP-ML, long-horizon Loop Engineering) → borrowed
  Final-State Guard (completion-honesty rules) + Task Contract discipline +
  structured goal contract/extended verdict (`unmet` flows back into resume
  instructions), landed as single-model guards in the system prompt and `/goal`
  judge ✅ (`core/src/prompts.ts`); the MEA three-role judgment layer (independent
  Auditor + verified-state ledger) ✅ delivered (`cli/src/mea.ts`, merged with the
  codex Guardian — see the "MEA independent judgment layer" section).
- **OpenClaw** (openclaw/openclaw, multi-channel AI assistant gateway) → borrowed
  judgment-layer/engineering discipline only: **core per-call tax + repeat
  need→seam governance yardstick** (OC#2, core strict-entry / skills·extensions
  tax-free & encouraged / ≥2 independent wire-ins → extract seam ✅,
  `docs/decisions.md` + APP.md §6), repair doctrine (OC#1, root-cause-first /
  production LOC first-class / no consumer-only guards masking root causes ✅),
  **live-verify default + check-existing-first** (OC#3, exercise real production
  path before claiming user-visible behavior + brief existing-solution gate before
  custom work ✅, `core/src/prompts.ts` `LIVE_VERIFY_DISCIPLINE`), trust-model
  clarification (OC#4, local single-operator boundary + prompt-injection-only chains
  are not security bugs ✅, see "Trust model" after the permissions section +
  APP.md §3), credential-owner isolation (OC#7, degrade owner not fallback
  credential ✅, dedicated section), versioned state guard + config self-healing
  (OC#5, schemaVersion + refuse-to-open-newer + `aih doctor --fix` backs up legacy
  config then migrates to canonical form ✅), maturity scorecard / coverage-ID +
  evidence pattern (OC#6, `aih coverage` derives a stable coverage registry from
  smoke-group titles + mock/live evidence classes + profile-based subset,
  `npm run eval:quality` ✅); explicitly NOT borrowed: multi-channel gateway /
  companion app / ClawHub market / OTel telemetry / Crabbox cloud sandbox / pnpm
  monorepo (clashes with the "local single-operator" positioning).
- **Harness-for-codex** (project-level scaffold) → borrowed `AGENTS.md` single
  source of truth + `CLAUDE.md` bridge ✅, `harness.yml` schema ✅,
  `docs/decisions.md` trail ✅, two-tier `verification` gates (`scripts/eval`) ✅;
  **CI workflow = automating the handoff gate** (`.github/workflows/ci.yml`,
  push/PR runs check+test) ✅.
- **Apache Maka** (apache/maka, local-first agent workspace) → borrowed the
  **fact-layer discipline**: append-only events are the only source of truth, UI/
  model calls are mere projections. Landed: compaction coverage digest
  (✅ MK#42, digest must prove coverage or fail-open), tool/dispatch T1 facts +
  RecoveryResolver four-state classification + park stable codes (✅ MK#44/45),
  tool-result pruning + archive_read lazy archiving (✅ MK#43), workspace identity
  UUID (✅ MK#47), models.dev snapshot fail-closed sync (✅ P#48), steering/
  follow-up dual queues (✅ P#35); explicitly NOT borrowed: SQLite/Electron,
  Phase3/4 file-level reconcile, provider-native remote compaction.
- **openai/codex** (Codex CLI, Rust) → borrowed `shell_environment_policy`
  (subprocess env secret filtering, ✅ `cli/src/env-policy.ts`),
  `codex debug prompt-input` (✅ `--debug-prompt` / `AgentLoop.onPromptInput`),
  skill-roster 2% context budget (✅ `withSkillRoster`); candidate roadmap:
  declarative hooks (`hooks.json` + hash trust), memories directory, parallel
  subagents.
- **Intelligent Terminal** (terminal UX reference) → borrowed **shell context
  awareness** (agent pulls shell output/exit codes, ✅ IT#1: `/shell` +
  `shell_context` tool + `AIH_SHELL_CONTEXT=auto`) + **deterministic
  error-detect→one-click send-to-agent** (✅ IT#2: `error-detect.ts` + status-bar
  `⚠ N failed` + `/fix`) + **`?`-prefix quick task + context injection** (✅ IT#3:
  `question.ts` + TUI input-line recognition) + **multi-agent session panel**
  (✅ IT#4: `sessions.ts` + TUI `/sessions` dashboard/kill/view) + **run-or-copy
  command approval** (✅ IT#5: `clipboard.ts` + `askRunOrCopy`).
- **AtomCode** (atomgit.com/atomgit_atomcode/atomcode, Rust coding agent) →
  borrowed **deep code-review pipeline** (✅ AC#1: 4-dim parallel fanout +
  structured findings + dedup + independent verify loop + diff-derived impact plan
  + JSONL audit, see `docs/review-atomcode.md`) + **lightweight LSP code graph**
  (✅ AC#2: `list_symbols`/`read_symbol`/`find_references` on-demand language-service
  pool, zero-dep LSP+tsserver dual adapters, see `codeintel.ts`); remaining:
  execution-strategy bitmask (AC#3, not scheduled); explicitly NOT borrowed:
  WebUI/mobile remote access, anonymous telemetry, closed-source CodingPlan signing,
  Rust migration.

**Gap action list** (by cost-effectiveness, see `docs/roadmap.md` section F):
① CI gate workflow (HfC) ✅; ② post-write auto-formatting (opencode) ✅;
③ structured checkpoint rollback (opencode/P0#1) ✅ `/checkpoint`+`/restore` +
worktree summary; ④ parallel read-only tools (dsh ≤10) ✅; ⑤ cost/TPS panel (MiMo)
✅ panel + /usage + stats (streaming TPS remaining); ⑥ side-by-side diff (MiMo,
previously promised) ✅ two-color cells + line-number column + narrow-screen
fallback to unified; ⑦ repo hygiene: CHANGELOG/devcontainer (HfC) ✅;
⑧ deterministic workflow (MiMo, P1#6 pulled forward) ✅; ⑨ deep code review
fanout+verify (AtomCode) ✅ AC#1; ⑩ lightweight LSP code graph (AtomCode) ✅ AC#2.

One-line summary: **use opencode / MiMo-Code for coding** (AIH `--dev` also offers
the same kind of coding toolset), **deepseek-harness for building generic agent
systems**, **Harness-for-codex for conventions in one repo** — and AIH when you
want to **connect any business app to an agent** (TUI/CLI/SDK + MCP server, zero
code changes to your app).

## Directory Structure

```
aih/
├── APP.md                    # L2: agent behavior contract (single source of truth)
├── harness.yml               # L2: canonical commands + task-loop phases
├── CHANGELOG.md              # L2: release entries (Keep a Changelog)
├── .devcontainer/            # L2: stable in-container agent env (auto bootstrap+build after create)
├── scripts/{doctor,check,eval}  # L2: standard command entry points
├── tasks/TEMPLATE.md         # L2: task brief template
├── docs/decisions.md         # L2: cross-session decision log
├── core/                     # L1: kernel (zero runtime deps)
├── mcp-server/               # L0: MCP integration (incl. TodoApp sample adapter)
├── cli/                      # CLI: aih run/chat/tools/describe/workflow
├── skills/                   # L3: skills
├── .aih/workflows/           # deterministic workflows (.mjs, export phases)
└── examples/opencode.json    # opencode integration example
```

## Community & License

MIT. Issues / PRs welcome on GitHub.

---

> **AIH-driven development**: this repo's commits are made by AIH (App Intelligence
> Harness) itself — from feature development and integration testing to documentation
> maintenance, executed autonomously by the agent under permission guardrails and
> audit logging. It is AIH's own demonstration of "connecting an app to AI".
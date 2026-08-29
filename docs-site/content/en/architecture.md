---
title: Architecture
description: Layered architecture — L0 integration / L1 kernel / L2 procedures / L3 skills, Seams, guarded pipeline, append-only sessions.
---

# Architecture

AIH has four layers + one cross-cutting plane:

```
L3 skill layer   skills/            on-demand domain knowledge, self-evolving via skill-creator
L2 procedure     APP.md · harness.yml · scripts · tasks · docs/decisions.md
L1 kernel        core/              SessionLog · ToolRegistry(guarded pipeline) · AgentLoop(turn/step) · Seams(LLM/permissions)
L0 integration   mcp-server/        AppAdapter: Context(read) / Action(write, with permissions) / Event(stream)
cross-cutting    allow/ask/deny permissions · audit log · eval handoff gate
```

## L0 integration layer (AppAdapter)

One app = one adapter: `descriptor` + `context(query)` + `actions`. This is the **only** integration surface; `APP.md` is the single source of truth. All three forms (MCP / CLI / SDK) reuse the same L0 contract.

## L1 kernel layer (core/)

- **SessionLog**: append-only JSONL event stream, "if the model can see it, it can be replayed"; supports fork/tree/checkpoint rollback
- **ToolRegistry (guarded pipeline)**: tool registration + permission guards + hooks (redaction/timing/audit) + parallel read-only scheduling
- **AgentLoop (turn/step)**: drives a multi-step round, `build/plan` dual mode, Goal judge, subagents
- **Seams**: replaceable seams — LLM adapter (OpenAI-compatible/SSE), sandbox backend, approval gate, skill loading

## L2 procedure layer

`APP.md` (app contract), `harness.yml` (declarative config), `scripts/` (doctor/check/eval gates), `docs/decisions.md` (decision records).

## L3 skill layer

SKILL.md three-tier loading (project > user > builtin) + BM25 relevance auto-suggestion + external registry install.

## Cross-cutting plane

- **three-tier permissions** allow / ask / deny + pattern/path scoping + doom_loop + key scoping
- **audit**: each tool call logged to `.aih/tool-audit.jsonl` (ok/error)
- **eval handoff gate**: `npm run eval` (doctor + bootstrap + check + test)

## Key design decisions

- **general kernel + app tools**: the kernel binds to no business; tools are injected by AppAdapter
- **append-only**: sessions/audit only append; rollback = prefix fork; crash-recoverable
- **Seam first**: LLM/sandbox/approval/skills are all seams, pluggable and never locked in
- **judgment decoupled from execution**: Goal judge, best_of_n judge are independent of the executing agent

## Directory structure

```
core/        L1 kernel (agent-loop / tool-registry / session-log / seams / prompts)
cli/         CLI + TUI + local tools (dev-tools / general-tools / sandbox / env-policy)
mcp-server/  L0 integration (app-adapter / todo-app example)
docs-site/   this site (isolated package, single dep: marked)
scripts/     doctor / check / eval / install / package / bench
docs/        internal design docs (roadmap / decisions / parity-matrix / test-plan)
```

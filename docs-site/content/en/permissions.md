---
title: Permissions
description: allow / ask / deny three-tier permissions, pattern/path scoping, doom_loop, autoAllowReadonly, key scoping.
---

# Permissions

AIH uses **allow / ask / deny** three-tier permissions to control every tool/action: reads are allowed by default, writes require confirmation by default, business red lines are refused outright.

## Three tiers

| Tier | Default target | Behavior |
|---|---|---|
| `allow` | read ops | run directly |
| `ask` | write ops | confirmed via `ApprovalGate` (human/policy) |
| `deny` | business red lines | rejected by the registry |

Implement `ApprovalGate` to plug in your own approval system (`PolicyGate` provides a rule-engine skeleton).

## Inline confirmation in the TUI

```
⚠ approval requested: run_cmd { "command": "rm -rf build" }
  [y] once · [n] no · [a] always <scope>
```

- `scope` is auto-derived from the target path to its parent directory
- choosing `a` (always) persists to aih.json as **last-match-wins** (project > global)
- submissions while busy are queued automatically (`queued: …`)

## Configuring permission rules

Declare pattern / path-scoped rules in `aih.json` (last-match-wins):

```json
{
  "permissions": {
    "edit": "allow",
    "run_cmd": "ask",
    "write_file:src/**": "allow",
    "write_file:secrets/**": "deny"
  }
}
```

- Wildcards control multiple tools at once (e.g. `mymcp_*: "ask"`)
- Path scoping lets you allow/deny "writes under a directory" independently
- Folder-level permissions: `v1` delivered (opencode pattern Ruleset)

## doom_loop guard

opencode's permission baseline `doom_loop: ask`: detects the agent repeatedly running the same failing operation (a death loop); when triggered it degrades to `ask` requiring human confirmation, preventing token burn.

## autoAllowReadonly (auto mode)

In `plan` mode + auto, **read-only** commands (e.g. `git status`, `ls`, read-only `run_cmd`) are auto-allowed without per-call prompts — the read-only classification is a deterministic local decision (no ML); writes still go through `ask`.

## Key scoping (runtime egress validation)

- **Subprocess env key filtering**: `run_cmd` children strip `KEY`/`TOKEN`/`SECRET`/`PASSWORD`-like variables and `AIH_*API*`, preventing key leakage into the child environment (`cli/src/env-policy.ts`)
- **Keys only sent to their owner endpoint**: runtime egress validation — telemetry etc. never carries a key that doesn't belong to that endpoint
- **Project trust gate**: `project-trust.ts` + `trust.json`; extensions/hooks in untrusted projects are constrained

## Injection-source approval isolation

Instructions coming from tool results / external content (injection sources) do not enjoy the same approval treatment as user instructions — preventing "instructions smuggled in tool output" from bypassing `ask` and running directly.

## Next steps

- Annotate permissions when integrating → [Integrate your app](adapter)
- Tool list → [Tools](tools)
- Session audit → [Sessions](sessions)

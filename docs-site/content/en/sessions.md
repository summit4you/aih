---
title: Sessions
description: Session persistence & audit — append-only JSONL, fork/tree structure, checkpoint rollback, branch distillation, compaction.
---

# Sessions

AIH sessions are **append-only JSONL** (one `SessionEvent` per line): "if the model can see it, it can be replayed." `chat` and `run` persist sessions to `.aih/sessions/default.jsonl` by default (flushed on exit, including Ctrl-C/exit interrupts); re-entering auto-resumes and **replays history** (user/assistant messages, tool calls & results, compaction events rendered in original order, full context restored).

## Persistence & resume

```sh
npm run cli -- chat                                # default persists to default, auto-restores next time
npm run cli -- run "add todo A" --session work     # name a session → .aih/sessions/work.jsonl
npm run cli -- run "add todo B" -c                 # resume the last session (full context kept)
npm run cli -- run "..." --ephemeral              # disable persistence
```

## Session management

```sh
npm run cli -- session list                       # list
npm run cli -- session show work                  # human-readable replay
npm run cli -- session export work > work.json    # export to JSON
npm run cli -- session rm work                    # delete
npm run cli -- stats                              # token usage across all sessions
```

## Fork & tree structure

```sh
npm run cli -- session fork default branch-a --from 7   # fork a new session from event seq 7
```

- each event has an optional `parentId` (default = previous; legacy files migrate zero-cost)
- `SessionLog.tree()` / `branchPoints()`; TUI `/tree` branch view
- **branch distillation**: `session distill-branch <discard> <target> --from 7` distills a discarded branch into a `branch_summary` injected into the target session

## Checkpoints & rollback

```sh
npm run cli -- session checkpoint work "before risky refactor"   # record a checkpoint
npm run cli -- session restore work                              # rollback: fork the prefix into work-restore-<seq> (original file untouched)
# in TUI: /checkpoint [note] and /restore [seq] (auto-snapshots full history before rollback)
```

- **append-only**: rollback does not delete the original file; it forks the prefix into a new session
- Stateful tools stamp full state into tool-result details (e.g. the `todo` tool
  `details: { kind: "state.todos", todos }`); on `/restore`, the latest snapshot is recovered from the pre-rollback prefix and written back to `.aih/todos.json` — **state rolls back naturally with the branch**

## Context compaction

- **active + passive + manual**: `/compact [focus]`
- **projective checkpoint**: compaction events carry `coverage { upToSeq, eventCount, digest }`; `deriveMessages` only accepts a summary whose digest matches (if the session file was modified externally, the projection is refused with a warning, fail-open)

## Next steps

- Token usage → [Configuration](config#environment-variables)
- Goal judge → see the [Introduction](index) feature highlights

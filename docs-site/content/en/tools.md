---
title: Tools
description: AIH's tool system — external app tools + built-in general tools, parallel read-only, sandbox seam.
---

# Tools

AIH's agent kernel is **general**: tools come from the connected app (AppAdapter Actions). The interactive terminal also mounts a set of local general tools by default (coexisting with any MCP app tools; **on name collision, the app tool wins**).

## Built-in general tools

| Tool | Description | Permission |
|---|---|---|
| `list_dir` / `read_file` | list dir / read file (64KB truncation, line offset) | allow |
| `write_file` / `run_cmd` | write file / run command (default 120s timeout, `timeout_ms` up to 600s; background children don't block) | ask |
| `edit` | exact string-replace edit (errors on ambiguity, `replace_all` for all) | ask |
| `glob` / `grep` | find files by pattern / regex content search | allow |
| `webfetch` / `websearch` | fetch URL (browser UA, bounded retry, Cloudflare self-heal, `timeout` arg, actionable errors) / web search | allow |
| `todo` | session task list (state stamped into tool-result, rolls back with branches) | allow |
| `remember` | persist knowledge to memory.md (project / user tiers) | allow |
| `load_skill` | load a skill's full text (dedup; second call returns the summary) | allow |
| `task` | serial subagent (own context, bounded steps) | allow |
| `best_of_n` | parallel subagents + judge (Max Mode); multi-strategy `prompts` (FB#1) + optional two-judge panel via `AIH_SECOND_JUDGE_MODEL` (FB#2) | allow |
| `question` | ask the user and wait for an answer (interactive) | allow |

## Parallel read-only tools

**Consecutive read-only** tool calls within a single step run concurrently, capped at `AIH_TOOL_CONCURRENCY` (default 4); **write tools are always serial**; results are persisted in original order. Reads/writes interleaved still keep writes serial.

## Sandbox seam

`run_cmd`'s execution backend is replaceable (the `SandboxBackend` interface in `cli/src/sandbox.ts`):

| Backend | Description |
|---|---|
| `local` (default) | run directly on this machine |
| `bwrap` | bubblewrap sandbox |
| `remote` | remote execution |

Select via `AIH_SANDBOX` or the tool's `sandbox` arg. Interface first, local by default.

## Tool results

- **Pruning + lazy archive**: oversized results are pruned, the full output saved to `.aih/outputs/*.log`, read back on demand via `archive_read`
- **Redaction + timing hooks**: built-in hooks (on by default) redact and time tool results
- **T1/T2 boundary facts**: `commitToolPrepared` / `commitToolOutcome` record tool boundaries so crash recovery is decidable

## Skill layer

Skills are reusable instruction packs (YAML frontmatter + body) that let the agent "understand the domain on connect":

```sh
npm run cli -- skills list                        # list: project > user > builtin tiers
npm run cli -- skills find tour                   # search by keyword
npm run cli -- skills install app-tour            # materialize a builtin skill to .aih/skills/
npm run cli -- skills show app-tour               # view the body
```

Built-in skills: `app-tour` (capability tour), `batch-ops` (plan-execute-verify bulk ops), `session-report` (session report). On name collision, project overrides user overrides builtin.

**Relevance auto-loading**: before each round, BM25 ranks installed skills by relevance (CJK char-bigram tokenization); a matching skill is injected as a "suggested load" hint so the model can `load_skill` directly.

## Next steps

- Permissions per tool → [Permissions](permissions)
- Integrate your own app → [Integrate your app](adapter)

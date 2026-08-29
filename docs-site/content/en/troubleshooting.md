---
title: Troubleshooting
description: Common problems and fixes — install, connectivity, permissions, sessions, performance.
---

# Troubleshooting

## Install & run

**`node: command not found` / version too low**

AIH needs Node.js ≥ 20. Confirm with `node -v`; upgrade via `nvm` or a package manager and retry.

**`npm run cli` reports a missing module**

Build first:

```sh
npm run bootstrap && npm run build
```

**Install script fails**

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

Use `--dir <path>` to change the directory, `--no-modify-path` to leave PATH alone; on Windows use the PowerShell `irm | iex` variant.

## Connectivity & models

**`401 / 403` (auth failure)**

- confirm `AIH_API_KEY` (or the provider's `apiKeyEnv`) is set and valid
- confirm `AIH_BASE_URL` points at the correct OpenAI-compatible endpoint
- `aih config` prints the effective config and each field's source — check provider / baseUrl / model

**`429` (rate-limited) / 5xx**

The LLM auto-retries 429/5xx; if it keeps failing, switch to another provider or model (`/model` hot-switch, `aih models` to see what's available).

**Connection timeout / no response**

- check network and proxy; is `AIH_BASE_URL` reachable
- a streaming (SSE) endpoint must support `stream: true`

## Permissions

**A write is refused / keeps asking for confirmation**

- in non-TTY, writes require explicit `--yes`, otherwise they're refused
- `ask` is the default tier; adjust per pattern/path in `aih.json` `permissions` (last-match-wins)
- choosing `a` (always) persists at folder level, avoiding repeated prompts
- `denied by registry` means a `deny` red line was hit — that's expected; change config or business logic

**doom_loop triggered**

the agent repeatedly running the same failing operation is degraded to `ask` requiring human confirmation — this is the anti-token-burn guard; check whether the tool-call arguments are stuck in a loop.

## Sessions

**Context lost / didn't resume**

- confirm you didn't use `--ephemeral` (that flag disables persistence)
- sessions default to `.aih/sessions/default.jsonl`; `--session <name>` names one, `-c` resumes the last
- `aih session list` / `show` to inspect; `aih stats` for token usage

**State wrong after rollback**

Rollback is a "prefix fork"; the original file is untouched. Stateful tools (e.g. `todo`) recover the latest snapshot from the pre-rollback prefix and write it back. Confirm the `/restore [seq]` seq is correct.

## Performance

**Slow responses**

- `/compact` to shrink a long session's context first
- use `plan` mode for read-only analysis (read-only commands auto-allowed, fewer confirmation round-trips)
- `run_cmd` defaults to a 120s timeout; pass `timeout_ms` (up to 600s) for long tasks or background it

**Output truncated**

Oversized tool results are handled by "prune + lazy archive"; the full output is saved to `.aih/outputs/*.log`, read back on demand via `archive_read`; `run_cmd keep_output=true` forces the full output to be kept.

## Get help

- `aih doctor` — environment & readiness check
- `aih config` — effective config and sources
- `aih --help` / each subcommand's `--help`
- repo issues: [github.com/summit4you/aih](https://github.com/summit4you/aih)

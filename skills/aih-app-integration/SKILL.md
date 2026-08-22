---
name: aih-app-integration
description: Wire any ordinary application into the App Intelligence Harness (AIH) so AI agents can read its state and perform actions. Use when adding AI assistance to an existing app, creating an AppAdapter, exposing app capabilities as MCP tools, writing APP.md contracts, or extending the session log / tool registry / agent loop in this repository.
---

# AIH App Integration

Give any ordinary application standardized AI assistance by exposing three
primitives — **Context** (read state), **Action** (guarded operations),
**Event** (change stream) — through a layered harness.

## Read first

- `APP.md` — the behavioral contract for agents operating on the app
- `harness.yml` — canonical commands and task-loop stages
- `docs/decisions.md` — durable decisions that constrain new work

## Layer map

| Layer | Location | Borrowed from |
|---|---|---|
| L0 access | `mcp-server/` | MCP external-hitch pattern |
| L1 kernel | `core/` | deepseek-harness (session log, guarded tools, agent loop, seams) |
| L2 contract | `APP.md`, `harness.yml`, `scripts/` | Harness-for-codex |
| L3 skills | `skills/` | open agent skills ecosystem |

## Standard MCP tools

Every AIH MCP server exposes:

- `app_describe` — self-description: context queries and actions with permission levels; call first
- `app_context` — read state by query name
- one tool per adapter action (e.g. `add_todo`), named exactly as in APP.md section 4

## CLI access

The `aih` CLI (`cli/`, also `npm run cli --`) connects over MCP stdio and
mirrors opencode conventions:

- `aih run "<msg>" [--format json] [--mock] [-y]` — one-shot turn; piped stdin is merged into the message; `--format json` streams NDJSON session events on stdout; tool calls trace as `⚙ name {args}` on stderr
- `aih chat` — interactive REPL with `/tools /events /inject /exit`
- `aih tools` / `aih describe` — must stay consistent with APP.md section 4
- `-s "<command>"` targets any MCP server; permission parsed from the `[kind=..., permission=...]` description suffix
- LLM seam: any OpenAI-compatible endpoint via `AIH_BASE_URL`/`AIH_MODEL`/`AIH_API_KEY`; `--mock` for offline demos

## Adding a new application

1. **Create an adapter** in `mcp-server/src/app-adapter.ts` style:
   - implement `AppAdapter`: `descriptor`, `context(query)`, `actions`
   - each action declares `kind` (`read`/`write`) and `permission`
     (`allow`/`ask`/`deny`); writes default to `ask`
   - use zod schemas for action parameters; they become MCP tool schemas
2. **Swap it into** `mcp-server/src/index.ts` (`new TodoAppAdapter()` → your adapter).
3. **Update APP.md**: section 4 must list every context query and action with
   its permission level.
4. **Extend the smoke test** in `mcp-server/src/smoke.ts` to cover one read
   and one write path of the new adapter.
5. **Run the handoff gate**: `npm run eval`.

## Extending the kernel (L1)

- New model-visible data ⇒ extend `SessionEvent` in `core/src/types.ts` and
  project it in `SessionLog.deriveMessages()` (invariant: model-visible means
  logged).
- New policy ⇒ implement `ApprovalGate` (see `PolicyGate`) rather than editing
  the registry.
- New model provider ⇒ implement `LLMAdapter`; never call model APIs elsewhere.

## Non-negotiables

- Never bypass the tool registry's guard pipeline (`pre-permission → execute → log`).
- Never let the agent touch storage/filesystems directly; only via declared actions.
- Update `docs/decisions.md` before any breaking change to the contract files.

---
title: Quick start
description: Get started with the three integration forms — MCP plugin, CLI integration, embedded SDK — with the todo example.
---

# Quick start

AIH ships a todo app as the example adapter; the following demos use it to show the three integration forms.

## Form 1: MCP plugin (zero-intrusion, recommended start)

Mount AIH's tools into any MCP client (opencode / codex / claude code):

```json
{
  "mcpServers": {
    "todos": {
      "command": "node",
      "args": ["/absolute/path/aih/mcp-server/dist/index.js"]
    }
  }
}
```

The client can now call `list_todos` / `add_todo` / `toggle_todo` / `remove_todo`; AIH handles permissions, audit, and sessions.

## Form 2: CLI integration

```sh
# interactive terminal (opencode-style TUI, needs a TTY)
aih

# one-shot Q&A (offline demo, no API key)
npm run cli -- run "add a todo buy milk" --mock

# real model (any OpenAI-compatible endpoint, SSE streaming)
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "list today's todos"

# session persistence: --session names it, -c resumes the last one
npm run cli -- run "add todo A" --session work
npm run cli -- run "add todo B" -c
```

**Common subcommands**:

| Command | Purpose |
|---|---|
| `aih tools` / `aih describe` | list tools / describe tools (consistent with §4 of `APP.md`) |
| `aih config` / `aih models` | print effective config / list all providers & models |
| `aih session list\|show\|export\|fork\|checkpoint\|restore` | session management |
| `aih skills list\|find\|install\|show` | skill management |
| `aih stats` | token usage across all sessions |
| `aih serve` / `aih attach` | headless service / remote attach |

## Form 3: Embedded Copilot (SDK)

Reuse the L1 kernel directly and register business tools into `AgentLoop`:

```js
import { AgentLoop, ToolRegistry } from "@aih/core";

const registry = new ToolRegistry();
registry.register({
  name: "get_order",
  description: "Read order status",
  kind: "read",
  permission: "allow",
  run: async (args) => myApp.getOrders(args.id),
});
// … hand the registry to AgentLoop to drive an embedded agent
```

## Write confirmation

Write operations require confirmation by default:

- **TTY**: `[y/N]` prompt
- **non-TTY**: explicit `--yes` required, otherwise refused

```sh
npm run cli -- run "delete todo #3" --yes   # explicitly allow in a script pipeline
```

## Next steps

- Configure providers & models → [Configuration](config)
- Integrate your own app → [Integrate your app](adapter)
- Understand the permission model → [Permissions](permissions)

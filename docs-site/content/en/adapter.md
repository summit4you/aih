---
title: Integrate your app
description: Connect your own application to AIH — implement AppAdapter (Context/Action/Event) and expose tools with permissions.
---

# Integrate your app

AIH's integration surface is the **L0 contract**: `Context` (read) / `Action` (write) / `Event` (change stream). Implement these three primitives and your app becomes an agent-ready app. `APP.md` is the single source of truth.

## The three primitives

### Context (read state)

Expose read-only state queries. Each is a named query returning a JSON-serializable snapshot:

```ts
context: {
  query: (name: string) => Promise<unknown>,  // e.g. "all", "stats"
}
```

### Action (execute, with permissions)

Expose executable actions. Each declares `kind` (read/write) and `permission` (allow/ask/deny):

```ts
actions: [
  { name: "add_todo", kind: "write", permission: "allow", run: (args) => … },
  { name: "remove_todo", kind: "write", permission: "ask", run: (args) => … },
]
```

### Event (change stream, optional)

Emit change events after mutations so clients can react:

```ts
on: (event: "todo.added" | "todo.removed" | …) => …
```

## Descriptor

Every adapter has a `descriptor` (name, version, one-line description) that `aih describe` and the TUI status bar display.

## Wiring it up

1. **MCP plugin**: wrap the adapter in an MCP server (`mcp-server/`) and point any MCP client at it.
2. **CLI**: pass `-s/--server` or configure `mcpServers` so `aih` connects to your adapter.
3. **Embedded SDK**: register the actions directly into a `ToolRegistry` and hand it to `AgentLoop`.

## Permission defaults

- Read actions → `allow`
- Write actions → `ask` (confirmed via the approval gate)
- Business red lines → `deny` (rejected by the registry)

See [Permissions](permissions) for the full model and how to override per-tool.

## Next steps

- Permission model → [Permissions](permissions)
- Tool system → [Tools](tools)
- Session audit → [Sessions](sessions)

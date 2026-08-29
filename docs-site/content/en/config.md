---
title: Configuration
description: aih.json configuration — precedence, providers/models, multiple MCP servers, $schema, environment variables.
---

# Configuration

## Precedence

**flag > environment variables > project `aih.json` / `.aih/config.json` > global user config**.

Config files are **merged**, not replaced: a later file only overrides earlier ones on key conflicts; non-conflicting settings are all preserved.

## Global user config (XDG)

Global config resolves per the **XDG data-directory spec** (`cli/src/paths.ts`):

```
AIH_HOME  >  $XDG_DATA_HOME/aih  >  ~/.local/share/aih
```

Legacy `~/.aih` is **still readable** when the XDG dir doesn't exist (smooth migration — existing old config is not lost).

## Project config example

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

- `model` is the primary model; `models[]` lists extra switchable models on the same endpoint (sharing that provider's `baseUrl` / `headers` / `apiKeyEnv`).
- Each model gets its own row in `aih models` and the TUI `ctrl-p` model picker; hot-switch with `/model <provider>/<model>` — handy for hanging free-tier / multi-tier models on one endpoint.

## Editor completion (`$schema`)

Add this to the top of `aih.json` / `config.json`:

```json
{ "$schema": "https://aih.dev/schema/aih.schema.json" }
```

to get field auto-completion and validation. `aih config --schema` prints the JSON Schema directly (local file `cli/schema/aih.schema.json`).

## Multiple MCP servers (`mcpServers`)

Besides `-s/--server` for a single MCP server, you can declare **multiple** MCP servers; AIH connects to all in parallel and aggregates their tools; duplicate tool names are renamed `<server>_<tool>`:

```json
{
  "mcpServers": {
    "todos": {
      "command": "node",
      "args": ["/absolute/path/aih/mcp-server/dist/index.js"],
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

- `command` is required, `args` optional; `enabled: false` temporarily disables a server.
- Resolution precedence: `-s/--server` (single) > `mcpServers` (multiple) > bundled todo-app.
- Multi-server duplicate tools get a server prefix (e.g. `todos_ping` vs `search_ping`), and tool comments note the source `(from <server>)`; with a single server, tool names stay as-is.

## Environment variables

| Variable | Purpose |
|---|---|
| `AIH_API_KEY` | API key for the provider |
| `AIH_MODEL` | model id |
| `AIH_BASE_URL` | OpenAI-compatible endpoint |
| `AIH_TODO_STORE` | persist the example app's state across processes |
| `AIH_TOOL_CONCURRENCY` | max parallel read-only tools (default 4) |
| `AIH_SANDBOX` | `run_cmd` backend: local / bwrap / remote |
| `AIH_HOME` | override the global config dir |

## Next steps

- Integrate your own app → [Integrate your app](adapter)
- Permission rules in config → [Permissions](permissions)

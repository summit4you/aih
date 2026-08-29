---
title: Commands
description: Slash commands and CLI subcommands quick reference — TUI / commands, aih subcommands, common flags.
---

# Commands

## TUI slash commands

Type `/` in the interactive terminal to trigger Tab ghost completion. Common commands:

| Command | Purpose |
|---|---|
| `/help` (`/h`) | help |
| `/commands` | list all commands |
| `/mode` | switch build / plan mode |
| `/goal <condition>` | set a goal, independent judge each round until met (`AIH_GOAL_ROUNDS` cap) |
| `/model <id>` | hot-switch model (`ctrl-p` opens the model picker) |
| `/models` | list providers & models |
| `/tools` | list currently available tools |
| `/usage` | token usage + cost + cache hits |
| `/compact [focus]` | proactively compact context (optional focus) |
| `/clear` | clear the current session context |
| `/inject <text>` | inject a prompt |
| `/events` | view the event stream |
| `/skills` | skill management |
| `/find <text>` | search across all tool outputs line by line |
| `/tree` | session branch view |
| `/fork` | fork from the current point |
| `/checkpoint [note]` | record a checkpoint |
| `/restore [seq]` | roll back to a checkpoint |
| `/distill` | branch distillation |
| `/memory` | persistent memory |
| `/bg <prompt>` | background task |
| `/vivid` | minimal rendering (strip chrome) |
| `/health` | health check |
| `/proc` | process view |
| `/quit` (`/exit`) | exit |

> The full list is authoritative in the TUI via `/commands` (evolves with versions).

## CLI subcommands

| Command | Purpose |
|---|---|
| `aih` | launch the interactive terminal (needs a TTY) |
| `aih run "<msg>" [flags]` | one-shot Q&A |
| `aih chat` | interactive session |
| `aih tools` / `aih describe` | list / describe tools |
| `aih config` / `aih models` | print config / list providers & models |
| `aih session <list\|show\|rm\|export\|import\|fork\|checkpoint\|restore>` | session management |
| `aih stats` | token usage across all sessions |
| `aih team <…>` | Agent Teams |
| `aih skills <…>` | skill management |
| `aih workflow <list\|run>` | deterministic multi-phase runs |
| `aih init [dir]` | scaffold a new app |
| `aih serve --port N` | headless HTTP/SSE service |
| `aih attach <url>` | remote attach |
| `aih mcp` | serve the bundled todo-app over stdio |
| `aih agents` | list named agent profiles |
| `aih bench` | performance benchmark |

## Common flags

| Flag | Purpose |
|---|---|
| `--mock` | scripted LLM, offline demo/test |
| `-y, --yes` | auto-approve `ask` tools |
| `--dev` | mount the local general toolset for one-shot `run` (coding agent) |
| `--no-dev` | disable the default local toolset in `chat` |
| `--goal <condition>` | judge-verified auto-continue |
| `-a, --as <name>` | use a named agent profile |
| `--session <name>` / `-c` | name a session / resume the last one |
| `--ephemeral` | disable session persistence |
| `--trust` / `--no-trust` | one-shot project trust override |
| `--no-extensions` | disable extension loading |

---
title: Installation
description: Install AIH — one-line script, package managers, or build from source.
---

# Installation

## Prerequisites

- **Node.js ≥ 20** (required for both build and run)
- A modern terminal emulator (for the interactive TUI)
- An API key for the LLM provider you want to use (optional — the `--mock` offline demo needs no key)

## One-line install (recommended)

**macOS / Linux / WSL**:

```sh
curl -fsSL https://raw.githubusercontent.com/summit4you/aih/main/scripts/install | bash
```

**Windows PowerShell**:

```powershell
irm https://raw.githubusercontent.com/summit4you/aih/main/scripts/install.ps1 | iex
```

**Options**: `--version <ver>` (pin a version), `--dir <path>` (custom directory), `--no-modify-path` (don't touch PATH).

## Install from source (developers)

```sh
git clone https://github.com/summit4you/aih && cd aih
npm run bootstrap   # install dependencies
npm run doctor      # readiness check
npm run check       # build + contract consistency
npm test            # smoke tests (core / mcp / cli)
npm run eval        # full handoff gate (doctor + bootstrap + check + test)
```

## Verify the install

```sh
# offline demo (no API key)
npm run cli -- run "add a todo buy milk" --mock

# real model (any OpenAI-compatible endpoint, SSE streaming)
AIH_BASE_URL=https://api.deepseek.com/v1 \
AIH_MODEL=deepseek-chat \
AIH_API_KEY=sk-... npm run cli -- run "list today's todos"
```

## Launch the interactive terminal

```sh
# enter the opencode-style TUI (needs a TTY)
aih
```

## Offline package

The repo ships a `dist-offline/` bundle for air-gapped environments: package `node_modules` alongside it and `npm ci --offline`.

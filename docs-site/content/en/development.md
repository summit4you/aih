---
title: Development
description: Developing AIH itself — build, test, gates, directory structure, contribution flow.
---

# Development

AIH is a TypeScript monorepo (`core/` kernel · `cli/` CLI+TUI · `mcp-server/` integration layer); `docs-site/` is an isolated package.

## Environment

- **Node.js ≥ 20**
- npm workspaces (`core` / `cli` / `mcp-server`)

## Common commands

```sh
npm run bootstrap   # install dependencies
npm run build       # tsc -b builds the three workspaces
npm run doctor      # environment & readiness check
npm run check       # build + contract consistency
npm test            # smoke tests (core / mcp / cli)
npm run eval        # full handoff gate (doctor + bootstrap + check + test)
npm run cli -- <cmd>  # CLI: run / chat / tools / describe / sessions …
npm run bench       # AIH vs opencode performance benchmark
```

## Handoff gate

Run `npm run eval` before completing a task as the handoff gate — it chains doctor + bootstrap + check + test; all green counts as delivered.

## Directory structure

```
core/        L1 kernel (agent-loop / tool-registry / session-log / seams / prompts)
cli/         CLI + TUI + local tools (dev-tools / general-tools / sandbox / env-policy)
mcp-server/  L0 integration (app-adapter / todo-app example)
docs-site/   docs site (isolated package, single dep: marked)
scripts/     doctor / check / eval / install / package / bench
docs/        internal design docs (roadmap / decisions / parity-matrix / test-plan)
```

## Change rules

1. When adding/modifying an Action or Context, you must update: `APP.md` §4, `mcp-server/src/app-adapter.ts`, and the smoke tests.
2. Breaking changes require a decision record in `docs/decisions.md` first.
3. Run `npm run eval` as the handoff gate before completing a task.

## Contribution flow

1. Fork + branch
2. local `npm run eval` all green
3. open a PR with a change description and (if applicable) a `docs/decisions.md` decision record
4. maintainers run the gate, then merge

## Docs-site development

`docs-site/` is an isolated package (single dependency `marked`):

```sh
cd docs-site
npm run build   # content/{zh,en}/*.md → dist/
npm run check   # validate both languages: nav↔content 1:1, links, assets
```

Content lives in `content/zh/` and `content/en/`, each with its own `_nav.json` as the single source of truth for navigation; all internal links are relative, so the site deploys cleanly to a GitHub Pages subpath.

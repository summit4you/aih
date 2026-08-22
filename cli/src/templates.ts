export const T_APP_MD = `# {{NAME}} — App Contract

## 1. What the app is
{{NAME}} is a minimal item store exposed to the AI through MCP tools.

## 2. Tools exposed to the model
| tool | kind | permission | description |
|---|---|---|---|
| list_items | read | allow | List all items |
| add_item | write | ask | Add a new item |
| remove_item | write | ask | Remove an item by id |

## 3. State ownership
State lives in the app adapter. The AI never touches storage directly.

## 4. Commands
| command | purpose |
|---|---|
| npm run build | compile |
| npm test | smoke test |
`;

export const T_HARNESS_YML = `name: {{NAME}}
version: 1
contract: APP.md
commands:
  bootstrap: npm run bootstrap
  check: npm run check
  test: npm test
  eval: npm run eval
documents:
  agent_instructions: AGENTS.md
  claude_bridge: CLAUDE.md
  decisions: docs/decisions.md
  task_template: tasks/TEMPLATE.md
task_loop: [inspect, plan, implement, verify, handoff]
verification:
  default: npm run check
  handoff: npm run eval
permissions:
  default_read: allow
  default_write: ask
compatibility:
  aih: APP.md
  codex: AGENTS.md
  claude_code: CLAUDE.md
 `;

export const T_AGENTS_MD = `# {{NAME}} — Agent Operating Instructions

## Commands
| command | purpose |
|---|---|
| npm run bootstrap | install/prepare dependencies |
| npm run check | lint + typecheck + tests (default gate) |
| npm test | test suite only |
| npm run eval | handoff gate: doctor + build + check |

## Task loop
1. inspect — read APP.md, this file, and recent entries in docs/decisions.md
2. plan — state the approach before editing (aih: /mode plan for read-only planning)
3. implement — smallest change that satisfies the task
4. verify — \`npm run check\` must pass before handoff
5. handoff — record durable decisions in docs/decisions.md

## Rules
- State ownership: app data lives in the adapter; never edit storage files directly.
- Write-kind tool calls require approval unless allowed by harness permissions (aih.json "permissions").
- Keep APP.md, this file, and harness.yml in sync when tools or commands change.
`;

export const T_CLAUDE_MD = `# CLAUDE.md

Read and follow \`AGENTS.md\` (shared agent instructions) and \`APP.md\` (app contract).
`;

export const T_GITIGNORE = `node_modules/
dist/
*.tsbuildinfo
.aih/
`;

export const T_DECISIONS = `# Decisions

Durable decisions future agents should preserve.

- [DATE] Scaffolded by \`aih init\`.
`;

export const T_TASK_TEMPLATE = `# Task: <title>

## Goal
What does done look like?

## Constraints
Non-negotiables.

## Verification
How to prove it works.
`;

export const T_BOOTSTRAP = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d mcp-server/node_modules ] || (cd mcp-server && npm install --silent)
echo "bootstrap ok"
`;

export const T_DOCTOR = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== {{NAME}} harness doctor =="
command -v node >/dev/null || { echo "missing: node"; exit 1; }
node --version
[ -f APP.md ] && echo "APP.md: present" || { echo "APP.md: missing"; exit 1; }
[ -f harness.yml ] && echo "harness.yml: present"
echo "doctor ok"
`;

export const T_CHECK = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
(cd mcp-server && npx tsc --noEmit)
echo "check ok"
`;

export const T_EVAL = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash scripts/doctor
bash scripts/bootstrap
bash scripts/check
npm --prefix mcp-server test 2>/dev/null || true
echo "eval passed: safe to hand off."
`;

export const T_MCP_PACKAGE = `{
  "name": "{{SLUG}}-mcp-server",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0"
  }
}
`;

export const T_MCP_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

export const T_MCP_INDEX = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ItemsAppAdapter } from "./app-adapter.js";

function buildServer(adapter: ItemsAppAdapter): McpServer {
  const server = new McpServer({ name: "{{SLUG}}", version: "0.1.0" });
  server.tool("list_items", "List all items [kind=read, permission=allow]", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(await adapter.list()) }],
  }));
  server.tool(
    "add_item",
    "Add a new item [kind=write, permission=ask]",
    { text: z.string().describe("item text") },
    async ({ text }) => ({
      content: [{ type: "text", text: JSON.stringify(await adapter.add(text)) }],
    }),
  );
  server.tool(
    "remove_item",
    "Remove an item by id [kind=write, permission=ask]",
    { id: z.number().describe("item id") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await adapter.remove(id)) }],
    }),
  );
  return server;
}

async function main(): Promise<void> {
  const adapter = new ItemsAppAdapter();
  await buildServer(adapter).connect(new StdioServerTransport());
  console.error("[{{SLUG}}-mcp] serving over stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

export const T_MCP_ADAPTER = `export interface Item {
  id: number;
  text: string;
}

export class ItemsAppAdapter {
  #items: Item[] = [];
  #nextId = 1;

  async list(): Promise<Item[]> {
    return [...this.#items];
  }

  async add(text: string): Promise<Item> {
    const item: Item = { id: this.#nextId++, text };
    this.#items.push(item);
    return item;
  }

  async remove(id: number): Promise<{ removed: boolean }> {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => i.id !== id);
    return { removed: this.#items.length < before };
  }
}
`;

export const T_CI = `name: ci

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  handoff-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install
        run: npm ci
      - name: Build + contract check
        run: npm run check
      - name: Smoke tests
        run: npm test
`;

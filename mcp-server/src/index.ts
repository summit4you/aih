#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TodoAppAdapter } from "./app-adapter.js";
import type { AppAdapter, AppActionDef } from "./app-adapter.js";

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function buildServer(adapter: AppAdapter): McpServer {
  const server = new McpServer({
    name: adapter.descriptor.name,
    version: adapter.descriptor.version,
  });

  server.registerTool(
    "app_describe",
    {
      description:
        "Describe this application: available context queries and actions with their permission levels. Call this first when unsure what the app can do.",
      inputSchema: {},
    },
    async () => textResult(adapter.descriptor),
  );

  server.registerTool(
    "app_context",
    {
      description: `Read application state. Supported queries: ${adapter.descriptor.contextQueries.join(", ")}.`,
      inputSchema: { query: z.string().describe("which state snapshot to read") },
    },
    async ({ query }) => textResult(await adapter.context(query)),
  );

  for (const [name, def] of Object.entries(adapter.actions)) {
    server.registerTool(
      name,
      {
        description: `${def.description} [kind=${def.kind}, permission=${def.permission}]`,
        inputSchema: shapeOf(def),
      },
      async (args) => textResult(await def.run(args)),
    );
  }

  return server;
}

function shapeOf(def: AppActionDef): z.ZodRawShape {
  return def.parameters as unknown as z.ZodRawShape;
}

async function main(): Promise<void> {
  const adapter = new TodoAppAdapter(process.env.AIH_TODO_STORE);
  const server = buildServer(adapter);
  await server.connect(new StdioServerTransport());
  console.error(`[aih-mcp-server] serving app "${adapter.descriptor.name}" over stdio`);
}

main().catch((err) => {
  console.error("[aih-mcp-server] fatal:", err);
  process.exit(1);
});

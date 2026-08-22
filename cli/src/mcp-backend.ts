import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition, ToolSchema } from "@aih/core";

export const VERSION = "0.1.0";

export interface McpBackend {
  readonly label: string;
  listTools(): Promise<ToolDefinition[]>;
  describe(): Promise<unknown>;
  close(): void;
}

export interface McpServerSpec {
  /** stable id used for tool-name prefixing and display */
  name: string;
  command: string;
  args?: string[];
}

function commandLabel(command: string, args: string[] = []): string {
  return `${command} ${args.join(" ")}`.trim();
}

function toolNameFor(prefix: string, name: string): string {
  return `${prefix}_${name}`;
}

const PERMISSION_SUFFIX = /\[kind=(read|write), permission=(allow|ask|deny)\]\s*$/;

function parsePermission(description: string): {
  kind: "read" | "write";
  permission: "allow" | "ask" | "deny";
  cleanDescription: string;
} {
  const match = description.match(PERMISSION_SUFFIX);
  if (match) {
    return {
      kind: match[1] as "read" | "write",
      permission: match[2] as "allow" | "ask" | "deny",
      cleanDescription: description.replace(PERMISSION_SUFFIX, "").trim(),
    };
  }
  return { kind: "read", permission: "allow", cleanDescription: description.trim() };
}

function extractText(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (!r?.content) return result;
  const texts = r.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined || result;
  }
}

export async function connectBackend(
  command: string,
  args: string[],
  opts: { quiet?: boolean } = {},
): Promise<McpBackend> {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: opts.quiet ? "pipe" : "inherit",
    env: Object.fromEntries(
      Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
    ),
  });
  const client = new Client({ name: "aih-cli", version: VERSION });
  await client.connect(transport);

  const label = commandLabel(command, args);

  const loadTools = async (): Promise<ToolDefinition[]> => {
    const res = await client.listTools();
    return res.tools.map((tool): ToolDefinition => {
      const parsed = parsePermission(tool.description ?? "");
      return {
        name: tool.name,
        description: parsed.cleanDescription,
        kind: parsed.kind,
        permission: parsed.permission,
        parameters: (tool.inputSchema ?? {
          type: "object",
          properties: {},
          required: [],
        }) as ToolSchema["parameters"],
        execute: async (callArgs) => {
          const result = await client.callTool({
            name: tool.name,
            arguments: (callArgs ?? {}) as Record<string, unknown>,
          });
          if ((result as { isError?: boolean }).isError) {
            throw new Error(JSON.stringify(extractText(result)));
          }
          return extractText(result);
        },
      };
    });
  };

  return {
    label,
    listTools: loadTools,
    async describe(): Promise<unknown> {
      try {
        const result = await client.callTool({ name: "app_describe", arguments: {} });
        return extractText(result);
      } catch {
        const tools = await loadTools();
        return { server: label, tools: tools.map((t) => t.name) };
      }
    },
    close(): void {
      transport.close();
    },
  };
}

/**
 * Connect several stdio MCP servers side by side. Tools are merged into one
 * registry; when two servers expose the same tool name, the later entry is
 * prefixed with its server id (`<name>_<tool>`) so nothing is shadowed, and
 * the tool description notes the server it comes from.
 */
export async function connectMultiBackend(
  specs: McpServerSpec[],
  opts: { quiet?: boolean } = {},
): Promise<McpBackend> {
  const backends = await Promise.all(
    specs.map((s) =>
      connectBackend(s.command, s.args ?? [], { quiet: opts.quiet }).then((b) => ({
        spec: s,
        backend: b,
      })),
    ),
  );

  const counts = new Map<string, number>();
  for (const { backend } of backends) {
    for (const t of await backend.listTools()) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
  }

  const label = backends.map((b) => b.spec.name).join(", ");

  const decorate = (spec: McpServerSpec, def: ToolDefinition): ToolDefinition => {
    const dup = (counts.get(def.name) ?? 0) > 1;
    const renamed = dup ? toolNameFor(spec.name, def.name) : def.name;
    const note = dup ? ` (from ${spec.name})` : "";
    return {
      ...def,
      name: renamed,
      description: def.description ? `${def.description}${note}` : `Tool from MCP server ${spec.name}.${note}`,
    };
  };

  return {
    label,
    async listTools(): Promise<ToolDefinition[]> {
      const out: ToolDefinition[] = [];
      for (const { spec, backend } of backends) {
        for (const def of await backend.listTools()) {
          out.push(decorate(spec, def));
        }
      }
      return out;
    },
    async describe(): Promise<unknown> {
      const servers: Record<string, unknown> = {};
      const all: ToolDefinition[] = [];
      for (const { spec, backend } of backends) {
        try {
          servers[spec.name] = await backend.describe();
        } catch (err) {
          servers[spec.name] = { error: err instanceof Error ? err.message : String(err) };
        }
        for (const def of await backend.listTools()) all.push(decorate(spec, def));
      }
      return {
        kind: "multi",
        servers,
        tools: all.map((t) => t.name),
      };
    },
    close(): void {
      for (const { backend } of backends) backend.close();
    },
  };
}

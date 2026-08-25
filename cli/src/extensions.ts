/**
 * P#39 — Extension API: code-level plugins loaded from `.aih/extensions/*.mjs`.
 *
 * An extension is a default-exported function receiving a small, typed API:
 *
 *   export default function (aih) {
 *     aih.registerTool({ name, description, kind, parameters, execute });
 *     aih.registerCommand({ name, description, run(args) });   // TUI /name
 *     aih.on("tool:before" | "tool:after" | "turn:end", handler);
 *     aih.log("[extension] …");                                // stderr note
 *   }
 *
 * Handlers may RETURN a value to act:
 *   - "tool:before": { cancel?: string }          → block the call
 *   - "tool:after" : { result?: unknown }         → rewrite the result in place
 * Extensions run in-process with full Node capability — same trust model as
 * the project itself; `--no-extensions` disables loading entirely.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolKind, PermissionAction } from "@aih/core";
import type { ToolRegistry } from "@aih/core";

export interface ExtensionContext {
  cwd: string;
  /** Append to .aih/extensions.log for debugging. */
  log(line: string): void;
}

export interface ExtensionApi {
  registerTool(def: {
    name: string;
    description: string;
    kind?: ToolKind;
    permission?: PermissionAction;
    parameters?: unknown;
    execute(args: unknown, ctx: unknown): Promise<unknown>;
  }): void;
  registerCommand(cmd: { name: string; description?: string; run(args: string): void | Promise<void> }): void;
  on(event: "tool:before" | "tool:after" | "turn:end", handler: (payload: unknown) => unknown): void;
  log(line: string): void;
  readonly cwd: string;
}

export interface LoadedExtension {
  file: string;
  name: string;
}

/** Scan `<cwd>/.aih/extensions` and import every *.mjs module. */
export async function loadExtensions(
  registry: ToolRegistry,
  opts: {
    cwd?: string;
    enabled?: boolean;
    commands?: Map<string, { run(args: string): void | Promise<void> }>;
    onEvent?: (event: string, handler: (payload: unknown) => unknown) => void;
  } = {},
): Promise<LoadedExtension[]> {
  const cwd = opts.cwd ?? process.cwd();
  const dir = join(cwd, ".aih", "extensions");
  if (!opts.enabled || !existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  const loaded: LoadedExtension[] = [];
  const eventHandlers = new Map<string, ((payload: unknown) => unknown)[]>();

  const api: ExtensionApi = {
    cwd,
    log(line) {
      process.stderr.write(`[extension] ${line}\n`);
    },
    registerTool(def) {
      const tool: ToolDefinition = {
        name: def.name,
        description: def.description,
        // Defaults keep extension tools visible & safe-by-confirmation.
        kind: def.kind ?? "read",
        permission: def.permission ?? "ask",
        parameters:
          (def.parameters as ToolDefinition["parameters"]) ??
          ({ type: "object", properties: {} } as ToolDefinition["parameters"]),
        async execute(args, ctx) {
          return def.execute(args, ctx);
        },
      };
      // Same-name registration replaces the built-in but inherits nothing else
      // (registry.register already overwrites by name).
      registry.register(tool);
    },
    registerCommand(cmd) {
      opts.commands?.set(cmd.name, { run: cmd.run });
    },
    on(event, handler) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
  };

  for (const f of files) {
    try {
      const mod = await import(join(dir, f));
      const init = mod.default;
      if (typeof init !== "function") {
        process.stderr.write(`[extension] ${f}: no default function export — skipped\n`);
        continue;
      }
      init(api);
      loaded.push({ file: f, name: f.replace(/\.mjs$/, "") });
    } catch (err) {
      // A broken extension must not kill the session — surface and continue.
      process.stderr.write(
        `[extension] ${f} failed to load: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Wire event handlers through registry hooks so they participate in the
  // same waterfall as audit/redaction.
  if (eventHandlers.size > 0 && opts.onEvent) {
    for (const [event, handlers] of eventHandlers) {
      for (const h of handlers) opts.onEvent(event, h);
    }
  }
  void eventHandlers;
  return loaded;
}

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
import {
  TOOL_ICONS,
  TOOL_TITLE_ARG,
} from "./tui.js";
import type {
  ToolDefinition,
  ToolKind,
  PermissionAction,
  ToolHookInfo,
  ToolInvocationResult,
  ToolHooks,
} from "@aih/core";
import type { ToolRegistry } from "@aih/core";
import { AskError } from "@aih/core";

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
      // P#39② — same-name shadowing inherits the built-in's RENDERING: icon,
      // title-arg and arg formatter fall back to the shadowed built-in so a
      // replacement tool keeps its familiar transcript appearance.
      const inheritedIcon = TOOL_ICONS[def.name];
      const inheritedTitle = TOOL_TITLE_ARG[def.name];
      if (inheritedIcon !== undefined) TOOL_ICONS[def.name] = inheritedIcon;
      if (inheritedTitle !== undefined) TOOL_TITLE_ARG[def.name] = inheritedTitle;
      const tool: ToolDefinition = {
        name: def.name,
        description: def.description,
        // Defaults keep extension tools visible & safe-by-confirmation.
        kind: def.kind ?? "read",
        permission: def.permission ?? "ask",
        parameters:
          (def.parameters as ToolDefinition["parameters"]) ??
          ({ type: "object", properties: {}, required: [] } as ToolDefinition["parameters"]),
        async execute(args, ctx) {
          return def.execute(args, ctx);
        },
      };
      // Same-name registration replaces the built-in (registry.register
      // overwrites by name); rendering inheritance handled above.
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
  return loaded;
}

export interface ExtensionEventBridge {
  /** Register one extension handler (called by loadExtensions via opts.onEvent). */
  on(event: "tool:before" | "tool:after" | "turn:end", handler: (payload: unknown) => unknown): void;
  /** Fire a session-log event (turn:end etc.) to subscribed handlers. */
  emit(event: "turn:end", payload: unknown): void;
}

/**
 * P#39① — result-bearing extension events. The bridge collects extension
 * handlers and exposes them through TWO seams:
 *   - `hookSet()` rides `registry.addHooks` (the same waterfall as audit /
 *     redaction): a "tool:before" handler may return `{ cancel: reason }` to
 *     BLOCK the call; a "tool:after" handler may return `{ result }` to
 *     REWRITE it in place.
 *   - `emit("turn:end", …)` fires from the host when the session log appends
 *     turn/end.
 * Handler exceptions are contained — an extension must never break a turn.
 */
export function createExtensionEventBridge(): ExtensionEventBridge & { hookSet(): ToolHooks } {
  const beforeHandlers: ((p: unknown) => unknown)[] = [];
  const afterHandlers: ((p: unknown) => unknown)[] = [];
  const turnEndHandlers: ((p: unknown) => unknown)[] = [];
  const safeRun = (h: (p: unknown) => unknown, p: unknown, what: string): unknown => {
    try {
      return h(p);
    } catch (err) {
      process.stderr.write(
        `[extension] ${what} handler failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return undefined;
    }
  };
  return {
    on(event, handler) {
      if (event === "tool:before") beforeHandlers.push(handler);
      else if (event === "tool:after") afterHandlers.push(handler);
      else turnEndHandlers.push(handler);
    },
    emit(event, payload) {
      if (event !== "turn:end") return;
      for (const h of turnEndHandlers) safeRun(h, payload, "turn:end");
    },
    hookSet(): ToolHooks {
      return {
        ...(beforeHandlers.length || afterHandlers.length
          ? {
              before: async (info: ToolHookInfo): Promise<void> => {
                for (const h of beforeHandlers) {
                  const r = safeRun(h, info, "tool:before");
                  if (r && typeof r === "object" && r !== null) {
                    const rec = r as Record<string, unknown>;
                    // CC#53 — `{ ask: true }` floors at a human confirmation
                    // (AskError routes to the approval gate) instead of a veto.
                    if ("ask" in rec && rec.ask) {
                      throw new AskError(String(rec.ask === true ? "extension requires confirmation" : rec.ask));
                    }
                    if ("cancel" in rec) {
                      // Cancel semantics ride the existing hook waterfall:
                      // throwing vetoes the call (ToolRegistry before-hook contract).
                      throw new Error(String(rec.cancel ?? "cancelled by extension"));
                    }
                  }
                }
              },
            }
          : {}),
        ...(afterHandlers.length
          ? {
              after: async (info: ToolHookInfo, outcome: ToolInvocationResult) => {
                let out = outcome;
                for (const h of afterHandlers) {
                  const r = safeRun(h, { ...info, result: out.result, ok: out.ok }, "tool:after");
                  if (r && typeof r === "object" && r !== null && "result" in (r as Record<string, unknown>)) {
                    out = { ...out, result: (r as { result: unknown }).result };
                  }
                }
                return out;
              },
            }
          : {}),
      };
    },
  };
}

import type { ApprovalGate } from "./seams/permissions.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolSchema,
} from "./types.js";

export interface ToolInvocationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  permission: "granted" | "denied" | "n/a";
}

const DOOM_LOOP_ASK_AT = 3;
const DOOM_LOOP_DENY_AT = 6;
let hookCallSeq = 0;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface ToolHookInfo {
  name: string;
  args: unknown;
  kind: string;
  turnId?: string;
  /** Unique id for this invocation — lets before/after hooks correlate a call
   *  even under concurrent (parallel read) dispatch. */
  callId: string;
}

export interface ToolHooks {
  before?(info: ToolHookInfo): Promise<void> | void;
  after?(
    info: ToolHookInfo,
    outcome: ToolInvocationResult,
  ): Promise<ToolInvocationResult | void> | ToolInvocationResult | void;
}

export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>();
  #gate: ApprovalGate;
  #callHistory: string[] = [];
  /** set in read-only/plan mode: unknown-tool errors steer the model back to build mode */
  #planHint = false;
  #hookBefore: Array<(info: ToolHookInfo) => Promise<void> | void> = [];
  #hookAfter: Array<
    (info: ToolHookInfo, outcome: ToolInvocationResult) => Promise<ToolInvocationResult | void> | ToolInvocationResult | void
  > = [];

  constructor(gate: ApprovalGate) {
    this.#gate = gate;
  }

  /** Enable the plan/read-only hint on unknown-tool errors (write tools are hidden in this mode). */
  planMode(hint = true): this {
    this.#planHint = hint;
    return this;
  }

  addHooks(hooks: ToolHooks): this {
    if (hooks.before) this.#hookBefore.push(hooks.before);
    if (hooks.after) this.#hookAfter.push(hooks.after);
    return this;
  }

  register(def: ToolDefinition): this {
    if (this.#tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.#tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  schemas(): ToolSchema[] {
    return [...this.#tools.values()].map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }));
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolInvocationResult> {
    const def = this.#tools.get(name);
    if (!def) {
      return {
        ok: false,
        error: this.#planHint
          ? `unknown tool: ${name} — not available in the current read-only (plan) mode; ` +
            `write-capable tools are hidden there. Ask the user to switch to build mode (Tab or \`/mode build\`) to use it.`
          : `unknown tool: ${name}`,
        permission: "n/a",
      };
    }

    const decision =
      typeof def.permission === "function"
        ? def.permission(args)
        : def.permission;

    if (decision === "deny") {
      return { ok: false, error: `permission denied for ${name}`, permission: "denied" };
    }

    const hash = `${name}:${stableStringify(args)}`;
    const repeats = this.#callHistory.filter((h) => h === hash).length;
    if (repeats >= DOOM_LOOP_DENY_AT) {
      return {
        ok: false,
        error: `doom loop guard: identical call to ${name} repeated ${repeats} times — denied. Change approach or ask the user.`,
        permission: "denied",
      };
    }
    const doomLoop = repeats >= DOOM_LOOP_ASK_AT;

    if (decision === "ask" || doomLoop) {
      const approved = await this.#gate.request({
        tool: name,
        kind: def.kind,
        args,
        ...(doomLoop
          ? { reason: `doom_loop: identical call repeated ${repeats} times — continue after repeated failures?` }
          : {}),
      });
      if (!approved) {
        return {
          ok: false,
          error: doomLoop ? "user stopped the repeated (doom-loop) call" : `user rejected ${name}`,
          permission: "denied",
        };
      }
    }

    const hookInfo: ToolHookInfo = {
      name,
      args,
      kind: def.kind,
      ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      callId: `${Date.now().toString(36)}-${(++hookCallSeq).toString(36)}`,
    };

    for (const before of this.#hookBefore) {
      try {
        await before(hookInfo);
      } catch (err) {
        return {
          ok: false,
          error: `hook vetoed ${name}: ${err instanceof Error ? err.message : String(err)}`,
          permission: "denied",
        };
      }
    }

    this.#callHistory.push(hash);
    if (this.#callHistory.length > 100) this.#callHistory.shift();

    let outcome: ToolInvocationResult;
    try {
      const result = await def.execute(args, ctx);
      outcome = { ok: true, result, permission: "granted" };
    } catch (err) {
      outcome = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        permission: "granted",
      };
    }

    for (const after of this.#hookAfter) {
      const next = await after(hookInfo, outcome);
      if (next) outcome = next;
    }

    return outcome;
  }
}

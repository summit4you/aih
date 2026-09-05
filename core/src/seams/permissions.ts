import { dirname, resolve } from "node:path";
import type { PermissionAction } from "../types.js";

export interface ApprovalRequest {
  tool: string;
  kind: "read" | "write";
  args: unknown;
  reason?: string;
  /**
   * CC#60 — provenance of the activity that triggered this request. "tty":
   * a turn started by local keyboard input. "injected": a turn started by
   * serve/attach POST /message or steering queue text. Only "tty" may answer
   * an ask prompt; "injected" requests are auto-denied at the gate.
   */
  source?: "tty" | "injected";
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
}

/**
 * CC#53 — thrown by before-hooks / extension bridges to force a human
 * confirmation for a tool call, regardless of the tool's own permission or the
 * current auto/plan mode. A plain thrown Error vetoes (denies); AskError instead
 * routes to the approval gate's prompt — the "ask" floor.
 */
export class AskError extends Error {
  constructor(message = "requires human confirmation") {
    super(message);
    this.name = "AskError";
  }
}

export class AutoApprove implements ApprovalGate {
  async request(): Promise<boolean> {
    return true;
  }
}

export class DenyAll implements ApprovalGate {
  async request(): Promise<boolean> {
    return false;
  }
}

export class PolicyGate implements ApprovalGate {
  #rules: Array<{
    match: (req: ApprovalRequest) => boolean;
    action: PermissionAction;
  }>;

  constructor(
    rules: Array<{
      match: (req: ApprovalRequest) => boolean;
      action: PermissionAction;
    }>,
  ) {
    this.#rules = rules;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    for (const rule of [...this.#rules].reverse()) {
      if (rule.match(req)) {
        if (rule.action === "allow") return true;
        if (rule.action === "deny") return false;
        break;
      }
    }
    return req.kind === "read";
  }
}

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: "allow" | "ask" | "deny";
}

const PATH_KEYS = ["path", "file", "dir", "directory", "target"] as const;

export function targetOf(req: ApprovalRequest): string | undefined {
  if (req.args == null || typeof req.args !== "object") return undefined;
  const a = req.args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = a[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function matchPattern(pattern: string | undefined, target: string | undefined): boolean {
  if (!pattern || pattern === "*" || pattern === "**") return true;
  if (!target) return false;
  let re = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`${re}$`).test(target);
  } catch {
    return false;
  }
}

export function deriveScope(req: ApprovalRequest): string {
  const target = targetOf(req);
  if (!target) return "*";
  const dir = dirname(resolve(target));
  return `${dir}/**`;
}

export class RulesetGate implements ApprovalGate {
  rules: PermissionRule[] = [];
  #base: ApprovalGate;

  constructor(base: ApprovalGate, initial: PermissionRule[] = []) {
    this.#base = base;
    for (const rule of initial) this.rules.push(rule);
  }

  add(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /**
   * KL-R#3 — build a subagent-scoped gate from an inherited deny set.
   *
   * Kilo semantics (subagent-permissions.ts): the parent's DENY rules and
   * external-directory constraints propagate to the subagent, but the
   * parent's ALLOW rules do NOT — a subagent stands on its own permissions.
   * In AIH's non-interactive subagent there is nobody to answer an "ask"
   * prompt, so write requests resolve to deny (returned as a tool error, the
   * subagent keeps exploring — "拒绝≠终止"), while read requests pass so the
   * subagent can do its research. task/todowrite are excluded by the caller
   * (no recursive delegation).
   */
  static subagentGate(denyOnly: PermissionRule[]): ApprovalGate {
    return new RulesetGate(
      {
        async request(req: ApprovalRequest): Promise<boolean> {
          // No human in the subagent: writes are denied (surfaced as tool
          // errors), reads pass so exploration continues.
          return req.kind === "read";
        },
      },
      denyOnly.map((r) => ({ ...r, action: "deny" as const })),
    );
  }

  /**
   * CC#53 — evaluate the ruleset with a deny > ask > allow priority floor.
   * If ANY matching rule is "deny", the request is denied. Else if ANY is
   * "ask", it must be confirmed by a human (a later "allow" cannot lift this
   * floor). Only when no ask/deny matches does "allow" (or the base) apply.
   */
  evaluate(req: ApprovalRequest): "allow" | "ask" | "deny" | undefined {
    const raw = targetOf(req);
    const abs = raw ? resolve(raw) : undefined;
    let action: "allow" | "ask" | "deny" | undefined;
    for (const rule of this.rules) {
      if (!matchPattern(rule.pattern, raw) && !matchPattern(rule.pattern, abs)) continue;
      const pathScoped = !!rule.pattern && rule.pattern !== "*" && rule.pattern !== "**";
      if (!(pathScoped || rule.tool === req.tool || rule.tool === "*")) continue;
      // Priority floor: deny dominates, then ask, then allow.
      if (rule.action === "deny") action = "deny";
      else if (rule.action === "ask" && action !== "deny") action = "ask";
      else if (rule.action === "allow" && action !== "ask" && action !== "deny") action = "allow";
    }
    return action;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    const action = this.evaluate(req);
    // "ask" floors at a human prompt in the SessionGate (which owns the TUI).
    // Here both "ask" and no-match delegate to the base (auto/deny fallback).
    if (action === "allow") return true;
    if (action === "deny") return false;
    return this.#base.request(req);
  }
}

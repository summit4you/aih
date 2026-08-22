import { dirname, resolve } from "node:path";
import type { PermissionAction } from "../types.js";

export interface ApprovalRequest {
  tool: string;
  kind: "read" | "write";
  args: unknown;
  reason?: string;
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
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
  action: "allow" | "deny";
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

  evaluate(req: ApprovalRequest): "allow" | "deny" | undefined {
    const raw = targetOf(req);
    const abs = raw ? resolve(raw) : undefined;
    let action: "allow" | "deny" | undefined;
    for (const rule of this.rules) {
      if (!matchPattern(rule.pattern, raw) && !matchPattern(rule.pattern, abs)) continue;
      const pathScoped = !!rule.pattern && rule.pattern !== "*" && rule.pattern !== "**";
      if (pathScoped || rule.tool === req.tool || rule.tool === "*") action = rule.action;
    }
    return action;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    const action = this.evaluate(req);
    if (action === "allow") return true;
    if (action === "deny") return false;
    return this.#base.request(req);
  }
}

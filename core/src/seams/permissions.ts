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

/** OCL-R#3 — permission denial diagnostic record (who denied / why / source). */
export interface DenialDiagnostic {
  tool: string;
  reason: string;
  source: "rule" | "gate" | "hook" | "unknown";
  ts: number;
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
  /** OCL-R#3 — optional: record a denial diagnostic (who denied / why / source). */
  diagnose?(d: DenialDiagnostic): void;
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

/**
 * CL-R#5 companion — an INTENTIONAL veto thrown from a before-hook (policy
 * extensions, audit rules). ToolRegistry distinguishes this from an
 * infrastructure crash: a veto blocks the call, a generic Error is skipped
 * (a crashing hook must not break the agent loop).
 */
export class HookVetoError extends Error {
  constructor(message = "blocked by hook") {
    super(message);
    this.name = "HookVetoError";
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
  /**
   * KL-R#5 — provenance of this rule (config file path / "session" / "env").
   * Not part of matching; the gate surfaces it on denials/asks so operators
   * can see WHY a request was allowed or rejected ("denied by
   * .aih/config.json").
   */
  source?: string;
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

export function matchPattern(
  pattern: string | undefined,
  target: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!pattern || pattern === "*" || pattern === "**") return true;
  if (!target) return false;
  // Windows: paths are case-insensitive and `\` == `/` (C:\Users\X and
  // c:/users/x are the same file). Normalize BOTH sides before compiling the
  // regex — otherwise a scope granted via resolve() (uppercase drive `C:\`)
  // never matches a later request built from a lowercase env var (`c:\` or
  // `c:/`), so every new temp filename re-prompts (the reported Windows bug:
  // "every different file in temp needs approval again"). POSIX stays
  // case-sensitive and `/`-only — untouched behavior.
  const norm =
    platform === "win32"
      ? (s: string): string => s.toLowerCase().replaceAll("\\", "/")
      : (s: string): string => s;
  pattern = norm(pattern);
  target = norm(target);
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

/**
 * KL-R#4 — guarded tools: write tools that a config rule must NOT be able to
 * re-open to automatic allow. kilocode calls these "guarded" (bash/task/write/
 * agent_manager/repo_clone) — configuration rules cannot lift them because
 * allow-everything config or a malicious machine-written config would
 * otherwise grant arbitrary execution with no human in the loop.
 *
 * AIH equivalent: the app's own write tools + shell. A rule of "allow" for
 * these still resolves to "ask" (the human floor). Deny stays deny — you may
 * always forbid, you may never auto-allow.
 */
export const GUARDED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "run_cmd",
  "write_file",
  "edit",
  "apply_patch",
  "append_text",
  "patch",
  "permissions",
  "toggle_todo",
  "remove_todo",
  "add_todo",
]);

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
   * KL-R#4 — a "guarded" write tool can never be auto-allowed by a rule: the
   * final result is at most "ask" even when every matching rule says allow
   * (deny still wins).
   */
  evaluate(req: ApprovalRequest): "allow" | "ask" | "deny" | undefined {
    const raw = targetOf(req);
    const abs = raw ? resolve(raw) : undefined;
    let action: "allow" | "ask" | "deny" | undefined;
    // KL-R#4 refinement (2026-09-06) — an EXPLICIT allow rule (config OR a
    // session [g] grant) is a deliberate per-scope decision and must STICK:
    // without this exemption the guarded floor below re-floors every such
    // allow back to "ask", so a configured/granted scope kept prompting on
    // every run_cmd (the reported bug: AIH_GUARDIAN=0 + config `run_cmd *`
    // allow still prompted). The floor's original purpose — preventing
    // AUTO-ALLOW when NO rule matched (base fallback) — is preserved: the
    // floor only fires when action === "allow" came from the base, not from
    // an explicit rule. Deny still dominates everything.
    // KL-R#4 — explicit allow must match BOTH the path AND the tool name (or *).
    // A path-scoped rule for tool "edit" does NOT exempt the guarded floor for
    // a different tool ("write_file") — sibling coverage is preserved, but the
    // floor still applies because the human didn't explicitly allow THIS tool.
    const explicitAllow = this.rules.some(
      (rule) =>
        rule.action === "allow" &&
        (rule.tool === req.tool || rule.tool === "*") &&
        (matchPattern(rule.pattern, raw) || matchPattern(rule.pattern, abs)),
    );
    for (const rule of this.rules) {
      if (!matchPattern(rule.pattern, raw) && !matchPattern(rule.pattern, abs)) continue;
      const pathScoped = !!rule.pattern && rule.pattern !== "*" && rule.pattern !== "**";
      if (!(pathScoped || rule.tool === req.tool || rule.tool === "*")) continue;
      // Priority floor: deny dominates, then ask, then allow.
      if (rule.action === "deny") action = "deny";
      else if (rule.action === "ask" && action !== "deny") action = "ask";
      else if (rule.action === "allow" && action !== "ask" && action !== "deny") action = "allow";
    }
    // KL-R#4 — guarded write tools floor at "ask" ONLY when no explicit allow
    // rule matched (i.e. the "allow" came from the base fallback, not a
    // deliberate config/grant decision). An explicit allow rule (config or
    // session [g] grant) is exempt — it IS the human's deliberate choice.
    // (Deny already dominated above.)
    if (action === "allow" && GUARDED_WRITE_TOOLS.has(req.tool) && req.kind === "write" && !explicitAllow) {
      return "ask";
    }
    return action;
  }

  /**
   * KL-R#5 — the highest-priority matching rule for a request (the one whose
   * action `evaluate` returned). Used by the SessionGate to surface WHERE a
   * decision came from ("denied by ~/.aih/config.json"); undefined when no
   * rule matched (the fallback/base decided).
   */
  explain(req: ApprovalRequest): PermissionRule | undefined {
    const raw = targetOf(req);
    const abs = raw ? resolve(raw) : undefined;
    let winner: PermissionRule | undefined;
    let rank = -1; // 2=deny, 1=ask, 0=allow
    for (const rule of this.rules) {
      if (!matchPattern(rule.pattern, raw) && !matchPattern(rule.pattern, abs)) continue;
      const pathScoped = !!rule.pattern && rule.pattern !== "*" && rule.pattern !== "**";
      if (!(pathScoped || rule.tool === req.tool || rule.tool === "*")) continue;
      const r = rule.action === "deny" ? 2 : rule.action === "ask" ? 1 : 0;
      if (r >= rank) {
        rank = r;
        winner = rule;
      }
    }
    return winner;
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

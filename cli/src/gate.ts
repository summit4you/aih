import { AutoApprove } from "@aih/core";
import type { ApprovalGate, ApprovalRequest, PermissionRule } from "@aih/core";
import { RulesetGate, deriveScope } from "@aih/core";
import { createInterface } from "node:readline";
import { copyToClipboard } from "./clipboard.js";
import { isReadonlyCommand } from "./readonly-allow.js";
import type { Tui } from "./tui.js";

export class DenyGate implements ApprovalGate {
  async request(): Promise<boolean> {
    return false;
  }
}

type ConfirmAnswer = "once" | "always" | "deny";

export class SessionGate implements ApprovalGate {
  #ruleset: RulesetGate;
  #tui: Tui | null = null;
  #persist?: (rule: PermissionRule) => string;
  /** CC#54 — auto-allow provably read-only commands when no explicit rule matched. */
  #autoAllowReadonly: boolean;

  constructor(
    fallback: ApprovalGate,
    initial: PermissionRule[] = [],
    persist?: (rule: PermissionRule) => string,
    autoAllowReadonly = false,
  ) {
    this.#ruleset = new RulesetGate(fallback, initial);
    this.#persist = persist;
    this.#autoAllowReadonly = autoAllowReadonly;
  }

  attachTui(tui: Tui): void {
    this.#tui = tui;
  }

  #remember(req: ApprovalRequest): string {
    const scope = deriveScope(req);
    const rule: PermissionRule = { tool: req.tool, pattern: scope, action: "allow" };
    this.#ruleset.add(rule);
    let saved = "this session only";
    if (this.#persist) {
      try {
        saved = `saved to ${this.#persist(rule)}`;
      } catch {
        saved = "session only (persist failed)";
      }
    }
    return `${req.tool} ${scope} → allow (${saved})`;
  }

  async request(req: ApprovalRequest): Promise<boolean> {
    const action = this.#ruleset.evaluate(req);
    if (action === "allow") return true;
    if (action === "deny") return false;
    // CC#54 — autoAllowReadonly: with no EXPLICIT ruleset decision (undefined
    // = rules never mentioned this tool), a provably read-only command may
    // pass without prompting. Never overrides deny/ask rules — the floor
    // semantics of CC#53 stay intact. Read-kind non-run_cmd tools and
    // whitelist-matching run_cmd commands qualify.
    if (action === undefined && this.#autoAllowReadonly) {
      if (req.kind === "read") return true;
      if (req.tool === "run_cmd" && typeof req.args === "object" && req.args !== null) {
        const cmd = (req.args as { command?: unknown }).command;
        if (typeof cmd === "string" && isReadonlyCommand(cmd)) return true;
      }
    }
    // CC#53 — "ask" floors at a human prompt. This is the floor: auto mode
    // (AutoApprove base) cannot override an ask rule, so we never consult the
    // base here — we always prompt the human.
    // CC#60 — but ONLY keyboard input may answer. A turn injected via
    // serve/attach or the steering queue is message TEXT, not approval; its
    // asks are refused outright (no prompt to spoof, no "yes" in text to count).
    if (req.source === "injected") {
      const note = `${req.tool} needs approval — injected input (serve/steering) cannot approve; run it from the local TTY`;
      if (this.#tui) this.#tui.pushSystem(`[gate] ${note}`);
      return false;
    }
    const detail = `${req.tool} ${JSON.stringify(req.args) ?? ""}`.slice(0, 120);
    const scope = deriveScope(req);

    // IT#5 — run-or-copy for WRITE shell commands: the agent proposes a
    // command; the human picks run / copy / no instead of it auto-running.
    // "copy" puts the command on the clipboard (degrades to printing) and does
    // NOT execute it. Only fires for run_cmd write asks that reach a prompt;
    // read-class + readonly-whitelisted commands already auto-allowed above.
    if (
      req.tool === "run_cmd" &&
      req.kind === "write" &&
      this.#tui &&
      typeof (this.#tui as unknown as { askRunOrCopy?: unknown }).askRunOrCopy === "function"
    ) {
      const command =
        typeof (req.args as { command?: unknown })?.command === "string"
          ? (req.args as { command: string }).command
          : detail;
      const choice = await (this.#tui as unknown as { askRunOrCopy(c: string, s: string): Promise<"run" | "copy" | "no"> }).askRunOrCopy(command, scope);
      if (choice === "run") {
        this.#tui.pushSystem("▶ approved — running");
        return true;
      }
      if (choice === "copy") {
        const res = copyToClipboard(command);
        if (res.ok) {
          this.#tui.pushSystem(`⧉ copied to clipboard (${res.via}): ${command}`);
        } else {
          // No clipboard available — degrade to printing so the user can paste
          // it manually (the spec's fallback path).
          this.#tui.pushSystem(`no clipboard — command to copy:\n  ${command}`);
        }
        return false; // copy never runs the command
      }
      this.#tui.pushSystem("denied");
      return false; // "no"
    }

    let answer: ConfirmAnswer;
    if (this.#tui) {
      answer = await this.#tui.askConfirm(detail, scope);
    } else {
      answer = await this.#readlineAsk(detail, scope);
    }
    if (answer === "always") {
      const line = `remembered: ${this.#remember(req)}`;
      if (this.#tui) this.#tui.pushSystem(line);
      else process.stderr.write(`${line}\n`);
    }
    return answer !== "deny";
  }

  #readlineAsk(detail: string, scope: string): Promise<ConfirmAnswer> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
      rl.question(`approve ${detail}? [y]es / [n]o / [a]lways ${scope} `, (ans) => {
        rl.close();
        const a = ans.trim().toLowerCase();
        resolve(a === "y" ? "once" : a === "a" ? "always" : "deny");
      });
    });
  }
}

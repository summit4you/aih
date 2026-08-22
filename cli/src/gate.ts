import { AutoApprove } from "@aih/core";
import type { ApprovalGate, ApprovalRequest, PermissionRule } from "@aih/core";
import { RulesetGate, deriveScope } from "@aih/core";
import { createInterface } from "node:readline";
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

  constructor(
    fallback: ApprovalGate,
    initial: PermissionRule[] = [],
    persist?: (rule: PermissionRule) => string,
  ) {
    this.#ruleset = new RulesetGate(fallback, initial);
    this.#persist = persist;
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
    const detail = `${req.tool} ${JSON.stringify(req.args) ?? ""}`.slice(0, 120);
    const scope = deriveScope(req);
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

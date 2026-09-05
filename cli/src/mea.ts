/**
 * MEA 判定层（Manager/Executor/Auditor）— 独立判定角色融合实现。
 *
 * 混合双源：
 *  - codex Guardian（CX-R#1）——「写动作独立审核」：需批准（ask）的写操作由
 *    独立无工具 LLM 按声明式 policy 评估 risk×authorization → allow/deny，
 *    fail-closed（超时/解析失败→deny）+ circuit breaker（连续 deny 中断 turn）。
 *  - LongHorizon Auditor（LH#1/LH#2）——「完成产物审计」：agent 声称 done 时由
 *    独立 LLM + 只读探查检查真实产物，产出 AuditReport；只有通过独立验证的
 *    状态才成为 trusted state（verified-state ledger）。
 *
 * 机制层：本文件放解析、policy、fail-closed、circuit-breaker 等纯逻辑（可单测）；
 * LLM 注入与 gate/agent-loop 接线在调用方。默认开启时若无可用的 LLM 适配器，
 * 所有审核 fail-closed 到「人工确认」（降级而非 fallback，见 APP.md 信任模型）。
 */

import type { ApprovalRequest, LLMAdapter } from "@aih/core";

/* ------------------------------------------------------------------ *
 * 1. Guardian —— 写动作独立审核（CX-R#1 + CX-R#3）
 * ------------------------------------------------------------------ */

export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
export type GuardianAuthorization = "unknown" | "low" | "medium" | "high";
export type GuardianOutcome = "allow" | "deny" | "ask";

export interface GuardianAssessment {
  risk_level: GuardianRiskLevel;
  user_authorization: GuardianAuthorization;
  outcome: GuardianOutcome;
  rationale: string;
}

/** 低风险时 Guardian 可只回 `{"outcome":"allow"}`（对齐 codex 的简化分支）。 */
export function parseGuardianAssessment(text: string): GuardianAssessment {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("guardian assessment: no JSON object found");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`guardian assessment: malformed JSON — ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("guardian assessment: not an object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.outcome !== "string") {
    throw new Error("guardian assessment: missing 'outcome'");
  }
  const outcome = o.outcome as GuardianOutcome;
  if (outcome !== "allow" && outcome !== "deny" && outcome !== "ask") {
    throw new Error(`guardian assessment: invalid outcome '${o.outcome}'`);
  }
  const normalize = <T extends string>(v: unknown, allowed: readonly T[], key: string): T => {
    if (v === undefined || v === null) return allowed[0];
    const s = String(v).toLowerCase() as T;
    return (allowed as readonly string[]).includes(s) ? s : allowed[0];
  };
  return {
    outcome,
    risk_level: normalize(o.risk_level, ["low", "medium", "high", "critical"], "risk_level"),
    user_authorization: normalize(
      o.user_authorization,
      ["unknown", "low", "medium", "high"],
      "user_authorization",
    ),
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}

/** 识别「仅 outcome」的简化响应。 */

/**
 * 声明式 policy 注入模板。占位符 {{ policy }} 由调用方替换为其 policy.md。
 * 对齐 codex：明确告知 Guardian「不要假设缺失上下文是安全的」。
 */
export const GUARDIAN_POLICY_TEMPLATE = `You are an independent write-action approval reviewer (Guardian), NOT the main agent.

An agent wants to perform the following action:
{{ action }}

Policy:
{{ policy }}

Rules:
- Evaluate the action strictly against the policy. Assess risk_level (low/medium/high/critical)
  and the strength of user_authorization (unknown/low/medium/high).
- Output STRICT JSON only, no prose:
  {"risk_level":"<low|medium|high|critical>","user_authorization":"<unknown|low|medium|high>","outcome":"<allow|deny|ask>","rationale":"<one sentence>"}
- Truncated/absent context is NOT safe — assume the worst for anything you cannot see.
- If you cannot confidently allow, output "deny" or "ask". Deny if the action could
  bypass policy or is destructive without explicit authorization.`;

/** 默认内置 policy（无显式 policy.md 时使用，本地确定性白名单为纲）。 */
export const DEFAULT_GUARDIAN_POLICY = `Destructive actions (delete, overwrite, formatting, credential/secret handling) are HIGH/critical risk and require strong user authorization.
Actions touching files outside the workspace are forbidden unless explicitly authorized.
Credential-probing, exfiltration, or policy-circumvention actions are DENIED.
Routine build/test/read of the workspace is low risk.`;

/** deny 后注入「不得规避达成同一结果」（对齐 codex GUARDIAN_REJECTION_INSTRUCTIONS）。 */
export const GUARDIAN_CIRCUMVENTION_NOTICE =
  "The agent must not attempt to achieve the same outcome via workaround, indirect " +
  "execution, or policy circumvention. Proceed only with a materially safer " +
  "alternative, or if the user explicitly approves the action after being informed " +
  "of the risk. Otherwise, stop and request user input.";

/** fail-closed：超时时间（ms），对齐 codex 90s。 */
export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;
/** circuit breaker：单个 turn 内连续 deny 上限，对齐 codex MAX_CONSECUTIVE=3。 */
export const GUARDIAN_MAX_CONSECUTIVE_DENIALS = 3;

export interface GuardianReviewResult {
  assessment?: GuardianAssessment;
  /** "allow" | "deny" | "ask" | "error"（fail-closed）| "timeout"（fail-closed） */
  decision: GuardianOutcome | "error" | "timeout";
  /** fail-closed / circuit-breaker 的说明。 */
  meta?: string;
  elapsedMs?: number;
}

/**
 * 运行一次 Guardian 独立审核（无工具 LLM 调用）。失败/超时 fail-closed。
 * onOpen 传入真实的 LLM 请求前后钩子（用于 debug / 事件落盘）。
 */
export async function runGuardianReview(opts: {
  llm: LLMAdapter;
  action: string;
  policy?: string;
  timeoutMs?: number;
}): Promise<GuardianReviewResult> {
  const policy = opts.policy ?? DEFAULT_GUARDIAN_POLICY;
  const timeoutMs = opts.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS;
  const prompt = GUARDIAN_POLICY_TEMPLATE
    .replace("{{ action }}", opts.action)
    .replace("{{ policy }}", policy);
  const started = Date.now();
  try {
    const resp = await withTimeout(
      opts.llm.complete({ messages: [{ role: "user", content: prompt }], tools: [] }),
      timeoutMs,
      "guardian timed out",
    );
    try {
      const assessment = parseGuardianAssessment(resp.text);
      return {
        assessment,
        decision: assessment.outcome,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      // fail-closed：malformed → deny
      return {
        decision: "deny",
        meta: `malformed assessment: ${(err as Error).message}`,
        elapsedMs: Date.now() - started,
      };
    }
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return timedOut
      ? { decision: "timeout", meta: `guardian timed out after ${timeoutMs}ms`, elapsedMs: timeoutMs }
      : { decision: "error", meta: `guardian error: ${(err as Error).message}`, elapsedMs: Date.now() - started };
  }
}

/** 把 promise 包上超时；超时抛 name="TimeoutError"。 */
async function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      const e = new Error(why);
      e.name = "TimeoutError";
      rej(e);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Circuit breaker（对齐 codex GuardianRejectionCircuitBreaker）：
 * 每 turn 连续 deny 达阈值即中断（受保护动作清零）。跨 turn 记录通过 reset() 隔离。
 */
export class GuardianCircuitBreaker {
  #consecutive = 0;

  /** 记录一次 deny（连续计数+1）。返回是否应中断 turn。 */
  recordDenial(): boolean {
    this.#consecutive += 1;
    return this.#consecutive >= GUARDIAN_MAX_CONSECUTIVE_DENIALS;
  }

  /** 非 deny 裁决（allow/ask 通过）重置连续计数。 */
  recordPass(): void {
    this.#consecutive = 0;
  }

  get consecutive(): number {
    return this.#consecutive;
  }

  /** 新 turn 开始调用，隔离历史计数。 */
  reset(): void {
    this.#consecutive = 0;
  }
}

/** 把 approval request 渲染成 Guardian 可见的动作描述。 */
export function describeAction(req: ApprovalRequest): string {
  const args = req.args && typeof req.args === "object"
    ? JSON.stringify(req.args)
    : String(req.args ?? "");
  const target = (() => {
    if (req.args && typeof req.args === "object") {
      const a = req.args as Record<string, unknown>;
      for (const k of ["path", "file", "dir", "directory", "target"]) {
        if (typeof a[k] === "string" && a[k].length) return a[k];
      }
    }
    return undefined;
  })();
  const lines = [`tool: ${req.tool}`, `kind: ${req.kind}`];
  if (target) lines.push(`target: ${target}`);
  if (args) lines.push(`args: ${args}`);
  if (req.reason) lines.push(`reason: ${req.reason}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 2. Auditor —— 完成产物审计（LH#1 + LH#2）
 * ------------------------------------------------------------------ */

export type AuditStatus = "complete" | "incomplete" | "blocked";

export interface AuditReport {
  status: AuditStatus;
  /** 真实产物完整性：0-1 */
  integrity: number;
  /** 契约对齐：true=与验收条件对齐 */
  contract_aligned: boolean;
  completed: string[];
  missing: string[];
  blockers: string[];
  findings: string[];
}

/** 解析 AuditReport 三行控制头 + 列表。宽松：缺列表给空数组。 */
export function parseAuditReport(text: string): AuditReport {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("audit report: no JSON object found");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`audit report: malformed JSON — ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("audit report: not an object");
  }
  const o = parsed as Record<string, unknown>;
  const status = String(o.status ?? "incomplete").toLowerCase() as AuditStatus;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    status: status === "complete" || status === "blocked" ? status : "incomplete",
    integrity: typeof o.integrity === "number" ? Math.max(0, Math.min(1, o.integrity)) : 0,
    contract_aligned: o.contract_aligned === true,
    completed: strList(o.completed),
    missing: strList(o.missing),
    blockers: strList(o.blockers),
    findings: strList(o.findings),
  };
}

export const AUDITOR_PROMPT_TEMPLATE = `You are an independent completion auditor (Auditor), NOT the main agent.

The agent claims the following task/goal is done:
"""{{ goal }}"""

Independently assess, based ONLY on real evidence you are given, whether the goal is genuinely met.

Verified evidence (already gathered from real state — the agent's own claims are NOT evidence):
{{ evidence }}

Rules:
- Output STRICT JSON only: {"status":"<complete|incomplete|blocked>","integrity":<0-1>,"contract_aligned":<true|false>,"completed":[...],"missing":[...],"blockers":[...],"findings":[...]}
- "complete" ONLY if all acceptance criteria are backed by verified evidence.
- List concrete missing artifacts / unmet criteria in "missing"; anything blocking in "blockers".
- Be skeptical: absence of evidence equals not-done.`;

/**
 * verified-state ledger —— 记录「已被独立验证」的真实状态（LH 只把通过验证的
 * 状态当作 trusted state）。审计前由调用方采集真实产物（文件内容/命令输出/
 * state.todos 快照等），作为 Auditor 的证据，杜绝 agent 自述。
 */
export class VerifiedStateLedger {
  #entries: Array<{ key: string; value: string; source: string; ts: number }> = [];

  /** 追加一条已验证的真实状态条目。 */
  add(key: string, value: string, source = "read"): void {
    this.#entries.push({ key, value, source, ts: Date.now() });
  }

  get entries(): ReadonlyArray<{ key: string; value: string; source: string; ts: number }> {
    return this.#entries;
  }

  /** 渲染成 Auditor 提示中的证据块（去重、截断到 token 预算内）。 */
  render(maxChars = 8000): string {
    const seen = new Set<string>();
    const out: string[] = [];
    let used = 0;
    for (const e of this.#entries) {
      const block = `- [${e.source}] ${e.key}: ${e.value}`;
      if (seen.has(block)) continue;
      seen.add(block);
      if (used + block.length > maxChars) {
        out.push(`- …(more evidence truncated)`);
        break;
      }
      out.push(block);
      used += block.length;
    }
    return out.join("\n") || "(no verified evidence gathered)";
  }

  clear(): void {
    this.#entries = [];
  }
}

export interface RunAuditOptions {
  llm: LLMAdapter;
  goal: string;
  ledger: VerifiedStateLedger;
  timeoutMs?: number;
}

export interface AuditOutcome {
  report: AuditReport;
  /** true=产物通过独立审计（trusted state） */
  passed: boolean;
  meta?: string;
}

/** 运行一次完成产物审计：独立 LLM + verified 证据。失败 fail-closed → incomplete。 */
export async function runAudit(opts: RunAuditOptions): Promise<AuditOutcome> {
  const timeoutMs = opts.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS;
  const prompt = AUDITOR_PROMPT_TEMPLATE
    .replace("{{ goal }}", opts.goal)
    .replace("{{ evidence }}", opts.ledger.render());
  try {
    const resp = await withTimeout(
      opts.llm.complete({ messages: [{ role: "user", content: prompt }], tools: [] }),
      timeoutMs,
      "auditor timed out",
    );
    const report = parseAuditReport(resp.text);
    const passed =
      report.status === "complete" && report.contract_aligned === true && report.integrity >= 0.9;
    return { report, passed, meta: resp.text.length ? undefined : "empty audit response" };
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return {
      report: {
        status: "incomplete",
        integrity: 0,
        contract_aligned: false,
        completed: [],
        missing: [],
        blockers: [timedOut ? `auditor timed out after ${timeoutMs}ms` : `auditor error: ${(err as Error).message}`],
        findings: ["audit could not be completed — treated as incomplete"],
      },
      passed: false,
      meta: timedOut ? "timeout" : "error",
    };
  }
}

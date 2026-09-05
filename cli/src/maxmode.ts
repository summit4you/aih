/**
 * P2#9 — Max Mode: parallel subagents + best-of-N judge.
 *
 * `best_of_n` runs N independent subagents (own context, bounded concurrency
 * via AIH_TOOL_CONCURRENCY) on the same prompt in parallel, then a single
 * no-tools LLM judge call picks the best answer. Mirrors the `task` subagent
 * primitive (E#18) and the goal-judge pattern (P0#3).
 *
 * Zero new dependencies: core AgentLoop/ToolRegistry + a small ordered
 * concurrency pool.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalGate, LLMAdapter, ToolHooks, ToolRegistry } from "@aih/core";
import { AgentLoop, SessionLog, ToolRegistry as Registry } from "@aih/core";
import { makeSubagentGate } from "./gate.js";

export interface SubagentOptions {
  gate: ApprovalGate;
  llm: LLMAdapter;
  toolsProvider: () => ToolRegistry | undefined;
  hooks?: ToolHooks;
  /** max steps per subagent (default 8, same as `task`) */
  maxSteps?: number;
  /** working dir for spilling over-length answers (default ".") */
  cwd?: string;
}

export interface SubagentResult {
  answer: string;
  steps: number;
  stopReason: string;
  /** FB#5 — true when the answer was capped to fit the parent context. */
  truncated?: boolean;
  /** FB#5 — where the FULL answer was spilled (present when `truncated`). */
  fullOutputPath?: string;
}

/**
 * FB#5 — subagent answer cap. A subagent's final answer is what lands in the
 * PARENT's context; an unbounded one can blow it up with process noise. Cap the
 * answer to `cap` chars; the full text is spilled to `.aih/outputs/` and the
 * capped answer points at it. `cap <= 0` disables capping.
 */
export interface CappedAnswer {
  answer: string;
  truncated: boolean;
  fullOutputPath?: string;
}
export function capAnswer(raw: string, cap: number, cwd = "."): CappedAnswer {
  if (cap <= 0 || raw.length <= cap) return { answer: raw, truncated: false };
  const dir = join(cwd, ".aih", "outputs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `subagent-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(file, raw, "utf8");
  return {
    answer: `${raw.slice(0, cap)}\n…[truncated, full output at ${file}]`,
    truncated: true,
    fullOutputPath: file,
  };
}
/** FB#5 — effective cap from AIH_SUBAGENT_ANSWER_CAP (default 8000; 0 = off). */
export function answerCapLimit(): number {
  // Distinguish "unset" (→ default 8000) from an explicit value (0 = off).
  const raw = process.env.AIH_SUBAGENT_ANSWER_CAP;
  if (raw === undefined || raw.trim() === "") return 8000;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 8000;
}

/**
 * Run one isolated subagent on `prompt` (same shape as the `task` tool):
 * own SessionLog + registry (task/question/best_of_n excluded to prevent
 * recursion), shared permission gate, bounded steps, returns the final
 * assistant answer.
 */
export async function runSubagent(o: SubagentOptions, prompt: string): Promise<SubagentResult> {
  const parent = o.toolsProvider();
  if (!parent) throw new Error("subagent has no parent tool registry");
  // KL-R#3 — subagent permission inheritance (see makeSubagentGate): parent's
  // DENY rules propagate, ALLOW/ask do not; writes resolve to deny (no human
  // inside the subagent) and the subagent keeps exploring.
  const sub = new Registry(makeSubagentGate(o.gate));
  for (const schema of parent.schemas()) {
    // KL-R#3 — same recursion guard as the task tool: no delegation, no
    // rewriting the parent's todo state from inside a subagent.
    if (schema.name === "task" || schema.name === "question" || schema.name === "best_of_n" || schema.name === "todowrite") continue;
    const def = parent.get(schema.name);
    if (def) sub.register(def);
  }
  if (o.hooks) sub.addHooks(o.hooks);
  const log = new SessionLog();
  const loop = new AgentLoop({
    llm: o.llm,
    tools: sub,
    log,
    systemPrompt:
      "You are a focused subagent of the AIH harness. Complete the assigned task with the available " +
      "tools and finish with one concise final answer covering what was done and key findings.",
    maxStepsPerTurn: o.maxSteps ?? 8,
  });
  const result = await loop.send(prompt);
  const lastAssistant = [...log.all()]
    .reverse()
    .find((e) => e.type === "assistant/message" && (e as { text?: string }).text);
  const rawAnswer = lastAssistant ? String((lastAssistant as { text: string }).text) : "(no final answer)";
  // FB#5 — cap the answer that re-enters the parent context; spill the full
  // text to .aih/outputs/ and point the capped answer at it.
  const capped = capAnswer(rawAnswer, answerCapLimit(), o.cwd ?? ".");
  return {
    answer: capped.answer,
    steps: result.steps,
    stopReason: result.stopReason,
    ...(capped.truncated ? { truncated: true, fullOutputPath: capped.fullOutputPath } : {}),
  };
}

/**
 * Bounded-concurrency pool: run `jobs` with at most `limit` in flight;
 * results are returned in input order regardless of completion order.
 */
export async function mapOrdered<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * FB#6 — parse the goal judge's strict-JSON verdict
 * `{"met": bool, "reason": "...", "unmet": [...]}`. Regex fallback covers the
 * minimal schema when the JSON is malformed. Shared by the `run --goal` loop
 * and the TUI goal check so both parse identically.
 */
export interface GoalVerdict {
  met: boolean;
  reason: string;
  unmet: string[];
}
export function parseGoalVerdict(text: string): GoalVerdict {
  const met = /"met"\s*:\s*(true|false)/.exec(text)?.[1] === "true";
  const reason = /"reason"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 200);
  let unmet: string[] = [];
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (Array.isArray(parsed?.unmet)) unmet = parsed.unmet.map(String).slice(0, 5);
  } catch {
    /* regex fallback above covers the minimal schema */
  }
  return { met, reason, unmet };
}

/**
 * Parse the judge's strict-JSON verdict `{"best": k, "reason": "..."}`.
 * Out-of-range / missing indices fall back to 0 (caller re-validates
 * against the successful candidates).
 */
export function parseJudgeVerdict(text: string, n: number): { best: number; reason: string } {
  const m = /"best"\s*:\s*(\d+)/.exec(text);
  let best = m ? Number(m[1]) : 0;
  if (!Number.isInteger(best) || best < 0 || best >= n) best = 0;
  const reason = /"reason"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 200);
  return { best, reason };
}

export interface Candidate {
  index: number;
  ok: boolean;
  answer: string;
  steps: number;
  stopReason: string;
  error?: string;
}

export interface BestOfNResult {
  description: string;
  n: number;
  concurrency: number;
  candidates: Candidate[];
  /** 0-based index of the chosen candidate (-1 when all failed) */
  best: number;
  judgeReason: string;
  answer: string;
  /** Per-candidate strategy prompts (multi-strategy mode; absent = all same prompt). */
  strategies?: string[];
  /**
   * Set when the verdict did not come from a clean single-judge call: the
   * primary judge failed and the fallback judge decided, or a second judge
   * was consulted and disagreed (primary's pick kept). Never silent — the
   * panel degrading to one opinion is a fact the caller should see.
   */
  judgeDegraded?: boolean;
}

/**
 * Run N parallel subagents and let a judge pick the best answer.
 * Concurrency is capped by AIH_TOOL_CONCURRENCY (default 4) so a large N
 * never floods the provider.
 *
 * Multi-strategy mode (Freebuff `editor-multi-prompt` /
 * `code-reviewer-multi-prompt` parity): pass `prompts` and candidate `i`
 * works on `prompts[i % prompts.length]` — N different implementation
 * strategies explore a wider solution space than N samples of one prompt.
 * Without `prompts`, every candidate gets the same `prompt` (original
 * best-of-N sampling behavior).
 */
export async function bestOfN(
  opts: SubagentOptions,
  prompt: string,
  n = 3,
  description = "",
  prompts?: string[],
  /**
   * Optional second judge (Freebuff BuffBench parity). Runs in PARALLEL with
   * the primary (opts.llm); the primary's pick is kept (median of two). A
   * disagreement or a failed judge is flagged (`judgeDegraded`) and warned —
   * a silently-dropped judge would turn the panel into one opinion. Absent →
   * single-judge behavior (unchanged).
   */
  judge2?: LLMAdapter,
): Promise<BestOfNResult> {
  const strategies = prompts && prompts.length > 0 ? prompts : undefined;
  // Multi-strategy mode: each candidate still gets the SHARED task context,
  // plus its own strategy direction (the strategy refines, it does not
  // replace the task). Single-prompt mode: the prompt as-is.
  const strategyFor = (i: number): string =>
    strategies
      ? `${prompt}\n\nStrategy for this run: ${strategies[i % strategies.length] ?? ""}`
      : prompt;
  const cap = Math.max(1, Number(process.env.AIH_TOOL_CONCURRENCY ?? "") || 4);
  const limit = Math.min(n, cap);
  const candidates: Candidate[] = await mapOrdered(
    Array.from({ length: n }, (_, i) => async () => {
      try {
        const r = await runSubagent(opts, strategyFor(i));
        return { index: i, ok: true, answer: r.answer, steps: r.steps, stopReason: r.stopReason };
      } catch (err) {
        return {
          index: i,
          ok: false,
          answer: "",
          steps: 0,
          stopReason: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
    limit,
  );

  const base = { description, n, concurrency: limit, candidates, ...(strategies ? { strategies } : {}) };
  const okIdx = candidates.filter((c) => c.ok).map((c) => c.index);
  if (okIdx.length === 0) {
    return { ...base, best: -1, judgeReason: "all candidates failed", answer: "" };
  }
  if (okIdx.length === 1) {
    const c = candidates[okIdx[0]];
    return { ...base, best: c.index, judgeReason: "only one candidate succeeded", answer: c.answer };
  }

  // Judge: one no-tools LLM call picks the best index (same pattern as /goal).
  // CC#50 — annotate partial candidates so the judge does not prefer a
  // truncated-but-looks-complete answer over a genuinely finished one.
  // Multi-strategy mode: label each candidate with the strategy it was asked
  // to follow, so the judge can weigh "right approach" as well as "right answer".
  const strategyLine = (i: number): string =>
    strategies ? ` [strategy: ${strategies[i % strategies.length] ?? ""}]\n` : "\n";
  const body = okIdx
    .map((i) => {
      const c = candidates[i];
      const flag = c.stopReason === "end_turn" ? "" : "[PARTIAL — subagent did not finish; treat as incomplete]\n";
      return `### Candidate ${i}${strategyLine(i)}${flag}${c.answer}`;
    })
    .join("\n\n");
  const judgeReq = {
    messages: [
      {
        role: "user" as const,
        content:
          `You are the judge for a best-of-N run. The task was:\n\n${prompt}\n\n` +
          `Independent subagents produced these candidate answers:\n\n${body}\n\n` +
          `Pick the single best answer for the task. Respond with STRICT JSON only: ` +
          `{"best": <0-based index>, "reason": "<one sentence>"}`,
      },
    ],
    tools: [],
  };
  // Two-judge panel (Freebuff BuffBench parity): primary = opts.llm, optional
  // second judge cross-checks. A silently-dropped judge would turn the panel
  // into one opinion — so every degraded path is flagged (judgeDegraded) and
  // warned on stderr.
  const panel = await judgePanel(
    opts.llm,
    judgeReq,
    (text) => parseJudgeVerdict(text, n),
    judge2,
    "best_of_n",
    (a, b) => a.best === b.best,
  );
  const primary = panel.verdict;
  const second = panel.second;
  // The judge may name a failed/out-of-range candidate — fall back to the
  // first successful one.
  const chosen = candidates[primary.best] && candidates[primary.best].ok ? primary.best : okIdx[0];
  const judgeReason = panel.degraded
    ? `[judge panel degraded — single opinion or disagreement, primary kept] ${primary.reason}`
    : second
      ? `[both judges agree] ${primary.reason}`
      : primary.reason;
  return { ...base, best: chosen, judgeReason, answer: candidates[chosen].answer, ...(panel.degraded ? { judgeDegraded: true } : {}) };
}

/**
 * Two-judge panel (Freebuff BuffBench parity). Runs the primary and optional
 * secondary judges in PARALLEL (Promise.allSettled), keeps the PRIMARY's
 * verdict (the median of two), and never lets a judge silently drop out — a
 * dropped judge turns the panel into a single opinion. Every degraded path
 * (disagreement, one judge failed) is returned as `degraded: true` AND warned
 * on stderr. `secondary === undefined` → single-judge mode (unchanged).
 *
 * Generic over the verdict shape so both `best_of_n` (`{best,reason}`) and the
 * goal judge (`{met,reason,unmet}`) share the same panel discipline.
 */
export async function judgePanel<V>(
  primary: LLMAdapter,
  req: Parameters<LLMAdapter["complete"]>[0],
  parse: (text: string) => V,
  secondary?: LLMAdapter,
  label = "judge",
  same: (a: V, b: V) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
): Promise<{ verdict: V; second?: V; degraded: boolean }> {
  if (!secondary) {
    const resp = await primary.complete(req);
    return { verdict: parse(resp.text), degraded: false };
  }
  const [p, s] = await Promise.allSettled([primary.complete(req), secondary.complete(req)]);
  const reason = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "unknown";
  if (p.status === "fulfilled" && s.status === "fulfilled") {
    const verdict = parse(p.value.text);
    const second = parse(s.value.text);
    const degraded = !same(verdict, second);
    if (degraded) {
      process.stderr.write(`warning: ${label} panel — the two judges disagreed; keeping the primary's verdict\n`);
    }
    return { verdict, second, degraded };
  }
  if (p.status === "fulfilled") {
    process.stderr.write(`warning: ${label} panel — secondary judge failed (${reason(s)}); verdict rests on a single judge\n`);
    return { verdict: parse(p.value.text), degraded: true };
  }
  if (s.status === "fulfilled") {
    process.stderr.write(`warning: ${label} panel — primary judge failed (${reason(p)}); verdict rests on the secondary judge\n`);
    return { verdict: parse(s.value.text), degraded: true };
  }
  throw new Error(`${label} panel: both judges failed: ${reason(p)} / ${reason(s)}`);
}

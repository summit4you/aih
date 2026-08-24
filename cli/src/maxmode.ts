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
import type { ApprovalGate, LLMAdapter, ToolHooks, ToolRegistry } from "@aih/core";
import { AgentLoop, SessionLog, ToolRegistry as Registry } from "@aih/core";

export interface SubagentOptions {
  gate: ApprovalGate;
  llm: LLMAdapter;
  toolsProvider: () => ToolRegistry | undefined;
  hooks?: ToolHooks;
  /** max steps per subagent (default 8, same as `task`) */
  maxSteps?: number;
}

export interface SubagentResult {
  answer: string;
  steps: number;
  stopReason: string;
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
  const sub = new Registry(o.gate);
  for (const schema of parent.schemas()) {
    if (schema.name === "task" || schema.name === "question" || schema.name === "best_of_n") continue;
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
  const answer = lastAssistant ? String((lastAssistant as { text: string }).text) : "(no final answer)";
  return { answer, steps: result.steps, stopReason: result.stopReason };
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
}

/**
 * Run N parallel subagents on `prompt` and let a judge pick the best answer.
 * Concurrency is capped by AIH_TOOL_CONCURRENCY (default 4) so a large N
 * never floods the provider.
 */
export async function bestOfN(
  opts: SubagentOptions,
  prompt: string,
  n = 3,
  description = "",
): Promise<BestOfNResult> {
  const cap = Math.max(1, Number(process.env.AIH_TOOL_CONCURRENCY ?? "") || 4);
  const limit = Math.min(n, cap);
  const candidates: Candidate[] = await mapOrdered(
    Array.from({ length: n }, (_, i) => async () => {
      try {
        const r = await runSubagent(opts, prompt);
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

  const base = { description, n, concurrency: limit, candidates };
  const okIdx = candidates.filter((c) => c.ok).map((c) => c.index);
  if (okIdx.length === 0) {
    return { ...base, best: -1, judgeReason: "all candidates failed", answer: "" };
  }
  if (okIdx.length === 1) {
    const c = candidates[okIdx[0]];
    return { ...base, best: c.index, judgeReason: "only one candidate succeeded", answer: c.answer };
  }

  // Judge: one no-tools LLM call picks the best index (same pattern as /goal).
  const body = okIdx.map((i) => `### Candidate ${i}\n${candidates[i].answer}`).join("\n\n");
  const resp = await opts.llm.complete({
    messages: [
      {
        role: "user",
        content:
          `You are the judge for a best-of-N run. The task was:\n\n${prompt}\n\n` +
          `Independent subagents produced these candidate answers:\n\n${body}\n\n` +
          `Pick the single best answer for the task. Respond with STRICT JSON only: ` +
          `{"best": <0-based index>, "reason": "<one sentence>"}`,
      },
    ],
    tools: [],
  });
  const { best, reason } = parseJudgeVerdict(resp.text, n);
  // The judge may name a failed/out-of-range candidate — fall back to the
  // first successful one.
  const chosen = candidates[best] && candidates[best].ok ? best : okIdx[0];
  return { ...base, best: chosen, judgeReason: reason, answer: candidates[chosen].answer };
}

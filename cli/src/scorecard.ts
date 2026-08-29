/**
 * PE#3 — harness health scorecard (Production Agent Engineering playbook).
 *
 * The playbook's core metric: "Do not count model calls, tokens, or messages.
 * Count completed tasks that required no manual intervention and still produced
 * acceptable evidence." A system is improving when completion rises while
 * rework, unnecessary approvals, cost per completed task, and recovery time fall.
 *
 * All functions are pure over the session event log (+ optional memory text) so
 * they are unit-testable without a live LLM — the same discipline as cost.ts.
 * No new storage: the data source is the existing append-only session log, so
 * the zero-dependency / offline stance is preserved.
 */
import type { SessionEvent } from "@aih/core";
import type { ModelPrice } from "./cost.js";
import { aggregateUsage, costForUsage, fmtCost } from "./cost.js";

export interface ScorecardOptions {
  /** Resolved price for the active model (from cost.ts). Absent → cost metrics 0. */
  price?: ModelPrice;
  /**
   * Raw text of the project memory file (.aih/memory.md). Used to count dated
   * guide entries (one dated line ≈ one past-failure converted into a rule, the
   * playbook's guide-growth signal). Absent/undefined → guide growth 0.
   */
  memoryText?: string;
}

export interface ScorecardMetrics {
  /** Distinct user turns observed (turn/start). */
  started: number;
  /** Turns that produced a verified result (goal/judge met). */
  verified: number;
  /** goal/judge met count (a turn may have several; last one wins for verified). */
  goalMet: number;
  /** goal/judge unmet count (auto-continue). */
  goalUnmet: number;
  /** tool/result failures (rework signal). */
  rework: number;
  /** Explicit escalations (escalate event, PE#4). */
  escalations: number;
  /** tool/result failures that were later followed by a passing call (recovered). */
  recovered: number;
  /** tool/result failures never followed by a passing call (unrecovered). */
  unrecovered: number;
  /** Max ms from a failed tool call to the next passing one (recovery time). */
  recoveryMs: number;
  /** Dated guide entries in memory (guide growth, absolute). */
  guideEntries: number;
  /** Dated guide entries per week over the session span (0 when span < 1 week). */
  guidePerWeek: number;
  /** Aggregate token usage across all turns. */
  tokens: { prompt: number; completion: number; total: number };
  /** Total cost (USD) across all turns (0 when no price). */
  costUsd: number;
  /** Cost per verified result (0 when verified === 0). */
  costPerVerified: number;
  /** Verified / started (0..1; 0 when started === 0). */
  completionRate: number;
  /** Rework (failed tool calls) per started turn. */
  reworkRate: number;
  /** Escalations per started turn. */
  escalationRate: number;
}

/**
 * Count dated guide entries. The `remember` tool prefixes every appended entry
 * with a `YYYY-MM-DD` date, either at line start (`2026-08-29 …`) or after a
 * leading bullet (`- 2026-08-29 — …`). We count a line if its first
 * non-space / non-bullet token is a date. Undated prose does not count — only
 * deliberate, dated rules do. A line with multiple dates (a nested re-append)
 * still counts once.
 */
export function countDatedEntries(memoryText: string | undefined): number {
  if (!memoryText) return 0;
  const re = /^\s*(?:[-*•]\s*)?\d{4}-\d{2}-\d{2}\b/;
  let n = 0;
  for (const line of memoryText.split("\n")) {
    if (re.test(line)) n += 1;
  }
  return n;
}

export function computeScorecard(
  events: readonly SessionEvent[],
  opts: ScorecardOptions = {},
): ScorecardMetrics {
  let started = 0;
  let goalMet = 0;
  let goalUnmet = 0;
  let rework = 0;
  let escalations = 0;
  let recovered = 0;
  let unrecovered = 0;
  let recoveryMs = 0;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = Number.NEGATIVE_INFINITY;

  // Track the most recent failed tool call so we can measure the span to the
  // next passing one (recovery time). A passing call clears the pending failure.
  let pendingFailTs: number | null = null;

  for (const e of events) {
    if (typeof e.ts === "number") {
      if (e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    switch (e.type) {
      case "turn/start":
        started += 1;
        break;
      case "goal/judge":
        if (e.met) goalMet += 1;
        else goalUnmet += 1;
        break;
      case "tool/result":
        if (e.ok) {
          if (pendingFailTs !== null) {
            recovered += 1;
            const span = e.ts - pendingFailTs;
            if (span > recoveryMs) recoveryMs = span;
            pendingFailTs = null;
          }
        } else {
          rework += 1;
          if (pendingFailTs === null) pendingFailTs = e.ts;
          // else: consecutive failures — keep the earliest (worst-case span).
        }
        break;
      case "escalate":
        escalations += 1;
        break;
      default:
        break;
    }
  }
  // Any failure still pending at the end was never followed by a passing call.
  if (pendingFailTs !== null) unrecovered += 1;

  const verified = goalMet > 0 ? goalMet : 0;
  const usage = aggregateUsage(events);
  const costUsd = opts.price ? costForUsage(usage, opts.price) : 0;

  const spanMs =
    Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs > firstTs
      ? lastTs - firstTs
      : 0;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const guideEntries = countDatedEntries(opts.memoryText);
  const guidePerWeek =
    spanMs >= weekMs ? (guideEntries * weekMs) / spanMs : 0;

  return {
    started,
    verified,
    goalMet,
    goalUnmet,
    rework,
    escalations,
    recovered,
    unrecovered,
    recoveryMs,
    guideEntries,
    guidePerWeek,
    tokens: {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
    },
    costUsd,
    costPerVerified: verified > 0 ? costUsd / verified : 0,
    completionRate: started > 0 ? verified / started : 0,
    reworkRate: started > 0 ? rework / started : 0,
    escalationRate: started > 0 ? escalations / started : 0,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtRecovery(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Render the scorecard as a human-readable table (deterministic, no colors). */
export function formatScorecard(m: ScorecardMetrics): string {
  const rows: Array<[string, string, string]> = [
    ["completion rate", pct(m.completionRate), `${m.verified}/${m.started} verified (goal-met)`],
    ["rework rate", pct(m.reworkRate), `${m.rework} failed tool call${m.rework === 1 ? "" : "s"}`],
    ["escalation rate", pct(m.escalationRate), `${m.escalations} escalation${m.escalations === 1 ? "" : "s"}`],
    ["recovery time", fmtRecovery(m.recoveryMs), `${m.recovered} recovered · ${m.unrecovered} unrecovered`],
    ["cost per verified", m.verified > 0 ? fmtCost(m.costPerVerified) : "—", `total ${fmtCost(m.costUsd)} · ${m.tokens.total} tok`],
    ["guide growth", m.guidePerWeek > 0 ? `${m.guidePerWeek.toFixed(1)}/wk` : `${m.guideEntries} entries`, "dated rules in memory"],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length), "metric".length);
  const w1 = Math.max(...rows.map((r) => r[1].length), "value".length);
  const out: string[] = [];
  out.push(`${"metric".padEnd(w0)}  ${"value".padEnd(w1)}  note`);
  out.push(`${"-".repeat(w0)}  ${"-".repeat(w1)}  ${"-".repeat(24)}`);
  for (const [a, b, c] of rows) {
    out.push(`${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`);
  }
  return out.join("\n");
}

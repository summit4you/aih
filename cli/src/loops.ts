import type { SessionEvent } from "@aih/core";

/**
 * CC#57 — /usage Loops breakdown.
 *
 * Autonomous loop activity (goal auto-continue rounds, task subagent
 * delegations, best_of_n judge batches) should be visible in /usage so a
 * runaway or chatty loop is easy to spot — per-source run count, total
 * tokens, tokens per run, and how long ago the last run happened.
 *
 * Honest accounting note: usage is recorded per TURN (turn/end), not per tool
 * call, so loop sources that fire inside a shared turn cannot be split exactly.
 * We attribute the usage of the turn that CONTAINS the loop activity to that
 * source, and say so in the rendering ("turn-attributed"). When a turn carries
 * several loop sources its usage is counted under each — the panel is a
 * spotlight, not a ledger. Deterministic, zero-dependency, unit-testable.
 */

export interface LoopSourceStat {
  /** Stable source id, e.g. "goal", "task", "best_of_n", "workflow". */
  source: string;
  /** How many loop activations were observed. */
  runs: number;
  /** Total tokens of turns attributed to this source. */
  totalTokens: number;
  /** Total prompt tokens of attributed turns (for cost-sensitive eyeballing). */
  promptTokens: number;
  /** Timestamp (epoch ms) of the most recent activation. */
  lastTs: number;
  /**
   * True when at least one attributed turn also contains OTHER loop sources
   * (shared-turn attribution — the same tokens appear under multiple sources).
   */
  sharedTurn: boolean;
}

/** Tool names whose calls count as loop sources. */
const LOOP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task",
  "best_of_n",
]);

/**
 * Aggregate loop activity by source over a session event log.
 * Returns stats sorted by totalTokens desc (runaway first), only sources with
 * runs > 0. Empty array when the session had no loop activity.
 */
export function loopUsageBreakdown(events: readonly SessionEvent[]): LoopSourceStat[] {
  // turnId → tokens (from turn/end), turnId → set of sources seen in that turn
  const turnTokens = new Map<string, { total: number; prompt: number }>();
  for (const e of events) {
    if (e.type === "turn/end" && e.usage) {
      turnTokens.set(e.turnId, { total: e.usage.totalTokens, prompt: e.usage.promptTokens });
    }
  }

  // source → per-source aggregate
  interface Acc {
    runs: number;
    turnIds: Set<string>;
    lastTs: number;
  }
  const acc = new Map<string, Acc>();
  const touch = (source: string, turnId: string, ts: number): void => {
    let a = acc.get(source);
    if (!a) {
      a = { runs: 0, turnIds: new Set(), lastTs: 0 };
      acc.set(source, a);
    }
    a.runs += 1;
    a.turnIds.add(turnId);
    if (ts > a.lastTs) a.lastTs = ts;
  };

  for (const e of events) {
    // Tool-driven loops: task / best_of_n calls.
    if (e.type === "tool/call") {
      if (LOOP_TOOL_NAMES.has(e.name)) {
        touch(e.name === "task" ? "task" : e.name, e.turnId, e.ts);
      }
      continue;
    }
    // Goal auto-continue rounds: one goal/judge event per judged round.
    if (e.type === "goal/judge") {
      touch("goal", e.turnId, e.ts);
    }
  }

  // Attribute turn usage to every source present in that turn; mark sharing.
  const sourcesInTurn = new Map<string, Set<string>>();
  for (const [source, a] of acc) {
    for (const turnId of a.turnIds) {
      let set = sourcesInTurn.get(turnId);
      if (!set) {
        set = new Set();
        sourcesInTurn.set(turnId, set);
      }
      set.add(source);
    }
  }

  const out: LoopSourceStat[] = [];
  for (const [source, a] of acc) {
    let total = 0;
    let prompt = 0;
    let shared = false;
    for (const turnId of a.turnIds) {
      const u = turnTokens.get(turnId);
      if (!u) continue;
      total += u.total;
      prompt += u.prompt;
      const set = sourcesInTurn.get(turnId);
      if (set && set.size > 1) shared = true;
    }
    out.push({
      source,
      runs: a.runs,
      totalTokens: total,
      promptTokens: prompt,
      lastTs: a.lastTs,
      sharedTurn: shared,
    });
  }
  out.sort((x, y) => y.totalTokens - x.totalTokens || y.runs - x.runs);
  return out;
}

/** Human relative time ("just now", "2m ago", "1h ago", "3d ago"). */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const fmtK = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();

/**
 * Render the breakdown as /usage panel lines. Returns [] when there is no
 * loop activity. Shared-turn attribution is called out once, on the header.
 */
export function formatLoopBreakdown(
  stats: readonly LoopSourceStat[],
  now = Date.now(),
): string[] {
  if (!stats.length) return [];
  const lines = ["loops breakdown (turn-attributed):"];
  for (const s of stats) {
    const per = s.runs > 0 ? Math.round(s.totalTokens / s.runs) : 0;
    const label = s.source === "goal" ? "goal rounds" : s.source === "task" ? "task subagents" : s.source;
    lines.push(
      `  ${label}: ${s.runs} run${s.runs === 1 ? "" : "s"} · ${fmtK(s.totalTokens)} tok · ${fmtK(per)}/run · last ${fmtAgo(s.lastTs, now)}`,
    );
  }
  if (stats.some((s) => s.sharedTurn)) {
    lines.push("  note: turns carrying several loop sources count under each (spotlight, not a ledger)");
  }
  return lines;
}

/**
 * IT#4 — multi-agent session management panel (TUI `/sessions`).
 *
 * The `/bg` job board tracks background agent sessions by id/status, and the
 * session store holds each session's token usage. This module flattens both
 * into one "sessions dashboard": active agent sessions (running / waiting /
 * done / failed / cancelled) plus every saved session, each with its token
 * usage and model cost — so the TUI can render a single one-key control
 * surface (the IT Status-bar philosophy).
 *
 * Pure over plain data (jobs + per-session usage), same discipline as
 * cost.ts / scorecard.ts / measure.ts — no I/O, no LLM, unit-testable.
 *
 * Status model (aligned with IT#4's desired statuses):
 *   running  — job board says running (an agent turn in flight)
 *   done     — job finished with exit 0
 *   failed   — job finished non-zero
 *   cancelled— job cancelled
 *   idle     — a saved session with no associated (running/active) job
 */
import type { Job } from "./jobs.js";
import type { ModelPrice } from "./cost.js";

export type DashboardStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "idle";

export interface SessionRow {
  /** Session name (without .jsonl); for a bg job this is the job's session. */
  name: string;
  status: DashboardStatus;
  /** True when this row is a live background agent session (not just saved). */
  active: boolean;
  /** Job id when this row maps to a background job. */
  jobId?: string;
  /** Short label / prompt preview (for jobs). */
  label?: string;
  /** Token usage across the session's recorded turns. */
  tokens: number;
  /** Cost in USD (0 when no price). */
  cost: number;
}

export interface SessionsDashboard {
  /** Active agent sessions (from the job board), newest first. */
  active: SessionRow[];
  /** Saved sessions that are not backed by a running job, newest first. */
  saved: SessionRow[];
  /** Aggregate across all rows. */
  totalTokens: number;
  totalCost: number;
}

/** Map a job's status to the dashboard status vocabulary. */
export function jobStatus(j: Job): DashboardStatus {
  switch (j.status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** Cost (USD) for a token count under a model price. */
export function usageCost(tokens: number, price?: ModelPrice): number {
  if (!price) return 0;
  return (tokens / 1e6) * price.input; // conservative: input-rate estimate
}

/**
 * Build the dashboard. `sessionUsage` maps a session NAME → tokens recorded
 * (0 when absent). Prices optional → cost 0. Active rows come from `jobs`,
 * saved rows from `savedNames` (session names with no running job).
 */
export function buildDashboard(
  jobs: readonly Job[],
  sessionUsage: ReadonlyMap<string, number>,
  price?: ModelPrice,
  savedNames: readonly string[] = [],
): SessionsDashboard {
  const active: SessionRow[] = [];
  for (const j of [...jobs].reverse()) {
    active.push({
      name: j.session,
      status: jobStatus(j),
      active: true,
      jobId: j.id,
      label: j.label,
      tokens: sessionUsage.get(j.session) ?? 0,
      cost: usageCost(sessionUsage.get(j.session) ?? 0, price),
    });
  }
  // Sessions that exist on disk but are not backed by a job → idle (saved).
  const jobSessions = new Set(jobs.map((j) => j.session));
  const idleNames = savedNames.filter((n) => !jobSessions.has(n));
  const saved: SessionRow[] = idleNames.map((name) => ({
    name,
    status: "idle",
    active: false,
    tokens: sessionUsage.get(name) ?? 0,
    cost: usageCost(sessionUsage.get(name) ?? 0, price),
  }));
  const all = [...active, ...saved];
  const totalTokens = all.reduce((s, r) => s + r.tokens, 0);
  const totalCost = all.reduce((s, r) => s + r.cost, 0);
  return { active, saved, totalTokens, totalCost };
}

const STATUS_ICON: Record<DashboardStatus, string> = {
  running: "▶",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
  idle: "·",
};

/** Human-readable dashboard (one line per row). */
export function formatDashboard(d: SessionsDashboard): string {
  const lines: string[] = [];
  if (!d.active.length && !d.saved.length) {
    return "(no sessions yet)";
  }
  for (const s of [...d.active, ...d.saved]) {
    const icon = STATUS_ICON[s.status];
    const cost = d.totalCost > 0 && s.cost > 0 ? `  \$${s.cost.toFixed(4)}` : "";
    const usage = s.tokens > 0 ? `  ${s.tokens} tok` : "";
    const extra = s.label ? `  ${s.label}` : "";
    lines.push(`  ${icon} ${s.name}  [${s.status}${cost}${usage}]${extra}`);
  }
  if (d.totalTokens > 0) {
    lines.push(`total  ${d.totalTokens} tokens · \$${d.totalCost.toFixed(4)}`);
  }
  return lines.join("\n");
}

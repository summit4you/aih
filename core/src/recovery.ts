/**
 * MK#44/#45 — recovery classifier: interpret tool facts after a crash.
 *
 * Maka's insight: a missing tool result has at least four explanations
 * (never started / started but no effect / effect done but result lost /
 * changed afterwards). "Always retry" can duplicate side effects; "always
 * fail" invents history. The classifier maps the immutable event triple
 * (call → dispatch → result) to an honest decision:
 *
 *   call + result (no dispatch)  → synthetic   — provably never ran
 *     (length-truncation / cancel fill-ins write result without dispatch)
 *   call + dispatch + result     → completed   — reuse, never re-run
 *   call, no dispatch            → not_dispatched — provably safe to replay
 *   call + dispatch, no result   → indeterminate  — PARK: side effect unknown
 *
 * The model's own claims are not evidence. Only these facts decide.
 */
import type { SessionEvent } from "./types.js";

export type ToolRecoveryState =
  | "completed"
  | "synthetic"
  | "not_dispatched"
  | "indeterminate";

export interface ToolFact {
  callId: string;
  name: string;
  turnId: string;
  state: ToolRecoveryState;
}

/** Stable machine-readable park reason (UI copy may change; codes may not). */
export const PARK_REASON = "tool_recovery_parked";

/**
 * Classify every tool/call in `events`. Pure — no I/O, deterministic order
 * (first-appearance of each callId).
 */
export function classifyToolFacts(events: readonly SessionEvent[]): ToolFact[] {
  const calls = new Map<string, { name: string; turnId: string }>();
  const dispatched = new Set<string>();
  const results = new Set<string>();
  for (const e of events) {
    if (e.type === "tool/call") calls.set(e.callId, { name: e.name, turnId: e.turnId });
    else if (e.type === "tool/dispatch") dispatched.add(e.callId);
    else if (e.type === "tool/result") results.add(e.callId);
  }
  const out: ToolFact[] = [];
  for (const [callId, meta] of calls) {
    let state: ToolRecoveryState;
    if (results.has(callId) && !dispatched.has(callId)) state = "synthetic";
    else if (dispatched.has(callId) && results.has(callId)) state = "completed";
    else if (!dispatched.has(callId)) state = "not_dispatched";
    else state = "indeterminate";
    out.push({ callId, name: meta.name, turnId: meta.turnId, state });
  }
  return out;
}

export interface RecoveryReport {
  /** Last turnId with a turn/end event (the last PROVABLY closed turn). */
  lastClosedTurn?: string;
  /** Turn that started but never ended (crash candidate), if any. */
  openTurn?: string;
  facts: ToolFact[];
  /** True when at least one dispatched call lacks its outcome. */
  parked: boolean;
}

/**
 * Full recovery scan for a session log: which turn is open, what happened to
 * its tools. Pure over events.
 */
export function scanRecovery(events: readonly SessionEvent[]): RecoveryReport {
  let lastClosedTurn: string | undefined;
  const ended = new Set<string>();
  for (const e of events) {
    if (e.type === "turn/end") {
      ended.add(e.turnId);
      lastClosedTurn = e.turnId;
    }
  }
  // The open turn = the NEWEST turnId seen on activity (user message,
  // assistant turn, or tool facts) that never got a turn/end.
  let openTurn: string | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const tid = (e as { turnId?: string }).turnId;
    if (!tid || ended.has(tid)) continue;
    if (
      e.type === "user/message" || e.type === "assistant/message" ||
      e.type === "tool/call" || e.type === "tool/dispatch"
    ) {
      openTurn = tid;
      break;
    }
  }
  const allFacts = classifyToolFacts(events);
  const facts = openTurn ? allFacts.filter((f) => f.turnId === openTurn) : [];
  return {
    lastClosedTurn,
    ...(openTurn ? { openTurn } : {}),
    facts,
    parked: facts.some((f) => f.state === "indeterminate"),
  };
}

/** One-line human summary per fact for CLI/TUI display. */
export function describeFact(f: ToolFact): string {
  switch (f.state) {
    case "completed":
      return `${f.name} (${f.callId}) completed — result recorded`;
    case "synthetic":
      return `${f.name} (${f.callId}) synthetic result — provably never executed`;
    case "not_dispatched":
      return `${f.name} (${f.callId}) never dispatched — safe to replay`;
    case "indeterminate":
      return `${f.name} (${f.callId}) dispatched but outcome UNKNOWN — parked (side effect may have happened)`;
  }
}

/**
 * P2#7 — Dream / Distill ("sessions are assets").
 *
 * /dream: scan recent session JSONLs and surface durable knowledge worth
 * persisting to memory.md (user corrections, decisions, conventions).
 * /distill: find repeated manual flows (same tool + similar args across
 * sessions) that are candidates for a skill or workflow.
 *
 * This module owns the deterministic part: pure extraction over session
 * events, bounded and unit-testable without an LLM. The LLM step (turning the
 * extracted material into memory prose) happens in the TUI command via one
 * no-tools completion, mirroring judgeGoal().
 */
import type { SessionEvent } from "@aih/core";

/** A repeated-flow candidate found by distill. */
export interface FlowCandidate {
  tool: string;
  /** Normalized argument signature shared by >= threshold calls. */
  signature: string;
  /** How many times this exact signature appeared. */
  count: number;
  /** Example args (first occurrence). */
  example: string;
  /** Suggested deterministic artifact name. */
  suggestion: string;
}

const MAX_TURNS_SCANNED = 40;
const FLOW_THRESHOLD = 3;

function normArgs(name: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (name) {
    case "run_cmd":
      return typeof a.command === "string" ? a.command.trim().slice(0, 120) : null;
    case "webfetch":
      return typeof a.url === "string" ? a.url.replace(/\/+$/, "") : null;
    case "write_file":
    case "edit":
    case "read_file":
      return typeof a.path === "string" ? a.path : null;
    default:
      return null;
  }
}

/**
 * Extract candidate flows from session events: same tool + same normalized
 * argument signature appearing >= FLOW_THRESHOLD times.
 */
export function findFlowCandidates(events: SessionEvent[]): FlowCandidate[] {
  const counts = new Map<string, { count: number; example: string }>();
  for (const e of events) {
    if (e.type !== "assistant/message") continue;
    const am = e as Extract<SessionEvent, { type: "assistant/message" }>;
    for (const call of am.toolCalls ?? []) {
      const sig = normArgs(call.name, call.args);
      if (!sig) continue;
      const key = `${call.name}\u0000${sig}`;
      const prev = counts.get(key);
      if (prev) prev.count += 1;
      else counts.set(key, { count: 1, example: sig });
    }
  }
  const out: FlowCandidate[] = [];
  for (const [key, v] of counts) {
    if (v.count < FLOW_THRESHOLD) continue;
    const [tool, sig] = key.split("\u0000");
    out.push({
      tool,
      signature: sig,
      count: v.count,
      example: v.example,
      suggestion:
        tool === "run_cmd"
          ? `wrap as a workflow phase (.aih/workflows/<name>.mjs) or a skill`
          : tool === "webfetch"
            ? `consider a small skill documenting this source`
            : `frequent ${tool} on the same path — consider batching`,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

export interface DreamMaterial {
  /** Sessions scanned (bounded by MAX_TURNS_SCANNED per session). */
  sessions: number;
  /** user messages that look like corrections/preferences. */
  corrections: string[];
  /** checkpoint notes (explicit "worth remembering" markers). */
  checkpointNotes: string[];
  /** goal/judge reasons — what the agent kept getting wrong/right. */
  judgeReasons: string[];
  /** flow candidates from distill (included in the dream prompt too). */
  flows: FlowCandidate[];
}

// Note: \b is CJK-blind (all CJK chars are word chars, so there is no
// boundary between them) — Chinese cues match bare, English ones bounded.
const CORRECTION_RE =
  /(不要|其实应该|正确的是|以后都|记住|\balways\b|\bnever\b|\bdon'?t\b|\bactually\b|\binstead\b|\bprefer\b|\bmust\b)/i;

/**
 * Pull dream material from session events: correction-flavored user turns,
 * checkpoint notes, goal/judge reasons. Bounded so huge logs stay cheap.
 */
export function extractDreamMaterial(
  sessionsEvents: SessionEvent[][],
): DreamMaterial {
  const corrections: string[] = [];
  const checkpointNotes: string[] = [];
  const judgeReasons: string[] = [];
  let scanned = 0;
  for (const events of sessionsEvents) {
    scanned += 1;
    let turns = 0;
    for (let i = events.length - 1; i >= 0 && turns < MAX_TURNS_SCANNED; i -= 1) {
      const e = events[i];
      if (e.type === "checkpoint") {
        const note = (e as { note?: string }).note;
        if (note && !checkpointNotes.includes(note)) checkpointNotes.push(note);
        continue;
      }
      if (e.type === "goal/judge") {
        const g = e as Extract<SessionEvent, { type: "goal/judge" }>;
        if (g.reason && !judgeReasons.includes(g.reason)) judgeReasons.push(g.reason);
        continue;
      }
      if (e.type === "user/message") {
        turns += 1;
        const text = (e as Extract<SessionEvent, { type: "user/message" }>).text ?? "";
        if (text.length <= 300 && CORRECTION_RE.test(text) && !corrections.includes(text)) {
          corrections.push(text.trim());
        }
      }
    }
  }
  return {
    sessions: scanned,
    corrections: corrections.slice(0, 10),
    checkpointNotes: checkpointNotes.slice(0, 8),
    judgeReasons: judgeReasons.slice(0, 6),
    flows: findFlowCandidates(sessionsEvents.flat()),
  };
}

/** Render the material as compact text for the LLM (or direct display). */
export function formatDreamMaterial(m: DreamMaterial): string {
  const parts: string[] = [`sessions scanned: ${m.sessions}`];
  if (m.corrections.length) {
    parts.push(`\nuser corrections/preferences:\n${m.corrections.map((c) => `- ${c}`).join("\n")}`);
  }
  if (m.checkpointNotes.length) {
    parts.push(`\ncheckpoint notes:\n${m.checkpointNotes.map((c) => `- ${c}`).join("\n")}`);
  }
  if (m.judgeReasons.length) {
    parts.push(`\ngoal judge observations:\n${m.judgeReasons.map((c) => `- ${c}`).join("\n")}`);
  }
  if (m.flows.length) {
    parts.push(`\nrepeated flows:\n${m.flows.map((f) => `- ${f.tool} ×${f.count}: ${f.signature} (${f.suggestion})`).join("\n")}`);
  }
  if (parts.length === 1 && m.corrections.length === 0) parts.push("(nothing notable found)");
  return parts.join("\n");
}

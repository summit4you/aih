import { COMPACT_CONTINUE_PROMPT, COMPACTION_STATE_GUARD, LANGUAGE_RULE } from "./prompts.js";
import { createHash } from "node:crypto";
import { scanRecovery } from "./recovery.js";

// Single tool-result cap (characters) for what the MODEL sees in the projected
// conversation. Raised from opencode's 2K default to 8K: a 2K cap truncated
// most real source-file reads (657/2404 results in one session) down to a
// first strophe plus "[truncated]", which the model repeatedly mistook for a
// dead output channel and entered a blind retry loop. 8K ≈ 2K tokens keeps a
// single file read mostly intact while still bounding one huge result; the
// per-turn aggregate budget (TURN_TOOL_BUDGET_CHARS) bounds the total.
export const TOOL_OUTPUT_MAX_CHARS = 8_192;

export function truncateToolOutput(value: string): string {
  return value.length <= TOOL_OUTPUT_MAX_CHARS
    ? value
    : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
}

// FA#2 — per-turn aggregate budget for tool messages. The per-result cap above
// (2K) bounds a single result, but a turn that fans out N read tools still
// dumps N × 2K into the next request. This is the coarser, turn-level cap:
// the total tool content for one turn is bounded, with the EARLIEST results
// kept intact (they carry the first context) and later ones truncated.
// Default raised to 512K (≈128K tokens) so long agentic loops — a turn that
// reads source files, greps, edits, re-tests, and iterates many times — run to
// completion instead of being cut off mid-task. 64K was still too tight for
// such loops. See agent-loop pre-flight compact (each turn's first step) for
// the real context-overflow guard; this cap is only a last-resort flood
// barrier, and when it trips the model still gets an explicit directive.
export const TURN_TOOL_BUDGET_CHARS = 512_000;

// FA#2 (FrontierAgent ContextSizeGuard parity) — directive appended to the
// model-visible conversation when a turn's tool-output budget is exhausted.
// Unlike a bare truncation marker, it tells the model what to DO: stop
// issuing tool calls and deliver an answer from verified information, since
// continued tool calls are truncated anyway. Kept as a stable prefix so a
// replayed/compacted tail is not re-appended (dedup check uses startsWith).
export const TURN_BUDGET_STOP_DIRECTIVE =
  "[Turn tool-output budget exhausted: stop issuing tool calls now and deliver your best answer from verified information already gathered. Every further tool call this turn is truncated, so keep it to a single, clean, honest wrap-up. Sending another message resumes normal tool output on a fresh turn.]";

/**
 * FA#2 — cap the total tool-message content for a single turn.
 *
 * Pure (operates on the projected ChatMessage[]), so it is unit-testable
 * without a SessionLog. `turnOf` maps a tool message's `toolCallId` to its
 * turn id; tool messages that share a turn are budgeted together, in order.
 *
 * Strategy: walk the turn's tool messages in order, keeping each intact while
 * the running total fits `budget`; the first one that would exceed the budget
 * (and every one after it) is truncated to the remaining room (min 0). This
 * preserves the earliest results — the ones the model most needs to reason
 * about — and trims the tail. Returns a new array (input is not mutated).
 */
export function capTurnToolBudget(
  messages: ChatMessage[],
  turnOf: (m: ChatMessage) => string | undefined,
  budget: number = TURN_TOOL_BUDGET_CHARS,
): ChatMessage[] {
  if (budget <= 0) return messages;
  // Group indices by turn, preserving first-seen order.
  const byTurn = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const t = turnOf(m);
    if (t === undefined) continue;
    const arr = byTurn.get(t);
    if (arr) arr.push(i);
    else byTurn.set(t, [i]);
  }
  if (byTurn.size === 0) return messages;
  const out = messages.slice();
  let changed = false;
  for (const idxs of byTurn.values()) {
    let remaining = budget;
    for (const i of idxs) {
      const m = out[i];
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length <= remaining) {
        remaining -= content.length;
        continue;
      }
      // This result would exceed the remaining budget: truncate it to the
      // room left (floor at 0 so the pairing is still answered). The marker
      // is actionable, not cryptic: a model that sees it must STOP running
      // read/debug tools (they'd be truncated too) and wrap up from what it
      // already has, or end the turn so a fresh turn resets the budget.
      const keep = Math.max(0, remaining);
      out[i] = {
        ...m,
        content:
          keep > 0
            ? `${content.slice(0, keep)}\n[turn tool-output budget exhausted — STOP running read/debug tools and wrap up from what you have; sending another message will start a fresh turn with a reset budget]`
            : "[turn tool-output budget exhausted — STOP running read/debug tools and wrap up from what you have; sending another message will start a fresh turn with a reset budget]",
      };
      remaining = 0;
      changed = true;
    }
  }
  // True no-op when nothing was truncated (returns the original reference).
  return changed ? out : messages;
}

/**
 * MK#42 — stable digest over an ordered event prefix. Compaction summaries
 * carry this so consumers can verify that the projection still corresponds
 * to the log it claims to cover (Maka HistoryCompactCheckpoint parity).
 */
export function coverageDigest(events: readonly SessionEvent[]): string {
  const h = createHash("sha256");
  for (const e of events) {
    h.update(`${e.seq}\0${JSON.stringify(e)}\0`);
  }
  return h.digest("hex").slice(0, 32);
}
import type { ChatMessage, SessionEvent, WorktreeSummary } from "./types.js";

export type SessionListener = (event: SessionEvent) => void;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type SessionEventInput = DistributiveOmit<
  SessionEvent & Partial<import("./types.js").SessionTreeNode>,
  "seq" | "ts"
>;

export class SessionLog {
  #events: SessionEvent[] = [];
  #listeners = new Set<SessionListener>();
  /** MK#43 — callId → placeholder body for pruned tool results. */
  #pruned = new Map<string, string>();

  append(event: SessionEventInput): SessionEvent {
    const full = Object.freeze({
      ...event,
      seq: this.#nextSeq(),
      ts: Date.now(),
    }) as SessionEvent;
    this.#events.push(full);
    for (const listener of this.#listeners) listener(full);
    return full;
  }

  #nextSeq(): number {
    const last = this.#events[this.#events.length - 1];
    return last ? last.seq + 1 : 0;
  }

  static fromEvents(events: SessionEvent[]): SessionLog {
    const log = new SessionLog();
    log.#events = events.map((e) => Object.freeze({ ...e }) as SessionEvent);
    return log;
  }

  all(): readonly SessionEvent[] {
    return this.#events;
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * P#37 — tree view of the session: nodes with their parent seq (explicit
   * or the implicit previous event). Roots are events whose parent differs
   * from the linear default.
   */
  tree(): { seq: number; type: SessionEvent["type"]; parentId: number | null; summary: string }[] {
    const out: { seq: number; type: SessionEvent["type"]; parentId: number | null; summary: string }[] = [];
    this.#events.forEach((e, i) => {
      const explicit = (e as { parentId?: number }).parentId;
      out.push({
        seq: e.seq,
        type: e.type,
        parentId: typeof explicit === "number" ? explicit : i > 0 ? this.#events[i - 1].seq : null,
        summary:
          e.type === "user/message"
            ? (e as { text?: string }).text?.slice(0, 60) ?? ""
            : e.type === "checkpoint"
              ? (e as { note?: string }).note ?? ""
              : "",
      });
    });
    return out;
  }

  /** Branch points: events that were explicitly forked/branched from. */
  branchPoints(): number[] {
    return this.#events
      .filter((e) => typeof (e as { parentId?: number }).parentId === "number")
      .map((e) => e.seq);
  }

  fork(fromSeq = 0): SessionLog {
    const child = new SessionLog();
    child.#events = this.#events
      .filter((e) => e.seq >= fromSeq)
      .map((e) => ({ ...e }));
    return child;
  }

  /**
   * Record a named checkpoint (roadmap F#28). Append-only: the event is just a
   * marker; restoring never rewrites history.
   */
  checkpoint(
    note?: string,
    contextTokens?: number,
    worktree?: WorktreeSummary,
  ): SessionEvent & { type: "checkpoint" } {
    return this.append({
      type: "checkpoint",
      ...(note ? { note } : {}),
      ...(contextTokens != null ? { contextTokens } : {}),
      ...(worktree ? { worktree } : {}),
    }) as SessionEvent & { type: "checkpoint" };
  }

  /** Latest checkpoint at or before `beforeSeq` (inclusive), if any. */
  latestCheckpoint(beforeSeq = Infinity):
    | (SessionEvent & { type: "checkpoint" })
    | undefined {
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      const e = this.#events[i];
      if (e.type === "checkpoint" && e.seq <= beforeSeq) return e;
    }
    return undefined;
  }

  /**
   * Restore to a checkpoint (F#28): returns a NEW log containing only events
   * up to and including the marker (restore = prefix, not deletion), so the
   * discarded suffix survives in the original log / session file for audit.
   */
  restoreTo(checkpointSeq: number): SessionLog {
    const child = new SessionLog();
    child.#events = this.#events
      .filter((e) => e.seq <= checkpointSeq)
      .map((e) => ({ ...e }));
    return child;
  }

  /**
   * In-place pointer switch to another log's events (F#28 `/restore`): the
   * live log object keeps its identity (exit-save closures stay valid) while
   * its event list is replaced by the restored prefix. Seq numbers are kept,
   * so appends after the switch continue the restored timeline.
   */
  adopt(other: SessionLog): void {
    this.#events = other.all().map((e) => ({ ...e }));
  }

  /**
   * MK#43 — replace the model-visible body of a tool result with a short
   * placeholder (the full text stays in this log). Projection-only: events
   * are immutable; deriveMessages consults these overrides.
   */
  pruneResult(callId: string, placeholder: string): void {
    this.#pruned.set(callId, placeholder);
  }

  prunedResult(callId: string): string | undefined {
    return this.#pruned.get(callId);
  }

  deriveMessages(systemPrompt?: string): ChatMessage[] {
    let compact: Extract<SessionEvent, { type: "compaction" }> | undefined;
    // P#37 — branch summaries ride along with the projection: they carry
    // knowledge from abandoned branches and are folded into the leading
    // system message (never dropped, never re-summarized).
    const branchSummaries = this.#events.filter(
      (e): e is Extract<SessionEvent, { type: "branch_summary" }> => e.type === "branch_summary",
    );
    for (const event of this.#events) {
      if (event.type === "compaction") {
        // MK#42: verify the coverage digest before honoring the projection.
        // A stale/foreign summary must never replace raw history silently —
        // on mismatch we drop the projection and fail open to the full log.
        if (
          event.coverage &&
          coverageDigest(this.#events.filter((e) => e.seq <= event.coverage!.upToSeq)) !==
            event.coverage.digest
        ) {
          continue; // treat as if this compaction never happened
        }
        compact = event;
      }
    }
    // The compaction summary folds into the LEADING system message: some
    // providers (llama.cpp's Qwen3 template) raise "System message must be at
    // the beginning" for a system message anywhere after index 0.
    const summaryBlock = [
      compact?.summary ? `# Summary of the earlier conversation\n${compact.summary}` : "",
      ...branchSummaries.map((b) => `# Lessons from an abandoned branch\n${b.text}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    const summary = summaryBlock || undefined;
    // COMPACTION_STATE_GUARD rides along with every summary so a compacted
    // agent verifies current state before re-implementing "pending" work (see
    // prompts.ts). Always injected with a summary, never without one.
    const summaryWithGuard = summary
      ? `${summary}\n\n${COMPACTION_STATE_GUARD}`
      : undefined;
    const systemContent = summaryWithGuard
      ? systemPrompt
        ? `${systemPrompt}\n\n${summaryWithGuard}\n\n${LANGUAGE_RULE}`
        : `${summaryWithGuard}\n\n${LANGUAGE_RULE}`
      : systemPrompt
        ? `${systemPrompt}\n\n${LANGUAGE_RULE}`
        : undefined;
    const messages: ChatMessage[] = [];
    if (systemContent) messages.push({ role: "system", content: systemContent });
    const pushMessage = (event: SessionEvent): void => {
      switch (event.type) {
        case "user/message":
          messages.push({ role: "user", content: event.text });
          break;
        case "assistant/message":
          messages.push({
            role: "assistant",
            content: event.text,
            toolCalls: event.toolCalls,
          });
          break;
        case "tool/result": {
          const call = this.#events.find(
            (e) => e.type === "tool/call" && e.callId === event.callId,
          );
          if (
            call &&
            call.type === "tool/call" &&
            (!compact || call.seq >= compact.seq)
          ) {
            // MK#43: pruned results project the placeholder instead of the
            // full body (the original stays in the log).
            const prunedBody = this.#pruned.get(event.callId);
            const raw =
              prunedBody ??
              JSON.stringify(event.ok ? event.result : { error: event.error });
            messages.push({
              role: "tool",
              toolCallId: event.callId,
              name: call.name,
              content: truncateToolOutput(raw),
            });
          }
          break;
        }
        default:
          break;
      }
    };
    for (const event of this.#events) {
      if (compact && event.seq < compact.seq) continue;
      if (event.type === "compaction") {
        // summary is already folded into the leading system message; only the
        // verbatim recent tail is replayed here.
        if (event.recent) {
          for (const m of event.recent) messages.push(m);
        }
        continue;
       }
      // MK#44: dispatch facts are Runtime bookkeeping, not conversation —
      // the model never sees them.
      if (event.type === "tool/dispatch") continue;
       pushMessage(event);
     }
     // FA#2 — per-turn aggregate budget on tool content. The per-result cap
     // (truncateToolOutput, 2K) bounds a single result, but a turn that fans
     // out N read tools still dumps N × 2K into the next request. Cap the
     // total tool content per turn (earliest kept intact, later trimmed).
     // Budget is configurable via AIH_TURN_TOOL_BUDGET (chars); 0 disables.
     const budget =
       Number(process.env.AIH_TURN_TOOL_BUDGET ?? "") || TURN_TOOL_BUDGET_CHARS;
     if (budget > 0) {
       const turnByCallId = new Map<string, string>();
       for (const e of this.#events) {
         if (e.type === "tool/call") turnByCallId.set(e.callId, e.turnId);
       }
        const capped = capTurnToolBudget(
          messages,
          (m) => (m.toolCallId ? turnByCallId.get(m.toolCallId) : undefined),
          budget,
        );
        if (capped !== messages) {
          messages.length = 0, messages.push(...capped);
          // FA#2 supplement (FrontierAgent ContextSizeGuard parity): when a
          // turn's tool-output budget is exhausted and results were truncated,
          // append an explicit, actionable directive INSTEAD of leaving the
          // model to infer it. Do this only if one isn't already present (a
          // compacted/replayed tail could already carry one) — and never
          // break tool pairing, which is why the directive is a trailing
          // user message after all tool replies.
          //
          // IMPORTANT: only append the directive when the truncation hit the
          // CURRENT (still-open) turn. Historical CLOSED turns can also bust
          // the per-turn budget — but their work already ended, so telling the
          // model to "stop and wrap up" a brand-new turn is a false alarm that
          // makes every resume of a long session look budget-exhausted from
          // the first message. The truncation of old results still stands
          // (it bounds context); only the actionable "stop" nudge is gated to
          // the live turn.
          let hasDirective = false;
          for (const m of messages) {
            if (
              m.role === "user" &&
              typeof m.content === "string" &&
              m.content.startsWith(TURN_BUDGET_STOP_DIRECTIVE)
            ) {
              hasDirective = true;
              break;
            }
          }
          const openTurnId = scanRecovery(this.#events).openTurn;
          const openTurnTruncated =
            openTurnId !== undefined &&
            messages.some(
              (m) =>
                m.role === "tool" &&
                typeof m.content === "string" &&
                m.content.includes("turn tool-output budget exhausted") &&
                (m.toolCallId ? turnByCallId.get(m.toolCallId) === openTurnId : false),
            );
          if (!hasDirective && openTurnTruncated) {
            messages.push({ role: "user", content: TURN_BUDGET_STOP_DIRECTIVE });
          }
        }
      }
     // Invariant (opencode/MiMo-Code parity): the model-visible conversation
     // must contain at least one user message — strict chat templates (Qwen3:
     // "No user query found in messages") 400 otherwise. If a compaction
     // folded the turn's user message into the summary and stored no replay
     // tail (sessions compacted before the replay fix), re-anchor the last
     // user message; with none on record, use the synthetic continue prompt.
     if (!messages.some((m) => m.role === "user")) {
       let lastUser: string | undefined;
       for (let i = this.#events.length - 1; i >= 0; i -= 1) {
         const event = this.#events[i];
         if (event.type === "user/message") {
           lastUser = event.text;
           break;
         }
       }
       messages.push({
         role: "user",
         content: lastUser ?? COMPACT_CONTINUE_PROMPT,
       });
     }
     return messages;
   }
}

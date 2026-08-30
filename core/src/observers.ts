/**
 * FA#5 — pluggable loop observers.
 *
 * AIH's loop-side logic (doom_loop, stall, quota, empty-retry, compaction) has
 * historically lived inline in agent-loop.ts. This module defines a small,
 * composable Observer contract so workflow authors and plugins can hang their
 * own observers (FA#3 watchdog, FA#4 stop-loss, eval probes) on the loop
 * WITHOUT touching the kernel. Each observer implements only the callbacks it
 * needs; the AgentLoop notifies all observers at the loop boundaries in a
 * fixed order.
 *
 * Observers are OBSERVATION-ONLY by default: they may log, measure, inject
 * context (via the loop's inject seam), or throw a LoopAbort to stop the turn.
 * They do not mutate the session log directly — the loop owns that.
 */
/** A tool call the model requested (name + args, before execution). */
export interface ObserverToolCall {
  callId: string;
  name: string;
  args: unknown;
}

/** The outcome of a tool call (ok + result/error), after execution. */
export interface ObserverToolResult {
  callId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * FA#5 — a pluggable loop observer. Implement any subset of these callbacks;
 * the AgentLoop calls them (in the order listed) at each boundary. All are
 * optional and must be safe to throw (the loop treats a thrown LoopAbort as a
 * stop signal and swallows other errors so one bad observer can't crash the
 * loop).
 */
export interface LoopObserver {
  /** A turn is about to begin (after turn/start is logged). */
  onTurnStart?(turnId: string): void;
  /**
   * A turn is ending (before turn/end is logged). `stopReason` is the
   * resolved reason (end_turn / max_steps / max_tokens / cancelled).
   */
  onTurnEnd?(turnId: string, stopReason: string): void;
  /** The model produced a response (text and/or tool calls). */
  onModelResponse?(turnId: string, text: string, toolCalls: ObserverToolCall[]): void;
  /** A tool call is about to be executed. */
  onToolCall?(turnId: string, call: ObserverToolCall): void;
  /** A tool call finished (ok or error). */
  onToolResult?(turnId: string, result: ObserverToolResult): void;
  /** The loop compacted the context (after the compaction event). */
  onCompaction?(turnId: string, summaryChars: number): void;
}

/**
 * FA#5 — throw from an observer to stop the turn. Carries a reason the loop
 * records on the turn/end event (stopReason = "observer_aborted").
 */
export class LoopAbort extends Error {
  constructor(
    public readonly reason: string,
  ) {
    super(`observer aborted: ${reason}`);
    this.name = "LoopAbort";
  }
}

/**
 * FA#5 — fan-out helper: notify a set of observers of a boundary, swallowing
 * non-LoopAbort errors (one bad observer must not crash the loop) and
 * propagating the FIRST LoopAbort (the loop stops the turn). Returns the
 * LoopAbort if any observer requested an abort, else null.
 */
export function notifyObservers(
  observers: readonly LoopObserver[],
  fn: (o: LoopObserver) => void,
): LoopAbort | null {
  for (const o of observers) {
    try {
      fn(o);
    } catch (err) {
      if (err instanceof LoopAbort) return err;
      // Swallow non-abort observer errors: observation is best-effort.
    }
  }
  return null;
}

// ── FA#4 — repetition stop-loss (content-level guards) ──────────────────

/**
 * FA#4 — deterministic JSON stringification (sorted object keys) so a tool
 * call's (name, args) pair maps to a stable byte key. Pure; safe on
 * JSON-shaped args (which is what the model produces). Circular refs are
 * marked rather than recursing forever.
 */
export function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return `${value}n`;
  if (t === "function" || t === "symbol") return `[${t}]`;
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`);
  seen.delete(obj);
  return `{${parts.join(",")}}`;
}

/**
 * FA#4 — n-gram (shingle) Jaccard similarity over a string. Pure. 1 =
 * identical, 0 = disjoint. Used to detect "near-verbatim" repeated text.
 */
export function textSimilarity(a: string, b: string, n = 8): number {
  if (!a || !b) return 0;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    if (s.length < n) {
      set.add(s);
      return set;
    }
    for (let i = 0; i + n <= s.length; i += 1) set.add(s.slice(i, i + n));
    return set;
  };
  const sa = grams(a);
  const sb = grams(b);
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Options for {@link RepetitionObserver} (all have sensible defaults). */
export interface RepetitionObserverOptions {
  /** Consecutive identical tool calls before a soft hint (default 3). */
  hintAt?: number;
  /** Consecutive identical tool calls before a hard stop (default 6). */
  stopAt?: number;
  /** Near-verbatim text responses before a soft hint (default 2). */
  textHintAt?: number;
  /** Near-verbatim text responses before a hard stop (default 3). */
  textStopAt?: number;
  /** n-gram Jaccard threshold for "near-verbatim" (default 0.8). */
  similarityThreshold?: number;
  /** n-gram size for text similarity (default 8). */
  ngram?: number;
}

/**
 * FA#4 — repetition stop-loss observer. Content-level guards that complement
 * (not replace) the registry's doom_loop (same-tool-same-args ask/deny):
 *
 *   ① DuplicateQueryRollback — a query already executed WITH content is
 *      re-requested → nudge the model to re-approach (resample) rather than
 *      burn another identical step.
 *   ② RepetitionGuard — consecutive byte-identical tool calls → soft hint at
 *      `hintAt`, hard stop (LoopAbort) at `stopAt`. Fires in onToolCall,
 *      i.e. BEFORE the tool runs and BEFORE doom_loop's registry check.
 *   ③ TextRepetitionGuard — near-verbatim model text (n-gram similarity) →
 *      soft hint at `textHintAt`, hard stop at `textStopAt`.
 *
 * Hints are delivered via the loop's inject seam (bind the observer to the
 * loop after construction). Stops throw LoopAbort. Pure state machine — no
 * I/O, fully unit-testable.
 */
export class RepetitionObserver implements LoopObserver {
  #inject: (t: string) => void = () => {};
  #hintAt: number;
  #stopAt: number;
  #textHintAt: number;
  #textStopAt: number;
  #threshold: number;
  #n: number;
  #lastCallKey: string | null = null;
  #consecutive = 0;
  #callKeysByCallId = new Map<string, string>();
  #executedWithContent = new Set<string>();
  #lastText: string | null = null;
  #textRepeat = 0;

  constructor(opts: RepetitionObserverOptions = {}) {
    this.#hintAt = opts.hintAt ?? 3;
    this.#stopAt = opts.stopAt ?? 6;
    this.#textHintAt = opts.textHintAt ?? 2;
    this.#textStopAt = opts.textStopAt ?? 3;
    this.#threshold = opts.similarityThreshold ?? 0.8;
    this.#n = opts.ngram ?? 8;
  }

  /** Wire the observer's hint sink to a loop's inject seam. */
  bind(loop: { inject: (t: string) => void }): void {
    this.#inject = loop.inject;
  }

  onToolCall(_turnId: string, call: ObserverToolCall): void {
    const key = `${call.name}::${stableStringify(call.args)}`;
    this.#callKeysByCallId.set(call.callId, key);
    // ② RepetitionGuard: consecutive byte-identical calls.
    this.#consecutive = key === this.#lastCallKey ? this.#consecutive + 1 : 1;
    this.#lastCallKey = key;
    if (this.#consecutive >= this.#stopAt) {
      throw new LoopAbort(
        `repeated identical tool call ${call.name} ${this.#consecutive}× in a row — stopping (repetition guard)`,
      );
    }
    if (this.#consecutive >= this.#hintAt) {
      this.#inject(
        `[repetition guard] You have called ${call.name} with identical arguments ${this.#consecutive} times in a row. ` +
          `Use the result you already have, vary your approach, or conclude.`,
      );
    }
    // ① DuplicateQueryRollback: re-request of a query already executed WITH content.
    if (this.#executedWithContent.has(key)) {
      this.#inject(
        `[duplicate query] ${call.name} with these arguments was already executed and returned content. ` +
          `Re-approach with different parameters or conclude with what you have.`,
      );
    }
  }

  onToolResult(_turnId: string, result: ObserverToolResult): void {
    const key = this.#callKeysByCallId.get(result.callId);
    if (
      key &&
      result.ok &&
      result.result !== undefined &&
      result.result !== null &&
      result.result !== ""
    ) {
      this.#executedWithContent.add(key);
    }
  }

  onModelResponse(_turnId: string, text: string, _toolCalls: ObserverToolCall[]): void {
    const trimmed = text.trim();
    if (trimmed && this.#lastText) {
      const sim = textSimilarity(trimmed, this.#lastText, this.#n);
      this.#textRepeat = sim >= this.#threshold ? this.#textRepeat + 1 : 1;
    } else {
      this.#textRepeat = trimmed ? 1 : 0;
    }
    if (this.#textRepeat >= this.#textStopAt) {
      throw new LoopAbort(
        `near-verbatim response repeated ${this.#textRepeat}× — stopping (text repetition guard)`,
      );
    }
    if (this.#textRepeat >= this.#textHintAt) {
      this.#inject(
        `[text repetition guard] Your response is nearly identical to the previous one. Conclude or take a different action.`,
      );
    }
    if (trimmed) this.#lastText = trimmed;
  }
}

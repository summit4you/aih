import type { LLMAdapter } from "./seams/llm.js";
import { QuotaError, StallError } from "./seams/llm-sse.js";
import { COMPACT_CONTINUE_PROMPT, EMPTY_RETRY_PROMPT, MAX_STEPS_PROMPT, STREAM_RESUME_PROMPT, TRUNCATED_RETRY_PROMPT } from "./prompts.js";
import type { LoopObserver } from "./observers.js";
import { LoopAbort, notifyObservers } from "./observers.js";

/** Max consecutive empty responses (no text + no tool call) we nudge the model to retry before ending the turn. */
const MAX_EMPTY_RETRIES = 2;
/** Bounded re-issues after a length-truncated response (repetition loop hit the
 *  output ceiling). opencode parity: the turn survives a truncated call so the
 *  model can correct itself; beyond this bound the turn ends with max_tokens. */
const MAX_TRUNCATED_RETRIES = 2;

/**
 * CC#49 — max stream-stall resumes per turn (partial content + "continue"
 * nudge). Bounded so a pathologically flaky provider can't loop forever.
 */
const MAX_STALL_RESUMES = 1;

/**
 * CC#51 — quota-exhaustion (usage-limit) auto-resume. When the provider
 * spends its usage window it returns a quota 429; instead of ending the turn
 * with an error we WAIT for the reset and re-issue the SAME rejected call
 * (not re-run the turn). Bounded so a never-resetting provider can't hang the
 * session forever.
 */
const MAX_QUOTA_WAITS = 2;
/** Default wait (s) when the provider gives no Retry-After. */
const QUOTA_DEFAULT_WAIT_SEC = 60;
/** Hard cap on a single wait (s) — a "reset in 3 days" is not something to sit through. */
const QUOTA_MAX_WAIT_SEC = 1800;

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
import { coverageDigest, SessionLog } from "./session-log.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatMessage, ContentBlock, LLMResponse, SessionEvent, TokenUsage, ToolCall, TurnResult } from "./types.js";
import { BudgetExceeded, BudgetTracker } from "./budget.js";
import type { BudgetVerdict } from "./budget.js";

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep the
 * input order. Used for F#29 parallel read-only tool calls.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AgentLoopOptions {
  llm: LLMAdapter;
  tools: ToolRegistry;
  log?: SessionLog;
  systemPrompt?: string;
  maxStepsPerTurn?: number;
  contextWindow?: number;
  compactAt?: number;
  /**
   * F#29: max concurrent read-only tool calls within one step
   * (default AIH_TOOL_CONCURRENCY, 4). Write tools always run serially.
   */
  readConcurrency?: number;
  /**
   * Debug seam (Codex `codex debug prompt-input`): called with the exact
   * model-visible messages right before every LLM request.
   */
  onPromptInput?: (messages: ChatMessage[]) => void;
  /**
   * CC#60 — provenance of input driving this loop's turns. "tty" (default):
   * local keyboard. "injected": serve/attach POST /message or steering text.
   * Injected turns can never approve a pending permission ask.
   */
  inputSource?: "tty" | "injected";
  /**
   * FA#5 — pluggable loop observers. Each observer implements only the
   * callbacks it needs (onTurnStart/onTurnEnd/onModelResponse/onToolCall/
   * onToolResult/onCompaction). A LoopObserver may throw LoopAbort to stop
   * the turn. Default: no observers.
   */
  observers?: readonly LoopObserver[];
  /**
   * compactContext — optional state snapshot appended to every compaction
   * summary prompt (auto and manual). The CLI wires this to the current todo
   * state so a compacted agent does not forget which items are done vs
   * pending (observed: after compaction the agent re-did finished work). The
   * string
   * is folded into the summary request as an "Authoritative current state"
   * block the summarizer must carry forward verbatim.
   */
  compactContext?: () => string;
  /**
   * PE#2 — budget tracker (hard constraint + tripwire). When present, the
   * loop checks it after each step: a HARD verdict emits an `escalate` event
   * and stops the turn (stopReason "escalated"); a SOFT (tripwire) verdict is
   * surfaced via `onTripwire` (non-silent notice) and latched. Absent → no-op.
   */
  budget?: BudgetTracker;
  /**
   * PE#2 — price resolver: converts a TokenUsage chunk into dollars. The CLI
   * wires cost.ts's costForUsage (prices are a CLI concern). Absent → cost
   * enforcement is skipped (writes/timeout/scope still enforced).
   */
  costOf?: (usage: TokenUsage) => number;
  /**
   * PE#2 — called with the soft (tripwire) verdict before the loop continues.
   * The caller decides how to surface it (TUI system row / stderr line).
   */
  onTripwire?: (v: Extract<BudgetVerdict, { state: "soft" }>) => void;
  /**
   * PE#1 — computational sensors (写后验证循环). When present, after each
   * successful write-kind tool call the applicable sensors run; a red verdict
   * injects feedback for the model to fix (bounded retries); the final red
   * triggers escalation. Absent → no-op.
   */
  sensors?: import("./budget.js").SensorLoop;
  /**
   * PE#4 — escalate primitive. Called when the harness hits a bound it cannot
   * resolve alone (sensor red after retries, budget hard, repeated failure).
   * The caller decides: interactive → surface options in the TUI;
   * non-interactive → log the event and exit with code 3.
   * Model-invisible: the `escalate` event is skipped by deriveMessages.
   */
  onEscalate?: (v: {
    reason: string;
    options: string[];
    safestDefault: string;
  }) => void;
}

const CONTEXT_ERROR =
  /(maximum context|context length|context_length|prompt is too long|too many tokens|maximum number of tokens|exceeds? (the )?(longest )?maximum|requested \d+ tokens)/i;

/**
 * CJK-aware token estimate. A flat chars÷4 undercounts the tool-JSON +
 * Chinese-conversation mix by ~2-3× (CJK ≈ 1 char/token, dense JSON ≈ 3),
 * which let real prompts reach ~1.5× the window before anyone noticed.
 */
export function estimateTokensText(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0x3000 && cp <= 0x30ff) || // CJK punct + kana
      (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
      (cp >= 0xac00 && cp <= 0xd7af)    // Hangul
    ) {
      cjk++;
    }
  }
  const rest = s.length - cjk;
  return Math.max(1, Math.round(cjk * 1.1 + rest / 3.5));
}

/**
 * Image blocks contribute a fixed budget to the token estimate — treat a
 * 1024×1024 image as ~1k tokens (conservative floor; multimodal providers
 * usually align on ~1-2k for a standard image). Keeps context-window math
 * honest when a message carries images instead of plain text.
 */
export const IMAGE_TOKENS_ESTIMATE = 1024;

/**
 * Estimate tokens for a `string | ContentBlock[]` message content. Text blocks
 * flow through the CJK-aware estimator; image blocks get IMAGE_TOKENS_ESTIMATE.
 */
export function estimateTokensContent(content: string | ContentBlock[]): number {
  if (typeof content === "string") return estimateTokensText(content);
  let tokens = 0;
  for (const block of content) {
    if (block.type === "image_url") tokens += IMAGE_TOKENS_ESTIMATE;
    else if (typeof block.text === "string") tokens += estimateTokensText(block.text);
  }
  return tokens;
}

/** Below this fraction of the window, opaque server errors are NOT treated as overflow. */
const OVERFLOW_SUSPECT_RATIO = 0.6;

// Compaction design aligned with opencode / MiMo-Code (session/compaction.ts,
// core/session/compaction.ts, overflow.ts):
//  - keep a recent tail VERBATIM (not summarized) so the agent retains the most
//    recent context, and summarize only the older head;
//  - rolling summary: each new summary folds in the previous one;
//  - a structured summary template;
//  - tool outputs truncated when serialized for the summary input.
// Char cap for tool outputs serialized into the compaction-summary input
// (#serializeMessages). This is an INTERNAL summary-input bound (keeps the
// summary LLM prompt small) — distinct from session-log's TOOL_OUTPUT_MAX_CHARS
// (8K), which caps what the model sees in the projected conversation.
const TOOL_OUTPUT_MAX_CHARS = 2_000;
const MAX_RECENT_TOKENS = 15_000;   // opencode: MAX_PRESERVE_RECENT_TOKENS
const MIN_RECENT_TOKENS = 500;      // floor for the verbatim recent tail
const RESERVED_RATIO = 0.2;         // fraction of the window reserved for output
/** Summary output bound (opencode SUMMARY_OUTPUT_TOKENS parity). Prevents the
 *  summary LLM from emitting unbounded output; aih also slices to 12K chars as
 *  a belt-and-braces guard, but the token bound stops the generation early. */
const SUMMARY_OUTPUT_TOKENS = 4_096;

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.
- Historical memory only. The summary is not dialogue, not an output template, and not a tool-call format. Continue from the live user message below; when actions are needed, use real tool calls.
- Respond in the SAME language as the conversation (opencode compaction.txt parity): match the user's language exactly, whatever it is. A summary in a different language than the user's nudges the agent back into that language for narration after compaction.`;

const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.
- CRITICAL — never keep an item in "Objective" that is already done. Once the conversation shows a task was implemented, tested, or delivered (even if uncommitted), move it OUT of "Objective" and into "Completed"/"Active" with its verification state. "Objective" lists only what is genuinely NOT yet done. A stale Objective that duplicates a Completed item is the #1 cause of the agent re-doing finished work after compaction.
- Keep the summary in the SAME language as the conversation — match the user's language exactly.`;

export class AgentLoop {
  #llm: LLMAdapter;
  #tools: ToolRegistry;
  #log: SessionLog;
  #systemPrompt: string;
  #maxSteps: number;
  #contextWindow: number;
  #compactAt: number;
  #readConcurrency: number;
  /** P#36⑤ — side-channel session identity for summary calls (stable per loop). */
  #summarySid?: string;
  /** P#36④ — re-primed the interrupted turn once after an overflow recovery. */
  #overflowReprimed = false;
  #onPromptInput?: (messages: ChatMessage[]) => void;
  /** FA#5 — pluggable loop observers (each implements only the callbacks it needs). */
  #observers: readonly LoopObserver[];
  /** PE#2 — budget tracker (hard constraint + tripwire). */
  #budget?: BudgetTracker;
  /** PE#2 — price resolver (usage → $). */
  #costOf?: (usage: TokenUsage) => number;
  /** PE#2 — soft (tripwire) verdict surface hook. */
  #onTripwire?: (v: Extract<BudgetVerdict, { state: "soft" }>) => void;
  /** PE#1 — computational sensors (写后验证循环). */
  #sensors?: import("./budget.js").SensorLoop;
  /** PE#4 — escalate primitive hook. */
  #onEscalate?: (v: { reason: string; options: string[]; safestDefault: string }) => void;
  /** PE#2 — latched tripwire (fires once per task). */
  #tripwireFired = false;
  /** CC#60 — "tty" | "injected"; injected turns cannot approve asks. */
  #inputSource: "tty" | "injected" = "tty";
  #inbox: string[] = [];
  /** P#35 — user steering messages queued mid-turn; drained before the next LLM call. */
  #steering: string[] = [];
  /** P#35 — follow-up messages queued for the NEXT natural turn boundary. */
  #followUp: string[] = [];
  #activeAbort: AbortController | null = null;
  /** compactContext — authoritative state snapshot folded into summary prompts. */
  #compactContext?: () => string;

  constructor(options: AgentLoopOptions) {
    this.#llm = options.llm;
    this.#tools = options.tools;
    this.#log = options.log ?? new SessionLog();
    this.#systemPrompt = options.systemPrompt ?? "";
    // opencode/MiMo-Code parity: no step cap by default (agent.steps ??
    // Infinity) — the model ends the turn when it is done; a cap is an opt-in
    // safety valve (--max-steps) that triggers a text handoff, not a hard cut.
    this.#maxSteps = options.maxStepsPerTurn ?? Infinity;
    this.#contextWindow = options.contextWindow ?? 0;
    this.#compactAt = options.compactAt ?? 0.8;
    this.#compactContext = options.compactContext;
    this.#readConcurrency = Math.max(
      1,
      Math.floor(options.readConcurrency ?? (Number(process.env.AIH_TOOL_CONCURRENCY ?? "") || 4)),
    );
    this.#onPromptInput = options.onPromptInput;
    this.#observers = options.observers ?? [];
    this.#inputSource = options.inputSource ?? "tty";
    this.#budget = options.budget;
    this.#costOf = options.costOf;
    this.#onTripwire = options.onTripwire;
    this.#sensors = options.sensors;
    this.#onEscalate = options.onEscalate;
  }

  /**
   * PE#4 — emit an `escalate` event (model-invisible) and invoke the
   * onEscalate hook. The caller decides interactive (TUI options) vs
   * non-interactive (exit code 3) handling. Returns the event for logging.
   */
  escalate(reason: string, options: string[], safestDefault: string, turnId?: string) {
    this.#log.append({
      type: "escalate",
      ...(turnId ? { turnId } : {}),
      reason,
      options,
      safestDefault,
    });
    this.#onEscalate?.({ reason, options, safestDefault });
  }

  /**
   * PE#2 — accumulate cost + writes into the budget tracker and check the
   * verdict. Returns "stop" when a HARD bound was hit (the caller must break
   * the turn with stopReason "escalated"); "continue" otherwise. A SOFT
   * (tripwire) verdict is surfaced via onTripwire and latched, then continues.
   */
  async #enforceBudget(
    turnId: string,
    usage: TokenUsage | undefined,
    writes: number,
    writePaths: string[],
  ): Promise<"stop" | "continue"> {
    if (!this.#budget) return "continue";
    // accumulate cost (only when a price resolver is wired)
    if (usage && this.#costOf) {
      const cost = this.#costOf(usage);
      if (cost > 0) this.#budget.addUsage(cost);
    }
    if (writes > 0) this.#budget.addWrites(writes);
    // scope deny: check each written path against the deny list
    for (const p of writePaths) {
      const v = this.#budget.check({ writePath: p });
      if (v.state === "hard") {
        this.#escalateForBudget(turnId, v);
        return "stop";
      }
    }
    const v = this.#budget.check({});
    if (v.state === "hard") {
      this.#escalateForBudget(turnId, v);
      return "stop";
    }
    if (v.state === "soft") {
      if (!this.#tripwireFired) {
        this.#tripwireFired = true;
        this.#budget.latchTripwire();
        this.#onTripwire?.(v);
      }
    }
    return "continue";
  }

  /** PE#2/PE#4 — emit an escalate event for a hard budget verdict. */
  #escalateForBudget(
    turnId: string,
    v: Extract<BudgetVerdict, { state: "hard" }>,
  ): void {
    this.escalate(
      `budget ${v.kind} exceeded: ${v.reason}`,
      [
        "continue anyway (I accept the overage)",
        "stop here and review the work so far",
        "roll back to the last checkpoint and re-plan",
      ],
      "stop here and review the work so far",
      turnId,
    );
  }

  /**
   * PE#1 — run computational sensors after a successful write. Returns "stop"
   * when retries are exhausted (escalated); "continue" otherwise (feedback for
   * a red-but-retryable verdict is injected for the model to fix).
   */
  async #runSensorsAfterWrite(
    turnId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<"stop" | "continue"> {
    if (!this.#sensors) return "continue";
    const r = await this.#sensors.afterWrite(toolName, args, turnId);
    if (r.passed) return "continue";
    if (r.feedback) this.inject(r.feedback);
    if (r.escalated) {
      this.escalate(
        `sensor red after retries: ${r.feedback}`,
        [
          "fix it myself and continue",
          "stop and let a human decide",
          "roll back the last write and re-approach",
        ],
        "stop and let a human decide",
        turnId,
      );
      return "stop";
    }
    return "continue";
  }

  get log(): SessionLog {
    return this.#log;
  }

  inject(context: string): void {
    this.#inbox.push(context);
  }

  /**
   * P#35 — steer the running agent: queue a user instruction that lands
   * after the CURRENT tool batch, before the next LLM call. Unlike abort,
   * the turn continues with the new guidance in context.
   */
  steer(text: string): void {
    this.#steering.push(text);
  }

  /** P#35 — queue a message for the next natural turn (not mid-turn). */
  followUp(text: string): void {
    this.#followUp.push(text);
  }

  hasQueued(): boolean {
    return this.#steering.length > 0 || this.#followUp.length > 0;
  }

  /** Drain queued messages. mode "steering": both queues; else follow-up only. */
  drainQueued(mode: "steering" | "followUp" = "steering"): string[] {
    const out = this.#followUp.splice(0);
    if (mode === "steering") out.unshift(...this.#steering.splice(0));
    return out;
  }

  cancel(): void {
    this.#activeAbort?.abort();
  }

  async compactNow(
    opts?: { instructions?: string },
  ): Promise<{ applied: boolean; before: number; after: number; usage?: TokenUsage }> {
    const before = this.#estimateContext();
    const { usage, applied } = await this.#compact("manual", {
      instructions: opts?.instructions,
      trigger: "manual",
    });
    return { applied, before, after: applied ? this.#estimateContext() : before, usage };
  }

  async send(
    text: string,
    hooks?: {
      onDelta?: (delta: string) => void;
      onRetry?: (attempt: number, error: unknown) => void;
      /**
       * CC#51 — called around a quota-exhaustion wait: `begin` fires when we
       * start waiting (UI shows "[quota] exhausted — will auto-resume at …"),
       * `end` when the wait completes (success or budget exhausted). Absent
       * (non-interactive run mode) → the wait is skipped and the QuotaError
       * propagates immediately (scripts stay predictable).
       */
      quotaWait?: {
        begin: (info: { retryAfterSec: number; resumeAtMs: number; wait: number }) => void;
        /** Called when the wait completes (reason: "done" | "aborted"). */
        end: (reason: string) => void;
      };
    },
  ): Promise<TurnResult> {
    const turnId = `turn_${Date.now().toString(36)}`;
    const ac = new AbortController();
    this.#activeAbort = ac;
    this.#log.append({ type: "turn/start", turnId });
    this.#log.append({ type: "user/message", turnId, text });
    // FA#5 — notify observers of turn start.
    const turnStartAbort = notifyObservers(this.#observers, (o) => o.onTurnStart?.(turnId));
    if (turnStartAbort) {
      this.#log.append({ type: "turn/end", turnId, stopReason: "observer_aborted" });
      return { turnId, steps: 0, stopReason: "observer_aborted" };
    }
    // Drain any context injected BEFORE this turn (e.g. a P1#4 skill
    // relevance nudge) so it is part of the very first model call.
    if (this.#inbox.length > 0) {
      const injected = this.#inbox.splice(0);
      for (const item of injected) {
        this.#log.append({
          type: "user/message",
          turnId,
          text: `[injected context] ${item}`,
        });
      }
    }

    let steps = 0;
    let stopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let contextTokens = 0;
    let contextNow = 0;
    let truncated = false;
    // F#30: cumulative LLM-layer generation time for this turn (ms). Set by
    // the adapter only for real streaming responses (mocks leave it unset).
    let genMs = 0;
    // Consecutive empty responses (no text + no tool call) the model has
    // produced this turn. Models (Qwen3, big-pickle) occasionally "drop" a
    // task mid-turn and return nothing; nudge them to continue a bounded
    // number of times before giving up (see MAX_EMPTY_RETRIES).
    let emptyRetries = 0;
    // Bounded re-issues after a length-truncated response (see MAX_TRUNCATED_RETRIES).
    let truncatedRetries = 0;
    // CC#49 — bounded stream-stall resumes for this turn.
    let stallResumes = 0;
    // CC#51 — bounded quota-exhaustion waits for this turn.
    let quotaWaits = 0;

    while (steps < this.#maxSteps && !ac.signal.aborted) {
      steps += 1;
      // `truncated` reflects the LAST response only: a mid-turn truncation that
      // the model recovers from (bounded re-issue) must not poison the final
      // stopReason — only a turn whose last response was cut short ends as
      // "max_tokens".
      truncated = false;
      // Pre-flight compact: if context is already above the threshold before
      // the first LLM call, compact now. This prevents sending oversized
      // prompts that cause provider 503/timeout (observed when context is
      // ~160K and the compact check only runs after the LLM response).
      if (steps === 1) {
        const preCtx = this.#estimateContext();
        if (
          this.#contextWindow > 0 &&
          preCtx >= Math.min(
            this.#compactAt * this.#contextWindow,
            this.#contextWindow - this.#compactReserve(),
          )
        ) {
          const c = await this.#compactOrSkip(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
        }
      }
      const isLastStep = Number.isFinite(this.#maxSteps) && steps >= this.#maxSteps;
      const buildInput = (): ChatMessage[] => {
        const base = this.#log.deriveMessages(this.#systemPrompt);
        // Final step: prefill the handoff prompt as a trailing assistant
        // message (opencode/MiMo-Code) so the model wraps up in text instead
        // of being cut off mid-tool-call.
        return isLastStep
          ? [...base, { role: "assistant" as const, content: MAX_STEPS_PROMPT }]
          : base;
      };
      const doComplete = () => {
        const input = buildInput();
        this.#onPromptInput?.(input);
        return this.#llm.complete({
          messages: input,
          tools: this.#tools.schemas(),
          ...(hooks?.onDelta ? { onDelta: hooks.onDelta } : {}),
          ...(hooks?.onRetry ? { onRetry: hooks.onRetry } : {}),
          signal: ac.signal,
        });
      };
      let response: LLMResponse | undefined;
      try {
        response = await doComplete();
      } catch (err) {
        if (ac.signal.aborted) break;
        // CC#49 — a stalled stream that already delivered partial text is
        // resumed honestly: the partial text is kept in the transcript, and a
        // bounded continuation message asks the model to finish the thought.
        // (Stream-level retries without content are handled inside the LLM
        // adapter; reaching here means content existed or retries ran out.)
        if (err instanceof StallError && stallResumes < MAX_STALL_RESUMES) {
          stallResumes += 1;
          const partial = err.partialText.trim();
          if (partial) {
            this.#log.append({ type: "assistant/message", turnId, text: partial, toolCalls: [] });
          }
          this.#log.append({
            type: "user/message",
            turnId,
            text: STREAM_RESUME_PROMPT,
          });
          continue; // next loop step rebuilds input from the log (partial + resume note)
        }
        // CC#51 — quota exhaustion (usage limit): WAIT for the reset, then
        // re-issue the SAME call. Only when the caller opted in (interactive
        // session with auto-resume on); otherwise the QuotaError propagates
        // so non-interactive `run` fails fast and predictably.
        if (err instanceof QuotaError && hooks?.quotaWait && quotaWaits < MAX_QUOTA_WAITS) {
          quotaWaits += 1;
          const waitSec = Math.min(
            Math.max(1, Math.round(err.retryAfterSec || QUOTA_DEFAULT_WAIT_SEC)),
            QUOTA_MAX_WAIT_SEC,
          );
          const resumeAtMs = Date.now() + waitSec * 1000;
          this.#log.append({
            type: "quota_wait",
            turnId,
            retryAfterSec: waitSec,
            resumeAtMs,
            wait: quotaWaits,
          });
          hooks.quotaWait.begin({ retryAfterSec: waitSec, resumeAtMs, wait: quotaWaits });
          await sleepMs(waitSec * 1000, ac.signal);
          hooks.quotaWait.end(ac.signal.aborted ? "aborted" : "done");
          if (ac.signal.aborted) break;
          // Re-issue the SAME call (not re-run the turn). On success we fall
          // OUT of the catch and the normal post-catch path logs the response
          // (usage + assistant/message). On a non-quota failure it propagates
          // (turn ends). On a quota failure again we wait once more (bounded).
          for (;;) {
            try {
              response = await doComplete();
              break;
            } catch (retryErr) {
              if (!(retryErr instanceof QuotaError) || ac.signal.aborted || quotaWaits >= MAX_QUOTA_WAITS) {
                throw retryErr;
              }
              quotaWaits += 1;
              const w2 = Math.min(
                Math.max(1, Math.round(retryErr.retryAfterSec || QUOTA_DEFAULT_WAIT_SEC)),
                QUOTA_MAX_WAIT_SEC,
              );
              const ra2 = Date.now() + w2 * 1000;
              this.#log.append({
                type: "quota_wait",
                turnId,
                retryAfterSec: w2,
                resumeAtMs: ra2,
                wait: quotaWaits,
              });
              hooks.quotaWait.begin({ retryAfterSec: w2, resumeAtMs: ra2, wait: quotaWaits });
              await sleepMs(w2 * 1000, ac.signal);
              hooks.quotaWait.end(ac.signal.aborted ? "aborted" : "done");
            }
          }
        }
        // CC#51 — if the quota branch above already recovered (response set),
        // skip the generic error-recovery path and fall through to the normal
        // post-catch processing (log response, process tool calls).
        if (response === undefined) {
          const message = err instanceof Error ? err.message : String(err);
          // Provider text is unreliable about WHY it failed: free-tier gateways
          // return generic "HTTP 500 Internal server error" when the real cause
          // is an oversized prompt. When the local estimate says we're near the
          // window, treat opaque server errors as suspected overflow and try
          // one compact+retry — mirroring pi's silent-overflow heuristic.
          const nearWindow =
            this.#contextWindow > 0 &&
            this.#estimateContext() >= OVERFLOW_SUSPECT_RATIO * this.#contextWindow;
          const opaqueFailure =
            /HTTP [45]\d\d|fetch failed|terminated|socket hang|other side closed/i.test(message);
          if (!CONTEXT_ERROR.test(message) && !(nearWindow && opaqueFailure)) throw err;
          // P#36④ — the failed request was part of THIS turn: its user request
          // and everything logged before it stay in the log, but compaction may
          // fold them into the summary. Re-prime the turn with an explicit
          // continuation message AFTER compacting so "retry the step" becomes
          // "resume the interrupted turn": the model re-reads its goal instead
          // of silently dropping it (pi: overflow → resume the task).
          const c = await this.#compact(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
          if (!this.#overflowReprimed) {
            this.#overflowReprimed = true;
            this.#log.append({
              type: "user/message",
              turnId,
              text:
                `[context recovery] The previous model request failed (likely context overflow) ` +
                `and older history was just summarized. Resume the interrupted task from the summary. ` +
                `${this.#turnRequestPreview(turnId)}`,
            });
          }
          response = await doComplete();
        }
      }
      usage = addUsage(usage, response.usage);
      if (typeof response.genMs === "number") genMs += response.genMs;
      const promptTokens = response.usage?.promptTokens ?? 0;
      // Free-tier gateways sometimes report cumulative/garbage prompt_tokens
      // (observed 28M on a ~500k-token conversation). Trust the wire number
      // only when it is plausibly bounded by the window AND stays within a
      // sane band of the local chars÷4 estimate; otherwise keep the local
      // estimate so compaction triggers and any UI stay sane. The window check
      // alone is NOT enough: a gateway's cumulative 949K read slips through a
      // 2×window gate once the window grows to 1M, then falsely trips the
      // 80% compaction trigger (949K ≥ 0.8×1M).
      const est = this.#estimateContext();
      const plausible =
        promptTokens > 0 &&
        (this.#contextWindow <= 0 || promptTokens <= this.#contextWindow * 2) &&
        promptTokens <= est * 3;
      const effectiveContext = plausible
        ? promptTokens
        : Math.max(contextNow, this.#estimateContext());
      if (plausible && promptTokens > contextTokens) contextTokens = promptTokens;
      contextNow = effectiveContext;

      this.#log.append({
        type: "assistant/message",
        turnId,
        text: response.text,
        toolCalls: response.toolCalls,
      });

      // FA#5 — notify observers of the model response.
      const respText = response.text;
      const respToolCalls = response.toolCalls.map((c) => ({ callId: c.id, name: c.name, args: c.args }));
      const respAbort = notifyObservers(this.#observers, (o) =>
        o.onModelResponse?.(turnId, respText, respToolCalls),
      );
      if (respAbort) {
        ac.abort();
        break;
      }

      // P#36 (hybrid budget): prefer the REAL prompt size from the last
      // request over chars/4 estimates; trigger compaction at
      // tokens > window − reserve so it fires BEFORE the provider rejects
      // the request, not after. compactAt (default 0.8) remains the floor:
      // compact no later than 80% even when the reserve is larger.
      const shouldCompact =
        this.#contextWindow > 0 &&
        effectiveContext >= Math.min(
          this.#compactAt * this.#contextWindow,
          this.#contextWindow - this.#compactReserve(),
        );

      if (response.finishReason === "length") {
        truncated = true;
        // Every tool call inside a length-truncated assistant message gets a
        // synthetic failure: streamed arguments may have been cut mid-JSON, so
        // executing them risks acting on salvaged-but-wrong input, and leaving
        // them unanswered breaks the assistant-toolCalls→tool-result pairing
        // the next request needs (providers 400 otherwise). The error tells
        // the model to re-issue the call cleanly.
        for (const call of response.toolCalls) {
          this.#log.append({
            type: "tool/call",
            turnId,
            callId: call.id,
            name: call.name,
            args: call.args,
          });
          this.#log.append({
            type: "tool/result",
            turnId,
            callId: call.id,
            ok: false,
            error:
              "model response hit the output token limit before this call completed — arguments may be truncated; re-issue the call",
          });
        }
        if (shouldCompact) {
          const c = await this.#compactOrSkip(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
        }
        // Bounded re-issue (opencode parity): inject a corrective nudge and
        // let the model retry with shorter arguments instead of killing the
        // whole turn. A repetition loop (e.g. a provider-list regex repeating
        // one token thousands of times) should cost the model one correction,
        // not the user's turn. Beyond the bound, fall through to ending the
        // turn with stopReason "max_tokens" (truncated already true).
        // Text-only truncations have no call to re-issue — the retry loop
        // would only burn empty responses — so they end the turn directly.
        if (response.toolCalls.length > 0 && truncatedRetries < MAX_TRUNCATED_RETRIES) {
          truncatedRetries += 1;
          this.#log.append({ type: "user/message", turnId, text: TRUNCATED_RETRY_PROMPT });
          continue;
        }
        break;
      }

      if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
        // The model returned no tool call. If it ALSO returned no text, it
        // likely "dropped" the task (a known Qwen3 / big-pickle instability on
        // complex decisions) rather than intentionally finishing — nudge it to
        // continue, bounded by MAX_EMPTY_RETRIES. A non-empty final answer
        // (text present) is a genuine end-of-turn and is not retried.
        const isEmpty = !response.text.trim() && response.toolCalls.length === 0;
        if (isEmpty && emptyRetries < MAX_EMPTY_RETRIES && !isLastStep) {
          emptyRetries += 1;
          this.#log.append({
            type: "user/message",
            turnId,
            text: EMPTY_RETRY_PROMPT,
          });
          if (shouldCompact) {
            const c = await this.#compactOrSkip(turnId);
            if (c.usage) usage = addUsage(usage, c.usage);
            if (c.applied) contextNow = this.#estimateContext();
          }
          continue;
        }
        if (shouldCompact) {
          const c = await this.#compactOrSkip(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
        }
        break;
      }

      // F#29: run consecutive read-only tool calls concurrently (bounded by
      // readConcurrency, default AIH_TOOL_CONCURRENCY=4); write tools stay
      // serial (ordering + doom-loop semantics unchanged). Results are logged
      // in the original call order regardless of completion order.
      {
        let i = 0;
        const calls = response.toolCalls;
        while (i < calls.length) {
          if (ac.signal.aborted) break;
          const def = this.#tools.get(calls[i].name);
          const isRead = !!def && def.kind === "read";
          let j = i;
          if (isRead) {
            while (j < calls.length) {
              const d = this.#tools.get(calls[j].name);
              if (!d || d.kind !== "read") break;
              j += 1;
            }
          } else {
            j = i + 1;
          }
          const batch = calls.slice(i, j);
          const runOne = (call: ToolCall) =>
            this.#tools.invoke(call.name, call.args, {
              turnId,
              inject: (ctxText) => this.inject(ctxText),
              source: this.#inputSource,
            });
          // MK#44 (T1): dispatch facts land BEFORE the tool/call event (the
          // assistant's call is appended with its outcome below) but BEFORE
          // execution. Once dispatched the tool MAY have run — crash recovery
          // uses the call→dispatch→result triple to distinguish "never
          // dispatched" (safe to replay) from "dispatched, outcome unknown"
          // (park). Dispatch is model-invisible: deriveMessages skips it.
          for (const call of batch) {
            this.#log.append({ type: "tool/dispatch", turnId, callId: call.id, name: call.name });
          }
          // FA#5 — notify observers of each tool call before execution.
          // A LoopAbort here is honored by the existing "abort mid-batch"
          // handler below, which records failure results for unexecuted calls
          // (pairing preserved) — so we only set the abort flag and break.
          for (const call of batch) {
            const callAbort = notifyObservers(this.#observers, (o) =>
              o.onToolCall?.(turnId, { callId: call.id, name: call.name, args: call.args }),
            );
            if (callAbort) {
              ac.abort();
              break;
            }
          }
          if (ac.signal.aborted) break;
          const outcomes = isRead
            ? await mapConcurrent(batch, this.#readConcurrency, runOne)
            : [await runOne(batch[0])];
          for (let k = 0; k < batch.length; k += 1) {
            const call = batch[k];
            const outcome = outcomes[k];
            this.#log.append({
              type: "tool/call",
              turnId,
              callId: call.id,
              name: call.name,
              args: call.args,
            });
            this.#log.append({
              type: "tool/result",
              turnId,
              callId: call.id,
              ok: outcome.ok,
              result: outcome.result,
              error: outcome.error,
            });
            // FA#5 — notify observers of the tool result.
            const resultAbort = notifyObservers(this.#observers, (o) =>
              o.onToolResult?.(turnId, {
                callId: call.id, name: call.name, ok: outcome.ok,
                result: outcome.result, error: outcome.error,
              }),
            );
            if (resultAbort) {
              ac.abort();
              break;
            }
          }
          if (ac.signal.aborted) break;
          i = j;
        }

        // PE#1/PE#2 — after the whole tool batch: run computational sensors on
        // each successful write, then enforce the budget. A "stop" verdict
        // (sensor red after retries / hard budget) escalates and ends the turn.
        if (!ac.signal.aborted && (this.#sensors || this.#budget)) {
          let writeCount = 0;
          const writePaths: string[] = [];
          for (const call of response.toolCalls) {
            const def = this.#tools.get(call.name);
            if (!def || def.kind !== "write") continue;
            const res = this.#log
              .all()
              .find((e): e is Extract<SessionEvent, { type: "tool/result" }> =>
                e.type === "tool/result" && e.callId === call.id,
              );
            if (res && !res.ok) continue; // only successful writes are verified
            writeCount += 1;
            const args = (call.args ?? {}) as Record<string, unknown>;
            const p = args.path;
            if (typeof p === "string") writePaths.push(p);
            if (this.#sensors) {
              const s = await this.#runSensorsAfterWrite(turnId, call.name, args);
              if (s === "stop") {
                stopReason = "escalated";
                ac.abort();
                break;
              }
            }
          }
          if (!ac.signal.aborted) {
            const b = await this.#enforceBudget(turnId, response.usage, writeCount, writePaths);
            if (b === "stop") {
              stopReason = "escalated";
              ac.abort();
            }
          }
        }

        // Abort mid-batch: calls that were never executed still need results,
        // or the assistant's toolCalls go orphaned in the derived conversation
        // (invalid request on the next turn).
        for (let k = i; k < calls.length; k += 1) {
          this.#log.append({
            type: "tool/call",
            turnId,
            callId: calls[k].id,
            name: calls[k].name,
            args: calls[k].args,
          });
          this.#log.append({
            type: "tool/result",
            turnId,
            callId: calls[k].id,
            ok: false,
            error: "turn cancelled before this call was executed",
          });
        }
      }

      if (this.#inbox.length > 0) {
        const injected = this.#inbox.splice(0);
        for (const item of injected) {
          this.#log.append({
            type: "user/message",
            turnId,
            text: `[injected context] ${item}`,
          });
        }
      }

      // P#35 — steering: user messages queued mid-turn land right here, after
      // the current tool batch and before the next LLM call, so the agent can
      // change course without aborting the turn.
      if (this.#steering.length > 0) {
        for (const item of this.#steering.splice(0)) {
          this.#log.append({ type: "user/message", turnId, text: item });
        }
      }

      if (shouldCompact) {
        const c = await this.#compactOrSkip(turnId);
        if (c.usage) usage = addUsage(usage, c.usage);
        if (c.applied) contextNow = this.#estimateContext();
      }
    }

    // PE#4 — an "escalated" stop (sensor red after retries / hard budget) is
    // more specific than "cancelled": the loop aborted on purpose, not by user.
    if (stopReason !== "escalated") {
      if (ac.signal.aborted) stopReason = "cancelled";
      else if (steps >= this.#maxSteps) stopReason = "max_steps";
      else if (truncated) stopReason = "max_tokens";
    }

    // FA#5 — notify observers of turn end (before the turn/end event is logged).
    notifyObservers(this.#observers, (o) => o.onTurnEnd?.(turnId, stopReason));

    this.#activeAbort = null;
    this.#log.append({
      type: "turn/end",
      turnId,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(genMs > 0 ? { genMs } : {}),
    });
    return {
      turnId,
      steps,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(contextTokens ? { contextTokens } : {}),
      ...(contextNow ? { contextNow } : {}),
    };
  }

  /**
   * P#36 (hybrid budget) — token headroom between the compaction trigger and
   * the hard window: compaction fires at window minus this reserve. Mirrors
   * the preserveRecentBudget reserve (20k cap / 20% of window).
   */
  #compactReserve(): number {
    if (this.#contextWindow <= 0) return 0;
    return Math.min(20_000, Math.floor(this.#contextWindow * RESERVED_RATIO));
  }

  #estimateTokens(messages: ChatMessage[]): number {
    let tokens = 0;
    for (const m of messages) {
      tokens += estimateTokensContent(m.content);
      for (const tc of m.toolCalls ?? []) {
        tokens += estimateTokensText(`${tc.name} ${JSON.stringify(tc.args ?? {})}`);
      }
    }
    return Math.max(1, tokens);
  }

  #estimateContext(): number {
    return this.#estimateTokens(this.#log.deriveMessages(this.#systemPrompt));
  }

  // P#36④ — the user request that started this turn (truncated preview), so
  // the overflow-recovery continuation message re-states the original goal.
  #turnRequestPreview(turnId: string): string {
    const users = this.#log
      .all()
      .filter(
        (e): e is Extract<SessionEvent, { type: "user/message" }> =>
          e.type === "user/message" && e.turnId === turnId,
      );
    const first = users[0]?.text ?? "";
    return first.length > 400 ? `${first.slice(0, 400)}…` : first;
  }

  // Latest compaction event in the log (for post-compaction size estimation).
  #lastCompaction(): Extract<SessionEvent, { type: "compaction" }> | undefined {
    for (let i = this.#log.all().length - 1; i >= 0; i--) {
      const e = this.#log.all()[i];
      if (e.type === "compaction") return e;
    }
    return undefined;
  }

  // Context size if `compact` were the newest compaction event — same
  // projection deriveMessages applies, without mutating the log.
  #estimateContextWith(compact: { summary?: string; recent?: ChatMessage[]; upToSeq?: number } | undefined): number {
    // Simulate the post-append projection directly from the event list:
    // system (with the NEW summary) + every event after this compaction's
    // coverage cutoff, replayed verbatim. This mirrors deriveMessages's
    // projection exactly and avoids the previous delta-math, which derived
    // from the PRE-append projection (still containing the full tail being
    // compacted away) and inflated the stamped contextAfter on big sessions.
    const summary = compact?.summary?.trim();
    const header = summary ? `# Summary of the earlier conversation\n${summary}` : "";
    const systemContent = this.#systemPrompt
      ? header
        ? `${this.#systemPrompt}\n\n${header}`
        : this.#systemPrompt
      : header;
    let chars = systemContent.length;
    const cutoff = compact?.upToSeq ?? -1;
    const sum = (m: string) => m.length;
    for (const e of this.#log.all()) {
      if (e.seq <= cutoff) continue;
      switch (e.type) {
        case "user/message":
          chars += sum(e.text);
          break;
        case "assistant/message":
          chars += sum(e.text) + (e.toolCalls ?? []).reduce((n, tc) => n + `${tc.name} ${JSON.stringify(tc.args ?? {})}`.length, 0);
          break;
        case "tool/call":
          chars += `${e.name} ${JSON.stringify(e.args ?? {})}`.length;
          break;
        case "tool/result": {
          const call = this.#log.all().find((c) => c.type === "tool/call" && c.callId === e.callId);
          if (call && call.seq >= cutoff) {
            chars += JSON.stringify(e.ok ? e.result : { error: e.error }).length;
          }
          break;
        }
        default:
          break;
      }
    }
    return Math.max(1, Math.round(chars / 4));
  }

  // Largest single summarization request we attempt (leaving room for the
  // template + output). If the head exceeds this we split it into chunks.
  #topBudget(): number {
    if (this.#contextWindow > 0) return Math.max(1_000, Math.floor(this.#contextWindow * 0.6));
    return 120_000;
  }

  // Token budget for the "recent" tail kept verbatim (not summarized).
  // opencode: clamp(usable * 0.25, MIN_PRESERVE_RECENT_TOKENS, MAX_PRESERVE_RECENT_TOKENS)
  #preserveRecentBudget(): number {
    const cw = this.#contextWindow;
    if (cw <= 0) return 4_000;
    const reserved = Math.min(20_000, Math.floor(cw * RESERVED_RATIO));
    const usable = Math.max(0, cw - reserved);
    return Math.min(MAX_RECENT_TOKENS, Math.max(MIN_RECENT_TOKENS, Math.floor(usable * 0.25)));
  }

  // Split the conversation into an older `head` (to summarize) and a `recent`
  // tail (kept verbatim). The split lands on a user-message (turn) boundary so
  // no tool call/result pair is ever orphaned. opencode: select().
  #selectHeadTail(
    messages: ChatMessage[],
    budget: number,
  ): { head: ChatMessage[]; recent: ChatMessage[] } {
    const n = messages.length;
    if (n === 0) return { head: [], recent: [] };
    const boundaries: number[] = [];
    for (let i = 0; i < n; i++) if (messages[i].role === "user") boundaries.push(i);
    // Keep the largest recent suffix that fits the budget (earliest boundary
    // whose suffix fits) so the head is as large as possible.
    let split = n;
    for (const b of boundaries) {
      if (this.#estimateTokens(messages.slice(b)) <= budget) {
        split = b;
        break;
      }
    }
    if (split < n) return { head: messages.slice(0, split), recent: messages.slice(split) };
    // Tail guarantee (pi-style): no turn-boundary suffix fits — the newest
    // turn is a giant. Keep that turn anyway with its user message TRUNCATED
    // to the budget (plus any following whole messages that fit), so the
    // post-compaction conversation always retains the live request verbatim-
    // prefixed and never loses "what were we just doing". A user-led tail is
    // also chat-template-safe (Qwen3 400s on conversations without a user
    // query), and truncation keeps call↔result pairing inside whole messages.
    //
    // P#36③ — split-turn double summary: messages of the giant turn that do
    // NOT fit the tail are folded back into the summarized head (chronolo-
    // gically appended), so the map-reduce summarizer produces partials for
    // them and merges — every message is either summarized or kept verbatim,
    // never silently dropped. Summary input is serialized text, so cutting
    // inside the turn cannot orphan tool_calls the way a chat-history split
    // would.
    const lastUser = boundaries[boundaries.length - 1];
    if (lastUser !== undefined) {
      const charCap = Math.max(64, Math.floor(budget / 1.2));
      const u = messages[lastUser];
      const truncatedUser: ChatMessage = {
        ...u,
        content:
          u.content.length > charCap
            ? `${u.content.slice(0, charCap)}\n[…truncated to fit the post-compaction budget; full text stays in the session log]`
            : u.content,
      };
      const recent: ChatMessage[] = [truncatedUser];
      let acc = this.#estimateTokens([truncatedUser]);
      let overflowStart = n;
      for (let j = lastUser + 1; j < n; j++) {
        const cost = this.#estimateTokens([messages[j]]);
        if (acc + cost > budget) {
          overflowStart = j;
          break;
        }
        recent.push(messages[j]);
        acc += cost;
      }
      return {
        head: [...messages.slice(0, lastUser), ...messages.slice(overflowStart)],
        recent,
      };
    }
    return { head: messages.slice(0, split), recent: messages.slice(split) };
  }

  #chunkMessages(messages: ChatMessage[], budget: number): ChatMessage[][] {
    const head = messages[0]?.role === "system" ? [messages[0]] : [];
    const rest = head.length ? messages.slice(1) : messages;
    const chunks: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    let used = 0;
    for (const m of rest) {
      const cost = this.#estimateTokens([m]);
      if (used + cost > budget && current.length > 0) {
        chunks.push(current);
        current = [];
        used = 0;
      }
      current.push(m);
      used += cost;
    }
    if (current.length) chunks.push(current);
    if (head.length) {
      if (chunks.length) chunks[0] = [...head, ...chunks[0]];
      else chunks.push([...head]);
    }
    return chunks;
  }

  #truncate(value: string): string {
    return value.length <= TOOL_OUTPUT_MAX_CHARS
      ? value
      : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
  }

  // Serialize the conversation into a text block for the summary prompt.
  // Tool outputs are truncated (opencode: serialize + truncate).
  #serializeMessages(messages: ChatMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        lines.push(`[User]: ${m.content}`);
      } else if (m.role === "assistant") {
        if (m.content) lines.push(`[Assistant]: ${m.content}`);
        for (const tc of m.toolCalls ?? []) {
          lines.push(`[Assistant tool call]: ${tc.name}(${JSON.stringify(tc.args)})`);
        }
      } else if (m.role === "tool") {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        lines.push(`[Tool result${m.name ? ` (${m.name})` : ""}]: ${this.#truncate(content)}`);
      }
    }
    return lines.join("\n\n");
  }

  // Rolling summary: find the most recent prior compaction summary so the new
  // one can fold it in (opencode: completedCompactions + previousSummary).
  #findPreviousSummary(): string | undefined {
    const events = this.#log.all();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "compaction") return event.summary;
    }
    return undefined;
  }

  #buildSummaryPrompt(
    contextText: string,
    previousSummary: string | undefined,
    instructions: string | undefined,
  ): string {
    const focus = instructions ? `\n\nAdditional focus requested by the user: ${instructions}` : "";
    const conversation = `Here is the conversation so far:\n\n<conversation>\n${contextText}\n</conversation>`;
    if (!previousSummary) {
      return [
        conversation,
        "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
        SUMMARY_TEMPLATE,
        focus,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    return [
      conversation,
      `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${previousSummary}\n</prior-summary>`,
      SUMMARY_UPDATE_INSTRUCTIONS,
      SUMMARY_TEMPLATE,
      focus,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  #mergePrompt(partials: string[], previousSummary: string | undefined): string {
    const context = partials.map((p, i) => `Partial ${i + 1}:\n${p}`).join("\n\n---\n\n");
    const prior = previousSummary
      ? `\n\nHere is the earlier summary to fold in:\n\n<prior-summary>\n${previousSummary}\n</prior-summary>`
      : "";
    return `Merge these partial conversation summaries into one coherent summary.${prior}\n\n${context}\n\n${SUMMARY_TEMPLATE}`;
  }

  // Summarize the head. Single call when it fits the top budget; otherwise
  // chunk the head, summarize each piece, and merge (map-reduce fallback).
  async #summarizeHead(
    head: ChatMessage[],
    previousSummary: string | undefined,
    instructions: string | undefined,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const budget = this.#topBudget();
    const headText = this.#serializeMessages(head);
    const fullPrompt = this.#buildSummaryPrompt(headText, previousSummary, instructions);
    if (this.#estimateTokens([{ role: "user", content: fullPrompt }]) <= budget) {
      const response = await this.#llm.complete({
        messages: [{ role: "user", content: fullPrompt }],
        tools: [],
        maxTokens: SUMMARY_OUTPUT_TOKENS,
        ...(this.#summarySid ? { sessionId: this.#summarySid } : {}),
      });
      return { text: response.text, usage: response.usage };
    }
    const chunks = this.#chunkMessages(head, budget);
    const partials: string[] = [];
    let usage: TokenUsage | undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      const first = i === 0;
      const prompt = this.#buildSummaryPrompt(
        this.#serializeMessages(chunks[i]),
        first ? previousSummary : undefined,
        first ? instructions : undefined,
      );
      const response = await this.#llm.complete({
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: SUMMARY_OUTPUT_TOKENS,
        ...(this.#summarySid ? { sessionId: this.#summarySid } : {}),
      });
      if (response.text.trim()) partials.push(response.text.trim());
      usage = addUsage(usage, response.usage);
    }
    if (partials.length === 0) return { text: "", usage };
    if (partials.length === 1) return { text: partials[0], usage };
    const merged = await this.#llm.complete({
      messages: [{ role: "user", content: this.#mergePrompt(partials, previousSummary) }],
      tools: [],
      maxTokens: SUMMARY_OUTPUT_TOKENS,
      ...(this.#summarySid ? { sessionId: this.#summarySid } : {}),
    });
    return { text: merged.text, usage: addUsage(usage, merged.usage) };
  }

  #compactOrSkip(
    turnId: string,
  ): Promise<{ usage: TokenUsage | undefined; applied: boolean }> {
    return this.#compact(turnId, { trigger: "auto" }).catch((err) => {
      // Auto-compaction must never be a silent no-op: a skipped compact on a
      // bloated session snowballs into minute-long model responses. One
      // stderr line keeps the failure diagnosable without a debug flag.
      process.stderr.write(
        `[aih] auto-compaction failed (continuing without it): ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return { usage: undefined, applied: false };
    });
  }

  async #compact(
    turnId: string,
    opts?: { instructions?: string; trigger?: "auto" | "manual" },
  ): Promise<{ usage: TokenUsage | undefined; applied: boolean }> {
    const previousSummary = this.#findPreviousSummary();
    const messages = this.#log.deriveMessages(this.#systemPrompt);
    const conversation = messages.filter((m) => m.role !== "system");
    let { head, recent } = this.#selectHeadTail(conversation, this.#preserveRecentBudget());
    // If there is no older head to summarize: a manual request still compacts
    // the whole conversation (so it always makes progress, or refreshes the
    // rolling summary); an auto one is a no-op because the context is already
    // small enough to keep verbatim.
    if (head.length === 0) {
      const canManual =
        opts?.trigger === "manual" && (conversation.length > 0 || previousSummary !== undefined);
      if (!canManual) return { usage: undefined, applied: false };
      head = conversation;
      recent = [];
    }
    // P#36⑤ — summary-call isolation: auxiliary calls run on their own
    // session identity ("{sid}" header → fresh id), keeping gateway-side
    // per-session state and the main conversation's prompt-cache lineage
    // free of summary traffic. The mock adapter ignores the field.
    this.#summarySid ??= `aih-compact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Fold authoritative current state (e.g. todo list) into the summary so a
    // compacted agent never forgets what is already done vs still pending.
    const contextSnapshot = this.#compactContext?.()?.trim();
    const effectiveInstructions = [
      opts?.instructions?.trim(),
      contextSnapshot
        ? `Authoritative CURRENT STATE (carry this forward verbatim; it overrides any stale "Objective" entry in the summary):\n${contextSnapshot}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { text, usage } = await this.#summarizeHead(head, previousSummary, effectiveInstructions || undefined);
    if (!text.trim()) return { usage, applied: false };
    // User-query invariant (opencode/MiMo-Code "replay"): the compaction must
    // never strand the conversation without a visible user turn — strict chat
    // templates (Qwen3: "No user query found in messages") 400 otherwise.
    // When the tail selection came back empty, this turn's user message was
    // folded into the summarized head; replay it verbatim as the new tail
    // (synthetic continue prompt if the session has no user message at all).
    if (recent.length === 0) {
      const turnUsers = this.#log
        .all()
        .filter((e): e is Extract<SessionEvent, { type: "user/message" }> =>
          e.type === "user/message" && e.turnId === turnId,
        );
      const last = turnUsers[turnUsers.length - 1];
      recent = [
        { role: "user", content: last ? last.text : COMPACT_CONTINUE_PROMPT },
      ];
    }
    // MK#42: coverage stamp — the summary claims the ordered prefix through
    // the log's current head. deriveMessages verifies this digest before
    // honoring the projection.
    const allEvents = this.#log.all();
    const upToSeq = allEvents[allEvents.length - 1]?.seq ?? 0;
    const coverage = {
      upToSeq,
      digest: coverageDigest(allEvents.filter((e) => e.seq <= upToSeq)),
    };
    this.#log.append({
      type: "compaction",
      turnId,
      summary: text.slice(0, 12000),
      coverage,
      ...(recent.length > 0 ? { recent } : {}),
      ...(opts?.trigger ? { trigger: opts.trigger } : {}),
      // Stamp the post-compaction context size (estimate of the projected
      // message list AFTER the append below — computed from the summary text
      // + tail we are about to persist). UI/resume read this instead of the
      // stale pre-compaction turn/end usage.
      contextAfter: this.#estimateContextWith({
        summary: text.slice(0, 12000),
        recent: recent.length > 0 ? recent : undefined,
        upToSeq: coverage.upToSeq,
      }),
    });
    // FA#5 — notify observers that the context was compacted.
    notifyObservers(this.#observers, (o) => o.onCompaction?.(turnId, text.length));
    return { usage, applied: true };
  }
}

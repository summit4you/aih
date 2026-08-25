import type { LLMAdapter } from "./seams/llm.js";
import { COMPACT_CONTINUE_PROMPT, EMPTY_RETRY_PROMPT, MAX_STEPS_PROMPT } from "./prompts.js";

/** Max consecutive empty responses (no text + no tool call) we nudge the model to retry before ending the turn. */
const MAX_EMPTY_RETRIES = 2;
import { SessionLog } from "./session-log.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatMessage, SessionEvent, TokenUsage, ToolCall, TurnResult } from "./types.js";

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
}

const CONTEXT_ERROR =
  /(maximum context|context length|context_length|prompt is too long|too many tokens|maximum number of tokens|exceeds? (the )?(longest )?maximum|requested \d+ tokens)/i;

// Compaction design aligned with opencode / MiMo-Code (session/compaction.ts,
// core/session/compaction.ts, overflow.ts):
//  - keep a recent tail VERBATIM (not summarized) so the agent retains the most
//    recent context, and summarize only the older head;
//  - rolling summary: each new summary folds in the previous one;
//  - a structured summary template;
//  - tool outputs truncated when serialized for the summary input.
const TOOL_OUTPUT_MAX_CHARS = 2_000; // opencode: TOOL_OUTPUT_MAX_CHARS
const MAX_RECENT_TOKENS = 15_000;   // opencode: MAX_PRESERVE_RECENT_TOKENS
const MIN_RECENT_TOKENS = 500;      // floor for the verbatim recent tail
const RESERVED_RATIO = 0.2;         // fraction of the window reserved for output

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
- Do not mention the summary process or that context was compacted.`;

const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`;

export class AgentLoop {
  #llm: LLMAdapter;
  #tools: ToolRegistry;
  #log: SessionLog;
  #systemPrompt: string;
  #maxSteps: number;
  #contextWindow: number;
  #compactAt: number;
  #readConcurrency: number;
  #onPromptInput?: (messages: ChatMessage[]) => void;
  #inbox: string[] = [];
  #activeAbort: AbortController | null = null;

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
    this.#readConcurrency = Math.max(
      1,
      Math.floor(options.readConcurrency ?? (Number(process.env.AIH_TOOL_CONCURRENCY ?? "") || 4)),
    );
    this.#onPromptInput = options.onPromptInput;
  }

  get log(): SessionLog {
    return this.#log;
  }

  inject(context: string): void {
    this.#inbox.push(context);
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
    hooks?: { onDelta?: (delta: string) => void; onRetry?: (attempt: number, error: unknown) => void },
  ): Promise<TurnResult> {
    const turnId = `turn_${Date.now().toString(36)}`;
    const ac = new AbortController();
    this.#activeAbort = ac;
    this.#log.append({ type: "turn/start", turnId });
    this.#log.append({ type: "user/message", turnId, text });
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

    while (steps < this.#maxSteps && !ac.signal.aborted) {
      steps += 1;
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
      let response;
      try {
        response = await doComplete();
      } catch (err) {
        if (ac.signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        if (!CONTEXT_ERROR.test(message)) throw err;
        const c = await this.#compact(turnId);
        if (c.usage) usage = addUsage(usage, c.usage);
        if (c.applied) contextNow = this.#estimateContext();
        response = await doComplete();
      }
      usage = addUsage(usage, response.usage);
      if (typeof response.genMs === "number") genMs += response.genMs;
      const promptTokens = response.usage?.promptTokens ?? 0;
      if (promptTokens > contextTokens) contextTokens = promptTokens;
      if (promptTokens > 0) contextNow = promptTokens;

      this.#log.append({
        type: "assistant/message",
        turnId,
        text: response.text,
        toolCalls: response.toolCalls,
      });

      const shouldCompact =
        this.#contextWindow > 0 && promptTokens >= this.#compactAt * this.#contextWindow;

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
            });
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
          }
          i = j;
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

      if (shouldCompact) {
        const c = await this.#compactOrSkip(turnId);
        if (c.usage) usage = addUsage(usage, c.usage);
        if (c.applied) contextNow = this.#estimateContext();
      }
    }

    if (ac.signal.aborted) stopReason = "cancelled";
    else if (steps >= this.#maxSteps) stopReason = "max_steps";
    else if (truncated) stopReason = "max_tokens";

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

  #estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      chars += m.content.length + (m.toolCalls?.length ?? 0) * 32;
    }
    return Math.max(1, Math.round(chars / 4));
  }

  #estimateContext(): number {
    return this.#estimateTokens(this.#log.deriveMessages(this.#systemPrompt));
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
      });
      if (response.text.trim()) partials.push(response.text.trim());
      usage = addUsage(usage, response.usage);
    }
    if (partials.length === 0) return { text: "", usage };
    if (partials.length === 1) return { text: partials[0], usage };
    const merged = await this.#llm.complete({
      messages: [{ role: "user", content: this.#mergePrompt(partials, previousSummary) }],
      tools: [],
    });
    return { text: merged.text, usage: addUsage(usage, merged.usage) };
  }

  #compactOrSkip(
    turnId: string,
  ): Promise<{ usage: TokenUsage | undefined; applied: boolean }> {
    return this.#compact(turnId).catch(() => ({ usage: undefined, applied: false }));
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
    const { text, usage } = await this.#summarizeHead(head, previousSummary, opts?.instructions);
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
    this.#log.append({
      type: "compaction",
      turnId,
      summary: text.slice(0, 12000),
      ...(recent.length > 0 ? { recent } : {}),
      ...(opts?.trigger ? { trigger: opts.trigger } : {}),
    });
    return { usage, applied: true };
  }
}

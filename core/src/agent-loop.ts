import type { LLMAdapter } from "./seams/llm.js";
import { SessionLog } from "./session-log.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatMessage, TokenUsage, TurnResult } from "./types.js";

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export interface AgentLoopOptions {
  llm: LLMAdapter;
  tools: ToolRegistry;
  log?: SessionLog;
  systemPrompt?: string;
  maxStepsPerTurn?: number;
  contextWindow?: number;
  compactAt?: number;
}

const CONTEXT_ERROR =
  /(maximum context|context length|context_length|prompt is too long|too many tokens|maximum number of tokens|exceeds? (the )?(longest )?maximum|requested \d+ tokens)/i;

const COMPACT_PROMPT =
  "Summarize the conversation above so the work can continue without the original messages. " +
  "Preserve: the user's goals, decisions and constraints, key facts (paths, values, names), " +
  "completed steps, and pending steps. Be dense and factual; no preamble.";

const TAIL_KEEP = 40;

export class AgentLoop {
  #llm: LLMAdapter;
  #tools: ToolRegistry;
  #log: SessionLog;
  #systemPrompt: string;
  #maxSteps: number;
  #contextWindow: number;
  #compactAt: number;
  #inbox: string[] = [];
  #activeAbort: AbortController | null = null;

  constructor(options: AgentLoopOptions) {
    this.#llm = options.llm;
    this.#tools = options.tools;
    this.#log = options.log ?? new SessionLog();
    this.#systemPrompt = options.systemPrompt ?? "";
    this.#maxSteps = options.maxStepsPerTurn ?? 8;
    this.#contextWindow = options.contextWindow ?? 0;
    this.#compactAt = options.compactAt ?? 0.8;
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

  async send(
    text: string,
    hooks?: { onDelta?: (delta: string) => void; onRetry?: (attempt: number, error: unknown) => void },
  ): Promise<TurnResult> {
    const turnId = `turn_${Date.now().toString(36)}`;
    const ac = new AbortController();
    this.#activeAbort = ac;
    this.#log.append({ type: "turn/start", turnId });
    this.#log.append({ type: "user/message", turnId, text });

    let steps = 0;
    let stopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let contextTokens = 0;
    let contextNow = 0;
    let truncated = false;

    while (steps < this.#maxSteps && !ac.signal.aborted) {
      steps += 1;
      const doComplete = (messages?: ChatMessage[]) =>
        this.#llm.complete({
          messages: messages ?? this.#log.deriveMessages(this.#systemPrompt),
          tools: this.#tools.schemas(),
          ...(hooks?.onDelta ? { onDelta: hooks.onDelta } : {}),
          ...(hooks?.onRetry ? { onRetry: hooks.onRetry } : {}),
          signal: ac.signal,
        });
      let response;
      try {
        response = await doComplete();
      } catch (err) {
        if (ac.signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        if (!CONTEXT_ERROR.test(message)) throw err;
        const c = await this.#compact(turnId, { tailOnly: true });
        if (c.usage) usage = addUsage(usage, c.usage);
        if (c.applied) contextNow = this.#estimateContext();
        response = await doComplete(this.#log.deriveMessages(this.#systemPrompt));
      }
      usage = addUsage(usage, response.usage);
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
        if (shouldCompact) {
          const c = await this.#compactOrSkip(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
        }
        break;
      }

      if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
        if (shouldCompact) {
          const c = await this.#compactOrSkip(turnId);
          if (c.usage) usage = addUsage(usage, c.usage);
          if (c.applied) contextNow = this.#estimateContext();
        }
        break;
      }

      for (const call of response.toolCalls) {
        if (ac.signal.aborted) break;
        this.#log.append({
          type: "tool/call",
          turnId,
          callId: call.id,
          name: call.name,
          args: call.args,
        });
        const outcome = await this.#tools.invoke(call.name, call.args, {
          turnId,
          inject: (ctxText) => this.inject(ctxText),
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

  #estimateContext(): number {
    let chars = 0;
    for (const m of this.#log.deriveMessages(this.#systemPrompt)) {
      chars += m.content.length + (m.toolCalls?.length ?? 0) * 32;
    }
    return Math.max(1, Math.round(chars / 4));
  }

  #compactOrSkip(
    turnId: string,
  ): Promise<{ usage: TokenUsage | undefined; applied: boolean }> {
    return this.#compact(turnId).catch(() => ({ usage: undefined, applied: false }));
  }

  async #compact(
    turnId: string,
    opts?: { tailOnly?: boolean },
  ): Promise<{ usage: TokenUsage | undefined; applied: boolean }> {
    let base = this.#log.deriveMessages(this.#systemPrompt);
    if (opts?.tailOnly && base.length > TAIL_KEEP) {
      const head = base[0]?.role === "system" ? [base[0]] : [];
      base = [...head, ...base.slice(base.length - TAIL_KEEP)];
    }
    const response = await this.#llm.complete({
      messages: [...base, { role: "user", content: COMPACT_PROMPT }],
      tools: [],
    });
    if (!response.text.trim()) return { usage: response.usage, applied: false };
    this.#log.append({
      type: "compaction",
      turnId,
      summary: response.text.slice(0, 12000),
    });
    return { usage: response.usage, applied: true };
  }
}

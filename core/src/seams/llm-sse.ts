/**
 * TP#2 — 零依赖 SSE 流解析模块。
 *
 * 从 core/src/seams/llm-openai.ts 的 consumeStream 抽出并扩展三处语义：
 *   ① reasoning_content 思考流字段（opencode openai-chat.ts MIT attribution）
 *   ② finish_reason 到达时 eager finalize 工具参数（不等流结束）
 *   ③ provider 错误分类学（retryable / capacity / fatal）
 *
 * Stall-detection hooks 留在 llm-openai.ts 的调用侧——此处只提供 onFirstToken
 * 和 onStall 回调接口，不绑任何超时逻辑（超时策略由 AgentLoop 层决策）。
 *
 * MIT License — 语义对照 opencode packages/llm/src/protocols/openai-chat.ts
 * (Copyright (c) 2025 opencode) 移植，非代码复制。
 */

import type { TokenUsage, ToolCall } from "../types.js";

// ── SSE delta type (typed, not `any`) ──────────────────────────────────

interface SSEChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChoice {
  delta?: SSEChoiceDelta;
  finish_reason?: string | null;
}

interface SSEUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cached_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SSEChunk {
  choices?: SSEChoice[];
  usage?: SSEUsage;
  [k: string]: unknown;
}

// ── Accumulator result ─────────────────────────────────────────────────

export interface StreamAccumulator {
  /** Final concatenated text content. */
  text: string;
  /** Final concatenated reasoning/thinking content. */
  reasoning: string;
  /** Eagerly finalized tool calls (built as finish_reason arrives). */
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
  /** Whether eager-finalize already built tool calls before stream ended. */
  eagerFinalized: boolean;
  /** Internal: per-index tool call accumulation frames. */
  toolFrames: Map<number, { id: string; name: string; args: string }>;
}

// ── Parse options ──────────────────────────────────────────────────────

export interface ParseOptions {
  /** Called with each text delta chunk (streaming to TUI). */
  onDelta?: (delta: string) => void;
  /** Called with each reasoning delta chunk (opencode reasoning_content). */
  onReasoning?: (delta: string) => void;
  /** Fired once when first data frame arrives (for stall detection). */
  onFirstToken?: () => void;
}

// ── Core parser ────────────────────────────────────────────────────────

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { _raw: raw };
  }
}

/**
 * Parse a single SSE JSON data frame and update the accumulator.
 * Exported for unit testing individual frame handling.
 */
export function parseFrame(
  data: string,
  acc: StreamAccumulator,
  opts: ParseOptions,
  firstFrameFired: { value: boolean },
): void {
  if (data === "[DONE]") return;

  let json: SSEChunk;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }

  const choice = json.choices?.[0];

  // finish_reason → eager finalize tool args (CC#49 semantic ②)
  if (choice?.finish_reason) {
    acc.finishReason = choice.finish_reason;
    // Accumulate any tool_call deltas from THIS frame first
    accumulateToolCalls(choice.delta?.tool_calls ?? [], acc);
    // Eager finalize: if tool_frames exist, build toolCalls immediately — no waiting for [DONE].
    if (acc.toolFrames.size > 0 && !acc.eagerFinalized) {
      acc.toolCalls = [...acc.toolFrames.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, frame]) => ({
          id: frame.id,
          name: frame.name,
          args: parseArguments(frame.args),
        }));
      acc.eagerFinalized = true;
    }
  }

  const delta = choice?.delta;

  // text content
  if (typeof delta?.content === "string" && delta.content) {
    acc.text += delta.content;
    opts.onDelta?.(delta.content);
  }

  // reasoning_content (CC#49 semantic ① — opencode openai-chat.ts MIT)
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    acc.reasoning += delta.reasoning_content;
    opts.onReasoning?.(delta.reasoning_content);
  }

  // tool call accumulation
  accumulateToolCalls(delta?.tool_calls ?? [], acc);

  // usage
  if (json.usage) {
    acc.usage = mapUsage(json.usage);
  }

  // first-token signal
  if (!firstFrameFired.value) {
    firstFrameFired.value = true;
    opts.onFirstToken?.();
  }
}

function accumulateToolCalls(
  tcs: NonNullable<SSEChoiceDelta["tool_calls"]>,
  acc: StreamAccumulator,
): void {
  for (const tc of tcs) {
    const frame = acc.toolFrames.get(tc.index) ?? { id: "", name: "", args: "" };
    if (tc.id) frame.id = tc.id;
    if (tc.function?.name) frame.name += tc.function.name;
    if (tc.function?.arguments) frame.args += tc.function.arguments;
    acc.toolFrames.set(tc.index, frame);
  }
}

/**
 * Consume an SSE response body stream and return the fully accumulated result.
 * This is the main entry point — equivalent to the old consumeStream but with
 * reasoning support and eager finalize.
 */
export async function consumeSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: ParseOptions = {},
): Promise<StreamAccumulator> {
  const acc: StreamAccumulator = {
    text: "",
    reasoning: "",
    toolCalls: [],
    finishReason: undefined,
    usage: undefined,
    eagerFinalized: false,
    toolFrames: new Map(),
  };
  const decoder = new TextDecoder();
  let buffer = "";
  const firstFrameFired = { value: false };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      parseFrame(data, acc, opts, firstFrameFired);
    }
  }

  // Finalize tool calls if not already eager-finalized
  if (!acc.eagerFinalized && acc.toolFrames.size > 0) {
    acc.toolCalls = [...acc.toolFrames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, frame]) => ({
        id: frame.id,
        name: frame.name,
        args: parseArguments(frame.args),
      }));
  }

  return acc;
}

// ── Usage mapper ───────────────────────────────────────────────────────

function mapUsage(u: SSEUsage): TokenUsage {
  const prompt = u.prompt_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  const cached =
    Number(
      u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? 0,
    );
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u.total_tokens ?? prompt + completion,
    ...(cached > 0 ? { cachedTokens: cached } : {}),
  };
}

// ── Provider error classification (CC#49 semantic ③) ──────────────────

/**
 * Classify an HTTP error from a provider endpoint.
 *
 * Returns:
 *   "retryable"  — transient network / server errors (408, 429, 5xx)
 *   "capacity"   — provider is overloaded; retry with extended budget
 *   "auth"       — invalid key / expired token; do not retry
 *   "fatal"      — everything else (model not found, context too long, etc.)
 */
export type ProviderErrorClass = "retryable" | "capacity" | "auth" | "fatal";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const AUTH_STATUS = new Set([401, 403]);
const CAPACITY_RE = /upstream request failed|endpoint is unavailable|no healthy upstream|service unavailable|overloaded|at capacity/i;

export function classifyProviderError(
  status: number,
  body: string,
): ProviderErrorClass {
  if (AUTH_STATUS.has(status)) return "auth";
  if (CAPACITY_RE.test(body)) return "capacity";
  if (RETRYABLE_STATUS.has(status)) return "retryable";
  return "fatal";
}

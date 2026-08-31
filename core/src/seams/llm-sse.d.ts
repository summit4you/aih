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
interface SSEChoiceDelta {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
            name?: string;
            arguments?: string;
        };
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
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    cached_tokens?: number;
    cache_read_input_tokens?: number;
}
export interface SSEChunk {
    choices?: SSEChoice[];
    usage?: SSEUsage;
    [k: string]: unknown;
}
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
    toolFrames: Map<number, {
        id: string;
        name: string;
        args: string;
    }>;
}
export interface ParseOptions {
    /** Called with each text delta chunk (streaming to TUI). */
    onDelta?: (delta: string) => void;
    /** Called with each reasoning delta chunk (opencode reasoning_content). */
    onReasoning?: (delta: string) => void;
    /** Fired once when first data frame arrives (for stall detection). */
    onFirstToken?: () => void;
    /**
     * CC#49 — fired on EVERY observed stream activity (each data frame line).
     * The caller (llm-openai) resets its inter-frame stall timer on this.
     */
    onActivity?: () => void;
    /**
     * FA#3 — reasoning-runaway watchdog. When set, a reasoning-only stream
     * (no text, no tool call yet) that exceeds `maxChars` of reasoning or
     * `timeoutMs` of elapsed time throws ReasoningRunawayError. Omit to disable.
     */
    reasoningWatchdog?: {
        maxChars: number;
        timeoutMs: number;
    };
}
/**
 * CC#49 — the stream went silent past the stall budget AFTER partial content
 * had already arrived. Carries what was received so the turn can resume
 * honestly ("[stream interrupted] continue from where you left off") instead
 * of losing the partial answer or presenting it as complete.
 */
/**
 * FA#3 — the stream produced ONLY reasoning (no text, no tool call) past the
 * reasoning-only budget. Carries what was received so the caller can decide
 * whether to resume honestly or fold into the retry budget (mirrors StallError).
 */
export declare class ReasoningRunawayError extends Error {
    readonly reasoningChars: number;
    readonly elapsedMs: number;
    readonly limitChars: number;
    constructor(reasoningChars: number, elapsedMs: number, limitChars: number);
}
/**
 * FA#3 — pure decision: has a reasoning-only stream run away?
 *
 * A reasoning model that "thinks" forever without ever emitting content or a
 * tool call burns budget and stalls the turn. This fires when ALL of:
 *   - no text content yet AND no tool call yet (the stream is reasoning-only),
 *   - reasoning chars exceed `limitChars` (token-ish cap), OR
 *   - the reasoning-only phase has lasted longer than `timeoutMs`.
 *
 * Pure (no I/O, no Date.now) so it is unit-testable: callers pass `elapsedMs`.
 * Returns false when reasoning is not the only thing being produced (text or
 * a tool call has arrived) — that is a healthy stream, not a runaway.
 */
export declare function isReasoningRunaway(state: {
    reasoningChars: number;
    hasText: boolean;
    hasToolCall: boolean;
    elapsedMs: number;
}, limit: {
    maxChars: number;
    timeoutMs: number;
}): boolean;
export declare class StallError extends Error {
    /** Text received before the stall (may be empty). */
    partialText: string;
    constructor(partialText: string, silentMs: number);
}
/**
 * Parse a single SSE JSON data frame and update the accumulator.
 * Exported for unit testing individual frame handling.
 */
export declare function parseFrame(data: string, acc: StreamAccumulator, opts: ParseOptions, firstFrameFired: {
    value: boolean;
}): void;
/**
 * Consume an SSE response body stream and return the fully accumulated result.
 * This is the main entry point — equivalent to the old consumeStream but with
 * reasoning support and eager finalize.
 */
export declare function consumeSSEStream(body: ReadableStream<Uint8Array>, opts?: ParseOptions): Promise<StreamAccumulator>;
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
export declare function classifyProviderError(status: number, body: string): ProviderErrorClass;
/**
 * CC#51 — true when a 429 (or 402) is a quota/usage-window exhaustion rather
 * than a transient rate limit. `retryAfterSec` is the Retry-After header in
 * seconds (undefined when absent).
 */
export declare function isQuotaExhaustion(status: number, body: string, retryAfterSec?: number): boolean;
/**
 * CC#51 — a provider rejected the call because the usage window is spent.
 * Carries the reset horizon so the caller can wait + resume the SAME call.
 */
export declare class QuotaError extends Error {
    /** Seconds until the provider expects the window to reset (0 = unknown). */
    retryAfterSec: number;
    constructor(status: number, body: string, retryAfterSec: number);
}
export {};

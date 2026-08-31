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
export class ReasoningRunawayError extends Error {
    reasoningChars;
    elapsedMs;
    limitChars;
    constructor(reasoningChars, elapsedMs, limitChars) {
        super(`reasoning-only stream exceeded budget (${reasoningChars} reasoning chars, ` +
            `${elapsedMs}ms > limit ${limitChars} chars) — no content produced`);
        this.reasoningChars = reasoningChars;
        this.elapsedMs = elapsedMs;
        this.limitChars = limitChars;
        this.name = "ReasoningRunawayError";
    }
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
export function isReasoningRunaway(state, limit) {
    if (state.hasText || state.hasToolCall)
        return false; // healthy: content is flowing
    if (state.reasoningChars === 0)
        return false; // nothing yet — not a runaway
    if (state.reasoningChars > limit.maxChars)
        return true; // token-ish cap exceeded
    if (limit.timeoutMs > 0 && state.elapsedMs > limit.timeoutMs)
        return true; // time cap exceeded
    return false;
}
export class StallError extends Error {
    /** Text received before the stall (may be empty). */
    partialText;
    constructor(partialText, silentMs) {
        super(`stream stalled: no data for ${silentMs}ms`);
        this.name = "StallError";
        this.partialText = partialText;
    }
}
// ── Core parser ────────────────────────────────────────────────────────
function parseArguments(raw) {
    try {
        return JSON.parse(raw || "{}");
    }
    catch {
        return { _raw: raw };
    }
}
/**
 * Parse a single SSE JSON data frame and update the accumulator.
 * Exported for unit testing individual frame handling.
 */
export function parseFrame(data, acc, opts, firstFrameFired) {
    if (data === "[DONE]")
        return;
    let json;
    try {
        json = JSON.parse(data);
    }
    catch {
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
function accumulateToolCalls(tcs, acc) {
    for (const tc of tcs) {
        const frame = acc.toolFrames.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id)
            frame.id = tc.id;
        if (tc.function?.name)
            frame.name += tc.function.name;
        if (tc.function?.arguments)
            frame.args += tc.function.arguments;
        acc.toolFrames.set(tc.index, frame);
    }
}
/**
 * Consume an SSE response body stream and return the fully accumulated result.
 * This is the main entry point — equivalent to the old consumeStream but with
 * reasoning support and eager finalize.
 */
export async function consumeSSEStream(body, opts = {}) {
    const acc = {
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
    // FA#3 — reasoning-runaway watchdog (only when the caller opted in).
    const wd = opts.reasoningWatchdog;
    const startedAt = wd ? Date.now() : 0;
    for await (const chunk of body) {
        // CC#49 — every network chunk is activity; reset the caller's stall timer.
        opts.onActivity?.();
        buffer += decoder.decode(chunk, { stream: true });
        let newlineAt;
        while ((newlineAt = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineAt).trim();
            buffer = buffer.slice(newlineAt + 1);
            if (!line.startsWith("data:"))
                continue;
            const data = line.slice(5).trim();
            if (!data)
                continue;
            parseFrame(data, acc, opts, firstFrameFired);
            // FA#3 — check the watchdog after each frame (cheap pure check).
            if (wd) {
                const runaway = isReasoningRunaway({
                    reasoningChars: acc.reasoning.length,
                    hasText: acc.text.length > 0,
                    hasToolCall: acc.toolFrames.size > 0,
                    elapsedMs: Date.now() - startedAt,
                }, wd);
                if (runaway) {
                    throw new ReasoningRunawayError(acc.reasoning.length, Date.now() - startedAt, wd.maxChars);
                }
            }
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
function mapUsage(u) {
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? 0);
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: u.total_tokens ?? prompt + completion,
        ...(cached > 0 ? { cachedTokens: cached } : {}),
    };
}
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const AUTH_STATUS = new Set([401, 403]);
const CAPACITY_RE = /upstream request failed|endpoint is unavailable|no healthy upstream|service unavailable|overloaded|at capacity/i;
export function classifyProviderError(status, body) {
    if (AUTH_STATUS.has(status))
        return "auth";
    if (CAPACITY_RE.test(body))
        return "capacity";
    if (RETRYABLE_STATUS.has(status))
        return "retryable";
    return "fatal";
}
// ── Quota-exhaustion detection (CC#51) ─────────────────────────────────
//
// A "quota" 429 is NOT a transient rate limit: the provider's usage window
// is spent and will reset on a schedule (minutes, not seconds). Retrying it
// with the normal backoff budget just burns attempts and ends the turn with
// an error. Instead we want to WAIT for the reset and resume the SAME call
// (not re-run the turn).
//
// We distinguish quota from a plain rate-limit 429 by (roadmap CC#51 spec):
//   ① body keywords (quota / limit / credits), OR
//   ② a Retry-After header far larger than the normal backoff cap (≥60s) —
//      a provider telling us "come back in N minutes" is a quota window.
const QUOTA_RE = /quota|limit|credits/i;
/** Retry-After (seconds) at/above which a 429 is a quota window, not a blip. */
const QUOTA_RETRY_AFTER_SEC = 60;
/**
 * CC#51 — true when a 429 (or 402) is a quota/usage-window exhaustion rather
 * than a transient rate limit. `retryAfterSec` is the Retry-After header in
 * seconds (undefined when absent).
 */
export function isQuotaExhaustion(status, body, retryAfterSec) {
    if (status !== 429 && status !== 402)
        return false;
    if (QUOTA_RE.test(body))
        return true;
    if (retryAfterSec !== undefined && retryAfterSec >= QUOTA_RETRY_AFTER_SEC)
        return true;
    return false;
}
/**
 * CC#51 — a provider rejected the call because the usage window is spent.
 * Carries the reset horizon so the caller can wait + resume the SAME call.
 */
export class QuotaError extends Error {
    /** Seconds until the provider expects the window to reset (0 = unknown). */
    retryAfterSec;
    constructor(status, body, retryAfterSec) {
        super(`usage limit exhausted (HTTP ${status}): ${body.slice(0, 200)}` +
            (retryAfterSec > 0 ? ` — reset in ~${retryAfterSec}s` : ""));
        this.name = "QuotaError";
        this.retryAfterSec = retryAfterSec;
    }
}

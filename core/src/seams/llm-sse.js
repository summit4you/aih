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
        // Eager finalize: if tool_calls exist and args look complete (closing brace),
        // finalize immediately — no waiting for [DONE].
        const hasToolCalls = acc.toolCalls.length > 0 || (choice.delta?.tool_calls?.length ?? 0) > 0;
        if (hasToolCalls && !acc.eagerFinalized) {
            // Collect any remaining tool_call deltas from this frame first
            accumulateToolCalls(choice.delta?.tool_calls ?? [], acc);
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
    for await (const chunk of body) {
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
    // Strip internal map before returning
    const { toolFrames: _, ...result } = acc;
    return result;
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

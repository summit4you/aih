/**
 * TP#2 — Fake LLM Server (node:http)
 *
 * 基于 opencode 源码分析（packages/opencode/src/provider/openai-chat.test.ts）的脚本化设计。
 * 能力：
 *   ① 预设剧本式响应（顺序帧 → 流结束 / 异常）
 *   ② stall 故障注入（挂起超过指定毫秒后返回超时）
 *   ③ 断流测试（connection reset mid-stream）
 *   ④ 工具调用模拟（tool_calls + arguments 分帧发送）
 *   ⑤ reasoning_content 流模拟
 *   ⑥ 并发请求计数（验证重试逻辑）
 *   ⑦ 配置化延迟（帧间延迟、首帧延迟）
 *
 * 与 bench.ts 共享同一协议（POST /chat/completions）。
 * 此文件仅用于测试，不进生产。
 */
export interface SSEFrame {
    /** JSON payload to emit as `data: {payload}\n\n`. */
    payload: Record<string, unknown>;
    /** Delay in ms BEFORE emitting this frame (0 = immediate). */
    delay?: number;
}
export interface FakeLLMScenario {
    /** HTTP status code for the initial response. */
    status?: number;
    /** Body to return for non-200 status codes. */
    errorBody?: string;
    /** SSE frames to stream. Ignored if status !== 200. */
    frames?: SSEFrame[];
    /** If true, abort the connection mid-stream after all frames. */
    closeMidstream?: boolean;
    /** If set, stall (don't send anything) for this many ms, then return 504. */
    stallMs?: number;
    /** If set, stall for this many ms THEN start sending frames. */
    initialDelayMs?: number;
}
export interface FakeLLMOptions {
    /** Port to listen on (default: auto). */
    port?: number;
    /** Host to bind (default: 127.0.0.1). */
    host?: string;
}
export interface FakeLLMServer {
    /** The port the server is actually listening on. */
    port: number;
    /** Base URL for OpenAI-compatible requests. */
    baseUrl: string;
    /** Number of /chat/completions requests received. */
    requestCount: number;
    /** Headers from the most recent request. */
    lastRequestHeaders: Record<string, string>;
    /** Body from the most recent request. */
    lastRequestBody: Record<string, unknown> | null;
    /** Shut down the server. */
    close(): Promise<void>;
}
/**
 * Create a fake LLM server with a scriptable scenario queue.
 *
 * Usage:
 * ```ts
 * const srv = await createFakeLLMServer();
 * srv.enqueue({ frames: [{ payload: { choices: [{ delta: { content: "Hi" } }] } }] });
 * // ... use srv.baseUrl with AIH agent loop ...
 * console.log(srv.requestCount); // 1
 * await srv.close();
 * ```
 */
export declare function createFakeLLMServer(opts?: FakeLLMOptions): Promise<FakeLLMServer & {
    enqueue(s: FakeLLMScenario): void;
    clearQueue(): void;
}>;
/** Simple text response. */
export declare function textResponse(text: string): FakeLLMScenario;
/** Reasoning + text response (DeepSeek/QwQ style). */
export declare function reasoningResponse(thinking: string, answer: string): FakeLLMScenario;
/** Tool call response (single tool). */
export declare function toolCallResponse(callId: string, name: string, args: Record<string, unknown>): FakeLLMScenario;
/** Multi-turn script: queue multiple scenarios for sequential requests. */
export declare function multiTurnScript(...scenarios: FakeLLMScenario[]): FakeLLMScenario[];

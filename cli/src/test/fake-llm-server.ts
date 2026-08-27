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

import * as http from "node:http";

// ── Scenario types ─────────────────────────────────────────────────────

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

// ── Server ─────────────────────────────────────────────────────────────

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
export async function createFakeLLMServer(
  opts: FakeLLMOptions = {},
): Promise<FakeLLMServer & { enqueue(s: FakeLLMScenario): void; clearQueue(): void }> {
  const queue: FakeLLMScenario[] = [];
  let requestCount = 0;
  let lastHeaders: Record<string, string> = {};
  let lastBody: Record<string, unknown> | null = null;

  const server = http.createServer((req, res) => {
    // Collect request body
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requestCount++;
      lastHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        lastBody = null;
      }

      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, queue: queue.length, requests: requestCount }));
        return;
      }

      // Chat completions endpoint
      if (req.method === "POST" && req.url?.includes("/chat/completions")) {
        const scenario = queue.shift();
        if (!scenario) {
          // Default: empty successful response
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}]}\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const status = scenario.status ?? 200;

        // Non-200 error response
        if (status !== 200) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(scenario.errorBody ?? JSON.stringify({ error: { message: "fake error", type: "error" } }));
          return;
        }

        // Stall test: hang, then timeout
        if (scenario.stallMs && scenario.stallMs > 0) {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(504, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { message: "Gateway Timeout", type: "timeout" } }));
            }
          }, scenario.stallMs);
          return;
        }

        // SSE streaming response
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        });

        const sendFrames = async () => {
          const initialDelay = scenario.initialDelayMs ?? 0;
          if (initialDelay > 0) {
            await sleep(initialDelay);
          }

          const frames = scenario.frames ?? [];
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            if (frame.delay && frame.delay > 0) {
              await sleep(frame.delay);
            }
            if (res.writableEnded) break;
            res.write(`data: ${JSON.stringify(frame.payload)}\n\n`);
          }

          if (scenario.closeMidstream) {
            // Abrupt connection close — no [DONE]
            // Use res.end() after partial write to signal stream end cleanly;
            // the socket.destroy() is left to GC to avoid unhandled errors.
            res.end();
          } else {
            if (!res.writableEnded) {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          }
        };

        sendFrames().catch(() => {
          if (!res.writableEnded) res.end();
        });
        return;
      }

      // 404 for unknown routes
      res.writeHead(404);
      res.end("Not Found");
    });
  });

  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        baseUrl: `http://${host}:${port}`,
        get requestCount() {
          return requestCount;
        },
        get lastRequestHeaders() {
          return lastHeaders;
        },
        get lastRequestBody() {
          return lastBody;
        },
        enqueue(s: FakeLLMScenario) {
          queue.push(s);
        },
        clearQueue() {
          queue.length = 0;
        },
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Scenario builders (convenience) ────────────────────────────────────

/** Simple text response. */
export function textResponse(text: string): FakeLLMScenario {
  return {
    frames: [
      { payload: { choices: [{ delta: { content: text }, finish_reason: null }] } },
      { payload: { choices: [{ delta: {}, finish_reason: "stop" }] } },
    ],
  };
}

/** Reasoning + text response (DeepSeek/QwQ style). */
export function reasoningResponse(thinking: string, answer: string): FakeLLMScenario {
  return {
    frames: [
      {
        payload: {
          choices: [
            { delta: { reasoning_content: thinking }, finish_reason: null },
          ],
        },
      },
      {
        payload: {
          choices: [
            { delta: { content: answer }, finish_reason: null },
          ],
        },
      },
      {
        payload: {
          choices: [
            { delta: {}, finish_reason: "stop" },
          ],
        },
      },
    ],
  };
}

/** Tool call response (single tool). */
export function toolCallResponse(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): FakeLLMScenario {
  const argsStr = JSON.stringify(args);
  const mid = Math.floor(argsStr.length / 2);
  return {
    frames: [
      {
        payload: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: callId, type: "function", function: { name, arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        payload: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: argsStr.slice(0, mid) } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
      {
        payload: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: argsStr.slice(mid) } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
    ],
  };
}

/** Multi-turn script: queue multiple scenarios for sequential requests. */
export function multiTurnScript(...scenarios: FakeLLMScenario[]): FakeLLMScenario[] {
  return scenarios;
}

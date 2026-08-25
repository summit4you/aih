import { randomBytes } from "node:crypto";
import type {
  ChatMessage,
  LLMRequest,
  LLMResponse,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from "../types.js";
import type { LLMAdapter } from "./llm.js";

/**
 * Generate a 26-char id body in opencode's exact format (src/id/id.ts `create()`):
 *   12 hex chars = (Date.now() × 4096 + counter) big-endian, 6 bytes
 *     - high 44 bits: millisecond timestamp
 *     - low  12 bits: per-millisecond counter (0-4095, resets when ms changes)
 *   + 14 random base62 chars (randomBytes(14) % 62)
 * The counter guarantees distinct ids even when two are minted in the same ms.
 */
let idLastTs = 0;
let idCounter = 0;
function opencodeIDBody(): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let rand = "";
  const bytes = randomBytes(14);
  for (let i = 0; i < 14; i++) rand += chars[bytes[i] % 62];
  const ts = Date.now();
  if (ts !== idLastTs) {
    idLastTs = ts;
    idCounter = 0;
  }
  idCounter++;
  const now = BigInt(ts) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  return timeBytes.toString("hex") + rand;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  /** bearer key; optional for providers that authenticate by client identity (headers) */
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  /** extra request headers sent with every completion call (e.g. client identity) */
  headers?: Record<string, string>;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITool(schema: ToolSchema) {
  return {
    type: "function" as const,
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  };
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { _raw: raw };
  }
}

export class OpenAICompatibleLLM implements LLMAdapter {
  #options: OpenAICompatibleOptions;
  #fetch: typeof fetch;
  /** Stable id minted once per client instance; "{sid}" headers keep it across requests. */
  #sid: string;

  constructor(options: OpenAICompatibleOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sid = opencodeIDBody();
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now(); // F#30: per-request generation span
    const { baseUrl, apiKey, model } = this.#options;
    // Materialize header placeholders per request (opencode id format: 12 hex ts + 14 base62):
    //  - "{sid}"  → a stable id minted once per client instance (session identity,
    //               e.g. opencode's x-opencode-session — must not change mid-conversation
    //               or the server loses its per-session state).
    //  - "{rand}" → a fresh id on every request (request identity, e.g. x-opencode-request).
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#options.headers ?? {})) {
      let out = v;
      if (out.includes("{sid}")) out = out.split("{sid}").join(this.#sid);
      if (out.includes("{rand}")) out = out.split("{rand}").join(opencodeIDBody());
      headers[k] = out;
    }
    const normalized = baseUrl
      .replace(/\/$/, "")
      .replace(/\/chat\/completions$/, "");
    const url = `${normalized}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map(toOpenAIMessage),
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAITool);
      body.tool_choice = "auto";
    }
    if (req.onDelta) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const payload = JSON.stringify(body);
    const maxAttempts = (this.#options.retries ?? DEFAULT_RETRIES) + 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with ±25% jitter, capped at 8s per gap. Zen's
        // free tier (and Cloudflare-fronted endpoints generally) fail in
        // bursts lasting tens of seconds ("Upstream request failed" /
        // connection resets); opencode survives the same bursts by retrying
        // far longer than a flat ~2s budget, so its users never see them.
        req.onRetry?.(attempt, lastError);
        await sleep(retryBackoffMs(attempt - 1));
      }
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...headers,
          },
          body: payload,
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        lastError = err;
        if (attempt < maxAttempts - 1) continue;
        throw err;
      }
      if (!res.ok) {
        const text = await res.text();
        const httpError = new Error(`llm request failed: HTTP ${res.status} ${text}`);
        if (RETRYABLE.has(res.status) && attempt < maxAttempts - 1) {
          lastError = httpError;
          continue;
        }
        throw httpError;
      }
      try {
        if (req.onDelta && res.body) {
          const acc = await consumeStream(res.body, req.onDelta);
          return {
            text: acc.text,
            toolCalls: acc.toolCalls,
            stopReason: acc.toolCalls.length > 0 ? "tool_use" : "end_turn",
            ...(acc.finishReason ? { finishReason: acc.finishReason } : {}),
            ...(acc.usage ? { usage: acc.usage } : {}),
            // F#30: real per-request generation time (request → last delta),
            // enabling a true streaming TPS metric (completion tokens / genMs).
            genMs: Math.max(0, Date.now() - startedAt),
          };
        }
        return toResponse(await res.json());
      } catch (err) {
        if (req.signal?.aborted) throw err;
        lastError = err;
        if (attempt < maxAttempts - 1) continue;
        throw err;
      }
    }
    throw lastError;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Default transient-failure retry budget: 7 attempts ≈ 20s of backoff. */
export const DEFAULT_RETRIES = 6;

/**
 * Backoff before retry `attempt` (0-based): 400ms doubling to an 8s cap,
 * with ±25% jitter so concurrent clients don't re-synchronize.
 */
export function retryBackoffMs(attempt: number): number {
  const base = Math.min(8000, 400 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StreamAccumulator {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<StreamAccumulator> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        text += delta.content;
        onDelta(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const acc = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(tc.index, acc);
      }
      if (json.usage) {
        usage = mapUsage(json.usage);
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({
      id: acc.id,
      name: acc.name,
      args: parseArguments(acc.args),
    }));
  return { text, toolCalls, finishReason, usage };
}

function mapUsage(u: any): TokenUsage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

function toResponse(data: any): LLMResponse {
  const message = data.choices?.[0]?.message ?? {};
  const finishReason: string | undefined = data.choices?.[0]?.finish_reason;
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    args: parseArguments(tc.function.arguments),
  }));
  const usage: TokenUsage | undefined = data.usage ? mapUsage(data.usage) : undefined;

  return {
    text: message.content ?? "",
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

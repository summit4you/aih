import { randomBytes } from "node:crypto";
import type {
  ChatMessage,
  ContentBlock,
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
  /**
   * Cap for the model's max_tokens (max output tokens) per request. Some free
   * tiers reject requests that ask for more output than the account can afford
   * (e.g. OpenRouter upstreams 503 when max_tokens > remaining quota) — send an
   * explicit cap to stay under it. Undefined → omit the field (provider default).
   */
  maxTokens?: number;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown> | ContentBlock>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessage(message: ChatMessage): OpenAIMessage {
  // Content-block form (multi-modal): pass through verbatim so providers
  // receive [{type:"text"}, {type:"image_url",...}] unchanged.
  const rawContent: string | ContentBlock[] | null = message.content ?? null;
  const content: OpenAIMessage["content"] = Array.isArray(rawContent)
    ? (rawContent as Array<Record<string, unknown> | ContentBlock>)
    : rawContent;
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content,
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
      content: typeof content === "string" ? content : (content ?? null),
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

// TP#2: Import consumeSSEStream and classifyProviderError from llm-sse.ts
import {
  consumeSSEStream,
  classifyProviderError,
  isQuotaExhaustion,
  QuotaError,
  StallError,
} from "./llm-sse.js";

// CC#49 — stream-stall guards. Headers received but no data frame within
// firstTokenMs, or silence between frames within stallMs → abort the request.
// 0 disables a guard. Defaults: first token 180s, inter-frame 60s.
const FIRST_TOKEN_TIMEOUT_MS = () =>
  Number(process.env.AIH_FIRST_TOKEN_TIMEOUT_MS ?? "") || 180_000;
const STALL_TIMEOUT_MS = () =>
  Number(process.env.AIH_STALL_TIMEOUT_MS ?? "") || 60_000;

/** Arm a stall watchdog: fires `fire` after `ms` unless disarmed/reset. */
function armStallTimer(ms: number, fire: () => void): { reset(): void; disarm(): void } {
  if (ms <= 0) return { reset() {}, disarm() {} };
  let handle: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, ms);
  return {
    reset() {
      if (handle) {
        clearTimeout(handle);
        handle = setTimeout(fire, ms);
      }
    },
    disarm() {
      if (handle) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
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
      // P#36: auxiliary calls (compaction summaries) carry their own
      // session id so "{sid}" resolves to the side-channel identity.
      if (out.includes("{sid}")) out = out.split("{sid}").join(req.sessionId ?? this.#sid);
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
    if (this.#options.maxTokens !== undefined) {
      body.max_tokens = this.#options.maxTokens;
    }
    if (req.thinking) {
      body.thinking = { type: "enabled" };
    }
    if (req.onDelta) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const payload = JSON.stringify(body);
    const maxAttempts = (this.#options.retries ?? DEFAULT_RETRIES) + 1;

    let lastError: unknown;
    let attempts = maxAttempts; // grows when a capacity-classified error shows up
    for (let attempt = 0; attempt < attempts; attempt += 1) {
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
        const cls = classifyProviderError(0, err instanceof Error ? err.message : String(err));
        if (cls === "capacity") {
          attempts = Math.max(attempts, maxAttempts * CAPACITY_ATTEMPT_FACTOR);
        }
        if (attempt < attempts - 1) continue;
        throw err;
      }
      if (!res.ok) {
        const text = await res.text();
        const message = `llm request failed: HTTP ${res.status} ${text}`;
        // CC#51 — a quota/usage-window 429 is NOT a transient blip: it resets
        // on a schedule (minutes). Throw QuotaError so the AgentLoop can wait
        // for the reset and re-issue the SAME call (instead of burning the
        // retry budget and ending the turn with an error).
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterNum = retryAfterRaw ? Number(retryAfterRaw) : NaN;
        const retryAfterSec = Number.isFinite(retryAfterNum) ? retryAfterNum : undefined;
        if (isQuotaExhaustion(res.status, text, retryAfterSec)) {
          throw new QuotaError(res.status, text, retryAfterSec ?? 0);
        }
        const cls = classifyProviderError(res.status, text);
        if (cls === "capacity") {
          attempts = Math.max(attempts, maxAttempts * CAPACITY_ATTEMPT_FACTOR);
        }
        const httpError = new Error(message);
        if ((cls === "retryable" || cls === "capacity") && attempt < attempts - 1) {
          lastError = httpError;
          continue;
        }
        throw httpError;
      }
      try {
        if (req.onDelta && res.body) {
          // CC#49 — stall watchdogs: (1) the first data frame must arrive
          // within AIH_FIRST_TOKEN_TIMEOUT_MS; (2) frames must keep flowing
          // within AIH_STALL_TIMEOUT_MS. Firing cancels the read, which ends
          // the for-await inside consumeSSEStream. With partial text we throw
          // StallError (the AgentLoop resumes honestly); with none we fold
          // into the normal retry budget below.
          //
          // The body is read through an explicit reader: res.body.cancel() is
          // REJECTED while the stream is locked by the parse loop ("Invalid
          // state: ReadableStream is locked") — only reader.cancel() can
          // settle the pending read (it resolves it as {done:true}).
          const reader = res.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              return reader.read().then((r) =>
                r.done ? controller.close() : controller.enqueue(r.value),
              );
            },
          });
          let stalled = false;
          let stallMs = 0;
          const fire = (ms: number) => {
            if (stalled) return;
            stalled = true;
            stallMs = ms;
            reader.cancel().catch(() => {});
          };
          const firstTimer = armStallTimer(FIRST_TOKEN_TIMEOUT_MS(), () => fire(FIRST_TOKEN_TIMEOUT_MS()));
          let stallTimer = armStallTimer(0, () => {});
          const activity = () => {
            // First activity disarms the first-token guard; every activity
            // re-arms the inter-frame guard.
            firstTimer.disarm();
            stallTimer.disarm();
            stallTimer = armStallTimer(STALL_TIMEOUT_MS(), () => fire(STALL_TIMEOUT_MS()));
          };
          let accOut: Awaited<ReturnType<typeof consumeSSEStream>>;
          try {
            accOut = await consumeSSEStream(body, {
              onDelta: req.onDelta,
              onReasoning: (req as any).onReasoning,
              onActivity: activity,
            });
          } finally {
            firstTimer.disarm();
            stallTimer.disarm();
          }
          if (stalled) {
            throw new StallError(accOut.text, stallMs);
          }
          return {
            text: accOut.text,
            toolCalls: accOut.toolCalls,
            stopReason: accOut.toolCalls.length > 0 ? "tool_use" : "end_turn",
            ...(accOut.finishReason ? { finishReason: accOut.finishReason } : {}),
            ...(accOut.usage ? { usage: accOut.usage } : {}),
            // F#30: real per-request generation time (request → last delta),
            // enabling a true streaming TPS metric (completion tokens / genMs).
            genMs: Math.max(0, Date.now() - startedAt),
          };
        }
        return toResponse(await res.json());
      } catch (err) {
        if (req.signal?.aborted) throw err;
        // CC#49 — a stall with partial content is NOT retryable-blind: the
        // caller (AgentLoop) resumes from the partial text. With NO content,
        // fold into the normal retry budget like any transient failure.
        if (err instanceof StallError) {
          if (err.partialText.trim() !== "") throw err;
          if (attempt < maxAttempts - 1) {
            lastError = err;
            continue;
          }
        } else if (attempt < maxAttempts - 1) {
          lastError = err;
          continue;
        }
        lastError = err;
        throw err;
      }
    }
    throw lastError;
  }
}

// TP#2: RETRYABLE / CAPACITY_ERROR / CAPACITY_ATTEMPT_FACTOR moved to llm-sse.ts classifyProviderError
// Kept as legacy re-export for backward compatibility.
const CAPACITY_ATTEMPT_FACTOR = 3;

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

// TP#2: consumeStream removed — replaced by consumeSSEStream from llm-sse.ts
// Re-export for backward compatibility if any caller imported it.
export { consumeSSEStream as consumeStream } from "./llm-sse.js";

function mapUsage(u: any): TokenUsage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...(Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens) > 0
      ? { cachedTokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens) }
      : {}),
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

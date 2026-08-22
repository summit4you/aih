import type {
  ChatMessage,
  LLMRequest,
  LLMResponse,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from "../types.js";
import type { LLMAdapter } from "./llm.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  retries?: number;
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

  constructor(options: OpenAICompatibleOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { baseUrl, apiKey, model } = this.#options;
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
    const maxAttempts = (this.#options.retries ?? 3) + 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        req.onRetry?.(attempt, lastError);
        await sleep(Math.min(2000, 400 * attempt));
      }
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
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

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

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

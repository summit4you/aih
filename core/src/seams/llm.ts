import type { ChatMessage, LLMRequest, LLMResponse, ToolCall, ToolSchema } from "../types.js";

export interface LLMAdapter {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class MockLLM implements LLMAdapter {
  #script: LLMResponse[];
  #cursor = 0;

  constructor(script: Array<Partial<LLMResponse>>) {
    this.#script = script.map((partial) => ({
      text: partial.text ?? "",
      toolCalls: partial.toolCalls ?? [],
      stopReason:
        partial.stopReason ??
        (partial.toolCalls && partial.toolCalls.length > 0
          ? "tool_use"
          : "end_turn"),
      ...(partial.finishReason !== undefined ? { finishReason: partial.finishReason } : {}),
      ...(partial.usage ? { usage: partial.usage } : {}),
    }));
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const next =
      this.#script[this.#cursor] ?? {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
      };
    this.#cursor += 1;
    if (req.onDelta && next.text) {
      for (const piece of next.text.match(/.{1,12}/gs) ?? []) {
        req.onDelta(piece);
      }
    }
    return next;
  }
}

export function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, name, args };
}

export type { ChatMessage, ToolSchema };

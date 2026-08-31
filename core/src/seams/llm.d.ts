import type { ChatMessage, LLMRequest, LLMResponse, ToolCall, ToolSchema } from "../types.js";
export interface LLMAdapter {
    complete(req: LLMRequest): Promise<LLMResponse>;
}
export declare class MockLLM implements LLMAdapter {
    #private;
    constructor(script: Array<Partial<LLMResponse>>);
    complete(req: LLMRequest): Promise<LLMResponse>;
}
export declare function toolCall(id: string, name: string, args: unknown): ToolCall;
export type { ChatMessage, ToolSchema };

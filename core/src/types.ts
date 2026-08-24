export type PermissionAction = "allow" | "ask" | "deny";

export type ToolKind = "read" | "write";

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  items?: {
    type: string;
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    enum?: string[];
  };
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolContext {
  turnId: string;
  inject(text: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  kind: ToolKind;
  permission:
    | PermissionAction
    | ((args: unknown) => PermissionAction);
  parameters: ToolSchema["parameters"];
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export type SessionEvent =
  | { seq: number; ts: number; type: "turn/start"; turnId: string }
  | {
      seq: number;
      ts: number;
      type: "user/message";
      turnId: string;
      text: string;
    }
  | {
      seq: number;
      ts: number;
      type: "assistant/message";
      turnId: string;
      text: string;
      toolCalls: ToolCall[];
    }
  | {
      seq: number;
      ts: number;
      type: "tool/call";
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
    }
  | {
      seq: number;
      ts: number;
      type: "tool/result";
      turnId: string;
      callId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "compaction";
      turnId: string;
      summary: string;
      recent?: ChatMessage[];
      trigger?: "auto" | "manual";
    }
  | {
      seq: number;
      ts: number;
      type: "turn/end";
      turnId: string;
      stopReason: string;
      usage?: TokenUsage;
    }
  | {
      seq: number;
      ts: number;
      type: "goal/judge";
      turnId: string;
      met: boolean;
      reason: string;
      unmet: string[];
      roundsLeft?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "app/event";
      source: string;
      payload: unknown;
    };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  onDelta?: (delta: string) => void;
  onRetry?: (attempt: number, error: unknown) => void;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "tool_use" | "end_turn";
  finishReason?: string;
  usage?: TokenUsage;
}

export interface TurnResult {
  turnId: string;
  steps: number;
  stopReason: string;
  usage?: TokenUsage;
  contextTokens?: number;
  contextNow?: number;
}

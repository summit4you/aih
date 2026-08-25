export type PermissionAction = "allow" | "ask" | "deny";

export type ToolKind = "read" | "write";

/**
 * Git worktree snapshot attached to checkpoint events (F#28 increment):
 * branch, HEAD sha and a capped changed-file list captured at checkpoint time.
 * MK#47: `workspaceId` adds the LOGICAL workspace identity (stable UUID from
 * .aih/workspace.json) so restore/resume can prove "same workspace" across
 * path moves — path equality is diagnostic, uuid equality is the gate.
 */
export interface WorktreeSummary {
  /** Current branch name (`null` = detached HEAD or undetermined). */
  branch: string | null;
  /** Short HEAD sha (`null` = no commits yet or undetermined). */
  head: string | null;
  /** Changed files (status letter + path), capped at MAX_DIRTY_ENTRIES. */
  dirty: string[];
  /** Total number of changed files (>= dirty.length when capped). */
  dirtyCount: number;
  /** True when there are no local changes. */
  clean: boolean;
  /**
   * MK#47 — logical workspace identity (UUID from .aih/workspace.json).
   * Stable across path moves; a mismatch on restore means the checkpoint was
   * taken in a DIFFERENT workspace. Absent when identity could not be
   * established (no write access / marker unreadable) — unknown is advisory,
   * mismatch is the hard gate.
   */
  workspaceId?: string;
}

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
      type: "tool/dispatch";
      turnId: string;
      callId: string;
      name: string;
      /**
       * MK#44 (T1) — appended AFTER all preflight checks pass and BEFORE the
       * implementation runs. Model-invisible (deriveMessages skips it). A
       * crash between this event and the tool/result means the side effect
       * may have happened: recovery must treat that call as indeterminate,
       * never as "not executed". Calls with a result but no dispatch are
       * synthetic (length-truncation / cancel fill-ins) — provably never ran.
       */
    }
  | {
      seq: number;
      ts: number;
      type: "tool/dispatch";
      turnId: string;
      callId: string;
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
      /**
       * Estimated prompt-token size of the projected (post-compaction)
       * message list, stamped when the event is written. UI/resume seeds the
       * context counter from this when the compaction is the newest
       * turn-boundary event — otherwise a model switch or `-c` resume flashes
       * the stale pre-compaction size (last turn/end predates the summary).
       */
      contextAfter?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "turn/end";
      turnId: string;
      stopReason: string;
      usage?: TokenUsage;
      /**
       * F#30: cumulative wall-clock ms the LLM spent generating this turn
       * (sum of per-request generation spans, measured at the LLM layer).
       * Absent for non-streaming / mock turns — streaming TPS then falls
       * back to the session-average metric.
       */
      genMs?: number;
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
      type: "checkpoint";
      /** Human label, e.g. "before risky refactor" (optional). */
      note?: string;
      /** Context-window usage snapshot at checkpoint time. */
      contextTokens?: number;
      /**
       * Git worktree snapshot at checkpoint time (F#28 increment): branch,
       * HEAD sha and capped changed-file list, so a restore point also tells
       * you what the code looked like. Absent when git is unavailable.
       */
      worktree?: WorktreeSummary;
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
  /**
   * F#30: wall-clock ms this response took to generate, as measured at the
   * LLM layer (start of the request → last streamed delta). Set only for
   * real streaming responses; non-streaming and mock responses omit it.
   */
  genMs?: number;
}

export interface TurnResult {
  turnId: string;
  steps: number;
  stopReason: string;
  usage?: TokenUsage;
  contextTokens?: number;
  contextNow?: number;
}

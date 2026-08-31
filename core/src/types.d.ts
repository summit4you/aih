export type PermissionAction = "allow" | "ask" | "deny";
/**
 * P#37 — session tree: every event may declare its parent event seq. The
 * default (undefined) means "child of the previous event", so existing
 * session files are already linear chains and need no migration. A fork or
 * restore sets parentId explicitly to the source event, creating a branch.
 */
export interface SessionTreeNode {
    parentId?: number;
}
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
    permission: PermissionAction | ((args: unknown) => PermissionAction);
    parameters: ToolSchema["parameters"];
    execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}
export type SessionEvent = {
    seq: number;
    ts: number;
    type: "turn/start";
    turnId: string;
} | {
    seq: number;
    ts: number;
    type: "user/message";
    turnId: string;
    text: string;
} | {
    seq: number;
    ts: number;
    type: "assistant/message";
    turnId: string;
    text: string;
    toolCalls: ToolCall[];
} | {
    seq: number;
    ts: number;
    type: "tool/call";
    turnId: string;
    callId: string;
    name: string;
    args: unknown;
} | {
    seq: number;
    ts: number;
    type: "tool/dispatch";
    turnId: string;
    callId: string;
    name: string;
} | {
    seq: number;
    ts: number;
    type: "tool/result";
    turnId: string;
    callId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
} | {
    seq: number;
    ts: number;
    type: "compaction";
    turnId: string;
    summary: string;
    recent?: ChatMessage[];
    trigger?: "auto" | "manual";
    /**
     * MK#42 — coverage declaration: the summary claims to replace exactly
     * the ordered event prefix [0..upToSeq]. deriveMessages verifies the
     * digest against that prefix before honoring the projection; a mismatch
     * (file edited externally, cross-session fork) fails open to raw tail.
     */
    coverage?: {
        upToSeq: number;
        digest: string;
    };
    /**
     * Estimated prompt-token size of the projected (post-compaction)
     * message list, stamped when the event is written. UI/resume seeds the
     * context counter from this when the compaction is the newest
     * turn-boundary event — otherwise a model switch or `-c` resume flashes
     * the stale pre-compaction size (last turn/end predates the summary).
     */
    contextAfter?: number;
} | {
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
} | {
    seq: number;
    ts: number;
    type: "goal/judge";
    turnId: string;
    met: boolean;
    reason: string;
    unmet: string[];
    roundsLeft?: number;
    /** FB#6 — true when the verdict did not come from a clean single-judge call (two-judge panel disagreed / one judge failed). */
    degraded?: boolean;
} | {
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
} | {
    seq: number;
    ts: number;
    type: "branch_summary";
    /**
     * P#37 — distillation of an abandoned branch: what was learned on the
     * road not taken, injected at the fork point so the surviving branch
     * keeps the knowledge without the token cost. Model-visible as part of
     * the system prompt block (deriveMessages folds it in).
     */
    /** The source session this summary was distilled from. */
    fromSession?: string;
    /** Fork boundary the branch diverged at (seq in the SOURCE log). */
    fromSeq?: number;
    /** The distilled knowledge (≤ a few hundred words). */
    text: string;
} | {
    seq: number;
    ts: number;
    type: "app/event";
    source: string;
    payload: unknown;
};
export interface ContentBlock {
    type: "text" | "image_url";
    text?: string;
    image_url?: { url: string };
}
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentBlock[];
    toolCalls?: ToolCall[];
    toolCallId?: string;
    name?: string;
}
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /**
     * P#41 — tokens served from the provider's prompt cache (OpenAI
     * `prompt_tokens_details.cached_tokens`; Anthropic cache_read analog).
     * Absent/0 when the provider doesn't report it. Drives the cache-hit-rate
     * observation in /usage and the context panel.
     */
    cachedTokens?: number;
}
export interface LLMRequest {
    messages: ChatMessage[];
    tools: ToolSchema[];
    onDelta?: (delta: string) => void;
    onRetry?: (attempt: number, error: unknown) => void;
    signal?: AbortSignal;
    /**
     * Enable the provider's "thinking"/reasoning mode (e.g. zhipu's
     * `thinking: {type:"enabled"}`). Sent verbatim in the request body when
     * true; ignored by providers that don't support it.
     */
    thinking?: boolean;
    /**
     * P#36 — side-channel session identity for auxiliary calls (compaction
     * summaries). When set, "{sid}" header placeholders resolve to this id
     * instead of the client's stable session id, so gateway-side per-session
     * state (routing, caches keyed on the session header) treats the summary
     * traffic as a separate lane and the main conversation's cache lineage
     * stays clean.
     */
    sessionId?: string;
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

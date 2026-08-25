export { SessionLog } from "./session-log.js";
export type { SessionListener, SessionEventInput } from "./session-log.js";
export {
  classifyToolFacts,
  scanRecovery,
  describeFact,
  PARK_REASON,
} from "./recovery.js";
export type { ToolFact, ToolRecoveryState, RecoveryReport } from "./recovery.js";
export { SessionStore } from "./session-store.js";
export { AgentLoop } from "./agent-loop.js";
export type { AgentLoopOptions } from "./agent-loop.js";
export { ToolRegistry } from "./tool-registry.js";
export type {
  ToolHookInfo,
  ToolHooks,
  ToolInvocationResult,
} from "./tool-registry.js";
export { MockLLM, toolCall } from "./seams/llm.js";
export type { LLMAdapter } from "./seams/llm.js";
export {
  FINAL_STATE_GUARD,
  TASK_CONTRACT_RULES,
  GOAL_CONTRACT_TEMPLATE,
  GOAL_VERDICT_SCHEMA,
  COMPACT_CONTINUE_PROMPT,
  MAX_STEPS_PROMPT,
  EMPTY_RETRY_PROMPT,
  buildGoalJudgePrompt,
} from "./prompts.js";
export { OpenAICompatibleLLM, DEFAULT_RETRIES, retryBackoffMs } from "./seams/llm-openai.js";
export type { OpenAICompatibleOptions } from "./seams/llm-openai.js";
export {
  AutoApprove,
  DenyAll,
  PolicyGate,
  RulesetGate,
  deriveScope,
  matchPattern,
  targetOf,
} from "./seams/permissions.js";
export type { ApprovalGate, ApprovalRequest, PermissionRule } from "./seams/permissions.js";
export type * from "./types.js";

// Prompt-layer borrowings from LongHorizon-Harness (AMAP-ML), MIT-licensed
// (github.com/AMAP-ML/LongHorizon-Harness, arXiv 2608.01964). Adapted for a
// single-loop CLI agent: one model plays every role, so these rules are
// injected as guardrails instead of separate Manager/Auditor prompts.

/**
 * Final-state semantic guard (LH "FINAL_STATE_SEMANTIC_GUARD").
 * Anti-"fake done" rules: completion must exist on a state carrier the user
 * actually consumes, not in the agent's own narration.
 */
export const FINAL_STATE_GUARD = `Completion honesty rules (never claim done without meeting them):
- State carrier: "done" must exist on a state the user, an app, or a downstream process actually consumes — a saved file, database row, service config, exported artifact, or committed change. Your own narration ("I have completed...", "everything works"), progress output, or temporary logs cannot substitute.
- Authoritative inputs: inputs given by the task (files, URLs, values) must come from the real environment; if missing or conflicting, ask or report blocked — do not invent similar substitutes or silent defaults.
- Real production path: key state must be produced through real commands, official APIs, or normal file edits; never forge completion markers or hand-write artifacts that only the real workflow should produce.
- Commit/persistence boundary: for save/submit/publish/export tasks, fields filled, preview correct, draft ready, or file open are NOT completion — confirm the real persisted state exists before claiming done.
- Candidate contamination: when multiple candidate outputs may exist (old files, drafts, similar paths), verify the artifact that will actually be consumed is the correct one.`;

/**
 * Task-contract discipline (LH "TASK_CONTRACT_RULES", condensed).
 * How to treat a non-trivial goal: anchor it to a verifiable target state,
 * preserve restrictive wording, calibrate evidence horizon.
 */
export const TASK_CONTRACT_RULES = `Task-contract discipline (for non-trivial goals):
- A contract is a stable statement of the real, verifiable target state — it is not an execution plan and must not silently replace the request with an easier proxy goal.
- Preserve exact objects from the request: filenames, paths, formats, fields, counts, locations. Restrictive wording ("do not change X", "keep Y unchanged", "exact filename", "do not add extra files") becomes acceptance constraints; relaxing one constraint never relaxes another independent one.
- Evidence horizon: a final-state restriction ("leave no extra files at the end") is checked against the final state only — do not retro-strengthen it into "no temporary action ever happened" unless the request explicitly demands a process guarantee.
- Every acceptance constraint needs: source in the original request, required condition, how to verify it, and what blocks completion if unmet.
- If the target state is ambiguous, explore or ask first; never modify the final object to bet on one interpretation.`;

/**
 * Structured goal contract shape used by /goal and the judge. Deliberately
 * mirrors the compaction SUMMARY_TEMPLATE sections so a compacted summary can
 * be lifted into a contract without reformatting.
 */
export const GOAL_CONTRACT_TEMPLATE = `Goal contract:
- Objective: <what done means, in one sentence>
- Acceptance criteria: <each item: condition + how to verify>
- Constraints: <must-not-change / exactness requirements, or "(none)">
- Current state: <verified facts about progress so far>
- Next move: <the immediate concrete action>`;

/** One-line JSON verdict schema expected back from the goal judge. */
export const GOAL_VERDICT_SCHEMA =
  '{"met": true|false, "reason": "<one short line>", "unmet": ["<criterion or empty>"]}';

/**
 * Synthetic user query appended after a compaction that swallowed the turn's
 * user message (opencode/MiMo-Code "continue" fallback, compaction.ts):
 * strict chat templates (Qwen3: "No user query found in messages") reject a
 * conversation whose visible messages contain no user turn at all.
 */
export const COMPACT_CONTINUE_PROMPT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

/**
 * Final-step handoff, injected as an assistant prefill when a turn reaches its
 * (opt-in) step budget (opencode/MiMo-Code `MAX_STEPS_PROMPT`,
 * packages/core/src/session/runner/max-steps.ts): the model must stop calling
 * tools and deliver a text handoff instead of being cut off mid-action.
 */
export const MAX_STEPS_PROMPT = `CRITICAL: Maximum steps exhausted. You MUST stop immediately.

Respond with a brief text summary ONLY. Do NOT call any tools.

Your summary must contain:
1. What you completed
2. What remains (if anything)
3. Recommended next step for the user`;

/**
 * Nudge injected when the model returns an empty response (no text, no tool
 * call) mid-turn — a known Qwen3 / big-pickle instability on complex
 * decisions. Tells the model to resume the in-progress task instead of the
 * harness silently ending the turn.
 */
export const EMPTY_RETRY_PROMPT =
  "[harness] Your previous response was empty (no text and no tool call). " +
  "The task is not complete. Please continue: either call the next tool to " +
  "make progress, or reply with a short text answer.";

/**
 * Build the augmented judge prompt: the judge may not trust the agent's
 * self-report; it checks acceptance criteria against real evidence in the
 * transcript and reports which criteria remain unmet (feeds auto-continue).
 */
export function buildGoalJudgePrompt(goalCondition: string): string {
  return (
    `You are an impartial completion judge. The stated goal is:\n"""\n${goalCondition}\n"""\n\n` +
    `${FINAL_STATE_GUARD}\n\n${TASK_CONTRACT_RULES}\n\n` +
    "Judge ONLY from evidence visible in the conversation above. The agent's claim of completion is not evidence: look for the actual state carrier (file content shown by a read/tool result, command exit status, test output). If the transcript shows no such evidence, the goal is not met.\n" +
    'Reply with exactly one line of JSON matching this schema:\n' +
    `${GOAL_VERDICT_SCHEMA}\n` +
    `"reason" states what IS verified (when met) or the single most important gap (when not).`
  );
}

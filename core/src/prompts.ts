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

/**
 * Decision-asking rule (opencode/mimo-code/Claude-Code "askUser" parity).
 * Without an explicit prompt contract, models trained on developer chat treat
 * asking as weak and instead write the question as assistant text and keep
 * acting — which never reaches the user and runs the turn on assumptions.
 * The tool alone (question) is not enough; the system prompt must say WHEN
 * asking is mandatory and forbid the natural-language-then-continue pattern.
 */
export const DECISION_QUESTION_RULE = `# Handling user decisions
When the task is ambiguous, has multiple valid approaches, or needs a decision/confirmation the user has not given you:
1. Gather enough context first (read/search) so the question is useful.
2. Call the question tool and WAIT for the user's answer. Never proceed on an unconfirmed assumption.
3. NEVER write your question as assistant text and then keep working — that text never reaches the user and the turn continues blind. If you must ask, ask through the question tool.
4. When the answer set is small and known, pass 2-4 concrete options with the question.
5. In a headless (non-interactive) session the question tool errors — then pick the most reasonable option yourself, state the assumption explicitly, and continue.
Examples:
- "add auth" → question: OAuth vs JWT vs session-cookies
- "the spec says 7 more pages — finish them or deploy first?" → question: finish-all vs deploy-first
Specific tasks with exact file paths/lines/instructions need no question: act directly.`;

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
 * T#trunc — injected into the system prompt so the model does not mistake
 * output plumbing for an environment failure. A single tool result is capped
 * at TOOL_OUTPUT_MAX_CHARS (8K); a turn's total at TURN_TOOL_BUDGET_CHARS
 * (512K). When either trips, the model sees a literal marker instead of the
 * full text — a normal, recoverable condition, NOT a dead output channel.
 */
export const TOOL_OUTPUT_NOTES = `# Tool output limits
A single tool result is capped (≈8KB); a whole turn's tool output is capped (≈512KB). When a cap is hit you see a marker (e.g. "[truncated]" or a "budget exhausted" note) instead of full output — that is NORMAL and RECOVERABLE, not a broken output channel. Do NOT conclude the environment has failed and do NOT re-run the same tool to "prove" it works.
- To read a large file fully, print a specific line range (e.g. read_file with a small offset/max_lines, or sed/awk a narrow range) rather than reading the whole thing.
- Prefer targeted greps over broad cat/dump commands.
- If you have already gathered enough to answer, stop issuing tools and deliver your result.`;

/**
 * COMPACTION_STATE_GUARD — injected alongside every compaction summary to
 * prevent the agent from re-doing work it already completed BEFORE the
 * context was folded. Observed failure (same turn, two implementations of
 * webfetch hardening): after auto-compaction the objective "diagnose and
 * harden webfetch" survived verbatim while the "Completed" detail that it
 * WAS already done was buried, so the agent re-wrote the whole module and hit
 * duplicate-identifier compile errors. The guard makes the completion check
 * explicit and cheap: the summary is a memory of PAST turns — current reality
 * lives in the worktree/tools, so verify state before re-implementing.
 */
export const COMPACTION_STATE_GUARD = `# After a context compaction
Everything before this point was summarized because the window filled up. The summary reflects PAST turns, not current reality. Before you implement anything the summary lists as pending:
1. First verify the ACTUAL current state with a cheap read/grep/status check — the work may already be done (a previous turn completed it and the summary still lists it as pending).
2. Only re-implement when verification proves it is genuinely missing or broken.
3. If verification shows the work IS already present in the worktree (uncommitted or committed), treat it as YOUR OWN earlier work from this session unless you have hard evidence otherwise — do NOT assume it belongs to a parallel session. "Parallel session" is the last-resort explanation, not the default. Reuse and finish it; do not rebuild it.
4. Never restart a task that is already complete: confirm with evidence, not from memory.`;

/**
 * LANGUAGE_RULE — always appended at the VERY END of the system prompt so it
 * is the last instruction the model reads (buried mid-prompt it loses to the
 * surrounding English guardrails). Observed failure: after a compaction the
 * English summary pushed the language rule out of the recency window and the
 * agent reverted to English progress notes for a Chinese-speaking user.
 *
 * Wording is deliberately language-AGNOSTIC (opencode kimi.txt parity):
 * "the same language as the user", never a hardcoded language like Chinese —
 * a hardcoded language would be wrong for any other user and reads as
 * "English is fine unless the user writes Chinese". The rule is appended
 * after any summary/guard so nothing can follow it.
 */
export const LANGUAGE_RULE = `# Language
IMPORTANT: Every piece of text you output to the user — the final answer AND the short progress notes you write before and between tool calls — must ALWAYS be in the same language the user writes in. Follow the user's language exactly; do not switch to another language for narration, progress notes, or summaries.`;

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
 * CC#49 — shown after a stream stall that cut off a partial assistant answer.
 * The partial text was already appended to the transcript; this asks the
 * model to continue WITHOUT repeating what it already said (honest resume,
 * aligned with the compaction-recovery style).
 */
export const STREAM_RESUME_PROMPT =
  "[stream interrupted] Your previous response was cut off by a connection " +
  "stall. It is preserved above. Continue from where you left off — do not " +
  "repeat the part already written; finish the remaining answer or continue " +
  "the tool work.";

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

/**
 * P#37① — branch distillation prompt: one tool-less LLM call turns an
 * abandoned branch's transcript into a compact "lessons learned" block that
 * is injected at the fork point of the surviving branch.
 */
export function buildBranchDistillPrompt(transcript: string): string {
  return [
    "The conversation below is an ABANDONED branch of a coding session (the user forked away from it).",
    "Distill what was learned on it so a future agent on the SURVIVING branch does not repeat the dead end.",
    "Write 3-6 short bullet points covering ONLY transferable knowledge: approaches tried and why they failed,",
    "constraints discovered, file paths/commands that matter, and any partial progress worth keeping.",
    "Do not narrate the story; do not include secrets or credentials; maximum ~200 words.",
    "",
    "<abandoned-branch>",
    transcript,
    "</abandoned-branch>",
  ].join("\n");
}

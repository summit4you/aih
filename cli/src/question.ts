/**
 * IT#3 — `?` prefix: type `?` + a natural-language task to start an agent in a
 * BACKGROUND session, with the active context auto-injected (recent shell
 * output / cwd / active session). The foreground TUI is never interrupted; the
 * job's result is surfaced when it completes (the D#13 `/bg` board).
 *
 * This module is the PURE decision + composition seam (cost.ts / scorecard.ts
 * discipline — no I/O, no LLM, unit-testable):
 *
 *   - `isQuestionPrefix`  — is this input line a `?`-prefixed background task?
 *     Deliberately conservative so a literal "?" in a normal message is not
 *     captured: ASCII text must be separated by a space; CJK may follow
 *     directly (the common `? 修一下…` shape).
 *   - `buildQuestionContext` — assemble the injected context block from the
 *     session log (shell history via IT#1 `extractShellContext`) + cwd + the
 *     active session name.
 *   - `composeQuestionPrompt` — join context + task into the single prompt the
 *     background agent receives.
 *
 * The actual background dispatch reuses the D#13 `spawnJob` board (a detached
 * `aih run --session bg-*` child), so this seam stays pure and the process
 * spawn stays in one place.
 */
import type { SessionEvent } from "@aih/core";
import { extractShellContext, formatShellContext } from "./shell-context.js";

export interface QuestionPrefixResult {
  /** True when the line is a `?`-prefixed background task. */
  isQuestion: boolean;
  /** The task text (the line minus the leading `?`), trimmed. */
  prompt: string;
}

/**
 * Classify an input line as a `?`-prefixed background task or not.
 *
 * Rules (conservative, to avoid swallowing literal questions):
 *   - must start with `?`
 *   - must have non-empty content after the `?`
 *   - if the next char is ASCII (letter/digit/punct), it MUST be separated
 *     by whitespace — so `?foo` is a literal, `? foo` is a task
 *   - if the next char is non-ASCII (CJK etc.), it may follow directly —
 *     so `?修一下` and `? 修一下` are both tasks
 */
export function classifyQuestionPrefix(line: string): QuestionPrefixResult {
  if (!line.startsWith("?")) return { isQuestion: false, prompt: "" };
  const rest = line.slice(1);
  if (!rest.trim()) return { isQuestion: false, prompt: "" };
  const first = rest[0];
  const code = first.codePointAt(0)!;
  let isQuestion = false;
  if (code > 127) {
    // CJK / other non-ASCII: allow direct attachment.
    isQuestion = true;
  } else if (first === " " || first === "\t") {
    // ASCII: require a separating space and real content after it.
    isQuestion = rest.trim().length > 1;
  }
  if (!isQuestion) return { isQuestion: false, prompt: "" };
  return { isQuestion: true, prompt: rest.trim() };
}

export interface QuestionContextArgs {
  /** The session's events (for the shell-history part). */
  events: readonly SessionEvent[];
  /** The working directory (injected so the agent knows where it is). */
  cwd: string;
  /** The active session name (so the agent can reference it). */
  sessionName?: string;
  /** How many recent run_cmd calls to include (default 3). */
  maxCommands?: number;
}

/**
 * Assemble the context block injected into a `?` background task. Reuses IT#1
 * `extractShellContext` / `formatShellContext` for the shell-history part, so
 * the same bounded, model-readable format is used everywhere. Returns `""`
 * only when there is nothing to inject (no cwd) — in practice cwd is always
 * present, so this is non-empty.
 */
export function buildQuestionContext(args: QuestionContextArgs): string {
  const lines: string[] = ["[background task context]"];
  if (args.cwd) lines.push(`cwd: ${args.cwd}`);
  if (args.sessionName) lines.push(`active session: ${args.sessionName}`);
  const cmds = extractShellContext(args.events, {
    maxCommands: args.maxCommands,
  });
  if (cmds.length > 0) {
    lines.push("");
    lines.push(formatShellContext(cmds));
  }
  return lines.join("\n");
}

/**
 * Join the injected context block and the user's task into the single prompt
 * the background agent receives. The task comes last and is labelled so the
 * model knows which part is the instruction vs. the context.
 */
export function composeQuestionPrompt(context: string, prompt: string): string {
  const ctx = context.trim();
  return ctx ? `${ctx}\n\nTask: ${prompt}` : `Task: ${prompt}`;
}

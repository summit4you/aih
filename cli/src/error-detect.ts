/**
 * IT#2 — deterministic shell-failure detection → one-click fix.
 *
 * The agent should not have to *notice* a failed command from the transcript;
 * the harness should detect it deterministically (non-zero exit code / timeout)
 * and offer a one-click path to hand the failure to the agent for a fix.
 *
 * This is a PURE seam over `shell-context.ts` (IT#1): it reuses
 * `extractShellContext` so the failure set, exit codes, cwd, and bounded
 * output tails are exactly what IT#1 already guarantees — no re-parsing, no
 * non-shell tool leakage. On top of that it:
 *
 *   - `detectShellErrors` — filter the recent `run_cmd` calls to failures
 *     (non-zero exit code or timeout) and classify each by a small,
 *     deterministic pattern set (network / fs / js / test / build / crash).
 *   - `errorBadge`        — the status-bar indicator (`⚠ N failed`), or `null`
 *     when everything is green (the "all green → no indicator" state).
 *   - `formatFixBlock`    — a compact, model-readable block (command + exit
 *     code + output tail) suitable for injection into the next turn via `/fix`.
 *
 * Design rules (mirrors cost.ts / scorecard.ts / shell-context.ts discipline):
 *   - Pure: no I/O, no LLM, no globals — unit-testable in isolation.
 *   - Deterministic: classification is a fixed regex set, never a model call.
 *     A non-zero exit code is the primary failure signal; patterns only
 *     *label* the kind, they never decide failure (so a green exit is never
 *     misread as a failure, and a failed exit with no known pattern is
 *     still reported, as `unknown`).
 *   - Bounded: output tails are capped so a huge failure can't blow the
 *     context window; the full output is referenced by path instead.
 *   - Toggleable: callers gate on `AIH_ERROR_DETECT` (default on) for the
 *     *automatic* indicator; the explicit `/fix` command always works.
 */
import type { SessionEvent } from "@aih/core";
import {
  extractShellContext,
  describeCommand,
  type ShellCommand,
} from "./shell-context.js";

/** Deterministic failure classes (a label, not a pass/fail decision). */
export type ErrorKind =
  | "network"
  | "fs"
  | "js"
  | "test"
  | "build"
  | "crash"
  | "unknown";

/** One failed `run_cmd` invocation, classified and bounded. */
export interface ShellError {
  command: string;
  /** Exit code. `null` when unknown (timeout with no code is still a failure). */
  code: number | null;
  cwd?: string;
  /** True when the command hit its timeout. */
  timedOut: boolean;
  /** Bounded tail of the command's merged stdout+stderr. */
  outputTail: string;
  /** True when `outputTail` was truncated to the tail cap. */
  outputTruncated: boolean;
  /** Full (uncapped) output file, when `keep_output` was used. */
  outputFile?: string;
  /** Byte size of the full output, when known. */
  outputBytes?: number;
  /** The deterministic class (network/fs/js/test/build/crash/unknown). */
  kind: ErrorKind;
  /** The pattern string that matched ("" when `kind` is `unknown`). */
  matched: string;
}

export interface DetectOptions {
  /** How many most-recent `run_cmd` calls to scan (default 8). */
  maxCommands?: number;
  /** Max chars of output tail per failure (default 2000). */
  maxOutputChars?: number;
  /** Max number of failures to report (default 5, most recent kept). */
  maxErrors?: number;
}

const DEFAULT_MAX_COMMANDS = 8;
const DEFAULT_MAX_OUTPUT_CHARS = 2000;
const DEFAULT_MAX_ERRORS = 5;

/** A command is a failure iff it timed out or exited non-zero. */
export function isFailed(c: ShellCommand): boolean {
  if (c.timedOut) return true;
  return c.code !== null && c.code !== 0;
}

/**
 * Fixed, deterministic pattern set → `ErrorKind`. Ordered most-specific first
 * so a `SyntaxError` is labelled `js`, not `build`. Matching is case-insensitive
 * over the bounded output tail. This only *labels*; it never decides failure.
 */
const KIND_PATTERNS: ReadonlyArray<{ kind: ErrorKind; re: RegExp }> = [
  { kind: "crash", re: /segmentation fault|core dumped|panic:|traceback \(most recent call last\)|sigsegv|sigabrt|segfault/i },
  { kind: "network", re: /econnrefused|econnreset|etimedout|eai_again|connection (refused|reset|timed out)|network is unreachable|getaddrinfo|curl: \(\d+\)/i },
  { kind: "js", re: /syntaxerror|typeerror|referenceerror|rangeerror|uncaught|cannot find module|is not a function|is not defined|unhandled promise rejection/i },
  { kind: "test", re: /assertionerror|tests? failed|test suite|expected .* but got|n tests? (failed|failing)|\d+ (tests?|assertions?) failed/i },
  { kind: "fs", re: /enoent|eacces|eperm|eisdir|enotdir|no such file or directory|permission denied|command not found/i },
  { kind: "build", re: /npm err|yarn error|pip error|make:\s*\*{3}|cargo error|compilation error|build failed/i },
];

function classifyKind(output: string): { kind: ErrorKind; matched: string } {
  for (const p of KIND_PATTERNS) {
    const m = p.re.exec(output);
    if (m) return { kind: p.kind, matched: m[0] };
  }
  return { kind: "unknown", matched: "" };
}

/**
 * Pull the recent `run_cmd` failures from a session's events, newest first.
 * Reuses `extractShellContext` (IT#1) so only `run_cmd` events and only their
 * `stdout` result field are ever read — no non-shell tool output leaks in.
 * Returns `[]` when there is no shell history or nothing failed (the
 * "all green" state).
 */
export function detectShellErrors(
  events: readonly SessionEvent[],
  opts: DetectOptions = {},
): ShellError[] {
  const maxErrors = Math.max(1, opts.maxErrors ?? DEFAULT_MAX_ERRORS);
  const maxCommands = Math.max(1, opts.maxCommands ?? DEFAULT_MAX_COMMANDS);
  const maxOutputChars = Math.max(200, opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);

  const cmds = extractShellContext(events, {
    maxCommands,
    maxOutputChars,
  });
  // `extractShellContext` is already newest-first (the failure the user just
  // saw goes on top). Filter to failures and cap to the most recent `maxErrors`.
  const failures = cmds.filter(isFailed).slice(0, maxErrors);

  return failures.map((c) => {
    const { kind, matched } = classifyKind(c.output);
    return {
      command: c.command,
      code: c.code,
      cwd: c.cwd,
      timedOut: c.timedOut,
      outputTail: c.output,
      outputTruncated: c.outputTruncated,
      outputFile: c.outputFile,
      outputBytes: c.outputBytes,
      kind,
      matched,
    };
  });
}

/**
 * The status-bar indicator. `null` when there is nothing to flag (all green /
 * no history) — the "all green → no indicator" state. Otherwise a red badge
 * with the failure count.
 */
export function errorBadge(
  errors: readonly ShellError[],
): { glyph: string; ok: boolean; label: string } | null {
  if (errors.length === 0) return null;
  return { glyph: "⚠", ok: false, label: `${errors.length} failed` };
}

/**
 * Render the failures into a compact, model-readable block for `/fix` — framed
 * as "these command(s) failed; diagnose and fix". Each entry carries the
 * command, exit code (or timeout), the deterministic class, and a bounded
 * output tail (with the full-output path when truncated). Returns `""` for the
 * empty state so callers can branch on it.
 */
export function formatFixBlock(errors: readonly ShellError[]): string {
  if (errors.length === 0) return "";
  const lines: string[] = [
    "[shell failures] the following shell command(s) FAILED in this session (most recent first). Diagnose the root cause and propose — or apply — a fix:",
  ];
  errors.forEach((e, i) => {
    const status =
      e.code === null
        ? "no exit code"
        : e.code === 0
          ? "exit 0"
          : `exit ${e.code}`;
    const timed = e.timedOut ? " · timed out" : "";
    const dir = e.cwd ? ` · ${e.cwd}` : "";
    lines.push(`${i + 1}. $ ${e.command}  (${status}${timed}${dir})`);
    lines.push(`   class: ${e.kind}${e.matched ? ` (matched: "${e.matched}")` : ""}`);
    const tail = e.outputTail.replace(/\s+$/, "");
    if (tail) {
      for (const ln of tail.split("\n").slice(-30)) {
        lines.push(`   ${ln}`);
      }
      if (e.outputTruncated) {
        lines.push("   …(output tail shown; earlier lines elided)…");
      }
    }
    if (e.outputFile) {
      lines.push(`   full output: ${e.outputFile}${e.outputBytes ? ` (${e.outputBytes} bytes)` : ""}`);
    }
  });
  lines.push("");
  lines.push("Do NOT re-run the failing command blindly. Explain the cause, then either fix the command/config and re-run, or state exactly what is needed.");
  return lines.join("\n");
}

/**
 * A one-line human summary of the failures (for the TUI system line), e.g.
 * `npm test (exit 1 · test)`. Empty string when there are no failures.
 */
export function summarizeErrors(errors: readonly ShellError[]): string {
  if (errors.length === 0) return "";
  return errors
    .map((e) => {
      const code = e.code === null ? "timeout" : `exit ${e.code}`;
      return `${e.command} (${code} · ${e.kind})`;
    })
    .join("  ·  ");
}

/** Re-export for callers that want a single import surface. */
export { describeCommand };

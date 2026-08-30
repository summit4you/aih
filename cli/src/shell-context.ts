/**
 * IT#1 — shell context awareness.
 *
 * The agent should be able to *reach for* the user's recent shell output and
 * exit codes instead of the user having to paste them. This module is a pure
 * seam over the session log's `run_cmd` tool/call + tool/result events:
 *
 *   - `extractShellContext` — pull the most recent N `run_cmd` invocations,
 *     each with its command, exit code, working dir, and a bounded tail of
 *     output (plus the full-output file path when `keep_output` was used).
 *   - `formatShellContext`  — render those into a compact, model-readable
 *     block that can be injected into the next turn (auto mode) or shown in
 *     the TUI (`/shell`).
 *
 * Design rules (mirrors the cost.ts / scorecard.ts discipline):
 *   - Pure: no I/O, no LLM, no globals — unit-testable in isolation.
 *   - Reads ONLY `run_cmd` events (never other tools' output) and ONLY the
 *     `stdout` field of the result — so it cannot leak non-shell tool output.
 *   - `ok` on a `tool/result` means "the tool executed"; a non-zero exit code
 *     is still `ok:true`. We therefore read `result.code` for failure, not `ok`.
 *   - Bounded: output tails are capped so a huge `run_cmd` can't blow the
 *     context window; the full output is referenced by path instead.
 */
import type { SessionEvent } from "@aih/core";

/** One recent `run_cmd` invocation, extracted and bounded. */
export interface ShellCommand {
  callId: string;
  ts: number;
  /** The shell command string (from the tool/call args). */
  command: string;
  /** Working dir the command ran in (from the tool/call args). */
  cwd?: string;
  /** Exit code. `null` when unknown (no result yet / tool errored). */
  code: number | null;
  /** True when the command hit its timeout. */
  timedOut: boolean;
  /** True when the command succeeded (code === 0). */
  ok: boolean;
  /** Bounded tail of the command's merged stdout+stderr. */
  output: string;
  /** True when `output` was truncated to the tail cap. */
  outputTruncated: boolean;
  /** Full (uncapped) output file, when `keep_output` was used. */
  outputFile?: string;
  /** Byte size of the full output, when known. */
  outputBytes?: number;
}

export interface ExtractOptions {
  /** How many most-recent `run_cmd` calls to include (default 3). */
  maxCommands?: number;
  /** Max chars of output tail per command (default 4000). */
  maxOutputChars?: number;
}

const DEFAULT_MAX_COMMANDS = 3;
const DEFAULT_MAX_OUTPUT_CHARS = 4000;

/**
 * Pull the most recent `run_cmd` invocations from a session's events, newest
 * first. Only `run_cmd` events are considered; only their `stdout` result field
 * is read. Returns `[]` when there is no shell history (the empty state).
 */
export function extractShellContext(
  events: readonly SessionEvent[],
  opts: ExtractOptions = {},
): ShellCommand[] {
  const maxCommands = Math.max(1, opts.maxCommands ?? DEFAULT_MAX_COMMANDS);
  const maxOutputChars = Math.max(200, opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);

  // Map callId -> the tool/call event (carries command + cwd).
  const calls = new Map<string, Extract<SessionEvent, { type: "tool/call" }>>();
  for (const e of events) {
    if (e.type === "tool/call" && e.name === "run_cmd") calls.set(e.callId, e);
  }

  // Collect tool/result events for those calls, in log order.
  const out: ShellCommand[] = [];
  for (const e of events) {
    if (e.type !== "tool/result") continue;
    const call = calls.get(e.callId);
    if (!call) continue; // not a run_cmd call — ignore (no other tool leaks in)

    const args = (call.args ?? {}) as { command?: unknown; cwd?: unknown };
    const command = typeof args.command === "string" ? args.command : "";
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

    const result = (e.result ?? {}) as {
      code?: unknown;
      timed_out?: unknown;
      stdout?: unknown;
      truncated?: unknown;
      output_file?: unknown;
      output_bytes?: unknown;
    };
    const code = typeof result.code === "number" ? result.code : null;
    const timedOut = result.timed_out === true;
    const rawOutput = typeof result.stdout === "string" ? result.stdout : "";
    const outputTruncated =
      rawOutput.length > maxOutputChars || result.truncated === true;
    const output = rawOutput.length > maxOutputChars
      ? rawOutput.slice(rawOutput.length - maxOutputChars)
      : rawOutput;

    out.push({
      callId: e.callId,
      ts: e.ts,
      command,
      cwd,
      code,
      timedOut,
      ok: code === 0,
      output,
      outputTruncated,
      outputFile: typeof result.output_file === "string" ? result.output_file : undefined,
      outputBytes: typeof result.output_bytes === "number" ? result.output_bytes : undefined,
    });
  }

  // Newest first, bounded to maxCommands.
  return out.slice(-maxCommands).reverse();
}

/** A single line describing a command's outcome (for the TUI / status). */
export function describeCommand(c: ShellCommand): string {
  const status =
    c.code === null
      ? "no exit code"
      : c.code === 0
        ? "exit 0"
        : `exit ${c.code}`;
  const timed = c.timedOut ? " · timed out" : "";
  const dir = c.cwd ? ` · ${c.cwd}` : "";
  return `$ ${c.command}  (${status}${timed}${dir})`;
}

/**
 * Render the extracted commands into a compact, model-readable block suitable
 * for injection into the next turn. Returns `""` for the empty state (no shell
 * history), so callers can branch on it.
 */
export function formatShellContext(commands: readonly ShellCommand[]): string {
  if (commands.length === 0) return "";
  const lines: string[] = [
    "[shell context] recent shell command(s) from this session (most recent last):",
  ];
  commands.forEach((c, i) => {
    lines.push(`${i + 1}. ${describeCommand(c)}`);
    const tail = c.output.replace(/\s+$/, "");
    if (tail) {
      // Indent the (already-tailed) output under the command line.
      for (const ln of tail.split("\n").slice(-40)) {
        lines.push(`   ${ln}`);
      }
      if (c.outputTruncated) {
        lines.push("   …(output tail shown; earlier lines elided)…");
      }
    }
    if (c.outputFile) {
      lines.push(`   full output: ${c.outputFile}${c.outputBytes ? ` (${c.outputBytes} bytes)` : ""}`);
    }
  });
  return lines.join("\n");
}

/**
 * P#46 phase 1 — Eval experiment framework (Maka packages/eval, simplified).
 *
 * An Experiment = tasks × models × repetitions, expanded into CELLS. Each
 * cell gets one ATTEMPT (an isolated `aih run` invocation with its own
 * session file). Attempts are immutable; when a cell has multiple attempts
 * the EARLIEST VALID one is authoritative (no cherry-picking — anti-Goodhart).
 *
 * The RESULT KERNEL is intentionally small: score, usage, cost, duration,
 * status and failure reason. Everything else is an artifact.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EvalTask {
  /** Unique task id. */
  id: string;
  /** The prompt sent to the agent. */
  prompt: string;
  /** Substring(s) that must ALL appear in the final output for success. */
  expect: string[];
}

export interface EvalModelSpec {
  /** Model id (passed as --model). */
  model: string;
  /** Optional provider (passed as --provider). */
  provider?: string;
  /** Optional base URL (passed as --base-url). */
  baseUrl?: string;
}

export interface CellResult {
  cellId: string;
  taskId: string;
  model: string;
  repetition: number;
  status: "passed" | "failed" | "error";
  durationMs: number;
  outputTail: string;
  sessionFile?: string;
  failureReason?: string;
}

/** Expand the experiment spec into deterministic cell list. */
export function expandCells(
  tasks: EvalTask[],
  models: EvalModelSpec[],
  repetitions: number,
): { taskId: string; model: string; repetition: number }[] {
  const cells: { taskId: string; model: string; repetition: number }[] = [];
  const reps = Math.max(1, Math.floor(repetitions));
  for (const t of tasks) {
    for (const m of models) {
      for (let r = 1; r <= reps; r += 1) {
        cells.push({ taskId: t.id, model: m.model, repetition: r });
      }
    }
  }
  return cells;
}

/** Check an agent output against a task's expectations. */
export function judgeOutput(output: string, expect: string[]): boolean {
  if (expect.length === 0) return output.trim().length > 0;
  return expect.every((e) => output.includes(e));
}

/**
 * Run one attempt: invoke `aih run` in a fresh working directory with its
 * own session file. Returns the raw attempt record (never mutated later).
 */
export function runAttempt(
  cliEntry: string,
  opts: {
    cwd: string;
    outDir: string;
    task: EvalTask;
    model: string;
    provider?: string;
    baseUrl?: string;
    repetition: number;
    timeoutMs?: number;
  },
): CellResult {
  const started = Date.now();
  const cellId = `${opts.task.id}__${opts.model}__r${opts.repetition}`;
  const workDir = join(opts.outDir, cellId);
  mkdirSync(workDir, { recursive: true });
  const sessionName = `eval-${cellId}`;

  const args = [
    join(cliEntry, "dist", "index.js"),
    "run",
    opts.task.prompt,
    "--yes",
    "--format",
    "json",
    "--session",
    sessionName,
  ];
  // Mock mode bypasses the API-key gate; otherwise the model id is passed
  // through and a real key must come from the environment.
  if (opts.model === "mock") args.push("--mock");
  else args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.baseUrl) args.push("--base-url", opts.baseUrl);

  const r = spawnSync(process.execPath, args, {
    cwd: workDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    env: process.env,
  });

  const durationMs = Date.now() - started;
  let output = "";
  // NDJSON turn/end stream: last assistant text wins; fall back to stdout.
  try {
    const lines = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { type?: string; text?: string });
    const texts = events.filter((e) => e.type === "assistant/message").map((e) => e.text ?? "").filter(Boolean);
    output = texts.join("\n") || (r.stdout ?? "");
  } catch {
    output = r.stdout ?? "";
  }

  const sessionFile = join(workDir, ".aih", "sessions", `${sessionName}.jsonl`);
  const base = {
    cellId,
    taskId: opts.task.id,
    model: opts.model,
    repetition: opts.repetition,
    durationMs,
    outputTail: output.slice(-400),
    ...(existsSync(sessionFile) ? { sessionFile } : {}),
  };

  if (r.error || (r.status !== 0 && !output)) {
    return {
      ...base,
      status: "error",
      failureReason: r.error?.message ?? r.stderr?.slice(0, 300) ?? "non-zero exit",
    };
  }
  const ok = judgeOutput(output, opts.task.expect);
  return {
    ...base,
    status: ok ? "passed" : "failed",
    ...(ok ? {} : { failureReason: "expectation not met in final output" }),
  };
}

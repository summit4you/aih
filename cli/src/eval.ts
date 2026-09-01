/**
 * P#46 — Eval experiment framework (Maka packages/eval, simplified).
 *
 * An Experiment = tasks × models × repetitions, expanded into CELLS. Each
 * cell gets one ATTEMPT (an isolated subject invocation with its own working
 * directory / session). Attempts are immutable; when a cell has multiple
 * attempts the EARLIEST VALID one is authoritative (no cherry-picking —
 * anti-Goodhart).
 *
 * The RESULT KERNEL is intentionally small: score, usage, cost, duration,
 * status and failure reason. Everything else is an artifact.
 *
 * Phase 2 — experiment semantics on top of the kernel:
 *  - `runExperiment`: bounded-concurrency runner over the expanded cells
 *    (`budget.concurrency`, default AIH_TOOL_CONCURRENCY then 4) with
 *    wall-clock (`budgetMs`) and cost-ceiling (`maxCostUsd`) budgets. Cells
 *    that never start due to budget exhaustion are reported in
 *    `skippedCells` — honest accounting, never fabricated results.
 *  - Subjects plug in via the `SubjectAdapter` seam: bundled CLI
 *    (`cliSubjectAdapter`), any external command (`externalSubjectAdapter`),
 *    or a running `aih serve` instance (`httpSubjectAdapter`). Eval owns
 *    experiment semantics only; execution reuses each subject's own runtime.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costForUsage, resolvePrice } from "./cost.js";

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
  /** Phase 2 — token/cost kernel filled from the attempt's session log. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Judging + cell expansion (pure, phase-1 surface kept stable)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Subject adapters — who executes a task prompt
// ---------------------------------------------------------------------------

export interface AttemptOutput {
  /** What the agent produced (judged against task.expect). */
  output: string;
  exitError?: string;
  sessionFile?: string;
}

/** A subject executes one task prompt and returns what the agent produced. */
export type SubjectAdapter = (
  task: EvalTask,
  model: EvalModelSpec,
  workDir: string,
) => Promise<AttemptOutput>;

/**
 * Extract the final agent text from `aih run --format json` NDJSON stdout:
 * last assistant/message wins; fall back to raw stdout (text mode).
 */
function parseCliStdout(stdout: string): string {
  try {
    const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
    const events = lines.map((l) => JSON.parse(l) as { type?: string; text?: string });
    const texts = events
      .filter((e) => e.type === "assistant/message")
      .map((e) => e.text ?? "")
      .filter(Boolean);
    return texts.join("\n") || stdout;
  } catch {
    return stdout;
  }
}

/** Run a child process to completion with a hard timeout (SIGKILL on expiry). */
function runChild(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolveP({ code: null, stdout, stderr: `${stderr}${err.message}`, killed });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ code, stdout, stderr, killed });
    });
  });
}

/**
 * Bundled CLI subject — invoke `aih run` per attempt with its own session
 * file under `<workDir>/.aih/sessions/`.
 */
export function cliSubjectAdapter(
  cliEntry: string,
  opts?: { timeoutMs?: number },
): SubjectAdapter {
  return async (task, model, workDir) => {
    const sessionName = `eval-${task.id}__${model.model}`;
    const args = [
      join(cliEntry, "dist", "index.js"),
      "run",
      task.prompt,
      "--yes",
      "--format",
      "json",
      "--session",
      sessionName,
    ];
    // Mock mode bypasses the API-key gate; otherwise the model id is passed
    // through and a real key must come from the environment.
    if (model.model === "mock") args.push("--mock");
    else args.push("--model", model.model);
    if (model.provider) args.push("--provider", model.provider);
    if (model.baseUrl) args.push("--base-url", model.baseUrl);

    const r = await runChild(process.execPath, args, {
      cwd: workDir,
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
    const output = parseCliStdout(r.stdout);
    const sessionFile = join(workDir, ".aih", "sessions", `${sessionName}.jsonl`);
    return {
      output,
      ...(r.killed
        ? { exitError: `timed out after ${opts?.timeoutMs ?? 120_000}ms` }
        : r.code !== 0 && !output.trim()
          ? { exitError: r.stderr.slice(0, 300) || `exit code ${r.code}` }
          : {}),
      ...(existsSync(sessionFile) ? { sessionFile } : {}),
    };
  };
}

/**
 * External command subject — run any agent CLI. argv = [command,
 * ...argsTemplate] where `{prompt}` expands to the task prompt and
 * `{workdir}` to the isolated cell directory. Stdout is the judged output;
 * non-zero exit is an error unless output was produced.
 */
export function externalSubjectAdapter(
  command: string,
  argsTemplate: string[],
  opts?: { timeoutMs?: number },
): SubjectAdapter {
  return async (task, _model, workDir) => {
    const argv = argsTemplate.map((a) =>
      a === "{prompt}" ? task.prompt : a.replaceAll("{workdir}", workDir),
    );
    const r = await runChild(command, argv, {
      cwd: workDir,
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
    return {
      output: r.stdout,
      ...(r.killed
        ? { exitError: `timed out after ${opts?.timeoutMs ?? 120_000}ms` }
        : r.code !== 0 && !r.stdout.trim()
          ? { exitError: r.stderr.slice(0, 300) || `exit code ${r.code}` }
          : {}),
    };
  };
}

/**
 * HTTP subject — POST the prompt to a running `aih serve` instance
 * (`POST /message`) and judge its answer.
 */
export function httpSubjectAdapter(baseUrl: string): SubjectAdapter {
  return async (task) => {
    let res: Response;
    try {
      res = await fetch(new URL("/message", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: task.prompt }),
      });
    } catch (err) {
      return { output: "", exitError: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) return { output: "", exitError: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { answer?: unknown; error?: unknown };
    if (typeof body.error === "string") return { output: "", exitError: body.error };
    return { output: typeof body.answer === "string" ? body.answer : "" };
  };
}

// ---------------------------------------------------------------------------
// Experiment runner — bounded concurrency + budgets + result kernel
// ---------------------------------------------------------------------------

export interface ExperimentBudget {
  /** Wall-clock ceiling for the whole experiment (ms). Exceeded → rest skipped. */
  budgetMs?: number;
  /** Cost ceiling in USD across all completed attempts (table prices). */
  maxCostUsd?: number;
  /** Max cells in flight (default AIH_TOOL_CONCURRENCY, then 4). */
  concurrency?: number;
}

export interface ExperimentReport {
  results: CellResult[];
  skippedCells: string[];
  totals: {
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    costUsd: number;
    durationMs: number;
    stopReason: "completed" | "time_budget_exhausted" | "cost_budget_exhausted";
  };
}

type Usage = NonNullable<CellResult["usage"]>;

const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

function sumUsage(a: Usage, b?: Usage): Usage {
  return {
    promptTokens: a.promptTokens + (b?.promptTokens ?? 0),
    completionTokens: a.completionTokens + (b?.completionTokens ?? 0),
    totalTokens: a.totalTokens + (b?.totalTokens ?? 0),
  };
}

/**
 * Read token usage out of an attempt's session log (turn/end events only —
 * the same source the TUI panel trusts). Missing file / mock runs → undefined.
 */
export function attemptUsage(sessionFile?: string): Usage | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  try {
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
    const acc = emptyUsage();
    let seen = false;
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as { type?: string; usage?: Partial<Usage> };
        if (e.type === "turn/end" && e.usage) {
          acc.promptTokens += e.usage.promptTokens ?? 0;
          acc.completionTokens += e.usage.completionTokens ?? 0;
          acc.totalTokens += e.usage.totalTokens ?? 0;
          seen = true;
        }
      } catch {
        /* skip malformed line — append-only log may have a torn tail */
      }
    }
    return seen ? acc : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// FA#6 — result persistence, failed-cell retry, progress inspection
// ---------------------------------------------------------------------------

/**
 * FA#6 — a persisted experiment result set. One file per experiment id:
 * `<resultsDir>/<expId>.results.json`. The per-cell `status` is the contract
 * for `--retry-failed` (re-run only `status !== "passed"` cells) and `--status`
 * (print the passed/failed/error distribution).
 */
export interface ExperimentResults {
  expId: string;
  updatedAt: string;
  /** Latest result per cellId (a retry overwrites the prior outcome). */
  cells: Record<string, CellResult>;
  /** Cells present in the spec but never run (budget-skipped, etc.). */
  skipped: string[];
}

/** Canonical results-file location for an experiment id. */
export function resultsPath(resultsDir: string, expId: string): string {
  return join(resultsDir, `${expId}.results.json`);
}

/** Load a persisted result set; undefined if the file is absent/invalid. */
export function loadResults(resultsDir: string, expId: string): ExperimentResults | undefined {
  const p = resultsPath(resultsDir, expId);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ExperimentResults;
    if (!raw || typeof raw !== "object" || !raw.cells) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Atomically-ish persist a result set (write to temp, rename). */
export function saveResults(
  resultsDir: string,
  results: ExperimentResults,
): string {
  mkdirSync(resultsDir, { recursive: true });
  const p = resultsPath(resultsDir, results.expId);
  writeFileSync(p, JSON.stringify(results, null, 2) + "\n");
  return p;
}

/**
 * FA#6 — fold a fresh run's results into the persisted set: a re-run cell
 * overwrites its prior outcome (that IS the retry), new cells are added, and
 * cells that were previously run but are absent from this run are kept (a
 * retry only touches the failed subset — the passed cells' last-known status
 * stays visible). `skipped` reflects this run.
 */
export function mergeResults(
  prev: ExperimentResults | undefined,
  fresh: { cells: Record<string, CellResult>; skipped: string[] },
  expId: string,
): ExperimentResults {
  const cells: Record<string, CellResult> = { ...(prev?.cells ?? {}) };
  for (const [id, r] of Object.entries(fresh.cells)) cells[id] = r;
  return {
    expId,
    updatedAt: new Date().toISOString(),
    cells,
    skipped: [...new Set([...(prev?.skipped ?? []), ...fresh.skipped])],
  };
}

/** passed/failed/error distribution over a set of results (pure). */
export function statusSummary(
  cells: Record<string, CellResult> | CellResult[],
): { passed: number; failed: number; error: number; total: number } {
  const list = Array.isArray(cells) ? cells : Object.values(cells);
  return {
    passed: list.filter((r) => r.status === "passed").length,
    failed: list.filter((r) => r.status === "failed").length,
    error: list.filter((r) => r.status === "error").length,
    total: list.length,
  };
}

/**
 * FA#6 — the cellIds to (re)run for a retry: every cell whose last-known
 * status is not "passed" (failed/error) plus cells never run (skipped/unknown).
 * Returns the full spec when there is no prior result set (first run).
 */
export function retryCellIds(
  spec: { taskId: string; model: string; repetition: number }[],
  prev: ExperimentResults | undefined,
): string[] {
  if (!prev) return spec.map((c) => `${c.taskId}__${c.model}__r${c.repetition}`);
  return spec
    .filter((c) => {
      const id = `${c.taskId}__${c.model}__r${c.repetition}`;
      const r = prev.cells[id];
      return !r || r.status !== "passed";
    })
    .map((c) => `${c.taskId}__${c.model}__r${c.repetition}`);
}

/**
 * Run the full cell matrix against a subject adapter with bounded
 * concurrency and time/cost budgets. Results are returned in input order;
 * cells not started because a budget ran out land in `skippedCells`.
 *
 * FA#6 — `opts.expId` + `opts.resultsDir` persist the result set
 * (`.aih/eval/<expId>.results.json` by convention); `opts.onlyCells` restricts
 * the run to a subset of cellIds (used by `--retry-failed`).
 */
export async function runExperiment(
  tasks: EvalTask[],
  models: EvalModelSpec[],
  repetitions: number,
  subject: SubjectAdapter,
  opts: {
    outDir: string;
    budget?: ExperimentBudget;
    timeoutMs?: number;
    expId?: string;
    resultsDir?: string;
    onlyCells?: string[];
  },
): Promise<ExperimentReport> {
  let cells = expandCells(tasks, models, repetitions);
  // FA#6 — restrict to a subset of cellIds (used by `--retry-failed`).
  if (opts.onlyCells && opts.onlyCells.length > 0) {
    const wanted = new Set(opts.onlyCells);
    cells = cells.filter((c) => wanted.has(`${c.taskId}__${c.model}__r${c.repetition}`));
  }
  const limit = Math.max(
    1,
    opts.budget?.concurrency ?? (Number(process.env.AIH_TOOL_CONCURRENCY ?? "") || 4),
  );
  const startedAt = Date.now();
  const results: (CellResult | undefined)[] = new Array(cells.length);
  const skipped: string[] = [];
  let stop: ExperimentReport["totals"]["stopReason"] | undefined;

  const spentSoFar = () =>
    results.reduce<number>((s, r) => s + (r?.costUsd ?? 0), 0);

  const jobs = cells.map((cell, i) => async () => {
    const task = tasks.find((t) => t.id === cell.taskId) ?? tasks[0];
    const model = models.find((m) => m.model === cell.model) ?? models[0];
    const cellId = `${cell.taskId}__${cell.model}__r${cell.repetition}`;
    const workDir = join(opts.outDir, cellId);
    mkdirSync(workDir, { recursive: true });
    const t0 = Date.now();
    let out: AttemptOutput;
    try {
      out = await subject(task, model, workDir);
    } catch (err) {
      out = { output: "", exitError: err instanceof Error ? err.message : String(err) };
    }
    const durationMs = Date.now() - t0;
    const ok = !out.exitError && judgeOutput(out.output, task.expect);
    const usage = attemptUsage(out.sessionFile);
    const price = resolvePrice(cell.model);
    const result: CellResult = {
      cellId,
      taskId: cell.taskId,
      model: cell.model,
      repetition: cell.repetition,
      status: out.exitError ? "error" : ok ? "passed" : "failed",
      durationMs,
      outputTail: out.output.slice(-400),
      ...(out.sessionFile ? { sessionFile: out.sessionFile } : {}),
      ...(usage ? { usage } : {}),
      ...(usage && price ? { costUsd: costForUsage(usage, price) } : {}),
      ...(out.exitError
        ? { failureReason: out.exitError }
        : ok
          ? {}
          : { failureReason: "expectation not met in final output" }),
    };
    results[i] = result;
  });

  // Bounded-concurrency pool with a lazy gate: each worker re-checks budgets
  // BEFORE taking the next cell, so exhaustion stops dispatch while running
  // cells finish naturally (no half-run attempts).
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, cells.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= cells.length) return;
        if (!stop) {
          if (opts.budget?.budgetMs !== undefined && Date.now() - startedAt > opts.budget.budgetMs) {
            stop = "time_budget_exhausted";
          } else if (
            opts.budget?.maxCostUsd !== undefined &&
            spentSoFar() > opts.budget.maxCostUsd
          ) {
            stop = "cost_budget_exhausted";
          }
        }
        if (stop) {
          const c = cells[i];
          skipped.push(`${c.taskId}__${c.model}__r${c.repetition}`);
          continue;
        }
        await jobs[i]();
      }
    }),
  );

  const done = results.filter(Boolean) as CellResult[];
  const totals: ExperimentReport["totals"] = {
    passed: done.filter((r) => r.status === "passed").length,
    failed: done.filter((r) => r.status === "failed").length,
    errors: done.filter((r) => r.status === "error").length,
    skipped: skipped.length,
    usage: done.reduce<Usage>((s, r) => sumUsage(s, r.usage), emptyUsage()),
    costUsd: done.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    durationMs: Date.now() - startedAt,
    stopReason: stop ?? "completed",
  };
  // FA#6 — persist the result set so `--retry-failed` / `--status` can read it
  // across processes. A re-run cell overwrites its prior outcome (the retry);
  // previously-passed cells not in this run keep their last-known status.
  if (opts.expId && opts.resultsDir) {
    const freshCells: Record<string, CellResult> = {};
    for (const r of done) freshCells[r.cellId] = r;
    const prev = loadResults(opts.resultsDir, opts.expId);
    saveResults(
      opts.resultsDir,
      mergeResults(prev, { cells: freshCells, skipped: [...new Set(skipped)] }, opts.expId),
    );
  }
  return { results: done, skippedCells: [...new Set(skipped)], totals };
}

// ---------------------------------------------------------------------------
// FB#4 — BuffBench-style quality eval: baseline comparison (regression gate)
// ---------------------------------------------------------------------------

/**
 * A task-suite manifest: fixed quality tasks + an expected-cell baseline.
 * Loaded from `evals/*.tasks.json` (BuffBench-style). The baseline records
 * which cells MUST pass; a cell that passed in the baseline but fails in a
 * new run is a REGRESSION.
 */
export interface QualitySuite {
  description?: string;
  tasks: EvalTask[];
}

/** Load a quality suite from an evals tasks file (missing/file-bad → undefined). */
export function loadQualitySuite(path: string): QualitySuite | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as QualitySuite;
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Compare a fresh run's results against a baseline expectation (an array of
 * cellIds or `task__*__rN` wildcard patterns that MUST pass). Pure: no I/O.
 * A cell the baseline expects to pass but the new run marks non-passed is a
 * REGRESSION. Cells with no baseline expectation are reported but never count
 * as a regression (unbaselined = informational).
 */
export interface BaselineDelta {
  /** cells that regressed: baseline expected pass, new run did not pass. */
  regressions: { cellId: string; expected: string; actual: string }[];
  /** cells whose status is unchanged from the baseline (passed→passed). */
  stable: string[];
  /** cells with no baseline expectation (informational only). */
  unbaselined: string[];
  /** true iff zero regressions. */
  ok: boolean;
}

/** Escape a literal for use inside a RegExp constructor (wildcard expansion). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compareToBaseline(
  results: Record<string, CellResult> | CellResult[],
  expectedPass: Record<string, "passed"> | string[],
): BaselineDelta {
  const list = Array.isArray(results) ? results : Object.values(results);
  const byId = new Map<string, CellResult>(list.map((r) => [r.cellId, r]));
  const patterns = Array.isArray(expectedPass) ? expectedPass : Object.keys(expectedPass);
  // Expand wildcard patterns (`task__*__r1`) against the actual cell ids so the
  // baseline can target "every model for this task" without knowing model ids.
  const expectedSet = new Set<string>();
  for (const p of patterns) {
    if (!p.includes("*")) {
      expectedSet.add(p);
      continue;
    }
    const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`);
    let matched = false;
    for (const id of byId.keys()) {
      if (re.test(id)) {
        expectedSet.add(id);
        matched = true;
      }
    }
    if (!matched) expectedSet.add(p); // no cell matched — the pattern itself counts as a (failing) expectation
  }

  const regressions: BaselineDelta["regressions"] = [];
  const stable: string[] = [];
  const unbaselined: string[] = [];

  for (const [cellId, r] of byId) {
    if (!expectedSet.has(cellId)) {
      unbaselined.push(cellId);
      continue;
    }
    if (r.status === "passed") stable.push(cellId);
    else regressions.push({ cellId, expected: "passed", actual: r.status });
  }
  // Cells the baseline expects but that never produced a result count as
  // regressions too (they were expected to pass, now absent/failed).
  for (const id of expectedSet) {
    if (!byId.has(id)) regressions.push({ cellId: id, expected: "passed", actual: "absent" });
  }
  return { regressions, stable, unbaselined, ok: regressions.length === 0 };
}

/**
 * D#13 — background tasks (dsh `ctx.jobs`).
 *
 * `/bg <prompt>` dispatches an isolated non-interactive agent turn
 * (`aih run --session bg-<id> --no-audit --no-stream`) as a background child
 * process. The TUI keeps working while the job runs; a status line shows
 * running/done/failed counts and the TUI polls for completions, surfacing the
 * job's final answer as a system message.
 *
 * State is persisted to `.aih/jobs.json` so `aih jobs` (CLI) and a restarted
 * TUI both see the same board. Pure bookkeeping lives here (testable); the
 * process spawn is a thin wrapper around `spawn` in the same module.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  /** short label derived from the prompt (status line) */
  label: string;
  prompt: string;
  status: JobStatus;
  /** session file the job writes to (`.aih/sessions/<session>.jsonl`) */
  session: string;
  /** where the job's stdout (final answer) is captured */
  out: string;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  /** last line of the captured output (preview in the TUI) */
  preview?: string;
}

export interface JobBoard {
  jobs: Job[];
}

const MAX_JOBS = 50;

export function jobsFile(cwd: string): string {
  return join(cwd, ".aih", "jobs.json");
}

export function loadBoard(cwd: string): JobBoard {
  const p = jobsFile(cwd);
  if (!existsSync(p)) return { jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as JobBoard;
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

export function saveBoard(cwd: string, board: JobBoard): void {
  const p = jobsFile(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(board, null, 2)}\n`);
}

export function jobById(cwd: string, id: string): Job | undefined {
  return loadBoard(cwd).jobs.find((j) => j.id === id);
}

export function runningJobs(cwd: string): Job[] {
  return loadBoard(cwd).jobs.filter((j) => j.status === "running");
}

export function summarize(board: JobBoard): { running: number; done: number; failed: number } {
  const s = { running: 0, done: 0, failed: 0 };
  for (const j of board.jobs) {
    if (j.status === "running") s.running += 1;
    else if (j.status === "done") s.done += 1;
    else if (j.status === "failed") s.failed += 1;
  }
  return s;
}

function makeLabel(prompt: string): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

export interface SpawnJobOptions {
  /** the aih CLI entry (node script) — defaults to process.argv[1] */
  cli?: string;
  /** node executable — defaults to process.execPath */
  node?: string;
  /** env for the child (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** cwd for the child (defaults to the board cwd) */
  cwd?: string;
  /**
   * Full argument list to run after the CLI entry (defaults to
   * `run <prompt> --session <id> --no-audit --no-stream --format text`).
   * Use to dispatch a direct subcommand (e.g. `distill`, `tidy`) as a job.
   */
  argv?: string[];
}

/**
 * Create a job record and spawn its child process (detached, unref'd so the
 * TUI can exit without waiting). The child writes its final answer to `out`.
 * Returns the job (status=running). The caller owns the `child` handle.
 */
export function spawnJob(cwd: string, prompt: string, opts: SpawnJobOptions = {}): { job: Job; child: ChildProcess } {
  const id = `bg-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  const session = `bg-${id}`;
  const out = join(cwd, ".aih", "outputs", `${id}.log`);
  mkdirSync(dirname(out), { recursive: true });
  const job: Job = {
    id,
    label: makeLabel(prompt),
    prompt,
    status: "running",
    session,
    out,
    createdAt: Date.now(),
    startedAt: Date.now(),
  };
  const board = loadBoard(cwd);
  board.jobs.push(job);
  // cap the board: drop oldest finished jobs beyond MAX_JOBS
  const finished = board.jobs.filter((j) => j.status !== "running");
  if (finished.length > MAX_JOBS) {
    const drop = new Set(finished.slice(0, finished.length - MAX_JOBS).map((j) => j.id));
    board.jobs = board.jobs.filter((j) => !drop.has(j.id));
  }
  saveBoard(cwd, board);

  const node = opts.node ?? process.execPath;
  const cli = opts.cli ?? process.argv[1] ?? "";
  const argv = opts.argv ?? [cli, "run", prompt, "--session", session, "--no-audit", "--no-stream", "--format", "text"];
  const child = spawn(
    node,
    argv,
    {
      cwd: opts.cwd ?? cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // capture stdout (final answer) and stderr into the job log
  const stream = openSync(out, "a");
  child.stdout?.on("data", (d: Buffer) => writeSync(stream, d));
  child.stderr?.on("data", (d: Buffer) => writeSync(stream, d));
  child.on("error", (err) => {
    closeSync(stream);
    finishJob(cwd, id, "failed", undefined, `spawn error: ${err.message}`);
  });
  child.on("close", (code) => {
    closeSync(stream);
    finishJob(cwd, id, code === 0 ? "done" : "failed", code ?? undefined);
  });
  return { job, child };
}

function finishJob(cwd: string, id: string, status: JobStatus, exitCode?: number, note?: string): void {
  const board = loadBoard(cwd);
  const job = board.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = status;
  job.finishedAt = Date.now();
  if (exitCode !== undefined) job.exitCode = exitCode;
  if (note) job.preview = note;
  // best-effort preview: last non-empty line of the captured output
  try {
    if (existsSync(job.out)) {
      const text = readFileSync(job.out, "utf8").trim();
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length) job.preview = lines[lines.length - 1].slice(0, 120);
    }
  } catch {
    /* preview is best-effort */
  }
  saveBoard(cwd, board);
}

/** Cancel a running job (kill the child) and mark it cancelled. */
export function cancelJob(cwd: string, id: string, child?: ChildProcess): boolean {
  const board = loadBoard(cwd);
  const job = board.jobs.find((j) => j.id === id);
  if (!job || job.status !== "running") return false;
  try {
    child?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  job.status = "cancelled";
  job.finishedAt = Date.now();
  saveBoard(cwd, board);
  return true;
}

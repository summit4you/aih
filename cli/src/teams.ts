/**
 * D#15 — Agent Teams (minimal): roster + task board + mailbox.
 *
 * A "team" is a plain-file workspace under `.aih/team/`:
 *   - `team.json`   roster (named agents, optional role/prompt) + task board
 *   - `mailbox/<agent>.jsonl`  append-only message inbox per agent
 *
 * This is the collaboration layer on top of the already-delivered subagent
 * primitives (D#18 `task` tool, P2#9 best-of-N): the board is the shared
 * source of truth, the mailbox is how agents hand work to each other, and
 * `aih team dispatch <task> --as <agent>` runs one synchronous agent turn
 * against a claimed task (reusing `spawnJob` for the child + job board).
 *
 * Pure bookkeeping lives here (testable without a TTY or LLM); the actual
 * agent turn is a thin `spawn` wrapper, exactly like D#13 background jobs.
 */
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnJob } from "./jobs.js";

export type TaskStatus = "todo" | "claimed" | "done" | "failed" | "cancelled";

export interface TeamAgent {
  name: string;
  /** short role description shown in `aih team list` */
  role?: string;
  /** optional per-agent prompt prefix used when dispatching */
  prompt?: string;
}

export interface TeamTask {
  id: string;
  title: string;
  /** full prompt / instructions for the task */
  detail?: string;
  status: TaskStatus;
  /** agent that claimed the task (roster name) */
  assignee?: string;
  /** session name the dispatch writes to */
  session?: string;
  /** captured output log of the dispatch */
  out?: string;
  createdAt: number;
  updatedAt: number;
  /** last line of the dispatch output (preview) */
  preview?: string;
}

export interface TeamMail {
  from: string;
  to: string;
  body: string;
  ts: number;
}

export interface TeamState {
  agents: TeamAgent[];
  tasks: TeamTask[];
}

const MAX_TASKS = 100;
const MAX_MAIL = 200;

export function teamDir(cwd: string): string {
  return join(cwd, ".aih", "team");
}

export function teamFile(cwd: string): string {
  return join(cwd, ".aih", "team", "team.json");
}

export function mailboxFile(cwd: string, agent: string): string {
  return join(cwd, ".aih", "team", "mailbox", `${agent}.jsonl`);
}

export function loadTeam(cwd: string): TeamState {
  const p = teamFile(cwd);
  if (!existsSync(p)) return { agents: [], tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as TeamState;
    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return { agents: [], tasks: [] };
  }
}

export function saveTeam(cwd: string, state: TeamState): void {
  const p = teamFile(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

// --- roster -----------------------------------------------------------------

export function addAgent(cwd: string, name: string, role?: string, prompt?: string): TeamAgent {
  const clean = name.trim();
  if (!clean) throw new Error("agent name must be non-empty");
  if (/[/\\\s]/.test(clean)) throw new Error(`invalid agent name "${name}" (no whitespace or path separators)`);
  const state = loadTeam(cwd);
  const existing = state.agents.find((a) => a.name === clean);
  if (existing) {
    if (role !== undefined) existing.role = role;
    if (prompt !== undefined) existing.prompt = prompt;
  } else {
    state.agents.push({ name: clean, ...(role ? { role } : {}), ...(prompt ? { prompt } : {}) });
  }
  saveTeam(cwd, state);
  return state.agents.find((a) => a.name === clean)!;
}

export function removeAgent(cwd: string, name: string): boolean {
  const state = loadTeam(cwd);
  const before = state.agents.length;
  state.agents = state.agents.filter((a) => a.name !== name);
  if (state.agents.length !== before) {
    saveTeam(cwd, state);
    return true;
  }
  return false;
}

export function agentByName(cwd: string, name: string): TeamAgent | undefined {
  return loadTeam(cwd).agents.find((a) => a.name === name);
}

// --- task board ---------------------------------------------------------------

let taskSeq = 0;
function makeTaskId(): string {
  // counter + random tail keep same-millisecond ids distinct (prefix
  // resolution stays unambiguous)
  taskSeq = (taskSeq + 1) % 1296;
  return `t-${Date.now().toString(36)}-${taskSeq.toString(36)}${randomUUID().slice(0, 4)}`;
}

export function addTask(cwd: string, title: string, detail?: string): TeamTask {
  const clean = title.trim();
  if (!clean) throw new Error("task title must be non-empty");
  const state = loadTeam(cwd);
  const now = Date.now();
  const task: TeamTask = {
    id: makeTaskId(),
    title: clean,
    ...(detail?.trim() ? { detail: detail.trim() } : {}),
    status: "todo",
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  // cap the board: drop oldest finished tasks beyond MAX_TASKS
  const finished = state.tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
  if (finished.length > MAX_TASKS) {
    const drop = new Set(finished.slice(0, finished.length - MAX_TASKS).map((t) => t.id));
    state.tasks = state.tasks.filter((t) => !drop.has(t.id));
  }
  saveTeam(cwd, state);
  return task;
}

export function taskById(cwd: string, id: string): TeamTask | undefined {
  return loadTeam(cwd).tasks.find((t) => t.id === id);
}

/** Resolve a task by exact id, or by unique id prefix. */
export function resolveTask(cwd: string, ref: string): TeamTask | undefined {
  const state = loadTeam(cwd);
  const exact = state.tasks.find((t) => t.id === ref);
  if (exact) return exact;
  const hits = state.tasks.filter((t) => t.id.startsWith(ref));
  return hits.length === 1 ? hits[0] : undefined;
}

export function openTasks(cwd: string): TeamTask[] {
  return loadTeam(cwd).tasks.filter((t) => t.status === "todo" || t.status === "claimed");
}

export function claimTask(cwd: string, ref: string, agent: string): TeamTask {
  const state = loadTeam(cwd);
  const task = state.tasks.find((t) => t.id === ref || t.id.startsWith(ref));
  if (!task) throw new Error(`no task "${ref}"`);
  if (task.status !== "todo") throw new Error(`task ${task.id} is ${task.status}, not claimable`);
  task.status = "claimed";
  task.assignee = agent;
  task.updatedAt = Date.now();
  saveTeam(cwd, state);
  return task;
}

export function setTaskStatus(cwd: string, ref: string, status: TaskStatus, preview?: string): TeamTask {
  const state = loadTeam(cwd);
  const task = state.tasks.find((t) => t.id === ref || t.id.startsWith(ref));
  if (!task) throw new Error(`no task "${ref}"`);
  task.status = status;
  task.updatedAt = Date.now();
  if (preview !== undefined) task.preview = preview;
  saveTeam(cwd, state);
  return task;
}

// --- mailbox ------------------------------------------------------------------

export function sendMail(cwd: string, from: string, to: string, body: string): TeamMail {
  const cleanTo = to.trim();
  if (!cleanTo) throw new Error("recipient must be non-empty");
  const mail: TeamMail = { from: from || "system", to: cleanTo, body: body.trim(), ts: Date.now() };
  const p = mailboxFile(cwd, cleanTo);
  mkdirSync(dirname(p), { recursive: true });
  const stream = openSync(p, "a");
  try {
    writeSync(stream, `${JSON.stringify(mail)}\n`);
  } finally {
    closeSync(stream);
  }
  // cap the inbox: keep the most recent MAX_MAIL messages
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > MAX_MAIL) {
      writeFileSync(p, `${lines.slice(lines.length - MAX_MAIL).join("\n")}\n`);
    }
  } catch {
    /* cap is best-effort */
  }
  return mail;
}

export function readMail(cwd: string, to: string, unreadOnly = false): TeamMail[] {
  const p = mailboxFile(cwd, to.trim());
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as TeamMail;
        } catch {
          return null;
        }
      })
      .filter((m): m is TeamMail => m !== null)
      .filter((m) => (unreadOnly ? m.ts > lastReadAt(cwd, to) : true));
  } catch {
    return [];
  }
}

function lastReadAt(cwd: string, to: string): number {
  const p = join(cwd, ".aih", "team", "mailbox", `.read-${to}`);
  if (!existsSync(p)) return 0;
  try {
    return Number(readFileSync(p, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

export function markRead(cwd: string, to: string): number {
  const p = join(cwd, ".aih", "team", "mailbox", `.read-${to.trim()}`);
  mkdirSync(dirname(p), { recursive: true });
  const now = Date.now();
  writeFileSync(p, `${now}\n`);
  return now;
}

// --- dispatch -----------------------------------------------------------------

export interface DispatchOptions {
  /** the aih CLI entry (node script) */
  cli?: string;
  node?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Dispatch one agent turn against a claimed (or claimable) task.
 *
 * The prompt is the task's `detail` (falling back to `title`), prefixed with
 * the assignee's roster prompt if one is set. The turn runs as
 * `aih run <prompt> --session team-<task> --no-audit --no-stream --format text`
 * via `spawnJob`, so it shows up on the D#13 background-job board too.
 *
 * Returns `{ job, child, task }`.
 */
export function dispatchTask(
  cwd: string,
  ref: string,
  agent: string,
  opts: DispatchOptions = {},
): { job: import("./jobs.js").Job; child: ChildProcess; task: TeamTask } {
  const state = loadTeam(cwd);
  const task = state.tasks.find((t) => t.id === ref || t.id.startsWith(ref));
  if (!task) throw new Error(`no task "${ref}"`);
  const roster = state.agents.find((a) => a.name === agent);
  // claim if still open (idempotent for an already-claimed task by the same agent)
  if (task.status === "todo") {
    task.status = "claimed";
    task.assignee = agent;
    task.updatedAt = Date.now();
  } else if (task.status !== "claimed") {
    throw new Error(`task ${task.id} is ${task.status}, not dispatchable`);
  }
  const prompt = [roster?.prompt?.trim(), task.detail?.trim() || task.title.trim()].filter(Boolean).join("\n\n");
  const cli = opts.cli ?? process.argv[1] ?? "";
  // spawnJob owns the session id + output path (D#13 pattern); record them on
  // the task for later inspection. The job board (.aih/jobs.json) is the
  // source of truth for liveness; the task board mirrors the outcome.
  const { job, child } = spawnJob(cwd, prompt, {
    cli,
    node: opts.node,
    env: opts.env,
    cwd: opts.cwd,
  });
  task.session = job.session;
  task.out = job.out;
  task.updatedAt = Date.now();
  saveTeam(cwd, state);
  return { job, child, task };
}

/** Summarize the board for the status line / TUI. */
export function summarizeTeam(state: TeamState): {
  agents: number;
  todo: number;
  claimed: number;
  done: number;
  failed: number;
} {
  const s = { agents: state.agents.length, todo: 0, claimed: 0, done: 0, failed: 0 };
  for (const t of state.tasks) {
    if (t.status === "todo") s.todo += 1;
    else if (t.status === "claimed") s.claimed += 1;
    else if (t.status === "done") s.done += 1;
    else if (t.status === "failed") s.failed += 1;
  }
  return s;
}

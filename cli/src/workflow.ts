// Deterministic workflow engine (roadmap F#33 / P1#6, MiMo `.mimocode/workflows/*.js` parity).
//
// A workflow is a plain `.mjs` module in `.aih/workflows/<name>.mjs` exporting
// (default or named `workflow`) a phase list. Phases run sequentially; each
// phase is one or more agent calls (parallel when `prompts` is given), with a
// bounded retry budget and an optional `expect` substring gate on the phase
// output. The whole run is non-interactive and ends in a JSON-serializable
// report — the generalization of AIH's eval/bench gate to app-defined checks.
//
// Design notes (loop-design-check skill): the goal is machine-decidable
// (every phase either contains `expect` or fails), retries are bounded
// (`retries`), and a failing phase stops the run (fail-fast) so a wrong
// answer is never carried forward into later phases.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface WorkflowPhase {
  name: string;
  /** single agent call (use `prompts` for parallel dispatch) */
  prompt?: string;
  /** parallel agent calls; outputs are joined for the `expect` gate */
  prompts?: string[];
  /** extra attempts after the first failure (default 1 → 2 total attempts) */
  retries?: number;
  /** substring that must appear in the phase output for the phase to pass */
  expect?: string;
}

export interface WorkflowDef {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

export interface PhaseReport {
  name: string;
  ok: boolean;
  attempts: number;
  parallel: number;
  ms: number;
  outputs: string[];
  error?: string;
}

export interface WorkflowReport {
  workflow: string;
  ok: boolean;
  startedAt: string;
  ms: number;
  phases: PhaseReport[];
  failedPhase?: string;
}

/** One agent call: prompt in, final assistant text out. */
export type SendFn = (prompt: string) => Promise<string>;

function validateDef(raw: unknown, source: string): WorkflowDef {
  const def = (raw && typeof raw === "object" && "phases" in (raw as object)
    ? (raw as { phases: unknown })
    : raw) as WorkflowDef | undefined;
  if (!def || !Array.isArray(def.phases) || def.phases.length === 0) {
    throw new Error(
      `workflow "${source}" is invalid: must export { phases: [...] } with at least one phase`,
    );
  }
  for (const [i, p] of def.phases.entries()) {
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name) {
      throw new Error(`workflow "${source}" phase #${i + 1}: missing "name"`);
    }
    const hasPrompt = typeof p.prompt === "string" && p.prompt.trim().length > 0;
    const hasPrompts = Array.isArray(p.prompts) && p.prompts.length > 0;
    if (!hasPrompt && !hasPrompts) {
      throw new Error(`workflow "${source}" phase "${p.name}": needs "prompt" or "prompts"`);
    }
    if (hasPrompt && hasPrompts) {
      throw new Error(`workflow "${source}" phase "${p.name}": use "prompt" XOR "prompts"`);
    }
    if (p.retries !== undefined && (!Number.isInteger(p.retries) || p.retries < 0)) {
      throw new Error(`workflow "${source}" phase "${p.name}": "retries" must be an integer ≥ 0`);
    }
  }
  return def;
}

export async function loadWorkflow(cwd: string, name: string): Promise<WorkflowDef> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "");
  const dir = join(cwd, ".aih", "workflows");
  if (!existsSync(dir)) {
    throw new Error(`no workflows directory at ${dir} (create .aih/workflows/${safe}.mjs)`);
  }
  const candidates = [join(dir, `${safe}.mjs`), join(dir, `${safe}.js`), join(dir, safe)];
  const file = candidates.find((f) => existsSync(f) && statSync(f).isFile());
  if (!file) {
    const have = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
      .map((f) => f.replace(/\.(mjs|js)$/, ""));
    throw new Error(
      `workflow "${name}" not found in ${dir}${have.length ? ` (available: ${have.join(", ")})` : ""}`,
    );
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: unknown;
    workflow?: unknown;
  };
  return validateDef(mod.default ?? mod.workflow, safe);
}

export interface WorkflowInfo {
  name: string;
  description?: string;
  phases: number;
}

export function listWorkflows(cwd: string): WorkflowInfo[] {
  const dir = join(cwd, ".aih", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.(mjs|js)$/, ""),
      description: undefined as string | undefined,
      phases: 0,
    }));
}

/** Fill in description/phase count by importing each workflow (best-effort). */
export async function describeWorkflows(cwd: string): Promise<WorkflowInfo[]> {
  const infos = listWorkflows(cwd);
  await Promise.all(
    infos.map(async (info) => {
      try {
        const def = await loadWorkflow(cwd, info.name);
        info.description = def.description;
        info.phases = def.phases.length;
      } catch {
        /* keep the bare listing; run will surface the real error */
      }
    }),
  );
  return infos;
}

async function runPhase(
  phase: WorkflowPhase,
  send: SendFn,
  onAttempt?: (attempt: number, status: "start" | "pass" | "fail") => void,
): Promise<PhaseReport> {
  const maxAttempts = 1 + (phase.retries ?? 1);
  const prompts = phase.prompts ?? [phase.prompt as string];
  const started = Date.now();
  let lastError = "";
  let lastOutputs: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onAttempt?.(attempt, "start");
    let outputs: string[];
    try {
      outputs = await Promise.all(prompts.map((p) => send(p)));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      onAttempt?.(attempt, "fail");
      continue;
    }
    lastOutputs = outputs;
    const joined = outputs.join("\n\n---\n\n");
    if (phase.expect && !joined.includes(phase.expect)) {
      lastError = `expect gate failed: output does not contain ${JSON.stringify(phase.expect)}`;
      onAttempt?.(attempt, "fail");
      continue;
    }
    onAttempt?.(attempt, "pass");
    return {
      name: phase.name,
      ok: true,
      attempts: attempt,
      parallel: prompts.length,
      ms: Date.now() - started,
      outputs,
    };
  }
  return {
    name: phase.name,
    ok: false,
    attempts: maxAttempts,
    parallel: prompts.length,
    ms: Date.now() - started,
    outputs: lastOutputs,
    error: lastError || "phase failed",
  };
}

export async function runWorkflow(
  def: WorkflowDef,
  send: SendFn,
  opts?: { onPhase?: (phase: WorkflowPhase, report: PhaseReport) => void },
): Promise<WorkflowReport> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const phases: PhaseReport[] = [];
  let failedPhase: string | undefined;
  for (const phase of def.phases) {
    const report = await runPhase(phase, send);
    phases.push(report);
    opts?.onPhase?.(phase, report);
    if (!report.ok) {
      failedPhase = phase.name;
      break; // fail-fast: never carry a failed gate into later phases
    }
  }
  return {
    workflow: def.name ?? "(unnamed)",
    ok: !failedPhase,
    startedAt,
    ms: Date.now() - started,
    phases,
    ...(failedPhase ? { failedPhase } : {}),
  };
}

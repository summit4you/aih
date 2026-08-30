/**
 * PE#1/PE#2/PE#4 — CLI wiring for the core safety seam.
 *
 *   - PE#2  budget hard constraint + tripwire  (AIH_BUDGET / config `budget`)
 *   - PE#1  computational sensors              (AIH_SENSORS / config `sensors`)
 *   - PE#4  escalate primitive                 (interactive: TUI options;
 *                                               non-interactive: exit code 3)
 *
 * Pure config parsing + a spawn-based sensor executor (buildChildEnv, so
 * child processes never inherit secrets). All state machines live in
 * core/src/budget.ts (BudgetTracker / SensorLoop) — this module only
 * translates config → core objects and core hooks → UI/exit behavior.
 */
import { spawn } from "node:child_process";
import {
  BudgetTracker,
  SensorLoop,
  parseBudget,
} from "@aih/core";
import type { BudgetLimits, SensorSpec } from "@aih/core";
import { buildChildEnv } from "./env-policy.js";

/** PE#4 — non-interactive runs exit with this code after an escalate. */
export const ESCALATE_EXIT_CODE = 3;

/** Default sensor command timeout (ms). */
const SENSOR_TIMEOUT_MS = Number(process.env.AIH_SENSOR_TIMEOUT_MS ?? "") || 60_000;
/** Max sensor output kept in the feedback line. */
const SENSOR_OUT_MAX = 1_200;

/** A sensor declared in config / AIH_SENSORS (command-backed). */
export interface SensorConfig {
  name: string;
  /** write tool names that trigger this sensor (default: all writes). */
  onTools?: string[];
  /** only run when the written path is under this prefix. */
  pathPrefix?: string;
  /** shell command to run (cwd = project root). Exit 0 = green. */
  command: string;
  /** timeout in ms (default AIH_SENSOR_TIMEOUT_MS, 60s). */
  timeoutMs?: number;
}

export interface SafetyConfig {
  budget?: BudgetLimits;
  sensors?: SensorConfig[];
  /** sensor retry budget before escalation (default 1). */
  sensorRetries?: number;
}

/**
 * Load the safety config from the `AIH_BUDGET` / `AIH_SENSORS` env vars.
 * `AIH_BUDGET`: JSON or `maxCostUsd=1|maxWrites=5|timeoutMs=60000|denyPaths=a|b`.
 * `AIH_SENSORS`: JSON array of SensorConfig (or a single object).
 * Returns `{}` when nothing is configured (the loop then no-ops).
 */
export function loadEnvSafety(): SafetyConfig {
  const out: SafetyConfig = {};
  const budgetRaw = process.env.AIH_BUDGET;
  if (budgetRaw) {
    let limits: BudgetLimits;
    try {
      const parsed = JSON.parse(budgetRaw) as Record<string, unknown>;
      limits = parseBudget(parsed);
    } catch {
      limits = parseBudget(budgetRaw);
    }
    if (
      limits.maxCostUsd !== undefined ||
      limits.maxWrites !== undefined ||
      limits.timeoutMs !== undefined ||
      (limits.denyPaths && limits.denyPaths.length)
    ) {
      out.budget = limits;
    }
  }
  const sensorsRaw = process.env.AIH_SENSORS;
  if (sensorsRaw) {
    try {
      const parsed = JSON.parse(sensorsRaw) as SensorConfig | SensorConfig[];
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const valid = arr.filter((s) => s && typeof s.command === "string" && s.command.trim());
      if (valid.length) out.sensors = valid;
    } catch {
      /* malformed AIH_SENSORS → no sensors (never crash the loop) */
    }
  }
  const retries = Number(process.env.AIH_SENSOR_RETRIES ?? "");
  if (Number.isFinite(retries) && retries >= 0) out.sensorRetries = Math.floor(retries);
  return out;
}

/** Merge a config-file `safety` block (same shape as env) with the env layer. */
export function mergeSafety(base: SafetyConfig, extra?: Partial<SafetyConfig>): SafetyConfig {
  const out: SafetyConfig = { ...base };
  if (extra?.budget) out.budget = { ...base.budget, ...extra.budget };
  if (extra?.sensors) out.sensors = extra.sensors;
  if (extra?.sensorRetries !== undefined) out.sensorRetries = extra.sensorRetries;
  return out;
}

/**
 * Run a sensor command with a timeout. Resolves (never throws):
 * exit 0 → green; non-zero/timeout/crash → red with a detail line.
 */
export function runSensorCommand(
  command: string,
  cwd: string,
  timeoutMs: number = SENSOR_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (!settled) {
        settled = true;
        resolve({ ok, detail });
      }
    };
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: buildChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(false, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let out = "";
    const cap = (d: Buffer) => {
      out += d.toString();
      if (out.length > 8_000) out = out.slice(-8_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(false, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(false, `spawn error: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trim().split("\n").slice(-4).join(" | ").slice(0, SENSOR_OUT_MAX);
      if (code === 0) finish(true, "ok");
      else finish(false, `exit ${code}${tail ? ` — ${tail}` : ""}`);
    });
  });
}

/** Build the core SensorLoop from a SafetyConfig (command-backed sensors). */
export function buildSensorLoop(cfg: SafetyConfig, cwd: string): SensorLoop | undefined {
  if (!cfg.sensors || cfg.sensors.length === 0) return undefined;
  const specs: SensorSpec[] = cfg.sensors.map((s) => ({
    name: s.name || s.command,
    onTools: s.onTools && s.onTools.length ? s.onTools : ["write_file", "edit", "apply_patch"],
    ...(s.pathPrefix ? { pathPrefix: s.pathPrefix } : {}),
    run: async () => {
      const r = await runSensorCommand(s.command, cwd, s.timeoutMs ?? SENSOR_TIMEOUT_MS);
      return { ok: r.ok, detail: r.detail };
    },
  }));
  return new SensorLoop(specs, { retries: cfg.sensorRetries ?? 1 });
}

/** Build the core BudgetTracker from a SafetyConfig. */
export function buildBudget(cfg: SafetyConfig): BudgetTracker | undefined {
  if (!cfg.budget) return undefined;
  const { maxCostUsd, maxWrites, timeoutMs, denyPaths } = cfg.budget;
  if (
    maxCostUsd === undefined &&
    maxWrites === undefined &&
    timeoutMs === undefined &&
    (!denyPaths || denyPaths.length === 0)
  ) {
    return undefined;
  }
  return new BudgetTracker(cfg.budget);
}

export interface SafetyHooks {
  budget?: BudgetTracker;
  sensors?: SensorLoop;
  /** PE#2 — tripwire (soft) surface. */
  onTripwire: (v: { reason: string; currentCostUsd: number; meanCostUsd: number }) => void;
  /** PE#4 — escalate surface. */
  onEscalate: (v: { reason: string; options: string[]; safestDefault: string }) => void;
}

/**
 * Build the full hook set for a loop. `interactive` selects the surface:
 *   - interactive (TUI): system rows with the options + safest default
 *   - non-interactive: stderr lines (the caller exits with ESCALATE_EXIT_CODE
 *     when a turn ends with stopReason "escalated")
 */
export function buildSafetyHooks(
  cfg: SafetyConfig,
  opts: { cwd: string; interactive?: boolean; line?: (t: string) => void },
): SafetyHooks | undefined {
  const budget = buildBudget(cfg);
  const sensors = buildSensorLoop(cfg, opts.cwd);
  if (!budget && !sensors) return undefined;
  const line = opts.line ?? ((t: string) => process.stderr.write(`${t}\n`));
  return {
    budget,
    sensors,
    onTripwire: (v) => {
      line(
        `⚠ [budget] tripwire: ${v.reason} — continuing, but a human should review ` +
          `(PE#2: cost > 2× session mean)`,
      );
    },
    onEscalate: (v) => {
      line(`⛔ [escalate] ${v.reason}`);
      for (const [i, o] of v.options.entries()) line(`   ${i + 1}. ${o}`);
      line(`   (safest default: ${v.safestDefault})`);
      if (!opts.interactive) {
        line(`   non-interactive: stopping — exit code ${ESCALATE_EXIT_CODE}`);
      }
    },
  };
}

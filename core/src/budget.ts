/**
 * PE#2 — budget hard constraint + tripwire.
 *
 * Upgrades cost.ts from DISPLAY to ENFORCEMENT. The harness (not the model)
 * enforces usage bounds. A BudgetTracker accumulates cost ($), write counts
 * and wall-clock duration across turns/steps and returns a verdict each time
 * it is checked:
 *   - `ok`            — within every bound.
 *   - `soft` (tripwire) — single-task cost exceeded 2× the session mean; the
 *     caller should PAUSE and surface a non-silent notice, but may continue
 *     if the human confirms.
 *   - `hard`          — a hard bound ($ / writes / timeout) was exceeded; the
 *     caller must STOP and escalate.
 *
 * All state transitions are pure (no I/O, no Date.now reads inside unless
 * injected) so the module is unit-testable without a live loop. `nowMs`
 * defaults to Date.now() but callers may inject a clock for deterministic
 * tests.
 *
 * Design notes:
 *   - cost is tracked as a running total in dollars (micro-units to avoid FP
 *     drift); write counts are increments; timeout is wall-clock from `startMs`.
 *   - Precedence, matching the ask-floor discipline of CC#53: any hard bound
 *     hit is reported; if both budget and writes are over, the first bound in
 *     [cost, writes, timeout] order wins the `reason` label (deterministic).
 *   - tripwire fires once (latch) and only for COST (per PE#2: "single-task
 *     cost > 2× session mean → pause"). It is not itself a hard stop.
 */
import type { TokenUsage } from "./types.js";

export interface BudgetLimits {
  /** Max allowed task cost in US dollars (micro-units are internal). */
  maxCostUsd?: number;
  /** Max number of write-kind tool calls for the whole task. */
  maxWrites?: number;
  /** Max wall-clock duration of the whole task in milliseconds. */
  timeoutMs?: number;
  /**
   * Scope deny list — path prefixes that are off-limits. A write targeting
   * any denied path is immediately a hard violation regardless of budget.
   * Optional; complements the existing path allow-list (CC#/F# path whitelist).
   */
  denyPaths?: string[];
}

export type BudgetVerdict =
  | { state: "ok" }
  | {
      state: "soft";
      /** which soft trigger fired (always "tripwire" for now) */
      kind: "tripwire";
      reason: string;
      currentCostUsd: number;
      meanCostUsd: number;
    }
  | {
      state: "hard";
      /** which hard bound fired: cost | writes | timeout | scope */
      kind: "cost" | "writes" | "timeout" | "scope";
      reason: string;
      currentCostUsd: number;
      writeCount: number;
      elapsedMs: number;
    };

export interface BudgetCheck {
  usage?: TokenUsage;
  /** cost ($) to add for this usage chunk, if known. */
  costUsd?: number;
  /** number of write-kind calls performed since the last check (default 0). */
  writes?: number;
  /** absolute: number of write calls performed so far in the whole task. */
  cumulativeWrites?: number;
  /** file path targeted by a write (for scope deny check). */
  writePath?: string;
}

/** Exception thrown when a HARD budget bound is exceeded (caller must escalate). */
export class BudgetExceeded extends Error {
  verdict: BudgetVerdict;
  constructor(verdict: Extract<BudgetVerdict, { state: "hard" }>) {
    super(`budget exceeded: ${verdict.kind} — ${verdict.reason}`);
    this.name = "BudgetExceeded";
    this.verdict = verdict;
  }
}

export class BudgetTracker {
  readonly limits: BudgetLimits;
  /** running cost in micro-dollars (µ$) to avoid FP drift. */
  #microUsd = 0;
  #writes = 0;
  #startMs: number;
  #meanCostUsd: number | null = null;
  #tripwireFired = false;
  /** counts cost checks that carried a real usage chunk (for the running mean). */
  #costSamples = 0;

  /** injectable clock (defaults to Date.now) for deterministic timeout tests */
  #now: () => number;

  constructor(limits: BudgetLimits, opts: { startMs?: number; now?: () => number } = {}) {
    this.limits = limits;
    this.#now = opts.now ?? (() => Date.now());
    this.#startMs = opts.startMs ?? this.#now();
  }

  get currentCostUsd(): number {
    return this.#microUsd / 1e6;
  }
  get writeCount(): number {
    return this.#writes;
  }
  get elapsedMs(): number {
    return Math.max(0, this.#now() - this.#startMs);
  }
  /** Session-mean cost per cost-bearing check, for the tripwire comparison. */
  get meanCostUsd(): number {
    return this.#costSamples === 0 ? 0 : this.currentCostUsd / this.#costSamples;
  }

  /**
   * Record a cost-bearing usage sample (for the running mean and tripwire).
   * Pure-in-effect: only mutates counters; deterministic given inputs.
   */
  addUsage(costUsd: number): void {
    if (costUsd <= 0) return;
    this.#microUsd += Math.round(costUsd * 1e6);
    this.#costSamples += 1;
    if (this.#meanCostUsd === null && this.#costSamples > 0) {
      // hold a first-pass mean estimate for the tripwire denominator
      this.#meanCostUsd = this.#microUsd / 1e6 / this.#costSamples;
    }
  }

  /** Record write-kind tool calls (cumulative). */
  addWrites(count: number): void {
    if (count > 0) this.#writes += count;
  }

  /**
   * Check the current state against every bound. Pure: does not mutate state
   * (tripwire latch is NOT persisted here — the caller owns the side effect).
   */
  check(check: BudgetCheck = {}): BudgetVerdict {
    const { limits } = this;
    if (check.costUsd !== undefined) this.addUsage(check.costUsd);
    if (check.cumulativeWrites !== undefined) this.#writes = check.cumulativeWrites;
    else if (check.writes !== undefined) this.addWrites(check.writes);

    const cost = this.currentCostUsd;
    const writes = this.writeCount;
    const elapsed = this.#now() - this.#startMs;

    // scope deny check first — a denied path is a hard violation regardless
    if (
      check.writePath &&
      limits.denyPaths &&
      limits.denyPaths.some((p) => isDenied(check.writePath!, p))
    ) {
      return {
        state: "hard",
        kind: "scope",
        reason: `write targets denied path ${check.writePath}`,
        currentCostUsd: cost,
        writeCount: writes,
        elapsedMs: elapsed,
      };
    }

    // hard bounds, deterministic order: cost → writes → timeout
    if (limits.maxCostUsd !== undefined && cost >= limits.maxCostUsd) {
      return {
        state: "hard",
        kind: "cost",
        reason: `cost $${cost.toFixed(4)} ≥ $${limits.maxCostUsd}`,
        currentCostUsd: cost,
        writeCount: writes,
        elapsedMs: elapsed,
      };
    }
    if (limits.maxWrites !== undefined && writes >= limits.maxWrites) {
      return {
        state: "hard",
        kind: "writes",
        reason: `writes ${writes} ≥ ${limits.maxWrites}`,
        currentCostUsd: cost,
        writeCount: writes,
        elapsedMs: elapsed,
      };
    }
    if (limits.timeoutMs !== undefined && elapsed >= limits.timeoutMs) {
      return {
        state: "hard",
        kind: "timeout",
        reason: `elapsed ${Math.round(elapsed / 1000)}s ≥ ${Math.round(limits.timeoutMs / 1000)}s`,
        currentCostUsd: cost,
        writeCount: writes,
        elapsedMs: elapsed,
      };
    }

    // soft tripwire: single-task cost > 2× session mean (latched, cost only)
    if (!this.#tripwireFired && this.#costSamples >= 2) {
      const mean = this.currentCostUsd / this.#costSamples;
      if (mean > 0 && cost >= 2 * mean) {
        return {
          state: "soft",
          kind: "tripwire",
          reason: `task cost $${cost.toFixed(4)} ≥ 2× session mean $${(2 * mean).toFixed(4)}`,
          currentCostUsd: cost,
          meanCostUsd: mean,
        };
      }
    }

    return { state: "ok" };
  }

  /** Persist the tripwire latch (call this when you surface the soft verdict). */
  latchTripwire(): void {
    this.#tripwireFired = true;
  }

  /** Export a forward snapshot (for serialization / restore). */
  snapshot(): { microUsd: number; writes: number; costSamples: number; startMs: number } {
    return {
      microUsd: this.#microUsd,
      writes: this.#writes,
      costSamples: this.#costSamples,
      startMs: this.#startMs,
    };
  }
}

/**
 * PE#1 — computational sensor (写后验证循环).
 *
 * A sensor is a deterministic (non-LLM) check that runs AFTER write-kind tool
 * calls succeed. PE requires "computational before inferential": the harness
 * verifies the change with a machine before asking the model to judge.
 *
 * `run` is supplied by the caller (CLI) and executes the sensor command with
 * a timeout; the core only orchestrates the verdict → feedback → escalate
 * loop. `ok` is true when the sensor passed.
 */
export interface SensorRunResult {
  ok: boolean;
  /** short human/model-readable summary of the failure (or pass). */
  detail: string;
}

export interface SensorSpec {
  /** stable id for the sensor (appears in feedback + escalate events). */
  name: string;
  /** which write tool names trigger this sensor (e.g. ["write_file","edit"]). */
  onTools: string[];
  /** optional: only run when a written path matches this prefix. */
  pathPrefix?: string;
  /** execute the sensor; must resolve within the caller's timeout. */
  run: (ctx: { turnId: string; toolName: string; args: Record<string, unknown> }) => Promise<SensorRunResult>;
}

export interface SensorFeedback {
  /** model-visible feedback injected when a sensor fails (retry nudge). */
  feedback: string;
  /** true when we gave up after bounded retries → the caller must escalate. */
  escalated: boolean;
}

/**
 * PE#1 — orchestrate the sensor verdict loop. Pure state machine: `retryLeft`
 * counts remaining retries; each red verdict consumes one and returns feedback
 * for the model to fix; the final red returns `escalated: true`.
 */
export class SensorLoop {
  #retryLeft: number;
  constructor(specs: readonly SensorSpec[], opts: { retries?: number } = {}) {
    this.specs = specs;
    this.#retryLeft = Math.max(0, Math.floor(opts.retries ?? 1));
  }
  readonly specs: readonly SensorSpec[];

  /** Sensors applicable to a given write call (name + optional path prefix). */
  applicable(toolName: string, path?: string): SensorSpec[] {
    return this.specs.filter((s) => {
      if (!s.onTools.includes(toolName)) return false;
      if (s.pathPrefix) {
        if (!path) return false;
        const p = path.replace(/\\/g, "/");
        const d = s.pathPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
        if (p !== d && !p.startsWith(d + "/")) return false;
      }
      return true;
    });
  }

  /**
   * Run all applicable sensors after a successful write. Returns:
   *   - `passed: true` when every sensor is green (no feedback needed).
   *   - otherwise the first red sensor's feedback + whether retries are
   *     exhausted (escalated).
   */
  async afterWrite(
    toolName: string,
    args: Record<string, unknown>,
    turnId: string,
  ): Promise<{ passed: boolean; feedback?: string; escalated: boolean }> {
    const path = typeof args.path === "string" ? args.path : undefined;
    const specs = this.applicable(toolName, path);
    if (specs.length === 0) return { passed: true, escalated: false };
    for (const spec of specs) {
      let res: SensorRunResult;
      try {
        res = await spec.run({ turnId, toolName, args });
      } catch (err) {
        res = { ok: false, detail: `sensor ${spec.name} crashed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (res.ok) continue;
      const escalated = this.#retryLeft <= 0;
      if (!escalated) this.#retryLeft -= 1;
      return {
        passed: false,
        escalated,
        feedback:
          `[sensor ${spec.name} RED] ${res.detail}` +
          (escalated
            ? " — retries exhausted; a human must decide."
            : ` — fix the issue and re-run the write (retry ${this.#retryLeft} left).`),
      };
    }
    return { passed: true, escalated: false };
  }
}

/** Scope deny matching — exact or path-prefix (boundary-aware: `/` or nothing). */
export function isDenied(targetPath: string, deniedPrefix: string): boolean {
  const t = normalizeSlash(targetPath);
  const d = normalizeSlash(deniedPrefix);
  if (t === d) return true;
  return t.startsWith(d.endsWith("/") ? d : `${d}/`);
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Parse an `AIH_BUDGET` env/JSON string into BudgetLimits. Accepts JSON or key=value. */
export function parseBudget(spec: string | Record<string, unknown> | undefined): BudgetLimits {
  if (!spec) return {};
  if (typeof spec === "object") {
    const o = spec as Record<string, unknown>;
    return {
      maxCostUsd: num(o.maxCostUsd),
      maxWrites: int(o.maxWrites),
      timeoutMs: int(o.timeoutMs),
      denyPaths: Array.isArray(o.denyPaths) ? o.denyPaths.map(String) : undefined,
    };
  }
  const out: BudgetLimits = {};
  for (const pair of String(spec).split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k === "maxCostUsd") out.maxCostUsd = Number(v);
    else if (k === "maxWrites") out.maxWrites = Number(v);
    else if (k === "timeoutMs") out.timeoutMs = Number(v);
    else if (k === "denyPaths") out.denyPaths = v.split("|").filter(Boolean);
  }
  return out;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function int(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.floor(n);
}

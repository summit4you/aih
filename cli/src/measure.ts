/**
 * PR#2 — `aih measure`: a structural / behavioral distance instrument.
 *
 * The scorecard (PE#3) answers "how good is it now?" (a single point). This
 * module answers "how much did it change, and how?" — the Proteus principle:
 * "a measurement instrument, not just a score". It measures:
 *
 *   - `distance`     — per-surface STRUCTURAL distance between two snapshots:
 *                      added / dropped / revised entries + path length.
 *   - `stream`       — BEHAVIORAL distance over normalized action traces:
 *                      tool frequency / order / procedure, and a between/within
 *                      ratio R with a permutation test (reproducible).
 *   - `crystallize`  — does an evolved state, read back under neutral
 *                      conditions, equal its own endpoint? (disposition check)
 *
 * Hard rules (copied verbatim from the Proteus playbook):
 *   ① Read the BEHAVIOR trace — never the agent's self-report, never instrument
 *      the harness to make a number look better.
 *   ② Measure the DECLARED surface — the caller names which surfaces to read;
 *      nothing is hard-coded.
 *   ③ Use the NORMALIZED trace (ActionEvent), not provider logs.
 *   ④ Define the behavior for MISSING / PARTIAL snapshots and for too few
 *      seeds — degrade explicitly, never crash, never fabricate.
 *   ⑤ Every statistic ships with a regression test (see smoke.ts PR#2 block).
 *
 * Discipline: pure functions over plain data, no I/O, no LLM, no globals —
 * unit-testable in isolation, exactly like cost.ts / scorecard.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of a DECLARED harness surface. `entries` is the
 * canonical set of items on that surface (skill names, memory entry keys,
 * config keys, …). The caller decides what counts as an entry — this module
 * only compares sets, it never inspects their meaning.
 */
export interface Snapshot {
  /** Surface name (declared by the caller, e.g. "skills", "memory"). */
  surface: string;
  /** Canonical entry keys present in this snapshot. */
  entries: string[];
}

/** One normalized action event (a tool call, a turn, …). */
export interface ActionEvent {
  /** Event kind (e.g. "tool/call", "turn/start"). */
  type: string;
  /** For tool/call: the tool name. */
  name?: string;
  /** Optional timestamp (ordering falls back to array order). */
  ts?: number;
}

/** A normalized behavior trace for one arm / seed. */
export interface Trace {
  /** Arm or seed label (e.g. "review:notes", "seed-2"). */
  label: string;
  events: ActionEvent[];
}

// ---------------------------------------------------------------------------
// distance — structural
// ---------------------------------------------------------------------------

export interface SurfaceDistance {
  surface: string;
  /** In B, not in A. */
  added: string[];
  /** In A, not in B. */
  dropped: string[];
  /** In both, but the surface reports them as changed (caller-provided). */
  revised: string[];
  /** added + dropped + revised — the path length for this surface. */
  pathLength: number;
}

export interface DistanceReport {
  surfaces: SurfaceDistance[];
  /** Sum of pathLength across surfaces. */
  totalPathLength: number;
  /** True when a surface was missing from either snapshot (degraded). */
  degraded: boolean;
  /** Which surfaces were missing (and on which side). */
  missing: { surface: string; side: "a" | "b" }[];
}

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/**
 * Structural distance between two snapshots of the SAME surface.
 * `revised` is caller-supplied (the module cannot know what "changed" means
 * for an opaque entry key); when omitted it is empty.
 */
export function surfaceDistance(
  a: Snapshot,
  b: Snapshot,
  revised: string[] = [],
): SurfaceDistance {
  const aSet = new Set(a.entries);
  const bSet = new Set(b.entries);
  const added = sortedUnique(b.entries.filter((e) => !aSet.has(e)));
  const dropped = sortedUnique(a.entries.filter((e) => !bSet.has(e)));
  const rev = sortedUnique(revised.filter((e) => aSet.has(e) && bSet.has(e)));
  return {
    surface: a.surface,
    added,
    dropped,
    revised: rev,
    pathLength: added.length + dropped.length + rev.length,
  };
}

/**
 * Multi-surface distance. Surfaces are matched by name. A surface present in
 * only one snapshot is reported as MISSING (degraded) rather than treated as
 * "everything added/dropped" — that would fabricate a huge distance from a
 * data gap. Rule ④.
 */
export function distance(
  a: readonly Snapshot[],
  b: readonly Snapshot[],
  revisedBySurface?: Record<string, string[]>,
): DistanceReport {
  const aBy = new Map(a.map((s) => [s.surface, s]));
  const bBy = new Map(b.map((s) => [s.surface, s]));
  const surfaces = new Set([...aBy.keys(), ...bBy.keys()]);
  const out: SurfaceDistance[] = [];
  const missing: DistanceReport["missing"] = [];
  let degraded = false;
  for (const name of sortedUnique([...surfaces])) {
    const sa = aBy.get(name);
    const sb = bBy.get(name);
    if (!sa || !sb) {
      degraded = true;
      missing.push({ surface: name, side: sa ? "b" : "a" });
      continue;
    }
    out.push(surfaceDistance(sa, sb, revisedBySurface?.[name] ?? []));
  }
  return {
    surfaces: out,
    totalPathLength: out.reduce((s, x) => s + x.pathLength, 0),
    degraded,
    missing,
  };
}

// ---------------------------------------------------------------------------
// stream — behavioral
// ---------------------------------------------------------------------------

export interface ToolFlow {
  /** Tool name → call count. */
  frequency: Record<string, number>;
  /** Total tool calls. */
  totalCalls: number;
  /** Distinct tools used. */
  distinctTools: number;
  /** The ordered sequence of tool names (procedure). */
  procedure: string[];
  /**
 * Bigram (adjacent-pair) transition counts — captures ORDER, not just
 * frequency. `a→b` counts how often `b` immediately followed `a`.
   */
  transitions: Record<string, number>;
}

/**
 * Extract the tool-call flow from a normalized trace. Only `tool/call` events
 * with a `name` are counted (rule ③: the normalized trace, not self-report).
 */
export function toolFlow(events: readonly ActionEvent[]): ToolFlow {
  const frequency: Record<string, number> = {};
  const transitions: Record<string, number> = {};
  const procedure: string[] = [];
  for (const e of events) {
    if (e.type !== "tool/call" || !e.name) continue;
    frequency[e.name] = (frequency[e.name] ?? 0) + 1;
    const prev = procedure[procedure.length - 1];
    if (prev !== undefined) {
      const key = `${prev}→${e.name}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
    procedure.push(e.name);
  }
  return {
    frequency,
    totalCalls: procedure.length,
    distinctTools: Object.keys(frequency).length,
    procedure,
    transitions,
  };
}

/**
 * Behavioral distance between two traces: the L1 distance over tool-call
 * frequencies (how much the MIX changed) plus the Jaccard distance over
 * transition bigrams (how much the ORDER/procedure changed). Both are in
 * [0, 1]; the combined score is their mean.
 */
export function behaviorDistance(a: readonly ActionEvent[], b: readonly ActionEvent[]): {
  mix: number;
  order: number;
  score: number;
} {
  const fa = toolFlow(a);
  const fb = toolFlow(b);
  // L1 over frequency, normalized by total calls (0 when both empty).
  const tools = new Set([...Object.keys(fa.frequency), ...Object.keys(fb.frequency)]);
  let l1 = 0;
  for (const t of tools) l1 += Math.abs((fa.frequency[t] ?? 0) - (fb.frequency[t] ?? 0));
  const maxTotal = Math.max(fa.totalCalls, fb.totalCalls, 1);
  const mix = Math.min(1, l1 / maxTotal);
  // Jaccard distance over transition bigram SETS.
  const sa = new Set(Object.keys(fa.transitions));
  const sb = new Set(Object.keys(fb.transitions));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  const order = union === 0 ? 0 : 1 - inter / union;
  return { mix, order, score: (mix + order) / 2 };
}

// --- permutation test (between/within ratio R) -----------------------------

/** Deterministic PRNG (mulberry32) so the permutation test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle (in place) using the given RNG. */
function shuffle<T>(xs: T[], rng: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = xs[i];
    xs[i] = xs[j];
    xs[j] = tmp;
  }
  return xs;
}

/** Mean pairwise behavior distance WITHIN a group of traces. */
function withinMean(traces: readonly Trace[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < traces.length; i += 1) {
    for (let j = i + 1; j < traces.length; j += 1) {
      sum += behaviorDistance(traces[i].events, traces[j].events).score;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Mean pairwise behavior distance BETWEEN two groups of traces. */
function betweenMean(a: readonly Trace[], b: readonly Trace[]): number {
  let sum = 0;
  for (const x of a) for (const y of b) sum += behaviorDistance(x.events, y.events).score;
  return a.length * b.length === 0 ? 0 : sum / (a.length * b.length);
}

export interface PermutationTest {
  /** Observed between/within ratio R. */
  R: number;
  /** p-value: fraction of permutations with R' >= R (one-sided). */
  p: number;
  /** Number of permutations run. */
  permutations: number;
  /** True when there were too few traces to make a test (degraded). */
  degraded: boolean;
  reason?: string;
}

/**
 * Permutation test for the between/within ratio R (rule ⑤: ships with a
 * regression test). Given traces grouped by arm label, compute the observed
 * R = between / within, then shuffle arm labels `permutations` times (seeded,
 * so reproducible) and report the fraction of shuffles with R' >= R.
 *
 * Degraded (rule ④): needs >= 2 arms and >= 2 traces total; otherwise returns
 * `degraded: true` with a reason instead of a number.
 */
export function permutationTest(
  traces: readonly Trace[],
  opts: { permutations?: number; seed?: number } = {},
): PermutationTest {
  const perms = Math.max(0, Math.floor(opts.permutations ?? 500));
  const seed = opts.seed ?? 12345;
  const arms = new Map<string, Trace[]>();
  for (const t of traces) {
    const g = arms.get(t.label) ?? [];
    g.push(t);
    arms.set(t.label, g);
  }
  const armNames = [...arms.keys()];
  const total = traces.length;
  if (armNames.length < 2 || total < 2) {
    return {
      R: 0,
      p: 1,
      permutations: 0,
      degraded: true,
      reason: `need >= 2 arms and >= 2 traces (got ${armNames.length} arms, ${total} traces)`,
    };
  }

  const observed = () => {
    // Partition into the first arm vs. the rest (generalizes to 2 arms; for
    // >2 arms this is the first-vs-rest contrast, which is what R measures).
    const a = arms.get(armNames[0])!;
    const b = traces.filter((t) => t.label !== armNames[0]);
    const within = withinMean(a) + withinMean(b);
    const between = betweenMean(a, b);
    return { R: within === 0 ? (between > 0 ? Infinity : 0) : between / within, between, within };
  };

  const obs = observed();
  if (!isFinite(obs.R)) {
    return { R: Infinity, p: 0, permutations: perms, degraded: false };
  }

  let ge = 0;
  const labels = traces.map((t) => t.label);
  const rng = mulberry32(seed);
  for (let k = 0; k < perms; k += 1) {
    const shuffled = shuffle([...labels], rng);
    // Rebuild groups from the shuffled labels.
    const g = new Map<string, Trace[]>();
    shuffled.forEach((lab, i) => {
      const t = traces[i];
      const arr = g.get(lab) ?? [];
      arr.push(t);
      g.set(lab, arr);
    });
    const names = [...g.keys()];
    if (names.length < 2) continue;
    const a = g.get(names[0])!;
    const b = traces.filter((t) => t.label !== names[0]);
    const within = withinMean(a) + withinMean(b);
    const between = betweenMean(a, b);
    const R = within === 0 ? (between > 0 ? Infinity : 0) : between / within;
    if (R >= obs.R) ge += 1;
  }
  const p = perms === 0 ? 1 : (ge + 1) / (perms + 1); // add-1 smoothing
  return { R: obs.R, p, permutations: perms, degraded: false };
}

// ---------------------------------------------------------------------------
// crystallize — disposition check
// ---------------------------------------------------------------------------

export interface CrystallizeResult {
  /** Read-back distance between the evolved endpoint and the neutral read-back. */
  distance: number;
  /** True when the read-back equals the endpoint (disposition is stable). */
  stable: boolean;
  /** True when a required snapshot was missing (degraded). */
  degraded: boolean;
  reason?: string;
}

/**
 * Crystallize: does an evolved state, read back under NEUTRAL conditions,
 * equal its own endpoint? Compare the evolved snapshot set against the
 * neutral read-back set; a small distance means the disposition is stable
 * (the initial condition left a permanent mark). Missing either side →
 * degraded, never a fabricated 0.
 */
export function crystallize(
  evolved: readonly Snapshot[],
  neutral: readonly Snapshot[],
  revisedBySurface?: Record<string, string[]>,
): CrystallizeResult {
  if (evolved.length === 0 || neutral.length === 0) {
    return {
      distance: 0,
      stable: false,
      degraded: true,
      reason: "missing evolved or neutral snapshot",
    };
  }
  const d = distance(evolved, neutral, revisedBySurface);
  return {
    distance: d.totalPathLength,
    stable: d.totalPathLength === 0,
    degraded: d.degraded,
  };
}

// ---------------------------------------------------------------------------
// formatting (human-readable report)
// ---------------------------------------------------------------------------

export function formatDistance(r: DistanceReport): string {
  const lines: string[] = [];
  lines.push(`distance  total path length = ${r.totalPathLength}${r.degraded ? `  (DEGRADED: missing ${r.missing.map((m) => `${m.surface}[${m.side}]`).join(", ")})` : ""}`);
  for (const s of r.surfaces) {
    const parts: string[] = [];
    if (s.added.length) parts.push(`+${s.added.join(",")}`);
    if (s.dropped.length) parts.push(`-${s.dropped.join(",")}`);
    if (s.revised.length) parts.push(`~${s.revised.join(",")}`);
    lines.push(`  ${s.surface}: ${parts.length ? parts.join("  ") : "(no change)"}  [len ${s.pathLength}]`);
  }
  return lines.join("\n");
}

export function formatPermutationTest(t: PermutationTest): string {
  if (t.degraded) return `permutation  DEGRADED: ${t.reason}`;
  return `permutation  R = ${t.R.toFixed(3)}  p = ${t.p.toFixed(3)}  (n=${t.permutations})`;
}

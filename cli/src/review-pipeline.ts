/**
 * AC#1 — Deep code-review pipeline (borrowed from atomcode-review fanout).
 *
 * Four read-only review dimensions run in PARALLEL over the same diff, each
 * through its own lens; findings are merged deterministically (file + line
 * overlap + title similarity, high-priority wins) and then EVERY candidate
 * finding is re-verified by an independent verify agent (KEEP/DROP, the diff
 * is authoritative) before landing in the report.
 *
 * Everything in this module is a PURE function (testable without TTY or LLM)
 * except `renderVerifyTask`/`renderReviewTask` which are pure string builders.
 * The sub-agent orchestration (fanout + verify) happens in the skill layer,
 * which calls these primitives.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One review lens. Appended to the shared reviewer persona to bias focus. */
export interface ReviewDimension {
  id: string;
  display: string;
  lens: string;
}

/** The four concern dimensions a deep review fans out across (display order). */
export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  {
    id: "correctness",
    display: "Correctness",
    lens: "\n\n## This review's lens: CORRECTNESS\nConcentrate on logic errors, wrong conditions, off-by-one, unhandled edge cases, error handling, concurrency/races, and regressions introduced by this diff. Still report anything clearly severe you notice outside this lens.",
  },
  {
    id: "security",
    display: "Security",
    lens: "\n\n## This review's lens: SECURITY\nConcentrate on injection, missing authz/authn, secret handling, unsafe deserialization, path/SSRF issues, and supply-chain surface (dependency, CI, and config changes). Still report anything clearly severe you notice outside this lens.",
  },
  {
    id: "performance",
    display: "Performance",
    lens: "\n\n## This review's lens: PERFORMANCE\nConcentrate on hot-path cost, needless allocations/clones, blocking calls on async paths, N+1 / repeated I/O, and accidental quadratic behavior introduced by this diff. Still report anything clearly severe you notice outside this lens.",
  },
  {
    id: "tests_contracts",
    display: "Tests & contracts",
    lens: "\n\n## This review's lens: TESTS & CONTRACTS\nConcentrate on whether the change is covered by tests, whether public APIs/contracts stay consistent, and whether the diff changes a convention on its lines while leaving sibling/parallel code on the old form (a one-sided divergence). Still report anything clearly severe you notice outside this lens.",
  },
];

/** Priority of a finding. */
export type FindingPriority = "high" | "medium" | "low";

/** A structured finding from one reviewer dimension (before merge). */
export interface Finding {
  /** One of REVIEW_DIMENSIONS ids, or "standards" / "spec" / "general". */
  dimension: string;
  priority: FindingPriority;
  /** 0..1 — how sure the reviewer is this is real. */
  confidence: number;
  file_path: string;
  line_start: number;
  line_end: number;
  title: string;
  body: string;
}

/** A finding that survived merge, tagged with every dimension that reported it. */
export interface MergedFinding {
  finding: Finding;
  dimensions: string[];
}

/** KEEP/DROP verdict of the independent verify pass. */
export interface VerifyVerdict {
  finding: MergedFinding;
  keep: boolean;
  reason: string;
}

/** Per-dimension review output (parsed from a reviewer's structured answer). */
export interface DimensionReview {
  dimension: string;
  findings: Finding[];
  /** free-text observations that were not structured findings */
  notes: string;
}

/** The full report model (JSONL-serializable). */
export interface ReviewReport {
  /** diff command used (informational). */
  diffCommand: string;
  /** ISO timestamp. */
  createdAt: string;
  /** the four lens results, pre-merge (audit trail). */
  dimensions: DimensionReview[];
  /** merged + verified findings (the actual report). */
  findings: MergedFinding[];
  /** dropped candidates (audit trail, with the verify reason). */
  dropped: VerifyVerdict[];
}

/* ------------------------------------------------------------------ */
/* 1. Impact plan — deterministic review targets from the diff          */
/* ------------------------------------------------------------------ */

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/** Lines changed to NEW side line numbers, from a unified diff hunk header. */
function hunkNewLines(hunkHeader: string, body: string): number[] {
  const m = HUNK_HEADER.exec(hunkHeader);
  if (!m) return [];
  let newStart = Number(m[2]);
  const lines: number[] = [];
  for (const raw of body.split("\n")) {
    const line = raw;
    if (line.startsWith("+")) {
      lines.push(newStart);
      newStart += 1;
    } else if (line.startsWith("-")) {
      // deletion: new side does not advance
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      newStart += 1;
    }
  }
  return lines;
}

/** Parse a unified diff into per-file { path, hunks:[{newLineNumbers}] }. */
export function parseDiff(diff: string): { path: string; newLines: number[] }[] {
  const files: { path: string; newLines: number[] }[] = [];
  let cur: { path: string; newLines: number[] } | null = null;
  let inHunk = false;
  let hunkHeader = "";
  const hunkBody: string[] = [];

  const flushHunk = () => {
    if (cur && hunkHeader) {
      cur.newLines.push(...hunkNewLines(hunkHeader, hunkBody.join("\n")));
    }
    hunkHeader = "";
    hunkBody.length = 0;
    inHunk = false;
  };

  for (const raw of diff.split("\n")) {
    const line = raw;
    if (line.startsWith("diff --git ")) {
      flushHunk();
      const m = /diff --git a\/(.+) b\/(.+)/.exec(line);
      const path = m ? m[2] : "";
      cur = { path, newLines: [] };
      files.push(cur);
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      hunkHeader = line;
      inHunk = true;
      continue;
    }
    if (inHunk) {
      hunkBody.push(line);
    }
  }
  flushHunk();
  return files.filter((f) => f.path);
}

/** Is a candidate line number inside (or adjacent to) a changed hunk? */
export function isChangedLine(file: { newLines: number[] }, line: number): boolean {
  if (!file.newLines.length) return false;
  // Exact hit, or within 1 line of a change (context lines around the change).
  return file.newLines.some((n) => Math.abs(n - line) <= 1);
}

/** Deterministic impact targets: changed files + high-risk symbol names from `+` lines. */
export function extractImpactTargets(diff: string): {
  changedFiles: string[];
  symbols: string[];
} {
  const changedFiles: string[] = [];
  const symbols = new Set<string>();
  // Symbol-ish tokens on added lines: function/class definitions, exported names.
  const symbolRe =
    /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /diff --git a\/(.+) b\/(.+)/.exec(raw);
      if (m && m[2] !== "/dev/null") changedFiles.push(m[2]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      for (const sm of raw.matchAll(symbolRe)) symbols.add(sm[1]);
    }
  }
  return { changedFiles, symbols: [...symbols].slice(0, 24) };
}

/** Render the deterministic impact plan injected before the fanout. */
export function renderImpactPlan(diff: string): string {
  const { changedFiles, symbols } = extractImpactTargets(diff);
  const out: string[] = [
    "## Review impact plan (deterministic, code-graph guided)",
    "",
    "Use this plan to keep exploration bounded. The DIFF remains authoritative.",
    "",
    "- Changed files:",
    ...(changedFiles.length ? changedFiles.map((f) => `  - ${f}`) : ["  (none parsed)"]),
  ];
  if (symbols.length) {
    out.push(
      "",
      "- High-risk symbols introduced/changed by this diff (check their callers/callees):",
      ...symbols.map((s) => `  - ${s}`),
    );
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* 2. Finding merge — deterministic dedup                              */
/* ------------------------------------------------------------------ */

/** Rough title similarity: shared significant tokens / total. */
export function titleSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9_$]+/)
        .filter((t) => t.length > 2),
    );
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

/** Do two findings point at (roughly) the same location? */
export function sameLocation(a: Finding, b: Finding): boolean {
  if (a.file_path !== b.file_path) return false;
  const aStart = a.line_start;
  const aEnd = Math.max(a.line_start, a.line_end);
  const bStart = b.line_start;
  const bEnd = Math.max(b.line_start, b.line_end);
  // Overlapping or adjacent ranges.
  return aStart <= bEnd + 1 && bStart <= aEnd + 1;
}

const PRIORITY_RANK: Record<FindingPriority, number> = { high: 3, medium: 2, low: 1 };

/**
 * Collapse per-dimension findings into a deduped set. Two findings are the
 * same issue when they touch the same file, their line ranges overlap, and
 * their titles are similar (≥ 0.5). On a collision the higher-priority (then
 * higher-confidence) finding's content wins and every contributing dimension
 * is credited. Returns findings in stable order: by priority desc, then file.
 */
export function mergeFindings(perDim: DimensionReview[]): MergedFinding[] {
  const sorted: Finding[] = [];
  const dimOf = new Map<Finding, string>();
  for (const d of perDim) {
    for (const f of d.findings) {
      sorted.push(f);
      dimOf.set(f, d.dimension);
    }
  }
  // Highest priority first so the winner is decided in one pass.
  sorted.sort((a, b) => {
    const pr = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (pr !== 0) return pr;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.file_path.localeCompare(b.file_path) || a.line_start - b.line_start;
  });

  const merged: MergedFinding[] = [];
  for (const f of sorted) {
    const dim = dimOf.get(f) ?? "general";
    let hit: MergedFinding | null = null;
    for (const m of merged) {
      if (
        sameLocation(m.finding, f) &&
        titleSimilarity(m.finding.title, f.title) >= 0.5
      ) {
        hit = m;
        break;
      }
    }
    if (hit) {
      if (!hit.dimensions.includes(dim)) hit.dimensions.push(dim);
    } else {
      merged.push({ finding: f, dimensions: [dim] });
    }
  }
  // Stable final order: priority desc, then file, then line.
  merged.sort(
    (a, b) =>
      PRIORITY_RANK[b.finding.priority] - PRIORITY_RANK[a.finding.priority] ||
      a.finding.file_path.localeCompare(b.finding.file_path) ||
      a.finding.line_start - b.finding.line_start,
  );
  return merged;
}

/* ------------------------------------------------------------------ */
/* 3. Verify — independent KEEP/DROP re-check of each candidate         */
/* ------------------------------------------------------------------ */

/** True when an independent verify pass re-confirms a candidate finding. */
export function verifyReconfirms(candidate: Finding, reported: Finding[]): boolean {
  // An independent reviewer confirms our candidate by reporting an overlapping
  // finding that mentions any of the candidate's significant title tokens.
  const toks = new Set(
    candidate.title
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter((t) => t.length > 2),
  );
  if (!toks.size) return reported.some((r) => sameLocation(candidate, r));
  return reported.some(
    (r) =>
      sameLocation(candidate, r) &&
      [...toks].some((t) => r.title.toLowerCase().includes(t)),
  );
}

/** The verify task text handed to an independent verify agent. */
export function renderVerifyTask(c: MergedFinding, annotatedDiff: string): string {
  const f = c.finding;
  return [
    "## This review's task: VERIFY ONE CANDIDATE FINDING",
    "",
    "You are checking a single candidate finding from a prior review pass. Using the DIFF as the authoritative source (plus read-only tools for context), decide whether it is a REAL defect INTRODUCED by these changes.",
    "",
    `- To KEEP it (it is real, OR you are unsure): re-report THE SAME issue at the SAME file and an overlapping line range (you may refine the wording). Keeping is the default whenever you are not certain.`,
    `- To DROP it: report NOTHING, and briefly state why it is a false positive, not introduced by this diff, or already handled.`,
    "",
    "Report only about THIS candidate — do not hunt for new, unrelated issues.",
    "",
    `CANDIDATE FINDING:`,
    `- [${f.priority} · conf ${f.confidence.toFixed(2)}] ${f.file_path}:${f.line_start}-${f.line_end}`,
    `  ${f.title}`,
    f.body ? `  ${f.body}` : "",
    "",
    `=== DIFF ===`,
    annotatedDiff,
  ].join("\n");
}

/** The per-dimension review task text (fanout). */
export function renderReviewTask(
  dim: ReviewDimension,
  impactPlan: string,
  annotatedDiff: string,
): string {
  return [
    `## This review's task: review the diff below through the "${dim.display}" lens.`,
    "",
    "Report structured findings using `report_finding` — one call per distinct issue, each with:",
    "  - `dimension`: the lens id",
    "  - `priority`: high | medium | low",
    "  - `confidence`: 0..1",
    "  - `file_path` + `line_start` + `line_end` (NEW-file line numbers)",
    "  - `title`: a short imperative title",
    "  - `body`: what/where/why, with the hunk quoted",
    "",
    "Only report issues INTRODUCED by this diff (regressions, bugs, contract breaks, smells on the changed lines). Do not report pre-existing issues in untouched code. If you find nothing, report nothing.",
    dim.lens,
    "",
    impactPlan,
    "",
    `=== DIFF (${annotatedDiff.length} chars) ===`,
    annotatedDiff,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 4. Report — human-readable + JSONL audit trail                      */
/* ------------------------------------------------------------------ */

/** Render the final merged + verified findings as a human-readable report. */
export function renderFindingsReport(report: ReviewReport): string {
  const out: string[] = ["# Code Review — verified findings", ""];
  if (!report.findings.length) {
    out.push("No verified findings. The reviewed change looks clean.");
  }
  const byPriority: FindingPriority[] = ["high", "medium", "low"];
  for (const p of byPriority) {
    const group = report.findings.filter((m) => m.finding.priority === p);
    if (!group.length) continue;
    out.push(`## ${p.toUpperCase()}`, "");
    for (const m of group) {
      const f = m.finding;
      out.push(
        `- [${f.dimension}${m.dimensions.length > 1 ? " +" + m.dimensions.filter((d) => d !== f.dimension).join("+") : ""}] ${f.file_path}:${f.line_start}-${f.line_end} — ${f.title} (conf ${f.confidence.toFixed(2)})`,
      );
      if (f.body) out.push(`  ${f.body}`);
    }
    out.push("");
  }
  if (report.dropped.length) {
    out.push(
      `## Dropped (${report.dropped.length} candidates failed independent verify)`,
      "",
      ...report.dropped.map(
        (v) =>
          `- [${v.finding.finding.priority}] ${v.finding.finding.file_path}:${v.finding.finding.line_start}-${v.finding.finding.line_end} — ${v.finding.finding.title}\n    ${v.reason}`,
      ),
      "",
    );
  }
  out.push(
    `_Diff: \`${report.diffCommand}\` · ${report.dimensions.length} dimensions · ` +
      `${report.findings.length} verified findings · generated ${report.createdAt}_`,
  );
  return out.join("\n");
}

/** Persist the full report (dimensions + merged + dropped) as JSONL. */
export function writeReviewReport(report: ReviewReport, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `review-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({ kind: "review", diffCommand: report.diffCommand, createdAt: report.createdAt }),
    ...report.dimensions.map((d) =>
      JSON.stringify({ kind: "dimension", dimension: d.dimension, notes: d.notes, findings: d.findings }),
    ),
    ...report.findings.map((m) =>
      JSON.stringify({ kind: "finding", finding: m.finding, dimensions: m.dimensions }),
    ),
    ...report.dropped.map((v) =>
      JSON.stringify({ kind: "dropped", finding: v.finding.finding, reason: v.reason }),
    ),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Parse a reviewer's structured output into per-dimension findings. */
export function parseReviewerOutput(raw: string, dimensionId: string): DimensionReview {
  const findings: Finding[] = [];
  const jsonBlocks = raw.match(/```json\s*([\s\S]*?)```/g) ?? [];
  for (const block of jsonBlocks) {
    const payload = block.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(payload);
      const list = Array.isArray(parsed) ? parsed : parsed.findings;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const f: Finding = {
            dimension: dimensionId,
            priority: normalizePriority(item.priority),
            confidence: clampConfidence(item.confidence),
            file_path: String(item.file_path ?? ""),
            line_start: Number(item.line_start ?? 0) || 0,
            line_end: Number(item.line_end ?? 0) || 0,
            title: String(item.title ?? "").trim(),
            body: String(item.body ?? "").trim(),
          };
          if (f.file_path && f.title) findings.push(f);
        }
      }
    } catch {
      // skip malformed block
    }
  }
  return { dimension: dimensionId, findings, notes: raw };
}

function normalizePriority(p: unknown): FindingPriority {
  if (p === "high" || p === "medium" || p === "low") return p;
  const s = String(p ?? "").toLowerCase();
  if (s.includes("high") || s.includes("critical") || s.includes("blocker")) return "high";
  if (s.includes("low") || s.includes("minor") || s.includes("nit")) return "low";
  return "medium";
}

function clampConfidence(c: unknown): number {
  const n = Number(c);
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/* ------------------------------------------------------------------ */
/* Helpers (diff annotation, path normalization)                        */
/* ------------------------------------------------------------------ */

/** Prefix every diff line with its NEW-side line number, for verify agents. */
export function annotateDiffLineNumbers(diff: string): string {
  const out: string[] = [];
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const line = raw;
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER.exec(line);
      if (m) newLine = Number(m[2]);
      out.push(line);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push(`${newLine} | ${line}`);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      out.push(`- | ${line}`);
    } else if (line.startsWith("\\")) {
      out.push(line);
    } else {
      out.push(`${newLine} | ${line}`);
      newLine += 1;
    }
  }
  return out.join("\n");
}
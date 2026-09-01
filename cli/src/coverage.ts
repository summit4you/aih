/**
 * OC#6 — maturity scorecard: coverage-ID + evidence-mode classification.
 *
 * OpenClaw taxonomy.yaml borrow: turn ad-hoc smoke groups into a STABLE
 * coverage registry — each group carries a stable coverage ID, an evidence
 * mode (mock = no external deps, pure-local; live = needs a real
 * provider/channel/network), and a profile (smoke-ci / personal-agent /
 * release) that selects a subset of groups to run.
 *
 * The registry is DERIVED from cli/src/smoke.ts's group headers (the `// ---`
 * / `// TP#x` title lines), so it can never drift from the tests themselves:
 * a group header IS the stable anchor. Evidence mode is inferred from the
 * group's own text — a group that mentions an API key / live bench / network
 * is `live`, everything else defaults to `mock`.
 *
 * Pure functions only (no I/O except reading the smoke source at
 * loadCoverageRegistry time), so the selection/matrix logic is unit-testable
 * exactly like cost.ts / scorecard.ts.
 */
import { readFileSync } from "node:fs";

export type EvidenceMode = "mock" | "live";
export type Profile = "smoke-ci" | "personal-agent" | "release";

export interface CoverageItem {
  /** stable, human-readable coverage ID derived from the group title. */
  id: string;
  /** the group header line (kept so a reader can jump to source). */
  group: string;
  title: string;
  evidence: EvidenceMode;
  /** which profiles run this group. First profile that matches wins. */
  profiles: Profile[];
}

/**
 * Stable slug for a group header line, e.g.
 *   "OC#5 residual: doctor --fix config self-healing (migration)"
 *   → "oc5-residual-doctor-fix-config-self-healing-migration"
 */
export function coverageIdFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const LIVE_HINTS =
  /\b(real api ?key|needs api ?key|requires? (a )?(real )?api ?key|live (provider|channel|bench|network|model)|real provider|real network)\b/i;

/** Infer evidence mode from a group's own text (header + a bounded lookahead). */
export function inferEvidenceMode(groupText: string): EvidenceMode {
  return LIVE_HINTS.test(groupText) ? "live" : "mock";
}

/** Parse the smoke source into a list of group headers (naive but stable). */
function parseGroupHeaders(source: string): Array<{ header: string; text: string }> {
  const lines = source.split("\n");
  const groups: Array<{ header: string; text: string }> = [];
  let current: { header: string; text: string } | null = null;
  for (const line of lines) {
    // A group boundary is either a dashed banner `// --- Title ---…`, a
    // `// ═══ Title ═══` divider, or a top-level section heading line of the
    // form `// TP#N — Title` (used by the TP#2/3/4/6/7 meta-sections, which are
    // delimited by bare `═══` dividers). Everything else — standalone
    // `// P#41: …` / `// CC#52 — …` per-case comments — is part of the current
    // group's body, so we only collect the real sections.
    const banner = line.match(/^\s*\/\/\s*-{3,}\s*(.+?)\s*-{3,}\s*$/);
    const divider = line.match(/^\s*\/\/\s*═+\s*(.+?)\s*═+\s*$/);
    const tpHeading = line.match(/^\s*\/\/\s*(TP#\d+)\s*[—-]\s*(.+)$/);
    if (banner || divider || tpHeading) {
      if (current) groups.push(current);
      let title: string;
      if (banner) title = banner[1];
      else if (divider) title = divider[1];
      else title = `${tpHeading![1]} — ${tpHeading![2]}`;
      title = title.trim();
      // `text` accumulates the group body (started with the title) so
      // inferEvidenceMode can see "requires a real API key" etc.
      current = { header: line.trim(), text: title };
    } else if (current) {
      current.text += "\n" + line;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/**
 * Build the coverage registry from a smoke-source path. `smokePath` is the
 * on-disk cli/src/smoke.ts (or its built dist/smoke.js equivalent at runtime);
 * the group titles are the stable coverage anchors.
 */
export function loadCoverageRegistry(smokePath: string): CoverageItem[] {
  let source = "";
  try {
    source = readFileSync(smokePath, "utf8");
  } catch {
    return [];
  }
  const items: CoverageItem[] = [];
  for (const g of parseGroupHeaders(source)) {
    let title = g.header.replace(/^\/\/\s*/, "").replace(/^-{3,}\s*/, "").trim();
    // skip bare `═══` separators / empty titles
    if (!title || /^═+$/.test(title)) continue;
    // Skip the coverage self-test group itself — its body legitimately contains
    // the literal phrases "requires real API key" / "live provider bench" that
    // the evidence heuristic keys on, so it must not pollute the registry.
    if (coverageIdFromTitle(title).startsWith("oc-6-maturity-scorecard")) continue;
    const evidence = inferEvidenceMode(g.text);
    const id = coverageIdFromTitle(title);
    // A release profile runs everything (incl. live); smoke-ci runs only mock;
    // personal-agent runs mock + a curated live subset (here: none yet).
    const profiles: Profile[] = evidence === "live" ? ["release"] : ["smoke-ci", "personal-agent", "release"];
    items.push({ id, group: g.header, title, evidence, profiles });
  }
  return dedupeById(items);
}

function dedupeById(items: CoverageItem[]): CoverageItem[] {
  const seen = new Map<string, CoverageItem>();
  for (const it of items) {
    if (!seen.has(it.id)) seen.set(it.id, it);
  }
  return [...seen.values()];
}

/** Which coverage items a given profile selects (pure). */
export function selectForProfile(items: CoverageItem[], profile: Profile): CoverageItem[] {
  return items.filter((it) => it.profiles.includes(profile));
}

/** Aggregate counts for a profile (pure). */
export function profileStats(
  items: CoverageItem[],
  profile: Profile,
): { total: number; mock: number; live: number } {
  const sel = selectForProfile(items, profile);
  return {
    total: sel.length,
    mock: sel.filter((i) => i.evidence === "mock").length,
    live: sel.filter((i) => i.evidence === "live").length,
  };
}

/** Render a coverage matrix (text) for a profile. */
export function formatCoverage(items: CoverageItem[], profile: Profile): string {
  const sel = selectForProfile(items, profile);
  const stats = profileStats(items, profile);
  const rows = sel.map((it) => {
    const title = it.title.replace(/\s*-{3,}\s*$/g, "").trim();
    return `  ${it.evidence === "live" ? "LIVE" : "mock".padEnd(4)}  ${it.id.padEnd(56)} ${title}`;
  });
  return [
    `AIH coverage (profile: ${profile})`,
    `-----------------------------------`,
    ...rows,
    ``,
    `  ${stats.total} groups selected · ${stats.mock} mock · ${stats.live} live`,
  ].join("\n");
}

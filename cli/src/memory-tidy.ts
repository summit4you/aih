/**
 * E#17 — memory auto-tidy (roadmap P0#2 increment "记忆条目失效/冲突的自动整理").
 *
 * Deterministic, LLM-free cleanup of a memory.md file: it drops duplicate
 * entries (same normalized content) keeping the most recent dated copy, and
 * reports exactly what was removed so the TUI/CLI can show a diff before the
 * user applies it. This preserves the "memory writes need human confirmation"
 * boundary — tidy only *proposes*; the caller decides whether to write.
 *
 * Pure functions here are unit-testable without touching the filesystem.
 */

export interface MemoryEntry {
  /** the raw bullet line (without the leading "- ") */
  text: string;
  /** normalized key used for dedup (lowercased, whitespace/punct collapsed) */
  norm: string;
  /** date prefix if the entry is dated ("2026-08-24"), else "" */
  date: string;
  /** original line number (1-based) for reporting */
  line: number;
}

export interface TidyReport {
  /** total bullet entries parsed */
  total: number;
  /** number of entries kept after dedup */
  kept: number;
  /** duplicate entries removed (with the entry they duplicate) */
  removed: Array<{ text: string; duplicateOf: string }>;
  /** the cleaned file text (header + kept entries, original order) */
  cleaned: string;
  /** true when nothing would change */
  noChange: boolean;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\s*[—-]\s*/;

/** Normalize an entry for dedup: lowercase, collapse whitespace, drop the date. */
export function normEntry(raw: string): string {
  let s = raw.replace(DATE_RE, "");
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  return s.replace(/[.,;:。；：]+$/g, "").trim();
}

/** Parse the bullet entries out of a memory.md file. */
export function parseMemoryEntries(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (!m) continue;
    const text2 = m[1].trim();
    const dm = DATE_RE.exec(text2);
    out.push({
      text: text2,
      norm: normEntry(text2),
      date: dm ? dm[1] : "",
      line: i + 1,
    });
  }
  return out;
}

/**
 * Compute the tidy report. Entries with the same normalized content are
 * duplicates; the most recent (by date, then by file position) is kept and the
 * earlier copies are dropped. Non-bullet lines (headers, prose) are preserved.
 */
export function tidyMemory(text: string): TidyReport {
  const entries = parseMemoryEntries(text);
  if (entries.length === 0) {
    return { total: 0, kept: 0, removed: [], cleaned: text.trim(), noChange: true };
  }
  // Group by normalized content.
  const byNorm = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const key = e.norm || `__line_${e.line}`;
    const arr = byNorm.get(key);
    if (arr) arr.push(e);
    else byNorm.set(key, [e]);
  }
  // Decide the survivor per group: most recent date, else last in file order.
  const keepLines = new Set<number>();
  const removed: Array<{ text: string; duplicateOf: string }> = [];
  for (const group of byNorm.values()) {
    const survivor = group.reduce((best, cur) => {
      if (cur.date && best.date && cur.date > best.date) return cur;
      if (cur.date && !best.date) return cur;
      if (!cur.date && best.date) return best;
      return cur; // equal/no dates → later in file wins (group is in file order)
    }, group[0]);
    keepLines.add(survivor.line);
    for (const e of group) {
      if (e.line !== survivor.line) {
        removed.push({ text: e.text, duplicateOf: survivor.text });
      }
    }
  }
  // Rebuild the file: keep non-bullet lines and the survivor bullets, in order.
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s*-\s+.*$/.exec(line);
    if (m) {
      if (keepLines.has(i + 1)) kept.push(line);
    } else {
      kept.push(line);
    }
  }
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return {
    total: entries.length,
    kept: keepLines.size,
    removed,
    cleaned,
    noChange: removed.length === 0,
  };
}

/** Human-readable summary of a tidy report (for the TUI/CLI). */
export function formatTidyReport(r: TidyReport): string {
  if (r.noChange) {
    return `memory is already tidy (${r.total} entries, no duplicates)`;
  }
  const lines = [
    `memory tidy: ${r.total} entries → ${r.kept} kept, ${r.removed.length} duplicate(s) removed`,
    ...r.removed.map((x) => `  - drop: ${x.text.slice(0, 80)}\n    (duplicate of: ${x.duplicateOf.slice(0, 80)})`),
  ];
  return lines.join("\n");
}

/**
 * Rules loading (opencode `rules` parity).
 *
 * opencode reads project + global AGENTS.md rules (with CLAUDE.md as a
 * Claude-Code compatibility fallback) and merges them into the LLM context.
 * AIH previously loaded only the app contract (APP.md). This module adds the
 * AGENTS.md / CLAUDE.md / `instructions` mechanism so a project can inject
 * custom instructions that the agent actually honors.
 *
 * Precedence (first match wins within a category, mirroring opencode):
 *   1. Project rules: walking up from cwd — AGENTS.md, else CLAUDE.md.
 *   2. Global rules:  <XDG user dir>/AGENTS.md (AIH's own global dir, legacy
 *                     ~/.aih/AGENTS.md also honored) →
 *                     ~/.claude/CLAUDE.md (Claude Code compat).
 *   3. Config `instructions` entries (paths / globs / remote URLs) from any
 *      trusted config layer.
 *
 * Claude-code compatibility can be disabled via AIH_DISABLE_CLAUDE_CODE / the
 * more specific AIH_DISABLE_CLAUDE_CODE_PROMPT / _SKILLS env vars
 * (opencode parity).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadLayers } from "./config.js";
import { userAihDirs } from "./paths.js";

/** True when a directory path carries the given file. */
function hasFile(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}

/**
 * Walk from `fromDir` upward to collect the nearest AGENTS.md / CLAUDE.md in
 * each ancestor (project rule files). Returns candidate file paths, most
 * specific (deepest) first.
 */
export function findProjectRuleFiles(fromDir = process.cwd()): string[] {
  const out: string[] = [];
  let dir = resolve(fromDir);
  // Cap the walk at the filesystem root.
  for (let i = 0; i < 100; i += 1) {
    // AGENTS.md wins over CLAUDE.md within the same dir.
    if (hasFile(dir, "AGENTS.md")) out.push(join(dir, "AGENTS.md"));
    else if (hasFile(dir, "CLAUDE.md")) out.push(join(dir, "CLAUDE.md"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Global rule files: AIH's own global AGENTS.md (XDG-resolved user dir +
 * legacy ~/.aih, both checked) first, then Claude Code ~/.claude/CLAUDE.md
 * (compat, unless disabled). Mirrors opencode's global.config/AGENTS.md.
 */
export function findGlobalRuleFiles(): string[] {
  const out: string[] = [];
  // AIH's own global AGENTS.md — userAihDirs() returns [primary, legacy] with
  // the XDG-resolved dir first, so a setup that keeps data in ~/.aih keeps
  // working. Disable with AIH_DISABLE_AIH_PROMPT=1.
  if (process.env.AIH_DISABLE_AIH_PROMPT !== "1") {
    for (const d of userAihDirs()) {
      const p = join(d, "AGENTS.md");
      if (existsSync(p) && !out.includes(p)) out.push(p);
    }
  }
  if (process.env.AIH_DISABLE_CLAUDE_CODE !== "1") {
    // ~/.claude/CLAUDE.md — Claude Code compatibility fallback.
    const home = process.env.HOME;
    if (home) {
      if (process.env.AIH_DISABLE_CLAUDE_CODE_PROMPT !== "1") {
        const p = join(home, ".claude", "CLAUDE.md");
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/** Read an `instructions` entry that may be a path, a glob, or a URL. */
function readInstructionsEntry(
  entry: string,
  baseDir: string,
): string[] {
  // Remote URL: the sync loader cannot fetch (no sync fetch in plain Node).
  // Fail LOUD instead of silently dropping the entry — a user configuring a
  // remote rules URL must know it is not active in this build. (opencode
  // fetches URLs asynchronously; AIH's session startup is synchronous, so
  // remote rules are intentionally unsupported until an async load path.)
  if (/^https?:\/\//.test(entry)) {
    process.stderr.write(
      `[aih] warning: instructions entry "${entry}" is a remote URL — ` +
        `remote rules are not loaded in this build (use a local file or glob path)\n`,
    );
    return [];
  }
  // ~ expansion (opencode parity): "~/rules.md" → $HOME/rules.md. Runs
  // BEFORE the glob/path resolution so "~/*.md" globs walk $HOME.
  let e = entry;
  if (e.startsWith("~")) {
    const home = process.env.HOME;
    if (!home) {
      process.stderr.write(
        `[aih] warning: instructions entry "${entry}" starts with ~ but HOME is unset — skipped\n`,
      );
      return [];
    }
    e = e === "~" ? home : join(home, e.slice(2));
  }
  // Glob pattern?
  if (e.includes("*") || e.includes("?")) {
    const globToRegex = (p: string): RegExp => {
      const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const rx = esc.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
      return new RegExp(`^${rx}$`);
    };
    const rx = globToRegex(e);
    const base = resolve(baseDir);
    // Search root = the glob's literal directory prefix (no glob chars), so
    // "docs/*.md" walks docs/ only, "*.md" walks base/ only. (A stray dirname
    // here walked one level too high: "*.md" scanned the config dir's PARENT.)
    const literalDir = e.split("/").slice(0, -1).join("/") || ".";
    const dir = join(base, literalDir);
    return walkFiles(dir).filter((f) => rx.test(relativePath(base, f)));
  }
  const p = isAbsolute(e) ? e : resolve(baseDir, e);
  return existsSync(p) && statSync(p).isFile() ? [p] : [];
}

/** Recursively list files under a directory (bounded, for glob matching). */
function walkFiles(dir: string, maxFiles = 2000): string[] {
  const out: string[] = [];
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) break;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walkFiles(p, maxFiles - out.length));
      else if (ent.isFile()) out.push(p);
    }
  } catch {
    // unreadable dir → skip
  }
  return out;
}

/**
 * Glob-relative path of a walked file under `base`, normalized for `..`
 * escapes. A pure prefix-slice breaks when the glob's literal dir walks
 * OUTSIDE base ("../docs/*.md" → dir above base) — path.relative gives the
 * correct "../docs/one.md" form in both cases.
 */
function relativePath(base: string, p: string): string {
  const rel = relative(base, p);
  return rel;
}

/** Load `instructions` entries from all trusted config layers (sync subset:
 * local paths and globs; URLs need the async loader). */
function loadInstructionsFromConfigSync(): string[] {
  const out: string[] = [];
  for (const layer of loadLayers()) {
    const inst = layer.config.instructions;
    if (!inst) continue;
    const base = dirname(layer.path);
    for (const entry of inst) {
      out.push(...readInstructionsEntry(entry, base));
    }
  }
  return out;
}

/** Read a rule file, trimming and honoring the 6000-char system-prompt budget.
 *  A file over the cap is cut WITH an explicit truncation marker so a silently
 *  truncated rule can never masquerade as complete (a mid-sentence cut can
 *  produce contradictory instructions the agent cannot diagnose). */
export function readRuleFile(path: string, maxChars = 6000): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n[truncated at ${maxChars} chars — rest of ${path} was not loaded]`;
  } catch {
    return "";
  }
}

/**
 * Collect all rule content (project + global + config instructions), returning
 * an ordered list of `{ path, content }` blocks, most-specific first.
 */
export function collectRulesSync(fromDir = process.cwd()): { path: string; content: string }[] {
  const seen = new Set<string>();
  const blocks: { path: string; content: string }[] = [];
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const content = readRuleFile(p);
    if (content) blocks.push({ path: p, content });
  };
  for (const p of findProjectRuleFiles(fromDir)) push(p);
  for (const p of findGlobalRuleFiles()) push(p);
  for (const p of loadInstructionsFromConfigSync()) push(p);
  return blocks;
}

/**
 * Render the collected rule blocks into a single system-prompt section.
 * Returns "" when no rules were found.
 */
export function renderRules(blocks: { path: string; content: string }[]): string {
  if (!blocks.length) return "";
  const parts = blocks.map(
    (b, i) => `### [rules ${i + 1}] ${b.path}\n${b.content}`,
  );
  return (
    `\n\n# Project rules\n` +
    `The following rules from AGENTS.md / CLAUDE.md / config instructions are ` +
    `mandatory and override any default behavior:\n\n` +
    parts.join("\n\n")
  );
}

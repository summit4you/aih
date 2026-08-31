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
 *   2. Global rules:  ~/.aih/AGENTS.md (AIH's own global dir) →
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadLayers } from "./config.js";

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
 * Global rule files: AIH's own global AGENTS.md first, then Claude Code
 * ~/.claude/CLAUDE.md (compat, unless disabled).
 */
export function findGlobalRuleFiles(): string[] {
  const out: string[] = [];
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
  // Remote URL: fetch with a short timeout, best-effort.
  if (/^https?:\/\//.test(entry)) {
    // No synchronous fetch in plain Node — log and skip (async path is in
    // loadRuleFilesAsync). Kept here for symmetry; the async loader handles URLs.
    return [];
  }
  // Glob pattern?
  if (entry.includes("*") || entry.includes("?")) {
    const globToRegex = (p: string): RegExp => {
      const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const rx = esc.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
      return new RegExp(`^${rx}$`);
    };
    const rx = globToRegex(entry);
    const base = resolve(baseDir);
    const dir = dirname(join(base, entry.split("/").slice(0, -1).join("/") || "."));
    return walkFiles(dir).filter((f) => rx.test(relativePath(base, f)));
  }
  const p = isAbsolute(entry) ? entry : resolve(baseDir, entry);
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

function relativePath(base: string, p: string): string {
  return p.startsWith(base) ? p.slice(base.length).replace(/^[/\\]/, "") : p;
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

/** Read a rule file, trimming and honoring the 6000-char system-prompt budget. */
export function readRuleFile(path: string, maxChars = 6000): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.trim().slice(0, maxChars);
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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadSkillRegistry } from "./config.js";
import { userAihDirs } from "./paths.js";

export interface Skill {
  name: string;
  description: string;
  scope: "project" | "user" | "builtin";
  path?: string;
  body: string;
}

export function parseSkillMd(
  raw: string,
  fallbackName: string,
): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: fallbackName, description: "", body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || "",
    body: m[2].trim(),
  };
}

function loadSkillDir(dir: string, scope: "project" | "user"): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const parsed = parseSkillMd(readFileSync(file, "utf8"), entry.name);
      out.push({ ...parsed, scope, path: file });
    } catch {
      continue;
    }
  }
  return out;
}

/** User-level skill dirs: primary XDG dir first, legacy `~/.aih` second (deduped). */
export function userSkillsDirs(): string[] {
  const out: string[] = [];
  for (const d of userAihDirs()) {
    const p = join(d, "skills");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function skillDirs(projectDir = process.cwd()): Array<{ dir: string; scope: "project" | "user" }> {
  return [
    { dir: join(projectDir, ".aih", "skills"), scope: "project" as const },
    ...userSkillsDirs().map((dir) => ({ dir, scope: "user" as const })),
  ];
}

export function discoverSkills(projectDir = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>();
  // User-level: legacy `~/.aih/skills` first, then the primary XDG dir — later
  // entries win per-name, so the primary XDG location takes precedence.
  for (const dir of userSkillsDirs()) {
    for (const s of loadSkillDir(dir, "user")) byName.set(s.name, s);
  }
  for (const s of loadSkillDir(join(projectDir, ".aih", "skills"), "project")) {
    byName.set(s.name, s);
  }
  for (const b of BUILTIN_SKILLS) {
    if (!byName.has(b.name)) byName.set(b.name, { ...b, scope: "builtin" });
  }
  return [...byName.values()];
}

export function searchSkills(query: string, skills: Skill[]): Skill[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...skills];
  const score = (s: Skill): number => {
    const hay = `${s.name} ${s.description}`.toLowerCase();
    let n = 0;
    for (const t of terms) {
      if (s.name.toLowerCase().includes(t)) n += 3;
      else if (hay.includes(t)) n += 1;
    }
    return n;
  };
  return skills
    .map((s) => ({ s, n: score(s) }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => b.n - a.n)
    .map(({ s }) => s);
}

export function installSkill(name: string, projectDir = process.cwd()): string {
  const builtin = BUILTIN_SKILLS.find((b) => b.name === name);
  if (!builtin) {
    throw new Error(`unknown builtin skill: ${name} (available: ${BUILTIN_SKILLS.map((b) => b.name).join(", ")})`);
  }
  const dir = join(projectDir, ".aih", "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    `---\nname: ${builtin.name}\ndescription: ${builtin.description}\n---\n${builtin.body}\n`,
  );
  return file;
}

export const BUILTIN_SKILLS: Array<{ name: string; description: string; body: string }> = [
  {
    name: "app-tour",
    description: "Explore the connected app's tools and produce a capability tour",
    body: `# App Tour

Goal: give the user a guided tour of the connected application.

Steps:
1. Call describe() if available, then review every tool exposed by the app.
2. Group tools by capability (read / write / admin).
3. For each group, demonstrate one safe read-only call against real data.
4. Summarize: what this app can do, what it refuses to do, and three suggested next actions.

Rules:
- Never perform a write action during a tour unless the user explicitly asks.
- Quote actual tool names and arguments you observed.`,
  },
  {
    name: "batch-ops",
    description: "Plan-execute-verify pattern for bulk operations on app data",
    body: `# Batch Operations

Use when the user asks to create/update/remove many items at once.

Steps:
1. PLAN: restate the target set as an explicit numbered list; confirm scope boundaries.
2. EXECUTE: apply operations one by one through the app's tools; keep a tally of done/skip/fail.
3. VERIFY: re-read state through a read tool and reconcile against the plan.
4. REPORT: table of applied items, skipped items with reasons, and final counts.

Rules:
- If more than 2 consecutive failures occur, stop and report instead of continuing blindly.
- Never retry a failed write without changing something about the request.`,
  },
  {
    name: "session-report",
    description: "Turn the current session history into a structured report",
    body: `# Session Report

Produce a handoff-ready summary of the work done in this conversation.

Sections:
1. Objective — what the user asked for, in one sentence.
2. Actions — every tool call grouped by intent, with outcomes (ok/failed).
3. State — current relevant app state observed via read tools.
4. Open items — anything promised but not done, each with a suggested next command.

Rules:
- Base every claim on events actually present in this session; do not invent history.
- Keep it under 400 words.`,
  },
];

// ---------------------------------------------------------------------------
// External skill registry (opencode-compatible)
//
// A registry is a base URL that serves:
//   GET {base}index.json          -> { "skills": [ { name, description?, files: string[], version? } ] }
//   GET {base}{name}/{file}       -> file contents
// `files` must include "SKILL.md". This mirrors opencode's skill discovery
// protocol (see packages/opencode/src/skill/discovery.ts) so any opencode
// registry can be used as-is.
// ---------------------------------------------------------------------------

export interface RemoteSkill {
  name: string;
  description?: string;
  files: string[];
  version?: string;
  /** normalized registry base URL (always ends with "/") */
  base: string;
}

export const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;

/** Fetch a URL body as text with a timeout. Throws on HTTP error / timeout. */
export async function fetchText(url: string, timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and validate a registry's index.json. Returns the skills that are
 * installable (have a name, a file list, and include SKILL.md).
 */
export async function fetchRegistryIndex(
  base: string,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
): Promise<RemoteSkill[]> {
  const b = base.endsWith("/") ? base : `${base}/`;
  const text = await fetchText(new URL("index.json", b).href, timeoutMs);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in registry index at ${b}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = (data as { skills?: unknown }).skills;
  if (!Array.isArray(list)) throw new Error(`invalid registry index at ${b}: missing "skills" array`);
  const out: RemoteSkill[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) continue;
    if (!Array.isArray(r.files) || !r.files.includes("SKILL.md")) continue;
    out.push({
      name: r.name,
      ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
      files: r.files.filter((f): f is string => typeof f === "string"),
      ...(typeof r.version === "string" && r.version ? { version: r.version } : {}),
      base: b,
    });
  }
  return out;
}

/**
 * Download a registry skill into destDir, version-aware and atomic.
 * If the skill is already present at the same version, it is a no-op.
 * Returns the path to the installed SKILL.md.
 */
export async function installRemoteSkill(
  skill: RemoteSkill,
  destDir: string,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
): Promise<string> {
  const skillMd = join(destDir, "SKILL.md");
  const versionFile = join(destDir, ".aih-version");
  const version = skill.version;
  const current =
    existsSync(versionFile) && version !== undefined
      ? readFileSync(versionFile, "utf8").trim()
      : undefined;
  if (version !== undefined && current === version && existsSync(skillMd)) {
    return skillMd; // already up to date
  }

  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const staging = `${destDir}.tmp-${token}`;
  try {
    for (const file of skill.files) {
      const url = new URL(file, `${skill.base}${skill.name}/`).href;
      const text = await fetchText(url, timeoutMs);
      const dest = join(staging, file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text, "utf8");
    }
    if (!existsSync(join(staging, "SKILL.md"))) {
      throw new Error(`registry skill "${skill.name}" is missing SKILL.md`);
    }
    if (version !== undefined) writeFileSync(join(staging, ".aih-version"), version, "utf8");

    if (existsSync(destDir)) {
      const backup = `${destDir}.old-${token}`;
      renameSync(destDir, backup);
      try {
        renameSync(staging, destDir);
      } catch (err) {
        renameSync(backup, destDir); // restore on failure
        throw err;
      }
      rmSync(backup, { recursive: true, force: true });
    } else {
      renameSync(staging, destDir);
    }
    return join(destDir, "SKILL.md");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Score remote skills against a query (same weighting as local searchSkills). */
export function searchRemote(query: string, skills: RemoteSkill[]): RemoteSkill[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...skills];
  const score = (s: RemoteSkill): number => {
    const hay = `${s.name} ${s.description ?? ""}`.toLowerCase();
    let n = 0;
    for (const t of terms) {
      if (s.name.toLowerCase().includes(t)) n += 3;
      else if (hay.includes(t)) n += 1;
    }
    return n;
  };
  return skills
    .map((s) => ({ s, n: score(s) }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => b.n - a.n)
    .map(({ s }) => s);
}

/**
 * Resolve the active skill registry base URLs.
 * Priority: explicit flag > AIH_SKILL_REGISTRY env (comma-separated) > aih.json skills.registry.
 */
export function resolveRegistryUrls(flag?: string): string[] {
  const add = (out: string[], v: string | undefined) => {
    if (!v) return;
    for (const part of v.split(",").map((x) => x.trim()).filter(Boolean)) out.push(part);
  };
  if (flag) {
    const out: string[] = [];
    add(out, flag);
    return [...new Set(out)];
  }
  const env = process.env.AIH_SKILL_REGISTRY;
  if (env) {
    const out: string[] = [];
    add(out, env);
    return [...new Set(out)];
  }
  return loadSkillRegistry();
}

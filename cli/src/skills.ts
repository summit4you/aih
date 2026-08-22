import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function skillDirs(projectDir = process.cwd()): Array<{ dir: string; scope: "project" | "user" }> {
  return [
    { dir: join(projectDir, ".aih", "skills"), scope: "project" as const },
    { dir: join(homedir(), ".aih", "skills"), scope: "user" as const },
  ];
}

export function discoverSkills(projectDir = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of loadSkillDir(join(homedir(), ".aih", "skills"), "user")) {
    byName.set(s.name, s);
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

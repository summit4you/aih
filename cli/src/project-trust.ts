/**
 * P#40 — project trust gate (Pi: project-trust.ts + trust.json).
 *
 * A cloned repository can carry its own aih.json (providers, MCP servers,
 * permission rules) and .aih/ assets. Loading them blindly executes the
 * repo author's choices in the user's environment. The trust gate asks
 * ONCE per directory before any project-local configuration is honored,
 * records the decision in a USER-level file keyed by path, and supports
 * one-shot overrides (--trust / --no-trust) plus a non-interactive default
 * policy.
 *
 * Design notes:
 * - The trust file lives under the user's global dir, NOT the project —
 *   the project must not be able to trust itself.
 * - Decisions are keyed by resolved absolute path; moving a directory
 *   re-triggers the prompt (path-keyed, simple and predictable).
 * - Non-interactive contexts (run --yes, CI) follow `defaultPolicy`
 *   ("allow" | "deny") instead of prompting; default deny fails closed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userAihDir } from "./paths.js";
import { readJson } from "./read-json.js";

export type TrustDecision = "trusted" | "untrusted";

export interface TrustRecord {
  /** Absolute project path → decision + when it was recorded. */
  projects: Record<string, { decision: TrustDecision; ts: number }>;
}

const TRUST_FILE = "trust.json";

export interface TrustQuery {
  projectDir?: string;
  /** TTY context — when false, prompts are skipped in favor of policy. */
  interactive?: boolean;
  /** One-shot CLI override. */
  flag?: "trust" | "no-trust";
  /** Policy used when non-interactive and no flag: "allow" | "deny". */
  defaultPolicy?: "allow" | "deny";
  /** Prompt implementation (injectable for tests / TUI). */
  ask?: (dir: string) => Promise<boolean>;
}

function trustFilePath(): string {
  return join(userAihDir(), TRUST_FILE);
}

function readTrustFile(): TrustRecord {
  const p = trustFilePath();
  if (!existsSync(p)) return { projects: {} };
  try {
    const raw = readJson<Partial<TrustRecord>>(p);
    return { projects: raw.projects ?? {} };
  } catch {
    // Corrupt trust file: fail closed (treat as no decisions), never throw.
    return { projects: {} };
  }
}

function writeTrustFile(rec: TrustRecord): void {
  const p = trustFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

/** Normalize a directory to the canonical key form. */
export function trustKey(projectDir?: string): string {
  const dir = projectDir ?? process.cwd();
  return resolve(isAbsolute(dir) ? dir : join(process.cwd(), dir));
}

/**
 * Read the stored decision without prompting. Undefined = never asked.
 */
export function getTrustDecision(projectDir?: string): TrustDecision | undefined {
  const key = trustKey(projectDir);
  return readTrustFile().projects[key]?.decision;
}

/**
 * Record a decision (used by both the prompt flow and explicit flags).
 */
export function setTrustDecision(decision: TrustDecision, projectDir?: string): void {
  const key = trustKey(projectDir);
  const rec = readTrustFile();
  rec.projects[key] = { decision, ts: Date.now() };
  writeTrustFile(rec);
}

export type TrustOutcome = "granted" | "denied" | "already-granted" | "already-denied";

/**
 * Resolve whether `projectDir` may load project-local config/skills.
 * Order of authority:
 *   1. explicit flag (--trust / --no-trust) — also persisted
 *   2. existing stored decision
 *   3. interactive prompt (persisted answer)
 *   4. non-interactive default policy (NOT persisted)
 */
export async function ensureProjectTrust(q: TrustQuery = {}): Promise<TrustOutcome> {
  const key = trustKey(q.projectDir);
  const existing = readTrustFile().projects[key]?.decision;

  if (q.flag === "trust") {
    if (existing !== "trusted") setTrustDecision("trusted", q.projectDir);
    return existing === "trusted" ? "already-granted" : "granted";
  }
  if (q.flag === "no-trust") {
    if (existing !== "untrusted") setTrustDecision("untrusted", q.projectDir);
    return existing === "untrusted" ? "already-denied" : "denied";
  }
  if (existing === "trusted") return "already-granted";
  if (existing === "untrusted") return "already-denied";

  if (!q.interactive) {
    return q.defaultPolicy === "allow" ? "granted" : "denied";
  }

  const ask =
    q.ask ??
    (async (dir: string) => {
      // Lazy import keeps node:test-style environments honest; in the real
      // TTY path this uses readline.
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      process.stderr.write(
        `\nThis directory (${dir}) carries its own AIH configuration (.aih/, aih.json).\n` +
          "Loading it runs that repo's model/MCP/permission settings.\n",
      );
      const ans = (await rl.question("Trust this directory and load its AIH config? [y/N] ")).trim();
      rl.close();
      return ans.toLowerCase() === "y" || ans.toLowerCase() === "yes";
    });
  const yes = await ask(key);
  setTrustDecision(yes ? "trusted" : "untrusted", q.projectDir);
  return yes ? "granted" : "denied";
}

/** True when the directory carries project-level AIH configuration/assets. */
export function hasProjectAssets(dir: string): boolean {
  return (
    existsSync(join(dir, "aih.json")) ||
    existsSync(join(dir, ".aih", "config.json")) ||
    existsSync(join(dir, ".aih", "workflows")) ||
    existsSync(join(dir, ".aih", "skills"))
  );
}

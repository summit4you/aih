/**
 * XDG data-dir resolution (roadmap P2#9 "XDG 数据目录规范").
 *
 * User-level (global) aih data — config, user skills, and (via --data-dir)
 * sessions — lives under the XDG data home instead of the ad-hoc `~/.aih`:
 *
 *   1. AIH_HOME            (explicit override, wins)
 *   2. $XDG_DATA_HOME/aih  (XDG base dir, default ~/.local/share)
 *   3. ~/.local/share/aih  (XDG default)
 *
 * Backward-compat: if the XDG location doesn't exist yet but the legacy
 * `~/.aih` does, we keep using `~/.aih` so existing installs don't lose
 * their config/skills. Project-scoped `.aih/` (relative to cwd) is untouched —
 * that is the correct XDG "project data" location and is not migrated.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AihPaths {
  /** user-level data dir (config.json, skills/, …) */
  user: string;
  /** legacy ~/.aih dir (kept for read-compat) */
  legacy: string;
  /** true when we resolved to the legacy dir for compatibility */
  usingLegacy: boolean;
}

export function resolveAihPaths(env: NodeJS.ProcessEnv = process.env): AihPaths {
  // Honor an injected HOME (tests / containers) before falling back to os.
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const legacy = join(home, ".aih");
  if (env.AIH_HOME) {
    return { user: env.AIH_HOME, legacy, usingLegacy: false };
  }
  const xdg = env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, "aih")
    : join(home, ".local", "share", "aih");
  // Migration-friendly: prefer XDG, but honor an existing legacy dir.
  if (existsSync(legacy) && !existsSync(xdg)) {
    return { user: legacy, legacy, usingLegacy: true };
  }
  return { user: xdg, legacy, usingLegacy: false };
}

/** Primary user-level data dir (see resolveAihPaths). */
export function userAihDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAihPaths(env).user;
}

/**
 * All candidate user-level data dirs, primary first, legacy second (deduped).
 * Readers (config, skills) should look in this order so a setup that has data
 * in either location keeps working.
 */
export function userAihDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const { user, legacy } = resolveAihPaths(env);
  const out = [user];
  if (legacy && legacy !== user) out.push(legacy);
  return out;
}

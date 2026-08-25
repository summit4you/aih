/**
 * F#28 increment — git worktree snapshot for checkpoints.
 *
 * A checkpoint is only useful if you can tell *what state the code was in*
 * when you took it. This module captures a cheap, bounded summary of the
 * working tree at checkpoint time: current branch, HEAD short sha and a
 * capped changed-file list via `git status --porcelain -b`.
 *
 * Types live in core (`WorktreeSummary` on the checkpoint event); this module
 * owns the capture: it shells out to git synchronously with a hard timeout
 * and returns `undefined` instead of throwing when git is missing, the
 * directory is not a repository, or git times out — checkpointing must never
 * fail because of the snapshot. All functions are unit-testable against a
 * real temp repo.
 */
import { spawnSync } from "node:child_process";
import type { WorktreeSummary } from "@aih/core";
import { workspaceIdentity } from "./workspace-identity.js";

/** Hard upper bound on stored entries so the session log stays small. */
export const MAX_DIRTY_ENTRIES = 50;
const GIT_TIMEOUT_MS = 5000;

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) return { ok: false, out: "" };
  return { ok: true, out: r.stdout ?? "" };
}

/**
 * Snapshot the worktree at `opts.cwd` (default process.cwd()). Returns
 * `undefined` when git is unavailable / not a repository / timed out.
 */
export function gitStatusSummary(opts?: {
  cwd?: string;
}): WorktreeSummary | undefined {
  const cwd = opts?.cwd ?? process.cwd();
  const st = git(cwd, ["status", "--porcelain", "-b"]);
  if (!st.ok) return undefined;
  const lines = st.out.split("\n").filter((l) => l.length > 0);
  let branch: string | null = null;
  const dirty: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      // "No commits yet on main" (fresh repo) | "main...origin/main [ahead 1]" | "main"
      const fresh = rest.match(/^No commits yet on (.+)$/);
      branch = fresh ? fresh[1].trim() : rest.split("...")[0].trim();
      continue;
    }
    // Porcelain rows are "XY <path>" / "R  old -> new" — keep status + path.
    const status = line.slice(0, 2).trim() || "?";
    const path = line.slice(3);
    dirty.push(`${status} ${path}`);
  }
  const headRes = git(cwd, ["rev-parse", "--short", "HEAD"]);
  const head = headRes.ok ? headRes.out.trim() || null : null;
  // MK#47: attach the logical workspace identity (best-effort, may be undefined).
  const identity = workspaceIdentity({ cwd });
  return {
    ...(identity ? { workspaceId: identity.uuid } : {}),
    branch,
    head,
    dirty: dirty.slice(0, MAX_DIRTY_ENTRIES),
    dirtyCount: dirty.length,
    clean: dirty.length === 0,
  };
}

/** Human-readable lines for TUI/CLI display ("worktree: …" block). */
export function formatWorktreeSummary(w: WorktreeSummary): string[] {
  const where = [w.branch ?? "(detached)", w.head ? `@ ${w.head}` : null]
    .filter(Boolean)
    .join(" ");
  const lines = [`worktree: ${where}`];
  if (w.clean) {
    lines.push("worktree: clean");
  } else {
    lines.push(`worktree: ${w.dirtyCount} changed file(s)`);
    for (const d of w.dirty) lines.push(`  ${d}`);
    if (w.dirtyCount > w.dirty.length) {
      lines.push(`  … and ${w.dirtyCount - w.dirty.length} more`);
    }
  }
  return lines;
}

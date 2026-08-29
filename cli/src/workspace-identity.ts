/**
 * MK#47 — workspace identity marker (Apache Maka's `.maka-workspace.json`).
 *
 * A checkpoint / fork / resume must be able to prove "this is still the same
 * workspace" as a LOGICAL identity, independent of the path. A path move is
 * diagnostic information; an identity MISMATCH is a hard gate.
 *
 * The marker lives at `<cwd>/.aih/workspace.json` and carries a single
 * stable UUID. First access creates it; later reads return the same id.
 * Everything is best-effort: if the filesystem is unwritable or unreadable,
 * resolve returns undefined and callers must treat identity as UNKNOWN —
 * unknown never blocks, mismatch always does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson } from "./read-json.js";

const MARKER_REL = join(".aih", "workspace.json");

export interface WorkspaceIdentity {
  /** Logical identity, stable across path moves. */
  uuid: string;
  /** Where the marker file was found/created. */
  path: string;
}

function readMarker(path: string): WorkspaceIdentity | undefined {
  try {
    const raw = readJson<{ workspaceId?: unknown }>(path);
    const id = typeof raw.workspaceId === "string" ? raw.workspaceId.trim() : "";
    if (id) return { uuid: id, path };
    // Structurally invalid marker: do not silently rewrite a foreign file.
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve (creating on first use) the workspace identity for `cwd`
 * (default process.cwd()). Returns undefined when identity cannot be
 * established (unreadable/unwritable fs) — callers treat that as unknown,
 * not as a mismatch.
 */
export function workspaceIdentity(opts?: { cwd?: string }): WorkspaceIdentity | undefined {
  const cwd = opts?.cwd ?? process.cwd();
  const dir = join(cwd, ".aih");
  const path = join(dir, "workspace.json");
  if (existsSync(path)) return readMarker(path);
  try {
    mkdirSync(dir, { recursive: true });
    const identity: WorkspaceIdentity = { uuid: randomUUID(), path };
    writeFileSync(
      path,
      `${JSON.stringify({ workspaceId: identity.uuid }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return identity;
  } catch {
    return undefined;
  }
}

/** Read-only variant: never creates anything. Undefined when absent/invalid. */
export function peekWorkspaceIdentity(opts?: { cwd?: string }): WorkspaceIdentity | undefined {
  const cwd = opts?.cwd ?? process.cwd();
  const path = join(cwd, MARKER_REL);
  if (!existsSync(path)) return undefined;
  return readMarker(path);
}

export type IdentityCheck = "match" | "mismatch" | "unknown";

/**
 * Compare two identities by uuid only. Path differences are NOT mismatches —
 * moving a directory does not change what it is. Unknown on either side is
 * "unknown" (advisory), never a hard failure.
 */
export function compareIdentity(
  a: WorkspaceIdentity | undefined,
  b: WorkspaceIdentity | undefined,
): IdentityCheck {
  if (!a || !b) return "unknown";
  return a.uuid === b.uuid ? "match" : "mismatch";
}

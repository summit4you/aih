/**
 * OC#7 — credential ownership isolation (Pi: owner-state.ts + owner.json).
 *
 * OpenClaw semantic (why-openclaw property ④ "Secrets have owners"):
 * an isolatable credential failure DEGRADES ITS OWNER — that one provider /
 * channel account / plugin route is marked unavailable and requests to it fail
 * with a typed error; the runtime NEVER falls back to a different credential.
 * Ingress-auth failures, unknown ownership, and invalid secret configuration
 * still PREVENT STARTUP (fail closed).
 *
 * AIH mapping: an "owner" is a configured LLM provider (empero / llamacpp /
 * zhipu / opencode …). When a provider's credential/capacity attempt fails
 * (auth 401/403 or quota exhaustion), we record that owner as degraded in a
 * USER-level file keyed by provider name — never in the project, never
 * silently. `aih models` / `aih doctor` / `aih status` list every degraded
 * owner with a REDACTED reason, so the user knows exactly which credential is
 * down and why, instead of the runtime quietly continuing on a different one.
 *
 * Hard-fail (still blocks): missing API key for a keyed provider, unknown
 * provider reference, or a provider denied by policy. Those are checked at
 * resolve/build time in config.ts and throw — they are NOT turned into a
 * degradation. Degradation is for runtime credential failures on an otherwise
 * valid owner; it lets OTHER owners keep working and lets the user explicitly
 * re-select a different owner (a user decision, not an automatic fallback).
 *
 * The registry lives under the user's global dir (NOT the project) so a
 * cloned repo cannot read or alter it — the owner state reflects the user's
 * credentials, which the project must not own.
 *
 * Design notes:
 * - Keys are provider names (the owner id). Simple and predictable.
 * - Reasons are redacted before being stored; secrets never reach disk or
 *   render output.
 * - `clearOwnerDegraded` lets a user who fixed a credential reset it; the
 *   CLI also auto-clears on a successful call for that owner (recovery hook).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userAihDir } from "./paths.js";
import { readJson } from "./read-json.js";

/** What class of failure degraded the owner. */
export type OwnerFailureClass = "credential" | "quota";

/** One degraded owner record. */
export interface OwnerRecord {
  /** Owner (provider name, e.g. "empero"). */
  owner: string;
  /** Failure class. */
  cls: OwnerFailureClass;
  /** Redacted, human-readable reason. */
  reason: string;
  /** Epoch ms when the failure was recorded. */
  ts: number;
  /** Cumulative failure count observed for this owner. */
  count: number;
}

export interface OwnerState {
  /** owner name → record. */
  owners: Record<string, OwnerRecord>;
}

const OWNER_FILE = "owner.json";

function ownerFilePath(): string {
  return join(userAihDir(), OWNER_FILE);
}

function readOwnerFile(): OwnerState {
  const p = ownerFilePath();
  if (!existsSync(p)) return { owners: {} };
  try {
    const raw = readJson<Partial<OwnerState>>(p);
    return { owners: raw.owners ?? {} };
  } catch {
    // Corrupt owner file: fail open to an empty state (never throw, never
    // block startup on an auxiliary registry we can just re-derive).
    return { owners: {} };
  }
}

function writeOwnerFile(state: OwnerState): void {
  const p = ownerFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Redact anything that looks like a secret from a failure reason, so never a
 * raw credential reaches disk or the rendered report. Masks:
 *   - bearer tokens / api keys / sk-… / long base62/hex runs
 *   - `key = value` assignments for common secret-ish names
 *   - quoted secrets immediately after authorization/api-key headers
 */
const SECRET_RUN_RE =
  /\b(?:Bearer|sk-[A-Za-z0-9_\-]{6,}|key=?"?[A-Za-z0-9_\-\.]{6,}"?|(?:api[-_]?key|authorization|token|secret|password)\s*[:=]\s*"?[A-Za-z0-9_\-\.\/+]{6,}"?)/gi;
const LONG_RUN_RE = /\b[A-Za-z0-9_\-]{28,}\b/g;

export function redactCredential(text: string): string {
  if (!text) return text;
  let out = text.replace(SECRET_RUN_RE, "[redacted]");
  out = out.replace(LONG_RUN_RE, (m) => (m.length >= 28 ? "[redacted]" : m));
  return out;
}

/**
 * Record that an owner (provider) failed in a way that marks it unavailable.
 * Reasons are redacted before persistence. Returns the updated record.
 */
export function markOwnerDegraded(
  owner: string,
  cls: OwnerFailureClass,
  reason: string,
): OwnerRecord {
  const state = readOwnerFile();
  const safe = redactCredential(reason);
  const prev = state.owners[owner];
  const rec: OwnerRecord = {
    owner,
    cls,
    reason: safe,
    ts: Date.now(),
    count: (prev?.count ?? 0) + 1,
  };
  state.owners[owner] = rec;
  writeOwnerFile(state);
  return rec;
}

/** Is `owner` currently degraded? */
export function isOwnerDegraded(owner: string): boolean {
  return Boolean(readOwnerFile().owners[owner]);
}

/** List degraded owners (records), oldest first. */
export function listDegradedOwners(): OwnerRecord[] {
  return Object.values(readOwnerFile().owners).sort((a, b) => a.ts - b.ts);
}

/** Clear a single owner's degradation (called when the user fixed it). */
export function clearOwnerDegraded(owner: string): void {
  const state = readOwnerFile();
  if (!state.owners[owner]) return;
  delete state.owners[owner];
  writeOwnerFile(state);
}

/** Clear all degradation records (`aih models --clear-degraded`). */
export function clearAllOwnerDegraded(): void {
  writeOwnerFile({ owners: {} });
}

/** Delete the registry file (tests / full reset). */
export function _resetOwnerState(): void {
  const p = ownerFilePath();
  if (!existsSync(p)) return;
  try {
    writeFileSync(p, `${JSON.stringify({ owners: {} }, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Render the degradation report block used by `aih models` / `aih doctor`.
 * Returns "" when nothing is degraded.
 */
export function renderDegradationReport(records: OwnerRecord[]): string {
  if (!records.length) return "";
  const lines = ["degraded owners:"];
  for (const r of records) {
    const when = new Date(r.ts).toISOString();
    lines.push(
      `  - ${r.owner} [${r.cls}] x${r.count} @ ${when}: ${r.reason}`,
    );
  }
  return lines.join("\n");
}

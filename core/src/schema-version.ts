/**
 * OC#5 — Versioned state, guarded upgrades (OpenClaw `why-openclaw.md` 属性⑤).
 *
 * OpenClaw's contract: "a build refuses to open a database newer than itself."
 * AIH applies the same principle to its two persisted state files:
 *
 *   - `aih.json` / `config.json`  → `schemaVersion` field
 *   - session `.jsonl`            → `schemaVersion` field (first event or meta)
 *
 * Guard semantics (fail-closed, loud):
 *   - No `schemaVersion` field  → legacy file, accepted (backward compat).
 *   - `schemaVersion` ≤ max     → OK.
 *   - `schemaVersion` > max     → **throw**: this build cannot safely interpret
 *     the file; refuse to open rather than silently misread it.
 *
 * This is the AIH equivalent of OpenClaw's "build refuses to open a DB newer
 * than itself" + "update refuses targets whose schema support is older than
 * on-disk state." AIH has no `update` command, so the guard is one-directional:
 * a new build can open old files; an old build must not open new files.
 */

/** Highest config schema version this build understands. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Highest session schema version this build understands. */
export const SESSION_SCHEMA_VERSION = 1;

/**
 * Check a persisted state file's `schemaVersion` against this build's max.
 * Throws a descriptive error when the file is newer than this build supports.
 *
 * @param fileVersion  the `schemaVersion` value read from the file (undefined
 *                     when the field is absent — legacy file, accepted).
 * @param maxSupported the build's max supported version
 *                     (`CONFIG_SCHEMA_VERSION` or `SESSION_SCHEMA_VERSION`).
 * @param kind         "config" | "session" — for the error message.
 * @param path         file path — for the error message.
 */
export function checkSchemaVersion(
  fileVersion: number | undefined,
  maxSupported: number,
  kind: "config" | "session",
  path?: string,
): void {
  if (fileVersion === undefined) return; // legacy: no version field → accept
  if (fileVersion > maxSupported) {
    const loc = path ? ` (${path})` : "";
    throw new Error(
      `${kind} file${loc} has schemaVersion ${fileVersion}, ` +
      `but this AIH build only supports up to ${maxSupported}. ` +
      `Upgrade AIH before opening this ${kind} file — ` +
      `opening it with an older build may corrupt or misread state.`,
    );
  }
}

/**
 * Stamp a `schemaVersion` onto a config object before writing.
 * Returns a new object (does not mutate the input).
 */
export function stampConfigVersion(cfg: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, ...cfg };
}

/**
 * Stamp a `schemaVersion` onto a session event (first event in the JSONL).
 * Returns a new event object.
 */
export function stampSessionVersion(event: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: SESSION_SCHEMA_VERSION, ...event };
}

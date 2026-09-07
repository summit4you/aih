/**
 * OMP-R#11 — reversible secret placeholder.
 *
 * The existing `redactCredential` is one-way: secrets are replaced with
 * "[redacted]" and the original value is lost. This module adds a REVERSIBLE
 * layer: when the model echoes a known secret (e.g. in a tool call argument),
 * we replace it with a placeholder like `{{secret:0}}` and remember the
 * mapping. Before the tool actually executes, we restore the real value from
 * the placeholder. The user sees the placeholder in the TUI (safe); the tool
 * gets the real secret (functional).
 *
 * Zero deps, pure TS. The placeholder format is `{{secret:N}}` where N is a
 * sequential index into the session's placeholder table.
 */

/** Placeholder pattern: {{secret:N}} */
const PLACEHOLDER_RE = /\{\{secret:(\d+)\}\}/g;

/** Session-scoped placeholder table: index → real secret value. */
const table = new Map<number, string>();
let nextIndex = 0;

/**
 * Replace all known secrets in `text` with placeholders.
 * Returns the redacted text + the number of replacements made.
 */
export function obfuscate(text: string, secrets: string[]): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue; // skip trivially short values
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    if (re.test(out)) {
      out = out.replace(re, `{{secret:${nextIndex++}}}`);
      count++;
    }
  }
  return { text: out, count };
}

/**
 * Restore placeholders back to real secrets.
 * Returns the deobfuscated text.
 */
export function deobfuscate(text: string): string {
  return text.replace(PLACEHOLDER_RE, (_, idx) => {
    const n = Number(idx);
    return table.get(n) ?? `{{secret:${n}}}`; // unknown placeholder → leave as-is
  });
}

/**
 * Register a secret in the placeholder table (called by the obfuscator).
 * Returns the index for use in the placeholder.
 */
export function registerSecret(value: string): number {
  const idx = nextIndex++;
  table.set(idx, value);
  return idx;
}

/**
 * Clear all placeholders (call at session end or on /clear).
 */
export function clearPlaceholders(): void {
  table.clear();
  nextIndex = 0;
}

/**
 * Check if a text contains any secret placeholders.
 */
export function hasPlaceholders(text: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(text);
}

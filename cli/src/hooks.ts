/**
 * D#11 — built-in tool-execution hooks (redaction + timing).
 *
 * These ride the core `ToolRegistry.addHooks` seam (the same waterfall the
 * default tool-audit consumer uses). Redaction is ON by default: it scrubs
 * obvious secret shapes (API keys / tokens / passwords) out of tool RESULTS
 * before they reach the LLM, the session log, and the audit trail. Timing
 * attaches a `duration_ms` to every tool result. Both are best-effort and
 * never throw into the turn.
 *
 * Redaction is intentionally conservative: it only rewrites *string leaf
 * values* that look like a credential, so it cannot corrupt structured data
 * (numbers, booleans, paths). A `redacted: N` counter is added to the result
 * so the user can see something was masked.
 */
import type { ToolHookInfo, ToolInvocationResult, ToolHooks } from "@aih/core";

/**
 * Compose multiple hook sets into one ToolHooks, chaining their `after`
 * waterfalls in order (so a later hook sees the earlier hook's rewritten
 * result). `before` hooks run in order too. Used to layer builtin hooks
 * (redaction+timing) with the audit consumer without one overwriting the
 * other.
 */
export function composeHooks(sets: ToolHooks[]): ToolHooks {
  const befores: NonNullable<ToolHooks["before"]>[] = [];
  const afters: NonNullable<ToolHooks["after"]>[] = [];
  for (const s of sets) {
    if (s.before) befores.push(s.before);
    if (s.after) afters.push(s.after);
  }
  return {
    ...(befores.length
      ? { before: (info: ToolHookInfo) => befores.forEach((b) => b(info)) }
      : {}),
    ...(afters.length
      ? {
          after: async (info: ToolHookInfo, outcome: ToolInvocationResult) => {
            let out = outcome;
            for (const a of afters) {
              const next = await a(info, out);
              if (next) out = next;
            }
            return out;
          },
        }
      : {}),
  };
}

/**
 * Patterns that look like a credential. Each is a key/value pair where the
 * key names a secret and the value is a plausible token. We match the value
 * (not the key) so a placeholder like `"API_KEY": "set-me"` is left alone
 * (it is not a real secret) while a real `ghp_…` token is masked.
 */
/** A secret shape: a regex plus (optionally) which capture group is the
 *  secret value to mask. When `group` is omitted the whole match is the
 *  secret (bare token shapes). */
type SecretPattern = { re: RegExp; group?: number };

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI / Anthropic / GitHub / Google / AWS / Slack / generic long tokens
  { re: /sk-[A-Za-z0-9_-]{8,}/g },
  { re: /ghp_[A-Za-z0-9]{16,}/g },
  { re: /gho_[A-Za-z0-9]{16,}/g },
  { re: /ghs_[A-Za-z0-9]{16,}/g },
  { re: /github_pat_[A-Za-z0-9_]{16,}/g },
  { re: /AKIA[0-9A-Z]{16}/g },
  { re: /AIza[0-9A-Za-z_-]{30,}/g },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // key=value / "key": "value" shapes with a secret-named key — mask the value
  {
    re: /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|credential|credentials|session[_-]?token|bearer)\s*[:=]\s*["']?([A-Za-z0-9+/=_\-]{12,})["']?/gi,
    group: 2,
  },
];

const REDACTED = "[REDACTED]";

function redactString(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (match, ...args) => {
      // replace() callback args = [p1, p2, ..., offset, string]; drop the
      // trailing offset+string to get the capture groups.
      const groups = args.slice(0, -2);
      const secret = p.group ? groups[p.group - 1] : match;
      return match.replace(String(secret), REDACTED);
    });
  }
  return out;
}

/**
 * Return a redacted copy of `value` (strings only) with secret shapes masked.
 * Non-string values pass through unchanged.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = redactSecrets(v);
    return out;
  }
  return value;
}

/**
 * Count how many secret shapes a string would redact (for tests / reporting).
 */
export function countSecrets(value: unknown): number {
  if (typeof value === "string") {
    let n = 0;
    for (const p of SECRET_PATTERNS) {
      const m = value.match(p.re);
      if (m) n += m.length;
    }
    return n;
  }
  if (Array.isArray(value)) return value.reduce<number>((a, v) => a + countSecrets(v), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>((a, v) => a + countSecrets(v), 0);
  }
  return 0;
}

/**
 * Build the D#11 built-in hooks: redaction (on success + error) + timing.
 *
 * - `before` records a start timestamp (keyed by a monotonic counter) so the
 *   `after` hook can report the real execution duration.
 * - `after` redacts secrets from the result/error and attaches `duration_ms`.
 *
 * Register BEFORE the audit hook so the audit log sees the redacted result.
 */
export function builtinHooks(): {
  before: (info: ToolHookInfo) => void;
  after: (info: ToolHookInfo, outcome: ToolInvocationResult) => ToolInvocationResult;
} {
  // Correlate before/after via the per-call id (exact even under concurrent
  // parallel-read dispatch).
  const starts = new Map<string, number>();
  return {
    before: (info) => {
      starts.set(info.callId, Date.now());
    },
    after: (info, outcome) => {
      const start = starts.get(info.callId) ?? Date.now();
      starts.delete(info.callId);
      const durationMs = Math.max(0, Date.now() - start);
      let result: unknown = outcome.result;
      let redactedCount = 0;
      if (outcome.ok && result !== undefined) {
        redactedCount = countSecrets(result);
        if (redactedCount > 0) result = redactSecrets(result);
      }
      // Redact error messages too (they can echo secrets).
      let error = outcome.error;
      if (error) {
        const redactedErr = redactSecrets(error);
        if (typeof redactedErr === "string" && redactedErr !== error) error = redactedErr;
      }
      const finalResult =
        result && typeof result === "object" && !Array.isArray(result)
          ? { ...(result as object), duration_ms: durationMs, ...(redactedCount > 0 ? { redacted: redactedCount } : {}) }
          : result;
      return {
        ok: outcome.ok,
        ...(finalResult !== undefined ? { result: finalResult } : {}),
        ...(error !== undefined ? { error } : {}),
        permission: outcome.permission,
      };
    },
  };
}

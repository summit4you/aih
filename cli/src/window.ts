/**
 * Live context-window detection for llama.cpp-compatible servers.
 *
 * The server reports each slot's own `n_ctx` (per-slot context, already
 * divided across `parallel` slots), so MIN(n_ctx) over the slots is exactly
 * the effective window a single request may use — no manual "256k / 2" math.
 * Non-llama.cpp endpoints (no `/slots`) or unreachable servers leave the
 * cached value null and callers fall back to the configured window.
 */
export const WINDOW_PROBE_TIMEOUT_MS = 1500;

const cache = new Map<string, number | null>();

function cacheKey(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

/** Detected window for a base URL, if the probe succeeded (undefined otherwise). */
export function detectedWindow(baseUrl: string | undefined): number | undefined {
  const k = cacheKey(baseUrl);
  if (!k) return undefined;
  const v = cache.get(k);
  return v && v > 0 ? v : undefined;
}

/** Test hook. */
export function resetWindowCache(): void {
  cache.clear();
}

/**
 * Probe `{origin}/slots` once (then serve from cache). Returns the effective
 * per-request window (min slot n_ctx), or undefined on any failure — probing
 * is best-effort and never throws.
 */
export async function probeContextWindow(
  baseUrl: string | undefined,
  timeoutMs: number = WINDOW_PROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  const k = cacheKey(baseUrl);
  if (!k) return undefined;
  const cached = cache.get(k);
  if (cached !== undefined) return cached || undefined;
  let value: number | null = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${k}/slots`, { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as
        | Array<{ n_ctx?: unknown }>
        | null;
      if (Array.isArray(body)) {
        const ctxs = body
          .map((s) => (s && typeof s === "object" ? Number((s as { n_ctx?: unknown }).n_ctx) : NaN))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (ctxs.length) value = Math.min(...ctxs);
      }
    }
  } catch {
    value = null;
  }
  cache.set(k, value);
  return value ?? undefined;
}

/**
 * F#30 — cost / TPS accounting.
 *
 * Prices are $ per 1M tokens, split into input (prompt) and output (completion).
 * Resolution order: `prices` from aih.json (user override) → built-in default
 * table for common models. Matching is normalized substring (case-insensitive)
 * so dated / suffixed ids ("gpt-4o-2024-11-20") still resolve ("gpt-4o").
 *
 * All functions are pure over the session event log so they are unit-testable
 * without a live LLM (the mock LLM does not report usage).
 */
import type { SessionEvent, TokenUsage } from "@aih/core";
import { estimateTokensText, truncateToolOutput } from "@aih/core";
import { MODEL_METADATA } from "./model-metadata.js";

export interface ModelPrice {
  /** $ per 1M input (prompt) tokens */
  input: number;
  /** $ per 1M output (completion) tokens */
  output: number;
}

/** Built-in price table ($/1M tokens) for common models. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  o1: { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o1-preview": { input: 15, output: 60 },
  // Anthropic
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-4": { input: 1, output: 5 },
  // Google
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // Qwen
  "qwen-max": { input: 2.4, output: 9.6 },
  "qwen-plus": { input: 0.4, output: 1.2 },
  "qwen-turbo": { input: 0.05, output: 0.2 },
  // Meta / others
  "llama-3.1-70b": { input: 0.59, output: 0.79 },
  "mistral-large": { input: 2, output: 6 },
  "mistral-small": { input: 0.2, output: 0.6 },
};

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Resolve a price for a model id. Checks the user `prices` override first
 * (normalized substring match), then the built-in table. Returns undefined if
 * no table entry matches (cost then renders as "—").
 */
export function resolvePrice(
  model: string,
  prices?: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const m = norm(model);
  if (!m) return undefined;
  const look = (table: Record<string, ModelPrice>): ModelPrice | undefined => {
    // Prefer exact, then longest-key substring so "gpt-4o-mini" doesn't
    // accidentally match the "gpt-4o" row.
    const keys = Object.keys(table).sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    );
    for (const k of keys) {
      const nk = norm(k);
      if (m === nk || m.includes(nk)) return table[k];
    }
    return undefined;
  };
  // P#48: models.dev snapshot as the LAST fallback — user overrides and the
  // built-in table win; the snapshot only fills gaps for models missing from
  // both (snapshot keys are provider-scoped like "openai/gpt-4o", so match
  // on the bare model segment).
  const snapLook = (table: Record<string, ModelPrice>): ModelPrice | undefined => {
    const keys = Object.keys(table).sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    );
    for (const k of keys) {
      const nk = norm(k);
      if (m === nk || m.includes(nk)) return table[k];
    }
    return undefined;
  };
  return look(prices ?? {}) ?? look(DEFAULT_PRICES) ?? snapLook(snapshotPrices());
}

/**
 * P#48 — flatten the generated models.dev snapshot to bare model-name keys
 * (provider prefix stripped; first occurrence wins on collision).
 */
function snapshotPrices(): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const [k, v] of Object.entries(MODEL_METADATA)) {
    if (!v.price) continue;
    const bare = k.split("/").pop() ?? k;
    if (!out[bare]) out[bare] = v.price;
  }
  return out;
}

/**
 * Context window for a model from the committed models.dev snapshot (P#48).
 * Keys are provider-scoped ("openai/gpt-4o"); resolution order:
 *   1. `providerHint` matches the snapshot's provider segment exactly
 *      (catalog/config provider id ↔ models.dev id, e.g. "opencode-go").
 *   2. bare-model exact match across providers → the MODE value (tie →
 *      smaller). Claiming more than the model supports would hard-fail
 *      requests at the provider, while under-claiming only compacts
 *      earlier — so disagreement resolves conservatively, not maximally.
 *   3. substring both ways → longest key wins.
 * Returns undefined when the snapshot does not know the model — callers
 * fall back to the default window. (Window fix: the resolver previously
 * never consulted the snapshot, so models declared only in models.dev
 * landed on the 128k default.)
 */
export function snapshotContextWindow(modelId: string, providerHint?: string): number | undefined {
  if (!modelId) return undefined;
  const bare = modelId.split("/").pop() ?? modelId;
  const entries: Array<{ key: string; provider: string; bareKey: string; window: number }> = [];
  for (const [k, v] of Object.entries(MODEL_METADATA)) {
    const w = v.contextWindow;
    if (typeof w !== "number" || w <= 0) continue;
    entries.push({ key: k, provider: k.split("/")[0] ?? "", bareKey: k.split("/").pop() ?? k, window: w });
  }
  if (providerHint) {
    const scoped = entries.find((e) => e.provider === providerHint && e.bareKey === bare);
    if (scoped) return scoped.window;
  }
  const exact = entries.filter((e) => e.bareKey === bare);
  if (exact.length === 1) return exact[0].window;
  if (exact.length > 1) {
    const tally = new Map<number, number>();
    for (const e of exact) tally.set(e.window, (tally.get(e.window) ?? 0) + 1);
    let best: { window: number; count: number } | undefined;
    for (const [window, count] of tally) {
      if (
        !best ||
        count > best.count ||
        (count === best.count && window < best.window)
      ) {
        best = { window, count };
      }
    }
    return best?.window;
  }
  let match: { key: string; window: number } | undefined;
  for (const e of entries) {
    if (bare.includes(e.bareKey) || e.bareKey.includes(bare)) {
      if (!match || e.key.length > match.key.length) match = e;
    }
  }
  return match?.window;
}

/** Cost (USD) of a single usage record at a given price. */
export function costForUsage(usage: TokenUsage, price: ModelPrice): number {
  return (
    (usage.promptTokens / 1_000_000) * price.input +
    (usage.completionTokens / 1_000_000) * price.output
  );
}

/** Aggregate all turn/end usages in an event log. */
export function aggregateUsage(events: readonly SessionEvent[]): TokenUsage {
  const out = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const e of events) {
    if (e.type === "turn/end" && e.usage) {
      out.promptTokens += e.usage.promptTokens;
      out.completionTokens += e.usage.completionTokens;
      out.totalTokens += e.usage.totalTokens;
    }
  }
  return out;
}

/**
 * Context size (prompt tokens) at the LAST turn boundary in the log. Used to
 * seed the context-usage counter when resuming a saved session (`-c`) or after
 * a model switch, so the panel reflects history immediately instead of 0 —
 * matching opencode/mimo, which derive the shown number from the restored
 * message list on resume rather than an independent zero-initialized counter.
 *
 * Compaction-aware: if the newest boundary is a compaction event (no LLM turn
 * ran since), use its stamped post-compaction estimate — the last turn/end
 * predates the summary and would flash the stale pre-compaction size.
 * 0 when no completed turn recorded prompt tokens (e.g. a mock-only session).
 */
export function lastContextTokens(
  events: readonly SessionEvent[],
  window = 0,
): { tokens: number; source: "usage" | "estimate" | "none" } {
  // The newest compaction is a hard cutoff: every usage sample older than it
  // describes a conversation that no longer exists. Without this, a bigger
  // window (e.g. switching 200k → 1M) lets a stale pre-compaction sample
  // through the plausibility gate and the panel jumps back to the old size.
  let cutoffSeq = -1;
  let compaction: Extract<SessionEvent, { type: "compaction" }> | undefined;
  for (const e of events) {
    if (e.type === "compaction") {
      cutoffSeq = e.seq;
      compaction = e;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq <= cutoffSeq) break;
    if (e.type !== "turn/end") continue;
    const p = e.usage?.promptTokens;
    if (!sanePromptTokens(p, window)) continue;
    const pnum = p as number;
    const est = estimateContextTokens(events);
    // Trust a server-reported prompt count only while it stays in a sane band
    // around the local estimate. Free-tier gateways report CUMULATIVE/garbage
    // prompt_tokens (observed 949K / 3.2M on a ~78K-token conversation), and
    // the gateway's own window gate (2×window) wrongly green-lights those once
    // the window grows to 1M — flashing a phantom near-full "compact needed".
    // A report more than 3× the local estimate is a cumulative read, not the
    // true request input; the local estimate wins in that direction too (the
    // existing `est > p*1.25` branch already covers the stale-downward case).
    // The reverse guard engages only once the log has genuinely estimable
    // content (est ≥ 100); synthetic/short logs (est≈0) carry no baseline, so
    // the wire number stays the source of truth there. Both drift directions
    // are covered: report ≫ estimate → cumulative/garbage (estimate wins);
    // estimate ≫ report → the log grew past a stale sample (estimate wins).
    return est >= 100 && pnum <= est * 3 && est <= pnum * 1.25 && est <= pnum * 1.25
      ? { tokens: pnum, source: "usage" }
      : est >= 100
        ? { tokens: est, source: "estimate" }
        : { tokens: pnum, source: "usage" };
  }
  if (events.length === 0) return { tokens: 0, source: "none" };
  if (compaction) {
    const stamped = compaction.contextAfter ?? 0;
    return {
      tokens: stamped > 0 ? stamped : estimateContextTokens(events),
      source: "estimate",
    };
  }
  return { tokens: estimateContextTokens(events), source: "estimate" };
}

/**
 * Local context-size estimate (chars÷4 heuristic, pi-style) over exactly what
 * deriveMessages would send: the latest compaction summary plus every event
 * after it. Server-reported promptTokens from free-tier gateways can be
 * garbage (observed 28M on a ~500k-token conversation), so the context panel
 * derives from this instead of trusting the wire numbers.
 */
export function estimateContextTokens(events: readonly SessionEvent[]): number {
  let cutoff = -1;
  let tokens = 0;
  for (const e of events) {
    if (e.type === "compaction") {
      cutoff = e.seq;
      tokens = estimateTokensText(e.summary ?? ""); // earlier summaries are superseded
    }
  }
  for (const e of events) {
    if (e.seq <= cutoff) continue;
    switch (e.type) {
      case "user/message":
        tokens += estimateTokensText(e.text);
        break;
      case "assistant/message":
        tokens +=
          estimateTokensText(e.text) +
          (e.toolCalls ?? []).reduce((n, tc) => n + estimateTokensText(`${tc.name} ${JSON.stringify(tc.args ?? {})}`), 0);
        break;
      case "tool/call":
        tokens += estimateTokensText(`${e.name} ${JSON.stringify(e.args ?? {})}`);
        break;
      case "tool/result":
        tokens += estimateTokensText(truncateToolOutput(JSON.stringify(e.result ?? e.error ?? "")));
        break;
      default:
        break;
    }
  }
  return Math.max(0, tokens);
}

/**
 * Display-trust test for server-reported prompt size: positive and, when the
 * window is known, within 2× of it. Free-tier gateways have returned
 * cumulative/garbage prompt_tokens that would otherwise pin the panel at
 * absurd values (and mis-trigger auto-compaction).
 */
export function sanePromptTokens(n: unknown, window: number): boolean {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return false;
  return window <= 0 || n <= window * 2;
}

/** Cumulative cost (USD) across the whole event log at a given price. */
export function totalCost(
  events: readonly SessionEvent[],
  price: ModelPrice,
): number {
  const u = aggregateUsage(events);
  return costForUsage(u, price);
}

/**
 * Session throughput (tokens/second) = total tokens / wall-clock span of the
 * turn/end events. 0 when there is <2 timestamped turn or no tokens. This is
 * the honest, data-derived "TPS" (average generation throughput over the
 * session) — the mock LLM reports no usage, so it is 0 there.
 */
export function tokensPerSecond(events: readonly SessionEvent[]): number {
  const ts: number[] = [];
  let total = 0;
  for (const e of events) {
    if (e.type === "turn/end") {
      ts.push(e.ts);
      total += e.usage?.totalTokens ?? 0;
    }
  }
  if (ts.length < 2 || total <= 0) return 0;
  const spanSec = (Math.max(...ts) - Math.min(...ts)) / 1000;
  if (spanSec <= 0) return 0;
  return total / spanSec;
}

/**
 * F#30: streaming (per-request) TPS — completion tokens generated per second
 * of real LLM generation time, summed across all streaming turn/end events
 * that carry `genMs`. This is the true per-token throughput (unlike
 * `tokensPerSecond`, which is the session wall-clock average). 0 when no
 * turn recorded generation time (mock / non-streaming).
 */
export function streamingTps(events: readonly SessionEvent[]): number {
  let completion = 0;
  let genMs = 0;
  for (const e of events) {
    if (e.type !== "turn/end") continue;
    if (typeof e.genMs === "number" && e.genMs > 0) {
      genMs += e.genMs;
      completion += e.usage?.completionTokens ?? 0;
    }
  }
  if (genMs <= 0 || completion <= 0) return 0;
  return completion / (genMs / 1000);
}


/**
 * P#41 — prompt-cache hit rate over the session: cached prompt tokens /
 * total prompt tokens across turns that reported a cache figure. 0 when the
 * provider never reports cachedTokens (rate is unobservable, not zero-hit).
 */
export function cacheHitRate(events: readonly SessionEvent[]): number | undefined {
  let cached = 0;
  let prompt = 0;
  for (const e of events) {
    if (e.type !== "turn/end") continue;
    const c = e.usage?.cachedTokens;
    if (typeof c !== "number" || c <= 0) continue;
    cached += c;
    prompt += e.usage?.promptTokens ?? 0;
  }
  if (prompt <= 0) return undefined;
  return Math.min(1, cached / prompt);
}

/** Human cache-rate string: "CH 87%" or "" when unobservable. */
export function fmtCacheRate(rate: number, observedTurns: number): string {
  if (observedTurns === 0) return "";
  return `CH ${Math.round(rate * 100)}%`;
}

/**
 * P#41 — TTL waste attribution. For every turn that reports cache data, ask:
 * "was this turn's cache MISS plausibly caused by the idle gap before it
 * exceeding the provider's prompt-cache TTL?" (Anthropic ~5 min; OpenAI
 * similar order.) The newest reported miss after a gap > ttlMs is attributed
 * to that gap; its uncached prompt tokens are "wasted" full-price reads.
 *
 * Pure and honest about limits: providers report only cached_tokens per turn,
 * not which prefix was served from cache — so this is an attribution
 * heuristic over observable facts (gap length + reported hit), never proof.
 * Returns undefined when no turn reports cache data.
 */
export function cacheTtlWaste(
  events: readonly SessionEvent[],
  opts?: { ttlMs?: number },
): { gaps: number; wastedTokens: number } | undefined {
  const ttl = opts?.ttlMs ?? 5 * 60_000;
  let lastTs: number | undefined;
  let prevPrompt = 0;
  let gaps = 0;
  let wastedTokens = 0;
  let seen = false;
  for (const e of events) {
    if (e.type !== "turn/end") continue;
    const c = e.usage?.cachedTokens;
    if (typeof c === "number" && c > 0) {
      seen = true;
      const prompt = e.usage?.promptTokens ?? 0;
      const uncached = Math.max(0, prompt - c);
      if (
        lastTs !== undefined &&
        typeof e.ts === "number" &&
        e.ts - lastTs > ttl &&
        uncached > 0
      ) {
        // A real cacheable prefix existed (previous turn had tokens), the gap
        // exceeds the TTL, and this turn paid for uncached prompt tokens.
        gaps += 1;
        wastedTokens += Math.min(uncached, prevPrompt || uncached);
      }
    }
    if (typeof e.ts === "number") {
      lastTs = e.ts;
      prevPrompt = e.usage?.promptTokens ?? prevPrompt;
    }
  }
  return seen ? { gaps, wastedTokens } : undefined;
}

/** Human TPS string, e.g. "128 tok/s". */
export function fmtTps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 100) return `${Math.round(n)} tok/s`;
  return `${n.toFixed(1)} tok/s`;
}

/** Human cost string: "$0.0042" for small, "$1.23" for larger. */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

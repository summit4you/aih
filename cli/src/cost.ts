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
  return look(prices ?? {}) ?? look(DEFAULT_PRICES);
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
 * Context size (prompt tokens) at the LAST completed turn in the log. Used to
 * seed the context-usage counter when resuming a saved session (`-c`), so the
 * panel reflects history immediately instead of starting at 0 — matching
 * opencode/mimo, which derive the shown number from the restored message list
 * on resume rather than an independent zero-initialized counter. 0 when no
 * completed turn recorded prompt tokens (e.g. a mock-only session).
 */
export function lastContextTokens(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "turn/end") {
      const p = e.usage?.promptTokens;
      if (typeof p === "number" && p > 0) return p;
    }
  }
  return 0;
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

/** Human cost string: "$0.0042" for small, "$1.23" for larger. */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Human TPS string, e.g. "128 tok/s". */
export function fmtTps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 100) return `${Math.round(n)} tok/s`;
  return `${n.toFixed(1)} tok/s`;
}

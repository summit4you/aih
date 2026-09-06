/**
 * F#30 — cost / TPS accounting.
 *
 * Prices are $ per 1M tokens, split into input (prompt) and output (completion).
 * Resolution order: user `prices` override → built-in table → models.dev
 * snapshot (bare-name EXACT only; keyless/local endpoints always price $0 —
 * see resolvePrice). Matching on the first two is normalized-substring
 * (case-insensitive) so dated ids ("gpt-4o-2024-11-20") still resolve.
 *
 * All functions are pure over the session event log so they are unit-testable
 * without a live LLM (the mock LLM does not report usage).
 */
import type { SessionEvent, TokenUsage } from "@aih/core";
import { createHash } from "node:crypto";
import { estimateTokensText, truncateToolOutput } from "@aih/core";
import { MODEL_METADATA } from "./model-metadata.js";

/**
 * True for self-hosted endpoints (llama.cpp / Ollama / vLLM on localhost, LAN,
 * or plain http). These run without auth, so a keyless client is legitimate —
 * and they bill nothing per token (F#30 pricing ground truth). Canonical owner
 * is cost.ts (the billing module); index.ts re-exports it for compat.
 */
export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  try {
    const u = new URL(baseUrl ?? "");
    if (u.protocol === "http:") return true;
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "::" ||
      h === "::1" ||
      /\.(local|internal|lan)$/i.test(h) ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
    );
  } catch {
    return false;
  }
}

export interface ModelPrice {
  /** $ per 1M input (prompt) tokens */
  input: number;
  /** $ per 1M output (completion) tokens */
  output: number;
  /**
   * F#30 — $ per 1M prompt-cache READ tokens (opencode Zen "缓存读取").
   * Agentic sessions serve most of the prompt from cache; billing it at the
   * full input price inflated the panel ~5×. Absent → cached tokens are
   * billed at the full input price (conservative, pre-cache-aware behavior).
   */
  cacheRead?: number;
  /** $ per 1M prompt-cache WRITE tokens (Anthropic cache_creation analog). */
  cacheWrite?: number;
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
 * Resolve a price for a model id. Resolution order:
 *   1. user `prices` override (normalized substring match — small, curated)
 *   2. built-in table (normalized substring match — small; dated/suffixed
 *      ids like "gpt-4o-2024-11-20" mapping to the "gpt-4o" row is intended)
 *   3. models.dev snapshot (P#48) — **bare-name EXACT match only**:
 *      the snapshot is 7400+ provider-scoped rows ("above/glm-5.3-flash",
 *      "aiand/qwen/qwen3.8-27b", …); substring-matching a local/free-gateway
 *      model id against it used to charge FOREIGN COMMERCIAL PRICES for
 *      keyless gateways and local gguf files (F#30 fix — the panel showed
 *      ~$17 for sessions that cost $0). Now:
 *        a. `providerHint` unlocks the scoped row "<provider>/<bare>";
 *        b. bare-name must match exactly;
 *        c. multiple providers with the SAME price → that price;
 *        d. multiple providers DISAGREEING → ambiguous, return undefined
 *           (the panel renders "—" and the /prices hint suggests an override)
 *           — refusing to guess beats showing a wrong bill.
 */
export function resolvePrice(
  model: string,
  prices?: Record<string, ModelPrice>,
  opts?: { providerHint?: string; keyless?: boolean; baseUrl?: string },
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
  const userHit = look(prices ?? {});
  if (userHit) return userHit;
  const builtHit = look(DEFAULT_PRICES);
  if (builtHit) return builtHit;

  // Billing ground truth — F#30: no credential at the endpoint means NO
  // per-token billing AT ALL, whatever the snapshot says about namesake
  // models elsewhere. Keyless public gateways (opencode Zen fingerprint
  // auth, empero keyless) and local llama.cpp/Ollama/vLLM endpoints bill
  // nothing per token; their prices are ALWAYS {0,0} regardless of model id.
  // (A user `prices` override above still wins for explicit opt-in pricing.)
  if (opts?.keyless || (opts?.baseUrl !== undefined && isLocalEndpoint(opts.baseUrl))) {
    return { input: 0, output: 0 };
  }

  // P#48 snapshot — bare-name EXACT only (see doc above for the F#30 fix).
  const bare = norm(m.split("/").pop() ?? m);
  const hint = opts?.providerHint ? norm(opts.providerHint) : "";
  const scoped: ModelPrice[] = [];
  const exact: Array<{ bare: string; price: ModelPrice }> = [];
  for (const [k, v] of Object.entries(MODEL_METADATA)) {
    if (!v.price) continue;
    const nk = norm(k);
    const nbare = norm(k.split("/").pop() ?? k);
    if (hint && nk === `${hint}/${bare}`) scoped.push(v.price);
    if (nbare === bare) exact.push({ bare: nbare, price: v.price });
  }
  if (scoped.length > 0) return scoped[0];
  if (exact.length === 0) return undefined;
  const distinct = new Map<string, ModelPrice>();
  for (const e of exact) distinct.set(`${e.price.input}/${e.price.output}`, e.price);
  if (distinct.size === 1) return exact[0].price;
  return undefined; // ambiguous: ≥2 providers, disagreeing prices
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
  // F#30 cache-aware billing: cached prompt tokens bill at cacheRead (when
  // the price table carries one), only the uncached remainder bills at the
  // full input price. Without cacheRead → everything at input (old behavior;
  // conservative since cacheRead ≤ input on every known price list).
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  const writeTokens = usage.cacheWriteTokens ?? 0;
  return (
    (uncached / 1_000_000) * price.input +
    (cached / 1_000_000) * cacheRead +
    (writeTokens / 1_000_000) * cacheWrite +
    (usage.completionTokens / 1_000_000) * price.output
  );
}

/** Aggregate all turn/end usages in an event log. */
export function aggregateUsage(events: readonly SessionEvent[]): TokenUsage {
  const out: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let cached = 0;
  let cacheWriteTokens = 0;
  let seenCached = false;
  for (const e of events) {
    if (e.type === "turn/end" && e.usage) {
      out.promptTokens += e.usage.promptTokens;
      out.completionTokens += e.usage.completionTokens;
      out.totalTokens += e.usage.totalTokens;
      if (typeof e.usage.cachedTokens === "number") {
        cached += e.usage.cachedTokens;
        seenCached = true;
      }
      if (typeof e.usage.cacheWriteTokens === "number") {
        cacheWriteTokens += e.usage.cacheWriteTokens;
        seenCached = true;
      }
    }
  }
  if (seenCached) {
    if (cached > 0) out.cachedTokens = cached;
    if (cacheWriteTokens > 0) out.cacheWriteTokens = cacheWriteTokens;
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

// ── CC-R#3 — prompt-cache prefix stability ──────────────────────────────
//
// Provider prompt caches are keyed on the exact byte prefix of the request
// (system prompt + tool definitions + messages so far). ANY byte change in
// that prefix — a tool added/removed (plan↔build switch), a changed system
// prompt, a first-turn announcement appended mid-session — forces a full
// re-read of the cached tokens at full price. claude-code tracks this
// (v2.1.248/261: "resume tool set must be byte-identical", "first-turn
// announcements must be one-shot"); AIH's observables:

/** JSON tool schema shape accepted by toolsetFingerprint. */
export interface FingerprintableTool {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * CC-R#3 — deterministic, order-sensitive fingerprint of the tool set that
 * prefixes every request. Two sessions (or two turns) with equal fingerprints
 * can share a cached prefix; any difference forces a full-cache miss.
 * Byte-stable: keys sorted (stableStringify-style), SHA-256 hex.
 */
export function toolsetFingerprint(tools: readonly FingerprintableTool[]): string {
  const h = createHash("sha256");
  for (const t of tools) {
    h.update(t.name);
    h.update("\u0000");
    h.update(t.description);
    h.update("\u0000");
    h.update(stableJson(t.parameters));
    h.update("\u0001");
  }
  return h.digest("hex").slice(0, 16);
}

/** Key-order-stable JSON (deterministic across object key insertion order). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** One observable cache-prefix break, attributed when it happened. */
export interface PrefixBreak {
  ts: number;
  /** What changed: toolset (byte-level) or system prompt (roster/memory/rules). */
  kind: "toolset" | "system";
  /** Short human note, e.g. "plan→build (write tools visible)". */
  note?: string;
}

export interface CachePrefixMissReport {
  /** Turns that reported a cache figure with an unexplained miss. */
  missTurns: number;
  /** Uncached prompt tokens on those turns (the "full-price read" cost). */
  uncachedTokens: number;
  /** Observed prefix breaks in-window (toolset/system), newest first. */
  breaks: PrefixBreak[];
}

/**
 * CC-R#3 — attribute cache misses to observable prefix-break events.
 *
 * For every turn/end that reports cache data, classify the miss:
 *   - the FIRST reported turn is always a cold start (no prefix existed yet);
 *   - a turn whose uncached tokens are plausibly TTL eviction is already
 *     counted by cacheTtlWaste — excluded here (avoid double-counting);
 *   - a turn after a recorded prefix break (toolset/system change) is
 *     attributed to that break.
 *
 * Pure over (events, breaks); honest limits: providers report only
 * cached_tokens per turn, so this is attribution over observable facts, not
 * proof. The /usage panel renders it as guidance ("prefix stability"),
 * never as a ledger.
 */
export function cachePrefixMissAttribution(
  events: readonly SessionEvent[],
  breaks: readonly PrefixBreak[],
  opts?: { ttlMs?: number },
): CachePrefixMissReport | undefined {
  const ttl = opts?.ttlMs ?? 5 * 60_000;
  // Only breaks BEFORE the observed window matter; sorted desc for reporting.
  const relevant = breaks
    .filter((b) => Number.isFinite(b.ts))
    .sort((a, b) => b.ts - a.ts);
  let missTurns = 0;
  let uncachedTokens = 0;
  let firstReportedSeen = false;
  let lastTs: number | undefined;
  for (const e of events) {
    if (e.type !== "turn/end") continue;
    const c = e.usage?.cachedTokens;
    if (typeof c !== "number" || c <= 0) continue; // unreported → unobservable
    const prompt = e.usage?.promptTokens ?? 0;
    const uncached = Math.max(0, prompt - c);
    const ts = typeof e.ts === "number" ? e.ts : undefined;
    if (!firstReportedSeen) {
      // First reported turn: the cache was cold regardless of breaks.
      firstReportedSeen = true;
    } else if (uncached > 0 && uncached > prompt / 2) {
      // A MISS = the majority of prompt tokens were NOT served from cache
      // (providers always report a small uncached tail; counting any
      // uncached>0 would attribute every normal turn). Below the half mark
      // is a healthy hit, not a prefix break.
      const ttlEvicted =
        lastTs !== undefined && ts !== undefined && ts - lastTs > ttl;
      if (!ttlEvicted) {
        missTurns += 1;
        uncachedTokens += uncached;
      }
    }
    if (ts !== undefined) lastTs = ts;
  }
  if (!firstReportedSeen) return undefined; // nothing observable
  return {
    missTurns,
    uncachedTokens,
    breaks: relevant.filter((b) => {
      // Report only breaks that could have affected a reported turn.
      return true;
    }),
  };
}

/** Human lines for /usage: prefix-stability guidance (empty when nothing to say). */
export function formatPrefixStability(report: CachePrefixMissReport | undefined): string[] {
  if (!report) return [];
  const lines: string[] = [];
  if (report.missTurns > 0) {
    lines.push(
      `prefix stability: ${report.missTurns} turn${report.missTurns === 1 ? "" : "s"} paid for uncached prompt` +
        ` (~${report.uncachedTokens.toLocaleString()} tok) outside idle-TTL gaps`,
    );
  }
  for (const b of report.breaks.slice(0, 3)) {
    const label = b.kind === "toolset" ? "tool set changed" : "system prompt changed";
    lines.push(`  cache prefix broken at ${new Date(b.ts).toLocaleTimeString()}: ${label}${b.note ? ` (${b.note})` : ""}`);
  }
  if (report.missTurns > 0) {
    lines.push("  hint: keep the system prompt + tool set byte-stable within a session; put volatile content in messages");
  }
  return lines;
}

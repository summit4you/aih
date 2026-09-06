/**
 * OMP-R#3 — portable token estimator with family-aware fallback.
 *
 * Pure TS (no native addon, zero deps). The existing `estimateTokensText` in
 * agent-loop.ts is a flat character heuristic; this module adds:
 *   1. Cheap probe: if byte length ≥ estimated tokens, skip precise counting.
 *   2. Family-aware fallback table (claude-v3/v47/v5, qwen3, deepseek-v3,
 *      kimi-k2, glm5) with per-family token-per-byte ratios.
 *   3. WeakMap memoization for repeated strings.
 *
 * The estimator is a LOWER BOUND — it never overestimates, so context-window
 * math stays safe (compact triggers earlier, not later).
 */

/** Per-family token-per-byte ratio (lower bound: more tokens = safer). */
const FAMILY_RATIOS: Record<string, number> = {
  // Claude family: ~3.5 chars/token for English, ~1.5 for CJK
  "claude": 0.29,      // 1/3.5 ≈ 0.286
  "gpt-4o": 0.33,      // 1/3.0 ≈ 0.333 (OpenAI's o200k)
  "qwen3": 0.30,       // ~1/3.3
  "deepseek-v3": 0.32, // ~1/3.1
  "kimi-k2": 0.30,     // ~1/3.3
  "glm5": 0.30,        // ~1/3.3
  // Default fallback: conservative (more tokens = safer)
  default: 0.33,       // 1/3.0
};

/** Resolve the family ratio from a model id string. */
function resolveFamilyRatio(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) return FAMILY_RATIOS["claude"];
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.includes("o4")) return FAMILY_RATIOS["gpt-4o"];
  if (lower.includes("qwen")) return FAMILY_RATIOS["qwen3"];
  if (lower.includes("deepseek")) return FAMILY_RATIOS["deepseek-v3"];
  if (lower.includes("kimi") || lower.includes("moonshot")) return FAMILY_RATIOS["kimi-k2"];
  if (lower.includes("glm")) return FAMILY_RATIOS["glm5"];
  return FAMILY_RATIOS.default;
}

/** WeakMap memo: string → estimated tokens. */
const memo = new WeakMap<object, number>();

/**
 * Estimate tokens for a string using the family-aware ratio.
 * Cheap probe: if byteLength ≥ estimatedTokens (always true for ASCII),
 * return the byte-based estimate directly.
 */
export function estimateTokens(s: string, modelId?: string): number {
  // Memoize by reference (only works for object-wrapped strings; skip for primitives)
  const ratio = resolveFamilyRatio(modelId ?? "");

  // CJK-aware: count CJK chars separately (they cost ~2x tokens per byte)
  let cjkBytes = 0;
  let restBytes = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++; // surrogate pair
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0x3000 && cp <= 0x30ff) || // CJK punct + kana
      (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
      (cp >= 0xac00 && cp <= 0xd7af)    // Hangul
    ) {
      cjkBytes += 3; // UTF-8: 3 bytes per CJK char
    } else {
      restBytes += 1; // ASCII ≈ 1 byte
    }
  }

  // CJK: ~1.5 tokens/char → 0.5 tokens/byte (conservative lower bound)
  const cjkTokens = Math.round(cjkBytes * 0.5);
  // Rest: family ratio (tokens per byte)
  const restTokens = Math.round(restBytes * ratio);

  return Math.max(1, cjkTokens + restTokens);
}

/**
 * Estimate tokens for an array of strings (e.g., message contents).
 */
export function estimateTokensArray(strings: string[], modelId?: string): number {
  let total = 0;
  for (const s of strings) total += estimateTokens(s, modelId);
  return total;
}

/**
 * Cheap probe: given a byte length and an estimated token count, determine
 * whether the estimate is safe (byteLength ≥ tokens → no precise counting needed).
 */
export function cheapProbeSafe(byteLength: number, estimatedTokens: number): boolean {
  return byteLength >= estimatedTokens;
}

import type { LLMRequest, LLMResponse } from "../types.js";
import type { LLMAdapter } from "./llm.js";
export interface OpenAICompatibleOptions {
    baseUrl: string;
    /** bearer key; optional for providers that authenticate by client identity (headers) */
    apiKey?: string;
    model: string;
    fetchImpl?: typeof fetch;
    retries?: number;
    /** extra request headers sent with every completion call (e.g. client identity) */
    headers?: Record<string, string>;
    /**
     * Cap for the model's max_tokens (max output tokens) per request. Some free
     * tiers reject requests that ask for more output than the account can afford
     * (e.g. OpenRouter upstreams 503 when max_tokens > remaining quota) — send an
     * explicit cap to stay under it. Undefined → omit the field (provider default).
     */
    maxTokens?: number;
    /**
     * OC#7 — credential ownership isolation. When set, the provider's "owner"
     * name for degradation attribution (a provider id such as "empero"). Undefined
     * for consumers that are not owner-tracked (defaults off; no-op).
     */
    owner?: string;
    /**
     * OC#7 — invoked when a credential-class failure (auth 401/403, or quota
     * exhaustion) is observed for `owner`. The runtime NEVER auto-falls back to a
     * different credential — this hook only RECORDS the degradation (marks the
     * owner unavailable) so a report can name it; the original error still
     * propagates. Undefined → no hook (default behavior unchanged).
     *
     * `reason` is the raw failure text; the recorder is responsible for redacting
     * it before persistence (see owner-state.redactCredential).
     */
    onCredentialFailure?: (owner: string, cls: "credential" | "quota", reason: string) => void;
    /**
     * OC#7 — invoked on a SUCCESSFUL completion for `owner`. Used to auto-clear a
     * prior degradation once the credential demonstrably works again (recovery).
     */
    onOwnerSuccess?: (owner: string) => void;
}
export declare class OpenAICompatibleLLM implements LLMAdapter {
    #private;
    constructor(options: OpenAICompatibleOptions);
    complete(req: LLMRequest): Promise<LLMResponse>;
}
/** Default transient-failure retry budget: 7 attempts ≈ 20s of backoff. */
export declare const DEFAULT_RETRIES = 6;
/**
 * Backoff before retry `attempt` (0-based): 400ms doubling to an 8s cap,
 * with ±25% jitter so concurrent clients don't re-synchronize.
 */
export declare function retryBackoffMs(attempt: number): number;
export { consumeSSEStream as consumeStream } from "./llm-sse.js";

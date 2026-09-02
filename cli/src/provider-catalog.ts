/**
 * Connectable provider catalog for `aih connect` / `/connect`.
 *
 * Mirrors opencode's `/connect` (DialogProviderList) but scoped to what AIH's
 * OpenAI-compatible LLM adapter can actually talk to:
 *   - Providers whose chat-completions endpoint IS OpenAI-compatible are listed
 *     with their stable baseUrl + env var name + a sensible default model.
 *   - Providers that require a NATIVE SDK (anthropic, google, cohere, …) are
 *     NOT listed — the adapter cannot speak their protocol. Add them through
 *     "Other" only if you have an OpenAI-compatible gateway for them.
 *
 * The catalog is a curated, bounded snapshot (models.dev has 172
 * openai-compatible providers — far too many to inline). "Popular" entries are
 * the ones most users actually want; baseUrls/env/default-model follow the
 * provider's official docs. `connectCatalog()` returns them in opencode-style
 * priority order (popular first, then alphabetical), plus an "Other" custom
 * entry handled by the caller.
 */

export interface CatalogProvider {
  /** provider id used in aih.json `providers.<id>` (lowercase, hyphenated) */
  id: string;
  /** display name (opencode models.dev `name`) */
  name: string;
  /** OpenAI-compatible base URL */
  baseUrl: string;
  /** env var that holds the API key */
  apiKeyEnv: string;
  /** a sensible default model id served by that endpoint */
  defaultModel: string;
  /** optional extra context window (tokens) for the default model */
  contextWindow?: number;
  /** optional per-provider extra headers (e.g. client identity) */
  headers?: Record<string, string>;
  /** extra models the user may pick from (beyond defaultModel) */
  models?: string[];
}

/** Providers whose chat-completions endpoint is OpenAI-compatible. */
const CATALOG: CatalogProvider[] = [
  // ---- Popular (opencode /connect priority order) ----
  { id: "opencode", name: "OpenCode", baseUrl: "https://opencode.ai/zen/v1", apiKeyEnv: "OPENCODE_API_KEY", defaultModel: "big-pickle", models: ["big-pickle", "hy3-free", "mimo-v2.5-free", "x-preview-f-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "laguna-s-2.1-free"] },
  { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1", apiKeyEnv: "OPENCODE_API_KEY", defaultModel: "deepseek-v4-flash", models: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.3-flash", "glm-5.3", "kimi-k2.7-code", "kimi-k3", "qwen3.7-max", "qwen3.8-max", "mimo-v2.5", "minimax-m3", "gpt-5.6-luna"] },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o", models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o1", "o1-mini"] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "openai/gpt-4o", models: ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash", "deepseek/deepseek-chat"] },
  { id: "github-copilot", name: "GitHub Copilot", baseUrl: "https://api.githubcopilot.com/v1", apiKeyEnv: "GITHUB_COPILOT_API_KEY", defaultModel: "gpt-4.1", models: ["gpt-4.1", "claude-sonnet-4"] },

  // ---- OpenAI-compatible first-party ----
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-small-latest", models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"] },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "grok-4", models: ["grok-4", "grok-4-fast"] },
  { id: "moonshotai", name: "Moonshot AI (Kimi)", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "kimi-k2.5", models: ["kimi-k2.5", "kimi-k2-turbo-preview", "moonshot-v1-8k"] },
  { id: "zhipuai", name: "Zhipu AI (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", defaultModel: "glm-4-flash", models: ["glm-4-flash", "glm-4-plus", "glm-4-air"] },
  { id: "alibaba", name: "Alibaba (Qwen, intl)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
  { id: "alibaba-cn", name: "Alibaba (Qwen, CN)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
  { id: "siliconflow", name: "SiliconFlow (intl)", baseUrl: "https://api.siliconflow.com/v1", apiKeyEnv: "SILICONFLOW_API_KEY", defaultModel: "deepseek-ai/DeepSeek-V3", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
  { id: "siliconflow-cn", name: "SiliconFlow (CN)", baseUrl: "https://api.siliconflow.cn/v1", apiKeyEnv: "SILICONFLOW_CN_API_KEY", defaultModel: "deepseek-ai/DeepSeek-V3", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },

  // ---- OpenAI-compatible aggregators / infra ----
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"] },
  { id: "fireworks-ai", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1/", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", models: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/deepseek-v3"] },
  { id: "novita-ai", name: "NovitaAI", baseUrl: "https://api.novita.ai/openai", apiKeyEnv: "NOVITA_API_KEY", defaultModel: "deepseek/deepseek-v3", models: ["deepseek/deepseek-v3", "meta-llama/llama-3.3-70b-instruct"] },
  { id: "huggingface", name: "Hugging Face (Inference)", baseUrl: "https://router.huggingface.co/v1", apiKeyEnv: "HF_TOKEN", defaultModel: "Qwen/Qwen2.5-72B-Instruct", models: ["Qwen/Qwen2.5-72B-Instruct", "meta-llama/Llama-3.3-70B-Instruct"] },
  { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1", models: ["nvidia/llama-3.3-nemotron-super-49b-v1", "nvidia/nemotron-3-nano-30b-a3b"] },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "gpt-oss-120b", models: ["gpt-oss-120b"] },
  { id: "perplexity", name: "Perplexity", baseUrl: "https://api.perplexity.ai", apiKeyEnv: "PERPLEXITY_API_KEY", defaultModel: "sonar", models: ["sonar", "sonar-pro"] },
  { id: "digitalocean", name: "DigitalOcean", baseUrl: "https://inference.do-ai.run/v1", apiKeyEnv: "DIGITALOCEAN_ACCESS_TOKEN", defaultModel: "openai-gpt-5.2-pro", models: ["openai-gpt-5.2-pro"] },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1", apiKeyEnv: "CLOUDFLARE_API_KEY", defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] },

  // ---- Local / self-hosted (OpenAI-compatible) ----
  { id: "ollama", name: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "OLLAMA_API_KEY", defaultModel: "llama3.1", models: ["llama3.1", "qwen2.5"], headers: {} },
  { id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "LMSTUDIO_API_KEY", defaultModel: "local-model", models: [] },
  { id: "vllm", name: "vLLM (local)", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "VLLM_API_KEY", defaultModel: "local-model", models: [] },
];

/** opencode-style priority: popular first (opencode→openai→openrouter→github-copilot), then alphabetical by name. */
export function connectCatalog(): CatalogProvider[] {
  // opencode /connect priority (from the opencode repo): OpenCode Zen, OpenAI,
  // OpenRouter, GitHub Copilot — the rest alphabetical by name. The popular set
  // keeps opencode's exact order, NOT a name sort.
  const popularOrder = ["opencode", "opencode-go", "openai", "openrouter", "github-copilot"];
  const byId = new Map(CATALOG.map((p) => [p.id, p]));
  const popular = popularOrder
    .map((id) => byId.get(id))
    .filter((p): p is CatalogProvider => p !== undefined);
  const rest = CATALOG.filter((p) => !popularOrder.includes(p.id)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return [...popular, ...rest];
}

/** Look up a catalog entry by id; undefined for unknown id. */
export function catalogEntry(id: string): CatalogProvider | undefined {
  return CATALOG.find((p) => p.id === id);
}
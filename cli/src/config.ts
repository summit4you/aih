import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PermissionRule } from "@aih/core";
import { checkSchemaVersion, CONFIG_SCHEMA_VERSION, stampConfigVersion } from "@aih/core";
import type { Policy } from "./policies.js";
import { loadPolicies, providerAllowed } from "./policies.js";
import { userAihDir, userAihDirs } from "./paths.js";
import { readJson } from "./read-json.js";
import { loadEnvSafety, mergeSafety } from "./safety.js";
import type { SafetyConfig } from "./safety.js";

/**
 * Global (user-level) config file. Resolves through the XDG data dir
 * (AIH_HOME > $XDG_DATA_HOME/aih > ~/.local/share/aih, with ~/.aih legacy
 * read-compat) — see paths.ts.
 */
function globalConfigPath(): string {
  return join(userAihDir(), "config.json");
}

/**
 * Ordered global config file candidates: the primary (XDG-resolved) path first
 * — even if not yet present, so writes land there — then any existing legacy
 * `~/.aih/config.json`. All are read (primary wins per-key on merge).
 */
function globalConfigCandidates(): string[] {
  const primary = join(userAihDir(), "config.json");
  const out = [primary];
  for (const d of userAihDirs()) {
    const p = join(d, "config.json");
    if (p !== primary && existsSync(p)) out.push(p);
  }
  return out;
}

export interface ProviderConfig {
  baseUrl?: string;
  model?: string;
  /**
   * Additional selectable models for this provider (beyond the primary
   * `model`). All share the provider's baseUrl/headers/apiKeyEnv; each shows
   * up as its own entry in the ctrl-p model picker / `aih models`.
   *
   * Entries are usually plain model-id strings; the object form
   * `{ model, contextWindow }` (F#34) declares a per-model context window
   * that overrides the provider-level `contextWindow` for that model only.
   * Both forms can be mixed freely.
   */
  models?: Array<string | ModelEntry>;
  apiKeyEnv?: string;
  /**
   * Mark this provider as keyless (no API key required). Use for public free
   * endpoints (HTTPS) that need no auth — otherwise buildRealLlm refuses to
   * start without a key, since only local/http endpoints and identity-header
   * providers are exempt automatically.
   */
  keyless?: boolean;
  /** context window (max input tokens) for this provider's model */
  contextWindow?: number;
  /**
   * Cap for max_tokens (max output tokens) sent per request. Free tiers that
   * reject large max_tokens (OpenRouter 503 "can only afford N") need this.
   */
  maxTokens?: number;
  /** extra request headers for this provider (e.g. client identity for rate-limit pools) */
  headers?: Record<string, string>;
}

/** F#34 — object form of one `providers.<name>.models[]` entry. */
export interface ModelEntry {
  /** model id served by that provider */
  model: string;
  /** per-model context window; overrides the provider-level value */
  contextWindow?: number;
  /**
   * per-model max output tokens; overrides the provider-level `maxTokens`
   * for this model only. Some providers cap output per model (e.g. zhipu's
   * glm-4v-flash rejects max_tokens > 1024 while glm-4-flash accepts more) —
   * the model-level value lets both share one provider entry.
   */
  maxTokens?: number;
}

export interface McpServerConfig {
  /** server command (first token) */
  command: string;
  /** extra args after the command */
  args?: string[];
  /** optional display name; defaults to the command basename */
  name?: string;
  /** when true, disable this server entry */
  enabled?: boolean;
}

export interface AihConfig {
  /**
   * OC#5 — schema version of this config file. Absent on legacy files (accepted
   * for backward compat); present when written by a versioning build. A build
   * refuses to open a config whose schemaVersion exceeds its own max
   * (CONFIG_SCHEMA_VERSION) — fail-closed, loud, never silent.
   */
  schemaVersion?: number;
  model?: string;
  baseUrl?: string;
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  /** multiple MCP servers (stdio) connected side-by-side and merged */
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: PermissionRule[];
  /**
   * CC#54 — auto-approve provably read-only run_cmd commands (deterministic
   * prefix whitelist, see cli/src/readonly-allow.ts) when the ruleset has no
   * explicit rule. Off by default; explicit `false` in a later layer wins.
   */
  autoAllowReadonly?: boolean;
  /** context window (max input tokens); per-provider value wins for that provider */
  contextWindow?: number;
  /**
   * F#30 — model price table ($ per 1M tokens, { input, output }).
   * Keys are model-id substrings; user values override the built-in table.
   * e.g. { "gpt-4o": { "input": 2.5, "output": 10 } }
   */
  prices?: Record<string, { input: number; output: number }>;
  /** external skill registry (opencode-compatible index.json base URL(s)) */
  skills?: { registry?: string | string[] };
  /**
   * opencode `policies` parity — control which configured resources (LLM
   * providers) AIH may use. A provider denied by policy is not available for
   * model selection or use, even if configured. Last matching statement wins.
   *   { "policies": [ { "effect":"deny", "action":"provider.use", "resource":"openai" } ] }
   */
  policies?: Policy[];
  /**
   * opencode `rules` parity — extra instruction files (paths, globs, or remote
   * URLs) merged into the system prompt alongside AGENTS.md / CLAUDE.md.
   * e.g. ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]
   */
  instructions?: string[];
  /**
   * E#18 — named agent profiles: `--as <name>` selects one. A profile carries
   * its own permission rules (applied on top of the base ruleset) and an
   * optional extra system-prompt line. e.g.
   *   { "agents": { "readonly": { "prompt": "You are read-only.",
   *        "permissions": [{ "tool": "*", "action": "deny" }] } }
   */
  agents?: Record<string, AgentProfile>;
  /**
   * PE#1/PE#2 — safety seam (harness enforces, not the model):
   *   - `budget`: hard constraints + tripwire —
   *     { "maxCostUsd": 1, "maxWrites": 50, "timeoutMs": 3600000,
   *       "denyPaths": ["node_modules", ".git"] }
   *   - `sensors`: computational 写后验证 — a command runs after successful
   *     writes; red → bounded retry feedback; final red → escalate.
   *     [{ "name": "typecheck", "command": "npx tsc -b",
   *        "onTools": ["write_file","edit","apply_patch"], "timeoutMs": 60000 }]
   *   - `sensorRetries`: red retries before escalation (default 1).
   * Env overrides: AIH_BUDGET / AIH_SENSORS / AIH_SENSOR_RETRIES.
   */
  safety?: {
    budget?: {
      maxCostUsd?: number;
      maxWrites?: number;
      timeoutMs?: number;
      denyPaths?: string[];
    };
    sensors?: Array<{
      name: string;
      onTools?: string[];
      pathPrefix?: string;
      command: string;
      timeoutMs?: number;
    }>;
    sensorRetries?: number;
  };
}

export interface AgentProfile {
  /** extra system-prompt line injected for this profile (optional) */
  prompt?: string;
  /** permission rules for this profile (appended after the base ruleset) */
  permissions?: PermissionRule[];
}

export interface ConfigLayer {
  path: string;
  config: AihConfig;
}

export interface ResolvedValue {
  value: string | undefined;
  source: string;
}

export interface ResolvedLlm {
  model: ResolvedValue;
  baseUrl: ResolvedValue;
  apiKeyEnv: string;
  provider: string | undefined;
  keyless: boolean;
  maxTokens?: number;
  contextWindow: ResolvedValue;
  headers: Record<string, string>;
  layers: ConfigLayer[];
}

const PROJECT_CONFIG_FILES = ["aih.json", ".aih/config.json"];

function readConfig(path: string): AihConfig {
  if (!existsSync(path)) return {};
  let cfg: AihConfig;
  try {
    cfg = readJson<AihConfig>(path);
  } catch (err) {
    throw new Error(
      `invalid config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // OC#5 — refuse to open a config newer than this build (fail-closed, loud).
  checkSchemaVersion(cfg.schemaVersion, CONFIG_SCHEMA_VERSION, "config", path);
  return cfg;
}

/**
 * OC#5 — write a config file, stamping the current schema version so a future
 * (newer) build can detect it and an older build can refuse to open it.
 */
function writeConfigFile(path: string, cfg: AihConfig): void {
  const stamped = stampConfigVersion(cfg as unknown as Record<string, unknown>) as AihConfig;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
}

export function loadLayers(): ConfigLayer[] {
  const layers: ConfigLayer[] = [];
  // Global (user-level) config: legacy `~/.aih/config.json` first, then the
  // primary XDG dir — `fromLayers` reads from the end of the array, so the
  // primary (pushed last) wins per-key over the legacy copy.
  const primary = join(userAihDir(), "config.json");
  for (const dir of userAihDirs()) {
    const p = join(dir, "config.json");
    if (p === primary) continue;
    const cfg = readConfig(p);
    if (Object.keys(cfg).length > 0) layers.push({ path: p, config: cfg });
  }
  const primaryCfg = readConfig(primary);
  if (Object.keys(primaryCfg).length > 0) layers.push({ path: primary, config: primaryCfg });
  // P#40 trust gate: project layers (aih.json / .aih/config.json) load only
  // when this directory is trusted. Untrusted → project files are invisible
  // to config resolution; a warning surfaces via projectTrustState().
  if (projectTrustState() === "trusted") {
    for (const name of PROJECT_CONFIG_FILES) {
      const projectPath = join(process.cwd(), name);
      const project = readConfig(projectPath);
      if (Object.keys(project).length > 0) layers.push({ path: projectPath, config: project });
    }
  }
  return layers;
}

/**
 * P#40 — module-level trust state, set once at CLI startup from the
 * resolveTrust flow. "trusted" → project config layers load normally;
 * anything else → they are skipped (fail closed). Kept as state rather than
 * an async check inside loadLayers because loadLayers is sync and called in
 * many hot paths.
 */
let _trustState: "trusted" | "untrusted" | "unset" =
  process.env.AIH_TRUST_ALL_PROJECTS === "1" ? "trusted" : "unset";

export function setProjectTrustState(s: "trusted" | "untrusted"): void {
  _trustState = s;
}

export function projectTrustState(): "trusted" | "untrusted" | "unset" {
  return _trustState;
}

function merged(layers: ConfigLayer[]): AihConfig {
  const out: AihConfig = {};
  for (const { config } of layers) Object.assign(out, config);
  return out;
}

/** F#34 — per-model context window declared on the active provider's
 *  `models[]` entry (`{ model, contextWindow }` object form). Later layers
 *  override earlier ones; plain string entries and other providers are
 *  ignored. */
function modelLevelWindow(
  layers: ConfigLayer[],
  providerName: string | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!providerName || !modelId) return undefined;
  let found: number | undefined;
  for (const { config } of layers) {
    const p = config.providers?.[providerName];
    if (!p?.models) continue;
    for (const e of normalizeModelEntries(p.models)) {
      if (e.id === modelId && e.contextWindow !== undefined) found = e.contextWindow;
    }
  }
  return found;
}

/** F#34 — normalize a provider's `models[]` into ids plus optional per-model
 *  context windows (and F: multi-model maxTokens). Accepts the legacy string
 *  form and the `{ model, contextWindow, maxTokens }` object form; malformed
 *  entries are skipped silently so a single bad line can't break catalog
 *  loading. */
export function normalizeModelEntries(
  models: Array<string | ModelEntry> | undefined,
): Array<{ id: string; contextWindow?: number; maxTokens?: number }> {
  const out: Array<{ id: string; contextWindow?: number; maxTokens?: number }> = [];
  for (const m of models ?? []) {
    if (typeof m === "string") {
      if (m.trim()) out.push({ id: m });
      continue;
    }
    if (m && typeof m === "object" && typeof (m as ModelEntry).model === "string" && (m as ModelEntry).model.trim()) {
      const cw = (m as ModelEntry).contextWindow;
      const mt = (m as ModelEntry).maxTokens;
      out.push({
        id: ((m as ModelEntry).model),
        ...(typeof cw === "number" && Number.isFinite(cw) && cw > 0 ? { contextWindow: cw } : {}),
        ...(typeof mt === "number" && Number.isFinite(mt) && mt > 0 ? { maxTokens: mt } : {}),
      });
    }
  }
  return out;
}

/** per-model max output tokens declared on the active provider's `models[]`
 *  entry (object form). Later layers override earlier ones; plain string
 *  entries and other providers are ignored. */
function modelLevelMaxTokens(
  layers: ConfigLayer[],
  providerName: string | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!providerName || !modelId) return undefined;
  let found: number | undefined;
  for (const { config } of layers) {
    const p = config.providers?.[providerName];
    if (!p?.models) continue;
    for (const e of normalizeModelEntries(p.models)) {
      if (e.id === modelId && e.maxTokens !== undefined) found = e.maxTokens;
    }
  }
  return found;
}

function fromLayers(
  layers: ConfigLayer[],
  read: (cfg: AihConfig) => string | undefined,
): ResolvedValue {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const value = read(layers[i].config);
    if (value !== undefined) return { value, source: layers[i].path };
  }
  return { value: undefined, source: "unset" };
}

/** F#30 — merged `prices` table from all config layers (user overrides win). */
export function loadPrices(): Record<string, { input: number; output: number }> | undefined {
  const layers = loadLayers();
  let out: Record<string, { input: number; output: number }> | undefined;
  for (const { config } of layers) {
    if (config.prices) out = { ...(out ?? {}), ...config.prices };
  }
  return out;
}

/**
 * PE#1/PE#2 — merged `safety` block across config layers (later layers win
 * per-key), then env overrides (AIH_BUDGET / AIH_SENSORS / AIH_SENSOR_RETRIES
 * win over the file). The CLI wires the result into the AgentLoop; absent
 * config → `{}` (the loop no-ops the safety seam).
 */
export function loadSafety(): SafetyConfig {
  let file: SafetyConfig = {};
  for (const { config } of loadLayers()) {
    const s = config.safety;
    if (!s) continue;
    file = mergeSafety(file, s);
  }
  // env wins over the file layer
  return mergeSafety(file, loadEnvSafety());
}

export function loadPermissionRules(): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const layer of loadLayers()) {
    for (const rule of layer.config.permissions ?? []) out.push(rule);
  }
  return out;
}

/**
 * CC#54 — merged `autoAllowReadonly` across config layers. Later layers win
 * per-key (explicit `false` disables an earlier `true`); default off.
 */
export function loadAutoAllowReadonly(): boolean {
  let out = false;
  for (const { config } of loadLayers()) {
    if (typeof config.autoAllowReadonly === "boolean") out = config.autoAllowReadonly;
  }
  return out;
}

/** E#18 — load the named agent profile `name` (merged across layers; later
 *  layers override per-key). Returns undefined if the profile is unknown. */
export function loadAgentProfile(name: string): AgentProfile | undefined {
  let out: AgentProfile | undefined;
  for (const { config } of loadLayers()) {
    const p = config.agents?.[name];
    if (p) out = { ...out, ...p, permissions: [...(out?.permissions ?? []), ...(p.permissions ?? [])] };
  }
  return out;
}

/** E#18 — list the configured agent profile names (for `aih agents`). */
export function listAgentProfiles(): string[] {
  const names = new Set<string>();
  for (const { config } of loadLayers()) {
    for (const n of Object.keys(config.agents ?? {})) names.add(n);
  }
  return [...names].sort();
}

export interface ResolvedServer {
  /** null means "use config mcpServers (multi)"; the array holds the expanded servers */
  servers: { name: string; command: string; args: string[] }[] | null;
  /** human-readable description of what was resolved */
  label: string;
}

/**
 * Resolve the backend(s) to connect: `--server` flag wins (single server);
 * otherwise merge configured `mcpServers` from aih.json; otherwise the
 * bundled todo-app server (single).
 */
export function resolveServers(opts: {
  flagServer?: string;
  bundled: { command: string; args: string[] };
}): ResolvedServer {
  if (opts.flagServer) {
    const parts = opts.flagServer.split(/\s+/).filter(Boolean);
    const name = parts[0]?.split(/\//).pop() ?? "custom";
    return { servers: [{ name, command: parts[0], args: parts.slice(1) }], label: `flag --server ${opts.flagServer}` };
  }
  const configured = loadMcpServers();
  const entries = Object.entries(configured).filter(([, cfg]) => cfg.enabled !== false);
  if (entries.length > 0) {
    return {
      servers: entries.map(([name, cfg]) => ({
        name: cfg.name ?? name,
        command: cfg.command,
        args: cfg.args ?? [],
      })),
      label: `aih.json mcpServers (${entries.length})`,
    };
  }
  return {
    servers: [{ name: "todo", command: opts.bundled.command, args: opts.bundled.args }],
    label: "builtin todo-app",
  };
}

/** Merged mcpServers across config layers (later layers override same-name entries). */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const layer of loadLayers()) {
    for (const [name, cfg] of Object.entries(layer.config.mcpServers ?? {})) {
      Object.assign(out, { [name]: { ...cfg } });
    }
  }
  return out;
}

/**
 * Persist a single skill registry base URL into the first writable config file
 * (project aih.json / .aih/config.json, else ~/.aih/config.json). Returns the path.
 */
export function saveSkillRegistry(url: string): string {
  const candidates = [
    join(process.cwd(), "aih.json"),
    join(process.cwd(), ".aih", "config.json"),
  ];
  const path =
    candidates.find((p) => existsSync(p)) ?? join(userAihDir(), "config.json");
  const cfg = readConfig(path);
  cfg.skills = { ...(cfg.skills ?? {}), registry: url };
  writeConfigFile(path, cfg);
  return path;
}

/**
 * Merged skill registry base URLs across config layers (dedup, order-preserving).
 * Each entry is an opencode-compatible registry root that serves `index.json`
 * plus the skill files it lists.
 */
export function loadSkillRegistry(): string[] {
  const out: string[] = [];
  for (const layer of loadLayers()) {
    const reg = layer.config.skills?.registry;
    if (typeof reg === "string" && reg.trim()) out.push(reg.trim());
    else if (Array.isArray(reg)) {
      for (const u of reg) if (typeof u === "string" && u.trim()) out.push(u.trim());
    }
  }
  return [...new Set(out)];
}

/**
 * Persist a provider definition into the first writable config file (project
 * aih.json / .aih/config.json, else user ~/.aih/config.json). Returns the path.
 *
 * Credential policy (OC#4 trust model): the API key itself NEVER goes into the
 * config file — `apiKeyEnv` names the environment variable that holds it, so
 * the file stays free of secrets and the key can be rotated without touching
 * provider config. `saveProvider` merges into `providers.<name>` (existing
 * fields survive; a new `apiKeyEnv` wins).
 */
export function saveProvider(name: string, cfg: ProviderConfig): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`invalid provider id "${name}" (allowed: letters, digits, . _ -)`);
  }
  const candidates = [
    join(process.cwd(), "aih.json"),
    join(process.cwd(), ".aih", "config.json"),
  ];
  const path =
    candidates.find((p) => existsSync(p)) ?? join(userAihDir(), "config.json");
  const file = readConfig(path);
  const existing = file.providers?.[name] ?? {};
  file.providers = { ...(file.providers ?? {}), [name]: { ...existing, ...cfg } };
  writeConfigFile(path, file);
  return path;
}

export function savePermissionRule(rule: PermissionRule): string {
  const candidates = [
    join(process.cwd(), "aih.json"),
    join(process.cwd(), ".aih", "config.json"),
  ];
  const path =
    candidates.find((p) => existsSync(p)) ?? join(userAihDir(), "config.json");
  const cfg = readConfig(path);
  const list = Array.isArray(cfg.permissions) ? [...cfg.permissions] : [];
  if (!list.some((r) => r.tool === rule.tool && (r.pattern ?? "*") === (rule.pattern ?? "*"))) {
    list.push(rule);
  }
  cfg.permissions = list;
  writeConfigFile(path, cfg);
  return path;
}

/** One selectable model entry across all configured providers. */
export interface ModelCatalogEntry {
  /** provider name from aih.json (e.g. "qwen", "opencode") */
  provider: string;
  /** model id served by that provider */
  model: string;
  /** provider baseUrl for display */
  baseUrl?: string;
  /** context window advertised by this provider's config */
  contextWindow?: number;
  /** true if this entry matches the currently active provider+model */
  active?: boolean;
}

/**
 * Build the full model catalog across every provider defined in any config
 * layer (later layers override same-name providers). Falls back to the
 * top-level model when no providers are configured.
 */
export function loadModelCatalog(activeProvider?: string, activeModel?: string): ModelCatalogEntry[] {
  const layers = loadLayers();
  const mergedCfg = merged(layers);
  // opencode `policies` parity — a denied provider is not selectable.
  const pols = loadPolicies(layers);
  const out: ModelCatalogEntry[] = [];
  for (const [name, p] of Object.entries(mergedCfg.providers ?? {})) {
    if (!providerAllowed(pols, name)) continue; // denied by policy → hidden
    // A provider may expose several selectable models: the primary `model`
    // plus any `models[]` extras (string ids or F#34 `{ model, contextWindow }`
    // objects). Each becomes its own catalog entry.
    const extras = normalizeModelEntries(p.models).filter((e) => e.id !== p.model);
    const entries = [
      ...(p.model !== undefined ? [{ id: p.model, contextWindow: p.contextWindow }] : []),
      ...extras.map((e) => ({ id: e.id, contextWindow: e.contextWindow ?? p.contextWindow })),
    ];
    if (!entries.length) continue;
    for (const { id: mid, contextWindow } of entries) {
      out.push({
        provider: name,
        model: mid,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        active:
          activeProvider === name &&
          (activeModel === undefined || mid === activeModel),
      });
    }
  }
  if (!out.length && mergedCfg.model) {
    out.push({
      provider: "(default)",
      model: mergedCfg.model,
      ...(mergedCfg.baseUrl !== undefined ? { baseUrl: mergedCfg.baseUrl } : {}),
      ...(mergedCfg.contextWindow !== undefined
        ? { contextWindow: mergedCfg.contextWindow }
        : {}),
      active: activeModel === undefined || activeModel === mergedCfg.model,
    });
  }
  return out;
}

/** Lookup a named provider's own config (self-contained unit: baseUrl/model/headers/keyEnv). */
export function providerEntry(name: string): ProviderConfig {
  const cfg = merged(loadLayers());
  const p = cfg.providers?.[name];
  if (!p) throw new Error(`unknown provider "${name}" (not defined in any aih.json providers)`);
  return p;
}

/**
 * CC#59 — a credential belongs to one host. When the effective baseUrl is
 * overridden (`AIH_BASE_URL` / `--base-url`) to a host different from the
 * provider's configured home, sensitive identity headers (authorization /
 * api-key …) must NOT ride along to the new host. Non-sensitive headers (e.g.
 * client identity like a user-agent / rate-pool id) still pass through.
 */
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-goog-api-key|x-amz-security-token|x-nano-fp)$/i;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function credentialSafeHeaders(
  headers: Record<string, string>,
  homeBaseUrl: string | undefined,
  effectiveBaseUrl: string | undefined,
): Record<string, string> {
  if (!homeBaseUrl || !effectiveBaseUrl) return { ...headers };
  const home = hostOf(homeBaseUrl);
  const eff = hostOf(effectiveBaseUrl);
  if (!home || !eff || home === eff) return { ...headers };
  // Hosts differ → drop sensitive headers; keep non-sensitive ones.
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(k)) continue;
    safe[k] = v;
  }
  return safe;
}

export function resolveLlm(opts: {  flagModel?: string;
  flagBaseUrl?: string;
  flagProvider?: string;
  flagContextWindow?: string;
  envModel?: string;
  envBaseUrl?: string;
  envContextWindow?: string;
}): ResolvedLlm {
  const layers = loadLayers();
  const cfg = merged(layers);

  const providerName = opts.flagProvider ?? cfg.defaultProvider;
  // opencode `policies` parity — a provider denied by policy is unusable even
  // if configured (throws on resolve so model use is blocked, not just hidden).
  if (providerName) {
    const pols = loadPolicies(layers);
    if (!providerAllowed(pols, providerName)) {
      throw new Error(
        `provider "${providerName}" is denied by policy (action provider.use) — ` +
        `remove it from the deny policy in aih.json / config.json to use it`,
      );
    }
  }
  let provider: ProviderConfig | undefined;
  if (providerName) {
    provider = cfg.providers?.[providerName];
    if (!provider) {
      throw new Error(`unknown provider "${providerName}" (not defined in any aih.json providers)`);
    }
  }

  const model =
    opts.flagModel !== undefined
      ? { value: opts.flagModel, source: "flag" }
      : opts.envModel !== undefined
        ? { value: opts.envModel, source: "env AIH_MODEL" }
        : fromLayers(layers, (c) =>
            provider?.model !== undefined ? provider.model : c.model,
          );

  const baseUrl =
    opts.flagBaseUrl !== undefined
      ? { value: opts.flagBaseUrl, source: "flag" }
      : opts.envBaseUrl !== undefined
        ? { value: opts.envBaseUrl, source: "env AIH_BASE_URL" }
        : fromLayers(layers, (c) =>
            provider?.baseUrl !== undefined ? provider.baseUrl : c.baseUrl,
          );

  const apiKeyEnv =
    provider?.apiKeyEnv ??
    (providerName ? `AIH_${providerName.toUpperCase()}_API_KEY` : "AIH_API_KEY");

  // CC#59 — a credential only rides to its own host. If the effective baseUrl
  // (possibly overridden by AIH_BASE_URL / --base-url) targets a different host
  // than the provider's configured home, sensitive headers are dropped.
  const homeBaseUrl = fromLayers(layers, (c) =>
    provider?.baseUrl !== undefined ? provider.baseUrl : c.baseUrl,
  );
  const headers = credentialSafeHeaders({ ...(provider?.headers ?? {}) }, homeBaseUrl?.value, baseUrl?.value);

  const keyless = provider?.keyless === true;

  // Model-level maxTokens overrides the provider tier, so models with
  // different output caps (e.g. zhipu glm-4v-flash ≤ 1024) share one
  // provider entry without forcing every model down to the smallest cap.
  const mMaxTokens = modelLevelMaxTokens(layers, providerName, model.value);
  const maxTokens =
    mMaxTokens !== undefined
      ? mMaxTokens
      : typeof provider?.maxTokens === "number" && provider.maxTokens > 0
        ? provider.maxTokens
        : undefined;

  // F#34 — the active model's own models[] entry overrides the provider tier.
  const mWindow = modelLevelWindow(layers, providerName, model.value);
  const contextWindow =
    opts.flagContextWindow !== undefined
      ? { value: opts.flagContextWindow, source: "flag --context-window" }
      : opts.envContextWindow !== undefined
        ? { value: opts.envContextWindow, source: "env AIH_CONTEXT_WINDOW" }
        : mWindow !== undefined
          ? {
              value: String(mWindow),
              source: `providers.${providerName}.models[${model.value}].contextWindow`,
            }
          : provider?.contextWindow !== undefined
            ? { value: String(provider.contextWindow), source: `providers.${providerName}.contextWindow` }
            : fromLayers(layers, (c) =>
                c.contextWindow !== undefined ? String(c.contextWindow) : undefined,
            );

  return { model, baseUrl, apiKeyEnv, provider: providerName, keyless, maxTokens, headers, contextWindow, layers };
}

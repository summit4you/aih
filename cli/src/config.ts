import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PermissionRule } from "@aih/core";
import { userAihDir, userAihDirs } from "./paths.js";

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
   */
  models?: string[];
  apiKeyEnv?: string;
  /** context window (max input tokens) for this provider's model */
  contextWindow?: number;
  /** extra request headers for this provider (e.g. client identity for rate-limit pools) */
  headers?: Record<string, string>;
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
  model?: string;
  baseUrl?: string;
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  /** multiple MCP servers (stdio) connected side-by-side and merged */
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: PermissionRule[];
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
  contextWindow: ResolvedValue;
  headers: Record<string, string>;
  layers: ConfigLayer[];
}

const PROJECT_CONFIG_FILES = ["aih.json", ".aih/config.json"];

function readConfig(path: string): AihConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AihConfig;
  } catch (err) {
    throw new Error(
      `invalid config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  for (const name of PROJECT_CONFIG_FILES) {
    const projectPath = join(process.cwd(), name);
    const project = readConfig(projectPath);
    if (Object.keys(project).length > 0) layers.push({ path: projectPath, config: project });
  }
  return layers;
}

function merged(layers: ConfigLayer[]): AihConfig {
  const out: AihConfig = {};
  for (const { config } of layers) Object.assign(out, config);
  return out;
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

export function loadPermissionRules(): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const layer of loadLayers()) {
    for (const rule of layer.config.permissions ?? []) out.push(rule);
  }
  return out;
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
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
  const out: ModelCatalogEntry[] = [];
  for (const [name, p] of Object.entries(mergedCfg.providers ?? {})) {
    // A provider may expose several selectable models: the primary `model`
    // plus any `models[]` extras. Each becomes its own catalog entry.
    const modelIds = [
      ...(p.model !== undefined ? [p.model] : []),
      ...(p.models ?? []).filter((m) => m !== p.model),
    ];
    if (!modelIds.length) continue;
    for (const mid of modelIds) {
      out.push({
        provider: name,
        model: mid,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
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

  const headers = { ...(provider?.headers ?? {}) };

  const contextWindow =
    opts.flagContextWindow !== undefined
      ? { value: opts.flagContextWindow, source: "flag --context-window" }
      : opts.envContextWindow !== undefined
        ? { value: opts.envContextWindow, source: "env AIH_CONTEXT_WINDOW" }
        : provider?.contextWindow !== undefined
          ? { value: String(provider.contextWindow), source: `providers.${providerName}.contextWindow` }
          : fromLayers(layers, (c) =>
              c.contextWindow !== undefined ? String(c.contextWindow) : undefined,
          );

  return { model, baseUrl, apiKeyEnv, provider: providerName, headers, contextWindow, layers };
}

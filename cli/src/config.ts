import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionRule } from "@aih/core";

export interface ProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
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
  const globalPath = join(homedir(), ".aih", "config.json");
  const global = readConfig(globalPath);
  if (Object.keys(global).length > 0) layers.push({ path: globalPath, config: global });
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

export function savePermissionRule(rule: PermissionRule): string {
  const candidates = [
    join(process.cwd(), "aih.json"),
    join(process.cwd(), ".aih", "config.json"),
  ];
  const path =
    candidates.find((p) => existsSync(p)) ?? join(homedir(), ".aih", "config.json");
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

export function resolveLlm(opts: {
  flagModel?: string;
  flagBaseUrl?: string;
  flagProvider?: string;
  envModel?: string;
  envBaseUrl?: string;
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

  return { model, baseUrl, apiKeyEnv, provider: providerName, layers };
}

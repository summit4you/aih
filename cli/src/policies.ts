/**
 * Policies (opencode `policies` parity; opencode marks it experimental).
 *
 * Policies control which *configured resources* AIH may use. They are separate
 * from permissions — permissions gate what *tools* do during a session;
 * policies gate whether a *resource* (an LLM provider) is usable at all.
 *
 * A provider denied by policy is not available for model selection or model
 * use, even if it has credentials or is otherwise configured correctly.
 *
 * Config shape (mirrors opencode `experimental.policies`):
 *   "policies": [
 *     { "effect": "deny" | "allow", "action": "provider.use", "resource": "openai" }
 *   ]
 *
 * Matching:
 *   - `resource` supports `*` (zero+ chars) and `?` (one char) wildcards.
 *   - Last matching statement wins → put broad rules first, specific after.
 *   - If no policy matches, use is allowed by default (opencode default).
 *   - Global policy takes priority over project policy (a repo can't re-enable
 *     a provider you deny globally). Implemented by layering: global policies
 *     are evaluated after project ones (last-match-wins), so a global deny
 *     overrides a project allow.
 */
import type { ConfigLayer } from "./config.js";

export type PolicyEffect = "allow" | "deny";
export type PolicyAction = "provider.use";

export interface Policy {
  effect: PolicyEffect;
  action: PolicyAction;
  resource: string;
}

/**
 * Evaluate policies against a resource id with wildcard matching.
 * Returns the effective effect, or "allow" when nothing matched (default).
 */
export function evaluatePolicy(
  policies: Policy[] | undefined,
  action: PolicyAction,
  resource: string,
): PolicyEffect {
  if (!policies || policies.length === 0) return "allow";
  let verdict: PolicyEffect | undefined;
  for (const p of policies) {
    if (p.action !== action) continue;
    if (wildcardMatch(p.resource, resource)) verdict = p.effect;
  }
  return verdict ?? "allow";
}

/** `*` matches zero+ chars, `?` matches one char. case-insensitive. */
export function wildcardMatch(pattern: string, value: string): boolean {
  // Build a regex from the glob-like pattern.
  let rx = "";
  for (const ch of pattern) {
    if (ch === "*") rx += ".*";
    else if (ch === "?") rx += ".";
    else rx += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`, "i").test(value);
}

/**
 * Collect policies from all trusted config layers, in resolution order.
 * Global layers come first, project layers last — but because we hand back an
 * ordered list that evaluatePolicy scans last-match-wins, the caller should
 * pass project policies BEFORE global ones so that a global deny (later) wins.
 * We do that by reversing load order: `loadLayers()` returns project last, so
 * to make global win we list project policies first, global after.
 */
export function loadPolicies(layers: ConfigLayer[]): Policy[] {
  const out: Policy[] = [];
  const nonProject = layers.filter((l) => !isProjectLayer(l));
  const project = layers.filter((l) => isProjectLayer(l));
  for (const layer of [...project, ...nonProject]) {
    for (const p of layer.config.policies ?? []) {
      if (p && typeof p.resource === "string") out.push(p);
    }
  }
  return out;
}

function isProjectLayer(l: ConfigLayer): boolean {
  const p = l.path ?? "";
  return p.endsWith("aih.json") || p.includes("/.aih/config.json");
}

/** True when a provider is usable (not denied) for `provider.use`. */
export function providerAllowed(
  policies: Policy[] | undefined,
  providerName: string,
): boolean {
  return evaluatePolicy(policies, "provider.use", providerName) === "allow";
}

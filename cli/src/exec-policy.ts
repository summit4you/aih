/**
 * AC#3 — execution policy bitmask (AtomCode execution_policy.rs).
 *
 * Per-turn fine-grained restriction of shell command CATEGORIES. The existing
 * plan mode hides all write tools; this adds a middle layer: "allow writes but
 * forbid build/test/script execution" (e.g. a review-only session where the
 * agent may edit files but must not run `npm run build` or `bash script.sh`).
 *
 * Design:
 * - Bitmask: NO_BUILD=1, NO_TEST=2, NO_SHELL=4. Combined: NO_BUILD|NO_TEST=3.
 * - Deterministic classifier (prefix + token scan, same style as readonly-allow.ts).
 * - Fail-closed: if the classifier can't categorize a command, it is NOT
 *   blocked (we only block what we can identify). The approval gate remains
 *   the real boundary; this policy is an additional layer on top.
 * - Config: `executionPolicy: number` in aih.json (bitmask), or
 *   `AIH_EXEC_POLICY=build,test,shell` env var (comma-separated names).
 * - CLI flags: `--no-build`, `--no-test`, `--no-shell` (each sets one bit).
 */

/** Bit flags for execution policy categories. */
export const NO_BUILD = 1;
export const NO_TEST = 2;
export const NO_SHELL = 4;
export const NO_ALL = NO_BUILD | NO_TEST | NO_SHELL;

/** Human-readable names for each bit (for env var parsing + error messages). */
const BIT_NAMES: ReadonlyArray<readonly [number, string]> = [
  [NO_BUILD, "build"],
  [NO_TEST, "test"],
  [NO_SHELL, "shell"],
];

/**
 * Parse a policy spec (number or comma-separated names) into a bitmask.
 * `parsePolicy("build,test")` → NO_BUILD|NO_TEST = 3.
 * `parsePolicy(5)` → 5 (NO_BUILD|NO_SHELL).
 * Unknown names are ignored with a warning to stderr.
 */
export function parsePolicy(spec: number | string): number {
  if (typeof spec === "number") return spec & NO_ALL;
  let bits = 0;
  for (const raw of spec.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const entry = BIT_NAMES.find(([, n]) => n === name);
    if (entry) bits |= entry[0];
    else process.stderr.write(`[exec-policy] unknown category "${name}" (valid: build, test, shell)\n`);
  }
  return bits & NO_ALL;
}

/**
 * Tokenize a shell command into its leading tokens (up to `max` tokens),
 * skipping env-var assignment prefixes (FOO=bar cmd …).
 * Shallow: does not handle subshells, command substitution, or quoting.
 * This is a HEURISTIC classifier — the approval gate is the real boundary.
 */
function leadingTokens(cmd: string, max = 4): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  // Skip leading env-var assignments.
  let rest = trimmed;
  while (true) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=\S* +/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  const parts = rest.split(/\s+/);
  for (let i = 0; i < Math.min(max, parts.length); i++) tokens.push(parts[i]);
  return tokens;
}

/**
 * Classify a run_cmd command into execution-policy categories.
 * Returns the bitmask of categories the command belongs to (0 = none).
 *
 * Categories:
 * - NO_BUILD: build/compile invocations (npm run build, tsc, cargo build, make, …)
 * - NO_TEST: test invocations (npm test, jest, pytest, cargo test, …)
 * - NO_SHELL: direct script execution (bash script.sh, sh script.sh, …)
 *
 * Deliberately conservative: only blocks what it can positively identify.
 * A command like `npm run lint` is NOT classified as build (it's a different
 * script name) — the policy only blocks the specific categories listed.
 */
export function classifyCommand(cmd: string): number {
  const trimmed = cmd.trim();
  if (!trimmed) return 0;
  const tok = leadingTokens(trimmed, 6);
  if (!tok.length) return 0;
  const [t0, t1, t2] = [tok[0] ?? "", tok[1] ?? "", tok[2] ?? ""];
  let bits = 0;

  // --- NO_BUILD: build/compile ---
  // npm/yarn/pnpm run <script> where <script> is a build-related name
  const pkgMgrs = new Set(["npm", "yarn", "pnpm", "bun"]);
  // `npm run <script>` / `yarn <script>` / `pnpm <script>` (yarn/pnpm accept
  // the script name directly, without the `run` verb).
  const scriptName = pkgMgrs.has(t0) ? (t1 === "run" ? t2 : t1) : "";
  if (scriptName) {
    const s = scriptName.toLowerCase();
    if (
      s === "build" || s === "compile" || s === "bundle" ||
      s === "pack" || s === "prebuild" || s === "postbuild" ||
      s === "dev" || s === "start" || s === "serve"
    ) {
      bits |= NO_BUILD;
    }
  }
  // Direct build tools
  if (
    t0 === "tsc" || t0 === "esbuild" || t0 === "webpack" || t0 === "vite" ||
    t0 === "rollup" || t0 === "parcel" || t0 === "swc" ||
    (t0 === "cargo" && t1 === "build") ||
    (t0 === "go" && t1 === "build") ||
    t0 === "make" || t0 === "cmake" ||
    (t0 === "dotnet" && t1 === "build") ||
    t0 === "msbuild" || t0 === "xcodebuild"
  ) {
    bits |= NO_BUILD;
  }
  // npx <build-tool>
  if (t0 === "npx" || t0 === "pnpx") {
    const tool = (t1 || "").toLowerCase();
    if (["tsc", "esbuild", "webpack", "vite", "rollup", "parcel", "swc"].includes(tool)) {
      bits |= NO_BUILD;
    }
  }

  // --- NO_TEST: test/verify ---
  if (pkgMgrs.has(t0) && t1 === "test") bits |= NO_TEST;
  if (
    t0 === "jest" || t0 === "vitest" || t0 === "mocha" || t0 === "tap" ||
    t0 === "pytest" || t0 === "py.test" || t0 === "nose2" ||
    (t0 === "cargo" && t1 === "test") ||
    (t0 === "go" && t1 === "test") ||
    t0 === "ctest" || (t0 === "dotnet" && t1 === "test") ||
    t0 === "phpunit" || t0 === "rspec" || t0 === "cucumber"
  ) {
    bits |= NO_TEST;
  }
  // npm/yarn/pnpm run <test-script>
  if (pkgMgrs.has(t0) && t1 === "run") {
    const script = (t2 || "").toLowerCase();
    if (script === "test" || script === "check" || script === "lint" || script === "typecheck" || script === "verify") {
      bits |= NO_TEST;
    }
  }

  // --- NO_SHELL: direct script execution ---
  // bash/sh/zsh/ksh running a script file (not -c inline)
  if (
    (t0 === "bash" || t0 === "sh" || t0 === "zsh" || t0 === "ksh" || t0 === "dash" || t0 === "ash") &&
    t1 && !t1.startsWith("-") && (t1.endsWith(".sh") || t1.endsWith(".bash") || t1.endsWith(".zsh") || t1.includes("/"))
  ) {
    bits |= NO_SHELL;
  }
  // pwsh/powershell running a script file
  if (
    (t0 === "pwsh" || t0 === "powershell" || t0 === "powershell.exe") &&
    t1 && !t1.startsWith("-") && (t1.endsWith(".ps1") || t1.endsWith(".psm1") || t1.includes("/"))
  ) {
    bits |= NO_SHELL;
  }
  // python/perl/ruby running a script file
  if (
    (t0 === "python" || t0 === "python3" || t0 === "perl" || t0 === "ruby" || t0 === "node") &&
    t1 && !t1.startsWith("-") && !t1.startsWith("--") &&
    (t1.endsWith(".py") || t1.endsWith(".pl") || t1.endsWith(".rb") || t1.endsWith(".js") || t1.endsWith(".mjs") || t1.endsWith(".cjs"))
  ) {
    bits |= NO_SHELL;
  }

  return bits;
}

/**
 * Check if a command violates the given policy bitmask.
 * Returns the violating bits (0 = no violation).
 */
export function policyViolation(cmd: string, policy: number): number {
  if (!policy) return 0;
  return classifyCommand(cmd) & policy;
}

/** Human-readable description of a policy bitmask (for error messages). */
export function describePolicy(bits: number): string {
  const names: string[] = [];
  for (const [bit, name] of BIT_NAMES) {
    if (bits & bit) names.push(name);
  }
  return names.length ? names.join(" + ") : "(none)";
}

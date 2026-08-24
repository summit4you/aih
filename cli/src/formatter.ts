// Post-write auto-formatting (roadmap F#27, opencode `format/formatter.ts` parity).
//
// After write_file / edit / apply_patch succeed, detect the project's formatter
// (prettier > biome > eslint --fix) by walking up from the written file for
// config files / package.json deps, then run it with a timeout. Success merges
// `formatted: true` into the tool result; a failure never blocks the write —
// it only adds a `formatNote` hint (roadmap: "失败不阻断、只提示").

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildChildEnv } from "./env-policy.js";

const FORMAT_TIMEOUT_MS = Number(process.env.AIH_FORMAT_TIMEOUT_MS ?? "") || 15_000;

/** Extensions we are willing to hand to a formatter. */
const FORMATTABLE = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".json", ".jsonc", ".yml", ".yaml", ".md", ".mdx",
  ".css", ".scss", ".html", ".htm", ".vue", ".svelte",
  ".toml", ".xml", ".graphql", ".gql",
]);

export interface FormatOutcome {
  /** true when a formatter ran successfully and may have rewritten the file */
  formatted?: boolean;
  /** which formatter ran (prettier | biome | eslint) */
  formatter?: string;
  /** set when no formatter applies or it failed — never fatal */
  formatNote?: string;
  /** true when the formatter actually changed the file on disk */
  changed?: boolean;
}

interface FormatterSpec {
  name: string;
  /** full argv to spawn, executable first (file already substituted) */
  argv: (file: string) => string[];
}

function readJsonSafe(file: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasDep(pkg: Record<string, unknown> | undefined, dep: string): boolean {
  if (!pkg) return false;
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[key] as Record<string, unknown> | undefined;
    if (deps && dep in deps) return true;
  }
  return false;
}

function localBin(pkgDir: string, binName: string): string | undefined {
  const bin = join(pkgDir, "node_modules", ".bin", binName);
  return existsSync(bin) ? bin : undefined;
}

/**
 * Walk up from `startDir` looking for the first directory that configures a
 * formatter for `file`. Returns the winning spec, or undefined.
 * Precedence: prettier > biome > eslint (first configured wins).
 */
export function detectFormatter(file: string, startDir: string = dirname(file)): FormatterSpec | undefined {
  const ext = file.slice(file.lastIndexOf("."));
  if (!FORMATTABLE.has(ext)) return undefined;

  let dir = resolve(startDir);
  for (;;) {
    const pkgFile = join(dir, "package.json");
    const pkg = existsSync(pkgFile) ? readJsonSafe(pkgFile) : undefined;

    // prettier: rc file, config file, package.json "prettier" key, or a dep
    const prettierConfigured =
      [".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.yaml", ".prettierrc.yml",
        "prettier.config.js", "prettier.config.mjs", "prettier.config.cjs"].some((f) => existsSync(join(dir, f))) ||
      (pkg !== undefined && "prettier" in pkg) ||
      hasDep(pkg, "prettier");
    if (prettierConfigured) {
      const bin = localBin(dir, "prettier");
      return {
        name: "prettier",
        argv: (f) => (bin ? [bin, "--write", f] : ["npx", "--no-install", "prettier", "--write", f]),
      };
    }

    // biome: config file or a dep
    const biomeConfigured =
      ["biome.json", "biome.jsonc", "biome.json5"].some((f) => existsSync(join(dir, f))) ||
      hasDep(pkg, "@biomejs/biome") || hasDep(pkg, "biome");
    if (biomeConfigured) {
      const bin = localBin(dir, "biome");
      return {
        name: "biome",
        argv: (f) => (bin ? [bin, "format", "--write", f] : ["npx", "--no-install", "@biomejs/biome", "format", "--write", f]),
      };
    }

    // eslint: rc / flat config, or a dep (eslint --fix)
    const eslintConfigured =
      [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yaml", ".eslintrc.yml",
        "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"].some((f) =>
        existsSync(join(dir, f)),
      ) ||
      hasDep(pkg, "eslint");
    if (eslintConfigured) {
      const bin = localBin(dir, "eslint");
      return {
        name: "eslint",
        argv: (f) => (bin ? [bin, "--fix", f] : ["npx", "--no-install", "eslint", "--fix", f]),
      };
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

function runWithTimeout(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((res) => {
    let settled = false;
    const finish = (code: number, output: string) => {
      if (!settled) {
        settled = true;
        res({ code, output });
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: buildChildEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish(127, err instanceof Error ? err.message : String(err));
      return;
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(124, `${out}\n[timeout after ${Math.round(timeoutMs / 1000)}s]`);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(127, err.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1, out);
    });
  });
}

/**
 * Format `file` in place if the project configures a formatter.
 * Never throws and never blocks the caller's success path.
 */
export async function formatAfterWrite(file: string, cwd: string = process.cwd()): Promise<FormatOutcome> {
  const abs = resolve(cwd, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return {};
  const spec = detectFormatter(abs);
  if (!spec) return {}; // no formatter configured — leave the result untouched

  const before = readFileSync(abs, "utf8");
  const argv = spec.argv(abs);
  const [cmd, ...args] = argv;
  const { code, output } = await runWithTimeout(cmd, args, dirname(abs), FORMAT_TIMEOUT_MS);
  if (code === 0) {
    let changed = false;
    try {
      changed = readFileSync(abs, "utf8") !== before;
    } catch {
      /* file vanished mid-format — not our failure */
    }
    return { formatted: true, formatter: spec.name, changed };
  }
  const tail = output.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
  const reason = code === 124 ? "timed out" : `exit ${code}`;
  return { formatted: false, formatter: spec.name, formatNote: `formatter ${spec.name} ${reason}: ${tail}` };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { ToolRegistry } from "@aih/core";
import { lineDiff } from "./diff.js";
import { publishFile } from "./atomic.js";
import { buildChildEnv } from "./env-policy.js";
import { formatAfterWrite } from "./formatter.js";
import { resolveSandboxBackend } from "./sandbox.js";
import { scanCommand, formatScanSummary } from "./shell-scan.js";
import { generateShellDescription } from "./shell-prompt.js";
import { CodeIntelPool, flattenDocumentSymbols, navtoLocate, navtreeToSymbols, pathToUri, uriToPath, openDocument } from "./codeintel.js";

const MAX_READ = 64 * 1024;
const MAX_OUT = 32 * 1024;
const CMD_TIMEOUT_DEFAULT_MS = Number(process.env.AIH_CMD_TIMEOUT_MS ?? "") || 120_000;
const CMD_TIMEOUT_MAX_MS = 600_000;

/** Detect the user's shell (for tool-description adaptation). */
function detectShellName(): string {
  const s = process.env.SHELL ?? "";
  if (/powershell|pwsh/i.test(s)) return "powershell";
  if (/zsh/i.test(s)) return "zsh";
  if (/bash/i.test(s)) return "bash";
  return s.split("/").pop() || "sh";
}

function safePath(cwd: string, p: string | undefined): string {
  const target = resolve(cwd, p ?? ".");
  return target;
}

/**
 * FA#1 — middle-truncate: keep head + tail, elide the middle.
 *
 * Shell output states its verdict at the END — a pytest run in the last three
 * lines, a webpack build in the last error, a script in its exit status. A
 * head-only cut drops exactly the lines the tool was called for, forcing the
 * model to spend a turn reading the spill file to get them back (FrontierAgent
 * and codex both cut the middle for this reason).
 *
 * Pure (no I/O) so it is unit-testable in isolation. Returns the input
 * unchanged when it fits the budget. The elided middle is marked so the model
 * knows context was dropped and can re-fetch via `output_file` / `read_file`.
 */
export function truncateMiddle(
  text: string,
  budget: number,
  opts?: { headRatio?: number },
): { text: string; truncated: boolean; elidedChars: number } {
  if (text.length <= budget) return { text, truncated: false, elidedChars: 0 };
  // headRatio is the share of the budget given to the head; the rest goes to
  // the tail. 0.5 (symmetric) is the default — the tail carries the verdict,
  // the head carries the initial context (command banner, first errors).
  const headRatio = Math.min(1, Math.max(0, opts?.headRatio ?? 0.5));
  const headLen = Math.floor(budget * headRatio);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const elided = text.length - headLen - tailLen;
  return {
    text: `${head}\n… ${elided} chars elided …\n${tail}`,
    truncated: true,
    elidedChars: elided,
  };
}

/** Input for the shared shell executor (run_cmd tool + `!` prompt prefix). */
export interface RunShellInput {
  command: string;
  /** workspace root */
  cwd: string;
  /** per-call working directory (resolved against cwd); falls back to cwd */
  workdir?: string;
  timeout_ms?: number;
  sandbox?: string;
  keep_output?: boolean;
  output_path?: string;
}

/** Structured result of a shell execution (mirrors the run_cmd tool output). */
export interface RunShellResult {
  code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elided_chars: number;
  sandbox: string;
  output_file?: string;
  output_bytes?: number;
  /** shell-scan annotation: what the command touches. */
  scan: {
    isWrite: boolean;
    externalDirs: string[];
    touchedPaths: string[];
    summary: string;
  };
}

/**
 * Shared shell executor — the real production path both the `run_cmd` tool and
 * the TUI `!`-prefix fast path use. Runs the command through the selected
 * sandbox backend with env-filtered children, enforces the timeout, applies
 * in-band middle-truncation (FA#1, verdict tail preserved), and persists the
 * full output on request (T#22). Co-located here so the tool and the prompt
 * prefix can never drift.
 */
export async function runShellCommand(
  input: RunShellInput,
  cwd = process.cwd(),
): Promise<RunShellResult> {
  const command = String(input.command);
  if (!command.trim()) throw new Error("command is required");
  const dir = input.workdir ? safePath(cwd, input.workdir) : safePath(cwd, ".");
  const timeoutMs = Math.min(
    CMD_TIMEOUT_MAX_MS,
    Math.max(1000, Number(input.timeout_ms ?? CMD_TIMEOUT_DEFAULT_MS) || CMD_TIMEOUT_DEFAULT_MS),
  );
  const scan = scanCommand(command, dir);
  const backend = resolveSandboxBackend(input.sandbox ? String(input.sandbox) : undefined);
  const { code, timed_out: killed, output } = await backend.run({
    command,
    cwd: dir,
    env: buildChildEnv(),
    timeoutMs,
  });
  let outputFile: string | undefined;
  if (input.keep_output === true) {
    const dest = input.output_path
      ? safePath(cwd, String(input.output_path))
      : join(cwd, ".aih", "outputs", `cmd-${Date.now()}-${randomUUID().slice(0, 8)}.log`);
    try {
      mkdirSync(resolve(dest, ".."), { recursive: true });
      writeFileSync(dest, output);
      outputFile = dest;
    } catch {
      /* keep_output is best-effort; the in-band stdout below still returns */
    }
  }
  const { text: stdout, truncated, elidedChars } = truncateMiddle(output, MAX_OUT);
  return {
    code,
    timed_out: killed,
    stdout,
    stderr: "",
    truncated,
    elided_chars: elidedChars,
    sandbox: backend.name,
    scan: {
      isWrite: scan.isWrite,
      externalDirs: [...scan.externalDirs],
      touchedPaths: scan.paths.slice(0, 50),
      summary: formatScanSummary(scan),
    },
    ...(outputFile ? { output_file: outputFile, output_bytes: Buffer.byteLength(output) } : {}),
  };
}

export function registerDevTools(
  registry: ToolRegistry,
  cwd = process.cwd(),
  hideWrites = false,
): void {
  registry.register({
    name: "list_dir",
    description: `List entries of a directory (default: ${cwd}).`,
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "directory path" } },
      required: [],
    },
    execute: async (args) => {
      const dir = safePath(cwd, String((args as { path?: unknown }).path ?? "."));
      if (!existsSync(dir)) throw new Error(`not found: ${dir}`);
      const entries = readdirSync(dir, { withFileTypes: true });
      return {
        dir,
        entries: entries.slice(0, 500).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
          size: e.isFile() ? statSync(join(dir, e.name)).size : undefined,
        })),
      };
    },
  });

  registry.register({
    name: "read_file",
    description: "Read a text file (first 64KB).",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        offset_line: { type: "number", description: "1-based start line" },
        max_lines: { type: "number", description: "max lines to return" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const a = args as { path?: unknown; offset_line?: unknown; max_lines?: unknown };
      const file = safePath(cwd, String(a.path));
      if (!existsSync(file)) throw new Error(`not found: ${file}`);
      if (!statSync(file).isFile()) throw new Error(`not a file: ${file}`);
      let text = readFileSync(file, "utf8").slice(0, MAX_READ);
      const start = Math.max(0, Number(a.offset_line ?? 1) - 1);
      const maxLines = Number(a.max_lines ?? 400);
      const lines = text.split("\n").slice(start, start + maxLines);
      return { path: file, total_lines_shown: lines.length, content: lines.join("\n").slice(0, MAX_READ) };
    },
  });

  if (hideWrites) return;
  registry.register({
    name: "write_file",
    description: "Create or overwrite a text file.",
    kind: "write",
    permission: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        content: { type: "string", description: "full file content" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
      const a = args as { path?: unknown; content?: unknown };
      const file = safePath(cwd, String(a.path));
      const content = String(a.content ?? "");
      let previous = "";
      if (existsSync(file)) {
        try {
          previous = readFileSync(file, "utf8");
        } catch {
          previous = "";
        }
      }
      mkdirSync(resolve(file, ".."), { recursive: true });
      publishFile(file, content);
      // F#27: post-write auto-format (prettier/biome/eslint), never blocks.
      const fmt = await formatAfterWrite(file, cwd);
      return { path: file, bytes: Buffer.byteLength(content), new_file: previous === "", _diff: lineDiff(previous, content), ...fmt };
    },
  });

  registry.register({
    name: "run_cmd",
    description: generateShellDescription({
      cwd,
      timeoutMs: CMD_TIMEOUT_DEFAULT_MS,
      maxLines: 400,
      maxBytes: MAX_OUT,
      shellName: detectShellName(),
    }),
    kind: "write",
    permission: "ask",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "command to run via sh -c" },
        cwd: { type: "string", description: "working directory" },
        workdir: { type: "string", description: "working directory (alias for cwd; prefer this over cd)" },
        timeout_ms: { type: "number", description: `timeout in ms (default ${CMD_TIMEOUT_DEFAULT_MS}, max ${CMD_TIMEOUT_MAX_MS})` },
        keep_output: { type: "boolean", description: "persist the full (uncapped) output to .aih/outputs/ and return output_file (T#22)" },
        output_path: { type: "string", description: "explicit path for the kept output (overrides the default .aih/outputs/ location)" },
        sandbox: { type: "string", description: "execution backend: local (default) | bwrap | remote (D#12 sandbox seam)" },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const a = args as {
        command?: unknown;
        cwd?: unknown;
        workdir?: unknown;
        timeout_ms?: unknown;
        keep_output?: unknown;
        output_path?: unknown;
        sandbox?: unknown;
      };
      return runShellCommand(
        {
          command: String(a.command),
          cwd,
          workdir: a.workdir !== undefined ? String(a.workdir) : String(a.cwd ?? "."),
          timeout_ms: Number(a.timeout_ms ?? undefined),
          sandbox: a.sandbox !== undefined ? String(a.sandbox) : undefined,
          keep_output: a.keep_output === true,
          output_path: a.output_path !== undefined ? String(a.output_path) : undefined,
        },
        cwd,
      );
    },
  });

  // AC#2 — code-intelligence tools (on-demand LSP, degraded-gracefully).
  registerCodeIntelTools(registry, cwd);
}

/**
 * AC#2 — Code-intelligence tools (on-demand LSP, AtomCode borrow).
 *
 * Tools are `kind: "read"` / `permission: "allow"` → they join the parallel
 * read-only tool class (F#29). A missing language server degrades to a
 * clear error, never a crash. The pool is held for the lifetime of the
 * registry (one process per project root + server command, reused across
 * compatible extensions, sticky-failure after a bad startup).
 */
export function registerCodeIntelTools(
  registry: ToolRegistry,
  cwd = process.cwd(),
  pool?: CodeIntelPool,
): void {
  const intel = pool ?? new CodeIntelPool(cwd);
  // Keep the pool reachable so tools don't re-create it per call.
  (registry as unknown as { __aihCodeIntel?: CodeIntelPool }).__aihCodeIntel = intel;

  const fileArg = (desc: string) => ({
    type: "object",
    properties: {
      path: { type: "string", description: desc },
      symbol: { type: "string", description: "symbol name to look up" },
    },
    required: [],
  });

  // ---- list_symbols: all top-level symbols in a file ---------------------
  registry.register({
    name: "list_symbols",
    description:
      "List top-level symbols (functions, classes, interfaces, types, consts) declared in a file, with locations. Requires a language server for the file's extension.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path relative to workspace" } },
      required: ["path"],
    },
    execute: async (args) => {
      const a = args as { path?: unknown };
      const p = String(a.path ?? "");
      if (!p) throw new Error("path is required");
      const abs = intel.resolveInWorkspace(p);
      if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
      const unavailable = intel.unavailableFor(abs);
      if (unavailable) throw new Error(`code intel unavailable: ${unavailable}`);
      const { spec, lsp, ts } = await intel.clientFor(abs);
      let symbols: Array<Record<string, unknown>> = [];
      if (ts) {
        // navtree = per-file outline. navto with an empty searchValue searches
        // the WHOLE project (and picks up ambient globals like __dirname), so
        // it is the wrong primitive for "symbols declared in this file".
        await ts.ensureOpen(abs);
        const tree = await ts.command<{ childItems?: unknown[] }>("navtree", { file: abs });
        symbols = navtreeToSymbols(tree, intel.root, abs) as unknown as Array<Record<string, unknown>>;
      } else if (lsp) {
        const text = readFileSync(abs, "utf8");
        await openDocument(lsp, abs, text);
        const items = await lsp.request<unknown>("textDocument/documentSymbol", {
          textDocument: { uri: pathToUri(abs) },
        });
        symbols = normalizeSymbols(items);
      }
      return { file: relative(intel.root, abs).split("\\").join("/"), count: symbols.length, symbols };
    },
  });

  // ---- read_symbol: definition + signature of a symbol --------------------
  registry.register({
    name: "read_symbol",
    description:
      "Get the definition location and signature of a symbol (function/class/type) in a file. Requires a language server.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path relative to workspace" },
        symbol: { type: "string", description: "symbol name" },
      },
      required: ["path", "symbol"],
    },
    execute: async (args) => {
      const a = args as { path?: unknown; symbol?: unknown };
      const p = String(a.path ?? "");
      const symbol = String(a.symbol ?? "");
      if (!p || !symbol) throw new Error("path and symbol are required");
      const abs = intel.resolveInWorkspace(p);
      const unavailable = intel.unavailableFor(abs);
      if (unavailable) throw new Error(`code intel unavailable: ${unavailable}`);
      const { ts, lsp } = await intel.clientFor(abs);
      if (ts) {
        // Locate the identifier first: quickinfo at the declaration span
        // start (often line start) returns "No content available." — it must
        // hit INSIDE the identifier. navtoLocate resolves the real position.
        const at = await navtoLocate(ts, abs, symbol);
        if (!at) {
          return { symbol, signature: "", doc: `symbol not found in ${p} (navto)` };
        }
        const q = await ts.command<{ displayString?: string; documentation?: string }>("quickinfo", {
          file: abs,
          line: at.line,
          offset: at.offset,
        });
        return {
          symbol,
          line: at.line - 1,
          character: at.offset - 1,
          signature: q?.displayString ?? "",
          doc: q?.documentation ?? "",
        };
      }
      if (lsp) {
        // Standard LSP: document symbols to locate, then hover at its selection.
        const text = readFileSync(abs, "utf8");
        await openDocument(lsp, abs, text);
        const items = await lsp.request<unknown>("textDocument/documentSymbol", {
          textDocument: { uri: pathToUri(abs) },
        });
        const flat = flattenDocumentSymbols(items);
        const hit = flat.find((s) => s.name === symbol) ?? flat.find((s) => s.name.includes(symbol));
        if (!hit) return { symbol, signature: "", doc: `symbol not found in ${p}` };
        const hover = await lsp.request<unknown>("textDocument/hover", {
          textDocument: { uri: pathToUri(abs) },
          position: { line: hit.line, character: hit.character },
        });
        const h = hover as { contents?: unknown } | null;
        const content =
          typeof h?.contents === "string"
            ? h.contents
            : Array.isArray(h?.contents)
              ? (h.contents as Array<{ value?: string } | string>).map((c) => (typeof c === "string" ? c : c.value ?? "")).join("\n")
              : (h?.contents as { value?: string } | undefined)?.value ?? "";
        return { symbol, line: hit.line, character: hit.character, signature: content, doc: "" };
      }
      return { symbol, signature: "", doc: "no language server available for this file type" };
    },
  });

  // ---- find_references: where a symbol is referenced -----------------------
  registry.register({
    name: "find_references",
    description:
      "Find all references to a symbol across the workspace. Requires a language server; returns up to 100 hits.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file containing the symbol" },
        symbol: { type: "string", description: "symbol name" },
        line: { type: "number", description: "0-based line of the symbol (optional)" },
      },
      required: ["path", "symbol"],
    },
    execute: async (args) => {
      const a = args as { path?: unknown; symbol?: unknown; line?: unknown; character?: unknown };
      const p = String(a.path ?? "");
      const symbol = String(a.symbol ?? "");
      if (!p || !symbol) throw new Error("path and symbol are required");
      const abs = intel.resolveInWorkspace(p);
      const unavailable = intel.unavailableFor(abs);
      if (unavailable) throw new Error(`code intel unavailable: ${unavailable}`);
      const { ts, lsp } = await intel.clientFor(abs);
      if (ts) {
        // Locate the declaration first (navto), then ask for references at
        // that position. tsserver's `references` returns { refs: [...] } with
        // 1-based line/offset; normalize to 0-based for the model.
        let line: number;
        let offset: number;
        if (a.line !== undefined && a.line !== null && Number(a.line) > 0) {
          // explicit 0-based position from the caller → 1-based tsserver
          line = Number(a.line) + 1;
          offset = Number(a.character ?? 0) + 1;
        } else {
          const at = await navtoLocate(ts, abs, symbol);
          if (!at) return { symbol, count: 0, references: [], note: `symbol not found in ${p} (navto)` };
          line = at.line;
          offset = at.offset;
        }
        const res = await ts.command<{ refs?: Array<{ file?: string; start?: { line?: number; offset?: number }; isDefinition?: boolean }> }>("references", {
          file: abs,
          line,
          offset,
        });
        const refs = res?.refs ?? [];
        return {
          symbol,
          count: refs.length,
          references: refs.slice(0, 100).map((r) => ({
            file: r.file ? relative(intel.root, r.file).split("\\").join("/") : "",
            line: (r.start?.line ?? 1) - 1,
            isDefinition: !!r.isDefinition,
          })),
        };
      }
      if (lsp) {
        const text = readFileSync(abs, "utf8");
        await openDocument(lsp, abs, text);
        let line = Number(a.line ?? 0);
        let character = 0;
        if (!a.line) {
          const items = await lsp.request<unknown>("textDocument/documentSymbol", {
            textDocument: { uri: pathToUri(abs) },
          });
          const flat = flattenDocumentSymbols(items);
          const hit = flat.find((s) => s.name === symbol) ?? flat.find((s) => s.name.includes(symbol));
          if (!hit) return { symbol, count: 0, references: [], note: `symbol not found in ${p}` };
          line = hit.line;
          character = hit.character;
        } else {
          character = Number(a.character ?? 0);
        }
        const res = await lsp.request<unknown>("textDocument/references", {
          textDocument: { uri: pathToUri(abs) },
          position: { line, character },
          context: { includeDeclaration: true },
        });
        const locs = Array.isArray(res) ? res : [];
        const refs = locs.map((l) => {
          const o = l as { uri?: string; range?: { start?: { line?: number; character?: number } } };
          return {
            file: o.uri ? relative(intel.root, uriToPath(o.uri)) : "",
            line: o.range?.start?.line ?? 0,
          };
        });
        return { symbol, count: refs.length, references: refs.slice(0, 100) };
      }
      return { symbol, count: 0, references: [] };
    },
  });
}

// ---- internal helpers exported for tests ---------------------------------
export function normalizeSymbols(items: unknown): Array<Record<string, unknown>> {
  // LSP DocumentSymbol[] (hierarchical) or SymbolInformation[].
  const out: Array<Record<string, unknown>> = [];
  const push = (s: Record<string, unknown>, depth: number): void => {
    out.push({
      name: s.name,
      kind: s.kind,
      detail: s.detail ?? "",
      line: (s.range as { start?: { line?: number } } | undefined)?.start?.line ?? 0,
      children: (s.children as Record<string, unknown>[] | undefined)?.length ?? 0,
    });
    if (depth < 4 && Array.isArray(s.children)) {
      for (const c of s.children as Record<string, unknown>[]) push(c, depth + 1);
    }
  };
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === "object") push(it as Record<string, unknown>, 0);
    }
  }
  return out;
}

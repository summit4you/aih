import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { publishFile } from "./atomic.js";
import { dirname, join, relative, resolve } from "node:path";
import type { ApprovalGate, LLMAdapter, ToolHooks, ToolRegistry } from "@aih/core";
import { AgentLoop, SessionLog, ToolRegistry as Registry } from "@aih/core";
import type { DiffLine } from "./diff.js";
import { lineDiff } from "./diff.js";
import { formatAfterWrite } from "./formatter.js";
import { bestOfN } from "./maxmode.js";
import { userAihDir } from "./paths.js";
import { extractShellContext } from "./shell-context.js";

export interface GeneralToolsOptions {
  cwd?: string;
  gate?: ApprovalGate;
  llm?: LLMAdapter | (() => LLMAdapter);
  toolsProvider?: () => ToolRegistry | undefined;
  ask?: (question: string, options?: string[]) => Promise<string>;
  hooks?: ToolHooks;
  /**
   * IT#1 — a provider for the live session log, so the `shell_context` tool
   * can read the recent `run_cmd` history on demand. Passed as a provider
   * (not a value) because the log is created after the registry is built;
   * the closure resolves at call time. Absent → `shell_context` is a no-op.
   */
  logProvider?: () => { all: () => readonly import("@aih/core").SessionEvent[] } | undefined;
  /**
   * Optional SECOND judge for `best_of_n` (Freebuff BuffBench two-judge
   * panel). Absent → single-judge mode (unchanged). Passed as a value or a
   * factory (resolved at call time, like `llm`). When present the two judges
   * run in parallel; a disagreement or a failed judge is flagged
   * (`judgeDegraded`) and warned, never silently dropped.
   */
  judge2?: LLMAdapter | (() => LLMAdapter | undefined);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build"]);
const MAX_GLOB = 500;
const MAX_GREP = 200;

/**
 * P#37② — recover the stateful-tool snapshot (todos) from a session log.
 * State-carrying tools stamp their FULL state into `details` on every write
 * (`{ kind: "state.todos", todos: [...] }`); the newest such result at or
 * before `beforeSeq` IS the timeline's state at that point — so /restore and
 * branch switches roll tool state back with the history, no sidecar files to
 * reconcile. Returns undefined when the log carries no todo state.
 */
export function todoStateFromLog(
  events: readonly { seq: number; type: string; ok?: boolean; result?: unknown }[],
  beforeSeq = Infinity,
): Array<{ content: string; status: string }> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i] as { seq: number; type: string; ok?: boolean; result?: { details?: { kind?: string; todos?: unknown } } };
    if (e.seq > beforeSeq) continue;
    if (e.type !== "tool/result" || e.ok === false) continue;
    const d = e.result?.details;
    if (d && d.kind === "state.todos" && Array.isArray(d.todos)) {
      return (d.todos as Array<{ content?: string; status?: string }>).map((t) => ({
        content: String(t.content ?? ""),
        status: String(t.status ?? "pending"),
      }));
    }
  }
  return undefined;
}

/** Write the recovered todo state back to .aih/todos.json (best-effort). */
export function applyTodoState(cwd: string, todos: Array<{ content: string; status: string }>): void {
  const p = join(cwd, ".aih", "todos.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ updatedAt: new Date().toISOString(), todos }, null, 2)}\n`);
}
const MAX_FETCH_BYTES = 1_500_000;
const MAX_CONTENT = 64_000;

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`${re}$`);
}

function walk(base: string, out: string[]): void {
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(full);
      }
    }
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  let body = html;
  const main = /<main[\s\S]*?<\/main>/i.exec(html) ?? /<article[\s\S]*?<\/article>/i.exec(html);
  if (main) body = main[0];
  return { title: decodeEntities(title), text: stripTags(body).replace(/\n{3,}/g, "\n\n").trim() };
}

// ── webfetch hardening (opencode/MiMo `tool/webfetch.ts` parity) ─────────────
// The old implementation was one-shot: a single 20s fetch with a bot UA, no
// retries, no Accept header, body downloaded before the size check, and bare
// error text ("webfetch failed: HTTP 403") that told the model nothing it
// could act on. In flaky networks that turned every transient blip into a
// visible failure. The seam below fixes that with zero new dependencies:
//   1. browser-grade UA + Accept/Accept-Language headers (bot-block resistance)
//   2. one bounded retry on network failures (connect/DNS/TLS/abort)
//   3. Cloudflare 403 + `cf-mitigated: challenge` → honest-UA retry (opencode)
//   4. configurable timeout: arg (s) > AIH_FETCH_TIMEOUT_MS > 30s, cap 120s
//   5. content-length precheck before downloading the body
//   6. actionable failure messages (FA#2 principle: tell the model what to DO)
export const FETCH_UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
export const FETCH_UA_HONEST = "aih (+harness)";
export const FETCH_ACCEPT_TEXT = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_MAX_TIMEOUT_MS = 120_000;
export const FETCH_RETRY_DELAY_MS = 500;

/** arg (seconds) > AIH_FETCH_TIMEOUT_MS (ms) > 30s default; hard cap 120s. */
export function resolveFetchTimeout(argSeconds: unknown, envMs?: string): number {
  let ms = FETCH_DEFAULT_TIMEOUT_MS;
  const env = Number(envMs ?? "");
  if (Number.isFinite(env) && env > 0) ms = env;
  const arg = Number(argSeconds);
  if (Number.isFinite(arg) && arg > 0) ms = arg * 1000;
  return Math.min(ms, FETCH_MAX_TIMEOUT_MS);
}

export function isCloudflareChallenge(res: Response): boolean {
  return res.status === 403 && String(res.headers.get("cf-mitigated") ?? "").toLowerCase().includes("challenge");
}

/** Actionable failure text (FA#2): state what happened AND what to try next. */
export function fetchFailureMessage(err: unknown, url: string, timeoutMs: number): string {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /abort/i.test(msg)) {
    return `webfetch timed out after ${Math.round(timeoutMs / 1000)}s: ${url}. The site may be unreachable from this network or very slow. Try a different endpoint (e.g. api.github.com instead of github.com), use websearch for an alternate source, or retry later.`;
  }
  if (/fetch failed/i.test(msg)) {
    return `webfetch connection failed for ${url} (DNS/TLS/network). This host may be blocked from the current network. Try a different endpoint, use websearch for an alternate source, or retry later.`;
  }
  return `webfetch failed: ${msg}`;
}

export interface FetchWithRetryOptions {
  timeoutMs: number;
  /** injectable for tests (default: global fetch) */
  fetchImpl?: typeof fetch;
  /** retry backoff in ms (default 500; pass 0 in tests) */
  delayMs?: number;
}

/**
 * One fetch with bounded self-healing: retry once on network failure, and on
 * a Cloudflare TLS-fingerprint challenge retry with an honest UA (opencode
 * parity). Returns the Response — the caller still checks `res.ok`.
 */
export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? FETCH_RETRY_DELAY_MS;
  const headers: Record<string, string> = {
    "user-agent": FETCH_UA_BROWSER,
    accept: FETCH_ACCEPT_TEXT,
    "accept-language": "en-US,en;q=0.9",
  };
  const attempt = async (h: Record<string, string>): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetchImpl(url, { signal: controller.signal, redirect: "follow", headers: h });
    } finally {
      clearTimeout(timer);
    }
  };
  let res: Response;
  try {
    res = await attempt(headers);
  } catch (first) {
    // bounded single retry for transient network failures (connect/DNS/TLS/abort)
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      res = await attempt(headers);
    } catch (second) {
      throw new Error(fetchFailureMessage(second, url, opts.timeoutMs));
    }
  }
  if (isCloudflareChallenge(res)) {
    try {
      const alt = await attempt({ ...headers, "user-agent": FETCH_UA_HONEST });
      if (alt.status !== 403) return alt;
    } catch (e) {
      throw new Error(fetchFailureMessage(e, url, opts.timeoutMs));
    }
  }
  return res;
}

function readToolFile(cwd: string, p: unknown): { file: string; text: string } {
  const file = resolve(cwd, String(p ?? ""));
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`not found: ${file}`);
  return { file, text: readFileSync(file, "utf8") };
}

export function registerGeneralTools(
  registry: ToolRegistry,
  opts: GeneralToolsOptions = {},
  hideWrites = false,
): void {
  const cwd = opts.cwd ?? process.cwd();
  const reg = (def: Parameters<ToolRegistry["register"]>[0]): void => {
    if (hideWrites && def.kind === "write") return;
    if (!registry.get(def.name)) registry.register(def);
  };

  reg({
    name: "edit",
    description:
      "Replace an exact string in a file. old_string must match the file content exactly; " +
      "if it occurs multiple times pass replace_all=true or make it more specific.",
    kind: "write",
    permission: "ask",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        old_string: { type: "string", description: "exact text to find (must be unique unless replace_all)" },
        new_string: { type: "string", description: "replacement text" },
        replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: async (args) => {
      const a = args as { path?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown };
      const oldString = String(a.old_string ?? "");
      if (!oldString) throw new Error("old_string is required");
      const { file, text } = readToolFile(cwd, a.path);
      const count = text.split(oldString).length - 1;
      if (count === 0) {
        throw new Error(
          `old_string not found in ${file}; read the file and retry with the exact text (whitespace included)`,
        );
      }
      if (count > 1 && !a.replace_all) {
        throw new Error(`old_string occurs ${count} times in ${file}; pass replace_all=true or a more specific old_string`);
      }
      const newString = String(a.new_string ?? "");
      const updated = a.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      publishFile(file, updated);
      // F#27: post-write auto-format (prettier/biome/eslint), never blocks.
      const fmt = await formatAfterWrite(file, cwd);
      return { path: file, replacements: a.replace_all ? count : 1, _diff: lineDiff(oldString, newString), ...fmt };
    },
  });

  reg({
    name: "glob",
    description: `Find files by glob pattern (supports ** and *), e.g. "**/*.ts". Relative to ${cwd}.`,
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob pattern" },
        path: { type: "string", description: "base directory (default: workspace)" },
      },
      required: ["pattern"],
    },
    execute: async (args) => {
      const a = args as { pattern?: unknown; path?: unknown };
      const pattern = String(a.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      const base = resolve(cwd, String(a.path ?? "."));
      const p = pattern.includes("/") ? pattern : `**/${pattern}`;
      const re = globToRegExp(p);
      const files: string[] = [];
      walk(base, files);
      const matches = files
        .map((f) => relative(base, f).split("\\").join("/"))
        .filter((rel) => re.test(rel))
        .sort()
        .slice(0, MAX_GLOB);
      return { base, pattern, count: matches.length, truncated: matches.length === MAX_GLOB, files: matches };
    },
  });

  reg({
    name: "grep",
    description: "Search file contents with a regex; returns file:line matches (first 200).",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern" },
        path: { type: "string", description: "file or directory to search (default: workspace)" },
        include: { type: "string", description: "glob filter for file names, e.g. \"*.ts\"" },
      },
      required: ["pattern"],
    },
    execute: async (args) => {
      const a = args as { pattern?: unknown; path?: unknown; include?: unknown };
      const pattern = String(a.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const root = resolve(cwd, String(a.path ?? "."));
      const includeRaw = String(a.include ?? "");
      const includeRe = includeRaw
        ? globToRegExp(includeRaw.includes("/") ? includeRaw : `**/${includeRaw}`)
        : null;
      const files: string[] = [];
      if (existsSync(root) && statSync(root).isFile()) files.push(root);
      else walk(root, files);
      const matches: Array<{ file: string; line: number; text: string }> = [];
      let scanned = 0;
      for (const file of files) {
        if (matches.length >= MAX_GREP) break;
        if (includeRe && !includeRe.test(relative(root, file).split("\\").join("/"))) continue;
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (text.slice(0, 8192).includes("\u0000")) continue;
        scanned += 1;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP; i += 1) {
          if (re.test(lines[i])) {
            matches.push({ file: relative(root, file).split("\\").join("/"), line: i + 1, text: lines[i].trim().slice(0, 400) });
          }
        }
      }
      return { pattern, scanned_files: scanned, count: matches.length, truncated: matches.length === MAX_GREP, matches };
    },
  });

  const todosPath = join(cwd, ".aih", "todos.json");
  reg({
    name: "todo",
    description:
      "Replace the session todo list (task tracking). Pass the full list with statuses " +
      "pending | in_progress | completed | cancelled; at most one in_progress. " +
      "The full list is also stamped into every tool/result (P#37② state-carrying), " +
      "so /restore and branch switches roll the todo state back with the timeline.",
    kind: "write",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "full todo list (replaces previous)",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute: async (args) => {
      const list = Array.isArray((args as { todos?: unknown }).todos) ? ((args as { todos: unknown[] }).todos as object[]) : [];
      const inProgress = list.filter((t) => (t as { status?: string }).status === "in_progress").length;
      if (inProgress > 1) throw new Error("at most one todo may be in_progress");
      mkdirSync(dirname(todosPath), { recursive: true });
      const body = JSON.stringify({ updatedAt: new Date().toISOString(), todos: list }, null, 2);
      writeFileSync(todosPath, `${body}\n`);
      const items = list.map((t) => {
        const item = t as { content?: string; status?: string };
        return { content: String(item.content ?? ""), status: String(item.status ?? "pending") };
      });
      const rendered = items.length
        ? items
            .map((item) => {
              const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : item.status === "cancelled" ? "-" : " ";
              return `${mark} [${item.status}] ${item.content}`;
            })
            .join("\n")
        : "(empty)";
      return {
        file: todosPath,
        count: items.length,
        list: rendered,
        todos: items,
        // P#37② — state-carrying result: the FULL todo snapshot rides inside
        // the tool/result event, so a restore/fork to any earlier seq makes
        // `todoStateFromLog(log)` return exactly this state again.
        details: { kind: "state.todos", todos: items },
      };
    },
  });

  reg({
    name: "remember",
    description:
      "Persist durable knowledge to memory.md so future sessions can recall it. " +
      "scope=project (default) writes .aih/memory.md; scope=user writes the cross-project " +
      "user memory (~/.local/share/aih/memory.md, XDG). action=append adds a dated entry; " +
      "action=set rewrites the whole file. Use for decisions, conventions, and facts that " +
      "must survive across sessions.",
    kind: "write",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["append", "set"],
          description: "append a dated entry, or set (replace) the whole memory",
        },
        text: { type: "string", description: "the memory content to store" },
        scope: {
          type: "string",
          enum: ["project", "user"],
          description: "project (default, .aih/memory.md) or user (cross-project, XDG data dir)",
        },
      },
      required: ["action", "text"],
    },
    execute: async (args) => {
      const a = args as { action?: unknown; text?: unknown; scope?: unknown };
      const action = String(a.action ?? "append");
      const text = String(a.text ?? "").trim();
      if (!text) throw new Error("remember requires non-empty text");
      const scope = String(a.scope ?? "project");
      if (scope !== "project" && scope !== "user") throw new Error(`remember: unknown scope "${scope}" (use project|user)`);
      const path = scope === "user" ? join(userAihDir(), "memory.md") : join(cwd, ".aih", "memory.md");
      const header = scope === "user" ? "# User memory" : "# Project memory";
      mkdirSync(dirname(path), { recursive: true });
      if (action === "set") {
        writeFileSync(path, `${header}\n\n${text}\n`);
      } else {
        const stamp = new Date().toISOString().slice(0, 10);
        const existing = existsSync(path) ? readFileSync(path, "utf8") : `${header}\n`;
        writeFileSync(path, `${existing.replace(/\s+$/, "")}\n\n- ${stamp} — ${text}\n`);
      }
      return { path, action, scope };
    },
  });

  reg({
    name: "question",
    description:
      "Ask the user a question and BLOCK until they answer (interactive sessions only). " +
      "Use this MANDATORILY whenever you need a decision, clarification, or confirmation from the user " +
      "that you cannot reasonably infer yourself — e.g. choosing between approaches, resolving ambiguity, " +
      "picking a scope, or confirming a risky action. Do NOT ask the user by writing the question as " +
      "assistant text and then continuing to act; that never reaches the user and the turn runs on " +
      "unconfirmed assumptions. Instead call this tool and wait for the answer before proceeding. " +
      "Provide 2-4 concrete `options` when the answer is one of a small known set (much better UX). " +
      "In headless (non-TTY) sessions this tool errors — then pick the most reasonable option yourself, " +
      "state the assumption, and continue.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "the question to ask the user" },
        options: {
          type: "array",
          description: "optional 2-4 concrete suggested answers the user can pick from",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
    execute: async (args) => {
      const a = args as { question?: unknown; options?: unknown };
      if (!opts.ask) throw new Error("no interactive channel available; run in `aih chat` (TTY) to use question");
      const answer = await opts.ask(String(a.question ?? ""), Array.isArray(a.options) ? (a.options as string[]) : undefined);
      return { answer };
    },
  });

  reg({
    name: "webfetch",
    description:
      "Fetch a URL and return its text content (HTML converted to plain text, max ~64KB). " +
      "Hardened: browser UA + Accept headers, one bounded network retry, Cloudflare-challenge self-heal, " +
      "configurable timeout. On failure the error says what to try next (alternate endpoint / websearch).",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "absolute http(s) URL" },
        format: { type: "string", enum: ["text", "markdown"], description: "output format (default text)" },
        timeout: {
          type: "number",
          description: "optional timeout in seconds (default 30, max 120; AIH_FETCH_TIMEOUT_MS overrides the default)",
        },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const a = args as { url?: unknown; timeout?: unknown };
      const url = String(a.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error("url must be absolute http(s)");
      const timeoutMs = resolveFetchTimeout(a.timeout, process.env.AIH_FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchWithRetry(url, { timeoutMs });
      } catch (e) {
        throw e instanceof Error ? e : new Error(fetchFailureMessage(e, url, timeoutMs));
      }
      if (!res.ok) {
        const cf = isCloudflareChallenge(res) ? " (Cloudflare bot challenge — the site is blocking non-browser clients)" : "";
        throw new Error(`webfetch failed: HTTP ${res.status}${cf}. Try a different endpoint (e.g. api.github.com instead of github.com) or use websearch for an alternate source.`);
      }
      const type = res.headers.get("content-type") ?? "";
      // content-length precheck (opencode parity): refuse before downloading
      const cl = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(cl) && cl > MAX_FETCH_BYTES) {
        throw new Error(`content too large: ${cl} bytes (limit ${MAX_FETCH_BYTES}); fetch a more specific page or use websearch`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_FETCH_BYTES) throw new Error(`content too large: ${buf.byteLength} bytes (limit ${MAX_FETCH_BYTES})`);
      const raw = buf.toString("utf8");
      if (type.includes("html")) {
        const { title, text } = htmlToText(raw);
        return { url, title, format: "text", chars: text.length, content: text.slice(0, MAX_CONTENT) };
      }
      return { url, format: "text", chars: raw.length, content: raw.slice(0, MAX_CONTENT) };
    },
  });

  reg({
    name: "websearch",
    description: "Web search (Parallel MCP); returns titles, URLs and snippets.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "search query" },
        max_results: { type: "number", description: "max results (default 8)" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const a = args as { query?: unknown; max_results?: unknown };
      const query = String(a.query ?? "");
      if (!query) throw new Error("query is required");
      const max = Math.min(20, Math.max(1, Number(a.max_results ?? 8) || 8));

      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective: query,
            search_queries: [query],
          },
        },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      let res: Response;
      try {
        res = await fetch("https://search.parallel.ai/mcp", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "User-Agent": "aih/0.2",
          },
          body,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`websearch failed: HTTP ${res.status}`);

      const raw = await res.text();
      // MCP responses may be SSE (data: ...) or plain JSON
      let json: any;
      for (const line of raw.split("\n")) {
        const trimmed = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
        if (!trimmed.startsWith("{")) continue;
        try { json = JSON.parse(trimmed); break; } catch { /* continue */ }
      }
      if (!json?.result?.content) throw new Error("websearch: invalid MCP response");

      const text = json.result.content.find((c: any) => c.type === "text")?.text;
      if (!text) throw new Error("websearch: no text in MCP response");

      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new Error("websearch: failed to parse search results"); }

      const results = (parsed.results ?? []).slice(0, max).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.excerpts ?? [])[0] ?? "",
      }));
      if (!results.length) throw new Error("no results (the search endpoint may be unavailable; try webfetch on a known URL)");
      return { query, count: results.length, results };
    },
  });

  reg({
    name: "apply_patch",
    description:
      "Apply a multi-file patch. Format: *** Begin Patch ... *** End Patch with sections " +
      "'*** Add File: <path>' (+ lines), '*** Delete File: <path>', '*** Update File: <path>' " +
      "(optional '*** Move to: <newpath>', then hunks of '@@ context' / '-' old lines / '+' new lines).",
    kind: "write",
    permission: "ask",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "full patch text" },
      },
      required: ["patch"],
    },
    execute: async (args) => {
      const a = args as { patch?: unknown };
      const patch = String(a.patch ?? "");
      const bodyMatch = /\*\*\* Begin Patch\n([\s\S]*?)\n?\*\*\* End Patch/.exec(patch);
      if (!bodyMatch) throw new Error("patch must be wrapped in '*** Begin Patch' ... '*** End Patch'");
      const lines = bodyMatch[1].split("\n");
      const applied: string[] = [];
      const written: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const add = /^\*\*\* Add File: (.+)$/.exec(line);
        if (add) {
          const path = resolve(cwd, add[1].trim());
          i += 1;
          const content: string[] = [];
          while (i < lines.length && !lineIsHeader(lines[i])) {
            if (!lines[i].startsWith("+")) throw new Error(`expected '+' line in Add File section at line ${i + 1}`);
            content.push(lines[i].slice(1));
            i += 1;
          }
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, `${content.join("\n")}\n`);
          applied.push(`A ${relative(cwd, path)}`);
          written.push(path);
          continue;
        }
        const del = /^\*\*\* Delete File: (.+)$/.exec(line);
        if (del) {
          const path = resolve(cwd, del[1].trim());
          if (!existsSync(path)) throw new Error(`cannot delete missing file: ${path}`);
          unlinkSync(path);
          applied.push(`D ${relative(cwd, path)}`);
          i += 1;
          continue;
        }
        const upd = /^\*\*\* Update File: (.+)$/.exec(line);
        if (upd) {
          let path = resolve(cwd, upd[1].trim());
          i += 1;
          let moveTo: string | undefined;
          const move = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? "");
          if (move) {
            moveTo = resolve(cwd, move[1].trim());
            i += 1;
          }
          const ops: Array<{ anchor?: string; remove: string[]; add: string[] }> = [];
          let op: { anchor?: string; remove: string[]; add: string[] } | undefined;
          while (i < lines.length && !lineIsHeader(lines[i])) {
            const l = lines[i];
            if (l.startsWith("@@")) {
              op = { anchor: l.slice(2).trim(), remove: [], add: [] };
              ops.push(op);
            } else if (l.startsWith("-")) {
              if (!op) throw new Error(`'-' line outside a hunk at line ${i + 1}`);
              op.remove.push(l.slice(1));
            } else if (l.startsWith("+")) {
              if (!op) throw new Error(`'+' line outside a hunk at line ${i + 1}`);
              op.add.push(l.slice(1));
            }
            i += 1;
          }
          if (!ops.length) throw new Error("Update File section has no hunks");
          const { file, text } = readToolFile(cwd, path);
          let updated = text;
          for (const o of ops) {
            const searchParts = [o.anchor, ...o.remove].filter((p) => p !== undefined && p !== "");
            if (!searchParts.length) throw new Error("empty hunk");
            const search = searchParts.join("\n");
            const idx = updated.indexOf(search);
            if (idx < 0) {
              throw new Error(`hunk not found in ${file}:\n${search.slice(0, 240)}`);
            }
            const replace = [o.anchor ?? "", ...o.add].filter((p) => p !== undefined).join("\n");
            updated = updated.slice(0, idx) + replace + updated.slice(idx + search.length);
          }
          if (moveTo) {
            mkdirSync(dirname(moveTo), { recursive: true });
            writeFileSync(moveTo, updated);
            unlinkSync(file);
            applied.push(`M ${relative(cwd, file)} -> ${relative(cwd, moveTo)}`);
            written.push(moveTo);
          } else {
            writeFileSync(file, updated);
            applied.push(`U ${relative(cwd, file)}`);
            written.push(file);
          }
          continue;
        }
        i += 1;
      }
      if (!applied.length) throw new Error("patch contained no file operations");
      // F#27: post-write auto-format for every file the patch touched.
      const fmt = await Promise.all(written.map((f) => formatAfterWrite(f, cwd)));
      const formattedCount = fmt.filter((f) => f.formatted).length;
      const notes = fmt.filter((f) => f.formatNote).map((f) => f.formatNote);
      const diff: DiffLine[] = [];
      for (const l of String(a.patch ?? "").split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++")) diff.push({ t: "add", s: l.slice(1) });
        else if (l.startsWith("-") && !l.startsWith("---")) diff.push({ t: "del", s: l.slice(1) });
      }
      return {
        applied,
        _diff: diff,
        ...(formattedCount > 0 ? { formatted: true, formattedFiles: formattedCount } : {}),
        ...(notes.length ? { formatNote: notes.join(" ; ") } : {}),
      };
    },
  });

  reg({
    name: "task",
    description:
      "Delegate a self-contained subtask to a focused subagent (own context, up to 8 steps, no nested tasks). " +
      "Use for research or multi-step work you want isolated from the main conversation.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "short (3-8 word) task label" },
        prompt: { type: "string", description: "full instructions for the subagent" },
      },
      required: ["description", "prompt"],
    },
    execute: async (args) => {
      const a = args as { description?: unknown; prompt?: unknown };
      const prompt = String(a.prompt ?? "");
      if (!prompt) throw new Error("task requires a prompt");
      if (!opts.gate || !opts.llm || !opts.toolsProvider) {
        throw new Error("task subagent is not wired in this context (chat only)");
      }
      const llm = typeof opts.llm === "function" ? opts.llm() : opts.llm;
      const parent = opts.toolsProvider();
      if (!parent) throw new Error("task subagent has no parent tool registry");
      const subRegistry = new Registry(opts.gate);
      for (const schema of parent.schemas()) {
        if (schema.name === "task" || schema.name === "question") continue;
        const def = parent.get(schema.name);
        if (def) subRegistry.register(def);
      }
      if (opts.hooks) subRegistry.addHooks(opts.hooks);
      const subLog = new SessionLog();
      const loop = new AgentLoop({
        llm,
        tools: subRegistry,
        log: subLog,
        systemPrompt:
          "You are a focused subagent of the AIH harness. Complete the assigned task with the available " +
          "tools and finish with one concise final answer covering what was done and key findings.",
        maxStepsPerTurn: 8,
      });
      const result = await loop.send(prompt);
      const lastAssistant = [...subLog.all()]
        .reverse()
        .find((e) => e.type === "assistant/message" && (e as { text?: string }).text);
      const rawAnswer = lastAssistant ? String((lastAssistant as { text: string }).text) : "(no final answer)";
      // CC#50 — honest partial marking: a subagent that hit its step limit (or
      // stopped for any non-end_turn reason) is NOT a finished answer. Prefix a
      // marker so the parent doesn't consume a truncated result as complete.
      const finished = result.stopReason === "end_turn";
      const answer = finished
        ? rawAnswer
        : `[partial — subagent stopped at ${result.stopReason ?? "step limit"}; re-delegate with a narrower prompt or ask it to continue] ${rawAnswer}`;
      return { description: String(a.description ?? ""), steps: result.steps, stopReason: result.stopReason, answer, partial: !finished };
    },
  });

  // P2#9 — Max Mode: N parallel subagents + a judge picks the best answer.
  reg({
    name: "best_of_n",
    description:
      "Max Mode: run N independent subagents in parallel and let a judge pick the best answer " +
      "(bounded concurrency, AIH_TOOL_CONCURRENCY). By default all N work on the same prompt; " +
      "pass `prompts` (an array of short strategy prompts) to run one subagent PER STRATEGY " +
      "(multi-strategy mode, wider exploration) — candidate i follows prompts[i % len]. " +
      "Use for high-stakes answers where one shot is not enough.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "short (3-8 word) task label" },
        prompt: { type: "string", description: "full instructions for every subagent (or the shared context when `prompts` is given)" },
        prompts: {
          type: "array",
          items: { type: "string" },
          description:
            "optional: one short implementation-strategy prompt per candidate (e.g. \"minimal change\", \"modularize into new files\", \"use a cache\"). " +
            "Candidate i follows prompts[i % length]; omit to run all N on the same `prompt`.",
        },
        n: { type: "number", description: "number of parallel candidates (default 3, max 8)" },
      },
      required: ["description", "prompt"],
    },
    execute: async (args) => {
      const a = args as { description?: unknown; prompt?: unknown; n?: unknown; prompts?: unknown };
      const prompt = String(a.prompt ?? "");
      if (!prompt) throw new Error("best_of_n requires a prompt");
      if (!opts.gate || !opts.llm || !opts.toolsProvider) {
        throw new Error("best_of_n is not wired in this context (chat only)");
      }
      const llm = typeof opts.llm === "function" ? opts.llm() : opts.llm;
      const n = Math.max(1, Math.min(8, Math.floor(Number(a.n ?? "") || 3)));
      const strategies = Array.isArray(a.prompts)
        ? a.prompts.map((p) => String(p).trim()).filter((p) => p.length > 0)
        : undefined;
      const judge2 =
        typeof opts.judge2 === "function" ? opts.judge2() : opts.judge2;
      const result = await bestOfN(
        { gate: opts.gate, llm, toolsProvider: opts.toolsProvider, hooks: opts.hooks },
        prompt,
        n,
        String(a.description ?? ""),
        strategies,
        judge2,
      );
      if (result.best < 0) throw new Error(`best_of_n: ${result.judgeReason}`);
      return result;
    },
  });

  // IT#1 — shell context awareness: the agent can reach for the recent shell
  // (run_cmd) output + exit codes on demand, so the user doesn't have to
  // paste them. Read-only, allow. No-op (empty) when there is no shell
  // history or the log is not wired in.
  reg({
    name: "shell_context",
    description:
      "IT#1: fetch the recent shell (run_cmd) context from this session — the most recent " +
      "commands with their exit codes, a bounded tail of each command's output, and the " +
      "full-output file path when keep_output was used. Use this to reason about the user's " +
      "shell (e.g. a failing command) without asking them to paste it. Returns { found: false } " +
      "when there is no shell history yet.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        max_commands: { type: "number", description: "how many most-recent commands to include (default 3, max 10)" },
        max_output_chars: { type: "number", description: "max output-tail chars per command (default 4000)" },
      },
      required: [],
    },
    execute: async (args) => {
      const a = args as { max_commands?: unknown; max_output_chars?: unknown };
      const log = opts.logProvider?.();
      if (!log) return { found: false, commands: [], note: "shell_context is not wired in this context" };
      const commands = extractShellContext(log.all(), {
        maxCommands: Math.max(1, Math.min(10, Math.floor(Number(a.max_commands ?? "") || 3))),
        maxOutputChars: Math.max(200, Math.floor(Number(a.max_output_chars ?? "") || 4000)),
      });
      if (commands.length === 0) {
        return { found: false, commands: [], note: "no shell history yet — run a command with run_cmd first" };
      }
      return {
        found: true,
        count: commands.length,
        commands: commands.map((c) => ({
          command: c.command,
          ...(c.cwd ? { cwd: c.cwd } : {}),
          code: c.code,
          ok: c.ok,
          timed_out: c.timedOut,
          output: c.output,
          output_truncated: c.outputTruncated,
          ...(c.outputFile ? { output_file: c.outputFile } : {}),
          ...(c.outputBytes !== undefined ? { output_bytes: c.outputBytes } : {}),
        })),
      };
    },
  });
}

function lineIsHeader(line: string): boolean {
  return (
    line.startsWith("*** Add File:") ||
    line.startsWith("*** Delete File:") ||
    line.startsWith("*** Update File:") ||
    line.startsWith("*** Move to:")
  );
}

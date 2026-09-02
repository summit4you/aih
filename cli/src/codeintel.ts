/**
 * AC#2 — Lightweight code intelligence via on-demand LSP (AtomCode borrow).
 *
 * Pooled language-server manager: one LSP client per project root + server
 * command, started lazily and reused across compatible extensions. Zero new
 * dependencies — a minimal JSON-RPC 2.0 client over stdio with
 * `Content-Length` framing, plus a thin adapter for `tsserver` (TypeScript's
 * native protocol, which is NOT standard LSP). Absence of a server binary
 * degrades gracefully: the tools report "server not available" instead of
 * crashing, and never block the main loop.
 *
 * All tools are `kind: "read"` / `permission: "allow"` so they join the
 * parallel read-only tool class (F#29).
 *
 * Security: file paths are normalized against the workspace root before any
 * query; a path outside the root is rejected (fail-closed) rather than sent
 * to the language server.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildChildEnv } from "./env-policy.js";

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0 framing (LSP uses Content-Length headers)              */
/* ------------------------------------------------------------------ */

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Encode an LSP message with Content-Length framing. */
export function frame(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`, "utf8");
}

/** A bounded incremental LSP message parser (buffers split frames). */
export class FrameParser {
  #buf = "";
  #maxFrame: number;

  constructor(maxFrame = 4 * 1024 * 1024) {
    this.#maxFrame = maxFrame;
  }

  /** Feed a chunk; return complete parsed JSON messages in order. */
  push(chunk: Buffer | string): unknown[] {
    this.#buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.#buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        // Header incomplete; if the buffer is huge, drop it (safety).
        if (this.#buf.length > 64 * 1024) this.#buf = this.#buf.slice(-64 * 1024);
        break;
      }
      const header = this.#buf.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.#buf = this.#buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (len > this.#maxFrame) {
        // Oversized frame: skip it rather than buffering unbounded data.
        this.#buf = this.#buf.slice(headerEnd + 4 + len);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.#buf.length < bodyStart + len) break; // wait for more bytes
      const body = this.#buf.slice(bodyStart, bodyStart + len);
      this.#buf = this.#buf.slice(bodyStart + len);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // malformed frame — skip
      }
    }
    return messages;
  }

  get buffered(): string {
    return this.#buf;
  }
}

/* ------------------------------------------------------------------ */
/* LSP client (one per server process)                                 */
/* ------------------------------------------------------------------ */

const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspSymbol {
  name: string;
  kind: string;
  kindLabel: string;
  /** file path relative to workspace root */
  path: string;
  /** 0-based line/character */
  line: number;
  character: number;
  containerName?: string;
}

/** A live language-server child process with JSON-RPC plumbing. */
export class LspClient {
  readonly root: string;
  readonly command: string;
  readonly args: string[];
  readonly adapter: "tsserver" | "lsp";

  #child: ChildProcessWithoutNullStreams | null = null;
  #parser = new FrameParser();
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #started: Promise<void> | null = null;
  #startError: string | null = null;
  /** tsserver stores responses with `request_seq` instead of `id`. */
  #isTsserver: boolean;

  constructor(root: string, command: string, args: string[], isTsserver = false) {
    this.root = root;
    this.command = command;
    this.args = args;
    this.adapter = isTsserver ? "tsserver" : "lsp";
    this.#isTsserver = isTsserver;
  }

  get available(): boolean {
    return this.#child !== null && !this.#child.killed;
  }

  get startError(): string | null {
    return this.#startError;
  }

  private async start(): Promise<void> {
    if (this.#started) return this.#started;
    this.#started = this.#doStart();
    return this.#started;
  }

  async #doStart(): Promise<void> {
    try {
      this.#child = spawn(this.command, this.args, {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LSP_MODE: undefined },
      });
    } catch (err) {
      this.#startError = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot spawn ${this.command}: ${this.#startError}`);
    }
    const child = this.#child;
    // Keep the server out of the parent's ref-count: when the CLI exits the
    // pipes close and the server sees EOF and terminates on its own.
    child.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const msg of this.#parser.push(chunk)) this.#onMessage(msg);
    });
    child.on("error", (err) => {
      this.#startError = err.message;
      this.#failAll(new Error(`language server ${this.command} error: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.#startError = `exited ${signal ? `with ${signal}` : `code ${code}`}`;
      this.#failAll(new Error(`language server ${this.command} exited`));
    });
  }

  #onMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    // tsserver responds with { request_seq } not { id }.
    const idRaw = m.id ?? m.request_seq;
    if (typeof idRaw === "number") {
      const waiter = this.#pending.get(idRaw);
      if (waiter) {
        this.#pending.delete(idRaw);
        if (m.error) waiter.reject(new Error(String((m.error as { message?: unknown })?.message ?? "rpc error")));
        else waiter.resolve(m.result);
      }
      return;
    }
    if (m.method === "window/logMessage" || m.method === "window/showMessage") {
      // ignore diagnostics noise
    }
  }

  #failAll(err: Error): void {
    for (const [, w] of this.#pending) w.reject(err);
    this.#pending.clear();
  }

  /** Send a request and await the response. */
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.start();
    if (!this.#child) throw new Error(`no language server for ${this.command}`);
    const id = this.#nextId++;
    // tsserver uses a different envelope: { seq, type: "request", command, arguments }.
    if (this.#isTsserver) {
      const envelope = {
        seq: id,
        type: "request",
        command: method,
        arguments: params ?? {},
      };
      this.#child.stdin.write(frame(envelope));
    } else {
      const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
      this.#child.stdin.write(frame(req));
    }
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting for ${method} (${this.command})`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Send a bare notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.#isTsserver) {
      // tsserver supports `{ type: "event", event, body }` — for initialize etc.
      // the handshake differs; the adapter handles it via request().
      return;
    }
    if (!this.#child) return;
    const n: RpcNotification = { jsonrpc: "2.0", method, params };
    this.#child.stdin.write(frame(n));
  }

  close(): void {
    try {
      this.#child?.stdin.end();
      this.#child?.kill();
    } catch {
      /* ignore */
    }
    this.#child = null;
  }
}

/* ------------------------------------------------------------------ */
/* LSP handshake + document sync                                       */
/* ------------------------------------------------------------------ */

export interface ServerCapabilities {
  /** supports textDocument/documentSymbol */
  documentSymbol: boolean;
  /** supports textDocument/definition */
  definition: boolean;
  /** supports textDocument/references */
  references: boolean;
  /** supports textDocument/callHierarchy */
  callHierarchy: boolean;
  /** supports textDocument/diagnostic (or publishDiagnostics) */
  diagnostics: boolean;
}

const NO_CAPS: ServerCapabilities = {
  documentSymbol: false,
  definition: false,
  references: false,
  callHierarchy: false,
  diagnostics: false,
};

export function pathToUri(p: string): string {
  const abs = resolve(p);
  return "file://" + (abs.startsWith("/") ? "" : "/") + abs;
}

export function uriToPath(uri: string): string {
  const m = /^file:\/\/(.+)$/.exec(uri);
  if (!m) return uri;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Initialize a standard LSP server and advertise capabilities. */
export async function initStandardLsp(client: LspClient): Promise<ServerCapabilities> {
  const init = await client.request<{
    capabilities?: Record<string, unknown>;
  }>("initialize", {
    processId: process.pid,
    clientInfo: { name: "aih", version: "0.x" },
    rootUri: pathToUri(client.root),
    capabilities: {
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        definition: { linkSupport: true },
        references: {},
        callHierarchy: {},
        synchronization: { didOpen: true, didChange: true, willSave: false },
      },
    },
  });
  client.notify("initialized", {});
  const caps = init?.capabilities ?? {};
  return {
    documentSymbol: !!(caps as Record<string, unknown>).documentSymbolProvider,
    definition: !!(caps as Record<string, unknown>).definitionProvider,
    references: !!(caps as Record<string, unknown>).referencesProvider,
    callHierarchy: !!(caps as Record<string, unknown>).callHierarchyProvider,
    diagnostics: !!(caps as Record<string, unknown>).diagnosticProvider,
  };
}

/** Open a file in the server so its symbols/calls are fresh. */
export async function openDocument(client: LspClient, filePath: string, text: string): Promise<void> {
  const uri = pathToUri(filePath);
  await client.request("textDocument/didOpen", {
    textDocument: { uri, languageId: languageFor(filePath), version: 1, text },
  });
}

function languageFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "hpp":
      return "cpp";
    default:
      return "plaintext";
  }
}

/* ------------------------------------------------------------------ */
/* tsserver adapter (TypeScript native protocol)                       */
/* ------------------------------------------------------------------ */

/**
 * tsserver is NOT standard LSP: it speaks its own JSON protocol over stdio
 * (newline-delimited JSON, no Content-Length framing) with `command` names
 * like `open`, `navtree`, `navto`, `quickinfo`, `references`, and 1-based
 * line/offset coordinates. The adapter translates queries onto those
 * commands and normalizes coordinates to the 0-based LSP convention.
 */
export interface TsServerClient {
  /** Send a command and await its response (tsserver line protocol). */
  command<T = unknown>(command: string, args?: unknown): Promise<T>;
  /**
   * Open a file before querying it. tsserver needs `open` (and the project
   * load it triggers) before navtree/navto/quickinfo/references return
   * anything. Idempotent per file; serialized across callers.
   */
  ensureOpen(absPath: string): Promise<void>;
}

/**
 * Resolve the tsserver command: a `tsserver` binary on PATH first, then the
 * project-local TypeScript install (run via node). Returns null when neither
 * exists — callers degrade gracefully.
 */
export function resolveTsServerCommand(root: string): { command: string; args: string[] } | null {
  // 1) Workspace-local TypeScript install — deterministic, no PATH games.
  //    (npm lifecycle runs put node_modules/.bin on PATH, so a bare spawnSync
  //    probe would false-positive on the npm shim; checking files cannot.)
  for (const rel of ["node_modules/typescript/bin/tsserver", "node_modules/typescript/lib/tsserver.js"]) {
    if (existsSync(join(root, rel))) {
      return { command: process.execPath, args: [join(root, rel)] };
    }
  }
  // 2) A real tsserver on PATH (global install). The npm-run PATH only
  //    surfaces our own node_modules/.bin shim, which points at the same
  //    local install — spawning through it would be two node hops for
  //    nothing, so it is skipped explicitly.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    if (dir.includes("node_modules/.bin")) continue;
    if (existsSync(join(dir, "tsserver"))) {
      return { command: "tsserver", args: [] };
    }
  }
  return null;
}

/** Build a tsserver client on top of a raw spawned process. */
export function createTsServerClient(root: string): TsServerClient {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buf = "";
  let seq = 1;
  let started = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** files already opened in this server session. */
  const opened = new Set<string>();
  /** serialization chain so concurrent ensureOpen calls cannot interleave. */
  let openChain: Promise<void> = Promise.resolve();

  const rejectAll = (message: string): void => {
    for (const w of pending.values()) w.reject(new Error(message));
    pending.clear();
  };

  /** Send on an already-started child (no start check — callers await start first). */
  function rawCommand<T>(command: string, args?: unknown): Promise<T> {
    if (!child) return Promise.reject(new Error("tsserver not available"));
    const id = seq++;
    child.stdin.write(JSON.stringify({ seq: id, type: "request", command, arguments: args ?? {} }) + "\n");
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`tsserver timed out for ${command}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  const start = async (): Promise<void> => {
    if (started) return;
    const resolved = resolveTsServerCommand(root);
    if (!resolved) {
      throw new Error(
        "tsserver not available: no `tsserver` on PATH and no node_modules/typescript install in this workspace",
      );
    }
    child = spawn(resolved.command, resolved.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      // same secret-filtering policy as run_cmd children (OC shell env policy).
      env: buildChildEnv(),
    });
    const c = child;
    // Same lifecycle rule as LspClient: never keep the agent alive for a
    // language server.
    c.unref();
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            request_seq?: number;
            seq?: number;
            success?: boolean;
            command?: string;
            message?: string;
            body?: unknown;
          };
          const id = msg.request_seq ?? msg.seq;
          if (typeof id === "number" && pending.has(id)) {
            const w = pending.get(id)!;
            pending.delete(id);
            if (msg.success === false) {
              w.reject(new Error(`tsserver ${msg.command ?? "request"} failed${msg.message ? `: ${msg.message}` : ""}`));
            } else {
              w.resolve(msg.body as never);
            }
          }
        } catch {
          /* skip malformed line */
        }
      }
    });
    c.on("error", (err) => rejectAll(`tsserver error: ${err.message}`));
    c.on("exit", (code) => rejectAll(`tsserver exited (${code})`));
    started = true;
  };

  return {
    async command<T>(command: string, args?: unknown): Promise<T> {
      await start();
      return rawCommand<T>(command, args);
    },

    async ensureOpen(absPath: string): Promise<void> {
      const task = openChain.then(async () => {
        if (opened.has(absPath)) return;
        await start();
        // The `open` request itself resolves only after the project graph is
        // ready (observed ~1.4s cold on this repo), so follow-up queries need
        // no sleeps.
        await rawCommand<void>("open", { file: absPath, projectRootPath: root });
        opened.add(absPath);
      });
      // Keep the chain alive even when this open failed (sticky per-file is
      // wrong: a transient failure must not poison every later query).
      openChain = task.catch(() => {});
      return task;
    },
  };
}

/**
 * Normalize tsserver `navtree` output into flat LspSymbol[]. tsserver is
 * 1-based (line/offset); coordinates are converted to 0-based (LSP style).
 */
export function navtreeToSymbols(
  tree: { childItems?: unknown[] } | null | undefined,
  root: string,
  file: string,
): LspSymbol[] {
  const out: LspSymbol[] = [];
  const walk = (items: unknown[], container?: string) => {
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const n = it as {
        text?: string;
        kind?: string;
        nameSpan?: { start?: { line?: number; offset?: number } };
        childItems?: unknown[];
      };
      const name = String(n.text ?? "");
      if (name && n.nameSpan?.start) {
        out.push({
          name,
          kind: String(n.kind ?? ""),
          kindLabel: String(n.kind ?? ""),
          path: relative(root, file).split("\\").join("/"),
          line: (n.nameSpan.start.line ?? 1) - 1,
          character: (n.nameSpan.start.offset ?? 1) - 1,
          containerName: container,
        });
      }
      if (Array.isArray(n.childItems)) walk(n.childItems, name || container);
    }
  };
  if (tree?.childItems) walk(tree.childItems);
  return out;
}

/* ------------------------------------------------------------------ */
/* Pooled manager                                                      */
/* ------------------------------------------------------------------ */

export interface LspServerSpec {
  /** command name on PATH */
  command: string;
  args?: string[];
  /** extensions this server handles (lowercase, no dot) */
  extensions: string[];
  /** true when the command is `tsserver` (native TS protocol) */
  tsserver?: boolean;
}

/** Common, actively-maintained language servers (checked on demand). */
export const DEFAULT_SERVER_SPECS: LspServerSpec[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  },
  { command: "tsserver", extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"], tsserver: true },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: ["py"],
  },
  {
    command: "basedpyright-langserver",
    args: ["--stdio"],
    extensions: ["py"],
  },
  { command: "rust-analyzer", extensions: ["rs"] },
  { command: "gopls", extensions: ["go"] },
  { command: "jdtls", extensions: ["java"] },
  { command: "clangd", extensions: ["c", "h", "cpp", "cc", "hpp"] },
];

export class CodeIntelPool {
  #root: string;
  /** cached availability of each command (probed once). */
  #availability = new Map<string, boolean>();
  /** standard LSP clients, keyed by `root|command`. */
  #lspClients = new Map<string, LspClient>();
  /** tsserver clients keyed by root. */
  #tsClients = new Map<string, TsServerClient>();
  /** sticky startup failures: `root|command` → message. */
  #unavailable = new Map<string, string>();
  specs: LspServerSpec[];

  constructor(root: string, specs: LspServerSpec[] = DEFAULT_SERVER_SPECS) {
    this.#root = resolve(root);
    this.specs = specs;
  }

  /** Workspace root (absolute, resolved). */
  get root(): string {
    return this.#root;
  }

  close(): void {
    for (const c of this.#lspClients.values()) c.close();
    this.#lspClients.clear();
    this.#tsClients.clear();
  }

  private commandAvailable(cmd: string): boolean {
    if (this.#availability.has(cmd)) return this.#availability.get(cmd)!;
    let ok = false;
    try {
      if (cmd === "tsserver") {
        // tsserver usually has no PATH binary; it ships inside the TypeScript
        // package. Resolve through the workspace-local install.
        ok = resolveTsServerCommand(this.#root) !== null;
      } else {
        const r = spawnSync(cmd, ["--version"], { timeout: 5000, stdio: "ignore" });
        ok = r.error === undefined && (r.status === 0 || r.status === null);
      }
    } catch {
      ok = false;
    }
    this.#availability.set(cmd, ok);
    return ok;
  }

  /** Pick a server spec for a file extension; returns null when none found/available. */
  specFor(ext: string): LspServerSpec | null {
    const e = ext.replace(/^\./, "").toLowerCase();
    for (const spec of this.specs) {
      if (spec.extensions.includes(e)) {
        if (this.commandAvailable(spec.command)) return spec;
      }
    }
    return null;
  }

  /** Sticky unavailable message for a file (or null when a server is usable). */
  unavailableFor(path: string): string | null {
    const ext = path.split(".").pop() ?? "";
    const spec = this.specFor(ext);
    if (!spec) {
      const candidates = this.specs
        .filter((s) => s.extensions.includes(ext))
        .map((s) => s.command)
        .join(", ");
      return `no language server available for .${ext} (checked: ${candidates || "none"})`;
    }
    const key = `${this.root}|${spec.command}`;
    return this.#unavailable.get(key) ?? null;
  }

  /** Get (or lazily start) a client for a file path. */
  async clientFor(path: string): Promise<{ spec: LspServerSpec; lsp?: LspClient; ts?: TsServerClient }> {
    const ext = path.split(".").pop() ?? "";
    const spec = this.specFor(ext);
    if (!spec) throw new Error(`no language server available for .${ext}`);
    const key = `${this.root}|${spec.command}`;
    if (this.#unavailable.has(key)) throw new Error(this.#unavailable.get(key)!);
    if (spec.tsserver) {
      let ts = this.#tsClients.get(this.root);
      if (!ts) {
        ts = createTsServerClient(this.root);
        this.#tsClients.set(this.root, ts);
      }
      return { spec, ts };
    }
    let client = this.#lspClients.get(key);
    if (!client) {
      client = new LspClient(this.root, spec.command, spec.args ?? ["--stdio"]);
      this.#lspClients.set(key, client);
      try {
        await initStandardLsp(client);
      } catch (err) {
        this.#unavailable.set(key, err instanceof Error ? err.message : String(err));
        client.close();
        this.#lspClients.delete(key);
        throw err;
      }
    }
    return { spec, lsp: client };
  }

  /** Normalize a caller path to an absolute path inside the workspace. */
  resolveInWorkspace(p: string): string {
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`path outside workspace: ${p}`);
    }
    return abs;
  }
}

/**
 * Flatten an LSP `textDocument/documentSymbol` response (hierarchical
 * DocumentSymbol[] OR flat SymbolInformation[]) into {name,line,character}
 * rows, coordinates taken from selectionRange/range/location (already
 * 0-based per LSP). Pure — exported for smoke tests.
 */
export function flattenDocumentSymbols(
  raw: unknown,
): Array<{ name: string; kind: string; line: number; character: number; container?: string }> {
  const out: Array<{ name: string; kind: string; line: number; character: number; container?: string }> = [];
  const posOf = (n: Record<string, unknown>): { line: number; character: number } => {
    const sel = n.selectionRange as { start?: { line?: unknown; character?: unknown } } | undefined;
    const range = n.range as { start?: { line?: unknown; character?: unknown } } | undefined;
    const loc = n.location as { range?: { start?: { line?: unknown; character?: unknown } } } | undefined;
    const pos = sel?.start ?? range?.start ?? loc?.range?.start;
    return { line: Number(pos?.line ?? 0), character: Number(pos?.character ?? 0) };
  };
  const walk = (node: unknown, container?: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, container);
      return;
    }
    const n = node as Record<string, unknown>;
    const name = String(n.name ?? "");
    if (name) {
      const pos = posOf(n);
      out.push({
        name,
        kind: String(n.kind ?? ""),
        line: pos.line,
        character: pos.character,
        container: container || (typeof n.containerName === "string" ? n.containerName : undefined),
      });
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c, name || container);
    }
  };
  walk(raw);
  return out;
}

/**
 * Locate a symbol's IDENTIFIER position via tsserver `navto`, ready for
 * quickinfo/references queries.
 *
 * Root cause this exists for: navto's `start` is the declaration SPAN start
 * (often offset 1 = line start), not the identifier itself. tsserver
 * `quickinfo`/`references` return nothing ("No content available.") unless
 * the position hits inside the identifier. We resolve the real column from
 * the source line (word-boundary match), falling back to backing off from
 * the span end. Returns 1-based {line, offset} or null when not found.
 */
export async function navtoLocate(
  ts: TsServerClient,
  file: string,
  symbol: string,
): Promise<{ line: number; offset: number } | null> {
  await ts.ensureOpen(file);
  const hits = await ts.command<
    Array<{
      name?: string;
      start?: { line?: number; offset?: number };
      end?: { line?: number; offset?: number };
    }>
  >("navto", { file, searchValue: symbol, maxResultCount: 10 });
  const hit = (hits ?? []).find((h) => h.name === symbol) ?? hits?.[0];
  if (!hit?.start) return null;
  const line = hit.start.line ?? 1;
  const startOffset = hit.start.offset ?? 1;
  const endOffset = hit.end?.offset ?? startOffset;
  const fallback = endOffset > symbol.length ? endOffset - symbol.length + 1 : startOffset;
  let offset = fallback;
  try {
    const lineText = readFileSync(file, "utf8").split("\n")[line - 1] ?? "";
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\b${esc}\\b`).exec(lineText);
    if (m && m.index !== undefined) offset = m.index + 1;
  } catch {
    /* unreadable source → keep fallback */
  }
  return { line, offset };
}

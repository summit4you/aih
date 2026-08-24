/**
 * P2#8 — serve / attach (headless harness + remote UI over HTTP/SSE).
 *
 * `aih serve --port N` runs the harness (MCP backend + agent loop) headless and
 * exposes it over a local HTTP server:
 *
 *   GET  /health          → { ok, version, session, model, busy, tools }
 *   GET  /events          → Server-Sent Events stream of session events
 *   POST /message         → { text } runs a turn (409 while busy)
 *   GET  /tools           → registered tool schemas
 *
 * `aih attach <url>` is a lightweight client: it follows the SSE stream and
 * renders the transcript, and sends typed lines to POST /message. This is the
 * "UI/backend separation" the MCP architecture already implies — solve SSH
 * lag by running the heavy harness on the box and attaching from anywhere.
 *
 * Zero new dependencies: node:http + a hand-rolled SSE reader.
 *
 * Streaming deltas are broadcast as `app/event` frames
 * (`source: "stream"`, `payload: { text }`) — the SessionEvent union has no
 * dedicated delta type, and app/event is the generic application channel.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentLoop, SessionLog, SessionStore, ToolRegistry } from "@aih/core";
import type { SessionEvent } from "@aih/core";
import { connectBackend, connectMultiBackend, type McpBackend } from "./mcp-backend.js";
import { resolveServers } from "./config.js";
import {
  attachAudit,
  bool,
  buildLlm,
  DEFAULT_SERVER_ENTRY,
  loadMemoryBlock,
  loadSystemPrompt,
  makeSessionGate,
  registerLocalTools,
  registerSkillTool,
  resolveContextWindow,
  str,
  withSkillRoster,
} from "./index.js";

export interface ServeServer {
  server: Server;
  port: number;
  host: string;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function startServe(
  flags: Record<string, string | boolean>,
): Promise<ServeServer> {
  const port = Number(str(flags, "port") ?? "") || 8787;
  const host = "127.0.0.1";
  const cwd = process.cwd();

  // --- backend (MCP) -------------------------------------------------------
  const resolved = resolveServers({
    flagServer: str(flags, "server"),
    bundled: { command: process.execPath, args: [DEFAULT_SERVER_ENTRY] },
  });
  const specs = (
    resolved.servers ?? [{ name: "todo", command: process.execPath, args: [DEFAULT_SERVER_ENTRY] }]
  ).map(({ name, command, args }: { name: string; command: string; args: string[] }) => ({
    name,
    command,
    args,
  }));
  const backend: McpBackend =
    specs.length === 1
      ? await connectBackend(specs[0].command, specs[0].args, { quiet: true })
      : await connectMultiBackend(specs, { quiet: true });

  // --- session / registry / loop ------------------------------------------
  const sessionName = str(flags, "session") ?? `serve-${Date.now().toString(36)}`;
  const sessionsDir = join(cwd, ".aih", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionPath = join(sessionsDir, `${sessionName}.jsonl`);
  const log = new SessionStore(sessionPath).load() ?? new SessionLog();
  const gate = makeSessionGate(flags);
  const registry = new ToolRegistry(gate);
  for (const def of await backend.listTools()) registry.register(def);
  const skills = registerSkillTool(registry);
  if (!bool(flags, "no-dev")) {
    registerLocalTools(registry, flags, gate, { current: null });
  }
  attachAudit(registry, flags);

  const llm = buildLlm(flags);
  const loop = new AgentLoop({
    llm,
    tools: registry,
    log,
    systemPrompt:
      withSkillRoster(loadSystemPrompt(), skills, resolveContextWindow(flags)) + loadMemoryBlock(),
    maxStepsPerTurn: Infinity,
    contextWindow: resolveContextWindow(flags),
    compactAt: 0.8,
  });

  let busy = false;
  const modelLabel = str(flags, "model") ?? process.env.AIH_MODEL ?? "(default)";
  const title = (): string => {
    try {
      return new SessionStore(sessionPath).title() ?? sessionName;
    } catch {
      return sessionName;
    }
  };
  const save = (): void => {
    try {
      new SessionStore(sessionPath).save(log);
    } catch {
      /* best-effort persistence */
    }
  };

  // --- SSE fan-out ---------------------------------------------------------
  const clients = new Set<ServerResponse>();
  const writeFrame = (res: ServerResponse, frame: string): void => {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  };
  const broadcast = (event: SessionEvent): void => {
    for (const res of clients) writeFrame(res, `data: ${JSON.stringify(event)}\n\n`);
  };
  log.subscribe(broadcast);
  // Ephemeral streaming deltas: broadcast as `app/event` wire frames but NOT
  // persisted — the `assistant/message` event is the canonical record (same
  // semantics as the TUI's in-memory pushDelta).
  const broadcastDelta = (text: string): void => {
    const frame = `data: ${JSON.stringify({ type: "app/event", source: "stream", payload: { text } })}\n\n`;
    for (const res of clients) writeFrame(res, frame);
  };

  // --- HTTP server ---------------------------------------------------------
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && url === "/health") {
      return json(res, 200, {
        ok: true,
        version: "0.2.0",
        session: sessionName,
        title: title(),
        model: modelLabel,
        busy,
        tools: registry.schemas().length,
      });
    }
    if (req.method === "GET" && url === "/tools") {
      return json(res, 200, registry.schemas());
    }
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Replay the existing session so a late attach sees history.
      for (const e of log.all()) writeFrame(res, `data: ${JSON.stringify(e)}\n\n`);
      res.write(": connected\n\n");
      clients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(": hb\n\n");
        } catch {
          clearInterval(heartbeat);
          clients.delete(res);
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url === "/message") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed: { text?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
        const text = String(parsed.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text is required" });
        if (busy) return json(res, 409, { error: "a turn is already in progress" });
        busy = true;
        try {
          const result = await loop.send(text, { onDelta: broadcastDelta });
          save();
          return json(res, 200, { ok: true, ...result });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          busy = false;
        }
      });
      return;
    }
    json(res, 404, { error: `no route for ${req.method} ${url}` });
  });

  return new Promise<ServeServer>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      process.on("exit", save);
      resolvePromise({
        server,
        port,
        host,
        close: async () => {
          for (const res of clients) {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
          clients.clear();
          save();
          backend.close();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

// --- attach client ----------------------------------------------------------
export interface AttachOptions {
  url: string;
  /** send a single line then exit (used by smoke tests / scripting) */
  sendOnce?: string;
  onEvent?: (e: SessionEvent) => void;
  /** wait until at least this many events arrived before closing (default 0) */
  minEvents?: number;
  /** max ms to wait for minEvents (default 5000) */
  timeoutMs?: number;
}

/**
 * Connect to a running `aih serve` instance: follow the SSE event stream and
 * (optionally) send a message. Used by the `aih attach` command and tests.
 */
export async function attach(opts: AttachOptions): Promise<{ events: SessionEvent[] }> {
  const base = opts.url.replace(/\/$/, "");
  const events: SessionEvent[] = [];

  const health = await fetch(`${base}/health`);
  if (!health.ok) throw new Error(`serve /health failed: ${health.status}`);

  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`serve /events failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readStream = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const e = JSON.parse(dataLine.slice(6)) as SessionEvent;
          events.push(e);
          opts.onEvent?.(e);
        } catch {
          /* skip malformed frame */
        }
      }
    }
  })();

  if (opts.sendOnce) {
    const post = await fetch(`${base}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: opts.sendOnce }),
    });
    if (!post.ok) {
      const body = await post.text().catch(() => "");
      throw new Error(`serve /message failed: ${post.status} ${body}`);
    }
  }

  const minEvents = opts.minEvents ?? 0;
  if (minEvents > 0) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    while (events.length < minEvents && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  } else if (opts.sendOnce) {
    // Let the stream flush the turn's events before we close.
    await new Promise((r) => setTimeout(r, 300));
  }

  controller.abort();
  try {
    await readStream;
  } catch {
    /* aborted */
  }
  return { events };
}

/**
 * Interactive attach: a minimal REPL over the SSE stream. Reads lines from
 * stdin, POSTs each to /message, and renders the transcript as events arrive.
 */
export async function attachInteractive(url: string): Promise<void> {
  const base = url.replace(/\/$/, "");
  const health = (await (await fetch(`${base}/health`)).json()) as {
    session?: string;
    model?: string;
  };
  process.stderr.write(
    `attached to ${base} — session ${health.session ?? "?"} · model ${health.model ?? "?"}\n`,
  );

  let streaming = "";
  const onEvent = (e: SessionEvent): void => {
    if (e.type === "app/event" && e.source === "stream") {
      const text = (e.payload as { text?: string } | undefined)?.text ?? "";
      streaming += text;
      process.stdout.write(text);
      return;
    }
    if (e.type === "turn/end") {
      if (streaming) process.stdout.write("\n");
      streaming = "";
      process.stdout.write(`\n${"─".repeat(40)}\n`);
      return;
    }
    if (e.type === "assistant/message" && e.text) {
      process.stdout.write(`\n${e.text}\n`);
    }
  };

  void attach({ url: base, onEvent });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pump = async (): Promise<void> => {
    for (;;) {
      const line = await new Promise<string>((resolve) => rl.question("you> ", resolve));
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") {
        rl.close();
        process.exit(0);
      }
      try {
        const post = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!post.ok) process.stderr.write(`\nerror: ${post.status} ${await post.text()}\n`);
      } catch (err) {
        process.stderr.write(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };
  void pump();
}

#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AgentLoop,
  MockLLM,
  OpenAICompatibleLLM,
  SessionLog,
  SessionStore,
  ToolRegistry,
  toolCall,
} from "@aih/core";
import type {
  ApprovalGate,
  SessionEvent,
  ToolDefinition,
  ToolHookInfo,
  ToolInvocationResult,
} from "@aih/core";
import { AutoApprove } from "@aih/core";

import { connectBackend, connectMultiBackend } from "./mcp-backend.js";
import type { McpBackend } from "./mcp-backend.js";
import { DenyGate, SessionGate } from "./gate.js";
import { loadPermissionRules, resolveLlm, resolveServers, savePermissionRule } from "./config.js";
import { cyan, dim, green, red, bold, toolTrace, turnFooter } from "./ui.js";
import { Tui } from "./tui.js";
import {
  BUILTIN_SKILLS,
  discoverSkills,
  installSkill,
  searchSkills,
  type Skill,
} from "./skills.js";
import { registerDevTools } from "./dev-tools.js";
import { registerGeneralTools } from "./general-tools.js";
import {
  T_AGENTS_MD,
  T_APP_MD,
  T_BOOTSTRAP,
  T_CI,
  T_CLAUDE_MD,
  T_CHECK,
  T_DECISIONS,
  T_DOCTOR,
  T_EVAL,
  T_GITIGNORE,
  T_HARNESS_YML,
  T_MCP_ADAPTER,
  T_MCP_INDEX,
  T_MCP_PACKAGE,
  T_MCP_TSCONFIG,
  T_TASK_TEMPLATE,
} from "./templates.js";

const VERSION = "0.2.0";
const DEFAULT_SERVER_ENTRY = fileURLToPath(
  new URL("../../mcp-server/dist/index.js", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const HELP = `aih — App Intelligence Harness CLI (${VERSION})

Usage:
  aih                             launch the interactive terminal (needs a TTY)
  aih run "<message>" [flags]     one-shot agent turn against the app
  aih chat                        interactive terminal session
  aih tools                       list tools exposed by the app server
  aih describe                    print the app descriptor
  aih session <list|show|rm|export|fork> [args]
                               fork: aih session fork [source] <target> [--from seq]
  aih stats                       token usage across saved sessions
  aih skills <list|find|install|show> [args]
                                  manage harness skills (SKILL.md packs)
  aih config                      print effective configuration and sources
  aih models                      list configured providers/models
  aih init [dir]                  scaffold a new app harness
  aih mcp                         serve the bundled todo-app over stdio
  aih doctor | check | eval       run harness scripts

Options:
  -m, --model <id>            model id (env AIH_MODEL > aih.json)
      --base-url <url>        OpenAI-compatible API base (env AIH_BASE_URL)
      --api-key <key>         API key (env AIH_API_KEY)
      --provider <name>       pick provider from aih.json providers
  -s, --server "<command>"    MCP server launch command; defaults to the
                              bundled todo-app server. For multiple servers set
                              \"mcpServers\" in aih.json (tools merged, duplicates
                              renamed <server>_<tool>)
      --max-steps <n>         max steps per turn (default 50, safety valve only)
  -y, --yes                   auto-approve ask-permission tools
      --mock                  scripted LLM for offline demo/testing
      --no-stream             buffer full responses instead of streaming
      --no-dev              chat only: disable the default local toolset — dev tools
                              (list_dir, read_file, write_file[ask], run_cmd[ask]) and
                              general tools (edit, glob, grep, todo, question, task,
                              webfetch, websearch, apply_patch) for chat; the one-shot
                              run command keeps the whole set opt-in via --dev
  -f, --format text|json      run output: human text or NDJSON event stream
      --no-audit              do not append tool calls to .aih/tool-audit.jsonl
                               (on by default; every invocation is recorded with ok/error)
     --session <name>        name a session (stored at .aih/sessions/<name>.jsonl);
                               without it, each launch starts a fresh auto-named
                               session and persists it unless --ephemeral is given
  -c, --continue [name]       resume a session (default: most recent) before
                               sending the new message
      --ephemeral             do not persist this session to disk
  -h, --help                  show help
  -v, --version               show version

Configuration (precedence: flags > env > project aih.json > ~/.aih/config.json):
  { "model", "baseUrl", "defaultProvider",
    "providers": { "<name>": { "baseUrl", "model", "apiKeyEnv" } },
    "mcpServers": { "<name>": { "command", "args?", "enabled?", "name?" } },
    "permissions": [ { "tool", "pattern?", "action": "allow|deny" } ] }

Environment:
  AIH_MODEL, AIH_BASE_URL, AIH_API_KEY, AIH_RETRIES, NO_COLOR
  AIH_CONTEXT_WINDOW (131072), AIH_COMPACT_AT (0.8), AIH_GOAL_ROUNDS (3)
  AIH_MEMORY_BUDGET (4000 chars of .aih/memory.md injected per turn)
  AIH_CMD_TIMEOUT_MS (120000 default run_cmd timeout)

Examples:
  aih run "add a todo buy milk" --mock
  aih run "what else?" -c                     # continue most recent session
  aih chat --session work
  aih init my-app && cd my-app && npm run bootstrap
  aih config                                  # inspect effective settings
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const valueFlags = new Set([
    "model",
    "base-url",
    "api-key",
    "server",
    "max-steps",
    "format",
    "session",
    "provider",
    "name",
    "from",
  ]);
  const optionalValueFlags = new Set(["continue", "c"]);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      let key = token.replace(/^--?/, "");
      let value: string | boolean = true;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (valueFlags.has(key)) {
        value = argv[++i] ?? true;
      } else if (optionalValueFlags.has(key)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i += 1;
        }
      }
      flags[key] = value;
    } else {
      positionals.push(token);
    }
    i += 1;
  }
  return { command: positionals.shift() ?? "", positionals, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Record<string, string | boolean>, ...keys: string[]): boolean {
  return keys.some((k) => flags[k] === true || flags[k] === "true");
}

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function buildLlm(flags: Record<string, string | boolean>) {
  if (bool(flags, "mock")) {
    return new MockLLM([
      {
        text: "",
        toolCalls: [toolCall("mock-1", "add_todo", { text: "from aih cli" })],
        stopReason: "tool_use",
      },
      { text: "Added via mock.", stopReason: "end_turn" },
    ]);
  }
  const resolved = resolveLlm({
    flagModel: str(flags, "model"),
    flagBaseUrl: str(flags, "base-url"),
    flagProvider: str(flags, "provider"),
    envModel: process.env.AIH_MODEL,
    envBaseUrl: process.env.AIH_BASE_URL,
  });
  const apiKey =
    str(flags, "api-key") ??
    process.env[resolved.apiKeyEnv] ??
    process.env.AIH_API_KEY;
  if (!apiKey) {
    console.error(
      `error: no API key. Set ${resolved.apiKeyEnv} (or AIH_API_KEY), pass --api-key, or use --mock for an offline demo.`,
    );
    process.exit(1);
  }
  if (!resolved.model.value) {
    console.error("error: no model id. Set AIH_MODEL, --model, or model in aih.json.");
    process.exit(1);
  }
  const retries = Number(process.env.AIH_RETRIES ?? "");
  return new OpenAICompatibleLLM({
    baseUrl: resolved.baseUrl.value ?? "https://api.openai.com/v1",
    apiKey,
    model: resolved.model.value,
    ...(Number.isFinite(retries) ? { retries } : {}),
  });
}

function loadMemoryBlock(cwd = process.cwd()): string {
  const path = join(cwd, ".aih", "memory.md");
  if (!existsSync(path)) return "";
  let text = readFileSync(path, "utf8").trim();
  if (!text) return "";
  const budget = Number(process.env.AIH_MEMORY_BUDGET ?? "") || 4000;
  if (text.length > budget) text = `${text.slice(0, budget)}\n…(truncated)`;
  return `\n\n# Project memory (persistent across sessions; keep it current with the remember tool)\n${text}`;
}

function loadSystemPrompt(): string {
  const appMd = `${process.cwd()}/APP.md`;
  if (existsSync(appMd)) {
    const content = readFileSync(appMd, "utf8");
    return [
      "You are the in-app intelligence of the application described below.",
      "Follow its contract strictly; prefer read actions; write actions may require approval.",
      "",
      content.slice(0, 6000),
    ].join("\n");
  }
  return "You are an in-app assistant operating the connected application through its tools.";
}

function makeBaseGate(flags: Record<string, string | boolean>): ApprovalGate {
  return bool(flags, "yes", "y") ? new AutoApprove() : new DenyGate();
}

function makeSessionGate(flags: Record<string, string | boolean>): SessionGate {
  return new SessionGate(
    makeBaseGate(flags),
    loadPermissionRules(),
    (rule) => savePermissionRule(rule),
  );
}

function registerSkillTool(registry: ToolRegistry): Skill[] {
  const skills = discoverSkills();
  if (!skills.length) return skills;
  registry.register({
    name: "load_skill",
    description:
      "Load a harness skill's full instructions into context. Available: " +
      skills.map((s) => s.name).join(", "),
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "skill name" } },
      required: ["name"],
    },
    execute: async (args) => {
      const name = String((args as { name?: unknown }).name ?? "");
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        throw new Error(
          `unknown skill: ${name}; available: ${skills.map((s) => s.name).join(", ")}`,
        );
      }
      return skill.body.slice(0, 6000);
    },
  });
  return skills;
}

function withSkillRoster(prompt: string, skills: Skill[]): string {
  if (!skills.length) return prompt;
  return `${prompt}\n\n## Skills\n${skills
    .map((s) => `- ${s.name}: ${s.description} (call load_skill to activate)`)
    .join("\n")}`;
}

function makeStdinAsk(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("the question tool needs an interactive terminal; run `aih chat`"));
      return;
    }
    process.stderr.write(`❓ ${question}\n> `);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function auditHooks(cwd: string) {
  const path = join(cwd, ".aih", "tool-audit.jsonl");
  return {
    after: (info: ToolHookInfo, outcome: ToolInvocationResult) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const entry = {
          ts: Date.now(),
          tool: info.name,
          args: JSON.stringify(info.args ?? {}).slice(0, 4096),
          ok: outcome.ok,
          error: outcome.error ?? undefined,
        };
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      } catch {
        /* audit must never break the turn */
      }
    },
  };
}

function attachAudit(registry: ToolRegistry, flags: Record<string, string | boolean>, cwd = process.cwd()): void {
  if (!bool(flags, "no-audit")) registry.addHooks(auditHooks(cwd));
}

function registerLocalTools(
  registry: ToolRegistry,
  flags: Record<string, string | boolean>,
  gate: ApprovalGate,
  tuiRef: { current: Tui | null },
  hideWrites = false,
): void {
  registerDevTools(registry, process.cwd(), hideWrites);
  registerGeneralTools(
    registry,
    {
      gate,
      llm: () => buildLlm(flags),
      toolsProvider: () => registry,
      ask: (q) => (tuiRef.current ? tuiRef.current.askQuestion(q) : makeStdinAsk(q)),
      ...(bool(flags, "no-audit") ? {} : { hooks: auditHooks(process.cwd()) }),
    },
    hideWrites,
  );
}

const SESSIONS_DIR = ".aih/sessions";

function latestSessionName(): string | undefined {
  if (!existsSync(SESSIONS_DIR)) return undefined;
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return undefined;
  const newest = files
    .map((f) => ({ f, m: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest.f.replace(/\.jsonl$/, "");
}

function freshSessionName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  let name = `s-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  if (existsSync(join(SESSIONS_DIR, `${name}.jsonl`))) {
    name += `-${Math.random().toString(36).slice(2, 6)}`;
  }
  return name;
}

function resolveSessionPath(flags: Record<string, string | boolean>): string | undefined {
  let name = str(flags, "session");
  const cont = flags["continue"] ?? flags["c"];
  if (!name && cont !== undefined) {
    name =
      typeof cont === "string" && cont
        ? cont
        : latestSessionName();
    if (!name) {
      console.error("error: --continue found no saved session (use --session <name> first)");
      process.exit(1);
    }
  }
  return name ? join(SESSIONS_DIR, `${name}.jsonl`) : undefined;
}

function loadSession(path?: string): SessionLog {
  if (!path) return new SessionLog();
  return new SessionStore(path).load() ?? new SessionLog();
}

function saveSession(path: string | undefined, log: SessionLog): void {
  if (!path) return;
  mkdirSync(SESSIONS_DIR, { recursive: true });
  new SessionStore(path).save(log);
}

function replayHistory(tui: Tui, events: readonly SessionEvent[]): void {
  for (const e of events) {
    if (e.type === "user/message") {
      tui.push({ role: "user", text: e.text });
    } else if (e.type === "assistant/message" && e.text) {
      tui.push({ role: "assistant", text: e.text });
    } else if (e.type === "tool/call") {
      tui.pushTool(e.name, e.args, e.callId);
    } else if (e.type === "tool/result") {
      tui.resolveTool(e.callId, e.ok, e.result);
    } else if (e.type === "compaction") {
      tui.pushSystem("── compacted (earlier context summarized) ──");
    }
  }
}

async function startBackend(
  flags: Record<string, string | boolean>,
  quiet = false,
): Promise<McpBackend> {
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
  if (specs.length === 1) {
    return connectBackend(specs[0].command, specs[0].args, { quiet });
  }
  return connectMultiBackend(specs, { quiet });
}

function wireTrace(log: SessionLog, format: string): { lastAssistant(): string } {
  let lastAssistant = "";
  log.subscribe((event: SessionEvent) => {
    if (format === "json") {
      console.log(JSON.stringify(event));
      return;
    }
    switch (event.type) {
      case "tool/call":
        process.stderr.write(`${toolTrace(event.name, event.args)}\n`);
        break;
      case "tool/result":
        if (!event.ok) {
          process.stderr.write(`${red(`✗ ${event.callId} failed`)} ${event.error ?? ""}\n`);
        }
        break;
      case "assistant/message":
        lastAssistant = event.text;
        break;
      default:
        break;
    }
  });
  return { lastAssistant: () => lastAssistant };
}

async function cmdRun(positionals: string[], flags: Record<string, string | boolean>) {
  const piped = await readPipedStdin();
  const typed = positionals.join(" ");
  const message = [typed, piped].filter(Boolean).join("\n");
  if (!message.trim()) {
    console.error('error: run needs a message, e.g. aih run "summarize open todos"');
    process.exit(1);
  }

  const format = str(flags, "format") ?? "text";
  if (format !== "text" && format !== "json") {
    console.error(`error: unknown format "${format}" (use text|json)`);
    process.exit(1);
  }

  const backend = await startBackend(flags);
  const sessionPath = bool(flags, "ephemeral")
    ? undefined
    : (resolveSessionPath(flags) ?? join(SESSIONS_DIR, `${freshSessionName()}.jsonl`));
  try {
    const gate = makeSessionGate(flags);
    const registry = new ToolRegistry(gate);
    for (const def of await backend.listTools()) registry.register(def);
    const skills = registerSkillTool(registry);
    if (bool(flags, "dev")) registerLocalTools(registry, flags, gate, { current: null });
    attachAudit(registry, flags);

    const log = loadSession(sessionPath);
    process.on("exit", () => saveSession(sessionPath, log));
    if (sessionPath && !existsSync(sessionPath)) {
      process.stderr.write(`${dim(`[session: new ${sessionPath}]`)}\n`);
    } else if (sessionPath) {
      process.stderr.write(
        `${dim(`[session: resumed ${sessionPath} (${log.all().length} events)]`)}\n`,
      );
    }
    const trace = wireTrace(log, format);
    const streaming = format === "text" && !bool(flags, "no-stream") && !bool(flags, "mock");

    const loop = new AgentLoop({
      llm: buildLlm(flags),
      tools: registry,
      log,
      systemPrompt: withSkillRoster(loadSystemPrompt(), skills) + loadMemoryBlock(),
      maxStepsPerTurn: Number(str(flags, "max-steps") ?? 50) || 50,
      contextWindow: Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 131072,
      compactAt: Number(process.env.AIH_COMPACT_AT ?? "") || 0.8,
    });

    let result: Awaited<ReturnType<AgentLoop["send"]>>;
    try {
      result = await loop.send(
        message,
        streaming ? { onDelta: (d) => process.stdout.write(d) } : undefined,
      );
    } finally {
      saveSession(sessionPath, log);
    }
    if (format === "text") {
      if (!streaming) {
        const text = trace.lastAssistant();
        if (text.trim()) console.log(text);
      } else {
        process.stdout.write("\n");
      }
      process.stderr.write(
        `${turnFooter([
          `turn ${result.turnId}`,
          `${result.steps} step(s)`,
          result.stopReason,
          result.usage
            ? `tokens ${result.usage.promptTokens}/${result.usage.completionTokens}/${result.usage.totalTokens}`
            : undefined,
        ])}\n`,
      );
    }
  } finally {
    backend.close();
  }
}

async function cmdChat(flags: Record<string, string | boolean>) {
  if (!process.stdin.isTTY) {
    console.error("error: chat needs a terminal; use `aih run` for non-interactive turns");
    process.exit(1);
  }

  const backend = await startBackend(flags, true);
  const sessionPath = bool(flags, "ephemeral")
    ? undefined
    : (resolveSessionPath(flags) ?? join(SESSIONS_DIR, `${freshSessionName()}.jsonl`));
  const gate = makeSessionGate(flags);
  const backendDefs = await backend.listTools();
  let agentMode: "build" | "plan" = "build";
  let registry = new ToolRegistry(gate);
  let skills: Skill[] = [];
  const tuiRef: { current: Tui | null } = { current: null };
  function rebuildRegistry(): void {
    registry = new ToolRegistry(gate);
    for (const def of backendDefs) {
      if (agentMode === "build" || def.kind !== "write") registry.register(def);
    }
    skills = registerSkillTool(registry);
    if (!bool(flags, "no-dev")) {
      registerLocalTools(registry, flags, gate, tuiRef, agentMode === "plan");
    }
    attachAudit(registry, flags);
  }
  rebuildRegistry();
  const appInfo = await backend.describe().catch(() => undefined);
  const appName =
    (appInfo && typeof appInfo === "object" && "name" in appInfo
      ? String((appInfo as { name: unknown }).name)
      : "") || "todo-app";

  const log = loadSession(sessionPath);
  process.on("exit", () => saveSession(sessionPath, log));
  const PLAN_PROMPT =
    "\n\nYou are in plan mode (read-only): write-capable tools are hidden in this " +
    "mode. Investigate with the available tools, then present a concrete step-by-step " +
    "implementation plan. Do not attempt to change any state.";
  const maxSteps = Number(str(flags, "max-steps") ?? 50) || 50;
  function makeLoop(): AgentLoop {
    return new AgentLoop({
      llm: buildLlm(flags),
      tools: registry,
      log,
      systemPrompt:
        withSkillRoster(loadSystemPrompt(), skills) +
          (agentMode === "plan" ? PLAN_PROMPT : "") +
          loadMemoryBlock(),
      maxStepsPerTurn: maxSteps,
      contextWindow: Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 131072,
      compactAt: Number(process.env.AIH_COMPACT_AT ?? "") || 0.8,
    });
  }
  let loop = makeLoop();
  const streaming = !bool(flags, "no-stream") && !bool(flags, "mock");
  let busy = false;
  let goalCondition = "";
  let goalRoundsLeft = 0;
  let echoEvents = false;
  let usedTokens = 0;
  let peakTokens = 0;

  const sessionName = sessionPath
    ? `${existsSync(sessionPath) ? "" : "new "}${basename(sessionPath)}`
    : "ephemeral";
  const initialTitle = sessionPath
    ? new SessionStore(sessionPath).title()
    : undefined;

  let modelLabel = String(
    bool(flags, "mock")
      ? "mock"
      : str(flags, "model") ??
          process.env.AIH_MODEL ??
          resolveLlm({}).model.value ??
          "?",
  );
  let providerLabel = bool(flags, "mock")
    ? "mock"
    : resolveLlm({
          flagModel: str(flags, "model"),
          flagBaseUrl: str(flags, "base-url"),
          flagProvider: str(flags, "provider"),
          envModel: process.env.AIH_MODEL,
          envBaseUrl: process.env.AIH_BASE_URL,
        }).provider ?? "custom";

  const tui = new Tui({
    placeholder: 'Ask anything... "add a todo"',
    meta: () => ({ agent: agentMode, model: modelLabel, provider: providerLabel }),
    cwd: process.cwd(),
    statusLeft: `${appName} · aih ${VERSION}`,
    statusRight: `S:${initialTitle ?? sessionName}`,
    statusBadge: () => {
      const n = registry.schemas().length;
      return { glyph: "⊙", ok: n > 0, label: `${n} MCP` };
    },
    busy: () => busy,
    cancelTurn: () => loop.cancel(),
    onLine: handleLine,
    onTab: () => setMode(agentMode === "build" ? "plan" : "build"),
    completions: () => [
      "/tools",
      "/mode",
      "/goal",
      "/memory",
      "/model",
      "/usage",
      "/clear",
      "/inject",
      "/events",
      "/skills",
      ...skills.map((s) => `/${s.name}`),
    ],
    ctxUsage: () => ({
      used: usedTokens,
      limit: Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 131072,
    }),
  });
  void echoEvents;
  gate.attachTui(tui);
  tuiRef.current = tui;

  function setMode(mode: "build" | "plan"): void {
    if (agentMode === mode) return;
    if (busy) {
      tui.pushSystem("finish the current turn before switching mode");
      return;
    }
    agentMode = mode;
    rebuildRegistry();
    loop = makeLoop();
    tui.pushSystem(
      mode === "plan"
        ? "mode: plan — read-only (write tools hidden)"
        : "mode: build — full toolset",
    );
  }

  log.subscribe((event: SessionEvent) => {
    if (event.type === "tool/call") {
      tui.pushTool(event.name, event.args, event.callId);
    } else if (event.type === "tool/result") {
      tui.resolveTool(event.callId, event.ok !== false, event.result);
     } else if (event.type === "assistant/message" && streaming === false && event.text) {
        tui.push({ role: "assistant", text: event.text });
      } else if (event.type === "compaction") {
        const window = Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 131072;
        const pct = usedTokens ? Math.round((usedTokens / window) * 100) : null;
        tui.pushSystem(
          pct !== null
            ? `context ~${pct}% — compacted (earlier messages summarized, continuing)`
            : "compacted (earlier messages summarized, continuing)",
        );
      }
    });

  tui.start();
  tui.push({
    role: "banner",
    text: ["█▀▀▀ ▀█▀ █ █", "█▄▄█  █  ███", "█  █ ▄█▄ █ █"].join("\n"),
  });
  tui.pushSystem(`app intelligence harness · v${VERSION}\n`);
  if (sessionPath && log.all().length) {
    const events = log.all();
    tui.pushSystem(`resumed session ${sessionPath} (${events.length} events)`);
    replayHistory(tui, events);
  }

  function evalTurn(
    input: string,
  ): Promise<Awaited<ReturnType<AgentLoop["send"]>>> {
    busy = true;
    const promise = loop
      .send(
        input,
        streaming
          ? { onDelta: (d) => tui.pushDelta(d), onRetry: () => tui.resetStream() }
          : undefined,
      )
      .finally(() => {
        busy = false;
      });
    return promise;
  }

  async function judgeGoal(): Promise<{ met: boolean; reason: string }> {
    const resp = await buildLlm(flags).complete({
      messages: [
        ...log.deriveMessages(),
        {
          role: "user",
          content:
            `You are an impartial progress judge. The stated goal is: "${goalCondition}".\n` +
            "Decide ONLY from the conversation above whether the goal has been fully achieved.\n" +
            'Reply with exactly one line of JSON: {"met": true|false, "reason": "<one short line>"}',
        },
      ],
      tools: [],
    });
    const met = /"met"\s*:\s*(true|false)/.exec(resp.text)?.[1] === "true";
    const reason =
      /"reason"\s*:\s*"([^"]*)"/.exec(resp.text)?.[1] ?? resp.text.slice(0, 200);
    return { met, reason };
  }

  async function runGoalCheck(): Promise<void> {
    if (!goalCondition) return;
    for (;;) {
      let verdict: { met: boolean; reason: string };
      try {
        verdict = await judgeGoal();
      } catch (err) {
        goalCondition = "";
        tui.pushError(
          `goal judge failed, stopping goal chain: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (verdict.met) {
        goalCondition = "";
        goalRoundsLeft = 0;
        tui.pushSystem(`✅ goal met — ${verdict.reason}`);
        return;
      }
      if (goalRoundsLeft <= 0) {
        goalCondition = "";
        tui.pushSystem(
          `⏹ goal not met after auto-continue rounds — stopping (${verdict.reason})`,
        );
        return;
      }
      goalRoundsLeft -= 1;
      tui.pushSystem(
        `↻ goal check: not yet met — ${verdict.reason} (auto-continuing, ${goalRoundsLeft} left)`,
      );
      const started = Date.now();
      try {
        await evalTurn(
          `[goal] The goal "${goalCondition}" is not yet met. Judge's note: ${verdict.reason}\nContinue working until the goal is fully achieved.`,
        );
        saveSession(sessionPath, log);
        const dur = Date.now() - started;
        tui.push({
          role: "footer",
          text: `▣ build · ${modelLabel} · goal-continue · ${fmtDur(dur)}`,
        });
      } catch (err) {
        goalCondition = "";
        tui.pushError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
  }

  let titled = false;
  async function ensureTitle(): Promise<void> {
    if (!sessionPath || titled) return;
    titled = true;
    try {
      const store = new SessionStore(sessionPath);
      if (store.title()) {
        tui.setStatusRight(`S:${store.title()}`);
        return;
      }
      const firstUser = log.all().find((e) => e.type === "user/message");
      const lastAssistant = [...log.all()]
        .reverse()
        .find((e) => e.type === "assistant/message" && (e as { text?: string }).text);
      if (!firstUser || !lastAssistant) return;
      const resp = await buildLlm(flags).complete({
        messages: [
          { role: "system", content: "You name conversations. Reply with only the title." },
          {
            role: "user",
            content:
              `User asked: ${String((firstUser as { text?: string }).text ?? "").slice(0, 300)}\n` +
              `Assistant answered: ${String((lastAssistant as { text?: string }).text ?? "").slice(0, 300)}\n\n` +
              "Give this conversation a short title (2-6 words, no quotes, no period).",
          },
        ],
        tools: [],
      });
      const t = resp.text.trim().split("\n")[0].trim().slice(0, 60);
      if (!t) return;
      store.setTitle(t);
      tui.setStatusRight(`S:${t}`);
    } catch {
      /* title is best-effort */
    }
  }

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) return;

    tui.push({ role: "user", text: line });

    if (input === "/exit" || input === "/quit") {
      tui.stop();
      backend.close();
      process.exit(0);
    }
    if (input === "/clear") {
      tui.clearItems();
      return;
    }
    if (input === "/tools") {
      const rows: string[] = [];
      for (const schema of registry.schemas()) {
        const def = registry.get(schema.name);
        if (!def) continue;
        rows.push(
          `${schema.name.padEnd(24)} ${String(def.kind).padEnd(6)} ${permLabel(def.permission).padEnd(7)} ${schema.description}`,
        );
      }
      tui.pushSystem(rows.join("\n"));
      return;
    }
    if (input === "/events") {
      echoEvents = !echoEvents;
      tui.pushSystem(`event echo ${echoEvents ? "on" : "off"}`);
      return;
    }
    if (input === "/skills") {
      const rows = skills.map(
        (s) => `${`/${s.name}`.padEnd(20)} ${s.scope.padEnd(8)} ${s.description}`,
      );
      tui.pushSystem(
        rows.length
          ? rows.join("\n")
          : "no skills installed; try `aih skills install app-tour`",
      );
      return;
    }
    if (input === "/usage") {
      const ends = log.all().filter((e) => e.type === "turn/end");
      let prompt = 0;
      let completion = 0;
      let total = 0;
      for (const e of ends) {
        const u = e.type === "turn/end" ? e.usage : undefined;
        if (u) {
          prompt += u.promptTokens;
          completion += u.completionTokens;
          total += u.totalTokens;
        }
      }
      const limit = Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 131072;
      tui.pushSystem(
        [
          `turns: ${ends.length}`,
          `context now: ${usedTokens}/${limit} (${Math.round(Math.min(1, usedTokens / limit) * 100)}%)`,
          `context peak (prompt tokens): ${peakTokens}`,
          `session totals: ${prompt}/${completion}/${total} (prompt/completion/total)`,
        ].join("\n"),
      );
      return;
    }
    if (input === "/memory") {
      const p = join(process.cwd(), ".aih", "memory.md");
      tui.pushSystem(
        existsSync(p)
          ? readFileSync(p, "utf8").trim() || "(empty)"
          : "(no project memory yet — the agent can add it with the remember tool)",
      );
      return;
    }
    if (input === "/goal clear") {
      const had = goalCondition;
      goalCondition = "";
      goalRoundsLeft = 0;
      tui.pushSystem(had ? "goal cleared" : "no active goal");
      return;
    }
    if (input.startsWith("/goal ")) {
      const cond = input.slice(6).trim();
      if (!cond) {
        tui.pushSystem("usage: /goal <condition> · /goal clear");
        return;
      }
      goalCondition = cond;
      goalRoundsLeft = Number(process.env.AIH_GOAL_ROUNDS ?? "") || 3;
      tui.pushSystem(
        `goal set: ${cond}\nafter each turn an independent judge checks it and auto-continues if unmet (up to ${goalRoundsLeft} extra rounds)`,
      );
      return;
    }
    if (input === "/goal") {
      tui.pushSystem(
        goalCondition
          ? `active goal: ${goalCondition} (auto-continue rounds left: ${goalRoundsLeft})`
          : "usage: /goal <condition> — judge-verified auto-continuation until the condition holds",
      );
      return;
    }
    if (input === "/mode") {
      tui.pushSystem(`mode: ${agentMode} — tab or /mode <build|plan> to switch`);
      return;
    }
    if (input.startsWith("/mode ")) {
      const want = input.slice(6).trim();
      if (want === "build" || want === "plan") setMode(want);
      else tui.pushSystem("usage: /mode <build|plan>");
      return;
    }
    if (input.startsWith("/inject ")) {
      loop.inject(input.slice("/inject ".length));
      tui.pushSystem("context injected; lands on next turn");
      return;
    }
    if (input === "/model") {
      tui.pushSystem(
        `current model: ${modelLabel} (${providerLabel})\nusage: /model <provider/model>`,
      );
      return;
    }
    if (input.startsWith("/model ")) {
      const id = input.slice("/model ".length).trim();
      if (!id) {
        tui.pushSystem("usage: /model <provider/model>");
        return;
      }
      flags["model"] = id;
      const re = resolveLlm({
        flagModel: str(flags, "model"),
        flagBaseUrl: str(flags, "base-url"),
        flagProvider: str(flags, "provider"),
        envModel: process.env.AIH_MODEL,
        envBaseUrl: process.env.AIH_BASE_URL,
      });
      modelLabel = id;
      providerLabel = re.provider ?? "custom";
      loop = makeLoop();
      tui.pushSystem(`switched model to ${id}`);
      return;
    }
    const skillMatch = /^\/([\w-]+)$/.exec(input);
    if (skillMatch) {
      const skill = skills.find((s) => s.name === skillMatch[1]);
      if (skill) {
        loop.inject(skill.body.slice(0, 6000));
        tui.pushSystem(`skill ${skill.name} injected; lands on next turn`);
        return;
      }
    }
    if (input.startsWith("/")) {
      tui.pushSystem(
        `unknown command: ${input}\navailable: /mode /goal /tools /model /usage /skills /inject /events /clear /exit`,
      );
      return;
    }

    try {
      const started = Date.now();
      const result = await evalTurn(input);
      saveSession(sessionPath, log);
      const usage = result.usage;
      if (result.contextNow != null) {
        usedTokens = result.contextNow;
      } else if (result.contextTokens) {
        usedTokens = Math.max(usedTokens, result.contextTokens);
      } else if (usage) {
        usedTokens = Math.max(usedTokens, usage.promptTokens ?? 0);
      }
      peakTokens = Math.max(peakTokens, usedTokens);
      const dur = Date.now() - started;
      tui.push({
        role: "footer",
        text: `▣ build · ${modelLabel} · ${result.steps} ${result.steps === 1 ? "step" : "steps"} · ${fmtDur(dur)}`,
      });
      if (result.stopReason === "max_steps") {
        tui.pushSystem(
          `⚠ step limit reached (${maxSteps}) — turn paused; send a message (e.g. "continue") to resume`,
        );
      }
      if (result.stopReason === "max_tokens") {
        tui.pushSystem(
          '⚠ model output hit its token ceiling mid-turn — partial step not executed; send a message (e.g. "continue") to resume',
        );
      }
      await runGoalCheck();
      void ensureTitle();
    } catch (err) {
      tui.pushError(err instanceof Error ? err.message : String(err));
    } finally {
      tui.turnSettled();
    }
  }
}

function permLabel(p: ToolDefinition["permission"]): string {
  return typeof p === "string" ? p : "dynamic";
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

async function cmdTools(flags: Record<string, string | boolean>) {
  const backend = await startBackend(flags);
  try {
    const gate = makeBaseGate(flags);
    const registry = new ToolRegistry(gate);
    for (const def of await backend.listTools()) registry.register(def);
    if (bool(flags, "dev")) registerLocalTools(registry, flags, gate, { current: null });
    const tools = registry.schemas().map((s) => ({
      name: s.name,
      kind: registry.get(s.name)?.kind ?? "read",
      permission: permLabel(registry.get(s.name)?.permission ?? "allow"),
      description: s.description,
    }));
    console.log(`${"tool".padEnd(24)} ${"kind".padEnd(6)} ${"perm".padEnd(7)} description`);
    for (const t of tools) {
      console.log(
        `${t.name.padEnd(24)} ${t.kind.padEnd(6)} ${t.permission.padEnd(7)} ${t.description}`,
      );
    }
  } finally {
    backend.close();
  }
}

async function cmdDescribe(flags: Record<string, string | boolean>) {
  const backend = await startBackend(flags);
  try {
    const desc = await backend.describe();
    console.log(JSON.stringify(desc, null, 2));
  } finally {
    backend.close();
  }
}

function sessionFiles(): Array<{ name: string; path: string; events: number; size: number; mtime: number }> {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(SESSIONS_DIR, f);
      const st = statSync(path);
      const events = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
      return { name: f.replace(/\.jsonl$/, ""), path, events, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function readSessionEvents(name: string): SessionEvent[] {
  const path = join(SESSIONS_DIR, `${name}.jsonl`);
  if (!existsSync(path)) {
    console.error(`error: no such session "${name}"`);
    process.exit(1);
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SessionEvent);
}

function cmdSessionList() {
  const files = sessionFiles();
  if (files.length === 0) {
    console.log("(no saved sessions)");
    return;
  }
  console.log(`${"session".padEnd(24)} ${"events".padEnd(7)} ${"bytes".padEnd(8)} ${"title".padEnd(28)} modified`);
  for (const f of files) {
    const title = new SessionStore(join(SESSIONS_DIR, `${f.name}.jsonl`)).title() ?? "";
    console.log(
      `${f.name.padEnd(24)} ${String(f.events).padEnd(7)} ${String(f.size).padEnd(8)} ${title.slice(0, 28).padEnd(28)} ${new Date(f.mtime).toISOString()}`,
    );
  }
}

function cmdSessionShow(name: string) {
  for (const event of readSessionEvents(name)) {
    const time = new Date(event.ts).toLocaleTimeString();
    switch (event.type) {
      case "user/message":
        console.log(`${dim(time)} ${cyan("you>")} ${event.text}`);
        break;
      case "assistant/message":
        if (event.text) console.log(`${dim(time)} ${green("aih>")} ${event.text}`);
        for (const call of event.toolCalls) {
          console.log(`${dim(time)} ${toolTrace(call.name, call.args)}`);
        }
        break;
      case "tool/result":
        if (!event.ok) console.log(`${red(`✗ ${event.callId} failed`)} ${event.error ?? ""}`);
        break;
      case "turn/end":
        console.log(
          dim(
            `  turn ended (${event.stopReason}${event.usage ? `, tokens ${event.usage.totalTokens}` : ""})`,
          ),
        );
        break;
      default:
        break;
    }
  }
}

function cmdSessionRm(names: string[]) {
  if (names.length === 0) {
    console.error("error: session rm needs a name (or --all)");
    process.exit(1);
  }
  for (const name of names) {
    const path = join(SESSIONS_DIR, `${name}.jsonl`);
    rmSync(path, { force: true });
    console.log(`${dim("removed")} ${name}`);
  }
}

function cmdSessionFork(source: string | undefined, target: string, fromSeq?: string): void {
  const src = source ?? latestSessionNameOrExit();
  const srcPath = join(SESSIONS_DIR, `${src}.jsonl`);
  if (!existsSync(srcPath)) {
    console.error(`error: no such session: ${src}`);
    process.exit(1);
  }
  const dstPath = join(SESSIONS_DIR, `${target}.jsonl`);
  if (existsSync(dstPath)) {
    console.error(`error: session already exists: ${target} (rm it first)`);
    process.exit(1);
  }
  const from = Math.max(0, Number.parseInt(String(fromSeq), 10) || 0);
  const log = SessionLog.fromEvents(readSessionEvents(src)).fork(from);
  if (log.all().length === 0) {
    console.error(`error: nothing to fork (source has no events with seq >= ${from})`);
    process.exit(1);
  }
  saveSession(dstPath, log);
  console.log(
    `forked ${src} (from seq ${from}) -> ${target} (${log.all().length} events)`,
  );
}

function cmdSessionExport(name: string, outFile: string | undefined) {
  const events = readSessionEvents(name);
  const out = JSON.stringify(events, null, 2);
  if (outFile) {
    writeFileSync(outFile, out, "utf8");
    console.log(`${dim("exported to")} ${outFile}`);
  } else {
    console.log(out);
  }
}

function cmdStats() {
  let turns = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  for (const file of sessionFiles()) {
    for (const event of readSessionEvents(file.name)) {
      if (event.type === "turn/end" && event.usage) {
        turns += 1;
        prompt += event.usage.promptTokens;
        completion += event.usage.completionTokens;
        total += event.usage.totalTokens;
      }
    }
  }
  if (turns === 0) {
    console.log("(no usage recorded yet)");
    return;
  }
  console.log(`sessions   ${sessionFiles().length}`);
  console.log(`turns      ${turns}`);
  console.log(`tokens     ${prompt} prompt / ${completion} completion / ${total} total`);
}

async function cmdConfig(flags: Record<string, string | boolean>) {
  const llm = resolveLlm({
    flagModel: str(flags, "model"),
    flagBaseUrl: str(flags, "base-url"),
    flagProvider: str(flags, "provider"),
    envModel: process.env.AIH_MODEL,
    envBaseUrl: process.env.AIH_BASE_URL,
  });
  const servers = resolveServers({
    flagServer: str(flags, "server"),
    bundled: { command: process.execPath, args: [DEFAULT_SERVER_ENTRY] },
  });
  const apiKeySet = Boolean(
    str(flags, "api-key") ?? process.env[llm.apiKeyEnv] ?? process.env.AIH_API_KEY,
  );
  console.log(
    JSON.stringify(
      {
        version: VERSION,
        model: llm.model,
        baseUrl: llm.baseUrl,
        provider: llm.provider,
        apiKeyEnv: llm.apiKeyEnv,
        apiKeySet,
        servers: servers.servers,
        serverSource: servers.label,
        sessionsDir: join(process.cwd(), SESSIONS_DIR),
        configLayers: llm.layers.map((l) => l.path),
        retriesEnv: process.env.AIH_RETRIES ?? "(unset)",
        streaming: !bool(flags, "no-stream"),
      },
      null,
      2,
    ),
  );
}

function cmdSkills(action: string, args: string[]): void {
  const skills = discoverSkills();
  const scopeLabel = (s: Skill): string =>
    s.scope === "builtin" ? "builtin" : s.scope;
  if (action === "list" || (!action && !args.length)) {
    console.log(`${"name".padEnd(18)} ${"scope".padEnd(8)} description`);
    for (const s of skills) {
      console.log(`${s.name.padEnd(18)} ${scopeLabel(s).padEnd(8)} ${s.description}`);
    }
    return;
  }
  if (action === "find") {
    const query = args.join(" ");
    const hits = searchSkills(query, skills);
    if (!hits.length) {
      console.log(`no skills match "${query}"`);
      return;
    }
    console.log(`${"score".padEnd(6)} ${"name".padEnd(18)} ${"scope".padEnd(8)} description`);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const s of hits) {
      const n = terms.reduce(
        (acc, t) => acc + (s.name.toLowerCase().includes(t) ? 3 : `${s.description}`.toLowerCase().includes(t) ? 1 : 0),
        0,
      );
      console.log(
        `${String(n).padEnd(6)} ${s.name.padEnd(18)} ${scopeLabel(s).padEnd(8)} ${s.description}`,
      );
    }
    return;
  }
  if (action === "install") {
    const name = args[0];
    if (!name) {
      console.error("error: usage: aih skills install <builtin-name>");
      process.exit(1);
    }
    try {
      const file = installSkill(name);
      console.log(`installed ${name} -> ${file}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }
  if (action === "show") {
    const name = args[0];
    const s = skills.find((x) => x.name === name);
    if (!s) {
      console.error(`error: unknown skill: ${name}`);
      process.exit(1);
    }
    console.log(`# ${s.name} [${scopeLabel(s)}]${s.path ? ` ${s.path}` : ""}`);
    console.log(s.body);
    return;
  }
  console.error(`error: unknown skills action: ${action} (use list|find|install|show)`);
  process.exit(1);
}

function cmdModels() {
  const resolved = resolveLlm({
    flagProvider: undefined,
    flagModel: undefined,
    flagBaseUrl: undefined,
    envModel: process.env.AIH_MODEL,
    envBaseUrl: process.env.AIH_BASE_URL,
  });
  const cfg = mergedConfig(resolved.layers);
  const rows: Array<[string, string, string]> = [];
  rows.push([
    "(env/default)",
    process.env.AIH_MODEL ?? cfg.model ?? "-",
    process.env.AIH_BASE_URL ?? cfg.baseUrl ?? "-",
  ]);
  const providers = (cfg.providers ?? {}) as Record<string, { model?: string; baseUrl?: string }>;
  for (const [name, p] of Object.entries(providers)) {
    rows.push([name, p.model ?? "-", p.baseUrl ?? "-"]);
  }
  console.log(`${"provider".padEnd(20)} ${"model".padEnd(28)} base-url`);
  for (const [provider, model, baseUrl] of rows) {
    console.log(`${provider.padEnd(20)} ${model.padEnd(28)} ${baseUrl}`);
  }
}

function mergedConfig(layers: Array<{ config: any }>): any {
  const out: any = {};
  for (const { config } of layers) Object.assign(out, config);
  return out;
}

function cmdInit(positionals: string[], flags: Record<string, string | boolean>) {
  const dir = positionals[0] ?? ".";
  const name = str(flags, "name") ?? basename(dir === "." ? process.cwd() : dir);
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const target = dir === "." ? process.cwd() : resolve(process.cwd(), dir);
  const render = (content: string) =>
    content
      .replaceAll("{{NAME}}", name)
      .replaceAll("{{SLUG}}", slug)
      .replaceAll("{{DATE}}", new Date().toISOString().slice(0, 10));
  const write = (rel: string, content: string) => {
    const path = join(target, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, render(content), "utf8");
    if (rel.startsWith("scripts/")) chmodSync(path, 0o755);
  };
  if (existsSync(join(target, "APP.md")) && !bool(flags, "force")) {
    console.error(`error: ${dir} already has an APP.md (use --force to overwrite scaffolding)`);
    process.exit(1);
  }
  write("APP.md", T_APP_MD);
  write("AGENTS.md", T_AGENTS_MD);
  write("CLAUDE.md", T_CLAUDE_MD);
  write("harness.yml", T_HARNESS_YML);
  write(".gitignore", T_GITIGNORE);
  write("docs/decisions.md", T_DECISIONS);
  write("tasks/TEMPLATE.md", T_TASK_TEMPLATE);
  write("scripts/bootstrap", T_BOOTSTRAP);
  write("scripts/doctor", T_DOCTOR);
  write("scripts/check", T_CHECK);
  write("scripts/eval", T_EVAL);
  write(".github/workflows/ci.yml", T_CI);
  write("mcp-server/package.json", T_MCP_PACKAGE);
  write("mcp-server/tsconfig.json", T_MCP_TSCONFIG);
  write("mcp-server/src/index.ts", T_MCP_INDEX);
  write("mcp-server/src/app-adapter.ts", T_MCP_ADAPTER);
  console.log(`${green("scaffolded")} ${name} in ${target}`);
  console.log(dim("  cd mcp-server && npm install && npm run build"));
  console.log(dim('  aih run "list my items" -s "node mcp-server/dist/index.js"'));
}

async function cmdMcp(flags: Record<string, string | boolean>) {
  const custom = str(flags, "server");
  if (custom) {
    const parts = custom.split(/\s+/).filter(Boolean);
    const child = spawn(parts[0], parts.slice(1), { stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return;
  }
  const res = spawnSync(process.execPath, [DEFAULT_SERVER_ENTRY], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

function cmdScript(name: string) {
  const script = `${REPO_ROOT}scripts/${name}`;
  if (!existsSync(script)) {
    console.error(`error: "${name}" is a repo QA command (doctor/check/eval) and is not included in installed builds`);
    process.exit(1);
  }
  const res = spawnSync("bash", [script], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  process.exit(res.status ?? 1);
}

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  if (bool(flags, "version", "v")) {
    console.log(VERSION);
    return;
  }
  if (bool(flags, "help", "h")) {
    console.log(HELP);
    return;
  }
  if (!command) {
    if (process.stdin.isTTY) {
      return cmdChat(flags);
    }
    console.log(HELP);
    process.exit(1);
  }

  switch (command) {
    case "run":
      return cmdRun(positionals, flags);
    case "chat":
      return cmdChat(flags);
    case "tools":
      return cmdTools(flags);
    case "describe":
      return cmdDescribe(flags);
    case "sessions":
      return cmdSessionList();
    case "session": {
      const sub = positionals.shift() ?? "list";
      if (sub === "list") return cmdSessionList();
      if (sub === "show") return cmdSessionShow(positionals[0] ?? latestSessionNameOrExit());
      if (sub === "rm") return cmdSessionRm(positionals);
      if (sub === "export") {
        return cmdSessionExport(
          positionals[0] ?? latestSessionNameOrExit(),
          positionals[1],
        );
      }
      if (sub === "fork") {
        if (!positionals[1]) {
          console.error("error: usage: aih session fork [source] <target> [--from seq]");
          process.exit(1);
        }
        return cmdSessionFork(positionals[0], positionals[1], str(flags, "from"));
      }
      console.error(`error: unknown session subcommand "${sub}" (list|show|rm|export|fork)`);
      process.exit(1);
    }
    case "stats":
      return cmdStats();
    case "skills":
      return cmdSkills(positionals[0] ?? "", positionals.slice(1));
    case "config":
      return cmdConfig(flags);
    case "models":
      return cmdModels();
    case "init":
      return cmdInit(positionals, flags);
    case "mcp":
      return cmdMcp(flags);
    case "version":
      console.log(VERSION);
      return;
    case "doctor":
    case "check":
    case "eval":
      return cmdScript(command);
    default:
      console.error(`error: unknown command "${command}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function latestSessionNameOrExit(): string {
  const latest = latestSessionName();
  if (!latest) {
    console.error("error: no saved sessions");
    process.exit(1);
  }
  return latest;
}

main().catch((err) => {
  const cause =
    err instanceof Error && err.cause
      ? ` [cause: ${String(
          (err.cause as { code?: string }).code ??
            (err.cause as { message?: string }).message ??
            err.cause,
        )}]`
      : "";
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}${cause}`);
  process.exit(1);
});

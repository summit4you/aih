#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { userAihDir } from "./paths.js";
import { judgePanel, parseGoalVerdict } from "./maxmode.js";
import { fileURLToPath } from "node:url";
import {
  AgentLoop,
  MockLLM,
  OpenAICompatibleLLM,
  SessionLog,
  SessionStore,
  ToolRegistry,
  FINAL_STATE_GUARD,
  GOAL_CONTRACT_TEMPLATE,
  TASK_CONTRACT_RULES,
  REPAIR_DOCTRINE,
  DECISION_QUESTION_RULE,
  TOOL_OUTPUT_NOTES,
  buildGoalJudgePrompt,
  buildBranchDistillPrompt,
  toolCall,
  scanRecovery,
  describeFact,
  PARK_REASON,
} from "@aih/core";
import type {
  ApprovalGate,
  LLMAdapter,
  SessionEvent,
  ToolDefinition,
  ToolHookInfo,
  ToolInvocationResult,
} from "@aih/core";
import { AutoApprove } from "@aih/core";

import { connectBackend, connectMultiBackend } from "./mcp-backend.js";
import type { McpBackend } from "./mcp-backend.js";
import { DenyGate, SessionGate } from "./gate.js";
import {
  loadModelCatalog,
  loadPermissionRules,
  loadAutoAllowReadonly,
  loadAgentProfile,
  listAgentProfiles,
  normalizeModelEntries,
  providerEntry,
  loadPrices,
  loadSafety,
  resolveLlm,
  resolveServers,
  savePermissionRule,
  saveSkillRegistry,
  type ModelCatalogEntry,
} from "./config.js";
import { buildSafetyHooks, ESCALATE_EXIT_CODE } from "./safety.js";
import type { SafetyHooks } from "./safety.js";
import { projectTrustState, setProjectTrustState } from "./config.js";
import { collectRulesSync, renderRules } from "./rules.js";
import { buildKeybindDispatch, loadKeybinds } from "./keybinds.js";
import {
  clearAllOwnerDegraded,
  clearOwnerDegraded,
  listDegradedOwners,
  markOwnerDegraded,
  renderDegradationReport,
} from "./owner-state.js";
import {
  ensureProjectTrust,
  hasProjectAssets,
} from "./project-trust.js";
import { loadExtensions, createExtensionEventBridge } from "./extensions.js";
import {
  findPruneCandidates,
  placeholderFor,
  registerArchiveReadTool,
  saveToArchive,
} from "./prune.js";
import {
  aggregateUsage,
  costForUsage,
  fmtCost,
  fmtTps,
  cacheHitRate,
  cacheTtlWaste,
  estimateContextTokens,
  lastContextTokens,
  resolvePrice,
  sanePromptTokens,
  streamingTps,
  tokensPerSecond,
  totalCost,
} from "./cost.js";
import { computeScorecard, formatScorecard } from "./scorecard.js";
import { detectedWindow, probeContextWindow } from "./window.js";
import { gitStatusSummary, formatWorktreeSummary } from "./worktree.js";
import { peekWorkspaceIdentity, compareIdentity } from "./workspace-identity.js";
import { extractDreamMaterial, formatDreamMaterial } from "./dream.js";
import { builtinHooks, composeHooks } from "./hooks.js";
import { loadBoard, spawnJob, cancelJob, jobById, summarize } from "./jobs.js";
import { buildDashboard, formatDashboard } from "./sessions.js";
import {
  addAgent,
  addTask,
  agentByName,
  claimTask,
  dispatchTask,
  loadTeam,
  markRead,
  readMail,
  removeAgent,
  resolveTask,
  sendMail,
  setTaskStatus,
  summarizeTeam,
} from "./teams.js";
import { tidyMemory, formatTidyReport } from "./memory-tidy.js";
import { cyan, dim, green, red, bold, toolTrace, turnFooter } from "./ui.js";
import { Tui } from "./tui.js";
import {
  BUILTIN_SKILLS,
  discoverSkills,
  fetchRegistryIndex,
  installRemoteSkill,
  installSkill,
  resolveRegistryUrls,
  searchRemote,
  searchSkills,
  skillSecretPatterns,
  suggestSkills,
  SkillLoadTracker,
  type RemoteSkill,
  type Skill,
} from "./skills.js";
import { isKnownSlashCommand } from "./slash.js";
import { loopUsageBreakdown, formatLoopBreakdown } from "./loops.js";
import { registerDevTools } from "./dev-tools.js";
import { extractShellContext, formatShellContext, describeCommand } from "./shell-context.js";
import { detectShellErrors, formatFixBlock, errorBadge, summarizeErrors, type ShellError } from "./error-detect.js";
import { classifyQuestionPrefix, buildQuestionContext, composeQuestionPrompt } from "./question.js";
import { registerGeneralTools, todoStateFromLog, applyTodoState } from "./general-tools.js";
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
  T_EXTENSION_EXAMPLE,
  T_GITIGNORE,
  T_SKILL_MD,
  T_HARNESS_YML,
  T_MCP_ADAPTER,
  T_MCP_INDEX,
  T_MCP_PACKAGE,
  T_MCP_TSCONFIG,
  T_TASK_TEMPLATE,
} from "./templates.js";
import {
  describeWorkflows,
  loadWorkflow,
  runWorkflow,
} from "./workflow.js";
import {
  runExperiment,
  loadResults,
  retryCellIds,
  statusSummary,
  expandCells,
  cliSubjectAdapter,
  externalSubjectAdapter,
  resultsPath,
  type EvalTask,
  type EvalModelSpec,
  type SubjectAdapter,
} from "./eval.js";
import {
  distance,
  behaviorDistance,
  toolFlow,
  permutationTest,
  crystallize,
  formatDistance,
  formatPermutationTest,
  type Snapshot,
  type ActionEvent,
  type Trace,
} from "./measure.js";

export const VERSION = "0.4.0";
export const DEFAULT_SERVER_ENTRY = fileURLToPath(
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
aih session <list|show|rm|export|import|fork> [args]
                                fork: aih session fork [source] <target> [--from seq]
                                import: aih session import <file.jsonl|file.json> [target]
                                rm:    aih session rm <name>... | --all   (quote globs: 's-*')
  aih stats                       token usage across saved sessions
  aih scorecard [--format json]   harness health scorecard (6 metrics, PE#3)
  aih team <list|add-agent|add-task|claim|dispatch|mail|inbox> [args]
                               Agent Teams: roster + task board + mailbox (D#15)
  aih skills <list|find|install|show|registry> [args]
                                   manage skills (local + external registry)
                                   find: aih skills find <query> [--install]
                                   install: aih skills install <name> [--registry <url>]
                                   registry: aih skills registry [url]
  aih config                      print effective configuration and sources
  aih models                      list configured providers/models
  aih init [dir]                  scaffold a new app harness
  aih workflow <list|run> [name]  deterministic multi-phase agent runs
                                   list: list .aih/workflows/*.mjs
                                   run: aih workflow run <name> [--format json]
  aih experiment <run|status>     P#46 eval matrix + failed-cell retry (FA#6)
                                   run <spec.json> [--exp-id id] [--retry-failed] [--mock]
                                   status <exp-id> [--json]
  aih mcp                         serve the bundled todo-app over stdio
  aih serve --port N              headless harness over HTTP/SSE (P2#8)
                                  GET /health · GET /events (SSE) · POST /message · GET /tools
  aih attach <url>                attach a lightweight REPL to a running serve
  aih doctor | check | eval       run harness scripts

Options:
  -m, --model <id>            model id (env AIH_MODEL > aih.json)
      --base-url <url>        OpenAI-compatible API base (env AIH_BASE_URL)
      --api-key <key>         API key (env AIH_API_KEY)
      --provider <name>       pick provider from aih.json providers
      --context-window <n>    model context window in tokens
                              (env AIH_CONTEXT_WINDOW > live /slots detection [llama.cpp] >
                              aih.json models[<id>].contextWindow >
                              providers.<name>.contextWindow / contextWindow)
  -s, --server "<command>"    MCP server launch command; defaults to the
                              bundled todo-app server. For multiple servers set
                              \"mcpServers\" in aih.json (tools merged, duplicates
                              renamed <server>_<tool>)
      --max-steps <n>         max steps per turn (default: unlimited; opt-in safety valve)
      --goal <condition>      run: judge-verified auto-continuation until the
                              condition holds (bounded by AIH_GOAL_ROUNDS, default 3)
  -a, --as <name>             run a named agent profile (E#18): its permission rules
                              + optional prompt line apply for this run (see aih agents)
      --debug-prompt          print the exact model-visible prompt input before each LLM call
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
      --no-redact             do not scrub secret shapes (API keys/tokens) from tool
                               results (redaction is on by default; timing always on)
     --session <name>        name a session (stored at .aih/sessions/<name>.jsonl);
                               without it, each launch starts a fresh auto-named
                               session and persists it unless --ephemeral is given
  -c, --continue [name]       resume a session (default: most recent) before
                               sending the new message
      --ephemeral             do not persist this session to disk
  -h, --help                  show help
  -v, --version               show version

Configuration (precedence: flags > env > project aih.json/.aih/config.json >
  user config — XDG: $AIH_HOME > $XDG_DATA_HOME/aih > ~/.local/share/aih,
  with legacy ~/.aih read-compat):
  { "model", "baseUrl", "defaultProvider", "contextWindow"?,
    "providers": { "<name>": { "baseUrl", "model", "apiKeyEnv", "contextWindow"? } },
    "mcpServers": { "<name>": { "command", "args?", "enabled?", "name?" } },
    "permissions": [ { "tool", "pattern?", "action": "allow|deny" } ] }

Environment:
  AIH_MODEL, AIH_BASE_URL, AIH_API_KEY, AIH_RETRIES, NO_COLOR
  AIH_HOME (explicit user data dir) / XDG_DATA_HOME (default ~/.local/share/aih)
  AIH_CONTEXT_WINDOW (default 131072; live /slots detection [llama.cpp] beats aih.json
    models[<id>].contextWindow > providers.<name>.contextWindow > global;
    explicit flag/env always wins),
  AIH_COMPACT_AT (0.8), AIH_GOAL_ROUNDS (3)
  AIH_MEMORY_BUDGET (4000 chars of .aih/memory.md injected per turn)
  AIH_CMD_TIMEOUT_MS (120000 default run_cmd timeout)
  AIH_TOOL_CONCURRENCY (4) max parallel read-only tool calls per step
  AIH_FORMAT_TIMEOUT_MS (15000) post-write formatter timeout

Examples:
  aih run "add a todo buy milk" --mock
  aih run "what else?" -c                     # continue most recent session
  aih chat --session work
  aih serve --port 8787 --session work       # headless harness over HTTP/SSE
  aih attach http://127.0.0.1:8787           # attach a REPL from another box
  aih init my-app && cd my-app && npm run bootstrap
  aih config                                  # inspect effective settings
  aih config --schema                         # print the aih.json JSON Schema

Chat commands (inside the TUI):
  ctrl-p              command palette (switch model, mode, compact, …)
  /model              open the model picker overlay (all providers/models)
  /model <p/m>        direct switch: "<provider>/<model>" or bare model id
  /compact [focus]    summarize earlier context now (optionally steer the summary)
  /usage              token totals + current context fill
  /shell              recent run_cmd output + exit codes (IT#1) · /shell --send
  /fix                detect failed run_cmd + send to agent for a fix (IT#2) · /fix --show
  /mode, /goal, /tools, /skills, /inject, /memory, /events, /bg, /clear
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
    "context-window",
    "goal",
    "port",
    "url",
    "as",
    "a",
    "role",
    "prompt",
    "detail",
    "note",
    "sender",
    "image",
    // FA#6 — `aih experiment` value flags
    "exp-id",
    "reps",
    "concurrency",
    "out",
    "results-dir",
    "external",
    "args-template",
    "timeout",
  ]);
  const booleanFlags = new Set(["thinking"]);
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

export function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(flags: Record<string, string | boolean>, ...keys: string[]): boolean {
  return keys.some((k) => flags[k] === true || flags[k] === "true");
}

/** Built-in fallback context window (max input tokens) when nothing is configured. */
export const DEFAULT_CONTEXT_WINDOW = 131072;

/**
 * True for self-hosted endpoints (llama.cpp / Ollama / vLLM on localhost, LAN,
 * or plain http). These run without auth, so a keyless client is legitimate.
 */
function isLocalEndpoint(baseUrl: string | undefined): boolean {
  try {
    const u = new URL(baseUrl ?? "");
    if (u.protocol === "http:") return true;
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "::" ||
      h === "::1" ||
      /\.(local|internal|lan)$/i.test(h) ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the model's context window for a command:
 * `--context-window` > `AIH_CONTEXT_WINDOW` > live detection (llama.cpp `/slots`,
 * min per-slot n_ctx) > aih.json model-level (`providers.<name>.models[]` object
 * entry `{ model, contextWindow }`, F#34) > provider-level
 * (`providers.<name>.contextWindow`) > global `contextWindow` > default 128k.
 * Non-numeric / non-positive values are treated as unset.
 */
export function resolveContextWindow(flags: Record<string, string | boolean>): number {
  const resolved = resolveLlm({
    flagModel: str(flags, "model"),
    flagBaseUrl: str(flags, "base-url"),
    flagProvider: str(flags, "provider"),
    envModel: process.env.AIH_MODEL,
    envBaseUrl: process.env.AIH_BASE_URL,
  });
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const fromFlag = num(str(flags, "context-window"));
  if (fromFlag) return fromFlag;
  const fromEnv = num(process.env.AIH_CONTEXT_WINDOW);
  if (fromEnv) return fromEnv;
  const live = detectedWindow(resolved.baseUrl.value);
  if (live) return live;
  const fromConfig = num(resolved.contextWindow.value);
  if (fromConfig) return fromConfig;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Best-effort live window probe for the active endpoint (skipped in --mock). */
async function probeWindow(flags: Record<string, string | boolean>): Promise<void> {
  if (bool(flags, "mock")) return;
  try {
    const base = resolveLlm({
      flagModel: str(flags, "model"),
      flagBaseUrl: str(flags, "base-url"),
      flagProvider: str(flags, "provider"),
      envModel: process.env.AIH_MODEL,
      envBaseUrl: process.env.AIH_BASE_URL,
    }).baseUrl.value;
    if (base) await probeContextWindow(base);
  } catch {
    // detection is best-effort only; configured values still apply
  }
}

/**
 * PE#2 — cost resolver for the budget seam: price the current model (config
 * `prices` → built-in table → models.dev snapshot) and convert a usage chunk
 * to USD. Returns `undefined` when no price is known (mock / unknown model) —
 * the tracker then bounds on writes/timeout/scope only, which is the honest
 * behavior (no invented price).
 */
function buildCostOf(flags: Record<string, string | boolean>): ((u: import("@aih/core").TokenUsage) => number) | undefined {
  const modelId =
    (str(flags, "model") as string | undefined) ??
    process.env.AIH_MODEL ??
    resolveLlm({}).model.value ??
    "";
  const price = modelId ? resolvePrice(modelId, loadPrices()) : undefined;
  if (!price) return undefined;
  return (usage) => costForUsage(usage, price);
}

/**
 * PE#1/PE#2/PE#4 — assemble the safety hook set for a loop from the merged
 * config (file `safety` block + AIH_BUDGET/AIH_SENSORS env). `interactive`
 * selects the escalate surface (TUI rows vs stderr + exit-code-3). Returns
 * `undefined` when nothing is configured (the loop no-ops the seam).
 */
function wireSafety(
  flags: Record<string, string | boolean>,
  opts: { interactive?: boolean; line?: (t: string) => void },
): (SafetyHooks & { costOf?: (u: import("@aih/core").TokenUsage) => number }) | undefined {
  const cfg = loadSafety();
  const hooks = buildSafetyHooks(cfg, {
    cwd: process.cwd(),
    interactive: opts.interactive,
    line: opts.line,
  });
  if (!hooks) return undefined;
  return { ...hooks, costOf: buildCostOf(flags) };
}

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function buildLlm(flags: Record<string, string | boolean>) {
  if (bool(flags, "mock")) {
    // AIH_MOCK_AUX_TEXT: non-empty reply for auxiliary tool-less calls (goal
    // judge / branch distiller) in mock mode — a testing hook without a key.
    const aux = process.env.AIH_MOCK_AUX_TEXT;
    return new MockLLM([
      {
        text: "",
        toolCalls: [toolCall("mock-1", "add_todo", { text: "from aih cli" })],
        stopReason: "tool_use",
      },
      { text: "Added via mock.", stopReason: "end_turn" },
      ...(aux ? [{ text: aux, stopReason: "end_turn" as const }] : []),
    ]);
  }
  return buildRealLlm(flags);
}

/**
 * LLM for the SECOND judge of the `best_of_n` two-judge panel (Freebuff
 * BuffBench parity). Opt-in via `AIH_SECOND_JUDGE_MODEL` — unset/empty →
 * `undefined` → `best_of_n` runs single-judge (unchanged). Reuses the
 * provider/base-url/api-key resolution of the primary model, only the model id
 * differs. In `--mock` mode it returns a MockLLM (so the panel is testable
 * without a key).
 */
export function buildJudge2Llm(flags: Record<string, string | boolean>): LLMAdapter | undefined {
  const model = process.env.AIH_SECOND_JUDGE_MODEL?.trim();
  if (!model) return undefined;
  if (bool(flags, "mock")) {
    const aux = process.env.AIH_MOCK_AUX_TEXT;
    return new MockLLM(aux ? [{ text: aux, stopReason: "end_turn" as const }] : [{ text: "", stopReason: "end_turn" as const }]);
  }
  return buildRealLlm({ ...flags, model });
}

/**
 * LLM for standalone AUXILIARY calls (branch distiller): one tool-less
 * completion. In mock mode the whole script IS the aux reply (AIH_MOCK_AUX_TEXT),
 * so a single-call consumer gets it on the first try.
 */
export function buildAuxLlm(flags: Record<string, string | boolean>) {
  const aux = process.env.AIH_MOCK_AUX_TEXT;
  if (bool(flags, "mock")) {
    return new MockLLM([{ text: aux ?? "", stopReason: "end_turn" }]);
  }
  return buildRealLlm(flags);
}

function buildRealLlm(flags: Record<string, string | boolean>) {
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
  // Keyless is legitimate for: (a) providers carrying identity headers (opencode
  // Zen free tier authenticates by client fingerprint) — but ONLY when the
  // request actually goes to that provider's own endpoint, and (b) self-hosted
  // endpoints (llama.cpp/Ollama/vLLM) that run without auth. An env/flag URL
  // override that moves the request OFF the provider's home invalidates (a):
  // opencode's fingerprint headers sent to api.openai.com authenticate nothing.
  const providerHome = resolved.provider
    ? (() => {
        try {
          return providerEntry(resolved.provider).baseUrl;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const sameHome =
    providerHome !== undefined &&
    resolved.baseUrl.value !== undefined &&
    resolved.baseUrl.value.replace(/\/+$/, "") === providerHome.replace(/\/+$/, "");
  const headerExempt = Object.keys(resolved.headers).length > 0 && sameHome;
  if (!apiKey && !resolved.keyless && !headerExempt && !isLocalEndpoint(resolved.baseUrl.value)) {
    throw new Error(
      `no API key for provider "${resolved.provider ?? "custom"}". Set ${resolved.apiKeyEnv} (or AIH_API_KEY), pass --api-key, or use --mock for an offline demo.`,
    );
  }
  if (!resolved.model.value) {
    throw new Error("no model id. Set AIH_MODEL, --model, or model in aih.json.");
  }
  // AIH_RETRIES unset/empty must fall through to the adapter default —
  // Number("") is 0 and Number.isFinite(0) is true, which silently disabled
  // ALL retries (the "fetch failed" on every provider blip).
  const retries = parseRetryEnv(process.env.AIH_RETRIES);
  const owner = resolved.provider;
  return new OpenAICompatibleLLM({
    baseUrl: resolved.baseUrl.value ?? "https://api.openai.com/v1",
    apiKey,
    model: resolved.model.value,
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(Object.keys(resolved.headers).length > 0 ? { headers: resolved.headers } : {}),
    // OC#7 — credential ownership isolation: a credential failure on this
    // provider degrades ITS OWNER (recorded for `aih models`/doctor/status);
    // a later success auto-clears it. Never auto-falls back (the error still
    // propagates; re-selecting another owner is an explicit user choice).
    ...(owner ? { owner } : {}),
    onCredentialFailure: (o, cls, reason) => markOwnerDegraded(o, cls, reason),
    onOwnerSuccess: (o) => clearOwnerDegraded(o),
  });
}

/** Parse AIH_RETRIES; undefined (use adapter default) when unset/empty/invalid. */
export function parseRetryEnv(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a memory file, trimmed; "" when missing/empty. */
function readMemoryFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function fitBudget(text: string, budget: number): string {
  if (text.length > budget) return `${text.slice(0, Math.max(budget - 12, 0))}\n…(truncated)`;
  return text;
}

/**
 * Memory injection (roadmap P0#2): project `.aih/memory.md` first, then
 * user-level `~/.local/share/aih/memory.md` (cross-project). Total length is
 * capped by AIH_MEMORY_BUDGET (default 4000 chars); the project file gets the
 * budget first, the user file gets whatever remains.
 */
export function loadMemoryBlock(cwd = process.cwd()): string {
  const budget = Number(process.env.AIH_MEMORY_BUDGET ?? "") || 4000;
  const parts: string[] = [];
  const project = readMemoryFile(join(cwd, ".aih", "memory.md"));
  if (project) {
    parts.push(`# Project memory (persistent across sessions; keep it current with the remember tool)\n${fitBudget(project, budget)}`);
  }
  const user = readMemoryFile(join(userAihDir(), "memory.md"));
  if (user) {
    const used = parts.reduce((n, p) => n + p.length, 0);
    const remain = Math.max(budget - used - 80, 0); // 80 ≈ header overhead
    if (remain > 0) {
      parts.push(`# User memory (cross-project, ${join(userAihDir(), "memory.md")}; remember scope=user)\n${fitBudget(user, remain)}`);
    }
  }
  if (!parts.length) return "";
  return `\n\n${parts.join("\n\n")}`;
}

/**
 * Build the authoritative todo-state snapshot folded into every compaction
 * summary (auto + manual). This prevents a compacted agent from forgetting
 * which items are done vs pending — the observed failure mode was the agent
 * re-implementing finished work (FB#5/#6) after compaction and misattributing
 * its own earlier edits to a "parallel session". The summary must carry this
 * forward verbatim (see AgentLoop compactContext).
 */
export function compactTodoContext(
  log: { all: () => readonly SessionEvent[] },
  cwd: string,
): string {
  const todos = todoStateFromLog(log.all());
  if (!todos || todos.length === 0) return "";
  const done = todos.filter((t) => t.status === "completed").map((t) => t.content);
  const pending = todos.filter((t) => t.status !== "completed").map((t) => t.content);
  const lines: string[] = [];
  if (pending.length) lines.push("### Todos — still PENDING (do not mark done):");
  for (const p of pending) lines.push(`- [ ] ${p}`);
  if (done.length) lines.push("### Todos — ALREADY COMPLETED (verified, do NOT redo):");
  for (const d of done) lines.push(`- [x] ${d}`);
  void cwd;
  if (lines.length === 0) return "";
  return `# Authoritative todo state (from .aih/todos.json)\n${lines.join("\n")}`;
}

export function loadSystemPrompt(): string {
  const appMd = `${process.cwd()}/APP.md`;
// The language rule now lives in core (LANGUAGE_RULE) and is appended at the
  // very END of the derived system prompt by session-log deriveMessages, so a
  // compaction summary can never bury it (observed: after compaction the
  // English summary pushed the mid-prompt language rule out of reach and the
  // agent reverted to English notes). Nothing else is appended after it.
  const guard = `\n\n# Completion honesty rules\n${FINAL_STATE_GUARD}\n\n${TASK_CONTRACT_RULES}\n\n${REPAIR_DOCTRINE}\n\n${DECISION_QUESTION_RULE}\n\n${TOOL_OUTPUT_NOTES}`;
  // opencode `rules` parity — AGENTS.md / CLAUDE.md / config `instructions`
  // are merged in as mandatory project rules.
  const rules = renderRules(collectRulesSync());
  if (existsSync(appMd)) {
    const content = readFileSync(appMd, "utf8");
    return [
      "You are the in-app intelligence of the application described below.",
      "Follow its contract strictly; prefer read actions; write actions may require approval.",
      "",
      content.slice(0, 6000),
    ].join("\n") + guard + rules;
  }
  return (
    "You are an in-app assistant operating the connected application through its tools." +
    guard + rules
  );
}

function makeBaseGate(flags: Record<string, string | boolean>): ApprovalGate {
  return bool(flags, "yes", "y") ? new AutoApprove() : new DenyGate();
}

export function makeSessionGate(flags: Record<string, string | boolean>): SessionGate {
  const base = loadPermissionRules();
  // E#18: `--as <name>` selects a named agent profile — its permission rules
  // are appended AFTER the base ruleset (last-match-wins, so the profile can
  // tighten or loosen per-tool behavior for this run).
  const asName = str(flags, "as") ?? str(flags, "a");
  const profile = asName ? loadAgentProfile(asName) : undefined;
  if (asName && !profile) {
    const known = listAgentProfiles().join(", ") || "(none configured)";
    process.stderr.write(
      `warning: unknown agent profile "${asName}" — falling back to base permissions (known: ${known})\n`,
    );
  }
  const rules = profile?.permissions ? [...base, ...profile.permissions] : base;
  return new SessionGate(
    makeBaseGate(flags),
    rules,
    (rule) => savePermissionRule(rule),
    // CC#54 — opt-in read-only auto-allow from config (default off).
    loadAutoAllowReadonly(),
  );
}

/** E#18 — the extra system-prompt line for the active `--as` profile (or ""). */
export function agentProfilePrompt(flags: Record<string, string | boolean>): string {
  const asName = str(flags, "as") ?? str(flags, "a");
  if (!asName) return "";
  const profile = loadAgentProfile(asName);
  return profile?.prompt ? `\n\n[agent profile: ${asName}] ${profile.prompt}` : "";
}

export function registerSkillTool(
  registry: ToolRegistry,
  opts?: { projectTrusted?: boolean; loadTracker?: SkillLoadTracker },
): Skill[] {
  // P#40 trust gate: project-scope skills load only for trusted directories.
  // User + builtin skills are unaffected (they are not repo-controlled).
  const loadTracker = opts?.loadTracker ?? new SkillLoadTracker();
  const skills = discoverSkills().filter(
    (s) => s.scope !== "project" || opts?.projectTrusted !== false,
  );
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
      // CC#52 — avoid re-appending a full duplicate copy on a repeat load.
      if (loadTracker.isLoaded(name)) {
        const recap = skill.body.trim().slice(0, 200);
        return (
          `skill "${name}" was already loaded ${loadTracker.markLoaded(name)}; ` +
          `its full instructions are already in context — do not load again unless expired. ` +
          `recap (first ~200 chars): ${recap}`
        );
      }
      loadTracker.markLoaded(name);
      return skill.body.slice(0, 6000);
    },
  });
  return skills;
}

export function withSkillRoster(
  prompt: string,
  skills: Skill[],
  ctxWindow?: number,
): string {
  if (!skills.length) return prompt;
  // Context budget for the initial roster (Codex rule): at most 2% of the
  // model's context window, or 8000 chars when the window is unknown.
  const budget = Math.max(
    1000,
    Math.floor((ctxWindow && ctxWindow > 0 ? ctxWindow * 0.02 : 8000)),
  );
  const header = `\n\n## Skills\n`;
  let lines = skills.map(
    (s) => `- ${s.name}: ${s.description} (call load_skill to activate)`,
  );
  let body = lines.join("\n");
  let omitted = false;
  if (header.length + body.length > budget) {
    // First shorten descriptions, front-loading the name so matching survives.
    lines = skills.map((s) => {
      const keep = Math.max(40, budget - header.length - skills.length * 40);
      const d =
        s.description.length > keep
          ? `${s.description.slice(0, Math.max(0, keep - 1))}…`
          : s.description;
      return `- ${s.name}: ${d} (call load_skill to activate)`;
    });
    body = lines.join("\n");
  }
  if (header.length + body.length > budget) {
    // Still over: omit trailing skills from the initial list and warn.
    const kept: string[] = [];
    let used = header.length;
    for (const line of lines) {
      const cost = line.length + 1;
      if (used + cost > budget) {
        omitted = true;
        break;
      }
      kept.push(line);
      used += cost;
    }
    body = kept.join("\n");
  }
  const warning = omitted
    ? `\n(${skills.length - body.split("\n").length + 2} more skills hidden to stay within the roster context budget; use /skills to list all)`
    : "";
  return `${prompt}${header}${body}${warning}`;
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

/**
 * D#11 — built-in hooks (redaction + timing) + the default tool-audit
 * consumer. Order matters: builtin hooks run FIRST so the audit log sees the
 * redacted result. Redaction is on by default; `--no-redact` disables it.
 */
export function attachAudit(registry: ToolRegistry, flags: Record<string, string | boolean>, cwd = process.cwd()): void {
  if (!bool(flags, "no-redact")) {
    // D#11: redaction uses the built-in table + any secretPatterns declared
    // by installed skills (skill-driven hook config).
    registry.addHooks(builtinHooks(skillSecretPatterns()));
  }
  if (!bool(flags, "no-audit")) registry.addHooks(auditHooks(cwd));
}

/**
 * MK#43 — prune oversized old tool results: archive the body to
 * .aih/archives/<callId>.txt and project a short placeholder in future
 * requests. Deterministic, non-LLM, orthogonal to compaction; the log itself
 * is never rewritten. Skips the most recent turn's results (still "hot").
 */
export function pruneOldToolResults(
  log: { all: () => readonly SessionEvent[]; pruneResult: (callId: string, placeholder: string) => void },
  contextTokens: number,
): number {
  const events = log.all();
  const candidates = findPruneCandidates(events);
  if (candidates.length === 0) return 0;
  // Only prune when context pressure exists (>=60% of window or window unknown).
  const limit = Number(process.env.AIH_CONTEXT_WINDOW ?? "") || 0;
  let pruned = 0;
  for (const c of candidates) {
    const ev = events.find(
      (e): e is Extract<SessionEvent, { type: "tool/result" }> =>
        e.type === "tool/result" && e.callId === c.callId,
    );
    if (!ev || !ev.ok) continue;
    const body = JSON.stringify(ev.result ?? "");
    saveToArchive(process.cwd(), c.callId, body);
    log.pruneResult(c.callId, placeholderFor(c.callId, ev.result));
    pruned += 1;
  }
  void contextTokens;
  void limit;
  return pruned;
}

export function registerLocalTools(
  registry: ToolRegistry,
  flags: Record<string, string | boolean>,
  gate: ApprovalGate,
  tuiRef: { current: Tui | null },
  hideWrites = false,
  logRef?: { current: { all: () => readonly SessionEvent[] } | null },
): void {
  registerDevTools(registry, process.cwd(), hideWrites);
  registerGeneralTools(
    registry,
    {
      gate,
      llm: () => buildLlm(flags),
      toolsProvider: () => registry,
      // IT#1 — resolve the live session log at call time (created after the
      // registry in every path); absent → shell_context reports "not wired".
      logProvider: logRef ? () => logRef.current ?? undefined : undefined,
      ask: (q) => (tuiRef.current ? tuiRef.current.askQuestion(q) : makeStdinAsk(q)),
      // Two-judge panel for best_of_n (Freebuff BuffBench parity): opt-in via
      // AIH_SECOND_JUDGE_MODEL; absent → single judge (unchanged).
      judge2: () => buildJudge2Llm(flags),
      // D#11: builtin hooks (redaction+timing) first, then the audit consumer.
      // Compose the after-waterfall manually (spread would drop the builtin
      // `after` when audit is enabled).
      hooks: composeHooks([
        ...(bool(flags, "no-redact") ? [] : [builtinHooks(skillSecretPatterns())]),
        ...(bool(flags, "no-audit") ? [] : [auditHooks(process.cwd())]),
      ]),
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
    const p = join(SESSIONS_DIR, `${name}.jsonl`);
    if (!existsSync(p)) {
      const have = existsSync(SESSIONS_DIR)
        ? readdirSync(SESSIONS_DIR)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => f.replace(/\.jsonl$/, ""))
            .join(", ")
        : "(none)";
      console.error(`error: --continue: no saved session named "${name}" (available: ${have})`);
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
  // MK#45 — close any turn that is still open at save time. A turn/end is
  // normally written when send() returns, but if the process exits mid-turn
  // (TUI close, Ctrl+C, crash) the last turn never gets its turn/end, so the
  // next `-c` resume sees an eternal "interrupted turn" and re-surfaces it
  // every launch even when every tool completed harmlessly. Marking it closed
  // here makes the log self-consistent: the next resume scans clean. Only the
  // newest unended turn is closed; tool facts are untouched (recovery still
  // tells the truth about each call).
  const rep = scanRecovery(log.all());
  if (rep.openTurn) {
    log.append({ type: "turn/end", turnId: rep.openTurn, stopReason: "session_closed" });
  }
  mkdirSync(SESSIONS_DIR, { recursive: true });
  new SessionStore(path).save(log);
}

/** Question text from a `question` tool call's args (undefined if absent). */
export function questionText(args: unknown): string | undefined {
  const q = (args as { question?: unknown } | undefined)?.question;
  return typeof q === "string" && q.trim() ? q : undefined;
}

/** The user's answer from a `question` tool result (undefined if absent). */
export function questionAnswer(result: unknown): string | undefined {
  const a = (result as { answer?: unknown } | undefined)?.answer;
  return typeof a === "string" && a.trim() ? a : undefined;
}

export function replayHistory(tui: Tui, events: readonly SessionEvent[]): void {
  const userLines: string[] = [];
  const questionCalls = new Set<string>();
  tui.beginBatch();
  try {
    for (const e of events) {
      if (e.type === "user/message") {
        tui.push({ role: "user", text: e.text });
        userLines.push(e.text);
      } else if (e.type === "assistant/message" && e.text) {
        tui.push({ role: "assistant", text: e.text });
      } else if (e.type === "tool/call") {
        if (e.name === "question") {
          // Replay the "❓ <question>" line (askQuestion isn't called on
          // resume) and remember the callId so the result renders the answer
          // instead of a duplicate tool item.
          tui.pushSystem(`❓ ${questionText(e.args) ?? ""}`.trim());
          questionCalls.add(e.callId);
        } else {
          tui.pushTool(e.name, e.args, e.callId);
        }
      } else if (e.type === "tool/result") {
        if (questionCalls.delete(e.callId)) {
          tui.pushSystem(`→ ${questionAnswer(e.result) ?? "(no answer)"}`);
        } else {
          tui.resolveTool(e.callId, e.ok, e.result);
        }
      } else if (e.type === "compaction") {
        tui.pushSystem("── compacted (earlier context summarized) ──");
      }
    }
  } finally {
    tui.endBatch();
  }
  tui.seedHistory(userLines);
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
    const skillTracker = new SkillLoadTracker(); // CC#52 — per-session load-skill dedup
    const skills = registerSkillTool(registry, { projectTrusted: projectTrustState() === "trusted", loadTracker: skillTracker });
    registerArchiveReadTool(registry);
    void loadExtensions(registry, {
      enabled: !bool(flags, "no-extensions") && projectTrustState() === "trusted",
    });
    // IT#1 — resolve the live session log at call time (created after the
    // registry); absent → shell_context reports "not wired".
    const logRef: { current: { all: () => readonly SessionEvent[] } | null } = { current: null };
    if (bool(flags, "dev")) registerLocalTools(registry, flags, gate, { current: null }, false, logRef);
    attachAudit(registry, flags);

    const log = loadSession(sessionPath);
    logRef.current = log; // IT#1 — shell_context now resolves the live log
    // MK#43: prune oversized old tool results once at session start (the
    // fresh-turn path prunes nothing; resumed sessions may reclaim context).
    pruneOldToolResults(log, 0);
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

    let llm: ReturnType<typeof buildLlm>;
    try {
      llm = buildLlm(flags);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    await probeWindow(flags);
    const safety = wireSafety(flags, { interactive: false });
    const loop = new AgentLoop({
      llm,
      tools: registry,
      log,
      systemPrompt:
        withSkillRoster(loadSystemPrompt(), skills, resolveContextWindow(flags)) +
        loadMemoryBlock() +
        agentProfilePrompt(flags),
      maxStepsPerTurn: Number(str(flags, "max-steps") ?? Infinity) || Infinity,
      contextWindow: resolveContextWindow(flags),
      compactAt: Number(process.env.AIH_COMPACT_AT ?? "") || 0.8,
      compactContext: () => compactTodoContext(log, process.cwd()),
      ...(safety ? { budget: safety.budget, costOf: safety.costOf, sensors: safety.sensors, onTripwire: safety.onTripwire, onEscalate: safety.onEscalate } : {}),
      ...(bool(flags, "debug-prompt")
        ? {
            onPromptInput: (messages) => {
              process.stderr.write(
                `\n[debug-prompt] ${messages.length} messages:\n` +
                  JSON.stringify(messages, null, 2) +
                  "\n",
              );
            },
          }
        : {}),
    });

    // P1#4: BM25 relevance auto-loading — nudge the model toward a clearly
    // relevant installed skill (best-effort; the model decides whether to load).
    if (message.trim().length >= 8) {
      try {
        const sugg = suggestSkills(message, skills, 2);
        if (sugg.length) {
          loop.inject(
            `[skill suggestion] "${sugg[0].skill.name}" looks relevant to this request — call load_skill("${sugg[0].skill.name}") to read its instructions before proceeding if it fits.` +
              (sugg[1] ? ` (also: ${sugg[1].skill.name})` : ""),
          );
        }
      } catch {
        /* best-effort */
      }
    }
    const result = await loop.send(
      message,
      streaming ? { onDelta: (d) => process.stdout.write(d) } : undefined,
    );
    saveSession(sessionPath, log);
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

    // PE#4 — a turn that ended in an escalation (hard budget / sensor red after
    // retries) is a hard stop: surface the exit code so scripts/CI can branch
    // on it (the onEscalate hook already printed the options + safest default).
    if (result.stopReason === "escalated") {
      process.exit(ESCALATE_EXIT_CODE);
    }

    // --goal: judge-verified auto-continuation (bounded by AIH_GOAL_ROUNDS).
    const goal = str(flags, "goal");
    if (goal) {
      let goalMet = false;
      let rounds = Number(process.env.AIH_GOAL_ROUNDS ?? "") || 3;
      const goalJudge2 = buildJudge2Llm(flags); // FB#6 — undefined → single judge
      for (;;) {
        let verdict: { met: boolean; reason: string; unmet: string[] };
        let degraded = false;
        try {
          // FB#6 — goal judge runs as a two-judge panel (primary = llm, optional
          // secondary = AIH_SECOND_JUDGE_MODEL). The primary's verdict is kept;
          // a disagreement / failed judge is flagged (degraded) and warned, never
          // silently dropped. Single-judge when goalJudge2 is undefined.
          const panel = await judgePanel(
            llm,
            {
              messages: [
                ...log.deriveMessages(),
                { role: "user", content: buildGoalJudgePrompt(goal) },
              ],
              tools: [],
            },
            parseGoalVerdict,
            goalJudge2,
            "goal",
            (a, b) => a.met === b.met,
          );
          verdict = panel.verdict;
          degraded = panel.degraded;
        } catch (err) {
          process.stderr.write(
            `${red("goal judge failed, stopping goal chain: ")}${err instanceof Error ? err.message : String(err)}\n`,
          );
          break;
        }
        const turnId = result.turnId;
        log.append({ type: "goal/judge", turnId, met: verdict.met, reason: verdict.reason, unmet: verdict.unmet, roundsLeft: verdict.met ? 0 : rounds, ...(degraded ? { degraded: true } : {}) });
        saveSession(sessionPath, log);
        if (verdict.met) {
          goalMet = true;
          process.stderr.write(`${green("✅ goal met")} — ${verdict.reason}\n`);
          break;
        }
        if (rounds <= 0) {
          process.stderr.write(`${red("⏹ goal not met after auto-continue rounds — stopping")} (${verdict.reason})\n`);
          break;
        }
        rounds -= 1;
        const unmetNote = verdict.unmet.length
          ? `\n[goal] Unverified criteria: ${verdict.unmet.join("; ")}\nVerify each against real persisted state (read the file, run the check) — do not re-claim completion without fresh evidence.\n`
          : "";
        process.stderr.write(`${dim(`↻ goal check: not yet met — ${verdict.reason} (auto-continuing, ${rounds} left)`)}\n`);
        await loop.send(
          `${unmetNote}[goal] The goal "${goal}" is not yet met. Judge's note: ${verdict.reason}\nContinue working until the goal is fully achieved.`,
          streaming ? { onDelta: (d) => process.stdout.write(d) } : undefined,
        );
        saveSession(sessionPath, log);
      }
      if (format === "json") {
        // goal/judge events already streamed via wireTrace; nothing extra
      }
      process.exit(goalMet ? 0 : 1);
    }
  } finally {
    backend.close();
  }
}

async function cmdWorkflow(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = positionals.shift() ?? "list";
  if (sub === "list") {
    const infos = await describeWorkflows(process.cwd());
    const format = str(flags, "format") ?? "text";
    if (format === "json") {
      console.log(JSON.stringify({ workflows: infos }, null, 2));
      return;
    }
    if (infos.length === 0) {
      console.log(
        "no workflows yet — add .aih/workflows/<name>.mjs exporting { phases: [...] }",
      );
      return;
    }
    for (const info of infos) {
      console.log(
        `${bold(info.name)}  ·  ${info.phases} phase(s)${info.description ? `  ·  ${info.description}` : ""}`,
      );
    }
    return;
  }
  if (sub === "run") {
    const name = positionals.shift();
    if (!name) {
      console.error("error: usage: aih workflow run <name> [--format json|text]");
      process.exit(1);
    }
    const format = str(flags, "format") ?? "text";
    if (format !== "text" && format !== "json") {
      console.error(`error: unknown format "${format}" (use text|json)`);
      process.exit(1);
    }
    let def;
    try {
      def = await loadWorkflow(process.cwd(), name);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    def.name = name;

    const backend = await startBackend(flags);
    const sessionPath = bool(flags, "ephemeral")
      ? undefined
      : (resolveSessionPath(flags) ?? join(SESSIONS_DIR, `${freshSessionName()}.jsonl`));
    try {
      const gate = makeSessionGate(flags);
      const registry = new ToolRegistry(gate);
      for (const def2 of await backend.listTools()) registry.register(def2);
      const skillTracker = new SkillLoadTracker(); // CC#52 — per-session load-skill dedup
      const skills = registerSkillTool(registry, { projectTrusted: projectTrustState() === "trusted", loadTracker: skillTracker });
      // IT#1 — resolve the live session log at call time (created after the
      // registry); absent → shell_context reports "not wired".
      const logRef: { current: { all: () => readonly SessionEvent[] } | null } = { current: null };
      if (bool(flags, "dev")) registerLocalTools(registry, flags, gate, { current: null }, false, logRef);
      attachAudit(registry, flags);
      const log = loadSession(sessionPath);
      logRef.current = log; // IT#1 — shell_context now resolves the live log
      const llm = buildLlm(flags);
      await probeWindow(flags);
      const safety = wireSafety(flags, { interactive: false });
      const loop = new AgentLoop({
        llm,
        tools: registry,
        log,
        systemPrompt: withSkillRoster(loadSystemPrompt(), skills, resolveContextWindow(flags)) + loadMemoryBlock() + agentProfilePrompt(flags),
        maxStepsPerTurn: Number(str(flags, "max-steps") ?? Infinity) || Infinity,
        contextWindow: resolveContextWindow(flags),
        compactAt: Number(process.env.AIH_COMPACT_AT ?? "") || 0.8,
        compactContext: () => compactTodoContext(log, process.cwd()),
        ...(safety ? { budget: safety.budget, costOf: safety.costOf, sensors: safety.sensors, onTripwire: safety.onTripwire, onEscalate: safety.onEscalate } : {}),
      });
      const send = async (prompt: string): Promise<string> => {
        const result = await loop.send(prompt);
        const events = log.all();
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i];
          if (e.type === "assistant/message" && e.text.trim()) return e.text;
        }
        return "";
      };
      const quiet = format === "json";
      const report = await runWorkflow(def, send, {
        onPhase: (phase, report) => {
          if (quiet) return;
          if (report.ok) {
            process.stderr.write(
              `${green("✓")} ${phase.name} (${report.attempts} attempt(s), ${report.parallel} call(s), ${report.ms}ms)\n`,
            );
          } else {
            process.stderr.write(
              `${red("✗")} ${phase.name} failed after ${report.attempts} attempt(s): ${report.error}\n`,
            );
          }
        },
      });
      saveSession(sessionPath, log);
      if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          report.ok
            ? `${green("workflow ok")} — ${report.phases.length} phase(s), ${report.ms}ms`
            : `${red("workflow failed")} at phase "${report.failedPhase}" (${report.ms}ms)`,
        );
        for (const phase of report.phases) {
          if (!phase.ok) console.log(`  ${red("✗")} ${phase.name}: ${phase.error}`);
          else console.log(`  ${green("✓")} ${phase.name} (${phase.attempts} attempt(s))`);
        }
      }
      process.exit(report.ok ? 0 : 1);
    } finally {
      backend.close();
    }
  }
  console.error(`error: unknown workflow subcommand "${sub}" (list|run)`);
  process.exit(1);
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
  // CC#52 — session-lived load-skill dedup tracker; survives registry rebuilds,
  // reset on compaction so a skill can be re-loaded once its instructions are
  // likely no longer in context.
  const skillTracker = new SkillLoadTracker();
  const tuiRef: { current: Tui | null } = { current: null };
  // IT#1 — the live session log, resolved by the shell_context tool at call
  // time. Populated below once `log` is created (after the first rebuild).
  const logRef: { current: { all: () => readonly SessionEvent[] } | null } = { current: null };
  // P#39 — TUI slash commands contributed by extensions.
  const extensionCommands = new Map<string, { run(args: string): void | Promise<void> }>();
  // P#39① — result-bearing extension events (cancel / rewrite / turn:end).
  const extensionEvents = createExtensionEventBridge();
  function rebuildRegistry(): void {
    registry = new ToolRegistry(gate);
    for (const def of backendDefs) {
      if (agentMode === "build" || def.kind !== "write") registry.register(def);
    }
    registry.planMode(agentMode === "plan");
    skills = registerSkillTool(registry, { projectTrusted: projectTrustState() === "trusted", loadTracker: skillTracker });
    registerArchiveReadTool(registry);
    void loadExtensions(registry, {
      enabled: !bool(flags, "no-extensions") && projectTrustState() === "trusted",
      commands: extensionCommands,
      onEvent: (event, handler) => extensionEvents.on(event as "tool:before" | "tool:after" | "turn:end", handler),
    });
    if (!bool(flags, "no-dev")) {
      registerLocalTools(registry, flags, gate, tuiRef, agentMode === "plan", logRef);
    }
    attachAudit(registry, flags);
    // Extension hooks ride LAST in the waterfall (after redaction+audit) so
    // they see the sanitized result and their rewrite lands in the log.
    const extHooks = extensionEvents.hookSet();
    if (extHooks.before || extHooks.after) registry.addHooks(extHooks);
  }
  rebuildRegistry();
  const appInfo = await backend.describe().catch(() => undefined);
  const appName =
    (appInfo && typeof appInfo === "object" && "name" in appInfo
      ? String((appInfo as { name: unknown }).name)
      : "") || "todo-app";

  // One store instance for the whole chat session: its flushedSeq baseline
  // (from load) drives per-event incremental appends between turns.
  const store = sessionPath ? new SessionStore(sessionPath) : undefined;
  const log = store?.load() ?? loadSession(sessionPath);
  logRef.current = log; // IT#1 — shell_context now resolves the live log
  process.on("exit", () => {
    saveSession(sessionPath, log);
  });
  const PLAN_PROMPT =
    "\n\nYou are in plan mode (read-only): write-capable tools are hidden in this " +
    "mode. Investigate with the available tools, then present a concrete step-by-step " +
    "implementation plan. Do not attempt to change any state.";
  const maxSteps = Number(str(flags, "max-steps") ?? Infinity) || Infinity;
  // PE#1/PE#2/PE#4 — interactive safety seam: escalate surfaces as TUI rows
  // (options + safest default); tripwire as a non-silent notice. `tuiSafety`
  // is assigned once `tui` exists (below) — makeLoop is only invoked after that.
  let tuiSafety:
    | (SafetyHooks & { costOf?: (u: import("@aih/core").TokenUsage) => number })
    | undefined;
  function makeLoop(): AgentLoop {
    return new AgentLoop({
      llm: buildLlm(flags),
      tools: registry,
      log,
      systemPrompt:
        withSkillRoster(loadSystemPrompt(), skills, resolveContextWindow(flags)) +
          (agentMode === "plan" ? PLAN_PROMPT : "") +
          loadMemoryBlock() +
          agentProfilePrompt(flags),
      maxStepsPerTurn: maxSteps,
      contextWindow: resolveContextWindow(flags),
      compactAt: Number(process.env.AIH_COMPACT_AT ?? "") || 0.8,
      compactContext: () => compactTodoContext(log, process.cwd()),
      ...(tuiSafety
        ? {
            budget: tuiSafety.budget,
            costOf: tuiSafety.costOf,
            sensors: tuiSafety.sensors,
            onTripwire: tuiSafety.onTripwire,
            onEscalate: tuiSafety.onEscalate,
          }
        : {}),
    });
  }
  await probeWindow(flags);
  let loop: AgentLoop;
  try {
    loop = makeLoop();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const streaming = !bool(flags, "no-stream") && !bool(flags, "mock");
  const bgChildren = new Map<string, ChildProcess>();
  // On TUI exit, in-flight background children can't be waited on synchronously;
  // kill them and mark the board entries cancelled so the board never lies.
  process.on("exit", () => {
    for (const [id, child] of bgChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      cancelJob(process.cwd(), id);
    }
  });
  let busy = false;
  let goalCondition = "";
  let goalRoundsLeft = 0;
  let echoEvents = false;
  // Seed the context-usage counter from the restored session's last completed
  // turn so `-c`/`--session` resume shows the real context immediately instead
  // of 0 (opencode/mimo derive this from the restored history on resume).
  // Window-bounded so garbage provider usage (28M-token prompts) is skipped
  // in favor of the local estimate. Seed from the live estimate so the panel
  // matches what would actually be sent (tool outputs truncated) — a stale
  // provider sample from an old turn would pin the panel instead.
  let usedTokens = estimateContextTokens(log.all());
  let peakTokens = usedTokens;
  // IT#2 — cached shell-failure detection (recomputed on tool/result, not per
  // paint). `undefined` = not yet computed; `[]` = all green (no indicator).
  let shellErrors: ShellError[] | undefined;
  if (process.env.AIH_ERROR_DETECT !== "0") {
    try {
      shellErrors = detectShellErrors(log.all());
    } catch {
      shellErrors = undefined;
    }
  }

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

  // F#30: resolve the active model's price (user `prices` override → built-in
  // table). Recomputed lazily so a runtime /model switch picks up the new price.
  const currentPrice = () => {
    const id =
      str(flags, "model") ??
      process.env.AIH_MODEL ??
      resolveLlm({}).model.value ??
      "";
    if (!id) return undefined;
    return resolvePrice(id, loadPrices());
  };

  /**
   * Switch the active model/provider at runtime: update the resolution flags,
   * refresh labels + context window and rebuild the loop (fresh LLM client).
   */
  async function applyModel(provider: string | undefined, modelId: string): Promise<void> {
    const prevFlags = { model: flags["model"], provider: flags["provider"], baseUrl: flags["base-url"] };
    const prevLabels = { model: modelLabel, provider: providerLabel };
    flags["model"] = modelId;
    flags["provider"] = provider ?? "";
    // A named provider is a self-contained unit: pin its own endpoint at the flag
    // level so stale launch-time env (AIH_BASE_URL/AIH_MODEL from start.sh) stops
    // leaking into the target provider (e.g. switching qwen→llama.cpp while the
    // session was launched against opencode Zen's https URL).
    if (provider) {
      const entry = providerEntry(provider);
      if (entry.baseUrl) flags["base-url"] = entry.baseUrl;
      else delete flags["base-url"];
    } else {
      delete flags["base-url"];
    }
    try {
      await probeWindow(flags);
      const re = resolveLlm({
        flagModel: str(flags, "model"),
        flagBaseUrl: str(flags, "base-url"),
        flagProvider: str(flags, "provider") || undefined,
        envModel: process.env.AIH_MODEL,
        envBaseUrl: process.env.AIH_BASE_URL,
      });
      modelLabel = re.model.value ?? modelId;
      providerLabel = re.provider ?? "custom";
      // Context size belongs to the conversation, not the model: re-seed from
      // the log (same as `-c` resume) instead of zeroing the panel.
      usedTokens = lastContextTokens(log.all(), resolveContextWindow(flags)).tokens;
      loop = makeLoop();
    } catch (err) {
      // A failed switch (e.g. target provider has no API key) must not kill
      // the session: roll back and report in-band.
      flags["model"] = prevFlags.model;
      flags["provider"] = prevFlags.provider;
      if (prevFlags.baseUrl === undefined) delete flags["base-url"];
      else flags["base-url"] = prevFlags.baseUrl;
      modelLabel = prevLabels.model;
      providerLabel = prevLabels.provider;
      tui.pushError(
        `model switch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Open the command palette (ctrl-p / /commands). */
  async function openPalette(): Promise<void> {
    if (busy) {
      tui.pushSystem("finish the current turn before opening the palette");
      return;
    }
    type Command = { name: string; hint: string; run: () => void | Promise<void> };
    const commands: Command[] = [
      { name: "switch model", hint: "change provider/model", run: () => openModelPicker() },
      { name: "mode build", hint: "full toolset (tab)", run: () => setMode("build") },
      { name: "mode plan", hint: "read-only planning (tab)", run: () => setMode("plan") },
      { name: "compact context", hint: "/compact — summarize earlier history", run: () => handleLine("/compact") },
      { name: "usage", hint: "/usage — token usage this session", run: () => handleLine("/usage") },
      { name: "fork session", hint: "/fork <target> [--from seq] — branch a session", run: () => handleLine("/fork") },
      { name: "tools", hint: "/tools — connected tools & permissions", run: () => handleLine("/tools") },
      { name: "skills", hint: "/skills — installed skill packs", run: () => handleLine("/skills") },
      { name: "memory", hint: "/memory — project memory (.aih/memory.md)", run: () => handleLine("/memory") },
      { name: "dream", hint: "/dream — mine recent sessions for memory-worthy knowledge", run: () => handleLine("/dream") },
      { name: "distill", hint: "/distill — repeated flows → skill/workflow candidates", run: () => handleLine("/distill") },
      { name: "tidy memory", hint: "/tidy [project|user] — dedup duplicate memory entries (apply to write)", run: () => handleLine("/tidy") },
      { name: "events", hint: "/events — session event log toggle", run: () => handleLine("/events") },
      { name: "help", hint: "? /help — keybindings & shortcuts", run: () => tui.openHelp() },
      { name: "vivid (concise render)", hint: "/vivid — toggle plain render (no borders/panel)", run: () => handleLine("/vivid") },
      { name: "background jobs", hint: "/bg <prompt> — dispatch a background agent turn (list/cancel)", run: () => handleLine("/bg") },
      { name: "sessions panel", hint: "/sessions — multi-agent session dashboard (kill/view)", run: () => handleLine("/sessions") },
      { name: "search tool output", hint: "/find <text> — search across tool outputs (T#22)", run: () => handleLine("/find") },
      { name: "shell context", hint: "/shell — recent run_cmd output + exit codes (IT#1) · /shell --send", run: () => handleLine("/shell") },
      { name: "fix shell errors", hint: "/fix — detect failed run_cmd + send to agent (IT#2) · /fix --show", run: () => handleLine("/fix") },
      { name: "clear chat", hint: "/clear — clear the message view", run: () => handleLine("/clear") },
      { name: "exit", hint: "quit aih (busy turn is cancelled first)", run: () => handleLine("exit") },
    ];
    const entries = commands.map((c) => ({ label: c.name, hint: c.hint }));
    const outcome = await tui.pick("Commands", entries);
    if (outcome.kind === "select") await commands[outcome.index].run();
  }

  /** Open the model picker overlay listing every configured provider/model. */
  async function openModelPicker(): Promise<void> {
    if (bool(flags, "mock")) {
      tui.pushSystem("model picker unavailable in --mock mode");
      return;
    }
    const catalog = loadModelCatalog(
      providerLabel === "custom" ? undefined : providerLabel,
      modelLabel,
    );
    if (!catalog.length) {
      tui.pushSystem(
        'no models configured — add providers to aih.json:\n{\n  "providers": { "<name>": { "baseUrl": "...", "model": "..." } }\n}',
      );
      return;
    }
    const short = (u?: string): string =>
      !u ? "" : u.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "") || u;
    const entries = catalog.map((e: ModelCatalogEntry) => ({
      label: `${e.provider}/${e.model}`,
      ...(e.baseUrl ? { hint: short(e.baseUrl) } : {}),
      ...(e.active ? { active: true } : {}),
    }));
    const outcome = await tui.pick("Switch model", entries);
    if (outcome.kind !== "select") return;
    const entry = catalog[outcome.index];
    if (!entry || entry.active) return;
    await applyModel(entry.provider === "(default)" ? undefined : entry.provider, entry.model);
    tui.pushSystem(
      `switched model to ${entry.provider}/${entry.model} (context window ${resolveContextWindow(flags)})`,
    );
  }


  const { byteToAction, warnings: kbWarnings } = buildKeybindDispatch(loadKeybinds());
  const tui = new Tui({
    placeholder: 'Ask anything... "add a todo"',
    keybinds: { byteToAction },
    keybindWarnings: kbWarnings,
    meta: () => ({ agent: agentMode, model: modelLabel, provider: providerLabel }),
    cwd: process.cwd(),
    statusLeft: `${appName} · aih ${VERSION}`,
    statusRight: `S:${initialTitle ?? sessionName}`,
    statusBadge: () => {
      const n = registry.schemas().length;
      return { glyph: "⊙", ok: n > 0, label: `${n} MCP` };
    },
    // IT#2 — shell-failure indicator (red ⚠ when a run_cmd failed; hidden when green).
    shellErrorBadge: () =>
      process.env.AIH_ERROR_DETECT !== "0"
        ? errorBadge(shellErrors ?? [])
        : null,
    jobStatus: () => {
      const s = summarize(loadBoard(process.cwd()));
      return s.running + s.done + s.failed > 0 ? s : null;
    },
    busy: () => busy,
    cancelTurn: () => loop.cancel(),
    onLine: handleLine,
    onLineBusy: (line) => {
      const t = line.trim();
      // Slash commands need a quiet session — keep the queued fallback for
      // them. Known slash only: unknown "/..." is a message and gets steered.
      if (!t || isKnownSlash(t)) return false;
      loop.steer(t);
      tui.pushSystem("↳ steering — lands before the next step of the running turn");
      return true;
    },
    onLineKnownSlash: (line) => isKnownSlash(line),
    onTab: () => setMode(agentMode === "build" ? "plan" : "build"),
    onPalette: () => {
      void openPalette();
    },
    completions: () => [
      "/help",
      "/commands",
      "/tools",
      "/mode",
      "/goal",
      "/memory",
      "/model",
      "/models",
      "/usage",
      "/compact",
      "/checkpoint",
      "/restore",
      "/fork",
      "/tree",
      "/dream",
      "/distill",
      "/tidy",
      "/find",
      "/shell",
      "/fix",
      "/vivid",
      "/bg",
      "/sessions",
      "/clear",
      "/inject",
      "/events",
      "/skills",
      ...skills.map((s) => `/${s.name}`),
    ],
    ctxUsage: () => {
      try {
        const win = resolveContextWindow(flags);
        const trend = log
          .all()
          .filter((e) => e.type === "turn/end")
          .map((e) => (e.type === "turn/end" ? (e.usage?.promptTokens ?? 0) : 0))
          .filter((n) => sanePromptTokens(n, win))
          .slice(-8);
        // F#30: cost + throughput (only when the model has a price table entry)
        const price = currentPrice();
        const usage = aggregateUsage(log.all());
        // P#41: cache hit rate (undefined when the provider never reports it)
        const chr = cacheHitRate(log.all());
        return {
          used: usedTokens,
          limit: win,
          trend,
          ...(chr !== undefined ? { cacheRate: chr } : {}),
          ...(price && usage.totalTokens > 0
            ? { cost: totalCost(log.all(), price) }
            : {}),
          ...(usage.totalTokens > 0
            ? { tps: tokensPerSecond(log.all()) }
            : {}),
          ...(usage.totalTokens > 0
            ? { stps: streamingTps(log.all()) }
            : {}),
        };
      } catch (err) {
        // Paint path must never throw: a transient config read failure (e.g.
        // racing this process's own atomic-rename window) used to escape the
        // paint timer as an uncaught exception and kill the whole TUI.
        if (process.env.AIH_DEBUG_PANEL) {
          process.stderr.write(`[aih] ctxUsage error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return { used: usedTokens, limit: 0, trend: [] };
      }
    },
  });
  void echoEvents;
  gate.attachTui(tui);
  tuiRef.current = tui;

  // PE#1/PE#2/PE#4 — interactive safety seam (assigned now that `tui` exists,
  // so escalate/tripwire rows land in the TUI instead of stderr).
  tuiSafety = wireSafety(flags, {
    interactive: true,
    line: (t) => tui.pushSystem(t),
  });

  // P2#7 helpers — dream/distill over recent session logs (bounded).
  function collectSessionEventsForDream(): SessionEvent[][] {
    return sessionFiles()
      .slice(0, 5)
      .map((f) => {
        try {
          return readSessionEvents(f.name);
        } catch {
          return [];
        }
      });
  }

  async function runDream(): Promise<void> {
    tui.pushSystem("dream: scanning recent sessions…");
    const material = extractDreamMaterial(collectSessionEventsForDream());
    const summary = formatDreamMaterial(material);
    if (summary.includes("(nothing notable found)")) {
      tui.pushSystem(`dream found nothing notable.\n${summary}`);
      return;
    }
    // One no-tools LLM pass distills the material into memory prose; the
    // result is only SUGGESTED — the user applies it via the remember tool.
    try {
      const resp = await buildLlm(flags).complete({
        messages: [
          {
            role: "system",
            content:
              "You turn scanned agent-session findings into durable project-memory entries. " +
              "Output at most 5 concise markdown bullet lines (each starting with '- '), each stating a " +
              "durable fact/convention/preference worth remembering across sessions. No preamble.",
          },
          { role: "user", content: `Scanned session material:\n${summary}\n\nWrite the memory bullets.` },
        ],
        tools: [],
      });
      const bullets = resp.text
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .slice(0, 5)
        .join("\n");
      if (!bullets) {
        tui.pushSystem(`dream produced no memory bullets. Raw material:\n${summary}`);
        return;
      }
      tui.pushSystem(
        `dream suggests adding to .aih/memory.md:\n${bullets}\n\n` +
          `apply with the remember tool (e.g. tell me "记住这些" or use remember action=append), or /memory to review first`,
      );
    } catch (err) {
      tui.pushError(`dream LLM pass failed: ${err instanceof Error ? err.message : String(err)}\nRaw material:\n${summary}`);
    }
  }

  function setMode(mode: "build" | "plan"): void {    if (agentMode === mode) return;
    if (busy) {
      tui.pushSystem("finish the current turn before switching mode");
      return;
    }
    const prevMode = agentMode;
    agentMode = mode;
    rebuildRegistry();
    try {
      loop = makeLoop();
    } catch (err) {
      agentMode = prevMode;
      rebuildRegistry();
      tui.pushError(
        `mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    tui.pushSystem(
      mode === "plan"
        ? "mode: plan — read-only (write tools hidden)"
        : "mode: build — full toolset",
    );
  }

  const questionCalls = new Set<string>();
  // opencode parity: after a compaction, show what the summarizer produced —
  // not just a status line. Preview of the newest compaction summary.
  const summaryPreview = (): string => {
    for (let i = log.all().length - 1; i >= 0; i -= 1) {
      const e = log.all()[i];
      if (e.type === "compaction") {
        const body = (e.summary ?? "").trim();
        if (!body) return "";
        const lines = body.split("\n");
        return `\n${dim("── compaction summary ──")}\n${lines.slice(0, 8).join("\n")}${lines.length > 8 ? `\n${dim("… full summary in the session log (/events)")}` : ""}`;
      }
    }
    return "";
  };
  // Refresh the live context gauge on every event that changes context size
  // (tool result, compaction, turn end) so the panel reflects each append, not
  // just turn-completion. Uses the live estimate (what deriveMessages would
  // actually send) rather than lastContextTokens, which pins the panel to a
  // stale provider sample from the newest sane turn/end — it never moves while
  // a turn is in flight.
  const refreshContextGauge = (): void => {
    usedTokens = estimateContextTokens(log.all());
    if (usedTokens > peakTokens) peakTokens = usedTokens;
    // IT#2 — recompute the shell-failure indicator (deterministic, cheap:
    // reuses IT#1's extractShellContext over the bounded recent window).
    if (process.env.AIH_ERROR_DETECT !== "0") {
      try {
        shellErrors = detectShellErrors(log.all());
      } catch {
        shellErrors = undefined; // best-effort — never break the gauge
      }
    }
    tui.requestPaint();
  };

  log.subscribe((event: SessionEvent) => {
    // Per-event durability: a long-running turn no longer lives only in
    // memory — every event is appended to the session file as it happens.
    if (store) {
      try {
        store.flushIncremental(log);
      } catch {
        /* disk hiccup: per-turn save + exit save still cover us */
      }
    }
    if (
      event.type === "tool/result" ||
      event.type === "compaction" ||
      event.type === "turn/end"
    ) {
      refreshContextGauge();
    }
    if (event.type === "tool/call") {
      if (event.name === "question") {
        // The "❓ <question>" line is pushed when the question is asked
        // (askQuestion); a tool item would duplicate the question text.
        // Remember the callId so the result renders the answer instead.
        questionCalls.add(event.callId);
      } else {
        tui.pushTool(event.name, event.args, event.callId);
      }
    } else if (event.type === "tool/result") {
      if (questionCalls.delete(event.callId)) {
        tui.pushSystem(`→ ${questionAnswer(event.result) ?? "(no answer)"}`);
      } else {
        tui.resolveTool(event.callId, event.ok !== false, event.result);
      }
     } else if (event.type === "assistant/message" && streaming === false && event.text) {
        tui.push({ role: "assistant", text: event.text });
      } else if (event.type === "compaction") {
        if (event.trigger === "manual") return; // /compact prints its own detailed line
        skillTracker.reset(); // CC#52 — instructions may be summarized away; allow reload
        const window = resolveContextWindow(flags);
        const pct = usedTokens ? Math.round((usedTokens / window) * 100) : null;
        tui.pushSystem(
          (pct !== null ? `context ~${pct}% — compacted` : "compacted") +
            " (earlier messages summarized, continuing)" +
            summaryPreview(),
        );
      } else if (event.type === "turn/end") {
        // P#39① — extension turn:end subscribers fire on every finished turn.
        extensionEvents.emit("turn:end", { stopReason: event.stopReason, usage: event.usage });
      } else if (event.type === "escalate") {
        // PE#4 — model-invisible escalation (hard budget / sensor red after
        // retries). The onEscalate hook already printed the options live; this
        // branch covers resume/replay so the decision point is never lost.
        tui.pushSystem(
          `⛔ escalated: ${event.reason}\n` +
            event.options.map((o, i) => `   ${i + 1}. ${o}`).join("\n") +
            `\n   (safest default: ${event.safestDefault})`,
        );
      }
    });

  tui.start();
  for (const w of kbWarnings) tui.pushSystem(`keybind warning: ${w}`);
  tui.push({
    role: "banner",
    text: ["█▀▀▀ ▀█▀ █ █", "█▄▄█  █  ███", "█  █ ▄█▄ █ █"].join("\n"),
  });
  tui.pushSystem(`app intelligence harness · v${VERSION}\n`);
  tui.pushSystem(`type a message · /commands · ctrl-p palette`);
  if (sessionPath && log.all().length) {
    const events = log.all();
    tui.pushSystem(`resumed session ${sessionPath} (${events.length} events)`);
    replayHistory(tui, events);
    // MK#45 — resume is not retry: scan the log for an interrupted turn and
    // classify its tool facts honestly instead of silently continuing.
    const rep = scanRecovery(events);
    if (rep.openTurn) {
      const lines = [
        `⚠ interrupted turn detected: "${rep.openTurn}" never completed`,
        ...rep.facts.map((f) => `  ${describeFact(f)}`),
      ];
      if (rep.parked) {
        lines.push(
          `parked (${PARK_REASON}): at least one tool was dispatched whose outcome is unknown — ` +
            `its side effect may have happened. Review the facts above; the next message starts a FRESH turn ` +
            `(nothing is re-run automatically).`,
        );
      } else {
        lines.push("all tool calls in the open turn have recorded outcomes or provably never ran — safe to continue");
      }
      tui.pushSystem(lines.join("\n"));
    }
  }

  function evalTurn(
    input: string,
  ): Promise<Awaited<ReturnType<AgentLoop["send"]>>> {
    busy = true;
    // CC#51 — usage-limit (quota) auto-resume: when the provider spends its
    // usage window it returns a quota 429. Instead of ending the turn with an
    // error we WAIT for the reset and re-issue the same call. Opt out with
    // AIH_QUOTA_AUTO_RESUME=0. (Non-interactive `run` never passes this hook,
    // so it fails fast and predictably.)
    const quotaAutoResume = process.env.AIH_QUOTA_AUTO_RESUME !== "0";
    const quotaWait = quotaAutoResume
      ? {
          begin: (info: { retryAfterSec: number; resumeAtMs: number; wait: number }) => {
            const at = new Date(info.resumeAtMs).toLocaleTimeString();
            tui.pushSystem(
              `⏳ [quota] usage limit exhausted — will auto-resume at ${at} ` +
                `(~${info.retryAfterSec}s, wait ${info.wait})`,
            );
          },
          end: (reason: string) => {
            tui.pushSystem(
              reason === "aborted"
                ? "⏹ quota wait aborted"
                : "⏳ [quota] window reset — resuming the interrupted call…",
            );
          },
        }
      : undefined;
    const promise = loop
      .send(
        input,
        streaming
          ? {
              onDelta: (d) => tui.pushDelta(d),
              onRetry: () => tui.resetStream(),
              ...(quotaWait ? { quotaWait } : {}),
            }
          : quotaWait
            ? { quotaWait }
            : undefined,
      )
      .finally(() => {
        busy = false;
      });
    return promise;
  }

  // FB#6 — goal judge as a two-judge panel (primary + optional
  // AIH_SECOND_JUDGE_MODEL). Returns the verdict plus whether the panel
  // degraded (disagreement / one judge failed) so it can be recorded.
  async function judgeGoal(): Promise<{ met: boolean; reason: string; unmet: string[]; degraded: boolean }> {
    const panel = await judgePanel(
      buildLlm(flags),
      {
        messages: [
          ...log.deriveMessages(),
          { role: "user", content: buildGoalJudgePrompt(goalCondition) },
        ],
        tools: [],
      },
      parseGoalVerdict,
      buildJudge2Llm(flags),
      "goal",
      (a, b) => a.met === b.met,
    );
    return { ...panel.verdict, degraded: panel.degraded };
  }

  // Most recent turnId on record (falls back to a synthetic id) so goal/judge
  // events can be correlated with the turn they judged.
  function lastTurnId(): string {
    const events = log.all();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if ("turnId" in e && e.turnId) return e.turnId;
    }
    return `goal_${Date.now().toString(36)}`;
  }

  function recordGoalJudge(
    verdict: { met: boolean; reason: string; unmet: string[]; degraded?: boolean },
    roundsLeft: number,
  ): void {
    log.append({
      type: "goal/judge",
      turnId: lastTurnId(),
      met: verdict.met,
      reason: verdict.reason,
      unmet: verdict.unmet,
      roundsLeft,
      ...(verdict.degraded ? { degraded: true } : {}),
    });
    store?.save(log);
  }

  async function runGoalCheck(): Promise<void> {
    if (!goalCondition) return;
    for (;;) {
      let verdict: { met: boolean; reason: string; unmet: string[] };
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
        recordGoalJudge(verdict, 0);
        tui.pushSystem(`✅ goal met — ${verdict.reason}`);
        return;
      }
      if (goalRoundsLeft <= 0) {
        goalCondition = "";
        recordGoalJudge(verdict, 0);
        tui.pushSystem(
          `⏹ goal not met after auto-continue rounds — stopping (${verdict.reason})`,
        );
        return;
      }
      goalRoundsLeft -= 1;
      recordGoalJudge(verdict, goalRoundsLeft);
      const unmetNote = verdict.unmet.length
        ? `\n[goal] Unverified criteria: ${verdict.unmet.join("; ")}\n` +
          `Verify each against real persisted state (read the file, run the check) — do not re-claim completion without fresh evidence.\n`
        : "";
      tui.pushSystem(
        `↻ goal check: not yet met — ${verdict.reason} (auto-continuing, ${goalRoundsLeft} left)`,
      );
      const started = Date.now();
      try {
        await evalTurn(
          `${unmetNote}[goal] The goal "${goalCondition}" is not yet met. Judge's note: ${verdict.reason}\nContinue working until the goal is fully achieved.`,
        );
        store?.save(log);
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

  // Slash-command recognition (opencode semantics): a "/" input is only a
  // command when its head token names a known builtin / skill / extension
  // command. Everything else — including code pasted at the prompt like
  // `setvbuf(stdout, ...)` commented with `//` or `/* ... */` — falls through
  // to the model as a normal message instead of "unknown command".
  const isKnownSlash = (text: string): boolean =>
    isKnownSlashCommand(
      text,
      [...skills.map((s) => s.name), ...extensionCommands.keys()],
    );

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) return;

    tui.push({ role: "user", text: line });

    // IT#3: `?` prefix — type `?` + a natural-language task to start an agent
    // in a BACKGROUND session with the active context auto-injected (recent
    // shell output / cwd / active session). The foreground TUI is never
    // interrupted; the job's result is surfaced when it completes (D#13 board).
    // Recognized BEFORE the busy-steering check so it works even mid-turn.
    {
      const q = classifyQuestionPrefix(input);
      if (q.isQuestion) {
        // AIH_QUESTION_CONTEXT=0 disables auto-injection (task only).
        const context =
          process.env.AIH_QUESTION_CONTEXT === "0"
            ? ""
            : buildQuestionContext({
                events: log.all(),
                cwd: process.cwd(),
                sessionName: sessionName || undefined,
              });
        const prompt = composeQuestionPrompt(context, q.prompt);
        const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
        const session = `bg-${Date.now().toString(36)}`;
        const argv = [cliPath, "run", prompt, "--session", session, "--no-audit", "--no-stream", "--format", "text"];
        const { job, child } = spawnJob(process.cwd(), q.prompt, { cli: cliPath, argv });
        bgChildren.set(job.id, child);
        child.on("close", () => {
          bgChildren.delete(job.id);
          const finished = jobById(process.cwd(), job.id);
          if (finished) {
            const icon = finished.status === "done" ? "✓" : finished.status === "failed" ? "✗" : "⊘";
            tui.pushSystem(
              `${icon} ? background task ${job.id} ${finished.status}: ${finished.label}` +
                (finished.preview ? `\n${finished.preview}` : "") +
                `\nfull output: ${finished.out} · session: ${finished.session}`,
            );
          }
          tui.requestPaint();
        });
        tui.pushSystem(
          `▶ dispatched background task ${job.id}: ${job.label}\n` +
            `  (context injected: cwd${context ? " + shell history" : ""}; TUI stays responsive; /bg list to track)`,
        );
        tui.requestPaint();
        return;
      }
    }

    // P#35 — steering: while a turn is running, plain text input is queued
    // into the running loop (lands after the current tool batch) instead of
    // being rejected; slash commands that need a quiet session still refuse.
    // CC slash-recognition: only KNOWN slash commands take the command path —
    // unknown "/..." input is steered as a normal message.
    if (busy && !isKnownSlash(input)) {
      loop.steer(input);
      tui.pushSystem("↳ steering — will land before the next step of the running turn");
      return;
    }

    if (input === "/exit" || input === "/quit") {
      tui.stop();
      backend.close();
      process.exit(0);
    }
    if (input === "/clear") {
      tui.clearItems();
      return;
    }
    // T#22: /find — search across tool outputs (expanded content, incl. the
    // 32KB in-band cap). Expands matched tools and scrolls the first hit into
    // view; results are listed newest-first (capped at 12).
    if (input === "/find" || input.startsWith("/find ")) {
      const q = input === "/find" ? "" : input.slice("/find ".length).trim();
      if (!q) {
        tui.pushSystem("usage: /find <text> — search tool outputs (e.g. /find ECONNREFUSED)\n  (full output beyond the 32KB cap: run_cmd keep_output=true → output_file)");
        return;
      }
      const { n, matches } = tui.searchTools(q);
      if (!n) {
        tui.pushSystem(`no tool output matched "${q}"`);
        return;
      }
      const rows = matches
        .slice(-12)
        .reverse()
        .map((m) => `  ${m.tool} · line ${m.line}  ${m.snippet}`);
      tui.pushSystem(`found ${n} line(s) matching "${q}" (showing last ${rows.length}):\n${rows.join("\n")}`);
      return;
    }
    // IT#1: /shell — show the recent shell (run_cmd) context the agent can
    // reach for: command, exit code, output tail, and the full-output file
    // when keep_output was used. `--send` also injects it into the next turn.
    if (input === "/shell" || input.startsWith("/shell ")) {
      const arg = input === "/shell" ? "" : input.slice("/shell ".length).trim();
      const cmds = extractShellContext(log.all());
      if (!cmds.length) {
        tui.pushSystem(
          "no shell history yet — run a command with run_cmd first.\n" +
            "  (auto-inject on the next turn: set AIH_SHELL_CONTEXT=auto)",
        );
        return;
      }
      const rows = cmds
        .slice()
        .reverse()
        .map((c) => {
          const tail = c.output.replace(/\s+$/, "").split("\n").slice(-6).join("\n");
          const lines = [describeCommand(c)];
          if (tail) lines.push(`    ${tail.replace(/\n/g, "\n    ")}`);
          if (c.outputTruncated) lines.push("    …(earlier output elided)…");
          if (c.outputFile) lines.push(`    full output: ${c.outputFile}`);
          return lines.join("\n");
        });
      tui.pushSystem(`recent shell context (newest last):\n${rows.join("\n")}`);
      if (arg === "--send") {
        const block = formatShellContext(cmds);
        if (block) {
          loop.inject(block);
          tui.pushSystem("↳ injected into the next turn — send a message to use it");
        }
      }
      return;
    }
    // IT#2: /fix — deterministic shell-failure detection → one-click fix.
    // Detects the recent failed run_cmd calls (non-zero exit / timeout),
    // frames them as a fix request, and sends them to the agent as a turn.
    // `--show` only lists the failures (no turn); `--dry` shows the block.
    if (input === "/fix" || input.startsWith("/fix ")) {
      const arg = input === "/fix" ? "" : input.slice("/fix ".length).trim();
      if (busy) {
        tui.pushSystem("a turn is already running — wait for it to finish, then /fix");
        return;
      }
      const errors = detectShellErrors(log.all());
      if (errors.length === 0) {
        tui.pushSystem(
          "no shell failures detected — the recent run_cmd calls all exited 0 (or there is no shell history yet).",
        );
        return;
      }
      const block = formatFixBlock(errors);
      tui.pushSystem(
        `⚠ detected ${errors.length} shell failure(s):\n${summarizeErrors(errors)}`,
      );
      if (arg === "--show" || arg === "--dry") {
        tui.pushSystem(`fix block (not sent):\n${block}`);
        return;
      }
      tui.pushSystem("→ sending the failures to the agent for a fix…");
      try {
        const started = Date.now();
        await evalTurn(block);
        for (;;) {
          const queued = loop.drainQueued("followUp");
          if (queued.length === 0) break;
          for (const q of queued) {
            tui.pushSystem(`→ follow-up: ${q}`);
            await evalTurn(q);
            store?.save(log);
          }
        }
        store?.save(log);
        const dur = Date.now() - started;
        tui.push({ role: "footer", text: `▣ fix · ${((dur / 1000)).toFixed(1)}s` });
      } catch (err) {
        tui.pushError(err instanceof Error ? err.message : String(err));
      } finally {
        tui.turnSettled();
      }
      return;
    }
    // D#13: /bg — background tasks (dispatch + status + cancel)
    if (input === "/bg" || input.startsWith("/bg ")) {
      const arg = input === "/bg" ? "" : input.slice("/bg ".length).trim();
      if (arg === "list" || arg === "") {
        const board = loadBoard(process.cwd());
        if (!board.jobs.length) {
          tui.pushSystem("no background jobs yet — dispatch one with /bg <prompt>");
          return;
        }
        const rows = board.jobs
          .slice(-12)
          .reverse()
          .map((j) => {
            const icon = j.status === "running" ? "▶" : j.status === "done" ? "✓" : j.status === "failed" ? "✗" : "⊘";
            const when = j.finishedAt ? `${Math.round((j.finishedAt - j.startedAt) / 1000)}s` : `${Math.round((Date.now() - j.startedAt) / 1000)}s…`;
            return `  ${icon} ${j.id}  ${j.label}  [${j.status} · ${when}]${j.preview ? `\n      ${j.preview}` : ""}`;
          });
        tui.pushSystem(`background jobs:\n${rows.join("\n")}`);
        return;
      }
      if (arg.startsWith("cancel ")) {
        const id = arg.slice("cancel ".length).trim();
        const child = bgChildren.get(id);
        const ok = cancelJob(process.cwd(), id, child);
        if (ok) {
          bgChildren.delete(id);
          tui.pushSystem(`cancelled job ${id}`);
        } else {
          tui.pushSystem(`no running job ${id} to cancel`);
        }
        tui.requestPaint();
        return;
      }
      const prompt = arg;
      if (!prompt) {
        tui.pushSystem("usage: /bg <prompt> — dispatch a background agent turn (or /bg list · /bg cancel <id>)");
        return;
      }
      const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
      // Direct subcommands run as a plain CLI job (no LLM turn): distill / tidy.
      const direct = /^(distill|tidy)(\s|$)/.exec(prompt);
      const argv = direct
        ? [cliPath, ...prompt.split(/\s+/)]
        : [cliPath, "run", prompt, "--session", `bg-${Date.now().toString(36)}`, "--no-audit", "--no-stream", "--format", "text"];
      const { job, child } = spawnJob(process.cwd(), prompt, { cli: cliPath, argv });
      bgChildren.set(job.id, child);
      child.on("close", () => {
        bgChildren.delete(job.id);
        // surface the result + refresh the status line
        const finished = jobById(process.cwd(), job.id);
        if (finished) {
          const icon = finished.status === "done" ? "✓" : finished.status === "failed" ? "✗" : "⊘";
          tui.pushSystem(
            `${icon} background job ${job.id} ${finished.status}: ${finished.label}` +
              (finished.preview ? `\n${finished.preview}` : "") +
              `\nfull output: ${finished.out} · session: ${finished.session}`,
          );
        }
        tui.requestPaint();
      });
      tui.pushSystem(`▶ dispatched background job ${job.id}: ${job.label}\n  (TUI stays responsive; /bg list to track, /bg cancel ${job.id} to stop)`);
      tui.requestPaint();
      return;
    }
    // IT#4: /sessions — multi-agent session management panel.
    // Lists active background agent sessions + every saved session with token
    // usage + model cost, in one control surface. Subcommands:
    //   /sessions            — dashboard
    //   /sessions kill <id>  — cancel a running background job
    //   /sessions view <name>— per-session token/cost summary
    if (input === "/sessions" || input.startsWith("/sessions ")) {
      const arg = input === "/sessions" ? "" : input.slice("/sessions ".length).trim();
      if (arg.startsWith("kill ")) {
        const id = arg.slice("kill ".length).trim();
        const child = bgChildren.get(id);
        const ok = cancelJob(process.cwd(), id, child);
        if (ok) {
          bgChildren.delete(id);
          tui.pushSystem(`killed job ${id}`);
        } else {
          tui.pushSystem(`no running job ${id} to kill`);
        }
        tui.requestPaint();
        return;
      }
      if (arg.startsWith("view ")) {
        const name = arg.slice("view ".length).trim();
        if (!name || !name.match(/^[\w-]+$/)) {
          tui.pushSystem("usage: /sessions view <session-name>");
          return;
        }
        const events = readSessionEvents(name);
        if (events.length === 0) {
          tui.pushSystem(`no saved session named "${name}"`);
          return;
        }
        const usage = aggregateUsage(events);
        const modelId = process.env.AIH_MODEL ?? resolveLlm({}).model.value ?? "";
        const price = modelId ? resolvePrice(modelId, loadPrices()) : undefined;
        const cost = price ? (usage.totalTokens / 1e6) * price.input : 0;
        tui.pushSystem(
          `session ${name}: ${usage.totalTokens} tokens (${usage.promptTokens} prompt / ${usage.completionTokens} completion)` +
            (price ? ` · cost ${fmtCost(cost)}` : ""),
        );
        return;
      }
      // Dashboard: job board + saved session usage.
      const board = loadBoard(process.cwd());
      const usageMap = new Map<string, number>();
      for (const f of sessionFiles()) {
        const u = aggregateUsage(readSessionEvents(f.name));
        usageMap.set(f.name, u.totalTokens);
      }
      const savedNames = sessionFiles().map((f) => f.name);
      const modelId = process.env.AIH_MODEL ?? resolveLlm({}).model.value ?? "";
      const price = modelId ? resolvePrice(modelId, loadPrices()) : undefined;
      const dash = buildDashboard(board.jobs, usageMap, price, savedNames);
      tui.pushSystem(`sessions dashboard:\n${formatDashboard(dash)}`);
      return;
    }
    // P2#9: /vivid toggles the concise (plain) render mode — no borders/surface/panel.
    if (input === "/vivid") {
      const on = !tui.isPlain();
      tui.setPlain(on);
      tui.pushSystem(on ? "vivid: concise render ON (no borders/panel/chrome)" : "vivid: concise render OFF (full theme)");
      return;
    }
    // F#28: checkpoint / restore (append-only rollback to a marker)
    if (input === "/checkpoint" || input.startsWith("/checkpoint ")) {
      const note = input === "/checkpoint" ? "" : input.slice("/checkpoint ".length).trim();
      if (busy) {
        tui.pushSystem("finish the current turn before checkpointing");
        return;
      }
      const cp = log.checkpoint(
        note || undefined,
        usedTokens || undefined,
        gitStatusSummary({ cwd: process.cwd() }),
      );
      store?.save(log);
      const wtLines = cp.worktree ? formatWorktreeSummary(cp.worktree) : [];
      tui.pushSystem(
        `checkpoint #${cp.seq} recorded${note ? ` — ${note}` : ""}` +
          (wtLines.length ? `\n${wtLines.join("\n")}` : "") +
          `\nrestore later with /restore [seq] (rolls back context to that point; the discarded suffix stays auditable in the log)`,
      );
      return;
    }
    if (input === "/restore" || input.startsWith("/restore ")) {
      if (busy) {
        tui.pushSystem("finish the current turn before restoring");
        return;
      }
      const arg = input === "/restore" ? "" : input.slice("/restore ".length).trim();
      const cps = log.all().filter((e) => e.type === "checkpoint");
      if (cps.length === 0) {
        tui.pushSystem("no checkpoints yet — record one with /checkpoint [note]");
        return;
      }
      let target: (SessionEvent & { type: "checkpoint" }) | undefined = log.latestCheckpoint();
      if (!target) {
        tui.pushSystem("no checkpoints yet — record one with /checkpoint [note]");
        return;
      }
      if (arg) {
        const want = Number.parseInt(arg, 10);
        target = cps.find(
          (c): c is SessionEvent & { type: "checkpoint" } => c.type === "checkpoint" && c.seq === want,
        );
        if (!target) {
          tui.pushSystem(
            `no checkpoint at seq ${arg} — available: ${cps.map((c) => `#${c.seq}${(c as { note?: string }).note ? ` (${(c as { note?: string }).note})` : ""}`).join(", ")}`,
          );
          return;
        }
      }
      const restored = log.restoreTo(target.seq);
      // MK#47: identity gate — a checkpoint carries the workspace UUID it was
      // taken in. A mismatch means this session's checkpoints belong to a
      // DIFFERENT workspace (e.g. the log was forked across repos): refuse
      // rather than silently rolling back foreign context. Unknown (no marker
      // either side, e.g. unwritable fs) is advisory and does not block.
      const cpWt: { workspaceId?: string } | undefined = target.worktree;
      if (cpWt?.workspaceId) {
        const now = peekWorkspaceIdentity();
        const check = compareIdentity(now, { uuid: cpWt.workspaceId, path: "" });
        if (check === "mismatch") {
          tui.pushError(
            `restore refused: checkpoint #${target.seq} was recorded in a different workspace ` +
              `(marker ${cpWt.workspaceId.slice(0, 8)}… vs here ${now?.uuid.slice(0, 8)}…) — ` +
              `the history was probably forked across repositories`,
          );
          return;
        }
        if (check === "unknown") {
          tui.pushSystem(
            "note: no local workspace marker (.aih/workspace.json) — cannot verify this checkpoint's origin",
          );
        }
      }
      // Append-only: snapshot the FULL pre-restore history to a side file so
      // the discarded suffix stays auditable (the live file will be rewritten
      // to the restored prefix below).
      let snapshot = "";
      if (sessionPath) {
        const base = basename(sessionPath).replace(/\.jsonl$/, "");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const snapName = `${base}-pre-restore-${stamp}.jsonl`;
        const snapPath = join(dirname(sessionPath), snapName);
        saveSession(snapPath, log);
        snapshot = snapName;
      }
      log.adopt(restored);
      tui.clearItems();
      replayHistory(tui, restored.all());
      store?.save(log);
      usedTokens = target.contextTokens ?? 0;
      // P#37② — stateful tools roll back WITH the timeline: recover the todo
      // snapshot from the restored prefix and re-apply it to .aih/todos.json.
      const rolledTodos = todoStateFromLog(log.all(), target.seq);
      if (rolledTodos) applyTodoState(process.cwd(), rolledTodos);
      tui.pushSystem(
        `restored to checkpoint #${target.seq}${target.note ? ` — ${target.note}` : ""}\n` +
          `context now rolls back to that point; the discarded suffix was snapshotted to ${snapshot || "(ephemeral — no session file)"} for audit` +
          (rolledTodos ? `\ntodo state rolled back with the timeline (${rolledTodos.length} entr${rolledTodos.length === 1 ? "y" : "ies"})` : ""),
      );
      return;
    }
    // D#10: /fork — branch the current (or latest) session into a new session file
    // from an event boundary. The source file is left untouched (append-only).
    // P#37 — /tree: render the session as a tree (branch points from
    // explicit parentId links; linear sessions show a single trunk).
    if (input === "/tree" || input.startsWith("/tree ")) {
      const nodes = log.tree();
      const branchSeqs = new Set(log.branchPoints());
      const lines: string[] = ["session tree:"];
      for (const n of nodes) {
        const isBranchRoot = branchSeqs.has(n.seq);
        const indent = isBranchRoot ? "├─ " : "│  ";
        const label =
          n.type === "checkpoint"
            ? `#${n.seq} checkpoint${n.summary ? ` — ${n.summary}` : ""}`
            : n.type === "user/message"
              ? `#${n.seq} user: ${n.summary}`
              : `#${n.seq} ${n.type}`;
        lines.push(`${indent}${label}`);
      }
      if (branchSeqs.size === 0) lines.push("(linear session — no branches; /fork to create one)");
      tui.pushSystem(lines.join("\n"));
      return;
    }
    if (input === "/fork" || input.startsWith("/fork ")) {
      if (busy) {
        tui.pushSystem("finish the current turn before forking");
        return;
      }
      const arg = input === "/fork" ? "" : input.slice("/fork ".length).trim();
      if (!arg) {
        tui.pushSystem("usage: /fork <target> [--from seq]");
        return;
      }
      const parts = arg.split(/\s+/);
      const target = parts[0];
      let from = 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--from" && parts[i + 1]) {
          const v = Number.parseInt(parts[i + 1], 10);
          if (!Number.isFinite(v) || v < 0) {
            tui.pushSystem(`bad --from seq: ${parts[i + 1]}`);
            return;
          }
          from = v;
          break;
        }
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target)) {
        tui.pushSystem(`invalid target name: ${target}`);
        return;
      }
      // source: the current session if persisted, else the latest saved one
      const src = sessionPath ? basename(sessionPath).replace(/\.jsonl$/, "") : latestSessionName();
      if (!src) {
        tui.pushSystem("no source session to fork (no saved sessions yet)");
        return;
      }
      const srcPath = join(SESSIONS_DIR, `${src}.jsonl`);
      if (!existsSync(srcPath)) {
        tui.pushSystem(`no such source session: ${src}`);
        return;
      }
      const dstPath = join(SESSIONS_DIR, `${target}.jsonl`);
      if (existsSync(dstPath)) {
        tui.pushSystem(`session already exists: ${target} (rm it first)`);
        return;
      }
      const srcLog = SessionLog.fromEvents(readSessionEvents(src));
      const forked = srcLog.fork(from);
      if (forked.all().length === 0) {
        tui.pushSystem(`nothing to fork (source has no events with seq >= ${from})`);
        return;
      }
      saveSession(dstPath, forked);
      tui.pushSystem(
        `forked ${src} (from seq ${from}) -> ${target} (${forked.all().length} events)\n` +
          `resume it later with: aih chat --session ${target}`,
      );
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
    if (input === "/help") {
      tui.openHelp();
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
      const limit = resolveContextWindow(flags);
      const lines = [
        `turns: ${ends.length}`,
        `context now: ${usedTokens}/${limit} (${Math.round(Math.min(1, usedTokens / limit) * 100)}%)`,
        `context peak (prompt tokens): ${peakTokens}`,
        `session totals: ${prompt}/${completion}/${total} (prompt/completion/total)`,
      ];
      // F#30: cost + throughput
      const price = currentPrice();
      if (price && total > 0) {
        lines.push(`cost: ${fmtCost(totalCost(log.all(), price))} (model price: ${price.input}/${price.output} per 1M in/out)`);
      } else if (total > 0) {
        lines.push("cost: — (no price table entry for the active model; set `prices` in aih.json)");
      }
      // P#41: prompt-cache hit rate (only when the provider reports cache data)
      const chr = cacheHitRate(log.all());
      if (chr !== undefined) lines.push(`cache hit rate: ${Math.round(chr * 100)}% of prompt tokens`);
      // P#41: idle-gap TTL waste attribution (heuristic over observable facts)
      const ttlWaste = cacheTtlWaste(log.all());
      if (ttlWaste && ttlWaste.gaps > 0) {
        const wasteCost = price && ttlWaste.wastedTokens > 0 ? fmtCost((ttlWaste.wastedTokens / 1_000_000) * price.input) : undefined;
        lines.push(
          `TTL waste: ${ttlWaste.gaps} gap(s) > 5min likely evicted the prompt cache` +
            ` (~${ttlWaste.wastedTokens.toLocaleString()} uncached tokens${wasteCost ? ` ≈ ${wasteCost}` : ""})`,
        );
      }
      const tps = tokensPerSecond(log.all());
      if (tps > 0) lines.push(`throughput: ${fmtTps(tps)} (session average)`);
      const stps = streamingTps(log.all());
      if (stps > 0) lines.push(`streaming: ${fmtTps(stps)} (completion tokens / real generation time)`);
      // CC#57: loops breakdown — goal rounds / task subagents / best_of_n.
      const loops = loopUsageBreakdown(log.all());
      lines.push(...formatLoopBreakdown(loops));
      tui.pushSystem(lines.join("\n"));
      return;
    }
    if (input === "/memory") {
      const p = join(process.cwd(), ".aih", "memory.md");
      const u = join(userAihDir(), "memory.md");
      const sections: string[] = [];
      sections.push(existsSync(p) ? readFileSync(p, "utf8").trim() || "(empty)" : "(no project memory yet)");
      if (existsSync(u)) sections.push(`— user (${u}) —\n${readFileSync(u, "utf8").trim() || "(empty)"}`);
      tui.pushSystem(
        sections.join("\n\n") +
          (sections.length === 1 ? " — the agent can add memory with the remember tool (scope: project | user)" : ""),
      );
      return;
    }
    // E#17: /tidy — deterministic memory auto-tidy (dedup stale/duplicate entries).
    // Proposes changes; the user confirms before anything is written.
    const tidyApply = input === "/tidy apply" || input.startsWith("/tidy apply ");
    if (!tidyApply && (input === "/tidy" || input.startsWith("/tidy "))) {
      const scope = input === "/tidy" ? "project" : input.slice("/tidy ".length).trim() || "project";
      if (scope !== "project" && scope !== "user") {
        tui.pushSystem("usage: /tidy [project|user] — tidy that memory file (duplicate entries)");
        return;
      }
      const target = scope === "user" ? join(userAihDir(), "memory.md") : join(process.cwd(), ".aih", "memory.md");
      if (!existsSync(target)) {
        tui.pushSystem(`no ${scope} memory to tidy yet (${target})`);
        return;
      }
      const current = readFileSync(target, "utf8");
      const report = tidyMemory(current);
      if (report.noChange) {
        tui.pushSystem(formatTidyReport(report));
        return;
      }
      tui.pushSystem(
        `${formatTidyReport(report)}\n\n` +
          `apply with: /tidy apply ${scope}   (or review with /memory first)`,
      );
      return;
    }
    if (tidyApply) {
      const scope = (input.slice("/tidy apply ".length).trim() || "project") as "project" | "user";
      if (scope !== "project" && scope !== "user") {
        tui.pushSystem("usage: /tidy apply [project|user]");
        return;
      }
      const target = scope === "user" ? join(userAihDir(), "memory.md") : join(process.cwd(), ".aih", "memory.md");
      if (!existsSync(target)) {
        tui.pushSystem(`no ${scope} memory to tidy yet (${target})`);
        return;
      }
      const current = readFileSync(target, "utf8");
      const report = tidyMemory(current);
      if (report.noChange) {
        tui.pushSystem(formatTidyReport(report));
        return;
      }
      // snapshot for audit, then write the cleaned file
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const snap = `${target}.pre-tidy-${stamp}`;
      writeFileSync(snap, current, "utf8");
      writeFileSync(target, report.cleaned, "utf8");
      tui.pushSystem(
        `tidied ${scope} memory: ${report.total} → ${report.kept} entries (${report.removed.length} duplicate(s) removed)\n` +
          `previous version snapshotted to ${snap}`,
      );
      return;
    }
    // P2#7: dream / distill — "sessions are assets" (scan recent logs).
    if (input === "/dream" || input.startsWith("/dream ")) {
      void runDream();
      return;
    }
    if (input === "/distill") {
      const material = extractDreamMaterial(collectSessionEventsForDream());
      const flows = material.flows;
      if (!flows.length) {
        tui.pushSystem("distill: no repeated flows found (need the same tool + same signature ≥3 times across sessions)");
        return;
      }
      tui.pushSystem(
        `distill — ${flows.length} candidate(s) for skills/workflows:\n` +
          flows
            .map((f) => `• ${f.tool} ×${f.count} — ${f.signature}\n  → ${f.suggestion}`)
            .join("\n"),
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
        `goal set: ${cond}\nafter each turn an independent judge checks acceptance criteria against real evidence and auto-continues if unmet (up to ${goalRoundsLeft} extra rounds)\n` +
          `tip — structure it as:\n${GOAL_CONTRACT_TEMPLATE}`,
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
    if (input === "/compact" || input.startsWith("/compact ")) {
      if (busy) {
        tui.pushSystem("finish the current turn before compacting");
        return;
      }
      const focus = input === "/compact" ? "" : input.slice("/compact ".length).trim();
      if (focus.length > 2000) {
        tui.pushSystem("focus text too long (max 2000 chars)");
        return;
      }
      tui.pushSystem(focus ? `compacting context (focus: ${focus})...` : "compacting context...");
      try {
        const r = await loop.compactNow({ instructions: focus || undefined });
        if (!r.applied) {
          tui.pushSystem("nothing to compact — the summary came back empty; history kept");
          return;
        }
        usedTokens = r.after;
        store?.save(log);
        const limit = resolveContextWindow(flags);
        const pct = limit ? Math.round(Math.min(1, r.after / limit) * 100) : null;
        const drop = r.before > 0 ? Math.round(((r.before - r.after) / r.before) * 100) : 0;
        tui.pushSystem(
          `compacted: ~${r.before} → ~${r.after} tokens (-${drop}%)\ncontext now ${r.after}/${limit}${pct !== null ? ` (${pct}%)` : ""} — earlier messages summarized, full history stays in the session log` +
            summaryPreview(),
        );
      } catch (err) {
        tui.pushSystem(`compact failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (input === "/model") {
      void openModelPicker();
      return;
    }
    if (input.startsWith("/model ")) {
      const id = input.slice("/model ".length).trim();
      if (!id) {
        tui.pushSystem("usage: /model <provider/model> — or run /model for the picker");
        return;
      }
      // "<provider>/<model>" picks that provider; bare id keeps the current provider
      const slash = id.indexOf("/");
      const provider = slash > 0 ? id.slice(0, slash) : undefined;
      const modelId = slash > 0 ? id.slice(slash + 1) : id;
      try {
        await applyModel(provider, modelId);
        tui.pushSystem(`switched model to ${provider ? `${provider}/` : ""}${modelId}`);
      } catch (err) {
        tui.pushError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (input === "/commands") {
      void openPalette();
      return;
    }
    if (input === "/models" || input.startsWith("/models ")) {
      if (!bool(flags, "mock")) await openModelPicker();
      else tui.pushSystem("model picker unavailable in --mock mode");
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
    if (input.startsWith("/") && isKnownSlash(input)) {
      // P#39: extension-contributed commands get first crack at unknown
      // slash names.
      const extName = input.slice(1).split(" ")[0];
      const extCmd = extensionCommands.get(extName);
      if (extCmd) {
        await extCmd.run(input.slice(1 + extName.length).trim());
        return;
      }
      tui.pushSystem(
        `unknown command: ${input}\navailable: /help /commands(ctrl-p) /mode /goal /tools /model /models /usage /compact /checkpoint /restore /fork /tree /skills /inject /events /clear /exit`,
      );
      return;
    }
    // Unknown "/..." input is not a command — treat it as a normal message
    // (opencode semantics: pasted code like `// comment` or `/* ... */`
    // reaches the model instead of dying on "unknown command").

    // P1#4: BM25 relevance auto-loading — if an installed skill clearly
    // matches this request and is not in context yet, nudge the model to
    // consider it (one line, non-intrusive; the model decides).
    if (!input.startsWith("/") && input.length >= 8) {
      try {
        const sugg = suggestSkills(input, skills, 2);
        if (sugg.length) {
          loop.inject(
            `[skill suggestion] "${sugg[0].skill.name}" looks relevant to this request — call load_skill("${sugg[0].skill.name}") to read its instructions before proceeding if it fits.` +
              (sugg[1] ? ` (also: ${sugg[1].skill.name})` : ""),
          );
        }
      } catch {
        /* relevance nudge is best-effort */
      }
    }

    // IT#1: shell context awareness — when AIH_SHELL_CONTEXT=auto, attach the
    // recent run_cmd output + exit codes to the next turn so the agent can
    // reason about the user's shell without the user pasting it. Only for
    // normal messages (not slash commands), and only when there IS shell
    // history (empty state → no-op). Best-effort: any error is swallowed.
    if (process.env.AIH_SHELL_CONTEXT === "auto" && !input.startsWith("/")) {
      try {
        const cmds = extractShellContext(log.all());
        const block = formatShellContext(cmds);
        if (block) loop.inject(block);
      } catch {
        /* shell-context injection is best-effort */
      }
    }

    try {
      const started = Date.now();
      const result = await evalTurn(input);
      // P#35: drain any follow-ups queued during the turn and run them as
      // fresh turns (steering messages already landed mid-turn).
      for (;;) {
        const queued = loop.drainQueued("followUp");
        if (queued.length === 0) break;
        for (const q of queued) {
          tui.pushSystem(`→ follow-up: ${q}`);
          await evalTurn(q);
          store?.save(log);
        }
      }
      store?.save(log);
      const usage = result.usage;
      // Belt-and-braces vs garbage provider usage (agent-loop already gates
      // its own contextNow): only adopt wire numbers bounded by the window.
      const win = resolveContextWindow(flags);
      const sane = (n: unknown): n is number => sanePromptTokens(n, win);
      if (result.contextNow != null && sane(result.contextNow)) {
        usedTokens = result.contextNow;
      } else if (sane(result.contextTokens)) {
        usedTokens = Math.max(usedTokens, result.contextTokens);
      } else if (usage && sane(usage.promptTokens)) {
        usedTokens = Math.max(usedTokens, usage.promptTokens ?? 0);
      } else {
        usedTokens = lastContextTokens(log.all(), win).tokens;
      }
      peakTokens = Math.max(peakTokens, usedTokens);
      const dur = Date.now() - started;
      tui.push({
        role: "footer",
        text: `▣ build · ${modelLabel} · ${result.steps} ${result.steps === 1 ? "step" : "steps"} · ${fmtDur(dur)}`,
      });
      if (result.stopReason === "max_steps") {
        tui.pushSystem(
          `⚠ step limit reached (${maxSteps}) — the model was asked to wrap up; send a message (e.g. "continue") to resume`,
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

function cmdSessionRm(names: string[], flags: Record<string, string | boolean> = {}) {
  if (names.length === 0 && !bool(flags, "all", "a")) {
    console.error("error: session rm needs a name, a glob (quoted), or --all");
    process.exit(1);
  }
  // `--all` removes every saved session. A bare glob that the shell expands
  // (`aih session rm *`) becomes a list of CWD files, none of which are
  // session names — the shell must never be trusted to know our sessions.
  if (bool(flags, "all", "a")) {
    const all = sessionFiles();
    if (all.length === 0) {
      console.log("(no saved sessions)");
      return;
    }
    for (const s of all) {
      rmSync(s.path, { force: true });
      console.log(`${dim("removed")} ${s.name}`);
    }
    return;
  }
  let missing = 0;
  for (const raw of names) {
    const name = raw.replace(/\.jsonl$/i, "");
    // Guard: a session name must be a bare id — never a path. A shell glob
    // (`aih session rm *`) expands to every file in the CWD; feeding those
    // into join() could reach outside the sessions dir or silently "remove"
    // names that were never sessions. Suggest --all instead.
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
      console.error(`error: "${raw}" is not a valid session name (use "aih session rm --all" to remove every session)`);
      missing += 1;
      continue;
    }
    const path = join(SESSIONS_DIR, `${name}.jsonl`);
    if (!existsSync(path)) {
      console.error(`error: no such session "${raw}"`);
      missing += 1;
      continue;
    }
    rmSync(path, { force: true });
    console.log(`${dim("removed")} ${name}`);
  }
  if (missing > 0) process.exitCode = 1;
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

/**
 * P#37① — distill an abandoned branch into a branch_summary event appended to
 * the target session: one tool-less LLM call over the source transcript
 * (events after --from, capped), then the surviving session carries the
 * lessons without the dead branch's token cost. The source file is untouched.
 */
async function cmdSessionDistillBranch(
  source: string | undefined,
  target: string,
  fromSeq?: string,
  flags: Record<string, string | boolean> = {},
): Promise<void> {
  const src = source ?? latestSessionNameOrExit();
  const srcPath = join(SESSIONS_DIR, `${src}.jsonl`);
  if (!existsSync(srcPath)) {
    console.error(`error: no such session: ${src}`);
    process.exit(1);
  }
  const dstPath = join(SESSIONS_DIR, `${target}.jsonl`);
  if (!existsSync(dstPath)) {
    console.error(`error: no such session: ${target} (the distilled summary is appended to it)`);
    process.exit(1);
  }
  const from = Math.max(0, Number.parseInt(String(fromSeq), 10) || 0);
  const events = readSessionEvents(src).filter((e) => e.seq >= from);
  // Serialize the branch transcript for the distiller (user + assistant text
  // and tool activity markers; tool bodies truncated — same discipline as
  // compaction serialization).
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "user/message") lines.push(`[User]: ${e.text}`);
    else if (e.type === "assistant/message") {
      if (e.text) lines.push(`[Assistant]: ${e.text}`);
      for (const tc of e.toolCalls ?? []) lines.push(`[Assistant tried] ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})`);
    } else if (e.type === "tool/result") {
      lines.push(`[Tool result ok=${e.ok}] ${String(e.ok ? JSON.stringify(e.result) : e.error ?? "").slice(0, 300)}`);
    }
  }
  if (lines.length === 0) {
    console.error(`error: nothing to distill in ${src} (no conversation events at seq >= ${from})`);
    process.exit(1);
  }
  process.stderr.write(`${dim(`distilling ${src} (${lines.length} entries, from seq ${from})…`)}\n`);
  const llm = buildAuxLlm(flags);
  let text: string;
  try {
    const resp = await llm.complete({
      messages: [{ role: "user", content: buildBranchDistillPrompt(lines.join("\n\n").slice(0, 24_000)) }],
      tools: [],
    });
    text = resp.text.trim();
  } catch (err) {
    console.error(`error: distiller LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!text) {
    console.error("error: distiller returned an empty summary — nothing recorded");
    process.exit(1);
  }
  const log = SessionLog.fromEvents(readSessionEvents(target));
  const ev = log.append({
    type: "branch_summary",
    ...(from > 0 ? { fromSeq: from } : {}),
    fromSession: src,
    text: text.slice(0, 4000),
  });
  saveSession(dstPath, log);
  console.log(
    `branch summary #${ev.seq} appended to ${target} (from ${src})\n${dim(text.slice(0, 400))}${text.length > 400 ? "…" : ""}`,
  );
}

/** F#28: record a named checkpoint marker in a session (append-only). */
function cmdSessionCheckpoint(name: string | undefined, note: string | undefined) {
  const src = name ?? latestSessionNameOrExit();
  const srcPath = join(SESSIONS_DIR, `${src}.jsonl`);
  if (!existsSync(srcPath)) {
    console.error(`error: no such session: ${src}`);
    process.exit(1);
  }
  const log = SessionLog.fromEvents(readSessionEvents(src));
  const cp = log.checkpoint(note, undefined, gitStatusSummary());
  saveSession(srcPath, log);
  console.log(
    `checkpoint #${cp.seq} recorded in ${src}` +
      (note ? ` — ${note}` : "") +
      (cp.worktree ? `\n${formatWorktreeSummary(cp.worktree).join("\n")}` : "") +
      `\nrestore later with: aih session restore ${src} [seq]   (or /restore in the TUI)`,
  );
}

/**
 * F#28: restore a session to a checkpoint = fork + pointer switch.
 * The ORIGINAL session file is left untouched (append-only, fully auditable);
 * the restored prefix is written to `<name>-restore-<seq>.jsonl`, which the
 * user then resumes (aih chat --session <name>-restore-<seq>).
 */
function cmdSessionRestore(name: string, seqArg: string | undefined) {
  const srcPath = join(SESSIONS_DIR, `${name}.jsonl`);
  if (!existsSync(srcPath)) {
    console.error(`error: no such session: ${name}`);
    process.exit(1);
  }
  const events = readSessionEvents(name);
  const log = SessionLog.fromEvents(events);
  let cp: (SessionEvent & { type: "checkpoint" }) | undefined;
  if (seqArg != null) {
    const want = Number.parseInt(seqArg, 10);
    if (!Number.isFinite(want)) {
      console.error(`error: bad checkpoint seq: ${seqArg}`);
      process.exit(1);
    }
    cp = events.find((e) => e.type === "checkpoint" && e.seq === want) as
      | (SessionEvent & { type: "checkpoint" })
      | undefined;
    if (!cp) {
      console.error(`error: no checkpoint at seq ${want} in ${name}`);
      process.exit(1);
    }
  } else {
    cp = log.latestCheckpoint();
    if (!cp) {
      console.error(
        `error: no checkpoints in ${name} (record one with: aih session checkpoint ${name} [note])`,
      );
      process.exit(1);
    }
  }
  const target = `${name}-restore-${cp.seq}`;
  const dstPath = join(SESSIONS_DIR, `${target}.jsonl`);
  if (existsSync(dstPath)) {
    console.error(`error: session already exists: ${target} (rm it first)`);
    process.exit(1);
  }
  const restored = log.restoreTo(cp.seq);
  saveSession(dstPath, restored);
  const dropped = events.length - restored.all().length;
  console.log(
    `restored ${name} @ checkpoint #${cp.seq}${cp.note ? ` — ${cp.note}` : ""} → ${target}\n` +
      (cp.worktree ? `${formatWorktreeSummary(cp.worktree).join("\n")}\n` : "") +
      `kept ${restored.all().length} events, dropped ${dropped}; original ${name} untouched (full history stays auditable)\n` +
      `resume with: aih chat --session ${target}`,
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

/**
 * Import events from a JSONL (one JSON object per line) or a pretty-printed
 * JSON array into a NEW saved session. Counterpart of `export`. Accepts both
 * the raw session-file format (NDJSON) and the pretty `JSON.stringify(…, 2)`
 * array that `session export` writes to a file. Events are re-sequenced to
 * start at 0 and stamped with the newest ts so the imported history replays
 * cleanly and is comparable with a freshly forked session.
 */
function cmdSessionImport(file: string, targetArg: string | undefined): void {
  if (!existsSync(file)) {
    console.error(`error: no such file: ${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file, "utf8");
  let events: SessionEvent[];
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      // Pretty JSON array (what `session export` writes to a file).
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      events = parsed as SessionEvent[];
    } else {
      // NDJSON: one JSON object per line (raw session-file format).
      events = trimmed
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as SessionEvent);
    }
  } catch (err) {
    console.error(
      `error: could not parse ${file} as JSONL or JSON array: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (events.length === 0) {
    console.error(`error: no events found in ${file}`);
    process.exit(1);
  }
  for (const e of events) {
    if (!e || typeof e.type !== "string" || typeof e.seq !== "number" || typeof e.ts !== "number") {
      console.error(
        `error: ${file} contains a malformed event (expected {seq, ts, type, …}): ${JSON.stringify(e)?.slice(0, 120)}`,
      );
      process.exit(1);
    }
    // Minimal per-type field check: conversation events must carry turnId so
    // deriveMessages can replay them; a bare {seq,ts,type} would silently
    // corrupt the session on resume.
    const needsTurnId =
      e.type === "turn/start" ||
      e.type === "user/message" ||
      e.type === "assistant/message" ||
      e.type === "tool/call" ||
      e.type === "tool/result";
    if (needsTurnId && typeof (e as { turnId?: unknown }).turnId !== "string") {
      console.error(
        `error: ${file} event #${e.seq} (type ${e.type}) is missing its turnId`,
      );
      process.exit(1);
    }
    if (e.type === "user/message" && typeof (e as { text?: unknown }).text !== "string") {
      console.error(`error: ${file} user/message event #${e.seq} is missing its text`);
      process.exit(1);
    }
  }
  const target = (targetArg ?? basename(file))
    .replace(/\.(jsonl|json)$/i, "")
    .trim();
  if (!target) {
    console.error("error: could not derive a session name from the file; pass <target> explicitly");
    process.exit(1);
  }
  const dstPath = join(SESSIONS_DIR, `${target}.jsonl`);
  if (existsSync(dstPath)) {
    console.error(`error: session already exists: ${target} (rm it first)`);
    process.exit(1);
  }
  // Re-sequence so seq runs 0..n-1 (imported files may carry arbitrary seqs),
  // and stamp the newest ts so the session sorts as "recent".
  const newestTs = Math.max(...events.map((e) => e.ts));
  const renumbered = events.map((e, i) => ({ ...e, seq: i, ts: e.ts || newestTs }));
  const log = SessionLog.fromEvents(renumbered);
  saveSession(dstPath, log);
  console.log(
    `imported ${events.length} events from ${file} → ${target} (${dim(`.aih/sessions/${target}.jsonl`)})\n` +
      `resume with: aih chat --session ${target}`,
  );
}

function cmdStats() {
  let turns = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let genMs = 0;
  let genCompletion = 0;
  const ts: number[] = [];
  for (const file of sessionFiles()) {
    for (const event of readSessionEvents(file.name)) {
      if (event.type === "turn/end" && event.usage) {
        turns += 1;
        prompt += event.usage.promptTokens;
        completion += event.usage.completionTokens;
        total += event.usage.totalTokens;
        ts.push(event.ts);
        if (typeof event.genMs === "number" && event.genMs > 0) {
          genMs += event.genMs;
          genCompletion += event.usage.completionTokens;
        }
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
  // F#30: cost + throughput for the active model
  const modelId = process.env.AIH_MODEL ?? resolveLlm({}).model.value ?? "";
  const price = modelId ? resolvePrice(modelId, loadPrices()) : undefined;
  if (price) {
    const cost = (prompt / 1e6) * price.input + (completion / 1e6) * price.output;
    console.log(`cost       ${fmtCost(cost)} (model ${price.input}/${price.output} per 1M in/out)`);
  }
  if (ts.length >= 2) {
    const span = (Math.max(...ts) - Math.min(...ts)) / 1000;
    if (span > 0) console.log(`throughput ${fmtTps(total / span)} (across recorded turns)`);
  }
  if (genMs > 0 && genCompletion > 0) {
    console.log(`streaming  ${fmtTps(genCompletion / (genMs / 1000))} (completion tokens / real generation time)`);
  }
  // OC#7 — `aih stats` names every degraded credential owner (redacted), the
  // way opencode's `doctor`/`status` surface degraded owners.
  const degReport = renderDegradationReport(listDegradedOwners());
  if (degReport) {
    console.log("");
    console.log(degReport);
    console.log("  (clear with: aih models --clear-degraded)");
  }
}

/**
 * PE#3 — harness health scorecard: `aih scorecard [--format json]`.
 *
 * The playbook's real metric: "Do not count tokens. Count completed tasks that
 * required no manual intervention and still produced acceptable evidence."
 * Pure over the existing append-only session log + project memory — no new
 * storage, so the zero-dependency / offline stance is preserved. Data sources:
 *   - completion rate   : goal/judge met / turn/start
 *   - rework rate       : tool/result failures / turn
 *   - escalation rate   : escalate events / turn (PE#4)
 *   - recovery time     : failed tool call → next passing call (max span)
 *   - cost per verified : totalCost / verified (cost.ts)
 *   - guide growth      : dated entries in .aih/memory.md over the session span
 */
function cmdScorecard(flags: Record<string, string | boolean>) {
  const format = str(flags, "format") ?? "text";
  const files = sessionFiles();
  const events: SessionEvent[] = [];
  for (const f of files) {
    for (const event of readSessionEvents(f.name)) events.push(event);
  }
  if (events.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify({ sessions: 0, metrics: computeScorecard([]) }, null, 2));
    } else {
      console.log("(no sessions recorded yet — run a turn first)");
    }
    return;
  }
  // Cost metrics use the active model's price (same resolution as cmdStats).
  const modelId = process.env.AIH_MODEL ?? resolveLlm({}).model.value ?? "";
  const price = modelId ? resolvePrice(modelId, loadPrices()) : undefined;
  // Guide growth reads the project memory file (one dated line ≈ one rule).
  const memPath = join(process.cwd(), ".aih", "memory.md");
  let memoryText: string | undefined;
  if (existsSync(memPath)) {
    try {
      memoryText = readFileSync(memPath, "utf8");
    } catch {
      memoryText = undefined;
    }
  }
  const metrics = computeScorecard(events, { price, memoryText });
  if (format === "json") {
    console.log(JSON.stringify({ sessions: files.length, metrics }, null, 2));
    return;
  }
  console.log(`scorecard  ${files.length} session${files.length === 1 ? "" : "s"} · ${events.length} events`);
  console.log("");
  console.log(formatScorecard(metrics));
  console.log("");
  console.log("direction: completion↑ · rework↓ · escalation↓ · recovery↓ · cost-per-verified↓ · guide-growth→declining");
}

/**
 * E#17 — non-interactive distill: `aih distill [--format json]`.
 * Deterministic repeated-flow extraction over the recent sessions (the same
 * pure functions /distill uses in the TUI). Non-interactive so it can run as
 * a background job (`/bg distill`) or in CI.
 */
function cmdDistill(flags: Record<string, string | boolean>) {
  const format = str(flags, "format") ?? "text";
  const files = sessionFiles().slice(0, 5);
  const sessionsEvents = files.map((f) => {
    try {
      return readSessionEvents(f.name);
    } catch {
      return [];
    }
  });
  const material = extractDreamMaterial(sessionsEvents);
  if (format === "json") {
    console.log(
      JSON.stringify(
        { sessions: material.sessions, flows: material.flows, corrections: material.corrections },
        null,
        2,
      ),
    );
    return;
  }
  if (!material.flows.length) {
    console.log(`distill: scanned ${material.sessions} session(s) — no repeated flows (≥3 identical calls) found`);
    return;
  }
  const lines = [`distill: ${material.flows.length} repeated-flow candidate(s) across ${material.sessions} session(s):`];
  for (const f of material.flows) {
    lines.push(`  - ${f.tool} ×${f.count}: ${f.signature}`);
    lines.push(`    → ${f.suggestion}`);
  }
  lines.push("\nwrap the top one as a workflow (.aih/workflows/<name>.mjs) or a skill");
  console.log(lines.join("\n"));
}

/** E#17 — non-interactive memory tidy: `aih tidy [project|user] [--apply]`. */
function cmdTidy(positionals: string[], flags: Record<string, string | boolean>) {
  const scope = (positionals[0] ?? "project") as "project" | "user";
  if (scope !== "project" && scope !== "user") {
    console.error(`error: unknown scope "${scope}" (use project|user)`);
    process.exit(1);
  }
  const target = scope === "user" ? join(userAihDir(), "memory.md") : join(process.cwd(), ".aih", "memory.md");
  if (!existsSync(target)) {
    console.log(`no ${scope} memory to tidy yet (${target})`);
    return;
  }
  const current = readFileSync(target, "utf8");
  const report = tidyMemory(current);
  if (report.noChange) {
    console.log(formatTidyReport(report));
    return;
  }
  if (bool(flags, "apply")) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snap = `${target}.pre-tidy-${stamp}`;
    writeFileSync(snap, current, "utf8");
    writeFileSync(target, report.cleaned, "utf8");
    console.log(
      `tidied ${scope} memory: ${report.total} → ${report.kept} entries (${report.removed.length} duplicate(s) removed)\n` +
        `previous version snapshotted to ${snap}`,
    );
  } else {
    console.log(
      `${formatTidyReport(report)}\n\n(dry run — pass --apply to write; snapshot will be saved)`,
    );
  }
}

/**
 * D#15 — Agent Teams (minimal): roster + task board + mailbox.
 *
 *   aih team list                       roster + task board + inbox counts
 *   aih team add-agent <name> [--role R] [--prompt P]
 *   aih team rm-agent <name>
 *   aih team add-task <title...> [--detail D]
 *   aih team claim <task> --as <agent>
 *   aih team done|fail|cancel <task> [--note N]
 *   aih team dispatch <task> --as <agent>   (synchronous agent turn)
 *   aih team mail <to> <body...> [--sender F]
 *   aih team inbox <agent> [--unread]
 */
function cmdTeam(positionals: string[], flags: Record<string, string | boolean>) {
  const cwd = process.cwd();
  const sub = positionals.shift() ?? "list";
  const as = str(flags, "as");
  const icon = (s: string): string =>
    s === "todo" ? "◻" : s === "claimed" ? "▶" : s === "done" ? "✓" : s === "failed" ? "✗" : "⊘";

  switch (sub) {
    case "list":
    case "ls": {
      const state = loadTeam(cwd);
      const s = summarizeTeam(state);
      if (!state.agents.length && !state.tasks.length) {
        console.log("no team yet — aih team add-agent <name> [--role R] [--prompt P]");
        return;
      }
      console.log(`team @ ${cwd}`);
      console.log(`  agents: ${s.agents}   tasks: ${s.todo} todo · ${s.claimed} claimed · ${s.done} done · ${s.failed} failed`);
      for (const a of state.agents) {
        console.log(`  ● ${a.name}${a.role ? `  — ${a.role}` : ""}${a.prompt ? "  (has prompt)" : ""}`);
      }
      const recent = state.tasks.slice(-15).reverse();
      for (const t of recent) {
        console.log(`  ${icon(t.status)} ${t.id}  ${t.title}  [${t.status}${t.assignee ? ` · ${t.assignee}` : ""}]${t.preview ? `\n      ${t.preview}` : ""}`);
      }
      for (const a of state.agents) {
        const mail = readMail(cwd, a.name);
        if (mail.length) console.log(`  ✉ ${a.name}: ${mail.length} message(s) in inbox`);
      }
      return;
    }
    case "add-agent":
    case "agent": {
      const name = positionals.shift();
      if (!name) {
        console.error("error: usage: aih team add-agent <name> [--role R] [--prompt P]");
        process.exit(1);
      }
      const agent = addAgent(cwd, name, str(flags, "role"), str(flags, "prompt"));
      console.log(`added agent ${agent.name}${agent.role ? ` (${agent.role})` : ""}`);
      return;
    }
    case "rm-agent": {
      const name = positionals.shift();
      if (!name) {
        console.error("error: usage: aih team rm-agent <name>");
        process.exit(1);
      }
      if (removeAgent(cwd, name)) console.log(`removed agent ${name}`);
      else {
        console.error(`error: no agent "${name}"`);
        process.exit(1);
      }
      return;
    }
    case "add-task":
    case "task": {
      const title = positionals.join(" ").trim();
      if (!title) {
        console.error("error: usage: aih team add-task <title...> [--detail D]");
        process.exit(1);
      }
      const t = addTask(cwd, title, str(flags, "detail"));
      console.log(`added task ${t.id}: ${t.title}`);
      return;
    }
    case "claim": {
      const ref = positionals.shift();
      if (!ref || !as) {
        console.error("error: usage: aih team claim <task> --as <agent>");
        process.exit(1);
      }
      try {
        const t = claimTask(cwd, ref, as);
        console.log(`claimed ${t.id} for ${as}`);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }
    case "done":
    case "fail":
    case "cancel": {
      const ref = positionals.shift();
      if (!ref) {
        console.error(`error: usage: aih team ${sub} <task> [--note N]`);
        process.exit(1);
      }
      const status = sub === "done" ? "done" : sub === "fail" ? "failed" : "cancelled";
      try {
        const t = setTaskStatus(cwd, ref, status, str(flags, "note"));
        console.log(`${t.id} → ${status}`);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }
    case "dispatch": {
      const ref = positionals.shift();
      if (!ref || !as) {
        console.error("error: usage: aih team dispatch <task> --as <agent>");
        process.exit(1);
      }
      if (!agentByName(cwd, as)) {
        // allow dispatching to a name not in the roster (still recorded) —
        // but warn so typos surface.
        console.error(`warning: agent "${as}" is not in the roster (aih team add-agent ${as})`);
      }
      const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
      let job: ReturnType<typeof dispatchTask>["job"];
      let child: ReturnType<typeof dispatchTask>["child"];
      let task: ReturnType<typeof dispatchTask>["task"];
      try {
        ({ job, child, task } = dispatchTask(cwd, ref, as, { cli: cliPath }));
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      // Synchronous dispatch: wait for the agent turn, mirror the outcome onto
      // the task board, report, and exit with the child's code. (spawnJob
      // pipes the child's stdio, so the CLI process stays alive until it
      // finishes anyway — a "background" dispatch from a non-interactive CLI
      // would just look hung. True backgrounding is the TUI's /bg, which owns
      // the child handle in a long-lived process.)
      const finish = (code: number | null, err?: Error): void => {
        try {
          const finished = resolveTask(cwd, task.id);
          if (finished && (finished.status === "todo" || finished.status === "claimed")) {
            setTaskStatus(cwd, task.id, code === 0 ? "done" : "failed", finished?.preview ?? (err ? `spawn error: ${err.message}` : undefined));
          }
        } catch {
          /* board mirror is best-effort */
        }
        const t = resolveTask(cwd, task.id);
        const status = t?.status ?? (code === 0 ? "done" : "failed");
        console.log(`${icon(status)} task ${task.id} ${status}${t?.preview ? ` — ${t.preview}` : err ? ` — ${err.message}` : ""}`);
        console.log(`  output: ${job.out}`);
        process.exit(code === 0 ? 0 : 1);
      };
      child.on("close", (code) => finish(code));
      child.on("error", (err) => finish(null, err));
      console.log(`▶ dispatching ${task.id} as ${as}…`);
      return;
    }
    case "mail": {
      const to = positionals.shift();
      const body = positionals.join(" ").trim();
      if (!to || !body) {
        console.error("error: usage: aih team mail <to> <body...> [--sender F]");
        process.exit(1);
      }
      const m = sendMail(cwd, str(flags, "sender") ?? "cli", to, body);
      console.log(`✉ ${m.from} → ${m.to}: ${m.body}`);
      return;
    }
    case "inbox": {
      const to = positionals.shift();
      if (!to) {
        console.error("error: usage: aih team inbox <agent> [--unread]");
        process.exit(1);
      }
      const unread = bool(flags, "unread");
      const mail = readMail(cwd, to, unread);
      if (!mail.length) {
        console.log(`no ${unread ? "unread " : ""}messages for ${to}`);
        return;
      }
      for (const m of mail) {
        const when = new Date(m.ts).toISOString().replace("T", " ").slice(0, 19);
        console.log(`  [${when}] ${m.from}: ${m.body}`);
      }
      if (!unread) markRead(cwd, to);
      return;
    }
    default:
      console.error(`error: unknown team subcommand "${sub}" (list|add-agent|rm-agent|add-task|claim|done|fail|cancel|dispatch|mail|inbox)`);
      process.exit(1);
  }
}

/** P2#9 — config `$schema` for editor autocompletion. */
const AIH_SCHEMA_URL = "https://aih.dev/schema/aih.schema.json";
function aihSchemaPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "aih.schema.json");
}
function aihSchema(): string {
  return readFileSync(aihSchemaPath(), "utf8");
}

async function cmdConfig(flags: Record<string, string | boolean>) {
  // `aih config --schema` prints the raw JSON Schema for aih.json / config.json.
  if (bool(flags, "schema")) {
    console.log(aihSchema());
    return;
  }
  const llm = resolveLlm({
    flagModel: str(flags, "model"),
    flagBaseUrl: str(flags, "base-url"),
    flagProvider: str(flags, "provider"),
    flagContextWindow: str(flags, "context-window"),
    envModel: process.env.AIH_MODEL,
    envBaseUrl: process.env.AIH_BASE_URL,
    envContextWindow: process.env.AIH_CONTEXT_WINDOW,
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
        schema: AIH_SCHEMA_URL,
        schemaFile: aihSchemaPath(),
        model: llm.model,
        baseUrl: llm.baseUrl,
        provider: llm.provider,
        apiKeyEnv: llm.apiKeyEnv,
        apiKeySet,
        contextWindow: {
          ...llm.contextWindow,
          value: llm.contextWindow.value !== undefined ? Number(llm.contextWindow.value) : undefined,
          effective: resolveContextWindow(flags),
        },
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

async function cmdSkills(
  action: string,
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const skills = discoverSkills();
  const scopeLabel = (s: Skill): string => (s.scope === "builtin" ? "builtin" : s.scope);
  const registryFlag = str(flags, "registry");
  const projectSkillsDir = join(process.cwd(), ".aih", "skills");

  // Fetch the merged remote index across all configured registries (best-effort).
  const fetchRemote = async (): Promise<RemoteSkill[]> => {
    const bases = resolveRegistryUrls(registryFlag);
    const out: RemoteSkill[] = [];
    for (const base of bases) {
      try {
        out.push(...(await fetchRegistryIndex(base)));
      } catch (err) {
        console.error(
          `warning: registry ${base} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  };

  if (action === "list" || (!action && !args.length)) {
    console.log(`${"name".padEnd(18)} ${"scope".padEnd(8)} description`);
    for (const s of skills) {
      console.log(`${s.name.padEnd(18)} ${scopeLabel(s).padEnd(8)} ${s.description}`);
    }
    return;
  }

  if (action === "registry") {
    const url = args[0];
    if (url) {
      const path = saveSkillRegistry(url);
      console.log(`registry set to ${url} (${path})`);
      return;
    }
    const urls = resolveRegistryUrls(registryFlag);
    if (!urls.length) {
      console.log("no skill registry configured (set via `aih skills registry <url>` or aih.json skills.registry)");
      return;
    }
    for (const u of urls) console.log(u);
    return;
  }

  if (action === "find") {
    const wantInstall = args.includes("--install") || bool(flags, "install");
    const query = args.filter((a) => a !== "--install").join(" ");
    const local = searchSkills(query, skills);
    const remote = await fetchRemote();
    const remoteHits = searchRemote(query, remote);

    const anyLocal = local.length > 0;
    const anyRemote = remoteHits.length > 0;
    if (!anyLocal && !anyRemote) {
      console.log(`no skills match "${query}"${remote.length ? " (checked registry)" : ""}`);
      return;
    }
    console.log(`${"score".padEnd(6)} ${"name".padEnd(18)} ${"scope".padEnd(8)} description`);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const s of local) {
      const n = terms.reduce(
        (acc, t) =>
          acc + (s.name.toLowerCase().includes(t) ? 3 : `${s.description}`.toLowerCase().includes(t) ? 1 : 0),
        0,
      );
      console.log(`${String(n).padEnd(6)} ${s.name.padEnd(18)} ${scopeLabel(s).padEnd(8)} ${s.description}`);
    }
    for (const s of remoteHits) {
      const n = terms.reduce(
        (acc, t) =>
          acc + (s.name.toLowerCase().includes(t) ? 3 : `${s.description ?? ""}`.toLowerCase().includes(t) ? 1 : 0),
        0,
      );
      console.log(`${String(n).padEnd(6)} ${s.name.padEnd(18)} ${"remote".padEnd(8)} ${s.description ?? ""}`);
    }

    if (wantInstall) {
      if (!remoteHits.length) {
        console.error(`error: --install requested but no remote skill matches "${query}"`);
        process.exit(1);
      }
      const top = remoteHits[0];
      const destDir = join(projectSkillsDir, top.name);
      const file = await installRemoteSkill(top, destDir);
      console.log(`installed ${top.name} (remote) -> ${file}`);
    } else if (remoteHits.length) {
      console.log(`\ninstall with: aih skills install ${remoteHits[0].name}`);
    }
    return;
  }

  if (action === "suggest") {
    // P1#4: BM25 relevance ranking of installed skills against a query.
    const query = args.join(" ");
    if (!query.trim()) {
      console.error("error: usage: aih skills suggest <query>");
      process.exit(1);
    }
    const hits = suggestSkills(query, skills, 5);
    if (!hits.length) {
      console.log(`no installed skill is relevant to "${query}"`);
      return;
    }
    console.log(`${"score".padEnd(8)} ${"name".padEnd(18)} ${"scope".padEnd(8)} description`);
    for (const h of hits) {
      console.log(
        `${h.score.toFixed(2).padEnd(8)} ${h.skill.name.padEnd(18)} ${scopeLabel(h.skill).padEnd(8)} ${h.skill.description}`,
      );
    }
    console.log(`\nactivate the best match: aih run "..." with load_skill("${hits[0].skill.name}") (or /${hits[0].skill.name} in the TUI)`);
    return;
  }

  if (action === "install") {
    const name = args[0];
    if (!name) {
      console.error("error: usage: aih skills install <name> [--registry <url>] [--global]");
      process.exit(1);
    }
    // --global: install into the user-level (XDG) skills dir, not the project.
    const global = bool(flags, "global");
    const targetDir = global ? join(userAihDir(), "skills") : projectSkillsDir;
    // 1) local builtin
    if (BUILTIN_SKILLS.some((b) => b.name === name)) {
      try {
        // installSkill writes to <projectDir>/.aih/skills; for --global we
        // relocate the result into the user-level (XDG) skills dir.
        const file = installSkill(name);
        if (global) {
          const want = join(targetDir, name, "SKILL.md");
          mkdirSync(dirname(want), { recursive: true });
          renameSync(file, want);
          rmSync(dirname(file), { recursive: true, force: true });
          console.log(`installed ${name} (global) -> ${want}`);
        } else {
          console.log(`installed ${name} -> ${file}`);
        }
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      return;
    }
    // 2) remote registry
    const remote = await fetchRemote();
    const match = remote.find((s) => s.name === name);
    if (match) {
      const destDir = join(targetDir, name);
      const file = await installRemoteSkill(match, destDir);
      console.log(`installed ${name} (remote) -> ${file}`);
      return;
    }
    console.error(
      `error: unknown skill "${name}" (not a builtin, and not in any configured registry)`,
    );
    process.exit(1);
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
  console.error(`error: unknown skills action: ${action} (use list|find|install|show|registry)`);
  process.exit(1);
}

function cmdModels(flags: Record<string, string | boolean>) {
  // OC#7 — `aih models --clear-degraded` resets the owner degradation registry.
  if (bool(flags, "clear-degraded")) clearAllOwnerDegraded();
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
  const providers = (cfg.providers ?? {}) as Record<
    string,
    { model?: string; models?: Array<string | { model: string }>; baseUrl?: string }
  >;
  // OC#7 — mark owners whose credential is degraded, so `aih models` names
  // every down credential (redacted) instead of hiding it.
  const degraded = new Map(listDegradedOwners().map((r) => [r.owner, r]));
  for (const [name, p] of Object.entries(providers)) {
    const ids = [
      ...(p.model !== undefined ? [p.model] : []),
      ...normalizeModelEntries(p.models).map((e) => e.id).filter((m) => m !== p.model),
    ];
    if (!ids.length) ids.push("-");
    const mark = degraded.has(name) ? " ⚠ degraded" : "";
    for (const mid of ids) rows.push([`${name}${mark}`, mid, p.baseUrl ?? "-"]);
  }
  console.log(`${"provider".padEnd(22)} ${"model".padEnd(28)} base-url`);
  for (const [provider, model, baseUrl] of rows) {
    console.log(`${provider.padEnd(22)} ${model.padEnd(28)} ${baseUrl}`);
  }
  const report = renderDegradationReport(listDegradedOwners());
  if (report) {
    console.log("");
    console.log(report);
    console.log("  (clear with: aih models --clear-degraded)");
  }
}

function mergedConfig(layers: Array<{ config: any }>): any {
  const out: any = {};
  for (const { config } of layers) Object.assign(out, config);
  return out;
}

/** E#18 — list configured named agent profiles (`aih agents`). */
function cmdAgents() {
  const names = listAgentProfiles();
  if (names.length === 0) {
    console.log("no agent profiles configured");
    console.log('add them to aih.json: { "agents": { "<name>": { "prompt": "...", "permissions": [...] } } }');
    console.log("then run with: aih run --as <name> \"...\"  (or aih chat --as <name>)");
    return;
  }
  console.log(`${"profile".padEnd(24)} prompt`.padEnd(60) + "permissions");
  for (const n of names) {
    const p = loadAgentProfile(n);
    const perms = (p?.permissions ?? []).map((r) => `${r.tool}:${r.action}`).join(", ");
    console.log(`${n.padEnd(24)} ${(p?.prompt ?? "-").slice(0, 34).padEnd(36) + ""} ${perms || "-"}`);
  }
  console.log("\nselect one with: aih run --as <name> \"...\"");
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
  // P1#4: app-specific skill skeleton (auto-discovered as a project skill).
  write(join(".aih", "skills", `${slug}-app`, "SKILL.md"), T_SKILL_MD);
  // P#39③: self-extension entry point — a runnable example the agent (or the
  // user) can adapt; the trust gate still gates loading.
  write(join(".aih", "extensions", "example.mjs"), T_EXTENSION_EXAMPLE);
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

// --- P2#8: serve / attach (headless harness + remote UI over HTTP/SSE) ------
async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const { startServe } = await import("./serve.js");
  const srv = await startServe(flags);
  const url = `http://${srv.host}:${srv.port}`;
  console.log(`${green("serving")} AIH harness at ${url}`);
  console.log(
    dim(
      `  session ${str(flags, "session") ?? "(auto)"} · GET /health · GET /events (SSE) · POST /message · GET /tools`,
    ),
  );
  console.log(dim(`  attach with: aih attach ${url}`));
  const shutdown = (sig: string): void => {
    process.stderr.write(`\n${dim(`shutting down (${sig})`)}`);
    void srv
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => undefined); // run until signaled
}

async function cmdAttach(
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const url = positionals[0] ?? str(flags, "url") ?? "http://127.0.0.1:8787";
  const { attachInteractive } = await import("./serve.js");
  await attachInteractive(url);
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

// ---------------------------------------------------------------------------
// PR#2 — `aih measure`: structural / behavioral distance instrument
//
//   aih measure distance <a.json> <b.json> [--revised skills=a,b]
//       a/b: { "surfaces": [{ "surface": "skills", "entries": ["x","y"] }] }
//   aih measure stream <traces.json> [--perms N] [--seed N]
//       traces: { "traces": [{ "label": "arm-a", "events": [{ "type": "tool/call", "name": "run_cmd" }] }] }
//   aih measure crystallize <evolved.json> <neutral.json>
//
// Pure measurement (cli/src/measure.ts): reads DECLARED surfaces + NORMALIZED
// traces, never the agent's self-report. Missing snapshots degrade explicitly
// (reported, never fabricated).
// ---------------------------------------------------------------------------
function readJsonFile(path: string): unknown {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`error: file not found: ${abs}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    console.error(`error: ${abs} is not valid JSON: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

function parseSnapshots(raw: unknown): Snapshot[] {
  const o = raw as { surfaces?: unknown };
  if (!o || !Array.isArray(o.surfaces)) {
    console.error('error: snapshot file must be { "surfaces": [ { "surface": "...", "entries": [...] } ] }');
    process.exit(1);
  }
  return o.surfaces.map((s) => {
    const x = s as { surface?: unknown; entries?: unknown };
    if (typeof x.surface !== "string" || !Array.isArray(x.entries)) {
      console.error("error: each surface needs a string \"surface\" and an \"entries\" array");
      process.exit(1);
    }
    return { surface: x.surface, entries: x.entries.map(String) };
  });
}

function parseTraces(raw: unknown): Trace[] {
  const o = raw as { traces?: unknown };
  if (!o || !Array.isArray(o.traces)) {
    console.error('error: traces file must be { "traces": [ { "label": "...", "events": [...] } ] }');
    process.exit(1);
  }
  return o.traces.map((t) => {
    const x = t as { label?: unknown; events?: unknown };
    if (typeof x.label !== "string" || !Array.isArray(x.events)) {
      console.error("error: each trace needs a string \"label\" and an \"events\" array");
      process.exit(1);
    }
    return { label: x.label, events: x.events as ActionEvent[] };
  });
}

function cmdMeasure(positionals: string[], flags: Record<string, string | boolean>) {
  const sub = positionals.shift() ?? "";
  const asJson = bool(flags, "json");

  if (sub === "distance") {
    const a = parseSnapshots(readJsonFile(positionals.shift() ?? ""));
    const b = parseSnapshots(readJsonFile(positionals.shift() ?? ""));
    // --revised surface=entry,entry (repeatable) — caller declares which
    // shared entries changed (the module cannot infer meaning of opaque keys).
    const revised: Record<string, string[]> = {};
    for (const r of (str(flags, "revised") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = r.indexOf("=");
      if (eq < 0) {
        console.error(`error: --revised expects surface=entry,entry (got "${r}")`);
        process.exit(1);
      }
      const name = r.slice(0, eq);
      revised[name] = [...(revised[name] ?? []), ...r.slice(eq + 1).split(",").map((s) => s.trim()).filter(Boolean)];
    }
    const report = distance(a, b, revised);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatDistance(report));
    if (report.degraded) process.exitCode = 1;
    return;
  }

  if (sub === "stream") {
    const traces = parseTraces(readJsonFile(positionals.shift() ?? ""));
    const perms = Math.max(0, Math.floor(Number(str(flags, "perms") ?? "") || 500));
    const seed = Math.floor(Number(str(flags, "seed") ?? "") || 12345);
    const test = permutationTest(traces, { permutations: perms, seed });
    // Pairwise behavior distances (matrix) for the report.
    const pairs: { a: string; b: string; mix: number; order: number; score: number }[] = [];
    for (let i = 0; i < traces.length; i += 1) {
      for (let j = i + 1; j < traces.length; j += 1) {
        const d = behaviorDistance(traces[i].events, traces[j].events);
        pairs.push({ a: traces[i].label, b: traces[j].label, ...d });
      }
    }
    const flows = traces.map((t) => ({ label: t.label, flow: toolFlow(t.events) }));
    const out = { test, pairs, flows };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(formatPermutationTest(test));
      for (const p of pairs) {
        console.log(`  ${p.a} × ${p.b}:  mix=${p.mix.toFixed(3)}  order=${p.order.toFixed(3)}  score=${p.score.toFixed(3)}`);
      }
      for (const f of flows) {
        const freq = Object.entries(f.flow.frequency)
          .sort((x, y) => y[1] - x[1])
          .map(([k, v]) => `${k}×${v}`)
          .join(" ");
        console.log(`  ${f.label}: ${f.flow.totalCalls} calls, ${f.flow.distinctTools} tools  [${freq}]`);
      }
    }
    return;
  }

  if (sub === "crystallize") {
    const evolved = parseSnapshots(readJsonFile(positionals.shift() ?? ""));
    const neutral = parseSnapshots(readJsonFile(positionals.shift() ?? ""));
    const result = crystallize(evolved, neutral);
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `crystallize  ${result.degraded ? "DEGRADED" : result.stable ? "STABLE" : "DRIFTED"}  distance=${result.distance}${result.reason ? `  (${result.reason})` : ""}`,
      );
    }
    if (result.degraded || !result.stable) process.exitCode = 1;
    return;
  }

  console.error(
    "usage: aih measure distance <a.json> <b.json> [--revised surface=a,b] [--json]\n" +
      "       aih measure stream <traces.json> [--perms N] [--seed N] [--json]\n" +
      "       aih measure crystallize <evolved.json> <neutral.json> [--json]",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// FA#6 — `aih experiment` (the P#46 eval framework's CLI surface)
//
//   aih experiment run <spec.json> [--exp-id <id>] [--retry-failed]
//       [--mock] [--reps N] [--concurrency N] [--out <dir>]
//       [--results-dir <dir>] [--external <cmd> --args-template "…{prompt}…"]
//   aih experiment status <exp-id> [--results-dir <dir>]
//
// `run` executes the tasks × models × repetitions matrix against a subject
// (bundled CLI by default) and persists per-cell status to
// `<results-dir>/<exp-id>.results.json`. `--retry-failed` re-runs ONLY the
// cells whose last status is not "passed" (failed/error/never-run) and merges
// the new outcomes back into the same result set — saving tokens and time.
// `status` prints the passed/failed/error distribution for an experiment id.
//
// NOTE: `aih eval` is already the repo QA gate (doctor+bootstrap+check+test),
// so the experiment framework lives under `aih experiment` instead of the
// roadmap's literal `aih eval --retry-failed`.
// ---------------------------------------------------------------------------
interface ExperimentSpec {
  tasks: EvalTask[];
  models: EvalModelSpec[];
  repetitions?: number;
}

function parseSpecFile(path: string): ExperimentSpec {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`error: spec file not found: ${abs}`);
    process.exit(1);
  }
  let spec: ExperimentSpec;
  try {
    spec = JSON.parse(readFileSync(abs, "utf8")) as ExperimentSpec;
  } catch (e) {
    console.error(`error: spec is not valid JSON: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    console.error('error: spec must have a non-empty "tasks" array');
    process.exit(1);
  }
  for (const t of spec.tasks) {
    if (!t.id || typeof t.prompt !== "string") {
      console.error('error: every task needs an "id" and a "prompt"');
      process.exit(1);
    }
  }
  if (!Array.isArray(spec.models) || spec.models.length === 0) {
    spec.models = [{ model: "mock" }];
  }
  spec.repetitions = Math.max(1, Math.floor(spec.repetitions ?? 1));
  return spec;
}

function defaultExpId(spec: ExperimentSpec): string {
  // Deterministic id from the task ids + model ids (stable across runs so
  // --retry-failed / --status can find the same result set without --exp-id).
  const seed = [spec.tasks.map((t) => t.id).join(","), spec.models.map((m) => m.model).join(",")].join("|");
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return `exp-${h.toString(16)}`;
}

async function cmdExperiment(positionals: string[], flags: Record<string, string | boolean>) {
  const cwd = process.cwd();
  const sub = positionals.shift() ?? "";
  const resultsDir = str(flags, "results-dir") ?? join(cwd, ".aih", "eval");
  const outDir = str(flags, "out") ?? join(resultsDir, "cells");

  if (sub === "status") {
    const expId = positionals.shift() ?? str(flags, "exp-id");
    if (!expId) {
      console.error("error: `aih experiment status <exp-id>` needs an experiment id");
      process.exit(1);
    }
    const res = loadResults(resultsDir, expId);
    if (!res) {
      console.error(`error: no results for "${expId}" under ${resultsDir}`);
      process.exit(1);
    }
    const s = statusSummary(res.cells);
    console.log(`experiment ${expId}`);
    console.log(`  updated: ${res.updatedAt}`);
    console.log(`  cells:   ${s.total}  (passed ${s.passed} · failed ${s.failed} · error ${s.error})`);
    console.log(`  skipped: ${res.skipped.length ? res.skipped.join(", ") : "(none)"}`);
    const failed = Object.values(res.cells).filter((r) => r.status !== "passed");
    if (failed.length > 0) {
      console.log(`  not passed (${failed.length}):`);
      for (const r of failed) console.log(`    - ${r.cellId}  ${r.status}${r.failureReason ? `  — ${r.failureReason}` : ""}`);
    }
    if (bool(flags, "json")) {
      console.log(JSON.stringify({ expId, totals: s, cells: res.cells, skipped: res.skipped }, null, 2));
    }
    return;
  }

  if (sub !== "run" && sub !== "retry") {
    console.error(
      "usage: aih experiment run <spec.json> [--exp-id <id>] [--retry-failed] [--mock] [--reps N] [--concurrency N] [--out <dir>] [--results-dir <dir>]\n" +
        "       aih experiment status <exp-id> [--results-dir <dir>] [--json]\n" +
        "spec.json: { \"tasks\": [{id, prompt, expect[]}], \"models\": [{model, provider?, baseUrl?}], \"repetitions\": N }",
    );
    process.exit(1);
  }

  const specPath = positionals.shift();
  if (!specPath) {
    console.error(`error: \`aih experiment ${sub}\` needs a spec.json path`);
    process.exit(1);
  }
  const spec = parseSpecFile(specPath);
  // --mock forces the bundled mock subject regardless of the spec's models.
  if (bool(flags, "mock")) spec.models = [{ model: "mock" }];
  const reps = Math.max(1, Math.floor(Number(str(flags, "reps") ?? "") || spec.repetitions || 1));
  const expId = str(flags, "exp-id") ?? defaultExpId(spec);
  const retryOnly = sub === "retry" || bool(flags, "retry-failed");

  // Build the subject adapter.
  let subject: SubjectAdapter;
  if (str(flags, "external")) {
    const tmpl = (str(flags, "args-template") ?? "{prompt}").split(/\s+/).filter(Boolean);
    subject = externalSubjectAdapter(str(flags, "external")!, tmpl, {
      timeoutMs: Number(str(flags, "timeout") ?? "") || 120_000,
    });
  } else {
    // cliEntry is the `cli/` directory; cliSubjectAdapter appends
    // `dist/index.js` (matches the smoke test's cliRoot resolution).
    const cliEntry = dirname(dirname(fileURLToPath(import.meta.url)));
    subject = cliSubjectAdapter(cliEntry, {
      timeoutMs: Number(str(flags, "timeout") ?? "") || 120_000,
    });
  }

  // FA#6 — retry: restrict to the failed/never-run cells of this exp-id.
  let onlyCells: string[] | undefined;
  if (retryOnly) {
    const prev = loadResults(resultsDir, expId);
    if (!prev) {
      console.error(`error: --retry-failed needs a prior run for "${expId}" (run \`aih experiment run ${specPath} --exp-id ${expId}\` first)`);
      process.exit(1);
    }
    const allCells = expandCells(spec.tasks, spec.models, reps);
    onlyCells = retryCellIds(allCells, prev);
    if (onlyCells.length === 0) {
      console.log(`all cells for "${expId}" already passed — nothing to retry`);
      return;
    }
    console.log(`retrying ${onlyCells.length} non-passed cell(s) for "${expId}": ${onlyCells.join(", ")}`);
  }

  const concurrency = Math.max(1, Math.floor(Number(str(flags, "concurrency") ?? "") || 4));
  const report = await runExperiment(
    spec.tasks,
    spec.models,
    reps,
    subject,
    {
      outDir,
      budget: { concurrency },
      expId,
      resultsDir,
      onlyCells,
    },
  );

  const t = report.totals;
  console.log(`experiment ${expId}  [${t.stopReason}]`);
  console.log(`  cells:   ${report.results.length}  (passed ${t.passed} · failed ${t.failed} · error ${t.errors})`);
  if (report.skippedCells.length > 0) console.log(`  skipped: ${report.skippedCells.length}  (${report.skippedCells.join(", ")})`);
  console.log(`  usage:   ${t.usage.totalTokens} tokens  ·  cost ${t.costUsd.toFixed(4)}`);
  console.log(`  results: ${resultsPath(resultsDir, expId)}`);
  if (bool(flags, "json")) {
    console.log(JSON.stringify({ expId, totals: t, results: report.results, skipped: report.skippedCells }, null, 2));
  }
  // Exit non-zero if any cell did not pass (CI-friendly), but a clean retry
  // that fixed everything exits 0.
  if (t.failed + t.errors > 0) process.exitCode = 1;
}

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  // P#40 — project trust gate: resolve trust for the working directory BEFORE
  // anything reads config/skills. One-shot flags win; TTY chat prompts once
  // (persisted per directory in the USER-level trust file); non-interactive
  // commands fail closed to untrusted unless AIH_TRUST_ALL_PROJECTS=1.
  {
    const interactive = process.stdin.isTTY === true && !bool(flags, "yes");
    const flag = bool(flags, "trust") ? ("trust" as const) : bool(flags, "no-trust") ? ("no-trust" as const) : undefined;
    const outcome = await ensureProjectTrust({
      interactive,
      flag,
      defaultPolicy: process.env.AIH_TRUST_ALL_PROJECTS === "1" ? "allow" : "deny",
    });
    setProjectTrustState(outcome === "granted" || outcome === "already-granted" ? "trusted" : "untrusted");
    if (
      (outcome === "denied" || outcome === "already-denied") &&
      hasProjectAssets(process.cwd()) &&
      !bool(flags, "help") && !bool(flags, "version")
    ) {
      console.error(
        `note: project AIH configuration in ${process.cwd()} is NOT trusted — ` +
          `project aih.json/.aih assets are ignored this run ` +
          `(use --trust to allow once, or answer the prompt in an interactive session)`,
      );
    }
  }

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
      if (sub === "rm") return cmdSessionRm(positionals, flags);
      if (sub === "export") {
        return cmdSessionExport(
          positionals[0] ?? latestSessionNameOrExit(),
          positionals[1],
        );
      }
      if (sub === "import") {
        if (!positionals[0]) {
          console.error("error: usage: aih session import <file.jsonl|file.json> [target]");
          process.exit(1);
        }
        return cmdSessionImport(positionals[0], positionals[1]);
      }
      if (sub === "fork") {
        if (!positionals[1]) {
          console.error("error: usage: aih session fork [source] <target> [--from seq]");
          process.exit(1);
        }
        return cmdSessionFork(positionals[0], positionals[1], str(flags, "from"));
      }
      if (sub === "checkpoint") {
        // aih session checkpoint [name] [note...]  — name defaults to latest session
        const name = positionals[0] && !positionals[0].startsWith("-") ? positionals[0] : undefined;
        const note = (positionals.slice(name ? 1 : 0).join(" ").trim() || undefined);
        return cmdSessionCheckpoint(name, note);
      }
      if (sub === "restore") {
        if (!positionals[0]) {
          console.error("error: usage: aih session restore <name> [checkpoint-seq]");
          process.exit(1);
        }
        return cmdSessionRestore(positionals[0], positionals[1]);
      }
      if (sub === "distill-branch") {
        if (!positionals[1]) {
          console.error("error: usage: aih session distill-branch <abandoned-session> <target-session> [--from seq]");
          process.exit(1);
        }
        return cmdSessionDistillBranch(positionals[0], positionals[1], str(flags, "from"), flags);
      }
      console.error(`error: unknown session subcommand "${sub}" (list|show|rm|export|import|fork|checkpoint|restore|distill-branch)`);
      process.exit(1);
    }
    case "stats":
      return cmdStats();
    case "scorecard":
      return cmdScorecard(flags);
    case "team":
      return cmdTeam(positionals, flags);
    case "tidy":
      return cmdTidy(positionals, flags);
    case "distill":
      return cmdDistill(flags);
    case "skills":
      return cmdSkills(positionals[0] ?? "", positionals.slice(1), flags);
    case "config":
      return cmdConfig(flags);
    case "models":
      return cmdModels(flags);
    case "agents":
      return cmdAgents();
    case "init":
      return cmdInit(positionals, flags);
    case "workflow":
      return cmdWorkflow(positionals, flags);
    case "experiment":
      return cmdExperiment(positionals, flags);
    case "measure":
      return cmdMeasure(positionals, flags);
    case "mcp":
      return cmdMcp(flags);
    case "serve":
      return cmdServe(flags);
    case "attach":
      return cmdAttach(positionals, flags);
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

function isDirectRun(): boolean {
  // Node resolves the main module through symlinks (import.meta.url is the
  // real path) while process.argv[1] keeps the invoked path — compare both
  // in real form so symlinked installs (npm bin, /usr/local/bin/aih) work.
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  if (process.argv[1] === self) return true;
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return false;
  }
}

export { main };

if (isDirectRun()) {
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
}

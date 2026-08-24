import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePrice,
  totalCost,
  tokensPerSecond,
  fmtCost,
  fmtTps,
  DEFAULT_PRICES,
} from "./cost.js";
import type { SessionEvent } from "@aih/core";

const cli = fileURLToPath(new URL("./index.js", import.meta.url));

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

function aih(args: string[], env: Record<string, string> = {}, cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  });
}

// Like aih(), but with AIH_MODEL/AIH_BASE_URL stripped so config-file values
// are what get resolved (the dev shell exports real provider env vars).
function aihClean(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete e.AIH_MODEL;
  delete e.AIH_BASE_URL;
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: e,
    ...(cwd ? { cwd } : {}),
  });
}

// --- F#30: cost / TPS (pure functions over seeded events) -------------------
{
  // Price resolution: exact, substring, user-override, and miss.
  assert(
    resolvePrice("gpt-4o")?.input === 2.5 && resolvePrice("gpt-4o")?.output === 10,
    "resolvePrice finds built-in gpt-4o",
  );
  assert(
    resolvePrice("gpt-4o-2024-11-20")?.input === 2.5,
    "resolvePrice matches a dated id to the gpt-4o row",
  );
  assert(
    resolvePrice("GPT-4O-MINI")?.input === 0.15,
    "resolvePrice is case-insensitive and picks the more specific mini row",
  );
  assert(
    resolvePrice("my-custom-model", { "my-custom-model": { input: 1, output: 2 } })?.input === 1,
    "user `prices` override wins for an unknown model",
  );
  assert(
    resolvePrice("totally-unknown-xyz") === undefined,
    "resolvePrice returns undefined when no table matches",
  );

  // Seeded turn/end events with known usage + timestamps.
  const mk = (seq: number, ts: number, prompt: number, completion: number): SessionEvent =>
    ({
      seq,
      ts,
      type: "turn/end",
      turnId: `t${seq}`,
      stopReason: "end_turn",
      usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
    }) as SessionEvent;
  const events = [
    mk(0, 1_000_000, 1_000_000, 0), // 1M input
    mk(1, 1_002_000, 0, 1_000_000), // 1M output, 2s later
  ];
  const price = resolvePrice("gpt-4o")!;
  // 1M input @ $2.5 + 1M output @ $10 = $12.50
  const c = totalCost(events, price);
  assert(Math.abs(c - 12.5) < 1e-9, `totalCost = $12.50 for 1M in + 1M out (got ${c})`);
  // 2M tokens over 2s = 1,000,000 tok/s
  const tps = tokensPerSecond(events);
  assert(Math.abs(tps - 1_000_000) < 1e-6, `tokensPerSecond = 1e6 tok/s (got ${tps})`);
  assert(tokensPerSecond([mk(0, 1, 100, 100)]) === 0, "TPS is 0 with a single turn");
  assert(tokensPerSecond([]) === 0, "TPS is 0 with no events");
  assert(fmtCost(12.5) === "$12.50", "fmtCost formats >=0.01 to 2 decimals");
  assert(fmtCost(0.0042) === "$0.0042", "fmtCost formats <0.01 to 4 decimals");
  assert(fmtCost(0) === "$0.00", "fmtCost(0) is $0.00");
  assert(fmtTps(1000) === "1000 tok/s", "fmtTps rounds >=100");
  assert(fmtTps(0) === "", "fmtTps(0) is empty");
  assert(Object.keys(DEFAULT_PRICES).length >= 10, "built-in price table has entries");
}

const version = aih(["--version"]);
assert(version.stdout.trim() === "0.2.0", "--version prints version");
const versionCmd = aih(["version"]);
assert(versionCmd.stdout.trim() === "0.2.0", "version command prints version");

const help = aih([]);
assert(help.status === 1 && help.stdout.includes("Usage:"), "no command prints help and exits 1");

const unknown = aih(["frobnicate"]);
assert(unknown.status === 1 && unknown.stderr.includes("unknown command"), "unknown command errors");

const tools = aih(["tools"]);
assert(tools.status === 0, "tools connects to the bundled server");
assert(
  tools.stdout.includes("toggle_todo") && tools.stdout.includes("ask"),
  "tools lists actions with permission levels",
);

const describe = aih(["describe"]);
assert(describe.status === 0 && describe.stdout.includes("todo-app"), "describe prints app descriptor");

const run = aih(["run", "please add a todo", "--mock", "--yes"]);
assert(run.status === 0, "run --mock exits cleanly");
assert(run.stdout.includes("Added via mock."), "run prints final assistant text");
assert(run.stderr.includes("⚙ add_todo"), "run traces tool calls inline");

const runJson = aih(["run", "add a todo", "--mock", "--yes", "--format", "json"]);
assert(runJson.status === 0, "run --format json exits cleanly");
const lines = runJson.stdout.trim().split("\n").filter(Boolean);
const events = lines.map((l) => JSON.parse(l));
assert(
  events.some((e) => e.type === "turn/start") && events.some((e) => e.type === "turn/end"),
  "json format streams NDJSON session events",
);
assert(
  events.some((e) => e.type === "tool/result" && e.ok),
  "json stream includes successful tool result",
);

// Public (https) endpoint with zero credentials must still fail fast.
const noKey = aih(
  ["run", "hi"],
  { AIH_API_KEY: "", AIH_MODEL: "m", AIH_BASE_URL: "https://api.openai.com/v1" },
);
assert(noKey.status === 1 && noKey.stderr.includes("no API key"), "missing API key fails fast with hint");

// buildLlm must throw (not process.exit) so interactive callers can recover.
{
  const { buildLlm } = await import("./index.js");
  const savedKey = process.env.AIH_API_KEY;
  const savedBase = process.env.AIH_BASE_URL;
  process.env.AIH_API_KEY = "";
  process.env.AIH_BASE_URL = "https://api.openai.com/v1";
  let threw = false;
  let msg = "";
  try {
    buildLlm({ model: "m" });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    if (savedKey === undefined) delete process.env.AIH_API_KEY;
    else process.env.AIH_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.AIH_BASE_URL;
    else process.env.AIH_BASE_URL = savedBase;
  }
  assert(threw && /no API key/i.test(msg), "buildLlm throws (not exits) when keyless on a public endpoint");
}

// Self-hosted endpoints (llama.cpp / Ollama / vLLM) run without auth — the
// no-key gate must not reject them.
{
  const { buildLlm } = await import("./index.js");
  const savedKey = process.env.AIH_API_KEY;
  process.env.AIH_API_KEY = "";
  let llm: unknown;
  try {
    llm = buildLlm({ model: "local-model", "base-url": "http://127.0.0.1:8081/v1" });
  } finally {
    if (savedKey === undefined) delete process.env.AIH_API_KEY;
    else process.env.AIH_API_KEY = savedKey;
  }
  assert(
    typeof (llm as { complete?: unknown })?.complete === "function",
    "buildLlm allows a keyless local http endpoint (llama.cpp)",
  );
}
{
  // Loopback:1 refuses instantly — proves the gate is open and a request is attempted.
  const keylessLocal = aih(
    ["run", "hi"],
    { AIH_API_KEY: "", AIH_MODEL: "m", AIH_BASE_URL: "http://127.0.0.1:1/v1" },
  );
  assert(
    !keylessLocal.stderr.includes("no API key"),
    "keyless local endpoint attempts a request instead of hitting the no-key gate",
  );
}

rmSync(".aih/sessions", { recursive: true, force: true });
const s1a = aih(["run", "first prompt alpha", "--mock", "--yes", "--session", "s1"]);
assert(
  s1a.status === 0 && s1a.stderr.includes("[session: new"),
  "run --session creates a new session file",
);
const s1b = aih(["run", "second prompt beta", "--mock", "--yes", "-c"]);
assert(
  s1b.status === 0 && s1b.stderr.includes("[session: resumed"),
  "-c resumes the most recent session",
);
const sessionFile = ".aih/sessions/s1.jsonl";
assert(existsSync(sessionFile), "session file persisted");
const sessionContent = readFileSync(sessionFile, "utf8");
assert(
  sessionContent.includes("first prompt alpha") && sessionContent.includes("second prompt beta"),
  "both turns recorded in one session log",
);

const list = aih(["sessions"]);
assert(list.status === 0 && list.stdout.includes("s1"), "sessions command lists saved sessions");

const show = aih(["session", "show", "s1"]);
assert(show.status === 0 && show.stdout.includes("first prompt alpha"), "session show renders transcript");

const exportJson = aih(["session", "export", "s1"]);
assert(exportJson.status === 0 && JSON.parse(exportJson.stdout).length > 0, "session export emits JSON events");

const stats = aih(["stats"]);
assert(stats.status === 0, "stats command runs");
assert(stats.stdout.includes("(no usage recorded yet)"), "stats reports when no usage recorded");

const fork = aih(["session", "fork", "s1", "s1-branch"]);
assert(fork.status === 0 && fork.stdout.includes("forked s1"), "session fork copies a session");
assert(existsSync(".aih/sessions/s1-branch.jsonl"), "forked session file exists");
const forkAgain = aih(["session", "fork", "s1", "s1-branch"]);
assert(forkAgain.status === 1 && forkAgain.stderr.includes("already exists"), "fork refuses to overwrite an existing session");

// --- F#28: checkpoint / restore (append-only rollback) ----------------------
{
  const cp = aih(["session", "checkpoint", "s1", "before", "risky", "refactor"]);
  assert(cp.status === 0 && cp.stdout.includes("checkpoint #") && cp.stdout.includes("before risky refactor"), "session checkpoint records a named marker");
  const cpSeq = Number.parseInt(cp.stdout.match(/checkpoint #(\d+)/)?.[1] ?? "", 10);
  assert(Number.isFinite(cpSeq), "checkpoint reports its seq");

  const moreTurn = aih(["run", "turn after checkpoint", "--mock", "--yes", "--session", "s1"]);
  assert(moreTurn.status === 0, "turns keep appending after a checkpoint");

  const restore = aih(["session", "restore", "s1"]);
  assert(restore.status === 0 && restore.stdout.includes(`restore-${cpSeq}`), "session restore forks the prefix to a new session");
  const restoredFile = `.aih/sessions/s1-restore-${cpSeq}.jsonl`;
  assert(existsSync(restoredFile), "restored session file exists");
  const restoredEvents = JSON.parse(aih(["session", "export", `s1-restore-${cpSeq}`]).stdout);
  assert(restoredEvents[restoredEvents.length - 1].type === "checkpoint", "restored session ends at the checkpoint marker");
  assert(!restoredEvents.some((e: { text?: string }) => e.text === "turn after checkpoint"), "restored session excludes the post-checkpoint suffix");
  assert(
    readFileSync(".aih/sessions/s1.jsonl", "utf8").includes("turn after checkpoint"),
    "original session file stays untouched (append-only, full history auditable)",
  );
  const restoreAgain = aih(["session", "restore", "s1"]);
  assert(restoreAgain.status === 1 && restoreAgain.stderr.includes("already exists"), "restore refuses to overwrite an existing restored session");
  const badSeq = aih(["session", "restore", "s1", "99999"]);
  assert(badSeq.status === 1 && badSeq.stderr.includes("no checkpoint at seq"), "restore rejects an unknown checkpoint seq");
  const noCp = aih(["session", "restore", "s1-branch"]);
  assert(noCp.status === 1 && noCp.stderr.includes("no checkpoints"), "restore errors cleanly when the session has no checkpoints");
}

rmSync(".aih/sessions", { recursive: true, force: true });

const config = aih(["config"], { AIH_MODEL: "deepseek-v4-flash" });
assert(config.status === 0, "config command runs");
const configJson = JSON.parse(config.stdout);
assert(
  configJson.model.value === "deepseek-v4-flash" && configJson.model.source === "env AIH_MODEL",
  "config reports model source",
);

// context window resolution: providers.<name> > global aih.json > env > flag (highest) > 128k default
{
  const cwDir = ".aih-smoke-cw";
  rmSync(cwDir, { recursive: true, force: true });
  mkdirSync(cwDir, { recursive: true });
  writeFileSync(
    `${cwDir}/aih.json`,
    JSON.stringify({ model: "m1", contextWindow: 50000, providers: { p1: { model: "p1-model", contextWindow: 55555 } } }),
  );
  const runIn = (args: string[], env: Record<string, string> = {}) => {
    const e = { ...process.env, ...env };
    if (!("AIH_CONTEXT_WINDOW" in env)) delete e.AIH_CONTEXT_WINDOW;
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: e, cwd: cwDir });
  };

  let r = runIn(["config", "--provider", "p1"]);
  let cw = JSON.parse(r.stdout).contextWindow;
  assert(
    r.status === 0 && cw.value === 55555 && cw.source.includes("p1.contextWindow") && cw.effective === 55555,
    "context window from providers.<name>.contextWindow",
  );

  r = runIn(["config"]);
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 50000 && cw.effective === 50000,
    "context window from global aih.json (no provider)",
  );

  r = runIn(["config"], { AIH_CONTEXT_WINDOW: "44444" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 44444 && cw.source === "env AIH_CONTEXT_WINDOW" && cw.effective === 44444,
    "env AIH_CONTEXT_WINDOW overrides aih.json",
  );

  r = runIn(["config", "--context-window", "33333"], { AIH_CONTEXT_WINDOW: "44444" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 33333 && cw.source.includes("flag") && cw.effective === 33333,
    "flag --context-window wins over env and config",
  );

  r = runIn(["config"], { AIH_CONTEXT_WINDOW: "bogus" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(cw.effective === 50000, "invalid AIH_CONTEXT_WINDOW falls through to the config tier");
  rmSync(cwDir, { recursive: true, force: true });
}

// Live context-window detection (llama.cpp /slots): MIN slot n_ctx is the
// effective per-request window; explicit flag/env still win; unreachable or
// non-llama endpoints fall back silently.
{
  const { createServer } = await import("node:http");
  const { probeContextWindow, resetWindowCache, detectedWindow } = await import("./window.js");
  const { resolveContextWindow } = await import("./index.js");
  const slotsSrv = createServer((req, res) => {
    if (req.url === "/slots") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: 0, n_ctx: 8192 },
          { id: 1, n_ctx: 4096 },
          { id: 2, n_ctx: "bogus" },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((r) => slotsSrv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(slotsSrv.address() as { port: number }).port}/v1`;
  const noSlotsSrv = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => noSlotsSrv.listen(0, "127.0.0.1", () => r()));
  const noSlotsBase = `http://127.0.0.1:${(noSlotsSrv.address() as { port: number }).port}/v1`;
  resetWindowCache();
  const probed = await probeContextWindow(base);
  assert(probed === 4096, "probe reads /slots and takes MIN n_ctx (non-numeric entries skipped)");
  assert(
    (await probeContextWindow(base)) === 4096,
    "probe result is cached (no second network call)",
  );
  assert(
    resolveContextWindow({ model: "m", "base-url": base }) === 4096,
    "detected window wins over aih.json config/default tier",
  );
  assert(
    resolveContextWindow({ model: "m", "base-url": base, "context-window": "777" }) === 777,
    "flag --context-window beats live detection",
  );
  const savedEnv = process.env.AIH_CONTEXT_WINDOW;
  process.env.AIH_CONTEXT_WINDOW = "1234";
  try {
    assert(
      resolveContextWindow({ model: "m", "base-url": base }) === 1234,
      "AIH_CONTEXT_WINDOW beats live detection",
    );
  } finally {
    if (savedEnv === undefined) delete process.env.AIH_CONTEXT_WINDOW;
    else process.env.AIH_CONTEXT_WINDOW = savedEnv;
  }
  assert(detectedWindow("http://127.0.0.1:1/v1") === undefined, "unprobed endpoint: no detected window");
  assert(
    (await probeContextWindow("http://127.0.0.1:1/v1")) === undefined,
    "unreachable endpoint: probe fails silently (no throw)",
  );
  assert(
    (await probeContextWindow(noSlotsBase)) === undefined,
    "endpoint without /slots: probe fails silently (fallback applies)",
  );
  slotsSrv.close();
  noSlotsSrv.close();
}

const models = aih(["models"], { AIH_MODEL: "deepseek-v4-flash" });
assert(
  models.status === 0 && models.stdout.includes("deepseek-v4-flash"),
  "models lists configured model",
);

// model catalog across providers (used by ctrl-p palette / /model picker)
{
  const catDir = ".aih-smoke-cat";
  rmSync(catDir, { recursive: true, force: true });
  mkdirSync(catDir, { recursive: true });
  writeFileSync(
    `${catDir}/aih.json`,
    JSON.stringify({
      defaultProvider: "alpha",
      model: "m1",
      providers: {
        alpha: { baseUrl: "http://a.example/v1", model: "alpha-model", contextWindow: 32000 },
        beta: { baseUrl: "http://b.example/v1", model: "beta-model" },
        gamma: {
          baseUrl: "http://g.example/v1",
          model: "gamma-main",
          models: ["gamma-free-1", "gamma-free-2"],
        },
      },
    }),
  );
  const runIn = (args: string[]) => {
    // strip ambient AIH_MODEL / AIH_BASE_URL so aih.json providers decide
    const e = { ...process.env };
    delete e.AIH_MODEL;
    delete e.AIH_BASE_URL;
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: catDir, env: e });
  };

  const cfg = runIn(["config"]);
  const cfgJson = JSON.parse(cfg.stdout);
  assert(cfgJson.provider === "alpha", "defaultProvider resolves from aih.json");
  assert(cfgJson.model.value === "alpha-model", "provider model overrides top-level model");

  // switching provider via --provider picks up that provider's model + context window
  const switched = runIn(["config", "--provider", "beta"]);
  const swJson = JSON.parse(switched.stdout);
  assert(swJson.model.value === "beta-model", "--provider beta resolves beta-model");

  // a provider's `models[]` extras each become their own catalog entry
  const modelsOut = runIn(["models"]);
  assert(
    modelsOut.stdout.includes("gamma-main") &&
      modelsOut.stdout.includes("gamma-free-1") &&
      modelsOut.stdout.includes("gamma-free-2"),
    "models[] extras are listed alongside the primary model",
  );
  // switching to an extra model keeps the provider's endpoint
  const freeSwitch = runIn(["config", "--provider", "gamma", "--model", "gamma-free-1"]);
  const freeJson = JSON.parse(freeSwitch.stdout);
  assert(freeJson.model.value === "gamma-free-1", "--model picks a models[] extra");
  assert(
    String(freeJson.baseUrl?.value ?? "").includes("g.example"),
    "models[] extra inherits the provider baseUrl",
  );

  rmSync(catDir, { recursive: true, force: true });
}


const skillsList = aih(["skills", "list"]);
assert(
  skillsList.status === 0 &&
    skillsList.stdout.includes("app-tour") &&
    skillsList.stdout.includes("builtin"),
  "skills list shows builtin skills",
);
const skillsFind = aih(["skills", "find", "tour"]);
const findDataLine = skillsFind.stdout.trim().split("\n")[1] ?? "";
assert(
  skillsFind.status === 0 && findDataLine.includes("app-tour"),
  "skills find ranks name matches first",
);
const skillsInstall = aih(["skills", "install", "batch-ops"]);
assert(
  skillsInstall.status === 0 && existsSync(".aih/skills/batch-ops/SKILL.md"),
  "skills install writes project SKILL.md",
);
const skillsListAfter = aih(["skills", "list"]);
assert(
  skillsListAfter.status === 0 && skillsListAfter.stdout.includes("project"),
  "installed skill discovered with project scope",
);
const skillsShowMissing = aih(["skills", "show", "nope"]);
assert(
  skillsShowMissing.status === 1 && skillsShowMissing.stderr.includes("unknown skill"),
  "skills show rejects unknown name",
);

// --- external skill registry (opencode-compatible index.json) ---
{
  const http = await import("node:http");
  const pathMod = await import("node:path");

  const regContent = ".aih-smoke-reg-content";
  const workDir = ".aih-smoke-reg-work";
  rmSync(regContent, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(`${regContent}/tui-design`, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    `${regContent}/tui-design/SKILL.md`,
    `---\nname: tui-design\ndescription: TUI UI design principles for terminal interfaces\n---\n# TUI Design\n\nWrap long lines and dim secondary text.\n`,
  );
  writeFileSync(
    `${regContent}/index.json`,
    JSON.stringify({
      skills: [
        {
          name: "tui-design",
          description: "TUI UI design principles for terminal interfaces",
          files: ["SKILL.md"],
          version: "1.0.0",
        },
        { name: "no-skill-md", description: "broken entry", files: ["README.md"], version: "1" },
      ],
    }),
  );
  // pre-create a project config so `skills registry <url>` writes here, not ~/.aih
  writeFileSync(`${workDir}/aih.json`, "{}\n");

  const root = pathMod.resolve(regContent);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const file = pathMod.resolve(root, rel);
    if (file !== root && !file.startsWith(root + pathMod.sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(readFileSync(file, "utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/`;

  // NOTE: must use async spawn (not spawnSync) so this process's event loop
  // stays free to serve the in-process HTTP registry while the CLI fetches it.
  const { execFile } = await import("node:child_process");
  const runIn = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => {
    const e = { ...process.env };
    delete e.AIH_SKILL_REGISTRY;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        { encoding: "utf8", cwd: workDir, env: e },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ status: code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  };

  try {
    const regSet = await runIn(["skills", "registry", base]);
    assert(
      regSet.status === 0 && regSet.stdout.includes("registry set to"),
      "skills registry <url> persists the registry URL",
    );
    assert(
      readFileSync(`${workDir}/aih.json`, "utf8").includes(base),
      "registry URL written to the project aih.json",
    );
    const regShow = await runIn(["skills", "registry"]);
    assert(regShow.status === 0 && regShow.stdout.includes(base), "skills registry shows the configured URL");

    const find = await runIn(["skills", "find", "tui"]);
    assert(
      find.status === 0 && find.stdout.includes("tui-design") && find.stdout.includes("remote"),
      "skills find surfaces remote registry matches",
    );
    assert(!find.stdout.includes("no-skill-md"), "registry entries without SKILL.md are filtered out");

    const inst = await runIn(["skills", "install", "tui-design"]);
    assert(
      inst.status === 0 && existsSync(`${workDir}/.aih/skills/tui-design/SKILL.md`),
      "skills install downloads a remote skill into .aih/skills",
    );
    assert(inst.stdout.includes("remote"), "remote install is labeled as remote");

    const listAfter = await runIn(["skills", "list"]);
    assert(
      listAfter.stdout.includes("tui-design") && listAfter.stdout.includes("project"),
      "installed remote skill is discovered with project scope",
    );

    rmSync(`${workDir}/.aih/skills/tui-design`, { recursive: true, force: true });
    const findInstall = await runIn(["skills", "find", "terminal design", "--install"]);
    assert(
      findInstall.status === 0 && existsSync(`${workDir}/.aih/skills/tui-design/SKILL.md`),
      "skills find --install auto-installs the top remote match",
    );

    const reinstall = await runIn(["skills", "install", "tui-design"]);
    assert(reinstall.status === 0, "reinstalling the same version is a clean no-op");

    const unknown = await runIn(["skills", "install", "does-not-exist"]);
    assert(
      unknown.status === 1 && unknown.stderr.includes("unknown skill"),
      "installing an unknown remote skill fails with a clear error",
    );
  } finally {
    server.close();
    rmSync(regContent, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

const devTools = aih(["tools", "--dev"]);
assert(
  devTools.status === 0 &&
    devTools.stdout.includes("run_cmd") &&
    devTools.stdout.includes("write_file") &&
    devTools.stdout.includes("add_todo"),
  "tools --dev lists local dev tools alongside app tools",
);
const generalTools = aih(["tools", "--dev"]);
for (const name of ["edit", "glob", "grep", "todo", "remember", "question", "task", "webfetch", "websearch", "apply_patch"]) {
  assert(generalTools.stdout.includes(name), `tools --dev lists ${name}`);
}

{
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerGeneralTools } = await import("./general-tools.js");
  const workdir = ".aih-smoke-general";
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(`${workdir}/src`, { recursive: true });
  writeFileSync(`${workdir}/src/app.ts`, "const a = 1;\nconst b = 2;\n");
  const gate = new AutoApprove();
  const registry = new ToolRegistry(gate);
  registerGeneralTools(registry, { gate, cwd: workdir });
  const call = async (name: string, args: unknown) => {
    const r = await registry.invoke(name, args, { turnId: "t", inject: () => {} });
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    return r.result as Record<string, unknown>;
  };
  const editRes = await call("edit", { path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 9;" });
  assert(readFileSync(`${workdir}/src/app.ts`, "utf8").includes("const a = 9;"), "edit replaces an exact string");
  const editDiff = editRes._diff as Array<{ t: string; s: string }>;
  assert(
    Array.isArray(editDiff) &&
      editDiff.some((d) => d.t === "del" && d.s.includes("const a = 1")) &&
      editDiff.some((d) => d.t === "add" && d.s.includes("const a = 9")),
    "edit returns a before/after diff for TUI rendering",
  );
  const globRes = await call("glob", { pattern: "*.ts" });
  assert((globRes.files as string[]).includes("src/app.ts"), "glob finds files at any depth");
  const grepRes = await call("grep", { pattern: "const a", include: "*.ts" });
  assert((grepRes.matches as unknown[]).length === 1, "grep matches file contents");
  await call("todo", { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "pending" }] });
  assert(existsSync(`${workdir}/.aih/todos.json`), "todo persists the list");
  const todoRes = await call("todo", { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "pending" }] });
  const todoItems = todoRes.todos as Array<{ content: string; status: string }>;
  assert(
    Array.isArray(todoItems) &&
      todoItems.length === 2 &&
      todoItems.some((t) => t.content === "x" && t.status === "in_progress") &&
      todoItems.some((t) => t.content === "y" && t.status === "pending"),
    "todo returns structured todos for the TUI side panel",
  );
  const emptyTodos = await call("todo", { todos: [] });
  assert((emptyTodos.todos as unknown[]).length === 0 && emptyTodos.list === "(empty)", "todo renders empty list");
  const patchRes = await call("apply_patch", {
    patch: "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** Update File: src/app.ts\n@@ const a = 9;\n-const b = 2;\n+const b = 3;\n*** End Patch",
  });
  assert(
    (patchRes.applied as string[]).length === 2 && readFileSync(`${workdir}/src/app.ts`, "utf8").includes("const b = 3;"),
    "apply_patch adds and updates files",
  );
  await call("remember", { action: "append", text: "smoke memory entry" });
  assert(
    readFileSync(`${workdir}/.aih/memory.md`, "utf8").includes("smoke memory entry"),
    "remember appends to .aih/memory.md",
  );
  // P0#2: user-level memory (cross-project) + injection budget.
  // AIH_HOME is redirected in-process so scope=user never touches real user data.
  const memHome = mkdtempSync("/tmp/aih-mem-");
  const userMemPath = `${memHome}/memory.md`;
  const prevAihHome = process.env.AIH_HOME;
  process.env.AIH_HOME = memHome;
  try {
    const userRes = await call("remember", { action: "append", text: "user-level smoke memory", scope: "user" });
    assert(
      (userRes.path as string) === userMemPath && readFileSync(userMemPath, "utf8").includes("user-level smoke memory"),
      "remember scope=user writes the XDG user memory file",
    );
    const userSet = await call("remember", { action: "set", text: "rewritten user memory", scope: "user" });
    assert(
      (userSet.path as string) === userMemPath &&
        readFileSync(userMemPath, "utf8").startsWith("# User memory") &&
        readFileSync(userMemPath, "utf8").includes("rewritten user memory") &&
        !readFileSync(userMemPath, "utf8").includes("user-level smoke memory"),
      "remember scope=user action=set rewrites the user file",
    );
    let badScope: string;
    try {
      await call("remember", { action: "append", text: "x", scope: "nope" });
      badScope = "no error";
    } catch (e) {
      badScope = String((e as Error).message);
    }
    assert(badScope.includes("unknown scope"), "remember rejects an unknown scope");
    const { loadMemoryBlock } = await import("./index.js");
    const block = loadMemoryBlock(workdir);
    assert(block.includes("smoke memory entry"), "loadMemoryBlock injects project memory");
    assert(block.includes("rewritten user memory"), "loadMemoryBlock also injects the current user memory");
    writeFileSync(userMemPath, "# User memory\n\n- 2026-01-01 — user fact abc\n");
    const block2 = loadMemoryBlock(workdir);
    assert(block2.includes("smoke memory entry") && block2.includes("user fact abc"), "loadMemoryBlock injects project + user memory");
    assert(block2.indexOf("# Project memory") < block2.indexOf("# User memory"), "project memory comes before user memory");
    // budget caps total length (project first, user gets the remainder)
    const big = "x".repeat(9000);
    writeFileSync(`${workdir}/.aih/memory.md`, `# Project memory\n\n- ${big}\n`);
    writeFileSync(userMemPath, `# User memory\n\n- ${big}\n`);
    const prevBudget = process.env.AIH_MEMORY_BUDGET;
    process.env.AIH_MEMORY_BUDGET = "1200";
    try {
      const capped = loadMemoryBlock(workdir);
      assert(capped.length <= 1400 && capped.includes("…(truncated)"), "AIH_MEMORY_BUDGET caps the injected memory block");
    } finally {
      if (prevBudget === undefined) delete process.env.AIH_MEMORY_BUDGET;
      else process.env.AIH_MEMORY_BUDGET = prevBudget;
    }
  } finally {
    if (prevAihHome === undefined) delete process.env.AIH_HOME;
    else process.env.AIH_HOME = prevAihHome;
  }
  const registryHooks = new ToolRegistry(gate);
  registryHooks.register({
    name: "calc",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ sum: 3 }),
  });
  registryHooks.addHooks({
    before: (info) => {
      if ((info.args as Record<string, unknown>).veto) throw new Error("nope");
    },
    after: (_info, outcome) =>
      outcome.ok ? { ...outcome, result: { ...(outcome.result as object), hooked: true } } : undefined,
  });
  const hookOk = await registryHooks.invoke("calc", { a: 1 }, { turnId: "t", inject: () => {} });
  assert(
    hookOk.ok && (hookOk.result as Record<string, unknown>).hooked === true,
    "after hook rewrites the tool result",
  );
  const hookDenied = await registryHooks.invoke("calc", { veto: true }, { turnId: "t", inject: () => {} });
  assert(!hookDenied.ok && (hookDenied.error ?? "").includes("hook vetoed"), "before hook can veto a call");

  // D#11: builtin redaction + timing hooks
  const { redactSecrets, countSecrets, builtinHooks, composeHooks } = await import("./hooks.js");
  const r1 = redactSecrets({ stdout: "token=sk-abcdef1234567890 done" }) as Record<string, unknown>;
  assert(String(r1.stdout).includes("[REDACTED]") && !String(r1.stdout).includes("sk-abcdef1234567890"), "redactSecrets masks sk- tokens");
  const r2 = redactSecrets("ghp_ABCDEFGHIJKLMNOP1234567890") as string;
  assert(r2.includes("[REDACTED]") && !r2.includes("ghp_ABCDEFGHIJKLMNOP1234567890"), "redactSecrets masks ghp_ tokens");
  const r3 = redactSecrets("password: hunter2secretvalue") as string;
  assert(r3.includes("[REDACTED]") && !r3.includes("hunter2secretvalue"), "redactSecrets masks key=value secrets");
  assert(redactSecrets("hello world") === "hello world", "redactSecrets leaves non-secret text alone");
  assert(redactSecrets({ a: 1, b: [true, "xoxb-1234567890abcdef"] }) !== undefined, "redactSecrets recurses into arrays/objects");
  assert(countSecrets("sk-abcdef1234567890") >= 1, "countSecrets counts secret shapes");
  assert(countSecrets("no secrets here") === 0, "countSecrets is 0 for clean text");

  // D#11 skill-driven hook config: extra secret shapes from skill front matter
  const { compileExtraPatterns } = await import("./hooks.js");
  const extra = ["acme_[A-Z0-9]{16,}"];
  const rSkill = redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234 done", extra) as string;
  assert(rSkill.includes("[REDACTED]") && !rSkill.includes("acme_ABCDEFGHIJKLMNOP1234"), "skill-driven pattern masks a custom secret shape");
  assert(redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234") === "key=acme_ABCDEFGHIJKLMNOP1234", "without the skill pattern the custom shape is untouched");
  assert(countSecrets("key=acme_ABCDEFGHIJKLMNOP1234", extra) >= 1, "countSecrets sees skill-driven patterns");
  // invalid regex source is skipped (never breaks the turn)
  const badExtra = ["[unclosed", "acme_[A-Z0-9]{16,}"];
  assert(compileExtraPatterns(badExtra).length === 1, "compileExtraPatterns skips invalid regexes");
  assert(redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234", badExtra) !== "key=acme_ABCDEFGHIJKLMNOP1234", "valid patterns still apply alongside an invalid one");
  // builtin patterns still apply on top of skill-driven ones
  const rBoth = redactSecrets("a=sk-abcdef1234567890 b=acme_ABCDEFGHIJKLMNOP1234", extra) as string;
  assert(!rBoth.includes("sk-abcdef1234567890") && !rBoth.includes("acme_ABCDEFGHIJKLMNOP1234"), "builtin + skill-driven patterns both apply");

  const regHooks = new ToolRegistry(new AutoApprove());
  regHooks.register({
    name: "leaky",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ stdout: "api_key=abcd1234efgh5678ijkl", n: 7 }),
  });
  regHooks.addHooks(builtinHooks());
  const hookResult = (await regHooks.invoke("leaky", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; n?: number; duration_ms?: number; redacted?: number };
  };
  assert(hookResult.ok, "builtin hook invocation succeeds");
  assert(!!hookResult.result?.stdout && hookResult.result.stdout.includes("[REDACTED]"), "result stdout is redacted");
  assert(!!hookResult.result?.stdout && !hookResult.result.stdout.includes("abcd1234efgh5678ijkl"), "raw secret is gone from result");
  assert(typeof hookResult.result?.duration_ms === "number" && hookResult.result!.duration_ms! >= 0, "duration_ms attached (>=0)");
  assert((hookResult.result?.redacted ?? 0) >= 1, "redacted counter present");
  assert(hookResult.result?.n === 7, "non-string fields untouched");

  // composeHooks: builtin (redact+timing) then a custom after — both apply in order
  const regCompose = new ToolRegistry(new AutoApprove());
  regCompose.register({
    name: "leaky2",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ stdout: "token=sk-zzzzzzzzzzzzzzzz" }),
  });
  regCompose.addHooks(
    composeHooks([
      builtinHooks(),
      { after: (_i, o) => ({ ...o, result: { ...((o.result as object) ?? {}), tagged: true } }) },
    ]),
  );
  const composed = (await regCompose.invoke("leaky2", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; tagged?: boolean; duration_ms?: number };
  };
  assert(composed.ok, "composed hooks invocation succeeds");
  assert(!!composed.result?.stdout && composed.result.stdout.includes("[REDACTED]"), "redaction applied in composition");
  assert(composed.result?.tagged === true, "custom after hook still runs after builtin");
  assert(typeof composed.result?.duration_ms === "number", "timing still present in composition");

  const planRegistry = new ToolRegistry(gate);
  registerGeneralTools(planRegistry, { gate, cwd: workdir }, true);
  const planNames = new Set(planRegistry.schemas().map((s) => s.name));
  assert(
    !planNames.has("edit") && !planNames.has("apply_patch"),
    "plan mode hides write-kind general tools",
  );
  // todo/remember mutate disk, so they are write-kind and must be hidden in plan mode
  assert(
    !planNames.has("todo") && !planNames.has("remember"),
    "plan mode hides disk-mutating tools (todo, remember)",
  );
  // read-only tools stay available in plan mode
  assert(planNames.has("glob") && planNames.has("grep"), "plan mode keeps read-only tools (glob, grep)");
  rmSync(workdir, { recursive: true, force: true });
}

const initDir = ".aih-smoke-init";
rmSync(initDir, { recursive: true, force: true });
const init = aih(["init", initDir, "--name", "my-items"]);
assert(init.status === 0, "init scaffolds a project");
assert(existsSync(`${initDir}/APP.md`), "init writes APP.md");
assert(
  readFileSync(`${initDir}/APP.md`, "utf8").includes("my-items"),
  "init substitutes the project name",
);
assert(existsSync(`${initDir}/mcp-server/src/app-adapter.ts`), "init writes mcp-server adapter");
assert(existsSync(`${initDir}/scripts/eval`), "init writes scripts/eval");
{
  const exe = spawnSync("test", ["-x", `${initDir}/scripts/eval`], { encoding: "utf8" });
  assert(exe.status === 0, "init scripts are executable");
}
const initAgain = aih(["init", initDir]);
assert(initAgain.status === 1 && initAgain.stderr.includes("already has an APP.md"), "init refuses to overwrite without --force");
rmSync(initDir, { recursive: true, force: true });

// --- multi-MCP: connect two stdio servers side by side and merge their tools ---
{
  const { connectMultiBackend } = await import("./mcp-backend.js");
  const mcpDir = ".aih-smoke-mcp";
  rmSync(mcpDir, { recursive: true, force: true });
  mkdirSync(mcpDir, { recursive: true });
  const serverSrc = (name: string, pong: string): string => `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const srv = new Server({ name: ${JSON.stringify(name)}, version: "1" }, { capabilities: { tools: {} } });
srv.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "pings " + ${JSON.stringify(name)}, inputSchema: { type: "object", properties: {} } }],
}));
srv.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: ${JSON.stringify(pong)} }],
}));
await srv.connect(new StdioServerTransport());
`.trim();
  writeFileSync(`${mcpDir}/server-a.mjs`, serverSrc("a", "pong-a"));
  writeFileSync(`${mcpDir}/server-b.mjs`, serverSrc("b", "pong-b"));
  const multi = await connectMultiBackend([
    { name: "srv-a", command: process.execPath, args: [`${mcpDir}/server-a.mjs`] },
    { name: "srv-b", command: process.execPath, args: [`${mcpDir}/server-b.mjs`] },
  ]);
  try {
    const defs = await multi.listTools();
    assert(
      defs.some((d) => d.name === "srv-a_ping") &&
        defs.some((d) => d.name === "srv-b_ping") &&
        !defs.some((d) => d.name === "ping"),
      "multi-MCP suffixes duplicate tool names (both servers' ping renamed)",
    );
    const desc = (await multi.describe()) as { servers: Record<string, unknown>; tools: string[] };
    assert(
      desc.tools.includes("srv-a_ping") && desc.tools.includes("srv-b_ping"),
      "multi-MCP describe lists all servers' tools",
    );
  } finally {
    multi.close();
    rmSync(mcpDir, { recursive: true, force: true });
  }
}

{
  // shell environment policy: secrets never reach agent-executed commands
  const { execFileSync } = (await import("node:child_process")) as {
    execFileSync: (...args: unknown[]) => Buffer;
  };
  const out = String(
    execFileSync(
      process.execPath,
      [
        "-e",
        [
          "const { buildChildEnv } = await import('./cli/dist/env-policy.js');",
          "const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/root', AIH_API_KEY: 'sk-secret', MY_TOKEN: 't', DB_PASSWORD: 'p', AWS_SECRET_ACCESS_KEY: 'x', LANG: 'C' });",
          "console.log(JSON.stringify(env));",
        ].join("\n"),
      ],
      { cwd: process.cwd() },
    ),
  );
  const env = JSON.parse(out) as Record<string, string>;
  assert(env.PATH === "/usr/bin" && env.HOME === "/root", "env policy keeps benign vars");
  assert(
    !("AIH_API_KEY" in env) && !("MY_TOKEN" in env) && !("DB_PASSWORD" in env) &&
      !("AWS_SECRET_ACCESS_KEY" in env),
    "env policy strips KEY/TOKEN/SECRET/PASSWORD vars from the child environment",
  );
  assert(env.LANG === "C", "env policy passes unrelated vars through");
}

{
  // skills roster respects its context budget: shortens descriptions first,
  // then omits skills entirely with a warning
  const { withSkillRoster } = await import("./index.js");
  const many = Array.from({ length: 200 }, (_, i) => ({
    name: `skill-${i}`,
    description: `d`.repeat(120),
    scope: "project" as const,
    body: "b",
  }));
  const out = withSkillRoster("BASE", many, 100_000); // budget = 2000 chars
  assert(out.startsWith("BASE"), "roster keeps the base prompt");
  assert(
    out.length <= 2200,
    "roster output stays within ~budget even with hundreds of skills",
  );
  assert(out.includes("hidden to stay within"), "roster warns about omitted skills");
  const small = withSkillRoster(
    "BASE",
    [{ name: "s", description: "d", scope: "project" as const, body: "b" }],
    100_000,
  );
  assert(small.includes("- s: d"), "small roster renders fully");
}

{
  // onPromptInput debug seam surfaces the exact model-visible messages
  const { AgentLoop, MockLLM, ToolRegistry, AutoApprove, toolCall } = await import("@aih/core");
  const seen: number[] = [];
  const loop = new AgentLoop({
    llm: new MockLLM([
      {
        text: "",
        toolCalls: [toolCall("c1", "echo", { text: "hi" })],
        stopReason: "tool_use" as const,
      },
      { text: "done", stopReason: "end_turn" as const },
    ]),
    tools: new ToolRegistry(new AutoApprove()),
    systemPrompt: "sys",
    onPromptInput: (messages) => seen.push(messages.length),
  });
  await loop.send("hello");
  assert(seen.length >= 2, "onPromptInput fires for every LLM request in a turn");
}

{
  // end-to-end: run_cmd child processes see a filtered environment
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const registry2 = new ToolRegistry(new AutoApprove());
  registerDevTools(registry2, process.cwd());
  const res = await registry2.invoke(
    "run_cmd",
    { command: "node -e 'console.log(JSON.stringify({t:process.env.SMOKE_TOKEN,k:process.env.AIH_API_KEY,p:process.env.PATH}))'" },
    { turnId: "smoke", inject: () => {} },
  ) as { ok: boolean; result?: { stdout?: string }; error?: string };
  assert(res.ok, "run_cmd e2e invocation succeeds");
  const outEnv = JSON.parse(res.result?.stdout ?? "{}") as {
    t?: string;
    k?: string;
    p?: string;
  };
  assert(outEnv.t === undefined && outEnv.k === undefined, "run_cmd hides SMOKE_TOKEN/AIH_API_KEY from children");
  assert(!!outEnv.p, "run_cmd keeps PATH for children");
}

{
  // T#22: keep_output persists the FULL (uncapped) output to a file
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const { mkdtempSync, readFileSync: rfs } = await import("node:fs");
  const { tmpdir: tdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const work = mkdtempSync(j(tdir(), "aih-keepout-"));
  try {
    const reg = new ToolRegistry(new AutoApprove());
    registerDevTools(reg, work);
    // 60KB of output: exceeds the 32KB in-band cap.
    const r = (await reg.invoke(
      "run_cmd",
      { command: "node -e 'console.log(\"x\".repeat(60*1024))'", keep_output: true },
      { turnId: "smoke", inject: () => {} },
    )) as { ok: boolean; result?: { truncated?: boolean; stdout?: string; output_file?: string; output_bytes?: number }; error?: string };
    assert(r.ok, `keep_output run succeeds (${r.error ?? "none"})`);
    assert(r.result?.truncated === true, "in-band stdout is still capped (truncated=true)");
    assert((r.result?.stdout ?? "").length <= 32 * 1024, "in-band stdout capped at 32KB");
    const file = r.result?.output_file;
    assert(!!file && file.startsWith(work), "output_file is under the working dir");
    const full = rfs(file!, "utf8");
    assert(full.length === 60 * 1024 + 1, `output_file holds the FULL 60KB (got ${full.length})`);
    assert(r.result?.output_bytes === 60 * 1024 + 1, "output_bytes reports the full size");
    // explicit output_path honored
    const r2 = (await reg.invoke(
      "run_cmd",
      { command: "echo hello-keep", keep_output: true, output_path: "custom/out.txt" },
      { turnId: "smoke", inject: () => {} },
    )) as { ok: boolean; result?: { output_file?: string }; error?: string };
    assert(r2.ok && r2.result?.output_file === j(work, "custom", "out.txt"), "output_path is honored");
    assert(rfs(j(work, "custom", "out.txt"), "utf8") === "hello-keep\n", "explicit output_path content is correct");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

{
  // D#12: sandbox seam — pluggable run_cmd backend (local default, registry, env/override)
  const {
    localBackend,
    bwrapBackend,
    remoteBackend,
    registerSandboxBackend,
    getSandboxBackend,
    listSandboxBackends,
    resolveSandboxBackend,
  } = await import("./sandbox.js");
  assert(localBackend.name === "local" && bwrapBackend.name === "bwrap" && remoteBackend.name === "remote", "built-in backends named");
  assert(listSandboxBackends().includes("local") && listSandboxBackends().includes("bwrap") && listSandboxBackends().includes("remote"), "registry lists built-ins");
  // local backend actually runs a command
  const lr = await localBackend.run({ command: "echo hello-sandbox", cwd: process.cwd(), env: { ...process.env } as NodeJS.ProcessEnv, timeoutMs: 10000 });
  assert(lr.code === 0 && lr.output.includes("hello-sandbox") && lr.timed_out === false, "local backend runs and captures output");
  // default resolution is local
  const prev = process.env.AIH_SANDBOX;
  delete process.env.AIH_SANDBOX;
  try {
    assert(resolveSandboxBackend().name === "local", "default backend is local");
    // env selection
    process.env.AIH_SANDBOX = "bwrap";
    assert(resolveSandboxBackend().name === "bwrap", "AIH_SANDBOX env selects bwrap");
    // per-call override wins over env
    assert(resolveSandboxBackend("local").name === "local", "per-call override wins over env");
    // unknown name falls back to local (never breaks a turn)
    assert(resolveSandboxBackend("does-not-exist").name === "local", "unknown backend falls back to local");
    // custom backend registration
    const custom = { name: "echoer", run: async () => ({ code: 0, timed_out: false, output: "custom-ran" }) };
    registerSandboxBackend("echoer", custom);
    assert(getSandboxBackend("echoer")?.name === "echoer", "custom backend registered");
    assert(resolveSandboxBackend("echoer").name === "echoer", "custom backend resolvable");
    const cr = await resolveSandboxBackend("echoer").run({ command: "x", cwd: ".", env: {} as NodeJS.ProcessEnv, timeoutMs: 1000 });
    assert(cr.output === "custom-ran", "custom backend executes");
  } finally {
    if (prev === undefined) delete process.env.AIH_SANDBOX;
    else process.env.AIH_SANDBOX = prev;
  }
  // run_cmd exposes the sandbox param and reports the backend used
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const reg = new ToolRegistry(new AutoApprove());
  registerDevTools(reg, process.cwd());
  const schema = reg.schemas().find((s) => s.name === "run_cmd");
  const props = (schema?.parameters as { properties?: Record<string, unknown> }).properties;
  assert(!!schema && props !== undefined && "sandbox" in props, "run_cmd schema exposes sandbox param");
  const r3 = (await reg.invoke("run_cmd", { command: "echo via-sandbox" }, { turnId: "smoke", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; sandbox?: string };
  };
  assert(r3.ok && !!r3.result?.stdout && r3.result.stdout.includes("via-sandbox") && r3.result?.sandbox === "local", "run_cmd reports the sandbox backend used");
}

{
  // bracketed paste (DEC 2004): multi-line pastes must be inserted as literal
  // text, never interpreted as key presses (the ctrl+shift+v auto-submit bug)
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("\x1b[200~one\ntwo\rthree\x1b[201~");
  assert(lines.length === 0, "paste alone never submits");
  tui.feed("\r");
  assert(
    lines.length === 1 && lines[0] === "one two three",
    "pasted newlines become spaces; real Enter submits once",
  );
}

{
  // paste payload split across stdin read-events (incl. a split end marker)
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("\x1b[200~hel");
  tui.feed("lo\nwor");
  tui.feed("ld\x1b[2");
  tui.feed("01~");
  tui.feed("\r");
  assert(
    lines.length === 1 && lines[0] === "hello world",
    "paste reassembles across events, surviving a split end marker",
  );
}

{
  // pasting while the palette overlay is open must not select an entry
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  const pick = tui.pick("pick", [{ label: "alpha" }, { label: "beta" }]);
  tui.feed("\x1b[200~ab\ncd\x1b[201~"); // must NOT commit the overlay
  tui.feed("\x1b");
  tui.feed("\x1b"); // double-Esc cancels
  const outcome = await Promise.race([
    pick,
    new Promise((r) => setTimeout(() => r("timeout"), 400)),
  ]);
  assert(
    JSON.stringify(outcome) === JSON.stringify({ kind: "cancel" }) && lines.length === 0,
    "overlay paste does not select; double-Esc still cancels",
  );
}

{
  // theme: OSC 11 background query resolves light/dark; response bytes must not
  // leak into the input
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  assert(tui.isDark() === true, "theme defaults to dark");
  tui.feed("\x1b]11;rgb:ffffffff/ffffffff/ffffffff\x07");
  assert(tui.isDark() === false, "OSC 11 white background resolves light theme");
  tui.feed("\x1b]11;rgb:0e0e0e/0e0e0e/0e0e0e\x07");
  assert(tui.isDark() === true, "OSC 11 black background resolves dark theme");
  const sub: string[] = [];
  const t2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => sub.push(l),
  });
  t2.feed("\x1b]11;rgb:ffffffff/ffffffff/ffffffff\x07");
  t2.feed("hi");
  t2.feed("\r");
  assert(sub.length === 1 && sub[0] === "hi", "OSC 11 response bytes never typed as input");
}

{
  // help dialog: `?` on an empty idle composer opens it; typed text then goes
  // to the overlay (not the composer); double-Esc closes; input works after
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("?"); // open help (empty input)
  tui.feed("x"); // would be composer text without the overlay
  tui.feed("\x1b");
  tui.feed("\x1b"); // close help
  tui.feed("hi");
  tui.feed("\r");
  assert(lines.length === 1 && lines[0] === "hi", "help overlay traps typing; closes on double-Esc");
  const l2: string[] = [];
  const t2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => l2.push(l),
  });
  t2.feed("why?");
  t2.feed("?");
  t2.feed("\r");
  assert(l2.length === 1 && l2[0] === "why??", "literal ? types normally in a non-empty composer");
}

{
  // sparkline: 8 steps, flat series mid-scale, fewer than 2 points = none
  const { Tui } = await import("./tui.js");
  assert(Tui.sparkline([1, 2, 3, 4, 5, 6, 7, 8]) === "▁▂▃▄▅▆▇█", "sparkline maps range to 8 blocks");
  assert(Tui.sparkline([4, 4, 4, 4]) === "▄▄▄▄", "sparkline flat series mid-scale");
  assert(Tui.sparkline([10]) === "" && Tui.sparkline() === "", "sparkline needs ≥2 points");
  assert(Tui.sparkline([1, 0, 2, 3]) === "▁▅█", "sparkline ignores non-positive points");
}

{
  // Tool rows: plain full-width lines (no background, no border); the whole
  // command wraps instead of being clipped. edit diffs render side-by-side
  // (left=removed, right=added) with red/green tinted cells.
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const cmd =
    "cd /app/agents/aih && npm install pkg-a pkg-b pkg-c --save-dev && npm run test -- --grep \"long pattern\" && echo done";
  tui.pushTool("run_cmd", { command: cmd }, "c1");
  tui.pushTool("write_file", { path: "/tmp/foo.txt", content: "x".repeat(3000) }, "c2");
  tui.pushTool("edit", { path: "/tmp/foo.txt", old_string: "old line", new_string: "new line" }, "c3");
  tui.resolveTool("c1", true, { done: true });
  tui.resolveTool("c2", true, { path: "/tmp/foo.txt" });
  tui.resolveTool("c3", true, {
    _diff: [
      { t: "del", s: "old line", a: 7 },
      { t: "add", s: "new line", b: 9 },
    ],
  });
  const raw = tui.transcriptLines();
  const body = raw.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""));
  const flat = body
    .map((l) => l.trimEnd())
    .join(" ")
    .replace(/\s+/g, " ");
  assert(flat.includes(cmd), "run_cmd row shows the full command across wrapped lines (no clip)");
  assert(
    flat.includes("/tmp/foo.txt") && !flat.includes("xxxx"),
    "write_file row shows the path, not the 3000-char content",
  );
  assert(!raw.some((l) => l.includes("48;5;236")), "tool rows carry no background box");
  assert(!raw.some((l) => l.includes("┃")), "tool rows carry no left border");
  const diffLine = raw.find((l) => l.includes("48;5;237") && l.includes("old line"));
  assert(!!diffLine, "edit diff renders a tinted removed row");
  const addLine = raw.find((l) => l.includes("48;5;233") && l.includes("new line"));
  assert(!!addLine, "edit diff renders a tinted added row");
  const flatBody = body.join("\n");
  assert(flatBody.indexOf("old line") < flatBody.indexOf("new line"), "removed row comes before the added row");
  assert(diffLine!.includes("┃") === false && addLine!.includes("┃") === false, "diff cells have no border");
  assert(body.every((l) => l.length <= 80), "tool rows fit the full history width (80 cols)");

  // F#31: line numbers + unified fallback on narrow terminals.
  // Default 80-col test TUI → body < 100 → unified single-column rows.
  assert(
    body.some((l) => /7 - old line/.test(l)) && body.some((l) => /9 \+ new line/.test(l)),
    "narrow (<100 cols) diff falls back to unified with inline numbers",
  );
  assert(
    !raw.some((l) => l.includes("48;5;237") && l.includes("48;5;233")),
    "unified fallback renders one cell per row (never both tints)",
  );
  // Wide terminal (width option = 120): side-by-side with numbered gutters.
  const wide = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
    width: 120,
  });
  wide.pushTool("edit", { path: "/tmp/foo.txt", old_string: "a\nb", new_string: "A\nc" }, "w1");
  wide.resolveTool("w1", true, {
    _diff: [
      { t: "del", s: "alpha", a: 12 },
      { t: "del", s: "beta", a: 13 },
      { t: "add", s: "ALPHA", b: 12 },
      { t: "add", s: "GAMMA", b: 13 },
    ],
  });
  const wideRaw = wide.transcriptLines();
  const pairRow = wideRaw.find((l) => l.includes("48;5;237") && l.includes("48;5;233"));
  assert(!!pairRow, "wide diff renders side-by-side (both tints on one row)");
  const pairBody = pairRow!.replace(/\x1b\[[0-9;]*m/g, "");
  assert(pairBody.includes("12 - alpha") && pairBody.includes("12 + ALPHA"), "wide diff shows old/new line numbers before -/+");
  assert(wideRaw.some((l) => /13 - beta/.test(l.replace(/\x1b\[[0-9;]*m/g, ""))), "second del keeps its own number");
  assert(
    wideRaw.every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 120),
    "wide diff rows fit the fixed width",
  );
  assert(!pairBody.includes("┃"), "wide diff cells keep the borderless style");
}

// --- Post-write auto-formatting (roadmap F#27, opencode formatters) --------
{
  const { formatAfterWrite, detectFormatter } = await import("./formatter.js");
  const { chmodSync } = await import("node:fs");
  const root = process.cwd();
  const base = `${root}/.aih-smoke-fmt`;
  rmSync(base, { recursive: true, force: true });
  mkdirSync(`${base}/plain`, { recursive: true });
  mkdirSync(`${base}/cfg`, { recursive: true });
  mkdirSync(`${base}/bin/node_modules/.bin`, { recursive: true });

  // 1) no formatter configured anywhere up the tree → untouched result
  writeFileSync(`${base}/plain/a.js`, "const x=1;\n");
  const r1 = await formatAfterWrite(`${base}/plain/a.js`, base);
  assert(r1.formatted === undefined && r1.formatNote === undefined, "formatter: no config → no-op (no formatted flag)");
  assert(detectFormatter(`${base}/plain/a.js`) === undefined, "formatter: detection returns undefined without config");
  assert(detectFormatter(`${base}/plain/a.txt`) === undefined, "formatter: non-formattable extension ignored");

  // 2) prettier configured (dep) but no binary → formatNote, never throws
  writeFileSync(`${base}/cfg/package.json`, JSON.stringify({ name: "cfg", devDependencies: { prettier: "3.0.0" } }));
  writeFileSync(`${base}/cfg/code.js`, "const   x   = 1;\n");
  const r2 = await formatAfterWrite(`${base}/cfg/code.js`, base);
  assert(r2.formatted === false && typeof r2.formatNote === "string" && r2.formatter === "prettier", "formatter: configured but missing binary → formatNote, not fatal");

  // 3) a real (fake) prettier binary → formatted:true + changed:true, file rewritten
  writeFileSync(`${base}/bin/package.json`, JSON.stringify({ name: "bin", devDependencies: { prettier: "3.0.0" } }));
  writeFileSync(
    `${base}/bin/node_modules/.bin/prettier`,
    "#!/bin/sh\nf=\"$3\"; [ -f \"$f\" ] || f=\"$2\"; [ -f \"$f\" ] || f=\"$1\"; sed -i 's/  */ /g' \"$f\"\n",
  );
  chmodSync(`${base}/bin/node_modules/.bin/prettier`, 0o755);
  writeFileSync(`${base}/bin/code.js`, "const   x   =   1;\n");
  const before = readFileSync(`${base}/bin/code.js`, "utf8");
  const r3 = await formatAfterWrite(`${base}/bin/code.js`, base);
  const after = readFileSync(`${base}/bin/code.js`, "utf8");
  assert(r3.formatted === true && r3.formatter === "prettier" && r3.changed === true, "formatter: real binary success → formatted + changed");
  assert(before !== after, "formatter: the file on disk was actually rewritten");

  // 4) the write tools merge the outcome into their result (write_file)
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const reg = new ToolRegistry(new AutoApprove());
  registerDevTools(reg, base);
  const wf = reg.get("write_file")!;
  const res = (await wf.execute({ path: `${base}/bin/merge.js`, content: "const   y   =   2;\n" }, { turnId: "t", inject: () => {} })) as Record<string, unknown>;
  assert(res.formatted === true && res.formatter === "prettier", "write_file result carries the formatted flag");
  rmSync(base, { recursive: true, force: true });
}

// --- Deterministic workflows (roadmap F#33 / P1#6) -------------------------
{
  const wfDir = ".aih-smoke-wf";
  rmSync(wfDir, { recursive: true, force: true });
  mkdirSync(`${wfDir}/.aih/workflows`, { recursive: true });
  const wfRun = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: wfDir, env: process.env });

  // list in an empty dir
  const emptyDir = ".aih-smoke-wf-empty";
  rmSync(emptyDir, { recursive: true, force: true });
  mkdirSync(emptyDir, { recursive: true });
  const listEmpty = spawnSync(process.execPath, [cli, "workflow", "list"], { encoding: "utf8", cwd: emptyDir, env: process.env });
  assert(listEmpty.status === 0 && listEmpty.stdout.includes("no workflows yet"), "workflow list in empty dir is a clean no-op");

  writeFileSync(
    `${wfDir}/.aih/workflows/good.mjs`,
    `export default { name: "good", description: "smoke", phases: [
      { name: "p1", prompt: "say hi", expect: "Added via mock.", retries: 0 },
      { name: "p2", prompts: ["a", "b"], expect: "Added via mock.", retries: 0 },
    ] };`,
  );
  const list = wfRun(["workflow", "list"]);
  assert(list.status === 0 && list.stdout.includes("good") && list.stdout.includes("2 phase(s)"), "workflow list shows name + phase count");

  const runOk = wfRun(["workflow", "run", "good", "--mock", "--ephemeral"]);
  assert(runOk.status === 0 && runOk.stdout.includes("workflow ok") && runOk.stdout.includes("p2"), "workflow run (mock) passes both phases");

  const runOkJson = wfRun(["workflow", "run", "good", "--mock", "--ephemeral", "--format", "json"]);
  const rep = JSON.parse(runOkJson.stdout);
  assert(rep.ok === true && rep.phases.length === 2 && rep.phases[1].parallel === 2, "workflow JSON report: ok, 2 phases, parallel fan-out recorded");

  // expect-gate failure → fail-fast, exit 1, failedPhase named
  writeFileSync(
    `${wfDir}/.aih/workflows/bad.mjs`,
    `export default { name: "bad", phases: [
      { name: "gate", prompt: "x", expect: "NEVER-APPEARS", retries: 1 },
      { name: "after", prompt: "y", expect: "Added via mock.", retries: 0 },
    ] };`,
  );
  const runBad = wfRun(["workflow", "run", "bad", "--mock", "--ephemeral"]);
  assert(runBad.status === 1 && runBad.stdout.includes('failed at phase "gate"'), "workflow expect-gate failure fails fast with exit 1");
  const badRep = JSON.parse(
    wfRun(["workflow", "run", "bad", "--mock", "--ephemeral", "--format", "json"]).stdout,
  );
  assert(
    badRep.ok === false && badRep.failedPhase === "gate" && badRep.phases.length === 1 && badRep.phases[0].attempts === 2,
    "workflow failure report names the failed phase, bounded retries, later phases skipped",
  );

  // unknown workflow → clean error
  const runMissing = wfRun(["workflow", "run", "nope", "--mock", "--ephemeral"]);
  assert(runMissing.status === 1 && runMissing.stderr.includes('workflow "nope" not found'), "workflow run of a missing name errors cleanly");

  rmSync(wfDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
}

// --- run --goal: judge-verified auto-continuation + goal/judge event (P0#3) ---
{
  const goalDir = ".aih-smoke-goal";
  rmSync(goalDir, { recursive: true, force: true });
  mkdirSync(goalDir, { recursive: true });
  const goalRun = spawnSync(
    process.execPath,
    [cli, "run", "do the thing", "--mock", "--yes", "--session", "g", "--goal", "the thing is done"],
    { encoding: "utf8", cwd: goalDir, env: { ...process.env, AIH_GOAL_ROUNDS: "1" } },
  );
  assert(goalRun.status === 1, "run --goal exits 1 when the judge never reports met (mock)");
  assert(goalRun.stderr.includes("goal not met after auto-continue rounds"), "run --goal reports the bounded stop");
  // the judge verdict must be persisted as a structured goal/judge event
  const sessFile = `${goalDir}/.aih/sessions/g.jsonl`;
  const sess = existsSync(sessFile) ? readFileSync(sessFile, "utf8") : "";
  assert(
    sess.includes('"goal/judge"') && sess.includes('"unmet"'),
    "run --goal persists a structured goal/judge event in the session log",
  );
  rmSync(goalDir, { recursive: true, force: true });
}

// --- TUI markdown table rendering: bordered, column-aligned, CJK-aware ---
{
  const { Tui, width, cols } = await import("./tui.js");
  assert(width("✅") === 2 && width("⚪") === 2, "emoji (✅ ⚪) count 2 cells");
  assert(width("⚠") === 1 && width("⚠️") === 1, "⚠ (U+26A0) is 1 cell in the user's CJK font (override)");
  assert(width("✓") === 1 && width("✗") === 1 && width("❯") === 1, "text dingbats (✓ ✗ ❯, EAW=N) count 1 cell");
  assert(width("≥") === 1 && width("−") === 1, "math operators (≥ −, EAW=A) count 1 cell by default");
  assert(width("—") === 1 && width("…") === 1 && width("→") === 1, "dashes/ellipsis/arrows (— … →) count 1 cell by default");
  assert(width("\ufe0f") === 0, "variation selector (U+FE0F) is zero-width");
  assert(width("组") === 2 && width("\u{1f600}") === 2, "true-wide (CJK, pictographic emoji) stay 2 cells");
  const tuiUrl = pathToFileURL(fileURLToPath(new URL("./tui.js", import.meta.url))).href;
  const probe = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(tuiUrl)}).then((m) => console.log(m.width("✅"), m.width("≥"), m.width("—")))`],
      { encoding: "utf8", env: { ...process.env, ...env } },
    ).stdout.trim();
  assert(probe({ AIH_AMBIGUOUS_WIDE: "1" }) === "2 1 1", "AIH_AMBIGUOUS_WIDE=1 keeps EAW=A narrow (emoji still 2)");
  assert(probe({ AIH_AMBIGUOUS_WIDE: "2" }) === "2 2 2", "AIH_AMBIGUOUS_WIDE=2 forces EAW=A wide");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const table = [
    "核对完成。",
    "| 组 | 文件 | roadmap 依据 |",
    "|---|---|---|",
    "| **A. Workflow 引擎** | `cli/src/workflow.ts`（新）、`cli/src/index.ts` 部分 | #6 / #33「✅ v0.2 已交付」 |",
    "| **B. 写后格式化** | `cli/src/formatter.ts`（新） | #27「✅ v0.2 已交付」 |",
  ].join("\n");
  tui.pushDelta(table);
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = tui.transcriptLines().map(plain);
  const tableLines = lines.slice(lines.findIndex((l) => l.includes("┌")));
  assert(tableLines.length > 0, "markdown table renders as a bordered block");
  assert(tableLines[0].includes("┌") && tableLines[0].includes("┬") && tableLines[0].includes("┐"), "table top border has corners + junctions");
  assert(tableLines.some((l) => l.includes("├") && l.includes("┼") && l.includes("┤")), "table header separator row present");
  assert(tableLines[tableLines.length - 1].includes("└") && tableLines[tableLines.length - 1].includes("┴"), "table bottom border present");
  const contentRows = tableLines.filter((l) => !/^[┌├└─┬┼┴┐┤┘\s]+$/.test(l));
  assert(contentRows.length > 0 && contentRows.every((l) => l.includes("│")), "content rows have column separators");
  assert(tableLines.every((l) => !l.includes(" · ")), "table pipes are NOT mangled into ' · '");
  const joined = tableLines.join("\n");
  assert(joined.includes("组") && joined.includes("roadmap") && joined.includes("依据"), "header cells preserved");
  assert(joined.includes("Workflow") && joined.includes("引擎") && joined.includes("cli/src/workflow.ts"), "data cells preserved (bold + code, wrap-tolerant)");
  assert(joined.includes("cli/src/formatter.ts"), "second data row cell preserved");
  const widths = tableLines.map((l) => cols(l));
  assert(new Set(widths).size === 1, `all table rows align to one display width (${widths[0]})`);
}

// --- TUI performance: batch replay + render cache + history seeding ---
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const md = "text **bold** and a table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```";
  tui.beginBatch();
  for (let i = 0; i < 50; i++) {
    tui.push({ role: "user", text: `hello ${i}` });
    tui.push({ role: "assistant", text: md + ` (msg ${i})` });
    tui.pushTool("run_cmd", { command: `echo ${i}` }, `c${i}`);
    tui.resolveTool(`c${i}`, true, { stdout: `out ${i}\nline2\nline3\nline4` });
  }
  tui.endBatch();
  tui.seedHistory(["first", "second", "third"]);
  const lines = tui.transcriptLines();
  assert(lines.some((l) => l.includes("hello 0")) && lines.some((l) => l.includes("hello 49")), "batch replay renders all user messages");
  assert(lines.some((l) => l.includes("bold")) && lines.some((l) => l.includes("const x = 1;")), "batch replay renders assistant markdown (bold + code)");
  // Render cache: repeated renders are consistent and fast.
  const t0 = Date.now();
  for (let k = 0; k < 50; k++) tui.transcriptLines();
  const per = (Date.now() - t0) / 50;
  assert(per < 50, `render cache keeps repeated renders fast (${per.toFixed(1)} ms < 50 ms)`);
  // Mutating the streaming item invalidates its cache (re-render picks up new text).
  tui.pushDelta("APPENDED");
  assert(tui.transcriptLines().some((l) => l.includes("APPENDED")), "pushDelta after cache invalidates and re-renders");
}

// --- F#28 increment: worktree snapshot on checkpoints ------------------------
{
  const { gitStatusSummary, formatWorktreeSummary, MAX_DIRTY_ENTRIES } = await import("./worktree.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync: gitSpawn } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "aih-wt-"));
  const run = (args: string[]) => gitSpawn("git", args, { cwd: repo, encoding: "utf8" });

  // Not a repository → undefined, never throws.
  const plain = mkdtempSync(join(tmpdir(), "aih-plain-"));
  assert(gitStatusSummary({ cwd: plain }) === undefined, "worktree snapshot returns undefined outside a repo");
  rmSync(plain, { recursive: true, force: true });

  // Real repo: branch + HEAD + dirty files.
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "smoke@test"]);
  run(["config", "user.name", "smoke"]);
  writeFileSync(`${repo}/tracked.txt`, "v1\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  writeFileSync(`${repo}/tracked.txt`, "v2\n");
  writeFileSync(`${repo}/new.txt`, "n\n");
  const snap = gitStatusSummary({ cwd: repo });
  assert(!!snap && snap.branch === "main", "snapshot reads the current branch");
  assert(!!snap && typeof snap.head === "string" && /^[0-9a-f]{7,}$/.test(snap.head!), "snapshot carries the short HEAD sha");
  assert(!!snap && !snap.clean && snap.dirtyCount === 2 && snap.dirty.length === 2, "snapshot lists changed files (modified + untracked)");
  assert(!!snap && snap.dirty.some((d) => d.startsWith("M") && d.includes("tracked.txt")), "modified file keeps its status letter");

  // Cap + formatting.
  for (let i = 0; i < MAX_DIRTY_ENTRIES + 5; i += 1) writeFileSync(`${repo}/f${i}.txt`, "x\n");
  const capped = gitStatusSummary({ cwd: repo });
  assert(!!capped && capped.dirty.length === MAX_DIRTY_ENTRIES && capped.dirtyCount > capped.dirty.length, "dirty list caps at MAX_DIRTY_ENTRIES but counts all");
  const lines = formatWorktreeSummary(snap!);
  assert(lines[0].startsWith("worktree: main @ "), "formatted summary names branch@sha");
  assert(lines.slice(1).some((l) => l.trim().length > 0), "formatted summary includes dirty entries");
  rmSync(repo, { recursive: true, force: true });

  // CLI checkpoint embeds the snapshot into the event (cwd = this repo).
  rmSync(".aih/sessions", { recursive: true, force: true });
  const s1run = aih(["run", "seed for wt", "--mock", "--yes", "--session", "s1wt"]);
  assert(s1run.status === 0, "seed session exists before checkpoint");
  const cpOut = aih(["session", "checkpoint", "s1wt", "wt", "check"]);
  assert(cpOut.status === 0 && cpOut.stdout.includes("worktree:"), "CLI checkpoint prints the worktree summary");
  const s1Events = JSON.parse(aih(["session", "export", "s1wt"]).stdout);
  const cpEvt = [...s1Events].reverse().find((e: { type?: string }) => e.type === "checkpoint");
  assert(!!cpEvt?.worktree, "checkpoint event carries a worktree summary");
  assert(
    typeof cpEvt.worktree.dirtyCount === "number" && Array.isArray(cpEvt.worktree.dirty) && typeof cpEvt.worktree.branch !== "undefined",
    "worktree summary is structured (branch/head/dirty/dirtyCount)",
  );
}

// --- P2#7: dream / distill (pure extraction over session events) ------------
{
  const { findFlowCandidates, extractDreamMaterial, formatDreamMaterial } =
    await import("./dream.js");
  type Ev = Record<string, unknown>;
  const am = (toolCalls: Array<{ name: string; args: unknown }>): Ev => ({
    type: "assistant/message",
    turnId: "t",
    text: "",
    toolCalls,
  });
  const um = (text: string): Ev => ({ type: "user/message", turnId: "t", text });

  // flow candidates: same tool + same signature >= 3 → candidate; below → not
  const evs: Ev[] = [
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm run build" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a/" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a" } }]),
    am([{ name: "run_cmd", args: { command: "echo once" } }]),
  ];
  const flows = findFlowCandidates(evs as never);
  assert(flows.length === 2, "distill finds exactly 2 repeated flows");
  assert(flows[0].tool === "run_cmd" && flows[0].count === 3, "most-repeated flow ranks first");
  assert(flows.some((f) => f.tool === "webfetch" && f.count === 3), "trailing-slash-normalized URL still matches");
  assert(flows.every((f) => f.count >= 3), "below-threshold flows are excluded");

  // dream material: corrections + checkpoint notes + judge reasons + flows
  const evs2: Ev[] = [
    um("不要推送，先本地提交"),
    um("remember: always run npm run eval before handoff"),
    um("just a short chat"),
    { type: "checkpoint", note: "before risky refactor" },
    { type: "goal/judge", met: false, reason: "tests were not run" },
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
  ];
  const mat = extractDreamMaterial([[...evs, ...evs2]] as never);
  assert(mat.sessions === 1, "dream counts sessions scanned");
  assert(mat.corrections.length === 2, "corrections captured (2 of 3 user turns)");
  assert(mat.checkpointNotes.includes("before risky refactor"), "checkpoint note captured");
  assert(mat.judgeReasons.includes("tests were not run"), "judge reason captured");
  assert(mat.flows.length === 2, "flows carried into dream material");
  const txt = formatDreamMaterial(mat);
  assert(txt.includes("sessions scanned: 1") && txt.includes("npm test"), "formatted material renders");
  // empty input → clean no-op
  const empty = extractDreamMaterial([[]] as never);
  assert(empty.corrections.length === 0 && empty.flows.length === 0 && formatDreamMaterial(empty).includes("nothing notable"), "empty sessions → nothing notable");
}

// --- P2#9: /vivid concise (plain) render mode -------------------------------
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  assert(!tui.isPlain(), "vivid (plain render) defaults off");
  tui.push({ role: "user", text: "hello" });
  tui.push({ role: "assistant", text: "world" });
  const vivid = tui.transcriptLines().join("\n");
  assert(vivid.includes("┃"), "default render keeps the user-row border (┃)");
  tui.setPlain(true);
  assert(tui.isPlain(), "setPlain(true) toggles on");
  const plain = tui.transcriptLines().join("\n");
  assert(plain.includes("hello") && plain.includes("world"), "plain render still shows the text");
  assert(!plain.includes("┃"), "plain render drops the user-row border");
  assert(!plain.includes("\x1b[48"), "plain render drops the surface background");
  tui.setPlain(false);
  assert(!tui.isPlain(), "setPlain(false) toggles back off");
}

// --- P2#9: config $schema injection (editor autocompletion) -----------------
{
  const { mkdtempSync: mkd } = await import("node:fs");
  const { tmpdir: tdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const proj = mkd(j(tdir(), "aih-schema-proj-"));
  try {
    const out = aihClean(["config", "--schema"], {}, proj);
    const schema = JSON.parse(out.stdout);
    assert(schema.$id?.endsWith("aih.schema.json"), "config --schema prints a valid AIH schema");
    assert(
      schema.properties?.model && schema.properties?.providers && schema.properties?.mcpServers,
      "schema covers model/providers/mcpServers",
    );
    const cfg = JSON.parse(aihClean(["config"], {}, proj).stdout);
    assert(
      cfg.schema?.endsWith("aih.schema.json") && cfg.schemaFile?.endsWith("aih.schema.json"),
      "aih config exposes the $schema URL + local file path",
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- P2#9: Max Mode — parallel subagents + best-of-N judge ------------------
{
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerGeneralTools } = await import("./general-tools.js");
  const { mapOrdered, parseJudgeVerdict, runSubagent } = await import("./maxmode.js");

  // Pure helpers first.
  const pv = parseJudgeVerdict('{"best": 2, "reason": "most complete"}', 3);
  assert(pv.best === 2 && pv.reason === "most complete", "parseJudgeVerdict reads best+reason");
  assert(parseJudgeVerdict('{"best": 9}', 3).best === 0, "parseJudgeVerdict clamps out-of-range to 0");
  assert(parseJudgeVerdict("no json here", 3).best === 0, "parseJudgeVerdict falls back to 0 on garbage");

  // mapOrdered: results in input order regardless of completion order.
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const out = await mapOrdered(
    [() => delay(30).then(() => "slow"), () => delay(5).then(() => "fast"), () => delay(10).then(() => "mid")],
    2,
  );
  assert(out.join(",") === "slow,fast,mid", "mapOrdered returns results in input order");

  // Concurrency is actually bounded (limit=2 over 4 jobs).
  {
    let inflight = 0;
    let maxInflight = 0;
    await mapOrdered(
      Array.from({ length: 4 }, () => async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await delay(10);
        inflight -= 1;
        return true;
      }),
      2,
    );
    assert(maxInflight === 2, `mapOrdered caps in-flight jobs at the limit (observed ${maxInflight})`);
  }

  // Routing LLM: subagent calls (tools present) answer per-candidate; the
  // judge call (no tools) picks an index.
  const makeLlm = (judgeBest: number) => {
    let sub = 0;
    return {
      complete: async (req: { tools: unknown[] }) => {
        if (req.tools.length === 0) {
          return { text: JSON.stringify({ best: judgeBest, reason: "judge says so" }), toolCalls: [], stopReason: "end_turn" as const };
        }
        const i = sub++;
        return { text: `answer-${i}`, toolCalls: [], stopReason: "end_turn" as const };
      },
    };
  };

  const parent = new ToolRegistry(new AutoApprove());
  parent.register({
    name: "echo",
    description: "echo",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
    execute: async (args: unknown) => ({ echoed: args }),
  });

  const gate = new AutoApprove();
  const registry = new ToolRegistry(gate);
  registerGeneralTools(registry, { gate, llm: makeLlm(1), toolsProvider: () => parent, cwd: "/tmp" });
  assert(Boolean(registry.get("best_of_n")), "best_of_n tool is registered");

  const r = (await registry.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 3 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; result?: { best: number; n: number; candidates: Array<{ ok: boolean; answer: string }>; answer: string }; error?: string };
  assert(r.ok, `best_of_n runs (error: ${r.error ?? "none"})`);
  assert(r.result!.n === 3 && r.result!.candidates.length === 3, "best_of_n runs N=3 candidates");
  assert(r.result!.candidates.every((c) => c.ok), "all candidates succeeded");
  assert(r.result!.best === 1 && r.result!.answer === "answer-1", "judge picks candidate 1 and its answer is returned");

  // n is clamped to [1,8].
  const r2 = (await registry.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 99 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; result?: { n: number }; error?: string };
  assert(r2.ok && r2.result!.n === 8, "best_of_n clamps n to 8");

  // All-fail path: judge is skipped, best=-1 → tool error.
  const failingLlm = {
    complete: async () => {
      throw new Error("provider down");
    },
  };
  const registryFail = new ToolRegistry(gate);
  registerGeneralTools(registryFail, { gate, llm: failingLlm, toolsProvider: () => parent, cwd: "/tmp" });
  const rf = (await registryFail.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 2 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; error?: string };
  assert(!rf.ok && /all candidates failed/.test(rf.error ?? ""), "best_of_n reports all-candidates-failed when every subagent errors");

  // runSubagent excludes task/question/best_of_n (no recursion) but keeps tools.
  const { ToolRegistry: Reg2 } = await import("@aih/core");
  const parent2 = new Reg2(new AutoApprove());
  parent2.register({
    name: "echo2",
    description: "echo2",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
    execute: async () => ({ ok: 1 }),
  });
  parent2.register({
    name: "question",
    description: "q",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "q",
  });
  const sub = await runSubagent({ gate, llm: makeLlm(0), toolsProvider: () => parent2 }, "do it");
  assert(sub.answer === "answer-0", "runSubagent returns the subagent's final answer");
}

// --- P2#9: XDG data-dir resolution (paths.ts + config/skills wiring) --------
{
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveAihPaths, userAihDirs } = await import("./paths.js");

  // Pure resolution (env-injected, no disk needed).
  assert(
    resolveAihPaths({ AIH_HOME: "/x", XDG_DATA_HOME: "/xdg", HOME: "/h" }).user === "/x",
    "AIH_HOME wins over XDG_DATA_HOME and default",
  );
  assert(
    resolveAihPaths({ XDG_DATA_HOME: "/xdg", HOME: "/h" }).user === "/xdg/aih",
    "XDG_DATA_HOME/aih is used when AIH_HOME is unset",
  );
  assert(
    resolveAihPaths({ HOME: "/h" }).user === "/h/.local/share/aih",
    "default is ~/.local/share/aih (XDG base dir)",
  );

  // Legacy ~/.aih compat: honored only while the XDG dir does not exist yet.
  const home = mkdtempSync(join(tmpdir(), "aih-xdg-"));
  try {
    mkdirSync(join(home, ".aih"), { recursive: true });
    const legacyOnly = resolveAihPaths({ HOME: home });
    assert(
      legacyOnly.user === join(home, ".aih") && legacyOnly.usingLegacy === true,
      "existing legacy ~/.aih is honored while the XDG dir is absent",
    );
    mkdirSync(join(home, ".local", "share", "aih"), { recursive: true });
    const both = resolveAihPaths({ HOME: home });
    assert(
      both.user === join(home, ".local", "share", "aih") && both.usingLegacy === false,
      "once the XDG dir exists it wins over legacy ~/.aih",
    );
    const dirs = userAihDirs({ HOME: home });
    assert(
      dirs.length === 2 && dirs[0] === join(home, ".local", "share", "aih") && dirs[1] === join(home, ".aih"),
      "userAihDirs lists primary first, legacy second (deduped)",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // Subprocess: AIH_HOME drives the user config + skills + --global install.
  const home2 = mkdtempSync(join(tmpdir(), "aih-xdg-cfg-"));
  const project = mkdtempSync(join(tmpdir(), "aih-xdg-proj-"));
  try {
    const userCfg = join(home2, "config.json");
    writeFileSync(userCfg, JSON.stringify({ model: "xdg-model-1", contextWindow: 4242 }) + "\n");
    // a user skill under the XDG-resolved dir
    mkdirSync(join(home2, "skills", "xdg-skill"), { recursive: true });
    writeFileSync(
      join(home2, "skills", "xdg-skill", "SKILL.md"),
      "---\nname: xdg-skill\ndescription: a user skill in the XDG dir\n---\nbody\n",
    );

    // Run from the empty project dir (no aih.json) with the dev shell's
    // AIH_MODEL/AIH_BASE_URL stripped, so the AIH_HOME config.json is the only
    // model source.
    const cfgOut = aihClean(["config"], { AIH_HOME: home2, HOME: home2 }, project);
    const cfg = JSON.parse(cfgOut.stdout);
    assert(
      cfg.model?.value === "xdg-model-1" && cfg.model?.source === userCfg,
      "aih config resolves model from the AIH_HOME config.json",
    );
    assert(
      Array.isArray(cfg.configLayers) && cfg.configLayers.includes(userCfg),
      "aih config lists the AIH_HOME layer",
    );

    const listOut = aih(["skills", "list"], { AIH_HOME: home2, HOME: home2 }, project);
    assert(listOut.stdout.includes("xdg-skill") && listOut.stdout.includes("user"), "aih skills list finds the XDG user skill");

    const inst = aih(["skills", "install", "app-tour", "--global"], { AIH_HOME: home2, HOME: home2 }, project);
    assert(inst.status === 0 && existsSync(join(home2, "skills", "app-tour", "SKILL.md")), "skills install --global lands in the XDG dir");
    assert(!existsSync(join(project, ".aih", "skills", "app-tour")), "--global install does not touch the project dir");
  } finally {
    rmSync(home2, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }

  // Subprocess: legacy ~/.aih config is still read when the XDG dir is absent.
  const home3 = mkdtempSync(join(tmpdir(), "aih-xdg-legacy-"));
  const proj3 = mkdtempSync(join(tmpdir(), "aih-xdg-legacy-proj-"));
  try {
    mkdirSync(join(home3, ".aih"), { recursive: true });
    const legacyCfg = join(home3, ".aih", "config.json");
    writeFileSync(legacyCfg, JSON.stringify({ model: "legacy-model-2" }) + "\n");
    const out = aihClean(
      ["config"],
      { HOME: home3, AIH_HOME: "", XDG_DATA_HOME: "" },
      proj3,
    );
    const cfg = JSON.parse(out.stdout);
    assert(
      cfg.model?.value === "legacy-model-2" && cfg.model?.source === legacyCfg,
      "legacy ~/.aih/config.json is honored for existing installs (XDG absent)",
    );
  } finally {
    rmSync(home3, { recursive: true, force: true });
    rmSync(proj3, { recursive: true, force: true });
  }
}

// --- P2#8: serve / attach (headless harness over HTTP/SSE) ------------------
{
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workDir = mkdtempSync(join(tmpdir(), "aih-serve-"));
  const port = 18000 + (process.pid % 10000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [cli, "serve", "--port", String(port), "--session", "smksrv", "--mock", "--yes", "--no-dev"],
    { cwd: workDir, stdio: "ignore", detached: true },
  );
  const cleanup = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  try {
    // Wait for the server to be ready.
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const h = await fetch(`${url}/health`);
        up = h.ok;
      } catch {
        up = false;
      }
    }
    assert(up, "serve /health is reachable");

    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    assert(
      health.ok === true && health.session === "smksrv" && typeof health.tools === "number",
      "serve /health reports session + tool count",
    );

    const tools = (await (await fetch(`${url}/tools`)).json()) as Array<{ name: string }>;
    assert(Array.isArray(tools) && tools.some((t) => t.name === "add_todo"), "serve /tools lists backend tools");

    // POST /message runs a (mocked) turn and persists it to the session file.
    const post = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "serve smoke" }),
    });
    assert(post.status === 200, "serve /message accepts a turn");
    const body = (await post.json()) as { ok?: boolean };
    assert(body.ok === true, "serve /message reports ok");

    // Empty text → 400.
    const bad = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert(bad.status === 400, "serve /message rejects empty text with 400");

    // Unknown route → 404.
    const nf = await fetch(`${url}/nope`);
    assert(nf.status === 404, "serve unknown route → 404");

    // attach client: SSE replay of the persisted turn.
    const { attach } = await import("./serve.js");
    const { events } = await attach({ url, minEvents: 5, timeoutMs: 5000 });
    const types = events.map((e) => e.type);
    assert(types.includes("user/message") && types.includes("turn/end"), "attach sees the replayed turn (user/message … turn/end)");
    assert(
      events.some((e) => e.type === "user/message" && (e as { text?: string }).text === "serve smoke"),
      "attach replay carries the posted message text",
    );

    // The turn is persisted in the serve cwd (append-only JSONL).
    const sessionFile = join(workDir, ".aih", "sessions", "smksrv.jsonl");
    assert(existsSync(sessionFile), "serve persists the session to .aih/sessions/<name>.jsonl");
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    assert(lines.length >= 5 && lines.every((l) => l.startsWith("{")), "session file is append-only JSONL");
  } finally {
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
}

{
  // E#18: named agent profiles (--as <name>) — config load + rules + prompt
  const { loadAgentProfile, listAgentProfiles } = await import("./config.js");
  const { RulesetGate, DenyAll } = await import("@aih/core");
  const { mkdtempSync: mkd, writeFileSync: wfs } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: jj } = await import("node:path");
  const profDir = mkd(jj(td(), "aih-profiles-"));
  const prevCwd = process.cwd();
  try {
    wfs(
      jj(profDir, "aih.json"),
      JSON.stringify({
        agents: {
          readonly: {
            prompt: "You are a read-only reviewer.",
            permissions: [{ tool: "write_file", action: "deny" }],
          },
          permissive: { permissions: [{ tool: "run_cmd", action: "allow" }] },
        },
      }),
    );
    process.chdir(profDir);
    const names = listAgentProfiles();
    assert(names.includes("readonly") && names.includes("permissive"), "listAgentProfiles finds configured profiles");
    const ro = loadAgentProfile("readonly");
    assert(!!ro && ro.prompt === "You are a read-only reviewer.", "loadAgentProfile returns prompt");
    assert(!!ro && ro.permissions?.length === 1 && ro.permissions[0].action === "deny", "loadAgentProfile returns permissions");
    assert(loadAgentProfile("nope") === undefined, "unknown profile is undefined");
    // profile rules applied on top of base: write_file denied, run_cmd still ask->base
    const gate = new RulesetGate(new DenyAll(), [
      { tool: "todo", pattern: "*", action: "allow" },
      ...(ro?.permissions ?? []),
    ]);
    assert(gate.evaluate({ tool: "todo", kind: "write", args: {} }) === "allow", "base allow rule still applies");
    assert(gate.evaluate({ tool: "write_file", kind: "write", args: { path: "/x" } }) === "deny", "profile deny rule applies");
    assert(gate.evaluate({ tool: "run_cmd", kind: "write", args: { command: "ls" } }) === undefined, "unmatched tool falls through to base gate");
  } finally {
    process.chdir(prevCwd);
    rmSync(profDir, { recursive: true, force: true });
  }
}

// --- D#13: background jobs (board bookkeeping + spawn lifecycle) -----------
{
  const { loadBoard, saveBoard, summarize, spawnJob, cancelJob, jobById, jobsFile } = await import("./jobs.js");
  const jobdir = mkdtempSync("/tmp/aih-jobs-");
  // pure bookkeeping
  assert(loadBoard(jobdir).jobs.length === 0, "empty board when no jobs file");
  const board = { jobs: [
    { id: "a", label: "a", prompt: "a", status: "running" as const, session: "a", out: "/x", createdAt: 1, startedAt: 1 },
    { id: "b", label: "b", prompt: "b", status: "done" as const, session: "b", out: "/x", createdAt: 1, startedAt: 1, finishedAt: 2 },
    { id: "c", label: "c", prompt: "c", status: "failed" as const, session: "c", out: "/x", createdAt: 1, startedAt: 1, finishedAt: 2 },
  ] };
  saveBoard(jobdir, board);
  assert(existsSync(jobsFile(jobdir)), "saveBoard writes .aih/jobs.json");
  const s = summarize(loadBoard(jobdir));
  assert(s.running === 1 && s.done === 1 && s.failed === 1, "summarize counts running/done/failed");
  assert(jobById(jobdir, "b")?.status === "done", "jobById finds a job");
  assert(cancelJob(jobdir, "a") === true, "cancelJob marks a running job cancelled");
  assert(jobById(jobdir, "a")?.status === "cancelled", "cancelled job persisted");
  assert(cancelJob(jobdir, "b") === false, "cancelJob refuses a finished job");
  // spawn lifecycle: a fake CLI that prints an answer and exits 0
  const fakeCli = `${jobdir}/fake.mjs`;
  writeFileSync(fakeCli, `process.stdout.write("bg answer line\\n"); process.exit(0);\n`);
  const { job, child } = spawnJob(jobdir, "do a thing in the background", { cli: fakeCli });
  assert(job.status === "running" && job.id.startsWith("bg-"), "spawnJob creates a running job");
  assert(jobById(jobdir, job.id)?.status === "running", "spawned job is on the board");
  const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
  assert(code === 0, "background child exits 0");
  const finished = jobById(jobdir, job.id);
  assert(finished?.status === "done" && finished?.exitCode === 0, "job marked done with exit 0");
  assert(finished?.preview === "bg answer line", "job preview captures the last output line");
  assert(existsSync(finished!.out) && readFileSync(finished!.out, "utf8").includes("bg answer line"), "job output captured to file");
  // failing child → failed
  const fakeFail = `${jobdir}/fail.mjs`;
  writeFileSync(fakeFail, `process.stderr.write("boom\\n"); process.exit(3);\n`);
  const f2 = spawnJob(jobdir, "will fail", { cli: fakeFail });
  await new Promise((res) => f2.child.on("close", () => res(null)));
  assert(jobById(jobdir, f2.job.id)?.status === "failed", "failing child marks job failed");
  rmSync(jobdir, { recursive: true, force: true });
}

// --- E#17: memory auto-tidy (deterministic dedup) ---------------------------
{
  const { tidyMemory, formatTidyReport, parseMemoryEntries, normEntry } = await import("./memory-tidy.js");
  // no entries → no change
  const empty = tidyMemory("# Project memory\n\n(no bullets here)\n");
  assert(empty.noChange && empty.total === 0, "tidyMemory: no bullets → noChange");
  // exact duplicates → keep one, drop the rest
  const dup = tidyMemory(
    "# Project memory\n\n- 2026-01-01 — use tabs not spaces\n- 2026-02-02 — use tabs not spaces\n- 2026-03-03 — other fact\n",
  );
  assert(dup.total === 3 && dup.kept === 2 && dup.removed.length === 1, "tidyMemory: 3 entries, 2 kept, 1 dup removed");
  assert(!dup.cleaned.includes("2026-01-01") && dup.cleaned.includes("2026-02-02"), "tidyMemory: keeps the most recent dated copy");
  assert(dup.cleaned.includes("other fact"), "tidyMemory: preserves non-duplicate entries");
  // near-duplicate (punctuation/whitespace) still dedups
  const near = tidyMemory("- use tabs, not spaces\n- use  tabs, not  spaces\n");
  assert(near.kept === 1 && near.removed.length === 1, "tidyMemory: whitespace/punctuation variants dedupe");
  // no dates → later in file wins
  const undated = tidyMemory("- fact A\n- fact A\n");
  assert(undated.kept === 1 && undated.removed.length === 1, "tidyMemory: undated dup keeps later copy");
  // report formatting
  assert(formatTidyReport(dup).includes("2 kept") && formatTidyReport(dup).includes("1 duplicate"), "formatTidyReport summarizes kept/removed");
  assert(formatTidyReport(empty).includes("already tidy"), "formatTidyReport reports tidy");
  // parse + norm helpers
  assert(parseMemoryEntries("- a\n- b\nnot a bullet\n").length === 2, "parseMemoryEntries counts bullets only");
  assert(normEntry("2026-01-01 — Use Tabs") === normEntry("use tabs"), "normEntry strips date + case/punct");
}

// --- P1#4: BM25 relevance scoring -------------------------------------------
{
  const { tokenize, buildIndex, search, rank } = await import("./bm25.js");
  // tokenizer: ascii words + CJK bigrams (segmenter-free CJK IR)
  const toks = tokenize("Batch Ops 批量操作 plan-execute-verify");
  assert(toks.includes("batch") && toks.includes("ops"), "tokenize keeps ascii words");
  assert(toks.includes("批量") && toks.includes("操作") && !toks.includes("批量操作"), "tokenize expands CJK runs into bigrams");
  assert(tokenize("中").length === 1 && tokenize("中") [0] === "中", "tokenize keeps a lone CJK char");
  assert(tokenize("  ").length === 0, "tokenize of whitespace is empty");
  // rank: relevant doc beats unrelated, topK caps, empty query → no hits
  const docs = [
    { id: "batch-ops", text: "batch operations bulk create update remove plan execute verify" },
    { id: "app-tour", text: "explore connected app tools capability tour" },
    { id: "session-report", text: "turn current session history into structured report" },
  ];
  const hits = rank(docs, "bulk batch operations", 3);
  assert(hits.length > 0 && hits[0].id === "batch-ops", "rank: batch-ops tops a bulk-operations query");
  assert(hits.every((h) => h.score > 0), "rank: only positive-score hits returned");
  assert(rank(docs, "bulk batch operations", 2).length <= 2, "rank: topK caps results");
  assert(search(buildIndex(docs), "   ").length === 0, "search: blank query → no hits");
  assert(rank(docs, "zzz qqq xyz").length === 0, "rank: no-match query → no hits");
  // CJK query matches CJK text
  const cjk = rank(
    [
      { id: "cn", text: "中文技能：批量操作与验证" },
      { id: "en", text: "english only skill" },
    ],
    "批量操作",
  );
  assert(cjk.length > 0 && cjk[0].id === "cn", "rank: CJK query ranks the CJK doc first");
}

// --- P1#4: suggestSkills (BM25 over installed skills) ------------------------
{
  const { suggestSkills, discoverSkills } = await import("./skills.js");
  const skills = discoverSkills();
  const hits = suggestSkills("bulk batch operations on app data", skills, 3);
  assert(hits.length > 0 && hits[0].skill.name === "batch-ops", "suggestSkills: batch-ops tops a bulk-ops query");
  assert(hits[0].score > 0, "suggestSkills: scores are positive");
  assert(suggestSkills("   ", skills).length === 0, "suggestSkills: blank query → none");
  assert(suggestSkills("zzz qqq xyz", skills).length === 0, "suggestSkills: no match → none");
  // explicit skill list (deterministic, no filesystem)
  const custom = [
    { name: "deploy", description: "deploy release publish to production", scope: "project" as const, body: "" },
    { name: "tour", description: "explore tools capability tour", scope: "project" as const, body: "" },
  ];
  const ch = suggestSkills("release deploy to production", custom, 2);
  assert(ch.length > 0 && ch[0].skill.name === "deploy", "suggestSkills: explicit list ranks deploy first");
}

// --- D#11: skill-driven hook config (secretPatterns front matter) -----------
{
  const { parseSkillMd, skillSecretPatterns } = await import("./skills.js");
  const parsed = parseSkillMd(
    "---\nname: acme\ndescription: acme ops\nsecretPatterns: acme_[A-Z0-9]{16,}; zzz_[0-9]{8,}\n---\n# body\n",
    "fallback",
  );
  assert(parsed.name === "acme", "parseSkillMd reads name");
  assert(Array.isArray(parsed.secretPatterns) && parsed.secretPatterns.length === 2, "parseSkillMd parses secretPatterns list");
  assert(parsed.secretPatterns![0] === "acme_[A-Z0-9]{16,}" && parsed.secretPatterns![1] === "zzz_[0-9]{8,}", "parseSkillMd splits semicolon-separated patterns (keeps {n,} quantifiers intact)");
  // no secretPatterns → undefined
  const plain = parseSkillMd("---\nname: x\ndescription: d\n---\nbody\n", "fb");
  assert(plain.secretPatterns === undefined, "parseSkillMd: absent secretPatterns → undefined");
  // skillSecretPatterns unions across skills (deduped)
  const skills = [
    { name: "a", description: "", scope: "project" as const, body: "", secretPatterns: ["p1", "p2"] },
    { name: "b", description: "", scope: "project" as const, body: "", secretPatterns: ["p2", "p3"] },
    { name: "c", description: "", scope: "builtin" as const, body: "" },
  ];
  const union = skillSecretPatterns(skills);
  assert(union.length === 3 && union.includes("p1") && union.includes("p2") && union.includes("p3"), "skillSecretPatterns unions + dedupes");
  assert(skillSecretPatterns([{ name: "c", description: "", scope: "builtin" as const, body: "" }]).length === 0, "skillSecretPatterns: none declared → empty");
}

// --- F#30: streaming TPS (per-request generation time) ------------------------
{
  const { streamingTps } = await import("./cost.js");
  const mk = (completion: number, genMs: number): SessionEvent =>
    ({
      seq: 1,
      ts: Date.now(),
      type: "turn/end",
      turnId: "t",
      stopReason: "end_turn",
      usage: { promptTokens: 10, completionTokens: completion, totalTokens: 10 + completion },
      genMs,
    }) as SessionEvent;
  // 100 completion tokens over 2s of generation → 50 tok/s
  const evts = [mk(60, 1000), mk(40, 1000)];
  const stps = streamingTps(evts);
  assert(Math.abs(stps - 50) < 1e-9, "streamingTps: completion tokens / gen time");
  // no genMs (mock / non-streaming) → 0
  const noGen = [{ seq: 1, ts: Date.now(), type: "turn/end", turnId: "t", stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 5, totalTokens: 6 } }] as SessionEvent[];
  assert(streamingTps(noGen) === 0, "streamingTps: 0 without genMs");
  assert(streamingTps([]) === 0, "streamingTps: 0 with no events");
}

// --- D#15: Agent Teams (roster + task board + mailbox) ---
{
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    addAgent,
    addTask,
    claimTask,
    dispatchTask,
    loadTeam,
    readMail,
    resolveTask,
    sendMail,
    setTaskStatus,
    summarizeTeam,
  } = await import("./teams.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "aih-team-"));
  try {
    // roster
    addAgent(dir, "scout", "research", "You are a careful researcher.");
    addAgent(dir, "builder");
    let state = loadTeam(dir);
    assert(state.agents.length === 2, "team: two agents in roster");
    assert(state.agents[0].role === "research" && Boolean(state.agents[0].prompt), "team: role + prompt recorded");
    // re-adding the same name updates, does not duplicate
    addAgent(dir, "scout", "research+build");
    state = loadTeam(dir);
    assert(state.agents.length === 2, "team: add-agent is upsert, not duplicate");
    assert(state.agents[0].role === "research+build", "team: upsert updates role");
    // invalid names rejected
    let threw = false;
    try { addAgent(dir, "bad name"); } catch { threw = true; }
    assert(threw, "team: agent name with whitespace rejected");

    // task board
    const t1 = addTask(dir, "write the report", "draft v1 of the quarterly report");
    const t2 = addTask(dir, "review the report");
    state = loadTeam(dir);
    assert(state.tasks.length === 2, "team: two tasks on the board");
    assert(state.tasks.every((t) => t.status === "todo"), "team: new tasks start todo");
    // claim
    claimTask(dir, t1.id, "scout");
    state = loadTeam(dir);
    assert(state.tasks[0].status === "claimed" && state.tasks[0].assignee === "scout", "team: claim sets status+assignee");
    // double-claim rejected
    threw = false;
    try { claimTask(dir, t1.id, "builder"); } catch { threw = true; }
    assert(threw, "team: claiming a claimed task throws");
    // prefix resolution (drop the last 2 chars of the random tail; the seq
    // counter keeps same-millisecond ids distinct, so the prefix is unique)
    const byPrefix = resolveTask(dir, t2.id.slice(0, -2));
    assert(byPrefix?.id === t2.id, "team: resolveTask by unique prefix");
    // status transitions
    setTaskStatus(dir, t1.id, "done", "report shipped");
    state = loadTeam(dir);
    assert(state.tasks[0].status === "done" && state.tasks[0].preview === "report shipped", "team: done + preview recorded");
    setTaskStatus(dir, t2.id, "cancelled");
    // summary
    const s = summarizeTeam(loadTeam(dir));
    assert(s.agents === 2 && s.done === 1 && s.todo === 0, "team: summarizeTeam counts");

    // mailbox
    sendMail(dir, "scout", "builder", "report is ready for review");
    sendMail(dir, "builder", "scout", "looks good, ship it");
    const inbox = readMail(dir, "builder");
    assert(inbox.length === 1 && inbox[0].from === "scout", "team: mailbox delivers to the right inbox");
    assert(readMail(dir, "scout").length === 1, "team: each agent has its own inbox");
    assert(readMail(dir, "nobody").length === 0, "team: empty inbox for unknown agent");

    // dispatch: claim (idempotent) + spawn a child that echoes the prompt.
    // We point the CLI at a tiny node script that prints its args so no LLM
    // is needed and the job finishes fast.
    const t3 = addTask(dir, "echo task", "say hello from the team");
    const fakeCli = path.join(dir, "fake-cli.mjs");
    writeFileSync(fakeCli, `import process from "node:process";\nconsole.log("ARGS " + process.argv.slice(2).join(" ").slice(0, 200));\n`);
    const { job, child, task } = dispatchTask(dir, t3.id, "builder", { cli: fakeCli });
    assert(task.status === "claimed" && task.assignee === "builder", "team: dispatch claims the task");
    assert(job.status === "running", "team: dispatch creates a running job");
    await new Promise<void>((res) => child.on("close", () => res()));
    const after = resolveTask(dir, t3.id);
    assert(Boolean(after?.session) && Boolean(after?.out), "team: dispatch records session + output path on the task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- T#22: /find — search across tool outputs ---
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  tui.pushTool("run_cmd", { command: "npm test" }, "c1");
  tui.resolveTool("c1", true, { stdout: "line one\nECONNREFUSED 127.0.0.1:5432\nall green" });
  tui.pushTool("run_cmd", { command: "ls" }, "c2");
  tui.resolveTool("c2", true, { stdout: "a.txt\nb.txt" });
  tui.push({ role: "assistant", text: "the tests failed with a connection error" });
  // no match
  let r = tui.searchTools("zzz-not-present");
  assert(r.n === 0, "/find: no match → n=0");
  // match (case-insensitive)
  r = tui.searchTools("econnrefused");
  assert(r.n === 1, "/find: one line matches");
  assert(r.matches[0].tool === "run_cmd" && r.matches[0].line === 2, "/find: match points at the right tool + line");
  assert(r.matches[0].snippet.includes("ECONNREFUSED"), "/find: snippet carries the matched line");
  // the matched tool is now expanded so the match is visible
  const t1 = tui.transcriptLines().join("\n");
  assert(t1.includes("ECONNREFUSED"), "/find: matched tool output is expanded in the transcript");
  // empty query is a no-op
  assert(tui.searchTools("   ").n === 0, "/find: blank query → no matches");
}

console.log("\nAIH cli smoke test passed.");

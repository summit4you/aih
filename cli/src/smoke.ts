import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function aih(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
    _diff: [{ t: "del", s: "old line" }, { t: "add", s: "new line" }],
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
  const diffLine = raw.find((l) => l.includes("48;5;237") && l.includes("48;5;233"));
  assert(!!diffLine, "edit diff renders side-by-side (red del cell + green add cell)");
  const diffBody = diffLine!.replace(/\x1b\[[0-9;]*m/g, "");
  assert(diffBody.includes("old line") && diffBody.includes("new line"), "diff shows original left, modified right");
  assert(diffBody.indexOf("old line") < diffBody.indexOf("new line"), "removed side is left, added side is right");
  assert(diffBody.includes("┃") === false, "diff cells have no border");
  assert(body.every((l) => l.length <= 80), "tool rows fit the full history width (80 cols)");
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

console.log("\nAIH cli smoke test passed.");

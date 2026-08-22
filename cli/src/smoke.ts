import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

const noKey = aih(["run", "hi"], { AIH_API_KEY: "", AIH_MODEL: "" });
assert(noKey.status === 1 && noKey.stderr.includes("no API key"), "missing API key fails fast with hint");

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

rmSync(".aih/sessions", { recursive: true, force: true });

const config = aih(["config"], { AIH_MODEL: "deepseek-v4-flash" });
assert(config.status === 0, "config command runs");
const configJson = JSON.parse(config.stdout);
assert(
  configJson.model.value === "deepseek-v4-flash" && configJson.model.source === "env AIH_MODEL",
  "config reports model source",
);

const models = aih(["models"], { AIH_MODEL: "deepseek-v4-flash" });
assert(
  models.status === 0 && models.stdout.includes("deepseek-v4-flash"),
  "models lists configured model",
);

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
  assert(
    !planRegistry.schemas().some((s) => s.name === "edit" || s.name === "apply_patch"),
    "plan mode hides write-kind general tools",
  );
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

console.log("\nAIH cli smoke test passed.");

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TodoAppAdapter } from "./app-adapter.js";

const serverEntry = fileURLToPath(new URL("./index.js", import.meta.url));

let child: ReturnType<typeof spawn>;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    child?.kill();
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

function send(msg: unknown): void {
  child.stdin!.write(`${JSON.stringify(msg)}\n`);
}

function request(id: number, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
    const rl = createInterface({ input: child.stdout! });
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed.id === id) {
        clearTimeout(timer);
        rl.close();
        resolve(parsed);
      }
    };
    rl.on("line", onLine);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function callTool(id: number, name: string, args: unknown): Promise<any> {
  const res = await request(id, "tools/call", { name, arguments: args });
  const text = res?.result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return res?.result;
  }
}

async function main(): Promise<void> {
  child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr!.on("data", (d) => process.stderr.write(`[server] ${d}`));

  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "aih-smoke", version: "0.0.1" },
  });
  assert(!!init.result?.serverInfo?.name, `initialized with server "${init.result?.serverInfo?.name}"`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request(2, "tools/list");
  const names: string[] = list.result.tools.map((t: any) => t.name);
  for (const expected of ["app_describe", "app_context", "add_todo", "toggle_todo", "remove_todo", "list_todos"]) {
    assert(names.includes(expected), `tool "${expected}" exposed`);
  }

  const add = await callTool(3, "add_todo", { text: "hello aih" });
  assert(
    JSON.stringify(add).includes("hello aih"),
    "add_todo executed and returned the new item",
  );

  const ctx = await callTool(4, "app_context", { query: "stats" });
  assert(
    ctx?.total === 1,
    "app_context reflects app state",
  );

  const describe = await callTool(5, "app_describe", {});
  assert(
    JSON.stringify(describe).includes("permission"),
    "app_describe self-describes permissions",
  );

  child.kill();
  console.log("\nAIH mcp-server smoke test passed.");

  const storePath = join(tmpdir(), `aih-todo-${Date.now()}.json`);
  const writer = new TodoAppAdapter(storePath);
  await writer.actions.add_todo.run({ text: "persist-me" });
  const reader = new TodoAppAdapter(storePath);
  const stats = (await reader.context("stats")) as { total: number };
  assert(stats.total === 1, "todo store persists across adapter instances");
  rmSync(storePath, { force: true });

  process.exit(0);
}

main().catch((err) => {
  child?.kill();
  console.error(err);
  process.exit(1);
});

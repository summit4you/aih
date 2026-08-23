import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ToolRegistry } from "@aih/core";
import { lineDiff } from "./diff.js";
import { buildChildEnv } from "./env-policy.js";

const MAX_READ = 64 * 1024;
const MAX_OUT = 32 * 1024;
const CMD_TIMEOUT_DEFAULT_MS = Number(process.env.AIH_CMD_TIMEOUT_MS ?? "") || 120_000;
const CMD_TIMEOUT_MAX_MS = 600_000;

function safePath(cwd: string, p: string | undefined): string {
  const target = resolve(cwd, p ?? ".");
  return target;
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
      writeFileSync(file, content);
      return { path: file, bytes: Buffer.byteLength(content), new_file: previous === "", _diff: lineDiff(previous, content) };
    },
  });

  registry.register({
    name: "run_cmd",
    description:
      `Run a shell command in the workspace; returns merged stdout+stderr. Timeout default ${Math.round(CMD_TIMEOUT_DEFAULT_MS / 1000)}s ` +
      "(pass timeout_ms up to 600s for installs). Backgrounded children (cmd &) keep running after return.",
    kind: "write",
    permission: "ask",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "command to run via sh -c" },
        cwd: { type: "string", description: "working directory" },
        timeout_ms: { type: "number", description: `timeout in ms (default ${CMD_TIMEOUT_DEFAULT_MS}, max ${CMD_TIMEOUT_MAX_MS})` },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const a = args as { command?: unknown; cwd?: unknown; timeout_ms?: unknown };
      const dir = safePath(cwd, String(a.cwd ?? "."));
      const timeoutMs = Math.min(
        CMD_TIMEOUT_MAX_MS,
        Math.max(1000, Number(a.timeout_ms ?? CMD_TIMEOUT_DEFAULT_MS) || CMD_TIMEOUT_DEFAULT_MS),
      );
      const logPath = join(tmpdir(), `aih-cmd-${randomUUID()}.log`);
      const fd = openSync(logPath, "w");
      let code = 1;
      let killed = false;
      try {
        code = await new Promise<number>((res) => {
          const child = spawn("/bin/sh", ["-c", String(a.command)], {
            cwd: dir,
            env: buildChildEnv(),
            stdio: ["ignore", fd, fd],
          });
          const timer = setTimeout(() => {
            killed = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, timeoutMs);
          child.on("error", () => {
            clearTimeout(timer);
            res(127);
          });
          child.on("close", (c) => {
            clearTimeout(timer);
            res(c ?? 1);
          });
        });
      } finally {
        closeSync(fd);
      }
      let output = "";
      try {
        output = readFileSync(logPath, "utf8");
      } catch {
        output = "";
      }
      try {
      unlinkSync(logPath);
    } catch {
      /* already gone */
    }
      const capped = output.length > MAX_OUT;
      return {
        code: killed ? 124 : code,
        timed_out: killed,
        stdout: output.slice(0, MAX_OUT),
        stderr: "",
        truncated: capped,
      };
    },
  });
}

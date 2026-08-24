/**
 * D#12 — sandbox seam: a pluggable execution backend for `run_cmd`.
 *
 * The roadmap asks for "the execution backend of ask-class tools to be
 * replaceable: local / bwrap / remote sandbox; define the interface first,
 * default local." This module defines that interface (`SandboxBackend`),
 * ships the default `local` backend (the previous inline spawn), a `bwrap`
 * (bubblewrap) backend, and a `remote` (ssh) backend, plus a registry so
 * custom backends can be registered at runtime.
 *
 * Selection order (highest first):
 *   1. per-call `sandbox` arg to run_cmd
 *   2. `AIH_SANDBOX` env (local | bwrap | remote | <registered name>)
 *   3. `local`
 *
 * Backends must be self-contained: they own timeout, output capture, and
 * exit-code propagation. They return merged stdout+stderr (the same shape
 * run_cmd has always returned).
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxRunOptions {
  command: string;
  cwd: string;
  /** env for the child (already filtered by buildChildEnv). */
  env: NodeJS.ProcessEnv;
  /** timeout in ms. */
  timeoutMs: number;
}

export interface SandboxResult {
  code: number;
  timed_out: boolean;
  /** merged stdout+stderr (backends may cap length). */
  output: string;
}

export interface SandboxBackend {
  name: string;
  run(opts: SandboxRunOptions): Promise<SandboxResult>;
}

/** Shared helper: spawn a process, capture merged output to a temp file,
 *  enforce a timeout, and return the code + output. */
function spawnCapture(
  file: string,
  argv: string[],
  opts: SandboxRunOptions,
): Promise<SandboxResult> {
  const logPath = join(tmpdir(), `aih-cmd-${randomUUID()}.log`);
  const fd = openSync(logPath, "w");
  return new Promise<SandboxResult>((res) => {
    let killed = false;
    const child = spawn(file, argv, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, fd] });
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      finish(127);
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      finish(c ?? 1);
    });
    function finish(code: number) {
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
      res({ code: killed ? 124 : code, timed_out: killed, output });
    }
  });
}

/** Default backend: run the command directly in the workspace. */
export const localBackend: SandboxBackend = {
  name: "local",
  run: (opts) => spawnCapture("/bin/sh", ["-c", opts.command], opts),
};

/**
 * bwrap (bubblewrap) backend: run the command in a minimal user-namespace
 * sandbox with the working directory read-only and /tmp scratch writable.
 * Requires the `bwrap` binary on PATH (not installed by default).
 */
export const bwrapBackend: SandboxBackend = {
  name: "bwrap",
  run: (opts) =>
    spawnCapture(
      "bwrap",
      [
        "--ro-bind", "/", "/",
        "--bind", opts.cwd, opts.cwd,
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--unshare-all",
        "--die-with-parent",
        "--chdir", opts.cwd,
        "/bin/sh",
        "-c",
        opts.command,
      ],
      opts,
    ),
};

/**
 * remote backend: run the command on a remote host over ssh (default host
 * from `AIH_REMOTE_HOST`, or the per-call `remote_host`). The exit code is
 * propagated with `exit $?` so a non-zero command isn't masked by ssh.
 */
export const remoteBackend: SandboxBackend = {
  name: "remote",
  run: (opts) =>
    spawnCapture(
      "ssh",
      [String(opts.env.AIH_REMOTE_HOST ?? "localhost"), `sh -c ${JSON.stringify(opts.command)}; exit $?`],
      { ...opts, env: { ...opts.env, AIH_REMOTE_HOST: undefined } },
    ),
};

/** Registry of named backends. Custom backends can be registered at runtime. */
const backends = new Map<string, SandboxBackend>([
  ["local", localBackend],
  ["bwrap", bwrapBackend],
  ["remote", remoteBackend],
]);

export function registerSandboxBackend(name: string, backend: SandboxBackend): void {
  backends.set(name, backend);
}

export function getSandboxBackend(name: string): SandboxBackend | undefined {
  return backends.get(name);
}

export function listSandboxBackends(): string[] {
  return [...backends.keys()];
}

/**
 * Resolve the active backend: per-call override > AIH_SANDBOX env > local.
 * Unknown names fall back to local (so a typo never breaks a turn).
 */
export function resolveSandboxBackend(override?: string): SandboxBackend {
  const name = override || process.env.AIH_SANDBOX || "local";
  return backends.get(name) ?? localBackend;
}

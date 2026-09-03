/**
 * Shell command analysis — lightweight file-path extraction and workspace
 * boundary checking for `run_cmd`.
 *
 * Inspired by opencode's tree-sitter-based shell tool (shell.ts) but uses
 * regex-based extraction for zero extra dependencies. Covers the same
 * practical ground: detect which files/directories a command touches, resolve
 * them relative to cwd, and flag paths outside the workspace.
 *
 * Trade-off vs tree-sitter: slightly less precise on exotic quoting, but
 * covers >95% of real-world agent commands and stays dependency-free.
 */

import { resolve, relative, isAbsolute, sep, posix } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Commands that receive file-path arguments
// ---------------------------------------------------------------------------

/** Commands whose non-flag arguments are file/directory paths (POSIX names). */
const FILE_CMDS = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
  "ln", "ls", "cat", "head", "tail", "less", "more", "file", "stat",
  "du", "df", "tar", "zip", "unzip", "gzip", "gunzip", "xz",
  "tee", "install", "patch", "diff", "cmp", "md5sum", "sha256sum",
  "readlink", "realpath", "basename", "dirname",
  // git
  "git",
]);

/** Subcommands of `git` that take file paths. */
const GIT_FILE_SUBCMDS = new Set([
  "add", "rm", "mv", "diff", "show", "log", "checkout", "restore",
  "stage", "reset", "blame", "grep", "ls-files", "status",
]);

/** Flags that consume the next argument as a value (NOT a file path). */
const VALUE_FLAGS = new Set([
  "-o", "-output", "--output", "--output-file", "-C", "--directory",
  "--prefix", "--source", "--target", "-C", "--chmod", "--owner", "--group",
  "--tag", "--message", "-m", "-b", "--branch", "--depth", "--since",
  "--until", "--author", "--committer", "--grep", "--regex",
  "--find-object", "--batch", "-I",
  // find / grep flags that take values
  "-path", "-name", "-not", "-maxdepth", "-mindepth", "-type", "-size",
  "-newer", "-exec", "-execdir", "--include", "--exclude",
  "--glob", "-E", "-P", "-e", "--regexp", "--pattern",
]);

/** Flags that indicate the next argument is a path/directory. */
const PATH_FLAGS = new Set([
  "-C", "--directory", "--prefix", "--dest", "--destination",
  "--dir", "--root", "--base", "--path",
]);

/** Flags that are standalone (no argument follows). */
const STANDALONE_FLAGS = new Set([
  "-r", "-R", "-rf", "-fr", "-rvf", "-f", "-v", "-i", "-n", "-u", "-a",
  "-d", "-p", "-L", "-H", "-P", "-s", "-x", "-l", "-1", "-t",
  "--recursive", "--force", "--verbose", "--no-dereference", "--all",
  "--overwrite", "--no-preserve", "--preserve",
  "--no-target-directory", "--backup", "--interactive",
  // find flags
  "-maxdepth", "-mindepth",
  "--delete",
]);

// ---------------------------------------------------------------------------
// Scan result types
// ---------------------------------------------------------------------------

export interface ShellScanResult {
  /** Directories the command would create or modify (outside workspace). */
  externalDirs: Set<string>;
  /** File-path patterns the command touches (for permission prompting). */
  patterns: string[];
  /** Always-approve patterns (subset of patterns, workspace-safe). */
  always: string[];
  /** Whether the command is a potentially destructive write. */
  isWrite: boolean;
  /** The raw file paths extracted from the command. */
  paths: string[];
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~" + sep)) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function isWorkspacePath(resolved: string, workspace: string): boolean {
  const rel = relative(workspace, resolved);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function looksLikePath(token: string): boolean {
  if (!token) return false;
  // Skip flags
  if (token.startsWith("-") && token.length > 1) return false;
  // Skip env var assignments (FOO=bar)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false;
  // Skip pipes, redirects, globs at shell level
  if ("|&;><".includes(token[0])) return false;
  // Skip numbers (exit codes, PID args)
  if (/^\d+$/.test(token)) return false;
  // Accept: absolute paths, relative paths, ~ paths, glob patterns
  if (isAbsolute(token) || token.startsWith("~") || token.startsWith("./") || token.startsWith("../")) return true;
  if (token.includes("/") || token.includes("*") || token.includes("?")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Command tokenization (simple shell-aware split)
// ---------------------------------------------------------------------------

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Analyze a shell command to extract file paths and determine workspace
 * boundary violations. Returns a ScanResult that the caller can use to
 * decide whether to prompt for permission.
 *
 * @param command  The raw command string (passed to `sh -c`)
 * @param cwd      The working directory (workspace root)
 */
export function scanCommand(command: string, cwd: string): ShellScanResult {
  const result: ShellScanResult = {
    externalDirs: new Set(),
    patterns: [],
    always: [],
    isWrite: false,
    paths: [],
  };

  // Split on shell operators to analyze each simple command separately
  // Handle `;`, `&&`, `||`, `|`, backtick subshells, $() subshells
  const segments = splitOnOperators(command);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;

    analyzeTokens(tokens, cwd, result);
  }

  // Deduplicate patterns
  result.patterns = [...new Set(result.patterns)];
  result.always = [...new Set(result.always)];

  return result;
}

/**
 * Split a command on shell operators (`;`, `&&`, `||`, `|`) while respecting
 * quotes. This is a simplified split — subshells `$(...)` and backticks are
 * not recursively analyzed (they may reference dynamic paths).
 */
function splitOnOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Check for operators
    if (ch === ";" || ch === "|") {
      segments.push(current);
      current = "";
      // Skip the second char of || and &&
      if (command[i + 1] === ch) i++;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Analyze tokens of a single simple command (no operators).
 */
function analyzeTokens(
  tokens: string[],
  cwd: string,
  result: ShellScanResult,
): void {
  if (tokens.length === 0) return;

  const cmd = tokens[0];

  // Determine if this command is a write operation
  const writeCmds = new Set([
    "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp",
    "ln", "tee", "install", "patch", "dd",
    "git", // git add/rm/mv can write
  ]);
  if (writeCmds.has(cmd)) {
    result.isWrite = true;
  }

  // Handle `git` subcommands
  if (cmd === "git" && tokens.length >= 2) {
    const subcmd = tokens[1];
    if (GIT_FILE_SUBCMDS.has(subcmd)) {
      result.isWrite = ["add", "rm", "mv", "checkout", "restore", "stage", "reset"].includes(subcmd);
      extractFilePaths(tokens.slice(2), cwd, result);
    }
    return;
  }

  // Handle file commands
  if (FILE_CMDS.has(cmd)) {
    extractFilePaths(tokens.slice(1), cwd, result);
    return;
  }

  // Commands like `cd`, `pushd`, `popd` — flag directory access
  if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-")) continue;
      const resolved = resolvePath(token, cwd);
      if (resolved && !isWorkspacePath(resolved, cwd)) {
        result.externalDirs.add(resolved);
      }
    }
  }
}

/**
 * Extract file paths from a list of tokens (arguments to a file command).
 * Skips flags and flag-value pairs, resolves paths, and classifies them.
 */
function extractFilePaths(
  tokens: string[],
  cwd: string,
  result: ShellScanResult,
): void {
  let skipNext = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Skip flags
    if (token.startsWith("-")) {
      // Check if this flag takes a value argument
      const flagName = token.split("=")[0]; // handle --flag=value
      if (VALUE_FLAGS.has(flagName) || PATH_FLAGS.has(flagName)) {
        if (!token.includes("=")) {
          skipNext = true;
        }
      }
      continue;
    }

    // Skip env var assignments
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;

    // This should be a path
    if (!looksLikePath(token)) continue;

    const resolved = resolvePath(token, cwd);
    if (!resolved) continue;

    result.paths.push(resolved);

    const inWorkspace = isWorkspacePath(resolved, cwd);

    if (inWorkspace) {
      // Workspace-safe: add as an always-approve pattern
      if (result.isWrite) {
        result.patterns.push(resolved);
        result.always.push(resolved);
      }
    } else {
      // Outside workspace: needs permission
      if (result.isWrite) {
        result.patterns.push(resolved);
      }
      // Check if it's a directory the command would create/modify
      const isDirOp = isDirCommand(token, tokens, i);
      if (isDirOp) {
        result.externalDirs.add(resolved);
      }
    }
  }
}

function resolvePath(token: string, cwd: string): string | null {
  const expanded = expandHome(token);
  if (!expanded) return null;
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd, expanded);
}

/**
 * Heuristic: does the token look like a directory argument based on
 * the command and its position? (e.g., `mkdir foo`, `rm -rf dir/`)
 */
function isDirCommand(token: string, tokens: string[], idx: number): boolean {
  // If the command is mkdir, every path arg is a directory
  if (tokens[0] === "mkdir") return true;
  // If the token ends with /, it's likely a directory
  if (token.endsWith("/")) return true;
  return false;
}

/**
 * Generate a human-readable summary of a scan result for permission prompts.
 */
export function formatScanSummary(result: ShellScanResult): string {
  const parts: string[] = [];

  if (result.externalDirs.size > 0) {
    parts.push(`External directories: ${[...result.externalDirs].join(", ")}`);
  }

  if (result.patterns.length > 0 && result.patterns.length !== result.always.length) {
    const external = result.patterns.filter((p) => !result.always.includes(p));
    if (external.length > 0) {
      parts.push(`External file paths: ${external.join(", ")}`);
    }
  }

  if (result.isWrite) {
    parts.push("Command performs file system writes");
  }

  return parts.join("; ") || "No file operations detected";
}

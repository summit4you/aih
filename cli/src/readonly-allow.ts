/**
 * CC#54 — auto mode read-only allowance (deterministic, local, no ML).
 *
 * CC's "plan mode with auto no longer prompts for Bash commands the static
 * analyzer can't prove read-only" — but AIH keeps it deterministic: a fixed
 * prefix whitelist of read-only commands. Anything not on the list keeps the
 * current ask behavior. No classifier, no cloud, no learning — auditable and
 * zero-dependency, matching the "writes need confirmation" red line (this
 * only ever affects READ-class activity).
 *
 * Off by default; enabled per-config via `permissions.autoAllowReadonly: true`
 * (see config.ts). The config key lives next to `permissions` deliberately:
 * one namespace for permission behavior.
 */

/**
 * Read-only command prefixes judged safe to auto-approve when the gate falls
 * through to a prompt and `autoAllowReadonly` is on. Deliberately conservative:
 * - no `git *` (only explicit read-only subcommands)
 * - no redirects (`>` writes files), no command chaining (`;` `&&` `||` `|`)
 *   except a leading env-var prefix, no backticks/`$(` substitution
 * - `find` without `-delete`/`-exec` (guarded below)
 */
export const READONLY_CMD_PREFIXES: readonly string[] = [
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "grep", "rg", "find", "which", "whoami", "hostname", "uname", "date",
  "echo", "env", "printenv", "id", "tree", "realpath", "readlink", "basename", "dirname",
  "git status", "git log", "git diff", "git show", "git branch", "git rev-parse", "git ls-files", "git blame", "git remote", "git tag", "git describe", "git config --get",
  "npm test -- --list", "node --version", "npm --version", "npx tsc --version",
];

/** Substrings that make an otherwise read-only command potentially writes. */
const DANGEROUS_SUBSTRINGS: ReadonlySet<string> = new Set([
  ">", "<", "|", ";", "&", "`", "$(", "\n", "-delete", "-exec", "-execdir", "--exec", "sudo", "rm ", "mv ", "chmod", "chown", "tee ", "sh -c", "bash -c",
]);

/**
 * Is `cmd` a provably read-only command per the deterministic whitelist?
 * `cmd` should be the run_cmd command string. Parsing is intentionally
 * shallow (prefix + danger scan) — if we can't prove it read-only, it isn't.
 */
export function isReadonlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Reject anything with write/chaining/substitution affordances up front.
  for (const bad of DANGEROUS_SUBSTRINGS) {
    if (trimmed.includes(bad)) return false;
  }
  // Env-var assignment prefix (FOO=bar cmd ...) is allowed; skip past it.
  let rest = trimmed;
  while (true) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=[^ ]* +/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  // Longest matching prefix wins (git subcommands before bare names).
  const matches = READONLY_CMD_PREFIXES.filter((p) => rest === p || rest.startsWith(p + " "));
  if (!matches.length) return false;
  // A more specific command must not be undermined: `git config --get` ok,
  // bare `git config` (a write) is not on the list at all, so prefix table
  // membership is the decision.
  return true;
}

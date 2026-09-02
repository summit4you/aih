/**
 * CC slash-command recognition (opencode `parseSlashCommand` semantics).
 *
 * A "/" input is only a command when its head token names a KNOWN command
 * (builtin, skill, or extension). Everything else — including code pasted at
 * the prompt like `// setvbuf(...)` or `/* hook *​/` — falls through to the
 * model as a normal message instead of dying on "unknown command".
 *
 * Pure functions so both cmdChat and the smoke tests exercise the same logic.
 */

/** Head token of a slash input: "/goal clear" → "goal", "// x" → "". */
export function slashHeadOf(text: string): string {
  return (/^\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "").toLowerCase();
}

/** Builtin heads dispatched inside cmdChat's handleLine. */
export const BUILTIN_SLASH_HEADS: ReadonlySet<string> = new Set([
  "help", "commands", "tools", "mode", "goal", "memory", "model", "models",
  "connect", "usage", "compact", "checkpoint", "restore", "fork", "tree", "dream",
  "distill", "tidy", "find", "shell", "fix", "vivid", "bg", "sessions", "clear", "inject", "events",
  "skills", "exit", "quit",
]);

/**
 * Is `text` a known slash command? `extraHeads` carries the dynamic heads
 * (installed skill names + extension command names).
 */
export function isKnownSlashCommand(
  text: string,
  extraHeads: Iterable<string> = [],
): boolean {
  const head = slashHeadOf(text);
  if (!head) return false;
  if (BUILTIN_SLASH_HEADS.has(head)) return true;
  for (const name of extraHeads) {
    if (name.toLowerCase() === head) return true;
  }
  return false;
}

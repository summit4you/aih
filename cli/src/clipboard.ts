/**
 * IT#5 — clipboard copy for the run-or-copy approval UX.
 *
 * When the agent proposes a WRITE shell command, the approval prompt offers
 * "run / copy / no" (never auto-runs). "Copy" puts the command on the system
 * clipboard so the user can paste it wherever they want, instead of executing
 * it. This module is a thin, dependency-free seam over the OS clipboard:
 *
 *   - `detectClipboardCmd` — probe for a working clipboard binary
 *     (pbcopy / wl-copy / xclip / xsel / clip / clip.exe) and return it, or
 *     `null` when none is available (headless / CI / no X11).
 *   - `copyToClipboard`    — write text to the clipboard via that binary;
 *     returns a result describing success or the degraded fallback.
 *
 * Design rules (mirrors the cost.ts / scorecard.ts discipline):
 *   - Pure decision logic (`detectClipboardCmd`) is unit-testable without a
 *     real clipboard: it only inspects a candidate list + a `which` predicate.
 *   - `copyToClipboard` does the I/O but NEVER throws — a missing binary, a
 *     non-zero exit, or a spawn error all resolve to `{ ok:false, mode:"print" }`
 *     so the caller degrades to printing the command (the spec's fallback).
 *   - No new dependency: we shell out to a standard clipboard binary.
 */
import { spawnSync } from "node:child_process";

/** A candidate clipboard binary + how to invoke it (stdin → clipboard). */
export interface ClipboardCmd {
  /** Binary name to spawn. */
  bin: string;
  /** Extra args (usually none — text is piped on stdin). */
  args: string[];
  /** Human label for the result (e.g. "pbcopy"). */
  label: string;
}

/**
 * The probe order, most-preferred first. macOS `pbcopy`, then Wayland
 * `wl-copy`, then X11 `xclip`/`xsel`, then Windows `clip` (cmd.exe builtin)
 * / `clip.exe` (Git Bash). The first one that `which`-resolves wins.
 */
export const CLIPBOARD_CANDIDATES: readonly ClipboardCmd[] = [
  { bin: "pbcopy", args: [], label: "pbcopy" },
  { bin: "wl-copy", args: [], label: "wl-copy" },
  { bin: "xclip", args: ["-selection", "clipboard"], label: "xclip" },
  { bin: "xsel", args: ["--clipboard", "--input"], label: "xsel" },
  { bin: "clip", args: [], label: "clip" },
];

/**
 * Pure: pick the first candidate whose binary resolves under `which`.
 * `which` is injected so tests can fake availability without a real binary.
 * Returns `null` when none resolve (caller degrades to printing).
 */
export function detectClipboardCmd(
  candidates: readonly ClipboardCmd[] = CLIPBOARD_CANDIDATES,
  which: (bin: string) => boolean = defaultWhich,
): ClipboardCmd | null {
  for (const c of candidates) {
    if (which(c.bin)) return c;
  }
  return null;
}

/** Default `which`: is this binary on PATH? (spawnSync, no shell.) */
function defaultWhich(bin: string): boolean {
  try {
    const r = spawnSync("which", [bin], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface CopyResult {
  ok: boolean;
  /** "clipboard" when written to the OS clipboard, "print" when degraded. */
  mode: "clipboard" | "print";
  /** The binary used (clipboard mode) or a reason (print mode). */
  via?: string;
  /** True when the caller should print the command as the fallback. */
  print: boolean;
}

/**
 * Write `text` to the system clipboard. Never throws. When no clipboard
 * binary is available (or it fails), returns `{ ok:false, mode:"print",
 * print:true }` so the caller prints the command instead.
 */
export function copyToClipboard(
  text: string,
  candidates: readonly ClipboardCmd[] = CLIPBOARD_CANDIDATES,
  which: (bin: string) => boolean = defaultWhich,
): CopyResult {
  const cmd = detectClipboardCmd(candidates, which);
  if (!cmd) {
    return { ok: false, mode: "print", print: true, via: "no clipboard binary found" };
  }
  try {
    const r = spawnSync(cmd.bin, cmd.args, {
      input: text,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (r.status === 0) {
      return { ok: true, mode: "clipboard", print: false, via: cmd.label };
    }
    const err = r.stderr ? r.stderr.toString().trim() : `exit ${r.status}`;
    return { ok: false, mode: "print", print: true, via: `${cmd.label} failed: ${err}` };
  } catch (e) {
    return {
      ok: false,
      mode: "print",
      print: true,
      via: `${cmd.label} spawn error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

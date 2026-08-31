/**
 * Keybinds (opencode `keybinds` parity, proportionate scope).
 *
 * opencode exposes a full tui.json keybind surface (leader + ~60 actions).
 * AIH mirrors the *concept* at the scope of its distinct core-action
 * keystrokes, so a user can remap the few keys that currently trigger a fixed
 * TUI action. Keys not listed keep their built-in default.
 *
 * Keybind source (loaded in order, later wins):
 *   1. `tui.json`   in cwd (project)
 *   2. `~/.aih/tui.json` (global)
 *
 * Shape:
 *   {
 *     "keybinds": {
 *       "palette": "ctrl+x",      // command palette (default ctrl-p = \x10)
 *       "toggleMode": "ctrl+m",   // build<->plan toggle (default tab = \t)
 *       "help": "?"               // open help on idle empty composer (default ?)
 *     }
 *   }
 *
 * Each value is a single-byte key name mapped to the raw byte the TUI's input
 * dispatcher sees. Supported names:
 *   "ctrl+<letter>"  → control byte (e.g. ctrl+p = \x10)
 *   "tab"            → \t
 *   "?" / any single printable char → that char
 *   "none"           → disable the key; action unavailable via key (palette
 *                      still reachable via the /command palette).
 *
 * Two-byte sequences (Alt+…, F-keys, arrows) are intentionally out of scope —
 * they flow through the escape machine, not the single-byte dispatcher.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userAihDir } from "./paths.js";
import { readJson } from "./read-json.js";

export type KeybindAction = "palette" | "toggleMode" | "help";

/** Human key name → raw byte(s) the TUI receives. */
export type KeybindMap = Partial<Record<KeybindAction, string>>;

const DEFAULTS: KeybindMap = {
  palette: "ctrl+p",
  // toggleMode is NOT keyed by default: Tab already drives completion-and-
  // toggle-mode in the built-in TUI; a user may opt in to a separate key.
  toggleMode: "none",
  help: "?",
};

interface TuiJson {
  keybinds?: KeybindMap;
}

function readTuiJson(path: string): TuiJson | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readJson<TuiJson>(path);
  } catch {
    return undefined;
  }
}

/**
 * Load the effective keybind map: defaults overlaid with project tui.json
 * then global ~/.aih/tui.json (global last → wins, so a user's global remap
 * overrides a repo's).
 */
export function loadKeybinds(): KeybindMap {
  const map: KeybindMap = { ...DEFAULTS };
  const files = [
    join(process.cwd(), "tui.json"),
    join(userAihDir(), "tui.json"),
  ];
  for (const f of files) {
    const cfg = readTuiJson(f);
    if (!cfg?.keybinds) continue;
    for (const [action, key] of Object.entries(cfg.keybinds)) {
      if (action === "palette" || action === "toggleMode" || action === "help") {
        if (key === undefined) continue;
        (map as Record<string, string>)[action] = key;
      }
    }
  }
  return map;
}

/**
 * Resolve a human key name to the raw byte(s) the TUI dispatches on, or
 * `undefined` when the name is unrecognized or "none".
 */
export function keyToBytes(name: string | undefined): string | undefined {
  if (!name || name === "none") return undefined;
  if (name === "tab") return "\t";
  if (name === "enter" || name === "return") return "\r";
  if (name === "escape" || name === "esc") return "\x1b";
  const m = /^ctrl\+([a-z])$/i.exec(name);
  if (m) return String.fromCharCode(m[1].toLowerCase().charCodeAt(0) - 96);
  if (/^[ -~]$/.test(name)) return name; // single printable char
  return undefined;
}

/**
 * Build a lookup table from resolved raw bytes → action name (for the TUI's
 * input dispatcher). Multiple actions must not share the same byte — a remap
 * that collides with another remapped action (or with a reserved built-in
 * like enter/submit) is dropped with a warning so behavior stays predictable.
 */
export function buildKeybindDispatch(
  map: KeybindMap,
): { byteToAction: Record<string, KeybindAction>; warnings: string[] } {
  const byteToAction: Record<string, KeybindAction> = {};
  const warnings: string[] = [];
  // Reserve built-ins that must not be rebound (submit, clear, interrupt).
  const reserved = new Set(["\r", "\n", "\x03", "\x15", "\x7f", "\x1b"]);
  const actions: KeybindAction[] = ["palette", "toggleMode", "help"];
  for (const action of actions) {
    const bytes = keyToBytes(map[action]);
    if (!bytes) continue; // "none" or unrecognized → action not keyed
    if (reserved.has(bytes)) {
      warnings.push(`keybind "${action}": ${map[action]} collides with a reserved key — ignored`);
      continue;
    }
    const existing = byteToAction[bytes];
    if (existing) {
      warnings.push(`keybind "${action}": ${map[action]} collides with "${existing}" — ignored`);
      continue;
    }
    byteToAction[bytes] = action;
  }
  return { byteToAction, warnings };
}

/** Write a tui.json keybind config to the project dir (used by any future UI). */
export function saveTuiJson(keybinds: KeybindMap): string {
  const path = join(process.cwd(), "tui.json");
  writeFileSync(path, `${JSON.stringify({ keybinds }, null, 2)}\n`, "utf8");
  return path;
}

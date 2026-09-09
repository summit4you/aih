import { accent, bold, blue, cyan, danger, dim, gradientText, green, italic, magenta, muted, paint, red, success, underline, warn, yellow } from "./ui.js";
import type { DiffLine } from "./diff.js";
import { capDiff } from "./diff.js";
import type { KeybindAction } from "./keybinds.js";
import stringWidth from "string-width";

export interface TodoItem {
  content: string;
  status: string;
}

export interface ToolView {
  name: string;
  args: string;
  callId: string;
  ok?: boolean;
  error?: string;
  diff?: DiffLine[];
  truncated?: number;
  output?: string;
  expanded?: boolean;
  outputCapped?: boolean;
  todos?: TodoItem[];
}

export type SysKind =
  | "tool" //      tool status:      blue 38;5;75
  | "permission" // permission event: yellow 33
  | "model" //     model/mode change: cyan 36
  | "memory" //    memory/context:    cyan 36
  | "auth" //      auth success:      green 32
  | "shell" //     shell output:      gray 38;5;244
  | "thought" //   thought trace:     dim 2
  | "error" //     error:             red 31
  | "info"; //     default info:      dim 2

/** qwen-code terminal.ts parity — semantic SGR per system row kind (Q-R7). */
export const SYS_KIND_SGR: Record<SysKind, string> = {
  tool: "38;5;75",
  permission: "33",
  model: "36",
  memory: "36",
  auth: "32",
  shell: "38;5;244",
  thought: "2",
  error: "31",
  info: "2",
};

export interface TuiItem {
  role: "user" | "assistant" | "tool" | "system" | "footer" | "banner";
  text: string;
  red?: boolean;
  sysKind?: SysKind;
  tool?: ToolView;
}

export interface TuiOptions {
  placeholder: string;
  meta(): { agent: string; model: string; provider: string };
  /** opencode-parity footer: aih version shown at the left of the second row. */
  version?: string;
  cwd: string;
  statusLeft: string;
  statusRight: string;
  statusBadge?(): { glyph: string; ok: boolean; label: string } | null;
  /** IT#2 — shell-failure indicator (null/absent = all green, hide). */
  shellErrorBadge?(): { glyph: string; ok: boolean; label: string } | null;
  /** D#13: background-job counts for the status line (null/absent = hide). */
  jobStatus?(): { running: number; done: number; failed: number } | null;
  busy(): boolean;
  cancelTurn?(): void;
  onLine(line: string): void;
  /**
   * P#35 — called instead of onLine when a turn is active: lets the host
   * STEER the running turn immediately (opencode parity — user input during
   * execution is injected before the next step, not held until it ends).
   * Return false to fall back to the internal queue (shown as "queued").
   */
  onLineBusy?(line: string): boolean;
  /** Is this trimmed input a KNOWN slash command? (used for queue labels) */
  onLineKnownSlash?(line: string): boolean;
  ctxUsage?(): {
    used: number;
    limit: number;
    trend?: number[];
    /** F#30: cumulative session cost in USD (undefined = no price table match) */
    cost?: number;
    /** F#30: session throughput tokens/s (0 = no usage data) */
    tps?: number;
    /** F#30: streaming TPS — completion tokens / real generation ms (0 = n/a) */
    stps?: number;
    /** P#41: prompt-cache hit rate 0..1 (absent when unobservable) */
    cacheRate?: number;
  };
  completions?(): string[];
  onTab?(): void;
  /** open the command palette (ctrl-p) */
  onPalette?(): void;
  /**
   * Keybinds — remap of core-action keystrokes (opencode `keybinds` parity).
   * Maps raw bytes → action name, built by `cli/keybinds.ts`. When absent, the
   * built-in defaults apply (palette=ctrl-p, toggleMode=tab, help=?).
   */
  keybinds?: { byteToAction: Record<string, KeybindAction> };
  /** Keybind load/validation warnings to surface to the user at startup. */
  keybindWarnings?: string[];
  /**
   * Fixed terminal width override (cols). When set, the TUI uses this instead
   * of process.stdout.columns — for tests, embedding and replay harnesses.
   * Resize events from the real terminal are ignored while it is set.
   */
  width?: number;
}

/** One selectable entry in a TUI overlay picker. */
export interface PickerEntry {
  /** primary label (left side of the row) */
  label: string;
  /** dimmer detail shown on the right / second line */
  hint?: string;
  /** marker for the currently-active entry */
  active?: boolean;
}

/** Result of a dismissed overlay picker. */
export type PickerOutcome =
  | { kind: "select"; index: number }
  | { kind: "cancel" };

const CSI = "\x1b[";
const HIDE = `${CSI}?25l`;
const SHOW = `${CSI}?25h`;
const BOX_BG = `${CSI}48;5;236m`; // dark-theme surface (near-black)
const LIGHT_BG = `${CSI}48;5;254m`; // light-theme surface (near-white)
// Diff cells (opencode-style, no border): left = removed (red tint),
// right = added (green tint).
const DEL_BG = `${CSI}48;5;237m`; // dark-theme removed cell (red tint)
const ADD_BG = `${CSI}48;5;233m`; // dark-theme added cell (green tint)
const DEL_BG_LIGHT = `${CSI}48;5;225m`; // light-theme removed cell
const ADD_BG_LIGHT = `${CSI}48;5;194m`; // light-theme added cell
/** Below this body width the side-by-side diff falls back to unified. */
const DIFF_SIDEBYSIDE_MIN_COLS = 100;
const REV = `${CSI}7m`; // reverse video: selection that works on any theme
const RESET = `${CSI}0m`;
// Terminal background report (OSC 11), 16-bit RRRR/GGGG/BBBB, BEL or ST terminated.
const OSC11_BG =
  /^\x1b]11;rgb:([0-9a-fA-F]{4,8})\/([0-9a-fA-F]{4,8})\/([0-9a-fA-F]{4,8})(?:\x07|\x1b\\)/;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Show the spinner only after this much busy time (avoids a flash for fast ops).
const SPINNER_DELAY_MS = 200;
// A double-Esc arriving within this window after a consumed escape SEQUENCE
// (mouse/scroll/paste/OSC) is treated as residual terminal noise (conpty
// children flushing leftover bytes), not a user cancel gesture. Windows:
// `run_cmd` PowerShell exit → terminal flushes residual ESC/<CSI> bytes →
// they must never cancel a running turn. 150ms is far below human Esc-Esc
// cadence yet covers same-read burst pairing.
const ESC_NOISE_MS = 150;

// Content of the read-only help dialog (? with empty input, /help, palette).
// Kept short enough for the dialog width; each line is clipped anyway.
const HELP_LINES: string[] = [
  bold("keys"),
  "    enter send · esc clear · esc escape twice cancels the turn",
  "    up/down recall history · Alt+Up recall queued · tab complete · ctrl-p palette",
  "    ? help (empty input) · mouse scroll/click · enter expand",
  bold("state"),
  "    ▶ running   ✓ ok   ✗ failed   ● active model",
  bold("commands"),
  "    /skills · /usage · /compact · /checkpoint · /restore · /fork · /find · /vivid · /exit",
];

export const TOOL_ICONS: Record<string, string> = {
  bash: "$",
  execute: "$",
  run: "$",
  run_cmd: "$",
  shell: "$",
  read: "→",
  read_file: "→",
  view_image: "→",
  grep: "✱",
  search: "✱",
  glob: "✱",
  find: "✱",
  websearch: "◈",
  codesearch: "◈",
  webfetch: "%",
  fetch: "%",
  write: "←",
  write_file: "←",
  edit: "←",
  patch: "←",
  apply_patch: "←",
  todowrite: "#",
  todo: "#",
  skill: "→",
  load_skill: "→",
};

/**
 * ?1007 (alternate scroll) policy per platform. POSIX terminals (xterm/VTE/
 * kitty) translate the wheel to ↑/↓ arrows in the alt screen; sending ?1007h
 * makes them deliver SGR 64/65 after our first-flick recovery. Windows
 * Terminal must NOT get it: under active mouse tracking (?1000/?1006) it
 * already forwards the wheel as SGR 64/65 ("mouse tracking takes precedence" —
 * microsoft/terminal#13187), and ?1007h there forces arrow translation — the
 * first flick falls into input-history recall and never scrolls (the reported
 * "Windows Terminal wheel can't scroll the transcript" bug).
 */
export function useAltScrollFor(platform: string): boolean {
  return platform !== "win32";
}

// Display width follows the standard `string-width` algorithm (the same one
// Bun.stringWidth and opencode/mimo use): emoji = 2 cells, East-Asian
// Wide/Fullwidth = 2, Ambiguous = 1 (narrow) by default, Neutral = 1, and
// zero-width / combining / variation-selector code points = 0. ANSI escape
// sequences are stripped. Override AIH_AMBIGUOUS_WIDE=2 to count Ambiguous
// characters as wide (2 cells) for terminals whose CJK font renders them so.
//
// Font-specific overrides: some CJK mono fonts render a few emoji as a single
// halfwidth cell even though the standard algorithm counts them as 2. Map of
// code point -> actual cell count for the user's terminal (GNOME/Konsole,
// zh_CN CJK font). Verified against the user's table: ⚠ (U+26A0) is 1 cell.
const WIDTH_OVERRIDES: Record<number, number> = {
  0x26a0: 1, // ⚠ warning sign
};
const segmenter = new Intl.Segmenter();

// swOpts derives from an env var that is fixed for the life of the process —
// memoize it so the per-cluster hot path never re-reads env / re-allocates.
let _swOpts: { ambiguousIsNarrow: boolean } | null = null;
function swOpts(): { ambiguousIsNarrow: boolean } {
  if (_swOpts === null) {
    _swOpts = process.env.AIH_AMBIGUOUS_WIDE === "2"
      ? { ambiguousIsNarrow: false }
      : { ambiguousIsNarrow: true };
  }
  return _swOpts;
}

// Cache cluster widths: the same grapheme clusters repeat across the whole TUI,
// so a Map lookup is far cheaper than re-running stringWidth on every paint.
// (The set of distinct clusters in a TUI is small — ASCII + CJK + a few emoji —
// so this stays bounded.)
const clusterWidthCache = new Map<string, number>();
function clusterWidth(cluster: string): number {
  const hit = clusterWidthCache.get(cluster);
  if (hit !== undefined) return hit;
  const c = cluster.codePointAt(0);
  const w =
    c !== undefined && WIDTH_OVERRIDES[c] !== undefined
      ? WIDTH_OVERRIDES[c]
      : stringWidth(cluster, swOpts());
  clusterWidthCache.set(cluster, w);
  return w;
}

/** Display width of one code point in terminal cells: 0, 1, or 2. */
/**
 * CC#58 — hard cap (in display columns) for a single input line fed to
 * wrapStyled. Pathological lines (base64, minified diff/JSON) are truncated to
 * this width with a marker so the wrap loop stays O(n·cols) and rendering stays
 * interactive.
 */
export const MAX_WRAP_COLS = 4000;

export function width(ch: string): number {
  // Fast path for a single code point (the #clip / wrapStyled hot path): a lone
  // code point is a single grapheme cluster, so skip the Segmenter iterator.
  if (ch.length === 1) return clusterWidth(ch);
  if (ch.length === 2 && (ch.charCodeAt(0) & 0xfc00) === 0xd800) return clusterWidth(ch);
  let n = 0;
  for (const { segment } of segmenter.segment(ch)) n += clusterWidth(segment);
  return n;
}

/** Display width of a (possibly ANSI-styled) string, in terminal cells. */
export function cols(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const { segment } of segmenter.segment(plain)) n += clusterWidth(segment);
  return n;
}

/**
 * Overlay picker scrolling window: which rows of a long list are visible and
 * where the highlight sits. `sel` is a 0-based index into the FULL list; the
 * visible window is a `maxRows`-tall slice centered on `sel`. Returns the
 * slice start `top` and the highlight offset WITHIN the window, so callers
 * can render the highlight at the correct row (a classic bug is comparing a
 * window-relative loop index against the global `sel` — that drifts once the
 * list scrolls).
 */
export function paletteWindow(
  sel: number,
  len: number,
  maxRows: number,
): { top: number; highlight: number } {
  const rows = Math.max(1, maxRows);
  const top = Math.max(0, Math.min(sel - (rows >> 1), Math.max(0, len - rows)));
  return { top, highlight: sel - top };
}

export function wrapStyled(s: string, limit: number): string[] {
  // CC#58 — hard cap on a pathological single line (base64 / minified diff).
  // Without it the wrap loop would be O(n·cols) and freeze rendering on
  // 10k+-char lines. We measure the plain (unstyled) width and truncate with a
  // marker, keeping the wrap loop's cost bounded.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length > MAX_WRAP_COLS) {
    const kept = plain.slice(0, MAX_WRAP_COLS);
    const marker = `… [+${plain.length - MAX_WRAP_COLS} chars truncated]`;
    return wrapStyledCore(kept + marker, limit);
  }
  return wrapStyledCore(s, limit);
}

/** The wrap loop itself (no cap — wrapStyled handles the cap up front). */
function wrapStyledCore(s: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  let n = 0;
  let open = "";
  for (const tk of s.split(/(\x1b\[[0-9;]*m)/).filter((x) => x !== "")) {
    if (/^\x1b\[[0-9;]*m$/.test(tk)) {
      open = tk === RESET ? "" : tk;
      cur += tk;
      continue;
    }
    for (const ch of tk) {
      const w = width(ch);
      if (n + w > limit && n > 0) {
        out.push(cur + (open ? RESET : ""));
        cur = open;
        n = 0;
      }
      cur += ch;
      n += w;
    }
  }
  out.push(cur);
  return out.length ? out : [""];
}

const emph = (s: string) => italic(yellow(s));
const linkLabel = (s: string) => underline(cyan(s));
const linkUrl = (s: string) => underline(blue(s));

function inlineMd(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, x: string) => {
    codes.push(green(x));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, x: string) => bold(x));
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, x: string) => `${pre}${emph(x)}`);
  s = s.replace(/(\[([^\]]+)\]\(([^)\s]+)\))|(?<![\w(])(https?:\/\/[^\s<>()]+)/g, (m, link, label, url, bare) => {
    if (link) return `${linkLabel(label)} ${linkUrl(url)}`;
    return linkUrl(bare);
  });
  s = s.replace(/\|/g, " · ");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
  return s;
}

// --- markdown table rendering (opencode/mimo-code style bordered text table) ---

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  const cells = splitTableRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableRow(line: string): boolean {
  return (line.trim().match(/\|/g) ?? []).length >= 2;
}

function padStyled(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - cols(s)));
}

function maxCellLines(cells: string[][]): number {
  return Math.max(0, ...cells.map((c) => c.length));
}

/**
 * Render a parsed markdown table (rows of cell strings) as a bordered text
 * table: content-fit columns (CJK-aware), 1-space cell padding, box-drawing
 * borders, header row bold, long cells word-wrapped. Total width ≤ W.
 */
function renderTable(rows: string[][], W: number): string[] {
  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const c = r.slice(0, nCols);
    while (c.length < nCols) c.push("");
    return c;
  });
  const ideal = Array.from({ length: nCols }, (_, c) =>
    Math.max(1, ...norm.map((r) => cols(inlineMd(r[c])))),
  );
  const budget = Math.max(nCols, W - 3 * nCols - 1);
  let colW = ideal.slice();
  const sum = colW.reduce((a, b) => a + b, 0);
  if (sum > budget) {
    const scale = budget / sum;
    colW = ideal.map((w) => Math.max(3, Math.round(w * scale)));
    let s = colW.reduce((a, b) => a + b, 0);
    while (s > budget) {
      const idx = colW.indexOf(Math.max(...colW));
      if (colW[idx] <= 3) break;
      colW[idx] -= 1;
      s -= 1;
    }
  }
  const wrapped = norm.map((r) => r.map((cell, c) => wrapStyled(inlineMd(cell), colW[c])));
  const bar = (l: string, m: string, r: string) =>
    dim(l + colW.map((w) => "─".repeat(w + 2)).join(m) + r);
  const line = (cells: string[]) =>
    `${dim("│")} ${cells.map((c, i) => padStyled(c, colW[i])).join(dim(" │ "))}${dim(" │")}`;
  const out: string[] = [bar("┌", "┬", "┐")];
  const h = maxCellLines(wrapped[0]);
  for (let i = 0; i < h; i += 1) out.push(line(wrapped[0].map((cell, c) => bold(cell[i] ?? ""))));
  out.push(bar("├", "┼", "┤"));
  for (let r = 1; r < norm.length; r += 1) {
    const n = maxCellLines(wrapped[r]);
    for (let i = 0; i < n; i += 1) out.push(line(wrapped[r].map((cell, c) => cell[i] ?? "")));
  }
  out.push(bar("└", "┴", "┘"));
  return out;
}

function restyle(s: string, fn: (t: string) => string): string {
  return s
    .split(/(\x1b\[[0-9;]*m)/)
    .filter((x) => x !== "")
    .map((tk) => (/^\x1b\[[0-9;]*m$/.test(tk) ? tk : fn(tk)))
    .join("");
}

const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "elif", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "super", "import",
  "export", "from", "default", "try", "catch", "finally", "throw", "await", "async",
  "yield", "typeof", "instanceof", "in", "of", "delete", "void", "this", "null",
  "undefined", "true", "false", "static", "def", "lambda", "pass", "raise", "with", "as",
  "assert", "global", "nonlocal", "print", "None", "True", "False", "except", "func",
  "package", "type", "struct", "interface", "map", "chan", "go", "defer", "select",
  "range", "fallthrough", "fn", "pub", "use", "mod", "impl", "trait", "enum", "match",
  "move", "ref", "mut", "dyn", "echo", "cd", "grep", "awk", "sed", "curl", "npm",
  "node", "bash", "sh", "source", "local", "readonly", "set", "unset", "read",
  "printf", "select", "where", "insert", "into", "values", "update", "delete", "join",
  "left", "right", "inner", "outer", "group", "by", "order", "having", "limit",
  "union", "create", "table", "index", "alter", "drop",
]);

function highlightCode(line: string): string {
  const re = /(\/\/[^\n]*|#[ \t][^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out += line.slice(last, m.index);
    last = re.lastIndex;
    if (m[1] !== undefined) {
      out += dim(m[1]);
    } else if (m[2] !== undefined) {
      out += green(m[2]);
    } else if (m[3] !== undefined) {
      out += yellow(m[3]);
    } else {
      const w = m[4];
      const rest = line.slice(re.lastIndex);
      if (CODE_KEYWORDS.has(w)) out += magenta(w);
      else if (/^\s*\(/.test(rest)) out += blue(w);
      else out += w;
    }
  }
  return out + line.slice(last);
}

// opencode-style per-tool "title" argument: the row shows its full value
// (no truncation) instead of a capped k=v dump — e.g. run_cmd shows the whole
// command, write_file shows the path.
export const TOOL_TITLE_ARG: Record<string, string> = {
  run_cmd: "command",
  read_file: "path",
  write_file: "path",
  edit: "path",
  apply_patch: "path",
  glob: "pattern",
  grep: "pattern",
  webfetch: "url",
  websearch: "query",
  question: "question",
  todo: "content",
  task: "description",
};

function fmtArgs(name: string, args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object" || Array.isArray(args)) {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 197) + "…" : s;
  }
  const a = args as Record<string, unknown>;
  const title = TOOL_TITLE_ARG[name];
  if (title && typeof a[title] === "string") {
    let s = String(a[title]).replace(/\s*\n+\s*/g, " ").trim();
    const rest = Object.entries(a)
      .filter(([k, v]) => k !== title && typeof v === "string" && (v as string).length <= 40)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    if (rest.length) s = `${s} ${rest.join(" ")}`;
    return s;
  }
  const parts = Object.entries(a).map(([k, v]) => {
    let sv: string;
    if (typeof v === "string") sv = v.length > 120 ? `<${v.length} chars>` : JSON.stringify(v);
    else {
      const j = JSON.stringify(v);
      sv = j == null ? "" : j.length > 120 ? j.slice(0, 117) + "…" : j;
    }
    return `${k}=${sv}`;
  });
  const s = parts.join(" ");
  return s.length > 400 ? s.slice(0, 397) + "…" : s;
}

type Unit =
  | { kind: "item"; index: number; item: TuiItem }
  | { kind: "group"; start: number; items: TuiItem[] };

export class Tui {
  #opts: TuiOptions;
  #items: TuiItem[] = [];
  #bodyUnitIdx: number[] = [];
  #groupOpen = new Map<number, boolean>();
  // Render cache: rendered lines per item / per group, keyed by (width, theme).
  // Items are immutable once pushed (except the streaming assistant item and
  // tool results, which are invalidated on mutation), so re-rendering the whole
  // transcript on every follow/paint is pure waste. This makes scroll + replay
  // O(viewport) instead of O(transcript).
  #itemCache = new Map<object, { w: number; d: boolean; lines: string[] }>();
  #groupCache = new Map<number, { w: number; d: boolean; open: boolean; lines: string[] }>();
  #batching = false;
  #edit = "";
  #keybinds: Record<string, KeybindAction> = {};
  #keybindWarnings: string[] = [];
  #cursor = 0;
  #history: string[] = [];
  #held = "";
  #histCursor = -1;
  #scrollTop = 0;
  #rows = 24;
  #cols = 80;
  #running = false;
  #frame = 0;
  #busySince = 0;
  #arrowTimes: number[] = [];
  #sgrWheelSeen = false;
  #mouseHintShown = false;
  #swallowArrows = false;
  #burstSnapshot: { edit: string; cursor: number; hist: number } | null = null;
  /**
   * Should we send ?1007 (alternate scroll)? Only on non-Windows terminals.
   * Windows Terminal resolves wheel events itself: with mouse tracking
   * enabled (?1000/?1006) it forwards the wheel as SGR 64/65 — "mouse
   * tracking takes precedence" (microsoft/terminal#13187). Sending ?1007h
   * there instead converts the wheel to ↑/↓ arrows, which our #arrowKey
   * only recovers from AFTER seeing an SGR wheel first (a chicken-and-egg:
   * the first flick never scrolls and edits the input history instead —
   * the reported "Windows Terminal wheel can't scroll the transcript" bug).
   */
  #useAltScroll = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #paintScheduled = false;
  #paintTimer: ReturnType<typeof setTimeout> | null = null;
  #clearNext = true;
  #lastLines: string[] = [];
  #confirm: ((ans: "once" | "always" | "deny") => void) | null = null;
  #confirmText = "";
  /** IT#5 — "confirm" = [y]/[n]/[a]; "runorcopy" = [R]un/[C]opy/[N]o. */
  #confirmMode: "confirm" | "runorcopy" | "grant" = "confirm";
  #question: { resolve: (answer: string) => void; reject: (err: Error) => void } | null = null;
  #qbuf = "";
  #queue: string[] = [];
  #pendingExit = false;
  #overlay: {
    title: string;
    entries: PickerEntry[];
    filtered: number[];
    query: string;
    sel: number;
    /** true = read-only help dialog (no filtering, Enter just closes) */
    help?: boolean;
    resolve: (outcome: PickerOutcome) => void;
  } | null = null;
  /** Theme: derived from the terminal background (OSC 11), forced via AIH_THEME. */
  #dark = true;
  /** P2#9 — /vivid: concise (plain) render mode — no borders/surface/panel/chrome. */
  #plain = false;
  /**
   * Keyboard focus for expand/collapse (A). Mouse click also works (Win10+
   * conhost supports ?1000/?1006 SGR mouse). Enter/o on a focused unit is the
   * keyboard path. Default = the most recently rendered tool unit.
   */
  #focusUnit = -1;
  /**
   * Legacy Windows console (conhost, no WT_SESSION/TERM_PROGRAM): mouse
   * tracking works (Win10+), but bracketed paste is unreliable and GBK
   * codepage mis-renders Unicode block chars. Set in start(); consumers
   * (panel sparkline) degrade to ASCII.
   */
  #legacyWin = false;

constructor(opts: TuiOptions) {
    this.#opts = opts;
    this.#keybinds = opts.keybinds?.byteToAction ?? {};
    this.#keybindWarnings = opts.keybindWarnings ?? [];
    if (typeof opts.width === "number" && opts.width > 0) this.#cols = Math.floor(opts.width);
  }

 /** Current theme (test/UI hook). */
  isDark(): boolean {
    return this.#dark;
  }

  /** P2#9 — /vivid concise render mode (toggle). */
  setPlain(on: boolean): void {
    if (this.#plain === on) return;
    this.#plain = on;
    this.#itemCache.clear();
    this.requestPaint();
  }

  /** P2#9 — current concise render mode. */
  isPlain(): boolean {
    return this.#plain;
  }

  /** All rendered transcript lines (test/text-replay hook). */
  transcriptLines(): string[] {
    const body: string[] = [];
    for (const u of this.#units()) {
      const lines = u.kind === "item" ? this.#block(u.item) : this.#groupLines(u);
      for (const r of lines) body.push(r);    }
    return body;
  }

 /** Background surface for input box / user rows / panel, by theme. */
 #surface(): string {
    return this.#dark ? BOX_BG : LIGHT_BG;
  }

 start(): void {
    if (!process.stdin.isTTY) throw new Error("Tui requires a TTY");
    // Resolve the terminal theme: AIH_THEME=light|dark forces it, otherwise
    // ask the terminal for its background color (OSC 11) and fall back to the
    // dark theme if it does not answer.
    const forced = (process.env.AIH_THEME ?? "").toLowerCase();
    if (forced === "light") this.#dark = false;
    else if (forced !== "dark") process.stdout.write("\x1b]11;?\x07");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => this.#feed(data.toString("utf8")));
    process.stdout.on("resize", () => {
      this.#clearNext = true;
      // Legacy conhost (Win10/11 without Windows Terminal) crashes on
      // synchronized-output + clear-screen during buffer reallocation.
      // Delay the paint so conhost finishes resizing before we write.
      const delay = this.#legacyWin ? 250 : 16;
      if (this.#paintTimer) clearTimeout(this.#paintTimer);
      this.#paintScheduled = true;
      this.#paintTimer = setTimeout(() => {
        this.#paintScheduled = false;
        this.#paintTimer = null;
        this.#paint();
      }, delay);
    });
    process.on("exit", this.#restore);
    this.#running = true;
    // ?1049 alt screen, ?1000 mouse, ?1006 SGR mouse, ?2004 bracketed paste —
    // pastes arrive wrapped in ESC[200~…ESC[201~ so their newlines are never
    // mistaken for Enter presses.
    // Legacy Windows console (no WT_SESSION → not Windows Terminal): mouse
    // tracking and bracketed paste are unreliable there (conhost predates
    // both; unknown CSIs either no-op or leak into the buffer), so skip them
    // and keep only the alt-screen toggle, which conhost understands. Windows
    // Terminal / VS Code get the full set.
    const legacyWin = process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
    this.#legacyWin = legacyWin;
    // ?1007 (alternate scroll) is a Linux/Unix-terminal behavior (xterm/VTE/
    // kitty): it makes the wheel arrive as ↑/↓ arrows so the app can scroll
    // itself, and our #arrowKey burst-detection recovers SGR after the first
    // flick. On Windows Terminal we must NOT send it — WT already honours
    // mouse-tracking precedence and delivers the wheel as SGR 64/65 directly
    // (see #useAltScroll; sending ?1007h there forces arrow conversion and the
    // first flick falls into input-history recall instead of scrolling).
    this.#useAltScroll = useAltScrollFor(process.platform);
    // Legacy conhost: NO alt-screen (?1049) — its resize handler has a buffer
    // overflow bug that crashes when the TUI writes during reallocation.
    // Mouse tracking (?1000/?1006) IS supported on Win10+ conhost — enable it
    // so click-to-expand works. Bracketed paste (?2004) enables Ctrl+Shift+V
    // and right-click paste to arrive as literal text (not key events).
    // ?1007 (alternate scroll): while in the alt screen, wheel events are
    // delivered to the application as mouse SGR sequences (64/65) instead of
    // being translated by the terminal into arrow keys (CSI A/B). Without it:
    //  - Windows Terminal (alternateScroll: auto) swallows the wheel for its
    //    own scrollback — the user sees the main-screen scrollback.
    //  - Linux VTE terminals (GNOME Terminal, xfce4-terminal, Konsole) default
    //    to alternate-scroll OFF: the wheel is translated into ↑/↓ arrow keys,
    //    which the TUI reads as composer input-history recall — so scrolling
    //    "works" until the transcript hits the top, then the wheel starts
    //    editing the input history instead.
    // ?1007 is honored by xterm, VTE (3.26+), kitty, foot — but NOT sent on
    // Windows (WT forwards the wheel as SGR under mouse tracking; see
    // #useAltScroll). Legacy conhost does not understand it either, and its
    // resize bug forbids ?1049 (see above) — legacy keeps mouse/paste only.
    const modes = legacyWin
      ? `${CSI}?1000h${CSI}?1006h${CSI}?2004h`
      : this.#useAltScroll
        ? `${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h${CSI}?1007h`
        : `${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h`;
    process.stdout.write(modes);
    if (legacyWin) {
      this.pushSystem(
        "conhost detected — for full mouse/paste/alt-screen, use Windows Terminal (Microsoft Store). " +
        "Keyboard: PgUp/PgDn = scroll · Enter/o = expand/collapse · right-click = paste"
      );
    } else if (process.platform === "win32") {
      // Windows Terminal: mouse tracking (?1000/?1006) forwards the wheel as
      // SGR 64/65 directly — no ?1007 (which would convert it to arrows and
      // break the first flick). The wheel scrolls the transcript natively.
      this.pushSystem(
        "Windows Terminal: mouse wheel scrolls the conversation (SGR mouse tracking). " +
        "Keyboard: PgUp/PgDn = scroll · Enter/o = expand/collapse"
      );
    } else if (process.platform === "linux") {
      // ?1007 enabled: VTE terminals that translate the wheel into arrow keys
      // (GNOME Terminal, xfce4-terminal, Konsole) now forward it to aih.
      this.pushSystem(
        "Mouse wheel scrolls the conversation (alternate scroll enabled). " +
        "Keyboard: PgUp/PgDn = scroll · Enter/o = expand/collapse"
      );
    }
    this.#timer = setInterval(this.#tick, 120);
    this.#paint();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#paintTimer) clearTimeout(this.#paintTimer);
    this.#paintTimer = null;
    this.#paintScheduled = false;
    process.stdin.setRawMode(false);
    // Clear the TUI's screen before leaving: on alt-screen terminals ?1049l
    // restores the pre-session main screen, but on terminals WITHOUT alt
    // screen (legacy conhost — which never gets ?1049h because of its resize
    // bug — and minimal terminals/tmux configs whose ?1049 save/restore is
    // a raw buffer switch that preserves nothing), the transcript was painted
    // straight onto the main screen and STAYED there after exit: the user saw
    // the whole conversation above the freshly shown shell prompt. ESC[2J
    // clears whatever screen we are on at this moment — a no-op visually on
    // alt-screen terminals (the main screen is about to replace it) and the
    // clear fix for everything else.
    // Exit cleanliness: the user wanted the post-exit prompt at the TOP row
    // (either keep the session history on the main screen, or clear like
    // `clear`). We choose the clear: after ?1049l the pre-session main screen
    // (and its old cursor row) comes back, so a SECOND ESC[2J wipes that main
    // screen too and CSI H parks the cursor at 1,1 — the new shell prompt
    // starts at the top row, exactly like running `clear`.
    const clear = `${CSI}H${CSI}2J`;
    // Legacy conhost: restore mouse tracking + bracketed paste (no alt-screen,
    // no ?1007 — conhost doesn't understand it). All other terminals get the
    // full teardown; ?1007l only if we sent ?1007h (#useAltScroll).
    const restore = this.#legacyWin
      ? `${clear}${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}H${SHOW}`
      : this.#useAltScroll
        ? `${clear}${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}?1049l${clear}${CSI}?1007l${CSI}H${SHOW}`
        : `${clear}${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}?1049l${clear}${CSI}H${SHOW}`;
    process.stdout.write(restore);
  }

  requestPaint(): void {
    if (!this.#running || this.#paintScheduled) return;
    this.#paintScheduled = true;
    this.#paintTimer = setTimeout(() => {
      this.#paintScheduled = false;
      this.#paintTimer = null;
      this.#paint();
    }, 16);
  }

  /** Test/embedding hook: run one paint synchronously (start() not required). */
  paintNow(): void {
    const was = this.#running;
    this.#running = true;
    try {
      this.#paint();
    } finally {
      this.#running = was;
    }
  }

  #tick = (): void => {
    if (!this.#running) return;
    if (this.#opts.busy()) {
      if (!this.#busySince) this.#busySince = Date.now();
      // Delay the spinner (and its repaint loop) for fast operations.
      if (Date.now() - this.#busySince >= SPINNER_DELAY_MS) {
        this.#frame = (this.#frame + 1) % SPINNER.length;
        this.requestPaint();
      }
    } else {
      this.#busySince = 0;
      if (this.#queue.length && !this.#confirm) {
        const line = this.#queue.shift()!;
        this.requestPaint();
        this.#opts.onLine(line);
      }
    }
  };

  #restore = (): void => {
    // ?1007l is only sent when ?1007h was sent (#useAltScroll; Windows Terminal
    // never gets it — see start()). Same clear-then-restore order as stop():
    // ESC[2J wipes the screen the TUI painted on (alt or main), then the
    // alt-screen leave restores the shell, then a second ESC[2J + CSI H wipes
    // the restored main screen and parks the cursor at the top row — the
    // post-exit prompt starts at 1,1 (clear-like).
    const clear = `${CSI}H${CSI}2J`;
    const base = `${clear}${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}?1049l${clear}`;
    process.stdout.write(
      `${base}${this.#useAltScroll ? `${CSI}?1007l` : ""}${CSI}H${SHOW}`,
    );
  };

  /** Begin a bulk insert (session replay): suppress per-item follow/paint. */
  beginBatch(): void {
    this.#batching = true;
  }

  /** End a bulk insert: follow + paint once. */
  endBatch(): void {
    this.#batching = false;
    this.#follow();
    this.requestPaint();
  }

  push(item: TuiItem): void {
    this.#items.push(item);
    this.#panelSeq += 1;
    if (!this.#batching) {
      this.#follow();
      this.requestPaint();
    }
  }

  pushTool(name: string, args: unknown, callId: string): void {
    this.#items.push({
      role: "tool",
      text: name,
      tool: { name, args: fmtArgs(name, args), callId, ok: undefined },
    });
    this.#panelSeq += 1;
    if (!this.#batching) {
      this.#follow();
      this.requestPaint();
    }
  }

  resolveTool(callId: string, ok: boolean, result?: unknown): void {
    let idx = -1;
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const it = this.#items[i];
      if (
        it.role === "tool" &&
        it.tool &&
        it.tool.ok === undefined &&
        it.tool.callId === callId
      ) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = this.#items.length - 1; i >= 0; i -= 1) {
        const it = this.#items[i];
        if (it.role === "tool" && it.tool && it.tool.ok === undefined) {
          idx = i;
          break;
        }
      }
    }
    if (idx >= 0) {
      const view = this.#items[idx].tool!;
      view.ok = ok;
      if (!ok && typeof result === "object" && result !== null) {
        const e = (result as { error?: unknown }).error;
        if (typeof e === "string" && e) view.error = e;
      }
      if (ok && result && typeof result === "object") {
        const d = (result as { _diff?: unknown })._diff;
        if (Array.isArray(d) && d.length) {
          const clean = d.filter(
            (x): x is DiffLine =>
              !!x &&
              typeof x === "object" &&
              ((x as DiffLine).t === "add" || (x as DiffLine).t === "del") &&
              typeof (x as DiffLine).s === "string",
          );
          if (clean.length) {
            const capped = capDiff(clean);
            view.diff = capped.lines;
            view.truncated = capped.truncated;
          }
        }
      }
      let out = "";
      if (typeof result === "string") out = result;
      else if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.stdout === "string" && r.stdout.trim()) out = r.stdout;
        if (r.truncated === true) view.outputCapped = true;
        if (Array.isArray(r.todos)) {
          const clean = (r.todos as unknown[]).filter(
            (x): x is TodoItem =>
              !!x &&
              typeof x === "object" &&
              typeof (x as TodoItem).content === "string" &&
              typeof (x as TodoItem).status === "string",
          );
          if (clean.length) view.todos = clean;
        }
      }
      if (out) {
        view.output = out;
        view.expanded = false;
      }
      this.#invalidateItem(this.#items[idx]);
    }
    if (!this.#batching) this.requestPaint();
  }

  pushDelta(text: string): void {
    this.#panelSeq += 1;
    const last = this.#items[this.#items.length - 1];
    if (last && last.role === "assistant") {
      last.text += text;
      this.#invalidateItem(last);
    } else this.#items.push({ role: "assistant", text });
    if (!this.#batching) {
      this.#follow();
      this.requestPaint();
    }
  }

  resetStream(): void {
    const last = this.#items[this.#items.length - 1];
    if (last && last.role === "assistant") {
      last.text = "";
      this.#invalidateItem(last);
      if (!this.#batching) this.requestPaint();
    }
  }

  /** Drop cached render for a mutated item (and any group containing it). */
  #invalidateItem(item: TuiItem): void {
    this.#itemCache.delete(item);
    this.#groupCache.clear();
    this.#panelSeq += 1;
  }

  pushSystem(text: string, kind: SysKind = "info"): void {
    this.push({ role: "system", text, sysKind: kind });
  }

  /** Restore up-arrow recall from a resumed session (chronological order). */
  seedHistory(lines: string[]): void {
    const clean = lines.filter((l) => l.trim().length > 0);
    this.#history = clean.slice(-200);
    this.#histCursor = -1;
  }

  turnSettled(): void {
    if (this.#pendingExit) {
      this.#pendingExit = false;
      this.stop();
      process.exit(0);
    }
  }

  setStatusRight(text: string): void {
    this.#opts.statusRight = text;
    this.requestPaint();
  }

  askConfirm(question: string, scope: string): Promise<"once" | "always" | "deny"> {
    this.pushSystem(`⚠ approval requested: ${question}`);
    this.#confirmText = `[y] once   [n] no   [a] always ${scope}   ${question}`;
    this.requestPaint();
    return new Promise((resolve) => {
      this.#confirm = (ans) => {
        this.#confirm = null;
        this.#confirmText = "";
        this.pushSystem(ans === "deny" ? "denied" : "approved");
        this.requestPaint();
        resolve(ans);
      };
    });
  }

  /**
   * C (2026-09-05) — one-key grant offered AFTER a Guardian deny.
   * `[g]` grants an allow rule for this scope (same semantics as "always" —
   * the gate writes the rule; it persists to disk when a persist hook exists),
   * `[n]` declines. The gate then denies THIS action (the denial already
   * happened) but the pattern is pre-authorized for the rest of the run.
   * Resolves false for anything other than g/G (Esc, Enter, other keys).
   */
  askGrantScope(tool: string, scope: string): Promise<boolean> {
    this.pushSystem(`guardian denied ${tool} — allow this scope anyway?`);
    // The key handler branches on #confirmMode to map g→"always" (grant) and
    // n/Enter/Esc→deny; without "grant" the [g] key was unhandled.
    this.#confirmMode = "grant";
    this.#confirmText = `[g] grant ${scope}   [n] no`;
    this.requestPaint();
    return new Promise((resolve) => {
      this.#confirm = (ans) => {
        this.#confirm = null;
        this.#confirmText = "";
        const granted = ans === "always";
        this.pushSystem(granted ? "granted — this scope is now pre-authorized" : "grant declined");
        this.requestPaint();
        resolve(granted);
      };
    });
  }

  /**
   * IT#5 — run-or-copy approval for a WRITE shell command. Renders
   * `[R]un / [C]opy / [N]o` and resolves with the choice. The gate owns the
   * side-effects + outcome reporting (it does the clipboard copy for "copy");
   * this method only captures the keyboard choice, so a stub TUI without it
   * falls back to the generic askConfirm. "run" approves execution; "copy"
   * means "put it on the clipboard, don't run it"; "no" denies.
   */
  askRunOrCopy(command: string, scope: string): Promise<"run" | "copy" | "no"> {
    this.pushSystem(`⚠ write command needs approval: ${command}`);
    this.#confirmMode = "runorcopy";
    this.#confirmText = `[R]un   [C]opy   [N]o   ${scope}`;
    this.requestPaint();
    return new Promise((resolve) => {
      this.#confirm = (ans) => {
        this.#confirm = null;
        this.#confirmMode = "confirm";
        this.#confirmText = "";
        this.requestPaint();
        resolve(ans === "once" ? "run" : ans === "always" ? "copy" : "no");
      };
    });
  }

  askQuestion(question: string): Promise<string> {
    this.pushSystem(`❓ ${question}`);
    this.#qbuf = "";
    this.requestPaint();
    return new Promise((resolve, reject) => {
      this.#question = { resolve, reject };
    });
  }

  pushError(text: string): void {
    this.push({ role: "system", text, red: true, sysKind: "error" });
  }

  clearItems(): void {
    this.#items = [];
    this.#queue = [];
    this.#groupOpen.clear();
    this.#scrollTop = 0;
    this.#panelSeq += 1;
    this.requestPaint();
  }

  /** True while a modal overlay picker is open. */
  overlayOpen(): boolean {
    return this.#overlay !== null;
  }

  /**
   * Open a modal fuzzy-filter picker overlay (ctrl-p palette / model switcher).
   * Resolves with the chosen entry index, or "cancel" on Esc/ctrl-c.
   */
  pick(title: string, entries: PickerEntry[]): Promise<PickerOutcome> {
    if (this.#overlay) {
      return Promise.resolve({ kind: "cancel" });
    }
    this.#overlay = {
      title,
      entries,
      filtered: entries.map((_, i) => i),
      query: "",
      sel: Math.max(
        0,
        entries.findIndex((e) => e.active),
      ),
      resolve: () => {},
    };
    this.requestPaint();
    return new Promise((resolve) => {
      this.#overlay!.resolve = resolve;
    });
  }

  #closeOverlay(outcome: PickerOutcome): void {
    const ov = this.#overlay;
    if (!ov) return;
    this.#overlay = null;
    ov.resolve(outcome);
    this.requestPaint();
  }

  #applyOverlayFilter(): void {
    const ov = this.#overlay!;
    if (ov.help) {
      // read-only dialog: no filtering, selection stays at the top
      ov.filtered = ov.entries.map((_, i) => i);
      ov.sel = 0;
      return;
    }
    const q = ov.query.toLowerCase().trim();
    if (!q) {
      ov.filtered = ov.entries.map((_, i) => i);
    } else {
      // subsequence match against "label hint" so "qs" finds "switch model"
      const hits: number[] = [];
      for (let i = 0; i < ov.entries.length; i += 1) {
        const hay = `${ov.entries[i].label} ${ov.entries[i].hint ?? ""}`.toLowerCase();
        let pos = 0;
        for (const c of q) {
          pos = hay.indexOf(c, pos);
          if (pos < 0) break;
          pos += 1;
        }
        if (pos >= 0) hits.push(i);
      }
      ov.filtered = hits;
    }
    ov.sel = Math.min(ov.sel, Math.max(0, ov.filtered.length - 1));
    if (!ov.filtered.includes(ov.sel)) {
      ov.sel = 0;
    }
  }

  #overlaySeq(ch: string): void {
    if (ch === "\x1b") {
      const now = Date.now();
      if (this.#held === "\x1b" && now - this.#escAt < 500) {
        this.#held = "";
        this.#closeOverlay({ kind: "cancel" });
        return;
      }
      this.#escAt = now;
      this.#held = "\x1b";
      return;
    }
    if (!this.#held) return;
    if (this.#held === "\x1b" && (ch === "[" || ch === "O")) {
      this.#held += ch;
      this.#escAt = 0;
      return;
    }
    this.#held += ch;
    if (/[A-Za-z~]/.test(ch)) {
      const kind = this.#held.slice(2);
      this.#held = "";
      switch (kind) {
        case "A": // up
          this.#overlayMove(-1);
          break;
        case "B": // down
          this.#overlayMove(1);
          break;
        case "200~": // bracketed paste start
          this.#inPaste = true;
          break;
        case "201~": // bracketed paste end
          this.#inPaste = false;
          break;
        default: // other sequences (mouse, pgup…) just close nothing — ignore
          break;
      }
    }
  }

  /** Open the read-only help dialog (keybindings / states / commands). */
  openHelp(): void {
    if (this.#overlay) return;
    this.#overlay = {
      title: "help",
      entries: [{ label: "help" }],
      filtered: [0],
      query: "",
      sel: 0,
      help: true,
      resolve: () => {},
    };
    this.requestPaint();
  }

  #overlayMove(delta: number): void {
    const ov = this.#overlay!;
    if (!ov.filtered.length) return;
    ov.sel = Math.min(ov.filtered.length - 1, Math.max(0, ov.sel + delta));
    this.requestPaint();
  }

  #overlayKey(ch: string): void {
    const ov = this.#overlay!;
    switch (ch) {
      case "\x1b": // bare Esc (raw mode delivers it as a lone byte here)
      case "\x03":
        this.#closeOverlay({ kind: "cancel" });
        return;
      case "\r":
      case "\n":
        if (ov.help) {
          this.#closeOverlay({ kind: "cancel" });
          return;
        }
        if (ov.filtered.length) {
          const index = ov.filtered[ov.sel] ?? 0;
          this.#closeOverlay({ kind: "select", index });
        }
        return;
      case "\x7f":
        if (ov.query) {
          ov.query = ov.query.slice(0, -1);
          this.#applyOverlayFilter();
          this.requestPaint();
        }
        return;
      case "\x15":
        if (ov.query) {
          ov.query = "";
          this.#applyOverlayFilter();
          this.requestPaint();
        }
        return;
      default: {
        // arrow keys arrive as ESC [ A/B — #feed splits them, so handle
        // the final letter only when it follows an ESC-[ prefix
        if (ch === "A" || ch === "B" || ch === "C" || ch === "D") return; // handled in #escape
        if (ch === "\x0e") { this.#overlayMove(1); return; } // ctrl-n
        if (ch === "\x10") { this.#overlayMove(-1); return; } // ctrl-p moves within the palette
        if (ch >= " ") {
          ov.query += ch;
          this.#applyOverlayFilter();
          this.requestPaint();
        }
      }
    }
  }

  #escAt = 0;
  #lastBareEscAt = 0;
  /**
   * Last time a real escape SEQUENCE (CSI/SS3/SGR/OSC/DCS — mouse, scroll,
   * paste marker, title) was consumed by #escape. A double-Esc must not fire
   * within a hair of one, because leftover escape bytes flushed by a conpty
   * child (e.g. a PowerShell process that run_cmd spawned) look exactly like a
   * user's Esc-Esc when they arrive back-to-back — but they are terminal
   * noise, not a cancel gesture. Only a second \x1b arriving well after the
   * sequence has settled counts as the user pressing Esc again.
   */
  #lastSeqAt = 0;

  #doubleEsc(): void {
    const wasBusy = this.#opts.busy();
    this.#edit = "";
    this.#cursor = 0;
    if (wasBusy) {
      this.pushSystem("turn cancelled");
      this.#opts.cancelTurn?.();
    }
    this.requestPaint();
  }

  #inPaste = false;

  /** Bracketed paste (DEC 2004): while `#inPaste` is set — between the
   *  ESC[200~ and ESC[201~ markers — every payload byte is inserted as literal
   *  text instead of acting as a key press, so a multi-line paste can never
   *  look like Enter presses (no submits, no overlay selection, no question
   *  answers, no confirm). The markers themselves are ordinary escape
   *  sequences for the reassembly machine below (see #escape / #overlaySeq),
   *  which also keeps them working if split across stdin read events. This
   *  mirrors how opencode/opentui deliver paste as one literal-text event to
   *  the editor widget. */
 #feed(data: string): void {
    // The OSC 11 background-query answer (requested in start()) arrives on
    // stdin and must be consumed as data, never typed as keystrokes.
    const m = OSC11_BG.exec(data);
    if (m) {
      // Each channel may be 4–8 hex digits (16–32 bits); normalize to 0–1
      // by its own width so luminance is width-agnostic.
      const norm = (hex: string) => parseInt(hex, 16) / (Math.pow(16, hex.length) - 1);
      const r = norm(m[1]);
      const g = norm(m[2]);
      const b = norm(m[3]);
      this.#dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
      data = data.slice(m[0].length);
    }
    // Windows consoles (conhost, and some emulators) report Backspace as BS
    // (\x08) instead of DEL (\x7f). Normalize ONCE here so every input path —
    // composer, question, confirm, overlay filter, paste — treats \x08 as
    // backspace (readline tradition also conflates Ctrl+H this way). Doing it
    // in #feed rather than at each `case "\x7f"` keeps the key grammar in one
    // place. (opencode tracks the same Windows quirk in its win32 TUI shims.)
    data = data.replace(/\x08/g, "\x7f");
    for (const ch of data) this.#char(ch);
  }

  #pasteWs = false;

  /** Insert one bracketed-paste payload byte into the active text context. */
  #pasteChar(ch: string): void {
    let t = "";
    if (ch === "\r" || ch === "\n" || ch === "\t") {
      if (this.#pasteWs) return; // collapse CRLF / repeated line breaks to one space
      this.#pasteWs = true;
      t = " "; // composer is single-line
    } else if (ch >= " " && ch !== "\x7f") {
      this.#pasteWs = false;
      t = ch;
    } else {
      return;
    }
    if (!t) return;
    if (this.#confirm) return; // a paste must never answer y/a/n
    if (this.#overlay) {
      this.#overlay.query += t;
      this.#applyOverlayFilter();
      this.requestPaint();
      return;
    }
    if (this.#question) {
      this.#qbuf += t;
      this.requestPaint();
      return;
    }
    this.#edit = this.#edit.slice(0, this.#cursor) + t + this.#edit.slice(this.#cursor);
    this.#cursor += 1;
    this.requestPaint();
  }

  /** Test hook: feed raw key bytes exactly as the stdin data handler would. */
  feed(data: string): void {
    this.#feed(data);
  }

 #char(ch: string): void {
    // Bracketed-paste payload bytes: always literal text — except ESC and
    // mid-sequence bytes, which must reach the escape machine so the
    // ESC[201~ terminator can complete even mid-paste.
    if (this.#inPaste && ch !== "\x1b" && !this.#held) {
      this.#pasteChar(ch);
      return;
    }
    // Keybind dispatch (opencode `keybinds` parity): an incoming byte that a
    // configured keybind maps to an action fires that action. The palette byte
    // (default ctrl-p) and help-byte (default ?) both live here. Overlay /
    // question / confirm states take precedence so a remap never hijacks a
    // modal prompt's own keys.
    if (!this.#overlay && !this.#question && !this.#confirm) {
      const action = this.#keybinds[ch];
      if (action === "palette") {
        this.#opts.onPalette?.();
        return;
      }
      if (action === "toggleMode") {
        this.#opts.onTab?.();
        return;
      }
      if (action === "help") {
        // Help only on an empty, idle composer; otherwise it's a plain '?'.
        if (ch === "?" && this.#edit === "") {
          this.openHelp();
          return;
        }
      }
    }
    if (this.#overlay) {
      if (ch === "\x1b" || this.#held) {
        this.#overlaySeq(ch);
        return;
      }
      if (this.#inPaste) {
        this.#pasteChar(ch);
        return;
      }
      this.#overlayKey(ch);
      return;
    }
    if (this.#question) {
      if (this.#inPaste && (ch === "\x1b" || this.#held)) {
        // Mid-paste escape machinery: RUN the escape machine so the paste-end
        // terminator (ESC [ 2 0 1 ~) is actually parsed and `#inPaste` clears.
        // The old empty fall-through never invoked the machine, so the ESC
        // byte was dropped and the remaining "[201~" bytes were treated as
        // ordinary paste content — they leaked into the answer buffer AND
        // `#inPaste` stayed true forever, which swallowed Enter (became a
        // space) and Ctrl+C (ignored by #pasteChar) — a stuck prompt.
        this.#escapeSeq(ch);
        return;
      } else if (ch === "\x1b" || this.#held) {
        // Escape sequence (scroll keys, arrows, mouse) — do NOT swallow its
        // bytes as answer text; run the escape machine so the user can still
        // scroll the transcript while a `question` prompt is open.
        //
        // BUT a bare Esc's follow-up byte is NOT part of a sequence: the
        // machine clears #held and consumes the byte as the double-Esc
        // detector's timing sample. If we returned here, the user's NEXT real
        // keypress (backspace / tab / Enter) would be the one swallowed — the
        // observed "backspace doesn't work after Esc, need to press Enter
        // twice" bug. When the machine consumed the held bare-Esc (held went
        // from "\x1b" to "" on a non-escape byte), fall through to the answer
        // handling below so that byte is processed as an answer key.
        const heldBefore = this.#held;
        this.#escapeSeq(ch);
        if (ch === "\x1b" || this.#held) return;
        if (!(heldBefore === "\x1b")) return;
        // fall through: this byte belongs to the answer, not to a sequence
      }
      const done = this.#question;
      if (ch === "\r" || ch === "\n") {
        this.#question = null;
        const answer = this.#qbuf;
        this.#qbuf = "";
        this.requestPaint();
        done.resolve(answer);
      } else if (ch === "\x03") {
        this.#question = null;
        this.#qbuf = "";
        this.requestPaint();
        done.reject(new Error("user cancelled the question"));
      } else if (ch === "\x7f") {
        this.#qbuf = this.#qbuf.slice(0, -1);
        this.requestPaint();
      } else if (ch >= " ") {
        this.#qbuf += ch;
        this.requestPaint();
      }
      return;
    }
    if (this.#confirm) {
      // Mouse/escape sequences must NOT be treated as answer keys: the first
      // byte \x1b of an SGR mouse event (\x1b<0;col;rowM) would match `refuse`
      // (ch === "\x1b") and auto-deny the prompt on every click. Route escape
      // sequences through #escapeSeq (handles scroll/click); only plain keys
      // reach the accept/refuse logic below.
      if (ch === "\x1b" || this.#held) {
        this.#escapeSeq(ch);
        return;
      }
      if (!(this.#inPaste && (ch === "\x1b" || this.#held))) {
        const done = this.#confirm;
        const roc = this.#confirmMode === "runorcopy";
        // IT#5 — run-or-copy keys: r=run(once), c=copy(always), n/no.
        // C — grant-scope prompt (after a Guardian deny): g=grant → maps to
        // "always" (askGrantScope resolves granted = ans === "always"), so the
        // gate writes the allow rule; n/Enter/Esc decline. Previously the [g]
        // key was unhandled (only y/n/a were wired) and fell into the ignore
        // branch, so pressing g did nothing — the reported Linux bug.
        const grant = this.#confirmMode === "grant";
        // confirm keys (unchanged): y=once, a=always, n/deny.
        // Esc denies: the footer advertises Esc as the cancel affordance and
        // a bare Esc here used to fall through all branches and get eaten by
        // the double-Esc detector, leaving the approval wedged.
        const accept = roc
          ? ch === "r" || ch === "R"
          : grant
            ? ch === "g" || ch === "G"
            : ch === "y" || ch === "Y";
        const secondary = roc ? ch === "c" || ch === "C" : ch === "a" || ch === "A";
        const refuse =
          ch === "n" || ch === "N" || ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\x1b";
        if (accept) {
          // grant-scope: the single affirmative key (g) IS the grant — resolve
          // "always" so askGrantScope sees granted=true. (Previously it resolved
          // "once", which askGrantScope treats as a decline — the reported bug
          // where pressing g showed "grant declined".)
          done(grant ? "always" : "once");
        } else if (secondary) {
          done("always");
        } else if (refuse) {
          done("deny");
        } else {
          this.#confirm = done;
        }
        return;
      }
    }
    if (ch === "\x1b" || this.#held) {
      this.#escapeSeq(ch);
      return;
    }
    switch (ch) {
      case "\r":
      case "\n": {
        const line = this.#edit;
        // A — empty composer Enter expands/collapses the focused tool block
        // (only path to expand on legacy Windows conhost, which has no mouse).
        if (!line.trim()) {
          this.#toggleFocus();
          this.requestPaint();
          return;
        }
        this.#edit = "";
        this.#cursor = 0;
        if (line.trim() === "exit" || line.trim() === "/quit") {
          if (this.#opts.busy()) {
            this.#pendingExit = true;
            this.pushSystem("cancelling turn…");
            this.#opts.cancelTurn?.();
            return;
          }
          this.stop();
          process.exit(0);
        }
        this.#history.push(line);
        if (this.#history.length > 200) this.#history.shift();
        this.#histCursor = -1;
        if (this.#opts.busy()) {
          // P#35: prefer live steering — the host injects into the running
          // turn so the message lands before the next step, not after the
          // whole turn. Only queue when the host declines.
          const steered = this.#opts.onLineBusy?.(line) ?? false;
          if (!steered) {
            this.#queue.push(line);
            this.pushSystem(
              // known slash → will run as a command once the turn finishes
              (line.trim().startsWith("/") && this.#opts.onLineKnownSlash?.(line.trim())) === true
                ? `queued (runs right after the current turn finishes): ${line}`
                : `queued: ${line}`,
            );
          }
        } else {
          this.#opts.onLine(line);
        }
        this.requestPaint();
        return;
      }
      case "\x03":
        if (!this.#edit) {
          if (this.#opts.busy()) {
            this.pushSystem("turn cancelled");
            this.#opts.cancelTurn?.();
            return;
          }
          this.stop();
          process.exit(0);
        }
        this.#edit = "";
        this.#cursor = 0;
        this.requestPaint();
        return;
      case "\x15":
        this.#edit = "";
        this.#cursor = 0;
        this.requestPaint();
        return;
      case "\x7f":
        if (this.#cursor > 0) {
          this.#edit = this.#edit.slice(0, this.#cursor - 1) + this.#edit.slice(this.#cursor);
          this.#cursor -= 1;
          this.requestPaint();
        }
        return;
      case "o":
      case "O": {
        // A — `o` on an empty composer toggles the focused tool block too
        // (mnemonic "open"; keyboard-only path for legacy Windows conhost).
        if (!this.#edit.trim()) {
          this.#toggleFocus();
          this.requestPaint();
        } else {
          this.#edit =
            this.#edit.slice(0, this.#cursor) + ch + this.#edit.slice(this.#cursor);
          this.#cursor += 1;
          this.requestPaint();
        }
        return;
      }
      case "\t": {
        const ghost = this.#ghost();
        if (ghost) {
          this.#setEdit(this.#edit + ghost);
        } else {
          this.#opts.onTab?.();
        }
        return;
      }
      default:
        if (ch >= " ") {
          this.#edit =
            this.#edit.slice(0, this.#cursor) + ch + this.#edit.slice(this.#cursor);
          this.#cursor += 1;
          this.requestPaint();
        }
    }
  }

  #escapeSeq(ch: string): void {
    if (ch === "\x1b") {
      const now = Date.now();
      if (this.#escAt > 0 && this.#held === "\x1b" && now - this.#escAt < 500) {
        this.#escAt = 0;
        this.#lastBareEscAt = 0;
        this.#held = "";
        // Same conpty-noise hardening as below: two \x1b bytes landing right
        // after a consumed escape sequence are residual terminal bytes (split
        // CSI trailing ESC), not the user's Esc-Esc cancel. Require the last
        // sequence to have settled before honouring the gesture.
        if (now - this.#lastSeqAt >= ESC_NOISE_MS) {
          this.#doubleEsc();
        }
        return;
      }
      this.#escAt = now;
      this.#held = "\x1b";
      // Confirm prompt: a LONE Esc means deny (the footer advertises Esc as
      // the cancel affordance). e055216 routed all \x1b bytes through the
      // escape machine (so SGR mouse bursts can't auto-deny), which orphaned
      // the single-Esc case — nothing ever resolved it and the approval
      // wedged forever (deterministic: "confirm Esc denies (got TIMEOUT)").
      // Resolution: if no sequence-continuation byte has consumed the held
      // Esc within a hair (60ms), it was a real Esc → deny. A mouse/scroll
      // burst continues with '['/'O'/'<' within the same stdin read, so it
      // never hits the timer; a second Esc clears #held first (double-Esc
      // branch), also safe.
      const confirm = this.#confirm;
      if (confirm) {
        const timer = setTimeout(() => {
          if (this.#confirm === confirm && this.#held === "\x1b") {
            this.#held = "";
            this.#escAt = 0;
            this.#lastBareEscAt = 0;
            confirm("deny");
          }
        }, 60);
        // A pending Esc-deny must never keep a headless process alive.
        timer.unref?.();
      }
      return;
    }
    if (this.#held === "\x1b") {
      // '[' / 'O' start a CSI/SS3 sequence. ']' starts an OSC (operating-system
      // command, e.g. tmux/terminal title: ESC ] 0;title BEL), and 'P' starts a
      // DCS (device control string, e.g. tmux passthrough). All three are
      // TERMINAL-control sequences, not user input — absorb them instead of
      // treating the follow-up ESC as a second bare-Esc (double-Esc cancel).
      // Observed bug: tmux repainting its status line / title fired OSC/DCS
      // ESC bursts that were misread as double-Esc, cancelling an active turn.
      // '[' starts CSI, 'O' starts SS3, '<' starts SGR mouse (ESC < btn;col;row M/m).
      if (ch === "[" || ch === "O" || ch === "<") {
        this.#escAt = 0;
        this.#held += ch;
        return;
      }
      if (ch === "]" || ch === "P") {
        this.#escAt = 0;
        this.#lastBareEscAt = 0;
        this.#held = ch === "]" ? "osc:" : "dcs:";
        return;
      }
      const now = Date.now();
      if (this.#lastBareEscAt > 0 && now - this.#lastBareEscAt < 500) {
        this.#lastBareEscAt = 0;
        // Harden against conpty leftover-escapes: a second \x1b right after a
        // consumed escape sequence (within ESC_NOISE_MS) is almost certainly
        // residual terminal noise (the paste/CSI was split, and the trailing
        // \x1b arrived separately), not the user pressing Esc again — ignore
        // it instead of cancelling a running turn. Genuine double-Esc presses
        // are spaced apart by human timing, so this never eats a real one.
        if (now - this.#lastSeqAt >= ESC_NOISE_MS) {
          this.#doubleEsc();
        }
      } else {
        this.#lastBareEscAt = now;
      }
      this.#held = "";
    } else if (this.#held === "osc:" || this.#held === "dcs:") {
      // OSC/DCS payload absorbed until terminator (BEL / ST ESC\ ).
      if (ch === "\x07") this.#held = ""; // BEL ends OSC
      else if (ch === "\x1b") this.#held = "\x1boscST"; // ESC begins ST; next '\' closes
      // else: keep absorbing payload
    } else if (this.#held === "\x1boscST") {
      // '\' completes ST (ESC \); anything else resets to absorbing the OSC.
      this.#held = ch === "\\" ? "" : ch === "\x07" ? "" : "osc:";
    } else {
      this.#held += ch;
      const final = /[A-Za-z~]/.test(ch);
      if (this.#held.length >= 2 && final) this.#escape(this.#held);
    }
  }

  #escape(seq: string): void {
    this.#held = "";
    // Any real CSI/SS3/SGR sequence consumes the ESC deliberately — it is
    // terminal noise (mouse/scroll/paste/OSC), NOT a bare-Esc keystroke.
    // Reset the bare-Esc pair timer so a sequence burst (e.g. leftover
    // escape bytes flushed by a conpty child process after run_cmd exits)
    // can never pair with a neighboring bare \x1b into a double-Esc cancel.
    // Observed bug (Windows): `run_cmd` → PowerShell exits → terminal flushes
    // residual ESC/[20~ bytes → TUI misread them as double-Esc, auto-cancelled
    // the running turn, and leaked "[20~" into the composer.
    this.#lastBareEscAt = 0;
    this.#lastSeqAt = Date.now();
    const kind = seq.slice(2);
    if (kind.startsWith("<")) {
      const m = /^<(\d+);(\d+);(\d+)([Mm])$/.exec(kind);
      if (m) {
        const button = Number(m[1]);
        const row = Number(m[3]);
        if (button === 64 || button === 4) {
          this.#sgrWheelSeen = true;
          this.#scrollBy(-3);
        } else if (button === 65 || button === 5) {
          this.#sgrWheelSeen = true;
          this.#scrollBy(3);
        } else if (m[4] === "M" && button === 0) this.#clickAt(row);
      }
      return;
    }
    switch (kind) {
      case "200~": // bracketed paste start
        this.#inPaste = true;
        break;
      case "201~": // bracketed paste end
        this.#inPaste = false;
        break;
      case "A":
        this.#arrowKey(-1);
        break;
      case "B":
        this.#arrowKey(1);
        break;
      case "C":
        this.#cursor = Math.min(this.#edit.length, this.#cursor + 1);
        this.requestPaint();
        break;
      case "D":
        this.#cursor = Math.max(0, this.#cursor - 1);
        this.requestPaint();
        break;
      case "5~":
        this.#scrollBy(-this.#viewHeight());
        break;
      case "6~":
        this.#scrollBy(this.#viewHeight());
        break;
      case "H":
      case "OH":
        this.#scrollTop = 0;
        this.requestPaint();
        break;
      case "F":
      case "OF":
        this.#follow();
        this.requestPaint();
        break;
      case "1;3A": // Alt+Up — P#35: recall the last queued/busy-line message
      case "1;3a": // (some terminals report it lowercase)
        this.recallQueued();
        break;
      default:
        break;
    }
  }

  /**
   * P#35 — Alt+Up: pull the most recent queued (or steering-declined) input
   * back into the editor for editing and resubmission. Nothing is lost: the
   * entry is removed from the queue and becomes editable text.
   */
  recallQueued(): void {
    if (!this.#queue.length) {
      this.pushSystem("no queued messages to recall");
      return;
    }
    const line = this.#queue.pop()!;
    this.#setEdit(line);
    this.requestPaint();
  }

  /** Queued-message accessors (test hook + status display). */
  queueSize(): number {
    return this.#queue.length;
  }

  /** Current editor content (test hook). */
  editText(): string {
    return this.#edit;
  }

  #chooseHistory(): void {
    this.#setEdit(this.#histCursor < 0 ? "" : this.#history[this.#histCursor]);
  }

  #setEdit(value: string): void {
    this.#edit = value;
    this.#cursor = value.length;
    this.requestPaint();
  }

  /**
   * ↑/↓ arrow: composer input-history recall — UNLESS the keys arrive as a
   * rapid burst, which is the signature of a mouse WHEEL delivered as arrows
   * because mouse tracking was silently cleared mid-session (terminal quirk,
   * multiplexer reset; the modes we set in start() only die this way). The
   * user scrolled the transcript and got input-history recall instead —
   * exactly the reported "scroll breaks and starts editing the input line"
   * bug. Fix: re-assert the tracking modes (?1000/?1006/?1007) and undo the
   * burst — restore the composer to its pre-burst text (the first arrows of
   * the flick already recalled history over whatever the user had typed) so
   * the flick leaves the composer untouched. If the terminal honours the
   * re-assert, wheel events arrive as SGR again (#sgrWheelSeen re-arms for
   * the next loss). If it never sends SGR at all, only this first burst is
   * swallowed — later bursts pass through as normal arrow recall.
   */
  #arrowKey(dir: -1 | 1): void {
    const now = Date.now();
    this.#arrowTimes.push(now);
    this.#arrowTimes = this.#arrowTimes.filter((t) => now - t <= 900);
    if (this.#arrowTimes.length === 1) {
      // Fresh burst window: the previous flick is over — pass arrows through
      // again and snapshot the composer so a burst inside THIS window can be
      // undone completely.
      this.#swallowArrows = false;
      this.#burstSnapshot = { edit: this.#edit, cursor: this.#cursor, hist: this.#histCursor };
    }
    if (!this.#legacyWin && this.#sgrWheelSeen && this.#arrowTimes.length >= 3) {
      if (this.#burstSnapshot) {
        this.#edit = this.#burstSnapshot.edit;
        this.#cursor = this.#burstSnapshot.cursor;
        this.#histCursor = this.#burstSnapshot.hist;
      }
      // Keep #arrowTimes — clearing it would re-open the window instantly and
      // let the rest of this same flick through. The window expires on its
      // own (900ms), ending the swallow.
      this.#sgrWheelSeen = false;
      this.#swallowArrows = true; // swallow the rest of this flick
      if (this.#running || process.stdout.isTTY) {
        process.stdout.write(
          this.#useAltScroll
            ? `${CSI}?1000h${CSI}?1006h${CSI}?1007h`
            : `${CSI}?1000h${CSI}?1006h`,
        );
      }
      if (!this.#mouseHintShown) {
        this.#mouseHintShown = true;
        this.pushSystem(
          "mouse tracking was lost (wheel arrived as arrow keys) — re-enabled; scroll the transcript again",
        );
      }
      this.requestPaint();
      return;
    }
    if (this.#swallowArrows) return; // rest of the burst: not a real ↑/↓
    if (dir === -1) {
      if (this.#history.length) {
        if (this.#histCursor < 0) this.#histCursor = this.#history.length - 1;
        else this.#histCursor = Math.max(0, this.#histCursor - 1);
        this.#chooseHistory();
      }
    } else if (this.#histCursor >= 0) {
      this.#histCursor += 1;
      if (this.#histCursor >= this.#history.length) this.#histCursor = -1;
      this.#chooseHistory();
    }
  }

  #scrollBy(delta: number): void {
    const maxTop = Math.max(0, this.#contentLines() - this.#viewHeight());
    this.#scrollTop = Math.min(maxTop, Math.max(0, this.#scrollTop + delta));
    this.requestPaint();
  }

  #clickAt(row: number): void {
    if (this.#overlay) return; // modal is open: never toggle transcript items beneath it
    if (!this.#bodyUnitIdx.length) return;
    const view = this.#viewHeight();
    if (row < 1 || row > view) return;
    const ui = this.#bodyUnitIdx[row - 1 + this.#scrollTop];
    if (ui === undefined) return;
    const u = this.#units()[ui];
    if (!u) return;
    if (u.kind === "group") {
      this.#groupOpen.set(u.start, !this.#groupOpen.get(u.start));
      this.#groupCache.delete(u.start);
      this.#focusUnit = ui;
      this.requestPaint();
      return;
    }
    const item = u.item;
    if (!item?.tool || typeof item.tool.output !== "string") return;
    item.tool.expanded = !item.tool.expanded;
    this.#invalidateItem(item);
    this.#focusUnit = ui;
    this.requestPaint();
  }

  /**
   * A — keyboard expand/collapse for the focused unit (Enter/o on an empty
   * composer). On legacy Windows console there are no mouse events at all, so
   * this is the only way to expand a tool output / group there.
   * - groups: toggle the open flag.
   * - tool items with output: toggle `expanded`.
   * Falls back to the LAST collapsible unit when nothing is focused.
   */
  #toggleFocus(): void {
    if (this.#overlay || this.#question || this.#confirm) return;
    const units = this.#units();
    if (!units.length) return;
    let i = this.#focusUnit;
    if (i < 0 || i >= units.length) {
      // fall back: last unit that is expandable (tool w/ output, or group)
      for (let k = units.length - 1; k >= 0; k -= 1) {
        const u = units[k];
        const can =
          u.kind === "group" ||
          (u.kind === "item" && !!u.item.tool && typeof u.item.tool.output === "string");
        if (can) {
          i = k;
          break;
        }
      }
      if (i < 0) return;
    }
    const u = units[i];
    if (u.kind === "group") {
      this.#groupOpen.set(u.start, !this.#groupOpen.get(u.start));
      this.#groupCache.delete(u.start);
    } else {
      const it = u.item;
      if (!it.tool || typeof it.tool.output !== "string") return;
      it.tool.expanded = !it.tool.expanded;
      this.#invalidateItem(it);
    }
    this.#focusUnit = i;
    this.#follow();
    this.requestPaint();
  }

  #follow(): void {
    this.#scrollTop = Math.max(0, this.#contentLines() - this.#viewHeight());
  }

  /**
   * T#22 — search across tool outputs (the expanded content, incl. the 32KB
   * in-band cap). Returns matches in transcript order; expands any matched
   * tool (and its collapsed group) and scrolls the first match into view.
   */
  searchTools(query: string): { n: number; matches: Array<{ item: number; tool: string; callId: string; line: number; snippet: string }> } {
    const q = query.toLowerCase();
    const matches: Array<{ item: number; tool: string; callId: string; line: number; snippet: string }> = [];
    if (!q) return { n: 0, matches };
    this.#items.forEach((it, idx) => {
      const t = it.tool;
      if (!t || typeof t.output !== "string" || !t.output.trim()) return;
      const lines = t.output.split("\n");
      for (let li = 0; li < lines.length; li += 1) {
        if (lines[li].toLowerCase().includes(q)) {
          matches.push({
            item: idx,
            tool: t.name,
            callId: t.callId,
            line: li + 1,
            snippet: lines[li].trim().slice(0, 96),
          });
          if (matches.length >= 50) return;
        }
      }
    });
    if (!matches.length) return { n: 0, matches };
    // Expand the matched tools (and any collapsed group they live in) so the
    // match is actually visible, then scroll the first match into view.
    const first = matches[0].item;
    const units = this.#units();
    for (const u of units) {
      if (u.kind === "group" && u.start <= first && first < u.start + u.items.length) {
        this.#groupOpen.set(u.start, true);
        this.#groupCache.delete(u.start);
      }
    }
    const it = this.#items[first];
    if (it.tool) it.tool.expanded = true;
    this.#invalidateItem(it);
    // best-effort scroll: land the first match ~1/3 down the viewport
    const view = this.#viewHeight();
    const target = Math.max(0, this.#contentLines() - view);
    this.#scrollTop = Math.max(0, Math.min(target, Math.max(0, target - 3)));
    this.requestPaint();
    return { n: matches.length, matches };
  }

  #viewHeight(): number {
    const pw = this.#panelWidth();
    const w = pw ? Math.max(20, this.#cols - pw - Tui.PANEL_GAP) : this.#cols;
    const k = this.#inputLineCount(w);
    // Fixed bottom rows: pad-above + box-top + box-bottom + pad-below +
    // hints + status = 6 (the separate meta box row and dashed separator were
    // folded into the status line, dropping 2).
    return Math.max(1, this.#rows - 6 - k);
  }

  #inputLineCount(width: number): number {
    if (this.#confirmText) return 1;
    if (this.#question) {
      const limit = Math.max(4, width - 6);
      return Math.min(Tui.INPUT_MAX_ROWS, this.#wrapEdit(this.#qbuf, limit).length);
    }
    const limit = Math.max(4, width - 6); // 2-space wrap indent fits inner (width-4)
    // opencode/mimo-code parity: the composer never grows past TEXTAREA_MAX_ROWS=6
    // — it scrolls internally. Cap here so #viewHeight stays stable for long
    // pastes (a 20-line paste must not shrink the body to zero rows).
    return Math.min(Tui.INPUT_MAX_ROWS, this.#wrapEdit(this.#edit, limit).length);
  }

  #contentLines(): number {
    let n = 0;
    for (const u of this.#units()) {
      n += u.kind === "item" ? this.#block(u.item).length : this.#groupLines(u).length;
    }
    return n;
  }

  #wrap(raw: string, limit: number): string[] {
    const out: string[] = [];
    for (const seg of raw.split("\n")) {
      const words = seg ? seg.split(/\s+/).filter(Boolean) : [];
      let line = "";
      const flush = (): void => {
        out.push(line);
        line = "";
      };
      for (const word of words) {
        let rest = word;
        while (rest.length > 0) {
          const sep = line ? 1 : 0;
          const avail = Math.max(1, limit - cols(line) - sep);
          if (cols(rest) <= avail) {
            line = line ? `${line} ${rest}` : rest;
            rest = "";
            continue;
          }
          // Word does not fit the remaining space but fits a fresh line:
          // break at the word boundary (never split "npm" into "np"/"m").
          if (line && cols(word) <= limit) {
            flush();
            continue;
          }
          // Word longer than the whole line: hard-split at display width.
          let cut = 0;
          let n = 0;
          while (cut < rest.length) {
            const w = width(rest[cut]);
            if (n + w > avail) break;
            n += w;
            cut += 1;
          }
          if (cut === 0) cut = 1;
          line = line ? `${line} ${rest.slice(0, cut)}` : rest.slice(0, cut);
          rest = rest.slice(cut);
          flush();
        }
      }
      flush();
    }
    return out.length ? out : [""];
  }

  #markdown(text: string, limit: number): string[] {
    const out: string[] = [];
    const prefixed = (pre: string, mdText: string, restyleBody?: (s: string) => string): void => {
      const marker = pre.endsWith(" ") ? pre : `${pre} `;
      const pw = cols(marker);
      let styled = inlineMd(mdText);
      if (restyleBody) styled = restyle(styled, restyleBody);
      const body = wrapStyled(styled, Math.max(1, limit - pw));
      out.push(`${marker}${body[0] ?? ""}`);
      for (let i = 1; i < body.length; i += 1) {
        out.push(`${" ".repeat(pw)}${body[i]}`);
      }
    };
    const renderLine = (t: string): void => {
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        out.push(...wrapStyled(bold(inlineMd(h[2].trim())), limit));
        return;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(t)) {
        out.push(dim("─".repeat(Math.min(limit, 48))));
        return;
      }
      const q = /^\s*>\s?(.*)$/.exec(t);
      if (q) {
        prefixed(yellow(italic("> ")), q[1], (b) => yellow(italic(b)));
        return;
      }
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(t);
      if (li) {
        const marker = /^\d/.test(li[1]) ? cyan(`${li[1]} `) : blue("•");
        prefixed(marker, li[2]);
        return;
      }
      out.push(...wrapStyled(inlineMd(t), limit));
    };
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let inCode = false;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      if (/^\s*```/.test(raw)) {
        inCode = !inCode;
        i += 1;
        continue;
      }
      const t = raw.replace(/\s+$/, "");
      if (!t.trim()) {
        out.push("");
        i += 1;
        continue;
      }
      if (inCode) {
        out.push(...wrapStyled(highlightCode(t), limit));
        i += 1;
        continue;
      }
      // Markdown table: a run of pipe rows that includes a `|---|` separator.
      if (isTableRow(t)) {
        const block: string[] = [];
        let j = i;
        while (j < lines.length && isTableRow(lines[j].replace(/\s+$/, ""))) {
          block.push(lines[j].replace(/\s+$/, ""));
          j += 1;
        }
        if (block.some(isSeparatorRow)) {
          const rows = block.filter((l) => !isSeparatorRow(l)).map(splitTableRow);
          if (rows.length) {
            out.push(...renderTable(rows, limit));
            i = j;
            continue;
          }
        }
      }
      renderLine(t);
      i += 1;
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  #groupable(it: TuiItem): boolean {
    const t = it.tool;
    if (!t) return false;
    if (t.ok === false) return false;
    if (typeof t.output === "string" && t.output.trim()) return false;
    if (t.diff && t.diff.length) return false;
    return true;
  }

  #units(): Unit[] {
    const units: Unit[] = [];
    let i = 0;
    while (i < this.#items.length) {
      const it = this.#items[i];
      if (it.role === "tool" && this.#groupable(it)) {
        let j = i + 1;
        while (j < this.#items.length) {
          const nx = this.#items[j];
          if (nx.role === "tool" && this.#groupable(nx) && nx.tool!.name === it.tool!.name) j += 1;
          else break;
        }
        if (j - i >= 2) {
          units.push({ kind: "group", start: i, items: this.#items.slice(i, j) });
          i = j;
          continue;
        }
      }
      units.push({ kind: "item", index: i, item: it });
      i += 1;
    }
    return units;
  }

  #groupLines(g: { start: number; items: TuiItem[] }): string[] {
    const w = this.#bodyCols();
    const d = this.#dark;
    const open = !!this.#groupOpen.get(g.start);
    const c = this.#groupCache.get(g.start);
    if (c && c.w === w && c.d === d && c.open === open) return c.lines;
    const lines = this.#renderGroup(g);
    this.#groupCache.set(g.start, { w, d, open, lines });
    return lines;
  }

  #renderGroup(g: { start: number; items: TuiItem[] }): string[] {
    const t = g.items[0].tool!;
    const icon = TOOL_ICONS[t.name] ?? "⚙";
    if (!this.#groupOpen.get(g.start)) {
      return [this.#clip(`${icon} ${paint(t.name, "38;5;75")} ×${g.items.length}${muted("   enter to expand")}`, this.#bodyCols())];
    }
    const rows = g.items.flatMap((it) => this.#toolRow(it));
    rows.push(this.#clip(muted("   enter to collapse"), this.#bodyCols()));
    return rows;
  }

  #panelTodos(): TodoItem[] | null {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const t = this.#items[i].tool;
      if (t && Array.isArray(t.todos) && t.todos.length) return t.todos;
    }
    return null;
  }

  #panelCtx(): {
    used: number;
    limit: number;
    trend?: number[];
    cost?: number;
    tps?: number;
    stps?: number;
    cacheRate?: number;
  } | null {
    const u = this.#opts.ctxUsage?.();
    if (!u || !(u.limit > 0)) return null;
    return u;
  }

  #fmtTok(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(Math.round(n));
  }

  #panelActive(): boolean {
    if (this.#cols <= 120) return false; // opencode/mimo-code: sidebar shows only when wide (>120)
    // The sidebar footer (cwd path + "• aih vX") is IDENTITY info and must render
    // on every wide screen — it does not depend on context-usage data or todos
    // being present. So once we are wide, the panel is active; the CONTEXT/TODO
    // sections above it simply stay empty when there is nothing to show. This
    // fixes the mock / fresh-session case where limit=0 and no todos used to
    // suppress the whole sidebar (and with it the footer).
    return true;
  }

  #panelWidth(): number {
    if (this.#plain) return 0; // /vivid: no side panel
    if (!this.#panelActive()) return 0;
    // opencode/mimo-code parity: SIDEBAR_WIDTH = 42 fixed (both repos). AIH
    // keeps its panel right-anchored but uses the same 42-column width and the
    // same >120 wide threshold, so a maximized terminal shows an identical
    // sidebar silhouette. User found 42 too wide → 34 (42×0.8, keeps the same
    // silhouette at ~81%, more room for the transcript).
    return Tui.SIDEBAR_WIDTH;
  }

 static readonly SIDEBAR_WIDTH = 34; // user: 42 was too wide → 34 (42×0.8)
 static readonly PANEL_GAP = 4; // opencode/mimo-code: contentWidth = width - sidebar(42) - 4
 static readonly INPUT_MAX_ROWS = 9; // user request: 6 → 1.5× (opencode TEXTAREA_MAX_ROWS=6; composer caps at 9 lines, scrolls beyond)

  /** Inline sparkline of recent per-turn prompt tokens (8 steps/cell, skill §5). */
  static sparkline(trend?: number[]): string {
    const v = (trend ?? []).filter((x) => typeof x === "number" && x > 0).slice(-8);
    if (v.length < 2) return "";
    const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    return v
      .map((x) => BLOCKS[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)])
      .join("");
  }

  // #bodyCols feeds #panelActive() -> ctxUsage()/panelTodos(), both O(session)
  // in the host. It is called per item from #block/#groupLines/#renderBlock,
  // so on a large resumed session it ran ~12k times per paint (~1.2s). Memoize
  // on (cols, plain, panelSeq); panelSeq bumps whenever #items mutate.
  #bodyColsMemo: { key: string; value: number } | null = null;
  #panelSeq = 0;

  #bodyCols(): number {
    const key = `${this.#cols}|${this.#plain}|${this.#panelSeq}`;
    const m = this.#bodyColsMemo;
    if (m && m.key === key) return m.value;
    const pw = this.#panelWidth();
    const value = pw ? Math.max(20, this.#cols - pw - Tui.PANEL_GAP) : this.#cols;
    this.#bodyColsMemo = { key, value };
    return value;
  }

  #panelSeg(content: string | undefined, pw: number): string {
    const bg = this.#surface();
    // Symmetric margins: 2 left + (pw-4) content + 2 right = pw total.
    // (Was pw-2: left=2, right=0 → content hugged the right edge, making the
    // left margin look larger than the right. Now centered.)
    const s = `  ${this.#clip(content ?? "", Math.max(1, pw - 4))}  `;
    return bg + s.split(RESET).join(RESET + bg) + RESET;
  }

  /**
   * Pure fill for the context-usage bar (testable without a platform mock).
   * Block chars (█ filled / ░ empty) on modern terminals — the classic
   * attractive bar. Legacy Windows conhost (GBK codepage) renders block chars
   * as two cells each and misaligns the panel, so `legacy=true` falls back to
   * ASCII #/-. opencode uses a plain text line ("N tokens · X% used"); we keep
   * a compact bar AND the text.
   */
  static bar(pct: number, width: number, legacy: boolean): string {
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const [F, E] = legacy ? ["#", "-"] : ["█", "░"];
    return F.repeat(filled) + E.repeat(width - filled);
  }

  #progressBar(pct: number, width: number): string {
    const bar = Tui.bar(pct, width, this.#legacyWin);
    if (pct >= 95) return danger(bar);
    if (pct >= 80) return warn(bar);
    return success(bar);
  }

  /**
   * Side-panel lines at a given panel width (test hook — mirrors #panelLines,
   * the private renderer used by #paint). Returns raw (styled) lines so tests
   * can assert layout, e.g. the F#30 panel: cost on its own line, the two
   * throughput figures sharing the next.
   */
  panelLinesForTest(pw: number): string[] {
    return this.#panelLines(pw);
  }

  /** Test hook for #panelFooter (the pinned path+version block). */
  panelFooterForTest(pw: number): string[] {
    return this.#panelFooter(pw);
  }

  /** Test hook: the last painted frame, ANSI-stripped (authoritative render). */
  frameForTest(): string[] {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][0-9A-Z]/g, "");
    return this.#lastLines.map(strip);
  }

  /** Test hook — mirrors #inputLayout so smoke can assert the opencode/mimo-code
   *  6-line composer cap (TEXTAREA_MAX_ROWS=6) without a live PTY. Returns the
   *  windowed lines + cursor cell for the current #edit/#cursor state. */
  inputLayoutForTest(width: number): { lines: string[]; segs: string[]; ci: number; col: number } {
    return this.#inputLayout(width);
  }

  #panelLines(pw: number): string[] {
    const lines: string[] = [];
    const ctx = this.#panelCtx();
    if (ctx) {
      const used = Math.min(ctx.used, ctx.limit);
      const pct = Math.round((used / ctx.limit) * 100);
      lines.push(accent(bold("CONTEXT")));
      // User: stretch the bar out to the panel's right edge — but keep an
      // even left/right margin. #panelSeg pads every line with 2 leading
      // spaces, so a bar of pw-4 (2 left + 2 right) is symmetric with the
      // left indent and reads as a full-width gauge. (Was capped at 12 from
      // the 42-wide era; at 34 the capped bar left a huge dead zone.)
      const bw = Math.max(4, pw - 4);
      lines.push(this.#progressBar(pct, bw));
      // Sparkline uses block glyphs (▁…█) which legacy conhost GBK renders as
      // two cells each; drop it there — the text % is still readable.
      const spark = this.#legacyWin ? "" : Tui.sparkline(ctx.trend);
      lines.push(muted(`${this.#fmtTok(used)} / ${this.#fmtTok(ctx.limit)} · ${pct}%${spark ? `  ${spark}` : ""}`));
      // F#30: cost + throughput (only when the model has a price table entry).
      // Layout: cost gets its own line; the two throughput figures share one
      // ("N tok/s · stream M tok/s") — a single combined line overflows the
      // narrow side panel and truncates mid-number.
      const cost =
        typeof ctx.cost === "number" && ctx.cost > 0
          ? `cost ${ctx.cost < 0.01 ? ctx.cost.toFixed(4) : ctx.cost.toFixed(2)}`
          : null;
      const tps =
        typeof ctx.tps === "number" && ctx.tps > 0
          ? `${ctx.tps >= 100 ? Math.round(ctx.tps) : ctx.tps.toFixed(1)} tok/s`
          : null;
      const stps =
        typeof ctx.stps === "number" && ctx.stps > 0
          ? `stream ${ctx.stps >= 100 ? Math.round(ctx.stps) : ctx.stps.toFixed(1)} tok/s`
          : null;
      const speed = [tps, stps].filter(Boolean).join(" · ");
      if (cost) lines.push(muted(cost));
      if (speed) lines.push(muted(speed));
      if (typeof ctx.cacheRate === "number") {
        lines.push(muted(`CH ${Math.round(ctx.cacheRate * 100)}%`));
      }
      if (pct >= 80) lines.push(warn("▲ compact soon (auto ≥80%)"));
    }
    const todos = this.#panelTodos();
    if (todos && todos.some((t) => t.status !== "completed")) {
      if (lines.length) {
        lines.push("");
        lines.push(dim("─".repeat(Math.min(pw - 2, 24))));
      }
      const done = todos.filter((t) => t.status === "completed").length;
      lines.push(accent(bold(`TODO ${done}/${todos.length}`)));
      // Wrap todo content to fit the panel (opencode uses wrapMode="word").
      // Available width = pw - 2 (padding) - 2 (icon + space) = pw - 4.
      const cw = Math.max(4, pw - 4);
      for (const t of todos) {
        const icon =
          t.status === "in_progress" ? warn(bold("▶"))
          : t.status === "completed" ? success("✓")
          : t.status === "cancelled" ? muted("✕")
          : muted("○");
        const styled =
          t.status === "in_progress" ? bold(t.content)
          : t.status === "completed" || t.status === "cancelled" ? muted(t.content)
          : t.content;
        const wrapped = wrapStyled(styled, cw);
        lines.push(`${icon} ${wrapped[0] ?? ""}`);
        for (let i = 1; i < wrapped.length; i += 1) {
          lines.push(`${" ".repeat(2)}${wrapped[i]}`);
        }
      }
    }
    return lines;
  }

  /**
   * opencode/mimo-code parity: the sidebar footer is a FIXED identity block
   * pinned to the BOTTOM of the side panel — current path (parent dimmed + name
   * in the primary colour) and brand+version. It renders regardless of whether
   * the CONTEXT/TODO sections above are present, so the user always sees where
   * they are and which aih build is running. Mirrors both repos' sidebar_footer
   * (path line + "• MiMoCode vX" / "• OpenCode vX"). Returned separately from
   * #panelLines so #paint can anchor it to the panel's bottom row(s) instead of
   * top-pairing it with body rows (where it would be clipped when the body is
   * shorter than the panel).
   */
  #panelFooter(pw: number): string[] {
    void pw; // width reserved for future wrapping; path/version are short
    const home = process.env.HOME || "";
    let pathText = this.#opts.cwd;
    if (home && pathText.startsWith(home)) pathText = "~" + pathText.slice(home.length);
    const parts = pathText.split("/");
    const name = parts.at(-1) ?? "";
    // parent may be empty for root-level paths (/tmp, /app): then show the bare
    // "/name" without a leading parent. Home-relative is already rewritten above.
    const parent = parts.slice(0, -1).join("/");
    const out: string[] = [""];
    if (parent) {
      out.push(`${muted(parent)}/${bold(name)}`);
    } else {
      out.push(bold(`/${name}`));
    }
    if (this.#opts.version) {
      out.push(`${success("•")} ${accent(bold("aih"))} v${this.#opts.version}`);
    }
    return out;
  }

  #todoRow(t: TodoItem): string {
    if (t.status === "in_progress") return `   ${warn(bold("▶ "))}${bold(t.content)}`;
    if (t.status === "completed") return `   ${success("✓ ")}${muted(t.content)}`;
    if (t.status === "cancelled") return `   ${muted("✕ ")}${muted(t.content)}`;
    return `   ${muted("○ ")}${t.content}`;
  }

  #block(item: TuiItem): string[] {
    const w = this.#bodyCols();
    const d = this.#dark;
    const c = this.#itemCache.get(item);
    if (c && c.w === w && c.d === d) return c.lines;
    const lines = this.#renderBlock(item);
    this.#itemCache.set(item, { w, d, lines });
    return lines;
  }

  /** P2#9 — plain (/vivid) render: user rows are plain text, no border/surface. */
  #userRow(line: string): string {
    if (this.#plain) return this.#clip(line, this.#bodyCols());
    const bg = this.#surface();
    // inner width: bodyCols - 4 (1 border + 2 content pad + 1 right margin) so
    // the row never touches the panel edge; ┃ is the wider, original border the
    // user prefers (Windows CJK fonts render it 1 cell like │ — the right
    // margin is what keeps the box off the sidebar, not the glyph).
    const inner = Math.max(1, this.#bodyCols() - 4);
    const raw = `${cyan("┃")}  ${this.#clip(line, inner)}`;
    return bg + raw.split(RESET).join(RESET + bg) + RESET;
  }

  #boxLine(content: string, width: number): string {
    if (this.#plain) return this.#clip(content, width);
    const bg = this.#surface();
    // inner width: width - 4 (1 border + 2 content pad + 1 right margin) — the
    // trailing 1-cell margin keeps the input box off the sidebar even if a
    // Windows font renders ┃ wide; the border stays the original ┃ glyph.
    const inner = Math.max(1, width - 4);
    const raw = `${cyan("┃")}  ${this.#clip(content, inner)}`;
    return bg + raw.split(RESET).join(RESET + bg) + RESET;
  }

  #renderBlock(item: TuiItem): string[] {
    // Right margin: every message family keeps 1 cell clear of the sidebar
    // (user rows already do via inner=bodyCols-4; assistant/tool did not and
    // their text ran flush against the panel — the "glued to the sidebar" look
    // on Windows). Wrap at bodyCols-4 (3 left indent + 1 right) so neither the
    // wrapped text nor its trailing space ever touches the panel edge.
    const limit = Math.max(1, this.#bodyCols() - 4);
    if (item.role === "assistant") {
      const lines = this.#markdown(item.text, limit);
      // opencode-style block spacing: a 1-line gap above each message block
      // (except the very first item) makes consecutive turns visually
      // separate — on Windows the small line-height made them look glued.
      const first = this.#items[0] === item;
      const row = (s: string): string => `   ${s}`;
      const out = lines.map(row);
      if (!first && lines.length) out.unshift("");
      return out;
    }
    // Banner (ASCII-art logo) is pre-laid-out: whitespace is significant,
    // so it bypasses #wrap's word-join (which folds runs of spaces into one)
    // and emits each art line verbatim, clipped only when wider than the body.
    if (item.role === "banner") {
      const limit = Math.max(1, this.#bodyCols() - 4);
      const bc = this.#bodyCols();
      return (item.text ?? "")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const styled = bold(gradientText(line.trimEnd(), ["#00e5ff", "#2196f3", "#9c27b0"]));
          return this.#clip(`   ${styled}`, bc - 1);
        });
    }
    const body = item.text ? this.#wrap(item.text, limit) : [""];
    switch (item.role) {
      // NOTE: "banner" is handled above (pre-laid-out ASCII art with
      // significant whitespace — #wrap's space-folding would corrupt it).
      case "user": {
        const rows = [this.#userRow("")];
        for (const line of body) rows.push(this.#userRow(line));
        rows.push(this.#userRow(""));
        return rows;
      }
      case "system": {
        // qwen-code terminal.ts parity — semantic SGR palette per system
        // row kind (Q-R7). Default/unknown kinds stay dim (old behavior).
        const code =
          item.red || item.sysKind === "error"
            ? SYS_KIND_SGR.error
            : SYS_KIND_SGR[item.sysKind ?? "info"];
        return body.map((line) => (code === "2" ? dim(`  ${line}`) : paint(`  ${line}`, code)));
      }
      case "footer":
        return body.map((line, i) =>
          i === 0 ? cyan("▣") + dim(line.slice(1)) : dim(`  ${line}`),
        );
      case "tool": {
        const rows = this.#toolRow(item);
        const t = item.tool;
        const bc = this.#bodyCols(); // keep 1-cell right margin like #toolRow
        if (t && t.ok === false && t.error) {
          for (const line of this.#wrap(t.error, bc - 1)) rows.push(this.#clip(`   ${red(line)}`, bc - 1));
        }
        if (t && typeof t.output === "string" && t.output.trim()) {
          const all = t.output.replace(/\r\n?/g, "\n").split("\n");
          const shown = t.expanded ? all : all.slice(0, 3);
          for (const l of shown) rows.push(this.#clip(`   ${dim(l || " ")}`, bc - 1));
          if (!t.expanded && all.length > 3) {
            rows.push(this.#clip(dim(`   … ${all.length - 3} more · enter to expand`), bc - 1));
          } else if (t.expanded) {
            rows.push(this.#clip(dim("   enter to collapse"), bc - 1));
          }
          if (t.outputCapped) rows.push(this.#clip(dim("   … output truncated at 32KB"), bc - 1));
        }
        if (item.tool?.ok && item.tool.diff && item.tool.diff.length) {
          rows.push(...this.#diffRows(item));
        }
        if (item.tool?.ok && item.tool.todos && item.tool.todos.length) {
          for (const t of item.tool.todos) rows.push(this.#todoRow(t));
        }
        return rows;
      }
      default:
        return body;
    }
  }

  #toolRow(item: TuiItem): string[] {
    const t = item.tool;
    const bodyCols = this.#bodyCols();
    if (!t) return [this.#clip(item.text, bodyCols - 1)];
    const icon = t.ok === undefined ? warn("▶") : t.ok ? success("✓") : danger("✗");
    // Q-R7 — tool name in the same blue qwen-code uses for tool rows
    // (terminal.ts `tool` → 38;5;75); arguments stay muted gray.
    const name = t.ok === false ? danger(`${t.name} failed`) : paint(t.name, "38;5;75");
    const argText = (t.args ?? "").replace(/\s*\n+\s*/g, " ").trim();
    // All tool rows are plain lines (no background, no border); the argument
    // text wraps onto extra lines instead of being clipped. Right margin: rows
    // are clipped to bodyCols-1 so the panel's 1-cell gap is never touched.
    const line = (s: string): string => this.#clip(s, bodyCols - 1);
    if (!argText) return [line(`${icon} ${name}`)];
    const nameVisible = t.ok === false ? t.name.length + 8 : t.name.length;
    const first = Math.max(8, bodyCols - 5 - nameVisible);
    const wrapped = this.#wrap(argText, first);
    const rows = [line(`${icon} ${name} ${muted(wrapped[0])}`)];
    for (let i = 1; i < wrapped.length; i += 1) {
      rows.push(line(`   ${muted(wrapped[i])}`));
    }
    return rows;
  }

  /** Zip each del run with the add run that follows it (side-by-side pairs). */
  #diffPairs(d: DiffLine[]): Array<{ del: DiffLine | null; add: DiffLine | null }> {
    const pairs: Array<{ del: DiffLine | null; add: DiffLine | null }> = [];
    let i = 0;
    while (i < d.length) {
      if (d[i].t === "del") {
        const dels: DiffLine[] = [];
        while (i < d.length && d[i].t === "del") {
          dels.push(d[i]);
          i += 1;
        }
        const adds: DiffLine[] = [];
        while (i < d.length && d[i].t === "add") {
          adds.push(d[i]);
          i += 1;
        }
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k += 1) {
          pairs.push({ del: dels[k] ?? null, add: adds[k] ?? null });
        }
      } else {
        while (i < d.length && d[i].t === "add") {
          pairs.push({ del: null, add: d[i] });
          i += 1;
        }
      }
    }
    return pairs;
  }

  /**
   * Diff rendering. Wide terminals (≥100 cols): side-by-side — left cell =
   * removed (red tint, old-file line number), right cell = added (green
   * tint, new-file line number), no border, full history width.
   * Narrow terminals (<100 cols): unified single-column fallback — one
   * cell per changed line, `-` red / `+` green, line numbers inline.
   */
  #diffRows(item: TuiItem): string[] {
    const t = item.tool;
    if (!t || !t.diff || !t.diff.length) return [];
    const bodyCols = this.#bodyCols();
    const delBg = this.#dark ? DEL_BG : DEL_BG_LIGHT;
    const addBg = this.#dark ? ADD_BG : ADD_BG_LIGHT;
    const surf = this.#surface();
    if (bodyCols < DIFF_SIDEBYSIDE_MIN_COLS) return this.#diffRowsUnified(item);
    // Line-number gutter sized to the largest number actually shown (capped,
    // so a huge file can't eat the whole row).
    let maxNo = 0;
    for (const l of t.diff) maxNo = Math.max(maxNo, l.a ?? 0, l.b ?? 0);
    const gutter = String(Math.min(maxNo, 99999)).length + 1;
    // Diff rows are borderless (test: "tool rows carry no left border").
    // Right edge must align with the input box: #boxLine(content, bodyCols)
    // = ┃(1)+2pad+(bodyCols-4) = bodyCols-1 wide. So diff row = bodyCols-1:
    // leftW+1(space)+rightW = bodyCols-1, i.e. leftW+rightW = bodyCols-2.
    const avail = Math.max(8, bodyCols - 2);
    const leftW = Math.max(4, Math.floor(avail / 2));
    const rightW = Math.max(4, avail - leftW);
    // Long lines WRAP to extra rows instead of clipping (opencode/mimo-code
    // `diff` wrapMode="char"): the {no} -/+ prefix + line number sits on the
    // first row, wrapped continuations keep the tinted bg and only the content.
    // Each pair produces max(wrapsLeft, wrapsRight) rows; the shorter side is
    // padded with blank tinted rows so left/right stay row-aligned.
    const cell = (bg: string, text: string, w: number): string =>
      `${bg}${this.#clip(text, w)}${RESET}`;
    const wsLimit = (pre: string, w: number): number => Math.max(1, w - cols(pre));
    const rows: string[] = [];
    for (const p of this.#diffPairs(t.diff)) {
      const delLine = p.del ? `${String(p.del.a).padStart(gutter - 1)} - ${p.del.s ?? ""}` : null;
      const addLine = p.add ? `${String(p.add.b).padStart(gutter - 1)} + ${p.add.s ?? ""}` : null;
      const delPre = delLine ? delLine.slice(0, gutter - 1 + 3) : "";
      const addPre = addLine ? addLine.slice(0, gutter - 1 + 3) : "";
      const delContent = delLine ? delLine.slice(delPre.length) : "";
      const addContent = addLine ? addLine.slice(addPre.length) : "";
      const delWpre = delLine ? cols(delPre) : 0;
      const addWpre = addLine ? cols(addPre) : 0;
      const delWraps = delLine
        ? wrapStyled(delContent, wsLimit(delPre, leftW)).map((s, i) =>
            i === 0 ? delPre + s : " ".repeat(delWpre) + s,
          )
        : [""];
      const addWraps = addLine
        ? wrapStyled(addContent, wsLimit(addPre, rightW)).map((s, i) =>
            i === 0 ? addPre + s : " ".repeat(addWpre) + s,
          )
        : [""];
      const n = Math.max(delWraps.length, addWraps.length);
      const delBgC = p.del ? delBg : surf;
      const addBgC = p.add ? addBg : surf;
      for (let k = 0; k < n; k += 1) {
        const l = p.del ? cell(delBgC, delWraps[k] ?? "", leftW) : cell(delBgC, "", leftW);
        const r = p.add ? cell(addBgC, addWraps[k] ?? "", rightW) : cell(addBgC, "", rightW);
        rows.push(`${l} ${r}`);
      }
    }
    if (t.truncated) {
      rows.push(this.#clip(dim(`… ${t.truncated} more line(s)`), bodyCols - 1));
    }
    return rows;
  }

  /** Unified single-column fallback for narrow terminals (opencode style). */
  #diffRowsUnified(item: TuiItem): string[] {
    const t = item.tool;
    if (!t || !t.diff || !t.diff.length) return [];
    const bodyCols = this.#bodyCols();
    const delBg = this.#dark ? DEL_BG : DEL_BG_LIGHT;
    const addBg = this.#dark ? ADD_BG : ADD_BG_LIGHT;
    // Single-column, borderless (test: "tool rows carry no background box").
    // Long lines WRAP to extra rows instead of clipping.
    const cell = (bg: string, text: string): string => `${bg}${this.#clip(text, bodyCols - 1)}${RESET}`;
    const rows: string[] = [];
    for (const l of t.diff) {
      const no = l.t === "del" ? l.a : l.b;
      const mark = l.t === "del" ? "-" : "+";
      const bg = l.t === "del" ? delBg : addBg;
      const prefix = `${typeof no === "number" ? `${no} ` : ""}${mark} `;
      const content = `${prefix}${l.s}`;
      const cw = Math.max(1, bodyCols - 1 - cols(prefix));
      const wraps = wrapStyled(l.s, cw).map((s, i) =>
        i === 0 ? content : " ".repeat(cols(prefix)) + s,
      );
      for (const w of wraps) rows.push(cell(bg, w));
    }
    if (t.truncated) {
      rows.push(this.#clip(dim(`… ${t.truncated} more line(s)`), bodyCols - 1));
    }
    return rows;
  }

  #ghost(): string {
    if (!this.#edit.startsWith("/") || this.#edit.includes(" ")) return "";
    const candidates = (this.#opts.completions?.() ?? []).filter(
      (c) => c.startsWith(this.#edit) && c.length > this.#edit.length,
    );
    if (!candidates.length) return "";
    let ghost = candidates[0].slice(this.#edit.length);
    for (const c of candidates.slice(1)) {
      const rest = c.slice(this.#edit.length);
      let end = 0;
      while (
        end < ghost.length &&
        end < rest.length &&
        ghost[end] === rest[end]
      ) {
        end += 1;
      }
      ghost = ghost.slice(0, end);
    }
    return ghost;
  }

  #wrapEdit(text: string, limit: number): string[] {
    const out: string[] = [];
    let line = "";
    let w = 0;
    for (const ch of text) {
      const cw = width(ch);
      if (w + cw > limit && line) {
        const sp = line.lastIndexOf(" ");
        const brk = sp > 0 ? sp : line.length;
        out.push(line.slice(0, brk));
        const rest = line.slice(brk);
        line = `${rest}${ch}`;
        w = cols(rest) + cw;
      } else {
        line += ch;
        w += cw;
      }
    }
    out.push(line);
    return out;
  }

  #inputLayout(width: number): { lines: string[]; segs: string[]; ci: number; col: number } {
    if (this.#question) {
      // Hint only while the answer is empty — once the user types, the hint
      // must step aside (it was crowding the answer text and made the input
      // look like a placeholder that never cleared).
      const hint = this.#qbuf ? "" : dim("  Enter to send · ctrl-c to cancel");
      // Long answers wrap (same limit as the composer) so a long question
      // answer never vanishes behind the box's right edge.
      const qlimit = Math.max(4, width - 6);
      const wrapped = this.#wrapEdit(this.#qbuf, qlimit);
      const lines = wrapped.map((s, i) => (i === 0 ? `${cyan("❯")} ${s}` : `  ${s}`));
      if (wrapped.length === 1) lines[0] += hint;
      // cursor lands at the end of the answer (last wrapped line)
      const ci = Math.min(wrapped.length - 1, Tui.INPUT_MAX_ROWS - 1);
      const col = wrapped[ci]?.length ?? 0;
      return { lines, segs: wrapped.slice(0, Tui.INPUT_MAX_ROWS), ci, col };
    }
    if (this.#confirmText) {
      const at = this.#confirmText.indexOf("always");
      const head = at >= 0 ? this.#confirmText.slice(0, at + "always".length) : "";
      const tail = at >= 0 ? this.#confirmText.slice(at + "always".length).trimStart() : this.#confirmText;
      return {
        lines: [`${red(bold(head))}${tail ? ` ${dim(tail)}` : ""}`],
        segs: [""],
        ci: 0,
        col: 0,
      };
    }
    const limit = Math.max(4, width - 6); // 2-space wrap indent fits inner (width-4)
    // opencode/mimo-code parity: the composer caps at TEXTAREA_MAX_ROWS=6 and
    // scrolls beyond. AIH keeps the full text in #edit (send is unaffected) but
    // renders a 6-line window centred on the cursor; overflow is signalled with
    // an ellipsis marker so the user knows more lines exist above/below.
    const all = this.#wrapEdit(this.#edit, limit);
    let segs = all;
    let topOffset = 0;
    if (all.length > Tui.INPUT_MAX_ROWS) {
      // find which wrapped line the cursor sits on
      let before = 0;
      let curLine = 0;
      for (let i = 0; i < all.length; i += 1) {
        if (this.#cursor <= before + all[i].length) {
          curLine = i;
          break;
        }
        before += all[i].length;
      }
      topOffset = Math.max(0, Math.min(curLine - (Tui.INPUT_MAX_ROWS >> 1), all.length - Tui.INPUT_MAX_ROWS));
      segs = all.slice(topOffset, topOffset + Tui.INPUT_MAX_ROWS);
    }
    const lines = segs.map((s, i) => (i === 0 ? s : `  ${s}`));
    // base offset: the wrapped length of every line ABOVE the window (when we
    // scrolled past the top). ci/col are reported in window-relative terms so
    // the cursor lands on the right visual cell even when the first visible
    // line is not the first logical line.
    let base = 0;
    for (let i = 0; i < topOffset; i += 1) base += all[i].length;
    let before = base;
    for (let i = 0; i < segs.length; i += 1) {
      if (this.#cursor <= before + segs[i].length) {
        return { lines, segs, ci: i, col: this.#cursor - before };
      }
      before += segs[i].length;
    }
    const last = segs.length - 1;
    return { lines, segs, ci: last, col: segs[last]?.length ?? 0 };
  }

  #num(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return String(n);
  }

 #usageText(): string {
    const u = this.#opts.ctxUsage?.();
    if (!u || !u.used) return "";
    if (!u.limit) return dim(this.#num(u.used));
    const pct = Math.min(100, Math.round((u.used / u.limit) * 100));
    const text = `${this.#num(u.used)}/${this.#num(u.limit)} (${pct}%)`;
    if (pct >= 95) return red(text);
    if (pct >= 80) return yellow(text);
    return dim(text);
  }

  #metaContent(): string {
    const m = this.#opts.meta();
    // opencode-parity footer: the current model leads the bottom status line
    // (opencode's statusline shows model info on the right; we put it on the
    // left per user request), with the provider dimmed next to it, and the
    // agent mode demoted to a trailing tag — the model is the identity users
    // need to see first.
    const model = accent(bold(m.model));
    const agent = m.agent === "plan" ? warn(bold(m.agent)) : muted(m.agent);
    return `${model}${muted(" · ")}${muted(m.provider)}${muted(" · ")}${agent}`;
  }

  #hintsRow(width: number): string {
    const usage = this.#usageText();
    // Contextual footer: only what is actionable right now (progressive disclosure).
    let hint: string;
    if (this.#confirmText) hint = this.#confirmMode === "runorcopy" ? "R run · C copy · N no" : "y once · a always · n deny";
    else if (this.#question) hint = "enter answer · esc cancel";
    else if (this.#opts.busy()) hint = "esc escape twice to cancel · enter queues";
    else hint = "? help · /commands · ctrl-p palette · tab complete";
    // Scroll-back indicator (used to ride the now-removed dashed separator
    // row): shown on the hints row when scrolled up from the bottom.
    const tag = this.#scrollTop > 0 ? `  ↑${this.#scrollTop}` : "";
    // The aih version + cwd path used to lead this row, but they now live in the
    // sidebar footer (bottom-aligned, opencode/mimo-code parity) — keeping them
    // here too would duplicate. This row is now purely the actionable hint +
    // scroll-back tag.
    const left = dim(`${hint}${tag}`);
    if (!usage) return this.#clip(left, width);
    const right = usage;
    const pad = Math.max(1, width - cols(left) - cols(right) - 1);
    return this.#clip(`${left}${" ".repeat(Math.min(pad, 200))}${right}`, width);
  }

  #statusRow(width: number): string {
    // The session identity (agent · model · provider) lives here now — folded
    // into the single bottom status line (opencode/mimo-code style) instead of
    // a separate boxed meta row above the footer.
    const meta = this.#metaContent();
    const b = this.#opts.statusBadge?.() ?? null;
    const badge = b ? `${b.ok ? success(b.glyph) : danger(b.glyph)} ${muted(b.label)}` : "";
    // IT#2 — shell-failure indicator (red when a run_cmd failed; hidden when green).
    const se = this.#opts.shellErrorBadge?.() ?? null;
    const shellBadge = se
      ? `${se.ok ? success(se.glyph) : danger(se.glyph)} ${danger(se.label)}`
      : "";
    const pending = this.#confirmText
      ? `${danger(bold("⚠ APPROVAL PENDING"))}  `
      : this.#question
        ? `${warn(bold("❓ AWAITING ANSWER"))}  `
        : "";
    const js = this.#opts.jobStatus?.() ?? null;
    const jobSeg =
      js && js.running + js.done + js.failed > 0
        ? [
            js.running > 0 ? warn(`${js.running} bg running`) : "",
            js.done > 0 ? success(`${js.done} done`) : "",
            js.failed > 0 ? danger(`${js.failed} failed`) : "",
          ]
            .filter(Boolean)
            .join(" · ") + "  "
        : "";
    const l =
      pending +
      meta +
      (badge ? `${muted("  ")}${badge}` : "") +
      (shellBadge ? `${muted("  ")}${shellBadge}` : "") +
      (jobSeg ? `${muted("  ")}${jobSeg}` : "") +
      (this.#opts.statusLeft ? `${muted("  ")}${muted(this.#opts.statusLeft)}` : "");
    const r = this.#opts.statusRight ? muted(this.#opts.statusRight) : "";
    const pad = Math.max(1, width - cols(l) - cols(r) - 1);
    return this.#clip(`${l}${" ".repeat(Math.min(pad, 200))}${r}`, width);
  }

  /**
   * Last-line-of-defense paint guard (render-desync fix): every row written to
   * the terminal must be EXACTLY ≤ #cols display cells and contain no cursor
   * control characters. A row that slips past its component's clip — an
   * embedded `\n`/`\r` from tool output, an ANSI-styled string whose visible
   * width was miscounted (CJK/emoji) — makes the terminal auto-wrap or scroll
   * mid-frame. Every subsequent row-addressed diff then draws against a
   * shifted screen: history lines smear over the input box and status bar and
   * ONLY a window resize (#clearNext full repaint) fixes it. Strip control
   * chars, hard-cap the display width, keep SGR styling intact, then pad back
   * to the cell's target width (a sanitized row must still overwrite its old
   * tail — the diff painter relies on full-width rows).
   */
  #paintGuard(line: string, padTo: number): string {
    // Drop C0 controls that move the cursor or ring bells; keep \x1b (SGR
    // styling below relies on it) — non-SGR escapes are stripped with the
    // width walk, since only `ESC[...m` sequences are recognized there.
    const clean = line.replace(/[\r\n\x07\x08\x09\x0b\x0c]/g, " ");
    let out = "";
    let n = 0;
    let i = 0;
    while (i < clean.length && n < padTo) {
      if (clean[i] === "\x1b") {
        const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(clean.slice(i));
        if (m) {
          // SGR (…m) is styling — zero width, pass through. Anything else
          // (cursor moves, mode sets) inside a content row is poison — drop it.
          if (m[0].endsWith("m")) out += m[0];
          i += m[0].length;
          continue;
        }
        i += 1; // lone ESC — drop
        continue;
      }
      const cp = clean.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = width(ch);
      if (n + w > padTo) break;
      out += ch;
      n += w;
      i += ch.length;
    }
    return out + " ".repeat(Math.max(0, padTo - n));
  }

  #clip(line: string, limit: number): string {
    let out = "";
    let n = 0;
    let i = 0;
    while (i < line.length) {
      if (line[i] === "\x1b") {
        const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
        if (m) {
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = width(ch);
      if (n + w > limit) break;
      out += ch;
      n += w;
      i += ch.length;
    }
    return out + " ".repeat(Math.max(0, limit - n));
  }

  #paletteBox(leftW: number): { lines: string[]; width: number } {
    const ov = this.#overlay!;
    // W is the total display width including both border columns; every row is
    // clipped/padded to exactly W so left/right borders always line up.
    const W = Math.max(40, Math.min(64, leftW - 4));
    const maxRows = Math.max(3, Math.min(12, this.#rows - 10));
    const rows: string[] = [];
    for (const fi of ov.filtered) {
      const e = ov.entries[fi];
      const mark = e.active ? green("●") : " ";
      const label = e.active ? bold(cyan(e.label)) : e.label;
      const hint = e.hint ? `  ${dim(e.hint)}` : "";
      rows.push(`${mark} ${label}${hint}`);
    }
    if (!rows.length) rows.push(dim("no matching entries"));
    const { top, highlight } = paletteWindow(ov.sel, rows.length, maxRows);
    const visible = rows.slice(top, top + maxRows);
    // every row is exactly W display columns wide (border chars included)
    const box: string[] = [];
    if (ov.help) {
      // read-only help dialog: title + static sections, no selection/filter
      box.push(cyan(`╭─${"─".repeat(W - 3)}╮`));
      const titleInner = ` ${bold("help")}`;
      box.push(
        `${cyan("│")}${titleInner}${" ".repeat(Math.max(1, W - 2 - cols(titleInner)))}${cyan("│")}`,
      );
      box.push(cyan(`├─${"─".repeat(W - 3)}┤`));
      for (const h of HELP_LINES) {
        const cl = this.#clip(h, W - 4);
        box.push(`${cyan("│")} ${cl}${" ".repeat(Math.max(1, W - 4 - cols(cl)))}${cyan("│")}`);
      }
      const footer = dim("enter or esc — close");
      box.push(cyan(`├─${"─".repeat(W - 3)}┤`));
      const fcl = this.#clip(footer, W - 4);
      box.push(`${cyan("│")} ${fcl}${" ".repeat(Math.max(1, W - 4 - cols(fcl)))}${cyan("│")}`);
      box.push(cyan(`╰─${"─".repeat(W - 3)}╯`));
      return { lines: box, width: W };
    }
    box.push(cyan(`╭─${"─".repeat(W - 3)}╮`));
    const titleInner = ` ${bold(ov.title)}`;
    box.push(
      `${cyan("│")}${titleInner}${" ".repeat(Math.max(1, W - 2 - cols(titleInner)))}${cyan("│")}`,
    );
    const filterContent = ov.query ? ov.query : this.#clip(dim("(type to filter)"), W - 12);
    const filterInner = ` ${dim("filter: ")}${filterContent}`;
    box.push(
      `${cyan("│")}${filterInner}${" ".repeat(Math.max(1, W - 2 - cols(filterInner)))}${cyan("│")}`,
    );
    box.push(cyan(`├─${"─".repeat(W - 3)}┤`));
    for (let i = 0; i < visible.length; i += 1) {
      // `visible` is a slice of `rows` starting at `top`, while `ov.sel` is a
      // global index into the full list — `highlight` (from paletteWindow) is
      // the location of the selection WITHIN the window. Before this fix the
      // highlight compared a window-relative loop index against the global
      // `ov.sel`, so once the list scrolled the highlighted row and the
      // actually-selected entry drifted apart ("chose one, got another").
      const isSel = i === highlight;
      const line = visible[i];
     if (isSel) {
        // selection row: reverse video (theme-proof) with the same geometry as
        // the │…│ rows — content clipped to W-3, padded, right border aligned.
        const content = this.#clip(restyle(line, (t) => cyan(t)), W - 3);
        const used = 1 + cols(content);
        const pad = " ".repeat(Math.max(1, W - 3 - used));
        box.push(`${REV} ${content}${pad}${RESET}${cyan("│")}`);
      } else {
        const cl = this.#clip(line, W - 4);
        box.push(`${cyan("│")} ${cl}${" ".repeat(Math.max(1, W - 4 - cols(cl)))}${cyan("│")}`);
      }
    }
    const footer = dim("↑↓ select · enter confirm · esc close · type to filter");
    box.push(cyan(`├─${"─".repeat(W - 3)}┤`));
    const fcl = this.#clip(footer, W - 4);
    box.push(`${cyan("│")} ${fcl}${" ".repeat(Math.max(1, W - 4 - cols(fcl)))}${cyan("│")}`);
    box.push(cyan(`╰─${"─".repeat(W - 3)}╯`));
    return { lines: box, width: W };
  }

  #paint(): void {
    if (!this.#running) return;
    this.#rows = process.stdout.rows || 24;
    // A fixed `width` option (test/embedding) wins over the live terminal.
    if (typeof this.#opts.width !== "number" || this.#opts.width <= 0) {
      this.#cols = process.stdout.columns || 80;
    }
    const width = this.#cols;

    const view = this.#viewHeight();
    const maxTop = Math.max(0, this.#contentLines() - view);
    if (this.#scrollTop > maxTop) this.#scrollTop = maxTop;

    const units = this.#units();
    const body: string[] = [];
    this.#bodyUnitIdx = [];
    units.forEach((u, ui) => {
      const lines = u.kind === "item" ? this.#block(u.item) : this.#groupLines(u);
      for (const r of lines) {
        body.push(r);
        this.#bodyUnitIdx.push(ui);
      }
    });

    const pw = this.#panelWidth();
    const panel = pw ? this.#panelLines(pw) : null;
    // opencode/mimo-code parity: the sidebar footer (path + brand version) is
    // pinned to the BOTTOM of the side panel, independent of body height. We
    // reserve the last `footer.length` visible rows for it and top-pair the
    // remaining rows with the CONTEXT/TODO lines. Without this the footer sat at
    // the END of #panelLines and got clipped whenever the body was shorter than
    // the panel (the common case on a fresh session).
    const footer = pw ? this.#panelFooter(pw) : null;
    const leftW = panel ? Math.max(20, width - pw - Tui.PANEL_GAP) : width;
    let rowIdx = 0;
    const row = (content: string): { left: string; right?: string } => {
      const left = this.#clip(content, leftW);
      if (!panel) return { left };
      // Body rows top-pair with the CONTEXT/TODO lines; rows outside the body
      // window (input box / hints / status) get a blank panel cell. The footer
      // is anchored separately to the BOTTOM of the frame (see below) so it
      // sits level with the status line, not floating in the body area.
      if (rowIdx >= (panel?.length ?? 0)) return { left, right: this.#panelSeg("", pw) };
      return { left, right: this.#panelSeg(panel[rowIdx++] ?? "", pw) };
    };

    const rows: Array<{ left: string; right?: string }> = [];
    for (let i = 0; i < view; i += 1) {
      // hoist the clip result into a local: passing `this.#clip(...)` inline as
      // the first arg of row() trips a TS5.9 private-call + trailing-arg parse
      // quirk (TS2554 "expected 2 got 1") even though it is type-correct.
      const clipped = this.#clip(body[this.#scrollTop + i] ?? "", leftW);
      rows.push(row(clipped));
    }

    if (this.#overlay) {
      // centered modal: horizontally centered over the full window width,
      // vertically over the body area; right panel border stays put.
      const { lines: box, width: bw } = this.#paletteBox(leftW);
      const padLeft = Math.max(0, ((leftW - bw) >> 1));
      // center over the full window minus the ~7-row input/footer block
      // (6 fixed rows + 1 input row; was 9 before the meta box row folded
      // into the status line)
      const freeRows = Math.max(box.length, this.#rows - 7);
      const padTop = Math.max(0, ((freeRows - box.length) >> 1));
      for (let i = 0; i < view; i += 1) {
        const bi = i - padTop;
        const content =
          bi >= 0 && bi < box.length
            ? " ".repeat(padLeft) + box[bi]
            : "";
        rows[i] = row(content);
      }
    }

    const il = this.#inputLayout(leftW);
    let firstLine: string;
    if (this.#question || this.#confirmText) {
      firstLine = il.lines[0];
    } else {
      const busyNow = this.#opts.busy();
      // Spinner appears only after the delay (fast ops show a stable prompt).
      const spinnerUp =
        busyNow &&
        !!this.#busySince &&
        Date.now() - this.#busySince >= SPINNER_DELAY_MS;
      const prompt = spinnerUp
        ? `${accent(SPINNER[this.#frame])} `
        : `${accent("❯")} `;
      const seg0 = il.segs[0] ?? "";
      firstLine = prompt + (seg0.startsWith("/") ? accent("/") + seg0.slice(1) : seg0);
      if (!this.#edit && !busyNow) {
        firstLine = prompt + muted(this.#opts.placeholder);
      } else if (spinnerUp) {
        firstLine += `  ${muted(`${Math.floor((Date.now() - this.#busySince!) / 1000)}s`)}`;
      }
      if (!busyNow && il.lines.length === 1 && this.#cursor === 0) {
        const g = this.#ghost();
        if (g) firstLine += muted(`${g}  (Tab to accept)`);
      }
    }

    // C — input box breathing room: one blank line above AND below (opencode
    // pads its prompt box top/bottom by 1). #viewHeight (rows - 6 - k) accounts
    // for exactly these fixed rows: pad-above(1) + box-top(1) + k input +
    // box-bottom(1) + pad-below(1) + hints(1) + status(1) = 6 + k. A second
    // stray pad row here (a refactor leftover) pushed the frame to rows+1, so
    // the final write scrolled the terminal and the path row of the sidebar
    // footer was lost — only the version row survived.
    rows.push(row(""));
    rows.push(row(this.#boxLine("", leftW)));
    let cursorIdx = -1;
    for (let i = 0; i < il.lines.length; i += 1) {
      rows.push(row(this.#boxLine(i === 0 ? firstLine : il.lines[i], leftW)));
      if (i === il.ci) cursorIdx = rows.length - 1;
    }
    rows.push(row(this.#boxLine("", leftW)));
    rows.push(row("")); // padding below the input box (see comment above)
    // The meta line (agent · model · provider) used to be a separate boxed
    // row with its own BOX_BG surface here — a black bar visually splitting
    // the input box from the footer. opencode/mimo-code fold that identity
    // info into the single bottom status line; we do the same (see
    // #statusRow), dropping the box row AND the dashed separator row.
    rows.push(row(this.#hintsRow(leftW)));
    rows.push(row(this.#statusRow(leftW)));

    // opencode/mimo-code parity: the sidebar footer (cwd path + "• aih vX") is
    // pinned to the BOTTOM of the side column — level with the hints/status
    // lines, not floating up in the body area. We overwrite the right cell of
    // the last `footer.length` rows with it. This is what makes it "bottom-
    // aligned" as the user requested: it now sits at the very bottom of the
    // sidebar, matching both repos' sidebar_footer which renders at the panel's
    // lowest row.
    if (footer) {
      const start = Math.max(0, rows.length - footer.length);
      for (let fi = 0; fi < footer.length; fi += 1) {
        const r = rows[start + fi];
        if (r) r.right = this.#panelSeg(footer[fi] ?? "", pw);
      }
    }

    // Paint guard (render-desync fix): sanitize every cell BEFORE both the
    // diff bookkeeping and the terminal write — an embedded \n or a miscounted
    // wide-char row must never reach the screen (auto-wrap there shifts the
    // whole frame and only a resize fixes the smear). Pad back to the cell's
    // original width so a sanitized row still overwrites its old tail.
    // Frame-height invariant: writing MORE lines than the terminal has rows
    // scrolls the buffer and permanently desyncs the row-addressed diff (tiny
    // terminals where view is floored at 1: rows.length = 7+k > #rows). Drop
    // the surplus and force a full repaint so the screen stays consistent.
    if (rows.length > this.#rows) {
      rows.length = this.#rows;
      this.#clearNext = true;
    }
    for (const r of rows) {
      r.left = this.#paintGuard(r.left, leftW);
      if (r.right !== undefined) r.right = this.#paintGuard(r.right, pw);
    }
    const lines = rows.map((r) => r.left + (r.right ?? ""));
    // Row-level diff against the previous frame (pi-style): rewrite only rows
    // whose string changed, erase surplus rows when the frame got shorter
    // (input box unwrapped / terminal resized), and never clear the whole
    // screen outside an explicit #clearNext (resize/restore). #clip pads rows
    // to full width, so a shorter replacement overwrites its old tail.
    const prevLen = this.#lastLines.length;
    const curRow = Math.max(1, cursorIdx + 1);
    // Text starts at 0-based offset 5: ┃(1) + 2 spaces(2) + prompt(2: "❯ "/"⠋ ").
    // The `4` was correct when #boxLine used ┃+1 space (v≤0.7.0); the v0.7.1
    // 2-space padding shifted the text right by one cell but the constant was
    // left stale, so the cursor landed one cell LEFT — on the last typed char
    // instead of the next input position (the reported Linux bug).
    const curCol = Math.min(width - 1, 5 + cols((il.segs[il.ci] ?? "").slice(0, il.col)));
    if (
      !this.#clearNext &&
      prevLen === lines.length &&
      lines.every((line, i) => line === this.#lastLines[i])
    ) {
      process.stdout.write(`${CSI}${curRow};${curCol + 1}H`);
      return;
    }
    // Synchronized output (?2026) is unsupported on legacy conhost and can
    // trigger buffer overflow during resize — skip it there.
    const sync = this.#legacyWin ? "" : `${CSI}?2026h`;
    let out = `${sync}${HIDE}${CSI}H`;
    if (this.#clearNext) out += `${CSI}2J`;
    const panelCol = width - pw + 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (!this.#clearNext && this.#lastLines[i] === lines[i]) continue;
      // Close ANY SGR state left open by the previously written row before
      // starting this one. The diff painter skips unchanged rows, but the
      // terminal's SGR state does NOT skip with them: a background opened by
      // the last written row (user-row surface, sidebar panelSeg) bleeds onto
      // the NEXT row that is written — the reported regression where tool
      // output rows and the "esc escape twice" hint row acquired a background
      // they never declare. Every row is self-contained (its own SGR + RESET),
      // so resetting at row boundaries is always correct and never visible.
      out += `${CSI}${i + 1};1H${RESET}${rows[i].left}`;
      if (rows[i].right) out += `${CSI}${i + 1};${panelCol}H${RESET}${rows[i].right}`;
    }
    if (!this.#clearNext) {
      for (let i = rows.length; i < prevLen; i += 1) {
        out += `${CSI}${i + 1};1H${CSI}2K`;
      }
    }
    this.#lastLines = lines;
    this.#clearNext = false;
    const syncEnd = this.#legacyWin ? "" : `${CSI}?2026l`;
    out += `${CSI}${curRow};${curCol + 1}H${SHOW}${syncEnd}`;
    process.stdout.write(out);
  }
}

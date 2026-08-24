import { accent, bold, blue, cyan, danger, dim, green, italic, magenta, muted, red, success, underline, warn, yellow } from "./ui.js";
import type { DiffLine } from "./diff.js";
import { capDiff } from "./diff.js";
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

export interface TuiItem {
  role: "user" | "assistant" | "tool" | "system" | "footer" | "banner";
  text: string;
  red?: boolean;
  tool?: ToolView;
}

export interface TuiOptions {
  placeholder: string;
  meta(): { agent: string; model: string; provider: string };
  cwd: string;
  statusLeft: string;
  statusRight: string;
  statusBadge?(): { glyph: string; ok: boolean; label: string } | null;
  busy(): boolean;
  cancelTurn?(): void;
  onLine(line: string): void;
  ctxUsage?(): { used: number; limit: number; trend?: number[] };
  completions?(): string[];
  onTab?(): void;
  /** open the command palette (ctrl-p) */
  onPalette?(): void;
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
const REV = `${CSI}7m`; // reverse video: selection that works on any theme
const RESET = `${CSI}0m`;
// Terminal background report (OSC 11), 16-bit RRRR/GGGG/BBBB, BEL or ST terminated.
const OSC11_BG =
  /^\x1b]11;rgb:([0-9a-fA-F]{4,8})\/([0-9a-fA-F]{4,8})\/([0-9a-fA-F]{4,8})(?:\x07|\x1b\\)/;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Show the spinner only after this much busy time (avoids a flash for fast ops).
const SPINNER_DELAY_MS = 200;

// Content of the read-only help dialog (? with empty input, /help, palette).
// Kept short enough for the dialog width; each line is clipped anyway.
const HELP_LINES: string[] = [
  bold("keys"),
  "    enter send · esc clear · esc escape twice cancels the turn",
  "    up/down recall history · tab complete · ctrl-p command palette",
  "    ? help (empty input) · mouse scroll/click",
  bold("state"),
  "    ▶ running   ✓ ok   ✗ failed   ● active model",
  bold("commands"),
  "    /skills · /usage · /compact · /help · /exit",
];

const TOOL_ICONS: Record<string, string> = {
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

function swOpts(): { ambiguousIsNarrow: boolean } {
  const mode = process.env.AIH_AMBIGUOUS_WIDE;
  if (mode === "2") return { ambiguousIsNarrow: false };
  return { ambiguousIsNarrow: true };
}

/** Width of one grapheme cluster, applying font-specific overrides. */
function clusterWidth(cluster: string): number {
  const c = cluster.codePointAt(0);
  if (c !== undefined && WIDTH_OVERRIDES[c] !== undefined) return WIDTH_OVERRIDES[c];
  return stringWidth(cluster, swOpts());
}

/** Display width of one code point in terminal cells: 0, 1, or 2. */
export function width(ch: string): number {
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

function wrapStyled(s: string, limit: number): string[] {
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
const TOOL_TITLE_ARG: Record<string, string> = {
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
  #timer: ReturnType<typeof setInterval> | null = null;
  #paintScheduled = false;
  #paintTimer: ReturnType<typeof setTimeout> | null = null;
  #clearNext = true;
  #lastLines: string[] = [];
  #confirm: ((ans: "once" | "always" | "deny") => void) | null = null;
  #confirmText = "";
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

constructor(opts: TuiOptions) {
    this.#opts = opts;
  }

 /** Current theme (test/UI hook). */
  isDark(): boolean {
    return this.#dark;
  }

  /** All rendered transcript lines (test/text-replay hook). */
  transcriptLines(): string[] {
    const body: string[] = [];
    for (const u of this.#units()) {
      const lines = u.kind === "item" ? this.#block(u.item) : this.#groupLines(u);
      for (const r of lines) body.push(r);
    }
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
      this.requestPaint();
    });
    process.on("exit", this.#restore);
    this.#running = true;
    // ?1049 alt screen, ?1000 mouse, ?1006 SGR mouse, ?2004 bracketed paste —
    // pastes arrive wrapped in ESC[200~…ESC[201~ so their newlines are never
    // mistaken for Enter presses.
    process.stdout.write(`${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h`);
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
    process.stdout.write(`${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}?1049l${SHOW}`);
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
    process.stdout.write(`${CSI}?1000l${CSI}?1006l${CSI}?2004l${CSI}?1049l${SHOW}`);
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
  }

  pushSystem(text: string): void {
    this.push({ role: "system", text });
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

  askQuestion(question: string): Promise<string> {
    this.pushSystem(`❓ ${question}`);
    this.#qbuf = "";
    this.requestPaint();
    return new Promise((resolve, reject) => {
      this.#question = { resolve, reject };
    });
  }

  pushError(text: string): void {
    this.push({ role: "system", text, red: true });
  }

  clearItems(): void {
    this.#items = [];
    this.#queue = [];
    this.#groupOpen.clear();
    this.#scrollTop = 0;
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
    if (ch === "\x10" && !this.#overlay) {
      this.#opts.onPalette?.();
      return;
    }
    // `?` opens help only on an empty, idle composer — in any other state it
    // is a perfectly ordinary question mark.
    if (
      ch === "?" &&
      !this.#overlay &&
      !this.#question &&
      !this.#confirm &&
      this.#edit === ""
    ) {
      this.openHelp();
      return;
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
        // let the paste terminator sequence complete via the escape machine
      } else {
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
    }
    if (this.#confirm) {
      if (!(this.#inPaste && (ch === "\x1b" || this.#held))) {
        const done = this.#confirm;
        this.#confirm = null;
        if (ch === "y" || ch === "Y") {
          done("once");
        } else if (ch === "a" || ch === "A") {
          done("always");
        } else if (ch === "n" || ch === "N" || ch === "\r" || ch === "\n" || ch === "\x03") {
          done("deny");
        } else {
          this.#confirm = done;
        }
        return;
      }
    }
    if (ch === "\x1b") {
      const now = Date.now();
      if (this.#escAt > 0 && this.#held === "\x1b" && now - this.#escAt < 500) {
        this.#escAt = 0;
        this.#lastBareEscAt = 0;
        this.#held = "";
        this.#doubleEsc();
        return;
      }
      this.#escAt = now;
      this.#held = "\x1b";
      return;
    }
    if (this.#held) {
      if (this.#held === "\x1b") {
        if (ch === "[" || ch === "O") {
          this.#escAt = 0;
          this.#held += ch;
          return;
        }
        const now = Date.now();
        if (this.#lastBareEscAt > 0 && now - this.#lastBareEscAt < 500) {
          this.#lastBareEscAt = 0;
          this.#doubleEsc();
        } else {
          this.#lastBareEscAt = now;
        }
        this.#held = "";
      } else {
        this.#held += ch;
        const final = /[A-Za-z~]/.test(ch);
        if (this.#held.length >= 2 && final) this.#escape(this.#held);
        return;
      }
    }
    switch (ch) {
      case "\r":
      case "\n": {
        const line = this.#edit;
        this.#edit = "";
        this.#cursor = 0;
        if (!line.trim()) {
          this.requestPaint();
          return;
        }
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
          this.#queue.push(line);
          this.pushSystem(`queued: ${line}`);
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

  #escape(seq: string): void {
    this.#held = "";
    const kind = seq.slice(2);
    if (kind.startsWith("<")) {
      const m = /^<(\d+);(\d+);(\d+)([Mm])$/.exec(kind);
      if (m) {
        const button = Number(m[1]);
        const row = Number(m[3]);
        if (button === 64 || button === 4) this.#scrollBy(-3);
        else if (button === 65 || button === 5) this.#scrollBy(3);
        else if (m[4] === "M" && button === 0) this.#clickAt(row);
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
        if (this.#history.length) {
          if (this.#histCursor < 0) this.#histCursor = this.#history.length - 1;
          else this.#histCursor = Math.max(0, this.#histCursor - 1);
          this.#chooseHistory();
        }
        break;
      case "B":
        if (this.#histCursor >= 0) {
          this.#histCursor += 1;
          if (this.#histCursor >= this.#history.length) this.#histCursor = -1;
          this.#chooseHistory();
        }
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
      default:
        break;
    }
  }

  #chooseHistory(): void {
    this.#setEdit(this.#histCursor < 0 ? "" : this.#history[this.#histCursor]);
  }

  #setEdit(value: string): void {
    this.#edit = value;
    this.#cursor = value.length;
    this.requestPaint();
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
      this.requestPaint();
      return;
    }
    const item = u.item;
    if (!item?.tool || typeof item.tool.output !== "string") return;
    item.tool.expanded = !item.tool.expanded;
    this.#invalidateItem(item);
    this.requestPaint();
  }

  #follow(): void {
    this.#scrollTop = Math.max(0, this.#contentLines() - this.#viewHeight());
  }

  #viewHeight(): number {
    const pw = this.#panelWidth();
    const w = pw ? Math.max(20, this.#cols - pw - Tui.PANEL_GAP) : this.#cols;
    const k = this.#inputLineCount(w);
    return Math.max(1, this.#rows - 7 - k);
  }

  #inputLineCount(width: number): number {
    if (this.#question || this.#confirmText) return 1;
    const limit = Math.max(4, width - 4);
    return this.#wrapEdit(this.#edit, limit).length;
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
      return [this.#clip(`${icon} ${accent(t.name)} ×${g.items.length}${muted("   click to expand")}`, this.#bodyCols())];
    }
    const rows = g.items.flatMap((it) => this.#toolRow(it));
    rows.push(this.#clip(muted("   click to collapse"), this.#bodyCols()));
    return rows;
  }

  #panelTodos(): TodoItem[] | null {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const t = this.#items[i].tool;
      if (t && Array.isArray(t.todos) && t.todos.length) return t.todos;
    }
    return null;
  }

  #panelCtx(): { used: number; limit: number; trend?: number[] } | null {
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
    if (this.#cols < 100) return false;
    const todos = this.#panelTodos();
    return !!this.#panelCtx() || (!!todos && todos.some((t) => t.status !== "completed"));
  }

  #panelWidth(): number {
    if (!this.#panelActive()) return 0;
    return Math.min(32, Math.max(24, this.#cols >> 2));
  }

 static readonly PANEL_GAP = 3;

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

  #bodyCols(): number {
    const pw = this.#panelWidth();
    return pw ? Math.max(20, this.#cols - pw - Tui.PANEL_GAP) : this.#cols;
  }

  #panelSeg(content: string | undefined, pw: number): string {
    const bg = this.#surface();
    const s = `  ${this.#clip(content ?? "", Math.max(1, pw - 2))}`;
    return bg + s.split(RESET).join(RESET + bg) + RESET;
  }

  #progressBar(pct: number, width: number): string {
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    if (pct >= 95) return danger(bar);
    if (pct >= 80) return warn(bar);
    return success(bar);
  }

  #panelLines(pw: number): string[] {
    const lines: string[] = [];
    const ctx = this.#panelCtx();
    if (ctx) {
      const used = Math.min(ctx.used, ctx.limit);
      const pct = Math.round((used / ctx.limit) * 100);
      lines.push(accent(bold("CONTEXT")));
      const bw = Math.min(12, Math.max(8, pw - 8));
      lines.push(this.#progressBar(pct, bw));
      const spark = Tui.sparkline(ctx.trend);
      lines.push(muted(`${this.#fmtTok(used)} / ${this.#fmtTok(ctx.limit)} · ${pct}%${spark ? `  ${spark}` : ""}`));
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

  #renderBlock(item: TuiItem): string[] {
    const limit = Math.max(1, this.#bodyCols() - 3);
    if (item.role === "assistant") {
      const lines = this.#markdown(item.text, limit);
      return lines.map((line) => `   ${line}`);
    }
    const body = item.text ? this.#wrap(item.text, limit) : [""];
    switch (item.role) {
      case "banner":
        return body.map((line) => bold(cyan(line)));
      case "user": {
        const rows = [this.#userRow("")];
        for (const line of body) rows.push(this.#userRow(line));
        rows.push(this.#userRow(""));
        return rows;
      }
      case "system":
        return body.map((line) => (item.red ? red(`  ${line}`) : dim(`  ${line}`)));
      case "footer":
        return body.map((line, i) =>
          i === 0 ? cyan("▣") + dim(line.slice(1)) : dim(`  ${line}`),
        );
      case "tool": {
        const rows = this.#toolRow(item);
        const t = item.tool;
        if (t && t.ok === false && t.error) {
          for (const line of this.#wrap(t.error, this.#bodyCols())) rows.push(this.#clip(`   ${red(line)}`, this.#bodyCols()));
        }
        if (t && typeof t.output === "string" && t.output.trim()) {
          const all = t.output.replace(/\r\n?/g, "\n").split("\n");
          const shown = t.expanded ? all : all.slice(0, 3);
          for (const l of shown) rows.push(this.#clip(`   ${dim(l || " ")}`, this.#bodyCols()));
          if (!t.expanded && all.length > 3) {
            rows.push(this.#clip(dim(`   … ${all.length - 3} more · click to expand`), this.#bodyCols()));
          } else if (t.expanded) {
            rows.push(this.#clip(dim("   click to collapse"), this.#bodyCols()));
          }
          if (t.outputCapped) rows.push(this.#clip(dim("   … output truncated at 32KB"), this.#bodyCols()));
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
    if (!t) return [this.#clip(item.text, bodyCols)];
    const icon = t.ok === undefined ? warn("▶") : t.ok ? success("✓") : danger("✗");
    const name = t.ok === false ? danger(`${t.name} failed`) : t.name;
    const argText = (t.args ?? "").replace(/\s*\n+\s*/g, " ").trim();
    // All tool rows are plain full-width lines (no background, no border);
    // the argument text wraps onto extra lines instead of being clipped.
    const line = (s: string): string => this.#clip(s, bodyCols);
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
  #diffPairs(d: DiffLine[]): Array<{ del: string; add: string }> {
    const pairs: Array<{ del: string; add: string }> = [];
    let i = 0;
    while (i < d.length) {
      if (d[i].t === "del") {
        const dels: string[] = [];
        while (i < d.length && d[i].t === "del") {
          dels.push(d[i].s);
          i += 1;
        }
        const adds: string[] = [];
        while (i < d.length && d[i].t === "add") {
          adds.push(d[i].s);
          i += 1;
        }
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k += 1) {
          pairs.push({ del: dels[k] ?? "", add: adds[k] ?? "" });
        }
      } else {
        while (i < d.length && d[i].t === "add") {
          pairs.push({ del: "", add: d[i].s });
          i += 1;
        }
      }
    }
    return pairs;
  }

  /**
   * Side-by-side diff (opencode style): left cell = removed (red tint),
   * right cell = added (green tint), no border, full history width.
   */
  #diffRows(item: TuiItem): string[] {
    const t = item.tool;
    if (!t || !t.diff || !t.diff.length) return [];
    const bodyCols = this.#bodyCols();
    const leftW = Math.max(4, Math.floor((bodyCols - 1) / 2));
    const rightW = Math.max(4, bodyCols - 1 - leftW);
    const delBg = this.#dark ? DEL_BG : DEL_BG_LIGHT;
    const addBg = this.#dark ? ADD_BG : ADD_BG_LIGHT;
    const surf = this.#surface();
    const cell = (bg: string, text: string, w: number): string =>
      `${bg}${this.#clip(text, w)}${RESET}`;
    const rows = this.#diffPairs(t.diff).map(
      (p) =>
        `${cell(p.del ? delBg : surf, p.del ? `- ${p.del}` : "", leftW)} ` +
        `${cell(p.add ? addBg : surf, p.add ? `+ ${p.add}` : "", rightW)}`,
    );
    if (t.truncated) {
      rows.push(this.#clip(dim(`… ${t.truncated} more line(s)`), bodyCols));
    }
    return rows;
  }

  #userRow(line: string): string {
    const bg = this.#surface();
    const inner = Math.max(1, this.#bodyCols() - 2);
    const raw = `${cyan("┃")} ${this.#clip(line, inner)}`;
    return bg + raw.split(RESET).join(RESET + bg) + RESET;
  }

  #boxLine(content: string, width: number): string {
    const bg = this.#surface();
    const inner = Math.max(1, width - 2);
    const raw = `${cyan("┃")} ${this.#clip(content, inner)}`;
    return bg + raw.split(RESET).join(RESET + bg) + RESET;
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
      const hint = dim("  Enter to send · ctrl-c to cancel");
      return { lines: [`${cyan("❯")} ${this.#qbuf}${hint}`], segs: [this.#qbuf], ci: 0, col: this.#qbuf.length };
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
    const limit = Math.max(4, width - 4);
    const segs = this.#wrapEdit(this.#edit, limit);
    const lines = segs.map((s, i) => (i === 0 ? s : `  ${s}`));
    let before = 0;
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
    const agent = m.agent === "plan" ? warn(bold(m.agent)) : accent(bold(m.agent));
    return `${agent}${muted(" · ")}${m.model}${muted(" · ")}${muted(m.provider)}`;
  }

  #hintsRow(width: number): string {
    const usage = this.#usageText();
    // Contextual footer: only what is actionable right now (progressive disclosure).
    let hint: string;
    if (this.#confirmText) hint = "y once · a always · n deny";
    else if (this.#question) hint = "enter answer · esc cancel";
    else if (this.#opts.busy()) hint = "esc escape twice to cancel · enter queues";
    else hint = "? help · /commands · ctrl-p palette · tab complete";
    const left = dim(`${this.#opts.cwd}   ${hint}`);
    if (!usage) return this.#clip(left, width);
    const right = usage;
    const pad = Math.max(1, width - cols(left) - cols(right) - 1);
    return this.#clip(`${left}${" ".repeat(Math.min(pad, 200))}${right}`, width);
  }

  #statusRow(width: number): string {
    const b = this.#opts.statusBadge?.() ?? null;
    const badge = b ? `${b.ok ? success(b.glyph) : danger(b.glyph)} ${muted(b.label)}` : "";
    const pending = this.#confirmText
      ? `${danger(bold("⚠ APPROVAL PENDING"))}  `
      : this.#question
        ? `${warn(bold("❓ AWAITING ANSWER"))}  `
        : "";
    const l =
      pending +
      (badge ? `${badge}${muted("  ")}` : "") +
      (this.#opts.statusLeft ? muted(this.#opts.statusLeft) : "");
    const r = this.#opts.statusRight ? muted(this.#opts.statusRight) : "";
    const pad = Math.max(1, width - cols(l) - cols(r) - 1);
    return this.#clip(`${l}${" ".repeat(Math.min(pad, 200))}${r}`, width);
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
    const top = Math.max(0, Math.min(ov.sel - (maxRows >> 1), Math.max(0, rows.length - maxRows)));
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
      const isSel = i === ov.sel;
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
    this.#cols = process.stdout.columns || 80;
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
    const leftW = panel ? Math.max(20, width - pw - Tui.PANEL_GAP) : width;
    let rowIdx = 0;
    const row = (content: string): { left: string; right?: string } => {
      const left = this.#clip(content, leftW);
      if (!panel) return { left };
      return { left, right: this.#panelSeg(panel[rowIdx++], pw) };
    };

    const rows: Array<{ left: string; right?: string }> = [];
    for (let i = 0; i < view; i += 1) {
      rows.push(row(this.#clip(body[this.#scrollTop + i] ?? "", leftW)));
    }

    if (this.#overlay) {
      // centered modal: horizontally centered over the full window width,
      // vertically over the body area; right panel border stays put.
      const { lines: box, width: bw } = this.#paletteBox(leftW);
      const padLeft = Math.max(0, ((leftW - bw) >> 1));
      // center over the full window minus the ~9-row input/footer block
      const freeRows = Math.max(box.length, this.#rows - 9);
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

    rows.push(row(""));
    rows.push(row(this.#boxLine("", leftW)));
    let cursorIdx = -1;
    for (let i = 0; i < il.lines.length; i += 1) {
      rows.push(row(this.#boxLine(i === 0 ? firstLine : il.lines[i], leftW)));
      if (i === il.ci) cursorIdx = rows.length - 1;
    }
    rows.push(row(this.#boxLine("", leftW)));
    rows.push(row(this.#boxLine(this.#metaContent(), leftW)));

    const tag = this.#scrollTop > 0 ? ` ↑${this.#scrollTop}` : "";
    rows.push(row(`${dim("-".repeat(Math.max(1, leftW - cols(tag))))}${tag ? dim(tag) : ""}`));

    rows.push(row(this.#hintsRow(leftW)));
    rows.push(row(this.#statusRow(leftW)));

    const lines = rows.map((r) => r.left + (r.right ?? ""));
    const geomChanged = this.#lastLines.length !== lines.length;
    const clear = this.#clearNext || geomChanged ? `${CSI}2J` : "";
    if (this.#clearNext || geomChanged) this.#lastLines = [];
    this.#clearNext = false;
    const curRow = Math.max(1, cursorIdx + 1);
    const curCol = Math.min(width - 1, 4 + cols((il.segs[il.ci] ?? "").slice(0, il.col)));
    if (!clear && lines.every((line, i) => line === this.#lastLines[i])) {
      process.stdout.write(`${CSI}${curRow};${curCol + 1}H`);
      return;
    }
    let out = `${CSI}?2026h${HIDE}${CSI}H${clear}`;
    const panelCol = width - pw + 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (this.#lastLines[i] === lines[i]) continue;
      out += `${CSI}${i + 1};1H${rows[i].left}`;
      if (rows[i].right) out += `${CSI}${i + 1};${panelCol}H${rows[i].right}`;
    }
    this.#lastLines = lines;
    out += `${CSI}${curRow};${curCol + 1}H${SHOW}${CSI}?2026l`;
    process.stdout.write(out);
  }
}

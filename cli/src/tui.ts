import { bold, blue, cyan, dim, green, italic, magenta, red, underline, yellow } from "./ui.js";
import type { DiffLine } from "./diff.js";
import { capDiff } from "./diff.js";

export interface TodoItem {
  content: string;
  status: string;
}

export interface ToolView {
  name: string;
  args: string;
  callId: string;
  ok?: boolean;
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
  ctxUsage?(): { used: number; limit: number };
  completions?(): string[];
  onTab?(): void;
}

const CSI = "\x1b[";
const HIDE = `${CSI}?25l`;
const SHOW = `${CSI}?25h`;
const BOX_BG = `${CSI}48;5;236m`;
const RESET = `${CSI}0m`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

const AMBIGUOUS_WIDE = new Set([
  0x2299, 0x23f9, 0x25a3, 0x25c8, 0x2699, 0x26a0, 0x2705, 0x2717, 0x2753, 0x276f,
]);
const CJK_LOCALE = /zh|ja|ko|_sc|_tc/i.test(
  `${process.env.LANG ?? ""} ${process.env.LC_ALL ?? ""} ${process.env.LC_CTYPE ?? ""}`,
);

function wide(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  if (CJK_LOCALE && AMBIGUOUS_WIDE.has(c)) return true;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

function cols(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const ch of plain) n += wide(ch) ? 2 : 1;
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
      const w = wide(ch) ? 2 : 1;
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

function fmtArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object" || Array.isArray(args)) {
    const s = JSON.stringify(args);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
  const parts = Object.entries(args as Record<string, unknown>).map(
    ([k, v]) => `${k}=${JSON.stringify(v)}`,
  );
  const s = parts.join(" ");
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

type Unit =
  | { kind: "item"; index: number; item: TuiItem }
  | { kind: "group"; start: number; items: TuiItem[] };

export class Tui {
  #opts: TuiOptions;
  #items: TuiItem[] = [];
  #bodyUnitIdx: number[] = [];
  #groupOpen = new Map<number, boolean>();
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

  constructor(opts: TuiOptions) {
    this.#opts = opts;
  }

  start(): void {
    if (!process.stdin.isTTY) throw new Error("Tui requires a TTY");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => this.#feed(data.toString("utf8")));
    process.stdout.on("resize", () => {
      this.#clearNext = true;
      this.requestPaint();
    });
    process.on("exit", this.#restore);
    this.#running = true;
    process.stdout.write(`${CSI}?1049h${CSI}?1000h${CSI}?1006h`);
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
    process.stdout.write(`${CSI}?1000l${CSI}?1006l${CSI}?1049l${SHOW}`);
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
      this.#frame = (this.#frame + 1) % SPINNER.length;
      this.requestPaint();
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
    process.stdout.write(`${CSI}?1000l${CSI}?1006l${CSI}?1049l${SHOW}`);
  };

  push(item: TuiItem): void {
    this.#items.push(item);
    this.#follow();
    this.requestPaint();
  }

  pushTool(name: string, args: unknown, callId: string): void {
    this.#items.push({
      role: "tool",
      text: name,
      tool: { name, args: fmtArgs(args), callId, ok: undefined },
    });
    this.#follow();
    this.requestPaint();
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
    }
    this.requestPaint();
  }

  pushDelta(text: string): void {
    const last = this.#items[this.#items.length - 1];
    if (last && last.role === "assistant") last.text += text;
    else this.#items.push({ role: "assistant", text });
    this.#follow();
    this.requestPaint();
  }

  resetStream(): void {
    const last = this.#items[this.#items.length - 1];
    if (last && last.role === "assistant") {
      last.text = "";
      this.requestPaint();
    }
  }

  pushSystem(text: string): void {
    this.push({ role: "system", text });
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

  #feed(data: string): void {
    for (const ch of data) this.#char(ch);
  }

 #char(ch: string): void {
    if (this.#question) {
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
    if (!this.#bodyUnitIdx.length) return;
    const view = this.#viewHeight();
    if (row < 1 || row > view) return;
    const ui = this.#bodyUnitIdx[row - 1 + this.#scrollTop];
    if (ui === undefined) return;
    const u = this.#units()[ui];
    if (!u) return;
    if (u.kind === "group") {
      this.#groupOpen.set(u.start, !this.#groupOpen.get(u.start));
      this.requestPaint();
      return;
    }
    const item = u.item;
    if (!item?.tool || typeof item.tool.output !== "string") return;
    item.tool.expanded = !item.tool.expanded;
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
      let line = "";
      for (const ch of seg) {
        if (cols(line) + (wide(ch) ? 2 : 1) > limit) {
          out.push(line);
          line = "";
        }
        line += ch;
      }
      out.push(line);
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
    let inCode = false;
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\s*```/.test(raw)) {
        inCode = !inCode;
        continue;
      }
      const t = raw.replace(/\s+$/, "");
      if (!t.trim()) {
        out.push("");
        continue;
      }
      if (inCode) {
        out.push(...wrapStyled(highlightCode(t), limit));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        out.push(...wrapStyled(bold(inlineMd(h[2].trim())), limit));
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(t)) {
        out.push(dim("─".repeat(Math.min(limit, 48))));
        continue;
      }
      const q = /^\s*>\s?(.*)$/.exec(t);
      if (q) {
        prefixed(yellow(italic("> ")), q[1], (b) => yellow(italic(b)));
        continue;
      }
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(t);
      if (li) {
        const marker = /^\d/.test(li[1]) ? cyan(`${li[1]} `) : blue("•");
        prefixed(marker, li[2]);
        continue;
      }
      out.push(...wrapStyled(inlineMd(t), limit));
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
    const t = g.items[0].tool!;
    const icon = TOOL_ICONS[t.name] ?? "⚙";
    if (!this.#groupOpen.get(g.start)) {
      return [this.#clip(`${icon} ${t.name} ×${g.items.length}${dim("   click to expand")}`, this.#bodyCols())];
    }
    const rows = g.items.map((it) => this.#toolRow(it));
    rows.push(this.#clip(dim("   click to collapse"), this.#bodyCols()));
    return rows;
  }

  #panelTodos(): TodoItem[] | null {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const t = this.#items[i].tool;
      if (t && Array.isArray(t.todos) && t.todos.length) return t.todos;
    }
    return null;
  }

  #panelCtx(): { used: number; limit: number } | null {
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

  #bodyCols(): number {
    const pw = this.#panelWidth();
    return pw ? Math.max(20, this.#cols - pw - Tui.PANEL_GAP) : this.#cols;
  }

  #panelSeg(content: string | undefined, pw: number): string {
    const s = `  ${this.#clip(content ?? "", Math.max(1, pw - 2))}`;
    return BOX_BG + s.split(RESET).join(RESET + BOX_BG) + RESET;
  }

  #panelLines(pw: number): string[] {
    const lines: string[] = [];
    const ctx = this.#panelCtx();
    if (ctx) {
      const used = Math.min(ctx.used, ctx.limit);
      const pct = Math.round((used / ctx.limit) * 100);
      lines.push(bold("CONTEXT"));
      lines.push(`${this.#fmtTok(ctx.used)} tokens`);
      lines.push(`${pct}% used`);
      lines.push(`limit ${this.#fmtTok(ctx.limit)}`);
    }
    const todos = this.#panelTodos();
    if (todos && todos.some((t) => t.status !== "completed")) {
      if (lines.length) lines.push("");
      const done = todos.filter((t) => t.status === "completed").length;
      lines.push(bold(`TODO ${done}/${todos.length}`));
      for (const t of todos) {
        if (t.status === "in_progress") lines.push(`${yellow(bold("›"))} ${bold(t.content)}`);
        else if (t.status === "completed") lines.push(`${green("x")} ${dim(t.content)}`);
        else if (t.status === "cancelled") lines.push(`${dim("-")} ${dim(t.content)}`);
        else lines.push(`${dim("·")} ${t.content}`);
      }
    }
    return lines;
  }

  #todoRow(t: TodoItem): string {
    if (t.status === "in_progress") return `   ${yellow(bold("> "))}${bold(t.content)}`;
    if (t.status === "completed") return `   ${green("x ")}${dim(t.content)}`;
    if (t.status === "cancelled") return `   ${dim("- ")}${dim(t.content)}`;
    return `   ${dim("· ")}${t.content}`;
  }

    #block(item: TuiItem): string[] {
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
        const rows = [this.#toolRow(item)];
        const t = item.tool;
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
          for (const d of item.tool.diff) {
            rows.push(d.t === "add" ? `   ${green(`+ ${d.s}`)}` : `   ${red(`- ${d.s}`)}`);
          }
          if (item.tool.truncated) {
            rows.push(dim(`   … ${item.tool.truncated} more line(s)`));
          }
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

  #toolRow(item: TuiItem): string {
    const t = item.tool;
    if (!t) return this.#clip(item.text, this.#bodyCols());
    const icon = TOOL_ICONS[t.name] ?? "⚙";
    const args = t.args ? ` ${dim(t.args)}` : "";
    if (t.ok === undefined) {
      return this.#clip(`${cyan("~")} ${t.name}${args}`, this.#bodyCols());
    }
    if (t.ok) {
      return this.#clip(`${icon} ${t.name}${args}`, this.#bodyCols());
    }
    return this.#clip(`${red("⚠ ")} ${red(`${t.name} failed`)}${args}`, this.#bodyCols());
  }

  #userRow(line: string): string {
    const inner = Math.max(1, this.#bodyCols() - 2);
    const raw = `${cyan("┃")} ${this.#clip(line, inner)}`;
    return BOX_BG + raw.split(RESET).join(RESET + BOX_BG) + RESET;
  }

  #boxLine(content: string, width: number): string {
    const inner = Math.max(1, width - 2);
    const raw = `${cyan("┃")} ${this.#clip(content, inner)}`;
    return BOX_BG + raw.split(RESET).join(RESET + BOX_BG) + RESET;
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
      const cw = wide(ch) ? 2 : 1;
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
    const agent = m.agent === "plan" ? yellow(m.agent) : cyan(m.agent);
    return `${agent}${dim(" · ")}${m.model}${dim(" · ")}${dim(m.provider)}`;
  }

  #hintsRow(width: number): string {
    const usage = this.#usageText();
    const left = dim(`${this.#opts.cwd}   tab complete · / commands · exit quit`);
    if (!usage) return this.#clip(left, width);
    const right = usage;
    const pad = Math.max(1, width - cols(left) - cols(right) - 1);
    return this.#clip(`${left}${" ".repeat(Math.min(pad, 200))}${right}`, width);
  }

 #statusRow(width: number): string {
    const b = this.#opts.statusBadge?.() ?? null;
    const badge = b ? `${b.ok ? green(b.glyph) : red(b.glyph)} ${dim(b.label)}` : "";
    const pending = this.#confirmText
      ? `${red(bold("⚠ APPROVAL PENDING"))}  `
      : this.#question
        ? `${yellow(bold("❓ AWAITING ANSWER"))}  `
        : "";
    const l =
      pending +
      (badge ? `${badge}${dim("  ")}` : "") +
      (this.#opts.statusLeft ? dim(this.#opts.statusLeft) : "");
    const r = this.#opts.statusRight ? dim(this.#opts.statusRight) : "";
    const pad = Math.max(1, width - cols(l) - cols(r) - 1);
    return this.#clip(`${l}${" ".repeat(Math.min(pad, 200))}${r}`, width);
  }

  #clip(line: string, width: number): string {
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
      const w = wide(ch) ? 2 : 1;
      if (n + w > width) break;
      out += ch;
      n += w;
      i += ch.length;
    }
    return out + " ".repeat(Math.max(0, width - n));
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

    const il = this.#inputLayout(leftW);
    let firstLine: string;
    if (this.#question || this.#confirmText) {
      firstLine = il.lines[0];
    } else {
      const busyNow = this.#opts.busy();
      const prompt = busyNow
        ? `${cyan(SPINNER[this.#frame])} `
        : `${cyan("❯")} `;
      firstLine = prompt + (il.segs[0] ?? "");
      if (!this.#edit && !busyNow) {
        firstLine = prompt + dim(this.#opts.placeholder);
      } else if (busyNow && this.#busySince) {
        firstLine += `  ${dim(`${Math.floor((Date.now() - this.#busySince) / 1000)}s`)}`;
      }
      if (!busyNow && il.lines.length === 1 && this.#cursor === 0) {
        const g = this.#ghost();
        if (g) firstLine += dim(`${g}  (Tab to accept)`);
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

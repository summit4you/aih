const enabled =
  process.stderr.isTTY === true && !process.env.NO_COLOR ? true : false;

export function paint(text: string, code: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const dim = (s: string) => paint(s, "2");
export const bold = (s: string) => paint(s, "1");
export const cyan = (s: string) => paint(s, "36");
export const green = (s: string) => paint(s, "32");
export const yellow = (s: string) => paint(s, "33");
export const red = (s: string) => paint(s, "31");
export const blue = (s: string) => paint(s, "34");
export const magenta = (s: string) => paint(s, "35");
export const italic = (s: string) => paint(s, "3");
export const underline = (s: string) => paint(s, "4");

/**
 * Gradient rendering (qwen-code Header parity — light, zero-dependency).
 *
 * qwen-code renders its startup logo with `ink-gradient` (per-character
 * 24-bit RGB interpolation between theme colors). AIH keeps the same visual
 * effect without the dependency: this interpolates between `colors` across
 * the printable characters of `text` and emits per-character truecolor SGR
 * (`\x1b[38;2;r;g;bm`), falling back to the plain text when the terminal
 * lacks color (same `enabled` gate as paint) or when fewer than two colors
 * are given. ANSI sequences already present in the input pass through
 * untouched and do not advance the gradient position.
 */
export function gradientText(text: string, colors: readonly string[]): string {
  if (!enabled || colors.length < 2) return text;
  // Count interpolatable characters (skip ANSI escape runs).
  const esc = /\x1b\[[0-9;]*m/g;
  const chars = text.replace(esc, "");
  const n = chars.length;
  if (n === 0) return text;
  // Parse "#rrggbb" (accept 3-digit shorthand; fall back to a default cyan).
  const parse = (c: string): [number, number, number] => {
    const h = c.replace(/^#/, "");
    const v =
      h.length === 3
        ? h.split("").map((x) => x + x).join("")
        : h.length === 6
          ? h
          : "00bcd4";
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  };
  const stops = colors.map(parse);
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  // Rebuild with one scan: emit escape runs verbatim, interpolate the rest.
  let out = "";
  let plainIdx = 0;
  let pos = 0;
  const iterator = text.matchAll(esc);
  let m = iterator.next();
  while (pos < text.length) {
    if (!m.done && m.value.index === pos) {
      out += m.value[0];
      pos += m.value[0].length;
      m = iterator.next();
      continue;
    }
    const ch = text[pos];
    const t = plainIdx / Math.max(1, n - 1);
    const k = t * (stops.length - 1);
    const i0 = Math.min(Math.floor(k), stops.length - 2);
    const f = k - i0;
    const [r, g, b] = stops[i0];
    const [r2, g2, b2] = stops[i0 + 1];
    const col = `38;2;${lerp(r, r2, f)};${lerp(g, g2, f)};${lerp(b, b2, f)}`;
    out += `\x1b[${col}m${ch}\x1b[0m`;
    plainIdx++;
    pos++;
  }
  return out;
}

// Semantic tokens — prefer these over raw colors for app-level meaning.
export const accent = cyan; // primary / interactive (prompts, links, active)
export const success = green; // done / ok
export const warn = yellow; // in-progress / caution
export const danger = red; // failed / denied
export const muted = dim; // secondary / meta
export const info = blue; // secondary accent

export function toolTrace(name: string, args: unknown): string {
  return `${cyan("⚙")} ${bold(name)} ${dim(JSON.stringify(args))}`;
}

export function turnFooter(parts: Array<string | undefined>): string {
  return dim(`[${parts.filter(Boolean).join(", ")}]`);
}

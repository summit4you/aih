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

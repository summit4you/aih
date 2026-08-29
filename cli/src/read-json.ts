import { readFileSync } from "node:fs";

/**
 * #55 (CC) — read a JSON file with UTF-8 BOM tolerance.
 *
 * Windows editors save UTF-8 files with a leading byte-order mark (\uFEFF),
 * which makes plain `JSON.parse(readFileSync(p,"utf8"))` throw a SyntaxError.
 * Strip the BOM before parsing so aih.json / config.json / SKILL.md front
 * matter / workflow / jobboard JSON all load cleanly regardless of editor.
 *
 * Throws the original parse error (wrapped with the path) when the file is
 * genuinely invalid.
 */
export function readJson<T = unknown>(path: string): T {
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as T;
}

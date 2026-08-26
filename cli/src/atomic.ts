/**
 * Atomic file publish for tool writes: temp file + rename in the same
 * directory. Readers (including this process's own paint timer reading
 * config files) never observe a truncated or half-written file, and a crash
 * mid-write leaves the previous version intact — the exact failure class
 * that killed a live TUI when `edit` rewrote aih.json while #paint parsed it.
 */
import { dirname, basename } from "node:path";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

export function publishFile(path: string, data: string): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${dir}/${basename(path)}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

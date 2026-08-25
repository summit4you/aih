import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionLog } from "./session-log.js";
import type { SessionEvent } from "./types.js";

export class SessionStore {
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  save(log: SessionLog): void {
    // Never overwrite an existing non-empty session with an empty log: a
    // crashed/failed resume used to truncate good history to a 1-byte file.
    if (log.all().length === 0 && existsSync(this.#path)) return;
    this.#publish(
      `${log.all().map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
  }

  load(): SessionLog | undefined {
    if (!existsSync(this.#path)) return undefined;
    const lines = readFileSync(this.#path, "utf8").split("\n");
    const events: SessionEvent[] = [];
    const badLines: number[] = [];
    let lastGoodLine = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
        lastGoodLine = i;
      } catch {
        badLines.push(i);
      }
    }
    if (badLines.length === 0) return SessionLog.fromEvents(events);
    // Torn tail (crash mid-write): every unparsable line sits after the last
    // good one. Repair by republishing just the valid prefix, atomically.
    if (badLines.every((i) => i > lastGoodLine)) {
      process.stderr.write(
        `warning: ${this.#path}: dropped ${badLines.length} torn trailing line(s)\n`,
      );
      this.#publish(`${lines.slice(0, lastGoodLine + 1).join("\n")}\n`);
      return SessionLog.fromEvents(events);
    }
    // Interior corruption: keep the parseable events but leave the file alone
    // (never destroy evidence silently).
    process.stderr.write(
      `warning: ${this.#path}: ${badLines.length} corrupt line(s) inside the session skipped\n`,
    );
    return SessionLog.fromEvents(events);
  }

  /** Write via temp file + rename in the same directory: readers never see a half-written file, and a crash mid-save leaves the previous version intact. */
  #publish(text: string): void {
    const dir = dirname(this.#path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.#path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, this.#path);
  }

  #metaPath(): string {
    return `${this.#path}.meta.json`;
  }

  title(): string | undefined {
    try {
      const meta = JSON.parse(readFileSync(this.#metaPath(), "utf8")) as { title?: unknown };
      return typeof meta.title === "string" && meta.title ? meta.title : undefined;
    } catch {
      return undefined;
    }
  }

  setTitle(title: string): void {
    const dir = dirname(this.#path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.#metaPath(), JSON.stringify({ title }) + "\n", "utf8");
  }

  static dir(root = ".aih/sessions"): string {
    return root;
  }
}

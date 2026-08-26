import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionLog } from "./session-log.js";
import type { SessionEvent } from "./types.js";

export class SessionStore {
  #path: string;
  /** Last seq known to be in the file (full publish or incremental append). */
  #flushedSeq = -1;
  /** File byte size at the last flush — detects out-of-band writes/rewrites. */
  #flushedBytes = -1;

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
    const text = `${log.all().map((e) => JSON.stringify(e)).join("\n")}\n`;
    this.#publish(text);
    this.#rebaseline(log.all());
  }

  /**
   * Durability between turns: append only the events past #flushedSeq
   * (single-line appends, µs each — safe to call from the event subscription).
   * Ownership contract: one store instance owns one file. If the file's size
   * no longer matches what this store last wrote (external writer, rewrite,
   * or a lagging baseline), fall back to a full publish so the file always
   * converges to THIS store's log. A torn final line from a crash mid-append
   * is repaired by load().
   */
  flushIncremental(log: SessionLog): void {
    const all = log.all();
    const lastSeq = all.length ? all[all.length - 1].seq : -1;
    if (lastSeq <= this.#flushedSeq) return;
    if (this.#flushedSeq < 0 || !existsSync(this.#path)) return; // no baseline yet
    let size = -1;
    try {
      size = statSync(this.#path).size;
    } catch {
      return;
    }
    if (size !== this.#flushedBytes) {
      this.save(log); // out-of-band change → converge to our truth
      return;
    }
    const bySeq = new Map(all.map((e) => [e.seq, e]));
    const lines: string[] = [];
    for (let s = this.#flushedSeq + 1; s <= lastSeq; s++) {
      const e = bySeq.get(s);
      if (!e) {
        this.save(log);
        return;
      }
      lines.push(JSON.stringify(e));
    }
    const chunk = `${lines.join("\n")}\n`;
    appendFileSync(this.#path, chunk, "utf8");
    this.#flushedSeq = lastSeq;
    this.#flushedBytes = size + Buffer.byteLength(chunk, "utf8");
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
    if (badLines.length === 0) {
      this.#rebaseline(events);
      return SessionLog.fromEvents(events);
    }
    // Torn tail (crash mid-write): every unparsable line sits after the last
    // good one. Repair by republishing just the valid prefix, atomically.
    if (badLines.every((i) => i > lastGoodLine)) {
      process.stderr.write(
        `warning: ${this.#path}: dropped ${badLines.length} torn trailing line(s)\n`,
      );
      this.#publish(`${lines.slice(0, lastGoodLine + 1).join("\n")}\n`);
      this.#rebaseline(events);
      return SessionLog.fromEvents(events);
    }
    // Interior corruption: keep the parseable events but leave the file alone
    // (never destroy evidence silently). Sentinel blocks incremental appends
    // until the next full save re-baselines the store.
    process.stderr.write(
      `warning: ${this.#path}: ${badLines.length} corrupt line(s) inside the session skipped\n`,
    );
    this.#flushedSeq = -2;
    this.#flushedBytes = -1;
    return SessionLog.fromEvents(events);
  }

  /** Re-baseline flush watermarks from a just-published/loaded event list. */
  #rebaseline(events: readonly SessionEvent[]): void {
    this.#flushedSeq = events.length ? events[events.length - 1].seq : -1;
    try {
      this.#flushedBytes = statSync(this.#path).size;
    } catch {
      this.#flushedBytes = -1;
    }
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

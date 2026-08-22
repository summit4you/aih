import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const dir = dirname(this.#path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lines = log.all().map((e) => JSON.stringify(e));
    writeFileSync(this.#path, `${lines.join("\n")}\n`, "utf8");
  }

  load(): SessionLog | undefined {
    if (!existsSync(this.#path)) return undefined;
    const events: SessionEvent[] = [];
    for (const line of readFileSync(this.#path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as SessionEvent);
    }
    return SessionLog.fromEvents(events);
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

import type { ChatMessage, SessionEvent } from "./types.js";

export type SessionListener = (event: SessionEvent) => void;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type SessionEventInput = DistributiveOmit<SessionEvent, "seq" | "ts">;

export class SessionLog {
  #events: SessionEvent[] = [];
  #listeners = new Set<SessionListener>();

  append(event: SessionEventInput): SessionEvent {
    const full = Object.freeze({
      ...event,
      seq: this.#nextSeq(),
      ts: Date.now(),
    }) as SessionEvent;
    this.#events.push(full);
    for (const listener of this.#listeners) listener(full);
    return full;
  }

  #nextSeq(): number {
    const last = this.#events[this.#events.length - 1];
    return last ? last.seq + 1 : 0;
  }

  static fromEvents(events: SessionEvent[]): SessionLog {
    const log = new SessionLog();
    log.#events = events.map((e) => Object.freeze({ ...e }) as SessionEvent);
    return log;
  }

  all(): readonly SessionEvent[] {
    return this.#events;
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  fork(fromSeq = 0): SessionLog {
    const child = new SessionLog();
    child.#events = this.#events
      .filter((e) => e.seq >= fromSeq)
      .map((e) => ({ ...e }));
    return child;
  }

  deriveMessages(systemPrompt?: string): ChatMessage[] {
    let compact: Extract<SessionEvent, { type: "compaction" }> | undefined;
    for (const event of this.#events) {
      if (event.type === "compaction") compact = event;
    }
    // The compaction summary folds into the LEADING system message: some
    // providers (llama.cpp's Qwen3 template) raise "System message must be at
    // the beginning" for a system message anywhere after index 0.
    const summary = compact?.summary;
    const systemContent = summary
      ? systemPrompt
        ? `${systemPrompt}\n\n# Summary of the earlier conversation\n${summary}`
        : `Summary of the earlier conversation:\n${summary}`
      : systemPrompt;
    const messages: ChatMessage[] = [];
    if (systemContent) messages.push({ role: "system", content: systemContent });
    const pushMessage = (event: SessionEvent): void => {
      switch (event.type) {
        case "user/message":
          messages.push({ role: "user", content: event.text });
          break;
        case "assistant/message":
          messages.push({
            role: "assistant",
            content: event.text,
            toolCalls: event.toolCalls,
          });
          break;
        case "tool/result": {
          const call = this.#events.find(
            (e) => e.type === "tool/call" && e.callId === event.callId,
          );
          if (
            call &&
            call.type === "tool/call" &&
            (!compact || call.seq >= compact.seq)
          ) {
            messages.push({
              role: "tool",
              toolCallId: event.callId,
              name: call.name,
              content: JSON.stringify(event.ok ? event.result : { error: event.error }),
            });
          }
          break;
        }
        default:
          break;
      }
    };
    for (const event of this.#events) {
      if (compact && event.seq < compact.seq) continue;
      if (event.type === "compaction") {
        // summary is already folded into the leading system message; only the
        // verbatim recent tail is replayed here.
        if (event.recent) {
          for (const m of event.recent) messages.push(m);
        }
        continue;
      }
      pushMessage(event);
    }
    return messages;
  }
}

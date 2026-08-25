/**
 * MK#43 — tool-result pruning (projection, not deletion).
 *
 * Large tool outputs dominate context long after they are useful. Pruning
 * replaces a tool RESULT in the derived message projection with a short
 * placeholder pointing at the archive; the full text stays in the append-only
 * SessionLog and can be re-read via the `archive_read` tool. The model loses
 * nothing permanently — it just stops paying rent on stale bytes.
 *
 * Deterministic, non-LLM, and orthogonal to compaction: prune never touches
 * user/assistant messages, never summarizes, and always records what it did.
 */
import type { SessionEvent } from "./types.js";

/** Results larger than this (chars) are prune candidates (~4k tokens). */
export const PRUNE_THRESHOLD_CHARS = 16_000;
/** Keep at least this many chars in the placeholder preview. */
const PREVIEW_CHARS = 400;

export interface PruneCandidate {
  callId: string;
  seq: number;
  chars: number;
}

/** Find tool/result events whose serialized body exceeds the threshold. */
export function findPruneCandidates(
  events: readonly SessionEvent[],
  threshold = PRUNE_THRESHOLD_CHARS,
): PruneCandidate[] {
  const out: PruneCandidate[] = [];
  for (const e of events) {
    if (e.type !== "tool/result" || !e.ok) continue;
    const call = events.find((x) => x.type === "tool/call" && x.callId === e.callId);
    // Skip question tools entirely — their answers are part of the dialogue.
    if (call && call.type === "tool/call" && call.name === "question") continue;
    const body = JSON.stringify(e.result ?? "");
    if (body.length > threshold) {
      out.push({ callId: e.callId, seq: e.seq, chars: body.length });
    }
  }
  return out;
}

/** The placeholder the model sees after pruning. */
export function placeholderFor(callId: string, result: unknown): string {
  const body = JSON.stringify(result ?? "");
  return (
    `[pruned: result was ${body.length} chars — first ${PREVIEW_CHARS} follow]\n` +
    body.slice(0, PREVIEW_CHARS) +
    `\n…full output archived; call archive_read with callId "${callId}" to retrieve any part`
  );
}

/** Archive file name for a callId under .aih/archives/. */
export function archiveFileName(callId: string): string {
  return `${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
}

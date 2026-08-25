/**
 * MK#43 — tool-result pruning with lazy archive reads.
 *
 * Old, large tool outputs keep occupying every subsequent prompt. Pruning
 * REPLACES the model-visible copy of a result with a short placeholder that
 * carries an aihs://archive/<callId> address; the full original text stays in
 * the append-only session log (and a side archive file for convenience), and
 * the model can pull it back on demand via the read-only `archive_read` tool.
 *
 * Invariants (Maka):
 *  - the canonical event is NEVER rewritten; pruning only changes what
 *    deriveMessages projects for future requests;
 *  - prune actions themselves are recorded as facts (`tool/result_pruned`);
 *  - placeholder generation is deterministic — no LLM, no summarization.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, ToolDefinition } from "@aih/core";

/** Results larger than this (chars) are prune candidates (~4k tokens). */
export const PRUNE_THRESHOLD_CHARS = 16_000;
/** Placeholder keeps at most this many leading chars of the original. */
export const PLACEHOLDER_HEAD_CHARS = 400;

export interface PruneRecord {
  callId: string;
  name: string;
  /** Original size in chars. */
  chars: number;
}

function archivePath(sessionsDir: string, callId: string): string {
  return join(sessionsDir, "archives", `${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
}

/**
 * Find ok tool/results whose serialized body exceeds `threshold` — the prune
 * candidates, largest first.
 */
export function findPruneCandidates(
  events: readonly SessionEvent[],
  threshold = PRUNE_THRESHOLD_CHARS,
): PruneRecord[] {
  const out: PruneRecord[] = [];
  for (const e of events) {
    if (e.type !== "tool/result" || !e.ok) continue;
    const body = JSON.stringify(e.result ?? "");
    if (body.length > threshold) {
      const call = events.find((x) => x.type === "tool/call" && x.callId === e.callId);
      out.push({
        callId: e.callId,
        name: call && call.type === "tool/call" ? call.name : "unknown",
        chars: body.length,
      });
    }
  }
  return out.sort((a, b) => b.chars - a.chars);
}

/** Persist an output to the archive before pruning. Idempotent per callId. */
export function saveToArchive(sessionsDir: string, callId: string, text: string): void {
  mkdirSync(join(sessionsDir, "archives"), { recursive: true });
  const p = archivePath(sessionsDir, callId);
  if (!existsSync(p)) writeFileSync(p, text, "utf8");
}

/**
 * Select tool/results eligible for pruning: ok results larger than the
 * threshold. Returns one record per callId (the largest wins).
 */
export function selectPrunable(
  events: readonly SessionEvent[],
  thresholdChars = PRUNE_THRESHOLD_CHARS,
): PruneRecord[] {
  const byCall = new Map<string, { name: string; chars: number }>();
  for (const e of events) {
    if (e.type !== "tool/result" || !e.ok) continue;
    const text = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? "");
    if (text.length < thresholdChars) continue;
    const call = events.find((x) => x.type === "tool/call" && x.callId === e.callId);
    const prev = byCall.get(e.callId);
    if (!prev || prev.chars < text.length) {
      byCall.set(e.callId, {
        name: call && call.type === "tool/call" ? call.name : "unknown",
        chars: text.length,
      });
    }
  }
  return [...byCall.entries()]
    .map(([callId, v]) => ({ callId, name: v.name, chars: v.chars }))
    .sort((a, b) => b.chars - a.chars);
}

/** Read back an archived output (archive_read body). Undefined when absent. */
export function readArchive(
  sessionsDir: string,
  callId: string,
  offsetLine = 1,
  maxLines = 2000,
): string | undefined {
  try {
    const p = archivePath(sessionsDir, callId);
    if (!existsSync(p)) return undefined;
    const all = readFileSync(p, "utf8").split("\n");
    const start = Math.max(1, offsetLine) - 1;
    return all.slice(start, start + Math.max(1, maxLines)).join("\n");
  } catch {
    return undefined;
  }
}

/** Build the placeholder body the model sees after pruning. */
export function placeholderFor(callId: string, result: unknown): string {
  const body = JSON.stringify(result ?? "");
  return (
    `[pruned to save context — original was ${body.length} chars; first ${PLACEHOLDER_HEAD_CHARS} follow]\n` +
    body.slice(0, PLACEHOLDER_HEAD_CHARS) +
    `\n…call archive_read with callId "${callId}" to read the full archived output`
  );
}

interface RegistryLike {
  get(name: string): unknown;
  register(def: ToolDefinition): unknown;
}

/**
 * Register the read-only `archive_read` tool (idempotent). The model calls it
 * with a callId seen in a "[pruned …]" placeholder to pull archived bytes
 * back into context, optionally windowed by line.
 */
export function registerArchiveReadTool(registry: RegistryLike): void {
  if (registry.get("archive_read")) return;
  registry.register({
    name: "archive_read",
    description:
      "Read lines from a previously archived (pruned) tool output by its callId. " +
      "Use after seeing '[pruned …]' placeholders in old tool results.",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: {
        callId: { type: "string", description: "callId of the pruned tool result" },
        offsetLine: { type: "number", description: "1-based first line to return" },
        maxLines: { type: "number", description: "max lines to return (default 500)" },
      },
      required: ["callId"],
    },
    execute: async (args) => {
      const a = args as { callId?: string; offsetLine?: number; maxLines?: number };
      if (!a.callId || typeof a.callId !== "string") {
        throw new Error("archive_read: callId is required");
      }
      const body = readArchive(process.cwd(), a.callId, Number(a.offsetLine) || 1, Number(a.maxLines) || 500);
      if (body === undefined) {
        return { ok: false, error: `no archive for callId "${a.callId}"` };
      }
      return { ok: true, result: body };
    },
  });
}

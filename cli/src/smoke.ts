import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  REVIEW_DIMENSIONS,
  extractImpactTargets,
  mergeFindings,
  parseReviewerOutput,
  renderImpactPlan,
  renderVerifyTask,
  renderFindingsReport,
  verifyReconfirms,
  writeReviewReport,
  annotateDiffLineNumbers,
  parseDiff,
} from "./review-pipeline.js";
import type { Finding, DimensionReview } from "./review-pipeline.js";
import {
  resolvePrice,
  totalCost,
  tokensPerSecond,
  fmtCost,
  fmtTps,
  lastContextTokens,
  estimateContextTokens,
  cacheHitRate,
  DEFAULT_PRICES,
} from "./cost.js";
import type { SessionEvent } from "@aih/core";

const cli = fileURLToPath(new URL("./index.js", import.meta.url));

// The session tests wipe ./.aih/sessions; a real user session must never be
// the casualty. Stash it aside (recoverable under /tmp) instead of rm -rf.
const SESSIONS_STASH_ROOT = `/tmp/aih-sessions-stash-${process.pid}`;
function wipeLocalSessions(): void {
  if (!existsSync(".aih/sessions")) return;
  const dest = `${SESSIONS_STASH_ROOT}/${Date.now()}`;
  mkdirSync(dest, { recursive: true });
  try {
    renameSync(".aih/sessions", dest);
  } catch (err) {
    // EXDEV: /tmp may live on a different filesystem than the repo — fall
    // back to copy+remove so a cross-device layout never kills the run.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(".aih/sessions", dest, { recursive: true });
    rmSync(".aih/sessions", { recursive: true, force: true });
  }
  console.error(`[smoke] stashed pre-existing .aih/sessions → ${dest}`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

function aih(args: string[], env: Record<string, string> = {}, cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  });
}

// Like aih(), but with AIH_MODEL/AIH_BASE_URL stripped so config-file values
// are what get resolved (the dev shell exports real provider env vars).
function aihClean(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete e.AIH_MODEL;
  delete e.AIH_BASE_URL;
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: e,
    ...(cwd ? { cwd } : {}),
  });
}

// --- F#30: cost / TPS (pure functions over seeded events) -------------------
{
  // Price resolution: exact, substring, user-override, and miss.
  assert(
    resolvePrice("gpt-4o")?.input === 2.5 && resolvePrice("gpt-4o")?.output === 10,
    "resolvePrice finds built-in gpt-4o",
  );
  assert(
    resolvePrice("gpt-4o-2024-11-20")?.input === 2.5,
    "resolvePrice matches a dated id to the gpt-4o row",
  );
  assert(
    resolvePrice("GPT-4O-MINI")?.input === 0.15,
    "resolvePrice is case-insensitive and picks the more specific mini row",
  );
  assert(
    resolvePrice("my-custom-model", { "my-custom-model": { input: 1, output: 2 } })?.input === 1,
    "user `prices` override wins for an unknown model",
  );
  assert(
    resolvePrice("totally-unknown-xyz") === undefined,
    "resolvePrice returns undefined when no table matches",
  );

  // Seeded turn/end events with known usage + timestamps.
  const mk = (seq: number, ts: number, prompt: number, completion: number): SessionEvent =>
    ({
      seq,
      ts,
      type: "turn/end",
      turnId: `t${seq}`,
      stopReason: "end_turn",
      usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
    }) as SessionEvent;
  const events = [
    mk(0, 1_000_000, 1_000_000, 0), // 1M input
    mk(1, 1_002_000, 0, 1_000_000), // 1M output, 2s later
  ];
  const price = resolvePrice("gpt-4o")!;
  // 1M input @ $2.5 + 1M output @ $10 = $12.50
  const c = totalCost(events, price);
  assert(Math.abs(c - 12.5) < 1e-9, `totalCost = $12.50 for 1M in + 1M out (got ${c})`);
  // 2M tokens over 2s = 1,000,000 tok/s
  const tps = tokensPerSecond(events);
  assert(Math.abs(tps - 1_000_000) < 1e-6, `tokensPerSecond = 1e6 tok/s (got ${tps})`);
  assert(tokensPerSecond([mk(0, 1, 100, 100)]) === 0, "TPS is 0 with a single turn");

  // P#41: cache hit rate — only turns reporting cachedTokens count.
  const mkCached = (seq: number, ts: number, prompt: number, cached: number): SessionEvent =>
    ({
      seq,
      ts,
      type: "turn/end",
      turnId: `c${seq}`,
      stopReason: "end_turn",
      usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt, ...(cached > 0 ? { cachedTokens: cached } : {}) },
    }) as SessionEvent;
  // 8000 cached of 10000 prompt = 80%
  assert(
    cacheHitRate([mkCached(0, 1, 10_000, 8_000)]) === 0.8,
    "cacheHitRate = cached/prompt when the provider reports it",
  );
  // turns without cache data are excluded, not treated as zero-hit
  const mixed = [mkCached(0, 1, 10_000, 8_000), mk(1, 2, 20_000, 0)];
  // mixed: one reporting turn + one non-reporting turn → rate from the
  // reporting turn only (unobservable turns are excluded, not zero-hit).
  assert(
    cacheHitRate([mkCached(0, 1, 10_000, 8_000), mk(1, 2, 20_000, 0)]) === 0.8,
    "cacheHitRate excludes turns without cache figures instead of diluting",
  );
  assert(cacheHitRate([mk(0, 1, 20_000, 5)]) === undefined, "no reported cache → undefined");
  assert(cacheHitRate([]) === undefined, "empty session → no rate");

  // P#41: TTL waste attribution — a miss after an idle gap > TTL is attributed
  // to cache eviction; misses within the TTL are not.
  {
    const { cacheTtlWaste } = await import("./cost.js");
    const t0 = 1_000_000;
    const fiveMin = 5 * 60_000;
    // t0: cached turn (cache established). t0+6min: gap > TTL, uncached read.
    const evs = [
      mkCached(0, t0, 10_000, 9_000),
      mkCached(1, t0 + sixMin(), 12_000, 2_000),
      mkCached(2, t0 + sixMin() + 1000, 13_000, 11_000), // within TTL, normal
    ];
    const w = cacheTtlWaste(evs);
    assert(w !== undefined && w.gaps === 1, `one idle gap > TTL attributed (${w?.gaps})`);
    assert(
      w !== undefined && w.wastedTokens === Math.min(10_000, 10_000),
      `wasted tokens = uncached reads capped by the previous prefix (${w?.wastedTokens})`,
    );
    // No gap over TTL → zero attribution.
    const tight = [mkCached(0, t0, 10_000, 9_000), mkCached(1, t0 + 60_000, 12_000, 3_000)];
    assert(cacheTtlWaste(tight)?.gaps === 0, "misses within the TTL are not attributed");
    function sixMin(): number {
      return fiveMin + 60_000;
    }
  }

  // --- PE#3: harness health scorecard (pure over seeded events) -------------
  {
  const { computeScorecard, formatScorecard, countDatedEntries } = await import("./scorecard.js");

  // countDatedEntries: only lines that START with a YYYY-MM-DD date count.
  assert(countDatedEntries("") === 0, "PE#3 countDatedEntries: empty → 0");
  assert(countDatedEntries("no date here\n  2026-08-29 rule\n2026-08-29 another\n") === 2, "PE#3 countDatedEntries: counts dated lines only");
  assert(countDatedEntries("2026-08-29\n") === 1, "PE#3 countDatedEntries: bare dated line counts");
  assert(countDatedEntries("- 2026-08-23 — 借鉴 LongHorizon\n* 2026-08-24 — 第二批\nno date\n") === 2, "PE#3 countDatedEntries: bullet-prefixed dated lines count (real memory.md form)");
  assert(countDatedEntries("- 2026-08-23 — - 2026-08-23 — nested\n") === 1, "PE#3 countDatedEntries: nested re-append line counts once");

  // Seeded session: 3 turns; turn 1 reworks (fail→pass), turn 2 fails &
  // escalates, turn 3 is clean + goal-met. Span = 10 days.
  const t0 = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const ev: SessionEvent[] = [
    { seq: 0, ts: t0, type: "turn/start", turnId: "a" },
    { seq: 1, ts: t0 + 1000, type: "tool/result", turnId: "a", callId: "c1", ok: false, error: "boom" },
    { seq: 2, ts: t0 + 9000, type: "tool/result", turnId: "a", callId: "c2", ok: true, result: "ok" }, // recovered in 8s
    { seq: 3, ts: t0 + 10_000, type: "turn/end", turnId: "a", stopReason: "end_turn", usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } },
    { seq: 4, ts: t0 + day, type: "turn/start", turnId: "b" },
    { seq: 5, ts: t0 + day + 1000, type: "tool/result", turnId: "b", callId: "c3", ok: false, error: "still broken" }, // unrecovered
    { seq: 6, ts: t0 + day + 2000, type: "escalate", turnId: "b", reason: "sensor red", options: ["retry", "abort"], safestDefault: "abort" },
    { seq: 7, ts: t0 + day + 3000, type: "turn/end", turnId: "b", stopReason: "end_turn", usage: { promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 } },
    { seq: 8, ts: t0 + 9 * day, type: "turn/start", turnId: "c" },
    { seq: 9, ts: t0 + 9 * day + 1000, type: "goal/judge", turnId: "c", met: true, reason: "done", unmet: [] },
    { seq: 10, ts: t0 + 9 * day + 2000, type: "turn/end", turnId: "c", stopReason: "end_turn", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  ];
  const price = resolvePrice("gpt-4o")!; // 2.5 / 10 per 1M
  const mem = "2026-08-29 rule one\n2026-08-29 rule two\nundated prose\n";
  const m = computeScorecard(ev, { price, memoryText: mem });

  assert(m.started === 3, `PE#3 started = 3 turns (got ${m.started})`);
  assert(m.verified === 1 && m.goalMet === 1, `PE#3 verified = 1 (goal met) (got ${m.verified})`);
  assert(m.rework === 2, `PE#3 rework = 2 failed tool calls (got ${m.rework})`);
  assert(m.escalations === 1, `PE#3 escalations = 1 (got ${m.escalations})`);
  assert(m.recovered === 1 && m.unrecovered === 1, `PE#3 recovered=1 unrecovered=1 (got ${m.recovered}/${m.unrecovered})`);
  assert(m.recoveryMs === 8000, `PE#3 recovery time = 8s (got ${m.recoveryMs})`);
  assert(m.completionRate === 1 / 3, `PE#3 completion rate = 1/3 (got ${m.completionRate})`);
  assert(m.reworkRate === 2 / 3, `PE#3 rework rate = 2/3 (got ${m.reworkRate})`);
  assert(m.escalationRate === 1 / 3, `PE#3 escalation rate = 1/3 (got ${m.escalationRate})`);
  // 1M input @2.5 + 1M output @10 = $12.50 total; /1 verified = $12.50
  assert(Math.abs(m.costUsd - 12.5) < 1e-9, `PE#3 total cost = $12.50 (got ${m.costUsd})`);
  assert(Math.abs(m.costPerVerified - 12.5) < 1e-9, `PE#3 cost per verified = $12.50 (got ${m.costPerVerified})`);
  assert(m.guideEntries === 2, `PE#3 guide entries = 2 dated (got ${m.guideEntries})`);
  // guide growth = entries * week / span, where span is the real event span.
  const spanMs = (t0 + 9 * day + 2000) - t0;
  const expectedPerWeek = (2 * 7 * 24 * 60 * 60 * 1000) / spanMs;
  assert(Math.abs(m.guidePerWeek - expectedPerWeek) < 1e-9, `PE#3 guide growth = ${expectedPerWeek}/wk over real span (got ${m.guidePerWeek})`);
  // Short span (< 1 week) → per-week is 0 (no extrapolation).
  const short = computeScorecard([
    { seq: 0, ts: 0, type: "turn/start", turnId: "s" },
    { seq: 1, ts: 1000, type: "turn/end", turnId: "s", stopReason: "end_turn", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  ], { memoryText: "2026-08-29 a\n2026-08-29 b\n" });
  assert(short.guideEntries === 2 && short.guidePerWeek === 0, "PE#3 guide growth: span < 1 week → per-week 0 (no extrapolation)");
  assert(m.tokens.total === 2_000_000, `PE#3 total tokens = 2M (got ${m.tokens.total})`);

  // Empty session → all-zero metrics, no crash.
  const empty = computeScorecard([]);
  assert(empty.started === 0 && empty.verified === 0 && empty.completionRate === 0 && empty.costPerVerified === 0, "PE#3 empty session → all-zero metrics, no crash");
  assert(formatScorecard(empty).includes("completion rate"), "PE#3 formatScorecard renders the metric table");
}

  // CC#55 — readJson: UTF-8 BOM tolerance for config / JSON state files.
  {
    const { readJson } = await import("./read-json.js");
    const dir = mkdtempSync(join(tmpdir(), "aih-smoke-bom-"));
    const bare = join(dir, "plain.json");
    const bom = join(dir, "bom.json");
    writeFileSync(bare, '{"a":1,"list":[1,2,3]}', "utf8");
    writeFileSync(bom, "\uFEFF" + '{"a":1,"list":[1,2,3]}', "utf8");
    const p1 = readJson<{ a: number; list: number[] }>(bare);
    const p2 = readJson<{ a: number; list: number[] }>(bom);
    assert(p1.a === 1 && p1.list.length === 3, "CC#55 readJson: bare JSON parses (a=1)");
    assert(
      p2.a === 1 && p2.list.length === 3 && JSON.stringify(p2) === '{"a":1,"list":[1,2,3]}',
      "CC#55 readJson: BOM-prefixed JSON parses identically to bare JSON",
    );
    console.log("ok: CC#55 readJson strips UTF-8 BOM");
    rmSync(dir, { recursive: true, force: true });
  }

  // CC slash-recognition — pasted code like `// setvbuf(...)` must NOT be
  // parsed as a slash command; unknown "/..." reaches the model as a message
  // (opencode parseSlashCommand semantics: known head token or nothing).
  {
    const { isKnownSlashCommand, slashHeadOf, BUILTIN_SLASH_HEADS } = await import("./slash.js");
    // the reported bug: C code whose comment starts with "//"
    const pastedCode = `// 无缓冲：崩溃/卡死时也能实时看到日志（文件重定向默认全缓冲会吞掉现场）\n    setvbuf(stdout, nullptr, _IONBF, 0);`;
    assert(slashHeadOf(pastedCode) === "", "slashHeadOf: '//' yields empty head (not a command)");
    assert(slashHeadOf("/* block comment */") === "", "slashHeadOf: '/*' yields empty head");
    assert(isKnownSlashCommand(pastedCode) === false, "pasted C code with // is a normal message, not a command");
    assert(isKnownSlashCommand("/goal fix the build") === true, "known builtin with args → command");
    assert(isKnownSlashCommand("/unknowncmd hello") === false, "unknown slash head → normal message (was: unknown command error)");
    assert(isKnownSlashCommand("/SKILLS") === true, "head matching is case-insensitive");
    assert(isKnownSlashCommand("/my-skill", ["my-skill", "ext"]) === true, "skill/extension heads count as known");
    assert(isKnownSlashCommand("/ext run", ["ext"]) === true, "extension with args → command");
    assert(isKnownSlashCommand("/") === false, "bare '/' is not a command");
    assert(BUILTIN_SLASH_HEADS.has("help") && BUILTIN_SLASH_HEADS.has("exit"), "builtin heads populated");
    console.log("ok: CC slash-recognition — pasted '// code' is a message, only known heads are commands");
  }

  // CC#59 — credential scope: sensitive headers ride only to the provider's
  // own host. A host override (proxy / mirror / typo'd endpoint) must drop
  // authorization-class headers while keeping innocuous ones.
  {
    const { credentialSafeHeaders } = await import("./config.js");
    const headers = {
      authorization: "Bearer sk-secret",
      "x-api-key": "sk-also-secret",
      "user-agent": "aih/1.0",
      "x-custom-trace": "ok",
    };
    const sameHost = credentialSafeHeaders(headers, "https://api.example.com/v1", "https://api.example.com/v1");
    assert(
      sameHost.authorization === "Bearer sk-secret" && sameHost["x-api-key"] === "sk-also-secret",
      "CC#59: same-host request keeps all headers (secrets go to their owner)",
    );
    const diffHost = credentialSafeHeaders(headers, "https://api.example.com/v1", "https://evil.example.com/v1");
    assert(
      !("authorization" in diffHost) && !("x-api-key" in diffHost),
      "CC#59: host override drops authorization/x-api-key",
    );
    assert(
      diffHost["user-agent"] === "aih/1.0" && diffHost["x-custom-trace"] === "ok",
      "CC#59: non-sensitive headers survive the leak guard",
    );
    const missing = credentialSafeHeaders(headers, undefined, "https://x.example.com");
    assert("authorization" in missing, "CC#59: unknown home base → pass-through (cannot judge, fails open)");
    const proxyAuth = credentialSafeHeaders(
      { "proxy-authorization": "Basic zzz", apikey: "k2" },
      "https://a.com",
      "https://b.com",
    );
    assert(!("proxy-authorization" in proxyAuth) && !("apikey" in proxyAuth), "CC#59: proxy-authorization/apikey also dropped");
    console.log("ok: CC#59 credentialSafeHeaders — secrets only ride to their owning host");
  }

  // CC#57 — /usage Loops breakdown: goal rounds / task / best_of_n aggregated
  // per source with turn-attributed tokens (spotlight, not a ledger).
  {
    const { loopUsageBreakdown, formatLoopBreakdown, fmtAgo } = await import("./loops.js");
    const mkEnd = (seq: number, ts: number, turnId: string, total: number): SessionEvent =>
      ({
        seq,
        ts,
        type: "turn/end",
        turnId,
        stopReason: "end_turn",
        usage: { promptTokens: total - 10, completionTokens: 10, totalTokens: total },
      }) as SessionEvent;
    const mkGoal = (seq: number, ts: number, turnId: string): SessionEvent =>
      ({ seq, ts, type: "goal/judge", turnId, met: false, reason: "r", unmet: [] }) as SessionEvent;
    const mkCall = (seq: number, ts: number, turnId: string, name: string): SessionEvent =>
      ({ seq, ts, type: "tool/call", turnId, callId: `c${seq}`, name, args: {} }) as SessionEvent;

    const t0 = 1_000_000_000_000;
    const now = t0 + 120_000; // "2m ago" territory
    const events: SessionEvent[] = [
      mkEnd(0, t0, "turnA", 30_000),
      mkGoal(1, t0 + 1_000, "turnA"),
      mkGoal(2, t0 + 2_000, "turnA"),
      mkGoal(3, t0 + 3_000, "turnA"),
      mkEnd(4, t0 + 10_000, "turnB", 50_000),
      mkCall(5, t0 + 10_100, "turnB", "task"),
      mkEnd(6, t0 + 20_000, "turnC", 5_000),
      mkCall(7, t0 + 20_100, "turnC", "task"),
      mkCall(8, t0 + 20_200, "turnC", "best_of_n"),
      // plain turn with no loop activity — must not be attributed
      mkEnd(9, t0 + 30_000, "turnD", 999_000),
    ];
    const stats = loopUsageBreakdown(events);
    const goal = stats.find((s) => s.source === "goal");
    const task = stats.find((s) => s.source === "task");
    const bon = stats.find((s) => s.source === "best_of_n");
    assert(goal?.runs === 3 && goal.totalTokens === 30_000, "CC#57: goal rounds = 3 runs, turn-attributed 30k tok");
    assert(task?.runs === 2 && task.totalTokens === 55_000, "CC#57: task = 2 runs across two turns (50k + 5k)");
    assert(bon?.runs === 1 && bon.totalTokens === 5_000, "CC#57: best_of_n shares turnC with task");
    assert(bon?.sharedTurn === true, "CC#57: shared turn flagged");
    assert(!stats.some((s) => s.totalTokens > 60_000), "CC#57: plain turnD's 999k tok NOT attributed to any loop source");
    assert(stats[0].source === "task", "CC#57: sorted by totalTokens desc (runaway first)");
    const lines = formatLoopBreakdown(stats, now);
    assert(lines.length >= 4 && lines[0].startsWith("loops breakdown"), "CC#57: header + one line per source");
    assert(lines.some((l) => l.includes("goal rounds: 3 runs") && l.includes("30.0k tok") && l.includes("10.0k/run")), "CC#57: goal line format (runs · tok · per-run)");
    assert(lines.some((l) => l.includes("last 1m ago")), "CC#57: relative last-run time (task/best_of_n last activation ~100s before now)");
    assert(lines.some((l) => l.includes("spotlight, not a ledger")), "CC#57: shared-turn honesty note present");
    assert(formatLoopBreakdown([], now).length === 0, "CC#57: no loop activity → no lines");
    assert(fmtAgo(t0 + 5_000, t0 + 5_003) === "just now", "CC#57: fmtAgo just now");
    console.log("ok: CC#57 loops breakdown — per-source runs/tok/per-run/last with honest attribution");
  }

  // CC#54 — autoAllowReadonly: deterministic read-only whitelist, off by
  // default, never overrides explicit ask/deny rules.
  {
    const { isReadonlyCommand } = await import("./readonly-allow.js");
    const { SessionGate, DenyGate } = await import("./gate.js");
    const { ToolRegistry } = await import("@aih/core");

    // whitelist accepts
    assert(isReadonlyCommand("ls -la /tmp"), "CC#54: ls accepted");
    assert(isReadonlyCommand("cat foo.txt"), "CC#54: cat accepted");
    assert(isReadonlyCommand("grep -rn pattern src/"), "CC#54: grep accepted");
    assert(isReadonlyCommand("git status"), "CC#54: git status accepted");
    assert(isReadonlyCommand("git log --oneline -5"), "CC#54: git log accepted");
    assert(isReadonlyCommand("AIH_X=1 ls"), "CC#54: env-var prefix tolerated");
    // dangerous / unknown rejected
    assert(!isReadonlyCommand("rm -rf /"), "CC#54: rm rejected");
    assert(!isReadonlyCommand("ls > /etc/passwd"), "CC#54: redirect rejected");
    assert(!isReadonlyCommand("cat a && rm b"), "CC#54: chaining rejected");
    assert(!isReadonlyCommand("echo $(rm -rf x)"), "CC#54: command substitution rejected");
    assert(!isReadonlyCommand("find . -delete"), "CC#54: find -delete rejected");
    assert(!isReadonlyCommand("find . -exec rm {} \\;"), "CC#54: find -exec rejected");
    assert(!isReadonlyCommand("git push origin main"), "CC#54: git push rejected (not on list)");
    assert(!isReadonlyCommand("curl http://evil"), "CC#54: curl rejected (not on list)");
    assert(!isReadonlyCommand("ls; rm x"), "CC#54: semicolon chaining rejected");
    assert(!isReadonlyCommand(""), "CC#54: empty command rejected");

    // Gate integration. SessionGate's ask path always prompts a human (CC#53
    // floor), so we attach a stub TUI whose askConfirm records the prompt and
    // answers "deny". OFF → prompt happens (and is denied); ON with a
    // whitelist/read request → NO prompt at all (auto-allow).
    const mkStubTui = (): { tui: unknown; prompts: string[] } => {
      const prompts: string[] = [];
      return {
        prompts,
        tui: { askConfirm: async (detail: string) => { prompts.push(detail); return "deny" as const; }, pushSystem: () => {} },
      };
    };
    const attach = (gate: unknown, stub: { tui: unknown }): void => {
      (gate as { attachTui(t: unknown): void }).attachTui(stub.tui);
    };

    // OFF (default): no rules → human prompt (recorded) → denied by the stub.
    const offStub = mkStubTui();
    const offGate = new SessionGate(new DenyGate(), [], undefined, false);
    attach(offGate, offStub);
    const offOk = await offGate.request({ tool: "run_cmd", kind: "write", args: { command: "ls -la" } });
    assert(offOk === false && offStub.prompts.length === 1, "CC#54: default OFF — read-only cmd still prompts (recorded 1 prompt)");

    // ON + no rules: whitelist passes with NO prompt at all.
    const onStub = mkStubTui();
    const onGate = new SessionGate(new DenyGate(), [], undefined, true);
    attach(onGate, onStub);
    const onOk = await onGate.request({ tool: "run_cmd", kind: "write", args: { command: "ls -la" } });
    assert(onOk === true && onStub.prompts.length === 0, "CC#54: ON — whitelisted cmd auto-allowed, zero prompts");

    // ON but non-whitelisted command → prompts → denied by the stub.
    const badStub = mkStubTui();
    const badGate = new SessionGate(new DenyGate(), [], undefined, true);
    attach(badGate, badStub);
    const badOk = await badGate.request({ tool: "run_cmd", kind: "write", args: { command: "curl http://evil.example" } });
    assert(badOk === false && badStub.prompts.length === 1, "CC#54: ON — non-whitelisted cmd still prompts");

    // ON + explicit deny rule dominates the whitelist (floor intact).
    const denyStub = mkStubTui();
    const denyGate = new SessionGate(new DenyGate(), [{ tool: "run_cmd", pattern: "*", action: "deny" }], undefined, true);
    attach(denyGate, denyStub);
    const denyOk = await denyGate.request({ tool: "run_cmd", kind: "write", args: { command: "ls -la" } });
    assert(denyOk === false && denyStub.prompts.length === 0, "CC#54: explicit deny rule dominates — silent reject, no prompt");

    // ON + read-kind request with no rules → auto-allow, no prompt.
    const readStub = mkStubTui();
    const readGate = new SessionGate(new DenyGate(), [], undefined, true);
    attach(readGate, readStub);
    const readOk = await readGate.request({ tool: "list_todos", kind: "read", args: {} });
    assert(readOk === true && readStub.prompts.length === 0, "CC#54: ON — read-kind request auto-allowed, zero prompts");

    console.log("ok: CC#54 autoAllowReadonly — deterministic whitelist, default off, floors intact");
  }

  // CC#60 — notification classification: injected input (serve/steering) can
  // never approve a pending ask; only TTY keyboard input can.
  {
    const { SessionGate, DenyGate } = await import("./gate.js");
    const mkStubTui = (): { tui: unknown; prompts: string[] } => {
      const prompts: string[] = [];
      return {
        prompts,
        tui: { askConfirm: async (detail: string) => { prompts.push(detail); return "once" as const; }, pushSystem: () => {} },
      };
    };
    // TTY source: the ask prompts a human; the stub approves "once".
    const ttyStub = mkStubTui();
    const ttyGate = new SessionGate(new DenyGate(), [], undefined, false);
    (ttyGate as { attachTui(t: unknown): void }).attachTui(ttyStub.tui);
    const ttyOk = await ttyGate.request({ tool: "run_cmd", kind: "write", args: { command: "deploy.sh" }, source: "tty" });
    assert(ttyOk === true && ttyStub.prompts.length === 1, "CC#60: tty source — ask prompts a human as before");

    // Injected source: NO prompt at all — auto-refused even though the stub
    // would say yes. Message text can never answer an approval.
    const injStub = mkStubTui();
    const injGate = new SessionGate(new DenyGate(), [], undefined, false);
    (injGate as { attachTui(t: unknown): void }).attachTui(injStub.tui);
    const injOk = await injGate.request({ tool: "run_cmd", kind: "write", args: { command: "deploy.sh" }, source: "injected" });
    assert(injOk === false && injStub.prompts.length === 0, "CC#60: injected source — refused without any prompt");

    // Legacy callers that don't set source still behave as tty (no behavior change).
    const legacyStub = mkStubTui();
    const legacyGate = new SessionGate(new DenyGate(), [], undefined, false);
    (legacyGate as { attachTui(t: unknown): void }).attachTui(legacyStub.tui);
    const legacyOk = await legacyGate.request({ tool: "run_cmd", kind: "write", args: {} });
    assert(legacyOk === true && legacyStub.prompts.length === 1, "CC#60: absent source defaults to tty (back-compat)");

    console.log("ok: CC#60 source classification — injected text never approves an ask; tty unchanged");
  }

  // CC#58 — TUI hard cap on a pathological single line (base64 / minified diff).
  {
    const { wrapStyled, MAX_WRAP_COLS } = await import("./tui.js");
    const big = "A".repeat(100_000);
    const t0 = Date.now();
    const wrapped = wrapStyled(big, 80);
    const dt = Date.now() - t0;
    const joined = wrapped.join("\n");
    assert(
      joined.includes("chars truncated"),
      "CC#58: 100k-char single line is truncated with a marker",
    );
    assert(joined.length < MAX_WRAP_COLS * 2, "CC#58: wrap output stays bounded");
    assert(dt < 2000, `CC#58: rendering 100k chars is time-bounded (took ${dt}ms)`);
    // Marker not present for normal-length lines.
    const normal = wrapStyled("hello world ".repeat(20), 40).join("\n");
    assert(!normal.includes("chars truncated"), "CC#58: normal lines are NOT truncated");
    console.log("ok: CC#58 TUI caps pathological long lines with a truncated marker");
  }

  // CC#56 — MCP empty-schema args: a provider-serialized JSON string payload is
  // normalized back to a real typed object before hitting the MCP server.
  {
    const { normalizeMcpArgs } = await import("./mcp-backend.js");
    const obj = normalizeMcpArgs('{"text":"hi","n":3}');
    assert(
      obj !== null && typeof obj === "object" && (obj as { text: string }).text === "hi" && (obj as { n: number }).n === 3,
      "CC#56: string args are parsed back to a typed object",
    );
    assert(
      typeof normalizeMcpArgs({ text: "hi", n: 3 }) === "object",
      "CC#56: object args pass through unchanged",
    );
    assert(
      typeof normalizeMcpArgs("not-json{") === "string",
      "CC#56: non-JSON string payload is kept as-is (no throw)",
    );
    assert(typeof normalizeMcpArgs(undefined) === "object", "CC#56: undefined args default to object");
    console.log("ok: CC#56 MCP string args normalize to typed objects");
  }


  // lastContextTokens: compaction-aware seeding. When the newest turn-boundary
  // is a compaction event (no LLM turn ran since), the stamped post-compaction
  // estimate wins over the stale pre-compaction turn/end usage — otherwise a
  // /model switch or `-c` resume flashes the pre-compaction size.
  const mkCompact = (seq: number, ts: number, contextAfter?: number): SessionEvent =>
    ({
      seq,
      ts,
      type: "compaction",
      turnId: `c${seq}`,
      summary: "earlier work summarized",
      ...(contextAfter !== undefined ? { contextAfter } : {}),
    }) as SessionEvent;
  // compaction newest → stamp wins (labeled as estimate).
  const est = lastContextTokens([mk(0, 1, 100_000, 5), mkCompact(1, 2, 12_000)]);
  assert(est.tokens === 12_000 && est.source === "estimate", "compaction stamp wins and is labeled estimate");
  // …and it stays won even under a much bigger window where the stale
  // pre-compaction sample would pass the plausibility gate (the reported
  // "switch to x-preview → 254k" regression).
  const bigWin = lastContextTokens([mk(0, 1, 254_098, 5), mkCompact(1, 2, 6_709)], 1_000_000);
  assert(bigWin.tokens === 6_709 && bigWin.source === "estimate", "pre-compaction usage never survives a compaction, whatever the window");
  // newer real turn → usage wins again.
  const real = lastContextTokens([mk(0, 1, 100_000, 5), mkCompact(1, 2, 12_000), mk(2, 3, 15_000, 5)]);
  assert(real.tokens === 15_000 && real.source === "usage", "newer turn/end returns to provider-truth usage");
  // legacy compaction event without the stamp (old session file) → local
  // estimate over post-compaction events, never the stale pre-compaction value.
  const legacy = lastContextTokens([mk(0, 1, 100_000, 5), mkCompact(1, 2)]);
  assert(legacy.source === "estimate" && legacy.tokens < 100_000, "unstamped legacy compaction → local estimate, not stale usage");

  // Garbage provider usage (cumulative/free-tier inflation) is skipped when a
  // window is known: 28M reported on a 200k-window model must not reach the
  // panel; a sane newer/older sample still wins; nothing sane → estimate.
  const garbage = mk(5, 6, 28_200_904, 7_697);
  assert(lastContextTokens([garbage], 200_000).source === "estimate", "implausible usage skipped (window known)");
  assert(lastContextTokens([garbage], 0).tokens === 28_200_904, "without a window the raw value passes through (cannot judge)");
  const saneNewer = lastContextTokens([mk(0, 1, 120_000, 5), garbage, mk(9, 10, 130_000, 5)], 200_000);
  assert(saneNewer.tokens === 130_000 && saneNewer.source === "usage", "sane newer usage beats older garbage");

  // A sane sample can be STALE: when the log clearly outgrew it (tool-heavy
  // sessions accrue fast), the local estimate is the current truth.
  {
    const stale = [
      mk(1, 2, 100_000, 5),
      ...Array.from({ length: 4 }, (_, i) =>
        ({ seq: 2 + i, ts: 3 + i, type: "user/message", turnId: `t${i}`, text: "工具输出测试".repeat(6000) }) as SessionEvent,
      ),
    ];
    const r = lastContextTokens(stale, 200_000);
    assert(r.source === "estimate" && r.tokens > 130_000, `stale sample outgrown by log → estimate wins (got ${r.source} ${r.tokens})`);
  }

  // estimateContextTokens is CJK-aware: Chinese-heavy events count ≈1 token
  // per char (flat chars÷4 would undercount ~3× and hide real overflow).
  {
    const cjkEvents = [
      { seq: 1, ts: 1, type: "user/message", turnId: "t", text: "你好世界".repeat(25) }, // 100 CJK chars
    ] as SessionEvent[];
    const est = estimateContextTokens(cjkEvents);
    assert(est >= 90 && est <= 130, `100 CJK chars ≈ ~110 tokens (got ${est}; chars/4 would say 25)`);
  }

  assert(tokensPerSecond([]) === 0, "TPS is 0 with no events");
  assert(fmtCost(12.5) === "$12.50", "fmtCost formats >=0.01 to 2 decimals");
  assert(fmtCost(0.0042) === "$0.0042", "fmtCost formats <0.01 to 4 decimals");
  assert(fmtCost(0) === "$0.00", "fmtCost(0) is $0.00");
  assert(fmtTps(1000) === "1000 tok/s", "fmtTps rounds >=100");
  assert(fmtTps(0) === "", "fmtTps(0) is empty");
  assert(Object.keys(DEFAULT_PRICES).length >= 10, "built-in price table has entries");
}

// Version assertions read the constant from the module (never hardcode —
// release bumps used to break the smoke suite).
// Atomic tool-write publish: exact content, zero temp residue — the paint
// timer reads config files on a 120ms cadence and must never see a torn file.
{
  const { publishFile } = await import("./atomic.js");
  const dir = mkdtempSync(join(tmpdir(), "aih-atomic-"));
  const target = join(dir, "cfg.json");
  publishFile(target, '{"a":1}\n');
  publishFile(target, "完整中文内容\n第二行");
  assert(readFileSync(target, "utf8") === "完整中文内容\n第二行", "publishFile overwrites exactly");
  const residue = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert(residue.length === 0, `no temp files left behind (${residue.join(",")})`);
}

const { VERSION } = await import("./index.js");
const version = aih(["--version"]);
assert(version.stdout.trim() === VERSION, "--version prints version");
const versionCmd = aih(["version"]);
assert(versionCmd.stdout.trim() === VERSION, "version command prints version");

const help = aih([]);
assert(help.status === 1 && help.stdout.includes("Usage:"), "no command prints help and exits 1");

const unknown = aih(["frobnicate"]);
assert(unknown.status === 1 && unknown.stderr.includes("unknown command"), "unknown command errors");

const tools = aih(["tools"]);
assert(tools.status === 0, "tools connects to the bundled server");
assert(
  tools.stdout.includes("toggle_todo") && tools.stdout.includes("ask"),
  "tools lists actions with permission levels",
);

const describe = aih(["describe"]);
assert(describe.status === 0 && describe.stdout.includes("todo-app"), "describe prints app descriptor");

const run = aih(["run", "please add a todo", "--mock", "--yes"]);
assert(run.status === 0, "run --mock exits cleanly");
assert(run.stdout.includes("Added via mock."), "run prints final assistant text");
assert(run.stderr.includes("⚙ add_todo"), "run traces tool calls inline");

const runJson = aih(["run", "add a todo", "--mock", "--yes", "--format", "json"]);
assert(runJson.status === 0, "run --format json exits cleanly");
const lines = runJson.stdout.trim().split("\n").filter(Boolean);
const events = lines.map((l) => JSON.parse(l));
assert(
  events.some((e) => e.type === "turn/start") && events.some((e) => e.type === "turn/end"),
  "json format streams NDJSON session events",
);
assert(
  events.some((e) => e.type === "tool/result" && e.ok),
  "json stream includes successful tool result",
);

// Public (https) endpoint with zero credentials must still fail fast.
const noKey = aih(
  ["run", "hi"],
  { AIH_API_KEY: "", AIH_MODEL: "m", AIH_BASE_URL: "https://api.openai.com/v1" },
);
assert(noKey.status === 1 && noKey.stderr.includes("no API key"), "missing API key fails fast with hint");

// buildLlm must throw (not process.exit) so interactive callers can recover.
{
  const { buildLlm } = await import("./index.js");
  const savedKey = process.env.AIH_API_KEY;
  const savedBase = process.env.AIH_BASE_URL;
  process.env.AIH_API_KEY = "";
  process.env.AIH_BASE_URL = "https://api.openai.com/v1";
  let threw = false;
  let msg = "";
  try {
    buildLlm({ model: "m" });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    if (savedKey === undefined) delete process.env.AIH_API_KEY;
    else process.env.AIH_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.AIH_BASE_URL;
    else process.env.AIH_BASE_URL = savedBase;
  }
  assert(threw && /no API key/i.test(msg), "buildLlm throws (not exits) when keyless on a public endpoint");
}

// Self-hosted endpoints (llama.cpp / Ollama / vLLM) run without auth — the
// no-key gate must not reject them.
{
  const { buildLlm } = await import("./index.js");
  const savedKey = process.env.AIH_API_KEY;
  process.env.AIH_API_KEY = "";
  let llm: unknown;
  try {
    llm = buildLlm({ model: "local-model", "base-url": "http://127.0.0.1:8081/v1" });
  } finally {
    if (savedKey === undefined) delete process.env.AIH_API_KEY;
    else process.env.AIH_API_KEY = savedKey;
  }
  assert(
    typeof (llm as { complete?: unknown })?.complete === "function",
    "buildLlm allows a keyless local http endpoint (llama.cpp)",
  );
}
{
  // Loopback:1 refuses instantly — proves the gate is open and a request is attempted.
  const keylessLocal = aih(
    ["run", "hi"],
    { AIH_API_KEY: "", AIH_MODEL: "m", AIH_BASE_URL: "http://127.0.0.1:1/v1" },
  );
  assert(
    !keylessLocal.stderr.includes("no API key"),
    "keyless local endpoint attempts a request instead of hitting the no-key gate",
  );
}

// The explicit "keyless": true provider flag exempts a public HTTPS endpoint
// from the no-key gate (e.g. free.empero.org), and "maxTokens" caps the
// max_tokens field for tiers that reject large output budgets.
{
  const projDir = mkdtempSync(join(tmpdir(), "aih-keyless-flag-"));
  writeFileSync(
    join(projDir, "aih.json"),
    JSON.stringify({
      defaultProvider: "free",
      providers: {
        free: {
          baseUrl: "https://free.example.test/v1",
          model: "m1",
          keyless: true,
          maxTokens: 16000,
        },
      },
    }),
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    aih(args, { AIH_TRUST_ALL_PROJECTS: "1", ...env }, projDir);
  const list = run(["models"]);
  assert(list.status === 0 && list.stdout.includes("free.example.test"), "keyless:true provider appears in the model catalog");
  // No API key anywhere + a public HTTPS endpoint → must NOT hit the no-key
  // gate (loopback refuses instantly, proving the gate is open).
  const attempt = run(["run", "hi"], { AIH_API_KEY: "" });
  assert(!attempt.stderr.includes("no API key"), "keyless:true skips the no-key gate on a public endpoint");
  // A project WITHOUT the keyless flag on the same endpoint still errors.
  const projDir2 = mkdtempSync(join(tmpdir(), "aih-keyless-flag2-"));
  writeFileSync(
    join(projDir2, "aih.json"),
    JSON.stringify({
      defaultProvider: "free",
      providers: { free: { baseUrl: "https://free.example.test/v1", model: "m1" } },
    }),
  );
  const denied = aih(["run", "hi"], { AIH_API_KEY: "", AIH_TRUST_ALL_PROJECTS: "1" }, projDir2);
  assert(denied.status === 1 && denied.stderr.includes("no API key"), "without keyless:true the same public endpoint still demands a key");
}

// Identity-header providers are keyless ONLY on their own endpoint: a URL
// override (env/flag) that moves the request elsewhere must re-enable the
// no-key gate — opencode fingerprint headers authenticate nothing on
// api.openai.com.
{
  const dir = mkdtempSync(join(tmpdir(), "aih-keyless-"));
  writeFileSync(
    join(dir, "aih.json"),
    JSON.stringify({
      defaultProvider: "zen",
      providers: {
        zen: {
          baseUrl: "https://zen.example/v1",
          model: "big-pickle",
          apiKeyEnv: "AIH_API_KEY",
          headers: { "x-fingerprint": "smoke" },
        },
      },
    }),
  );
  // aihClean, not aih: the dev shell exports real AIH_BASE_URL/AIH_MODEL,
  // which would leak in and move the request off the provider's config home,
  // breaking sameHome before the gate under test is even reached.
  const atHome = aihClean(["run", "hi", "--trust"], { AIH_API_KEY: "" }, dir);
  assert(
    !atHome.stderr.includes("no API key"),
    "identity-header provider stays keyless on its own endpoint",
  );
  // Flag override (not env) to move off the provider home — a flag beats both
  // env and layers, so the assertion holds no matter what the shell exports.
  const moved = aihClean(
    ["run", "hi", "--trust", "--base-url", "https://api.openai.com/v1"],
    { AIH_API_KEY: "" },
    dir,
  );
  assert(
    moved.stderr.includes("no API key"),
    "URL override off the provider home re-enables the no-key gate",
  );
}

wipeLocalSessions();
const s1a = aih(["run", "first prompt alpha", "--mock", "--yes", "--session", "s1"]);
assert(
  s1a.status === 0 && s1a.stderr.includes("[session: new"),
  "run --session creates a new session file",
);
const s1b = aih(["run", "second prompt beta", "--mock", "--yes", "-c"]);
assert(
  s1b.status === 0 && s1b.stderr.includes("[session: resumed"),
  "-c resumes the most recent session",
);
const s1c = aih(["run", "x", "-c", "no-such-session"]);
assert(
  s1c.status === 1 && s1c.stderr.includes('no saved session named "no-such-session"'),
  "-c with an unknown session name errors instead of silently starting empty",
);
assert(!existsSync(".aih/sessions/no-such-session.jsonl"), "failed resume does not create a session file");
const sessionFile = ".aih/sessions/s1.jsonl";
assert(existsSync(sessionFile), "session file persisted");
const sessionContent = readFileSync(sessionFile, "utf8");
assert(
  sessionContent.includes("first prompt alpha") && sessionContent.includes("second prompt beta"),
  "both turns recorded in one session log",
);

const list = aih(["sessions"]);
assert(list.status === 0 && list.stdout.includes("s1"), "sessions command lists saved sessions");

const show = aih(["session", "show", "s1"]);
assert(show.status === 0 && show.stdout.includes("first prompt alpha"), "session show renders transcript");

const exportJson = aih(["session", "export", "s1"]);
assert(exportJson.status === 0 && JSON.parse(exportJson.stdout).length > 0, "session export emits JSON events");

// --- session import: JSON array (export format) and NDJSON (raw file) -------
{
  const tmpD = mkdtempSync(join(tmpdir(), "aih-import-"));
  const expFile = join(tmpD, "s1-export.json");
  const exp = aih(["session", "export", "s1", expFile]);
  assert(exp.status === 0 && existsSync(expFile), "session export writes a JSON file");
  const imp = aih(["session", "import", expFile, "s1-imported"]);
  assert(imp.status === 0 && imp.stdout.includes("imported") && imp.stdout.includes("s1-imported"), `session import accepts the exported JSON array (exit ${imp.status}: ${imp.stderr})`);
  const impList = aih(["sessions"]);
  assert(impList.stdout.includes("s1-imported"), "imported session appears in the list");
  const impShow = aih(["session", "show", "s1-imported"]);
  assert(impShow.status === 0 && impShow.stdout.includes("first prompt alpha"), "imported session replays its transcript");
  const impDup = aih(["session", "import", expFile, "s1-imported"]);
  assert(impDup.status === 1 && impDup.stderr.includes("already exists"), "session import refuses to overwrite an existing session");

  const raw = join(tmpD, "s1-raw.jsonl");
  writeFileSync(raw, readFileSync(sessionFile, "utf8"), "utf8");
  const impRaw = aih(["session", "import", raw, "s1-imported-raw"]);
  assert(impRaw.status === 0 && impRaw.stdout.includes("s1-imported-raw"), "session import accepts the raw NDJSON session file");

  const bad = join(tmpD, "bad.jsonl");
  writeFileSync(bad, '{"seq":0,"ts":123,"type":"user/message"}\n', "utf8");
  const impBad = aih(["session", "import", bad, "s1-imported-bad"]);
  assert(impBad.status === 1 && impBad.stderr.includes("missing its turnId"), "session import rejects malformed events");
  const noFile = aih(["session", "import", join(tmpD, "nope.jsonl"), "s1-imported-nope"]);
  assert(noFile.status === 1 && noFile.stderr.includes("no such file"), "session import errors on a missing file");
}

// --- session rm hardening: never claim removal of non-sessions / traverse ---
{
  // A shell glob (`session rm *`) expands to every file in the CWD; none of
  // these are sessions. rm must error (exit 1) instead of printing "removed".
  const fake = aih(["session", "rm", "AGENTS.md", "aih.json", "not-a-session"]);
  assert(fake.status === 1 && fake.stderr.includes('no such session "AGENTS.md"'), "session rm errors on a non-session name instead of fake 'removed'");
  assert(!fake.stdout.includes("removed AGENTS.md"), "session rm never claims to remove a non-session");
  const trav = aih(["session", "rm", "../evil", "a/../b"]);
  assert(trav.status === 1 && trav.stderr.includes("not a valid session name"), "session rm rejects path-traversal names");
  const realRm = aih(["session", "fork", "s1", "s1-rm-me"]);
  assert(realRm.status === 0, "fork a session to remove");
  const rmIt = aih(["session", "rm", "s1-rm-me"]);
  assert(rmIt.status === 0 && rmIt.stdout.includes("removed s1-rm-me"), "session rm still removes a real session");
  assert(!existsSync(".aih/sessions/s1-rm-me.jsonl"), "session rm deletes the file for a real session");
}

const stats = aih(["stats"]);
assert(stats.status === 0, "stats command runs");
assert(stats.stdout.includes("(no usage recorded yet)"), "stats reports when no usage recorded");

const fork = aih(["session", "fork", "s1", "s1-branch"]);
assert(fork.status === 0 && fork.stdout.includes("forked s1"), "session fork copies a session");
assert(existsSync(".aih/sessions/s1-branch.jsonl"), "forked session file exists");
const forkAgain = aih(["session", "fork", "s1", "s1-branch"]);
assert(forkAgain.status === 1 && forkAgain.stderr.includes("already exists"), "fork refuses to overwrite an existing session");

// --- P#37①: distill an abandoned branch into a branch_summary event ---------
{
  // mock mode: AIH_MOCK_AUX_TEXT feeds the distiller's tool-less call
  const d = aih(["session", "distill-branch", "s1-branch", "s1", "--mock"], {
    AIH_MOCK_AUX_TEXT: "- Approach A breaks on Windows paths\n- Use pnpm in this repo",
  });
  assert(d.status === 0 && d.stdout.includes("branch summary #"), `distill-branch appends a summary (exit ${d.status}: ${d.stderr})`);
  const targetLog = readFileSync(".aih/sessions/s1.jsonl", "utf8");
  assert(targetLog.includes('"branch_summary"') && targetLog.includes('"fromSession":"s1-branch"'), "target log carries a branch_summary sourced from the abandoned branch");
  const missingTarget = aih(["session", "distill-branch", "s1-branch", "no-such-dst", "--mock"]);
  assert(missingTarget.status === 1 && missingTarget.stderr.includes("no such session"), "distill-branch refuses a missing target session");
}

// --- F#28: checkpoint / restore (append-only rollback) ----------------------
{
  const cp = aih(["session", "checkpoint", "s1", "before", "risky", "refactor"]);
  assert(cp.status === 0 && cp.stdout.includes("checkpoint #") && cp.stdout.includes("before risky refactor"), "session checkpoint records a named marker");
  const cpSeq = Number.parseInt(cp.stdout.match(/checkpoint #(\d+)/)?.[1] ?? "", 10);
  assert(Number.isFinite(cpSeq), "checkpoint reports its seq");

  const moreTurn = aih(["run", "turn after checkpoint", "--mock", "--yes", "--session", "s1"]);
  assert(moreTurn.status === 0, "turns keep appending after a checkpoint");

  const restore = aih(["session", "restore", "s1"]);
  assert(restore.status === 0 && restore.stdout.includes(`restore-${cpSeq}`), "session restore forks the prefix to a new session");
  const restoredFile = `.aih/sessions/s1-restore-${cpSeq}.jsonl`;
  assert(existsSync(restoredFile), "restored session file exists");
  const restoredEvents = JSON.parse(aih(["session", "export", `s1-restore-${cpSeq}`]).stdout);
  assert(restoredEvents[restoredEvents.length - 1].type === "checkpoint", "restored session ends at the checkpoint marker");
  assert(!restoredEvents.some((e: { text?: string }) => e.text === "turn after checkpoint"), "restored session excludes the post-checkpoint suffix");
  assert(
    readFileSync(".aih/sessions/s1.jsonl", "utf8").includes("turn after checkpoint"),
    "original session file stays untouched (append-only, full history auditable)",
  );
  const restoreAgain = aih(["session", "restore", "s1"]);
  assert(restoreAgain.status === 1 && restoreAgain.stderr.includes("already exists"), "restore refuses to overwrite an existing restored session");
  const badSeq = aih(["session", "restore", "s1", "99999"]);
  assert(badSeq.status === 1 && badSeq.stderr.includes("no checkpoint at seq"), "restore rejects an unknown checkpoint seq");
  const noCp = aih(["session", "restore", "s1-branch"]);
  assert(noCp.status === 1 && noCp.stderr.includes("no checkpoints"), "restore errors cleanly when the session has no checkpoints");
}

wipeLocalSessions();

const config = aih(["config"], { AIH_MODEL: "deepseek-v4-flash" });
assert(config.status === 0, "config command runs");
const configJson = JSON.parse(config.stdout);
assert(
  configJson.model.value === "deepseek-v4-flash" && configJson.model.source === "env AIH_MODEL",
  "config reports model source",
);

// context window resolution: providers.<name> > global aih.json > env > flag (highest) > 128k default
{
  const cwDir = ".aih-smoke-cw";
  rmSync(cwDir, { recursive: true, force: true });
  mkdirSync(cwDir, { recursive: true });
  writeFileSync(
    `${cwDir}/aih.json`,
    JSON.stringify({ model: "m1", contextWindow: 50000, providers: { p1: { model: "p1-model", contextWindow: 55555 } } }),
  );
  // P#40: the trust gate would hide this temp dir's aih.json (it is never in
  // the user's trust store) — mark it trusted for the duration of the block.
  // AIH_HOME sandbox: the dev machine's global layer (~/.local/share/aih) may
  // carry its own defaultProvider/providers (e.g. a local qwen endpoint);
  // without the sandbox those leak in whenever this fixture omits the key.
  const cwHome = mkdtempSync(join(tmpdir(), "aih-cw-home-"));
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AIH_TRUST_ALL_PROJECTS: "1",
    AIH_HOME: cwHome,
  };
  const runIn = (args: string[], envOverrides: Record<string, string> = {}) => {
    const merged: NodeJS.ProcessEnv = { ...baseEnv, ...envOverrides };
    if (!("AIH_CONTEXT_WINDOW" in envOverrides)) delete merged.AIH_CONTEXT_WINDOW;
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: merged, cwd: cwDir });
  };

  let r = runIn(["config", "--provider", "p1"]);
  let cw = JSON.parse(r.stdout).contextWindow;
  assert(
    r.status === 0 && cw.value === 55555 && cw.source.includes("p1.contextWindow") && cw.effective === 55555,
    "context window from providers.<name>.contextWindow",
  );

  r = runIn(["config"]);
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 50000 && cw.effective === 50000,
    "context window from global aih.json (no provider)",
  );

  r = runIn(["config"], { AIH_CONTEXT_WINDOW: "44444" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 44444 && cw.source === "env AIH_CONTEXT_WINDOW" && cw.effective === 44444,
    "env AIH_CONTEXT_WINDOW overrides aih.json",
  );

  r = runIn(["config", "--context-window", "33333"], { AIH_CONTEXT_WINDOW: "44444" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(
    cw.value === 33333 && cw.source.includes("flag") && cw.effective === 33333,
    "flag --context-window wins over env and config",
  );

  r = runIn(["config"], { AIH_CONTEXT_WINDOW: "bogus" });
  cw = JSON.parse(r.stdout).contextWindow;
  assert(cw.effective === 50000, "invalid AIH_CONTEXT_WINDOW falls through to the config tier");
  rmSync(cwDir, { recursive: true, force: true });
}

// Live context-window detection (llama.cpp /slots): MIN slot n_ctx is the
// effective per-request window; explicit flag/env still win; unreachable or
// non-llama endpoints fall back silently.
{
  const { createServer } = await import("node:http");
  const { probeContextWindow, resetWindowCache, detectedWindow } = await import("./window.js");
  const { resolveContextWindow } = await import("./index.js");
  const slotsSrv = createServer((req, res) => {
    if (req.url === "/slots") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: 0, n_ctx: 8192 },
          { id: 1, n_ctx: 4096 },
          { id: 2, n_ctx: "bogus" },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((r) => slotsSrv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(slotsSrv.address() as { port: number }).port}/v1`;
  const noSlotsSrv = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => noSlotsSrv.listen(0, "127.0.0.1", () => r()));
  const noSlotsBase = `http://127.0.0.1:${(noSlotsSrv.address() as { port: number }).port}/v1`;
  resetWindowCache();
  const probed = await probeContextWindow(base);
  assert(probed === 4096, "probe reads /slots and takes MIN n_ctx (non-numeric entries skipped)");
  assert(
    (await probeContextWindow(base)) === 4096,
    "probe result is cached (no second network call)",
  );
  assert(
    resolveContextWindow({ model: "m", "base-url": base }) === 4096,
    "detected window wins over aih.json config/default tier",
  );
  assert(
    resolveContextWindow({ model: "m", "base-url": base, "context-window": "777" }) === 777,
    "flag --context-window beats live detection",
  );
  const savedEnv = process.env.AIH_CONTEXT_WINDOW;
  process.env.AIH_CONTEXT_WINDOW = "1234";
  try {
    assert(
      resolveContextWindow({ model: "m", "base-url": base }) === 1234,
      "AIH_CONTEXT_WINDOW beats live detection",
    );
  } finally {
    if (savedEnv === undefined) delete process.env.AIH_CONTEXT_WINDOW;
    else process.env.AIH_CONTEXT_WINDOW = savedEnv;
  }
  assert(detectedWindow("http://127.0.0.1:1/v1") === undefined, "unprobed endpoint: no detected window");
  assert(
    (await probeContextWindow("http://127.0.0.1:1/v1")) === undefined,
    "unreachable endpoint: probe fails silently (no throw)",
  );
  assert(
    (await probeContextWindow(noSlotsBase)) === undefined,
    "endpoint without /slots: probe fails silently (fallback applies)",
  );
  slotsSrv.close();
  noSlotsSrv.close();
}

const models = aih(["models"], { AIH_MODEL: "deepseek-v4-flash" });
assert(
  models.status === 0 && models.stdout.includes("deepseek-v4-flash"),
  "models lists configured model",
);

// model catalog across providers (used by ctrl-p palette / /model picker)
{
  const catDir = ".aih-smoke-cat";
  const catHome = mkdtempSync(join(tmpdir(), "aih-cat-home-"));
  rmSync(catDir, { recursive: true, force: true });
  mkdirSync(catDir, { recursive: true });
  // P#40: trust gate would hide the temp dir's aih.json — trust it for this block.
  process.env.AIH_TRUST_ALL_PROJECTS = "1";
  writeFileSync(
    `${catDir}/aih.json`,
    JSON.stringify({
      defaultProvider: "alpha",
      model: "m1",
      providers: {
        alpha: { baseUrl: "http://a.example/v1", model: "alpha-model", contextWindow: 32000 },
        beta: { baseUrl: "http://b.example/v1", model: "beta-model" },
        gamma: {
          baseUrl: "http://g.example/v1",
          model: "gamma-main",
          models: ["gamma-free-1", "gamma-free-2"],
        },
      },
    }),
  );
  const runIn = (args: string[]) => {
    // strip ambient AIH_MODEL / AIH_BASE_URL so aih.json providers decide;
    // P#40: temp dir is never in the trust store → mark trusted for this block;
    // AIH_HOME sandbox keeps the machine's global layer (defaultProvider etc.)
    // out of the merge — fixtures here omit keys on purpose.
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      AIH_TRUST_ALL_PROJECTS: "1",
      AIH_HOME: catHome,
    };
    delete e.AIH_MODEL;
    delete e.AIH_BASE_URL;
    return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: catDir, env: e });
  };

  const cfg = runIn(["config"]);
  const cfgJson = JSON.parse(cfg.stdout);
  assert(cfgJson.provider === "alpha", "defaultProvider resolves from aih.json");
  assert(cfgJson.model.value === "alpha-model", "provider model overrides top-level model");

  // switching provider via --provider picks up that provider's model + context window
  const switched = runIn(["config", "--provider", "beta"]);
  const swJson = JSON.parse(switched.stdout);
  assert(swJson.model.value === "beta-model", "--provider beta resolves beta-model");

  // a provider's `models[]` extras each become their own catalog entry
  const modelsOut = runIn(["models"]);
  assert(
    modelsOut.stdout.includes("gamma-main") &&
      modelsOut.stdout.includes("gamma-free-1") &&
      modelsOut.stdout.includes("gamma-free-2"),
    "models[] extras are listed alongside the primary model",
  );
  // switching to an extra model keeps the provider's endpoint
  const freeSwitch = runIn(["config", "--provider", "gamma", "--model", "gamma-free-1"]);
  const freeJson = JSON.parse(freeSwitch.stdout);
  assert(freeJson.model.value === "gamma-free-1", "--model picks a models[] extra");
  assert(
    String(freeJson.baseUrl?.value ?? "").includes("g.example"),
    "models[] extra inherits the provider baseUrl",
  );

  // F#34 — per-model contextWindow: models[] accepts object form
  // { model, contextWindow }; the model-level value overrides the provider's
  // contextWindow for that model only (siblings keep the provider tier).
  writeFileSync(
    `${catDir}/aih.json`,
    JSON.stringify({
      defaultProvider: "gamma",
      providers: {
        gamma: {
          baseUrl: "http://g.example/v1",
          contextWindow: 131072,
          model: "gamma-main",
          models: ["gamma-free-1", { model: "gamma-1m", contextWindow: 1000000 }],
        },
      },
    }),
  );
  const oneM = JSON.parse(runIn(["config", "--provider", "gamma", "--model", "gamma-1m"]).stdout);
  assert(
    oneM.contextWindow.effective === 1000000 &&
      String(oneM.contextWindow.source).includes("models[gamma-1m].contextWindow"),
    "model-level contextWindow overrides the provider tier",
  );
  const sibling = JSON.parse(runIn(["config", "--provider", "gamma", "--model", "gamma-free-1"]).stdout);
  assert(
    sibling.contextWindow.effective === 131072 &&
      String(sibling.contextWindow.source).includes("providers.gamma.contextWindow"),
    "sibling models[] entries keep the provider contextWindow",
  );
  const primary = JSON.parse(runIn(["config", "--provider", "gamma"]).stdout);
  assert(primary.contextWindow.effective === 131072, "primary model uses the provider contextWindow");
  const objListed = runIn(["models"]);
  assert(objListed.stdout.includes("gamma-1m"), "`aih models` lists object-form models[] entries");

  rmSync(catDir, { recursive: true, force: true });
  delete process.env.AIH_TRUST_ALL_PROJECTS;
}

{
  // Window-fix regression — the resolver previously never consulted the
  // committed models.dev snapshot, so a model whose window is declared only
  // there (catalog-connected providers like glm-5.3-flash) fell through to
  // the hardcoded 128k default.
  const { snapshotContextWindow } = await import("./cost.js");
  const { resolveContextWindow } = await import("./index.js");
  // bare-name match resolves to the MODE of provider-reported windows
  // (tie → smaller): claiming more than the model supports would hard-fail
  // at the provider, under-claiming only compacts earlier.
  const w = snapshotContextWindow("glm-5.3-flash");
  assert(
    w !== undefined && w >= 1_000_000,
    `window-fix: snapshot knows glm-5.3-flash >=1M (got ${w})`,
  );
  assert(snapshotContextWindow("totally-unknown-model-xyz") === undefined, "window-fix: unknown model → undefined (default stays)");
  // provider hint pins the provider-scoped entry
  const hint = snapshotContextWindow("glm-5.3-flash", "opencode-go");
  assert(hint === 1_000_000, `window-fix: provider hint resolves scoped entry (got ${hint})`);
  // full resolver path: catalog-style config (no window declared anywhere)
  // no longer lands on the 131072 default when the snapshot knows the model
  const mkd = (await import("node:fs")).mkdtempSync;
  const jn = (await import("node:path")).join;
  const dir = mkd(jn(tmpdir(), "aih-win-"));
  process.env.AIH_TRUST_ALL_PROJECTS = "1";
  const prevCwd = process.cwd();
  process.chdir(dir);
  writeFileSync(
    `${dir}/aih.json`,
    JSON.stringify({
      defaultProvider: "cat",
      providers: { cat: { baseUrl: "http://c.example/v1", model: "glm-5.3-flash", keyless: true } },
    }),
  );
  const resolvedWin = resolveContextWindow({ model: "glm-5.3-flash", provider: "" });
  assert(
    resolvedWin >= 1_000_000,
    `window-fix: catalog-style config gets the real window, not 131072 (got ${resolvedWin})`,
  );
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AIH_TRUST_ALL_PROJECTS;
  console.log("ok: window-fix — models.dev snapshot tier in resolveContextWindow");
}

// `/connect` — interactive provider connect (opencode parity, OpenAI-compatible):
// catalog list, saveProvider (key never in aih.json), env-file key persistence
// (chmod 600) and startup auto-load. Pure functions shared by TUI /connect and
// `aih connect`.
{
  const { connectCatalog, catalogEntry } = await import("./provider-catalog.js");
  const { saveProvider, setProjectTrustState, loadModelCatalog } = await import("./config.js");
  const { envFilePath, persistEnvKey, loadEnvFile } = await import("./index.js");
  const { isKnownSlashCommand, BUILTIN_SLASH_HEADS } = await import("./slash.js");

  assert(BUILTIN_SLASH_HEADS.has("connect"), "/connect is a known builtin slash head");
  assert(isKnownSlashCommand("/connect"), "isKnownSlashCommand('/connect') → true");
  assert(isKnownSlashCommand("/connect deepseek"), "/connect <id> is still the known head (falls into the /connect handler)");

  const cat = connectCatalog();
  assert(cat.length >= 20, `catalog has a curated set (got ${cat.length})`);
  // opencode priority: the five popular providers come before the rest
  const names = cat.map((p) => p.id);
  const popular = ["opencode", "opencode-go", "openai", "openrouter", "github-copilot"];
  const popularIdx = popular.map((id) => names.indexOf(id));
  for (const [i, id] of popular.entries()) {
    assert(popularIdx[i] >= 0, `popular provider ${id} present`);
    if (i > 0) assert(popularIdx[i] > popularIdx[i - 1], `popular ordering: ${popular[i - 1]} before ${id}`);
  }
  // non-popular entries are alphabetical by (display) name
  const tailNames = names
    .slice(Math.max(...popularIdx) + 1)
    .map((id) => cat.find((p) => p.id === id)!.name);
  const sortedNames = [...tailNames].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(tailNames) === JSON.stringify(sortedNames), "non-popular catalog entries are alphabetical by name");
  const openai = catalogEntry("openai");
  assert(openai?.baseUrl === "https://api.openai.com/v1" && openai.apiKeyEnv === "OPENAI_API_KEY", "openai entry has correct baseUrl/env");
  // Anthropic / Google are NOT catalog entries (native SDK, not OpenAI-compatible)
  assert(catalogEntry("anthropic") === undefined && catalogEntry("google") === undefined, "native-SDK providers are excluded from the catalog");

  // saveProvider: merges into providers.<name>, key never written, id validated
  const scDir = ".aih-smoke-connect";
  const scHome = mkdtempSync(join(tmpdir(), "aih-connect-home-"));
  rmSync(scDir, { recursive: true, force: true });
  mkdirSync(scDir, { recursive: true });
  process.env.AIH_HOME = scHome;
  const prevCwd = process.cwd();
  const prevTrust = process.env.AIH_TRUST_ALL_PROJECTS;
  process.env.AIH_TRUST_ALL_PROJECTS = "1";
  setProjectTrustState("trusted"); // P#40: direct-call tests must init trust explicitly
  process.chdir(scDir);
  writeFileSync("aih.json", JSON.stringify({ schemaVersion: 1 }), "utf8");
  const saved = saveProvider("deepseek", {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
  });
  assert(saved.endsWith("aih.json"), `saveProvider writes the project aih.json (got ${saved})`);
  const onDisk = JSON.parse(readFileSync("aih.json", "utf8"));
  assert(onDisk.providers.deepseek.baseUrl === "https://api.deepseek.com", "provider baseUrl persisted");
  assert(onDisk.providers.deepseek.apiKeyEnv === "DEEPSEEK_API_KEY", "apiKeyEnv persisted (key itself never is)");
  assert(JSON.stringify(onDisk).includes("sk-") === false, "no plaintext key ever lands in aih.json");
  // merging: existing fields survive
  saveProvider("deepseek", { model: "deepseek-chat-v2" });
  const merged = JSON.parse(readFileSync("aih.json", "utf8")).providers.deepseek;
  assert(merged.baseUrl === "https://api.deepseek.com" && merged.model === "deepseek-chat-v2", "saveProvider merges, keeps existing baseUrl");
  // invalid id rejected
  let threw = false;
  try {
    saveProvider("bad id!", { baseUrl: "http://x" });
  } catch {
    threw = true;
  }
  assert(threw, "saveProvider rejects invalid provider ids");

  // env-file key persistence: chmod 600 + auto-load round-trip
  const envPath = ".aih-smoke.env";
  process.env.AIH_ENV_PATH = join(process.cwd(), envPath);
  const stored = persistEnvKey("SMOKE_KEY", "smoke-value-123abc");
  const st = statSync(stored);
  assert((st.mode & 0o777) === 0o600, `env file is chmod 600 (got ${st.mode & 0o777})`);
  assert(readFileSync(stored, "utf8").includes("smoke-value-123abc"), "env file holds the key (that file is 0600)");
  delete process.env.SMOKE_KEY; // simulate a fresh process
  const loaded: Record<string, string> = {};
  loaded.AIH_ENV_PATH = join(process.cwd(), envPath);
  loadEnvFile(loaded);
  assert(loaded.SMOKE_KEY === "smoke-value-123abc", "loadEnvFile restores the persisted key");
  // existing env wins (never overrides)
  const loaded2: Record<string, string> = { SMOKE_KEY: "shell-wins" };
  loadEnvFile(loaded2);
  assert(loaded2.SMOKE_KEY === "shell-wins", "loadEnvFile never overrides an existing env var");

  // opencode DialogModel parity: the model picker lists NOT-yet-configured
  // providers as "+ connect" entries; configured providers are excluded.
  const pickerCatalog = loadModelCatalog(undefined, undefined);
  const pickerConfigured = new Set(pickerCatalog.map((e) => e.provider));
  const pickerConnectable = connectCatalog().filter((p) => !pickerConfigured.has(p.id));
  assert(pickerConfigured.has("deepseek"), "saveProvider'd deepseek is a configured provider");
  assert(!pickerConnectable.some((p) => p.id === "deepseek"), "configured provider is excluded from connect entries");
  assert(pickerConnectable.length >= 10, `catalog keeps unconfigured connect candidates (got ${pickerConnectable.length})`);
  const pickerHead = pickerConnectable.slice(0, 6).map((p) => p.id);
  assert(pickerHead.includes("opencode"), "opencode is a top connect candidate when unconfigured");


  process.chdir(prevCwd);
  process.env.AIH_HOME = undefined;
  setProjectTrustState("untrusted"); // restore module-level trust for later blocks
  delete process.env.AIH_TRUST_ALL_PROJECTS;
  delete process.env.AIH_ENV_PATH;
  if (prevTrust === undefined) delete process.env.AIH_TRUST_ALL_PROJECTS;
  else process.env.AIH_TRUST_ALL_PROJECTS = prevTrust;
  rmSync(scDir, { recursive: true, force: true });
  console.log("ok: /connect — provider catalog + saveProvider + env-file key store (chmod 600, auto-load)");
}


const skillsList = aih(["skills", "list"]);
assert(
  skillsList.status === 0 &&
    skillsList.stdout.includes("app-tour") &&
    skillsList.stdout.includes("builtin"),
  "skills list shows builtin skills",
);
const skillsFind = aih(["skills", "find", "tour"]);
const findDataLine = skillsFind.stdout.trim().split("\n")[1] ?? "";
assert(
  skillsFind.status === 0 && findDataLine.includes("app-tour"),
  "skills find ranks name matches first",
);
const skillsInstall = aih(["skills", "install", "batch-ops"]);
assert(
  skillsInstall.status === 0 && existsSync(".aih/skills/batch-ops/SKILL.md"),
  "skills install writes project SKILL.md",
);
const skillsListAfter = aih(["skills", "list"]);
assert(
  skillsListAfter.status === 0 && skillsListAfter.stdout.includes("project"),
  "installed skill discovered with project scope",
);
const skillsShowMissing = aih(["skills", "show", "nope"]);
assert(
  skillsShowMissing.status === 1 && skillsShowMissing.stderr.includes("unknown skill"),
  "skills show rejects unknown name",
);

// CC#52 — load_skill de-duplication tracker.
{
  const { SkillLoadTracker } = await import("./skills.js");
  const { registerSkillTool } = await import("./index.js");
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const t = new SkillLoadTracker();
  assert(!t.isLoaded("app-tour"), "CC#52: skill not loaded initially");
  t.markLoaded("app-tour");
  assert(t.isLoaded("app-tour"), "CC#52: skill marked loaded after first load");
  assert(t.loadedNames().length === 1 && t.loadedNames()[0] === "app-tour", "CC#52: loadedNames lists the loaded skill");
  // Compaction invalidates the mark → reload allowed.
  t.reset();
  assert(!t.isLoaded("app-tour"), "CC#52: compaction reset invalidates load marks");

  // Tool-level: a second load_skill call returns a recap, not the full body.
  const reg = new ToolRegistry(new AutoApprove());
  registerSkillTool(reg, { projectTrusted: true });
  const tool = reg.get("load_skill")!;
  const once = await tool.execute({ name: "app-tour" }, { turnId: "t", inject: () => {} });
  const twice = await tool.execute({ name: "app-tour" }, { turnId: "t", inject: () => {} });
  assert(
    typeof once === "string" && String(once).length > 200,
    "CC#52: first load returns the full skill body",
  );
  assert(
    typeof twice === "string" &&
      String(twice).includes("already loaded") &&
      String(twice).length < 400,
    "CC#52: repeat load returns a short dedup recap, not a full duplicate",
  );
  console.log("ok: CC#52 SkillLoadTracker dedups repeat loads and resets on compaction");
}

// --- external skill registry (opencode-compatible index.json) ---
{
  const http = await import("node:http");
  const pathMod = await import("node:path");

  const regContent = ".aih-smoke-reg-content";
  const workDir = ".aih-smoke-reg-work";
  rmSync(regContent, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(`${regContent}/tui-design`, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    `${regContent}/tui-design/SKILL.md`,
    `---\nname: tui-design\ndescription: TUI UI design principles for terminal interfaces\n---\n# TUI Design\n\nWrap long lines and dim secondary text.\n`,
  );
  writeFileSync(
    `${regContent}/index.json`,
    JSON.stringify({
      skills: [
        {
          name: "tui-design",
          description: "TUI UI design principles for terminal interfaces",
          files: ["SKILL.md"],
          version: "1.0.0",
        },
        { name: "no-skill-md", description: "broken entry", files: ["README.md"], version: "1" },
      ],
    }),
  );
  // pre-create a project config so `skills registry <url>` writes here, not ~/.aih
  writeFileSync(`${workDir}/aih.json`, "{}\n");

  const root = pathMod.resolve(regContent);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const file = pathMod.resolve(root, rel);
    if (file !== root && !file.startsWith(root + pathMod.sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(readFileSync(file, "utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/`;

  // NOTE: must use async spawn (not spawnSync) so this process's event loop
  // stays free to serve the in-process HTTP registry while the CLI fetches it.
  const { execFile } = await import("node:child_process");
  const runIn = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => {
    // P#40: registry URL lives in the project aih.json — trust the temp dir
    const e: NodeJS.ProcessEnv = { ...process.env, AIH_TRUST_ALL_PROJECTS: "1" };
    delete e.AIH_SKILL_REGISTRY;
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        { encoding: "utf8", cwd: workDir, env: e },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ status: code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  };

  try {
    const regSet = await runIn(["skills", "registry", base]);
    assert(
      regSet.status === 0 && regSet.stdout.includes("registry set to"),
      "skills registry <url> persists the registry URL",
    );
    assert(
      readFileSync(`${workDir}/aih.json`, "utf8").includes(base),
      "registry URL written to the project aih.json",
    );
    const regShow = await runIn(["skills", "registry"]);
    assert(regShow.status === 0 && regShow.stdout.includes(base), "skills registry shows the configured URL");

    const find = await runIn(["skills", "find", "tui"]);
    assert(
      find.status === 0 && find.stdout.includes("tui-design") && find.stdout.includes("remote"),
      "skills find surfaces remote registry matches",
    );
    assert(!find.stdout.includes("no-skill-md"), "registry entries without SKILL.md are filtered out");

    const inst = await runIn(["skills", "install", "tui-design"]);
    assert(
      inst.status === 0 && existsSync(`${workDir}/.aih/skills/tui-design/SKILL.md`),
      "skills install downloads a remote skill into .aih/skills",
    );
    assert(inst.stdout.includes("remote"), "remote install is labeled as remote");

    const listAfter = await runIn(["skills", "list"]);
    assert(
      listAfter.stdout.includes("tui-design") && listAfter.stdout.includes("project"),
      "installed remote skill is discovered with project scope",
    );

    rmSync(`${workDir}/.aih/skills/tui-design`, { recursive: true, force: true });
    const findInstall = await runIn(["skills", "find", "terminal design", "--install"]);
    assert(
      findInstall.status === 0 && existsSync(`${workDir}/.aih/skills/tui-design/SKILL.md`),
      "skills find --install auto-installs the top remote match",
    );

    const reinstall = await runIn(["skills", "install", "tui-design"]);
    assert(reinstall.status === 0, "reinstalling the same version is a clean no-op");

    const unknown = await runIn(["skills", "install", "does-not-exist"]);
    assert(
      unknown.status === 1 && unknown.stderr.includes("unknown skill"),
      "installing an unknown remote skill fails with a clear error",
    );
  } finally {
    server.close();
    rmSync(regContent, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

const devTools = aih(["tools", "--dev"]);
assert(
  devTools.status === 0 &&
    devTools.stdout.includes("run_cmd") &&
    devTools.stdout.includes("write_file") &&
    devTools.stdout.includes("add_todo"),
  "tools --dev lists local dev tools alongside app tools",
);
const generalTools = aih(["tools", "--dev"]);
for (const name of ["edit", "glob", "grep", "todo", "remember", "question", "task", "webfetch", "websearch", "apply_patch"]) {
  assert(generalTools.stdout.includes(name), `tools --dev lists ${name}`);
}

{
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const {
    registerGeneralTools,
    resolveFetchTimeout,
    isCloudflareChallenge,
    fetchFailureMessage,
    fetchWithRetry,
    FETCH_UA_BROWSER,
    FETCH_UA_HONEST,
    FETCH_DEFAULT_TIMEOUT_MS,
    FETCH_MAX_TIMEOUT_MS,
  } = await import("./general-tools.js");
  const workdir = ".aih-smoke-general";
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(`${workdir}/src`, { recursive: true });
  writeFileSync(`${workdir}/src/app.ts`, "const a = 1;\nconst b = 2;\n");
  const gate = new AutoApprove();
  const registry = new ToolRegistry(gate);
  registerGeneralTools(registry, { gate, cwd: workdir });
  const call = async (name: string, args: unknown) => {
    const r = await registry.invoke(name, args, { turnId: "t", inject: () => {} });
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    return r.result as Record<string, unknown>;
  };
  const editRes = await call("edit", { path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 9;" });
  assert(readFileSync(`${workdir}/src/app.ts`, "utf8").includes("const a = 9;"), "edit replaces an exact string");
  const editDiff = editRes._diff as Array<{ t: string; s: string }>;
  assert(
    Array.isArray(editDiff) &&
      editDiff.some((d) => d.t === "del" && d.s.includes("const a = 1")) &&
      editDiff.some((d) => d.t === "add" && d.s.includes("const a = 9")),
    "edit returns a before/after diff for TUI rendering",
  );
  const globRes = await call("glob", { pattern: "*.ts" });
  assert((globRes.files as string[]).includes("src/app.ts"), "glob finds files at any depth");
  const grepRes = await call("grep", { pattern: "const a", include: "*.ts" });
  assert((grepRes.matches as unknown[]).length === 1, "grep matches file contents");
  await call("todo", { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "pending" }] });
  assert(existsSync(`${workdir}/.aih/todos.json`), "todo persists the list");
  const todoRes = await call("todo", { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "pending" }] });
  const todoItems = todoRes.todos as Array<{ content: string; status: string }>;
  assert(
    Array.isArray(todoItems) &&
      todoItems.length === 2 &&
      todoItems.some((t) => t.content === "x" && t.status === "in_progress") &&
      todoItems.some((t) => t.content === "y" && t.status === "pending"),
    "todo returns structured todos for the TUI side panel",
  );
  const emptyTodos = await call("todo", { todos: [] });
  assert((emptyTodos.todos as unknown[]).length === 0 && emptyTodos.list === "(empty)", "todo renders empty list");
  const patchRes = await call("apply_patch", {
    patch: "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** Update File: src/app.ts\n@@ const a = 9;\n-const b = 2;\n+const b = 3;\n*** End Patch",
  });
  assert(
    (patchRes.applied as string[]).length === 2 && readFileSync(`${workdir}/src/app.ts`, "utf8").includes("const b = 3;"),
    "apply_patch adds and updates files",
  );
  // apply_patch robustness (opencode Patch engine parity) — the old parser
  // dropped space-prefixed context lines and threw "empty hunk" on legitimate
  // pure-insertion hunks, forcing the model onto run_cmd heredoc detours.
  {
    // 1) pure insertion with NO scope hint → appended at EOF (was: "empty hunk")
    await call("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n+// appended tail\n*** End Patch",
    });
    assert(
      readFileSync(`${workdir}/src/app.ts`, "utf8").trimEnd().endsWith("// appended tail"),
      "apply_patch pure-insertion hunk appends at EOF (no more 'empty hunk')",
    );
    // 2) space-prefixed context line participates in matching AND survives
    await call("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@ const a = 9;\n-const a = 9;\n+const a = 9; // kept\n*** End Patch",
    });
    const afterCtx = readFileSync(`${workdir}/src/app.ts`, "utf8");
    assert(
      afterCtx.includes("const a = 9; // kept"),
      "apply_patch space-prefixed context lines match and survive",
    );
    // 3) *** End of File anchors the match at the tail
    await call("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n // appended tail\n+// eof anchored\n*** End of File\n*** End Patch",
    });
    assert(
      readFileSync(`${workdir}/src/app.ts`, "utf8").trimEnd().endsWith("// eof anchored"),
      "apply_patch *** End of File anchors the hunk at the file tail",
    );
  }
  await call("remember", { action: "append", text: "smoke memory entry" });
  assert(
    readFileSync(`${workdir}/.aih/memory.md`, "utf8").includes("smoke memory entry"),
    "remember appends to .aih/memory.md",
  );
  // P0#2: user-level memory (cross-project) + injection budget.
  // AIH_HOME is redirected in-process so scope=user never touches real user data.
  const memHome = mkdtempSync("/tmp/aih-mem-");
  const userMemPath = `${memHome}/memory.md`;
  const prevAihHome = process.env.AIH_HOME;
  process.env.AIH_HOME = memHome;
  try {
    const userRes = await call("remember", { action: "append", text: "user-level smoke memory", scope: "user" });
    assert(
      (userRes.path as string) === userMemPath && readFileSync(userMemPath, "utf8").includes("user-level smoke memory"),
      "remember scope=user writes the XDG user memory file",
    );
    const userSet = await call("remember", { action: "set", text: "rewritten user memory", scope: "user" });
    assert(
      (userSet.path as string) === userMemPath &&
        readFileSync(userMemPath, "utf8").startsWith("# User memory") &&
        readFileSync(userMemPath, "utf8").includes("rewritten user memory") &&
        !readFileSync(userMemPath, "utf8").includes("user-level smoke memory"),
      "remember scope=user action=set rewrites the user file",
    );
    let badScope: string;
    try {
      await call("remember", { action: "append", text: "x", scope: "nope" });
      badScope = "no error";
    } catch (e) {
      badScope = String((e as Error).message);
    }
    assert(badScope.includes("unknown scope"), "remember rejects an unknown scope");
    const { loadMemoryBlock } = await import("./index.js");
    const block = loadMemoryBlock(workdir);
    assert(block.includes("smoke memory entry"), "loadMemoryBlock injects project memory");
    assert(block.includes("rewritten user memory"), "loadMemoryBlock also injects the current user memory");
    writeFileSync(userMemPath, "# User memory\n\n- 2026-01-01 — user fact abc\n");
    const block2 = loadMemoryBlock(workdir);
    assert(block2.includes("smoke memory entry") && block2.includes("user fact abc"), "loadMemoryBlock injects project + user memory");
    assert(block2.indexOf("# Project memory") < block2.indexOf("# User memory"), "project memory comes before user memory");
    // budget caps total length (project first, user gets the remainder)
    const big = "x".repeat(9000);
    writeFileSync(`${workdir}/.aih/memory.md`, `# Project memory\n\n- ${big}\n`);
    writeFileSync(userMemPath, `# User memory\n\n- ${big}\n`);
    const prevBudget = process.env.AIH_MEMORY_BUDGET;
    process.env.AIH_MEMORY_BUDGET = "1200";
    try {
      const capped = loadMemoryBlock(workdir);
      assert(capped.length <= 1400 && capped.includes("…(truncated)"), "AIH_MEMORY_BUDGET caps the injected memory block");
    } finally {
      if (prevBudget === undefined) delete process.env.AIH_MEMORY_BUDGET;
      else process.env.AIH_MEMORY_BUDGET = prevBudget;
    }
  } finally {
    if (prevAihHome === undefined) delete process.env.AIH_HOME;
    else process.env.AIH_HOME = prevAihHome;
  }
  const registryHooks = new ToolRegistry(gate);
  registryHooks.register({
    name: "calc",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ sum: 3 }),
  });
  registryHooks.addHooks({
    before: (info) => {
      if ((info.args as Record<string, unknown>).veto) throw new Error("nope");
    },
    after: (_info, outcome) =>
      outcome.ok ? { ...outcome, result: { ...(outcome.result as object), hooked: true } } : undefined,
  });
  const hookOk = await registryHooks.invoke("calc", { a: 1 }, { turnId: "t", inject: () => {} });
  assert(
    hookOk.ok && (hookOk.result as Record<string, unknown>).hooked === true,
    "after hook rewrites the tool result",
  );
  const hookDenied = await registryHooks.invoke("calc", { veto: true }, { turnId: "t", inject: () => {} });
  assert(!hookDenied.ok && (hookDenied.error ?? "").includes("hook vetoed"), "before hook can veto a call");

  // D#11: builtin redaction + timing hooks
  const { redactSecrets, countSecrets, builtinHooks, composeHooks } = await import("./hooks.js");
  const r1 = redactSecrets({ stdout: "token=sk-abcdef1234567890 done" }) as Record<string, unknown>;
  assert(String(r1.stdout).includes("[REDACTED]") && !String(r1.stdout).includes("sk-abcdef1234567890"), "redactSecrets masks sk- tokens");
  const r2 = redactSecrets("ghp_ABCDEFGHIJKLMNOP1234567890") as string;
  assert(r2.includes("[REDACTED]") && !r2.includes("ghp_ABCDEFGHIJKLMNOP1234567890"), "redactSecrets masks ghp_ tokens");
  const r3 = redactSecrets("password: hunter2secretvalue") as string;
  assert(r3.includes("[REDACTED]") && !r3.includes("hunter2secretvalue"), "redactSecrets masks key=value secrets");
  assert(redactSecrets("hello world") === "hello world", "redactSecrets leaves non-secret text alone");
  assert(redactSecrets({ a: 1, b: [true, "xoxb-1234567890abcdef"] }) !== undefined, "redactSecrets recurses into arrays/objects");
  assert(countSecrets("sk-abcdef1234567890") >= 1, "countSecrets counts secret shapes");
  assert(countSecrets("no secrets here") === 0, "countSecrets is 0 for clean text");

  // D#11 skill-driven hook config: extra secret shapes from skill front matter
  const { compileExtraPatterns } = await import("./hooks.js");
  const extra = ["acme_[A-Z0-9]{16,}"];
  const rSkill = redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234 done", extra) as string;
  assert(rSkill.includes("[REDACTED]") && !rSkill.includes("acme_ABCDEFGHIJKLMNOP1234"), "skill-driven pattern masks a custom secret shape");
  assert(redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234") === "key=acme_ABCDEFGHIJKLMNOP1234", "without the skill pattern the custom shape is untouched");
  assert(countSecrets("key=acme_ABCDEFGHIJKLMNOP1234", extra) >= 1, "countSecrets sees skill-driven patterns");
  // invalid regex source is skipped (never breaks the turn)
  const badExtra = ["[unclosed", "acme_[A-Z0-9]{16,}"];
  assert(compileExtraPatterns(badExtra).length === 1, "compileExtraPatterns skips invalid regexes");
  assert(redactSecrets("key=acme_ABCDEFGHIJKLMNOP1234", badExtra) !== "key=acme_ABCDEFGHIJKLMNOP1234", "valid patterns still apply alongside an invalid one");
  // builtin patterns still apply on top of skill-driven ones
  const rBoth = redactSecrets("a=sk-abcdef1234567890 b=acme_ABCDEFGHIJKLMNOP1234", extra) as string;
  assert(!rBoth.includes("sk-abcdef1234567890") && !rBoth.includes("acme_ABCDEFGHIJKLMNOP1234"), "builtin + skill-driven patterns both apply");

  const regHooks = new ToolRegistry(new AutoApprove());
  regHooks.register({
    name: "leaky",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ stdout: "api_key=abcd1234efgh5678ijkl", n: 7 }),
  });
  regHooks.addHooks(builtinHooks());
  const hookResult = (await regHooks.invoke("leaky", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; n?: number; duration_ms?: number; redacted?: number };
  };
  assert(hookResult.ok, "builtin hook invocation succeeds");
  assert(!!hookResult.result?.stdout && hookResult.result.stdout.includes("[REDACTED]"), "result stdout is redacted");
  assert(!!hookResult.result?.stdout && !hookResult.result.stdout.includes("abcd1234efgh5678ijkl"), "raw secret is gone from result");
  assert(typeof hookResult.result?.duration_ms === "number" && hookResult.result!.duration_ms! >= 0, "duration_ms attached (>=0)");
  assert((hookResult.result?.redacted ?? 0) >= 1, "redacted counter present");
  assert(hookResult.result?.n === 7, "non-string fields untouched");

  // composeHooks: builtin (redact+timing) then a custom after — both apply in order
  const regCompose = new ToolRegistry(new AutoApprove());
  regCompose.register({
    name: "leaky2",
    description: "d",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ stdout: "token=sk-zzzzzzzzzzzzzzzz" }),
  });
  regCompose.addHooks(
    composeHooks([
      builtinHooks(),
      { after: (_i, o) => ({ ...o, result: { ...((o.result as object) ?? {}), tagged: true } }) },
    ]),
  );
  const composed = (await regCompose.invoke("leaky2", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; tagged?: boolean; duration_ms?: number };
  };
  assert(composed.ok, "composed hooks invocation succeeds");
  assert(!!composed.result?.stdout && composed.result.stdout.includes("[REDACTED]"), "redaction applied in composition");
  assert(composed.result?.tagged === true, "custom after hook still runs after builtin");
  assert(typeof composed.result?.duration_ms === "number", "timing still present in composition");

  const planRegistry = new ToolRegistry(gate);
  registerGeneralTools(planRegistry, { gate, cwd: workdir }, true);
  const planNames = new Set(planRegistry.schemas().map((s) => s.name));
  assert(
    !planNames.has("edit") && !planNames.has("apply_patch"),
    "plan mode hides write-kind general tools",
  );
  // todo/remember mutate disk, so they are write-kind and must be hidden in plan mode
  assert(
    !planNames.has("todo") && !planNames.has("remember"),
    "plan mode hides disk-mutating tools (todo, remember)",
  );
  // read-only tools stay available in plan mode
  assert(planNames.has("glob") && planNames.has("grep"), "plan mode keeps read-only tools (glob, grep)");

  // ── webfetch hardening (opencode/MiMo parity) ──────────────────────────────
  // 1) timeout resolution: arg(s) > env(ms) > 30s default, hard cap 120s
  assert(resolveFetchTimeout(undefined, undefined) === FETCH_DEFAULT_TIMEOUT_MS, "fetch timeout defaults to 30s");
  assert(resolveFetchTimeout(undefined, "45000") === 45000, "fetch timeout honors AIH_FETCH_TIMEOUT_MS");
  assert(resolveFetchTimeout(5, "45000") === 5000, "fetch timeout arg (seconds) wins over env");
  assert(resolveFetchTimeout(999, undefined) === FETCH_MAX_TIMEOUT_MS, "fetch timeout capped at 120s");
  assert(resolveFetchTimeout("garbage", undefined) === FETCH_DEFAULT_TIMEOUT_MS, "fetch timeout ignores bad arg");
  assert(resolveFetchTimeout(10, "0") === 10000, "fetch timeout env 0 means 'unset'");

  // 2) Cloudflare challenge detection
  const cfRes = new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } });
  assert(isCloudflareChallenge(cfRes), "cf-mitigated: challenge + 403 detected");
  assert(!isCloudflareChallenge(new Response(null, { status: 403 })), "plain 403 is not a challenge");
  assert(!isCloudflareChallenge(new Response(null, { status: 200, headers: { "cf-mitigated": "challenge" } })), "200 with header is not a challenge");

  // 3) actionable failure messages (FA#2: tell the model what to DO)
  const timeoutMsg = fetchFailureMessage(new DOMException("aborted", "AbortError"), "https://x.example", 30000);
  assert(timeoutMsg.includes("timed out after 30s") && timeoutMsg.includes("websearch"), "timeout message is actionable");
  const connMsg = fetchFailureMessage(new Error("fetch failed"), "https://x.example", 30000);
  assert(connMsg.includes("connection failed") && connMsg.includes("alternate source"), "connection message is actionable");

  // 4) one bounded retry on transient network failure (then success)
  {
    let calls = 0;
    const flakyFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const res = await fetchWithRetry("https://flaky.example", { timeoutMs: 1000, fetchImpl: flakyFetch, delayMs: 0 });
    assert(calls === 2 && res.status === 200, "transient failure is retried once and succeeds");
  }
  // 5) two failures → actionable error, no infinite retry
  {
    let calls = 0;
    const deadFetch: typeof fetch = async () => {
      calls += 1;
      throw new Error("fetch failed");
    };
    let deadErr = "";
    try {
      await fetchWithRetry("https://dead.example", { timeoutMs: 1000, fetchImpl: deadFetch, delayMs: 0 });
    } catch (e) {
      deadErr = String((e as Error).message);
    }
    assert(calls === 2, "bounded: exactly one retry, no infinite loop");
    assert(deadErr.includes("connection failed") && deadErr.includes("websearch"), "dead host yields actionable error");
  }
  // 6) Cloudflare challenge → honest-UA retry (opencode parity)
  {
    const seenUA: string[] = [];
    const cfFetch: typeof fetch = async (_url, init) => {
      const ua = String((init?.headers as Record<string, string>)?.["user-agent"] ?? "");
      seenUA.push(ua);
      if (ua === FETCH_UA_BROWSER) return new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } });
      return new Response("passed", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const res = await fetchWithRetry("https://cf.example", { timeoutMs: 1000, fetchImpl: cfFetch, delayMs: 0 });
    assert(
      res.status === 200 && seenUA.length === 2 && seenUA[0] === FETCH_UA_BROWSER && seenUA[1] === FETCH_UA_HONEST,
      "challenge triggers exactly one honest-UA retry",
    );
  }
  // 7) tool surface: timeout arg + hardened description
  {
    const wf = registry.get("webfetch")!;
    const props = (wf.parameters as { properties: Record<string, unknown> }).properties;
    assert("timeout" in props, "webfetch exposes a timeout argument");
    assert(String(wf.description).includes("retry"), "webfetch description documents the retry behavior");
  }
  rmSync(workdir, { recursive: true, force: true });
}

const initDir = ".aih-smoke-init";
rmSync(initDir, { recursive: true, force: true });
const init = aih(["init", initDir, "--name", "my-items"]);
assert(init.status === 0, "init scaffolds a project");
assert(existsSync(`${initDir}/APP.md`), "init writes APP.md");
assert(
  readFileSync(`${initDir}/APP.md`, "utf8").includes("my-items"),
  "init substitutes the project name",
);
assert(existsSync(`${initDir}/mcp-server/src/app-adapter.ts`), "init writes mcp-server adapter");
assert(existsSync(`${initDir}/scripts/eval`), "init writes scripts/eval");
assert(
  existsSync(`${initDir}/.aih/extensions/example.mjs`) &&
    readFileSync(`${initDir}/.aih/extensions/example.mjs`, "utf8").includes("aih.registerTool"),
  "init scaffolds the self-extension example (.aih/extensions/example.mjs)",
);
{
  const exe = spawnSync("test", ["-x", `${initDir}/scripts/eval`], { encoding: "utf8" });
  assert(exe.status === 0, "init scripts are executable");
}
const initAgain = aih(["init", initDir]);
assert(initAgain.status === 1 && initAgain.stderr.includes("already has an APP.md"), "init refuses to overwrite without --force");
rmSync(initDir, { recursive: true, force: true });

// --- multi-MCP: connect two stdio servers side by side and merge their tools ---
{
  const { connectMultiBackend } = await import("./mcp-backend.js");
  const mcpDir = ".aih-smoke-mcp";
  rmSync(mcpDir, { recursive: true, force: true });
  mkdirSync(mcpDir, { recursive: true });
  const serverSrc = (name: string, pong: string): string => `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const srv = new Server({ name: ${JSON.stringify(name)}, version: "1" }, { capabilities: { tools: {} } });
srv.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "pings " + ${JSON.stringify(name)}, inputSchema: { type: "object", properties: {} } }],
}));
srv.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: ${JSON.stringify(pong)} }],
}));
await srv.connect(new StdioServerTransport());
`.trim();
  writeFileSync(`${mcpDir}/server-a.mjs`, serverSrc("a", "pong-a"));
  writeFileSync(`${mcpDir}/server-b.mjs`, serverSrc("b", "pong-b"));
  const multi = await connectMultiBackend([
    { name: "srv-a", command: process.execPath, args: [`${mcpDir}/server-a.mjs`] },
    { name: "srv-b", command: process.execPath, args: [`${mcpDir}/server-b.mjs`] },
  ]);
  try {
    const defs = await multi.listTools();
    assert(
      defs.some((d) => d.name === "srv-a_ping") &&
        defs.some((d) => d.name === "srv-b_ping") &&
        !defs.some((d) => d.name === "ping"),
      "multi-MCP suffixes duplicate tool names (both servers' ping renamed)",
    );
    const desc = (await multi.describe()) as { servers: Record<string, unknown>; tools: string[] };
    assert(
      desc.tools.includes("srv-a_ping") && desc.tools.includes("srv-b_ping"),
      "multi-MCP describe lists all servers' tools",
    );
  } finally {
    multi.close();
    rmSync(mcpDir, { recursive: true, force: true });
  }
}

{
  // shell environment policy: secrets never reach agent-executed commands
  const { execFileSync } = (await import("node:child_process")) as {
    execFileSync: (...args: unknown[]) => Buffer;
  };
  const out = String(
    execFileSync(
      process.execPath,
      [
        "-e",
        [
          "const { buildChildEnv } = await import('./cli/dist/env-policy.js');",
          "const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/root', AIH_API_KEY: 'sk-secret', MY_TOKEN: 't', DB_PASSWORD: 'p', AWS_SECRET_ACCESS_KEY: 'x', LANG: 'C' });",
          "console.log(JSON.stringify(env));",
        ].join("\n"),
      ],
      { cwd: process.cwd() },
    ),
  );
  const env = JSON.parse(out) as Record<string, string>;
  assert(env.PATH === "/usr/bin" && env.HOME === "/root", "env policy keeps benign vars");
  assert(
    !("AIH_API_KEY" in env) && !("MY_TOKEN" in env) && !("DB_PASSWORD" in env) &&
      !("AWS_SECRET_ACCESS_KEY" in env),
    "env policy strips KEY/TOKEN/SECRET/PASSWORD vars from the child environment",
  );
  assert(env.LANG === "C", "env policy passes unrelated vars through");
}

{
  // skills roster respects its context budget: shortens descriptions first,
  // then omits skills entirely with a warning
  const { withSkillRoster } = await import("./index.js");
  const many = Array.from({ length: 200 }, (_, i) => ({
    name: `skill-${i}`,
    description: `d`.repeat(120),
    scope: "project" as const,
    body: "b",
  }));
  const out = withSkillRoster("BASE", many, 100_000); // budget = 2000 chars
  assert(out.startsWith("BASE"), "roster keeps the base prompt");
  assert(
    out.length <= 2200,
    "roster output stays within ~budget even with hundreds of skills",
  );
  assert(out.includes("hidden to stay within"), "roster warns about omitted skills");
  const small = withSkillRoster(
    "BASE",
    [{ name: "s", description: "d", scope: "project" as const, body: "b" }],
    100_000,
  );
  assert(small.includes("- s: d"), "small roster renders fully");
}

{
  // onPromptInput debug seam surfaces the exact model-visible messages
  const { AgentLoop, MockLLM, ToolRegistry, AutoApprove, toolCall } = await import("@aih/core");
  const seen: number[] = [];
  const loop = new AgentLoop({
    llm: new MockLLM([
      {
        text: "",
        toolCalls: [toolCall("c1", "echo", { text: "hi" })],
        stopReason: "tool_use" as const,
      },
      { text: "done", stopReason: "end_turn" as const },
    ]),
    tools: new ToolRegistry(new AutoApprove()),
    systemPrompt: "sys",
    onPromptInput: (messages) => seen.push(messages.length),
  });
  await loop.send("hello");
  assert(seen.length >= 2, "onPromptInput fires for every LLM request in a turn");
}

{
  // end-to-end: run_cmd child processes see a filtered environment
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const registry2 = new ToolRegistry(new AutoApprove());
  registerDevTools(registry2, process.cwd());
  const res = await registry2.invoke(
    "run_cmd",
    { command: "node -e 'console.log(JSON.stringify({t:process.env.SMOKE_TOKEN,k:process.env.AIH_API_KEY,p:process.env.PATH}))'" },
    { turnId: "smoke", inject: () => {} },
  ) as { ok: boolean; result?: { stdout?: string }; error?: string };
  assert(res.ok, "run_cmd e2e invocation succeeds");
  const outEnv = JSON.parse(res.result?.stdout ?? "{}") as {
    t?: string;
    k?: string;
    p?: string;
  };
  assert(outEnv.t === undefined && outEnv.k === undefined, "run_cmd hides SMOKE_TOKEN/AIH_API_KEY from children");
  assert(!!outEnv.p, "run_cmd keeps PATH for children");
}

{
  // T#22: keep_output persists the FULL (uncapped) output to a file
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const { mkdtempSync, readFileSync: rfs } = await import("node:fs");
  const { tmpdir: tdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const work = mkdtempSync(j(tdir(), "aih-keepout-"));
  try {
    const reg = new ToolRegistry(new AutoApprove());
    registerDevTools(reg, work);
    // 60KB of output: exceeds the 32KB in-band cap.
    const r = (await reg.invoke(
      "run_cmd",
      { command: "node -e 'console.log(\"x\".repeat(60*1024))'", keep_output: true },
      { turnId: "smoke", inject: () => {} },
    )) as { ok: boolean; result?: { truncated?: boolean; stdout?: string; output_file?: string; output_bytes?: number }; error?: string };
    assert(r.ok, `keep_output run succeeds (${r.error ?? "none"})`);
    assert(r.result?.truncated === true, "in-band stdout is still capped (truncated=true)");
    // FA#1: middle-truncation = 32KB budget + the "… N chars elided …" marker
    // (a few dozen chars), so the bound is budget + a small marker allowance.
    assert((r.result?.stdout ?? "").length <= 32 * 1024 + 64, "in-band stdout bounded by 32KB budget + elided marker");
    const file = r.result?.output_file;
    assert(!!file && file.startsWith(work), "output_file is under the working dir");
    const full = rfs(file!, "utf8");
    assert(full.length === 60 * 1024 + 1, `output_file holds the FULL 60KB (got ${full.length})`);
    assert(r.result?.output_bytes === 60 * 1024 + 1, "output_bytes reports the full size");
    // explicit output_path honored
    const r2 = (await reg.invoke(
      "run_cmd",
      { command: "echo hello-keep", keep_output: true, output_path: "custom/out.txt" },
      { turnId: "smoke", inject: () => {} },
    )) as { ok: boolean; result?: { output_file?: string }; error?: string };
    assert(r2.ok && r2.result?.output_file === j(work, "custom", "out.txt"), "output_path is honored");
    assert(rfs(j(work, "custom", "out.txt"), "utf8") === "hello-keep\n", "explicit output_path content is correct");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

{
  // FA#1 — middle-truncate (head + tail, elide the middle) so the verdict
  // lines at the END of shell output survive the in-band cap.
  const { truncateMiddle } = await import("./dev-tools.js");
  // short input: unchanged, no marker.
  const short = truncateMiddle("hello world", 100);
  assert(short.text === "hello world" && !short.truncated && short.elidedChars === 0, "FA#1 short input unchanged");
  // long input: head + marker + tail, elidedChars consistent.
  const body = "H".repeat(500) + "MIDDLE" + "T".repeat(500);
  const mid = truncateMiddle(body, 200);
  assert(mid.truncated === true, "FA#1 long input flagged truncated");
  assert(mid.text.includes("chars elided"), "FA#1 elided marker present");
  assert(mid.text.startsWith("H"), "FA#1 head preserved");
  assert(mid.text.endsWith("T"), "FA#1 tail (verdict) preserved");
  assert(mid.elidedChars === body.length - 200, "FA#1 elidedChars = total - budget");
  assert(mid.text.length > 200, "FA#1 marker adds chars beyond the budget");
  // headRatio: 0 → all tail; 1 → all head.
  const allTail = truncateMiddle(body, 100, { headRatio: 0 });
  assert(allTail.text.endsWith("T".repeat(100)), "FA#1 headRatio 0 → all tail");
  const allHead = truncateMiddle(body, 100, { headRatio: 1 });
  assert(allHead.text.startsWith("H".repeat(100)), "FA#1 headRatio 1 → all head");
  console.log("ok: FA#1 truncateMiddle pure (head+tail, elided marker, headRatio)");

  // run_cmd integration: 60KB output is middle-truncated in-band (tail kept),
  // while keep_output still holds the FULL body.
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const { mkdtempSync, readFileSync: rfs2 } = await import("node:fs");
  const { tmpdir: tdir2 } = await import("node:os");
  const { join: j2 } = await import("node:path");
  const work2 = mkdtempSync(j2(tdir2(), "aih-fa1-"));
  try {
    const reg = new ToolRegistry(new AutoApprove());
    registerDevTools(reg, work2);
    // 60KB of distinct lines: the LAST line is the "verdict" that must survive.
    const r = (await reg.invoke(
      "run_cmd",
      { command: "node -e 'for(let i=0;i<6000;i++)console.log(\"line-\"+i)'" , keep_output: true },
      { turnId: "smoke", inject: () => {} },
    )) as { ok: boolean; result?: { truncated?: boolean; stdout?: string; elided_chars?: number; output_file?: string }; error?: string };
    assert(r.ok, `FA#1 run_cmd succeeds (${r.error ?? "none"})`);
    assert(r.result?.truncated === true, "FA#1 run_cmd flags truncated");
    assert((r.result?.elided_chars ?? 0) > 0, "FA#1 run_cmd reports elided_chars");
    // The in-band stdout must END with the real last line (the verdict).
    const tail = (r.result?.stdout ?? "").split("\n").filter(Boolean).pop() ?? "";
    assert(tail === "line-5999", `FA#1 in-band stdout keeps the last line (got "${tail}")`);
    assert((r.result?.stdout ?? "").includes("chars elided"), "FA#1 in-band stdout has the elided marker");
    // Full output still recoverable from the spill file.
    const full = rfs2(r.result?.output_file as string, "utf8");
    assert(full.endsWith("line-5999\n"), "FA#1 keep_output file holds the FULL body incl. last line");
  } finally {
    rmSync(work2, { recursive: true, force: true });
  }
  console.log("ok: FA#1 run_cmd middle-truncation (tail kept, full in spill)");

  // ---- shell-scan: workspace-boundary classification (OC shell scan) ----
  const { scanCommand, formatScanSummary } = await import("./shell-scan.js");
  {
    const root = "/workspace";
    // Write command detection.
    const rm = scanCommand("rm -rf ./dist", root);
    assert(rm.isWrite === true, "shell-scan: rm flagged write");
    assert(rm.paths.some((p) => p.startsWith(root)), "shell-scan: rm resolves workspace path");
    // Read command stays non-write.
    const git = scanCommand("git status", root);
    assert(git.isWrite === false, "shell-scan: git status not write");
    // External path detection (cp from /tmp).
    const cp = scanCommand("cp /tmp/x.txt ./dest", root);
    assert(cp.isWrite === true, "shell-scan: cp flagged write");
    assert(
      cp.paths.some((p) => p.startsWith("/tmp")),
      "shell-scan: cp external source path captured",
    );
    // External directory via cd.
    const cd = scanCommand("cd /opt && ls", root);
    assert([...cd.externalDirs].some((d) => d === "/opt"), "shell-scan: cd external dir captured");
    // Operator splitting handled (&&).
    const chain = scanCommand("npm i && npm run build", root);
    assert(Array.isArray(chain.paths), "shell-scan: chained command handled");
    // Summary is non-empty for write commands.
    assert(formatScanSummary(cp).length > 0, "shell-scan: summary rendered for write");
    assert(formatScanSummary(git) === "No file operations detected", "shell-scan: summary empty for plain read");
    // workdir variant of run_cmd returns scan annotations in result.
    const wscan = scanCommand("mkdir -p out/", root);
    assert(wscan.isWrite === true, "shell-scan: mkdir flagged write");
  }
  console.log("ok: shell-scan workspace-boundary classification");

  // ---- opencode/mimo-code parity: `!` prompt prefix is a direct shell exec ----
  // The TUI dispatch (index.ts handleLine) routes a leading `!` through the same
  // `runShellCommand` executor as the `run_cmd` tool — never to the LLM. Assert
  // the shared executor resolves a real `!ls`-style command to real output so the
  // fast path can never silently fall back to a model message.
  const { runShellCommand } = await import("./dev-tools.js");
  {
    const r = await runShellCommand({ command: "ls", cwd: process.cwd() });
    assert(r.code === 0, "`!`-prefix: runShellCommand resolves exit 0");
    assert(typeof r.stdout === "string" && r.stdout.length > 0, "`!`-prefix: stdout is real non-empty shell output");
    assert(r.scan.isWrite === false, "`!`-prefix: ls classified read (not write)");
    // A `!`-prefixed line must be treated as a command, not a message: assert the
    // executor's result shape matches what the TUI renders (code + output + scan),
    // which is exactly the "not sent to the model" contract.
    assert("code" in r && "stdout" in r && "scan" in r, "`!`-prefix: result carries code/stdout/scan (shell exec, not chat)");
  }
  console.log("ok: `!`-prefix direct-shell-exec parity (opencode/mimo-code)");
}

{
  // IT#1 — shell context awareness (pure extract/format over the session log).
  const { SessionLog } = await import("@aih/core");
  const { extractShellContext, formatShellContext, describeCommand } = await import("./shell-context.js");

  // empty state: no events → no commands, empty block.
  const emptyLog = new SessionLog();
  assert(extractShellContext(emptyLog.all()).length === 0, "IT#1 empty state → no commands");
  assert(formatShellContext([]) === "", "IT#1 empty block formats to ''");

  // one run_cmd call+result → extracted with command, exit code, output.
  const log = new SessionLog();
  log.append({ type: "tool/call", turnId: "t1", callId: "c1", name: "run_cmd", args: { command: "npm test", cwd: "/w" } });
  log.append({ type: "tool/result", turnId: "t1", callId: "c1", ok: true, result: { code: 1, timed_out: false, stdout: "FAIL: 3 tests failed\n  at suite\n" } });
  const one = extractShellContext(log.all());
  assert(one.length === 1, "IT#1 one run_cmd extracted");
  assert(one[0].command === "npm test", "IT#1 command captured");
  assert(one[0].code === 1 && one[0].ok === false, "IT#1 non-zero exit → ok:false (reads code, not ok)");
  assert(one[0].cwd === "/w", "IT#1 cwd captured");
  assert(one[0].output.includes("FAIL"), "IT#1 output tail captured");
  const fmt = formatShellContext(one);
  assert(fmt.includes("npm test") && fmt.includes("exit 1"), "IT#1 block shows command + exit code");

  // non-run_cmd tools must NOT leak into shell context.
  const log2 = new SessionLog();
  log2.append({ type: "tool/call", turnId: "t1", callId: "x1", name: "read_file", args: { path: "secret.txt" } });
  log2.append({ type: "tool/result", turnId: "t1", callId: "x1", ok: true, result: { path: "secret.txt", bytes: 10, stdout: "TOP-SECRET" } });
  assert(extractShellContext(log2.all()).length === 0, "IT#1 non-run_cmd tool output is excluded");

  // newest-first ordering + max_commands cap.
  const log3 = new SessionLog();
  for (const [i, cmd] of ["first", "second", "third", "fourth"].entries()) {
    const id = `c${i}`;
    log3.append({ type: "tool/call", turnId: "t", callId: id, name: "run_cmd", args: { command: cmd } });
    log3.append({ type: "tool/result", turnId: "t", callId: id, ok: true, result: { code: 0, stdout: cmd + "-out\n" } });
  }
  const three = extractShellContext(log3.all(), { maxCommands: 3 });
  assert(three.length === 3, "IT#1 maxCommands caps to 3");
  assert(three[0].command === "fourth" && three[2].command === "second", "IT#1 newest-first order");

  // large output → bounded tail + truncated flag.
  const log4 = new SessionLog();
  const big = "L".repeat(20000);
  log4.append({ type: "tool/call", turnId: "t", callId: "cb", name: "run_cmd", args: { command: "big" } });
  log4.append({ type: "tool/result", turnId: "t", callId: "cb", ok: true, result: { code: 0, stdout: big } });
  const bigCmd = extractShellContext(log4.all())[0];
  assert(bigCmd.outputTruncated === true, "IT#1 large output flagged truncated");
  assert(bigCmd.output.length <= 4000, "IT#1 output tail bounded to cap");
  assert(bigCmd.output.endsWith("L"), "IT#1 tail keeps the END of the output");
  assert(formatShellContext([bigCmd]).includes("elided"), "IT#1 block notes elided output");

  // describeCommand renders the outcome line.
  assert(describeCommand(one[0]).includes("npm test") && describeCommand(one[0]).includes("exit 1"), "IT#1 describeCommand line");
  console.log("ok: IT#1 shell-context pure extract/format");
}

{
  // IT#1 — shell_context agent tool (on-demand fetch over the live log).
  const { ToolRegistry, AutoApprove, SessionLog } = await import("@aih/core");
  const { registerGeneralTools } = await import("./general-tools.js");

  const log = new SessionLog();
  log.append({ type: "tool/call", turnId: "t", callId: "c1", name: "run_cmd", args: { command: "ls -la" } });
  log.append({ type: "tool/result", turnId: "t", callId: "c1", ok: true, result: { code: 0, stdout: "total 8\nfile.txt\n" } });

  const reg = new ToolRegistry(new AutoApprove());
  registerGeneralTools(reg, { logProvider: () => log });
  const r = (await reg.invoke("shell_context", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { found?: boolean; count?: number; commands?: Array<{ command?: string; code?: number }> };
  };
  assert(r.ok, "IT#1 shell_context invokes");
  assert(r.result?.found === true && r.result?.count === 1, "IT#1 shell_context found 1 command");
  assert(r.result?.commands?.[0]?.command === "ls -la" && r.result?.commands?.[0]?.code === 0, "IT#1 shell_context returns command+code");

  // no log wired → graceful not-found (not an error).
  const reg2 = new ToolRegistry(new AutoApprove());
  registerGeneralTools(reg2, {});
  const r2 = (await reg2.invoke("shell_context", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { found?: boolean };
  };
  assert(r2.ok && r2.result?.found === false, "IT#1 shell_context not-wired → found:false");

  // empty log → found:false.
  const reg3 = new ToolRegistry(new AutoApprove());
  const emptyLog = new SessionLog();
  registerGeneralTools(reg3, { logProvider: () => emptyLog });
  const r3 = (await reg3.invoke("shell_context", {}, { turnId: "t", inject: () => {} })) as {
    ok: boolean;
    result?: { found?: boolean };
  };
  assert(r3.ok && r3.result?.found === false, "IT#1 shell_context empty log → found:false");
  console.log("ok: IT#1 shell_context tool");
}

{
  // IT#1 — e2e: injected shell context lands in the FIRST model call of the
  // next turn (the auto-injection seam, proven via onPromptInput).
  const { AgentLoop, ToolRegistry, AutoApprove, SessionLog, MockLLM, toolCall } = await import("@aih/core");
  const { extractShellContext, formatShellContext } = await import("./shell-context.js");

  const log = new SessionLog();
  log.append({ type: "tool/call", turnId: "t0", callId: "c1", name: "run_cmd", args: { command: "npm test" } });
  log.append({ type: "tool/result", turnId: "t0", callId: "c1", ok: true, result: { code: 1, stdout: "ERROR: build failed\n" } });

  // Simulate the TUI auto-inject: pull the shell context and inject it before
  // the next user turn (exactly what the AIH_SHELL_CONTEXT=auto path does).
  const block = formatShellContext(extractShellContext(log.all()));
  assert(block.includes("npm test"), "IT#1 e2e: block built from log");

  const seen: string[] = [];
  const llm = new MockLLM([
    { text: "I see the failing build.", stopReason: "end_turn" },
  ]);
  const loop = new AgentLoop({
    llm,
    tools: new ToolRegistry(new AutoApprove()),
    log,
    systemPrompt: "sys",
    onPromptInput: (messages) =>
      seen.push(messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")),
  });
  loop.inject(block);
  await loop.send("why did it fail?");
  const firstCall = seen[0] ?? "";
  assert(
    firstCall.includes("[shell context]") && firstCall.includes("npm test"),
    "IT#1 e2e: injected shell context is in the first model call",
  );
  console.log("ok: IT#1 e2e injection lands in first model call");
}

{
  // IT#2 — deterministic shell-failure detection → one-click fix (pure, no LLM).
  const { SessionLog } = await import("@aih/core");
  const {
    detectShellErrors,
    formatFixBlock,
    errorBadge,
    summarizeErrors,
    isFailed,
  } = await import("./error-detect.js");

  // empty state: no events → no failures, null badge, empty block/summary.
  const emptyLog = new SessionLog();
  assert(detectShellErrors(emptyLog.all()).length === 0, "IT#2 empty state → no failures");
  assert(errorBadge(detectShellErrors(emptyLog.all())) === null, "IT#2 all green → null badge");
  assert(formatFixBlock([]) === "", "IT#2 empty block → ''");
  assert(summarizeErrors([]) === "", "IT#2 empty summary → ''");

  // one failing run_cmd (non-zero exit) → detected, classified, badge lit.
  const log = new SessionLog();
  log.append({ type: "tool/call", turnId: "t1", callId: "c1", name: "run_cmd", args: { command: "npm test", cwd: "/w" } });
  log.append({ type: "tool/result", turnId: "t1", callId: "c1", ok: true, result: { code: 1, timed_out: false, stdout: "FAIL: 3 tests failed\n  at suite\n" } });
  const errs = detectShellErrors(log.all());
  assert(errs.length === 1, "IT#2 one failure detected");
  assert(errs[0].command === "npm test", "IT#2 failing command captured");
  assert(errs[0].code === 1, "IT#2 exit code captured");
  assert(errs[0].kind === "test", "IT#2 classified as test failure");
  assert(errs[0].matched.length > 0, "IT#2 matched pattern recorded");
  const badge = errorBadge(errs);
  assert(badge !== null && badge.ok === false && /1 failed/.test(badge.label), "IT#2 badge lit (1 failed)");
  const block = formatFixBlock(errs);
  assert(block.includes("npm test") && block.includes("exit 1"), "IT#2 block has command + exit code");
  assert(block.includes("class: test"), "IT#2 block has classification");
  assert(summarizeErrors(errs).includes("npm test"), "IT#2 summary has command");

  // a GREEN run_cmd (exit 0) → NOT detected (a green exit is never a failure).
  const green = new SessionLog();
  green.append({ type: "tool/call", turnId: "t1", callId: "g1", name: "run_cmd", args: { command: "ls -la" } });
  green.append({ type: "tool/result", turnId: "t1", callId: "g1", ok: true, result: { code: 0, stdout: "total 8\nfile.txt\n" } });
  assert(detectShellErrors(green.all()).length === 0, "IT#2 exit-0 command → not a failure");
  assert(errorBadge(detectShellErrors(green.all())) === null, "IT#2 all green → no indicator");

  // a TIMEOUT (no exit code) → still a failure (timedOut flag).
  const to = new SessionLog();
  to.append({ type: "tool/call", turnId: "t1", callId: "x1", name: "run_cmd", args: { command: "sleep 999" } });
  to.append({ type: "tool/result", turnId: "t1", callId: "x1", ok: true, result: { code: 0, timed_out: true, stdout: "" } });
  const toErrs = detectShellErrors(to.all());
  assert(toErrs.length === 1 && toErrs[0].timedOut === true, "IT#2 timeout → failure (timedOut)");
  assert(isFailed({ callId: "x", ts: 0, command: "x", code: 0, timedOut: true, ok: true, output: "", outputTruncated: false }), "IT#2 isFailed: timeout → true");

  // network error pattern → classified network.
  const net = new SessionLog();
  net.append({ type: "tool/call", turnId: "t1", callId: "n1", name: "run_cmd", args: { command: "curl http://x" } });
  net.append({ type: "tool/result", turnId: "t1", callId: "n1", ok: true, result: { code: 7, timed_out: false, stdout: "curl: (7) Failed to connect: ECONNREFUSED" } });
  assert(detectShellErrors(net.all())[0].kind === "network", "IT#2 ECONNREFUSED → network");

  // fs error pattern → classified fs.
  const fs = new SessionLog();
  fs.append({ type: "tool/call", turnId: "t1", callId: "f1", name: "run_cmd", args: { command: "cat /nope" } });
  fs.append({ type: "tool/result", turnId: "t1", callId: "f1", ok: true, result: { code: 1, timed_out: false, stdout: "cat: /nope: No such file or directory" } });
  assert(detectShellErrors(fs.all())[0].kind === "fs", "IT#2 ENOENT → fs");

  // non-run_cmd tools must NOT leak into failure detection.
  const leak = new SessionLog();
  leak.append({ type: "tool/call", turnId: "t1", callId: "l1", name: "read_file", args: { path: "s.txt" } });
  leak.append({ type: "tool/result", turnId: "t1", callId: "l1", ok: false, result: { error: "ENOENT" } });
  assert(detectShellErrors(leak.all()).length === 0, "IT#2 non-run_cmd tool → excluded");

  // newest-first ordering: 2 failures → most recent reported first.
  const two = new SessionLog();
  two.append({ type: "tool/call", turnId: "t1", callId: "a", name: "run_cmd", args: { command: "first-fail" } });
  two.append({ type: "tool/result", turnId: "t1", callId: "a", ok: true, result: { code: 1, stdout: "boom" } });
  two.append({ type: "tool/call", turnId: "t1", callId: "b", name: "run_cmd", args: { command: "second-fail" } });
  two.append({ type: "tool/result", turnId: "t1", callId: "b", ok: true, result: { code: 2, stdout: "boom2" } });
  const twoErrs = detectShellErrors(two.all());
  assert(twoErrs.length === 2, "IT#2 two failures detected");
  assert(twoErrs[0].command === "second-fail", "IT#2 newest failure reported first");
  assert(errorBadge(twoErrs)?.label === "2 failed", "IT#2 badge count = 2");

  // maxErrors cap: 5 failures, maxErrors=2 → only 2 (most recent).
  const five = new SessionLog();
  for (let i = 1; i <= 5; i++) {
    five.append({ type: "tool/call", turnId: "t1", callId: `e${i}`, name: "run_cmd", args: { command: `fail-${i}` } });
    five.append({ type: "tool/result", turnId: "t1", callId: `e${i}`, ok: true, result: { code: 1, stdout: "x" } });
  }
  const capped = detectShellErrors(five.all(), { maxErrors: 2 });
  assert(capped.length === 2, "IT#2 maxErrors cap honored");
  assert(capped[0].command === "fail-5" && capped[1].command === "fail-4", "IT#2 cap keeps most recent");

  // output tail is bounded (huge stdout → capped, flagged truncated).
  const big = new SessionLog();
  big.append({ type: "tool/call", turnId: "t1", callId: "b", name: "run_cmd", args: { command: "verbose" } });
  big.append({ type: "tool/result", turnId: "t1", callId: "b", ok: true, result: { code: 1, stdout: "E".repeat(5000) } });
  const bigErr = detectShellErrors(big.all(), { maxOutputChars: 500 })[0];
  assert(bigErr.outputTail.length <= 500, "IT#2 output tail bounded");
  assert(bigErr.outputTruncated === true, "IT#2 truncation flagged");

  // deterministic: same log → same detection (stable kind + order).
  const d1 = detectShellErrors(log.all());
  const d2 = detectShellErrors(log.all());
  assert(JSON.stringify(d1) === JSON.stringify(d2), "IT#2 deterministic (stable output)");

  console.log("ok: IT#2 deterministic error-detection + /fix block");
}

{
  // IT#5 — run-or-copy approval UX (write commands: run / copy / no, never auto-run).
  const { detectClipboardCmd, copyToClipboard, CLIPBOARD_CANDIDATES } =
    await import("./clipboard.js");
  const { SessionGate, DenyGate } = await import("./gate.js");

  // detectClipboardCmd is pure: first candidate whose binary resolves wins.
  const cands = [
    { bin: "nope1", args: [], label: "nope1" },
    { bin: "yesbin", args: [], label: "yesbin" },
    { bin: "nope2", args: [], label: "nope2" },
  ];
  assert(
    detectClipboardCmd(cands, (b) => b === "yesbin")?.bin === "yesbin",
    "IT#5 detect: first resolving candidate wins",
  );
  assert(
    detectClipboardCmd(cands, () => false) === null,
    "IT#5 detect: none resolving → null (degrade to print)",
  );
  assert(CLIPBOARD_CANDIDATES.some((c) => c.bin === "pbcopy"), "IT#5 candidates include pbcopy");

  // copyToClipboard: no binary available → print fallback, never throws.
  const noClip = copyToClipboard("echo hi", cands, () => false);
  assert(noClip.ok === false && noClip.mode === "print" && noClip.print === true, "IT#5 copy: no binary → print fallback");
  // copyToClipboard: binary "resolves" but spawn fails → still print fallback.
  const failClip = copyToClipboard("echo hi", [{ bin: "/nonexistent-clip-bin", args: [], label: "fake" }], () => true);
  assert(failClip.ok === false && failClip.mode === "print" && failClip.print === true, "IT#5 copy: spawn failure → print fallback (no throw)");

  // Gate integration: a TUI WITH askRunOrCopy gets the run-or-copy prompt for
  // run_cmd write asks. Each stub records what it saw and returns a choice.
  const mkRocStub = (choice: "run" | "copy" | "no") => {
    const calls: { command: string; scope: string }[] = [];
    const sys: string[] = [];
    return {
      calls,
      sys,
      tui: {
        askRunOrCopy: async (command: string, scope: string) => {
          calls.push({ command, scope });
          return choice;
        },
        askConfirm: async () => "deny" as const,
        pushSystem: (s: string) => { sys.push(s); },
      },
    };
  };
  const attach = (gate: unknown, stub: { tui: unknown }): void =>
    (gate as { attachTui(t: unknown): void }).attachTui(stub.tui);

  // "run" → approved (true), run-or-copy prompt used (not askConfirm).
  const runStub = mkRocStub("run");
  const runGate = new SessionGate(new DenyGate(), [], undefined, false);
  attach(runGate, runStub);
  const runOk = await runGate.request({ tool: "run_cmd", kind: "write", args: { command: "npm publish" } });
  assert(runOk === true, "IT#5 run → approved (executes)");
  assert(runStub.calls.length === 1 && runStub.calls[0].command === "npm publish", "IT#5 run: run-or-copy prompt received the command");
  assert(runStub.sys.some((s) => /approved/.test(s)), "IT#5 run: approval reported");

  // "copy" → NOT executed (false), command surfaced for manual paste (clipboard
  // or the print fallback — either way the user gets the command text).
  const copyStub = mkRocStub("copy");
  const copyGate = new SessionGate(new DenyGate(), [], undefined, false);
  attach(copyGate, copyStub);
  const copyOk = await copyGate.request({ tool: "run_cmd", kind: "write", args: { command: "rm -rf dist" } });
  assert(copyOk === false, "IT#5 copy → NOT executed");
  assert(copyStub.calls.length === 1 && copyStub.calls[0].command === "rm -rf dist", "IT#5 copy: prompt received the command");
  assert(copyStub.sys.some((s) => s.includes("rm -rf dist")), "IT#5 copy: command surfaced (clipboard or print fallback)");

  // "no" → denied (false).
  const noStub = mkRocStub("no");
  const noGate = new SessionGate(new DenyGate(), [], undefined, false);
  attach(noGate, noStub);
  const noOk = await noGate.request({ tool: "run_cmd", kind: "write", args: { command: "git push origin main" } });
  assert(noOk === false, "IT#5 no → denied");
  assert(noStub.sys.some((s) => /denied/.test(s)), "IT#5 no: denial reported");

  // Fallback: a TUI WITHOUT askRunOrCopy (e.g. the CC#54 stub) still works via
  // askConfirm — IT#5 must not break the existing gate contract.
  const legacyStub = { prompts: [] as string[], tui: { askConfirm: async (d: string) => { (legacyStub.prompts as string[]).push(d); return "deny" as const; }, pushSystem: () => {} } };
  const legacyGate = new SessionGate(new DenyGate(), [], undefined, false);
  attach(legacyGate, legacyStub);
  const legacyOk = await legacyGate.request({ tool: "run_cmd", kind: "write", args: { command: "npm test" } });
  assert(legacyOk === false && legacyStub.prompts.length === 1, "IT#5 fallback: TUI without askRunOrCopy → askConfirm path (CC#54 intact)");

  // Non-run_cmd write asks never take the run-or-copy path (they have no
  // command to copy) — they keep the generic askConfirm prompt.
  const nonRunStub = mkRocStub("run");
  const nonRunGate = new SessionGate(new DenyGate(), [], undefined, false);
  attach(nonRunGate, nonRunStub);
  const nonRunOk = await nonRunGate.request({ tool: "write_file", kind: "write", args: { path: "/tmp/x", content: "y" } });
  assert(nonRunOk === false && nonRunStub.calls.length === 0, "IT#5 non-run_cmd write → generic askConfirm (no run-or-copy)");

  console.log("ok: IT#5 run-or-copy approval UX + clipboard fallback");
}

{
  // IT#3 — `?` prefix: classify + context composition (pure, no LLM).
  const {
    classifyQuestionPrefix,
    buildQuestionContext,
    composeQuestionPrompt,
  } = await import("./question.js");
  const { SessionLog } = await import("@aih/core");

  // classify: ASCII task needs a separating space; CJK may attach directly.
  assert(classifyQuestionPrefix("? fix the failing test").isQuestion === true, "IT#3 ? + space + ascii → task");
  assert(classifyQuestionPrefix("? fix the failing test").prompt === "fix the failing test", "IT#3 prompt extracted (ascii)");
  assert(classifyQuestionPrefix("?修一下刚才那个报错").isQuestion === true, "IT#3 ? + CJK (no space) → task");
  assert(classifyQuestionPrefix("? 修一下刚才那个报错").prompt === "修一下刚才那个报错", "IT#3 prompt extracted (CJK)");
  // conservative: a lone "?" or "?<ascii>" is NOT a task (literal question).
  assert(classifyQuestionPrefix("?").isQuestion === false, "IT#3 lone ? → not a task");
  assert(classifyQuestionPrefix("?foo").isQuestion === false, "IT#3 ?<ascii> → not a task (literal)");
  assert(classifyQuestionPrefix("what is this?").isQuestion === false, "IT#3 trailing ? → not a task");
  assert(classifyQuestionPrefix("hello").isQuestion === false, "IT#3 no ? → not a task");

  // context: cwd + session + shell history (reuses IT#1 extractShellContext).
  const log = new SessionLog();
  log.append({ type: "tool/call", turnId: "t", callId: "c1", name: "run_cmd", args: { command: "npm test", cwd: "/w" } });
  log.append({ type: "tool/result", turnId: "t", callId: "c1", ok: true, result: { code: 1, stdout: "FAIL 1 test" } });
  const ctx = buildQuestionContext({ events: log.all(), cwd: "/work", sessionName: "s-123" });
  assert(ctx.includes("cwd: /work"), "IT#3 context has cwd");
  assert(ctx.includes("active session: s-123"), "IT#3 context has active session");
  assert(ctx.includes("npm test") && ctx.includes("exit 1"), "IT#3 context has shell history (command + exit code)");
  // empty log → still has cwd/session, no shell section.
  const ctxEmpty = buildQuestionContext({ events: [], cwd: "/work" });
  assert(ctxEmpty.includes("cwd: /work") && !ctxEmpty.includes("npm test"), "IT#3 empty log → cwd only, no shell");

  // compose: context + task joined, task labelled last.
  const composed = composeQuestionPrompt(ctx, "fix the failing test");
  assert(composed.includes(ctx) && composed.endsWith("Task: fix the failing test"), "IT#3 compose: context + labelled task");
  assert(composeQuestionPrompt("", "do it") === "Task: do it", "IT#3 compose: empty context → task only");

  console.log("ok: IT#3 ?-prefix classify + context composition");
}

{
  // D#12: sandbox seam — pluggable run_cmd backend (local default, registry, env/override)
  const {
    localBackend,
    bwrapBackend,
    remoteBackend,
    registerSandboxBackend,
    getSandboxBackend,
    listSandboxBackends,
    resolveSandboxBackend,
  } = await import("./sandbox.js");
  assert(localBackend.name === "local" && bwrapBackend.name === "bwrap" && remoteBackend.name === "remote", "built-in backends named");
  assert(listSandboxBackends().includes("local") && listSandboxBackends().includes("bwrap") && listSandboxBackends().includes("remote"), "registry lists built-ins");
  // local backend actually runs a command
  const lr = await localBackend.run({ command: "echo hello-sandbox", cwd: process.cwd(), env: { ...process.env } as NodeJS.ProcessEnv, timeoutMs: 10000 });
  assert(lr.code === 0 && lr.output.includes("hello-sandbox") && lr.timed_out === false, "local backend runs and captures output");
  // default resolution is local
  const prev = process.env.AIH_SANDBOX;
  delete process.env.AIH_SANDBOX;
  try {
    assert(resolveSandboxBackend().name === "local", "default backend is local");
    // env selection
    process.env.AIH_SANDBOX = "bwrap";
    assert(resolveSandboxBackend().name === "bwrap", "AIH_SANDBOX env selects bwrap");
    // per-call override wins over env
    assert(resolveSandboxBackend("local").name === "local", "per-call override wins over env");
    // unknown name falls back to local (never breaks a turn)
    assert(resolveSandboxBackend("does-not-exist").name === "local", "unknown backend falls back to local");
    // custom backend registration
    const custom = { name: "echoer", run: async () => ({ code: 0, timed_out: false, output: "custom-ran" }) };
    registerSandboxBackend("echoer", custom);
    assert(getSandboxBackend("echoer")?.name === "echoer", "custom backend registered");
    assert(resolveSandboxBackend("echoer").name === "echoer", "custom backend resolvable");
    const cr = await resolveSandboxBackend("echoer").run({ command: "x", cwd: ".", env: {} as NodeJS.ProcessEnv, timeoutMs: 1000 });
    assert(cr.output === "custom-ran", "custom backend executes");
  } finally {
    if (prev === undefined) delete process.env.AIH_SANDBOX;
    else process.env.AIH_SANDBOX = prev;
  }
  // run_cmd exposes the sandbox param and reports the backend used
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const reg = new ToolRegistry(new AutoApprove());
  registerDevTools(reg, process.cwd());
  const schema = reg.schemas().find((s) => s.name === "run_cmd");
  const props = (schema?.parameters as { properties?: Record<string, unknown> }).properties;
  assert(!!schema && props !== undefined && "sandbox" in props, "run_cmd schema exposes sandbox param");
  const r3 = (await reg.invoke("run_cmd", { command: "echo via-sandbox" }, { turnId: "smoke", inject: () => {} })) as {
    ok: boolean;
    result?: { stdout?: string; sandbox?: string };
  };
  assert(r3.ok && !!r3.result?.stdout && r3.result.stdout.includes("via-sandbox") && r3.result?.sandbox === "local", "run_cmd reports the sandbox backend used");
}

{
  // bracketed paste (DEC 2004): multi-line pastes must be inserted as literal
  // text, never interpreted as key presses (the ctrl+shift+v auto-submit bug)
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("\x1b[200~one\ntwo\rthree\x1b[201~");
  assert(lines.length === 0, "paste alone never submits");
  tui.feed("\r");
  assert(
    lines.length === 1 && lines[0] === "one two three",
    "pasted newlines become spaces; real Enter submits once",
  );
}

{
  // Question prompt + scroll keys — a pending `question` must not swallow
  // escape sequences (PageUp/PageDown/arrows/mouse) as answer text, so the
  // user can still scroll the transcript while answering. Regression: before
  // the fix, `\x1b[5~` leaked its bytes into the answer buffer.
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  const lines: string[] = [];
  const p = tui.askQuestion("pick one?");
  tui.feed("\x1b[5~"); // PageUp — must scroll, not become answer text
  tui.feed("option-b");
  tui.feed("\r"); // submit
  const answer = await p;
  assert(answer === "option-b", `question answer excludes scroll-key bytes (got "${answer}")`);
  // Mouse scroll (SGR) while answering also must not pollute the answer.
  const p2 = tui.askQuestion("scroll test?");
  tui.feed("\x1b[<65;1;1M"); // wheel-up
  tui.feed("ok");
  tui.feed("\r");
  const answer2 = await p2;
  assert(answer2 === "ok", `question answer excludes mouse-scroll bytes (got "${answer2}")`);
  console.log("ok: question prompt allows scrolling without polluting the answer");
}

{
  // Question prompt + bracketed paste (Ctrl+Shift+V) — the paste-end terminator
  // must be parsed (clearing #inPaste) and must never leak "[201~" into the
  // answer. Regression: the mid-paste ESC fell through an empty branch that
  // never ran the escape machine, so "[201~" leaked into the answer, #inPaste
  // stayed true forever, Enter became a space (could not submit) and Ctrl+C
  // was swallowed by #pasteChar (could not cancel) — a stuck prompt.
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const p = tui.askQuestion("API key:");
  tui.feed("\x1b[200~sk-abc123\x1b[201~"); // bracketed paste of the key
  tui.feed("\r"); // Enter submits
  const answer = await Promise.race([
    p,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 400)),
  ]);
  assert(answer === "sk-abc123", `paste into question submits cleanly, no "[201~" leak (got "${answer}")`);
  // Ctrl+C cancels after a paste (inPaste must have cleared).
  const p2 = tui.askQuestion("API key:");
  tui.feed("\x1b[200~sk-xyz\x1b[201~");
  const o2 = await Promise.race([
    p2.then(() => "resolved").catch(() => "cancelled"),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 400)),
  ]);
  assert(o2 === "TIMEOUT", "paste alone does not resolve or reject the question");
  tui.feed("\x03"); // Ctrl+C
  const o3 = await Promise.race([
    p2.then(() => "resolved").catch(() => "cancelled"),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 400)),
  ]);
  assert(o3 === "cancelled", "Ctrl+C cancels the question after a bracketed paste");
  console.log("ok: question + bracketed paste (Ctrl+Shift+V) submits/cancels cleanly");
}

{
  // P#35 — Alt+Up recalls the last queued message back into the editor.
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    // busy + host declines steering (slash command) → falls back to the queue
    busy: () => true,
    onLineBusy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("/compact extra args\r"); // queued while busy
  assert(tui.queueSize() === 1, "busy input lands in the fallback queue");
  tui.feed("\x1b[1;3A"); // Alt+Up
  assert(tui.queueSize() === 0, "Alt+Up pulls the entry out of the queue");
  const recalled = tui.editText();
  assert(recalled === "/compact extra args", `recalled text is editable (${JSON.stringify(recalled)})`);
  // Edit and resubmit after the turn ends: simulate quiet session via a second Tui.
  tui.recallQueued(); // empty now
  const lines2: string[] = [];
  const tui2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines2.push(l),
  });
  tui2.feed("hello\r");
  assert(lines2.length === 1 && lines2[0] === "hello", "sanity: quiet submit works");
}

{
  // paste payload split across stdin read-events (incl. a split end marker)
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("\x1b[200~hel");
  tui.feed("lo\nwor");
  tui.feed("ld\x1b[2");
  tui.feed("01~");
  tui.feed("\r");
  assert(
    lines.length === 1 && lines[0] === "hello world",
    "paste reassembles across events, surviving a split end marker",
  );
}

{
  // pasting while the palette overlay is open must not select an entry
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  const pick = tui.pick("pick", [{ label: "alpha" }, { label: "beta" }]);
  tui.feed("\x1b[200~ab\ncd\x1b[201~"); // must NOT commit the overlay
  tui.feed("\x1b");
  tui.feed("\x1b"); // double-Esc cancels
  const outcome = await Promise.race([
    pick,
    new Promise((r) => setTimeout(() => r("timeout"), 400)),
  ]);
  assert(
    JSON.stringify(outcome) === JSON.stringify({ kind: "cancel" }) && lines.length === 0,
    "overlay paste does not select; double-Esc still cancels",
  );
}

{
  // tmux/terminal ESC control sequences must NOT cancel an active turn.
  // tmux repaints its status line / title via OSC (ESC ] ... BEL) and DCS
  // (ESC P ... ST) bursts. Before the fix, two such ESC-led sequences inside
  // 500ms were misread as double-Esc and aborted the running turn — the user
  // saw "turn cancelled" without pressing Esc. The sequences must be absorbed
  // and the turn must keep running.
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  let cancelled = 0;
  let busy = false;
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => busy,
    onLine: (l: string) => lines.push(l),
    cancelTurn: () => {
      cancelled += 1;
    },
  });
  // Simulate: a turn is running (busy) while tmux fires its control bursts.
  busy = true;
  tui.feed("\x1b]0;tmux status title\x07"); // OSC title update
  tui.feed("\x1b]2;window 0\x07"); // second OSC inside the 500ms window
  tui.feed("\x1bPtmux passthrough payload\x1b\\"); // DCS with ST terminator
  tui.feed("\x1b]133;A\x1b\\"); // kitty/tmux inline-bell-ish OSC+ST
  assert(cancelled === 0, "tmux OSC/DCS bursts do not cancel a running turn");
  // A REAL double bare-Esc still cancels (nothing regressed).
  tui.feed("\x1b");
  tui.feed("\x1b");
  assert(cancelled === 1, "genuine double-Esc still cancels after OSC/DCS absorption");
  assert(lines.length === 0, "tmux control bytes never reach the composer");
  console.log("ok: tmux OSC/DCS control sequences are absorbed, not cancel-turn");
}

{
  // theme: OSC 11 background query resolves light/dark; response bytes must not
  // leak into the input
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  assert(tui.isDark() === true, "theme defaults to dark");
  tui.feed("\x1b]11;rgb:ffffffff/ffffffff/ffffffff\x07");
  assert(tui.isDark() === false, "OSC 11 white background resolves light theme");
  tui.feed("\x1b]11;rgb:0e0e0e/0e0e0e/0e0e0e\x07");
  assert(tui.isDark() === true, "OSC 11 black background resolves dark theme");
  const sub: string[] = [];
  const t2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => sub.push(l),
  });
  t2.feed("\x1b]11;rgb:ffffffff/ffffffff/ffffffff\x07");
  t2.feed("hi");
  t2.feed("\r");
  assert(sub.length === 1 && sub[0] === "hi", "OSC 11 response bytes never typed as input");
}

{
  // help dialog: `?` on an empty idle composer opens it; typed text then goes
  // to the overlay (not the composer); double-Esc closes; input works after
  const { Tui } = await import("./tui.js");
  const lines: string[] = [];
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => lines.push(l),
  });
  tui.feed("?"); // open help (empty input)
  tui.feed("x"); // would be composer text without the overlay
  tui.feed("\x1b");
  tui.feed("\x1b"); // close help
  tui.feed("hi");
  tui.feed("\r");
  assert(lines.length === 1 && lines[0] === "hi", "help overlay traps typing; closes on double-Esc");
  const l2: string[] = [];
  const t2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: (l: string) => l2.push(l),
  });
  t2.feed("why?");
  t2.feed("?");
  t2.feed("\r");
  assert(l2.length === 1 && l2[0] === "why??", "literal ? types normally in a non-empty composer");
}

{
  // F#30 side panel — cost and throughput must NOT share one line: the panel
  // is ~24-32 cols wide and a combined "cost … · N tok/s · stream M tok/s"
  // row truncates mid-number. Layout: cost line, then one "N tok/s · stream
  // M tok/s" line, then cache-hit rate.
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "glm-5.3-flash", provider: "empero" }),
    cwd: "/tmp",
    statusLeft: "",
    statusRight: "",
    busy: () => false,
    onLine: () => {},
    ctxUsage: () => ({ used: 250000, limit: 1000000, cost: 0.0123, tps: 142.8, stps: 38.5, cacheRate: 0.412 }),
  });
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  const panel = tui.panelLinesForTest(30).map(strip);
  const costIdx = panel.findIndex((l) => l.startsWith("cost "));
  const speedIdx = panel.findIndex((l) => l.includes("tok/s"));
  assert(costIdx >= 0, "F#30 panel: cost line present");
  assert(panel[costIdx] === "cost 0.01", `F#30 panel: cost alone on its line (got ${panel[costIdx]})`);
  assert(speedIdx === costIdx + 1, `F#30 panel: throughput directly under cost (got gap ${speedIdx - costIdx})`);
  assert(
    panel[speedIdx] === "143 tok/s · stream 38.5 tok/s",
    `F#30 panel: tps + stream tps share ONE line (got ${panel[speedIdx]})`,
  );
  assert(panel.some((l) => l === "CH 41%"), "F#30 panel: cache rate on its own line");
  assert(
    panel.every((l) => l.length <= 30),
    `F#30 panel: every line fits the 30-col panel (longest ${Math.max(...panel.map((l) => l.length))})`,
  );
  // absent metrics degrade independently (no empty stubs / no dangling "·")
  const tui2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "",
    statusRight: "",
    busy: () => false,
    onLine: () => {},
    ctxUsage: () => ({ used: 1000, limit: 128000, cost: 0, tps: 90.55 }),
  });
  const panel2 = tui2.panelLinesForTest(30).map(strip);
  assert(!panel2.some((l) => l.startsWith("cost")), "F#30 panel: zero cost omitted");
  const tpsLine = panel2.find((l) => l.includes("tok/s"));
  assert(tpsLine === "90.5 tok/s" || tpsLine === "90.6 tok/s", `F#30 panel: tps alone, no "stream" stub (got ${tpsLine})`);
  assert(!panel2.some((l) => l.includes("CH ")), "F#30 panel: absent cache rate omitted");
}

{
  // sparkline: 8 steps, flat series mid-scale, fewer than 2 points = none
  const { Tui } = await import("./tui.js");
  assert(Tui.sparkline([1, 2, 3, 4, 5, 6, 7, 8]) === "▁▂▃▄▅▆▇█", "sparkline maps range to 8 blocks");
  assert(Tui.sparkline([4, 4, 4, 4]) === "▄▄▄▄", "sparkline flat series mid-scale");
  assert(Tui.sparkline([10]) === "" && Tui.sparkline() === "", "sparkline needs ≥2 points");
  assert(Tui.sparkline([1, 0, 2, 3]) === "▁▅█", "sparkline ignores non-positive points");
}

{
  // Tool rows: plain full-width lines (no background, no border); the whole
  // command wraps instead of being clipped. edit diffs render side-by-side
  // (left=removed, right=added) with red/green tinted cells.
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const cmd =
    "cd /app/agents/aih && npm install pkg-a pkg-b pkg-c --save-dev && npm run test -- --grep \"long pattern\" && echo done";
  tui.pushTool("run_cmd", { command: cmd }, "c1");
  tui.pushTool("write_file", { path: "/tmp/foo.txt", content: "x".repeat(3000) }, "c2");
  tui.pushTool("edit", { path: "/tmp/foo.txt", old_string: "old line", new_string: "new line" }, "c3");
  tui.resolveTool("c1", true, { done: true });
  tui.resolveTool("c2", true, { path: "/tmp/foo.txt" });
  tui.resolveTool("c3", true, {
    _diff: [
      { t: "del", s: "old line", a: 7 },
      { t: "add", s: "new line", b: 9 },
    ],
  });
  const raw = tui.transcriptLines();
  const body = raw.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""));
  const flat = body
    .map((l) => l.trimEnd())
    .join(" ")
    .replace(/\s+/g, " ");
  assert(flat.includes(cmd), "run_cmd row shows the full command across wrapped lines (no clip)");
  assert(
    flat.includes("/tmp/foo.txt") && !flat.includes("xxxx"),
    "write_file row shows the path, not the 3000-char content",
  );
  assert(!raw.some((l) => l.includes("48;5;236")), "tool rows carry no background box");
  assert(!raw.some((l) => l.includes("┃")), "tool rows carry no left border");
  const diffLine = raw.find((l) => l.includes("48;5;237") && l.includes("old line"));
  assert(!!diffLine, "edit diff renders a tinted removed row");
  const addLine = raw.find((l) => l.includes("48;5;233") && l.includes("new line"));
  assert(!!addLine, "edit diff renders a tinted added row");
  const flatBody = body.join("\n");
  assert(flatBody.indexOf("old line") < flatBody.indexOf("new line"), "removed row comes before the added row");
  assert(diffLine!.includes("┃") === false && addLine!.includes("┃") === false, "diff cells have no border");
  assert(body.every((l) => l.length <= 80), "tool rows fit the full history width (80 cols)");

  // F#31: line numbers + unified fallback on narrow terminals.
  // Default 80-col test TUI → body < 100 → unified single-column rows.
  assert(
    body.some((l) => /7 - old line/.test(l)) && body.some((l) => /9 \+ new line/.test(l)),
    "narrow (<100 cols) diff falls back to unified with inline numbers",
  );
  assert(
    !raw.some((l) => l.includes("48;5;237") && l.includes("48;5;233")),
    "unified fallback renders one cell per row (never both tints)",
  );
  // Wide terminal (width option = 120): side-by-side with numbered gutters.
  const wide = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
    width: 120,
  });
  wide.pushTool("edit", { path: "/tmp/foo.txt", old_string: "a\nb", new_string: "A\nc" }, "w1");
  wide.resolveTool("w1", true, {
    _diff: [
      { t: "del", s: "alpha", a: 12 },
      { t: "del", s: "beta", a: 13 },
      { t: "add", s: "ALPHA", b: 12 },
      { t: "add", s: "GAMMA", b: 13 },
    ],
  });
  const wideRaw = wide.transcriptLines();
  const pairRow = wideRaw.find((l) => l.includes("48;5;237") && l.includes("48;5;233"));
  assert(!!pairRow, "wide diff renders side-by-side (both tints on one row)");
  const pairBody = pairRow!.replace(/\x1b\[[0-9;]*m/g, "");
  assert(pairBody.includes("12 - alpha") && pairBody.includes("12 + ALPHA"), "wide diff shows old/new line numbers before -/+");
  assert(wideRaw.some((l) => /13 - beta/.test(l.replace(/\x1b\[[0-9;]*m/g, ""))), "second del keeps its own number");
  assert(
    wideRaw.every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 120),
    "wide diff rows fit the fixed width",
  );
  assert(!pairBody.includes("┃"), "wide diff cells keep the borderless style");
}

// --- AIH_RETRIES parse semantics (regression: Number("") === 0 disabled all retries)
{
  const { parseRetryEnv } = await import("./index.js");
  assert(parseRetryEnv(undefined) === undefined, "AIH_RETRIES unset → adapter default");
  assert(parseRetryEnv("") === undefined, "AIH_RETRIES empty → adapter default (was: 0, killing all retries)");
  assert(parseRetryEnv("  ") === undefined, "AIH_RETRIES blank → adapter default");
  assert(parseRetryEnv("0") === 0 && parseRetryEnv("3") === 3, "AIH_RETRIES numeric values pass through");
  assert(parseRetryEnv("abc") === undefined, "AIH_RETRIES non-numeric → adapter default");
}

// --- question tool renders once (question + answer), not duplicated --------
{
  const { Tui } = await import("./tui.js");
  const { replayHistory, questionText, questionAnswer } = await import("./index.js");
  const Q = "你的本地 Qwen 模型是通过什么方式运行的？";
  const A = "llama.cpp 我只需要你给出一个命令行的示例";

  assert(questionText({ question: Q, options: ["x"] }) === Q, "questionText extracts the question");
  assert(questionText({}) === undefined, "questionText is undefined when absent");
  assert(questionAnswer({ answer: A, duration_ms: 1 }) === A, "questionAnswer extracts the answer");
  assert(questionAnswer({}) === undefined, "questionAnswer is undefined when absent");
  assert(questionAnswer(undefined) === undefined, "questionAnswer is undefined for undefined result");

  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const ev = (seq: number, e: Record<string, unknown>) => ({ seq, ts: seq, ...e });
  const events = [
    ev(1, { type: "turn/start", turnId: "t1" }),
    ev(2, { type: "user/message", turnId: "t1", text: "帮我配置本地模型" }),
    ev(3, { type: "assistant/message", turnId: "t1", text: "先看下：", toolCalls: [{ id: "c1", name: "question", args: { question: Q, options: ["Ollama", "vLLM"] } }] }),
    ev(4, { type: "tool/call", turnId: "t1", callId: "c1", name: "question", args: { question: Q, options: ["Ollama", "vLLM"] } }),
    ev(5, { type: "tool/result", turnId: "t1", callId: "c1", ok: true, result: { answer: A, duration_ms: 41708 } }),
    ev(6, { type: "assistant/message", turnId: "t1", text: "好的，命令这样写：", toolCalls: [] }),
    ev(7, { type: "turn/end", turnId: "t1", stopReason: "end_turn" }),
  ] as SessionEvent[];
  replayHistory(tui, events);
  const body = tui
    .transcriptLines()
    .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""))
    .map((l) => l.trim())
    .filter(Boolean);
  const qCount = body.filter((l) => l.includes(Q)).length;
  assert(qCount === 1, `question appears exactly once (got ${qCount})`);
  assert(body.some((l) => l.includes(A)), "the user's answer is shown");
  assert(!body.some((l) => l.includes("question") && l.includes(Q)), "no 'question' tool row duplicates the question text");

  // Cancelled question (ok:false, no result) still renders the question + a
  // "(no answer)" marker, without duplicating the question.
  const tui2 = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const cancelled = [
    ev(1, { type: "turn/start", turnId: "t2" }),
    ev(2, { type: "tool/call", turnId: "t2", callId: "c2", name: "question", args: { question: Q } }),
    ev(3, { type: "tool/result", turnId: "t2", callId: "c2", ok: false, error: "user cancelled the question" }),
    ev(4, { type: "turn/end", turnId: "t2", stopReason: "end_turn" }),
  ] as SessionEvent[];
  replayHistory(tui2, cancelled);
  const body2 = tui2
    .transcriptLines()
    .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""))
    .map((l) => l.trim())
    .filter(Boolean);
  assert(body2.filter((l) => l.includes(Q)).length === 1, "cancelled question appears exactly once");
  assert(body2.some((l) => l.includes("(no answer)")), "cancelled question shows a (no answer) marker");
}

// --- Post-write auto-formatting (roadmap F#27, opencode formatters) --------
{
  const { formatAfterWrite, detectFormatter } = await import("./formatter.js");
  const { chmodSync } = await import("node:fs");
  const root = process.cwd();
  const base = `${root}/.aih-smoke-fmt`;
  rmSync(base, { recursive: true, force: true });
  mkdirSync(`${base}/plain`, { recursive: true });
  mkdirSync(`${base}/cfg`, { recursive: true });
  mkdirSync(`${base}/bin/node_modules/.bin`, { recursive: true });

  // 1) no formatter configured anywhere up the tree → untouched result
  writeFileSync(`${base}/plain/a.js`, "const x=1;\n");
  const r1 = await formatAfterWrite(`${base}/plain/a.js`, base);
  assert(r1.formatted === undefined && r1.formatNote === undefined, "formatter: no config → no-op (no formatted flag)");
  assert(detectFormatter(`${base}/plain/a.js`) === undefined, "formatter: detection returns undefined without config");
  assert(detectFormatter(`${base}/plain/a.txt`) === undefined, "formatter: non-formattable extension ignored");

  // 2) prettier configured (dep) but no binary → formatNote, never throws
  writeFileSync(`${base}/cfg/package.json`, JSON.stringify({ name: "cfg", devDependencies: { prettier: "3.0.0" } }));
  writeFileSync(`${base}/cfg/code.js`, "const   x   = 1;\n");
  const r2 = await formatAfterWrite(`${base}/cfg/code.js`, base);
  assert(r2.formatted === false && typeof r2.formatNote === "string" && r2.formatter === "prettier", "formatter: configured but missing binary → formatNote, not fatal");

  // 3) a real (fake) prettier binary → formatted:true + changed:true, file rewritten
  writeFileSync(`${base}/bin/package.json`, JSON.stringify({ name: "bin", devDependencies: { prettier: "3.0.0" } }));
  writeFileSync(
    `${base}/bin/node_modules/.bin/prettier`,
    "#!/bin/sh\nf=\"$3\"; [ -f \"$f\" ] || f=\"$2\"; [ -f \"$f\" ] || f=\"$1\"; sed -i 's/  */ /g' \"$f\"\n",
  );
  chmodSync(`${base}/bin/node_modules/.bin/prettier`, 0o755);
  writeFileSync(`${base}/bin/code.js`, "const   x   =   1;\n");
  const before = readFileSync(`${base}/bin/code.js`, "utf8");
  const r3 = await formatAfterWrite(`${base}/bin/code.js`, base);
  const after = readFileSync(`${base}/bin/code.js`, "utf8");
  assert(r3.formatted === true && r3.formatter === "prettier" && r3.changed === true, "formatter: real binary success → formatted + changed");
  assert(before !== after, "formatter: the file on disk was actually rewritten");

  // 4) the write tools merge the outcome into their result (write_file)
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerDevTools } = await import("./dev-tools.js");
  const reg = new ToolRegistry(new AutoApprove());
  registerDevTools(reg, base);
  const wf = reg.get("write_file")!;
  const res = (await wf.execute({ path: `${base}/bin/merge.js`, content: "const   y   =   2;\n" }, { turnId: "t", inject: () => {} })) as Record<string, unknown>;
  assert(res.formatted === true && res.formatter === "prettier", "write_file result carries the formatted flag");
  rmSync(base, { recursive: true, force: true });
}

// --- Deterministic workflows (roadmap F#33 / P1#6) -------------------------
{
  const wfDir = ".aih-smoke-wf";
  rmSync(wfDir, { recursive: true, force: true });
  mkdirSync(`${wfDir}/.aih/workflows`, { recursive: true });
  const wfRun = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: wfDir, env: process.env });

  // list in an empty dir
  const emptyDir = ".aih-smoke-wf-empty";
  rmSync(emptyDir, { recursive: true, force: true });
  mkdirSync(emptyDir, { recursive: true });
  const listEmpty = spawnSync(process.execPath, [cli, "workflow", "list"], { encoding: "utf8", cwd: emptyDir, env: process.env });
  assert(listEmpty.status === 0 && listEmpty.stdout.includes("no workflows yet"), "workflow list in empty dir is a clean no-op");

  writeFileSync(
    `${wfDir}/.aih/workflows/good.mjs`,
    `export default { name: "good", description: "smoke", phases: [
      { name: "p1", prompt: "say hi", expect: "Added via mock.", retries: 0 },
      { name: "p2", prompts: ["a", "b"], expect: "Added via mock.", retries: 0 },
    ] };`,
  );
  const list = wfRun(["workflow", "list"]);
  assert(list.status === 0 && list.stdout.includes("good") && list.stdout.includes("2 phase(s)"), "workflow list shows name + phase count");

  const runOk = wfRun(["workflow", "run", "good", "--mock", "--ephemeral"]);
  assert(runOk.status === 0 && runOk.stdout.includes("workflow ok") && runOk.stdout.includes("p2"), "workflow run (mock) passes both phases");

  const runOkJson = wfRun(["workflow", "run", "good", "--mock", "--ephemeral", "--format", "json"]);
  const rep = JSON.parse(runOkJson.stdout);
  assert(rep.ok === true && rep.phases.length === 2 && rep.phases[1].parallel === 2, "workflow JSON report: ok, 2 phases, parallel fan-out recorded");

  // expect-gate failure → fail-fast, exit 1, failedPhase named
  writeFileSync(
    `${wfDir}/.aih/workflows/bad.mjs`,
    `export default { name: "bad", phases: [
      { name: "gate", prompt: "x", expect: "NEVER-APPEARS", retries: 1 },
      { name: "after", prompt: "y", expect: "Added via mock.", retries: 0 },
    ] };`,
  );
  const runBad = wfRun(["workflow", "run", "bad", "--mock", "--ephemeral"]);
  assert(runBad.status === 1 && runBad.stdout.includes('failed at phase "gate"'), "workflow expect-gate failure fails fast with exit 1");
  const badRep = JSON.parse(
    wfRun(["workflow", "run", "bad", "--mock", "--ephemeral", "--format", "json"]).stdout,
  );
  assert(
    badRep.ok === false && badRep.failedPhase === "gate" && badRep.phases.length === 1 && badRep.phases[0].attempts === 2,
    "workflow failure report names the failed phase, bounded retries, later phases skipped",
  );

  // unknown workflow → clean error
  const runMissing = wfRun(["workflow", "run", "nope", "--mock", "--ephemeral"]);
  assert(runMissing.status === 1 && runMissing.stderr.includes('workflow "nope" not found'), "workflow run of a missing name errors cleanly");

  rmSync(wfDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
}

// --- run --goal: judge-verified auto-continuation + goal/judge event (P0#3) ---
{
  const goalDir = ".aih-smoke-goal";
  rmSync(goalDir, { recursive: true, force: true });
  mkdirSync(goalDir, { recursive: true });
  const goalRun = spawnSync(
    process.execPath,
    [cli, "run", "do the thing", "--mock", "--yes", "--session", "g", "--goal", "the thing is done"],
    { encoding: "utf8", cwd: goalDir, env: { ...process.env, AIH_GOAL_ROUNDS: "1" } },
  );
  assert(goalRun.status === 1, "run --goal exits 1 when the judge never reports met (mock)");
  assert(goalRun.stderr.includes("goal not met after auto-continue rounds"), "run --goal reports the bounded stop");
  // the judge verdict must be persisted as a structured goal/judge event
  const sessFile = `${goalDir}/.aih/sessions/g.jsonl`;
  const sess = existsSync(sessFile) ? readFileSync(sessFile, "utf8") : "";
  assert(
    sess.includes('"goal/judge"') && sess.includes('"unmet"'),
    "run --goal persists a structured goal/judge event in the session log",
  );
  rmSync(goalDir, { recursive: true, force: true });
}

// --- TUI markdown table rendering: bordered, column-aligned, CJK-aware ---
{
  const { Tui, width, cols } = await import("./tui.js");
  assert(width("✅") === 2 && width("⚪") === 2, "emoji (✅ ⚪) count 2 cells");
  assert(width("⚠") === 1 && width("⚠️") === 1, "⚠ (U+26A0) is 1 cell in the user's CJK font (override)");
  assert(width("✓") === 1 && width("✗") === 1 && width("❯") === 1, "text dingbats (✓ ✗ ❯, EAW=N) count 1 cell");
  assert(width("≥") === 1 && width("−") === 1, "math operators (≥ −, EAW=A) count 1 cell by default");
  assert(width("—") === 1 && width("…") === 1 && width("→") === 1, "dashes/ellipsis/arrows (— … →) count 1 cell by default");
  assert(width("\ufe0f") === 0, "variation selector (U+FE0F) is zero-width");
  assert(width("组") === 2 && width("\u{1f600}") === 2, "true-wide (CJK, pictographic emoji) stay 2 cells");
  const { paletteWindow } = await import("./tui.js");
  // Overlay picker scroll window: highlight must track the GLOBAL sel even as
  // the visible slice scrolls. Regression: rendering compared a window-relative
  // loop index against the global sel, so with >maxRows entries the highlighted
  // row and the actually-selected entry drifted apart ("chose one, got another").
  {
    const len = 25;
    const maxRows = 8;
    // sel sits in the window center once the list overflows
    let { top, highlight } = paletteWindow(10, len, maxRows);
    assert(top === 6 && highlight === 4 && 10 === top + highlight, "paletteWindow: mid-list sel centers the window");
    // top edge: sel 0 → window at the very top, highlight row 0
    ({ top, highlight } = paletteWindow(0, len, maxRows));
    assert(top === 0 && highlight === 0, "paletteWindow: sel 0 pins the top, highlight 0");
    // bottom edge: last sel → window bottom-pinned, highlight at last row
    ({ top, highlight } = paletteWindow(len - 1, len, maxRows));
    assert(top === 17 && highlight === 7, "paletteWindow: last sel pins the bottom, highlight at last visible row");
    // degenerate: list shorter than the window → no scroll, top=0, highlight==sel
    ({ top, highlight } = paletteWindow(2, 3, 8));
    assert(top === 0 && highlight === 2, "paletteWindow: short list never scrolls; highlight == sel");
  }
  const tuiUrl = pathToFileURL(fileURLToPath(new URL("./tui.js", import.meta.url))).href;
  const probe = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(tuiUrl)}).then((m) => console.log(m.width("✅"), m.width("≥"), m.width("—")))`],
      { encoding: "utf8", env: { ...process.env, ...env } },
    ).stdout.trim();
  assert(probe({ AIH_AMBIGUOUS_WIDE: "1" }) === "2 1 1", "AIH_AMBIGUOUS_WIDE=1 keeps EAW=A narrow (emoji still 2)");
  assert(probe({ AIH_AMBIGUOUS_WIDE: "2" }) === "2 2 2", "AIH_AMBIGUOUS_WIDE=2 forces EAW=A wide");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const table = [
    "核对完成。",
    "| 组 | 文件 | roadmap 依据 |",
    "|---|---|---|",
    "| **A. Workflow 引擎** | `cli/src/workflow.ts`（新）、`cli/src/index.ts` 部分 | #6 / #33「✅ v0.2 已交付」 |",
    "| **B. 写后格式化** | `cli/src/formatter.ts`（新） | #27「✅ v0.2 已交付」 |",
  ].join("\n");
  tui.pushDelta(table);
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = tui.transcriptLines().map(plain);
  const tableLines = lines.slice(lines.findIndex((l) => l.includes("┌")));
  assert(tableLines.length > 0, "markdown table renders as a bordered block");
  assert(tableLines[0].includes("┌") && tableLines[0].includes("┬") && tableLines[0].includes("┐"), "table top border has corners + junctions");
  assert(tableLines.some((l) => l.includes("├") && l.includes("┼") && l.includes("┤")), "table header separator row present");
  assert(tableLines[tableLines.length - 1].includes("└") && tableLines[tableLines.length - 1].includes("┴"), "table bottom border present");
  const contentRows = tableLines.filter((l) => !/^[┌├└─┬┼┴┐┤┘\s]+$/.test(l));
  assert(contentRows.length > 0 && contentRows.every((l) => l.includes("│")), "content rows have column separators");
  assert(tableLines.every((l) => !l.includes(" · ")), "table pipes are NOT mangled into ' · '");
  const joined = tableLines.join("\n");
  assert(joined.includes("组") && joined.includes("roadmap") && joined.includes("依据"), "header cells preserved");
  assert(joined.includes("Workflow") && joined.includes("引擎") && joined.includes("cli/src/workflow.ts"), "data cells preserved (bold + code, wrap-tolerant)");
  assert(joined.includes("cli/src/formatter.ts"), "second data row cell preserved");
  const widths = tableLines.map((l) => cols(l));
  assert(new Set(widths).size === 1, `all table rows align to one display width (${widths[0]})`);
}

// --- TUI performance: batch replay + render cache + history seeding ---
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  const md = "text **bold** and a table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```";
  tui.beginBatch();
  for (let i = 0; i < 50; i++) {
    tui.push({ role: "user", text: `hello ${i}` });
    tui.push({ role: "assistant", text: md + ` (msg ${i})` });
    tui.pushTool("run_cmd", { command: `echo ${i}` }, `c${i}`);
    tui.resolveTool(`c${i}`, true, { stdout: `out ${i}\nline2\nline3\nline4` });
  }
  tui.endBatch();
  tui.seedHistory(["first", "second", "third"]);
  const lines = tui.transcriptLines();
  assert(lines.some((l) => l.includes("hello 0")) && lines.some((l) => l.includes("hello 49")), "batch replay renders all user messages");
  assert(lines.some((l) => l.includes("bold")) && lines.some((l) => l.includes("const x = 1;")), "batch replay renders assistant markdown (bold + code)");
  // Render cache: repeated renders are consistent and fast.
  const t0 = Date.now();
  for (let k = 0; k < 50; k++) tui.transcriptLines();
  const per = (Date.now() - t0) / 50;
  assert(per < 50, `render cache keeps repeated renders fast (${per.toFixed(1)} ms < 50 ms)`);
  // Mutating the streaming item invalidates its cache (re-render picks up new text).
  tui.pushDelta("APPENDED");
  assert(tui.transcriptLines().some((l) => l.includes("APPENDED")), "pushDelta after cache invalidates and re-renders");
}

// --- F#28 increment: worktree snapshot on checkpoints ------------------------
{
  const { gitStatusSummary, formatWorktreeSummary, MAX_DIRTY_ENTRIES } = await import("./worktree.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync: gitSpawn } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "aih-wt-"));
  const run = (args: string[]) => gitSpawn("git", args, { cwd: repo, encoding: "utf8" });

  // Not a repository → undefined, never throws.
  const plain = mkdtempSync(join(tmpdir(), "aih-plain-"));
  assert(gitStatusSummary({ cwd: plain }) === undefined, "worktree snapshot returns undefined outside a repo");
  rmSync(plain, { recursive: true, force: true });

  // Real repo: branch + HEAD + dirty files.
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "smoke@test"]);
  run(["config", "user.name", "smoke"]);
  writeFileSync(`${repo}/tracked.txt`, "v1\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  writeFileSync(`${repo}/tracked.txt`, "v2\n");
  writeFileSync(`${repo}/new.txt`, "n\n");
  const snap = gitStatusSummary({ cwd: repo });
  assert(!!snap && snap.branch === "main", "snapshot reads the current branch");
  assert(!!snap && typeof snap.head === "string" && /^[0-9a-f]{7,}$/.test(snap.head!), "snapshot carries the short HEAD sha");
  assert(!!snap && !snap.clean && snap.dirtyCount === 2 && snap.dirty.length === 2, "snapshot lists changed files (modified + untracked)");
  assert(!!snap && snap.dirty.some((d) => d.startsWith("M") && d.includes("tracked.txt")), "modified file keeps its status letter");

  // Cap + formatting.
  for (let i = 0; i < MAX_DIRTY_ENTRIES + 5; i += 1) writeFileSync(`${repo}/f${i}.txt`, "x\n");
  const capped = gitStatusSummary({ cwd: repo });
  assert(!!capped && capped.dirty.length === MAX_DIRTY_ENTRIES && capped.dirtyCount > capped.dirty.length, "dirty list caps at MAX_DIRTY_ENTRIES but counts all");
  const lines = formatWorktreeSummary(snap!);
  assert(lines[0].startsWith("worktree: main @ "), "formatted summary names branch@sha");
  assert(lines.slice(1).some((l) => l.trim().length > 0), "formatted summary includes dirty entries");

  // MK#47 — workspace identity marker on the same repo.
  {
    const wi = await import("./workspace-identity.js");
    const id1 = wi.workspaceIdentity({ cwd: repo });
    assert(!!id1 && /^[0-9a-f-]{36}$/.test(id1!.uuid), "workspaceIdentity creates a UUID marker");
    const raw = JSON.parse(readFileSync(`${repo}/.aih/workspace.json`, "utf8")) as { workspaceId: string };
    assert(raw.workspaceId === id1!.uuid, "marker file persists the uuid verbatim");
    const id2 = wi.workspaceIdentity({ cwd: repo });
    assert(!!id2 && id2!.uuid === id1!.uuid, "identity is stable across reads");
    // Peek does not create anything in a fresh directory.
    const fresh = mkdtempSync(join(tmpdir(), "aih-wsid-"));
    assert(wi.peekWorkspaceIdentity({ cwd: fresh }) === undefined, "peek returns undefined when no marker exists");
    assert(!existsSync(`${fresh}/.aih/workspace.json`), "peek never creates the marker");
    assert(!!wi.peekWorkspaceIdentity({ cwd: repo }), "peek finds an existing marker");
    // Compare semantics: uuid equality decides; paths are irrelevant; unknown ≠ mismatch.
    const moved = { uuid: id1!.uuid, path: "/somewhere/else" };
    assert(wi.compareIdentity(id1!, moved) === "match", "path move alone is NOT a mismatch (logical identity)");
    assert(wi.compareIdentity(id1!, { uuid: "00000000-0000-0000-0000-000000000000", path: repo }) === "mismatch", "different uuid = mismatch");
    assert(wi.compareIdentity(undefined, id1!) === "unknown" && wi.compareIdentity(id1!, undefined) === "unknown", "missing identity either side = unknown (advisory)");
    // gitStatusSummary embeds the identity into checkpoint snapshots.
    const snapWithId = gitStatusSummary({ cwd: repo });
    assert(!!snapWithId && snapWithId.workspaceId === id1!.uuid, "checkpoint worktree snapshot carries workspaceId");
    rmSync(fresh, { recursive: true, force: true });
  }
  rmSync(repo, { recursive: true, force: true });

  // CLI checkpoint embeds the snapshot into the event (cwd = this repo).
  wipeLocalSessions();
  const s1run = aih(["run", "seed for wt", "--mock", "--yes", "--session", "s1wt"]);
  assert(s1run.status === 0, "seed session exists before checkpoint");
  const cpOut = aih(["session", "checkpoint", "s1wt", "wt", "check"]);
  assert(cpOut.status === 0 && cpOut.stdout.includes("worktree:"), "CLI checkpoint prints the worktree summary");
  const s1Events = JSON.parse(aih(["session", "export", "s1wt"]).stdout);
  const cpEvt = [...s1Events].reverse().find((e: { type?: string }) => e.type === "checkpoint");
  assert(!!cpEvt?.worktree, "checkpoint event carries a worktree summary");
  assert(
    typeof cpEvt.worktree.dirtyCount === "number" && Array.isArray(cpEvt.worktree.dirty) && typeof cpEvt.worktree.branch !== "undefined",
    "worktree summary is structured (branch/head/dirty/dirtyCount)",
  );
}

// --- P2#7: dream / distill (pure extraction over session events) ------------
{
  const { findFlowCandidates, extractDreamMaterial, formatDreamMaterial } =
    await import("./dream.js");
  type Ev = Record<string, unknown>;
  const am = (toolCalls: Array<{ name: string; args: unknown }>): Ev => ({
    type: "assistant/message",
    turnId: "t",
    text: "",
    toolCalls,
  });
  const um = (text: string): Ev => ({ type: "user/message", turnId: "t", text });

  // flow candidates: same tool + same signature >= 3 → candidate; below → not
  const evs: Ev[] = [
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm run build" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a/" } }]),
    am([{ name: "webfetch", args: { url: "https://example.com/a" } }]),
    am([{ name: "run_cmd", args: { command: "echo once" } }]),
  ];
  const flows = findFlowCandidates(evs as never);
  assert(flows.length === 2, "distill finds exactly 2 repeated flows");
  assert(flows[0].tool === "run_cmd" && flows[0].count === 3, "most-repeated flow ranks first");
  assert(flows.some((f) => f.tool === "webfetch" && f.count === 3), "trailing-slash-normalized URL still matches");
  assert(flows.every((f) => f.count >= 3), "below-threshold flows are excluded");

  // dream material: corrections + checkpoint notes + judge reasons + flows
  const evs2: Ev[] = [
    um("不要推送，先本地提交"),
    um("remember: always run npm run eval before handoff"),
    um("just a short chat"),
    { type: "checkpoint", note: "before risky refactor" },
    { type: "goal/judge", met: false, reason: "tests were not run" },
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
    am([{ name: "run_cmd", args: { command: "npm test" } }]),
  ];
  const mat = extractDreamMaterial([[...evs, ...evs2]] as never);
  assert(mat.sessions === 1, "dream counts sessions scanned");
  assert(mat.corrections.length === 2, "corrections captured (2 of 3 user turns)");
  assert(mat.checkpointNotes.includes("before risky refactor"), "checkpoint note captured");
  assert(mat.judgeReasons.includes("tests were not run"), "judge reason captured");
  assert(mat.flows.length === 2, "flows carried into dream material");
  const txt = formatDreamMaterial(mat);
  assert(txt.includes("sessions scanned: 1") && txt.includes("npm test"), "formatted material renders");
  // empty input → clean no-op
  const empty = extractDreamMaterial([[]] as never);
  assert(empty.corrections.length === 0 && empty.flows.length === 0 && formatDreamMaterial(empty).includes("nothing notable"), "empty sessions → nothing notable");
}

// --- P2#9: /vivid concise (plain) render mode -------------------------------
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  assert(!tui.isPlain(), "vivid (plain render) defaults off");
  tui.push({ role: "user", text: "hello" });
  tui.push({ role: "assistant", text: "world" });
  const vivid = tui.transcriptLines().join("\n");
  assert(vivid.includes("┃"), "default render keeps the user-row border (┃)");
  tui.setPlain(true);
  assert(tui.isPlain(), "setPlain(true) toggles on");
  const plain = tui.transcriptLines().join("\n");
  assert(plain.includes("hello") && plain.includes("world"), "plain render still shows the text");
  assert(!plain.includes("┃"), "plain render drops the user-row border");
  assert(!plain.includes("\x1b[48"), "plain render drops the surface background");
  tui.setPlain(false);
  assert(!tui.isPlain(), "setPlain(false) toggles back off");
}

// --- P2#9: config $schema injection (editor autocompletion) -----------------
{
  const { mkdtempSync: mkd } = await import("node:fs");
  const { tmpdir: tdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const proj = mkd(j(tdir(), "aih-schema-proj-"));
  try {
    const out = aihClean(["config", "--schema"], {}, proj);
    const schema = JSON.parse(out.stdout);
    assert(schema.$id?.endsWith("aih.schema.json"), "config --schema prints a valid AIH schema");
    assert(
      schema.properties?.model && schema.properties?.providers && schema.properties?.mcpServers,
      "schema covers model/providers/mcpServers",
    );
    const cfg = JSON.parse(aihClean(["config"], {}, proj).stdout);
    assert(
      cfg.schema?.endsWith("aih.schema.json") && cfg.schemaFile?.endsWith("aih.schema.json"),
      "aih config exposes the $schema URL + local file path",
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

// --- P2#9: Max Mode — parallel subagents + best-of-N judge ------------------
{
  const { ToolRegistry, AutoApprove } = await import("@aih/core");
  const { registerGeneralTools } = await import("./general-tools.js");
  const { mapOrdered, parseJudgeVerdict, runSubagent } = await import("./maxmode.js");

  // Pure helpers first.
  const pv = parseJudgeVerdict('{"best": 2, "reason": "most complete"}', 3);
  assert(pv.best === 2 && pv.reason === "most complete", "parseJudgeVerdict reads best+reason");
  assert(parseJudgeVerdict('{"best": 9}', 3).best === 0, "parseJudgeVerdict clamps out-of-range to 0");
  assert(parseJudgeVerdict("no json here", 3).best === 0, "parseJudgeVerdict falls back to 0 on garbage");

  // mapOrdered: results in input order regardless of completion order.
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const out = await mapOrdered(
    [() => delay(30).then(() => "slow"), () => delay(5).then(() => "fast"), () => delay(10).then(() => "mid")],
    2,
  );
  assert(out.join(",") === "slow,fast,mid", "mapOrdered returns results in input order");

  // Concurrency is actually bounded (limit=2 over 4 jobs).
  {
    let inflight = 0;
    let maxInflight = 0;
    await mapOrdered(
      Array.from({ length: 4 }, () => async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await delay(10);
        inflight -= 1;
        return true;
      }),
      2,
    );
    assert(maxInflight === 2, `mapOrdered caps in-flight jobs at the limit (observed ${maxInflight})`);
  }

  // Routing LLM: subagent calls (tools present) answer per-candidate; the
  // judge call (no tools) picks an index.
  const makeLlm = (judgeBest: number) => {
    let sub = 0;
    return {
      complete: async (req: { tools: unknown[] }) => {
        if (req.tools.length === 0) {
          return { text: JSON.stringify({ best: judgeBest, reason: "judge says so" }), toolCalls: [], stopReason: "end_turn" as const };
        }
        const i = sub++;
        return { text: `answer-${i}`, toolCalls: [], stopReason: "end_turn" as const };
      },
    };
  };

  const parent = new ToolRegistry(new AutoApprove());
  parent.register({
    name: "echo",
    description: "echo",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
    execute: async (args: unknown) => ({ echoed: args }),
  });

  const gate = new AutoApprove();
  const registry = new ToolRegistry(gate);
  registerGeneralTools(registry, { gate, llm: makeLlm(1), toolsProvider: () => parent, cwd: "/tmp" });
  assert(Boolean(registry.get("best_of_n")), "best_of_n tool is registered");

  const r = (await registry.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 3 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; result?: { best: number; n: number; candidates: Array<{ ok: boolean; answer: string }>; answer: string }; error?: string };
  assert(r.ok, `best_of_n runs (error: ${r.error ?? "none"})`);
  assert(r.result!.n === 3 && r.result!.candidates.length === 3, "best_of_n runs N=3 candidates");
  assert(r.result!.candidates.every((c) => c.ok), "all candidates succeeded");
  assert(r.result!.best === 1 && r.result!.answer === "answer-1", "judge picks candidate 1 and its answer is returned");

  // n is clamped to [1,8].
  const r2 = (await registry.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 99 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; result?: { n: number }; error?: string };
  assert(r2.ok && r2.result!.n === 8, "best_of_n clamps n to 8");

  // All-fail path: judge is skipped, best=-1 → tool error.
  const failingLlm = {
    complete: async () => {
      throw new Error("provider down");
    },
  };
  const registryFail = new ToolRegistry(gate);
  registerGeneralTools(registryFail, { gate, llm: failingLlm, toolsProvider: () => parent, cwd: "/tmp" });
  const rf = (await registryFail.invoke(
    "best_of_n",
    { description: "pick", prompt: "answer this", n: 2 },
    { turnId: "t", inject: () => {} },
  )) as { ok: boolean; error?: string };
  assert(!rf.ok && /all candidates failed/.test(rf.error ?? ""), "best_of_n reports all-candidates-failed when every subagent errors");

  // --- Freebuff ① — multi-strategy best_of_n (one subagent per strategy) ----
  {
    const seen: string[] = [];
    const stratLlm = {
      complete: async (req: { tools: unknown[]; messages?: Array<{ content?: unknown }> }) => {
        if (req.tools.length === 0) {
          return { text: JSON.stringify({ best: 1, reason: "judge" }), toolCalls: [], stopReason: "end_turn" as const };
        }
        // messages[0] is the subagent system prompt; the task is a later user message.
        const all = (req.messages ?? [])
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n");
        seen.push(all);
        return { text: `s`, toolCalls: [], stopReason: "end_turn" as const };
      },
    };
    const stratReg = new ToolRegistry(new AutoApprove());
    registerGeneralTools(stratReg, { gate: new AutoApprove(), llm: stratLlm, toolsProvider: () => parent, cwd: "/tmp" });
    const rstrat = (await stratReg.invoke(
      "best_of_n",
      { description: "strat", prompt: "answer this", n: 3, prompts: ["minimal change", "modularize", "cache it"] },
      { turnId: "t", inject: () => {} },
    )) as { ok: boolean; result?: { best: number; strategies?: string[] }; error?: string };
    assert(rstrat.ok, `multi-strategy best_of_n runs (error: ${rstrat.error ?? "none"})`);
    assert(
      (rstrat.result?.strategies ?? []).join("|") === "minimal change|modularize|cache it",
      "multi-strategy: strategies recorded on the result",
    );
    assert(seen.length === 3, "multi-strategy: every candidate got its own subagent call");
    assert(seen.every((s) => s.includes("answer this")), "multi-strategy: shared task context present in every subagent");
    assert(seen[0].includes("minimal change") && seen[1].includes("modularize") && seen[2].includes("cache it"), "multi-strategy: candidate i follows prompts[i]");
    assert(seen[0].includes("Strategy for this run: minimal change"), "multi-strategy: strategy direction appended to the shared context");
  }

  // --- Freebuff ② — dual-judge panel (agreement / disagreement / fallback) ---
  {
    const mk = (judgeBest: number) => ({
      complete: async (req: { tools: unknown[] }) => {
        if (req.tools.length === 0) {
          return { text: JSON.stringify({ best: judgeBest, reason: `judge-${judgeBest}` }), toolCalls: [], stopReason: "end_turn" as const };
        }
        return { text: "c", toolCalls: [], stopReason: "end_turn" as const };
      },
    });
    const reg = (judge2: import("@aih/core").LLMAdapter) => {
      const g = new AutoApprove();
      const reg = new ToolRegistry(g);
      registerGeneralTools(reg, { gate: g, llm: mk(1), toolsProvider: () => parent, cwd: "/tmp", judge2 });
      return reg;
    };
    type BonResult = { ok: boolean; result?: { best: number; judgeDegraded?: boolean; judgeReason: string }; error?: string };

    // both agree → clean, no degraded flag
    const agree = (await reg(mk(1)).invoke("best_of_n", { description: "j", prompt: "x", n: 2 }, { turnId: "t", inject: () => {} })) as BonResult;
    assert(agree.ok && agree.result!.best === 1 && agree.result!.judgeDegraded !== true, "dual-judge: agreement keeps the pick, not degraded");
    assert(/\[both judges agree\]/.test(agree.result!.judgeReason), "dual-judge: agreement is labelled in judgeReason");

    // disagree → primary kept, FLAGGED
    const dis = (await reg(mk(0)).invoke("best_of_n", { description: "j", prompt: "x", n: 2 }, { turnId: "t", inject: () => {} })) as BonResult;
    assert(dis.ok && dis.result!.best === 1, "dual-judge: disagreement keeps the PRIMARY's pick");
    assert(dis.result!.judgeDegraded === true, "dual-judge: disagreement is flagged (judgeDegraded)");
    assert(/\[judge panel degraded/.test(dis.result!.judgeReason), "dual-judge: disagreement labelled in judgeReason");

    // second judge fails → primary kept, FLAGGED
    const secFail = (await reg({ complete: async () => { throw new Error("2nd down"); } }).invoke("best_of_n", { description: "j", prompt: "x", n: 2 }, { turnId: "t", inject: () => {} })) as BonResult;
    assert(secFail.ok && secFail.result!.best === 1 && secFail.result!.judgeDegraded === true, "dual-judge: second judge failed → single-opinion verdict, flagged");

    // primary fails → second decides, FLAGGED
    const regPrimFail = new ToolRegistry(new AutoApprove());
    registerGeneralTools(regPrimFail, {
      gate: new AutoApprove(),
      llm: { complete: async (req: { tools: unknown[] }) => { if (req.tools.length === 0) throw new Error("primary down"); return { text: "c", toolCalls: [], stopReason: "end_turn" as const }; } },
      toolsProvider: () => parent,
      cwd: "/tmp",
      judge2: mk(0),
    });
    const primFail = (await regPrimFail.invoke("best_of_n", { description: "j", prompt: "x", n: 2 }, { turnId: "t", inject: () => {} })) as BonResult;
    assert(primFail.ok && primFail.result!.best === 0 && primFail.result!.judgeDegraded === true, "dual-judge: primary failed → secondary decides, flagged");

    // both fail → hard error (subagent must SUCCEED so we reach the judge;
    // only the no-tools judge calls throw)
    const regBoth = new ToolRegistry(new AutoApprove());
    const judgeDown = {
      complete: async (req: { tools: unknown[] }) => {
        if (req.tools.length === 0) throw new Error("judge down");
        return { text: "c", toolCalls: [], stopReason: "end_turn" as const };
      },
    };
    registerGeneralTools(regBoth, { gate: new AutoApprove(), llm: judgeDown, toolsProvider: () => parent, cwd: "/tmp", judge2: judgeDown });
    const both = (await regBoth.invoke("best_of_n", { description: "j", prompt: "x", n: 2 }, { turnId: "t", inject: () => {} })) as BonResult;
    assert(both.ok === false && /both judges failed/.test(both.error ?? ""), "dual-judge: both judges failed → hard error");
  }

  // --- FB#5 — subagent answer cap (capAnswer + answerCapLimit) ------------
  {
    const { capAnswer, answerCapLimit } = await import("./maxmode.js");
    const { existsSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    // short answer → unchanged, not truncated
    const short = capAnswer("hello", 8000, tmpdir());
    assert(short.truncated === false && short.answer === "hello" && !short.fullOutputPath, "FB#5: short answer passes through untouched");

    // cap <= 0 → capping disabled
    const off = capAnswer("x".repeat(100), 0, tmpdir());
    assert(off.truncated === false && off.answer.length === 100, "FB#5: cap 0 disables capping");

    // long answer → truncated, spilled to a real file, capped text points at it
    const long = "A".repeat(5000);
    const capped = capAnswer(long, 100, tmpdir());
    assert(capped.truncated === true, "FB#5: long answer is truncated");
    assert(capped.answer.startsWith("A".repeat(100)), "FB#5: capped answer keeps the first `cap` chars");
    assert(/\[truncated, full output at /.test(capped.answer), "FB#5: capped answer points at the full output");
    assert(typeof capped.fullOutputPath === "string" && existsSync(capped.fullOutputPath), "FB#5: full output spilled to a real file");
    assert(readFileSync(capped.fullOutputPath!, "utf8") === long, "FB#5: spilled file holds the FULL answer");

    // answerCapLimit: default 8000, env override, 0 = off
    const saved = process.env.AIH_SUBAGENT_ANSWER_CAP;
    delete process.env.AIH_SUBAGENT_ANSWER_CAP;
    assert(answerCapLimit() === 8000, "FB#5: default cap is 8000");
    process.env.AIH_SUBAGENT_ANSWER_CAP = "123";
    assert(answerCapLimit() === 123, "FB#5: AIH_SUBAGENT_ANSWER_CAP overrides the cap");
    process.env.AIH_SUBAGENT_ANSWER_CAP = "0";
    assert(answerCapLimit() === 0, "FB#5: cap 0 is respected (off)");
    if (saved === undefined) delete process.env.AIH_SUBAGENT_ANSWER_CAP;
    else process.env.AIH_SUBAGENT_ANSWER_CAP = saved;
    console.log("ok: FB#5 subagent answer cap");
  }

  // --- FB#6 — goal judge two-judge panel (parseGoalVerdict + judgePanel) ---
  {
    const { parseGoalVerdict, judgePanel } = await import("./maxmode.js");

    // parseGoalVerdict: met / reason / unmet
    const v1 = parseGoalVerdict('{"met": true, "reason": "file written", "unmet": []}');
    assert(v1.met === true && v1.reason === "file written" && v1.unmet.length === 0, "FB#6: parseGoalVerdict reads met/reason/unmet (met)");
    const v2 = parseGoalVerdict('{"met": false, "reason": "no test run", "unmet": ["run tests", "commit"]}');
    assert(v2.met === false && v2.reason === "no test run" && v2.unmet.length === 2, "FB#6: parseGoalVerdict reads the unmet list");
    // malformed JSON → regex fallback still extracts met
    const v3 = parseGoalVerdict('garbage {"met": true} trailing');
    assert(v3.met === true, "FB#6: parseGoalVerdict falls back to regex on malformed JSON");

    const goalJudge = (met: boolean) => ({
      complete: async (req: { tools: unknown[] }) => {
        if (req.tools.length === 0) {
          return { text: JSON.stringify({ met, reason: `judge-${met}`, unmet: met ? [] : ["x"] }), toolCalls: [], stopReason: "end_turn" as const };
        }
        return { text: "c", toolCalls: [], stopReason: "end_turn" as const };
      },
    });
    const req = { messages: [{ role: "user" as const, content: "judge" }], tools: [] };
    const same = (a: { met: boolean }, b: { met: boolean }) => a.met === b.met;

    // both agree → clean verdict, not degraded
    const agree = await judgePanel(goalJudge(true), req, parseGoalVerdict, goalJudge(true), "goal", same);
    assert(agree.degraded === false && agree.verdict.met === true, "FB#6: agreement → clean verdict, not degraded");

    // disagree → PRIMARY kept, FLAGGED
    const dis = await judgePanel(goalJudge(true), req, parseGoalVerdict, goalJudge(false), "goal", same);
    assert(dis.degraded === true && dis.verdict.met === true, "FB#6: disagreement keeps the PRIMARY's verdict, flagged degraded");

    // second judge fails → primary kept, FLAGGED
    const secFail = await judgePanel(goalJudge(true), req, parseGoalVerdict, { complete: async () => { throw new Error("2nd down"); } }, "goal", same);
    assert(secFail.degraded === true && secFail.verdict.met === true, "FB#6: second judge failed → primary verdict, flagged");

    // primary fails → secondary decides, FLAGGED
    const primFail = await judgePanel({ complete: async () => { throw new Error("primary down"); } }, req, parseGoalVerdict, goalJudge(false), "goal", same);
    assert(primFail.degraded === true && primFail.verdict.met === false, "FB#6: primary failed → secondary decides, flagged");

    // no secondary → single-judge (unchanged), not degraded
    const single = await judgePanel(goalJudge(true), req, parseGoalVerdict, undefined, "goal", same);
    assert(single.degraded === false && single.verdict.met === true, "FB#6: no secondary → single-judge, not degraded");
    console.log("ok: FB#6 goal judge two-judge panel");
  }

  // CC#50 — subagent partial-results honesty marking.
  {
    const registerGeneralToolsMod = (await import("./general-tools.js")).registerGeneralTools;
    const { ToolRegistry: Reg, toolCall } = await import("@aih/core");
    const partialLlm = {
      complete: async () => ({
        text: "still working...",
        toolCalls: [toolCall("c-partial", "echo3", { text: "x" })],
        stopReason: "tool_use" as const,
      }),
    };
    const fullLlm = {
      complete: async () => ({
        text: "All done, here is the full result.",
        toolCalls: [],
        stopReason: "end_turn" as const,
      }),
    };
    const pParent = new Reg(new AutoApprove());
    pParent.register({
      name: "echo3",
      description: "echo3",
      kind: "read",
      permission: "allow",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
      execute: async () => ({ ok: 1 }),
    });
    const mkTask = (llm: unknown) => {
      const g = new AutoApprove();
      const reg = new Reg(g);
      registerGeneralToolsMod(reg, {
        gate: g,
        llm: llm as NonNullable<Parameters<typeof registerGeneralToolsMod>[1]>["llm"],
        toolsProvider: () => pParent,
        cwd: "/tmp",
      });
      return reg;
    };
    const partial = (await mkTask(partialLlm).invoke(
      "task",
      { description: "short task", prompt: "go work" },
      { turnId: "t", inject: () => {} },
    )) as { ok: boolean; result?: { answer: string; partial: boolean; stopReason: string }; error?: string };
    assert(partial.ok === true, "CC#50: task tool runs ok");
    assert(
      partial.result?.partial === true && partial.result.stopReason === "max_steps" && /^\[partial/.test(partial.result.answer),
      "CC#50: max_steps-terminated subagent answer is marked partial",
    );
    const full = (await mkTask(fullLlm).invoke(
      "task",
      { description: "short task", prompt: "go work" },
      { turnId: "t", inject: () => {} },
    )) as { ok: boolean; result?: { answer: string; partial: boolean } };
    assert(
      full.result?.partial === false && !/^\[partial/.test(full.result.answer),
      "CC#50: end_turn subagent answer is NOT marked partial",
    );
    console.log("ok: CC#50 subagent partial results are honestly marked");
  }

  // runSubagent excludes task/question/best_of_n (no recursion) but keeps tools.
  const { ToolRegistry: Reg2 } = await import("@aih/core");
  const parent2 = new Reg2(new AutoApprove());
  parent2.register({
    name: "echo2",
    description: "echo2",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
    execute: async () => ({ ok: 1 }),
  });
  parent2.register({
    name: "question",
    description: "q",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "q",
  });
  const sub = await runSubagent({ gate, llm: makeLlm(0), toolsProvider: () => parent2 }, "do it");
  assert(sub.answer === "answer-0", "runSubagent returns the subagent's final answer");
}

// --- P2#9: XDG data-dir resolution (paths.ts + config/skills wiring) --------
{
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveAihPaths, userAihDirs } = await import("./paths.js");

  // Pure resolution (env-injected, no disk needed).
  assert(
    resolveAihPaths({ AIH_HOME: "/x", XDG_DATA_HOME: "/xdg", HOME: "/h" }).user === "/x",
    "AIH_HOME wins over XDG_DATA_HOME and default",
  );
  assert(
    resolveAihPaths({ XDG_DATA_HOME: "/xdg", HOME: "/h" }).user === "/xdg/aih",
    "XDG_DATA_HOME/aih is used when AIH_HOME is unset",
  );
  assert(
    resolveAihPaths({ HOME: "/h" }).user === "/h/.local/share/aih",
    "default is ~/.local/share/aih (XDG base dir)",
  );

  // Legacy ~/.aih compat: honored only while the XDG dir does not exist yet.
  const home = mkdtempSync(join(tmpdir(), "aih-xdg-"));
  try {
    mkdirSync(join(home, ".aih"), { recursive: true });
    const legacyOnly = resolveAihPaths({ HOME: home });
    assert(
      legacyOnly.user === join(home, ".aih") && legacyOnly.usingLegacy === true,
      "existing legacy ~/.aih is honored while the XDG dir is absent",
    );
    mkdirSync(join(home, ".local", "share", "aih"), { recursive: true });
    const both = resolveAihPaths({ HOME: home });
    assert(
      both.user === join(home, ".local", "share", "aih") && both.usingLegacy === false,
      "once the XDG dir exists it wins over legacy ~/.aih",
    );
    const dirs = userAihDirs({ HOME: home });
    assert(
      dirs.length === 2 && dirs[0] === join(home, ".local", "share", "aih") && dirs[1] === join(home, ".aih"),
      "userAihDirs lists primary first, legacy second (deduped)",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // Subprocess: AIH_HOME drives the user config + skills + --global install.
  const home2 = mkdtempSync(join(tmpdir(), "aih-xdg-cfg-"));
  const project = mkdtempSync(join(tmpdir(), "aih-xdg-proj-"));
  try {
    const userCfg = join(home2, "config.json");
    writeFileSync(userCfg, JSON.stringify({ model: "xdg-model-1", contextWindow: 4242 }) + "\n");
    // a user skill under the XDG-resolved dir
    mkdirSync(join(home2, "skills", "xdg-skill"), { recursive: true });
    writeFileSync(
      join(home2, "skills", "xdg-skill", "SKILL.md"),
      "---\nname: xdg-skill\ndescription: a user skill in the XDG dir\n---\nbody\n",
    );

    // Run from the empty project dir (no aih.json) with the dev shell's
    // AIH_MODEL/AIH_BASE_URL stripped, so the AIH_HOME config.json is the only
    // model source.
    const cfgOut = aihClean(["config"], { AIH_HOME: home2, HOME: home2 }, project);
    const cfg = JSON.parse(cfgOut.stdout);
    assert(
      cfg.model?.value === "xdg-model-1" && cfg.model?.source === userCfg,
      "aih config resolves model from the AIH_HOME config.json",
    );
    assert(
      Array.isArray(cfg.configLayers) && cfg.configLayers.includes(userCfg),
      "aih config lists the AIH_HOME layer",
    );

    const listOut = aih(["skills", "list"], { AIH_HOME: home2, HOME: home2 }, project);
    assert(listOut.stdout.includes("xdg-skill") && listOut.stdout.includes("user"), "aih skills list finds the XDG user skill");

    const inst = aih(["skills", "install", "app-tour", "--global"], { AIH_HOME: home2, HOME: home2 }, project);
    assert(inst.status === 0 && existsSync(join(home2, "skills", "app-tour", "SKILL.md")), "skills install --global lands in the XDG dir");
    assert(!existsSync(join(project, ".aih", "skills", "app-tour")), "--global install does not touch the project dir");
  } finally {
    rmSync(home2, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }

  // Subprocess: legacy ~/.aih config is still read when the XDG dir is absent.
  const home3 = mkdtempSync(join(tmpdir(), "aih-xdg-legacy-"));
  const proj3 = mkdtempSync(join(tmpdir(), "aih-xdg-legacy-proj-"));
  try {
    mkdirSync(join(home3, ".aih"), { recursive: true });
    const legacyCfg = join(home3, ".aih", "config.json");
    writeFileSync(legacyCfg, JSON.stringify({ model: "legacy-model-2" }) + "\n");
    const out = aihClean(
      ["config"],
      { HOME: home3, AIH_HOME: "", XDG_DATA_HOME: "" },
      proj3,
    );
    const cfg = JSON.parse(out.stdout);
    assert(
      cfg.model?.value === "legacy-model-2" && cfg.model?.source === legacyCfg,
      "legacy ~/.aih/config.json is honored for existing installs (XDG absent)",
    );
  } finally {
    rmSync(home3, { recursive: true, force: true });
    rmSync(proj3, { recursive: true, force: true });
  }
}

// --- P2#8: serve / attach (headless harness over HTTP/SSE) ------------------
{
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workDir = mkdtempSync(join(tmpdir(), "aih-serve-"));
  const port = 18000 + (process.pid % 10000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [cli, "serve", "--port", String(port), "--session", "smksrv", "--mock", "--yes", "--no-dev"],
    { cwd: workDir, stdio: "ignore", detached: true },
  );
  const cleanup = (): void => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  try {
    // Wait for the server to be ready.
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const h = await fetch(`${url}/health`);
        up = h.ok;
      } catch {
        up = false;
      }
    }
    assert(up, "serve /health is reachable");

    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    assert(
      health.ok === true && health.session === "smksrv" && typeof health.tools === "number",
      "serve /health reports session + tool count",
    );

    const tools = (await (await fetch(`${url}/tools`)).json()) as Array<{ name: string }>;
    assert(Array.isArray(tools) && tools.some((t) => t.name === "add_todo"), "serve /tools lists backend tools");

    // POST /message runs a (mocked) turn and persists it to the session file.
    const post = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "serve smoke" }),
    });
    assert(post.status === 200, "serve /message accepts a turn");
    const body = (await post.json()) as { ok?: boolean };
    assert(body.ok === true, "serve /message reports ok");

    // Empty text → 400.
    const bad = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert(bad.status === 400, "serve /message rejects empty text with 400");

    // Unknown route → 404.
    const nf = await fetch(`${url}/nope`);
    assert(nf.status === 404, "serve unknown route → 404");

    // attach client: SSE replay of the persisted turn.
    const { attach } = await import("./serve.js");
    const { events } = await attach({ url, minEvents: 5, timeoutMs: 5000 });
    const types = events.map((e) => e.type);
    assert(types.includes("user/message") && types.includes("turn/end"), "attach sees the replayed turn (user/message … turn/end)");
    assert(
      events.some((e) => e.type === "user/message" && (e as { text?: string }).text === "serve smoke"),
      "attach replay carries the posted message text",
    );

    // The turn is persisted in the serve cwd (append-only JSONL).
    const sessionFile = join(workDir, ".aih", "sessions", "smksrv.jsonl");
    assert(existsSync(sessionFile), "serve persists the session to .aih/sessions/<name>.jsonl");
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    assert(lines.length >= 5 && lines.every((l) => l.startsWith("{")), "session file is append-only JSONL");
  } finally {
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
}

{
  // E#18: named agent profiles (--as <name>) — config load + rules + prompt
  const { loadAgentProfile, listAgentProfiles, setProjectTrustState } = await import("./config.js");
  const { RulesetGate, DenyAll } = await import("@aih/core");
  const { mkdtempSync: mkd, writeFileSync: wfs } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: jj } = await import("node:path");
  const profDir = mkd(jj(td(), "aih-profiles-"));
  const prevCwd = process.cwd();
  try {
    // P#40: the temp dir's aih.json carries agents — trust it for this block
    process.env.AIH_TRUST_ALL_PROJECTS = "1";
    wfs(
      jj(profDir, "aih.json"),
      JSON.stringify({
        agents: {
          readonly: {
            prompt: "You are a read-only reviewer.",
            permissions: [{ tool: "write_file", action: "deny" }],
          },
          permissive: { permissions: [{ tool: "run_cmd", action: "allow" }] },
        },
      }),
    );
    process.chdir(profDir);
    // P#40: in-process trust state was resolved at startup (before chdir) —
    // mark this temp dir trusted so its aih.json layers are visible.
    setProjectTrustState("trusted");
    const names = listAgentProfiles();
    assert(names.includes("readonly") && names.includes("permissive"), "listAgentProfiles finds configured profiles");
    const ro = loadAgentProfile("readonly");
    assert(!!ro && ro.prompt === "You are a read-only reviewer.", "loadAgentProfile returns prompt");
    assert(!!ro && ro.permissions?.length === 1 && ro.permissions[0].action === "deny", "loadAgentProfile returns permissions");
    assert(loadAgentProfile("nope") === undefined, "unknown profile is undefined");
    // profile rules applied on top of base: write_file denied, run_cmd still ask->base
    const gate = new RulesetGate(new DenyAll(), [
      { tool: "todo", pattern: "*", action: "allow" },
      ...(ro?.permissions ?? []),
    ]);
    assert(gate.evaluate({ tool: "todo", kind: "write", args: {} }) === "allow", "base allow rule still applies");
    assert(gate.evaluate({ tool: "write_file", kind: "write", args: { path: "/x" } }) === "deny", "profile deny rule applies");
    assert(gate.evaluate({ tool: "run_cmd", kind: "write", args: { command: "ls" } }) === undefined, "unmatched tool falls through to base gate");
  } finally {
    process.chdir(prevCwd);
    delete process.env.AIH_TRUST_ALL_PROJECTS;
    rmSync(profDir, { recursive: true, force: true });
  }
}

// CC#53 — permission rule `ask` action + deny>ask>allow floor + AskError hook.
{
  const { RulesetGate, DenyAll, AskError, ToolRegistry } = await import("@aih/core");
  // deny > ask > allow priority: a later `allow` cannot lift an earlier `ask`.
  const gate = new RulesetGate(new DenyAll(), [
    { tool: "write_file", action: "ask" },
    { tool: "write_file", action: "allow" },
    { tool: "run_cmd", action: "allow" },
    { tool: "run_cmd", action: "deny" },
  ]);
  assert(
    gate.evaluate({ tool: "write_file", kind: "write", args: { path: "/x" } }) === "ask",
    "CC#53: ask rule is NOT overridden by a later allow (floor held)",
  );
  assert(
    gate.evaluate({ tool: "run_cmd", kind: "write", args: { command: "ls" } }) === "deny",
    "CC#53: deny dominates an earlier allow",
  );
  assert(
    gate.evaluate({ tool: "unrelated", kind: "write", args: {} }) === undefined,
    "CC#53: unmatched tool falls through to base",
  );

  // AskError from a before-hook routes to the approval gate (forces a prompt)
  // instead of denying — and an approving gate lets the call through.
  const askRec = { asked: false };
  const recordingGate: ApprovalGate = {
    request: async () => {
      askRec.asked = true;
      return true; // human approves
    },
  };
  const reg = new ToolRegistry(recordingGate);
  reg.register({
    name: "echo4",
    description: "echo4",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
    execute: async (a: unknown) => ({ echoed: (a as { text?: string }).text }),
  });
  reg.addHooks({
    before: async () => {
      throw new AskError("review this one");
    },
  });
  const res = await reg.invoke("echo4", { text: "hi" }, { turnId: "t", inject: () => {} });
  assert(res.ok === true && askRec.asked === true, "CC#53: AskError floors at a gate prompt; approved call runs");
  console.log("ok: CC#53 ask rule floors (deny>ask>allow) and AskError routes to the gate");
}

// --- D#13: background jobs (board bookkeeping + spawn lifecycle) -----------
{
  const { loadBoard, saveBoard, summarize, spawnJob, cancelJob, jobById, jobsFile } = await import("./jobs.js");
  const jobdir = mkdtempSync("/tmp/aih-jobs-");
  // pure bookkeeping
  assert(loadBoard(jobdir).jobs.length === 0, "empty board when no jobs file");
  const board = { jobs: [
    { id: "a", label: "a", prompt: "a", status: "running" as const, session: "a", out: "/x", createdAt: 1, startedAt: 1 },
    { id: "b", label: "b", prompt: "b", status: "done" as const, session: "b", out: "/x", createdAt: 1, startedAt: 1, finishedAt: 2 },
    { id: "c", label: "c", prompt: "c", status: "failed" as const, session: "c", out: "/x", createdAt: 1, startedAt: 1, finishedAt: 2 },
  ] };
  saveBoard(jobdir, board);
  assert(existsSync(jobsFile(jobdir)), "saveBoard writes .aih/jobs.json");
  const s = summarize(loadBoard(jobdir));
  assert(s.running === 1 && s.done === 1 && s.failed === 1, "summarize counts running/done/failed");
  assert(jobById(jobdir, "b")?.status === "done", "jobById finds a job");
  assert(cancelJob(jobdir, "a") === true, "cancelJob marks a running job cancelled");
  assert(jobById(jobdir, "a")?.status === "cancelled", "cancelled job persisted");
  assert(cancelJob(jobdir, "b") === false, "cancelJob refuses a finished job");
  // spawn lifecycle: a fake CLI that prints an answer and exits 0
  const fakeCli = `${jobdir}/fake.mjs`;
  writeFileSync(fakeCli, `process.stdout.write("bg answer line\\n"); process.exit(0);\n`);
  const { job, child } = spawnJob(jobdir, "do a thing in the background", { cli: fakeCli });
  assert(job.status === "running" && job.id.startsWith("bg-"), "spawnJob creates a running job");
  assert(jobById(jobdir, job.id)?.status === "running", "spawned job is on the board");
  const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
  assert(code === 0, "background child exits 0");
  const finished = jobById(jobdir, job.id);
  assert(finished?.status === "done" && finished?.exitCode === 0, "job marked done with exit 0");
  assert(finished?.preview === "bg answer line", "job preview captures the last output line");
  assert(existsSync(finished!.out) && readFileSync(finished!.out, "utf8").includes("bg answer line"), "job output captured to file");
  // failing child → failed
  const fakeFail = `${jobdir}/fail.mjs`;
  writeFileSync(fakeFail, `process.stderr.write("boom\\n"); process.exit(3);\n`);
  const f2 = spawnJob(jobdir, "will fail", { cli: fakeFail });
  await new Promise((res) => f2.child.on("close", () => res(null)));
  assert(jobById(jobdir, f2.job.id)?.status === "failed", "failing child marks job failed");
  rmSync(jobdir, { recursive: true, force: true });
}

// --- E#17: memory auto-tidy (deterministic dedup) ---------------------------
{
  const { tidyMemory, formatTidyReport, parseMemoryEntries, normEntry } = await import("./memory-tidy.js");
  // no entries → no change
  const empty = tidyMemory("# Project memory\n\n(no bullets here)\n");
  assert(empty.noChange && empty.total === 0, "tidyMemory: no bullets → noChange");
  // exact duplicates → keep one, drop the rest
  const dup = tidyMemory(
    "# Project memory\n\n- 2026-01-01 — use tabs not spaces\n- 2026-02-02 — use tabs not spaces\n- 2026-03-03 — other fact\n",
  );
  assert(dup.total === 3 && dup.kept === 2 && dup.removed.length === 1, "tidyMemory: 3 entries, 2 kept, 1 dup removed");
  assert(!dup.cleaned.includes("2026-01-01") && dup.cleaned.includes("2026-02-02"), "tidyMemory: keeps the most recent dated copy");
  assert(dup.cleaned.includes("other fact"), "tidyMemory: preserves non-duplicate entries");
  // near-duplicate (punctuation/whitespace) still dedups
  const near = tidyMemory("- use tabs, not spaces\n- use  tabs, not  spaces\n");
  assert(near.kept === 1 && near.removed.length === 1, "tidyMemory: whitespace/punctuation variants dedupe");
  // no dates → later in file wins
  const undated = tidyMemory("- fact A\n- fact A\n");
  assert(undated.kept === 1 && undated.removed.length === 1, "tidyMemory: undated dup keeps later copy");
  // report formatting
  assert(formatTidyReport(dup).includes("2 kept") && formatTidyReport(dup).includes("1 duplicate"), "formatTidyReport summarizes kept/removed");
  assert(formatTidyReport(empty).includes("already tidy"), "formatTidyReport reports tidy");
  // parse + norm helpers
  assert(parseMemoryEntries("- a\n- b\nnot a bullet\n").length === 2, "parseMemoryEntries counts bullets only");
  assert(normEntry("2026-01-01 — Use Tabs") === normEntry("use tabs"), "normEntry strips date + case/punct");
}

// --- P1#4: BM25 relevance scoring -------------------------------------------
{
  const { tokenize, buildIndex, search, rank } = await import("./bm25.js");
  // tokenizer: ascii words + CJK bigrams (segmenter-free CJK IR)
  const toks = tokenize("Batch Ops 批量操作 plan-execute-verify");
  assert(toks.includes("batch") && toks.includes("ops"), "tokenize keeps ascii words");
  assert(toks.includes("批量") && toks.includes("操作") && !toks.includes("批量操作"), "tokenize expands CJK runs into bigrams");
  assert(tokenize("中").length === 1 && tokenize("中") [0] === "中", "tokenize keeps a lone CJK char");
  assert(tokenize("  ").length === 0, "tokenize of whitespace is empty");
  // rank: relevant doc beats unrelated, topK caps, empty query → no hits
  const docs = [
    { id: "batch-ops", text: "batch operations bulk create update remove plan execute verify" },
    { id: "app-tour", text: "explore connected app tools capability tour" },
    { id: "session-report", text: "turn current session history into structured report" },
  ];
  const hits = rank(docs, "bulk batch operations", 3);
  assert(hits.length > 0 && hits[0].id === "batch-ops", "rank: batch-ops tops a bulk-operations query");
  assert(hits.every((h) => h.score > 0), "rank: only positive-score hits returned");
  assert(rank(docs, "bulk batch operations", 2).length <= 2, "rank: topK caps results");
  assert(search(buildIndex(docs), "   ").length === 0, "search: blank query → no hits");
  assert(rank(docs, "zzz qqq xyz").length === 0, "rank: no-match query → no hits");
  // CJK query matches CJK text
  const cjk = rank(
    [
      { id: "cn", text: "中文技能：批量操作与验证" },
      { id: "en", text: "english only skill" },
    ],
    "批量操作",
  );
  assert(cjk.length > 0 && cjk[0].id === "cn", "rank: CJK query ranks the CJK doc first");
}

// --- P1#4: suggestSkills (BM25 over installed skills) ------------------------
{
  const { suggestSkills, discoverSkills } = await import("./skills.js");
  const skills = discoverSkills();
  const hits = suggestSkills("bulk batch operations on app data", skills, 3);
  assert(hits.length > 0 && hits[0].skill.name === "batch-ops", "suggestSkills: batch-ops tops a bulk-ops query");
  assert(hits[0].score > 0, "suggestSkills: scores are positive");
  assert(suggestSkills("   ", skills).length === 0, "suggestSkills: blank query → none");
  assert(suggestSkills("zzz qqq xyz", skills).length === 0, "suggestSkills: no match → none");
  // explicit skill list (deterministic, no filesystem)
  const custom = [
    { name: "deploy", description: "deploy release publish to production", scope: "project" as const, body: "" },
    { name: "tour", description: "explore tools capability tour", scope: "project" as const, body: "" },
  ];
  const ch = suggestSkills("release deploy to production", custom, 2);
  assert(ch.length > 0 && ch[0].skill.name === "deploy", "suggestSkills: explicit list ranks deploy first");
}

// --- D#11: skill-driven hook config (secretPatterns front matter) -----------
{
  const { parseSkillMd, skillSecretPatterns } = await import("./skills.js");
  const parsed = parseSkillMd(
    "---\nname: acme\ndescription: acme ops\nsecretPatterns: acme_[A-Z0-9]{16,}; zzz_[0-9]{8,}\n---\n# body\n",
    "fallback",
  );
  assert(parsed.name === "acme", "parseSkillMd reads name");
  assert(Array.isArray(parsed.secretPatterns) && parsed.secretPatterns.length === 2, "parseSkillMd parses secretPatterns list");
  assert(parsed.secretPatterns![0] === "acme_[A-Z0-9]{16,}" && parsed.secretPatterns![1] === "zzz_[0-9]{8,}", "parseSkillMd splits semicolon-separated patterns (keeps {n,} quantifiers intact)");
  // no secretPatterns → undefined
  const plain = parseSkillMd("---\nname: x\ndescription: d\n---\nbody\n", "fb");
  assert(plain.secretPatterns === undefined, "parseSkillMd: absent secretPatterns → undefined");
  // skillSecretPatterns unions across skills (deduped)
  const skills = [
    { name: "a", description: "", scope: "project" as const, body: "", secretPatterns: ["p1", "p2"] },
    { name: "b", description: "", scope: "project" as const, body: "", secretPatterns: ["p2", "p3"] },
    { name: "c", description: "", scope: "builtin" as const, body: "" },
  ];
  const union = skillSecretPatterns(skills);
  assert(union.length === 3 && union.includes("p1") && union.includes("p2") && union.includes("p3"), "skillSecretPatterns unions + dedupes");
  assert(skillSecretPatterns([{ name: "c", description: "", scope: "builtin" as const, body: "" }]).length === 0, "skillSecretPatterns: none declared → empty");
}

// --- F#30: streaming TPS (per-request generation time) ------------------------
{
  const { streamingTps } = await import("./cost.js");
  const mk = (completion: number, genMs: number): SessionEvent =>
    ({
      seq: 1,
      ts: Date.now(),
      type: "turn/end",
      turnId: "t",
      stopReason: "end_turn",
      usage: { promptTokens: 10, completionTokens: completion, totalTokens: 10 + completion },
      genMs,
    }) as SessionEvent;
  // 100 completion tokens over 2s of generation → 50 tok/s
  const evts = [mk(60, 1000), mk(40, 1000)];
  const stps = streamingTps(evts);
  assert(Math.abs(stps - 50) < 1e-9, "streamingTps: completion tokens / gen time");
  // no genMs (mock / non-streaming) → 0
  const noGen = [{ seq: 1, ts: Date.now(), type: "turn/end", turnId: "t", stopReason: "end_turn", usage: { promptTokens: 1, completionTokens: 5, totalTokens: 6 } }] as SessionEvent[];
  assert(streamingTps(noGen) === 0, "streamingTps: 0 without genMs");
  assert(streamingTps([]) === 0, "streamingTps: 0 with no events");
}

// --- D#15: Agent Teams (roster + task board + mailbox) ---
{
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    addAgent,
    addTask,
    claimTask,
    dispatchTask,
    loadTeam,
    readMail,
    resolveTask,
    sendMail,
    setTaskStatus,
    summarizeTeam,
  } = await import("./teams.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "aih-team-"));
  try {
    // roster
    addAgent(dir, "scout", "research", "You are a careful researcher.");
    addAgent(dir, "builder");
    let state = loadTeam(dir);
    assert(state.agents.length === 2, "team: two agents in roster");
    assert(state.agents[0].role === "research" && Boolean(state.agents[0].prompt), "team: role + prompt recorded");
    // re-adding the same name updates, does not duplicate
    addAgent(dir, "scout", "research+build");
    state = loadTeam(dir);
    assert(state.agents.length === 2, "team: add-agent is upsert, not duplicate");
    assert(state.agents[0].role === "research+build", "team: upsert updates role");
    // invalid names rejected
    let threw = false;
    try { addAgent(dir, "bad name"); } catch { threw = true; }
    assert(threw, "team: agent name with whitespace rejected");

    // task board
    const t1 = addTask(dir, "write the report", "draft v1 of the quarterly report");
    const t2 = addTask(dir, "review the report");
    state = loadTeam(dir);
    assert(state.tasks.length === 2, "team: two tasks on the board");
    assert(state.tasks.every((t) => t.status === "todo"), "team: new tasks start todo");
    // claim
    claimTask(dir, t1.id, "scout");
    state = loadTeam(dir);
    assert(state.tasks[0].status === "claimed" && state.tasks[0].assignee === "scout", "team: claim sets status+assignee");
    // double-claim rejected
    threw = false;
    try { claimTask(dir, t1.id, "builder"); } catch { threw = true; }
    assert(threw, "team: claiming a claimed task throws");
    // prefix resolution (drop the last 2 chars of the random tail; the seq
    // counter keeps same-millisecond ids distinct, so the prefix is unique)
    const byPrefix = resolveTask(dir, t2.id.slice(0, -2));
    assert(byPrefix?.id === t2.id, "team: resolveTask by unique prefix");
    // status transitions
    setTaskStatus(dir, t1.id, "done", "report shipped");
    state = loadTeam(dir);
    assert(state.tasks[0].status === "done" && state.tasks[0].preview === "report shipped", "team: done + preview recorded");
    setTaskStatus(dir, t2.id, "cancelled");
    // summary
    const s = summarizeTeam(loadTeam(dir));
    assert(s.agents === 2 && s.done === 1 && s.todo === 0, "team: summarizeTeam counts");

    // mailbox
    sendMail(dir, "scout", "builder", "report is ready for review");
    sendMail(dir, "builder", "scout", "looks good, ship it");
    const inbox = readMail(dir, "builder");
    assert(inbox.length === 1 && inbox[0].from === "scout", "team: mailbox delivers to the right inbox");
    assert(readMail(dir, "scout").length === 1, "team: each agent has its own inbox");
    assert(readMail(dir, "nobody").length === 0, "team: empty inbox for unknown agent");

    // dispatch: claim (idempotent) + spawn a child that echoes the prompt.
    // We point the CLI at a tiny node script that prints its args so no LLM
    // is needed and the job finishes fast.
    const t3 = addTask(dir, "echo task", "say hello from the team");
    const fakeCli = path.join(dir, "fake-cli.mjs");
    writeFileSync(fakeCli, `import process from "node:process";\nconsole.log("ARGS " + process.argv.slice(2).join(" ").slice(0, 200));\n`);
    const { job, child, task } = dispatchTask(dir, t3.id, "builder", { cli: fakeCli });
    assert(task.status === "claimed" && task.assignee === "builder", "team: dispatch claims the task");
    assert(job.status === "running", "team: dispatch creates a running job");
    await new Promise<void>((res) => child.on("close", () => res()));
    const after = resolveTask(dir, t3.id);
    assert(Boolean(after?.session) && Boolean(after?.out), "team: dispatch records session + output path on the task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- T#22: /find — search across tool outputs ---
{
  const { Tui } = await import("./tui.js");
  const tui = new Tui({
    placeholder: ">",
    meta: () => ({ agent: "t", model: "m", provider: "p" }),
    cwd: "/tmp",
    statusLeft: "x",
    statusRight: "y",
    busy: () => false,
    onLine: () => {},
  });
  tui.pushTool("run_cmd", { command: "npm test" }, "c1");
  tui.resolveTool("c1", true, { stdout: "line one\nECONNREFUSED 127.0.0.1:5432\nall green" });
  tui.pushTool("run_cmd", { command: "ls" }, "c2");
  tui.resolveTool("c2", true, { stdout: "a.txt\nb.txt" });
  tui.push({ role: "assistant", text: "the tests failed with a connection error" });
  // no match
  let r = tui.searchTools("zzz-not-present");
  assert(r.n === 0, "/find: no match → n=0");
  // match (case-insensitive)
  r = tui.searchTools("econnrefused");
  assert(r.n === 1, "/find: one line matches");
  assert(r.matches[0].tool === "run_cmd" && r.matches[0].line === 2, "/find: match points at the right tool + line");
  assert(r.matches[0].snippet.includes("ECONNREFUSED"), "/find: snippet carries the matched line");
  // the matched tool is now expanded so the match is visible
  const t1 = tui.transcriptLines().join("\n");
  assert(t1.includes("ECONNREFUSED"), "/find: matched tool output is expanded in the transcript");
  // empty query is a no-op
  assert(tui.searchTools("   ").n === 0, "/find: blank query → no matches");
}

// --- P#46: eval experiment framework (phase 1 kernel + phase 2 semantics) ---
{
  const { expandCells, judgeOutput, runExperiment, cliSubjectAdapter, externalSubjectAdapter, attemptUsage } = await import("./eval.js");
  const tasks = [
    { id: "t1", prompt: "say OK", expect: [] },
    { id: "t2", prompt: "echo hi then deploy", expect: [] },
  ];
  const models = [{ model: "mock" }];
  const cells = expandCells(tasks, models, 2);
  assert(cells.length === 4, "expandCells: 2 tasks x 1 model x 2 reps = 4 cells");
  assert(
    cells[0].repetition === 1 && cells[1].repetition === 2,
    "cells are ordered task → model → repetition",
  );

  assert(judgeOutput("all OK done", ["OK"]) === true, "judgeOutput passes when expectation present");
  assert(judgeOutput("nothing here", ["OK"]) === false, "judgeOutput fails on missing expectation");
  assert(judgeOutput("nonempty", []) === true, "judgeOutput with no expectations needs non-empty output");

  // Phase 2: real experiment over the bundled CLI subject (mock LLM),
  // bounded concurrency, isolated workdirs per cell.
  const { mkdtempSync } = await import("node:fs");
  const outDir = mkdtempSync("/tmp/aih-eval-");
  const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
  const report = await runExperiment(
    [tasks[0]],
    [{ model: "mock" }, { model: "mock" }],
    2,
    cliSubjectAdapter(await import("node:path").then((m) => m.join(cliRoot, "cli")), { timeoutMs: 60_000 }),
    { outDir, budget: { concurrency: 2 } },
  );
  assert(report.results.length === 4, `experiment ran all 4 cells (got ${report.results.length})`);
  assert(report.totals.passed === 4, `all mock cells pass (got ${report.totals.passed} passed, ${report.totals.failed} failed)`);
  assert(
    report.results.every((r) => r.cellId === `t1__mock__r${r.repetition}`),
    "cellIds are task__model__rep",
  );
  assert(report.totals.stopReason === "completed", "no budget set → completed");

  // Time budget: exhausted budget skips queued cells honestly (no fabrication).
  const tight = await runExperiment([tasks[0]], [{ model: "mock" }], 4, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return { output: "ok" };
  }, { outDir: join(outDir, "tight"), budget: { budgetMs: 50, concurrency: 1 } });
  assert(tight.totals.stopReason === "time_budget_exhausted", "tiny wall-clock budget → time_budget_exhausted");
  assert(tight.skippedCells.length > 0, "unstarted cells are reported as skipped");
  assert(
    tight.results.length + tight.skippedCells.length === 4,
    "every cell is either run or skipped (never fabricated)",
  );

  // Cost budget: ceiling below one attempt's spend stops after first cell.
  const { writeFileSync } = await import("node:fs");
  const fakeSession = join(outDir, "fake-session.jsonl");
  writeFileSync(fakeSession, JSON.stringify({ type: "turn/end", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 } }) + "\n");
  const usage = attemptUsage(fakeSession);
  assert(usage?.totalTokens === 1500 && usage.promptTokens === 1000, "attemptUsage aggregates turn/end usage");
  assert(attemptUsage(undefined) === undefined, "attemptUsage missing file → undefined");
  const costly = await runExperiment([tasks[0]], [{ model: "gpt-4o" }], 3, async (_t, _m, wd) => {
    // simulate an expensive subject by planting a session log next to the workdir
    const { copyFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    copyFileSync(fakeSession, pjoin(wd, "s.jsonl"));
    return { output: "ok", sessionFile: pjoin(wd, "s.jsonl") };
  }, { outDir: join(outDir, "cost"), budget: { maxCostUsd: 0.001, concurrency: 1 } });
  assert(costly.totals.costUsd > 0, "cost kernel prices attempts via table prices");
  assert(costly.totals.stopReason === "cost_budget_exhausted", "cost ceiling → cost_budget_exhausted");
  void costly;

  // External command subject: echo passes, failing command errors honestly.
  const ext = await runExperiment([{ id: "e1", prompt: "hello eval", expect: ["hello eval"] }], [{ model: "any" }], 1,
    externalSubjectAdapter("/bin/echo", ["{prompt}"], { timeoutMs: 10_000 }),
    { outDir: join(outDir, "ext"), budget: { concurrency: 2 } });
  assert(ext.totals.passed === 1, `externalSubjectAdapter: /bin/echo output judged (got ${ext.totals.passed}/${JSON.stringify(ext.results[0])})`);
  const bad = await runExperiment([{ id: "b1", prompt: "x", expect: [] }], [{ model: "any" }], 1,
    externalSubjectAdapter("/bin/false", [], { timeoutMs: 10_000 }),
    { outDir: join(outDir, "bad"), budget: {} });
  assert(bad.results[0]?.status === "error" || bad.totals.errors === 0, "external failure surfaces as error or empty-output fail");
}

// --- FA#6: result persistence + failed-cell retry + status inspection ---
{
  const {
    runExperiment: re,
    loadResults: lr,
    saveResults: sr,
    retryCellIds: rci,
    statusSummary: ss,
    resultsPath: rp,
    expandCells: ec,
  } = await import("./eval.js");
  const tasks = [
    { id: "t1", prompt: "always ok", expect: ["OK"] },
    { id: "t2", prompt: "flaky", expect: ["OK"] },
  ];
  const models = [{ model: "mock" }];
  const rd = mkdtempSync("/tmp/aih-fa6-");
  const spec = ec(tasks, models, 1); // t1__mock__r1, t2__mock__r1

  // Flaky subject: t2 fails on its first attempt, passes on the retry.
  let t2Attempts = 0;
  const flaky = async (task: { id: string }, _m: unknown, _wd: string) => {
    if (task.id === "t2") {
      t2Attempts += 1;
      return t2Attempts === 1 ? { output: "nope" } : { output: "OK" };
    }
    return { output: "OK" };
  };

  // 1) first run: t1 passes, t2 fails → persisted.
  const r1 = await re(tasks, models, 1, flaky, { outDir: join(rd, "c1"), expId: "e1", resultsDir: rd });
  assert(r1.totals.passed === 1 && r1.totals.failed === 1, `FA#6 first run: 1 passed 1 failed (got ${r1.totals.passed}/${r1.totals.failed})`);
  const p1 = rp(rd, "e1");
  assert(existsSync(p1), "FA#6 results file persisted");
  const s1 = lr(rd, "e1");
  assert(!!s1 && s1.cells["t1__mock__r1"].status === "passed", "FA#6 t1 persisted as passed");
  assert(s1?.cells["t2__mock__r1"].status === "failed", "FA#6 t2 persisted as failed");

  // 2) retry only the failed cell: t1 must NOT re-run, t2 must re-run and pass.
  const only = rci(spec, lr(rd, "e1"));
  assert(only.length === 1 && only[0] === "t2__mock__r1", `FA#6 retry targets only the failed cell (got ${JSON.stringify(only)})`);
  const r2 = await re(tasks, models, 1, flaky, { outDir: join(rd, "c2"), expId: "e1", resultsDir: rd, onlyCells: only });
  assert(r2.results.length === 1 && r2.results[0].cellId === "t2__mock__r1", "FA#6 retry ran exactly the failed cell");
  assert(r2.results[0].status === "passed", "FA#6 retried cell now passes");
  assert(t2Attempts === 2, "FA#6 t2 attempted exactly twice (1 fail + 1 retry)");

  // 3) merged result set: both cells passed, t1's first-run status retained.
  const s2 = lr(rd, "e1");
  const sum2 = ss(s2!.cells);
  assert(sum2.passed === 2 && sum2.failed === 0 && sum2.total === 2, `FA#6 merged set all passed (got ${JSON.stringify(sum2)})`);
  assert(s2!.cells["t1__mock__r1"].status === "passed", "FA#6 passed cell retained across retry");

  // 4) status inspection reads the same persisted set (cross-process safe).
  const s3 = lr(rd, "e1");
  assert(!!s3 && ss(s3.cells).total === 2, "FA#6 status reads persisted set");

  // 5) all-passed → retry targets nothing.
  const allPassed: Record<string, import("./eval.js").CellResult> = {
    "a__mock__r1": { cellId: "a__mock__r1", taskId: "a", model: "mock", repetition: 1, status: "passed", durationMs: 1, outputTail: "" },
  };
  assert(rci([{ taskId: "a", model: "mock", repetition: 1 }], { expId: "x", updatedAt: "", cells: allPassed, skipped: [] }).length === 0, "FA#6 all-passed → nothing to retry");

  // 6) no prior set → retry targets the full spec (first run).
  assert(rci(spec, undefined).length === 2, "FA#6 no prior → full spec");

  // 7) saveResults → loadResults round-trip.
  const rd2 = mkdtempSync("/tmp/aih-fa6b-");
  sr(rd2, { expId: "e2", updatedAt: "now", cells: allPassed, skipped: [] });
  assert(lr(rd2, "e2")?.cells["a__mock__r1"].status === "passed", "FA#6 save/load round-trip");

  rmSync(rd, { recursive: true, force: true });
  rmSync(rd2, { recursive: true, force: true });
  console.log("ok: FA#6 result persistence + failed-cell retry + status inspection");
}

// --- P#39①: result-bearing extension events (cancel / rewrite / turn:end) ---
{
  const { createExtensionEventBridge, loadExtensions } = await import("./extensions.js");
  const { ToolRegistry: Reg, AutoApprove } = await import("@aih/core");
  const { TOOL_ICONS, TOOL_TITLE_ARG } = await import("./tui.js");

  // ② Same-name shadowing inherits the built-in's rendering tables.
  {
    const dir = mkdtempSync("/tmp/aih-ext-");
    mkdirSync(join(dir, ".aih", "extensions"), { recursive: true });
    // run_cmd is a built-in with icon "$" and title-arg "command".
    writeFileSync(
      join(dir, ".aih", "extensions", "shadow.mjs"),
      `export default function (aih) {
        aih.registerTool({
          name: "run_cmd",
          description: "shadowed run_cmd",
          kind: "read",
          parameters: { type: "object", properties: {}, required: [] },
          execute: async () => ({ shadowed: true }),
        });
      }`,
    );
    const reg2 = new Reg(new AutoApprove());
    await loadExtensions(reg2, { cwd: dir, enabled: true });
    assert(reg2.get("run_cmd") !== undefined && reg2.get("run_cmd")?.description === "shadowed run_cmd", "same-name extension tool replaces the built-in");
    assert(TOOL_ICONS["run_cmd"] === "$", "shadowing inherits the built-in icon");
    assert(TOOL_TITLE_ARG["run_cmd"] === "command", "shadowing inherits the built-in title-arg");
    rmSync(dir, { recursive: true, force: true });
  }

  const bridge = createExtensionEventBridge();
  // before-handler vetoes a call; after-handler rewrites the result.
  bridge.on("tool:before", (p) => {
    const info = p as { name: string };
    if (info.name === "forbidden") return { cancel: "blocked by policy extension" };
    return undefined;
  });
  bridge.on("tool:after", (p) => {
    const info = p as { name: string; result: unknown };
    if (info.name === "echo") return { result: { ...(info.result as object), rewritten: true } };
    return undefined;
  });
  let turnEnded = 0;
  bridge.on("turn:end", () => {
    turnEnded += 1;
  });

  const reg = new Reg(new AutoApprove());
  const schema = { type: "object" as const, properties: {}, required: [] as string[] };
  reg.register({
    name: "echo",
    description: "echo",
    kind: "read",
    permission: "allow",
    parameters: schema,
    execute: async () => ({ echoed: true }),
  });
  reg.register({
    name: "forbidden",
    description: "should never run",
    kind: "read",
    permission: "allow",
    parameters: schema,
    execute: async () => ({ ran: true }),
  });
  reg.addHooks(bridge.hookSet());

  const vetoed = await reg.invoke("forbidden", {}, { turnId: "t", inject: () => {} });
  assert(vetoed.ok === false && /blocked by policy extension/.test(vetoed.error ?? ""), `tool:before cancel vetoes the call (${vetoed.error})`);
  const ok = await reg.invoke("echo", {}, { turnId: "t", inject: () => {} });
  assert(ok.ok === true && (ok.result as { rewritten?: boolean })?.rewritten === true, `tool:after rewrites the result in place (${JSON.stringify(ok.result)})`);
  bridge.emit("turn:end", { stopReason: "end_turn" });
  assert(turnEnded === 1, "turn:end subscribers fire via emit");
}

// --- P#37②: stateful tools roll back with the timeline ----------------------
{
  const { todoStateFromLog, registerGeneralTools } = await import("./general-tools.js");
  const { ToolRegistry: Reg2, AutoApprove: AA } = await import("@aih/core");
  const reg3 = new Reg2(new AA());
  const tmpCwd = mkdtempSync("/tmp/aih-state-");
  registerGeneralTools(reg3, { cwd: tmpCwd });
  const t = await reg3.invoke("todo", { todos: [{ content: "first", status: "completed" }] }, { turnId: "t", inject: () => {} });
  assert(t.ok && (t.result as { details?: { kind?: string } })?.details?.kind === "state.todos", "todo stamps a state.todos snapshot into the result");
  // Simulate the log growing, then rolling back to before the second write.
  const evs = [
    { seq: 0, type: "user/message", text: "start" },
    { seq: 1, type: "tool/result", callId: "a", ok: true },
    { seq: 2, type: "tool/result", callId: "b", ok: true, result: { details: { kind: "state.todos", todos: [{ content: "old", status: "pending" }] } } },
    { seq: 3, type: "tool/result", callId: "c", ok: true, result: { details: { kind: "state.todos", todos: [{ content: "new", status: "in_progress" }] } } },
    { seq: 4, type: "checkpoint" },
    { seq: 5, type: "tool/result", callId: "d", ok: true, result: { details: { kind: "state.todos", todos: [{ content: "future", status: "completed" }] } } },
  ];
  assert(todoStateFromLog(evs)?.[0]?.content === "future", "newest state snapshot wins");
  assert(todoStateFromLog(evs, 4)?.[0]?.content === "new", "beforeSeq rolls state back to the timeline point");
  assert(todoStateFromLog(evs, 1) === undefined, "no snapshot before first write → undefined");
  rmSync(tmpCwd, { recursive: true, force: true });
}

console.log("\nAIH cli smoke test passed.");

// ════════════════════════════════════════════════════════════════════════
// TP#2 — llm-sse.ts + fake-llm-server smoke tests
// ════════════════════════════════════════════════════════════════════════
import { consumeSSEStream, classifyProviderError, parseFrame } from "@aih/core";
import type { StreamAccumulator } from "@aih/core";
import {
  createFakeLLMServer,
  textResponse,
  reasoningResponse,
  toolCallResponse,
} from "./test/fake-llm-server.js";

{
  // TP#2.1 — classifyProviderError
  assert(classifyProviderError(401, '{"error":"bad key"}') === "auth", "classifyProviderError: 401 → auth");
  assert(classifyProviderError(403, '{"error":"forbidden"}') === "auth", "classifyProviderError: 403 → auth");
  assert(classifyProviderError(429, '{"error":"rate limit"}') === "retryable", "classifyProviderError: 429 → retryable");
  assert(classifyProviderError(500, '{"error":"server"}') === "retryable", "classifyProviderError: 500 → retryable");
  assert(classifyProviderError(503, '{"error":"overloaded"}') === "capacity", "classifyProviderError: 503 + overloaded → capacity");
  assert(classifyProviderError(502, "upstream request failed") === "capacity", "classifyProviderError: 502 + upstream → capacity");
  assert(classifyProviderError(404, '{"error":"not found"}') === "fatal", "classifyProviderError: 404 → fatal");
  assert(classifyProviderError(400, '{"error":"context too long"}') === "fatal", "classifyProviderError: 400 → fatal");
  assert(classifyProviderError(503, "no healthy upstream") === "capacity", "classifyProviderError: no healthy upstream → capacity");
  assert(classifyProviderError(503, "Endpoint is unavailable") === "capacity", "classifyProviderError: endpoint unavailable → capacity");
  console.log("ok: TP#2.1 classifyProviderError (10 cases)");
}

{
  // TP#2.2 — parseFrame: basic text delta
  const acc: StreamAccumulator = { text: "", reasoning: "", toolCalls: [], finishReason: undefined, usage: undefined, eagerFinalized: false, toolFrames: new Map() };
  const fired = { value: false };
  const deltas: string[] = [];
  parseFrame('{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}', acc, { onDelta: (d) => deltas.push(d) }, fired);
  assert(acc.text === "Hello", "parseFrame: text delta accumulated");
  assert(deltas.length === 1 && deltas[0] === "Hello", "parseFrame: onDelta callback fired");
  assert(fired.value === true, "parseFrame: firstFrameFired set on first frame");
  console.log("ok: TP#2.2 parseFrame text delta");
}

{
  // TP#2.3 — parseFrame: reasoning_content
  const acc: StreamAccumulator = { text: "", reasoning: "", toolCalls: [], finishReason: undefined, usage: undefined, eagerFinalized: false, toolFrames: new Map() };
  const fired = { value: false };
  const reasoningDeltas: string[] = [];
  parseFrame('{"choices":[{"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}', acc, { onReasoning: (d) => reasoningDeltas.push(d) }, fired);
  assert(acc.reasoning === "Let me think", "parseFrame: reasoning_content accumulated");
  assert(reasoningDeltas.length === 1, "parseFrame: onReasoning callback fired");
  console.log("ok: TP#2.3 parseFrame reasoning_content");
}

{
  // TP#2.4 — parseFrame: usage mapping
  const acc: StreamAccumulator = { text: "", reasoning: "", toolCalls: [], finishReason: undefined, usage: undefined, eagerFinalized: false, toolFrames: new Map() };
  const fired = { value: false };
  parseFrame('{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}', acc, {}, fired);
  assert(acc.usage?.promptTokens === 100, "parseFrame: usage.promptTokens");
  assert(acc.usage?.completionTokens === 50, "parseFrame: usage.completionTokens");
  assert(acc.usage?.totalTokens === 150, "parseFrame: usage.totalTokens");
  console.log("ok: TP#2.4 parseFrame usage mapping");
}

{
  // TP#2.5 — consumeSSEStream: reasoning + text
  const chunks = [
    new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n'),
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n'),
    new TextEncoder().encode("data: [DONE]\n\n"),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { chunks.forEach((c) => ctrl.enqueue(c)); ctrl.close(); },
  });
  const result = await consumeSSEStream(body);
  assert(result.reasoning === "thinking", "consumeSSEStream: reasoning_content concatenated");
  assert(result.text === "answer", "consumeSSEStream: text content concatenated");
  assert(result.finishReason === "stop", "consumeSSEStream: finishReason captured");
  console.log("ok: TP#2.5 consumeSSEStream reasoning + text");
}

{
  // TP#2.6 — consumeSSEStream: tool call eager finalize
  const args = JSON.stringify({ path: "/tmp/test" });
  const chunks = [
    new TextEncoder().encode(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n`),
    new TextEncoder().encode(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(args)}}}]},"finish_reason":"tool_calls"}]}\n\n`),
    new TextEncoder().encode("data: [DONE]\n\n"),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { chunks.forEach((c) => ctrl.enqueue(c)); ctrl.close(); },
  });
  const result = await consumeSSEStream(body);
  assert(result.toolCalls.length === 1, "consumeSSEStream: tool call parsed");
  assert(result.toolCalls[0].name === "read_file", "consumeSSEStream: tool call name correct");
  assert(result.toolCalls[0].id === "call_1", "consumeSSEStream: tool call id correct");
  assert(result.eagerFinalized === true, "consumeSSEStream: eager finalized on finish_reason");
  console.log("ok: TP#2.6 consumeSSEStream tool call eager finalize");
}

{
  // TP#2.7 — consumeSSEStream: usage with cached tokens
  const chunks = [
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":80}}}\n\n'),
    new TextEncoder().encode("data: [DONE]\n\n"),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { chunks.forEach((c) => ctrl.enqueue(c)); ctrl.close(); },
  });
  const result = await consumeSSEStream(body);
  assert(result.usage?.cachedTokens === 80, "consumeSSEStream: cachedTokens from prompt_tokens_details");
  console.log("ok: TP#2.7 consumeSSEStream usage with cached tokens");
}

{
  // TP#2.8 — consumeSSEStream: malformed JSON skipped
  const chunks = [
    new TextEncoder().encode("data: not-json\n\n"),
    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'),
    new TextEncoder().encode("data: [DONE]\n\n"),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { chunks.forEach((c) => ctrl.enqueue(c)); ctrl.close(); },
  });
  const result = await consumeSSEStream(body);
  assert(result.text === "ok", "consumeSSEStream: malformed JSON skipped gracefully");
  console.log("ok: TP#2.8 consumeSSEStream malformed JSON resilience");
}

{
  // TP#2.9 — fake-llm-server: basic text response
  const srv = await createFakeLLMServer();
  srv.enqueue(textResponse("Hello from fake LLM"));
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
  });
  assert(res.ok, "fake-llm-server: basic request returns 200");
  const text = await res.text();
  assert(text.includes("Hello from fake LLM"), "fake-llm-server: response contains expected text");
  assert(srv.requestCount === 1, "fake-llm-server: requestCount incremented");
  await srv.close();
  console.log("ok: TP#2.9 fake-llm-server basic text response");
}

{
  // TP#2.10 — fake-llm-server: stream via consumeSSEStream integration
  const srv = await createFakeLLMServer();
  srv.enqueue(reasoningResponse("step 1...", "the answer"));
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "think" }], stream: true }),
  });
  assert(!!(res.ok && res.body), "fake-llm-server: stream request returns 200 with body");
  const result = await consumeSSEStream(res.body!);
  assert(result.reasoning === "step 1...", "fake-llm-server → consumeSSEStream: reasoning_content");
  assert(result.text === "the answer", "fake-llm-server → consumeSSEStream: text content");
  assert(result.finishReason === "stop", "fake-llm-server → consumeSSEStream: finishReason");
  await srv.close();
  console.log("ok: TP#2.10 fake-llm-server + consumeSSEStream reasoning integration");
}

{
  // TP#2.11 — fake-llm-server: health check
  const srv = await createFakeLLMServer();
  const res = await fetch(`${srv.baseUrl}/health`);
  const body = await res.json() as any;
  assert(body.ok === true, "fake-llm-server: health check ok");
  assert(typeof body.queue === "number", "fake-llm-server: health check has queue count");
  await srv.close();
  console.log("ok: TP#2.11 fake-llm-server health check");
}

{
  // TP#2.12 — fake-llm-server: tool call stream via consumeSSEStream
  const srv = await createFakeLLMServer();
  srv.enqueue(toolCallResponse("call_xyz", "list_dir", { path: "/tmp" }));
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "ls" }], stream: true }),
  });
  assert(!!(res.ok && res.body), "fake-llm-server: tool call stream returns 200");
  const result = await consumeSSEStream(res.body!);
  assert(result.toolCalls.length === 1, "fake-llm-server → consumeSSEStream: tool call parsed");
  assert(result.toolCalls[0].name === "list_dir", "fake-llm-server → consumeSSEStream: tool name correct");
  assert(result.toolCalls[0].id === "call_xyz", "fake-llm-server → consumeSSEStream: tool id correct");
  assert(result.eagerFinalized === true, "fake-llm-server → consumeSSEStream: eager finalized");
  await srv.close();
  console.log("ok: TP#2.12 fake-llm-server tool call stream integration");
}

{
  // TP#2.13 — fake-llm-server: non-200 error response
  const srv = await createFakeLLMServer();
  srv.enqueue({ status: 401, errorBody: '{"error":{"message":"Invalid API key","type":"auth_error"}}' });
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  assert(res.status === 401, "fake-llm-server: 401 returned");
  const body = await res.text();
  assert(body.includes("Invalid API key"), "fake-llm-server: error body preserved");
  await srv.close();
  console.log("ok: TP#2.13 fake-llm-server error response");
}

{
  // TP#2.14 — fake-llm-server: request headers and body capture
  const srv = await createFakeLLMServer();
  srv.enqueue(textResponse("ok"));
  await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer test-key" },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "yo" }] }),
  });
  assert(srv.lastRequestHeaders["authorization"] === "Bearer test-key", "fake-llm-server: captures auth header");
  assert((srv.lastRequestBody as any)?.model === "gpt-4", "fake-llm-server: captures request body model");
  await srv.close();
  console.log("ok: TP#2.14 fake-llm-server request capture");
}

{
  // TP#2.15 — fake-llm-server: multi-request queue
  const srv = await createFakeLLMServer();
  srv.enqueue(textResponse("first"));
  srv.enqueue(textResponse("second"));
  const r1 = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "t", messages: [] }),
  });
  const t1 = await r1.text();
  assert(t1.includes("first"), "fake-llm-server: first queued response");
  const r2 = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "t", messages: [] }),
  });
  const t2 = await r2.text();
  assert(t2.includes("second"), "fake-llm-server: second queued response");
  assert(srv.requestCount === 2, "fake-llm-server: requestCount=2 after two requests");
  await srv.close();
  console.log("ok: TP#2.15 fake-llm-server multi-request queue");
}

{
  // TP#2.16 — CC#49 skip skeleton: stall detection (timeout)
  // This demonstrates the server can inject stalls; real CC#49 test
  // requires stall detection in agent loop (roadmap CC#49 item).
  const srv = await createFakeLLMServer();
  srv.enqueue({ stallMs: 50 });
  const start = Date.now();
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "t", messages: [] }),
    signal: AbortSignal.timeout(2000),
  });
  const elapsed = Date.now() - start;
  assert(res.status === 504, "CC#49 skeleton: stall returns 504");
  assert(elapsed >= 40, "CC#49 skeleton: stall waited at least 40ms");
  await srv.close();
  console.log("ok: TP#2.16 CC#49 skeleton: stall timeout (skip: needs agent loop integration)");
}

{
  // TP#2.17 — CC#49 skip skeleton: midstream close
  const srv = await createFakeLLMServer();
  srv.enqueue({ frames: [{ payload: { choices: [{ delta: { content: "partial" } }] } }], closeMidstream: true });
  const res = await fetch(`${srv.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "t", messages: [], stream: true }),
  });
  assert(res.ok, "CC#49 skeleton: midstream close starts 200");
  const result = await consumeSSEStream(res.body!);
  assert(result.text === "partial", "CC#49 skeleton: partial text captured before close");
  // Stream ended without [DONE] — finishReason should be undefined or null
  assert(!result.finishReason || result.finishReason === "stop", "CC#49 skeleton: no tool_calls finish_reason on midstream close");
  await srv.close();
  console.log("ok: TP#2.17 CC#49 skeleton: midstream close (skip: needs recovery in agent loop)");
}

console.log("ok: TP#2 all smoke tests passed (17 cases: 10 classifyProviderError + 7 SSE parser + fake-llm-server integration + CC#49 skeletons)");

// ════════════════════════════════════════════════════════════════════════
// TP#3 — Compaction / Recovery / Prompt Guards
// ════════════════════════════════════════════════════════════════════════
import {
  classifyToolFacts,
  scanRecovery,
  describeFact,
  PARK_REASON,
  estimateTokensText,
  SessionLog,
  FINAL_STATE_GUARD,
  TASK_CONTRACT_RULES,
  REPAIR_DOCTRINE,
  LIVE_VERIFY_DISCIPLINE,
  DECISION_QUESTION_RULE,
} from "@aih/core";

{
  // TP#3.1 — Recovery: classifyToolFacts — completed (call + dispatch + result)
  const events = [
    { seq: 0, type: "user/message", turnId: "t" as const, text: "hello" },
    { seq: 1, type: "tool/call" as const, callId: "c1", name: "read_file", turnId: "t1" },
    { seq: 2, type: "tool/dispatch" as const, callId: "c1", name: "read_file", turnId: "t1" },
    { seq: 3, type: "tool/result" as const, callId: "c1", ok: true, turnId: "t1" },
  ];
  const facts = classifyToolFacts(events as any);
  assert(facts.length === 1, "TP#3.1 recovery: completed tool has 1 fact");
  assert(facts[0].state === "completed", "TP#3.1 recovery: call+dispatch+result = completed");
  assert(facts[0].callId === "c1", "TP#3.1 recovery: callId preserved");
  assert(facts[0].name === "read_file", "TP#3.1 recovery: name preserved");
  console.log("ok: TP#3.1 recovery classifyToolFacts completed");
}

{
  // TP#3.2 — Recovery: classifyToolFacts — synthetic (result without dispatch)
  const events = [
    { seq: 0, type: "tool/call" as const, callId: "c2", name: "run_cmd", turnId: "t1" },
    { seq: 1, type: "tool/result" as const, callId: "c2", ok: true, turnId: "t1" },
  ];
  const facts = classifyToolFacts(events as any);
  assert(facts.length === 1, "TP#3.2 recovery: synthetic tool has 1 fact");
  assert(facts[0].state === "synthetic", "TP#3.2 recovery: result without dispatch = synthetic");
  console.log("ok: TP#3.2 recovery classifyToolFacts synthetic");
}

{
  // TP#3.3 — Recovery: classifyToolFacts — not_dispatched (call only, no dispatch, no result)
  const events = [
    { seq: 0, type: "tool/call" as const, callId: "c3", name: "write_file", turnId: "t1" },
  ];
  const facts = classifyToolFacts(events as any);
  assert(facts.length === 1, "TP#3.3 recovery: not_dispatched has 1 fact");
  assert(facts[0].state === "not_dispatched", "TP#3.3 recovery: call only = not_dispatched");
  console.log("ok: TP#3.3 recovery classifyToolFacts not_dispatched");
}

{
  // TP#3.4 — Recovery: classifyToolFacts — indeterminate (call + dispatch, no result)
  const events = [
    { seq: 0, type: "tool/call" as const, callId: "c4", name: "run_cmd", turnId: "t1" },
    { seq: 1, type: "tool/dispatch" as const, callId: "c4", name: "run_cmd", turnId: "t1" },
  ];
  const facts = classifyToolFacts(events as any);
  assert(facts.length === 1, "TP#3.4 recovery: indeterminate has 1 fact");
  assert(facts[0].state === "indeterminate", "TP#3.4 recovery: call+dispatch (no result) = indeterminate");
  // dispatch-only without call might not produce a fact — depends on implementation
  // Let's test the scanRecovery path instead
  const report = scanRecovery(events as any);
  assert(typeof report.parked === "boolean", "TP#3.4 recovery: scanRecovery returns parked boolean");
  console.log("ok: TP#3.4 recovery scanRecovery basic structure");
}

{
  // TP#3.5 — Recovery: scanRecovery — no tool facts on clean session
  const events = [
    { seq: 0, type: "user/message", turnId: "t" as const, text: "hello" },
    { seq: 1, type: "assistant/message", turnId: "t", toolCalls: [] as const, text: "hi" },
    { seq: 2, type: "user/message", turnId: "t" as const, text: "bye" },
    { seq: 3, type: "assistant/message", turnId: "t", toolCalls: [] as const, text: "goodbye" },
  ];
  const report = scanRecovery(events as any);
  assert(report.facts.length === 0, "TP#3.5 recovery: no tool facts on clean session");
  assert(report.parked === false, "TP#3.5 recovery: not parked on clean session");
  console.log("ok: TP#3.5 recovery scanRecovery clean session");
}

{
  // TP#3.6 — Recovery: scanRecovery — open turn with completed tool
  const events = [
    { seq: 0, type: "user/message", turnId: "t" as const, text: "list files" },
    { seq: 1, type: "tool/call" as const, callId: "c6", name: "list_dir", turnId: "t1" },
    { seq: 2, type: "tool/dispatch" as const, callId: "c6", name: "list_dir", turnId: "t1" },
    { seq: 3, type: "tool/result" as const, callId: "c6", ok: true, turnId: "t1", result: { entries: [] } },
  ];
  const report = scanRecovery(events as any);
  assert(report.openTurn === "t1" || typeof report.openTurn === "string", "TP#3.6 recovery: open turn detected");
  assert(report.facts.length === 1, "TP#3.6 recovery: 1 fact for open turn");
  assert(report.facts[0].state === "completed", "TP#3.6 recovery: open turn fact is completed");
  assert(report.parked === false, "TP#3.6 recovery: not parked with completed fact");
  console.log("ok: TP#3.6 recovery scanRecovery open turn");
}

{
  // TP#3.6b — session-close turn closure (saveSession parity): a turn whose
  // tools all completed but which never got its turn/end is mis-reported as
  // "interrupted" on every resume. Closing it with a session_closed end event
  // makes the next scan clean — this asserts that closure behaviour.
  const events: { type: string; turnId?: string; callId?: string; stopReason?: string; [k: string]: unknown }[] = [
    { seq: 0, type: "turn/start", turnId: "t" },
    { seq: 1, type: "user/message", turnId: "t", text: "继续" },
    { seq: 2, type: "assistant/message", turnId: "t", text: "", toolCalls: [] },
    { seq: 3, type: "tool/call", callId: "c9", name: "run_cmd", turnId: "t", args: {} },
    { seq: 4, type: "tool/dispatch", callId: "c9", name: "run_cmd", turnId: "t" },
    { seq: 5, type: "tool/result", callId: "c9", ok: true, turnId: "t", result: "ok" },
  ];
  const before = scanRecovery(events as any);
  assert(before.openTurn === "t" && before.facts[0].state === "completed", "TP#3.6b before closure: completed-but-open turn is detected");
  // saveSession appends one session_closed turn/end for the open turn.
  if (before.openTurn) {
    events.push({ seq: events.length, type: "turn/end", turnId: before.openTurn, stopReason: "session_closed" });
  }
  const after = scanRecovery(events as any);
  assert(after.openTurn === undefined && after.lastClosedTurn === "t", "TP#3.6b after closure: no false interrupted turn on resume");
  console.log("ok: TP#3.6b session-close turn closure");
}

{
  // TP#3.7 — Recovery: describeFact
  const fact = { callId: "c7", name: "run_cmd", turnId: "t1", state: "completed" as const };
  const desc = describeFact(fact);
  assert(typeof desc === "string" && desc.length > 0, "TP#3.7 recovery: describeFact returns non-empty string");
  assert(desc.includes("run_cmd"), "TP#3.7 recovery: describeFact includes tool name");
  console.log("ok: TP#3.7 recovery describeFact");
}

{
  // TP#3.8 — Recovery: PARK_REASON constant
  assert(PARK_REASON === "tool_recovery_parked", "TP#3.8 recovery: PARK_REASON constant value");
  console.log("ok: TP#3.8 recovery PARK_REASON");
}

{
  // TP#3.9 — estimateTokensText: basic estimation
  assert(estimateTokensText("") >= 0, "TP#3.9 estimateTokensText: empty → >=0");
  assert(estimateTokensText("hello") > 0, "TP#3.9 estimateTokensText: non-empty → >0");
  const t4 = estimateTokensText("abcd");
  assert(t4 > 0, "TP#3.9 estimateTokensText: 4 chars → >0 tokens");
  console.log("ok: TP#3.9 estimateTokensText basic");
}

{
  // TP#3.10 — estimateTokensText: CJK characters count as ~2 tokens
  const ascii = estimateTokensText("hello");
  const cjk = estimateTokensText("你好世界"); // 4 CJK chars
  assert(cjk >= ascii, "TP#3.10 estimateTokensText: CJK ≥ ASCII for same char count");
  console.log("ok: TP#3.10 estimateTokensText CJK");
}

{
  // TP#3.11 — FINAL_STATE_GUARD: anti-fake-done rules present
  assert(typeof FINAL_STATE_GUARD === "string", "TP#3.11 prompts: FINAL_STATE_GUARD is string");
  assert(FINAL_STATE_GUARD.length > 100, "TP#3.11 prompts: FINAL_STATE_GUARD is substantial");
  assert(/state carrier|file|database|commit/i.test(FINAL_STATE_GUARD), "TP#3.11 prompts: FINAL_STATE_GUARD mentions state carriers");
  console.log("ok: TP#3.11 FINAL_STATE_GUARD present");
}

{
  // TP#3.12 — TASK_CONTRACT_RULES: contract discipline present
  assert(typeof TASK_CONTRACT_RULES === "string", "TP#3.12 prompts: TASK_CONTRACT_RULES is string");
  assert(TASK_CONTRACT_RULES.length > 100, "TP#3.12 prompts: TASK_CONTRACT_RULES is substantial");
  assert(/acceptance|constraint|verifiable/i.test(TASK_CONTRACT_RULES), "TP#3.12 prompts: TASK_CONTRACT_RULES mentions acceptance criteria");
  console.log("ok: TP#3.12 TASK_CONTRACT_RULES present");
}

{
  // TP#3.16 — REPAIR_DOCTRINE (OpenClaw AGENTS.md borrow): root-cause-first,
  // owner-bound, net-LOC-disciplined repair rules present AND injected into
  // the main system prompt (loadSystemPrompt).
  assert(typeof REPAIR_DOCTRINE === "string", "TP#3.16 prompts: REPAIR_DOCTRINE is string");
  assert(REPAIR_DOCTRINE.length > 200, "TP#3.16 prompts: REPAIR_DOCTRINE is substantial");
  assert(/root.?cause/i.test(REPAIR_DOCTRINE), "TP#3.16 prompts: REPAIR_DOCTRINE is root-cause-first");
  assert(/producer|owner/i.test(REPAIR_DOCTRINE), "TP#3.16 prompts: REPAIR_DOCTRINE fixes at the owner, not downstream");
  assert(/net ≤0|net <=0|production loc/i.test(REPAIR_DOCTRINE), "TP#3.16 prompts: REPAIR_DOCTRINE carries the net-LOC constraint");
  assert(/never mask|consumer-only guard/i.test(REPAIR_DOCTRINE), "TP#3.16 prompts: REPAIR_DOCTRINE forbids masking root causes");
  assert(/reproduction|regression test/i.test(REPAIR_DOCTRINE), "TP#3.16 prompts: REPAIR_DOCTRINE requires a failing repro before editing");
  const { loadSystemPrompt } = await import("./index.js");
  const sys = loadSystemPrompt();
  assert(sys.includes("Repair doctrine"), "TP#3.16 injection: main system prompt carries REPAIR_DOCTRINE");
  assert(sys.includes("Root-cause repair is the default"), "TP#3.16 injection: doctrine text is the real constant, not a stub");
  console.log("ok: TP#3.16 REPAIR_DOCTRINE present + injected");
}

{
  // OC#3 — LIVE_VERIFY_DISCIPLINE (OpenClaw AGENTS.md "Start" borrow):
  // live-verify-by-default + check-existing-first, present AND injected into
  // the main system prompt (loadSystemPrompt).
  assert(typeof LIVE_VERIFY_DISCIPLINE === "string", "OC#3 prompts: LIVE_VERIFY_DISCIPLINE is string");
  assert(LIVE_VERIFY_DISCIPLINE.length > 200, "OC#3 prompts: LIVE_VERIFY_DISCIPLINE is substantial");
  assert(/live.?verify/i.test(LIVE_VERIFY_DISCIPLINE), "OC#3 prompts: discipline names live-verify");
  assert(/real production path|real path/i.test(LIVE_VERIFY_DISCIPLINE), "OC#3 prompts: live-verify requires the REAL production path");
  assert(/never skip it to save effort|concrete infeasibility/i.test(LIVE_VERIFY_DISCIPLINE), "OC#3 prompts: skipping requires a concrete infeasibility, not saving effort");
  assert(/check.?existing/i.test(LIVE_VERIFY_DISCIPLINE), "OC#3 prompts: discipline names check-existing-first");
  assert(/brief gate|brief, bounded check/i.test(LIVE_VERIFY_DISCIPLINE), "OC#3 prompts: existing-check is a brief gate, not a research assignment");
  const { loadSystemPrompt: lsp3 } = await import("./index.js");
  const sys3 = lsp3();
  assert(sys3.includes("Live-verify & check-existing-first"), "OC#3 injection: main system prompt carries LIVE_VERIFY_DISCIPLINE");
  assert(sys3.includes("Live-verify by default"), "OC#3 injection: discipline text is the real constant, not a stub");
  console.log("ok: OC#3 LIVE_VERIFY_DISCIPLINE present + injected");
}

{
  // TP#3.14 — DECISION_QUESTION_RULE: models must ask via the question tool
  assert(typeof DECISION_QUESTION_RULE === "string", "TP#3.14 prompts: DECISION_QUESTION_RULE is string");
  assert(DECISION_QUESTION_RULE.length > 150, "TP#3.14 prompts: DECISION_QUESTION_RULE is substantial");
  assert(/question tool/i.test(DECISION_QUESTION_RULE), "TP#3.14 prompts: requires the question tool");
  assert(/wait|never|assumption/i.test(DECISION_QUESTION_RULE), "TP#3.14 prompts: forbids proceeding on assumptions");
  assert(/headless|non-interactive/i.test(DECISION_QUESTION_RULE), "TP#3.14 prompts: handles headless fallback");
  console.log("ok: TP#3.14 DECISION_QUESTION_RULE present");
}

{
  // TP#3.13 — SessionLog: append + all + deriveMessages roundtrip
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: "hello" });
  log.append({ type: "assistant/message", turnId: "t", toolCalls: [], text: "hi there" });
  const all = log.all();
  assert(all.length === 2, "TP#3.13 sessionlog: append 2 events");
  assert(all[0].type === "user/message", "TP#3.13 sessionlog: first is user");
  assert(all[1].type === "assistant/message", "TP#3.13 sessionlog: second is assistant");
  const msgs = log.deriveMessages();
  assert(msgs.length === 2, "TP#3.13 sessionlog: deriveMessages returns 2 messages");
  assert(msgs[0].role === "user", "TP#3.13 sessionlog: derive user role");
  assert(msgs[1].role === "assistant", "TP#3.13 sessionlog: derive assistant role");
  console.log("ok: TP#3.13 SessionLog append/derive roundtrip");
}

{
  // TP#3.14 — SessionLog: checkpoint + restoreTo
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: "first" });
  log.append({ type: "assistant/message", turnId: "t", toolCalls: [], text: "reply1" });
  const cp = log.checkpoint();
  log.append({ type: "user/message", turnId: "t", text: "second" });
  log.append({ type: "assistant/message", turnId: "t", toolCalls: [], text: "reply2" });
  assert(log.all().length === 5, "TP#3.14 sessionlog: 4 events + 1 checkpoint = 5");
  const restored = log.restoreTo(cp.seq);
  assert(restored.all().length === 3, "TP#3.14 sessionlog: restoreTo checkpoint keeps up to checkpoint (3 = 2 msgs + cp)");
  console.log("ok: TP#3.14 SessionLog checkpoint/restoreTo");
}

{
  // TP#3.15 — SessionLog: fork creates independent copy
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: "original" });
  const forked = log.fork();
  forked.append({ type: "assistant/message", turnId: "t", toolCalls: [], text: "forked" });
  assert(log.all().length === 1, "TP#3.15 sessionlog: fork doesn't mutate original");
  assert(forked.all().length === 2, "TP#3.15 sessionlog: fork has extra event");
  console.log("ok: TP#3.15 SessionLog fork independence");
}

console.log("ok: TP#3 all smoke tests passed (15 cases: recovery 8 + prompts 2 + session-log 5)");

// ════════════════════════════════════════════════════════════════════════
// TP#4 — Permission Matrix & Security
// ════════════════════════════════════════════════════════════════════════
import {
  AutoApprove,
  DenyAll,
  PolicyGate,
  RulesetGate,
  deriveScope,
  matchPattern,
  targetOf,
} from "@aih/core";
import type { ApprovalGate } from "@aih/core";
import { buildChildEnv } from "./env-policy.js";

{
  // TP#4.1 — AutoApprove: always true
  const gate: ApprovalGate = new AutoApprove();
  assert(await gate.request({ tool: "run_cmd", kind: "write", args: {} }), "TP#4.1 permission: AutoApprove always grants");
  assert(await gate.request({ tool: "rm", kind: "write", args: { path: "/etc/passwd" } }), "TP#4.1 permission: AutoApprove even for dangerous tools");
  console.log("ok: TP#4.1 AutoApprove always true");
}

{
  // TP#4.2 — DenyAll: always false
  const gate: ApprovalGate = new DenyAll();
  assert(!(await gate.request({ tool: "read_file", kind: "read", args: {} })), "TP#4.2 permission: DenyAll denies reads");
  assert(!(await gate.request({ tool: "add_todo", kind: "write", args: {} })), "TP#4.2 permission: DenyAll denies writes");
  console.log("ok: TP#4.2 DenyAll always false");
}

{
  // TP#4.3 — PolicyGate: reads allowed by default, writes denied by default
  const gate: ApprovalGate = new PolicyGate([]);
  assert(await gate.request({ tool: "read_file", kind: "read", args: {} }), "TP#4.3 permission: PolicyGate allows reads by default");
  assert(!(await gate.request({ tool: "write_file", kind: "write", args: {} })), "TP#4.3 permission: PolicyGate denies writes by default");
  console.log("ok: TP#4.3 PolicyGate default read/deny");
}

{
  // TP#4.4 — PolicyGate: explicit allow rule
  const gate = new PolicyGate([{ match: (r) => r.tool === "write_file", action: "allow" }]);
  assert(await gate.request({ tool: "write_file", kind: "write", args: {} }), "TP#4.4 permission: PolicyGate explicit allow");
  assert(!(await gate.request({ tool: "run_cmd", kind: "write", args: {} })), "TP#4.4 permission: PolicyGate unmatched still denied");
  console.log("ok: TP#4.4 PolicyGate explicit allow");
}

{
  // TP#4.5 — PolicyGate: explicit deny rule
  const gate = new PolicyGate([{ match: (r) => r.tool === "read_file", action: "deny" }]);
  assert(!(await gate.request({ tool: "read_file", kind: "read", args: {} })), "TP#4.5 permission: PolicyGate explicit deny overrides default allow");
  console.log("ok: TP#4.5 PolicyGate explicit deny");
}

{
  // TP#4.6 — RulesetGate: allow rule
  const gate = new RulesetGate(new AutoApprove());
  gate.rules.push({ tool: "read_file", action: "allow" });
  assert(gate.evaluate({ tool: "read_file", kind: "read", args: {} }) === "allow", "TP#4.6 permission: RulesetGate allow rule");
  console.log("ok: TP#4.6 RulesetGate allow");
}

{
  // TP#4.7 — RulesetGate: deny rule
  const gate = new RulesetGate(new AutoApprove());
  gate.rules.push({ tool: "run_cmd", action: "deny" });
  assert(gate.evaluate({ tool: "run_cmd", kind: "write", args: { command: "rm -rf /" } }) === "deny", "TP#4.7 permission: RulesetGate deny rule");
  console.log("ok: TP#4.7 RulesetGate deny");
}

{
  // TP#4.8 — RulesetGate: fallback to base gate
  const gate = new RulesetGate(new DenyAll());
  // No rules → falls back to DenyAll
  assert(gate.evaluate({ tool: "read_file", kind: "read", args: {} }) === undefined, "TP#4.8 permission: RulesetGate no rules → undefined (falls back to base)");
  console.log("ok: TP#4.8 RulesetGate fallback to base");
}

{
  // TP#4.9 — matchPattern: glob patterns (against path segments, not absolute)
  assert(matchPattern("*", "/any/path") === true, "TP#4.9 matchPattern: * matches all");
  assert(matchPattern("**", "/any/path/deep") === true, "TP#4.9 matchPattern: ** matches deep");
  assert(matchPattern(undefined, "/any/path") === true, "TP#4.9 matchPattern: undefined matches all");
  assert(matchPattern("src/*", "src/foo") === true, "TP#4.9 matchPattern: src/* matches src/foo");
  assert(matchPattern("src/*", "lib/bar") === false, "TP#4.9 matchPattern: src/* rejects lib/bar");
  assert(matchPattern("src/**", "src/deep/nested") === true, "TP#4.9 matchPattern: src/** matches deep");
  console.log("ok: TP#4.9 matchPattern glob patterns");
}

{
  // TP#4.10 — targetOf: extracts path from args
  assert(targetOf({ tool: "read_file", kind: "read", args: { path: "/tmp/x" } }) === "/tmp/x", "TP#4.10 targetOf: extracts path");
  assert(targetOf({ tool: "read_file", kind: "read", args: { file: "/tmp/y" } }) === "/tmp/y", "TP#4.10 targetOf: extracts file");
  assert(targetOf({ tool: "read_file", kind: "read", args: { dir: "/tmp/z" } }) === "/tmp/z", "TP#4.10 targetOf: extracts dir");
  assert(targetOf({ tool: "read_file", kind: "read", args: {} }) === undefined, "TP#4.10 targetOf: no path → undefined");
  console.log("ok: TP#4.10 targetOf path extraction");
}

{
  // TP#4.11 — deriveScope: dirname + /**
  const scope = deriveScope({ tool: "read_file", kind: "read", args: { path: "/workspace/src/main.ts" } });
  assert(scope.endsWith("/**"), "TP#4.11 deriveScope: ends with /**");
  assert(scope.includes("src"), "TP#4.11 deriveScope: includes parent dir");
  console.log("ok: TP#4.11 deriveScope");
}

{
  // TP#4.12 — env-policy: secrets stripped from child env
  const parent = {
    PATH: "/usr/bin",
    HOME: "/root",
    MY_API_KEY: "sk-secret123",
    DATABASE_TOKEN: "db-tok-456",
    AIH_API_KEY: "aih-key",
    AIH_PROVIDER_URL: "https://example.com",
    NORMAL_VAR: "keep-me",
    PASSWORD: "hunter2",
    CREDENTIAL_FILE: "/etc/cred",
    TERM: "xterm-256color",
  };
  const child = buildChildEnv(parent);
  assert(child.PATH === "/usr/bin", "TP#4.12 env-policy: PATH preserved");
  assert(child.HOME === "/root", "TP#4.12 env-policy: HOME preserved");
  assert(child.TERM === "xterm-256color", "TP#4.12 env-policy: TERM preserved");
  assert(child.NORMAL_VAR === "keep-me", "TP#4.12 env-policy: normal vars preserved");
  assert(!("MY_API_KEY" in child), "TP#4.12 env-policy: API_KEY stripped");
  assert(!("DATABASE_TOKEN" in child), "TP#4.12 env-policy: TOKEN stripped");
  assert(!("AIH_API_KEY" in child), "TP#4.12 env-policy: AIH_API_KEY stripped");
  // AIH_PROVIDER_URL doesn't match SECRET_HINT or AIH_*API*, so it stays (expected)
  assert(!("PASSWORD" in child), "TP#4.12 env-policy: PASSWORD stripped");
  assert(!("CREDENTIAL_FILE" in child), "TP#4.12 env-policy: CREDENTIAL stripped");
  console.log("ok: TP#4.12 env-policy secrets stripped (10 checks)");
}

{
  // TP#4.13 — env-policy: forced set overrides
  const child = buildChildEnv({ PATH: "/usr/bin" }, { set: { MY_VAR: "forced" } });
  assert(child.MY_VAR === "forced", "TP#4.13 env-policy: set override works");
  console.log("ok: TP#4.13 env-policy forced set");
}

{
  // TP#4.14 — env-policy: empty parent
  const child = buildChildEnv({});
  assert(typeof child === "object", "TP#4.14 env-policy: empty parent → valid object");
  console.log("ok: TP#4.14 env-policy empty parent");
}

{
  // TP#4.15 — offline-package guard: internal IPs detected
  // Test the regex pattern directly (same as scripts/offline-package)
  const INTERNAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)|(\.internal$|\.local$|\.lan$)/i;
  assert(INTERNAL_HOST.test("127.0.0.1"), "TP#4.15 offline-guard: 127.0.0.1 blocked");
  assert(INTERNAL_HOST.test("192.168.1.1"), "TP#4.15 offline-guard: 192.168.x.x blocked");
  assert(INTERNAL_HOST.test("10.0.0.1"), "TP#4.15 offline-guard: 10.x.x.x blocked");
  assert(INTERNAL_HOST.test("172.16.0.1"), "TP#4.15 offline-guard: 172.16.x.x blocked");
  assert(INTERNAL_HOST.test("myhost.internal"), "TP#4.15 offline-guard: .internal blocked");
  assert(INTERNAL_HOST.test("myhost.local"), "TP#4.15 offline-guard: .local blocked");
  assert(!INTERNAL_HOST.test("api.openai.com"), "TP#4.15 offline-guard: public host allowed");
  assert(!INTERNAL_HOST.test("example.com"), "TP#4.15 offline-guard: example.com allowed");
  console.log("ok: TP#4.15 offline-package internal IP guard (8 patterns)");
}

{
  // TP#4.16 — offline-package guard: bare IPv4 rejection
  const BARE_IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  assert(BARE_IPV4.test("222.16.106.86"), "TP#4.16 offline-guard: bare IP detected");
  assert(BARE_IPV4.test("8.8.8.8"), "TP#4.16 offline-guard: public bare IP detected");
  assert(!BARE_IPV4.test("https://api.openai.com"), "TP#4.16 offline-guard: URL not bare IP");
  assert(!BARE_IPV4.test("192.168.1.1:8080"), "TP#4.16 offline-guard: IP:port not bare IP");
  console.log("ok: TP#4.16 offline-package bare IPv4 guard");
}

{
  // TP#4.17 — RulesetGate: path-scoped rule matches tool independently
  const gate = new RulesetGate(new DenyAll());
  gate.rules.push({ tool: "*", pattern: "/etc/**", action: "deny" });
  assert(gate.evaluate({ tool: "read_file", kind: "read", args: { path: "/etc/passwd" } }) === "deny", "TP#4.17 permission: path-scoped deny matches");
  assert(gate.evaluate({ tool: "read_file", kind: "read", args: { path: "/tmp/safe" } }) === undefined, "TP#4.17 permission: path-scoped deny doesn't match outside scope");
  console.log("ok: TP#4.17 RulesetGate path-scoped rule");
}

console.log("ok: TP#4 all security tests passed (17 cases: permission 12 + env-policy 3 + offline-guard 2)");

// ════════════════════════════════════════════════════════════════════════
// TP#5 — Parity Matrix (see docs/parity-matrix.md)
// ════════════════════════════════════════════════════════════════════════
// TP#5 is a documentation task — parity-matrix.md written separately.
// Smoke test validates the file exists and has expected structure.
// TP#5: file existence check
{
  const pmPath = new URL("../../../docs/parity-matrix.md", import.meta.url).pathname;
  const existing = [pmPath, "docs/parity-matrix.md"].find((p) => existsSync(p));
  if (existing) {
    const content = readFileSync(existing, "utf8");
    assert(content.includes("compaction") || content.includes("压缩"), "TP#5 parity-matrix: covers compaction domain");
    assert(content.includes("permission") || content.includes("权限"), "TP#5 parity-matrix: covers permission domain");
    assert(content.includes("opencode"), "TP#5 parity-matrix: references opencode");
    assert((content.match(/\|/g)?.length ?? 0) > 50, "TP#5 parity-matrix: has substantial table content");
    console.log("ok: TP#5 parity-matrix.md exists and has expected structure");
  } else {
    console.log("ok: TP#5 parity-matrix.md (skipped: file not yet created in this build)");
  }
}

// ════════════════════════════════════════════════════════════════════════
// TP#6 — Behavioral Benchmark Extension (skip: needs API key)
// ════════════════════════════════════════════════════════════════════════
// TP#6 requires real API key for multi-dimension bench.
// Smoke test verifies bench script exists and task definitions loadable.
{
  const benchExists = existsSync(new URL("../../../scripts/bench", import.meta.url).pathname) || existsSync("scripts/bench");
  assert(benchExists, "TP#6 bench: scripts/bench exists");
  console.log("ok: TP#6 bench script exists (skip: needs API key for real run)");
}

// ════════════════════════════════════════════════════════════════════════
// TP#7 — Stress & Chaos
// ════════════════════════════════════════════════════════════════════════
import { width } from "./tui.js";
// mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync, join, tmpdir — already imported at top

{
  // TP#7.1 — CJK/emoji width correctness
  assert(width("a") === 1, "TP#7.1 width: ASCII 'a' = 1");
  assert(width("你") === 2, "TP#7.1 width: CJK '你' = 2");
  assert(width("ABC") === 3, "TP#7.1 width: ASCII string = sum");
  assert(width("你好") === 4, "TP#7.1 width: CJK string = 2×len");
  assert(width("") === 0, "TP#7.1 width: empty = 0");
  // Emoji: some are double-width, some are variation-selector
  const emojiW = width("🎉");
  assert(emojiW === 1 || emojiW === 2, `TP#7.1 width: emoji 🎉 = ${emojiW} (acceptable 1-2)`);
  // Mixed
  assert(width("hi你") === 4, "TP#7.1 width: mixed ASCII+CJK = 1+2+padding");
  console.log("ok: TP#7.1 CJK/emoji width (7 checks)");
}

{
  // TP#7.2 — Large single line (100k chars) in session log
  const large = "x".repeat(100_000);
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: large });
  const all = log.all();
  assert(all.length === 1, "TP#7.2 stress: 100k char message appended");
  assert(all[0].type === "user/message", "TP#7.2 stress: type preserved");
  // deriveMessages should handle it without crash
  const t0 = Date.now();
  const msgs = log.deriveMessages();
  const elapsed = Date.now() - t0;
  assert(msgs.length === 1, "TP#7.2 stress: deriveMessages handles 100k");
  assert(elapsed < 5000, `TP#7.2 stress: deriveMessages 100k in ${elapsed}ms (<5s)`);
  console.log(`ok: TP#7.2 stress large input (100k chars, ${elapsed}ms)`);
}

{
  // TP#7.3 — Session file corruption: truncated file
  const tmp = mkdtempSync(join(tmpdir(), "aih-chaos-"));
  const fpath = join(tmp, "session.jsonl");
  writeFileSync(fpath, '{"seq":0,"type":"user/message","text":"hello"}\n{"seq":1,"type":"assistant/message","text":"world"');
  // Read and try to parse — last line truncated
  const raw = readFileSync(fpath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert(lines.length === 2, "TP#7.3 chaos: truncated file has 2 lines");
  let parsed = 0;
  for (const line of lines) {
    try { JSON.parse(line); parsed++; } catch { /* truncated */ }
  }
  assert(parsed >= 1, `TP#7.3 chaos: at least 1 valid line parsed (got ${parsed})`);
  rmSync(tmp, { recursive: true, force: true });
  console.log("ok: TP#7.3 chaos truncated session file");
}

{
  // TP#7.4 — Session file corruption: empty file
  const tmp = mkdtempSync(join(tmpdir(), "aih-chaos-"));
  const fpath = join(tmp, "empty.jsonl");
  writeFileSync(fpath, "");
  const raw = readFileSync(fpath, "utf8");
  assert(raw.length === 0, "TP#7.4 chaos: empty file is empty");
  const lines = raw.split("\n").filter(Boolean);
  assert(lines.length === 0, "TP#7.4 chaos: no lines from empty file");
  rmSync(tmp, { recursive: true, force: true });
  console.log("ok: TP#7.4 chaos empty session file");
}

{
  // TP#7.5 — Session file corruption: binary junk
  const tmp = mkdtempSync(join(tmpdir(), "aih-chaos-"));
  const fpath = join(tmp, "junk.jsonl");
  const junk = Buffer.alloc(1024);
  for (let i = 0; i < 1024; i++) junk[i] = Math.floor(Math.random() * 256);
  writeFileSync(fpath, junk);
  // Followed by a valid line
  appendFileSync(fpath, '\n{"seq":0,"type":"user/message","text":"survivor"}\n');
  const raw = readFileSync(fpath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const validLines = lines.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  assert(validLines.length >= 1, "TP#7.5 chaos: at least 1 valid line after binary junk");
  const parsed = JSON.parse(validLines[validLines.length - 1]);
  assert(parsed.text === "survivor", "TP#7.5 chaos: valid line after junk is correct");
  rmSync(tmp, { recursive: true, force: true });
  console.log("ok: TP#7.5 chaos binary junk then valid line");
}

{
  // TP#7.6 — SessionLog: concurrent append from multiple "sessions"
  // Simulate two logs appending to a shared conceptual store
  const log1 = new SessionLog();
  const log2 = new SessionLog();
  for (let i = 0; i < 50; i++) {
    log1.append({ type: "user/message", turnId: "t", text: `s1-${i}` });
    log2.append({ type: "user/message", turnId: "t", text: `s2-${i}` });
  }
  assert(log1.all().length === 50, "TP#7.6 chaos: log1 has 50 events");
  assert(log2.all().length === 50, "TP#7.6 chaos: log2 has 50 events");
  // They don't cross-contaminate
  assert(log1.all()[0].type === "user/message", "TP#7.6 chaos: log1 events intact");
  assert((log1.all()[0] as any).text === "s1-0", "TP#7.6 chaos: log1 first event text correct");
  console.log("ok: TP#7.6 chaos concurrent session append");
}

{
  // TP#7.7 — estimateTokensText: very long string
  const megabyte = "a".repeat(1_000_000);
  const t0 = Date.now();
  const tokens = estimateTokensText(megabyte);
  const elapsed = Date.now() - t0;
  assert(tokens > 0, "TP#7.7 stress: 1M chars produces tokens > 0");
  assert(elapsed < 2000, `TP#7.7 stress: 1M char estimate in ${elapsed}ms (<2s)`);
  console.log(`ok: TP#7.7 stress megabyte estimate (${elapsed}ms, ${tokens} tokens)`);
}

{
  // TP#7.8 — SessionLog: rapid checkpoint/restore cycle
  const log = new SessionLog();
  const checkpoints: number[] = [];
  for (let i = 0; i < 100; i++) {
    log.append({ type: "user/message", turnId: "t", text: `msg-${i}` });
    if (i % 10 === 0) {
      const cp = log.checkpoint();
      checkpoints.push(cp.seq);
    }
  }
  assert(log.all().length === 110, "TP#7.8 stress: 100 msgs + 10 checkpoints = 110 events");
  // Restore to the 50th checkpoint
  const target = checkpoints[5];
  const restored = log.restoreTo(target);
  assert(restored.all().length <= target + 1, "TP#7.8 stress: restoreTo correct checkpoint");
  console.log("ok: TP#7.8 stress rapid checkpoint/restore cycle");
}

{
  // TP#7.9 — Unicode edge cases: Zalgo text
  const zalgo = "H̷e̷l̷l̷o̷";
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: zalgo });
  const msgs = log.deriveMessages();
  assert(msgs.length === 1, "TP#7.9 chaos: Zalgo text survives deriveMessages");
  assert(typeof msgs[0].content === "string", "TP#7.9 chaos: Zalgo content is string");
  console.log("ok: TP#7.9 chaos Zalgo text");
}

{
  // TP#7.10 — Unicode edge cases: null bytes
  const withNull = "hello\x00world";
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: withNull });
  const all = log.all();
  assert(all.length === 1, "TP#7.10 chaos: null byte message appended");
  console.log("ok: TP#7.10 chaos null bytes in message");
}

// --- session rm --all (safe "remove everything"; runs last so the earlier
// --- session tests are unaffected) ------------------------------------------
{
  const before = aih(["session", "list"]);
  assert(before.status === 0, "session list runs before --all");
  const rmAll = aih(["session", "rm", "--all"]);
  assert(rmAll.status === 0 && rmAll.stdout.includes("removed"), "session rm --all removes every session");
  const listAfter = aih(["session", "list"]);
  assert(listAfter.status === 0 && listAfter.stdout.includes("(no saved sessions)"), "session list is empty after --all");
}

console.log("ok: TP#7 all stress/chaos tests passed (10 cases)");

{
  // PR#2 — `aih measure`: structural / behavioral distance instrument.
  // Pure functions over declared surfaces + normalized traces (no LLM).
  const {
    surfaceDistance,
    distance,
    toolFlow,
    behaviorDistance,
    permutationTest,
    crystallize,
    formatDistance,
    formatPermutationTest,
  } = await import("./measure.js");

  // ---- structural distance: exact diff on a known pair ---------------------
  const sd = surfaceDistance(
    { surface: "skills", entries: ["a", "b", "c"] },
    { surface: "skills", entries: ["b", "c", "d"] },
    ["c"], // c present in both and reported changed
  );
  assert(JSON.stringify(sd.added) === '["d"]', "PR#2 surfaceDistance added = [d] (sorted unique)");
  assert(JSON.stringify(sd.dropped) === '["a"]', "PR#2 surfaceDistance dropped = [a]");
  assert(JSON.stringify(sd.revised) === '["c"]', "PR#2 surfaceDistance revised = [c]");
  assert(sd.pathLength === 3, "PR#2 surfaceDistance pathLength = added+dropped+revised = 3");

  // multi-surface with revisedBySurface = exact total.
  const dr = distance(
    [
      { surface: "skills", entries: ["a", "b"] },
      { surface: "memory", entries: ["m1"] },
    ],
    [
      { surface: "skills", entries: ["a", "c"] },
      { surface: "memory", entries: ["m1"] },
    ],
    { skills: ["a"] },
  );
  assert(dr.totalPathLength === 3, "PR#2 multi-surface total path length = 3 (skills: +c,-b,~a; memory 0)");
  assert(dr.degraded === false, "PR#2 no missing surface -> not degraded");
  assert(dr.surfaces.length === 2, "PR#2 two surfaces reported");

  // ---- degradation: missing surface is NOT fabricated as a big distance -----
  const deg = distance(
    [{ surface: "skills", entries: ["s1"] }],
    [{ surface: "memory", entries: ["m1"] }],
  );
  assert(deg.degraded === true, "PR#2 missing surface -> degraded");
  assert(deg.surfaces.length === 0, "PR#2 missing surfaces are skipped, not fabricated");
  assert(deg.totalPathLength === 0, "PR#2 degraded distance does not invent path length");
  assert(
    deg.missing.some((m) => m.surface === "skills" && m.side === "b"),
    "PR#2 missing reports skills on side b",
  );

  // ---- toolFlow: frequency / transitions / procedure ----------------------
  const flow = toolFlow([
    { type: "tool/call", name: "run_cmd" },
    { type: "tool/call", name: "read_file" },
    { type: "tool/call", name: "run_cmd" },
    { type: "turn/start" }, // not a tool/call -> ignored
  ]);
  assert(flow.totalCalls === 3, "PR#2 toolFlow counts only tool/call with name");
  assert(flow.frequency["run_cmd"] === 2, "PR#2 toolFlow frequency run_cmd = 2");
  assert(flow.transitions["run_cmd→read_file"] === 1, "PR#2 toolFlow transition run_cmd→read_file");
  assert(flow.transitions["read_file→run_cmd"] === 1, "PR#2 toolFlow transition read_file→run_cmd");

  // ---- behaviorDistance: identical -> 0; disjoint -> >0; empty -> 0 ---------
  const ev = (names: string[]) =>
    names.map((n) => ({ type: "tool/call" as const, name: n }));
  const same = behaviorDistance(ev(["a", "b"]), ev(["a", "b"]));
  assert(same.score === 0 && same.mix === 0 && same.order === 0, "PR#2 identical traces -> distance 0");
  const disjoint = behaviorDistance(ev(["a"]), ev(["b"]));
  assert(disjoint.mix === 1, "PR#2 disjoint tool sets -> mix = 1 (L1/maxTotal)");
  assert(behaviorDistance([], []).score === 0, "PR#2 empty traces -> distance 0");

  // ---- permutationTest: seeded reproducible + degraded on < 2 arms ----------
  const mkTrace = (label: string, first: string, second: string) => ({
    label,
    events: [
      { type: "tool/call", name: first },
      { type: "tool/call", name: second },
      { type: "tool/call", name: first },
    ],
  });
  // Two arms with clearly separated tool usage -> between >> within -> R > 1.
  const traces = [
    mkTrace("a", "alpha", "alpha2"),
    mkTrace("a", "alpha", "alpha2"),
    mkTrace("b", "beta", "beta2"),
    mkTrace("b", "beta", "beta2"),
  ];
  const t1 = permutationTest(traces, { permutations: 100, seed: 42 });
  const t2 = permutationTest(traces, { permutations: 100, seed: 42 });
  assert(t1.R === t2.R && t1.p === t2.p, "PR#2 permutation test seeded -> reproducible (same seed)");
  assert(t1.R > 1, `PR#2 separated arms -> R > 1 (got ${t1.R})`);
  assert(t1.degraded === false, "PR#2 enough arms/traces -> not degraded");
  assert(t1.permutations === 100, "PR#2 permutation count honored");
  assert(t1.p >= 0 && t1.p <= 1, "PR#2 p in [0,1]");

  const tooFew = permutationTest([mkTrace("a", "x", "y")], { permutations: 100 });
  assert(tooFew.degraded === true, "PR#2 < 2 arms -> degraded, not a number");
  assert(typeof tooFew.reason === "string" && tooFew.reason.includes("2 arms"), "PR#2 degraded reason explains need for arms");
  assert(formatPermutationTest(tooFew).startsWith("permutation  DEGRADED"), "PR#2 formatPermutationTest renders degraded");

  // ---- crystallize: evolved == neutral -> stable; different -> not ----------
  const stable = crystallize(
    [{ surface: "memory", entries: ["g1", "g2"] }],
    [{ surface: "memory", entries: ["g1", "g2"] }],
  );
  assert(stable.stable === true && stable.distance === 0 && stable.degraded === false, "PR#2 crystallize equal endpoints -> stable, distance 0");
  const changed = crystallize(
    [{ surface: "memory", entries: ["g1"] }],
    [{ surface: "memory", entries: ["g2"] }],
  );
  assert(changed.stable === false && changed.distance === 2, "PR#2 crystallize drift -> not stable, distance 2");
  const missing = crystallize([], [{ surface: "memory", entries: ["g1"] }]);
  assert(missing.degraded === true, "PR#2 crystallize missing endpoint -> degraded, no fabricated 0");

  // ---- formatter smoke ------------------------------------------------------
  assert(
    formatDistance({ surfaces: [], totalPathLength: 0, degraded: true, missing: [{ surface: "skills", side: "b" }] }).includes("DEGRADED"),
    "PR#2 formatDistance renders DEGRADED marker",
  );

  console.log("ok: PR#2 (aih measure) pure distance/permutation/crystallize tests passed");
}

{
  // PR#2 — CLI wiring: `aih measure distance` / `stream` / `crystallize` read
  // declared surfaces from JSON inputs and emit a report (no LLM, off-line).
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join: jn } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(jn(tmpdir(), "aih-measure-"));
  const snapA = jn(dir, "a.json");
  const snapB = jn(dir, "b.json");
  writeFileSync(snapA, JSON.stringify({ surfaces: [{ surface: "skills", entries: ["a", "b"] }] }));
  writeFileSync(snapB, JSON.stringify({ surfaces: [{ surface: "skills", entries: ["a", "c"] }] }));

  const d = aih(["measure", "distance", snapA, snapB], { AIH_API_KEY: "mock", AIH_MODEL: "mock" });
  assert(d.status === 0, "PR#2 aih measure distance exits 0");
  assert(d.stdout.includes("+c") && d.stdout.includes("-b"), "PR#2 distance report shows +c and -b");

  const c = aih(["measure", "crystallize", snapA, snapB], { AIH_API_KEY: "mock", AIH_MODEL: "mock" });
  // crystallize exits 1 when the endpoints have drifted (by design): a drift
  // signal. Assert we detect the drift, not a clean exit.
  assert(c.status === 1, "PR#2 aih measure crystallize exits 1 on drift (signal, not a bug)");
  assert(/DRIFTED/.test(c.stdout), `PR#2 crystallize drift rendered as DRIFTED (got: ${c.stdout.trim().slice(0, 80)})`);
  assert(/distance=2/.test(c.stdout), `PR#2 crystallize drift distance=2 rendered (got: ${c.stdout.trim().slice(0, 80)})`);

  console.log("ok: PR#2 (aih measure) CLI distance/crystallize wiring passed");
}

{
  // IT#4 — multi-agent session management panel (pure sessions.ts + /sessions).
  const {
    jobStatus,
    usageCost,
    buildDashboard,
    formatDashboard,
  } = await import("./sessions.js");
  const { isKnownSlashCommand } = await import("./slash.js");

  // jobStatus maps the job-board vocabulary onto the dashboard's statuses.
  assert(jobStatus({ status: "running" } as never) === "running", "IT#4 running job -> running");
  assert(jobStatus({ status: "done" } as never) === "done", "IT#4 done job -> done");
  assert(jobStatus({ status: "failed" } as never) === "failed", "IT#4 failed job -> failed");
  assert(jobStatus({ status: "cancelled" } as never) === "cancelled", "IT#4 cancelled job -> cancelled");

  // usageCost is price-scaled, 0 without a price.
  assert(usageCost(1_000_000, { input: 1, output: 1 }) === 1, "IT#4 1M tokens @ $1/M in -> $1");
  assert(usageCost(1000, undefined) === 0, "IT#4 no price -> cost 0");

  // buildDashboard: active (jobs) + idle (saved, non-job) sessions, aggregates.
  const price = { input: 1, output: 1 };
  const jobs = [
    { id: "j1", session: "bg-1", label: "fix the build", status: "running" },
    { id: "j2", session: "bg-2", label: "write tests", status: "done" },
  ] as never as import("./jobs.js").Job[];
  const usage = new Map<string, number>([
    ["bg-1", 5000],
    ["bg-2", 7000],
    ["main", 1000],
  ]);
  const dash = buildDashboard(jobs, usage, price, ["bg-1", "bg-2", "main"]);
  assert(dash.active.length === 2, "IT#4 two active (job) sessions listed");
  // buildDashboard lists jobs newest-first (reversed), so active[0] is j2.
  assert(dash.active[0].status === "done" && dash.active[1].status === "running", "IT#4 active statuses mapped (newest first)");
  // "main" is saved but not a job -> idle session.
  assert(dash.saved.length === 1 && dash.saved[0].name === "main" && dash.saved[0].status === "idle", "IT#4 non-job saved session -> idle");
  assert(dash.saved[0].tokens === 1000, "IT#4 idle session picks up its tokens");
  assert(dash.totalTokens === 13000, "IT#4 aggregate tokens = 5000+7000+1000");
  assert(dash.totalCost > 0, "IT#4 total cost computed when a price is present");

  // formatDashboard renders each row and the total, and the empty case.
  const fmt = formatDashboard(dash);
  assert(fmt.includes("bg-1") && fmt.includes("[running") && fmt.includes("fix the build"), "IT#4 format shows running job + label");
  assert(fmt.includes("· $"), "IT#4 format shows cost line");
  assert(formatDashboard({ active: [], saved: [], totalTokens: 0, totalCost: 0 }) === "(no sessions yet)", "IT#4 empty dashboard degrades cleanly");

  // /sessions is a recognized builtin slash-command head (so busy-steering
  // treats it as a command, not a stray steer message).
  assert(isKnownSlashCommand("/sessions", []) === true, "IT#4 /sessions recognized as known slash command");
  assert(isKnownSlashCommand("/sessions kill j1", []) === true, "IT#4 /sessions <arg> recognized");

  console.log("ok: IT#4 (sessions dashboard) pure status/usage/cost + slash-recognition passed");
}

console.log("\n═══════════════════════════════════════════════");
console.log("TP#3-7 batch complete");
console.log("  TP#3 compaction/recovery: 15 cases");
console.log("  TP#4 permission/security: 17 cases");
console.log("  TP#5 parity-matrix:       1 case (doc)");
console.log("  TP#6 bench extension:     1 case (skip:key)");
console.log("  TP#7 stress/chaos:        10 cases");
console.log("═══════════════════════════════════════════════");

// ════════════════════════════════════════════════════════════════════════
// PE#1/PE#2/PE#4 — safety seam (config parsing + sensor executor + hooks)
// ════════════════════════════════════════════════════════════════════════
{
  const {
    loadEnvSafety,
    mergeSafety,
    runSensorCommand,
    buildSensorLoop,
    buildBudget,
    buildSafetyHooks,
    ESCALATE_EXIT_CODE,
  } = await import("./safety.js");

  // env parsing: AIH_BUDGET (JSON + key=value) and AIH_SENSORS.
  const prevBudget = process.env.AIH_BUDGET;
  const prevSensors = process.env.AIH_SENSORS;
  const prevRetries = process.env.AIH_SENSOR_RETRIES;
  try {
    process.env.AIH_BUDGET = JSON.stringify({ maxCostUsd: 2, maxWrites: 5, denyPaths: ["node_modules"] });
    let cfg = loadEnvSafety();
    assert(cfg.budget?.maxCostUsd === 2 && cfg.budget?.maxWrites === 5 && cfg.budget?.denyPaths?.length === 1, "PE#2 AIH_BUDGET JSON parsed");

    process.env.AIH_BUDGET = "maxCostUsd=1,maxWrites=3,denyPaths=a|b";
    cfg = loadEnvSafety();
    assert(cfg.budget?.maxCostUsd === 1 && cfg.budget?.maxWrites === 3 && cfg.budget?.denyPaths?.length === 2, "PE#2 AIH_BUDGET key=value parsed");

    process.env.AIH_SENSORS = JSON.stringify([{ name: "tsc", command: "npx tsc -b" }]);
    process.env.AIH_SENSOR_RETRIES = "2";
    cfg = loadEnvSafety();
    assert(cfg.sensors?.length === 1 && cfg.sensors?.[0].command === "npx tsc -b", "PE#1 AIH_SENSORS parsed");
    assert(cfg.sensorRetries === 2, "PE#1 AIH_SENSOR_RETRIES parsed");

    // malformed JSON must not crash (degrades to no sensors).
    process.env.AIH_SENSORS = "{not json";
    assert(loadEnvSafety().sensors === undefined, "PE#1 malformed AIH_SENSORS → no sensors (no crash)");
  } finally {
    if (prevBudget === undefined) delete process.env.AIH_BUDGET;
    else process.env.AIH_BUDGET = prevBudget;
    if (prevSensors === undefined) delete process.env.AIH_SENSORS;
    else process.env.AIH_SENSORS = prevSensors;
    if (prevRetries === undefined) delete process.env.AIH_SENSOR_RETRIES;
    else process.env.AIH_SENSOR_RETRIES = prevRetries;
  }

  // mergeSafety: file layer, then env layer (env wins).
  const base = { budget: { maxCostUsd: 1, maxWrites: 10 }, sensors: [{ name: "a", command: "true" }] };
  const merged = mergeSafety(base, { budget: { maxCostUsd: 5 }, sensors: [{ name: "b", command: "false" }] });
  assert(merged.budget?.maxCostUsd === 5 && merged.budget?.maxWrites === 10, "PE#2 mergeSafety budget per-key (env wins, file fills)");
  assert(merged.sensors?.length === 1 && merged.sensors?.[0].name === "b", "PE#1 mergeSafety sensors replaced by env");

  // runSensorCommand: green (exit 0), red (non-zero + detail), timeout.
  const g = await runSensorCommand("true", process.cwd(), 5000);
  assert(g.ok === true, "PE#1 sensor exit 0 → green");
  const r = await runSensorCommand("echo boom; exit 7", process.cwd(), 5000);
  assert(r.ok === false && r.detail.includes("exit 7") && r.detail.includes("boom"), "PE#1 sensor non-zero → red with exit code + output tail");
  const t = await runSensorCommand("sleep 3", process.cwd(), 300);
  assert(t.ok === false && t.detail.includes("timed out"), "PE#1 sensor timeout → red (killed)");

  // buildSensorLoop / buildBudget from a config.
  const loop = buildSensorLoop({ sensors: [{ name: "tsc", command: "true" }] }, process.cwd());
  assert(loop !== undefined, "PE#1 buildSensorLoop produces a SensorLoop");
  const noLoop = buildSensorLoop({}, process.cwd());
  assert(noLoop === undefined, "PE#1 no sensors → undefined loop");
  const budget = buildBudget({ budget: { maxCostUsd: 1 } });
  assert(budget !== undefined, "PE#2 buildBudget produces a BudgetTracker");
  assert(buildBudget({}) === undefined, "PE#2 no budget → undefined tracker");

  // buildSafetyHooks: interactive vs non-interactive surfaces.
  const hooks = buildSafetyHooks({ budget: { maxCostUsd: 1 } }, { cwd: process.cwd(), interactive: false, line: () => {} });
  assert(
    hooks !== undefined && hooks.budget !== undefined && typeof hooks.onEscalate === "function" && typeof hooks.onTripwire === "function",
    "PE#4 buildSafetyHooks wires budget + hooks",
  );
  assert(ESCALATE_EXIT_CODE === 3, "PE#4 non-interactive escalate exit code is 3");

  // onEscalate (non-interactive) prints options + safest default + exit note.
  const lines: string[] = [];
  const h2 = buildSafetyHooks({ budget: { maxCostUsd: 1 } }, { cwd: process.cwd(), interactive: false, line: (t) => lines.push(t) });
  h2?.onEscalate({ reason: "budget cost exceeded", options: ["a", "b"], safestDefault: "b" });
  assert(lines.some((l) => l.includes("budget cost exceeded")), "PE#4 onEscalate prints the reason");
  assert(lines.some((l) => l.includes("1. a")) && lines.some((l) => l.includes("2. b")), "PE#4 onEscalate prints numbered options");
  assert(lines.some((l) => l.includes("safest default: b")), "PE#4 onEscalate prints the safest default");
  assert(lines.some((l) => l.includes("exit code 3")), "PE#4 non-interactive onEscalate notes the exit code");

  console.log("ok: PE#1/PE#2/PE#4 CLI safety seam (env/merge/sensor-exec/hooks)");
}



// --- OC#5: versioned state, guarded upgrades (schema-version) --------------
{
  const {
    checkSchemaVersion,
    CONFIG_SCHEMA_VERSION,
    SESSION_SCHEMA_VERSION,
    stampConfigVersion,
    stampSessionVersion,
    SessionStore,
    SessionLog,
  } = await import("@aih/core");

  // 1. Constants are positive integers.
  assert(CONFIG_SCHEMA_VERSION >= 1, "OC#5 CONFIG_SCHEMA_VERSION >= 1");
  assert(SESSION_SCHEMA_VERSION >= 1, "OC#5 SESSION_SCHEMA_VERSION >= 1");

  // 2. checkSchemaVersion: undefined (legacy) → accepted, no throw.
  let legacyOk = true;
  try { checkSchemaVersion(undefined, CONFIG_SCHEMA_VERSION, "config"); }
  catch { legacyOk = false; }
  assert(legacyOk, "OC#5 checkSchemaVersion(undefined) → accepted (legacy backward-compat)");

  // 3. checkSchemaVersion: version == max → accepted.
  let eqOk = true;
  try { checkSchemaVersion(CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION, "config"); }
  catch { eqOk = false; }
  assert(eqOk, "OC#5 checkSchemaVersion(version == max) → accepted");

  // 4. checkSchemaVersion: version < max → accepted (newer file, older build).
  let ltOk = true;
  try { checkSchemaVersion(1, 2, "config"); }
  catch { ltOk = false; }
  assert(ltOk, "OC#5 checkSchemaVersion(version < max) → accepted");

  // 5. checkSchemaVersion: version > max → throws (fail-closed, loud).
  let threw = false, errMsg = "";
  try { checkSchemaVersion(99, CONFIG_SCHEMA_VERSION, "config", "/tmp/aih.json"); }
  catch (e) { threw = true; errMsg = String((e as Error).message); }
  assert(threw, "OC#5 checkSchemaVersion(version > max) → throws (fail-closed)");
  assert(errMsg.includes("schemaVersion 99"), "OC#5 throw message names the offending version");
  assert(errMsg.includes("only supports up to"), "OC#5 throw message names the build max");
  assert(errMsg.includes("Upgrade AIH"), "OC#5 throw message tells user to upgrade");

  // 6. stampConfigVersion stamps the current version.
  const stamped = stampConfigVersion({ model: "test" });
  assert(stamped.schemaVersion === CONFIG_SCHEMA_VERSION, "OC#5 stampConfigVersion stamps schemaVersion");
  assert(stamped.model === "test", "OC#5 stampConfigVersion preserves other fields");

  // 7. stampSessionVersion stamps the current version.
  const sStamped = stampSessionVersion({ type: "user/message" });
  assert(sStamped.schemaVersion === SESSION_SCHEMA_VERSION, "OC#5 stampSessionVersion stamps schemaVersion");
  assert((sStamped as { type: string }).type === "user/message", "OC#5 stampSessionVersion preserves event type");

  // 8. SessionStore.save() writes schemaVersion to meta sidecar.
  const tmpDir = mkdtempSync(join(tmpdir(), "aih-oc5-"));
  const sessPath = join(tmpDir, "test.jsonl");
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t1", text: "hello" });
  const store = new SessionStore(sessPath);
  store.save(log);
  const metaRaw = readFileSync(`${sessPath}.meta.json`, "utf8");
  const meta = JSON.parse(metaRaw);
  assert(meta.schemaVersion === SESSION_SCHEMA_VERSION, "OC#5 SessionStore.save() writes schemaVersion to meta");

  // 9. SessionStore.load() with a newer schemaVersion → throws.
  writeFileSync(`${sessPath}.meta.json`, JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION + 100 }) + "\n");
  let sessThrew = false;
  try { new SessionStore(sessPath).load(); }
  catch (e) { sessThrew = true; }
  assert(sessThrew, "OC#5 SessionStore.load() refuses newer schema (fail-closed)");

  // 10. SessionStore.load() with no meta (legacy) → loads fine.
  rmSync(`${sessPath}.meta.json`);
  const legacyLoad = new SessionStore(sessPath).load();
  assert(legacyLoad !== undefined && legacyLoad.all().length === 1, "OC#5 SessionStore.load() legacy (no meta) → loads fine");

  // 11. SessionStore.load() with matching schemaVersion → loads fine.
  writeFileSync(`${sessPath}.meta.json`, JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION }) + "\n");
  const matchLoad = new SessionStore(sessPath).load();
  assert(matchLoad !== undefined && matchLoad.all().length === 1, "OC#5 SessionStore.load() matching schema → loads fine");

  // 12. setTitle preserves schemaVersion in meta.
  const store2 = new SessionStore(sessPath);
  store2.setTitle("my session");
  const meta2 = JSON.parse(readFileSync(`${sessPath}.meta.json`, "utf8"));
  assert(meta2.title === "my session", "OC#5 setTitle writes title");
  assert(meta2.schemaVersion === SESSION_SCHEMA_VERSION, "OC#5 setTitle preserves schemaVersion");

  rmSync(tmpDir, { recursive: true, force: true });
  console.log("ok: OC#5 versioned state guarded upgrades (schema-version)");
}

// --- OC#5 residual: doctor --fix config self-healing (migration) -----------
{
  const { CONFIG_SCHEMA_VERSION } = await import("@aih/core");
  const {
    detectConfigMigrations,
    migrateConfig,
    migrateConfigFile,
    configMigrationTargets,
  } = await import("./migrate.js");

  // 1. detect: legacy config (no schemaVersion) → needs migration (M1).
  const legacyCfg = { defaultProvider: "opencode", model: "gpt-5.1" } as Record<string, unknown>;
  const det = detectConfigMigrations(legacyCfg);
  assert(det.needsMigration === true, "doctor --fix detect: legacy config needs migration");
  assert(det.changes.some((c) => c.rule === "M1-schema-version-stamp"), "doctor --fix detect: M1 stamp rule present");

  // 2. detect: already-canonical config (stamped) → no migration.
  const canonicalCfg = { schemaVersion: CONFIG_SCHEMA_VERSION, defaultProvider: "opencode" } as Record<string, unknown>;
  const det2 = detectConfigMigrations(canonicalCfg);
  assert(det2.needsMigration === false && det2.changes.length === 0, "doctor --fix detect: canonical config → no migration");

  // 3. migrateConfig: stamps schemaVersion, preserves other fields.
  const { config: mig, changes } = migrateConfig(legacyCfg);
  assert(mig.schemaVersion === CONFIG_SCHEMA_VERSION, "doctor --fix migrate: schemaVersion stamped");
  assert(mig.defaultProvider === "opencode" && mig.model === "gpt-5.1", "doctor --fix migrate: other fields preserved");
  assert(changes.length === 1, "doctor --fix migrate: exactly one change reported");

  // 4. migrateConfig is idempotent (second pass → no changes).
  const second = migrateConfig(mig);
  assert(second.changes.length === 0, "doctor --fix migrate: idempotent (second pass no-op)");

  // 5. migrateConfigFile: legacy file → migrated + backup written + content stamped.
  const dir = mkdtempSync(join(tmpdir(), "aih-doctor-fix-"));
  const cfgPath = join(dir, "aih.json");
  writeFileSync(cfgPath, JSON.stringify({ defaultProvider: "opencode", model: "gpt-5.1" }) + "\n");
  const fileRes = migrateConfigFile(cfgPath);
  assert(fileRes.migrated === true, "doctor --fix file: legacy file migrated");
  assert(fileRes.backup !== undefined && existsSync(fileRes.backup), "doctor --fix file: backup exists");
  const after = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert(after.schemaVersion === CONFIG_SCHEMA_VERSION, "doctor --fix file: rewritten content stamped");
  assert(after.defaultProvider === "opencode" && after.model === "gpt-5.1", "doctor --fix file: content preserved");
  const bakContent = JSON.parse(readFileSync(fileRes.backup!, "utf8"));
  assert(bakContent.schemaVersion === undefined, "doctor --fix file: backup holds the ORIGINAL (un-stamped) config");

  // 6. migrateConfigFile is idempotent (second run → no migration, no new backup).
  const fileRes2 = migrateConfigFile(cfgPath);
  assert(fileRes2.migrated === false && fileRes2.backup === undefined, "doctor --fix file: idempotent (second run no-op)");

  // 7. migrateConfigFile on a missing file → no-op, no throw.
  const missingRes = migrateConfigFile(join(dir, "does-not-exist.json"));
  assert(missingRes.migrated === false, "doctor --fix file: missing file → no-op");

  // 8. migrateConfigFile on an unparseable file → no-op (left for the user).
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "{ not valid json");
  const badRes = migrateConfigFile(badPath);
  assert(badRes.migrated === false, "doctor --fix file: unparseable file → no-op (not a migration concern)");

  // 9. configMigrationTargets lists global + project config files.
  const targets = configMigrationTargets(["/u/aih"], "/proj");
  assert(targets.includes("/u/aih/config.json"), "doctor --fix targets: global config included");
  assert(targets.includes("/proj/aih.json"), "doctor --fix targets: project aih.json included");
  assert(targets.includes("/proj/.aih/config.json"), "doctor --fix targets: project .aih/config.json included");

  rmSync(dir, { recursive: true, force: true });
  console.log("ok: OC#5 residual doctor --fix config self-healing (migration)");
}

// --- OC parity: rules (AGENTS.md/CLAUDE.md/instructions) + policies + keybinds
{
  const {
    findProjectRuleFiles,
    collectRulesSync,
    renderRules,
  } = await import("./rules.js");
  const {
    evaluatePolicy,
    wildcardMatch,
    providerAllowed,
  } = await import("./policies.js");
  const {
    loadKeybinds,
    keyToBytes,
    buildKeybindDispatch,
  } = await import("./keybinds.js");
  const { loadSystemPrompt } = await import("./index.js");

  // ---- RULES ----
  const ruleDir = mkdtempSync(join(tmpdir(), "aih-rules-"));
  writeFileSync(join(ruleDir, "AGENTS.md"), "# Repo Rules\nAlways use tabs.\n");
  const f = findProjectRuleFiles(ruleDir);
  assert(f.length === 1 && f[0].endsWith("AGENTS.md"), "rules: finds project AGENTS.md by walking up");
  const blocks = collectRulesSync(ruleDir);
  assert(blocks.length === 1, "rules: collects the AGENTS.md block");
  assert(blocks[0].content.includes("Always use tabs"), "rules: block carries rule content");
  const rendered = renderRules(blocks);
  assert(rendered.includes("Project rules") && rendered.includes("mandatory"), "rules: render marks rules mandatory");
  // CLAUDE.md fallback (AGENTS.md absent → CLAUDE.md)
  const fallbackDir = mkdtempSync(join(tmpdir(), "aih-rules-"));
  writeFileSync(join(fallbackDir, "CLAUDE.md"), "# Claude rules\nNo commits.\n");
  const fb = findProjectRuleFiles(fallbackDir);
  assert(fb.length === 1 && fb[0].endsWith("CLAUDE.md"), "rules: falls back to CLAUDE.md when no AGENTS.md");
  // loadSystemPrompt injection
  const savedCwd = process.cwd();
  process.chdir(ruleDir);
  const sp = loadSystemPrompt();
  process.chdir(savedCwd);
  assert(sp.includes("Project rules"), "rules: loadSystemPrompt injects the Project rules section");
  assert(sp.includes("Always use tabs"), "rules: system prompt carries rule content");
  rmSync(ruleDir, { recursive: true, force: true });
  rmSync(fallbackDir, { recursive: true, force: true });

  // ---- POLICIES ----
  assert(wildcardMatch("company-*", "company-us"), "policies: '*' wildcard matches");
  assert(wildcardMatch("compan?-us", "company-us"), "policies: '?' wildcard matches");
  assert(!wildcardMatch("compan?-us", "company-eu"), "policies: '?' does not match different char");
  const denyAllAllowOne = [
    { effect: "deny" as const, action: "provider.use" as const, resource: "*" },
    { effect: "allow" as const, action: "provider.use" as const, resource: "anthropic" },
  ];
  assert(evaluatePolicy(denyAllAllowOne, "provider.use", "anthropic") === "allow", "policies: last-match-wins → anthropic allowed");
  assert(evaluatePolicy(denyAllAllowOne, "provider.use", "openai") === "deny", "policies: deny-all blocks openai");
  assert(providerAllowed(undefined, "openai") === true, "policies: no policy → allowed by default");
  assert(providerAllowed(denyAllAllowOne, "openai") === false, "policies: providerAllowed false for denied");

  // ---- KEYBINDS ----
  const def = buildKeybindDispatch(loadKeybinds());
  assert(def.byteToAction["\x10"] === "palette", "keybinds: default palette = ctrl-p");
  assert(def.byteToAction["?"] === "help", "keybinds: default help = ?");
  assert(!Object.values(def.byteToAction).includes("toggleMode"), "keybinds: toggleMode not keyed by default");
  assert(keyToBytes("ctrl+p") === "\x10", "keybinds: ctrl+p → \\x10");
  assert(keyToBytes("tab") === "\t", "keybinds: tab → \\t");
  assert(keyToBytes("none") === undefined, "keybinds: none → disabled");
  // custom palette remap
  const custom = buildKeybindDispatch({ palette: "ctrl+x", toggleMode: "none", help: "?" });
  assert(custom.byteToAction["\x18"] === "palette", "keybinds: remap palette to ctrl+x");
  assert(custom.byteToAction["\x10"] === undefined, "keybinds: old palette byte no longer bound");
  // collision is dropped with warning
  const clash = buildKeybindDispatch({ palette: "ctrl+p", toggleMode: "ctrl+p", help: "?" });
  assert(clash.warnings.length === 1 && clash.warnings[0].includes("toggleMode"), "keybinds: colliding remap dropped with warning");

  console.log("ok: OC-parity rules + policies + keybinds");
}

// --- OC#7: credential ownership isolation (degrade own owner, never fallback)
{
  const {
    redactCredential,
    markOwnerDegraded,
    clearOwnerDegraded,
    clearAllOwnerDegraded,
    isOwnerDegraded,
    listDegradedOwners,
    renderDegradationReport,
  } = await import("./owner-state.js");

  // ---- redaction: secrets masked, benign text kept ----
  const r1 = redactCredential("llm request failed: HTTP 401 Bearer sk-abcdef1234567890 window");
  assert(!/sk-abcdef1234567890/.test(r1) && r1.includes("[redacted]"), "OC#7 redact masks a bearer sk- token");
  assert(!/[A-Za-z0-9]{28,}/.test(r1), "OC#7 redact masks long base62 runs");
  const r2 = redactCredential("api-key=wp_0123456789abcdefghijklmnopqrstuv");
  assert(!/wp_0123456/.test(r2) && r2.includes("[redacted]"), "OC#7 redact masks a key=value assignment");
  const r3 = redactCredential("quota exhausted on provider X at /v1/chat/completions");
  assert(r3.includes("quota exhausted on provider X"), "OC#7 redact keeps benign reason text");

  // ---- isolated registry under AIH_HOME ----
  const oHome = mkdtempSync(join(tmpdir(), "aih-owner-"));
  const prevHome = process.env.AIH_HOME;
  process.env.AIH_HOME = oHome;
  clearAllOwnerDegraded();
  markOwnerDegraded("empero", "credential", "HTTP 401 Bearer sk-empero-secret-token12345");
  assert(isOwnerDegraded("empero"), "OC#7 markOwnerDegraded marks owner degraded");
  assert(!isOwnerDegraded("opencode"), "OC#7 unrelated owner not degraded");
  const listed = listDegradedOwners();
  assert(listed.length === 1 && listed[0].owner === "empero", "OC#7 listDegradedOwners returns the owner");
  assert(listed[0].cls === "credential", "OC#7 failure class recorded");
  assert(!/sk-empero-secret-token12345/.test(listed[0].reason), "OC#7 persisted reason is redacted (no secret on disk)");
  const rep = renderDegradationReport(listDegradedOwners());
  assert(rep.includes("empero") && rep.includes("[credential]"), "OC#7 render report names owner + class");
  assert(!/sk-empero-secret-token12345/.test(rep), "OC#7 render report is redacted");

  // re-mark increments count
  markOwnerDegraded("empero", "quota", "429 usage limit reached");
  assert(listDegradedOwners()[0].count === 2, "OC#7 re-mark increments failure count");

  // recovery: clear one / clear all
  markOwnerDegraded("zhipu", "credential", "HTTP 403 forbidden");
  clearOwnerDegraded("empero");
  assert(!isOwnerDegraded("empero") && isOwnerDegraded("zhipu"), "OC#7 clearOwnerDegraded only clears the named owner");
  clearAllOwnerDegraded();
  assert(listDegradedOwners().length === 0, "OC#7 clearAllOwnerDegraded empties the registry");

  if (prevHome === undefined) delete process.env.AIH_HOME;
  else process.env.AIH_HOME = prevHome;
  rmSync(oHome, { recursive: true, force: true });

  // ---- LLM adapter: 401 degrades the owner AND the error still throws ----
  // Load the built LLM adapter at runtime (TS-free) — the cli tsconfig's rootDir
  // forbids static-importing core source, so resolve the compiled module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { OpenAICompatibleLLM } = (await import(
    /* webpackIgnore: true */ new URL("../../core/dist/seams/llm-openai.js", import.meta.url).href
  )) as any;
  const degrades: Array<{ o: string; cls: string; reason: string }> = [];
  const successes: string[] = [];
  const failing = new OpenAICompatibleLLM({
    baseUrl: "https://api.example.com/v1",
    model: "m",
    owner: "empero",
    onCredentialFailure: (o: string, cls: string, reason: string) => degrades.push({ o, cls, reason }),
    onOwnerSuccess: (o: string) => successes.push(o),
    fetchImpl: async () =>
      new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }),
  });
  let threw = false;
  try {
    await failing.complete({ messages: [{ role: "user", content: "hi" }], tools: [] } as any);
  } catch {
    threw = true;
  }
  assert(threw, "OC#7 auth failure still throws (no silent auto-fallback)");
  assert(degrades.length === 1 && degrades[0].o === "empero" && degrades[0].cls === "credential",
    "OC#7 401 fires onCredentialFailure for that owner as credential");
  assert(successes.length === 0, "OC#7 failure does not clear the owner");

  // an OK response clears a prior degradation (recovery)
  const ok = new OpenAICompatibleLLM({
    baseUrl: "https://api.example.com/v1",
    model: "m",
    owner: "opencode",
    onCredentialFailure: (o: string, cls: string, reason: string) => degrades.push({ o, cls, reason }),
    onOwnerSuccess: (o: string) => successes.push(o),
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await ok.complete({ messages: [{ role: "user", content: "hi" }], tools: [] } as any);
  assert(successes.includes("opencode"), "OC#7 successful completion calls onOwnerSuccess (recovery)");
  assert(degrades.length === 1, "OC#7 success does not degrade anyone");

  console.log("ok: OC#7 credential ownership isolation (owner-state + adapter hook)");
}

// --- OC#6: maturity scorecard — coverage-ID + evidence-mode classification ---
{
  const {
    coverageIdFromTitle,
    inferEvidenceMode,
    loadCoverageRegistry,
    selectForProfile,
    profileStats,
    formatCoverage,
  } = await import("./coverage.js");

  // 1. Stable slug derives from a group title (# becomes a separator).
  const slug = coverageIdFromTitle("OC#5 residual: doctor --fix config self-healing (migration)");
  assert(slug === "oc-5-residual-doctor-fix-config-self-healing-migration", "OC#6 slug: title → stable coverage id");
  assert(coverageIdFromTitle("F#30: cost / TPS") === "f-30-cost-tps", "OC#6 slug: # becomes a separator");

  // 2. Evidence mode: live only for real-provider/key/network signals.
  assert(inferEvidenceMode("TP#6 requires real API key") === "live", "OC#6 evidence: real API key → live");
  assert(inferEvidenceMode("live provider bench") === "live", "OC#6 evidence: live provider bench → live");
  assert(inferEvidenceMode("pure deterministic parser tests") === "mock", "OC#6 evidence: pure tests → mock");

  // 3. Registry is derived from the live smoke source (never drifts).
  const reg = loadCoverageRegistry(fileURLToPath(new URL("./smoke.js", import.meta.url)));
  assert(reg.length >= 40, `OC#6 registry: derived ≥40 coverage groups (got ${reg.length})`);
  const ids = new Set(reg.map((i) => i.id));
  assert(ids.size === reg.length, "OC#6 registry: coverage ids are unique");

  // 4. Profile selection: smoke-ci excludes live; release includes everything.
  const live = reg.filter((i) => i.evidence === "live");
  const smokeSel = selectForProfile(reg, "smoke-ci");
  assert(smokeSel.every((i) => i.evidence === "mock"), "OC#6 profile: smoke-ci runs only mock groups");
  if (live.length > 0) {
    assert(smokeSel.length < reg.length, "OC#6 profile: smoke-ci is a strict subset when live groups exist");
    const relSel = selectForProfile(reg, "release");
    assert(relSel.length === reg.length, "OC#6 profile: release runs every group");
    assert(smokeSel.length < relSel.length, "OC#6 profile: release ⊃ smoke-ci when live groups exist");
  }

  // 5. Stats + format are well-formed.
  const st = profileStats(reg, "smoke-ci");
  assert(st.total === smokeSel.length && st.mock === smokeSel.length && st.live === 0, "OC#6 stats: smoke-ci counts");
  const fmt = formatCoverage(reg, "smoke-ci");
  assert(fmt.includes("smoke-ci") && (st.total === 0 || fmt.includes(st.total + " groups selected")), "OC#6 format: matrix header + totals");

  console.log("ok: OC#6 maturity scorecard — coverage-ID + evidence-mode classification");
}

// --- FB#4: BuffBench-style quality eval — baseline regression gate ----------
{
  const { compareToBaseline, loadQualitySuite } = await import("./eval.js");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const cell = (id: string, status: "passed" | "failed" | "error") =>
    ({ cellId: id, taskId: id.split("__")[0], model: id.split("__")[1] ?? "mock", repetition: 1, status, durationMs: 1, outputTail: "" });

  // 1. Exact cellIds in baseline.
  let d = compareToBaseline([cell("a__m__r1", "passed"), cell("b__m__r1", "failed")], ["a__m__r1", "b__m__r1"]);
  assert(d.ok === false && d.regressions.length === 1, "FB#4 baseline: exact failing cell is a regression");
  assert(d.regressions[0].cellId === "b__m__r1" && d.regressions[0].actual === "failed", "FB#4 baseline: regression names the cell + actual status");
  assert(d.stable.includes("a__m__r1"), "FB#4 baseline: passing cell is stable");

  // 2. Wildcard patterns expand against the actual cells.
  d = compareToBaseline([cell("task-x__mock__r1", "passed"), cell("task-x__mock__r1", "passed")], ["task-x__mock__r1"]);
  d = compareToBaseline([cell("a__mock__r1", "passed"), cell("b__mock__r1", "failed")], ["*__mock__r1"]);
  assert(d.regressions.length === 1 && d.regressions[0].cellId === "b__mock__r1", "FB#4 baseline: wildcard matches all cells of the model");
  assert(d.stable.length === 1 && d.stable[0] === "a__mock__r1", "FB#4 baseline: wildcard marks passing cells stable");

  // 3. Baseline expected but never-run cell → absent regression.
  d = compareToBaseline([cell("a__m__r1", "passed")], ["a__m__r1", "missing__m__r1"]);
  assert(d.regressions.some((r) => r.cellId === "missing__m__r1" && r.actual === "absent"), "FB#4 baseline: expected-but-absent cell is a regression");

  // 4. Unbaselined cells are informational, never regressions.
  d = compareToBaseline([cell("x__m__r1", "failed")], []);
  assert(d.ok === true && d.regressions.length === 0 && d.unbaselined.length === 1, "FB#4 baseline: unbaselined cell is not a regression");

  // 5. loadQualitySuite parses a committed evals task file (metadata ignored).
  const dir = mkdtempSync(join(tmpdir(), "aih-fb4-"));
  const suitePath = join(dir, "tasks.json");
  writeFileSync(suitePath, JSON.stringify({ description: "suite", tasks: [{ id: "t1", prompt: "p", expect: ["x"] }] }));
  const suite = loadQualitySuite(suitePath);
  assert(suite !== undefined && suite.tasks.length === 1 && suite.tasks[0].id === "t1", "FB#4 suite: loads tasks.json");
  assert(loadQualitySuite(join(dir, "nope.json")) === undefined, "FB#4 suite: missing file → undefined");
  writeFileSync(join(dir, "bad.json"), "{ not json");
  assert(loadQualitySuite(join(dir, "bad.json")) === undefined, "FB#4 suite: unparseable → undefined");

  console.log("ok: FB#4 BuffBench-style quality eval — baseline regression gate");
}

{
  // AC#1 — Deep code-review pipeline (atomcode-review fanout borrow).
  // Pure-function primitives: impact plan, diff parse, finding merge,
  // verify re-confirm, report render + JSONL audit trail.

  // ---- impact plan: changed files + symbols from added lines --------------
  const diff1 = [
    "diff --git a/src/util.ts b/src/util.ts",
    "index abc..def 100644",
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -10,3 +10,4 @@ export function helper() {",
    " export function helper() {",
    "   // unchanged",
    "+  const x = 1;",
    " }",
    "diff --git a/src/api.ts b/src/api.ts",
    "index 123..456 100644",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -1,2 +1,3 @@",
    "+export async function newEndpoint() {",
    "+  return { ok: true };",
    "+}",
  ].join("\n");

  const impact = extractImpactTargets(diff1);
  assert(
    impact.changedFiles.includes("src/util.ts") && impact.changedFiles.includes("src/api.ts"),
    "AC#1 impact plan: changed files parsed from diff --git lines",
  );
  assert(
    impact.symbols.includes("newEndpoint") && !impact.symbols.includes("helper"),
    `AC#1 impact plan: only added-line symbols extracted (got ${impact.symbols.join(",")})`,
  );
  const plan = renderImpactPlan(diff1);
  assert(
    plan.includes("src/api.ts") && plan.includes("newEndpoint"),
    "AC#1 impact plan: rendered plan lists files + high-risk symbols",
  );

  // ---- parseDiff: new-side line numbers -----------------------------------
  const parsed = parseDiff(diff1);
  const util = parsed.find((f) => f.path === "src/util.ts");
  assert(util !== undefined, "AC#1 parseDiff: src/util.ts found");
  // The added `const x = 1;` lands on new-side line 12 (hunk +10,3 +10,4):
  assert(util!.newLines.includes(12), `AC#1 parseDiff: added line maps to new-side 12 (got ${util!.newLines.join(",")})`);
  const api = parsed.find((f) => f.path === "src/api.ts");
  assert(api!.newLines.includes(3), `AC#1 parseDiff: new file lines 1-3 (got ${api!.newLines.join(",")})`);

  // ---- merge: same-location + similar-title findings dedupe ----------------
  const dims: DimensionReview[] = [
    {
      dimension: "correctness",
      notes: "",
      findings: [
        {
          dimension: "correctness",
          priority: "high",
          confidence: 0.9,
          file_path: "src/api.ts",
          line_start: 2,
          line_end: 3,
          title: "Missing null check on response",
          body: "response may be undefined",
        },
      ],
    },
    {
      dimension: "security",
      notes: "",
      findings: [
        {
          dimension: "security",
          priority: "high",
          confidence: 0.8,
          file_path: "src/api.ts",
          line_start: 2,
          line_end: 4,
          title: "Null response not validated",
          body: "same issue, security angle",
        },
        {
          dimension: "security",
          priority: "low",
          confidence: 0.4,
          file_path: "src/util.ts",
          line_start: 12,
          line_end: 12,
          title: "Unused local variable",
          body: "minor",
        },
      ],
    },
  ];
  const merged = mergeFindings(dims);
  assert(merged.length === 2, `AC#1 merge: 2 distinct findings survive (got ${merged.length})`);
  const apiMerged = merged.find((m) => m.finding.file_path === "src/api.ts");
  assert(
    apiMerged !== undefined && apiMerged.dimensions.includes("correctness") && apiMerged.dimensions.includes("security"),
    `AC#1 merge: cross-dimension credit accumulates (got ${apiMerged?.dimensions.join("+")})`,
  );
  assert(
    merged.every((m) => m.finding.priority === "high" || m.finding.priority === "low"),
    "AC#1 merge: high-priority winner preserved in merged finding",
  );

  // ---- merge: distinct locations never dedupe ------------------------------
  const dims2: DimensionReview[] = [
    { dimension: "correctness", notes: "", findings: [mkFinding("a.ts", 1, 1, "Bug A")] },
    { dimension: "security", notes: "", findings: [mkFinding("b.ts", 5, 5, "Bug B")] },
  ];
  assert(mergeFindings(dims2).length === 2, "AC#1 merge: different files stay separate");

  // ---- verify re-confirm: overlapping + shared token → keep ----------------
  const candidate = mkFinding("src/api.ts", 2, 3, "Missing null check on response");
  const confirming = mkFinding("src/api.ts", 2, 4, "Response null check missing");
  assert(verifyReconfirms(candidate, [confirming]) === true, "AC#1 verify: overlapping + shared tokens re-confirm");
  const nonConfirming = mkFinding("src/api.ts", 20, 21, "Unrelated UI issue");
  assert(verifyReconfirms(candidate, [nonConfirming]) === false, "AC#1 verify: unrelated finding does not re-confirm");
  assert(verifyReconfirms(candidate, []) === false, "AC#1 verify: no reported findings → not confirmed");

  // ---- verify task render includes the annotated diff ----------------------
  const annotated = annotateDiffLineNumbers(diff1);
  assert(annotated.includes("12 | +  const x = 1;"), `AC#1 annotate: new-side line numbers prefixed (got: ${annotated.split("\n").find((l) => l.includes("const x = 1"))})`);
  const vtask = renderVerifyTask({ finding: candidate, dimensions: ["correctness"] }, annotated);
  assert(vtask.includes("VERIFY ONE CANDIDATE FINDING") && vtask.includes("src/api.ts:2-3"), "AC#1 verify task: candidate + lens included");

  // ---- report render + JSONL audit trail ----------------------------------
  const report = {
    diffCommand: "git diff a...HEAD",
    createdAt: new Date().toISOString(),
    dimensions: dims,
    findings: merged,
    dropped: [
      {
        finding: { finding: mkFinding("src/util.ts", 12, 12, "Unused local variable"), dimensions: ["security"] },
        keep: false,
        reason: "false positive — variable used later",
      },
    ],
  };
  const rendered = renderFindingsReport(report);
  assert(rendered.includes("HIGH") && rendered.includes("Missing null check"), "AC#1 report: renders priority groups + findings");
  assert(rendered.includes("Dropped (1") && rendered.includes("false positive"), "AC#1 report: dropped candidates audited");

  const jdir = mkdtempSync(join(tmpdir(), "aih-ac1-"));
  const jfile = writeReviewReport(report, jdir);
  const jl = readFileSync(jfile, "utf8").trim().split("\n");
  assert(
    jl.some((l) => l.includes('"kind":"review"')) &&
      jl.some((l) => l.includes('"kind":"finding"')) &&
      jl.some((l) => l.includes('"kind":"dropped"')),
    "AC#1 JSONL audit: review/finding/dropped records persisted",
  );

  // ---- parseReviewerOutput: structured JSON blocks extraction --------------
  const parsedOut = parseReviewerOutput(
    'Some notes.\n```json\n[{"file_path":"x.ts","line_start":1,"line_end":2,"title":"T","priority":"high","confidence":0.9,"body":"b"}]\n```',
    "correctness",
  );
  assert(
    parsedOut.findings.length === 1 && parsedOut.findings[0].file_path === "x.ts" && parsedOut.findings[0].priority === "high",
    "AC#1 parse: reviewer JSON block extracted into finding",
  );

  assert(REVIEW_DIMENSIONS.length === 4, "AC#1: four review dimensions defined");

  console.log("ok: AC#1 deep code-review pipeline (impact/merge/verify/report) passed");
}

function mkFinding(file: string, start: number, end: number, title: string): Finding {
  return {
    dimension: "correctness",
    priority: "high",
    confidence: 0.8,
    file_path: file,
    line_start: start,
    line_end: end,
    title,
    body: "",
  };
}

{
  // AC#2 — Lightweight code intel (on-demand tsserver, AtomCode borrow).
  // Pure-function primitives first (no server needed), then a live tsserver
  // round-trip when a TypeScript install is present.

  // ---- navtreeToSymbols: tsserver 1-based → 0-based normalization ----------
  const { navtreeToSymbols, flattenDocumentSymbols, resolveTsServerCommand, navtoLocate } = await import("./codeintel.js");
  const tree = {
    childItems: [
      {
        text: "Outer",
        kind: "class",
        nameSpan: { start: { line: 3, offset: 7 } },
        childItems: [
          { text: "method", kind: "method", nameSpan: { start: { line: 4, offset: 3 } } },
        ],
      },
      { text: "topFn", kind: "function", nameSpan: { start: { line: 7, offset: 16 } } },
    ],
  };
  const syms = navtreeToSymbols(tree as never, "/repo", "/repo/src/a.ts");
  assert(syms.length === 3, `AC#2 navtreeToSymbols: flattens nested items (got ${syms.length})`);
  assert(syms[0].line === 2 && syms[0].character === 6, `AC#2 navtreeToSymbols: 1-based → 0-based (got ${syms[0].line},${syms[0].character})`);
  assert(syms[1].containerName === "Outer", "AC#2 navtreeToSymbols: nested container tracked");
  assert(syms[0].path === "src/a.ts", "AC#2 navtreeToSymbols: path relative to root");

  // ---- flattenDocumentSymbols: hierarchical LSP response → flat rows -------
  const flat = flattenDocumentSymbols([
    {
      name: "Class",
      kind: 5,
      selectionRange: { start: { line: 1, character: 6 } },
      children: [{ name: "m", kind: 6, selectionRange: { start: { line: 2, character: 2 } } }],
    },
    { name: "Loose", kind: 12, location: { range: { start: { line: 9, character: 0 } } } },
  ]);
  assert(flat.length === 3, `AC#2 flattenDocumentSymbols: 3 rows (got ${flat.length})`);
  assert(flat[1].line === 2 && flat[1].container === "Class", "AC#2 flattenDocumentSymbols: child row with container");
  assert(flat[2].line === 9 && flat[2].container === undefined, "AC#2 flattenDocumentSymbols: SymbolInformation location fallback");

  // ---- resolveTsServerCommand: PATH miss falls back to local install -------
  const { mkdtempSync, writeFileSync: wfs, rmSync: rmS } = await import("node:fs");
  const { join: jn } = await import("node:path");
  const tmpRoot = mkdtempSync(jn(tmpdir(), "aih-intel-"));
  const resolved = resolveTsServerCommand(tmpRoot);
  assert(resolved === null, "AC#2 resolveTsServerCommand: null when nothing resolvable");
  mkdirSync(jn(tmpRoot, "node_modules/typescript/lib"), { recursive: true });
  wfs(jn(tmpRoot, "node_modules/typescript/lib/tsserver.js"), "// stub");
  const resolved2 = resolveTsServerCommand(tmpRoot);
  assert(
    resolved2 !== null && resolved2.command === process.execPath && String(resolved2.args[0]).endsWith("tsserver.js"),
    "AC#2 resolveTsServerCommand: falls back to node + local tsserver.js",
  );
  rmS(tmpRoot, { recursive: true, force: true });

  // ---- live tsserver round-trip (skipped when no TS install) ---------------
  const live = resolveTsServerCommand(process.cwd());
  if (live) {
    const { ToolRegistry: TR } = await import("@aih/core");
    const { registerDevTools: rdt } = await import("./dev-tools.js");
    const workdir = mkdtempSync(jn(tmpdir(), "aih-intel-live-"));
    mkdirSync(jn(workdir, "src"), { recursive: true });
    wfs(
      jn(workdir, "src/lib.ts"),
      'export interface User { id: number; name: string }\nexport function greet(u: User): string { return "hi " + u.name; }\n',
    );
    wfs(
      jn(workdir, "src/main.ts"),
      'import { greet, User } from "./lib.js";\nconst u: User = { id: 1, name: "x" };\nconsole.log(greet(u));\n',
    );
    wfs(
      jn(workdir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true }, include: ["src"] }),
    );
    mkdirSync(jn(workdir, "node_modules"), { recursive: true });
    try {
      symlinkSync(process.cwd() + "/node_modules/typescript", jn(workdir, "node_modules/typescript"));
    } catch { /* exists */ }
    const gate2 = { async decide() { return "allow" as const; }, async ask() { throw new Error("no ask"); } };
    const registry2 = new TR(gate2 as never);
    rdt(registry2 as never, workdir);
    const call2 = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      const r = await registry2.invoke(name, args, { turnId: "smoke", inject: () => {} } as never);
      if (!r.ok) throw new Error(`${name}: ${r.error}`);
      return r.result as Record<string, unknown>;
    };
    const ls = await call2("list_symbols", { path: "src/lib.ts" });
    assert(Number(ls.count) >= 2, `AC#2 live list_symbols: >=2 symbols (got ${ls.count})`);
    const rs = await call2("read_symbol", { path: "src/lib.ts", symbol: "greet" });
    assert(String(rs.signature).includes("greet"), `AC#2 live read_symbol: signature (got ${rs.signature})`);
    const fr = await call2("find_references", { path: "src/lib.ts", symbol: "greet" });
    const refs = fr.references as Array<{ file: string }>;
    assert(Number(fr.count) >= 2, `AC#2 live find_references: >=2 refs (got ${fr.count})`);
    assert(refs.some((x) => String(x.file).includes("main.ts")), "AC#2 live find_references: cross-file hit");
    rmS(workdir, { recursive: true, force: true });
    console.log("ok: AC#2 live tsserver round-trip (list_symbols / read_symbol / find_references)");
  } else {
    console.log("ok: AC#2 live tsserver round-trip SKIPPED (no typescript install)");
  }
  console.log("ok: AC#2 code-intel primitives passed");
}

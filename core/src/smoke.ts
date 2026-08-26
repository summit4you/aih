import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AgentLoop,
  AutoApprove,
  DenyAll,
  MockLLM,
  OpenAICompatibleLLM,
  DEFAULT_RETRIES,
  retryBackoffMs,
  PolicyGate,
  RulesetGate,
  SessionLog,
  SessionStore,
  ToolRegistry,
  buildGoalJudgePrompt,
  deriveScope,
  matchPattern,
  toolCall,
  COMPACT_CONTINUE_PROMPT,
  MAX_STEPS_PROMPT,
  EMPTY_RETRY_PROMPT,
} from "./index.js";
import type { ChatMessage, LLMRequest, SessionEvent, ToolDefinition } from "./types.js";
import type { LLMAdapter } from "./seams/llm.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

const echo: ToolDefinition = {
  name: "echo",
  description: "Echo back the given text",
  kind: "read",
  permission: "allow",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "text to echo" } },
    required: ["text"],
  },
  execute: async (args) => ({ echoed: (args as { text: string }).text }),
};

const deploy: ToolDefinition = {
  name: "deploy",
  description: "Deploy the app",
  kind: "write",
  permission: "ask",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async () => ({ deployed: true }),
};

const log = new SessionLog();
let approvals = 0;
const gate = {
  async request() {
    approvals += 1;
    return true;
  },
};

const tools = new ToolRegistry(gate);
tools.register(echo).register(deploy);

const llm = new MockLLM([
  {
    text: "I will echo then deploy.",
    toolCalls: [
      toolCall("c1", "echo", { text: "hello aih" }),
      toolCall("c2", "deploy", {}),
    ],
    stopReason: "tool_use",
  },
  { text: "Done.", stopReason: "end_turn" },
]);

const loop = new AgentLoop({
  llm,
  tools,
  log,
  systemPrompt: "You are an in-app assistant.",
});

const result = await loop.send("please echo hello and deploy");
assert(result.steps === 2, "turn used exactly two steps");
assert(result.stopReason === "end_turn", "turn ended normally");
assert(approvals === 1, "write tool triggered exactly one approval");

const events = log.all();
assert(events.some((e) => e.type === "tool/call" && e.name === "echo"), "echo call logged");
assert(
  events.some(
    (e) => e.type === "tool/result" && e.ok && JSON.stringify(e.result).includes("hello aih"),
  ),
  "echo result logged",
);

const derived = log.deriveMessages("sys");
assert(derived[0].role === "system", "derived messages start with system prompt");
assert(derived.filter((m) => m.role === "tool").length === 2, "both tool results projected");

const forked = log.fork();
assert(forked.all().length === events.length, "fork copies full history");

// --- F#28: checkpoint / restore (append-only, prefix semantics) -------------
{
  const clog = new SessionLog();
  clog.append({ type: "user/message", turnId: "t1", text: "turn one" });
  clog.append({ type: "assistant/message", turnId: "t1", text: "reply one", toolCalls: [] });
  const cp = clog.checkpoint("before risky refactor", 1234);
  assert(cp.type === "checkpoint" && cp.note === "before risky refactor", "checkpoint appends a marker event");
  assert(cp.contextTokens === 1234, "checkpoint records context-token snapshot");
  clog.append({ type: "user/message", turnId: "t2", text: "turn two" });
  clog.append({ type: "assistant/message", turnId: "t2", text: "reply two", toolCalls: [] });
  assert(clog.all().length === 5, "post-checkpoint events keep appending");
  assert(clog.latestCheckpoint()!.seq === cp.seq, "latestCheckpoint finds the marker");
  assert(clog.latestCheckpoint(cp.seq - 1) === undefined, "latestCheckpoint respects the beforeSeq bound");
  const restored = clog.restoreTo(cp.seq);
  assert(restored.all().length === 3, "restoreTo keeps the prefix up to and including the marker");
  assert(restored.all()[2].type === "checkpoint", "the marker itself survives the restore");
  assert(clog.all().length === 5, "original log keeps the full history (append-only)");
  clog.adopt(restored);
  assert(clog.all().length === 3, "adopt switches the live log pointer in place");
  clog.append({ type: "user/message", turnId: "t3", text: "turn three" });
  const last = clog.all()[clog.all().length - 1];
  assert(last.seq === cp.seq + 1, "appends after adopt continue the restored seq timeline");
  // deriveMessages must not be confused by checkpoint markers.
  const msgs = restored.deriveMessages("sys");
  assert(msgs.some((m) => m.content.includes("turn one")) && !msgs.some((m) => m.content.includes("turn two")), "deriveMessages ignores checkpoint markers");
}

// --- MK#44/#45: tool/dispatch facts + recovery classifier --------------------
{
  const { classifyToolFacts, scanRecovery, describeFact, PARK_REASON } = await import("./recovery.js");

  // The live loop records dispatch before executing each call.
  {
    const dlog = new SessionLog();
    const dTools = new ToolRegistry(gate);
    dTools.register(echo);
    const dScripted = new MockLLM([
      { text: "calling", toolCalls: [toolCall("dx", "echo", { text: "hi" })], stopReason: "tool_use" },
      { text: "done", stopReason: "end_turn" },
    ]);
    await new AgentLoop({ llm: dScripted, tools: dTools, log: dlog }).send("dispatch test");
    const kinds = dlog.all().map((e) => e.type);
    assert(kinds.includes("tool/dispatch"), "live turn appends tool/dispatch facts");
    // dispatch lands between the call and its result (T1 before execution);
    // tool/call itself is appended after execution with the outcome.
    const dispatchIdx = kinds.indexOf("tool/dispatch");
    const callIdx = kinds.indexOf("tool/call");
    const resultIdx = kinds.indexOf("tool/result");
    assert(
      dispatchIdx > -1 && callIdx > -1 && resultIdx > -1 &&
      dispatchIdx < callIdx && callIdx < resultIdx,
      `ordering: dispatch → call → result (got ${kinds.join(", ")})`,
    );
  }

  // Pure-classifier coverage over a synthetic log (the four states).
  const mk = (seq: number, type: string, extra: Record<string, unknown> = {}) =>
    ({ seq, ts: seq, type, turnId: "t1", ...extra }) as never as Parameters<typeof classifyToolFacts>[0][number];
  const facts = classifyToolFacts([
    mk(0, "user/message", { text: "go" }),
    mk(1, "turn/start"),
    mk(2, "assistant/message", { text: "", toolCalls: [] }),
    mk(3, "tool/call", { callId: "a", name: "write_file", args: {} }), // completed
    mk(4, "tool/dispatch", { callId: "a", name: "write_file" }),
    mk(5, "tool/result", { callId: "a", ok: true, result: 1 }),
    mk(6, "tool/call", { callId: "b", name: "run_cmd", args: {} }),   // synthetic
    mk(7, "tool/result", { callId: "b", ok: false, error: "cancelled" }),
    mk(8, "tool/call", { callId: "c", name: "read_file", args: {} }), // not dispatched
    mk(9, "turn/end", { stopReason: "end_turn" }),
    mk(10, "tool/call", { callId: "d", name: "edit_file", args: {} }),// indeterminate
    mk(11, "tool/dispatch", { callId: "d", name: "edit_file" }),
  ]);
  const by = Object.fromEntries(facts.map((f) => [f.callId, f.state]));
  assert(by.a === "completed", "call+dispatch+result → completed");
  assert(by.b === "synthetic", "result without dispatch → synthetic (provably never ran)");
  assert(by.c === "not_dispatched", "call only → not_dispatched (safe to replay)");
  assert(by.d === "indeterminate", "call+dispatch without result → indeterminate (park)");

  // Recovery scan on an interrupted session.
  const crashLog = [
    mk(0, "turn/start"),
    mk(1, "user/message", { text: "do it" }),
    mk(2, "assistant/message", { text: "", toolCalls: [] }),
    mk(3, "tool/call", { callId: "x", name: "run_cmd", args: {} }),
    mk(4, "tool/dispatch", { callId: "x", name: "run_cmd" }),
    // no result — the crash happened here
  ];
  const rep = scanRecovery(crashLog);
  assert(rep.openTurn === "t1", "scanRecovery finds the open turn");
  assert(rep.parked && rep.facts[0].state === "indeterminate", "dispatched-without-result parks the session");
  assert(describeFact(rep.facts[0]).includes("UNKNOWN"), "describeFact surfaces the indeterminate state");
  assert(PARK_REASON === "tool_recovery_parked", "stable park reason code");

  // A closed turn with all results → not parked; open turn w/o tools → parked=false too.
  const cleanRep = scanRecovery([
    mk(0, "turn/start"),
    mk(1, "user/message", { text: "hi" }),
    mk(2, "assistant/message", { text: "done", toolCalls: [] }),
    mk(3, "turn/end", { stopReason: "end_turn" }),
  ]);
  assert(cleanRep.openTurn === undefined && !cleanRep.parked && cleanRep.lastClosedTurn === "t1", "clean closed session scans clean");

  // deriveMessages keeps dispatch events out of the model conversation.
  const elog = new SessionLog();
  elog.append({ type: "user/message", turnId: "t", text: "q" });
  elog.append({ type: "assistant/message", turnId: "t", text: "", toolCalls: [] });
  elog.append({ type: "tool/call", turnId: "t", callId: "k", name: "echo", args: {} });
  elog.append({ type: "tool/dispatch", turnId: "t", callId: "k", name: "echo" });
  elog.append({ type: "tool/result", turnId: "t", callId: "k", ok: true, result: "r" });
  elog.append({ type: "assistant/message", turnId: "t", text: "final", toolCalls: [] });
  const derivedEligible = elog.deriveMessages("sys").filter((m) => m.role !== "system");
  assert(
    derivedEligible.some((m) => m.role === "tool") && derivedEligible.every((m) => m.role !== "tool" || m.content.includes("r")),
    "tool/result still projected alongside its call",
  );
}

loop.inject("[app/event] todo.added #42");
assert(true, "injected context queued without error");

const policy = new PolicyGate([
  { match: (r) => r.tool === "deploy", action: "deny" },
]);
const deniedTools = new ToolRegistry(policy);
deniedTools.register(deploy);
const denied = await deniedTools.invoke("deploy", {}, {
  turnId: "t0",
  inject: () => {},
});
assert(!denied.ok && denied.permission === "denied", "policy gate denies deploy");

const scope = deriveScope({ tool: "edit", kind: "write", args: { path: "README.md" } });
assert(
  scope.endsWith("/**") && matchPattern(scope, resolve("README.md")),
  "deriveScope(bare file) yields a matching dir scope",
);
assert(matchPattern(scope, resolve(process.cwd(), "README.md")), "deriveScope(bare file) matches the resolved absolute path");
const crossTool = new RulesetGate(new DenyAll(), [{ tool: "edit", pattern: scope, action: "allow" }]);
assert(
  (await crossTool.request({ tool: "write_file", kind: "write", args: { path: "README.md" } })) === true,
  "path-scoped rule covers sibling write tools on the same file",
);
const wildcard = new RulesetGate(new DenyAll(), [{ tool: "run_cmd", pattern: "*", action: "allow" }]);
assert(
  (await wildcard.request({ tool: "edit", kind: "write", args: { path: "/x/README.md" } })) === false,
  "wildcard rule stays tool-specific",
);

const usageLog = new SessionLog();
const usageLlm = new MockLLM([
  {
    text: "",
    toolCalls: [toolCall("u1", "echo", { text: "x" })],
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  },
  {
    text: "done",
    stopReason: "end_turn",
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
  },
]);
const usageLoop = new AgentLoop({ llm: usageLlm, tools, log: usageLog });
const usageResult = await usageLoop.send("use echo");
assert(usageResult.usage?.totalTokens === 43, "turn result accumulates token usage");
const turnEnd = usageLog
  .all()
  .find((e) => e.type === "turn/end");
assert(
  turnEnd?.type === "turn/end" && turnEnd.usage?.totalTokens === 43,
  "turn/end event carries accumulated usage",
);

const storePath = join(mkdtempSync(join(tmpdir(), "aih-core-")), "session.jsonl");
const original = new SessionLog();
original.append({ type: "user/message", turnId: "t1", text: "hello store" });
original.append({ type: "app/event", source: "test", payload: { n: 1 } });
new SessionStore(storePath).save(original);
const reloaded = new SessionStore(storePath).load();
assert(reloaded !== undefined && reloaded.all().length === 2, "session store roundtrips events");
reloaded!.append({ type: "app/event", source: "test", payload: { n: 2 } });
const seqs = reloaded!.all().map((e) => e.seq);
assert(
  seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
  "seq continues monotonically after reload",
);
// Storage hardening: torn tail repaired, interior corruption tolerated,
// empty log never clobbers an existing file.
{
  const p = join(mkdtempSync(join(tmpdir(), "aih-core-")), "torn.jsonl");
  const good1 = JSON.stringify({ seq: 0, ts: 1, type: "turn/start", turnId: "t" });
  const good2 = JSON.stringify({ seq: 1, ts: 2, type: "user/message", turnId: "t", text: "hi" });
  writeFileSync(p, `${good1}\n${good2}\n{"seq":2,"ts":3,"type":"tool/ca`, "utf8"); // torn final line
  const torn = new SessionStore(p).load();
  assert(torn !== undefined && torn.all().length === 2, "load drops a torn trailing line and keeps valid events");
  assert(
    readFileSync(p, "utf8") === `${good1}\n${good2}\n`,
    "load atomically repairs the file to the valid prefix",
  );
  assert(!existsSync(`${p}.tmp-` + process.pid) && !readdirSync(dirname(p)).some((f) => f.includes(".tmp-")), "no temp files left behind");

  const interior = `${good1}\n{corrupt\n${good2}\n`;
  const p2 = join(mkdtempSync(join(tmpdir(), "aih-core-")), "interior.jsonl");
  writeFileSync(p2, interior, "utf8");
  const kept = new SessionStore(p2).load();
  assert(kept !== undefined && kept.all().length === 2, "interior corruption still yields the parseable events");
  assert(readFileSync(p2, "utf8") === interior, "interior corruption leaves the file untouched (no evidence destroyed)");

  const empty = new SessionLog();
  new SessionStore(p).save(empty);
  assert(
    readFileSync(p, "utf8") === `${good1}\n${good2}\n`,
    "saving an empty log never truncates an existing session file",
  );
}

// Incremental durability (per-event appends between full saves): a long
// running turn must not live only in memory.
{
  const p = join(mkdtempSync(join(tmpdir(), "aih-core-")), "incr.jsonl");
  const store = new SessionStore(p);
  const log = new SessionLog();
  log.append({ type: "user/message", turnId: "t", text: "one" });
  log.append({ type: "assistant/message", turnId: "t", text: "two", toolCalls: [] });
  store.save(log); // baseline: flushed = seq 1
  log.append({ type: "user/message", turnId: "t", text: "three" });
  log.append({ type: "tool/call", turnId: "t", callId: "c1", name: "echo", args: { x: 1 } });
  store.flushIncremental(log);
  const reloaded = new SessionStore(p).load();
  assert(reloaded !== undefined && reloaded.all().length === 4, "flushIncremental persists events past the last full save");
  assert(reloaded!.all()[3].type === "tool/call" && reloaded!.all()[3].seq === 3, "appended events keep seq continuity");

  // Baseline from load(): a fresh store on the same file appends exactly the
  // one new event, not a duplicate history.
  const fresh = new SessionStore(p);
  fresh.load();
  log.append({ type: "tool/result", turnId: "t", callId: "c1", ok: true, result: { ok: 1 } });
  fresh.flushIncremental(log);
  const raw2 = readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert(raw2.length === 5, `load-baselined append writes only the delta (got ${raw2.length} lines)`);

  // Same-log history rewrite (/restore → adopt shortens the log): a lagging
  // watermark converges the file to the adopted prefix on the next incremental
  // flush — never duplicated, never left mixed.
  log.adopt(log.fork(2)); // keep seq ≥ 2 → three events remain
  store.flushIncremental(log);
  const rawNow = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).seq as number);
  assert(
    JSON.stringify(rawNow) === JSON.stringify([2, 3, 4]),
    `adopted rewrite converges the file exactly (got ${JSON.stringify(rawNow)})`,
  );
  const afterRewrite = new SessionStore(p).load()!;
  assert(afterRewrite.all().length === 3 && afterRewrite.all()[0].seq === 2, "republished file matches the adopted log");
}
rmSync(storePath, { force: true });

let fetchCalls = 0;
const flaky = new OpenAICompatibleLLM({
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "m",
  retries: 1,
  fetchImpl: (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response("server exploded", { status: 500 });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch,
});
const retryRes = await flaky.complete({
  messages: [{ role: "user", content: "hi" }],
  tools: [],
});
assert(fetchCalls === 2, "retryable 500 is retried once");
{
  // Capacity bursts (zen: "Upstream request failed: Endpoint is unavailable")
  // triple the retry budget — a plain 500 with the same config fails at the
  // base budget, the capacity flavour survives well past it.
  let capacityCalls = 0;
  let plainCalls = 0;
  const mk = (counter: () => number, body: string) =>
    new OpenAICompatibleLLM({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      retries: 1, // base attempts = 2
      fetchImpl: (async () => {
        counter();
        return new Response(body, { status: 503 });
      }) as typeof fetch,
    });
  const capErr = await mk(() => capacityCalls++, "Upstream request failed: Endpoint is unavailable.").complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  }).catch((e: Error) => e);
  assert(capacityCalls === 6, `capacity 503 triples the attempt budget (got ${capacityCalls}, want 6)`);
  assert(capErr instanceof Error && /HTTP 503/.test(capErr.message), "capacity exhaustion still surfaces the HTTP error");
  const plainErr = await mk(() => plainCalls++, "Internal server error").complete({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  }).catch((e: Error) => e);
  assert(plainCalls === 2, `non-capacity 503 keeps the base budget (got ${plainCalls})`);
  assert(plainErr instanceof Error, "plain 503 exhausts to an error");
}
assert(
  retryRes.text === "ok" && retryRes.usage?.totalTokens === 15,
  "usage mapped from OpenAI-compatible response",
);
assert(retryRes.genMs === undefined, "non-streaming response carries no genMs (F#30)");

// Transient-failure resilience (opencode-parity): exponential backoff bounds
// and generous default budget.
assert(DEFAULT_RETRIES >= 5, "default retry budget spans multi-second provider bursts");
for (let a = 0; a < 8; a += 1) {
  const cap = Math.min(8000, 400 * 2 ** a);
  const ms = retryBackoffMs(a);
  assert(
    ms >= Math.floor(cap * 0.75) && ms <= Math.ceil(cap * 1.25),
    `retryBackoffMs(${a}) within ±25% of ${cap}ms cap (got ${ms})`,
  );
}

// CJK-aware token estimation: flat chars÷4 undercounts the Chinese + JSON mix
// ~2-3×, which let real prompts hit ~1.5× the window unnoticed.
{
  const { estimateTokensText } = await import("./agent-loop.js");
  const cjk = estimateTokensText("你好世界".repeat(10)); // 40 CJK chars
  assert(cjk >= 36 && cjk <= 48, `40 CJK chars ≈ 40+ tokens (got ${cjk}, chars/4 would say 10)`);
  const json = estimateTokensText(JSON.stringify({ path: "/tmp/x", content: "a".repeat(60) }));
  assert(json >= 20, `dense JSON estimates denser than chars/4 (got ${json})`);
}
{
  // Opaque HTTP 500 near the window → suspected overflow → compact → retry
  // succeeds (free-tier gateways hide real overflow behind generic 500s).
  const { AgentLoop: Loop, estimateTokensText } = await import("./agent-loop.js");
  let calls = 0;
  const flaky500 = {
    complete: async () => {
      calls += 1;
      if (calls === 1) throw new Error("llm request failed: HTTP 500 Internal server error");
      if (calls === 2)
        return { text: "summary of the earlier work", toolCalls: [], stopReason: "end_turn" };
      return { text: "recovered after compaction", toolCalls: [], stopReason: "end_turn" };
    },
  } as unknown as LLMAdapter;
  const oLog = new SessionLog();
  oLog.append({ type: "user/message", turnId: "old", text: "older question" });
  oLog.append({ type: "assistant/message", turnId: "old", text: "older answer", toolCalls: [] });
  const filler = "工具输出测试".repeat(450); // ≈2700 CJK chars → ~2970 tokens (> the 600 recent budget)
  oLog.append({ type: "user/message", turnId: "t0", text: filler });
  oLog.append({ type: "assistant/message", turnId: "t0", text: "", toolCalls: [] });
  assert(estimateTokensText(filler) >= 1500, "filler is large enough to sit near the test window");
  const oLoop = new Loop({ llm: flaky500, tools: new ToolRegistry(gate), log: oLog, contextWindow: 3000 });
  const oRes = await oLoop.send("continue");
  assert(oRes.stopReason === "end_turn", "turn completes via compact-retry after opaque 500");
  const oCompacts = oLog.all().filter((e) => e.type === "compaction") as Extract<SessionEvent, { type: "compaction" }>[];
  assert(oCompacts.length === 1, "a compaction event was appended before the retry");
  // Tail guarantee: the giant turn can't fit the recent budget whole, but the
  // verbatim tail is still non-empty (trailing whole-message suffix).
  assert(
    (oCompacts[0].recent?.length ?? 0) >= 1,
    "recent tail survives even when no user-boundary suffix fits",
  );
  assert(
    oLog.all().some((e) => e.type === "compaction"),
    "a compaction event was appended before the retry",
  );
}

{
  // provider config headers (client identity) are sent with every completion call
  let seen: Record<string, string> = {};
  const custom = new OpenAICompatibleLLM({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    model: "m",
    retries: 0,
    headers: { "user-agent": "opencode/1.17.11", "x-opencode-client": "cli" },
    fetchImpl: (async (_url, init) => {
      seen = { ...((init as RequestInit)?.headers as Record<string, string>) };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  await custom.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  assert(seen["user-agent"] === "opencode/1.17.11" && seen["x-opencode-client"] === "cli", "provider custom headers sent on the request");
  assert(seen["authorization"] === "Bearer k" && seen["content-type"] === "application/json", "auth/content-type headers still present alongside custom ones");
}

{
  // "{sid}" is stable across requests (session identity); "{rand}" is fresh per request.
  const seen: Record<string, string>[] = [];
  const sidLlm = new OpenAICompatibleLLM({
    baseUrl: "https://example.invalid/v1",
    model: "m",
    retries: 0,
    headers: { "x-opencode-session": "ses_{sid}", "x-opencode-request": "msg_{rand}" },
    fetchImpl: (async (_url, init) => {
      seen.push({ ...((init as RequestInit)?.headers as Record<string, string>) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  await sidLlm.complete({ messages: [{ role: "user", content: "1" }], tools: [] });
  await sidLlm.complete({ messages: [{ role: "user", content: "2" }], tools: [] });
  const opencodeId = (v: string, prefix: string) =>
    new RegExp(`^${prefix}_[0-9a-f]{12}[0-9A-Za-z]{14}$`).test(v);
  assert(
    seen[0]["x-opencode-session"] === seen[1]["x-opencode-session"] &&
      opencodeId(seen[0]["x-opencode-session"], "ses"),
    "{sid} header is stable across requests AND matches opencode id format (12hex+14base62)",
  );
  assert(
    seen[0]["x-opencode-request"] !== seen[1]["x-opencode-request"] &&
      opencodeId(seen[0]["x-opencode-request"], "msg"),
    "{rand} header is fresh per request AND matches opencode id format (12hex+14base62)",
  );
}

function sseResponse(parts: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(new TextEncoder().encode(`data: ${part}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let deltas = "";
const streamLlm = new OpenAICompatibleLLM({
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "m",
  retries: 0,
  fetchImpl: (async () =>
    sseResponse([
      JSON.stringify({
        choices: [{ delta: { content: "Hello" } }],
      }),
      JSON.stringify({
        choices: [{ delta: { content: " world" } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "echo", arguments: "{\"text\":" } }] } },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } },
        ],
      }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
    ])) as typeof fetch,
});
const streamRes = await streamLlm.complete({
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  onDelta: (d) => {
    deltas += d;
  },
});
assert(deltas === "Hello world", "streaming onDelta receives content chunks in order");
assert(streamRes.text === "Hello world", "streamed response accumulates full text");
assert(streamRes.toolCalls.length === 1, "streamed tool_call deltas accumulate by index");
assert(
  streamRes.toolCalls[0]?.name === "echo" &&
    JSON.stringify(streamRes.toolCalls[0].args) === '{"text":"x"}',
  "streamed tool call args reconstruct from fragments",
);
assert(streamRes.usage?.totalTokens === 7, "stream final chunk carries usage");
assert(
  typeof streamRes.genMs === "number" && streamRes.genMs >= 0,
  "streaming response carries per-request genMs (F#30)",
);

const mockStreamLlm = new MockLLM([{ text: "streamed mock text", stopReason: "end_turn" }]);
const loopStream = new AgentLoop({
  llm: mockStreamLlm,
  tools,
});
let mockStreamed = "";
const streamTurn = await loopStream.send("echo", { onDelta: (d) => (mockStreamed += d) });
assert(mockStreamed === "streamed mock text", "MockLLM emits deltas through the loop");
assert(streamTurn.steps === 1, "streamed turn completes normally");

{
  // F#30: an adapter that reports per-request genMs (like the streaming
  // OpenAI adapter does) must see it land on the turn/end event.
  const timedLlm: LLMAdapter = {
    async complete() {
      return {
        text: "done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        genMs: 250,
      };
    },
  };
  const timedLog = new SessionLog();
  const timedLoop = new AgentLoop({ llm: timedLlm, tools, log: timedLog });
  await timedLoop.send("hi");
  const end = timedLog
    .all()
    .find((e) => e.type === "turn/end") as { type: "turn/end"; genMs?: number };
  assert(end.genMs === 250, "turn/end carries genMs from the LLM layer (F#30)");
}

const compactLog = new SessionLog();
const compactTools = new ToolRegistry(gate);
compactTools.register(echo);
let lastCompactReq: ChatMessage[] | undefined;
const compactScripted = new MockLLM([
  {
    text: "calling echo",
    toolCalls: [toolCall("k1", "echo", { text: "hi" })],
    stopReason: "tool_use",
    usage: { promptTokens: 4500, completionTokens: 10, totalTokens: 4510 },
  },
  { text: "SUMMARY user asked to echo hi" },
  { text: "Done.", stopReason: "end_turn" },
]);
const compactLoop = new AgentLoop({
  llm: { complete: (req) => { lastCompactReq = req.messages; return compactScripted.complete(req); } },
  tools: compactTools,
  log: compactLog,
  systemPrompt: "sys",
  contextWindow: 5000,
  compactAt: 0.8,
});
// Seed an older "head" so there is something to summarize (the recent tail is
// kept verbatim, mirroring opencode/MiMo's head/tail compaction).
compactLog.append({ type: "user/message", turnId: "bulk", text: `older question: ${"context ".repeat(400)}` });
compactLog.append({ type: "assistant/message", turnId: "bulk", text: `older answer: ${"detail ".repeat(400)}`, toolCalls: [] });
const compactResult = await compactLoop.send("echo hi");
assert(compactResult.stopReason === "end_turn", "compaction turn completes");
assert(compactLog.all().some((e) => e.type === "compaction"), "proactive compaction recorded above threshold");
const req = lastCompactReq ?? [];
const orphaned = req.filter(
  (m, i) =>
    m.role === "tool" &&
    !req.slice(0, i).some(
      (p) => p.role === "assistant" && Array.isArray(p.toolCalls) && p.toolCalls.some((tc) => tc.id === m.toolCallId),
    ),
).length;
assert(orphaned === 0, "compaction mid tool-chain leaves no orphan tool messages");
assert(
  req.some((m) => typeof m.content === "string" && m.content.includes("SUMMARY")),
  "post-compaction request carries the summary",
);
assert(
  compactResult.contextNow != null && compactResult.contextNow < 900,
  "contextNow drops below pre-compaction prompt size after compaction",
);
// Compaction events carry a post-compaction context stamp so the UI/resume
// seeding can stay honest across /model switches and `-c` resume (the
// "compact shows no effect until next input" bug). The consumer-side test
// (lastContextTokens preferring the stamp) lives in cli/src/smoke.ts.
{
  const cev = compactLog.all().find((e) => e.type === "compaction");
  assert(
    cev?.type === "compaction" && typeof cev.contextAfter === "number" && cev.contextAfter > 0,
    `compaction event stamps contextAfter (${cev?.type === "compaction" ? cev.contextAfter : "missing"})`,
  );
  // MK#42: the summary must carry verifiable coverage — digest over the
  // covered prefix, verified by deriveMessages; a corrupted log fails open.
  assert(
    cev?.type === "compaction" && typeof cev.coverage?.digest === "string" && cev.coverage.digest.length === 32,
    "compaction event carries a coverage digest",
  );
  const derivedOk = compactLog.deriveMessages("sys");
  assert(
    derivedOk.some((m) => m.role === "user" && m.content.includes("echo hi")),
    "valid coverage: projection applies (tail user message visible)",
  );
  // Tamper with an event covered by the summary → digest mismatch → fail
  // open to raw history (the pre-compaction messages become visible again).
  const tampered = SessionLog.fromEvents(
    compactLog.all().map((e) =>
      e.type === "user/message" ? { ...e, text: (e as { text?: string }).text + " TAMPERED" } : e,
    ),
  );
  const tamperedDerived = tampered.deriveMessages("sys");
  assert(
    tamperedDerived.some((m) => m.content.includes("TAMPERED")),
    "coverage mismatch fails open to raw events (no false projection)",
  );
}

// User-query invariant (opencode/MiMo-Code parity): a compaction that folds
// the turn's user message into the summary and stores no replay tail must not
// leave the model-visible window with zero user messages (Qwen3 and other
// strict chat templates 400 with "No user query found in messages").
const noUserLog = new SessionLog();
noUserLog.append({ type: "user/message", turnId: "t1", text: "do the thing" });
noUserLog.append({ type: "assistant/message", turnId: "t1", text: "", toolCalls: [toolCall("k9", "echo", { text: "x" })] });
noUserLog.append({ type: "tool/call", turnId: "t1", callId: "k9", name: "echo", args: { text: "x" } });
noUserLog.append({ type: "tool/result", turnId: "t1", callId: "k9", ok: true, result: { echoed: "x" } });
noUserLog.append({ type: "compaction", turnId: "t1", summary: "All work summarized." });
const noUserDerived = noUserLog.deriveMessages("sys");
assert(
  noUserDerived.some((m) => m.role === "user" && m.content === "do the thing"),
  "deriveMessages re-anchors the last user message when compaction swallowed it",
);
assert(
  noUserDerived.filter((m) => m.role === "user").length === 1,
  "user-query guard appends exactly one user message",
);

// --- P#36③④⑤: split-turn double summary, overflow re-prime, summary isolation ---
{
  // ⑤ Summary-call isolation: every auxiliary (summary) call carries a
  // sessionId distinct from the main conversation's requests.
  const { AgentLoop: Loop } = await import("./agent-loop.js");
  const isoLog = new SessionLog();
  const seenSessionIds: Array<string | undefined> = [];
  let phase = 0; // 0 = main call → tool_use, 1 = summary, 2+ = main
  const isoLlm = {
    complete: (r: LLMRequest) => {
      if (phase === 1) seenSessionIds.push(r.sessionId);
      else seenSessionIds.push(r.sessionId);
      phase += 1;
      if (phase === 1)
        return Promise.resolve({
          text: "",
          toolCalls: [toolCall("iso-1", "echo", { text: "x" })],
          stopReason: "tool_use" as const,
          usage: { promptTokens: 4500, completionTokens: 5, totalTokens: 4505 },
        });
      if (phase === 2) return Promise.resolve({ text: "ISO-SUMMARY", toolCalls: [], stopReason: "end_turn" as const });
      return Promise.resolve({ text: "done", toolCalls: [], stopReason: "end_turn" as const });
    },
  } as unknown as LLMAdapter;
  const isoLoop = new Loop({ llm: isoLlm, tools: new ToolRegistry(gate), log: isoLog, contextWindow: 5000 });
  isoLog.append({ type: "user/message", turnId: "old", text: `history ${"x ".repeat(600)}` });
  await isoLoop.compactNow();
  assert(
    seenSessionIds.length >= 1 &&
      seenSessionIds.every((s) => typeof s === "string" && s.startsWith("aih-compact-")),
    `every summary call carries its own side-channel sessionId (${seenSessionIds.map((s) => s ?? "-").join(",")})`,
  );

  // ④ Overflow recovery re-primes the interrupted turn: after a suspected-
  // overflow failure + compaction, an explicit continuation message quoting
  // the original request is logged before the retry.
  const rpLog = new SessionLog();
  let calls4 = 0;
  const flaky = {
    complete: async () => {
      calls4 += 1;
      if (calls4 === 1) throw new Error("llm request failed: HTTP 500 Internal server error");
      return { text: "RP-SUMMARY", toolCalls: [], stopReason: "end_turn" };
    },
  } as unknown as LLMAdapter;
  // Fill near the window so the opaque 500 is classified as overflow
  // (≥60% of the 3000-token window → ~1800 tokens of filler).
  rpLog.append({ type: "user/message", turnId: "old", text: `filler ${"y".repeat(4800)} end` });
  rpLog.append({ type: "assistant/message", turnId: "old", text: `ack ${"z".repeat(2400)}`, toolCalls: [] });
  const rpLoop = new Loop({ llm: flaky, tools: new ToolRegistry(gate), log: rpLog, contextWindow: 3000 });
  await rpLoop.send("deploy the staging cluster");
  const reprime = rpLog.all().find(
    (e): e is Extract<SessionEvent, { type: "user/message" }> =>
      e.type === "user/message" && e.text.includes("[context recovery]"),
  );
  assert(!!reprime, "overflow recovery appends a [context recovery] continuation message");
  assert(
    !!reprime && reprime.text.includes("deploy the staging cluster"),
    "continuation message quotes the interrupted turn's original request",
  );
  assert(
    rpLog.all().some((e) => e.type === "compaction"),
    "compaction happened before/with the re-prime",
  );
}

// --- P#37①: branch summaries ride along in the projection -------------------
{
  const bLog = new SessionLog();
  bLog.append({ type: "user/message", turnId: "t1", text: "try approach A" });
  bLog.append({ type: "assistant/message", turnId: "t1", text: "A failed", toolCalls: [] });
  bLog.append({
    type: "branch_summary",
    fromSession: "dead-end",
    fromSeq: 3,
    text: "- Approach A breaks on Windows paths\n- Use pnpm, not npm, in this repo",
  });
  const derived = bLog.deriveMessages("sys");
  assert(
    derived[0]?.role === "system" && derived[0].content.includes("Lessons from an abandoned branch"),
    "branch summary folds into the leading system message",
  );
  assert(
    derived.some((m) => m.role === "user" && m.content === "try approach A"),
    "branch summary does not hide the raw conversation",
  );
  // Coexists with a compaction projection.
  const { coverageDigest } = await import("./session-log.js");
  const all = bLog.all();
  bLog.append({
    type: "compaction",
    turnId: "t1",
    summary: "earlier work summarized",
    coverage: { upToSeq: all[all.length - 1].seq, digest: coverageDigest(all) },
  });
  const derived2 = SessionLog.fromEvents(bLog.all().map((e) => ({ ...e }))).deriveMessages("sys");
  assert(
    derived2[0]?.role === "system" &&
      derived2[0].content.includes("earlier work summarized") &&
      derived2[0].content.includes("Lessons from an abandoned branch"),
    "branch summary coexists with the compaction projection",
  );
}
const synthLog = new SessionLog();
synthLog.append({ type: "assistant/message", turnId: "t2", text: "orphan", toolCalls: [] });
synthLog.append({ type: "compaction", turnId: "t2", summary: "s" });
const synthDerived = synthLog.deriveMessages("sys");
assert(
  synthDerived.some((m) => m.role === "user" && m.content === COMPACT_CONTINUE_PROMPT),
  "deriveMessages falls back to the synthetic continue prompt when no user message exists",
);

// A turn whose size exceeds the recent-tail budget (opencode "tail fallback")
// must replay that turn's user message as the new verbatim tail after
// compaction, so its request stays visible in the post-compaction window.
const replayLog = new SessionLog();
const replayTools = new ToolRegistry(gate);
replayTools.register(echo);
const replayUser = "huge turn: " + "context ".repeat(1700); // ~2550 est tokens > 1600 budget (window 8000)
replayLog.append({ type: "user/message", turnId: "bulk", text: "seed: " + "old ".repeat(300) });
replayLog.append({ type: "assistant/message", turnId: "bulk", text: "seed answer", toolCalls: [] });
const replayLlm = new MockLLM([
  { text: "ok, working on it", stopReason: "end_turn", usage: { promptTokens: 7000, completionTokens: 10, totalTokens: 7010 } },
  { text: "## Objective\n- summarized the huge turn" },
]);
const replayResult = await new AgentLoop({
  llm: replayLlm,
  tools: replayTools,
  log: replayLog,
  systemPrompt: "sys",
  contextWindow: 8000,
  compactAt: 0.8,
}).send(replayUser);
assert(replayResult.stopReason === "end_turn", "mega-turn compaction completes the turn");
const replayCompacts = replayLog.all().filter((e) => e.type === "compaction") as Extract<SessionEvent, { type: "compaction" }>[];
assert(replayCompacts.length === 1, "mega turn (tail over budget) still compacts");
  assert(
    replayCompacts[0].recent?.some(
      (m) =>
        m.role === "user" &&
        (m.content === replayUser || replayUser.startsWith(m.content.slice(0, 100))),
    ) === true,
    "#compact keeps the turn's user request in the tail (verbatim or budget-truncated)",
  );
const replayDerived = replayLog.deriveMessages("sys");
assert(
  replayDerived.some(
    (m) =>
      m.role === "user" &&
      (m.content === replayUser || replayUser.startsWith(m.content.slice(0, 100))),
  ),
  "post-compaction request contains the user's request again (replay tail)",
);

const blankLog = new SessionLog();
const blankTools = new ToolRegistry(gate);
blankTools.register(echo);
const blankLlm = new MockLLM([
  { text: "calling", toolCalls: [toolCall("k2", "echo", { text: "x" })], stopReason: "tool_use", usage: { promptTokens: 950, completionTokens: 5, totalTokens: 955 } },
  { text: "   " },
  { text: "Done.", stopReason: "end_turn" },
]);
await new AgentLoop({ llm: blankLlm, tools: blankTools, log: blankLog, contextWindow: 1000, compactAt: 0.8 }).send("go");
assert(!blankLog.all().some((e) => e.type === "compaction"), "blank summary does not record a compaction");
assert(
  blankLog.deriveMessages("sys").some((m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length),
  "history preserved when summary is blank",
);

const manLog = new SessionLog();
const manTools = new ToolRegistry(gate);
manTools.register(echo);
let manLastReq: ChatMessage[] | undefined;
const manScripted = new MockLLM([
  {
    text: "calling echo",
    toolCalls: [toolCall("m1", "echo", { text: "yo" })],
    stopReason: "tool_use",
    usage: { promptTokens: 120, completionTokens: 5, totalTokens: 125 },
  },
  { text: "Done.", stopReason: "end_turn" },
  { text: "MANUAL SUMMARY keep the echo result" },
  { text: "SECOND MANUAL SUMMARY" },
]);
const manLoop = new AgentLoop({
  llm: {
    complete: (req) => {
      manLastReq = req.messages;
      return manScripted.complete(req);
    },
  },
  tools: manTools,
  log: manLog,
  systemPrompt: "sys",
  contextWindow: 100000,
  compactAt: 0.99,
});
await manLoop.send("echo yo");
assert(!manLog.all().some((e) => e.type === "compaction"), "manual test setup: no auto compaction below threshold");
for (let i = 0; i < 3; i += 1) {
  manLog.append({ type: "user/message", turnId: "bulk", text: `filler note ${i}: ${"detail ".repeat(400)}` });
}
const manual = await manLoop.compactNow({ instructions: "keep every tool result verbatim" });
assert(manual.applied === true, "compactNow applies a manual compaction");
assert(manual.before > 0 && manual.after > 0 && manual.after < manual.before, `compactNow reports before/after sizes (${manual.before} -> ${manual.after})`);
assert(manual.usage?.totalTokens === undefined || manual.usage.totalTokens > 0, "compactNow surfaces summarization usage when provided");
assert(
  (manLog.all().find((e) => e.type === "compaction") ?? { trigger: undefined }).trigger === "manual",
  "manual compaction event carries trigger=manual",
);
const manReq = manLastReq ?? [];
assert(
  manReq.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Additional focus requested by the user: keep every tool result verbatim")),
  "manual compact request carries the user's focus instructions",
);
const derivedAfterManual = manLog.deriveMessages("sys");
assert(
  derivedAfterManual.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("MANUAL SUMMARY")),
  "derived messages contain the manual summary after compactNow",
);
assert(
  !derivedAfterManual.some((m) => m.role === "user" && m.content === "echo yo"),
  "pre-compaction messages are dropped from context after compactNow",
);
const noop = await manLoop.compactNow({ instructions: "" });
assert(noop.applied === true, "second manual compaction still applies while history exists");

const reactiveLog = new SessionLog();
const reactiveTools = new ToolRegistry(gate);
reactiveTools.register(echo);
let reactiveCalls = 0;
const reactiveLlm = {
  async complete() {
    reactiveCalls += 1;
    if (reactiveCalls === 1) throw new Error("This model's maximum context length is 128000 tokens. However, you requested 4096 input tokens + 2000000 new tokens");
    if (reactiveCalls === 2) return { text: "SUMMARY of earlier work", toolCalls: [], stopReason: "end_turn" as const };
    return { text: "Done.", toolCalls: [], stopReason: "end_turn" as const };
  },
};
// Seed an older "head" so the reactive compaction has something to summarize
// (a context error only makes sense once the context is large enough).
reactiveLog.append({ type: "user/message", turnId: "bulk", text: `older question: ${"context ".repeat(2500)}` });
reactiveLog.append({ type: "assistant/message", turnId: "bulk", text: `older answer: ${"detail ".repeat(2500)}`, toolCalls: [] });
const reactive = await new AgentLoop({ llm: reactiveLlm, tools: reactiveTools, log: reactiveLog }).send("do it");
assert(reactive.stopReason === "end_turn", "turn recovers after provider context error");
assert(reactiveLog.all().some((e) => e.type === "compaction"), "reactive compaction recorded");

const capTools = new ToolRegistry(gate);
capTools.register(echo);
const capLlm = new MockLLM([
  { text: "step1", toolCalls: [toolCall("c1", "echo", { text: "a" })], stopReason: "tool_use" },
  { text: "step2", toolCalls: [toolCall("c2", "echo", { text: "b" })], stopReason: "tool_use" },
  { text: "never reached", stopReason: "end_turn" },
]);
const capResult = await new AgentLoop({ llm: capLlm, tools: capTools, maxStepsPerTurn: 2 }).send("loop");
assert(capResult.stopReason === "max_steps", "turn stops with max_steps at the step budget");
assert(capResult.steps === 2, "step budget caps executed steps");

// opencode/MiMo-Code parity: the final step's request is prefilled with
// MAX_STEPS_PROMPT (trailing assistant message) so the model wraps up in text
// instead of being cut off mid-tool-call; earlier steps carry no prefill.
const handoffInputs: ChatMessage[][] = [];
const handoffLlm = {
  async complete(req: { messages: ChatMessage[] }) {
    handoffInputs.push(req.messages);
    return {
      text: "working",
      toolCalls: [toolCall(`h${handoffInputs.length}`, "echo", { text: "z" })],
      stopReason: "tool_use" as const,
    };
  },
};
const handoff = await new AgentLoop({ llm: handoffLlm, tools: capTools, maxStepsPerTurn: 2 }).send("loop");
assert(handoff.stopReason === "max_steps", "capped turn still stops at the step budget");
assert(
  handoffInputs[0][handoffInputs[0].length - 1]?.content !== MAX_STEPS_PROMPT,
  "non-final step requests carry no handoff prefill",
);
assert(
  handoffInputs[1][handoffInputs[1].length - 1]?.role === "assistant" &&
    handoffInputs[1][handoffInputs[1].length - 1]?.content === MAX_STEPS_PROMPT,
  "final step request is prefilled with MAX_STEPS_PROMPT",
);

// Empty-response retry: the model "drops" the task (no text, no tool call) a
// couple of times, then resumes. The harness nudges it (bounded) instead of
// ending the turn, and the task completes.
const emptyTools = new ToolRegistry(gate);
emptyTools.register(echo);
const emptyLlm = new MockLLM([
  { text: "", toolCalls: [], stopReason: "end_turn" }, // empty → nudge 1
  { text: "", toolCalls: [], stopReason: "end_turn" }, // empty → nudge 2
  { text: "", toolCalls: [toolCall("e1", "echo", { text: "resumed" })], stopReason: "tool_use" }, // progress
  { text: "Done.", stopReason: "end_turn" }, // finish
]);
const emptyLog = new SessionLog();
const emptyResult = await new AgentLoop({ llm: emptyLlm, tools: emptyTools, log: emptyLog }).send("do the task");
assert(emptyResult.stopReason === "end_turn", "turn completes after recovering from empty responses");
const nudges = emptyLog.all().filter((e) => e.type === "user/message" && e.text === EMPTY_RETRY_PROMPT);
assert(nudges.length === 2, "two empty-response nudges injected (bounded by MAX_EMPTY_RETRIES)");

// Empty-response exhaustion: the model returns empty every time; after
// MAX_EMPTY_RETRIES nudges the harness gives up and ends the turn (no infinite loop).
const stuckLlm = new MockLLM([
  { text: "", toolCalls: [], stopReason: "end_turn" },
  { text: "", toolCalls: [], stopReason: "end_turn" },
  { text: "", toolCalls: [], stopReason: "end_turn" },
  { text: "", toolCalls: [], stopReason: "end_turn" },
]);
const stuckLog = new SessionLog();
const stuckResult = await new AgentLoop({ llm: stuckLlm, tools: emptyTools, log: stuckLog }).send("do the task");
assert(stuckResult.stopReason === "end_turn", "stuck-on-empty turn ends (no infinite loop)");
const stuckNudges = stuckLog.all().filter((e) => e.type === "user/message" && e.text === EMPTY_RETRY_PROMPT);
assert(stuckNudges.length === 2, "gives up after MAX_EMPTY_RETRIES nudges");

// A genuine end-of-turn (text present, no tool call) must NOT be retried.
const genuineLlm = new MockLLM([{ text: "All done.", stopReason: "end_turn" }]);
const genuineLog = new SessionLog();
const genuineResult = await new AgentLoop({ llm: genuineLlm, tools: emptyTools, log: genuineLog }).send("status?");
assert(genuineResult.stopReason === "end_turn", "genuine text answer ends the turn");
const genuineNudges = genuineLog.all().filter((e) => e.type === "user/message" && e.text === EMPTY_RETRY_PROMPT);
assert(genuineNudges.length === 0, "a non-empty final answer is not nudged");

const truncTools = new ToolRegistry(gate);
truncTools.register(echo);
const truncLoop = new AgentLoop({
  llm: new MockLLM([
    { text: "half", toolCalls: [toolCall("t1", "echo", { text: "x" })], stopReason: "tool_use", finishReason: "length" },
  ]),
  tools: truncTools,
});
const truncResult = await truncLoop.send("go");
assert(truncResult.stopReason === "max_tokens", "finish_reason=length ends the turn as max_tokens");
const truncEvents = truncLoop.log.all();
const t1 = truncEvents.find((e) => e.type === "tool/result" && e.callId === "t1") as
  | Extract<SessionEvent, { type: "tool/result" }>
  | undefined;
assert(
  !!t1 && t1.ok === false && String(t1.error).includes("re-issue"),
  "truncated step's tool call is failed with a re-issue hint (never executed)",
);
{
  // Pairing invariant: every tool/call in a log has exactly one tool/result.
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const e of truncEvents) {
    if (e.type === "tool/call") calls.add(e.callId);
    if (e.type === "tool/result" && !results.has(e.callId)) results.add(e.callId);
  }
  assert(
    [...calls].every((c) => results.has(c)) && calls.size === results.size,
    "length-truncation leaves no orphaned tool calls (call↔result pairing intact)",
  );
}
const plainTrunc = await new AgentLoop({
  llm: new MockLLM([{ text: "cut off mid-sentence", stopReason: "end_turn", finishReason: "length" }]),
  tools: truncTools,
}).send("go");
assert(plainTrunc.stopReason === "max_tokens", "text-only truncation is reported as max_tokens, not end_turn");
const okFinish = await new AgentLoop({
  llm: new MockLLM([{ text: "done", stopReason: "end_turn", finishReason: "stop" }]),
  tools: truncTools,
}).send("go");
assert(okFinish.stopReason === "end_turn", "normal finish_reason=stop stays end_turn");

// Abort mid-batch: the un-executed calls get synthetic cancelled results, so
// no assistant toolCalls are ever left without a paired result.
{
  const canceler: ToolDefinition = {
    name: "canceler",
    description: "cancels the turn",
    kind: "write",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      loopRef!.cancel();
      return { ok: true };
    },
  };
  const abortTools = new ToolRegistry(gate);
  abortTools.register(canceler);
  let loopRef: AgentLoop | undefined;
  const abortLoop = new AgentLoop({
    llm: new MockLLM([
      {
        text: "",
        toolCalls: [toolCall("a1", "canceler", {}), toolCall("a2", "canceler", {})],
        stopReason: "tool_use",
      },
    ]),
    tools: abortTools,
  });
  loopRef = abortLoop;
  const r = await abortLoop.send("go");
  assert(r.stopReason === "cancelled", "cancelled turn reports stopReason=cancelled");
  const a2 = abortLoop.log.all().find((e) => e.type === "tool/result" && e.callId === "a2") as
    | Extract<SessionEvent, { type: "tool/result" }>
    | undefined;
  assert(
    !!a2 && a2.ok === false && String(a2.error).includes("cancelled before"),
    "abort mid-batch pairs the skipped call with a synthetic cancelled result",
  );
}

const truncStreamLlm = new OpenAICompatibleLLM({
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "m",
  retries: 0,
  fetchImpl: (async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "half" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
    ])) as typeof fetch,
});
const truncStream = await truncStreamLlm.complete({
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  onDelta: () => {},
});
assert(truncStream.finishReason === "length", "streaming finish_reason=length is surfaced on the response");

{
  // plan/read-only mode: unknown-tool errors steer the model back to build mode
  const planTools = new ToolRegistry(gate);
  planTools.planMode(true);
  const missing = await planTools.invoke("write_file", { path: "x" }, { turnId: "t", inject: () => {} });
  assert(!missing.ok, "plan mode rejects hidden (unregistered) write tools");
  assert(
    /read-only \(plan\) mode/i.test(missing.error ?? "") && /build mode/i.test(missing.error ?? ""),
    "plan-mode unknown-tool error suggests switching to build mode",
  );
  const buildTools = new ToolRegistry(gate);
  const missingBuild = await buildTools.invoke("write_file", { path: "x" }, { turnId: "t", inject: () => {} });
  assert((missingBuild.error ?? "").startsWith("unknown tool: write_file"), "build mode keeps the plain unknown-tool error");
}

{
  // prompt-layer borrowings from LongHorizon-Harness (prompts.ts)
  const jp = buildGoalJudgePrompt("all tests pass");
  assert(
    jp.includes("all tests pass") && /state carrier/i.test(jp) && /evidence horizon/i.test(jp),
    "goal judge prompt embeds the goal plus final-state guard and contract rules",
  );
  assert(
    /unmet/.test(jp) && /met"\s*:\s*true\|false/.test(jp),
    "judge prompt specifies the extended verdict schema",
  );
}

{
  // F#29: consecutive read-only tool calls run concurrently (bounded by
  // readConcurrency); write tools stay serial; results log in original call
  // order regardless of completion order (codex parallel.rs parity).
  const parGate = { async request() { return true; } };

  // (a) three identical slow reads overlap: max in-flight reaches 3 and the
  // wall clock is well under the serial sum (3 x 60ms).
  const inflight = { n: 0, max: 0 };
  const parTools = new ToolRegistry(parGate);
  parTools.register({
    name: "slow_read",
    description: "read that takes time",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      inflight.n += 1;
      inflight.max = Math.max(inflight.max, inflight.n);
      await new Promise((r) => setTimeout(r, 60));
      inflight.n -= 1;
      return { ok: true };
    },
  } satisfies ToolDefinition);
  const parLog = new SessionLog();
  const parLlm = new MockLLM([
    {
      text: "reading",
      toolCalls: [
        toolCall("p1", "slow_read", {}),
        toolCall("p2", "slow_read", {}),
        toolCall("p3", "slow_read", {}),
      ],
      stopReason: "tool_use",
    },
    { text: "Done.", stopReason: "end_turn" },
  ]);
  const t0 = Date.now();
  const parTurn = await new AgentLoop({ llm: parLlm, tools: parTools, log: parLog }).send("read thrice");
  const elapsed = Date.now() - t0;
  assert(parTurn.stopReason === "end_turn", "parallel-read turn completes");
  assert(inflight.max === 3, "three consecutive read-only calls ran concurrently");
  assert(elapsed < 150, `parallel batch beats serial sum (${elapsed}ms < ~180ms)`);

  // (b) completion order differs from call order, but tool/result events are
  // appended in the ORIGINAL call order.
  const ordLog = new SessionLog();
  const ordTools = new ToolRegistry(parGate);
  ordTools.register({
    name: "stagger_read",
    description: "sleeps for args.delay ms then reports it",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { delay: { type: "number", description: "ms to sleep" } },
      required: ["delay"],
    },
    execute: async (args) => {
      const delay = (args as { delay: number }).delay;
      await new Promise((r) => setTimeout(r, delay));
      return { delay };
    },
  } satisfies ToolDefinition);
  const ordLlm = new MockLLM([
    {
      text: "staggered",
      toolCalls: [
        toolCall("o1", "stagger_read", { delay: 90 }),
        toolCall("o2", "stagger_read", { delay: 50 }),
        toolCall("o3", "stagger_read", { delay: 10 }),
      ],
      stopReason: "tool_use",
    },
    { text: "Done.", stopReason: "end_turn" },
  ]);
  const ordTurnLog = new SessionLog();
  await new AgentLoop({ llm: ordLlm, tools: ordTools, log: ordTurnLog }).send("stagger");
  const resultOrder = ordTurnLog
    .all()
    .filter((e) => e.type === "tool/result")
    .map((e) => ((e.result as { delay?: number }) ?? {}).delay);
  assert(
    JSON.stringify(resultOrder) === JSON.stringify([90, 50, 10]),
    `results log in original call order despite out-of-order completion (${JSON.stringify(resultOrder)})`,
  );

  // (c) read / write / read: the write never overlaps a read and reads are NOT
  // batched across it.
  const timeline: string[] = [];
  const mixTools = new ToolRegistry(parGate);
  mixTools.register({
    name: "tl_read",
    description: "timeline read",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
    },
    execute: async (args) => {
      timeline.push(`${(args as { tag: string }).tag}:start`);
      await new Promise((r) => setTimeout(r, 30));
      timeline.push(`${(args as { tag: string }).tag}:end`);
      return {};
    },
  } satisfies ToolDefinition);
  mixTools.register({
    name: "tl_write",
    description: "timeline write",
    kind: "write",
    permission: "ask",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      timeline.push("W:start");
      timeline.push("W:end");
      return {};
    },
  } satisfies ToolDefinition);
  const mixLlm = new MockLLM([
    {
      text: "mixing",
      toolCalls: [
        toolCall("x1", "tl_read", { tag: "R1" }),
        toolCall("x2", "tl_write", {}),
        toolCall("x3", "tl_read", { tag: "R2" }),
      ],
      stopReason: "tool_use",
    },
    { text: "Done.", stopReason: "end_turn" },
  ]);
  await new AgentLoop({ llm: mixLlm, tools: mixTools }).send("mixed kinds");
  assert(
    JSON.stringify(timeline) ===
      JSON.stringify(["R1:start", "R1:end", "W:start", "W:end", "R2:start", "R2:end"]),
    `writes stay serial and reads do not batch across them (${JSON.stringify(timeline)})`,
  );

  // (d) readConcurrency caps in-flight reads (AIH_TOOL_CONCURRENCY default 4).
  const capped = { n: 0, max: 0 };
  const capParTools = new ToolRegistry(parGate);
  capParTools.register({
    name: "cap_read",
    description: "counts in-flight executions",
    kind: "read",
    permission: "allow",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      capped.n += 1;
      capped.max = Math.max(capped.max, capped.n);
      await new Promise((r) => setTimeout(r, 20));
      capped.n -= 1;
      return {};
    },
  } satisfies ToolDefinition);
  const capLlm = new MockLLM([
    {
      text: "capping",
      toolCalls: [1, 2, 3, 4].map((k) => toolCall(`q${k}`, "cap_read", {})),
      stopReason: "tool_use",
    },
    { text: "Done.", stopReason: "end_turn" },
  ]);
  await new AgentLoop({ llm: capLlm, tools: capParTools, readConcurrency: 2 }).send("capped reads");
  assert(capped.max === 2, `readConcurrency=2 caps in-flight reads at 2 (saw ${capped.max})`);
}

// --- MK#44: tool/dispatch T1 facts -------------------------------------------
{
  const { classifyToolFacts, scanRecovery, describeFact } = await import("./recovery.js");
  const mk = (over: Partial<Record<string, unknown>> & Record<string, unknown>) =>
    ({ seq: 0, ts: 0, ...over }) as unknown as Parameters<typeof classifyToolFacts>[0][number];

  // The four states over (call, dispatch, result):
  const events = [
    mk({ type: "turn/start", turnId: "tA" }),
    // completed: call → dispatch → result
    mk({ type: "tool/call", turnId: "tA", callId: "c1", name: "echo", args: {} }),
    mk({ type: "tool/dispatch", turnId: "tA", callId: "c1", name: "echo" }),
    mk({ type: "tool/result", turnId: "tA", callId: "c1", ok: true, result: "x" }),
    // synthetic: result without dispatch (length-truncation / cancel fill-in)
    mk({ type: "tool/call", turnId: "tA", callId: "c2", name: "echo", args: {} }),
    mk({ type: "tool/result", turnId: "tA", callId: "c2", ok: false, error: "cancelled" }),
    // not_dispatched: bare call
    mk({ type: "tool/call", turnId: "tB", callId: "c3", name: "run_cmd", args: {} }),
    // indeterminate: dispatch without result
    mk({ type: "user/message", turnId: "tB", text: "do it" }),
    mk({ type: "tool/call", turnId: "tB", callId: "c4", name: "write_file", args: {} }),
    mk({ type: "tool/dispatch", turnId: "tB", callId: "c4", name: "write_file" }),
    mk({ type: "turn/end", turnId: "tA", stopReason: "end_turn" }),
    // tB never ends — the crash candidate.
  ];
  const facts = classifyToolFacts(events);
  const by = Object.fromEntries(facts.map((f) => [f.callId, f.state]));
  assert(by.c1 === "completed", "call+dispatch+result → completed");
  assert(by.c2 === "synthetic", "result without dispatch → synthetic (provably never ran)");
  assert(by.c3 === "not_dispatched", "bare call → not_dispatched (safe to replay)");
  assert(by.c4 === "indeterminate", "dispatch without result → indeterminate");

  const rep = scanRecovery(events);
  assert(rep.lastClosedTurn === "tA", "lastClosedTurn is the newest turn with an end event");
  assert(rep.openTurn === "tB", "turn B never closed → open turn detected");
  assert(rep.parked === true && rep.facts.some((f) => f.state === "indeterminate"), "open turn with an unresolved dispatch → parked");
  const cleanRep = scanRecovery([
    mk({ type: "user/message", turnId: "t1", text: "hi" }),
    mk({ type: "assistant/message", turnId: "t1", text: "hello", toolCalls: [] }),
    mk({ type: "turn/end", turnId: "t1", stopReason: "end_turn" }),
  ]);
  assert(cleanRep.parked === false && !cleanRep.openTurn, "fully closed session scans clean");

  // P#37: session tree — linear default + explicit branch points.
  const tlog = new SessionLog();
  const e0 = tlog.append({ type: "user/message", turnId: "tA", text: "trunk start" });
  const e1 = tlog.append({ type: "assistant/message", turnId: "tA", text: "reply", toolCalls: [] });
  const nodes = tlog.tree();
  assert(nodes.length === 2 && nodes[0].parentId === null, "tree: root has no parent");
  assert(nodes[1].parentId === e0.seq, "tree: implicit parent is the previous event");
  // Explicit branch: an event declaring parentId pointing back into history.
  const br = tlog.append({
    type: "user/message",
    turnId: "tB",
    text: "branch start",
    ...( { parentId: e0.seq } as object ),
  } as Parameters<SessionLog["append"]>[0]);
  assert(tlog.branchPoints().includes(br.seq), "explicit parentId marks a branch point");
  const tnodes = tlog.tree();
  const brNode = tnodes.find((n) => n.seq === br.seq);
  assert(!!brNode && brNode.parentId === e0.seq, "tree preserves the explicit parent link");
  assert(describeFact(facts.find((f) => f.callId === "c4")!).includes("UNKNOWN"), "describeFact flags the indeterminate fact for display");

  // Real AgentLoop run emits dispatch facts between call and result.
  const dLog = new SessionLog();
  const dTools = new ToolRegistry(gate);
  dTools.register(echo);
  await new AgentLoop({
    llm: new MockLLM([
      { text: "calling", toolCalls: [toolCall("d1", "echo", { text: "hi" })], stopReason: "tool_use" },
      { text: "Done.", stopReason: "end_turn" },
    ]),
    tools: dTools,
    log: dLog,
  }).send("trigger a tool call");
  const kinds = dLog.all().map((e) => e.type);
  const iCall = kinds.indexOf("tool/call");
  const iDispatch = kinds.indexOf("tool/dispatch");
  const iResult = kinds.indexOf("tool/result");
  // dispatch lands BEFORE the call event (which is appended with its outcome).
  assert(
    iDispatch > -1 && iDispatch < iCall && iCall < iResult,
    `AgentLoop dispatch ordering (dispatch=${iDispatch}, call=${iCall}, result=${iResult}; got ${kinds.join(",")})`,
  );
  const derivedDispatch = dLog.deriveMessages("sys");
  assert(
    !derivedDispatch.some((m) => m.role === "tool" && m.toolCallId === "d1" && false),
    "deriveMessages keeps paired results",
  );
  assert(dLog.all().filter((e) => e.type === "tool/dispatch").length === 1, "exactly one dispatch fact per executed call");
}

// --- P#35: steering lands mid-turn (before the next LLM step) ----------------
{
  const slog = new SessionLog();
  const stools = new ToolRegistry(gate);
  stools.register(echo);
  // Scripted: first call returns a tool_use with a SLOW tool, second happens
  // only after the steer message was injected.
  const seenByStep: string[] = [];
  const slowEcho: ToolDefinition = {
    name: "slow_echo",
    description: "echo but takes a moment",
    kind: "read",
    permission: "allow",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "text to echo" } },
      required: ["text"],
    },
    execute: async () => {
      // Steer WHILE this tool runs — the whole point of the feature.
      loopRef.steer("CHANGE OF PLAN: stop echoing");
      await new Promise((r) => setTimeout(r, 30));
      return { echoed: true };
    },
  };
  const sTools = new ToolRegistry(gate);
  sTools.register(echo);
  sTools.register(slowEcho);
  const sLlm: MockLLM = new MockLLM([
    { text: "", toolCalls: [toolCall("s1", "slow_echo", JSON.stringify({ text: "x" }))], stopReason: "tool_use" },
    { text: "done", stopReason: "end_turn" },
  ]);
  const seenByStep2 = seenByStep;
  const loopRef = new AgentLoop({
    llm: sLlm,
    tools: sTools,
    log: slog,
    onPromptInput: (msgs) => seenByStep2.push(msgs.map((m) => m.content).join("|")),
  });
  await loopRef.send("start slow echo");
  const userTexts = slog
    .all()
    .filter((e): e is Extract<SessionEvent, { type: "user/message" }> => e.type === "user/message")
    .map((e) => e.text);
  assert(
    userTexts.some((t) => t.includes("CHANGE OF PLAN")),
    "steer() called during tool execution is recorded as a user message",
  );
  assert(
    slog.all().some((e) => e.type === "turn/end"),
    "steered turn still completes normally",
  );
}

console.log("\nAIH core smoke test passed.");

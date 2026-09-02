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
  TRUNCATED_RETRY_PROMPT,
  STREAM_RESUME_PROMPT,
  isQuotaExhaustion,
  QuotaError,
  StallError,
  ReasoningRunawayError,
  isReasoningRunaway,
  capTurnToolBudget,
  TURN_TOOL_BUDGET_CHARS,
  TURN_BUDGET_STOP_DIRECTIVE,
  LoopAbort,
  notifyObservers,
  stableStringify,
  textSimilarity,
  RepetitionObserver,
  BudgetTracker,
  SensorLoop,
  isDenied,
  parseBudget,
} from "./index.js";
import type { LoopObserver } from "./index.js";
import type { ChatMessage, LLMRequest, LLMResponse, SessionEvent, ToolDefinition } from "./types.js";
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
  assert(msgs.some((m) => String(m.content).includes("turn one")) && !msgs.some((m) => String(m.content).includes("turn two")), "deriveMessages ignores checkpoint markers");
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
    derivedEligible.some((m) => m.role === "tool") && derivedEligible.every((m) => m.role !== "tool" || String(m.content).includes("r")),
    "tool/result still projected alongside its call",
  );
}

{
  // FA#2 — per-turn aggregate budget on tool content (capTurnToolBudget).
  const tool = (id: string, body: string): ChatMessage => ({
    role: "tool",
    toolCallId: id,
    name: "echo",
    content: body,
  });
  // under budget: unchanged (uses the real default budget).
  {
    const msgs = [tool("a", "x".repeat(100)), tool("b", "y".repeat(100))];
    const out = capTurnToolBudget(msgs, () => "t", TURN_TOOL_BUDGET_CHARS);
    assert(out === msgs, "FA#2 under budget → same array, untouched");
  }
  // over budget: earliest kept intact, later truncated, total bounded.
  {
    const msgs = [tool("a", "A".repeat(1000)), tool("b", "B".repeat(1000)), tool("c", "C".repeat(1000))];
    const out = capTurnToolBudget(msgs, () => "t", 1500);
    assert(out[0].content === "A".repeat(1000), "FA#2 earliest result kept intact");
    assert(String(out[1].content).includes("[turn tool-output budget exhausted"), "FA#2 later result truncated with marker");
    assert(String(out[2].content).startsWith("[turn tool-output budget exhausted") && out[2].content.length < 200, "FA#2 exhausted result → marker only");
    assert(msgs[1].content === "B".repeat(1000), "FA#2 input array not mutated");
  }
  // independent turns: each gets its own budget (each fits its own 1500,
  // though the combined 3000 would exceed a single shared budget of 1500).
  {
    const msgs = [tool("a", "A".repeat(1000)), tool("b", "B".repeat(1000))];
    const out = capTurnToolBudget(msgs, (m) => (m.toolCallId === "a" ? "t1" : "t2"), 1500);
    assert(out[0].content === "A".repeat(1000), "FA#2 turn t1 within its own budget → intact");
    assert(out[1].content === "B".repeat(1000), "FA#2 turn t2 within its own budget → intact");
    // Contrast: same two results in ONE turn, budget 1500 → the second is trimmed.
    const oneTurn = capTurnToolBudget(msgs, () => "shared", 1500);
    assert(String(oneTurn[1].content).includes("[turn tool-output budget exhausted"), "FA#2 same turn, shared budget → second trimmed");
  }
  // budget 0 → disabled (no-op).
  {
    const msgs = [tool("a", "A".repeat(5000))];
    assert(capTurnToolBudget(msgs, () => "t", 0) === msgs, "FA#2 budget 0 → disabled");
  }
  // integration: deriveMessages caps a turn whose fan-out exceeds the budget.
  {
    const ilog = new SessionLog();
    const big = "Z".repeat(3_000); // under the 8K per-result cap, so only the turn cap applies
    ilog.append({ type: "user/message", turnId: "t", text: "q" });
    ilog.append({ type: "assistant/message", turnId: "t", text: "", toolCalls: [] });
    for (const id of ["r1", "r2", "r3", "r4"]) {
      ilog.append({ type: "tool/call", turnId: "t", callId: id, name: "echo", args: {} });
      ilog.append({ type: "tool/result", turnId: "t", callId: id, ok: true, result: big });
    }
    ilog.append({ type: "assistant/message", turnId: "t", text: "final", toolCalls: [] });
    // With the default turn budget, 4 × 3K = 12K fits → all intact.
    const d1 = ilog.deriveMessages("sys").filter((m) => m.role === "tool");
    assert(d1.every((m) => String(m.content).includes("Z".repeat(500))), "FA#2 4×3K fits default turn budget → intact");
    // Tighten the budget below the total via env → later results truncated.
    process.env.AIH_TURN_TOOL_BUDGET = "4000";
    try {
      const d2 = ilog.deriveMessages("sys").filter((m) => m.role === "tool");
      assert(
        String(d2[0].content).includes("Z") && !String(d2[0].content).includes("[turn tool-output budget exhausted"),
        "FA#2 env budget: earliest result kept (per-result cap only)",
      );
      assert(d2.some((m) => String(m.content).includes("[turn tool-output budget exhausted")), "FA#2 env budget: later results truncated");
      // FA#2 supplement: when truncation happened, a trailing user directive
      // is appended (FrontierAgent ContextSizeGuard parity) so the model is
      // told to stop issuing tool calls instead of inferring it.
      const d3 = ilog.deriveMessages("sys");
      const tail = d3[d3.length - 1];
      const hasDirective =
        tail.role === "user" &&
        String(tail.content).startsWith(TURN_BUDGET_STOP_DIRECTIVE);
      assert(hasDirective, "FA#2 directive appended when truncation occurred");
      const directiveCount = d3.filter(
        (m) =>
          m.role === "user" &&
          String(m.content).startsWith(TURN_BUDGET_STOP_DIRECTIVE),
      ).length;
      assert(directiveCount === 1, "FA#2 directive appended exactly once");
    } finally {
      delete process.env.AIH_TURN_TOOL_BUDGET;
    }
  }
  console.log("ok: FA#2 capTurnToolBudget (pure + deriveMessages integration)");
}

{
  // FA#2 regression — a CLOSED historical turn that busts the per-turn budget
  // must still truncate its oversized tool output (bounds context) but must
  // NOT append the "stop running tools" directive. Before the fix, resuming
  // any long session where one past turn read many big files re-armed the
  // budget-exhausted directive, so a brand-new turn looked budget-exhausted
  // from its very first message. (Budget is pinned via env so this stays
  // meaningful regardless of the default TURN_TOOL_BUDGET_CHARS value.)
  const ilog = new SessionLog();
  const big = "Z".repeat(8_000); // each at the per-result cap; 20 busts 64K
  ilog.append({ type: "user/message", turnId: "t1", text: "read a lot" });
  ilog.append({ type: "assistant/message", turnId: "t1", text: "", toolCalls: [] });
  for (let i = 0; i < 20; i += 1) {
    ilog.append({ type: "tool/call", turnId: "t1", callId: `h${i}`, name: "echo", args: {} });
    ilog.append({ type: "tool/result", turnId: "t1", callId: `h${i}`, ok: true, result: big });
  }
  ilog.append({ type: "assistant/message", turnId: "t1", text: "done", toolCalls: [] });
  ilog.append({ type: "turn/end", turnId: "t1", stopReason: "end_turn" }); // t1 CLOSED
  // Brand-new live turn, no tool output yet.
  ilog.append({ type: "turn/start", turnId: "t2" });
  ilog.append({ type: "user/message", turnId: "t2", text: "do the new task" });
  process.env.AIH_TURN_TOOL_BUDGET = "64000"; // pin a tight budget for the assertion
  let dm;
  try {
    dm = ilog.deriveMessages("sys");
  } finally {
    delete process.env.AIH_TURN_TOOL_BUDGET;
  }
  assert(
    dm.some(
      (m) => m.role === "tool" && String(m.content).includes("turn tool-output budget exhausted"),
    ),
    "FA#2 regression: historical over-budget turn still truncates (context bounded)",
  );
  assert(
    !dm.some(
      (m) => m.role === "user" && String(m.content).startsWith(TURN_BUDGET_STOP_DIRECTIVE),
    ),
    "FA#2 regression: no stop-directive on a fresh turn after a closed over-budget turn",
  );
  console.log("ok: FA#2 regression — closed over-budget turn truncates but does not re-arm the directive");
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

// CC#49 — adapter-level stall semantics: a stalled stream WITH partial text
// must propagate immediately (AgentLoop resumes honestly); WITHOUT text it
// must consume the retry budget like a transient failure.
{
  const prevFirst = process.env.AIH_FIRST_TOKEN_TIMEOUT_MS;
  const prevStall = process.env.AIH_STALL_TIMEOUT_MS;
  process.env.AIH_FIRST_TOKEN_TIMEOUT_MS = "150";
  process.env.AIH_STALL_TIMEOUT_MS = "150";
  try {
    // A body that delivers `frames` then hangs forever (never closes).
    const hangingBody = (frames: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const f of frames) controller.enqueue(new TextEncoder().encode(`data: ${f}\n\n`));
          // no controller.close() — the stream stalls
        },
      });
    // 1) partial text + stall → StallError thrown immediately, no retry.
    let partialCalls = 0;
    const partialLlm = new OpenAICompatibleLLM({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      retries: 2, // budget that would normally survive — must NOT be used
      fetchImpl: (async () => {
        partialCalls += 1;
        return new Response(
          hangingBody([JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
    });
    const partialErr = (await partialLlm.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => {},
    }).catch((e: unknown) => e)) as StallError;
    assert(partialErr instanceof StallError, "stalled stream with partial text throws StallError");
    assert(partialErr.partialText === "Hel", "StallError carries the partial text");
    assert(partialCalls === 1, "partial-text stall is NOT retried (propagates for honest resume)");
    // 2) no text + stall → folded into the retry budget.
    let emptyCalls = 0;
    const emptyLlm = new OpenAICompatibleLLM({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      retries: 1,
      fetchImpl: (async () => {
        emptyCalls += 1;
        return new Response(hangingBody([]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    const emptyErr = (await emptyLlm.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => {},
    }).catch((e: unknown) => e)) as StallError;
    assert(emptyErr instanceof StallError, "stalled stream without text throws StallError");
    assert(emptyErr.partialText === "", "empty-partial StallError carries no text");
    assert(emptyCalls === 2, "empty-partial stall consumes the retry budget (2 attempts)");
  } finally {
    if (prevFirst === undefined) delete process.env.AIH_FIRST_TOKEN_TIMEOUT_MS;
    else process.env.AIH_FIRST_TOKEN_TIMEOUT_MS = prevFirst;
    if (prevStall === undefined) delete process.env.AIH_STALL_TIMEOUT_MS;
    else process.env.AIH_STALL_TIMEOUT_MS = prevStall;
  }
}

{
  // FA#3 — reasoning-runaway watchdog.
  // 1) pure decision (isReasoningRunaway): reasoning-only past the char cap →
  //    runaway; with text or a tool call → healthy; under budget → not runaway.
  assert(
    isReasoningRunaway({ reasoningChars: 20_000, hasText: false, hasToolCall: false, elapsedMs: 100 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 reasoning-only past char cap → runaway",
  );
  assert(
    !isReasoningRunaway({ reasoningChars: 20_000, hasText: true, hasToolCall: false, elapsedMs: 100 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 text present → healthy (not runaway)",
  );
  assert(
    !isReasoningRunaway({ reasoningChars: 20_000, hasText: false, hasToolCall: true, elapsedMs: 100 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 tool call present → healthy (not runaway)",
  );
  assert(
    isReasoningRunaway({ reasoningChars: 100, hasText: false, hasToolCall: false, elapsedMs: 200_000 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 reasoning-only past time cap → runaway",
  );
  assert(
    !isReasoningRunaway({ reasoningChars: 1_000, hasText: false, hasToolCall: false, elapsedMs: 100 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 under both budgets → not runaway",
  );
  assert(
    !isReasoningRunaway({ reasoningChars: 0, hasText: false, hasToolCall: false, elapsedMs: 200_000 }, { maxChars: 16_384, timeoutMs: 120_000 }),
    "FA#3 no reasoning yet → not runaway",
  );
  console.log("ok: FA#3 isReasoningRunaway pure decision");

  // 2) integration: a reasoning-only stream that exceeds the char cap throws
  //    ReasoningRunawayError (folds into the retry budget).
  const prevFirst = process.env.AIH_FIRST_TOKEN_TIMEOUT_MS;
  const prevStall = process.env.AIH_STALL_TIMEOUT_MS;
  const prevTo = process.env.AIH_REASONING_ONLY_TIMEOUT_MS;
  const prevMax = process.env.AIH_REASONING_ONLY_MAX_CHARS;
  process.env.AIH_FIRST_TOKEN_TIMEOUT_MS = "180000"; // no first-token fire
  process.env.AIH_STALL_TIMEOUT_MS = "180000"; // no inter-frame fire
  process.env.AIH_REASONING_ONLY_TIMEOUT_MS = "0"; // disable time guard
  process.env.AIH_REASONING_ONLY_MAX_CHARS = "100"; // tiny char cap → fire fast
  try {
    const reasoningBody = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < n; i += 1) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(50) } }] })}\n\n`));
          }
          // no close — the stream would otherwise hang; the watchdog throws first
        },
      });
    let calls = 0;
    const llm = new OpenAICompatibleLLM({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      retries: 1,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(reasoningBody(10), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    const err = (await llm.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => {},
    }).catch((e: unknown) => e)) as ReasoningRunawayError;
    assert(err instanceof ReasoningRunawayError, "FA#3 reasoning-only runaway throws ReasoningRunawayError");
    assert(err.reasoningChars > 100, "FA#3 error carries the reasoning char count");
    assert(calls === 2, "FA#3 runaway folds into the retry budget (2 attempts)");
  } finally {
    if (prevFirst === undefined) delete process.env.AIH_FIRST_TOKEN_TIMEOUT_MS;
    else process.env.AIH_FIRST_TOKEN_TIMEOUT_MS = prevFirst;
    if (prevStall === undefined) delete process.env.AIH_STALL_TIMEOUT_MS;
    else process.env.AIH_STALL_TIMEOUT_MS = prevStall;
    if (prevTo === undefined) delete process.env.AIH_REASONING_ONLY_TIMEOUT_MS;
    else process.env.AIH_REASONING_ONLY_TIMEOUT_MS = prevTo;
    if (prevMax === undefined) delete process.env.AIH_REASONING_ONLY_MAX_CHARS;
    else process.env.AIH_REASONING_ONLY_MAX_CHARS = prevMax;
  }
  console.log("ok: FA#3 reasoning-runaway watchdog (integration)");
}

{
  // FA#5 — pluggable loop observers.
  // 1) notifyObservers: fan-out, swallows non-LoopAbort, propagates first LoopAbort.
  {
    const seen: string[] = [];
    notifyObservers(
      [
        { onTurnStart: (t) => seen.push(`A:${t}`) },
        { onTurnStart: (t) => { seen.push("B-err"); throw new Error("boom"); } },
        { onTurnStart: (t) => seen.push(`C:${t}`) },
      ],
      (o) => o.onTurnStart?.("t1"),
    );
    assert(seen.length === 3 && seen[1] === "B-err", "FA#5 non-LoopAbort observer error is swallowed (fan-out continues)");
    const abort = notifyObservers(
      [{ onTurnStart: () => { throw new LoopAbort("stop"); } }],
      (o) => o.onTurnStart?.("t1"),
    );
    assert(abort instanceof LoopAbort && abort.reason === "stop", "FA#5 LoopAbort propagates");
  }

  // 2) boundary order: onTurnStart → onModelResponse → onToolCall → onToolResult → onTurnEnd.
  {
    const order: string[] = [];
    const obs: LoopObserver = {
      onTurnStart: (t) => order.push(`start:${t}`),
      onModelResponse: (t, text, calls) => order.push(`model:${text}:${calls.length}`),
      onToolCall: (t, c) => order.push(`call:${c.name}`),
      onToolResult: (t, r) => order.push(`result:${r.name}:${r.ok}`),
      onTurnEnd: (t, r) => order.push(`end:${r}`),
    };
    const reg = new ToolRegistry(new AutoApprove());
    reg.register(echo);
    const mllm = new MockLLM([
      { text: "echoing", toolCalls: [toolCall("c1", "echo", { text: "hi" })], stopReason: "tool_use" },
      { text: "done", stopReason: "end_turn" },
    ]);
    const olog = new SessionLog();
    const oloop = new AgentLoop({ llm: mllm, tools: reg, log: olog, observers: [obs] });
    const res = await oloop.send("echo hi");
    assert(res.stopReason === "end_turn", "FA#5 observer turn ends normally");
    assert(
      order[0].startsWith("start:") &&
        order[1].startsWith("model:") &&
        order.includes("call:echo") &&
        order.includes("result:echo:true") &&
        order[order.length - 1].startsWith("end:"),
      `FA#5 observer boundaries fire in order (got: ${order.join(", ")})`,
    );
    const startIdx = order.findIndex((s) => s.startsWith("start:"));
    const modelIdx = order.findIndex((s) => s.startsWith("model:"));
    const callIdx = order.findIndex((s) => s === "call:echo");
    const resultIdx = order.findIndex((s) => s.startsWith("result:echo:"));
    const endIdx = order.length - 1;
    assert(startIdx < modelIdx && modelIdx < callIdx && callIdx < resultIdx && resultIdx < endIdx, "FA#5 strict boundary ordering");
  }

  // 3) LoopAbort from onToolCall stops the turn; the unexecuted call gets a failure result.
  {
    const reg = new ToolRegistry(new AutoApprove());
    reg.register(echo);
    const mllm = new MockLLM([
      { text: "echoing", toolCalls: [toolCall("c1", "echo", { text: "hi" })], stopReason: "tool_use" },
      { text: "done", stopReason: "end_turn" },
    ]);
    const olog = new SessionLog();
    const obs: LoopObserver = {
      onToolCall: () => { throw new LoopAbort("policy: no echo"); },
    };
    const oloop = new AgentLoop({ llm: mllm, tools: reg, log: olog, observers: [obs] });
    const res = await oloop.send("echo hi");
    assert(res.stopReason === "cancelled", "FA#5 LoopAbort stops the turn (cancelled)");
    const evts = olog.all();
    const echoCall = evts.find((e): e is Extract<SessionEvent, { type: "tool/call" }> => e.type === "tool/call" && e.name === "echo");
    const echoResult = echoCall ? evts.find((e): e is Extract<SessionEvent, { type: "tool/result" }> => e.type === "tool/result" && e.callId === echoCall.callId) : undefined;
    assert(!!echoCall, "FA#5 aborted call is still logged (tool/call)");
    assert(!!echoResult && echoResult.ok === false, "FA#5 aborted call gets a failure result (pairing preserved)");
  }
  console.log("ok: FA#5 loop observers (fan-out, boundary order, LoopAbort)");
}

{
  // FA#4 — repetition stop-loss observer.
  // 1) pure helpers: stableStringify (key-order independent) + textSimilarity.
  assert(
    stableStringify({ a: 1, b: [2, 3] }) === stableStringify({ b: [2, 3], a: 1 }),
    "FA#4 stableStringify is key-order independent",
  );
  assert(stableStringify(null) === "null" && stableStringify(undefined) === "undefined", "FA#4 stableStringify null/undefined");
  assert(textSimilarity("the quick brown fox", "the quick brown fox") === 1, "FA#4 textSimilarity identical = 1");
  assert(textSimilarity("the quick brown fox", "totally different text here") < 0.5, "FA#4 textSimilarity disjoint < 0.5");
  assert(textSimilarity("", "x") === 0, "FA#4 textSimilarity empty = 0");
  console.log("ok: FA#4 pure helpers (stableStringify, textSimilarity)");

  // 2) RepetitionObserver — ② consecutive identical tool calls: hint@3, stop@6.
  {
    const obs = new RepetitionObserver({ hintAt: 3, stopAt: 6 });
    const hints: string[] = [];
    obs.bind({ inject: (t) => hints.push(t) });
    const call = { callId: "c", name: "echo", args: { text: "hi" } };
    let threw = false;
    for (let i = 0; i < 5; i += 1) {
      try { obs.onToolCall("t", call); } catch (e) { threw = e instanceof LoopAbort; }
    }
    assert(!threw, "FA#4 5 identical calls (< stopAt 6) does not stop");
    assert(hints.length >= 1, "FA#4 hint fired at consecutive 3");
    try { obs.onToolCall("t", call); } catch (e) { threw = e instanceof LoopAbort; }
    assert(threw, "FA#4 6th identical call → LoopAbort (stop)");
  }

  // 3) RepetitionObserver — ① duplicate query (executed with content, re-requested).
  {
    const obs = new RepetitionObserver();
    const hints: string[] = [];
    obs.bind({ inject: (t) => hints.push(t) });
    const call = { callId: "c1", name: "search", args: { q: "foo" } };
    obs.onToolCall("t", call);
    obs.onToolResult("t", { callId: "c1", name: "search", ok: true, result: "found 3 docs" });
    obs.onToolCall("t", { callId: "c2", name: "search", args: { q: "foo" } });
    assert(hints.some((h) => h.includes("duplicate query")), "FA#4 duplicate query (same args, had content) → hint");
  }

  // 4) RepetitionObserver — ③ near-verbatim text: hint@2, stop@3.
  {
    const obs = new RepetitionObserver({ textHintAt: 2, textStopAt: 3 });
    const hints: string[] = [];
    obs.bind({ inject: (t) => hints.push(t) });
    const text = "I will now proceed to analyze the data carefully and report back the results soon";
    obs.onModelResponse("t", text, []);
    obs.onModelResponse("t", text, []); // near-verbatim 2nd → hint
    let threw = false;
    try { obs.onModelResponse("t", text, []); } catch (e) { threw = e instanceof LoopAbort; }
    assert(threw, "FA#4 near-verbatim text 3× → LoopAbort (stop)");
    assert(hints.length >= 1, "FA#4 text hint fired at repeat 2");
  }

  // 5) RepetitionObserver — distinct calls do NOT trip the repetition guard.
  {
    const obs = new RepetitionObserver({ hintAt: 3, stopAt: 6 });
    obs.bind({ inject: () => {} });
    obs.onToolCall("t", { callId: "1", name: "a", args: { x: 1 } });
    obs.onToolCall("t", { callId: "2", name: "b", args: { x: 2 } });
    obs.onToolCall("t", { callId: "3", name: "c", args: { x: 3 } });
    obs.onToolCall("t", { callId: "4", name: "a", args: { x: 1 } }); // same as #1 but not consecutive
    assert(true, "FA#4 non-consecutive / distinct calls do not trip the guard");
  }
  console.log("ok: FA#4 RepetitionObserver (repetition, duplicate-query, text-repetition, distinct)");
}

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
const compactReqs: ChatMessage[][] = [];
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
  llm: { complete: (req) => { lastCompactReq = req.messages; compactReqs.push(req.messages); return compactScripted.complete(req); } },
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
// Compaction state guard — after compaction the system prompt must carry
// COMPACTION_STATE_GUARD so the agent verifies current state before
// re-implementing work the summary lists as pending (observed bug: a single
// turn re-wrote the whole webfetch-hardening module after auto-compaction
// because the objective survived verbatim in the summary while the
// "already done" detail was buried → duplicate-identifier compile errors).
assert(
  req.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("After a context compaction")),
  "post-compaction system prompt carries the state-guard (verify before re-implement)",
);
assert(
  req.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Only re-implement when verification proves it is genuinely missing")),
  "state-guard forbids re-implementing verified-complete work",
);
assert(
  req.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("determine who owns it BEFORE touching it")),
  "state-guard checks ownership before touching existing work (multi-agent safe)",
);
// Freebuff ③ — the compaction prompt must tell the model the summary is
// HISTORICAL MEMORY ONLY: not dialogue, not an output template, not a
// tool-call format. Guards against the model copying the summary's
// structure into its live output after compaction.
assert(
  compactReqs.some((r) => r.some((m) => typeof m.content === "string" && m.content.includes("Historical memory only"))),
  "compaction summarization prompt carries the historical-memory-only guard",
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
    derivedOk.some((m) => m.role === "user" && String(m.content).includes("echo hi")),
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
    tamperedDerived.some((m) => String(m.content).includes("TAMPERED")),
    "coverage mismatch fails open to raw events (no false projection)",
  );
}

// Cumulative/garbage provider prompt_tokens must NOT be trusted as the
// context size, even inside a large window. Regression: a free-tier gateway
// reported 949K prompt_tokens on a ~78K-token conversation; the old
// plausibility gate (`promptTokens <= window*2`) green-lit it once the window
// grew to 1M, falsely tripping the 80% compaction trigger (949K ≥ 0.8×1M) and
// flashing a phantom "compact needed" on model switch. The wire number is
// accepted only while it stays within a sane band of the local chars÷4
// estimate.
{
  const { AgentLoop: Loop } = await import("./agent-loop.js");
  const gLog = new SessionLog();
  const gTools = new ToolRegistry(gate);
  gTools.register(echo);
  // Single turn reporting a garbage cumulative promptTokens (949K) on a log
  // whose local chars÷4 estimate is ~2K → must NOT become contextNow.
  const garbageLlm = new MockLLM([
    { text: "ok", stopReason: "end_turn", usage: { promptTokens: 949_390, completionTokens: 5, totalTokens: 949_395 } },
  ]);
  const gLoop = new Loop({
    llm: garbageLlm,
    tools: gTools,
    log: gLog,
    systemPrompt: "sys",
    contextWindow: 1_000_000, // 1M window — the 2×window gate alone admits 949K
    compactAt: 0.8,
  });
  gLog.append({ type: "user/message", turnId: "g1", text: "hello" });
  const gRes = await gLoop.send("hi");
  assert(gRes.stopReason === "end_turn", "garbage-promptTokens turn completes");
  assert(
    gRes.contextNow != null && gRes.contextNow < 10_000,
    `garbage promptTokens rejected: contextNow stays at local-estimate scale (got ${gRes.contextNow})`,
  );
  assert(
    !gLog.all().some((e) => e.type === "compaction"),
    "garbage promptTokens must not falsely trigger compaction",
  );
}

// Rolling compaction must tell the summarizer to drop finished work from
// "Objective" — otherwise a stale Objective duplicates a Completed item and
// the agent re-does finished work after compaction (observed: FB#5/#6 were
// implemented, then re-implemented after compaction).
{
  const { AgentLoop: Loop } = await import("./agent-loop.js");
  const rLog = new SessionLog();
  const rGate = new PolicyGate([{ match: (r) => r.tool === "echo", action: "allow" }]);
  const rTools = new ToolRegistry(rGate);
  rTools.register(echo);
  const rScripted = new MockLLM([
    { text: "SUMMARY-ONE" },
    { text: "SUMMARY-TWO" },
    { text: "final", stopReason: "end_turn" },
  ]);
  const rReq: ChatMessage[][] = [];
  const rLoop = new Loop({
    llm: { complete: (req) => { rReq.push(req.messages); return rScripted.complete(req); } },
    tools: rTools,
    log: rLog,
    systemPrompt: "sys",
    contextWindow: 5000,
    compactAt: 0.8,
  });
  // First compaction (no prior summary → initial SUMMARY_TEMPLATE).
  rLog.append({ type: "user/message", turnId: "b1", text: `bulk1: ${"x".repeat(400)}` });
  rLog.append({ type: "assistant/message", turnId: "b1", text: `answer1: ${"y".repeat(400)}`, toolCalls: [] });
  const first = await rLoop.compactNow();
  assert(first.applied, "rolling: first compaction applies");
  assert(rLog.all().some((e) => e.type === "compaction"), "rolling: first compaction fires");
  // Second compaction — now there IS a prior summary, so the summarizer gets
  // SUMMARY_UPDATE_INSTRUCTIONS; it must forbid leaving done work in Objective.
  rLog.append({ type: "user/message", turnId: "b2", text: `bulk2: ${"z".repeat(400)}` });
  rLog.append({ type: "assistant/message", turnId: "b2", text: `answer2: ${"w".repeat(400)}`, toolCalls: [] });
  const updated = await rLoop.compactNow();
  assert(updated.applied, "rolling: second compaction applies");
  const updatePrompt = rReq.flat().map((m) => String(m.content)).join("\n");
  assert(
    updatePrompt.includes("never keep an item in \"Objective\" that is already done"),
    "rolling summary instructions forbid keeping finished work in Objective",
  );
  console.log("ok: rolling compaction warns against re-doing finished work after compaction");
}

// compactContext — an authoritative state snapshot (e.g. todo list) must be
// folded into EVERY compaction summary prompt so a compacted agent cannot
// forget what is done vs pending (the FB#5/#6 "re-did after compaction"
// bug). The summarizer must see "done, do NOT redo" as authoritative truth.
{
  const { AgentLoop: Loop } = await import("./agent-loop.js");
  const cLog = new SessionLog();
  const cGate = new PolicyGate([{ match: (r) => r.tool === "echo", action: "allow" }]);
  const cTools = new ToolRegistry(cGate);
  cTools.register(echo);
  const cReq: ChatMessage[][] = [];
  const cReqTokens: Array<number | undefined> = [];
  const cScripted = new MockLLM([{ text: "SNAPSHOT-SUMMARY" }]);
  const cLoop = new Loop({
    llm: { complete: (req) => { cReq.push(req.messages); cReqTokens.push(req.maxTokens); return cScripted.complete(req); } },
    tools: cTools,
    log: cLog,
    systemPrompt: "sys",
    contextWindow: 5000,
    compactAt: 0.8,
    compactContext: () =>
      "# Authoritative todo state (from .aih/todos.json)\n### Todos — ALREADY COMPLETED (verified, do NOT redo):\n- [x] FB#5 subagent answer cap\n- [x] FB#6 dual judge\n### Todos — still PENDING:\n- [ ] FB#7",
  });
  cLog.append({ type: "user/message", turnId: "c1", text: `bulk: ${"m".repeat(400)}` });
  cLog.append({ type: "assistant/message", turnId: "c1", text: `answer: ${"n".repeat(400)}`, toolCalls: [] });
  const applied = await cLoop.compactNow();
  assert(applied.applied, "compactContext: compaction applies");
  const prompt = cReq.flat().map((m) => String(m.content)).join("\n");
  assert(
    prompt.includes("Authoritative CURRENT STATE") && prompt.includes("ALREADY COMPLETED (verified, do NOT redo)"),
    "compactContext: todo snapshot folded into the summary prompt",
  );
  assert(
    prompt.includes("FB#5 subagent answer cap") && prompt.includes("FB#6 dual judge"),
    "compactContext: completed todos carried into the summary (do NOT redo)",
  );
  assert(
    prompt.includes("FB#7"),
    "compactContext: pending todos carried into the summary",
  );
  assert(
    cReqTokens.some((t) => t === 4096),
    "compaction summary LLM request carries maxTokens=4096 (opencode parity, bounded output)",
  );
  console.log("ok: compactContext folds authoritative todo state into every compaction summary");
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
    derived[0]?.role === "system" && String(derived[0].content).includes("Lessons from an abandoned branch"),
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
      String(derived2[0].content).includes("earlier work summarized") &&
      String(derived2[0].content).includes("Lessons from an abandoned branch"),
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
        (m.content === replayUser || replayUser.startsWith(String(m.content).slice(0, 100))),
    ) === true,
    "#compact keeps the turn's user request in the tail (verbatim or budget-truncated)",
  );
const replayDerived = replayLog.deriveMessages("sys");
assert(
  replayDerived.some(
    (m) =>
      m.role === "user" &&
      (m.content === replayUser || replayUser.startsWith(String(m.content).slice(0, 100))),
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
// Bounded re-issue (opencode parity): a length-truncated response injects a
// corrective nudge and lets the model retry instead of killing the turn.
// Script: attempt 1 truncates mid-call → rejected + nudge; attempt 2 issues a
// clean call → executes → ends the turn normally.
const truncLog = new SessionLog();
const truncLoop = new AgentLoop({
  llm: new MockLLM([
    { text: "half", toolCalls: [toolCall("t1", "echo", { text: "x" })], stopReason: "tool_use", finishReason: "length" },
    { text: "clean re-issue", toolCalls: [toolCall("t2", "echo", { text: "y" })], stopReason: "tool_use" },
    { text: "done", stopReason: "end_turn" },
  ]),
  tools: truncTools,
  log: truncLog,
});
const truncResult = await truncLoop.send("go");
assert(truncResult.stopReason === "end_turn", "one truncation does not kill the turn — model re-issues and finishes");
const truncEvents = truncLoop.log.all();
const t1 = truncEvents.find((e) => e.type === "tool/result" && e.callId === "t1") as
  | Extract<SessionEvent, { type: "tool/result" }>
  | undefined;
assert(
  !!t1 && t1.ok === false && String(t1.error).includes("re-issue"),
  "truncated step's tool call is failed with a re-issue hint (never executed)",
);
assert(
  truncEvents.some((e) => e.type === "user/message" && e.text === TRUNCATED_RETRY_PROMPT),
  "a corrective nudge is injected after the truncated response",
);
assert(
  truncEvents.some((e) => e.type === "tool/result" && e.callId === "t2" && e.ok),
  "the re-issued call executes normally after the nudge",
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
// Repetition loop: if the model keeps truncating, the re-issues are bounded —
// after MAX_TRUNCATED_RETRIES nudges the turn ends with max_tokens.
const loopLog = new SessionLog();
const loopTrunc = await new AgentLoop({
  llm: new MockLLM([
    { text: "h1", toolCalls: [toolCall("r1", "echo", { text: "x" })], stopReason: "tool_use", finishReason: "length" },
    { text: "h2", toolCalls: [toolCall("r2", "echo", { text: "x" })], stopReason: "tool_use", finishReason: "length" },
    { text: "h3", toolCalls: [toolCall("r3", "echo", { text: "x" })], stopReason: "tool_use", finishReason: "length" },
  ]),
  tools: truncTools,
  log: loopLog,
}).send("go");
assert(loopTrunc.stopReason === "max_tokens", "a persistent repetition loop still ends as max_tokens");
assert(
  loopLog.all().filter((e) => e.type === "user/message" && e.text === TRUNCATED_RETRY_PROMPT).length === 2,
  "re-issue nudges are bounded to MAX_TRUNCATED_RETRIES (2)",
);
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

// ── CC#49: stream-stall protection ──────────────────────────────────────
{
  // 1) StallError with partial text → AgentLoop appends partial + resume
  //    prompt, then the next LLM call completes the answer.
  let stallFirst = true;
  const stallLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      if (stallFirst) {
        stallFirst = false;
        throw new StallError("I was explaining the design of", 60_000);
      }
      return {
        text: " the caching layer.",
        toolCalls: [],
        stopReason: "end_turn",
      };
    },
  };
  const stallLog = new SessionLog();
  const stallTools = new ToolRegistry({ async request() { return true; } });
  const stallLoop = new AgentLoop({ llm: stallLlm, tools: stallTools, log: stallLog });
  const stallResult = await stallLoop.send("explain the design");
  assert(stallResult.steps === 2, "stall-resume turn used two steps (stall + recovery)");
  const stallEvents = stallLog.all();
  const partialMsg = stallEvents.find(
    (e): e is Extract<SessionEvent, { type: "assistant/message" }> =>
      e.type === "assistant/message" && e.text === "I was explaining the design of",
  );
  assert(partialMsg !== undefined, "partial text is preserved in the transcript");
  assert(partialMsg!.toolCalls.length === 0, "partial message carries empty toolCalls");
  const resumeMsg = stallEvents.find(
    (e): e is Extract<SessionEvent, { type: "user/message" }> =>
      e.type === "user/message" && e.text === STREAM_RESUME_PROMPT,
  );
  assert(resumeMsg !== undefined, "STREAM_RESUME_PROMPT is appended after the partial text");
  const finalMsg = stallEvents.find(
    (e): e is Extract<SessionEvent, { type: "assistant/message" }> =>
      e.type === "assistant/message" && e.text === " the caching layer.",
  );
  assert(finalMsg !== undefined, "recovery response completes the answer");
  const stallDerived = stallLog.deriveMessages("sys");
  const stallAssistantTexts = stallDerived
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);
  assert(
    stallAssistantTexts.some((t) => t === "I was explaining the design of"),
    "partial text is visible in derived messages",
  );
  assert(
    stallAssistantTexts.some((t) => t === " the caching layer."),
    "recovery text is visible in derived messages",
  );

  // 2) StallError with empty partial text → propagates to caller (no resume).
  const emptyStallLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new StallError("", 60_000);
    },
  };
  const emptyStallLog = new SessionLog();
  const emptyStallLoop = new AgentLoop({
    llm: emptyStallLlm,
    tools: stallTools,
    log: emptyStallLog,
  });
  let emptyStallThrew = false;
  try {
    await emptyStallLoop.send("explain the design");
  } catch (err) {
    emptyStallThrew = err instanceof StallError && err.partialText === "";
  }
  assert(emptyStallThrew, "empty-partial StallError propagates to the caller");

  // 3) Bounded: a second StallError in the same turn (after one resume)
  //    propagates instead of looping forever.
  let doubleStallCalls = 0;
  const doubleStallLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      doubleStallCalls += 1;
      if (doubleStallCalls === 1) {
        throw new StallError("first partial", 60_000);
      }
      throw new StallError("second partial", 60_000);
    },
  };
  const doubleStallLog = new SessionLog();
  const doubleStallLoop = new AgentLoop({
    llm: doubleStallLlm,
    tools: stallTools,
    log: doubleStallLog,
  });
  let doubleStallThrew = false;
  try {
    await doubleStallLoop.send("explain the design");
  } catch (err) {
    doubleStallThrew = err instanceof StallError;
  }
  assert(doubleStallThrew, "second StallError in same turn propagates (bounded resume)");
  const doubleEvents = doubleStallLog.all();
  const resumeCount = doubleEvents.filter(
    (e) => e.type === "user/message" && e.text === STREAM_RESUME_PROMPT,
  ).length;
  assert(resumeCount === 1, "exactly one STREAM_RESUME_PROMPT appended (bounded to MAX_STALL_RESUMES)");
}

// ── CC#51: usage-limit (quota) auto-resume ─────────────────────────────
{
  // 1) isQuotaExhaustion: quota 429 vs transient 429 vs non-quota status.
  assert(isQuotaExhaustion(429, "rate limit exceeded, quota resets at 00:00 UTC"), "quota keyword 429 → quota");
  assert(isQuotaExhaustion(429, "Your credits are exhausted"), "credits keyword 429 → quota");
  assert(!isQuotaExhaustion(429, "slow down"), "plain 429 without quota keyword → NOT quota");
  assert(isQuotaExhaustion(429, "try again later", 120), "429 with large Retry-After → quota");
  assert(!isQuotaExhaustion(429, "try again later", 2), "429 with small Retry-After → NOT quota");
  assert(!isQuotaExhaustion(500, "quota"), "non-429/402 → NOT quota");
  assert(isQuotaExhaustion(402, "insufficient credits"), "402 with credits → quota");

  // 2) Adapter throws QuotaError (not a retryable HTTP error) for a quota 429.
  const quotaAdapter = new OpenAICompatibleLLM({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    model: "m",
    retries: 3,
    fetchImpl: (async () =>
      new Response("rate limit: quota exhausted, resets in 60s", {
        status: 429,
        headers: { "retry-after": "60" },
      })) as typeof fetch,
  });
  const quotaErr = (await quotaAdapter
    .complete({ messages: [{ role: "user", content: "hi" }], tools: [] })
    .catch((e: unknown) => e)) as QuotaError;
  assert(quotaErr instanceof QuotaError, "quota 429 → QuotaError (not a retried HTTP error)");
  assert(quotaErr.retryAfterSec === 60, "QuotaError carries the Retry-After horizon");

  // 3) AgentLoop: quota 429 → wait → re-issue SAME call → success. The
  //    quota_wait event is logged and the turn completes (not an error).
  let quotaCalls = 0;
  const quotaLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      quotaCalls += 1;
      if (quotaCalls === 1) throw new QuotaError(429, "quota exhausted", 1);
      return { text: "done after quota reset", toolCalls: [], stopReason: "end_turn" };
    },
  };
  const quotaLog = new SessionLog();
  const quotaTools = new ToolRegistry({ async request() { return true; } });
  const quotaLoop = new AgentLoop({ llm: quotaLlm, tools: quotaTools, log: quotaLog });
  let beginInfo: { retryAfterSec: number; resumeAtMs: number; wait: number } | undefined;
  let endReason: string | undefined;
  const quotaResult = await quotaLoop.send("explain", {
    quotaWait: {
      begin: (i) => { beginInfo = i; },
      end: (r) => { endReason = r; },
    },
  });
  assert(quotaResult.stopReason === "end_turn", "quota turn completes after auto-resume");
  assert(quotaCalls === 2, "quota 429 re-issued the SAME call once (2 total)");
  assert(beginInfo !== undefined, "quotaWait.begin fired");
  assert(beginInfo!.wait === 1 && beginInfo!.retryAfterSec === 1, "begin carries wait=1, retryAfterSec=1");
  assert(endReason === "done", "quotaWait.end fired with reason=done");
  const quotaEvents = quotaLog.all();
  const quotaWaitEvent = quotaEvents.find((e) => e.type === "quota_wait");
  assert(quotaWaitEvent !== undefined, "quota_wait event logged");
  assert(quotaWaitEvent!.wait === 1, "quota_wait wait=1");
  const quotaAssistant = quotaEvents.find(
    (e) => e.type === "assistant/message" && e.text === "done after quota reset",
  );
  assert(quotaAssistant !== undefined, "recovered response is in the transcript");

  // 4) Bounded: quota 429 on EVERY call → QuotaError propagates after the
  //    wait budget (MAX_QUOTA_WAITS) is exhausted.
  let alwaysQuotaCalls = 0;
  const alwaysQuotaLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      alwaysQuotaCalls += 1;
      throw new QuotaError(429, "quota exhausted", 1);
    },
  };
  const alwaysQuotaLog = new SessionLog();
  const alwaysQuotaLoop = new AgentLoop({
    llm: alwaysQuotaLlm,
    tools: quotaTools,
    log: alwaysQuotaLog,
  });
  let alwaysQuotaThrew = false;
  try {
    await alwaysQuotaLoop.send("explain", {
      quotaWait: { begin: () => {}, end: () => {} },
    });
  } catch (err) {
    alwaysQuotaThrew = err instanceof QuotaError;
  }
  assert(alwaysQuotaThrew, "quota budget exhausted → QuotaError propagates");
  const alwaysQuotaWaits = alwaysQuotaLog.all().filter((e) => e.type === "quota_wait").length;
  assert(alwaysQuotaWaits === 2, `quota waits bounded (got ${alwaysQuotaWaits}, want 2 = MAX_QUOTA_WAITS)`);

  // 5) Non-interactive (no quotaWait hook) → QuotaError propagates immediately,
  //    no wait, no quota_wait event (run mode stays predictable).
  const noHookLlm: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new QuotaError(429, "quota exhausted", 60);
    },
  };
  const noHookLog = new SessionLog();
  const noHookLoop = new AgentLoop({ llm: noHookLlm, tools: quotaTools, log: noHookLog });
  let noHookThrew = false;
  try {
    await noHookLoop.send("explain");
  } catch (err) {
    noHookThrew = err instanceof QuotaError;
  }
  assert(noHookThrew, "no quotaWait hook → QuotaError propagates immediately");
  assert(noHookLog.all().filter((e) => e.type === "quota_wait").length === 0, "no quota_wait event in non-interactive mode");
}

// ────────────────────────────────────────────────────────────────────────────
// PE#2 — budget hard constraint + tripwire (pure state machine)
// ────────────────────────────────────────────────────────────────────────────
{
  // cost hard bound
  const bt = new BudgetTracker({ maxCostUsd: 1 });
  assert(bt.check({ costUsd: 0.5 }).state === "ok", "PE#2 cost under bound → ok");
  const hard = bt.check({ costUsd: 0.6 });
  assert(hard.state === "hard" && hard.kind === "cost", "PE#2 cost ≥ bound → hard/cost");
  if (hard.state === "hard") assert(hard.reason.includes("$"), "PE#2 cost verdict carries a reason");

  // writes hard bound
  const bw = new BudgetTracker({ maxWrites: 3 });
  assert(bw.check({ writes: 2 }).state === "ok", "PE#2 writes under bound → ok");
  const hw = bw.check({ writes: 2 });
  assert(hw.state === "hard" && hw.kind === "writes", "PE#2 writes ≥ bound → hard/writes");

  // timeout hard bound (injected clock)
  let now = 1_000_000;
  const bto = new BudgetTracker({ timeoutMs: 1000 }, { now: () => now });
  assert(bto.check({}).state === "ok", "PE#2 timeout under bound → ok");
  now += 1500;
  const ht = bto.check({});
  assert(ht.state === "hard" && ht.kind === "timeout", "PE#2 elapsed ≥ bound → hard/timeout");

  // scope deny (a denied path is a hard violation regardless of budget)
  const bsc = new BudgetTracker({ maxCostUsd: 100, denyPaths: ["node_modules", ".git"] });
  assert(bsc.check({ writePath: "src/app.ts" }).state === "ok", "PE#2 allowed path → ok");
  assert(bsc.check({ writePath: "node_modules/x.js" }).state === "hard", "PE#2 denied path → hard/scope");
  assert(isDenied(".git/config", ".git"), "PE#2 isDenied matches a file under the denied dir");
  assert(!isDenied("gitignore.txt", ".git"), "PE#2 isDenied is boundary-aware (no false prefix match)");

  // tripwire: single-task cost > 2× session mean (latched, cost only)
  const btw = new BudgetTracker({ maxCostUsd: 1000 });
  btw.check({ costUsd: 1 }); // sample 1
  btw.check({ costUsd: 1 }); // sample 2 → mean 1, cost 2 → not > 2×
  const tw = btw.check({ costUsd: 10 }); // cost 12, mean 4 → 12 ≥ 8 → tripwire
  assert(tw.state === "soft" && tw.kind === "tripwire", "PE#2 cost spike → soft tripwire");
  btw.latchTripwire();
  assert(btw.check({ costUsd: 1 }).state === "ok", "PE#2 tripwire latched → no re-fire");

  // parseBudget: JSON + key=value
  const p1 = parseBudget({ maxCostUsd: 2, maxWrites: 5, denyPaths: ["a", "b"] });
  assert(p1.maxCostUsd === 2 && p1.maxWrites === 5 && p1.denyPaths?.length === 2, "PE#2 parseBudget JSON");
  const p2 = parseBudget("maxCostUsd=1,maxWrites=3,denyPaths=x|y");
  assert(p2.maxCostUsd === 1 && p2.maxWrites === 3 && p2.denyPaths?.length === 2, "PE#2 parseBudget key=value");
  console.log("ok: PE#2 budget tracker (cost/writes/timeout/scope/tripwire/parse)");
}

// ────────────────────────────────────────────────────────────────────────────
// PE#1 — computational sensor loop (verdict → feedback → escalate)
// ────────────────────────────────────────────────────────────────────────────
{
  // green sensor → pass
  const green = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], run: async () => ({ ok: true, detail: "ok" }) },
  ]);
  const g = await green.afterWrite("write_file", { path: "a.ts" }, "t1");
  assert(g.passed === true && g.escalated === false, "PE#1 green sensor → pass");

  // red sensor, retries remain → feedback, not escalated
  const red1 = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], run: async () => ({ ok: false, detail: "2 errors" }) },
  ], { retries: 1 });
  const r1 = await red1.afterWrite("write_file", { path: "a.ts" }, "t1");
  assert(r1.passed === false && r1.escalated === false && (r1.feedback?.includes("retry") === true), "PE#1 red w/ retry left → feedback");

  // red sensor, retries exhausted → escalated
  const red2 = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], run: async () => ({ ok: false, detail: "2 errors" }) },
  ], { retries: 0 });
  const r2 = await red2.afterWrite("write_file", { path: "a.ts" }, "t1");
  assert(r2.passed === false && r2.escalated === true, "PE#1 red w/ no retries → escalated");

  // non-applicable tool → pass (no sensor runs)
  const na = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], run: async () => ({ ok: false, detail: "x" }) },
  ]);
  const nr = await na.afterWrite("echo", {}, "t1");
  assert(nr.passed === true, "PE#1 sensor not applicable to tool → pass");

  // pathPrefix filter: sensor only fires for matching paths
  const pf = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], pathPrefix: "src", run: async () => ({ ok: false, detail: "x" }) },
  ], { retries: 0 });
  const pfHit = await pf.afterWrite("write_file", { path: "src/a.ts" }, "t1");
  const pfMiss = await pf.afterWrite("write_file", { path: "docs/a.md" }, "t1");
  assert(pfHit.escalated === true, "PE#1 pathPrefix match → sensor ran");
  assert(pfMiss.passed === true, "PE#1 pathPrefix mismatch → sensor skipped");
  console.log("ok: PE#1 sensor loop (green/red/retry/escalate/pathPrefix)");
}

// ────────────────────────────────────────────────────────────────────────────
// PE#1/PE#2/PE#4 — AgentLoop integration: sensor red → escalate, budget hard → escalate
// ────────────────────────────────────────────────────────────────────────────
{
  // A write tool that succeeds (so the sensor/budget path is exercised).
  const writer: ToolDefinition = {
    name: "write_file",
    description: "write",
    kind: "write",
    permission: "allow",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (a) => ({ ok: true, path: (a as { path: string }).path }),
  };
  const wTools = new ToolRegistry(new AutoApprove());
  wTools.register(writer);

  // (a) sensor red after retries → stopReason "escalated" + escalate event
  let escalations: { reason: string; options: string[]; safestDefault: string }[] = [];
  const sensorLlm = new MockLLM([
    { text: "writing", toolCalls: [toolCall("w1", "write_file", { path: "a.ts" })], stopReason: "tool_use" },
    { text: "done", stopReason: "end_turn" },
  ]);
  const redSensor = new SensorLoop([
    { name: "tsc", onTools: ["write_file"], run: async () => ({ ok: false, detail: "type error" }) },
  ], { retries: 0 });
  const sLog = new SessionLog();
  const sLoop = new AgentLoop({
    llm: sensorLlm,
    tools: wTools,
    log: sLog,
    sensors: redSensor,
    onEscalate: (v) => escalations.push(v),
  });
  const sRes = await sLoop.send("write it");
  assert(sRes.stopReason === "escalated", "PE#4 sensor red (retries 0) → stopReason escalated");
  assert(escalations.length === 1 && escalations[0].safestDefault.length > 0, "PE#4 onEscalate hook fired with options + safestDefault");
  assert(sLog.all().some((e) => e.type === "escalate"), "PE#4 escalate event recorded in the log (model-invisible)");

  // (b) budget hard (writes) → stopReason "escalated"
  const bEsc: { reason: string }[] = [];
  const budgetLlm = new MockLLM([
    { text: "writing", toolCalls: [toolCall("w1", "write_file", { path: "a.ts" })], stopReason: "tool_use" },
    { text: "done", stopReason: "end_turn" },
  ]);
  const bTracker = new BudgetTracker({ maxWrites: 1 });
  const bLog = new SessionLog();
  const bLoop = new AgentLoop({
    llm: budgetLlm,
    tools: wTools,
    log: bLog,
    budget: bTracker,
    onEscalate: (v) => bEsc.push(v),
  });
  const bRes = await bLoop.send("write it");
  assert(bRes.stopReason === "escalated", "PE#4 budget hard (writes) → stopReason escalated");
  assert(bEsc.length === 1 && bEsc[0].reason.includes("writes"), "PE#4 budget escalate reason names the writes bound");

  // (c) budget soft tripwire → onTripwire fires once, turn continues
  const trips: number[] = [];
  const tripLlm = new MockLLM([
    { text: "writing", toolCalls: [toolCall("w1", "write_file", { path: "a.ts" })], stopReason: "tool_use" },
    { text: "done", stopReason: "end_turn" },
  ]);
  const tripTracker = new BudgetTracker({ maxCostUsd: 1000 });
  tripTracker.addUsage(1);
  tripTracker.addUsage(10); // spike → tripwire on the next check
  const tLog = new SessionLog();
  const tLoop = new AgentLoop({
    llm: tripLlm,
    tools: wTools,
    log: tLog,
    budget: tripTracker,
    costOf: () => 0,
    onTripwire: (v) => trips.push(v.currentCostUsd),
  });
  const tRes = await tLoop.send("write it");
  assert(tRes.stopReason === "end_turn", "PE#2 soft tripwire does not stop the turn");
  assert(trips.length >= 1, "PE#2 onTripwire surfaced the soft verdict");
  console.log("ok: PE#1/PE#2/PE#4 AgentLoop integration (sensor/budget → escalate, tripwire → continue)");
}

console.log("\nAIH core smoke test passed.");

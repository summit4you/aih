import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentLoop,
  AutoApprove,
  DenyAll,
  MockLLM,
  OpenAICompatibleLLM,
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
import type { ChatMessage, SessionEvent, ToolDefinition } from "./types.js";

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
assert(
  retryRes.text === "ok" && retryRes.usage?.totalTokens === 15,
  "usage mapped from OpenAI-compatible response",
);

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

const mockStreamLlm = new MockLLM([{ text: "streamed mock text", stopReason: "end_turn" }]);
const loopStream = new AgentLoop({
  llm: mockStreamLlm,
  tools,
});
let mockStreamed = "";
const streamTurn = await loopStream.send("echo", { onDelta: (d) => (mockStreamed += d) });
assert(mockStreamed === "streamed mock text", "MockLLM emits deltas through the loop");
assert(streamTurn.steps === 1, "streamed turn completes normally");

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
  replayCompacts[0].recent?.some((m) => m.role === "user" && m.content === replayUser) === true,
  "#compact replays the turn's user message when the tail selection is empty",
);
const replayDerived = replayLog.deriveMessages("sys");
assert(
  replayDerived.some((m) => m.role === "user" && m.content === replayUser),
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
assert(
  !truncLoop.log.all().some((e) => e.type === "tool/call"),
  "truncated step's tool calls are not executed (possibly incomplete args)",
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

console.log("\nAIH core smoke test passed.");

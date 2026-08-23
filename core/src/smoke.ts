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
} from "./index.js";
import type { ChatMessage, ToolDefinition } from "./types.js";

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

console.log("\nAIH core smoke test passed.");

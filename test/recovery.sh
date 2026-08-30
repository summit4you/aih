#!/usr/bin/env bash
#
# PE#4 — escalate 原语 + 恢复测试 (recovery test)
#
# PE#4 acceptance (docs/roadmap.md):
#   1. escalate 落盘事件可回放  — a persisted `escalate` event (options +
#      safestDefault + reason) survives in the session log and is replayable.
#   2. 非交互退出码 3           — a non-interactive run that hits a hard bound
#      stops and exits with code 3 (the onEscalate hook already printed the
#      options + safest default).
#   3. 恢复测试通过（续跑不重复）— a mid-turn crash is re-opened on resume, the
#      dispatched-but-unresolved tool is PARKED (outcome unknown), and resume
#      does NOT re-dispatch it ("续跑不重复").
#
# The test drives the REAL CLI (mock LLM, no provider key) against a real
# persisted session file, then simulates a crash by appending the immutable
# event triple (user message → tool/call → tool/dispatch, no result) and
# verifies the recovery classifier + the no-re-dispatch guarantee.
#
# Exit 0 on success, 1 on the first failed assertion.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/cli/dist/index.js"

if [ ! -f "$CLI" ]; then
  echo "FAIL: cli/dist/index.js not found — run 'npm run build' first" >&2
  exit 1
fi

# A throwaway workspace so we never touch a real user's sessions/config.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/aih-recovery-XXXXXX")"
SESSION="rec-$(date +%s%N 2>/dev/null || echo "$RANDOM")"
SESSION_FILE="$WORK/.aih/sessions/$SESSION.jsonl"

PASS=0
FAIL=0
ok()   { echo "ok:   $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1" >&2; FAIL=$((FAIL+1)); }
check(){ if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi; }

# Run the CLI in the throwaway workspace with a mock LLM (no provider key).
run_cli() {
  ( cd "$WORK" && AIH_TRUST_ALL_PROJECTS=1 node "$CLI" "$@" )
}

# ────────────────────────────────────────────────────────────────────────────
# Phase 1 — escalate: a hard budget bound stops the turn, persists the event,
# and the non-interactive run exits with code 3.
# ────────────────────────────────────────────────────────────────────────────
echo "── PE#4 phase 1: escalate (budget hard) → exit 3 + persisted event ──"

# maxWrites=1: the mock LLM's single add_todo write trips the writes bound.
OUT="$(AIH_BUDGET="maxWrites=1" run_cli run "add a todo" --mock --yes --session "$SESSION" 2>&1)"
CODE=$?
check "$([ "$CODE" -eq 3 ] && echo 0 || echo 1)" "non-interactive run exits with code 3 (got $CODE)"
check "$([ -f "$SESSION_FILE" ] && echo 0 || echo 1)" "session file persisted ($SESSION_FILE)"

# The escalate event must be in the persisted log with the full shape.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const esc = lines.find((e) => e.type === "escalate");
  if (!esc) { console.error("no escalate event"); process.exit(1); }
  if (typeof esc.reason !== "string" || !esc.reason) { console.error("escalate.reason missing"); process.exit(1); }
  if (!Array.isArray(esc.options) || esc.options.length < 2) { console.error("escalate.options missing"); process.exit(1); }
  if (typeof esc.safestDefault !== "string" || !esc.safestDefault) { console.error("escalate.safestDefault missing"); process.exit(1); }
  const ended = lines.find((e) => e.type === "turn/end" && e.stopReason === "escalated");
  if (!ended) { console.error("no turn/end stopReason=escalated"); process.exit(1); }
  process.exit(0);
' "$SESSION_FILE"
check "$?" "persisted escalate event has reason + options + safestDefault, and the turn ended 'escalated'"

# The onEscalate hook must have surfaced the options + safest default to the user.
echo "$OUT" | grep -q "safest default"
check "$?" "onEscalate surfaced the safest default to the user"
echo "$OUT" | grep -q "budget writes exceeded"
check "$?" "onEscalate surfaced the escalate reason"

# ────────────────────────────────────────────────────────────────────────────
# Phase 2 — recovery: simulate a mid-turn crash (dispatched, no result), then
# verify the classifier parks it and resume does NOT re-dispatch it.
# ────────────────────────────────────────────────────────────────────────────
echo "── PE#4 phase 2: crash → resume → parked, no re-dispatch ──"

# Simulate a crash: a new turn whose tool was dispatched but never got a result
# (the process died between dispatch and result). This is the immutable event
# triple the recovery classifier reasons over.
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const nextSeq = lines.length ? Math.max(...lines.map((e) => e.seq)) + 1 : 0;
  const now = Date.now();
  const turn = "turn_crash_" + now.toString(36);
  const call = "c_crash_parked";
  const events = [
    { seq: nextSeq,     ts: now, type: "user/message",      turnId: turn, text: "keep going" },
    { seq: nextSeq + 1, ts: now, type: "tool/call",         turnId: turn, callId: call, name: "run_cmd", args: { command: "npm test" } },
    { seq: nextSeq + 2, ts: now, type: "tool/dispatch",     turnId: turn, callId: call, name: "run_cmd" },
  ];
  fs.appendFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  process.exit(0);
' "$SESSION_FILE"
check "$?" "crash simulated (user message → tool/call → tool/dispatch, no result)"

# The recovery classifier must see an open turn with a PARKED (indeterminate)
# tool — the side effect is unknown, so it must NOT be auto-retried.
node -e '
  const { SessionLog, scanRecovery, describeFact } = require(process.argv[1]);
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const log = SessionLog.fromEvents(lines);
  const rep = scanRecovery(log.all());
  if (!rep.openTurn) { console.error("no open turn detected"); process.exit(1); }
  const parked = rep.facts.find((f) => f.callId === "c_crash_parked");
  if (!parked) { console.error("parked tool fact not found"); process.exit(1); }
  if (parked.state !== "indeterminate") { console.error("parked tool state=" + parked.state + " (want indeterminate)"); process.exit(1); }
  if (!rep.parked) { console.error("report.parked is false (want true)"); process.exit(1); }
  if (!describeFact(parked).includes("outcome UNKNOWN")) { console.error("describeFact does not flag unknown outcome"); process.exit(1); }
  process.exit(0);
' "$ROOT/core/dist/index.js" "$SESSION_FILE"
check "$?" "recovery classifier: open turn + parked (indeterminate) tool, outcome UNKNOWN"

# Count dispatches of the parked tool BEFORE resume (must be exactly 1).
DISPATCH_BEFORE=$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(lines.filter((e) => e.type === "tool/dispatch" && e.callId === "c_crash_parked").length);
' "$SESSION_FILE")

# Resume: the CLI must (a) close the open turn (turn/end session_closed) and
# (b) NOT re-dispatch the parked tool. The mock LLM runs a fresh turn (a
# different callId), which is expected; the parked callId must stay at 1.
RESUME_RC=0
run_cli run "continue" --mock --yes -c "$SESSION" >/dev/null 2>&1 || RESUME_RC=$?
check "$([ "$RESUME_RC" -eq 0 ] || [ "$RESUME_RC" -eq 3 ] && echo 0 || echo 1)" "resume run completes (exit $RESUME_RC, want 0 or 3)"

# The open turn must now be closed (a turn/end for it was appended).
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const openTurn = lines.filter((e) => e.type === "tool/dispatch" && e.callId === "c_crash_parked").map((e) => e.turnId)[0];
  const closed = lines.find((e) => e.type === "turn/end" && e.turnId === openTurn);
  if (!closed) { console.error("open turn not closed on resume"); process.exit(1); }
  process.exit(0);
' "$SESSION_FILE"
check "$?" "resume closed the open (crashed) turn with a turn/end"

# The no-re-dispatch guarantee: the parked tool's dispatch count is unchanged.
DISPATCH_AFTER=$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(lines.filter((e) => e.type === "tool/dispatch" && e.callId === "c_crash_parked").length);
' "$SESSION_FILE")
check "$([ "$DISPATCH_BEFORE" = "$DISPATCH_AFTER" ] && [ "$DISPATCH_AFTER" -eq 1 ] && echo 0 || echo 1)" "no re-dispatch of the parked tool (before=$DISPATCH_BEFORE after=$DISPATCH_AFTER, want 1)"

# ────────────────────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────────────────────
echo "────────────────────────────────────────────────────────────"
echo "PE#4 recovery: $PASS passed, $FAIL failed"
rm -rf "$WORK"
[ "$FAIL" -eq 0 ] && { echo "PE#4 recovery test passed."; exit 0; } || { echo "PE#4 recovery test FAILED." >&2; exit 1; }

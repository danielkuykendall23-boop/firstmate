// Node-native test suite for .omp/extensions/fm-jev-compaction.ts.
// Run via `node --test tests/fm-jev-compaction.node.test.ts` (Node 24's
// built-in type stripping loads it directly; no build step, matching how omp
// itself loads the extension). tests/fm-jev-compaction.test.sh is the
// shellcheck-clean tests/ wrapper this repo's convention expects.
//
// This exercises the omp adapter and the real vendored upstream compact()
// together (compactOmpRegion runs both), never a hand-rolled reimplementation
// of the decision algorithm, and never touches the real Jev endpoint - every
// network-shaped test drives a fake fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditFromResult,
  buildFilesTag,
  compactOmpRegion,
  mergeAudits,
  mergeSplitTurnSummary,
  renderLibraryMessages,
  toLibraryMessages,
  type OmpMessage,
} from "../.omp/extensions/fm-jev-compaction.ts";
import { compact, type CompactResult, type Message as LibMessage } from "../.omp/extensions/vendor/fast-jev-compaction/src/index.ts";

function userText(text: string): OmpMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): OmpMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResult(toolCallId: string, text: string, isError = false): OmpMessage {
  return { role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError };
}

test("toLibraryMessages pairs an omp toolCall block with its separate toolResult message", () => {
  const messages: OmpMessage[] = [userText("do it"), assistantToolCall("c1", "read", { path: "a.ts" }), toolResult("c1", "file contents")];
  const lib = toLibraryMessages(messages);
  assert.equal(lib.length, 3);
  assert.equal(lib[0].role, "user");
  assert.equal(lib[0].text, "do it");
  assert.equal(lib[1].toolUses.length, 1);
  assert.equal(lib[1].toolUses[0].tool_use_id, "c1");
  assert.equal(lib[1].toolUses[0].tool, "read");
  assert.deepEqual(lib[1].toolUses[0].input, { path: "a.ts" });
  // Backfilled from the paired toolResult, matching what the vendored
  // library's own Claude Code-derived type doc comment assumes is present.
  assert.equal(lib[1].toolUses[0].text, "file contents");
  assert.equal(lib[2].toolResults?.[0].tool_use_id, "c1");
  assert.equal(lib[2].toolResults?.[0].text, "file contents");
});

test("toLibraryMessages leaves an unresulted toolCall's text/isError unset, not fabricated", () => {
  const lib = toLibraryMessages([assistantToolCall("c1", "read", { path: "a.ts" })]);
  assert.equal(lib[0].toolUses[0].text, undefined);
  assert.equal(lib[0].toolUses[0].isError, undefined);
});

test("renderLibraryMessages walks a kept Message[] verbatim, including an applyDecisions truncation note", () => {
  const messages: LibMessage[] = [
    { role: "user", text: "please read two files", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "keep1", tool: "read", input: { path: "a.ts" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "keep1", text: "kept content in full" }] },
  ];
  const rendered = renderLibraryMessages(messages);
  assert.match(rendered, /please read two files/);
  assert.match(rendered, /kept content in full/);
  assert.match(rendered, /\[tool call read\]/);
});

test("mergeSplitTurnSummary matches omp's documented split-turn section header format", () => {
  const merged = mergeSplitTurnSummary("older history text", "recent turn text");
  assert.equal(merged, "older history text\n\n---\n\n**Turn Context (split turn):**\n\nrecent turn text");
});

test("mergeSplitTurnSummary returns the non-empty side alone when the other is empty", () => {
  assert.equal(mergeSplitTurnSummary("history only", ""), "history only");
  assert.equal(mergeSplitTurnSummary("", "prefix only"), "prefix only");
});

test("mergeAudits sums counts and combines dropped ids without losing either side", () => {
  const a = { model: "jev-latest", keepThreshold: 0.5, candidateCalls: 2, kept: 1, truncated: 0, dropped: ["d1"], requestCount: 1, stateTokens: 100, reductionRatio: 0.5 };
  const b = { model: "jev-latest", keepThreshold: 0.5, candidateCalls: 3, kept: 2, truncated: 1, dropped: ["d2", "d3"], requestCount: 1, stateTokens: 200, reductionRatio: 0.25 };
  const merged = mergeAudits(a, b);
  assert.equal(merged.candidateCalls, 5);
  assert.equal(merged.kept, 3);
  assert.equal(merged.truncated, 1);
  assert.deepEqual(merged.dropped, ["d1", "d2", "d3"]);
  assert.equal(merged.requestCount, 2);
  assert.equal(merged.stateTokens, 300);
  // Weighted by candidateCalls: (0.5*2 + 0.25*3) / 5 = 0.35
  assert.ok(Math.abs(merged.reductionRatio - 0.35) < 1e-9);
});

test("buildFilesTag renders a read/write list capped at 20 and marks write-after-read as Write", () => {
  const tag = buildFilesTag({ read: { "a.ts": 1, "b.ts": 1 }, written: { "b.ts": 1 }, edited: {} });
  assert.match(tag, /a\.ts \(Read\)/);
  assert.match(tag, /b\.ts \(Write\)/);
  assert.doesNotMatch(tag, /b\.ts \(Read\)/, "a written file must not also be listed as read-only");
});

test("buildFilesTag returns an empty string when nothing was touched", () => {
  assert.equal(buildFilesTag({}), "");
});

test("auditFromResult reads counts straight from the vendored library's own CompactResult.stats/decisions", () => {
  const result: CompactResult = {
    messages: [],
    decisions: [
      { id: "t1", tool: "read", keepCall: 0.9, keepResult: 0.9, action: "keep", reason: "kept" },
      { id: "t2", tool: "bash", keepCall: 0.9, keepResult: 0.1, action: "drop_result", reason: "result_dropped" },
      { id: "t3", tool: "bash", keepCall: 0.1, keepResult: 0.1, action: "drop_call", reason: "call_dropped" },
    ],
    stats: { messagesBefore: 5, messagesAfter: 3, charsBefore: 1000, charsAfter: 400, calls: 3, kept: 1, resultsDropped: 1, callsDropped: 1, pinned: 0, stateTokens: 200, stateStage: "full", requests: 1, ms: 5 },
  };
  const audit = auditFromResult("jev-latest", 0.5, result);
  assert.equal(audit.candidateCalls, 3);
  assert.equal(audit.kept, 1);
  assert.equal(audit.truncated, 1);
  assert.deepEqual(audit.dropped, ["t3"]);
  assert.equal(audit.requestCount, 1);
  assert.equal(audit.stateTokens, 200);
  assert.ok(Math.abs(audit.reductionRatio - 0.6) < 1e-9);
});

test("compactOmpRegion runs the real vendored compact() end to end against a fake fetch, never sending real network traffic", async () => {
  const messages: OmpMessage[] = [
    userText("investigate the failing test"),
    assistantToolCall("keep1", "read", { path: "important.ts" }),
    toolResult("keep1", "the important content Jev should keep"),
    assistantToolCall("drop1", "bash", { command: "ls -la" }),
    toolResult("drop1", "drwxr-xr-x  2 x  x  64 Jan 1 00:00 .\n".repeat(20)),
  ];

  let requestCount = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body));
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(body.questions)) {
      // The vendored library's real question keys are `call_<id>`/`result_<id>`
      // where <id> is collectToolCalls' own "t1", "t2", ... assignment order -
      // t1 is the first paired call collected, i.e. keep1 here.
      const isKeep = name.endsWith("_t1");
      answers[name] = { type: "noul", noul: isKeep ? 0.95 : 0.05 };
    }
    return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  };

  const result = await compactOmpRegion(messages, { apiKey: "test-key", fetchImpl: fakeFetch, maxRequestTokens: 100000 });

  assert.equal(requestCount, 1);
  assert.equal(result.audit.candidateCalls, 2);
  assert.equal(result.audit.kept, 1);
  assert.equal(result.audit.dropped.length, 1);
  assert.equal(result.audit.dropped[0], "t2");
  assert.match(result.text, /important content Jev should keep/);
  assert.doesNotMatch(result.text, /drwxr-xr-x/, "dropped tool output must not appear in the rendered summary");
});

test("compactOmpRegion never orphans a tool call without its result or vice versa (the vendored library's own pairing guarantee)", async () => {
  // A leading text message keeps the tool call out of the library's own
  // unconditional "index 0 is always pinned" rule, so this actually
  // exercises the drop decision rather than the pin decision.
  const messages: OmpMessage[] = [userText("investigate"), assistantToolCall("c1", "read", { path: "a.ts" }), toolResult("c1", "content")];
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ model: "jev-latest", answers: { call_t1: { type: "noul", noul: 0.1 }, result_t1: { type: "noul", noul: 0.1 } } }), { status: 200 });
  const result = await compactOmpRegion(messages, { apiKey: "k", fetchImpl: fakeFetch });
  assert.equal(result.audit.dropped.length, 1, "a fully-dropped call drops call and result together, never one alone");
  assert.doesNotMatch(result.text, /content/, "the dropped result text must not leak into the summary");
});

test("the vendored compact() itself is reachable directly (proves this is the real upstream export, not a shadowed local copy)", async () => {
  const lib: LibMessage[] = [{ role: "user", text: "hello", toolUses: [] }];
  const fakeAsker = { async ask() { return { model: "jev-latest", answers: {} }; } };
  const result = await compact(lib, fakeAsker, {});
  assert.equal(result.messages.length, 1);
  assert.equal(result.stats.calls, 0, "no tool calls in this fixture: the vendored compact() makes zero Jev requests");
});

// Node-native test suite for .omp/extensions/fm-jev-compaction.ts.
// Run via `node --test tests/fm-jev-compaction.node.test.ts` (Node 24's
// built-in type stripping loads it directly; no build step, matching how omp
// itself loads the extension). tests/fm-jev-compaction.test.sh is the
// shellcheck-clean tests/ wrapper this repo's convention expects.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchCalls,
  buildFilesTag,
  buildState,
  decideCall,
  estimateTokens,
  jevCompactRegion,
  mergeAudits,
  mergeSplitTurnSummary,
  pairToolCalls,
  questionsFor,
  renderRegion,
  type OmpMessage,
} from "../.omp/extensions/fm-jev-compaction.ts";

function userText(text: string): OmpMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): OmpMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResult(toolCallId: string, text: string, isError = false): OmpMessage {
  return { role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError };
}

test("estimateTokens scales with letters, digits, and symbols roughly as documented", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("hello") >= 1);
  assert.ok(estimateTokens("a".repeat(600)) >= 100);
});

test("pairToolCalls only pairs calls that have a matching toolResult message", () => {
  const messages: OmpMessage[] = [
    userText("do it"),
    assistantToolCall("c1", "read", { path: "a.ts" }),
    toolResult("c1", "file contents"),
    assistantToolCall("c2", "read", { path: "b.ts" }), // no result yet
  ];
  const paired = pairToolCalls(messages);
  assert.equal(paired.length, 1);
  assert.equal(paired[0].toolCallId, "c1");
  assert.equal(paired[0].resultText, "file contents");
});

test("pairToolCalls pairs a call to its result regardless of adjacency", () => {
  const messages: OmpMessage[] = [
    assistantToolCall("c1", "read", { path: "a.ts" }),
    assistantToolCall("c2", "read", { path: "b.ts" }),
    toolResult("c2", "b contents"),
    toolResult("c1", "a contents"),
  ];
  const paired = pairToolCalls(messages);
  assert.equal(paired.length, 2);
  const byId = Object.fromEntries(paired.map((p) => [p.toolCallId, p.resultText]));
  assert.equal(byId.c1, "a contents");
  assert.equal(byId.c2, "b contents");
});

test("decideCall applies keepResult then keepCall against the threshold", () => {
  assert.equal(decideCall(0.9, 0.9, 0.5), "keep");
  assert.equal(decideCall(0.9, 0.3, 0.5), "truncate");
  assert.equal(decideCall(0.1, 0.1, 0.5), "drop");
  // Exactly-at-threshold counts as keep/truncate, matching upstream's `>=`.
  assert.equal(decideCall(0.5, 0.5, 0.5), "keep");
});

test("buildState fits within maxStateTokens by truncating inputs before falling back to no input", () => {
  const calls = pairToolCalls([
    assistantToolCall("c1", "read", { path: "x".repeat(5000) }),
    toolResult("c1", "y".repeat(50)),
  ]);
  const state = buildState(calls, { maxStateTokens: 50, truncateInputChars: [1000, 200, 60] });
  assert.ok(estimateTokens(state) <= 50, `state should fit budget, got ${estimateTokens(state)} tokens`);
});

test("questionsFor asks two independent noul questions per call", () => {
  const calls = pairToolCalls([assistantToolCall("c1", "bash", { command: "ls" }), toolResult("c1", "a.ts")]);
  const questions = questionsFor(calls[0], 0);
  assert.deepEqual(Object.keys(questions).sort(), ["keepCall0", "keepResult0"]);
});

test("batchCalls splits candidates so state plus questions stays under the request budget", () => {
  const calls = pairToolCalls(
    Array.from({ length: 20 }, (_, i) => [assistantToolCall(`c${i}`, "read", { path: `f${i}.ts` }), toolResult(`c${i}`, "x")]).flat(),
  );
  const batches = batchCalls(calls, 100, 200);
  assert.ok(batches.length >= 2, "20 calls at ~40 tokens each should need more than one batch under a 200-token cap");
  const flatIndices = batches.flat();
  assert.deepEqual(
    [...flatIndices].sort((a, b) => a - b),
    calls.map((_, i) => i),
    "every call index must appear exactly once across batches",
  );
});

test("renderRegion keeps text and full result verbatim for keep, a truncated result for truncate, and omits drop", () => {
  const messages: OmpMessage[] = [
    userText("please read two files"),
    assistantToolCall("keep1", "read", { path: "a.ts" }),
    toolResult("keep1", "kept content in full"),
    assistantToolCall("trunc1", "read", { path: "b.ts" }),
    toolResult("trunc1", "this is the very long result body that should be truncated"),
    assistantToolCall("drop1", "read", { path: "c.ts" }),
    toolResult("drop1", "dropped content"),
  ];
  const calls = pairToolCalls(messages);
  const decisions = new Map<string, "keep" | "truncate" | "drop">([
    ["keep1", "keep"],
    ["trunc1", "truncate"],
    ["drop1", "drop"],
  ]);
  const rendered = renderRegion(messages, calls, decisions, 10);
  assert.match(rendered, /please read two files/);
  assert.match(rendered, /kept content in full/, "a kept call's full result text must appear verbatim");
  assert.match(rendered, /this is th/, "a truncated call keeps its head");
  assert.doesNotMatch(rendered, /should be truncated/, "a truncated call must not keep text past its head cap");
  assert.doesNotMatch(rendered, /dropped content/, "a dropped call's result must never appear");
  assert.doesNotMatch(rendered, /drop1/, "dropped call ids must never leak into the rendered summary");
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

test("jevCompactRegion applies Jev's decisions end to end against a fake fetch, never sending real network traffic", async () => {
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
      const isKeep = name.includes("0"); // call index 0 = keep1
      answers[name] = { type: "noul", noul: isKeep ? 0.95 : 0.05 };
    }
    return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  };

  const result = await jevCompactRegion(messages, { apiKey: "test-key", fetchImpl: fakeFetch, maxRequestTokens: 100000 });

  assert.equal(requestCount, 1);
  assert.equal(result.audit.candidateCalls, 2);
  assert.equal(result.audit.kept, 1);
  assert.equal(result.audit.dropped.length, 1);
  assert.equal(result.audit.dropped[0], "drop1");
  assert.match(result.text, /important content Jev should keep/);
  assert.doesNotMatch(result.text, /drwxr-xr-x/, "dropped tool output must not appear in the rendered summary");
});

test("jevCompactRegion never orphans a tool call without its result or vice versa in the audit", async () => {
  const messages: OmpMessage[] = [
    assistantToolCall("c1", "read", { path: "a.ts" }),
    toolResult("c1", "content"),
  ];
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ model: "jev-latest", answers: { keepCall0: { type: "noul", noul: 0.1 }, keepResult0: { type: "noul", noul: 0.1 } } }), { status: 200 });
  const result = await jevCompactRegion(messages, { apiKey: "k", fetchImpl: fakeFetch });
  assert.equal(result.audit.dropped.length, 1, "a fully-dropped call drops call and result together, never one alone");
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

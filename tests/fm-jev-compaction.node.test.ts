// Node-native test suite for .omp/extensions/fm-jev-compaction.ts.
// Run via `node --test tests/fm-jev-compaction.node.test.ts` (Node 24's
// built-in type stripping loads it directly; no build step, matching how omp
// itself loads the extension). tests/fm-jev-compaction.test.sh is the
// shellcheck-clean tests/ wrapper this repo's convention expects.
//
// This exercises the omp adapter and the real vendored upstream compact()
// together (compactOmpRegion runs both), never a hand-rolled reimplementation
// of the decision algorithm, and never touches the real Jev endpoint - every
// network-shaped test drives a fake fetch, injected either directly or as
// the global fetch the registered session_before_compact handler picks up.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import registerJevCompaction, {
  auditFromResult,
  buildFilesTag,
  compactOmpRegion,
  envFileValue,
  mergeAudits,
  mergePreviousSummary,
  mergeSplitTurnSummary,
  renderLibraryMessages,
  toLibraryMessages,
  type JevCompactionAudit,
  type OmpCompactionPreparation,
  type OmpCompactionResult,
  type OmpMessage,
  type SessionBeforeCompactEvent,
} from "../.omp/extensions/fm-jev-compaction.ts";
import { compact, type CompactResult, type Message as LibMessage } from "../.omp/extensions/vendor/fast-jev-compaction/src/index.ts";

function userText(text: string): OmpMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): OmpMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): OmpMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResult(toolCallId: string, text: string, isError = false): OmpMessage {
  return { role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError };
}

function audit(overrides: Partial<JevCompactionAudit>): JevCompactionAudit {
  return {
    model: "jev-latest",
    keepThreshold: 0.5,
    candidateCalls: 0,
    kept: 0,
    truncated: 0,
    dropped: [],
    requestCount: 0,
    stateTokens: 0,
    charsBefore: 0,
    charsAfter: 0,
    reductionRatio: 0,
    ...overrides,
  };
}

// Jev answers keep for the first collected call (t1) and drop for every other.
function keepFirstDropRestFetch(seen: { headers: string[]; bodies: string[] }): typeof fetch {
  return async (_url, init) => {
    seen.headers.push(JSON.stringify(init?.headers ?? {}));
    seen.bodies.push(String(init?.body));
    const body = JSON.parse(String(init?.body));
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(body.questions)) {
      answers[name] = { type: "noul", noul: name.endsWith("_t1") ? 0.95 : 0.05 };
    }
    return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  };
}

// ---- Handler harness: registers the extension against a fake omp ExtensionAPI
// and drives the session_before_compact handler it installs, exactly as omp would.

type HookUi = { notify?: (message: string, kind?: string) => void; setStatus?: (key: string, text: string) => void };
type Handler = (event: unknown, ctx: { ui?: HookUi }) => Promise<{ compaction: OmpCompactionResult } | undefined>;

function loadHandler(): Handler {
  let handler: Handler | undefined;
  registerJevCompaction({
    on: (event, h) => {
      if (event === "session_before_compact") handler = h as Handler;
    },
  });
  assert.ok(handler, "the extension must register a session_before_compact handler");
  return handler;
}

function compactEvent(messagesToSummarize: OmpMessage[], overrides: Partial<OmpCompactionPreparation> = {}): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-9",
      messagesToSummarize,
      turnPrefixMessages: [],
      recentMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: {},
      ...overrides,
    },
  };
}

function uiCapture(): { notes: string[]; ctx: { ui: HookUi } } {
  const notes: string[] = [];
  return { notes, ctx: { ui: { notify: (message) => { notes.push(message); }, setStatus: () => {} } } };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withGlobalFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function quietStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function homeWithEnvFile(lines: string): string {
  const home = mkdtempSync(join(tmpdir(), "fm-jev-home-"));
  writeFileSync(join(home, ".env"), lines);
  return home;
}

// A region omp really hands the hook in a firstmate session: a `custom`
// nudge with bare-string content, a bare-string user prompt, `!cmd` bash and
// python executions with no content (one of each flagged excludeFromContext,
// the `!!cmd` form omp keeps out of the model), and a branch summary with
// only `summary`. An earlier compaction's summary is never in the region;
// omp passes it as preparation.previousSummary instead.
const realWorldRegion: OmpMessage[] = [
  { role: "custom", customType: "firstmate-sessionstart-nudge", content: "nudge text", display: false, timestamp: 1 },
  { role: "user", content: "plain string prompt", timestamp: 2 },
  { role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
  { role: "bashExecution", command: "cat ~/.aws/credentials", output: "aws_secret_access_key=EXCLUDED-BASH", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 4 },
  { role: "pythonExecution", code: "print(6 * 7)", output: "42", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
  { role: "pythonExecution", code: "open('/etc/shadow').read()", output: "EXCLUDED-PYTHON", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 6 },
  { role: "branchSummary", summary: "branch summary text", fromId: "b1", timestamp: 7 },
];
const excludedText = /EXCLUDED-BASH|credentials|EXCLUDED-PYTHON|shadow/;

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

test("toLibraryMessages flattens the non-block message kinds omp really injects and omits excluded executions exactly as omp's own LLM conversion does", () => {
  const lib = toLibraryMessages(realWorldRegion);
  assert.equal(lib.length, 5, "the two excludeFromContext executions must not become messages at all");
  assert.deepEqual(lib.map((m) => m.role), ["user", "user", "user", "user", "user"]);
  assert.equal(lib[0].text, "nudge text");
  assert.equal(lib[1].text, "plain string prompt");
  assert.match(lib[2].text, /git status/);
  assert.match(lib[2].text, /clean/);
  assert.match(lib[3].text, /print\(6 \* 7\)/);
  assert.match(lib[3].text, /42/);
  assert.equal(lib[4].text, "branch summary text");
  assert.doesNotMatch(lib.map((m) => m.text).join("\n"), excludedText);
  assert.deepEqual(lib.map((m) => m.toolUses), [[], [], [], [], []]);
});

test("mergePreviousSummary leaves a first compaction alone and prepends an earlier summary verbatim ahead of a later one", () => {
  assert.equal(mergePreviousSummary(undefined, "new"), "new");
  assert.equal(mergePreviousSummary("", "new"), "new");
  assert.equal(mergePreviousSummary("old", "new"), "old\n\n---\n\n**Later history:**\n\nnew");
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

test("mergeAudits sums counts, combines dropped ids, and measures the merged reduction in characters rather than per-call ratios", () => {
  // A 100k-character text-only history (nothing droppable) plus a 3k-character
  // turn prefix whose two results Jev dropped: the real reduction is ~2.4% of
  // 103k characters, however good the prefix's own ratio looks.
  const history = audit({ candidateCalls: 0, charsBefore: 100_000, charsAfter: 100_000, reductionRatio: 0 });
  const prefix = audit({ candidateCalls: 2, kept: 0, dropped: ["call-a", "call-b"], requestCount: 1, stateTokens: 200, charsBefore: 3_000, charsAfter: 500, reductionRatio: 1 - 500 / 3_000 });
  const merged = mergeAudits(history, prefix);
  assert.equal(merged.candidateCalls, 2);
  assert.deepEqual(merged.dropped, ["call-a", "call-b"]);
  assert.equal(merged.requestCount, 1);
  assert.equal(merged.stateTokens, 200);
  assert.equal(merged.charsBefore, 103_000);
  assert.equal(merged.charsAfter, 100_500);
  assert.ok(Math.abs(merged.reductionRatio - (1 - 100_500 / 103_000)) < 1e-9);
  assert.ok(merged.reductionRatio < 0.25, "a split turn that barely shrank must not pass the minimum-reduction gate");
});

test("buildFilesTag reads omp's Set<string> fileOps and renders the native <files> shape, marking write-after-read as Write", () => {
  const tag = buildFilesTag({ read: new Set(["b.ts", "a.ts"]), written: new Set(["b.ts"]), edited: new Set() });
  assert.equal(tag, "<files>\na.ts (Read)\nb.ts (Write)\n</files>");
});

test("buildFilesTag elides past twenty paths and returns an empty string when nothing was touched", () => {
  const many = new Set(Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(2, "0")}.ts`));
  const tag = buildFilesTag({ read: many, written: new Set(), edited: new Set() });
  assert.equal(tag.split("\n").filter((line) => line.endsWith("(Read)")).length, 20);
  assert.match(tag, /5 files elided/);
  assert.equal(buildFilesTag({ read: new Set(), written: new Set(), edited: new Set() }), "");
});

test("auditFromResult reads counts and character totals straight from the vendored library's own CompactResult.stats/decisions and records dropped calls by omp's tool-call id", () => {
  const result: CompactResult = {
    messages: [],
    decisions: [
      { id: "t1", tool: "read", keepCall: 0.9, keepResult: 0.9, action: "keep", reason: "kept" },
      { id: "t2", tool: "bash", keepCall: 0.9, keepResult: 0.1, action: "drop_result", reason: "result_dropped" },
      { id: "t3", tool: "bash", keepCall: 0.1, keepResult: 0.1, action: "drop_call", reason: "call_dropped" },
    ],
    stats: { messagesBefore: 5, messagesAfter: 3, charsBefore: 1000, charsAfter: 400, calls: 3, kept: 1, resultsDropped: 1, callsDropped: 1, pinned: 0, stateTokens: 200, stateStage: "full", requests: 1, ms: 5 },
  };
  const ids = new Map([["t1", "call-read-1"], ["t2", "call-bash-2"], ["t3", "call-bash-3"]]);
  const a = auditFromResult("jev-latest", 0.5, result, ids);
  assert.equal(a.candidateCalls, 3);
  assert.equal(a.kept, 1);
  assert.equal(a.truncated, 1);
  assert.deepEqual(a.dropped, ["call-bash-3"], "dropped ids are omp's own tool-call ids, not the library's per-run t-numbers");
  assert.equal(a.requestCount, 1);
  assert.equal(a.stateTokens, 200);
  assert.equal(a.charsBefore, 1000);
  assert.equal(a.charsAfter, 400);
  assert.ok(Math.abs(a.reductionRatio - 0.6) < 1e-9);
});

test("envFileValue follows fmx_env_get: last assignment wins, export and quotes are tolerated, absent file or key is empty", () => {
  const home = homeWithEnvFile(['OTHER=x', 'TYPESAFE_API_KEY=first', "  export TYPESAFE_API_KEY = 'second'  ", 'TYPESAFE_API_KEY="third"\r', ''].join("\n"));
  assert.equal(envFileValue(join(home, ".env"), "TYPESAFE_API_KEY"), "third");
  assert.equal(envFileValue(join(home, ".env"), "MISSING"), "");
  assert.equal(envFileValue(join(home, "no-such-file"), "TYPESAFE_API_KEY"), "");
  const single = homeWithEnvFile("export TYPESAFE_API_KEY='quoted value'\n");
  assert.equal(envFileValue(join(single, ".env"), "TYPESAFE_API_KEY"), "quoted value");
});

test("compactOmpRegion runs the real vendored compact() end to end against a fake fetch, never sending real network traffic", async () => {
  const messages: OmpMessage[] = [
    userText("investigate the failing test"),
    assistantToolCall("keep1", "read", { path: "important.ts" }),
    toolResult("keep1", "the important content Jev should keep"),
    assistantToolCall("drop1", "bash", { command: "ls -la" }),
    toolResult("drop1", "drwxr-xr-x  2 x  x  64 Jan 1 00:00 .\n".repeat(20)),
  ];
  const seen = { headers: [] as string[], bodies: [] as string[] };
  const result = await compactOmpRegion(messages, { apiKey: "test-key", fetchImpl: keepFirstDropRestFetch(seen), maxRequestTokens: 100000 });

  assert.equal(seen.headers.length, 1);
  assert.equal(result.audit.candidateCalls, 2);
  assert.equal(result.audit.kept, 1);
  assert.deepEqual(result.audit.dropped, ["drop1"], "the dropped id is omp's toolCall id, resolvable against the journal");
  assert.equal(result.audit.keepThreshold, 0.5, "the audit records the vendored library's own resolved default threshold");
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

test("the registered handler is a no-op unless FM_JEV_COMPACTION=1, even with a key present", async () => {
  const handler = loadHandler();
  const { notes, ctx } = uiCapture();
  const result = await withEnv({ FM_JEV_COMPACTION: undefined, TYPESAFE_API_KEY: "k" }, () => handler(compactEvent([userText("x")]), ctx));
  assert.equal(result, undefined);
  assert.deepEqual(notes, [], "the default-off path must not even announce a fallback");
});

test("the handler falls back to native compaction for a region with no tool calls instead of installing the region verbatim as its own summary", async () => {
  const handler = loadHandler();
  const { notes, ctx } = uiCapture();
  const region = [userText("explain X"), assistantText("y".repeat(4000)), userText("more"), assistantText("z".repeat(4000))];
  const result = await quietStderr(() => withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: "k" }, () => handler(compactEvent(region), ctx)));
  assert.equal(result, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /reduction 0% below minimum/);
});

test("the handler reads TYPESAFE_API_KEY from $FM_HOME/.env when the environment lacks it, and reports unset when neither has it", async () => {
  const handler = loadHandler();
  const region = [userText("explain X"), assistantText("y".repeat(4000))];

  const bare = homeWithEnvFile("OTHER=1\n");
  const unset = uiCapture();
  await quietStderr(() => withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: undefined, FM_HOME: bare }, () => handler(compactEvent(region), unset.ctx)));
  assert.match(unset.notes[0], /TYPESAFE_API_KEY unset/);

  const keyed = homeWithEnvFile('export TYPESAFE_API_KEY="from-dot-env"\n');
  const found = uiCapture();
  await quietStderr(() => withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: undefined, FM_HOME: keyed }, () => handler(compactEvent(region), found.ctx)));
  assert.doesNotMatch(found.notes[0], /unset/, "a key in .env must get past the key check");
  assert.match(found.notes[0], /below minimum/, "and then reach the ordinary reduction gate");
});

test("the handler returns omp's compaction result with the previous summary leading the Jev-pruned summary, the <files> block from Set fileOps, and the audit; the environment key wins over .env", async () => {
  const handler = loadHandler();
  const region: OmpMessage[] = [
    ...realWorldRegion,
    userText("investigate the failing test"),
    assistantToolCall("keep1", "read", { path: "important.ts" }),
    toolResult("keep1", "the important content Jev should keep"),
    assistantToolCall("drop1", "bash", { command: "ls -la" }),
    toolResult("drop1", "drwxr-xr-x  2 x  x  64 Jan 1 00:00 .\n".repeat(20)),
  ];
  const home = homeWithEnvFile('TYPESAFE_API_KEY="from-dot-env"\n');
  const seen = { headers: [] as string[], bodies: [] as string[] };
  const { notes, ctx } = uiCapture();
  const event = compactEvent(region, {
    previousSummary: "EARLIER SUMMARY kept verbatim by compaction #1\n\n<files>\nold.ts (Read)\n</files>",
    fileOps: { read: new Set(["important.ts", "notes.md"]), written: new Set(["notes.md"]), edited: new Set() },
  });

  const result = await quietStderr(() =>
    withGlobalFetch(keepFirstDropRestFetch(seen), () =>
      withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: "from-process-env", FM_HOME: home }, () => handler(event, ctx))));

  assert.deepEqual(notes, [], "a successful Jev run must not announce a fallback");
  assert.equal(seen.headers.length, 1);
  assert.match(seen.headers[0], /from-process-env/);
  assert.doesNotMatch(seen.headers[0], /from-dot-env/);
  assert.match(seen.bodies[0], /git status/, "included history reaches the Jev state");
  assert.doesNotMatch(seen.bodies[0], excludedText, "an excluded execution must never be POSTed to Jev");
  assert.ok(result, "the handler must return a compaction result");
  const compaction = result.compaction;
  assert.equal(compaction.fromExtension, true);
  assert.equal(compaction.firstKeptEntryId, "entry-9");
  assert.equal(compaction.tokensBefore, 1000);
  assert.ok(compaction.summary.startsWith("EARLIER SUMMARY kept verbatim by compaction #1"), "the previous compaction's summary must lead the new one, never be discarded");
  assert.match(compaction.summary, /old\.ts \(Read\)/, "the earlier summary's own <files> block survives, since omp does not carry extension file ops forward");
  assert.match(compaction.summary, /\*\*Later history:\*\*\n\nuser: nudge text/);
  assert.match(compaction.summary, /git status/);
  assert.match(compaction.summary, /print\(6 \* 7\)/);
  assert.doesNotMatch(compaction.summary, excludedText, "an excluded execution must never be installed as model context");
  assert.match(compaction.summary, /important content Jev should keep/);
  assert.doesNotMatch(compaction.summary, /drwxr-xr-x/);
  assert.match(compaction.summary, /<files>\nimportant\.ts \(Read\)\nnotes\.md \(Write\)\n<\/files>$/);
  assert.equal(compaction.preserveData.jevCompaction.candidateCalls, 2);
  assert.deepEqual(compaction.preserveData.jevCompaction.dropped, ["drop1"]);
  assert.ok(compaction.preserveData.jevCompaction.reductionRatio >= 0.25);
});

test("the handler gives a split turn two separate Jev passes and gates on their combined character reduction", async () => {
  const handler = loadHandler();
  const history = [userText("explain X"), assistantText("y".repeat(20000))];
  const turnPrefix: OmpMessage[] = [
    userText("now check"),
    assistantToolCall("k", "read", { path: "a.ts" }),
    toolResult("k", "keep this"),
    assistantToolCall("d", "bash", { command: "ls" }),
    toolResult("d", "x".repeat(2500)),
  ];
  const seen = { headers: [] as string[], bodies: [] as string[] };
  const { notes, ctx } = uiCapture();
  const event = compactEvent(history, { isSplitTurn: true, turnPrefixMessages: turnPrefix });
  const result = await quietStderr(() =>
    withGlobalFetch(keepFirstDropRestFetch(seen), () =>
      withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: "k" }, () => handler(event, ctx))));
  assert.equal(seen.headers.length, 1, "the text-only history needs no Jev request; the prefix needs one");
  assert.equal(result, undefined, "dropping 2.5k of ~22.5k characters is below the 25% minimum for the whole region");
  assert.match(notes[0], /below minimum/);
});

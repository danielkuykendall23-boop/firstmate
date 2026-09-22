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
// The handler's `omp config get` call runs against a stand-in omp binary
// installed as process.execPath for the duration of each run, exactly where
// the real omp binary sits inside a real session; the live counterpart is
// tests/fm-jev-compaction-live-e2e.test.sh.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import registerJevCompaction, {
  auditFromResult,
  buildFilesTag,
  compactOmpRegion,
  envFileValue,
  hideSecretsState,
  mergeAudits,
  mergePreviousSummary,
  mergeSplitTurnSummary,
  ompConfiguredSecretsEnabled,
  overlayFilesFromArgv,
  overlaySecretsStatement,
  renderLibraryMessages,
  retainedBudget,
  systemPromptText,
  toLibraryMessages,
  triggerTokens,
  unretainableNativeHistory,
  type JevCompactionAudit,
  type OmpCompactionPreparation,
  type OmpCompactionResult,
  type OmpMessage,
  type SessionBeforeCompactEvent,
} from "../.omp/extensions/fm-jev-compaction.ts";
import { compact, SYSTEM_ONE_URL, type CompactResult, type Message as LibMessage } from "../.omp/extensions/vendor/fast-jev-compaction/src/index.ts";

const repoRoot = join(import.meta.dirname, "..");

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

type Seen = { urls: string[]; headers: string[]; bodies: string[] };
function seenRequests(): Seen {
  return { urls: [], headers: [], bodies: [] };
}

// Jev answers keep for the first collected call (t1) and drop for every other.
function keepFirstDropRestFetch(seen: Seen): typeof fetch {
  return async (url, init) => {
    seen.urls.push(String(url));
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
type HookCtx = { ui?: HookUi; cwd?: string; model?: { id?: string; contextWindow?: number }; getSystemPrompt?: () => unknown };
type Handler = (event: unknown, ctx: HookCtx) => Promise<{ compaction: OmpCompactionResult } | undefined>;

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "fm-jev-agent-"));
const isolatedProject = mkdtempSync(join(tmpdir(), "fm-jev-project-"));

// The omp binary the handler runs `config get` through is process.execPath
// (inside a real session that is omp itself). This stand-in answers from
// FAKE_OMP_MODE and records its arguments and physical cwd in FAKE_OMP_LOG.
const fakeOmp = join(mkdtempSync(join(tmpdir(), "fm-jev-fake-omp-")), "omp");
writeFileSync(fakeOmp, `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_OMP_LOG"
pwd -P >> "$FAKE_OMP_LOG"
case "$FAKE_OMP_MODE" in
  on) printf '{"key":"secrets.enabled","value":true,"type":"boolean"}\\n' ;;
  off) printf '{"key":"secrets.enabled","value":false,"type":"boolean"}\\n' ;;
  fail) echo "Unknown setting: secrets.enabled" >&2; exit 1 ;;
  garbage) echo "not json at all" ;;
  string) printf '{"key":"secrets.enabled","value":"true","type":"boolean"}\\n' ;;
esac
`);
chmodSync(fakeOmp, 0o755);

type OmpMode = "on" | "off" | "fail" | "garbage" | "string" | "missing";
type OmpRuntime = { mode?: OmpMode; argv?: string[] };
type OmpCall = { args: string; cwd: string };

function readOmpCall(log: string): OmpCall | undefined {
  if (!existsSync(log)) return undefined;
  const [args, cwd] = readFileSync(log, "utf8").split("\n");
  return { args, cwd };
}

// Installs the stand-in as process.execPath and the given launch flags as
// process.argv (omp's own argv shape: `bun`, the bundled entry, then flags)
// for the duration of fn, exactly the two process facts the gate reads.
async function withOmpRuntime<T>(runtime: OmpRuntime, fn: (log: string) => Promise<T>): Promise<T> {
  const saved = { execPath: process.execPath, argv: process.argv, mode: process.env.FAKE_OMP_MODE, log: process.env.FAKE_OMP_LOG };
  const log = join(mkdtempSync(join(tmpdir(), "fm-jev-omp-log-")), "call.log");
  process.execPath = runtime.mode === "missing" ? join(tmpdir(), "fm-jev-no-such-omp-binary") : fakeOmp;
  process.argv = ["bun", "/$bunfs/root/omp-darwin-arm64", "--mode", "rpc", ...(runtime.argv ?? [])];
  process.env.FAKE_OMP_MODE = runtime.mode ?? "off";
  process.env.FAKE_OMP_LOG = log;
  try {
    return await fn(log);
  } finally {
    process.execPath = saved.execPath;
    process.argv = saved.argv;
    if (saved.mode === undefined) delete process.env.FAKE_OMP_MODE;
    else process.env.FAKE_OMP_MODE = saved.mode;
    if (saved.log === undefined) delete process.env.FAKE_OMP_LOG;
    else process.env.FAKE_OMP_LOG = saved.log;
  }
}

// Loads the extension exactly as omp does at session start, with
// FM_JEV_COMPACTION set as given for the duration of the load only.
function registerWith(flag: string | undefined): { handler: Handler | undefined; registrations: number } {
  const saved = process.env.FM_JEV_COMPACTION;
  if (flag === undefined) delete process.env.FM_JEV_COMPACTION;
  else process.env.FM_JEV_COMPACTION = flag;
  let handler: Handler | undefined;
  let registrations = 0;
  try {
    registerJevCompaction({
      on: (event, h) => {
        registrations += 1;
        if (event === "session_before_compact") handler = h as Handler;
      },
    });
  } finally {
    if (saved === undefined) delete process.env.FM_JEV_COMPACTION;
    else process.env.FM_JEV_COMPACTION = saved;
  }
  return { handler, registrations };
}

function loadHandler(): Handler {
  const { handler } = registerWith("1");
  assert.ok(handler, "with FM_JEV_COMPACTION=1 the extension must register a session_before_compact handler");
  return handler;
}

// The region every repeated-compaction case hands to Jev: one call to keep
// and one listing Jev drops (1.5k characters unless asked for more), so the
// new region itself always shrinks by well over 25% on its own.
function droppableRegion(listingLines = 40): OmpMessage[] {
  return [
    userText("investigate the failing test"),
    assistantToolCall("keep1", "read", { path: "important.ts" }),
    toolResult("keep1", "the important content Jev should keep"),
    assistantToolCall("drop1", "bash", { command: "ls -la" }),
    toolResult("drop1", "drwxr-xr-x  2 x  x  64 Jan 1 00:00 .\n".repeat(listingLines)),
  ];
}

// A region carrying a credential-shaped value omp's Hide Secrets would redact
// before any provider request; the hook receives it un-redacted.
function regionWithSecret(): OmpMessage[] {
  return [
    ...droppableRegion(),
    { role: "bashExecution", command: "cat .env", output: "AWS_SECRET_ACCESS_KEY=REDACTED-BY-OMP-NATIVELY", exitCode: 0, cancelled: false, truncated: false, timestamp: 9 },
  ];
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
      settings: { thresholdTokens: 550000 },
      ...overrides,
    },
  };
}

// The hook context omp 18.2.8 hands a handler, as far as this extension
// reads it: ui, the session cwd, the active model with its context window
// (Codex Max, the captain's required model), and the system prompt.
const CODEX_MAX_CONTEXT = 272000;
function uiCapture(overrides: Partial<HookCtx> = {}): { notes: string[]; ctx: HookCtx } {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      ui: { notify: (message) => { notes.push(message); }, setStatus: () => {} },
      cwd: isolatedProject,
      model: { id: "gpt-5.1-codex-max", contextWindow: CODEX_MAX_CONTEXT },
      getSystemPrompt: () => ["You are omp.", { text: "Work in the harness." }],
      ...overrides,
    },
  };
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const vars: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: isolatedAgentDir, FM_JEV_ENDPOINT: undefined, ...overrides };
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

type RunOptions = { ctx?: Partial<HookCtx>; env?: Record<string, string | undefined>; runtime?: OmpRuntime; fetch?: typeof fetch };
type Run = { result: { compaction: OmpCompactionResult } | undefined; seen: Seen; notes: string[]; ompCall?: OmpCall };

// One handler run exactly as omp performs it: the registered handler, the
// hook context, the stand-in omp binary, the launch argv, the environment,
// and a fake fetch standing in for the network.
async function runHandler(event: SessionBeforeCompactEvent, options: RunOptions = {}): Promise<Run> {
  const handler = loadHandler();
  const seen = seenRequests();
  const { notes, ctx } = uiCapture(options.ctx);
  let ompCall: OmpCall | undefined;
  const result = await quietStderr(() =>
    withOmpRuntime(options.runtime ?? {}, (log) =>
      withGlobalFetch(options.fetch ?? keepFirstDropRestFetch(seen), () =>
        withEnv({ FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: "k", ...options.env }, async () => {
          const outcome = await handler(event, ctx);
          ompCall = readOmpCall(log);
          return outcome;
        }))));
  return { result, seen, notes, ompCall };
}

function homeWithEnvFile(lines: string): string {
  const home = mkdtempSync(join(tmpdir(), "fm-jev-home-"));
  writeFileSync(join(home, ".env"), lines);
  return home;
}

function overlayFile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "fm-jev-overlay-")), "overlay.yml");
  writeFileSync(file, text);
  return file;
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

// ---- Translation and rendering ----

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
  assert.equal(mergeSplitTurnSummary("older history text", "recent turn text"), "older history text\n\n---\n\n**Turn Context (split turn):**\n\nrecent turn text");
});

test("mergeSplitTurnSummary returns the non-empty side alone when the other is empty", () => {
  assert.equal(mergeSplitTurnSummary("history only", ""), "history only");
  assert.equal(mergeSplitTurnSummary("", "prefix only"), "prefix only");
});

test("mergeAudits sums counts, combines dropped ids, and measures the merged reduction in characters rather than per-call ratios", () => {
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
  assert.equal(buildFilesTag({ read: new Set(["b.ts", "a.ts"]), written: new Set(["b.ts"]), edited: new Set() }), "<files>\na.ts (Read)\nb.ts (Write)\n</files>");
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
  const home = homeWithEnvFile(["OTHER=x", "TYPESAFE_API_KEY=first", "  export TYPESAFE_API_KEY = 'second'  ", 'TYPESAFE_API_KEY="third"\r', ""].join("\n"));
  assert.equal(envFileValue(join(home, ".env"), "TYPESAFE_API_KEY"), "third");
  assert.equal(envFileValue(join(home, ".env"), "MISSING"), "");
  assert.equal(envFileValue(join(home, "no-such-file"), "TYPESAFE_API_KEY"), "");
  const single = homeWithEnvFile("export TYPESAFE_API_KEY='quoted value'\n");
  assert.equal(envFileValue(join(single, ".env"), "TYPESAFE_API_KEY"), "quoted value");
});

// ---- The real vendored compact() through the adapter ----

test("compactOmpRegion runs the real vendored compact() end to end against a fake fetch at upstream's own endpoint, never sending real network traffic", async () => {
  const seen = seenRequests();
  const result = await compactOmpRegion(droppableRegion(20), { apiKey: "test-key", fetchImpl: keepFirstDropRestFetch(seen), maxRequestTokens: 100000 });
  assert.equal(seen.urls.length, 1);
  assert.equal(seen.urls[0], SYSTEM_ONE_URL, "without an override the vendored client targets upstream's System One URL");
  assert.equal(result.audit.candidateCalls, 2);
  assert.equal(result.audit.kept, 1);
  assert.deepEqual(result.audit.dropped, ["drop1"], "the dropped id is omp's toolCall id, resolvable against the journal");
  assert.equal(result.audit.keepThreshold, 0.5, "the audit records the vendored library's own resolved default threshold");
  assert.match(result.text, /important content Jev should keep/);
  assert.doesNotMatch(result.text, /drwxr-xr-x/, "dropped tool output must not appear in the rendered summary");
});

test("compactOmpRegion sends to the given endpoint when one is supplied, the hook the live omp test uses to aim a real session at a local fake", async () => {
  const seen = seenRequests();
  await compactOmpRegion(droppableRegion(20), { apiKey: "test-key", fetchImpl: keepFirstDropRestFetch(seen), baseUrl: "http://127.0.0.1:1/systemone" });
  assert.deepEqual(seen.urls, ["http://127.0.0.1:1/systemone"]);
});

test("compactOmpRegion never orphans a tool call without its result or vice versa (the vendored library's own pairing guarantee)", async () => {
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

// ---- Registration ----

test("with FM_JEV_COMPACTION unset or not exactly 1 the extension registers no hook at all, the condition omp checks before it arms speculative background compaction", () => {
  const disabled = registerWith(undefined);
  assert.equal(disabled.registrations, 0, "omp disables speculative compaction whenever any session_before_compact handler exists, so a disabled launch must register none");
  assert.equal(disabled.handler, undefined);
  assert.equal(registerWith("0").registrations, 0);
  assert.equal(registerWith("true").registrations, 0);
  assert.equal(registerWith("1").registrations, 1, "enabled, exactly one hook is registered");
});

// ---- Hide Secrets: omp's own reader plus launch overlays ----

test("ompConfiguredSecretsEnabled asks the running omp binary itself, in the session's cwd, and refuses to guess when the answer is not a plain boolean", async () => {
  const project = mkdtempSync(join(tmpdir(), "fm-jev-project-"));
  const ask = (mode: OmpMode) => withOmpRuntime({ mode }, async (log) => ({ answer: ompConfiguredSecretsEnabled(project), call: readOmpCall(log) }));
  const off = await ask("off");
  assert.deepEqual(off.answer, { value: false });
  assert.equal(off.call?.args, "config get secrets.enabled --json", "the exact supported omp CLI reader, no hand-parsed config files");
  assert.equal(off.call?.cwd, realpathSync(project), "asked from the session's own working directory so project precedence is omp's");
  assert.deepEqual((await ask("on")).answer, { value: true });
  for (const mode of ["fail", "garbage", "string", "missing"] as const) {
    const { answer } = await ask(mode);
    assert.ok("error" in answer, `${mode}: an answer that cannot be established must be an error, never a default`);
  }
});

test("overlayFilesFromArgv collects every --config overlay on omp's own argv, in order, resolving relative paths against the session cwd", () => {
  const argv = ["bun", "/$bunfs/root/omp", "--mode", "rpc", "--config", "/abs/a.yml", "--cwd", "/somewhere", "--config=rel/b.yml", "--model", "x"];
  assert.deepEqual(overlayFilesFromArgv(argv, "/proj"), ["/abs/a.yml", "/proj/rel/b.yml"]);
  assert.deepEqual(overlayFilesFromArgv(["bun", "omp", "--mode", "rpc"], "/proj"), []);
});

test("overlaySecretsStatement follows only a nested boolean secrets.enabled statement and refuses every other way an overlay could touch secrets", () => {
  assert.equal(overlaySecretsStatement(""), "unstated");
  assert.equal(overlaySecretsStatement("composer:\n  shape: line\nplan:\n  defaultOnStartup: false\n"), "unstated");
  assert.equal(overlaySecretsStatement("secrets:\n  enabled: true\n"), true);
  assert.equal(overlaySecretsStatement("theme:\n  dark: x\nsecrets:\n  enabled: false # off\ncompaction:\n  thresholdTokens: 1\n"), false);
  assert.equal(overlaySecretsStatement("secrets:\n  patterns:\n    - AKIA\n  enabled: true\n"), true, "a sibling list inside the block must not hide the switch");
  assert.equal(overlaySecretsStatement("secrets:\n  # enabled: false\n"), undefined, "a bare group omp may shadow or ignore is not followed");
  assert.equal(overlaySecretsStatement("secrets.enabled: true\n"), undefined, "a dotted key omp's loader does not expand is not followed");
  assert.equal(overlaySecretsStatement("secrets.enabled: false\n"), undefined);
  assert.equal(overlaySecretsStatement("secrets: { enabled: true }\n"), undefined);
  assert.equal(overlaySecretsStatement("secrets:\n  enabled: 'true'\n"), undefined);
  assert.equal(overlaySecretsStatement("secrets:\n  enabled: yes\n"), undefined);
  assert.equal(overlaySecretsStatement("secrets: &s\n  enabled: true\n"), undefined);
});

test("hideSecretsState layers omp's own answer with the launch overlays in order and is unprovable whenever any input cannot be established", async () => {
  const project = mkdtempSync(join(tmpdir(), "fm-jev-project-"));
  const state = (mode: OmpMode, argv: string[]) => withOmpRuntime({ mode, argv }, async () => hideSecretsState(project, process.argv));
  assert.deepEqual(await state("off", []), { state: "off", source: "omp config get secrets.enabled" });
  assert.deepEqual(await state("on", []), { state: "on", source: "omp config get secrets.enabled" });
  const on = overlayFile("secrets:\n  enabled: true\n");
  const off = overlayFile("secrets:\n  enabled: false\n");
  const silent = overlayFile("composer:\n  shape: line\n");
  assert.deepEqual(await state("off", ["--config", on]), { state: "on", source: `--config overlay ${on}` });
  assert.deepEqual(await state("on", [`--config=${off}`]), { state: "off", source: `--config overlay ${off}` }, "a later overlay statement overrides omp's file-layer answer, as omp layers overlays last");
  assert.deepEqual(await state("on", ["--config", silent]), { state: "on", source: "omp config get secrets.enabled" }, "an overlay that never mentions secrets changes nothing");
  assert.deepEqual(await state("off", ["--config", off, "--config", on]), { state: "on", source: `--config overlay ${on}` }, "repeated overlays apply in launch order");
  assert.equal((await state("off", ["--config", overlayFile("secrets:\n")])).state, "unprovable");
  assert.equal((await state("off", ["--config", overlayFile("secrets.enabled: false\n")])).state, "unprovable");
  assert.equal((await state("off", ["--config", join(project, "missing.yml")])).state, "unprovable");
  assert.equal((await state("fail", [])).state, "unprovable");
  assert.equal((await state("garbage", [])).state, "unprovable");
});

// ---- The retained-context budget ----

test("triggerTokens and retainedBudget mirror omp's own arithmetic for the active model: a 550000 trigger is clamped to the model, the reserve is 15% or reserveTokens, and the budget sits under the 80% progress ceiling", () => {
  assert.equal(triggerTokens(CODEX_MAX_CONTEXT, { thresholdTokens: 550000 }), 271999, "the captain's 550000 trigger clamps to contextWindow - 1 for Codex Max");
  assert.equal(triggerTokens(1_000_000, { thresholdTokens: 550000 }), 550000);
  assert.equal(triggerTokens(CODEX_MAX_CONTEXT, {}), 231200, "no fixed threshold: contextWindow minus the 15% reserve");
  assert.equal(triggerTokens(CODEX_MAX_CONTEXT, { thresholdPercent: 50 }), 136000);
  const budget = retainedBudget(CODEX_MAX_CONTEXT, { thresholdTokens: 550000 }, 20000, 5000);
  assert.equal(budget.trigger, 271999);
  assert.equal(budget.progressCeiling, 217599);
  assert.equal(budget.reserve, 40800);
  assert.equal(budget.budgetTokens, 217599 - 40800 - 20000 - 5000);
  assert.equal(retainedBudget(CODEX_MAX_CONTEXT, { thresholdTokens: 550000, reserveTokens: 100000 }, 0, 0).reserve, 100000, "an explicit larger reserveTokens wins over the 15% floor");
  assert.ok(retainedBudget(3000, { thresholdTokens: 550000 }, 0, 0).budgetTokens < 0, "a tiny model has no budget at all once omp's 16384-token default reserve is counted");
});

test("systemPromptText reads the system prompt in every shape omp hands the hook: a string, an array of strings, or text parts, and nothing else", () => {
  assert.equal(systemPromptText("plain"), "plain");
  assert.equal(systemPromptText(["RFC 2119: MUST", "§ Role"]), "RFC 2119: MUST\n§ Role", "omp 18.2.8 hands an array of strings");
  assert.equal(systemPromptText(["a", { text: "b" }, { type: "image" }]), "a\nb\n");
  assert.equal(systemPromptText(undefined), "");
  assert.equal(systemPromptText({ text: "not counted as a bare object" }), "");
});

// ---- The registered handler, driven as omp drives it ----

test("the handler falls back to native compaction for a region with no tool calls instead of installing the region verbatim as its own summary", async () => {
  const region = [userText("explain X"), assistantText("y".repeat(4000)), userText("more"), assistantText("z".repeat(4000))];
  const { result, seen, notes } = await runHandler(compactEvent(region));
  assert.equal(result, undefined);
  assert.equal(seen.urls.length, 0, "a text-only region needs no Jev request");
  assert.match(notes[0], /reduction 0% of the whole context below minimum/);
});

test("the handler reads TYPESAFE_API_KEY from $FM_HOME/.env when the environment lacks it, and reports unset when neither has it", async () => {
  const region = [userText("explain X"), assistantText("y".repeat(4000))];
  const unset = await runHandler(compactEvent(region), { env: { TYPESAFE_API_KEY: undefined, FM_HOME: homeWithEnvFile("OTHER=1\n") } });
  assert.match(unset.notes[0], /TYPESAFE_API_KEY unset/);
  const found = await runHandler(compactEvent(region), { env: { TYPESAFE_API_KEY: undefined, FM_HOME: homeWithEnvFile('export TYPESAFE_API_KEY="from-dot-env"\n') } });
  assert.doesNotMatch(found.notes[0], /unset/, "a key in .env must get past the key check");
  assert.match(found.notes[0], /below minimum/, "and then reach the ordinary reduction gate");
});

test("the handler returns omp's compaction result with the previous summary leading the Jev-pruned summary, the <files> block from Set fileOps, and the audit with its budget; the environment key wins over .env", async () => {
  const region: OmpMessage[] = [...realWorldRegion, ...droppableRegion(20)];
  const previousSummary = "EARLIER SUMMARY kept verbatim by compaction #1\n\n<files>\nold.ts (Read)\n</files>";
  const event = compactEvent(region, {
    previousSummary,
    recentMessages: [userText("recent question"), assistantText("recent answer")],
    fileOps: { read: new Set(["important.ts", "notes.md"]), written: new Set(["notes.md"]), edited: new Set() },
  });
  const { result, seen, notes } = await runHandler(event, { env: { TYPESAFE_API_KEY: "from-process-env", FM_HOME: homeWithEnvFile('TYPESAFE_API_KEY="from-dot-env"\n') } });
  assert.deepEqual(notes, [], "a successful Jev run must not announce a fallback");
  assert.equal(seen.urls.length, 1);
  assert.equal(seen.urls[0], SYSTEM_ONE_URL);
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
  const record = compaction.preserveData.jevCompaction;
  assert.equal(record.candidateCalls, 2);
  assert.deepEqual(record.dropped, ["drop1"]);
  assert.equal(record.previousSummaryChars, previousSummary.length);
  const wholeContext = 1 - (previousSummary.length + record.charsAfter) / (previousSummary.length + record.charsBefore);
  assert.ok(Math.abs(record.reductionRatio - wholeContext) < 1e-9, "the recorded reduction is measured over the whole context, carried summary included");
  assert.ok(record.reductionRatio >= 0.25);
  assert.equal(record.budget.contextWindow, CODEX_MAX_CONTEXT);
  assert.equal(record.budget.trigger, 271999);
  assert.equal(record.budget.progressCeiling, 217599);
  assert.equal(record.budget.reserve, 40800);
  assert.ok(record.budget.recentTokens > 0, "the recent messages omp keeps are counted against the budget");
  assert.ok(record.budget.systemPromptTokens > 0, "the system prompt is counted against the budget");
  assert.equal(record.budget.budgetTokens, 217599 - 40800 - record.budget.recentTokens - record.budget.systemPromptTokens);
  assert.ok(record.summaryTokens > 0 && record.summaryTokens <= record.budget.budgetTokens);
});

test("the handler gives a split turn two separate Jev passes and gates on their combined character reduction", async () => {
  const history = [userText("explain X"), assistantText("y".repeat(20000))];
  const turnPrefix: OmpMessage[] = [userText("now check"), assistantToolCall("k", "read", { path: "a.ts" }), toolResult("k", "keep this"), assistantToolCall("d", "bash", { command: "ls" }), toolResult("d", "x".repeat(2500))];
  const { result, seen, notes } = await runHandler(compactEvent(history, { isSplitTurn: true, turnPrefixMessages: turnPrefix }));
  assert.equal(seen.urls.length, 1, "the text-only history needs no Jev request; the prefix needs one");
  assert.equal(result, undefined, "dropping 2.5k of ~22.5k characters is below the 25% minimum for the whole region");
  assert.match(notes[0], /below minimum/);
});

test("repeated compaction: once the carried previous summary dominates, the handler falls back to native compaction even though the new region itself shrank by over 90%", async () => {
  const { result, seen, notes } = await runHandler(compactEvent(droppableRegion(), { previousSummary: "carried verbatim summary ".repeat(2000) }));
  assert.equal(seen.urls.length, 1, "Jev was asked about the new region");
  assert.equal(result, undefined, "a ~3% whole-context reduction hands the whole thing to native compaction, which rewrites and bounds it");
  assert.match(notes[0], /reduction \d% of the whole context below minimum/);
});

test("budget: a model whose context cannot hold any retained history under omp's reserve declines before contacting Jev, and an unknown context window declines too", async () => {
  const tiny = await runHandler(compactEvent(droppableRegion()), { ctx: { model: { id: "small", contextWindow: 3000 } } });
  assert.equal(tiny.result, undefined);
  assert.equal(tiny.seen.urls.length, 0, "no transcript is sent for a result that could never be installed");
  assert.match(tiny.notes[0], /no retained-context budget/);
  const unknown = await runHandler(compactEvent(droppableRegion()), { ctx: { model: undefined } });
  assert.equal(unknown.result, undefined);
  assert.equal(unknown.seen.urls.length, 0);
  assert.match(unknown.notes[0], /context window is unknown/);
});

test("budget: the same well-reduced replacement is refused when it exceeds a smaller model's retained-context budget and installed under Codex Max's, with the previous summary leading", async () => {
  const previousSummary = "carried verbatim summary ".repeat(7200);
  const event = () => compactEvent(droppableRegion(16000), { previousSummary });
  const small = await runHandler(event(), { ctx: { model: { id: "gpt-small", contextWindow: 60000 } } });
  assert.equal(small.seen.urls.length, 1, "Jev ran and the region shrank; only the installed size failed");
  assert.equal(small.result, undefined);
  assert.match(small.notes[0], /exceeds the \d+-token retained-context budget for a 60000-token model/);

  const codexMax = await runHandler(event());
  assert.deepEqual(codexMax.notes, [], "under Codex Max the same replacement fits");
  assert.ok(codexMax.result);
  const record = codexMax.result.compaction.preserveData.jevCompaction;
  assert.ok(record.reductionRatio >= 0.25);
  assert.ok(record.summaryTokens > 40000 && record.summaryTokens <= record.budget.budgetTokens, `~${record.summaryTokens} retained tokens is far past the 13107-token native summary cap this budget replaces`);
  assert.ok(codexMax.result.compaction.summary.startsWith(previousSummary), "the carried summary still leads the installed replacement");
});

// ---- Native history that a text-only summary cannot carry ----

test("unretainableNativeHistory names the method-native history a text-only summary would drop, and nothing else", () => {
  assert.equal(unretainableNativeHistory(undefined), undefined);
  assert.equal(unretainableNativeHistory({}), undefined);
  assert.equal(unretainableNativeHistory({ jevCompaction: { kept: 1 } }), undefined, "the extension's own earlier record is fully represented by the carried summary text");
  assert.equal(unretainableNativeHistory({ openaiRemoteCompaction: { provider: "openai", replacementHistory: [] } }), "openaiRemoteCompaction");
  assert.equal(unretainableNativeHistory({ snapcompact: { frames: [], text: "archived history" } }), "snapcompact");
  assert.equal(unretainableNativeHistory({ openaiRemoteCompaction: "not an object" }), undefined, "omp's own readers ignore a non-object value, so there is nothing to lose");
});

const openaiRemotePlaceholder = "Remote compaction preserved provider-native history for this session. Compaction processed 12345 input tokens.";
const openaiRemotePreserveData = {
  openaiRemoteCompaction: {
    provider: "openai",
    replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text", text: "history only the provider replay still holds" }] }],
    compactionItem: { type: "compaction_summary" },
  },
};

test("after a native OpenAI remote compaction the handler declines before contacting Jev, so native compaction keeps the replayed history the placeholder summary does not contain", async () => {
  const { result, seen, notes } = await runHandler(compactEvent(droppableRegion(), { previousSummary: openaiRemotePlaceholder, previousPreserveData: openaiRemotePreserveData }));
  assert.equal(result, undefined, "a text-only summary would install the placeholder sentence and lose everything compaction #1 preserved");
  assert.equal(seen.urls.length, 0, "no transcript is sent to Jev for a result that could not be installed anyway");
  assert.match(notes[0], /previous compaction's openaiRemoteCompaction history cannot be carried/);
});

test("after a native snapcompact compaction the handler declines the same way, since its archive frames live beside the summary text", async () => {
  const { result, seen, notes } = await runHandler(compactEvent(droppableRegion(), {
    previousSummary: "Archived 40,000 chars of history onto 3 snapcompact frames",
    previousPreserveData: { snapcompact: { frames: [{ data: "...", mimeType: "image/png", cols: 80, rows: 40, chars: 3200 }], text: "" } },
  }));
  assert.equal(result, undefined);
  assert.equal(seen.urls.length, 0);
  assert.match(notes[0], /snapcompact history cannot be carried/);
});

test("the same later compaction proceeds and installs when the previous compaction was this extension's own, whose substance is the carried summary text", async () => {
  const previousSummary = "user: earlier Jev-kept history\n\n<files>\nold.ts (Read)\n</files>";
  const { result, seen, notes } = await runHandler(compactEvent(droppableRegion(), {
    previousSummary,
    previousPreserveData: { jevCompaction: { model: "jev-latest", kept: 1, dropped: ["old-call"], charsBefore: 900, charsAfter: 90 } },
  }));
  assert.deepEqual(notes, []);
  assert.equal(seen.urls.length, 1, "Jev is asked about the new region");
  assert.ok(result);
  assert.ok(result.compaction.summary.startsWith(previousSummary), "the earlier Jev summary leads the installed replacement");
  assert.match(result.compaction.summary, /important content Jev should keep/);
});

// ---- Privacy: the same event omp emits from a manual /compact and from
// automatic threshold compaction, so one handler run stands for both. ----

test("privacy: with omp itself reporting Hide Secrets on, the handler declines before anything is sent, having asked this very omp binary from the session cwd", async () => {
  const { result, seen, notes, ompCall } = await runHandler(compactEvent(regionWithSecret()), { runtime: { mode: "on" } });
  assert.equal(result, undefined, "native compaction, which omp redacts, must run instead");
  assert.equal(seen.urls.length, 0, "no request may leave the machine");
  assert.match(notes[0], /Hide Secrets is on \(omp config get secrets\.enabled\)/);
  assert.equal(ompCall?.args, "config get secrets.enabled --json");
  assert.equal(ompCall?.cwd, realpathSync(isolatedProject));
});

test("privacy: a --config overlay on omp's own argv that turns Hide Secrets on declines the same way, even though omp's file-layer reader still says off", async () => {
  const on = overlayFile("secrets:\n  enabled: true\n");
  const { result, seen, notes } = await runHandler(compactEvent(regionWithSecret()), { runtime: { mode: "off", argv: ["--config", on, "--cwd", isolatedProject] } });
  assert.equal(result, undefined);
  assert.equal(seen.urls.length, 0);
  assert.match(notes[0], /Hide Secrets is on \(--config overlay .*overlay\.yml\)/);
});

test("privacy: whenever the effective switch cannot be established - omp's reader failing, answering garbage, missing, or an overlay touching secrets in an unfollowed form - the handler declines before contacting Jev", async () => {
  for (const mode of ["fail", "garbage", "string", "missing"] as const) {
    const { result, seen, notes } = await runHandler(compactEvent(regionWithSecret()), { runtime: { mode } });
    assert.equal(result, undefined, mode);
    assert.equal(seen.urls.length, 0, `${mode}: nothing may leave the machine on an unprovable state`);
    assert.match(notes[0], /Hide Secrets could not be established/);
  }
  const bare = await runHandler(compactEvent(regionWithSecret()), { runtime: { mode: "off", argv: ["--config", overlayFile("secrets:\n  # enabled: false\n")] } });
  assert.equal(bare.result, undefined);
  assert.equal(bare.seen.urls.length, 0);
  assert.match(bare.notes[0], /touches secrets in a form this gate does not follow/);
  const missingOverlay = await runHandler(compactEvent(regionWithSecret()), { runtime: { mode: "off", argv: ["--config", join(isolatedProject, "no-such-overlay.yml")] } });
  assert.equal(missingOverlay.result, undefined);
  assert.equal(missingOverlay.seen.urls.length, 0);
  assert.match(missingOverlay.notes[0], /could not be read/);
});

test("privacy: the actual Firstmate worker launch - omp's reader off and the tracked worker overlay on argv - proceeds, as does an overlay that turns an inherited on back off; the un-redacted disclosure is then the captain's documented opt-in", async () => {
  const workerOverlay = join(repoRoot, ".omp", "fm-worker-overlay.yml");
  assert.ok(existsSync(workerOverlay), "the overlay bin/fm-spawn.sh passes on every Firstmate-launched omp session");
  for (const runtime of [
    { mode: "off" as const, argv: ["--config", workerOverlay, "--auto-approve", "--cwd", isolatedProject] },
    { mode: "off" as const, argv: [] },
    { mode: "on" as const, argv: ["--config", overlayFile("secrets:\n  enabled: false\n")] },
  ]) {
    const { result, seen, notes } = await runHandler(compactEvent(regionWithSecret()), { runtime });
    assert.deepEqual(notes, []);
    assert.equal(seen.urls.length, 1, "Jev is asked exactly once");
    assert.match(seen.bodies[0], /cat \.env/, "the raw region reaches Jev when omp itself would not redact it either");
    assert.ok(result);
    assert.match(result.compaction.summary, /REDACTED-BY-OMP-NATIVELY/);
  }
});

test("FM_JEV_ENDPOINT aims the handler's Jev requests at the given URL and is otherwise absent, so a real launch targets upstream", async () => {
  const redirected = await runHandler(compactEvent(droppableRegion()), { env: { FM_JEV_ENDPOINT: "http://127.0.0.1:1/systemone" } });
  assert.deepEqual(redirected.seen.urls, ["http://127.0.0.1:1/systemone"]);
  const upstream = await runHandler(compactEvent(droppableRegion()));
  assert.deepEqual(upstream.seen.urls, [SYSTEM_ONE_URL]);
});

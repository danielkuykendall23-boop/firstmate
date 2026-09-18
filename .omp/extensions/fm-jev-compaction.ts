// Optional Jev-guided compaction for omp (Oh My Pi).
//
// Off by default. Set FM_JEV_COMPACTION=1 to activate this extension's
// session_before_compact handler; otherwise it registers and immediately
// no-ops, so omp's own compaction.methodOrder and compaction.thresholdTokens
// (verified live in this environment as ["remote","handoff","snapcompact",
// "shake","soft"] and 550000 respectively - see the captured-event evidence
// referenced in docs/jev-compaction.md) are never touched by a default
// launch. This never writes to a captain's ~/.omp/agent/config.yml.
//
// Adapted from tamaratran/fast-jev-compaction (MIT), commit
// e3f262a7f4d42bd8dd32ced30d26176f7cb545b0. That project ships two things: a
// harness-agnostic npm library (src/) and a Claude Code-only function-hook
// plugin (hooks/) built on Claude Code's early-access hooks.json/SessionMessage
// API. omp's hook loader has no code path that reads hooks.json or that API
// shape (grepped extension-loading.md and plugin-manager-installer-plumbing.md
// for "hooks.json", "session.compact", "claude-code", "PluginOptions": zero
// matches), so only the decision algorithm is reusable; this file is a fresh
// port of that algorithm against omp's real, empirically captured
// session_before_compact contract, not a copy of hooks/fast-jev.ts. This repo
// has no package.json/node_modules pipeline for bin/.omp material, and omp
// loads .ts extensions directly with no build step, so the algorithm is
// adapted inline here rather than added as an npm dependency; that
// substitution (vendored port vs. npm install) is exactly what
// firstmate-coding-guidelines asks to flag for review before shipping.
//
// omp's compaction contract is boundary-plus-summary, not per-item surgery:
// session_before_compact only asks a hook to replace the *summary text* for
// the region omp already decided to discard (preparation.messagesToSummarize
// / .turnPrefixMessages, ending at preparation.firstKeptEntryId).
// preparation.recentMessages, after that boundary, are never touched by any
// compaction method, Jev-guided or native, and the original journal entries
// for the summarized region are never deleted from disk by omp itself: only
// the rebuilt LLM context stops including them. Verified empirically against
// live omp 18.2.5 (see docs/jev-compaction.md "Verified against a real omp
// session"): a disposable synthetic session with a probe hook dumped the real
// session_before_compact event, which is exactly
// { type, preparation: { firstKeptEntryId, messagesToSummarize,
// turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps,
// settings }, branchEntries, signal }, and omp's real assistant message
// content carries { type: "toolCall", id, name, arguments, intent } blocks
// with a *separate* { role: "toolResult", toolCallId, toolName, content,
// details, isError } message - not fast-jev-compaction's Claude Code
// SessionMessage shape (toolUses[]/toolResults[] arrays keyed by
// tool_use_id).
//
// So this extension's contribution, within that real contract: decide, per
// tool call/result pair in the region omp already discards, whether it is
// still needed (Jev noul questions, same two-question shape and 0.5
// threshold as upstream), and render the *kept* text verbatim with dropped
// content replaced by a short note - never an LLM paraphrase of content that
// survives. Never touch preparation.recentMessages or the chosen
// firstKeptEntryId boundary. A dropped call/result is omitted from the
// rendered summary with no recall marker there (matching upstream's own
// documented behavior, corrected in data/env-jev-repo-integration/report.md's
// second pass), but the original journal entries themselves are untouched
// disk state that omp already keeps regardless of method, and every decision
// (kept/truncated/dropped, by omp entry id) is written to
// preserveData.jevCompaction for audit. On any failure - missing key, network
// error, malformed Jev response, or a reduction ratio below
// FM_JEV_MIN_REDUCTION_RATIO - this returns undefined and visibly notifies a
// native-fallback status; it never reports Jev success when Jev did not run.

type HookUiContext = {
  hasUI?: boolean;
  notify?: (message: string, kind?: string) => void;
  setStatus?: (key: string, text: string) => void;
};

type HookContext = {
  ui?: HookUiContext;
};

// The omp extension API surface this file uses, declared locally: omp ships
// no separately installable type package (same approach as
// fm-primary-turnend-guard.ts's ExtensionAPI).
type ExtensionAPI = {
  on: (event: string, handler: (event: unknown, ctx: HookContext) => unknown) => void;
};

export type OmpContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
  | { type: string; [key: string]: unknown };

export type OmpMessage =
  | { role: "user" | "assistant"; content: OmpContentBlock[]; [key: string]: unknown }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: OmpContentBlock[]; isError?: boolean; [key: string]: unknown };

export type OmpFileOps = {
  read?: Record<string, unknown>;
  written?: Record<string, unknown>;
  edited?: Record<string, unknown>;
};

export type OmpCompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: OmpMessage[];
  turnPrefixMessages: OmpMessage[];
  recentMessages: OmpMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  fileOps: OmpFileOps;
  settings: Record<string, unknown>;
};

export type SessionBeforeCompactEvent = {
  type: "session_before_compact";
  preparation: OmpCompactionPreparation;
};

export type CompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromExtension: true;
  preserveData: { jevCompaction: JevCompactionAudit };
  details?: { readFiles?: string[]; modifiedFiles?: string[] };
};

export type JevCompactionAudit = {
  model: string;
  keepThreshold: number;
  candidateCalls: number;
  kept: number;
  truncated: number;
  dropped: string[];
  requestCount: number;
  stateTokens: number;
  reductionRatio: number;
};

// ---- Tunables, same names/defaults as upstream fast-jev-compaction so a
// captain who already knows that project's options recognizes these. ----

const DEFAULT_MODEL = "jev-latest";
const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_TRUNCATE_HEAD_CHARS = 300;
const DEFAULT_MAX_STATE_TOKENS = 25000;
const DEFAULT_MAX_REQUEST_TOKENS = 30000;
const DEFAULT_MIN_REDUCTION_RATIO = 0.25;
const REQUEST_OVERHEAD_TOKENS = 20;
const FETCH_TIMEOUT_MS = 30000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---- Token estimate: identical formula to upstream's src/state.ts, so
// batching lands in the same ballpark Jev itself reports (calibrated a
// little above real counts, not an exact tokenizer). ----

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const piece of text.match(TOKEN_PIECES) ?? []) {
    if (/^[A-Za-z]+$/.test(piece)) tokens += Math.max(1, Math.ceil(piece.length / 6));
    else if (/^\d+$/.test(piece)) tokens += Math.max(1, Math.ceil(piece.length / 2));
    else tokens += 1;
  }
  return tokens;
}

// ---- Flatten the OMP region into text + paired tool calls. ----

export type FlatEntry =
  | { kind: "text"; role: "user" | "assistant"; text: string; index: number }
  | { kind: "toolCall"; toolCallId: string; name: string; arguments: Record<string, unknown>; index: number; pinned: boolean };

export type PairedCall = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  callIndex: number;
  resultIndex: number;
};

function blockText(blocks: OmpContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Pairs every toolCall block with its toolResult message by id, in the given message region. */
export function pairToolCalls(messages: readonly OmpMessage[]): PairedCall[] {
  const resultByCallId = new Map<string, { index: number; message: Extract<OmpMessage, { role: "toolResult" }> }>();
  messages.forEach((message, index) => {
    if (message.role === "toolResult") {
      resultByCallId.set(message.toolCallId, { index, message });
    }
  });
  const paired: PairedCall[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const found = resultByCallId.get(block.id);
      if (!found) continue; // no result yet: not a candidate (nothing to drop)
      paired.push({
        toolCallId: block.id,
        name: block.name,
        arguments: block.arguments,
        resultText: blockText(found.message.content),
        isError: found.message.isError ?? false,
        callIndex: index,
        resultIndex: found.index,
      });
    }
  });
  return paired;
}

function inputSummary(input: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable]";
  }
  return json.length <= limit ? json : `${json.slice(0, limit)}…`;
}

// ---- Jev wire format: identical request/response shape to upstream. ----

type JevNoulAnswer = { type: "noul"; noul: number };
type JevAnswer = JevNoulAnswer | { type: string; [key: string]: unknown };
type JevResponse = { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens: number; output_tokens: number } };

function buildJevRequest(apiKey: string, model: string, state: string, questions: Record<string, unknown>) {
  return {
    url: SYSTEM_ONE_URL,
    method: "POST" as const,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
  };
}

function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("answers" in parsed) || typeof (parsed as { answers?: unknown }).answers !== "object") {
    throw new Error("Jev response is missing answers");
  }
  return parsed as JevResponse;
}

function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || answer.type !== "noul" || typeof (answer as JevNoulAnswer).noul !== "number" || !Number.isFinite((answer as JevNoulAnswer).noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return (answer as JevNoulAnswer).noul;
}

async function askJev(
  apiKey: string,
  model: string,
  state: string,
  questions: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<JevResponse> {
  const request = buildJevRequest(apiKey, model, state, questions);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

// ---- State building and batching: one state string per batch, resent whole
// each time (matches upstream), fitted to maxStateTokens by truncating tool
// call inputs first. ----

export type BuildStateOptions = { maxStateTokens: number; truncateInputChars: readonly number[] };

export function buildState(calls: readonly PairedCall[], options: BuildStateOptions): string {
  for (const inputChars of [...options.truncateInputChars, 0]) {
    const lines = calls.map(
      (call, i) => `#${i + 1} ${call.name} input=${inputSummary(call.arguments, inputChars)} -> ${call.isError ? "error" : "ok"}, ${call.resultText.length} chars (omitted)`,
    );
    const state = lines.join("\n");
    if (estimateTokens(state) <= options.maxStateTokens) return state;
  }
  const lines = calls.map((call, i) => `#${i + 1} ${call.name} -> ${call.isError ? "error" : "ok"}, ${call.resultText.length} chars (omitted)`);
  return lines.join("\n");
}

export function questionsFor(call: PairedCall, index: number) {
  return {
    [`keepCall${index}`]: {
      type: "noul",
      instructions: `Call #${index + 1} (${call.name}) was made with the input shown. Knowing it happened, with its input, still matters for later work in this conversation.`,
    },
    [`keepResult${index}`]: {
      type: "noul",
      instructions: `Call #${index + 1} (${call.name})'s full result is still needed verbatim, and re-running the tool would not reproduce it as usefully (e.g. it captured a point-in-time state).`,
    },
  };
}

export function batchCalls(calls: readonly PairedCall[], stateTokens: number, maxRequestTokens: number): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = stateTokens + REQUEST_OVERHEAD_TOKENS;
  calls.forEach((_, index) => {
    const questionTokens = 40; // small, fixed estimate per two-question pair
    if (current.length > 0 && currentTokens + questionTokens > maxRequestTokens) {
      batches.push(current);
      current = [];
      currentTokens = stateTokens + REQUEST_OVERHEAD_TOKENS;
    }
    current.push(index);
    currentTokens += questionTokens;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

export type CallDecision = { action: "keep" | "truncate" | "drop"; keepCall: number; keepResult: number };

export function decideCall(keepCall: number, keepResult: number, keepThreshold: number): CallDecision["action"] {
  if (keepResult >= keepThreshold) return "keep";
  if (keepCall >= keepThreshold) return "truncate";
  return "drop";
}

// ---- Rendering: verbatim text with per-call notes, never a paraphrase. ----

export function renderRegion(
  messages: readonly OmpMessage[],
  calls: readonly PairedCall[],
  decisions: ReadonlyMap<string, CallDecision["action"]>,
  truncateHeadChars: number,
): string {
  const callById = new Map(calls.map((call) => [call.toolCallId, call]));
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") continue; // rendered inline with its call below
    if (message.role === "user" || message.role === "assistant") {
      const text = blockText(message.content);
      if (text.trim()) lines.push(`${message.role}: ${text}`);
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const action = decisions.get(block.id);
        if (action === "drop") continue; // omitted entirely, no recall marker here
        const call = callById.get(block.id);
        if (!call) continue; // no paired result: not a decided candidate, leave it out
        const resultText =
          action === "truncate" ? `${call.resultText.slice(0, truncateHeadChars)}\n[${call.isError ? "error" : "ok"}, ${call.resultText.length} chars, truncated]` : call.resultText;
        lines.push(`${message.role}: [tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
        lines.push(`toolResult: ${resultText}`);
      }
    }
  }
  return lines.join("\n");
}

export function buildFilesTag(fileOps: OmpFileOps): string {
  const read = Object.keys(fileOps.read ?? {});
  const written = new Set([...Object.keys(fileOps.written ?? {}), ...Object.keys(fileOps.edited ?? {})]);
  const readOnly = read.filter((p) => !written.has(p));
  const entries = [...readOnly.map((p) => `${p} (Read)`), ...[...written].map((p) => `${p} (Write)`)].slice(0, 20);
  if (entries.length === 0) return "";
  return `<files>\n${entries.join("\n")}\n</files>`;
}

// ---- Top-level: run the whole decision + render pipeline for one region. ----

export type JevCompactOptions = {
  apiKey: string;
  model?: string;
  keepThreshold?: number;
  truncateHeadChars?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  fetchImpl?: typeof fetch;
};

export type JevCompactRegionResult = { text: string; audit: JevCompactionAudit };

export async function jevCompactRegion(messages: readonly OmpMessage[], options: JevCompactOptions): Promise<JevCompactRegionResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const keepThreshold = options.keepThreshold ?? DEFAULT_KEEP_THRESHOLD;
  const truncateHeadChars = options.truncateHeadChars ?? DEFAULT_TRUNCATE_HEAD_CHARS;
  const maxStateTokens = options.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;
  const maxRequestTokens = options.maxRequestTokens ?? DEFAULT_MAX_REQUEST_TOKENS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const calls = pairToolCalls(messages);
  const decisions = new Map<string, CallDecision["action"]>();

  if (calls.length === 0) {
    return {
      text: renderRegion(messages, [], decisions, truncateHeadChars),
      audit: { model, keepThreshold, candidateCalls: 0, kept: 0, truncated: 0, dropped: [], requestCount: 0, stateTokens: 0, reductionRatio: 0 },
    };
  }

  const state = buildState(calls, { maxStateTokens, truncateInputChars: [1000, 200, 60] });
  const stateTokens = estimateTokens(state);
  const batches = batchCalls(calls, stateTokens, maxRequestTokens);

  let requestCount = 0;
  for (const batch of batches) {
    const questions: Record<string, unknown> = {};
    for (const index of batch) Object.assign(questions, questionsFor(calls[index], index));
    const response = await askJev(options.apiKey, model, state, questions, fetchImpl);
    requestCount += 1;
    for (const index of batch) {
      const keepCall = noulAnswer(response.answers, `keepCall${index}`);
      const keepResult = noulAnswer(response.answers, `keepResult${index}`);
      decisions.set(calls[index].toolCallId, decideCall(keepCall, keepResult, keepThreshold));
    }
  }

  const kept = [...decisions.values()].filter((a) => a === "keep").length;
  const truncated = [...decisions.values()].filter((a) => a === "truncate").length;
  const dropped = calls.filter((c) => decisions.get(c.toolCallId) === "drop").map((c) => c.toolCallId);

  const originalChars = calls.reduce((sum, c) => sum + c.resultText.length, 0);
  const keptChars = calls.reduce((sum, c) => {
    const action = decisions.get(c.toolCallId);
    if (action === "keep") return sum + c.resultText.length;
    if (action === "truncate") return sum + Math.min(c.resultText.length, truncateHeadChars);
    return sum;
  }, 0);
  const reductionRatio = originalChars > 0 ? 1 - keptChars / originalChars : 0;

  return {
    text: renderRegion(messages, calls, decisions, truncateHeadChars),
    audit: { model, keepThreshold, candidateCalls: calls.length, kept, truncated, dropped, requestCount, stateTokens, reductionRatio },
  };
}

// ---- Extension wiring. ----

// ctx.ui.setStatus/notify are the verified visible channel: driving a real
// omp 18.2.5 session over RPC (headless, no TUI) with this reason and
// capturing its stdout showed both surface as real extension_ui_request
// frames (method "setStatus"/"notify") with this exact text - see
// docs/jev-compaction.md "Verified against a real omp session". console.error
// is also emitted as a best-effort debug trace, but was not observed in that
// same captured RPC stream, so only the ctx.ui calls are the proven
// visibility guarantee this function makes.
function fallback(ctx: HookContext, reason: string): undefined {
  console.error(`[fm-jev-compaction] falling back to native omp compaction: ${reason}`);
  ctx.ui?.setStatus?.("jev-compaction", `Jev compaction skipped (${reason}) - using native compaction`);
  ctx.ui?.notify?.(`Jev compaction skipped (${reason}); falling back to native omp compaction.`, "info");
  return undefined;
}

/** Matches omp's own documented split-turn merge format (compaction.md "Split-turn handling"). */
export function mergeSplitTurnSummary(history: string, turnPrefix: string): string {
  if (!turnPrefix) return history;
  if (!history) return turnPrefix;
  return `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix}`;
}

export function mergeAudits(a: JevCompactionAudit, b: JevCompactionAudit): JevCompactionAudit {
  const candidateCalls = a.candidateCalls + b.candidateCalls;
  return {
    model: a.model,
    keepThreshold: a.keepThreshold,
    candidateCalls,
    kept: a.kept + b.kept,
    truncated: a.truncated + b.truncated,
    dropped: [...a.dropped, ...b.dropped],
    requestCount: a.requestCount + b.requestCount,
    stateTokens: a.stateTokens + b.stateTokens,
    reductionRatio: candidateCalls > 0 ? (a.reductionRatio * a.candidateCalls + b.reductionRatio * b.candidateCalls) / candidateCalls : 0,
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (rawEvent: unknown, ctx: HookContext) => {
    if (process.env.FM_JEV_COMPACTION !== "1") return undefined;

    const event = rawEvent as SessionBeforeCompactEvent;
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) return fallback(ctx, "TYPESAFE_API_KEY unset");

    const historyRegion = event.preparation.messagesToSummarize;
    const turnPrefixRegion = event.preparation.isSplitTurn ? event.preparation.turnPrefixMessages : [];
    if (historyRegion.length === 0 && turnPrefixRegion.length === 0) return undefined; // nothing to summarize: let omp handle it

    const options: JevCompactOptions = {
      apiKey,
      model: process.env.TYPESAFE_MODEL || DEFAULT_MODEL,
      keepThreshold: envNumber("FM_JEV_KEEP_THRESHOLD", DEFAULT_KEEP_THRESHOLD),
      truncateHeadChars: envNumber("FM_JEV_TRUNCATE_HEAD_CHARS", DEFAULT_TRUNCATE_HEAD_CHARS),
      maxStateTokens: envNumber("FM_JEV_MAX_STATE_TOKENS", DEFAULT_MAX_STATE_TOKENS),
      maxRequestTokens: envNumber("FM_JEV_MAX_REQUEST_TOKENS", DEFAULT_MAX_REQUEST_TOKENS),
    };
    const minReductionRatio = envNumber("FM_JEV_MIN_REDUCTION_RATIO", DEFAULT_MIN_REDUCTION_RATIO);

    let result: JevCompactRegionResult;
    try {
      const historyResult = await jevCompactRegion(historyRegion, options);
      // Split-turn mirrors omp's own two-summary native behavior (compaction.md
      // "Split-turn handling"): a separate Jev pass for the turn prefix, merged
      // with the same documented section header, never flattened into one region.
      const turnPrefixResult =
        turnPrefixRegion.length > 0 ? await jevCompactRegion(turnPrefixRegion, options) : { text: "", audit: { ...historyResult.audit, candidateCalls: 0, kept: 0, truncated: 0, dropped: [], requestCount: 0, stateTokens: 0, reductionRatio: 0 } };
      result = { text: mergeSplitTurnSummary(historyResult.text, turnPrefixResult.text), audit: mergeAudits(historyResult.audit, turnPrefixResult.audit) };
    } catch (error) {
      return fallback(ctx, error instanceof Error ? error.message : "Jev request failed");
    }

    if (result.audit.candidateCalls > 0 && result.audit.reductionRatio < minReductionRatio) {
      return fallback(ctx, `reduction ${(result.audit.reductionRatio * 100).toFixed(0)}% below minimum`);
    }

    const filesTag = buildFilesTag(event.preparation.fileOps);
    const summary = filesTag ? `${result.text}\n\n${filesTag}` : result.text;

    const statusText = `Jev compaction: kept ${result.audit.kept}, truncated ${result.audit.truncated}, dropped ${result.audit.dropped.length} of ${result.audit.candidateCalls} calls (${(result.audit.reductionRatio * 100).toFixed(0)}% reduction)`;
    console.error(`[fm-jev-compaction] ${statusText}`);
    ctx.ui?.setStatus?.("jev-compaction", statusText);

    const compaction: CompactionResult = {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      fromExtension: true,
      preserveData: { jevCompaction: result.audit },
    };
    return { compaction };
  });
}

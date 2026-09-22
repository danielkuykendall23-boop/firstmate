// Key-gated Jev-guided compaction for OMP. A missing key or
// FM_JEV_COMPACTION=0 registers no hook, preserving native speculative
// compaction. Neither activation nor fallback changes saved settings.
//
// This is an OMP adapter around the real, pinned upstream decision
// algorithm - not a reimplementation of it. `./vendor/fast-jev-compaction/`
// is a verbatim copy of tamaratran/fast-jev-compaction's src/ (MIT, commit
// e3f262a7f4d42bd8dd32ced30d26176f7cb545b0; see vendor/fast-jev-compaction/
// NOTICE.md for provenance, the sha256 of the pinned source archive, and the
// exact one-line-per-file import-extension patch applied so Node's own
// loader - the same loader omp's native .ts extension discovery uses -
// resolves the vendored files' internal `./x.js` imports; verified:
// unpatched, `node --input-type=module -e "import '...compact.ts'"` fails
// with ERR_MODULE_NOT_FOUND for request.js). Every actual decision - state
// fitting, batching, the keep/drop rule, applyDecisions' verbatim rendering
// and pairing guarantee - runs as the real vendored `compact()`, not a port.
//
// What upstream's own project cannot supply is reusable: its hooks/ plugin
// is built on Claude Code's early-access hooks.json/SessionMessage function-
// hook API, and omp's hook/extension loader has no code path that reads
// that manifest or event-name shape (grepped extension-loading.md and
// plugin-manager-installer-plumbing.md for "hooks.json", "session.compact",
// "claude-code", "PluginOptions": zero matches). So this file supplies only
// what the vendored library cannot: translating omp's real message shapes
// into the library's Message/ToolUse/ToolResult shape, rendering the
// library's own pruned result into the summary text omp's
// session_before_compact contract actually accepts, and the omp-side
// fallback/env-var/wiring glue.
//
// omp's compaction contract is boundary-plus-summary, not per-item surgery:
// session_before_compact only asks a hook to replace the *summary text* for
// the region omp already decided to discard (preparation.messagesToSummarize
// / .turnPrefixMessages, ending at preparation.firstKeptEntryId).
// preparation.recentMessages, after that boundary, are never touched by any
// compaction method, Jev-guided or native, and the original journal entries
// for the summarized region are never deleted from disk by omp itself: only
// the rebuilt LLM context stops including them. Verified empirically against
// live omp 18.2.5 (docs/verification/jev.md): a disposable synthetic session
// with a probe hook dumped the real session_before_compact event, which is
// exactly { type, preparation: { firstKeptEntryId, messagesToSummarize,
// turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps,
// settings }, branchEntries, signal }, and omp's real assistant message
// content carries { type: "toolCall", id, name, arguments, intent } blocks
// with a *separate* { role: "toolResult", toolCallId, toolName, content,
// details, isError } message - not the vendored library's own Message shape.
// The same region also carries pi's other AgentMessage kinds: an extension-
// injected `custom` message whose content may be a bare string (this repo's
// own turn-end guard sends one at every session start), `!cmd` bash and
// python executions with no content at all, and branch summaries carrying
// only `summary`; toLibraryMessages below flattens each the way pi's own
// convertToLlm does before the library ever sees it, and drops an execution
// flagged excludeFromContext (`!!cmd`) exactly as that conversion does, so
// nothing omp keeps out of the model's context reaches Jev or the summary.
// An earlier compaction's summary never sits in the region: omp passes it
// as preparation.previousSummary, and the handler prepends it verbatim so a
// second compaction never discards what the first one kept. Because that
// carried text is opaque to every later Jev pass, both gates below measure
// the complete replacement - carried summary plus the new region - and hand
// the whole thing to native compaction, which rewrites and bounds it, when
// Jev's verbatim result cannot satisfy them. Two native methods keep a
// compaction's substance beside the entry's summary text rather than in it
// (OpenAI remote compaction's replayed history under
// preserveData.openaiRemoteCompaction, behind a placeholder summary
// sentence; snapcompact's archive frames under preserveData.snapcompact),
// and omp reads either back only from the newest compaction entry, so a
// text-only hook result following one of them would silently drop it. When
// preparation.previousPreserveData carries such a key the handler declines
// before Jev is contacted and native compaction, which carries both forward
// itself, runs instead. Each such native compaction writes its key into the
// newest entry again, so that decline then holds for the rest of the
// session: with an OpenAI-family model and a methodOrder that starts at
// remote (the captain's configuration), the first fallback of any kind hands
// every later compaction of that session to native compaction, and only a
// fresh session, or a native method that leaves no such key, brings Jev
// back. Preserving that history is deliberate; the cost is disclosed in
// docs/jev.md.
//
// A dropped call/result is omitted from the rendered summary with no recall
// marker there (the vendored applyDecisions' own documented behavior), but
// the original journal entries themselves are untouched disk state that omp
// already keeps regardless of method, and every decision (kept/truncated/
// dropped, by omp tool-call id) is written to preserveData.jevCompaction for
// audit, straight from the vendored library's own result.decisions/stats. On
// any failure - Hide Secrets on or not provable, missing key, unknown model
// capacity, network error, malformed Jev response, a whole-context character
// reduction below MIN_REDUCTION_RATIO, or a replacement above the retained-
// context budget - this returns undefined and visibly notifies a native-
// fallback status; it never reports Jev success when Jev did not run. Both
// gates are first measured over the region's irreducible floor - the
// library's own applyDecisions run as if Jev had dropped every candidate
// call, leaving the carried summary, pinned and unanswered calls, and all
// user/assistant prose - and a floor that already fails either gate is
// declined before any request is built, so a region no Jev answer could make
// installable is never uploaded. The real result can only be larger, and the
// same gates run on it again.
//
// The retained-context budget is derived from omp's own arithmetic for the
// active model rather than from the cap omp puts on an LLM-written summary:
// omp's compaction-loop guard treats a compaction as progress only while the
// context it leaves behind stays at or under 80% of the trigger it computes
// for the model's context window (thresholdTokens clamped to the window),
// so the installed replacement - carried summary, Jev-pruned region and
// <files> block - must fit under that ceiling with the model's response
// reserve, the recent messages omp keeps, and the system prompt already
// counted. Whatever fits leaves at least a fifth of the trigger plus one
// full response of headroom before the next compaction; whatever does not
// is handed to native compaction, which rewrites and bounds the whole
// context. Verbatim text the library cannot prune (user and assistant
// prose) is never truncated to make a result fit.
//
// The key is TYPESAFE_API_KEY from the process environment, else the
// TYPESAFE_API_KEY= line of $FM_HOME/.env read under the same rule as
// bin/fm-env-lib.sh's fmx_env_get (environment wins, last assignment wins,
// one layer of matching quotes stripped). The value is never logged.
//
// omp's own "Hide Secrets" redaction (`secrets.enabled`, default off) is
// applied to every native provider request, but the preparation omp hands a
// session_before_compact handler is the raw, un-redacted region, and the
// hook context exposes no redaction helper or settings reader. So before
// anything is sent, the handler asks omp itself: it runs this very omp
// binary's `config get secrets.enabled --json` as a child with the session's
// cwd and inherited environment, so global/project precedence, the
// config.yml/config.yaml choice, the project group-shadow rule and a
// --profile agent directory are all decided by omp's own settings loader.
// The one input that reader does not see is a `--config` overlay on this
// process's own argv, so those files are read here with a deliberately
// narrow rule: a top-level `secrets:` block with a plain boolean `enabled:`
// child states the switch, an overlay that never mentions secrets states
// nothing, and every other way of touching it is not followed. When the
// switch is on, or when any of that cannot be established, the handler
// declines before Jev is contacted; native compaction, which omp redacts,
// runs instead.
//
// FM_JEV_ENDPOINT replaces the upstream System One URL so the repository's
// live omp test can point a real session at a local fake endpoint; it is
// not a tuning knob and is unset in every real launch.
import { fileURLToPath } from "node:url";
import { resolveTypesafeKey } from "./lib/fm-jev-key.ts";
import { hideSecretsState } from "./lib/fm-jev-privacy.ts";
import { registrations } from "./lib/fm-jev-registration.ts";
import {
  applyDecisions,
  collectToolCalls,
  compact,
  decideCall,
  estimateTokens,
  JevClient,
  messageChars,
  resolveOptions,
  type CompactOptions,
  type CompactResult,
  type Message as LibMessage,
  type ToolResult as LibToolResult,
  type ToolUse as LibToolUse,
} from "./vendor/fast-jev-compaction/src/index.ts";

type HookUiContext = {
  hasUI?: boolean;
  notify?: (message: string, kind?: string) => void;
  setStatus?: (key: string, text: string) => void;
};

type HookModel = {
  id?: string;
  contextWindow?: number;
};

type HookContext = {
  ui?: HookUiContext;
  cwd?: string;
  model?: HookModel;
  getSystemPrompt?: () => unknown;
};

// The omp extension API surface this file uses, declared locally: omp ships
// no separately installable type package (same approach as
// fm-primary-turnend-guard.ts's ExtensionAPI).
type ExtensionAPI = {
  events: object;
  on: (event: string, handler: (event: unknown, ctx: HookContext) => unknown) => void;
};

export type OmpContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
  | { type: string; [key: string]: unknown };

// One entry of omp's AgentMessage union as the hook receives it. `content`
// is block-shaped on user/assistant/toolResult messages, may be a bare
// string on a user prompt or a `custom` message, and is absent on a bash
// (command/output) or python (code/output) execution or a summary (summary)
// message.
export type OmpMessage = {
  role: string;
  content?: string | OmpContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  code?: string;
  output?: string;
  excludeFromContext?: boolean;
  summary?: string;
  [key: string]: unknown;
};

// omp's CompactionPreparation.fileOps: three Set<string> fields.
export type OmpFileOps = {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
};

// omp's compaction settings group as the hook receives it; these are the
// fields omp's own trigger and reserve arithmetic reads.
export type OmpCompactionSettings = {
  thresholdTokens?: number;
  thresholdPercent?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  [key: string]: unknown;
};

export type OmpCompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: OmpMessage[];
  turnPrefixMessages: OmpMessage[];
  recentMessages: OmpMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  previousPreserveData?: Record<string, unknown>;
  fileOps: OmpFileOps;
  settings: OmpCompactionSettings;
};

export type SessionBeforeCompactEvent = {
  type: "session_before_compact";
  preparation: OmpCompactionPreparation;
};

export type OmpCompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromExtension: true;
  preserveData: { jevCompaction: JevCompactionRecord };
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
  charsBefore: number;
  charsAfter: number;
  reductionRatio: number;
};

// The audit as installed: the region stats above, re-measured over the
// complete replacement (carried previous summary included), with the
// estimated size of what was installed beside the budget it had to fit.
export type JevCompactionRecord = JevCompactionAudit & {
  previousSummaryChars: number;
  summaryTokens: number;
  budget: RetainedBudget;
};

const JEV_MODEL = "jev-latest";
const MIN_REDUCTION_RATIO = 0.25;
const FILES_TAG_LIMIT = 20;

const extensionFile = fileURLToPath(import.meta.url);




function contentBlocks(content: unknown): OmpContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as OmpContentBlock[]) : [];
}

function blockText(blocks: OmpContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** The text of one omp message, flattened the way pi's convertToLlm flattens each AgentMessage kind. */
export function messageText(message: OmpMessage): string {
  if (message.role === "bashExecution") {
    return `Ran \`${message.command ?? ""}\`${message.output ? `\n${message.output}` : ""}`;
  }
  if (message.role === "pythonExecution") {
    return `Ran Python:\n${message.code ?? ""}${message.output ? `\nOutput:\n${message.output}` : ""}`;
  }
  if (message.content === undefined && typeof message.summary === "string") return message.summary;
  return blockText(contentBlocks(message.content));
}

/** omp's own LLM conversion returns nothing for an execution flagged excludeFromContext (`!!cmd`); so does this adapter. */
function excludedFromContext(message: OmpMessage): boolean {
  return (message.role === "bashExecution" || message.role === "pythonExecution") && message.excludeFromContext === true;
}

// ---- omp message shapes -> the vendored library's own Message shape. ----

/**
 * Translates omp's real toolCall-block-plus-separate-toolResult-message wire
 * shape into the vendored library's Message/ToolUse/ToolResult convention
 * (a Claude Code SessionMessage subset: toolUses[]/toolResults[] on a
 * message, paired by tool_use_id). This is the one piece the vendored
 * library cannot supply, because it was built against a different host's
 * transcript shape.
 */
export function toLibraryMessages(messages: readonly OmpMessage[]): LibMessage[] {
  const resultByCallId = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      resultByCallId.set(message.toolCallId, { text: messageText(message), isError: message.isError ?? false });
    }
  }

  const out: LibMessage[] = [];
  for (const message of messages) {
    if (excludedFromContext(message)) continue;
    if (message.role === "toolResult") {
      // omp represents a tool result as its own message; the library expects
      // toolResults[] attached to *some* message. A synthetic carrier keeps
      // it at its real position, and collectToolCalls pairs by tool_use_id
      // regardless of which message carries it.
      const result: LibToolResult = { tool_use_id: message.toolCallId ?? "", text: messageText(message), isError: message.isError ?? false };
      out.push({ role: "user", text: "", toolUses: [], toolResults: [result] });
      continue;
    }
    const toolUses: LibToolUse[] = [];
    for (const block of contentBlocks(message.content)) {
      if (block.type !== "toolCall") continue;
      const call = block as { id: string; name: string; arguments: Record<string, unknown> };
      const paired = resultByCallId.get(call.id);
      const toolUse: LibToolUse = { tool_use_id: call.id, tool: call.name, input: call.arguments ?? {} };
      // "text"/"isError" mirror the paired result once the transcript holds
      // it (types.ts's own doc comment: "Claude Code attaches them") - omp's
      // toolCall block never carries them itself, so backfill from the
      // separate toolResult message, matching what the library assumes.
      if (paired) {
        toolUse.text = paired.text;
        toolUse.isError = paired.isError;
      }
      toolUses.push(toolUse);
    }
    out.push({ role: message.role === "assistant" ? "assistant" : "user", text: messageText(message), toolUses });
  }
  return out;
}

// ---- Render the library's own pruned Message[] result into plain text.
// applyDecisions already truncated dropped-result text in place (with its
// own note) and never orphans a call without its result, so this only needs
// to walk the kept array in order - no truncation/decision logic of its own.

export function renderLibraryMessages(messages: readonly LibMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.text.trim()) lines.push(`${message.role}: ${message.text}`);
    for (const tool of message.toolUses) {
      lines.push(`${message.role}: [tool call ${tool.tool}] ${JSON.stringify(tool.input)}`);
    }
    for (const result of message.toolResults ?? []) {
      lines.push(`toolResult: ${result.text}`);
    }
  }
  return lines.join("\n");
}

/** Matches omp's own documented split-turn merge format (compaction.md "Split-turn handling"). */
export function mergeSplitTurnSummary(history: string, turnPrefix: string): string {
  if (!turnPrefix) return history;
  if (!history) return turnPrefix;
  return `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix}`;
}

/**
 * omp never places an earlier compaction's summary in the region; it arrives
 * as preparation.previousSummary, and buildSessionContext afterwards reads
 * only the newest compaction entry, so it must lead the new summary or be
 * lost. Kept verbatim, so the carried text is opaque to every later Jev
 * pass; installedRecord therefore measures both gates over the complete
 * replacement rather than the new region alone.
 */
export function mergePreviousSummary(previous: string | undefined, current: string): string {
  if (!previous) return current;
  return `${previous}\n\n---\n\n**Later history:**\n\n${current}`;
}

/** The summary text as omp installs it: the carried previous summary, the region's text, and the <files> block. */
export function assembleSummary(previousSummary: string, regionText: string, filesTag: string): string {
  const text = mergePreviousSummary(previousSummary, regionText);
  return filesTag ? `${text}\n\n${filesTag}` : text;
}

function reduction(charsBefore: number, charsAfter: number): number {
  return charsBefore > 0 ? 1 - charsAfter / charsBefore : 0;
}

/** The library's per-run `t1`, `t2`, ... ids back to omp's own toolCall ids; collectToolCalls is deterministic for the same messages. */
export function toolCallIdsByLibraryId(libMessages: readonly LibMessage[]): Map<string, string> {
  return new Map(collectToolCalls(libMessages, 0).map((call) => [call.id, call.tool_use_id]));
}

export function auditFromResult(model: string, keepThreshold: number, result: CompactResult, toolCallIds: ReadonlyMap<string, string>): JevCompactionAudit {
  const dropped = result.decisions.filter((d) => d.action === "drop_call").map((d) => toolCallIds.get(d.id) ?? d.id);
  const truncated = result.decisions.filter((d) => d.action === "drop_result").length;
  return {
    model,
    keepThreshold,
    candidateCalls: result.stats.calls,
    kept: result.stats.kept,
    truncated,
    dropped,
    requestCount: result.stats.requests,
    stateTokens: result.stats.stateTokens,
    charsBefore: result.stats.charsBefore,
    charsAfter: result.stats.charsAfter,
    reductionRatio: reduction(result.stats.charsBefore, result.stats.charsAfter),
  };
}

export function mergeAudits(a: JevCompactionAudit, b: JevCompactionAudit): JevCompactionAudit {
  const charsBefore = a.charsBefore + b.charsBefore;
  const charsAfter = a.charsAfter + b.charsAfter;
  return {
    model: a.model,
    keepThreshold: a.keepThreshold,
    candidateCalls: a.candidateCalls + b.candidateCalls,
    kept: a.kept + b.kept,
    truncated: a.truncated + b.truncated,
    dropped: [...a.dropped, ...b.dropped],
    requestCount: a.requestCount + b.requestCount,
    stateTokens: a.stateTokens + b.stateTokens,
    charsBefore,
    charsAfter,
    reductionRatio: reduction(charsBefore, charsAfter),
  };
}

// preserveData keys under which a native method keeps the substance of its
// compaction beside the summary text; omp reads each back only from the
// newest compaction entry, and a text-only summary cannot carry either.
const NATIVE_PRESERVED_HISTORY_KEYS = ["openaiRemoteCompaction", "snapcompact"] as const;

/** The key of a previous compaction's method-native history a text-only Jev result would drop, if any. */
export function unretainableNativeHistory(previousPreserveData: Record<string, unknown> | undefined): string | undefined {
  return NATIVE_PRESERVED_HISTORY_KEYS.find((key) => {
    const value = previousPreserveData?.[key];
    return typeof value === "object" && value !== null && !Array.isArray(value);
  });
}

// ---- The retained-context budget, from omp's own trigger and reserve rules
// for the active model (omp 18.2.8, verified in the installed binary):
//   reserve  = max(floor(contextWindow * 0.15), compaction.reserveTokens ?? 16384)
//   trigger  = thresholdTokens > 0 ? min(contextWindow - 1, thresholdTokens)
//            : thresholdPercent > 0 ? floor(contextWindow * clamp(percent, 1..99) / 100)
//            : max(0, min(contextWindow - 1, contextWindow - thresholdReserve))
//   ceiling  = floor(trigger * 0.8), the most context a compaction may leave
//              behind before omp's loop guard pauses automatic maintenance.

const OMP_DEFAULT_RESERVE_TOKENS = 16384;
const OMP_RESERVE_FRACTION = 0.15;
const OMP_PROGRESS_FRACTION = 0.8;

function effectiveReserve(contextWindow: number, settings: OmpCompactionSettings): number {
  return Math.max(Math.floor(contextWindow * OMP_RESERVE_FRACTION), settings.reserveTokens ?? OMP_DEFAULT_RESERVE_TOKENS);
}

function thresholdReserve(contextWindow: number, settings: OmpCompactionSettings): number {
  const reserve = effectiveReserve(contextWindow, settings);
  const fifteenPercent = Math.max(1, Math.floor(contextWindow * OMP_RESERVE_FRACTION));
  const unset = settings.reserveTokens === undefined;
  return (unset && reserve >= contextWindow - fifteenPercent) || reserve >= contextWindow ? fifteenPercent : reserve;
}

/** The token count at which omp triggers compaction for this model and these settings. */
export function triggerTokens(contextWindow: number, settings: OmpCompactionSettings): number {
  const fixed = settings.thresholdTokens;
  if (typeof fixed === "number" && Number.isFinite(fixed) && fixed > 0) return Math.min(contextWindow - 1, Math.max(1, fixed));
  const percent = settings.thresholdPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) {
    return Math.max(0, Math.min(contextWindow - 1, contextWindow - thresholdReserve(contextWindow, settings)));
  }
  return Math.floor(contextWindow * (Math.min(99, Math.max(1, percent)) / 100));
}

/** The text of omp's system prompt as the hook receives it: a string, or an array of strings and `{ text }` parts (omp 18.2.8 hands an array of strings). */
export function systemPromptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown } | null)?.text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

export type RetainedBudget = {
  contextWindow: number;
  trigger: number;
  progressCeiling: number;
  reserve: number;
  recentTokens: number;
  systemPromptTokens: number;
  budgetTokens: number;
};

/**
 * How much retained verbatim history the installed replacement may hold:
 * omp's progress ceiling for this model, less the model's response reserve,
 * the recent messages omp keeps beside the summary, and the system prompt.
 * Whatever fits leaves at least a fifth of the trigger plus one full
 * response of headroom before the next compaction and never trips omp's
 * compaction-loop guard.
 */
export function retainedBudget(contextWindow: number, settings: OmpCompactionSettings, recentTokens: number, systemPromptTokens: number): RetainedBudget {
  const trigger = triggerTokens(contextWindow, settings);
  const progressCeiling = Math.floor(trigger * OMP_PROGRESS_FRACTION);
  const reserve = effectiveReserve(contextWindow, settings);
  return { contextWindow, trigger, progressCeiling, reserve, recentTokens, systemPromptTokens, budgetTokens: progressCeiling - reserve - recentTokens - systemPromptTokens };
}

/**
 * The region audit re-measured as installed: the carried previous summary
 * counts on both sides of the reduction, so a small region that shrank a lot
 * cannot pass once the verbatim carry dominates, and the whole replacement's
 * estimated size stands beside the budget it must fit.
 */
export function installedRecord(audit: JevCompactionAudit, previousSummary: string, summary: string, budget: RetainedBudget): JevCompactionRecord {
  const previousSummaryChars = previousSummary.length;
  return {
    ...audit,
    previousSummaryChars,
    reductionRatio: reduction(previousSummaryChars + audit.charsBefore, previousSummaryChars + audit.charsAfter),
    summaryTokens: estimateTokens(summary),
    budget,
  };
}

/**
 * The same <files> block omp's native summaries carry - one sorted
 * "path (Read|Write)" line each, elided past 20 - built from the Set<string>
 * fields of omp's CompactionPreparation.fileOps. omp only carries file
 * operations forward from its own native compaction entries, so for an
 * extension result this block in the summary text is what preserves them.
 */
export function buildFilesTag(fileOps: OmpFileOps): string {
  const written = new Set<string>([...fileOps.written, ...fileOps.edited]);
  const labels = new Map<string, string>();
  for (const path of fileOps.read) if (!written.has(path)) labels.set(path, "Read");
  for (const path of written) labels.set(path, "Write");
  const paths = [...labels.keys()].sort();
  if (paths.length === 0) return "";
  const lines = paths.slice(0, FILES_TAG_LIMIT).map((path) => `${path} (${labels.get(path)})`);
  if (paths.length > FILES_TAG_LIMIT) lines.push(`[…${paths.length - FILES_TAG_LIMIT} files elided…]`);
  return `<files>\n${lines.join("\n")}\n</files>`;
}

// ---- Top-level: run the real vendored compact() against one omp region. ----

export type JevRegionOptions = CompactOptions & { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch };
export type JevRegionResult = { text: string; audit: JevCompactionAudit };

export async function compactOmpRegion(messages: readonly OmpMessage[], options: JevRegionOptions): Promise<JevRegionResult> {
  const asker = new JevClient({ apiKey: options.apiKey, model: JEV_MODEL, baseUrl: options.baseUrl, fetch: options.fetchImpl });
  const libMessages = toLibraryMessages(messages);
  // The region omp hands the hook is already scoped to "not recent"; a
  // second preserveRecentMessages layer inside it would wrongly re-protect
  // its own tail, so this always compacts the whole given region.
  const result = await compact(libMessages, asker, { ...options, preserveRecentMessages: 0 });
  return {
    text: renderLibraryMessages(result.messages),
    audit: auditFromResult(JEV_MODEL, resolveOptions(options).keepThreshold, result, toolCallIdsByLibraryId(libMessages)),
  };
}

export type IrreducibleRegion = { text: string; charsBefore: number; charsAfter: number };

/**
 * The smallest replacement any Jev answer could leave for a region: the
 * vendored library's own collectToolCalls, decideCall and applyDecisions run
 * with every answer at zero, so each candidate call is dropped together with
 * its result while pinned calls, calls without a result, orphan results and
 * all user/assistant prose stay exactly as the library keeps them. Nothing is
 * fitted or sent; a real answer can only add to this.
 */
export function irreducibleOmpRegion(messages: readonly OmpMessage[]): IrreducibleRegion {
  const libMessages = toLibraryMessages(messages);
  const resolved = resolveOptions({ preserveRecentMessages: 0 });
  const calls = collectToolCalls(libMessages, resolved.preserveRecentMessages);
  const decisions = calls.map((call) => decideCall(call, { keepCall: 0, keepResult: 0 }, resolved));
  const kept = applyDecisions(libMessages, decisions, calls, resolved.truncateHeadChars);
  const chars = (list: readonly LibMessage[]): number => list.reduce((sum, message) => sum + messageChars(message), 0);
  return { text: renderLibraryMessages(kept), charsBefore: chars(libMessages), charsAfter: chars(kept) };
}

/** The floor for everything omp hands over at once: both halves of a split turn, merged as the installed summary would be. */
export function irreducibleReplacement(historyRegion: readonly OmpMessage[], turnPrefixRegion: readonly OmpMessage[]): IrreducibleRegion {
  const history = irreducibleOmpRegion(historyRegion);
  if (turnPrefixRegion.length === 0) return history;
  const prefix = irreducibleOmpRegion(turnPrefixRegion);
  return {
    text: mergeSplitTurnSummary(history.text, prefix.text),
    charsBefore: history.charsBefore + prefix.charsBefore,
    charsAfter: history.charsAfter + prefix.charsAfter,
  };
}

// ---- Extension wiring. ----

// Both channels are verified visible against a real omp 18.2.5 process
// (docs/verification/jev.md):
// ctx.ui.setStatus/notify surface as real extension_ui_request frames
// (method "setStatus"/"notify") in the RPC stream itself, and
// console.error surfaces on the process's own stderr, captured in the same
// run when stderr is merged into the driver's log (the ordinary way any
// real omp launcher captures a session's output). Neither channel silently
// claims Jev ran when it did not.
function fallback(ctx: HookContext, reason: string): undefined {
  console.error(`[fm-jev-compaction] falling back to native omp compaction: ${reason}`);
  ctx.ui?.setStatus?.("jev-compaction", `Jev compaction skipped (${reason}) - using native compaction`);
  ctx.ui?.notify?.(`Jev compaction skipped (${reason}); falling back to native omp compaction.`, "info");
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  if (process.env.FM_JEV_COMPACTION === "0" || !resolveTypesafeKey(extensionFile)) return;
  const loaded = registrations("fm-jev-compaction");
  if (loaded.has(pi.events)) return;

  pi.on("session_before_compact", async (rawEvent: unknown, ctx: HookContext) => {
    const event = rawEvent as SessionBeforeCompactEvent;
    const cwd = ctx.cwd ?? process.cwd();

    const hideSecrets = hideSecretsState(cwd);
    if (hideSecrets.state === "on") return fallback(ctx, `omp Hide Secrets is on (${hideSecrets.source}) and the hook receives the un-redacted region`);
    if (hideSecrets.state === "unprovable") return fallback(ctx, `omp Hide Secrets could not be established: ${hideSecrets.detail}`);

    const apiKey = resolveTypesafeKey(extensionFile);
    if (!apiKey) return fallback(ctx, "TYPESAFE_API_KEY unset");

    const historyRegion = event.preparation.messagesToSummarize;
    const turnPrefixRegion = event.preparation.isSplitTurn ? event.preparation.turnPrefixMessages : [];
    if (historyRegion.length === 0 && turnPrefixRegion.length === 0) return undefined; // nothing to summarize: let omp handle it

    const nativeHistory = unretainableNativeHistory(event.preparation.previousPreserveData);
    if (nativeHistory) return fallback(ctx, `the previous compaction's ${nativeHistory} history cannot be carried by a text-only summary`);

    const contextWindow = ctx.model?.contextWindow;
    if (typeof contextWindow !== "number" || !(contextWindow > 0)) return fallback(ctx, "the active model's context window is unknown, so no retained-context budget can be derived");
    const budget = retainedBudget(
      contextWindow,
      event.preparation.settings,
      estimateTokens(renderLibraryMessages(toLibraryMessages(event.preparation.recentMessages))),
      estimateTokens(systemPromptText(await ctx.getSystemPrompt?.())),
    );
    if (budget.budgetTokens <= 0) return fallback(ctx, `no retained-context budget: omp's ${budget.progressCeiling}-token progress ceiling is consumed by the response reserve, the recent messages, and the system prompt`);

    const previousSummary = event.preparation.previousSummary ?? "";
    const filesTag = buildFilesTag(event.preparation.fileOps);

    const floor = irreducibleReplacement(historyRegion, turnPrefixRegion);
    const floorReduction = reduction(previousSummary.length + floor.charsBefore, previousSummary.length + floor.charsAfter);
    if (floorReduction < MIN_REDUCTION_RATIO) {
      return fallback(ctx, `reduction ${(floorReduction * 100).toFixed(0)}% of the whole context below minimum even if Jev dropped every candidate call`);
    }
    const floorTokens = estimateTokens(assembleSummary(previousSummary, floor.text, filesTag));
    if (floorTokens > budget.budgetTokens) {
      return fallback(ctx, `even if Jev dropped every candidate call, the carried summary and the verbatim text the library cannot prune are ~${floorTokens} tokens, over the ${budget.budgetTokens}-token retained-context budget for a ${contextWindow}-token model`);
    }

    const options: JevRegionOptions = { apiKey, baseUrl: process.env.FM_JEV_ENDPOINT || undefined };

    let merged: JevRegionResult;
    try {
      const historyResult = await compactOmpRegion(historyRegion, options);
      // Split-turn mirrors omp's own two-summary native behavior
      // (compaction.md "Split-turn handling"): a separate Jev pass for the
      // turn prefix, merged with the same documented section header, never
      // flattened into one region.
      const turnPrefixResult = turnPrefixRegion.length > 0 ? await compactOmpRegion(turnPrefixRegion, options) : undefined;
      merged = turnPrefixResult
        ? { text: mergeSplitTurnSummary(historyResult.text, turnPrefixResult.text), audit: mergeAudits(historyResult.audit, turnPrefixResult.audit) }
        : historyResult;
    } catch (error) {
      return fallback(ctx, error instanceof Error ? error.message : "Jev request failed");
    }

    const summary = assembleSummary(previousSummary, merged.text, filesTag);
    const record = installedRecord(merged.audit, previousSummary, summary, budget);

    if (record.reductionRatio < MIN_REDUCTION_RATIO) {
      return fallback(ctx, `reduction ${(record.reductionRatio * 100).toFixed(0)}% of the whole context below minimum`);
    }
    if (record.summaryTokens > budget.budgetTokens) {
      return fallback(ctx, `replacement of ~${record.summaryTokens} tokens exceeds the ${budget.budgetTokens}-token retained-context budget for a ${contextWindow}-token model`);
    }

    const statusText = `Jev compaction: kept ${record.kept}, truncated ${record.truncated}, dropped ${record.dropped.length} of ${record.candidateCalls} calls (${(record.reductionRatio * 100).toFixed(0)}% reduction of the whole context, ~${record.summaryTokens} of ${budget.budgetTokens} budget tokens)`;
    console.error(`[fm-jev-compaction] ${statusText}`);
    ctx.ui?.setStatus?.("jev-compaction", statusText);

    const compaction: OmpCompactionResult = {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      fromExtension: true,
      preserveData: { jevCompaction: record },
    };
    return { compaction };
  });
  loaded.add(pi.events);
}

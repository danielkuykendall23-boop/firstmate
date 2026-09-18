// Optional Jev-guided compaction for omp (Oh My Pi).
//
// Off by default. Set FM_JEV_COMPACTION=1 to activate this extension's
// session_before_compact handler; otherwise it registers and immediately
// no-ops, so omp's own compaction.methodOrder and compaction.thresholdTokens
// (verified live in this environment as ["remote","handoff","snapcompact",
// "shake","soft"] and 550000 respectively - see docs/jev-compaction.md
// "Verified against a real omp session") are never touched by a default
// launch. This never writes to a captain's ~/.omp/agent/config.yml.
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
// live omp 18.2.5 (docs/jev-compaction.md): a disposable synthetic session
// with a probe hook dumped the real session_before_compact event, which is
// exactly { type, preparation: { firstKeptEntryId, messagesToSummarize,
// turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps,
// settings }, branchEntries, signal }, and omp's real assistant message
// content carries { type: "toolCall", id, name, arguments, intent } blocks
// with a *separate* { role: "toolResult", toolCallId, toolName, content,
// details, isError } message - not the vendored library's own Message shape.
//
// A dropped call/result is omitted from the rendered summary with no recall
// marker there (the vendored applyDecisions' own documented behavior,
// corrected in data/env-jev-repo-integration/report.md's second pass), but
// the original journal entries themselves are untouched disk state that omp
// already keeps regardless of method, and every decision (kept/truncated/
// dropped, by omp tool-call id) is written to preserveData.jevCompaction for
// audit, straight from the vendored library's own result.decisions/stats. On
// any failure - missing key, network error, malformed Jev response, or a
// reduction ratio below FM_JEV_MIN_REDUCTION_RATIO - this returns undefined
// and visibly notifies a native-fallback status; it never reports Jev
// success when Jev did not run.
import {
  compact,
  JevClient,
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

export type OmpCompactionResult = {
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

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MIN_REDUCTION_RATIO = 0.25;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function blockText(blocks: OmpContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
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
    if (message.role === "toolResult") {
      resultByCallId.set(message.toolCallId, { text: blockText(message.content), isError: message.isError ?? false });
    }
  }

  const out: LibMessage[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      // omp represents a tool result as its own message; the library expects
      // toolResults[] attached to *some* message. A synthetic carrier keeps
      // it at its real position, and collectToolCalls pairs by tool_use_id
      // regardless of which message carries it.
      const result: LibToolResult = { tool_use_id: message.toolCallId, text: blockText(message.content), isError: message.isError ?? false };
      out.push({ role: "user", text: "", toolUses: [], toolResults: [result] });
      continue;
    }
    const toolUses: LibToolUse[] = [];
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const paired = resultByCallId.get(block.id);
      const toolUse: LibToolUse = { tool_use_id: block.id, tool: block.name, input: block.arguments };
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
    out.push({ role: message.role, text: blockText(message.content), toolUses });
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

export function auditFromResult(model: string, keepThreshold: number, result: CompactResult): JevCompactionAudit {
  const reductionRatio = result.stats.charsBefore > 0 ? 1 - result.stats.charsAfter / result.stats.charsBefore : 0;
  const dropped = result.decisions.filter((d) => d.action === "drop_call").map((d) => d.id);
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
    reductionRatio,
  };
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

export function buildFilesTag(fileOps: OmpFileOps): string {
  const read = Object.keys(fileOps.read ?? {});
  const written = new Set([...Object.keys(fileOps.written ?? {}), ...Object.keys(fileOps.edited ?? {})]);
  const readOnly = read.filter((p) => !written.has(p));
  const entries = [...readOnly.map((p) => `${p} (Read)`), ...[...written].map((p) => `${p} (Write)`)].slice(0, 20);
  if (entries.length === 0) return "";
  return `<files>\n${entries.join("\n")}\n</files>`;
}

// ---- Top-level: run the real vendored compact() against one omp region. ----

export type JevRegionOptions = CompactOptions & { apiKey: string; model?: string; fetchImpl?: typeof fetch };
export type JevRegionResult = { text: string; audit: JevCompactionAudit };

export async function compactOmpRegion(messages: readonly OmpMessage[], options: JevRegionOptions): Promise<JevRegionResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const keepThreshold = options.keepThreshold ?? 0.5;
  const asker = new JevClient({ apiKey: options.apiKey, model, fetch: options.fetchImpl });
  const libMessages = toLibraryMessages(messages);
  // The region omp hands the hook is already scoped to "not recent"; a
  // second preserveRecentMessages layer inside it would wrongly re-protect
  // its own tail, so this always compacts the whole given region.
  const result = await compact(libMessages, asker, { ...options, preserveRecentMessages: 0 });
  return { text: renderLibraryMessages(result.messages), audit: auditFromResult(model, keepThreshold, result) };
}

// ---- Extension wiring. ----

// Both channels are verified visible against a real omp 18.2.5 process
// (docs/jev-compaction.md "Verified against a real omp session"):
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
  pi.on("session_before_compact", async (rawEvent: unknown, ctx: HookContext) => {
    if (process.env.FM_JEV_COMPACTION !== "1") return undefined;

    const event = rawEvent as SessionBeforeCompactEvent;
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) return fallback(ctx, "TYPESAFE_API_KEY unset");

    const historyRegion = event.preparation.messagesToSummarize;
    const turnPrefixRegion = event.preparation.isSplitTurn ? event.preparation.turnPrefixMessages : [];
    if (historyRegion.length === 0 && turnPrefixRegion.length === 0) return undefined; // nothing to summarize: let omp handle it

    const options: JevRegionOptions = {
      apiKey,
      model: process.env.TYPESAFE_MODEL || DEFAULT_MODEL,
      keepThreshold: envNumber("FM_JEV_KEEP_THRESHOLD", 0.5),
      truncateHeadChars: envNumber("FM_JEV_TRUNCATE_HEAD_CHARS", 300),
      maxStateTokens: envNumber("FM_JEV_MAX_STATE_TOKENS", 25000),
      maxRequestTokens: envNumber("FM_JEV_MAX_REQUEST_TOKENS", 30000),
    };
    const minReductionRatio = envNumber("FM_JEV_MIN_REDUCTION_RATIO", DEFAULT_MIN_REDUCTION_RATIO);

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

    if (merged.audit.candidateCalls > 0 && merged.audit.reductionRatio < minReductionRatio) {
      return fallback(ctx, `reduction ${(merged.audit.reductionRatio * 100).toFixed(0)}% below minimum`);
    }

    const filesTag = buildFilesTag(event.preparation.fileOps);
    const summary = filesTag ? `${merged.text}\n\n${filesTag}` : merged.text;

    const statusText = `Jev compaction: kept ${merged.audit.kept}, truncated ${merged.audit.truncated}, dropped ${merged.audit.dropped.length} of ${merged.audit.candidateCalls} calls (${(merged.audit.reductionRatio * 100).toFixed(0)}% reduction)`;
    console.error(`[fm-jev-compaction] ${statusText}`);
    ctx.ui?.setStatus?.("jev-compaction", statusText);

    const compaction: OmpCompactionResult = {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      fromExtension: true,
      preserveData: { jevCompaction: merged.audit },
    };
    return { compaction };
  });
}

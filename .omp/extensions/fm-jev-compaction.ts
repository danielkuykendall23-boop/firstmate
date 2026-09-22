// Optional Jev-guided compaction for omp (Oh My Pi).
//
// Off by default. Set FM_JEV_COMPACTION=1 in the environment that launches
// omp to register this extension's session_before_compact handler;
// otherwise the default export returns without registering anything, so
// omp sees no compaction hook at all. That matters beyond the handler: omp
// disables its speculative (background) compaction whenever any
// session_before_compact handler exists, so a default launch must leave it
// with none, and omp's own compaction.methodOrder and
// compaction.thresholdTokens (verified live in this environment as
// ["remote","handoff","snapcompact","shake","soft"] and 550000 respectively
// - see docs/jev-compaction.md "Verified against a real omp session") are
// never touched by a default launch. This never writes to a captain's
// ~/.omp/agent/config.yml.
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
// itself, runs instead.
//
// A dropped call/result is omitted from the rendered summary with no recall
// marker there (the vendored applyDecisions' own documented behavior), but
// the original journal entries themselves are untouched disk state that omp
// already keeps regardless of method, and every decision (kept/truncated/
// dropped, by omp tool-call id) is written to preserveData.jevCompaction for
// audit, straight from the vendored library's own result.decisions/stats. On
// any failure - missing key, network error, malformed Jev response, a
// whole-context character reduction below MIN_REDUCTION_RATIO, or a
// replacement above omp's own native summary token cap - this returns
// undefined and visibly notifies a native-fallback status; it never reports
// Jev success when Jev did not run.
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
// anything is sent, the handler reads `secrets.enabled` from the config.yml
// files omp itself layers - the agent directory's (PI_CODING_AGENT_DIR, else
// ~/.omp/agent) and the project's .omp/config.yml - and declines when it is
// on, or when a file exists that it cannot read or follow, so a region omp
// would redact never reaches Jev un-redacted. A `--config` overlay or
// `--config-override` flag is not visible here; docs/jev-compaction.md
// "Activation" states that limit.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectToolCalls,
  compact,
  estimateTokens,
  JevClient,
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

type HookContext = {
  ui?: HookUiContext;
  cwd?: string;
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

// omp's compaction settings as the hook receives them; reserveTokens is the
// one field the native summary cap below depends on.
export type OmpCompactionSettings = {
  reserveTokens?: number;
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
// complete replacement (carried previous summary included) with omp's own
// summary cap beside the estimated size of what was installed.
export type JevCompactionRecord = JevCompactionAudit & {
  previousSummaryChars: number;
  summaryTokens: number;
  summaryTokenCap: number;
};

const JEV_MODEL = "jev-latest";
const MIN_REDUCTION_RATIO = 0.25;
const FILES_TAG_LIMIT = 20;
// omp 18.2.5 caps every native summary at
// min(floor(0.8 * compaction.reserveTokens), MAX_SUMMARY_TOKENS), with the
// default reserve and MAX_SUMMARY_TOKENS both 16384.
const NATIVE_MAX_SUMMARY_TOKENS = 16384;
const NATIVE_DEFAULT_RESERVE_TOKENS = 16384;

const extensionFile = fileURLToPath(import.meta.url);
const root = resolve(dirname(extensionFile), "../..");

function fmHome(): string {
  return process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root;
}

/**
 * The one-key .env read of bin/fm-env-lib.sh's fmx_env_get: the last
 * `KEY=` assignment wins, a leading `export ` and surrounding whitespace are
 * tolerated, one layer of matching quotes is stripped, and an absent file or
 * key yields "".
 */
export function envFileValue(file: string, key: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
  let value = "";
  for (const line of text.split(/\r?\n/)) {
    const match = assignment.exec(line);
    if (match) value = match[1].trim();
  }
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    value = value.slice(1);
    if (value.endsWith(quote)) value = value.slice(0, -1);
  }
  return value;
}

function resolveApiKey(): string {
  return process.env.TYPESAFE_API_KEY || envFileValue(`${fmHome()}/.env`, "TYPESAFE_API_KEY");
}

// ---- omp's Hide Secrets switch, read from the config files omp layers. ----

function ompAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

/** The config.yml files omp reads, in omp's own layering order: the agent directory's, then the project's. */
export function ompConfigFiles(agentDir: string, cwd: string): string[] {
  const global = [join(agentDir, "config.yml"), join(agentDir, "config.yaml")];
  return [global.find((file) => existsSync(file)) ?? global[0], join(cwd, ".omp", "config.yml")];
}

type YamlMappingLine = { indent: number; key: string; value: string };

// null: a line that is not a plain `key: value` mapping line (list item,
// continuation); undefined: blank, comment, or document marker.
function yamlMappingLine(raw: string): YamlMappingLine | null | undefined {
  const line = raw.replace(/(^|\s)#.*$/, "");
  if (line.trim() === "" || /^\s*(---|\.\.\.)\s*$/.test(line)) return undefined;
  const match = /^["']?([A-Za-z0-9_.-]+)["']?\s*:(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { indent: line.length - line.trimStart().length, key: match[1], value: (match[2] ?? "").trim() };
}

function yamlBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * omp's `secrets.enabled` as one config.yml states it: the boolean when the
 * file spells it plainly (a top-level `secrets:` block with an `enabled:`
 * key, or a flat `secrets.enabled:` key; the last statement wins), false
 * when the file says nothing about it, and undefined when it is written in
 * a form this reader does not follow (a flow mapping, an alias, a quoted or
 * non-boolean value), so the caller fails closed rather than guessing.
 */
export function secretsEnabledInConfig(text: string): boolean | undefined {
  let enabled = false;
  let block: { indent: number; childIndent?: number } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = yamlMappingLine(raw);
    if (line === undefined) continue;
    if (block && line !== null && line.indent <= block.indent) block = undefined;
    if (block) {
      if (line === null) continue;
      block.childIndent ??= line.indent;
      if (line.indent === block.childIndent && line.key === "enabled") {
        const value = yamlBoolean(line.value);
        if (value === undefined) return undefined;
        enabled = value;
      }
      continue;
    }
    if (line === null || line.indent !== 0) continue;
    if (line.key === "secrets") {
      if (line.value !== "") return undefined;
      block = { indent: line.indent };
    } else if (line.key === "secrets.enabled") {
      const value = yamlBoolean(line.value);
      if (value === undefined) return undefined;
      enabled = value;
    }
  }
  return enabled;
}

export type HideSecretsState = { state: "off" } | { state: "on" | "unreadable"; file: string };

/** Hide Secrets across omp's layered config files: a later file that states the switch overrides an earlier one, as in omp; an unreadable or unfollowable file wins outright. */
export function hideSecretsState(files: readonly string[]): HideSecretsState {
  let on: string | undefined;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { state: "unreadable", file };
    }
    const enabled = secretsEnabledInConfig(text);
    if (enabled === undefined) return { state: "unreadable", file };
    if (enabled) on = file;
    else if (/^\s*secrets(\.enabled)?\s*:/m.test(text)) on = undefined;
  }
  return on ? { state: "on", file: on } : { state: "off" };
}

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

/** omp's own bound on a native summary, applied here to the complete replacement Jev would install. */
export function nativeSummaryTokenCap(settings: OmpCompactionSettings): number {
  return Math.min(Math.floor(0.8 * (settings.reserveTokens ?? NATIVE_DEFAULT_RESERVE_TOKENS)), NATIVE_MAX_SUMMARY_TOKENS);
}

/**
 * The region audit re-measured as installed: the carried previous summary
 * counts on both sides of the reduction, so a small region that shrank a lot
 * cannot pass once the verbatim carry dominates, and the whole replacement's
 * estimated size stands beside the native cap it must fit.
 */
export function installedRecord(audit: JevCompactionAudit, previousSummary: string, summary: string, settings: OmpCompactionSettings): JevCompactionRecord {
  const previousSummaryChars = previousSummary.length;
  return {
    ...audit,
    previousSummaryChars,
    reductionRatio: reduction(previousSummaryChars + audit.charsBefore, previousSummaryChars + audit.charsAfter),
    summaryTokens: estimateTokens(summary),
    summaryTokenCap: nativeSummaryTokenCap(settings),
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

export type JevRegionOptions = CompactOptions & { apiKey: string; fetchImpl?: typeof fetch };
export type JevRegionResult = { text: string; audit: JevCompactionAudit };

export async function compactOmpRegion(messages: readonly OmpMessage[], options: JevRegionOptions): Promise<JevRegionResult> {
  const asker = new JevClient({ apiKey: options.apiKey, model: JEV_MODEL, fetch: options.fetchImpl });
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
  if (process.env.FM_JEV_COMPACTION !== "1") return;

  pi.on("session_before_compact", async (rawEvent: unknown, ctx: HookContext) => {
    const event = rawEvent as SessionBeforeCompactEvent;

    const hideSecrets = hideSecretsState(ompConfigFiles(ompAgentDir(), ctx.cwd ?? process.cwd()));
    if (hideSecrets.state === "on") return fallback(ctx, `omp Hide Secrets is on in ${hideSecrets.file} and the hook receives the un-redacted region`);
    if (hideSecrets.state === "unreadable") return fallback(ctx, `omp Hide Secrets could not be read from ${hideSecrets.file}`);

    const apiKey = resolveApiKey();
    if (!apiKey) return fallback(ctx, "TYPESAFE_API_KEY unset");

    const historyRegion = event.preparation.messagesToSummarize;
    const turnPrefixRegion = event.preparation.isSplitTurn ? event.preparation.turnPrefixMessages : [];
    if (historyRegion.length === 0 && turnPrefixRegion.length === 0) return undefined; // nothing to summarize: let omp handle it

    const nativeHistory = unretainableNativeHistory(event.preparation.previousPreserveData);
    if (nativeHistory) return fallback(ctx, `the previous compaction's ${nativeHistory} history cannot be carried by a text-only summary`);

    const options: JevRegionOptions = { apiKey };

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

    const previousSummary = event.preparation.previousSummary ?? "";
    const filesTag = buildFilesTag(event.preparation.fileOps);
    const text = mergePreviousSummary(previousSummary, merged.text);
    const summary = filesTag ? `${text}\n\n${filesTag}` : text;
    const record = installedRecord(merged.audit, previousSummary, summary, event.preparation.settings);

    if (record.reductionRatio < MIN_REDUCTION_RATIO) {
      return fallback(ctx, `reduction ${(record.reductionRatio * 100).toFixed(0)}% of the whole context below minimum`);
    }
    if (record.summaryTokens > record.summaryTokenCap) {
      return fallback(ctx, `replacement of ~${record.summaryTokens} tokens exceeds omp's ${record.summaryTokenCap}-token summary cap`);
    }

    const statusText = `Jev compaction: kept ${record.kept}, truncated ${record.truncated}, dropped ${record.dropped.length} of ${record.candidateCalls} calls (${(record.reductionRatio * 100).toFixed(0)}% reduction of the whole context, ~${record.summaryTokens} of ${record.summaryTokenCap} tokens)`;
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
}

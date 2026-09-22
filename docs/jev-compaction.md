# Jev-guided compaction for omp (Oh My Pi)

`.omp/extensions/fm-jev-compaction.ts` is an optional, off-by-default omp extension that lets TypeSafe's Jev model choose which old tool calls and tool results a compaction can drop, instead of an LLM-written paraphrase losing that detail silently.
It is a thin omp-side adapter around the real, pinned upstream decision algorithm, not a reimplementation of it.
`.omp/extensions/vendor/fast-jev-compaction/` is a verbatim copy of [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)'s own harness-agnostic `src/` library (MIT, commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`), with one mechanical, fully documented import-extension patch so Node's native TypeScript loader can resolve it; see `.omp/extensions/vendor/fast-jev-compaction/NOTICE.md` for the exact patch, the pinned archive's sha256, and what upstream code is deliberately not vendored (their Claude Code-only `hooks/` plugin, tests, and demo assets).
Every actual decision - state fitting, batching, the keep/drop rule, `applyDecisions`' verbatim rendering and pairing guarantee - runs as the real vendored `compact()` export, not a port of it.
Upstream's own plugin cannot run under omp as-is: it is built on Claude Code's early-access `hooks.json`/`SessionMessage` function-hook API, which omp's hook and extension loader never reads, so only the library is reusable and the adapter described below supplies the omp-side translation.

## Scope: the three Jev repositories

This change covers the three Jev-related repositories that were assessed together, and records each one's disposition here so the reasoning stays with the code:

- [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction): adopted as the vendored library plus the omp adapter this document describes.
- [`NiazMorshed2007/jev-review`](https://github.com/NiazMorshed2007/jev-review): adopted as a vendored, on-demand MCP server behind a reversible user-scope installer (see "Optional: Jev Review" below), never as a review gate.
- [`lahfir/agent-desktop`](https://github.com/lahfir/agent-desktop): no repository integration.
  It is a standalone native macOS accessibility engine plus the hosted `jev-desktop` skill, used as a plain CLI and skill from a user-scope install rather than as anything omp or this repository wires; earlier work already installed and natively smoke-tested it at user scope, so this change neither re-installs nor duplicates it.
  Its live Jev decisions need the same `TYPESAFE_API_KEY` this extension reads.

All three call the same TypeSafe endpoint, but the environment variable name is not uniform: `agent-desktop` and `fast-jev-compaction` read `TYPESAFE_API_KEY`, while `jev-review` reads `JEV_API_KEY`; a setup using more than one needs each name set to the same key.
Both newly vendored projects are young (created the day before they were assessed, with single-author commit histories), which is a maturity flag to keep in mind, not a defect.

## Setup

Off by default.
Set `FM_JEV_COMPACTION=1` in the environment that launches omp to register the extension's `session_before_compact` handler; otherwise the extension registers no hook at all.
That matters beyond the handler itself: omp disables its speculative (background) compaction whenever any `session_before_compact` handler exists, so a default launch must leave omp with none, and a captain's `compaction.methodOrder`, `compaction.thresholdTokens`, and background compaction are all untouched by a default launch.
This never writes to `~/.omp/agent/config.yml`.

Requires:

- `TYPESAFE_API_KEY`, either in the environment that launches omp or as a `TYPESAFE_API_KEY=` line in the home's gitignored `.env`.
  This is the same file and the same one-key read rule as "Typed dispatch resolution" in `docs/configuration.md`: the environment wins, the last assignment in the file wins, a leading `export` and one layer of matching quotes are tolerated, and the value is never logged.
  The extension resolves the home as `FM_HOME`, else `FM_ROOT_OVERRIDE`, else the repository root that holds `.omp/extensions/`, matching the other omp extensions here.
  Absent in both places: the extension returns a native-fallback result and never claims Jev ran; see "Verified against a real omp session" below.
- Node 24+ (omp's own extension loader), no build step.

There is no tuning surface.
The adapter runs the vendored library at its own defaults (`jev-latest`, keep threshold 0.5, 300 characters kept from a truncated result, 25000 state tokens, 30000 request tokens) and requires two things of the complete replacement it would install - the carried previous summary plus the new region's Jev-pruned text and `<files>` block - before using it: an estimated reduction of at least 25% measured over the whole context (previous summary plus region, before and after), and an estimated size within omp's own native summary cap, `min(floor(0.8 * compaction.reserveTokens), 16384)` tokens, the same bound omp applies to every native summary.
Anything else falls back to native compaction, which rewrites and bounds the whole context, so the installed summary can never grow without bound across compactions.

### Activation in the captain environment

The shared code stays opt-in on purpose: every Jev compaction sends the region's message text and tool inputs to a third-party API, so no Firstmate user's transcripts leave their machine without that user's own explicit step.
Activating it for one home means three things: put a `TYPESAFE_API_KEY=` line in that home's `.env` (or export the variable where omp is launched), export `FM_JEV_COMPACTION=1` in the environment that launches omp, and start a new omp session.
At the time of this change no authorized TypeSafe key with usable entitlement was provisioned for the captain environment, so the extension is wired and tested but not yet active there; the deployment is complete only once such a key exists and a real session has been observed compacting through it.
This covers omp only.
The Pi and Claude Code primaries this repository also runs keep their harnesses' native compaction; nothing here changes them.

## What it actually changes

omp's `session_before_compact` hook is boundary-plus-summary, not per-item surgery: it can only replace the *summary text* for the region omp already decided to discard (`preparation.messagesToSummarize`, plus `preparation.turnPrefixMessages` on a split turn), ending at the `firstKeptEntryId` boundary omp itself already chose.
`preparation.recentMessages`, after that boundary, are never touched by any compaction method, Jev-guided or native.
The original journal entries for the summarized region are never deleted from disk by omp itself, regardless of method: only the rebuilt LLM context stops including them.

So the adapter's job is exactly the part the vendored library cannot supply on its own: `toLibraryMessages` translates omp's real `toolCall`-block-plus-separate-`toolResult`-message wire shape into the vendored library's own `Message`/`ToolUse`/`ToolResult` shape, `compactOmpRegion` calls the real vendored `compact()` against that translation, and `renderLibraryMessages` walks the library's own pruned `Message[]` result back into the plain summary text omp's contract actually accepts.
The region omp hands over also carries pi's other message kinds - an extension-injected `custom` message whose content may be a bare string (this repository's own turn-end guard sends one at every session start), `!cmd` bash and python executions with no content at all, and branch summaries carrying only `summary` - and `toLibraryMessages` flattens each of them into user-role text the way pi's own `convertToLlm` does, so a real firstmate session's first compaction does not throw before Jev is ever asked.
It also applies that conversion's exclusion rule exactly: an execution flagged `excludeFromContext` (the `!!cmd` form omp offers to keep a command's output out of the model) is omitted entirely, so nothing omp already keeps out of the model's context is sent to TypeSafe or installed in the summary.
For every tool call/result pair in the region omp already discards, the vendored library asks Jev two `noul` questions (keep the call, keep the result verbatim), then `applyDecisions` truncates or drops content in place; the adapter only renders what the library already decided, with no decision logic of its own.
A dropped call/result is omitted from the rendered summary with no recall marker there, matching upstream's own documented behavior; this is "omitted from the returned summary text," not a claim about disk-level journal survival, which omp already guarantees independently of this extension.
`auditFromResult` copies every decision - kept, truncated, or dropped, with each dropped call recorded by omp's own `toolCall` id, mapped back from the vendored library's per-run `t1`, `t2`, ... ids through the same deterministic `collectToolCalls` pairing - plus the before/after character totals straight from the vendored library's own `result.decisions`/`result.stats` into `preserveData.jevCompaction` on the compaction entry, for later audit against the journal.
`mergeSplitTurnSummary` gives a split turn two separate Jev passes (one per region), merged with the same `**Turn Context (split turn):**` section header omp's own native split-turn summaries use; `mergeAudits` measures the combined reduction over the summed character totals of both regions, so a large text-only history cannot be passed off by a small prefix that shrank a lot.
An earlier compaction's summary never sits in the region omp hands over: omp converts compaction entries out of `messagesToSummarize`, passes the newest one as `preparation.previousSummary`, and afterwards reads only the newest compaction entry when it rebuilds context, so a handler that ignored it would silently discard everything the first Jev compaction kept.
`mergePreviousSummary` therefore prepends it verbatim, under a `**Later history:**` divider, ahead of the new region's summary - the same merge every native method performs in its own way (pi's update prompt wraps it in `<previous-summary>`, omp's snapcompact prepends `[Summary of earlier history]`).
Because each Jev summary is verbatim rather than paraphrased, the carried text is opaque to every later Jev pass, so both gates in "Setup" are measured over the complete replacement rather than the new region alone: once the carried summary dominates, or the replacement would exceed omp's native summary cap, the handler falls back and native compaction rewrites and bounds the whole thing.
`preserveData.jevCompaction` records the previous summary's character count, the estimated replacement tokens, and the cap used, beside the region's own before/after totals and decisions.
`buildFilesTag` appends the same `<files>` block omp's native summaries carry (one sorted `path (Read|Write)` line each, elided past 20), built from the `Set<string>` fields of omp's `preparation.fileOps`; omp only carries file operations forward from its own native compaction entries, so this block in the summary text is what preserves them across a Jev compaction.

On any failure - missing key, network error, malformed Jev response, a whole-context reduction below 25%, or a replacement above omp's native summary cap - the extension returns `undefined`, omp's own `compaction.methodOrder` runs unmodified, and the fallback is visibly logged (see next section).
It never reports Jev success when Jev did not run.

## Verified against a real omp session

Every claim above about the live `session_before_compact` contract, and the fallback's visibility, was checked against a real omp 18.2.5 process, not just read from documentation, using a disposable synthetic session (`--no-session`, `--mode rpc`) in an isolated scratch directory - no captain data, no real project.

- A probe hook capturing the raw event confirmed the shape used throughout this file: `{ type, preparation: { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps, settings }, branchEntries, signal }`.
  `preparation.settings` in this environment reported `methodOrder: ["remote","handoff","snapcompact","shake","soft"]` and `thresholdTokens: 550000` - the exact live, preserved settings this port never touches.
- The same probe confirmed omp's real message wire shape differs from the Claude Code `SessionMessage` shape the upstream plugin assumes: an assistant `toolCall` content block carries `{ type, id, name, arguments, intent }`, and its result is a *separate* message `{ role: "toolResult", toolCallId, toolName, content, details, isError }` - not `toolUses[]`/`toolResults[]` arrays keyed by `tool_use_id` on one message.
- Loading the vendored-library-backed extension with `FM_JEV_COMPACTION` unset produced zero `extension_error` events and a normal `get_state` response, confirming the default-off path loads cleanly.
  That probe only checked for errors; the stronger default-off guarantee, that no `session_before_compact` handler is registered at all (the condition omp checks before arming speculative compaction), is asserted by `tests/fm-jev-compaction.node.test.ts` against the extension's real default export.
- Driving the same extension with `FM_JEV_COMPACTION=1` and no `TYPESAFE_API_KEY` against a real (synthetic-content) session showed the RPC `compact` command still succeeding via native `remote` compaction, with the raw combined output containing all three fallback signals: the `console.error` line on stderr, an `extension_ui_request` frame with `method: "setStatus"` and `statusText: "Jev compaction skipped (TYPESAFE_API_KEY unset) - using native compaction"`, and a second frame with `method: "notify"` and the matching message - confirming the fallback is visible on every channel this extension writes to, headlessly over RPC, with no extension error and no false claim of Jev success.

No live Jev inference (an actual `noul`/`choice`/`score` decision from TypeSafe) was exercised for this change: `TYPESAFE_API_KEY` was absent throughout, by design, because no private transcript leaves the machine before an authorized key exists.
The decision/rendering pipeline itself is covered by `tests/fm-jev-compaction.node.test.ts` against a fake `fetch` and the real vendored `compact()`, including the end-to-end keep/truncate/drop flow, a pairing-guarantee case proving a call is never orphaned from its result, and the registered handler driven exactly as omp drives it: the message-shape flattening and `excludeFromContext` omission above (asserted on both the Jev request body and the installed summary), the previous summary being carried forward, repeated compaction (a dominating carried summary or an over-cap replacement falling back to native, and the same replacement installed once within the cap), a disabled launch registering no hook, the zero-tool-call region falling back rather than becoming its own summary, the `.env` key read with the environment winning, the `<files>` block from `Set` file operations, and the split-turn character gate.

## Optional: Jev Review, on demand, never a gate

[`NiazMorshed2007/jev-review`](https://github.com/NiazMorshed2007/jev-review) (MIT, commit `57690af54ef7d862c2483342c1e61c14dffcf727`) is a separate, local stdio MCP server exposing one `jev_review` tool: a repeated scalar code-quality score loop the *implementing agent* may call on its own diff mid-task.
`.omp/vendor/jev-review/` is upstream's own pinned build artifact (`dist/server.js`, unmodified; see `NOTICE.md` in that directory for provenance and the archive sha256), so opting in never requires a network fetch or a local build step.
It is not wired into this repository's own MCP configuration and is not part of no-mistakes: `AGENTS.md` section 7 is explicit that no-mistakes alone owns review, fixes, tests, and CI, and this stays consistent with that by never becoming a second mandatory review gate.
MCP tools are called at the agent's own discretion, never automatically, so registering the server only makes `jev_review` available; nothing invokes it.

A captain or crewmate who wants it as a personal, on-demand tool opts in with the reversible installer, at the user level only:

```sh
bin/fm-jev-review-setup.sh install     # registers the vendored server in ~/.omp/agent/mcp.json
bin/fm-jev-review-setup.sh status      # reports whether it is currently registered
bin/fm-jev-review-setup.sh uninstall   # removes exactly the entry install added, nothing else
export JEV_API_KEY=...                 # note: a different env var name than TYPESAFE_API_KEY above
```

The installer only ever writes the user-scope `~/.omp/agent/mcp.json` (never a project's own `.omp/mcp.json`) and merges one `mcpServers["jev-review"]` entry into whatever is already there without disturbing other servers, so a repeat install is a no-op.
`uninstall` deletes only that entry, and only while it still equals what install writes, so every other server - including ones added after install, by hand or through omp's own MCP management - survives untouched; an entry somebody has since edited is left in place and reported instead, because deleting it would discard their change.
When only an empty `mcpServers` object would remain, `uninstall` removes the file, since an empty object configures nothing.
`tests/fm-jev-review-setup.test.sh` covers install/uninstall/status against isolated fixture config files, including a server added after install surviving uninstall and an edited entry being refused; no case ever touches the real `~/.omp/agent/mcp.json` on this host.

`jev-review` has no marketplace catalog, so it is not installable through `/marketplace add`; the manual MCP entry the installer writes is the same fallback shape its own README documents for OpenCode.

### Verified: omp itself discovers the vendored server, not just a hand-rolled probe

Beyond the server's own MCP handshake (a standalone stdio `initialize`/`tools/list` probe against the vendored `dist/server.js`, run with no key set and no `jev_review` call), omp's *own* MCP client was driven against the vendored server through the installer's real write target:

1. `bin/fm-jev-review-setup.sh install` was run with `FM_JEV_REVIEW_MCP_CONFIG` pointed at `<fake-home>/.omp/agent/mcp.json`, writing exactly the config a real `install` writes.
2. A real `omp --mode rpc --no-session` process was launched with `HOME=<fake-home>` and `--cwd` at an isolated project directory with no `.omp/mcp.json` of its own, so the only source of the `jev-review` server was that user-scope file.
3. `get_state`'s response came back with zero `extension_error` events, and its `systemPrompt` field listed the real tool as `xd://mcp__jev_review_jev_review — Run a scalar software-quality feedback loop over a focused implementation...` - the description text is jev-review's own tool schema, discovered and registered by omp's real MCP manager over a live stdio connection to the vendored `dist/server.js`, not read from any doc or asserted by this repository.

## Regression entry points

```sh
tests/fm-jev-compaction.test.sh
tests/fm-jev-review-setup.test.sh
```

`fm-jev-compaction.test.sh` runs `tests/fm-jev-compaction.node.test.ts` (Node's native TypeScript support, no build step - the same way omp itself loads the extension), covering the omp-message-shape translation, flattening, and excluded-execution omission, the previous-summary merge and its whole-context and native-cap gates across repeated compactions, the disabled launch registering nothing, verbatim rendering, the split-turn merge and its character-based gate, the audit/stats mapping, the `.env` key read, the `Set`-based `<files>` block, and full runs of the real vendored `compact()` and of the registered handler against a fake `fetch` - never contacting the real TypeSafe endpoint.
`fm-jev-review-setup.test.sh` covers the installer's install/status/uninstall behavior against isolated fixture config files, including preservation of servers added after install and refusal to delete an edited entry.

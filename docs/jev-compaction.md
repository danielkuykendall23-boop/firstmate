# Jev-guided compaction for omp (Oh My Pi)

`.omp/extensions/fm-jev-compaction.ts` is an optional, off-by-default omp extension that lets TypeSafe's Jev model choose which old tool calls and tool results a compaction can drop, instead of an LLM-written paraphrase losing that detail silently.
It is a thin omp-side adapter around the real, pinned upstream decision algorithm, not a reimplementation of it.
`.omp/extensions/vendor/fast-jev-compaction/` is a verbatim copy of [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)'s own harness-agnostic `src/` library (MIT, commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`), with one mechanical, fully documented import-extension patch so Node's native TypeScript loader can resolve it; see `.omp/extensions/vendor/fast-jev-compaction/NOTICE.md` for the exact patch, the pinned archive's sha256, and what upstream code is deliberately not vendored (their Claude Code-only `hooks/` plugin, tests, and demo assets).
Every actual decision - state fitting, batching, the keep/drop rule, `applyDecisions`' verbatim rendering and pairing guarantee - runs as the real vendored `compact()` export, not a port of it.
The assessment behind this adapter, including why upstream's own Claude Code plugin cannot run under omp as-is, lives in `data/env-jev-repo-integration/report.md`.

## Setup

Off by default.
Set `FM_JEV_COMPACTION=1` in the environment that launches omp to activate the extension's `session_before_compact` handler; otherwise it registers and immediately no-ops, so a captain's `compaction.methodOrder` and `compaction.thresholdTokens` are never touched by a default launch.
This never writes to `~/.omp/agent/config.yml`.

Requires:

- `TYPESAFE_API_KEY` in the environment (same variable `agent-desktop`'s `jev-desktop` scripts and upstream `fast-jev-compaction` use).
  Absent key: the extension returns a native-fallback result and never claims Jev ran; see "Verified against a real omp session" below.
- Node 24+ (omp's own extension loader), no build step.

Optional tuning, all matching upstream's own option names:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_MODEL` | `jev-latest` | Jev model name |
| `FM_JEV_KEEP_THRESHOLD` | `0.5` | Minimum keep probability |
| `FM_JEV_TRUNCATE_HEAD_CHARS` | `300` | Characters kept when a result is truncated, not dropped |
| `FM_JEV_MAX_STATE_TOKENS` | `25000` | Estimated token ceiling for one Jev request's state |
| `FM_JEV_MAX_REQUEST_TOKENS` | `30000` | Estimated ceiling for state plus one batch of questions |
| `FM_JEV_MIN_REDUCTION_RATIO` | `0.25` | Minimum estimated reduction required to use Jev's result instead of falling back |

## What it actually changes

omp's `session_before_compact` hook is boundary-plus-summary, not per-item surgery: it can only replace the *summary text* for the region omp already decided to discard (`preparation.messagesToSummarize`, plus `preparation.turnPrefixMessages` on a split turn), ending at the `firstKeptEntryId` boundary omp itself already chose.
`preparation.recentMessages`, after that boundary, are never touched by any compaction method, Jev-guided or native.
The original journal entries for the summarized region are never deleted from disk by omp itself, regardless of method: only the rebuilt LLM context stops including them.

So the adapter's job is exactly the part the vendored library cannot supply on its own: `toLibraryMessages` translates omp's real `toolCall`-block-plus-separate-`toolResult`-message wire shape into the vendored library's own `Message`/`ToolUse`/`ToolResult` shape, `compactOmpRegion` calls the real vendored `compact()` against that translation, and `renderLibraryMessages` walks the library's own pruned `Message[]` result back into the plain summary text omp's contract actually accepts.
For every tool call/result pair in the region omp already discards, the vendored library asks Jev two `noul` questions (keep the call, keep the result verbatim), then `applyDecisions` truncates or drops content in place; the adapter only renders what the library already decided, with no decision logic of its own.
A dropped call/result is omitted from the rendered summary with no recall marker there, matching upstream's own documented behavior (and the corrected framing in `data/env-jev-repo-integration/report.md`'s second pass: this is "omitted from the returned summary text," not a claim about disk-level journal survival, which omp already guarantees independently of this extension).
`auditFromResult` copies every decision - kept, truncated, or dropped, by tool-call id - straight from the vendored library's own `result.decisions`/`result.stats` into `preserveData.jevCompaction` on the compaction entry, for later audit.
`mergeSplitTurnSummary` gives a split turn two separate Jev passes (one per region), merged with the same `**Turn Context (split turn):**` section header omp's own native split-turn summaries use.

On any failure - missing key, network error, malformed Jev response, or a reduction ratio below `FM_JEV_MIN_REDUCTION_RATIO` - the extension returns `undefined`, omp's own `compaction.methodOrder` runs unmodified, and the fallback is visibly logged (see next section).
It never reports Jev success when Jev did not run.

## Verified against a real omp session

Every claim above about the live `session_before_compact` contract, and the fallback's visibility, was checked against a real omp 18.2.5 process, not just read from documentation, using a disposable synthetic session (`--no-session`, `--mode rpc`) in an isolated scratch directory - no captain data, no real project.

- A probe hook capturing the raw event confirmed the shape used throughout this file: `{ type, preparation: { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps, settings }, branchEntries, signal }`.
  `preparation.settings` in this environment reported `methodOrder: ["remote","handoff","snapcompact","shake","soft"]` and `thresholdTokens: 550000` - the exact live, preserved settings this port never touches.
- The same probe confirmed omp's real message wire shape differs from the Claude Code `SessionMessage` shape the upstream plugin assumes: an assistant `toolCall` content block carries `{ type, id, name, arguments, intent }`, and its result is a *separate* message `{ role: "toolResult", toolCallId, toolName, content, details, isError }` - not `toolUses[]`/`toolResults[]` arrays keyed by `tool_use_id` on one message.
- Loading the vendored-library-backed extension with `FM_JEV_COMPACTION` unset produced zero `extension_error` events and a normal `get_state` response, confirming the default-off path changes nothing about session startup.
- Driving the same extension with `FM_JEV_COMPACTION=1` and no `TYPESAFE_API_KEY` against a real (synthetic-content) session showed the RPC `compact` command still succeeding via native `remote` compaction, with the raw combined output containing all three fallback signals: the `console.error` line on stderr, an `extension_ui_request` frame with `method: "setStatus"` and `statusText: "Jev compaction skipped (TYPESAFE_API_KEY unset) - using native compaction"`, and a second frame with `method: "notify"` and the matching message - confirming the fallback is visible on every channel this extension writes to, headlessly over RPC, with no extension error and no false claim of Jev success.

No `jev_review`-equivalent live Jev inference (an actual `noul`/`choice`/`score` decision from TypeSafe) was exercised in this task: `TYPESAFE_API_KEY` was absent throughout, by design (see the ship spec in `data/env-jev-repo-integration/`).
The decision/rendering pipeline itself is covered by `tests/fm-jev-compaction.node.test.ts` against a fake `fetch` and the real vendored `compact()`, including the end-to-end keep/truncate/drop flow and a pairing-guarantee case proving a call is never orphaned from its result.

## Optional: Jev Review, on demand, never a gate

[`NiazMorshed2007/jev-review`](https://github.com/NiazMorshed2007/jev-review) (MIT, commit `57690af54ef7d862c2483342c1e61c14dffcf727`) is a separate, local stdio MCP server exposing one `jev_review` tool: a repeated scalar code-quality score loop the *implementing agent* may call on its own diff mid-task.
`.omp/extensions/vendor/jev-review/` is upstream's own pinned build artifact (`dist/server.js`, unmodified; see `NOTICE.md` in that directory for provenance and the archive sha256), so opting in never requires a network fetch or a local build step.
It is not wired into this repository's own MCP configuration and is not part of no-mistakes: `AGENTS.md` section 7 is explicit that no-mistakes alone owns review, fixes, tests, and CI, and this stays consistent with that by never becoming a second mandatory review gate.
MCP tools are called at the agent's own discretion, never automatically, so registering the server only makes `jev_review` available; nothing invokes it.

A captain or crewmate who wants it as a personal, on-demand tool opts in with the reversible installer, at the user level only:

```sh
bin/fm-jev-review-setup.sh install     # registers the vendored server in ~/.omp/agent/mcp.json
bin/fm-jev-review-setup.sh status      # reports whether it is currently registered
bin/fm-jev-review-setup.sh uninstall   # restores ~/.omp/agent/mcp.json to its exact state before install
export JEV_API_KEY=...                 # note: a different env var name than TYPESAFE_API_KEY above
```

The installer only ever writes the user-scope `~/.omp/agent/mcp.json` (never a project's own `.omp/mcp.json`), merges into whatever is already there without disturbing other servers, and snapshots the file's exact prior bytes (or its prior absence) before the first install so `uninstall` restores that exact prior state rather than merely deleting the added key.
`tests/fm-jev-review-setup.test.sh` covers install/uninstall/status against isolated fixture config files; no case ever touches the real `~/.omp/agent/mcp.json` on this host.

`jev-review` has no marketplace catalog, so it is not installable through `/marketplace add`; the manual MCP entry the installer writes is the same fallback shape its own README documents for OpenCode.

### Verified: omp itself discovers the vendored server, not just a hand-rolled probe

Beyond the server's own MCP handshake (a standalone stdio `initialize`/`tools/list` probe, in `data/env-jev-repo-integration/report.md`), omp's *own* MCP client was driven against the vendored server through the installer's real write target:

1. `bin/fm-jev-review-setup.sh install` was run with `FM_JEV_REVIEW_MCP_CONFIG` pointed at `<fake-home>/.omp/agent/mcp.json`, writing exactly the config a real `install` writes.
2. A real `omp --mode rpc --no-session` process was launched with `HOME=<fake-home>` and `--cwd` at an isolated project directory with no `.omp/mcp.json` of its own, so the only source of the `jev-review` server was that user-scope file.
3. `get_state`'s response came back with zero `extension_error` events, and its `systemPrompt` field listed the real tool as `xd://mcp__jev_review_jev_review — Run a scalar software-quality feedback loop over a focused implementation...` - the description text is jev-review's own tool schema, discovered and registered by omp's real MCP manager over a live stdio connection to the vendored `dist/server.js`, not read from any doc or asserted by this repository.

## Regression entry points

```sh
tests/fm-jev-compaction.test.sh
tests/fm-jev-review-setup.test.sh
```

`fm-jev-compaction.test.sh` runs `tests/fm-jev-compaction.node.test.ts` (Node's native TypeScript support, no build step - the same way omp itself loads the extension), covering the omp-message-shape translation, verbatim rendering, the split-turn merge, the audit/stats mapping, and one full run of the real vendored `compact()` against a fake `fetch` - never contacting the real TypeSafe endpoint.
`fm-jev-review-setup.test.sh` covers the installer's install/status/uninstall reversibility against isolated fixture config files.

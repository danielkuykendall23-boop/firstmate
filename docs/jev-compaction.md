# Jev-guided compaction for omp (Oh My Pi)

`.omp/extensions/fm-jev-compaction.ts` is an optional, off-by-default omp extension that lets TypeSafe's Jev model choose which old tool calls and tool results a compaction can drop, instead of an LLM-written paraphrase losing that detail silently.
It is a fresh port of the decision algorithm from [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) (MIT, commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`) against omp's own compaction contract, not a copy of that project's Claude Code-only plugin.
The assessment behind this port, including why the plugin itself cannot run under omp, lives in `data/env-jev-repo-integration/report.md`.

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

So this extension's contribution: for every tool call/result pair in the region omp already discards, ask Jev two `noul` questions (keep the call, keep the result verbatim), exactly as upstream, then render the *kept* text verbatim with dropped content replaced by a short note, never an LLM paraphrase of content that survives.
A dropped call/result is omitted from the rendered summary with no recall marker there, matching upstream's own documented behavior (and the corrected framing in `data/env-jev-repo-integration/report.md`'s second pass: this is "omitted from the returned summary text," not a claim about disk-level journal survival, which omp already guarantees independently of this extension).
Every decision - kept, truncated, or dropped, by tool-call id - is written to `preserveData.jevCompaction` on the compaction entry for later audit.
A split turn gets two separate Jev passes, merged with the same `**Turn Context (split turn):**` section header omp's own native split-turn summaries use.

On any failure - missing key, network error, malformed Jev response, or a reduction ratio below `FM_JEV_MIN_REDUCTION_RATIO` - the extension returns `undefined`, omp's own `compaction.methodOrder` runs unmodified, and the fallback is visibly logged (see next section).
It never reports Jev success when Jev did not run.

## Verified against a real omp session

Every claim above about the live `session_before_compact` contract, and the fallback's visibility, was checked against a real omp 18.2.5 process, not just read from documentation, using a disposable synthetic session (`--no-session`, `--mode rpc`) in an isolated scratch directory - no captain data, no real project.

- A probe hook capturing the raw event confirmed the shape used throughout this file: `{ type, preparation: { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, fileOps, settings }, branchEntries, signal }`.
  `preparation.settings` in this environment reported `methodOrder: ["remote","handoff","snapcompact","shake","soft"]` and `thresholdTokens: 550000` - the exact live, preserved settings this port never touches.
- The same probe confirmed omp's real message wire shape differs from the Claude Code `SessionMessage` shape the upstream plugin assumes: an assistant `toolCall` content block carries `{ type, id, name, arguments, intent }`, and its result is a *separate* message `{ role: "toolResult", toolCallId, toolName, content, details, isError }` - not `toolUses[]`/`toolResults[]` arrays keyed by `tool_use_id` on one message.
- Driving the extension with `FM_JEV_COMPACTION=1` and no `TYPESAFE_API_KEY` against a real (synthetic-content) session showed the RPC `compact` command still succeeding via native `remote` compaction, with `extension_ui_request` frames for both `setStatus` (`"Jev compaction skipped (TYPESAFE_API_KEY unset) - using native compaction"`) and `notify` actually present in the captured stream - confirming the fallback is visible even headlessly over RPC, with no extension error and no false claim of Jev success.
- Loading the extension with the flag unset produced zero `extension_error` events and a normal `get_state` response, confirming the default-off path changes nothing about session startup.

No `jev_review`-equivalent live Jev inference (an actual `noul`/`choice`/`score` decision from TypeSafe) was exercised in this task: `TYPESAFE_API_KEY` was absent throughout, by design (see the ship spec in `data/env-jev-repo-integration/`).
The decision/rendering pipeline itself is covered by `tests/fm-jev-compaction.node.test.ts` against a fake `fetch`, including the end-to-end keep/truncate/drop flow.

## Optional: Jev Review, on demand, never a gate

[`NiazMorshed2007/jev-review`](https://github.com/NiazMorshed2007/jev-review) (MIT) is a separate, local stdio MCP server exposing one `jev_review` tool: a repeated scalar code-quality score loop the *implementing agent* may call on its own diff mid-task.
It is not wired into this repository's own MCP configuration and is not part of no-mistakes: `AGENTS.md` section 7 is explicit that no-mistakes alone owns review, fixes, tests, and CI, and this stays consistent with that by never becoming a second mandatory review gate.

A captain or crewmate who wants it as a personal, on-demand tool opts in at the user level, not the project level:

```sh
git clone https://github.com/NiazMorshed2007/jev-review.git ~/some/path/jev-review
export JEV_API_KEY=...   # note: a different env var name than TYPESAFE_API_KEY above
```

Then add to `~/.omp/agent/mcp.json` (user scope only - never commit this to a project's `.omp/mcp.json`):

```json
{
  "mcpServers": {
    "jev-review": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/jev-review/dist/server.js"],
      "env": { "JEV_API_KEY": "JEV_API_KEY" }
    }
  }
}
```

`jev-review` has no marketplace catalog, so it is not installable through `/marketplace add`; the manual MCP entry above is the same fallback path its own README documents for OpenCode.
Full assessment, including a real stdio `initialize`/`tools/list` handshake against the committed server, in `data/env-jev-repo-integration/report.md`.

## Regression entry points

```sh
tests/fm-jev-compaction.test.sh
```

Runs `tests/fm-jev-compaction.node.test.ts` (Node's native TypeScript support, no build step - the same way omp itself loads the extension), covering token estimation, call pairing, the keep/truncate/drop decision rule, state fitting, batching, verbatim rendering, the files tag, the split-turn merge, and one full fake-fetch pipeline run.
None of it contacts the real TypeSafe endpoint.

# Jev in Firstmate OMP sessions

Firstmate uses TypeSafe's Jev for compaction and software-quality evaluation, and the installed Agent Desktop Jev operator for approved desktop work.
Model and effort routing is owned by [Typed dispatch resolution](configuration.md#typed-dispatch-resolution-env-typesafe_api_key); this integration never changes saved model defaults.
These extensions cover Firstmate and its OMP workers, not unrelated sessions, Pi, or native Claude Code.

## Key and activation

Provide `TYPESAFE_API_KEY` in the launching process environment or the owning Firstmate home's private `.env`, then start a new OMP session.
A resolved key automatically enables compaction and `jev_review`; without a key both factories register nothing, including no compaction hook, so native speculative compaction remains available.
`FM_JEV_COMPACTION=0` in the launching environment disables only Jev compaction.
No key is included in generated worker commands, task metadata, or logs, and the extension reader never exports a file credential into `process.env`.
The shared extension reader is `.omp/extensions/lib/fm-jev-key.ts`: a nonempty inherited value wins; otherwise the home is `FM_HOME`, then `FM_ROOT_OVERRIDE`, then the repository containing the extension.
Its one-key file parsing follows `bin/fm-env-lib.sh`: the last assignment wins, leading whitespace and `export` are tolerated, and surrounding quotes are stripped.
The desktop wrapper uses that existing shell accessor and gives the credential only to the Node child's environment.
OMP itself can load a project `.env` into its environment before extension discovery; that native behavior is not changed here.

`bin/fm-spawn.sh` explicitly loads the code root's compaction and review extensions for OMP ship/scout workers and supplies their owning `FM_HOME` path.
Secondmates keep their existing project discovery rather than additional extension flags.
Duplicate project and explicit copies register once per session, using OMP's shared event-bus identity; a disabled copy does not claim registration, and a reviewer child gets its own tool when factories are rebound.
The directory package `.omp/package.json` exposes exactly those two extensions and `.omp/agents/reviewer.md` to worker discovery without copying agent definitions into projects or global configuration.
Other worker runtimes and repository/profile settings are unchanged.

A local fake endpoint proves loading and protocol behavior without credentials.
It is not authenticated TypeSafe verification or proof of live inference quality.
An authorized key with usable credits and user-entered OMP login remain separate activation prerequisites; do not purchase credits or enter a secret on the user's behalf.
The extension key reader and OMP's built-in judge login are separate consumers of the same credential.

## Privacy and fallback

Compaction sends relevant history text and tool inputs/results; review sends the caller's task, focused diff, relevant file contents and repository context.
Previous review scores are used locally for deltas, not resubmitted to Jev.
Never supply secrets or unrelated private material.
The shared `.omp/extensions/lib/fm-jev-privacy.ts` gate preserves OMP's native effective `secrets.enabled` protection for both integrations.
The hook/tool receives raw input rather than OMP's provider-redacted request and has no native redaction helper.
Before any upload the gate asks the running OMP binary for the setting, in the session cwd and profile environment, and applies the launch `--config` overlays using the conservative rule in that module.
An enabled or unprovable setting refuses the upload: compaction falls back to native redacted compaction, and review reports unavailable and continues agent-led review.
An overlay mentioning secrets in a form the gate cannot establish also refuses; no second settings loader or secret scanner replaces OMP's owner.
When native protection is off, these extensions do not promise secret detection or add redaction.
Permission to send relevant code is not permission to send credentials.

Compaction failures visibly report native fallback through OMP UI status/notification and stderr without changing native method order.
Review input, network or response failures return an explicit unavailable result, never invented scores; upstream validation errors and raw response bodies are not printed because they can echo input.
The worker's review loop records unavailable Jev once and continues ordinary review.
A missing key makes the tool absent: OMP drops the unregistered name from the reviewer definition rather than failing the spawn, and the reviewer and worker instructions disclose the fallback.
Desktop failures pause Jev-driven actions instead of silently choosing another operator.
`FM_JEV_ENDPOINT` is solely a local-fake verification seam shared by compaction and review; leave it unset for real requests.

## Compaction boundaries

The adapter calls the real pinned [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) library; its source, MIT license and import patch provenance are under `.omp/extensions/vendor/fast-jev-compaction/`.
OMP's `session_before_compact` contract replaces the summary of the region OMP selected, not individual journal entries or the recent messages beyond `firstKeptEntryId`.
The original journal remains on disk; dropped calls are absent from the replacement summary, not deleted from the journal.
Translation preserves custom messages, execution messages and branch summaries, and omits `excludeFromContext` executions before upload or rendering.
The upstream library decides keep/truncate/drop and preserves tool call/result pairing; split turns receive separate passes and a combined audit.
An earlier Jev or text summary is prepended verbatim; file operations remain in the summary's bounded `<files>` block.
`preserveData.jevCompaction` records decisions by original tool-call id and the installed replacement's budget and reduction measurements.

Both acceptance checks cover the whole replacement, including carried history: at least 25% character reduction and a token estimate within the active model's retained-context budget.
The budget uses OMP's 80%-of-trigger progress ceiling after counting response reserve, recent messages and system prompt, not the native summary-text cap.
The trigger is bounded by the actual model context window; configuring 550000 never proves a smaller model accepts that many tokens.
The irreducible floor is checked before a request, so unprunable prose or carried history that cannot fit is not uploaded pointlessly.
The actual Jev result is checked again; verbatim prose is never truncated just to pass.
Unknown capacity, insufficient reduction, excess retained context, malformed responses, or service failure hand the complete region to native compaction.

Native `openaiRemoteCompaction` and `snapcompact` preserve substance outside summary text.
A text-only Jev result cannot carry that opaque history, so the adapter declines before upload whenever the previous compaction has either key.
Those methods retain their key in the newest entry, making that fallback last for the session unless a native method without such state subsequently succeeds; a fresh session can use Jev again.
An OpenAI session whose first fallback uses remote compaction therefore remains native afterwards.
This is deliberate history preservation, not a guarantee of Jev on every later compaction.
OMP may emit the same hook for multiple native method attempts, repeating local declines or a request whose result does not fit; this adapter does not cache a decline.
Manual and automatic compaction use the same hook and privacy checks.

## Review and improvement

`jev_review` is an in-process OMP tool backed by pinned [`jev-review`](https://github.com/NiazMorshed2007/jev-review) evaluation code.
`.omp/vendor/jev-review/NOTICE.md` owns provenance and reproducible bundling; the shipped evaluator includes upstream Zod and needs no install or separate server at runtime.
The tool takes `task`, `diff`, `files: [{path, content}]`, `repositoryContext`, and the previous complete result as `previousEvaluation`.
At least one substantive task, diff or file is required.
It returns the upstream evaluation JSON both as text and structured details: applicable dimensions with scores from 1 to 10, confidence, priorities, and local comparison deltas on a rescore.
Jev scores inform diagnosis; the agent still inspects code, identifies evidence-backed weaknesses, verifies fixes and decides its verdict.
No score dismisses a finding, authorizes an edit by a read-only reviewer, grants merge authority, or adds scope.

The `.omp/agents/reviewer.md` override preserves the bundled review criteria and tool restrictions, adds `jev_review`, and returns its evaluation through the optional `jev_evaluation` output field.
The implementing worker, not the reviewer, makes justified fixes.
`bin/fm-brief.sh` owns the ship-only improvement/rescore instructions and their stop condition; the section tells the worker it applies only inside an OMP session, and a ship worker in any other harness skips it silently with no Jev status line.
The loop runs before the selected delivery path starts; no-mistakes alone owns its branch and fixes after validation begins.
Scouts have desktop guidance but no ship improvement loop.
A previously configured external Jev server is not used by this tool; remove only that obsolete user-configured server entry before restarting, leaving unrelated servers unchanged.

## Desktop operation

`bin/fm-jev-desktop.sh --help` owns invocation, consent flags, installed-script resolution and exit status.
The wrapper calls the installed Agent Desktop Jev scripts, not another operator or a copied decision policy.
Load both installed `agent-desktop` and `jev-desktop` skills first.
The caller must already have approved access to the exact app and permission for its UI descriptions to reach TypeSafe before using the attestation flags.
Private documents, filled forms and credentials require a separate permission decision before observation.
`run` always adds `--no-values`; that suppresses field values, not accessible labels, window titles or text exposed in names.
Agent Desktop 0.9.2 `act` does not implement `--no-values`; the wrapper refuses that combination instead of silently exposing values under a false privacy promise.
Use it only when the visible content is authorized for transmission.
Use `run` only for bounded, already-authorized reversible goals; use `act` without `--execute` to inspect a potentially destructive step and obtain concrete permission before execution.
Jev's confidence/risk thresholds are not approval, and no destructive confirmation may be answered automatically.
The caller supplies entered text; native delivery/retry safety semantics and operator failure statuses remain intact.
No real private desktop content is used by the credential-free verification.

## Verification

[The Jev verification record](verification/jev.md) owns dated actual-runtime results, refresh commands and the pending authenticated checks.
Run `tests/fm-jev-compaction.test.sh` for compaction and review behavior, `tests/fm-jev-desktop.test.sh` for the wrapper contract, and the opt-in `tests/fm-jev-compaction-live-e2e.test.sh` for isolated real OMP execution against a loopback fake endpoint.
The live proof uses synthetic histories and a scripted local model for reviewer tool calls: it proves runtime integration and result handling, not an AI review's judgment.

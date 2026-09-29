# Jev integration verification

Audience: maintainer verification.

[The Jev operator guide](../jev.md) owns activation, privacy, fallback and desktop consent.
This record distinguishes installed-runtime proof with local fake responses from live authenticated inference.
The credential-free sections used no credentials, purchases, private desktop observations, primary restarts or global OMP setting changes.

## Credential-free OMP proof

Verified on 2026-09-22 on macOS arm64 with OMP 18.2.8.
The opt-in test uses a real OMP process, isolated HOME and agent directories, synthetic native session journals, a loopback System One endpoint and a scripted loopback model for reviewer tool calls.
The synthetic project is outside the Firstmate repository, so it cannot accidentally inherit the repository's reviewer by ancestor discovery.
It loads the `.omp` directory package with the same explicit extension shape used by OMP workers, alongside auto-discovered copies of both Jev extensions.

```sh
FM_JEV_COMPACTION_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-jev-compaction-live-e2e.test.sh
bin/fm-test-run.sh tests/fm-jev-compaction.test.sh tests/fm-jev-desktop.test.sh tests/fm-brief.test.sh
```

Observed outcomes:

| Case | Observable result |
| --- | --- |
| Tool-heavy synthetic history, approximately 551190 tokens | One Jev request; OMP installed the extension replacement; 106 of 107 candidate calls dropped; approximately 8454 tokens within the 115699-token retained-context budget. |
| Retained and excluded tool results | The selected tool result survived verbatim; a dropped listing did not survive in the summary; an `excludeFromContext` execution marker reached neither the endpoint nor replacement. |
| Irreducible prose, approximately 550302 tokens | Zero Jev requests; OMP completed native `snapcompact`. |
| Mixed history, approximately 551605 tokens | The approximately 338986-token irreducible floor exceeded the 119075-token budget; zero Jev requests; native compaction completed. |
| Native protection on, inherited bare project group, or protective CLI overlay | Zero Jev uploads; native protection remained authoritative. |
| Firstmate worker overlay | One request and an installed replacement of approximately 4921 tokens within a 110030-token budget. |
| No key | Zero compaction hooks, review tools or Jev requests; native compaction completed. |
| Duplicate extension copies | One compaction hook and one `jev_review` tool; no load errors; the file key was not exported into OMP's environment. |
| Actual reviewer child | The child had `jev_review` but not `edit`, called the real upstream evaluator, and returned its evaluation in the optional `jev_evaluation` output field. |
| Reviewer child without key | OMP dropped the unregistered `jev_review` name from the reviewer definition instead of failing the spawn; the child had its read tools but neither `jev_review` nor `edit`, made zero requests, returned an explicit unavailable reason in `jev_evaluation`, and completed. |
| Baseline and rescore | Real upstream response handling produced correctness scores 4 and 9 and a comparison delta of +5 from deliberately different fake answers. |
| Protected review | Zero endpoint hits and an explicit unavailable result naming native protection. |

The actual selected model reported a 272000-token context window, not 550000.
These oversized synthetic journals prove compaction boundaries, not that this model accepts a 550000-token inference request.
The native opaque-history fallback remains intentional: a prior `snapcompact` or `openaiRemoteCompaction` entry can keep a session on native compaction until that state is replaced or a new session starts.
Unit regressions preserve that boundary and carried-summary, split-turn, whole-result budget, pairing and failure behavior.

A second actual-runtime run submitted a 13010-byte focused compaction diff from the implementation, rather than only the canned code fixture, through the same upstream evaluator and external-project reviewer.
It returned zero load errors, one hook, one review tool, an unexported file key, baseline 4, rescore 9, child score 4 and a completed structured reviewer result in three requests.
These numbers prove score propagation and comparison; fake answers are not a software-quality verdict and the scripted model does not prove an AI follows the review prompt.

The directory package is load-bearing: OMP discovers agent definitions from directory extension roots, not sibling directories of individual `-e file.ts` entries.
The external-project reviewer assertion failed when only the two extension files were passed, then passed with `.omp/package.json` exposing the two extensions and the repository reviewer.

## Compatibility and type evidence

The generated worker launch and brief contracts passed `tests/fm-omp-harness.test.sh` and `tests/fm-brief.test.sh`.
The OMP harness suite was run beneath nine neutral shell ancestors so the invoking real OMP process did not contaminate its negative ancestry-detection cases; no assertion or detection code was weakened.
It still checked secondmate discovery, worker loading, model validation, busy-state events, supervision hooks and presentation behavior.
No non-OMP launch contract was changed.

Strict TypeScript checking passed for both extension entrypoints and their shared key, privacy and registration modules with TypeScript 7.0.2, NodeNext resolution, ES2022, Node 22 types and the bundled upstream Zod declarations.
No language server was configured in this environment; the compiler check and actual OMP loader/schema execution supplied the type and runtime evidence instead.
The upstream evaluation source is vendored without source edits and the in-process bundle uses Zod 4.6.5; [the vendoring notice](../../.omp/vendor/jev-review/NOTICE.md) owns checksums, licenses and the build command.

On 2026-09-22 a clean `git archive` checkout reproduced both results from `.omp/vendor/jev-review` after `npm install` of its pinned development dependencies:

```sh
npm run build
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --types node --allowImportingTsExtensions --skipLibCheck ../../extensions/fm-jev-compaction.ts ../../extensions/fm-jev-review.ts
```

`cmp` found the rebuilt `dist/review.js` byte-identical to the tracked bundle, and the typecheck exited 0 through the tracked `dist/review.d.ts` chain into the vendored `src/config`, `src/evaluation` and `src/jev` sources.
The root `.gitignore` excludes every `config/` directory; a narrow negation keeps only `.omp/vendor/jev-review/src/config/` tracked, so a fresh clone carries the complete upstream source.

## Desktop boundary

Installed Agent Desktop reported version 0.9.2.
The real wrapper, given an empty isolated Firstmate home and no inherited key, exited 1 before opening or observing any application:

```text
fm-jev-desktop: TYPESAFE_API_KEY absent; Jev-driven desktop actions paused
```

The deterministic wrapper test executes controlled child programs and proves missing key/consent/script refusal, inherited-key precedence, file-key delivery only in the child environment, automatic `run --no-values`, refusal of unsupported `act --no-values`, and propagation of the operator's failure exit status.
This is not evidence of a successful desktop interaction.
Agent Desktop 0.9.2's installed `act` interface lacks `--no-values`; the wrapper must not silently promise that protection.

## Live authenticated verification

Verified on 2026-09-28 on macOS arm64 with OMP 18.2.10 against live `jev-1.13.0`, using the key in the owning home's `.env`, synthetic inputs only, and Hide Secrets off.

`jev_review` had failed every OMP worker call with the generic unavailable reason because OMP hands `execute` its intent field `i` (the eval tool bridge always does), which upstream's strict input schema rejects before any request; the adapter now forwards only the evaluator's own fields.
A fresh session exercised the direct tool, the eval bridge and the reviewer:

```sh
cd <synthetic-git-project-with-uncommitted-diff>
env -u FM_JEV_ENDPOINT -u FM_TASK_ID -u TYPESAFE_API_KEY FM_HOME=<home> \
  omp -p --no-session --thinking low --mode json -e <code-root>/.omp \
  "<call jev_review directly, then via eval's tool.jev_review, then the reviewer agent, on the same task and diff>"
```

All three returned scores (correctness 3.4 for a divide function missing the requested zero check); the reviewer reported correctness 3.4 at confidence 0.58.
A direct adapter run with the intent field present also scored a 53,019-character input (task, a 27,000-character diff and one 24,000-character file) in 2.4 seconds, and a rescore with `previousEvaluation` returned comparison deltas.

Compaction was checked by driving the registered `session_before_compact` handler directly (not `/compact` in a session) with a synthetic 9-call worker region.
Before the change, the vendored library at its 0.5 default dropped all 10 calls of a matching probe, including both edits and the latest failing test run; live keep-call answers were 0.18-0.51 and keep-result answers 0.10-0.21.
With the session goal and a fixed 0.3 threshold the handler reported `kept 0, truncated 7, dropped 2 of 9 calls (74% reduction ...)`, dropping only a grep and `git status`, and the summary retained the latest failing test's head.

### Compaction calibration on saved worker sessions

Measured on 2026-09-28 with OMP 18.2.10, Node 24.11.1 and live `jev-1.13.0`, using the home key, Hide Secrets off, and read-only copies of five saved OMP worker sessions in the owning home, each holding one live Jev compaction whose region had already been sent to Jev at the time.
Each region was rebuilt from its session journal as the entries before the compaction's `firstKeptEntryId`, with the later entries as the recent messages that supply the goal; every rebuilt region produced the same candidate-call count the live audit recorded.
`compactOmpRegion` then ran against live Jev with the session goal, recording every answer; the whole measurement made 84 requests totalling about 2.35 million input tokens, about $0.10 at the published $0.042 per million input tokens.

Across the five regions, median keep-call answers were 0.25-0.31 (10th to 90th percentile 0.18-0.42) and median keep-result answers 0.13-0.15.
Candidate calls kept whole or truncated, of the total:

| Session region | Live compaction as recorded | Fixed 0.3 | Calibrated (threshold) |
| --- | --- | --- | --- |
| Worker A, 154 calls | 2 (0.5, no goal) | 45 (29%) | 84 (55%, 0.25) |
| Worker B, 251 calls | 17 (0.5, no goal) | 149 (59%) | 144 (57%, 0.30) |
| Worker C, 276 calls | 2 (0.5, no goal) | 77 (28%) | 139 (50%, 0.27) |
| Worker D, 360 calls | 2 (0.5, no goal) | 111 (31%) | 186 (52%, 0.27) |
| Worker E, 313 calls | 163 (0.3, goal) | 165 (53%) | 166 (53%, 0.30) |

Calibrated region character reductions were 59-69%, and at most three results per region were kept whole.
Offline replay of the recorded answers through the calibrated rule kept 83-91% of edit calls per region and 79-100% of edited file paths, beside the summary's own `<files>` block; the dropped edits were mostly failed edits, cosmetic touch-ups and throwaway scripts outside the project.
The latest failing and latest passing test runs stayed in every region that had them, except Worker C's latest passing run, rated 0.26 against its 0.27 threshold.
A goal extended with an explicit sentence about edits, test runs and file paths raised answers across the board on two regions without improving edit retention under the calibrated rule, so the adapter keeps the plain session goal.
Repeat runs of the same region moved its middle-rank answer by at most 0.01 and its retained count by at most 23 of 360 calls.

Desktop: `bin/fm-jev-desktop.sh act --access-approved --ui-approved --app Finder "select the file calc.py"`, without `--execute`, on a Finder window showing only the synthetic project returned `ok: true`, `decision: act`, target confidence 0.98 and `executed: null`.
The same resolve on a Finder window of `/Applications` returned `typesafe 503 Service Unavailable` on four attempts over about two minutes while small review requests succeeded.

Still pending: `/compact` inside a live OMP session with its installed audit record, and a desktop `run` that executes a reversible synthetic-app goal.
Honor an enabled or unprovable native secret-protection setting: refusal is the expected result, not permission to bypass protection.
Never reuse a private production transcript just to obtain a successful test.

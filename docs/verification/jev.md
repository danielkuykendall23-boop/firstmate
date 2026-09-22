# Jev integration verification

Audience: maintainer verification.

[The Jev operator guide](../jev.md) owns activation, privacy, fallback and desktop consent.
This record distinguishes installed-runtime proof with local fake responses from live authenticated inference.
No credentials, purchases, private desktop observations, primary restarts or global OMP setting changes were used.

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

## Pending live activation and verification

A valid TypeSafe key with usable credits is still required for authenticated inference.
The user must enter the key privately and perform any OMP `/login typesafe` themselves; the extension key reader is separate from OMP's built-in judge login.
Starting a new session is required to replace already-loaded extension factories.
The primary environment's installation and restart are not proven by this worktree's isolated runtime tests.

After authorization, use a fresh synthetic project and the owning private home, leaving the fake endpoint unset:

```sh
env -u FM_JEV_ENDPOINT FM_HOME="<authorized-private-home>" \
  omp --cwd "<synthetic-project>" -e "<firstmate-code-root>/.omp"
```

In that session, call `jev_review` with a small nonsecret task and diff, preserve the complete evaluation, make an independently justified improvement and rescore using `previousEvaluation`.
Run the read-only reviewer on the same diff and verify that its returned structured evaluation agrees with the tool result.
Use a fresh synthetic tool-heavy history and `/compact` to verify an authenticated compaction request and installed audit record.
Honor an enabled or unprovable native secret-protection setting: refusal is the expected result, not permission to bypass protection.
Never reuse a private production transcript just to obtain a successful test.

Desktop success remains pending exact-app access approval, consent to send that synthetic app's UI descriptions, and a usable key.
Load both desktop skills, consult `bin/fm-jev-desktop.sh --help` and the installed operator's current help, then use the wrapper for one reversible synthetic-app goal.
The two approval flags attest the recorded permission; they do not create it.
Confirm the real UI result and operator exit status, and keep private windows, populated forms, credentials and destructive operations out of the proof.

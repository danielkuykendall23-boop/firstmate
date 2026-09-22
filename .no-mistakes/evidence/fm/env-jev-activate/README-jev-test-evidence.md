# Jev activation test evidence (branch fm/env-jev-activate, commit 3a1d55b)

Credential-free proof only: no TypeSafe key, no real desktop observation, no user config changes.
All runs used OMP 18.2.8, Node 24.11.1, Agent Desktop 0.9.2 on macOS arm64, 2026-09-22.

## Real OMP runtime (live-e2e-runner.log, omp-case-*.summary.json)
- `live-e2e-runner.log`: `FM_JEV_COMPACTION_LIVE_E2E=1 bin/fm-test-run.sh tests/fm-jev-compaction-live-e2e.test.sh`, 11 real OMP cases, all ok, exit 0.
- `omp-case-tools-550k.summary.json`: real OMP `compact` on a ~551k-token tool-heavy history; one Jev request; extension replacement installed; 106 of 107 calls dropped; excluded-bash marker never left the machine.
- `omp-case-no-key.summary.json`: no key => 0 hooks, 0 tools, 0 requests; OMP's native snapcompact completed.
- `omp-case-review.summary.json`: with a file key, duplicate loads registered one hook and one `jev_review`; the file key was not exported into OMP's env; baseline correctness 4, rescore 9, comparison delta +5; the real reviewer child had `jev_review` but no `edit`, called the upstream evaluator, and returned `jev_evaluation` with status completed.
- `omp-case-review-no-key.summary.json`: without a key OMP dropped `jev_review` from the reviewer definition; the child kept read tools, made 0 requests, and completed with `{"unavailable": true, "reason": "jev_review tool absent"}`.

## Generated worker instructions (bin/fm-brief.sh output)
- `generated-ship-brief-no-mistakes.md`: real ship brief; `## Jev review loop` is scoped to OMP sessions, `## Desktop control` present, rule 2 names only status, steering-inbox acknowledgement and Jev evaluation artifacts.
- `generated-scout-brief.md`: real scout brief; `## Desktop control` present, no Jev review loop.

## Desktop wrapper (desktop-wrapper-transcript.txt)
- Real `bin/fm-jev-desktop.sh` with an empty isolated home: missing key pauses (exit 1); missing consent refuses (exit 2); `act --no-values` refuses because Agent Desktop 0.9.2 lacks it (exit 2). No app was opened.

## Reproducible vendored bundle (vendored-bundle-reproducible-build.txt)
- Clean `git archive HEAD .omp`, `npm install` of pinned dev deps, `npm run build`: rebuilt `dist/review.js` byte-identical to the tracked bundle (sha256 025949ec...); strict `tsc --noEmit` on both extension entrypoints exit 0 through the tracked `src/config/environment.ts`.

## Deterministic suites (deterministic-suites-runner.log, documentation-audiences-runner.log)
- `bin/fm-test-run.sh tests/fm-jev-compaction.test.sh tests/fm-jev-desktop.test.sh tests/fm-brief.test.sh tests/fm-omp-harness.test.sh tests/fm-test-run.test.sh`: 5 scripts, 0 failed.
- `bin/fm-test-run.sh tests/fm-documentation-audiences.test.sh`: passed after the docs manifest change.
- `bin/fm-test-run.sh --list --changed --base 686b819`: exit 0, selecting the Jev live, Node, desktop, brief, harness and test-run suites (round-3 selector proof).

## Not proven here (by design)
- Authenticated TypeSafe inference, OMP `/login typesafe`, and a successful real desktop interaction wait for a user-supplied key, credits and consent.

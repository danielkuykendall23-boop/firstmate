#!/usr/bin/env bash
# Live, opt-in proof that .omp/extensions/fm-jev-compaction.ts behaves inside
# a real omp process the way tests/fm-jev-compaction.node.test.ts proves it
# behaves in isolation: a resumed synthetic session is compacted over omp's
# own RPC `compact` command with the extension loaded from the project's
# .omp/extensions/, Jev requests go to a local fake System One endpoint via
# FM_JEV_ENDPOINT, and omp's own `config get` answers the Hide Secrets gate.
# No credentials, no real TypeSafe or provider traffic, no captain data: the
# agent directory, HOME, project, and session directory are all scratch.
#
# Cases, each one real omp run:
#   tools-550k   ~550k-token tool-heavy history: Jev installs the replacement
#                (compaction entry with fromExtension and the Jev record).
#   text-550k    ~550k tokens of irreducible prose: zero Jev requests, honest
#                fallback, and omp's own native method order completes the
#                compaction instead (a native, not extension, entry on disk).
#   mixed-550k   ~550k tokens, each turn a droppable listing beside analysis
#                prose that alone exceeds the retained-context budget: the
#                tool calls would be asked about, but the floor decides first,
#                so zero requests, honest fallback, native completion.
#   secrets-on   agent config.yml turns Hide Secrets on: declined before any
#                request, with omp itself as the source.
#   shadow-A     agent on, project .omp/config.yml holds a bare `secrets:`
#                group: omp keeps it on (group shadow rule), so declined.
#   overlay-on   --config overlay turns it on: declined via the overlay.
#   worker       the tracked .omp/fm-worker-overlay.yml every Firstmate omp
#                launch carries: proceeds and installs.
#   no-key      no hooks/tools or requests; native compaction still completes.
#   review      duplicate-safe loading, actual read-only reviewer child and
#               upstream baseline/rescore handling through a loopback model.
#   review-no-key  no key: omp drops the unregistered jev_review from the
#               reviewer definition; the child still spawns read-only,
#               reports Jev unavailable through yield and completes.
#   protected   native Hide Secrets blocks all review uploads.
# The tool-heavy cases also plant an excludeFromContext bash execution
# carrying a marker and prove it never reaches the fake endpoint.
#
# Opt in with FM_JEV_COMPACTION_LIVE_E2E=1; needs omp, node, and jq.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate opt-in FM_JEV_COMPACTION_LIVE_E2E omp node jq

LAB=$(fm_test_tmproot fm-jev-compaction-live-e2e)
OMP_BIN=$(command -v omp)
DRIVER="$ROOT/tests/fixtures/fm-jev-runtime.mjs"


run_case() {
  local name=$1 kind=$2 turns=$3 target=$4
  shift 4
  local out="$LAB/$name.report.json"
  node "$DRIVER" "--case=$name" "--kind=$kind" "--turns=$turns" "--targetChars=$target" "--lab=$LAB" "--root=$ROOT" "--omp=$OMP_BIN" "--out=$out" "$@" > "$LAB/$name.driver.log" 2>&1 \
    || fail "$name: driver failed (see $LAB/$name.driver.log)"
  [ -f "$out" ] || fail "$name: no report written (see $LAB/$name.driver.log)"
  printf 'evidence %s: %s\n' "$name" "$(jq -c '{approxTokens, contextWindow: .model.contextWindow, compactSuccess: .compact.success, compactError: .compact.error, endpointHits: .endpoint.hits, markerLeaked: .endpoint.markerLeaked, durationMs, jevStderr, installed: ([.compactionEntries[] | select(.fromExtension)] | .[0] // null | if . == null then null else {summaryChars, summaryHasKept, summaryHasMarker, jev} end)}' "$out")" >&2
  printf '%s\n' "$out"
}

field() { jq -r "$2" "$1"; }

assert_zero_requests() {
  local report=$1 name=$2
  assert_equals 0 "$(field "$report" '.endpoint.hits')" "$name: no request may reach the endpoint"
  assert_equals 0 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "$name: nothing may be installed by the extension"
}

test_tools_550k_installs_through_real_omp() {
  local report
  report=$(run_case tools-550k tools 110 2200000)
  assert_equals 272000 "$(field "$report" '.model.contextWindow')" "the real session runs the captain's Codex Max model with its real context window"
  assert_equals true "$(field "$report" '.compact.success')" "omp's RPC compact must succeed on the tool-heavy history"
  assert_equals 1 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "exactly one compaction entry from the extension must be on disk"
  assert_equals true "$(field "$report" '.compactionEntries[0].summaryHasKept')" "the summary keeps the verbatim text Jev was told to keep"
  assert_equals true "$(field "$report" '.compactionEntries[0].keptToolVerbatim')" "the chosen tool result, not just user prose, must survive verbatim"
  assert_equals true "$(field "$report" '.compactionEntries[0].droppedToolAbsent')" "a dropped tool result must not survive in the replacement"
  assert_equals false "$(field "$report" '.compactionEntries[0].summaryHasMarker')" "the excludeFromContext execution never reaches the installed summary"
  assert_equals false "$(field "$report" '.endpoint.markerLeaked')" "the excludeFromContext execution never reaches the fake endpoint"
  assert_equals true "$(field "$report" '.endpoint.hits >= 1')" "Jev was asked at least once"
  assert_equals true "$(field "$report" '.compactionEntries[0].jev.reductionRatio >= 0.5')" "the tool-heavy history shrinks by well over the 25% minimum"
  assert_equals true "$(field "$report" '.compactionEntries[0].jev.budget.budgetTokens >= 100000')" "the retained-context budget for Codex Max is six figures, not the 13107-token native cap"
  assert_contains "$(field "$report" '.jevStatus | join("\n")')" "Jev compaction: kept" "omp received the success status frame"
  pass "tools-550k: real omp installs the Jev replacement for a ~$(field "$report" '.approxTokens')-token tool-heavy history (budget $(field "$report" '.compactionEntries[0].jev.budget.budgetTokens') tokens, ~$(field "$report" '.compactionEntries[0].jev.summaryTokens') used)"
}

test_text_550k_falls_back_honestly() {
  local report
  report=$(run_case text-550k text 110 2200000)
  assert_zero_requests "$report" text-550k
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "reduction 0% of the whole context below minimum" "irreducible prose is declined for lack of reduction, before any request"
  assert_equals true "$(field "$report" '.compact.success')" "omp's own native methods must complete the compaction the hook declined"
  assert_equals true "$(field "$report" '[.compactionEntries[] | select(.fromExtension | not)] | length >= 1')" "a native compaction entry, not an extension one, must be on disk"
  pass "text-550k: irreducible prose falls back with zero requests and omp's native $(field "$report" '[.compactionEntries[] | select(.fromExtension | not)][0].method // "native"') method completes the compaction instead"
}

test_mixed_550k_declines_on_the_floor_before_any_request() {
  local report
  report=$(run_case mixed-550k mixed 110 2200000)
  assert_zero_requests "$report" mixed-550k
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "even if Jev dropped every candidate call" "the floor, not a Jev answer, decides a region whose prose alone cannot fit"
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "retained-context budget" "the decline names the budget the prose exceeds"
  assert_equals true "$(field "$report" '.compact.success')" "omp's own native methods must complete the compaction the hook declined"
  assert_equals true "$(field "$report" '[.compactionEntries[] | select(.fromExtension | not)] | length >= 1')" "a native compaction entry, not an extension one, must be on disk"
  pass "mixed-550k: 110 droppable listings beside prose over the budget make zero requests and omp's native $(field "$report" '[.compactionEntries[] | select(.fromExtension | not)][0].method // "native"') method completes the compaction instead"
}

test_secrets_on_declines_via_omp_itself() {
  local report
  report=$(run_case secrets-on tools 24 300000 "--agentConfig=secrets:\n  enabled: true\n")
  assert_zero_requests "$report" secrets-on
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on (omp config get secrets.enabled)" "the decline names omp's own reader as its source"
  pass "secrets-on: real omp's config get answers true from inside the session and the hook declines before any request"
}

test_shadow_group_keeps_protection_on() {
  local report
  report=$(run_case shadow-A tools 24 300000 "--agentConfig=secrets:\n  enabled: true\n" "--projectConfig=secrets:\n  # enabled: false\n")
  assert_zero_requests "$report" shadow-A
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on" "a bare project group cannot switch an inherited on back off"
  pass "shadow-A: a bare project secrets: group leaves omp's effective switch on, and the hook follows omp"
}

test_overlay_on_declines() {
  local report overlay="$LAB/overlay-on.yml"
  printf 'secrets:\n  enabled: true\n' > "$overlay"
  report=$(run_case overlay-on tools 24 300000 "--overlay=$overlay")
  assert_zero_requests "$report" overlay-on
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on (--config overlay" "the decline names the overlay as its source"
  pass "overlay-on: a --config overlay turning Hide Secrets on is honored from the real launch argv"
}

test_worker_overlay_proceeds() {
  local report
  report=$(run_case worker tools 24 300000 "--overlay=$ROOT/.omp/fm-worker-overlay.yml")
  assert_equals true "$(field "$report" '.compact.success')" "the actual Firstmate worker overlay must not block Jev"
  assert_equals 1 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "worker: the extension installs"
  assert_equals true "$(field "$report" '.endpoint.hits >= 1')" "worker: Jev was asked"
  assert_equals false "$(field "$report" '.endpoint.markerLeaked')" "worker: the excluded execution still never leaves the machine"
  pass "worker: the tracked .omp/fm-worker-overlay.yml launch posture proceeds and installs"
}


test_no_key_preserves_native_compaction() {
  local report
  report=$(run_case no-key tools 24 300000)
  assert_zero_requests "$report" no-key
  assert_equals 0 "$(field "$report" '.proof.hooks')" "no key must not disable native speculative compaction"
  assert_equals 0 "$(field "$report" '.proof.tools | length')" "no key must not register review"
  assert_equals true "$(field "$report" '.compact.success')" "native compaction must still complete"
  pass "no-key: no hooks/tools or Jev requests; native compaction completes"
}

test_real_reviewer_tool_and_rescore() {
  local report
  report=$(run_case review review 12 180000)
  assert_equals 0 "$(field "$report" '.proof.errors | length')" "real OMP must load the review extension"
  assert_equals 1 "$(field "$report" '.proof.hooks')" "two source copies must register only one compaction hook"
  assert_equals 1 "$(field "$report" '.proof.tools | length')" "two source copies must register only one review tool"
  assert_equals false "$(field "$report" '.proof.keyExported')" "file credentials must stay out of the OMP environment"
  assert_equals 4 "$(field "$report" '.proof.baseline.details.metrics.correctness.score')" "real upstream transformation uses the fake baseline answer"
  assert_equals 9 "$(field "$report" '.proof.rescore.details.metrics.correctness.score')" "rescore must use the new answer"
  assert_equals 5 "$(field "$report" '.proof.rescore.details.comparison[] | select(.metric == "correctness") | .delta')" "upstream comparison must expose the real score delta"
  assert_equals true "$(field "$report" '.reviewEvidence.childTools | index("jev_review") != null')" "reviewer child must receive the tool"
  assert_equals false "$(field "$report" '.reviewEvidence.childTools | index("edit") != null')" "reviewer must remain read-only"
  assert_equals 4 "$(field "$report" '.reviewEvidence.childEvaluation.metrics.correctness.score')" "reviewer child must call the real tool and consume scores"
  assert_contains "$(field "$report" '.reviewEvidence.parentResult')" 'status="completed"' "reviewer must finish, not only spawn"
  assert_contains "$(field "$report" '.reviewEvidence.parentResult')" '"jev_evaluation"' "reviewer must return structured evaluation"
  pass "review: duplicate loads register once; real reviewer child uses Jev and returns scores; upstream rescore delta is +5"
}

test_reviewer_without_key_continues_agent_led_review() {
  local report
  report=$(run_case review-no-key review 12 180000)
  assert_equals 0 "$(field "$report" '.proof.errors | length')" "review-no-key: real OMP must load both extensions without a key"
  assert_equals 0 "$(field "$report" '.proof.tools | length')" "review-no-key: no key must register no review tool"
  assert_equals 0 "$(field "$report" '.endpoint.hits')" "review-no-key: nothing may reach the endpoint"
  assert_equals false "$(field "$report" '.reviewEvidence.childTools | index("jev_review") != null')" "review-no-key: the unregistered tool must not reach the reviewer child"
  assert_equals true "$(field "$report" '.reviewEvidence.childTools | index("read") != null')" "review-no-key: the reviewer child keeps its read tools"
  assert_equals false "$(field "$report" '.reviewEvidence.childTools | index("edit") != null')" "review-no-key: reviewer must remain read-only"
  assert_equals null "$(field "$report" '.reviewEvidence.missingTool')" "review-no-key: the child must not stall on the absent tool"
  assert_contains "$(field "$report" '.reviewEvidence.parentResult')" 'status="completed"' "review-no-key: reviewer must finish without Jev"
  assert_contains "$(field "$report" '.reviewEvidence.parentResult')" 'jev_review tool absent' "review-no-key: the structured result must carry the unavailable reason"
  pass "review-no-key: omp drops the unregistered jev_review from the reviewer definition; the child spawns read-only, reports Jev unavailable and completes"
}

test_real_review_honors_secret_protection() {
  local report
  report=$(run_case review-protected review 12 180000 "--agentConfig=secrets:\n  enabled: true\n")
  assert_equals 0 "$(field "$report" '.endpoint.hits')" "protected review input must not reach TypeSafe"
  assert_equals true "$(field "$report" '.proof.baseline.isError')" "protected review must report unavailable, not scores"
  assert_contains "$(field "$report" '.proof.baseline.content[0].text')" "Hide Secrets is on" "native protection owner must decide"
  pass "review-protected: real OMP protection refuses all review uploads"
}
test_tools_550k_installs_through_real_omp
test_text_550k_falls_back_honestly
test_mixed_550k_declines_on_the_floor_before_any_request
test_secrets_on_declines_via_omp_itself
test_shadow_group_keeps_protection_on
test_overlay_on_declines
test_worker_overlay_proceeds
test_no_key_preserves_native_compaction
test_real_reviewer_tool_and_rescore
test_reviewer_without_key_continues_agent_led_review
test_real_review_honors_secret_protection

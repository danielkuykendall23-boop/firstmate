#!/usr/bin/env bash
# Exercise the real resolver and spawn entrypoint without launching a real worker.
set -u
# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"
TMP_ROOT=$(fm_test_tmproot fm-spawn-resolve)
unset TYPESAFE_API_KEY

make_case() {
  local name=$1
  HOME_DIR="$TMP_ROOT/$name/home"
  PROJ_DIR="$TMP_ROOT/$name/project"
  WT_DIR="$TMP_ROOT/$name/worktree"
  FAKEBIN=$(fm_test_make_spawn_fakebin "$TMP_ROOT/$name" omp)
  fm_test_spawn_home "$HOME_DIR" omp
  fm_git_worktree "$PROJ_DIR" "$WT_DIR" "resolve-$name"
  fm_test_spawn_brief "$HOME_DIR" routing
  printf 'TYPESAFE_API_KEY=fake\n' > "$HOME_DIR/.env"
  chmod 600 "$HOME_DIR/.env"
  printf '%s\n' '{"rules":[{"when":"Implement the task reliably.","use":{"harness":"omp","model":"openai-codex/gpt-6-astra","effort":"high","provider":"codex"}}]}' > "$HOME_DIR/config/crew-dispatch.json"
  cat > "$FAKEBIN/curl" <<'SH'
#!/usr/bin/env bash
: > "$FAKE_CURL_MARK"
out=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac
done
cat >/dev/null
printf '%s\n' "{\"model\":\"jev-fake\",\"answers\":{\"rule\":{\"choice\":\"rule_1\",\"confidence\":${FAKE_CONFIDENCE:-0.95},\"probabilities\":{\"rule_1\":0.95,\"default\":0.05}}}}" > "$out"
printf '%s' "${FAKE_HTTP:-200}"
SH
  cat > "$FAKEBIN/quota-axi" <<'SH'
#!/usr/bin/env bash
if [ "$1" = --version ]; then printf '9.0.0\n'; exit; fi
printf '%s\n' '{"schemaVersion":5,"providers":[{"provider":"codex","quotaSemantics":{"status":"known","effectiveAvailability":[{"scope":"all_models","status":"known","effectivePercentRemaining":80,"runway":{"status":"through_reset"},"selection":{"spendPriority":0.8}}]}}]}'
SH
  chmod +x "$FAKEBIN/curl" "$FAKEBIN/quota-axi"
  LAUNCH_LOG="$TMP_ROOT/$name/launch.log"
  CURL_MARK="$TMP_ROOT/$name/curl.called"
}
run_case() {
  local output rc
  output=$(FAKE_CURL_MARK="$CURL_MARK" FM_FAKE_LAUNCH_LOG="$LAUNCH_LOG" fm_test_run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN" "$@")
  rc=$?
  printf '%s\n' "$output"
  if [ "$rc" -ne 0 ]; then
    printf '# fm-spawn exit=%s args=' "$rc" >&2
    printf '%q ' "$@" >&2
    printf '\n%s\n' "$output" >&2
  fi
  return "$rc"
}
ship() { run_case routing "$PROJ_DIR" --mode no-mistakes --yolo off --resolve "$@"; }
refused() {
  expect_code 2 "$code" "$1 refuses before launch"
  assert_absent "$LAUNCH_LOG" "$1 launches nothing"
  assert_absent "$HOME_DIR/state/routing.meta" "$1 creates no task metadata"
}

make_case clear
out=$(ship); code=$?
expect_code 0 "$code" "clear profile launches"
assert_present "$CURL_MARK" "the launch consulted the resolver"
assert_grep 'model=openai-codex/gpt-6-astra' "$HOME_DIR/state/routing.meta" "effective model is recorded"
assert_grep 'effort=high' "$HOME_DIR/state/routing.meta" "effective effort is recorded"
assert_contains "$(cat "$LAUNCH_LOG")" "--model 'openai-codex/gpt-6-astra' --thinking 'high'" "resolved axes reach the launch"
pass "clear uses resolved model and effort"

make_case explicit
out=$(ship --harness omp --model custom/model --effort max); code=$?
expect_code 0 "$code" "explicit axes launch"
assert_contains "$(cat "$LAUNCH_LOG")" "--model 'custom/model' --thinking 'max'" "explicit model and effort win"
pass "explicit axes win over resolution"

make_case partial
out=$(ship --effort max); code=$?
expect_code 0 "$code" "partial override launches"
assert_contains "$(cat "$LAUNCH_LOG")" "--model 'openai-codex/gpt-6-astra' --thinking 'max'" "only explicit effort overrides"
pass "per-axis override preserves unresolved axes"

make_case positional
out=$(ship codex --model gpt-5.5); code=$?
expect_code 0 "$code" "positional harness overrides"
assert_contains "$(cat "$LAUNCH_LOG")" "codex --model 'gpt-5.5' -c 'model_reasoning_effort=\"high\"'" "positional harness and explicit model retain resolved effort"
pass "legacy positional harness remains explicit"

make_case cross
out=$(ship --harness claude); code=$?
refused cross-harness
assert_contains "$out" "explicit harness 'claude' cannot interpret" "the refusal names the incompatible tuple"
pass "an explicit harness never adopts another harness's resolved model"

make_case scout
out=$(run_case routing "$PROJ_DIR" --scout --resolve); code=$?
expect_code 0 "$code" "scout resolves"
assert_grep 'kind=scout' "$HOME_DIR/state/routing.meta" "scout launch records its kind"
assert_contains "$(cat "$LAUNCH_LOG")" "--model 'openai-codex/gpt-6-astra'" "scout uses resolved model"
pass "scout supports resolution"

make_case off
rm "$HOME_DIR/.env"
out=$(ship --harness omp --model custom/model --effort max); code=$?
refused off
assert_contains "$out" 'dispatch resolution off' "explicit axes do not hide an off resolver"
make_case ambiguous
out=$(FAKE_CONFIDENCE=0.3 ship); code=$?
refused ambiguous
assert_contains "$out" 'dispatch resolution ambiguous' "ambiguous reason is visible"
make_case approval
jq '.rules[0].approval="captain"' "$HOME_DIR/config/crew-dispatch.json" > "$TMP_ROOT/rules.json"
mv "$TMP_ROOT/rules.json" "$HOME_DIR/config/crew-dispatch.json"
out=$(ship); code=$?
refused approval
assert_contains "$out" 'dispatch resolution escalate' "approval still requires a decision"
make_case error
out=$(FAKE_HTTP=503 ship); code=$?
refused error
assert_contains "$out" 'dispatch resolution error' "transport error is visible"
make_case malformed
printf '{\n' > "$HOME_DIR/config/crew-dispatch.json"
out=$(ship); code=$?
refused malformed
assert_contains "$out" 'malformed rules file' "configuration error is retained"
pass "all non-clear outcomes refuse without a launch"

make_case fallback
rm "$HOME_DIR/.env"
out=$(run_case routing "$PROJ_DIR" --mode no-mistakes --yolo off --harness omp --model custom/model --effort max); code=$?
expect_code 0 "$code" "the no-key fallback launches without --resolve"
assert_absent "$CURL_MARK" "no resolver request is made without --resolve"
assert_contains "$(cat "$LAUNCH_LOG")" "--model 'custom/model' --thinking 'max'" "the explicit selection is retained"
pass "no-key fallback retains the explicit selection without --resolve"

for unsupported in --secondmate --relaunch; do
  make_case "${unsupported#--}"
  out=$(ship "$unsupported"); code=$?
  refused "$unsupported"
done
make_case batch
out=$(run_case "routing=$PROJ_DIR" --resolve --mode no-mistakes --yolo off); code=$?
refused batch
pass "resolution rejects secondmate, relaunch, and batch modes"
echo '# all fm-spawn-resolve tests passed'

#!/usr/bin/env bash
# CLI transcript: worker spawn-time model/effort selection through the real
# bin/fm-spawn.sh and bin/fm-dispatch-resolve.sh with a loopback fake Jev answer.
# Reuses the repository's test fixtures read-only; nothing is written to the worktree.
# Usage: spawn-resolve-transcript.sh <worktree-root> <evidence-dir>
set -u
ROOT_IN=$1
EV=$2
. "$ROOT_IN/tests/fixtures.sh"
TMP_ROOT=$(fm_test_tmproot fm-spawn-evidence)
unset TYPESAFE_API_KEY
OUT="$EV/spawn-resolve-transcript.txt"
: > "$OUT"
say() { printf '%s\n' "$@" | tee -a "$OUT"; }

make_case() {
  local name=$1
  HOME_DIR="$TMP_ROOT/$name/home"
  PROJ_DIR="$TMP_ROOT/$name/project"
  WT_DIR="$TMP_ROOT/$name/worktree"
  FAKEBIN=$(fm_test_make_spawn_fakebin "$TMP_ROOT/$name" omp)
  fm_test_spawn_home "$HOME_DIR" omp
  fm_git_worktree "$PROJ_DIR" "$WT_DIR" "resolve-$name"
  fm_test_spawn_brief "$HOME_DIR" routing "Implement the pager retry queue reliably with tests."
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

show() {
  # show <title> [fm-spawn args...]
  local title=$1 rc output
  shift
  say "" "### $title" "\$ bin/fm-spawn.sh routing <project> $*"
  output=$(FAKE_CURL_MARK="$CURL_MARK" FM_FAKE_LAUNCH_LOG="$LAUNCH_LOG" fm_test_run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN" routing "$PROJ_DIR" "$@")
  rc=$?
  # Keep the transcript readable: the resolver's JSON line and every fm-spawn/dispatch message; drop quota dumps.
  printf '%s\n' "$output" | grep -E '^(\{"status"|fm-spawn:|error:|dispatch-resolve:|spawned|ok|Spawned|launched)' | sed 's/^/  /' | tee -a "$OUT"
  say "  exit=$rc"
  if [ -f "$CURL_MARK" ]; then say "  resolver contacted Jev: yes"; else say "  resolver contacted Jev: no"; fi
  if [ -f "$LAUNCH_LOG" ]; then
    say "  launched worker command (from the pane's staged launch file):"
    grep -oE -- "(omp|codex|claude)[^|]*(--model|--thinking|-c 'model_reasoning_effort)[^|]*" "$LAUNCH_LOG" | head -1 | sed 's/^/    /' | tee -a "$OUT"
    if [ -f "$HOME_DIR/state/routing.meta" ]; then
      say "  task metadata (state/routing.meta): $(grep -E '^(harness|model|effort|kind)=' "$HOME_DIR/state/routing.meta" | tr '\n' ' ')"
    fi
  else
    say "  launched worker command: none (refused before any worker allocation)"
  fi
}

say "# Worker spawn-time routing transcript" "# fm-spawn.sh + fm-dispatch-resolve.sh (real scripts), loopback fake Jev answer: rule_1 -> omp openai-codex/gpt-6-astra effort high" "# Rules file: config/crew-dispatch.json with one rule; key: TYPESAFE_API_KEY=fake in <home>/.env; quota-axi faked at 80% remaining"

make_case clear
show "1. --resolve with a clear Jev answer adopts the resolved model and effort" --mode no-mistakes --yolo off --resolve

make_case explicit
show "2. Explicit --model/--effort win over the resolved axes" --mode no-mistakes --yolo off --resolve --harness omp --model custom/model --effort max

make_case partial
show "3. Per-axis override: only --effort given, resolved model kept" --mode no-mistakes --yolo off --resolve --effort max

make_case cross
show "4. Explicit --harness claude with a resolved omp model refuses (harness-namespaced model ids)" --mode no-mistakes --yolo off --resolve --harness claude

make_case scout
show "5. Scout spawn resolves too" --scout --resolve

make_case off
rm "$HOME_DIR/.env"
show "6. No key + --resolve refuses (never the no-key path), even with explicit axes" --mode no-mistakes --yolo off --resolve --harness omp --model custom/model --effort max

make_case fallback
rm "$HOME_DIR/.env"
show "7. No key, documented fallback: launch the explicit selection without --resolve (no Jev call)" --mode no-mistakes --yolo off --harness omp --model custom/model --effort max

make_case ambiguous
FAKE_CONFIDENCE=0.3 show "8. Low-confidence (ambiguous) answer refuses before launch" --mode no-mistakes --yolo off --resolve

make_case error
FAKE_HTTP=503 show "9. Jev transport error refuses before launch" --mode no-mistakes --yolo off --resolve

say "" "# end of transcript"

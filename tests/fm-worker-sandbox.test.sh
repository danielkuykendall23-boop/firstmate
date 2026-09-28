#!/usr/bin/env bash
# Behavior tests for the opt-in worker sandbox (config/worker-sandbox,
# bin/fm-worker-sandbox.sh, and its wiring in bin/fm-spawn.sh).
#
# Portable cases drive fm-spawn through the fake tmux spawn world and pin the
# refusal contract: a malformed setting, an unverified harness, a raw launch
# command, or a machine that cannot enforce the fence must refuse before any
# metadata or launch exists, never degrade into an unsandboxed worker. The
# macOS case then executes the exact launch command fm-spawn staged, with a
# stand-in omp that performs a worker's real writes, under the real
# /usr/bin/sandbox-exec, and asserts which writes the fence let through.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

SANDBOX="$ROOT/bin/fm-worker-sandbox.sh"
# Fixtures live under /tmp rather than the per-user temp dir, because the
# fence deliberately leaves that per-user dir writable for tool caches; a
# fixture inside it could not observe a denial.
TMP_ROOT=$(TMPDIR=/tmp fm_test_tmproot fm-worker-sandbox)

make_case() {  # <name> <harness> <id>
  local name=$1 harness=$2 id=$3
  CASE_DIR="$TMP_ROOT/$name"
  HOME_DIR="$CASE_DIR/home"
  PROJ_DIR="$CASE_DIR/project"
  WT_DIR="$CASE_DIR/wt"
  LAUNCH_LOG="$CASE_DIR/launch.log"
  FAKEBIN=$(fm_test_make_spawn_fakebin "$CASE_DIR/fake" omp)
  fm_test_spawn_home "$HOME_DIR" "$harness"
  fm_git_worktree "$PROJ_DIR" "$WT_DIR" "wt-$name"
  fm_test_spawn_brief "$HOME_DIR" "$id"
}

spawn() {  # [fm-spawn args...]
  : > "$LAUNCH_LOG"
  CLAUDE_CONFIG_DIR='' FM_FAKE_LAUNCH_LOG="$LAUNCH_LOG" \
    fm_test_run_spawn "$HOME_DIR" "$WT_DIR" "$FAKEBIN" "$@"
}

assert_refused_before_launch() {  # <status> <id> <what>
  expect_code 1 "$1" "$3 must refuse"
  [ ! -s "$LAUNCH_LOG" ] || fail "$3 must launch nothing (got: $(cat "$LAUNCH_LOG"))"
  assert_absent "$HOME_DIR/state/$2.meta" "$3 must refuse before task metadata exists"
}

test_setting_tokens() {
  local cfg="$TMP_ROOT/setting" out status
  mkdir -p "$cfg"
  [ "$("$SANDBOX" setting "$cfg")" = off ] || fail "an absent config/worker-sandbox must read off"
  printf '  on\n' > "$cfg/worker-sandbox"
  [ "$("$SANDBOX" setting "$cfg")" = on ] || fail "surrounding whitespace must be trimmed"
  printf 'off\n' > "$cfg/worker-sandbox"
  [ "$("$SANDBOX" setting "$cfg")" = off ] || fail "an explicit off must read off"
  printf 'yes\n' > "$cfg/worker-sandbox"
  out=$("$SANDBOX" setting "$cfg" 2>&1); status=$?
  expect_code 1 "$status" "an unrecognized token must be an error"
  assert_contains "$out" "holds 'yes'" "the error must name the offending token"
  pass "config/worker-sandbox reads absent and off as off, on as on, and rejects anything else"
}

test_invalid_setting_refuses_spawn() {
  local id=sandbox-invalid out status
  make_case invalid omp "$id"
  printf 'maybe\n' > "$HOME_DIR/config/worker-sandbox"
  out=$(spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off); status=$?
  assert_refused_before_launch "$status" "$id" "a malformed worker-sandbox setting"
  assert_contains "$out" "config/worker-sandbox holds 'maybe'" "the refusal must name the file and token"
  pass "a malformed config/worker-sandbox refuses the spawn before metadata or launch"
}

test_unverified_harness_refuses() {
  local id=sandbox-claude out status
  make_case claude claude "$id"
  printf 'on\n' > "$HOME_DIR/config/worker-sandbox"
  out=$(spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off); status=$?
  assert_refused_before_launch "$status" "$id" "a claude worker under the sandbox setting"
  assert_contains "$out" "verified only for: omp" "the refusal must name the verified harnesses"
  pass "an unverified harness refuses instead of launching unsandboxed"
}

test_raw_launch_refuses() {
  local id=sandbox-raw out status
  make_case raw omp "$id"
  printf 'on\n' > "$HOME_DIR/config/worker-sandbox"
  out=$(spawn "$id" "$PROJ_DIR" "custom-agent --flag" --mode no-mistakes --yolo off); status=$?
  assert_refused_before_launch "$status" "$id" "a raw launch command under the sandbox setting"
  assert_contains "$out" "raw launch command has no verified sandbox profile" "the refusal must explain the raw launch"
  pass "a raw launch command refuses under the sandbox setting"
}

test_unavailable_sandbox_refuses() {
  local id=sandbox-unavailable out status
  make_case unavailable omp "$id"
  printf 'on\n' > "$HOME_DIR/config/worker-sandbox"
  out=$(FM_WORKER_SANDBOX_EXEC="$CASE_DIR/no-such-sandbox-exec" \
    spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off); status=$?
  assert_refused_before_launch "$status" "$id" "a machine without a usable sandbox"
  assert_contains "$out" "refusing to launch the worker unsandboxed" "the refusal must say the worker was not launched"
  pass "a machine that cannot enforce the fence refuses the spawn"
}

test_off_launches_exactly_as_absent() {
  local id=sandbox-off absent off
  make_case off-absent omp "$id"
  spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off >/dev/null || fail "absent-setting spawn failed"
  absent=$(sed "s#$CASE_DIR#CASE#g" "$LAUNCH_LOG")
  make_case off-explicit omp "$id"
  printf 'off\n' > "$HOME_DIR/config/worker-sandbox"
  spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off >/dev/null || fail "off-setting spawn failed"
  off=$(sed "s#$CASE_DIR#CASE#g" "$LAUNCH_LOG")
  [ -n "$absent" ] || fail "the absent-setting spawn launched nothing"
  [ "$absent" = "$off" ] || fail "config/worker-sandbox=off changed the launch"$'\n'"absent: $absent"$'\n'"off:    $off"
  pass "config/worker-sandbox=off launches exactly as an absent file does"
}

test_secondmate_launch_is_not_fenced() {
  local id=sandbox-sm sm out status
  make_case secondmate codex "$id"
  printf 'on\n' > "$HOME_DIR/config/worker-sandbox"
  sm="$CASE_DIR/sm-home"
  mkdir -p "$sm/bin" "$sm/data"
  printf '# Firstmate\n' > "$sm/AGENTS.md"
  printf '%s\n' "$id" > "$sm/.fm-secondmate-home"
  printf 'charter for %s\n' "$id" > "$sm/data/charter.md"
  out=$(FM_SKIP_SECONDMATE_INHERIT=1 spawn "$id" "$sm" --secondmate); status=$?
  expect_code 0 "$status" "a secondmate spawn under the sandbox setting should succeed"$'\n'"$out"
  assert_not_contains "$(cat "$LAUNCH_LOG")" "sandbox-exec" "a secondmate runs its own home and must not be fenced"
  pass "persistent secondmates are outside the worker sandbox"
}

# A stand-in omp performing the writes a worker makes, plus writes it must not.
write_worker_omp() {  # <fakebin>
  cat > "$1/omp" <<'SH'
#!/usr/bin/env bash
set -u
try() {  # <label> <command...>
  local label=$1
  shift
  if "$@" 2>/dev/null; then printf 'allowed %s\n' "$label"; else printf 'denied %s\n' "$label"; fi
}
st=$PROBE_STATE; id=$PROBE_ID
{
  try commit sh -c 'cd "$PROBE_WT" && echo change > change.txt && git add change.txt &&
    git -c user.name=w -c user.email=w@example.invalid commit -qm change'
  try status sh -c 'echo "working [at=1]: probe" >> "$0"' "$st/$id.status"
  try busy sh -c 'mkdir "$0.lock" && echo r > "$0.tmp.1" && mv -f "$0.tmp.1" "$0" && rmdir "$0.lock"' "$st/$id.busy-state"
  try turnend touch "$st/$id.turn-ended"
  try inbox mv "$st/$id.inbox/001.msg" "$st/$id.inbox/handled/"
  try report sh -c 'echo findings > "$0"' "$PROBE_DATA/$id/report.md"
  try tasktmp touch "/tmp/fm-$id/scratch"
  try meta sh -c 'mkdir "$0" && echo decisions_reviewed=1 >> "$1" && rmdir "$0"' "$st/.meta-$id.lock" "$st/$id.meta"
  try other-meta sh -c 'echo harness=evil >> "$0"' "$st/other-task.meta"
  try home-state touch "$st/.wake-queue"
  try other-status sh -c 'echo x >> "$0"' "$st/other-task.status"
  try other-data touch "$PROBE_DATA/other-task/report.md"
  try primary-checkout touch "$PROBE_PROJ/planted.txt"
  try git-hooks touch "$PROBE_PROJ/.git/hooks/post-commit"
  try git-config git -C "$PROBE_WT" config probe.key value
  try home touch "$HOME/planted"
} > "$PROBE_OUT"
SH
  chmod +x "$1/omp"
}

test_on_fences_the_spawned_worker() {
  local kind id out status launch result label
  if [ "$(uname -s)" != Darwin ] || [ ! -x /usr/bin/sandbox-exec ]; then
    printf '# skip - the worker sandbox uses macOS Seatbelt (/usr/bin/sandbox-exec)\n'
    return 0
  fi
  for kind in ship scout; do
    # Task ids may contain dots (bin/fm-pr-lib.sh fm_task_id_path_safe).
    id="sandbox.live-$kind"
    make_case "live-$kind" omp "$id"
    write_worker_omp "$FAKEBIN"
    printf 'on\n' > "$HOME_DIR/config/worker-sandbox"
    if [ "$kind" = ship ]; then
      out=$(spawn "$id" "$PROJ_DIR" --mode no-mistakes --yolo off); status=$?
    else
      out=$(spawn "$id" "$PROJ_DIR" --scout); status=$?
    fi
    expect_code 0 "$status" "$kind spawn under the sandbox setting should succeed"$'\n'"$out"
    launch=$(cat "$LAUNCH_LOG")
    assert_contains "$launch" "sandbox-exec' -f " "the $kind launch must run under sandbox-exec"
    mkdir -p "$HOME_DIR/state/$id.inbox/handled" "$HOME_DIR/data/other-task"
    printf 'steer\n' > "$HOME_DIR/state/$id.inbox/001.msg"
    # The stand-in reports through the task temp root, one of the few paths the
    # fence leaves writable.
    result="/tmp/fm-$id/probe.out"
    rm -f "$result"
    # Execute the staged launch exactly as the pane would, with the stand-in
    # omp first on PATH and the spawn's own throwaway HOME.
    HOME="$HOME_DIR/user-home" PATH="$FAKEBIN:$PATH" PROBE_OUT="$result" PROBE_ID="$id" \
      PROBE_STATE="$(cd "$HOME_DIR/state" && pwd -P)" PROBE_DATA="$(cd "$HOME_DIR/data" && pwd -P)" \
      PROBE_WT="$WT_DIR" PROBE_PROJ="$PROJ_DIR" bash -c "$launch" >"$CASE_DIR/launch.out" 2>&1
    [ -s "$result" ] || fail "the $kind launch never ran the worker"$'\n'"$(cat "$CASE_DIR/launch.out")"
    for label in commit status busy turnend inbox report tasktmp meta; do
      assert_grep "allowed $label" "$result" "$kind worker write '$label' must be allowed"$'\n'"$(cat "$result")"
    done
    for label in other-meta home-state other-status other-data primary-checkout git-hooks git-config home; do
      assert_grep "denied $label" "$result" "$kind worker write '$label' must be denied"$'\n'"$(cat "$result")"
    done
    assert_absent "$PROJ_DIR/planted.txt" "the $kind worker planted a file in the primary checkout"
    assert_present "$HOME_DIR/state/$id.inbox/handled/001.msg" "the $kind worker could not acknowledge its inbox"
    rm -rf "/tmp/fm-$id" "/tmp/fm-$id+"*
  done
  pass "a sandboxed worker writes its task files and nothing else"
}

test_setting_tokens
test_invalid_setting_refuses_spawn
test_unverified_harness_refuses
test_raw_launch_refuses
test_unavailable_sandbox_refuses
test_off_launches_exactly_as_absent
test_secondmate_launch_is_not_fenced
test_on_fences_the_spawned_worker

echo "# all fm-worker-sandbox tests passed"

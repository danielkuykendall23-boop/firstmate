#!/usr/bin/env bash
# Drives real bin/fm-spawn.sh for an omp worker on --backend tern (fake tern CLI)
# and on the default tmux backend (fake tmux), and prints both launch lines.
set -u
ROOT=$1
cd "$ROOT"
. tests/fixtures.sh
TMP_ROOT=$(fm_test_tmproot fm-s2-evidence)
US=$'\037'
ORIG_PATH=$PATH
eval "$(sed -n '/^make_tern_world() {/,/^}/p' tests/fm-backend-tern.test.sh)"
eval "$(sed -n '/^make_fake_omp() {/,/^}/p' tests/fm-omp-harness.test.sh)"

echo "=== tern backend: fm-spawn.sh tern-omp-q1 --harness omp --backend tern --scout"
make_tern_world omp-spawn
case_dir="$TMP_ROOT/omp-spawn"; home="$case_dir/home"; id=tern-omp-q1
fakebin=$(make_spawn_fakebin "$case_dir/fake"); make_fake_omp "$fakebin"
fm_test_spawn_home "$home" omp
fm_git_worktree "$case_dir/project" "$case_dir/wt" wt-tern-omp
fm_test_spawn_brief "$home" "$id"
printf '{"pane":102,"child":{"pid":1,"name":"zsh","argv":["zsh"],"cwd":"%s"},"group":1,"foreground":{"pid":1,"name":"zsh","argv":["zsh"],"cwd":"%s"}}' "$case_dir/wt" "$case_dir/wt" >"$W/process/102"
fm_test_run_spawn "$home" "$case_dir/wt" "$fakebin" "$id" "$case_dir/project" --harness omp --backend tern --scout | tail -3
staged=$(sed -n "s/^tern${US}send${US}102${US}text${US}--${US}\. '\(.*\)'\$/\1/p" "$TERN_LOG")
echo "--- staged launch file typed into tern block 102: $staged"
tern_launch=$(cat "$staged"); printf '%s\n' "$tern_launch" | grep -o "omp' --config.*--auto-approve --cwd [^ ]*"
rm -rf "/tmp/fm-$id" "/tmp/fm-$id+"*

echo; echo "=== tmux backend (default): fm-spawn.sh omp-tmux-q1 --harness omp --scout"
PATH=$ORIG_PATH; unset FM_TERN_FAKE FM_TERN_SESSION
case_dir="$TMP_ROOT/tmux-spawn"; home="$case_dir/home"; id=omp-tmux-q1
fakebin=$(make_spawn_fakebin "$case_dir/fake"); make_fake_omp "$fakebin"
fm_test_spawn_home "$home" omp
fm_git_worktree "$case_dir/project" "$case_dir/wt" wt-tmux-omp
fm_test_spawn_brief "$home" "$id"
: >"$case_dir/launch.log"
FM_FAKE_LAUNCH_LOG="$case_dir/launch.log" fm_test_run_spawn "$home" "$case_dir/wt" "$fakebin" "$id" "$case_dir/project" --harness omp --scout | tail -3
tmux_launch=$(cat "$case_dir/launch.log"); printf '%s\n' "$tmux_launch" | grep -o "omp' --config.*--auto-approve --cwd [^ ]*"

echo; echo "=== checks"
case "$tern_launch" in *"--config '$ROOT/.omp/fm-worker-overlay.yml' --config '$ROOT/.omp/fm-tern-worker-overlay.yml' --auto-approve"*) echo "PASS tern: posture overlay, then tern overlay, then --auto-approve";; *) echo "FAIL tern";; esac
case "$tmux_launch" in *fm-tern-worker-overlay*) echo "FAIL tmux carries tern overlay";; *"--config '$ROOT/.omp/fm-worker-overlay.yml' --auto-approve"*) echo "PASS tmux: posture overlay only, no tern overlay";; *) echo "FAIL tmux launch shape";; esac
rm -rf "$TMP_ROOT"

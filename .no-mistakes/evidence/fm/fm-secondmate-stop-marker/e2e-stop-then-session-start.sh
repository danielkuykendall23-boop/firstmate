#!/usr/bin/env bash
# End-to-end: captain stops a secondmate via bin/fm-control.sh exit, then a new
# session start runs bin/fm-bootstrap.sh. Reuses the repo's own test fakes
# (fake tmux providers from tests/fm-control.test.sh and
# tests/fm-secondmate-liveness.test.sh) without running their test lists.
set -u
WT=${1:?worktree}
cd "$WT"
for f in fm-control fm-secondmate-liveness; do
  grep -vE '^test_[a-z0-9_]+$|^echo "# all|^trap ' "tests/$f.test.sh" > "tests/.e2e-$f.sh"
done
trap 'rm -f "$WT"/tests/.e2e-*.sh; rm -rf "$TMP_ROOT"' EXIT
. tests/.e2e-fm-secondmate-liveness.sh
LIVE_TMP=$TMP_ROOT
. tests/.e2e-fm-control.sh      # defines make_tmux_stub, run_control, CONTROL
TMP_ROOT=$LIVE_TMP
trap 'rm -f "$WT"/tests/.e2e-*.sh; rm -rf "$TMP_ROOT"' EXIT

hr() { printf '\n==== %s ====\n' "$*"; }

w=$(new_world e2e); add_sm_home "$w" sm-phone firstmate:fm-sm-phone
echo "worktree=$w/sm-phone" >> "$w/home/state/sm-phone.meta"
echo "endpoint_task_id=sm-phone" >> "$w/home/state/sm-phone.meta"
echo "project=$w/sm-phone" >> "$w/home/state/sm-phone.meta"
fb=$(make_toolchain "$w"); ltmux=$(make_liveness_tmux "$w/lt")
# the liveness tmux stub hardcodes window fm-sm1 in list-windows; use a copy that lists our window
sed -i '' 's/fm-sm1/fm-sm-phone/' "$ltmux/tmux"

hr "1. secondmate record before the stop"
cat "$w/home/state/sm-phone.meta"

hr "2. captain: bin/fm-control.sh sm-phone exit   (agent 'claude' is live in the pane)"
c="$w/ctl"; mkdir -p "$c/fake"; : > "$c/fake/literal"; : > "$c/fake/keys"
printf 'claude' > "$c/fake/command"; printf 'claude' > "$c/fake/becomes"
printf '%s\n' fm-sm-phone > "$c/fake/windows"; printf '%s' "$w/sm-phone" > "$c/fake/cwd"
make_tmux_stub "$c" >/dev/null
ln -s "$w/home" "$c/home"
run_control "$c" sm-phone exit; echo "rc=$?"
echo "typed into pane: $(cat "$c/fake/literal")   pane foreground now: $(cat "$c/fake/command")"

hr "3. secondmate record after the stop"
cat "$w/home/state/sm-phone.meta"

hr "4. next session start: bin/fm-bootstrap.sh (pane is a bare zsh = dead endpoint)"
log="$w/calls.log"; : > "$log"
run_bootstrap "$ltmux:$fb" "$w/home" zsh "$log" | grep -E 'SECONDMATE_LIVENESS' || echo "(no SECONDMATE_LIVENESS line)"
echo "tmux kill-window/new-window calls by the sweep: $(wc -l < "$log" | tr -d ' ')"; cat "$log"

hr "5. control: same dead endpoint WITHOUT the marker (pre-fix behavior)"
grep -v '^secondmate_stopped_' "$w/home/state/sm-phone.meta" > "$w/nomark"; cp "$w/home/state/sm-phone.meta" "$w/marked"; cp "$w/nomark" "$w/home/state/sm-phone.meta"
: > "$log"; rm -f "$log.killed"
run_bootstrap "$ltmux:$fb" "$w/home" zsh "$log" | grep -E 'SECONDMATE_LIVENESS' || true
echo "tmux calls by the sweep:"; cat "$log"
cp "$w/marked" "$w/home/state/sm-phone.meta"

hr "6. remote secondmate (e.g. DGX Spark) carrying the marker"
echo "remote_host=dgx-spark" >> "$w/home/state/sm-phone.meta"
mkdir -p "$w/sshbin"; printf '#!/usr/bin/env bash\necho "ssh $*" >> "%s/ssh.log"\nexit 255\n' "$w" > "$w/sshbin/ssh"; chmod +x "$w/sshbin/ssh"
: > "$w/ssh.log"; : > "$log"
run_bootstrap "$w/sshbin:$ltmux:$fb" "$w/home" zsh "$log" | grep -E 'SECONDMATE_LIVENESS' || true
echo "ssh calls: $(wc -l < "$w/ssh.log" | tr -d ' ')   tmux calls: $(wc -l < "$log" | tr -d ' ')"
hr "6b. same remote record WITHOUT the marker (sweep does reach out to the remote)"
grep -v '^secondmate_stopped_' "$w/home/state/sm-phone.meta" > "$w/t" && mv "$w/t" "$w/home/state/sm-phone.meta"
: > "$w/ssh.log"; : > "$log"
run_bootstrap "$w/sshbin:$ltmux:$fb" "$w/home" zsh "$log" | grep -E 'SECONDMATE_LIVENESS' || true
echo "ssh calls: $(wc -l < "$w/ssh.log" | tr -d ' ')"

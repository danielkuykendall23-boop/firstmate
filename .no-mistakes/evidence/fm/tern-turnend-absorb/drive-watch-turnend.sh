#!/usr/bin/env bash
# Drive the REAL bin/fm-watch.sh (with the REAL bin/fm-crew-state.sh and the real
# no-mistakes v1.84 CLI) on one bare turn-ended wake from a busy omp worker whose
# task copy is a LINKED git worktree, against a disposable NM_HOME/state dir.
# usage: drive-watch-turnend.sh <label> <firstmate-root> <lab-dir> <herdr-target>
set -u
label=$1 root=$2 S=$3 target=$4
st=$S/state-$label; rm -rf "$st"; mkdir -p "$st" "$S/cfg-empty"
printf '%s\n' "window=$target" "backend=herdr" "worktree=$S/wt" "kind=ship" "harness=omp" "branch=fm/linked" > "$st/twk.meta"
gen=$("$root/bin/fm-busy-event.sh" arm "$st" twk)
"$root/bin/fm-busy-event.sh" apply "$st" twk busy --gen "$gen" --source omp-ext --event turn-start
echo "busy-state: $(cat "$st/twk.busy-state")"
echo "fm-crew-state: $(NM_HOME=$S/nm FM_STATE_OVERRIDE=$st "$root/bin/fm-crew-state.sh" twk)"
: > "$st/twk.turn-ended"
out=$S/watch-$label.out
NM_HOME=$S/nm FM_STATE_OVERRIDE=$st FM_CONFIG_OVERRIDE=$S/cfg-empty FM_POLL=1 FM_SIGNAL_GRACE=1 \
  FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 "$root/bin/fm-watch.sh" > "$out" 2>"$S/watch-$label.err" &
pid=$!
for i in $(seq 1 200); do kill -0 $pid 2>/dev/null || break; [ -s "$st/.watch-triage.log" ] && grep -q "twk.turn-ended" "$st/.watch-triage.log" 2>/dev/null && break; sleep 0.1; done
sleep 2
if kill -0 $pid 2>/dev/null; then echo "watcher: still running (did not wake)"; kill $pid; wait $pid 2>/dev/null; else echo "watcher: EXITED (woke the supervisor)"; fi
echo "watcher stdout: $(cat "$out")"
echo "wake-queue: $(cat "$st/.wake-queue" 2>/dev/null | tr '\t' ' ')"
echo "triage log:"; sed 's/^/  /' "$st/.watch-triage.log" 2>/dev/null

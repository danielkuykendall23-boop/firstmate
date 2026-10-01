#!/bin/bash
# usage: drive.sh <bash-binary> <git-rev> <mode: supervisor|burst> <iterations>
set -u
BASHBIN=$1 REV=$2 MODE=$3 ITER=$4
REPO=/Users/danielkuykendall/.no-mistakes/worktrees/6ada68ffd386/01M3W74CTPTFYJ8XQJ76GT4WX1
T=$(mktemp -d /tmp/nm-drive/run.XXXX); T=$(cd "$T" && pwd -P)
R=$T/root; H=$T/home; S=$T/state
mkdir -p "$R/bin" "$H"; chmod 700 "$H"
for f in fm-remote-job-lib.sh fm-remote-job-worker.sh fm-remote-delta-read.sh; do
  git -C "$REPO" show "$REV:bin/$f" | sed "1s|^#!.*bash.*|#!$BASHBIN|" > "$R/bin/$f"
done
chmod +x "$R/bin"/*.sh; printf 'fixture\n' > "$R/AGENTS.md"
git -C "$R" init -q -b main; git -C "$R" -c user.email=t@e -c user.name=t add -A; git -C "$R" -c user.email=t@e -c user.name=t commit -qm f
. "$R/bin/fm-remote-job-lib.sh"
pass=0 hang=0 leak=0 total_ms=0 max_ms=0
for n in $(seq 1 "$ITER"); do
  if [ "$MODE" = supervisor ]; then args=(); else args=(--serve); fi
  HOME="$H" FM_ROOT_OVERRIDE="$R" FM_REMOTE_JOB_STATE_ROOT="$S" FM_REMOTE_JOB_PLATFORM_OVERRIDE=Linux \
    "$R/bin/fm-remote-job-worker.sh" ${args[@]+"${args[@]}"} >>"$T/out" 2>>"$T/err" &
  P=$!
  for _ in $(seq 1 400); do [ -f "$S/worker.ready" ] && break; sleep 0.05; done
  [ -f "$S/worker.ready" ] || { echo "iter $n: never ready"; tail -3 "$T/err"; kill -KILL -- $P; exit 1; }
  sleep 0.$((RANDOM % 9 + 1))
  t0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  if [ "$MODE" = supervisor ] || [ "$MODE" = single ]; then kill -TERM $P; else for _ in 1 2 3 4 5 6 7 8 9 10; do kill -TERM $P 2>/dev/null; done; fi
  for _ in $(seq 1 200); do kill -0 $P 2>/dev/null || break; sleep 0.05; done
  t1=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000'); ms=$((t1 - t0))
  if kill -0 $P 2>/dev/null; then
    hang=$((hang+1)); echo "iter $n: HANG >10s after stop; tree:"; ps -o pid=,ppid=,stat=,etime=,command= -g "$(ps -o pgid= -p $P | tr -d ' ')" 2>/dev/null | sed 's/^/   /'
    pkill -KILL -P $P 2>/dev/null; kill -KILL $P 2>/dev/null; wait $P 2>/dev/null
    for c in $(pgrep -f "$R/bin/fm-remote-job-worker.sh"); do kill -KILL $c 2>/dev/null; done
    rm -f "$S/worker.lock" "$S/worker.ready"; rm -rf "$S/worker.lock"
    continue
  fi
  wait $P 2>/dev/null; rc=$?
  if [ -e "$S/worker.lock" ] || [ -e "$S/worker.ready" ] || pgrep -f "$R/bin/fm-remote-job-worker.sh" >/dev/null; then
    leak=$((leak+1)); echo "iter $n: rc=$rc but lock/ready/process left behind"; ls -la "$S"; pgrep -fl "$R/bin/fm-remote-job-worker.sh"
    for c in $(pgrep -f "$R/bin/fm-remote-job-worker.sh"); do kill -KILL $c; done; rm -rf "$S/worker.lock" "$S/worker.ready"; continue
  fi
  [ "$rc" -eq 0 ] || echo "iter $n: exit $rc"
  pass=$((pass+1)); total_ms=$((total_ms+ms)); [ $ms -le $max_ms ] || max_ms=$ms
done
echo "RESULT bash=$("$BASHBIN" -c 'echo $BASH_VERSION') rev=$REV mode=$MODE iterations=$ITER clean=$pass hangs=$hang leaks=$leak avg_stop_ms=$(( pass ? total_ms/pass : 0 )) max_stop_ms=$max_ms"
rm -rf "$T"

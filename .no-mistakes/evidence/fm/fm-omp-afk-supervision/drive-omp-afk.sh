#!/bin/bash
# Runs INSIDE a process whose comm is `omp` (copy of bash named omp), so
# bin/fm-harness.sh ancestry detection is real and unmocked.
W="$1"; H="$2"
export FM_HOME="$H" FM_STATE_OVERRIDE="$H/state"
echo "\$ bin/fm-harness.sh"; "$W/bin/fm-harness.sh"
echo; echo "\$ bin/fm-afk-launch.sh propose --words 'merge the windows fix when green'"
"$W/bin/fm-afk-launch.sh" propose --words 'merge the windows fix when green' 2>&1; echo "rc=$?"
echo; echo "\$ bin/fm-afk-launch.sh confirm"
"$W/bin/fm-afk-launch.sh" confirm 2>&1; echo "rc=$?"
echo; echo "\$ bin/fm-afk-launch.sh start   (FM_SUPERVISOR_BACKEND=herdr FM_SUPERVISOR_TARGET=fake)"
FM_SUPERVISOR_BACKEND=herdr FM_SUPERVISOR_TARGET=fm-lab-never-used:1 "$W/bin/fm-afk-launch.sh" start 2>&1; echo "rc=$?"
echo; echo "\$ bin/fm-afk-launch.sh start-native"
"$W/bin/fm-afk-launch.sh" start-native 2>&1; echo "rc=$?"
echo; echo "--- state after refusals ---"; ls -A "$H/state"
pgrep -fl "fm-supervise-daemon|fm-afk-start" | grep -F "$H" || echo "no daemon process for this home"
echo; echo "\$ bin/fm-afk-launch.sh stop"
"$W/bin/fm-afk-launch.sh" stop 2>&1; echo "rc=$?"
echo "--- state after stop ---"; ls -A "$H/state"; ls "$H/state/afk-contracts" 2>/dev/null

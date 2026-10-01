#!/bin/bash
# usage: launch.sh <run> <with-overlay 1|0> <prompt> [extra omp args...]
L=$(cat /tmp/fmshake.path); W=/Users/danielkuykendall/.no-mistakes/worktrees/6ada68ffd386/01M3TDBBM1CFP6SK3VY400QEQP
run=$1; ov=$2; prompt=$3; shift 3
H=$L/$run/home
cfg=(); [ "$ov" = 1 ] && cfg=(--config $W/.omp/fm-worker-overlay.yml)
cd $L/$run/work
exec env -u CLAUDECODE HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share XDG_STATE_HOME=$H/.local/state XDG_CACHE_HOME=$H/.cache OMP_SKIP_SETUP=1 FM_OMP_HARNESS=omp \
  omp "${cfg[@]}" --auto-approve --cwd $L/$run/work --model fake/fake-1 --no-title --max-time 60 "$@" -p "$prompt"

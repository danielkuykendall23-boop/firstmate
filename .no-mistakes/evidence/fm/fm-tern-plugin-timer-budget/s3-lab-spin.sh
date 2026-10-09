#!/bin/zsh
# Retitles its pane like an omp spinner about every 0.12 s using only builtins
# (zselect -t is the sleep), so no process is spawned per frame.
zmodload zsh/zselect
n=$1; frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
while :; do for f in $frames; do printf '\033]0;π %s fm-%s\007' $f $n; zselect -t 12; done; done

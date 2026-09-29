#!/usr/bin/env bash
# Simulates a slow runner for the captain-held-quiet leg by backdating the fresh
# declaration (as if 1500 s of wall clock elapsed during the absorb rounds), then
# drives the real bin/fm-watch.sh through the test's own round helper under
# (a) the old default 999 s resurface window and (b) the pinned 86400 s window.
slow_runner_repro() {
  local working='state: working · source: run-step · ci running'
  local window="test:fm-wedge" key dir state fakebin out capture resurface age rc
  key=$(printf '%s' "$window" | tr ':/.' '___')
  for age in 0 1500; do
    for resurface in default 86400; do
      dir=$(wedge_threshold_fixture "repro-$age-$resurface" 'captain-held: which retention window wins' "$age")
      state="$dir/state"; fakebin="$dir/fakebin"; out="$dir/watch.out"; capture="$dir/pane.txt"
      if [ "$resurface" = default ]; then
        (unset FM_TEST_PAUSE_RESURFACE; wedge_threshold_round "$state" "$fakebin" "$out" "$capture" "$window" "$working" absorb); rc=$?
      else
        FM_TEST_PAUSE_RESURFACE=86400 wedge_threshold_round "$state" "$fakebin" "$out" "$capture" "$window" "$working" absorb; rc=$?
      fi
      printf 'declaration_age=%-5s resurface=%-7s absorb_round=%s stale_wakes=%s escalations=%s watcher_output=%s\n' \
        "$age" "$resurface" "$([ $rc -eq 0 ] && echo absorbed || echo EXITED)" \
        "$(wedge_stale_wakes "$state" "$window")" \
        "$(cat "$state/.wedge-escalations-$key" 2>/dev/null || echo 0)" \
        "$(tr '\n' ' ' < "$out" | cut -c1-160)"
    done
  done
}
export -f slow_runner_repro

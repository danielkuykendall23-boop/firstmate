#!/usr/bin/env bash
# Disposable probe: a keyed agent starts the Herdr server for a lab session via
# the real adapter; does a later worker pane inherit TYPESAFE_API_KEY?
set -u
ROOT=$1; OUT=$2; LABEL=$3
. "$ROOT/tests/herdr-test-safety.sh"
herdr_forget_inherited_pane
SESSION=$("$ROOT/bin/fm-herdr-lab.sh" name "$LABEL")
export HERDR_SESSION="$SESSION"
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/fm-jevkey-herdr.XXXXXX")
cleanup() { herdr_safe_stop_and_delete "$SESSION"; rm -rf "$SCRATCH"; }
trap cleanup EXIT
fm_herdr_lab_prepare "$SESSION" || { echo "prepare failed"; exit 1; }
. "$ROOT/bin/fm-backend.sh"; fm_backend_source herdr || exit 1
mkdir -p "$SCRATCH/proj"
export FM_HOME="$SCRATCH/home"; mkdir -p "$FM_HOME"
# the Firstmate conversation holds the key ambiently (G1)
RAW=$(TYPESAFE_API_KEY=ambient-jev-key fm_backend_herdr_container_ensure "$SCRATCH/proj") || { echo "container_ensure failed"; exit 1; }
CONTAINER=${RAW%%$'\t'*}; SEEDED=${RAW#*$'\t'}
IDS=$(fm_backend_herdr_create_task "$CONTAINER" fm-jevkey-probe "$SCRATCH/proj" "$SEEDED") || { echo "create_task failed"; exit 1; }
read -r TAB PANE <<<"$IDS"
"$ROOT/bin/fm-herdr-lab.sh" run "$SESSION" pane run "$PANE" "printf '%s\n' \"\${TYPESAFE_API_KEY-unset}\" > $SCRATCH/seen" >/dev/null
for i in $(seq 1 40); do [ -s "$SCRATCH/seen" ] && break; sleep 0.25; done
echo "session=$SESSION pane=$PANE worker_pane_TYPESAFE_API_KEY=$(cat "$SCRATCH/seen" 2>/dev/null || echo '<no-output>')" | tee "$OUT"

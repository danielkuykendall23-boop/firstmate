#!/usr/bin/env bash
# Evidence harness: rehearse the guarded `fm-herdr-lab.sh handoff` action against
# the REAL installed Herdr, on generated non-default fm-lab- sessions only.
# Every Herdr call goes through the helper's public CLI, except read-only
# `herdr session list --json` and `ps`, which observe the default server.
# usage: real-herdr-handoff-rehearsal.sh <worktree-root>
set -u
ROOT=${1:?worktree root}
HELPER="$ROOT/bin/fm-herdr-lab.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fm-handoff-rehearsal.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
LABS=()
FAILS=0

# The round-1 defect was a group-writable ownership record on umask-0002 hosts.
umask 0002

say() { printf '\n## %s\n' "$*"; }
show() { printf '$ %s\n' "$*"; }
check() { # <description> <status>
  if [ "$2" -eq 0 ]; then printf 'CHECK ok   - %s\n' "$1"; else printf 'CHECK FAIL - %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
lab() { local name=$1; shift; "$HELPER" run "$name" "$@"; }
default_snapshot() { herdr session list --json | jq -c '[.sessions[] | select(.default == true)]'; }
default_server_process() { LC_ALL=C ps -axo pid=,lstart=,command= | grep -E 'herdr server$' | sed 's/^ *//'; }
lab_server_process() { LC_ALL=C ps -axo pid=,lstart=,command= | grep -F -- "--session $1" | grep -v grep | sed 's/^ *//'; }
cleanup() {
  local name
  for name in ${LABS[@]+"${LABS[@]}"}; do
    if herdr session list --json | jq -e --arg n "$name" '.sessions[] | select(.name == $n)' >/dev/null 2>&1; then
      "$HELPER" teardown "$name" >/dev/null 2>&1 || printf 'CLEANUP WARNING: teardown of %s failed\n' "$name"
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

say "Host"
show "herdr --version; sw_vers -productVersion; uname -m; umask"
herdr --version; sw_vers -productVersion; uname -m; umask

say "Default session and server BEFORE any lab work (read-only observation)"
DEFAULT_BEFORE=$(default_snapshot); printf '%s\n' "$DEFAULT_BEFORE"
DEFAULT_PROC_BEFORE=$(default_server_process); printf '%s\n' "$DEFAULT_PROC_BEFORE"

say "Stage a separate copy of the stock executable (nothing is installed)"
mkdir -p "$WORK/staged"
cp "$(command -v herdr)" "$WORK/staged/herdr"
chmod 700 "$WORK/staged/herdr"
STAGED="$WORK/staged/herdr"
DIGEST=$(shasum -a 256 "$STAGED" | awk '{print $1}')
VERSION=$(herdr --version | awk '{print $2}')
printf 'staged=%s\nsha256=%s\nversion=%s\n' "$STAGED" "$DIGEST" "$VERSION"

say "Provision a short-label lab under umask 0002"
show "fm-herdr-lab.sh name ho"
LAB=$("$HELPER" name ho); printf '%s\n' "$LAB"
LABS+=("$LAB")
show "fm-herdr-lab.sh provision $LAB"
"$HELPER" provision "$LAB"; check "provision exits 0" $?
RECORD="${TMPDIR:-/tmp}/fm-herdr-lab-${UID}/$LAB.fleet-state.json"
show "stat ownership record"
stat -f '%Sp links=%l %N' "$RECORD"
[ "$(stat -f '%Lp' "$RECORD")" = 600 ]; check "ownership record is owner-only (0600) despite umask 0002" $?

say "Start a fixture in a lab pane: a shell whose foreground child acknowledges input"
cat > "$WORK/fixture.sh" <<'FIXTURE'
#!/usr/bin/env bash
printf 'FIXTURE_START pid=%s\n' "$$"
while IFS= read -r line; do printf 'ACK %s\n' "$line"; done
FIXTURE
chmod 700 "$WORK/fixture.sh"
PANE=$(lab "$LAB" workspace create --cwd "$WORK" --label rehearsal --no-focus | jq -er '.result.root_pane.pane_id')
printf 'pane=%s\n' "$PANE"
lab "$LAB" pane run "$PANE" "$WORK/fixture.sh" >/dev/null
sleep 2
lab "$LAB" pane send-text "$PANE" BEFORE_HANDOFF >/dev/null
lab "$LAB" pane send-keys "$PANE" enter >/dev/null
sleep 1
show "fm-herdr-lab.sh run $LAB pane process-info --pane $PANE"
INFO_BEFORE=$(lab "$LAB" pane process-info --pane "$PANE" | jq -c '.result'); printf '%s\n' "$INFO_BEFORE"
show "fm-herdr-lab.sh run $LAB pane read $PANE --source recent --lines 500 --format text"
lab "$LAB" pane read "$PANE" --source recent --lines 500 --format text | grep -E 'FIXTURE_START|ACK' || true
FIXTURE_PID=$(pgrep -f "$WORK/fixture.sh" | head -n 1)
FIXTURE_PROC_BEFORE=$(LC_ALL=C ps -p "$FIXTURE_PID" -o pid=,ppid=,tty=,lstart=)
printf 'fixture process: %s\n' "$FIXTURE_PROC_BEFORE"
LAB_PROC_BEFORE=$(lab_server_process "$LAB"); printf 'lab server: %s\n' "$LAB_PROC_BEFORE"

say "Refusals: each must exit non-zero and leave the lab server process untouched"
refuse() { # <description> <command...>
  local description=$1 status=0 output
  shift
  show "fm-herdr-lab.sh ${*:2}"
  output=$("$@" 2>&1) || status=$?
  printf '%s\nexit=%s\n' "$output" "$status"
  [ "$status" -ne 0 ] && [ "$(lab_server_process "$LAB")" = "$LAB_PROC_BEFORE" ]
  check "$description" $?
}
refuse "the default session is refused" "$HELPER" handoff default "$STAGED" "$DIGEST" "$VERSION" 20
refuse "a lab this helper does not own is refused" "$HELPER" handoff fm-lab-not-mine "$STAGED" "$DIGEST" "$VERSION" 20
refuse "a wrong digest is refused" "$HELPER" handoff "$LAB" "$STAGED" "$(printf '0%.0s' $(seq 64))" "$VERSION" 20
refuse "the installed client itself is refused as its own replacement" "$HELPER" handoff "$LAB" "$(command -v herdr)" \
  "$(shasum -a 256 "$(command -v herdr)" | awk '{print $1}')" "$VERSION" 20
refuse "an extra --session argument is refused" "$HELPER" handoff "$LAB" "$STAGED" "$DIGEST" "$VERSION" 20 --session=default
refuse "generic run still forbids server live-handoff" "$HELPER" run "$LAB" server live-handoff --import-exe "$STAGED"

say "Guarded handoff with a deliberately wrong expected version (Herdr must refuse the import)"
show "fm-herdr-lab.sh handoff $LAB <staged> <sha256> 9.9.9 20"
STATUS=0; "$HELPER" handoff "$LAB" "$STAGED" "$DIGEST" 9.9.9 20 || STATUS=$?
printf 'exit=%s\n' "$STATUS"
[ "$STATUS" -ne 0 ]; check "a mismatched expected version fails" $?
lab "$LAB" status --json | jq -c '.server // .'
[ "$(LC_ALL=C ps -p "$FIXTURE_PID" -o pid=,ppid=,tty=,lstart=)" = "$FIXTURE_PROC_BEFORE" ]
check "fixture process identity survives the refused import" $?
[ "$(default_snapshot)" = "$DEFAULT_BEFORE" ] && [ "$(default_server_process)" = "$DEFAULT_PROC_BEFORE" ]
check "default session and default server process unchanged after the refused import" $?

say "Guarded handoff with the matching version and protocol"
show "fm-herdr-lab.sh handoff $LAB <staged> <sha256> $VERSION 20"
STATUS=0; "$HELPER" handoff "$LAB" "$STAGED" "$DIGEST" "$VERSION" 20 || STATUS=$?
printf 'exit=%s\n' "$STATUS"
check "matching handoff exits 0" "$STATUS"
show "fm-herdr-lab.sh run $LAB status --json"
lab "$LAB" status --json | jq -c '.server // .'
LAB_PROC_AFTER=$(LC_ALL=C ps -axo pid=,lstart=,command= | grep -F "$STAGED" | grep -v grep | sed 's/^ *//')
printf 'lab server now: %s\n' "$LAB_PROC_AFTER"
[ -n "$LAB_PROC_AFTER" ]; check "the lab server now runs from the staged executable" $?
INFO_AFTER=$(lab "$LAB" pane process-info --pane "$PANE" | jq -c '.result'); printf '%s\n' "$INFO_AFTER"
[ "$INFO_AFTER" = "$INFO_BEFORE" ]; check "pane process-info identical across the handoff" $?
[ "$(LC_ALL=C ps -p "$FIXTURE_PID" -o pid=,ppid=,tty=,lstart=)" = "$FIXTURE_PROC_BEFORE" ]
check "fixture child kept its pid, parent, tty, and start time" $?
lab "$LAB" pane send-text "$PANE" AFTER_HANDOFF >/dev/null
lab "$LAB" pane send-keys "$PANE" enter >/dev/null
sleep 1
show "fm-herdr-lab.sh run $LAB pane read $PANE --source recent --lines 500 --format text"
READ_AFTER=$(lab "$LAB" pane read "$PANE" --source recent --lines 500 --format text | grep -E 'FIXTURE_START|ACK|HANDOFF' || true)
printf '%s\n' "$READ_AFTER"
printf '%s' "$READ_AFTER" | grep -q 'ACK AFTER_HANDOFF'; check "input sent after the handoff reaches the surviving child" $?
[ "$(stat -f '%Lp' "$RECORD")" = 600 ] && [ -f "$RECORD" ]; check "ownership record retained unchanged" $?
[ "$(default_snapshot)" = "$DEFAULT_BEFORE" ] && [ "$(default_server_process)" = "$DEFAULT_PROC_BEFORE" ]
check "default session and default server process unchanged after the committed handoff" $?
[ "$(shasum -a 256 "$(command -v herdr)" | awk '{print $1}')" = "$DIGEST" ]; check "installed herdr executable untouched (nothing installed)" $?

say "Guarded teardown of the short-label lab"
show "fm-herdr-lab.sh teardown $LAB"
"$HELPER" teardown "$LAB"; check "teardown exits 0 with the tripwire intact" $?

say "Long task-derived label: provisions, then the native handoff hits the macOS socket path limit"
show "fm-herdr-lab.sh name herdr-phone-guide"
LONG=$("$HELPER" name herdr-phone-guide); printf '%s\n' "$LONG"
LABS+=("$LONG")
SESSION_DIR="$HOME/.config/herdr/sessions/$LONG"
printf 'worst-case handoff socket path bytes: %s (macOS limit 103)\n' "$(printf '%s/herdr-handoff-99999.sock' "$SESSION_DIR" | wc -c | tr -d ' ')"
"$HELPER" provision "$LONG"; check "long-label lab provisions" $?
show "fm-herdr-lab.sh handoff $LONG <staged> <sha256> $VERSION 20"
STATUS=0; LONG_OUTPUT=$("$HELPER" handoff "$LONG" "$STAGED" "$DIGEST" "$VERSION" 20 2>&1) || STATUS=$?
printf '%s\nexit=%s\n' "$LONG_OUTPUT" "$STATUS"
lab "$LONG" status --json | jq -c '.server // .'
show "fm-herdr-lab.sh teardown $LONG"
"$HELPER" teardown "$LONG"; check "long-label lab teardown exits 0" $?

say "Default session and server AFTER all lab work"
default_snapshot; default_server_process
[ "$(default_snapshot)" = "$DEFAULT_BEFORE" ] && [ "$(default_server_process)" = "$DEFAULT_PROC_BEFORE" ]
check "default session snapshot and default server pid/start time byte-identical to BEFORE" $?
herdr session list --json | jq -c '[.sessions[].name]'
! herdr session list --json | jq -e '.sessions[] | select(.name | startswith("fm-lab-ho-") or startswith("fm-lab-herdr-phone-"))' >/dev/null
check "no rehearsal lab left behind" $?

printf '\nRESULT: %s failed checks\n' "$FAILS"
[ "$FAILS" -eq 0 ]

#!/usr/bin/env bash
# Real restored-shell E2E for home-local Herdr projection cleanup, at session
# start and as the watcher's mid-session housekeeping run.
# Every CLI operation is routed through one guarded named non-default lab, and
# lab teardown verifies that the default fleet session is byte-identical.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERDR_LAB_HELPER=${HERDR_LAB_HELPER:-$ROOT/bin/fm-herdr-lab.sh}

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

command -v herdr >/dev/null 2>&1 || { echo 'skip: herdr not found'; exit 0; }
command -v jq >/dev/null 2>&1 || { echo 'skip: jq not found'; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo 'skip: python3 not found'; exit 0; }
[ -x "$HERDR_LAB_HELPER" ] || { echo "skip: Herdr lab helper not executable at $HERDR_LAB_HELPER"; exit 0; }

REAL_HERDR=$(command -v herdr)
HERDR_ORIGINAL_PATH=$PATH
TMP_ROOT=$(mktemp -d "$(cd "${TMPDIR:-/tmp}" && pwd -P)/fm-herdr-session-cleanup-e2e.XXXXXX")
FAKEBIN="$TMP_ROOT/fakebin"
HOME_DIR="$TMP_ROOT/home"
mkdir -p "$FAKEBIN" "$HOME_DIR/state" "$HOME_DIR/config"
touch "$HOME_DIR/config/herdr-presentation-spaces"
printf '%s\n' herdr > "$HOME_DIR/config/backend"

HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name fm-herdr-session-start-stale-projection-cleanup-r1)
export HERDR_LAB_HELPER HERDR_LAB_SESSION REAL_HERDR HERDR_ORIGINAL_PATH
cleanup() {
  local status=$?
  env PATH="$HERDR_ORIGINAL_PATH" "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || status=1
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"

# Keep the lab helper as the only CLI transport. Production adapter calls have
# already appended the exact session; this shim strips that pair, refuses every
# other caller-supplied session, and delegates the command to helper run.
cat > "$FAKEBIN/herdr" <<'SH'
#!/usr/bin/env bash
set -u
args=("$@")
last=$((${#args[@]} - 1))
flag=$((last - 1))
if [ "${#args[@]}" -ge 2 ] \
  && [ "${args[$flag]}" = --session ] \
  && [ "${args[$last]}" = "$HERDR_LAB_SESSION" ]; then
  unset "args[$last]" "args[$flag]"
fi
set -- "${args[@]}"
for arg in "$@"; do
  case "$arg" in --session|--session=*) exit 9 ;; esac
done
if [ "${1:-}" = --version ]; then
  exec env PATH="$HERDR_ORIGINAL_PATH" "$REAL_HERDR" "$@" --session "$HERDR_LAB_SESSION"
fi
exec env PATH="$HERDR_ORIGINAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"
SH
chmod +x "$FAKEBIN/herdr"

lab() { env PATH="$HERDR_ORIGINAL_PATH" "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }
production_process_proof() { # [pane]
  FM_HOME="$HOME_DIR" FM_BACKEND=herdr HERDR_SESSION="$HERDR_LAB_SESSION" \
    FM_HERDR_SESSION_CLEANUP_SOURCE_ONLY=1 PATH="$FAKEBIN:$HERDR_ORIGINAL_PATH" \
    bash -c '. "$1"; fm_backend_herdr_pane_idle_shell_pid "$2" "$3" >/dev/null' \
      _ "$ROOT/bin/fm-herdr-session-cleanup.sh" "$HERDR_LAB_SESSION" "${1:-$PANE}"
}
wait_idle_shell() { # <pane>
  local attempt=0
  while [ "$attempt" -lt 50 ]; do
    if production_process_proof "$1"; then
      return 0
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  return 1
}
focus_snapshot() {
  local list workspace tab tabs
  list=$(lab workspace list) || return 1
  workspace=$(printf '%s' "$list" | jq -er '[.result.workspaces[] | select(.focused == true)] | select(length == 1) | .[0].workspace_id') || return 1
  tab=$(printf '%s' "$list" | jq -er --arg workspace "$workspace" '[.result.workspaces[] | select(.workspace_id == $workspace)] | select(length == 1) | .[0].active_tab_id') || return 1
  tabs=$(lab tab list --workspace "$workspace") || return 1
  printf '%s' "$tabs" | jq -e --arg tab "$tab" '([.result.tabs[] | select(.focused == true)] | length) == 1 and ([.result.tabs[] | select(.focused == true)][0].tab_id == $tab)' >/dev/null || return 1
  printf '%s\t%s' "$workspace" "$tab"
}

ANCHOR=$(lab workspace create --cwd "$ROOT" --label captain-anchor --focus) || fail 'could not create focus anchor'
ANCHOR_TAB=$(printf '%s' "$ANCHOR" | jq -r '.result.tab.tab_id')
TOKEN=AbCdEfGhIjKlMnOpQrStUv
ID=restored-idle-shell
TITLE="└ $ID · p:$TOKEN"
CANDIDATE=$(lab workspace create --cwd "$ROOT" --label "$TITLE" --no-focus) || fail 'could not create projected child fixture'
WS=$(printf '%s' "$CANDIDATE" | jq -r '.result.workspace.workspace_id')
PANE=$(printf '%s' "$CANDIDATE" | jq -r '.result.root_pane.pane_id')
{
  printf 'version=1\n'
  printf 'task_id=%s\n' "$ID"
  printf 'projection_id=%s\n' "$TOKEN"
} > "$HOME_DIR/state/$ID.herdr-presentation"

# A projected child whose task record still names its pane: the in-flight task
# shape a Herdr server restart leaves behind. Its journal, record, and the pane
# are all created before the restart, so spawn_gen predates the restored shell.
write_journal() { # <id> <token>
  {
    printf 'version=1\n'
    printf 'task_id=%s\n' "$1"
    printf 'projection_id=%s\n' "$2"
  } > "$HOME_DIR/state/$1.herdr-presentation"
}
write_meta() { # <id> <workspace> <tab> <pane> <spawn-epoch>
  {
    printf 'window=%s:%s\n' "$HERDR_LAB_SESSION" "$4"
    printf 'endpoint_task_id=%s\n' "$1"
    printf 'worktree=%s\n' "$ROOT"
    printf 'project=%s\n' "$ROOT"
    printf 'harness=claude\nkind=ship\nmode=no-mistakes\nyolo=off\n'
    printf 'model=default\neffort=default\n'
    printf 'spawn_gen=s%s.1.1\n' "$5"
    printf 'backend=herdr\n'
    printf 'herdr_session=%s\n' "$HERDR_LAB_SESSION"
    printf 'herdr_workspace_id=%s\nherdr_tab_id=%s\nherdr_pane_id=%s\n' "$2" "$3" "$4"
  } > "$HOME_DIR/state/$1.meta"
}
create_child() { # <title>
  lab workspace create --cwd "$ROOT" --label "$1" --no-focus
}
HUSK_TOKEN=BcDeFgHiJkLmNoPqRsTuVw
HUSK_ID=restored-husk
HUSK_TITLE="└ $HUSK_ID · p:$HUSK_TOKEN"
HUSK=$(create_child "$HUSK_TITLE") || fail 'could not create metadata-backed husk fixture'
HUSK_WS=$(printf '%s' "$HUSK" | jq -r '.result.workspace.workspace_id')
HUSK_TAB=$(printf '%s' "$HUSK" | jq -r '.result.tab.tab_id')
HUSK_PANE=$(printf '%s' "$HUSK" | jq -r '.result.root_pane.pane_id')
write_journal "$HUSK_ID" "$HUSK_TOKEN"
write_meta "$HUSK_ID" "$HUSK_WS" "$HUSK_TAB" "$HUSK_PANE" "$(date +%s)"
HUSK_META_BEFORE=$(cat "$HOME_DIR/state/$HUSK_ID.meta")

# A projected child whose task record names a DIFFERENT pane (the task moved
# elsewhere): never a cleanup candidate, restored shell or not.
MOVED_TOKEN=CdEfGhIjKlMnOpQrStUvWx
MOVED_ID=moved-elsewhere
MOVED_TITLE="└ $MOVED_ID · p:$MOVED_TOKEN"
MOVED=$(create_child "$MOVED_TITLE") || fail 'could not create moved-record fixture'
MOVED_WS=$(printf '%s' "$MOVED" | jq -r '.result.workspace.workspace_id')
MOVED_TAB=$(printf '%s' "$MOVED" | jq -r '.result.tab.tab_id')
MOVED_PANE=$(printf '%s' "$MOVED" | jq -r '.result.root_pane.pane_id')
write_journal "$MOVED_ID" "$MOVED_TOKEN"
write_meta "$MOVED_ID" "$MOVED_WS" "$MOVED_TAB" "$(printf '%s' "$ANCHOR" | jq -r '.result.root_pane.pane_id')" "$(date +%s)"
# The restored shell must start more than the cleanup's restored-shell margin
# after the husk's recorded launch second.
sleep 6

"$HERDR_LAB_HELPER" stop "$HERDR_LAB_SESSION" >/dev/null || fail 'could not stop named lab for restored-shell reproduction'
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || fail 'could not restore named lab layout'
lab tab focus "$ANCHOR_TAB" >/dev/null || fail 'could not restore the anchor focus after lab restart'

# A projected child created AFTER the restart whose record was minted after
# its shell started: the shell firstmate launched into, exactly what a parked
# or exited worker's pane looks like. It must survive even though it is an
# agent-free idle shell too.
PARKED_TOKEN=DeFgHiJkLmNoPqRsTuVwXy
PARKED_ID=parked-launch-shell
PARKED_TITLE="└ $PARKED_ID · p:$PARKED_TOKEN"
PARKED=$(create_child "$PARKED_TITLE") || fail 'could not create parked launch-shell fixture'
PARKED_WS=$(printf '%s' "$PARKED" | jq -r '.result.workspace.workspace_id')
PARKED_TAB=$(printf '%s' "$PARKED" | jq -r '.result.tab.tab_id')
PARKED_PANE=$(printf '%s' "$PARKED" | jq -r '.result.root_pane.pane_id')
write_journal "$PARKED_ID" "$PARKED_TOKEN"
sleep 2
write_meta "$PARKED_ID" "$PARKED_WS" "$PARKED_TAB" "$PARKED_PANE" "$(date +%s)"
BEFORE_FOCUS=$(focus_snapshot) || fail 'could not capture exact pre-cleanup focus'
[ "$BEFORE_FOCUS" = "$(printf '%s\t%s' "$(printf '%s' "$ANCHOR" | jq -r '.result.workspace.workspace_id')" "$ANCHOR_TAB")" ] \
  || fail 'anchor focus does not match the exact intended workspace and tab'

WORKSPACES=$(lab workspace list) || fail 'could not inspect restored workspaces'
TABS=$(lab tab list --workspace "$WS") || fail 'could not inspect restored tabs'
PANES=$(lab pane list --workspace "$WS") || fail 'could not inspect restored panes'
[ "$(printf '%s' "$WORKSPACES" | jq --arg title "$TITLE" '[.result.workspaces[] | select(.label == $title)] | length')" = 1 ] \
  || fail 'restored projected title is not unique'
[ "$(printf '%s' "$TABS" | jq '.result.tabs | length')" = 1 ] || fail 'restored child is not one tab'
[ "$(printf '%s' "$PANES" | jq '.result.panes | length')" = 1 ] || fail 'restored child is not one pane'
if lab agent get "$PANE" >/dev/null 2>&1; then
  fail 'restored child unexpectedly retained a registered agent'
fi
wait_idle_shell "$PANE" || fail 'restored child did not converge to the exact childless idle-shell process-group shape'
pass 'real named lab reproduced the exact restored one-tab one-pane childless no-agent shell shape'

run_cleanup() { # [--dry-run]
  FM_HOME="$HOME_DIR" FM_BACKEND=herdr HERDR_SESSION="$HERDR_LAB_SESSION" \
    PATH="$FAKEBIN:$HERDR_ORIGINAL_PATH" "$ROOT/bin/fm-herdr-session-cleanup.sh" "$@"
}
verdict_for() { # <inventory> <workspace>
  printf '%s\n' "$1" | awk -F'\t' -v ws="$2" '$2 == ws { print $1; exit }'
}
INVENTORY=$(run_cleanup --dry-run 2>/dev/null) || fail 'dry-run inventory command failed'
[ "$(verdict_for "$INVENTORY" "$WS")" = close ] || fail "dry run did not mark the record-less stale projection close: $INVENTORY"
[ "$(verdict_for "$INVENTORY" "$HUSK_WS")" = close ] || fail "dry run did not mark the metadata-backed restored husk close: $INVENTORY"
[ "$(verdict_for "$INVENTORY" "$PARKED_WS")" = keep ] || fail "dry run did not keep the parked launch-shell pane: $INVENTORY"
[ "$(verdict_for "$INVENTORY" "$MOVED_WS")" = keep ] || fail "dry run did not keep the moved-record projection: $INVENTORY"
[ -z "$(verdict_for "$INVENTORY" "$(printf '%s' "$ANCHOR" | jq -r '.result.workspace.workspace_id')")" ] \
  || fail 'dry run listed the captain anchor, which carries no projection title'
for fixture_id in "$ID" "$HUSK_ID" "$MOVED_ID" "$PARKED_ID"; do
  [ -e "$HOME_DIR/state/$fixture_id.herdr-presentation" ] || fail "dry run retired the $fixture_id journal"
done
for fixture_pane in "$PANE" "$HUSK_PANE" "$MOVED_PANE" "$PARKED_PANE"; do
  lab pane get "$fixture_pane" >/dev/null 2>&1 || fail "dry run closed pane $fixture_pane"
done
[ "$(focus_snapshot)" = "$BEFORE_FOCUS" ] || fail 'dry run changed focus'
pass 'real named lab dry run inventories every owned projection with the verdict the locked run applies and mutates nothing'

FM_HOME="$HOME_DIR" FM_BACKEND=herdr HERDR_SESSION="$HERDR_LAB_SESSION" \
  PATH="$FAKEBIN:$HERDR_ORIGINAL_PATH" "$ROOT/bin/fm-herdr-session-cleanup.sh" \
  || fail 'session-start cleanup command failed'
AFTER_FOCUS=$(focus_snapshot) || fail 'could not capture exact post-cleanup focus'
[ "$AFTER_FOCUS" = "$BEFORE_FOCUS" ] || fail 'exact workspace/tab focus changed during cleanup'
if lab pane get "$PANE" >/dev/null 2>&1; then
  fail 'exact stale pane survived cleanup'
fi
if lab workspace get "$WS" >/dev/null 2>&1; then
  fail 'last-pane side effect did not remove the stale projected child workspace'
fi
[ ! -e "$HOME_DIR/state/$ID.herdr-presentation" ] || fail 'matching journal survived confirmed exact pane closure'
pass 'real named lab cleanup closes only the exact stale pane and preserves exact focus'
if lab pane get "$HUSK_PANE" >/dev/null 2>&1; then
  fail 'metadata-backed restored husk pane survived cleanup'
fi
if lab workspace get "$HUSK_WS" >/dev/null 2>&1; then
  fail 'metadata-backed restored husk workspace survived cleanup'
fi
[ ! -e "$HOME_DIR/state/$HUSK_ID.herdr-presentation" ] || fail 'restored husk journal survived confirmed exact pane closure'
[ "$(cat "$HOME_DIR/state/$HUSK_ID.meta")" = "$HUSK_META_BEFORE" ] || fail 'cleanup edited the restored husk task record'
lab pane get "$PARKED_PANE" >/dev/null 2>&1 || fail 'parked launch-shell pane was closed'
[ -e "$HOME_DIR/state/$PARKED_ID.herdr-presentation" ] || fail 'parked launch-shell journal was retired'
lab pane get "$MOVED_PANE" >/dev/null 2>&1 || fail 'moved-record projection pane was closed'
[ -e "$HOME_DIR/state/$MOVED_ID.herdr-presentation" ] || fail 'moved-record journal was retired'
pass 'real named lab cleanup retires a metadata-backed server-restored husk, keeps its task record, and preserves the launch-shell and moved-record panes'

FM_HOME="$HOME_DIR" FM_BACKEND=herdr HERDR_SESSION="$HERDR_LAB_SESSION" \
  PATH="$FAKEBIN:$HERDR_ORIGINAL_PATH" "$ROOT/bin/fm-herdr-session-cleanup.sh" \
  || fail 'idempotent repeat failed'
[ "$(focus_snapshot)" = "$BEFORE_FOCUS" ] || fail 'idempotent repeat changed focus'
lab pane get "$(printf '%s' "$ANCHOR" | jq -r '.result.root_pane.pane_id')" >/dev/null \
  || fail 'anchor pane was touched by cleanup'
pass 'real named lab cleanup is idempotent'

# A task projected after session start whose server restarts later must
# disappear without a new session: bin/fm-watch.sh runs this exact locked entry
# point on its slow-check cadence. Reproduce that shape - a new record-backed
# child, a second server restart, one housekeeping run - and prove the husk
# retires while a pane whose record was minted after its shell started (a
# parked worker) survives. The earlier parked pane's shell died with the
# server too, so this run retires it on the same proof.
LATE_TOKEN=EfGhIjKlMnOpQrStUvWxYz
LATE_ID=late-restored-husk
LATE_TITLE="└ $LATE_ID · p:$LATE_TOKEN"
LATE=$(create_child "$LATE_TITLE") || fail 'could not create the mid-session husk fixture'
LATE_WS=$(printf '%s' "$LATE" | jq -r '.result.workspace.workspace_id')
LATE_TAB=$(printf '%s' "$LATE" | jq -r '.result.tab.tab_id')
LATE_PANE=$(printf '%s' "$LATE" | jq -r '.result.root_pane.pane_id')
write_journal "$LATE_ID" "$LATE_TOKEN"
write_meta "$LATE_ID" "$LATE_WS" "$LATE_TAB" "$LATE_PANE" "$(date +%s)"
LATE_META_BEFORE=$(cat "$HOME_DIR/state/$LATE_ID.meta")
sleep 6
"$HERDR_LAB_HELPER" stop "$HERDR_LAB_SESSION" >/dev/null || fail 'could not stop named lab for the mid-session restart'
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || fail 'could not restore named lab layout after the mid-session restart'
lab tab focus "$ANCHOR_TAB" >/dev/null || fail 'could not restore the anchor focus after the mid-session restart'
LATE_PARKED_TOKEN=FgHiJkLmNoPqRsTuVwXyZa
LATE_PARKED_ID=late-parked-launch-shell
LATE_PARKED_TITLE="└ $LATE_PARKED_ID · p:$LATE_PARKED_TOKEN"
LATE_PARKED=$(create_child "$LATE_PARKED_TITLE") || fail 'could not create the mid-session parked fixture'
LATE_PARKED_WS=$(printf '%s' "$LATE_PARKED" | jq -r '.result.workspace.workspace_id')
LATE_PARKED_TAB=$(printf '%s' "$LATE_PARKED" | jq -r '.result.tab.tab_id')
LATE_PARKED_PANE=$(printf '%s' "$LATE_PARKED" | jq -r '.result.root_pane.pane_id')
write_journal "$LATE_PARKED_ID" "$LATE_PARKED_TOKEN"
sleep 2
write_meta "$LATE_PARKED_ID" "$LATE_PARKED_WS" "$LATE_PARKED_TAB" "$LATE_PARKED_PANE" "$(date +%s)"
[ "$(focus_snapshot)" = "$BEFORE_FOCUS" ] || fail 'anchor focus did not survive the mid-session restart'
wait_idle_shell "$LATE_PANE" || fail 'mid-session husk did not converge to the childless idle-shell shape'
INVENTORY=$(run_cleanup --dry-run 2>/dev/null) || fail 'mid-session dry-run inventory command failed'
[ "$(verdict_for "$INVENTORY" "$LATE_WS")" = close ] || fail "mid-session dry run did not mark the new husk close: $INVENTORY"
[ "$(verdict_for "$INVENTORY" "$LATE_PARKED_WS")" = keep ] || fail "mid-session dry run did not keep the new parked pane: $INVENTORY"
run_cleanup || fail 'mid-session housekeeping run failed'
if lab pane get "$LATE_PANE" >/dev/null 2>&1; then
  fail 'mid-session restored husk pane survived the housekeeping run'
fi
[ ! -e "$HOME_DIR/state/$LATE_ID.herdr-presentation" ] || fail 'mid-session husk journal survived the housekeeping run'
[ "$(cat "$HOME_DIR/state/$LATE_ID.meta")" = "$LATE_META_BEFORE" ] || fail 'housekeeping run edited the mid-session husk task record'
if lab pane get "$PARKED_PANE" >/dev/null 2>&1; then
  fail 'the earlier parked pane, whose shell the second restart replaced, survived the housekeeping run'
fi
lab pane get "$LATE_PARKED_PANE" >/dev/null 2>&1 || fail 'mid-session parked launch-shell pane was closed'
[ -e "$HOME_DIR/state/$LATE_PARKED_ID.herdr-presentation" ] || fail 'mid-session parked journal was retired'
lab pane get "$MOVED_PANE" >/dev/null 2>&1 || fail 'moved-record projection pane was closed by the housekeeping run'
[ "$(focus_snapshot)" = "$BEFORE_FOCUS" ] || fail 'housekeeping run changed focus'
STATUS=$(lab status --json) || fail 'could not read final named-lab version evidence'
pass 'real named lab housekeeping run retires a husk that appeared mid-session, preserves a parked launch shell, and leaves the default fleet session to the teardown tripwire'
printf 'evidence: herdr=%s protocol=%s default-session-tripwire=armed\n' \
  "$(printf '%s' "$STATUS" | jq -r '.client.version')" \
  "$(printf '%s' "$STATUS" | jq -r '.server.protocol')"

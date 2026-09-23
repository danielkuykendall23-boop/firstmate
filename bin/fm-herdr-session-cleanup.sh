#!/usr/bin/env bash
# Retire stale restored-shell Herdr presentation children inside the lock-owning
# session.
#
# Usage: fm-herdr-session-cleanup.sh [--dry-run]
#
# The caller must already own this Firstmate home's session lock. It runs at
# locked session start (bin/fm-session-start.sh) and again on the watcher's
# bounded slow-check cadence (bin/fm-watch.sh, FM_CHECK_INTERVAL) for the rest
# of that session, so a space that becomes provably unused mid-session
# disappears without a new session; it has no daemon or per-poll sweep of its
# own, and the watcher only carries its warnings to the triage log. This
# script is home-local and considers only the current named Herdr session and
# ordinary state/*.herdr-presentation journals in the effective FM_HOME. Each
# candidate
# is additionally serialized by the existing state/.spawn-<task>.lock and the
# shared named-session Herdr presentation lock, in that order.
#
# A visible title is discovery only. Cleanup requires the exact current
# "└ <concise-task> · p:<22-char-token>" grammar, one token occurrence across
# the named-session snapshot, exactly one matching home-local journal, one tab,
# one pane, absent task metadata, no registered agent, and a process proof
# that the pane contains only one idle recognized shell with no child process.
# A version 2 journal must also bind the exact workspace, tab, and pane.
# A task whose state/<task>.meta record still exists keeps its projected space
# however its pane looks - live, parked, exited, or a husk shell a Herdr server
# restart left behind - so a bin/fm-control.sh relaunch keeps landing in that
# task's own space.
# Topology is first checked from one locked API snapshot, then every mutation
# prerequisite is immediately rechecked before the existing exact-pane
# focus-preserving close helper is called.
# The script never closes a workspace and never edits task metadata. It removes
# only the matching journal, and only after the exact pane is confirmed gone.
# Every error warns and returns success so session startup, or the watcher's
# cycle, continues conservatively.
#
# --dry-run takes no lock and mutates nothing: it prints one tab-separated line
# per workspace carrying the projection title grammar in the named session -
# "close|keep <workspace-id> <task-id|-> <pane-id|-> <reason>" - so an operator
# can inspect exactly which spaces the locked run would retire and why every
# other one stays. Both modes read the one classifier below
# (fm_herdr_cleanup_classify); the locked run re-derives that verdict under
# its locks and revalidates before closing, so the preview is evidence, never
# authority.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-wake-lib.sh
. "$SCRIPT_DIR/fm-wake-lib.sh"
# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"
fm_backend_source herdr
# shellcheck source=bin/fm-pr-lib.sh
. "$SCRIPT_DIR/fm-pr-lib.sh"

fm_herdr_cleanup_warn() {
  printf 'warning: herdr projection cleanup: %s\n' "$*" >&2
}

fm_herdr_cleanup_title_token() { # <workspace-title>
  local title=$1 prefix token rest
  case "$title" in
    '└ '*' · p:'*) ;;
    *) return 1 ;;
  esac
  token=${title##*' · p:'}
  prefix=${title%" · p:$token"}
  [ "$prefix" != "$title" ] && [ -n "${prefix#'└ '}" ] || return 1
  [ "${#token}" -eq 22 ] || return 1
  case "$token" in *[!A-Za-z0-9_-]*) return 1 ;; esac
  rest=${title#*p:}
  [ "$rest" != "$title" ] || return 1
  case "$rest" in *p:*) return 1 ;; esac
  printf '%s' "$token"
}

fm_herdr_cleanup_home_identity() {
  [ -d "$FM_HOME" ] && [ ! -L "$FM_HOME" ] || return 1
  (cd "$FM_HOME" 2>/dev/null && pwd -P)
}

fm_herdr_cleanup_journal_matches() { # <title> <session> <home-real>
  local title=$1 session=$2 home_real=$3 journal id expected journal_home
  [ -d "$STATE" ] && [ ! -L "$STATE" ] || return 1
  for journal in "$STATE"/*"$FM_BACKEND_HERDR_PRESENTATION_JOURNAL_SUFFIX"; do
    [ -f "$journal" ] && [ ! -L "$journal" ] || continue
    id=$(basename "$journal" "$FM_BACKEND_HERDR_PRESENTATION_JOURNAL_SUFFIX")
    fm_task_id_creation_valid "$id" || continue
    fm_backend_herdr_projection_journal_snapshot "$journal" "$id" || continue
    if [ "$FM_BACKEND_HERDR_JOURNAL_VERSION" = 2 ]; then
      journal_home=$(fm_backend_herdr_projection_home_identity \
        "$FM_BACKEND_HERDR_JOURNAL_HOME" 2>/dev/null) || continue
      [ "$journal_home" = "$home_real" ] \
        && [ "$FM_BACKEND_HERDR_JOURNAL_SESSION" = "$session" ] || continue
    fi
    expected=$(fm_backend_herdr_projection_workspace_label \
      "$id" "$FM_BACKEND_HERDR_JOURNAL_PROJECTION_ID")
    [ "$expected" = "$title" ] || continue
    printf '%s\t%s\t%s\n' "$journal" "$id" "$FM_BACKEND_HERDR_JOURNAL_PROJECTION_ID"
  done
}

fm_herdr_cleanup_unique_match() { # <title> <session> <home-real>
  local title=$1 session=$2 home_real=$3 matches count record
  FM_HERDR_CLEANUP_JOURNAL=
  FM_HERDR_CLEANUP_ID=
  FM_HERDR_CLEANUP_TOKEN=
  FM_HERDR_CLEANUP_VERSION=
  FM_HERDR_CLEANUP_BOUND_WORKSPACE=
  FM_HERDR_CLEANUP_BOUND_TAB=
  FM_HERDR_CLEANUP_BOUND_PANE=
  matches=$(fm_herdr_cleanup_journal_matches "$title" "$session" "$home_real") || return 1
  count=$(printf '%s\n' "$matches" | awk 'NF { n++ } END { print n+0 }')
  [ "$count" -eq 1 ] || return 1
  record=$(printf '%s\n' "$matches" | awk 'NF { print; exit }')
  FM_HERDR_CLEANUP_JOURNAL=${record%%$'\t'*}
  record=${record#*$'\t'}
  FM_HERDR_CLEANUP_ID=${record%%$'\t'*}
  FM_HERDR_CLEANUP_TOKEN=${record#*$'\t'}
  [ -n "$FM_HERDR_CLEANUP_JOURNAL" ] \
    && [ -n "$FM_HERDR_CLEANUP_ID" ] \
    && [ -n "$FM_HERDR_CLEANUP_TOKEN" ] || return 1
  fm_backend_herdr_projection_journal_snapshot \
    "$FM_HERDR_CLEANUP_JOURNAL" "$FM_HERDR_CLEANUP_ID" || return 1
  [ "$FM_BACKEND_HERDR_JOURNAL_PROJECTION_ID" = "$FM_HERDR_CLEANUP_TOKEN" ] || return 1
  FM_HERDR_CLEANUP_VERSION=$FM_BACKEND_HERDR_JOURNAL_VERSION
  if [ "$FM_HERDR_CLEANUP_VERSION" = 2 ]; then
    FM_HERDR_CLEANUP_BOUND_WORKSPACE=$FM_BACKEND_HERDR_JOURNAL_WORKSPACE_ID
    FM_HERDR_CLEANUP_BOUND_TAB=$FM_BACKEND_HERDR_JOURNAL_TAB_ID
    FM_HERDR_CLEANUP_BOUND_PANE=$FM_BACKEND_HERDR_JOURNAL_PANE_ID
  fi
}

fm_herdr_cleanup_snapshot_candidate() { # <snapshot> <workspace> <title> <token> <bound-workspace> <bound-tab> <bound-pane>
  local snapshot=$1 workspace=$2 title=$3 token=$4
  local bound_workspace=$5 bound_tab=$6 bound_pane=$7 record
  FM_HERDR_CLEANUP_TAB=
  FM_HERDR_CLEANUP_PANE=
  record=$(printf '%s' "$snapshot" | jq -er \
    --arg workspace "$workspace" --arg title "$title" --arg token "$token" \
    --arg bound_workspace "$bound_workspace" --arg bound_tab "$bound_tab" \
    --arg bound_pane "$bound_pane" '
    .result.snapshot as $s
    | [$s.workspaces[]? | select(.workspace_id == $workspace)] as $workspaces
    | [$s.tabs[]? | select(.workspace_id == $workspace)] as $tabs
    | [$s.panes[]? | select(.workspace_id == $workspace)] as $panes
    | ([ $s.workspaces[]?.label? // "" |
         ((split("p:" + $token) | length) - 1) ] | add // 0) as $token_count
    | select($workspaces | length == 1)
    | select($workspaces[0].label == $title)
    | select($workspaces[0].tab_count == 1 and $workspaces[0].pane_count == 1)
    | select($tabs | length == 1)
    | select($panes | length == 1)
    | select($panes[0].tab_id == $tabs[0].tab_id)
    | select($bound_workspace == "" or $workspace == $bound_workspace)
    | select($bound_tab == "" or $tabs[0].tab_id == $bound_tab)
    | select($bound_pane == "" or $panes[0].pane_id == $bound_pane)
    | select($token_count == 1)
    | select(($s.focused_workspace_id | type) == "string")
    | select(($s.focused_tab_id | type) == "string")
    | select(($s.focused_pane_id | type) == "string")
    | select($s.focused_tab_id != $tabs[0].tab_id)
    | [$tabs[0].tab_id, $panes[0].pane_id] | @tsv
  ' 2>/dev/null) || return 1
  [ -n "$record" ] && [ "${record#*$'\t'}" != "$record" ] || return 1
  FM_HERDR_CLEANUP_TAB=${record%%$'\t'*}
  FM_HERDR_CLEANUP_PANE=${record#*$'\t'}
  [ -n "$FM_HERDR_CLEANUP_TAB" ] && [ -n "$FM_HERDR_CLEANUP_PANE" ]
}

fm_herdr_cleanup_meta_absent() { # <task-id>
  [ ! -e "$STATE/$1.meta" ] && [ ! -L "$STATE/$1.meta" ]
}

# fm_herdr_cleanup_classify: the one close/keep verdict for a workspace, read
# by both the locked run and --dry-run so neither can disagree with the other.
# Returns 1 when the title carries no projection grammar (not a candidate).
# Otherwise sets FM_HERDR_CLEANUP_VERDICT to close or keep and
# FM_HERDR_CLEANUP_REASON to why; FM_HERDR_CLEANUP_QUIET is 1 when the keep is
# an ordinary in-flight task (its task record still exists) that the locked
# run does not warn about. The record is checked before any Herdr read, so an
# in-flight task's pane never pays for the snapshot or the idle-shell proof.
# On close, the identity globals left by fm_herdr_cleanup_unique_match and
# fm_herdr_cleanup_snapshot_candidate describe the exact candidate.
fm_herdr_cleanup_classify() { # <session> <workspace> <title> <home-real>
  local session=$1 workspace=$2 title=$3 home_real=$4 token snapshot state
  FM_HERDR_CLEANUP_VERDICT=keep
  FM_HERDR_CLEANUP_REASON=
  FM_HERDR_CLEANUP_QUIET=0
  FM_HERDR_CLEANUP_TAB=
  FM_HERDR_CLEANUP_PANE=
  token=$(fm_herdr_cleanup_title_token "$title") || return 1
  if ! fm_herdr_cleanup_unique_match "$title" "$session" "$home_real" \
    || [ "$FM_HERDR_CLEANUP_TOKEN" != "$token" ]; then
    FM_HERDR_CLEANUP_REASON='no unique home-local journal correlates this token'
    return 0
  fi
  if ! fm_herdr_cleanup_meta_absent "$FM_HERDR_CLEANUP_ID"; then
    FM_HERDR_CLEANUP_QUIET=1
    FM_HERDR_CLEANUP_REASON='its task record still exists'
    return 0
  fi
  snapshot=$(fm_backend_herdr_cli "$session" api snapshot 2>/dev/null) || snapshot=
  if [ -z "$snapshot" ] \
    || ! fm_herdr_cleanup_snapshot_candidate \
      "$snapshot" "$workspace" "$title" "$token" \
      "$FM_HERDR_CLEANUP_BOUND_WORKSPACE" "$FM_HERDR_CLEANUP_BOUND_TAB" "$FM_HERDR_CLEANUP_BOUND_PANE"; then
    FM_HERDR_CLEANUP_REASON='the candidate snapshot was ambiguous: one tab holding one pane bound as journaled, one token occurrence, and focus elsewhere did not all hold'
    return 0
  fi
  state=$(fm_backend_herdr_pane_agent_state "$session" "$FM_HERDR_CLEANUP_PANE")
  if [ "$state" != no-agent ]; then
    FM_HERDR_CLEANUP_REASON="its pane agent state is $state"
    return 0
  fi
  if ! fm_backend_herdr_pane_idle_shell_pid "$session" "$FM_HERDR_CLEANUP_PANE" >/dev/null; then
    FM_HERDR_CLEANUP_REASON='its pane is not a provably idle childless shell'
    return 0
  fi
  FM_HERDR_CLEANUP_REASON='no task record remains for this projection'
  FM_HERDR_CLEANUP_VERDICT=close
}

fm_herdr_cleanup_revalidate() { # <session> <workspace> <tab> <pane> <title> <token> <home-real> <journal> <task-id> <version> <bound-workspace> <bound-tab> <bound-pane>
  local session=$1 workspace=$2 tab=$3 pane=$4 title=$5 token=$6 home_real=$7
  local journal=$8 id=$9 version=${10} bound_workspace=${11} bound_tab=${12} bound_pane=${13}
  local workspaces workspace_info tabs panes focus
  fm_herdr_cleanup_meta_absent "$id" || return 1
  fm_herdr_cleanup_unique_match "$title" "$session" "$home_real" || return 1
  [ "$FM_HERDR_CLEANUP_JOURNAL" = "$journal" ] \
    && [ "$FM_HERDR_CLEANUP_ID" = "$id" ] \
    && [ "$FM_HERDR_CLEANUP_TOKEN" = "$token" ] \
    && [ "$FM_HERDR_CLEANUP_VERSION" = "$version" ] \
    && [ "$FM_HERDR_CLEANUP_BOUND_WORKSPACE" = "$bound_workspace" ] \
    && [ "$FM_HERDR_CLEANUP_BOUND_TAB" = "$bound_tab" ] \
    && [ "$FM_HERDR_CLEANUP_BOUND_PANE" = "$bound_pane" ] || return 1

  workspaces=$(fm_backend_herdr_cli "$session" workspace list 2>/dev/null) || return 1
  printf '%s' "$workspaces" | jq -e --arg workspace "$workspace" --arg title "$title" --arg token "$token" '
    ([.result.workspaces[]? | select(.workspace_id == $workspace and .label == $title)] | length) == 1
    and ([.result.workspaces[]?.label? // "" |
          ((split("p:" + $token) | length) - 1)] | add // 0) == 1
  ' >/dev/null 2>&1 || return 1
  workspace_info=$(fm_backend_herdr_cli "$session" workspace get "$workspace" 2>/dev/null) || return 1
  printf '%s' "$workspace_info" | jq -e --arg workspace "$workspace" --arg title "$title" '
    .result.workspace.workspace_id == $workspace
    and .result.workspace.label == $title
    and .result.workspace.tab_count == 1
    and .result.workspace.pane_count == 1
  ' >/dev/null 2>&1 || return 1
  tabs=$(fm_backend_herdr_cli "$session" tab list --workspace "$workspace" 2>/dev/null) || return 1
  printf '%s' "$tabs" | jq -e --arg workspace "$workspace" --arg tab "$tab" '
    (.result.tabs | type) == "array"
    and (.result.tabs | length) == 1
    and .result.tabs[0].workspace_id == $workspace
    and .result.tabs[0].tab_id == $tab
  ' >/dev/null 2>&1 || return 1
  panes=$(fm_backend_herdr_cli "$session" pane list --workspace "$workspace" 2>/dev/null) || return 1
  printf '%s' "$panes" | jq -e --arg workspace "$workspace" --arg tab "$tab" --arg pane "$pane" '
    (.result.panes | type) == "array"
    and (.result.panes | length) == 1
    and .result.panes[0].workspace_id == $workspace
    and .result.panes[0].tab_id == $tab
    and .result.panes[0].pane_id == $pane
  ' >/dev/null 2>&1 || return 1
  [ "$(fm_backend_herdr_pane_agent_state "$session" "$pane")" = no-agent ] || return 1
  fm_backend_herdr_pane_idle_shell_pid "$session" "$pane" >/dev/null || return 1
  focus=$(fm_backend_herdr_projection_focus_snapshot "$session") || return 1
  [ "${focus#*$'\t'}" != "$tab" ]
}

fm_herdr_cleanup_release() { # <lock>...
  local lock
  for lock in "$@"; do
    [ -n "$lock" ] || continue
    fm_lock_release "$lock" || true
  done
}

fm_herdr_cleanup_one() { # <session> <workspace> <title> <home-real>
  local session=$1 workspace=$2 title=$3 home_real=$4 id task_lock presentation_lock
  local journal token version bound_workspace bound_tab bound_pane tab pane
  local state close_status=0
  fm_herdr_cleanup_title_token "$title" >/dev/null || return 0
  fm_herdr_cleanup_unique_match "$title" "$session" "$home_real" || return 0
  id=$FM_HERDR_CLEANUP_ID
  task_lock="$STATE/.spawn-$id.lock"
  if ! fm_lock_try_acquire "$task_lock"; then
    fm_herdr_cleanup_warn "$id skipped because its task lock is busy"
    return 0
  fi
  presentation_lock=$(fm_backend_herdr_presentation_session_lock_path "$session" 2>/dev/null) || {
    fm_herdr_cleanup_release "$task_lock"
    fm_herdr_cleanup_warn "$id skipped because the shared presentation lock is unavailable"
    return 0
  }
  if ! fm_lock_try_acquire "$presentation_lock"; then
    fm_herdr_cleanup_release "$task_lock"
    fm_herdr_cleanup_warn "$id skipped because the shared presentation lock is busy"
    return 0
  fi

  fm_herdr_cleanup_classify "$session" "$workspace" "$title" "$home_real" || true
  if [ "$FM_HERDR_CLEANUP_VERDICT" != close ]; then
    [ "$FM_HERDR_CLEANUP_QUIET" -eq 1 ] \
      || fm_herdr_cleanup_warn "$id preserved because $FM_HERDR_CLEANUP_REASON"
    fm_herdr_cleanup_release "$presentation_lock" "$task_lock"
    return 0
  fi
  if [ "$FM_HERDR_CLEANUP_ID" != "$id" ]; then
    fm_herdr_cleanup_warn "$id preserved because its journal identity changed under the locks"
    fm_herdr_cleanup_release "$presentation_lock" "$task_lock"
    return 0
  fi
  journal=$FM_HERDR_CLEANUP_JOURNAL
  token=$FM_HERDR_CLEANUP_TOKEN
  version=$FM_HERDR_CLEANUP_VERSION
  bound_workspace=$FM_HERDR_CLEANUP_BOUND_WORKSPACE
  bound_tab=$FM_HERDR_CLEANUP_BOUND_TAB
  bound_pane=$FM_HERDR_CLEANUP_BOUND_PANE
  tab=$FM_HERDR_CLEANUP_TAB
  pane=$FM_HERDR_CLEANUP_PANE
  if ! fm_herdr_cleanup_revalidate \
    "$session" "$workspace" "$tab" "$pane" "$title" "$token" "$home_real" \
    "$journal" "$id" "$version" "$bound_workspace" "$bound_tab" "$bound_pane"; then
    fm_herdr_cleanup_warn "$id preserved because immediate revalidation changed or was unreadable"
    fm_herdr_cleanup_release "$presentation_lock" "$task_lock"
    return 0
  fi

  # This unconditional retirement is the authorized containment documented
  # with the presentation floor ownership in bin/backends/herdr.sh.
  fm_backend_herdr_projection_close_pane_focus_preserving \
    "$session" "$pane" no-agent || close_status=$?
  state=$(fm_backend_herdr_pane_agent_state "$session" "$pane")
  if [ "$state" = dead ]; then
    if [ -f "$journal" ] && [ ! -L "$journal" ] \
      && fm_herdr_cleanup_unique_match "$title" "$session" "$home_real" \
      && [ "$FM_HERDR_CLEANUP_JOURNAL" = "$journal" ] \
      && [ "$FM_HERDR_CLEANUP_ID" = "$id" ] \
      && [ "$FM_HERDR_CLEANUP_VERSION" = "$version" ] \
      && [ "$FM_HERDR_CLEANUP_BOUND_WORKSPACE" = "$bound_workspace" ] \
      && [ "$FM_HERDR_CLEANUP_BOUND_TAB" = "$bound_tab" ] \
      && [ "$FM_HERDR_CLEANUP_BOUND_PANE" = "$bound_pane" ] \
      && fm_herdr_cleanup_meta_absent "$id"; then
      rm -f -- "$journal" || fm_herdr_cleanup_warn "$id pane closed but its journal could not be retired"
    else
      fm_herdr_cleanup_warn "$id pane closed but its journal changed and was preserved"
    fi
  elif [ "$close_status" -ne 0 ]; then
    fm_herdr_cleanup_warn "$id preserved because exact focus-safe pane closure was refused or unconfirmed"
  else
    fm_herdr_cleanup_warn "$id preserved because exact pane closure could not be confirmed"
  fi
  fm_herdr_cleanup_release "$presentation_lock" "$task_lock"
  return 0
}

# fm_herdr_cleanup_preview: print the shared classifier's verdict for one
# workspace as "close|keep <workspace> <task|-> <pane|-> <reason>", taking no
# lock and mutating nothing.
fm_herdr_cleanup_preview() { # <session> <workspace> <title> <home-real>
  fm_herdr_cleanup_classify "$1" "$2" "$3" "$4" || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' "$FM_HERDR_CLEANUP_VERDICT" "$2" \
    "${FM_HERDR_CLEANUP_ID:--}" "${FM_HERDR_CLEANUP_PANE:--}" "$FM_HERDR_CLEANUP_REASON"
}

fm_herdr_session_cleanup() { # [--dry-run]
  local dry_run=0 session home_real list candidates workspace title journal found=0
  [ "${1:-}" != --dry-run ] || dry_run=1
  [ -d "$STATE" ] && [ ! -L "$STATE" ] || return 0
  for journal in "$STATE"/*"$FM_BACKEND_HERDR_PRESENTATION_JOURNAL_SUFFIX"; do
    if [ -f "$journal" ] && [ ! -L "$journal" ]; then
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ] || return 0
  command -v herdr >/dev/null 2>&1 \
    && command -v jq >/dev/null 2>&1 || return 0
  home_real=$(fm_herdr_cleanup_home_identity) || {
    fm_herdr_cleanup_warn 'home identity is unreadable; preserving every candidate'
    return 0
  }
  session=$(fm_backend_herdr_session)
  list=$(fm_backend_herdr_cli "$session" workspace list 2>/dev/null) || {
    fm_herdr_cleanup_warn "session '$session' workspace discovery failed; preserving every candidate"
    return 0
  }
  candidates=$(printf '%s' "$list" | jq -er '
    .result.workspaces
    | select(type == "array")
    | .[]
    | select((.workspace_id | type) == "string" and (.workspace_id | length) > 0)
    | select((.label | type) == "string" and (.label | length) > 0)
    | [.workspace_id, .label] | @tsv
  ' 2>/dev/null) || {
    fm_herdr_cleanup_warn "session '$session' workspace discovery was unreadable; preserving every candidate"
    return 0
  }
  while IFS=$'\t' read -r workspace title; do
    [ -n "$workspace" ] && [ -n "$title" ] || continue
    if [ "$dry_run" -eq 1 ]; then
      fm_herdr_cleanup_preview "$session" "$workspace" "$title" "$home_real"
    else
      fm_herdr_cleanup_one "$session" "$workspace" "$title" "$home_real"
    fi
  done <<< "$candidates"
  return 0
}

if [ "${FM_HERDR_SESSION_CLEANUP_SOURCE_ONLY:-0}" != 1 ]; then
  case "${1:-}" in
    '') fm_herdr_session_cleanup ;;
    --dry-run) fm_herdr_session_cleanup --dry-run ;;
    *)
      echo "usage: fm-herdr-session-cleanup.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
  exit 0
fi

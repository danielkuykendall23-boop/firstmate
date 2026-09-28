#!/usr/bin/env bash
# Opt-in macOS Seatbelt write fence for Firstmate ship and scout workers.
#
# Usage:
#   fm-worker-sandbox.sh setting <config-dir>
#       Print the home's setting, "on" or "off", from <config-dir>/worker-sandbox.
#       Absent file = off, today's unsandboxed launch. The token is the file's
#       whitespace-trimmed content; any other value, or an unreadable file, is
#       an error (exit 1) so a malformed setting never launches unsandboxed.
#   fm-worker-sandbox.sh preflight <harness>
#       Exit 0 only when this machine can start <harness> fenced: macOS, a
#       usable /usr/bin/sandbox-exec, a harness in SUPPORTED_HARNESSES, and a
#       live probe proving a write inside the allowed tree succeeds while a
#       sibling write is denied. Otherwise print the reason and exit 1.
#   fm-worker-sandbox.sh profile --id <id> --harness <h> --worktree <dir>
#                                --task-tmp <dir> --state <dir> --data <dir>
#                                --output <file>
#       Write the task's Seatbelt profile to <file> (mode 0600), prove it
#       loads by running /usr/bin/true under it, and print the sandbox-exec
#       path that proof used; exit 1 and remove <file> on any failure.
#   FM_WORKER_SANDBOX_EXEC overrides /usr/bin/sandbox-exec, for tests only.
#
# WHY. Workers run with their harness's approval prompts off (omp
# --auto-approve), and a separate worktree keeps edits apart without being a
# security boundary. The profile turns that convention into an OS-enforced
# rule: the whole worker process tree - every tool, extension, hook, and
# subprocess - may write only the paths listed below. Reads and network stay
# open. bin/fm-spawn.sh wraps the launch as
#   /usr/bin/sandbox-exec -f <profile> /bin/sh -c '<launch>'
# and refuses the spawn when preflight or profile fails, never falling back to
# an unsandboxed worker.
#
# WHY A PROCESS WRAPPER AND NOT EACH HARNESS'S OWN SANDBOX. omp (18.2.x) has
# no native sandbox. Claude Code's /sandbox fences only Bash, PowerShell and
# Monitor commands; its Read, Edit and Write tools use the permission system,
# which Firstmate workers run bypassed, so it would leave file-tool writes
# unfenced. Seatbelt around the whole process is the mechanism both Claude
# Code and Codex use internally, and it covers every tool uniformly. Nested
# Seatbelt profiles are not supported, so a harness's own sandbox must stay
# off inside this wrapper.
#
# SUPPORTED_HARNESSES lists only harnesses proven end to end under this
# profile (docs/verification/worker-sandbox.md). Adding one requires its own
# harness-state paths below and a live proof; an unlisted harness refuses.
#
# Writable set (every path resolved to its real location, because Seatbelt
# matches resolved paths, e.g. /tmp is /private/tmp). No writable entry is an
# ancestor of a denied path, because a rename of that ancestor into another
# writable path would carry the denied path out of reach of its rule:
#   - the contents of the task worktree except its .git gitlink, and, in the
#     repository's shared git dir, only objects/, logs/, the contents of the
#     task's own linked-worktree admin dir worktrees/<name>/ (its HEAD, index,
#     FETCH_HEAD, ORIG_HEAD and rebase state) except its commondir, gitdir and
#     config.worktree, so a worker cannot repoint its checkout at a repository
#     it controls or set a hook or fsmonitor command that the unfenced primary
#     would run when it inspects the worktree with git; its own branch
#     refs/heads/fm/<id> and that ref's lock, and the shared refs/remotes/ and
#     refs/tags/ a fetch and push update, plus packed-refs.lock, which git
#     2.50 takes on every ref update and reports as an error when refused.
#     Every other branch ref, the primary checkout's HEAD and index, other
#     worktrees' admin dirs, hooks/, config and packed-refs itself stay
#     denied, so one worker cannot move another task's branch or checkout, or
#     plant code that runs in every other checkout. Residual: a worker can
#     still create or move a tag or remote-tracking ref and briefly hold the
#     packed-refs lock, and deleting a packed ref (e.g. fetch --prune of a
#     packed remote-tracking ref) fails because packed-refs is denied. The
#     worktree's files are still worker-written, so anything the primary does
#     beyond git in it (running its scripts, tests or project-local tool
#     configuration) runs worker-chosen code outside the fence. The task
#     worktree must be a linked worktree, never the primary checkout.
#   - the task temp root (/tmp/fm-<id>)
#   - Firstmate task files: state/<id>.status, .turn-ended, .progress,
#     .busy-state and its .busy-state.* lock and temp siblings, the steering
#     inbox state/<id>.inbox/, data/<id>/ (reports, findings snapshots,
#     review artifacts), and the task's own record state/<id>.meta with its
#     lock state/.meta-<id>.lock*, which the scout completion gate
#     (bin/fm-captain-hold.sh complete) records into; never another task's
#     files or any home-wide state
#   - no-mistakes (~/.no-mistakes): only what the worker-side CLI writes
#     (logs/cli.log, state.sqlite and its journal files, update-check.json,
#     telemetry-gate.json) and, in each gate repository repos/<gate>/, only
#     what a push of the task branch writes: objects/, logs/, the ref
#     refs/heads/fm/<id> and its lock, creating (never renaming) the
#     refs/heads/fm directory, packed-refs.lock, and the notify-push.log the
#     gate's hooks append to. Each gate's hooks/, config, config.worktree
#     (where a real gate sets core.hooksPath), info/, no-mistakes-gate-config,
#     other branch refs, and worktrees/<run>/ pipeline admin dirs stay
#     denied, as do config.yaml, bin/, the daemon's files, pipeline
#     worktrees/ and the gate directories themselves.
#   - the per-user macOS temp and cache dirs, ~/Library/Caches, ~/.cache and
#     the npm, bun, Go module and Cargo download caches, so builds and test
#     runs keep working; the tmux socket dir /private/tmp/tmux-<uid>
#   - the harness's own session state. omp: agent/sessions, agent/blobs,
#     agent/terminal-sessions, agent/cache, the agent, models and history
#     databases, logs/, cache/, run/, webcache/, stats.db and gpu_cache.json
#     under ~/.omp, plus a mode change on ~/.omp/agent itself, which omp makes
#     at startup. Shared omp configuration - agent/RULES.md, agent/rules,
#     agent/extensions, agent/config.yml, natives/ and everything else not
#     listed - stays denied.
#   - terminal and null devices
set -u

SUPPORTED_HARNESSES="omp"
SANDBOX_EXEC=${FM_WORKER_SANDBOX_EXEC:-/usr/bin/sandbox-exec}

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -u$/p' "$0" | sed -n '/^# Usage:/,/^#$/p' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# Print the real path of an existing directory, or of a not-yet-existing
# path whose parent directory exists.
real_path() {
  local path=$1 parent base
  if [ -d "$path" ]; then
    (CDPATH='' cd -P -- "$path" 2>/dev/null && pwd -P)
    return
  fi
  parent=$(dirname -- "$path")
  base=$(basename -- "$path")
  parent=$(CDPATH='' cd -P -- "$parent" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "${parent%/}" "$base"
}

# A path enters the profile as an SBPL string literal; refuse anything that
# would need escaping rather than trusting an escaper.
sbpl_path_ok() {
  case "$1" in
  /*) ;;
  *) return 1 ;;
  esac
  case "$1" in
  *'"'* | *\\* | *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

# Quote a path for use inside an SBPL regex literal.
regex_quote() {
  printf '%s' "$1" | sed 's/[.*+?(){}|^$[]/\\&/g; s/]/\\]/g'
}

# Print one SBPL filter per "kind|path" argument.
sbpl_rules() {
  local p
  for p in "$@"; do
    case "${p%%|*}" in
    regex) printf '\n  (regex #"%s")' "${p#*|}" ;;
    *) printf '\n  (%s "%s")' "${p%%|*}" "${p#*|}" ;;
    esac
  done
}

harness_supported() {
  local h
  for h in $SUPPORTED_HARNESSES; do
    [ "$1" = "$h" ] && return 0
  done
  return 1
}

cmd_setting() {
  local config=$1 file present token
  file="$config/worker-sandbox"
  if [ -e "$file" ] || [ -L "$file" ]; then present=1; else present=0; fi
  if [ "$present" = 0 ]; then
    printf 'off\n'
    return 0
  fi
  [ -f "$file" ] && [ -r "$file" ] ||
    die "config/worker-sandbox must be a readable regular file holding one of: on, off"
  token=$(tr -d '[:space:]' <"$file") || die "config/worker-sandbox could not be read"
  case "$token" in
  on | off) printf '%s\n' "$token" ;;
  *) die "config/worker-sandbox holds '$token'; accepted values are: on (fence ship and scout workers with the macOS Seatbelt sandbox), off (the default when the file is absent)" ;;
  esac
}

sandbox_exec_usable() {
  [ "$(uname -s)" = Darwin ] ||
    die "config/worker-sandbox is on, but the worker sandbox uses macOS Seatbelt and this machine is $(uname -s); refusing to launch the worker unsandboxed"
  [ -x "$SANDBOX_EXEC" ] ||
    die "config/worker-sandbox is on, but $SANDBOX_EXEC is not available; refusing to launch the worker unsandboxed"
}

cmd_preflight() {
  local harness=$1 dir status=0
  harness_supported "$harness" ||
    die "config/worker-sandbox is on, but the worker sandbox is verified only for: $SUPPORTED_HARNESSES; a $harness worker would run unsandboxed, so this spawn refuses - choose a supported harness or turn the setting off"
  sandbox_exec_usable
  dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-worker-sandbox-probe.XXXXXX") ||
    die "could not create a sandbox probe directory"
  dir=$(real_path "$dir") || die "could not resolve the sandbox probe directory"
  mkdir "$dir/in" "$dir/out" || status=1
  if [ "$status" = 0 ]; then
    printf '(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (literal "/dev/null") (subpath "%s/in"))\n' \
      "$dir" >"$dir/probe.sb" || status=1
  fi
  if [ "$status" = 0 ]; then
    # shellcheck disable=SC2016 # $1 expands in the sandboxed shell, not here
    "$SANDBOX_EXEC" -f "$dir/probe.sb" /bin/sh -c ': >"$1/in/allowed"; : >"$1/out/denied"' _ "$dir" \
      >/dev/null 2>&1
    if [ ! -f "$dir/in/allowed" ] || [ -e "$dir/out/denied" ]; then
      status=1
    fi
  fi
  rm -rf "$dir"
  [ "$status" = 0 ] ||
    die "config/worker-sandbox is on, but $SANDBOX_EXEC did not enforce a probe write fence on this machine; refusing to launch the worker unsandboxed"
}

cmd_profile() {
  local id='' harness='' worktree='' task_tmp='' state='' data='' output=''
  while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || usage
    case "$1" in
    --id) id=$2 ;;
    --harness) harness=$2 ;;
    --worktree) worktree=$2 ;;
    --task-tmp) task_tmp=$2 ;;
    --state) state=$2 ;;
    --data) data=$2 ;;
    --output) output=$2 ;;
    *) usage ;;
    esac
    shift 2
  done
  [ -n "$id" ] && [ -n "$harness" ] && [ -n "$worktree" ] && [ -n "$task_tmp" ] &&
    [ -n "$state" ] && [ -n "$data" ] && [ -n "$output" ] || usage
  # The same charset bin/fm-pr-lib.sh's fm_task_id_path_safe admits for ids.
  case "$id" in
  '' | .* | *[!A-Za-z0-9._-]*) die "task id '$id' is not path-safe" ;;
  esac
  harness_supported "$harness" ||
    die "the worker sandbox is verified only for: $SUPPORTED_HARNESSES (got $harness)"
  sandbox_exec_usable

  local wt common gitdir tmp st dt home nm gate omp uid paths=() p denies=() modes=() creates=()
  wt=$(real_path "$worktree") && [ -d "$wt" ] || die "worktree $worktree cannot be resolved"
  common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    die "worktree $wt has no resolvable git common dir"
  common=$(real_path "$common") || die "git common dir $common cannot be resolved"
  gitdir=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null) ||
    die "worktree $wt has no resolvable git dir"
  gitdir=$(real_path "$gitdir") || die "git dir $gitdir cannot be resolved"
  case "$gitdir" in
  "$common"/worktrees/?*) ;;
  *) die "worktree $wt is not a linked worktree of $common; the worker sandbox fences only a task's own linked worktree" ;;
  esac
  mkdir -p "$common/refs/heads/fm" 2>/dev/null ||
    die "could not create $common/refs/heads/fm for the task branch"
  tmp=$(real_path "$task_tmp") && [ -d "$tmp" ] || die "task temp root $task_tmp cannot be resolved"
  st=$(real_path "$state") && [ -d "$st" ] || die "state directory $state cannot be resolved"
  dt=$(real_path "$data") && [ -d "$dt" ] || die "data directory $data cannot be resolved"
  home=$(real_path "$HOME") && [ -d "$home" ] || die "HOME cannot be resolved"
  uid=$(id -u)

  paths+=("regex|^$(regex_quote "$wt")/" "subpath|$tmp")
  paths+=("subpath|$common/objects" "subpath|$common/logs" "regex|^$(regex_quote "$gitdir")/")
  denies+=("literal|$wt/.git" "literal|$gitdir/commondir" "literal|$gitdir/gitdir" "literal|$gitdir/config.worktree")
  paths+=("literal|$common/refs/heads/fm/$id" "literal|$common/refs/heads/fm/$id.lock")
  paths+=("subpath|$common/refs/remotes" "subpath|$common/refs/tags" "literal|$common/packed-refs.lock")
  paths+=("literal|$st/$id.status" "literal|$st/$id.turn-ended" "literal|$st/$id.progress")
  paths+=("literal|$st/$id.busy-state" "literal|$st/$id.busy-state.lock" "prefix|$st/$id.busy-state.tmp.")
  paths+=("subpath|$st/$id.inbox" "subpath|$dt/$id" "literal|$st/$id.meta")
  paths+=("literal|$st/.meta-$id.lock" "prefix|$st/.meta-$id.lock.owner.")
  paths+=("literal|$st/.meta-$id.lock.steal" "prefix|$st/.meta-$id.lock.steal.owner.")
  nm="$home/.no-mistakes"
  paths+=("prefix|$nm/logs/cli.log" "prefix|$nm/state.sqlite")
  paths+=("prefix|$nm/update-check.json" "prefix|$nm/telemetry-gate.json")
  gate="^$(regex_quote "$nm/repos/")[^/]+/"
  paths+=("regex|${gate}objects/" "regex|${gate}logs/" "regex|${gate}packed-refs\.lock\$")
  paths+=("regex|${gate}refs/heads/fm/$(regex_quote "$id")(\.lock)?\$" "regex|${gate}notify-push\.log\$")
  creates+=("regex|${gate}refs/heads/fm\$")
  for p in DARWIN_USER_TEMP_DIR DARWIN_USER_CACHE_DIR; do
    p=$(getconf "$p" 2>/dev/null) && [ -n "$p" ] && p=$(real_path "${p%/}") && paths+=("subpath|$p")
  done
  paths+=("subpath|$home/Library/Caches" "subpath|$home/.cache" "subpath|$home/.npm")
  paths+=("subpath|$home/.bun/install/cache" "subpath|$home/go/pkg/mod")
  paths+=("subpath|$home/.cargo/registry" "subpath|$home/.cargo/git")
  paths+=("subpath|/private/tmp/tmux-$uid")
  case "$harness" in
  omp)
    omp="$home/.omp"
    paths+=("subpath|$omp/agent/sessions" "subpath|$omp/agent/blobs")
    paths+=("subpath|$omp/agent/terminal-sessions" "subpath|$omp/agent/cache")
    paths+=("prefix|$omp/agent/agent.db" "prefix|$omp/agent/models.db" "prefix|$omp/agent/history.db")
    paths+=("subpath|$omp/logs" "subpath|$omp/cache" "subpath|$omp/run" "subpath|$omp/webcache")
    paths+=("prefix|$omp/stats.db" "literal|$omp/gpu_cache.json")
    modes+=("literal|$omp/agent")
    ;;
  esac

  for p in "${paths[@]}" "${denies[@]}" ${modes[@]+"${modes[@]}"}; do
    [ "${p%%|*}" = regex ] && continue
    sbpl_path_ok "${p#*|}" || die "path '${p#*|}' cannot be expressed safely in a sandbox profile"
  done

  local stage="$output.tmp.$$"
  if ! {
    printf ';; Firstmate worker sandbox for task %s (%s); generated by bin/fm-worker-sandbox.sh\n' "$id" "$harness"
    printf '(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n'
    printf '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx")\n'
    printf '  (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/")'
    sbpl_rules "${paths[@]}"
    printf ')\n(deny file-write*'
    sbpl_rules "${denies[@]}"
    printf ')\n(allow file-write-create'
    sbpl_rules "${creates[@]}"
    printf ')\n'
    if [ "${#modes[@]}" -gt 0 ]; then
      printf '(allow file-write-mode'
      sbpl_rules ${modes[@]+"${modes[@]}"}
      printf ')\n'
    fi
  } >"$stage"; then
    rm -f "$stage"
    die "could not write sandbox profile $output"
  fi
  if ! chmod 0600 "$stage" || ! mv -f "$stage" "$output"; then
    rm -f "$stage"
    die "could not publish sandbox profile $output"
  fi
  if ! "$SANDBOX_EXEC" -f "$output" /usr/bin/true >/dev/null 2>&1; then
    rm -f "$output"
    die "$SANDBOX_EXEC rejected the generated profile for $id; refusing to launch the worker unsandboxed"
  fi
  printf '%s\n' "$SANDBOX_EXEC"
}

[ "$#" -ge 1 ] || usage
cmd=$1
shift
case "$cmd" in
setting) [ "$#" -eq 1 ] || usage; cmd_setting "$1" ;;
preflight) [ "$#" -eq 1 ] || usage; cmd_preflight "$1" ;;
profile) cmd_profile "$@" ;;
-h | --help) usage ;;
*) usage ;;
esac

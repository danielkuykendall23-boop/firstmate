#!/usr/bin/env bash
# fm-jev-desktop.sh - run the installed Agent Desktop Jev operator.
# Usage: fm-jev-desktop.sh {run|act} --access-approved --ui-approved --app App <args...>
# The approval flags attest already-recorded permission for this exact app and
# the UI description sent to TypeSafe. They never grant permission themselves.
# run is for approved reversible goals and always adds --no-values. Names and
# titles still leave the machine. act is a plan unless --execute is supplied;
# installed act lacks --no-values, so that combination is refused, never ignored.
# Key: inherited TYPESAFE_API_KEY, else fmx_env_get from $FM_HOME/.env
# (FM_HOME defaults to FM_ROOT_OVERRIDE, then this code root). It reaches only
# the Node child environment, never command arguments or a generated launcher.
# Scripts: ~/.local/share/agent-desktop/<installed-version>/scripts/jev/.
# No downloads, operator substitutions, automatic approvals, or retries here.
# Exit: underlying operator's status; 1 missing dependency/key; 2 unsafe usage.
set +x
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
# shellcheck source=bin/fm-env-lib.sh
. "$SCRIPT_DIR/fm-env-lib.sh"

case "${1:-}" in
  --help|-h)
    printf '%s\n' 'Usage: fm-jev-desktop.sh {run|act} --access-approved --ui-approved --app App <args...>' \
      'Approve access and UI disclosure first. run always uses --no-values; act does not support it.' \
      'Use act without --execute for a potentially destructive step; confidence is not permission.'
    exit 0 ;;
  run|act) mode=$1; shift ;;
  *) echo 'fm-jev-desktop: expected run or act; see --help' >&2; exit 2 ;;
esac

key="${TYPESAFE_API_KEY:-}"
[ -n "$key" ] || key=$(fmx_env_get TYPESAFE_API_KEY "$FM_HOME/.env")
[ -n "$key" ] || { echo 'fm-jev-desktop: TYPESAFE_API_KEY absent; Jev-driven desktop actions paused' >&2; exit 1; }
access=0 ui=0 no_values=0
args=()
for arg in "$@"; do
  case "$arg" in
    --access-approved) access=1 ;;
    --ui-approved) ui=1 ;;
    --no-values) no_values=1; args+=("$arg") ;;
    *) args+=("$arg") ;;
  esac
done
if [ "$access" != 1 ] || [ "$ui" != 1 ]; then
  echo 'fm-jev-desktop: recorded app access and UI disclosure consent required (--access-approved --ui-approved)' >&2
  exit 2
fi
if [ "$mode" = act ] && [ "$no_values" = 1 ]; then
  echo 'fm-jev-desktop: installed act interface has no --no-values support; refusing to expose field values under that promise' >&2
  exit 2
fi
if [ "$mode" = run ] && [ "$no_values" = 0 ]; then args+=(--no-values); fi
command -v agent-desktop >/dev/null 2>&1 || { echo 'fm-jev-desktop: agent-desktop is not installed' >&2; exit 1; }
version_output=$(agent-desktop --version)
if [[ ! "$version_output" =~ ^agent-desktop[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo 'fm-jev-desktop: unsupported agent-desktop version output' >&2
  exit 1
fi
script="$HOME/.local/share/agent-desktop/${BASH_REMATCH[1]}/scripts/jev/$mode.mjs"
[ -f "$script" ] || { printf 'fm-jev-desktop: missing installed Jev script: %s\n' "$script" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'fm-jev-desktop: node is not installed' >&2; exit 1; }
TYPESAFE_API_KEY="$key" exec node "$script" "${args[@]}"

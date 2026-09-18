#!/usr/bin/env bash
# fm-jev-review-setup.sh - reversible opt-in installer for the vendored
# jev-review MCP server (NiazMorshed2007/jev-review, pinned commit and
# provenance in .omp/vendor/jev-review/NOTICE.md).
#
# jev-review is a stdio MCP server exposing one on-demand tool
# (`jev_review`, wire name `mcp__jev-review_jev-review`) that a session may
# call when it chooses to. Registering it in a user-scope mcp.json makes the
# tool available; it never runs automatically and is never a required review
# gate, because MCP tools are called at the agent's own discretion, not
# wired into any hook or lifecycle event.
#
# This script only ever writes the *user*-scope MCP config
# (~/.omp/agent/mcp.json by default), never this or any other project's
# .omp/mcp.json, so installing does not change behavior for any project that
# has not explicitly opted in by running this script on that machine.
#
# Usage:
#   fm-jev-review-setup.sh install     Register the vendored server.
#   fm-jev-review-setup.sh uninstall   Remove exactly the entry install added.
#   fm-jev-review-setup.sh status      Report whether it is registered.
#
# The target config file can be overridden for testing with
# FM_JEV_REVIEW_MCP_CONFIG=<path>; it defaults to ~/.omp/agent/mcp.json.
#
# Reversibility: install merges one mcpServers["jev-review"] entry into the
# current file and touches nothing else, so a repeat install is a no-op.
# uninstall deletes only that entry, and only while it still equals what
# install writes, so every other server - including ones added after
# install - survives untouched; an entry somebody has since edited is left
# in place and reported instead, because deleting it would discard their
# change. When only an empty mcpServers object would remain, uninstall
# removes the file, since an empty object configures nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="$REPO_ROOT/.omp/vendor/jev-review/dist/server.js"

config_path() {
  echo "${FM_JEV_REVIEW_MCP_CONFIG:-$HOME/.omp/agent/mcp.json}"
}

require_server() {
  if [[ ! -f "$SERVER_JS" ]]; then
    echo "fm-jev-review-setup.sh: vendored server missing at $SERVER_JS" >&2
    echo "See .omp/vendor/jev-review/NOTICE.md for provenance." >&2
    exit 1
  fi
}

owned_entry() {
  jq -cn --arg server "$SERVER_JS" '{"type": "stdio", "command": "node", "args": [$server]}'
}

is_installed() {
  local config="$1"
  [[ -f "$config" ]] && jq -e '.mcpServers["jev-review"] // empty' "$config" > /dev/null 2>&1
}

owns_entry() {
  local config="$1"
  jq -e --argjson owned "$(owned_entry)" '.mcpServers["jev-review"] == $owned' "$config" > /dev/null 2>&1
}

write_config() {
  local config="$1" content="$2"
  printf '%s\n' "$content" > "$config.tmp"
  mv "$config.tmp" "$config"
}

cmd_install() {
  require_server
  local config current updated
  config="$(config_path)"
  mkdir -p "$(dirname "$config")"

  current="$(cat "$config" 2> /dev/null || echo '{}')"
  if ! echo "$current" | jq -e . > /dev/null 2>&1; then
    echo "fm-jev-review-setup.sh: $config exists but is not valid JSON; refusing to merge" >&2
    exit 1
  fi

  updated="$(
    echo "$current" | jq --argjson owned "$(owned_entry)" \
      '.mcpServers = (.mcpServers // {}) | .mcpServers["jev-review"] = $owned'
  )"
  write_config "$config" "$updated"

  echo "fm-jev-review-setup.sh: registered jev-review (stdio) in $config"
  echo "The jev_review tool is now available on-demand; nothing calls it automatically."
  echo "Run 'fm-jev-review-setup.sh uninstall' to remove it."
}

cmd_uninstall() {
  local config updated
  config="$(config_path)"

  if ! is_installed "$config"; then
    echo "fm-jev-review-setup.sh: not installed, nothing to do"
    return 0
  fi

  if ! owns_entry "$config"; then
    echo "fm-jev-review-setup.sh: the jev-review entry in $config is not the one install writes; leaving it untouched" >&2
    echo "Remove or restore it by hand if that is what you intend." >&2
    exit 1
  fi

  updated="$(jq 'del(.mcpServers["jev-review"])' "$config")"
  if [[ "$(echo "$updated" | jq -c .)" == '{"mcpServers":{}}' ]]; then
    rm -f "$config"
    echo "fm-jev-review-setup.sh: removed jev-review; $config configured nothing else and was removed"
  else
    write_config "$config" "$updated"
    echo "fm-jev-review-setup.sh: removed the jev-review entry from $config; every other entry is untouched"
  fi
}

cmd_status() {
  local config
  config="$(config_path)"
  if is_installed "$config"; then
    echo "installed: jev-review is registered in $config"
    jq '.mcpServers["jev-review"]' "$config"
  else
    echo "not installed: jev-review is not registered in $config"
  fi
}

main() {
  local sub="${1:-}"
  case "$sub" in
    install) cmd_install ;;
    uninstall) cmd_uninstall ;;
    status) cmd_status ;;
    *)
      echo "usage: fm-jev-review-setup.sh {install|uninstall|status}" >&2
      exit 1
      ;;
  esac
}

main "$@"

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
#   fm-jev-review-setup.sh uninstall   Remove exactly what install added,
#                                      restoring the file to its prior state.
#   fm-jev-review-setup.sh status      Report whether it is registered.
#
# The target config file can be overridden for testing with
# FM_JEV_REVIEW_MCP_CONFIG=<path>; it defaults to ~/.omp/agent/mcp.json.
#
# Reversibility: install snapshots the config file's exact prior bytes (or
# records that it was absent) into "$CONFIG.pre-jev-review-backup" before
# writing, and only on the first install (a repeat install does not
# overwrite an existing snapshot with already-modified content). uninstall
# restores exactly that snapshot and removes the marker, so uninstall undoes
# install byte-for-byte rather than merely deleting the jev-review key.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="$REPO_ROOT/.omp/vendor/jev-review/dist/server.js"
ABSENT_MARKER="__FM_JEV_REVIEW_CONFIG_WAS_ABSENT__"

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

is_installed() {
  local config="$1"
  [[ -f "$config" ]] && jq -e '.mcpServers["jev-review"] // empty' "$config" > /dev/null 2>&1
}

cmd_install() {
  require_server
  local config backup
  config="$(config_path)"
  backup="$config.pre-jev-review-backup"
  mkdir -p "$(dirname "$config")"

  if [[ ! -e "$backup" ]]; then
    if [[ -f "$config" ]]; then
      cp "$config" "$backup"
    else
      printf '%s' "$ABSENT_MARKER" > "$backup"
    fi
  fi

  local current
  current="$(cat "$config" 2> /dev/null || echo '{}')"
  if ! echo "$current" | jq -e . > /dev/null 2>&1; then
    echo "fm-jev-review-setup.sh: $config exists but is not valid JSON; refusing to merge" >&2
    exit 1
  fi

  local updated
  updated="$(
    echo "$current" | jq \
      --arg cmd node \
      --arg server "$SERVER_JS" \
      '.mcpServers = (.mcpServers // {}) | .mcpServers["jev-review"] = {"type": "stdio", "command": $cmd, "args": [$server]}'
  )"
  printf '%s\n' "$updated" > "$config.tmp"
  mv "$config.tmp" "$config"

  echo "fm-jev-review-setup.sh: registered jev-review (stdio) in $config"
  echo "The jev_review tool is now available on-demand; nothing calls it automatically."
  echo "Run 'fm-jev-review-setup.sh uninstall' to remove it."
}

cmd_uninstall() {
  local config backup
  config="$(config_path)"
  backup="$config.pre-jev-review-backup"

  if [[ ! -e "$backup" ]]; then
    if is_installed "$config"; then
      echo "fm-jev-review-setup.sh: no install snapshot found; removing just the jev-review entry from $config" >&2
      local updated
      updated="$(jq 'del(.mcpServers["jev-review"])' "$config")"
      printf '%s\n' "$updated" > "$config.tmp"
      mv "$config.tmp" "$config"
      echo "fm-jev-review-setup.sh: removed jev-review entry from $config"
    else
      echo "fm-jev-review-setup.sh: not installed, nothing to do"
    fi
    return 0
  fi

  if [[ "$(cat "$backup")" == "$ABSENT_MARKER" ]]; then
    rm -f "$config"
  else
    cp "$backup" "$config"
  fi
  rm -f "$backup"
  echo "fm-jev-review-setup.sh: restored $config to its state before install"
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

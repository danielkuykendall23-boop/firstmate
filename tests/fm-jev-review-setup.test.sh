#!/usr/bin/env bash
# Tests for fm-jev-review-setup.sh, the reversible opt-in installer for the
# vendored jev-review MCP server.
#
# Every case points FM_JEV_REVIEW_MCP_CONFIG at its own temporary file, so no
# case ever reads or writes the real ~/.omp/agent/mcp.json on this host.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SETUP="$ROOT/bin/fm-jev-review-setup.sh"
TMP_ROOT=$(fm_test_tmproot fm-jev-review-setup)

run_setup() {
  local config="$1"
  shift
  FM_JEV_REVIEW_MCP_CONFIG="$config" "$SETUP" "$@"
}

test_status_reports_absent_before_install() {
  local config out
  config="$TMP_ROOT/status-absent/mcp.json"
  out=$(run_setup "$config" status)
  assert_contains "$out" "not installed" "status must report not-installed when the config file does not exist yet"
  assert_absent "$config" "status alone must never create the config file"
  pass "status reports not-installed and creates nothing when the config file is absent"
}

test_install_creates_config_pointing_at_the_vendored_server() {
  local config
  config="$TMP_ROOT/fresh-install/mcp.json"
  run_setup "$config" install > /dev/null
  assert_present "$config" "install must create the config file when none existed"
  local args
  args=$(jq -r '.mcpServers["jev-review"].args[0]' "$config")
  assert_equals "$ROOT/.omp/vendor/jev-review/dist/server.js" "$args" "the installed entry must point at the vendored server.js, not some other copy"
  assert_equals stdio "$(jq -r '.mcpServers["jev-review"].type' "$config")" "the installed entry must use the stdio transport jev-review actually speaks"
  pass "install registers the vendored server at its real path"
}

test_uninstall_after_fresh_install_removes_the_file_entirely() {
  local config
  config="$TMP_ROOT/fresh-roundtrip/mcp.json"
  run_setup "$config" install > /dev/null
  run_setup "$config" uninstall > /dev/null
  assert_absent "$config" "uninstall must remove a config file that did not exist before install"
  assert_absent "$config.pre-jev-review-backup" "uninstall must clean up its own backup marker"
  pass "uninstalling a fresh install leaves no config file behind, exactly as before install"
}

test_install_preserves_an_unrelated_existing_server_entry() {
  local config
  config="$TMP_ROOT/preserve/mcp.json"
  mkdir -p "$(dirname "$config")"
  cat > "$config" << 'EOF'
{
  "mcpServers": {
    "some-other-server": { "type": "stdio", "command": "node", "args": ["/opt/other/server.js"] }
  }
}
EOF
  run_setup "$config" install > /dev/null
  assert_equals '"/opt/other/server.js"' "$(jq -c '.mcpServers["some-other-server"].args[0]' "$config")" "install must not disturb an unrelated existing server entry"
  assert_equals stdio "$(jq -r '.mcpServers["jev-review"].type' "$config")" "install must still add its own entry alongside the existing one"
  pass "install merges into an existing config without disturbing other servers"
}

test_uninstall_restores_a_preexisting_config_byte_for_byte() {
  local config before after
  config="$TMP_ROOT/restore/mcp.json"
  mkdir -p "$(dirname "$config")"
  cat > "$config" << 'EOF'
{
  "mcpServers": {
    "some-other-server": { "type": "stdio", "command": "node", "args": ["/opt/other/server.js"] }
  }
}
EOF
  before=$(jq -S . "$config")
  run_setup "$config" install > /dev/null
  run_setup "$config" uninstall > /dev/null
  after=$(jq -S . "$config")
  assert_equals "$before" "$after" "uninstall must restore a config that pre-existed install to its exact prior content"
  assert_absent "$config.pre-jev-review-backup" "uninstall must clean up its own backup marker after restoring"
  pass "uninstall restores a pre-existing config to its exact prior content"
}

test_repeat_install_does_not_clobber_the_reversibility_snapshot() {
  local config before after
  config="$TMP_ROOT/repeat-install/mcp.json"
  mkdir -p "$(dirname "$config")"
  cat > "$config" << 'EOF'
{
  "mcpServers": {
    "some-other-server": { "type": "stdio", "command": "node", "args": ["/opt/other/server.js"] }
  }
}
EOF
  before=$(jq -S . "$config")
  run_setup "$config" install > /dev/null
  run_setup "$config" install > /dev/null
  run_setup "$config" uninstall > /dev/null
  after=$(jq -S . "$config")
  assert_equals "$before" "$after" "installing twice must still uninstall back to the original pre-install content, not the once-modified state"
  pass "a repeat install does not overwrite the original reversibility snapshot"
}

test_status_reflects_current_state() {
  local config out
  config="$TMP_ROOT/status-cycle/mcp.json"
  run_setup "$config" install > /dev/null
  out=$(run_setup "$config" status)
  assert_contains "$out" "installed:" "status must report installed right after install"
  run_setup "$config" uninstall > /dev/null
  out=$(run_setup "$config" status)
  assert_contains "$out" "not installed" "status must report not-installed right after uninstall"
  pass "status reflects install and uninstall as they happen"
}

test_uninstall_without_prior_install_is_a_silent_no_op() {
  local config out
  config="$TMP_ROOT/uninstall-noop/mcp.json"
  out=$(run_setup "$config" uninstall)
  assert_contains "$out" "nothing to do" "uninstalling with no install and no existing config must be reported as a no-op, not an error"
  assert_absent "$config" "uninstall must never create a config file where none existed"
  pass "uninstalling with nothing installed is a reported no-op"
}

test_install_refuses_a_config_file_that_is_not_valid_json() {
  local config
  config="$TMP_ROOT/invalid-json/mcp.json"
  mkdir -p "$(dirname "$config")"
  printf 'not json at all' > "$config"
  if run_setup "$config" install > /dev/null 2>&1; then
    fail "install must refuse to merge into a config file that is not valid JSON"
  fi
  assert_equals "not json at all" "$(cat "$config")" "a refused install must leave the invalid file untouched"
  pass "install refuses rather than overwriting a config file that is not valid JSON"
}

test_invalid_subcommand_is_refused() {
  local config
  config="$TMP_ROOT/bad-subcommand/mcp.json"
  if run_setup "$config" bogus > /dev/null 2>&1; then
    fail "an unrecognized subcommand must exit non-zero"
  fi
  assert_absent "$config" "an unrecognized subcommand must not create the config file"
  pass "an unrecognized subcommand is refused without touching the config file"
}

test_status_reports_absent_before_install
test_install_creates_config_pointing_at_the_vendored_server
test_uninstall_after_fresh_install_removes_the_file_entirely
test_install_preserves_an_unrelated_existing_server_entry
test_uninstall_restores_a_preexisting_config_byte_for_byte
test_repeat_install_does_not_clobber_the_reversibility_snapshot
test_status_reflects_current_state
test_uninstall_without_prior_install_is_a_silent_no_op
test_install_refuses_a_config_file_that_is_not_valid_json
test_invalid_subcommand_is_refused

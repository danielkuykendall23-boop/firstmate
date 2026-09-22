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

seed_config_with_other_server() {
  local config="$1"
  mkdir -p "$(dirname "$config")"
  cat > "$config" << 'EOF_CONFIG'
{
  "mcpServers": {
    "some-other-server": { "type": "stdio", "command": "node", "args": ["/opt/other/server.js"] }
  }
}
EOF_CONFIG
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
  assert_absent "$config" "uninstall must remove a config file that would otherwise hold only an empty mcpServers object"
  assert_absent "$config.tmp" "uninstall must not leave its scratch file behind"
  pass "uninstalling a fresh install leaves no config file behind"
}

test_install_preserves_an_unrelated_existing_server_entry() {
  local config
  config="$TMP_ROOT/preserve/mcp.json"
  seed_config_with_other_server "$config"
  run_setup "$config" install > /dev/null
  assert_equals '"/opt/other/server.js"' "$(jq -c '.mcpServers["some-other-server"].args[0]' "$config")" "install must not disturb an unrelated existing server entry"
  assert_equals stdio "$(jq -r '.mcpServers["jev-review"].type' "$config")" "install must still add its own entry alongside the existing one"
  pass "install merges into an existing config without disturbing other servers"
}

test_uninstall_removes_only_the_jev_review_entry() {
  local config before after
  config="$TMP_ROOT/surgical/mcp.json"
  seed_config_with_other_server "$config"
  before=$(jq -S . "$config")
  run_setup "$config" install > /dev/null
  run_setup "$config" uninstall > /dev/null
  after=$(jq -S . "$config")
  assert_equals "$before" "$after" "uninstall must leave a pre-existing config holding exactly what it held before install"
  pass "uninstall removes only the jev-review entry and leaves the pre-existing server alone"
}

test_uninstall_preserves_a_server_added_after_install() {
  local config
  config="$TMP_ROOT/added-later/mcp.json"
  seed_config_with_other_server "$config"
  run_setup "$config" install > /dev/null
  jq '.mcpServers["added-later"] = {"type": "stdio", "command": "node", "args": ["/opt/later/server.js"]}' "$config" > "$config.edit"
  mv "$config.edit" "$config"
  run_setup "$config" uninstall > /dev/null
  assert_equals '"/opt/later/server.js"' "$(jq -c '.mcpServers["added-later"].args[0]' "$config")" "a server the user added after install must survive uninstall"
  assert_equals '"/opt/other/server.js"' "$(jq -c '.mcpServers["some-other-server"].args[0]' "$config")" "the pre-existing server must survive uninstall too"
  assert_equals null "$(jq -c '.mcpServers["jev-review"]' "$config")" "the jev-review entry itself must be gone"
  pass "uninstall keeps servers added after install instead of restoring a stale snapshot"
}

test_repeat_install_is_idempotent_and_uninstall_still_removes_only_its_entry() {
  local config before after
  config="$TMP_ROOT/repeat-install/mcp.json"
  seed_config_with_other_server "$config"
  before=$(jq -S . "$config")
  run_setup "$config" install > /dev/null
  run_setup "$config" install > /dev/null
  assert_equals 2 "$(jq '.mcpServers | length' "$config")" "installing twice must leave exactly one jev-review entry beside the existing server"
  run_setup "$config" uninstall > /dev/null
  after=$(jq -S . "$config")
  assert_equals "$before" "$after" "installing twice then uninstalling must leave the original content, not a modified state"
  pass "a repeat install is a no-op and a later uninstall still removes only the jev-review entry"
}

test_uninstall_refuses_a_jev_review_entry_somebody_edited() {
  local config
  config="$TMP_ROOT/edited-entry/mcp.json"
  seed_config_with_other_server "$config"
  run_setup "$config" install > /dev/null
  jq '.mcpServers["jev-review"].args += ["--verbose"]' "$config" > "$config.edit"
  mv "$config.edit" "$config"
  if run_setup "$config" uninstall > /dev/null 2>&1; then
    fail "uninstall must refuse to delete a jev-review entry that no longer matches what install wrote"
  fi
  assert_equals '"--verbose"' "$(jq -c '.mcpServers["jev-review"].args[1]' "$config")" "a refused uninstall must leave the edited entry exactly as it was"
  assert_equals '"/opt/other/server.js"' "$(jq -c '.mcpServers["some-other-server"].args[0]' "$config")" "a refused uninstall must leave every other entry as it was"
  pass "uninstall refuses rather than discarding a jev-review entry the user has edited"
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
test_uninstall_removes_only_the_jev_review_entry
test_uninstall_preserves_a_server_added_after_install
test_repeat_install_is_idempotent_and_uninstall_still_removes_only_its_entry
test_uninstall_refuses_a_jev_review_entry_somebody_edited
test_status_reflects_current_state
test_uninstall_without_prior_install_is_a_silent_no_op
test_install_refuses_a_config_file_that_is_not_valid_json
test_invalid_subcommand_is_refused

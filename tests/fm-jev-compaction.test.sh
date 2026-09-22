#!/usr/bin/env bash
# Runs the Node-native behavior suite for .omp/extensions/fm-jev-compaction.ts.
# The suite lives in tests/fm-jev-compaction.node.test.ts (Node 24's built-in
# type stripping loads it directly, matching how omp itself loads the
# extension with no build step) and never contacts the real Jev endpoint;
# every test drives the pure decision/rendering functions or a fake fetch.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v node >/dev/null 2>&1 || fail "node is required to run the fm-jev-compaction suite"

# The suite and the extension are loaded as .ts through Node's own unflagged
# type stripping, which exists from Node 22.18, 23.6, and 24; CI provisions
# Node 24 for the shard that runs this. An older Node is named here rather
# than reported as a suite failure.
node_version=$(node -p 'process.versions.node' 2>/dev/null) || fail "could not read the Node version"
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
case "$node_major$node_minor" in
  ''|*[!0-9]*) fail "unrecognized Node version '$node_version'" ;;
esac
if [ "$node_major" -lt 22 ] \
  || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; } \
  || { [ "$node_major" -eq 23 ] && [ "$node_minor" -lt 6 ]; }; then
  fail "Node $node_version cannot load tests/fm-jev-compaction.node.test.ts: unflagged TypeScript type stripping needs Node 22.18, 23.6, or 24 and later (CI provisions Node 24)"
fi

out=$(node --test "$ROOT/tests/fm-jev-compaction.node.test.ts" "$ROOT/tests/fm-jev-review.node.test.ts" 2>&1)
code=$?

if [ "$code" -ne 0 ]; then
  printf '%s\n' "$out" >&2
  fail "Jev Node behavior suites reported a failure (exit $code)"
fi

assert_contains "$out" "fail 0" "expected zero failing Node subtests"
pass "Jev compaction and review Node behavior suites passed"

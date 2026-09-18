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

out=$(node --test "$ROOT/tests/fm-jev-compaction.node.test.ts" 2>&1)
code=$?

if [ "$code" -ne 0 ]; then
  printf '%s\n' "$out" >&2
  fail "fm-jev-compaction.node.test.ts reported a failure (exit $code)"
fi

assert_contains "$out" "fail 0" "expected zero failing Node subtests"
pass "fm-jev-compaction.node.test.ts passed"

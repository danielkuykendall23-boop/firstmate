#!/usr/bin/env bash
# Portable routing event and fallback regression; no credentials or model calls.
set -u
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v node >/dev/null 2>&1 || { echo 'skip: node is required'; exit 0; }
node --experimental-strip-types --test "$ROOT/tests/fm-jev-route.node.test.ts"

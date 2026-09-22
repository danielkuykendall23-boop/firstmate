#!/usr/bin/env bash
# Real OMP RPC and interactive terminal sessions with loopback endpoints; no
# credentials, vendor calls, or model tokens.
set -u
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate default-on FM_JEV_ROUTE_LIVE_E2E omp node curl jq python3
node "$ROOT/tests/fm-jev-route-rpc.mjs"

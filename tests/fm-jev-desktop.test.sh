#!/usr/bin/env bash
# Desktop wrapper output/consent/environment contract. No desktop is observed.
set -euo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB=$(fm_test_tmproot fm-jev-desktop)
mkdir -p "$LAB/bin" "$LAB/home" "$LAB/fleet"
cat > "$LAB/bin/agent-desktop" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'agent-desktop 0.9.2'
SH
cat > "$LAB/bin/node" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "child-key=${TYPESAFE_API_KEY:-missing}"
printf 'arg=%s\n' "$@"
exit "${FAKE_NODE_EXIT:-0}"
SH
chmod +x "$LAB/bin/agent-desktop" "$LAB/bin/node"
run_wrapper() {
  env -u TYPESAFE_API_KEY HOME="$LAB/home" FM_HOME="$LAB/fleet" PATH="$LAB/bin:$PATH" \
    "$ROOT/bin/fm-jev-desktop.sh" "$@"
}
if out=$(run_wrapper run --app Synthetic 'read label' 2>&1); then fail 'missing key should refuse'; fi
assert_contains "$out" 'TYPESAFE_API_KEY absent' 'missing key must disclose pause'
printf '%s\n' 'TYPESAFE_API_KEY="synthetic-file-key"' > "$LAB/fleet/.env"
if out=$(run_wrapper run --app Synthetic 'read label' 2>&1); then fail 'unapproved access should refuse'; fi
assert_contains "$out" 'consent required' 'UI must not be observed before consent'
if out=$(run_wrapper run --access-approved --ui-approved --app Synthetic 'read label' 2>&1); then fail 'missing Jev script should refuse'; fi
assert_contains "$out" 'missing installed Jev script' 'no alternate desktop operator may be substituted'
scripts="$LAB/home/.local/share/agent-desktop/0.9.2/scripts/jev"
mkdir -p "$scripts"
touch "$scripts/run.mjs" "$scripts/act.mjs"
out=$(run_wrapper run --access-approved --ui-approved --app Synthetic 'read label')
assert_contains "$out" 'child-key=synthetic-file-key' 'file key reaches the Node child'
assert_contains "$out" 'arg=--no-values' 'run withholds field values by default'
case "$out" in *'arg=synthetic-file-key'*) fail 'credential leaked into child arguments' ;; esac
out=$(TYPESAFE_API_KEY=synthetic-env-key HOME="$LAB/home" FM_HOME="$LAB/fleet" PATH="$LAB/bin:$PATH" \
  "$ROOT/bin/fm-jev-desktop.sh" act --access-approved --ui-approved --app Synthetic 'read label')
assert_contains "$out" 'child-key=synthetic-env-key' 'inherited key overrides file key'
if out=$(run_wrapper act --access-approved --ui-approved --no-values --app Synthetic 'read label' 2>&1); then fail 'act cannot silently ignore no-values'; fi
assert_contains "$out" 'no --no-values support' 'unsupported privacy promise must refuse'
if FAKE_NODE_EXIT=7 run_wrapper run --access-approved --ui-approved --app Synthetic 'read label' >/dev/null; then fail 'operator failure should be preserved'; else code=$?; fi
assert_equals 7 "$code" 'Jev failure is not converted into success'
[ "${TYPESAFE_API_KEY:-}" != synthetic-file-key ] || fail 'file key escaped the wrapper'
pass 'Jev desktop refuses missing key/consent/script, preserves failures, and supplies only child environment credentials'

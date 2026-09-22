#!/usr/bin/env bash
# Live, opt-in proof that .omp/extensions/fm-jev-compaction.ts behaves inside
# a real omp process the way tests/fm-jev-compaction.node.test.ts proves it
# behaves in isolation: a resumed synthetic session is compacted over omp's
# own RPC `compact` command with the extension loaded from the project's
# .omp/extensions/, Jev requests go to a local fake System One endpoint via
# FM_JEV_ENDPOINT, and omp's own `config get` answers the Hide Secrets gate.
# No credentials, no real TypeSafe or provider traffic, no captain data: the
# agent directory, HOME, project, and session directory are all scratch.
#
# Cases, each one real omp run:
#   tools-550k   ~550k-token tool-heavy history: Jev installs the replacement
#                (compaction entry with fromExtension and the Jev record).
#   text-550k    ~550k tokens of irreducible prose: zero Jev requests, honest
#                fallback, and omp's own native method order completes the
#                compaction instead (a native, not extension, entry on disk).
#   secrets-on   agent config.yml turns Hide Secrets on: declined before any
#                request, with omp itself as the source.
#   shadow-A     agent on, project .omp/config.yml holds a bare `secrets:`
#                group: omp keeps it on (group shadow rule), so declined.
#   overlay-on   --config overlay turns it on: declined via the overlay.
#   worker       the tracked .omp/fm-worker-overlay.yml every Firstmate omp
#                launch carries: proceeds and installs.
# The tool-heavy cases also plant an excludeFromContext bash execution
# carrying a marker and prove it never reaches the fake endpoint.
#
# Opt in with FM_JEV_COMPACTION_LIVE_E2E=1; needs omp, node, and jq.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate opt-in FM_JEV_COMPACTION_LIVE_E2E omp node jq

LAB=$(fm_test_tmproot fm-jev-compaction-live-e2e)
OMP_BIN=$(command -v omp)
DRIVER="$LAB/drive.mjs"

cat > "$DRIVER" <<'DRIVER_EOF'
// Runs one case: builds a scratch omp agent dir, home, project (with the
// extension copied in), and a synthetic resumed session; serves a fake
// System One endpoint; launches real omp in RPC mode; sends get_state and
// compact; then reports what omp, the extension, the endpoint, and the
// session file on disk show.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=")]; }));
const caseDir = join(args.lab, args.case);
const agent = join(caseDir, "agent"), home = join(caseDir, "home"), project = join(caseDir, "project"), sessions = join(caseDir, "sessions");
for (const d of [agent, home, join(project, ".omp", "extensions"), sessions]) mkdirSync(d, { recursive: true });
cpSync(join(args.root, ".omp", "extensions", "fm-jev-compaction.ts"), join(project, ".omp", "extensions", "fm-jev-compaction.ts"));
cpSync(join(args.root, ".omp", "extensions", "vendor"), join(project, ".omp", "extensions", "vendor"), { recursive: true });
if (args.agentConfig) writeFileSync(join(agent, "config.yml"), args.agentConfig.replace(/\\n/g, "\n"));
if (args.projectConfig) writeFileSync(join(project, ".omp", "config.yml"), args.projectConfig.replace(/\\n/g, "\n"));

// ---- synthetic session in omp's own v3 JSONL shape ----
const MARKER = "EXCLUDED-BASH-MARKER-" + Math.random().toString(16).slice(2);
const KEPT = "the important invariant the run must keep";
let seq = 0; const nextId = () => (seq++).toString(16).padStart(8, "0");
const lines = [JSON.stringify({ type: "session", version: 3, id: `synthetic-${args.case}`, timestamp: new Date().toISOString(), cwd: project })];
let parent = null; let chars = 0;
const push = (message) => { const e = { type: "message", id: nextId(), parentId: parent, timestamp: new Date().toISOString(), message }; parent = e.id; lines.push(JSON.stringify(e)); };
const usage = () => { const ctx = Math.floor(chars / 4); return { input: ctx, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: ctx + 60, contextTokens: ctx, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; };
const assistant = { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5.1-codex-max" };
const turns = Number(args.turns), targetChars = Number(args.targetChars);
const perTurn = Math.floor(targetChars / turns);
push({ role: "user", content: [{ type: "text", text: `Investigate the failing build across the repository. ${KEPT}.` }], timestamp: Date.now() });
push({ role: "bashExecution", command: "cat .env", output: `AWS_SECRET_ACCESS_KEY=${MARKER}`, exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: Date.now() });
for (let i = 0; i < turns; i++) {
  if (args.kind === "tools") {
    const line = `drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir${i}/file-${i}.ts\n`;
    const listing = line.repeat(Math.ceil(perTurn / line.length));
    chars += listing.length;
    push({ ...assistant, content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: { command: `ls -la dir${i}` } }], usage: usage(), stopReason: "toolUse", timestamp: Date.now() });
    push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", content: [{ type: "text", text: listing }], isError: false, timestamp: Date.now() });
    push({ ...assistant, content: [{ type: "text", text: `Listing ${i} noted.` }], usage: usage(), stopReason: "stop", timestamp: Date.now() });
  } else {
    const sentence = `Analysis ${i}: the scheduler retry path re-enters the queue boundary, and each retry widens the regression window. `;
    const prose = sentence.repeat(Math.ceil(perTurn / sentence.length));
    chars += prose.length;
    push({ role: "user", content: [{ type: "text", text: `Explain part ${i} in depth.` }], timestamp: Date.now() });
    push({ ...assistant, content: [{ type: "text", text: prose }], usage: usage(), stopReason: "stop", timestamp: Date.now() });
  }
}
push({ role: "user", content: [{ type: "text", text: "Now summarize what we learned so far." }], timestamp: Date.now() });
push({ ...assistant, content: [{ type: "text", text: "Summarizing: the scheduler retry path is the culprit." }], usage: usage(), stopReason: "stop", timestamp: Date.now() });
const sessionFile = join(sessions, `synthetic-${args.case}.jsonl`);
writeFileSync(sessionFile, lines.join("\n") + "\n");

// ---- fake System One endpoint: keep the first collected call, drop the rest ----
const endpoint = { hits: 0, markerLeaked: false, questions: 0 };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    endpoint.hits += 1;
    if (body.includes(MARKER)) endpoint.markerLeaked = true;
    const parsed = JSON.parse(body);
    const answers = {};
    for (const q of Object.keys(parsed.questions)) { endpoint.questions += 1; answers[q] = { type: "noul", noul: q.endsWith("_t1") ? 0.95 : 0.05 }; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

// ---- real omp, RPC mode ----
const ompArgs = ["--mode", "rpc", "--session-dir", sessions, "--resume", sessionFile, "--cwd", project, "--model", "openai/gpt-5.1-codex-max"];
if (args.overlay) ompArgs.push("--config", args.overlay);
const env = {
  ...process.env, PI_CODING_AGENT_DIR: agent, HOME: home, OMP_SKIP_SETUP: "1",
  FM_JEV_COMPACTION: "1", TYPESAFE_API_KEY: "fake-live-key-never-valid",
  FM_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/systemone`,
};
const child = spawn(args.omp, ompArgs, { cwd: project, stdio: ["pipe", "pipe", "pipe"], env });
let out = "", err = "", sent = false; const started = Date.now();
const report = { case: args.case, kind: args.kind, sessionChars: chars, approxTokens: Math.floor(chars / 4), model: null, compact: null, jevStatus: [], jevStderr: [], endpoint, compactionEntries: [], durationMs: 0 };
const finish = () => setTimeout(() => child.kill("SIGTERM"), 800);
child.stdout.on("data", (d) => {
  out += d;
  if (!sent && out.includes('"type":"ready"')) { sent = true; child.stdin.write(JSON.stringify({ id: "s", type: "get_state" }) + "\n"); child.stdin.write(JSON.stringify({ id: "c", type: "compact" }) + "\n"); }
  if (out.includes('"command":"compact"')) finish();
});
child.stderr.on("data", (d) => { err += d; });
const killer = setTimeout(() => child.kill("SIGKILL"), Number(args.timeoutMs ?? 180000));
child.on("exit", () => {
  clearTimeout(killer);
  report.durationMs = Date.now() - started;
  for (const l of out.split("\n").filter(Boolean)) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === "response" && j.command === "get_state") report.model = { id: j.data?.model?.id, contextWindow: j.data?.model?.contextWindow };
    if (j.type === "response" && j.command === "compact") report.compact = { success: j.success, error: j.error ?? null, dataKeys: j.data && typeof j.data === "object" ? Object.keys(j.data) : typeof j.data };
    if (j.type === "extension_ui_request" && j.statusKey === "jev-compaction") report.jevStatus.push(j.statusText);
    if (j.type === "extension_error") report.jevStderr.push(`extension_error: ${JSON.stringify(j).slice(0, 300)}`);
  }
  for (const l of err.split("\n")) if (l.includes("[fm-jev-compaction]")) report.jevStderr.push(l.trim());
  for (const f of readdirSync(sessions)) {
    for (const l of readFileSync(join(sessions, f), "utf8").split("\n")) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === "compaction") report.compactionEntries.push({ file: f, fromExtension: j.fromExtension === true, method: j.method ?? null, summaryChars: (j.summary ?? "").length, summaryHasKept: (j.summary ?? "").includes(KEPT), summaryHasMarker: (j.summary ?? "").includes(MARKER), jev: j.preserveData?.jevCompaction ? { kept: j.preserveData.jevCompaction.kept, dropped: j.preserveData.jevCompaction.dropped?.length, candidateCalls: j.preserveData.jevCompaction.candidateCalls, reductionRatio: j.preserveData.jevCompaction.reductionRatio, summaryTokens: j.preserveData.jevCompaction.summaryTokens, budget: j.preserveData.jevCompaction.budget } : null });
    }
  }
  server.close();
  writeFileSync(args.out, JSON.stringify(report, null, 2));
});
DRIVER_EOF

run_case() {
  local name=$1 kind=$2 turns=$3 target=$4
  shift 4
  local out="$LAB/$name.report.json"
  node "$DRIVER" "--case=$name" "--kind=$kind" "--turns=$turns" "--targetChars=$target" "--lab=$LAB" "--root=$ROOT" "--omp=$OMP_BIN" "--out=$out" "$@" > "$LAB/$name.driver.log" 2>&1 \
    || fail "$name: driver failed (see $LAB/$name.driver.log)"
  [ -f "$out" ] || fail "$name: no report written (see $LAB/$name.driver.log)"
  printf 'evidence %s: %s\n' "$name" "$(jq -c '{approxTokens, contextWindow: .model.contextWindow, compactSuccess: .compact.success, compactError: .compact.error, endpointHits: .endpoint.hits, markerLeaked: .endpoint.markerLeaked, durationMs, jevStderr, installed: ([.compactionEntries[] | select(.fromExtension)] | .[0] // null | if . == null then null else {summaryChars, summaryHasKept, summaryHasMarker, jev} end)}' "$out")" >&2
  printf '%s\n' "$out"
}

field() { jq -r "$2" "$1"; }

assert_zero_requests() {
  local report=$1 name=$2
  assert_equals 0 "$(field "$report" '.endpoint.hits')" "$name: no request may reach the endpoint"
  assert_equals 0 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "$name: nothing may be installed by the extension"
}

test_tools_550k_installs_through_real_omp() {
  local report
  report=$(run_case tools-550k tools 110 2200000)
  assert_equals 272000 "$(field "$report" '.model.contextWindow')" "the real session runs the captain's Codex Max model with its real context window"
  assert_equals true "$(field "$report" '.compact.success')" "omp's RPC compact must succeed on the tool-heavy history"
  assert_equals 1 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "exactly one compaction entry from the extension must be on disk"
  assert_equals true "$(field "$report" '.compactionEntries[0].summaryHasKept')" "the summary keeps the verbatim text Jev was told to keep"
  assert_equals false "$(field "$report" '.compactionEntries[0].summaryHasMarker')" "the excludeFromContext execution never reaches the installed summary"
  assert_equals false "$(field "$report" '.endpoint.markerLeaked')" "the excludeFromContext execution never reaches the fake endpoint"
  assert_equals true "$(field "$report" '.endpoint.hits >= 1')" "Jev was asked at least once"
  assert_equals true "$(field "$report" '.compactionEntries[0].jev.reductionRatio >= 0.5')" "the tool-heavy history shrinks by well over the 25% minimum"
  assert_equals true "$(field "$report" '.compactionEntries[0].jev.budget.budgetTokens >= 100000')" "the retained-context budget for Codex Max is six figures, not the 13107-token native cap"
  assert_contains "$(field "$report" '.jevStatus | join("\n")')" "Jev compaction: kept" "omp received the success status frame"
  pass "tools-550k: real omp installs the Jev replacement for a ~$(field "$report" '.approxTokens')-token tool-heavy history (budget $(field "$report" '.compactionEntries[0].jev.budget.budgetTokens') tokens, ~$(field "$report" '.compactionEntries[0].jev.summaryTokens') used)"
}

test_text_550k_falls_back_honestly() {
  local report
  report=$(run_case text-550k text 110 2200000)
  assert_zero_requests "$report" text-550k
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "reduction 0% of the whole context below minimum" "irreducible prose is declined for lack of reduction, before any request"
  assert_equals true "$(field "$report" '.compact.success')" "omp's own native methods must complete the compaction the hook declined"
  assert_equals true "$(field "$report" '[.compactionEntries[] | select(.fromExtension | not)] | length >= 1')" "a native compaction entry, not an extension one, must be on disk"
  pass "text-550k: irreducible prose falls back with zero requests and omp's native $(field "$report" '[.compactionEntries[] | select(.fromExtension | not)][0].method // "native"') method completes the compaction instead"
}

test_secrets_on_declines_via_omp_itself() {
  local report
  report=$(run_case secrets-on tools 24 300000 "--agentConfig=secrets:\n  enabled: true\n")
  assert_zero_requests "$report" secrets-on
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on (omp config get secrets.enabled)" "the decline names omp's own reader as its source"
  pass "secrets-on: real omp's config get answers true from inside the session and the hook declines before any request"
}

test_shadow_group_keeps_protection_on() {
  local report
  report=$(run_case shadow-A tools 24 300000 "--agentConfig=secrets:\n  enabled: true\n" "--projectConfig=secrets:\n  # enabled: false\n")
  assert_zero_requests "$report" shadow-A
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on" "a bare project group cannot switch an inherited on back off"
  pass "shadow-A: a bare project secrets: group leaves omp's effective switch on, and the hook follows omp"
}

test_overlay_on_declines() {
  local report overlay="$LAB/overlay-on.yml"
  printf 'secrets:\n  enabled: true\n' > "$overlay"
  report=$(run_case overlay-on tools 24 300000 "--overlay=$overlay")
  assert_zero_requests "$report" overlay-on
  assert_contains "$(field "$report" '.jevStderr | join("\n")')" "Hide Secrets is on (--config overlay" "the decline names the overlay as its source"
  pass "overlay-on: a --config overlay turning Hide Secrets on is honored from the real launch argv"
}

test_worker_overlay_proceeds() {
  local report
  report=$(run_case worker tools 24 300000 "--overlay=$ROOT/.omp/fm-worker-overlay.yml")
  assert_equals true "$(field "$report" '.compact.success')" "the actual Firstmate worker overlay must not block Jev"
  assert_equals 1 "$(field "$report" '[.compactionEntries[] | select(.fromExtension)] | length')" "worker: the extension installs"
  assert_equals true "$(field "$report" '.endpoint.hits >= 1')" "worker: Jev was asked"
  assert_equals false "$(field "$report" '.endpoint.markerLeaked')" "worker: the excluded execution still never leaves the machine"
  pass "worker: the tracked .omp/fm-worker-overlay.yml launch posture proceeds and installs"
}

test_tools_550k_installs_through_real_omp
test_text_550k_falls_back_honestly
test_secrets_on_declines_via_omp_itself
test_shadow_group_keeps_protection_on
test_overlay_on_declines
test_worker_overlay_proceeds

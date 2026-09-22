// Credential-free real OMP proof; invoked by fm-jev-compaction-live-e2e.test.sh.
// Runs one case: builds a scratch omp agent dir, home, project (with the
// extension copied in), and a synthetic resumed session; serves a fake
// System One endpoint; launches real omp in RPC mode; sends get_state and
// compact; then reports what omp, the extension, the endpoint, and the
// session file on disk show.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fakeSystemOne } from "./fake-systemone.mjs";
import { reviewerModel } from "./fake-reviewer-model.mjs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=")]; }));
const caseDir = join(args.lab, args.case);
const agent = join(caseDir, "agent"), home = join(caseDir, "home"), project = join(caseDir, "project"), sessions = join(caseDir, "sessions");
for (const d of [agent, home, join(project, ".omp", "extensions"), sessions]) mkdirSync(d, { recursive: true });
cpSync(join(args.root, ".omp", "extensions", "fm-jev-compaction.ts"), join(project, ".omp", "extensions", "fm-jev-compaction.ts"));
cpSync(join(args.root, ".omp", "extensions", "vendor"), join(project, ".omp", "extensions", "vendor"), { recursive: true });
cpSync(join(args.root, ".omp/extensions/lib"), join(project, ".omp/extensions/lib"), { recursive: true });
cpSync(join(args.root, ".omp/extensions/fm-jev-review.ts"), join(project, ".omp/extensions/fm-jev-review.ts"));
cpSync(join(args.root, ".omp/vendor"), join(project, ".omp/vendor"), { recursive: true });
const fleet = join(caseDir, "fleet");
mkdirSync(fleet, { recursive: true });
if (args.case !== "no-key") writeFileSync(join(fleet, ".env"), "TYPESAFE_API_KEY=fake-live-key-never-valid\n");
if (args.agentConfig) writeFileSync(join(agent, "config.yml"), args.agentConfig.replace(/\\n/g, "\n"));
if (args.projectConfig) writeFileSync(join(project, ".omp", "config.yml"), args.projectConfig.replace(/\\n/g, "\n"));

// ---- synthetic session in omp's own v3 JSONL shape ----
const MARKER = "EXCLUDED-BASH-MARKER-" + Math.random().toString(16).slice(2);
const KEPT = "the important invariant the run must keep";
let toolKeptText = "";
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
    if (i === 0) toolKeptText = listing;
    chars += listing.length;
    push({ ...assistant, content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: { command: i === 0 ? "keep important tool output" : `ls -la dir${i}` } }], usage: usage(), stopReason: "toolUse", timestamp: Date.now() });
    push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", content: [{ type: "text", text: listing }], isError: false, timestamp: Date.now() });
    push({ ...assistant, content: [{ type: "text", text: `Listing ${i} noted.` }], usage: usage(), stopReason: "stop", timestamp: Date.now() });
  } else if (args.kind === "mixed") {
    const line = `drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir${i}/file-${i}.ts\n`;
    const listing = line.repeat(Math.ceil((perTurn * 0.3) / line.length));
    const sentence = `Analysis ${i}: the scheduler retry path re-enters the queue boundary, and each retry widens the regression window. `;
    const prose = sentence.repeat(Math.ceil((perTurn * 0.7) / sentence.length));
    chars += listing.length + prose.length;
    push({ ...assistant, content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: { command: `ls -la dir${i}` } }], usage: usage(), stopReason: "toolUse", timestamp: Date.now() });
    push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", content: [{ type: "text", text: listing }], isError: false, timestamp: Date.now() });
    push({ ...assistant, content: [{ type: "text", text: prose }], usage: usage(), stopReason: "stop", timestamp: Date.now() });
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

// Jev and model traffic terminate on the same isolated loopback server.
const reviewEvidence = {};
const { server, evidence: endpoint, url } = await fakeSystemOne({ marker: MARKER, handleModel: reviewerModel(reviewEvidence) });

// ---- real omp, RPC mode ----
const reviewing = args.kind === "review";
const ompArgs = ["--mode", "rpc", "--session-dir", sessions, "--cwd", project, "--model", reviewing ? "jev-proof/proof" : "openai/gpt-5.1-codex-max"];
if (!reviewing) ompArgs.push("--resume", sessionFile);
// The same explicit loading shape as Firstmate OMP workers; the project's
// copied Jev files also auto-discover, deliberately exercising duplicate loads.
ompArgs.push("-e", join(args.root, ".omp"));
if (reviewing || args.case === "no-key") ompArgs.push("-e", join(args.root, "tests/fixtures/fm-jev-omp-probe.mjs"));
if (reviewing) {
  writeFileSync(join(agent, "models.yml"), `providers:\n  jev-proof:\n    baseUrl: ${url.replace("/systemone", "")}\n    api: openai-completions\n    auth: none\n    models:\n      - id: proof\n        name: Local proof\n        contextWindow: 272000\n        maxTokens: 8192\n`);
  writeFileSync(join(agent, "config.yml"), `async:\n  enabled: false\ntask:\n  maxRuntimeMs: 30000\n  agentModelOverrides:\n    reviewer: jev-proof/proof\n` + (args.agentConfig ?? "").replace(/\\n/g, "\n"));
}
if (args.overlay) ompArgs.push("--config", args.overlay);
const env = {
  PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, HOME: home, OMP_SKIP_SETUP: "1",
  FM_HOME: fleet, FM_TASK_ID: "synthetic-jev-proof", FM_JEV_ENDPOINT: url,
  JEV_PROOF_ROOT: args.root,
  JEV_PROOF_DIFF: args.reviewDiff ? readFileSync(args.reviewDiff, "utf8") : "",
};
const child = spawn(args.omp, ompArgs, { cwd: project, stdio: ["pipe", "pipe", "pipe"], env });
let out = "", err = "", sent = false; const started = Date.now();
const report = { case: args.case, kind: args.kind, sessionChars: chars, approxTokens: Math.floor(chars / 4), model: null, compact: null, jevStatus: [], jevStderr: [], endpoint, reviewEvidence, compactionEntries: [], durationMs: 0 };
const finish = () => child.stdin.end();
let pending = "";
child.stdout.on("data", (d) => {
  out += d;
  pending += d;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (!sent && frame.type === "ready") {
      sent = true;
      child.stdin.write(JSON.stringify({ id: "s", type: "get_state" }) + "\n");
      child.stdin.write(JSON.stringify(reviewing || args.case === "no-key" ? { id: "p", type: "prompt", message: "/jev-proof" } : { id: "c", type: "compact" }) + "\n");
    }
    const text = frame.message ?? "";
    if (frame.type === "extension_ui_request" && text.startsWith("JEV_PROOF=")) {
      report.proof = JSON.parse(text.slice("JEV_PROOF=".length));
      child.stdin.write(JSON.stringify(reviewing ? { id: "r", type: "prompt", message: "JEV_PARENT_PROOF: call the reviewer for the synthetic key-gate change." } : { id: "c", type: "compact" }) + "\n");
    }
    if (frame.type === "response" && frame.command === "compact") finish();
    if (reviewing && frame.type === "agent_end" && endpoint.modelRequests.length) finish();
  }
});
child.stderr.on("data", (d) => { err += d; });
const killer = setTimeout(() => child.kill("SIGKILL"), Number(args.timeoutMs ?? 180000));
child.on("exit", () => {
  clearTimeout(killer);
  report.durationMs = Date.now() - started;
  writeFileSync(join(caseDir, "rpc.jsonl"), out);
  writeFileSync(join(caseDir, "stderr.log"), err);
  for (const l of out.split("\n").filter(Boolean)) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === "response" && j.command === "get_state") report.model = { id: j.data?.model?.id, contextWindow: j.data?.model?.contextWindow };
    if (j.type === "response" && j.command === "compact") report.compact = { success: j.success, error: j.error ?? null, dataKeys: j.data && typeof j.data === "object" ? Object.keys(j.data) : typeof j.data };
    if (j.type === "extension_ui_request" && j.statusKey === "jev-compaction") report.jevStatus.push(j.statusText);
    if (j.type === "extension_error") report.jevStderr.push(`extension_error: ${JSON.stringify(j).slice(0, 300)}`);
  }
  for (const l of err.split("\n")) if (l.includes("[fm-jev-compaction]")) report.jevStderr.push(l.trim());
  for (const f of readdirSync(sessions)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const l of readFileSync(join(sessions, f), "utf8").split("\n")) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === "compaction") {
        const summary = j.summary ?? "", audit = j.preserveData?.jevCompaction;
        report.compactionEntries.push({
          file: f, fromExtension: j.fromExtension === true, method: j.method ?? null,
          summaryChars: summary.length, summaryHasKept: summary.includes(KEPT),
          summaryHasMarker: summary.includes(MARKER),
          keptToolVerbatim: Boolean(toolKeptText && summary.includes(toolKeptText)),
          droppedToolAbsent: !summary.includes("dir3/file-3.ts"),
          jev: audit ? { kept: audit.kept, dropped: audit.dropped?.length, candidateCalls: audit.candidateCalls,
            reductionRatio: audit.reductionRatio, summaryTokens: audit.summaryTokens, budget: audit.budget } : null,
        });
      }
    }
  }
  server.close();
  writeFileSync(args.out, JSON.stringify(report, null, 2));
});

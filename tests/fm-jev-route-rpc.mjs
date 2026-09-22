// Token-free OMP RPC smoke: real runtime and resolver, loopback Jev/chat/quota fixtures.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const lab = await mkdtemp(join(tmpdir(), "fm-jev-route-rpc-"));
const processes = new Set();
let succeeded = false;
const traces = [];
let jevRequests = 0;
let chatRequests = 0;
let todoIssued = false;
const chatModels = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  if (req.url === "/v1/systemone") {
    jevRequests++;
    assert.equal(req.headers.authorization, "Bearer fake");
    assert.deepEqual(Object.keys(data.questions), ["rule"]);
    traces.push({ event: "fake-jev-answer", status: "clear", rule: "rule_1", confidence: 0.95 });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "jev-fake", answers: { rule: { choice: "rule_1", confidence: 0.95, probabilities: { rule_1: 0.95, default: 0.05 } } } }));
    return;
  }
  assert.equal(req.url, "/v1/chat/completions");
  chatRequests++;
  chatModels.push(data.model);
  res.setHeader("content-type", "text/event-stream");
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chat-${chatRequests}`, object: "chat.completion.chunk", created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!todoIssued) {
    todoIssued = true;
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "todo-smoke", type: "function", function: { name: "todo", arguments: JSON.stringify({ op: "init", items: ["Prove routing through the real runtime"] }) } }] });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: "ROUTE_SMOKE_OK" });
    chunk({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const curl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
// Only inspect the saved global config's metadata, never its contents or auth stores.
const globalConfig = join(homedir(), ".omp/agent/config.yml");
const beforeGlobal = await stat(globalConfig).then(s => [s.mtimeMs, s.size]).catch(() => null);
const version = execFileSync("omp", ["--version"], { encoding: "utf8" }).trim();
const timeout = setTimeout(() => { // Hard bound on a real child/HTTP integration, not a guessed success delay.
  console.error(`not ok - ${version}: routing RPC smoke exceeded 90 seconds`);
  for (const child of processes) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  process.exitCode = 1;
}, 90_000);

async function session(name, keyed) {
  const home = join(lab, name);
  const agent = join(home, "agent");
  const fakebin = join(home, "fakebin");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(fakebin, { recursive: true }), mkdir(join(home, "config"), { recursive: true }), mkdir(join(home, "user"), { recursive: true })]);
  const config = "modelRoles:\n  default: route-fake/initial\ndefaultThinkingLevel: low\n";
  await writeFile(join(agent, "config.yml"), config);
  const before = await stat(join(agent, "config.yml"));
  if (keyed) await writeFile(join(home, ".env"), "TYPESAFE_API_KEY=fake\n", { mode: 0o600 });
  await writeFile(join(home, "config/crew-dispatch.json"), JSON.stringify({ rules: [{ when: "Complete this task reliably.", use: { harness: "omp", model: "route-fake/routed", effort: "high", provider: "codex" } }] }));
  // Keep the production endpoint fixed; this test-only transport redirects it to loopback.
  await writeFile(join(fakebin, "curl"), `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in https://api.typesafe.ai/v1/systemone) args+=('${base}/v1/systemone') ;; *) args+=("$arg") ;; esac\ndone\nexec '${curl}' "\${args[@]}"\n`);
  await writeFile(join(fakebin, "quota-axi"), `#!/usr/bin/env bash\nprintf '%s\\n' '{"schemaVersion":5,"providers":[{"provider":"codex","quotaSemantics":{"status":"known","effectiveAvailability":[{"scope":"all_models","status":"known","effectivePercentRemaining":80,"runway":{"status":"through_reset"},"selection":{"spendPriority":0.8}}]}}]}'\n`);
  await Promise.all([chmod(join(fakebin, "curl"), 0o700), chmod(join(fakebin, "quota-axi"), 0o700)]);
  await writeFile(join(home, "provider.mjs"), `export default function(pi) { pi.registerProvider("route-fake", { baseUrl: "${base}/v1", apiKey: "fake", api: "openai-completions", models: ["initial","routed","manual"].map(id => ({id,name:id,reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024})) }); }`);
  const routePath = join(root, ".omp/extensions/fm-jev-route.ts");
  const environment = { ...process.env, HOME: join(home, "user"), PI_CODING_AGENT_DIR: agent, OMP_SKIP_SETUP: "1", FM_HOME: home, PATH: `${fakebin}:${process.env.PATH}` };
  for (const key of ["FM_TASK_ID", "FM_ROOT_OVERRIDE", "FM_STATE_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_JEV_ROUTE", "TYPESAFE_API_KEY", "OMP_PROFILE", "PI_MODEL", "PI_PLAN_MODEL", "PI_SMOL_MODEL", "PI_SLOW_MODEL"]) delete environment[key];
  const child = spawn("omp", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk", "--auto-approve", "--tools", "todo", "--max-time", "60", "-e", join(home, "provider.mjs"), "-e", routePath], { cwd: home, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  processes.add(child);
  const frames = [];
  const events = new EventEmitter();
  let stderr = "";
  let exited = false;
  child.stderr.on("data", chunk => { stderr += chunk; traces.push({ name, stderr: String(chunk).replaceAll("Bearer fake", "Bearer [synthetic]") }); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (["response", "prompt_result", "model_changed", "thinking_level_changed", "extension_error", "agent_end"].includes(frame.type)) {
        traces.push({ name, type: frame.type, id: frame.id, success: frame.success,
          model: frame.data?.model?.id, effort: frame.data?.thinkingLevel, agentInvoked: frame.agentInvoked });
      }
      events.emit("frame");
    } catch { /* Non-protocol output fails the assertions below. */ }
  });
  child.on("exit", () => { exited = true; processes.delete(child); events.emit("frame"); });
  const wait = async predicate => {
    for (;;) {
      const found = frames.find(predicate);
      if (found) return found;
      if (exited) throw new Error(`${version} exited before expected RPC frame: ${stderr}`);
      await once(events, "frame");
    }
  };
  let id = 0;
  const request = async command => {
    const next = `${name}-${++id}`;
    child.stdin.write(`${JSON.stringify({ ...command, id: next })}\n`);
    const response = await wait(frame => frame.type === "response" && frame.id === next);
    assert.equal(response.success, true, JSON.stringify(response));
    if (command.type === "prompt" && command.message.startsWith("/")) {
      const result = await wait(frame => frame.type === "prompt_result" && frame.id === next);
      assert.equal(result.agentInvoked, false, "the extension command completed without invoking the agent");
    }
    return response.data;
  };
  const prompt = async message => {
    const start = frames.length;
    await request({ type: "prompt", message });
    await wait(frame => frame.type === "agent_end" && frames.indexOf(frame) >= start);
  };
  await wait(frame => frame.type === "ready");
  await wait(frame => frame.type === "available_commands_update" && frame.commands.some(command => command.name === "jev-route"));
  const initial = await request({ type: "get_state" });
  assert.equal(initial.model.id, "initial");
  await prompt("Complete the routing smoke task using todo, then answer ROUTE_SMOKE_OK.");
  const current = await request({ type: "get_state" });
  assert.equal(current.model.id, keyed ? "routed" : "initial");
  assert.equal(current.thinkingLevel, keyed ? "high" : "low");
  const logPath = join(home, "state/.jev-route.log");
  const logs = async () => (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const firstLogs = await logs();
  assert.equal(firstLogs[0].status, keyed ? "clear" : "off");
  if (keyed) assert.deepEqual(firstLogs.map(row => row.trigger), ["session", "todo-init"]);
  await prompt("Continue the same task; answer ROUTE_SMOKE_OK without tools.");
  assert.equal((await logs()).length, firstLogs.length);
  await request({ type: "set_model", provider: "route-fake", modelId: "manual" });
  await request({ type: "set_thinking_level", level: "low" });
  await request({ type: "prompt", message: "/jev-route Explicit selection must win" });
  const manual = await request({ type: "get_state" });
  assert.equal(manual.model.id, "manual");
  assert.equal(manual.thinkingLevel, "low");
  assert.equal(await readFile(join(agent, "config.yml"), "utf8"), config);
  assert.equal((await stat(join(agent, "config.yml"))).mtimeMs, before.mtimeMs);
  assert.equal(frames.some(frame => frame.type === "extension_error"), false);
  child.stdin.end();
  if (!exited) await once(child, "exit");
  console.log(`ok - ${version} ${keyed ? "fake endpoint" : "no key"}: ${initial.model.id}/low -> ${current.model.id}/${current.thinkingLevel}; routine turn retained; explicit manual/low retained; saved config unchanged`);
}
try {
  await session("keyed", true);
  const count = jevRequests;
  await session("off", false);
  assert.equal(jevRequests, count);
  assert.ok(chatModels.includes("routed"), "the real request uses the routed model");
  assert.deepEqual(await stat(globalConfig).then(s => [s.mtimeMs, s.size]).catch(() => null), beforeGlobal);
  console.log(`ok - fake Jev requests=${jevRequests}; real OMP chat requests=${chatRequests}; real global config metadata unchanged; authenticated Jev proof pending`);
  succeeded = true;
} finally {
  clearTimeout(timeout);
  for (const child of processes) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  if (succeeded) await rm(lab, { recursive: true, force: true });
  else {
    await writeFile(join(lab, "rpc-diagnostic.json"), JSON.stringify(traces, null, 2), { mode: 0o600 });
    console.error(`Failure evidence retained at ${lab}`);
  }
}

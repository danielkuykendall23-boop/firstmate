// Token-free OMP smoke: real runtime and resolver, loopback Jev/chat/quota fixtures,
// driven through RPC and through a real interactive terminal session.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

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
  console.error(`not ok - ${version}: routing smoke exceeded 180 seconds`);
  for (const child of processes) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  process.exitCode = 1;
}, 180_000);
// A pseudo-terminal for the interactive session: forwards this process's stdin
// to omp as keystrokes, its screen back on stdout, and stops omp on stdin EOF.
const PTY_DRIVER = `
import os, pty, sys, fcntl, termios, struct, select, signal
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
def stop(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, stop)
reading = True
while True:
    ready, _, _ = select.select([fd] + ([0] if reading else []), [], [], 0.5)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(fd, data)
        else:
            reading = False
            stop()
os.waitpid(pid, 0)
`;

async function prepare(name, keyed, protectedSecrets) {
  const home = join(lab, name);
  const agent = join(home, "agent");
  const fakebin = join(home, "fakebin");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(fakebin, { recursive: true }), mkdir(join(home, "config"), { recursive: true }), mkdir(join(home, "user"), { recursive: true })]);
  const config = `modelRoles:\n  default: route-fake/initial\ndefaultThinkingLevel: low\n${protectedSecrets ? "secrets:\n  enabled: true\n" : ""}`;
  await writeFile(join(agent, "config.yml"), config);
  const before = await stat(join(agent, "config.yml"));
  if (keyed) await writeFile(join(home, ".env"), "TYPESAFE_API_KEY=fake\n", { mode: 0o600 });
  await writeFile(join(home, "config/crew-dispatch.json"), JSON.stringify({ rules: [{ when: "Complete this task reliably.", use: { harness: "omp", model: "route-fake/routed", effort: "high", provider: "codex" } }] }));
  // Keep the production endpoint fixed; this test-only transport redirects it to loopback.
  await writeFile(join(fakebin, "curl"), `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in https://api.typesafe.ai/v1/systemone) args+=('${base}/v1/systemone') ;; *) args+=("$arg") ;; esac\ndone\nexec '${curl}' "\${args[@]}"\n`);
  await writeFile(join(fakebin, "quota-axi"), `#!/usr/bin/env bash\nprintf '%s\\n' '{"schemaVersion":5,"providers":[{"provider":"codex","quotaSemantics":{"status":"known","effectiveAvailability":[{"scope":"all_models","status":"known","effectivePercentRemaining":80,"runway":{"status":"through_reset"},"selection":{"spendPriority":0.8}}]}}]}'\n`);
  await Promise.all([chmod(join(fakebin, "curl"), 0o700), chmod(join(fakebin, "quota-axi"), 0o700)]);
  await writeFile(join(home, "provider.mjs"), `export default function(pi) { pi.registerProvider("route-fake", { baseUrl: "${base}/v1", apiKey: "fake", api: "openai-completions", models: ["initial","routed","manual"].map(id => ({id,name:id,reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024})) }); }`);
  const environment = { ...process.env, HOME: join(home, "user"), PI_CODING_AGENT_DIR: agent, OMP_SKIP_SETUP: "1", FM_HOME: home, PATH: `${fakebin}:${process.env.PATH}` };
  for (const key of ["FM_TASK_ID", "FM_ROOT_OVERRIDE", "FM_STATE_OVERRIDE", "FM_CONFIG_OVERRIDE", "FM_JEV_ROUTE", "TYPESAFE_API_KEY", "OMP_PROFILE", "PI_MODEL", "PI_PLAN_MODEL", "PI_SMOL_MODEL", "PI_SLOW_MODEL"]) delete environment[key];
  const args = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk", "--auto-approve", "--tools", "todo", "--max-time", "60", "-e", join(home, "provider.mjs"), "-e", join(root, ".omp/extensions/fm-jev-route.ts")];
  todoIssued = false;
  return { home, agent, config, before, environment, args };
}
const logs = async home => (await readFile(join(home, "state/.jev-route.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const unchangedConfig = async ({ agent, config, before }) => {
  assert.equal(await readFile(join(agent, "config.yml"), "utf8"), config);
  assert.equal((await stat(join(agent, "config.yml"))).mtimeMs, before.mtimeMs);
};

async function session(name, keyed, protectedSecrets = false) {
  const prepared = await prepare(name, keyed, protectedSecrets);
  const { home, environment, args } = prepared;
  const child = spawn("omp", ["--mode", "rpc", ...args], { cwd: home, env: environment, stdio: ["pipe", "pipe", "pipe"] });
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
  const jevBefore = jevRequests;
  const initial = await request({ type: "get_state" });
  assert.equal(initial.model.id, "initial");
  await prompt("Complete the routing smoke task using todo, then answer ROUTE_SMOKE_OK.");
  const current = await request({ type: "get_state" });
  const routed = keyed && !protectedSecrets;
  assert.equal(current.model.id, routed ? "routed" : "initial");
  assert.equal(current.thinkingLevel, routed ? "high" : "low");
  const firstLogs = await logs(home);
  assert.deepEqual(firstLogs.map(row => row.trigger), ["session", "todo-init"]);
  assert.ok(firstLogs.every(row => row.status === (protectedSecrets ? "declined" : keyed ? "clear" : "off")), JSON.stringify(firstLogs));
  if (protectedSecrets) assert.equal(jevRequests, jevBefore, "secret protection makes no Jev request");
  await prompt("Continue the same task; answer ROUTE_SMOKE_OK without tools.");
  assert.equal((await logs(home)).length, firstLogs.length);
  await request({ type: "set_model", provider: "route-fake", modelId: "manual" });
  await request({ type: "set_thinking_level", level: "low" });
  await request({ type: "prompt", message: "/jev-route Explicit selection must win" });
  const manual = await request({ type: "get_state" });
  assert.equal(manual.model.id, "manual");
  assert.equal(manual.thinkingLevel, "low");
  await unchangedConfig(prepared);
  assert.equal(frames.some(frame => frame.type === "extension_error"), false);
  child.stdin.end();
  if (!exited) await once(child, "exit");
  const label = protectedSecrets ? "secret protection on" : keyed ? "fake endpoint" : "no key";
  console.log(`ok - ${version} rpc ${label}: ${initial.model.id}/low -> ${current.model.id}/${current.thinkingLevel}; routine turn retained; explicit manual/low retained; saved config unchanged`);
}

async function terminal(name) {
  const prepared = await prepare(name, true, false);
  const { home, environment, args } = prepared;
  const driver = spawn("python3", ["-c", PTY_DRIVER, "omp", ...args], { cwd: home, env: { ...environment, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  processes.add(driver);
  let screen = "";
  let stderr = "";
  let exited = false;
  driver.stdout.on("data", chunk => { screen += String(chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>]/g, ""); });
  driver.stderr.on("data", chunk => { stderr += chunk; traces.push({ name, stderr: String(chunk) }); });
  driver.on("exit", () => { exited = true; processes.delete(driver); });
  const until = async (predicate, what) => {
    while (!(await predicate())) {
      if (exited) throw new Error(`${version} interactive session ended before ${what}: ${stderr}`);
      await sleep(250);
    }
  };
  const chatFrom = chatModels.length;
  const jevFrom = jevRequests;
  await until(() => /initial/.test(screen), "the footer showed the initial model");
  driver.stdin.write("Complete the routing smoke task using todo, then answer ROUTE_SMOKE_OK.\r");
  await until(() => chatModels.length >= chatFrom + 2, "the second chat request");
  await until(() => /ROUTE_SMOKE_OK/.test(screen), "the reply rendered in the terminal");
  const rows = await logs(home);
  assert.deepEqual(rows.map(row => [row.trigger, row.status, row.model, row.effort]),
    [["session", "clear", "route-fake/routed", "high"], ["todo-init", "clear", "route-fake/routed", "high"]]);
  assert.deepEqual(chatModels.slice(chatFrom, chatFrom + 2), ["routed", "routed"]);
  assert.equal(jevRequests, jevFrom + 2);
  await unchangedConfig(prepared);
  driver.stdin.end();
  if (!exited) await Promise.race([once(driver, "exit"), sleep(10_000)]);
  if (!exited) driver.kill("SIGKILL");
  console.log(`ok - ${version} interactive tui fake endpoint: initial/low -> routed/high on the first prompt; todo boundary rerouted; both chat requests used routed; saved config unchanged`);
}
try {
  await session("keyed", true);
  const count = jevRequests;
  await session("off", false);
  assert.equal(jevRequests, count);
  await session("protected", true, true);
  assert.equal(jevRequests, count);
  await terminal("tui");
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

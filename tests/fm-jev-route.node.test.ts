import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type install from "../.omp/extensions/fm-jev-route.ts";

type API = Parameters<typeof install>[0];
type Handler = Parameters<API["on"]>[1];
type Context = Parameters<Handler>[1];
type Event = Parameters<Handler>[0];
type Thinking = Parameters<API["setThinkingLevel"]>[0];
const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };
const argv = [...process.argv];
const execPath = process.execPath;
const dirs: string[] = [];
afterEach(async () => {
  process.env = { ...env };
  process.argv = [...argv];
  process.execPath = execPath;
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const clear = { status: "clear", rule: "rule_1", confidence: 0.95,
  chosen: { profile: { harness: "omp", model: "fake/routed", effort: "high" } } };

async function fixture(options: { worker?: boolean; disabled?: boolean; flags?: string[]; mode?: string; overlay?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "fm-jev-route-test-"));
  dirs.push(home);
  for (const file of [".omp/extensions/fm-jev-route.ts", ".pi/extensions/lib/fm-async-exec.ts", "bin/fm-timeout-lib.sh"]) {
    await mkdir(dirname(join(home, file)), { recursive: true });
    await copyFile(join(root, file), join(home, file));
  }
  await writeFile(join(home, "bin/fm-dispatch-resolve.sh"), `#!/usr/bin/env bash
if [ -e "$FM_HOME/delay" ]; then touch "$FM_HOME/started"; read -r _ < "$FM_HOME/release"; fi
node -e 'const fs=require("node:fs");const p=process.argv[1];fs.appendFileSync(process.env.FM_HOME+"/calls",JSON.stringify({path:p,mode:fs.statSync(p).mode & 511,goal:fs.readFileSync(p,"utf8")})+"\\n");' "$1"
if [ -e "$FM_HOME/off" ]; then echo 'dispatch-resolve: off (no key)' >&2; echo '{"status":"off"}'; exit 0; fi
if [ -e "$FM_HOME/silent" ]; then echo 'dispatch-resolve: off (no key)' >&2; exit 0; fi
cat "$FM_HOME/result"
if [ -e "$FM_HOME/fail" ]; then exit 2; fi
`);
  // The extension asks the binary it runs inside for the effective Hide Secrets switch; here that binary is this fake.
  await writeFile(join(home, "bin/omp"), `#!/usr/bin/env bash
[ "$*" = "config get secrets.enabled --json" ] || exit 2
echo "$PWD" >> "$FM_HOME/config-gets"
if [ -e "$FM_HOME/unprovable" ]; then echo 'settings unavailable' >&2; exit 1; fi
if [ -e "$FM_HOME/protected" ]; then echo '{"key":"secrets.enabled","value":true}'; else echo '{"key":"secrets.enabled","value":false}'; fi
`);
  await chmod(join(home, "bin/fm-dispatch-resolve.sh"), 0o700);
  await chmod(join(home, "bin/omp"), 0o700);
  await writeFile(join(home, "result"), JSON.stringify(clear));
  process.env.FM_HOME = home;
  delete process.env.FM_ROOT_OVERRIDE;
  delete process.env.FM_STATE_OVERRIDE;
  delete process.env.FM_TASK_ID;
  delete process.env.FM_JEV_ROUTE;
  if (options.worker) process.env.FM_TASK_ID = "worker";
  if (options.disabled) process.env.FM_JEV_ROUTE = "0";
  const flags = [...(options.flags ?? [])];
  if (options.overlay !== undefined) {
    await writeFile(join(home, "overlay.yml"), options.overlay);
    flags.push("--config", join(home, "overlay.yml"));
  }
  process.argv = ["node", "fixture", ...flags];
  process.execPath = join(home, "bin/omp");
  // Each import loads a runtime-selected isolated code root and its fake resolver.
  const factory: typeof install = (await import(pathToFileURL(join(home, ".omp/extensions/fm-jev-route.ts")).href)).default;
  const models = [{ provider: "fake", id: "initial" }, { provider: "fake", id: "routed" }, { provider: "fake", id: "manual" }];
  let model = models[0];
  let thinking: Thinking = "low";
  let clamp = false;
  let hold: Promise<void> | undefined;
  let landed: (() => void) | undefined;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Parameters<API["registerCommand"]>[1]>();
  const notices: string[] = [];
  const ctx: Context = { cwd: home, mode: options.mode ?? "tui", models: {
    current: () => model, list: () => models,
    resolve: spec => models.find(candidate => `${candidate.provider}/${candidate.id}` === spec),
  }, ui: { notify: message => { notices.push(message); } } };
  const api: API = {
    on: (name, fn) => { handlers.set(name, fn); },
    registerCommand: (name, command) => { commands.set(name, command); },
    // OMP applies the model, then its promise settles later; a held fixture keeps that gap open.
    setModel: async selected => {
      model = selected;
      landed?.();
      if (hold) { const gate = hold; hold = undefined; await gate; }
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: level => { thinking = clamp && level === "max" ? "high" : level; },
  };
  factory(api);
  const fire = async (name: string, event: Event = {}) => { await handlers.get(name)?.(event, ctx); };
  await fire("session_start");
  return { home, ctx, api, fire, notices, handlers, commands,
    current: () => [model.id, thinking], setClamp: () => { clamp = true; },
    select: (id: string, level?: Thinking) => { model = models.find(candidate => candidate.id === id) ?? model; if (level) thinking = level; },
    holdModel: () => {
      let release!: () => void;
      hold = new Promise<void>(done => { release = done; });
      const applied = new Promise<void>(done => { landed = done; });
      return { applied, release };
    },
    result: async (value: unknown) => writeFile(join(home, "result"), JSON.stringify(value)),
    route: async (goal = "") => { await commands.get("jev-route")?.handler(goal, ctx); },
    calls: async () => existsSync(join(home, "calls")) ? (await readFile(join(home, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [],
    configGets: async () => existsSync(join(home, "config-gets")) ? (await readFile(join(home, "config-gets"), "utf8")).trim().split("\n").length : 0,
    log: async () => (await readFile(join(home, "state/.jev-route.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("routes once per session, explicit todo init, and command; not routine turns", async () => {
  const f = await fixture();
  await f.fire("before_agent_start", { prompt: "private task context" });
  assert.deepEqual(f.current(), ["routed", "high"]);
  await f.fire("before_agent_start", { prompt: "continue private task" });
  await f.fire("tool_call", { toolName: "todo", input: { op: "done", task: "one" } });
  assert.equal((await f.calls()).length, 1);
  await f.fire("tool_call", { toolName: "todo", input: { op: "init", list: [{ phase: "Build", items: ["one", "two"] }] } });
  await f.route();
  assert.deepEqual((await f.log()).map(row => row.trigger), ["session", "todo-init", "command"]);
  assert.match((await f.calls())[1].goal, /continue private task\n\none\ntwo/);
  assert.equal((await f.calls())[2].goal, "continue private task");
  for (const call of await f.calls()) {
    assert.equal(call.mode, 0o600);
    assert.equal(existsSync(dirname(call.path)), false);
  }
  assert.equal(await f.configGets(), 3);
  assert.doesNotMatch(await readFile(join(f.home, "state/.jev-route.log"), "utf8"), /private task|goal.txt/);
  await f.fire("session_start");
  await f.fire("before_agent_start", { prompt: "new session task" });
  assert.equal((await f.log()).length, 4);
});

test("omitted op routes only after OMP confirms a successful init", async () => {
  const f = await fixture();
  const event = { toolName: "todo", input: { items: ["one"] } };
  await f.fire("tool_call", event);
  await f.fire("tool_result", { ...event, details: { op: "append" } });
  await f.fire("tool_result", { ...event, details: { op: "init" }, isError: true });
  assert.equal((await f.calls()).length, 0);
  await f.fire("tool_result", { ...event, details: { op: "init" } });
  assert.deepEqual(f.current(), ["routed", "high"]);
  assert.equal((await f.calls()).length, 1);
});

test("workers, explicit disable, unrelated directories and print mode are inert; RPC routes", async () => {
  for (const options of [{ worker: true }, { disabled: true }]) {
    const f = await fixture(options);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.commands.size, 0);
  }
  const f = await fixture();
  f.ctx.cwd = root;
  await f.fire("before_agent_start", { prompt: "unrelated task" });
  f.ctx.cwd = f.home;
  f.ctx.mode = "print";
  await f.route("child task");
  assert.equal((await f.calls()).length, 0);
  assert.equal(await f.configGets(), 0);
  const g = await fixture({ mode: "rpc" });
  await g.route("rpc task");
  assert.deepEqual(g.current(), ["routed", "high"]);
});

test("off, non-clear, malformed, empty and nonzero resolver results leave selection unchanged", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "off"), "");
  await f.route("no key");
  await rm(join(f.home, "off"));
  for (const status of ["ambiguous", "escalate", "error"]) {
    await f.result({ status });
    await f.route("keep selection");
  }
  await writeFile(join(f.home, "result"), "not JSON");
  await f.route("malformed");
  await writeFile(join(f.home, "silent"), "");
  await f.route("empty stdout is not an off answer");
  await rm(join(f.home, "silent"));
  await f.result(clear);
  await writeFile(join(f.home, "fail"), "");
  await f.route("nonzero");
  assert.deepEqual(f.current(), ["initial", "low"]);
  assert.deepEqual((await f.log()).map(row => row.status), ["off", "ambiguous", "escalate", "error", "error", "error", "error"]);
  assert.equal(f.notices[0], "Jev route: off - model unchanged");
  assert.ok(f.notices.every(line => line.endsWith("model unchanged")));
});

test("explicit model and effort axes win independently at launch and after routing", async () => {
  const f = await fixture({ flags: ["--model=fake/initial"] });
  await f.fire("before_agent_start", { prompt: "task" });
  assert.deepEqual(f.current(), ["initial", "high"]);
  await f.api.setModel({ provider: "fake", id: "manual" });
  f.api.setThinkingLevel("max");
  await f.route("another goal");
  assert.deepEqual(f.current(), ["manual", "max"]);
  const g = await fixture({ flags: ["--thinking", "low"] });
  await g.route("task");
  assert.deepEqual(g.current(), ["routed", "low"]);
});

test("unsupported profile and clamped effort cannot partially change the selection", async () => {
  const f = await fixture();
  for (const profile of [
    { harness: "claude", model: "fake/routed", effort: "high" },
    { harness: "omp", model: "fake/missing", effort: "high" },
    { harness: "omp", model: "fake/routed", effort: "invalid" },
  ]) {
    await f.result({ ...clear, chosen: { profile } });
    await f.route("task");
    assert.deepEqual(f.current(), ["initial", "low"]);
  }
  f.setClamp();
  await f.result({ ...clear, chosen: { profile: { harness: "omp", model: "fake/routed", effort: "max" } } });
  await f.route("unsupported max");
  assert.deepEqual(f.current(), ["initial", "low"]);
  assert.ok((await f.log()).every(row => row.status === "error"));
});

test("a delayed decision cannot replace a new session or a manual choice", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "delay"), "");
  execFileSync("mkfifo", [join(f.home, "release")]);
  let watcher = watch(f.home);
  const pending = f.route("old task");
  for await (const event of watcher) if (event.filename === "started") break;
  await f.fire("session_start");
  await writeFile(join(f.home, "release"), "go\n");
  await pending;
  assert.deepEqual(f.current(), ["initial", "low"]);
  await rm(join(f.home, "started"));
  watcher = watch(f.home);
  const next = f.route("current task");
  for await (const event of watcher) if (event.filename === "started") break;
  await f.api.setModel({ provider: "fake", id: "manual" });
  f.api.setThinkingLevel("max");
  await writeFile(join(f.home, "release"), "go\n");
  await next;
  assert.deepEqual(f.current(), ["manual", "max"]);
});

test("a model applied as the session is replaced is undone, not misread as that session's choice, and never rolls back a newer manual selection", async () => {
  const f = await fixture();
  let held = f.holdModel();
  let pending = f.route("old task");
  await held.applied;
  assert.deepEqual(f.current(), ["routed", "low"]);
  await f.fire("session_start");
  held.release();
  await pending;
  assert.deepEqual(f.current(), ["initial", "low"]);
  assert.equal(existsSync(join(f.home, "state/.jev-route.log")), false);
  await f.route("new session task");
  assert.deepEqual(f.current(), ["routed", "high"]);
  assert.deepEqual((await f.log()).map(row => [row.trigger, row.status]), [["command", "clear"]]);
  const g = await fixture();
  held = g.holdModel();
  pending = g.route("old task");
  await held.applied;
  await g.fire("session_start");
  g.select("manual", "max");
  held.release();
  await pending;
  assert.deepEqual(g.current(), ["manual", "max"]);
  await g.fire("before_agent_start", { prompt: "new session task" });
  assert.deepEqual(g.current(), ["manual", "max"]);
  assert.match(g.notices.at(-1) ?? "", /explicit choices retained$/);
});

test("secret protection on or unprovable declines before any resolver request", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "protected"), "");
  await f.fire("before_agent_start", { prompt: "first prompt with a pasted token" });
  await f.fire("tool_call", { toolName: "todo", input: { op: "init", items: ["one"] } });
  assert.deepEqual(f.current(), ["initial", "low"]);
  assert.equal((await f.calls()).length, 0);
  assert.equal(await f.configGets(), 2);
  assert.deepEqual(f.notices, Array(2).fill("Jev route: declined (secret protection on) - model unchanged"));
  await rm(join(f.home, "protected"));
  await writeFile(join(f.home, "unprovable"), "");
  await f.route("still private");
  assert.equal((await f.calls()).length, 0);
  assert.equal(f.notices.at(-1), "Jev route: declined (secret protection unprovable) - model unchanged");
  await rm(join(f.home, "unprovable"));
  await f.route("now routed");
  assert.deepEqual(f.current(), ["routed", "high"]);
  assert.deepEqual((await f.log()).map(row => [row.trigger, row.status]),
    [["session", "declined"], ["todo-init", "declined"], ["command", "declined"], ["command", "clear"]]);
  assert.doesNotMatch(await readFile(join(f.home, "state/.jev-route.log"), "utf8"), /pasted token|still private/);
  const g = await fixture({ overlay: "secrets:\n  enabled: false\n" });
  await g.route("overlay mentions secrets");
  assert.equal((await g.calls()).length, 0);
  assert.equal(await g.configGets(), 0);
  assert.equal(g.notices.at(-1), "Jev route: declined (secret protection unprovable) - model unchanged");
  const h = await fixture({ overlay: "composer:\n  shape: borderless\n" });
  await h.route("overlay without secrets");
  assert.deepEqual(h.current(), ["routed", "high"]);
});

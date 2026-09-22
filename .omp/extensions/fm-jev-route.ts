// Primary-only, once-per-task Jev routing. Operator contract: docs/configuration.md.
// OMP 18.2.8's setModel takes a registry Model, not a selector string, and both
// action APIs change this session without saving model defaults (RPC guard below).
// OMP is distributed as a binary here, without installable local host declarations;
// keep this narrow structural API checked by TypeScript and the real RPC guard.
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandAsync } from "../../.pi/extensions/lib/fm-async-exec.ts";

type Model = { provider: string; id: string };
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
type Context = {
  cwd: string;
  mode?: string;
  models: { current(): Model | undefined; resolve(spec: string): Model | undefined; list(): Model[] };
  ui?: { notify(message: string, type?: "info" | "warning"): void };
};
type Event = { prompt?: string; toolName?: string; input?: unknown; details?: unknown; isError?: boolean };
type API = {
  on(name: string, handler: (event: Event, ctx: Context) => unknown): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: Context): Promise<void> }): void;
  setModel(model: Model): Promise<boolean>;
  getThinkingLevel(): Thinking;
  setThinkingLevel(level: Thinking): void;
};
type Status = "clear" | "off" | "ambiguous" | "escalate" | "error" | "declined";
type Resolution = {
  status: Status;
  model: string | null;
  effort: Thinking | null;
  rule: string | null;
  confidence: number | null;
};
type Protection = "off" | "on" | "unprovable";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const empty = (status: Status): Resolution => ({ status, model: null, effort: null, rule: null, confidence: null });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const selector = (model: Model | undefined) => model ? `${model.provider}/${model.id}` : null;
const effort = (value: unknown): value is Thinking => typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value);
const timed = (seconds: number, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runCommandAsync("bash", ["-c", '. "$1"; shift; fm_run_timed "$@"', "jev-route", join(root, "bin/fm-timeout-lib.sh"), String(seconds), command, ...args], { cwd, env });

function parseResult(stdout: string, code: number | null): Resolution {
  if (code !== 0 || !stdout.trim()) return empty("error");
  const value: unknown = JSON.parse(stdout);
  if (!record(value)) return empty("error");
  const status = value.status;
  if (status !== "clear" && status !== "off" && status !== "ambiguous" && status !== "escalate" && status !== "error") return empty("error");
  if (status !== "clear") return { ...empty(status), rule: text(value.rule) ? value.rule : null,
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : null };
  if (!record(value.chosen) || !record(value.chosen.profile)) return empty("error");
  const profile = value.chosen.profile;
  // A primary cannot switch harnesses or interpret another harness's model ids.
  if (profile.harness !== "omp" || (profile.model !== undefined && !text(profile.model)) ||
      (profile.effort !== undefined && !effort(profile.effort)) || !text(value.rule) ||
      typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0.6 || value.confidence > 1) return empty("error");
  return { status, model: text(profile.model) ? profile.model : null, effort: effort(profile.effort) ? profile.effort : null,
    rule: value.rule, confidence: value.confidence };
}

function overlays(argv: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && i + 1 < argv.length) files.push(argv[++i]);
    else if (argv[i].startsWith("--config=")) files.push(argv[i].slice("--config=".length));
  }
  return files;
}

async function secretProtection(cwd: string): Promise<Protection> {
  for (const file of overlays(process.argv)) {
    try {
      if (/secrets/i.test(await readFile(resolve(cwd, file), "utf8"))) return "unprovable";
    } catch {
      return "unprovable";
    }
  }
  const command = await timed(15, process.execPath, ["config", "get", "secrets.enabled", "--json"], cwd, { ...process.env, OMP_SKIP_SETUP: "1" });
  if (command.status !== 0) return "unprovable";
  try {
    const value: unknown = JSON.parse(command.stdout);
    if (record(value) && value.key === "secrets.enabled" && typeof value.value === "boolean") return value.value ? "on" : "off";
  } catch { /* Not the documented shape. */ }
  return "unprovable";
}

function todoGoal(input: unknown): string {
  if (!record(input)) return "";
  const items: string[] = [];
  if (Array.isArray(input.list)) {
    for (const phase of input.list) {
      if (!record(phase) || !Array.isArray(phase.items)) continue;
      for (const item of phase.items) if (typeof item === "string") items.push(item);
    }
  } else if (Array.isArray(input.items)) {
    for (const item of input.items) if (typeof item === "string") items.push(item);
  }
  return items.join("\n");
}

export default function installJevRoute(pi: API): void {
  if (process.env.FM_TASK_ID || process.env.FM_JEV_ROUTE === "0") return;
  const home = resolve(process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root);
  const state = process.env.FM_STATE_OVERRIDE || join(home, "state");
  const hasFlag = (name: string) => process.argv.some(arg => arg === name || arg.startsWith(`${name}=`));
  const cliModel = hasFlag("--model") || hasFlag("--provider");
  const cliEffort = hasFlag("--thinking");
  let first = true;
  let lastPrompt = "";
  let baseline: { model: string | null; effort: Thinking } | undefined;
  let modelExplicit = cliModel;
  let effortExplicit = cliEffort;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  const snapshot = (ctx: Context) => ({ model: selector(ctx.models.current()), effort: pi.getThinkingLevel() });
  const primary =(ctx: Context) => resolve(ctx.cwd) === home && (ctx.mode === "tui" || ctx.mode === "rpc");
  const notify = (ctx: Context, message: string) => {
    if (ctx.ui?.notify) ctx.ui.notify(message, "info");
    else process.stderr.write(`${message}\n`);
  };
  const observeOverrides = (ctx: Context) => {
    const current = snapshot(ctx);
    if (baseline) {
      if (current.model !== baseline.model) modelExplicit = true;
      if (current.effort !== baseline.effort) effortExplicit = true;
    }
    baseline = current;
  };

  async function route(trigger: string, goal: string, ctx: Context, epoch: number): Promise<void> {
    if (epoch !== generation || !primary(ctx)) return;
    observeOverrides(ctx);
    let result = empty("error");
    let temp: string | undefined;
    const protection = await secretProtection(ctx.cwd);
    if (protection !== "off") {
      result = empty("declined");
    } else {
      try {
        temp = await mkdtemp(join(tmpdir(), "fm-jev-route-")); // mkdtemp creates a private 0700 directory.
        const brief = join(temp, "goal.txt");
        await writeFile(brief, goal, { mode: 0o600 });
        const command = await timed(15, join(root, "bin/fm-dispatch-resolve.sh"), [brief, "--project", basename(ctx.cwd), "--json"],
          root, { ...process.env, FM_HOME: home });
        result = parseResult(command.stdout, command.status);
      } catch {
        // Resolver diagnostics can contain input or credentials; publish metadata only.
        result = empty("error");
      } finally {
        if (temp) {
          try { await rm(temp, { recursive: true, force: true }); }
          catch { result = empty("error"); notify(ctx, "Jev route: temporary context cleanup failed"); }
        }
      }
    }
    if (epoch !== generation) return; // A new/replaced session must not inherit a stale decision.
    observeOverrides(ctx); // A user selection made during the resolver call wins too.
    let changed = false;
    let unchanged = true;
    if (result.status === "clear") {
      const previous = snapshot(ctx);
      const desired = modelExplicit || !result.model ? ctx.models.current() : ctx.models.resolve(result.model);
      const thinking = effortExplicit || !result.effort ? previous.effort : result.effort;
      // Resolve through the session's authenticated catalog, never through a fuzzy fallback.
      if (!previous.model || !desired || (!modelExplicit && result.model && selector(desired) !== result.model) ||
          !ctx.models.list().some(model => selector(model) === selector(desired)) || thinking === "auto") {
        result.status = "error";
      } else {
        const oldModel = ctx.models.current();
        try {
          if (selector(desired) !== previous.model) {
            if (!(await pi.setModel(desired))) throw new Error("Model unavailable");
            if (epoch !== generation) {
              if (oldModel && selector(ctx.models.current()) === selector(desired)) {
                try { await pi.setModel(oldModel); } catch { /* The replaced session reports its actual selection. */ }
                if (baseline) baseline.model = selector(ctx.models.current());
              }
              return;
            }
          }
          // Do not overwrite a selection made while OMP was resolving the model.
          if (selector(ctx.models.current()) !== selector(desired)) {
            observeOverrides(ctx);
            result.status = "error";
          } else {
          pi.setThinkingLevel(thinking);
          if (pi.getThinkingLevel() !== thinking) throw new Error("Effort unsupported");
          changed = true;
          }
        } catch {
          try {
            if (oldModel && selector(ctx.models.current()) !== previous.model) await pi.setModel(oldModel);
            pi.setThinkingLevel(previous.effort);
          } catch { /* Report the actual selection below if restoration was refused. */ }
          result.status = "error";
          unchanged = selector(ctx.models.current()) === previous.model && pi.getThinkingLevel() === previous.effort;
        }
      }
      baseline = snapshot(ctx);
      if (changed) { result.model = baseline.model; result.effort = baseline.effort; }
    }
    const line = changed
      ? `Jev route: ${result.model} ${result.effort} (${result.rule}, confidence ${result.confidence})${modelExplicit || effortExplicit ? " - explicit choices retained" : ""}`
      : `Jev route: ${result.status}${result.status === "declined" ? ` (secret protection ${protection})` : ""} - ${unchanged ? "model unchanged" : `could not restore selection; current ${selector(ctx.models.current())} ${pi.getThinkingLevel()}`}`;
    notify(ctx, line);
    try {
      await mkdir(state, { recursive: true, mode: 0o700 });
      await appendFile(join(state, ".jev-route.log"), `${JSON.stringify({ ts: new Date().toISOString(), trigger, ...result })}\n`, { mode: 0o600 });
    } catch {
      notify(ctx, "Jev route: could not write routing metadata");
    }
  }
  function enqueue(trigger: string, goal: string, ctx: Context): Promise<void> {
    const epoch = generation;
    queue = queue.catch(() => {}).then(() => route(trigger, goal, ctx, epoch));
    return queue;
  }

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    first = true;
    lastPrompt = "";
    modelExplicit = cliModel;
    effortExplicit = cliEffort;
    baseline = primary(ctx) ? snapshot(ctx) : undefined;
  });
  pi.on("session_shutdown", () => { generation += 1; });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!primary(ctx)) return;
    lastPrompt = event.prompt ?? lastPrompt;
    observeOverrides(ctx);
    if (!first) return;
    first = false; // Set before awaiting: OMP may prepare the same submission again.
    await enqueue("session", lastPrompt, ctx);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "todo" || !record(event.input) || event.input.op !== "init") return;
    await enqueue("todo-init", [lastPrompt, todoGoal(event.input)].filter(Boolean).join("\n\n"), ctx);
  });
  // OMP repairs some omitted-op todo calls at execution, not at tool_call time.
  // Use its successful resolved operation rather than inventing another inference rule.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "todo" || event.isError || !record(event.input) || event.input.op != null ||
        !record(event.details) || event.details.op !== "init") return;
    await enqueue("todo-init", [lastPrompt, todoGoal(event.input)].filter(Boolean).join("\n\n"), ctx);
  });
  pi.registerCommand("jev-route", {
    description: "Choose this task's model and effort with Jev; explicit choices still win",
    handler: async (args, ctx) => {
      if (!primary(ctx)) return;
      first = false;
      await enqueue("command", args.trim() || lastPrompt, ctx);
    },
  });
}

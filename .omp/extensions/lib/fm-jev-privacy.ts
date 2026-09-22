// Native OMP secret-protection gate shared by compaction and review.
// No configured LSP or installable host types: strict local types and real OMP
// config/overlay execution are verified by the Jev regression and live checks.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
// ---- omp's Hide Secrets switch: omp's own reader for the layered config
// files, plus the --config overlays only this process can see. ----

export type HideSecretsState = { state: "on" | "off"; source: string } | { state: "unprovable"; detail: string };

const OMP_CONFIG_GET_TIMEOUT_MS = 15_000;

/**
 * omp's own `config get secrets.enabled --json`, run as a child of this very
 * omp binary (process.execPath inside a session) with the session's cwd and
 * inherited environment, so omp's settings loader decides global/project
 * precedence, config.yml versus config.yaml, the project group-shadow rule,
 * and a --profile agent directory (exported as PI_CODING_AGENT_DIR).
 */
export function ompConfiguredSecretsEnabled(cwd: string, execPath = process.execPath): { value: boolean } | { error: string } {
  const run = spawnSync(execPath, ["config", "get", "secrets.enabled", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: OMP_CONFIG_GET_TIMEOUT_MS,
    env: { ...process.env, OMP_SKIP_SETUP: "1" },
  });
  if (run.error) return { error: `omp config get did not run (${run.error.message})` };
  if (run.status !== 0) return { error: `omp config get exited ${run.status ?? "by signal"}: ${(run.stderr || run.stdout || "").trim().slice(0, 200)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { error: "omp config get returned non-JSON output" };
  }
  const record = parsed as { key?: unknown; value?: unknown } | null;
  if (record?.key !== "secrets.enabled" || typeof record.value !== "boolean") return { error: "omp config get returned an unexpected shape for secrets.enabled" };
  return { value: record.value };
}

/** Every `--config <file>` / `--config=<file>` overlay on omp's own argv, in order, resolved against the session's working directory. */
export function overlayFilesFromArgv(argv: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && i + 1 < argv.length) files.push(argv[++i]);
    else if (arg.startsWith("--config=")) files.push(arg.slice("--config=".length));
  }
  return files.map((file) => (isAbsolute(file) ? file : resolve(cwd, file)));
}

type YamlMappingLine = { indent: number; key: string; value: string };

// null: a line that is not a plain `key: value` mapping line (list item,
// continuation); undefined: blank, comment, or document marker.
function yamlMappingLine(raw: string): YamlMappingLine | null | undefined {
  const line = raw.replace(/(^|\s)#.*$/, "");
  if (line.trim() === "" || /^\s*(---|\.\.\.)\s*$/.test(line)) return undefined;
  const match = /^["']?([A-Za-z0-9_.-]+)["']?\s*:(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { indent: line.length - line.trimStart().length, key: match[1], value: (match[2] ?? "").trim() };
}

function yamlBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * What one `--config` overlay states about `secrets.enabled`: the boolean
 * when a top-level `secrets:` block carries a plain boolean `enabled:` child
 * (the last statement wins), "unstated" when the overlay never mentions
 * secrets, and undefined for every other way of touching it - a bare or
 * flow `secrets:` group, an alias, a dotted `secrets.` key, a quoted or
 * non-boolean value - because omp's handling of those forms in an overlay is
 * not established here and a wrong guess would be a silent bypass.
 */
export function overlaySecretsStatement(text: string): boolean | "unstated" | undefined {
  let stated: boolean | "unstated" = "unstated";
  let block: { indent: number; childIndent?: number; statedEnabled: boolean } | undefined;
  const closeBlock = (): boolean => {
    if (block && !block.statedEnabled) return false;
    block = undefined;
    return true;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = yamlMappingLine(raw);
    if (line === undefined) continue;
    if (block && line !== null && line.indent <= block.indent && !closeBlock()) return undefined;
    if (block) {
      if (line === null) continue;
      block.childIndent ??= line.indent;
      if (line.indent === block.childIndent && line.key === "enabled") {
        const value = yamlBoolean(line.value);
        if (value === undefined) return undefined;
        stated = value;
        block.statedEnabled = true;
      }
      continue;
    }
    if (line === null || line.indent !== 0) continue;
    if (line.key === "secrets") {
      if (line.value !== "") return undefined;
      block = { indent: line.indent, statedEnabled: false };
    } else if (line.key === "secrets.enabled" || line.key.startsWith("secrets.")) {
      return undefined;
    }
  }
  return closeBlock() ? stated : undefined;
}

/**
 * omp's effective Hide Secrets switch for this session: omp's own answer for
 * the layered config files, then each --config overlay in launch order, a
 * later statement overriding an earlier one. Anything that cannot be
 * established faithfully is "unprovable", and the handler declines on it.
 */
export function hideSecretsState(cwd: string, argv: readonly string[] = process.argv): HideSecretsState {
  const configured = ompConfiguredSecretsEnabled(cwd);
  if ("error" in configured) return { state: "unprovable", detail: configured.error };
  let enabled = configured.value;
  let source = "omp config get secrets.enabled";
  for (const file of overlayFilesFromArgv(argv, cwd)) {
    let overlay: string;
    try {
      overlay = readFileSync(file, "utf8");
    } catch (error) {
      return { state: "unprovable", detail: `--config overlay ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    const statement = overlaySecretsStatement(overlay);
    if (statement === undefined) return { state: "unprovable", detail: `--config overlay ${file} touches secrets in a form this gate does not follow` };
    if (statement !== "unstated") {
      enabled = statement;
      source = `--config overlay ${file}`;
    }
  }
  return { state: enabled ? "on" : "off", source };
}

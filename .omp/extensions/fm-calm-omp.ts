// Firstmate's Calm presentation toggle for the omp (Oh My Pi) primary.
//
// A presentation-only adaptation of .pi/extensions/fm-calm.ts. While Calm is on
// and one logical agent run is active (agent_start through the agent_end whose
// willContinue is not true), the shared SSHHIP boat is installed as an
// above-editor widget and built-in tool rows are collapsed. The state line under
// the boat, the working-row text, and the footer hook status carry only what omp's
// own events show: `working`, `waiting for you` (an open tool approval), or
// `working, quiet Nm` when no tool or message event has arrived for a while. There
// is never a percent, an estimate, or a "nearly done" claim, and the run is
// reported finished only when omp settles it.
//
// Verified against omp 18.2.1: ctx.ui.setWidget(key, factory, { placement }) hands
// the factory the live TUI (requestRender) and theme; setWidget(key, undefined)
// disposes the component; setToolsExpanded/getToolsExpanded, setWorkingMessage
// (undefined restores the stock text), and setStatus(key, undefined-to-clear)
// are exposed by the interactive controller; agent_end carries willContinue;
// tool_approval_requested/resolved fire only when a tool needs approval. omp has
// no setWorkingVisible and no per-row renderer for built-in tools, so the stock
// working row stays on screen under the boat and tool rows collapse rather than
// disappear. Widgets are no-ops in RPC/ACP modes, so headless workers are unaffected.
//
// The preference is the same home-local config/calm file the Pi extension and the
// Claude Code mod share; docs/configuration.md owns its contract. Toggling Calm
// off restores the tool expansion observed when it was turned on and the stock
// working message. No tool is registered and no model context is injected.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALM_WORKING_SHIP_TICK_MS,
  CALM_WORKING_SHIP_WIDGET_KEY,
  createCalmWorkingShipAnimation,
  createCalmWorkingShipWidget,
} from "../../.pi/extensions/lib/fm-calm-working-ship.ts";

// The omp extension API surface this file uses, declared locally: omp ships no
// separately installable type package and is a Pi fork whose event and UI names
// match where they are used here.
type WidgetComponent = { render(width: number): string[]; invalidate(): void; dispose?(): void };
type WidgetTui = { requestRender(): void };
type ExtensionUI = {
  setWidget(key: string, factory: ((tui: WidgetTui, theme: unknown) => WidgetComponent) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  setWorkingMessage(message: string | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  setToolsExpanded(expanded: boolean): void;
  getToolsExpanded?(): boolean;
  notify(message: string, level?: string): void;
};
type Context = { ui: ExtensionUI; hasUI?: boolean };
type ExtensionAPI = {
  on?: (event: string, handler: (event: unknown, ctx: Context) => unknown) => void;
  registerCommand?: (name: string, command: { description: string; handler: (args: string, ctx: Context) => unknown }) => void;
};
const extensionFile = fileURLToPath(import.meta.url);
const root = resolve(dirname(extensionFile), "../..");
const fmHome = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root;
const configDirectory = process.env.FM_CONFIG_OVERRIDE || resolve(fmHome, "config");
const calmPreferencePath = resolve(configDirectory, "calm");

// "max" is the legacy value of a removed third level whose behavior is now ordinary
// Calm; docs/configuration.md owns the persisted value schema.
function loadCalmPreference(): boolean {
  let stored: string;
  try {
    stored = readFileSync(calmPreferencePath, "utf8").trim();
  } catch {
    return false;
  }
  return stored === "on" || stored === "max";
}

function persistCalmPreference(active: boolean): void {
  mkdirSync(dirname(calmPreferencePath), { recursive: true });
  const temporaryPath = `${calmPreferencePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, active ? "on\n" : "off\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, calmPreferencePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

const STATUS_KEY = "fm-calm";
// A run with no tool or message event for this long is reported as quiet, with its
// age; it is an observation about event silence, never a stuck or failed verdict.
const QUIET_AFTER_MS = 5 * 60 * 1000;
const STATE_REFRESH_MS = 15 * 1000;
const DIM = "\u001b[2m";
const RESET = "\u001b[22m";

export default function (pi: ExtensionAPI) {
  let calmActive = loadCalmPreference();
  let agentRunActive = false;
  let approvalPending = false;
  let lastEventAt = 0;
  let shipShown = false;
  let restoreToolsExpanded: boolean | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let lastStateText: string | undefined;
  const animation = createCalmWorkingShipAnimation();

  const stateText = (): string => {
    if (!agentRunActive) return "idle";
    if (approvalPending) return "waiting for you";
    const quietMs = Date.now() - lastEventAt;
    if (quietMs >= QUIET_AFTER_MS) return `working, quiet ${Math.floor(quietMs / 60000)}m`;
    return "working";
  };

  // Single owner of every presentation surface Calm touches. Only real transitions
  // create or dispose the widget, so repeated starts never duplicate its timer.
  const apply = (ui: ExtensionUI): void => {
    const showShip = calmActive && agentRunActive;
    if (showShip !== shipShown) {
      shipShown = showShip;
      ui.setWidget(
        CALM_WORKING_SHIP_WIDGET_KEY,
        showShip
          ? (tui) => {
              const ship = createCalmWorkingShipWidget(tui, animation);
              return {
                render: (width) => [...ship.render(width), `${DIM}${stateText()}${RESET}`],
                invalidate: () => {},
                dispose: () => ship.dispose(),
              };
            }
          : undefined,
        { placement: "aboveEditor" },
      );
    }
    const text = calmActive ? stateText() : undefined;
    if (text !== lastStateText) {
      lastStateText = text;
      ui.setStatus(STATUS_KEY, text);
      ui.setWorkingMessage(calmActive && agentRunActive ? text : undefined);
    }
    if (showShip && !refreshTimer) {
      refreshTimer = setInterval(() => apply(ui), STATE_REFRESH_MS);
      refreshTimer.unref?.();
    } else if (!showShip && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };

  const setCalm = (ui: ExtensionUI, active: boolean): void => {
    if (active === calmActive) return;
    calmActive = active;
    if (active) {
      restoreToolsExpanded = ui.getToolsExpanded?.();
      ui.setToolsExpanded(false);
    } else if (restoreToolsExpanded !== undefined) {
      ui.setToolsExpanded(restoreToolsExpanded);
      restoreToolsExpanded = undefined;
    }
    apply(ui);
  };

  const touch = (ui: ExtensionUI): void => {
    lastEventAt = Date.now();
    apply(ui);
  };

  pi.registerCommand?.("calm", {
    description: "Toggle Firstmate Calm: boat while working, collapsed tool rows",
    handler: (_args, ctx) => {
      const next = !calmActive;
      persistCalmPreference(next);
      setCalm(ctx.ui, next);
      ctx.ui.notify(next ? "Calm on: boat while working, tool rows collapsed" : "Calm off: stock presentation restored", "info");
    },
  });

  pi.on?.("session_start", (_event, ctx) => {
    animation.reset();
    if (calmActive && restoreToolsExpanded === undefined) {
      restoreToolsExpanded = ctx.ui.getToolsExpanded?.();
      ctx.ui.setToolsExpanded(false);
    }
    apply(ctx.ui);
  });

  pi.on?.("agent_start", (_event, ctx) => {
    agentRunActive = true;
    approvalPending = false;
    touch(ctx.ui);
  });

  pi.on?.("agent_end", (event, ctx) => {
    if (event && typeof event === "object" && "willContinue" in event && event.willContinue === true) return;
    agentRunActive = false;
    approvalPending = false;
    apply(ctx.ui);
  });

  pi.on?.("tool_approval_requested", (_event, ctx) => {
    approvalPending = true;
    touch(ctx.ui);
  });

  pi.on?.("tool_approval_resolved", (_event, ctx) => {
    approvalPending = false;
    touch(ctx.ui);
  });

  for (const event of ["tool_execution_start", "tool_execution_update", "tool_execution_end", "message_update"]) {
    pi.on?.(event, (_event, ctx) => {
      if (agentRunActive) touch(ctx.ui);
    });
  }

  pi.on?.("session_shutdown", (_event, ctx) => {
    agentRunActive = false;
    apply(ctx.ui);
  });
}

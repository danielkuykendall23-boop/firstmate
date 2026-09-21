# Calm on omp: real-terminal evidence

Target commit 9351d57 on branch fm/fm-calm-fork-delivery, tested against the installed
`omp` 18.2.5 (the extension header says it was verified on 18.2.1; 18.2.7 is available
but not installed).

## How the run was driven

- A fresh `git clone` of the target commit was launched as a real interactive omp TUI inside
  a pseudo-terminal (110x34) and rendered through a VT emulator; each PNG is that screen.
- omp ran with an isolated agent directory (`PI_CODING_AGENT_DIR`), `--no-session`, and
  `FM_CONFIG_OVERRIDE` pointing at a lab config dir, so the captain's real `~/.omp/agent`
  and Firstmate home were never touched (listing and config checksum verified unchanged).
- No model credentials or quota were used: a lab-only extension registered a deterministic
  provider (`calm-e2e/scripted`) whose first turn calls the real built-in `bash` tool
  (`sleep 10` then forty output lines) and whose second turn returns a final text.
  The only Firstmate extension present was the tracked `.omp/extensions/fm-calm-omp.ts`,
  auto-discovered with no `-e` flag.
- Tool approval mode was `always-ask` so a real approval dialog opened mid-run.

## What each screen shows

| Screen | What it proves |
| --- | --- |
| `01-startup-calm-off` | Fresh session, no `config/calm`: stock omp footer, no Calm status. |
| `02-calm-on-notice-idle` | `/calm` typed: "Calm on: boat while working, tool rows collapsed" notice; footer status `idle`; lab `config/calm` now reads `on`. |
| `03`/`04-working-boat-frame-*` | Run started: two-row sailboat above the editor, dim state line `working`, footer `working`; frames differ (boat and swell moved). omp's own "Working…" row stays visible under the boat, as documented. |
| `05-waiting-for-you-approval` | The `bash` approval dialog is open: state line and footer both read `waiting for you`. |
| `06-working-after-approval-tool-collapsed` | Approved (Enter): back to `working`; the running tool row shows only the command. |
| `07-run-settled-idle-boat-gone` | Run settled: boat and state line gone, footer `idle`, final text visible. The tool row carries omp's collapse marker "… (30 earlier lines, showing 10 of 40) ⟦Ctrl+O: Expand⟧" because Calm collapsed tool output (ctrl+o had expanded it before `/calm`). |
| `08-calm-off-tool-rows-restored` | `/calm` again: "Calm off: stock presentation restored", footer status cleared, all forty output lines shown again (expansion restored to what it was when Calm was turned on); `config/calm` reads `off`. |
| `09-relaunch-preference-on-footer-idle` | `config/calm` written as `on` externally, omp relaunched: footer already shows `idle` with no `/calm` typed (session_start reload). |
| `10-after-new-session-switch` | `/new` inside the same process: Calm status persists across omp's session_switch. |
| `baseline-b01`/`b02` | Calm off, same forty-line output: omp's native default is collapsed (same marker), and ctrl+o expands it with omp's own "Tool output expansion: enabled" notice. |
| `q00`–`q03` | Second run with `config/calm` pre-set to `on` and `--auto-approve`, where the scripted model stays silent for 322 seconds before its first tool call: after five minutes without any tool or message event the state line under the boat and the footer status both read `working, quiet 5m` (an age, not a verdict), and the run still settles to `idle`. The boat's state line is drawn live on each animation frame while the footer status is refreshed on the extension's 15-second timer, so the footer can trail the boat line by up to 15 seconds; the `q02` frame is taken from the captured stream at the point both agree. A first attempt with a 335-second `bash` sleep did not work as a probe because omp 18.2.5 moves a long-running bash into a background job, ends the tool early, and settles the run. |

The state line vocabulary observed on screen was exactly `idle`, `working`, `waiting for you`,
and `working, quiet Nm`. No percent, estimate, or "almost done" text appeared anywhere.

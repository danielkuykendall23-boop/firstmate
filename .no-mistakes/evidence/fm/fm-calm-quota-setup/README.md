# Calm on omp: live terminal evidence

Branch `fm/fm-calm-quota-setup`, target commit `ec8f862`, tested 2026-09-18 against the installed
omp 18.2.5 (`~/.local/bin/omp`) with the captain's existing omp Anthropic login and
`--model anthropic/claude-fable-5-1 --thinking low --approval-mode always-ask`.

The real omp TUI was driven inside a pseudo-terminal (110x34, `TERM=xterm-256color`) by
`omp-tui-driver.py` (pyte terminal emulation) using the step script `calm-run.json`, from the
worktree root with only the Calm extension loaded
(`omp --no-extensions -e .omp/extensions/fm-calm-omp.ts`), `FM_CONFIG_OVERRIDE` pointing at a
temp config directory, and an isolated `--session-dir`. Every screen in `omp-tui-snapshots/` is
the emulated terminal at that moment: `.txt` is the plain screen, `.html` keeps the colors, and
`.png` is that HTML rendered in Chrome.

## Sequence (one real Claude Fable 5.1 turn)

| Screen | What it shows |
| --- | --- |
| `00-startup-calm-off` | Stock omp start screen, no Calm status in the footer. |
| `01-calm-on-idle` | `/calm` typed: transient notice "Calm on: boat while working, tool rows collapsed", footer status `idle`. |
| `02-bash-approval-waiting-for-you` | The model called bash; omp's "Allow tool: bash" dialog is open. The boat is above the editor with the state line `waiting for you`, and the footer status says `waiting for you`. The tool row is collapsed to its one-line command box. |
| `03-bash-running-working` | Approval given, `sleep 15` running: state line and footer both say `working`; the boat has moved; omp's own "Running…" row stays under the boat as documented. |
| `05-ask-open-waiting-for-you` | The model then called omp's built-in `ask` tool ("Ahoy captain?"). While the question is open the state line and footer say `waiting for you` (the round-1 decision that an open ask counts as waiting). |
| `06-settled-idle` | Answered "Aye"; the run settled with the reply `calm-check-ok`. The boat is gone and the footer status is `idle`. No percent, estimate, or "almost done" text appeared at any point. |
| `07-after-new-with-preference-off` | `config/calm` rewritten to `off` from outside, then `/new` in the same process (omp emits `session_switch`): the Calm footer status is gone. |
| `08-after-new-with-preference-on` | `config/calm` rewritten to `on`, `/new` again: footer status `idle` is back. |
| `09-calm-off-notice` | `/calm` again: "Calm off: stock presentation restored". |
| `a1-calm-on-autodiscovered` | Separate launch from the checkout **without** `-e` (all three tracked `.omp/extensions` auto-discovered, `FM_STATE_OVERRIDE` to a temp dir): `/calm` registers and toggles the same way. |

Persisted preference written by the extension (atomic rename, `wx` temp file):

- `config-calm-after-calm-on.txt` = `on\n` (copied after step 06)
- `config-calm-after-calm-off.txt` = `off\n` (copied after step 09)

`omp-tui-snapshots/driver.log` is the timestamped step log; `raw.bin` (not copied) held every byte omp wrote.

## Automated suites run

- `bash tests/fm-omp-harness.test.sh` (includes the new fake-API Calm case): all 12 cases ok.
- `bash tests/fm-calm-pi-extension.test.sh` (Pi fixtures now copy the shared preference lib): ok; the three tmux-dependent E2E cases skipped because tmux is not installed here.
- `PATH=<local tsc 5.8.3>:$PATH bash tests/fm-pi-primary-types.test.sh`: strict typecheck ok (skips without a `tsc` on PATH).
- `bin/fm-test-run.sh --list --changed --base daaffdb5`: the new mappings select the omp harness, Pi Calm, Pi types, and Calm Claude mod suites.

omp 18.2.5 embedded source was checked for the events the extension binds: `session_switch` is
emitted with reasons `new`, `fork`, and `resume`; the question tool is still named `ask`;
`setWidget` defaults to `aboveEditor`; `setToolsExpanded`/`getToolsExpanded`, `setStatus`, and the
`tool_approval_requested`/`tool_approval_resolved` pair are all present; there is still no
`setWorkingVisible`.

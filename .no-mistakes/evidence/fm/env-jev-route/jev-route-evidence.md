# Task-bound Jev routing: test evidence

Branch `fm/env-jev-route`, target `a0d5515`, omp/18.2.8, Node v24.11.1, macOS arm64.
Everything below ran against loopback fake Jev, chat, and quota endpoints. No credentials, no vendor calls, no real key.

## Automated tests (all pass)

| Test | Log |
| --- | --- |
| `tests/fm-jev-route.test.sh` (node unit test, 9 cases) | `fm-jev-route-node-test.log` |
| `tests/fm-spawn-resolve.test.sh` | `fm-spawn-resolve-test.log` |
| `tests/fm-dispatch-resolve.test.sh` | `fm-dispatch-resolve-test.log` |
| `tests/fm-jev-route-live-e2e.test.sh` (real omp RPC + TUI) | `fm-jev-route-live-e2e.log` |

## Interactive terminal (the captain's surface)

`jev-route-evidence-driver.py` launched the real omp interactive TUI under a pseudo-terminal with the extension
auto-discovered from `<home>/.omp/extensions/` (no `-e` flag, the same shape as a real Firstmate home) and
rendered the screen with a VT emulator. Screenshots:

| Screenshot | What it shows |
| --- | --- |
| `tui-tui-keyed-01-startup.png` | Before any prompt: footer `initial`, low effort (saved default). |
| `tui-tui-keyed-02-jev-route-notice.png` | Right after the first prompt: notice `Jev route: route-fake/routed high (rule_1, confidence 0.95)`, footer already `routed`. |
| `tui-tui-keyed-03-after-first-prompt.png` | After the todo-init plan boundary: second notice, footer `routed`, reply rendered. |
| `tui-tui-keyed-04-routine-turn.png` | A routine follow-up turn: no new notice, footer still `routed`. |
| `tui-tui-nokey-02-jev-route-notice.png` | No key: notice `Jev route: off - model unchanged`, footer stays `initial`. |
| `tui-tui-nokey-03-after-first-prompt.png` | No key after the plan boundary: still `initial`, low. |

All five real chat requests in the keyed TUI session were sent with model `routed`; all five in the no-key session used `initial`.

## RPC transcripts

`rpc-<name>-transcript.txt` (condensed) and `rpc-<name>-frames.jsonl` (every frame) for `keyed`, `nokey`, `protected`:

- keyed: `get_state` initial/low; first prompt emits `model_changed`, `thinking_level_changed`, two `notify` frames; `get_state` routed/high; routine turn adds no log row; after `set_model manual` + `set_thinking_level low`, `/jev-route` reports `... - explicit choices retained` and `get_state` stays manual/low.
- nokey: three `Jev route: off - model unchanged` notices, model never changes, zero Jev requests.
- protected (Hide Secrets on in the isolated agent config): `Jev route: declined (secret protection on) - model unchanged`, zero Jev requests.

Each transcript ends with the session's `state/.jev-route.log`, which holds only timestamp, trigger, status, model, effort, rule, confidence.

## Worker spawn path

`spawn-resolve-transcript.txt` runs the real `bin/fm-spawn.sh` with `--resolve` through the real resolver and shows the
staged worker launch command: resolved `--model 'openai-codex/gpt-6-astra' --thinking 'high'` adopted; explicit
`--model/--effort` win per axis; explicit `--harness claude` with a resolved omp model refuses before allocation;
scout resolves; no key + `--resolve` refuses with `dispatch resolution off`; the documented no-key fallback (no `--resolve`)
launches the explicit selection with no Jev call; ambiguous and transport-error answers refuse before launch.

## Saved defaults untouched

Every session's isolated `agent/config.yml` kept identical bytes and mtime, and the real `~/.omp/agent/config.yml`
metadata (size 610, mtime) was identical before and after the whole run (`jev-route-evidence-summary.json`).

## Not proven here

Production authentication, credits, and real Jev rule quality: the fake endpoint answers `rule_1` at confidence 0.95.
`docs/verification/dispatch-resolve.md` "Pending live proof" owns those steps once a key exists.

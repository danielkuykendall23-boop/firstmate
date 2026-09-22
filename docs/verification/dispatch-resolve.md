# Typed dispatch resolution verification

Audience: maintainer verification.

This record supports the opt-in `bin/fm-dispatch-resolve.sh` contract owned by [`../configuration.md`](../configuration.md) ("Typed dispatch resolution") and the declared rule and profile fields owned there under "Crew dispatch profiles".
It records only facts that must be re-established when the typesafe.ai model, its API, or firstmate's dispatch rules change.
Task chronology, the captain's rules, and the briefs themselves stay in the private scout report.

## The API the tool depends on

Verified 2026-09-16 against `https://api.typesafe.ai`.
`GET /v1/models` listed `jev-latest` and `jev-preview`, both released 2026-09-10; a `jev-latest` request answered as `jev-1.13.0`.
`POST /v1/systemone` takes `{model, state, questions}`; a `choice` question returns `{choice, probabilities, confidence}` with the probabilities summing to 1.
Observed error shapes: 401 `authentication_error` for a bad key, 403 when the header is missing, 422 with a `detail[].loc` naming the offending field, 400 `api_usage_error` for an unknown model, 405 on GET.
No rate-limit headers were present on any response; every response carried `x-typesafe-request-id`.
Observed end-to-end latency from a Mac was 123 to 348 ms per request, with the server's own upstream time at 4 to 60 ms.

## Live rule match against real briefs

Run 2026-09-16 with the key injected for the one command through the vault (`av inject +TYPESAFE_API_KEY -- ...`), model `jev-latest`, confidence floor 0.6, timeout 5 s, one `quota-axi --json` snapshot for the whole run.
Rules: the captain's five-rule file with a captain-authored none option, one `approval: captain` rule, two rule floors on `model:fable`, and declared `provider` on the Pi profiles.
Briefs: 15 real briefs from this home's recent work plus 10 synthetic ones written to hit each rule.

| Measure | Result |
| --- | --- |
| Rule matched the hand label | 20 of 25 |
| Resolved to the hand-labeled profile | 20 of 25 |
| Outcomes: clear / ambiguous / escalate / error | 18 / 1 / 6 / 0 |
| Clear results with a wrong profile | 0 |
| API latency (min / median / max) | 152 / 214 / 348 ms |
| Wall time per call including jq (min / median / max) | 198 / 261 / 396 ms |
| Input tokens per brief (min / median / max) | 1,279 / 3,114 / 4,538 |
| Output tokens | 150 to 152 |
| API errors | 0 |

Of the five disagreements, one was a wrong hand label (the brief quoted the bug-fix rule's wording verbatim), three were real briefs the model read as the approval-gated design rule at 0.66 to 0.86 confidence and escalated by design, each of which the captain had in fact dispatched at the strongest-reasoning class, and one was a synthetic tweak that came back ambiguous at 0.41 confidence and was handed back to firstmate.
A lean request that asks only the rule Choice matched the full request (rule, profile, and status) on all 25 briefs, which is why the shipped tool asks one question and keeps every gate in code.
That table records the 2026-09-16 run with the captain-authored none option.
A second live run on 2026-09-17 used the same 25 briefs, held one quota snapshot constant through a fake `quota-axi`, and exercised a copy of this branch with the shipped neutral `No listed rule applies to this task.` option and option-free interface.

| Measure | Result |
| --- | --- |
| Rule matched the hand label | 20 of 25 |
| Resolved to the hand-labeled profile | 18 of 25 |
| Outcomes: clear / ambiguous / escalate / error | 17 / 2 / 6 / 0 |
| Clear results with a profile other than the hand label | 1 |
| API latency (min / median / max) | 137 / 220 / 1,795 ms |
| Input tokens per brief (min / median / max) | 754 / 2,589 / 4,013 |
| Output tokens | 60 to 62 |
| API errors | 0 |

The maximum latency was one outlier; the next slowest request was 309 ms.
The differing clear result was a synthetic small tweak that matched the simple-bug-fix rule at 0.90 and selected `cursor-grok-4.6-medium` instead of the hand-labeled `cursor-grok-4.6-high`: the tweak exemption removed from the none-option text belongs in that rule's own `when` text.
Two default-labeled briefs became ambiguous.

## Offline behavior

`tests/fm-dispatch-resolve.test.sh` drives the public interface with a fake `curl` that records argv, the request body, the header read from file descriptor 3, and whether the secret reached its environment, plus a fake `quota-axi` that performs the same environment check.
It proves firstmate can invoke the resolve path without a preflight, rules are snapshotted once from the isolated home's canonical `config/crew-dispatch.json`, and dynamic output fields are flattened to one line.
It proves the absent key (environment and `.env`) prints one stderr line, nothing on stdout, exits 0, and never invokes `curl` or `quota-axi`.
It proves absent, default-only, and empty-rules files return `no rules to match` without a model or quota request, while a broken rules-file symlink exits 2 as unreadable.
It proves the documented starter configuration resolves its Pi default through the declared Claude provider, a `.env` key turns the tool on, and the environment wins over it.
It proves the key is absent from child environments, never appears on `curl` argv, and arrives only as the bearer header on the descriptor.
It proves the request uses the fixed endpoint and model, carries only the project, brief, and rule Choice with one option per rule plus the fixed neutral none option, and never carries `why`, `use`, or quota.
It proves the clear, fixed-floor ambiguous with candidate evidence, escalate (approval with candidate evidence, unverifiable rule floor, tie, nothing rankable), known rule-floor fall-through, known and unverifiable profile-floor evidence, explicit-provider and provider-ID enforcement, authoritative Agy and explicit-provider Gemini routing, partial providers, eligible unranked candidates and their clear-result note, concrete quota vetoes and profile-floor shortfalls taking precedence over uncertainty, account-wide quota veto, limiting-bound ranking, missing-curl and quota-axi failures, HTTP 429 and 500, transport failure, malformed usage, zero-mass or malformed probabilities or confidence, malformed or duplicate profile, invalid selector, removed-option rejection, and out-of-range rule ID paths behave as the contract states, with configuration errors exiting 2 before any network call.
`tests/fm-bootstrap.test.sh` proves bootstrap ignores resolver-only fields without the typed key, validates each malformed shape when the environment or home `.env` activates typed resolution, and prevents an environment-provided key from reaching child processes.

```console
$ bash tests/fm-dispatch-resolve.test.sh | tail -1
# all fm-dispatch-resolve tests passed
```

A live run needs a key and is not part of the suite; rerun the table above by pointing the tool at a brief with the key injected for that one command.

## Primary and spawn routing: fake endpoint

Verified 2026-09-21 on macOS arm64 with omp/18.2.8, Node v24.11.1, jq-1.7.1-apple, and the system python3 as the pseudo-terminal driver.
These commands exercise the real resolver and OMP runtime without production Jev credentials or provider tokens:

```sh
bin/fm-test-run.sh tests/fm-dispatch-resolve.test.sh
bin/fm-test-run.sh tests/fm-spawn-resolve.test.sh
bin/fm-test-run.sh tests/fm-jev-route.test.sh
bin/fm-test-run.sh tests/fm-jev-route-live-e2e.test.sh
```

The spawn fixture verifies clear selection, independent explicit axes, the positional harness override, refusal of a resolved model under a different explicit harness, scout routing, non-clear refusal before launch, the documented no-key launch of an explicit selection without `--resolve`, and rejection of secondmate, relaunch, and batch resolution.
The portable extension tests cover session and todo boundaries, inferred todo operations, worker, print-mode and unrelated-session isolation, fallback, an empty resolver answer treated as an error rather than off, explicit selection during an in-flight decision, obsolete-session decisions including a model applied as the session is replaced, unsupported effort, secret-protection declines with zero resolver calls, and private temporary-file cleanup.
The live guard uses a private `FM_HOME`, separate synthetic user home and agent configuration, fake quota, and loopback Jev and chat endpoints, and drives omp both over RPC and as a real interactive terminal session (extension mode `tui`) under a Python pseudo-terminal.
It asserts the model used by an actual OMP chat request, not merely a routing log, and that a session whose isolated agent configuration enables Hide Secrets makes no Jev request.

Observed live-guard output:

```text
ok - omp/18.2.8 rpc fake endpoint: initial/low -> routed/high; routine turn retained; explicit manual/low retained; saved config unchanged
ok - omp/18.2.8 rpc no key: initial/low -> initial/low; routine turn retained; explicit manual/low retained; saved config unchanged
ok - omp/18.2.8 rpc secret protection on: initial/low -> initial/low; routine turn retained; explicit manual/low retained; saved config unchanged
ok - omp/18.2.8 interactive tui fake endpoint: initial/low -> routed/high on the first prompt; todo boundary rerouted; both chat requests used routed; saved config unchanged
ok - fake Jev requests=5; real OMP chat requests=18; real global config metadata unchanged; authenticated Jev proof pending
```

The verified API is `pi.setModel(ctx.models.resolve("provider/id"))`: passing a selector string directly returned `false`, while the registry model object returned `true` and changed the active model.
`pi.setThinkingLevel("high")` changed the session's effort without changing saved configuration.
The guard checks the isolated saved config's bytes and modification time and the real global config's size and modification time, without reading real credentials.
An RPC `prompt` response acknowledges a slash command before its handler completes; the guard waits for that command's matching `prompt_result` before checking its final model.
`FM_JEV_ROUTE_LIVE_E2E=1` requires the installed runtime and tools rather than allowing a capability skip.

## Pending live proof

The following checks remain unrun until a real key, credits, and user-authorized OMP login exist.
The fake-endpoint results above do not establish production authentication, account access, or real Jev rule quality.
Run from the real Firstmate home, with real `curl` and quota tools on `PATH`, no fake provider or transport, and no worker marker:

```sh
FM_HOME=/Users/danielkuykendall/kun-agent-workspace bin/fm-dispatch-resolve.sh data/env-jev-route/brief.md --project kun-agent-workspace
```

Require `clear`, a matched rule, and confidence at least 0.6; a different outcome is evidence to inspect, not permission to force a launch.
Next, start a separate RPC process without other extensions or a saved session:

```sh
env -u FM_TASK_ID -u FM_JEV_ROUTE FM_HOME=/Users/danielkuykendall/kun-agent-workspace \
  omp --mode rpc --no-session --no-extensions --no-skills --no-rules --tools todo \
  -e .omp/extensions/fm-jev-route.ts
```

After its `ready` event and registration of `jev-route`, send these JSON records one at a time, waiting for the first state response and then `agent_end` before the final state request:

```json
{"id":"before","type":"get_state"}
{"id":"route","type":"prompt","message":"Choose the model and effort for this task, then reply ROUTE_LIVE_OK without tools."}
{"id":"after","type":"get_state"}
```

Require a clear routing record and a corresponding active-model switch in RPC, with saved global model configuration unchanged.
Select an authorized rule whose model differs from the initial selection so the switch assertion is not vacuous.
Finally, after filing a newly authorized ship task and writing its real brief, exercise spawn-time selection through the normal guarded launch:

```sh
bin/fm-spawn.sh <new-task-id> <project-dir> --mode no-mistakes --yolo off --resolve
```

Require adoption of the resolver's clear axes or refusal before launch for any other outcome, preserving explicit flags per axis.
Do not reuse an active task id or dispatch a synthetic production task merely to obtain this evidence.

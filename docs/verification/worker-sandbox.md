# Worker sandbox verification

Audience: maintainer verification.

This record supports the supported-harness list and writable set owned by the [`bin/fm-worker-sandbox.sh`](../../bin/fm-worker-sandbox.sh) header and the operator contract in [`docs/configuration.md`](../configuration.md) "Worker sandbox".
It records only facts that must be re-established when macOS, omp, or a worker-side Firstmate script that writes task state changes.
Task chronology and full transcripts stay in private reports or PR evidence.

## Regression entry point

`tests/fm-worker-sandbox.test.sh` pins the refusal contract on every platform and, on macOS, executes the exact launch `bin/fm-spawn.sh` staged under the real `/usr/bin/sandbox-exec`, with a stand-in harness that performs a worker's writes and forbidden writes.
Re-run it, and repeat the live proof below, after any change to the writable set, to a worker-side script that writes under `state/` or `data/`, or to the omp launch.

## Harness facts the design rests on

Verified 2026-09-28 on macOS 26.3 (build 25D125).

- omp 18.2.10 has no native sandbox: its extension, plugin, browser, and computer-use documentation each states that code runs unsandboxed, and `omp --help` offers only `--auto-approve` and `--approval-mode`.
- Claude Code's sandbox covers only Bash, PowerShell, and Monitor commands; its sandboxing documentation states "Read, Edit, and Write use the permission system directly rather than running through the sandbox", so under a bypassed permission posture its file tools stay unfenced.
- Claude Code 2.1.280 could not be proven here: `claude auth status` reported `"loggedIn": false`, and its own unsandboxed turn failed with `Failed to authenticate: OAuth session expired and could not be refreshed`.
  Under the wrapper it also needs `CLAUDE_CODE_TMPDIR`, because it otherwise creates `/tmp/claude-501` and stops with `EPERM: operation not permitted, mkdir '/tmp/claude-501'`, plus write access to `~/.claude.json.tmp.*` and `~/.local/state/claude/locks/`.
- The Codex CLI was not installed, so Codex could not be proven.
- `/usr/bin/sandbox-exec` is marked deprecated in its manual page but enforces profiles on this release, and nested Seatbelt profiles are not supported, so a harness's own sandbox must stay off inside the wrapper.

## Live proof

A throwaway Firstmate home held `config/worker-sandbox` set to `on` and a two-file project.
`bin/fm-spawn.sh` staged a real scout launch and a real local-only ship launch through the fake tmux spawn world from `tests/fixtures.sh`, and each staged command then ran in a real terminal with the interactive omp 18.2.10 TUI on its default model.
Both briefs were real `bin/fm-brief.sh` scaffolds whose tasks added deliberate writes outside the fence.

The staged launch began:

```text
'/usr/bin/sandbox-exec' -f '/tmp/fm-sbx-live-scout+<home-token>/sandbox.<gen>.sb' /bin/sh -c 'export COMPACT_ADVISER_DISABLE=1; FM_HOME=...
```

The scout's final status line:

```text
done [at=1790602838]: calc.py provides add(a,b) only; README.md does not document it. Neighbor write refused (Operation not permitted); doctor ok, axi status fails (repo not initialized). Read inbox message 001.
```

Its completion gate, `bin/fm-captain-hold.sh complete <id> --none`, ran fenced and recorded `decisions_reviewed=1` in the task's own record.
Before the fence opened the task's own `state/<id>.meta` and `state/.meta-<id>.lock*`, that step never finished: the denied lock create was treated as a stale holder and retried as an ever-longer `.meta-<id>.lock.steal.steal...` path.
`bin/fm-wake-lib.sh` now reports a lock whose create is refused as uncreatable and stops the wait with a clear error instead of stealing, and `tests/fm-watcher-lock.test.sh` pins that; a worker-side script that needs a lock outside the fence therefore fails visibly rather than hanging.

The ship's final status line:

```text
done [at=1790602828]: ready in branch fm/sbx-live-ship (05ab06d, subtract added); inbox 001.msg read+acked to handled/; neighbor/precious.txt write REFUSED: 'Operation not permitted (os error 1)'; toyproj/HACK.txt create REFUSED: 'touch: cannot touch ...: Permission denied'; git push to ~/.no-mistakes/repos/fm-sandbox-probe.git SUCCEEDED ('* [new branch] HEAD -> probe', exit 0) - fence gap; Jev skipped per spec
```

The push target was a throwaway bare repository under `~/.no-mistakes/repos/`, where a no-mistakes remote lives, so that write is allowed by design.
No pipeline run was started, because the throwaway project had no forge remote for the pipeline's push and pull-request steps; the fenced scout confirmed `no-mistakes doctor` exits 0.

Every write the kernel refused during both complete sessions, read with `log show --predicate 'eventMessage CONTAINS "deny" AND eventMessage CONTAINS "file-write"'`:

```text
Sandbox: omp deny(1) file-write-create /private/tmp/fm-fm-mac-worker-sandbox/live/neighbor/scout-was-here.txt
Sandbox: omp deny(1) file-write-create /private/tmp/fm-fm-mac-worker-sandbox/live/toyproj/HACK.txt
Sandbox: omp deny(1) file-write-data /private/tmp/fm-fm-mac-worker-sandbox/live/neighbor/precious.txt
```

Only the three deliberate writes were refused; omp's own session, extension, and busy-state writes needed nothing outside the writable set.
Run fenced from a Firstmate worktree, `gh auth status`, `gh api`, `gh-axi pr list`, and `git ls-remote origin` over HTTPS all succeeded with no refused write.

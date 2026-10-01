# Shake-first worker compaction: live OMP 18.2.10 runs against a disposable local fake model

Launch shape (same as bin/fm-spawn.sh omp template): OMP_SKIP_SETUP=1 FM_OMP_HARNESS=omp omp --config <worktree>/.omp/fm-worker-overlay.yml --auto-approve --cwd <work> --model fake/fake-1 -p ...
Isolated HOME per run with config.yml = captain order [remote, handoff, snapcompact, shake, soft]; models.yml points provider 'fake' at 127.0.0.1 (64k window).

## Overlay file under test
compaction:
  # Shake moved first: it moves old tool output to recoverable artifact:// links
  # with no model, key or network; a remote-first order never reaches it. The
  # captain's own tail order (remote, handoff, snapcompact, soft) is kept.
  methodOrder: [shake, remote, handoff, snapcompact, soft]

## 1. Effective method order inside the live session (OMP debug log)
### worker WITH overlay
{"message":"Mid-run compaction ran between provider calls","contextTokens":53687,"contextWindow":64000,"methods":["shake","remote","handoff","snapcompact","soft"]}
### same captain config, WITHOUT overlay (primary-session behaviour)
{"message":"Mid-run compaction ran between provider calls","contextTokens":53687,"contextWindow":64000,"methods":["remote","handoff","snapcompact","shake","soft"]}

## 2. Which method acted first (requests seen by the fake model)
### overlay
req1: shaken-markers-in-context=0 handoff-summary-request=0
req2: shaken-markers-in-context=0 handoff-summary-request=0
req3: shaken-markers-in-context=0 handoff-summary-request=0
req4: shaken-markers-in-context=0 handoff-summary-request=0
req5: shaken-markers-in-context=0 handoff-summary-request=0
req6: shaken-markers-in-context=1 handoff-summary-request=1
### nooverlay
req1: shaken-markers-in-context=0 handoff-summary-request=0
req2: shaken-markers-in-context=0 handoff-summary-request=0
req3: shaken-markers-in-context=0 handoff-summary-request=0
req4: shaken-markers-in-context=0 handoff-summary-request=0
req5: shaken-markers-in-context=0 handoff-summary-request=1
req6: shaken-markers-in-context=0 handoff-summary-request=0

## 3. Worker session file (overlay) - tool results before the first compaction entry
{"type":"message","method":null,"text":"[shaken ~7328 tokens — recover: artifact://5 (region 1)]"}
{"type":"message","method":null,"text":"[shaken ~7328 tokens — recover: artifact://5 (region 2)]"}
{"type":"message","method":null,"text":"call3 line 1 marker-UNIQUE-3-1 padding padding padding\ncall3 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"call4 line 1 marker-UNIQUE-4-1 padding padding padding\ncall4 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"[shaken ~7328 tokens — recover: artifact://10 (region 1)]"}
{"type":"compaction","method":"handoff","text":""}

### baseline session file (no overlay)
{"type":"message","method":null,"text":"call1 line 1 marker-UNIQUE-1-1 padding padding padding\ncall1 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"call2 line 1 marker-UNIQUE-2-1 padding padding padding\ncall2 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"call3 line 1 marker-UNIQUE-3-1 padding padding padding\ncall3 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"call4 line 1 marker-UNIQUE-4-1 padding padding padding\ncall4 line 2 marker-UNIQU"}
{"type":"message","method":null,"text":"call5 line 1 marker-UNIQUE-5-1 padding padding padding\ncall5 line 2 marker-UNIQU"}
{"type":"compaction","method":"handoff","text":""}
shake artifacts in baseline session dir: 0

## 4. Shake artifact artifact://5 (5.shake.log) - region headers and original text
1:### region 1 (bash, ~7328 tok)
507:### region 2 (bash, ~7328 tok)
### region 1 (bash, ~7328 tok)

call1 line 1 marker-UNIQUE-1-1 padding padding padding
call1 line 2 marker-UNIQUE-1-2 padding padding padding


Wall time: 0.18 seconds
region 1 line count: 500  (expected 500)

## 5. Recovery: resumed worker session, agent calls read artifact://5:raw:507-512
{"n":1,"tool":["read",{"path":"artifact://5:raw:507-512"}]}
{"n":2,"tool":null}
--- omp -p output:
Working...
done after tools: ### region 2 (bash, ~7328 tok)

call2 line 1 marker-UNIQUE-2-1 padding padding padding
call2 line 2 marker-UNIQUE-2-2 padding padding padding
call2 line 3 marker-UNIQUE-2-3 padding padding padding
call2 line 4 marker-UNIQUE-2-4 padding padding padding

[Showing lines 507-512 of 1012. Use :513 to con

## 6. Prose-heavy session (nothing for shake to trim) falls through to OMP's normal summary
{"methods":["shake","remote","handoff","snapcompact","soft"],"shouldCompact":true,"resolvedContextTokens":210493,"thresholdTokens":47616}
{"method":"handoff","summary":"## Goal\nMOCK-SUMMARY: generator runs.\n## Next Step"}
(eval):27: no matches found: /tmp/fmshake.UynZ/prose/home/.omp/agent/sessions/*/*/
shake artifacts written: 0

## 7. Captain config.yml untouched after all worker runs
before: 73a272cf813cd315815a29dca2d608a402262143
73a272cf813cd315815a29dca2d608a402262143  /tmp/fmshake.UynZ/overlay/home/.omp/agent/config.yml
73a272cf813cd315815a29dca2d608a402262143  /tmp/fmshake.UynZ/nooverlay/home/.omp/agent/config.yml
73a272cf813cd315815a29dca2d608a402262143  /tmp/fmshake.UynZ/prose/home/.omp/agent/config.yml

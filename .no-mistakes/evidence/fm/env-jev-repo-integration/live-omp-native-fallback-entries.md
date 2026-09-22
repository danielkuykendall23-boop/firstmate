# text-550k: what omp wrote after the hook declined before any request (real omp 18.2.8, fake endpoint hit 0 times)
# Session file: synthetic-text-550k.jsonl

## extension stderr lines captured by the driver
[fm-jev-compaction] falling back to native omp compaction: reduction 0% of the whole context below minimum even if Jev dropped every candidate call
[fm-jev-compaction] falling back to native omp compaction: reduction 0% of the whole context below minimum even if Jev dropped every candidate call

## extension_ui_request status frames omp emitted on the RPC stream
Jev compaction skipped (reduction 0% of the whole context below minimum even if Jev dropped every candidate call) - using native compaction
Jev compaction skipped (reduction 0% of the whole context below minimum even if Jev dropped every candidate call) - using native compaction

## compaction entries on disk (native method, not fromExtension)
{"type":"compaction","fromExtension":false,"method":"snapcompact","summaryChars":1115,"preserveDataKeys":["snapcompact"]}

## first 6 lines of the native summary
Resume prior conversation. Earlier turns archived under HISTORY below, oldest→newest. Read HISTORY fully; continue the live conversation following it.

Archived transcript scopes:
- `¶user:`, `¶think:`, `¶ai:`, `¶call:`: user, assistant reasoning, assistant reply, tool call.
- Unprefixed following lines: current scope. Consecutive same-kind blocks omit repeated prefix.
- Tool call: `¶call:name(args)//intent`; trailing `//intent` optional. `<out>…</out>`: tool output.

-----

# mixed-550k: what omp wrote after the hook declined before any request (real omp 18.2.8, fake endpoint hit 0 times)
# Session file: synthetic-mixed-550k.jsonl

## extension stderr lines captured by the driver
[fm-jev-compaction] falling back to native omp compaction: even if Jev dropped every candidate call, the carried summary and the verbatim text the library cannot prune are ~338986 tokens, over the 119084-token retained-context budget for a 272000-token model
[fm-jev-compaction] falling back to native omp compaction: even if Jev dropped every candidate call, the carried summary and the verbatim text the library cannot prune are ~338986 tokens, over the 119084-token retained-context budget for a 272000-token model

## extension_ui_request status frames omp emitted on the RPC stream
Jev compaction skipped (even if Jev dropped every candidate call, the carried summary and the verbatim text the library cannot prune are ~338986 tokens, over the 119084-token retained-context budget for a 272000-token model) - using native compaction
Jev compaction skipped (even if Jev dropped every candidate call, the carried summary and the verbatim text the library cannot prune are ~338986 tokens, over the 119084-token retained-context budget for a 272000-token model) - using native compaction

## compaction entries on disk (native method, not fromExtension)
{"type":"compaction","fromExtension":false,"method":"snapcompact","summaryChars":1115,"preserveDataKeys":["snapcompact"]}

## first 6 lines of the native summary
Resume prior conversation. Earlier turns archived under HISTORY below, oldest→newest. Read HISTORY fully; continue the live conversation following it.

Archived transcript scopes:
- `¶user:`, `¶think:`, `¶ai:`, `¶call:`: user, assistant reasoning, assistant reply, tool call.
- Unprefixed following lines: current scope. Consecutive same-kind blocks omit repeated prefix.
- Tool call: `¶call:name(args)//intent`; trailing `//intent` optional. `<out>…</out>`: tool output.

-----


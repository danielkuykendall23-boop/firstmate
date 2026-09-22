# The compaction entry omp wrote to the resumed session file after RPC 'compact' (tools-550k, real omp 18.2.8, fake System One endpoint).
# Session file: synthetic-tools-550k.jsonl  size: 2409502 bytes

## Entry fields (summary text elided here, shown below)
{
  "type": "compaction",
  "id": "eeda0ea1",
  "parentId": "0000014d",
  "fromExtension": true,
  "firstKeptEntryId": "00000142",
  "tokensBefore": 551190,
  "summaryChars": 23310,
  "preserveData": {
    "jevCompaction": {
      "model": "jev-latest",
      "keepThreshold": 0.5,
      "candidateCalls": 107,
      "kept": 0,
      "truncated": 0,
      "droppedCount": 106,
      "droppedSample": [
        "call-1",
        "call-2",
        "call-3",
        "call-4",
        "call-5"
      ],
      "requestCount": 1,
      "stateTokens": 12397,
      "charsBefore": 2149402,
      "charsAfter": 21952,
      "reductionRatio": 0.989786926782426,
      "previousSummaryChars": 0,
      "summaryTokens": 8454,
      "budget": {
        "contextWindow": 272000,
        "trigger": 231200,
        "progressCeiling": 184960,
        "reserve": 40800,
        "recentTokens": 23318,
        "systemPromptTokens": 5134,
        "budgetTokens": 115708
      }
    }
  }
}

## Installed summary text, first 60 lines (verbatim history omp now replays in place of the ~551k-token region)
user: Investigate the failing build across the repository. the important invariant the run must keep.

---

**Turn Context (split turn):**

assistant: [tool call bash] {"command":"ls -la dir0"}
toolResult: drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
drwxr-xr-x  2 dev dev 4096 Jan 1 00:00 dir0/file-0.ts
...
## Installed summary text, last 12 lines
assistant: Listing 94 noted.
assistant: Listing 95 noted.
assistant: Listing 96 noted.
assistant: Listing 97 noted.
assistant: Listing 98 noted.
assistant: Listing 99 noted.
assistant: Listing 100 noted.
assistant: Listing 101 noted.
assistant: Listing 102 noted.
assistant: Listing 103 noted.
assistant: Listing 104 noted.
assistant: Listing 105 noted.

## Line count of the installed summary: 485
## Occurrences of the excluded-bash secret marker in the installed summary: 0
## Occurrences of the kept invariant sentence: 1

---
name: process-reading-list
description: Submit the not-yet-processed entries of a reading-list JSON file to the reading-lite API and write the outcomes back into the file. Use after check-reading-list has marked which entries are processed, to ingest the rest into the corpus. Pairs with check-reading-list.
---

# process-reading-list

Takes a reading-list JSON file (ideally already annotated by
`check-reading-list`) and POSTs the entries that are **not** yet processed to
the reading-lite API, then records each outcome back into the file.

## What it does

1. Reads the JSON array of entries.
2. Selects entries with `processed !== true` and a usable `http(s)` URL.
   Entries already marked `submitted: true` are skipped (so re-runs resume),
   unless `--resubmit`.
3. POSTs each selected URL to `POST /api/readings` (serial, with transport retry),
   asking `Y/n/q` before each unless `--quick`.
4. Writes outcomes back into the file:
   - **200 / existing** (already in corpus) → `processed: true`, `reading_id`, `submitted_at`.
   - **202 / new** (accepted, queued) → `submitted: true`, `reading_id`, `submitted_at`. Stays `processed: false` until the queue finishes.
   - **failure** → `submit_error`.

`processed` only flips true on a confirmed corpus hit. After a batch of 202s
finishes processing on the server, re-run `check-reading-list` to promote those
entries to `processed: true`.

## Prerequisites

A reading-lite API bearer token: pass `--token`, set `READER_API_TOKEN`, or put
it in `.dev.vars`. (This skill talks to the HTTP API, not R2 — different auth
from `check-reading-list`.)

## Usage

```bash
# Preview which entries would be submitted (no POST, no write).
npm run ops -- reading-list process --file ~/Desktop/chrome-reading-list.json

# Interactive: prompts Y/n/q before each URL, writes back in place.
npm run ops -- reading-list process --file ~/Desktop/chrome-reading-list.json --execute

# Fire everything without prompting.
npm run ops -- reading-list process --file ~/Desktop/chrome-reading-list.json --execute --quick

# Submit to a local dev worker instead of production.
npm run ops -- reading-list process --file in.json --url http://127.0.0.1:8787/api/readings --execute
```

Flags: `--file` (required, rewritten in place), `--out` (write elsewhere),
`--url` (default `READER_URL` env, then `https://reading-lite.bbell.dev/api/readings`),
`--token`, `--resubmit`, `--execute` (submit and write back; omit it to plan),
`--quick`.

Prints a JSON summary to stdout (`selected`, `confirmed`, `queued`, `errors`,
`skipped`). Exits non-zero if any submission errored.

## Typical loop

```bash
npm run ops -- reading-list check --file list.json --execute   # mark processed true/false
npm run ops -- reading-list process --file list.json --execute # submit the false ones
# …wait for the queue to drain…
npm run ops -- reading-list check --file list.json --execute   # promote freshly-ready ones
```

## Implementation

- CLI: `scripts/ops-lib/commands/reading-list-process.ts` (via `scripts/ops.ts`)
- Selection (pure, tested): `scripts/process-reading-list-lib/select.ts`
- Write-back (pure, tested): `scripts/process-reading-list-lib/annotate.ts`
- Reuses `scripts/import-bookmarks-lib/submit.ts` (POST + retry + classification)
  and `confirm.ts` (the Y/n/q prompter).
- Tests: `test/unit/process-reading-list/` (node project in `vitest.workspace.ts`)

## Notes / gotchas

- The default endpoint is **production**, matching `check-reading-list`'s
  default production bucket. Use `--url` for a local worker, and make
  sure `--token` matches whichever environment you target.
- Submitting triggers paid summarization on the server. Plan first (omit `--execute`);
  the default per-URL prompt is the safety rail — `--quick` removes it.

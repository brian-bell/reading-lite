---
name: check-reading-list
description: Mark which entries of a reading-list JSON export are already in the reading-lite corpus. Reads index/list.json straight from the R2 bucket via wrangler and stamps each entry with "processed": true|false. Use when triaging a Chrome reading-list / bookmarks JSON export before importing, or to find what still needs submitting.
---

# check-reading-list

Annotate a reading-list JSON export against the live reading-lite corpus: each
entry gets `"processed": true` if its URL is already in the corpus, else
`"processed": false`.

## Input shape

A JSON **array** of entries, each with a `url` string (other keys are kept
as-is). This matches Chrome's reading-list export, e.g.:

```json
[
  { "status": "READ", "title": "…", "url": "https://example.com/post" },
  { "status": "UNREAD", "title": "…", "url": "https://other.com/x" }
]
```

## How membership is decided

- The corpus is read directly from R2: `wrangler r2 object get
  <bucket>/index/list.json --remote --pipe`. That file lists every reading with
  its `url` and `status`.
- An entry is `processed: true` only when its URL appears in `index/list.json`
  with status **`ready`** (successfully summarized). `pending`/`failed` count as
  not processed — they are still re-submittable. Override with `--status` /
  `--any-status`.
- Matching is **exact URL string** — the same key the worker hashes for its
  by-url dedup pointer, so this agrees with what a re-submit would classify.
  (A trailing `?utm_…` or `/` difference is a different URL.)

## Prerequisites

A Cloudflare session that can read R2: run `wrangler login`, or set
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) in the environment. No
reading-lite API token is needed — this path does not hit the HTTP API.

## Usage

```bash
# Default: production bucket, ready-only, rewrites the file in place.
npm run check-corpus -- --file ~/Desktop/chrome-reading-list.json

# Preview the counts without writing.
npm run check-corpus -- --file ~/Desktop/chrome-reading-list.json --dry-run

# Write to a new file instead of in place.
npm run check-corpus -- --file in.json --out annotated.json

# Count anything present in the corpus (pending/failed too).
npm run check-corpus -- --file in.json --any-status

# An alternate R2 bucket.
npm run check-corpus -- --file in.json --bucket some-other-bucket
```

Flags: `--file` (required), `--out` (default: in place), `--bucket` (default
`reading-lite`, or `READING_LITE_BUCKET` env), `--status <s>` (repeatable,
default `ready`), `--any-status`, `--local` (read miniflare cache), `--dry-run`.

The script prints a JSON summary to stdout:

```json
{
  "file": "…", "out": "…", "bucket": "reading-lite",
  "match_statuses": ["ready"], "corpus_urls": 1234,
  "total": 52, "processed": 30, "unprocessed": 22, "missingUrl": 0,
  "dry_run": false
}
```

## Implementation

- CLI: `scripts/check-corpus.ts`
- Corpus logic (pure, unit-tested): `scripts/check-corpus-lib/corpus.ts`
- Wrangler R2 read (injectable runner): `scripts/check-corpus-lib/fetch-index.ts`
- Tests: `test/unit/check-corpus/` (node project in `vitest.workspace.ts`)

## Notes / gotchas

- Use `--dry-run` first to sanity-check `corpus_urls` is non-zero — a zero there
  usually means wrong bucket or an unauthenticated wrangler session, not an
  empty corpus.
- `index/list.json` is the worker's maintained list index. If it were ever
  stale, membership would lag; in practice every terminal write updates it
  (see CLAUDE.md "Maintain `index/list.json` on every terminal write").

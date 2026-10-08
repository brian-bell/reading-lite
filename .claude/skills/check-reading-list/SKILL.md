---
name: check-reading-list
description: Mark which entries of a reading-list JSON export are already in the reading-lite corpus. Resolves each exported URL against the tenant's URL claims in PostgreSQL and stamps each entry with "processed": true|false. Use when triaging a Chrome reading-list / bookmarks JSON export before importing, or to find what still needs submitting.
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

- Only the exported URLs are looked up, not the whole corpus: each is hashed
  and resolved against the tenant's `reading_urls` claims, joined to the
  reading for its status.
- An entry is `processed: true` only when its URL is claimed by a reading whose
  status is **`ready`** (successfully summarized). `pending`/`failed` count as
  not processed — they are still re-submittable. Override with `--status` /
  `--any-status`.
- Matching is **exact URL string** — the same key the worker hashes when it
  claims a URL, so this agrees with what a re-submit would classify. (A
  trailing `?utm_…` or `/` difference is a different URL.)

## Prerequisites

- `--tenant <usr_…>`: whose corpus counts as "processed". Production's is
  `GET /api/whoami`'s `tenant_id`.
- A direct PostgreSQL connection string in the variable paired with the bucket
  (`PRODUCTION_DATABASE_URL` for `reading-lite`); operators source these from
  `~/.config/reading-lite/neon.env`. No reading-lite API token is needed — this
  path does not hit the HTTP API.

## Usage

```bash
# Default: production, ready-only, rewrites the file in place.
npm run ops -- reading-list check --tenant "$TENANT" \
  --file ~/Desktop/chrome-reading-list.json --execute

# Preview the counts without writing.
npm run ops -- reading-list check --tenant "$TENANT" \
  --file ~/Desktop/chrome-reading-list.json

# Write to a new file instead of in place.
npm run ops -- reading-list check --tenant "$TENANT" --file in.json --out annotated.json --execute

# Count anything present in the corpus (pending/failed too).
npm run ops -- reading-list check --tenant "$TENANT" --file in.json --any-status --execute
```

Flags: `--file` (required), `--tenant` (required), `--out` (default: in place),
`--bucket` (default `reading-lite`, or `READING_LITE_BUCKET` env, and it selects
the database), `--database-url-env <NAME>`, `--status <s>` (repeatable, default
`ready`), `--any-status`, `--local` (this checkout's database), `--execute`
(write the annotated file; omit it to plan).

The script prints a JSON summary to stdout:

```json
{
  "file": "…", "out": "…", "bucket": "reading-lite", "tenant": "usr_…",
  "match_statuses": ["ready"], "tenant_readings": 1234,
  "total": 52, "processed": 30, "unprocessed": 22, "missingUrl": 0,
  "executed": true
}
```

## Implementation

- CLI: `scripts/ops-lib/commands/reading-list-check.ts` (via `scripts/ops.ts`)
- Corpus logic (pure): `scripts/check-corpus-lib/corpus.ts`
- URL lookup: `PgReadingStore.ownersByUrls`, through
  `scripts/pg-lib/operator-corpus.ts`

## Notes / gotchas

- Plan first (omit `--execute`) to sanity-check `tenant_readings` is non-zero —
  that is the tenant's whole corpus size, so a zero means the wrong tenant or
  the wrong database. (`processed` counting zero is not the same signal: a fresh
  export legitimately overlaps nothing.)
- The URL claim and its reading commit together, so membership cannot lag the
  corpus the way a denormalized list index could.

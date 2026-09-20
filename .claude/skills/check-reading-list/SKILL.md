---
name: check-reading-list
description: Mark which entries of a reading-list JSON export are already in the reading-lite corpus. Queries the tenant's readings over a direct PostgreSQL connection and stamps each entry with "processed": true|false. Use when triaging a Chrome reading-list / bookmarks JSON export before importing, or to find what still needs submitting.
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

- The corpus is read with one query against the tenant's `readings`, which
  carries every reading's `url` and `status`.
- An entry is `processed: true` only when its URL appears in that tenant's
  corpus with status **`ready`** (successfully summarized). `pending`/`failed` count as
  not processed — they are still re-submittable. Override with `--status` /
  `--any-status`.
- Matching is **exact URL string** — the same URL the worker hashes for its
  per-tenant ownership row, so this agrees with what a re-submit would find.
  (A trailing `?utm_…` or `/` difference is a different URL.)

## Prerequisites

A direct PostgreSQL connection string. Source the laptop file and pass the
variable's name:

```bash
set -a; . ~/.config/reading-lite/neon.env; set +a
```

No Cloudflare session and no reading-lite API token: this path reaches neither
R2 nor the HTTP API.

## Usage

```bash
# Ready-only, rewrites the file in place. --tenant is required.
npm run ops -- reading-list check --file ~/Desktop/chrome-reading-list.json \
  --tenant "$TENANT" --database-url-env NEON_MAIN_DATABASE_URL --execute

# Preview the counts without writing.
npm run ops -- reading-list check --file ~/Desktop/chrome-reading-list.json \
  --tenant "$TENANT" --database-url-env NEON_MAIN_DATABASE_URL

# Write to a new file instead of in place.
npm run ops -- reading-list check --file in.json --out annotated.json \
  --tenant "$TENANT" --database-url-env NEON_MAIN_DATABASE_URL --execute

# Count anything present in the corpus (pending/failed too).
npm run ops -- reading-list check --file in.json --any-status \
  --tenant "$TENANT" --database-url-env NEON_MAIN_DATABASE_URL --execute

# A different database (the laptop file holds the Neon strings).
set -a; . ~/.config/reading-lite/neon.env; set +a
npm run ops -- reading-list check --file in.json --tenant "$TENANT" \
  --database-url-env NEON_REHEARSAL_DATABASE_URL --execute
```

Flags: `--file` (required), `--tenant` (**required** — a tenant id; `global`
is refused), `--database-url-env` (default `DATABASE_URL`), `--out` (default:
in place), `--status <s>` (repeatable, default `ready`), `--any-status`,
`--execute` (write the annotated file; omit it to plan).

`--tenant` is new: the old list index was one document per key root, but a
query has to be told whose corpus it is asking about. Getting it wrong is not
a quiet failure — an empty answer marks every entry unprocessed and
`reading-list process` resubmits the library.

The script prints a JSON summary to stdout:

```json
{
  "file": "…", "out": "…", "bucket": "reading-lite",
  "match_statuses": ["ready"], "corpus_urls": 1234,
  "total": 52, "processed": 30, "unprocessed": 22, "missingUrl": 0,
  "executed": true
}
```

## Implementation

- CLI: `scripts/ops-lib/commands/reading-list-check.ts` (via `scripts/ops.ts`)
- Corpus logic (pure, unit-tested): `scripts/check-corpus-lib/corpus.ts`
- Wrangler R2 read (injectable runner): `scripts/check-corpus-lib/fetch-index.ts`
- Tests: `test/unit/check-corpus/` (node project in `vitest.workspace.ts`)

## Notes / gotchas

- Plan first (omit `--execute`) to sanity-check `corpus_urls` is non-zero — a
  zero there usually means the wrong tenant or the wrong database, not an
  empty corpus.
- Membership cannot lag: the reading and its ownership row commit together, so
  the query sees exactly what a re-submit would.

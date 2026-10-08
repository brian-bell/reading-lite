---
name: corpus-drop
description: Remove one or more readings from the reading-lite corpus, identified by URL or by reading id. Resolves each selector against the tenant's readings in PostgreSQL, deletes the row (its URL claim, revisions, attempts, relationships and embedding cascade with it), and deletes the reading's captured content from R2. Non-ready only by default — a ready reading needs --allow-ready, which refuses the production bucket. Dry-run by default; writes only with --execute. Use whenever the user wants to drop, delete, or remove a specific reading, URL, dead link, junk, or duplicate failed copy from the corpus — including when they just paste a URL or rd_ id and say to get rid of it.
---

# corpus-drop

Drops readings from the reading-lite corpus, fully and consistently, given a URL
or a reading id. It is the generic "delete this from the corpus" tool: resolve
selectors → delete each reading's captured content from R2 → delete its row.

**Dry-run by default. It only writes with `--execute`.**

## What it does

For each target reading:

1. **Resolves its captured content** by asking the reading where its bytes are.
   That answer comes in three tiers: the current revision's keys; the latest
   capturing attempt's keys, for a reading that was never published; and the
   legacy spelling under the stored `key_prefix`, for an imported reading no
   attempt has touched. All three are deleted. (Deriving the keys from the
   revision alone silently strands the third tier's bytes — the rows go, R2
   keeps the objects, and nothing reports it.)
2. **Deletes the `readings` row.** `reading_urls` (the URL claim),
   `reading_revisions`, `reading_attempts`, `reading_relationships` and
   `reading_embeddings` all cascade from it, so there is nothing else to clean
   up and no separate Vectorize delete.

**Bytes first, row last.** If an object delete fails, the row is left in place,
so the reading stays visible to the next audit and the drop stays re-runnable.

## Selectors

A selector is either a **reading id** (`rd_…`) or a **URL**. Mix freely.
- A **URL** resolves to *every non-ready copy* of that URL in the tenant's
  corpus (a failed URL often has several duplicate attempts).
- A **reading id** resolves to that one reading.

## Non-ready only (the safety rule)

A `ready` reading is the live, searchable copy of its URL, so dropping one is
never routine:
- a `ready` id named explicitly is **refused** (hard error), and
- a URL with a ready copy **keeps** that copy and drops only its non-ready
  duplicates (the orphan-dup cleanup case).

`--allow-ready` opts into it for staging cleanup, and **refuses the production
bucket name**. There is no longer a `--vectorize` flag to pair with it: the
embedding is a row that cascades with the reading. To remove a ready reading
from production, use `corpus-sweep`, which only ever drops one alongside a
surviving keeper.

## Prerequisites

- `--tenant <usr_…>`. `--tenant global` is **refused** here: it names the
  pre-tenant R2 layout, which has no rows.
- A direct PostgreSQL connection string in the variable paired with the bucket
  (`PRODUCTION_DATABASE_URL` for `reading-lite`), from
  `~/.config/reading-lite/neon.env`.
- A Cloudflare session that can read **and write** R2, for the content deletes:
  `wrangler login`, or `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).

## Usage

```bash
# Dry run (default): see exactly what would be deleted.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC123

# Multiple selectors, mixing URLs and ids.
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC https://a.com/x https://b.com/y

# Apply.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link --execute

# Staging cleanup of a ready reading.
npm run ops -- corpus drop --tenant "$STG_TENANT" rd_ABC \
  --bucket reading-lite-staging --allow-ready --execute

# This checkout's local database and R2 cache.
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC --local --execute
```

`--tenant` is required on every corpus command, and here it must be a real
tenant id. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see
`docs/operations.md`); staging takes its founder tenant id.

Flags: `--bucket` (default `READING_LITE_BUCKET` env, then `reading-lite`; it
selects the database too), `--database-url-env <NAME>`, `--allow-ready`,
`--local`, `--execute`, `--help`.

## Always dry-run first

The default run prints every object and row it would delete and changes nothing.
Confirm the target set, then re-run with `--execute`.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-drop.ts` (via `scripts/ops.ts`)
- Pure resolver: `scripts/corpus-lib/drop.ts`
- Rows and content keys: `scripts/pg-lib/operator-corpus.ts`, over
  `PgReadingStore`
- R2 delete (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`

## Related
- **`corpus-audit`** — find what's broken first (it surfaces the ids/URLs).
- **`corpus-recover`** — try to *fix* recoverable readings instead of dropping.
- **`corpus-sweep`** — the tool for duplicates across URL spellings, and the
  only one that drops a ready reading on production.

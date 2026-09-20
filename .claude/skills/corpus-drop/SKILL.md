---
name: corpus-drop
description: Remove one or more readings from the reading-lite corpus, identified by URL or by reading id. Resolves each selector against the tenant's readings, deletes the content each one captured in R2, then deletes its row, which cascades URL ownership, revisions, relationships, attempts and the embedding. Non-ready only by default — refuses ready readings, which are live library entries. Dry-run by default; writes only with --execute. Use whenever the user wants to drop, delete, or remove a specific reading, URL, dead link, junk, or duplicate failed copy from the corpus — including when they just paste a URL or rd_ id and say to get rid of it.
---

# corpus-drop

Drops readings from the reading-lite corpus, fully and consistently, given a URL
or a reading id. It is the generic "delete this from the corpus" tool: resolve
selectors → delete each reading's captured content from R2 → delete its row.

**Dry-run by default. It only writes with `--execute`.**

## What it does

For each target reading it deletes every R2 key the reading's rows still
reference — each revision's and each attempt's raw and extracted content —
then deletes the row. Deleting the row cascades its URL ownership, revisions,
relationships, attempts and embedding, so there is no pointer to unlink, no
Vectorize index to keep in step and no list index to rewrite.

**Content first, row last.** The row is what makes a reading findable, so
deleting it first would strand the bytes with nothing left to name them. If an
object delete fails, that reading keeps its row and the drop stays
re-runnable; one reading's failure does not hold back another's.

## Selectors

A selector is either a **reading id** (`rd_…`) or a **URL**. Mix freely.
- A **URL** resolves to *every non-ready copy* of that URL in the tenant's
  corpus (a failed URL often has several duplicate attempts).
- A **reading id** resolves to that one reading.

## Non-ready only (the safety rule)

Nothing dangles any more — URL ownership, the embedding and the relationships
are rows that cascade with the reading. But a `ready` reading is a live library
entry with a published summary, and deleting one is not corpus repair. So:
- a `ready` id named explicitly is **refused** (hard error), and
- a URL with a ready copy **keeps** that copy and drops only its non-ready
  duplicates (the orphan-dup cleanup case).

Dropping those non-ready duplicates is safe: only one reading owns the URL, and
an orphan duplicate is not it, so the surviving ready copy's ownership row is
untouched. `--allow-ready` opts into dropping a ready reading (staging only —
it refuses the production bucket name); it no longer needs a `--vectorize`
index, because the embedding goes with its reading.

## Prerequisites

Two things: a direct PostgreSQL connection string, and a Cloudflare session
that can read **and write** R2 (`wrangler login`, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`).

The connection string comes from a named variable, never a flag, so it stays
out of shell history:

```sh
set -a; . ~/.config/reading-lite/neon.env; set +a
```

Then pass `--database-url-env NEON_MAIN_DATABASE_URL` (the default is
`DATABASE_URL`).

## Usage

```bash
# Dry run (default): see exactly what would be deleted.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC123

# Multiple selectors, mixing URLs and ids.
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC https://a.com/x https://b.com/y

# Apply.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link --execute

# The local corpus. --local refuses a database that is not on this machine,
# so it cannot delete production rows while deleting local objects.
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC --local --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is **refused**: it addressed the pre-tenant R2 key root, which has no PostgreSQL representation.

Flags: `--database-url-env` (default `DATABASE_URL`), `--bucket` (captured
content; default `READING_LITE_BUCKET` env, then `reading-lite`), `--local`
(local miniflare bucket, and a local database), `--allow-ready`, `--execute`,
`--help`.

## Always dry-run first

The default run prints every object and row it would delete and
changes nothing. Confirm the target set, then re-run with `--execute`.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-drop.ts` (via `scripts/ops.ts`)
- Pure resolver (tested): `scripts/corpus-lib/drop.ts`
- R2 read/delete/put (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/drop.test.ts` (node project)

## Related
- **`corpus-audit`** — find what's broken first (it surfaces the ids/URLs).
- **`corpus-recover`** — try to *fix* recoverable readings instead of dropping.
- **`corpus-delete-orphans`** — the original, audit-driven bulk variant
  (`--ids`/orphan-dup mode). `corpus-drop` is the ad-hoc URL-or-id front-end.

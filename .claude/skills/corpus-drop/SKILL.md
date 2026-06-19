---
name: corpus-drop
description: Remove one or more readings from the reading-lite corpus, identified by URL or by reading id. Resolves each selector against index/list.json, deletes every object under the reading's id-scoped prefix, and rewrites index/list.json. Non-ready only — refuses ready readings (which own a by-url pointer + embedding). Dry-run by default; writes only with --execute. Use to drop dead links, junk, or duplicate failed copies from the corpus.
---

# corpus-drop

Drops readings from the reading-lite corpus, fully and consistently, given a URL
or a reading id. It is the generic "delete this from the corpus" tool: resolve
selectors → delete each reading's R2 objects → rewrite `index/list.json` once.

**Dry-run by default. It only writes with `--execute`.**

## What it does

For each target reading it deletes, under that reading's own id-scoped prefix:
- `{prefix}/manifest.json` (durability anchor — list rebuilds key off this)
- `{prefix}/extracted.md`, `{prefix}/raw.{ext}` (best-effort across common exts)
- `{prefix}/attempts/{id}.json` (attempt ids read live from the manifest)
- `index/by-id/{id}` (so `GET /readings/:id` 404s instead of resolving)

Then it rewrites `index/list.json` once, dropping the targeted ids.

## Selectors

A selector is either a **reading id** (`rd_…`) or a **URL**. Mix freely.
- A **URL** resolves to *every non-ready copy* of that URL in `index/list.json`
  (a failed URL often has several duplicate attempts).
- A **reading id** resolves to that one reading.

## Non-ready only (the safety rule)

A `ready` reading owns its `index/by-url/{hash}` pointer **and** a Vectorize
embedding; deleting it here would dangle both. So:
- a `ready` id named explicitly is **refused** (hard error), and
- a URL with a ready copy **keeps** that copy and drops only its non-ready
  duplicates (the orphan-dup cleanup case).

To remove a `ready` reading you'd also need to delete its by-url pointer and
Vectorize vector — out of scope here on purpose.

## Prerequisites

A Cloudflare session that can read **and write** R2: `wrangler login`, or
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).

Run it when nothing is being submitted: the `index/list.json` rewrite is a plain
put, not a CAS write, so a concurrent queue write could be lost.

## Usage

```bash
# Dry run (default): see exactly what would be deleted.
npm run corpus-drop -- https://example.com/dead-link
npm run corpus-drop -- rd_ABC123

# Multiple selectors, mixing URLs and ids.
npm run corpus-drop -- rd_ABC https://a.com/x https://b.com/y

# Apply.
npm run corpus-drop -- https://example.com/dead-link --execute

# Alternate bucket / local miniflare cache.
npm run corpus-drop -- rd_ABC --bucket some-other-bucket --execute
npm run corpus-drop -- rd_ABC --local --execute
```

Flags: `--bucket` (default `READING_LITE_BUCKET` env, then `reading-lite`),
`--local` (local miniflare bucket instead of `--remote`), `--execute`, `--help`.

## Always dry-run first

The default run prints every object it would delete and the `list.json` diff and
changes nothing. Confirm the target set, then re-run with `--execute`.

## Implementation
- CLI: `scripts/corpus-drop.ts`
- Pure resolver (tested): `scripts/corpus-lib/drop.ts`
- R2 read/delete/put (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/drop.test.ts` (node project)

## Related
- **`corpus-audit`** — find what's broken first (it surfaces the ids/URLs).
- **`corpus-recover`** — try to *fix* recoverable readings instead of dropping.
- **`corpus-delete-orphans`** — the original, audit-driven bulk variant
  (`--ids`/orphan-dup mode). `corpus-drop` is the ad-hoc URL-or-id front-end.

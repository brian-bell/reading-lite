---
name: corpus-drop
description: Remove one or more readings from the reading-lite corpus, identified by URL or by reading id. Resolves each selector against index/list.json, deletes every object under the reading's id-scoped prefix (including the by-url ownership pointer when the dropped reading actually owns it), and rewrites index/list.json. Non-ready only — refuses ready readings (which own a Vectorize embedding). Dry-run by default; writes only with --execute. Use whenever the user wants to drop, delete, or remove a specific reading, URL, dead link, junk, or duplicate failed copy from the corpus — including when they just paste a URL or rd_ id and say to get rid of it.
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
- `index/by-id/{id}` (so `GET /api/readings/:id` 404s instead of resolving)
- `index/by-url/{hash}` — **only when the stored pointer is owned by this
  reading**. by-url pointers are eager URL ownership claims, so a failed/pending
  reading may own its pointer; but an orphan-duplicate's URL hashes to the same
  slot as the surviving ready copy, whose pointer must be left intact. The tool
  reads the pointer object and deletes it only if `pointer.id` matches the
  dropped reading.

Then it rewrites `index/list.json` once, dropping the targeted ids.

## Selectors

A selector is either a **reading id** (`rd_…`) or a **URL**. Mix freely.
- A **URL** resolves to *every non-ready copy* of that URL in `index/list.json`
  (a failed URL often has several duplicate attempts).
- A **reading id** resolves to that one reading.

## Non-ready only (the safety rule)

A `ready` reading owns a Vectorize embedding (and, as the live owner of its URL,
its `index/by-url/{hash}` pointer); dropping it here would dangle the embedding.
So:
- a `ready` id named explicitly is **refused** (hard error), and
- a URL with a ready copy **keeps** that copy and drops only its non-ready
  duplicates (the orphan-dup cleanup case).

Dropping those non-ready duplicates is safe: by-url pointers are eager ownership
claims, so the deletion plan removes `index/by-url/{hash}` only when the dropped
reading genuinely owns it — never the surviving ready copy's pointer. To remove a
`ready` reading you'd still also need to delete its Vectorize vector — out of
scope here on purpose.

## Prerequisites

A Cloudflare session that can read **and write** R2: `wrangler login`, or
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).

Run it when nothing is being submitted: the `index/list.json` rewrite is a plain
put, not a CAS write, so a concurrent queue write could be lost.

## Usage

```bash
# Dry run (default): see exactly what would be deleted.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC123

# Multiple selectors, mixing URLs and ids.
npm run ops -- corpus drop --tenant "$TENANT" rd_ABC https://a.com/x https://b.com/y

# Apply.
npm run ops -- corpus drop --tenant "$TENANT" https://example.com/dead-link --execute

# Alternate bucket / local miniflare cache (gate-off: --tenant global).
npm run ops -- corpus drop --tenant global rd_ABC --bucket some-other-bucket --execute
npm run ops -- corpus drop --tenant global rd_ABC --local --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is the pre-tenant layout: local, staging (gate still off), migrate-founder source, and leftover production global objects. A `usr_…` id addresses that tenant's `u/{tenantId}/` namespace.
Flags: `--bucket` (default `READING_LITE_BUCKET` env, then `reading-lite`),
`--local` (local miniflare bucket instead of `--remote`), `--execute`, `--help`.

## Always dry-run first

The default run prints every object it would delete and the `list.json` diff and
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

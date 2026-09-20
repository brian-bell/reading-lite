---
name: corpus-audit
description: Read-only health audit of the reading-lite corpus. Inventories every reading that is not "ready" (failed + pending), categorizes each failure by reason, splits both failed and pending into real failures vs orphan-duplicates (a url that already has a ready copy — droppable cruft), and optionally flags paywall-teaser readings and ready YouTube enrichment misses. Writes index.json + INDEX.md. Use to see what is broken in the corpus and why, before recovering. Safe to run anytime — never writes to the corpus.
---

# corpus-audit

Produces a complete inventory of every reading in the reading-lite corpus that
is **not** `ready`, with a categorized reason for each. Read-only: it queries
the tenant's readings over a direct PostgreSQL connection (and, with
`--teasers`, reads their captured content from R2). It never mutates the
corpus.

## Output

Writes two files to `--out` (default: cwd):
- **`index.json`** — structured rows (the input `corpus-recover` consumes).
- **`INDEX.md`** — human-readable tables, grouped:
  - **Failed** — deduped by URL, with a derived reason (HTTP 403/404/429/5xx, paywalls, dead links, oversized, summarize failures, etc.). Real failures only: a failed URL that *also* has a `ready` copy is moved to the next group instead.
  - **Failed — orphan dup** — failed copies of a URL that *already* has a `ready` reading (earlier attempts left behind after a later success, or a re-submit that lost a fetch race). Not real failures — cosmetic cruft. The `ready` copy owns the URL, so these are safe to remove with `corpus drop <url>` (which keeps the ready copy). `× N` is the failed-copy count per URL.
  - **Pending — stranded** — never completed and older than the pending TTL, no `ready` copy (reprocess candidates).
  - **Pending — orphan dup** — the URL already has a `ready` reading (cosmetic index cruft).
  - **Pending — in-flight** — within the pending TTL; likely still processing, no action.
  - **Ready-but-teaser** — only with `--teasers`.
  - **Ready — enrichment degraded** — only with `--degraded`. Ready YouTube readings that recorded a swallowed watch-page or transcript miss.

It also prints a JSON summary (totals + counts) to stdout.

## Prerequisites

A direct PostgreSQL connection string: source `~/.config/reading-lite/neon.env`
and pass `--database-url-env`. No reading-API token needed.

A Cloudflare session (`wrangler login`, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID`) is needed only for `--teasers`, which reads captured
content from R2. The inventory itself is database-only.

## Usage

```bash
# Plan first (reads + classifies, prints counts and paths, writes nothing).
npm run ops -- corpus audit --tenant "$TENANT"

# Fast inventory (one query) into the current directory.
npm run ops -- corpus audit --tenant "$TENANT" --execute

# Write somewhere specific.
npm run ops -- corpus audit --tenant "$TENANT" --out ~/Desktop/reading-lite-extracted --execute

# Also scan ready pragmaticengineer/substack readings for paywall teasers
# (reads each one's content — slower).
npm run ops -- corpus audit --tenant "$TENANT" --teasers --execute

# Also list ready YouTube readings that recorded an enrichment miss
# (no extra reads).
npm run ops -- corpus audit --tenant "$TENANT" --degraded --execute

# Resolve the true stuck stage of stranded pending from attempt files (slower).
npm run ops -- corpus audit --tenant "$TENANT" --deep --execute

# A different database (the laptop file holds the Neon strings).
set -a; . ~/.config/reading-lite/neon.env; set +a
npm run ops -- corpus audit --tenant "$TENANT" --database-url-env NEON_REHEARSAL_DATABASE_URL --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is **refused**: it addressed the pre-tenant R2 key root, which has no PostgreSQL representation.

The connection string comes from a named variable, never a flag, so it stays out of shell history: source `~/.config/reading-lite/neon.env` and pass `--database-url-env` (default `DATABASE_URL`).

Flags: `--database-url-env` (default `DATABASE_URL`), `--out` (dir, default cwd), `--teasers`, `--degraded`, `--deep`, `--bucket` (captured content, read only by `--teasers`), `--local`, `--execute` (write the report files; without it the command plans), `--help`.

## How categories are decided
- **Failed reason** comes from the manifest error code + the HTTP status embedded in `BadStatusError` messages, with a few hand-verified per-URL overrides (PDF, YouTube, confirmed dead links). Reddit URLs are flagged as needing the `.json` endpoint.
- **Orphan dup (failed or pending)**: any non-ready reading whose URL *also* has a `ready` reading. The content is already in the corpus, so it can't be recovered — `corpus-recover` maps it to `none`, and the fix is `corpus-drop`. This applies symmetrically to failed and pending readings.
- **Stranded vs orphan-dup vs in-flight** (pending): a pending URL that *also* has a `ready` reading is an orphan duplicate; one within the pending TTL (900s, mirroring `PENDING_TTL_SECONDS`; measured from `updated_at` when present) is in-flight (`fresh`); only an older pending with no `ready` copy is genuinely stranded.
- **Teaser** (`--teasers` only): a `ready` pragmaticengineer/substack reading whose extracted content is short (< ~2.5 KB) or short-ish with a paywall-cutoff marker. Subscribe *footers* on full articles are deliberately not enough.
- **Enrichment degraded** (`--degraded` only): a `ready` reading whose list row carries `enrichment_degradation` (today, a YouTube oEmbed-floor miss). `corpus-recover` maps these to `skip` — upgrade with the `youtube-import` skill, do not reprocess.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-audit.ts` (via `scripts/ops.ts`)
- Pure logic (tested): `scripts/corpus-lib/{reason,classify,policy,audit,render}.ts`
- R2 reads (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/` (node project)

## Next step
Feed the resulting `index.json` to **`corpus-recover`** to act on it (reprocess / re-extract). That step writes and costs money; this one doesn't. For the **orphan dup** groups (failed or pending), there's nothing to recover — clean them with **`corpus-drop`** instead (it keeps the ready copy).

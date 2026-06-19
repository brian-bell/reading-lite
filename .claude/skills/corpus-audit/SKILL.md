---
name: corpus-audit
description: Read-only health audit of the reading-lite corpus. Inventories every reading that is not "ready" (failed + pending), categorizes each failure by reason, splits pending into stranded vs orphan-duplicate, and optionally flags paywall-teaser readings. Writes index.json + INDEX.md. Use to see what is broken in the corpus and why, before recovering. Safe to run anytime — never writes to the corpus.
---

# corpus-audit

Produces a complete inventory of every reading in the reading-lite corpus that
is **not** `ready`, with a categorized reason for each. Read-only: it reads
`index/list.json` (and, with flags, content/attempt files) from R2 via
`wrangler`. It never mutates the corpus.

## Output

Writes two files to `--out` (default: cwd):
- **`index.json`** — structured rows (the input `corpus-recover` consumes).
- **`INDEX.md`** — human-readable tables, grouped:
  - **Failed** — deduped by URL, with a derived reason (HTTP 403/404/429/5xx, paywalls, dead links, oversized, summarize failures, etc.). A failed URL that *also* has a `ready` copy (e.g. drained by a prior local-extract) is excluded.
  - **Pending — stranded** — never completed and older than the pending TTL, no `ready` copy (reprocess candidates).
  - **Pending — orphan dup** — the URL already has a `ready` reading (cosmetic index cruft).
  - **Pending — in-flight** — within the pending TTL; likely still processing, no action.
  - **Ready-but-teaser** — only with `--teasers`.

It also prints a JSON summary (totals + counts) to stdout.

## Prerequisites

A Cloudflare session that can read R2: `wrangler login`, or `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`). No reading-API token needed.

## Usage

```bash
# Fast inventory (one list.json read) into the current directory.
npm run corpus-audit

# Write somewhere specific.
npm run corpus-audit -- --out ~/Desktop/reading-lite-extracted

# Also scan ready pragmaticengineer/substack readings for paywall teasers
# (reads each one's content — slower).
npm run corpus-audit -- --teasers

# Resolve the true stuck stage of stranded pending from attempt files (slower).
npm run corpus-audit -- --deep

# An alternate R2 bucket, or the local miniflare cache.
npm run corpus-audit -- --bucket some-other-bucket
npm run corpus-audit -- --local
```

Flags: `--bucket` (default `READING_LITE_BUCKET` env, then `reading-lite`), `--out` (dir, default cwd), `--teasers`, `--deep`, `--local`, `--help`.

## How categories are decided
- **Failed reason** comes from the manifest error code + the HTTP status embedded in `BadStatusError` messages, with a few hand-verified per-URL overrides (PDF, YouTube, confirmed dead links). Reddit URLs are flagged as needing the `.json` endpoint.
- **Stranded vs orphan-dup vs in-flight**: a pending URL that *also* has a `ready` reading is an orphan duplicate; one within the pending TTL (900s, mirroring `PENDING_TTL_SECONDS`; measured from `updated_at` when present) is in-flight (`fresh`); only an older pending with no `ready` copy is genuinely stranded.
- **Teaser** (`--teasers` only): a `ready` pragmaticengineer/substack reading whose extracted content is short (< ~2.5 KB) or short-ish with a paywall-cutoff marker. Subscribe *footers* on full articles are deliberately not enough.

## Implementation
- CLI: `scripts/corpus-audit.ts`
- Pure logic (tested): `scripts/corpus-lib/{reason,classify,policy,audit,render}.ts`
- R2 reads (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/` (node project)

## Next step
Feed the resulting `index.json` to **`corpus-recover`** to act on it (reprocess / re-extract). That step writes and costs money; this one doesn't.

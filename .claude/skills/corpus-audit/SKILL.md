---
name: corpus-audit
description: Read-only health audit of the reading-lite corpus. Inventories every reading that is not "ready" (failed + pending), categorizes each failure by reason, splits both failed and pending into real failures vs orphan-duplicates (a url that already has a ready copy — droppable cruft), and optionally flags paywall-teaser readings. Writes index.json + INDEX.md. Use to see what is broken in the corpus and why, before recovering. Safe to run anytime — never writes to the corpus.
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
  - **Failed** — deduped by URL, with a derived reason (HTTP 403/404/429/5xx, paywalls, dead links, oversized, summarize failures, etc.). Real failures only: a failed URL that *also* has a `ready` copy is moved to the next group instead.
  - **Failed — orphan dup** — failed copies of a URL that *already* has a `ready` reading (earlier attempts left behind after a later success, or a re-submit that lost a fetch race). Not real failures — cosmetic cruft. The `ready` copy owns the by-url pointer + embedding, so these are safe to remove with `corpus-drop <url>` (which keeps the ready copy). `× N` is the failed-copy count per URL.
  - **Pending — stranded** — never completed and older than the pending TTL, no `ready` copy (reprocess candidates).
  - **Pending — orphan dup** — the URL already has a `ready` reading (cosmetic index cruft).
  - **Pending — in-flight** — within the pending TTL; likely still processing, no action.
  - **Ready-but-teaser** — only with `--teasers`.

It also prints a JSON summary (totals + counts) to stdout.

## Prerequisites

A Cloudflare session that can read R2: `wrangler login`, or `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`). No reading-API token needed.

## Usage

```bash
# Plan first (reads + classifies, prints counts and paths, writes nothing).
npm run ops -- corpus audit --tenant "$TENANT"

# Fast inventory (one list.json read) into the current directory.
npm run ops -- corpus audit --tenant "$TENANT" --execute

# Write somewhere specific.
npm run ops -- corpus audit --tenant "$TENANT" --out ~/Desktop/reading-lite-extracted --execute

# Also scan ready pragmaticengineer/substack readings for paywall teasers
# (reads each one's content — slower).
npm run ops -- corpus audit --tenant "$TENANT" --teasers --execute

# Resolve the true stuck stage of stranded pending from attempt files (slower).
npm run ops -- corpus audit --tenant "$TENANT" --deep --execute

# An alternate R2 bucket, or the local miniflare cache (gate-off: --tenant global).
npm run ops -- corpus audit --tenant global --bucket some-other-bucket --execute
npm run ops -- corpus audit --tenant global --local --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is the pre-tenant layout: local only, migrate-founder source, and the leftover global objects production and staging both retain. Staging pins the gate too, so staging corpus commands take its founder tenant id, not `global`. A `usr_…` id addresses that tenant's `u/{tenantId}/` namespace.
Flags: `--bucket` (default `READING_LITE_BUCKET` env, then `reading-lite`), `--out` (dir, default cwd), `--teasers`, `--deep`, `--local`, `--execute` (write the report files; without it the command plans), `--help`.

## How categories are decided
- **Failed reason** comes from the manifest error code + the HTTP status embedded in `BadStatusError` messages, with a few hand-verified per-URL overrides (PDF, YouTube, confirmed dead links). Reddit URLs are flagged as needing the `.json` endpoint.
- **Orphan dup (failed or pending)**: any non-ready reading whose URL *also* has a `ready` reading. The content is already in the corpus, so it can't be recovered — `corpus-recover` maps it to `none`, and the fix is `corpus-drop`. This applies symmetrically to failed and pending readings.
- **Stranded vs orphan-dup vs in-flight** (pending): a pending URL that *also* has a `ready` reading is an orphan duplicate; one within the pending TTL (900s, mirroring `PENDING_TTL_SECONDS`; measured from `updated_at` when present) is in-flight (`fresh`); only an older pending with no `ready` copy is genuinely stranded.
- **Teaser** (`--teasers` only): a `ready` pragmaticengineer/substack reading whose extracted content is short (< ~2.5 KB) or short-ish with a paywall-cutoff marker. Subscribe *footers* on full articles are deliberately not enough.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-audit.ts` (via `scripts/ops.ts`)
- Pure logic (tested): `scripts/corpus-lib/{reason,classify,policy,audit,render}.ts`
- R2 reads (injectable runner): `scripts/corpus-lib/wrangler-r2.ts`
- Tests: `test/unit/corpus/` (node project)

## Next step
Feed the resulting `index.json` to **`corpus-recover`** to act on it (reprocess / re-extract). That step writes and costs money; this one doesn't. For the **orphan dup** groups (failed or pending), there's nothing to recover — clean them with **`corpus-drop`** instead (it keeps the ready copy).

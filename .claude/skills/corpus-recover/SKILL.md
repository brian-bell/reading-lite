---
name: corpus-recover
description: Act on a corpus-audit index.json to fix non-ready readings — reprocess recoverable ones via the reading API, and re-extract fetch-blocked ones locally (browser UA) then re-import as markdown. Applies a per-reason policy table, prints a plan, and only acts with --execute. Use after corpus-audit. This writes to the corpus and triggers paid summarization/embedding — always dry-run and confirm first.
---

# corpus-recover

Consumes the `index.json` produced by **`corpus-audit`** and applies the right
recovery per failure reason. It **writes to the corpus and triggers paid work**
(Claude summaries + OpenAI embeddings), so it is **dry-run by default** and only
acts with `--execute`.

## Workflow (always)

1. Run `corpus-audit` first to produce a fresh `index.json`.
2. Run `corpus-recover` **without `--execute`** to print the plan.
3. **Show the plan to the user and get confirmation** (it spends money / mutates prod).
4. Run with `--execute` (optionally `--monitor`).
5. Re-run `corpus-audit` to verify.

## Policy table (in-skill)

Each audit row maps to one action:

| Audit category / reason | Action |
|---|---|
| Pending **stranded**; `BadToolInputError` (summarize); `FetchTimeoutError`; HTTP 5xx origin errors | **reprocess** — `POST /readings/:id/reprocess {force:true}` |
| Fetch-blocked **HTTP 403 / 429**; **oversized** (article) | **local-extract** — fetch locally (browser UA), re-import via `POST /readings/import-markdown` |
| Dead links (404/410); paywalls (401/402/451); not-articles (PDF/YouTube); teasers | **skip** — recorded, no action |
| **Reddit** (`reddit.com` / `redd.it`) | **skip** — can't fetch from a script (bot-challenge); import with the **`reddit-import`** skill (drives a logged-in Chrome session) |
| **Orphan-dup** (failed *or* pending) | **none** — cosmetic; the URL already has a ready reading. Drop with `corpus-drop`, don't recover |
| Pending **fresh** (within the pending TTL) | **none** — likely still in-flight; don't duplicate active work |

The mapping lives in `scripts/corpus-lib/policy.ts` (`recoveryAction`).

`--limit <n>` caps **total** writes across the whole batch (reprocess + local-extract combined), not per-action.

## Bulk path: `--batch` (Anthropic Message Batch API)

For a backlog (backfills, recovering dozens–thousands), `--batch` summarizes
through the **Anthropic Message Batches API** instead of the realtime queue:
**~50% cheaper**, no per-minute rate-limit burst, nothing to strand. Use it for
non-latency-sensitive backfills; the realtime queue (and `--wave`) stays the
right tool for interactive single-URL submits.

What it does, end to end (`scripts/corpus-lib/batch/`):
1. **prepare** — resolve each `reprocess` + `local-extract` row from its existing
   manifest (created_at, url_hash, content fields, ready-snapshot).
2. **extract** — reuse R2 `extracted.md` only for a currently **ready+captured**
   reading (its content descriptors are trustworthy); otherwise re-extract
   locally (browser UA). A failed manifest has zeroed content fields, so reusing
   it would corrupt the rebuilt manifest — re-extracting also matches realtime
   reprocess (url readings re-fetch). The batch can't fetch URLs itself.
3. **similar** — embed the source (OpenAI array endpoint, realtime) + query
   Vectorize for top-K, exactly like the realtime path, to ground
   `novelty_verdict`/`connections`.
4. **submit** — one request per reading (`custom_id` = reading id, `params` =
   the *same* `emit_reading` body as realtime, so the prompt cache is shared),
   write fresh content objects to R2, persist a resume sidecar.
5. **poll → write** — poll to completion, then write manifests / pointers /
   vectors / `index/list.json` via the **same terminal-write contract** as the
   worker. A success writes the `index/by-url/{hash}` pointer; a failure writes a
   retryable failed manifest with **no** by-url pointer, so a failed batch URL
   stays re-submittable as an unclaimed URL (the batch path does not eagerly
   claim the by-url slot the way the realtime `POST /readings` path does).

```bash
# Dry-run the batch plan (no writes, no spend).
npm run corpus-recover -- --index .../index.json --batch

# Execute the batch (submit → poll → write). Embeddings stay realtime.
npm run corpus-recover -- --index .../index.json --batch --execute
```

- **Resume:** the in-flight batch is recorded in `<index>.batch.json`. If a poll
  is interrupted, re-running `--batch --execute` **resumes that batch** (polls +
  writes) instead of re-submitting — so the summarize step is never double-billed.
  The sidecar is deleted once results are written.
- **`--wave` is ignored** in `--batch` mode (there's no realtime queue to pace).
- **Embeddings are realtime** (cheap/fast), coalesced via OpenAI's array input.
- **Caveat:** a batch can take minutes–hours (24h max). While it runs, a
  `corpus-audit` may label the readings "stranded" if they outlive
  `PENDING_TTL_SECONDS` — benign; the sidecar is the source of truth and the
  terminal writes land on completion.
- **Credentials:** needs R2 (S3) + Vectorize creds from `.corpus.vars`
  (`CORPUS_*`) plus `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `ANTHROPIC_MODEL` from `.dev.vars`/`.prd.vars`.

## Prerequisites

- A reading-API bearer token (for writes): `--token`, `READER_API_TOKEN`, or `.prd.vars`/`.dev.vars`.
- For `--monitor`: a Cloudflare session to read `index/list.json` (wrangler login).

## Usage

```bash
# 1. Plan only (no writes) — review before doing anything.
npm run corpus-recover -- --index ~/Desktop/reading-lite-extracted/index.json

# 2. Execute everything in the plan, then watch the queue drain.
npm run corpus-recover -- --index .../index.json --execute --monitor

# Restrict to one action, or cap the batch.
npm run corpus-recover -- --index .../index.json --only reprocess --execute
npm run corpus-recover -- --index .../index.json --only local-extract --limit 5 --execute

# Point at a local worker.
npm run corpus-recover -- --index .../index.json --url http://127.0.0.1:8787 --execute
```

Flags: `--index` (default `./index.json`), `--execute`, `--only reprocess|local-extract`, `--limit <n>`, `--url`, `--token`, `--bucket` (for `--monitor`), `--monitor`, `--batch` (bulk Message Batch path), `--help`.

Outcomes are written back into the `index.json` rows (`result` field). Prints a JSON summary; exits non-zero if any action errored.

## Notes / gotchas
- **Reprocess won't fix a 403** (same worker egress) — that's why 403/429 route to local-extract instead. Conversely local-extract can't fix a dead link or hard paywall — those are `skip`.
- A `local-extract` whose local fetch also fails (paywall/404 from your IP too) is recorded as failed in the index; no reading is created.
- Reprocessed/imported readings still go through the serial queue — use `--monitor`, or re-run `corpus-audit` after a few minutes, to confirm they reached `ready`.

## Implementation
- CLI: `scripts/corpus-recover.ts`
- Policy (tested): `scripts/corpus-lib/policy.ts`; API client: `scripts/corpus-lib/api.ts`
- Reuses the worker's `extractFromUrl` (`src/modules/extractor`) for local extraction.
- Bulk path: `scripts/corpus-lib/batch/` (clients, prepare/extract/similar/submit/poll/write phases, `run` orchestrator, `sidecar`); shared CF clients in `scripts/lib/cf-clients.ts`; batch config in `scripts/corpus-lib/config.ts` (`resolveBatchConfig`).
- Tests: `test/unit/corpus/policy.test.ts`, `test/unit/corpus/batch/**`, `test/unit/lib/cf-clients.test.ts` (node project)

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
2. Run `ops corpus recover` **without `--execute`** to print the plan.
3. **Show the plan to the user and get confirmation** (it spends money / mutates prod).
4. Run with `--execute` (optionally `--monitor`).
5. Re-run `corpus-audit` to verify.

## Policy table (in-skill)

Each audit row maps to one action:

| Audit category / reason | Action |
|---|---|
| Pending **stranded**; `BadToolInputError` (summarize); `FetchTimeoutError`; HTTP 5xx origin errors; **`DestinationResolutionError`** on the originating submit/import (or a missing `last_attempt.trigger`) | **reprocess** — `POST /api/readings/:id/reprocess {force:true}` |
| Fetch-blocked **HTTP 403 / 429**; **oversized** (article) | **local-extract** — fetch locally (browser UA), re-import via `POST /api/readings/import-markdown` |
| **`DestinationResolutionError`** after a recover (`last_attempt.trigger` is `reprocess`) | **skip** — originating attempt + one recover already used; resolver cannot tell a dead name from a blip |
| Dead links (404/410); paywalls (401/402/451); not-articles (PDF); teasers; **enrichment-degraded** YouTube (`--degraded` audit rows) | **skip** — recorded, no action. YouTube floor misses: recover with the **`youtube-import`** skill |
| **`SourceRejectedError` / `OpenAISourceRejectedError`** | **skip** — the summarizer refused a thin extraction; reprocess would resubmit the same source. YouTube: recover with the **`youtube-import`** skill |
| **Reddit** (`reddit.com` / `redd.it`) | **skip** — can't fetch from a script (bot-challenge); import with the **`reddit-import`** skill (drives a logged-in Chrome session) |
| **Orphan-dup** (failed *or* pending) | **none** — cosmetic; the URL already has a ready reading. Drop with `corpus-drop`, don't recover |
| Pending **fresh** (within the pending TTL) | **none** — likely still in-flight; don't duplicate active work |

The mapping lives in `scripts/corpus-lib/policy.ts` (`recoveryAction`).

`--limit <n>` caps **total** writes across the whole batch (reprocess + local-extract combined), not per-action.

## Bulk path: `--batch` (provider Batch APIs)

For a backlog (backfills, recovering dozens–thousands), `--batch` summarizes
through the configured **OpenAI or Anthropic Batch API** instead of the realtime queue:
**~50% cheaper**, no per-minute rate-limit burst, nothing to strand. Use it for
non-latency-sensitive backfills; the realtime queue (and `--wave`) stays the
right tool for interactive single-URL submits.

What it does, end to end (`scripts/corpus-lib/batch/`):
1. **prepare/extract** — read tenant-scoped PostgreSQL readings and resolve their
   captured content keys. Reuse captured ready content or extract locally.
2. **similar** — embed source text and query exact per-tenant pgvector similarity.
3. **activate/submit** — admit the batch's maximum spend, persist the activating
   sidecar, write new content under immutable attempt keys in R2, and commit
   URL ownership and the offline attempt before provider submission. Offline
   attempts do not create realtime queue jobs.
4. **poll/write** — settle provider results and atomically publish each reading's
   revision, content keys, relationships and embedding in PostgreSQL. A failed
   recovery retains the previous publication. An interrupted write resumes the
   same batch and skips already committed attempts.

R2 stores captured bytes only. Source the direct PostgreSQL connection variable
paired with the bucket (for example `NEON_MAIN_DATABASE_URL` for `reading-lite`);
`--database-url-env` selects an accepted variable explicitly. Batch operations
require a tenant id and refuse the retained `global` layout. Keep realtime writers
paused and drained for the entire offline batch and pass `--sole-writer` on resume too.

```bash
# Dry-run the batch plan (no writes, no spend).
npm run ops -- corpus recover --tenant "$TENANT" --index .../index.json --batch

# Execute the batch (submit → poll → write). Embeddings stay realtime.
npm run ops -- corpus recover --tenant "$TENANT" --index .../index.json --batch --execute --sole-writer
```

- **Resume:** the in-flight batch is recorded in `<index>.batch.json`. If a poll
  is interrupted, re-running `--batch --execute --sole-writer` **resumes that batch** (polls +
  writes) instead of re-submitting — so the summarize step is never double-billed.
  The sidecar is deleted once results are written.
- **`--wave` is ignored** in `--batch` mode (there's no realtime queue to pace).
- **Embeddings are realtime** (cheap/fast), coalesced via OpenAI's array input.
- **Caveat:** a batch can take minutes–hours (24h max). While it runs, a
  `corpus-audit` may label the readings "stranded" if they outlive
  `PENDING_TTL_SECONDS` — benign; the sidecar is the source of truth and the
  terminal writes land on completion.
- **Credentials:** needs the R2 (S3) keys from `.corpus.vars`
  (`CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`, `CORPUS_R2_SECRET_KEY`),
  the bucket-paired direct PostgreSQL variable from
  `~/.config/reading-lite/neon.env`, and `OPENAI_API_KEY` (plus
  `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` for an Anthropic batch) from
  `.dev.vars`/`.prd.vars`. No Vectorize credential is needed.

## Prerequisites

- A reading-API bearer token (for writes): `--token`, `READER_API_TOKEN`, or `.prd.vars`/`.dev.vars`.
- For `--monitor`: a direct PostgreSQL connection string in the variable paired
  with the bucket (`PRODUCTION_DATABASE_URL` for `reading-lite`), from
  `~/.config/reading-lite/neon.env`. The poll SELECTs the tenant's readings;
  `--bucket` selects the database and `--database-url-env <NAME>` overrides the
  variable. `--tenant global` is refused on that path — it names the pre-tenant
  R2 layout, which has no rows.

## Usage

```bash
# 1. Plan only (no writes) — review before doing anything.
npm run ops -- corpus recover --tenant "$TENANT" --index ~/Desktop/reading-lite-extracted/index.json

# 2. Execute everything in the plan, then watch the queue drain.
npm run ops -- corpus recover --tenant "$TENANT" --index .../index.json --execute --monitor

# Restrict to one action, or cap the batch.
npm run ops -- corpus recover --tenant "$TENANT" --index .../index.json --only reprocess --execute
npm run ops -- corpus recover --tenant "$TENANT" --index .../index.json --only local-extract --limit 5 --execute

# Point at a local worker (TENANT_DATA_PLANE unset: --tenant global).
npm run ops -- corpus recover --tenant global --index .../index.json --url http://127.0.0.1:8787 --execute
```

`--tenant` is required on every corpus command. Production uses `--tenant "$TENANT"` from `GET /api/whoami` (see `docs/operations.md`). `--tenant global` is the pre-tenant layout: local only and the leftover global objects production and staging both retain. Staging pins the gate too, so live staging corpus commands take its founder tenant id, not `global`. A `usr_…` id addresses that tenant's `u/{tenantId}/` namespace.
Flags: `--index` (default `./index.json`), `--execute`, `--only reprocess|local-extract`, `--limit <n>`, `--url`, `--token`, `--bucket` (for `--monitor`), `--monitor`, `--batch` (bulk Message Batch path), `--help`.

Outcomes are written back into the `index.json` rows (`result` field). Prints a JSON summary; exits non-zero if any action errored.

## Notes / gotchas
- **Reprocess won't fix a 403** (same worker egress) — that's why 403/429 route to local-extract instead. Conversely local-extract can't fix a dead link or hard paywall — those are `skip`.
- A `local-extract` whose local fetch also fails (paywall/404 from your IP too) is recorded as failed in the index; no reading is created.
- Reprocessed/imported readings still go through the serial queue — use `--monitor`, or re-run `corpus-audit` after a few minutes, to confirm they reached `ready`.

## Implementation
- CLI: `scripts/ops-lib/commands/corpus-recover.ts` (via `scripts/ops.ts`)
- Policy: `scripts/corpus-lib/policy.ts`; API client: `scripts/corpus-lib/api.ts`
- Reuses the worker's `extractFromUrl` (`src/modules/extractor`) for local extraction.
- Bulk path: `scripts/corpus-lib/batch/` (clients, prepare/extract/similar/submit/poll/write phases, `run` orchestrator, `sidecar`); shared CF clients in `scripts/lib/cf-clients.ts`; batch config in `scripts/corpus-lib/config.ts` (`resolveBatchConfig`).
- Tests: `test/unit/operator-guards.test.ts` pins the batch's spend → sidecar → create order and its refusal to create again over an ambiguous sidecar

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
| Fetch-blocked **HTTP 403 / 429**; **oversized** (article) | **local-extract** — fetch locally with a browser UA, re-import via `POST /readings/import-markdown` |
| Dead links (404/410); paywalls (401/402/451); not-articles (PDF/YouTube); Reddit; teasers | **skip** — recorded, no action |
| Pending **orphan-dup** | **none** — cosmetic; the URL already has a ready reading |

The mapping lives in `scripts/corpus-lib/policy.ts` (`recoveryAction`).

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

# Point at a local/staging worker.
npm run corpus-recover -- --index .../index.json --url http://127.0.0.1:8787 --execute
```

Flags: `--index` (default `./index.json`), `--execute`, `--only reprocess|local-extract`, `--limit <n>`, `--url`, `--token`, `--bucket` (for `--monitor`), `--monitor`, `--help`.

Outcomes are written back into the `index.json` rows (`result` field). Prints a JSON summary; exits non-zero if any action errored.

## Notes / gotchas
- **Reprocess won't fix a 403** (same worker egress) — that's why 403/429 route to local-extract instead. Conversely local-extract can't fix a dead link or hard paywall — those are `skip`.
- A `local-extract` whose local fetch also fails (paywall/404 from your IP too) is recorded as failed in the index; no reading is created.
- Reprocessed/imported readings still go through the serial queue — use `--monitor`, or re-run `corpus-audit` after a few minutes, to confirm they reached `ready`.

## Implementation
- CLI: `scripts/corpus-recover.ts`
- Policy (tested): `scripts/corpus-lib/policy.ts`; API client: `scripts/corpus-lib/api.ts`
- Reuses the worker's `extractFromUrl` (`src/modules/extractor`) for local extraction.
- Tests: `test/unit/corpus/policy.test.ts` (node project)

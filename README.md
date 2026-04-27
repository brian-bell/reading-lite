# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → Claude summarizes it once via forced tool use → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the embedding → poll for the result.

Replaces a heavier Docker + SQLite + agent-orchestrator pipeline with a single Worker plus two managed services.

- Full PRD: [`plans/001-prd-reading-lite.md`](plans/001-prd-reading-lite.md)
- Original design memo: [`plans/000-re-design.md`](plans/000-re-design.md)
- Tracking issue: [#1](https://github.com/brian-bell/reading-lite/issues/1)

## Status

Greenfield. Production-shaped TypeScript, fully unit-tested (105 tests across 11 files), but not yet deployed to a real Cloudflare account. The verification steps in the PRD are still pending.

## Architecture at a glance

```
POST /readings { url }
  ├─ dedup via index/by-url/{sha256(url)} → existing manifest? return 200
  └─ else: write a "pending" manifest, return 202, enter ctx.waitUntil():
        fetch URL (timeout + size cap)
      → linkedom + readability + turndown → markdown
      → OpenAI text-embedding-3-small over the extracted text
      → Vectorize.query(top-K) for similar context
      → Anthropic messages.create with forced tool use (`emit_reading`)
      → OpenAI embed the final TL;DR
      → Vectorize.upsert(id, tldr_embedding, metadata)
      → R2 write final manifest + by-url pointer
      (on any error → write status="failed" manifest; skip by-url pointer)
```

The Worker is composed of four deeply-isolated modules (each unit-tested with stubbed `fetch` / bindings):

| Module | Responsibility |
|---|---|
| `extractor` | fetch source URL, sniff content type, HTML→Markdown via linkedom + readability + turndown |
| `embeddings` | OpenAI `text-embedding-3-small` (1536-dim) |
| `anthropic` | one-shot `messages.create` with `tool_choice: {type: "tool", name: "emit_reading"}`; system + tool def cached via `cache_control` |
| `stores` | `ReadingStore` over R2 (manifest, raw, extracted, by-url + by-id pointers) and `SimilarityStore` over Vectorize |

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # wrangler dev with R2 + Vectorize bindings
npm test                         # vitest workspace (workers pool + node pool)
npm run typecheck
```

You'll need staging R2 + Vectorize resources before `wrangler dev` works:

```sh
npx wrangler login
npx wrangler r2 bucket create reading-lite-staging
npx wrangler vectorize create reading-lite-staging --dimensions=1536 --metric=cosine
```

The default `wrangler.toml` config (no `--env` flag) targets `reading-lite-staging` for both R2 and Vectorize. Vectorize has no local emulator, so the binding is marked `remote = true` and goes against the real staging index even under `wrangler dev`. Production resources live under `[env.production]` and are reached via `wrangler deploy --env production`.

### Required secrets (production)

Set via `wrangler secret put` against the deployed Worker:

| Secret | What |
|---|---|
| `READER_API_TOKEN` | Bearer token required on every protected route |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key (text-embedding-3-small) |

Vars in `wrangler.toml` (non-secret, can be edited per-environment):

| Var | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `PENDING_TTL_SECONDS` | `300` | A `pending` manifest older than this is surfaced as `failed` with `error.code = "stale_pending"` on read. |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap (10 MiB) on source response size. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model passed to `messages.create`. |

## API

All routes except `/health` require `Authorization: Bearer $READER_API_TOKEN`.

| Method + path | Behavior |
|---|---|
| `GET /health` | 200 `ok`. No auth. |
| `POST /readings` | Body `{ url }`. Returns 202 `{ id, status: "pending", poll }` for new URLs; 200 with the existing manifest for already-ingested URLs. Background work fills the manifest. |
| `GET /readings` | Newest-first list. Query: `cursor`, `limit` (1–100, default 20). |
| `GET /readings/:id` | Returns the manifest (status `pending` / `ready` / `failed`). |
| `GET /readings/:id/content` | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /readings/:id/content/raw` | Streams the raw bytes with the original `content_type`. |
| `GET /readings/lookup?url=` | 200 `{ id }` for known URLs, 404 otherwise. |
| `POST /readings/similar` | Body `{ query_embedding: number[1536], k?: number }`. Top-K via Vectorize. |

The full manifest schema lives in `src/schemas/manifest.ts`. Notable fields: `status`, `error?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`, `novelty_verdict?` (`novel` | `familiar` | `duplicate`), `connections?`, `summary_markdown?`, `content_type`, `content_status`, `content_bytes`, `extracted_bytes?`, `content_sha256`, `usage?` (anthropic + openai token counts).

## Migration from Backlite

A one-shot script backfills the new R2 bucket + Vectorize index from a Backlite SQLite snapshot + content directory. Read-only against Backlite; idempotent against the target.

```sh
npm run migrate -- \
  --sqlite ./backlite.db \
  --content-dir ./backlite-data \
  --r2-account-id $CF_ACCOUNT_ID \
  --r2-access-key $R2_ACCESS_KEY_ID \
  --r2-secret-key $R2_SECRET_ACCESS_KEY \
  --r2-bucket reading-lite-staging \
  --cf-api-token $CF_API_TOKEN \
  --vectorize-account-id $CF_ACCOUNT_ID \
  --vectorize-index reading-lite-staging
```

Add `--dry-run` to print the planned R2 + Vectorize operations without hitting any remote API. Every flag also accepts an env var (`MIGRATE_<UPPER_SNAKE_CASE>`).

The `--cf-api-token` needs Vectorize Edit permission. R2 keys come from the R2 dashboard's "Manage R2 API Tokens".

The migration writes a CSV report (`id,status,error`) to stdout — capture it for verification:

```sh
npm run migrate -- ... > migration-report.csv 2> migration.log
```

> **Embedding dimension is locked to 1536.** Migrating reuses the existing OpenAI `text-embedding-3-small` vectors; switching to a 768-dim model later requires a re-embed and a fresh index.

## Repo layout

```
src/
  index.ts                      # worker entry (fetch handler) + Env types
  router.ts                     # Hono app: routes, dispatches to processReading
  middleware.ts                 # bearer auth + CORS allowlist
  process-reading.ts            # ctx.waitUntil() orchestration
  services.ts                   # Services interface (DI for fetch / now / id)
  schemas/                      # zod: manifest, tool input, API request/response
  modules/
    extractor/                  # HTML→Markdown pipeline + bounded fetch
    embeddings/                 # OpenAI client
    anthropic/                  # forced tool use + prompt caching
    stores/
      reading-store.ts          # R2: manifest, raw, extracted, by-url + by-id
      similarity-store.ts       # Vectorize: upsert + query
scripts/
  migrate.ts                    # CLI entry (better-sqlite3 + aws4fetch)
  migrate-lib/{plan,run,clients}.ts
test/
  integration/                  # Hono router via Miniflare (R2 + stub Vectorize)
  unit/{schemas,extractor,embeddings,anthropic,stores}/  # workers pool
  unit/migrate/                 # node pool (fs / os / path)
wrangler.toml                   # production config (R2 + Vectorize bindings)
wrangler.test.toml              # test config (R2 only; Vectorize is stub-injected)
vitest.workspace.ts             # two projects: "workers" + "node"
```

## Tests

`npm test` runs all 105 tests across two Vitest projects:

- **workers** — schemas, deep modules, R2 store, integration tests against the Hono router using `cloudflare:test`'s `env` (Miniflare-backed R2). Vectorize is not natively emulated by Miniflare, so each test that needs it injects a stub binding directly into `env.READINGS_INDEX`.
- **node** — migration script tests use `node:fs`/`os`/`path` and a real temp dir for fixture files.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. Manual verification against a staging deployment is part of the PRD's verification plan.

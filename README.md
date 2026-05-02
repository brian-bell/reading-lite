# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → Claude summarizes it once via forced tool use → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the embedding → poll for the result.

Replaces a heavier Docker + SQLite + agent-orchestrator pipeline with a single Worker plus two managed services.

- Full PRD: [`plans/001-prd-reading-lite.md`](plans/001-prd-reading-lite.md)
- Original design memo: [`plans/000-re-design.md`](plans/000-re-design.md)
- Tracking issue: [#1](https://github.com/brian-bell/reading-lite/issues/1)

## Status

Greenfield. Production-shaped TypeScript, fully unit-tested (271 root tests across 21 files plus 22 SPA tests), but not yet deployed to a real Cloudflare account. The verification steps in the PRD are still pending.

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

Each background run also writes a staged attempt record under
`readings/.../attempts/{attempt_id}.json`. Attempts capture the trigger
(`submit` or `reprocess`), current/final stage, timings, and sanitized error
details so failed readings can be inspected without relying only on `wrangler
tail`.

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

`wrangler dev` (top-level `wrangler.toml`) targets the `reading-lite-staging` bucket + index for local testing only — never deployed. Both bindings are marked `remote = true`, so dev runs your code locally against the real staging bucket and Vectorize index. Production resources (`reading-lite` bucket + index, served at `reading-lite.bbell.dev`) live under `[env.production]`; deploys always go there via `npm run deploy -- --execute` (dry-run by default).

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
| `GET /readings` | Newest-first list. Query: `q` (substring across title/tldr/url, case-insensitive), `tag` (exact, case-insensitive), `offset` (default 0), `limit` (1–100, default 20). Response: `{ readings, limit, offset, has_more }`. |
| `GET /readings/:id` | Returns the manifest (status `pending` / `ready` / `failed`). |
| `GET /readings/:id/diagnostics` | Returns the manifest, pointer health, list-index item, R2 object inventory, and recent processing attempts. |
| `POST /readings/:id/reprocess` | Starts a fresh processing attempt for the existing reading id. Failed readings move through `pending`; ready readings keep their current ready manifest if the new attempt fails. Optional body `{ "force": true }` bypasses an active-attempt conflict. |
| `GET /readings/:id/content` | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /readings/:id/content/raw` | Streams the raw bytes with the original `content_type`. |
| `GET /readings/lookup?url=` | 200 `{ id }` for known URLs, 404 otherwise. |
| `POST /readings/similar` | Body `{ query_embedding: number[1536], k?: number }`. Top-K via Vectorize. |

List filtering is server-side against a denormalized `index/list.json` in R2 that is maintained on every `POST /readings` (pending) and every terminal write in `processReading` (ready/failed). When the index is missing (e.g. cold cache after migration), the list endpoint falls back to scan-and-rebuild.

The full manifest schema lives in `src/schemas/manifest.ts`. Notable fields: `status`, `error?`, `active_attempt?`, `last_attempt?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`, `novelty_verdict?` (`novel` | `familiar` | `duplicate`), `connections?`, `summary_markdown?`, `content_type`, `content_status`, `content_bytes`, `extracted_bytes?`, `content_sha256`, `usage?` (anthropic + openai token counts).

### Troubleshooting and reprocessing

Use `GET /readings/:id/diagnostics` when a reading is failed or stuck. The
response shows whether by-id/by-url pointers line up, whether expected R2
objects exist, and which processing stage failed (`fetch_source`,
`embed_source`, `summarize`, `upsert_vector`, `write_indexes`, etc.).

Use `POST /readings/:id/reprocess` to retry the exact reading id. For a failed
reading, the manifest becomes `pending` while the new attempt runs. For a ready
reading, the current ready manifest remains the fallback; if the reprocess
attempt succeeds it replaces the manifest and vector, and if it fails the ready
manifest is preserved with `last_attempt.status = "failed"`.

## Web SPA

A small React SPA lives in `web/` and points at the Worker via Vite's dev proxy. It renders the list (with search + tag chips), submission form, detail page (TL;DR, summary markdown, entities, connections, content links), and persists the bearer token in `localStorage`.

```sh
# In one terminal — Worker:
npm run dev                            # wrangler dev on http://127.0.0.1:8787

# In another terminal — SPA:
cd web && npm install && npm run dev   # vite dev on http://127.0.0.1:5173
```

The SPA proxies `/readings` and `/health` to the Worker so requests are same-origin in development. In production the SPA is served from Cloudflare Pages on the same custom domain as the Worker (`reading-lite.bbell.dev`), with Worker routes scoped to `/readings*` and `/health` so Pages handles every other path. Deploy with `npm run deploy:web -- --execute` (dry-run by default).

The SPA carries its own hand-typed `web/src/types.ts` mirroring `src/schemas/manifest.ts` — keep them in sync if the Worker schema changes.

## Migration from Backlite

A one-shot script backfills the new R2 bucket + Vectorize index from a Backlite SQLite snapshot + content directory. Read-only against Backlite; idempotent against the target.

```sh
npm run migrate -- \
  --sqlite ./backlite.db \
  --content-dir ./backlite-data \
  --r2-account-id $CF_ACCOUNT_ID \
  --r2-access-key $R2_ACCESS_KEY_ID \
  --r2-secret-key $R2_SECRET_ACCESS_KEY \
  --r2-bucket reading-lite \
  --cf-api-token $CF_API_TOKEN \
  --vectorize-account-id $CF_ACCOUNT_ID \
  --vectorize-index reading-lite
```

Add `--dry-run` to print the planned R2 + Vectorize operations without hitting any remote API. Every flag also accepts an env var (`MIGRATE_<UPPER_SNAKE_CASE>`) or a value under the same name in a gitignored `.migrate.vars` file at the repo root. Resolution order: `--flag` > env var > `.migrate.vars`.

```sh
cp .migrate.vars.example .migrate.vars   # fill in keys + bucket/index
npm run migrate -- --dry-run             # no flags, no exports needed
```

The `--cf-api-token` needs Vectorize Edit permission. R2 keys come from the R2 dashboard's "Manage R2 API Tokens".

The migration writes a CSV report (`id,status,error`) to stdout — capture it for verification:

```sh
npm run migrate -- ... > migration-report.csv 2> migration.log
```

> **Embedding dimension is locked to 1536.** Migrating reuses the existing OpenAI `text-embedding-3-small` vectors; switching to a 768-dim model later requires a re-embed and a fresh index.

## Importing Chrome bookmarks

A node-side script ingests URLs from a Chrome bookmark export. By default it asks `Y/n/q` before each URL (Enter or `y` to submit, `n` to skip, `q` to abort). Re-runs are no-ops thanks to a local `.import-bookmarks-index.json` (per destination URL).

```sh
# default: "Computing" (top-level, i.e. under "Other Bookmarks") — interactive,
# posts to http://127.0.0.1:8787/readings
npm run import-bookmarks -- --file ~/Downloads/bookmarks.html

# fire everything without prompts (still serial — one POST at a time)
npm run import-bookmarks -- --file ~/Downloads/bookmarks.html --quick

# nested folder against prod
npm run import-bookmarks -- \
  --file ~/Downloads/bookmarks.html \
  --folder "Computing/AI/MCP" \
  --url https://reading-lite.bbell.dev/readings
```

`--url` takes the **full** readings endpoint to POST to (default: `http://127.0.0.1:8787/readings`, or `READER_URL` env). `--dry-run` prints the would-submit list without prompting or POSTing. `--quick` skips the per-URL prompt; submission is always serial (one POST at a time) so the local index can't race with itself. Token resolution mirrors `npm run read`: `--token` > `READER_API_TOKEN` env > `.dev.vars`. Transport-level fetch failures are retried twice (250ms / 500ms backoff); errors and statuses are surfaced with their underlying cause (e.g. `fetch failed / ECONNREFUSED ...`). Errors are NOT recorded in the index, so the next run retries them; `new`/`existing` responses are recorded immediately, so an interrupted run picks up where it left off. The worker also dedupes on its side via the by-url pointer, so deleting the local index is safe — it just means re-POSTing every URL once to rebuild it.

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
  import-bookmarks.ts           # CLI entry: parse Chrome export, POST /readings
  import-bookmarks-lib/{parse,select,submit,index-store,confirm}.ts
test/
  integration/                  # Hono router via Miniflare (R2 + stub Vectorize)
  unit/{schemas,extractor,embeddings,anthropic,stores}/  # workers pool
  unit/migrate/                 # node pool (fs / os / path)
  unit/import-bookmarks/        # node pool
web/                            # React SPA (separate npm project)
  src/{App.tsx, api.ts, types.ts, styles.css, main.tsx, test/setup.ts}
  index.html, package.json, tsconfig.json, vite.config.ts
wrangler.toml                   # production config (R2 + Vectorize bindings)
wrangler.test.toml              # test config (R2 only; Vectorize is stub-injected)
vitest.workspace.ts             # two projects: "workers" + "node"
```

## Tests

`npm test` (from the repo root) runs all root tests across two Vitest projects:

- **workers** — schemas, deep modules, R2 store, integration tests against the Hono router using `cloudflare:test`'s `env` (Miniflare-backed R2). Vectorize is not natively emulated by Miniflare, so each test that needs it injects a stub binding directly into `env.READINGS_INDEX`.
- **node** — migration script tests use `node:fs`/`os`/`path` and a real temp dir for fixture files.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. Manual smoke against staging bindings (`wrangler dev`) and the deployed Worker (`reading-lite.bbell.dev`) is part of the PRD's verification plan.

`cd web && npm test` runs the SPA tests (jsdom + window.fetch stubs).

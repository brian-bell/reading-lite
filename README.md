# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → Claude summarizes it once via forced tool use → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the embedding → poll for the result.

Replaces a heavier Docker + SQLite + agent-orchestrator pipeline with a single Worker plus managed Cloudflare services (R2, Vectorize, Queues) and a Pages-hosted SPA.

- Full PRD: [`plans/001-prd-reading-lite.md`](plans/001-prd-reading-lite.md)
- Original design memo: [`plans/000-re-design.md`](plans/000-re-design.md)
- Tracking issue: [#1](https://github.com/brian-bell/reading-lite/issues/1)

## Status

Deployed and in personal use at [`reading-lite.bbell.dev`](https://reading-lite.bbell.dev) (Worker + Cloudflare Pages SPA). Production-shaped TypeScript, fully unit-tested (418 root tests across 43 files plus 22 SPA tests).

## Architecture at a glance

```
POST /readings { url }
  ├─ dedup via index/by-url/{sha256(url)} → existing manifest? return 200
  └─ else: write a "pending" manifest, enqueue a job on the READING_JOBS
           queue, return 202. Poll GET /readings/:id until ready/failed.

READING_JOBS consumer (max_concurrency = 3) runs processReading per message:
        fetch URL (timeout + size cap)
      → linkedom + readability + turndown → markdown
      → OpenAI text-embedding-3-small over the extracted text
      → Vectorize.query(top-K) for similar context
      → Anthropic messages.create with forced tool use (`emit_reading`)
      → OpenAI embed the final TL;DR
      → Vectorize.upsert(id, tldr_embedding, metadata)
      → R2 write final manifest + by-url pointer
      (on any error → write status="failed" manifest; skip by-url pointer)
      (upstream 429 → RateLimitedError → msg.retry({delaySeconds}); the
       manifest stays pending until a later delivery completes. A message
       that exhausts max_retries routes to the reading-lite-dlq queue,
       where markDeadLettered flips the strand to a retryable "failed")
```

Each background run also writes a staged attempt record under
`readings/.../attempts/{attempt_id}.json`. Attempts capture the trigger
(`submit` or `reprocess`), current/final stage, timings, and sanitized error
details so failed readings can be inspected without relying only on `wrangler
tail`.

The Worker is composed of six deeply-isolated modules (each unit-tested with stubbed `fetch` / bindings):

| Module | Responsibility |
|---|---|
| `extractor` | fetch source URL, sniff content type, HTML→Markdown via linkedom + readability + turndown |
| `embeddings` | OpenAI `text-embedding-3-small` (1536-dim) |
| `anthropic` | one-shot `messages.create` with `tool_choice: {type: "tool", name: "emit_reading"}`; system + tool def cached via `cache_control` |
| `stores` | `ReadingStore` over R2 (manifest, raw, extracted, by-url + by-id pointers) and `SimilarityStore` over Vectorize |
| `http-retry` | `fetchWithRetry`: 5xx + network retry with exponential backoff + jitter; 429 → `RateLimitedError` so the queue reschedules instead of burning a slot |
| `email` | per-reading notification via Resend |

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # wrangler dev with R2 + Vectorize bindings
npm test                         # vitest workspace (workers pool + node pool)
npm run typecheck
```

`wrangler dev` (top-level `wrangler.toml`, worker name `reading-lite-dev`) runs your code locally against a Miniflare-emulated R2 bucket — initially empty, never the deployed one — so no remote resources are needed or touched. The distinct dev name also guards against an accidental bare `wrangler deploy` clobbering prod. Production resources (`reading-lite` bucket + Vectorize index, served at `reading-lite.bbell.dev`) live under `[env.production]`; deploys always go there via `npm run deploy -- --execute` (dry-run by default).

> **`wrangler dev` has no Vectorize binding and no Queue binding by design.** Search returns no results locally (Vectorize has no local emulator, and a remote binding would point dev at production data), and `POST /readings` / `/readings/:id/reprocess` return 503 without `READING_JOBS`. Read-only list/detail routes work against whatever you write to the local bucket. Most submission/search behavior is covered by the integration tests instead (`installQueueStub()` + `drainQueue()`), which don't need real bindings.

### Required secrets (production)

Set via `wrangler secret put` against the deployed Worker:

| Secret | What |
|---|---|
| `READER_API_TOKEN` | Bearer token required on every protected route |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key (text-embedding-3-small) |
| `RESEND_API_KEY` | Resend API key for per-reading email notifications. **`POST /readings` requests notifications by default** (`email: true`), so without this — and the `EMAIL_*` / `WEB_BASE_URL` vars below — every submission still produces a `ready` manifest but logs a failed `send_email` event. Leave unset to skip email; the reading itself is unaffected. |

Vars in `wrangler.toml` (non-secret, can be edited per-environment):

| Var | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `PENDING_TTL_SECONDS` | `900` | A `pending` manifest whose active attempt is older than this is treated as stale (surfaced as `failed` on read; a new attempt may supersede it). |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap (10 MiB) on source response size. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model passed to `messages.create`. |
| `EMAIL_FROM` | `""` | Sender for notification emails (a verified Resend domain). Empty disables email. |
| `EMAIL_TO` | `""` | Recipient for notification emails. |
| `WEB_BASE_URL` | `""` | Base URL used to build the "view reading" link in notification emails. |

## API

All routes except `/health` require `Authorization: Bearer $READER_API_TOKEN`.

| Method + path | Behavior |
|---|---|
| `GET /health` | 200 `ok`. No auth. |
| `POST /readings` | Body `{ url }`. Returns 202 `{ id, status: "pending", poll }` for new URLs; 200 with the existing manifest for already-ingested URLs. Background work fills the manifest. |
| `POST /readings/import-markdown` | Body `{ source_url, markdown, title?, email? }`. Uses `source_url` for identity/dedupe, but skips source fetching and processes the supplied Markdown as the captured article. Defaults `email` to false. |
| `GET /readings` | Newest-first list. Query: `q` (substring across title/tldr/url, case-insensitive), `tag` (exact, case-insensitive), `offset` (default 0), `limit` (1–100, default 20). Response: `{ readings, limit, offset, has_more }`. |
| `GET /readings/:id` | Returns the manifest (status `pending` / `ready` / `failed`). |
| `GET /readings/:id/diagnostics` | Returns the manifest, pointer health, list-index item, R2 object inventory, and recent processing attempts. |
| `POST /readings/:id/reprocess` | Starts a fresh processing attempt for the existing reading id. Failed readings move through `pending`; ready readings keep their current ready manifest if the new attempt fails. Optional body `{ "force": true }` bypasses an active-attempt conflict. |
| `GET /readings/:id/content` | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /readings/:id/content/raw` | Streams the raw bytes with the original `content_type`. |
| `GET /readings/lookup?url=` | 200 `{ id }` for known URLs, 404 otherwise. |
| `POST /readings/similar` | Body `{ query_embedding: number[1536], k?: number }`. Top-K via Vectorize. |

List filtering is server-side against a denormalized `index/list.json` in R2 that is maintained on every `POST /readings` (pending) and every terminal write in `processReading` (ready/failed). When the index is missing (e.g. a freshly provisioned bucket), the list endpoint falls back to scan-and-rebuild.

The full manifest schema lives in `src/schemas/manifest.ts`. Notable fields: `status`, `source_type?` (`url` | `markdown`), `error?`, `active_attempt?`, `last_attempt?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`, `novelty_verdict?` (`novel` | `familiar` | `duplicate`), `connections?`, `summary_markdown?`, `content_type`, `content_status`, `content_bytes`, `extracted_bytes?`, `content_sha256`, `usage?` (anthropic + openai token counts).

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

Two local scripts support bulk retry work. First gather failed attempts into
gitignored local files:

```sh
npm run gather:failed -- --base https://reading-lite.bbell.dev
```

This writes one JSON record per failed attempt plus `index.json` under
`.failed-attempts/<timestamp>/`. Failed manifests that predate attempt history
are captured as legacy records. Each record includes the reading, failed
attempt, and a retry decision. Then reprocess a single retryable failed reading
from a record file or directory:

```sh
# dry run: prints whether the selected reading would be retried/skipped
npm run reprocess:failed -- --input .failed-attempts/20260502T183000Z --reading rd_abc

# enqueue the selected retryable reading
npm run reprocess:failed -- --input .failed-attempts/20260502T183000Z --reading rd_abc --execute
```

Retryability is conservative: explicit `retryable` from the Worker wins; legacy
`FetchTimeoutError`, OpenAI/Anthropic failures, stale pending/active attempts,
and source HTTP 5xx are retried; source HTTP 4xx such as 404, blocked hosts,
oversized responses, and unknown errors are skipped unless
`--include-non-retryable` is passed.

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

## Importing local Markdown

Local `.md` files can be imported without re-fetching their source URLs. Each
file must include a source line:

```md
**Source:** https://example.com/article
```

The importer uses that URL as the canonical reading URL and sends the Markdown
body to `POST /readings/import-markdown`. Duplicate files with the same source
URL are collapsed before submit; the largest Markdown file wins. Imported
readings store the Markdown as both raw content and `extracted.md`, then reuse
the normal embedding, similarity, Claude summary, Vectorize, manifest, and list
index pipeline.

```sh
# preview the plan; no token required
npm run import-markdown -- --dir ~/Documents/articles --dry-run

# submit to local dev
npm run import-markdown -- --dir ~/Documents/articles

# submit to production
npm run import-markdown -- \
  --dir ~/Documents/articles \
  --url https://reading-lite.bbell.dev/readings/import-markdown
```

`--url` is the full import endpoint. Token resolution mirrors the other
scripts: `--token` > `READER_API_TOKEN` env > `.dev.vars`. Successful
new/existing responses are recorded in `.import-markdown-index.json`, scoped by
destination URL, so interrupted runs resume cleanly. Files larger than the
Cloudflare Queues 128 KB message limit are blocked before any POST; successful
new/existing responses move every file for that source URL into a `processed/`
subdirectory under the import directory. Emails are off by default; pass
`--email` to request email notifications for imported readings.

## Repo layout

```
src/
  index.ts                      # worker entry: fetch handler + queue consumer + Env types
  router.ts                     # Hono app: routes; POST enqueues a READING_JOBS message
  middleware.ts                 # bearer auth + CORS allowlist
  process-reading.ts            # processReading pipeline (runs in the queue consumer)
  services.ts                   # Services interface (DI for fetch / now / id)
  schemas/                      # zod: manifest, tool input, API request/response
  modules/
    extractor/                  # HTML→Markdown pipeline + bounded fetch
    embeddings/                 # OpenAI client
    anthropic/                  # forced tool use + prompt caching
    http-retry/                 # fetchWithRetry: backoff + RateLimitedError on 429
    email.ts                    # Resend per-reading notification
    stores/
      reading-store.ts          # R2: manifest, raw, extracted, by-url + by-id
      similarity-store.ts       # Vectorize: upsert + query
scripts/
  deploy.ts, deploy-web.ts      # wrangler deploy wrappers (dry-run by default)
  read-url.ts                   # CLI: POST a single URL
  gather-failed-attempts.ts     # CLI: collect failed attempts into local files
  reprocess-failed-attempts.ts  # CLI: retry a failed reading by id
  corpus-audit.ts               # CLI: inventory non-ready readings (read-only)
  corpus-recover.ts             # CLI: reprocess / re-extract non-ready readings (--wave paces realtime; --batch = bulk Message Batch path)
  corpus-delete-orphans.ts      # CLI: remove orphan-dup pending readings, consistently
  corpus-lib/{...}              # shared corpus audit/recover/throttle logic + R2 reads
  corpus-lib/batch/{...}        # bulk path: Anthropic Message Batch + OpenAI array embed, phase pipeline, resume sidecar
  lib/cf-clients.ts             # shared R2 (S3/SigV4) + Vectorize REST clients (corpus-recover --batch)
  check-corpus.ts               # CLI: mark a reading-list export against the corpus
  process-reading-list.ts       # CLI: submit unprocessed reading-list entries
  import-bookmarks.ts + import-bookmarks-lib/{...}        # Chrome export → POST /readings
  import-markdown.ts + import-markdown-lib/{...}          # local .md → import-markdown
test/
  integration/                  # Hono router via Miniflare (R2 + stub Vectorize + stub queue)
  unit/                         # workers pool: schemas, extractor, embeddings, anthropic,
                                #   http-retry, email, stores, process-reading, queue, corpus
                                # node pool: import-bookmarks, import-markdown,
                                #   check-corpus, process-reading-list, reprocess-failed,
                                #   corpus, lib
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
- **node** — Node-side script tests (corpus, import, shared `lib`) use `node:fs`/`os`/`path` and a real temp dir for fixture files.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. Manual smoke via local `wrangler dev` and against the deployed Worker (`reading-lite.bbell.dev`) is part of the PRD's verification plan.

`cd web && npm test` runs the SPA tests (jsdom + window.fetch stubs).

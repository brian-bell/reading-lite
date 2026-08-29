# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → the configured
provider summarizes it once (OpenAI by default, Anthropic optional) → R2 stores
the manifest + raw + extracted markdown → Vectorize indexes the embedding → poll
for the result.

Replaces a heavier Docker + SQLite + agent-orchestrator pipeline with a single
Worker plus managed Cloudflare services (R2, Vectorize, Queues) and a
Pages-hosted SPA. Deployed and in personal use at
[`reading-lite.bbell.dev`](https://reading-lite.bbell.dev).

- [`docs/operations.md`](docs/operations.md) — deploy, staging lifecycle, bulk
  ingest, corpus repair
- [`docs/founder-cutover.md`](docs/founder-cutover.md) — production founder
  corpus copy and `TENANT_DATA_PLANE` flip
- [`docs/system-map/`](docs/system-map/README.md) — interactive architecture map
- [`docs/product/`](docs/product/reading-lite-scope.md) — product brief and scope
- [`docs/decisions/`](docs/decisions/0001-tenant-control-plane.md) — architecture
  decision records
- [`CONTEXT.md`](CONTEXT.md) — the domain language the code is named after
- [`AGENTS.md`](AGENTS.md) — quick reference for AI coding agents

## Architecture at a glance

```
POST /api/readings { url }
  ├─ dedup via per-tenant index/by-url/{sha256(url)} → existing manifest? return 200
  └─ else: claim the by-url owner, write a "pending" manifest, enqueue a
           job on the READING_JOBS queue, return 202. Poll GET
           /api/readings/:id until ready/failed. Re-submitting a pending URL
           returns the owned reading; re-submitting a failed URL reprocesses
           that same id.

READING_JOBS consumer (max_concurrency = 3) runs processReading per message:
        fetch URL (timeout + size cap)
      → linkedom + readability + turndown → markdown
      → OpenAI text-embedding-3-small over the extracted text
      → Vectorize.query(top-K) for similar context
      → selected summarizer with structured output (OpenAI Responses by
        default; Anthropic tool use when configured; no fallback)
      → OpenAI embed the final TL;DR
      → Vectorize.upsert(id, tldr_embedding, metadata)
      → R2 write final manifest + confirm by-url pointer
      (on any error → write status="failed" manifest; the eager by-url
       owner stays in place so a later submit can reprocess the same id)
      (upstream 429 → RateLimitedError → msg.retry({delaySeconds}); the
       manifest stays pending until a later delivery completes. A message
       that exhausts max_retries routes to the reading-lite-dlq queue,
       where markDeadLettered flips the strand to a retryable "failed")
```

Each background run also stages an attempt record under
`readings/.../attempts/{attempt_id}.json` capturing the trigger, stage, timings,
and sanitized error details, so failed readings can be inspected without
`wrangler tail`. When `TENANT_DATA_PLANE=1` (Workers-pool tests today;
production stays off until the founder corpus is copied), those objects live
under `u/{tenantId}/`. Stored `key_prefix` remains the relative `readings/…`
path.

The Worker is composed of deeply isolated modules, each unit-tested with stubbed
`fetch` and bindings:

| Module | Responsibility |
|---|---|
| `extractor` | fetch source URL, sniff content type, HTML→Markdown via linkedom + readability + turndown; special-cases X author threads and YouTube watch pages |
| `embeddings` | OpenAI `text-embedding-3-small` (1536-dim) |
| `summarizer` | provider selection and normalized result/usage contract; defaults to OpenAI and never silently falls back |
| `openai-summarizer` | one-shot OpenAI Responses request with strict JSON-schema output |
| `anthropic` | one-shot `messages.create` with `tool_choice: any` (`emit_reading` or `reject_source`); system + tool defs cached via `cache_control` |
| `stores` | `ReadingStore` over R2 (manifest, raw, extracted, by-url + by-id pointers) and `SimilarityStore` over Vectorize |
| `http-retry` | `fetchWithRetry`: 5xx + network retry with exponential backoff + jitter; 429 → `RateLimitedError` so the queue reschedules instead of burning a slot |
| `email` | per-reading notification via Resend |

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # D1 migrations + founder bootstrap, then wrangler dev on :8787
npm test
npm run typecheck
```

`wrangler dev` (top-level `wrangler.toml`, Worker name `reading-lite-dev`) runs
against a Miniflare-emulated R2 bucket — initially empty, never the deployed one
— so no remote resources are needed or touched.

> **`wrangler dev` has no Vectorize binding and no Queue binding by design.**
> Vectorize has no local emulator and a remote binding would point dev at
> production data, so search returns nothing locally; without `READING_JOBS`,
> `POST /api/readings` and `/api/readings/:id/reprocess` return 503. Read-only
> list/detail routes work against whatever is in the local bucket — see
> [seeding local R2](docs/operations.md#seeding-local-r2). Submission and search
> behavior is covered by the integration tests instead, which inject queue and
> Vectorize stubs.

For deployed environments, secrets, and the staging lifecycle, see
[`docs/operations.md`](docs/operations.md).

### Configuration

Vars in `wrangler.toml` are non-secret and set per environment:

| Var | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `MCP_ALLOWED_ORIGINS` | `https://reading-lite.bbell.dev` | Comma-separated Origin allowlist for `POST /mcp`. Requests with no Origin (non-browser MCP clients) pass; unknown Origins are 403. |
| `PENDING_TTL_SECONDS` | `900` | A `pending` manifest whose active attempt is older than this is treated as stale (surfaced as `failed` on read; a new attempt may supersede it). |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap (10 MiB) on source response size. |
| `SUMMARIZER_PROVIDER` | `openai` | Summarization backend: `openai` or `anthropic`. Invalid values fail closed; there is no automatic fallback. |
| `OPENAI_SUMMARIZATION_MODEL` | `gpt-5.6-terra` | OpenAI Responses model used when the selected provider is OpenAI. |
| `OPENAI_SUMMARIZATION_REASONING_EFFORT` | `low` (`medium` in staging and production) | OpenAI reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model passed to `messages.create` when the selected provider is Anthropic. |
| `EMAIL_FROM` | `""` | Sender for notification emails (a verified Resend domain). Empty disables email. |
| `EMAIL_TO` | `""` | Recipient for notification emails. |
| `WEB_BASE_URL` | `""` | Base URL used to build the "view reading" link in notification emails. |
| `RETRY_MAX_ATTEMPTS` | `"3"` | In-call retry attempts for transient Anthropic/OpenAI failures. |
| `RETRY_BASE_DELAY_MS` | `"500"` | Base exponential-backoff delay for transient upstream retries. |
| `RETRY_MAX_DELAY_MS` | `"8000"` | Maximum in-call retry delay; `Retry-After` is clamped to this value. |

Secrets are set with `wrangler secret put` — see
[required secrets](docs/operations.md#secrets).

## API

Machine-readable contract: [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI
3.1). Keep it in lockstep with `src/router.ts` and `src/schemas/`.

All routes except `/health` require `Authorization: Bearer <token>`. After
cutover the token is the founder legacy bearer imported by
`founder-bootstrap` from `READER_API_TOKEN`; runtime auth looks it up in D1
and does not fall back to the secret itself.

| Method + path | Behavior |
|---|---|
| `GET /health` | 200 `ok`. No auth. |
| `GET /api/whoami` | Authenticated principal identity (`tenant_id`, `user_id`, `principal`, `tenant_data_plane`, `email`). No scope beyond auth. |
| `POST /mcp` | Streamable HTTP MCP endpoint (tools). Bearer auth. See [MCP connector](#mcp-connector). |
| `POST /api/readings` | Body `{ url, email? }`. Returns 202 `{ id, status: "pending", poll }` for new URLs; 200 with the existing manifest for owned `ready`/`pending` URLs; 202 reprocesses the same id for owned `failed` URLs. Background work fills the manifest. |
| `POST /api/readings/import-markdown` | Body `{ source_url, markdown, title?, email? }`. Uses `source_url` for identity/dedupe, skips source fetching, and processes the supplied Markdown as the captured article. Defaults `email` to false. Ready/pending owners return 200 with the existing manifest; failed owners reprocess the same id with the new Markdown. |
| `GET /api/readings` | Newest-first list. Query: `q` (substring across title/tldr/url/keywords, case-insensitive), `tag` (exact, case-insensitive, tags only), `offset` (default 0), `limit` (1–100, default 20). Response: `{ readings, limit, offset, has_more }`. |
| `GET /api/readings/:id` | Returns the manifest (status `pending` / `ready` / `failed`). |
| `GET /api/readings/:id/diagnostics` | Returns the manifest, pointer health, list-index item, R2 object inventory, and recent processing attempts. |
| `POST /api/readings/:id/reprocess` | Starts a fresh processing attempt for the existing reading id. Optional body `{ "force": true }` bypasses an active-attempt conflict. Optional body `{ "source": { "kind": "markdown", "markdown": "…", "title"?: "…" } }` reprocesses the supplied Markdown instead of re-fetching the URL, taking precedence over a markdown reading's stored text. A successful attempt makes the reading `source_type: "markdown"`, so later no-source reprocesses reuse that Markdown; on failure the reading keeps its previous `source_type`, and a reading that was already `ready` rolls back to its preserved manifest. The Markdown must fit Cloudflare's 128 KB queue-message limit; a larger body rolls the attempt back and returns 503. |
| `GET /api/readings/:id/content` | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /api/readings/:id/content/raw` | Streams the raw bytes with the original `content_type`. |
| `GET /api/readings/lookup?url=` | 200 `{ id }` for URLs with an owner, including `pending` and `failed` readings, 404 otherwise. |
| `DELETE /api/readings/:id` | Purges the reading everywhere: Vectorize vector, `index/list.json` row, by-url ownership pointer (only when this reading owns it — an orphan-duplicate's slot belongs to its surviving copy and is left alone), every R2 object under the reading's prefix, and the by-id pointer last, so a partially-failed purge can be re-issued to completion. Requires the `readings:delete` scope. 409 while an attempt is running (stale attempts past the pending TTL don't block); 404 for unknown ids. Returns a purge report `{ id, vector_delete_requested, list_row_removed, by_url_released, objects_deleted }`. Other readings' `connections` may still name the deleted id; those links 404 until swept. |
| `POST /api/readings/similar` | Body `{ query_embedding: number[1536], k?: number }`. Top-K via Vectorize. |

List filtering is server-side against a denormalized `index/list.json` in R2,
maintained on every `POST /api/readings` (pending) and every terminal write in
`processReading` (ready/failed). When the index is missing — a freshly
provisioned bucket, say — the list endpoint falls back to scan-and-rebuild.

The full manifest schema lives in `src/schemas/manifest.ts`. Notable fields:
`status`, `source_type?` (`url` | `markdown`), `error?`, `active_attempt?`,
`last_attempt?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`,
`novelty_verdict?` (`novel` | `familiar` | `duplicate`), `connections?`,
`summary_markdown?`, `content_type`, `content_status`, `content_bytes`,
`extracted_bytes?`, `content_sha256`, and `usage?`, which records embedding
tokens plus a provider-discriminated summarization usage object.

To diagnose a failed or stuck reading, retry one, or repair the corpus in bulk,
see [`docs/operations.md`](docs/operations.md).

## MCP connector

`POST /mcp` is a stateless Streamable HTTP MCP server for Cursor and Grok Bot.
Tools dispatch internally into the authenticated HTTP API with the caller's
Bearer token — they never re-fetch `reading-lite.bbell.dev` over the network.

Tools (reads first; writes mutate the corpus): `list_readings`, `search_readings`,
`get_reading`, `get_reading_content`, `submit_url`, `import_markdown`,
`reprocess_reading`, `get_diagnostics`. List/search return metadata only; full
extracted markdown is opt-in by id. After a successful import the tool result
includes `public_url` / `public_markdown_link` when `WEB_BASE_URL` is set.

Cursor `mcp.json` / Grok Bot custom connector (same shape). Use the existing
`reading-lite.bearerToken` value — never commit it:

```json
{
  "name": "reading-lite",
  "url": "https://reading-lite.bbell.dev/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

The same tools are also served at `https://reading-lite.bbell.dev/api/mcp` (already
inside the `/api/*` Worker route). Use `/mcp` once the dedicated `mcp*` route is
attached; `/api/mcp` is the fallback when Pages still owns `/mcp`.

Local `wrangler dev` serves the same path at `http://127.0.0.1:8787/mcp`.
Stdio-only clients can bridge with `npx mcp-remote https://reading-lite.bbell.dev/mcp`.
Operator notes (origin var, production route) live in
[`docs/operations.md`](docs/operations.md#mcp-connector).

## Web SPA

A small React SPA in `web/` renders the list (with search + tag chips),
submission form, and detail page (TL;DR, summary markdown, entities,
connections, content links), and persists the bearer token in `localStorage`.

```sh
# In one terminal — Worker:
npm run dev

# In another terminal — SPA:
cd web && npm install && npm run dev   # vite dev on http://127.0.0.1:5173
```

Vite proxies `/api` and `/health` to the Worker so requests are same-origin in
development. In production the SPA is served from Cloudflare Pages on the same
custom domain as the Worker, with Worker routes scoped to `/api/*`, `/health`,
and `/mcp*` so Pages handles every other path.

The SPA carries its own hand-typed `web/src/types.ts` mirroring
`src/schemas/manifest.ts` — keep them in sync when the Worker schema changes.

## Ingesting readings

Beyond the API and the SPA form, several node-side tools ingest in bulk. All are
documented in [`docs/operations.md`](docs/operations.md#bulk-ingest); all plan
by default (omit `--execute` to preview) and resume from a local index.

```sh
npm run ops -- reading submit <url> --execute          # POST a single URL
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute
npm run ops -- import markdown --dir ~/Documents/articles --execute
npm run ops -- corpus ingest --dir ~/Documents/articles --execute --sole-writer  # provider Batch API
```

X/Twitter status URLs extract in-worker through the official recent-search
API (`X_API_BEARER_TOKEN`). Reddit and YouTube need a local extraction step
— the Worker is blocked from both — via the `reddit-import` and
`youtube-import` skills. See [X threads](docs/operations.md#x-threads) and
[sources that need a local skill](docs/operations.md#sources-that-need-a-local-skill).

## Repo layout

```
src/
  index.ts                      # worker entry: fetch handler + queue consumer + Env types
  router.ts                     # Hono app: routes + the IntakeOutcome -> HTTP mapping
  mcp/                          # Streamable HTTP MCP connector (POST /mcp tools)
  middleware.ts                 # bearer auth + CORS allowlist
  intake/                       # Reading intake: submit/importMarkdown/reprocess verbs;
                                #   activation.ts = eager write-and-enqueue + rollback funnel
  process-reading.ts            # processReading pipeline (runs in the queue consumer)
  reading-visibility.ts         # list-row + Vectorize-vector lockstep, behind an owner gate
  attempt-ownership.ts          # shared ownership verdict + attempt arg shapes
  control-plane/                # D1 auth: HMAC crypto, principal, founder bootstrap
  services.ts                   # Services interface (DI for fetch / now / id)
  schemas/                      # zod: manifest, tool input, API request/response
  modules/
    reading-claim.ts            # by-url ownership resolution
    staleness.ts                # read-time stale-annotation rule
    extractor/                  # HTML→Markdown pipeline + bounded fetch; x.ts threads + youtube.ts in-worker path
    embeddings/                 # OpenAI client
    summarizer/                 # provider selection + normalized usage/result contract
    openai-summarizer/          # Responses API + strict structured output
    anthropic/                  # emit_reading / reject_source + prompt caching
    http-retry/                 # fetchWithRetry: backoff + RateLimitedError on 429
    email.ts                    # Resend per-reading notification
    stores/
      reading-store.ts          # R2: manifest, raw, extracted, by-url + by-id
      list-index.ts             # index/list.json: CAS, search, ownership, rebuild
      similarity-store.ts       # Vectorize: upsert + query
scripts/                        # operator tooling — plan-first, --execute to act
  ops.ts, ops-lib/              # unified operator CLI (npm run ops -- <group> <command>):
                                #   deploy, staging, founder, corpus, reading,
                                #   import, and reading-list groups
  dev-setup.ts                  # local npm run dev bootstrap
  corpus-lib/, lib/, *-lib/     # shared logic behind the CLIs above;
                                #   corpus-lib/batch/ is the provider Batch API pipeline
test/
  integration/                  # Hono router via Miniflare (R2 + stub Vectorize + stub queue)
  unit/                         # workers pool: schemas, modules, stores, process-reading, queue
                                # node pool: script + shared-lib tests
web/                            # React SPA (separate npm project)
docs/                           # operations runbook, system map, product, decisions
wrangler.toml                   # local, staging, and production Worker config
wrangler.test.toml              # test config (R2 only; Vectorize is stub-injected)
vitest.workspace.ts             # two projects: "workers" + "node"
```

## Tests

`npm test` from the repo root runs both Vitest projects:

- **workers** — schemas, deep modules, R2 store, and integration tests against
  the Hono router using `cloudflare:test`'s Miniflare-backed `env`. Vectorize is
  not natively emulated, so each test that needs it injects a stub binding into
  `env.READINGS_INDEX`.
- **node** — script tests (corpus, import, shared `lib`) that use `node:fs` /
  `os` / `path` and a real temp dir for fixtures.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. `npm run
test:quiet` runs the same suite with Workers-pool stderr noise stripped.

`cd web && npm test` runs the SPA tests (jsdom + `window.fetch` stubs).

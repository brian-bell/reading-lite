# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → the configured provider summarizes it once (OpenAI by default, Anthropic optional) → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the embedding → poll for the result.

Replaces a heavier Docker + SQLite + agent-orchestrator pipeline with a single Worker plus managed Cloudflare services (R2, Vectorize, Queues) and a Pages-hosted SPA.

- Full PRD: [`plans/001-prd-reading-lite.md`](plans/001-prd-reading-lite.md)
- Original design memo: [`plans/000-re-design.md`](plans/000-re-design.md)
- Tracking issue: [#1](https://github.com/brian-bell/reading-lite/issues/1)

## Status

Deployed and in personal use at [`reading-lite.bbell.dev`](https://reading-lite.bbell.dev) (Worker + Cloudflare Pages SPA). Production-shaped TypeScript with root and SPA test suites.

## Architecture at a glance

```
POST /api/readings { url }
  ├─ dedup via index/by-url/{sha256(url)} → existing manifest? return 200
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
        default; Anthropic forced tool use when configured; no fallback)
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

Each background run also writes a staged attempt record under
`readings/.../attempts/{attempt_id}.json`. Attempts capture the trigger
(`submit` or `reprocess`), current/final stage, timings, and sanitized error
details so failed readings can be inspected without relying only on `wrangler
tail`.

The Worker is composed of deeply isolated modules (each unit-tested with stubbed `fetch` / bindings):

| Module | Responsibility |
|---|---|
| `extractor` | fetch source URL, sniff content type, HTML→Markdown via linkedom + readability + turndown; special-cases YouTube watch pages (oEmbed + transcript) |
| `embeddings` | OpenAI `text-embedding-3-small` (1536-dim) |
| `summarizer` | provider selection and normalized result/usage contract; defaults to OpenAI and never silently falls back |
| `openai-summarizer` | one-shot OpenAI Responses request with strict JSON-schema output |
| `anthropic` | one-shot `messages.create` with `tool_choice: {type: "tool", name: "emit_reading"}`; system + tool def cached via `cache_control` |
| `stores` | `ReadingStore` over R2 (manifest, raw, extracted, by-url + by-id pointers) and `SimilarityStore` over Vectorize |
| `http-retry` | `fetchWithRetry`: 5xx + network retry with exponential backoff + jitter; 429 → `RateLimitedError` so the queue reschedules instead of burning a slot |
| `email` | per-reading notification via Resend |

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # wrangler dev with local R2 only; Queue/Vectorize absent by design
npm test                         # vitest workspace (workers pool + node pool)
npm run typecheck
```

`wrangler dev` (top-level `wrangler.toml`, worker name `reading-lite-dev`) runs your code locally against a Miniflare-emulated R2 bucket — initially empty, never the deployed one — so no remote resources are needed or touched. The distinct dev name also guards against an accidental bare `wrangler deploy` clobbering prod. Staging resources (`reading-lite-staging` bucket, Queue/DLQ, and Vectorize index) live under `[env.staging]`; production resources (`reading-lite` bucket + Vectorize index, served at `reading-lite.bbell.dev`) live under `[env.production]`.

> **`wrangler dev` has no Vectorize binding and no Queue binding by design.** Search returns no results locally (Vectorize has no local emulator, and a remote binding would point dev at production data), and `POST /api/readings` / `/api/readings/:id/reprocess` return 503 without `READING_JOBS`. Read-only list/detail routes work against whatever you write to the local bucket. Most submission/search behavior is covered by the integration tests instead (`installQueueStub()` + `drainQueue()`), which don't need real bindings.

### Deployed environments

Staging is for real end-to-end smoke tests without mutating the production
corpus. One-time Cloudflare resources are managed by dry-run-first wrappers:

```sh
npm run staging:setup
npm run staging:setup -- --execute
# or:
make staging-setup EXECUTE=1
```

Setup is idempotent: if a staging bucket, Queue/DLQ, or Vectorize index already
exists, the script treats Cloudflare's "already exists" response as success and
continues.

Set staging Worker secrets separately from production:

```sh
wrangler secret put READER_API_TOKEN --env staging
wrangler secret put OPENAI_API_KEY --env staging
# Only when SUMMARIZER_PROVIDER=anthropic:
wrangler secret put ANTHROPIC_API_KEY --env staging
# Optional notifications:
wrangler secret put RESEND_API_KEY --env staging
```

To tear down the isolated staging Worker and resources, review the dry run
first. The script removes Queue consumers before deleting the Worker, then
deletes Queue/DLQ and Vectorize resources, empties the staging R2 bucket via
the S3-compatible R2 API, and deletes the bucket. The bucket-empty step requires
`CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`, and `CORPUS_R2_SECRET_KEY` in
the environment or `.corpus.vars`; the bucket name is still forced to
`reading-lite-staging`. The script is hard-coded to staging resource names and
refuses production-looking names:

```sh
npm run staging:teardown
npm run staging:teardown -- --execute
# or:
make staging-teardown EXECUTE=1
```

Teardown is also idempotent: missing Queue consumers, Worker, Queue/DLQ,
Vectorize index, or R2 bucket are treated as already removed. Unexpected
Wrangler or R2 API failures still stop the script.

Deploy staging with dry-run defaults:

```sh
cp .stg.vars.example .stg.vars   # fill in staging values
make deploy-worker ENV=stg
make deploy-worker ENV=stg EXECUTE=1
make deploy-web ENV=stg
make deploy-web ENV=stg EXECUTE=1
```

Run idempotency smoke against staging:

```sh
VARS_FILE=.stg.vars BASE=https://reading-lite-staging.<workers-subdomain>.workers.dev \
  ./scripts/manual/idempotency-smoke.sh a "https://example.com/reading-lite-staging-$RANDOM"
```

Clean staging throwaways, including ready readings:

```sh
npm run corpus-audit -- --bucket reading-lite-staging
npm run corpus-drop -- "https://example.com/reading-lite-staging-123" \
  --bucket reading-lite-staging \
  --allow-ready \
  --vectorize reading-lite-staging \
  --execute
```

### Required secrets

Set via `wrangler secret put --env staging` or `--env production` against the
deployed Worker:

| Secret | What |
|---|---|
| `READER_API_TOKEN` | Bearer token required on every protected route |
| `OPENAI_API_KEY` | Always required for `text-embedding-3-small` and the default OpenAI summarizer |
| `ANTHROPIC_API_KEY` | Required only when `SUMMARIZER_PROVIDER=anthropic` |
| `RESEND_API_KEY` | Resend API key for per-reading email notifications. **`POST /api/readings` requests notifications by default** (`email: true`), so without this — and the `EMAIL_*` / `WEB_BASE_URL` vars below — every submission still produces a `ready` manifest but logs a failed `send_email` event. Leave unset to skip email; the reading itself is unaffected. |

Vars in `wrangler.toml` (non-secret, can be edited per-environment):

| Var | Default | Purpose |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated origin allowlist for browser callers. Empty disables CORS preflight. |
| `PENDING_TTL_SECONDS` | `900` | A `pending` manifest whose active attempt is older than this is treated as stale (surfaced as `failed` on read; a new attempt may supersede it). |
| `FETCH_TIMEOUT_MS` | `20000` | Hard timeout for the source URL fetch. |
| `FETCH_MAX_BYTES` | `10485760` | Hard cap (10 MiB) on source response size. |
| `SUMMARIZER_PROVIDER` | `openai` | Summarization backend: `openai` or `anthropic`. Invalid values fail closed; there is no automatic fallback. |
| `OPENAI_SUMMARIZATION_MODEL` | `gpt-5.6-terra` | OpenAI Responses model used when the selected provider is OpenAI. |
| `OPENAI_SUMMARIZATION_REASONING_EFFORT` | `low` | OpenAI reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model passed to `messages.create` when the selected provider is Anthropic. |
| `EMAIL_FROM` | `""` | Sender for notification emails (a verified Resend domain). Empty disables email. |
| `EMAIL_TO` | `""` | Recipient for notification emails. |
| `WEB_BASE_URL` | `""` | Base URL used to build the "view reading" link in notification emails. |
| `RETRY_MAX_ATTEMPTS` | `"3"` | In-call retry attempts for transient Anthropic/OpenAI failures. |
| `RETRY_BASE_DELAY_MS` | `"500"` | Base exponential-backoff delay for transient upstream retries. |
| `RETRY_MAX_DELAY_MS` | `"8000"` | Maximum in-call retry delay; `Retry-After` is clamped to this value. |

## API

All routes except `/health` require `Authorization: Bearer $READER_API_TOKEN`.

| Method + path | Behavior |
|---|---|
| `GET /health` | 200 `ok`. No auth. |
| `POST /api/readings` | Body `{ url, email? }`. Returns 202 `{ id, status: "pending", poll }` for new URLs; 200 with the existing manifest for owned `ready`/`pending` URLs; 202 reprocesses the same id for owned `failed` URLs. Background work fills the manifest. |
| `POST /api/readings/import-markdown` | Body `{ source_url, markdown, title?, email? }`. Uses `source_url` for identity/dedupe, skips source fetching, and processes the supplied Markdown as the captured article. Defaults `email` to false. Ready/pending owners return 200 with the existing manifest; failed owners reprocess the same id with the new Markdown. |
| `GET /api/readings` | Newest-first list. Query: `q` (substring across title/tldr/url, case-insensitive), `tag` (exact, case-insensitive), `offset` (default 0), `limit` (1–100, default 20). Response: `{ readings, limit, offset, has_more }`. |
| `GET /api/readings/:id` | Returns the manifest (status `pending` / `ready` / `failed`). |
| `GET /api/readings/:id/diagnostics` | Returns the manifest, pointer health, list-index item, R2 object inventory, and recent processing attempts. |
| `POST /api/readings/:id/reprocess` | Starts a fresh processing attempt for the existing reading id. Failed readings move through `pending`; ready readings keep their current ready manifest if the new attempt fails. Optional body `{ "force": true }` bypasses an active-attempt conflict. |
| `GET /api/readings/:id/content` | Streams `extracted.md`. 404 when `content_status != "captured"`. |
| `GET /api/readings/:id/content/raw` | Streams the raw bytes with the original `content_type`. |
| `GET /api/readings/lookup?url=` | 200 `{ id }` for URLs with an owner, including `pending` and `failed` readings, 404 otherwise. |
| `POST /api/readings/similar` | Body `{ query_embedding: number[1536], k?: number }`. Top-K via Vectorize. |

List filtering is server-side against a denormalized `index/list.json` in R2 that is maintained on every `POST /api/readings` (pending) and every terminal write in `processReading` (ready/failed). When the index is missing (e.g. a freshly provisioned bucket), the list endpoint falls back to scan-and-rebuild.

The full manifest schema lives in `src/schemas/manifest.ts`. Notable fields: `status`, `source_type?` (`url` | `markdown`), `error?`, `active_attempt?`, `last_attempt?`, `title?`, `tldr?`, `tags?`, `keywords?`, `people?`, `orgs?`, `novelty_verdict?` (`novel` | `familiar` | `duplicate`), `connections?`, `summary_markdown?`, `content_type`, `content_status`, `content_bytes`, `extracted_bytes?`, `content_sha256`, and `usage?`, which records embedding tokens plus a provider-discriminated summarization usage object.

### Troubleshooting and reprocessing

Use `GET /api/readings/:id/diagnostics` when a reading is failed or stuck. The
response shows whether by-id/by-url pointers line up, whether expected R2
objects exist, and which processing stage failed (`fetch_source`,
`embed_source`, `summarize`, `upsert_vector`, `write_indexes`, etc.).

Use `POST /api/readings/:id/reprocess` to retry the exact reading id. For a failed
reading, the manifest becomes `pending` while the new attempt runs. For a ready
reading, the current ready manifest remains the fallback; if the reprocess
attempt succeeds it replaces the manifest and vector, and if it fails the ready
manifest is preserved with `last_attempt.status = "failed"`.

For bulk retry work, use the corpus tools: `npm run corpus-audit` inventories
every non-ready reading and classifies each failure by reason (read-only), and
`npm run corpus-recover` acts on that audit — reprocessing recoverable readings
through `POST /api/readings/:id/reprocess` (`--wave` paces realtime submissions) or
the asynchronous provider Batch API path (`--batch`), per a per-reason policy table.
Both default to a dry run; pass `--execute` to act. The recover `--batch` path now
eagerly claims each by-url slot before submit (a failed→pending flip), matching
fresh ingest, but still requires `--sole-writer` to execute: the eager claim is
defense-in-depth, not a full replacement for pausing the realtime writer, so
confirm it is paused/drained first
(`npm run corpus-recover -- --batch --execute --sole-writer`). To bulk-import a
*fresh* markdown directory (not yet in the corpus) through the same provider batch
path, use `npm run corpus-ingest -- --dir <path>` (see Bulk markdown ingest above).

## Web SPA

A small React SPA lives in `web/` and points at the Worker via Vite's dev proxy. It renders the list (with search + tag chips), submission form, detail page (TL;DR, summary markdown, entities, connections, content links), and persists the bearer token in `localStorage`.

```sh
# In one terminal — Worker:
npm run dev                            # wrangler dev on http://127.0.0.1:8787

# In another terminal — SPA:
cd web && npm install && npm run dev   # vite dev on http://127.0.0.1:5173
```

The SPA proxies `/api` and `/health` to the Worker so requests are same-origin in development. In production the SPA is served from Cloudflare Pages on the same custom domain as the Worker (`reading-lite.bbell.dev`), with Worker routes scoped to `/api/*` and `/health` so Pages handles every other path. Deploy production with `npm run deploy:web -- --execute` or `make deploy-web ENV=prd EXECUTE=1`; deploy a Pages preview for staging with `make deploy-web ENV=stg EXECUTE=1`.

The SPA carries its own hand-typed `web/src/types.ts` mirroring `src/schemas/manifest.ts` — keep them in sync if the Worker schema changes.

## Importing Chrome bookmarks

A node-side script ingests URLs from a Chrome bookmark export. By default it asks `Y/n/q` before each URL (Enter or `y` to submit, `n` to skip, `q` to abort). Re-runs are no-ops thanks to a local `.import-bookmarks-index.json` (per destination URL).

```sh
# default: "Computing" (top-level, i.e. under "Other Bookmarks") — interactive,
# posts to http://127.0.0.1:8787/api/readings
npm run import-bookmarks -- --file ~/Downloads/bookmarks.html

# fire everything without prompts (still serial — one POST at a time)
npm run import-bookmarks -- --file ~/Downloads/bookmarks.html --quick

# nested folder against prod
npm run import-bookmarks -- \
  --file ~/Downloads/bookmarks.html \
  --folder "Computing/AI/MCP" \
  --url https://reading-lite.bbell.dev/api/readings
```

`--url` takes the **full** readings endpoint to POST to (default: `http://127.0.0.1:8787/api/readings`, or `READER_URL` env). `--dry-run` prints the would-submit list without prompting or POSTing. `--quick` skips the per-URL prompt; submission is always serial (one POST at a time) so the local index can't race with itself. Token resolution mirrors `npm run read`: `--token` > `READER_API_TOKEN` env > `.dev.vars`. Transport-level fetch failures are retried twice (250ms / 500ms backoff); errors and statuses are surfaced with their underlying cause (e.g. `fetch failed / ECONNREFUSED ...`). Errors are NOT recorded in the index, so the next run retries them; `new`/`existing` responses are recorded immediately, so an interrupted run picks up where it left off. The worker also dedupes on its side via the by-url pointer, so deleting the local index is safe — it just means re-POSTing every URL once to rebuild it.

## Importing local Markdown

Local `.md` files can be imported without re-fetching their source URLs. Each
file must include a source line:

```md
**Source:** https://example.com/article
```

The importer uses that URL as the canonical reading URL and sends the Markdown
body to `POST /api/readings/import-markdown`. Duplicate files with the same source
URL are collapsed before submit; the largest Markdown file wins. Imported
readings store the Markdown as both raw content and `extracted.md`, then reuse
the normal embedding, similarity, configured-provider summary, Vectorize, manifest, and list
index pipeline.

```sh
# preview the plan; no token required
npm run import-markdown -- --dir ~/Documents/articles --dry-run

# submit to local dev
npm run import-markdown -- --dir ~/Documents/articles

# submit to staging
npm run import-markdown -- \
  --dir ~/Documents/articles \
  --url https://reading-lite-staging.<workers-subdomain>.workers.dev/api/readings/import-markdown

# submit to production
npm run import-markdown -- \
  --dir ~/Documents/articles \
  --url https://reading-lite.bbell.dev/api/readings/import-markdown
```

`--url` is the full import endpoint. Token resolution mirrors the other
scripts: `--token` > `READER_API_TOKEN` env > `.dev.vars`. Successful
new/existing responses are recorded in `.import-markdown-index.json`, scoped by
destination URL, so interrupted runs resume cleanly. Files larger than the
Cloudflare Queues 128 KB message limit are blocked before any POST; successful
new/existing responses move every file for that source URL into a `processed/`
subdirectory under the import directory. Emails are off by default; pass
`--email` to request email notifications for imported readings.

#### Bulk markdown ingest via provider Batch APIs

`import-markdown` summarizes every file **realtime** through the Worker queue.
For large backfills, `corpus-ingest` ingests the same directory through the
configured provider's **Batch API** (OpenAI by default, Anthropic optional).
It is the markdown-in-hand sibling of `corpus-recover --batch`: it
talks to R2/Vectorize directly with `CORPUS_R2_*` credentials rather than the
HTTP `/api/readings` API. The resulting `ready` manifests are contract-compatible
with the realtime import path (`source_type: "markdown"`, captured content,
correct `content_bytes`/`content_sha256`, `usage.openai_embedding_tokens`,
by-url + by-id pointers, a Vectorize vector, and an `index/list.json` entry);
like `corpus-recover --batch`, the bulk path omits the realtime attempt-log
fields (`last_attempt` and the per-attempt objects under the key prefix).

```sh
# dry-run (default): print the plan; with creds it also shows ownership skips
npm run corpus-ingest -- --dir ~/Documents/articles

# ingest for real (writes manifests, pointers, vectors, list index)
# --sole-writer is required: confirm the realtime writer is paused/drained first
npm run corpus-ingest -- --dir ~/Documents/articles --execute --sole-writer --bucket reading-lite
```

Idempotency is resolved client-side from `index/by-url/{sha256(url)}` by the same
rules as the Worker's `ReadingClaim`: a pointer only counts as the owner when its
manifest actually matches (id + url + url_hash), so ready owners and pending
owners are skipped while failed owners re-ingest in place; a fresh pointer whose
manifest hasn't landed yet is treated as still-initializing and skipped (a
realtime submit may be in flight); unclaimed URLs mint a brand-new reading; and
damaged or mismatched by-url pointers are skipped for operator repair rather than
claimed over. When no by-url pointer exists, it first runs the same cold-legacy
lookup the Worker does (`findManifestByUrl` over `index/list.json`): a prior
legacy failed ingest may have a by-id pointer + list row but no by-url pointer, so
a rerun finds that failed reading there and re-ingests it in place instead of
minting a duplicate. Pending owners are skipped even when past `PENDING_TTL_SECONDS`: this
offline path can't safely supersede a queue worker that may still be running, so
a stranded pending is left to heal via the realtime API or `corpus-recover`
rather than risk racing the worker. Before any fresh eager activation writes,
the batch path preflights the provider payload, resolves similar-reading context,
then validates the final request payload. OpenAI JSONL is measured as exact
UTF-8 bytes and capped at 50,000 requests and 190 MB; Anthropic payloads use the
existing 200 MB safety cap. If a run is too large, rerun with `--limit` to split
it without leaving pending owners behind. Fresh ingest then eagerly claims activated by-url slots
before creating the provider batch; if the batch later fails, the write phase
releases that eager claim only when the by-url pointer still exactly matches the
failed target. The "sole writer" condition is enforced, not just assumed:
`corpus-ingest --execute` (and likewise `corpus-recover --batch --execute`)
**refuses to submit unless you also pass `--sole-writer`**, confirming the
realtime writer is paused/drained; both batch paths now eagerly claim by-url slots
(recover via a failed→pending flip that keeps its claim on failure so the URL
stays re-submittable), but that claim is defense-in-depth, so the flag stays
required; an acknowledged run prints a loud banner before any submit,
and dry-runs (which submit nothing) never require it. The in-flight batch is
recorded in a versioned sidecar (`./corpus-ingest.batch.json` by default);
re-running resumes that batch instead of creating a second (double-billed) one.
The sidecar pins provider, model, OpenAI reasoning effort, and a stable run id,
so an environment change cannot switch a resume to another provider. OpenAI's
pre-submit upload/create phases are persisted (companion `<sidecar>.input.jsonl`
holds the exact JSONL bytes, written before the `uploading` checkpoint). On
resume, the reconciler adopts what already exists: remote files by filename
(`reading-lite-${runId}.jsonl`), remote batches by `metadata.run_id`. The
expensive `create` step is **fail-closed**: a list-then-create cannot
distinguish a successful-but-lost-response prior create from a failed one
(the OpenAI Batch API has no idempotency key, and listing can lag). An
ambiguous match or no visible remote batch at the create step aborts and
asks the operator to reconcile manually. Anthropic pre-submit and OpenAI
`activating` sidecars still require manual reconcile. A sidecar-scoped file
lock serializes the entire reconcile path against concurrent resumes.
There is no cross-provider fallback.
The tools always need `CORPUS_R2_*`, `CORPUS_CF_API_TOKEN`, and
`OPENAI_API_KEY` (embeddings); `ANTHROPIC_API_KEY` is needed only for an
Anthropic start or resume. `--execute` requires the applicable credentials,
while dry-run degrades to the local plan without them.

```sh
# refuses without acknowledgment; pass --sole-writer once the realtime writer is paused
npm run corpus-ingest -- --dir ~/Documents/articles --execute --sole-writer --bucket reading-lite
```

### Reddit threads

Reddit serves a bot-challenge to datacenter egress, so the Worker can't fetch
thread JSON directly — a `POST /api/readings` with a `reddit.com` / `redd.it` URL
deliberately lands `failed`. Add Reddit threads with the **`reddit-import`**
skill instead: it drives a logged-in Chrome session to fetch the public
`<thread>.json`, renders the post + top comments to Markdown with the same
parser the Worker uses, and imports it via `POST /api/readings/import-markdown`. No
Reddit app or OAuth credentials are needed. The skill wraps
`scripts/reddit-import.ts <redditUrl> --json <saved.json>` (which also has a
`--dry-run` to preview the Markdown).

### YouTube videos

YouTube watch pages have no server-rendered article body, so the extractor
handles them in-worker instead of via Readability. Submitting a
`youtube.com/watch`, `youtu.be`, `shorts`, `live`, or `embed` URL builds Markdown
from the public oEmbed metadata (title + author — the reliable floor), plus a
best-effort description (scraped from the page's `ytInitialPlayerResponse`) and
transcript (the first caption track) when YouTube serves them. Unlike Reddit,
no skill or manual import is required — the URL summarizes to `ready` directly.
Description and transcript are best-effort: when YouTube rate-limits or gates the
watch page, the reading still lands `ready` on the title + author floor.

In practice the worker is usually blocked from the watch page (datacenter
egress), so it lands the floor only. For a full extraction — description plus
transcript — run the **`youtube-import`** skill locally:
`npx tsx scripts/youtube-import.ts "<youtubeUrl>"` (add `--dry-run` to preview).
It fetches the watch page from your residential IP and uses `yt-dlp` for the
transcript, then imports the rich markdown via `POST /api/readings/import-markdown` —
reusing the same parsers the worker uses. Requires `yt-dlp` on PATH.

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
    extractor/                  # HTML→Markdown pipeline + bounded fetch; youtube.ts in-worker path
    embeddings/                 # OpenAI client
    summarizer/                 # provider selection + normalized usage/result contract
    openai-summarizer/          # Responses API + strict structured output
    anthropic/                  # forced tool use + prompt caching
    http-retry/                 # fetchWithRetry: backoff + RateLimitedError on 429
    email.ts                    # Resend per-reading notification
    stores/
      reading-store.ts          # R2: manifest, raw, extracted, by-url + by-id
      list-index.ts             # index/list.json: CAS, search, ownership, rebuild
      similarity-store.ts       # Vectorize: upsert + query
scripts/
  deploy.ts, deploy-web.ts      # wrangler deploy wrappers (dry-run by default)
  read-url.ts                   # CLI: POST a single URL
  corpus-audit.ts               # CLI: inventory non-ready readings (read-only)
  corpus-recover.ts             # CLI: reprocess / re-extract non-ready readings (--wave paces realtime; --batch = provider Batch API path)
  corpus-ingest.ts              # CLI: bulk-ingest a fresh .md dir via a provider Batch API (markdown-in-hand sibling of corpus-recover --batch)
  corpus-delete-orphans.ts      # CLI: remove orphan-dup pending readings, consistently
  corpus-lib/{...}              # shared corpus audit/recover/throttle logic + R2 reads
  corpus-lib/batch/{...}        # bulk path: provider batch + OpenAI array embed, payload preflight, fresh activation, resume sidecar; prepare-fresh-markdown + run-fresh-markdown front-end for corpus-ingest
  lib/cf-clients.ts             # shared R2 (S3/SigV4) + Vectorize REST clients (corpus-recover --batch / corpus-ingest)
  check-corpus.ts               # CLI: mark a reading-list export against the corpus
  process-reading-list.ts       # CLI: submit unprocessed reading-list entries
  import-bookmarks.ts + import-bookmarks-lib/{...}        # Chrome export → POST /api/readings
  import-markdown.ts + import-markdown-lib/{...}          # local .md → import-markdown
  run-with-vars.ts              # helper: overlay a dotenv file onto env, then run a command
test/
  integration/                  # Hono router via Miniflare (R2 + stub Vectorize + stub queue)
  unit/                         # workers pool: schemas, extractor, embeddings, anthropic,
                                #   http-retry, email, stores, process-reading, queue
                                # node pool: import-bookmarks, import-markdown,
                                #   check-corpus, process-reading-list,
                                #   corpus, lib
web/                            # React SPA (separate npm project)
  src/{App.tsx, api.ts, types.ts, styles.css, main.tsx, test/setup.ts}
  index.html, package.json, tsconfig.json, vite.config.ts
wrangler.toml                   # local, staging, and production Worker config
wrangler.test.toml              # test config (R2 only; Vectorize is stub-injected)
vitest.workspace.ts             # two projects: "workers" + "node"
```

## Tests

`npm test` (from the repo root) runs all root tests across two Vitest projects:

- **workers** — schemas, deep modules, R2 store, integration tests against the Hono router using `cloudflare:test`'s `env` (Miniflare-backed R2). Vectorize is not natively emulated by Miniflare, so each test that needs it injects a stub binding directly into `env.READINGS_INDEX`.
- **node** — Node-side script tests (corpus, import, shared `lib`) use `node:fs`/`os`/`path` and a real temp dir for fixture files.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. Manual smoke via local `wrangler dev` and against Cloudflare staging is part of the PRD's verification plan.

`cd web && npm test` runs the SPA tests (jsdom + window.fetch stubs).

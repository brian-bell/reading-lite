# CLAUDE.md — `reading-lite`

Personal reading service on Cloudflare Workers + a React SPA at `web/`. POST a URL → a `READING_JOBS` queue message → the consumer (`max_concurrency = 3`) runs `processReading` → Claude summarizes once via forced tool use (`emit_reading`) → R2 stores manifest + raw + extracted markdown, Vectorize indexes the TL;DR embedding → poll `GET /readings/:id` until ready. The SPA uses the same routes.

Architecture, API, scripts, and repo layout live in `README.md`. This file is just the non-obvious bits.

## Conventions

- **Inject `fetch` / `now` / `newId`; never reach for globals.** Modules take deps as args; the router takes a `Services` (`src/services.ts`) so tests stub them. `globalThis.fetch` inside a module makes it unstubbable.
- **Validate only at the seams.** zod parses untrusted JSON (R2 reads, OpenAI/Anthropic responses, request bodies). Inside the worker, types are trusted — except `ManifestSchema.parse` on R2 reads (guards on-disk schema drift).
- **Failures land on the manifest, not the response.** `processReading` writes `status: "failed"` with a structured `error` block. The by-url pointer is written only on success, so failed URLs stay re-submittable.
- **Maintain `index/list.json` on every terminal write.** `POST /readings` writes the pending entry; `processReading` (success and `markFailed`) replaces it via `appendOrReplaceListIndexItem` (idempotent on `id`). Never write a per-id manifest without updating the index, or list/search go stale.
- **Don't drift from the manifest schema.** `Manifest` and `EmitReadingToolInput` are the cross-module contracts; the SPA hand-mirrors them in `web/src/types.ts` — update in lockstep with `src/schemas/manifest.ts`.
- **TDD by default**; comments explain *why*, not *what*.

## Easy to get wrong

- **Never add the Vectorize or Queue binding to `wrangler.test.toml`** — Miniflare hangs starting a Vectorize stub. Inject fakes per-test: `installVectorizeStub()` / `installQueueStub()` + `drainQueue()` in `test/integration/readings.test.ts`. Tests that must observe a still-pending state (e.g. the 409 active-attempt guard) must NOT drain between requests — only at the end.
- **`processReading` runs in the queue consumer, not `ctx.waitUntil()`.** POST writes a pending manifest, sends a `ProcessReadingArgs` message, returns 202; `src/index.ts:queue` branches on `batch.queue` — the main `reading-lite` queue dispatches each message to `dispatchQueueMessage`, the `reading-lite-dlq` dead-letter queue to `handleDeadLetter`. On success or non-rate-limit failure it acks (the failed manifest is already written; reprocess is the recovery path). On `RateLimitedError` it calls `msg.retry({ delaySeconds })` (`e.retryAfterMs` clamped 1–43200s, else 30→60→120→300s) and leaves the manifest pending until a later delivery completes or `PENDING_TTL_SECONDS` flips it stale. A message that exhausts `max_retries` (upstream stayed rate-limited past the budget) routes to the DLQ instead of vanishing; `markDeadLettered` flips its manifest to a retryable `failed` (reusing `markFailed`, so a previously-`ready` reading rolls back to its preserved snapshot) so the strand stays visible and re-submittable. Bulk recovery should pace submissions (`corpus-recover --wave`). Tests drive this with `installQueueStub()` + `drainQueue()`.
- **Prompt cache is a prefix match.** The `emit_reading` tool def + system prompt are the cacheable prefix (`cache_control` on the last system block; render order `tools → system → messages`); per-request content (markdown, similar readings, URL) goes in the user message. Any byte change in the prefix invalidates everything after it. `buildSummarizeRequestBody` (`src/modules/anthropic`) is the single source of that body — both `summarizeReading` (realtime) and the bulk batch path call it, so the prefix stays byte-identical and the cache is shared across a batch. A snapshot test (`test/unit/anthropic`) guards the prefix; don't edit the body in only one path.
- **Bulk path is a separate Node CLI, not the worker.** `corpus-recover --batch` summarizes a backlog through the Anthropic **Message Batches API** (~50% cheaper, no rate-limit burst) — `scripts/corpus-lib/batch/` (prepare→extract→similar→submit→poll→write, orchestrated by `run.ts`). It writes R2/Vectorize from Node via the shared S3/REST clients (`scripts/lib/cf-clients.ts`, the same pattern as `migrate.ts`) and **reuses the worker's terminal-write contract**: by-url pointer only on success, `index/list.json` merged on every terminal write, failed readings stay re-submittable, a previously-`ready` reading rolls forward to its preserved snapshot on failure. Embeddings stay realtime (coalesced via OpenAI array input). An in-flight batch is journaled to `<index>.batch.json`; a re-run **resumes** (polls + writes) rather than re-submitting, so the summarize step is never double-billed. The interactive submit/poll path is untouched.
- **429s throw `RateLimitedError` and are not retried in-process** so the queue reschedules and frees the slot rather than sleeping; 5xx + network failures do retry with backoff + jitter via `fetchWithRetry`. `RetryDeps` come from `RETRY_*` env vars.
- **Turndown's internal DOMParser needs a `document`, absent in Workers** — pass linkedom's parsed `<body>` directly.
- **Embedding dimension is locked to 1536** (Backlite rows used OpenAI `text-embedding-3-small`). Switching to a 768-dim model needs a full re-embed + a fresh Vectorize index.
- **`writeByUrlPointer({ ifNotExists })` uses a `head()` guard**, not R2 `onlyIf` — etag conditional-write semantics vary by binding version.
- **Don't remove `nodejs_compat`** — linkedom, readability, and better-sqlite3 (scripts) all need it.
- **`test/env.d.ts` is load-bearing** — it extends `Env` from `src/index.ts` so `cloudflare:test`'s `env` is fully typed. Node-pool tests (importing `node:fs`/`os`/`path`) go under the node project's glob (e.g. `test/unit/migrate/`).

## Not yet done

- Migration script not run end-to-end against a real Backlite snapshot (unit-tested; the SigV4 path is exercised only in prod-shaped config).
- SPA polling for `pending` manifests (manual refresh works for v1).

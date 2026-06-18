# CLAUDE.md — `reading-lite`

Personal reading service on Cloudflare Workers + a small React SPA at `web/`. POST a URL → message goes onto a Cloudflare Queue (`READING_JOBS`) → consumer runs `processReading` (`max_concurrency = 3`) → Claude summarizes once via forced tool use → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the TL;DR embedding → poll `GET /readings/:id` until ready. The SPA consumes the same routes for list/search/submit/detail.

For the user-facing pitch, see `README.md`. Original design intent: `plans/000-re-design.md` and PRD at `plans/001-prd-reading-lite.md` (issue #1). SPA + list-filter follow-up: PRD on issue #3.

## Architecture

## Key components and their contracts

**`extractor.extractFromUrl(url, deps)`** — `deps = { fetch, timeoutMs, maxBytes }`. HTML goes through linkedom → Readability → Turndown; passes the parsed `<body>` directly into Turndown to bypass its DOMParser (no `document` global in Workers). Plain text and JSON are captured as markdown; PDFs and unknown types are stored raw.

**`embeddings.embed(input, deps)`** — `deps = { fetch, apiKey, retry? }`. Wraps OpenAI `text-embedding-3-small`. Validates response shape via zod (must be 1536-dim). When `retry` is supplied, the request goes through `fetchWithRetry`.

**`anthropic.summarizeReading(input, deps)`** — `deps = { fetch, apiKey, model, retry? }`. One-shot call to `messages.create` with one tool (`emit_reading`) and `tool_choice` forcing it. The tool definition + system prompt are the cacheable prefix; `cache_control: {type: "ephemeral"}` sits on the last system block (caches tools+system together since render order is `tools → system → messages`). Volatile content (extracted markdown + similar-readings context + URL) is in the user message, after the cache breakpoint.

**`http-retry.fetchWithRetry(fetch, input, init, deps)`** — `deps = { sleep, maxAttempts, baseDelayMs, maxDelayMs, random?, now? }`. Retries 5xx + network rejections with exponential backoff + full jitter. **429s do not retry in-process** — they throw `RateLimitedError` (carrying `retryAfterMs` from the upstream's `Retry-After` header) so the queue handler can `msg.retry({ delaySeconds })` and free its concurrency slot rather than sleeping. Other 4xx returns immediately. After `maxAttempts` returns the last 5xx response so the caller's typed `!ok` branch still throws with the final status. `process-reading.ts` builds a single `RetryDeps` from `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS` env vars and threads it into `embed` + `summarizeReading`.

**`stores.ReadingStore`** — wraps an `R2Bucket` binding. Keys live under `readings/YYYY/MM/DDTHHMMSSZ-{id}/`

**`stores.SimilarityStore`** — wraps a `VectorizeIndex` binding. 

**`router.createApp({services})`** — Hono app exposing all eight routes.

**`src/index.ts:queue(batch, env)`** — Cloudflare Queue consumer for the `reading-lite` queue. Delegates each message to `dispatchQueueMessage(msg, processFn)`. On success or non-rate-limit failure, the dispatcher acks: `processReading` writes a failed manifest before throwing, so re-delivery would just repeat the same upstream error; the reprocess script is the recovery path. On `RateLimitedError`, the dispatcher calls `msg.retry({ delaySeconds })` using `e.retryAfterMs` (clamped 1-43200) or an attempts-based exponential default (30s → 60s → 120s, capped at 300s) and the manifest stays `pending+running` until a future delivery completes or `PENDING_TTL_SECONDS` flips it stale.

## Conventions worth following

- **Inject dependencies, don't pull from globals.** Every module that touches the network takes `fetch` as a constructor arg / dep. The router takes a `Services` (in `src/services.ts`) so tests stub `fetch` / `now` / `newId`. Don't reach for `globalThis.fetch` inside a module — it makes the module unstubbable.
- **Validate at the seams.** zod parses untrusted JSON (R2 reads, OpenAI/Anthropic responses, request bodies). Inside the worker, types are typed; we don't re-validate. The exception is `ManifestSchema.parse` on R2 reads — guards against schema drift on disk.
- **Failures land on the manifest, not in the response.** `processReading` writes `status: "failed"` with a structured `error` block instead of throwing into the void. The by-url pointer is only written on success, so failed URLs stay re-submittable.
- **No comments explaining what.** The code says what. Comments explain *why* — usually a hidden constraint (e.g. "turndown's internal DOMParser needs `document`, which doesn't exist in Workers; pass linkedom's parsed body directly").
- **Prefer adding a test next to a fix.** TDD is the default — write the failing test first, then implement. Existing tests live alongside their module under `test/unit/<module>/` and integration tests under `test/integration/`.
- **Don't drift from the manifest schema.** `Manifest` and `EmitReadingToolInput` are the cross-module contracts. If you change them, run all tests — the breakage tells you who depends on what. The SPA carries its own hand-typed mirror at `web/src/types.ts`; update it in lockstep with `src/schemas/manifest.ts`.
- **Maintain `index/list.json` on every terminal write.** `POST /readings` writes a pending entry; `processReading` (success and `markFailed`) replaces it. The `appendOrReplaceListIndexItem(item)` helper is idempotent on `id`. Don't write the per-id manifest without also updating the index, or list/search results will go stale.

## Test strategy

`npm test` runs a Vitest workspace with two projects:

- **workers** (`@cloudflare/vitest-pool-workers`): schemas, deep modules, R2 store, integration tests against the Hono router via Miniflare's R2 binding. The test config is `wrangler.test.toml` (R2 only). Vectorize is not natively emulated by Miniflare — each test that needs it overwrites `env.READINGS_INDEX` with a hand-rolled stub. The integration tests' `installVectorizeStub()` is the canonical pattern.
- **node**: migration script tests use `node:fs`/`node:os`/`node:path` and write fixture files into a real temp dir.

Live Anthropic / OpenAI / Vectorize calls are stubbed everywhere. The integration tests dispatch by URL prefix in a single `vi.fn<typeof fetch>(...)` to keep the wiring legible.

## Things that are easy to get wrong

- **Adding the Vectorize binding to `wrangler.test.toml` will hang the test runtime.** Miniflare's runtime errors out trying to start a Vectorize stub; we omit the binding from the test config and inject a fake `VectorizeIndex` per-test instead. If a new test needs Vectorize, copy the stub pattern from `test/integration/readings.test.ts:installVectorizeStub`.
- **Same applies to the Queue binding.** `READING_JOBS` is also stubbed per-test via `installQueueStub()` in `test/integration/readings.test.ts`. The stub captures `send()` calls into a `queuedJobs` array; tests then call `await drainQueue(services)` to run the consumer logic (`processReading` per message) at the asserted moment. Tests that need to observe a still-pending state between submit and consume (e.g., the 409 active-attempt guard) must NOT drain between requests — only at the end. Don't add the queue binding to `wrangler.test.toml`; same lesson as Vectorize.
- **Embedding dimension is locked to 1536** because migrated rows from Backlite were embedded with OpenAI `text-embedding-3-small`. Don't switch to Workers AI `bge-base-en` (768) without also re-embedding every existing reading and creating a fresh Vectorize index.
- **Don't try to interpolate dynamic content into the system prompt.** Caching is a prefix match — any byte change anywhere in the prefix invalidates everything after it. The system prompt + tool definition are the cacheable prefix; per-request content goes in the user message. (See `shared/prompt-caching.md` if you've loaded the `claude-api` skill.)
- **The `test/env.d.ts` augmentation is load-bearing.** Without it, `cloudflare:test`'s `env` is typed as a stripped-down `ProvidedEnv` and the tests fail to compile. Updating `Env` in `src/index.ts` is enough — the `.d.ts` extends from there.
- **R2's `etag-based conditional write` semantics vary by binding version.** `writeByUrlPointer({ifNotExists: true})` uses a `head()` guard instead of relying on `onlyIf`. Stick with that pattern.
- **`processReading` runs in the queue consumer, not in `ctx.waitUntil()`.** Production: POST `/readings` writes a pending manifest, sends a `ProcessReadingArgs` message, returns 202. The CF queue consumer (`max_concurrency = 3`, see `wrangler.toml`) calls `processReading` later. Tests drive this via `installQueueStub()` + `drainQueue(services)` — the latter mimics the consumer by calling `processReading` once per captured message against the test's `services`. `waitOnExecutionContext(ctx)` is still called as a no-op safety, but the actual processing happens during `drainQueue`.
- **Don't downgrade or remove the `nodejs_compat` flag** — `linkedom`, `readability`, and `better-sqlite3` (script-side) all rely on it.
- **Migration tests run in the node project, not workers.** If you add a test that imports `node:fs` / `os` / `path`, put it under `test/unit/migrate/` (or expand the node project's `include` glob in `vitest.workspace.ts`).

## What's not yet done

- The migration script has not been run end-to-end against a real Backlite snapshot. The unit tests cover the row-mapping + per-row migration logic; the SigV4 path is exercised only in production-shaped configurations.
- SPA polling for `pending` manifests (manual refresh works for v1).
- Concurrent-write etag retry loop on `index/list.json` — last-writer-wins for personal scale; mitigation deferred.

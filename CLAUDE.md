# CLAUDE.md — `reading-lite`

Personal reading service on Cloudflare Workers + a small React SPA at `web/`. POST a URL → Claude summarizes it once via forced tool use → R2 stores the manifest + raw + extracted markdown → Vectorize indexes the TL;DR embedding → poll `GET /readings/:id` until ready. The SPA consumes the same routes for list/search/submit/detail.

For the user-facing pitch, see `README.md`. Original design intent: `plans/000-re-design.md` and PRD at `plans/001-prd-reading-lite.md` (issue #1). SPA + list-filter follow-up: PRD on issue #3.

## Architecture in one paragraph

`POST /readings` writes a `pending` manifest, returns 202 immediately, and runs the heavy work in `ctx.waitUntil()`: fetch the URL → `linkedom + readability + turndown` → OpenAI `text-embedding-3-small` over the extracted text → Vectorize top-K query for similar context → Anthropic `messages.create` with `tool_choice: {type: "tool", name: "emit_reading"}` → embed the final TL;DR → Vectorize upsert → R2 write the final manifest + by-url pointer. On any failure, write a `failed` manifest and skip the by-url pointer (so the URL stays re-submittable).

The Worker entry is thin. Real logic lives in four deep modules under `src/modules/`, each unit-tested with stubbed `fetch` / bindings.

## Repo layout

```
src/
  index.ts                    # default export (fetch handler) + Env types
  router.ts                   # Hono app; createApp({services}) for DI in tests
  middleware.ts               # bearer auth (timing-safe) + CORS allowlist
  process-reading.ts          # ctx.waitUntil() orchestration; failure path
  services.ts                 # Services interface (fetch / now / newId), default impl, sha256Hex, mintReadingId
  schemas/
    manifest.ts               # Manifest + EmitReadingToolInput + ByUrlPointer (zod)
    api.ts                    # POST/GET request + response shapes (zod), EMBEDDING_DIM=1536
  modules/
    extractor/                # fetchBounded + linkedom + readability + turndown
    embeddings/               # OpenAI text-embedding-3-small
    anthropic/                # forced tool use + prompt caching
    stores/
      reading-store.ts        # R2: manifest / raw / extracted / by-url + by-id pointers / list
      similarity-store.ts     # Vectorize: upsert + query
scripts/
  migrate.ts                  # CLI entry — node-side, better-sqlite3 + aws4fetch
  migrate-lib/{plan,run,clients}.ts
  import-bookmarks.ts         # CLI entry — Chrome bookmark HTML → POST /readings
  import-bookmarks-lib/{parse,select,submit,index-store,confirm}.ts
test/
  integration/                # workers pool — Hono router via Miniflare
  unit/{schemas,extractor,embeddings,anthropic,stores}/  # workers pool
  unit/migrate/               # node pool (fs/os/path)
  unit/import-bookmarks/      # node pool
  env.d.ts                    # augments cloudflare:test ProvidedEnv with Env
web/                          # React SPA (separate npm project; cd web && npm install)
  src/{App.tsx, App.test.tsx, api.ts, types.ts, main.tsx, styles.css, test/setup.ts}
  index.html, package.json, tsconfig.json, vite.config.ts
plans/
  000-re-design.md            # original design memo
  001-prd-reading-lite.md     # PRD (filed as #1)
wrangler.toml                 # production: R2 + Vectorize bindings
wrangler.test.toml            # test: R2 only (Vectorize is stub-injected)
vitest.workspace.ts           # two projects: "workers" + "node"
```

## Key components and their contracts

**`extractor.extractFromUrl(url, deps)`** — `deps = { fetch, timeoutMs, maxBytes }`. Returns `{ raw, content_type, content_status, content_bytes, content_sha256, markdown?, title? }`. Throws `FetchTimeoutError` / `OversizedResponseError` / `BadStatusError`. HTML goes through linkedom → Readability → Turndown; passes the parsed `<body>` directly into Turndown to bypass its DOMParser (no `document` global in Workers). Plain text and JSON are captured as markdown; PDFs and unknown types are stored raw.

**`embeddings.embed(input, deps)`** — `deps = { fetch, apiKey }`. Wraps OpenAI `text-embedding-3-small`. Validates response shape via zod (must be 1536-dim). Throws `OpenAIError` / `BadEmbeddingResponseError`.

**`anthropic.summarizeReading(input, deps)`** — one-shot call to `messages.create` with one tool (`emit_reading`) and `tool_choice` forcing it. The tool definition + system prompt are the cacheable prefix; `cache_control: {type: "ephemeral"}` sits on the last system block (caches tools+system together since render order is `tools → system → messages`). Volatile content (extracted markdown + similar-readings context + URL) is in the user message, after the cache breakpoint. Returns `{ reading, usage }`. Errors: `AnthropicError`, `NoToolUseError`, `BadToolInputError`.

**`stores.ReadingStore`** — wraps an `R2Bucket` binding. Keys live under `readings/YYYY/MM/DDTHHMMSSZ-{id}/` so ascending lex order matches chronological order. Methods: `writeManifest` / `readManifest` (zod-validated on read), `writeRaw` / `readRaw`, `writeExtracted` / `readExtracted`, `writeByUrlPointer` (with `ifNotExists` → `PointerExistsError`) / `readByUrlPointer`, `writeByIdPointer` / `readByIdPointer`, `readListIndex` / `writeListIndex` / `appendOrReplaceListIndexItem`, `listManifests({q?, tag?, offset, limit})` (filters in-memory against `index/list.json`; falls back to scan-and-rebuild on cold cache). `buildKeyPrefix(id, createdAtIso)` is the key generator. `manifestToIndexItem(manifest, keyPrefix)` projects the index summary used by the list path.

**`stores.SimilarityStore`** — wraps a `VectorizeIndex` binding. `upsert(id, embedding, metadata)` and `query(embedding, topK)`. Validates 1536-dim before calling the binding; clamps `topK` to `[1, 50]`.

**`router.createApp({services})`** — Hono app exposing all eight routes. Test code constructs the app with stubbed services (mock fetch, deterministic `now` and `newId`); production calls the no-arg form. Bearer auth on every route except `/health`. CORS allowlist via env `CORS_ALLOWED_ORIGINS`.

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
- **Embedding dimension is locked to 1536** because migrated rows from Backlite were embedded with OpenAI `text-embedding-3-small`. Don't switch to Workers AI `bge-base-en` (768) without also re-embedding every existing reading and creating a fresh Vectorize index.
- **Don't try to interpolate dynamic content into the system prompt.** Caching is a prefix match — any byte change anywhere in the prefix invalidates everything after it. The system prompt + tool definition are the cacheable prefix; per-request content goes in the user message. (See `shared/prompt-caching.md` if you've loaded the `claude-api` skill.)
- **The `test/env.d.ts` augmentation is load-bearing.** Without it, `cloudflare:test`'s `env` is typed as a stripped-down `ProvidedEnv` and the tests fail to compile. Updating `Env` in `src/index.ts` is enough — the `.d.ts` extends from there.
- **R2's `etag-based conditional write` semantics vary by binding version.** `writeByUrlPointer({ifNotExists: true})` uses a `head()` guard instead of relying on `onlyIf`. Stick with that pattern.
- **`processReading` runs in `ctx.waitUntil()`, so test it through the worker, not by calling the function directly.** The integration tests use `createExecutionContext()` + `waitOnExecutionContext(ctx)` to drain background work before asserting on R2 state.
- **Don't downgrade or remove the `nodejs_compat` flag** — `linkedom`, `readability`, and `better-sqlite3` (script-side) all rely on it.
- **Migration tests run in the node project, not workers.** If you add a test that imports `node:fs` / `os` / `path`, put it under `test/unit/migrate/` (or expand the node project's `include` glob in `vitest.workspace.ts`).

## Common commands

```sh
npm install              # one-time (root)
npm run dev              # wrangler dev (needs .dev.vars + staging R2/Vectorize via remote=true; local-only)
npm test                 # vitest workspace, all worker + migration tests
npm test -- <pattern>    # run a subset, e.g. "test/unit/extractor"
npm run typecheck        # tsc --noEmit
npm run deploy           # worker deploy; dry-run by default. --execute to upload
npm run deploy:web       # SPA → Cloudflare Pages; dry-run by default. --execute to upload
npm run migrate -- ...   # one-shot migration; --dry-run to preview ops
npm run import-bookmarks -- --file <chrome-export.html> [--folder <path>] [--dry-run] [--quick]
                         # ingest a Chrome bookmark export folder; default folder is "Computing".
                         # interactive (Y/n/q per URL) by default; --quick fires everything in parallel.

# SPA (separate project)
cd web && npm install    # one-time
cd web && npm run dev    # vite on :5173, proxies /readings + /health to :8787
cd web && npm test       # vitest with jsdom
cd web && npm run build  # tsc -b && vite build → dist/
```

## What's not yet done

- Manual smoke against a real Cloudflare account (R2 + Vectorize). Per the PRD's verification plan, this is the next step.
- The migration script has not been run end-to-end against a real Backlite snapshot. The unit tests cover the row-mapping + per-row migration logic; the SigV4 path is exercised only in production-shaped configurations.
- SPA polling for `pending` manifests (manual refresh works for v1).
- Concurrent-write etag retry loop on `index/list.json` — last-writer-wins for personal scale; mitigation deferred.

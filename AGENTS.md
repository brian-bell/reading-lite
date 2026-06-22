# AGENTS.md - reading-lite

Personal reading service on Cloudflare Workers plus a React SPA in `web/`.
Submitting a URL writes an eager by-url ownership claim, stores a pending
manifest in R2, sends a `READING_JOBS` queue message, and returns a pollable
reading id. The queue consumer runs `processReading`, extracts source content,
embeds it with OpenAI, queries Vectorize for similar readings, summarizes once
with Anthropic forced tool use (`emit_reading`), writes the terminal manifest
and `index/list.json`, and optionally sends a Resend email.

`README.md` is the user-facing architecture and operations guide. This file is
agent context: current commands, module map, conventions, and gotchas.

## Project Layout

- `src/index.ts` exports the Worker fetch and queue handlers. The main queue
  dispatches to `processReading`; the DLQ dispatches to `markDeadLettered`.
- `src/router.ts` owns the HTTP API, auth-protected `/readings*` routes,
  idempotent submit/import/reprocess behavior, lookup, diagnostics, and content
  streaming. After claiming the by-url slot it delegates the eager write +
  enqueue to `activateAttempt`.
- `src/attempt-activation.ts` owns `activateAttempt`, the single home for the
  eager write-and-enqueue ordering (artifacts → manifest → by-id pointer → list
  index → queue message) plus the rollback-to-failed funnel shared by submit,
  reprocess, and both markdown-import paths. It is the activation mirror of
  `commitTerminalManifest` on the terminal-write side.
- `src/process-reading.ts` owns the background processing pipeline, attempt
  logging, terminal manifest commits, email logging, and failure handling.
- `src/reading-visibility.ts` owns `ReadingVisibility`, the single home for the
  list-row + Vectorize-vector lockstep and the owner gate that protects it. It
  exposes `publish` / `remove` / `restoreIfOwner`; `commitTerminalManifest`
  decides which verb to call and the module enforces the list+vector pairing
  (list-only when `similarity` is null — the success/failure asymmetry). It is
  the terminal-side mirror of `activateAttempt` on the activation side.
- `src/attempt-ownership.ts` is the neutral low layer both `process-reading.ts`
  and `reading-visibility.ts` sit above: it owns `attemptOwnership` (the single
  active/last/pending ownership verdict the five gates share), its
  `resolveAttemptId` (`attemptId ?? at_${id}`) helper, and the
  `ProcessReadingArgs` / `ProcessReadingSource` args shape they both read.
  Homing it below both keeps the dependency graph acyclic
  (`process-reading.ts → reading-visibility.ts → attempt-ownership.ts`, no
  back-edge); `process-reading.ts` re-exports the args types for its callers.
- `src/modules/reading-claim.ts` resolves URL ownership through
  `index/by-url/{sha256(url)}` pointers.
- `src/modules/staleness.ts` owns the read-time stale-annotation rule
  (`stalenessOf`): a `running` attempt or `pending` record past TTL surfaces as
  `failed` without a write. `router.ts`'s `annotateStale` /
  `annotateStaleIndexItem` are thin adapters over it.
- `src/modules/stores/reading-store.ts` wraps the thin R2 codecs — manifests,
  raw/extracted content, by-id/by-url pointers, attempts, and diagnostics. It
  composes a `ListIndexStore` and delegates its public list-index methods to it,
  so existing `reader.appendOrReplaceListIndexItem(...)` / `findManifestByUrl`
  / `listManifests` call sites are unchanged.
- `src/modules/stores/list-index.ts` owns `ListIndexStore`, the `index/list.json`
  subsystem: the optimistic-concurrency CAS mutate loop (jittered backoff), the
  q/tag filter+sort+paginate read path, URL-ownership resolution (the
  ready>pending>failed `OWNERSHIP_RANK` then recency), the full-bucket `rebuild`
  fallback, and `manifestToIndexItem`. It reads manifests directly (no back-edge
  to `ReadingStore`); reading-store.ts imports the shared R2-layout constants
  (`MANIFEST_FILE`, `READINGS_PREFIX`) from here to keep the layout single-homed.
- `src/modules/stores/similarity-store.ts` wraps Vectorize query/upsert/delete.
- `src/modules/extractor`, `embeddings`, `anthropic`, `email`, and
  `http-retry` isolate upstream integrations.
- `src/schemas` contains zod API and manifest contracts. `web/src/types.ts`
  hand-mirrors the Worker manifest/list/diagnostics types.
- `scripts/` contains operator CLIs for deploys, staging lifecycle, corpus
  audit/recovery/drop, imports, and manual smoke tests.
- `web/` is the React/Vite SPA. It stores the bearer token in localStorage,
  lists/searches readings, submits URLs, shows details/diagnostics, opens
  authed content blobs, and can start reprocesses.
- `plans/` contains PRDs, implementation plans, and manual verification
  handoffs. Treat these as historical or task-specific unless a user names one.

## Commands

Root Worker:

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
npm test
npm run typecheck
```

Web SPA:

```sh
cd web
npm install
npm run dev
npm test
npm run build
```

Deploy and staging helpers are dry-run by default:

```sh
npm run deploy -- --env staging
npm run deploy -- --env staging --execute
npm run deploy -- --env production
npm run deploy -- --env production --execute
npm run deploy:web -- --branch staging
npm run deploy:web -- --branch staging --execute
npm run staging:setup
npm run staging:setup -- --execute
npm run staging:teardown
npm run staging:teardown -- --execute
```

Make targets wrap the same scripts:

```sh
make deploy-worker ENV=stg EXECUTE=1
make deploy-worker ENV=prd EXECUTE=1
make deploy-web ENV=stg EXECUTE=1
make deploy-web ENV=prd EXECUTE=1
make staging-setup EXECUTE=1
make staging-teardown EXECUTE=1
```

Corpus/import tools:

```sh
npm run import-bookmarks -- --file ~/Downloads/bookmarks.html
npm run import-markdown -- --dir ~/Documents/articles --dry-run
npm run corpus-audit -- --bucket reading-lite-staging
npm run corpus-drop -- "$URL" --bucket reading-lite-staging --allow-ready --vectorize reading-lite-staging --execute
npm run corpus-recover -- --index ./index.json --execute --monitor
```

## Environments

- Local `wrangler dev` uses `wrangler.toml` top-level bindings with Worker name
  `reading-lite-dev` and a local Miniflare-emulated R2 bucket. It intentionally
  has no Queue or Vectorize binding, so submissions/reprocesses return a clear
  503 and similarity search returns no results locally.
- Staging uses `[env.staging]` with isolated `reading-lite-staging` Worker,
  R2 bucket, Vectorize index, Queue, and DLQ. `staging:setup` and
  `staging:teardown` are idempotent and hard-coded to staging resource names.
  Teardown removes queue consumers before deleting the Worker, empties the R2
  bucket through the S3-compatible API, then deletes the bucket.
- Production uses `[env.production]`, Worker name `reading-lite`, R2 bucket
  `reading-lite`, Vectorize index `reading-lite`, and Worker routes scoped to
  `reading-lite.bbell.dev/readings*` and `/health`; Cloudflare Pages serves the
  SPA for other paths.
- Secrets are managed outside deploy scripts with `wrangler secret put --env
  staging|production`. Required Worker secrets: `READER_API_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and optionally `RESEND_API_KEY`.
- Staging teardown R2 emptying additionally needs `CORPUS_R2_ACCOUNT_ID`,
  `CORPUS_R2_ACCESS_KEY`, and `CORPUS_R2_SECRET_KEY` in env or `.corpus.vars`.

## Conventions

- Use TDD by default. Tests should exercise public behavior, not internal
  implementation shape.
- Inject `fetch`, `now`, and `newId`; do not reach for globals in modules. The
  router accepts `Services` from `src/services.ts` so tests can stub behavior.
- Validate only at seams. zod parses request bodies, R2 reads, and upstream API
  responses. Inside the Worker, trust typed values except for manifest reads
  from R2, which are parsed to guard stored-schema drift.
- Keep by-url ownership eager. `POST /readings` and markdown import claim the
  URL slot before queueing work. Ready/pending owners return the existing
  manifest; failed owners reprocess in place. Markdown import over a visible
  pending owner is expected to return `200` with the same pending manifest/id.
- Keep `index/list.json` in sync on every terminal write. List/search behavior
  depends on it, and writes should use existing `ReadingStore` helpers rather
  than direct object manipulation.
- Keep manifest contracts synchronized. Update `src/schemas/manifest.ts`,
  `src/schemas/api.ts`, tests, and `web/src/types.ts` together when fields
  change.
- Preserve the Anthropic prompt-cache prefix. `buildSummarizeRequestBody` in
  `src/modules/anthropic` is shared by realtime processing and the batch path;
  snapshot tests guard the cacheable prefix.
- Keep embedding vectors at 1536 dimensions unless you are intentionally
  planning a full re-embed and fresh Vectorize index.

## Testing Notes

- `vitest.workspace.ts` splits Workers-pool tests from Node-pool tests. Tests
  that import Node built-ins belong under the Node project globs.
- `wrangler.test.toml` deliberately omits Queue and Vectorize bindings.
  Integration tests inject fakes such as `installQueueStub()` and
  `installVectorizeStub()` from `test/integration/readings.test.ts`.
- Tests that need to observe an active pending state must not drain the queue
  between requests; drain only after the assertion.
- `test/env.d.ts` is load-bearing because it extends `Env` for
  `cloudflare:test` typing.
- Full root verification is `npm test` and `npm run typecheck`. SPA
  verification is `cd web && npm test` and `cd web && npm run build`.
- The Workers pool emits high-volume stderr/stdout noise (`CODE_MOVED`, the
  `MF-Vitest-Source` non-ASCII byte dumps, `[vpw:debug]`/`[vpw:info]` logs).
  Prefer `npm run test:quiet` over `npm test` to keep logs small — it wraps
  vitest (`scripts/test-quiet.mjs`), strips only those known-noise lines, and
  preserves vitest's exit code and all real failure output. Pass filters with
  `npm run test:quiet -- <path>`. CI still runs the canonical `npm test`.

## Operational Gotchas

- `processReading` runs in the queue consumer, not `ctx.waitUntil()`. A
  `RateLimitedError` calls `msg.retry({ delaySeconds })` and leaves the
  manifest pending until a later delivery succeeds or the pending TTL annotates
  it stale. Non-rate-limit processing errors write a failed manifest and ack.
- Messages that exhaust main-queue retries route to the DLQ, where
  `markDeadLettered` converts the stranded attempt to retryable `failed` and
  acks terminally.
- Read-only `GET /readings/lookup` must stay side-effect-free. It must not
  claim cold legacy pointers, repair damaged pointers, deep-scan R2, or write.
- `Readability`/Turndown can throw on pathological HTML. The extractor has a
  raw-DOM salvage path for throws, but deliberate "no article" verdicts still
  degrade to `raw_only`.
- Reddit thread/comment URLs can't be fetched from the worker — datacenter
  egress gets an HTML bot-challenge from `www.reddit.com/*.json`. The extractor
  detects Reddit URLs (`isRedditThreadUrl`) and throws `RedditManualImportError`
  so the reading lands `failed` with guidance instead of capturing the challenge
  page. Add Reddit threads with the **`reddit-import`** skill, which drives a
  logged-in Chrome session (via `chrome-devtools-mcp`) to fetch the public
  `<thread>.json`, renders it with the shared `redditListingToMarkdown` parser,
  and imports the markdown (`scripts/reddit-import.ts` → `/readings/import-markdown`).
  No Reddit app / OAuth credentials are involved. corpus-recover routes Reddit
  rows to `skip` for the same reason — recover them with the skill.
- YouTube watch pages are JS shells with no article body, so the extractor
  special-cases them in-worker (`src/modules/extractor/youtube.ts`). It detects
  watch/`youtu.be`/`shorts`/`live`/`embed` URLs (`isYoutubeWatchUrl`) and builds
  markdown in tiers: the public oEmbed endpoint is the required floor (title +
  author; a 429 here surfaces `RateLimitedError` so the queue retries), while the
  watch-page description (scraped from `ytInitialPlayerResponse`) and the
  timedtext transcript are best-effort enrichment that degrade to the floor on
  any error rather than fail the reading. Transcript fetches are host-checked to
  YouTube origins. A YouTube URL reprocesses to `ready` in-worker, so
  corpus-recover routes failed YouTube rows by their actual error (no longer a
  hard `skip`). In practice the worker usually lands the floor only (datacenter
  egress is blocked from the watch page, and timedtext is token-gated), so for a
  full extraction — description + transcript — use the **`youtube-import`** skill,
  which fetches the watch page from a residential IP and runs `yt-dlp` for the
  transcript, reusing the same `youtube.ts` parsers and importing via
  `/readings/import-markdown` (`scripts/youtube-import.ts`).
- Turndown's internal DOMParser needs a `document`, absent in Workers; pass
  linkedom's parsed body directly.
- Do not remove `nodejs_compat`; Worker dependencies and scripts rely on it.
- `corpus-recover --batch` is a Node-side bulk recovery path using Anthropic
  Message Batches plus R2/Vectorize clients. It resumes from
  `<index>.batch.json` and reuses the Worker terminal-write contract.
- The SPA currently invalidates queries after submit/reprocess but does not
  continuously poll pending manifests.

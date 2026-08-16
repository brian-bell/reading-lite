# AGENTS.md - reading-lite

Personal reading service on Cloudflare Workers plus a React SPA in `web/`.
Submitting a URL writes an eager by-url ownership claim, stores a pending
manifest in R2, sends a `READING_JOBS` queue message, and returns a pollable
reading id. The queue consumer runs `processReading`, extracts source content,
embeds it with OpenAI, queries Vectorize for similar readings, summarizes once
through the configured provider (OpenAI structured output by default; Anthropic
forced tool use when selected), writes the terminal manifest and
`index/list.json`, and optionally sends a Resend email. Provider selection never
falls back silently.

`README.md` is the user-facing architecture and operations guide. This file is
agent context: current commands, module map, conventions, and gotchas.

## Project Layout

- `src/index.ts` exports the Worker fetch and queue handlers. The main queue
  dispatches to `processReading`; the DLQ dispatches to `markDeadLettered`.
- `src/router.ts` owns the HTTP API, auth-protected `/api/readings*` routes,
  idempotent submit/import/reprocess behavior, lookup, diagnostics, and content
  streaming. After claiming the by-url slot it delegates the eager write +
  enqueue to `activateAttempt`. `enqueueReprocess` resolves the attempt's
  source as `request source ?? stored-markdown synthesis` — a reprocess body
  may carry `{source: {kind: "markdown", markdown, title?}}`, and when it does,
  `extracted.md` is never read.
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
- `src/modules/summarizer` owns provider selection, configuration parsing, and
  the normalized result/usage contract. `src/modules/openai-summarizer` owns the
  OpenAI Responses structured-output path; `src/modules/anthropic` owns the
  forced-tool Anthropic path. `extractor`, `embeddings`, `email`, and
  `http-retry` isolate the other upstream integrations.
- `src/schemas` contains zod API and manifest contracts. `web/src/types.ts`
  hand-mirrors the Worker manifest/list/diagnostics types.
- `scripts/` contains operator CLIs for deploys, staging lifecycle, corpus
  audit/recovery/drop, imports, and manual smoke tests.
- `scripts/corpus-lib/batch/` is the Node-side provider Batch API pipeline.
  `run.ts`'s `runBatchPipeline` is the shared tail (resume-guard → optional
  fresh payload preflight → similar → final payload validation + activation →
  submit+sidecar → poll → write) that both front-ends feed: `corpus-recover --batch` resolves audit rows via
  `prepare.ts` + `extract-phase.ts`, while
  `corpus-ingest` resolves a fresh markdown directory via
  `prepare-fresh-markdown.ts` (client-side by-url ownership + minted ids,
  bypassing extract-phase since the markdown is in hand) and `run-fresh-markdown.ts`.
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
  `reading-lite.bbell.dev/api/*` and `/health`; Cloudflare Pages serves the
  SPA for other paths.
- Secrets are managed outside deploy scripts with `wrangler secret put --env
  staging|production`. `READER_API_TOKEN` and `OPENAI_API_KEY` are always
  required; `ANTHROPIC_API_KEY` is required only when
  `SUMMARIZER_PROVIDER=anthropic`; `RESEND_API_KEY` is optional. Checked-in
  environments select OpenAI with `gpt-5.6-terra`; production uses `medium`
  reasoning effort while local and staging use `low`.
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
- Keep by-url ownership eager. `POST /api/readings` and markdown import claim the
  URL slot before queueing work. Ready/pending owners return the existing
  manifest; failed owners reprocess in place. Markdown import over a visible
  pending owner is expected to return `200` with the same pending manifest/id.
- Keep `index/list.json` in sync on every terminal write. List/search behavior
  depends on it, and writes should use existing `ReadingStore` helpers rather
  than direct object manipulation.
- Keep manifest contracts synchronized. Update `src/schemas/manifest.ts`,
  `src/schemas/api.ts`, tests, and `web/src/types.ts` together when fields
  change.
- Keep summarizer configuration fail-closed. OpenAI is always required for
  embeddings; require the selected summarizer's credential, reject invalid
  provider/effort values, and do not add implicit provider fallback.
- Preserve the Anthropic prompt-cache prefix. `buildSummarizeRequestBody` in
  `src/modules/anthropic` is shared by the Anthropic realtime and batch paths;
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
- A reprocess carrying a markdown `source` flips the reading's `source_type` to
  `"markdown"` only on a successful terminal write. After the flip every later
  no-source reprocess takes the stored-markdown synthesis instead of re-fetching
  the URL, which is the point (the URL is what degraded). Reprocess queue args
  snapshot `sourceTypeOnFailure`, so an unsuccessful attempt keeps its prior
  source type even when supplied Markdown fails before `write_extracted`; a
  failure on a *ready* reading additionally rolls back to
  `preserveReadyManifest`.
- Read-only `GET /api/readings/lookup` must stay side-effect-free. It must not
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
  and imports the markdown (`scripts/reddit-import.ts` → `/api/readings/import-markdown`).
  No Reddit app / OAuth credentials are involved. corpus-recover routes Reddit
  rows to `skip` for the same reason. The extract-agent's Reddit route
  (`scripts/extract-agent-lib/reddit.ts`) instead attempts one anonymous fetch
  of `<thread>.json?raw_json=1&limit=20&sort=top` (the skill's exact query;
  `raw_json=1` keeps Reddit from HTML-escaping entities) per manifest version
  through `safeFetch` + browser headers, parses with the shared
  `buildRedditImport`, and re-enters via import-markdown. A challenge
  (401/403/429 or served HTML) becomes a durable terminal `manual` sidecar
  outcome that stays in the run report's manual queue until the manifest moves
  — recover those with the skill.
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
  `/api/readings/import-markdown` (`scripts/youtube-import.ts`).
- Turndown's internal DOMParser needs a `document`, absent in Workers; pass
  linkedom's parsed body directly.
- Do not remove `nodejs_compat`; Worker dependencies and scripts rely on it.
- `corpus-recover --batch` is a Node-side bulk recovery path using the selected
  provider's Batch API (OpenAI by default, Anthropic optional) plus
  R2/Vectorize clients. It resumes from `<index>.batch.json` and reuses the
  Worker terminal-write contract. Version-2 sidecars pin provider, model,
  OpenAI reasoning effort, and a stable run id, so resume is independent of
  later environment changes and never falls back across providers. OpenAI
  upload/create phases are persisted and reconciled before creating another
  remote object after a crash. Like fresh ingest it eagerly claims by-url
  ownership before batch submit
  (`activateRecoverTargets` in `activation-phase.ts`, wired in `runBatch`), but
  for a recover target the slot is usually already held (realtime-failed readings
  own by-url; batch-failed ones don't), so the "claim" is really a **failed→pending
  flip**: it `putIfAbsent`s an unclaimed slot, proceeds idempotently without a
  write when the live pointer already equals `{id, key_prefix}`, and skips a
  damaged or foreign-owned pointer for operator repair rather than clobbering it.
  It then revalidates the live manifest is still this reading (id/url/url_hash,
  status-agnostic) and writes a pending manifest via `buildRecoverPendingManifest`
  — content descriptors from the fresh re-extract (else the live manifest), forced
  `content_status:"captured"` so a `markFailed`-zeroed manifest's descriptors never
  leak in. Unlike fresh ingest, recover sets **no** `releaseByUrlOnFailure`: a
  failed recover URL keeps its claim and stays re-submittable by both recover
  (resolves via `row.key_prefix`, pointer-independent) and the online reprocess
  path (`ownedManifestMatches` is status-agnostic). Mid-batch the slot is
  transiently `ready→pending` with a pending list row — benign under
  `--sole-writer`; `preserveReadyManifest` rolls a ready reading forward on
  failure. Recover activation does not mutate the original target object, but the
  activated target returned to submit carries the just-written pending manifest;
  submit-phase reads that manifest so same-run and crash-rerun failures can both
  see its nested `preserve_ready_manifest` snapshot. A post-create crash resumes
  `pollAndWrite` over the
  eager-claim pendings with no orphan, and an activating-window crash aborts (no
  batch id) for the operator to clear and re-run idempotently. On that rerun
  `extract-phase` reuses the `batch_<id>` activation pending's captured
  `extracted.md` rather than re-fetching, so a transiently-down source can't drop
  the reading and strand its eager claim.
- `corpus-ingest` (`npm run corpus-ingest -- --dir <path>`) is the markdown-in-hand
  bulk-import path: it feeds a fresh markdown directory into the same Message
  Batch pipeline as `corpus-recover --batch`, so resulting manifests are
  contract-compatible with the realtime `import-markdown` path (terminal fields
  match; like the recover-batch path it omits the `last_attempt` attempt log). It
  resolves by-url ownership client-side by `ReadingClaim`'s own rules (reusing its
  exported `ownedManifestMatches` / `isFreshMissingManifestPointer`): a pointer
  owns the URL only when its manifest matches (id + url + url_hash), so ready and
  pending owners skip while failed owners re-ingest in place; a fresh
  missing-manifest pointer is still-initializing and skipped; unclaimed URLs mint
  a new id; damaged or mismatched by-url pointers are skipped for operator repair
  rather than claimed over. When there is no live
  by-url pointer it first runs the cold-legacy lookup (`findByUrlInList` in
  `r2-reads.ts`, mirroring the Worker's `findManifestByUrl`): a prior legacy
  failed ingest may have a by-id pointer + list row but no by-url pointer, so a
  rerun resolves that failed reading through `index/list.json` (ready>pending>failed
  rank then recency) and re-ingests it in place rather than minting a duplicate.
  Pending owners are skipped
  even past PENDING_TTL_SECONDS — unlike the Worker, this offline path can't
  claim/supersede an in-flight queue attempt, so re-ingesting a stale pending could
  race the worker and (on a batch failure, which carries no preserved-ready
  snapshot) clobber a just-ready manifest; stranded pendings heal via the API or
  corpus-recover. Before fresh eager activation writes, `runBatchPipeline`
  preflights the extracted-only summarization payload, resolves similar-reading
  context, then validates the final provider request. OpenAI JSONL is measured
  as exact UTF-8 bytes and capped at 50,000 requests and 190 MB; Anthropic uses
  the existing 200 MB safety cap. An oversized run fails with `--limit`
  guidance without leaving pending owners behind. Fresh ingest then eagerly writes a
  pending manifest, by-id pointer, by-url pointer, and list row before Message
  Batch creation.
  `write-phase` writes the by-id pointer on both the success and failure branches
  (a fresh-ingest failure must still be reachable via detail/reprocess) and
  releases a pre-existing eager by-url pointer on terminal batch failure only
  when the pointer still exactly matches the failed target.
  Dry-run-by-default + `--execute`; resumes its in-flight batch from
  `./corpus-ingest.batch.json` (override with `--sidecar`). Both tools always
  require `OPENAI_API_KEY` for embeddings and require `ANTHROPIC_API_KEY` only
  for an Anthropic start or resume.
- The sole-writer requirement is enforced, not just documented (issue #68). Both
  batch tools — `corpus-ingest --execute` and `corpus-recover --batch --execute`
  — refuse to submit unless the operator also passes `--sole-writer`, asserting
  the realtime writer is paused/drained; an acknowledged run prints a loud banner
  before any submit. Dry-runs submit nothing and so never require it. The shared
  pure guard is `soleWriterGuard` in `scripts/corpus-lib/sole-writer.ts` (the
  unit-tested decision; the CLIs only do the stderr-print + `exit(2)` I/O). Both
  batch paths now eagerly claim activated by-url slots (fresh releases its own
  failed claims; recover keeps a failed claim so it stays re-submittable), but the
  eager claim is defense-in-depth, not a replacement: `--sole-writer` remains
  required whenever offline batch tools may overlap the realtime writer. The old
  home-server migration plan was dropped in favor of a home-server rewrite.
- The SPA currently invalidates queries after submit/reprocess but does not
  continuously poll pending manifests.

## Cursor Cloud specific instructions

Standard commands live in `## Commands` above and in `README.md`; this section
only captures non-obvious caveats for running/testing in the Cloud Agent VM
(the update script already ran `npm install`, `npm install --prefix web`, and
created `.dev.vars` from `.dev.vars.example`).

- There is no separate lint script. `npm run typecheck` (`tsc --noEmit`) is the
  static gate for the Worker; the SPA type-checks via `cd web && npm run build`
  (`tsc -b && vite build`). Prefer `npm run test:quiet` over `npm test` for the
  root suite (it strips the Workers-pool stderr noise but keeps the exit code).
- `.dev.vars` holds only placeholders (`READER_API_TOKEN=dev-local-token`,
  `OPENAI_API_KEY=sk-...`). The token makes local auth work; the OpenAI/Anthropic
  keys are fake. Real summarization needs real provider keys plus Cloudflare
  Queue + Vectorize, which only exist in staging/production — you cannot run the
  full submit→summarize pipeline against local `wrangler dev`.
- Run the Worker with `npm run dev` (serves `http://localhost:8787`, also
  reachable at `127.0.0.1:8787`) and the SPA with `cd web && npm run dev`
  (`http://127.0.0.1:5173`, proxies `/api` + `/health` to the Worker). In the
  SPA, paste the bearer token (`dev-local-token`) into the field in the top-right
  and Save to authenticate.
- Local `wrangler dev` deliberately has no Queue/Vectorize binding, so
  `POST /api/readings` and `/reprocess` return 503 and similarity search
  (`POST /api/readings/similar`) returns an empty result set. List search via
  `q` on `GET /api/readings` still works — it filters `index/list.json` from
  local R2 and does not need Vectorize.
  The submit→summarize pipeline itself is covered end-to-end by the test suite
  (integration tests inject queue/Vectorize stubs). The read-path routes (list,
  detail, `/content`, `/lookup`) work against whatever is in the local R2 bucket.
- To exercise the read path / SPA against real data locally, seed the local R2
  bucket, then restart `wrangler dev`. Seed via **Miniflare** (persist path
  `.wrangler/state/v3/r2`, bucket `reading-lite`), not `wrangler r2 object put
  --local` (which writes to a different local store the dev server never reads).
  The running dev server also caches R2 in-process, so restart it after seeding.
  A minimal `ready` reading needs `readings/<key_prefix>/manifest.json` (a valid
  `ManifestSchema` with `content_status: "captured"`), `index/by-id/<id>`,
  `index/by-url/<url_hash>` (matching the manifest's `url_hash`), an
  `index/list.json` row, `readings/<key_prefix>/extracted.md` (for `/content`),
  and `readings/<key_prefix>/raw.{ext}` matching the manifest's `content_type`
  (for `/content/raw`). `/lookup` requires the by-url pointer and does not
  discover pointerless readings.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->

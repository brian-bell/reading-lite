# AGENTS.md - reading-lite

Personal reading service on Cloudflare Workers plus a React SPA in `web/`.
Submitting a URL writes an eager by-url ownership claim, stores a pending
manifest in R2, and enqueues a `READING_JOBS` message; the consumer
(`processReading`) extracts, embeds with OpenAI, queries Vectorize for similar
readings, summarizes through the configured provider (OpenAI structured output
by default; Anthropic tool use when selected — provider selection never
falls back silently), and commits the terminal manifest plus `index/list.json`.

This file is the agent quick reference: module map, commands, conventions, and
gotchas. Elsewhere: `README.md` is the user-facing architecture and API guide,
`docs/operations.md` is the operator runbook (deploy, staging, bulk ingest,
corpus repair), `CONTEXT.md` defines the domain language the code is named
after, and the [Reading Lite](https://app.notion.com/p/Reading-Lite-3ca374f5e57480b9b226c239a6d94114)
Notion project holds tasks. Module design rationale lives in the header
comments of the modules themselves — read those before changing a module.

## Module Map

- `src/index.ts` — Worker fetch + queue + scheduled handlers (READING_JOBS →
  `processReading`, reading DLQ → `markDeadLettered`, DIGEST_JOBS → digest
  send, digest DLQ → ledger `failed` only, ACCOUNT_WIPE_JOBS → tenant
  R2+Vectorize wipe, wipe DLQ → log/ack).
- `src/account-wipe.ts` — deferred tenant prefix wipe (issue 195b PR1): 7-day
  grace on `deleting_at_ms` gates *new* wipes; cron resumes in-progress/leftover
  (preserving `force` on progress.json). Heartbeats `updated_at_ms` from current
  time during collect and R2/vector pages; retry lease is failure time plus
  delay. Two phases: Vectorize `deleteByIds` then paged R2. Does not hard-delete
  the users row. The header comment is the invariant list — read it first.
- `src/router.ts` — HTTP API: auth, zod parsing, read paths, and the single
  `toHttp` mapping from `IntakeOutcome` onto statuses — a thin adapter over
  Reading intake. Also mounts `POST /mcp`.
- `src/mcp/` — Streamable HTTP MCP connector: origin guard, tool handlers, and
  internal dispatch into the authenticated HTTP API so Cursor/Grok Bot search
  the corpus through named tools instead of raw curl.
- `src/intake/` — Reading intake, the write-side front door: `submit` /
  `importMarkdown` / `reprocess` own the claim → pending-manifest → activation
  ordering and return HTTP-free `IntakeOutcome`s. Reprocess prefers request
  Markdown over stored-Markdown synthesis; supplied Markdown bypasses
  `extracted.md`. `activation.ts` inside it is `activateAttempt`: the eager
  write-and-enqueue ordering plus the shared rollback-to-failed funnel.
- `src/process-reading.ts` — background pipeline, attempt logging, terminal
  manifest commits, failure handling.
- `src/digest-pipeline.ts` — digest cron fan-out + DIGEST_JOBS consumer (issue
  196 B2: Resend digest mail, one job per tenant). Send-time re-read honors
  cadence off. Digest DLQ must not touch reading manifests.
- `src/reading-visibility.ts` — list-row + Vectorize-vector lockstep and the
  owner gate protecting it.
- `src/reading-purge.ts` — `DELETE /api/readings/:id`: visibility-first purge
  ordering (vector → owned by-url pointer → list row → objects → final sweep →
  by-id last) behind the `readings:delete` scope; inbound `connections` stay
  dangling. The consumer's purge guard (`missingManifestStillLive` in
  `process-reading.ts`) keeps stale queue messages from recreating purged
  state.
- `src/attempt-ownership.ts` — the shared ownership verdict + attempt args
  shapes (the low layer under `process-reading.ts` and `reading-visibility.ts`).
- `src/control-plane/` — D1 auth: branded IDs, HKDF/HMAC crypto,
  `AuthenticatedPrincipal`, founder bootstrap (`scripts/lib/founder-bootstrap.ts`),
  and bearer authentication via `requirePrincipal` in `src/middleware.ts`.
  Runtime auth does not fall back to `READER_API_TOKEN`; that secret is imported
  once as a legacy-format token. `TenantUsageGuard` (SQLite DO,
  `idFromName(tenantId)`) enforces tenant-keyed request-rate and
  hourly/monthly reading-slot reservations from D1 `tenant_limits`.
- `src/modules/reading-claim.ts` — by-url ownership via
  `index/by-url/{sha256(url)}` pointers.
- `src/modules/staleness.ts` — the read-time stale-annotation rule.
- `src/modules/manifest-drafting.ts` — the pure constructors for every Manifest
  the system writes: pending drafts for the intake verbs, the queue-send
  rollback, and the terminal builders shared with the offline batch write phase
  (see CONTEXT.md "Manifest drafting").
- `src/modules/stores/` — `layout.ts` (the single-homed R2 key vocabulary:
  constants, `buildKeyPrefix`, and the tenant-rootable `r2KeyLayout` builders
  shared by the worker stores and the operator scripts), `reading-store.ts`
  (R2 codecs), `list-index.ts` (the `index/list.json` CAS subsystem),
  `similarity-store.ts` (Vectorize).
- `src/modules/{summarizer,openai-summarizer,anthropic,extractor,embeddings,email,http-retry}`
  — upstream-integration seams.
- `src/schemas/` — zod API + manifest contracts; `web/src/types.ts`
  hand-mirrors them.
- `scripts/ops.ts` + `scripts/ops-lib/` — the unified plan-first operator CLI:
  typed registry, dispatcher with shared exit semantics (0 ok / 2 usage / 1
  operational), native `run(argv, deps)` command modules under
  `ops-lib/commands/`, and `ops-lib/policy-contract.ts` (the tested extension
  contract for the future system-policy command, reading-lite-s1k.9.4).
  `test/unit/scripts/ops-registry-coverage.test.ts` fails when a supported
  workflow lacks a native command, safety classification, or help path.
- `scripts/*-lib/` — shared logic behind the CLI commands.
  `scripts/corpus-lib/batch/` is the offline provider Batch API pipeline:
  `run.ts`'s header documents the shared phase ordering; the recover front-end
  is `prepare.ts`/`extract-phase.ts`/`activation-phase.ts`, the fresh-markdown
  front-end is `prepare-fresh-markdown.ts`/`run-fresh-markdown.ts`.
- `web/` — React/Vite SPA (magic-link cookie session for identity/logout,
  list/search, submit, detail/diagnostics, reprocess). Does not store bearer
  material in localStorage/sessionStorage.

## Commands

```sh
npm install && cp .dev.vars.example .dev.vars
npm run dev
npm run test:quiet        # preferred over npm test — strips Workers-pool noise
npm run typecheck

cd web && npm install     # then: npm run dev, npm test, npm run build
```

Operator workflows live behind the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects plans by
default and acts only with `--execute`, e.g. `npm run ops -- deploy worker
--env staging --execute`, `npm run ops -- founder bootstrap --email
founder@example.com --execute`, `npm run ops -- corpus recover --tenant "$TENANT" --index
./index.json --execute`. Production `$TENANT` is `GET /api/whoami` `tenant_id`
(see `docs/operations.md` or `--help` for the full matrix).

Operator Node for `npm run ops` is **20.19.x** (Debian `/usr/bin/node`). Do
not bump the operator laptop to 22: Node 22 will not launch under the
operator security boundary, and Wrangler 4.87+ refuses Node 20 in
`bin/wrangler.js`. Ops launches `wrangler-dist/cli.js` on the current Node
instead, so R2/D1/deploy commands work on 20.19.x. Wrangler may still print a
Node 22 warning; that is not a hard fail. CI stays on Node 22. The Worker
runtime is workerd, not Node.

Production summarizer comparisons on live readings (N ids/URLs, OpenAI
efforts including max, optional Anthropic Sonnet, GET-only, no production
writes) use `.agents/skills/compare-summary-effort` — dry-run first,
`--execute` is the only paid path. `ops eval summarizer` is the fixture
matrix, not a substitute for real readings.

## Environments

- Local `wrangler dev` (`reading-lite-dev`) intentionally has no Queue or
  Vectorize binding: submit/reprocess return 503 and similarity search returns
  nothing.
- Staging (`[env.staging]`, `reading-lite-staging`) and production
  (`[env.production]`, `reading-lite`, routed at `reading-lite.bbell.dev/api/*`)
  are fully isolated; `ops staging setup`/`ops staging teardown` are idempotent and
  hard-coded to staging names. Staging same-origin host is
  `reading-lite-staging.bbell.dev` (Pages + Worker `/api/*`, `/health`, `/mcp*`).
- Merges to `main` run CI, then deploy that exact commit's production Worker via
  `.github/workflows/deploy-worker.yml` (`ops deploy worker --env production
  --execute`, which applies pending remote D1 migrations then uploads). After
  that succeeds, `.github/workflows/deploy-spa.yml` deploys the same commit's
  SPA through `ops deploy web --branch main --execute`. A shared production
  release lock serializes both workflows, and each rechecks for a stale commit
  immediately before its deploy command. GitHub secrets:
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Secrets via `wrangler secret put --env …`: `AUTH_ROOT_SECRET` and
  `OPENAI_API_KEY` always; `ANTHROPIC_API_KEY` only when
  `SUMMARIZER_PROVIDER=anthropic`; `X_API_BEARER_TOKEN` only for
  X/Twitter status URL imports; `RESEND_API_KEY` required on staging/production
  for magic-link auth mail.
  `founder-bootstrap` reads `AUTH_ROOT_SECRET` and `READER_API_TOKEN` from
  `.dev.vars` / `.stg.vars` / `.prd.vars` (same `AUTH_ROOT_SECRET` as the
  Worker secret). `READER_API_TOKEN` is not a runtime auth fallback.
  Checked-in defaults: OpenAI `gpt-5.6-terra`; staging and production use
  `high` effort, local uses `low` (OpenAI
  `OPENAI_SUMMARIZATION_REASONING_EFFORT` and Anthropic
  `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT`). Staging teardown's R2 emptying needs
  `CORPUS_R2_*` creds in env or `.corpus.vars`.

## Conventions

- Use TDD by default; test public behavior, not implementation shape.
- Inject `fetch`, `now`, and `newId`; the router takes `Services` from
  `src/services.ts` so tests can stub behavior.
- Validate only at seams: zod parses request bodies, R2 reads, and upstream
  responses. Manifest reads from R2 are always parsed (stored-schema drift).
- Keep by-url ownership eager: submit/import claim the URL slot before queueing.
  Ready/pending owners return the existing manifest; failed owners reprocess in
  place. Ownership is per tenant — hosted code constructs `ReadingStore` via
  `readingStoreFor` from a validated `TenantContext`.
- Keep `index/list.json` in sync on every terminal write, via existing
  `ReadingStore` helpers. When `TENANT_DATA_PLANE=1` those objects live under
  `u/{tenantId}/`; stored `key_prefix` stays relative. Production has been
  cut over (2026-08-31) and pins the gate in `[env.production.vars]`; local
  and staging stay unset.
- Keep Vectorize scoped the same way: hosted code builds the store via
  `similarityStoreFor`, which maps the tenant onto a Vectorize **namespace**
  (its own segmentation primitive — a namespaced query cannot match another
  namespace's vector, and unlike a metadata `filter` it needs no metadata
  index). While the gate is off the namespace is unset, which is what keeps the
  pre-tenant corpus visible. Flipping the gate therefore also requires
  re-upserting existing vectors into the founder namespace — a namespaced query
  will not see un-namespaced vectors, so a corpus migrated in R2 but not in
  Vectorize would silently return zero neighbours.
- Keep manifest contracts synchronized: `src/schemas/manifest.ts`,
  `src/schemas/api.ts`, tests, `web/src/types.ts`, and `docs/openapi.yaml`
  change together.
- Keep summarizer config fail-closed: require the selected provider's
  credential, reject invalid provider/effort values, no implicit fallback.
- Preserve the Anthropic prompt-cache prefix (`buildSummarizeRequestBody` in
  `src/modules/anthropic`; snapshot tests guard it).
- Keep embedding vectors at 1536 dimensions unless deliberately re-embedding
  into a fresh Vectorize index.

## Testing Notes

- `vitest.workspace.ts` splits Workers-pool from Node-pool tests; anything
  importing Node built-ins belongs under the Node globs.
- `wrangler.test.toml` omits Queue/Vectorize; integration tests inject
  `installQueueStub()` / `installVectorizeStub()` fakes.
- Tests observing an active pending state must not drain the queue before the
  assertion.
- `test/env.d.ts` is load-bearing (`cloudflare:test` `Env` typing).
- Full verification: `npm test` + `npm run typecheck`; SPA: `cd web && npm test
  && npm run build`. CI runs the canonical `npm test`.

## Operational Gotchas

Pointers only — the details live in the named files' comments.

- Production founder cutover ran 2026-08-31 (`docs/founder-cutover.md`,
  record at the bottom). `TENANT_DATA_PLANE = "1"` is pinned in
  `[env.production.vars]`, so ordinary deploys (incl. merge-to-main) keep the
  gate on; rollback is removing the pin. Legacy global objects and bare-id
  vectors are still in the bucket/index pending a separate signed-off
  deletion — `--tenant global` operator commands still see them; live
  production corpus ops use `--tenant "$TENANT"` from whoami (see
  `docs/operations.md`). With the gate on, tenant-scoped operations do not
  reach that legacy data and are not meant to: a tenant-rooted read, write, or
  delete addresses `u/{tenantId}/` and the tenant's Vectorize namespace, so
  pre-tenant `readings/`/`index/` objects and un-namespaced `rd_…` vectors
  survive it — account wipe (`src/account-wipe.ts`) included. With the gate
  off the stores fall back to the pre-tenant layout (`tenantKeyRoot` is `""`,
  the namespace unset), but wipe does not follow them there: gate off or an
  empty key root each skip with `no_tenant_prefix` rather than empty the
  bucket. The signed-off deletion is what clears the legacy data. Default
  `--bucket` is production `reading-lite`. Copy, never move; restore missing
  vectors with `corpus backfill-vectors`, not reprocess.
- `processReading` runs in the queue consumer. `RateLimitedError` → retry with
  delay, manifest stays pending; other errors → failed manifest + ack.
  Exhausted retries hit the DLQ, where `markDeadLettered` writes a retryable
  `failed`. Digest jobs use `DIGEST_JOBS` (never `READING_JOBS`); the digest
  DLQ marks `digest_deliveries` failed and must not call `markDeadLettered`.
  Digest send is Resend to the current verified `email_display` (never
  `EMAIL_TO`, never `LOCAL_MAIL_SINK`). Empty windows skip and close the
  period. Resend 429 retries the job and leaves the ledger `pending`.
  Fan-out re-enqueues leftover pending only after `DIGEST_PENDING_STALE_MS`
  (15 minutes / one cron interval). Digest Resend POSTs set `Idempotency-Key`
  to `digestDeliveryKeyId`.
  Account wipe uses `ACCOUNT_WIPE_JOBS` (never `READING_JOBS`): cron starts
  new wipes for `status=deleting` tenants past the 7-day `deleting_at_ms`
  grace; a job `{ force: true }` skips grace to start. Cron resumes
  in-progress or leftover wipes during grace and preserves `force` from
  `progress.json`. Leftover recovery restarts at Vectorize (`phase=vectors`,
  offset 0) and re-derives reading ids from an R2 re-list — ids are never
  persisted on the progress record. There is no post-empty re-submit: a
  consumer publishing against a tenant confirmed `deleting` deletes its own
  vector directly (`ReadingVisibility.removeForDeletedTenant`) instead of
  routing through an `index/list.json` row the wipe may already have removed.
  Wipe heartbeats `progress.updated_at_ms` from current time during collect and
  R2/vector pages; a delayed `msg.retry` advances the wipe lease from
  failure time by `delaySeconds` so cron does not enqueue a sibling. An unbound
  `READINGS_INDEX` throws (`index_unbound`) rather than emptying R2, and that
  check runs before the "no ids to delete" short-circuit, so a wipe cannot
  report success without having addressed the index.
  Vectorize `deleteByIds` is async (mutationId; embeddings may take a short
  time to disappear). Continuation cursors live at
  `wipe/{tenantId}/progress.json`, written compare-and-set on the R2 etag (a
  losing duplicate delivery fails with `progress_conflict` instead of clobbering
  the cursor; the consumer also runs at `max_concurrency = 1`) and **deleted**
  at the terminal transition — that key names a deleted tenant, so it must not
  outlive the wipe.
  Because that record is the only "already wiped" marker, fan-out skips a
  tenant with no record and an empty prefix, and CAS-clears any object left at
  a finished tenant's key. Before success the wipe probes the tenant namespace,
  retrying a hit on a minutes-scale delay bounded at the queue's `max_retries`,
  then emits a high-severity `account_wipe_namespace_residue` (tenant id only,
  never reading ids) and completes rather than looping forever. Two gaps are
  deliberate and written down in `docs/operations.md`: an empty-prefix tenant
  with stranded vectors is never swept again, and there is no durable record of
  a wipe's outcome — do not gate the PR2 hard-delete on inferring one from R2
  state. Both close with the durable vector ledger, issue #261
  (`rl-wipe-vector-ledger`). The wipe DLQ logs and acks; it must not call
  `markDeadLettered`.
- Reprocess with a Markdown source flips `source_type` only after success;
  failures retain the prior source type, and ready readings also restore their
  preserved manifest. After a successful flip, later source-less reprocesses
  reuse stored Markdown.
- `GET /api/readings/lookup` must stay side-effect-free: no pointer claims,
  repairs, deep scans, or writes.
- Reddit can't be fetched from the worker (bot challenge) — the reading lands
  `failed` with guidance. The extract-agent makes one anonymous
  `<thread>.json?raw_json=1&limit=20&sort=top` attempt per manifest version and
  records challenges as durable `manual` outcomes; recover those with the
  **`reddit-import`** skill.
- YouTube extracts a metadata floor in-worker
  (`src/modules/extractor/youtube.ts`); for description + transcript use the
  **`youtube-import`** skill.
- X/Twitter status URLs reconstruct the author thread in-worker
  (`src/modules/extractor/x.ts`) via recent search and `X_API_BEARER_TOKEN`.
  Conversations older than seven days land `failed` with
  `XThreadOutsideRecentWindowError`.
- Turndown/linkedom quirks and the raw-DOM salvage path are documented in
  `src/modules/extractor/index.ts`.
- Do not remove `nodejs_compat`; Worker dependencies and scripts rely on it.
- Offline batch tools (`ops corpus ingest --tenant "$TENANT" --execute`, `ops corpus recover --tenant "$TENANT" --batch
  --execute`) refuse to submit without `--sole-writer` — pause/drain the
  realtime writer first (`scripts/corpus-lib/sole-writer.ts`). Both resume from
  sidecars and never recreate a batch; claim/release/crash-resume semantics are
  documented in `activation-phase.ts`, `write-phase.ts`,
  `prepare-fresh-markdown.ts`, and `openai-reconcile.ts`.
- The SPA invalidates queries after submit/reprocess but does not poll pending
  manifests.

## Cloud Agents

`.cursor/environment.json` runs `npm ci`, `cd web && npm ci`, then
`scripts/cloud-agent-install.ts` on boot. Add these **environment secrets** in
the Cursor dashboard (not in git):

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — non-interactive wrangler
- `AUTH_ROOT_SECRET`, `READER_API_TOKEN`, `FOUNDER_EMAIL` — writes `.stg.vars`

Staging founder state already lives in D1 after the first bootstrap; re-run is
only needed after credential rotation. Set `CLOUD_AGENT_FOUNDER_BOOTSTRAP=1` to
run the staging founder bootstrap (`ops founder bootstrap --env staging
--execute` equivalent) on every install (idempotent).

## Working Locally

- There is no lint script. `npm run typecheck` (`tsc --noEmit`) is the static
  gate for the Worker; the SPA type-checks via `cd web && npm run build`
  (`tsc -b && vite build`).
- `.dev.vars` holds placeholders: `READER_API_TOKEN=dev-local-token` makes local
  auth work, but the provider keys are fake. Real summarization needs real keys
  plus Queue + Vectorize, which exist only in staging/production — you cannot run
  the full submit→summarize pipeline against local `wrangler dev`. It is covered
  end-to-end by the integration tests instead.
- Worker on `http://127.0.0.1:8787` (`npm run dev` runs `dev:setup` first to
  apply local D1 migrations and import `dev-local-token` as the founder legacy
  bearer), SPA on `http://127.0.0.1:5173` (`cd web && npm run dev`) proxying
  `/api` + `/health`. Request a magic link from the SPA; local `LOCAL_MAIL_SINK=1`
  stores it for `GET /api/dev/mailbox?email=…` on loopback. Bearer tokens still
  authenticate the Worker API for operator CLIs.
- Read-path routes (list, detail, `/content`, `/lookup`) and `q` search on
  `GET /api/readings` work against the local R2 bucket without Vectorize. To try
  them against real data, see "Seeding local R2" in `docs/operations.md`.

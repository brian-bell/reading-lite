# Architecture

Reading Lite runs on one Cloudflare Worker plus PostgreSQL with pgvector
(through Hyperdrive), Durable Objects, R2, and Queues. Reading state,
embeddings and the control plane live in PostgreSQL; captured content stays in R2
([ADR 0005](decisions/0005-postgresql-storage.md)). The Worker owns `/api/*`, `/health`, and `/mcp*`;
the TanStack Start frontend in `app/`, a separate Worker, handles the other
routes ([ADR 0003](decisions/0003-frontend-worker-topology.md)). Cloudflare
Pages still serves the legacy React SPA in `web/` on the same hosts as the
rollback target.
[Configuration](configuration.md) lists environment defaults, and
[operations](operations.md) covers deployment and maintenance.

## Reading lifecycle

`src/router.ts` authenticates the principal, validates input, and maps the
HTTP-free `IntakeOutcome` to a response. `src/intake/` owns `submit`,
`importMarkdown`, and `reprocess`, including URL claims and activation.

1. Resolve the URL's owner: one read of the tenant's `reading_urls` row.
   Return an existing ready/pending reading; reuse the ID of a failed one.
2. Commit the claim in one transaction: the reading, its unique URL row, the
   attempt, and a `queued` job row. A concurrent submission of the same URL
   waits on the unique key and then finds the winner, so duplicates converge on
   one reading and an owner is never half-written. `activateAttempt` writes
   import content under the attempt's revision keys, then enqueues; a failure
   there rolls the reading back to a retryable failure and marks the job
   `send_failed`. New work returns 202 with a poll URL.
3. `processReading` checks the reading's row, tenant, and attempt ownership
   before spending or writing. It extracts the source and stores raw and
   captured content under `{key_prefix}/revisions/{attemptId}/`.
4. Acquire tenant/global processing leases. Embed the source, query related
   readings, summarize, then embed the TL;DR. The paid checkpoint on the
   attempt row avoids repeating completed provider stages on recovery.
5. Publish in one transaction (see below). Tenant eligibility is part of it:
   the transaction locks the tenant's `users` row FOR SHARE and reads `status`
   there, so `DELETE /api/account` waits behind an in-flight publish and there
   is no window to compensate for. An ineligible tenant's reading is stored
   with no embedding, so it is never searchable; a `deleting` tenant's copy is
   removed by the account wipe, which sweeps rows again after its objects
   phase for exactly this publisher.
6. Send any eligible immediate notification after publication; mail failure
   does not fail a ready reading.

The hosted reading consumer has `max_concurrency=3` in staging and production.
Tenant/global leases also limit paid concurrency. Every actual hosted provider
attempt passes through [budget admission](paid-provider-spend.md) inside the
adapter's retry loop, including retries. A queue delay alone does not make a
request eligible for provider Batch API pricing. Only the separate operator
batch pipeline submits provider batches.

### Orphaned in-flight leases

The expiry sweep never removes an `inFlight` row: expiry alone must not let
another delivery resume paid work. Recovery is separate from normal lease
acquisition, in `src/control-plane/processing-lease-recovery.ts`. Queue
processing and the operator entrypoint both call the global guard's
`recover_leases` operation. Observations contain expiry and in-flight state,
never the holder's dispatch fence.

The global guard holds its lock while checking its row, observing the tenant
row, and asking the tenant guard to conditionally retire it. The tenant guard
checks the observed expiry under its own lock. A refusal on either side
prevents deletion of the other side; global heartbeats cannot interleave with
this decision. No tenant handler calls the global guard, so lock acquisition
has no cycle. An unavailable or malformed observation is never absence.

Retirement writes `retired-lease:<attemptId>` before deleting tenant capacity,
then the global guard deletes its row. This small credential-free marker blocks
acquire, renew, and pause for the retired attempt, even if recovery crashes
before `processReading` writes the terminal manifest. Retried recovery inspects
both sides independently, including a global-only leftover. Markers occupy no
capacity, survive expiry sweeps, and are removed by tenant teardown. A user
retry receives a new attempt ID. Normal successful attempts need no marker.

Reading policy decides when to request recovery:

- A terminal manifest without `active_attempt`, or a purged target, permits
  cleanup without waiting for expiry. A ready/failed reprocess with an active
  attempt is not terminal. Purge cannot cancel a provider request already sent;
  retiring its lease prevents subsequent dispatches at the next fence check.
- An incomplete attempt must reach the 24-hour defer ceiling and have overdue
  in-flight rows on both sides (or confirmed absence). The guards use their
  own clocks. A heartbeat after observation makes the tenant CAS refuse; a
  fresh global row refuses before the tenant is touched. Recovery never grants
  another delivery permission to resume the retired attempt.
- A previously retired attempt finishes cleanup and terminalization on its
  next delivery, without acquiring a work hold.

Any unconfirmed cleanup defers, including terminal/purged deliveries and
attempts past the age ceiling. Only confirmed cleanup logs
`processing_lease_orphan_released`. Operator diagnostics expose tenant,
attempt, expiry and heartbeat-overdue age. The plan-first operator command
uses the same authority with explicit observed expiries and always requires
overdue rows; see [operations](operations.md#orphaned-in-flight-processing-leases).

### Publication and failure ordering

`PgReadingWriter.publish` (`src/modules/stores/postgres/reading-writer.ts`) is
one transaction, and its order is the contract: lock the reading row, verify
attempt ownership (`src/attempt-ownership.ts`), settle URL ownership, then
write the revision, the reading, its relationships, the embedding, and the
attempt and job rows. Nothing is written before ownership is settled, and a
reader never sees a summary without its content keys or a vector for a reading
that is not ready. Only the URL's owner is searchable: a duplicate that does
not own its URL is stored without an embedding. `test/integration/postgres/
reading-writer.test.ts` pins lost ownership, rollback, and the fence.

This replaces the old cross-service sequence (ledger row, terminal manifest,
list row, vector) and its compensation paths. A publish transaction that fails
rolls back whole and throws `PublishCommitError`; the consumer requeues rather
than marking the reading failed, because the summary is paid for and
checkpointed and the reading is still pending and still owned by the attempt.

An upstream 429 raises `RateLimitedError`; queue retry leaves the attempt
pending. Paid-work denial or stale processing leases defer the same attempt,
with checkpoints and the configured defer-age bound. Other processing failures
write a failed result through `PgReadingWriter.fail`. Exhausted reading
retries reach the reading DLQ, which calls `markDeadLettered`, the only path
that marks a job `dead`. If that write fails, the handler logs and acks;
read-time staleness annotation remains the fallback.

The consumer and the scheduled jobs use `sqlSessionFor`: one client reused
while it keeps being used, replaced after 10 seconds idle (a provider call) or
after any error, and ended when the work finishes. A client per statement
would also be correct but floods the connection path where nothing pools.
HTTP routes share one client per request (`src/modules/db/request-sql.ts`).
Attempt journals and paid checkpoints are `reading_attempts` rows; durable job
intent is `reading_jobs`.

## Reprocessing and recovery

Supplied Markdown takes precedence over stored text and avoids fetching the
source URL. Successful processing changes `source_type` to `markdown`; later
source-less reprocesses reuse the stored Markdown, found through the reading's
own content keys. Failure keeps the previous source type.

Every attempt writes its content under its own immutable revision prefix, so a
reprocess can never overwrite what the published revision points at. A ready
reading stays `ready` while it reprocesses. If the attempt fails, only the
attempt summaries change: the previous content, summary, relationships, and
embedding stay intact together. This closes the gap where a failed reprocess
restored the manifest but not the content artifacts it had overwritten
(reading-lite-psu; the [193-v2.1 handoff](193-v2.1-handoff.md) records one
observed case in the pre-migration corpus).

Content a failed or superseded attempt captured is deleted once nothing
references it. `AttemptIo.discardUnreferencedContent` checks the reading's
current keys first, because a redelivered message for an attempt that already
published reaches the same "may not write" exits with the live prefix.

A never-published reading serves its latest capturing attempt's content. An
imported reading that no attempt has touched serves the legacy spelling under
its stored `key_prefix`, so imported content keys stay readable and
reprocessable.

`src/reading-purge.ts` deletes the reading's row in one transaction, which
cascades to its URL ownership, revisions, relationships, embedding, attempts,
and jobs, then deletes the R2 prefix twice. The active-attempt guard runs
under the row lock, so a purge and an activation cannot both win. The missing
row is the deletion fence: a late consumer's publish, failure, or attempt-log
write finds no row and writes nothing, and it deletes what it captured itself.
A purge that dies between the rows and the objects leaves unreachable bytes;
the re-issued DELETE is a 404, and the account wipe removes the tenant's
prefix. Inbound connections from other readings remain until an explicit
corpus sweep.

## Tenant storage

Hosted stores derive their scope from a validated `TenantContext`, and every
PostgreSQL query is `WHERE tenant_id = $1`:

| Store | Location and responsibility |
|---|---|
| `postgres/reading-store.ts` | List, detail, relationship targets, URL owner, content keys |
| `postgres/reading-writer.ts` | Claims, attempts, publication, failure, purge (one transaction each) |
| `postgres/similarity-store.ts` | Exact cosine scan over one tenant's embeddings |
| `postgres/manifest-rows.ts` | The manifest-to-rows mapping, shared with seeding and the importer |
| `content-store.ts` | R2 bytes by relative key under the tenant root |
| `layout.ts` | Key constants, `buildKeyPrefix`, `r2KeyLayout`, and the revision key family |
| `staleness.ts` | Read-time stale-attempt annotation |
| `manifest-drafting.ts` | Pure pending, rollback, and terminal manifest constructors |

With `TENANT_DATA_PLANE=1`, R2 keys live under `u/{tenantId}/`; stored
`key_prefix` values and content keys stay relative, such as
`readings/YYYY/MM/<timestamp>-<id>/revisions/<attemptId>/raw.html`.

The R2 `ReadingStore`, `ListIndexStore`, and Vectorize `SimilarityStore` remain
for the operator scripts, which move in a later slice, and the account wipe
still runs its Vectorize and vector-ledger phases for vectors written before
the cutover. No runtime reading path writes manifests, `index/list.json`,
pointers, or Vectorize.

Staging and production pin the tenant gate. The completed founder cutover
copied data and retained global R2 objects and unnamespaced vectors, which
tenant operations, including account wipe, do not reach. The founder migration
command is retired; see the [historical cutover](founder-cutover.md).

## Authentication and background jobs

PostgreSQL stores users, credentials, sessions, settings, limits, and deletion
records ([ADR 0005](decisions/0005-postgresql-storage.md)). Each HTTP request
shares one client between authentication and its handler. Reads that were a
read-then-write on D1's single writer now lock then act in one transaction:
magic-link issue (advisory locks per address and user), redeem (the challenge
row), session issue and token creation (the user row), founder bootstrap, and
teardown.
`src/control-plane/` handles branded IDs, HKDF/HMAC credentials, eligibility,
CSRF, recent auth, and guard RPCs. `TenantUsageGuard` uses `idFromName(tenantId)`
for request limits, hourly/monthly reading slots, and processing leases.
`GlobalUsageGuard` owns global leases and the shared tenant/global spend ledger.
Runtime auth looks up the imported founder bearer in PostgreSQL; it never falls back
to the `READER_API_TOKEN` secret. See the [API guide](api.md).

`FrontendReads` (`src/frontend-reads.ts`) is a named `WorkerEntrypoint` for the
`app/` frontend's server renders, reachable only through a service binding
([ADR 0003](decisions/0003-frontend-worker-topology.md)). Its RPC methods,
`whoami`, `reading`, and `list` (the library's `q`, `tag`, and `offset`, never
a page size), rebuild a GET from the browser's Cookie header and
host and dispatch it through the Worker's own Hono app, so auth, tenant
resolution, `x-expected-tenant`, and handlers match the HTTP API. The rebuilt
`Request` object is registered in `control-plane/frontend-read-trust.ts`;
`requirePrincipal` accepts its cookie as same-origin instead of requiring
`Origin` or `Sec-Fetch-Site`, and nothing on the wire can reach that set. Results
are `{ status, body }` with no headers, so the entrypoint never sets cookies.
Session auth still refreshes `last_seen_at`, as on any authenticated GET.
Every prototype method is RPC-callable, so add one only for an allowlisted read.

`src/index.ts` dispatches fetch, queue, and scheduled events. Cron runs every
15 minutes for digest/wipe work, with a separate gated nightly relationship
scan at 03:07 UTC. The job families have separate queues and DLQs:

| Job | Consumer and completion |
|---|---|
| `READING_JOBS` | `processReading`; reading DLQ marks a reading failed |
| `DIGEST_JOBS` | `digest-pipeline.ts`; digest DLQ only marks `digest_deliveries` failed |
| `ACCOUNT_WIPE_JOBS` | `account-wipe.ts`; wipe DLQ logs and acks |
| `RELATIONSHIP_REFRESH_JOBS` | `relationship-refresh.ts`; full scan shards and capped judge fan-out; `relationship-judge.ts` publishes relationship-only patches, DLQ logs and acks |

Digest send re-reads cadence and the current verified account address. Empty
windows close without mail. Resend 429 retains pending state for retry;
fan-out redrives pending deliveries only after 15 minutes. Each send uses
`digestDeliveryKeyId` as its idempotency key. Digest delivery ignores `EMAIL_TO`
and `LOCAL_MAIL_SINK`. See [mail configuration](operations.md#secrets).

Account deletion first suppresses access and revokes credentials. Wipe starts
after seven days, or with an explicit forced job, and deletes the tenant's
reading rows and embeddings before its R2 objects. `wipe_progress` owns the
phase (`rows`, `objects`, `done`), the object cursor, the lease sequence, and
current/first completion records. Cron runs `account-teardown.ts` after
completion and an empty-prefix check. Its audit row survives the account. Read the
[complete deletion rules](operations.md#account-deletion) before changing any
of these modules.

## Extraction and provider adapters

`src/modules/extractor/` converts HTML with linkedom, Readability, and Turndown.
Its header documents raw-DOM salvage and parser quirks. Each fetch hop checks
scheme, DNS/private addresses, redirects, time, and response size. Defaults are
20 seconds and 10 MiB. X threads, Reddit failures, and YouTube metadata have
specific paths; see [source recovery](operations.md#sources-that-need-a-local-skill).
The local extract-agent tries anonymous Reddit thread JSON once per manifest
version, with `raw_json=1&limit=20&sort=top`, then records challenges as manual.

DNS validation is a preflight, not connection pinning. Hosted and operator
static fetches validate an address, then fetch resolves the hostname again.
A DNS answer change can bypass the earlier check. The Workers adapter also
cannot distinguish some single-family failures from absent records,
`ENOTFOUND`. The operator headless browser instead uses a validating proxy that
connects to vetted IPs directly. Tests cover the implemented checks and these
limits; they do not prove DNS rebinding impossible.

`embeddings` uses `text-embedding-3-small` at 1536 dimensions. `summarizer`
selects and normalizes provider results; `openai-summarizer` uses Responses with
strict structured output, and `anthropic` uses `emit_reading` / `reject_source`
tools. Preserve the Anthropic system/tool cache prefix. `http-retry` retries
network/5xx failures with bounded exponential backoff and jitter; 429 exits to
the caller. Invalid provider, credentials, or effort fail closed.

## Operator code and SPA

`scripts/ops.ts` and `ops-lib/` provide the typed command registry, dispatcher,
and native `run(argv, deps)` commands. Shared libraries live in `scripts/*-lib/`.
Registry coverage tests require supported workflows to have a native command,
safety classification, and help path. Normal CLI exits are 0 for success, 2 for
usage, and 1 for operational failure; neighbour refresh also uses 3 for readings
that need repair.

The offline batch pipeline in `scripts/corpus-lib/batch/` shares manifest
constructors with hosted processing. `run.ts` documents phase ordering;
`prepare.ts`, `extract-phase.ts`, and `activation-phase.ts` handle recovery;
`prepare-fresh-markdown.ts` and `run-fresh-markdown.ts` handle new Markdown.
The sidecar records provider/model and progress so resume does not create a
second batch, and `spend.ts` bounds, admits, and settles each batch as one
spend operation that the sidecar carries. See
[batch operations](operations.md#provider-batch-apis).

`OperatorStatus` exposes private accounting and quota inspection through a
service binding, with no public admin route. `OperatorSpend` is the paid
operator commands' equivalent for the four spend verbs, reached through
`scripts/system-lib/wrangler-spend.toml` and wrapped by
`ops-lib/operator-spend.ts`. `system policy` uses the tested
`ops-lib/policy-contract.ts`. `staging prepare-context` builds local fixture
packets; it does not apply them remotely. Their guides are
[paid spend](paid-provider-spend.md) and [context preparation](staging-context-copy.md).

The SPA uses cookie sessions, React Query invalidation, and routed views for
readings and account security. It stores no bearer material in localStorage or
sessionStorage. `web/src/types.ts` hand-mirrors Worker contracts; change it with
`src/schemas/` and [OpenAPI](openapi.yaml). Tests use jsdom and fetch stubs;
`npm run build` in `web/` checks types and builds the Pages artifact.

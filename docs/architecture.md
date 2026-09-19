# Architecture

Reading Lite runs on one Cloudflare Worker plus managed D1, Durable Objects,
R2, Vectorize, and Queues. The Worker owns `/api/*`, `/health`, and `/mcp*`;
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

1. Resolve the tenant's by-url owner. Return an existing ready/pending reading;
   reuse the ID of a failed reading.
2. Claim the URL before writing the pending manifest and enqueuing the attempt.
   `activateAttempt` owns the write/enqueue order and rollback to failed when
   activation cannot finish. New work returns 202 with a poll URL.
3. `processReading` checks purge, tenant, and attempt ownership before spending
   or writing artifacts. It extracts the source and stores raw/captured content.
4. Acquire tenant/global processing leases. Embed the source, query related
   readings, summarize, then embed the TL;DR. Supported checkpoints avoid
   repeating completed provider stages on recovery.
5. Record the reading ID as live in D1 `vector_ledger`, then commit the terminal
   manifest. Recheck tenant eligibility and the per-reading purge tombstone
   (`index/deleted/{id}`) immediately before by-url reclaim, the terminal
   write, and publish. A confirmed tombstone skips those writes (see
   [reprocessing and recovery](#reprocessing-and-recovery)). Otherwise publish
   the list row, then the vector. Confirm URL ownership as part of the
   terminal write path.
6. Recheck deletion eligibility after publish. `users.status=deleting`
   compensates with `visibility.removeForDeletedTenant` so a missing list row
   cannot skip the vector delete. A confirmed purge tombstone does not run
   that compensation — it is a write fence, not a second purge. Send any
   eligible immediate notification after publication; mail failure does not
   fail a ready reading.

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

`src/attempt-ownership.ts` supplies the shared ownership verdict.
`commitTerminalManifest` chooses publish, remove, or restore;
`ReadingVisibility` owns list/vector reconciliation. These writes span services
and are not atomic. Publication errors after the terminal manifest are logged
and contained so they cannot overwrite a ready result with failed.

The ledger write must occur before the terminal manifest. A ready manifest
clears `active_attempt`, so putting the ledger write inside the later
`ReadingVisibility.publish` would make a ledger failure's retry exit without
republishing. In its current position, `VectorLedgerWriteError` reaches the
consumer while the attempt can still retry. D1 is therefore a hard dependency
of publication and single-reading purge. A D1 outage may look like a vector
failure but must not be treated as optional bookkeeping.

An upstream 429 raises `RateLimitedError`; queue retry leaves the attempt
pending. Paid-work denial or stale processing leases defer the same attempt,
with checkpoints and the configured defer-age bound. Other processing failures
write a failed result, subject to the ready-reprocess preservation rule below.
Exhausted reading retries reach the reading DLQ, which calls `markDeadLettered`
to write a retryable failure. If that write fails, the handler logs and acks;
read-time staleness annotation remains the fallback.

Attempt journals live at `{key_prefix}/attempts/{attempt_id}.json`, with stage,
timing, trigger, and sanitized errors. Processing checkpoints live at
`{key_prefix}/processing/{attempt_id}.json`. Tenant rooting applies to both.

## Reprocessing and recovery

Supplied Markdown takes precedence over stored text and avoids fetching the
source URL. Successful processing changes `source_type` to `markdown`; later
source-less reprocesses reuse the stored Markdown. Failure keeps the previous
source type. A previously ready reading restores its preserved manifest and
records a failed last attempt.

That preservation covers the manifest, not the earlier content writes. A failed
reprocess can overwrite raw/extracted artifacts before restoring the old ready
manifest, leaving its recorded size/hash inconsistent with stored content. The
[193-v2.1 handoff](193-v2.1-handoff.md) records one observed case. Verify captured
bytes against the manifest before copying fixtures; do not assume ready status
proves artifact integrity.

`src/reading-purge.ts` writes an irrevocable `index/deleted/{id}` tombstone
after the active-attempt guard and before any delete (fail-closed on a thrown
put), then removes the reading with vector deletion first, then its owned
by-url pointer, list row, objects, a final sweep, and by-id pointer last. This
supports retries after partial failure; a purge that dies right after the
tombstone put leaves a doomed-but-present reading that only the re-issued
DELETE finishes. Inbound connections remain until an explicit corpus sweep.

The tombstone is a write fence (issue #179), not a second purge. Writers
recheck it — fail-open on a throwing HEAD, latched for the rest of a
`commitTerminalManifest` call once confirmed — and skip the write: before
`activateAttempt` puts a pending manifest or rolls a failed enqueue back,
before by-url reclaim, the terminal write, and publish, again after the
terminal CAS and after publish, on the lost-CAS restore, at
`processReading`'s early returns, and before `markFailed`/`markDeadLettered`
recreate a failed manifest. A confirmed tombstone on those consumer paths
may also delete objects under the reading prefix (attempt residue this
delivery wrote). It does not ungated-delete the vector, list row, or by-url
pointer. A consumer that publishes after the purge's final sweep and then
dies can leave a listed or searchable reading whose by-id pointer is already
gone, so a re-issued DELETE answers `not_found`. That is last-writer-wins
residue; repair is account wipe or corpus tooling. The missing-manifest
purge guard treats a tombstone as purged. Tombstones are retained forever
(the consumer they fence can wake hours later from the retry/DLQ pipeline)
and are deleted only by the account wipe's objects phase, which covers the
whole tenant key root.

## Tenant storage

Hosted stores derive their scope from a validated `TenantContext`:

| Store | Location and responsibility |
|---|---|
| `layout.ts` | Constants, `buildKeyPrefix`, and `r2KeyLayout`, shared by Worker stores and operator scripts |
| `reading-store.ts` | Parsed R2 codecs for manifests, content, pointers, attempts, and checkpoints |
| `list-index.ts` | `index/list.json`, CAS updates, filtering, ownership, and rebuild |
| `similarity-store.ts` | Vectorize queries, upserts, deletes, and namespace probes |
| `reading-claim.ts` | `index/by-url/{sha256(url)}` ownership |
| `staleness.ts` | Read-time stale-attempt annotation |
| `manifest-drafting.ts` | Pure pending, rollback, and terminal manifest constructors |

With `TENANT_DATA_PLANE=1`, R2 keys live under `u/{tenantId}/`; stored
`key_prefix` stays relative, such as `readings/YYYY/MM/<timestamp>-<id>`.
Vectorize uses the tenant namespace for queries and composed
`{tenantId}:{readingId}` IDs for writes. Namespace filtering prevents a query
from matching another tenant's vectors. IDs are index-unique, and deletion by
ID has no namespace argument, so namespace selection alone cannot protect a
bare-ID delete.

Staging and production pin the tenant gate. Local leaves it unset to read the
global layout. The completed founder cutover copied data and retained global
R2 objects and unnamespaced vectors. Tenant operations, including account wipe,
do not reach that retained copy. Removing the pin after new tenant writes land
hides those readings behind the global snapshot. Rollback then needs a freeze
and reverse reconciliation, or explicit acceptance of that loss.

A namespaced query cannot see unnamespaced vectors. Any future storage migration
must verify both R2 and Vectorize before activation. The founder migration
command is retired; see the [historical cutover](founder-cutover.md).

## Authentication and background jobs

D1 stores users, credentials, sessions, settings, limits, and deletion records.
`src/control-plane/` handles branded IDs, HKDF/HMAC credentials, eligibility,
CSRF, recent auth, and guard RPCs. `TenantUsageGuard` uses `idFromName(tenantId)`
for request limits, hourly/monthly reading slots, and processing leases.
`GlobalUsageGuard` owns global leases and the shared tenant/global spend ledger.
Runtime auth looks up the imported founder bearer in D1; it never falls back
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
Session auth still refreshes `last_seen_at_ms`, as on any authenticated GET.
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
after seven days, or with an explicit forced job, and seeds its own vector
ledger before deleting anything. D1 `wipe_progress` owns seed/object cursors,
lease sequence, probe counts, and current/first completion records. Cron runs
`account-teardown.ts` after completion and an empty-prefix check. Its audit
row survives the account, as do unconfirmed vector IDs for repair. Read the
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
second batch. See [batch operations](operations.md#provider-batch-apis).

`OperatorStatus` exposes private accounting and quota inspection through a
service binding, with no public admin route. `system policy` uses the tested
`ops-lib/policy-contract.ts`. `staging prepare-context` builds local fixture
packets; it does not apply them remotely. Their guides are
[paid spend](paid-provider-spend.md) and [context preparation](staging-context-copy.md).

The SPA uses cookie sessions, React Query invalidation, and routed views for
readings and account security. It stores no bearer material in localStorage or
sessionStorage. `web/src/types.ts` hand-mirrors Worker contracts; change it with
`src/schemas/` and [OpenAPI](openapi.yaml). Tests use jsdom and fetch stubs;
`npm run build` in `web/` checks types and builds the Pages artifact.

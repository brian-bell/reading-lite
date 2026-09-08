# Architecture

Reading Lite runs on one Cloudflare Worker plus managed D1, Durable Objects,
R2, Vectorize, and Queues. Cloudflare Pages serves the React SPA. The Worker
owns `/api/*`, `/health`, and `/mcp*`; Pages handles the other routes.
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
   (`index/deleted/{id}`) before by-url reclaim and before the terminal write.
   A confirmed tombstone skips reclaim and does not write a new terminal
   object. Skip-write and lost-CAS still sweep prefix objects (attempt
   residue) then compensate visibility. Otherwise publish the list row, then
   the vector.
   Confirm URL ownership as part of the terminal write path.
6. Recheck deletion eligibility and compensate if needed. A confirmed purge
   tombstone or `users.status=deleting` compensates with
   `visibility.removeForDeletedTenant` so a missing list row cannot skip the
   vector delete. Tombstone compensation also releases this reading's by-url
   pointer if it still owns the slot. A confirmed tombstone on skip-write,
   lost-CAS, or after the terminal CAS also deletes objects under the reading
   prefix so attempt residue or a rewritten manifest is not left unreapable.
   Send any eligible immediate notification after publication; mail failure
   does not fail a ready reading.

The hosted reading consumer has `max_concurrency=3` in staging and production.
Tenant/global leases also limit paid concurrency. Every actual hosted provider
attempt passes through [budget admission](paid-provider-spend.md) inside the
adapter's retry loop, including retries. A queue delay alone does not make a
request eligible for provider Batch API pricing. Only the separate operator
batch pipeline submits provider batches.

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

`src/reading-purge.ts` writes `index/deleted/{id}` after the active-attempt
guard and before any vector, list, or object delete, then removes the reading
with vector deletion first, then its owned by-url pointer, list row, objects,
a final sweep, and by-id pointer last. This supports retries after partial
failure. Inbound connections remain until an explicit corpus sweep. The
consumer rechecks the tombstone at the same terminal visibility sites as the
tenant-deletion fence so a still-running attempt cannot republish after the
sweep, reclaim by-url, or recreate a terminal manifest. A confirmed tombstone
on skip-write, lost-CAS, or after the terminal CAS also deletes prefix objects.
The missing-manifest purge guard also treats a tombstone as purged.

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

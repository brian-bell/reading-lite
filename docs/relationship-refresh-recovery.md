# Relationship refresh CPU recovery

> The diagnosis and CPU fix below are current: both hosted Wrangler
> environments pin `limits.cpu_ms = 30_000`. The September 10 recovery
> procedure is a dated record written against the stores of that time (R2
> manifests and list rows, D1 `relationship_refresh_jobs`); readings and judge
> checkpoints now live in PostgreSQL ([ADR 0005](decisions/0005-postgresql-storage.md)),
> while the scan cursor stays in R2. Plan any new recovery afresh rather than
> replaying it.

## Diagnosis (September 10, 2026)

The production refresh failed under an account shown by Cloudflare's Workers
plans dashboard as **Free / Current plan**. Both account settings and the
serving Worker reported `usage_model: standard`; that value does **not** prove a
Workers Paid subscription. The subscriptions API was unavailable to the local
credential (403), so the account plan was checked in the authenticated dashboard.
Neither script settings nor the deployed version exposed an explicit CPU limit.
The Worker was created in April 2026, so the documented March 2024 migration of
Bundled Workers is not an established explanation for this incident.

The retained tail has 80 refresh `exceededCpu` deliveries: 79 at 50 ms and one at
63 ms, all without application logs or exceptions. Four successful judges used
391–620 ms of CPU. Occasional successes above the cutoff do not establish a
usable allowance: Cloudflare documents isolate flexibility for occasional
excesses. Network wait is not CPU time.

The missing Paid entitlement is established; the precise internal reason Free
queue invocations were cut off around 50 ms is not exposed by the settings API.
Do not describe 50 ms as a documented universal Free queue limit. Cloudflare's
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
distinguish Free from Paid, while its
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/#increasing-queue-consumer-worker-cpu-limits)
describe a 30-second default. The latter is insufficient evidence of this
account's effective allowance. The
[pricing documentation](https://developers.cloudflare.com/workers/platform/pricing/)
explains usage models separately from subscriptions.

## Fix and release gate

Enable Workers Paid for the hosting account with the owner's billing approval
(the dashboard advertised $5/month plus usage). Then deploy the explicit
`limits.cpu_ms = 30_000` in both hosted Wrangler environments. This pins the
ordinary documented queue allowance, rather than depending on an implicit
account default. It applies to the shared Worker, including HTTP and the other
queue handlers; it is not a refresh-only setting. It does not alter provider
budgets, provider retry admission, judgement caps, or checkpoints.

Do not merge a configuration release until Paid is active. A local Wrangler
build cannot verify account entitlement or enforce the production CPU limit.
After deploying staging through `ops deploy worker --env staging --execute
--database-url-env NEON_REHEARSAL_DATABASE_URL`,
verify the serving version's CPU setting and observe an authorized staging judge
through checkpoint and reading publication. Then use the normal
CI → Worker → SPA release chain for production. Match the release SHA to the
version ID in the successful deploy log when the version has no commit tag.
If CPU terminations persist with Paid and an explicit deployed limit, stop
recovery and take the version ID and invocation evidence to Cloudflare support.
Do not keep increasing the limit.

## Recovering the contained September 10 run

This is a deliberate recovery, not a queue purge or a new scan. Keep all
snapshots, reading IDs, queue envelopes, and spend records in private operator
storage. The existing evidence directory contains corpus content and must not
be committed. Run supported operational commands through `npm run ops -- …`.
There is no supported hosted-cursor recovery command yet; the conditional R2
edit and queue sends below need a reviewed one-time operator procedure. Do not
substitute the offline `corpus refresh-connections` writer: it does not use the
hosted judgement checkpoint protocol.

1. Before any replay, take a fresh read-only snapshot of the serving release,
   account plan, refresh and refresh-DLQ metrics, tenant cursor, relevant
   manifests/list rows, D1 `relationship_refresh_jobs`, and complete tenant and
   global spend details. Use `ops system status --env production --tenant
   <tenant-id> --details` for spend. Require both queues drained and no overlap
   with the nightly cron or another recovery operator. Check `RELATIONSHIP_REFRESH=1`,
   `TENANT_DATA_PLANE=1`, and `REFRESH_MAX_JUDGEMENTS=2`. The provider budgets stay
   at their existing values; budget exhaustion is a deferral, not permission to
   raise a dollar limit.
2. Require the original cursor identity and expected state before using this
   plan: `run_at=2026-09-10T03:07:48.000Z`, 578 targets, `scan_offset=578`, 75
   candidates, `judge_offset=25`, `dispatched=25`, empty `pending`, `limit=25`,
   and no rollover. Retain the fetched ETag. If the cron or another writer has
   changed this state, regenerate the plan instead of overwriting it. Do not
   reset the token, run identity, targets, offsets, or dispatch accounting.
3. Reconcile the first 25 candidate IDs against checkpoints and spend operations
   whose attempt identity is `refresh:<readingId>:<runAt>`. The captured state
   had four saved results and four settled operations totaling $0.025168, with
   no unsettled refresh operations. Verify each saved result's manifest hash,
   owned patch fields, and list novelty verdict. Replaying that same identity
   can repair publication without another provider call, but changed input
   versions can legitimately prevent applying a saved patch.
4. The other 21 reserved IDs have no saved checkpoint in the captured state.
   Twenty messages reached the acknowledging DLQ, and one delivery returned
   without a paid call. The old logs do not include judge IDs, so they cannot
   identify which of the 21 skipped. Treat all 21 as reconciliation targets.
   Only replay an ID with **no checkpoint and no spend operation** after fresh
   checks, or a confirmed retryable 429 checkpoint whose retry time has elapsed.
   A dispatched checkpoint with no result and no confirmed 429 is uncertain:
   retain it and investigate; never delete it or give it a newer run identity
   merely to force another charge. A spend operation without a checkpoint is
   also a stop-and-investigate case, even if settled.
5. Use one eligible reserved ID as the production canary. Send exactly the
   original envelope to `reading-lite-refresh`:
   `{version:1, kind:"judge", tenantId, runAt:cursor.run_at,
   readingId:target.id, keyPrefix:target.key_prefix}`. Do not carry an expired
   `deferredAt` from an old delivery. Keep the cursor contained at 25 while
   observing this canary. Require a saved result and matching manifest/list
   publication (or a separately established legitimate skip), reconciled spend,
   and no CPU termination. A queue acknowledgement alone is not success.
6. Replay the remaining eligible reserved IDs in small observed batches using
   the same identities, without advancing or rewinding `judge_offset` or
   `dispatched`. These identities already consumed their reservation. Keep a
   private per-ID record of published, repaired, skipped, deferred, and uncertain
   outcomes. Recheck spend/checkpoints before retrying a send of unknown outcome.
7. To dispatch the 50 never-reserved candidates, CAS-change **only** the current
   cursor's `limit` from 25 to **75** using its fresh ETag, then send
   `{version:1, kind:"scan", tenantId, token:cursor.token}` to the refresh queue.
   The consumer's existing reserve-before-send protocol advances the last 50.
   A failed CAS means reread and replan. A send of unknown outcome is recovered
   with the current persisted token, never by recreating the cursor. Stop
   further dispatch on renewed failure by CAS-setting `limit` to the current
   `dispatched` count; already queued jobs still need observation.
8. Reconcile all 75 candidate identities and wait for both queues to drain.
   Record legitimate skips explicitly. Compare all manifests and list rows to
   the pre-recovery snapshot: only the refresh-owned relationship fields and
   list novelty verdict may change. Require no unexplained paid holds or
   uncertain jobs. `judge_offset=75`, `dispatched=75`, and empty `pending` prove
   dispatch completion only, not successful publication.
9. Leave `REFRESH_MAX_JUDGEMENTS=2` deployed throughout. Do **not** set a completed
   cursor's limit to 2 while `dispatched=75`: that violates the cursor schema.
   Its historical limit remains 75. On the next UTC night, the existing cron
   starts a new scan with `limit=2` and `dispatched=0` if this cursor has finished
   dispatch. Verify that transition and the resulting outcomes. If recovery
   misses the cron, take a new snapshot and replan: an unfinished cursor rolls
   its allowance to two and continues its backlog; it does not start a fresh
   full scan.

# Issue 193: staging measurement preflight

> Historical 193-v2 preflight. Later approval deployed detailed status and
> applied the revised 90-seed context packet. Paid measurement was then deferred.
> Read the [current handoff](193-v2.1-handoff.md) before planning further work;
> the earlier blockers and observations below remain as recorded.

Version `193-v2-preflight-1`, September 6, 2026 UTC. **Read-only preflight complete; paid execution is not ready for approval.** This supplements the [measurement proposal](limit-policy-measurement-proposal.md) and [cohort inventory](limit-policy-cohort-inventory.md). It does not approve paid work or production limits.

## Verified staging state

Observed around 00:56–01:04 UTC; individual observation timestamps and responses are retained in the private `.summarizer-comparisons/193-v2-preflight/` packet. Re-read all volatile state immediately before any later execution.

| Check | Observed result |
| --- | --- |
| Worker | `reading-lite-staging` |
| Active deployment | 100% version `24aacb0f-d7c1-49f2-aae6-4ff1d6e25d4c`, uploaded September 5 at 23:52:37 UTC |
| Runtime provenance | Same deployed version recorded in the accepted #193 staging drill, whose source commit is `2897208420082bb65b601be7ff2889c0d6c37160`; version metadata itself does not carry a Git commit annotation |
| Provider/model/effort | Live bindings: `openai` / `gpt-5.6-terra` / `high` |
| Tenant data plane | Live binding `1`; authenticated whoami confirms tenant mode |
| Selected tenant | `usr_24b3629b-a738-440a-9122-99ee70e04aa1`, active; existing staging API token authenticates |
| Migrations | 0001 through 0013 applied; all migrations in this checkout present |
| Global policy | Version 7, paid work **disabled**, catalog 1, daily cap $2, concurrency 3 |
| Selected tenant policy | Version 5, daily cap $1, 20 submissions/hour, 200 readings/month, concurrency 2 |
| Authoritative day accounting | September 6 UTC: global and selected tenant each **42,404 microdollars ($0.042404)** |
| Selected tenant list | 49 unique readings: 39 ready, 10 failed, zero listed pending |
| Queue backlog | All six staging queues report zero messages and zero bytes: reading, reading DLQ, digest, digest DLQ, wipe, wipe DLQ |
| Wipe progress | No current `wipe_progress` rows |
| Vector inventory | 75 total: 39 in the selected tenant namespace and 36 unnamespaced legacy vectors |
| Existing vector ledger | Six live rows for selected tenant; the other 33 existing namespaced vectors predate this ledger inventory. No repair was performed |

Queue metrics were read from the documented [Cloudflare realtime metrics endpoint](https://developers.cloudflare.com/queues/observability/metrics/). These are point-in-time observations, not a promise that new work cannot arrive. No queue messages were pulled, acknowledged, retried, or purged.

The supported `system status` command successfully reached the deployed `OperatorStatus` service. Its counters include holds and uncertain maxima. It does **not** expose the operation breakdown, unresolved reservation count, active processing leases, or hourly/monthly reading counters. A 200/month configured allowance is not proof of 65 remaining slots. The list count is not a quota counter, particularly after reprocesses or deletions. Do not probe quota by making a reservation or importing a test reading during this read-only preflight.

## Pricing and deployment requirements

Fetched the official [OpenAI pricing page](https://developers.openai.com/api/docs/pricing) on September 6. Its standard Terra rates match catalog 1: short-context input/cached/cache-write/output $2/$0.20/$2.50/$12 per million tokens; long-context $4/$0.40/$5/$18. `text-embedding-3-small` remains $0.02 per million tokens. The hosted implementation uses the ordinary `api.openai.com` endpoint and sets standard service tier at the dispatch boundary; this preflight made no provider request.

There is no indicated need for another migration or a model/configuration deployment for the measurement itself. A new read-only status capability, if chosen to resolve the observability gaps below, would require a separately reviewed deployment. Secret values were neither fetched from the deployed Worker nor printed. Existing successful drill evidence establishes prior credential operation; current provider account readiness was not probed with a paid call.

## Exact context-preparation scope

The 65 frozen targets contain 110 selected-connection references to **91 unique production reading IDs**. All 91 source manifests resolve and are ready; 88 have captured content and three are raw-only. **None of their canonical URLs exists in the selected staging tenant's list.** All 91 composed production vector IDs were retrieved successfully, with 1,536-dimensional values in the expected production namespace. Their values need no paid re-embedding to be copied. The private context plan records the seed IDs and availability evidence; vectors were inspected in memory, not persisted as an unreviewed upload file.

Existing staging context is not empty, but is dominated by previous fixtures and unrelated readings. It has no exact seed-URL coverage for the selected context. A replay against its current 39 namespaced vectors would measure a materially different context workload. The 36 unnamespaced legacy vectors are outside the selected namespace and must remain untouched.

The proposed preparation is an **identity-preserving copy of these 91 context fixtures into the selected staging tenant**, with no new provider calls:

- Copy the necessary source manifests, captured/raw content artifacts, and by-ID/by-URL ownership records using the existing tenant-rooted key layout. Build an exact object manifest with source hashes and destination preconditions before approving writes. Do not copy production credentials, control-plane identities, attempt checkpoints, or historical pending work. Do not create ready manifests that point to missing content.
- Merge the 91 ready fixture rows into the staging list using the existing CAS subsystem; preserve the 49 existing rows. Recheck both source and destination immediately before writing. Canonical-URL absence was checked in the list, not every by-URL pointer; the preparation planner must also check pointer ownership and destination object absence.
- Record all 91 seed IDs in the staging tenant's vector ledger **before** upsert. Copy their existing vector values and metadata while rewriting index-unique IDs, namespace, and `tenant_id` metadata to the staging tenant. Preserve source identity and context fields; never delete or move production vectors.
- Preserve existing staging vectors. Verify copied values, dimension, namespace, metadata, pointer/list consistency, and vector visibility before intake. A Vectorize upsert acknowledgement alone is not visibility evidence.

This is a specification for a missing preparation step, **not an implemented copy command or permission to hand-write objects now**. The existing staging setup command creates resources; the existing vector backfill re-embeds and does not provide this scoped copy. A prepared, reviewed, plan-first copy utility or equivalent concrete operator artifact is needed. Exact R2 object keys/counts and destination CAS conditions have not yet been enumerated, so this preflight deliberately does not label the copy ready for execution.

## Target identity and context fidelity

**Eleven seed IDs are also measurement targets.** Importing all 65 under new IDs after seeding would let these eleven see their own old summary as a different related reading, defeating the Worker's self-exclusion rule. The correct identity-preserving action map is:

- **11 reprocesses** of the copied seed IDs, each with the verified supplied Markdown. New attempt identities ensure a fresh run; do not reuse copied checkpoints.
- **54 new Markdown imports**, using their original canonical source URLs, with the generated staging IDs recorded against source IDs.

None of the 65 target canonical URLs currently collides with the selected staging list. These observations must be refreshed at copy/import time, including by-URL pointer checks. The private `target-mapping.json` records source IDs, canonical-URL hashes, and the intended verb. New IDs for the 54 are assigned by intake, not invented in this preflight.

Copying 91 selected connections recreates a useful real-content context pool, **not the original historical full top-K**. Existing staging context and newly published cohort summaries also affect later queries. The Worker queries source embeddings against stored summary embeddings, so querying with an existing summary vector would not establish the exact future prompt. After preparation, accept and record the actual hosted neighbourhood and scores as the prospective measurement context. Preserve the original six source-length/selected-connection strata for weighting and report any context-density shift; do not silently relabel the reconstructed-context quotes as exact hosted quotes.

Run the six strata interleaved in a frozen deterministic order, then the five stress cases, so one length/context group does not always see the smallest library. Record the source-to-staging map and sequence before paid execution. Changes during the run are measurement events, not permission to substitute readings.

## Financial packet once prerequisites are resolved

Retain the proposed **$25 shared additional hosted charge allowance** for the 65 measured readings and their retries/uncertain maxima. Context copying has zero OpenAI/Anthropic calls; Cloudflare storage/API activity is separate from this provider-charge allowance. The nominal clean run has 195 paid operations: 65 source embeddings, 65 summaries, and 65 summary embeddings. Rejections/checkpoint recovery may reduce that count; genuine retries may increase it. Both need explicit accounting.

At the observed baseline, both absolute daily caps would be **25,042,404 microdollars ($25.042404)**. These are one shared $25 incremental allowance, not $50. Recompute from fresh authoritative baselines immediately before approval/execution; keep all other tenants' limits unchanged. The existing global and selected tenant row versions are 7 and 5, respectively; never reuse these if subsequent reads show changes.

The previous frozen partial quotes remain $15.071564, covering one summary/source embedding per target with reconstructed selected-connection context. Actual hosted context is not yet available, future summary embeddings are unknown, and retries are additional. Therefore that partial total is **not** an exact hosted-run quote or completion guarantee. At dispatch, the guard must quote and enforce every actual request inside the allowance. Requote any request bodies available after preparation and report changed context; stop rather than raise the allowance.

After prerequisite approval and verified preparation, the candidate sequence is: retain disabled paid work; inspect fresh baselines; set tenant/global caps under version checks; enable paid work; submit serially at no more than 19 intake requests in any sliding hour; stop at five hours or the applicable earlier UTC deadline. Start only with six hours before UTC midnight. Enqueue each next reading only after the prior reading is terminal; do not accumulate hours of deferred reservations. Use both successful and failed outcomes in the economics denominators.

Restoration would disable paid work, restore the selected tenant's $1 cap and the global $2 cap using fresh versions, preserve charges, and retain all seeded/measured artifacts. Restoring a cap below incurred charges intentionally leaves paid admission blocked; it is not a refund. Report pending readings on abort. No deletion, wipe, automatic quota reset, production changes, or issue closure is included.

## Readiness verdict and bounded next work

Local preparation update: the [context artifact command and application contract](staging-context-copy.md) and private `system status --details` capability have now been implemented. The live observations below remain historical: no instrumentation has been deployed and no staging data has been copied. Artifact checksum validation is a separate local verification; live quota and reservation readiness still requires the updated Worker.

**Do not request approval for paid execution yet.** Runtime, pricing, current spend totals, resource isolation, and queue backlog checks pass. Context availability is established, but safe preparation and complete accounting/quota readiness remain unresolved.

The original preflight requested the following deliverables (implementation is now local; the actual packet is blocked by the source-integrity finding documented in the context-copy runbook):

1. A plan-first context-copy artifact for exactly 91 readings, including object manifests/hashes, ownership checks, tenant namespace rewrites, ledger-before-vector ordering, the 11/54 target map, and non-destructive verification. It must preserve the existing 49 staging readings and 36 legacy vectors. This needs implementation/review authorization beyond the read-only preflight.
2. A supported read-only way to inspect remaining tenant hourly/monthly reservations and active leases, plus held/uncertain spend operations. Prefer extending the private operator status boundary rather than adding public routes or mutating the guard to probe it. Existing `TenantUsageGuard` dispatch has no status verb; `OperatorStatus` currently exposes only spend totals. Alternatively, an approver may explicitly revise the proposal to accept unknown quota headroom and a potentially partial run, but that is weaker evidence and is not assumed here.
3. A refreshed execution packet after those prerequisites, with exact object scope, current state, context/quote limitations, admission schedule, and the $25 financial boundary. Any needed instrumentation deployment belongs in that packet. Production policy approval remains separate.

The 33 pre-ledger staging vectors are recorded as existing state, not repaired as unrelated cleanup. Seed writes must obey the ledger invariant for their own 91 vectors; existing account-wipe self-seeding remains unchanged.

## Verification performed

Read deployment/version metadata, live nonsecret bindings, D1 policy/migrations/user states/ledger/wipe state, the authenticated staging list and manifests, 91 production context manifests and vectors, and six realtime queue metrics. Read the supported authoritative spend status twice. Checked canonical-URL overlaps, vector dimensions and namespaces, seed/target intersections, policy arithmetic, and private packet checksums. No provider calls, imports, reprocesses, durable policy/data edits, migrations, or deployments were executed. Ordinary authentication last-used bookkeeping and Wrangler's temporary remote proxy session are incidental to read-only access.

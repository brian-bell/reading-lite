# Hosted provider spend protection

Issue #200 covers source embedding, OpenAI/Anthropic summarization, and summary
embedding in the hosted reading consumer. Operator batch, evaluation, comparison,
and judgement clients remain outside this scope; their estimates are not enforcement.

`src/control-plane/paid-dispatch.ts` wraps each provider adapter's fetch inside
its HTTP retry loop. It bounds the complete request, then asks the existing
GlobalUsageGuard singleton to reserve both tenant and global daily budgets in
one atomic write. TenantUsageGuard continues owning its existing rate, reading
slot, and concurrency responsibilities; it has no spend ledger.

This deliberately centralizes spend accounting at the project's current scale.
It removes cross-guard compensation and partial settlement. Revisit the
throughput boundary only when measurements justify distributing accounting.

## Request and accounting rules

Every actual provider attempt gets a fresh operation UUID. Guard RPC retries
reuse that identity; provider retries and queue redelivery allocate another.
Only a fresh dispatch mark authorizes fetch. Existing source embedding and
summary checkpoints still skip requests on recovery. Each HTTP retry also
presents its processing lease.

The catalog bounds complete supported payloads and rounds upward in integer
microdollars. Unknown models, unsupported payload shapes, and missing bounds
fail closed. Catalog version 1 uses prices verified on 2026-09-05 against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
It includes OpenAI long-context tiers, pins hosted OpenAI requests to the
standard service tier, and includes Anthropic's maximum geography surcharge
without overriding the workspace's geography setting.

A reservation charges the maximum to both budgets for its UTC admission day.
Valid returned usage replaces that maximum atomically for both counters, before
summary parsing. A response arriving after midnight still settles its original
day. Missing usage, transport errors, and uncertain dispatch authorization keep
the maximum; concurrency lease expiry and a kill switch never refund them.

Known unused reservations can be released and expire after ten minutes.
The guard refuses expired dispatch marks. Reading-slot commit occurs after the fresh dispatch mark. If it fails before
fetch, the wrapper settles zero: no provider request has been made. If that
reconciliation is unavailable, the maximum remains counted. An uncertain settlement retains the maximum and logs
`paid_spend_settlement_held` for investigation. Structured `paid_spend` events
identify reservations, denials, confirmed usage, and unresolved outcomes without
logging provider payloads. These events are diagnostics, not a second ledger.

Operation records are retained through the admission day plus one full UTC day,
then discarded in bounded cleanup batches. Daily aggregates keep their charges;
a settlement arriving after record cleanup cannot refund them. New reservations
must name the authority's current UTC day, so replaying an old quote cannot
recreate a discarded operation. Account teardown removes tenant records/counters
while preserving incurred spend in the global daily aggregate.

## Rollout and issue #201

Migration `0013_system_policy_daily_spend.sql` adds nullable
`system_policy.daily_spend_microdollars`. NULL blocks hosted paid work.
Configure an explicit global cap and catalog version 1 before deployment;
tenant caps use `tenant_limits.daily_spend_microdollars`. No production budget
was selected or changed. Calibration belongs to #193.

The global guard checks the existing `paid_work_enabled` switch at reservation
and dispatch authorization. Denial defers the same reading attempt through
`SpendAdmissionError` / `DeferPaidWorkError`, without an in-process provider retry.

#201 owns the small plan-first operator interface to inspect policy, set budgets,
and disable/re-enable paid work. Preserve the existing policy command contract in
`scripts/ops-lib/policy-contract.ts`. Policy changes must never release uncertain
charges. Operator-tool enforcement and broader recovery workflows are deferred.

The single-authority RPC verbs are `reserve_spend`, `mark_spend_dispatched`,
`release_spend`, and `settle_spend`. Requests carry tenant id, operation id, and
an immutable quote `{dayKey, catalogVersion, requestFingerprint,
maxMicrodollars}`. Reserve also carries admission time; settlement carries
`actualMicrodollars`. No tenant-side spend RPC or two-phase compensation remains.

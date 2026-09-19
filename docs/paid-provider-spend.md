# Hosted provider spend protection

Issue #200 covers source embedding, OpenAI/Anthropic summarization, and summary
embedding in the hosted reading consumer, plus hosted relationship judgements.
Operator batch clients remain outside this scope; their estimates are not
enforcement. Synchronous operator clients are covered
[below](#synchronous-operator-clients).

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

Anthropic rates are flat by design. As verified on 2026-09-19 against
[long-context pricing](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing)
and [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows),
no cataloged Claude model has a long-context premium: Claude 4.6 and later bill
the full 1M-token window at standard rates, and Opus 4.5 rejects input beyond
its 200k window instead of billing it. Re-check both pages before adding a
model (#316).

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

The plan-first `system policy` and read-only `system status` operator commands
inspect policy/accounting, set budgets, and disable/re-enable paid work (see below).
`scripts/ops-lib/policy-contract.ts` enforces the command safety contract. Policy
changes never release uncertain charges. Operator-tool enforcement and broader
recovery workflows are deferred.

The single-authority RPC verbs are `reserve_spend`, `mark_spend_dispatched`,
`release_spend`, and `settle_spend`. Requests carry tenant id, operation id, and
an immutable quote `{dayKey, catalogVersion, requestFingerprint,
maxMicrodollars}`. Reserve also carries admission time; settlement carries
`actualMicrodollars`. No tenant-side spend RPC or two-phase compensation remains.

## Operator policy and accounting

Use `npm run ops -- system status --env staging` (or explicit `production`) to
inspect global policy and current UTC-day accounting. Add `--tenant usr_…` for
one tenant's policy and charged total. Charged means **charged against budget**:
known usage, unused holds, and unresolved maximum charges can all contribute.
It is not a provider invoice. The command reports the guard's observation time
and UTC reset time; D1 policy and accounting are separate observations, not an
atomic snapshot. An unavailable guard yields exit 1 and no accounting total.

The status command uses Wrangler's authenticated remote service binding to the
existing Worker's named `OperatorStatus` entrypoint. This entrypoint exposes only
the status read and is not mounted on the public HTTP router. Deploy the Worker
containing that entrypoint before using status; older deployments report
unavailable. Use the same Cloudflare account credentials/login used by Wrangler
for that environment. No new secret or public admin token is introduced.
The dedicated `scripts/system-lib/wrangler-status.toml` pins the two Worker
names and enables only the remote status service; local persistence is disabled.
This follows Cloudflare's [service-binding pattern for remote Durable Objects](https://developers.cloudflare.com/workers/local-development/#using-remote-resources-with-durable-objects-and-workflows).

Policy changes use the existing D1 operator adapter. For example, after inspecting
staging and observing global policy version 3:

```sh
# Plan only; shows the target, before/after fields, and dollar equivalent.
npm run ops -- system policy --env staging --paid-work disabled

# Apply the same desired state only if version 3 is still current.
npm run ops -- system policy --env staging --paid-work disabled \
  --execute --acknowledge-guard-version 3

# Inspect the resulting version and retained charges.
npm run ops -- system status --env staging
```

Production writes additionally require `--confirm-production`. Both commands
require `--env staging|production`; neither defaults to production.
`--acknowledge-guard-version` names the selected row's **policy_version**, not
the pricing catalog version. A changed row increments its version atomically;
a concurrent edit makes execute fail. Unchanged values with the current
acknowledgement succeed without a write or version bump. Replaying an execute
with its old version refuses even if values already match; inspect and use the
current version. This converges without allowing stale automation to undo a
newer decision. An uncertain write response also requires inspection, not a
blind retry.

`system policy` accepts these desired-state changes:

- `--paid-work enabled|disabled`: global hosted paid-work permission.
- `--daily-spend-microdollars <positive integer>`: global daily budget; one
  dollar is 1,000,000 microdollars. Zero is invalid; use the switch to disable.
- `--catalog-version <n>`: this checkout's supported catalog version (currently 1).
- `--tenant usr_… --daily-spend-microdollars <positive integer>`: one existing
  tenant's budget, acknowledged against that tenant_limits row's version.

Global and tenant changes require separate invocations. Global fields may be
combined in one update, including setting a budget/catalog and enabling paid
work. Explicit enabling refuses an unset global budget or unsupported catalog.
Disabling still works on an unconfigured policy. Budget values and staging
sign-off belong to #193; these commands do not choose production defaults.

Disabling stops subsequent dispatch authorization, not already authorized or
in-flight provider calls. Re-enabling allows normal retries of deferred attempts;
it does not enqueue recovery jobs. Neither action releases leases, refunds
uncertain charges, changes reading attempts, nor resets daily accounting.
Operator batch enforcement remains separate (#319).

### Synchronous operator clients

`corpus backfill-vectors`, `corpus refresh-connections`, `corpus refresh-tensions`,
`eval summarizer`, and the compare-summary-effort script wrap their provider
fetch in the same `createPaidFetch`, inside the client's retry loop, in their
`--execute` branch only. A plan opens no spend session. The verbs travel over
the `OperatorSpend` service binding (`scripts/system-lib/spend.ts`, one
`getPlatformProxy` session per run), which accepts exactly `reserve_spend`,
`mark_spend_dispatched`, `release_spend`, and `settle_spend` and forwards them
to the same GlobalUsageGuard singleton. A budget denial, an unreachable
authority or undeployed entrypoint, and a request the price catalog cannot
bound each refuse the provider request.

There is no global-only accounting mode. `--billing-tenant usr_…` names the
tenant whose cap, with the global cap, admits the requests. Corpus commands
default it to a real `--tenant` and take the authority from `--bucket`;
`--tenant global`, `eval summarizer`, and comparisons must pass it to execute,
and the latter two also pass `--env staging|production`. `corpus recover`
without `--batch` submits through the hosted API and is already enforced there.

### Detailed private preflight inspection

`npm run ops -- system status --env staging --tenant usr_… --details` requests
retained spend-operation state, global leases, and the selected tenant's request,
hourly-reading, monthly-reading, reservation, and lease state. This requires the
Worker with the detailed `OperatorStatus` implementation; a counter-only response
from an older deployment is unavailable, not a clean inspection. There is no
public HTTP route and no generic guard-RPC forwarding.

The command reads without cleanup, refunds, lease renewals, or quota changes.
`reserved` spend remains a charged maximum even when its unused-hold expiry has
passed; `dispatched` means authorized but not settled and may be in flight or
uncertain. Neither state is proof of a completed provider charge. Operation rows
span the retained admission days; daily aggregates outlive those rows, so this
is not a lifetime ledger or provider invoice. Fingerprints and lease fences are
omitted. Tenant quota headroom uses the actual stored counters, conservatively
including expired reading holds until normal cleanup releases them. Request
headroom applies to the current rolling request window; hourly readings reset
on UTC hour boundaries and monthly readings on UTC month boundaries.

Each scan reads at most 1,000 records. A full page is marked `complete: false`
(even if it happens to contain exactly the final 1,000 records), and the CLI exits
1. Never infer an empty outstanding-work set from a partial scan. Malformed or
unavailable state also fails closed. The global and tenant objects have separate
observation timestamps; this is not a cross-object atomic snapshot. Even a
complete inspection does not reserve the reported headroom for a later run.

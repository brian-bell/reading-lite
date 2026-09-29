# Hosted provider spend protection

Issue #200 covers source embedding, OpenAI/Anthropic summarization, and summary
embedding in the hosted reading consumer, plus hosted relationship judgements.
Operator clients are covered below: the [inventory](#operator-dispatch-inventory),
[synchronous](#synchronous-operator-clients) clients, and
[provider batches](#operator-provider-batches).

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

`system_policy.daily_spend_microdollars` (PostgreSQL migration
`db/migrations/0003_control_plane.sql`) is nullable, and NULL blocks hosted paid work.
Configure an explicit global cap and catalog version 1 before deployment;
tenant caps use `tenant_limits.daily_spend_microdollars`, lowered by a reader's
own cap ([below](#who-pays-and-the-readers-cap)). No production budget
was selected or changed. Calibration belongs to #193.

The global guard checks the existing `paid_work_enabled` switch at reservation
and dispatch authorization. Denial defers the same reading attempt through
`SpendAdmissionError` / `DeferPaidWorkError`, without an in-process provider retry.

The plan-first `system policy` and read-only `system status` operator commands
inspect policy/accounting, set budgets, and disable/re-enable paid work (see below).
`scripts/ops-lib/policy-contract.ts` enforces the command safety contract. Policy
changes never release uncertain charges. Paid operator commands are admitted by
the same authority ([inventory](#operator-dispatch-inventory)); broader recovery
workflows are deferred.

The single-authority RPC verbs are `reserve_spend`, `mark_spend_dispatched`,
`release_spend`, and `settle_spend`. Requests carry tenant id, operation id, and
an immutable quote `{dayKey, catalogVersion, requestFingerprint,
maxMicrodollars}`. Reserve also carries admission time and the
[payer](#who-pays-and-the-readers-cap); settlement carries
`actualMicrodollars`. No tenant-side spend RPC or two-phase compensation remains.

## Who pays and the reader's cap

ADR 0004 records who pays for every spend operation. `reserve_spend` carries
`payer`, `tenant` or `operator`, and the guard refuses a reservation without
one. The operation record keeps it, and a replay that names the other payer
is an operation conflict. `createPaidFetch` sets `tenant` only when it attaches
the tenant's own key (`TENANT_PROVIDER_KEYS=1`); hosted calls on deployment
keys and every operator tool are `operator`. The `OperatorSpend` entrypoint
accepts only `operator`, so an operator command cannot admit tenant-funded
work. Every `paid_spend` log line carries the same `payer` field, and
`system status --details` shows it on each retained operation. Records written
before the payer was recorded show none until retention discards them.

The payer labels spend; it does not split budgets. Both payers charge the
same tenant and global daily counters, and admission is the same for both.

The tenant cap the guard admits against is the operator default on
`tenant_limits.daily_spend_microdollars`, lowered by the reader's own
`user_settings.daily_spend_cap_microdollars` when they set one: the smaller of
the two. The reader sets it through `POST /api/auth/provider/preferences`,
which refuses a cap above the operator default; an operator lowering the
default below a reader's cap takes effect too. The guard reads both at
reservation and again at dispatch authorization, so a cap lowered between the
two denies a reservation that no longer fits. A denial is the usual
`daily_spend` deferral. The global cap is unchanged. Because the counter is
per tenant, operator commands billed to a tenant with `--billing-tenant` are
admitted under that reader's lowered cap as well.

`GET /api/auth/provider/usage` is the reader's read-only view for the settings
page: the tenant's charged total for the current UTC day, the effective cap,
and the reset time. Charged has the meaning described under
[operator policy](#operator-policy-and-accounting), so it can exceed the cap
after the cap is lowered. The cap comes from PostgreSQL and the total from the
guard; they are separate observations, and an unreachable guard answers 503
with no figure.

## Operator policy and accounting

Use `npm run ops -- system status --env staging` (or explicit `production`) to
inspect global policy and current UTC-day accounting. Add `--tenant usr_…` for
one tenant's policy and charged total. Charged means **charged against budget**:
known usage, unused holds, and unresolved maximum charges can all contribute.
It is not a provider invoice. The command reports the guard's observation time
and UTC reset time; PostgreSQL policy and guard accounting are separate
observations, not an atomic snapshot. An unavailable guard yields exit 1 and no
accounting total.

The status command uses Wrangler's authenticated remote service binding to the
existing Worker's named `OperatorStatus` entrypoint. This entrypoint exposes only
the status read and is not mounted on the public HTTP router. Deploy the Worker
containing that entrypoint before using status; older deployments report
unavailable. Use the same Cloudflare account credentials/login used by Wrangler
for that environment. No new secret or public admin token is introduced.
The dedicated `scripts/system-lib/wrangler-status.toml` pins the two Worker
names and enables only the remote status service; local persistence is disabled.
This follows Cloudflare's [service-binding pattern for remote Durable Objects](https://developers.cloudflare.com/workers/local-development/#using-remote-resources-with-durable-objects-and-workflows).

`system status` and `system policy` read and write the policy rows over a
direct PostgreSQL connection resolved through the operator database pairing
(`scripts/pg-lib/operator-db.ts`: `STAGING_DATABASE_URL` or
`NEON_REHEARSAL_DATABASE_URL` for staging, `PRODUCTION_DATABASE_URL` or
`NEON_MAIN_DATABASE_URL` for production). For example, after inspecting
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
  tenant's budget, acknowledged against that tenant_limits row's version. This
  is the operator default; a reader's lower cap still applies, and
  `system status` does not show it.

Global and tenant changes require separate invocations. Global fields may be
combined in one update, including setting a budget/catalog and enabling paid
work. Explicit enabling refuses an unset global budget or unsupported catalog.
Disabling still works on an unconfigured policy. Budget values and staging
sign-off belong to #193; these commands do not choose production defaults.

Disabling stops subsequent dispatch authorization, not already authorized or
in-flight provider calls. Re-enabling allows normal retries of deferred attempts;
it does not enqueue recovery jobs. Neither action releases leases, refunds
uncertain charges, changes reading attempts, nor resets daily accounting.

### Operator dispatch inventory

Every operator path that pays a provider, and which tenant's budget admits it.
All of them are operator-funded: the `payer` on their operations is `operator`.
"Per attempt" means one operation per provider HTTP attempt, as in hosted
processing. The billing tenant's daily cap and the global cap both admit each
operation. Plan mode
reaches none of these providers.

| Path | Provider request | Operation | Billing tenant and authority |
| --- | --- | --- | --- |
| `corpus refresh-connections`, `corpus refresh-tensions` | Synchronous OpenAI Responses or Anthropic Messages judgements | Per attempt | `--billing-tenant`, default a real `--tenant`; authority from `--bucket` |
| `corpus ingest`, `corpus recover --batch` | OpenAI Batch or Anthropic Message Batches summaries, plus synchronous OpenAI embeddings | One per provider batch; embeddings per attempt | As above; a resume pays with the tenant its sidecar recorded |
| `eval summarizer`, compare-summary-effort script | Synchronous OpenAI or Anthropic summaries | Per attempt | `--billing-tenant` required; authority from `--env` |
| `corpus recover` without `--batch`, `reading submit`, `import …`, `staging smoke`, `extract agent` | None from the operator: the hosted consumer calls the provider | Hosted, per attempt | The bearer token's tenant; `--billing-tenant` does not apply |

`--tenant global` is a storage selector, not a billing tenant, so it always needs
`--billing-tenant` to execute paid work.

### Synchronous operator clients

`corpus refresh-connections`, `corpus refresh-tensions`,
`eval summarizer`, and the compare-summary-effort script wrap their provider
fetch in the same `createPaidFetch`, inside the client's retry loop, in their
`--execute` branch only. A plan opens no spend session. The verbs travel over
the `OperatorSpend` service binding (`scripts/system-lib/spend.ts`, one
`getPlatformProxy` session per run through the dedicated
`scripts/system-lib/wrangler-spend.toml`), which accepts exactly `reserve_spend`,
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

### Operator provider batches

`corpus ingest` and `corpus recover --batch` admit each provider batch as one
operation (`scripts/corpus-lib/batch/spend.ts`), over the same `OperatorSpend`
route and billed the same way. Their embedding calls go through `createPaidFetch`
like any synchronous client.

- **Bound.** The maximum is the sum of the synchronous quote of every request in
  the batch: each OpenAI JSONL body against `/v1/responses`, each Anthropic
  `params` against `/v1/messages`. Batch prices are at most synchronous prices,
  so the catalog has no batch entries. A request the catalog cannot bound refuses
  the whole batch in the extracted-only preflight, before similar-reading
  embeddings. The fingerprint is a SHA-256 of the exact admitted JSONL or
  request collection.
- **Order.** Reserve, then mark dispatched, then the first pending sidecar
  (`activating`, or `creating`/`uploading`), then create. Every later sidecar
  carries `{tenantId, opId, quote}`. A denial or outage writes no sidecar and
  claims nothing, so a rerun starts clean. Activation can only drop requests, so
  the admitted maximum still bounds the batch that is created.
- **Uncertainty.** A failure before create is attempted (activation leaving
  nothing, an activation or upload error) settles the operation at zero. An
  `activating` sidecar found on resume is settled at zero before it may be
  deleted; if that settlement is refused, the sidecar is retained so the hold
  can be retried. A create whose outcome is unknown keeps the maximum held; the
  existing adopt-or-refuse reconciliation decides the batch, and a resume never
  reserves again.
- **Settlement.** Once results are downloaded, the summed actual usage settles
  the sidecar's operation. If any request lacks valid usage (errored, expired,
  missing, or a response tier the catalog does not price) the maximum stays
  charged. Settlement is idempotent, so a repeated resume settles at most once.
- **Retention.** Operation records last the admission day plus one UTC day. A
  resume after that gets a settlement refusal; the run logs the maximum as
  permanently held and completes. A sidecar that carries no spend operation
  resumes unmetered.
- **Billing tenant.** A resume settles against the tenant its sidecar records and needs no
  `--billing-tenant`; naming a different one is refused. The spend authority
  follows `--bucket`; an unmapped bucket cannot execute a batch.

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

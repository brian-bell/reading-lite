# Issue 195: S5 staging drill evidence, 2026-09-05

> Pre-PostgreSQL record. The D1 and Vectorize sources and `account audit-bare-vectors`
> it used are retired; for the current scan see
> [account residue scan](../operations.md#account-residue-scan-s5).

The staging drill exercised guarded bare-vector repair, the real HTTP account
deletion fence, ordinary cron/queue wipe, and automatic S4 control-plane teardown.
The final residue scan found **no observed tenant residue in scanned sources**, but
returned **exit 1 with `residue:false, incomplete:true`**. This is evidence for the
observed staging paths, not an unconditional zero-residue certificate or proof of
all [#195 acceptance criteria](https://github.com/brian-bell/reading-lite/issues/195).

All times are UTC on September 5, 2026; the run began September 4 in
America/New_York. This is a historical report, not a statement of current staging
state. The issue was already closed when this report was prepared; the drill did
not change its status. Operational procedures remain in the
[operations runbook](../operations.md#account-residue-scan-s5).

## Source and scope

- Deployed source: [`6d37891308498cb9ae12902bc016d26242c122f2`](https://github.com/brian-bell/reading-lite/commit/6d37891308498cb9ae12902bc016d26242c122f2),
  including S4 #275, S5 #282, and runbook corrections #278.
- Worker, R2 bucket, and Vectorize index: `reading-lite-staging`.
- D1: `reading-lite-control-staging`.
- Host: `https://reading-lite-staging.bbell.dev`; tenant data-plane gate enabled;
  ordinary cron schedule `*/15 * * * *`.
- Disposable tenant: `usr_08577a4e-da8e-4b8a-aadf-f3bd55a2f7ea`.
- Synthetic Markdown and 1536-dimensional embeddings were generated locally.
  Notifications were disabled and the live mail allowlist excluded the synthetic
  address. No drill email or paid provider call was made.
- No production audit, repair, deployment, or S7 legacy cleanup was performed.
  The drill made no application source changes.

The tenant was created with `ensureUserWithDefaults`; synthetic sessions and
API tokens exercised actual deployed authentication. Signup, email verification,
and email reuse through a new signup were **not exercised**.

## Fixture and repair evidence

Collision checks preceded creation of 21 tenant R2 objects and eight synthetic
vectors. R2 writes used `putIfAbsent`. The tenant initially had no ledger rows.

| Reading ID | Fixture case |
|---|---|
| `rd_BCAS6H4KJ2` | Bare vector only |
| `rd_08BXQYGHEZ` | Identical bare/composed pair |
| `rd_KVD9SF87XF` | Intentionally conflicting bare/composed pair |
| `rd_KZ1TDCTYAM` | Protected unnamespaced control plus tenant composed copy |
| `rd_S6Y8ZG7V23` | Composed vector only |

The operator confirmed all offline staging writers on all machines were stopped.
All six staging queues were paused and read back. A temporary staging maintenance
Worker returned HTTP 503, retried queue deliveries without processing, and skipped
cron. After a 16-minute wait, maintenance remained active, all queues remained
paused, and backlog was zero. Repairs ran inside this sole-writer window.

Observed guards and repair results:

1. Missing sole-writer acknowledgement and mismatched confirmation each exited 2
   before remote work.
2. The initial audit identified the protected global pair and intentional
   conflict. Guarded execution refused the whole plan, exit 1; all eight vector
   payloads and the empty ledger were unchanged.
3. The underlying repair guard rejected the hydrated global control before any
   downstream I/O, verified with a read-only trap.
4. Only the synthetic composed conflict was resolved, after checking its exact
   payload, namespace, and tenant status. Repair pass 1 submitted deletion of two
   duplicate bare vectors and the missing composed copy, retaining that copy's
   bare source. After propagation and re-audit, pass 2 deleted the last duplicate.
   Both mutation passes exited 1 for asynchronous submissions, not completion.
5. The post-propagation audit exited **0 at 01:43:51.073**, with an empty repair
   plan, zero unknown/unexpected IDs, and the protected control unchanged. Five
   tenant composed vectors and three ledger rows remained.

The normal Worker was restored at **01:44:32.015**, version
`8c361b4f-e050-47a6-859a-f6a3fdf8cb71`. The exact original Wrangler configuration
was restored; health passed and all six original queue delivery settings were
restored and read-verified by **01:44:51.599**.

## HTTP deletion fence

| Request/check | Observed HTTP status |
|---|---:|
| Session and bearer `whoami` before deletion | 200 each |
| Delete without CSRF | 403 |
| Delete with stale recent authentication | 403 |
| Delete with bearer authentication | 403 |
| Delete with invalid confirmation | 400 |
| Valid session, CSRF, recent authentication, and `{"confirm":"delete"}` | **200** |
| Same session and bearer `whoami` after deletion | **401 each** |

The valid `DELETE /api/account` completed at **01:46:19.637**. All four fixture
sessions were revoked with reason `account_delete`; both API tokens were revoked.
Only this disposable deleting tenant's grace timestamp was backdated eight days,
with actual affected-row count **1** at **01:46:21.058**. The ordinary scheduler
then owned progress: no force envelope, manual queue message, or manual deletion
of `users` or `wipe_progress` was used.

## Ordinary wipe and automatic teardown

The ordinary **02:00 cron** started the wipe. At **02:00:56**, all 21 R2 objects
were gone, but five ledger rows remained `delete_submitted`, vectors were still
propagating, and completion was NULL. The consumer seeded the two missing ledger
IDs itself (`seed_completed_at_ms = 1788573616313`). R2 emptiness was not treated
as completion.

Wipe completion was **02:02:20.583**:

- `completed_at_ms = first_completed_at_ms = 1788573740583`
- `residue = first_residue = 0`
- `force = 0`; ledger empty

The observer captured a residue scan before teardown. Automatic S4 teardown ran
on the ordinary **02:15 cron** cycle, with `torn_down_at_ms = 1788574511000`
(**02:15:11.000**). A second scan followed observed user removal.

| Scanned source | After wipe, before teardown | After automatic teardown |
|---|---:|---:|
| Tenant R2 objects | 0 | 0 |
| Legacy tenant wipe records | 0 | 0 |
| Vector ledger rows | 0 | 0 |
| Namespace probe matches | 0 | 0 |
| Namespace inventory tenant IDs | 0 | 0 |
| `users` | 1 | 0 |
| `sessions` | 4 | 0 |
| `api_tokens` | 2 | 0 |
| `api_token_scopes` | 2 | 0 |
| `user_settings` | 1 | 0 |
| `tenant_limits` | 1 | 0 |
| `wipe_progress` | 1 | 0 |
| `digest_deliveries` | 0 | 0 |
| `auth_challenges` | 0 | 0 |
| `signup_invites` | 0 | 0 |

Both scans enumerated all 69 index IDs with zero unhydrated IDs, then selected
actual namespaces. A bounded similarity query was not used as enumeration.
Both scans exited **1**:

- Before teardown: `residue:true, incomplete:true`, including expected remaining
  control-plane rows.
- After teardown: **`residue:false, incomplete:true`**, with the expected retained
  `account_deletions` audit and no observed tenant data in the scanned sources.

The retained audit was:

```json
{
  "tenant_id": "usr_08577a4e-da8e-4b8a-aadf-f3bd55a2f7ea",
  "deleting_at_ms": 1787881580942,
  "completed_at_ms": 1788573740583,
  "residue": 0,
  "first_completed_at_ms": 1788573740583,
  "first_residue": 0,
  "torn_down_at_ms": 1788574511000
}
```

The first-completion pair exactly matched the pre-teardown record. Direct D1
checks confirmed absent user/progress/child rows; audit existence alone was not
used as proof. Exact checks of all four saved session IDs and both token
IDs/scopes returned no rows, and the tested credentials still returned 401.

The historical S6 fixture also underwent automatic teardown on the 01:45 cycle,
with its original `first_completed_at_ms = 1788537026192` and `first_residue = 0`
preserved. This additional observation did not substitute for the fresh fixture.

## Preservation and final staging state

Baseline inventory contained **503 R2 objects and 68 vectors**. Final inventory
contained **503 R2 objects and 69 vectors**. Every preexisting object's ETag and
every preexisting vector's namespace/payload hash were unchanged. The founder
and other preexisting active tenant remained active.

The only additional vector was the deliberately retained, unnamespaced synthetic
control **`rd_KZ1TDCTYAM`** in `reading-lite-staging`. Its payload and namespace
were unchanged. Its tenant composed counterpart was deleted, and no tenant R2
object remained for it. This control is outside the tenant scanner's namespace
scope; the drill does not claim every synthetic artifact was deleted.

At final verification, the normal Worker and cron were restored and all six
queues had their original delivery settings and zero backlog. Offline writers
could resume. Expected deletion audit rows remained. Generated local fixture
bearer material was removed after verification.

## Acceptance limits and follow-ups

The scanner's incomplete result must accompany this evidence:

- **Durable Objects:** TenantUsageGuard storage/alarms and GlobalUsageGuard leases
  had no independent operator read surface. S4's fail-closed purge provides
  indirect evidence, not direct inspection of empty storage.
- **Rate windows:** Hashed AuthRateGuard windows were not attributable to a tenant.
- **Erased ownership:** Released-address invites, NULL-owner challenges, and orphan
  token scopes can lose attribution after teardown. Saved fixture credential
  selectors were checked, but real signup/address-history scenarios were not.
- **Concurrent work:** The scanner does not inspect queues or concurrent writers.
  Repair quiescence was established separately. Vector inventory and hydration
  are a non-atomic snapshot.
- **Legacy and production scope:** Unnamespaced legacy ownership belongs to S7.
  Production residue audit/repair and real email-reuse acceptance were not proved
  by this staging drill.

A fixture setup attempt exposed `makeWranglerD1` reporting zero affected rows even
when an insert succeeded. The runner subsequently used actual D1 REST metadata;
all extra fixture credentials were revoked and automatically removed. The source
fix is tracked in [#283: preserve D1 affected-row counts](https://github.com/brian-bell/reading-lite/issues/283).
An initial session GET without same-origin context returned 401; the same saved
session worked with the required Origin header. These runner failures are not
reported as passing application checks.

## Validation and evidence provenance

The drill's targeted validation passed **3 files / 55 tests**:

```sh
npm run test:quiet -- test/unit/scripts/ops-account-s5.test.ts test/unit/control-plane/account-teardown.test.ts test/integration/auth-account-delete.test.ts
```

Ops deployment plan/build and the operational read-backs described above passed.
This report records those drill checks; adding this document does not rerun them.

The report was transcribed from the operator's captured `report.md`, chronological
`run-history.md`, repair/refusal logs, `auth-delete-resume.log`,
`wipe-in-progress.log`, `wipe-complete.log`, both residue-scan logs, and final D1,
credential, preservation, Worker, and queue observations in the local
`s5-staging-drill` evidence bundle. Raw logs and executable runners remain
operator-local and are not attached to this repository. This document preserves
the relevant observations and limitations without credentials, authentication
material, machine-specific paths, or links that require access to that bundle.

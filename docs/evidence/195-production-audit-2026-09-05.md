# Issue 195: S5 production read-only audit, 2026-09-05

The production audit found **no tenant bare-vector repair candidates and no ready
readings missing composed vectors**. All 557 ready-listed readings had a composed
vector in the correct namespace. No production repair or other mutation was
requested.

This is a historical observation, not an unconditional zero-residue certificate
or proof of all [#195 acceptance criteria](https://github.com/brian-bell/reading-lite/issues/195).
All times are UTC on September 5, 2026. The audit ran from **02:23:05.736 to
02:27:56.825**. The issue was already closed before this audit; the audit did not
change its status. Procedures remain in the
[operations runbook](../operations.md#account-residue-scan-and-bare-vector-repair-s5).

## Source, authorization and scope

- Reviewed source: [`6d37891308498cb9ae12902bc016d26242c122f2`](https://github.com/brian-bell/reading-lite/commit/6d37891308498cb9ae12902bc016d26242c122f2),
  including S4 #275, S5 #282 and corrections #278; clean checkout, identical to
  freshly fetched main at execution.
- Production R2 bucket and Vectorize index: `reading-lite`.
- Production D1: `reading-lite-control`.
- Founder tenant: `usr_1700450b-c2df-4421-8805-c308a63b4dea`, observed active.
- The operator authorized production read-only discovery and scans after the
  completed [staging drill](195-staging-drill-2026-09-05.md), and explicitly
  supplied the credential source. No repair was authorized.

Metadata reads returned HTTP 200 and matched the production resource mapping,
including a 1536-dimensional Vectorize index. Credentials were loaded in memory;
no values were printed or copied into the checkout or evidence. The selected
Cloudflare token was explicitly mapped into Wrangler's inherited environment.
R2 used REST, with S3 credentials disabled to avoid assuming a staging-scoped
key pair covered production. Successful reads established resource access;
token privilege breadth was not independently audited.

Scope discovery combined D1 users, account_deletions, wipe_progress and
vector_ledger with R2 `u/` and `wipe/` roots and index-wide vector hydration.
All sources identified only the founder tenant. Discovery did not rely solely
on ledger rows, bounded similarity results, ID prefixes or vector metadata:
actual returned namespaces determined vector attribution. No invalid tenant
scope or missing hydration was observed.

The application `/api/whoami` route was deliberately excluded: its authentication
middleware can update usage timestamps or stored authentication hashes. The
commands used SELECTs, R2 reads and Vectorize list/get/query operations. HTTP
POST for D1 SELECTs or vector queries did not make those operations mutations.
No queue jobs, ledger seeds, repairs, deletions, upserts, deployments, credential
changes or workflow triggers were requested. Services and production writers
remained active; this audit did not establish sole-writer conditions.

## Results

| Observation | Result |
|---|---:|
| Index IDs enumerated and hydrated | 1,104 / 1,104 |
| Missing hydration / unexpected audit IDs | 0 / 0 |
| Founder composed vectors | 557 |
| Bare IDs in founder namespace / repair plan entries | 0 / 0 |
| Unnamespaced vectors, all protected | 547 |
| Bare/composed pairs with protected unnamespaced bare copies | 545 |
| Ready listed readings / correct composed vectors | 557 / 557 |
| Ready readings with missing or wrong-namespace composed vectors | 0 |
| Founder ledger rows / delete_submitted remnants | 0 / 0 |
| Founder R2 objects | 3,691 |
| Old wipe objects / current wipe-progress rows | 0 / 0 |
| Deleted tenants scanned by all-deleted selector | 0 |

### Bare-vector audit

Exit **0**: active tenant, empty repair plan, no unknown or unexpected IDs.
All 545 reported pairs had `bareNamespace: null` and `protected: true`. Those
bare copies are protected global data, not tenant bare-ID repair candidates.
The two additional unnamespaced vectors without a reported founder pair remain
protected as well. Ownership and deletion eligibility belong to S7's separate
review. Pair existence alone does not establish duplicate search results across
namespaces.

### Founder residue scan

Exit **1**, with **`residue:true, incomplete:true`**. The residue flag reflects
the active account's normal corpus and control-plane rows; it is not evidence
of a failed wipe. `listed_vectors` reported all 557 composed vectors present in
the correct namespace. The empty ledger contained no purge-confirmation remnants.

| D1 table | Observed founder rows |
|---|---:|
| users | 1 |
| sessions | 3 |
| api_tokens | 2 |
| api_token_scopes | 7 |
| user_settings | 1 |
| tenant_limits | 1 |
| digest_deliveries | 0 |
| wipe_progress | 0 |
| auth_challenges | 3 |
| signup_invites | 0 |

There was no durable deletion audit for the live founder. The scanner retained
its explicit DO and ownership/concurrency visibility gaps.

### All-deleted selector

Exit **0**, with “No account_deletions rows; no tenants scanned.” This is an empty
selection, not clean certification of a deleted account. Production deletion
was not exercised by this audit. The staging drill supplies the separate
end-to-end deletion evidence.

## Commands, timing and encountered failure

The captured CLI commands were:

```sh
TENANT=usr_1700450b-c2df-4421-8805-c308a63b4dea
npm run ops -- account audit-bare-vectors --namespace "$TENANT" --bucket reading-lite
npm run ops -- account residue-scan --tenant "$TENANT" --bucket reading-lite
npm run ops -- account residue-scan --all-deleted --bucket reading-lite
```

Discovery additionally used resource metadata GETs, paged fixed D1 SELECTs,
index-wide listing followed by get_by_ids batches of at most 20, and R2 root
listing. D1 scope pagination used a 500-row keyset limit and a matching count.
Each native audit invocation captured its own full-index snapshot; no supported
CLI cache or snapshot-import option was assumed.

| Observation | Start UTC | Finish UTC | Exit |
|---|---|---|---:|
| discover-d1 | 02:23:05.736 | 02:23:07.111 | 0 |
| discover-storage | 02:23:28.498 | 02:23:43.930 | 1 |
| discover-storage-retry-1 | 02:24:17.333 | 02:24:51.801 | 0 |
| all-deleted | 02:24:33.984 | 02:24:35.361 | 0 |
| founder-bare | 02:25:19.396 | 02:27:16.656 | 0 |
| founder-residue | 02:26:50.861 | 02:27:56.825 | 1 |

The first discovery list request returned **HTTP 504**. That failed observation
was retained and was not classified as absence. One explicit fresh retry
succeeded, hydrating all 1,104 IDs with zero missing results. All three successful
index enumerations reported 1,104 IDs. The tenant scan overlapped the bare audit's
independent pair reads; their windows were not atomic.

The implementation implies roughly 789 Vectorize requests across discovery and
the two audits, including the failed listing, hydrations, pair reads,
listed-reading checks and probe. This is a source-derived estimate, not an
instrumented request ledger. Additional R2 and D1 reads occurred. No LLM or
embedding-generation API was invoked; no dollar billing estimate is asserted.

## Concerns and follow-up decisions

No production repair is indicated by the observed results. Four limits remain:

1. **Empty live ledger needs deployment context.** The founder has 557 composed
   vectors but zero ledger rows. That is consistent with a corpus predating
   ledger bookkeeping, but publication/reprocess history was not correlated with
   deployment history in this audit. The wipe seeds missing entries itself,
   and staging demonstrated that path. If readings were successfully published
   or reprocessed after ledger writing deployed, missing rows would warrant a
   focused investigation. This is a proposed read-only follow-up, not a confirmed
   writer defect or a reason to seed production now.
2. **Legacy data remains protected.** The 547 unnamespaced vectors and 545 pairs
   remain S7's separate ownership/deletion decision. This audit does not establish
   deletion eligibility or authorize cleanup.
3. **The scanner cannot certify complete absence.** It has no direct operator
   view of TenantUsageGuard storage/alarms or GlobalUsageGuard leases. Hashed
   AuthRateGuard windows cannot be attributed, and erased address/token ownership
   can hide released-address invites, NULL-owner challenges or orphan scopes.
   It does not inspect queued/in-flight writers. Source review also found weaker
   R2 pagination and D1 result parsing: truncated R2 responses without a cursor
   can terminate listing, repeated cursors are not rejected, and malformed D1
   result shapes can become empty arrays. Vector enumeration validates cursor
   progress but discards provider totals. No such malformed-response omission
   was demonstrated here; these are limits on certification, not observed loss.
4. **Production deletion was not tested.** The all-deleted selection was empty.
   Live-corpus integrity evidence and staging deletion evidence answer different
   questions. An account_deletions row, when present, proves an attempt rather
   than complete teardown by itself.

Vector listing snapshots exclude later inserts, while hydration occurs later.
Production writers remained active. Successful missing results would be single
candidate absences, not the wipe's spaced confirmation protocol. Scanner exit 1
must be interpreted by source, and exit 0 from an empty selector is not a clean
wipe. Keep these limitations explicit in acceptance decisions even though #195
was already closed. The single retried HTTP 504 is a reliability observation,
not evidence of corruption.

## Validation and evidence provenance

Node 20.20.2 was selected explicitly. Dependency installation succeeded without
tracked changes; the repository Wrangler payload launcher passed a local help
check. The audit's local checks passed **2 files / 40 tests**:

```sh
npm run test:quiet -- test/unit/scripts/ops-account-s5.test.ts test/unit/scripts/ops-registry-coverage.test.ts
```

Preparation also passed seven snippet syntax checks and four isolated mock
checks. Those mocks made no real network requests. Adding this document does
not rerun production observations.

This report was transcribed from the operator-local production audit report,
`summary.json`, metadata and scope JSON, index discovery checkpoints,
`founder-bare.json`, `founder-residue.json`, command logs and evidence hash
manifest. Raw logs, individual vector IDs/pairs and executable runners remain
operator-local; they are not attached to the repository. This document preserves
the results and unresolved concerns without credentials, authentication material,
machine-specific paths or links requiring access to that bundle.

# Staging evidence checklist and release-gate scope (#203)

Canonical CI runs on every code release. Staging checks are selected for the
behavior a change affects, with an explicit operator release gate as the intended
first implementation. **No new staging runner or release enforcement is shipped
by this document.** Ordinary production deployment remains unchanged.

## Evidence already accepted

The [founder cutover](founder-cutover.md) completed on 2026-08-31. Its counts,
hashes, tenant paths, vectors and connections were reconciled. The one-time
migration command and dedicated code/tests are retired; repeating that migration
is not an ongoing release requirement. New installations use tenant storage;
future migrations need their own scoped tests and rehearsal.

Account deletion and its named limits were accepted in
[#288](https://github.com/brian-bell/reading-lite/issues/288#issuecomment-5552724368)
and [#195](https://github.com/brian-bell/reading-lite/issues/195#issuecomment-5552783135),
with [staging deletion evidence](evidence/195-staging-drill-2026-09-05.md),
[real email-reuse evidence](evidence/286-staging-email-reuse-followup-2026-09-05.md),
and local storage/concurrency verification. They do not need another drill
merely because an unrelated change is released.

## Select checks by the affected behavior

Record the selection and rationale with the PR or operator work. This is a
checklist for a single operator, not automatic path classification.

| Change affects | Relevant staging evidence |
|---|---|
| Account deletion or tenant storage removal | Nonempty disposable account; working owner credential baseline; real HTTP DELETE and credential rejection; deployed wipe/automatic teardown; saved-selector queries and per-source residue scan. |
| Authentication, sessions or tokens | Positive baseline, affected refusal/revocation cases, and real signup/email reuse when affected. |
| Notifications | Controlled tenants and recipients; correct immediate/digest delivery and disabled-preference behavior. |
| Cost or provider policy | Approved numeric policy; bounded paid cap, retry, kill/defer/re-enable and accounting proof. Depends on #200/#201/#193. |
| Restore or rollback | Disposable restored snapshot and verified reads; rehearse the affected rollback. Gate-off rollback does not recover post-cutover tenant writes. |
| A new data migration | A separate migration-specific plan, reconciliation criteria and rehearsal. The retired founder migration is not reused as a routine gate. |

For each selected drill:

- Record the intended commit, effective staging configuration, deployed version,
  fixture selectors and observation interval. Keep staging unchanged during it.
- Save commands, actual exit codes, positive baselines and final observations.
  Identify staging services versus local tests/stubs; keep distinct fixture
  lifecycles separate.
- Keep failed attempts. Missing, unreadable, timed-out or empty fixtures do not
  pass. Do not rewrite an unsuccessful report into success.
- Record cleanup, restoration and any explicitly accepted retained data. Preserve
  unrelated tenants. Retain sanitized evidence with the operator release record,
  never credentials or login links.

### Preserve accepted limits

The accepted deletion boundary includes local DO storage/alarm evidence instead
of independent deployed inspection, named auth retention, already-started work,
non-atomic vector observations and deferred legacy cleanup. Preserve
`residue:false, incomplete:true` and actual scanner exit 1 when applicable.
A release decision may reference those specific accepted limits; it must not
turn them into observed absence or waive new read errors, unexplained residue,
or missing evidence. No new inspection API or unconditional zero-residue promise
is required. D1 migrations, runtime tenant isolation, the activation preflight,
production wipe check and general repair/deletion tools remain in service.

## Small operator release-gate design (not implemented)

The next slice should make **one selected, still-relevant drill** repeatable and
retain its result with the intended commit/configuration. A separate explicit
operator release entry point should read that evidence and refuse before
production migrations or upload if the selected check failed, is incomplete
outside accepted limits, or does not match the intended release.

A successful result would still run existing production deployment checks. Test
both failure and missing-evidence paths with deployment effects trapped, then
run a separately scoped live drill when the affected behavior warrants it. A
successful local test is evidence for the gate, not a live staging result.

Use ordinary workflow/operator coordination. No shared release database, atomic
seals, generic exception engine, arbitrary freshness cutoff, full paid drill on
every release, or automatic bypass is required for this stage. Automatic CI
release enforcement and SPA coordination are future scope, not implied by an
operator-only gate. The founder-migration-dependent prototype was discarded
before any live staging or production operation.

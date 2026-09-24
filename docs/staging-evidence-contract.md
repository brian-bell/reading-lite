# Staging evidence checklist and release-gate scope (#203)

Canonical CI runs on every code release. Staging checks are selected for the
behavior a change affects, with an explicit operator release gate for token revocation. `ops staging
token-revocation` retains evidence and `ops deploy release` validates it before
production writes. Ordinary production deployment remains unchanged.

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
is required. PostgreSQL migrations, runtime tenant isolation, the activation
preflight, production wipe check and general repair/deletion tools remain in
service.

## Explicit token-revocation gate

This first implementation covers token creation, positive bearer authentication,
revocation, rejection of the revoked token, and continued session access. Select
it when token behavior is affected. It does not certify signup, email delivery,
all session behavior, provider policy, or account deletion.

Use a controlled staging account with a recent authenticated browser session.
Token creation can send a security notification to that account's email address;
use a controlled recipient. The runner creates one `readings:read` token with a
15-minute expiry, then revokes it. It never submits paid work or wipes an account.
It leaves the operator session and revoked token record in place. Those are
explicitly retained fixtures, not evidence of zero auth residue.

Commit the candidate first and use a clean checkout. Stage it through the
existing deploy command with its commit tag:

```sh
CANDIDATE_SHA=$(git rev-parse HEAD)
npm run ops -- deploy worker --env staging --release-sha "$CANDIDATE_SHA" \
  --database-url-env NEON_REHEARSAL_DATABASE_URL
# After reviewing the plan, add --execute to deploy the staging candidate.
```

`--release-sha` verifies the clean checkout matches and supplies Wrangler's
version tag. Existing readiness and activation guards still apply. The drill
reads the active Cloudflare version and requires that tag; local HEAD alone is
not evidence that staging serves the candidate. Split deployments are refused.
Keep staging deployment/configuration and the candidate checkout unchanged for
the drill and selected release.

Provide the recent session through `STAGING_SESSION_COOKIE` in the process
environment, in `__Host-session=<value>` format. Never put it in command-line
arguments, retained evidence, or shell history. The CSRF token is obtained in
memory from `/api/whoami`. No login automation or secret bootstrap is added.

Choose a new evidence directory **outside the checkout**, under an existing
parent directory. Plan first:

```sh
npm run ops -- staging token-revocation \
  --tenant "$STAGING_TEST_TENANT" --release-sha "$CANDIDATE_SHA" \
  --output "$EVIDENCE_PARENT/token-run-01"
# Add --execute for the separately approved staging drill.
```

The runner verifies the session's tenant before creating anything. It observes
one token authenticate with HTTP 200, revokes that token, observes HTTP 401 for
the same bearer, and confirms the session still authenticates. Cleanup queries
the exact run-generated token name and confirms a revoked timestamp and unusable
state. A lost POST response is not retried: cleanup tries to recover the created
token by that name. Missing/ambiguous selectors or failed cleanup reads block
success and require operator investigation. An expired token alone does not
prove revocation.

Each run creates `start.json` and then `result.json`, both without overwriting an
existing file. `start.json` contains the command and fixture selector. A crash
may leave only the start record; it cannot authorize release. Inspect that exact
token name for cleanup, and use a fresh directory for the next attempt. Failed
results are retained and cannot be converted to success by rerunning over them.
A successful run has actual command exit 0; a completed failed run has exit 1.
HTTP status codes remain observations (the expected HTTP 401 is not rewritten).
Evidence-write failure makes the command fail; never use a partial result.

The result contains commit, local `wrangler.toml` hash, active version ID, a hash
of selected effective staging auth configuration (APP_ENV, WEB_BASE_URL,
TENANT_DATA_PLANE and the Hyperdrive binding), observation interval, token
selectors, statuses, exit code and cleanup/restoration outcomes. It compares provenance before and
after the drill. HTTP bodies, cookies, bearer values, CSRF tokens, email addresses,
login links and arbitrary exception text are not retained. This does not attest
secret values, dynamically changed PostgreSQL policy, or continuous deployment stability
between observations; coordinate changes during the run. Version tags and JSON
are operator audit evidence, not tamper-proof authorization seals.

Review the retained evidence, then select the gated production Worker release:

```sh
npm run ops -- deploy release --check token-revocation \
  --evidence "$EVIDENCE_PARENT/token-run-01/result.json" \
  --release-sha "$CANDIDATE_SHA"
# Add --execute only for the reviewed production release.
```

Plan mode reads and validates evidence and provenance without production writes.
Execute refuses missing, malformed, failed, incomplete or mismatched evidence
before invoking the production wipe check. On success it runs `deploy wipe-check`
with the candidate SHA, then the existing production Worker deploy command,
including readiness, activation, migrations-before-upload and child exit codes.
The existing reviewed SHA-specific wipe override remains available; this wrapper
does not introduce an activation override or evidence exception mechanism.
No accepted deletion limit is silently converted into a successful token drill.

The wrapper is explicitly selected. It does not intercept `deploy worker`, direct
Wrangler, or the automatic CI/SPA deployment chain. Coordinate a selected manual
release with existing release activity; this local command does not acquire the
GitHub Actions release lock. Wipe/provenance checks are snapshots, not concurrency
locks. There is no automatic path classification, arbitrary freshness deadline,
shared release database, generic drill registry, or new production dependency.

## Verification and live acceptance

The Node command tests exercise positive/negative token observations, cleanup,
provenance and failed evidence with injected HTTP/storage/deployment dependencies.
Missing and failed evidence invoke neither production wipe nor deploy callbacks;
a wipe refusal prevents deploy, and a deployment failure preserves its exit code.
Existing deployment tests retain activation refusal and migration failure coverage.
These are local tests with production effects trapped, not deployed observations.

Run a separately scoped live drill when the affected auth behavior warrants it.
Retain its sanitized directory with the operator release record and record any
cleanup follow-up. Local test success does not claim live staging acceptance or
close the remaining live portion of #203.
